"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td, num } from "@/components/ui/Table";

type Line = {
  ledger_id: string;
  ledger_name: string;
  debit_amount: number;
  credit_amount: number;
  narration: string | null;
  line_order: number;
};

type Template = {
  id: string;
  template_name: string;
  voucher_type: string;
  frequency: string;
  day_of_month: number;
  branch_id: string;
  branch_name: string;
  start_date: string;
  end_date: string | null;
  next_run_date: string;
  is_active: boolean;
  is_due: boolean;
  narration_template: string | null;
  party_ledger_id: string | null;
  party_ledger_name: string | null;
  line_count: number;
  template_amount: number;
  lines: Line[];
  last_run_date: string | null;
  last_run_voucher_id: string | null;
  last_run_voucher_number: string | null;
};

type Branch = { id: string; code: string; name: string };
type Ledger = { id: string; name: string };

type DraftLine = { ledger_id: string; side: "debit" | "credit"; amount: string; narration: string };

type GenerateResult = {
  template_id: string;
  template_name: string;
  run_date: string;
  voucher_id: string | null;
  voucher_number: string | null;
  status: string;
};

const VOUCHER_TYPE_LABEL: Record<string, string> = {
  receipt: "Receipt",
  payment: "Payment",
  contra: "Contra",
  journal: "Journal",
};

const FREQUENCY_LABEL: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

