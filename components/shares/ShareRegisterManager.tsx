"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td } from "@/components/ui/Table";
import { formatINR } from "@/lib/utils/currency";

type ShareClass = {
  id: string;
  class_name: string;
  nominal_value_per_share: number;
  authorized_shares: number;
};

type Summary = {
  share_class_id: string;
  class_name: string;
  nominal_value_per_share: number;
  authorized_shares: number;
  authorized_capital: number;
  issued_shares: number;
  unissued_shares: number;
  paid_up_capital: number;
  current_holder_count: number;
};

type Holding = {
  id: string;
  share_class_id: string;
  holder_name: string;
  holder_pan: string | null;
  holder_address: string | null;
  holder_occupation: string | null;
  consideration: string | null;
  shares_held: number;
  date_of_allotment: string;
  date_of_cessation: string | null;
  folio_number: string | null;
};

// Mirrors app_private.is_valid_pan exactly (see components/directors/DirectorManager.tsx).
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const CONSIDERATION_LABEL: Record<string, string> = {
  cash: "Cash",
  other_than_cash: "Other than cash",
  bonus: "Bonus (capitalised from reserves)",
};

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

type ClassFormState = {
  className: string;
  nominalValue: string;
  authorizedShares: string;
};

const EMPTY_CLASS_FORM: ClassFormState = { className: "", nominalValue: "", authorizedShares: "" };

type HoldingFormState = {
  holderName: string;
  holderPan: string;
  holderAddress: string;
  holderOccupation: string;
  consideration: string;
  sharesHeld: string;
  dateOfAllotment: string;
  dateOfCessation: string;
  folioNumber: string;
};

const EMPTY_HOLDING_FORM: HoldingFormState = {
  holderName: "",
  holderPan: "",
  holderAddress: "",
  holderOccupation: "",
  consideration: "cash",
  sharesHeld: "",
  dateOfAllotment: "",
  dateOfCessation: "",
  folioNumber: "",
};

function toHoldingRow(h: Holding): HoldingFormState {
  return {
    holderName: h.holder_name,
    holderPan: h.holder_pan ?? "",
    holderAddress: h.holder_address ?? "",
    holderOccupation: h.holder_occupation ?? "",
    consideration: h.consideration ?? "cash",
    sharesHeld: String(h.shares_held),
    dateOfAllotment: h.date_of_allotment,
    dateOfCessation: h.date_of_cessation ?? "",
    folioNumber: h.folio_number ?? "",
  };
}

function toHoldingPayload(f: HoldingFormState) {
  return {
    holder_name: f.holderName.trim(),
    holder_pan: f.holderPan.trim() || null,
    holder_address: f.holderAddress.trim() || null,
    holder_occupation: f.holderOccupation.trim() || null,
    consideration: f.consideration || null,
    shares_held: Number(f.sharesHeld),
    date_of_allotment: f.dateOfAllotment,
    date_of_cessation: f.dateOfCessation || null,
    folio_number: f.folioNumber.trim() || null,
  };
}

