import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod, financialYearStart } from "@/lib/utils/period";
import { cn } from "@/lib/utils/cn";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { DrillRow } from "@/components/reports/DrillLink";

const NATURE_LABEL: Record<string, string> = {
  capital: "Capital Account",
  share_capital: "Share Capital",
  reserves_surplus: "Reserves and Surplus",
  current_liability: "Current Liabilities",
  non_current_liability: "Non-current Liabilities",
  long_term_borrowing: "Long-term Borrowings",
  deferred_tax: "Deferred Tax Liabilities (Net)",
  long_term_provision: "Long-term Provisions",
  current_asset: "Current Assets",
  fixed_asset: "Fixed Assets",
};

// Schedule III's own structural order — Share Capital and Reserves and
// Surplus (Shareholders' Funds) ahead of the four Non-current Liabilities
// lines ahead of Current Liabilities, non-current assets ahead of current
// assets — differs from the plain alphabetical order get_balance_sheet's
// ORDER BY nature happens to produce, so it is spelled out here rather than
// trusted to fall out of the RPC's row order. 'capital' and
// 'non_current_liability' are BOTH still real natures a ledger can carry
// (0037 added five siblings, it did not retire either) — 'capital' sits
// alongside Share Capital/Reserves and Surplus as a residual catch-all now
// that those two cover Shareholders' Funds' real line items;
// 'non_current_liability' IS itself Schedule III's fourth Non-current
// Liabilities line, "Other Long-term Liabilities" — see displayLabel.
const LIABILITY_ORDER = {
  simple: [
    "capital", "share_capital", "reserves_surplus",
    "non_current_liability", "long_term_borrowing", "deferred_tax", "long_term_provision",
    "current_liability",
  ],
  schedule_iii: [
    "share_capital", "reserves_surplus", "capital",
    "long_term_borrowing", "deferred_tax", "non_current_liability", "long_term_provision",
    "current_liability",
  ],
} as const;
const ASSET_ORDER = {
  simple: ["current_asset", "fixed_asset"],
  schedule_iii: ["fixed_asset", "current_asset"],
} as const;

// In schedule_iii mode, every heading in LIABILITY_ORDER prints unconditionally
// EXCEPT 'capital' — Share Capital and Reserves and Surplus now cover what
// 'capital' used to mean for a Schedule III company, so it only earns a row
// when something is actually still posted there (typically a pre-existing
// ledger from before 0037 that has not been moved). Every other heading here
// is a genuine Schedule III line item, not a legacy catch-all, so it keeps
// the original "always show, nil or not" behaviour.
const SCHEDULE_III_PRESENT_ONLY = new Set(["capital"]);

// The Schedule III asset sub-heads within the fixed_asset nature (0089).
// Reads account_groups.ledger_role, not a new nature value — see the
// migration header for why a finer split within one nature has to ride
// ledger_role (a child group's nature is forced to match its parent's;
// ledger_role is not). Always shown nil-or-not in schedule_iii mode, same
// reasoning as every other Schedule III heading above: a Schedule III
// company genuinely has these four line items whether or not anything is
// posted to one of them yet.
const FIXED_ASSET_BUCKET_LABEL: Record<string, string> = {
  tangible_fixed_asset: "Tangible Assets",
  intangible_fixed_asset: "Intangible Assets",
  capital_work_in_progress: "Capital Work-in-Progress",
  investment: "Non-current Investments",
};
const FIXED_ASSET_BUCKET_ORDER = [
  "tangible_fixed_asset", "intangible_fixed_asset", "capital_work_in_progress", "investment",
] as const;
// Any row whose ledger_role is not one of the four sub-heads (there should
// be none after 0089's backfill, but a defensive default matters more than
// an assumption) falls back to Tangible — the same "assume tangible unless
// told otherwise" call the migration's own backfill made, for the same
// reason: every fixed-asset ledger this app has ever seeded is genuinely
// tangible plant/equipment/furniture.
function fixedAssetBucketOf(role: string | null | undefined): string {
  return role && (FIXED_ASSET_BUCKET_ORDER as readonly string[]).includes(role)
    ? role
    : "tangible_fixed_asset";
}

