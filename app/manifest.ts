import type { MetadataRoute } from "next";

// Makes LEKHA installable ("Add to Home Screen" / desktop install prompt) —
// the dossier's own critical finding was "desktop-only in practice", no
// manifest and no service worker at all. This is the manifest half: a
// self-contained special file Next.js auto-links in every page's <head>,
// no edit to app/layout.tsx needed (that file already carries unrelated
// uncommitted changes from another concurrent session in this shared
// working tree — touching it would risk sweeping those into this commit).
//
// Icons are generated at app/icon-192 and app/icon-512 (ImageResponse —
// no image-editing tool or external asset needed, see those route files),
// not static PNGs in public/.
//
// Service-worker-based full offline caching is a separate, larger piece
// (needs a third-party library like Serwist — Next.js has no built-in
// service-worker generation) and is not attempted here; this migration
// only covers installability, which needs just the manifest + icons +
// HTTPS, no service worker at all.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LEKHA — Statutory Accounting",
    short_name: "LEKHA",
    description: "Accounting and statutory compliance for Indian businesses",
    start_url: "/companies",
    display: "standalone",
    background_color: "#F7F7F5",
    theme_color: "#3654D6",
    icons: [
      {
        src: "/icon-192",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
