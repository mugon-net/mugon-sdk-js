import { describe, expect, it, vi } from "vitest";
import {
  createVersionFileFetcher,
  resolveVersionFileUrl,
  VersionFileCache,
  VersionFileRefusedError,
} from "./version-file-fetcher";
import type { VersionFileRequest } from "./fetch-proxy";

const BASE = "https://cdn.test/bcdn_token=abc&expires=1/games/g/versions/1/";
const KEY_BASE = "https://cdn.test/games/g/versions/1/";

function request(
  path: string,
  query = "",
  extra: Partial<VersionFileRequest> = {},
) {
  return { path, query, method: "GET" as const, ...extra };
}

describe("request validation", () => {
  const refused: [string, string][] = [
    ["empty", ""],
    ["parent traversal", "../x"],
    ["nested traversal", "a/../../x"],
    ["dot segment", "./x"],
    ["encoded dots", "%2e%2e/x"],
    ["encoded dots uppercase", "%2E%2E/x"],
    ["encoded slash", "a%2Fb"],
    ["encoded backslash", "a%5cb"],
    ["double encoding", "a%252e"],
    ["encoded nul", "a%00b"],
    ["encoded query separator", "a%3fb"],
    ["encoded fragment", "a%23b"],
    ["backslash", "a\\b"],
    ["nul", "a\u0000b"],
    ["newline", "a\nb"],
    ["absolute path", "/etc/passwd"],
    ["protocol-relative", "//evil.test/x"],
    ["scheme", "https://evil.test/x"],
    ["empty segment", "a//b"],
    ["question mark", "a?b"],
    ["fragment", "a#b"],
  ];
  it.each(refused)("refuses a path with %s", (_name, path) => {
    expect(() => resolveVersionFileUrl(BASE, request(path))).toThrow(
      VersionFileRefusedError,
    );
  });

  it.each([
    "token=x",
    "TOKEN=x",
    "%74oken=x",
    "a=1&expires=2",
    "token_path=%2F",
    "bcdn_token=1",
    "a#b",
  ])("refuses the query %s", (query) => {
    expect(() => resolveVersionFileUrl(BASE, request("a", query))).toThrow(
      VersionFileRefusedError,
    );
  });

  it("refuses methods other than GET and HEAD", () => {
    expect(() =>
      resolveVersionFileUrl(BASE, {
        path: "a",
        query: "",
        method: "POST" as never,
      }),
    ).toThrow(VersionFileRefusedError);
  });

  it("builds the url below the token-carrying base", () => {
    expect(resolveVersionFileUrl(BASE, request("dir/file.wasm", "v=1"))).toBe(
      `${BASE}dir/file.wasm?v=1`,
    );
  });

  it("keeps userinfo-looking paths inside the version directory", () => {
    const url = resolveVersionFileUrl(BASE, request("user@evil.test/x"));
    expect(url.startsWith(BASE)).toBe(true);
    expect(new URL(url).hostname).toBe("cdn.test");
  });

  it("does not confuse v1 with v10", () => {
    const base = "https://cdn.test/versions/v1/";
    expect(() => resolveVersionFileUrl(base, request("../v10/x"))).toThrow();
  });
});

class FakeCache implements VersionFileCache {
  entries = new Map<
    string,
    { body: Uint8Array; headers: [string, string][] }
  >();
  async match(key: string) {
    const entry = this.entries.get(key);
    return entry
      ? new Response(entry.body.slice(), {
          status: 200,
          headers: entry.headers,
        })
      : undefined;
  }
  async put(key: string, response: Response) {
    const body = new Uint8Array(await response.arrayBuffer());
    this.entries.set(key, { body, headers: [...response.headers] });
  }
}

function setup(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  cacheName: string | null = "files",
) {
  const cache = new FakeCache();
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
    respond(String(url), init ?? {}),
  );
  const fetcher = createVersionFileFetcher({
    versionBaseUrl: BASE,
    cacheKeyBase: KEY_BASE,
    cacheName,
    cacheStorage: { open: async () => cache },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { cache, fetchImpl, fetcher, signal: new AbortController().signal };
}

const okFile = () =>
  new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), {
    headers: { "content-type": "application/wasm" },
  });