function HoldingFormFields({
  value,
  onChange,
}: {
  value: HoldingFormState;
  onChange: (next: HoldingFormState) => void;
}) {
  const panOk = value.holderPan.length === 0 || PAN_PATTERN.test(value.holderPan);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">Holder name</span>
        <input
          required
          value={value.holderName}
          onChange={(e) => onChange({ ...value, holderName: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          PAN <span className="font-normal text-ink-faint">optional</span>
        </span>
        <input
          value={value.holderPan}
          onChange={(e) => onChange({ ...value, holderPan: e.target.value.toUpperCase() })}
          maxLength={10}
          placeholder="AAAAA0000A"
          className={field + " font-mono uppercase"}
        />
        {value.holderPan.length > 0 && !panOk && (
          <span className="text-xs text-warning">
            That doesn&rsquo;t match the PAN format (5 letters, 4 digits, 1 letter).
          </span>
        )}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Occupation <span className="font-normal text-ink-faint">optional</span>
        </span>
        <input
          value={value.holderOccupation}
          onChange={(e) => onChange({ ...value, holderOccupation: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">
          Address <span className="font-normal text-ink-faint">optional</span>
        </span>
        <input
          value={value.holderAddress}
          onChange={(e) => onChange({ ...value, holderAddress: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Shares held</span>
        <input
          required
          type="number"
          min="0"
          step="any"
          value={value.sharesHeld}
          onChange={(e) => onChange({ ...value, sharesHeld: e.target.value })}
          className={field + " font-mono"}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Folio number</span>
        <input
          value={value.folioNumber}
          onChange={(e) => onChange({ ...value, folioNumber: e.target.value })}
          className={field + " font-mono"}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Consideration</span>
        <select
          value={value.consideration}
          onChange={(e) => onChange({ ...value, consideration: e.target.value })}
          className={field}
        >
          {Object.entries(CONSIDERATION_LABEL).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Date of allotment</span>
        <input
          required
          type="date"
          value={value.dateOfAllotment}
          onChange={(e) => onChange({ ...value, dateOfAllotment: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">
          Date of cessation{" "}
          <span className="font-normal text-ink-faint">
            leave blank while still a member — record this instead of deleting the row when they
            transfer out, so the register still shows who held these shares and when (Sec 88)
          </span>
        </span>
        <input
          type="date"
          value={value.dateOfCessation}
          onChange={(e) => onChange({ ...value, dateOfCessation: e.target.value })}
          className={field}
        />
      </label>
    </div>
  );
}

function ClassCard({
  companyId,
  shareClass,
  summary,
  holdings,
  busy,
  setBusy,
}: {
  companyId: string;
  shareClass: ShareClass;
  summary: Summary | undefined;
  holdings: Holding[];
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const router = useRouter();
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState<HoldingFormState>(EMPTY_HOLDING_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<HoldingFormState>(EMPTY_HOLDING_FORM);

  const current = holdings.filter((h) => !h.date_of_cessation);
  const past = holdings.filter((h) => h.date_of_cessation);
  const issuedShares = summary?.issued_shares ?? 0;

  async function addHolding(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await createClient()
      .from("share_holdings")
      .insert({
        company_id: companyId,
        share_class_id: shareClass.id,
        ...toHoldingPayload(form),
      });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Holding recorded");
    setForm(EMPTY_HOLDING_FORM);
    setShowAddForm(false);
    router.refresh();
  }

  function startEdit(h: Holding) {
    setEditingId(h.id);
    setEditForm(toHoldingRow(h));
  }

  async function saveEdit(id: string) {
    setBusy(true);
    const { error } = await createClient()
      .from("share_holdings")
      .update(toHoldingPayload(editForm))
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

  function renderRow(h: Holding) {
    const isEditing = editingId === h.id;
    const pct = issuedShares > 0 && !h.date_of_cessation ? (h.shares_held / issuedShares) * 100 : null;
    return (
      <Fragment key={h.id}>
        <tr className="border-b border-border last:border-0">
          <td className={td}>{h.holder_name}</td>
          <td className={td + " font-mono text-xs text-ink-soft"}>
            {h.folio_number ?? <span className="text-ink-faint">—</span>}
          </td>
          <td className={td + " font-mono text-xs text-ink-soft"}>
            {h.holder_pan ?? <span className="text-ink-faint">—</span>}
          </td>
          <td className={td + " text-right font-mono tabular-nums"}>
            {formatINR(h.shares_held, { showZero: true })}
          </td>
          <td className={td + " text-right font-mono tabular-nums text-ink-soft"}>
            {pct !== null ? `${pct.toFixed(2)}%` : "—"}
          </td>
          <td className={td + " whitespace-nowrap"}>{h.date_of_allotment}</td>
          <td className={td}>
            {h.date_of_cessation ? (
              <Badge tone="neutral">Ceased {h.date_of_cessation}</Badge>
            ) : (
              <Badge tone="ok">Current</Badge>
            )}
          </td>
          <td className={td}>
            <button
              type="button"
              onClick={() => (isEditing ? setEditingId(null) : startEdit(h))}
              className="text-xs text-accent underline underline-offset-2"
            >
              {isEditing ? "Cancel" : "Edit"}
            </button>
          </td>
        </tr>
        {isEditing && (
          <tr className="border-b border-border bg-bg">
            <td colSpan={8} className="px-4 py-4">
              <HoldingFormFields value={editForm} onChange={setEditForm} />
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => saveEdit(h.id)}
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
    <section className="rounded-[14px] border border-border bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">{shareClass.class_name}</h2>
          <p className="mt-0.5 text-xs text-ink-soft">
            Face value {formatINR(shareClass.nominal_value_per_share, { showZero: true })} per share
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddForm((s) => !s)}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showAddForm ? "Cancel" : "Add holder"}
        </button>
      </div>

      {summary && (
        <div className="mb-4 grid grid-cols-2 gap-3 rounded-lg bg-surface-2 p-3 text-sm sm:grid-cols-4">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint">Authorized</div>
            <div className="font-mono tabular-nums">
              {formatINR(summary.authorized_capital, { showZero: true })}
            </div>
            <div className="text-xs text-ink-faint">{formatINR(summary.authorized_shares, { showZero: true })} shares</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint">Issued (current)</div>
            <div className="font-mono tabular-nums">{formatINR(summary.issued_shares, { showZero: true })} shares</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint">Paid-up capital</div>
            <div className="font-mono tabular-nums font-semibold text-ink">
              {formatINR(summary.paid_up_capital, { showZero: true })}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint">Headroom left</div>
            <div className="font-mono tabular-nums">{formatINR(summary.unissued_shares, { showZero: true })} shares</div>
          </div>
        </div>
      )}

      {showAddForm && (
        <form
          onSubmit={addHolding}
          className="mb-4 rounded-[12px] border border-border bg-bg p-4"
        >
          <HoldingFormFields value={form} onChange={setForm} />
          <button
            type="submit"
            disabled={busy}
            className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save holding"}
          </button>
        </form>
      )}

      <TableContainer>
        <table className="w-full min-w-[880px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Holder</th>
              <th className={th}>Folio</th>
              <th className={th}>PAN</th>
              <th className={th + " text-right"}>Shares</th>
              <th className={th + " text-right"}>% of issued</th>
              <th className={th}>Allotted</th>
              <th className={th}>Status</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {current.length === 0 && past.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-ink-faint">
                  No holders recorded for this class yet.
                </td>
              </tr>
            )}
            {current.map(renderRow)}
            {past.map(renderRow)}
          </tbody>
        </table>
      </TableContainer>
    </section>
  );
}

export function ShareRegisterManager({
  companyId,
  entityType,
  shareClasses,
  holdings,
  summary,
}: {
  companyId: string;
  entityType: string | null;
  shareClasses: ShareClass[];
  holdings: Holding[];
  summary: Summary[];
}) {
  const router = useRouter();
  const [showClassForm, setShowClassForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [classForm, setClassForm] = useState<ClassFormState>(EMPTY_CLASS_FORM);

  const eligible = entityType === "pvt_ltd" || entityType === "ltd" || entityType === "opc";

  async function addClass(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await createClient()
      .from("share_classes")
      .insert({
        company_id: companyId,
        class_name: classForm.className.trim(),
        nominal_value_per_share: Number(classForm.nominalValue),
        authorized_shares: Number(classForm.authorizedShares),
      });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Share class added");
    setClassForm(EMPTY_CLASS_FORM);
    setShowClassForm(false);
    router.refresh();
  }

  if (!eligible) {
    return (
      <div className="rounded-[14px] border border-border bg-surface-2 p-5 text-sm text-ink-soft">
        Share capital doesn&rsquo;t apply here. A Sec 88 Register of Members exists only for a
        company limited by shares — this app treats pvt_ltd, ltd and opc as that (the three
        entity types its own reference data marks as filing MGT-7/MGT-7A). An LLP has partner
        contribution instead of shares, and a proprietorship, partnership, HUF, AOP/BOI, trust or
        society has no share capital at all. The database enforces this too: it will refuse a
        share class for any other entity type, not just hide the button here.
      </div>
    );
  }

  const totalAuthorized = summary.reduce((s, r) => s + r.authorized_capital, 0);
  const totalPaidUp = summary.reduce((s, r) => s + r.paid_up_capital, 0);

  return (
    <div className="flex flex-col gap-6">
      {shareClasses.length > 0 && (
        <div className="flex flex-wrap gap-6 rounded-[14px] border border-border bg-surface p-4 text-sm">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint">
              Total authorized capital
            </div>
            <div className="font-mono text-base tabular-nums font-semibold text-ink">
              {formatINR(totalAuthorized, { showZero: true })}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-ink-faint">
              Total paid-up capital
            </div>
            <div className="font-mono text-base tabular-nums font-semibold text-ink">
              {formatINR(totalPaidUp, { showZero: true })}
            </div>
          </div>
          <div className="text-xs text-ink-faint self-end">
            Paid-up capital across classes is the figure the Sec 2(85) small-company test and the
            Sec 186 investment ceiling both need.
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowClassForm((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showClassForm ? "Cancel" : "Add share class"}
        </button>
      </div>

      {showClassForm && (
        <form
          onSubmit={addClass}
          className="grid gap-3 rounded-[14px] border border-border bg-surface p-4 sm:grid-cols-3"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Class name <span className="font-normal text-ink-faint">e.g. Equity, Preference</span>
            </span>
            <input
              required
              value={classForm.className}
              onChange={(e) => setClassForm({ ...classForm, className: e.target.value })}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Face value per share (Rs.)</span>
            <input
              required
              type="number"
              min="0"
              step="any"
              value={classForm.nominalValue}
              onChange={(e) => setClassForm({ ...classForm, nominalValue: e.target.value })}
              className={field + " font-mono"}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Authorized shares</span>
            <input
              required
              type="number"
              min="0"
              step="any"
              value={classForm.authorizedShares}
              onChange={(e) => setClassForm({ ...classForm, authorizedShares: e.target.value })}
              className={field + " font-mono"}
            />
          </label>
          <div className="sm:col-span-3">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </form>
      )}

      {shareClasses.length === 0 ? (
        <div className="rounded-[14px] border border-border bg-surface-2 p-8 text-center text-sm text-ink-faint">
          No share classes recorded yet. Add one (e.g. Equity, Rs. 10 face value) to start the
          register.
        </div>
      ) : (
        shareClasses.map((sc) => (
          <ClassCard
            key={sc.id}
            companyId={companyId}
            shareClass={sc}
            summary={summary.find((s) => s.share_class_id === sc.id)}
            holdings={holdings.filter((h) => h.share_class_id === sc.id)}
            busy={busy}
            setBusy={setBusy}
          />
        ))
      )}
    </div>
  );
}
