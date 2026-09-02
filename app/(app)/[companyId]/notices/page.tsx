import { createClient } from "@/lib/supabase/server";
import { NoticeManager, type Notice } from "@/components/notices/NoticeManager";
import {
  ContingentLiabilityManager,
  type ContingentLiability,
  type CounterpartyLedger,
} from "@/components/contingent-liabilities/ContingentLiabilityManager";

export default async function NoticesPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/notices">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const requested = typeof sp.filter === "string" ? sp.filter : "open";
  const filter = requested === "all" || requested === "disclosed" ? requested : "open";

  const [{ data: notices }, { data: disclosure }, { data: docs }, { data: contingent }, { data: ledgers }] =
    await Promise.all([
      supabase.rpc("get_notices", {
        p_company_id: companyId,
        // "In the contingent note" spans every status — a closed notice still
        // ticked as contingent is exactly the row worth finding.
        p_status_filter: filter === "open" ? "open" : undefined,
      }),
      // get_notices predates 0105 and returns neither is_disclosed_as_contingent
      // nor contingent_amount. Read them straight off the table under
      // notices_read RLS and merge by id, rather than widening that RPC's
      // return type: changing a function's OUT columns means dropping and
      // recreating it, and get_notices is shared with the dashboard and the
      // compliance surfaces. Same tenant filter either way.
      supabase
        .from("notices")
        .select("id, is_disclosed_as_contingent, contingent_amount")
        .eq("company_id", companyId),
      supabase
        .from("documents")
        .select("id, storage_path, file_name, mime_type, size_bytes, created_at, entity_id")
        .eq("company_id", companyId)
        .eq("entity_type", "notice"),
      supabase
        .from("contingent_liabilities")
        .select(
          "id, category, description, related_ledger_id, amount, raised_date, status, resolved_date, resolution_note"
        )
        .eq("company_id", companyId)
        .order("status")
        .order("raised_date", { ascending: false }),
      // Every ledger, not a party-filtered subset: the counterparty on a
      // guarantee is usually the BANK that issued it, and bank ledgers carry
      // neither ledger_role nor party_type in real seeded data (confirmed
      // live — the one contingent liability that already existed points at
      // "HDFC Bank Current A/c", which a party filter would have hidden,
      // leaving its own row unable to show its own counterparty). ~66 ledgers
      // is the largest chart of accounts in this project.
      supabase.from("ledgers").select("id, name").eq("company_id", companyId).order("name"),
    ]);

  const disclosureById = new Map(
    (disclosure ?? []).map((d) => [
      d.id,
      {
        is_disclosed_as_contingent: d.is_disclosed_as_contingent,
        contingent_amount: d.contingent_amount,
      },
    ])
  );

  const merged: Notice[] = (notices ?? []).map((n) => ({
    ...n,
    // A notice whose disclosure row somehow did not come back is shown as
    // disclosed, matching the column's own NOT NULL DEFAULT true rather than
    // inventing a safer-looking false the database does not hold.
    is_disclosed_as_contingent: disclosureById.get(n.id)?.is_disclosed_as_contingent ?? true,
    contingent_amount: disclosureById.get(n.id)?.contingent_amount ?? null,
  }));

  const visible = filter === "disclosed" ? merged.filter((n) => n.is_disclosed_as_contingent) : merged;

  const overdueCount = merged.filter((n) => n.is_overdue).length;
  const disclosedCount = (disclosure ?? []).filter((d) => d.is_disclosed_as_contingent).length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
            Notices &amp; assessments
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            Government notices received, tracked through to response. Response deadlines
            are whatever the notice itself says — they are not computed here.
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            {disclosedCount > 0 ? (
              <>
                {disclosedCount} {disclosedCount === 1 ? "notice is" : "notices are"} currently
                disclosed as a contingent liability in the{" "}
                <a
                  href={`/${companyId}/reports/notes-to-accounts`}
                  className="text-accent underline underline-offset-4"
                >
                  notes to accounts
                </a>
                . Review that before signing anything — a demand already paid or dropped must come
                out.
              </>
            ) : (
              <>
                No notice is currently disclosed as a contingent liability in the{" "}
                <a
                  href={`/${companyId}/reports/notes-to-accounts`}
                  className="text-accent underline underline-offset-4"
                >
                  notes to accounts
                </a>
                .
              </>
            )}
          </p>
        </div>
        {overdueCount > 0 && (
          <span className="rounded-full bg-error-soft px-3 py-1 text-sm font-semibold text-error">
            {overdueCount} overdue
          </span>
        )}
      </header>

      <NoticeManager companyId={companyId} notices={visible} filter={filter} docs={docs ?? []} />

      <section className="mt-14">
        <h2 className="mb-3 font-display text-xl font-semibold tracking-tight text-ink">
          Other contingent liabilities
        </h2>
        <ContingentLiabilityManager
          companyId={companyId}
          items={(contingent ?? []) as ContingentLiability[]}
          ledgers={(ledgers ?? []) as CounterpartyLedger[]}
        />
      </section>
    </main>
  );
}
