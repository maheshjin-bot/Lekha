/**
 * Rule 46 tax-invoice computation — everything the printed document needs to
 * decide that is arithmetic or statute, and nothing that is layout.
 *
 * This module exists so that the two places a GST document is rendered (the
 * print page at app/(app)/[companyId]/vouchers/[voucherId]/print, which the
 * PDF export route drives a headless Chromium over, and the on-screen
 * voucher detail view) can never disagree about what the tax break-up says.
 * It is pure: no React, no Supabase, no dates, no I/O — so it is unit
 * testable, and tests/unit/tax-invoice.test.ts exercises it against
 * hand-derived figures from real Sharma Textiles invoices.
 *
 * ---------------------------------------------------------------------------
 * STATUTORY BASIS — CGST Rule 46, text read from the CBIC tax repository
 * (taxinformation.cbic.gov.in, chapter6/rule46), not from a summary.
 * ---------------------------------------------------------------------------
 * The particulars a tax invoice must carry, and where each is answered:
 *
 *   (a) supplier name, address, GSTIN ......... branch + its gst_registration
 *   (b) consecutive serial number ............. vouchers.voucher_number
 *   (c) date of issue ......................... vouchers.voucher_date
 *   (d) recipient name/address/GSTIN .......... party ledger
 *   (e) unregistered recipient, value >= 50k:
 *       name, address, address of delivery,
 *       name of State and its code ............ party ledger + voucher_ship_to
 *   (f) same, below 50k, on request ........... same
 *   (g) HSN/SAC ............................... voucher_items.hsn_sac
 *   (h) description ........................... item name + line description
 *   (i) quantity and unit / UQC ............... voucher_items.quantity, uom
 *   (j) total value of supply ................. voucher totals
 *   (k) taxable value after discount .......... voucher_items.amount (0147
 *       already stores the post-discount figure, with the discount itself
 *       kept as its own particular rather than netted silently into the rate)
 *   (l) rate of tax, per head ................. buildRateWiseBreakup, below
 *   (m) amount of tax charged, per head ....... buildRateWiseBreakup, below
 *   (n) place of supply with State name, for
 *       an inter-State supply ................. vouchers.place_of_supply
 *   (o) address of delivery where different
 *       from the place of supply .............. voucher_ship_to (0805)
 *   (p) whether tax is payable on reverse
 *       charge ................................ isReverseCharge, below
 *   (q) signature of the supplier or his
 *       authorised representative ............. signature block + 0800's
 *       print_signatory_name / _designation
 *   (r) QR code with embedded IRN, where the
 *       invoice was issued under Rule 48(4) ... einvoice_details (0230)
 *
 * First proviso (export / SEZ): the endorsement in exportEndorsement() below,
 * quoted verbatim, plus recipient name, ADDRESS OF DELIVERY and NAME OF THE
 * COUNTRY OF DESTINATION. The country of destination is deliberately absent
 * from this module: public.ledgers has no country column, so there is no
 * honest value to print. See the module note in the print page.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE. It never picks a GST rate,
 * never decides that a supply is inter-State, and never computes tax. Rates
 * come from the item master and tax comes from what was actually posted to
 * the ledger; this module only redistributes the latter across the former.
 * A printed invoice that disagreed with the ledger it came from would be
 * worse than a bare one.
 */

import { toPaise, fromPaise } from "@/lib/utils/currency";

/** One item line, already joined to its item master. */
export type InvoiceLine = {
  /** Post-discount taxable value of this line — Rule 46(k). */
  amount: number;
  /** Read fresh from the item master; voucher_items does not denormalise it. */
  gstRatePercent: number;
  cessRatePercent: number;
};

/** Tax actually posted to the ledger for this voucher, keyed by head. */
export type PostedTax = {
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
};

export type RateBucket = {
  /** The GST rate these lines carry, e.g. 18 for 18%. */
  ratePercent: number;
  /** Sum of the post-discount taxable values in this bucket. */
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
};

