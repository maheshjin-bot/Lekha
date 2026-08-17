import type { ReactNode } from "react";

/**
 * Shared frame for every report: heading, period, an optional status chip, and
 * a table that scrolls inside its own container so the page body never scrolls
 * sideways.
 *
 * Print rules live here rather than per report — a statement should leave as a
 * document, not a screenshot, and doing that once means the fifteenth report
 * gets it free.
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
  const tone =
    status?.tone === "ok"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
      : status?.tone === "warn"
        ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
        : "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300";

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 print:max-w-none print:px-0 print:py-0">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{period}</p>
        </div>
        {status && (
          <span className={`rounded px-2.5 py-1 text-xs font-medium print:hidden ${tone}`}>
            {status.label}
          </span>
        )}
      </header>
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 print:rounded-none print:border-0">
        {children}
      </div>
    </main>
  );
}

export const th =
  "px-4 py-2.5 text-[11px] uppercase tracking-wide text-zinc-500 font-medium";
export const td = "px-4 py-2";
export const num = "px-4 py-2 text-right tabular-nums";
