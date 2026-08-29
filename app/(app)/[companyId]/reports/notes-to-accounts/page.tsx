import { Fragment } from "react";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod, periodRangeLabel } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

// Local to this page for the same reason balance-sheet/page.tsx keeps its
// own formatAsAt rather than widening lib/utils/period.ts's surface for one
// caller — "23 Aug 2026", not the raw ISO string a preparer would otherwise
// have to read off the query string.
function formatAsAt(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The local wall-clock date, as YYYY-MM-DD — never toISOString(), same
 * reasoning lib/utils/period.ts's own todayLocal carries. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const CONTINGENT_CATEGORY_ORDER = [
  "Claims against the company not acknowledged as debt",
  "Guarantees",
  "Other money for which the company is contingently liable",
];

// Matches the ledgers_relationship_type_check values from 0105 exactly.
const RELATIONSHIP_LABEL: Record<string, string> = {
  holding_company: "Holding company",
  subsidiary_or_fellow_subsidiary: "Subsidiary / fellow subsidiary",
  associate_or_joint_venture: "Associate / joint venture",
  individual_with_control_or_significant_influence: "Individual with control / significant influence",
  relative_of_such_individual: "Relative of such individual",
  key_management_personnel: "Key management personnel",
  relative_of_kmp: "Relative of KMP",
  enterprise_influenced_by_kmp_or_relative: "Enterprise influenced by KMP or relative",
  other: "Other related party",
};

const VOUCHER_TYPE_LABEL: Record<string, string> = {
  sales: "Sales",
  purchase: "Purchases",
  credit_note: "Credit notes",
  debit_note: "Debit notes",
  receipt: "Amounts received",
  payment: "Amounts paid",
  contra: "Contra",
  journal: "Journal / other adjustments",
};

const RECEIVABLE_BUCKET_ORDER = ["Not due", "Less than 6 months", "6 months - 1 year", "1-2 years", "2-3 years", "More than 3 years"];
const PAYABLE_BUCKET_ORDER = ["Not due", "Less than 1 year", "1-2 years", "2-3 years", "More than 3 years"];

// Matches get_notes_employee_benefits_breakup's bucket_order 1-5 (0360) —
// fixed so all five buckets render even when a company has nothing posted
// in one of them yet, the same "shell of known labels, SQL supplies only
// the actuals" split the ageing tables above already use.
const EMPLOYEE_BENEFIT_BUCKET_ORDER = [
  "Salaries and wages",
  "Contribution to provident and other funds (incl. ESI)",
  "Gratuity expense",
  "Statutory bonus",
  "Staff welfare / other",
];

type ContingentRow = {
  source: string;
  category: string;
  reference: string;
  description: string;
  amount: number | null;
  raised_date: string;
  status: string;
};

type RelatedPartyRow = {
  ledger_id: string;
  ledger_name: string;
  relationship_type: string | null;
  voucher_type: string | null;
  period_debit: number;
  period_credit: number;
  closing_balance: number;
  closing_balance_type: string;
};

type AgeingRow = {
  segment: string;
  bucket_label: string;
  bucket_order: number;
  amount: number;
};

type EmployeeBenefitRow = {
  bucket_order: number;
  bucket_label: string;
  source_basis: string;
  ledger_id: string;
  ledger_name: string;
  amount: number;
};

