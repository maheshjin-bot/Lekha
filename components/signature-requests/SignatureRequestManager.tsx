"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/Badge";
import { DocumentAttachments } from "@/components/documents/DocumentAttachments";
import { checkPdfSignaturePresence } from "@/lib/pdf/signature-check";

type Doc = {
  id: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  entity_id: string | null;
  entity_type: string;
};

type Signer = {
  id: string;
  request_id: string;
  signer_name: string;
  signer_email: string;
  sign_order: number;
  status: "pending" | "signed" | "declined";
  signed_at: string | null;
  signed_document_id: string | null;
  decline_reason: string | null;
  has_embedded_signature: boolean | null;
  signature_check_note: string | null;
};

type Request = {
  id: string;
  title: string;
  description: string | null;
  status: "draft" | "sent" | "completed" | "cancelled";
  created_at: string;
  updated_at: string;
};

const ALLOWED_MIME = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;

const STATUS_BADGE: Record<Request["status"], { tone: "neutral" | "warn" | "ok" | "bad" | "accent"; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  sent: { tone: "warn", label: "Awaiting signatures" },
  completed: { tone: "ok", label: "Completed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

const SIGNER_STATUS_BADGE: Record<Signer["status"], { tone: "neutral" | "warn" | "ok" | "bad"; label: string }> = {
  pending: { tone: "warn", label: "Pending" },
  signed: { tone: "ok", label: "Signed" },
  declined: { tone: "bad", label: "Declined" },
};

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadDoc(storagePath: string) {
  const { data, error } = await createClient().storage.from("documents").createSignedUrl(storagePath, 60);
  if (error || !data) {
    toast.error(error?.message ?? "Could not open file");
    return;
  }
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}

/** One signer's "upload the signed-back copy" control — runs the structural
 * PDF check, uploads to the same 'documents' bucket/table 0060 already
 * uses (tagged entity_type=signature_request_signer), then calls
 * record_signed_document. Deliberately not a reuse of <DocumentAttachments/>
 * — that component only uploads+inserts, and this step also has to run the
 * check and call the RPC, so it gets its own small uploader instead of the
 * shared component being reshaped around this one call site. */
function SignerRow({
  companyId,
  request,
  signer,
  doc,
  onChanged,
}: {
  companyId: string;
  request: Request;
  signer: Signer;
  doc: Doc | undefined;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

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
        const buf = await file.arrayBuffer();
        checkResult = checkPdfSignaturePresence(buf);
      } catch {
        checkResult = null;
      }
    }

    const path = `${companyId}/signature_request_signer/${signer.id}/${crypto.randomUUID()}-${file.name}`;
    const { error: uploadError } = await client.storage.from("documents").upload(path, file, {
      contentType: file.type,
    });
    if (uploadError) {
      setBusy(false);
      toast.error(uploadError.message);
      return;
    }

    const { data: docRow, error: insertError } = await client
      .from("documents")
      .insert({
        company_id: companyId,
        entity_type: "signature_request_signer",
        entity_id: signer.id,
        storage_path: path,
        file_name: file.name,
        mime_type: file.type,
        size_bytes: file.size,
      })
      .select("id")
      .single();

    if (insertError || !docRow) {
      await client.storage.from("documents").remove([path]);
      setBusy(false);
      toast.error(insertError?.message ?? "Could not save the uploaded file's record");
      return;
    }

    const { error: rpcError } = await client.rpc("record_signed_document", {
      p_request_id: request.id,
      p_signer_id: signer.id,
      p_document_id: docRow.id,
      p_has_embedded_signature: checkResult?.hasSignature ?? undefined,
      p_signature_check_note: checkResult?.note ?? undefined,
    });

    if (rpcError) {
      // Keep the record consistent: an uploaded-but-unrecorded file left
      // behind would be confusing (it would sit under the signer's folder
      // looking like a signed copy that was never actually accepted).
      await client.from("documents").delete().eq("id", docRow.id);
      await client.storage.from("documents").remove([path]);
      setBusy(false);
      toast.error(rpcError.message);
      return;
    }

    setBusy(false);
    toast.success(`Recorded as signed${checkResult ? (checkResult.hasSignature ? " — embedded signature found" : " — no embedded signature structure found") : ""}`);
    onChanged();
  }

  async function decline() {
    setBusy(true);
    const { error } = await createClient().rpc("decline_signer", {
      p_request_id: request.id,
      p_signer_id: signer.id,
      p_reason: declineReason.trim() || undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Marked as declined");
    setDeclining(false);
    setDeclineReason("");
    onChanged();
  }

  return (
    <tr className="border-b border-border last:border-0 align-top">
      <td className="px-4 py-2 font-mono text-xs text-ink-faint">{signer.sign_order}</td>
      <td className="px-4 py-2">
        <div className="text-sm text-ink">{signer.signer_name}</div>
        <div className="text-xs text-ink-faint">{signer.signer_email}</div>
      </td>
      <td className="px-4 py-2">
        <Badge tone={SIGNER_STATUS_BADGE[signer.status].tone}>{SIGNER_STATUS_BADGE[signer.status].label}</Badge>
        {signer.status === "declined" && signer.decline_reason && (
          <p className="mt-1 max-w-xs text-xs text-ink-faint">{signer.decline_reason}</p>
        )}
      </td>
      <td className="px-4 py-2 text-xs text-ink-faint whitespace-nowrap">
        {signer.signed_at ? new Date(signer.signed_at).toLocaleString() : "—"}
      </td>
      <td className="px-4 py-2 max-w-sm">
        {signer.status === "signed" && doc && (
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => downloadDoc(doc.storage_path)}
              className="w-fit text-xs text-accent underline underline-offset-2"
            >
              {doc.file_name} ({formatSize(doc.size_bytes)})
            </button>
            {signer.has_embedded_signature === null ? (
              <span className="text-[11px] text-ink-faint">Not checked (not a PDF, or the check could not run).</span>
            ) : (
              <span
                className={
                  "text-[11px] " + (signer.has_embedded_signature ? "text-success" : "text-warning")
                }
                title={signer.signature_check_note ?? undefined}
              >
                {signer.has_embedded_signature
                  ? "Structural check: embedded signature found (hover for details)"
                  : "Structural check: no embedded signature structure found (hover for details)"}
              </span>
            )}
          </div>
        )}

        {signer.status === "pending" && request.status === "sent" && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-dashed border-border-strong px-2 py-1 text-xs text-ink-soft hover:bg-surface-2">
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
            {!declining ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setDeclining(true)}
                className="text-xs text-error underline underline-offset-2 disabled:opacity-50"
              >
                Decline
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <input
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                  placeholder="Reason (optional)"
                  className={field + " w-40 py-1 text-xs"}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={decline}
                  className="text-xs text-error underline underline-offset-2 disabled:opacity-50"
                >
                  Confirm
                </button>
              </div>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function RequestCard({
  companyId,
  request,
  signers,
  docs,
  onChanged,
}: {
  companyId: string;
  request: Request;
  signers: Signer[];
  docs: Doc[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showAddSigner, setShowAddSigner] = useState(false);
  const [signerName, setSignerName] = useState("");
  const [signerEmail, setSignerEmail] = useState("");

  const sourceDocs = docs.filter((d) => d.entity_type === "signature_request" && d.entity_id === request.id);
  const signedDocsBySignerId = new Map(
    docs.filter((d) => d.entity_type === "signature_request_signer").map((d) => [d.entity_id, d])
  );
  const nextOrder = signers.length > 0 ? Math.max(...signers.map((s) => s.sign_order)) + 1 : 1;
  const signedCount = signers.filter((s) => s.status === "signed").length;
  const canSend = request.status === "draft" && sourceDocs.length > 0 && signers.length > 0;

  async function addSigner(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await createClient().from("signature_request_signers").insert({
      request_id: request.id,
      company_id: companyId,
      signer_name: signerName.trim(),
      signer_email: signerEmail.trim(),
      sign_order: nextOrder,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSignerName("");
    setSignerEmail("");
    setShowAddSigner(false);
    onChanged();
  }

  async function removeSigner(signerId: string) {
    setBusy(true);
    const { error } = await createClient().from("signature_request_signers").delete().eq("id", signerId);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    onChanged();
  }

  async function send() {
    setBusy(true);
    const { error } = await createClient().rpc("send_signature_request", { p_request_id: request.id });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Sent");
    onChanged();
  }

  async function cancel() {
    setBusy(true);
    const { error } = await createClient().rpc("cancel_signature_request", { p_request_id: request.id });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Cancelled");
    onChanged();
  }

  return (
    <div className="rounded-[14px] border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-display text-base font-semibold text-ink">{request.title}</h3>
            <Badge tone={STATUS_BADGE[request.status].tone}>{STATUS_BADGE[request.status].label}</Badge>
          </div>
          {request.description && <p className="mt-1 max-w-2xl text-sm text-ink-soft">{request.description}</p>}
          {signers.length > 0 && (
            <p className="mt-1 text-xs text-ink-faint">
              {signedCount} of {signers.length} signed
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {request.status === "draft" && (
            <button
              type="button"
              disabled={busy || !canSend}
              onClick={send}
              title={!canSend ? "Attach a document and add at least one signer first" : undefined}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
            >
              Send
            </button>
          )}
          {(request.status === "draft" || request.status === "sent") && (
            <button
              type="button"
              disabled={busy}
              onClick={cancel}
              className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-semibold text-ink-soft hover:bg-surface-2 disabled:opacity-50"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="mt-4">
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-faint">
          Document{sourceDocs.length === 1 ? "" : "s"} to sign
        </p>
        {request.status === "draft" ? (
          <DocumentAttachments
            companyId={companyId}
            entityType="signature_request"
            entityId={request.id}
            docs={sourceDocs}
          />
        ) : sourceDocs.length === 0 ? (
          <p className="text-xs text-ink-faint">No document was attached.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {sourceDocs.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => downloadDoc(d.storage_path)}
                className="w-fit text-xs text-accent underline underline-offset-2"
              >
                {d.file_name} ({formatSize(d.size_bytes)})
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">Signers, in order</p>
          {request.status === "draft" && (
            <button
              type="button"
              onClick={() => setShowAddSigner((s) => !s)}
              className="text-xs text-accent underline underline-offset-2"
            >
              {showAddSigner ? "Cancel" : "Add signer"}
            </button>
          )}
        </div>

        {showAddSigner && (
          <form onSubmit={addSigner} className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-border-strong bg-bg p-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Order</span>
              <input value={nextOrder} disabled className={field + " w-16 opacity-60"} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Name</span>
              <input required value={signerName} onChange={(e) => setSignerName(e.target.value)} className={field} />
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs font-medium">Email</span>
              <input
                required
                type="email"
                value={signerEmail}
                onChange={(e) => setSignerEmail(e.target.value)}
                className={field}
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
            >
              Add
            </button>
          </form>
        )}

        {signers.length === 0 ? (
          <p className="text-xs text-ink-faint">No signers added yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">#</th>
                  <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Signer</th>
                  <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Status</th>
                  <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Signed at</th>
                  <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                    {request.status === "draft" ? "Remove" : "Signed copy"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {signers
                  .slice()
                  .sort((a, b) => a.sign_order - b.sign_order)
                  .map((s) =>
                    request.status === "draft" ? (
                      <tr key={s.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2 font-mono text-xs text-ink-faint">{s.sign_order}</td>
                        <td className="px-4 py-2">
                          <div className="text-sm text-ink">{s.signer_name}</div>
                          <div className="text-xs text-ink-faint">{s.signer_email}</div>
                        </td>
                        <td className="px-4 py-2">
                          <Badge tone={SIGNER_STATUS_BADGE[s.status].tone}>{SIGNER_STATUS_BADGE[s.status].label}</Badge>
                        </td>
                        <td className="px-4 py-2 text-xs text-ink-faint">—</td>
                        <td className="px-4 py-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => removeSigner(s.id)}
                            className="text-xs text-error underline underline-offset-2 disabled:opacity-50"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ) : (
                      <SignerRow
                        key={s.id}
                        companyId={companyId}
                        request={request}
                        signer={s}
                        doc={signedDocsBySignerId.get(s.id)}
                        onChanged={onChanged}
                      />
                    )
                  )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function SignatureRequestManager({
  companyId,
  requests,
  signers,
  docs,
}: {
  companyId: string;
  requests: Request[];
  signers: Signer[];
  docs: Doc[];
}) {
  const router = useRouter();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  function onChanged() {
    router.refresh();
  }

  async function createRequest(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await createClient().from("signature_requests").insert({
      company_id: companyId,
      title: title.trim(),
      description: description.trim() || null,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Draft request created");
    setTitle("");
    setDescription("");
    setShowCreateForm(false);
    onChanged();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowCreateForm((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showCreateForm ? "Cancel" : "New signature request"}
        </button>
      </div>

      {showCreateForm && (
        <form onSubmit={createRequest} className="grid gap-4 rounded-[14px] border border-border bg-surface p-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">Title</span>
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Lease renewal — Ashoka Traders"
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">Description (optional)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={field}
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              Create draft
            </button>
          </div>
        </form>
      )}

      {requests.length === 0 && (
        <p className="rounded-[14px] border border-dashed border-border-strong px-4 py-10 text-center text-sm text-ink-faint">
          No signature requests yet.
        </p>
      )}

      <div className="flex flex-col gap-4">
        {requests.map((r) => (
          <RequestCard
            key={r.id}
            companyId={companyId}
            request={r}
            signers={signers.filter((s) => s.request_id === r.id)}
            docs={docs}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  );
}
