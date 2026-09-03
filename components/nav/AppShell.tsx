"use client";

import { useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { NavRail } from "@/components/nav/NavRail";
import { CommandBar } from "@/components/nav/CommandBar";
import { ContextBar, type ContextBarBranch } from "@/components/nav/ContextBar";

/**
 * Owns the one boolean NavRail's off-canvas drawer needs and that a
 * server-component layout cannot hold itself: whether the mobile menu is
 * open. Below `lg:` this renders a slim top bar with the hamburger that
 * flips it; at `lg:` and up the bar is hidden and NavRail falls back to its
 * always-visible sidebar shape, so nothing here changes the desktop layout
 * pixel-for-pixel from what CompanyLayout rendered directly before this.
 *
 * Also mounts the two other shell-wide pieces of nav:
 *
 *   - CommandBar: global Ctrl+K/Cmd+K search over every screen plus the
 *     company's own ledgers/items/vouchers/employees. It is entirely
 *     self-contained (owns its own open/closed state, registers the keyboard
 *     listener itself) — dropping it anywhere in the tree is the whole
 *     integration, per its own file header.
 *
 *   - ContextBar: the sticky Company/FY/Branch/Period bar every report page
 *     currently re-derives its own period/branch defaults without. It sits
 *     between the mobile header and the page content, so a screen scrolled
 *     to that stays visible both above `lg:` (where the mobile header is
 *     hidden) and below it.
 *
 *     ContextBar needs two things this shell does not have today —
 *     `companies.financial_year_start_month` and the company's branch list —
 *     because app/(app)/[companyId]/layout.tsx (this component's only
 *     caller, and a file outside this task's assignment) does not select or
 *     fetch either yet. Both are accepted here as optional props, defaulted
 *     to "not known" (null / no branches) rather than required, so ContextBar
 *     still mounts and works today: readContext() already treats a null
 *     fyStartMonth as "April" (its own documented default), and ContextBar
 *     already renders no branch control at all for an empty branches array.
 *     The FY and Period controls are fully correct as soon as this mounts;
 *     only the Branch control is silently absent until layout.tsx is updated
 *     to pass the real values through — see this task's own `needs`.
 */
export function AppShell({
  companyId,
  companyName,
  activePath,
  fyStartMonth = null,
  branches = [],
  children,
}: {
  companyId: string;
  companyName: string;
  activePath: string;
  fyStartMonth?: number | null;
  branches?: ContextBarBranch[];
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-bg">
      <CommandBar companyId={companyId} />
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
        <ContextBar
          companyId={companyId}
          companyName={companyName}
          fyStartMonth={fyStartMonth}
          branches={branches}
        />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
