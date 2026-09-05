/**
 * Provider-agnostic GST Suvidha Provider (GSP) submission interface.
 *
 * WHY THIS EXISTS NOW, WITHOUT A CHOSEN PROVIDER. e-invoice IRN generation,
 * e-Way Bill generation and GSTR-1/3B filing are all prep-only in this app
 * today: build_einvoice_json (0230) and build_ewb_json (0190/0500/0510)
 * assemble a NIC-schema payload the preparer copies into a GSP portal or the
 * NIC offline utility by hand, and the /einvoice and /eway-bill screens only
 * let them paste back whatever the portal returned (irn/ackNumber/ackDate/
 * signedQrPayload; ewbNumber/ewbGeneratedDate/ewbValidUntil) — see
 * components/einvoice/EinvoiceDetailForm.tsx and
 * components/eway-bill/EwbDetailsForm.tsx. GSTR-1/3B filing has no submit
 * path at all; reports/gstr1-summary and reports/gstr3b-prep are read-only
 * prep reports.
 *
 * Which GSP to integrate with (Sandbox.co.in and MasterGST were the two
 * candidates prior research turned up) is a pending BUSINESS decision, not
 * a technical one, and this file does not make it. What it does instead is
 * fix the SEAM: one interface every future GSP adapter implements, so that
 * once a provider is chosen the work is "write one adapter class", not
 * "figure out where in three different screens a fetch call belongs and
 * what shape it returns". Nothing in this file makes a network call.
 *
 * NAMING. Every field below is the exact name an existing LEKHA table or
 * screen already uses for the same fact, not a fresh name for it:
 *   - irn, ackNumber, ackDate: einvoice_details.irn/ack_number/ack_date
 *     (0230), and the same three names EinvoiceDetailForm.tsx's own local
 *     state already uses.
 *   - signedQrPayload: einvoice_details.signed_qr_payload — the IRP's own
 *     "SignedQRCode" string, camelCased to this app's column name rather
 *     than either the portal's PascalCase or a generic "qrCode".
 *   - ewbNumber, ewbGeneratedDate, ewbValidUntil: ewb_details.ewb_number/
 *     ewb_generated_date/ewb_valid_until (0190), and EwbDetailsForm.tsx's
 *     own state variables of the same names.
 *   - acknowledgementNumber, filedDate: filing_register.acknowledgement_number
 *     /filed_date (0095) — the one existing table that already models
 *     "a compliance document was filed with a government portal outside
 *     this app, and here is the reference number and date it gave back."
 *     That is exactly what a filed GSTR-1/3B is, so fileGstReturn's result
 *     is shaped like a filing_register row, not like an einvoice ack (a
 *     GSTR filing ARN is a materially different, unvalidated-format string
 *     from an IRP ack_number — see filing_register's migration header on
 *     why ARN/SRN/IT-ack formats are deliberately never validated).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No auth/credential handling, no HTTP,
 * no retry or idempotency policy, no GST-portal error-code mapping, and no
 * wiring into any screen's submit button — none of that can be built sanely
 * before a provider is chosen (auth flows, error codes and rate limits are
 * provider-specific), and no screen currently has a submit button for this
 * to attach to. See lib/gsp/mockAdapter.ts for the one adapter that exists
 * today, used for local development and tests only.
 */

/** A failed GSP call. Every real GSP returns *some* error payload (a code
 * and a message, typically) on rejection — this stays a single free-text
 * `error` field, deliberately as unvalidated as filing_register's own
 * acknowledgement_number, because a real adapter will need to translate a
 * provider-specific error shape into this ONE string, and guessing at a
 * structured shape (errorCode, errorField, ...) before any real provider's
 * actual error responses have been seen would be inventing a contract this
 * interface cannot yet honour. */
export type GspError = { error: string };

/** Either the operation's own result, or a GspError. Every GspAdapter method
 * returns this rather than throwing, so a caller always gets a value back to
 * show the preparer instead of an unhandled rejection — the same "errors are
 * data, not exceptions" shape the RPC layer already uses (see
 * lib/supabase/rpc.ts's callRpc, which returns `{ data, error }`). */
export type GspResult<T> = T | GspError;

export function isGspError<T>(result: GspResult<T>): result is GspError {
  return typeof result === "object" && result !== null && "error" in result;
}

/** The NIC e-invoice schema v1.1 JSON build_einvoice_json (0230) already
 * assembles from a posted sales invoice / credit note — see
 * lib/utils/einvoice.ts for the client-side conformance checks run against
 * this exact shape before a preparer would submit it. Kept as a bag of
 * unknowns here rather than a typed NIC schema: this file's job is the
 * submission seam, not re-modelling a schema build_einvoice_json already
 * owns. */
