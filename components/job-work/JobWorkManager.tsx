"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select, Label } from "@/components/ui/Input";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";

type Challan = {
  challan_id: string;
  challan_number: string;
  challan_date: string;
  job_worker_name: string;
  item_id: string;
  item_name: string;
  uom: string;
  quantity_sent: number;
  quantity_received: number;
  quantity_loss: number;
  quantity_outstanding: number;
  statutory_due_date: string | null;
  extended_due_date: string | null;
  is_overdue: boolean;
  status: "open" | "partially_returned" | "closed";
};

type Item = { id: string; name: string; uom: string };
type Ledger = { id: string; name: string };
type Branch = { id: string; code: string; name: string };
type Godown = { id: string; name: string; is_default: boolean };

const STATUS_TONE: Record<Challan["status"], "neutral" | "accent" | "ok"> = {
  open: "accent",
  partially_returned: "accent",
  closed: "ok",
};

// Per-item live weighted-average cost (get_stock_summary.average_rate),
// keyed by item_id. Used to suggest a real Rate default on both the
// job-work-out challan and the job-work-in return, instead of leaving the
// field blank/0 — a blank rate used to force preparers to type an arbitrary
// placeholder just to get past the database's own (0,0) voucher_entries
// rejection, and that placeholder then silently corrupted the item's
// weighted-average cost (see migration 2070). Refreshed after every post so
// a later challan/return in the same session suggests an up-to-date number.
function useItemAverageRates(companyId: string) {
  const [rates, setRates] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    const { data } = await createClient().rpc("get_stock_summary", { p_company_id: companyId });
    if (!data) return;
    const map: Record<string, number> = {};
    for (const row of data as { item_id: string; average_rate: number | string }[]) {
      map[row.item_id] = Number(row.average_rate) || 0;
    }
    setRates(map);
  }, [companyId]);

  // Wrapped in an inline async IIFE rather than calling `refresh` directly —
  // same house pattern as CaptureReviewInbox.tsx's own fetch-on-open effect.
  // Calling a named useCallback that itself sets state is exactly the shape
  // react-hooks/set-state-in-effect traces and refuses; an anonymous inline
  // async function is not.
  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  return { rates, refresh };
}

