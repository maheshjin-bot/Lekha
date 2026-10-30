"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { House, FileText, ScanLine, BarChart3, Menu } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { mobilePrimaryNav, resolveNavHref } from "@/lib/nav/registry";

/**
 * The persistent 5-slot mobile bottom bar: Home, Invoices, a raised centre
 * FAB for Scan, Reports, and More. Visible only below `lg:` — the exact
 * breakpoint NavRail.tsx's own drawer/rail split already uses (see that
 * file's own header) — so at `lg:` and up this renders nothing and NavRail
 * looks exactly as it did before this file existed.
 *
 * This is ADDITIVE, not a replacement: the hamburger drawer NavRail already
 * renders below `lg:` keeps working exactly as before (a "Menu" tap there
 * still opens it, same as it always did), and "More" here is a second door
 * into that very same drawer — AppShell.tsx passes this the identical
 * `onOpenMore` handler its own hamburger button calls, so there is exactly
 * one drawer, one `mobileOpen` boolean, two triggers.
 *
 * Every href rendered here is a real `NavEntry` from
 * lib/nav/registry.ts's own curated `mobilePrimaryNav` — this file holds no
 * label or href of its own for Home/Invoices/Reports/Scan, only the layout
 * and the icons, so a future edit to any one of those entries cannot
 * silently drift out of sync with what this bar shows.
 *
 * Scan is deliberately NOT company-scoped: /scan is a separate surface with
 * its own device-remembered company/branch picker (see app/scan/layout.tsx
 * and lib/scan/deviceMemory.ts's own headers for why). `resolveNavHref` is
 * still called on it below, uniformly with the other three, but it is a
 * documented no-op for this one entry (its href carries no ":companyId"
 * token to replace) — so the FAB still lands on plain `/scan`, never on a
 * `/${companyId}/scan` route that does not exist.
 *
 * `env(safe-area-inset-bottom)` pads the bar itself for a notched phone's
 * home indicator, mirroring the inline-style convention components/scan's
 * own screens already use for the identical purpose — expressed here as a
 * Tailwind arbitrary value instead of an inline style only because this
 * component (unlike a full-bleed /scan screen) also needs the ordinary
 * `lg:hidden` responsive class alongside it.
 */
export function BottomNav({
  companyId,
  activePath,
  onOpenMore,
}: {
  companyId: string;
  activePath: string;
  onOpenMore: () => void;
}) {
  const homeHref = resolveNavHref(mobilePrimaryNav.home.href, companyId);
  const invoicesHref = resolveNavHref(mobilePrimaryNav.invoices.href, companyId);
  const reportsHref = resolveNavHref(mobilePrimaryNav.reports.href, companyId);
  const scanHref = resolveNavHref(mobilePrimaryNav.scan.href, companyId);

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden print:hidden"
    >
      <div className="relative grid h-16 grid-cols-5 items-stretch">
        <TabLink
          href={homeHref}
          label="Home"
          active={activePath === homeHref}
          icon={<House size={20} />}
        />
        <TabLink
          href={invoicesHref}
          label="Invoices"
          active={activePath === invoicesHref}
          icon={<FileText size={20} />}
        />

        {/* Centre grid cell, left empty — the raised FAB below is
            absolutely positioned and escapes this cell's own box, but the
            cell itself still has to exist for the other four tabs to land
            in a true five-column grid rather than a lopsided four. */}
        <div aria-hidden="true" />

        <TabLink
          href={reportsHref}
          label="Reports"
          active={activePath === reportsHref}
          icon={<BarChart3 size={20} />}
        />

        <button
          type="button"
          onClick={onOpenMore}
          className="flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-ink-soft transition-colors hover:text-ink"
        >
          <Menu size={20} aria-hidden="true" />
          More
        </button>

        {/* The raised centre FAB. Positioned absolutely against the grid's
            own relative wrapper, not as a real sixth column, so it can rise
            above the bar's top edge (`-top-5`) the way a raised FAB always
            does, without needing a taller row than the four ordinary tabs.
            A static transform, not one ever swapped between two values at
            runtime — the translate-x bug the Responsive pass work found
            (see NavRail.tsx's own comment) was specifically about toggling
            between two different translate classes on the same element;
            this element's transform never changes, so that trap does not
            apply here. */}
        <Link
          href={scanHref}
          aria-label={mobilePrimaryNav.scan.label}
          title={mobilePrimaryNav.scan.label}
          className="absolute left-1/2 -top-5 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full border-4 border-bg bg-accent text-accent-ink shadow-card transition-transform active:scale-95"
        >
          <ScanLine size={22} aria-hidden="true" />
        </Link>
      </div>
    </nav>
  );
}

function TabLink({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors",
        active ? "text-accent" : "text-ink-soft hover:text-ink"
      )}
    >
      {icon}
      {label}
    </Link>
  );
}