describe("construction", () => {
  it("requires both base urls to end with a slash", () => {
    const base = {
      cacheName: null,
      versionBaseUrl: BASE,
      cacheKeyBase: KEY_BASE,
    };
    expect(() =>
      createVersionFileFetcher({
        ...base,
        versionBaseUrl: "https://cdn.test/v1",
      }),
    ).toThrow("must end with");
    expect(() =>
      createVersionFileFetcher({
        ...base,
        cacheKeyBase: "https://cdn.test/v1",
      }),
    ).toThrow("must end with");
  });
});

describe("base url provider", () => {
  it("asks the provider on every request, so a refreshed token is used", async () => {
    const bases = [
      "https://cdn.test/bcdn_token=old/games/g/versions/1/",
      "https://cdn.test/bcdn_token=new/games/g/versions/1/",
    ];
    const fetchImpl = vi.fn(async (..._args: unknown[]) => new Response("x"));
    const fetcher = createVersionFileFetcher({
      versionBaseUrl: async () => bases.shift()!,
      cacheKeyBase: KEY_BASE,
      cacheName: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const signal = new AbortController().signal;
    await fetcher(request("a"), signal);
    await fetcher(request("b"), signal);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://cdn.test/bcdn_token=old/games/g/versions/1/a",
      "https://cdn.test/bcdn_token=new/games/g/versions/1/b",
    ]);
  });

  it("refuses a provided base url without a trailing slash", async () => {
    const fetcher = createVersionFileFetcher({
      versionBaseUrl: () => "https://cdn.test/v1",
      cacheKeyBase: KEY_BASE,
      cacheName: null,
    });
    await expect(
      fetcher(request("a"), new AbortController().signal),
    ).rejects.toThrow("must end with");
  });
});