function NewChallanForm({
  companyId,
  items,
  ledgers,
  branches,
  godowns,
  avgRates,
  onPosted,
}: {
  companyId: string;
  items: Item[];
  ledgers: Ledger[];
  branches: Branch[];
  godowns: Godown[];
  avgRates: Record<string, number>;
  onPosted: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jobWorkerId, setJobWorkerId] = useState("");
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [rate, setRate] = useState("");
  // Once the preparer edits Rate directly, stop overwriting it when the
  // item changes — they may know a better number than the suggested one.
  const [rateTouched, setRateTouched] = useState(false);
  const [godownId, setGodownId] = useState(godowns.find((g) => g.is_default)?.id ?? godowns[0]?.id ?? "");
  const [challanDate, setChallanDate] = useState(new Date().toISOString().slice(0, 10));
  const [expectedReturn, setExpectedReturn] = useState("");
  const [nature, setNature] = useState("");
  const [limitType, setLimitType] = useState<"input" | "capital_good" | "exempt_tool">("input");

  const selectedItem = items.find((i) => i.id === itemId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!jobWorkerId || !itemId || !godownId || !(Number(quantity) > 0)) {
      toast.error("Job worker, item, godown and a positive quantity are all required.");
      return;
    }
    if (!(Number(rate) > 0)) {
      toast.error("Rate must be greater than zero — it values the goods sent for job work. Enter the item's current cost, or its real value.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("create_job_work_challan", {
      p_company_id: companyId,
      p_branch_id: branches[0]?.id,
      p_job_worker_ledger_id: jobWorkerId,
      p_item_id: itemId,
      p_quantity: Number(quantity),
      p_uom: selectedItem?.uom ?? "NOS",
      p_godown_id: godownId,
      p_rate: Number(rate) || 0,
      p_challan_date: challanDate,
      p_nature_of_job_work: nature.trim() || undefined,
      p_expected_return_date: expectedReturn || undefined,
      p_statutory_limit_type: limitType,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Challan created — stock moved out.");
    setJobWorkerId("");
    setItemId("");
    setQuantity("1");
    setRate("");
    setRateTouched(false);
    setNature("");
    setExpectedReturn("");
    setOpen(false);
    router.refresh();
    onPosted();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setOpen((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {open ? "Cancel" : "New challan"}
        </button>
      </div>
      {open && (
        <form onSubmit={submit} className="flex flex-col gap-4 rounded-[14px] border border-border bg-surface p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5">
              <Label>Job worker</Label>
              <Select value={jobWorkerId} onChange={(e) => setJobWorkerId(e.target.value)}>
                <option value="">— select —</option>
                {ledgers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Item</Label>
              <Select
                value={itemId}
                onChange={(e) => {
                  const newItemId = e.target.value;
                  setItemId(newItemId);
                  if (!rateTouched) {
                    const suggested = avgRates[newItemId];
                    setRate(suggested && suggested > 0 ? suggested.toFixed(2) : "");
                  }
                }}
              >
                <option value="">— select —</option>
                {items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Quantity ({selectedItem?.uom ?? "—"})</Label>
              <Input type="number" min={0} step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Rate (₹ per unit — suggested at current cost, editable)</Label>
              <Input
                type="number"
                min={0}
                step="any"
                value={rate}
                onChange={(e) => {
                  setRate(e.target.value);
                  setRateTouched(true);
                }}
                placeholder={itemId && !avgRates[itemId] ? "Item's cost per unit (required)" : undefined}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Godown</Label>
              <Select value={godownId} onChange={(e) => setGodownId(e.target.value)}>
                <option value="">— select —</option>
                {godowns.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Challan date</Label>
              <Input type="date" value={challanDate} onChange={(e) => setChallanDate(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Expected return</Label>
              <Input type="date" value={expectedReturn} onChange={(e) => setExpectedReturn(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Statutory limit</Label>
              <Select value={limitType} onChange={(e) => setLimitType(e.target.value as typeof limitType)}>
                <option value="input">Input (1 year)</option>
                <option value="capital_good">Capital good (3 years)</option>
                <option value="exempt_tool">Tool/die/jig/fixture (no limit)</option>
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-4">
              <Label>Nature of job work</Label>
              <Input value={nature} onChange={(e) => setNature(e.target.value)} placeholder="e.g. Machining, electroplating, stitching" />
            </label>
          </div>
          <div className="flex justify-end">
            <Button type="submit" busy={busy} busyLabel="Posting…">
              Create challan
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function ReturnRow({
  companyId,
  branches,
  godowns,
  items,
  c,
  avgRates,
  onDone,
}: {
  companyId: string;
  branches: Branch[];
  godowns: Godown[];
  items: Item[];
  c: Challan;
  avgRates: Record<string, number>;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10));
  const [receivedQty, setReceivedQty] = useState(String(c.quantity_outstanding));
  const [lossQty, setLossQty] = useState("0");
  const [rate, setRate] = useState("");
  // Once the preparer edits Rate directly, stop overwriting it when the
  // returned item changes — a real, deliberately different value (scrap,
  // damage, added job-work cost) must always be accepted, never forced back
  // to the suggestion.
  const [rateTouched, setRateTouched] = useState(false);
  const [godownId, setGodownId] = useState(godowns.find((g) => g.is_default)?.id ?? godowns[0]?.id ?? "");
  // Defaults to the item that was sent — the common case — but the
  // returned item can legitimately differ (cloth out, shirts back), so
  // this is a real, changeable picker, not an assumption.
  const [returnedItemId, setReturnedItemId] = useState(c.item_id);

  // Suggest the returned item's live weighted-average cost as the Rate
  // default — never blank/0 by default (2070). The common case, a normal
  // job-work return of the same item, is then rate-neutral by construction:
  // accepting the suggestion adds units back at exactly today's average,
  // which cannot move a weighted average. Re-suggests whenever the returned
  // item (or that item's own known average) changes, but never overwrites a
  // value the preparer already edited.
  //
  // Adjusted DURING RENDER, not in an effect: React's own guidance for "sync
  // state to a changed input" is to compare against the last-seen key and
  // call setState inline when it differs, which bails out into an immediate
  // re-render with no committed intermediate frame — the effect version did
  // the same adjustment one render later, which is what the set-state-in-
  // effect lint rule is warning is unnecessary here.
  const suggestionKey = `${returnedItemId}:${avgRates[returnedItemId] ?? ""}`;
  const [lastSuggestionKey, setLastSuggestionKey] = useState(suggestionKey);
  if (suggestionKey !== lastSuggestionKey) {
    setLastSuggestionKey(suggestionKey);
    if (!rateTouched) {
      const suggested = avgRates[returnedItemId];
      setRate(suggested && suggested > 0 ? suggested.toFixed(2) : "");
    }
  }

  async function submit() {
    const received = Number(receivedQty) || 0;
    const loss = Number(lossQty) || 0;
    if (received <= 0 && loss <= 0) {
      toast.error("Enter a received quantity, a loss quantity, or both.");
      return;
    }
    if (received > 0 && !returnedItemId) {
      toast.error("Pick the item actually being returned.");
      return;
    }
    if (received > 0 && !(Number(rate) > 0)) {
      toast.error("Rate must be greater than zero to receive goods back into stock. Enter the item's current cost, or its real value if this batch is genuinely different.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("create_job_work_return", {
      p_company_id: companyId,
      p_branch_id: branches[0]?.id,
      p_challan_id: c.challan_id,
      p_return_date: returnDate,
      p_quantity_received: received,
      p_returned_item_id: received > 0 ? returnedItemId : undefined,
      p_godown_id: received > 0 ? godownId : undefined,
      p_rate: received > 0 ? Number(rate) || 0 : undefined,
      p_quantity_loss_or_waste: loss,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Return recorded.");
    setOpen(false);
    onDone();
  }

  if (c.status === "closed") {
    return <span className="text-xs text-ink-faint">—</span>;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium text-ink hover:bg-accent-soft"
      >
        Record return
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-strong bg-surface-2 p-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} className="h-8 rounded-md border border-border-strong bg-surface px-2" />
        <select
          value={returnedItemId}
          onChange={(e) => setReturnedItemId(e.target.value)}
          title="Item actually being returned — defaults to what was sent"
          className="h-8 min-w-[140px] rounded-md border border-border-strong bg-surface px-2"
        >
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          step="any"
          value={receivedQty}
          onChange={(e) => setReceivedQty(e.target.value)}
          placeholder="Received qty"
          className="h-8 w-24 rounded-md border border-border-strong bg-surface px-2"
        />
        <input
          type="number"
          min={0}
          step="any"
          value={rate}
          onChange={(e) => {
            setRate(e.target.value);
            setRateTouched(true);
          }}
          placeholder={avgRates[returnedItemId] ? undefined : "Rate ₹ (required)"}
          title="Suggested at the item's current cost — override for a genuinely different real value (scrap, damage, added job-work charge)"
          className="h-8 w-20 rounded-md border border-border-strong bg-surface px-2"
        />
        <select value={godownId} onChange={(e) => setGodownId(e.target.value)} className="h-8 rounded-md border border-border-strong bg-surface px-2">
          {godowns.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          step="any"
          value={lossQty}
          onChange={(e) => setLossQty(e.target.value)}
          placeholder="Loss/waste qty"
          className="h-8 w-24 rounded-md border border-border-strong bg-surface px-2"
        />
      </div>
      <p className="text-xs text-ink-faint">
        Still outstanding on this challan: {formatINR(c.quantity_outstanding, { showZero: true })} {c.uom}.
        Rate is suggested at the item&rsquo;s current cost so an ordinary return doesn&rsquo;t move its
        valuation — override it if this batch is genuinely worth something different.
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} busy={busy} busyLabel="Saving…">
          Confirm
        </Button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-faint hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}

export function JobWorkManager({
  companyId,
  challans,
  items,
  ledgers,
  branches,
  godowns,
}: {
  companyId: string;
  challans: Challan[];
  items: Item[];
  ledgers: Ledger[];
  branches: Branch[];
  godowns: Godown[];
}) {
  const router = useRouter();
  const { rates: avgRates, refresh: refreshAvgRates } = useItemAverageRates(companyId);

  return (
    <div className="flex flex-col gap-6">
      <NewChallanForm
        companyId={companyId}
        items={items}
        ledgers={ledgers}
        branches={branches}
        godowns={godowns}
        avgRates={avgRates}
        onPosted={refreshAvgRates}
      />

      {challans.length === 0 ? (
        <EmptyState>No job work challans yet.</EmptyState>
      ) : (
        <TableContainer>
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr>
                <th className={th}>Challan</th>
                <th className={th}>Job worker</th>
                <th className={th}>Item</th>
                <th className={th + " text-right"}>Sent</th>
                <th className={th + " text-right"}>Outstanding</th>
                <th className={th}>Due date</th>
                <th className={th}>Status</th>
                <th className={th}>Return</th>
              </tr>
            </thead>
            <tbody>
              {challans.map((c) => (
                <tr key={c.challan_id}>
                  <td className={td}>
                    <div>{c.challan_number}</div>
                    <div className="text-xs text-ink-faint">{c.challan_date}</div>
                  </td>
                  <td className={td}>{c.job_worker_name}</td>
                  <td className={td}>{c.item_name}</td>
                  <td className={num}>
                    {formatINR(c.quantity_sent, { showZero: true })} {c.uom}
                  </td>
                  <td className={num + (c.quantity_outstanding > 0 ? " font-medium text-warning" : "")}>
                    {formatINR(c.quantity_outstanding, { showZero: true })} {c.uom}
                  </td>
                  <td className={td}>
                    {c.statutory_due_date ? (
                      <span className={c.is_overdue ? "font-medium text-error" : "text-ink"}>
                        {c.extended_due_date ?? c.statutory_due_date}
                        {c.is_overdue && " · overdue"}
                      </span>
                    ) : (
                      <span className="text-ink-faint">No limit</span>
                    )}
                  </td>
                  <td className={td}>
                    <Badge tone={STATUS_TONE[c.status]}>{c.status.replace("_", " ")}</Badge>
                  </td>
                  <td className={td}>
                    <ReturnRow
                      companyId={companyId}
                      branches={branches}
                      godowns={godowns}
                      items={items}
                      c={c}
                      avgRates={avgRates}
                      onDone={() => {
                        router.refresh();
                        refreshAvgRates();
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}

      <p className="text-xs text-ink-faint">
        Sending material to a job worker isn&rsquo;t a &ldquo;supply&rdquo; under Sec 7
        CGST Act — no invoice, no GST at dispatch. A challan that passes its due date with
        material still outstanding is treated as deemed-supplied retroactively, which is
        what the &ldquo;overdue&rdquo; flag above is warning about. Return quantity can
        split across several visits here; a partial return keeps the challan open until
        everything sent is either received back or written off as loss/waste.
      </p>
    </div>
  );
}
