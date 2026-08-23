"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
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
}: {
  companyId: string;
  companyName: string;
  activePath: string;
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
        { href: `${base}/orders`, label: "Orders" },
        { href: `${base}/forex`, label: "Foreign currency" },
        { href: `${base}/job-work`, label: "Job work" },
        { href: `${base}/manufacturing`, label: "Manufacturing" },
        { href: `${base}/approvals`, label: "Approvals" },
      ],
    },
    {
      label: "Masters",
      items: [
        { href: `${base}/ledgers`, label: "Ledgers" },
        { href: `${base}/items`, label: "Items" },
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
        { href: `${base}/directors`, label: "Directors & KMP" },
        { href: `${base}/meetings`, label: "Meetings" },
      ],
    },
    {
      label: "GST",
      items: [
        { href: `${base}/registrations`, label: "Registrations" },
        { href: `${base}/reports/gst-registers`, label: "Registers" },
        { href: `${base}/reports/gst-setoff`, label: "GST set-off" },
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
        { href: `${base}/reports/stock`, label: "Stock" },
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
        { href: `${base}/lower-deduction`, label: "Sec 197 certificates" },
        { href: `${base}/reports/tax-depreciation`, label: "Tax depreciation" },
        { href: `${base}/deferred-tax`, label: "Deferred tax" },
        { href: `${base}/reports/income-tax`, label: "Income tax" },
        { href: `${base}/reports/tax-audit`, label: "Tax audit" },
        { href: `${base}/reports/payroll-register`, label: "Payroll register" },
        { href: `${base}/reports/compliance-calendar`, label: "Calendar" },
      ],
    },
  ];

  const bottomItems: NavItem[] = [
    { href: `${base}/reconciliation`, label: "Reconcile" },
    { href: `${base}/audit-trail`, label: "Audit trail" },
    { href: `${base}/year-end`, label: "Year-end" },
    { href: `${base}/settings`, label: "Settings" },
    { href: `${base}/settings/employer-registrations`, label: "Employer registrations" },
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
    <nav className="flex h-screen w-60 shrink-0 flex-col border-r border-border bg-surface print:hidden">
      {/* Company switcher — pinned at the very top of the rail, above the menu.
          For a firm juggling several GST-registered entities, changing
          companies is a navigational act, not a settings screen. */}
      <Link
        href="/companies"
        className="flex items-center gap-2.5 border-b border-border px-4 py-3.5 transition-colors hover:bg-surface-2"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft font-mono text-[11px] font-semibold text-accent">
          {initials(companyName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{companyName}</span>
          <span className="block text-[11px] text-ink-faint">Switch company</span>
        </span>
      </Link>

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