function emptyLine(): DraftLine {
  return { ledger_id: "", side: "debit", amount: "", narration: "" };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function RecurringVoucherManager({
  companyId,
  templates,
  branches,
  ledgers,
}: {
  companyId: string;
  templates: Template[];
  branches: Branch[];
  ledgers: Ledger[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [generateResults, setGenerateResults] = useState<GenerateResult[] | null>(null);

  const [templateName, setTemplateName] = useState("");
  const [voucherType, setVoucherType] = useState("journal");
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [frequency, setFrequency] = useState("monthly");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState("");
  const [partyLedgerId, setPartyLedgerId] = useState("");
  const [narrationTemplate, setNarrationTemplate] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);

  const dueCount = templates.filter((t) => t.is_due).length;

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const debitTotal = lines.reduce((n, l) => n + (l.side === "debit" ? Number(l.amount) || 0 : 0), 0);
  const creditTotal = lines.reduce((n, l) => n + (l.side === "credit" ? Number(l.amount) || 0 : 0), 0);
  const balanced = debitTotal > 0 && Math.abs(debitTotal - creditTotal) < 0.005;

  function resetForm() {
    setTemplateName("");
    setVoucherType("journal");
    setBranchId(branches[0]?.id ?? "");
    setFrequency("monthly");
    setDayOfMonth("1");
    setStartDate(todayISO());
    setEndDate("");
    setPartyLedgerId("");
    setNarrationTemplate("");
    setLines([emptyLine(), emptyLine()]);
    setEditingId(null);
  }

  function openCreate() {
    resetForm();
    setShowForm(true);
  }

  function openEdit(t: Template) {
    setTemplateName(t.template_name);
    setVoucherType(t.voucher_type);
    setBranchId(t.branch_id);
    setFrequency(t.frequency);
    setDayOfMonth(String(t.day_of_month));
    setStartDate(t.start_date);
    setEndDate(t.end_date ?? "");
    setPartyLedgerId(t.party_ledger_id ?? "");
    setNarrationTemplate(t.narration_template ?? "");
    setLines(
      t.lines.length
        ? t.lines.map((l) => ({
            ledger_id: l.ledger_id,
            side: l.debit_amount > 0 ? "debit" : "credit",
            amount: String(l.debit_amount > 0 ? l.debit_amount : l.credit_amount),
            narration: l.narration ?? "",
          }))
        : [emptyLine(), emptyLine()]
    );
    setEditingId(t.id);
    setShowForm(true);
  }

  function buildLinesPayload() {
    return lines
      .filter((l) => l.ledger_id && Number(l.amount) > 0)
      .map((l, i) => ({
        ledger_id: l.ledger_id,
        debit_amount: l.side === "debit" ? Number(l.amount) : 0,
        credit_amount: l.side === "credit" ? Number(l.amount) : 0,
        narration: l.narration.trim() || null,
        line_order: i,
      }));
  }

  async function saveTemplate(e: React.FormEvent) {
    e.preventDefault();
    const payloadLines = buildLinesPayload();
    if (payloadLines.length < 2) {
      toast.error("Add at least two ledger lines.");
      return;
    }
    if (!balanced) {
      toast.error("Debits and credits must balance before saving.");
      return;
    }

    setBusy(true);
    const supabase = createClient();

    if (editingId) {
      const { error } = await callRpc<
        {
          p_template_id: string;
          p_template_name: string;
          p_lines: typeof payloadLines;
          p_end_date: string | null;
          p_party_ledger_id: string | null;
          p_narration_template: string | null;
        },
        string
      >(supabase, "update_recurring_voucher_template", {
        p_template_id: editingId,
        p_template_name: templateName.trim(),
        p_lines: payloadLines,
        p_end_date: endDate || null,
        p_party_ledger_id: partyLedgerId || null,
        p_narration_template: narrationTemplate.trim() || null,
      });
      setBusy(false);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Template updated");
    } else {
      const { error } = await callRpc<
        {
          p_company_id: string;
          p_branch_id: string;
          p_template_name: string;
          p_voucher_type: string;
          p_frequency: string;
          p_day_of_month: number;
          p_start_date: string;
          p_lines: typeof payloadLines;
          p_end_date: string | null;
          p_party_ledger_id: string | null;
          p_narration_template: string | null;
        },
        string
      >(supabase, "create_recurring_voucher_template", {
        p_company_id: companyId,
        p_branch_id: branchId,
        p_template_name: templateName.trim(),
        p_voucher_type: voucherType,
        p_frequency: frequency,
        p_day_of_month: Number(dayOfMonth),
        p_start_date: startDate,
        p_lines: payloadLines,
        p_end_date: endDate || null,
        p_party_ledger_id: partyLedgerId || null,
        p_narration_template: narrationTemplate.trim() || null,
      });
      setBusy(false);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Recurring voucher template created");
    }

    resetForm();
    setShowForm(false);
    router.refresh();
  }

  async function toggleActive(t: Template) {
    setBusy(true);
    const { error } = await callRpc<{ p_template_id: string; p_is_active: boolean }, null>(
      createClient(),
      "set_recurring_voucher_template_active",
      { p_template_id: t.id, p_is_active: !t.is_active }
    );
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(t.is_active ? "Template paused" : "Template resumed");
    router.refresh();
  }

  async function generateDue() {
    setGenerateBusy(true);
    setGenerateResults(null);
    const { data, error } = await callRpc<
      { p_company_id: string; p_as_of: string; p_template_ids: string[] | null },
      GenerateResult[]
    >(createClient(), "generate_due_recurring_vouchers", {
      p_company_id: companyId,
      p_as_of: todayISO(),
      p_template_ids: null,
    });
    setGenerateBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const rows = data ?? [];
    setGenerateResults(rows);
    const posted = rows.filter((r) => r.status === "generated").length;
    const failed = rows.filter((r) => r.status.startsWith("failed")).length;
    if (rows.length === 0) {
      toast("Nothing due right now.");
    } else if (failed > 0) {
      toast.error(`${posted} voucher(s) posted, ${failed} failed — see details below.`);
    } else {
      toast.success(`${posted} voucher(s) posted.`);
    }
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";
  const fieldDisabled = field + " opacity-60";

  const partyLedgerOptions = useMemo(() => ledgers, [ledgers]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <button
          type="button"
          disabled={generateBusy || dueCount === 0}
          onClick={generateDue}
          className="rounded-lg border border-accent px-4 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
        >
          {generateBusy ? "Generating…" : `Generate due vouchers${dueCount > 0 ? ` (${dueCount})` : ""}`}
        </button>
        <button
          type="button"
          onClick={() => (showForm ? setShowForm(false) : openCreate())}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : "New template"}
        </button>
      </div>

      {generateResults && (
        <div className="rounded-[14px] border border-border bg-surface p-4 text-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium text-ink">Generation result</span>
            <button
              type="button"
              onClick={() => setGenerateResults(null)}
              className="text-xs text-ink-faint underline underline-offset-2"
            >
              Dismiss
            </button>
          </div>
          {generateResults.length === 0 ? (
            <p className="text-ink-soft">Nothing was due.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {generateResults.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.status === "generated" ? "ok" : r.status === "already_generated" ? "neutral" : "bad"}>
                    {r.status}
                  </Badge>
                  <span className="text-ink">{r.template_name}</span>
                  <span className="text-ink-faint">— {r.run_date}</span>
                  {r.voucher_number && <span className="font-mono text-xs text-ink-soft">{r.voucher_number}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showForm && (
        <form onSubmit={saveTemplate} className="flex flex-col gap-4 rounded-[14px] border border-border bg-surface p-4">
          {editingId && (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-ink-soft">
              The branch, voucher type, frequency, day of month and start date are fixed once a
              template is created — deactivate this one and create a new template to change any of
              those.
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5 lg:col-span-2">
              <span className="text-sm font-medium">Template name</span>
              <input
                required
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                className={field}
                placeholder="e.g. Monthly office rent"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Voucher type</span>
              <select
                value={voucherType}
                onChange={(e) => setVoucherType(e.target.value)}
                disabled={!!editingId}
                className={editingId ? fieldDisabled : field}
              >
                {Object.entries(VOUCHER_TYPE_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Branch</span>
              <select
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                disabled={!!editingId}
                className={editingId ? fieldDisabled : field}
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Frequency</span>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
                disabled={!!editingId}
                className={editingId ? fieldDisabled : field}
              >
                {Object.entries(FREQUENCY_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Day of month</span>
              <input
                required
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(e.target.value)}
                disabled={!!editingId}
                className={editingId ? fieldDisabled : field}
              />
              <span className="text-xs text-ink-faint">Clamped to the last day in a shorter month.</span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Start date</span>
              <input
                required
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                disabled={!!editingId}
                className={editingId ? fieldDisabled : field}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">End date (optional)</span>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={field} />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Party ledger (optional)</span>
              <select value={partyLedgerId} onChange={(e) => setPartyLedgerId(e.target.value)} className={field}>
                <option value="">— none —</option>
                {partyLedgerOptions.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 lg:col-span-3">
              <span className="text-sm font-medium">Narration on generated vouchers</span>
              <input
                value={narrationTemplate}
                onChange={(e) => setNarrationTemplate(e.target.value)}
                className={field}
                placeholder="Defaults to the template name + “(recurring)”"
              />
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Ledger lines</span>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[2fr_auto_1fr_1fr_auto] items-center gap-2">
                <select value={l.ledger_id} onChange={(e) => updateLine(i, { ledger_id: e.target.value })} className={field}>
                  <option value="">Select ledger…</option>
                  {ledgers.map((led) => (
                    <option key={led.id} value={led.id}>
                      {led.name}
                    </option>
                  ))}
                </select>
                <select
                  value={l.side}
                  onChange={(e) => updateLine(i, { side: e.target.value as "debit" | "credit" })}
                  className={field}
                >
                  <option value="debit">Dr</option>
                  <option value="credit">Cr</option>
                </select>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={l.amount}
                  onChange={(e) => updateLine(i, { amount: e.target.value })}
                  className={field}
                  placeholder="Amount"
                />
                <input
                  value={l.narration}
                  onChange={(e) => updateLine(i, { narration: e.target.value })}
                  className={field}
                  placeholder="Line narration (optional)"
                />
                <button
                  type="button"
                  onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
                  className="text-xs text-error underline underline-offset-2"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
              className="w-fit text-xs text-accent underline underline-offset-2"
            >
              + Add line
            </button>
            <p className="text-right text-sm">
              Dr {formatINR(debitTotal, { showZero: true })} &nbsp; Cr {formatINR(creditTotal, { showZero: true })}{" "}
              {balanced ? (
                <span className="font-semibold text-success">balanced</span>
              ) : (
                <span className="font-semibold text-error">not balanced</span>
              )}
            </p>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-fit rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {editingId ? "Save changes" : "Save template"}
          </button>
        </form>
      )}

      <TableContainer>
        <table className="w-full min-w-[1000px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Status</th>
              <th className={th}>Template</th>
              <th className={th}>Type</th>
              <th className={th}>Schedule</th>
              <th className={th}>Branch</th>
              <th className={th + " text-right"}>Amount</th>
              <th className={th}>Next run</th>
              <th className={th}>Last generated</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {templates.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-ink-faint">
                  No recurring voucher templates yet.
                </td>
              </tr>
            )}
            {templates.map((t) => (
              <tr key={t.id} className="border-b border-border last:border-0">
                <td className={td}>
                  <div className="flex flex-col gap-1">
                    <Badge tone={t.is_active ? "accent" : "neutral"}>{t.is_active ? "Active" : "Paused"}</Badge>
                    {t.is_due && t.is_active && <Badge tone="warn">Due</Badge>}
                  </div>
                </td>
                <td className={td}>{t.template_name}</td>
                <td className={td}>{VOUCHER_TYPE_LABEL[t.voucher_type] ?? t.voucher_type}</td>
                <td className={td + " text-xs text-ink-soft"}>
                  {FREQUENCY_LABEL[t.frequency] ?? t.frequency}, day {t.day_of_month}
                </td>
                <td className={td}>{t.branch_name}</td>
                <td className={num}>{formatINR(Number(t.template_amount), { showZero: true })}</td>
                <td className={td + " whitespace-nowrap"}>{t.next_run_date}</td>
                <td className={td + " text-xs text-ink-soft"}>
                  {t.last_run_voucher_number ? (
                    <span className="font-mono">{t.last_run_voucher_number}</span>
                  ) : (
                    "— never —"
                  )}
                </td>
                <td className={td}>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => openEdit(t)}
                      className="text-xs text-accent underline underline-offset-2"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => toggleActive(t)}
                      className="text-xs text-ink-soft underline underline-offset-2 disabled:opacity-50"
                    >
                      {t.is_active ? "Pause" : "Resume"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableContainer>
    </div>
  );
}
