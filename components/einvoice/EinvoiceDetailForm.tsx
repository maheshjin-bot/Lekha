"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { checkEinvoicePayload } from "@/lib/utils/einvoice";
import { Input, Label, Textarea } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EinvoiceQr } from "@/components/einvoice/EinvoiceQr";

type Existing = {
  id: string;
  status: "not_generated" | "json_ready" | "irn_obtained";
  generated_json: Record<string, unknown> | null;
  generated_at: string | null;
  irn: string | null;
  ack_number: string | null;
  ack_date: string | null;
  signed_qr_payload: string | null;
};

const STATUS_BADGE: Record<Existing["status"], { label: string; tone: "ok" | "warn" | "neutral" }> = {
  not_generated: { label: "Not generated", tone: "neutral" },
  json_ready: { label: "JSON ready", tone: "warn" },
  irn_obtained: { label: "IRN obtained", tone: "ok" },
};

/** DB stores timestamptz; <input type="datetime-local"> wants
 * "YYYY-MM-DDTHH:mm" in local time with no offset. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The addendum screen for ONE sales invoice or credit note (0230): build the
 * NIC-schema JSON this app can assemble from a voucher it already posted,
 * for the user to copy into whatever GSP portal or NIC utility they
 * actually use — this app makes no call to any IRP — and record the
 * IRN/acknowledgement/QR once obtained elsewhere. Same "addendum reached
 * from the invoice list" shape as EximShipmentForm (0119).
 */
