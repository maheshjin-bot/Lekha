"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { createClient } from "@/lib/supabase/client";
import { describeDate, inferDateOrder, type DateOrder } from "@/lib/csv/coerce";
import {
  buildPreview,
  toBulkPayload,
  type ImportPreview,
  type VoucherCsvRow,
} from "@/lib/csv/voucher-import";
import { formatINR } from "@/lib/utils/currency";

type Ledger = { id: string; name: string };
type Branch = { id: string; code: string; name: string };

const TEMPLATE = [
  "Voucher Ref,Date,Voucher Type,Ledger,Dr/Cr,Amount,Narration,Reference",
  "PAY-001,01/04/2026,Payment,Office Rent,Dr,25000.00,April rent,",
  "PAY-001,01/04/2026,Payment,Bank Account,Cr,25000.00,April rent,",
  "PUR-001,03/04/2026,Purchase,Purchases,Dr,1;00;000.00,Steel sheets,INV-8891".replace(/;/g, ","),
].join("\n");

export function VoucherImport({
  companyId,
  ledgers,
  branches,
  lockDate,
}: {
  companyId: string;
  ledgers: Ledger[];
  branches: Branch[];
  lockDate: string | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [rawRows, setRawRows] = useState<VoucherCsvRow[]>([]);
  const [dateOrder, setDateOrder] = useState<DateOrder>("dmy");
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ posted: number; failed: { key: string; message: string }[] } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const inference = useMemo(
    () => (rawRows.length ? inferDateOrder(rawRows.map((r) => findDate(r))) : null),
    [rawRows]
  );

  const preview: ImportPreview | null = useMemo(() => {
    if (!rawRows.length) return null;
    return buildPreview(rawRows, { ledgers, dateOrder, lockDate, branchId });
  }, [rawRows, ledgers, dateOrder, lockDate, branchId]);

  function onFile(file: File) {
    setParseError(null);
    setResult(null);
    setOrderConfirmed(false);
    setFileName(file.name);

    Papa.parse<VoucherCsvRow>(file, {
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
        // Only skip the prompt when the file itself settles the question.
        setOrderConfirmed(inf.certain);
      },
      error: (err) => setParseError(err.message),
    });
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    const payload = toBulkPayload(preview, branchId);

    const { data, error } = await createClient().rpc("create_vouchers_bulk", {
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
      failed: rows
        .filter((r) => !r.voucher_id)
        .map((r) => ({ key: r.group_key, message: r.error_message ?? "Unknown error" })),
    });
    setBusy(false);
    router.refresh();
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "lekha-voucher-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  // ---- result -------------------------------------------------------------
  if (result) {
    return (
      <section className="mt-8">
        <div
          className={
            "rounded-lg border p-6 " +
            (result.failed.length
              ? "border-warning/30 bg-warning-soft"
              : "border-accent bg-accent-soft")
          }
        >
          <h2 className="text-lg font-semibold">
            {result.posted} voucher{result.posted === 1 ? "" : "s"} posted
            {result.failed.length > 0 && `, ${result.failed.length} failed`}
          </h2>
          {result.failed.length > 0 && (
            <>
              <p className="mt-2 text-sm">
                The rest were written. Each failure below rolled back on its own,
                so nothing is half-posted.
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
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setRawRows([]);
            setFileName(null);
            if (fileRef.current) fileRef.current.value = "";
          }}
          className="mt-5 rounded-lg border border-border-strong px-3 py-1.5 text-sm transition-colors hover:bg-accent-soft"
        >
          Import another file
        </button>
      </section>
    );
  }

  return (
    <section className="mt-8">
      {/* ---- file ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          className="text-sm file:mr-3 file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm"
        />
        <button
          type="button"
          onClick={downloadTemplate}
          className="text-sm text-accent underline underline-offset-4"
        >
          Download template
        </button>
        {branches.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="font-medium">Branch</span>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {parseError && (
        <p className="mt-4 rounded-md bg-error-soft px-3 py-2 text-sm text-error">
          {parseError}
        </p>
      )}

      {/* ---- date order ----------------------------------------------------- */}
      {inference && !inference.certain && !orderConfirmed && (
        <div className="mt-6 rounded-lg border border-warning/30 bg-warning-soft p-5">
          <h2 className="font-semibold">Which way round are these dates?</h2>
          <p className="mt-1.5 text-sm">
            {inference.reason} Getting this wrong shifts every date by months
            without anything looking broken, so it is worth a moment.
          </p>
          {/* Bound outside the callback: narrowing on inference.example does
              not survive into the closure below. */}
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
                  <span className="block font-medium">
                    {order === "dmy" ? "Day first" : "Month first"}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-soft">
                    <span className="font-mono">{example}</span> reads as{" "}
                    <strong>{describeDate(example, order)}</strong>
                  </span>
                </button>
              ))}
            </div>
          ))(inference.example)}
        </div>
      )}

      {/* ---- preview -------------------------------------------------------- */}
      {preview && (inference?.certain || orderConfirmed) && (
        <>
          <div className="mt-8 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
            <span className="font-medium">{fileName}</span>
            <span className="text-ink-soft">
              {preview.validGroupCount} voucher
              {preview.validGroupCount === 1 ? "" : "s"} ready
            </span>
            {preview.invalidRowCount > 0 && (
              <span className="text-warning">
                {preview.invalidRowCount} row
                {preview.invalidRowCount === 1 ? "" : "s"} need attention
              </span>
            )}
            <span className="text-ink-faint">
              dates read {dateOrder === "dmy" ? "day first" : "month first"}
              {!inference?.certain && (
                <button
                  type="button"
                  onClick={() => setOrderConfirmed(false)}
                  className="ml-2 underline underline-offset-4"
                >
                  change
                </button>
              )}
            </span>
          </div>

          {preview.groupIssues.length > 0 && (
            <div className="mt-4 rounded-lg border border-warning/30 bg-warning-soft p-4">
              <h3 className="text-sm font-semibold">Voucher-level problems</h3>
              <ul className="mt-2 space-y-1 text-sm">
                {preview.groupIssues.map((g, i) => (
                  <li key={i}>
                    <span className="font-mono">{g.groupId}</span> (rows{" "}
                    {g.rowNumbers.join(", ")}) — {g.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-3 py-2.5 font-medium">Row</th>
                  <th className="px-3 py-2.5 font-medium">Ref</th>
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">Ledger</th>
                  <th className="px-3 py-2.5 font-medium">Dr/Cr</th>
                  <th className="px-3 py-2.5 text-right font-medium">Amount</th>
                  <th className="px-3 py-2.5 font-medium">Problem</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 200).map((r) => (
                  <tr
                    key={r.rowNumber}
                    className={
                      "border-b border-border last:border-0  " +
                      (r.data ? "" : "bg-warning-soft")
                    }
                  >
                    <td className="px-3 py-2 tabular-nums text-ink-faint font-mono">{r.rowNumber}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.data?.groupId ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums font-mono">{r.data?.date ?? "—"}</td>
                    <td className="px-3 py-2">
                      {r.data
                        ? ledgers.find((l) => l.id === r.data!.ledgerId)?.name
                        : "—"}
                    </td>
                    <td className="px-3 py-2 uppercase">{r.data?.side ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-mono">
                      {r.data ? formatINR(r.data.amount) : "—"}
                    </td>
                    <td className="px-3 py-2 text-warning">
                      {r.issues.map((iss, i) => (
                        <div key={i}>
                          {iss.field && <span className="font-medium">{iss.field}: </span>}
                          {iss.message}
                          {iss.suggestion && (
                            <span className="text-ink-soft">
                              {" "}Did you mean <strong>{iss.suggestion}</strong>?
                            </span>
                          )}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.rows.length > 200 && (
            <p className="mt-2 text-xs text-ink-faint">
              Showing the first 200 of {preview.rows.length} rows. All of them
              are validated and all valid ones will be imported.
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={commit}
              disabled={busy || preview.validGroupCount === 0}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {busy
                ? "Importing…"
                : `Import ${preview.validGroupCount} voucher${preview.validGroupCount === 1 ? "" : "s"}`}
            </button>
            {preview.invalidRowCount > 0 && (
              <span className="text-sm text-ink-soft">
                Rows with problems are skipped, not guessed at. Fix them in the
                file and import again.
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** The Date column, whatever case or spacing the export used. */
function findDate(row: VoucherCsvRow): string {
  for (const [k, v] of Object.entries(row)) {
    if (k.trim().toLowerCase() === "date") return String(v ?? "");
  }
  return "";
}
