"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td } from "@/components/ui/Table";
import { formatINR } from "@/lib/utils/currency";

type Charge = {
  id: string;
  charge_holder_name: string;
  charge_type: string;
  amount_secured: number;
  assets_charged: string;
  date_of_creation: string;
  chg1_filing_date: string | null;
  chg1_srn: string | null;
  date_of_satisfaction: string | null;
  chg4_filing_date: string | null;
  chg4_srn: string | null;
  notes: string | null;
};

type Summary = {
  live_charge_count: number;
  satisfied_charge_count: number;
  total_amount_secured_live: number;
  total_amount_secured_satisfied: number;
  chg1_not_yet_filed_count: number;
  chg1_overdue_count: number;
  chg4_not_yet_filed_count: number;
  chg4_overdue_count: number;
};

// Mirrors the charges_charge_type_check constraint (0115) exactly.
const CHARGE_TYPE_LABEL: Record<string, string> = {
  mortgage: "Mortgage",
  hypothecation: "Hypothecation",
  pledge: "Pledge",
  assignment: "Assignment",
  floating_charge: "Floating charge",
  lien: "Lien",
  other: "Other",
};
const CHARGE_TYPE_OPTIONS = Object.keys(CHARGE_TYPE_LABEL);

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

type FormState = {
  chargeHolderName: string;
  chargeType: string;
  amountSecured: string;
  assetsCharged: string;
  dateOfCreation: string;
  chg1FilingDate: string;
  chg1Srn: string;
  dateOfSatisfaction: string;
  chg4FilingDate: string;
  chg4Srn: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
  chargeHolderName: "",
  chargeType: "mortgage",
  amountSecured: "",
  assetsCharged: "",
  dateOfCreation: "",
  chg1FilingDate: "",
  chg1Srn: "",
  dateOfSatisfaction: "",
  chg4FilingDate: "",
  chg4Srn: "",
  notes: "",
};

function toRow(c: Charge): FormState {
  return {
    chargeHolderName: c.charge_holder_name,
    chargeType: c.charge_type,
    amountSecured: String(c.amount_secured),
    assetsCharged: c.assets_charged,
    dateOfCreation: c.date_of_creation,
    chg1FilingDate: c.chg1_filing_date ?? "",
    chg1Srn: c.chg1_srn ?? "",
    dateOfSatisfaction: c.date_of_satisfaction ?? "",
    chg4FilingDate: c.chg4_filing_date ?? "",
    chg4Srn: c.chg4_srn ?? "",
    notes: c.notes ?? "",
  };
}

function toPayload(f: FormState) {
  return {
    charge_holder_name: f.chargeHolderName.trim(),
    charge_type: f.chargeType,
    amount_secured: Number(f.amountSecured),
    assets_charged: f.assetsCharged.trim(),
    date_of_creation: f.dateOfCreation,
    chg1_filing_date: f.chg1FilingDate || null,
    chg1_srn: f.chg1Srn.trim() || null,
    date_of_satisfaction: f.dateOfSatisfaction || null,
    chg4_filing_date: f.chg4FilingDate || null,
    chg4_srn: f.chg4Srn.trim() || null,
    notes: f.notes.trim() || null,
  };
}

