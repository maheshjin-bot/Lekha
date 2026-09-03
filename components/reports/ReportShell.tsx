"use client";

import { useRef, type ReactNode } from "react";
import { Download, Printer } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { ExportActions } from "@/components/ui/ExportActions";
import { ActionRail, type ActionRailItem } from "@/components/nav/ActionRail";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { downloadCsv, tableToCsv } from "@/lib/utils/table-to-csv";
import { cn } from "@/lib/utils/cn";

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