export type EinvoicePayload = Record<string, unknown>;

export type EinvoiceSubmitResult = {
  /** 64 lowercase hex characters — same shape einvoice_details.irn's own
   * CHECK constraint enforces (0230). */
  irn: string;
  /** The IRP's SignedQRCode string, verbatim — see einvoice_details.
   * signed_qr_payload and components/einvoice/EinvoiceQr.tsx, which renders
   * this exact string as the printed invoice's QR. */
  signedQrPayload: string;
  /** Digits only, at most 20 characters — einvoice_details.ack_number's own
   * CHECK constraint (0230). */
  ackNumber: string;
  /** ISO 8601 timestamp — einvoice_details.ack_date is timestamptz. */
  ackDate: string;
};

/** The EWB-01 JSON build_ewb_json (0190/0500/0510) already assembles —
 * ship-to, transporter/vehicle and the invoice's own line data. Kept
 * unknown-shaped for the same reason as EinvoicePayload above. */
export type EwayBillPayload = Record<string, unknown>;

export type EwayBillSubmitResult = {
  /** 12 digits — ewb_details.ewb_number's own CHECK constraint (0190). */
  ewbNumber: string;
  /** ISO 8601 timestamp — ewb_details.ewb_generated_date. Required
   * alongside ewbNumber: 0190's own CHECK constraint refuses status =
   * 'generated' unless both are present together, so an adapter result
   * missing this cannot actually be recorded as a generated e-Way Bill. */
  ewbGeneratedDate: string;
  /** ISO 8601 timestamp — ewb_details.ewb_valid_until. Real validity is
   * distance/mode-dependent under CGST Rule 138(10); computing it is the
   * GSP/NIC portal's job, not this interface's — an adapter simply hands
   * back whatever the portal decided. */
  ewbValidUntil: string;
};

/** No GSTR-1/3B JSON-schema builder exists yet in this app — unlike
 * e-invoice and e-Way Bill, reports/gstr1-summary and reports/gstr3b-prep
 * are read-only prep reports, not payload builders. So this payload stays a
 * generic (formCode, periodLabel, data) envelope, named after
 * filing_register's own columns (0095) rather than invented fresh, until a
 * real return-JSON builder exists for a chosen provider to consume. */
export type GstReturnFilingPayload = {
  /** e.g. "GSTR-1", "GSTR-3B" — free text, not an enum, same reasoning as
   * filing_register.form_code (0095): the set of GST return forms is not
   * this interface's to fix in stone. */
  formCode: string;
  /** e.g. "Apr-2026" or "Q1-2026-27" — filing_register.period_label is the
   * same free-text grain-agnostic label for the same reason (0095). */
  periodLabel: string;
  /** The return body a chosen provider's API actually wants. Provider-
   * specific until one is chosen; not modelled further here. */
  data: Record<string, unknown>;
};

export type GstReturnFilingResult = {
  /** ARN, or whatever reference the filing portal returns — mirrors
   * filing_register.acknowledgement_number (0095), including that
   * migration's deliberate choice not to validate its format: ARN (GST),
   * SRN (MCA) and an income-tax acknowledgement number are three unrelated
   * shapes from three unrelated portals, and GST return filing is only one
   * of them. */
  acknowledgementNumber: string;
  /** Date the return was actually filed — mirrors filing_register.filed_date
   * (a date, not a timestamp: that table's own CHECK constraint requires
   * this to be present exactly when status = 'filed'). */
  filedDate: string;
};

/**
 * Implemented once per GSP. Every method takes the payload this app already
 * builds (or, for fileGstReturn, a lightweight envelope around one) and
 * returns a GspResult — never throws for an ordinary rejection (a bad
 * payload, an expired token, a provider-side validation failure); throwing
 * stays reserved for something a caller genuinely cannot recover from
 * (a network layer that never got a response at all).
 *
 * `providerName` exists so a caller can log/display which adapter actually
 * handled a call (useful the moment there is more than one — a real adapter
 * next to the mock during a migration from one GSP to another, say).
 */
export interface GspAdapter {
  readonly providerName: string;
  submitEinvoice(payload: EinvoicePayload): Promise<GspResult<EinvoiceSubmitResult>>;
  submitEwayBill(payload: EwayBillPayload): Promise<GspResult<EwayBillSubmitResult>>;
  fileGstReturn(payload: GstReturnFilingPayload): Promise<GspResult<GstReturnFilingResult>>;
}
