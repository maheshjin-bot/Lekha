import { createClient } from "@/lib/supabase/server";
import { LedgerManager } from "@/components/ledgers/LedgerManager";

export default async function LedgersPage({
  params,
}: PageProps<"/[companyId]/ledgers">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: ledgers }, { data: groups }, { data: tdsSections }, { data: modules }, { data: company }] =
    await Promise.all([
      supabase
        .from("ledgers")
        .select(
          "id, name, group_id, opening_balance_amount, opening_balance_type, is_active, pan, is_tds_deductee, default_tds_section, udyam_number, msme_category, msme_payment_days, is_partner_remuneration"
        )
        .eq("company_id", companyId)
        .order("name"),
      supabase
        .from("account_groups")
        .select("id, name, nature, ledger_role, parent_group_id")
        .eq("company_id", companyId)
        .order("sort_order"),
      supabase
        .from("ref_tds_sections")
        .select("section_code, description, rate_percent")
        .eq("is_active", true)
        .order("sort_order"),
      supabase.rpc("get_company_modules", { p_company_id: companyId }),
      supabase.from("companies").select("entity_type").eq("id", companyId).maybeSingle(),
    ]);

  const tdsOn = (modules ?? []).some((m) => m.code === "tds" && m.active);
  const msmeOn = (modules ?? []).some((m) => m.code === "msme" && m.active);
  // Sec 40(b)'s remuneration slab ceiling only ever applies to firms/LLPs —
  // the flag is meaningless (and the income tax report never reads it) for
  // any other entity type.
  const partnerRemunerationOn =
    company?.entity_type === "partnership" || company?.entity_type === "llp";

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Ledgers</h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        Every posting lands in a ledger, and every ledger belongs to a group.
        The group decides how it appears in the statements.
      </p>
      <LedgerManager
        companyId={companyId}
        initialLedgers={ledgers ?? []}
        groups={groups ?? []}
        tdsSections={tdsSections ?? []}
        tdsOn={tdsOn}
        msmeOn={msmeOn}
        partnerRemunerationOn={partnerRemunerationOn}
      />
    </main>
  );
}
