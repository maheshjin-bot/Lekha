import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { VoucherForm } from "@/components/vouchers/VoucherForm";

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

  const [{ data: entries }, { data: ledgers }, { data: branches }, { data: tdsSections }, { data: tdsPayableMap }] =
    await Promise.all([
      supabase
        .from("voucher_entries")
        .select("ledger_id, debit_amount, credit_amount, narration, line_order")
        .eq("voucher_id", voucherId)
        .order("line_order"),
      supabase
        .from("ledgers")
        .select(
          "id, name, account_groups(ledger_role), is_tds_deductee, default_tds_section, ldc_rate, ldc_valid_from, ldc_valid_to, ldc_amount_cap"
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
    ]);

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

      <VoucherForm
        companyId={companyId}
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
        }))}
        branches={branches ?? []}
        tdsSections={tdsSections ?? []}
        tdsPayableLedgerId={tdsPayableMap?.ledger_id ?? null}
        existing={{
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
        }}
      />
    </main>
  );
}
