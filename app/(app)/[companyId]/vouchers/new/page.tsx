import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { VoucherForm } from "@/components/vouchers/VoucherForm";

export default async function NewVoucherPage({
  params,
}: PageProps<"/[companyId]/vouchers/new">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: ledgers }, { data: branches }, { data: tdsSections }, { data: tdsPayableMap }] =
    await Promise.all([
      supabase
        .from("ledgers")
        .select(
          "id, name, account_groups(name), is_tds_deductee, default_tds_section, ldc_rate, ldc_valid_from, ldc_valid_to, ldc_amount_cap"
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
    ]);

  const flatLedgers = (ledgers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    group_name: l.account_groups?.name ?? null,
    is_tds_deductee: l.is_tds_deductee,
    default_tds_section: l.default_tds_section,
    ldc_rate: l.ldc_rate,
    ldc_valid_from: l.ldc_valid_from,
    ldc_valid_to: l.ldc_valid_to,
    ldc_amount_cap: l.ldc_amount_cap,
  }));

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
        <VoucherForm
          companyId={companyId}
          ledgers={flatLedgers}
          branches={branches ?? []}
          tdsSections={tdsSections ?? []}
          tdsPayableLedgerId={tdsPayableMap?.ledger_id ?? null}
        />
      )}
    </main>
  );
}