function FormFields({ value, onChange }: { value: FormState; onChange: (next: FormState) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">Charge holder (lender)</span>
        <input
          required
          value={value.chargeHolderName}
          onChange={(e) => onChange({ ...value, chargeHolderName: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Charge type</span>
        <select
          value={value.chargeType}
          onChange={(e) => onChange({ ...value, chargeType: e.target.value })}
          className={field}
        >
          {CHARGE_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {CHARGE_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Amount secured (Rs.)</span>
        <input
          required
          type="number"
          min="0"
          step="any"
          value={value.amountSecured}
          onChange={(e) => onChange({ ...value, amountSecured: e.target.value })}
          className={field + " font-mono"}
        />
      </label>

      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">Assets charged</span>
        <input
          required
          value={value.assetsCharged}
          onChange={(e) => onChange({ ...value, assetsCharged: e.target.value })}
          placeholder="e.g. Plant and machinery at the Pune unit"
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Date of creation</span>
        <input
          required
          type="date"
          value={value.dateOfCreation}
          onChange={(e) => onChange({ ...value, dateOfCreation: e.target.value })}
          className={field}
        />
      </label>

      <div />

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          CHG-1 filing date <span className="font-normal text-ink-faint">optional</span>
        </span>
        <input
          type="date"
          value={value.chg1FilingDate}
          onChange={(e) =>
            onChange({
              ...value,
              chg1FilingDate: e.target.value,
              chg1Srn: e.target.value ? value.chg1Srn : "",
            })
          }
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          CHG-1 SRN <span className="font-normal text-ink-faint">needs a filing date first</span>
        </span>
        <input
          value={value.chg1Srn}
          disabled={!value.chg1FilingDate}
          onChange={(e) => onChange({ ...value, chg1Srn: e.target.value })}
          className={field + " font-mono uppercase disabled:opacity-50"}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Date of satisfaction{" "}
          <span className="font-normal text-ink-faint">leave blank while the charge is live</span>
        </span>
        <input
          type="date"
          value={value.dateOfSatisfaction}
          onChange={(e) =>
            onChange({
              ...value,
              dateOfSatisfaction: e.target.value,
              chg4FilingDate: e.target.value ? value.chg4FilingDate : "",
              chg4Srn: e.target.value ? value.chg4Srn : "",
            })
          }
          className={field}
        />
      </label>

      <div />

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          CHG-4 filing date{" "}
          <span className="font-normal text-ink-faint">needs a satisfaction date first</span>
        </span>
        <input
          type="date"
          value={value.chg4FilingDate}
          disabled={!value.dateOfSatisfaction}
          onChange={(e) =>
            onChange({
              ...value,
              chg4FilingDate: e.target.value,
              chg4Srn: e.target.value ? value.chg4Srn : "",
            })
          }
          className={field + " disabled:opacity-50"}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          CHG-4 SRN <span className="font-normal text-ink-faint">needs a filing date first</span>
        </span>
        <input
          value={value.chg4Srn}
          disabled={!value.chg4FilingDate}
          onChange={(e) => onChange({ ...value, chg4Srn: e.target.value })}
          className={field + " font-mono uppercase disabled:opacity-50"}
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

function SummaryCards({ s }: { s: Summary | undefined }) {
  if (!s) return null;
  return (
    <div className="grid grid-cols-2 gap-3 rounded-[14px] border border-border bg-surface p-4 text-sm sm:grid-cols-4">
      <div>
        <div className="text-[11px] uppercase tracking-wide text-ink-faint">Live charges</div>
        <div className="font-mono text-base tabular-nums font-semibold text-ink">
          {s.live_charge_count}
        </div>
        <div className="text-xs text-ink-faint">
          {formatINR(s.total_amount_secured_live, { showZero: true })} secured
        </div>
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-ink-faint">Satisfied</div>
        <div className="font-mono text-base tabular-nums font-semibold text-ink">
          {s.satisfied_charge_count}
        </div>
        <div className="text-xs text-ink-faint">
          {formatINR(s.total_amount_secured_satisfied, { showZero: true })} secured
        </div>
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-ink-faint">CHG-1 pending</div>
        <div className="font-mono text-base tabular-nums font-semibold text-ink">
          {s.chg1_not_yet_filed_count}
        </div>
        {s.chg1_overdue_count > 0 && (
          <Badge tone="bad" className="mt-0.5">
            {s.chg1_overdue_count} past 120 days
          </Badge>
        )}
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-ink-faint">CHG-4 pending</div>
        <div className="font-mono text-base tabular-nums font-semibold text-ink">
          {s.chg4_not_yet_filed_count}
        </div>
        {s.chg4_overdue_count > 0 && (
          <Badge tone="bad" className="mt-0.5">
            {s.chg4_overdue_count} past 120 days
          </Badge>
        )}
      </div>
    </div>
  );
}

export function ChargeRegisterManager({
  companyId,
  entityType,
  charges,
  summary,
}: {
  companyId: string;
  entityType: string | null;
  charges: Charge[];
  summary: Summary[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);

  const eligible = entityType === "pvt_ltd" || entityType === "ltd" || entityType === "opc";

  if (!eligible) {
    return (
      <div className="rounded-[14px] border border-border bg-surface-2 p-5 text-sm text-ink-soft">
        Sec 77-87 charge registration (CHG-1/CHG-4) doesn&rsquo;t apply here. This app treats
        pvt_ltd, ltd and opc as &ldquo;a company&rdquo; for this purpose — the same three entity
        types its Register of Members (Sec 88) already uses. An LLP has a parallel but separate
        charge-filing duty on Form 8 under the LLP Act, not tracked on this screen. The database
        enforces this too: it will refuse a charge for any other entity type, not just hide the
        form here.
      </div>
    );
  }

  const live = charges.filter((c) => !c.date_of_satisfaction);
  const satisfied = charges.filter((c) => c.date_of_satisfaction);

  async function addCharge(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await createClient()
      .from("charges")
      .insert({ company_id: companyId, ...toPayload(form) });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Charge recorded");
    setForm(EMPTY_FORM);
    setShowForm(false);
    router.refresh();
  }

  function startEdit(c: Charge) {
    setEditingId(c.id);
    setEditForm(toRow(c));
  }

  async function saveEdit(id: string) {
    setBusy(true);
    const { error } = await createClient().from("charges").update(toPayload(editForm)).eq("id", id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Saved");
    setEditingId(null);
    router.refresh();
  }

  function renderRow(c: Charge) {
    const isEditing = editingId === c.id;
    return (
      <Fragment key={c.id}>
        <tr className="border-b border-border last:border-0">
          <td className={td}>{c.charge_holder_name}</td>
          <td className={td}>{CHARGE_TYPE_LABEL[c.charge_type] ?? c.charge_type}</td>
          <td className={td + " text-right font-mono tabular-nums"}>
            {formatINR(c.amount_secured, { showZero: true })}
          </td>
          <td className={td + " whitespace-nowrap"}>{c.date_of_creation}</td>
          <td className={td}>
            {c.chg1_filing_date ? (
              <span className="text-xs text-ink-soft">
                Filed {c.chg1_filing_date}
                {c.chg1_srn && <span className="block font-mono text-ink-faint">{c.chg1_srn}</span>}
              </span>
            ) : (
              <Badge tone="warn">Not filed</Badge>
            )}
          </td>
          <td className={td}>
            {c.date_of_satisfaction ? (
              <Badge tone="neutral">Satisfied {c.date_of_satisfaction}</Badge>
            ) : (
              <Badge tone="ok">Live</Badge>
            )}
          </td>
          <td className={td}>
            <button
              type="button"
              onClick={() => (isEditing ? setEditingId(null) : startEdit(c))}
              className="text-xs text-accent underline underline-offset-2"
            >
              {isEditing ? "Cancel" : "Edit"}
            </button>
          </td>
        </tr>
        {isEditing && (
          <tr className="border-b border-border bg-bg">
            <td colSpan={7} className="px-4 py-4">
              <FormFields value={editForm} onChange={setEditForm} />
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => saveEdit(c.id)}
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
      <SummaryCards s={summary[0]} />

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : "Record a charge"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={addCharge} className="rounded-[14px] border border-border bg-surface p-4">
          <FormFields value={form} onChange={setForm} />
          <button
            type="submit"
            disabled={busy}
            className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-soft">Live ({live.length})</h2>
        <TableContainer>
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Charge holder</th>
                <th className={th}>Type</th>
                <th className={th + " text-right"}>Amount secured</th>
                <th className={th}>Created</th>
                <th className={th}>CHG-1</th>
                <th className={th}>Status</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {live.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
                    No live charges on record.
                  </td>
                </tr>
              )}
              {live.map(renderRow)}
            </tbody>
          </table>
        </TableContainer>
      </section>

      {satisfied.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink-soft">Satisfied ({satisfied.length})</h2>
          <TableContainer>
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className={th}>Charge holder</th>
                  <th className={th}>Type</th>
                  <th className={th + " text-right"}>Amount secured</th>
                  <th className={th}>Created</th>
                  <th className={th}>CHG-1</th>
                  <th className={th}>Status</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>{satisfied.map(renderRow)}</tbody>
            </table>
          </TableContainer>
        </section>
      )}
    </div>
  );
}
