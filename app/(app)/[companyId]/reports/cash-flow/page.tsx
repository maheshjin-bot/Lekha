import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod, periodRangeLabel } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

type CfsRow = {
  step: number;
  section: "operating" | "investing" | "financing" | "reconciliation";
  line_item: string;
  label: string;
  amount: number;
};

// Sub-lines that read as an addition/reduction to the section subtotal
// above them, indented and lighter — the subtotal and reconciliation rows
// stay full-weight. Kept as a static set rather than inferred from
// line_item naming, so a future line added to the RPC defaults to a plain
// (not indented) row unless explicitly listed here.
const DETAIL_LINES = new Set([
  "net_profit_before_tax",
  "depreciation_addback",
  "wc_current_assets",
  "wc_current_liabilities",
  "investing_tangible",
  "investing_intangible",
  "investing_cwip",
  "investing_investments",
  "financing_capital",
  "financing_loan_funds",
]);

const SUBTOTAL_LINES = new Set([
  "cash_from_operating",
  "cash_from_investing",
  "cash_from_financing",
]);

function Row({ row }: { row: CfsRow }) {
  const isSubtotal = SUBTOTAL_LINES.has(row.line_item);
  const isDetail = DETAIL_LINES.has(row.line_item);
  return (
    <tr className={isSubtotal ? "border-y border-border bg-surface-2" : undefined}>
      <td className={td + (isDetail ? " pl-8 text-ink-soft" : " font-medium") + (isSubtotal ? " font-semibold" : "")}>
        {row.label}
      </td>
      <td className={num + (isSubtotal ? " font-semibold" : "")}>
        {formatINR(row.amount, { showZero: true })}
      </td>
    </tr>
  );
}