/**
 * Splits the tax ACTUALLY POSTED for a voucher across its distinct GST rates
 * — Rule 46(l) and (m), which require the rate and the amount of each head,
 * not one blended total. A real invoice that mixes 18% and 12% lines has to
 * show two rows.
 *
 * THE WEIGHTING, AND WHY IT IS NOT A VALUE SHARE. Each line's claim on the
 * voucher's posted tax is weighted by that line's OWN implied tax (its
 * taxable value times its own rate), not by its taxable value alone. On a
 * voucher that mixes rates those two answers differ, and only the first is
 * right: on ₹5,000 at 18% plus ₹3,000 at 12%, a plain value share would hand
 * the 12% bucket 3/8ths of the tax (₹472.50) when it actually bears ₹360.
 * This is the same allocation migration 0098 established for GSTR-1 Table
 * 12, deliberately so — the printed invoice and the return built from the
 * same voucher now derive their rate split the same way and cannot drift.
 *
 * THE RESIDUAL, AND WHY IT IS NOT OPTIONAL. The weights are ratios, so
 * rounding each bucket to paise can leave the buckets summing to a paisa
 * more or less than the tax genuinely posted. On a report that is noise; on
 * a document a customer reconciles against a payment it is a defect. So the
 * arithmetic is done in integer paise and any residual is folded into the
 * largest bucket, which makes the printed break-up foot EXACTLY to the
 * posted total by construction rather than by luck.
 *
 * Lines carrying no rate at all (an exempt or nil-rated line, or an item
 * master with no rate recorded) still form their own 0% bucket, so the
 * taxable values across buckets always re-sum to the invoice's taxable
 * value and nothing silently disappears.
 */
export function buildRateWiseBreakup(lines: InvoiceLine[], posted: PostedTax): RateBucket[] {
  if (lines.length === 0) return [];

  const impliedGst = lines.map((l) => (l.amount * l.gstRatePercent) / 100);
  const impliedCess = lines.map((l) => (l.amount * l.cessRatePercent) / 100);
  const totalImpliedGst = impliedGst.reduce((n, v) => n + v, 0);
  const totalImpliedCess = impliedCess.reduce((n, v) => n + v, 0);
  const totalAmount = lines.reduce((n, l) => n + l.amount, 0);

  // Group by rate. A Map keeps insertion order, but the buckets are sorted
  // by rate below so the printed table reads low-to-high regardless of the
  // order the lines happen to sit in.
  const byRate = new Map<number, { taxable: number; wGst: number; wCess: number }>();

  lines.forEach((line, i) => {
    const key = Number(line.gstRatePercent) || 0;
    const bucket = byRate.get(key) ?? { taxable: 0, wGst: 0, wCess: 0 };
    bucket.taxable += line.amount;
    // Weight fallbacks mirror 0098: when a voucher has no implied tax at all
    // (every rate zero) fall back to a plain value share so a posted amount
    // is still fully distributed rather than dropped; when it has no value
    // either, there is nothing to distribute.
    bucket.wGst +=
      totalImpliedGst !== 0
        ? impliedGst[i] / totalImpliedGst
        : totalAmount !== 0
          ? line.amount / totalAmount
          : 0;
    bucket.wCess +=
      totalImpliedCess !== 0
        ? impliedCess[i] / totalImpliedCess
        : totalAmount !== 0
          ? line.amount / totalAmount
          : 0;
    byRate.set(key, bucket);
  });

  const rates = [...byRate.keys()].sort((a, b) => a - b);

  // Allocate each head in integer paise, then hand the rounding residual to
  // the bucket with the largest taxable value — deterministic, and it lands
  // where it is least visible as a proportion.
  const allocate = (totalRupees: number, weightOf: (rate: number) => number): Map<number, number> => {
    const totalP = toPaise(totalRupees);
    const out = new Map<number, number>();
    let assigned = 0;
    for (const rate of rates) {
      const p = Math.round(totalP * weightOf(rate));
      out.set(rate, p);
      assigned += p;
    }
    const residual = totalP - assigned;
    if (residual !== 0 && rates.length > 0) {
      const biggest = rates.reduce((best, r) =>
        (byRate.get(r)!.taxable ?? 0) > (byRate.get(best)!.taxable ?? 0) ? r : best
      );
      out.set(biggest, (out.get(biggest) ?? 0) + residual);
    }
    return out;
  };

  const cgst = allocate(posted.cgst, (r) => byRate.get(r)!.wGst);
  const sgst = allocate(posted.sgst, (r) => byRate.get(r)!.wGst);
  const igst = allocate(posted.igst, (r) => byRate.get(r)!.wGst);
  const cess = allocate(posted.cess, (r) => byRate.get(r)!.wCess);

  return rates.map((rate) => ({
    ratePercent: rate,
    taxableValue: fromPaise(toPaise(byRate.get(rate)!.taxable)),
    cgst: fromPaise(cgst.get(rate) ?? 0),
    sgst: fromPaise(sgst.get(rate) ?? 0),
    igst: fromPaise(igst.get(rate) ?? 0),
    cess: fromPaise(cess.get(rate) ?? 0),
  }));
}

