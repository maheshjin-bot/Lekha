/**
 * Amounts in words, Indian style — lakh and crore, not million and billion.
 *
 * Required on an invoice by convention and expected by every bank and
 * assessing officer who reads one, so it is worth getting exactly right:
 * 1,00,000 is "One Lakh", not "Hundred Thousand".
 */

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];

const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
];

/** 0–99. */
function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t} ${o}` : t;
}

/** 0–999. */
function threeDigits(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(" ");
}

/**
 * The whole-rupee part in words. Groups as crore / lakh / thousand / hundred,
 * which is why this cannot be the usual three-digit western grouping.
 */
export function numberToIndianWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return "Zero";

  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;

  const parts: string[] = [];
  // Crores above 99 keep grouping in the Indian style — 1,00,00,00,000 reads
  // as "One Hundred Crore", not "One Arab".
  if (crore) parts.push(`${threeDigits(crore % 1000) || twoDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));

  return parts.join(" ");
}

/**
 * A full amount as it appears at the foot of an invoice.
 *
 * Paise are rounded, not truncated: 0.005 becomes one paisa, matching what the
 * numeric total on the same document shows. Truncating here is how the words
 * and the figures end up a paisa apart.
 */
export function amountInWords(amount: number, currency = "Rupees"): string {
  const negative = amount < 0;
  const totalPaise = Math.round(Math.abs(amount) * 100);
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;

  const parts = [currency, numberToIndianWords(rupees)];
  if (paise > 0) parts.push("and", twoDigits(paise), "Paise");
  parts.push("Only");

  const words = parts.join(" ");
  return negative ? `Minus ${words}` : words;
}
