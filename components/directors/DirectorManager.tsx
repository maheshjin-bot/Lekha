"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { formatINR } from "@/lib/utils/currency";

type Director = {
  id: string;
  name: string;
  din: string | null;
  din_allotment_date: string | null;
  designation: string;
  pan: string | null;
  date_of_appointment: string;
  date_of_cessation: string | null;
  is_opc_nominee: boolean;
};

// LLP-only additions (see 0097). Every type/state/handler below this comment
// block and gated on entityType === "llp" is additive — a non-LLP company
// never renders it, never calls addContribution, and the two extra props
// default to empty arrays when the caller (app/(app)/[companyId]/directors/
// page.tsx) doesn't fetch them.

type Contribution = {
  id: string;
  director_id: string;
  contribution_type: "cash" | "kind";
  amount: number;
  contribution_date: string;
  valuation_certificate_reference: string | null;
  notes: string | null;
};

const CONTRIBUTION_TYPE_LABEL: Record<Contribution["contribution_type"], string> = {
  cash: "Cash",
  kind: "In kind",
};

type ContribFormState = {
  contributionType: "cash" | "kind";
  amount: string;
  contributionDate: string;
  valuationCertificateReference: string;
  notes: string;
};

const EMPTY_CONTRIB_FORM: ContribFormState = {
  contributionType: "cash",
  amount: "",
  contributionDate: "",
  valuationCertificateReference: "",
  notes: "",
};

// Mirrors app_private.is_valid_pan exactly (see components/employees/EmployeeManager.tsx).
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
// Mirrors the company_directors_din_check constraint (0088) exactly — a bare
// 8-digit run, no separator convention to strip.
const DIN_PATTERN = /^[0-9]{8}$/;

const DESIGNATION_LABEL: Record<string, string> = {
  director: "Director",
  managing_director: "Managing Director",
  whole_time_director: "Whole-time Director",
  independent_director: "Independent Director",
  nominee_director: "Nominee Director (board)",
  additional_director: "Additional Director",
  alternate_director: "Alternate Director",
  designated_partner: "Designated Partner (LLP)",
  company_secretary: "Company Secretary",
  chief_financial_officer: "Chief Financial Officer",
  manager: "Manager",
  ceo: "CEO",
  opc_nominee: "OPC nominee (Sec 3(1) member successor)",
};

const DESIGNATION_OPTIONS = Object.keys(DESIGNATION_LABEL);

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

type FormState = {
  name: string;
  din: string;
  dinAllotmentDate: string;
  designation: string;
  pan: string;
  dateOfAppointment: string;
  dateOfCessation: string;
  isOpcNominee: boolean;
};

const EMPTY_FORM: FormState = {
  name: "",
  din: "",
  dinAllotmentDate: "",
  designation: "director",
  pan: "",
  dateOfAppointment: "",
  dateOfCessation: "",
  isOpcNominee: false,
};

function toRow(d: Director): FormState {
  return {
    name: d.name,
    din: d.din ?? "",
    dinAllotmentDate: d.din_allotment_date ?? "",
    designation: d.designation,
    pan: d.pan ?? "",
    dateOfAppointment: d.date_of_appointment,
    dateOfCessation: d.date_of_cessation ?? "",
    isOpcNominee: d.is_opc_nominee,
  };
}

