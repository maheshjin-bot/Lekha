import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { detectAndExtractPdfBankRows, extractBankRowsFromPdf } from "@/lib/csv/bank-pdf-import";
import { BANK_FORMATS, getBankFormat, type BankFormatId } from "@/lib/csv/bank-format-adapters";

export const dynamic = "force-dynamic";

/**
 * POST /api/companies/[companyId]/bank-statement-pdf
 *
 * Server-side counterpart to the CSV bank-statement import that already
 * runs entirely client-side in ReconciliationScreen (Papa.parse on the
 * File object, no server round trip). A PDF needs one: extracting a text
 * layer and reconstructing table columns from glyph positions
 * (lib/csv/bank-pdf-import.ts) uses pdfjs-dist's Node build, which needs
 * Node APIs a client bundle running in the browser does not have (no
 * bundled PDF worker, no canvas) — so unlike CSV, the PDF path makes one
 * request here, gets back the SAME BankCsvRow[] shape Papa.parse already
 * produces, and then rejoins the CSV path's existing buildBankPreview /
 * commitImport pipeline completely unchanged from that point on.
 *
 * WHAT THIS DOES NOT DO. It never reads bank_statement_lines or writes
 * anything — parsing is stateless, the actual insert still happens from
 * the browser via the existing upsert(..., {ignoreDuplicates:true}) RLS
 * path in ReconciliationScreen.commitImport, unchanged by this route. It
 * also does not attempt image OCR — if the uploaded PDF has no extractable
 * text layer (a scanned/photographed statement), pdfjs-dist finds no text
 * items at all and this returns headerFound:false / rows:[], the same
 * "nothing detected" outcome the UI already shows for an unrecognised CSV
 * layout, not a crash.
 *
 * AUTH: session-cookie gated like print-pdf/route.ts, not the key-
 * authenticated app/api/v1/* surface. Membership is checked even though
 * this route never actually reads this company's own data (parsing is
 * pure computation on the uploaded bytes) — matching this app's existing
 * posture of not exposing an authenticated-but-otherwise-open compute
 * endpoint to any signed-in user regardless of company, and because the
 * eventual insert this feeds IS company-scoped and member-gated by RLS.
 */
const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15MB — generous for a text-only multi-page statement, not for a scanned one

export async function POST(request: Request, { params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { data: membership, error: membershipError } = await supabase
    .from("company_members")
    .select("status")
    .eq("company_id", companyId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (membershipError) {
    return NextResponse.json({ error: membershipError.message }, { status: 500 });
  }
  if (!membership || membership.status !== "active") {
    return NextResponse.json({ error: "You are not an active member of this company." }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data with a 'file' field." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "The uploaded file is empty." }, { status: 400 });
  }
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json(
      { error: `File is too large (${Math.round(file.size / 1024 / 1024)}MB). The limit is ${MAX_PDF_BYTES / 1024 / 1024}MB.` },
      { status: 413 }
    );
  }

  const requestedFormatRaw = formData.get("formatId");
  const requestedFormat = typeof requestedFormatRaw === "string" && requestedFormatRaw !== "" ? requestedFormatRaw : null;
  const knownFormatIds = new Set<BankFormatId>(BANK_FORMATS.map((f) => f.id));
  if (requestedFormat && !knownFormatIds.has(requestedFormat as BankFormatId)) {
    return NextResponse.json({ error: `Unknown bank format "${requestedFormat}".` }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    if (requestedFormat) {
      const format = getBankFormat(requestedFormat as BankFormatId);
      const result = await extractBankRowsFromPdf(bytes, format);
      return NextResponse.json({
        rows: result.rows,
        detectedFormatId: result.headerFound ? format.id : null,
        headerFound: result.headerFound,
        pageCount: result.pageCount,
      });
    }

    const outcome = await detectAndExtractPdfBankRows(bytes);
    return NextResponse.json({
      rows: outcome.rows,
      detectedFormatId: outcome.formatId,
      headerFound: outcome.formatId !== null,
      pageCount: outcome.pageCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not read this PDF.";
    return NextResponse.json(
      {
        error: `Could not read this PDF (${message}). If this is a scanned or photographed statement rather than one downloaded directly from your bank's own portal, this app does not extract text from images — re-export a text-based PDF, or use the CSV/Excel import instead.`,
      },
      { status: 422 }
    );
  }
}
