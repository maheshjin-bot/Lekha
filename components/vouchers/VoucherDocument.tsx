import { formatINR } from "@/lib/utils/currency";
import { amountInWords } from "@/lib/utils/words";
import { UpiPaymentQr } from "@/components/invoices/UpiPaymentQr";
import { EinvoiceQr } from "@/components/einvoice/EinvoiceQr";
import type { RateBucket } from "@/lib/invoice/taxInvoice";

/**
 * The printed body of a voucher — and, for the four voucher types that are
 * GST documents, a CGST Rule 46 compliant tax invoice.
 *
 * WHAT THIS IS AND WHY IT LOOKS LIKE THIS. This component is deliberately
 * pure and universal: it takes a single fully-computed `doc` prop and
 * renders it. It performs no fetching, holds no state, has no "use client"
 * directive and touches no browser API. That matters for one specific
 * reason beyond tidiness — the PDF export route
 * (app/api/companies/[companyId]/vouchers/[voucherId]/print-pdf) does not
 * re-implement this layout; it drives a real headless Chromium over the
 * print page that renders this component. So this file IS the PDF. A layout
 * that only works on screen silently produces a broken PDF, which is why
 * every rule below about page breaks is load-bearing rather than cosmetic.
 *
 * THE HONESTY RULE, WHICH IS THE POINT OF THE WHOLE FILE. Where a particular
 * Rule 46 requires is genuinely not in this database, this component prints
 * NOTHING rather than a plausible-looking value. The two live instances of
 * that today, both stated here so neither looks like an oversight:
 *   - The name of the country of destination, which the first proviso to
 *     Rule 46 requires on an export invoice. public.ledgers has no country
 *     column. An export document therefore carries its endorsement and the
 *     recipient's address, and simply omits the country.
 *   - The signed QR (Rule 46(r)). It is rendered only when
 *     einvoice_details.signed_qr_payload actually holds the IRP's own JWS
 *     token. An IRN with no payload prints the IRN and acknowledgement and
 *     no QR — a QR encoding anything this app invented would be worse than
 *     no QR, because it would scan.
 *
 * NON-GST VOUCHERS ARE NOT INVOICES. A journal, receipt, payment or contra
 * renders as the plain voucher it is: heading, its own reference particulars
 * and its ledger postings. It grows no bill-to block, no place of supply, no
 * ship-to, no tax break-up and no reverse-charge line — every one of those
 * sections is gated on `doc.gst` being present, which the print page only
 * populates for sales/purchase/credit-note/debit-note. This is not a styling
 * preference: a journal that printed a "Billed to —" block and an empty tax
 * table would be asserting things about a transaction that has no customer
 * and no supply.
 */

export type DocumentLine = {
  id: string;
  itemName: string | null;
  description: string | null;
  hsnSac: string | null;
  quantity: number;
  uom: string;
  rate: number;
  amount: number;
  discountPercent: number;
  amountBeforeDiscount: number;
};

export type LedgerPosting = {
  id: string;
  ledgerName: string | null;
  narration: string | null;
  debit: number;
  credit: number;
};

export type PartyBlock = {
  name: string;
  address: string | null;
  city: string | null;
  pincode: string | null;
  gstin: string | null;
  stateName: string | null;
  stateCode: string | null;
  phone: string | null;
  email: string | null;
};

export type ShipToBlock = {
  name: string;
  address: string;
  city: string | null;
  pincode: string | null;
  gstin: string | null;
  stateName: string | null;
  stateCode: string;
};

/** Everything that only exists on a GST document. Absent => plain voucher. */
export type GstBlock = {
  /** "Billed to" / "Supplier", depending on who issued the document. */
  partyLabel: string;
  party: PartyBlock | null;
  shipTo: ShipToBlock | null;
  placeOfSupplyName: string | null;
  placeOfSupplyCode: string | null;
  /** Rule 46(p) — stated either way, never left silent. */
  reverseCharge: boolean;
  lines: DocumentLine[];
  /** Rule 46(l),(m) — one row per distinct rate. */
  rateBuckets: RateBucket[];
  taxableValue: number;
  /** Heads posted outside the GST rate table, e.g. TCS. */
  otherCharges: { label: string; amount: number }[];
  /** First proviso to Rule 46, verbatim, or null. */
  exportEndorsement: string | null;
  einvoice: { irn: string; ackNumber: string | null; ackDate: string | null; signedQr: string | null } | null;
};

