"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Input, Label } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

type Shipment = {
  id: string;
  document_type: "shipping_bill" | "bill_of_entry";
  document_number: string;
  document_date: string;
  port_code: string;
  brc_number: string | null;
  brc_date: string | null;
  export_realisation_due_date: string | null;
  realised_date: string | null;
};

/**
 * Create-or-edit for the ONE exim_shipment_details row a voucher can have
 * (v1 scope — see 0119 migration header). document_type is fixed by the
 * voucher's own direction (sales -> shipping_bill, purchase ->
 * bill_of_entry) — the enforce_exim_shipment_voucher trigger rejects the
 * other, so this form never offers a choice, it just states which one
 * applies and why.
 */
export function EximShipmentForm({
  companyId,
  voucherId,
  voucherType,
  existing,
}: {
  companyId: string;
  voucherId: string;
  voucherType: "sales" | "purchase";
  existing: Shipment | null;
}) {
  const router = useRouter();
  const documentType: "shipping_bill" | "bill_of_entry" =
    voucherType === "sales" ? "shipping_bill" : "bill_of_entry";
  const isExport = documentType === "shipping_bill";

  const [documentNumber, setDocumentNumber] = useState(existing?.document_number ?? "");
  const [documentDate, setDocumentDate] = useState(existing?.document_date ?? "");
  const [portCode, setPortCode] = useState(existing?.port_code ?? "");
  const [brcNumber, setBrcNumber] = useState(existing?.brc_number ?? "");
  const [brcDate, setBrcDate] = useState(existing?.brc_date ?? "");
  const [realisedDate, setRealisedDate] = useState(existing?.realised_date ?? "");
  const [busy, setBusy] = useState(false);

  const [dueDate, setDueDate] = useState(existing?.export_realisation_due_date ?? null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!documentNumber.trim() || !documentDate || !portCode.trim()) {
      toast.error(`${isExport ? "Shipping bill" : "Bill of Entry"} number, date and port code are all required.`);
      return;
    }

    setBusy(true);
    const supabase = createClient();
    const payload = {
      company_id: companyId,
      voucher_id: voucherId,
      document_type: documentType,
      document_number: documentNumber.trim(),
      document_date: documentDate,
      port_code: portCode.trim(),
      brc_number: isExport ? (brcNumber.trim() || null) : null,
      brc_date: isExport ? (brcDate || null) : null,
      realised_date: isExport ? (realisedDate || null) : null,
    };

    const { data, error } = existing
      ? await supabase
          .from("exim_shipment_details")
          .update(payload)
          .eq("id", existing.id)
          .select("export_realisation_due_date")
          .single()
      : await supabase
          .from("exim_shipment_details")
          .insert(payload)
          .select("export_realisation_due_date")
          .single();

    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setDueDate(data?.export_realisation_due_date ?? null);
    toast.success(existing ? "EXIM details updated." : "EXIM details saved.");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5 rounded-[14px] border border-border bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">
          {isExport ? "Shipping bill (export)" : "Bill of Entry (import)"}
        </h2>
        <Badge tone="accent">{isExport ? "Shipping bill" : "Bill of Entry"}</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <Label>{isExport ? "Shipping bill number" : "BOE number"}</Label>
          <Input
            required
            value={documentNumber}
            onChange={(e) => setDocumentNumber(e.target.value)}
            placeholder={isExport ? "e.g. 5412345" : "e.g. INNSA1-2026-3345678"}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <Label>{isExport ? "Shipping bill date" : "BOE date"}</Label>
          <Input type="date" required value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5">
          <Label>Port code</Label>
          <Input
            required
            value={portCode}
            onChange={(e) => setPortCode(e.target.value.toUpperCase())}
            placeholder="e.g. INNSA1"
            maxLength={6}
            className="font-mono uppercase"
          />
        </label>
      </div>
      <p className="text-xs text-ink-faint">
        ICEGATE customs station code — &ldquo;IN&rdquo; plus the 4-character facility code (INNSA1 = Nhava
        Sheva/JNPT, INBOM4 = Mumbai air cargo). A lookup on ICEGATE fails silently if this is wrong even when
        the number and date are right.
      </p>

      {isExport && (
        <>
          <div className="border-t border-border pt-4">
            <h3 className="text-sm font-semibold text-ink">Bank Realisation Certificate (BRC)</h3>
            <p className="mt-1 text-xs text-ink-faint">
              The bank-issued proof that export proceeds actually arrived in foreign exchange — the fact FEMA
              cares about, not the shipment itself. Leave blank until the AD bank uploads the eBRC; fill in
              once you have it.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1.5">
                <Label>eBRC / BRC number</Label>
                <Input value={brcNumber} onChange={(e) => setBrcNumber(e.target.value)} placeholder="Optional until realised" />
              </label>
              <label className="flex flex-col gap-1.5">
                <Label>BRC date</Label>
                <Input type="date" value={brcDate} onChange={(e) => setBrcDate(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1.5">
                <Label>Proceeds realised on</Label>
                <Input type="date" value={realisedDate} onChange={(e) => setRealisedDate(e.target.value)} />
              </label>
            </div>
          </div>

          <div className="rounded-lg bg-surface-2 px-4 py-3 text-sm">
            <span className="font-medium text-ink">FEMA Reg. 9(1) realisation due date: </span>
            {dueDate ? (
              <span className="font-mono tabular-nums text-ink">{dueDate}</span>
            ) : (
              <span className="text-ink-faint">computed on save</span>
            )}
            <p className="mt-1 text-xs text-ink-faint">
              Computed from the shipping bill date using whichever FEMA export-realisation window (9, 15 or 18
              months) was actually in force on that date — RBI has changed this window three times in the last
              ten months, so it is not a flat constant. Recomputes automatically if you edit the date above.
            </p>
          </div>
        </>
      )}

      {!isExport && (
        <p className="rounded-lg bg-surface-2 px-4 py-3 text-xs text-ink-faint">
          Imports have no BRC and no fixed FEMA realisation clock in this app — the payment timeline for an
          import is set by the underlying contract with the overseas seller, not by a single RBI-prescribed
          number, so nothing is computed here. Not tracked, not fabricated.
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" busy={busy} busyLabel="Saving…">
          {existing ? "Save changes" : "Save EXIM details"}
        </Button>
      </div>
    </form>
  );
}
