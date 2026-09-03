"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Menu, Keyboard } from "lucide-react";
import { NavRail } from "@/components/nav/NavRail";
import { CommandBar } from "@/components/nav/CommandBar";
import { ContextBar, type ContextBarBranch } from "@/components/nav/ContextBar";
import { ShortcutSheet } from "@/components/nav/ShortcutSheet";
import { useShortcuts } from "@/lib/keys/useShortcuts";
import { GLOBAL_SCOPE } from "@/lib/keys/registry";

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
 *
 *   - Global keyboard shortcuts: AppShell is rendered from
 *     app/(app)/[companyId]/layout.tsx, so a single `useShortcuts(GLOBAL_SCOPE,
 *     …)` call registered here stays live across every navigation inside a
 *     company, exactly what "active anywhere in the app" requires (a
 *     per-page component would re-register — and briefly go dark — on every
 *     route change). Alt+S/Alt+Y jump to a blank /invoices/new or
 *     /vouchers/new with no query param; both forms already default their
 *     own voucherType state to "sales" and "payment" respectively
 *     (InvoiceForm.tsx, VoucherForm.tsx), so those two land exactly right
 *     with no further wiring. Alt+P and Alt+R append ?type=purchase and
 *     ?type=receipt to that same URL — InvoiceForm.tsx and VoucherForm.tsx
 *     each read that `type` query param once on mount (never on an edit,
 *     which already has its own real voucherType) and use it as their
 *     initial selection instead of the sales/payment default, so all four
 *     shortcuts land on the right PAGE *and* the right pre-selected type in
 *     the visible type selector.
 *
 *     Shift+? opens ShortcutSheet, listing every currently-registered
 *     shortcut across every mounted scope. Per useShortcuts.ts's own rule
 *     that a combo must never be the only way to reach what it triggers,
 *     the small "Keyboard shortcuts" button beside the mobile hamburger
 *     (and, at `lg:` and up, floating in the corner where NavRail leaves no
 *     header row to put it in) opens the exact same sheet by click.
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
  const [shortcutSheetOpen, setShortcutSheetOpen] = useState(false);
  const router = useRouter();

  // See this file's own header comment: the ?type= param on the purchase
  // bill and receipt routes is read by InvoiceForm.tsx/VoucherForm.tsx to
  // preselect their type selector, so all four shortcuts land on the right
  // page already showing the right voucher type.
  useShortcuts(GLOBAL_SCOPE, [
    {
      combo: "alt+s",
      label: "New sales invoice",
      handler: () => router.push(`/${companyId}/invoices/new`),
    },
    {
      combo: "alt+p",
      label: "New purchase bill",
      handler: () => router.push(`/${companyId}/invoices/new?type=purchase`),
    },
    {
      combo: "alt+r",
      label: "New receipt",
      handler: () => router.push(`/${companyId}/vouchers/new?type=receipt`),
    },
    {
      combo: "alt+y",
      label: "New payment",
      handler: () => router.push(`/${companyId}/vouchers/new`),
    },
    {
      combo: "shift+?",
      label: "Show keyboard shortcuts",
      handler: () => setShortcutSheetOpen(true),
    },
  ]);

  return (
    <div className="flex min-h-screen bg-bg">
      <CommandBar companyId={companyId} />
      <ShortcutSheet open={shortcutSheetOpen} onClose={() => setShortcutSheetOpen(false)} />
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
          <span className="truncate flex-1 text-sm font-semibold text-ink">{companyName}</span>
          <button
            type="button"
            onClick={() => setShortcutSheetOpen(true)}
            aria-label="Keyboard shortcuts"
            className="rounded-md p-1.5 text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Keyboard size={18} />
          </button>
        </header>
        <ContextBar
          companyId={companyId}
          companyName={companyName}
          fyStartMonth={fyStartMonth}
          branches={branches}
        />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
      {/* Desktop twin of the mobile header's button above — the header row
          itself is lg:hidden, so ShortcutSheet needs its own always-visible
          trigger at that breakpoint too (useShortcuts.ts's own rule: a combo
          must never be the only way to reach what it triggers). Fixed to the
          corner rather than threaded into ContextBar or NavRail — both are
          files outside this task's ownership, and a floating help button is
          a standalone affordance that does not need to live inside either.
          Stacked at bottom-20 (80px), not bottom-4 — confirmed live in the
          browser that the support-chat widget already floats a 48px circular
          button at bottom-6/right-6, z-50: placing this one at the same
          corner made it real but permanently unclickable, sitting entirely
          underneath that higher, larger, higher-z-index button. */}
      <button
        type="button"
        onClick={() => setShortcutSheetOpen(true)}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (Shift+?)"
        className="fixed bottom-20 right-4 z-30 hidden rounded-full border border-border bg-surface p-2.5 text-ink-soft shadow-card transition-colors hover:bg-surface-2 hover:text-ink lg:block print:hidden"
      >
        <Keyboard size={18} />
      </button>
    </div>
  );
}
