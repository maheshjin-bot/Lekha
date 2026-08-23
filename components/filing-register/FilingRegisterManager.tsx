"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td } from "@/components/ui/Table";
import { formatINR } from "@/lib/utils/currency";

export type FilingRecord = {
  id: string;
  form_code: string;
  gst_registration_id: string | null;
  gstin: string | null;
  period_label: string;
  filed_date: string | null;
  acknowledgement_number: string | null;
  fee_paid: number;
  additional_fee: number;
  status: "pending" | "filed" | "not_applicable";
  notes: string | null;
  created_at: string;
};

export type GstRegistration = {
  id: string;
  gstin: string;
  state_code: string;
};

// Suggestions only — form_code itself is free text (see 0095's migration
// header for why it is deliberately not an enum). Drawn from the exact set
// of labels public.get_compliance_calendar computes today (read from
// pg_proc.prosrc via sbq, not recalled), normalized to a clean code without
// the GSTIN/period the calendar's own labels concatenate in, plus a few
// common filings the calendar does not compute at all (marked below) so this
// register is not limited to only what that formula happens to cover.
const FORM_CODE_SUGGESTIONS = [
  "GSTR-1",
  "GSTR-3B",
  "GSTR-9", // annual return — not computed by get_compliance_calendar
  "TDS Payment",
  "TDS Return (Form 138/140)",
  "TCS Payment",
  "TCS Return (Form 143)",
  "Advance Tax",
  "ITR",
  "Tax Audit Report (Form 3CA/3CB-3CD)",
  "AOC-4",
  "MGT-7",
  "MGT-7A",
  "DIR-3 KYC",
  "DPT-3",
  "MSME Form-1",
  "LLP Form 11",
  "LLP Form 8",
  "PF (ECR)",
  "ESI Monthly Contribution",
  "ESI Half-Yearly Return",
];

// Forms a GST registration is relevant for — used only to decide whether the
// registration picker starts open by default when adding a new row; the
// picker is never hidden outright, since form_code is free text and a
// user typing an unlisted GST form should still be able to pick one.
const GST_FORM_HINTS = ["gstr-1", "gstr-3b", "gstr-9"];

const STATUS_LABEL: Record<FilingRecord["status"], string> = {
  pending: "Pending",
  filed: "Filed",
  not_applicable: "Not applicable",
};

function statusBadge(status: FilingRecord["status"]) {
  if (status === "filed") return <Badge tone="ok">Filed</Badge>;
  if (status === "not_applicable") return <Badge tone="neutral">Not applicable</Badge>;
  return <Badge tone="warn">Pending</Badge>;
}

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

type FormState = {
  formCode: string;
  gstRegistrationId: string;
  periodLabel: string;
  status: FilingRecord["status"];
  filedDate: string;
  acknowledgementNumber: string;
  feePaid: string;
  additionalFee: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
  formCode: "",
  gstRegistrationId: "",
  periodLabel: "",
  status: "pending",
  filedDate: "",
  acknowledgementNumber: "",
  feePaid: "0",
  additionalFee: "0",
  notes: "",
};

function toRow(r: FilingRecord): FormState {
  return {
    formCode: r.form_code,
    gstRegistrationId: r.gst_registration_id ?? "",
    periodLabel: r.period_label,
    status: r.status,
    filedDate: r.filed_date ?? "",
    acknowledgementNumber: r.acknowledgement_number ?? "",
    feePaid: String(r.fee_paid ?? 0),
    additionalFee: String(r.additional_fee ?? 0),
    notes: r.notes ?? "",
  };
}

function toPayload(f: FormState) {
  return {
    form_code: f.formCode.trim(),
    gst_registration_id: f.gstRegistrationId || null,
    period_label: f.periodLabel.trim(),
    status: f.status,
    filed_date: f.status === "filed" ? f.filedDate || null : null,
    acknowledgement_number: f.acknowledgementNumber.trim() || null,
    fee_paid: Number(f.feePaid) || 0,
    additional_fee: Number(f.additionalFee) || 0,
    notes: f.notes.trim() || null,
  };
}