export type VoucherDoc = {
  title: string;
  /** One of Rule 48(1)/(2)'s markings, or null for a single unmarked copy. */
  copyLabel: string | null;
  /** Rule 5(1)(f), verbatim, when the company is a composition dealer. */
  compositionDeclaration: boolean;
  logoDataUri: string | null;
  accentColor: string | null;

  supplierName: string;
  supplierAddress: string | null;
  supplierGstin: string | null;
  supplierPan: string | null;
  supplierStateName: string | null;
  supplierStateCode: string | null;

  voucherNumber: string;
  voucherDate: string;
  referenceNumber: string | null;
  referenceDate: string | null;
  narration: string | null;
  totalAmount: number;
  txnCurrency: string;
  exchangeRate: number;

  /** Present only for sales/purchase/credit-note/debit-note. */
  gst: GstBlock | null;
  /**
   * Whether this is a commercial document THIS company issues to a
   * counterparty — a sales invoice or a credit/debit note — as opposed to a
   * purchase bill (the supplier's document, under the supplier's terms) or a
   * journal/receipt/payment (no counterparty document at all).
   *
   * It gates the invoice stationery: bank details "for payment", the UPI QR,
   * the terms and conditions, and the company's declaration. That gate is not
   * cosmetic. Migration 0800's declaration text reads "We declare that this
   * invoice shows the actual price of the goods described…"; printed at the
   * foot of a journal voucher recording an opening capital introduction, it
   * is a statement about goods that do not exist. Bank details captioned "for
   * payment" on a receipt the company itself issued are similarly backwards.
   */
  showCommercialTerms: boolean;
  /** Always present — what the voucher actually did to the ledger. */
  postings: LedgerPosting[];

  bank: {
    accountName: string | null;
    bankName: string | null;
    branch: string | null;
    accountNumber: string;
    ifsc: string | null;
  } | null;
  upi: { link: string; vpa: string; amountDue: number } | null;
  declarationText: string | null;
  termsAndConditions: string | null;
  footerNote: string | null;
  signatoryName: string | null;
  signatoryDesignation: string | null;
};

const RULE_5_1_F =
  "Composition taxable person, not eligible to collect tax on supplies";

function joinAddress(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(", ");
}

/** "Delhi (07)" — Rule 46(e)/(f) and (n) both want the State AND its code. */
function stateWithCode(name: string | null, code: string | null): string | null {
  if (!name && !code) return null;
  if (!code) return name;
  return name ? `${name} (${code})` : code;
}

function PartyAddress({ party }: { party: PartyBlock }) {
  const line = joinAddress([party.address, party.city, party.pincode]);
  const state = stateWithCode(party.stateName, party.stateCode);
  return (
    <>
      <div className="mt-1 font-semibold">{party.name}</div>
      {line && <div className="mt-0.5 text-xs leading-relaxed text-ink-soft">{line}</div>}
      {state && <div className="mt-0.5 text-xs text-ink-soft">State: {state}</div>}
      {party.gstin ? (
        <div className="mt-1 text-xs">
          GSTIN <span className="font-mono">{party.gstin}</span>
        </div>
      ) : (
        <div className="mt-1 text-xs text-ink-faint">Unregistered — no GSTIN on record</div>
      )}
      {(party.phone || party.email) && (
        <div className="mt-0.5 text-xs text-ink-faint">{joinAddress([party.phone, party.email])}</div>
      )}
    </>
  );
}

