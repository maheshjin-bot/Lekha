"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { buildLedgerPreview, type LedgerCsvRow, type RowResult } from "@/lib/csv/ledger-import";
import { formatINR } from "@/lib/utils/currency";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { th, td, num, TableContainer } from "@/components/ui/Table";

const TEMPLATE = [
  "Name,Group,Opening Balance,Dr/Cr,PAN,TDS Deductee,TDS Section,Udyam Number,MSME Category,MSME Payment Days",
  "Acme Traders,Sundry Debtors,25000.00,Dr,,,,,,",
  "Bansal Professional Services,Sundry Creditors,0,Cr,AAAAA0000A,Y,194J,,,",
].join("\n");

export function LedgerImport({
  companyId,
  groups,
  tdsSections,
  existingNames,
}: {
  companyId: string;
  groups: { id: string; name: string; parent_group_id: string | null }[];
  tdsSections: { section_code: string }[];
  existingNames: string[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [rawRows, setRawRows] = useState<LedgerCsvRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ posted: number } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const rows: RowResult[] = useMemo(
    () => (rawRows.length ? buildLedgerPreview(rawRows, { groups, tdsSections, existingNames }) : []),
    [rawRows, groups, tdsSections, existingNames]
  );
  const validRows = rows.filter((r) => r.data !== null);
  const invalidCount = rows.length - validRows.length;

  function onFile(file: File) {
    setParseError(null);
    setResult(null);
    setFileName(file.name);
    Papa.parse<LedgerCsvRow>(file, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (out) => {
        if (!out.data.length) {
          setParseError("That file has no data rows.");
          setRawRows([]);
          return;
        }
        setRawRows(out.data);
      },
      error: (err) => setParseError(err.message),
    });
  }

  async function commit() {
    if (!validRows.length) return;
    setBusy(true);
    const { error } = await createClient()
      .from("ledgers")
      .insert(validRows.map((r) => ({ company_id: companyId, ...r.data! })));

    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setResult({ posted: validRows.length });
    router.refresh();
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "lekha-ledgers-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (result) {
    return (
      <section className="mt-8">
        <div className="rounded-lg border border-accent bg-accent-soft p-6">
          <h2 className="text-lg font-semibold">
            {result.posted} ledger{result.posted === 1 ? "" : "s"} created
          </h2>
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
      </div>

      {parseError && <Alert tone="error" className="mt-4">{parseError}</Alert>}

      {rows.length > 0 && (
        <>
          <div className="mt-8 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
            <span className="font-medium">{fileName}</span>
            <span className="text-ink-soft">
              {validRows.length} ledger{validRows.length === 1 ? "" : "s"} ready
            </span>
            {invalidCount > 0 && (
              <span className="text-warning">
                {invalidCount} row{invalidCount === 1 ? "" : "s"} need attention
              </span>
            )}
          </div>

          <TableContainer className="mt-4">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr>
                  <th className={th}>Row</th>
                  <th className={th}>Name</th>
                  <th className={th}>Group</th>
                  <th className={th + " text-right"}>Opening</th>
                  <th className={th}>Problem</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 200).map((r) => (
                  <tr key={r.rowNumber} className={r.data ? undefined : "bg-warning-soft"}>
                    <td className={td + " font-mono text-ink-faint"}>{r.rowNumber}</td>
                    <td className={td}>
                      {r.data?.name ?? r.raw["Name"] ?? "—"}
                      {r.possibleDuplicate && (
                        <Badge tone="warn" className="ml-2">
                          Duplicate name
                        </Badge>
                      )}
                    </td>
                    <td className={td}>{groups.find((g) => g.id === r.data?.group_id)?.name ?? "—"}</td>
                    <td className={num}>
                      {r.data && r.data.opening_balance_amount > 0
                        ? `${formatINR(r.data.opening_balance_amount)} ${r.data.opening_balance_type === "debit" ? "Dr" : "Cr"}`
                        : "—"}
                    </td>
                    <td className={td + " text-warning"}>
                      {r.issues.map((iss, i) => (
                        <div key={i}>
                          {iss.field && <span className="font-medium">{iss.field}: </span>}
                          {iss.message}
                          {iss.suggestion && (
                            <span className="text-ink-soft"> Try: {iss.suggestion}</span>
                          )}
                        </div>
                      ))}
                    </td>
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
              Import {validRows.length} ledger{validRows.length === 1 ? "" : "s"}
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
