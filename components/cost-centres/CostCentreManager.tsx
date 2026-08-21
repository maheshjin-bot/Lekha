"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td, num, trSelected } from "@/components/ui/Table";

type CostCentre = {
  id: string;
  code: string;
  name: string;
  kind: string;
  is_active: boolean;
};

type Entry = {
  entry_id: string;
  voucher_date: string;
  voucher_number: string;
  ledger_name: string;
  narration: string | null;
  amount: number;
  is_expense: boolean;
  cost_centre_id: string | null;
  cost_centre_name: string | null;
};

export function CostCentreManager({
  companyId,
  centres,
  entries,
  showAll,
}: {
  companyId: string;
  centres: CostCentre[];
  entries: Entry[];
  showAll: boolean;
}) {
  const router = useRouter();

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("cost_centre");
  const [busy, setBusy] = useState(false);

  // Selection is the whole point of this screen — allocation is a bulk act,
  // so the primary control is a checkbox column, not a per-row dropdown.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState("");

  const active = centres.filter((c) => c.is_active);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === entries.length ? new Set() : new Set(entries.map((e) => e.entry_id))
    );
  }

  async function addCentre(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await createClient().from("cost_centres").insert({
      company_id: companyId,
      code: code.trim().toUpperCase(),
      name: name.trim(),
      kind,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setCode("");
    setName("");
    toast.success("Cost centre added");
    router.refresh();
  }

  async function allocate() {
    if (selected.size === 0) return;
    setBusy(true);
    // An empty target means "clear" — the RPC takes null for exactly that, so
    // there is no separate unassign path to keep in step.
    const { data, error } = await createClient().rpc("set_entry_cost_centre", {
      p_company_id: companyId,
      p_entry_ids: Array.from(selected),
      p_cost_centre_id: target || undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(
      target
        ? `${data} ${data === 1 ? "line" : "lines"} allocated`
        : `${data} ${data === 1 ? "line" : "lines"} cleared`
    );
    setSelected(new Set());
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="flex flex-col gap-8">
      {/* ---------------- Master ---------------- */}
      <section>
        <h2 className="font-display text-lg font-semibold tracking-tight">Cost centres & projects</h2>
        <p className="mt-1 text-sm text-ink-soft">
          A cost centre is ongoing (a division, a branch, a department); a project is
          finite. They behave identically in every report — the distinction is what you
          call it.
        </p>

        <TableContainer className="mt-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Code</th>
                <th className={th}>Name</th>
                <th className={th}>Kind</th>
              </tr>
            </thead>
            <tbody>
              {centres.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-ink-faint">
                    None yet. Add one below, then allocate lines to it.
                  </td>
                </tr>
              )}
              {centres.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className={td + " font-mono text-xs"}>{c.code}</td>
                  <td className={td}>{c.name}</td>
                  <td className={td}>
                    <Badge tone={c.kind === "project" ? "accent" : "neutral"}>
                      {c.kind === "project" ? "Project" : "Cost centre"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>

        <form onSubmit={addCentre} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Code</span>
            <input
              required
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="RETAIL"
              maxLength={12}
              className={field + " w-32 font-mono"}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Retail Division"
              className={field + " w-64"}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={field}>
              <option value="cost_centre">Cost centre</option>
              <option value="project">Project</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Add
          </button>
        </form>
      </section>

      {/* ---------------- Allocation ---------------- */}
      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight">Allocate</h2>
            <p className="mt-1 text-sm text-ink-soft">
              Tick the lines, pick a cost centre, apply. Only profit &amp; loss lines
              appear — a cost centre on a bank balance or a creditor would not sum into
              anything meaningful.
            </p>
          </div>
          <a
            href={`?${showAll ? "" : "all=1"}`}
            className="rounded-md border border-border-strong px-2.5 py-1 text-sm hover:bg-surface-2"
          >
            {showAll ? "Show unallocated only" : "Show all lines"}
          </a>
        </div>

        {active.length === 0 ? (
          <p className="mt-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
            Add a cost centre above before allocating.
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-[14px] border border-border bg-surface p-3">
            <span className="text-sm font-medium">
              {selected.size} selected
            </span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className={field}
              aria-label="Cost centre to apply"
            >
              <option value="">— Clear allocation —</option>
              {active.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={allocate}
              disabled={busy || selected.size === 0}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              Apply
            </button>
          </div>
        )}

        <TableContainer className="mt-4">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th + " w-10"}>
                  <input
                    type="checkbox"
                    checked={entries.length > 0 && selected.size === entries.length}
                    onChange={toggleAll}
                    aria-label="Select all lines"
                    className="h-4 w-4 rounded border-border-strong accent-accent"
                  />
                </th>
                <th className={th}>Date</th>
                <th className={th}>Voucher</th>
                <th className={th}>Ledger</th>
                <th className={th}>Narration</th>
                <th className={th}>Allocated to</th>
                <th className={th + " text-right"}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
                    {showAll
                      ? "No profit & loss lines in this period."
                      : "Everything in this period is allocated."}
                  </td>
                </tr>
              )}
              {entries.map((e) => (
                <tr
                  key={e.entry_id}
                  className={
                    "border-b border-border last:border-0 " +
                    (selected.has(e.entry_id) ? trSelected : "")
                  }
                >
                  <td className={td}>
                    <input
                      type="checkbox"
                      checked={selected.has(e.entry_id)}
                      onChange={() => toggle(e.entry_id)}
                      aria-label={`Select ${e.voucher_number} ${e.ledger_name}`}
                      className="h-4 w-4 rounded border-border-strong accent-accent"
                    />
                  </td>
                  <td className={td + " whitespace-nowrap"}>{e.voucher_date}</td>
                  <td className={td + " font-mono text-xs"}>{e.voucher_number}</td>
                  <td className={td}>{e.ledger_name}</td>
                  <td className={td + " text-ink-soft"}>{e.narration ?? "—"}</td>
                  <td className={td}>
                    {e.cost_centre_name ? (
                      <Badge tone="accent">{e.cost_centre_name}</Badge>
                    ) : (
                      <span className="text-xs text-ink-faint">—</span>
                    )}
                  </td>
                  <td className={num}>
                    <span className={e.is_expense ? "text-error" : "text-success"}>
                      {e.is_expense ? "−" : "+"}
                      {formatINR(Math.abs(Number(e.amount)), { showZero: true })}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      </section>
    </div>
  );
}
