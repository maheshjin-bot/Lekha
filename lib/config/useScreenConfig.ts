"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * A screen's own config is an opaque JSON object — this module imposes no
 * shape on it. Each screen_key owns its own keys (a chosen density, a hidden
 * column list, a default filter, ...); see 1560's migration header for the
 * two-scope model (company default + per-user override) this merges.
 */
export type ScreenConfig = Record<string, unknown>;

const EMPTY_CONFIG: ScreenConfig = {};

// No autosave-write convention exists elsewhere in this codebase to match —
// CommandBar.tsx's own 200ms debounce is for a SEARCH (every keystroke
// re-queries), not a write. 500ms is picked here as long enough that a user
// dragging a column width or clicking through several density options in a
// row produces one write, not one per intermediate state, while still short
// enough that navigating away a moment later doesn't lose it outright (the
// unmount-flush effect below is the actual guarantee for that case, not this
// number).
const WRITE_DEBOUNCE_MS = 500;

/**
 * `useScreenConfig(companyId, screenKey)` — reads and writes one screen's
 * config through get_screen_config / set_screen_config (1560).
 *
 *     const { config, setConfig, loading } = useScreenConfig(companyId, "invoices-list");
 *     const density = (config.density as string | undefined) ?? "comfortable";
 *     setConfig((prev) => ({ ...prev, density: "compact" }));
 *
 * `setConfig` takes a full replacement OR a `(prev) => next` updater exactly
 * like useState's own setter — a partial preference change reads the current
 * merged config out of `prev` and spreads it, since set_screen_config (1560)
 * replaces the row's config wholesale rather than deep-merging server-side.
 * The local `config` state updates immediately (so a slider or a toggle
 * feels instant); the RPC write is debounced WRITE_DEBOUNCE_MS behind it and
 * flushed early if the hook unmounts with a write still pending, so
 * navigating away right after a change does not silently drop it.
 *
 * `forCompany`: when true, writes go to the company-wide default row instead
 * of the calling user's own override (set_screen_config raises a friendly
 * error server-side, per 1560, if the caller is not a company admin — this
 * hook does not pre-check that itself, so a non-admin handed forCompany:true
 * by mistake will see the write fail loudly in the console rather than
 * silently no-op). Defaults to false: a screen's own preference is the
 * common case this hook exists for; the settings screen that lets an admin
 * set a company-wide default is later, separate work per this migration's
 * own scope note.
 *
 * Deliberately NOT wired into any screen yet — see supabase/migrations/
 * 1560_screen_config.sql's header. This hook is the plumbing; which config
 * keys a given screen actually reads is chosen when that screen is adapted.
 */
