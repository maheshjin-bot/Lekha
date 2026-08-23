"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { buildItemPreview, type ItemCsvRow, type RowResult } from "@/lib/csv/item-import";
import { formatINR } from "@/lib/utils/currency";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { th, td, num, TableContainer } from "@/components/ui/Table";

const TEMPLATE = [
  "Name,Type,HSN/SAC,Unit,Opening Qty,Opening Value,Sale Rate,Purchase Rate,GST Rate,TCS Section",
  "Steel Sheet 2mm,Goods,7208,KGS,500,150000.00,350.00,300.00,18,",
  "Consulting — Setup,Service,998311,NOS,,,25000.00,,18,",
].join("\n");

export function ItemImport({
  companyId,
  uoms,
  tcsSections,
  existingNames,
}: {
  companyId: string;
  uoms: { code: string; name: string }[];
  tcsSections: { section_code: string }[];
  existingNames: string[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [rawRows, setRawRows] = useState<ItemCsvRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ posted: number; failed: string[] } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const rows: RowResult[] = useMemo(
    () => (rawRows.length ? buildItemPreview(rawRows, { uoms, tcsSections, existingNames }) : []),
    [rawRows, uoms, tcsSections, existingNames]
  );
  const validRows = rows.filter((r) => r.data !== null);
  const invalidCount = rows.length - validRows.length;

  function onFile(file: File) {
    setParseError(null);
    setResult(null);
    setFileName(file.name);
    Papa.parse<ItemCsvRow>(file, {
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
      .from("items")
      .insert(validRows.map((r) => ({ company_id: companyId, ...r.data! })));

    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setResult({ posted: validRows.length, failed: [] });
    router.refresh();
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "lekha-items-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (result) {
    return (
      <section className="mt-8">
        <div className="rounded-lg border border-accent bg-accent-soft p-6">
          <h2 className="text-lg font-semibold">
            {result.posted} item{result.posted === 1 ? "" : "s"} created
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
              {validRows.length} item{validRows.length === 1 ? "" : "s"} ready
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
                  <th className={th}>Unit</th>
                  <th className={th + " text-right"}>Opening</th>
                  <th className={th + " text-right"}>GST</th>
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
                    <td className={td}>{r.data?.uom ?? "—"}</td>
                    <td className={num}>
                      {r.data && r.data.item_type === "goods" && r.data.opening_quantity > 0
                        ? `${r.data.opening_quantity} @ ${formatINR(r.data.opening_value / r.data.opening_quantity)}`
                        : "—"}
                    </td>
                    <td className={num}>{r.data ? `${r.data.gst_rate_percent}%` : "—"}</td>
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
              Import {validRows.length} item{validRows.length === 1 ? "" : "s"}
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
