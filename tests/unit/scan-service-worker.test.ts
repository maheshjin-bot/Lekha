import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The scanner's service worker, driven directly.
 *
 * This is here because the one thing that most needs proving cannot be produced
 * in this environment's browser: a genuinely dead network. Next 16 refuses a
 * second `next dev` in one directory, the dev server on :3000 belongs to a
 * concurrent session and must stay up, and a local reverse proxy — tried —
 * serves every asset happily but cannot get Chrome to register a service worker
 * through it. So the worker is loaded as source, given a fake `self`, `caches`
 * and `fetch`, and asked the questions a dead godown would ask it.
 *
 * The two properties under test are not equally important. The offline fallback
 * is the feature. The CACHING ALLOWLIST is the safety boundary: this is a
 * multi-tenant accounting database, and a worker that quietly kept a copy of
 * `/api/capture/upload` or of a document image from the storage bucket would be
 * a disclosure, not a bug. Every "must never cache" line in the worker's own
 * header has an assertion here.
 */

type FakeResponse = {
  ok: boolean;
  status: number;
  redirected: boolean;
  body: string;
  clone(): FakeResponse;
  text(): Promise<string>;
};

function response(
  body: string,
  init?: { status?: number; redirected?: boolean }
): FakeResponse {
  const status = init?.status ?? 200;
  const self: FakeResponse = {
    ok: status >= 200 && status < 300,
    status,
    redirected: init?.redirected ?? false,
    body,
    clone: () => response(body, init),
    text: async () => body,
  };
  return self;
}

function keyOf(request: unknown): string {
  if (typeof request === "string") return request;
  return (request as { url: string }).url;
}

function fakeCaches() {
  const stores = new Map<string, Map<string, FakeResponse>>();
  const cacheFor = (name: string) => {
    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }
    return {
      match: async (request: unknown) => store.get(keyOf(request)),
      put: async (request: unknown, value: FakeResponse) =>
        void store.set(keyOf(request), value),
      delete: async (request: unknown) => store.delete(keyOf(request)),
      keys: async () => [...store.keys()].map((url) => ({ url })),
    };
  };
  return {
    api: {
      open: async (name: string) => cacheFor(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match: async (request: unknown) => {
        for (const store of stores.values()) {
          const hit = store.get(keyOf(request));
          if (hit) return hit;
        }
        return undefined;
      },
    },
    stores,
    contents: () => [...(stores.get("lekha-scan-v1")?.keys() ?? [])],
  };
}

const ORIGIN = "https://books.example.com";

type Listener = (event: Record<string, unknown>) => void;

function loadWorker(options?: { dev?: boolean }) {
  const source = readFileSync(
    path.join(process.cwd(), "lib/scan/scan-service-worker.js"),
    "utf8"
  );
  const listeners = new Map<string, Listener[]>();
  const caches = fakeCaches();
  let network: (input: unknown) => Promise<FakeResponse> = async () =>
    response("<html>from the server</html>");

  const workerSelf = {
    location: {
      href: `${ORIGIN}/_next/static/service-worker/sw-scan-abc.js${options?.dev ? "?dev=1" : ""}`,
      origin: ORIGIN,
    },
    addEventListener: (type: string, fn: Listener) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };

  // `new Function` rather than an import: the point of this suite is to
  // exercise the SHIPPED worker file, not a copy of it, and a service worker
  // has no module shape to import — it registers itself against globals.
  new Function("self", "caches", "fetch", source)(
    workerSelf,
    caches.api,
    (input: unknown) => network(input)
  );

  const waits: Promise<unknown>[] = [];

  /**
   * Returns the SETTLED outcome rather than the promise the worker handed to
   * respondWith. A raw rejecting promise handed back to a test is reported by
   * vitest as an unhandled rejection whatever the test then does with it, and
   * one of the cases under test — offline with no cached shell — is supposed to
   * reject. `null` means the worker did not call respondWith at all, which is
   * how it declines to touch a request.
   */
  async function fire(
    type: string,
    event: Record<string, unknown>
  ): Promise<{ response?: FakeResponse; error?: unknown } | null> {
    const settled: Promise<{ response?: FakeResponse; error?: unknown }>[] = [];
    const wrapped = {
      ...event,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      respondWith: (p: Promise<FakeResponse>) =>
        void settled.push(p.then((response) => ({ response }), (error) => ({ error }))),
    };
    for (const fn of listeners.get(type) ?? []) fn(wrapped);
    await Promise.all(waits.splice(0));
    return settled.length > 0 ? await settled[0] : null;
  }

  function request(url: string, init?: { mode?: string; method?: string }) {
    return {
      url: url.startsWith("http") ? url : ORIGIN + url,
      mode: init?.mode ?? "no-cors",
      method: init?.method ?? "GET",
    };
  }

  return {
    fire,
    request,
    caches,
    setNetwork: (fn: typeof network) => {
      network = fn;
    },
    settle: async () => {
      await Promise.all(waits.splice(0));
    },
  };
}