export function VoucherDocument({ doc }: { doc: VoucherDoc }) {
  const accent = doc.accentColor;
  // NULL accent means NO accent — render exactly as the document always has
  // (unfilled table head, ink rules) rather than defaulting to black, which
  // would show a design the printer has never produced.
  const headStyle = accent ? { backgroundColor: accent, color: "#ffffff" } : undefined;
  const ruleStyle = accent ? { borderColor: accent } : undefined;
  const titleStyle = accent ? { color: accent } : undefined;

  const gst = doc.gst;
  const hasDiscount = !!gst?.lines.some((l) => Number(l.discountPercent) > 0);
  const itemCols = hasDiscount ? 8 : 7;

  // Rule 46(l) asks for the RATE OF TAX — the rate at which tax was charged,
  // not the rate the item master happens to carry. On a document where no GST
  // was charged at all (an export or SEZ supply under LUT, an exempt supply, a
  // composition dealer's bill of supply) printing the master's "18%" beside a
  // nil tax column reads as a claim that 18% was applied and then not
  // collected. It says "Nil" instead. Per-bucket rates stay literal whenever
  // the document did charge tax, so a genuinely mixed invoice — including one
  // with an exempt 0% line beside taxed lines — still shows each real rate.
  const anyTaxCharged = !!gst?.rateBuckets.some(
    (b) => b.cgst !== 0 || b.sgst !== 0 || b.igst !== 0 || b.cess !== 0
  );

  return (
    <article
      className="tax-invoice border border-border-strong bg-surface p-8 text-sm text-ink print:border-0 print:p-0"
      data-copy={doc.copyLabel ?? undefined}
    >
      {/* Rule 5(1)(f) — verbatim, and above everything else on the sheet, so
          it cannot be mistaken for a footnote. */}
      {doc.compositionDeclaration && (
        <p className="mb-3 border border-ink px-3 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wide">
          {RULE_5_1_F}
        </p>
      )}

      <header className="border-b-2 border-ink pb-4" style={ruleStyle}>
        {doc.logoDataUri && (
          // eslint-disable-next-line @next/next/no-img-element -- inline data: URI, not a static asset Next's <Image> can optimise.
          <img
            src={doc.logoDataUri}
            alt={`${doc.supplierName} logo`}
            className="mx-auto mb-2 max-h-16 max-w-[200px] object-contain"
          />
        )}
        <h1
          className="text-center text-lg font-semibold uppercase tracking-wide"
          style={titleStyle}
        >
          {doc.title}
        </h1>
        {/* Rule 48(1)/(2). Suppressed upstream once an IRN exists — Rule 48(6). */}
        {doc.copyLabel && (
          <p className="mt-1 text-center text-[10px] uppercase tracking-widest text-ink-soft">
            {doc.copyLabel}
          </p>
        )}
      </header>

      {/* First proviso to Rule 46 — the endorsement is part of the document's
          legal effect, so it sits directly under the heading, not in a
          footnote. */}
      {gst?.exportEndorsement && (
        <p className="mt-3 border border-ink px-3 py-2 text-center text-[11px] font-semibold uppercase leading-snug tracking-wide">
          {gst.exportEndorsement}
        </p>
      )}

      {/* Rule 46(a) supplier, (d)-(f) recipient, (o) address of delivery — all
          three side by side, the way an invoice with a separate consignee has
          always been laid out. Stacking the delivery address in its own band
          below cost roughly 90px, which was the difference between one sheet
          and two on an otherwise ordinary invoice; with Rule 48(1)'s three
          copies that is three wasted sheets per document. */}
      <section
        className={`avoid-break grid gap-6 border-b border-border-strong py-4 ${
          gst?.shipTo ? "sm:grid-cols-3" : "sm:grid-cols-2"
        }`}
      >
        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-faint">From</div>
          <div className="mt-1 font-semibold">{doc.supplierName}</div>
          {doc.supplierAddress && (
            <div className="mt-0.5 text-xs leading-relaxed text-ink-soft">{doc.supplierAddress}</div>
          )}
          {stateWithCode(doc.supplierStateName, doc.supplierStateCode) && (
            <div className="mt-0.5 text-xs text-ink-soft">
              State: {stateWithCode(doc.supplierStateName, doc.supplierStateCode)}
            </div>
          )}
          {doc.supplierGstin ? (
            <div className="mt-1 text-xs">
              GSTIN <span className="font-mono">{doc.supplierGstin}</span>
            </div>
          ) : (
            doc.supplierPan && (
              <div className="mt-1 text-xs">
                PAN <span className="font-mono">{doc.supplierPan}</span>
              </div>
            )
          )}
        </div>

        {gst && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">{gst.partyLabel}</div>
            {gst.party ? (
              <PartyAddress party={gst.party} />
            ) : (
              <div className="mt-1 text-ink-faint">—</div>
            )}
          </div>
        )}

        {/* Rule 46(o). Labelled "Address of delivery", NOT place of supply —
            under Sec 10(1)(b) IGST Act a delivery made on a third person's
            direction does not move the place of supply, and a document that
            conflated the two would teach its reader the wrong rule. */}
        {gst?.shipTo && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">
              Address of delivery
            </div>
            <div className="mt-1 font-semibold">{gst.shipTo.name}</div>
            <div className="mt-0.5 text-xs leading-relaxed text-ink-soft">
              {joinAddress([gst.shipTo.address, gst.shipTo.city, gst.shipTo.pincode])}
            </div>
            <div className="mt-0.5 text-xs text-ink-soft">
              State: {stateWithCode(gst.shipTo.stateName, gst.shipTo.stateCode)}
            </div>
            {gst.shipTo.gstin && (
              <div className="mt-1 text-xs">
                GSTIN <span className="font-mono">{gst.shipTo.gstin}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Rule 46(b) serial number, (c) date, (n) place of supply, (p) reverse
          charge. */}
      <section className="avoid-break grid grid-cols-2 gap-4 border-b border-border-strong py-3 text-xs sm:grid-cols-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-faint">Number</div>
          <div className="font-mono">{doc.voucherNumber}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-faint">Date</div>
          <div className="tabular-nums font-mono">{doc.voucherDate}</div>
        </div>
        {gst && gst.placeOfSupplyName && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">Place of supply</div>
            <div>{stateWithCode(gst.placeOfSupplyName, gst.placeOfSupplyCode)}</div>
          </div>
        )}
        {gst && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">Reverse charge</div>
            <div>{gst.reverseCharge ? "Yes" : "No"}</div>
          </div>
        )}
        {doc.referenceNumber && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">Reference</div>
            <div>
              {doc.referenceNumber}
              {doc.referenceDate && (
                <span className="text-ink-faint"> · {doc.referenceDate}</span>
              )}
            </div>
          </div>
        )}
        {doc.txnCurrency !== "INR" && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-faint">Currency</div>
            <div>
              {doc.txnCurrency} @ {doc.exchangeRate}
            </div>
          </div>
        )}
      </section>

      {gst ? (
        <>
          {/* Rule 46(g) HSN, (h) description, (i) quantity and unit,
              (k) taxable value after discount. */}
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr
                className="border-b border-ink text-left text-[10px] uppercase tracking-wide"
                style={headStyle}
              >
                <th className="px-1 py-2 font-medium">#</th>
                <th className="px-1 py-2 font-medium">Description</th>
                <th className="px-1 py-2 font-medium">HSN/SAC</th>
                <th className="px-1 py-2 text-right font-medium">Qty</th>
                <th className="px-1 py-2 font-medium">Unit</th>
                <th className="px-1 py-2 text-right font-medium">Rate</th>
                {hasDiscount && <th className="px-1 py-2 text-right font-medium">Discount</th>}
                <th className="px-1 py-2 text-right font-medium">Taxable value</th>
              </tr>
            </thead>
            <tbody>
              {gst.lines.length === 0 && (
                <tr>
                  <td colSpan={itemCols} className="py-8 text-center text-ink-faint">
                    This document has no item lines.
                  </td>
                </tr>
              )}
              {gst.lines.map((l, i) => (
                <tr key={l.id} className="avoid-break border-b border-border">
                  <td className="px-1 py-2 tabular-nums font-mono">{i + 1}</td>
                  <td className="px-1 py-2">
                    {l.itemName ?? "—"}
                    {l.description && (
                      <span className="block text-xs text-ink-soft">{l.description}</span>
                    )}
                  </td>
                  <td className="px-1 py-2 font-mono text-xs">{l.hsnSac ?? "—"}</td>
                  <td className="px-1 py-2 text-right tabular-nums font-mono">{l.quantity}</td>
                  <td className="px-1 py-2">{l.uom}</td>
                  <td className="px-1 py-2 text-right tabular-nums font-mono">
                    {formatINR(l.rate)}
                  </td>
                  {hasDiscount && (
                    <td className="px-1 py-2 text-right tabular-nums font-mono text-xs">
                      {Number(l.discountPercent) > 0
                        ? `${Number(l.discountPercent)}% (−${formatINR(l.amountBeforeDiscount - l.amount)})`
                        : "—"}
                    </td>
                  )}
                  <td className="px-1 py-2 text-right tabular-nums font-mono">
                    {formatINR(l.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Rule 46(l) and (m): the RATE and the AMOUNT of each head. A single
              blended total does not satisfy either clause once an invoice
              mixes rates, which is why this is a table and not three lines.
              The item table above deliberately carries no taxable-value
              footer: this table's first column already totals it per rate,
              and the totals block below states it once more. Three statements
              of one figure is padding, and on a document that must fit a
              sheet, padding costs a page. */}
          {gst.rateBuckets.length > 0 && (
            <section className="avoid-break mt-4">
              <table className="w-full text-xs">
                <caption className="mb-1 text-left text-[10px] uppercase tracking-wide text-ink-faint">
                  Rate-wise tax break-up
                </caption>
                <thead>
                  <tr
                    className="border-b border-ink text-left text-[10px] uppercase tracking-wide"
                    style={headStyle}
                  >
                    <th className="px-1 py-1.5 font-medium">Rate</th>
                    <th className="px-1 py-1.5 text-right font-medium">Taxable value</th>
                    <th className="px-1 py-1.5 text-right font-medium">CGST</th>
                    <th className="px-1 py-1.5 text-right font-medium">SGST/UTGST</th>
                    <th className="px-1 py-1.5 text-right font-medium">IGST</th>
                    <th className="px-1 py-1.5 text-right font-medium">Cess</th>
                  </tr>
                </thead>
                <tbody>
                  {gst.rateBuckets.map((b) => (
                    <tr key={b.ratePercent} className="avoid-break border-b border-border">
                      <td className="px-1 py-1.5 tabular-nums font-mono">
                        {anyTaxCharged ? `${b.ratePercent}%` : "Nil"}
                      </td>
                      <td className="px-1 py-1.5 text-right tabular-nums font-mono">
                        {formatINR(b.taxableValue, { showZero: true })}
                      </td>
                      <td className="px-1 py-1.5 text-right tabular-nums font-mono">
                        {formatINR(b.cgst, { showZero: true })}
                      </td>
                      <td className="px-1 py-1.5 text-right tabular-nums font-mono">
                        {formatINR(b.sgst, { showZero: true })}
                      </td>
                      <td className="px-1 py-1.5 text-right tabular-nums font-mono">
                        {formatINR(b.igst, { showZero: true })}
                      </td>
                      <td className="px-1 py-1.5 text-right tabular-nums font-mono">
                        {formatINR(b.cess, { showZero: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Rule 46(j) total value of supply. Charges that are not GST on
              this supply (TCS under the Income-tax Act, for one) sit here,
              outside the rate table, because they belong to neither a GST
              rate nor a GST head. */}
          <section className="avoid-break mt-4 flex justify-end">
            <table className="w-full text-sm sm:w-2/3">
              <tbody>
                <tr>
                  <td className="px-1 py-1">Taxable value</td>
                  <td className="px-1 py-1 text-right tabular-nums font-mono">
                    {formatINR(gst.taxableValue, { showZero: true })}
                  </td>
                </tr>
                {(["cgst", "sgst", "igst", "cess"] as const).map((head) => {
                  const total = gst.rateBuckets.reduce((n, b) => n + b[head], 0);
                  if (total === 0) return null;
                  const label =
                    head === "sgst" ? "SGST/UTGST" : head === "cess" ? "Cess" : head.toUpperCase();
                  return (
                    <tr key={head} className="text-ink-soft">
                      <td className="px-1 py-1">{label}</td>
                      <td className="px-1 py-1 text-right tabular-nums font-mono">
                        {formatINR(total, { showZero: true })}
                      </td>
                    </tr>
                  );
                })}
                {gst.otherCharges.map((c) => (
                  <tr key={c.label} className="text-ink-soft">
                    <td className="px-1 py-1">{c.label}</td>
                    <td className="px-1 py-1 text-right tabular-nums font-mono">
                      {formatINR(c.amount, { showZero: true })}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-ink font-semibold" style={ruleStyle}>
                  <td className="px-1 py-2" style={titleStyle}>
                    Total
                  </td>
                  <td className="px-1 py-2 text-right tabular-nums font-mono" style={titleStyle}>
                    {formatINR(doc.totalAmount, { showZero: true })}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </>
      ) : (
        /* A journal, receipt, payment or contra prints what it actually did:
           its ledger postings. No item table, no tax, no counterparty block. */
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr
              className="border-b border-ink text-left text-[10px] uppercase tracking-wide"
              style={headStyle}
            >
              <th className="px-1 py-2 font-medium">Ledger</th>
              <th className="px-1 py-2 font-medium">Narration</th>
              <th className="px-1 py-2 text-right font-medium">Debit</th>
              <th className="px-1 py-2 text-right font-medium">Credit</th>
            </tr>
          </thead>
          <tbody>
            {doc.postings.map((p) => (
              <tr key={p.id} className="avoid-break border-b border-border">
                <td className="px-1 py-2 font-medium">{p.ledgerName ?? "—"}</td>
                <td className="px-1 py-2 text-xs text-ink-soft">{p.narration ?? "—"}</td>
                <td className="px-1 py-2 text-right tabular-nums font-mono">
                  {formatINR(p.debit)}
                </td>
                <td className="px-1 py-2 text-right tabular-nums font-mono">
                  {formatINR(p.credit)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ink font-semibold" style={ruleStyle}>
              <td className="px-1 py-2" colSpan={2}>
                {doc.postings.length} line{doc.postings.length === 1 ? "" : "s"}
              </td>
              <td className="px-1 py-2 text-right tabular-nums font-mono">
                {formatINR(
                  doc.postings.reduce((n, p) => n + p.debit, 0),
                  { showZero: true }
                )}
              </td>
              <td className="px-1 py-2 text-right tabular-nums font-mono">
                {formatINR(
                  doc.postings.reduce((n, p) => n + p.credit, 0),
                  { showZero: true }
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      )}

      {/* Conventional on an Indian invoice and expected by most buyers, who
          read the words before the figures. One line rather than a labelled
          block: it is a restatement of the total, not a new particular. */}
      <p className="avoid-break mt-3 border-t border-border-strong pt-2 text-xs">
        <span className="text-ink-faint">Amount in words: </span>
        <span className="font-medium">{amountInWords(doc.totalAmount)}</span>
      </p>

      {doc.narration && <p className="mt-2 text-xs text-ink-soft">{doc.narration}</p>}

      {/* One strip, not three stacked blocks. The e-invoice particulars
          (Rule 46(r)), the bank details and the UPI QR are all "how this
          document is settled and evidenced", they are each narrow, and
          stacking them was what pushed an ordinary two-line invoice onto a
          second sheet — which, with Rule 48(1)'s three copies, meant six
          sheets of paper where three will do. */}
      {(gst?.einvoice || (doc.showCommercialTerms && (doc.bank || doc.upi))) && (
        <section className="avoid-break mt-3 flex flex-wrap items-start gap-x-6 gap-y-3 border-t border-border-strong pt-2 text-xs">
          {gst?.einvoice && (
            <div className="flex min-w-[240px] flex-1 items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-wide text-ink-faint">
                  e-Invoice (Rule 48(4))
                </div>
                <div className="mt-0.5">
                  IRN <span className="break-all font-mono text-[10px]">{gst.einvoice.irn}</span>
                </div>
                {gst.einvoice.ackNumber && (
                  <div className="mt-0.5">
                    Ack. No. <span className="font-mono">{gst.einvoice.ackNumber}</span>
                    {gst.einvoice.ackDate && (
                      <span className="text-ink-faint"> · {gst.einvoice.ackDate}</span>
                    )}
                  </div>
                )}
                {!gst.einvoice.signedQr && (
                  <div className="mt-0.5 text-ink-faint">
                    Signed QR not on record — enter the IRP&apos;s signed QR payload to print it.
                  </div>
                )}
              </div>
              {gst.einvoice.signedQr && (
                <div className="shrink-0">
                  <EinvoiceQr data={gst.einvoice.signedQr} size={92} />
                </div>
              )}
            </div>
          )}
          {doc.showCommercialTerms && doc.bank && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-faint">
                Bank details for payment
              </div>
              {doc.bank.accountName && <div className="mt-0.5">{doc.bank.accountName}</div>}
              {(doc.bank.bankName || doc.bank.branch) && (
                <div className="text-ink-soft">
                  {joinAddress([doc.bank.bankName, doc.bank.branch])}
                </div>
              )}
              <div>
                A/c <span className="font-mono">{doc.bank.accountNumber}</span>
              </div>
              {doc.bank.ifsc && (
                <div>
                  IFSC <span className="font-mono">{doc.bank.ifsc}</span>
                </div>
              )}
            </div>
          )}
          {doc.showCommercialTerms && doc.upi && (
            <div className="flex items-center gap-2">
              <UpiPaymentQr data={doc.upi.link} size={84} />
              <div className="text-ink-soft">
                <div className="font-medium text-ink">Scan to pay via UPI</div>
                <div>{formatINR(doc.upi.amountDue, { showZero: true })} due</div>
                <div className="font-mono text-[10px] text-ink-faint">{doc.upi.vpa}</div>
              </div>
            </div>
          )}
        </section>
      )}

      {doc.showCommercialTerms && doc.termsAndConditions && (
        <section className="avoid-break mt-3 border-t border-border-strong pt-2">
          <div className="text-[10px] uppercase tracking-wide text-ink-faint">
            Terms &amp; conditions
          </div>
          <p className="mt-1 whitespace-pre-line text-xs text-ink-soft">{doc.termsAndConditions}</p>
        </section>
      )}

      {/* Rule 46(q). The proviso waiving a signature covers only an electronic
          invoice issued under the IT Act, 2000 — a printed sheet is not that,
          so the block is always present and only WHO signs is configurable. */}
      <footer className="avoid-break mt-5 flex items-end justify-between gap-6 text-xs">
        <div className="min-w-0 flex-1">
          {doc.showCommercialTerms && doc.declarationText && (
            <p className="max-w-md whitespace-pre-line text-ink-soft">{doc.declarationText}</p>
          )}
          <div className="mt-2 text-ink-faint">This is a computer-generated document.</div>
        </div>
        <div className="shrink-0 text-right">
          <div>For {doc.supplierName}</div>
          {/* Deliberate blank space: somebody has to physically sign here.
              Rule 46(q)'s proviso waives a signature only for an electronic
              invoice issued under the IT Act, 2000, and a printed sheet is
              not that — so the room to sign stays even when the layout is
              tight. */}
          <div className="mt-9 border-t border-border-strong pt-1">
            {doc.signatoryName && <div className="font-medium text-ink">{doc.signatoryName}</div>}
            {doc.signatoryName && doc.signatoryDesignation && (
              <div className="text-ink-soft">{doc.signatoryDesignation}</div>
            )}
            <div className="text-ink-soft">Authorised Signatory</div>
          </div>
        </div>
      </footer>

      {doc.footerNote && (
        <p className="avoid-break mt-4 border-t border-border-strong pt-2 text-center text-xs text-ink-faint">
          {doc.footerNote}
        </p>
      )}
    </article>
  );
}
