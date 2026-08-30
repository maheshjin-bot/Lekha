import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { analyzeCaptureImage, type CaptureContext } from "@/lib/capture/analyze";
import { mimeForPath } from "@/lib/capture/upload";

export const dynamic = "force-dynamic";

/**
 * POST /api/capture/extract   { draftId }
 *
 * Reads page 1 of a captured document and asks the vision model what it says
 * (migration 0870, section 5). This is the endpoint that MOVES OCR from
 * capture time to review time: 0740 analysed every upload as it arrived, so a
 * shop floor photographing everything that crosses the counter paid for a
 * vision call on paper nobody ever opened. Now the call is spent only when a
 * reviewer actually opens the document.
 *
 * Reuses lib/capture/analyze.ts unchanged — same Gemini models, same
 * two-alias fallback, same never-throws contract where a missing key, an
 * outage or an unreadable photo all come back as a low-confidence extraction
 * with a note rather than an exception. Nothing is rewritten here.
 *
 * The extraction is stored through set_capture_draft_extraction, which
 * re-checks that the caller may review this company's captures and refuses a
 * draft that is already confirmed or rejected. NOTHING HERE POSTS TO THE
 * LEDGER — a human still reviews the fields and calls create_invoice from the
 * browser, exactly as 0740 required.
 *
 * Safe to call more than once: re-extracting simply overwrites
 * extracted_json and moves extracted_at. That is the "the photo was blurry,
 * try again" button, and it is deliberately not rate-limited here — the
 * per-draft cost of a re-read is one vision call and the reviewer is a human
 * clicking a button.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const draftId = (body as { draftId?: unknown } | null)?.draftId;
  if (typeof draftId !== "string" || !draftId) {
    return NextResponse.json({ error: "draftId is required" }, { status: 400 });
  }

  // Both reads go through ordinary RLS as this user, so a draft belonging to
  // a company they are not a member of simply is not found.
  const { data: draft, error: draftError } = await supabase
    .from("capture_drafts")
    .select("id, company_id, storage_path, status")
    .eq("id", draftId)
    .maybeSingle();
  if (draftError || !draft) {
    return NextResponse.json({ error: "That document could not be found." }, { status: 404 });
  }
  if (draft.status !== "pending_review") {
    return NextResponse.json(
      { error: `This document is already ${draft.status} and cannot be re-read.` },
      { status: 409 }
    );
  }

  const { data: page } = await supabase
    .from("capture_draft_pages")
    .select("storage_path")
    .eq("draft_id", draftId)
    .eq("page_no", 1)
    .maybeSingle();

  // Page 1 if there is one; otherwise the draft's own storage_path, which is
  // where a pre-0870 single-shot upload (and the WhatsApp path) put its only
  // file. A draft that has neither has nothing to read — a path ending in '/'
  // is the folder placeholder create_capture_draft seeds, not an object.
  const path: string | null = page?.storage_path ?? draft.storage_path ?? null;
  if (!path || path.endsWith("/")) {
    return NextResponse.json(
      { error: "This document has no pages to read yet." },
      { status: 400 }
    );
  }

  const { data: blob, error: downloadError } = await supabase.storage
    .from("documents")
    .download(path);
  if (downloadError || !blob) {
    return NextResponse.json(
      { error: downloadError?.message ?? "Could not open that page." },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await blob.arrayBuffer());
  // The stored content type is what the upload declared; the extension is the
  // fallback for the pre-0870 rows whose blob type may come back generic.
  const mime = blob.type && blob.type !== "application/octet-stream"
    ? blob.type
    : mimeForPath(path) ?? "application/octet-stream";

  // Who WE are, so the model can tell a bill we received from one we issued
  // by reading the "Bill to" block rather than guessing. Both lookups are
  // best-effort: CaptureContext is entirely optional and analyzeCaptureImage
  // has a supported no-context branch, so a company with no GST registration
  // (or a failed read) degrades to exactly the pre-context behaviour rather
  // than failing the extraction.
  let context: CaptureContext | undefined;
  if (draft.company_id) {
    const [{ data: company }, { data: registrations }] = await Promise.all([
      supabase.from("companies").select("name").eq("id", draft.company_id).maybeSingle(),
      supabase
        .from("gst_registrations")
        .select("gstin")
        .eq("company_id", draft.company_id)
        .eq("is_active", true),
    ]);
    const gstins = ((registrations ?? []) as { gstin: string | null }[])
      .map((r) => r.gstin?.trim())
      .filter((g): g is string => Boolean(g));
    if (company?.name || gstins.length) {
      context = { companyName: company?.name ?? null, companyGstins: gstins };
    }
  }

  const extracted = await analyzeCaptureImage(buffer, mime, context);

  const { error: saveError } = await supabase.rpc("set_capture_draft_extraction", {
    p_draft_id: draftId,
    p_extracted: extracted,
  });
  if (saveError) {
    // The reading itself succeeded — hand it back so the reviewer can still
    // work from it even though it was not persisted, and say so plainly.
    return NextResponse.json(
      { draftId, extracted, saved: false, error: saveError.message },
      { status: 200 }
    );
  }

  return NextResponse.json({ draftId, extracted, saved: true });
}
