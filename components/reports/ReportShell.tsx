"use client";

import { useRef, type ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { ExportActions } from "@/components/ui/ExportActions";
import { TableContainer, th, td, num } from "@/components/ui/Table";

/**
 * Shared frame for every report: heading, period, an optional status chip, a
 * table that scrolls inside its own container so the page body never scrolls
 * sideways, and Print/CSV/JPG export — added once here rather than per
 * report, so the thirteenth report gets it free.
 *
 * Print rules live here rather than per report — a statement should leave as
 * a document, not a screenshot, and doing that once means every report gets
 * it free.
 */
export function ReportShell({
  title,
  period,
  status,
  children,
}: {
  title: string;
  period: string;
  status?: { label: string; tone: "ok" | "warn" | "bad" };
  children: ReactNode;
}) {
  const captureRef = useRef<HTMLDivElement>(null);
  const filename = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 print:max-w-none print:px-0 print:py-0" ref={captureRef}>
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
          <ExportActions captureRef={captureRef} filename={filename || "report"} />
        </div>
      </header>
      <TableContainer>{children}</TableContainer>
    </main>
  );
}

// Re-exported so every existing `import { th, td, num } from
// "@/components/reports/ReportShell"` keeps working unchanged — the shared
// definitions now live in components/ui/Table.tsx alongside the 5 Manager
// tables that use the same look.
export { th, td, num };
