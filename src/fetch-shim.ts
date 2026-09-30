import type {
  FetchRequestMessage,
  FromGameframeFetchMessage,
  ToGameframeFetchMessage,
} from "./protocol";

interface ProxiedHead {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ReadableStream<Uint8Array>;
}

interface PendingRequest {
  port: MessagePort;
  resolveHead: (head: ProxiedHead) => void;
  rejectHead: (error: Error) => void;
  head?: Omit<ProxiedHead, "body">;
  queue: Uint8Array[];
  done: boolean;
  error?: Error;
  wake?: () => void;
  stopWatchingSignal?: () => void;
}

export interface FetchClient {
  // Adopts the port a parentframe hands out; requests on a previous port fail.
  attach(port: MessagePort): void;
  request(
    request: Omit<FetchRequestMessage, "type" | "id">,
    signal: AbortSignal,
  ): Promise<ProxiedHead>;
}

// Requests made before the parentframe has handed over its port wait for it.
export function createFetchClient(): FetchClient {
  let port: MessagePort | undefined;
  let waitingForPort: (() => void)[] = [];
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();

  function finish(id: number, request: PendingRequest, error?: Error) {
    if (error) {
      request.error = error;
      if (!request.head) request.rejectHead(error);
    } else {
      request.done = true;
    }
    request.wake?.();
    request.stopWatchingSignal?.();
    pending.delete(id);
  }

  function handleMessage(event: MessageEvent) {
    const message = event.data as ToGameframeFetchMessage | undefined;
    const request = message && pending.get(message.id);
    if (!message || !request) return;
    switch (message.type) {
      case "head": {
        request.head = {
          status: message.status,
          statusText: message.statusText,
          headers: message.headers,
        };
        request.resolveHead({
          ...request.head,
          body: createBody(message.id, request),
        });
        break;
      }
      case "chunk":
        request.queue.push(message.data);
        request.wake?.();
        break;
      case "end":
        finish(message.id, request);
        break;
      case "error":
        finish(message.id, request, new TypeError(message.message));
        break;
    }
  }

  function createBody(id: number, request: PendingRequest) {
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          while (true) {
            const chunk = request.queue.shift();
            if (chunk) {
              controller.enqueue(chunk);
              const credit: FromGameframeFetchMessage = {
                type: "credit",
                id,
                bytes: chunk.byteLength,
              };
              request.port.postMessage(credit);
              return;
            }
            if (request.error) {
              controller.error(request.error);
              return;
            }
            if (request.done) {
              controller.close();
              return;
            }
            await new Promise<void>((resolve) => (request.wake = resolve));
          }
        },
        cancel() {
          if (pending.delete(id)) {
            request.stopWatchingSignal?.();
            request.port.postMessage({ type: "cancel", id });
          }
        },
      },
      { highWaterMark: 0 },
    );
  }

  return {
    attach(newPort) {
      if (port) {
        port.onmessage = null;
        port.close();
        for (const [id, request] of [...pending]) {
          finish(
            id,
            request,
            new TypeError("connection to the platform was reset"),
          );
        }
      }
      port = newPort;
      port.onmessage = handleMessage;
      const waiters = waitingForPort;
      waitingForPort = [];
      for (const resume of waiters) resume();
    },

    async request(request, signal) {
      while (!port) {
        if (signal.aborted) break;
        await new Promise<void>((resolve) => {
          waitingForPort.push(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      if (signal.aborted) throw abortError();

      const id = nextId++;
      const activePort = port!;
      let entry!: PendingRequest;
      const head = new Promise<ProxiedHead>((resolveHead, rejectHead) => {
        entry = {
          port: activePort,
          resolveHead,
          rejectHead,
          queue: [],
          done: false,
        };
      });
      pending.set(id, entry);

      const onAbort = () => {
        if (!pending.delete(id)) return;
        activePort.postMessage({ type: "cancel", id });
        const error = abortError();
        entry.error = error;
        if (!entry.head) entry.rejectHead(error);
        entry.wake?.();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      entry.stopWatchingSignal = () =>
        signal.removeEventListener("abort", onAbort);

      const message: FetchRequestMessage = { type: "fetch", id, ...request };
      activePort.postMessage(message);
      return head;
    },
  };
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// Replaces `target.fetch` so that requests for files below the document's own
// directory are served through the parentframe; everything else keeps using the
// native fetch. Deliberately small: published games keep their bundled copy of
// this forever, so behaviour worth fixing later belongs in the platform.
export function installFetchShim(
  target: { fetch: typeof fetch },
  client: FetchClient,
  documentUrl: string,
) {
  const nativeFetch = target.fetch.bind(target);
  const base = new URL("./", documentUrl).href;

  target.fetch = async function mugonFetch(input, init) {
    let request: Request;
    try {
      request = new Request(input, init);
    } catch {
      return nativeFetch(input, init);
    }
    const method = request.method;
    const isVersionFile =
      request.url.startsWith(base) && (method === "GET" || method === "HEAD");
    if (!isVersionFile) return nativeFetch(request);

    const relative = request.url.slice(base.length).split("#")[0];
    const queryStart = relative.indexOf("?");
    const path = queryStart === -1 ? relative : relative.slice(0, queryStart);
    const query = queryStart === -1 ? "" : relative.slice(queryStart + 1);
    const range = request.headers.get("range") ?? undefined;

    const head = await client.request(
      { path, query, method, range },
      request.signal,
    );
    const hasNoBody = method === "HEAD" || NULL_BODY_STATUSES.has(head.status);
    if (hasNoBody) void head.body.cancel();
    const response = new Response(hasNoBody ? null : head.body, {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
    });
    Object.defineProperty(response, "url", { value: request.url });
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  } as typeof fetch;
}
