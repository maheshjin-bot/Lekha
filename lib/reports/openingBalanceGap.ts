/**
 * The arithmetic behind "Out by ₹X" on the Trial Balance and Balance Sheet.
 *
 * 0755 established the underlying fact: a ledger's opening balance is a bare
 * pair of columns on one row, and in books keyed in before that migration
 * nothing required the company-wide set of them to add up. Every report that
 * reads app_private.ledger_opening_signed carries that difference forever.
 * 0755 also shipped get_unbalanced_opening_balances to name the contributing
 * ledgers, and 1350 added balance_opening_balances to move the residue onto
 * the standing Opening Balance Equity ledger.
 *
 * This module is the pure part in the middle — what to claim, and what the
 * repair would write — kept out of the components so it can be tested without
 * a database or a renderer.
 */

/** One row of public.get_unbalanced_opening_balances (0755). */
export type OpeningGapRow = {
  ledger_id: string;
  ledger_name: string;
  group_name: string;
  opening_balance_amount: number;
  opening_balance_type: string;
  opening_signed: number;
  company_total_imbalance: number;
};

/** The standing Opening Balance Equity ledger, or null if none exists yet. */
export type EquityLedger = {
  id: string;
  opening_balance_amount: number;
  opening_balance_type: string;
} | null;

/** Money is numeric(18,2) in Postgres but arrives as a JS number; round every
 * derived figure so a float artefact can never print as 57,499.999999 or make
 * an equality check miss by 1e-10. */
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Debit-positive signed balance, the convention every figure here uses. */
export function signedOf(amount: number, type: string): number {
  return round2(type === "credit" ? -Number(amount) : Number(amount));
}

/**
 * The company-wide opening-balance difference, read off the diagnostic's own
 * repeated company_total_imbalance rather than re-summed from the rows —
 * the rows only include ledgers whose own opening balance is nonzero, so
 * re-summing them would happen to agree today and silently stop agreeing the
 * day that filter changes.
 */
export function openingImbalance(rows: OpeningGapRow[]): number {
  return rows.length === 0 ? 0 : round2(Number(rows[0].company_total_imbalance));
}

export type GapCoverage = {
  /** The report's own difference, debit-positive. */
  reportGap: number;
  /** How much of it the opening balances account for. */
  explained: number;
  /** Whatever is left once the opening balances are taken out. */
  unexplained: number;
  /** True when the opening balances account for the whole difference, to the paisa. */
  explainsAll: boolean;
};

/**
 * Does the opening-balance difference actually explain this report's gap?
 *
 * This is the honesty gate for the whole panel. Both the Trial Balance
 * (closing debits minus closing credits) and the Balance Sheet (assets minus
 * liabilities-plus-profit) are debit-positive, and both equal the sum of every
 * ledger's opening balance when — and only when — nothing else is out. So an
 * exact match is a proof, not a coincidence: it means every voucher balances
 * and the entire difference is opening balances. Anything short of an exact
 * match must be reported as a partial explanation, because the remainder is
 * something this panel genuinely does not know about (a ledger under an
 * income/expense group carries an opening balance the Balance Sheet never
 * shows, for instance).
 */
export function gapCoverage(reportGap: number, imbalance: number): GapCoverage {
  const gap = round2(reportGap);
  const explained = round2(imbalance);
  const unexplained = round2(gap - explained);
  return { reportGap: gap, explained, unexplained, explainsAll: unexplained === 0 };
}

/**
 * How these books came to be out — a structural reading, not a guess.
 *
 * "before_safeguard": no Opening Balance Equity ledger exists. After 0755 the
 *   very first write of any nonzero opening balance creates that ledger as a
 *   side effect of enforce_opening_balance_equity, so its absence alongside a
 *   nonzero total means every opening balance in these books predates the
 *   trigger. (A human who deleted the ledger outright — unguarded, and 0755
 *   says so — also lands here; the copy says both readings out loud rather
 *   than picking one.)
 *
 * "equity_ledger_edited": the ledger does exist, so the automatic offset is
 *   live for this company and every new opening balance is absorbed as it is
 *   entered. The only remaining way to be out is a direct edit to that ledger,
 *   which is exactly the write 0755 deliberately leaves un-offset.
 */
export type GapOrigin = "before_safeguard" | "equity_ledger_edited";

export function gapOrigin(equity: EquityLedger): GapOrigin {
  return equity === null ? "before_safeguard" : "equity_ledger_edited";
}

export type EquityPlan = {
  /** The difference being absorbed, debit-positive. */
  imbalance: number;
  /** Opening Balance Equity's balance today, debit-positive. */
  previousSigned: number;
  previousAmount: number;
  previousType: "debit" | "credit";
  /** What it becomes. */
  targetSigned: number;
  targetAmount: number;
  targetType: "debit" | "credit";
  /** True when the ledger does not exist yet and would be created. */
  creates: boolean;
};

/**
 * Exactly what balance_opening_balances (1350) will write, computed here so
 * the confirmation can show it before anything happens. The RPC recomputes
 * this itself and refuses if the difference has moved since — this is the
 * preview, never the authority.
 *
 * The imbalance already INCLUDES Opening Balance Equity's own current balance,
 * so the new balance is the old one less the total, not simply the negated
 * total. Getting that wrong would double-count any company where the ledger
 * already carries something.
 */
export function equityPlan(imbalance: number, equity: EquityLedger): EquityPlan {
  const total = round2(imbalance);
  const previousSigned = equity
    ? signedOf(Number(equity.opening_balance_amount), equity.opening_balance_type)
    : 0;
  const targetSigned = round2(previousSigned - total);
  return {
    imbalance: total,
    previousSigned,
    previousAmount: Math.abs(previousSigned),
    previousType: previousSigned < 0 ? "credit" : "debit",
    targetSigned,
    targetAmount: Math.abs(targetSigned),
    targetType: targetSigned < 0 ? "credit" : "debit",
    creates: equity === null,
  };
}
