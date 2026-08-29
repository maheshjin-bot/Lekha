/**
 * Turns the rows the print page fetches into the single `doc` object the
 * document component renders — pure, so the whole decision of WHAT a printed
 * voucher says can be exercised without a browser, a session or a database.
 *
 * This is split out of the page for a reason that is about verification, not
 * tidiness. The printed document is also the PDF (a headless Chromium is
 * driven over the print page), and the parts of it that are easiest to get
 * wrong — which tax lands in which rate bucket, whether a journal grows an
 * invoice block, whether Rule 48 copy markings are suppressed — are exactly
 * the parts that a screenshot cannot check. Keeping them here means the same
 * function that produces the real page's output can be fed real database rows
 * directly and its answers compared against figures derived by hand.
 *
 * It performs no I/O and knows nothing about Supabase: callers hand it rows.
 */

import { buildUpiPayLink } from "@/lib/utils/upi";
import {
  buildRateWiseBreakup,
  copyLabels,
  documentTitle,
  exportEndorsement,
  isGstDocument,
  isReverseCharge,
} from "@/lib/invoice/taxInvoice";
import type {
  VoucherDoc,
  DocumentLine,
  GstBlock,
} from "@/components/vouchers/VoucherDocument";

/** Heads that belong inside the GST rate-wise table rather than beside it. */
const GST_HEADS = new Set(["cgst", "sgst", "utgst", "igst", "cess"]);

const OTHER_HEAD_LABEL: Record<string, string> = {
  tcs: "TCS",
  tds: "TDS",
};

export type RawVoucher = {
  voucher_number: string;
  voucher_type: string;
  voucher_date: string;
  narration: string | null;
  reference_number: string | null;
  reference_date: string | null;
  total_amount: number | string;
  place_of_supply: string | null;
  supply_type: string | null;
  txn_currency: string;
  exchange_rate: number | string;
};

export type RawItem = {
  id: string;
  quantity: number | string;
  uom: string;
  rate: number | string;
  amount: number | string;
  discount_percent: number | string | null;
  amount_before_discount: number | string | null;
  hsn_sac: string | null;
  description: string | null;
  items: {
    name: string;
    gst_rate_percent: number | string | null;
    cess_rate_percent: number | string | null;
    is_rcm_applicable: boolean | null;
  } | null;
};

export type RawEntry = {
  id: string;
  ledger_id: string;
  debit_amount: number | string;
  credit_amount: number | string;
  narration: string | null;
  ledgers: { name: string } | null;
};

export type RawParty = {
  name: string;
  address: string | null;
  city: string | null;
  pincode: string | null;
  gstin: string | null;
  state_code: string | null;
  phone: string | null;
  email: string | null;
};

export type RawBranch = {
  name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  pincode: string | null;
  state_code: string | null;
  gst_registrations: { gstin: string } | null;
};

export type RawShipTo = {
  ship_to_name: string;
  ship_to_address: string;
  ship_to_city: string | null;
  ship_to_state_code: string;
  ship_to_pincode: string | null;
  ship_to_gstin: string | null;
};

export type RawEinvoice = {
  irn: string | null;
  ack_number: string | null;
  ack_date: string | null;
  signed_qr_payload: string | null;
};

export type RawCompany = {
  name: string;
  legal_name: string | null;
  pan: string | null;
  upi_vpa: string | null;
  print_terms_and_conditions: string | null;
  print_footer_note: string | null;
  print_accent_color: string | null;
  print_paper_size: string | null;
  print_sales_title: string | null;
  print_composition_declaration: boolean | null;
  print_copy_labels: string | null;
  print_declaration_text: string | null;
  print_signatory_name: string | null;
  print_signatory_designation: string | null;
  print_bank_account_name: string | null;
  print_bank_name: string | null;
  print_bank_branch: string | null;
  print_bank_account_number: string | null;
  print_bank_ifsc: string | null;
  print_show_upi_qr: boolean | null;
};

export type BuildInput = {
  voucher: RawVoucher;
  company: RawCompany | null;
  branch: RawBranch | null;
  party: RawParty | null;
  shipTo: RawShipTo | null;
  einvoice: RawEinvoice | null;
  items: RawItem[];
  entries: RawEntry[];
  /** tax_ledger_map rows for this company: which ledger is which tax head. */
  taxMap: { purpose: string; ledger_id: string }[];
  states: { code: string; name: string }[];
  logoDataUri: string | null;
  /** This invoice's own remaining balance, from get_invoice_outstanding. */
  outstandingAmount: number;
};

