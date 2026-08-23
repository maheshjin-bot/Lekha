import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

/**
 * The one accent color means "act here" everywhere in the app — a primary
 * button is the only filled, saturated control on most screens. Loading
 * state swaps the label rather than showing a spinner: per the design
 * system's motion principles, a rotating spinner is a proven irritant to
 * someone staring at this screen for hours, and a label swap is enough to
 * confirm "your click registered."
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-ink hover:opacity-90",
        ghost: "border border-border-strong bg-transparent text-ink hover:bg-accent-soft",
        destructive: "bg-error text-white hover:opacity-90",
      },
      size: {
        default: "px-4 py-2",
        sm: "px-3 py-1.5 text-xs",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Disables the button and swaps its label — no spinner, per the motion principles. */
  busy?: boolean;
  busyLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, busy, busyLabel, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={disabled || busy}
        {...props}
      >
        {busy ? busyLabel ?? "Working…" : children}
      </button>
    );
  }
);
Button.displayName = "Button";
