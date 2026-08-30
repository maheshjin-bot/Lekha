"use client";

import { ArrowDown, ArrowUp, Camera, ClipboardList, Trash2 } from "lucide-react";
import type { ScanPage } from "@/lib/scan/types";

/**
 * The home screen, and the one that has to work with a thumb, in a godown, in
 * bad light.
 *
 * Everything reachable without moving your hand is at the BOTTOM: the shutter,
 * the page count, and the one way forward. The top strip is read-only context
 * (which business, which gate) plus the recent-sends door. There is no
 * navigation because there is nowhere else to go.
 */
export function ShootScreen({
  companyName,
  branchName,
  pages,
  onShoot,
  onDelete,
  onMove,
  onNext,
  onChangePlace,
  onOpenRecent,
}: {
  companyName: string;
  branchName: string | null;
  pages: ScanPage[];
  onShoot: () => void;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: number) => void;
  onNext: () => void;
  onChangePlace: () => void;
  onOpenRecent: () => void;
}) {
  const count = pages.length;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <button
          type="button"
          onClick={onChangePlace}
          className="flex min-w-0 flex-1 flex-col items-start rounded-lg px-1 py-1 text-left active:bg-surface-2"
        >
          <span className="w-full truncate text-base font-semibold text-ink">
            {companyName}
          </span>
          <span className="w-full truncate text-xs text-ink-faint">
            {/* Plenty of companies have no branches at all, so an absent one is
                not a missing setting to nag about — just offer the switch. */}
            {branchName ? `${branchName} · tap to change` : "Tap to change"}
          </span>
        </button>
        <button
          type="button"
          onClick={onOpenRecent}
          className="flex h-12 min-w-[3rem] items-center justify-center gap-1.5 rounded-lg border border-border-strong px-3 text-sm font-semibold text-ink-soft active:bg-surface-2"
        >
          <ClipboardList size={18} />
          <span>Sent</span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-4">
        {count === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 pb-16 text-center">
            <span className="flex h-20 w-20 items-center justify-center rounded-full bg-surface-2 text-ink-faint">
              <Camera size={36} strokeWidth={1.5} />
            </span>
            <p className="font-display text-2xl font-semibold text-ink">
              Photograph the paper
            </p>
            <p className="max-w-xs text-base text-ink-soft">
              Lay it flat, get all four corners in the frame, then press the button
              below.
            </p>
          </div>
        ) : (
          <>
            <p className="pb-3 text-sm font-semibold uppercase tracking-wide text-ink-faint">
              {count} {count === 1 ? "page" : "pages"} in this document
            </p>
            <ul className="flex flex-col gap-3">
              {pages.map((page, index) => (
                <li
                  key={page.id}
                  className="flex items-center gap-3 rounded-card border border-border bg-surface p-3"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-sm font-semibold text-ink-soft">
                    {index + 1}
                  </span>
                  {/* eslint-disable-next-line @next/next/no-img-element -- an in-memory object URL of a photo taken seconds ago, not a static asset Next's <Image> can optimise. */}
                  <img
                    src={page.previewUrl}
                    alt={`Page ${index + 1}`}
                    className="h-24 w-20 shrink-0 rounded-md border border-border object-cover"
                  />
                  <div className="min-w-0 flex-1 text-xs text-ink-faint">
                    <p className="font-mono">
                      {page.width > 0 ? `${page.width}×${page.height}` : "original"}
                    </p>
                    <p className="font-mono">{Math.round(page.bytes / 1024)} KB</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <div className="flex gap-1">
                      <IconButton
                        label={`Move page ${index + 1} up`}
                        disabled={index === 0}
                        onClick={() => onMove(page.id, -1)}
                      >
                        <ArrowUp size={18} />
                      </IconButton>
                      <IconButton
                        label={`Move page ${index + 1} down`}
                        disabled={index === pages.length - 1}
                        onClick={() => onMove(page.id, 1)}
                      >
                        <ArrowDown size={18} />
                      </IconButton>
                    </div>
                    <IconButton
                      label={`Delete page ${index + 1}`}
                      tone="danger"
                      onClick={() => onDelete(page.id)}
                    >
                      <Trash2 size={18} />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* Thumb zone. pb uses the safe-area inset so the shutter never sits
          underneath an iPhone's home indicator or a gesture bar. */}
      <div
        className="border-t border-border bg-surface px-4 pt-4"
        style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={onShoot}
            data-testid="scan-shutter"
            className="flex h-[76px] w-[76px] shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink shadow-card transition-transform active:scale-95"
            aria-label={count === 0 ? "Take a photo" : "Add another page"}
          >
            <Camera size={34} />
          </button>

          {count === 0 ? (
            <p className="text-base text-ink-soft">
              Take the first photo of this document.
            </p>
          ) : (
            <button
              type="button"
              onClick={onNext}
              data-testid="scan-next"
              className="flex min-h-[60px] flex-1 items-center justify-center rounded-card border-2 border-accent bg-transparent px-4 text-lg font-semibold text-accent active:bg-accent-soft"
            >
              Next · tag it
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function IconButton({
  children,
  label,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={
        "flex h-11 w-11 items-center justify-center rounded-lg border border-border-strong disabled:opacity-30 " +
        (tone === "danger"
          ? "text-error active:bg-error-soft"
          : "text-ink-soft active:bg-surface-2")
      }
    >
      {children}
    </button>
  );
}
