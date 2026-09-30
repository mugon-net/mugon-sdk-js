import type {
  FromGameframeFetchMessage,
  ToGameframeFetchMessage,
} from "./protocol";

export interface VersionFileRequest {
  path: string;
  query: string;
  method: "GET" | "HEAD";
  range?: string;
}

// Owned by the platform: validates the request, builds the signed URL, fetches
// and caches. It throws or returns a non-OK response for anything it refuses;
// the SDK never sees a token, a base URL or a cache.
export type FetchVersionFile = (
  request: VersionFileRequest,
  signal: AbortSignal,
) => Promise<Response>;

export interface FetchProxyOptions {
  fetchVersionFile: FetchVersionFile;
  // Called with the size of every chunk handed to the game.
  onBytes?: (bytes: number) => void;
  maxConcurrent?: number;
  // How many bytes may be in flight to the game before it has consumed them.
  windowBytes?: number;
}

const DEFAULT_MAX_CONCURRENT = 8;
const DEFAULT_WINDOW_BYTES = 8 * 1024 * 1024;
const FORWARDED_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "last-modified",
];
const GENERIC_ERROR = "Failed to fetch";

interface Transfer {
  abort: AbortController;
  credit: number;
  wake?: () => void;
}

function isRequest(message: unknown): message is FromGameframeFetchMessage & {
  type: "fetch";
} {
  const request = message as Record<string, unknown>;
  return (
    Number.isSafeInteger(request.id) &&
    typeof request.path === "string" &&
    typeof request.query === "string" &&
    (request.method === "GET" || request.method === "HEAD") &&
    (request.range === undefined || typeof request.range === "string")
  );
}

// Serves the game's file requests over `port` with the platform's
// `fetchVersionFile`. Returns a function that tears everything down.
export function serveFetchPort(
  port: MessagePort,
  options: FetchProxyOptions,
): () => void {
  const windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const transfers = new Map<number, Transfer>();
  const waitingForSlot: (() => void)[] = [];
  let activeCount = 0;
  let closed = false;

  const post = (
    message: ToGameframeFetchMessage,
    transfer?: Transferable[],
  ) => {
    if (!closed) port.postMessage(message, transfer ?? []);
  };

  async function acquireSlot(signal: AbortSignal) {
    while (activeCount >= maxConcurrent) {
      if (signal.aborted) return false;
      await new Promise<void>((resolve) => {
        waitingForSlot.push(resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if (signal.aborted) return false;
    activeCount++;
    return true;
  }

  function releaseSlot() {
    activeCount--;
    waitingForSlot.shift()?.();
  }

  async function handleFetch(
    request: FromGameframeFetchMessage & { type: "fetch" },
  ) {
    const { id } = request;
    const transfer: Transfer = {
      abort: new AbortController(),
      credit: windowBytes,
    };
    transfers.set(id, transfer);
    const { signal } = transfer.abort;
    let hasSlot = false;
    try {
      hasSlot = await acquireSlot(signal);
      if (!hasSlot) return;

      const response = await options.fetchVersionFile(
        {
          path: request.path,
          query: request.query,
          method: request.method,
          range: request.range,
        },
        signal,
      );
      if (signal.aborted) {
        void response.body?.cancel();
        return;
      }

      const headers: [string, string][] = [];
      for (const name of FORWARDED_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) headers.push([name, value]);
      }
      post({
        type: "head",
        id,
        status: response.status,
        statusText: response.statusText,
        headers,
      });

      if (!response.body || request.method === "HEAD") {
        void response.body?.cancel();
        post({ type: "end", id });
        return;
      }
      const reader = response.body.getReader();
      try {
        while (true) {
          while (transfer.credit <= 0 && !signal.aborted) {
            await new Promise<void>((resolve) => (transfer.wake = resolve));
          }
          if (signal.aborted) return;
          const { done, value } = await reader.read();
          if (done) {
            post({ type: "end", id });
            return;
          }
          transfer.credit -= value.byteLength;
          options.onBytes?.(value.byteLength);
          const owned =
            value.byteOffset === 0 &&
            value.byteLength === value.buffer.byteLength
              ? value
              : value.slice();
          post({ type: "chunk", id, data: owned }, [owned.buffer]);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (!signal.aborted) {
        post({
          type: "error",
          id,
          message:
            error instanceof Error && error.name === "VersionFileRefusedError"
              ? error.message
              : GENERIC_ERROR,
        });
      }
    } finally {
      if (hasSlot) releaseSlot();
      transfers.delete(id);
    }
  }

  port.onmessage = (event: MessageEvent) => {
    const message = event.data as FromGameframeFetchMessage | undefined;
    switch (message?.type) {
      case "fetch":
        if (isRequest(message) && !transfers.has(message.id)) {
          void handleFetch(message);
        }
        break;
      case "cancel": {
        const transfer = transfers.get(message.id);
        transfer?.abort.abort();
        transfer?.wake?.();
        break;
      }
      case "credit": {
        const transfer = transfers.get(message.id);
        if (transfer && Number.isFinite(message.bytes) && message.bytes > 0) {
          transfer.credit += message.bytes;
          transfer.wake?.();
        }
        break;
      }
    }
  };

  return () => {
    closed = true;
    for (const transfer of transfers.values()) {
      transfer.abort.abort();
      transfer.wake?.();
    }
    port.onmessage = null;
    port.close();
  };
}
