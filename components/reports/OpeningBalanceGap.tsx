"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { Button } from "@/components/ui/Button";
import { formatINR } from "@/lib/utils/currency";
import {
  equityPlan,
  gapCoverage,
  gapOrigin,
  openingImbalance,
  signedOf,
  type EquityLedger,
  type OpeningGapRow,
} from "@/lib/reports/openingBalanceGap";

/** "12,500.00 Dr" — the way an accountant reads an opening balance. */
function drcr(signed: number): string {
  return `${formatINR(Math.abs(signed), { showZero: true })} ${signed < 0 ? "Cr" : "Dr"}`;
}

/**
 * Turns the bare "Out by ₹X" badge on the Trial Balance and Balance Sheet into
 * the explanation 0755 wrote a diagnostic for and then never wired to a human:
 * that the difference is in ledger opening balances, which ones, by how much,
 * and — for an admin — the one write that closes it.
 *
 * Rendered only when the statement is actually out. The mid-setup state 0755
 * describes as normal (Opening Balance Equity carrying the not-yet-classified
 * part of a trial balance) does NOT reach this component at all, because in
 * that state the statement tallies — the trigger absorbed each opening balance
 * as it was keyed. See EquityCarriedNote below for that case.
 */
export function OpeningBalanceGap({
  companyId,
  statement,
  reportGap,
  rows,
  equity,
  isAdmin,
  voucherCount,
}: {
  companyId: string;
  /** How to name the statement in prose — "Trial Balance" / "Balance Sheet". */
  statement: string;
  /** The report's own difference, debit-positive. */
  reportGap: number;
  rows: OpeningGapRow[];
  equity: EquityLedger;
  isAdmin: boolean;
  voucherCount: number;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const imbalance = openingImbalance(rows);
  const coverage = gapCoverage(reportGap, imbalance);
  const origin = gapOrigin(equity);
  const plan = equityPlan(imbalance, equity);

  // Nothing to explain: the diagnostic found no unbalanced opening balances,
  // so whatever this report is out by, it is not this. Saying nothing is more
  // honest than guessing — the badge already says the statement is out.
  if (imbalance === 0) return null;

  async function onConfirm() {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await callRpc(createClient(), "balance_opening_balances", {
      p_company_id: companyId,
      p_expected_imbalance: imbalance,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setConfirming(false);
    toast.success(
      `${formatINR(Math.abs(imbalance), { showZero: true })} moved to Opening Balance Equity.`
    );
    router.refresh();
  }

  return (
    <section className="border-b border-border bg-warning-soft px-4 py-4 print:hidden">
      <h2 className="text-sm font-semibold text-ink">
        Out by {formatINR(Math.abs(coverage.reportGap), { showZero: true })} — the opening
        balances don&rsquo;t add up
      </h2>

      {coverage.explainsAll ? (
        <p className="mt-1.5 max-w-3xl text-sm text-ink-soft">
          This {statement} is out by exactly what the ledger opening balances are out by, to the
          paisa. That is worth reading as good news: it means every voucher you have posted
          balances, and the whole difference sits in the opening balances entered against
          individual ledgers, which are stored one per ledger and were never required to add up
          as a set.
        </p>
      ) : (
        <p className="mt-1.5 max-w-3xl text-sm text-ink-soft">
          The ledger opening balances are out by{" "}
          <strong className="font-mono tabular-nums">{drcr(coverage.explained)}</strong>, which is
          part of this {statement}&rsquo;s difference but not all of it —{" "}
          <strong className="font-mono tabular-nums">{drcr(coverage.unexplained)}</strong> comes
          from somewhere else, and this note cannot tell you where. An opening balance sitting on
          an income or expense ledger is one way that happens, since those never appear on a
          Balance Sheet. Worth tracing separately.
        </p>
      )}

      <p className="mt-2 max-w-3xl text-sm text-ink-soft">
        {origin === "before_safeguard" ? (
          voucherCount > 0 ? (
            <>
              There is no <em>Opening Balance Equity</em> ledger in these books. Since this app
              started offsetting opening balances automatically, the first one entered creates
              that ledger — so its absence means every opening balance here was keyed in before
              that safeguard existed. With {voucherCount.toLocaleString("en-IN")} voucher
              {voucherCount === 1 ? "" : "s"} already posted, this is not a half-finished setup:
              the difference has been carried in these books since before the safeguard shipped.
              (The same reading fits a company whose Opening Balance Equity ledger was deleted by
              hand, which nothing currently prevents.)
            </>
          ) : (
            <>
              There is no <em>Opening Balance Equity</em> ledger in these books, so these opening
              balances were keyed in before this app started offsetting them automatically. No
              vouchers have been posted yet either — so you may simply be part-way through
              entering the opening trial balance, in which case entering the rest of it will close
              this gap on its own and nothing here needs fixing.
            </>
          )
        ) : (
          <>
            This company does have an <em>Opening Balance Equity</em> ledger, so opening balances
            entered from now on are offset automatically as you go and cannot unbalance the books.
            A difference at this point means that ledger&rsquo;s own balance was changed by hand —
            it is the one balance the automatic offset deliberately leaves alone, precisely so a
            human can reclassify it.
          </>
        )}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <caption className="pb-1.5 text-left text-xs font-medium uppercase tracking-wide text-ink-faint">
            Ledgers carrying an opening balance
          </caption>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ledger_id} className="border-b border-border/60">
                <td className="py-1 pr-3">
                  {/* The ledger statement, not a ledger detail page — no
                      /[companyId]/ledgers/[id] route exists, and this is the
                      screen that actually shows what the opening balance did
                      to the ledger's running total. */}
                  <Link
                    href={`/${companyId}/reports/ledger-statement?ledger=${r.ledger_id}`}
                    className="text-ink hover:underline"
                  >
                    {r.ledger_name}
                  </Link>
                </td>
                <td className="py-1 pr-3 text-xs text-ink-faint">{r.group_name}</td>
                <td className="py-1 text-right font-mono tabular-nums text-ink">
                  {drcr(signedOf(Number(r.opening_balance_amount), r.opening_balance_type))}
                </td>
              </tr>
            ))}
            <tr className="border-t border-border-strong font-semibold">
              <td className="py-1 pr-3" colSpan={2}>
                Difference
              </td>
              <td className="py-1 text-right font-mono tabular-nums text-ink">
                {drcr(imbalance)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-3 max-w-3xl text-sm text-ink-soft">
        The real fix is to correct whichever opening balance is actually wrong, on the ledger
        itself — which one, and by how much, is a fact about what happened to real money that only
        your own records can settle, so nothing here guesses at it. If you would rather park the
        difference and have the statements tally in the meantime, move it to{" "}
        <em>Opening Balance Equity</em>: the standing account this app uses for the part of an
        opening trial balance that has not been classified yet, meant to be journalled out to
        Capital or Reserves once the entry is complete.
      </p>

      {!isAdmin ? (
        <p className="mt-3 text-xs text-ink-faint">
          Only a company admin can change an opening balance, so only an admin can move this. Ask
          one to do it, or correct the ledger the difference really belongs to.
        </p>
      ) : !confirming ? (
        <div className="mt-3">
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>
            Move {formatINR(Math.abs(imbalance), { showZero: true })} to Opening Balance Equity…
          </Button>
        </div>
      ) : (
        <div className="mt-3 max-w-2xl rounded-lg border border-border-strong bg-surface p-3.5">
          <h3 className="text-sm font-semibold text-ink">Before you confirm</h3>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink-soft">
            <li>
              {plan.creates ? (
                <>
                  A ledger called <strong>Opening Balance Equity</strong> will be created under
                  this company&rsquo;s Capital Account group, with an opening balance of{" "}
                  <strong className="font-mono tabular-nums">
                    {drcr(plan.targetSigned)}
                  </strong>
                  .
                </>
              ) : (
                <>
                  <strong>Opening Balance Equity</strong>&rsquo;s opening balance changes from{" "}
                  <span className="font-mono tabular-nums">{drcr(plan.previousSigned)}</span> to{" "}
                  <strong className="font-mono tabular-nums">{drcr(plan.targetSigned)}</strong>.
                </>
              )}
            </li>
            <li>
              No voucher is posted, and no other ledger&rsquo;s opening balance is touched. Nothing
              in any period, any GST return or any P&amp;L figure moves.
            </li>
            <li>
              Afterwards the Trial Balance and the Balance Sheet both tally, and this note
              disappears.
            </li>
            <li>
              It is not one-way: you can change or clear that balance again from the ledger
              itself, or journal it out to Capital / Reserves, exactly as you would any other
              opening balance.
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" busy={busy} busyLabel="Moving…" onClick={onConfirm}>
              Confirm — move {formatINR(Math.abs(imbalance), { showZero: true })}
            </Button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              className="text-xs font-medium text-ink-faint hover:text-ink"
            >
              Cancel
            </button>
            {error && <p className="text-xs text-error">{error}</p>}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The other half of telling this story honestly: a company that is BALANCED
 * but whose Opening Balance Equity ledger carries a figure is not broken. It is
 * the ordinary mid-setup state 0755's header describes — the automatic offset
 * absorbing an opening trial balance that has not been fully classified yet.
 * Without saying so, a user who found this note's louder sibling above would
 * reasonably read that balance as a fault too.
 */
export function EquityCarriedNote({
  companyId,
  equity,
}: {
  companyId: string;
  equity: EquityLedger;
}) {
  if (!equity) return null;
  const signed = signedOf(Number(equity.opening_balance_amount), equity.opening_balance_type);
  if (signed === 0) return null;

  return (
    <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
      <Link
        href={`/${companyId}/reports/ledger-statement?ledger=${equity.id}`}
        className="underline"
      >
        Opening Balance Equity
      </Link>{" "}
      carries {drcr(signed)}. That is not an error: it is the part of this company&rsquo;s opening
      trial balance that has not been classified yet, held there automatically so the books stay
      balanced while you key the rest in. Journal it out to Capital or Reserves — or reduce it by
      entering the opening balances it is standing in for — once the entry is complete.
    </p>
  );
}
