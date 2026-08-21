import { createClient } from "@/lib/supabase/server";
import { JobWorkManager } from "@/components/job-work/JobWorkManager";

export default async function JobWorkPage({
  params,
}: PageProps<"/[companyId]/job-work">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: challans }, { data: items }, { data: ledgers }, { data: branches }, { data: godowns }] =
    await Promise.all([
      supabase.rpc("get_job_work_outstanding", { p_company_id: companyId }),
      supabase
        .from("items")
        .select("id, name, uom")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .eq("maintain_stock", true)
        .order("name"),
      supabase
        .from("ledgers")
        .select("id, name, account_groups!inner(ledger_role)")
        .eq("company_id", companyId)
        .eq("account_groups.ledger_role", "creditor")
        .order("name"),
      supabase.from("branches").select("id, code, name").eq("company_id", companyId).eq("is_active", true),
      supabase.from("godowns").select("id, name, is_default").eq("company_id", companyId).eq("is_active", true),
    ]);

  const ledgerRows = (ledgers ?? []).map((l) => ({ id: l.id, name: l.name }));

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Job work
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Track material sent to a job worker (GST Sec 143) — a real stock movement, but
          not a supply, so it posts no P&amp;L or party-ledger impact. Each challan tracks
          its own 1-year (input) / 3-year (capital good) deemed-supply clock.
        </p>
      </header>

      <JobWorkManager
        companyId={companyId}
        challans={(challans ?? []) as never}
        items={items ?? []}
        ledgers={ledgerRows}
        branches={branches ?? []}
        godowns={godowns ?? []}
      />
    </main>
  );
}
