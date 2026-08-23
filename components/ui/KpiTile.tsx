import { cn } from "@/lib/utils/cn";

/**
 * Label + mono tabular-nums figure + delta line, per the design system's
 * dashboard mock (`.dash-kpi`). The figure is always the numeric monospace
 * font so a row of tiles lines up the same way a ledger column does.
 */
export function KpiTile({
  label,
  value,
  delta,
  deltaTone = "neutral",
  className,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "ok" | "warn" | "bad" | "neutral";
  className?: string;
}) {
  const deltaColor = {
    ok: "text-success",
    warn: "text-warning",
    bad: "text-error",
    neutral: "text-ink-faint",
  }[deltaTone];

  return (
    <div className={cn("rounded-lg border border-border p-3", className)}>
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-ink-faint">
        {label}
      </div>
      <div className="mt-1.5 font-mono text-[17px] font-medium tabular-nums text-ink">
        {value}
      </div>
      {delta && <div className={cn("mt-1 text-[10.5px]", deltaColor)}>{delta}</div>}
    </div>
  );
}
