import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod, comparativePeriod, periodRangeLabel } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

type PLRow = { nature: string; group_name: string; ledger_name: string; ledger_role: string; amount: number };

// Schedule III Division I/II's Statement of Profit and Loss "Expenses"
// break-up, in the Schedule's own order (confirmed live against Schedule
// III's bare-act text — see migration 0210). ledger_role is
// coalesce(ledger override, group default) from get_profit_and_loss, so
// every direct_expense/indirect_expense row lands in exactly one of these
// eight buckets — the eighth, tax_expense, is deliberately NOT one of the
// seven Schedule III heads (rendered separately below, not in this array).
const SCHEDULE_III_EXPENSE_HEADS: { role: string; label: string }[] = [
  { role: "cost_of_materials", label: "Cost of Materials Consumed" },
  { role: "purchases_stock_in_trade", label: "Purchases of Stock-in-Trade" },
  {
    role: "changes_in_inventories",
    label: "Changes in Inventories of Finished Goods, Work-in-Progress and Stock-in-Trade",
  },
  { role: "employee_benefits", label: "Employee Benefits Expense" },
  { role: "finance_costs", label: "Finance Costs" },
  { role: "depreciation_amortisation", label: "Depreciation and Amortisation Expense" },
  { role: "other_expenses", label: "Other Expenses" },
];

/** curr - comp as a signed percentage of |comp|, or null when there is
 * nothing to divide by — a brand-new line (comp undefined) or a comp that
 * nets to exactly zero. Rendered as an em dash rather than "Infinity%" or
 * a fake 0%, neither of which would describe what actually happened. */
function variancePct(curr: number, comp: number | undefined): number | null {
  if (comp === undefined || comp === 0) return null;
  return ((curr - comp) / Math.abs(comp)) * 100;
}

