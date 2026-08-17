/**
 * Money handling. Amounts are numeric(18,2) in Postgres — exact decimal, not
 * float — so these helpers are about presentation and about summing without
 * reintroducing float error on the client.
 */

/** Rupees to integer paise. Rounds, so 0.1 + 0.2 cannot drift. */
export function toPaise(amount: number): number {
  return Math.round((Number(amount) || 0) * 100);
}

export function fromPaise(paise: number): number {
  return paise / 100;
}

/**
 * Sums in integer paise. Adding rupees as floats is how a voucher that looks
 * balanced on screen gets rejected by the database.
 */
export function sumPaise(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/**
 * Indian digit grouping: 12,34,567.89 — last three digits, then pairs.
 * Intl handles this correctly with the en-IN locale.
 */
export function formatINR(amount: number, opts?: { showZero?: boolean }): string {
  const n = Number(amount) || 0;
  if (n === 0 && !opts?.showZero) return "—";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatINRWithSymbol(amount: number): string {
  return `₹${formatINR(amount, { showZero: true })}`;
}