function toPayload(f: FormState) {
  return {
    name: f.name.trim(),
    din: f.din.trim() || null,
    din_allotment_date: f.dinAllotmentDate || null,
    designation: f.designation,
    pan: f.pan.trim() || null,
    date_of_appointment: f.dateOfAppointment,
    date_of_cessation: f.dateOfCessation || null,
    is_opc_nominee: f.designation === "opc_nominee" ? true : f.isOpcNominee,
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
  const dinOk = value.din.length === 0 || DIN_PATTERN.test(value.din);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">Name</span>
        <input
          required
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Designation</span>
        <select
          value={value.designation}
          onChange={(e) => onChange({ ...value, designation: e.target.value })}
          className={field}
        >
          {DESIGNATION_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {DESIGNATION_LABEL[d]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          DIN <span className="font-normal text-ink-faint">optional — 8 digits</span>
        </span>
        <input
          value={value.din}
          onChange={(e) => onChange({ ...value, din: e.target.value.replace(/[^0-9]/g, "") })}
          maxLength={8}
          placeholder="01234567"
          className={field + " font-mono"}
        />
        {value.din.length > 0 && !dinOk && (
          <span className="text-xs text-warning">DIN is 8 digits.</span>
        )}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          DIN allotment date <span className="font-normal text-ink-faint">optional</span>
        </span>
        <input
          type="date"
          value={value.dinAllotmentDate}
          onChange={(e) => onChange({ ...value, dinAllotmentDate: e.target.value })}
          className={field}
          disabled={value.din.length === 0}
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
        <span className="text-sm font-medium">Date of appointment</span>
        <input
          required
          type="date"
          value={value.dateOfAppointment}
          onChange={(e) => onChange({ ...value, dateOfAppointment: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Date of cessation{" "}
          <span className="font-normal text-ink-faint">leave blank if still serving</span>
        </span>
        <input
          type="date"
          value={value.dateOfCessation}
          onChange={(e) => onChange({ ...value, dateOfCessation: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          checked={value.designation === "opc_nominee" ? true : value.isOpcNominee}
          disabled={value.designation === "opc_nominee"}
          onChange={(e) => onChange({ ...value, isOpcNominee: e.target.checked })}
        />
        Also the OPC&rsquo;s Sec 3(1) member nominee{" "}
        <span className="text-ink-faint">
          — who succeeds the sole member on death/incapacity; not the same fact as
          &ldquo;Nominee Director&rdquo; above
        </span>
      </label>
    </div>
  );
}

export function DirectorManager({
  companyId,
  directors,
  entityType,
  contributions = [],
}: {
  companyId: string;
  directors: Director[];
  entityType: string | null;
  // LLP-only (see 0097) — the caller (directors/page.tsx) only fetches and
  // passes this when entityType === "llp"; every other entity type gets the
  // default empty array, so isLLP below is the only thing that actually
  // gates any of this on screen.
  contributions?: Contribution[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [openContribId, setOpenContribId] = useState<string | null>(null);
  const [contribBusy, setContribBusy] = useState(false);
  const [contribForm, setContribForm] = useState<ContribFormState>(EMPTY_CONTRIB_FORM);

  const isLLP = entityType === "llp";

  const current = directors.filter((d) => !d.date_of_cessation);
  const past = directors.filter((d) => d.date_of_cessation);

  function toggleContrib(id: string) {
    if (openContribId === id) {
      setOpenContribId(null);
    } else {
      setOpenContribId(id);
      setContribForm(EMPTY_CONTRIB_FORM);
    }
  }

  async function addContribution(directorId: string) {
    if (!contribForm.amount || !contribForm.contributionDate) {
      toast.error("Amount and date are required.");
      return;
    }
    setContribBusy(true);
    const { error } = await createClient().from("llp_partner_contributions").insert({
      company_id: companyId,
      director_id: directorId,
      contribution_type: contribForm.contributionType,
      amount: Number(contribForm.amount),
      contribution_date: contribForm.contributionDate,
      valuation_certificate_reference:
        contribForm.contributionType === "kind"
          ? contribForm.valuationCertificateReference.trim() || null
          : null,
      notes: contribForm.notes.trim() || null,
    });
    setContribBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Contribution recorded");
    setContribForm(EMPTY_CONTRIB_FORM);
    router.refresh();
  }

  async function addDirector(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await createClient().from("company_directors").insert({
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

  function startEdit(d: Director) {
    setEditingId(d.id);
    setEditForm(toRow(d));
  }

  async function saveEdit(id: string) {
    setBusy(true);
    const { error } = await createClient()
      .from("company_directors")
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

  function renderRow(d: Director) {
    const isEditing = editingId === d.id;
    return (
      <Fragment key={d.id}>
        <tr className="border-b border-border last:border-0">
          <td className={td}>{d.name}</td>
          <td className={td}>
            {DESIGNATION_LABEL[d.designation] ?? d.designation}
            {d.is_opc_nominee && d.designation !== "opc_nominee" && (
              <Badge tone="accent" className="ml-1.5">
                +Nominee
              </Badge>
            )}
          </td>
          <td className={td + " font-mono text-xs text-ink-soft"}>
            {d.din ?? <span className="text-ink-faint">—</span>}
          </td>
          <td className={td + " font-mono text-xs text-ink-soft"}>
            {d.pan ?? <span className="text-ink-faint">—</span>}
          </td>
          <td className={td + " whitespace-nowrap"}>{d.date_of_appointment}</td>
          <td className={td}>
            {d.date_of_cessation ? (
              <Badge tone="neutral">Ceased {d.date_of_cessation}</Badge>
            ) : (
              <Badge tone="ok">Serving</Badge>
            )}
          </td>
          <td className={td}>
            <button
              type="button"
              onClick={() => (isEditing ? setEditingId(null) : startEdit(d))}
              className="text-xs text-accent underline underline-offset-2"
            >
              {isEditing ? "Cancel" : "Edit"}
            </button>
            {isLLP && (
              <button
                type="button"
                onClick={() => toggleContrib(d.id)}
                className="ml-3 text-xs text-accent underline underline-offset-2"
              >
                {openContribId === d.id ? "Hide contributions" : "Contributions"}
              </button>
            )}
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
        {isLLP && openContribId === d.id && renderContribPanel(d)}
      </Fragment>
    );
  }

  // LLP-only sub-panel (see 0097): this partner's contribution register —
  // running cash/kind/total, the existing rows, and (for a still-serving
  // partner) a form to add another. Renders only from renderRow above, and
  // only when isLLP — never touched for any other entity type.
  function renderContribPanel(d: Director) {
    const rows = contributions
      .filter((c) => c.director_id === d.id)
      .slice()
      .sort((a, b) => a.contribution_date.localeCompare(b.contribution_date));
    const totalCash = rows
      .filter((c) => c.contribution_type === "cash")
      .reduce((sum, c) => sum + Number(c.amount), 0);
    const totalKind = rows
      .filter((c) => c.contribution_type === "kind")
      .reduce((sum, c) => sum + Number(c.amount), 0);
    const total = totalCash + totalKind;

    return (
      <tr className="border-b border-border bg-bg">
        <td colSpan={7} className="px-4 py-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
              <span className="font-semibold text-ink">
                Total contribution to date: {formatINR(total, { showZero: true })}
              </span>
              <span className="text-ink-soft">
                Cash {formatINR(totalCash, { showZero: true })} · In kind{" "}
                {formatINR(totalKind, { showZero: true })}
              </span>
            </div>

            {rows.length > 0 ? (
              <TableContainer>
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className={th}>Date</th>
                      <th className={th}>Type</th>
                      <th className={num}>Amount</th>
                      <th className={th}>Valuation ref. / notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id} className="border-b border-border last:border-0">
                        <td className={td + " whitespace-nowrap"}>{c.contribution_date}</td>
                        <td className={td}>{CONTRIBUTION_TYPE_LABEL[c.contribution_type]}</td>
                        <td className={num}>{formatINR(Number(c.amount), { showZero: true })}</td>
                        <td className={td + " text-xs text-ink-soft"}>
                          {c.valuation_certificate_reference ?? c.notes ?? (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableContainer>
            ) : (
              <p className="text-xs text-ink-faint">No contribution recorded yet.</p>
            )}

            {!d.date_of_cessation && (
              <div className="rounded-[14px] border border-border bg-surface p-3">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium text-ink-soft">Type</span>
                    <select
                      value={contribForm.contributionType}
                      onChange={(e) =>
                        setContribForm({
                          ...contribForm,
                          contributionType: e.target.value as ContribFormState["contributionType"],
                          valuationCertificateReference:
                            e.target.value === "cash" ? "" : contribForm.valuationCertificateReference,
                        })
                      }
                      className={field}
                    >
                      <option value="cash">Cash</option>
                      <option value="kind">In kind</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium text-ink-soft">Amount</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={contribForm.amount}
                      onChange={(e) => setContribForm({ ...contribForm, amount: e.target.value })}
                      className={field}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    <span className="font-medium text-ink-soft">Date</span>
                    <input
                      type="date"
                      value={contribForm.contributionDate}
                      onChange={(e) =>
                        setContribForm({ ...contribForm, contributionDate: e.target.value })
                      }
                      className={field}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs sm:col-span-2">
                    <span className="font-medium text-ink-soft">
                      {contribForm.contributionType === "kind" ? (
                        <>
                          Valuation certificate ref.{" "}
                          <span className="font-normal text-ink-faint">
                            optional — practising CA / practising Cost Accountant / Central
                            Govt. approved valuer (Rule 23(2))
                          </span>
                        </>
                      ) : (
                        <>
                          Notes <span className="font-normal text-ink-faint">optional</span>
                        </>
                      )}
                    </span>
                    <input
                      value={
                        contribForm.contributionType === "kind"
                          ? contribForm.valuationCertificateReference
                          : contribForm.notes
                      }
                      onChange={(e) =>
                        setContribForm(
                          contribForm.contributionType === "kind"
                            ? { ...contribForm, valuationCertificateReference: e.target.value }
                            : { ...contribForm, notes: e.target.value }
                        )
                      }
                      className={field}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  disabled={contribBusy}
                  onClick={() => addContribution(d.id)}
                  className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                >
                  {contribBusy ? "Saving…" : "Add contribution"}
                </button>
              </div>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <div className="mt-6 flex flex-col gap-8">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : "Add director / KMP"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={addDirector}
          className="rounded-[14px] border border-border bg-surface p-4"
        >
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
          Currently serving ({current.length})
        </h2>
        <TableContainer>
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Name</th>
                <th className={th}>Designation</th>
                <th className={th}>DIN</th>
                <th className={th}>PAN</th>
                <th className={th}>Appointed</th>
                <th className={th}>Status</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {current.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
                    No one currently serving is on record yet.
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
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className={th}>Name</th>
                  <th className={th}>Designation</th>
                  <th className={th}>DIN</th>
                  <th className={th}>PAN</th>
                  <th className={th}>Appointed</th>
                  <th className={th}>Status</th>
                  <th className={th}></th>
                </tr>
              </thead>
              <tbody>{past.map(renderRow)}</tbody>
            </table>
          </TableContainer>
        </section>
      )}

      {entityType && entityType !== "pvt_ltd" && entityType !== "ltd" && entityType !== "opc" && entityType !== "llp" && (
        <p className="text-xs text-ink-faint">
          This entity type isn&rsquo;t ROC-applicable in this app&rsquo;s own reference
          data, so it wouldn&rsquo;t ordinarily have MCA-filed directors or designated
          partners — records can still be kept here if useful, but nothing else in
          the app currently reads them for this company.
        </p>
      )}
    </div>
  );
}
