"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td } from "@/components/ui/Table";

type DirectorOption = {
  id: string;
  name: string;
  designation: string;
  date_of_cessation: string | null;
};

export type DscRow = {
  id: string;
  holder_director_id: string | null;
  holder_name: string | null;
  holder_label: string;
  // Genuinely nullable at runtime: get_dsc_expiry_status LEFT JOINs
  // company_directors, so a free-text (non-director) holder has no
  // designation. Supabase's typegen can't see through that LEFT JOIN and
  // marks the RPC's OUT column non-null — the cast at the call site in
  // dsc-register/page.tsx corrects it back to the real, nullable shape.
  designation: string | null;
  certifying_authority: string;
  dsc_class: string;
  valid_from: string;
  valid_to: string;
  token_serial_number: string | null;
  notes: string | null;
  days_remaining: number;
  is_expired: boolean;
  expiring_within_30_days: boolean;
  expiring_within_60_days: boolean;
  expiring_within_90_days: boolean;
};

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

type FormState = {
  holderMode: "director" | "other";
  holderDirectorId: string;
  holderName: string;
  certifyingAuthority: string;
  dscClass: string;
  validFrom: string;
  validTo: string;
  tokenSerialNumber: string;
  notes: string;
};

function emptyForm(defaultDirectorId: string): FormState {
  return {
    holderMode: defaultDirectorId ? "director" : "other",
    holderDirectorId: defaultDirectorId,
    holderName: "",
    certifyingAuthority: "",
    dscClass: "Class 3",
    validFrom: "",
    validTo: "",
    tokenSerialNumber: "",
    notes: "",
  };
}

function toRow(d: DscRow): FormState {
  return {
    holderMode: d.holder_director_id ? "director" : "other",
    holderDirectorId: d.holder_director_id ?? "",
    holderName: d.holder_name ?? "",
    certifyingAuthority: d.certifying_authority,
    dscClass: d.dsc_class,
    validFrom: d.valid_from,
    validTo: d.valid_to,
    tokenSerialNumber: d.token_serial_number ?? "",
    notes: d.notes ?? "",
  };
}

function toPayload(f: FormState) {
  return {
    holder_director_id: f.holderMode === "director" ? f.holderDirectorId || null : null,
    holder_name: f.holderMode === "other" ? f.holderName.trim() || null : null,
    certifying_authority: f.certifyingAuthority.trim(),
    dsc_class: f.dscClass.trim() || "Class 3",
    valid_from: f.validFrom,
    valid_to: f.validTo,
    token_serial_number: f.tokenSerialNumber.trim() || null,
    notes: f.notes.trim() || null,
  };
}

function statusBadge(d: DscRow) {
  if (d.is_expired) {
    return <Badge tone="bad">Expired {Math.abs(d.days_remaining)}d ago</Badge>;
  }
  if (d.expiring_within_30_days) {
    return <Badge tone="bad">Expires in {d.days_remaining}d</Badge>;
  }
  if (d.expiring_within_60_days) {
    return <Badge tone="warn">Expires in {d.days_remaining}d</Badge>;
  }
  if (d.expiring_within_90_days) {
    return <Badge tone="warn">Expires in {d.days_remaining}d</Badge>;
  }
  return <Badge tone="ok">Valid</Badge>;
}

