"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { Badge } from "@/components/ui/Badge";
import { checkPdfSignaturePresence } from "@/lib/pdf/signature-check";

/**
 * The public, unauthenticated view behind /sign/[token] (0575). Everything
 * here comes from ONE anon-callable RPC, get_signature_request_by_token,
 * scoped server-side to exactly the one signer the token names — this
 * component never has access to, and never renders, any other signer's
 * name, email, status, or decline reason. lib/pdf/signature-check.ts is
 * reused byte-for-byte from the internal flow (SignerRow, in the file this
 * task deliberately does not touch) — same structural check, same caveats.
 */

type SignatureRequestByToken = {
  request_id: string;
  company_id: string;
  company_name: string;
  request_title: string;
  request_description: string | null;
  request_status: "draft" | "sent" | "completed" | "cancelled";
  signer_id: string;
  signer_name: string;
  signer_email: string;
  sign_order: number;
  signer_status: "pending" | "signed" | "declined";
  signed_at: string | null;
  decline_reason: string | null;
  documents: {
    id: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
    storage_path: string;
  }[];
};

const ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

const REQUEST_STATUS_COPY: Record<SignatureRequestByToken["request_status"], string> = {
  draft: "Not sent yet.",
  sent: "Awaiting signatures.",
  completed: "This request is complete — every signer has signed.",
  cancelled: "This request was cancelled by the sender. No further action is needed.",
};

const SIGNER_STATUS_BADGE: Record<SignatureRequestByToken["signer_status"], { tone: "neutral" | "warn" | "ok" | "bad"; label: string }> = {
  pending: { tone: "warn", label: "Awaiting your signature" },
  signed: { tone: "ok", label: "You signed this" },
  declined: { tone: "bad", label: "You declined this" },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ExternalSignerView({ token, data }: { token: string; data: SignatureRequestByToken }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function downloadDoc(storagePath: string) {
    const { data: signed, error } = await createClient().storage.from("documents").createSignedUrl(storagePath, 60);
    if (error || !signed) {
      toast.error(error?.message ?? "Could not open this file");
      return;
    }
    window.open(signed.signedUrl, "_blank", "noopener,noreferrer");
  }

  async function uploadSignedCopy(file: File) {
    if (!ALLOWED_MIME.includes(file.type)) {
      toast.error("Only PDF, PNG, JPEG or WebP files can be uploaded.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("File is larger than the 10 MB limit.");
      return;
    }

    setBusy(true);
    const client = createClient();

    let checkResult: ReturnType<typeof checkPdfSignaturePresence> | null = null;
    if (file.type === "application/pdf") {
      try {
        checkResult = checkPdfSignaturePresence(await file.arrayBuffer());
      } catch {
        checkResult = null;
      }
    }

    // Must land exactly under company_id/signature_request_signer/signer_id/
    // — the prefix record_signed_document_by_token re-derives from the
    // token itself and checks against, never trusting this path back.
    const path = `${data.company_id}/signature_request_signer/${data.signer_id}/${crypto.randomUUID()}-${file.name}`;
    const { error: uploadError } = await client.storage.from("documents").upload(path, file, {
      contentType: file.type,
    });
    if (uploadError) {
      setBusy(false);
      toast.error(uploadError.message);
      return;
    }

    const { error: rpcError } = await callRpc(client, "record_signed_document_by_token", {
      p_token: token,
      p_storage_path: path,
      p_file_name: file.name,
      p_mime_type: file.type,
      p_size_bytes: file.size,
      p_has_embedded_signature: checkResult?.hasSignature ?? null,
      p_signature_check_note: checkResult?.note ?? null,
    });

    if (rpcError) {
      // Same "don't leave an uploaded-but-unrecorded file behind" cleanup
      // SignerRow already does for the authenticated path — here via the
      // narrow anon DELETE policy scoped to this same pending-signer folder.
      await client.storage.from("documents").remove([path]);
      setBusy(false);
      toast.error(rpcError.message);
      return;
    }

    setBusy(false);
    toast.success(
      `Recorded as signed${checkResult ? (checkResult.hasSignature ? " — embedded signature found" : " — no embedded signature structure found") : ""}`
    );
    router.refresh();
  }

  const canUpload = data.signer_status === "pending" && data.request_status === "sent";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-12">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">{data.company_name} asked you to sign</p>
        <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">{data.request_title}</h1>
        {data.request_description && <p className="mt-2 text-sm text-ink-soft">{data.request_description}</p>}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SIGNER_STATUS_BADGE[data.signer_status].tone}>{SIGNER_STATUS_BADGE[data.signer_status].label}</Badge>
        {data.signed_at && <span className="text-xs text-ink-faint">on {new Date(data.signed_at).toLocaleString()}</span>}
      </div>

      <p className="text-sm text-ink-soft">{REQUEST_STATUS_COPY[data.request_status]}</p>

      {data.signer_status === "declined" && data.decline_reason && (
        <p className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-xs text-ink-faint">
          Reason given: {data.decline_reason}
        </p>
      )}

      <section className="rounded-[14px] border border-border bg-surface p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">
          Document{data.documents.length === 1 ? "" : "s"} to review
        </p>
        {data.documents.length === 0 ? (
          <p className="text-xs text-ink-faint">No document was attached.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {data.documents.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => downloadDoc(d.storage_path)}
                className="w-fit text-sm text-accent underline underline-offset-2"
              >
                {d.file_name} ({formatSize(d.size_bytes)})
              </button>
            ))}
          </div>
        )}
      </section>

      {canUpload && (
        <section className="rounded-[14px] border border-dashed border-border-strong bg-surface p-4">
          <p className="mb-2 text-sm font-medium text-ink">
            Sign the document above outside this page — your own DSC token, Aadhaar eSign, or a printed-and-scanned wet-ink
            signature — then upload the signed copy here.
          </p>
          <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90">
            {busy ? "Uploading…" : "Upload signed copy"}
            <input
              type="file"
              accept={ALLOWED_MIME.join(",")}
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadSignedCopy(file);
                e.target.value = "";
              }}
              className="sr-only"
            />
          </label>
          <p className="mt-2 text-xs text-ink-faint">PDF, PNG, JPEG or WebP — up to 10 MB.</p>
        </section>
      )}

      <p className="mt-4 text-center text-[11px] text-ink-faint">
        This link is unique to you. This app does not originate or verify legally binding electronic signatures — it only
        tracks whether a copy has been uploaded back.
      </p>
    </main>
  );
}

export type { SignatureRequestByToken };