export function useScreenConfig(
  companyId: string,
  screenKey: string,
  options?: { forCompany?: boolean }
): {
  config: ScreenConfig;
  setConfig: (next: ScreenConfig | ((prev: ScreenConfig) => ScreenConfig)) => void;
  loading: boolean;
} {
  const forCompany = options?.forCompany ?? false;

  const [config, setConfigState] = useState<ScreenConfig>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);

  // Mirrors `config` for setConfig's synchronous reads (applying a
  // functional updater, seeding the pending write) without needing `config`
  // in that callback's own dependency array. setConfig itself also writes
  // this ref directly the instant it resolves a new value (below), so the
  // effect here only has to catch the OTHER path config changes: the
  // initial fetch's setConfigState call. Kept in an effect rather than a
  // bare render-body assignment — this project's react-hooks/refs rule
  // refuses mutating a ref during render.
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Debounce bookkeeping for the write side. pendingWrite is the last value
  // setConfig produced that has not yet reached the RPC; writeTimer is the
  // in-flight setTimeout handle, if any. Both are refs, not state, because
  // touching them must never itself trigger a re-render — same reasoning as
  // CommandBar.tsx's own requestSeq counter.
  const writeTimer = useRef<number | null>(null);
  const pendingWrite = useRef<ScreenConfig | null>(null);

  // Guards the read-vs-local-write race: if the user calls setConfig before
  // the initial get_screen_config round trip resolves, the fetch landing
  // afterwards must not clobber what they just set. Reset at the start of
  // every fetch (a companyId/screenKey change starts a fresh race), flipped
  // once a local edit happens, consulted when the fetch resolves.
  const hasLocalEditRef = useRef(false);

  // Flip back to loading the instant companyId/screenKey changes, during
  // render rather than in the effect below — same reasoning as
  // EmployeeManager.tsx's revision-form seeding: a setState called
  // unconditionally at the top of an effect body is exactly what this
  // project's react-hooks/set-state-in-effect rule refuses, and doing it
  // here during render also means the "loading" state paints one render
  // sooner than an effect (which only runs after commit) ever could.
  const fetchKey = `${companyId}|${screenKey}`;
  const [loadingFor, setLoadingFor] = useState(fetchKey);
  if (fetchKey !== loadingFor) {
    setLoadingFor(fetchKey);
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    hasLocalEditRef.current = false;
    const supabase = createClient();
    supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- get_screen_config (1560) predates the generated types, same escape hatch as AllocationDrawer.tsx / AllocationManager.tsx.
      .rpc("get_screen_config" as any, { p_company_id: companyId, p_screen_key: screenKey })
      .then(({ data, error }) => {
        if (cancelled) return;
        setLoading(false);
        if (hasLocalEditRef.current) return; // see hasLocalEditRef above — a local edit already won
        setConfigState(!error && data ? (data as ScreenConfig) : EMPTY_CONFIG);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, screenKey]);

  // The one place that actually calls set_screen_config — reused by both the
  // debounce timer's callback and the unmount-flush effect below, so there
  // is exactly one write path to keep in sync rather than two.
  const flushPendingWrite = useCallback(() => {
    if (writeTimer.current !== null) {
      window.clearTimeout(writeTimer.current);
      writeTimer.current = null;
    }
    const toWrite = pendingWrite.current;
    pendingWrite.current = null;
    if (toWrite === null) return;
    const supabase = createClient();
    void supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- set_screen_config (1560) predates the generated types, same escape hatch as above.
      .rpc("set_screen_config" as any, {
        p_company_id: companyId,
        p_screen_key: screenKey,
        p_config: toWrite,
        p_for_company: forCompany,
      })
      .then(({ error }) => {
        if (error) {
          // No toast dependency lives in this hook — every client component
          // in this codebase reaches for sonner's toast directly for that,
          // and pulling it in here would make every future consumer of this
          // hook depend on a toast provider even for a screen preference
          // nobody needs a popup about. A caller that wants a visible
          // failure state (the admin-only company-default write, most
          // plausibly, since that is the one a non-admin can trigger a
          // rejection from) can watch for it another way; logged here so a
          // failed autosave is never silent.
          console.error(`useScreenConfig: set_screen_config(${screenKey}) failed: ${error.message}`);
        }
      });
  }, [companyId, screenKey, forCompany]);

  // Flush a pending write before switching context (company/screen/target
  // changes) or on final unmount, so a change made a moment before
  // navigating away still lands instead of being silently dropped by the
  // debounce timer never getting the chance to fire.
  useEffect(() => {
    return () => flushPendingWrite();
  }, [flushPendingWrite]);

  const setConfig = useCallback(
    (next: ScreenConfig | ((prev: ScreenConfig) => ScreenConfig)) => {
      hasLocalEditRef.current = true;
      const resolved = typeof next === "function" ? (next as (p: ScreenConfig) => ScreenConfig)(configRef.current) : next;
      configRef.current = resolved;
      setConfigState(resolved);
      pendingWrite.current = resolved;
      if (writeTimer.current !== null) window.clearTimeout(writeTimer.current);
      writeTimer.current = window.setTimeout(flushPendingWrite, WRITE_DEBOUNCE_MS);
    },
    [flushPendingWrite]
  );

  return { config, setConfig, loading };
}
