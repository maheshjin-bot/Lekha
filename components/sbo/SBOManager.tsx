"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td } from "@/components/ui/Table";

export type SBO = {
  id: string;
  individual_name: string;
  pan: string | null;
  interest_nature: "direct" | "indirect";
  held_through_entity_name: string | null;
  held_through_entity_type: string | null;
  qualifying_basis: string[];
  percentage_held: number | null;
  date_became_sbo: string;
  date_ceased_sbo: string | null;
  ben1_received_date: string | null;
  ben2_filed_date: string | null;
  notes: string | null;
};

// Mirrors app_private.is_valid_pan exactly (see components/directors/DirectorManager.tsx).
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const ENTITY_TYPE_LABEL: Record<string, string> = {
  body_corporate: "Body corporate",
  huf: "HUF (individual is karta)",
  partnership_entity: "Partnership entity",
  trust: "Trust",
  pooled_investment_vehicle: "Pooled investment vehicle",
  other: "Other",
};
const ENTITY_TYPE_OPTIONS = Object.keys(ENTITY_TYPE_LABEL);

const BASIS_LABEL: Record<string, string> = {
  shares: "Shares (≥10%)",
  voting_rights: "Voting rights (≥10%)",
  dividend_right: "Right to dividend/distribution (≥10%)",
  significant_influence: "Significant influence",
  control: "Control",
};
const BASIS_OPTIONS = Object.keys(BASIS_LABEL);

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

type FormState = {
  individualName: string;
  pan: string;
  interestNature: "direct" | "indirect";
  heldThroughEntityName: string;
  heldThroughEntityType: string;
  qualifyingBasis: string[];
  percentageHeld: string;
  dateBecameSbo: string;
  dateCeasedSbo: string;
  ben1ReceivedDate: string;
  ben2FiledDate: string;
  notes: string;
};

const EMPTY_FORM: FormState = {
  individualName: "",
  pan: "",
  interestNature: "indirect",
  heldThroughEntityName: "",
  heldThroughEntityType: "body_corporate",
  qualifyingBasis: [],
  percentageHeld: "",
  dateBecameSbo: "",
  dateCeasedSbo: "",
  ben1ReceivedDate: "",
  ben2FiledDate: "",
  notes: "",
};

function toRow(s: SBO): FormState {
  return {
    individualName: s.individual_name,
    pan: s.pan ?? "",
    interestNature: s.interest_nature,
    heldThroughEntityName: s.held_through_entity_name ?? "",
    heldThroughEntityType: s.held_through_entity_type ?? "body_corporate",
    qualifyingBasis: s.qualifying_basis ?? [],
    percentageHeld: s.percentage_held === null ? "" : String(s.percentage_held),
    dateBecameSbo: s.date_became_sbo,
    dateCeasedSbo: s.date_ceased_sbo ?? "",
    ben1ReceivedDate: s.ben1_received_date ?? "",
    ben2FiledDate: s.ben2_filed_date ?? "",
    notes: s.notes ?? "",
  };
}

function toPayload(f: FormState) {
  const indirect = f.interestNature === "indirect";
  return {
    individual_name: f.individualName.trim(),
    pan: f.pan.trim() || null,
    interest_nature: f.interestNature,
    held_through_entity_name: indirect ? f.heldThroughEntityName.trim() || null : null,
    held_through_entity_type: indirect ? f.heldThroughEntityType : null,
    qualifying_basis: f.qualifyingBasis,
    percentage_held: f.percentageHeld.trim() === "" ? null : Number(f.percentageHeld),
    date_became_sbo: f.dateBecameSbo,
    date_ceased_sbo: f.dateCeasedSbo || null,
    ben1_received_date: f.ben1ReceivedDate || null,
    ben2_filed_date: f.ben2FiledDate || null,
    notes: f.notes.trim() || null,
  };
}

