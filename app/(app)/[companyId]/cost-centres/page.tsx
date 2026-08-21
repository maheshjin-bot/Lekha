import { createClient } from "@/lib/supabase/server";
import { defaultPeriod } from "@/lib/utils/period";
import { CostCentreManager } from "@/components/cost-centres/CostCentreManager";

export default async function CostCentresPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/cost-centres">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const showAll = sp.all === "1";

  const { data: profile } = await supabase.rpc("get_company_profile", {
    p_company_id: companyId,
  });
  const period = defaultPeriod(profile?.[0]?.financial_year_start_month ?? 4, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  const [{ data: centres }, { data: entries }] = await Promise.all([
    supabase
      .from("cost_centres")
      .select("id, code, name, kind, is_active")
      .eq("company_id", companyId)
      .order("kind")
      .order("code"),
    supabase.rpc("get_allocatable_entries", {
      p_company_id: companyId,
      p_from: period.from,
      p_to: period.to,
      p_unallocated_only: !showAll,
    }),
  ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Cost centres
        </h1>
        <p className="mt-1 text-sm text-ink-soft">{period.label}</p>
      </header>

      <CostCentreManager
        companyId={companyId}
        centres={centres ?? []}
        entries={(entries ?? []) as never}
        showAll={showAll}
      />

      <p className="mt-8 text-xs text-ink-faint">
        Allocation writes an analytical label only — it changes no amount, no ledger and
        no date, so your trial balance, profit &amp; loss and balance sheet are identical
        before and after. That is also why allocating is still allowed after a period is
        closed: a closed period&rsquo;s statements cannot move. The change is recorded in
        the audit trail either way. See the split at Reports → Cost centre P&amp;L.
      </p>
    </main>
  );
}
