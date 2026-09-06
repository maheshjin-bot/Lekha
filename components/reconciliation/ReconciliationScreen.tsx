"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { createClient } from "@/lib/supabase/client";
import { describeDate, inferDateOrder, type DateOrder } from "@/lib/csv/coerce";
import { buildBankPreview, type BankCsvRow, type ExistingLine } from "@/lib/csv/bank-import";
import {
  BANK_FORMATS,
  detectBankFormat,
  getBankFormat,
  mapRowToCanonical,
  type BankFormatId,
} from "@/lib/csv/bank-format-adapters";
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

// A SUGGESTION only (from payment_webhook_events, migration 1420) — never an
// authoritative match. Surfaced as a highlighted banner on the line it
// belongs to; the actual confirmation is always the existing match_bank_line
// click below, on whichever book entry the user picks — never a new path.
type Suggestion = {
  ledgerName: string;
  voucherNumber: string;
  amount: number;
  reason: string | null;
} | null;

type Line = {
  id: string;
  txn_date: string;
  description: string | null;
  reference: string | null;
  debit_amount: number;
  credit_amount: number;
  suggestion?: Suggestion;
};

/** A statement line that has already been paired with a book entry. */
type MatchedLine = Line & {
  matched_at: string | null;
  entry_debit: number;
  entry_credit: number;
  voucher_number: string;
  voucher_date: string;
  narration: string | null;
  voucher_is_deleted: boolean;
};

// One downloadable sample per adapter, in that bank's own real column
// layout — see lib/csv/bank-format-adapters.ts for the sourcing behind
// each layout. "generic" is this app's own pre-existing template.
const SAMPLE_CSV: Record<BankFormatId, string> = {
  generic: [
    "Date,Description,Reference,Debit,Credit",
    "01/04/2026,Inward transfer,UTR8827,,5000.00",
    "02/04/2026,Cheque 000451,,2000.00,",
    "03/04/2026,Bank charges,,150.00,",
  ].join("\n"),
  hdfc_netbanking: [
    "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
    "01/04/2026,NEFT-UTR8827-ABC TRADERS,UTR8827,01/04/2026,,5000.00,55000.00",
    "02/04/2026,CHQ PAID 000451,000451,02/04/2026,2000.00,,53000.00",
    "03/04/2026,BANK CHARGES,,03/04/2026,150.00,,52850.00",
  ].join("\n"),
  icici_netbanking: [
    "Value Date,Transaction Date,Cheque Number,Transaction Remarks,Transaction Type,Amount (INR),Balance (INR)",
    "01-04-2026,01-04-2026,UTR8827,NEFT INWARD ABC TRADERS,Cr,5000.00,55000.00",
    "02-04-2026,02-04-2026,000451,CHEQUE PAID,Dr,2000.00,53000.00",
    "03-04-2026,03-04-2026,,BANK CHARGES,Dr,150.00,52850.00",
  ].join("\n"),
  axis_netbanking: [
    "Tran Date,Value Date,Transaction Particulars,Chq No,Amount(in Rs.),DR/CR,Balance(in Rs.)",
    "01-04-2026,01-04-2026,NEFT INWARD ABC TRADERS,UTR8827,5000.00,CR,55000.00",
    "02-04-2026,02-04-2026,CHEQUE PAID,000451,2000.00,DR,53000.00",
    "03-04-2026,03-04-2026,BANK CHARGES,,150.00,DR,52850.00",
  ].join("\n"),
};

