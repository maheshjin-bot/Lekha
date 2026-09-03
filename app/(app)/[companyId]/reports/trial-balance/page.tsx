import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod, periodRangeLabel } from "@/lib/utils/period";
import { readContext } from "@/lib/nav/context";
import { ReportShell, th, td, num } from "@/components/reports/ReportShell";
import {
  DrillHeadCell,
  DrillRow,
  drillHref,
  type DrillParams,
} from "@/components/reports/DrillLink";

export default async function TrialBalancePage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/trial-balance">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month")
    .eq("id", companyId)
    .maybeSingle();

  // Replaces the hand-rolled `defaultPeriod(month ?? 4, { from: sp.from, to:
  // sp.to })` this page used to do inline. With no `?fy=` in the URL it
  // resolves byte-for-byte the same dates (that is readContext's stated
  // contract), so no figure on this page moves; what it buys is one object
  // the drill links below can hand on intact instead of each of them
  // re-deriving the period from raw query params.
  const ctx = readContext(companyId, sp, company?.financial_year_start_month);

  // The FY start month, recovered from the context rather than re-read off
  // the company row: fyStart is by definition the first day of the financial
  // year, so its month IS the start month — and it has already been through
  // readContext's null/out-of-range normalisation, which a second
  // `?? 4` here would only duplicate and could drift from.
  const startMonth = Number(ctx.fyStart.slice(5, 7));

  // defaultPeriod owns the wording of the period caption, and its
  // "FY 2026-27 to date · …" form is only correct when the period really is
  // the untouched default. So compare against that bare default instead of
  // re-deriving the sentence here — an explicit `?from=`/`?to=` (including
  // one arriving from a drill) gets the plain range caption, exactly as it
  // did before.
  const bare = defaultPeriod(startMonth);
  const periodLabel =
    ctx.from === bare.from && ctx.to === bare.to
      ? bare.label
      : periodRangeLabel(ctx.from, ctx.to);

  // A `?branch=` arriving on this page (from a branch-scoped screen, or from
  // another report drilling in) is now actually applied rather than silently
  // ignored — get_trial_balance has taken p_branch_id since 0009, this page
  // just never passed it. The name is looked up only when one is set so the
  // caption can say which branch these figures are for; a filter that changes
  // every number on screen with nothing on screen to say so is the exact
  // failure mode the drill work is meant to remove, not introduce.
  const { data: branch } = ctx.branchId
    ? await supabase
        .from("branches")
        .select("name")
        .eq("id", ctx.branchId)
        .eq("company_id", companyId)
        .maybeSingle()
    : { data: null };
  const branchLabel = ctx.branchId ? ` · ${branch?.name ?? "Unknown branch"}` : "";

  const { data: rows, error } = await supabase.rpc("get_trial_balance", {
    p_company_id: companyId,
    p_from: ctx.from,
    p_to: ctx.to,
    // `?? undefined` and not `?? null`: the generated arg type is
    // `p_branch_id?: string`, and omitting the key lets Postgres apply the
    // function's own `default null` — the "all branches" case.
    p_branch_id: ctx.branchId ?? undefined,
  });

  const totals = (rows ?? []).reduce(
    (acc, r) => ({
      dr: acc.dr + Number(r.period_debit ?? 0),
      cr: acc.cr + Number(r.period_credit ?? 0),
      cdr: acc.cdr + Number(r.closing_debit ?? 0),
      ccr: acc.ccr + Number(r.closing_credit ?? 0),
    }),
    { dr: 0, cr: 0, cdr: 0, ccr: 0 }
  );

  const tallied = Math.abs(totals.cdr - totals.ccr) < 0.005;

  const statementHref = `/${companyId}/reports/ledger-statement`;

  return (
    <ReportShell
      title="Trial Balance"
      period={periodLabel + branchLabel}
      status={{
        label: tallied
          ? "Tallied"
          : `Out by ${formatINR(Math.abs(totals.cdr - totals.ccr), { showZero: true })}`,
        tone: tallied ? "ok" : "bad",
      }}
    >
      {error && (
        <p className="m-4 rounded-lg bg-error-soft px-3 py-2 text-sm text-error">
          {error.message}
        </p>
      )}
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr>
            <th className={th}>Ledger</th>
            <th className={th}>Group</th>
            <th className={th + " text-right"}>Debit</th>
            <th className={th + " text-right"}>Credit</th>
            <th className={th + " text-right"}>Closing Dr</th>
            <th className={th + " text-right"}>Closing Cr</th>
            {/* One per DrillRow trailing cell, or the column count is off by
                one and the hairline borders stop lining up. */}
            <DrillHeadCell />
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-ink-faint">
                Nothing posted in this period.
              </td>
            </tr>
          )}
          {(rows ?? []).map((r) => {
            // The period is pinned EXPLICITLY rather than left to `carry`,
            // even though this report does keep its period in ?from/?to and
            // carrying alone would usually work. Two reasons, and both are
            // the reason this chain exists:
            //
            //   - on the bare default URL there is no ?from/?to to carry, so
            //     the statement would fall back to its OWN "FY to date"
            //     default. That is normally the same window — but it is
            //     recomputed against "today", so a drill clicked either side
            //     of midnight, or after the 1 April rollover, would open a
            //     different period than the row it came from;
            //   - what the user clicked is a figure for a stated window. The
            //     link should reproduce that window, not re-derive one.
            //
            // `carry={sp}` is still passed underneath: params win over carry
            // (DrillLink applies them second), so these three keys are fixed
            // while any future CARRIED_PARAM_KEY this page does not know
            // about is still forwarded rather than dropped.
            //
            // `branch: ctx.branchId` — null included — is deliberate too: it
            // CLEARS a carried branch when this report ran company-wide,
            // which is what happens when the URL carried an empty or repeated
            // ?branch= that readContext dropped but a blind carry would not.
            const drillParams: DrillParams = {
              ledger: r.ledger_id,
              from: ctx.from,
              to: ctx.to,
              branch: ctx.branchId,
            };

            return (
              <DrillRow
                key={r.ledger_id}
                href={statementHref}
                params={drillParams}
                carry={sp}
                label={r.ledger_name}
              >
                <td className={td + " font-medium"}>
                  {/* The wider click target of DrillLink's obligation (D):
                      the ledger name is what a reader actually aims at, and
                      drillHref guarantees the identical URL to the chevron.
                      Underline on hover only, not DaybookTable's always-on
                      `text-accent underline` — that styling marks an explicit
                      action link, and 200 permanently-underlined accent names
                      down a trial balance would read as noise, not structure. */}
                  <Link
                    href={drillHref(statementHref, drillParams, sp)}
                    className="rounded-sm underline-offset-4 outline-none hover:text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent/30"
                  >
                    {r.ledger_name}
                  </Link>
                </td>
                <td className={td + " text-ink-soft"}>{r.group_name}</td>
                <td className={num}>{formatINR(Number(r.period_debit))}</td>
                <td className={num}>{formatINR(Number(r.period_credit))}</td>
                <td className={num}>{formatINR(Number(r.closing_debit))}</td>
                <td className={num}>{formatINR(Number(r.closing_credit))}</td>
              </DrillRow>
            );
          })}
        </tbody>
        {(rows ?? []).length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg font-semibold">
              <td className="px-4 py-2.5" colSpan={2}>
                Total
              </td>
              <td className={num}>{formatINR(totals.dr, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.cr, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.cdr, { showZero: true })}</td>
              <td className={num}>{formatINR(totals.ccr, { showZero: true })}</td>
              {/* An empty trailing cell for the chevron column rather than
                  bumping the leading "Total" colSpan to 3 — that would slide
                  all four totals one column left, out from under the figures
                  they total. print:hidden to match the chevron column, which
                  does not exist on paper. */}
              <td className="px-4 py-2.5 print:hidden" />
            </tr>
          </tfoot>
        )}
      </table>
    </ReportShell>
  );
}
