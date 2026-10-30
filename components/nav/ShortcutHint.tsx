"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

/** Bumped in the key itself, not the value, if this hint's copy or trigger
 * conditions ever change enough that everyone should see it again. */
const STORAGE_PREFIX = "lekha.shortcutHint.seen.v1:";

/** Tailwind's `lg:` breakpoint (1024px) — the exact same threshold
 * NavRail.tsx's own drawer/rail split and BottomNav.tsx's mobile-only
 * render already use, so "desktop" means the same thing everywhere in this
 * shell. Shortcuts are meaningless on a phone with no keyboard, hence the
 * gate. */
const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * The once-per-user "these shortcuts exist" toast. AppShell already has
 * real, useful global shortcuts (⌘K search, Alt+S/P/R/Y, Shift+? for the
 * full sheet — see that file's own header) but nothing told a new user they
 * exist before this. Shown once, on the first dashboard load a signed-in
 * desktop user makes, then never again for that user (until their
 * localStorage is cleared) — never as a blocking modal, only as a small,
 * dismissible banner in the corner.
 *
 * WHY THIS GATES ON activePath === `/${companyId}` RATHER THAN A "have I
 * shown this yet THIS SESSION" flag: AppShell mounts once per company and
 * stays mounted across every in-company navigation (see that file's own
 * header), so a plain "mount effect" would fire on whichever screen a
 * bookmark or a deep link happened to land the user on first — which is
 * often a specific report, not the dashboard the task actually asks for.
 * Deriving the gate from the `activePath` prop that already changes on every
 * navigation means this re-evaluates correctly if the user's FIRST stop in a
 * session is not the dashboard, and lands the very moment they do reach it.
 *
 * WHY "SEEN" IS WRITTEN THE MOMENT THIS DECIDES TO SHOW, NOT ONLY ON DISMISS:
 * a user who never touches the × (they just start using the app) must not
 * see the same toast again on their next visit — writing the flag as part of
 * the same check that flips `show` to true makes "shown" and "seen"
 * atomically the same event, which is simpler to reason about than two
 * separate write sites that both have to agree.
 *
 * userId is fetched client-side (this component's own `createClient()` call,
 * the same `@/lib/supabase/client` browser client CommandBar.tsx already
 * uses for its own RPC calls) rather than threaded down as a prop — the only
 * caller, AppShell.tsx, is mounted from app/(app)/[companyId]/layout.tsx,
 * which today selects the company row only, not the signed-in user; adding a
 * second query there for a one-time hint is a worse trade than this
 * component quietly fetching the one field it needs for itself. No new
 * table: a per-user "seen this tip" flag is exactly the kind of state
 * localStorage is for, and this codebase already treats "properties of this
 * browser, not of the account" the same way for a bigger, weirder case (see
 * lib/scan/deviceMemory.ts's own header) — a one-time hint is a far smaller
 * ask than that.
 */
export function ShortcutHint({
  companyId,
  activePath,
}: {
  companyId: string;
  activePath: string;
}) {
  const isDashboard = activePath === `/${companyId}`;
  const isDesktop = useSyncExternalStore(
    subscribeIsDesktop,
    getIsDesktopSnapshot,
    getIsDesktopServerSnapshot
  );
  const isMac = useSyncExternalStore(subscribeToNothing, getIsMacSnapshot, getIsMacServerSnapshot);

  const [show, setShow] = useState(false);

  // No setState call in this effect's own body — only inside the nested
  // .then() below, which runs later, in response to the auth call actually
  // completing. Same shape CommandBar.tsx's own debounced RPC effect uses,
  // and for the same reason: this project's react-hooks/set-state-in-effect
  // rule refuses a setState call that runs synchronously on every dependency
  // change outright.
  //
  // The `cancelled` guard is not decorative: Next's App Router runs React
  // Strict Mode by default in dev (no override in next.config.ts), which
  // mounts every component twice — mount, cleanup, remount — to surface
  // exactly this class of bug. Without this guard, the FIRST (discarded)
  // mount's getUser() call still resolves, still writes the "seen" flag to
  // localStorage, and is then torn down before it can paint — so the SECOND
  // (surviving) mount's own check reads "already seen" and never shows the
  // toast at all. Verified live: without this guard the flag was written on
  // every fresh load but the toast never once rendered. With it, the
  // discarded mount's callback becomes a no-op (its own `cancelled` closure
  // flips true on cleanup before its network round-trip returns), so only
  // the mount that actually stays alive gets to decide and write.
  useEffect(() => {
    if (!isDashboard || !isDesktop) return;
    let cancelled = false;
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (cancelled) return;
        const userId = data.user?.id;
        // No signed-in id to key a "seen" flag by — degrade to "never show"
        // rather than fall back to some shared, cross-account key.
        if (!userId) return;
        const key = `${STORAGE_PREFIX}${userId}`;
        let alreadySeen = true;
        try {
          alreadySeen = window.localStorage.getItem(key) === "1";
        } catch {
          // Private window / storage blocked. Same call this file makes
          // below on dismiss: best-effort only, never a thrown error.
        }
        if (alreadySeen) return;
        try {
          window.localStorage.setItem(key, "1");
        } catch {
          // Storage full or blocked — this session still gets to show the
          // hint once, it just won't be remembered next time. Milder than
          // failing the render over a courtesy write.
        }
        setShow(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isDashboard, isDesktop]);

  if (!show) return null;

  return (
    <div
      role="status"
      className="fixed bottom-6 left-6 z-40 flex max-w-sm items-start gap-3 rounded-card border border-border bg-surface px-4 py-3 text-sm shadow-card print:hidden"
    >
      <p className="text-ink-soft">
        Press{" "}
        <kbd className="rounded border border-border-strong bg-surface-2 px-1 py-px font-mono text-[11px] text-ink">
          {isMac ? "⌘" : "Ctrl"}K
        </kbd>{" "}
        to search anything ·{" "}
        <kbd className="rounded border border-border-strong bg-surface-2 px-1 py-px font-mono text-[11px] text-ink">
          Shift+?
        </kbd>{" "}
        for all shortcuts
      </p>
      <button
        type="button"
        onClick={() => setShow(false)}
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-0.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <X size={15} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// isDesktop — a real external store (unlike navigator.userAgent below, a
// browser's width genuinely changes under a mounted tab), so this subscribes
// to matchMedia's own `change` event rather than reading once and never
// again. MediaQueryList.addEventListener("change", …) has been supported in
// every browser this app targets since well before Next.js 16's own stated
// minimums (Chrome/Edge 111+, Firefox 111+, Safari 16.4+ — see that guide's
// own Node.js/browser support table), so no older `addListener` fallback is
// needed.
// ---------------------------------------------------------------------------

function subscribeIsDesktop(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getIsDesktopSnapshot(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

function getIsDesktopServerSnapshot(): boolean {
  // Unknown on the server. Rather than guess, this hint simply waits for
  // hydration to read the real viewport — the same "not known yet" default
  // lib/scan/deviceMemory.ts's own SCAN_PLACE_SERVER_SNAPSHOT uses, and for
  // the same reason: a wrong guess here would flash the toast at a mobile
  // visitor for one frame, which no default at all cannot do.
  return false;
}

// ---------------------------------------------------------------------------
// isMac — deliberately duplicated in miniature from ActionRail.tsx's own
// (unexported) isMac plumbing rather than imported, the same call
// ShortcutSheet.tsx already made and documented in its own header: this is
// the only other file that needs it, ActionRail does not export it, and a
// three-line snapshot pair is cheaper than a new shared module for it.
// ---------------------------------------------------------------------------

function subscribeToNothing() {
  return () => {};
}

function getIsMacSnapshot(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function getIsMacServerSnapshot(): boolean {
  return false;
}
