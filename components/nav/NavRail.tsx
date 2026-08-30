"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { SignOutButton } from "@/components/auth/SignOutButton";

type NavItem = { href: string; label: string };
type NavGroup = { label: string; items: NavItem[] };

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "—";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Exact match for a leaf route, prefix match for anything with children (so
 * /vouchers/new and /vouchers/abc123/edit both light up "New voucher"'s
 * neighbours correctly rather than every /vouchers/* link at once). */
function isActive(activePath: string, href: string): boolean {
  return activePath === href;
}

export function NavRail({
  companyId,
  companyName,
  activePath,
  mobileOpen = false,
  onMobileClose,
}: {
  companyId: string;
  companyName: string;
  activePath: string;
  /**
   * Below `lg:` this rail is an off-canvas drawer, not a permanent sidebar —
   * AppShell owns the open/closed boolean (it also renders the hamburger
   * button that flips it) and passes it straight through. At `lg:` and up
   * these two props are simply never touched: the rail's classes fall back
   * to their always-visible, in-flow desktop shape regardless of their
   * value, so nothing here needs a separate desktop code path.
   */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const base = `/${companyId}`;

  const groups: NavGroup[] = [
    {
      label: "Transactions",
      items: [
        { href: `${base}/vouchers/new`, label: "New voucher" },
        { href: `${base}/invoices/new`, label: "New invoice" },
        { href: `${base}/pos`, label: "Quick billing" },
        { href: `${base}/import`, label: "Import" },
        { href: `${base}/capture`, label: "Capture a bill" },
        { href: `${base}/orders`, label: "Orders" },
        { href: `${base}/forex`, label: "Foreign currency" },
        { href: `${base}/job-work`, label: "Job work" },
        { href: `${base}/manufacturing`, label: "Manufacturing" },
        { href: `${base}/delivery-challans`, label: "Delivery challans" },
        { href: `${base}/exim`, label: "EXIM shipments" },
        { href: `${base}/recurring-vouchers`, label: "Recurring vouchers" },
        { href: `${base}/service-advances`, label: "Service advances (GST)" },
        { href: `${base}/eway-bill`, label: "E-way bills" },
        { href: `${base}/einvoice`, label: "E-invoices" },
        { href: `${base}/signature-requests`, label: "Signature requests" },
        { href: `${base}/stock-verification`, label: "Stock verification" },
        { href: `${base}/approvals`, label: "Approvals" },
      ],
    },
    {
      label: "Masters",
      items: [
        { href: `${base}/ledgers`, label: "Ledgers" },
        { href: `${base}/items`, label: "Items" },
        { href: `${base}/price-lists`, label: "Price lists" },
        { href: `${base}/discount-agreements`, label: "Discount agreements" },
        { href: `${base}/fixed-assets`, label: "Fixed assets" },
        { href: `${base}/cost-centres`, label: "Cost centres" },
        { href: `${base}/batches`, label: "Batches & serials" },
        { href: `${base}/closing-stock`, label: "Closing stock" },
        { href: `${base}/depreciation`, label: "Depreciation" },
        { href: `${base}/budgets`, label: "Budgets" },
        { href: `${base}/notices`, label: "Notices" },
        { href: `${base}/tax-payments`, label: "Tax payments" },
        { href: `${base}/godowns`, label: "Godowns" },
        { href: `${base}/employees`, label: "Employees" },
        { href: `${base}/employees/perquisites`, label: "Perquisites" },
        { href: `${base}/leave`, label: "Leave" },
        { href: `${base}/fnf-settlement`, label: "Full & final settlement" },
        { href: `${base}/directors`, label: "Directors & KMP" },
        { href: `${base}/significant-beneficial-owners`, label: "Significant beneficial owners" },
        { href: `${base}/meetings`, label: "Meetings" },
        { href: `${base}/share-capital`, label: "Share capital" },
        { href: `${base}/charges`, label: "Charges (CHG-1/CHG-4)" },
        { href: `${base}/sec186-investments`, label: "Sec 186 investments" },
        { href: `${base}/dsc-register`, label: "DSC register" },
        { href: `${base}/filing-register`, label: "Filing register" },
      ],
    },
    {
      label: "GST",
      items: [
        { href: `${base}/registrations`, label: "Registrations" },
        { href: `${base}/reports/gst-registers`, label: "Registers" },
        { href: `${base}/reports/gst-setoff`, label: "GST set-off" },
        { href: `${base}/reports/itc-180day-reversal`, label: "ITC 180-day reversal" },
        { href: `${base}/reports/gstr2b-match`, label: "GSTR-2B match" },
        { href: `${base}/reports/gstr3b-prep`, label: "GSTR-3B prep" },
        { href: `${base}/reports/gst-refunds`, label: "GST refunds" },
        { href: `${base}/reports/gst-tds-tcs-suffered`, label: "GST TDS/TCS suffered" },
      ],
    },
    {
      label: "Reports",
      items: [
        { href: `${base}/reports/daybook`, label: "Daybook" },
        { href: `${base}/reports/sales-invoices`, label: "Sales invoices" },
        { href: `${base}/reports/purchase-invoices`, label: "Purchase invoices" },
        { href: `${base}/reports/sales-returns`, label: "Sales returns" },
        { href: `${base}/reports/purchase-returns`, label: "Purchase returns" },
        { href: `${base}/reports/ledger-statement`, label: "Ledger statement" },
        { href: `${base}/reports/trial-balance`, label: "Trial balance" },
        { href: `${base}/reports/profit-loss`, label: "Profit & loss" },
        { href: `${base}/reports/balance-sheet`, label: "Balance sheet" },
        { href: `${base}/reports/cash-flow`, label: "Cash flow" },
        { href: `${base}/reports/stock`, label: "Stock" },
        { href: `${base}/reports/stock-ageing`, label: "Stock ageing" },
        { href: `${base}/reports/stock-expiry`, label: "Stock expiry" },
        { href: `${base}/reports/outstanding`, label: "Outstanding" },
        { href: `${base}/reports/msme`, label: "MSME dues" },
        { href: `${base}/reports/stock-statement`, label: "Stock statement" },
        { href: `${base}/reports/cost-centre-pnl`, label: "Cost centre P&L" },
        { href: `${base}/reports/budget-variance`, label: "Budget variance" },
        { href: `${base}/reports/cma-ratios`, label: "CMA & ratios" },
        { href: `${base}/reports/tally-export`, label: "Export to Tally" },
        { href: `${base}/reports/itc-04-prep`, label: "ITC-04 prep" },
        { href: `${base}/reports/gstr1-summary`, label: "GSTR-1 summary" },
        { href: `${base}/reports/isd-distribution`, label: "ISD distribution" },
        { href: `${base}/reports/tds-summary`, label: "TDS summary" },
        { href: `${base}/reports/tds-threshold-status`, label: "TDS threshold status" },
        { href: `${base}/reports/tds-interest-and-fees`, label: "TDS interest & 234E fee" },
        { href: `${base}/reports/tds-return-24q`, label: "TDS return 24Q" },
        { href: `${base}/reports/tds-return-26q`, label: "TDS return 26Q" },
        { href: `${base}/reports/tds-return-27q`, label: "TDS return 27Q" },
        { href: `${base}/reports/tds-return-27eq`, label: "TDS return 27EQ (TCS)" },
        { href: `${base}/reports/form16-partb`, label: "Form 16 Part B" },
        { href: `${base}/reports/tds-credit-match`, label: "26AS/AIS/TIS match" },
        { href: `${base}/lower-deduction`, label: "Sec 197 certificates" },
        { href: `${base}/reports/tax-depreciation`, label: "Tax depreciation" },
        { href: `${base}/deferred-tax`, label: "Deferred tax" },
        { href: `${base}/reports/income-tax`, label: "Income tax" },
        { href: `${base}/reports/advance-tax`, label: "Advance tax" },
        { href: `${base}/reports/itr-prep`, label: "ITR prep" },
        { href: `${base}/reports/tax-audit`, label: "Tax audit" },
        { href: `${base}/reports/common-credit-apportionment`, label: "Common credit (Rules 42/43)" },
        { href: `${base}/reports/notes-to-accounts`, label: "Notes to accounts" },
        { href: `${base}/reports/discount-agreement-coverage`, label: "Discount agreement coverage" },
        { href: `${base}/reports/gstr9-workpaper`, label: "GSTR-9/9C workpaper" },
        { href: `${base}/reports/dpt3-content`, label: "DPT-3 content" },
        { href: `${base}/reports/aoc4-xbrl`, label: "AOC-4 XBRL" },
        { href: `${base}/reports/payroll-register`, label: "Payroll register" },
        { href: `${base}/reports/payroll-registers`, label: "Payroll registers (muster/wage)" },
        { href: `${base}/reports/pt-liability`, label: "Professional tax by state" },
        { href: `${base}/reports/statutory-bonus`, label: "Statutory bonus" },
        { href: `${base}/reports/gratuity`, label: "Gratuity" },
        { href: `${base}/reports/pf-ecr`, label: "PF ECR" },
        { href: `${base}/reports/esi-mc`, label: "ESI MC" },
        { href: `${base}/reports/compliance-calendar`, label: "Calendar" },
      ],
    },
  ];

  const bottomItems: NavItem[] = [
    { href: `${base}/reconciliation`, label: "Reconcile" },
    { href: `${base}/notifications`, label: "Notifications" },
    { href: `${base}/audit-trail`, label: "Audit trail" },
    { href: `${base}/year-end`, label: "Year-end" },
    { href: `${base}/settings`, label: "Settings" },
    { href: `${base}/settings/team`, label: "Team" },
    { href: `${base}/settings/employer-registrations`, label: "Employer registrations" },
    { href: `${base}/settings/numbering`, label: "Voucher numbering" },
    { href: `${base}/whatsapp-numbers`, label: "WhatsApp numbers" },
    { href: `${base}/settings/print-template`, label: "Invoice design" },
    { href: `${base}/settings/backup`, label: "Backup / export" },
    { href: `${base}/settings/api-keys`, label: "API keys" },
    // Not under /[companyId]: a second factor belongs to the person, not to a
    // company, so someone working across six companies enrols once.
    { href: `/security`, label: "Account security" },
  ];

  const [openGroup, setOpenGroup] = useState<string | null>(() => {
    const active = groups.find((g) => g.items.some((i) => isActive(activePath, i.href)));
    return active?.label ?? null;
  });

  return (
    <>
      {/* Backdrop — below lg: only, and only while the drawer is open. A tap
          anywhere outside the rail closes it, same as every other overlay in
          this app. */}
      {mobileOpen && (
        <div
          onClick={onMobileClose}
          aria-hidden="true"
          className="fixed inset-0 z-30 bg-ink/40 lg:hidden"
        />
      )}

      {/* Below lg: fixed and off-canvas by default, shown as an overlay
          drawer only while mobileOpen — a click on any link inside closes it
          via the delegated handler below, the same "navigating away closes
          the drawer" behaviour every mobile nav pattern uses. At lg: and up
          this is the original always-visible, in-flow sidebar.
          Plain hidden/flex display toggling on purpose, not a translate-x
          slide-in: confirmed live, twice, with two different class shapes,
          that Tailwind's translate-x-* utilities (backed by the registered
          --tw-translate-x custom property) get stuck displaying whichever
          value was first computed for this element and never re-resolve on
          a later class swap, even well past the transition's own duration.
          display has none of that custom-property machinery — hidden/flex
          is the same pattern virtually every Tailwind responsive nav uses,
          and it actually works. */}
      <nav
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) onMobileClose?.();
        }}
        className={cn(
          "fixed inset-y-0 left-0 z-40 h-screen w-60 shrink-0 flex-col border-r border-border bg-surface print:hidden lg:static lg:z-auto lg:flex",
          mobileOpen ? "flex" : "hidden"
        )}
      >
        {/* Company switcher — pinned at the very top of the rail, above the
            menu. For a firm juggling several GST-registered entities,
            changing companies is a navigational act, not a settings screen. */}
        <div className="flex items-center border-b border-border">
          <Link
            href="/companies"
            className="flex min-w-0 flex-1 items-center gap-2.5 px-4 py-3.5 transition-colors hover:bg-surface-2"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft font-mono text-[11px] font-semibold text-accent">
              {initials(companyName)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink">{companyName}</span>
              <span className="block text-[11px] text-ink-faint">Switch company</span>
            </span>
          </Link>
          <button
            type="button"
            onClick={onMobileClose}
            aria-label="Close menu"
            className="mr-2 shrink-0 rounded-md p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink-soft lg:hidden"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2.5 py-3">
        <NavLink href={base} label="Overview" active={isActive(activePath, base)} />

        {groups.map((group) => {
          const groupActive = group.items.some((i) => isActive(activePath, i.href));
          const open = openGroup === group.label || groupActive;
          return (
            <div key={group.label} className="mt-1">
              <button
                type="button"
                onClick={() => setOpenGroup(open ? null : group.label)}
                className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint transition-colors hover:text-ink-soft"
              >
                {group.label}
                <ChevronDown
                  size={13}
                  className={cn("transition-transform", open && "rotate-180")}
                />
              </button>
              {open && (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <NavLink
                      key={item.href}
                      href={item.href}
                      label={item.label}
                      active={isActive(activePath, item.href)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="mt-3 flex flex-col gap-0.5 border-t border-border pt-3">
          {bottomItems.map((item) => (
            <NavLink
              key={item.href}
              href={item.href}
              label={item.label}
              active={isActive(activePath, item.href)}
            />
          ))}
        </div>
      </div>

      <div className="border-t border-border px-3 py-3">
        <SignOutButton />
      </div>
    </nav>
    </>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "block rounded-md px-2.5 py-1.5 text-sm transition-colors",
        active
          ? "border-l-2 border-accent bg-accent-soft pl-2 font-medium text-accent"
          : "border-l-2 border-transparent text-ink-soft hover:bg-surface-2 hover:text-ink"
      )}
    >
      {label}
    </Link>
  );
}
