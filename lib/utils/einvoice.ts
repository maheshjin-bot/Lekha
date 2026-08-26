/**
 * Client-side conformance checks against the NIC e-invoice schema, run on
 * the payload build_einvoice_json (0230) already produced. These are
 * deliberately NOT enforced in the SQL function itself — the function
 * builds the payload from what is actually on the invoice (a real document
 * number, a real HSN code) rather than silently truncating or padding it to
 * fit the IRP's own rules, since that would make the JSON disagree with the
 * document it is describing. This is where that honesty surfaces to the
 * user instead: a loud banner naming exactly what will not validate at the
 * IRP and why, so fixing it (renumbering a voucher series, adding digits to
 * an HSN code) is an informed choice made deliberately, not a silent
 * mutation.
 */

export type EinvoiceWarning = { field: string; message: string };

/** Rule 46(b) CGST Rules: at most 16 characters, letters/digits/hyphen/slash only. */
const DOC_NO_RE = /^[A-Za-z0-9/-]{1,16}$/;

/** e-invoice schema: HsnCd is 6-8 characters (below the 5cr turnover slab a
 * 4-digit HSN is valid for GSTR-1 but not for e-invoicing — see 0230). */
const HSN_MIN_LEN = 6;

export function checkEinvoicePayload(payload: unknown): EinvoiceWarning[] {
  const warnings: EinvoiceWarning[] = [];
  if (!payload || typeof payload !== "object") return warnings;
  const p = payload as Record<string, unknown>;

  const docNo = (p.DocDtls as Record<string, unknown> | undefined)?.No;
  if (typeof docNo === "string" && !DOC_NO_RE.test(docNo)) {
    warnings.push({
      field: "DocDtls.No",
      message: `The invoice number "${docNo}" is ${docNo.length} characters — the e-invoice schema (Rule 46(b) CGST Rules) allows at most 16, letters/digits/hyphen/slash only. The IRP will reject this as-is; you'll need to shorten or reformat it before submitting.`,
    });
  }

  const items = Array.isArray(p.ItemList) ? (p.ItemList as Record<string, unknown>[]) : [];
  const shortHsn = new Set<string>();
  for (const item of items) {
    const hsn = item.HsnCd;
    if (typeof hsn === "string" && hsn.length < HSN_MIN_LEN) shortHsn.add(hsn);
  }
  if (shortHsn.size > 0) {
    warnings.push({
      field: "ItemList[].HsnCd",
      message: `HSN code${shortHsn.size > 1 ? "s" : ""} ${[...shortHsn].map((h) => `"${h}"`).join(", ")} ${shortHsn.size > 1 ? "have" : "has"} fewer than 6 digits. A 4-digit HSN is valid for GSTR-1 below the e-invoice turnover threshold, but the e-invoice schema itself wants 6-8. Update the item master before submitting.`,
    });
  }

  const supTyp = (p.TranDtls as Record<string, unknown> | undefined)?.SupTyp;
  if ((supTyp === "EXPWP" || supTyp === "EXPWOP") && p.ExpDtls) {
    const exp = p.ExpDtls as Record<string, unknown>;
    if (!exp.CntCode) {
      warnings.push({
        field: "ExpDtls.CntCode",
        message: "This is an export invoice, and the e-invoice schema requires the buyer's 2-letter destination country code (ExpDtls.CntCode) — this app does not capture a country anywhere, so it is missing here. Add it manually before submitting.",
      });
    }
  }

  return warnings;
}