/** The day before a YYYY-MM-DD date. Anchored at noon UTC so it cannot slip
 * across a day boundary — the same reasoning lib/utils/period.ts spells out
 * for its own date arithmetic. */
function dayBefore(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** For display only — "23 Aug 2026". Local to this page rather than
 * imported from lib/utils/period.ts because that file's own formatDate is
 * not exported; duplicating one Intl call is cheaper than widening that
 * module's surface for a single caller. */
function formatAsAt(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// The shape get_balance_sheet (0089) actually returns. Cast to this rather
// than trusted through the generated Database type, which will not carry
// the new ledger_role column until types/database.types.ts is regenerated
// after this migration — see this feature's own build notes.
type BsRow = {
  side: string;
  nature: string;
  group_name: string;
  ledger_name: string;
  ledger_role: string | null;
  amount: number;
};

const sumAmount = (rows: BsRow[]) => rows.reduce((n, r) => n + Number(r.amount), 0);

export default async function BalanceSheetPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/balance-sheet">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  // Same RPC the Overview page (app/(app)/[companyId]/page.tsx) already uses
  // for entity-type-driven display: one call resolves the company against
  // its ref_entity_types rule row, so statement_format and
  // financial_year_start_month come back together instead of two queries
  // disagreeing about which company they mean.
  const { data: profile } = await supabase.rpc("get_company_profile", {
    p_company_id: companyId,
  });
  const company = profile?.[0];
  // Fail safe to 'simple' on any lookup miss — a report page must render,
  // never crash, over a profile it couldn't resolve.
  const scheduleIII = company?.statement_format === "schedule_iii";
  const startMonth = company?.financial_year_start_month ?? 4;

  const period = defaultPeriod(startMonth, {
    to: typeof sp.as_at === "string" ? sp.as_at : undefined,
  });

  const [{ data: branches }, { data: companyRow }, { data: groupRows }, { data: ledgerRows }] =
    await Promise.all([
      supabase
        .from("branches")
        .select("id, code, name")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("is_head_office", { ascending: false }),
      supabase.from("companies").select("book_beginning_date").eq("id", companyId).single(),
      // Fetched for the group-drill feature below. get_balance_sheet (unlike
      // get_trial_balance) returns no id at all -- only nature/group_name/
      // ledger_name as plain text -- so a real account_groups.id and
      // ledgers.id have to be recovered client-side by matching on name,
      // same as the ledgers list page (app/(app)/[companyId]/ledgers) already
      // does for its own group picker: two flat queries, joined in JS,
      // rather than one PostgREST embed.
      supabase.from("account_groups").select("id, name, nature").eq("company_id", companyId),
      supabase.from("ledgers").select("id, name, group_id").eq("company_id", companyId),
    ]);
  const branchId = typeof sp.branch === "string" ? sp.branch : undefined;

  // (nature, group_name) -> the real account_groups.id, and (nature,
  // group_name, ledger_name) -> the real ledgers.id -- the exact same
  // tuple the comparativeIndex below already treats as a stable identity
  // for a ledger, just extended one level to reach the group and ledger
  // themselves. Verified against a real company (Bharat Industries
  // Limited, 17 ledger rows) that every current-period row resolves
  // cleanly; a row that somehow doesn't match still renders further down,
  // just without a group toggle or a drill link, rather than disappearing.
  const groupById = new Map((groupRows ?? []).map((g) => [g.id, g] as const));
  const groupIdByKey = new Map<string, string>();
  for (const g of groupRows ?? []) {
    groupIdByKey.set(`${g.nature}|${g.name}`, g.id);
  }
  const ledgerIdByKey = new Map<string, string>();
  for (const l of ledgerRows ?? []) {
    const g = groupById.get(l.group_id);
    if (!g) continue;
    ledgerIdByKey.set(`${g.nature}|${g.name}|${l.name}`, l.id);
  }
  const statementHref = `/${companyId}/reports/ledger-statement`;

  // The balance sheet reads every ledger CUMULATIVELY from the day the books
  // began (get_balance_sheet -> ledger_opening_signed, which sums all entries
  // before the as-at date). The profit added to the liabilities side, however,
  // used to cover only the CURRENT financial year — so from a company's second
  // year onward the statement was out by every rupee of profit earned before
  // that year.
  //
  // Migration 0020's header reasoned that year-end closing entries were
  // unnecessary "because the reports already compute the P&L and balance sheet
  // from a from/to range, so a financial year's numbers are already correct
  // without a year-end journal". That is true of the P&L, which genuinely is a
  // range. It is not true of the balance sheet, which is not a range at all.
  //
  // Proven against live data before this fix was written: for a real company
  // the statement balanced to 0.00 with the profit window opened at the book
  // beginning, and was out by exactly the prior period's profit with the
  // window opened later. The same check across 12 companies x 7 as-at dates
  // gave a worst imbalance of 0.00 — assets minus liabilities equals profit
  // accumulated since the books began, at every date, by double entry.
  //
  // So profit is carried forward the way a real balance sheet carries it: a
  // "balance brought forward" line covering every year before this one, plus
  // this year's own profit. Their sum is what makes the two sides agree, and
  // showing them as two lines is also how Schedule III expects the Surplus
  // line to read. Note this deliberately fixes the REPORT rather than posting
  // a closing journal — a posted year-end entry would have to touch the P&L
  // ledgers to balance, which would then distort every other consumer of them
  // (budget variance, CMA ratios, cost-centre P&L, income tax, tax audit).
  // A real closing voucher remains a separate, open feature.
  const bookBeginning = companyRow?.book_beginning_date ?? period.from;

  // Comparative column (0089): "as at the end of the immediately preceding
  // financial year" — a balance sheet has no length to match the way a P&L
  // period does, only a single instant, so this is simpler than the P&L's
  // "same-length immediately preceding period". financialYearStart is the
  // same helper get_company_profile-driven pages already use for FY math
  // (lib/utils/period.ts); called on the report's own as-at date (not on
  // "today", the way previousFinancialYearEnd works) so a user who picks an
  // earlier ?as_at= still gets THAT date's own preceding year-end, not
  // today's.
  const currentFyStartForAsAt = financialYearStart(startMonth, new Date(`${period.to}T12:00:00Z`));
  const comparativeAsAt = dayBefore(currentFyStartForAsAt.toISOString().slice(0, 10));
  const comparativeFyStart = financialYearStart(startMonth, new Date(`${comparativeAsAt}T12:00:00Z`))
    .toISOString()
    .slice(0, 10);
  // A comparative year-end only means something if the books had already
  // begun by then — every company seeded in this database began its books
  // on the first day of the CURRENT financial year, so comparativeAsAt
  // (last day of the prior year) predates book_beginning_date for all of
  // them today, and this correctly resolves to false for every one:
  // verified live, see this feature's build notes.
  const hasComparative = comparativeAsAt >= bookBeginning;

  const [
    { data: rows },
    { data: plCurrent },
    { data: plBroughtForward },
    { data: rows2 },
    { data: plCurrent2 },
    { data: plBroughtForward2 },
  ] = await Promise.all([
    supabase.rpc("get_balance_sheet", {
      p_company_id: companyId,
      p_as_at: period.to,
      p_branch_id: branchId,
    }),
    supabase.rpc("get_profit_and_loss", {
      p_company_id: companyId,
      p_from: period.from,
      p_to: period.to,
      p_branch_id: branchId,
    }),
    // Everything earned before this financial year started. If the books
    // themselves began inside the current year this range runs backwards,
    // which returns no rows and therefore zero — the correct answer.
    supabase.rpc("get_profit_and_loss", {
      p_company_id: companyId,
      p_from: bookBeginning,
      p_to: dayBefore(period.from),
      p_branch_id: branchId,
    }),
    hasComparative
      ? supabase.rpc("get_balance_sheet", {
          p_company_id: companyId,
          p_as_at: comparativeAsAt,
          p_branch_id: branchId,
        })
      : Promise.resolve({ data: null }),
    hasComparative
      ? supabase.rpc("get_profit_and_loss", {
          p_company_id: companyId,
          p_from: comparativeFyStart,
          p_to: comparativeAsAt,
          p_branch_id: branchId,
        })
      : Promise.resolve({ data: null }),
    // Same "everything before this year, or nothing if it runs backwards"
    // shape as the current-year query above, re-based on the comparative
    // year's own start instead of the current year's.
    hasComparative
      ? supabase.rpc("get_profit_and_loss", {
          p_company_id: companyId,
          p_from: bookBeginning,
          p_to: dayBefore(comparativeFyStart),
          p_branch_id: branchId,
        })
      : Promise.resolve({ data: null }),
  ]);

  const all = (rows ?? []) as unknown as BsRow[];
  const all2 = (rows2 ?? []) as unknown as BsRow[];
  const sumPL = (plRows: { nature: string; amount: number }[] | null) => {
    const r = plRows ?? [];
    const sumNature = (n: string[]) =>
      r.filter((x) => n.includes(x.nature)).reduce((t, x) => t + Number(x.amount), 0);
    return (
      sumNature(["direct_income", "indirect_income"]) -
      sumNature(["direct_expense", "indirect_expense"])
    );
  };

  // Both belong on the liabilities side — they are owed to the proprietor.
  // Without them the two sides cannot agree, because income and expense
  // ledgers are not carried on the balance sheet itself.
  const profitThisYear = sumPL(plCurrent);
  const profitBroughtForward = sumPL(plBroughtForward);
  const profit = profitBroughtForward + profitThisYear;

  // Same shape, recomputed for the comparative year-end — reusing sumPL
  // rather than inventing a second way to read a P&L result, per this
  // feature's own scope note about not duplicating 0073's carry-forward
  // logic.
  const profitThisYear2 = sumPL(plCurrent2);
  const profitBroughtForward2 = sumPL(plBroughtForward2);
  const profit2 = profitBroughtForward2 + profitThisYear2;

  const side = (s: string) => all.filter((r) => r.side === s);
  const total = (s: string) =>
    side(s).reduce((n, r) => n + Number(r.amount), 0) + (s === "liabilities" ? profit : 0);

  const side2 = (s: string) => all2.filter((r) => r.side === s);
  const total2 = (s: string) =>
    side2(s).reduce((n, r) => n + Number(r.amount), 0) + (s === "liabilities" ? profit2 : 0);

  const difference = total("assets") - total("liabilities");
  const balanced = Math.abs(difference) < 0.005;

  // Which account groups are currently expanded to show their ledgers —
  // Tally's Shift+Enter, done with a plain <Link> and a searchParam instead
  // of client state, so this stays a Server Component with no hooks. A
  // single flat set shared by both sides (not one per sideKey): a real
  // account_groups.id is a UUID, so a liabilities-side group can never
  // collide with an assets-side one, and sharing means a link built for one
  // side's group never accidentally disturbs the other side's expand state.
  const expandedGroupIds = new Set(
    typeof sp.expand === "string" && sp.expand.trim() !== "" ? sp.expand.split(",") : []
  );

  // Builds the href that flips ONE group's membership in ?expand=, keeping
  // every other query param (?as_at, ?branch, and anything this page does
  // not itself know about) exactly as it stands. Re-deriving from `sp`
  // rather than the branch-switch links' bare `href="?branch=..."` pattern
  // further up this file on purpose: those two links only ever need to set
  // branch/clear everything else, but a group toggle must NOT silently reset
  // the as-at date or branch filter the reader is already looking at — that
  // is the same "carrying the period" discipline DrillLink's own header
  // documents, applied here to an in-page toggle rather than a drill-out.
  const toggleExpandHref = (groupId: string): string => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(sp)) {
      if (key === "expand" || typeof value !== "string" || value === "") continue;
      params.set(key, value);
    }
    const next = expandedGroupIds.has(groupId)
      ? [...expandedGroupIds].filter((id) => id !== groupId)
      : [...expandedGroupIds, groupId];
    if (next.length > 0) params.set("expand", next.join(","));
    const qs = params.toString();
    return qs ? `?${qs}` : "?";
  };

  // Display-only renaming for Schedule III — the same nature/account-group
  // data, just Schedule III's own line-item names. 'capital' only ever
  // shows as a leftover row (see SCHEDULE_III_PRESENT_ONLY above), so it is
  // labelled as exactly that rather than reusing "Shareholders' Funds",
  // which now belongs to the Share Capital + Reserves and Surplus pair.
  // 'non_current_liability' IS Schedule III's own "Other Long-term
  // Liabilities" line, not a fallback label for something else.
  const displayLabel = (nature: string): string => {
    if (scheduleIII) {
      if (nature === "capital") return "Other Shareholders' Funds";
      if (nature === "non_current_liability") return "Other Long-term Liabilities";
      if (nature === "fixed_asset") return "Non-current Assets";
    }
    return NATURE_LABEL[nature] ?? nature;
  };

  // Named sideKey, not key: React reserves `key` as the list identity and
  // never forwards it as a prop, so it would arrive undefined.
  // A plain function, not a component: it closes over the page's own
  // variables and is called inline as {renderSide(...)} rather than
  // rendered as <RenderSide />, so React never sees it as a component type
  // that gets torn down and rebuilt on every render.
  const renderSide = ({ label, sideKey }: { label: string; sideKey: "assets" | "liabilities" }) => {
    const items = side(sideKey);
    const items2 = side2(sideKey);
    const format = scheduleIII ? "schedule_iii" : "simple";
    const order = sideKey === "liabilities" ? LIABILITY_ORDER[format] : ASSET_ORDER[format];
    // Schedule III always prints its real structural headings, nil or not —
    // Non-current Liabilities is the whole point of this feature, and
    // Shareholders' Funds / Non-current Assets should not silently vanish
    // just because nothing happens to be posted there yet. 'capital' is the
    // one exception even in schedule_iii mode — see SCHEDULE_III_PRESENT_ONLY
    // above. The simple format keeps its original fully data-driven
    // behaviour: a nature heading appears only when at least one ledger
    // under it carries a balance.
    const present = new Set(items.map((r) => r.nature));
    const byNature: readonly string[] = scheduleIII
      ? order.filter((n) => !SCHEDULE_III_PRESENT_ONLY.has(n) || present.has(n))
      : order.filter((n) => present.has(n));

    // Per-ledger comparative lookup, built once for this side rather than
    // per nature: keyed on (nature, group_name, ledger_name) so a name that
    // happens to repeat under a different group cannot collide. A ledger
    // absent from this map genuinely did not carry a balance as at the
    // comparative date (opened after that year-end, most commonly) —
    // reading that as zero is correct, not a missing-data guess.
    const comparativeIndex = new Map<string, number>();
    for (const r of items2) {
      comparativeIndex.set(`${r.nature}|${r.group_name}|${r.ledger_name}`, Number(r.amount));
    }
    const comparativeOf = (r: BsRow) =>
      comparativeIndex.get(`${r.nature}|${r.group_name}|${r.ledger_name}`) ?? 0;

    // One row of a nested per-ledger table: name, this year, comparative —
    // and, when this exact (nature, group_name, ledger_name) resolved to a
    // real ledgers.id above, a DrillRow out to that ledger's own statement
    // rather than a dead <tr>. `from`/`to` are pinned to bookBeginning..
    // period.to rather than left to carry() to pick up: the balance sheet
    // itself reads every ledger CUMULATIVELY since the books began (see the
    // page-level comment above bookBeginning), so a statement opened from
    // any narrower window would show a different closing figure than the
    // one just clicked — the same "the destination must resolve its own
    // period explicitly" rule DrillLink's header documents for any report
    // whose period is not already in ?from/?to.
    const ledgerRow = (r: BsRow, i: number) => {
      const ledgerId = ledgerIdByKey.get(`${r.nature}|${r.group_name}|${r.ledger_name}`);
      const cells = (
        <>
          <td className="py-0.5 pl-4 text-ink-soft">{r.ledger_name}</td>
          <td className="py-0.5 text-right tabular-nums font-mono">{formatINR(Number(r.amount))}</td>
          <td className="py-0.5 text-right tabular-nums font-mono text-ink-faint">
            {hasComparative ? formatINR(comparativeOf(r)) : "—"}
          </td>
        </>
      );
      if (!ledgerId) {
        // get_balance_sheet returns no ledger id at all (unlike
        // get_trial_balance), so this is recovered by matching names — see
        // the ledgerIdByKey comment above. A miss should be effectively
        // impossible for a current-period row (verified live: 0 of 17 for a
        // real company), so this falls back to a plain row rather than
        // hiding the figure.
        return <tr key={i}>{cells}</tr>;
      }
      return (
        <DrillRow
          key={i}
          href={statementHref}
          params={{ ledger: ledgerId, from: bookBeginning, to: period.to, branch: branchId ?? null }}
          carry={sp}
          label={r.ledger_name}
        >
          {cells}
        </DrillRow>
      );
    };

    // Groups the ledger rows of one nature (or one Schedule III fixed-asset
    // bucket) by their account group, Tally's Shift+Enter semantics: a
    // group heading + its own subtotal always shows, and its ledgers show
    // beneath it only once that group's real id is in ?expand=. This is a
    // strict partition of `items` by group_name (get_balance_sheet's own
    // ORDER BY already sorts by group_name, so a single left-to-right scan
    // is enough to keep each group's rows together) — every rupee in
    // `items` ends up in exactly one group, so the group subtotals always
    // sum back to the nature (or bucket) total above them, collapsed or
    // expanded alike; the toggle only ever changes which rows are drawn,
    // never what is summed.
    const groupSection = (groupItems: BsRow[], wrapperClassName = "mt-1 w-full") => {
      const order: string[] = [];
      const byGroup = new Map<string, BsRow[]>();
      for (const r of groupItems) {
        if (!byGroup.has(r.group_name)) {
          order.push(r.group_name);
          byGroup.set(r.group_name, []);
        }
        byGroup.get(r.group_name)!.push(r);
      }

      return (
        <table className={wrapperClassName}>
          <tbody>
            {order.map((groupName) => {
              const rows = byGroup.get(groupName)!;
              const groupId = groupIdByKey.get(`${rows[0].nature}|${groupName}`);
              const groupTotal = sumAmount(rows);
              const groupTotal2 = sumAmount(rows.map((r) => ({ ...r, amount: comparativeOf(r) })));
              const isExpanded = groupId ? expandedGroupIds.has(groupId) : false;
              const heading = (
                <span className="flex items-baseline justify-between gap-2">
                  <span className="flex items-center gap-1 text-xs font-semibold text-ink-soft">
                    {groupId && (
                      <ChevronDown
                        size={11}
                        className={cn("shrink-0 transition-transform", isExpanded && "rotate-180")}
                        aria-hidden="true"
                      />
                    )}
                    {groupName}
                  </span>
                  <span className="flex shrink-0 gap-4 font-mono text-xs tabular-nums text-ink-faint">
                    <span>{formatINR(groupTotal, { showZero: true })}</span>
                    <span>{hasComparative ? formatINR(groupTotal2, { showZero: true }) : "—"}</span>
                  </span>
                </span>
              );
              return (
                <tr key={groupName} className={groupId ? "transition-colors hover:bg-surface-2" : undefined}>
                  <td className="pt-1.5" colSpan={3}>
                    {groupId ? (
                      // A real Link, not a client onClick — this file is a
                      // Server Component (see DrillLink's own header for why
                      // that constraint is load-bearing), so "expand in
                      // place" means "reload this same page with one more
                      // id in ?expand=", exactly like the branch-switch
                      // links further up this file.
                      <Link
                        href={toggleExpandHref(groupId)}
                        aria-expanded={isExpanded}
                        className="block w-full rounded-sm pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
                      >
                        {heading}
                      </Link>
                    ) : (
                      // No real account_groups.id resolved for this group
                      // (see ledgerIdByKey's comment above for when that can
                      // happen) — the subtotal still prints, it just cannot
                      // be expanded or collapsed.
                      <div className="pl-2">{heading}</div>
                    )}
                    {isExpanded && (
                      <table className="mt-0.5 w-full">
                        <tbody>{rows.map(ledgerRow)}</tbody>
                      </table>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      );
    };

    return (
      <div className="min-w-0">
        <table className="w-full min-w-[360px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>{label}</th>
              <th className={th + " text-right"}>As at {formatAsAt(period.to)}</th>
              <th className={th + " text-right"}>
                {hasComparative ? `As at ${formatAsAt(comparativeAsAt)}` : "Previous year"}
              </th>
            </tr>
          </thead>
          <tbody>
            {byNature.map((nature) => {
              const natureItems = items.filter((r) => r.nature === nature);
              const natureTotal = sumAmount(natureItems);
              const natureTotal2 = sumAmount(natureItems.map((r) => ({ ...r, amount: comparativeOf(r) })));
              // Schedule III's asset sub-classification (0089) — only the
              // fixed_asset nature, only in schedule_iii mode. Every other
              // nature, and the whole of simple mode, keeps the original
              // flat per-ledger presentation.
              const isFixedAssetSplit = scheduleIII && nature === "fixed_asset";
              return (
                <tr key={nature} className="align-top">
                  <td className={td} colSpan={3}>
                    {scheduleIII ? (
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-semibold">{displayLabel(nature)}</span>
                        <span className="flex shrink-0 gap-4 font-mono text-xs tabular-nums text-ink-faint">
                          <span>{formatINR(natureTotal, { showZero: true })}</span>
                          <span>{hasComparative ? formatINR(natureTotal2, { showZero: true }) : "—"}</span>
                        </span>
                      </div>
                    ) : (
                      <div className="font-semibold">{displayLabel(nature)}</div>
                    )}
                    {isFixedAssetSplit ? (
                      <table className="mt-1 w-full">
                        <tbody>
                          {FIXED_ASSET_BUCKET_ORDER.map((bucket) => {
                            const bucketItems = natureItems.filter(
                              (r) => fixedAssetBucketOf(r.ledger_role) === bucket
                            );
                            const bucketTotal = sumAmount(bucketItems);
                            const bucketTotal2 = sumAmount(
                              bucketItems.map((r) => ({ ...r, amount: comparativeOf(r) }))
                            );
                            return (
                              <tr key={bucket}>
                                <td className="pt-1.5" colSpan={3}>
                                  <div className="flex items-baseline justify-between gap-2 pl-2">
                                    <span className="text-xs font-semibold text-ink-soft">
                                      {FIXED_ASSET_BUCKET_LABEL[bucket]}
                                    </span>
                                    <span className="flex shrink-0 gap-4 font-mono text-xs tabular-nums text-ink-faint">
                                      <span>{formatINR(bucketTotal, { showZero: true })}</span>
                                      <span>
                                        {hasComparative ? formatINR(bucketTotal2, { showZero: true }) : "—"}
                                      </span>
                                    </span>
                                  </div>
                                  {groupSection(bucketItems, "w-full")}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      groupSection(natureItems)
                    )}
                  </td>
                </tr>
              );
            })}
            {sideKey === "liabilities" &&
              (profitBroughtForward !== 0 || (hasComparative && profitBroughtForward2 !== 0)) && (
                <tr>
                  <td className={td}>
                    {profitBroughtForward >= 0
                      ? "Balance brought forward"
                      : "Accumulated loss brought forward"}
                    <div className="text-xs text-ink-faint">
                      Retained from every year before this one
                    </div>
                  </td>
                  <td className={num}>
                    {formatINR(profitBroughtForward, { showZero: true })}
                  </td>
                  <td className={num + " text-ink-faint"}>
                    {hasComparative ? formatINR(profitBroughtForward2, { showZero: true }) : "—"}
                  </td>
                </tr>
              )}
            {sideKey === "liabilities" &&
              (profitThisYear !== 0 || (hasComparative && profitThisYear2 !== 0)) && (
                <tr>
                  <td className={td}>{profitThisYear >= 0 ? "Profit for the period" : "Loss for the period"}</td>
                  {/* Signed, not Math.abs — a loss must print with the same visible
                      minus sign Input CGST/SGST and every other reducing row on this
                      side already carry (ledgerRow above), because that is what this
                      figure actually does to the liabilities total (it is added in
                      signed, i.e. subtracted for a loss — see the `total` closure).
                      Printing it as a bare positive here would make a reader's own
                      manual addition of the visible rows come out double the loss too
                      high, even though the total cell itself was always correct. */}
                  <td className={num}>{formatINR(profitThisYear, { showZero: true })}</td>
                  <td className={num + " text-ink-faint"}>
                    {hasComparative ? formatINR(profitThisYear2, { showZero: true }) : "—"}
                  </td>
                </tr>
              )}
            {sideKey === "liabilities" &&
              profitBroughtForward !== 0 &&
              profitThisYear !== 0 && (
                <tr>
                  <td className={td + " font-semibold"}>
                    {profit >= 0 ? "Profit and Loss Account" : "Profit and Loss Account (debit)"}
                  </td>
                  <td className={num + " font-semibold"}>
                    {formatINR(profit, { showZero: true })}
                  </td>
                  <td className={num + " font-semibold text-ink-faint"}>
                    {hasComparative && profitBroughtForward2 !== 0 && profitThisYear2 !== 0
                      ? formatINR(profit2, { showZero: true })
                      : "—"}
                  </td>
                </tr>
              )}
            {!scheduleIII && items.length === 0 && profit === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-ink-faint">
                  Nothing to show.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-bg">
              <td className="px-4 py-2.5 font-semibold">Total</td>
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums font-mono">
                {formatINR(total(sideKey), { showZero: true })}
              </td>
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums font-mono text-ink-faint">
                {hasComparative ? formatINR(total2(sideKey), { showZero: true }) : "—"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    );
  };

  const selectedBranch = (branches ?? []).find((b) => b.id === branchId);

  return (
    <ReportShell
      title="Balance Sheet"
      period={`As at ${period.label.split(" to ").pop()}`}
      status={{
        label: balanced
          ? "Balanced"
          : `Out by ${formatINR(Math.abs(difference), { showZero: true })}`,
        tone: balanced ? "ok" : "bad",
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
      <div className="grid divide-y divide-border md:grid-cols-2 md:divide-x md:divide-y-0">
        {renderSide({
          label: scheduleIII ? "Equity and Liabilities" : "Liabilities",
          sideKey: "liabilities",
        })}
        {renderSide({ label: "Assets", sideKey: "assets" })}
      </div>
      {!hasComparative && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          No comparative column: the books began {formatAsAt(bookBeginning)}, after{" "}
          {formatAsAt(comparativeAsAt)} — this financial year is this company&rsquo;s first, so
          there is no prior year-end to show alongside the current figures.
        </p>
      )}
      {selectedBranch && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          Showing {selectedBranch.name} only — the &ldquo;Balanced&rdquo; status above is
          this branch&rsquo;s own assets against its own liabilities, exactly the same
          check the whole-company view runs, just scoped down. If it ever reads
          &ldquo;Out by&rdquo; for one branch while the whole company balances, that means
          a voucher somewhere split its lines across more than one branch — worth tracing
          directly, since nothing here currently posts an inter-branch clearing entry to
          absorb that automatically.
        </p>
      )}
      {scheduleIII && (
        <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
          Shareholders&rsquo; Funds and Non-current Liabilities show Schedule
          III&rsquo;s own inner line items now. &ldquo;Other Long-term
          Liabilities&rdquo; is itself one of Schedule III&rsquo;s four real
          Non-current Liabilities lines, not a leftover bucket. &ldquo;Other
          Shareholders&rsquo; Funds&rdquo; is different: it only appears if
          something is still posted directly to the old &ldquo;Capital
          Account&rdquo; group from before this split existed — move those
          ledgers into Share Capital or Reserves and Surplus and that row
          disappears on its own. Non-current Assets is now split into
          Tangible / Intangible / Capital Work-in-Progress / Non-current
          Investments; Accumulated Depreciation, where posted, nets against
          Tangible Assets specifically rather than being spread across all
          four. Still open: the Profit &amp; Loss statement on this report
          page is still the simple format, not yet Schedule III&rsquo;s.
        </p>
      )}
    </ReportShell>
  );
}