describe("the scanner service worker — what it caches", () => {
  it("keeps the /scan shell and the build assets the page asked it to warm", async () => {
    const w = loadWorker();
    await w.fire("install", {});
    expect(w.caches.contents()).toContain("/scan");

    await w.fire("message", {
      data: {
        type: "lekha-scan-warm",
        urls: [`${ORIGIN}/_next/static/chunks/main.js`, `${ORIGIN}/_next/static/media/f.woff2`],
      },
    });
    await w.settle();
    expect(w.caches.contents()).toContain(`${ORIGIN}/_next/static/chunks/main.js`);
    expect(w.caches.contents()).toContain(`${ORIGIN}/_next/static/media/f.woff2`);
  });

  it("refuses to warm anything outside the allowlist, however it is asked", async () => {
    const w = loadWorker();
    await w.fire("install", {});
    const before = w.caches.contents().length;

    await w.fire("message", {
      data: {
        type: "lekha-scan-warm",
        urls: [
          // The upload route, an authenticated multi-tenant endpoint.
          `${ORIGIN}/api/capture/upload`,
          // Another company's dashboard.
          `${ORIGIN}/395e9f55/dashboard`,
          // A document image in the storage bucket.
          "https://xyz.supabase.co/storage/v1/object/documents/co/capture/page-001.jpg",
          // A build asset on somebody else's origin.
          "https://evil.example.com/_next/static/chunks/main.js",
        ],
      },
    });
    await w.settle();
    expect(w.caches.contents()).toHaveLength(before);
  });

  it("never touches an API request, a cross-origin request or a write", async () => {
    const w = loadWorker();
    await w.fire("install", {});

    // No respondWith at all means the request goes to the network untouched.
    expect(await w.fire("fetch", { request: w.request("/api/capture/upload", { method: "POST" }) })).toBeNull();
    expect(await w.fire("fetch", { request: w.request("/api/capture/extract") })).toBeNull();
    expect(
      await w.fire("fetch", {
        request: w.request("https://xyz.supabase.co/rest/v1/rpc/get_my_capture_drafts"),
      })
    ).toBeNull();
    expect(
      await w.fire("fetch", { request: w.request("/scan", { mode: "navigate", method: "POST" }) })
    ).toBeNull();
    // An RSC payload is per-user server-rendered data, not a shell.
    expect(
      await w.fire("fetch", {
        request: w.request("/scan?_rsc=abc123", { mode: "navigate" }),
      })
    ).toBeNull();
  });
});

describe("the scanner service worker — with no signal", () => {
  it("serves the cached shell when the network is gone", async () => {
    const w = loadWorker();
    await w.fire("install", {});

    // The godown.
    w.setNetwork(async () => {
      throw new TypeError("Failed to fetch");
    });
    const served = await w.fire("fetch", {
      request: w.request("/scan", { mode: "navigate" }),
    });
    expect(served?.response).toBeDefined();
    await expect(served!.response!.text()).resolves.toContain("from the server");
  });

  it("does not pretend to have a shell it never cached", async () => {
    const w = loadWorker();
    // Install while already offline: nothing to cache.
    w.setNetwork(async () => {
      throw new TypeError("Failed to fetch");
    });
    await w.fire("install", {});
    const served = await w.fire("fetch", {
      request: w.request("/scan", { mode: "navigate" }),
    });
    // The browser turns this rejection into its own offline page, which is the
    // honest outcome: this handset has never successfully loaded the scanner,
    // so there is nothing truthful it could show instead.
    expect((served?.error as Error)?.message).toMatch(/no cached scanner shell/);
  });

  it("falls back to a cached build asset, and 504s rather than hanging on one it lacks", async () => {
    const w = loadWorker();
    await w.fire("install", {});
    await w.fire("message", {
      data: { type: "lekha-scan-warm", urls: [`${ORIGIN}/_next/static/chunks/main.js`] },
    });
    await w.settle();

    w.setNetwork(async () => {
      throw new TypeError("Failed to fetch");
    });
    const hit = await w.fire("fetch", { request: w.request("/_next/static/chunks/main.js") });
    expect(hit!.response!.status).toBe(200);

    const miss = await w.fire("fetch", { request: w.request("/_next/static/chunks/never-seen.js") });
    expect(miss!.response!.status).toBe(504);
  });
});

describe("the scanner service worker — whose shell is it", () => {
  it("throws the shell away when the server says this session is over", async () => {
    const w = loadWorker();
    await w.fire("install", {});
    expect(w.caches.contents()).toContain("/scan");

    // Redirected to /login — the handset was signed out, and the cached page
    // names the last person's companies.
    w.setNetwork(async () => response("<html>login</html>", { status: 200, redirected: true }));
    await w.fire("fetch", { request: w.request("/scan", { mode: "navigate" }) });
    expect(w.caches.contents()).not.toContain("/scan");
  });

  it("keeps the shell through a 5xx, which says nothing about who is signed in", async () => {
    const w = loadWorker();
    await w.fire("install", {});

    w.setNetwork(async () => response("bad gateway", { status: 502 }));
    await w.fire("fetch", { request: w.request("/scan", { mode: "navigate" }) });
    // A proxy hiccup during a deploy must not destroy the only copy of the
    // scanner a phone in a dead spot can still open.
    expect(w.caches.contents()).toContain("/scan");
  });

  it("replaces the shell on every successful load, so it never goes stale", async () => {
    const w = loadWorker();
    await w.fire("install", {});
    w.setNetwork(async () => response("<html>second visit</html>"));
    await w.fire("fetch", { request: w.request("/scan", { mode: "navigate" }) });
    const cached = await w.caches.api.match("/scan");
    await expect(cached!.text()).resolves.toContain("second visit");
  });
});

describe("the scanner service worker — development", () => {
  it("prefers the network for build assets in dev, and the cache in production", async () => {
    for (const dev of [false, true]) {
      const w = loadWorker({ dev });
      await w.fire("install", {});
      await w.fire("message", {
        data: { type: "lekha-scan-warm", urls: [`${ORIGIN}/_next/static/chunks/main.js`] },
      });
      await w.settle();

      w.setNetwork(async () => response("the code you just saved"));
      const served = await w.fire("fetch", {
        request: w.request("/_next/static/chunks/main.js"),
      });
      const text = await served!.response!.text();
      // `next dev` reuses filenames and changes their contents, so a cache-first
      // worker serves the code from before your last save. Production hashes
      // every chunk name, so the cached one is by definition still right.
      expect(text === "the code you just saved").toBe(dev);
    }
  });
});
