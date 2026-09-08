import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LedgerEditForm } from "@/components/ledgers/LedgerEditForm";

export default async function EditLedgerPage({
  params,
}: PageProps<"/[companyId]/ledgers/[ledgerId]/edit">) {
  const { companyId, ledgerId } = await params;
  const supabase = await createClient();

  const [{ data: ledger }, { data: groups }, { data: tdsSections }, { data: modules }, { data: company }] =
    await Promise.all([
      supabase
        .from("ledgers")
        .select(
          "id, name, group_id, opening_balance_amount, opening_balance_type, is_active, pan, tan, state_code, gst_registration_type, gstin, contact_person, phone, email, address, city, pincode, notes, udyam_number, msme_category, msme_payment_days, bank_name, bank_account_number, bank_ifsc, is_tds_deductee, default_tds_section, is_partner_remuneration, is_related_party, relationship_type, is_loan_or_deposit, sec43b_category, party_type, credit_days"
        )
        .eq("id", ledgerId)
        .eq("company_id", companyId)
        .maybeSingle(),
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

  if (!ledger) notFound();

  // update_ledger (1900) hard-locks the account group once real postings
  // exist — checked here too, ahead of a round trip, purely so the form can
  // disable the control and explain why rather than let a save attempt come
  // back with the RPC's own refusal as the first anyone hears of it.
  const { count: postingCount } = await supabase
    .from("voucher_entries")
    .select("id", { count: "exact", head: true })
    .eq("ledger_id", ledgerId)
    .eq("company_id", companyId);

  const tdsOn = (modules ?? []).some((m) => m.code === "tds" && m.active);
  const msmeOn = (modules ?? []).some((m) => m.code === "msme" && m.active);
  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);
  const partnerRemunerationOn =
    company?.entity_type === "partnership" || company?.entity_type === "llp";
  const relatedPartyOn = (modules ?? []).some((m) => m.code === "tax_audit" && m.active);
  const loanTrackingOn = relatedPartyOn;
  const sec43bOn = relatedPartyOn;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href={`/${companyId}/ledgers`}
        className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
      >
        ← Back to ledgers
      </Link>
      <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight text-ink">
        Edit <span className="font-mono">{ledger.name}</span>
      </h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        Every change is recorded in the audit trail with a before and after
        snapshot.
      </p>
      <LedgerEditForm
        companyId={companyId}
        ledger={ledger}
        hasPostings={(postingCount ?? 0) > 0}
        groups={groups ?? []}
        tdsSections={tdsSections ?? []}
        tdsOn={tdsOn}
        msmeOn={msmeOn}
        partnerRemunerationOn={partnerRemunerationOn}
        relatedPartyOn={relatedPartyOn}
        loanTrackingOn={loanTrackingOn}
        sec43bOn={sec43bOn}
        gstOn={gstOn}
      />
    </main>
  );
}
