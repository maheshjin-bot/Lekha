import { cn } from "@/lib/utils/cn";

/**
 * Segmented control for a small enum — goods/service, SLM/WDV, books-only/
 * compliance. Replaces 3 duplicated hand-rolled instances.
 */
export function RadioPillGroup<T extends string>({
  name,
  value,
  onChange,
  options,
  className,
}: {
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; description?: string }[];
  className?: string;
}) {
  return (
    <div className={cn("grid gap-2", className)} role="radiogroup">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <label
            key={opt.value}
            className={cn(
              "flex cursor-pointer flex-col rounded-lg border px-3 py-2 text-sm transition-colors",
              active
                ? "border-accent bg-accent-soft"
                : "border-border-strong hover:bg-surface-2"
            )}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={active}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            <span className="font-medium text-ink">{opt.label}</span>
            {opt.description && (
              <span className="mt-0.5 text-xs text-ink-soft">{opt.description}</span>
            )}
          </label>
        );
      })}
    </div>
  );
}
