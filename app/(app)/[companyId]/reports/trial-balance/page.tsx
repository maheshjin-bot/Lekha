import { defineReport } from "@/lib/reports/defineReport";
import { ReportView } from "@/components/reports/ReportView";
import type { DrillParams } from "@/components/reports/DrillLink";
import { createClient } from "@/lib/supabase/server";
import { readContext } from "@/lib/nav/context";
import { EquityCarriedNote, OpeningBalanceGap } from "@/components/reports/OpeningBalanceGap";
import type { OpeningGapRow } from "@/lib/reports/openingBalanceGap";

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
 *
 * ---------------------------------------------------------------------------
 * The opening-balance-gap explanation (0755 / 1350), added back around this
 * contract rather than inside it.
 * ---------------------------------------------------------------------------
 * Deviation #1 above already recorded that this migration lost the "Tallied /
 * Out by ₹X" status badge because ReportView never threads a `status` into
 * <ReportShell>. That same gap means <ReportView> has no hook a report
 * definition could use to render a banner explaining WHY a statement is out —
 * `defineReport`/`ReportView` are owned elsewhere and deliberately out of
 * scope to extend here (see that file's own header for the reasoning this
 * task inherited).
 *
 * So `TrialBalancePage` below stays on the defineReport/ReportView contract
 * completely unchanged, and wraps its return instead: a second, independent
 * `get_trial_balance` call (identical params to the definition's own
 * `source.params`) computes `tallied` the same way the pre-migration page did,
 * then <OpeningBalanceGap>/<EquityCarriedNote> render OUTSIDE <ReportView>'s
 * own <ReportShell> chrome, immediately above and below it. The visible
 * seam — this panel sits outside the report's card, where the Balance
 * Sheet's equivalent panel (app/(app)/[companyId]/reports/balance-sheet)
 * nests inside its own <ReportShell> — is the deliberate trade for not
 * touching shared report infrastructure two other reports already depend on.
 * A generic `status`/banner slot on <ReportShell>/<ReportView> remains a
 * separate, bigger decision for whoever owns that contract.
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
  const supabase = await createClient();

  // Same resolution <ReportView> performs internally (see its own header) —
  // duplicated here rather than threaded through, since ReportView has no
  // way to hand this page the AppContext it computed. financial_year_start_month
  // and the branch/from/to params both come from the exact same source, so
  // this cannot disagree with what <ReportView> below is about to render.
  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month")
    .eq("id", companyId)
    .maybeSingle();
  const ctx = readContext(companyId, sp, company?.financial_year_start_month);

  // A second, independent get_trial_balance call — identical params to the
  // definition's own `source.params` above — purely to recover the tallied/
  // out-of-balance fact ReportView's generic contract has nowhere to carry.
  // See the header comment block for why this cannot instead read the figure
  // out of <ReportView>'s own render.
  const { data: tbRows } = await supabase.rpc("get_trial_balance", {
    p_company_id: companyId,
    p_from: ctx.from,
    p_to: ctx.to,
    p_branch_id: ctx.branchId ?? undefined,
  });
  const totals = ((tbRows ?? []) as unknown as TrialBalanceRow[]).reduce(
    (acc, r) => ({
      cdr: acc.cdr + Number(r.closing_debit ?? 0),
      ccr: acc.ccr + Number(r.closing_credit ?? 0),
    }),
    { cdr: 0, ccr: 0 }
  );
  const tallied = Math.abs(totals.cdr - totals.ccr) < 0.005;

  // Why the difference, and what to do about it (0755 / 1350) — see the
  // Balance Sheet page's identical block for the full reasoning; this report
  // has no branch caveat to gate on (get_trial_balance is already
  // branch-filtered by ctx.branchId, and unlike the Balance Sheet this report
  // makes no separate "whole company" claim), so it explains any imbalance.
  const [{ data: gapRows }, { data: equity }, { data: membership }, { count: voucherCount }] =
    await Promise.all([
      tallied
        ? Promise.resolve({ data: null })
        : supabase.rpc("get_unbalanced_opening_balances", { p_company_id: companyId }),
      supabase
        .from("ledgers")
        .select("id, opening_balance_amount, opening_balance_type")
        .eq("company_id", companyId)
        .ilike("name", "opening balance equity")
        .maybeSingle(),
      tallied
        ? Promise.resolve({ data: null })
        : supabase.from("company_members").select("role").eq("company_id", companyId),
      tallied
        ? Promise.resolve({ count: null })
        : supabase
            .from("vouchers")
            .select("id", { count: "exact", head: true })
            .eq("company_id", companyId)
            .eq("is_deleted", false),
    ]);
  const isAdmin = (membership?.[0]?.role ?? null) === "admin";

  return (
    <>
      {!tallied && (
        <OpeningBalanceGap
          companyId={companyId}
          statement="Trial Balance"
          reportGap={totals.cdr - totals.ccr}
          rows={(gapRows ?? []) as unknown as OpeningGapRow[]}
          equity={equity ?? null}
          isAdmin={isAdmin}
          voucherCount={voucherCount ?? 0}
        />
      )}
      <ReportView definition={trialBalanceReport} companyId={companyId} searchParams={sp} />
      {tallied && <EquityCarriedNote companyId={companyId} equity={equity ?? null} />}
    </>
  );
}
