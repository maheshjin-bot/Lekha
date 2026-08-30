/**
 * The scanner's app shell, so /scan LOADS with no signal.
 *
 * Everything else in phase 4 is about a photograph surviving until there is a
 * link. None of it matters if the person opens the scanner in a dead spot and
 * gets the browser's offline dinosaur, because then they cannot even take the
 * photograph. This file is the half that fixes that, and it is deliberately
 * about forty lines of logic — no Workbox, no Serwist. This project already
 * rejected an 8 MB computer-vision library for the same reason: every byte here
 * is downloaded over shop-floor mobile data by a handset that is not new.
 *
 * WHAT IT IS ALLOWED TO CACHE, and this is the important part:
 *
 *   - the /scan navigation response (an HTML shell), and
 *   - immutable build assets under /_next/static/, plus the manifest and icons.
 *
 * WHAT IT MUST NEVER CACHE:
 *
 *   - anything under /api/ — the upload route, the extract route, everything.
 *   - any cross-origin request, which is every Supabase call and every document
 *     image in the storage bucket.
 *   - any non-GET request.
 *   - any RSC payload (`?_rsc=`), which is server-rendered per-user data.
 *
 * This is a MULTI-TENANT ACCOUNTING DATABASE. A cached response handed back to
 * the wrong company would not be a glitch, it would be a disclosure. The
 * allowlist below is therefore a positive list of two things rather than a
 * blocklist of everything dangerous, because a blocklist is one forgotten path
 * away from being wrong.
 *
 * The one genuine judgement call: the /scan HTML shell is rendered per user and
 * names the companies and branches that person may send into. It is cached
 * because there is no other way for the scanner to open offline. The mitigation
 * is that it is (a) network-first, so an online device always sees fresh
 * server-rendered truth, (b) private to one browser profile that had already
 * fetched exactly this page, and (c) deleted the moment the server redirects
 * /scan to /login, which is what a signed-out or expired session looks like.
 * That last part is what stops a shared handset showing the previous person's
 * company names after they sign out.
 */

const CACHE = "lekha-scan-v1";
const SHELL = "/scan";

/**
 * Set by the registration in development only (see registerScanServiceWorker).
 *
 * `next dev` serves build assets under STABLE filenames whose contents change
 * on every edit, so a cache-first worker keeps handing the page the code from
 * before your last save — the app looks broken and the cache is invisible. A
 * production build content-hashes every chunk, where a cached chunk is by
 * definition still correct, so the fast path only applies there. Offline still
 * works in both: dev merely tries the network first and falls back.
 */
const DEV = new URL(self.location.href).searchParams.get("dev") === "1";

/** Static, user-independent, and safe to hold. Nothing else qualifies. */
function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname === "/manifest.webmanifest" ||
    url.pathname === "/icon-192" ||
    url.pathname === "/icon-512"
  );
}

function isShellNavigation(request, url) {
  return (
    request.mode === "navigate" &&
    request.method === "GET" &&
    (url.pathname === SHELL || url.pathname === SHELL + "/") &&
    !url.searchParams.has("_rsc")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Warm the shell now so "install it, then walk into the godown" works on
      // the FIRST trip rather than the second. A same-origin request from a
      // service worker carries the session cookie, so this is the real
      // authenticated page and not a login redirect.
      try {
        const response = await fetch(SHELL, { credentials: "same-origin" });
        if (response.ok && !response.redirected) {
          await cache.put(SHELL, response.clone());
        }
      } catch {
        // Installed while already offline. The navigation handler will fill
        // this in on the first successful load instead.
      }
      // Take over straight away. Without this the very first offline load after
      // installing still fails, because the worker would sit in `waiting` until
      // every tab on the origin had closed — and a shop-floor phone keeps the
      // scanner open all day.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("lekha-scan-") && name !== CACHE)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/**
 * The page tells us which build assets it actually used.
 *
 * Needed because of an ordering problem that is easy to miss: registration
 * happens FROM /scan, after the page has already fetched its own JS and CSS. By
 * the time this worker controls anything, those requests are long finished and
 * were never seen by a fetch handler — so the cache would hold the HTML shell
 * and none of the code that makes it work, and the first offline load would
 * render a blank page. The page hands over its own resource list to close that
 * gap on the first visit rather than the second.
 */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "lekha-scan-warm" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        data.urls.slice(0, 200).map(async (raw) => {
          try {
            const url = new URL(raw, self.location.origin);
            if (url.origin !== self.location.origin || !isStaticAsset(url)) return;
            if (await cache.match(url.href)) return;
            const response = await fetch(url.href, { credentials: "same-origin" });
            if (response.ok) await cache.put(url.href, response);
          } catch {
            // One asset that will not warm is not worth failing the batch over.
          }
        })
      );
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Everything the allowlist does not name is left completely alone — not read
  // from the cache, not written to it, not even observed.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (isShellNavigation(request, url)) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE);
          if (response.ok && !response.redirected) {
            await cache.put(SHELL, response.clone());
          } else if (
            response.redirected ||
            response.status === 401 ||
            response.status === 403
          ) {
            // The server sent us to /login, or refused us outright: this
            // session is gone. Drop the shell so the next offline open cannot
            // show a signed-out person the last user's company list.
            //
            // Deliberately NOT any other failure. An earlier version deleted on
            // every non-ok response, which meant one 502 from a proxy during a
            // deploy would throw away the only copy of the scanner a phone in a
            // dead spot could still open. A 5xx says nothing about who is
            // signed in, so it must leave the shell alone.
            await cache.delete(SHELL);
          }
          return response;
        } catch {
          const cached = await caches.match(SHELL);
          if (cached) return cached;
          throw new Error("offline and no cached scanner shell");
        }
      })()
    );
    return;
  }

  if (isStaticAsset(url)) {
    // Stale-while-revalidate. Cache-first alone would pin a build's JS forever
    // on a phone that never clears site data; network-first would make every
    // load on a two-bar link wait for a round trip it does not need, since a
    // content-hashed chunk can never be stale.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => null);
        if (cached && !DEV) {
          event.waitUntil(network);
          return cached;
        }
        // Dev, or nothing cached yet: the network is the truth, and the cache
        // is only there for when it is not answering.
        const fresh = await network;
        if (fresh) return fresh;
        if (cached) return cached;
        return new Response("", { status: 504, statusText: "Offline" });
      })()
    );
  }
});
