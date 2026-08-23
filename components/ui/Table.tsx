import { cn } from "@/lib/utils/cn";

/**
 * Shared table cell classes — hairline row dividers, never zebra striping
 * (stripes fight with colored debit/credit figures). Every numeric column is
 * right-aligned in the monospace font so decimal points form a straight edge
 * down the page. Originally lived only in ReportShell for the 9 report pages
 * that used it; generalized here so the 5 Manager tables share the same look.
 */
export const th =
  "px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-ink-faint border-b border-border";
export const td = "px-4 py-2 border-b border-border text-ink";
export const num = "px-4 py-2 border-b border-border text-right font-mono tabular-nums text-ink";

/** Applied to a <tr> to mark it selected/focused, per the design system's
 * inline-edit mock: soft accent wash plus an inset accent bar on the first cell. */
export const trSelected = "bg-accent-soft [&>td:first-child]:shadow-[inset_2px_0_0_var(--accent)]";

/** The bordered, scrollable card every table sits inside. */
export function TableContainer({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-[14px] border border-border bg-surface shadow-card print:rounded-none print:border-0 print:shadow-none",
        className
      )}
    >
      {children}
    </div>
  );
}
