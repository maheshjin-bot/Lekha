import { createClient } from "@/lib/supabase/server";
import { defaultPeriod } from "@/lib/utils/period";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

type Row = {
  row_scope: "line" | "whole_voucher";
  voucher_id: string;
  voucher_number: string;
  voucher_type: string;
  voucher_date: string;
  party_ledger_id: string;
  party_name: string;
  voucher_item_id: string | null;
  item_description: string;
  amount_before_discount: number;
  discount_percent: number | null;
  discount_amount: number;
  net_amount: number;
  agreement_id: string | null;
  agreement_terms: string | null;
  agreement_agreed_date: string | null;
  agreement_is_active: boolean | null;
  original_invoice_voucher_id: string | null;
  original_invoice_number: string | null;
  original_invoice_date: string | null;
  is_backed: boolean;
  backed_reason: string;
};

export default async function DiscountAgreementCoveragePage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/discount-agreement-coverage">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month")
    .eq("id", companyId)
    .maybeSingle();

  const period = defaultPeriod(company?.financial_year_start_month ?? 4, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  // get_discount_agreement_coverage is brand new (0431) — not yet in
  // generated types/database.types.ts (off-limits, owned by the integration
  // pass). Same `as unknown as` escape hatch already used by
  // reports/notes-to-accounts for get_notes_employee_benefits_breakup (0360).
  const { data, error } = await supabase.rpc("get_discount_agreement_coverage", {
    p_company_id: companyId,
    p_from: period.from,
    p_to: period.to,
  });

  const rows = (data ?? []) as unknown as Row[];
  const unbackedCount = rows.filter((r) => !r.is_backed).length;
  const unbackedValue = rows.filter((r) => !r.is_backed).reduce((n, r) => n + Number(r.discount_amount), 0);

  return (
    <ReportShell
      title="Discount agreement coverage"
      period={`${period.label} · Sec 15(3)(b) CGST Act defensibility, not a filing`}
      status={
        error
          ? { label: "Could not compute", tone: "bad" }
          : rows.length === 0
            ? { label: "No discounts in period", tone: "ok" }
            : unbackedCount === 0
              ? { label: "Every discount is agreement-backed", tone: "ok" }
              : { label: `${unbackedCount} discount(s), ${formatINR(unbackedValue, { showZero: true })} unbacked`, tone: "warn" }
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 print:hidden">
        <form className="flex items-center gap-2 text-sm" action="">
          <label htmlFor="from" className="text-ink-soft">
            From
          </label>
          <input
            type="date"
            id="from"
            name="from"
            defaultValue={period.from}
            className="rounded-md border border-border-strong bg-surface px-2 py-1"
          />
          <label htmlFor="to" className="text-ink-soft">
            To
          </label>
          <input
            type="date"
            id="to"
            name="to"
            defaultValue={period.to}
            className="rounded-md border border-border-strong bg-surface px-2 py-1"
          />
          <button type="submit" className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            Show
          </button>
        </form>
        <a href={`/${companyId}/discount-agreements`} className="text-sm text-accent underline underline-offset-4">
          Manage agreements →
        </a>
      </div>

      <table className="w-full min-w-[980px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Voucher</th>
            <th className={th}>Party</th>
            <th className={th}>What was discounted</th>
            <th className={th + " text-right"}>Discount</th>
            <th className={th}>Agreement</th>
            <th className={th}>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {!error && rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-12 text-center text-ink-faint">
                No line discount and no explicitly-linked credit note falls in this period.
              </td>
            </tr>
          )}
          {error && (
            <tr>
              <td colSpan={6} className="px-4 py-12 text-center text-danger">
                Could not compute this report: {error.message}
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.voucher_id}-${r.voucher_item_id ?? "whole"}`} className="border-b border-border align-top last:border-0">
              <td className={td}>
                {r.voucher_number}
                <div className="text-xs text-ink-faint">
                  {r.voucher_date} · {r.voucher_type === "credit_note" ? "Credit note" : "Sales invoice"}
                </div>
              </td>
              <td className={td}>{r.party_name}</td>
              <td className={td}>
                {r.item_description}
                {r.discount_percent != null && (
                  <div className="text-xs text-ink-faint">{Number(r.discount_percent)}% off</div>
                )}
              </td>
              <td className={num}>{formatINR(Number(r.discount_amount))}</td>
              <td className={td}>
                {r.agreement_terms ? (
                  <>
                    <span className="max-w-[220px] truncate block" title={r.agreement_terms}>
                      {r.agreement_terms}
                    </span>
                    <div className="text-xs text-ink-faint">
                      Agreed {r.agreement_agreed_date}
                      {r.original_invoice_number && ` · vs ${r.original_invoice_number} (${r.original_invoice_date})`}
                    </div>
                  </>
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </td>
              <td className={td}>
                <Badge tone={r.is_backed ? "ok" : "bad"}>{r.is_backed ? "Backed" : "Unbacked"}</Badge>
                <div className="mt-1 text-xs text-ink-faint">{r.backed_reason}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="space-y-2 border-t border-border px-4 py-3 text-xs text-ink-faint">
        <p>
          <strong>Scope.</strong> Every sales-invoice or credit-note line carrying a 0147
          discount_percent, plus every credit note explicitly linked whole to an agreement even
          when none of its own lines carry a discount_percent (the normal shape of a flat-rupee
          post-supply rebate). A credit note that is neither is not shown — this app cannot tell a
          genuine goods-return credit note apart from an un-flagged rebate one, and guessing would
          be automatic matching, which this feature deliberately does not do.
        </p>
        <p>
          <strong>What &ldquo;Backed&rdquo; proves, and what it does not.</strong> A line marked
          Backed is linked to an <em>active</em> agreement dated at or before the relevant
          supply — the original invoice&rsquo;s date when one is named on the link, else the
          voucher&rsquo;s own date as a necessary-but-not-sufficient proxy (a credit note is
          always later than the true original supply, so this can occasionally read Backed when a
          more precisely-dated check would not — name the original invoice on the link to remove
          that gap). This proves Sec 15(3)(b)(i) only: the agreement and its invoice linkage.
          It does <strong>not</strong> prove Sec 15(3)(b)(ii) — that the recipient has actually
          reversed the proportionate ITC — because that is a fact about the recipient&rsquo;s own
          GSTR-3B, not something this supplier&rsquo;s books can observe. Sales-invoice-line
          discounts (Sec 15(3)(a)) do not legally need an agreement at all, since being &ldquo;duly
          recorded in the invoice&rdquo; already excludes them from taxable value — a link there is
          useful supporting evidence, not a requirement.
        </p>
        <p>
          <strong>The law is mid-change.</strong> The Finance Act (No. 4), 2026 already substitutes
          Sec 15(3)(b) to drop the agreement/invoice-linkage condition entirely (credit note +
          ITC reversal only) — but per the CBIC&rsquo;s own repository, that amendment is enacted
          and not yet notified into force. This report is built against the law as it stands
          today; once that notification issues, the &ldquo;agreed at or before supply&rdquo; check
          below stops being a live requirement for new credit notes.
        </p>
      </div>
    </ReportShell>
  );
}
