"use client";

/**
 * Registering the scanner's service worker.
 *
 * Two things here are current-Next.js specific and are NOT what older guides
 * (or a from-memory implementation) would do:
 *
 *   1. The worker is referenced as `new URL("./scan-service-worker.js",
 *      import.meta.url)`, not as a hand-placed file in `public/`. Next compiles
 *      it into `distDir/static/service-worker/`, gives it a stable URL across
 *      builds so the browser keeps one registration, and serves it with
 *      `Cache-Control: public, max-age=0, must-revalidate`.
 *   2. That output directory is not `/`, so a worker living there could
 *      normally only control `/_next/static/service-worker/**`. Next.js emits a
 *      `Service-Worker-Allowed` header for exactly that path (see
 *      next/dist/build/index.js and next/dist/server/lib/router-server.js),
 *      which is what makes the `/scan` scope below legal in dev and in prod.
 *
 * SCOPE IS `/scan`, DELIBERATELY. The obvious scope is `/`, and it would be
 * wrong: the rest of LEKHA is a full accounting application whose every screen
 * is per-company, per-user and live. Nothing there should be answered from a
 * cache, and a worker scoped to `/` is one careless edit away from doing it.
 * The scanner is the only surface that has to survive with no signal, so it is
 * the only surface the worker can touch.
 */

const SCOPE = "/scan";

export type ScanServiceWorkerState =
  | "unsupported"
  | "registered"
  | "failed";

/**
 * Hand the worker the list of build assets this page actually loaded.
 *
 * Registration necessarily happens after /scan has fetched its own JS and CSS,
 * so those requests were never seen by a fetch handler and are not in the
 * cache. Without this, the first offline load would find the HTML shell and
 * none of the code, and render a blank screen — the failure would only show up
 * on a device that had visited twice, which is exactly the kind of bug that
 * ships.
 */
function warmBuildAssets(worker: ServiceWorker | null): void {
  if (!worker || typeof performance === "undefined") return;
  try {
    const urls = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter(
        (name) =>
          name.startsWith(window.location.origin) && name.includes("/_next/static/")
      );
    if (urls.length === 0) return;
    worker.postMessage({ type: "lekha-scan-warm", urls });
  } catch {
    // Resource timing is unavailable or blocked. The cache simply fills in on
    // the next load instead; nothing here is worth an error on the shutter.
  }
}

export async function registerScanServiceWorker(): Promise<ScanServiceWorkerState> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return "unsupported";
  }
  try {
    // `new URL(..., import.meta.url)` is the expression Next.js statically
    // detects, so it has to appear literally; the query is added afterwards, at
    // runtime, which the bundler does not care about.
    const workerUrl = new URL("./scan-service-worker.js", import.meta.url);
    if (process.env.NODE_ENV !== "production") {
      // Tells the worker to prefer the network for build assets. In production
      // every chunk URL is content-hashed, so a cached chunk is always the
      // right chunk; `next dev` reuses the SAME filenames and changes their
      // contents, so a cache-first worker happily serves the code you edited
      // five seconds ago and makes the dev server look broken. Found exactly
      // that way, browser-testing this feature.
      workerUrl.searchParams.set("dev", "1");
    }
    const registration = await navigator.serviceWorker.register(workerUrl, {
      scope: SCOPE,
      updateViaCache: "none",
    });

    const warm = () =>
      warmBuildAssets(
        navigator.serviceWorker.controller ??
          registration.active ??
          registration.waiting ??
          null
      );

    if (navigator.serviceWorker.controller || registration.active) {
      warm();
    } else {
      // First-ever install: the worker claims clients during `activate`, and
      // `controllerchange` is when that has actually happened.
      navigator.serviceWorker.addEventListener("controllerchange", warm, {
        once: true,
      });
    }
    return "registered";
  } catch (error) {
    // A registration that fails is a scanner that will not open offline. It is
    // NOT a scanner that is broken, so this never surfaces to the shop floor —
    // but it does belong in the console for whoever is looking.
    console.error(
      "[scan] service worker registration failed:",
      error instanceof Error ? error.message : error
    );
    return "failed";
  }
}
