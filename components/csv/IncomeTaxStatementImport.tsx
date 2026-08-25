"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { describeDate, inferDateOrder, type DateOrder } from "@/lib/csv/coerce";
import {
  buildStatementPreview,
  type StatementCsvRow,
  type StatementSource,
  type RowResult,
} from "@/lib/csv/income-tax-statement-import";
import { formatINR } from "@/lib/utils/currency";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { th, td, num, TableContainer } from "@/components/ui/Table";

const TEMPLATE = [
  "Deductor TAN,Deductor Name,Section,Transaction Type,Information Category,Transaction Date,Amount Paid/Credited,Tax Deducted,Tax Deposited,Status of Booking",
  "MUMA12345B,Ashoka Traders,194C,TDS,,18/06/2026,100000.00,9500.00,9500.00,F",
  "DELH99999X,Untracked Pvt Ltd,194J,TDS,,05/05/2026,20000.00,2000.00,2000.00,F",
].join("\n");

const SOURCE_LABEL: Record<StatementSource, string> = {
  "26as": "Form 26AS",
  ais: "AIS",
  tis: "TIS",
};

function currentFyLabel(): string {
  const today = new Date();
  const y = today.getFullYear();
  const startYear = today.getMonth() + 1 >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

export function IncomeTaxStatementImport({
  companyId,
  existingPeriods,
}: {
  companyId: string;
  existingPeriods: { source: string; financial_year_label: string; line_count: number; tan_count: number }[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [source, setSource] = useState<StatementSource>("26as");
  const [fyLabel, setFyLabel] = useState(currentFyLabel());

  const [fileName, setFileName] = useState<string | null>(null);
  const [rawRows, setRawRows] = useState<StatementCsvRow[]>([]);
  const [dateOrder, setDateOrder] = useState<DateOrder>("dmy");
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const inference = useMemo(
    () => (rawRows.length ? inferDateOrder(rawRows.map((r) => findCol(r, "transaction date"))) : null),
    [rawRows]
  );
  const rows: RowResult[] = useMemo(
    () => (rawRows.length ? buildStatementPreview(rawRows, source, dateOrder) : []),
    [rawRows, source, dateOrder]
  );
  const validRows = rows.filter((r) => r.data !== null);
  const invalidCount = rows.length - validRows.length;
  const noTanCount = validRows.filter((r) => !r.data!.deductor_tan).length;

  const existingForSelection = existingPeriods.find(
    (p) => p.source === source && p.financial_year_label === fyLabel
  );

  function onFile(file: File) {
    setParseError(null);
    setResult(null);
    setFileName(file.name);
    setOrderConfirmed(false);
    Papa.parse<StatementCsvRow>(file, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (out) => {
        if (!out.data.length) {
          setParseError("That file has no data rows.");
          setRawRows([]);
          return;
        }
        setRawRows(out.data);
        const inf = inferDateOrder(out.data.map((r) => findCol(r, "transaction date")));
        setDateOrder(inf.order);
        setOrderConfirmed(inf.certain);
      },
      error: (err) => setParseError(err.message),
    });
  }

  async function commit() {
    if (!validRows.length) return;
    setBusy(true);
    const { data, error } = await createClient().rpc("import_income_tax_statement_lines", {
      p_company_id: companyId,
      p_source: source,
      p_financial_year_label: fyLabel,
      p_lines: validRows.map((r) => r.data),
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setResult({ imported: (data as unknown as number) ?? validRows.length });
    router.refresh();
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "lekha-26as-ais-tis-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (result) {
    return (
      <section className="mt-8">
        <div className="rounded-lg border border-accent bg-accent-soft p-6">
          <h2 className="text-lg font-semibold">
            {result.imported} line{result.imported === 1 ? "" : "s"} uploaded for {SOURCE_LABEL[source]} · FY{" "}
            {fyLabel}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            Replaced any earlier upload for this source and year. See how it matches your TDS Receivable
            ledger on the TDS credit match report.
          </p>
        </div>
        <Button
          variant="ghost"
          className="mt-5"
          onClick={() => {
            setResult(null);
            setRawRows([]);
            setFileName(null);
            if (fileRef.current) fileRef.current.value = "";
          }}
        >
          Upload another
        </Button>
      </section>
    );
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Source</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as StatementSource)}
            className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
          >
            <option value="26as">Form 26AS</option>
            <option value="ais">AIS (TDS/TCS Information part)</option>
            <option value="tis">TIS</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Financial year</span>
          <input
            value={fyLabel}
            onChange={(e) => setFyLabel(e.target.value)}
            placeholder="2026-27"
            className="w-28 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30"
          />
        </label>
      </div>

      {existingForSelection && (
        <Alert tone="warning" className="mt-4">
          {existingForSelection.line_count} line{existingForSelection.line_count === 1 ? "" : "s"} already
          uploaded for {SOURCE_LABEL[source]} · FY {fyLabel}. Importing again replaces them — a statement
          download is a full snapshot for the year, not something to append to.
        </Alert>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          className="text-sm file:mr-3 file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm"
        />
        <button type="button" onClick={downloadTemplate} className="text-sm text-accent underline underline-offset-4">
          Download template
        </button>
      </div>
      <p className="mt-2 max-w-2xl text-xs text-ink-faint">
        Not a raw upload of the portal&rsquo;s own PDF/JSON/Excel — AIS&rsquo;s JSON download is PAN+DOB
        password protected and neither it nor 26AS publishes a confirmed byte-level field spec. Fill this
        normalized CSV from what you downloaded (26AS Part A / AIS&rsquo;s TDS-TCS Information part carry
        these same columns) — the same approach this app already uses for GSTR-2B import. TIS rows are
        category-aggregated and usually carry no deductor TAN at all, so they can be uploaded without one
        — but a TAN-less row can never enter the match against your TDS Receivable ledger, only 26AS/AIS
        rows with a TAN can. AIS&rsquo;s non-TDS/TCS categories (SFT, interest/dividend information, etc.)
        and no-fetch from the portal are also out of scope — see the match report&rsquo;s own footnote.
      </p>

      {parseError && <Alert tone="error" className="mt-4">{parseError}</Alert>}

      {inference && !inference.certain && !orderConfirmed && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning-soft p-4">
          <p className="text-sm font-medium">Which way round are these transaction dates?</p>
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
                    <span className="font-mono">{example}</span> is {describeDate(example, order)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {rows.length > 0 && (inference?.certain || orderConfirmed) && (
        <>
          <div className="mt-8 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
            <span className="font-medium">{fileName}</span>
            <span className="text-ink-soft">
              {validRows.length} line{validRows.length === 1 ? "" : "s"} ready
            </span>
            {invalidCount > 0 && (
              <span className="text-warning">
                {invalidCount} row{invalidCount === 1 ? "" : "s"} need attention
              </span>
            )}
            {noTanCount > 0 && (
              <span className="text-ink-faint">{noTanCount} row{noTanCount === 1 ? "" : "s"} with no TAN — stored, but excluded from the match</span>
            )}
          </div>

          <TableContainer className="mt-4">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr>
                  <th className={th}>Row</th>
                  <th className={th}>Deductor</th>
                  <th className={th}>TAN</th>
                  <th className={th}>Section</th>
                  <th className={th}>Date</th>
                  <th className={th + " text-right"}>Paid/Credited</th>
                  <th className={th + " text-right"}>Tax deposited</th>
                  <th className={th}>Problem</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 200).map((r) => (
                  <tr key={r.rowNumber} className={r.data ? undefined : "bg-warning-soft"}>
                    <td className={td + " font-mono text-ink-faint"}>{r.rowNumber}</td>
                    <td className={td}>{r.data?.deductor_name || r.raw["Deductor Name"] || "—"}</td>
                    <td className={td + " font-mono text-xs"}>{r.data?.deductor_tan ?? "—"}</td>
                    <td className={td}>{r.data?.section_code ?? "—"}</td>
                    <td className={td}>{r.data?.transaction_date ?? "—"}</td>
                    <td className={num}>{r.data ? formatINR(r.data.amount_paid_credited, { showZero: true }) : "—"}</td>
                    <td className={num}>{r.data ? formatINR(r.data.tax_deposited, { showZero: true }) : "—"}</td>
                    <td className={td + " text-warning"}>{r.issues.join(" ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>

          {rows.length > 200 && (
            <p className="mt-2 text-xs text-ink-faint">
              Showing the first 200 of {rows.length} rows. All are validated and all valid ones will import.
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Button busy={busy} busyLabel="Importing…" disabled={validRows.length === 0} onClick={commit}>
              Import {validRows.length} line{validRows.length === 1 ? "" : "s"} for {SOURCE_LABEL[source]} · FY{" "}
              {fyLabel}
            </Button>
            {invalidCount > 0 && (
              <span className="text-sm text-ink-soft">
                Rows with problems are skipped, not guessed at. Fix them in the file and import again.
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function findCol(row: StatementCsvRow, header: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === header) return String(v ?? "");
  }
  return "";
}