/**
 * Rule 46(p) — "whether the tax is payable on reverse charge basis". The only
 * representation of reverse charge in this schema is items.is_rcm_applicable
 * (migration 0102, which put the flag on the item master rather than on the
 * voucher), so a document is a reverse-charge document when any line it
 * carries is flagged. Rule 46(p) requires the particular either way, so the
 * document states "No" explicitly rather than staying silent — silence is
 * indistinguishable from having forgotten the clause.
 */
export function isReverseCharge(lines: { isRcmApplicable: boolean }[]): boolean {
  return lines.some((l) => l.isRcmApplicable);
}

/**
 * The heading. Rule 46 prescribes PARTICULARS, not a title — there is no
 * clause requiring the words "Tax Invoice", and the widely repeated claim
 * that Rule 46(a) mandates the heading is simply wrong (46(a) is the
 * supplier's name, address and GSTIN). The real constraint runs the other
 * way: Sec 31(3)(c) read with Rule 49 requires a BILL OF SUPPLY instead of a
 * tax invoice for an exempt supply or a composition dealer, and Rule 46A
 * allows a single invoice-cum-bill-of-supply for a B2C mix. So the override
 * (companies.print_sales_title, migration 0800) exists to let a company stop
 * printing "Tax Invoice" when it must, never to invent a heading.
 *
 * Only a sales document is affected. A purchase bill is not a document this
 * company issues at all, and Sec 34 names credit and debit notes, so those
 * three headings are fixed.
 */
export function documentTitle(voucherType: string, printSalesTitle: string | null): string {
  if (voucherType !== "sales") {
    return (
      {
        purchase: "Purchase Bill",
        credit_note: "Credit Note",
        debit_note: "Debit Note",
        receipt: "Receipt",
        payment: "Payment Voucher",
        contra: "Contra Voucher",
        journal: "Journal Voucher",
        branch_transfer: "Branch Transfer",
        stock_journal: "Stock Journal",
        delivery_challan_out: "Delivery Challan",
      }[voucherType] ?? "Voucher"
    );
  }
  switch (printSalesTitle) {
    case "bill_of_supply":
      return "Bill of Supply";
    case "invoice_cum_bill_of_supply":
      return "Invoice-cum-Bill of Supply";
    case "invoice":
      return "Invoice";
    case "tax_invoice":
    case "auto":
    default:
      return "Tax Invoice";
  }
}

/**
 * Rule 48(1) and (2) — the copies an invoice is prepared in, and what each is
 * marked. Goods take three (Rule 48(1)); services take two, and the second
 * one is the SUPPLIER'S, not the transporter's (Rule 48(2)) — which is why
 * companies.print_copy_labels is a three-way mode and not a boolean.
 *
 * Rule 48(6), inserted by Notification 68/2019-CT, disapplies sub-rules (1)
 * and (2) entirely for an invoice prepared under sub-rule (4) — an
 * e-invoice. So the moment a document carries an IRN the copy markings must
 * STOP, and it prints once, unmarked. That suppression is the single easiest
 * thing to get wrong here, so it lives in this function rather than in
 * layout, where it could be forgotten in one of the two renderers.
 *
 * Not applied to purchase bills or credit/debit notes: Rule 48 governs the
 * manner of issuing an INVOICE by the supplier, and a purchase bill is the
 * counterparty's document, not ours.
 */
export function copyLabels(
  voucherType: string,
  printCopyLabels: string | null,
  hasIrn: boolean
): string[] {
  if (voucherType !== "sales") return [];
  if (hasIrn) return []; // Rule 48(6)
  if (printCopyLabels === "goods") {
    return ["Original for Recipient", "Duplicate for Transporter", "Triplicate for Supplier"];
  }
  if (printCopyLabels === "services") {
    return ["Original for Recipient", "Duplicate for Supplier"];
  }
  return [];
}

