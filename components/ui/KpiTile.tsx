import Link from "next/link";
import { cn } from "@/lib/utils/cn";

/**
 * Label + mono tabular-nums figure + delta line, per the design system's
 * dashboard mock (`.dash-kpi`). The figure is always the numeric monospace
 * font so a row of tiles lines up the same way a ledger column does.
 *
 * `href` is optional and additive — every existing call site renders exactly
 * as before (a plain, non-interactive `<div>`). When passed, the whole tile
 * becomes the click target for drilling into the report the figure came
 * from, the same "click a figure, land on where it came from" pattern the
 * report pages use for individual rows (see components/reports/DrillLink.tsx)
 * — this is that same idea at the tile level, not a new interaction.
 */
export function KpiTile({
  label,
  value,
  delta,
  deltaTone = "neutral",
  href,
  className,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "ok" | "warn" | "bad" | "neutral";
  href?: string;
  className?: string;
}) {
  const deltaColor = {
    ok: "text-success",
    warn: "text-warning",
    bad: "text-error",
    neutral: "text-ink-faint",
  }[deltaTone];

  const classes = cn(
    "rounded-lg border border-border p-3",
    href && "block transition-colors hover:border-border-strong hover:bg-surface-2",
    className
  );

  const content = (
    <>
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-ink-faint">
        {label}
      </div>
      <div className="mt-1.5 font-mono text-[17px] font-medium tabular-nums text-ink">
        {value}
      </div>
      {delta && <div className={cn("mt-1 text-[10.5px]", deltaColor)}>{delta}</div>}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }

  return <div className={classes}>{content}</div>;
}
