"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { formatINR } from "@/lib/utils/currency";
import { financialYearStart } from "@/lib/utils/period";
import {
  buildBalanceSheetInstance,
  buildProfitAndLossInstance,
  estimateAoc4Applicability,
  mapBalanceSheetFacts,
  mapProfitAndLossFacts,
  type Aoc4Fact,
  type BalanceSheetMapping,
  type BsFactRow,
  type PlFactRow,
  type ProfitAndLossMapping,
} from "@/lib/xbrl/aoc4";

function downloadFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "application/xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** The day before a YYYY-MM-DD date, anchored at noon UTC — same pattern
 * balance-sheet/page.tsx uses, duplicated here rather than imported since
 * that helper is not exported from a page module. */
function dayBefore(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type PL = { nature: string; amount: number }[];

export function Aoc4XbrlPanel({
  companyId,
  companyName,
  cin,
  financialYearStartMonth,
  bookBeginningDate,
}: {
  companyId: string;
  companyName: string;
  cin: string | null;
  financialYearStartMonth: number;
  bookBeginningDate: string;
}) {
  const today = useMemo(() => isoDate(new Date()), []);
  const currentFyStart = useMemo(
    () => isoDate(financialYearStart(financialYearStartMonth, new Date(`${today}T12:00:00Z`))),
    [financialYearStartMonth, today]
  );
  // AOC-4 is an annual return, filed after a financial year closes — default
  // to the most recently COMPLETED financial year, not the in-progress one,
  // falling back to current-FY-to-date only when the books have no completed
  // year yet (same "first year, no comparative" edge case 0089 handles for
  // the balance sheet report).
  const completedFyEnd = dayBefore(currentFyStart);
  const completedFyStart = isoDate(financialYearStart(financialYearStartMonth, new Date(`${completedFyEnd}T12:00:00Z`)));
  const hasCompletedYear = completedFyStart >= bookBeginningDate;

  const [asAt, setAsAt] = useState(hasCompletedYear ? completedFyEnd : today);
  const [plFrom, setPlFrom] = useState(hasCompletedYear ? completedFyStart : currentFyStart);
  const [plTo, setPlTo] = useState(hasCompletedYear ? completedFyEnd : today);
  const [includeComparative, setIncludeComparative] = useState(true);

  const [isListed, setIsListed] = useState(false);
  const [isIndAs, setIsIndAs] = useState(false);

  const [busyBs, setBusyBs] = useState(false);
  const [busyPl, setBusyPl] = useState(false);

  const [bsPreview, setBsPreview] = useState<BalanceSheetMapping | null>(null);
  const [plPreview, setPlPreview] = useState<ProfitAndLossMapping | null>(null);

  const fileStem = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  async function retainedProfitAsAt(supabase: ReturnType<typeof createClient>, d: string): Promise<number> {
    const fyStart = isoDate(financialYearStart(financialYearStartMonth, new Date(`${d}T12:00:00Z`)));
    const [broughtForward, thisYear] = await Promise.all([
      supabase.rpc("get_profit_and_loss", {
        p_company_id: companyId,
        p_from: bookBeginningDate,
        p_to: dayBefore(fyStart),
      }),
      supabase.rpc("get_profit_and_loss", { p_company_id: companyId, p_from: fyStart, p_to: d }),
    ]);
    const sumPL = (rows: PL | null | undefined) =>
      (rows ?? []).reduce((t, r) => t + Number(r.amount) * (r.nature.includes("income") ? 1 : -1), 0);
    return sumPL(broughtForward.data as unknown as PL) + sumPL(thisYear.data as unknown as PL);
  }

  async function generateBalanceSheet() {
    if (!cin) {
      toast.error("No CIN on file for this company — set it under Company Settings first.");
      return;
    }
    setBusyBs(true);
    try {
      const supabase = createClient();
      const comparativeAsAt = dayBefore(isoDate(financialYearStart(financialYearStartMonth, new Date(`${asAt}T12:00:00Z`))));
      const wantComparative = includeComparative && comparativeAsAt >= bookBeginningDate;

      const [{ data: rows, error }, retained, compRows, compRetained] = await Promise.all([
        supabase.rpc("get_balance_sheet", { p_company_id: companyId, p_as_at: asAt }),
        retainedProfitAsAt(supabase, asAt),
        wantComparative
          ? supabase.rpc("get_balance_sheet", { p_company_id: companyId, p_as_at: comparativeAsAt })
          : Promise.resolve({ data: null, error: null }),
        wantComparative ? retainedProfitAsAt(supabase, comparativeAsAt) : Promise.resolve(0),
      ]);
      if (error) throw error;

      const mapping = mapBalanceSheetFacts((rows ?? []) as unknown as BsFactRow[], retained);
      const compMapping = wantComparative
        ? mapBalanceSheetFacts((compRows.data ?? []) as unknown as BsFactRow[], compRetained)
        : null;

      const diff = Math.abs(mapping.totalAssets - mapping.totalEquityAndLiabilities);
      if (diff > 0.5) {
        toast.error(
          `Total Assets (₹${formatINR(mapping.totalAssets)}) and Total Equity and Liabilities (₹${formatINR(mapping.totalEquityAndLiabilities)}) do not match — not downloading. This should not happen; check the company's balance sheet report first.`
        );
        return;
      }

      const xml = buildBalanceSheetInstance({
        cin,
        mapping,
        comparativeMapping: compMapping,
        asAt,
        comparativeAsAt: wantComparative ? comparativeAsAt : null,
      });
      setBsPreview(mapping);
      downloadFile(`${fileStem}-aoc4-xbrl-balance-sheet-${asAt}.xml`, xml);
      toast.success(`Balance sheet instance generated — Total Assets ₹${formatINR(mapping.totalAssets)}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not generate the balance sheet instance.");
    } finally {
      setBusyBs(false);
    }
  }

  async function generateProfitAndLoss() {
    if (!cin) {
      toast.error("No CIN on file for this company — set it under Company Settings first.");
      return;
    }
    setBusyPl(true);
    try {
      const supabase = createClient();
      const periodDays = Math.round(
        (new Date(`${plTo}T12:00:00Z`).getTime() - new Date(`${plFrom}T12:00:00Z`).getTime()) / 86400000
      );
      const comparativeTo = dayBefore(plFrom);
      const compFromDate = new Date(`${comparativeTo}T12:00:00Z`);
      compFromDate.setUTCDate(compFromDate.getUTCDate() - periodDays);
      const comparativeFrom = isoDate(compFromDate);
      const wantComparative = includeComparative && comparativeFrom >= bookBeginningDate;

      const [{ data: rows, error }, compResult] = await Promise.all([
        supabase.rpc("get_profit_and_loss", { p_company_id: companyId, p_from: plFrom, p_to: plTo }),
        wantComparative
          ? supabase.rpc("get_profit_and_loss", { p_company_id: companyId, p_from: comparativeFrom, p_to: comparativeTo })
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (error) throw error;

      const mapping = mapProfitAndLossFacts((rows ?? []) as unknown as PlFactRow[]);
      const compMapping = wantComparative
        ? mapProfitAndLossFacts((compResult.data ?? []) as unknown as PlFactRow[])
        : null;

      const xml = buildProfitAndLossInstance({
        cin,
        mapping,
        comparativeMapping: compMapping,
        from: plFrom,
        to: plTo,
        comparativeFrom: wantComparative ? comparativeFrom : null,
        comparativeTo: wantComparative ? comparativeTo : null,
      });
      setPlPreview(mapping);
      downloadFile(`${fileStem}-aoc4-xbrl-profit-loss-${plFrom}-to-${plTo}.xml`, xml);
      toast.success(`Profit & loss instance generated — Profit/Loss for the Period ₹${formatINR(mapping.profitForPeriod)}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not generate the profit & loss instance.");
    } finally {
      setBusyPl(false);
    }
  }

  const applicability = estimateAoc4Applicability({
    shareCapitalBalance: bsPreview
      ? bsPreview.liabilities.find((f) => f.element === "in-gaap:ShareCapital")?.amount ?? 0
      : 0,
    revenueFromOperations: plPreview
      ? plPreview.facts.find((f) => f.element === "in-gaap:RevenueFromOperations")?.amount ?? 0
      : 0,
    isListedOrListedSubsidiary: isListed,
    isIndAsRequired: isIndAs,
  });

  return (
    <div className="flex flex-col gap-6">
      {!cin && (
        <div className="rounded-lg border border-warning bg-warning-soft px-4 py-3 text-sm text-warning">
          This company has no CIN on file. A CIN is required for the XBRL entity identifier —
          add it under Company Settings before generating either instance document.
        </div>
      )}

      <Card>
        <CardHeader>
          <p className="text-sm font-semibold text-ink">Applicability estimate</p>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-xs text-ink-faint">
            LEKHA does not track &ldquo;listed&rdquo; status, Ind AS applicability, or a separately
            maintained paid-up capital / turnover figure — tick what applies, generate a balance
            sheet and P&amp;L below first so the ledger-based estimates fill in, then treat this as a
            starting point for your CA/CS to confirm, not a ruling.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isListed} onChange={(e) => setIsListed(e.target.checked)} />
            Listed on a stock exchange in India, or an Indian subsidiary of one
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isIndAs} onChange={(e) => setIsIndAs(e.target.checked)} />
            Required to prepare financial statements under the Ind AS Rules, 2015
          </label>
          <div
            className={
              "rounded-md px-3 py-2 text-sm " +
              (applicability.applicable ? "bg-warning-soft text-warning" : "bg-surface-2 text-ink-soft")
            }
          >
            {applicability.applicable ? (
              <>
                <p className="font-medium">Likely required to file AOC-4 in XBRL:</p>
                <ul className="mt-1 list-disc pl-5">
                  {applicability.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                Nothing generated yet, or none of the four Rule 3 triggers appear to apply —
                most SME users of this app will land here, and genuinely do not need to file
                AOC-4 in XBRL at all (plain AOC-4 covers them instead).
              </p>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <p className="text-sm font-semibold text-ink">1. Balance Sheet instance</p>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 sm:w-64">
            <Label>As at</Label>
            <Input type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeComparative} onChange={(e) => setIncludeComparative(e.target.checked)} />
            Include previous year-end comparative (when the books go back that far)
          </label>
          <div>
            <Button type="button" onClick={generateBalanceSheet} busy={busyBs} busyLabel="Generating…">
              Download Balance Sheet instance (XML)
            </Button>
          </div>
          {bsPreview && (
            <FactTable
              rows={[...bsPreview.assets, ...bsPreview.liabilities]}
              totalLabel="Total Assets vs Total Equity and Liabilities"
              totalLeft={bsPreview.totalAssets}
              totalRight={bsPreview.totalEquityAndLiabilities}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <p className="text-sm font-semibold text-ink">2. Profit &amp; Loss instance</p>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <Label>From</Label>
              <Input type="date" value={plFrom} onChange={(e) => setPlFrom(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>To</Label>
              <Input type="date" value={plTo} onChange={(e) => setPlTo(e.target.value)} />
            </label>
          </div>
          <div>
            <Button type="button" onClick={generateProfitAndLoss} busy={busyPl} busyLabel="Generating…">
              Download Profit &amp; Loss instance (XML)
            </Button>
          </div>
          {plPreview && (
            <div className="text-sm">
              <p className="mb-2 text-xs text-ink-faint">
                Expenses below are tagged individually across Schedule III&rsquo;s seven expense heads
                (whichever were actually posted to) plus Tax Expense, not as one lump figure — see the
                warning banner above for why the tag names are still unverified. Total Expenses is an
                independently computed cross-check of those facts, not a separate source of truth.
              </p>
              <table className="w-full text-sm">
                <tbody>
                  {plPreview.facts.map((f) => (
                    <FactRow key={f.element} fact={f} />
                  ))}
                  <tr className="border-t border-border font-semibold">
                    <td className="py-1">Total Revenue (I+II)</td>
                    <td className="py-1 text-right font-mono">{formatINR(plPreview.totalIncome, { showZero: true })}</td>
                  </tr>
                  <tr>
                    <td className="py-1 text-ink-soft">Total Expenses (cross-check sum)</td>
                    <td className="py-1 text-right font-mono text-ink-soft">
                      {formatINR(plPreview.totalExpenses, { showZero: true })}
                    </td>
                  </tr>
                  <tr className="border-t border-border font-semibold">
                    <td className="py-1">Profit / Loss for the Period</td>
                    <td className="py-1 text-right font-mono">
                      {formatINR(plPreview.profitForPeriod, { showZero: true })}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <p className="text-xs text-ink-faint">
        Both files are DRAFT instance documents with unverified taxonomy element names — see the
        banner above. Re-tag and validate them in MCA-recognised XBRL software before any real use;
        this app cannot validate against the live taxonomy or file anything itself.
      </p>
    </div>
  );
}

function FactRow({ fact }: { fact: Aoc4Fact }) {
  return (
    <tr>
      <td className="py-1 pl-2 text-ink-soft">{fact.scheduleIIICaption}</td>
      <td className="py-1 text-right font-mono">{formatINR(fact.amount, { showZero: true })}</td>
    </tr>
  );
}

function FactTable({
  rows,
  totalLabel,
  totalLeft,
  totalRight,
}: {
  rows: Aoc4Fact[];
  totalLabel: string;
  totalLeft: number;
  totalRight: number;
}) {
  const balanced = Math.abs(totalLeft - totalRight) < 0.5;
  return (
    <div className="text-sm">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((f) => (
            <FactRow key={f.element} fact={f} />
          ))}
        </tbody>
      </table>
      <div
        className={
          "mt-2 flex items-center justify-between rounded-md px-3 py-2 text-xs font-medium " +
          (balanced ? "bg-success-soft text-success" : "bg-error-soft text-error")
        }
      >
        <span>{totalLabel}</span>
        <span className="font-mono">
          {formatINR(totalLeft, { showZero: true })} / {formatINR(totalRight, { showZero: true })}
        </span>
      </div>
    </div>
  );
}
