"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { Badge } from "@/components/ui/Badge";
import { navEntries, type NavEntry } from "@/lib/nav/registry";

/**
 * The command bar: Ctrl+K/Cmd+K over all 120-odd nav destinations PLUS the
 * company's own ledgers, items, vouchers and employees, in one box. Today
 * NavRail is the only way to find any of those 120 links, and there is no
 * way at all to jump straight to "the Acme Traders ledger" or "voucher
 * INV-2044" without walking through a report screen first. This closes both
 * gaps at once.
 *
 * INTEGRATION SURFACE for whoever wires this into AppShell.tsx:
 *
 *   <CommandBar companyId={companyId} />
 *
 * dropped once into AppShell is the whole integration — it is self-contained
 * (owns its own open/closed state, listens for Ctrl+K/Cmd+K globally the
 * moment it mounts) and needs nothing else threaded through props. A SEPARATE
 * trigger elsewhere in the tree — a "Search" row in NavRail's bottom list, a
 * magnifying-glass button in the mobile header bar — opens the same instance
 * via the exported hook, with no prop drilling and no context provider:
 *
 *   const { open } = useCommandBar();
 *   <button onClick={open}>Search…</button>
 *
 * (`useCommandBar()` is safe to call even before any <CommandBar/> has
 * mounted — the returned `open()` is then a harmless no-op, same as a
 * keyboard shortcut fired one tick too early would be.)
 *
 * DESIGN NOTES:
 *
 *   - components/ui/Modal.tsx was the obvious first reach, and its overlay/
 *     escape/outside-click behaviour is mirrored here on purpose for visual
 *     and behavioural consistency with the rest of the app. But Modal's
 *     panel is built around a fixed `<h2>` title + description header,
 *     which is the wrong shape for a search-first palette — the input IS
 *     the header here, with no room left for a second, redundant title
 *     above it. Rather than fight that layout with overrides, this file
 *     builds its own panel that borrows Modal's exact visual language
 *     (border/radius/shadow tokens, the same `bg-ink/40` + blur overlay,
 *     the same `py-10` vertical placement) without importing the component.
 *
 *   - Every result row is a plain `<div role="option">`, not a `<button>`
 *     or `<a>`. This is the ARIA 1.2 "editable combobox with list
 *     autocomplete" pattern: DOM focus stays on the `<input>` the entire
 *     time (role="combobox"), the currently-highlighted row is communicated
 *     via `aria-activedescendant` rather than by moving real focus, and
 *     each row is wrapped by a `role="group"` labelled by its own section
 *     heading so a screen reader still gets "Screens" / "Recent" / "Records"
 *     context without a second, competing focusable element per row.
 *
 *   - The registry filter runs synchronously in a `useMemo` keyed only on
 *     the query text — it never touches the network, so it renders on every
 *     keystroke with zero latency exactly as the task requires. The RPC
 *     search is a separate, independently-debounced side channel that
 *     merges its results in underneath once (if) they arrive; a slow or
 *     failed RPC call degrades to "the screens list still works", never to
 *     a blocked or empty box.
 *
 *   - No effect in this file ever calls a state setter directly in its own
 *     top-level body — every one either only touches the DOM (focus,
 *     scrollIntoView) or defines a nested callback (an event listener, a
 *     debounce timeout, a `.then()`) that calls the setter later, in
 *     response to something actually happening. That split is not
 *     stylistic: this project's react-hooks lint (see
 *     components/scan/RecentSendsScreen.tsx's own comment on the same
 *     constraint) flags a setState call that runs synchronously every time
 *     an effect's dependencies change, because it causes an extra,
 *     avoidable render. "Open" and "close" resets live in `openBar`, an
 *     ordinary event-triggered callback, not in an effect that reacts to
 *     `open` becoming true.
 */

