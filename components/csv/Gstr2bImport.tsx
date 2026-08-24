"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { describeDate, inferDateOrder, type DateOrder } from "@/lib/csv/coerce";
import { buildGstr2bPreview, duplicateKey, type Gstr2bCsvRow, type RowResult } from "@/lib/csv/gstr2b-import";
import { formatINR } from "@/lib/utils/currency";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { th, td, num, TableContainer } from "@/components/ui/Table";

const TEMPLATE = [
  "Document Type,Supplier GSTIN,Supplier Name,Invoice Number,Invoice Date,Taxable Value,CGST,SGST,IGST,Cess,ITC Availability,Reason,GSTR-2B Table",
  "Invoice,27AAAAA0000A1Z5,Acme Traders,INV/2026/0451,05/05/2026,10000.00,900.00,900.00,0,0,Available,,B2B",
  "Credit Note,27AAAAA0000A1Z5,Acme Traders,CN/2026/0012,18/05/2026,2000.00,180.00,180.00,0,0,Available,,CDNR",
  "Invoice,29BBBBB1111B1Z2,Bansal & Co,B-778,10/04/2026,5000.00,0,0,450.00,0,Not Available,Recipient not eligible u/s 16(4),B2B",
].join("\n");

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

const ITC_TONE: Record<string, "ok" | "bad" | "warn" | "neutral"> = {
  available: "ok",
  not_available: "bad",
  reversal: "warn",
  rejected: "bad",
};

