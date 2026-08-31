import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  MAX_BYTES,
  capturePagePath,
  isAllowedMime,
  optionalText,
  parsePageNo,
  resolveMime,
  sha256Hex,
} from "@/lib/capture/upload";
import { logError } from "@/lib/errors/logError";

export const dynamic = "force-dynamic";

/**
 * POST /api/capture/upload  (multipart/form-data)
 *
 * The phone scanner's page-upload endpoint (migration 0870). Fields:
 *   file          required  one page image or PDF
 *   companyId     required
 *   pageNo        required  1-based
 *   draftId       optional  omit on the first page; pass it for pages 2..n
 *   branchId      optional
 *   documentType  optional  sales_challan | purchase_invoice | other
 *   vendorHint    optional
 *   note          optional
 *   dedupeKey     optional  stable per physical document, across retries
 *
 * Returns { draftId, pageNo, storagePath }.
 *
 * THIS ROUTE DOES NOT CALL GEMINI, and that is the point. 0740 analysed every
 * upload the moment it arrived; a shop floor photographing everything that
 * crosses the counter would spend a vision call on paper nobody ever opens.
 * Extraction now happens at REVIEW time, in POST /api/capture/extract, on the
 * documents a human actually looks at.
 *
 * NOTHING HERE POSTS TO THE LEDGER. No create_invoice call, no voucher write,
 * no confirmed_voucher_id. That invariant is 0740's and it is preserved
 * unchanged — a human reviews and posts, exactly as before.
 *
 * Everything runs on the CALLER'S OWN session (createClient(), not a
 * service-role client), so the storage write goes through the 'documents'
 * bucket's RLS as this user and every table write goes through a SECURITY
 * DEFINER RPC that re-checks membership itself. A caller who is not a writing
 * member of `companyId` is refused by the database, not merely by this file.
 *
 * ERROR LOG (migration 0950, instrumented here afterwards). Three kinds of
 * failure are recorded under the operation code `capture_upload`, attributed
 * to the company named in the form:
 *
 *   * a page REFUSED for its type or its size — a warning, and the one an
 *     owner is most likely to be asked about, because on a phone it looks like
 *     the scanner simply "didn't work" on some documents and not others;
 *   * a STORAGE write that failed — invisible to everyone today: the phone
 *     shows a raw Supabase string and nothing durable is kept;
 *   * a PAGE ROW that could not be written after the bytes landed — the path
 *     with the compensating delete, and therefore the one where knowing
 *     afterwards what happened matters most.
 *
 * Deliberately NOT instrumented: the missing-field validations (a client bug,
 * and no company is known yet), the 401, the 403 (nothing was lost and the
 * caller has no company to attribute it to), and a failing
 * create_capture_draft — it fails before any bytes move, returns the
 * database's own plain-English refusal, and a retry with the same dedupe key
 * reuses the same draft, so there is nothing for a later reader to reconstruct.
 * That line could be added later if it ever turns out to fire; the point of
 * this list is that it was a decision rather than an oversight.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const file = formData.get("file");
  const companyId = formData.get("companyId");
  const pageNo = parsePageNo(formData.get("pageNo"));
  const draftIdIn = optionalText(formData.get("draftId"));
  const branchId = optionalText(formData.get("branchId"));
  const documentType = optionalText(formData.get("documentType"));
  const vendorHint = optionalText(formData.get("vendorHint"));
  const note = optionalText(formData.get("note"));
  const dedupeKey = optionalText(formData.get("dedupeKey"));

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }
  if (typeof companyId !== "string" || !companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }
  if (pageNo === null) {
    return NextResponse.json(
      { error: "pageNo must be a whole number from 1 to 100." },
      { status: 400 }
    );
  }

  // Fails before a single byte is stored if this caller cannot even see the
  // company they named — companies' own RLS filters to memberships.
  //
  // THIS CHECK MOVED AHEAD OF THE TYPE AND SIZE CHECKS when the error log was
  // wired in, and the reason is attribution, not security. log_error RAISES if
  // the caller is not a member of the company a row is written against, so a
  // rejection logged before membership is known would either be dropped on the
  // floor or recorded with no company at all — and a row with no company is,
  // by 0950's read rule, invisible to the owner who needs it. Confirming
  // membership first means every rejection below lands in the right company's
  // log. Nothing is read from the request twice as a result: request.formData()
  // above has already pulled the whole body into memory either way, so this
  // costs one indexed lookup and no extra bytes. A non-member now sees 403
  // where they previously saw 400 for an oversized file, which is if anything
  // the more correct answer.
  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .maybeSingle();
  if (companyError || !company) {
    return NextResponse.json({ error: "You do not have access to this company." }, { status: 403 });
  }

  const mime = resolveMime(file.type, file.name);
  if (!isAllowedMime(mime)) {
    // A warning, not an error: nothing broke, a document was declined. Worth
    // recording anyway, because from the phone this is indistinguishable from
    // the scanner being broken — and the file NAME (the only part of it stored
    // here) is usually enough to see that a whole folder of .gif screenshots,
    // or one camera app writing an unexpected container, is behind it.
    await logError({
      operation: "capture_upload",
      severity: "warning",
      message: "A scanned page was refused because it is not a kind of file this app can read.",
      detail: `filename ${file.name || "(none)"}, browser said "${file.type || "(nothing)"}", resolved to "${mime || "(unknown)"}"`,
      companyId,
      supabase,
      context: {
        route: "/api/capture/upload",
        reason: "unsupported_type",
        resolvedMime: mime,
        declaredMime: file.type || null,
        pageNo,
      },
    });
    return NextResponse.json(
      { error: "Only JPEG, PNG, WebP, HEIC/HEIF or PDF pages can be captured." },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    await logError({
      operation: "capture_upload",
      severity: "warning",
      message: "A scanned page was refused for being over the 10 MB limit.",
      detail: `filename ${file.name || "(none)"}, ${file.size} bytes against a ${MAX_BYTES}-byte limit`,
      companyId,
      supabase,
      context: {
        route: "/api/capture/upload",
        reason: "over_size_limit",
        bytes: file.size,
        limitBytes: MAX_BYTES,
        resolvedMime: mime,
        pageNo,
      },
    });
    return NextResponse.json({ error: "This page is larger than the 10 MB limit." }, { status: 400 });
  }

  // First page of a new document creates the draft; later pages name it. The
  // RPC is idempotent on (company, dedupeKey), so a phone retrying page 1
  // after a lost response gets the SAME draft back rather than a second one.
  let draftId = draftIdIn;
  let createdDraftHere = false;
  if (!draftId) {
    // `?? undefined` rather than null on every optional argument: supabase-js
    // JSON-encodes the payload, so an undefined value is OMITTED and the SQL
    // parameter's own DEFAULT applies. Passing an explicit null would mean the
    // same thing to Postgres but does not match the generated Args type.
    const { data, error } = await supabase.rpc("create_capture_draft", {
      p_company_id: companyId,
      p_branch_id: branchId ?? undefined,
      p_document_type: documentType ?? "purchase_invoice",
      p_vendor_hint: vendorHint ?? undefined,
      p_note: note ?? undefined,
      p_client_dedupe_key: dedupeKey ?? undefined,
    });
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? "Could not start this document." },
        { status: 400 }
      );
    }
    draftId = data;
    createdDraftHere = true;
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const storagePath = capturePagePath(companyId, draftId, pageNo, mime);

  // Did this page already exist before we touched it? If so, the object at
  // this deterministic path is one the database already points at, and
  // deleting it on a later failure would destroy a good page rather than
  // clean up after ourselves. Checked BEFORE the upload, deliberately.
  const { data: existingPage } = await supabase
    .from("capture_draft_pages")
    .select("id")
    .eq("draft_id", draftId)
    .eq("page_no", pageNo)
    .maybeSingle();
  const pageExistedBefore = Boolean(existingPage);

  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, buffer, { contentType: mime, upsert: true });
  if (uploadError) {
    console.error("[capture/upload] storage write failed", uploadError);
    // Nothing about this reaches anyone today: the phone shows whatever
    // Storage said ("new row violates row-level security policy", "Payload too
    // large") and the owner never learns a scan was lost at all.
    await logError({
      operation: "capture_upload",
      message: "A scanned page could not be saved to storage.",
      detail: uploadError,
      companyId,
      supabase,
      context: {
        route: "/api/capture/upload",
        phase: "storage_upload",
        draftId,
        pageNo,
        storagePath,
        bytes: buffer.length,
      },
    });
    return NextResponse.json({ error: uploadError.message }, { status: 400 });
  }

  const { error: pageError } = await supabase.rpc("add_capture_draft_page", {
    p_draft_id: draftId,
    p_page_no: pageNo,
    p_storage_path: storagePath,
    p_sha256: sha256Hex(buffer),
  });

  if (pageError) {
    // The bytes landed but their metadata row did not — remove the object
    // rather than leave it orphaned in the bucket. Same compensating-delete
    // discipline as components/documents/DocumentAttachments.tsx and the
    // original 0740 route. Skipped when the page already existed, because
    // then the object is not ours to remove (see above).
    if (!pageExistedBefore) {
      await supabase.storage.from("documents").remove([storagePath]);
    }
    // A draft this request created but could not put a page on is left in
    // place on purpose: it holds no pages, is not submitted, appears in
    // nobody's review queue, and a retry with the same dedupeKey reuses it.
    console.error("[capture/upload] could not record the page", pageError);
    // Recorded WITH whether the compensating delete ran, because that is the
    // one fact nobody can recover afterwards: an orphaned object in the bucket
    // and a page that was never ours to delete look identical from outside.
    await logError({
      operation: "capture_upload",
      message: "A scanned page was saved but could not be attached to the document.",
      detail: pageError,
      companyId,
      supabase,
      context: {
        route: "/api/capture/upload",
        phase: "record_page",
        draftId,
        pageNo,
        storagePath,
        objectRemoved: !pageExistedBefore,
      },
    });
    return NextResponse.json(
      { error: pageError.message ?? "Could not record this page.", draftId },
      { status: 400 }
    );
  }

  return NextResponse.json({ draftId, pageNo, storagePath, createdDraft: createdDraftHere });
}