export default async function CashFlowStatementPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/cash-flow">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  // Same profile RPC the Balance Sheet and Profit & Loss reports already
  // use for entity-type-driven display — one call resolves
  // financial_year_start_month alongside entity_type, which is all this
  // page needs to decide the default period and the OPC exemption note.
  const [{ data: profile }, { data: companyRow }] = await Promise.all([
    supabase.rpc("get_company_profile", { p_company_id: companyId }),
    supabase.from("companies").select("book_beginning_date").eq("id", companyId).single(),
  ]);
  const company = profile?.[0];
  const startMonth = company?.financial_year_start_month ?? 4;
  const bookBeginning = companyRow?.book_beginning_date as string | undefined;

  const period = defaultPeriod(startMonth, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  const { data: rows, error } = await supabase.rpc("get_cash_flow_statement", {
    p_company_id: companyId,
    p_period_start: period.from,
    p_period_end: period.to,
  });

  const all = ((rows ?? []) as CfsRow[]).sort((a, b) => a.step - b.step);
  const bySection = (s: CfsRow["section"]) => all.filter((r) => r.section === s);
  const byLineItem = (k: string) => all.find((r) => r.line_item === k)?.amount ?? 0;

  const netChange = byLineItem("net_change_in_cash");
  const reconciliationDiff = byLineItem("reconciliation_difference");
  const reconciles = Math.abs(Number(reconciliationDiff)) < 0.005;

  // The day before the period start is the RPC's own "opening" snapshot
  // date (get_cash_flow_statement, 0100) — shown here only to explain the
  // opening-cash figure, not sent anywhere.
  const openingAsAt = (() => {
    const d = new Date(`${period.from}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const opensBeforeBooksBegan = !!bookBeginning && openingAsAt < bookBeginning;
  // This used to be the WHOLE test for the footnote below, on the assumption
  // that no company could have ledger activity dated before its own declared
  // book_beginning_date. That assumption is not enforced anywhere in this
  // schema — there is no CHECK constraint or trigger tying voucher_date to
  // book_beginning_date (confirmed live: 0003 only constrains lock_date
  // against it), so a voucher dated before a company's declared book start
  // is perfectly possible today, and get_balance_sheet (which
  // get_cash_flow_statement's opening snapshot is built on) has never
  // filtered by it either — by design, per 0089's own header, it reads every
  // dated voucher unconditionally. Nexgen Softwares Private Limited hit
  // exactly this: a receipt voucher dated 2025-12-15, before its 2026-04-01
  // book-start date, left the opening cash figure genuinely non-zero (real
  // money, really posted) while this footnote asserted "correctly zero"
  // regardless — the report contradicting its own table directly above it.
  // So the claim is now checked against the actual number the RPC returned,
  // not assumed from the dates alone.
  const openingCashAndBank = Number(byLineItem("opening_cash_and_bank"));
  const openingCashIsActuallyZero = Math.abs(openingCashAndBank) < 0.005;

  return (
    <ReportShell
      title="Cash Flow Statement"
      period={period.label}
      status={
        error
          ? { label: "Error", tone: "bad" }
          : { label: reconciles ? "Reconciles" : "Does not reconcile", tone: reconciles ? "ok" : "bad" }
      }
    >
      {error && (
        <div className="m-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-900">
          Could not compute this statement: {error.message}
        </div>
      )}
      {!error && (
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Particulars</th>
              <th className={th + " text-right"}>{periodRangeLabel(period.from, period.to)}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={td + " bg-bg font-semibold"} colSpan={2}>
                A. Cash Flow from Operating Activities
              </td>
            </tr>
            {bySection("operating").map((r) => (
              <Row key={r.line_item} row={r} />
            ))}

            <tr>
              <td className={td + " bg-bg font-semibold"} colSpan={2}>
                B. Cash Flow from Investing Activities
              </td>
            </tr>
            {bySection("investing").map((r) => (
              <Row key={r.line_item} row={r} />
            ))}

            <tr>
              <td className={td + " bg-bg font-semibold"} colSpan={2}>
                C. Cash Flow from Financing Activities
              </td>
            </tr>
            {bySection("financing").map((r) => (
              <Row key={r.line_item} row={r} />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg">
              <td className="px-4 py-3 font-semibold">Net increase/(decrease) in cash and cash equivalents (A+B+C)</td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums font-mono">
                {formatINR(netChange, { showZero: true })}
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2 text-ink-soft">Cash and cash equivalents at the beginning of the period</td>
              <td className="px-4 py-2 text-right tabular-nums font-mono text-ink-soft">
                {formatINR(byLineItem("opening_cash_and_bank"), { showZero: true })}
              </td>
            </tr>
            <tr>
              <td className="px-4 py-2 text-ink-soft">Cash and cash equivalents at the end of the period</td>
              <td className="px-4 py-2 text-right tabular-nums font-mono text-ink-soft">
                {formatINR(byLineItem("closing_cash_and_bank"), { showZero: true })}
              </td>
            </tr>
            {!reconciles && (
              <tr>
                <td className="px-4 py-2 font-semibold text-error">
                  Reconciliation difference (should be nil)
                </td>
                <td className="px-4 py-2 text-right font-semibold tabular-nums font-mono text-error">
                  {formatINR(Number(reconciliationDiff), { showZero: true })}
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      )}

      <div className="space-y-3 border-t border-border px-4 py-3 text-xs text-ink-faint">
        <p>
          Prepared under AS 3 / Ind AS 7 (indirect method). This app has no
          net-worth or listing flag to determine which of the two standards
          this company must actually follow, and both prescribe the same
          structure — profit before tax, adjusted for non-cash items and
          working-capital movements, then Investing, then Financing,
          reconciled to cash and cash equivalents — so both are named rather
          than one being silently assumed. Where the two standards genuinely
          differ (Ind AS 7 folds on-demand bank overdrafts into cash
          equivalents and fixes interest/dividend classification; AS 3 asks
          for extraordinary items to be separately flagged) this report does
          not distinguish, because nothing in this schema tags a posting as
          interest, a dividend, an overdraft, or extraordinary.
        </p>
        <p>
          This is an approximation built from ledger balances at two dates,
          not a transaction-tagged cash flow — LEKHA does not mark individual
          vouchers as operating, investing or financing. A period with both a
          purchase and a disposal within the same fixed-asset line nets to a
          smaller figure here than a line-item cash flow would show; the
          totals below still reconcile exactly (see the status badge above),
          only the presentation within a line is coarser.
        </p>
        <p>
          &ldquo;Financing Activities&rdquo; above also carries the movement
          in Deferred Tax Liabilities and Long-term Provisions, alongside
          capital, reserves and borrowings — AS 3&rsquo;s textbook treatment
          would show a deferred-tax movement as a non-cash operating
          adjustment instead, but this schema has no way to tell a real
          long-term borrowing drawn down from a non-cash deferred-tax entry
          within the same non-current-liability figures it reads, so both
          are grouped together here rather than one being guessed at. The
          statement still reconciles exactly either way (see the status
          badge above) — only which section a non-cash movement is shown
          under is affected, never the bottom line.
        </p>
        <p>
          &ldquo;Net profit before tax&rdquo; above is net profit exactly as
          the Profit &amp; Loss report computes it. This app has no
          income-tax-expense ledger convention, so it is honestly
          &ldquo;before tax&rdquo; only for a company that has never posted
          its own income-tax provision as an ordinary expense ledger.
        </p>
        <p>
          Sec 2(40), Companies Act 2013 (proviso inserted by MCA notification
          dated 13 Jun 2017) exempts a One Person Company, a small company
          and a dormant company from having to include a cash flow statement
          in their financial statements at all. This app does not track
          paid-up capital, turnover or Sec 455 dormancy status, so it cannot
          tell you whether your company qualifies — it shows this report
          unconditionally and leaves that judgement to you.
          {company?.entity_type === "opc" && (
            <> This company is registered as a One Person Company, which this exemption names directly.</>
          )}
        </p>
        {opensBeforeBooksBegan && openingCashIsActuallyZero && (
          <p>
            The opening balance sheet snapshot ({openingAsAt}) falls before
            this company&rsquo;s books began ({bookBeginning}), and the Cash
            and cash equivalents figure at the beginning of the period above
            is indeed zero — this is a first-year statement, not a data gap.
          </p>
        )}
        {opensBeforeBooksBegan && !openingCashIsActuallyZero && (
          <p>
            The opening balance sheet snapshot ({openingAsAt}) falls before
            this company&rsquo;s declared book-start date ({bookBeginning}),
            but the Cash and cash equivalents figure at the beginning of the
            period above is <strong>not</strong> zero. This company&rsquo;s
            books already contain at least one voucher dated before its own
            declared book-start date, and this report includes it exactly as
            it includes every other dated voucher — LEKHA does not currently
            restrict, warn on, or exclude vouchers dated before a
            company&rsquo;s book-start date when computing any report
            (a separate, deliberate gap, not something this statement
            attempts to correct). The opening figures above reflect what is
            actually posted, not what the declared book-start date alone
            would imply.
          </p>
        )}
      </div>
    </ReportShell>
  );
}
