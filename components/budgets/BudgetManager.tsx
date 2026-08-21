"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";

type Budget = {
  id: string;
  name: string;
  fy_start: string;
  fy_end: string;
  is_active: boolean;
};

type Ledger = { id: string; name: string; nature: string };

type LineMap = Record<string, Record<string, number>>; // ledger_id -> "YYYY-MM-01" -> amount

/** The 12 first-of-month dates spanned by [fyStart, fyEnd] — the budget's own
 * grid columns. Computed from the budget's own bounds rather than assumed to
 * be Apr-Mar, since a company's financial_year_start_month can be anything. */
function monthColumns(fyStart: string, fyEnd: string): string[] {
  const cols: string[] = [];
  let [y, m] = fyStart.split("-").map(Number);
  const [endY, endM] = fyEnd.split("-").map(Number);
  // Guard against a malformed range looping forever — 12 months is the most
  // a financial year is ever long, so 24 is a generous, safe ceiling.
  let guard = 0;
  while ((y < endY || (y === endY && m <= endM)) && guard < 24) {
    cols.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    guard += 1;
  }
  return cols;
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

export function BudgetManager({
  companyId,
  budgets,
  ledgers,
  selectedBudget,
  initialLines,
}: {
  companyId: string;
  budgets: Budget[];
  ledgers: Ledger[];
  selectedBudget: Budget | null;
  initialLines: LineMap;
}) {
  const router = useRouter();
  const [lines, setLines] = useState<LineMap>(initialLines);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [newName, setNewName] = useState("");
  const [fyStart, setFyStart] = useState("");
  const [fyEnd, setFyEnd] = useState("");

  const columns = useMemo(
    () => (selectedBudget ? monthColumns(selectedBudget.fy_start, selectedBudget.fy_end) : []),
    [selectedBudget]
  );

  async function createBudget(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { data, error } = await createClient()
      .from("budgets")
      .insert({ company_id: companyId, name: newName.trim(), fy_start: fyStart, fy_end: fyEnd })
      .select("id")
      .single();
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Budget created");
    router.push(`?budget=${data.id}`);
  }

  async function activate(id: string) {
    setBusy(true);
    // Clear the current active first — the partial unique index (one active
    // per company) would otherwise reject the new one before the old one is
    // turned off. Two calls, not one atomic swap, since this goes through
    // PostgREST rather than a single RPC — a real gap for a tiny window, not
    // worth a whole function for a low-frequency admin action.
    const client = createClient();
    await client.from("budgets").update({ is_active: false }).eq("company_id", companyId).eq("is_active", true);
    const { error } = await client.from("budgets").update({ is_active: true }).eq("id", id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Active budget changed");
    router.refresh();
  }

  function setCell(ledgerId: string, month: string, value: string) {
    const n = value === "" ? 0 : Number(value);
    if (Number.isNaN(n)) return;
    setLines((prev) => ({
      ...prev,
      [ledgerId]: { ...(prev[ledgerId] ?? {}), [month]: n },
    }));
    setDirty(true);
  }

  async function save() {
    if (!selectedBudget) return;
    setBusy(true);
    const payload = Object.entries(lines).flatMap(([ledgerId, months]) =>
      Object.entries(months).map(([period_month, amount]) => ({
        ledger_id: ledgerId,
        period_month,
        amount,
      }))
    );
    const { data, error } = await createClient().rpc("set_budget_lines", {
      p_company_id: companyId,
      p_budget_id: selectedBudget.id,
      p_lines: payload,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setDirty(false);
    toast.success(`${data} lines saved`);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="flex flex-col gap-8">
      {/* ---------------- Budget list / switcher ---------------- */}
      <section>
        <h2 className="font-display text-lg font-semibold tracking-tight">Budgets</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Keep an original plan and a mid-year revision side by side — only the active one
          is what variance reports compare against by default.
        </p>

        <TableContainer className="mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Name</th>
                <th className={th}>Financial year</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {budgets.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-ink-faint">
                    No budgets yet. Create one below.
                  </td>
                </tr>
              )}
              {budgets.map((b) => (
                <tr key={b.id} className="border-b border-border last:border-0">
                  <td className={td}>
                    <a href={`?budget=${b.id}`} className="underline underline-offset-2 hover:text-accent">
                      {b.name}
                    </a>
                  </td>
                  <td className={td + " text-ink-soft"}>
                    {b.fy_start} to {b.fy_end}
                  </td>
                  <td className={td}>
                    {b.is_active ? (
                      <Badge tone="ok">Active</Badge>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => activate(b.id)}
                        className="text-xs text-ink-soft underline underline-offset-2 hover:text-accent disabled:opacity-50"
                      >
                        Make active
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>

        <form onSubmit={createBudget} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="FY 2026-27 Budget"
              className={field + " w-56"}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Starts</span>
            <input
              required
              type="date"
              value={fyStart}
              onChange={(e) => setFyStart(e.target.value)}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Ends</span>
            <input
              required
              type="date"
              value={fyEnd}
              onChange={(e) => setFyEnd(e.target.value)}
              className={field}
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Create
          </button>
        </form>
      </section>

      {/* ---------------- Grid editor ---------------- */}
      {selectedBudget && (
        <section>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold tracking-tight">
                {selectedBudget.name}
              </h2>
              <p className="mt-1 text-sm text-ink-soft">
                Only profit &amp; loss ledgers can be budgeted — a figure on a bank balance
                or a creditor would not compare against anything meaningful.
              </p>
            </div>
            <button
              type="button"
              onClick={save}
              disabled={busy || !dirty}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {dirty ? "Save changes" : "Saved"}
            </button>
          </div>

          <TableContainer className="mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className={th + " sticky left-0 bg-surface"}>Ledger</th>
                  {columns.map((c) => (
                    <th key={c} className={th + " text-right"}>
                      {monthLabel(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ledgers.map((l) => (
                  <tr key={l.id} className="border-b border-border last:border-0">
                    <td className={td + " sticky left-0 whitespace-nowrap bg-surface"}>
                      {l.name}
                    </td>
                    {columns.map((c) => (
                      <td key={c} className={num}>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={lines[l.id]?.[c] ?? ""}
                          onChange={(e) => setCell(l.id, c, e.target.value)}
                          placeholder="0"
                          className="w-24 rounded border border-border-strong bg-surface px-2 py-1 text-right text-sm outline-none focus-visible:border-accent"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        </section>
      )}
    </div>
  );
}