/**
 * The first proviso to Rule 46, quoted verbatim in the capitals the rule
 * itself uses. Which of the two applies is not a preference — it is whether
 * integrated tax was actually paid on the supply, so for an SEZ supply
 * (where either is possible) the answer is read from whether IGST was in
 * fact posted, rather than guessed from the supply type alone.
 *
 * Deemed exports are deliberately absent. The first proviso covers "export
 * of goods or services or both" and supplies to an SEZ unit or developer; a
 * deemed export under Sec 147 is neither, and its endorsement requirements
 * live in the refund machinery (Rule 89), not in Rule 46. Printing an export
 * endorsement on a deemed-export invoice would be stating something the rule
 * does not say.
 */
export function exportEndorsement(supplyType: string | null, igstPosted: number): string | null {
  const onPayment =
    "SUPPLY MEANT FOR EXPORT/SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS ON PAYMENT OF INTEGRATED TAX";
  const underLut =
    "SUPPLY MEANT FOR EXPORT/SUPPLY TO SEZ UNIT OR SEZ DEVELOPER FOR AUTHORISED OPERATIONS UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX";

  switch (supplyType) {
    case "export_igst":
      return onPayment;
    case "export_lut":
      return underLut;
    case "sez":
      return igstPosted > 0 ? onPayment : underLut;
    default:
      return null;
  }
}

/**
 * The print-only CSS the document depends on. Exported as a string rather
 * than written inline in the page for one reason: it is the part of the
 * layout that is INVISIBLE ON SCREEN, so it is the part most likely to be
 * broken without anyone noticing until a customer receives a clipped
 * invoice. Keeping it here lets the PDF verification harness render with
 * byte-identical rules to the real page instead of an approximation of them.
 *
 * What each rule is actually for:
 *   - @page size: driven by companies.print_paper_size. The PDF route passes
 *     preferCSSPageSize so Puppeteer honours this instead of its own format;
 *     without both halves, browser-print and the PDF disagree about paper.
 *   - table-header-group: an invoice long enough to span pages repeats its
 *     column headings on every page, instead of leaving pages 2+ as
 *     unlabelled columns of numbers.
 *   - break-inside on rows and .avoid-break blocks: nothing lands half on one
 *     page and half on the next — least acceptable on the totals block and
 *     the signature, where a split changes what the document appears to say.
 *   - .invoice-copy: each Rule 48(1)/(2) copy starts its own sheet. The last
 *     one must NOT force a break, or every PDF ends with a blank page.
 */
export function printPageCss(paperSize: "A4" | "Letter"): string {
  return `
    @page { size: ${paperSize}; margin: 10mm 9mm; }
    @media print {
      /* A print type scale, which is the normal thing for a document and not
         a trick to squeeze content: the screen is a 16px medium, paper is a
         9-10pt one, and real invoice stationery has always set type smaller
         than a web page. At 15px root, the body text lands near 10pt and the
         fine print near 8.5pt — both comfortably legible — and an ordinary
         invoice that was spilling three or four lines onto a second sheet
         fits one. With Rule 48(1)'s three copies, each spilled sheet costs
         three. */
      html { font-size: 15px; }
      .tax-invoice thead { display: table-header-group; }
      .tax-invoice tfoot { display: table-row-group; }
      .avoid-break, .tax-invoice tr { break-inside: avoid; page-break-inside: avoid; }
      .invoice-copy { break-after: page; page-break-after: always; }
      .invoice-copy:last-child { break-after: auto; page-break-after: auto; }
    }
  `;
}

/** Voucher types that are GST documents — the only ones that grow a bill-to
 * block, a place of supply, a rate-wise break-up or a reverse-charge line. A
 * journal, receipt, payment or contra must print as the plain voucher it is;
 * this predicate is what keeps that true in both renderers. */
export function isGstDocument(voucherType: string): boolean {
  return (
    voucherType === "sales" ||
    voucherType === "purchase" ||
    voucherType === "credit_note" ||
    voucherType === "debit_note"
  );
}