export function Gstr2bImport({
  companyId,
  registrations,
  existingPeriods,
}: {
  companyId: string;
  registrations: { id: string; gstin: string }[];
  existingPeriods: { return_period: string; gst_registration_id: string; gstin: string; line_count: number }[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const today = new Date();
  const defaultPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

  const [returnPeriod, setReturnPeriod] = useState(defaultPeriod);
  const [registrationId, setRegistrationId] = useState(registrations[0]?.id ?? "");

  const [fileName, setFileName] = useState<string | null>(null);
  const [rawRows, setRawRows] = useState<Gstr2bCsvRow[]>([]);
  const [dateOrder, setDateOrder] = useState<DateOrder>("dmy");
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ imported: number } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const inference = useMemo(
    () => (rawRows.length ? inferDateOrder(rawRows.map((r) => findCol(r, "invoice date"))) : null),
    [rawRows]
  );
  const rows: RowResult[] = useMemo(
    () => (rawRows.length ? buildGstr2bPreview(rawRows, dateOrder) : []),
    [rawRows, dateOrder]
  );
  const validRows = rows.filter((r) => r.data !== null);
  const invalidCount = rows.length - validRows.length;

  const seen = new Set<string>();
  const repeatedKeys = new Set<string>();
  for (const r of validRows) {
    const k = duplicateKey(r.data!);
    if (seen.has(k)) repeatedKeys.add(k);
    seen.add(k);
  }

  const existingForSelection = existingPeriods.find(
    (p) => p.return_period === returnPeriod && p.gst_registration_id === registrationId
  );

  function onFile(file: File) {
    setParseError(null);
    setResult(null);
    setFileName(file.name);
    setOrderConfirmed(false);
    Papa.parse<Gstr2bCsvRow>(file, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (out) => {
        if (!out.data.length) {
          setParseError("That file has no data rows.");
          setRawRows([]);
          return;
        }
        setRawRows(out.data);
        const inf = inferDateOrder(out.data.map((r) => findCol(r, "invoice date")));
        setDateOrder(inf.order);
        setOrderConfirmed(inf.certain);
      },
      error: (err) => setParseError(err.message),
    });
  }

  async function commit() {
    if (!validRows.length || !registrationId) return;
    setBusy(true);
    const { data, error } = await createClient().rpc("import_gstr2b_lines", {
      p_company_id: companyId,
      p_gst_registration_id: registrationId,
      p_return_period: returnPeriod,
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
    a.download = "lekha-gstr2b-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!registrations.length) {
    return (
      <Alert tone="warning" className="mt-8">
        No GST registration is set up for this company yet — add one under Registrations before
        uploading a GSTR-2B statement.
      </Alert>
    );
  }

  if (result) {
    return (
      <section className="mt-8">
        <div className="rounded-lg border border-accent bg-accent-soft p-6">
          <h2 className="text-lg font-semibold">
            {result.imported} line{result.imported === 1 ? "" : "s"} uploaded for {returnPeriod}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            Replaced any earlier upload for this registration and period. See how it matches your
            purchase register on the GSTR-2B match report.
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
          Upload another period
        </Button>
      </section>
    );
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Return period</span>
          <input
            type="month"
            value={returnPeriod}
            onChange={(e) => setReturnPeriod(e.target.value)}
            className={field}
          />
        </label>
        {registrations.length > 1 && (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">GST registration</span>
            <select value={registrationId} onChange={(e) => setRegistrationId(e.target.value)} className={field}>
              {registrations.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.gstin}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {existingForSelection && (
        <Alert tone="warning" className="mt-4">
          {existingForSelection.line_count} line{existingForSelection.line_count === 1 ? "" : "s"} already
          uploaded for {returnPeriod} against {existingForSelection.gstin}. Importing again replaces them —
          a GSTR-2B download is a full snapshot for the period, not something to append to.
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
        Not a raw upload of the GSTN portal&rsquo;s own Excel or JSON file — GSTN does not publish a
        confirmed byte-level field spec for it. Fill this normalized CSV from your downloaded GSTR-2B
        (its B2B and CDNR sheets carry these same columns) — the same approach this app already uses
        for bank statement import. ISD, import-of-goods (IMPG/IMPGSEZ) and e-commerce Sec 9(5) (ECO)
        lines aren&rsquo;t covered — LEKHA has nothing in the purchase register to match them against.
      </p>

      {parseError && <Alert tone="error" className="mt-4">{parseError}</Alert>}

      {inference && !inference.certain && !orderConfirmed && (
        <div className="mt-4 rounded-lg border border-warning/30 bg-warning-soft p-4">
          <p className="text-sm font-medium">Which way round are these invoice dates?</p>
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
          </div>

          <TableContainer className="mt-4">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr>
                  <th className={th}>Row</th>
                  <th className={th}>Type</th>
                  <th className={th}>Supplier</th>
                  <th className={th}>Invoice #</th>
                  <th className={th}>Date</th>
                  <th className={th + " text-right"}>Taxable</th>
                  <th className={th + " text-right"}>Tax</th>
                  <th className={th}>ITC</th>
                  <th className={th}>Problem</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 200).map((r) => (
                  <tr key={r.rowNumber} className={r.data ? undefined : "bg-warning-soft"}>
                    <td className={td + " font-mono text-ink-faint"}>{r.rowNumber}</td>
                    <td className={td}>
                      {r.data?.document_type === "credit_note" ? "Credit note" : r.data ? "Invoice" : "—"}
                    </td>
                    <td className={td}>
                      {r.data?.supplier_name || r.raw["Supplier Name"] || "—"}
                      <div className="font-mono text-xs text-ink-faint">{r.data?.supplier_gstin ?? ""}</div>
                    </td>
                    <td className={td}>
                      {r.data?.invoice_number ?? r.raw["Invoice Number"] ?? "—"}
                      {r.data && repeatedKeys.has(duplicateKey(r.data)) && (
                        <Badge tone="warn" className="ml-2">Repeated</Badge>
                      )}
                    </td>
                    <td className={td}>{r.data?.invoice_date ?? "—"}</td>
                    <td className={num}>{r.data ? formatINR(r.data.taxable_value, { showZero: true }) : "—"}</td>
                    <td className={num}>
                      {r.data ? formatINR(r.data.cgst + r.data.sgst + r.data.igst + r.data.cess, { showZero: true }) : "—"}
                    </td>
                    <td className={td}>
                      {r.data && (
                        <Badge tone={ITC_TONE[r.data.itc_availability]}>
                          {r.data.itc_availability.replace("_", " ")}
                        </Badge>
                      )}
                    </td>
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
              Import {validRows.length} line{validRows.length === 1 ? "" : "s"} for {returnPeriod}
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

function findCol(row: Gstr2bCsvRow, header: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === header) return String(v ?? "");
  }
  return "";
}
