import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { VoucherScreen, type VoucherScreenExisting } from "@/components/vouchers/VoucherScreen";

export default async function EditVoucherPage({
  params,
}: PageProps<"/[companyId]/vouchers/[voucherId]/edit">) {
  const { companyId, voucherId } = await params;
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("vouchers")
    .select(
      "id, voucher_number, voucher_type, voucher_date, narration, reference_number, financial_year_label, branch_id"
    )
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!voucher) notFound();

  const [
    { data: entries },
    { data: ledgers },
    { data: branches },
    { data: tdsSections },
    { data: tdsPayableMap },
    { data: gstLedgerRows },
  ] =
    await Promise.all([
      supabase
        .from("voucher_entries")
        .select("ledger_id, debit_amount, credit_amount, narration, line_order")
        .eq("voucher_id", voucherId)
        .order("line_order"),
      // state_code/pan are added here beyond what VoucherForm ever needed —
      // VoucherScreen's own unified Ledger type requires both (Recon B1b).
      // They render nothing on this fixed-mode edit screen (Ctrl+H is
      // disabled whenever isEdit — B6), but the prop type still requires them.
      // party_type/gstin were missing here entirely until this fix — silently
      // undefined on every ledger, which meant RawVoucherGrid's
      // tdsReceivableSuggestion() (1780 Finding C: a customer withholding TDS
      // on money owed to us) could never fire on an edit, only on a brand-new
      // receipt, since it requires party_type==='both' and a truthy gstin.
      supabase
        .from("ledgers")
        .select(
          "id, name, account_groups(ledger_role), is_tds_deductee, default_tds_section, ldc_rate, ldc_valid_from, ldc_valid_to, ldc_amount_cap, state_code, pan, party_type, gstin"
        )
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("branches")
        .select("id, code, name")
        .eq("company_id", companyId)
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
      // 1781: same GST-specific ledger set as vouchers/new — see that page
      // for why ledger_role='duty_tax' is too broad to net out of a TDS base.
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
    ]);

  const gstLedgerIds = (gstLedgerRows ?? []).map((r) => r.ledger_id);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href={`/${companyId}/vouchers/${voucherId}`}
        className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
      >
        ← Back to voucher
      </Link>

      <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight text-ink">
        Edit <span className="font-mono">{voucher.voucher_number}</span>
      </h1>
      <p className="mt-1.5 text-sm text-ink-soft">
        Replacing the lines rewrites the whole voucher. Every change is recorded
        in the audit trail with a before and after snapshot.
      </p>

      <VoucherScreen
        companyId={companyId}
        // Ctrl+H is disabled for the whole life of an edit screen (B6) — a
        // saved voucher's row-shape (voucher_entries here) is fixed forever
        // — so none of these three ever render anything on this route.
        items={[]}
        godowns={[]}
        states={[]}
        gstOn={false}
        tcsOn={false}
        tcsSections={[]}
        ledgers={(ledgers ?? []).map((l) => ({
          id: l.id,
          name: l.name,
          group_name: null,
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
          party_type: l.party_type,
          gstin: l.gstin,
        }))}
        branches={(branches ?? []).map((b) => ({ ...b, registeredState: null }))}
        tdsSections={tdsSections ?? []}
        tdsPayableLedgerId={tdsPayableMap?.ledger_id ?? null}
        gstLedgerIds={gstLedgerIds}
        existing={
          {
            mode: "raw-voucher",
            data: {
              id: voucher.id,
              voucherNumber: voucher.voucher_number,
              voucherType: voucher.voucher_type,
              financialYearLabel: voucher.financial_year_label,
              date: voucher.voucher_date,
              narration: voucher.narration ?? "",
              reference: voucher.reference_number ?? "",
              branchId: voucher.branch_id,
              lines: (entries ?? []).map((e) => ({
                ledgerId: e.ledger_id,
                side: Number(e.debit_amount) > 0 ? ("dr" as const) : ("cr" as const),
                amount: String(
                  Number(e.debit_amount) > 0 ? e.debit_amount : e.credit_amount
                ),
                narration: e.narration ?? "",
              })),
            },
          } satisfies VoucherScreenExisting
        }
      />
    </main>
  );
}