export type BuiltDocument = {
  /** One entry per statutory copy; a single null entry = one unmarked sheet. */
  copies: (string | null)[];
  paper: "A4" | "Letter";
  doc: Omit<VoucherDoc, "copyLabel">;
};

const num = (v: number | string | null | undefined): number => Number(v ?? 0) || 0;

export function buildVoucherDoc(input: BuildInput): BuiltDocument {
  const { voucher, company, branch, party, shipTo, einvoice, entries, states } = input;
  const isGst = isGstDocument(voucher.voucher_type);
  const items = isGst ? input.items : [];

  const stateName = (code: string | null | undefined): string | null =>
    (code ? states.find((s) => s.code === code)?.name : null) ?? null;

  // ---------------------------------------------------------------------
  // Tax actually POSTED, by head — read from the ledger, never recomputed
  // from rates. A printed document that disagreed with the ledger it came
  // from would be worse than a bare one.
  // ---------------------------------------------------------------------
  const purposeByLedger = new Map(input.taxMap.map((t) => [t.ledger_id, t.purpose]));
  const postedByHead = new Map<string, number>();
  for (const e of entries) {
    const purpose = purposeByLedger.get(e.ledger_id);
    if (!purpose) continue;
    const head = purpose.split("_")[1]; // output_cgst -> cgst, input_igst -> igst
    const amount = num(e.debit_amount) || num(e.credit_amount) || 0;
    postedByHead.set(head, (postedByHead.get(head) ?? 0) + amount);
  }

  const postedGst = {
    cgst: postedByHead.get("cgst") ?? 0,
    // UTGST is the union-territory twin of SGST and posts to its own head.
    // The document shows one "SGST/UTGST" column because exactly one of the
    // two can ever apply to a given supply.
    sgst: (postedByHead.get("sgst") ?? 0) + (postedByHead.get("utgst") ?? 0),
    igst: postedByHead.get("igst") ?? 0,
    cess: postedByHead.get("cess") ?? 0,
  };

  const lines: DocumentLine[] = items.map((l) => ({
    id: l.id,
    itemName: l.items?.name ?? null,
    description: l.description,
    hsnSac: l.hsn_sac,
    quantity: num(l.quantity),
    uom: l.uom,
    rate: num(l.rate),
    amount: num(l.amount),
    discountPercent: num(l.discount_percent),
    amountBeforeDiscount: l.amount_before_discount == null ? num(l.amount) : num(l.amount_before_discount),
  }));

  const taxableValue = lines.reduce((n, l) => n + l.amount, 0);

  // Anything tax_ledger_map knows about that is not a GST head on this
  // supply — TCS under the Income-tax Act being the live example. Kept out
  // of the rate-wise table, because it belongs to no GST rate and no GST
  // head, but inside the total, because that is where it actually is.
  const otherCharges = [...postedByHead.entries()]
    .filter(([head, amount]) => !GST_HEADS.has(head) && amount !== 0)
    .map(([head, amount]) => ({ label: OTHER_HEAD_LABEL[head] ?? head.toUpperCase(), amount }));

  const hasIrn = !!einvoice?.irn;

  const gst: GstBlock | null = isGst
    ? {
        partyLabel:
          voucher.voucher_type === "purchase" || voucher.voucher_type === "debit_note"
            ? "Supplier"
            : "Billed to",
        party: party
          ? {
              name: party.name,
              address: party.address,
              city: party.city,
              pincode: party.pincode,
              gstin: party.gstin,
              stateName: stateName(party.state_code),
              stateCode: party.state_code,
              phone: party.phone,
              email: party.email,
            }
          : null,
        shipTo: shipTo
          ? {
              name: shipTo.ship_to_name,
              address: shipTo.ship_to_address,
              city: shipTo.ship_to_city,
              pincode: shipTo.ship_to_pincode,
              gstin: shipTo.ship_to_gstin,
              stateName: stateName(shipTo.ship_to_state_code),
              stateCode: shipTo.ship_to_state_code,
            }
          : null,
        placeOfSupplyName: stateName(voucher.place_of_supply),
        placeOfSupplyCode: voucher.place_of_supply,
        reverseCharge: isReverseCharge(
          items.map((l) => ({ isRcmApplicable: !!l.items?.is_rcm_applicable }))
        ),
        lines,
        rateBuckets: buildRateWiseBreakup(
          items.map((l) => ({
            amount: num(l.amount),
            gstRatePercent: num(l.items?.gst_rate_percent),
            cessRatePercent: num(l.items?.cess_rate_percent),
          })),
          postedGst
        ),
        taxableValue,
        otherCharges,
        exportEndorsement: exportEndorsement(voucher.supply_type, postedGst.igst),
        einvoice: hasIrn
          ? {
              irn: einvoice!.irn!,
              ackNumber: einvoice!.ack_number,
              ackDate: einvoice!.ack_date ? einvoice!.ack_date.slice(0, 10) : null,
              signedQr: einvoice!.signed_qr_payload,
            }
          : null,
      }
    : null;

  // The QR already printed before migration 0800 existed, so
  // print_show_upi_qr is an opt-OUT: only an explicit false suppresses it.
  //
  // Exports are excluded regardless of the setting. UPI is a domestic Indian
  // rail; an overseas buyer on an export invoice cannot pay with it, so
  // printing "Scan to pay via UPI — 1,00,000.00 due" beside a bank block on a
  // document whose place of supply is "Other Country" offers a settlement
  // route that does not exist for its reader. SEZ and deemed-export supplies
  // are NOT excluded: those recipients are in India and can pay by UPI.
  const isOverseasBuyer =
    voucher.supply_type === "export_igst" || voucher.supply_type === "export_lut";
  const showUpiQr =
    voucher.voucher_type === "sales" &&
    !isOverseasBuyer &&
    !!company?.upi_vpa &&
    input.outstandingAmount > 0 &&
    company.print_show_upi_qr !== false;

  const supplierName = company?.legal_name || company?.name || "";
  const total = num(voucher.total_amount);

  const doc: Omit<VoucherDoc, "copyLabel"> = {
    title: documentTitle(voucher.voucher_type, company?.print_sales_title ?? null),
    compositionDeclaration: company?.print_composition_declaration === true,
    logoDataUri: input.logoDataUri,
    accentColor: company?.print_accent_color ?? null,

    supplierName,
    supplierAddress: branch
      ? [branch.address_line1, branch.address_line2, branch.city, branch.pincode]
          .filter(Boolean)
          .join(", ") || branch.name
      : null,
    supplierGstin: branch?.gst_registrations?.gstin ?? null,
    supplierPan: company?.pan ?? null,
    supplierStateName: stateName(branch?.state_code),
    supplierStateCode: branch?.state_code ?? null,

    voucherNumber: voucher.voucher_number,
    voucherDate: voucher.voucher_date,
    referenceNumber: voucher.reference_number,
    referenceDate: voucher.reference_date,
    narration: voucher.narration,
    totalAmount: total,
    txnCurrency: voucher.txn_currency,
    exchangeRate: num(voucher.exchange_rate),

    gst,
    // Invoice stationery — bank details, UPI QR, terms, declaration — belongs
    // only on a document this company ISSUES to a counterparty. A purchase
    // bill is the supplier's document under the supplier's terms, and a
    // journal or receipt has no counterparty document at all.
    showCommercialTerms:
      voucher.voucher_type === "sales" ||
      voucher.voucher_type === "credit_note" ||
      voucher.voucher_type === "debit_note",
    postings: entries.map((e) => ({
      id: e.id,
      ledgerName: e.ledgers?.name ?? null,
      narration: e.narration,
      debit: num(e.debit_amount),
      credit: num(e.credit_amount),
    })),

    bank: company?.print_bank_account_number
      ? {
          accountName: company.print_bank_account_name,
          bankName: company.print_bank_name,
          branch: company.print_bank_branch,
          accountNumber: company.print_bank_account_number,
          ifsc: company.print_bank_ifsc,
        }
      : null,
    upi: showUpiQr
      ? {
          link: buildUpiPayLink({
            vpa: company!.upi_vpa!,
            payeeName: supplierName,
            amount: input.outstandingAmount,
            note: `Invoice ${voucher.voucher_number}`,
            txnRef: voucher.voucher_number,
          }),
          vpa: company!.upi_vpa!,
          amountDue: input.outstandingAmount,
        }
      : null,
    declarationText: company?.print_declaration_text ?? null,
    termsAndConditions: company?.print_terms_and_conditions ?? null,
    footerNote: company?.print_footer_note ?? null,
    signatoryName: company?.print_signatory_name ?? null,
    signatoryDesignation: company?.print_signatory_designation ?? null,
  };

  // Rule 48(1)/(2): a goods invoice is prepared in triplicate and a services
  // invoice in duplicate, each copy marked. Rule 48(6) disapplies both for an
  // e-invoice, so an IRN collapses this back to one unmarked sheet.
  const marks = copyLabels(voucher.voucher_type, company?.print_copy_labels ?? null, hasIrn);

  return {
    copies: marks.length > 0 ? marks : [null],
    paper: company?.print_paper_size === "letter" ? "Letter" : "A4",
    doc,
  };
}
