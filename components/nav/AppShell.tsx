"use client";

import { useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { NavRail } from "@/components/nav/NavRail";

/**
 * Owns the one boolean NavRail's off-canvas drawer needs and that a
 * server-component layout cannot hold itself: whether the mobile menu is
 * open. Below `lg:` this renders a slim top bar with the hamburger that
 * flips it; at `lg:` and up the bar is hidden and NavRail falls back to its
 * always-visible sidebar shape, so nothing here changes the desktop layout
 * pixel-for-pixel from what CompanyLayout rendered directly before this.
 */
export function AppShell({
  companyId,
  companyName,
  activePath,
  children,
}: {
  companyId: string;
  companyName: string;
  activePath: string;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-bg">
      <NavRail
        companyId={companyId}
        companyName={companyName}
        activePath={activePath}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2.5 lg:hidden print:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="rounded-md p-1.5 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Menu size={20} />
          </button>
          <span className="truncate text-sm font-semibold text-ink">{companyName}</span>
        </header>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