describe("fetching and caching", () => {
  it("fetches with a header-free, credential-less, redirect-refusing GET", async () => {
    const { fetcher, fetchImpl, signal } = setup(okFile);
    await (await fetcher(request("a.wasm"), signal)).arrayBuffer();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}a.wasm`);
    expect(init).toMatchObject({
      method: "GET",
      credentials: "omit",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(init).not.toHaveProperty("headers");
  });

  it("caches complete files under the token-free key and serves them without the network", async () => {
    const { fetcher, fetchImpl, cache, signal } = setup(okFile);
    const first = await fetcher(request("a.wasm"), signal);
    expect(new Uint8Array(await first.arrayBuffer())).toHaveLength(10);
    await vi.waitFor(() =>
      expect(cache.entries.has(`${KEY_BASE}a.wasm`)).toBe(true),
    );

    const second = await fetcher(request("a.wasm", "cachebust=1"), signal);
    expect(second.headers.get("content-type")).toBe("application/wasm");
    expect(new Uint8Array(await second.arrayBuffer())).toHaveLength(10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not cache or pass through the body of non-200 responses", async () => {
    const { fetcher, cache, signal } = setup(
      () => new Response("<Error>secret</Error>", { status: 403 }),
    );
    const response = await fetcher(request("a.wasm"), signal);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(cache.entries.size).toBe(0);
  });

  it("does not cache a download that fails midway", async () => {
    const { fetcher, cache, signal } = setup(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.error(new Error("connection lost"));
            },
          }),
        ),
    );
    const response = await fetcher(request("a.wasm"), signal);
    await response.arrayBuffer().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.entries.size).toBe(0);
  });

  it("does not use the cache when caching is disabled", async () => {
    const { fetcher, fetchImpl, cache, signal } = setup(okFile, null);
    await (await fetcher(request("a"), signal)).arrayBuffer();
    await (await fetcher(request("a"), signal)).arrayBuffer();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cache.entries.size).toBe(0);
  });

  it("answers HEAD from the cache without a body", async () => {
    const { fetcher, fetchImpl, cache, signal } = setup(okFile);
    await (await fetcher(request("a"), signal)).arrayBuffer();
    await vi.waitFor(() => expect(cache.entries.size).toBe(1));
    const head = await fetcher(request("a", "", { method: "HEAD" }), signal);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("range requests", () => {
  const rangeOf = async (range: string) => {
    const { fetcher, fetchImpl, signal } = setup(okFile);
    const response = await fetcher(request("a", "", { range }), signal);
    return { response, fetchImpl };
  };

  it("slices the complete file into a 206 without sending a range upstream", async () => {
    const { response, fetchImpl } = await rangeOf("bytes=2-4");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/10");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      3, 4, 5,
    ]);
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty("headers");
  });

  it("supports open-ended and suffix ranges", async () => {
    const open = await rangeOf("bytes=8-");
    expect([...new Uint8Array(await open.response.arrayBuffer())]).toEqual([
      9, 10,
    ]);
    const suffix = await rangeOf("bytes=-3");
    expect([...new Uint8Array(await suffix.response.arrayBuffer())]).toEqual([
      8, 9, 10,
    ]);
  });

  it("answers an unsatisfiable range with 416", async () => {
    const { response } = await rangeOf("bytes=50-60");
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  });

  it("serves the whole file for a malformed range", async () => {
    const { response } = await rangeOf("items=1-2");
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(10);
  });
});

describe("cache writes", () => {
  class GatedCache extends FakeCache {
    started: string[] = [];
    release!: () => void;
    private gate = new Promise<void>((resolve) => (this.release = resolve));
    async put(key: string, response: Response) {
      this.started.push(key);
      await this.gate;
      await super.put(key, response);
    }
  }

  function gatedSetup(
    respond: (url: string) => Response,
    maxBufferedBytes?: number,
  ) {
    const cache = new GatedCache();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      respond(String(url)),
    );
    const fetcher = createVersionFileFetcher({
      versionBaseUrl: BASE,
      cacheKeyBase: KEY_BASE,
      cacheName: "files",
      cacheStorage: { open: async () => cache },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxBufferedBytes,
    });
    return { cache, fetchImpl, fetcher, signal: new AbortController().signal };
  }

  const chunked = (
    chunkCount: number,
    chunkSize: number,
    produced = { count: 0 },
  ) =>
    new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (produced.count === chunkCount) {
              controller.close();
              return;
            }
            controller.enqueue(
              new Uint8Array(chunkSize).fill(produced.count % 251),
            );
            produced.count++;
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "application/octet-stream" } },
    );

  it("writes one file at a time", async () => {
    const { cache, fetcher, signal } = gatedSetup(() => okFile());
    await (await fetcher(request("a"), signal)).arrayBuffer();
    await (await fetcher(request("b"), signal)).arrayBuffer();
    await vi.waitFor(() => expect(cache.started).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.started).toEqual([`${KEY_BASE}a`]);

    cache.release();
    await vi.waitFor(() => expect(cache.entries.size).toBe(2));
  });

  it("never holds up the game for a big file that waits behind another write, and skips caching it", async () => {
    const { cache, fetchImpl, fetcher, signal } = gatedSetup(
      (url) => (url.endsWith("/small") ? okFile() : chunked(50, 1000)),
      4000,
    );
    await (await fetcher(request("small"), signal)).arrayBuffer();
    await vi.waitFor(() => expect(cache.started).toHaveLength(1));

    const big = await fetcher(request("big"), signal);
    expect((await big.arrayBuffer()).byteLength).toBe(50_000);

    cache.release();
    await vi.waitFor(() =>
      expect(cache.entries.has(`${KEY_BASE}small`)).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.entries.has(`${KEY_BASE}big`)).toBe(false);

    await (await fetcher(request("big"), signal)).arrayBuffer();
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/big")),
    ).toHaveLength(2);
  });

  it("holds the download back while the cache write is slow, and still stores the whole file", async () => {
    const produced = { count: 0 };
    const { cache, fetcher, signal } = gatedSetup(
      () => chunked(100, 1000, produced),
      4000,
    );
    const response = await fetcher(request("big"), signal);
    await vi.waitFor(() => expect(cache.started).toHaveLength(1));

    const reader = response.body!.getReader();
    let received = 0;
    void (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        received += value.byteLength;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(produced.count).toBeLessThanOrEqual(8);
    expect(received).toBeLessThan(100_000);

    cache.release();
    await vi.waitFor(() => expect(received).toBe(100_000));
    await vi.waitFor(() =>
      expect(cache.entries.get(`${KEY_BASE}big`)?.body.byteLength).toBe(
        100_000,
      ),
    );
  });
});
