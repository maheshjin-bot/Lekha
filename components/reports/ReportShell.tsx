"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Download, Printer, Settings } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { ExportActions } from "@/components/ui/ExportActions";
import { ActionRail, type ActionRailItem } from "@/components/nav/ActionRail";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { downloadCsv, tableToCsv } from "@/lib/utils/table-to-csv";
import { cn } from "@/lib/utils/cn";
import { useScreenConfig } from "@/lib/config/useScreenConfig";

/**
 * How wide the report is allowed to get.
 *
 * `document` is the old, only behaviour: 1024px, the width a page of prose or
 * a computation statement wants — a Form 16 or a notes-to-accounts reads like
 * a document and gets unreadable when its lines run 1600px wide.
 *
 * `data` is for the tables that are the actual point of an accounting app. A
 * trial balance or a 26-column GSTR-1 has real columns to show; boxing it at
 * 1024px made it scroll sideways inside its own container while ~650px of a
 * 1920px monitor sat empty. There is deliberately no cap here: the container
 * already scrolls when the table is wider than the screen, so the only thing
 * a cap can do on a big monitor is hide columns that would have fitted.
 */
export type ReportWidth = "document" | "data";

const WIDTH: Record<ReportWidth, string> = {
  document: "mx-auto max-w-5xl",
  data: "w-full",
};

/**
 * The three report-level display preferences every report can eventually
 * read back via `useScreenConfig` under the same screen_key this shell
 * derives (see `reportConfigScope` below). All three default ON, and ON is
 * defined as "whatever a report already renders today" for that axis —
 * every row shown, exact (unrounded) figures, opening/closing columns
 * visible — so a company/user with no screen_config row yet (the universal
 * case until someone opens the gear) sees byte-identical output to before
 * this file changed. Nothing in this shell currently filters/rounds a
 * report's own `children` — that is per-report work for whichever report
 * chooses to opt in later, reading the same config back with the same
 * screen_key convention below. This file only owns persisting the
 * preference and offering the toggle UI.
 */
export type ReportDisplayConfig = {
  showZeroBalance: boolean;
  showExactFigures: boolean;
  showOpeningClosing: boolean;
};

export const DEFAULT_REPORT_DISPLAY_CONFIG: ReportDisplayConfig = {
  showZeroBalance: true,
  showExactFigures: true,
  showOpeningClosing: true,
};

function resolveReportDisplayConfig(config: Record<string, unknown>): ReportDisplayConfig {
  return {
    showZeroBalance: (config.showZeroBalance as boolean | undefined) ?? DEFAULT_REPORT_DISPLAY_CONFIG.showZeroBalance,
    showExactFigures: (config.showExactFigures as boolean | undefined) ?? DEFAULT_REPORT_DISPLAY_CONFIG.showExactFigures,
    showOpeningClosing:
      (config.showOpeningClosing as boolean | undefined) ?? DEFAULT_REPORT_DISPLAY_CONFIG.showOpeningClosing,
  };
}

/**
 * Every report route is `/<companyId>/<...rest>` (the `(app)` segment above
 * it is a route group, invisible in the URL) — `[companyId]` is always the
 * first path segment, so this shell can derive both the RPC's p_company_id
 * and a stable per-report screen_key from the browser URL alone, with zero
 * change to any of the ~63 report page.tsx files that render it. The
 * screen_key is just the remaining segments joined with "-" (e.g.
 * "reports/trial-balance" -> "reports-trial-balance"), which already
 * satisfies screen_config's own `^[a-z0-9][a-z0-9_-]{0,63}$` check since
 * every Next.js route segment in this app is already lowercase kebab-case.
 * Returns nulls when the URL doesn't have the shape this shell expects
 * (nothing renders the gear then, rather than guessing).
 */
function reportConfigScope(pathname: string | null): { companyId: string | null; screenKey: string | null } {
  if (!pathname) return { companyId: null, screenKey: null };
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return { companyId: null, screenKey: null };
  const [companyId, ...rest] = segments;
  const screenKey = rest.join("-").slice(0, 64);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(screenKey)) return { companyId, screenKey: null };
  return { companyId, screenKey };
}

/**
 * The gear affordance itself — a small anchored popover, same open/close
 * shape as ContextBar.tsx's own `Dropdown` (outside-click and Escape both
 * close it; re-implemented here rather than imported since that one is
 * scoped to ContextBar's own menu-item/label props, not a generic popover).
 *
 * Rendered only once a companyId/screenKey were derivable from the URL —
 * `useScreenConfig` is called unconditionally *within this component*, so
 * gating happens at the parent by mounting/not-mounting this component
 * entirely, never by handing the hook a placeholder company id.
 */
function ReportDisplayGear({ companyId, screenKey }: { companyId: string; screenKey: string }) {
  const { config, setConfig } = useScreenConfig(companyId, screenKey);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const resolved = resolveReportDisplayConfig(config);

  function toggle(key: keyof ReportDisplayConfig) {
    // Reads `resolved` (this render's merged value), not `prev` inside the
    // updater, for the flip — the same reasoning as everywhere else in this
    // file avoids stale-closure math: there is no in-flight batched update
    // to a single checkbox that a second read of `prev` would need to
    // reconcile against, since each click is its own setConfig call.
    setConfig((prev) => ({ ...prev, [key]: !resolved[key] }));
  }

  return (
    <div ref={rootRef} className="relative shrink-0 print:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Report display settings"
        className="flex items-center justify-center rounded-lg border border-border-strong p-1.5 text-ink-soft transition-colors hover:bg-accent-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <Settings size={14} />
        <span className="sr-only">Report display settings</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1.5 w-64 rounded-[14px] border border-border bg-surface p-3 shadow-card"
        >
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Display</p>
          <div className="flex flex-col gap-2.5">
            <ToggleRow
              label="Zero-balance rows"
              checked={resolved.showZeroBalance}
              onChange={() => toggle("showZeroBalance")}
            />
            <ToggleRow
              label="Exact figures (not rounded)"
              checked={resolved.showExactFigures}
              onChange={() => toggle("showExactFigures")}
            />
            <ToggleRow
              label="Opening / closing columns"
              checked={resolved.showOpeningClosing}
              onChange={() => toggle("showOpeningClosing")}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-ink">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 shrink-0 rounded border-border-strong accent-accent"
      />
    </label>
  );
}

