"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { createClient } from "@/lib/supabase/client";
import { describeDate, inferDateOrder, type DateOrder } from "@/lib/csv/coerce";
import { buildBankPreview, type BankCsvRow, type ExistingLine } from "@/lib/csv/bank-import";
import { formatINR } from "@/lib/utils/currency";

type Summary = {
  book_balance: number;
  unmatched_book_count: number;
  unmatched_book_total: number;
  unmatched_statement_count: number;
  unmatched_statement_total: number;
} | null;

type Entry = {
  id: string;
  debit_amount: number;
  credit_amount: number;
  voucher_number: string;
  voucher_date: string;
  narration: string | null;
};

type Line = {
  id: string;
  txn_date: string;
  description: string | null;
  reference: string | null;
  debit_amount: number;
  credit_amount: number;
};

const TEMPLATE = [
  "Date,Description,Reference,Debit,Credit",
  "01/04/2026,Inward transfer,UTR8827,,5000.00",
  "02/04/2026,Cheque 000451,,2000.00,",
  "03/04/2026,Bank charges,,150.00,",
].join("\n");

export function ReconciliationScreen({
  companyId,
  ledgerId,
  bankLedgers,
  summary,
  unmatchedEntries,
  unmatchedLines,
  existingLines,
}: {
  companyId: string;
  ledgerId: string;
  bankLedgers: { id: string; name: string }[];
  summary: Summary;
  unmatchedEntries: Entry[];
  unmatchedLines: Line[];
  existingLines: ExistingLine[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoMatchedJustNow, setAutoMatchedJustNow] = useState<number | null>(null);

  // ---- import ---------------------------------------------------------
  const [rawRows, setRawRows] = useState<BankCsvRow[]>([]);
  const [dateOrder, setDateOrder] = useState<DateOrder>("dmy");
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number } | null>(null);

  const inference = useMemo(
    () => (rawRows.length ? inferDateOrder(rawRows.map((r) => findCol(r, "date"))) : null),
    [rawRows]
  );
  const preview = useMemo(
    () => (rawRows.length ? buildBankPreview(rawRows, dateOrder, existingLines) : null),
    [rawRows, dateOrder, existingLines]
  );

  function onFile(file: File) {
    setImportResult(null);
    setOrderConfirmed(false);
    Papa.parse<BankCsvRow>(file, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (out) => {
        setRawRows(out.data);
        const inf = inferDateOrder(out.data.map((r) => findCol(r, "date")));
        setDateOrder(inf.order);
        setOrderConfirmed(inf.certain);
      },
    });
  }

  async function commitImport() {
    if (!preview) return;
    const good = preview.filter((r) => r.issues.length === 0);
    if (!good.length) return;

    setBusy(true);
    const { error } = await createClient()
      .from("bank_statement_lines")
      .insert(
        good.map((r) => ({
          company_id: companyId,
          ledger_id: ledgerId,
          txn_date: r.date!,
          description: r.description,
          reference: r.reference,
          debit_amount: r.side === "debit" ? r.amount! : 0,
          credit_amount: r.side === "credit" ? r.amount! : 0,
        }))
      );

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    setImportResult({ imported: good.length });
    setRawRows([]);
    if (fileRef.current) fileRef.current.value = "";
    setBusy(false);
    router.refresh();
  }

  // ---- matching ---------------------------------------------------------
  const line = unmatchedLines.find((l) => l.id === selectedLine) ?? null;

  // An entry is eligible for the selected line only if it is on the opposite
  // side with the same amount — the sign convention the database itself
  // enforces, mirrored here just to guide the click rather than to decide.
  function eligible(entry: Entry): boolean {
    if (!line) return false;
    if (line.credit_amount > 0) return entry.debit_amount === line.credit_amount;
    return entry.credit_amount === line.debit_amount;
  }

  async function confirmMatch(entryId: string) {
    if (!selectedLine) return;
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("match_bank_line", {
      p_statement_line_id: selectedLine,
      p_voucher_entry_id: entryId,
    });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    setSelectedLine(null);
    setBusy(false);
    router.refresh();
  }

  async function runAutoMatch() {
    setBusy(true);
    setError(null);
    const { data, error } = await createClient().rpc("auto_match_bank_lines", {
      p_company_id: companyId,
      p_ledger_id: ledgerId,
    });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    setAutoMatchedJustNow(typeof data === "number" ? data : 0);
    setBusy(false);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8">
      {/* ---- ledger picker + summary --------------------------------- */}
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium">Ledger</span>
          <select
            value={ledgerId}
            onChange={(e) => router.push(`?ledger=${e.target.value}`)}
            className={field}
          >
            {bankLedgers.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {summary && (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="text-[11px] uppercase tracking-wide text-ink-faint">Book balance</div>
            <div className="mt-1 text-lg font-semibold tabular-nums font-mono">
              {formatINR(summary.book_balance, { showZero: true })}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <div className="text-[11px] uppercase tracking-wide text-ink-faint">
              Not yet on statement
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums font-mono">
              {summary.unmatched_book_count} entr{summary.unmatched_book_count === 1 ? "y" : "ies"}
            </div>
          </div>
          <div className="rounded-lg border border-warning/30 bg-warning-soft p-4">
            <div className="text-[11px] uppercase tracking-wide text-warning">
              Not yet in your books
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums font-mono">
              {summary.unmatched_statement_count} line
              {summary.unmatched_statement_count === 1 ? "" : "s"} ·{" "}
              {formatINR(summary.unmatched_statement_total, { showZero: true })}
            </div>
          </div>
        </div>
      )}

      {/* ---- import ---------------------------------------------------- */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          className="text-sm file:mr-3 file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm"
        />
        <button
          type="button"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = "lekha-bank-statement-template.csv";
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="text-sm text-accent underline underline-offset-4"
        >
          Download template
        </button>
        <button
          type="button"
          onClick={runAutoMatch}
          disabled={busy}
          className="rounded-lg border border-border-strong px-3 py-1.5 text-sm transition-colors hover:bg-accent-soft disabled:opacity-50"
        >
          Auto-match exact same-day amounts
        </button>
      </div>

      {autoMatchedJustNow !== null && (
        <p className="mt-2 text-sm text-ink-soft">
          {autoMatchedJustNow === 0
            ? "Nothing unambiguous to match automatically."
            : `Matched ${autoMatchedJustNow} pair${autoMatchedJustNow === 1 ? "" : "s"}.`}
        </p>
      )}

      {importResult && (
        <p className="mt-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          Imported {importResult.imported} line{importResult.imported === 1 ? "" : "s"}.
        </p>
      )}

      {inference && !inference.certain && !orderConfirmed && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning-soft p-4">
          <p className="text-sm font-medium">Which way round are these dates?</p>
          {inference.example && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(["dmy", "mdy"] as const).map((order) => {
                const example = inference.example!;
                return (
                  <button
                    key={order}
                    type="button"
                    onClick={() => {
                      setDateOrder(order);
                      setOrderConfirmed(true);
                    }}
                    className="rounded-md border border-border-strong bg-surface p-3 text-left text-sm transition hover:border-accent"
                  >
                    {order === "dmy" ? "Day first" : "Month first"} —{" "}
                    <span className="font-mono">{example}</span> is{" "}
                    {describeDate(example, order)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {preview && (inference?.certain || orderConfirmed) && (
        <div className="mt-4">
          <div className="overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 100).map((r) => (
                  <tr key={r.rowNumber} className="border-b border-border">
                    <td className="px-3 py-1.5 tabular-nums font-mono">{r.date ?? "—"}</td>
                    <td className="px-3 py-1.5">{r.description || "—"}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-mono">
                      {r.amount ? `${r.side === "debit" ? "Dr" : "Cr"} ${formatINR(r.amount)}` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-warning">
                      {r.issues.join(" ")}
                      {r.possibleDuplicate && "Looks already imported."}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={commitImport}
            disabled={busy || preview.every((r) => r.issues.length > 0)}
            className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Import {preview.filter((r) => r.issues.length === 0).length} line
            {preview.filter((r) => r.issues.length === 0).length === 1 ? "" : "s"}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-4 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
          {error}
        </p>
      )}

      {/* ---- matching ---------------------------------------------------- */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <section>
          <h2 className="mb-2 text-sm font-semibold">
            On the statement, not in your books ({unmatchedLines.length})
          </h2>
          <div className="max-h-[480px] overflow-y-auto rounded-lg border border-border bg-surface">
            {unmatchedLines.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-ink-faint">Nothing unmatched.</p>
            )}
            {unmatchedLines.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setSelectedLine(selectedLine === l.id ? null : l.id)}
                className={
                  "flex w-full items-center justify-between gap-3 border-b border-border px-4 py-2.5 text-left text-sm last:border-0  " +
                  (selectedLine === l.id
                    ? "bg-accent-soft"
                    : "hover:bg-surface-2")
                }
              >
                <span>
                  <span className="tabular-nums text-ink-faint font-mono">{l.txn_date}</span>{" "}
                  {l.description ?? "—"}
                </span>
                <span className="shrink-0 tabular-nums font-medium font-mono">
                  {l.credit_amount > 0 ? "Cr " : "Dr "}
                  {formatINR(l.credit_amount || l.debit_amount)}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-semibold">
            In your books, not on the statement ({unmatchedEntries.length})
            {line && <span className="ml-2 font-normal text-ink-faint">— pick the match</span>}
          </h2>
          <div className="max-h-[480px] overflow-y-auto rounded-lg border border-border bg-surface">
            {unmatchedEntries.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-ink-faint">Nothing unmatched.</p>
            )}
            {unmatchedEntries.map((e) => {
              const canMatch = line ? eligible(e) : true;
              return (
                <button
                  key={e.id}
                  type="button"
                  disabled={!line || !canMatch || busy}
                  onClick={() => confirmMatch(e.id)}
                  className={
                    "flex w-full items-center justify-between gap-3 border-b border-border px-4 py-2.5 text-left text-sm last:border-0  " +
                    (!line
                      ? "text-ink-faint"
                      : canMatch
                        ? "hover:bg-accent-soft"
                        : "opacity-30")
                  }
                >
                  <span>
                    <span className="tabular-nums text-ink-faint font-mono">{e.voucher_date}</span>{" "}
                    <span className="font-mono text-xs">{e.voucher_number}</span>{" "}
                    {e.narration ?? ""}
                  </span>
                  <span className="shrink-0 tabular-nums font-medium font-mono">
                    {e.debit_amount > 0 ? "Dr " : "Cr "}
                    {formatINR(e.debit_amount || e.credit_amount)}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {line && (
        <p className="mt-3 text-xs text-ink-faint">
          Selected the {line.credit_amount > 0 ? "credit" : "debit"} of{" "}
          {formatINR(line.credit_amount || line.debit_amount)} on {line.txn_date}. Only
          entries on the opposite side with the same amount are enabled on the
          right.
        </p>
      )}
    </div>
  );
}

function findCol(row: BankCsvRow, header: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === header) return String(v ?? "");
  }
  return "";
}
