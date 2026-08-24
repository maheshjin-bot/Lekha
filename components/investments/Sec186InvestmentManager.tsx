"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td } from "@/components/ui/Table";
import { formatINR } from "@/lib/utils/currency";

type Investment = {
  id: string;
  transaction_type: string;
  recipient_entity_name: string;
  amount: number;
  date: string;
  board_resolution_date: string;
  shareholder_resolution_date: string | null;
  purpose: string;
};

type CeilingCheck = {
  paid_up_capital: number;
  reserves_and_securities_premium_approx: number;
  ceiling_60pct_capital_plus_reserves: number;
  ceiling_100pct_reserves: number;
  board_only_limit: number;
  total_recorded_loans_investments: number;
  headroom_before_shareholder_approval: number;
  is_approximate: boolean;
  caveat: string;
};

// Mirrors the sec186_investments_transaction_type_check constraint (0116).
const TYPE_LABEL: Record<string, string> = {
  loan: "Loan",
  guarantee: "Guarantee",
  security: "Security",
  investment: "Investment",
};
const TYPE_OPTIONS = Object.keys(TYPE_LABEL);

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

type FormState = {
  transactionType: string;
  recipientEntityName: string;
  amount: string;
  date: string;
  boardResolutionDate: string;
  shareholderResolutionDate: string;
  purpose: string;
};

const EMPTY_FORM: FormState = {
  transactionType: "loan",
  recipientEntityName: "",
  amount: "",
  date: "",
  boardResolutionDate: "",
  shareholderResolutionDate: "",
  purpose: "",
};

function toRow(i: Investment): FormState {
  return {
    transactionType: i.transaction_type,
    recipientEntityName: i.recipient_entity_name,
    amount: String(i.amount),
    date: i.date,
    boardResolutionDate: i.board_resolution_date,
    shareholderResolutionDate: i.shareholder_resolution_date ?? "",
    purpose: i.purpose,
  };
}

function toPayload(f: FormState) {
  return {
    transaction_type: f.transactionType,
    recipient_entity_name: f.recipientEntityName.trim(),
    amount: Number(f.amount),
    date: f.date,
    board_resolution_date: f.boardResolutionDate,
    shareholder_resolution_date: f.shareholderResolutionDate || null,
    purpose: f.purpose.trim(),
  };
}

