"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { normalizeName } from "@/lib/csv/normalize";
import { parseTallyXml, type TallyParseResult } from "@/lib/tally/parse";
import {
  buildGroupPreview,
  buildLedgerPreview,
  buildVoucherPreview,
  groupKeyIndexFromExisting,
  type ExistingGroup,
  type GroupPreviewRow,
  type LedgerPreviewRow,
  type VoucherPreviewRow,
} from "@/lib/tally/import";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody } from "@/components/ui/Card";
import { th, td, TableContainer } from "@/components/ui/Table";
import { formatINR } from "@/lib/utils/currency";

type NotImported = { kind: "group" | "ledger" | "voucher"; label: string; reason: string };
type CommitResult = {
  groupsCreated: number;
  groupsAlready: number;
  ledgersCreated: number;
  vouchersCreated: number;
  notImported: NotImported[];
};

export function TallyImportPanel({
  companyId,
  existingGroups,
  existingLedgers,
  refStates,
  branches,
  lockDate,
}: {
  companyId: string;
  existingGroups: ExistingGroup[];
  existingLedgers: { id: string; name: string }[];
  refStates: { code: string; name: string }[];
  branches: { id: string; code: string; name: string }[];
  lockDate: string | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<TallyParseResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);

  const groupRows: GroupPreviewRow[] = useMemo(
    () => (parsed ? buildGroupPreview(parsed.groups, existingGroups) : []),
    [parsed, existingGroups]
  );

  // Display-only: pending (not-yet-inserted) custom groups get a placeholder
  // id here purely so the ledger preview below can show "this will resolve"
  // — commitAll() below recomputes ledger rows for real, against the actual
  // ids returned once groups are actually inserted.
  const previewGroupIdByKey = useMemo(() => {
    const m = groupKeyIndexFromExisting(existingGroups);
    for (const row of groupRows) {
      if (row.resolved && row.key) {
        m.set(row.key, row.resolved.kind === "exists" ? row.resolved.id : `PENDING:${row.key}`);
      }
    }
    return m;
  }, [groupRows, existingGroups]);

  const ledgerRows: LedgerPreviewRow[] = useMemo(
    () =>
      parsed
        ? buildLedgerPreview(parsed.ledgers, {
            groupIdByKey: previewGroupIdByKey,
            existingLedgerNames: existingLedgers.map((l) => l.name),
            refStates,
          })
        : [],
    [parsed, previewGroupIdByKey, existingLedgers, refStates]
  );

  const previewLedgerIdByName = useMemo(() => {
    const m = new Map(existingLedgers.map((l) => [normalizeName(l.name), l.id]));
    for (const row of ledgerRows) {
      if (row.data) m.set(normalizeName(row.data.name), `PENDING:${normalizeName(row.data.name)}`);
    }
    return m;
  }, [ledgerRows, existingLedgers]);

  const voucherRows: VoucherPreviewRow[] = useMemo(
    () =>
      parsed
        ? buildVoucherPreview(parsed.vouchers, {
            ledgerIdByName: previewLedgerIdByName,
            lockDate,
            branchId: branchId || "PENDING",
          })
        : [],
    [parsed, previewLedgerIdByName, lockDate, branchId]
  );

  const validGroups = groupRows.filter((r) => r.resolved?.kind === "create");
  const alreadyGroups = groupRows.filter((r) => r.resolved?.kind === "exists");
  const invalidGroups = groupRows.filter((r) => !r.resolved);
  const validLedgers = ledgerRows.filter((r) => r.data);
  const invalidLedgers = ledgerRows.filter((r) => !r.data);
  const validVouchers = voucherRows.filter((r) => r.data);
  const invalidVouchers = voucherRows.filter((r) => !r.data);

  function onFile(file: File) {
    setParseError(null);
    setResult(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const out = parseTallyXml(text);
      if (out.fatalError) {
        setParseError(out.fatalError);
        setParsed(null);
        return;
      }
      setParsed(out);
    };
    reader.onerror = () => setParseError("Could not read that file.");
    reader.readAsText(file);
  }

  async function commitAll() {
    if (!parsed) return;
    setBusy(true);
    const supabase = createClient();
    const notImported: NotImported[] = [];

    for (const r of invalidGroups) {
      notImported.push({ kind: "group", label: r.name ?? `(unnamed, item ${r.sourceIndex + 1})`, reason: r.issues.join(" ") });
    }
    for (const r of invalidLedgers) {
      notImported.push({ kind: "ledger", label: r.name ?? `(unnamed, item ${r.sourceIndex + 1})`, reason: r.issues.join(" ") });
    }

    // ---- groups, in dependency order ----------------------------------
    // groupKeyIndexFromExisting already seeds every already-exists group's
    // real id (that's exactly how buildGroupPreview found them), so nothing
    // further is needed to account for alreadyGroups here.
    const realGroupIdByKey = groupKeyIndexFromExisting(existingGroups);
    let groupsCreated = 0;
    const toCreate = [...validGroups].sort((a, b) => (a.commitOrder ?? 0) - (b.commitOrder ?? 0));
    for (const r of toCreate) {
      const resolved = r.resolved!;
      if (resolved.kind !== "create") continue;
      const parentId =
        resolved.parent.type === "existing" ? resolved.parent.id : realGroupIdByKey.get(resolved.parent.key);
      if (!parentId) {
        notImported.push({ kind: "group", label: r.name!, reason: "Its parent group failed to import, so this one was skipped too." });
        continue;
      }
      const { data, error } = await supabase
        .from("account_groups")
        .insert({
          company_id: companyId,
          parent_group_id: parentId,
          name: r.name!,
          nature: "current_asset", // overwritten by the DB trigger from the real parent's nature
          normal_balance: resolved.normalBalance,
        })
        .select("id")
        .single();
      if (error || !data) {
        notImported.push({ kind: "group", label: r.name!, reason: error?.message ?? "Unknown database error." });
        continue;
      }
      realGroupIdByKey.set(r.key!, data.id);
      groupsCreated++;
    }

    // ---- ledgers, against the real group ids ---------------------------
    const realLedgerRows = buildLedgerPreview(parsed.ledgers, {
      groupIdByKey: realGroupIdByKey,
      existingLedgerNames: existingLedgers.map((l) => l.name),
      refStates,
    });
    let ledgersCreated = 0;
    const alreadyReportedLedgers = new Set(invalidLedgers.map((r) => r.sourceIndex));
    const ledgerIdByName = new Map(existingLedgers.map((l) => [normalizeName(l.name), l.id]));
    for (const r of realLedgerRows) {
      if (!r.data) {
        // Valid in the initial preview (its group was still only "pending
        // create" then) but that parent group failed to actually insert —
        // report it now rather than silently dropping it, since the
        // preview-pass loop above never saw this failure coming.
        if (!alreadyReportedLedgers.has(r.sourceIndex)) {
          notImported.push({ kind: "ledger", label: r.name ?? `(unnamed, item ${r.sourceIndex + 1})`, reason: r.issues.join(" ") });
        }
        continue;
      }
      const { data, error } = await supabase
        .from("ledgers")
        .insert({ company_id: companyId, ...r.data })
        .select("id")
        .single();
      if (error || !data) {
        notImported.push({ kind: "ledger", label: r.data.name, reason: error?.message ?? "Unknown database error." });
        continue;
      }
      ledgerIdByName.set(normalizeName(r.data.name), data.id);
      ledgersCreated++;
    }

    // ---- vouchers, against the real ledger ids --------------------------
    let vouchersCreated = 0;
    if (parsed.vouchers.length > 0) {
      const realVoucherRows = buildVoucherPreview(parsed.vouchers, {
        ledgerIdByName,
        lockDate,
        branchId,
      });
      for (const r of realVoucherRows) {
        if (!r.data) {
          notImported.push({
            kind: "voucher",
            label: r.voucherNumber ?? `(item ${r.sourceIndex + 1})`,
            reason: r.issues.join(" "),
          });
        }
      }
      const payloads = realVoucherRows.filter((r) => r.data).map((r) => r.data!);
      if (payloads.length > 0) {
        const { data, error } = await supabase.rpc("create_vouchers_bulk", {
          p_company_id: companyId,
          p_groups: payloads,
        });
        if (error) {
          for (const p of payloads) {
            notImported.push({ kind: "voucher", label: p.reference_number ?? p.group_key, reason: error.message });
          }
        } else {
          const rows = (data ?? []) as { group_key: string; voucher_id: string | null; error_message: string | null }[];
          for (const row of rows) {
            if (row.voucher_id) vouchersCreated++;
            else notImported.push({ kind: "voucher", label: row.group_key, reason: row.error_message ?? "Unknown error." });
          }
        }
      }
    }

    setBusy(false);
    setResult({ groupsCreated, groupsAlready: alreadyGroups.length, ledgersCreated, vouchersCreated, notImported });
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  if (result) {
    const totalCreated = result.groupsCreated + result.ledgersCreated + result.vouchersCreated;
    return (
      <section className="mt-8">
        <div
          className={
            "rounded-lg border p-6 " +
            (result.notImported.length ? "border-warning/30 bg-warning-soft" : "border-accent bg-accent-soft")
          }
        >
          <h2 className="text-lg font-semibold">
            {result.groupsCreated} group{result.groupsCreated === 1 ? "" : "s"}
            {result.groupsAlready > 0 && ` (${result.groupsAlready} already existed, left alone)`}, {result.ledgersCreated} ledger
            {result.ledgersCreated === 1 ? "" : "s"}
            {result.vouchersCreated > 0 && `, ${result.vouchersCreated} voucher${result.vouchersCreated === 1 ? "" : "s"}`} imported
            {result.notImported.length > 0 && `, ${result.notImported.length} record${result.notImported.length === 1 ? "" : "s"} could not be imported`}
          </h2>
          {totalCreated === 0 && result.notImported.length === 0 && (
            <p className="mt-2 text-sm">Nothing in this file needed importing — everything already matched what&rsquo;s in LEKHA.</p>
          )}
          {result.notImported.length > 0 && (
            <>
              <p className="mt-2 text-sm">Every record that didn&rsquo;t import is listed below with the reason — nothing was silently dropped.</p>
              <ul className="mt-3 max-h-96 space-y-1.5 overflow-y-auto text-sm">
                {result.notImported.map((n, i) => (
                  <li key={i}>
                    <Badge tone="neutral" className="mr-1.5">{n.kind}</Badge>
                    <span className="font-medium">{n.label}</span> — {n.reason}
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
            setParsed(null);
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
      <Card>
        <CardBody className="flex flex-col gap-2 text-sm text-ink-soft">
          <p>
            In TallyPrime: open Chart of Accounts (for masters) or Day Book (for vouchers), press{" "}
            <strong>Alt+E</strong> (Export), set the format to <strong>XML</strong>, and export masters
            before vouchers — a voucher import is meaningless without the ledgers it references already
            existing.
          </p>
          <p>
            This importer covers <strong>groups and ledgers</strong> (the chart of accounts) plus the four
            plain accounting voucher types — <strong>Receipt, Payment, Contra, Journal</strong>. Sales,
            Purchase, Credit Note and Debit Note vouchers are not attempted here: they need item-level
            HSN/rate mapping from Tally&rsquo;s own stock item master, which is a separate, bigger problem.
            Use the item-level Sales &amp; Purchase importer on the other tab for those.
          </p>
        </CardBody>
      </Card>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".xml,text/xml,application/xml"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          className="text-sm file:mr-3 file:rounded-lg file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm"
        />
      </div>

      {parseError && <Alert tone="error" className="mt-4">{parseError}</Alert>}

      {parsed && (
        <>
          {parsed.notes.length > 0 && (
            <Alert tone="warning" className="mt-4">
              {parsed.notes.join(" ")}
            </Alert>
          )}

          <div className="mt-6 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
            <span className="font-medium">{fileName}</span>
            <span className="text-ink-soft">
              {parsed.groups.length} group{parsed.groups.length === 1 ? "" : "s"}, {parsed.ledgers.length} ledger
              {parsed.ledgers.length === 1 ? "" : "s"}, {parsed.vouchers.length} voucher{parsed.vouchers.length === 1 ? "" : "s"} found
            </span>
          </div>

          {parsed.vouchers.length > 0 && branches.length > 1 && (
            <label className="mt-4 flex items-center gap-2 text-sm">
              <span className="font-medium">Branch (for imported vouchers)</span>
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={field}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {parsed.groups.length > 0 && (
            <PreviewSection
              title="Groups"
              readyLabel={`${validGroups.length} to create, ${alreadyGroups.length} already exist`}
              problemCount={invalidGroups.length}
              rows={groupRows.map((r) => ({
                key: r.sourceIndex,
                name: r.name,
                sub: r.parentNameRaw,
                status: r.resolved
                  ? r.resolved.kind === "exists"
                    ? { tone: "neutral" as const, text: "Already exists" }
                    : { tone: "ok" as const, text: "Will create" }
                  : { tone: "bad" as const, text: r.issues.join(" ") },
              }))}
            />
          )}

          {parsed.ledgers.length > 0 && (
            <PreviewSection
              title="Ledgers"
              readyLabel={`${validLedgers.length} ready`}
              problemCount={invalidLedgers.length}
              rows={ledgerRows.map((r) => ({
                key: r.sourceIndex,
                name: r.name,
                sub: r.data
                  ? [
                      r.parentNameRaw,
                      r.data.opening_balance_amount > 0
                        ? `${formatINR(r.data.opening_balance_amount)} ${r.data.opening_balance_type === "debit" ? "Dr" : "Cr"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : r.parentNameRaw,
                status: r.data
                  ? {
                      tone: "ok" as const,
                      text: ["Ready", r.possibleDuplicate ? "possible duplicate name" : null, ...r.notes]
                        .filter(Boolean)
                        .join(" — "),
                    }
                  : { tone: "bad" as const, text: r.issues.join(" ") },
              }))}
            />
          )}

          {parsed.vouchers.length > 0 && (
            <PreviewSection
              title="Vouchers"
              readyLabel={`${validVouchers.length} ready`}
              problemCount={invalidVouchers.length}
              rows={voucherRows.map((r) => ({
                key: r.sourceIndex,
                name: r.voucherNumber ?? `(item ${r.sourceIndex + 1})`,
                sub: [r.vchType, r.dateRaw].filter(Boolean).join(" · "),
                status: r.data
                  ? { tone: "ok" as const, text: "Ready" }
                  : { tone: "bad" as const, text: r.issues.join(" ") },
              }))}
            />
          )}

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Button
              busy={busy}
              busyLabel="Importing…"
              disabled={validGroups.length + validLedgers.length + validVouchers.length === 0}
              onClick={commitAll}
            >
              Import {validGroups.length + validLedgers.length + validVouchers.length} record
              {validGroups.length + validLedgers.length + validVouchers.length === 1 ? "" : "s"}
            </Button>
            {invalidGroups.length + invalidLedgers.length + invalidVouchers.length > 0 && (
              <span className="text-sm text-ink-soft">
                Records with problems are skipped, not guessed at — see the reasons above. Fix the source
                file (or LEKHA&rsquo;s data) and import again.
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function PreviewSection({
  title,
  readyLabel,
  problemCount,
  rows,
}: {
  title: string;
  readyLabel: string;
  problemCount: number;
  rows: { key: number; name: string | null; sub: string | null; status: { tone: "ok" | "bad" | "neutral"; text: string } }[];
}) {
  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <span className="text-xs text-ink-soft">{readyLabel}</span>
        {problemCount > 0 && (
          <span className="text-xs text-warning">
            {problemCount} problem{problemCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <TableContainer className="mt-2">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr>
              <th className={th}>Name</th>
              <th className={th}>Detail</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((r) => (
              <tr key={r.key} className={r.status.tone === "bad" ? "bg-warning-soft" : undefined}>
                <td className={td}>{r.name ?? <span className="text-ink-faint">(unnamed)</span>}</td>
                <td className={td + " text-ink-soft"}>{r.sub ?? "—"}</td>
                <td className={td + (r.status.tone === "bad" ? " text-warning" : "")}>
                  <Badge tone={r.status.tone === "ok" ? "ok" : r.status.tone === "bad" ? "warn" : "neutral"}>
                    {r.status.tone === "bad" ? "Problem" : r.status.text.split(" — ")[0]}
                  </Badge>
                  {r.status.tone === "bad" && <span className="ml-2">{r.status.text}</span>}
                  {r.status.tone !== "bad" && r.status.text.includes(" — ") && (
                    <span className="ml-2 text-ink-soft">{r.status.text.split(" — ").slice(1).join(" — ")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableContainer>
      {rows.length > 200 && (
        <p className="mt-1.5 text-xs text-ink-faint">Showing the first 200 of {rows.length}. All are validated and all ready ones will import.</p>
      )}
    </div>
  );
}