export default async function NotesToAccountsPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/notes-to-accounts">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: profile } = await supabase.rpc("get_company_profile", { p_company_id: companyId });
  const startMonth = profile?.[0]?.financial_year_start_month ?? 4;

  const asAt = typeof sp.as_at === "string" && sp.as_at ? sp.as_at : todayLocal();
  const period = defaultPeriod(startMonth, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  const [
    { data: contingentData },
    { data: relatedPartyData },
    { data: receivableAgeing },
    { data: payableAgeing },
    { data: employeeBenefitsData },
  ] = await Promise.all([
    supabase.rpc("get_contingent_liabilities_note", { p_company_id: companyId, p_as_at: asAt }),
    supabase.rpc("get_related_party_note", {
      p_company_id: companyId,
      p_period_start: period.from,
      p_period_end: period.to,
    }),
    supabase.rpc("get_ageing_schedule", { p_company_id: companyId, p_as_at: asAt, p_party_type: "receivable" }),
    supabase.rpc("get_ageing_schedule", { p_company_id: companyId, p_as_at: asAt, p_party_type: "payable" }),
    // get_notes_employee_benefits_breakup (0360) is not yet in the generated
    // database.types.ts (off-limits to this task, owned by the integration
    // pass' regeneration) — same `as unknown as` escape hatch already used
    // by reports/gst-refunds, reports/balance-sheet, reports/pt-liability.
    supabase.rpc("get_notes_employee_benefits_breakup", {
      p_company_id: companyId,
      p_period_start: period.from,
      p_period_end: period.to,
    }),
  ]);

  const contingent = (contingentData ?? []) as ContingentRow[];
  const relatedParty = (relatedPartyData ?? []) as RelatedPartyRow[];
  const receivable = (receivableAgeing ?? []) as AgeingRow[];
  const payable = (payableAgeing ?? []) as AgeingRow[];
  const employeeBenefits = (employeeBenefitsData ?? []) as unknown as EmployeeBenefitRow[];

  // --- Contingent liabilities: group by category, Schedule III's own order ---
  const contingentByCategory = new Map<string, ContingentRow[]>();
  for (const r of contingent) {
    const bucket = contingentByCategory.get(r.category);
    if (bucket) bucket.push(r);
    else contingentByCategory.set(r.category, [r]);
  }
  const orderedCategories = [
    ...CONTINGENT_CATEGORY_ORDER.filter((c) => contingentByCategory.has(c)),
    ...Array.from(contingentByCategory.keys()).filter((c) => !CONTINGENT_CATEGORY_ORDER.includes(c)),
  ];
  const quantifiedTotal = contingent.reduce((n, r) => n + (r.amount != null ? Number(r.amount) : 0), 0);
  const unquantifiedCount = contingent.filter((r) => r.amount == null).length;

  // --- Related party: group by ledger, in the order the RPC already emits ---
  const relatedByLedger = new Map<string, RelatedPartyRow[]>();
  for (const r of relatedParty) {
    const bucket = relatedByLedger.get(r.ledger_id);
    if (bucket) bucket.push(r);
    else relatedByLedger.set(r.ledger_id, [r]);
  }

  // --- Ageing: pivot the long-format rows into segment x bucket ---
  function pivotAgeing(rows: AgeingRow[], bucketOrder: string[]) {
    const segments = Array.from(new Set(rows.map((r) => r.segment)));
    const bySegment = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!bySegment.has(r.segment)) bySegment.set(r.segment, new Map());
      bySegment.get(r.segment)!.set(r.bucket_label, Number(r.amount));
    }
    const totalsByBucket = bucketOrder.map((label) =>
      rows.filter((r) => r.bucket_label === label).reduce((n, r) => n + Number(r.amount), 0)
    );
    const grandTotal = rows.reduce((n, r) => n + Number(r.amount), 0);
    return { segments, bySegment, totalsByBucket, grandTotal };
  }
  const receivablePivot = pivotAgeing(receivable, RECEIVABLE_BUCKET_ORDER);
  const payablePivot = pivotAgeing(payable, PAYABLE_BUCKET_ORDER);

  // --- Employee benefits expense: group by the SQL's own bucket_label ---
  const employeeBenefitsByBucket = new Map<string, EmployeeBenefitRow[]>();
  for (const r of employeeBenefits) {
    const bucket = employeeBenefitsByBucket.get(r.bucket_label);
    if (bucket) bucket.push(r);
    else employeeBenefitsByBucket.set(r.bucket_label, [r]);
  }
  const employeeBenefitsTotal = employeeBenefits.reduce((n, r) => n + Number(r.amount), 0);

  return (
    <ReportShell title="Notes to accounts" period={`As at ${formatAsAt(asAt)}`}>
      {/* -------------------------------------------------------------- */}
      {/* Date controls                                                  */}
      {/* -------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-4 border-b border-border p-4 text-sm print:hidden">
        <form className="flex items-center gap-2" action="">
          <input type="hidden" name="from" value={period.from} />
          <input type="hidden" name="to" value={period.to} />
          <label htmlFor="as_at" className="text-ink-soft">
            Contingent liabilities / ageing as at
          </label>
          <input
            type="date"
            id="as_at"
            name="as_at"
            defaultValue={asAt}
            className="rounded-md border border-border-strong bg-surface px-2 py-1"
          />
          <button type="submit" className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            Show
          </button>
        </form>
        <form className="flex items-center gap-2" action="">
          <input type="hidden" name="as_at" value={asAt} />
          <label htmlFor="from" className="text-ink-soft">
            Related-party period
          </label>
          <input type="date" id="from" name="from" defaultValue={period.from} className="rounded-md border border-border-strong bg-surface px-2 py-1" />
          <span className="text-ink-faint">to</span>
          <input type="date" name="to" defaultValue={period.to} className="rounded-md border border-border-strong bg-surface px-2 py-1" />
          <button type="submit" className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            Show
          </button>
        </form>
      </div>

      {/* -------------------------------------------------------------- */}
      {/* Section 1 — Contingent liabilities                             */}
      {/* -------------------------------------------------------------- */}
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Contingent liabilities</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Schedule III Note (i) / AS 29 — disclosure only, never posted to the ledger. Sourced from
          disputed notices marked as still contingent, plus guarantees and other contingently-liable
          money logged separately. Disputed/undisputed classification and commitments (Note (ii)) are
          not tracked by this schema and are not represented here.
        </p>
      </div>
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Reference</th>
            <th className={th}>Description</th>
            <th className={th}>Raised</th>
            <th className={th}>Status</th>
            <th className={th + " text-right"}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {contingent.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-ink-faint">
                No contingent liabilities disclosed as at {formatAsAt(asAt)}.
              </td>
            </tr>
          )}
          {orderedCategories.map((category) => (
            <Fragment key={category}>
              <tr className="border-b border-border bg-bg">
                <td colSpan={5} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                  {category}
                </td>
              </tr>
              {contingentByCategory.get(category)!.map((r, i) => (
                <tr key={`${category}-${i}`} className="border-b border-border last:border-0">
                  <td className={td}>{r.reference}</td>
                  <td className={td + " text-ink-soft"}>{r.description}</td>
                  <td className={td + " whitespace-nowrap"}>{r.raised_date}</td>
                  <td className={td + " capitalize"}>{r.status}</td>
                  <td className={num}>{r.amount != null ? formatINR(Number(r.amount)) : <span className="text-ink-faint">not yet quantified</span>}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
        {contingent.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td colSpan={4} className="px-4 py-2.5">
                Total (quantified items)
                {unquantifiedCount > 0 && (
                  <span className="ml-2 font-normal text-ink-faint">
                    + {unquantifiedCount} item{unquantifiedCount > 1 ? "s" : ""} of unquantified amount
                  </span>
                )}
              </td>
              <td className={num}>{formatINR(quantifiedTotal, { showZero: true })}</td>
            </tr>
          </tfoot>
        )}
      </table>

      {/* -------------------------------------------------------------- */}
      {/* Section 2 — Related party transactions (AS 18 / Ind AS 24)     */}
      {/* -------------------------------------------------------------- */}
      <div className="border-t border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Related party transactions</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          AS 18 / Ind AS 24, {periodRangeLabel(period.from, period.to)}. Every ledger flagged a related
          party (the same flag Sec 40A(2)(b)&rsquo;s tax-audit clause 23 uses — see Ledgers), grouped by
          relationship, with gross transaction value per type and the closing balance as at{" "}
          {formatAsAt(period.to)}.
        </p>
      </div>
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Transaction type</th>
            <th className={th + " text-right"}>Debit</th>
            <th className={th + " text-right"}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {relatedByLedger.size === 0 && (
            <tr>
              <td colSpan={3} className="px-4 py-8 text-center text-ink-faint">
                No ledger is currently flagged a related party.
              </td>
            </tr>
          )}
          {Array.from(relatedByLedger.entries()).map(([ledgerId, rows]) => (
            <Fragment key={ledgerId}>
              <tr className="border-b border-border bg-bg">
                <td colSpan={3} className="px-4 py-1.5">
                  <span className="text-sm font-semibold text-ink">{rows[0].ledger_name}</span>
                  <span className="ml-2 text-xs text-ink-faint">
                    {rows[0].relationship_type ? RELATIONSHIP_LABEL[rows[0].relationship_type] ?? rows[0].relationship_type : "relationship not classified"}
                  </span>
                </td>
              </tr>
              {rows.map((r, i) =>
                r.voucher_type ? (
                  <tr key={`${ledgerId}-${i}`} className="border-b border-border last:border-0">
                    <td className={td + " pl-8 text-ink-soft"}>{VOUCHER_TYPE_LABEL[r.voucher_type] ?? r.voucher_type}</td>
                    <td className={num}>{formatINR(Number(r.period_debit))}</td>
                    <td className={num}>{formatINR(Number(r.period_credit))}</td>
                  </tr>
                ) : (
                  <tr key={`${ledgerId}-${i}`} className="border-b border-border last:border-0">
                    <td colSpan={3} className="px-4 py-2 pl-8 text-ink-faint">
                      No transactions in this period.
                    </td>
                  </tr>
                )
              )}
              <tr className="border-b border-border bg-bg last:border-0">
                <td className={td + " pl-8 font-medium"}>Closing balance</td>
                <td colSpan={2} className={num + " font-medium"}>
                  {formatINR(Number(rows[0].closing_balance), { showZero: true })} {rows[0].closing_balance_type === "credit" ? "Cr" : "Dr"}
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>

      {/* -------------------------------------------------------------- */}
      {/* Section 3 — Employee benefits expense sub-break-up             */}
      {/* -------------------------------------------------------------- */}
      <div className="border-t border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Employee benefits expense</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Schedule III Part II, General Instructions — the aggregate Employee Benefits Expense head
          (Profit &amp; Loss), {periodRangeLabel(period.from, period.to)}, broken up by note. Salaries and
          wages / Contribution to provident and other funds are sourced from the payroll ledgers this app
          itself posts; Gratuity and Statutory bonus are name-matched only — neither the gratuity nor the
          bonus computation posts a voucher, so either shows Rs 0 unless a ledger has been manually created
          and named accordingly. ESOP/ESPP is not tracked (no share-based-payment feature exists) and
          would fall into Staff welfare / other if ever ledgered. Sums to the Employee Benefits Expense
          total on the Statement of Profit and Loss for the same period.
        </p>
      </div>
      <table className="w-full min-w-[700px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Particulars</th>
            <th className={th + " text-right"}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {employeeBenefits.length === 0 && (
            <tr>
              <td colSpan={2} className="px-4 py-8 text-center text-ink-faint">
                No employee benefits expense posted for {periodRangeLabel(period.from, period.to)}.
              </td>
            </tr>
          )}
          {EMPLOYEE_BENEFIT_BUCKET_ORDER.map((label) => {
            const rows = employeeBenefitsByBucket.get(label) ?? [];
            const bucketTotal = rows.reduce((n, r) => n + Number(r.amount), 0);
            if (rows.length === 0) {
              return (
                <tr key={label} className="border-b border-border last:border-0">
                  <td className={td}>{label}</td>
                  <td className={num + " text-ink-faint"}>{formatINR(0, { showZero: true })}</td>
                </tr>
              );
            }
            return (
              <Fragment key={label}>
                <tr className="border-b border-border bg-bg">
                  <td colSpan={2} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-soft">
                    {label}
                  </td>
                </tr>
                {rows.map((r) => (
                  <tr key={r.ledger_id} className="border-b border-border last:border-0">
                    <td className={td + " pl-8 text-ink-soft"}>{r.ledger_name}</td>
                    <td className={num}>{formatINR(Number(r.amount))}</td>
                  </tr>
                ))}
                {rows.length > 1 && (
                  <tr className="border-b border-border last:border-0">
                    <td className={td + " pl-8 font-medium"}>Total — {label}</td>
                    <td className={num + " font-medium"}>{formatINR(bucketTotal)}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        {employeeBenefits.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td className="px-4 py-2.5">Total employee benefits expense</td>
              <td className={num}>{formatINR(employeeBenefitsTotal, { showZero: true })}</td>
            </tr>
          </tfoot>
        )}
      </table>

      {/* -------------------------------------------------------------- */}
      {/* Section 4 — Ageing schedule                                    */}
      {/* -------------------------------------------------------------- */}
      <div className="border-t border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Trade receivables ageing</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Schedule III (MCA notification 24 Mar 2021), as at {formatAsAt(asAt)} — aged from voucher
          date (no per-invoice due date is tracked). Disputed/undisputed and unbilled sub-columns are
          not represented.
        </p>
      </div>
      <table className="w-full min-w-[860px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Particulars</th>
            {RECEIVABLE_BUCKET_ORDER.map((b) => (
              <th key={b} className={th + " text-right"}>{b}</th>
            ))}
            <th className={th + " text-right"}>Total</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border last:border-0">
            <td className={td}>Trade receivables</td>
            {RECEIVABLE_BUCKET_ORDER.map((b) => (
              <td key={b} className={num}>{formatINR(receivablePivot.bySegment.get("All")?.get(b) ?? 0, { showZero: true })}</td>
            ))}
            <td className={num + " font-medium"}>{formatINR(receivablePivot.grandTotal, { showZero: true })}</td>
          </tr>
        </tbody>
      </table>

      <div className="border-t border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Trade payables ageing</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Same amendment, MSME split from ledgers.udyam_number / msme_category — the split Schedule III
          makes mandatory for payables specifically, not receivables.
        </p>
      </div>
      <table className="w-full min-w-[860px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Particulars</th>
            {PAYABLE_BUCKET_ORDER.map((b) => (
              <th key={b} className={th + " text-right"}>{b}</th>
            ))}
            <th className={th + " text-right"}>Total</th>
          </tr>
        </thead>
        <tbody>
          {["MSME", "Others"].map((seg) => {
            const row = payablePivot.bySegment.get(seg);
            const rowTotal = PAYABLE_BUCKET_ORDER.reduce((n, b) => n + (row?.get(b) ?? 0), 0);
            return (
              <tr key={seg} className="border-b border-border last:border-0">
                <td className={td}>{seg}</td>
                {PAYABLE_BUCKET_ORDER.map((b) => (
                  <td key={b} className={num}>{formatINR(row?.get(b) ?? 0, { showZero: true })}</td>
                ))}
                <td className={num + " font-medium"}>{formatINR(rowTotal, { showZero: true })}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border-strong bg-bg font-semibold">
            <td className="px-4 py-2.5">Total</td>
            {PAYABLE_BUCKET_ORDER.map((b, i) => (
              <td key={b} className={num}>{formatINR(payablePivot.totalsByBucket[i], { showZero: true })}</td>
            ))}
            <td className={num}>{formatINR(payablePivot.grandTotal, { showZero: true })}</td>
          </tr>
        </tfoot>
      </table>
    </ReportShell>
  );
}
