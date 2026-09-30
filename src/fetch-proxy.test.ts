import { afterEach, describe, expect, it, vi } from "vitest";
import { serveFetchPort, VersionFileRequest } from "./fetch-proxy";
import { createFetchClient, installFetchShim } from "./fetch-shim";
import { VersionFileRefusedError } from "./version-file-fetcher";

const DOCUMENT = "http://game.test/dir/index.html";
const MIB = 1024 * 1024;

function bytesOf(length: number, fill: number) {
  return new Uint8Array(length).fill(fill);
}

function streamOf(...chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function setup(
  fetchVersionFile: (
    request: VersionFileRequest,
    signal: AbortSignal,
  ) => Promise<Response>,
  options: { windowBytes?: number; maxConcurrent?: number } = {},
  attachImmediately = true,
) {
  const channel = new MessageChannel();
  const counted = { bytes: 0 };
  const dispose = serveFetchPort(channel.port1, {
    fetchVersionFile,
    onBytes: (bytes) => (counted.bytes += bytes),
    ...options,
  });
  const client = createFetchClient();
  const native = vi.fn(async () => new Response("native"));
  const target = { fetch: native as unknown as typeof fetch };
  installFetchShim(target, client, DOCUMENT);
  if (attachImmediately) client.attach(channel.port2);
  disposers.push(() => {
    dispose();
    channel.port2.close();
  });
  return { client, native, target, counted, channel };
}

const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

describe("fetch shim over the proxy", () => {
  it("delivers a multi-chunk body with status, allowlisted headers, url and type", async () => {
    const requests: VersionFileRequest[] = [];
    const { target, counted } = setup(async (request) => {
      requests.push(request);
      return new Response(streamOf(bytesOf(10, 1), bytesOf(5, 2)), {
        status: 200,
        headers: {
          "content-type": "application/wasm",
          "x-internal": "secret",
        },
      });
    });

    const response = await target.fetch(
      "http://game.test/dir/a/b.wasm?v=1#frag",
    );
    expect(response.status).toBe(200);
    expect(response.url).toBe("http://game.test/dir/a/b.wasm?v=1#frag");
    expect(response.type).toBe("basic");
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(response.headers.get("x-internal")).toBeNull();
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toHaveLength(15);
    expect(body[9]).toBe(1);
    expect(body[10]).toBe(2);
    expect(requests).toEqual([
      { path: "a/b.wasm", query: "v=1", method: "GET", range: undefined },
    ]);
    expect(counted.bytes).toBe(15);
  });

  it("uses the native fetch for foreign urls and non-GET requests", async () => {
    const { target, native } = setup(async () => new Response("proxied"));
    await target.fetch("https://elsewhere.test/x");
    await target.fetch("http://game.test/other/x");
    await target.fetch("http://game.test/dir/x", { method: "POST", body: "y" });
    expect(native).toHaveBeenCalledTimes(3);
  });

  it("hands request bodies of non-proxied requests to the native fetch intact", async () => {
    const received: string[] = [];
    const { target, native } = setup(async () => new Response("proxied"));
    native.mockImplementation((async (request: Request) => {
      received.push(await request.text());
      return new Response("native");
    }) as never);

    await target.fetch(
      new Request("https://api.test/x", {
        method: "POST",
        body: "from-request",
      }),
    );
    await target.fetch("https://api.test/x", {
      method: "POST",
      body: "from-init",
    });
    await target.fetch(
      new Request("https://api.test/x", {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("from-stream"));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
    );
    expect(received).toEqual(["from-request", "from-init", "from-stream"]);
  });

  it("keeps requests waiting until the parentframe hands over the port", async () => {
    const { target, client, channel, native } = setup(
      async () => new Response("late"),
      {},
      false,
    );
    const pendingResponse = target.fetch("http://game.test/dir/file");
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.attach(channel.port2);
    expect(await (await pendingResponse).text()).toBe("late");
    expect(native).not.toHaveBeenCalled();
  });

  it("forwards the range header and supports HEAD without a body", async () => {
    const seen: VersionFileRequest[] = [];
    const { target } = setup(async (request) => {
      seen.push(request);
      return new Response(request.method === "HEAD" ? null : "data", {
        headers: { "content-length": "4" },
      });
    });
    await target.fetch("http://game.test/dir/f", {
      headers: { range: "bytes=0-1" },
    });
    const head = await target.fetch("http://game.test/dir/f", {
      method: "HEAD",
    });
    expect(head.headers.get("content-length")).toBe("4");
    expect(await head.text()).toBe("");
    expect(seen.map((request) => [request.method, request.range])).toEqual([
      ["GET", "bytes=0-1"],
      ["HEAD", undefined],
    ]);
  });

  it("passes non-OK statuses through", async () => {
    const { target } = setup(async () => new Response(null, { status: 404 }));
    const response = await target.fetch("http://game.test/dir/missing");
    expect(response.status).toBe(404);
    expect(response.ok).toBe(false);
  });

  it("rejects with the refusal reason, and generically for other failures", async () => {
    const refused = setup(async () => {
      throw new VersionFileRefusedError("invalid path");
    });
    await expect(
      refused.target.fetch("http://game.test/dir/x"),
    ).rejects.toThrow("request refused: invalid path");

    const broken = setup(async () => {
      throw new Error("https://cdn.test/secret-token exploded");
    });
    await expect(broken.target.fetch("http://game.test/dir/x")).rejects.toThrow(
      /^Failed to fetch$/,
    );
  });

  it("errors the body when the upstream stream fails midway", async () => {
    const { target } = setup(async () => {
      let sent = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent) return controller.error(new Error("boom"));
            sent = true;
            controller.enqueue(bytesOf(4, 1));
          },
        }),
      );
    });
    const response = await target.fetch("http://game.test/dir/x");
    await expect(response.arrayBuffer()).rejects.toThrow("Failed to fetch");
  });

  it("stops reading ahead once the send window is used up", async () => {
    let pulled = 0;
    const totalChunks = 64;
    const { target, counted } = setup(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (pulled === totalChunks) return controller.close();
                pulled++;
                controller.enqueue(bytesOf(MIB, 1));
              },
            },
            { highWaterMark: 0 },
          ),
        ),
      { windowBytes: 4 * MIB },
    );
    const response = await target.fetch("http://game.test/dir/big");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pulled).toBeGreaterThanOrEqual(4);
    expect(pulled).toBeLessThanOrEqual(6);

    const body = await response.arrayBuffer();
    expect(body.byteLength).toBe(totalChunks * MIB);
    expect(counted.bytes).toBe(totalChunks * MIB);
  });

  it("aborts the upstream request when the game aborts", async () => {
    let upstreamSignal!: AbortSignal;
    let cancelled = false;
    const { target } = setup(
      async (_request, signal) => {
        upstreamSignal = signal;
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(bytesOf(MIB, 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      },
      { windowBytes: MIB },
    );
    const controller = new AbortController();
    const response = await target.fetch("http://game.test/dir/x", {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(upstreamSignal.aborted).toBe(true));
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("aborts before the head arrives", async () => {
    const { target } = setup(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const pendingResponse = target.fetch("http://game.test/dir/x", {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await expect(pendingResponse).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts the upstream request when the game cancels the body", async () => {
    let upstreamSignal!: AbortSignal;
    const { target } = setup(async (_request, signal) => {
      upstreamSignal = signal;
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(bytesOf(16, 1));
          },
        }),
      );
    });
    const response = await target.fetch("http://game.test/dir/x");
    await response.body!.cancel();
    await vi.waitFor(() => expect(upstreamSignal.aborted).toBe(true));
  });

  it("limits concurrent upstream requests", async () => {
    const releases: (() => void)[] = [];
    let active = 0;
    let maxActive = 0;
    const { target } = setup(
      () => {
        active++;
        maxActive = Math.max(maxActive, active);
        return new Promise<Response>((resolve) =>
          releases.push(() => {
            active--;
            resolve(new Response("ok"));
          }),
        );
      },
      { maxConcurrent: 2 },
    );
    const responses = [1, 2, 3, 4].map((index) =>
      target.fetch(`http://game.test/dir/f${index}`),
    );
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(releases).toHaveLength(2);
    while (releases.length) {
      releases.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await vi.waitFor(() => expect(maxActive).toBe(2));
    await Promise.all(responses);
  });

  it("fails in-flight requests when a new port replaces the old one", async () => {
    const { target, client } = setup(() => new Promise<Response>(() => {}));
    const pendingResponse = target.fetch("http://game.test/dir/x");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const replacement = new MessageChannel();
    client.attach(replacement.port2);
    disposers.push(() => replacement.port1.close());
    await expect(pendingResponse).rejects.toThrow("connection");
  });
});
