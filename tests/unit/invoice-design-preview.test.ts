import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COMPOSITION_DECLARATION,
  COPY_LABELS,
  InvoiceDesignPreview,
  TITLE_TEXT,
  type PreviewState,
} from "@/components/settings/InvoiceDesignPreview";

/**
 * The invoice-design settings screen (0800) is a form whose only feedback is
 * a live preview, so a preview that quietly stops honouring an option is the
 * one bug that would make the whole screen dishonest. These render the real
 * component to static markup — no jsdom, no testing-library, nothing new in
 * package.json — and assert on what actually comes out.
 *
 * JSX is deliberately avoided: vitest.config.ts includes only tests/​**​/*.test.ts,
 * and that file is shared with other work, so this uses createElement rather
 * than widening the glob.
 */

const DEFAULTS: PreviewState = {
  accentColor: null,
  paperSize: "a4",
  salesTitle: "auto",
  compositionDeclaration: false,
  copyLabels: "none",
  declarationText: "",
  signatoryName: "",
  signatoryDesignation: "",
  bankAccountName: "",
  bankName: "",
  bankBranch: "",
  bankAccountNumber: "",
  bankIfsc: "",
  showUpiQr: true,
  termsAndConditions: "",
  footerNote: "",
};

function render(state: Partial<PreviewState>, upiVpa: string | null = null): string {
  return renderToStaticMarkup(
    createElement(InvoiceDesignPreview, {
      companyName: "Sharma Textiles Private Limited",
      upiVpa,
      logoPreviewUrl: null,
      state: { ...DEFAULTS, ...state },
    })
  );
}

describe("invoice design preview", () => {
  it("at the stored defaults shows a Tax Invoice on A4 with no copy markings, no declaration and no bank block", () => {
    const html = render({});
    expect(html).toContain("Tax Invoice");
    expect(html).toContain("A4");
    expect(html).not.toContain("Duplicate for Transporter");
    expect(html).not.toContain(COMPOSITION_DECLARATION);
    expect(html).not.toContain("Bank details for payment");
    // No accent chosen means the sheet stays ink-on-paper: nothing is
    // filled, which is what today's document actually prints. "No accent"
    // must not silently become "accent = black".
    expect(html).not.toContain("background-color");
  });

  it("renames the document for every legally distinct title, never inventing a fourth name", () => {
    expect(render({ salesTitle: "bill_of_supply" })).toContain("Bill of Supply");
    expect(render({ salesTitle: "invoice_cum_bill_of_supply" })).toContain(
      "Invoice-cum-Bill of Supply"
    );
    expect(render({ salesTitle: "tax_invoice" })).toContain("Tax Invoice");
    // 'auto' means "whatever the print page already does", which today is
    // Tax Invoice — the same string, deliberately.
    expect(TITLE_TEXT.auto).toBe(TITLE_TEXT.tax_invoice);
  });

  it("prints Rule 5(1)(f)'s exact words when the composition declaration is on", () => {
    // Verbatim from the CGST Rules — a paraphrase here would be a compliance
    // defect, not a copy nit, so the constant is asserted character for
    // character rather than matched loosely.
    expect(COMPOSITION_DECLARATION).toBe(
      "Composition taxable person, not eligible to collect tax on supplies"
    );
    expect(render({ compositionDeclaration: true })).toContain(COMPOSITION_DECLARATION);
  });

  it("marks three copies for goods and two for services, and gives services' second copy to the supplier", () => {
    // Rule 48(1) vs 48(2): the difference is not just the count. A services
    // invoice's duplicate is the SUPPLIER's, and printing "Duplicate for
    // Transporter" on it would be wrong.
    expect(COPY_LABELS.goods).toEqual([
      "Original for Recipient",
      "Duplicate for Transporter",
      "Triplicate for Supplier",
    ]);
    expect(COPY_LABELS.services).toEqual(["Original for Recipient", "Duplicate for Supplier"]);

    const goods = render({ copyLabels: "goods" });
    expect(goods).toContain("Triplicate for Supplier");

    const services = render({ copyLabels: "services" });
    expect(services).toContain("Duplicate for Supplier");
    expect(services).not.toContain("Duplicate for Transporter");
  });

  it("shows the bank block only once an account number anchors it, matching the database constraint", () => {
    // companies_print_bank_block_anchored (0800) refuses a bank name with no
    // account number, so the preview must not pretend such a block prints.
    expect(render({ bankName: "HDFC Bank" })).not.toContain("Bank details for payment");

    const withAccount = render({
      bankAccountNumber: "50100123456789",
      bankName: "HDFC Bank",
      bankIfsc: "HDFC0000123",
      bankBranch: "Ring Road, Surat",
    });
    expect(withAccount).toContain("Bank details for payment");
    expect(withAccount).toContain("50100123456789");
    expect(withAccount).toContain("HDFC0000123");
  });

  it("draws a real scannable UPI QR only when a VPA exists and the switch is on", () => {
    const on = render({ showUpiQr: true }, "sharmatextiles@okhdfcbank");
    expect(on).toContain("Scan to pay");
    expect(on).toContain("<svg");

    // Switch off with a VPA on file, and switch on with none — neither may
    // print a QR. The second case is why the column has no CHECK requiring a
    // VPA: it is simply inert.
    expect(render({ showUpiQr: false }, "sharmatextiles@okhdfcbank")).not.toContain("Scan to pay");
    expect(render({ showUpiQr: true }, null)).not.toContain("Scan to pay");
  });

  it("names the signatory above the rule, and falls back to the bare rule when no name is set", () => {
    const named = render({ signatoryName: "Rakesh Sharma", signatoryDesignation: "Director" });
    expect(named).toContain("Rakesh Sharma");
    expect(named).toContain("Director");

    // Rule 46(q) still wants a signature line even when nobody is named, so
    // the block never disappears — it just goes back to the generic label.
    expect(render({})).toContain("Authorised Signatory");
  });

  it("changes the sheet's proportions with the paper size", () => {
    expect(render({ paperSize: "a4" })).toContain("210 / 297");
    expect(render({ paperSize: "letter" })).toContain("216 / 279");
  });

  it("tints the header, table head and total rule with the chosen accent", () => {
    const html = render({ accentColor: "#0F766E" });
    // Three separate places take the accent; a regression that wires up only
    // the header would still contain the colour once, so count them.
    expect(html.split("#0F766E").length - 1).toBeGreaterThanOrEqual(3);
  });
});
