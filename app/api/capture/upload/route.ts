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

  const mime = resolveMime(file.type, file.name);
  if (!isAllowedMime(mime)) {
    return NextResponse.json(
      { error: "Only JPEG, PNG, WebP, HEIC/HEIF or PDF pages can be captured." },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "This page is larger than the 10 MB limit." }, { status: 400 });
  }

  // Fails before a single byte is stored if this caller cannot even see the
  // company they named — companies' own RLS filters to memberships.
  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .maybeSingle();
  if (companyError || !company) {
    return NextResponse.json({ error: "You do not have access to this company." }, { status: 403 });
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
    return NextResponse.json(
      { error: pageError.message ?? "Could not record this page.", draftId },
      { status: 400 }
    );
  }

  return NextResponse.json({ draftId, pageNo, storagePath, createdDraft: createdDraftHere });
}
