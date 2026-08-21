import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ForexManager } from "@/components/forex/ForexManager";

export default async function ForexPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/forex">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const tab: "new" | "settle" = sp.tab === "settle" ? "settle" : "new";
  const supabase = await createClient();

  const [{ data: ledgers }, { data: branches }, { data: openVouchers }] = await Promise.all([
    supabase
      .from("ledgers")
      .select("id, name, account_groups!inner(ledger_role)")
      .eq("company_id", companyId)
      .order("name"),
    supabase
      .from("branches")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false }),
    supabase.rpc("get_open_fc_vouchers", { p_company_id: companyId }),
  ]);

  const ledgerRows = (ledgers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    role: (l.account_groups as unknown as { ledger_role: string } | null)?.ledger_role ?? null,
  }));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Foreign currency
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Record a foreign-currency journal, receipt or payment, then settle it later at
          whatever rate actually clears — the realized gain or loss posts automatically.
          The books stay INR-only throughout; currency is metadata on top.
        </p>
        <div className="mt-3 flex gap-2 text-sm">
          <Link
            href={`/${companyId}/forex`}
            className={
              "rounded-md border px-2.5 py-1 " +
              (tab === "new"
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong hover:bg-surface-2")
            }
          >
            New voucher
          </Link>
          <Link
            href={`/${companyId}/forex?tab=settle`}
            className={
              "rounded-md border px-2.5 py-1 " +
              (tab === "settle"
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong hover:bg-surface-2")
            }
          >
            Settle ({(openVouchers ?? []).length})
          </Link>
        </div>
      </header>

      <ForexManager
        companyId={companyId}
        tab={tab}
        ledgers={ledgerRows}
        branches={branches ?? []}
        openVouchers={(openVouchers ?? []) as never}
      />
    </main>
  );
}
