import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/auth/SignOutButton";

export default async function CompanyLayout({
  params,
  children,
}: LayoutProps<"/[companyId]">) {
  const { companyId } = await params;
  const supabase = await createClient();

  // RLS returns nothing for a company you are not a member of, so a missing
  // row and a forbidden one are the same 404 — which is the right answer:
  // "this company exists but is not yours" is itself information.
  const { data } = await supabase
    .from("companies")
    .select("id, name")
    .eq("id", companyId)
    .maybeSingle();

  if (!data) notFound();

  const nav = [
    { href: `/${companyId}`, label: "Overview" },
    { href: `/${companyId}/ledgers`, label: "Ledgers" },
    { href: `/${companyId}/items`, label: "Items" },
    { href: `/${companyId}/godowns`, label: "Godowns" },
    { href: `/${companyId}/registrations`, label: "GST" },
    { href: `/${companyId}/invoices/new`, label: "New invoice" },
    { href: `/${companyId}/vouchers/new`, label: "New voucher" },
    { href: `/${companyId}/import`, label: "Import" },
    { href: `/${companyId}/reports/daybook`, label: "Daybook" },
    { href: `/${companyId}/reports/ledger-statement`, label: "Ledger" },
    { href: `/${companyId}/reports/trial-balance`, label: "Trial balance" },
    { href: `/${companyId}/reports/profit-loss`, label: "P&L" },
    { href: `/${companyId}/reports/balance-sheet`, label: "Balance sheet" },
    { href: `/${companyId}/reports/stock`, label: "Stock" },
    { href: `/${companyId}/reports/outstanding`, label: "Outstanding" },
    { href: `/${companyId}/reports/msme`, label: "MSME dues" },
    { href: `/${companyId}/reports/compliance-calendar`, label: "Calendar" },
    { href: `/${companyId}/reconciliation`, label: "Reconcile" },
    { href: `/${companyId}/year-end`, label: "Year-end" },
    { href: `/${companyId}/settings`, label: "Settings" },
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <Link href="/companies" className="shrink-0 font-semibold tracking-tight">
            {data.name}
          </Link>
          <nav className="flex flex-1 flex-wrap gap-1 overflow-x-auto">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="whitespace-nowrap rounded px-2.5 py-1.5 text-sm text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <SignOutButton />
        </div>
      </header>
      {children}
    </div>
  );
}