function formatVariance(pct: number | null): string {
  if (pct === null) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

// Declared at module scope, not inside the page component: both the simple
// and schedule_iii layouts below reuse this for a different nature each, and
// a component re-created on every render (react-hooks/static-components)
// would multiply with each additional call site instead of staying fixed.
//
// `items` carries the CURRENT period's rows (as get_profit_and_loss already
// returns them: zero-balance ledgers excluded, so a ledger with nothing
// posted this period never appears here). `compByLedger` is the comparative
// period's amounts keyed by ledger_name for the same nature. The two are not
// the same ledger set in general — a ledger can have posted last period and
// not this one (comp-only) or vice versa (curr-only, the common case) — so
// the row list actually rendered is the UNION of both, with the missing side
// showing as nil (formatINR(0) prints "—" already, matching how this report
// treats any nil figure elsewhere). Without the union, a ledger that zeroed
// out this period would silently disappear from the comparative TOTAL too,
// understating the prior period's real total.
function Block({
  label,
  items,
  compByLedger,
  hasComparative,
}: {
  label: string;
  items: PLRow[];
  compByLedger: Map<string, { group_name: string; amount: number }>;
  hasComparative: boolean;
}) {
  const currLedgers = new Set(items.map((r) => r.ledger_name));
  const compOnly = hasComparative
    ? [...compByLedger.entries()]
        .filter(([ledgerName]) => !currLedgers.has(ledgerName))
        .map(([ledger_name, v]) => ({ ledger_name, group_name: v.group_name, amount: 0, compOnly: true }))
    : [];
  const rows = [...items.map((r) => ({ ...r, compOnly: false })), ...compOnly];
  if (rows.length === 0) return null;

  const currTotal = items.reduce((n, r) => n + Number(r.amount), 0);
  const compTotal = hasComparative
    ? rows.reduce((n, r) => n + (compByLedger.get(r.ledger_name)?.amount ?? 0), 0)
    : undefined;

  return (
    <>
      <tr className="bg-bg">
        <td className={td + " font-semibold"} colSpan={2}>
          {label}
        </td>
        <td className={num + " font-semibold"}>{formatINR(currTotal, { showZero: true })}</td>
        <td className={num + " font-semibold"}>
          {hasComparative ? formatINR(compTotal ?? 0, { showZero: true }) : "—"}
        </td>
        <td className={num + " font-semibold text-ink-soft"}>
          {hasComparative ? formatVariance(variancePct(currTotal, compTotal)) : "—"}
        </td>
      </tr>
      {rows.map((r, i) => {
        const comp = compByLedger.get(r.ledger_name)?.amount;
        return (
          <tr key={i} className="border-b border-border">
            <td className={td + " pl-8"}>{r.ledger_name}</td>
            <td className={td + " text-ink-soft "}>{r.group_name}</td>
            <td className={num}>{formatINR(Number(r.amount))}</td>
            <td className={num + " text-ink-soft"}>{hasComparative ? formatINR(comp ?? 0) : "—"}</td>
            <td className={num + " text-ink-faint"}>{hasComparative ? formatVariance(variancePct(Number(r.amount), comp)) : "—"}</td>
          </tr>
        );
      })}
    </>
  );
}

export default async function ProfitLossPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/profit-loss">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  // Same RPC the Balance Sheet report now uses for entity-type-driven
  // display (app/(app)/[companyId]/reports/balance-sheet/page.tsx): one call
  // resolves the company against its ref_entity_types rule row, so
  // statement_format and financial_year_start_month come back together.
  const { data: profile } = await supabase.rpc("get_company_profile", {
    p_company_id: companyId,
  });
  const company = profile?.[0];
  // Fail safe to 'simple' on any lookup miss — a report page must render,
  // never crash, over a profile it couldn't resolve.
  const scheduleIII = company?.statement_format === "schedule_iii";
  const startMonth = company?.financial_year_start_month ?? 4;

  const period = defaultPeriod(startMonth, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  // Schedule III General Instruction 1 requires a previous-year column on
  // any filed set of accounts — not optional decoration, though it is also
  // useful for simple-mode companies, so it is rendered for both. See
  // lib/utils/period.ts:comparativePeriod for the two date rules (full FY
  // vs a same-length preceding window for a custom range).
  const comparative = comparativePeriod(period.from, period.to, startMonth);

  const [{ data: branches }, { data: companyRow }] = await Promise.all([
    supabase
      .from("branches")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false }),
    supabase.from("companies").select("book_beginning_date").eq("id", companyId).single(),
  ]);
  const branchId = typeof sp.branch === "string" ? sp.branch : undefined;
  const bookBeginning = companyRow?.book_beginning_date as string | undefined;

  // A first-year company has no prior period at all — the comparative range
  // ends entirely before the books began, so get_profit_and_loss would
  // legitimately return zero rows there. Zero rows and "no data available"
  // both sum to 0, and showing that 0 next to a real current-period figure
  // reads as a genuine flat prior year, not as "this company didn't exist
  // yet". So the comparative RPC call is only made — and the whole column
  // only rendered as figures rather than em dashes — when the comparative
  // period's own end date reaches at least as far as book_beginning_date.
  // (String comparison is safe here: both sides are YYYY-MM-DD.)
  const hasComparative = !!bookBeginning && comparative.to >= bookBeginning;
  // True only when the comparative window starts before the books did but
  // still ends inside them — a genuine partial first year, not "no data".
  // Surfaced to the reader as a caption below rather than silently comparing
  // a full period against a partial one.
  const partialComparative = hasComparative && !!bookBeginning && comparative.from < bookBeginning;

  const [{ data: rows }, { data: compRows }] = await Promise.all([
    supabase.rpc("get_profit_and_loss", {
      p_company_id: companyId,
      p_from: period.from,
      p_to: period.to,
      p_branch_id: branchId,
    }),
    hasComparative
      ? supabase.rpc("get_profit_and_loss", {
          p_company_id: companyId,
          p_from: comparative.from,
          p_to: comparative.to,
          p_branch_id: branchId,
        })
      : Promise.resolve({ data: [] as PLRow[] }),
  ]);

  // `as PLRow[]`: ledger_role (migration 0210) is not yet reflected in
  // types/database.types.ts, which this task does not own — regenerating it
  // is the integration pass's job (same transient state 0089 left for
  // get_balance_sheet's own ledger_role column until its own regen landed).
  const all: PLRow[] = (rows ?? []) as PLRow[];
  const compAll: PLRow[] = (compRows ?? []) as PLRow[];
  const sum = (source: PLRow[], natures: string[]) =>
    source.filter((r) => natures.includes(r.nature)).reduce((n, r) => n + Number(r.amount), 0);

  // Gross profit is the trading account: direct income less direct expense.
  // Net profit then carries that through the indirect items. Schedule III
  // has no "Gross Profit" concept (it is a trading-account idea, not a
  // Schedule III line item) but its own Total Income - Total Expenses lands
  // on exactly the same figure as netProfit — direct_income + indirect_income
  // - direct_expense - indirect_expense either way — so it is reused as
  // Profit Before Tax below rather than recomputed.
  const grossProfit = sum(all, ["direct_income"]) - sum(all, ["direct_expense"]);
  const netProfit = grossProfit + sum(all, ["indirect_income"]) - sum(all, ["indirect_expense"]);
  const totalIncome = sum(all, ["direct_income", "indirect_income"]);
  const totalExpenses = sum(all, ["direct_expense", "indirect_expense"]);

  // Same three figures, independently re-derived from the comparative RPC
  // call's own rows — not from the rendered table rows, so a ledger that
  // dropped to zero this period (and so is folded into a Block's "comp
  // only" union rather than iterated as a `curr` row) still counts here.
  const compGrossProfit = sum(compAll, ["direct_income"]) - sum(compAll, ["direct_expense"]);
  const compNetProfit =
    compGrossProfit + sum(compAll, ["indirect_income"]) - sum(compAll, ["indirect_expense"]);
  const compTotalIncome = sum(compAll, ["direct_income", "indirect_income"]);
  const compTotalExpenses = sum(compAll, ["direct_expense", "indirect_expense"]);

  const section = (nature: string) => all.filter((r) => r.nature === nature);
  const compSection = (nature: string) => {
    const m = new Map<string, { group_name: string; amount: number }>();
    for (const r of compAll.filter((x) => x.nature === nature)) {
      m.set(r.ledger_name, { group_name: r.group_name, amount: Number(r.amount) });
    }
    return m;
  };

  // Schedule III expense-head grouping (0210): flattens BOTH direct_expense
  // and indirect_expense nature rows by ledger_role, since Schedule III
  // itself has no Direct/Indirect distinction — that split is this app's
  // own trading-account convention, not a Schedule III concept. Only
  // expense-nature rows carry a Schedule III head; income rows are untouched
  // (still grouped by nature above) and never matched by headSection.
  const headSection = (role: string) => all.filter((r) => r.ledger_role === role);
  const compHeadSection = (role: string) => {
    const m = new Map<string, { group_name: string; amount: number }>();
    for (const r of compAll.filter((x) => x.ledger_role === role)) {
      m.set(r.ledger_name, { group_name: r.group_name, amount: Number(r.amount) });
    }
    return m;
  };

  const selectedBranch = (branches ?? []).find((b) => b.id === branchId);

  return (
    <ReportShell
      title="Profit &amp; Loss"
      period={period.label}
      status={{
        label: netProfit >= 0 ? "Profit" : "Loss",
        tone: netProfit >= 0 ? "ok" : "bad",
      }}
    >
      {(branches ?? []).length > 1 && (
        <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2.5 text-sm">
          <Link
            href="?"
            className={
              "rounded-md border px-2.5 py-1 " +
              (!branchId
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong hover:bg-surface-2")
            }
          >
            All branches
          </Link>
          {(branches ?? []).map((b) => (
            <Link
              key={b.id}
              href={`?branch=${b.id}`}
              className={
                "rounded-md border px-2.5 py-1 " +
                (branchId === b.id
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-strong hover:bg-surface-2")
              }
            >
              {b.name}
            </Link>
          ))}
        </div>
      )}
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Particulars</th>
            <th className={th}>Group</th>
            <th className={th + " text-right"}>{periodRangeLabel(period.from, period.to)}</th>
            <th className={th + " text-right"}>
              {hasComparative ? periodRangeLabel(comparative.from, comparative.to) : "Previous period"}
            </th>
            <th className={th + " text-right"}>Change</th>
          </tr>
        </thead>
        <tbody>
          {all.length === 0 && compAll.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-12 text-center text-ink-faint">
                No income or expense posted in this period.
              </td>
            </tr>
          )}
          {scheduleIII ? (
            <>
              {/* Schedule III's own ordering: both income blocks together
                  under Total Income, then both expense blocks together under
                  Total Expenses — direct_income/direct_expense are the same
                  underlying nature values as the simple format, only
                  relabelled and reordered for display. */}
              <Block
                label="Revenue from Operations"
                items={section("direct_income")}
                compByLedger={compSection("direct_income")}
                hasComparative={hasComparative}
              />
              <Block
                label="Other Income"
                items={section("indirect_income")}
                compByLedger={compSection("indirect_income")}
                hasComparative={hasComparative}
              />
              {(all.length > 0 || compAll.length > 0) && (
                <tr className="border-y-2 border-border-strong bg-surface-2">
                  <td className={td + " font-semibold"} colSpan={2}>
                    Total Income
                  </td>
                  <td className={num + " font-semibold"}>
                    {formatINR(totalIncome, { showZero: true })}
                  </td>
                  <td className={num + " font-semibold"}>
                    {hasComparative ? formatINR(compTotalIncome, { showZero: true }) : "—"}
                  </td>
                  <td className={num + " font-semibold text-ink-soft"}>
                    {hasComparative ? formatVariance(variancePct(totalIncome, compTotalIncome)) : "—"}
                  </td>
                </tr>
              )}
              {/* Schedule III's own seven-head "Expenses" break-up (0210),
                  in the Schedule's own order — flattened across both
                  direct_expense and indirect_expense nature, since Schedule
                  III itself draws no Direct/Indirect line. */}
              {SCHEDULE_III_EXPENSE_HEADS.map(({ role, label }) => (
                <Block
                  key={role}
                  label={label}
                  items={headSection(role)}
                  compByLedger={compHeadSection(role)}
                  hasComparative={hasComparative}
                />
              ))}
              {/* tax_expense (0210): deliberately NOT one of the seven heads
                  above — Schedule III shows tax as its own section below
                  Profit before tax — but still totalled into Total Expenses
                  below, since this schema nets Deferred Tax Expense into the
                  indirect_expense nature (a pre-existing, out-of-scope
                  decision; see 0210's header). Shown as its own captioned
                  line rather than silently folded into Other Expenses. */}
              <Block
                label="Tax Expense (shown separately — not one of the seven expense heads above)"
                items={headSection("tax_expense")}
                compByLedger={compHeadSection("tax_expense")}
                hasComparative={hasComparative}
              />
              {(all.length > 0 || compAll.length > 0) && (
                <tr className="border-y-2 border-border-strong bg-surface-2">
                  <td className={td + " font-semibold"} colSpan={2}>
                    Total Expenses
                  </td>
                  <td className={num + " font-semibold"}>
                    {formatINR(totalExpenses, { showZero: true })}
                  </td>
                  <td className={num + " font-semibold"}>
                    {hasComparative ? formatINR(compTotalExpenses, { showZero: true }) : "—"}
                  </td>
                  <td className={num + " font-semibold text-ink-soft"}>
                    {hasComparative ? formatVariance(variancePct(totalExpenses, compTotalExpenses)) : "—"}
                  </td>
                </tr>
              )}
            </>
          ) : (
            <>
              <Block
                label="Direct Income"
                items={section("direct_income")}
                compByLedger={compSection("direct_income")}
                hasComparative={hasComparative}
              />
              <Block
                label="Direct Expenses"
                items={section("direct_expense")}
                compByLedger={compSection("direct_expense")}
                hasComparative={hasComparative}
              />
              {(all.length > 0 || compAll.length > 0) && (
                <tr className="border-y-2 border-border-strong bg-surface-2">
                  <td className={td + " font-semibold"} colSpan={2}>
                    Gross Profit
                  </td>
                  <td className={num + " font-semibold"}>
                    {formatINR(grossProfit, { showZero: true })}
                  </td>
                  <td className={num + " font-semibold"}>
                    {hasComparative ? formatINR(compGrossProfit, { showZero: true }) : "—"}
                  </td>
                  <td className={num + " font-semibold text-ink-soft"}>
                    {hasComparative ? formatVariance(variancePct(grossProfit, compGrossProfit)) : "—"}
                  </td>
                </tr>
              )}
              <Block
                label="Indirect Income"
                items={section("indirect_income")}
                compByLedger={compSection("indirect_income")}
                hasComparative={hasComparative}
              />
              <Block
                label="Indirect Expenses"
                items={section("indirect_expense")}
                compByLedger={compSection("indirect_expense")}
                hasComparative={hasComparative}
              />
            </>
          )}
        </tbody>
        {(all.length > 0 || compAll.length > 0) && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg">
              <td className="px-4 py-3 font-semibold" colSpan={2}>
                {scheduleIII ? "Profit Before Tax" : netProfit >= 0 ? "Net Profit" : "Net Loss"}
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums font-mono">
                {scheduleIII
                  ? formatINR(netProfit, { showZero: true })
                  : formatINR(Math.abs(netProfit), { showZero: true })}
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums font-mono">
                {hasComparative
                  ? scheduleIII
                    ? formatINR(compNetProfit, { showZero: true })
                    : formatINR(Math.abs(compNetProfit), { showZero: true })
                  : "—"}
              </td>
              <td className="px-4 py-3 text-right font-semibold tabular-nums font-mono text-ink-soft">
                {hasComparative ? formatVariance(variancePct(netProfit, compNetProfit)) : "—"}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
      {selectedBranch && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          Showing {selectedBranch.name} only — income and expense lines posted directly
          to this branch. If any voucher ever splits its own lines across more than one
          branch (uncommon; every voucher in this company today stays within one), this
          branch&rsquo;s own total can differ from its share of the whole-company figure.
        </p>
      )}
      {!hasComparative && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          No previous-period column: the comparative period
          ({periodRangeLabel(comparative.from, comparative.to)}) ends before this
          company&rsquo;s books began ({bookBeginning ?? "unknown"}), so there is no prior
          data to compare against. This is expected for a company&rsquo;s first reporting
          period.
        </p>
      )}
      {partialComparative && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          The previous-period column only partially overlaps this company&rsquo;s
          book-keeping — books began {bookBeginning} but the comparative period
          starts {comparative.from}. Figures shown are real, just for a shorter
          span than the current period.
        </p>
      )}
      {scheduleIII && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          Expenses above are classified by ledger group, defaulting to Cost
          of Materials Consumed (Direct Expenses) and Other Expenses
          (Indirect Expenses) unless a ledger has been moved into one of the
          dedicated Schedule III sub-groups (Purchases of Stock-in-Trade,
          Employee Benefits Expense, Finance Costs, Depreciation and
          Amortisation Expense) — so a newly-posted ledger can land under a
          broader head than its true nature until it is reclassified.
          Schedule III also requires each head to cross-reference a
          supporting note (e.g. an Employee Benefits break-up of salaries,
          PF contribution, and staff welfare); this report shows head totals
          only, not that note-level detail. Profit for the year (after tax)
          is not shown here; see the Income Tax report for a separate
          estimate.
        </p>
      )}
    </ReportShell>
  );
}
