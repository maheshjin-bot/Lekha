"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Button } from "@/components/ui/Button";
import { Input, Select, Label } from "@/components/ui/Input";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";

const CURRENCIES = ["USD", "EUR", "GBP", "AED", "SGD", "JPY", "AUD", "CAD"];
const RATE_SOURCES = [
  { value: "rbi", label: "RBI reference rate" },
  { value: "bank", label: "Bank-advised rate" },
  { value: "cbic", label: "CBIC notified rate" },
  { value: "manual", label: "Manual" },
];

type Ledger = { id: string; name: string; role: string | null };
type Branch = { id: string; code: string; name: string };
type OpenVoucher = {
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  voucher_type: string;
  txn_currency: string;
  exchange_rate: number;
  carrying_rate: number;
  last_revalued_at: string | null;
  party_ledger_id: string;
  party_ledger_name: string;
  fc_amount: number;
  inr_amount: number;
  direction: "debit" | "credit";
};

type DraftLine = { ledger_id: string; side: "debit" | "credit"; amount: string; fc_amount: string };

function emptyLine(): DraftLine {
  return { ledger_id: "", side: "debit", amount: "", fc_amount: "" };
}

function NewVoucherForm({
  companyId,
  ledgers,
  branches,
}: {
  companyId: string;
  ledgers: Ledger[];
  branches: Branch[];
}) {
  const router = useRouter();
  const [voucherType, setVoucherType] = useState<"journal" | "receipt" | "payment">("journal");
  const [voucherDate, setVoucherDate] = useState(new Date().toISOString().slice(0, 10));
  const [currency, setCurrency] = useState("USD");
  const [rate, setRate] = useState("");
  const [rateSource, setRateSource] = useState("rbi");
  const [narration, setNarration] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const [busy, setBusy] = useState(false);

  function updateLine(i: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  const totalDebit = lines.reduce((n, l) => n + (l.side === "debit" ? Number(l.amount) || 0 : 0), 0);
  const totalCredit = lines.reduce((n, l) => n + (l.side === "credit" ? Number(l.amount) || 0 : 0), 0);
  const balanced = lines.length >= 2 && totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.005;
  const fcLineCount = lines.filter((l) => Number(l.fc_amount) > 0).length;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const validLines = lines.filter((l) => l.ledger_id && Number(l.amount) > 0);
    if (!balanced) {
      toast.error("Debits and credits must balance before this can post.");
      return;
    }
    if (fcLineCount > 1) {
      toast.error("Only one line can carry a foreign-currency amount — settlement only supports a single FC leg.");
      return;
    }
    if (!(Number(rate) > 0)) {
      toast.error("Enter the exchange rate.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("create_voucher", {
      p_company_id: companyId,
      p_branch_id: branches[0]?.id,
      p_voucher_type: voucherType,
      p_voucher_date: voucherDate,
      p_lines: validLines.map((l) => ({
        ledger_id: l.ledger_id,
        debit_amount: l.side === "debit" ? Number(l.amount) : 0,
        credit_amount: l.side === "credit" ? Number(l.amount) : 0,
        fc_amount: Number(l.fc_amount) > 0 ? Number(l.fc_amount) : undefined,
      })),
      p_narration: narration.trim() || undefined,
      p_txn_currency: currency,
      p_exchange_rate: Number(rate),
      p_rate_source: rateSource || undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Foreign-currency voucher posted.");
    setLines([emptyLine(), emptyLine()]);
    setNarration("");
    setRate("");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-[14px] border border-border bg-surface p-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1.5">
          <Label>Voucher type</Label>
          <Select value={voucherType} onChange={(e) => setVoucherType(e.target.value as typeof voucherType)}>
            <option value="journal">Journal</option>
            <option value="receipt">Receipt</option>
            <option value="payment">Payment</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1.5">
          <Label>Date</Label>
          <Input type="date" value={voucherDate} onChange={(e) => setVoucherDate(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1.5">
          <Label>Currency</Label>
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1.5">
          <Label>Exchange rate (₹ per unit)</Label>
          <Input type="number" min={0} step="any" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="83.25" />
        </label>
        <label className="flex flex-col gap-1.5">
          <Label>Rate source</Label>
          <Select value={rateSource} onChange={(e) => setRateSource(e.target.value)}>
            {RATE_SOURCES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
          <Label>Narration</Label>
          <Input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Export sale — invoice ref, shipment, etc." />
        </label>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-xs text-ink-faint">
          Give the debtor/creditor (or other foreign-denominated) line its FC amount — that
          is the one line settlement will later close. Every other line is a plain INR
          amount.
        </p>
        {lines.map((l, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select
              value={l.ledger_id}
              onChange={(e) => updateLine(i, { ledger_id: e.target.value })}
              className="min-w-[200px] flex-1"
            >
              <option value="">— select ledger —</option>
              {ledgers.map((led) => (
                <option key={led.id} value={led.id}>
                  {led.name}
                </option>
              ))}
            </Select>
            <Select
              value={l.side}
              onChange={(e) => updateLine(i, { side: e.target.value as "debit" | "credit" })}
              className="w-24"
            >
              <option value="debit">Dr</option>
              <option value="credit">Cr</option>
            </Select>
            <Input
              type="number"
              min={0}
              step="any"
              value={l.amount}
              onChange={(e) => updateLine(i, { amount: e.target.value })}
              placeholder="INR amount"
              className="w-32"
            />
            <Input
              type="number"
              min={0}
              step="any"
              value={l.fc_amount}
              onChange={(e) => updateLine(i, { fc_amount: e.target.value })}
              placeholder={`${currency} amount (optional)`}
              className="w-40"
            />
            <button
              type="button"
              onClick={() => setLines((prev) => prev.filter((_, idx) => idx !== i))}
              className="text-ink-faint hover:text-error"
              aria-label="Remove line"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setLines((prev) => [...prev, emptyLine()])}
          className="self-start text-xs font-medium text-accent hover:underline"
        >
          + Add line
        </button>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
        <span className={balanced ? "text-ink-soft" : "text-error"}>
          Dr {formatINR(totalDebit, { showZero: true })} · Cr {formatINR(totalCredit, { showZero: true })}
          {!balanced && " — must balance"}
        </span>
        <Button type="submit" busy={busy} busyLabel="Posting…" disabled={!balanced}>
          Post voucher
        </Button>
      </div>
    </form>
  );
}

export function ForexManager({
  companyId,
  tab,
  ledgers,
  branches,
  openVouchers,
}: {
  companyId: string;
  tab: "new" | "settle";
  ledgers: Ledger[];
  branches: Branch[];
  openVouchers: OpenVoucher[];
}) {
  const router = useRouter();
  const bankLedgers = ledgers.filter((l) => l.role === "cash_bank");

  if (tab === "new") {
    return <NewVoucherForm companyId={companyId} ledgers={ledgers} branches={branches} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {openVouchers.length === 0 ? (
        <EmptyState>No open foreign-currency vouchers. Post one under &ldquo;New voucher&rdquo; first.</EmptyState>
      ) : (
        <TableContainer>
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr>
                <th className={th}>Voucher</th>
                <th className={th}>Ledger</th>
                <th className={th + " text-right"}>FC amount</th>
                <th className={th + " text-right"}>Carrying value (₹)</th>
                <th className={th}>Revalue</th>
                <th className={th}>Settle</th>
              </tr>
            </thead>
            <tbody>
              {openVouchers.map((v) => (
                <tr key={v.voucher_id}>
                  <td className={td}>
                    <div>{v.voucher_number}</div>
                    <div className="text-xs text-ink-faint">{v.voucher_date}</div>
                  </td>
                  <td className={td}>
                    {v.party_ledger_name}
                    <div className="text-xs text-ink-faint">
                      {v.direction === "debit" ? "Receivable" : "Payable"}
                    </div>
                  </td>
                  <td className={num}>
                    {v.txn_currency} {formatINR(v.fc_amount, { showZero: true })}
                  </td>
                  <td className={num}>
                    {formatINR(v.inr_amount, { showZero: true })}
                    <div className="text-xs text-ink-faint">
                      @ {v.carrying_rate}
                      {v.last_revalued_at ? ` (revalued ${v.last_revalued_at})` : " (booked rate)"}
                    </div>
                  </td>
                  <td className={td}>
                    <RevalueRow
                      companyId={companyId}
                      branches={branches}
                      v={v}
                      onDone={() => router.refresh()}
                    />
                  </td>
                  <td className={td}>
                    <SettleRow
                      companyId={companyId}
                      branches={branches}
                      bankLedgers={bankLedgers}
                      v={v}
                      onDone={() => router.refresh()}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}
      <p className="text-xs text-ink-faint">
        <b>Revalue</b> restates a still-open voucher to today&rsquo;s rate as an unrealized
        gain/loss — no cash moves, the voucher stays open. <b>Settle</b> is the real,
        realized close-out once actual money moves; full settlement only, v1 doesn&rsquo;t
        split one voucher&rsquo;s foreign-currency amount across several receipts. Either
        way the gain/loss posts to a per-company &ldquo;Exchange Gain/Loss&rdquo; ledger,
        created automatically on first use — and a voucher revalued one or more times
        before it&rsquo;s finally settled is only ever charged the movement since its last
        revaluation, never the same movement twice.
      </p>
    </div>
  );
}

function RevalueRow({
  companyId,
  branches,
  v,
  onDone,
}: {
  companyId: string;
  branches: Branch[];
  v: OpenVoucher;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [rate, setRate] = useState("");
  const [rateSource, setRateSource] = useState("rbi");
  const [busy, setBusy] = useState(false);

  const newCarrying = Number(rate) > 0 ? Number(rate) * v.fc_amount : null;
  const delta = newCarrying != null ? newCarrying - v.inr_amount : null;
  const gainLoss = delta != null ? (v.direction === "debit" ? delta : -delta) : null;

  async function revalue() {
    if (!(Number(rate) > 0)) {
      toast.error("Enter the closing rate.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("record_forex_revaluation", {
      p_company_id: companyId,
      p_branch_id: branches[0]?.id,
      p_original_voucher_id: v.voucher_id,
      p_as_at: date,
      p_closing_rate: Number(rate),
      p_rate_source: rateSource || undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Revaluation posted.");
    setOpen(false);
    onDone();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium text-ink hover:bg-accent-soft"
      >
        Revalue
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-strong bg-surface-2 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-8 rounded-md border border-border-strong bg-surface px-2 text-xs"
        />
        <input
          type="number"
          min={0}
          step="any"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          placeholder={`Closing rate (${v.txn_currency})`}
          className="h-8 w-36 rounded-md border border-border-strong bg-surface px-2 text-xs"
        />
        <select
          value={rateSource}
          onChange={(e) => setRateSource(e.target.value)}
          className="h-8 rounded-md border border-border-strong bg-surface px-2 text-xs"
        >
          {RATE_SOURCES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      {gainLoss != null && (
        <p className="text-xs text-ink-faint">
          New carrying value {formatINR(newCarrying ?? 0, { showZero: true })} vs. current{" "}
          {formatINR(v.inr_amount, { showZero: true })} ={" "}
          {gainLoss === 0 ? (
            "no change"
          ) : (
            <span className={gainLoss > 0 ? "text-success" : "text-error"}>
              unrealized {gainLoss > 0 ? "gain" : "loss"} of {formatINR(Math.abs(gainLoss), { showZero: true })}
            </span>
          )}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={revalue} busy={busy} busyLabel="Posting…">
          Confirm revaluation
        </Button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-faint hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}

function SettleRow({
  companyId,
  branches,
  bankLedgers,
  v,
  onDone,
}: {
  companyId: string;
  branches: Branch[];
  bankLedgers: Ledger[];
  v: OpenVoucher;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [rate, setRate] = useState("");
  const [rateSource, setRateSource] = useState("rbi");
  const [ledgerId, setLedgerId] = useState("");
  const [busy, setBusy] = useState(false);

  const settlementInr = Number(rate) > 0 ? Number(rate) * v.fc_amount : null;
  const gainLoss =
    settlementInr != null
      ? v.direction === "debit"
        ? settlementInr - v.inr_amount
        : v.inr_amount - settlementInr
      : null;

  async function settle() {
    if (!(Number(rate) > 0)) {
      toast.error("Enter the settlement rate.");
      return;
    }
    if (!ledgerId) {
      toast.error("Pick the bank/cash ledger money actually moved through.");
      return;
    }
    setBusy(true);
    const { error } = await createClient().rpc("record_forex_settlement", {
      p_company_id: companyId,
      p_branch_id: branches[0]?.id,
      p_original_voucher_id: v.voucher_id,
      p_settlement_date: date,
      p_settlement_rate: Number(rate),
      p_settlement_ledger_id: ledgerId,
      p_rate_source: rateSource || undefined,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Settlement posted.");
    setOpen(false);
    onDone();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium text-ink hover:bg-accent-soft"
      >
        Settle
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-strong bg-surface-2 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-8 rounded-md border border-border-strong bg-surface px-2 text-xs"
        />
        <input
          type="number"
          min={0}
          step="any"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          placeholder={`Rate (${v.txn_currency})`}
          className="h-8 w-32 rounded-md border border-border-strong bg-surface px-2 text-xs"
        />
        <select
          value={rateSource}
          onChange={(e) => setRateSource(e.target.value)}
          className="h-8 rounded-md border border-border-strong bg-surface px-2 text-xs"
        >
          {RATE_SOURCES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <select
          value={ledgerId}
          onChange={(e) => setLedgerId(e.target.value)}
          className="h-8 min-w-[160px] rounded-md border border-border-strong bg-surface px-2 text-xs"
        >
          <option value="">— bank/cash ledger —</option>
          {bankLedgers.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>
      {gainLoss != null && (
        <p className="text-xs text-ink-faint">
          Settlement value {formatINR(settlementInr ?? 0, { showZero: true })} vs. booked{" "}
          {formatINR(v.inr_amount, { showZero: true })} ={" "}
          <span className={gainLoss >= 0 ? "text-success" : "text-error"}>
            {gainLoss >= 0 ? "gain" : "loss"} of {formatINR(Math.abs(gainLoss), { showZero: true })}
          </span>
        </p>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={settle} busy={busy} busyLabel="Posting…">
          Confirm settlement
        </Button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-faint hover:text-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}
