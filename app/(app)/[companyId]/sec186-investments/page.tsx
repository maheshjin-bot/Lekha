import { createClient } from "@/lib/supabase/server";
import { Sec186InvestmentManager } from "@/components/investments/Sec186InvestmentManager";

export default async function Sec186InvestmentsPage({
  params,
}: PageProps<"/[companyId]/sec186-investments">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: company }, { data: investments }, { data: ceilingCheck }] = await Promise.all([
    supabase.from("companies").select("entity_type, name").eq("id", companyId).single(),
    supabase
      .from("sec186_investments")
      .select(
        "id, transaction_type, recipient_entity_name, amount, date, board_resolution_date, shareholder_resolution_date, purpose"
      )
      .eq("company_id", companyId)
      .order("date", { ascending: false }),
    supabase.rpc("get_sec186_ceiling_check", { p_company_id: companyId }),
  ]);

  const entityType = company?.entity_type ?? null;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Sec 186 loans &amp; investments (MBP-2)
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          Form MBP-2, the Sec 186(9) register of every loan given, guarantee or security given, or
          investment made by the company — mandatory for every such transaction regardless of
          size. Sec 186(2) always needs a board resolution; once the running total crosses the
          ceiling below, a shareholder special resolution is needed too (Sec 186(3)).
        </p>
      </header>

      <Sec186InvestmentManager
        companyId={companyId}
        entityType={entityType}
        investments={investments ?? []}
        ceilingCheck={ceilingCheck ?? []}
      />

      <p className="mt-6 max-w-2xl text-xs text-ink-faint">
        This register does not generate Form MBP-2 itself, and does not track repayment or
        closure of a loan given — every row entered here stays in the &ldquo;recorded
        total&rdquo; above indefinitely. The ceiling check reuses this app&rsquo;s exact paid-up
        capital figure (Sec 88 Register of Members), but approximates &ldquo;free reserves +
        securities premium&rdquo; as every ledger under this company&rsquo;s Reserves &amp;
        Surplus heading — this schema does not separately identify securities premium or exclude
        non-distributable reserves from that figure. Treat it as directional guidance, not a
        filing-ready computation.
      </p>
    </main>
  );
}