export function EinvoiceDetailForm({
  companyId,
  voucherId,
  existing,
}: {
  companyId: string;
  voucherId: string;
  existing: Existing | null;
}) {
  const router = useRouter();
  const [busyGenerate, setBusyGenerate] = useState(false);
  const [busySave, setBusySave] = useState(false);
  const [payload, setPayload] = useState<Record<string, unknown> | null>(existing?.generated_json ?? null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(existing?.generated_at ?? null);
  const [status, setStatus] = useState<Existing["status"]>(existing?.status ?? "not_generated");

  const [irn, setIrn] = useState(existing?.irn ?? "");
  const [ackNumber, setAckNumber] = useState(existing?.ack_number ?? "");
  const [ackDate, setAckDate] = useState(toLocalInput(existing?.ack_date ?? null));
  const [signedQr, setSignedQr] = useState(existing?.signed_qr_payload ?? "");

  const warnings = useMemo(() => checkEinvoicePayload(payload), [payload]);
  const prettyJson = useMemo(() => (payload ? JSON.stringify(payload, null, 2) : ""), [payload]);

  async function generate() {
    setBusyGenerate(true);
    const supabase = createClient();
    const { data, error } = await callRpc<{ p_voucher_id: string }, Record<string, unknown>>(
      supabase,
      "build_einvoice_json",
      { p_voucher_id: voucherId }
    );
    if (error) {
      setBusyGenerate(false);
      toast.error(error.message);
      return;
    }

    const row = {
      company_id: companyId,
      voucher_id: voucherId,
      generated_json: data,
    };
    // einvoice_details is brand new (migration 0230) — not yet in the
    // generated database types (owned by the integration pass), hence the
    // disabled rule below, same convention as ManufacturingManager.tsx's
    // bom_outputs. RLS and the runtime shape are both verified live.
    const { data: saved, error: saveError } = existing
      ? await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .from("einvoice_details" as any)
          .update(row)
          .eq("id", existing.id)
          .select("status, generated_at")
          .single()
      : await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .from("einvoice_details" as any)
          .insert(row)
          .select("status, generated_at")
          .single();

    setBusyGenerate(false);
    if (saveError) {
      toast.error(saveError.message);
      return;
    }
    setPayload(data);
    const savedRow = saved as unknown as { status: Existing["status"]; generated_at: string } | null;
    setStatus(savedRow?.status ?? "json_ready");
    setGeneratedAt(savedRow?.generated_at ?? null);
    toast.success("e-Invoice JSON generated.");
    router.refresh();
  }

  async function copyJson() {
    if (!prettyJson) return;
    await navigator.clipboard.writeText(prettyJson);
    toast.success("Copied to clipboard.");
  }

  async function saveIrn(e: React.FormEvent) {
    e.preventDefault();
    if (!payload) {
      toast.error("Generate the e-invoice JSON first — recording an IRN without it makes no sense to keep together.");
      return;
    }
    const trimmedIrn = irn.trim().toLowerCase();
    const trimmedAck = ackNumber.trim();
    if ((trimmedIrn || trimmedAck || ackDate) && !(trimmedIrn && trimmedAck && ackDate)) {
      toast.error("The IRP always returns IRN, Acknowledgement Number and Acknowledgement Date together — fill in all three, or leave all three blank.");
      return;
    }
    // Same 64-hex-character shape the einvoice_details table itself enforces
    // (einvoice_details_irn_check, 0230) — checked here too so a typo comes
    // back as a plain-English message instead of a raw Postgres constraint
    // name, which is what reaches the client if this check is skipped and
    // the database rejects it instead (caught live: a 63-character test IRN
    // surfaced as "violates check constraint einvoice_details_irn_check",
    // accurate but useless to an accountant reading the toast).
    if (trimmedIrn && !/^[0-9a-f]{64}$/.test(trimmedIrn)) {
      toast.error(`IRN must be exactly 64 hex characters (0-9, a-f) — this one is ${trimmedIrn.length}. Check for a missed or extra character.`);
      return;
    }
    if (trimmedAck && !/^[0-9]{1,20}$/.test(trimmedAck)) {
      toast.error("Acknowledgement number should be digits only.");
      return;
    }

    setBusySave(true);
    const supabase = createClient();
    const row = {
      company_id: companyId,
      voucher_id: voucherId,
      generated_json: payload,
      irn: trimmedIrn || null,
      ack_number: trimmedAck || null,
      ack_date: ackDate ? new Date(ackDate).toISOString() : null,
      signed_qr_payload: signedQr.trim() || null,
    };
    const { data, error } = existing
      ? await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .from("einvoice_details" as any)
          .update(row)
          .eq("id", existing.id)
          .select("status")
          .single()
      : await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .from("einvoice_details" as any)
          .insert(row)
          .select("status")
          .single();

    setBusySave(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setStatus((data as unknown as { status: Existing["status"] } | null)?.status ?? status);
    toast.success("Saved.");
    router.refresh();
  }

  const badge = STATUS_BADGE[status];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between rounded-[14px] border border-border bg-surface p-5 shadow-card">
        <div>
          <h2 className="text-sm font-semibold text-ink">e-Invoice JSON payload</h2>
          <p className="mt-1 text-xs text-ink-faint">
            Assembled from this voucher&rsquo;s own posted data — NIC e-invoice schema v1.1. This app does not
            submit it anywhere; copy it into your GSP portal or the NIC offline utility.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <Button type="button" onClick={generate} busy={busyGenerate} busyLabel="Building…">
            {payload ? "Regenerate JSON" : "Generate e-invoice JSON"}
          </Button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
          <p className="font-medium">This payload will not validate at the IRP as-is:</p>
          <ul className="list-disc space-y-1 pl-5">
            {warnings.map((w) => (
              <li key={w.field}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      {payload && (
        <div className="rounded-[14px] border border-border bg-surface p-5 shadow-card">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-ink-faint">
              {generatedAt ? `Generated ${new Date(generatedAt).toLocaleString("en-IN")}` : "Generated"}
            </span>
            <button type="button" onClick={copyJson} className="text-xs font-medium text-accent hover:underline">
              Copy JSON
            </button>
          </div>
          <Textarea readOnly value={prettyJson} rows={16} className="font-mono text-xs" />
        </div>
      )}

      <form onSubmit={saveIrn} className="flex flex-col gap-4 rounded-[14px] border border-border bg-surface p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ink">IRN, once obtained elsewhere</h3>
        <p className="text-xs text-ink-faint">
          Submit the JSON above through a GSP or the NIC offline utility, then paste what it returns here. This
          app never contacts an IRP itself.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <Label>Invoice Reference Number (IRN)</Label>
            <Input
              value={irn}
              onChange={(e) => setIrn(e.target.value)}
              placeholder="64-character hex string"
              maxLength={64}
              className="font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <Label>Acknowledgement number</Label>
            <Input value={ackNumber} onChange={(e) => setAckNumber(e.target.value)} placeholder="e.g. 112310186022618" />
          </label>
          <label className="flex flex-col gap-1.5">
            <Label>Acknowledgement date &amp; time</Label>
            <Input type="datetime-local" value={ackDate} onChange={(e) => setAckDate(e.target.value)} />
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <Label>Signed QR payload (SignedQRCode)</Label>
          <Textarea
            value={signedQr}
            onChange={(e) => setSignedQr(e.target.value)}
            rows={3}
            placeholder="Paste the IRP's SignedQRCode string to render it below"
            className="font-mono text-xs"
          />
        </label>

        {signedQr.trim() && (
          <div className="flex items-center gap-4 rounded-lg bg-surface-2 px-4 py-3">
            <EinvoiceQr data={signedQr.trim()} />
            <p className="text-xs text-ink-faint">
              Rendered directly from the pasted SignedQRCode — the same QR the real e-invoice print copy carries.
            </p>
          </div>
        )}

        <div className="flex justify-end">
          <Button type="submit" busy={busySave} busyLabel="Saving…">
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}
