import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { VoucherScreen } from "@/components/vouchers/VoucherScreen";
import {
  buildNumberingByBranch,
  type NumberingSettingsRow,
} from "@/lib/numbering/voucher-numbering";

export default async function NewVoucherPage({
  params,
}: PageProps<"/[companyId]/vouchers/new">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [
    { data: ledgers },
    { data: branches },
    { data: tdsSections },
    { data: tdsPayableMap },
    { data: gstLedgerRows },
    { data: modules },
    { data: states },
    { data: tcsSections },
  ] =
    await Promise.all([
      // state_code/pan are added here (beyond what VoucherForm ever needed)
      // because VoucherScreen's own unified Ledger type requires both —
      // Ctrl+H can swap this route into item-invoice/accounting-invoice mode,
      // whose party Combobox and GST tax preview read them. See the Recon
      // contract's B1b for the full "why the two forms' Ledger types had to
      // widen into one" reasoning.
      supabase
        .from("ledgers")
        .select(
          "id, name, account_groups(name, ledger_role), is_tds_deductee, default_tds_section, ldc_rate, ldc_valid_from, ldc_valid_to, ldc_amount_cap, state_code, pan, gstin, gst_registration_type, party_type"
        )
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("branches")
        .select("id, code, name")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("is_head_office", { ascending: false }),
      supabase
        .from("ref_tds_sections")
        .select("section_code, description, rate_percent")
        .eq("is_active", true)
        .order("sort_order"),
      // Company-wide (gst_registration_id null), same lookup shape the print
      // page already uses for tax_ledger_map — RLS-gated direct select,
      // rather than a dedicated RPC wrapper.
      supabase
        .from("tax_ledger_map")
        .select("ledger_id")
        .eq("company_id", companyId)
        .eq("purpose", "tds_payable")
        .is("gst_registration_id", null)
        .maybeSingle(),
      // 1781: the ledgers VoucherForm's own TDS-base netting must treat as
      // "this line is GST, not the underlying value" — the eight per-tax-leg
      // purposes only, across every GST registration this company holds, not
      // the whole ledger_role='duty_tax' umbrella (PF/ESI/PT/TCS/RCM/TDS
      // Payable/GST Payable/GST TDS Receivable all share that same role and
      // must never be netted out of a TDS base).
      supabase
        .from("tax_ledger_map")
        .select("ledger_id")
        .eq("company_id", companyId)
        .in("purpose", [
          "input_cgst",
          "input_sgst",
          "input_igst",
          "input_cess",
          "output_cgst",
          "output_sgst",
          "output_igst",
          "output_cess",
        ]),
      // gstOn/tcsOn, states and TCS sections — cheap, company/reference-scale
      // reads, fetched so a Ctrl+H swap into item-invoice mode from this
      // route renders its GST/TCS-dependent fields correctly rather than
      // silently behaving as if neither module were active. items/godowns/
      // priceListItems are deliberately left [] below (Recon B1's own
      // sanctioned default for "a pure raw-voucher route") — those scale with
      // company size, unlike these three reference-table reads.
      supabase.rpc("get_company_modules", { p_company_id: companyId }),
      supabase.from("ref_states").select("code, name").order("name"),
      supabase
        .from("ref_tcs_sections")
        .select("section_code, rate_percent, no_pan_rate_percent, threshold_rupees")
        .eq("is_active", true),
    ]);

  const flatLedgers = (ledgers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    group_name: l.account_groups?.name ?? null,
    // See the same field in components/vouchers/VoucherForm.tsx.
    ledger_role: l.account_groups?.ledger_role ?? null,
    is_tds_deductee: l.is_tds_deductee,
    default_tds_section: l.default_tds_section,
    ldc_rate: l.ldc_rate,
    ldc_valid_from: l.ldc_valid_from,
    ldc_valid_to: l.ldc_valid_to,
    ldc_amount_cap: l.ldc_amount_cap,
    state_code: l.state_code,
    pan: l.pan,
    gstin: l.gstin,
    gst_registration_type: l.gst_registration_type,
    party_type: l.party_type,
  }));

  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);
  const tcsOn = (modules ?? []).some((m) => m.code === "tcs" && m.active);

  // The numbering policy per voucher type (migration 0725) — fetched here, as
  // a prop, for the same reason the ledgers and branches above are: the form
  // is a client component and must not go looking for its own data.
  //
  // Once per BRANCH, and only after the branch list is known, hence the second
  // wave rather than a slot in the Promise.all above. The mode and the series
  // list are company-scoped and identical across branches, but the preview
  // number is not — {BRANCH} is the commonest token in a prefix and each
  // branch keeps its own counter — and showing a preview for the wrong branch
  // would be worse than showing none. Companies here carry one or two active
  // branches (max 2 across the whole database), so this is one or two parallel
  // calls, not a fan-out.
  //
  // get_voucher_numbering_settings is brand new and types/database.types.ts —
  // owned by the integration pass, not regenerated by this task — does not
  // know it yet, hence the disabled rule below. Same convention as
  // components/einvoice/EinvoiceDetailForm.tsx.
  const gstLedgerIds = (gstLedgerRows ?? []).map((r) => r.ledger_id);

  const numbering = buildNumberingByBranch(
    await Promise.all(
      (branches ?? []).map(async (b) => {
        const { data } = await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .rpc("get_voucher_numbering_settings" as any, {
            p_company_id: companyId,
            p_branch_id: b.id,
          });
        return [b.id, (data ?? []) as unknown as NumberingSettingsRow[]] as const;
      })
    )
  );

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">New voucher</h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        Debits and credits must match. The database enforces it too — this is
        just the faster place to find out.
      </p>

      {flatLedgers.length < 2 ? (
        <p className="mt-8 rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          You need at least two ledgers before you can post.{" "}
          <Link
            href={`/${companyId}/ledgers`}
            className="text-accent underline underline-offset-4"
          >
            Create some
          </Link>
          .
        </p>
      ) : (
        <VoucherScreen
          companyId={companyId}
          defaultMode="raw-voucher"
          items={[]}
          ledgers={flatLedgers}
          // registeredState is never fetched on this route (VoucherForm
          // never needed it) — B1c's own sanctioned default for a
          // raw-voucher-originating route: null per branch, read only by
          // item/accounting mode's tax preview, which this route's Ctrl+H
          // swap into either of those modes will not have a GST-registration
          // fact to show either way.
          branches={(branches ?? []).map((b) => ({ ...b, registeredState: null }))}
          godowns={[]}
          states={states ?? []}
          gstOn={gstOn}
          tcsOn={tcsOn}
          tcsSections={tcsSections ?? []}
          priceListItems={[]}
          tdsSections={tdsSections ?? []}
          tdsPayableLedgerId={tdsPayableMap?.ledger_id ?? null}
          gstLedgerIds={gstLedgerIds}
          numbering={numbering}
        />
      )}
    </main>
  );
}