export function ReconciliationScreen({
  companyId,
  ledgerId,
  bankLedgers,
  summary,
  unmatchedEntries,
  unmatchedLines,
  matchedLines,
  existingLines,
}: {
  companyId: string;
  ledgerId: string;
  bankLedgers: { id: string; name: string }[];
  summary: Summary;
  unmatchedEntries: Entry[];
  unmatchedLines: Line[];
  matchedLines: MatchedLine[];
  existingLines: ExistingLine[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoMatchedJustNow, setAutoMatchedJustNow] = useState<number | null>(null);
  const [unmatchedJustNow, setUnmatchedJustNow] = useState<string | null>(null);

  // ---- import ---------------------------------------------------------
  const [rawRows, setRawRows] = useState<BankCsvRow[]>([]);
  const [formatId, setFormatId] = useState<BankFormatId>("generic");
  const [detectedFormatId, setDetectedFormatId] = useState<BankFormatId | null>(null);
  const [dateOrder, setDateOrder] = useState<DateOrder>("dmy");
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);
  // Set only for a PDF upload — unlike a CSV file (whose already-parsed
  // rawRows are format-agnostic and can be re-interpreted locally for any
  // format the dropdown is switched to), a PDF's rawRows depend on WHICH
  // format's own column geometry produced them, so switching formats after
  // a PDF upload re-POSTs the original file rather than re-reading state
  // that no longer applies. null whenever the current rawRows came from a
  // CSV, or from nothing yet.
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfNote, setPdfNote] = useState<string | null>(null);

  const format = useMemo(() => getBankFormat(formatId), [formatId]);

  const inference = useMemo(
    () => (rawRows.length ? inferDateOrder(rawRows.map((r) => mapRowToCanonical(r, format).date)) : null),
    [rawRows, format]
  );
  const preview = useMemo(
    () => (rawRows.length ? buildBankPreview(rawRows, dateOrder, format, existingLines) : null),
    [rawRows, dateOrder, format, existingLines]
  );

  // Recomputes date-order inference for whichever format is now selected —
  // a different format can mean a different date column entirely.
  function reinferDateOrder(rows: BankCsvRow[], fmt = format) {
    const inf = inferDateOrder(rows.map((r) => mapRowToCanonical(r, fmt).date));
    setDateOrder(inf.order);
    setOrderConfirmed(inf.certain);
  }

  function onFile(file: File) {
    setImportResult(null);
    setOrderConfirmed(false);
    setPdfNote(null);

    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (isPdf) {
      setPdfFile(file);
      parsePdf(file, null);
      return;
    }

    setPdfFile(null);
    Papa.parse<BankCsvRow>(file, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (out) => {
        setRawRows(out.data);
        // Auto-detect from the header row to prefill the picker below, but
        // never silently commit to a guess: the dropdown always shows what
        // was picked (detected or defaulted to "generic"), it stays fully
        // editable, and the preview table re-renders live off whatever is
        // selected — the same "infer, then let the file's own preview
        // confirm or refute it" approach this screen already uses for date
        // order, chosen over a silent auto-detect-only because picking the
        // wrong bank format can flip which column is debit and which is
        // credit, which is a worse failure than asking.
        const detected = detectBankFormat(out.meta.fields ?? []);
        setDetectedFormatId(detected);
        const fmt = getBankFormat(detected ?? "generic");
        setFormatId(fmt.id);
        reinferDateOrder(out.data, fmt);
      },
    });
  }

  // A PDF's rawRows are produced by a specific format's own column geometry
  // (lib/csv/bank-pdf-import.ts) server-side — pass explicitFormatId to
  // re-run extraction under a different format (the dropdown override path);
  // pass null to let the server try every registered format, mirroring
  // detectBankFormat's CSV auto-detect.
  async function parsePdf(file: File, explicitFormatId: BankFormatId | null) {
    setPdfBusy(true);
    setError(null);
    setPdfNote(null);
    try {
      const body = new FormData();
      body.set("file", file);
      if (explicitFormatId) body.set("formatId", explicitFormatId);

      const res = await fetch(`/api/companies/${companyId}/bank-statement-pdf`, { method: "POST", body });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not read this PDF.");
        setRawRows([]);
        setPdfBusy(false);
        return;
      }

      const rows: BankCsvRow[] = json.rows ?? [];
      const detected: BankFormatId | null = json.detectedFormatId ?? null;
      setRawRows(rows);
      setDetectedFormatId(explicitFormatId ? null : detected);
      const fmt = getBankFormat(explicitFormatId ?? detected ?? "generic");
      setFormatId(fmt.id);
      if (rows.length) reinferDateOrder(rows, fmt);
      if (!detected) {
        setPdfNote(
          explicitFormatId
            ? `No "${fmt.label}" column header found anywhere in this PDF — try a different format above, or the CSV/Excel export instead.`
            : "Could not confidently match this PDF's own table layout to a known bank format — check the format above, or try the CSV/Excel export instead."
        );
      } else if (rows.length === 0) {
        setPdfNote("Found this bank's column headers, but no transaction rows underneath them — check the file has statement rows, not just a summary page.");
      }
    } catch {
      setError("Could not reach the server to read this PDF.");
      setRawRows([]);
    } finally {
      setPdfBusy(false);
    }
  }

  function onFormatChange(id: BankFormatId) {
    setFormatId(id);
    if (pdfFile) {
      parsePdf(pdfFile, id);
      return;
    }
    if (rawRows.length) reinferDateOrder(rawRows, getBankFormat(id));
  }

  async function commitImport() {
    if (!preview) return;
    const good = preview.filter((r) => r.issues.length === 0);
    if (!good.length) return;

    setBusy(true);
    // ignoreDuplicates -> ON CONFLICT (company_id, ledger_id,
    // external_txn_id) DO NOTHING. Re-uploading the identical file a
    // second time reproduces the identical external_txn_id per row (see
    // computeExternalTxnId), so every row conflicts and is silently
    // skipped rather than duplicated — .select() then returns only the
    // rows that were ACTUALLY inserted, which is how imported/skipped
    // below are told apart.
    // source_format/external_txn_id (0164) predate the generated types
    // being refreshed — same "as any" escape hatch the manufacturing/backup
    // code already uses for a column/table ahead of codegen.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = (await (createClient().from("bank_statement_lines") as any)
      .upsert(
        good.map((r) => ({
          company_id: companyId,
          ledger_id: ledgerId,
          txn_date: r.date!,
          description: r.description,
          reference: r.reference,
          debit_amount: r.side === "debit" ? r.amount! : 0,
          credit_amount: r.side === "credit" ? r.amount! : 0,
          source_format: formatId,
          external_txn_id: r.externalTxnId,
        })),
        { onConflict: "company_id,ledger_id,external_txn_id", ignoreDuplicates: true }
      )
      .select("id")) as { data: { id: string }[] | null; error: { message: string } | null };

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    const imported = data?.length ?? 0;
    setImportResult({ imported, skipped: good.length - imported });
    setRawRows([]);
    setPdfFile(null);
    setPdfNote(null);
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

  // The only way back out of a match. Deliberately not behind a confirmation:
  // unmatching destroys nothing — it clears matched_entry_id/matched_at and
  // both sides return to their unmatched lists, ready to be paired correctly.
  // The dangerous direction is the other one.
  async function undoMatch(lineId: string) {
    setBusy(true);
    setError(null);
    setUnmatchedJustNow(null);
    const { error } = await createClient().rpc("unmatch_bank_line", {
      p_statement_line_id: lineId,
    });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    setUnmatchedJustNow(lineId);
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
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium">Bank format</span>
          <select
            value={formatId}
            onChange={(e) => onFormatChange(e.target.value as BankFormatId)}
            disabled={pdfBusy}
            className={field}
          >
            {BANK_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,.pdf,application/pdf"
          disabled={pdfBusy}
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          className="text-sm file:mr-3 file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm"
        />
        <button
          type="button"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([SAMPLE_CSV[formatId]], { type: "text/csv" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `lekha-bank-statement-${formatId}-sample.csv`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="text-sm text-accent underline underline-offset-4"
        >
          Download sample for this format
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

      {rawRows.length > 0 && !pdfFile && (
        <p className="mt-2 text-xs text-ink-faint">
          {detectedFormatId
            ? `Detected as ${getBankFormat(detectedFormatId).label} from the file's own column headers.`
            : "Could not confidently detect the bank format from this file's headers — check the format above is right before importing; the preview below will show wrong amounts or a wrong debit/credit side if it isn't."}
        </p>
      )}

      {pdfBusy && <p className="mt-2 text-xs text-ink-faint">Reading the PDF&apos;s text layer…</p>}

      {pdfFile && !pdfBusy && (
        <p className="mt-2 text-xs text-ink-faint">
          {pdfNote ??
            (detectedFormatId
              ? `Detected as ${getBankFormat(detectedFormatId).label} from the PDF's own column layout.`
              : `Read as ${getBankFormat(formatId).label} (your own selection above).`)}
        </p>
      )}

      {autoMatchedJustNow !== null && (
        <p className="mt-2 text-sm text-ink-soft">
          {autoMatchedJustNow === 0
            ? "Nothing unambiguous to match automatically."
            : `Matched ${autoMatchedJustNow} pair${autoMatchedJustNow === 1 ? "" : "s"} — check them under “Already matched” below and unmatch anything that is wrong.`}
        </p>
      )}

      {importResult && (
        <p className="mt-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          Imported {importResult.imported} line{importResult.imported === 1 ? "" : "s"}.
          {importResult.skipped > 0 &&
            ` Skipped ${importResult.skipped} already imported earlier (same statement re-uploaded).`}
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
            disabled={busy || pdfBusy || preview.every((r) => r.issues.length > 0)}
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
              <div key={l.id} className="border-b border-border last:border-0">
                <button
                  type="button"
                  onClick={() => setSelectedLine(selectedLine === l.id ? null : l.id)}
                  className={
                    "flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm " +
                    (selectedLine === l.id ? "bg-accent-soft" : "hover:bg-surface-2")
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
                {l.suggestion && (
                  <p className="border-t border-accent/20 bg-accent-soft/60 px-4 py-1.5 text-xs text-accent">
                    Looks like <span className="font-semibold">{l.suggestion.ledgerName}</span>&rsquo;s invoice{" "}
                    <span className="font-mono">{l.suggestion.voucherNumber}</span> ({formatINR(l.suggestion.amount)}
                    ) — post a receipt against it, then match its bank entry here. Not automatic.
                  </p>
                )}
              </div>
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

      {/* ---- already matched ------------------------------------------- */}
      {/* Everything above this point shows only what is still UNMATCHED, so
          before this section a matched line left the screen for good and a
          wrong match — one bulk auto-match away — could never be found again,
          let alone corrected. The reconciliation statement behind an audited
          balance sheet depends on these pairings being right, so they have to
          be inspectable. Shown open rather than behind a disclosure for the
          same reason, and scrollable so a long list does not bury the
          matching panes above. */}
      <section className="mt-8">
        <h2 className="mb-2 text-sm font-semibold">
          Already matched ({matchedLines.length})
        </h2>
        <p className="mb-2 max-w-3xl text-xs text-ink-faint">
          Each pair below is a statement line this ledger treats as reconciled.
          Unmatching one destroys nothing — the line and the entry simply return
          to the two lists above to be paired again.
        </p>
        <div className="max-h-[480px] overflow-y-auto rounded-lg border border-border bg-surface">
          {matchedLines.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-ink-faint">
              Nothing matched yet on this ledger.
            </p>
          )}
          {matchedLines.map((m) => (
            <div
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5 text-sm last:border-0"
            >
              <div className="min-w-0 flex-1">
                <div>
                  <span className="tabular-nums text-ink-faint font-mono">{m.txn_date}</span>{" "}
                  {m.description ?? "—"}{" "}
                  <span className="whitespace-nowrap tabular-nums font-medium font-mono">
                    {m.credit_amount > 0 ? "Cr " : "Dr "}
                    {formatINR(m.credit_amount || m.debit_amount)}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-ink-soft">
                  matched to{" "}
                  <span className="font-mono">{m.voucher_number}</span>{" "}
                  <span className="tabular-nums font-mono text-ink-faint">{m.voucher_date}</span>{" "}
                  <span className="tabular-nums font-mono">
                    {m.entry_debit > 0 ? "Dr " : "Cr "}
                    {formatINR(m.entry_debit || m.entry_credit)}
                  </span>
                  {m.narration ? ` · ${m.narration}` : ""}
                  {m.matched_at && (
                    <span className="text-ink-faint">
                      {" "}
                      · on {m.matched_at.slice(0, 10)}
                    </span>
                  )}
                </div>
                {/* delete_voucher soft-deletes, so the entry survives and the
                    pairing keeps counting as reconciled against a voucher that
                    is no longer in the books. Say so where the fix is. */}
                {m.voucher_is_deleted && (
                  <div className="mt-0.5 text-xs text-warning">
                    That voucher has since been deleted — this line is
                    reconciled against nothing. Unmatch it.
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => undoMatch(m.id)}
                className="shrink-0 rounded-lg border border-border-strong px-3 py-1.5 text-xs transition-colors hover:bg-accent-soft disabled:opacity-50"
              >
                Unmatch
              </button>
            </div>
          ))}
        </div>
        {unmatchedJustNow && (
          <p className="mt-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success">
            Unmatched. That statement line and its entry are back in the two
            lists above.
          </p>
        )}
      </section>
    </div>
  );
}
