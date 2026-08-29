"use client";

import { UpiPaymentQr } from "@/components/invoices/UpiPaymentQr";
import { buildUpiPayLink } from "@/lib/utils/upi";

/**
 * A miniature, non-interactive stand-in for the printed invoice, redrawn on
 * every keystroke in the settings form beside it.
 *
 * IT IS A PREVIEW, NOT THE DOCUMENT. It deliberately does NOT import the
 * real print layout (app/(app)/[companyId]/vouchers/[voucherId]/print) and
 * must never grow into a second copy of it: that page is a server component
 * fed by seven live queries against a real voucher, and dragging it into a
 * settings screen would mean either faking a voucher or making this screen
 * depend on one existing. What this shows is only the part of the document
 * the settings on this screen actually move — the copy marking, the
 * composition declaration, the logo, the title, the accent, the payment
 * block and the signature block — over fixed dummy party/line data that is
 * obviously dummy (a single "Sample item" row) so nobody mistakes it for
 * their own invoice.
 *
 * Because it is a preview of a PRINTED page it is intentionally rendered on
 * a fixed white sheet with black text rather than the app's theme tokens.
 * A dark-mode preview would be lying about what comes out of the printer.
 */

export const COPY_LABELS: Record<string, string[]> = {
  none: [],
  goods: ["Original for Recipient", "Duplicate for Transporter", "Triplicate for Supplier"],
  services: ["Original for Recipient", "Duplicate for Supplier"],
};

export const TITLE_TEXT: Record<string, string> = {
  auto: "Tax Invoice",
  tax_invoice: "Tax Invoice",
  bill_of_supply: "Bill of Supply",
  invoice_cum_bill_of_supply: "Invoice-cum-Bill of Supply",
  invoice: "Invoice",
};

/** Rule 5(1)(f) CGST Rules, 2017 — verbatim, and it belongs at the top. */
export const COMPOSITION_DECLARATION =
  "Composition taxable person, not eligible to collect tax on supplies";

export type PreviewState = {
  accentColor: string | null;
  paperSize: string;
  salesTitle: string;
  compositionDeclaration: boolean;
  copyLabels: string;
  declarationText: string;
  signatoryName: string;
  signatoryDesignation: string;
  bankAccountName: string;
  bankName: string;
  bankBranch: string;
  bankAccountNumber: string;
  bankIfsc: string;
  showUpiQr: boolean;
  termsAndConditions: string;
  footerNote: string;
};

