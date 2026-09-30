import type { FetchVersionFile, VersionFileRequest } from "./fetch-proxy";

export class VersionFileRefusedError extends Error {
  constructor(reason: string) {
    super(`request refused: ${reason}`);
    this.name = "VersionFileRefusedError";
  }
}

export interface VersionFileCache {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface VersionFileFetcherOptions {
  // The directory the version's files are fetched from, including any token;
  // must end with "/". A function is asked on every request, so a token that
  // expires during a long session can be swapped for a fresh one.
  versionBaseUrl: string | (() => string | Promise<string>);
  // The same directory without the token; keys the cache, so a new token still
  // hits it. Must end with "/".
  cacheKeyBase: string;
  // Name of the Cache API cache to store complete files in; null disables caching.
  cacheName: string | null;
  cacheStorage?: { open(cacheName: string): Promise<VersionFileCache> };
  fetchImpl?: typeof fetch;
}

const FORBIDDEN_PATH_CHARACTERS = /[\\\u0000-\u001f\u007f?#]/;
// Percent-encoded dots, separators, `%` itself, NUL, `?` and `#`.
const FORBIDDEN_PATH_ESCAPES = /%(?:2e|2f|5c|25|00|3f|23)/i;
const MAX_PATH_LENGTH = 2048;
// Bunny's token authentication reads these from the query string, where they
// could override the token in the path.
const TOKEN_PARAMETERS = new Set([
  "token",
  "expires",
  "token_path",
  "bcdn_token",
  "token_countries",
  "token_countries_blocked",
  "token_ip",
]);

function validateRequest(request: VersionFileRequest) {
  const { path, query } = request;
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new VersionFileRefusedError("method not allowed");
  }
  if (
    typeof path !== "string" ||
    path === "" ||
    path.length > MAX_PATH_LENGTH
  ) {
    throw new VersionFileRefusedError("invalid path");
  }
  if (
    path.startsWith("/") ||
    FORBIDDEN_PATH_CHARACTERS.test(path) ||
    FORBIDDEN_PATH_ESCAPES.test(path)
  ) {
    throw new VersionFileRefusedError("invalid path");
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new VersionFileRefusedError("invalid path");
    }
  }
  if (
    typeof query !== "string" ||
    query.length > MAX_PATH_LENGTH ||
    /[\\\u0000-\u001f\u007f#]/.test(query)
  ) {
    throw new VersionFileRefusedError("invalid query");
  }
  for (const name of new URLSearchParams(query).keys()) {
    if (TOKEN_PARAMETERS.has(name.toLowerCase())) {
      throw new VersionFileRefusedError("invalid query");
    }
  }
}

// Builds the URL to fetch from and re-verifies that it stayed inside the
// version's directory.
export function resolveVersionFileUrl(
  versionBaseUrl: string,
  request: VersionFileRequest,
): string {
  validateRequest(request);
  const base = new URL(versionBaseUrl);
  const url = new URL(
    versionBaseUrl + request.path + (request.query ? `?${request.query}` : ""),
  );
  if (
    url.origin !== base.origin ||
    url.username !== "" ||
    url.password !== "" ||
    !url.href.startsWith(base.href)
  ) {
    throw new VersionFileRefusedError("path escapes the version directory");
  }
  return url.href;
}

function parseRange(range: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  let start: number;
  let end: number;
  if (match[1] === "") {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}

function refusedResponse(upstream: Response) {
  void upstream.body?.cancel();
  return new Response(null, {
    status: upstream.status,
    statusText: upstream.statusText,
  });
}

// The platform's `fetchVersionFile`: only ever fetches files below the
// version's directory, with a header-free GET (the CDN answers preflights with
// 403 and ignores `Range`), and keeps complete files in the Cache API because
// the HTTP cache does not store large entries.
export function createVersionFileFetcher(
  options: VersionFileFetcherOptions,
): FetchVersionFile {
  const assertTrailingSlash = (base: string) => {
    if (!base.endsWith("/")) {
      throw new Error(`version file base url must end with "/": ${base}`);
    }
    return base;
  };
  assertTrailingSlash(options.cacheKeyBase);
  if (typeof options.versionBaseUrl === "string") {
    assertTrailingSlash(options.versionBaseUrl);
  }
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  let cachePromise: Promise<VersionFileCache | undefined> | undefined;
  let persistRequested = false;

  function openCache() {
    cachePromise ??= (async () => {
      const storage =
        options.cacheStorage ??
        (typeof caches === "undefined" ? undefined : caches);
      if (options.cacheName === null || !storage) return undefined;
      try {
        return await storage.open(options.cacheName);
      } catch {
        return undefined;
      }
    })();
    return cachePromise;
  }

  async function store(
    cache: VersionFileCache,
    key: string,
    response: Response,
  ) {
    if (!persistRequested && typeof navigator !== "undefined") {
      persistRequested = true;
      void navigator.storage?.persist?.().catch(() => {});
    }
    try {
      await cache.put(key, response);
    } catch {
      // Quota or an aborted download; the next load fetches again.
    }
  }

  function download(url: string, method: string, signal: AbortSignal) {
    return fetchImpl(url, {
      method,
      credentials: "omit",
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal,
    });
  }

  async function getComplete(
    key: string,
    url: string,
    signal: AbortSignal,
    cache: VersionFileCache | undefined,
  ): Promise<{ blob: Blob; headers: Headers } | Response> {
    const cached = await cache?.match(key);
    if (cached) return { blob: await cached.blob(), headers: cached.headers };
    const upstream = await download(url, "GET", signal);
    if (upstream.status !== 200) return refusedResponse(upstream);
    const blob = await upstream.blob();
    if (cache) {
      await store(
        cache,
        key,
        new Response(blob, { status: 200, headers: upstream.headers }),
      );
    }
    return { blob, headers: upstream.headers };
  }

  async function serveRange(
    range: string,
    key: string,
    url: string,
    signal: AbortSignal,
    cache: VersionFileCache | undefined,
  ) {
    const complete = await getComplete(key, url, signal, cache);
    if (complete instanceof Response) return complete;
    const size = complete.blob.size;
    const bounds = parseRange(range, size);
    if (bounds === undefined) {
      return new Response(complete.blob, {
        status: 200,
        headers: complete.headers,
      });
    }
    const headers = new Headers();
    const contentType = complete.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    if (bounds === null) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("content-range", `bytes ${bounds.start}-${bounds.end}/${size}`);
    return new Response(complete.blob.slice(bounds.start, bounds.end + 1), {
      status: 206,
      headers,
    });
  }

  return async (request, signal) => {
    const versionBaseUrl = assertTrailingSlash(
      typeof options.versionBaseUrl === "string"
        ? options.versionBaseUrl
        : await options.versionBaseUrl(),
    );
    const url = resolveVersionFileUrl(versionBaseUrl, request);
    const key = options.cacheKeyBase + request.path;
    const cache = await openCache();

    if (request.range && request.method === "GET") {
      return serveRange(request.range, key, url, signal, cache);
    }

    const cached = await cache?.match(key);
    if (cached) {
      if (request.method === "HEAD") {
        void cached.body?.cancel();
        return new Response(null, { status: 200, headers: cached.headers });
      }
      return cached;
    }

    const upstream = await download(url, request.method, signal);
    if (upstream.status !== 200) return refusedResponse(upstream);
    if (request.method === "HEAD" || !cache || !upstream.body) return upstream;

    const [forGame, forCache] = upstream.body.tee();
    void store(
      cache,
      key,
      new Response(forCache, { status: 200, headers: upstream.headers }),
    );
    return new Response(forGame, { status: 200, headers: upstream.headers });
  };
}
