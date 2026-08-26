"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { th, td, num, TableContainer } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";

export type SufferedEntry = {
  id: string;
  source_type: "sec51_tds" | "sec52_tcs";
  deductor_or_operator_gstin: string;
  deductor_or_operator_name: string;
  period_label: string;
  financial_year_label: string;
  taxable_value: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  claimed_in_gstr3b: boolean;
  notes: string | null;
};

const SOURCE_LABEL: Record<string, string> = {
  sec51_tds: "Sec 51 TDS (govt/PSU deductor)",
  sec52_tcs: "Sec 52 TCS (e-commerce operator)",
};

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

type FormState = {
  id: string | null;
  sourceType: "sec51_tds" | "sec52_tcs";
  gstin: string;
  name: string;
  periodLabel: string;
  supplyType: "intra" | "inter";
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  claimed: boolean;
  notes: string;
};

function blankForm(): FormState {
  return {
    id: null,
    sourceType: "sec51_tds",
    gstin: "",
    name: "",
    periodLabel: "",
    supplyType: "intra",
    taxableValue: "",
    cgst: "",
    sgst: "",
    igst: "",
    claimed: false,
    notes: "",
  };
}

export function GstTdsTcsSufferedManager({
  companyId,
  gstRegistrationId,
  entries,
}: {
  companyId: string;
  gstRegistrationId: string | undefined;
  entries: SufferedEntry[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm());

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  function startEdit(e: SufferedEntry) {
    setForm({
      id: e.id,
      sourceType: e.source_type,
      gstin: e.deductor_or_operator_gstin,
      name: e.deductor_or_operator_name,
      periodLabel: e.period_label,
      supplyType: Number(e.igst_amount) > 0 ? "inter" : "intra",
      taxableValue: String(e.taxable_value),
      cgst: e.cgst_amount ? String(e.cgst_amount) : "",
      sgst: e.sgst_amount ? String(e.sgst_amount) : "",
      igst: e.igst_amount ? String(e.igst_amount) : "",
      claimed: e.claimed_in_gstr3b,
      notes: e.notes ?? "",
    });
    setShowForm(true);
  }

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    if (!gstRegistrationId) {
      toast.error("This company has no GST registration to attach this entry to.");
      return;
    }
    setBusy(true);
    const payload = {
      company_id: companyId,
      gst_registration_id: gstRegistrationId,
      source_type: form.sourceType,
      deductor_or_operator_gstin: form.gstin.trim().toUpperCase(),
      deductor_or_operator_name: form.name.trim(),
      period_label: form.periodLabel,
      taxable_value: Number(form.taxableValue) || 0,
      cgst_amount: form.supplyType === "intra" ? Number(form.cgst) || 0 : 0,
      sgst_amount: form.supplyType === "intra" ? Number(form.sgst) || 0 : 0,
      igst_amount: form.supplyType === "inter" ? Number(form.igst) || 0 : 0,
      claimed_in_gstr3b: form.claimed,
      notes: form.notes.trim() || null,
    };

    const supabase = createClient();
    // financial_year_label has no column default — a trigger derives it from
    // period_label server-side (0180) — so the generated Insert type marks it
    // required even though the client must never set it. Cast just this call.
    const { error } = form.id
      ? await supabase.from("gst_tds_tcs_suffered").update(payload).eq("id", form.id)
      : await supabase.from("gst_tds_tcs_suffered").insert(payload as never);

    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(form.id ? "Entry updated" : "Entry recorded");
    setForm(blankForm());
    setShowForm(false);
    router.refresh();
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this entry? This only removes it from LEKHA's own tracking, not from the GST portal.")) return;
    setBusy(true);
    const { error } = await createClient().from("gst_tds_tcs_suffered").delete().eq("id", id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Entry deleted");
    router.refresh();
  }

  async function toggleClaimed(e: SufferedEntry) {
    setBusy(true);
    const { error } = await createClient()
      .from("gst_tds_tcs_suffered")
      .update({ claimed_in_gstr3b: !e.claimed_in_gstr3b })
      .eq("id", e.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">
          Entries as they appear on the GST portal&rsquo;s <em>TDS and TCS Credit Received</em> statement —
          recorded here, not fetched, since no auto-population feed for that statement exists yet.
        </p>
        <button
          type="button"
          onClick={() => {
            if (showForm) {
              setForm(blankForm());
            }
            setShowForm((s) => !s);
          }}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : "Record an entry"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={save} className="grid gap-4 rounded-[14px] border border-border bg-surface p-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Source</span>
            <select
              value={form.sourceType}
              onChange={(e) => set("sourceType", e.target.value as FormState["sourceType"])}
              className={field}
            >
              <option value="sec51_tds">Sec 51 TDS — government/PSU deductor</option>
              <option value="sec52_tcs">Sec 52 TCS — e-commerce operator</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              GSTR-7/8 period <span className="font-normal text-ink-faint">— the deductor&rsquo;s own filing month</span>
            </span>
            <input
              required
              type="month"
              value={form.periodLabel}
              onChange={(e) => set("periodLabel", e.target.value)}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{form.sourceType === "sec51_tds" ? "Deductor" : "Operator"} GSTIN</span>
            <input
              required
              value={form.gstin}
              onChange={(e) => set("gstin", e.target.value)}
              placeholder="15-character GSTIN"
              className={field + " font-mono uppercase"}
              maxLength={15}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{form.sourceType === "sec51_tds" ? "Deductor" : "Operator"} name</span>
            <input required value={form.name} onChange={(e) => set("name", e.target.value)} className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              {form.sourceType === "sec51_tds" ? "Payment (taxable value)" : "Net taxable supplies"}
            </span>
            <input
              required
              type="number"
              min={0}
              step="0.01"
              value={form.taxableValue}
              onChange={(e) => set("taxableValue", e.target.value)}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Supply type</span>
            <select value={form.supplyType} onChange={(e) => set("supplyType", e.target.value as "intra" | "inter")} className={field}>
              <option value="intra">Intra-state (CGST + SGST)</option>
              <option value="inter">Inter-state (IGST)</option>
            </select>
          </label>
          {form.supplyType === "intra" ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">CGST</span>
                <input
                  required
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.cgst}
                  onChange={(e) => set("cgst", e.target.value)}
                  className={field}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">SGST</span>
                <input
                  required
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.sgst}
                  onChange={(e) => set("sgst", e.target.value)}
                  className={field}
                />
              </label>
            </>
          ) : (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">IGST</span>
              <input
                required
                type="number"
                min={0}
                step="0.01"
                value={form.igst}
                onChange={(e) => set("igst", e.target.value)}
                className={field}
              />
            </label>
          )}
          <label className="flex items-center gap-2 sm:col-span-2">
            <input type="checkbox" checked={form.claimed} onChange={(e) => set("claimed", e.target.checked)} className="h-4 w-4" />
            <span className="text-sm">Already claimed against a GSTR-3B liability</span>
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">Notes (optional)</span>
            <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} className={field} />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {form.id ? "Save changes" : "Save"}
            </button>
          </div>
        </form>
      )}

      <TableContainer>
        <table className="w-full min-w-[960px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Source</th>
              <th className={th}>Deductor / operator</th>
              <th className={th}>GSTIN</th>
              <th className={th}>Period</th>
              <th className={th + " text-right"}>Taxable value</th>
              <th className={th + " text-right"}>CGST</th>
              <th className={th + " text-right"}>SGST</th>
              <th className={th + " text-right"}>IGST</th>
              <th className={th}>Claimed?</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-ink-faint">
                  Nothing recorded yet for this GSTIN/year.
                </td>
              </tr>
            )}
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-border last:border-0">
                <td className={td}>
                  <Badge tone={e.source_type === "sec51_tds" ? "accent" : "neutral"}>
                    {e.source_type === "sec51_tds" ? "Sec 51 TDS" : "Sec 52 TCS"}
                  </Badge>
                </td>
                <td className={td}>{e.deductor_or_operator_name}</td>
                <td className={td + " font-mono text-xs"}>{e.deductor_or_operator_gstin}</td>
                <td className={td + " whitespace-nowrap"}>{e.period_label}</td>
                <td className={num}>{formatINR(Number(e.taxable_value), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(e.cgst_amount), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(e.sgst_amount), { showZero: true })}</td>
                <td className={num}>{formatINR(Number(e.igst_amount), { showZero: true })}</td>
                <td className={td}>
                  <button type="button" disabled={busy} onClick={() => toggleClaimed(e)} className="disabled:opacity-50">
                    <Badge tone={e.claimed_in_gstr3b ? "ok" : "warn"}>{e.claimed_in_gstr3b ? "Claimed" : "Not yet"}</Badge>
                  </button>
                </td>
                <td className={td}>
                  <div className="flex items-center gap-2 text-xs">
                    <button type="button" onClick={() => startEdit(e)} className="text-accent underline underline-offset-2">
                      Edit
                    </button>
                    <button type="button" disabled={busy} onClick={() => remove(e.id)} className="text-error underline underline-offset-2 disabled:opacity-50">
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableContainer>

      <p className="text-xs text-ink-faint">
        {SOURCE_LABEL.sec51_tds} and {SOURCE_LABEL.sec52_tcs} — manually entered from what the GST portal&rsquo;s own
        &ldquo;TDS and TCS Credit Received&rdquo; statement shows for each period, since this schema has no feed for that
        statement. Recording an entry here does not post anything to the ledger and does not change any GSTR-3B figure —
        it is a tracking aid; the actual claim happens on the GST portal itself.
      </p>
    </div>
  );
}
