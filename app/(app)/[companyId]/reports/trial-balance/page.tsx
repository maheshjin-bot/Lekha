import { defineReport } from "@/lib/reports/defineReport";
import { ReportView } from "@/components/reports/ReportView";
import type { DrillParams } from "@/components/reports/DrillLink";

/**
 * Trial Balance, re-expressed as a `defineReport` definition and rendered
 * through the shared <ReportView> — the reference migration this wave's
 * other two report migrations are meant to copy. See lib/reports/defineReport.ts
 * and components/reports/ReportView.tsx for the contract this implements;
 * both were read in full before writing this file, and every choice below
 * (RPC name, param shape, column list, drill target/params) is copied
 * verbatim from what this page used to do by hand — nothing about what
 * get_trial_balance is called with, or how a figure is computed, changed.
 *
 * `Row` mirrors get_trial_balance's actual return shape (confirmed live via
 * `pg_get_function_result` before writing this), not just the columns shown
 * — `nature`/`opening_debit`/`opening_credit` are real fields the RPC
 * returns that this report has never displayed, kept on the type so a
 * future column addition does not need a second look at the RPC.
 *
 * ---------------------------------------------------------------------------
 * Known, verified deviations from the pre-migration page — not oversights.
 * ---------------------------------------------------------------------------
 * This task's file assignment is this page only; <ReportView> and
 * `defineReport` are owned elsewhere and out of scope to change here, and
 * neither currently has a hook for the three things below. Each is a
 * rendering-only loss (no figure changes), confirmed by reading both files
 * in full rather than assumed:
 *
 *   1. The "Tallied" / "Out by ₹X" status badge in the header. ReportView
 *      calls `<ReportShell title period width>` with no `status` — the prop
 *      exists on ReportShell but ReportView never threads a value into it.
 *   2. The <tfoot> totals row (Total Dr/Cr/Closing Dr/Cr). ReportView's
 *      renderer has no footer/totals concept at all — confirmed the same gap
 *      exists in sales-analysis, the contract's other reference report,
 *      which also loses its own tfoot under this same contract.
 *   3. The ledger name's own wider-click-target <Link> (in addition to the
 *      row's chevron). A `ReportColumn.render` receives only the row, not
 *      the nav context/company id a same-URL <Link> needs to build, so this
 *      per-cell enhancement has no equivalent in the generic column model.
 *   4. The " · <Branch Name>" suffix this page used to append to the period
 *      caption when `?branch=` narrowed the report. ReportView resolves
 *      `ctx.branchId` and passes it to `source.params` (so the RPC is still
 *      correctly branch-filtered — this is a caption-only loss, not a data
 *      one) but never looks the branch's name up or appends it to the
 *      `period` string it hands ReportShell.
 *
 * The chevron-based row drill (the thing that actually matters — a figure
 * that looks wrong is never more than one click from the ledger it came
 * from) is fully preserved; see `drill` below.
 */

type TrialBalanceRow = {
  ledger_id: string;
  ledger_name: string;
  group_name: string;
  nature: string;
  opening_debit: number;
  opening_credit: number;
  period_debit: number;
  period_credit: number;
  closing_debit: number;
  closing_credit: number;
};

const trialBalanceReport = defineReport<TrialBalanceRow>({
  // Must equal ReportShell's own reportConfigScope() for this route
  // ("/<companyId>/reports/trial-balance" -> "reports-trial-balance") — this
  // is the same screen_key the report's gear (and Ctrl+L saved views) reads
  // and writes under.
  key: "reports-trial-balance",
  title: "Trial Balance",
  source: {
    rpc: "get_trial_balance",
    params: (ctx) => ({
      p_company_id: ctx.companyId,
      p_from: ctx.from,
      p_to: ctx.to,
      // `?? undefined`, not `?? null`: the generated arg type is
      // `p_branch_id?: string`, and omitting the key lets Postgres apply the
      // function's own `default null` — the "all branches" case. Identical
      // to what this page passed by hand before migrating.
      p_branch_id: ctx.branchId ?? undefined,
    }),
  },
  columns: [
    { key: "ledger_name", label: "Ledger", hideable: false },
    {
      key: "group_name",
      label: "Group",
      // Escape hatch for the one column that isn't a plain format-the-field
      // job: the original page rendered this in text-ink-soft, not the
      // default row text color.
      render: (row) => <span className="text-ink-soft">{row.group_name}</span>,
    },
    { key: "period_debit", label: "Debit", format: "currency" },
    { key: "period_credit", label: "Credit", format: "currency" },
    // Totals-critical (this report's own tallied/balanced check sums these
    // two), so not eligible for the gear's future "hidden columns" affordance.
    { key: "closing_debit", label: "Closing Dr", format: "currency", hideable: false },
    { key: "closing_credit", label: "Closing Cr", format: "currency", hideable: false },
  ],
  // Every row's chevron opens the ledger statement for exactly the window on
  // screen. `from`/`to` are pinned from `app` explicitly rather than left to
  // ReportView's automatic `carry`, for the same reason the original page
  // did: on the bare default URL there is no ?from/?to to carry, so the
  // statement would otherwise re-derive its own "FY to date" default against
  // "today" rather than reproducing the window the user is actually looking
  // at. `branch: app.branchId` (null included) likewise clears a carried
  // branch when this report ran company-wide. ReportView applies `carry`
  // (the page's own searchParams) underneath this automatically, so any
  // other ambient param is still forwarded.
  drill: (row, { companyId, app }) => ({
    href: `/${companyId}/reports/ledger-statement`,
    params: {
      ledger: row.ledger_id,
      from: app.from,
      to: app.to,
      branch: app.branchId,
    } satisfies DrillParams,
    label: row.ledger_name,
  }),
});

export default async function TrialBalancePage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/trial-balance">) {
  const { companyId } = await params;
  const sp = await searchParams;

  return <ReportView definition={trialBalanceReport} companyId={companyId} searchParams={sp} />;
}
