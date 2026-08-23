import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ReportShell } from "@/components/reports/ReportShell";
import { TaxPaymentManager } from "@/components/tax/TaxPaymentManager";

/** The financial year label for today, e.g. "2026-27". April-start. */
function currentFyLabel(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export default async function TaxPaymentsPage({
  params,
}: PageProps<"/[companyId]/tax-payments">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: payments } = await supabase
    .from("tax_payments")
    .select(
      "id, tax_type, minor_head, financial_year_label, payment_date, amount, bsr_code, challan_serial, challan_reference, tds_section"
    )
    .eq("company_id", companyId)
    .order("payment_date", { ascending: false });

  return (
    <ReportShell title="Tax payments" period="Challans on record">
      <TaxPaymentManager
        companyId={companyId}
        financialYearLabel={currentFyLabel()}
        payments={payments ?? []}
      />

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Every challan you have deposited: income tax on ITNS 280, TDS and TCS on ITNS 281, and GST
        on PMT-06. Income tax challans recorded here are netted off the{" "}
        <Link href={`/${companyId}/reports/income-tax`} className="underline">
          income tax computation
        </Link>{" "}
        — advance tax under minor head 100, self-assessment under 300 and a demand payment under
        400 — so without them that report shows the full year&rsquo;s tax as though nothing had
        been paid.
      </p>
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        The <strong className="font-medium text-ink">financial year</strong> is the year the payment
        belongs <em>to</em>, which is often not the year it was made in — self-assessment tax for
        2026-27 is normally paid during 2027-28. Getting it wrong is the single most common challan
        error, alongside picking the wrong minor head, and either one breaks the credit.
      </p>
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        The BSR code and challan serial together with the deposit date form the{" "}
        <strong className="font-medium text-ink">CIN</strong>, and an income tax return asks for all
        three separately when you claim credit — which is why they are stored as separate fields
        rather than as one string. Recording a challan here does not post anything to the ledger:
        the payment itself is an ordinary payment voucher, and this is the statutory record of it.
        TDS that your <em>customers</em> deducted from your receipts is different again — post that
        to the TDS Receivable ledger on the receipt voucher (Dr Bank, Dr TDS Receivable, Cr the
        customer) and it is credited automatically.
      </p>
    </ReportShell>
  );
}
