"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { createClient } from "@/lib/supabase/client";
import { describeDate, inferDateOrder, type DateOrder } from "@/lib/csv/coerce";
import {
  buildInvoicePreview,
  toInvoiceBulkPayload,
  type ImportPreview,
  type InvoiceCsvRow,
  type Item,
  type Ledger,
} from "@/lib/csv/invoice-import";
import { formatINR } from "@/lib/utils/currency";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { th, td, num, TableContainer } from "@/components/ui/Table";

type Branch = { id: string; code: string; name: string };
type Godown = { id: string; code: string; name: string };

const TEMPLATE = [
  "Invoice Ref,Date,Type,Party,Trading Ledger,Item,Quantity,Rate,Description,Reference,Place of Supply",
  "INV-001,01/04/2026,Sales,Acme Traders,,Steel Sheet 2mm,10,350.00,,PO-9981,27",
  "INV-001,01/04/2026,Sales,Acme Traders,,Consulting — Setup,1,25000.00,,PO-9981,27",
].join("\n");

export function InvoiceImport({
  companyId,
  items,
  ledgers,
  branches,
  godowns,
  lockDate,
}: {
  companyId: string;
  items: Item[];
  ledgers: Ledger[];
  branches: Branch[];
  godowns: Godown[];
  lockDate: string | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [rawRows, setRawRows] = useState<InvoiceCsvRow[]>([]);
  const [dateOrder, setDateOrder] = useState<DateOrder>("dmy");
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [godownId, setGodownId] = useState(godowns[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ posted: number; failed: { key: string; message: string }[] } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const inference = useMemo(
    () => (rawRows.length ? inferDateOrder(rawRows.map((r) => findDate(r))) : null),
    [rawRows]
  );

  const preview: ImportPreview | null = useMemo(() => {
    if (!rawRows.length) return null;
    return buildInvoicePreview(rawRows, { items, ledgers, dateOrder, lockDate, branchId, godownId: godownId || null });
  }, [rawRows, items, ledgers, dateOrder, lockDate, branchId, godownId]);

  function onFile(file: File) {
    setParseError(null);
    setResult(null);
    setOrderConfirmed(false);
    setFileName(file.name);
    Papa.parse<InvoiceCsvRow>(file, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (out) => {
        if (!out.data.length) {
          setParseError("That file has no data rows.");
          setRawRows([]);
          return;
        }
        setRawRows(out.data);
        const inf = inferDateOrder(out.data.map((r) => findDate(r)));
        setDateOrder(inf.order);
        setOrderConfirmed(inf.certain);
      },
      error: (err) => setParseError(err.message),
    });
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    const payload = toInvoiceBulkPayload(preview, { items, ledgers, dateOrder, lockDate, branchId, godownId: godownId || null });

    const { data, error } = await createClient().rpc("create_invoices_bulk", {
      p_company_id: companyId,
      p_groups: payload,
    });

    if (error) {
      setParseError(error.message);
      setBusy(false);
      return;
    }

    const rows = (data ?? []) as { group_key: string; voucher_id: string | null; error_message: string | null }[];
    setResult({
      posted: rows.filter((r) => r.voucher_id).length,
      failed: rows.filter((r) => !r.voucher_id).map((r) => ({ key: r.group_key, message: r.error_message ?? "Unknown error" })),
    });
    setBusy(false);
    router.refresh();
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "lekha-sales-purchase-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  if (result) {
    return (
      <section className="mt-8">
        <div className={"rounded-lg border p-6 " + (result.failed.length ? "border-warning/30 bg-warning-soft" : "border-accent bg-accent-soft")}>
          <h2 className="text-lg font-semibold">
            {result.posted} invoice{result.posted === 1 ? "" : "s"} posted
            {result.failed.length > 0 && `, ${result.failed.length} failed`}
          </h2>
          {result.failed.length > 0 && (
            <>
              <p className="mt-2 text-sm">
                The rest were written. Each failure below rolled back on its own, so nothing is half-posted.
              </p>
              <ul className="mt-3 space-y-1 text-sm">
                {result.failed.map((f) => (
                  <li key={f.key}>
                    <span className="font-mono">{f.key}</span> — {f.message}
                  </li>
                ))}
              </ul>
            </>
          )}
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
          Import another file
        </Button>
      </section>
    );
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center gap-3">
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
        {branches.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="font-medium">Branch</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.code} — {b.name}</option>
              ))}
            </select>
          </label>
        )}
        {godowns.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="font-medium">Godown</span>
            <select value={godownId} onChange={(e) => setGodownId(e.target.value)} className={field}>
              {godowns.map((g) => (
                <option key={g.id} value={g.id}>{g.code} — {g.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {parseError && <Alert tone="error" className="mt-4">{parseError}</Alert>}

      {inference && !inference.certain && !orderConfirmed && (
        <div className="mt-6 rounded-lg border border-warning/30 bg-warning-soft p-5">
          <h2 className="font-semibold">Which way round are these dates?</h2>
          <p className="mt-1.5 text-sm">
            {inference.reason} Getting this wrong shifts every date by months without anything looking broken, so it is worth a moment.
          </p>
          {inference.example !== null && ((example: string) => (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {(["dmy", "mdy"] as const).map((order) => (
                <button
                  key={order}
                  type="button"
                  onClick={() => {
                    setDateOrder(order);
                    setOrderConfirmed(true);
                  }}
                  className="rounded-md border border-border-strong bg-surface p-3 text-left text-sm transition hover:border-accent"
                >
                  <span className="block font-medium">{order === "dmy" ? "Day first" : "Month first"}</span>
                  <span className="mt-0.5 block text-xs text-ink-soft">
                    <span className="font-mono">{example}</span> reads as <strong>{describeDate(example, order)}</strong>
                  </span>
                </button>
              ))}
            </div>
          ))(inference.example)}
        </div>
      )}

      {preview && (inference?.certain || orderConfirmed) && (
        <>
          <div className="mt-8 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
            <span className="font-medium">{fileName}</span>
            <span className="text-ink-soft">
              {preview.validGroupCount} invoice{preview.validGroupCount === 1 ? "" : "s"} ready
            </span>
            {preview.invalidRowCount > 0 && (
              <span className="text-warning">
                {preview.invalidRowCount} row{preview.invalidRowCount === 1 ? "" : "s"} need attention
              </span>
            )}
            <span className="text-ink-faint">
              dates read {dateOrder === "dmy" ? "day first" : "month first"}
              {!inference?.certain && (
                <button type="button" onClick={() => setOrderConfirmed(false)} className="ml-2 underline underline-offset-4">
                  change
                </button>
              )}
            </span>
          </div>

          {preview.groupIssues.length > 0 && (
            <div className="mt-4 rounded-lg border border-warning/30 bg-warning-soft p-4">
              <h3 className="text-sm font-semibold">Invoice-level problems</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {preview.groupIssues.map((g, i) => (
                  <li key={i}>
                    <span className="font-mono">{g.groupId}</span> (rows {g.rowNumbers.join(", ")}) — {g.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <TableContainer className="mt-4">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr>
                  <th className={th}>Row</th>
                  <th className={th}>Ref</th>
                  <th className={th}>Date</th>
                  <th className={th}>Party</th>
                  <th className={th}>Item</th>
                  <th className={th + " text-right"}>Qty</th>
                  <th className={th + " text-right"}>Rate</th>
                  <th className={th + " text-right"}>Amount</th>
                  <th className={th}>Problem</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 200).map((r) => (
                  <tr key={r.rowNumber} className={r.data ? undefined : "bg-warning-soft"}>
                    <td className={td + " font-mono text-ink-faint"}>{r.rowNumber}</td>
                    <td className={td + " font-mono text-xs"}>{r.data?.groupId ?? "—"}</td>
                    <td className={td + " font-mono tabular-nums"}>{r.data?.date ?? "—"}</td>
                    <td className={td}>{r.data ? ledgers.find((l) => l.id === r.data!.partyLedgerId)?.name : "—"}</td>
                    <td className={td}>{r.data ? items.find((i) => i.id === r.data!.itemId)?.name : "—"}</td>
                    <td className={num}>{r.data?.quantity ?? "—"}</td>
                    <td className={num}>{r.data ? formatINR(r.data.rate) : "—"}</td>
                    <td className={num}>{r.data ? formatINR(r.data.quantity * r.data.rate) : "—"}</td>
                    <td className={td + " text-warning"}>
                      {r.issues.map((iss, i) => (
                        <div key={i}>
                          {iss.field && <span className="font-medium">{iss.field}: </span>}
                          {iss.message}
                          {iss.suggestion && <span className="text-ink-soft"> Try: {iss.suggestion}</span>}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>

          {preview.rows.length > 200 && (
            <p className="mt-2 text-xs text-ink-faint">
              Showing the first 200 of {preview.rows.length} rows. All are validated and all valid ones will import.
            </p>
          )}

          <p className="mt-3 text-xs text-ink-faint">
            GST and TCS are computed the same way they are for an invoice typed into the form — not shown here in
            the preview, only after import.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Button busy={busy} busyLabel="Importing…" disabled={preview.validGroupCount === 0} onClick={commit}>
              Import {preview.validGroupCount} invoice{preview.validGroupCount === 1 ? "" : "s"}
            </Button>
            {preview.invalidRowCount > 0 && (
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

function findDate(row: InvoiceCsvRow): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === "date") return String(v ?? "");
  }
  return "";
}