function FormFields({
  value,
  onChange,
}: {
  value: FormState;
  onChange: (next: FormState) => void;
}) {
  const panOk = value.pan.length === 0 || PAN_PATTERN.test(value.pan);
  const indirect = value.interestNature === "indirect";

  function toggleBasis(b: string) {
    onChange({
      ...value,
      qualifyingBasis: value.qualifyingBasis.includes(b)
        ? value.qualifyingBasis.filter((x) => x !== b)
        : [...value.qualifyingBasis, b],
    });
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">Individual name</span>
        <input
          required
          value={value.individualName}
          onChange={(e) => onChange({ ...value, individualName: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          PAN <span className="font-normal text-ink-faint">optional</span>
        </span>
        <input
          value={value.pan}
          onChange={(e) => onChange({ ...value, pan: e.target.value.toUpperCase() })}
          maxLength={10}
          placeholder="AAAAA0000A"
          className={field + " font-mono uppercase"}
        />
        {value.pan.length > 0 && !panOk && (
          <span className="text-xs text-warning">
            That doesn&rsquo;t match the PAN format (5 letters, 4 digits, 1 letter).
          </span>
        )}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          % held <span className="font-normal text-ink-faint">optional — see note below</span>
        </span>
        <input
          type="number"
          min="0.01"
          max="100"
          step="0.01"
          value={value.percentageHeld}
          onChange={(e) => onChange({ ...value, percentageHeld: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Nature of interest</span>
        <select
          value={value.interestNature}
          onChange={(e) =>
            onChange({ ...value, interestNature: e.target.value as FormState["interestNature"] })
          }
          className={field}
        >
          <option value="indirect">Indirect — held through another entity</option>
          <option value="direct">Direct — undisclosed Sec 89(2) beneficial interest</option>
        </select>
      </label>

      <div />

      {indirect && (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Held through — entity name</span>
            <input
              required={indirect}
              value={value.heldThroughEntityName}
              onChange={(e) => onChange({ ...value, heldThroughEntityName: e.target.value })}
              placeholder="e.g. Malhotra Holdings Private Limited"
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Held through — entity type</span>
            <select
              value={value.heldThroughEntityType}
              onChange={(e) => onChange({ ...value, heldThroughEntityType: e.target.value })}
              className={field}
            >
              {ENTITY_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {ENTITY_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">
          Qualifying basis (Sec 90(1)){" "}
          <span className="font-normal text-ink-faint">tick every limb actually declared</span>
        </span>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {BASIS_OPTIONS.map((b) => (
            <label key={b} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={value.qualifyingBasis.includes(b)}
                onChange={() => toggleBasis(b)}
              />
              {BASIS_LABEL[b]}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Date became SBO</span>
        <input
          required
          type="date"
          value={value.dateBecameSbo}
          onChange={(e) => onChange({ ...value, dateBecameSbo: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Date ceased to be SBO{" "}
          <span className="font-normal text-ink-faint">leave blank if still an SBO</span>
        </span>
        <input
          type="date"
          value={value.dateCeasedSbo}
          onChange={(e) => onChange({ ...value, dateCeasedSbo: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          BEN-1 received date <span className="font-normal text-ink-faint">optional</span>
        </span>
        <input
          type="date"
          value={value.ben1ReceivedDate}
          onChange={(e) =>
            onChange({
              ...value,
              ben1ReceivedDate: e.target.value,
              // Can't file BEN-2 about a declaration not yet on record — mirrors the DB CHECK.
              ben2FiledDate: e.target.value ? value.ben2FiledDate : "",
            })
          }
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          BEN-2 filed date{" "}
          <span className="font-normal text-ink-faint">
            optional — this app does not e-file it, tracking only
          </span>
        </span>
        <input
          type="date"
          value={value.ben2FiledDate}
          onChange={(e) => onChange({ ...value, ben2FiledDate: e.target.value })}
          disabled={value.ben1ReceivedDate.length === 0}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">
          Notes <span className="font-normal text-ink-faint">optional</span>
        </span>
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

export function SBOManager({
  companyId,
  owners,
  entityType,
}: {
  companyId: string;
  owners: SBO[];
  entityType: string | null;
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
        Significant beneficial ownership declarations don&rsquo;t apply here. Sec 90 Companies
        Act 2013 and the Companies (Significant Beneficial Owners) Rules, 2018 reach a company
        limited by shares — this app treats pvt_ltd, ltd and opc as that (the same three entity
        types share capital and the Register of Members already gate on). An LLP has its own,
        separate Limited Liability Partnership (Significant Beneficial Owners) Rules, 2023 with
        its own LLP BEN-1 to BEN-4 forms — not this table — and a proprietorship, partnership,
        HUF, AOP/BOI, trust or society has no share capital and no SBO regime at all. The
        database enforces this too: it will refuse a declaration for any other entity type, not
        just hide the button here.
      </div>
    );
  }

  const current = owners.filter((o) => !o.date_ceased_sbo);
  const past = owners.filter((o) => o.date_ceased_sbo);

  async function addOwner(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    // significant_beneficial_owners is brand new (migration 0296) — not yet
    // in the generated database types (owned by the integration pass),
    // hence the disabled rule below, same convention as
    // ManufacturingManager.tsx's bom_outputs / EinvoiceDetailForm.tsx's
    // einvoice_details. RLS and the runtime shape are both verified live.
    const { error } = await createClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .from("significant_beneficial_owners" as any)
      .insert({
        company_id: companyId,
        ...toPayload(form),
      });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Added");
    setForm(EMPTY_FORM);
    setShowForm(false);
    router.refresh();
  }

  function startEdit(o: SBO) {
    setEditingId(o.id);
    setEditForm(toRow(o));
  }

  async function saveEdit(id: string) {
    setBusy(true);
    const { error } = await createClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see addOwner above
      .from("significant_beneficial_owners" as any)
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

  function renderRow(o: SBO) {
    const isEditing = editingId === o.id;
    return (
      <Fragment key={o.id}>
        <tr className="border-b border-border last:border-0">
          <td className={td}>
            {o.individual_name}
            {o.pan && <div className="font-mono text-xs text-ink-faint">{o.pan}</div>}
          </td>
          <td className={td}>
            {o.interest_nature === "indirect" ? (
              <>
                Indirect
                <div className="text-xs text-ink-faint">
                  via {o.held_through_entity_name}
                  {o.held_through_entity_type &&
                    ` (${ENTITY_TYPE_LABEL[o.held_through_entity_type] ?? o.held_through_entity_type})`}
                </div>
              </>
            ) : (
              "Direct"
            )}
          </td>
          <td className={td + " text-xs"}>
            {o.qualifying_basis.length === 0 ? (
              <span className="text-ink-faint">—</span>
            ) : (
              o.qualifying_basis.map((b) => BASIS_LABEL[b] ?? b).join(", ")
            )}
          </td>
          <td className={td + " font-mono text-xs tabular-nums"}>
            {o.percentage_held === null ? (
              <span className="text-ink-faint">—</span>
            ) : (
              `${o.percentage_held}%`
            )}
          </td>
          <td className={td + " whitespace-nowrap"}>{o.date_became_sbo}</td>
          <td className={td}>
            {o.date_ceased_sbo ? (
              <Badge tone="neutral">Ceased {o.date_ceased_sbo}</Badge>
            ) : (
              <Badge tone="ok">Current SBO</Badge>
            )}
          </td>
          <td className={td + " text-xs"}>
            {o.ben1_received_date ? (
              <div>BEN-1: {o.ben1_received_date}</div>
            ) : (
              <div className="text-ink-faint">BEN-1 not received</div>
            )}
            {o.ben2_filed_date ? (
              <div>BEN-2: {o.ben2_filed_date}</div>
            ) : (
              <div className="text-ink-faint">BEN-2 not filed</div>
            )}
          </td>
          <td className={td}>
            <button
              type="button"
              onClick={() => (isEditing ? setEditingId(null) : startEdit(o))}
              className="text-xs text-accent underline underline-offset-2"
            >
              {isEditing ? "Cancel" : "Edit"}
            </button>
          </td>
        </tr>
        {isEditing && (
          <tr className="border-b border-border bg-bg">
            <td colSpan={8} className="px-4 py-4">
              <FormFields value={editForm} onChange={setEditForm} />
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => saveEdit(o.id)}
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

  const columns = (
    <tr className="border-b border-border text-left">
      <th className={th}>Individual</th>
      <th className={th}>Nature of interest</th>
      <th className={th}>Qualifying basis</th>
      <th className={th}>% held</th>
      <th className={th}>Became SBO</th>
      <th className={th}>Status</th>
      <th className={th}>BEN-1 / BEN-2</th>
      <th className={th}></th>
    </tr>
  );

  return (
    <div className="mt-6 flex flex-col gap-8">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : "Add SBO declaration"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={addOwner} className="rounded-[14px] border border-border bg-surface p-4">
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
        <h2 className="mb-2 text-sm font-semibold text-ink-soft">
          Current SBOs ({current.length})
        </h2>
        <TableContainer>
          <table className="w-full min-w-[960px] text-sm">
            <thead>{columns}</thead>
            <tbody>
              {current.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-ink-faint">
                    No significant beneficial owner is on record yet.
                  </td>
                </tr>
              )}
              {current.map(renderRow)}
            </tbody>
          </table>
        </TableContainer>
      </section>

      {past.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-ink-soft">Past ({past.length})</h2>
          <TableContainer>
            <table className="w-full min-w-[960px] text-sm">
              <thead>{columns}</thead>
              <tbody>{past.map(renderRow)}</tbody>
            </table>
          </TableContainer>
        </section>
      )}
    </div>
  );
}