function FormFields({
  value,
  onChange,
  directors,
}: {
  value: FormState;
  onChange: (next: FormState) => void;
  directors: DirectorOption[];
}) {
  const datesOk = !value.validFrom || !value.validTo || value.validTo >= value.validFrom;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">Holder</span>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={value.holderMode === "director"}
              onChange={() => onChange({ ...value, holderMode: "director" })}
            />
            A director / KMP on record
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={value.holderMode === "other"}
              onChange={() => onChange({ ...value, holderMode: "other" })}
            />
            Someone else (e.g. a practising CA)
          </label>
        </div>
      </div>

      {value.holderMode === "director" ? (
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-sm font-medium">Director / KMP</span>
          <select
            required
            value={value.holderDirectorId}
            onChange={(e) => onChange({ ...value, holderDirectorId: e.target.value })}
            className={field}
          >
            <option value="" disabled>
              Select…
            </option>
            {directors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} — {d.designation.replace(/_/g, " ")}
                {d.date_of_cessation ? " (ceased)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-sm font-medium">Holder name</span>
          <input
            required
            value={value.holderName}
            onChange={(e) => onChange({ ...value, holderName: e.target.value })}
            placeholder="e.g. CA Deepak Mehta (Statutory Auditor)"
            className={field}
          />
        </label>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Certifying authority</span>
        <input
          required
          value={value.certifyingAuthority}
          onChange={(e) => onChange({ ...value, certifyingAuthority: e.target.value })}
          placeholder="e.g. eMudhra, Sify SafeScrypt, Capricorn"
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          DSC class <span className="font-normal text-ink-faint">Class 3 covers MCA/GST/IT filings today</span>
        </span>
        <input
          value={value.dscClass}
          onChange={(e) => onChange({ ...value, dscClass: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Valid from</span>
        <input
          required
          type="date"
          value={value.validFrom}
          onChange={(e) => onChange({ ...value, validFrom: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Valid to</span>
        <input
          required
          type="date"
          value={value.validTo}
          onChange={(e) => onChange({ ...value, validTo: e.target.value })}
          className={field}
        />
        {!datesOk && <span className="text-xs text-warning">Valid-to can&rsquo;t be before valid-from.</span>}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Token / dongle serial <span className="font-normal text-ink-faint">optional</span>
        </span>
        <input
          value={value.tokenSerialNumber}
          onChange={(e) => onChange({ ...value, tokenSerialNumber: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">
          Notes <span className="font-normal text-ink-faint">optional</span>
        </span>
        <input
          value={value.notes}
          onChange={(e) => onChange({ ...value, notes: e.target.value })}
          className={field}
        />
      </label>
    </div>
  );
}

export function DscRegisterManager({
  companyId,
  rows,
  directors,
}: {
  companyId: string;
  rows: DscRow[];
  directors: DirectorOption[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm(directors[0]?.id ?? ""));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(emptyForm(""));

  async function addDsc(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await createClient().from("digital_signature_certificates").insert({
      company_id: companyId,
      ...toPayload(form),
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Added");
    setForm(emptyForm(directors[0]?.id ?? ""));
    setShowForm(false);
    router.refresh();
  }

  function startEdit(d: DscRow) {
    setEditingId(d.id);
    setEditForm(toRow(d));
  }

  async function saveEdit(id: string) {
    setBusy(true);
    const { error } = await createClient()
      .from("digital_signature_certificates")
      .update(toPayload(editForm))
      .eq("id", id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Saved");
    setEditingId(null);
    router.refresh();
  }

  async function removeDsc(id: string) {
    if (!confirm("Remove this DSC from the register?")) return;
    setBusy(true);
    const { error } = await createClient().from("digital_signature_certificates").delete().eq("id", id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Removed");
    router.refresh();
  }

  function renderRow(d: DscRow) {
    const isEditing = editingId === d.id;
    return (
      <Fragment key={d.id}>
        <tr className="border-b border-border last:border-0">
          <td className={td}>
            {d.holder_label}
            {d.designation && (
              <div className="text-xs text-ink-faint">{d.designation.replace(/_/g, " ")}</div>
            )}
          </td>
          <td className={td}>{d.certifying_authority}</td>
          <td className={td}>{d.dsc_class}</td>
          <td className={td + " whitespace-nowrap"}>
            {d.valid_from} → {d.valid_to}
          </td>
          <td className={td}>{statusBadge(d)}</td>
          <td className={td}>
            <button
              type="button"
              onClick={() => (isEditing ? setEditingId(null) : startEdit(d))}
              className="text-xs text-accent underline underline-offset-2"
            >
              {isEditing ? "Cancel" : "Edit"}
            </button>
            <button
              type="button"
              onClick={() => removeDsc(d.id)}
              className="ml-3 text-xs text-error underline underline-offset-2"
            >
              Remove
            </button>
          </td>
        </tr>
        {isEditing && (
          <tr className="border-b border-border bg-bg">
            <td colSpan={6} className="px-4 py-4">
              <FormFields value={editForm} onChange={setEditForm} directors={directors} />
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => saveEdit(d.id)}
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
    <div className="mt-6 flex flex-col gap-6">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : "Add DSC"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={addDsc} className="rounded-[14px] border border-border bg-surface p-4">
          <FormFields value={form} onChange={setForm} directors={directors} />
          <button
            type="submit"
            disabled={busy}
            className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      )}

      <TableContainer>
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Holder</th>
              <th className={th}>Certifying authority</th>
              <th className={th}>Class</th>
              <th className={th}>Validity</th>
              <th className={th}>Status</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-faint">
                  No DSC on record yet.
                </td>
              </tr>
            )}
            {rows.map(renderRow)}
          </tbody>
        </table>
      </TableContainer>
    </div>
  );
}
