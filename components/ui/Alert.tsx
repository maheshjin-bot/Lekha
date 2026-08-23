import { cn } from "@/lib/utils/cn";

/**
 * Inline banner, replacing the success/error/warning <p> reimplemented after
 * nearly every form. Most new success feedback should prefer the sonner
 * Toaster (mounted in app/layout.tsx) instead — this stays for validation
 * errors and states that must remain visible until the user acts.
 */
const TONE = {
  error: "bg-error-soft text-error border-error/20",
  success: "bg-success-soft text-success border-success/20",
  warning: "bg-warning-soft text-warning border-warning/20",
} as const;

export function Alert({
  tone,
  className,
  children,
}: {
  tone: keyof typeof TONE;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn("rounded-lg border px-3 py-2 text-sm", TONE[tone], className)}
    >
      {children}
    </p>
  );
}
