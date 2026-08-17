/**
 * Amount in words, Indian system — lakh and crore, not million and billion.
 *
 * Required on a tax invoice, and the place a wrong conversion is most visible:
 * a customer reads the words before the figures. Rupees and paise are spelled
 * separately because "one thousand point five zero rupees" is not a thing.
 */

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function underThousand(n: number): string {
  if (n === 0) return "";
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const o = ONES[n % 10];
    return o ? `${t} ${o}` : t;
  }
  const rest = underThousand(n % 100);
  return rest ? `${ONES[Math.floor(n / 100)]} Hundred ${rest}` : `${ONES[Math.floor(n / 100)]} Hundred`;
}

/** Whole number to Indian-system words. */
export function numberToWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return "Zero";

  // Indian grouping: crore, lakh, thousand, then the last three digits.
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${underThousand(crore)} Crore`);
  if (lakh) parts.push(`${underThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${underThousand(thousand)} Thousand`);
  if (rest) parts.push(underThousand(rest));

  return parts.join(" ");
}

/**
 * The full line as it appears on an invoice, e.g.
 * "Rupees One Lakh Twenty Three Thousand and Forty Five Paise Only".
 */
export function amountInWords(amount: number): string {
  const negative = amount < 0;

  // Round to paise FIRST, then split. Flooring the rupees and rounding the
  // remainder separately lets the two disagree: 99.999 became "Ninety Nine and
  // One Hundred Paise", which is not an amount. Rounding the whole figure once
  // makes it one hundred rupees, which is what the numerals beside it say.
  const totalPaise = Math.round(Math.abs(amount) * 100);
  const rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;

  const parts = [`Rupees ${numberToWords(rupees)}`];
  if (paise > 0) parts.push(`and ${numberToWords(paise)} Paise`);

  return `${negative ? "Minus " : ""}${parts.join(" ")} Only`;
}
