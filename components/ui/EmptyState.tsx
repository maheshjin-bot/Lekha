import { cn } from "@/lib/utils/cn";

/** Dashed-border placeholder, replacing 4+ duplicated instances. */
export function EmptyState({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint",
        className
      )}
    >
      {children}
    </p>
  );
}