// ---------------------------------------------------------------------------
// Cross-component open trigger.
//
// A plain module-level Set instead of a Context provider: this file must
// stay a leaf component nobody else has to wrap their tree in, and the only
// thing anything outside CommandBar itself ever needs to do is "open it" —
// there is no shared state to read back out. Each mounted <CommandBar/>
// registers one listener while it lives; useCommandBar()'s `open()` just
// rings every registered listener (in practice exactly one, since AppShell
// mounts a single instance).
// ---------------------------------------------------------------------------

type OpenListener = () => void;
const openListeners = new Set<OpenListener>();

export function useCommandBar(): { open: () => void } {
  const open = useCallback(() => {
    openListeners.forEach((listener) => listener());
  }, []);
  return { open };
}

// ---------------------------------------------------------------------------
// Result shape shared by both sources (registry entries and RPC rows) so the
// rendering and keyboard-navigation code below never has to branch on where
// a row came from.
// ---------------------------------------------------------------------------

type PaletteKind = "page" | "ledger" | "item" | "voucher" | "employee";

type PaletteItem = {
  /** Stable across renders — used as the React key and as half of the
   * localStorage recents dedup key. */
  id: string;
  href: string;
  label: string;
  sublabel: string | null;
  kind: PaletteKind;
};

const KIND_LABEL: Record<PaletteKind, string> = {
  page: "Screen",
  ledger: "Ledger",
  item: "Item",
  voucher: "Voucher",
  employee: "Employee",
};

/** One shared empty array rather than a fresh `[]` literal at each call
 * site — `rpcItems` below is recomputed on every render (it is a plain
 * `const`, not a `useMemo`, since it is only a cheap comparison), and a new
 * array identity every render would make `sections`' own `useMemo` below it
 * recompute every render too, defeating the memoization for no reason. */
const EMPTY_ITEMS: PaletteItem[] = [];

/** The shape public.search_company_entities returns — see F2's contract.
 * Not in types/database.types.ts (the RPC is newer than the last generation
 * run), so this is typed by hand the same way callRpc's own docstring
 * describes doing for get_company_team et al. */
type SearchRow = {
  kind: PaletteKind;
  id: string;
  label: string;
  sublabel: string | null;
  href: string;
  rank: number;
};

// ---------------------------------------------------------------------------
// Local registry search — synchronous, no network, re-run on every keystroke.
// ---------------------------------------------------------------------------

const RESULT_LIMIT = 8;

/** 3 = label starts with the query, 2 = label contains it anywhere, 1 = only
 * a keyword (the Tally-equivalent / synonym list registry.ts curates for
 * exactly this) matched, -1 = no match at all. Deliberately coarser than
 * F2's four-tier scheme server-side — with the whole list in memory there is
 * no ranking budget to spend, just "put the closest label matches first". */
function scoreEntry(entry: NavEntry, query: string): number {
  const label = entry.label.toLowerCase();
  if (label.startsWith(query)) return 3;
  if (label.includes(query)) return 2;
  if (entry.keywords.some((k) => k.toLowerCase().includes(query))) return 1;
  return -1;
}

function searchRegistry(trimmedQuery: string, companyId: string): PaletteItem[] {
  if (trimmedQuery === "") return EMPTY_ITEMS;
  const q = trimmedQuery.toLowerCase();

  return navEntries
    .map((entry) => ({ entry, score: scoreEntry(entry, q) }))
    .filter((x) => x.score > -1)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.label.length - b.entry.label.length ||
        a.entry.label.localeCompare(b.entry.label)
    )
    .slice(0, RESULT_LIMIT)
    .map(({ entry }) => ({
      id: `page:${entry.href}`,
      // ":companyId" is the token registry.ts documents every company-scoped
      // href carrying, and — per that file's own header — the token itself
      // carries no leading slash, so the replacement must supply one
      // (`/${companyId}`, not the bare id) or the result is a same-origin
      // RELATIVE path. That bug shipped here initially: router.push() on a
      // relative string resolves against the CURRENT pathname per the
      // standard URL rules, which happens to land correctly from a
      // one-segment page (/:companyId) but silently produces a duplicated,
      // broken path from any deeper page (e.g. from a report at
      // /:companyId/reports/trial-balance, picking a different report
      // resolved to
      // /:companyId/reports/:companyId/reports/<other> instead of
      // /:companyId/reports/<other>) — confirmed live via the browser's own
      // `new URL(relative, base)` resolution before this fix. NavRail.tsx and
      // app/.../w/[workspace]/page.tsx already resolve the same token
      // correctly this way; this file just hadn't matched them yet. The two
      // routes that AREN'T company-scoped (/scan, /security) contain no such
      // token, so replace() is still a no-op for them.
      href: entry.href.replace(":companyId", `/${companyId}`),
      label: entry.label,
      sublabel: entry.group ?? null,
      kind: "page" as const,
    }));
}