export function InvoiceDesignPreview({
  companyName,
  upiVpa,
  logoPreviewUrl,
  state,
}: {
  companyName: string;
  upiVpa: string | null;
  logoPreviewUrl: string | null;
  state: PreviewState;
}) {
  // "No accent" is not "accent = black". Today's document draws an UNFILLED
  // table head with a rule under it; filling that bar in near-black would
  // show a design the printer has never produced and would make the Reset
  // control look like it does nothing. So the fill is applied only when a
  // colour has actually been chosen, and the ink fallback is used for rules
  // and text alone.
  const hasAccent = state.accentColor !== null;
  const accent = state.accentColor ?? "#111111";
  const headStyle = hasAccent
    ? { backgroundColor: accent, color: "#ffffff" }
    : { borderBottom: `1px solid ${accent}` };
  const copies = COPY_LABELS[state.copyLabels] ?? [];
  const showBank = state.bankAccountNumber.trim().length > 0;
  const upiLink =
    state.showUpiQr && upiVpa
      ? buildUpiPayLink({
          vpa: upiVpa,
          payeeName: companyName,
          amount: 11800,
          note: "Invoice SI/2026-27/0001",
          txnRef: "SI/2026-27/0001",
        })
      : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs text-ink-faint">
        <span>Preview</span>
        <span className="uppercase tracking-wide">
          {state.paperSize === "letter" ? "Letter · 216 × 279 mm" : "A4 · 210 × 297 mm"}
        </span>
      </div>

      <div
        // The sheet's proportions change with the paper size — the only
        // honest way to show that Letter is wider and shorter than A4.
        style={{ aspectRatio: state.paperSize === "letter" ? "216 / 279" : "210 / 297" }}
        className="overflow-hidden rounded-md border border-border-strong bg-white p-4 text-[7px] leading-snug text-black shadow-card"
      >
        {copies.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {copies.map((label) => (
              <span
                key={label}
                className="rounded-sm border px-1 py-px text-[6px] font-semibold uppercase tracking-wide"
                style={{ borderColor: accent, color: accent }}
              >
                {label}
              </span>
            ))}
          </div>
        )}

        {state.compositionDeclaration && (
          <div className="mb-1.5 text-center text-[6.5px] font-semibold uppercase tracking-wide">
            {COMPOSITION_DECLARATION}
          </div>
        )}

        <div className="border-b-2 pb-1.5 text-center" style={{ borderColor: accent }}>
          {logoPreviewUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- signed/blob preview URL, not a static asset Next's <Image> can optimise.
            <img
              src={logoPreviewUrl}
              alt=""
              className="mx-auto mb-1 max-h-6 max-w-[70px] object-contain"
            />
          )}
          <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: accent }}>
            {TITLE_TEXT[state.salesTitle] ?? "Tax Invoice"}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 border-b py-1.5" style={{ borderColor: "#d4d4d4" }}>
          <div>
            <div className="text-[5.5px] uppercase tracking-wide text-neutral-500">From</div>
            <div className="font-semibold">{companyName}</div>
            <div className="text-neutral-600">GSTIN 24AAACS0000A1Z5</div>
          </div>
          <div>
            <div className="text-[5.5px] uppercase tracking-wide text-neutral-500">Billed to</div>
            <div className="font-semibold">Sample Customer</div>
            <div className="text-neutral-600">GSTIN 24AAACC0000B1Z1</div>
          </div>
        </div>

        <table className="mt-1.5 w-full">
          <thead>
            <tr style={headStyle}>
              <th className="px-1 py-0.5 text-left font-medium">Description</th>
              <th className="px-1 py-0.5 text-left font-medium">HSN</th>
              <th className="px-1 py-0.5 text-right font-medium">Qty</th>
              <th className="px-1 py-0.5 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-1 py-0.5">Sample item</td>
              <td className="px-1 py-0.5">5208</td>
              <td className="px-1 py-0.5 text-right">10</td>
              <td className="px-1 py-0.5 text-right">10,000.00</td>
            </tr>
            <tr className="text-neutral-600">
              <td className="px-1" colSpan={3}>
                CGST 9% + SGST 9%
              </td>
              <td className="px-1 text-right">1,800.00</td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="font-semibold" style={{ borderTop: `1px solid ${accent}` }}>
              <td className="px-1 py-0.5" colSpan={3}>
                Total
              </td>
              <td className="px-1 py-0.5 text-right">11,800.00</td>
            </tr>
          </tfoot>
        </table>

        {showBank && (
          <div className="mt-1.5 border-t pt-1" style={{ borderColor: "#d4d4d4" }}>
            <div className="text-[5.5px] uppercase tracking-wide text-neutral-500">
              Bank details for payment
            </div>
            <div className="text-neutral-700">
              {[state.bankAccountName || companyName, state.bankName, state.bankBranch]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <div className="text-neutral-700">
              A/c {state.bankAccountNumber}
              {state.bankIfsc ? ` · IFSC ${state.bankIfsc}` : ""}
            </div>
          </div>
        )}

        {state.termsAndConditions.trim() && (
          <div className="mt-1.5 border-t pt-1" style={{ borderColor: "#d4d4d4" }}>
            <div className="text-[5.5px] uppercase tracking-wide text-neutral-500">
              Terms &amp; conditions
            </div>
            <div className="line-clamp-2 text-neutral-700">{state.termsAndConditions}</div>
          </div>
        )}

        <div className="mt-2 flex items-end justify-between gap-2">
          <div>
            {upiLink && (
              <div className="flex items-center gap-1">
                <UpiPaymentQr data={upiLink} size={34} />
                <div className="text-neutral-700">
                  <div className="font-semibold text-black">Scan to pay</div>
                  <div className="font-mono text-[5.5px]">{upiVpa}</div>
                </div>
              </div>
            )}
          </div>
          <div className="shrink-0 text-right">
            {state.declarationText.trim() && (
              <div className="mb-1 max-w-[150px] text-[5.5px] text-neutral-600">
                {state.declarationText}
              </div>
            )}
            <div>For {companyName}</div>
            <div className="mt-4 border-t pt-0.5" style={{ borderColor: "#8a8a8a" }}>
              {state.signatoryName ? (
                <>
                  <div className="font-semibold">{state.signatoryName}</div>
                  <div className="text-neutral-600">
                    {state.signatoryDesignation || "Authorised Signatory"}
                  </div>
                </>
              ) : (
                "Authorised Signatory"
              )}
            </div>
          </div>
        </div>

        {state.footerNote.trim() && (
          <div
            className="mt-2 border-t pt-1 text-center text-neutral-500"
            style={{ borderColor: "#d4d4d4" }}
          >
            {state.footerNote}
          </div>
        )}
      </div>

      <p className="text-[11px] text-ink-faint">
        Party, item and tax figures above are dummy data. Only the settings on this screen change
        what you see here.
      </p>
    </div>
  );
}