function FormFields({ value, onChange }: { value: FormState; onChange: (next: FormState) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Transaction type</span>
        <select
          value={value.transactionType}
          onChange={(e) => onChange({ ...value, transactionType: e.target.value })}
          className={field}
        >
          {TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Amount (Rs.)</span>
        <input
          required
          type="number"
          min="0"
          step="any"
          value={value.amount}
          onChange={(e) => onChange({ ...value, amount: e.target.value })}
          className={field + " font-mono"}
        />
      </label>

      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">Recipient entity</span>
        <input
          required
          value={value.recipientEntityName}
          onChange={(e) => onChange({ ...value, recipientEntityName: e.target.value })}
          placeholder="Body corporate or person receiving the loan/guarantee/security/investment"
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Transaction date</span>
        <input
          required
          type="date"
          value={value.date}
          onChange={(e) => onChange({ ...value, date: e.target.value })}
          className={field}
        />
      </label>

      <div />

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Board resolution date{" "}
          <span className="font-normal text-ink-faint">
            Sec 186(2) — required for every transaction, on or before the date above
          </span>
        </span>
        <input
          required
          type="date"
          value={value.boardResolutionDate}
          onChange={(e) => onChange({ ...value, boardResolutionDate: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Shareholder special resolution date{" "}
          <span className="font-normal text-ink-faint">
            optional — only if the aggregate crossed the Sec 186(2) ceiling
          </span>
        </span>
        <input
          type="date"
          value={value.shareholderResolutionDate}
          onChange={(e) => onChange({ ...value, shareholderResolutionDate: e.target.value })}
          className={field}
        />
      </label>

      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-sm font-medium">Purpose</span>
        <input
          required
          value={value.purpose}
          onChange={(e) => onChange({ ...value, purpose: e.target.value })}
          className={field}
        />
      </label>
    </div>
  );
}

function CeilingCheckCard({ c }: { c: CeilingCheck | undefined }) {
  if (!c) return null;
  const overLimit = c.headroom_before_shareholder_approval < 0;
  return (
    <div className="rounded-[14px] border border-border bg-surface p-4">
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Paid-up capital</div>
          <div className="font-mono tabular-nums">{formatINR(c.paid_up_capital, { showZero: true })}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">
            Reserves + sec. premium (approx.)
          </div>
          <div className="font-mono tabular-nums">
            {formatINR(c.reserves_and_securities_premium_approx, { showZero: true })}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Board-only limit</div>
          <div className="font-mono tabular-nums font-semibold text-ink">
            {formatINR(c.board_only_limit, { showZero: true })}
          </div>
          <div className="text-xs text-ink-faint">higher of 60% (capital+reserves) or 100% reserves</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Recorded total</div>
          <div className="font-mono tabular-nums">
            {formatINR(c.total_recorded_loans_investments, { showZero: true })}
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Badge tone={overLimit ? "warn" : "ok"}>
          {overLimit
            ? `${formatINR(Math.abs(c.headroom_before_shareholder_approval), { showZero: true })} over the board-only limit`
            : `${formatINR(c.headroom_before_shareholder_approval, { showZero: true })} headroom left`}
        </Badge>
        {overLimit && (
          <span className="text-xs text-ink-faint">
            new transactions likely need a shareholder special resolution too
          </span>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-faint">{c.caveat}</p>
    </div>
  );
}

export function Sec186InvestmentManager({
  companyId,
  entityType,
  investments,
  ceilingCheck,
}: {
  companyId: string;
  entityType: string | null;
  investments: Investment[];
  ceilingCheck: CeilingCheck[];
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
        Sec 186 (Form MBP-2) doesn&rsquo;t apply here. It is a Companies Act provision — this app
        treats pvt_ltd, ltd and opc as &ldquo;a company&rdquo; for this purpose, the same three
        entity types the Register of Charges and Register of Members already use. An LLP,
        partnership, proprietorship, HUF, AOP/BOI, trust or society has no equivalent obligation.
        The database enforces this too: it will refuse a row for any other entity type, not just
        hide the form here.
      </div>
    );
  }

  async function addInvestment(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await createClient()
      .from("sec186_investments")
      .insert({ company_id: companyId, ...toPayload(form) });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Recorded");
    setForm(EMPTY_FORM);
    setShowForm(false);
    router.refresh();
  }

  function startEdit(i: Investment) {
    setEditingId(i.id);
    setEditForm(toRow(i));
  }

  async function saveEdit(id: string) {
    setBusy(true);
    const { error } = await createClient()
      .from("sec186_investments")
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

  function renderRow(i: Investment) {
    const isEditing = editingId === i.id;
    return (
      <Fragment key={i.id}>
        <tr className="border-b border-border last:border-0">
          <td className={td}>{TYPE_LABEL[i.transaction_type] ?? i.transaction_type}</td>
          <td className={td}>{i.recipient_entity_name}</td>
          <td className={td + " text-right font-mono tabular-nums"}>
            {formatINR(i.amount, { showZero: true })}
          </td>
          <td className={td + " whitespace-nowrap"}>{i.date}</td>
          <td className={td + " whitespace-nowrap"}>{i.board_resolution_date}</td>
          <td className={td}>
            {i.shareholder_resolution_date ? (
              <Badge tone="accent">{i.shareholder_resolution_date}</Badge>
            ) : (
              <span className="text-ink-faint">—</span>
            )}
          </td>
          <td className={td}>
            <button
              type="button"
              onClick={() => (isEditing ? setEditingId(null) : startEdit(i))}
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
                  onClick={() => saveEdit(i.id)}
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
      <CeilingCheckCard c={ceilingCheck[0]} />

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : "Record a loan / guarantee / security / investment"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={addInvestment} className="rounded-[14px] border border-border bg-surface p-4">
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

      <TableContainer>
        <table className="w-full min-w-[920px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Type</th>
              <th className={th}>Recipient</th>
              <th className={th + " text-right"}>Amount</th>
              <th className={th}>Date</th>
              <th className={th}>Board resolution</th>
              <th className={th}>Shareholder resolution</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {investments.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
                  No loans, guarantees, securities or investments recorded yet.
                </td>
              </tr>
            )}
            {investments.map(renderRow)}
          </tbody>
        </table>
      </TableContainer>
    </div>
  );
}