function FormFields({
  value,
  onChange,
  registrations,
}: {
  value: FormState;
  onChange: (next: FormState) => void;
  registrations: GstRegistration[];
}) {
  const looksLikeGst = GST_FORM_HINTS.includes(value.formCode.trim().toLowerCase());
  const filedMissing = value.status === "filed" && value.filedDate.trim().length === 0;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">Form</span>
        <input
          required
          list="filing-register-form-codes"
          value={value.formCode}
          onChange={(e) => onChange({ ...value, formCode: e.target.value })}
          placeholder="e.g. GSTR-3B, TDS Return (Form 138/140), AOC-4"
          className={field}
        />
        <datalist id="filing-register-form-codes">
          {FORM_CODE_SUGGESTIONS.map((code) => (
            <option key={code} value={code} />
          ))}
        </datalist>
      </label>

      {registrations.length > 0 && (
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-sm font-medium">
            GST registration{" "}
            <span className="font-normal text-ink-faint">
              — only for GST forms (GSTR-1, GSTR-3B, …); leave blank otherwise
            </span>
          </span>
          <select
            value={value.gstRegistrationId}
            onChange={(e) => onChange({ ...value, gstRegistrationId: e.target.value })}
            className={field}
          >
            <option value="">— not a GST filing —</option>
            {registrations.map((r) => (
              <option key={r.id} value={r.id}>
                {r.gstin} ({r.state_code})
              </option>
            ))}
          </select>
          {looksLikeGst && value.gstRegistrationId === "" && (
            <span className="text-xs text-warning">
              This looks like a GST form — pick which registration it belongs to.
            </span>
          )}
        </label>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Period <span className="font-normal text-ink-faint">— whatever grain this form files at</span>
        </span>
        <input
          required
          value={value.periodLabel}
          onChange={(e) => onChange({ ...value, periodLabel: e.target.value })}
          placeholder="Aug 2026, 2026-27 Q1, FY 2025-26"
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Status</span>
        <select
          value={value.status}
          onChange={(e) => {
            const status = e.target.value as FormState["status"];
            onChange({ ...value, status, filedDate: status === "filed" ? value.filedDate : "" });
          }}
          className={field}
        >
          <option value="pending">Pending — not yet filed</option>
          <option value="filed">Filed</option>
          <option value="not_applicable">Not applicable</option>
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Filed on</span>
        <input
          type="date"
          required={value.status === "filed"}
          disabled={value.status !== "filed"}
          value={value.filedDate}
          onChange={(e) => onChange({ ...value, filedDate: e.target.value })}
          className={field}
        />
        {filedMissing && <span className="text-xs text-warning">Required when status is Filed.</span>}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Acknowledgement no. <span className="font-normal text-ink-faint">ARN / SRN / ITR ack.</span>
        </span>
        <input
          value={value.acknowledgementNumber}
          onChange={(e) => onChange({ ...value, acknowledgementNumber: e.target.value })}
          className={field + " font-mono"}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Fee paid (₹)</span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={value.feePaid}
          onChange={(e) => onChange({ ...value, feePaid: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Additional / late fee (₹) <span className="font-normal text-ink-faint">optional</span>
        </span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={value.additionalFee}
          onChange={(e) => onChange({ ...value, additionalFee: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">Notes</span>
        <textarea
          value={value.notes}
          onChange={(e) => onChange({ ...value, notes: e.target.value })}
          rows={2}
          className={field}
        />
      </label>
    </div>
  );
}

const STATUS_FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "filed", label: "Filed" },
  { key: "not_applicable", label: "Not applicable" },
];

export function FilingRegisterManager({
  companyId,
  records,
  registrations,
  filter,
}: {
  companyId: string;
  records: FilingRecord[];
  registrations: GstRegistration[];
  filter: string;
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);

  const visible = useMemo(
    () => (filter === "all" ? records : records.filter((r) => r.status === filter)),
    [records, filter]
  );

  // Already ordered form_code, then filed_date desc nulls first, then
  // created_at desc by get_filing_register — grouping here just buckets that
  // existing order, it does not re-sort. See 0095 for why period_label
  // itself cannot be the sort key.
  const groups = useMemo(() => {
    const map = new Map<string, FilingRecord[]>();
    for (const r of visible) {
      const bucket = map.get(r.form_code);
      if (bucket) bucket.push(r);
      else map.set(r.form_code, [r]);
    }
    return Array.from(map.entries());
  }, [visible]);

  async function addRecord(e: React.FormEvent) {
    e.preventDefault();
    if (form.status === "filed" && !form.filedDate) {
      toast.error("Filed date is required when status is Filed.");
      return;
    }
    setBusy(true);
    const { error } = await createClient()
      .from("filing_register")
      .insert({ company_id: companyId, ...toPayload(form) });
    setBusy(false);
    if (error) {
      if (error.code === "23505") {
        toast.error(
          "This form, period and GST registration is already recorded — find it below and edit that entry instead of adding a new one."
        );
      } else {
        toast.error(error.message);
      }
      return;
    }
    toast.success("Recorded");
    setForm(EMPTY_FORM);
    setShowForm(false);
    router.refresh();
  }

  function startEdit(r: FilingRecord) {
    setEditingId(r.id);
    setEditForm(toRow(r));
  }

  async function saveEdit(id: string) {
    if (editForm.status === "filed" && !editForm.filedDate) {
      toast.error("Filed date is required when status is Filed.");
      return;
    }
    setBusy(true);
    const { error } = await createClient()
      .from("filing_register")
      .update(toPayload(editForm))
      .eq("id", id);
    setBusy(false);
    if (error) {
      if (error.code === "23505") {
        toast.error("Another entry already exists for that form, period and GST registration.");
      } else {
        toast.error(error.message);
      }
      return;
    }
    toast.success("Saved");
    setEditingId(null);
    router.refresh();
  }

  function renderRow(r: FilingRecord) {
    const isEditing = editingId === r.id;
    return (
      <Fragment key={r.id}>
        <tr className="border-b border-border last:border-0">
          <td className={td}>{statusBadge(r.status)}</td>
          <td className={td}>{r.period_label}</td>
          <td className={td + " text-ink-soft"}>{r.gstin ?? <span className="text-ink-faint">—</span>}</td>
          <td className={td + " whitespace-nowrap"}>{r.filed_date ?? <span className="text-ink-faint">—</span>}</td>
          <td className={td + " font-mono text-xs text-ink-soft"}>
            {r.acknowledgement_number ?? <span className="text-ink-faint">—</span>}
          </td>
          <td className={td + " text-right font-mono tabular-nums"}>{formatINR(r.fee_paid)}</td>
          <td className={td + " text-right font-mono tabular-nums"}>{formatINR(r.additional_fee)}</td>
          <td className={td + " max-w-[16rem] truncate text-ink-soft"} title={r.notes ?? undefined}>
            {r.notes ?? <span className="text-ink-faint">—</span>}
          </td>
          <td className={td}>
            <button
              type="button"
              onClick={() => (isEditing ? setEditingId(null) : startEdit(r))}
              className="text-xs text-accent underline underline-offset-2"
            >
              {isEditing ? "Cancel" : "Edit"}
            </button>
          </td>
        </tr>
        {isEditing && (
          <tr className="border-b border-border bg-bg">
            <td colSpan={9} className="px-4 py-4">
              <FormFields value={editForm} onChange={setEditForm} registrations={registrations} />
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => saveEdit(r.id)}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="rounded-lg border border-border-strong px-4 py-2 text-sm hover:bg-surface-2"
                >
                  Cancel
                </button>
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          {STATUS_FILTERS.map((f) => (
            <a
              key={f.key}
              href={`?filter=${f.key}`}
              className={
                "rounded-md border px-2.5 py-1 " +
                (filter === f.key
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-strong hover:bg-surface-2")
              }
            >
              {f.label}
            </a>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : "Record a filing"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={addRecord} className="rounded-[14px] border border-border bg-surface p-4">
          <FormFields value={form} onChange={setForm} registrations={registrations} />
          <button
            type="submit"
            disabled={busy}
            className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      )}

      {groups.length === 0 && (
        <div className="rounded-[14px] border border-border bg-surface p-8 text-center text-sm text-ink-faint">
          {filter === "all"
            ? "No filings recorded yet."
            : `No ${STATUS_LABEL[filter as FilingRecord["status"]]?.toLowerCase() ?? filter} filings.`}
        </div>
      )}

      {groups.map(([formCode, rows]) => (
        <section key={formCode}>
          <h2 className="mb-2 text-sm font-semibold text-ink-soft">
            {formCode} <span className="font-normal text-ink-faint">({rows.length})</span>
          </h2>
          <TableContainer>
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className={th}>Status</th>
                  <th className={th}>Period</th>
                  <th className={th}>GSTIN</th>
                  <th className={th}>Filed on</th>
                  <th className={th}>Ack. no.</th>
                  <th className={th + " text-right"}>Fee paid</th>
                  <th className={th + " text-right"}>Additional fee</th>
                  <th className={th}>Notes</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>{rows.map(renderRow)}</tbody>
            </table>
          </TableContainer>
        </section>
      ))}
    </div>
  );
}