// ---------------------------------------------------------------------------
// Recents — localStorage, keyed per company, capped at 8, newest first.
// Every read and write is wrapped in try/catch: private-browsing Safari and
// several embedded-webview contexts throw on ANY localStorage access, not
// just on quota, and recents are a nicety the command bar must survive
// losing rather than a reason to break the whole component.
// ---------------------------------------------------------------------------

const RECENTS_LIMIT = 8;

function recentsKey(companyId: string): string {
  return `lekha.commandBar.recents.${companyId}`;
}

function loadRecents(companyId: string): PaletteItem[] {
  try {
    const raw = window.localStorage.getItem(recentsKey(companyId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive per-row shape check: a value this component (or a future
    // version of it) wrote once and the schema of which later changed must
    // not crash today's reader — it is just treated as "not a valid row".
    return parsed
      .filter(
        (r): r is PaletteItem =>
          !!r &&
          typeof r === "object" &&
          typeof (r as PaletteItem).id === "string" &&
          typeof (r as PaletteItem).href === "string" &&
          typeof (r as PaletteItem).label === "string" &&
          typeof (r as PaletteItem).kind === "string"
      )
      .slice(0, RECENTS_LIMIT);
  } catch {
    return [];
  }
}

function saveRecent(companyId: string, item: PaletteItem): void {
  try {
    const withoutDuplicate = loadRecents(companyId).filter((r) => r.href !== item.href);
    const next = [item, ...withoutDuplicate].slice(0, RECENTS_LIMIT);
    window.localStorage.setItem(recentsKey(companyId), JSON.stringify(next));
  } catch {
    // Storage blocked or full — losing recents silently beats breaking
    // navigation, which is the one thing this component must never do.
  }
}

// ---------------------------------------------------------------------------
// The component.
// ---------------------------------------------------------------------------

export function CommandBar({ companyId }: { companyId: string }) {
  const router = useRouter();
  const listboxId = useId();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recents, setRecents] = useState<PaletteItem[]>([]);
  // The RPC's own result travels WITH the query it was fetched for, instead
  // of living in its own "current items" state that something would then
  // have to remember to actively clear when the query changes again. That
  // makes "is this result stale" a plain comparison made at render time (see
  // rpcItems/rpcLoading below) rather than a second, separately-synchronised
  // piece of state — and it is what lets the RPC effect further down never
  // need to call a setter until a response actually arrives.
  const [rpcResult, setRpcResult] = useState<{ forQuery: string; items: PaletteItem[] } | null>(
    null
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const requestSeq = useRef(0);

  const trimmedQuery = query.trim();

  // Everything "opening" resets, in one place, triggered directly by the
  // thing that opens the palette (a click, a keypress) rather than by an
  // effect reacting to `open` becoming true — see the file header for why
  // that distinction matters here.
  const openBar = useCallback(() => {
    setOpen(true);
    setQuery("");
    setActiveIndex(0);
    setRecents(loadRecents(companyId));
  }, [companyId]);

  // Register with useCommandBar()'s open trigger for as long as this
  // instance is mounted — see the module-level comment above. Re-registers
  // whenever `openBar` itself changes (i.e. when companyId changes) so a
  // trigger fired after switching companies still loads THAT company's
  // recents, not a closure still pointing at the old one.
  useEffect(() => {
    const listener = () => openBar();
    openListeners.add(listener);
    return () => {
      openListeners.delete(listener);
    };
  }, [openBar]);

  // Ctrl+K / Cmd+K opens from ANYWHERE on the page, regardless of what
  // currently has focus — this listener is registered unconditionally, not
  // only while the palette is already open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openBar();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openBar]);

  // Escape closes WITHOUT navigating — same shape as Modal.tsx's own effect,
  // scoped to only listen while open so it never intercepts Escape elsewhere
  // in the app.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // Hand focus to the input once it actually exists in the DOM — it does
  // not yet during the render that flips `open` to true, only after that
  // render commits, which is exactly what an effect is for. No setState
  // here at all, so this one is unconditionally clean regardless of the
  // constraint discussed in the file header.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  // The RPC side channel: debounced 200ms, guarded against out-of-order
  // responses with a monotonic request counter (a slow response for "l"
  // must never clobber a faster response that already landed for "led").
  // Note there is no setState call anywhere in this effect's own body — only
  // inside the nested setTimeout/.then() callbacks below, which run later,
  // in response to the timer or the network call actually completing.
  useEffect(() => {
    if (!open || trimmedQuery === "") return;

    const seq = ++requestSeq.current;
    const forQuery = trimmedQuery;
    const timer = window.setTimeout(() => {
      // Created fresh here rather than hoisted to component scope — the
      // same lightweight-wrapper pattern every other client component in
      // this codebase uses (see e.g. RecurringVoucherManager.tsx), so this
      // effect needs no separately-memoized client in its dependency array.
      callRpc<{ p_company_id: string; p_query: string; p_limit: number }, SearchRow[]>(
        createClient(),
        "search_company_entities",
        { p_company_id: companyId, p_query: forQuery, p_limit: RESULT_LIMIT }
      ).then(({ data, error }) => {
        if (seq !== requestSeq.current) return; // superseded by a newer keystroke
        setRpcResult({
          forQuery,
          items:
            error || !data
              ? EMPTY_ITEMS
              : data.map((row) => ({
                  id: `${row.kind}:${row.id}`,
                  href: row.href,
                  label: row.label,
                  sublabel: row.sublabel,
                  kind: row.kind,
                })),
        });
      });
    }, 200);

    return () => window.clearTimeout(timer);
  }, [open, trimmedQuery, companyId]);

  // A result only counts as "the answer to what's in the box right now" if
  // it was fetched FOR the current query text — anything else (a slower
  // response for a query the user has since changed or cleared) is treated
  // as not having arrived yet, which is what keeps a stale result from an
  // earlier keystroke from ever flashing up under a newer one.
  const rpcItems = rpcResult && rpcResult.forQuery === trimmedQuery ? rpcResult.items : EMPTY_ITEMS;
  const rpcLoading = trimmedQuery !== "" && (!rpcResult || rpcResult.forQuery !== trimmedQuery);

  const localItems = useMemo(
    () => searchRegistry(trimmedQuery, companyId),
    [trimmedQuery, companyId]
  );

  // Sections to render, each carrying the flat keyboard-navigation index its
  // first row starts at, so arrow keys/Enter/aria-activedescendant all work
  // off one continuous 0..N-1 index regardless of which sections are showing.
  const sections = useMemo(() => {
    const raw: { key: string; heading: string; items: PaletteItem[] }[] = [];

    if (trimmedQuery === "") {
      if (recents.length > 0) raw.push({ key: "recent", heading: "Recent", items: recents });
    } else {
      if (localItems.length > 0) raw.push({ key: "pages", heading: "Screens", items: localItems });
      if (rpcItems.length > 0) raw.push({ key: "records", heading: "Records", items: rpcItems });
    }

    let cursor = 0;
    return raw.map((section) => {
      const start = cursor;
      cursor += section.items.length;
      return { ...section, start };
    });
  }, [trimmedQuery, recents, localItems, rpcItems]);

  const items = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const effectiveActiveIndex = items.length === 0 ? -1 : Math.min(activeIndex, items.length - 1);

  // Keep the highlighted row visible as arrow keys move past the edge of
  // the scrollable list. Also DOM-only, no setState.
  useEffect(() => {
    if (effectiveActiveIndex < 0) return;
    itemRefs.current[effectiveActiveIndex]?.scrollIntoView({ block: "nearest" });
  }, [effectiveActiveIndex]);

  const selectItem = useCallback(
    (item: PaletteItem) => {
      saveRecent(companyId, item);
      setOpen(false);
      router.push(item.href);
    },
    [companyId, router]
  );

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length === 0) return;
      setActiveIndex(Math.min(effectiveActiveIndex + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      setActiveIndex(Math.max(effectiveActiveIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (effectiveActiveIndex >= 0) selectItem(items[effectiveActiveIndex]);
    }
    // Escape is deliberately not handled here — it bubbles to the
    // document-level listener above, which is the single source of truth
    // for "close without navigating".
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 px-4 py-10 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command bar"
        className="flex w-full max-w-xl flex-col rounded-[14px] border border-border bg-surface shadow-card"
      >
        <div className="flex items-center gap-2 rounded-t-[14px] border-b border-border px-4 py-3 focus-within:ring-2 focus-within:ring-accent/30">
          <Search size={16} className="shrink-0 text-ink-faint" aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-haspopup="listbox"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={
              effectiveActiveIndex >= 0 ? `${listboxId}-opt-${effectiveActiveIndex}` : undefined
            }
            aria-label="Search screens, ledgers, items, vouchers and employees"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Search or jump to…"
            autoComplete="off"
            spellCheck={false}
            className="w-full border-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        </div>

        <div
          id={listboxId}
          role="listbox"
          aria-label="Command bar results"
          className="max-h-96 overflow-y-auto overscroll-contain p-2"
        >
          {sections.length === 0 ? (
            <p className="px-3 py-10 text-center text-sm text-ink-faint">
              {trimmedQuery === ""
                ? "Type to search screens, ledgers, items, vouchers and employees."
                : "No matches."}
            </p>
          ) : (
            sections.map((section) => (
              <div key={section.key} role="group" aria-labelledby={`${listboxId}-h-${section.key}`}>
                <p
                  id={`${listboxId}-h-${section.key}`}
                  className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-ink-faint first:pt-1"
                >
                  {section.heading}
                  {section.key === "records" && rpcLoading ? " · searching…" : ""}
                </p>
                {section.items.map((item, i) => {
                  const index = section.start + i;
                  const active = index === effectiveActiveIndex;
                  return (
                    <div
                      key={item.id}
                      id={`${listboxId}-opt-${index}`}
                      role="option"
                      aria-selected={active}
                      ref={(el) => {
                        itemRefs.current[index] = el;
                      }}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => selectItem(item)}
                      aria-label={
                        item.sublabel
                          ? `${item.label}, ${item.sublabel}, ${KIND_LABEL[item.kind]}`
                          : `${item.label}, ${KIND_LABEL[item.kind]}`
                      }
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2",
                        active ? "bg-accent-soft" : "hover:bg-surface-2"
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">{item.label}</span>
                        {item.sublabel && (
                          <span className="block truncate text-xs text-ink-faint">{item.sublabel}</span>
                        )}
                      </span>
                      <Badge tone="neutral" className="shrink-0">
                        {KIND_LABEL[item.kind]}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 rounded-b-[14px] border-t border-border px-4 py-2 text-[11px] text-ink-faint">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-strong bg-surface-2 px-1 py-px font-mono text-[10px] leading-4">
              ↑
            </kbd>
            <kbd className="rounded border border-border-strong bg-surface-2 px-1 py-px font-mono text-[10px] leading-4">
              ↓
            </kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-strong bg-surface-2 px-1 py-px font-mono text-[10px] leading-4">
              Enter
            </kbd>
            open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-strong bg-surface-2 px-1 py-px font-mono text-[10px] leading-4">
              Esc
            </kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
