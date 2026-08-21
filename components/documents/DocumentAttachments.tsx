"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";

type Doc = {
  id: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
};

const ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Generic attachment widget — one component, any entity. entityType/entityId
 * are exactly what documents.entity_type/entity_id (0060) expect, so a new
 * call site (fixed assets, a voucher once its pages settle) is a two-line
 * addition here, not a new upload path.
 */
export function DocumentAttachments({
  companyId,
  entityType,
  entityId,
  docs,
}: {
  companyId: string;
  entityType: string;
  entityId: string | null;
  docs: Doc[];
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (!ALLOWED_MIME.includes(file.type)) {
      toast.error("Only PDF, PNG, JPEG or WebP files can be attached.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("File is larger than the 10 MB limit.");
      return;
    }

    setBusy(true);
    const client = createClient();
    // Path is the tenancy boundary storage RLS actually checks (0060) — this
    // must match exactly, not just look similar, or the upload is refused.
    const path = `${companyId}/${entityType}/${entityId ?? "none"}/${crypto.randomUUID()}-${file.name}`;

    const { error: uploadError } = await client.storage.from("documents").upload(path, file, {
      contentType: file.type,
    });
    if (uploadError) {
      setBusy(false);
      toast.error(uploadError.message);
      return;
    }

    const { error: insertError } = await client.from("documents").insert({
      company_id: companyId,
      entity_type: entityType,
      entity_id: entityId,
      storage_path: path,
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    });
    setBusy(false);
    if (insertError) {
      // The file itself uploaded but its metadata row didn't — clean it back
      // up rather than leave an orphaned, invisible-to-RLS-listing object
      // sitting in the bucket with no row pointing at it.
      await client.storage.from("documents").remove([path]);
      toast.error(insertError.message);
      return;
    }

    toast.success("Attached");
    if (fileInput.current) fileInput.current.value = "";
    router.refresh();
  }

  async function download(doc: Doc) {
    const { data, error } = await createClient().storage.from("documents").createSignedUrl(doc.storage_path, 60);
    if (error || !data) {
      toast.error(error?.message ?? "Could not open file");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function remove(doc: Doc) {
    setBusy(true);
    const client = createClient();
    await client.storage.from("documents").remove([doc.storage_path]);
    const { error } = await client.from("documents").delete().eq("id", doc.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Removed");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      {docs.length === 0 && <p className="text-xs text-ink-faint">No files attached.</p>}
      {docs.map((d) => (
        <div
          key={d.id}
          className="flex items-center justify-between gap-2 rounded-md border border-border-strong px-3 py-2 text-sm"
        >
          <button
            type="button"
            onClick={() => download(d)}
            className="min-w-0 flex-1 truncate text-left text-accent underline underline-offset-2"
          >
            {d.file_name}
          </button>
          <span className="shrink-0 text-xs text-ink-faint">{formatSize(d.size_bytes)}</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => remove(d)}
            className="shrink-0 text-xs text-error underline underline-offset-2 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      ))}

      <label className="mt-1 inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2 text-xs text-ink-soft hover:bg-surface-2">
        {busy ? "Uploading…" : "Attach a file (PDF, image — up to 10 MB)"}
        <input
          ref={fileInput}
          type="file"
          accept={ALLOWED_MIME.join(",")}
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
          }}
          className="sr-only"
        />
      </label>
    </div>
  );
}
