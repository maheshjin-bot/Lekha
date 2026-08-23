import { cn } from "@/lib/utils/cn";

/**
 * Reserved strictly for what the colors mean in a ledger: settled (ok),
 * pending/attend-to-this (warn), overdue/invalid (bad) — never decorative.
 * Replaces ~10 ad hoc pill reimplementations across the app.
 */
const TONE = {
  ok: "bg-success-soft text-success",
  warn: "bg-warning-soft text-warning",
  bad: "bg-error-soft text-error",
  neutral: "bg-surface-2 text-ink-soft",
  accent: "bg-accent-soft text-accent",
} as const;

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: keyof typeof TONE;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        TONE[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
