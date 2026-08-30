import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { analyzeCaptureImage } from "@/lib/capture/analyze";

export const dynamic = "force-dynamic";

/**
 * POST /api/capture/analyze  (multipart/form-data: file, companyId, branchId?)
 *
 * The upload half of OCR/vision bill capture (0740): stores the file in the
 * EXISTING private 'documents' Storage bucket (0060), calls the shared
 * lib/capture/analyze.ts analyzer, inserts one public.capture_drafts row,
 * and returns its id plus whatever was extracted. Never posts a voucher —
 * see 0740's migration header, and the /[companyId]/capture screen's own
 * copy, for why a human always confirms before anything reaches the ledger.
 *
 * Uses the caller's own session throughout (createClient(), not a service-
 * role client) — the storage write and the capture_drafts insert both go
 * through ordinary RLS as this user, so a caller who is not actually a
 * member of `companyId` is refused by the database itself, not merely by
 * this route's own logic. companyId is always supplied here (the /capture
 * screen only ever runs inside an already-selected company) — this route
 * never creates an unclaimed (company_id null) draft; that shape exists in
 * the schema for the later WhatsApp path only.
 */

const ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

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
  const branchIdRaw = formData.get("branchId");
  const branchId = typeof branchIdRaw === "string" && branchIdRaw.trim() ? branchIdRaw : null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }
  if (typeof companyId !== "string" || !companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }
  if (!ALLOWED_MIME.includes(file.type)) {
    return NextResponse.json(
      { error: "Only PDF, PNG, JPEG or WebP files can be captured." },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File is larger than the 10 MB limit." }, { status: 400 });
  }

  // Fails fast, before spending a Gemini call, if this caller cannot even
  // see the company they named — RLS on `companies` filters to memberships,
  // so a non-member gets no row back here.
  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .maybeSingle();
  if (companyError || !company) {
    return NextResponse.json(
      { error: "You do not have access to this company." },
      { status: 403 }
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const storagePath = `${companyId}/capture/${crypto.randomUUID()}-${file.name}`;
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(storagePath, buffer, { contentType: file.type });
  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 400 });
  }

  const extracted = await analyzeCaptureImage(buffer, file.type);

  // capture_drafts is brand new (migration 0740) — types/database.types.ts
  // does not know it in this session (no live DB connection was available
  // to regenerate it here; see this task's own final report). Same escape
  // hatch InvoiceForm's page already uses for get_voucher_numbering_settings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  const { data: draft, error: insertError } = await (supabase as any)
    .from("capture_drafts")
    .insert({
      company_id: companyId,
      branch_id: branchId,
      source: "upload",
      storage_path: storagePath,
      extracted_json: extracted,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (insertError || !draft) {
    // The file itself uploaded but its metadata row didn't — clean up rather
    // than leave an orphaned object in the bucket. Same compensating-delete
    // discipline as components/documents/DocumentAttachments.tsx.
    await supabase.storage.from("documents").remove([storagePath]);
    return NextResponse.json(
      { error: insertError?.message ?? "Could not save the capture draft." },
      { status: 400 }
    );
  }

  return NextResponse.json({ draftId: draft.id, extracted });
}