/**
 * Shared frame for every report: heading, period, an optional status chip, a
 * table that scrolls inside its own container so the page body never scrolls
 * sideways, and Print/CSV/JPG export — added once here rather than per
 * report, so the thirteenth report gets it free.
 *
 * Print rules live here rather than per report — a statement should leave as
 * a document, not a screenshot, and doing that once means every report gets
 * it free.
 *
 * `width` defaults to `data` so all ~58 report pages get their real width
 * back without touching 58 files; the handful that read as documents rather
 * than tables opt back in with `width="document"`.
 */
export function ReportShell({
  title,
  period,
  status,
  width = "data",
  actions,
  children,
}: {
  title: string;
  period: string;
  status?: { label: string; tone: "ok" | "warn" | "bad" };
  width?: ReportWidth;
  /**
   * Pass this — even as `[]` — to show the right-hand action rail, which
   * prepends Print and Download CSV to whatever you give it. Omitted means no
   * rail at all, which is why adding it here changed none of the existing
   * report pages.
   *
   * These pages are Server Components, so an entry may carry `href` but not
   * `onClick` (a function cannot cross the server/client boundary). The two
   * handler-backed rows below are built here, inside the client component,
   * for exactly that reason.
   */
  actions?: ActionRailItem[];
  children: ReactNode;
}) {
  const captureRef = useRef<HTMLDivElement>(null);
  const filename = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  // Derived from the URL, not a prop — see reportConfigScope's own header
  // for why this needed no change to any of the ~63 report page.tsx files.
  const pathname = usePathname();
  const { companyId, screenKey } = reportConfigScope(pathname);

  /**
   * The same two lines ExportActions runs, rather than reaching into it: the
   * rail needs its own click handler, and both paths call the same
   * tableToCsv/downloadCsv pair against the same captureRef, so the rail's
   * CSV and the header bar's CSV cannot drift apart.
   */
  function exportCsv() {
    const table = captureRef.current?.querySelector("table");
    if (!table) return;
    downloadCsv(tableToCsv(table), filename || "report");
  }

  // Print gets a shortcut chip because Ctrl/⌘+P genuinely prints this page
  // today — the browser binds it, we don't. CSV deliberately shows no
  // shortcut: nothing binds one yet, and a chip advertising a key that does
  // nothing teaches people the rail lies.
  const railActions: ActionRailItem[] | null = actions
    ? [
        { label: "Print", shortcut: "mod+P", icon: <Printer size={14} />, onClick: () => window.print() },
        { label: "Download CSV", icon: <Download size={14} />, onClick: exportCsv },
        ...actions,
      ]
    : null;

  return (
    <main
      className={cn("px-6 py-10 print:max-w-none print:px-0 print:py-0", WIDTH[width])}
      ref={captureRef}
    >
      {/* The row exists whether or not there is a rail: with one child it
          lays out identically to the bare content it replaced, so pages that
          pass no actions render exactly the markup they always did. */}
      <div className="flex items-start gap-8">
        <div className="min-w-0 flex-1">
          <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">{title}</h1>
              <p className="mt-1 text-sm text-ink-soft">{period}</p>
            </div>
            <div className="flex items-center gap-3">
              {status && (
                <Badge tone={status.tone === "ok" ? "ok" : status.tone === "warn" ? "warn" : "bad"} className="print:hidden">
                  {status.label}
                </Badge>
              )}
              {/* Kept even when the rail duplicates Print/CSV: it is where
                  every user of these 58 reports already looks, and JPG lives
                  only here. Retire it once the rail has proved itself. */}
              <ExportActions captureRef={captureRef} filename={filename || "report"} />
              {/* companyId/screenKey only fail to resolve for a URL shape
                  this shell doesn't recognise (see reportConfigScope) — no
                  gear renders then, rather than guessing a scope. */}
              {companyId && screenKey && <ReportDisplayGear companyId={companyId} screenKey={screenKey} />}
            </div>
          </header>
          <TableContainer>{children}</TableContainer>
        </div>
        {/*
          eslint-disable-next-line react-hooks/refs -- railActions only ever
          boxes exportCsv/window.print as onClick handlers. Both read
          captureRef.current when the user actually clicks, never during this
          render; the compiler cannot see that once the handler is nested
          inside the `actions` array/prop rather than written as a literal
          onClick={...} JSX attribute, and flags the reference regardless.
        */}
        {railActions && <ActionRail actions={railActions} />}
      </div>
    </main>
  );
}

// Re-exported so every existing `import { th, td, num } from
// "@/components/reports/ReportShell"` keeps working unchanged — the shared
// definitions now live in components/ui/Table.tsx alongside the 5 Manager
// tables that use the same look.
export { th, td, num };
