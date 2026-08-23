"use client";

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg border border-border-strong px-3 py-1.5 text-sm transition-colors hover:bg-accent-soft"
    >
      Print
    </button>
  );
}
