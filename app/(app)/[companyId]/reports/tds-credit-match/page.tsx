import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

/** The calendar April-March tax year label containing today's local date —
 * same convention as reports/income-tax/page.tsx and tax_payments.financial_
 * year_label, deliberately independent of this company's own book year. */
function currentFyLabel(): string {
  const today = new Date();
  const y = today.getFullYear();
  const startYear = today.getMonth() + 1 >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function shiftFyLabel(label: string, delta: number): string {
  const startYear = Number(label.slice(0, 4)) + delta;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

type MatchRow = {
  bucket: "matched" | "missing_from_books" | "missing_from_statement";
  deductor_tan: string | null;
  deductor_name: string | null;
  amount_paid_credited_statement: number | null;
  tax_deducted_statement: number | null;
  tax_deposited_statement: number | null;
  tds_receivable_register: number | null;
  amount_difference: number | null;
  ledger_id: string | null;
  ledger_name: string | null;
};

const SOURCE_LABEL: Record<string, string> = { "26as": "Form 26AS", ais: "AIS", tis: "TIS" };

export default async function TdsCreditMatchPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/tds-credit-match">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const fyParam = typeof sp.fy === "string" && /^\d{4}-\d{2}$/.test(sp.fy) ? sp.fy : currentFyLabel();
  const sourceParam = typeof sp.source === "string" && sp.source in SOURCE_LABEL ? sp.source : "26as";

  const { data: periods } = await supabase.rpc("list_income_tax_statement_periods", {
    p_company_id: companyId,
  });
  const uploadedSources = (periods ?? []).filter((p) => p.financial_year_label === fyParam);
  const uploaded = uploadedSources.find((p) => p.source === sourceParam);

  const { data: matchRows, error: matchError } = uploaded
    ? await supabase.rpc("match_income_tax_statement_tds_receivable", {
        p_company_id: companyId,
        p_financial_year_label: fyParam,
        p_source: sourceParam,
      })
    : { data: [], error: null };

  const rows = (matchRows ?? []) as MatchRow[];
  const matched = rows.filter((r) => r.bucket === "matched");
  const missingFromBooks = rows.filter((r) => r.bucket === "missing_from_books");
  const missingFromStatement = rows.filter((r) => r.bucket === "missing_from_statement");
  const noTan = missingFromStatement.filter((r) => r.deductor_tan === null);
  const genuinelyMissing = missingFromStatement.filter((r) => r.deductor_tan !== null);

  const atRiskTax = genuinelyMissing.reduce((n, r) => n + Number(r.tds_receivable_register ?? 0), 0);
  const notYetBookedTax = missingFromBooks.reduce((n, r) => n + Number(r.tax_deposited_statement ?? 0), 0);
  const amountMismatches = matched.filter((r) => Math.abs(Number(r.amount_difference ?? 0)) > 2);

  const base = `/${companyId}/reports/tds-credit-match`;

  return (
    <ReportShell
      title="TDS credit match"
      period={`FY ${fyParam} · ${SOURCE_LABEL[sourceParam]} · Sec 199/Rule 37BA credit is limited to what the deductor actually deposited and reported`}
      status={
        uploaded
          ? {
              label: atRiskTax > 0 ? `${formatINR(atRiskTax, { showZero: true })} credit at risk` : "Nothing at risk",
              tone: atRiskTax > 0 ? "bad" : "ok",
            }
          : { label: `Nothing uploaded for ${SOURCE_LABEL[sourceParam]}`, tone: "warn" }
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`${base}?fy=${shiftFyLabel(fyParam, -1)}&source=${sourceParam}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            ← Prev year
          </Link>
          <span className="px-2 font-medium">FY {fyParam}</span>
          <Link
            href={`${base}?fy=${shiftFyLabel(fyParam, 1)}&source=${sourceParam}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            Next year →
          </Link>
        </div>

        <div className="flex items-center gap-2 text-sm">
          {Object.entries(SOURCE_LABEL).map(([key, label]) => (
            <Link
              key={key}
              href={`${base}?fy=${fyParam}&source=${key}`}
              className={
                "rounded-md border px-2.5 py-1 " +
                (sourceParam === key ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
              }
            >
              {label}
            </Link>
          ))}
        </div>
      </div>

      {!uploaded && (
        <div className="border-b border-border bg-warning-soft px-4 py-3 text-sm text-ink">
          Nothing has been uploaded for {SOURCE_LABEL[sourceParam]} · FY {fyParam} yet.{" "}
          <Link href={`/${companyId}/import?tab=tax-statement`} className="underline">
            Upload it
          </Link>{" "}
          to see the match.
          {uploadedSources.length > 0 && (
            <span className="ml-1">
              ({uploadedSources.map((p) => SOURCE_LABEL[p.source]).join(", ")} already uploaded for this year —
              pick that tab above.)
            </span>
          )}
        </div>
      )}

      {matchError && (
        <div className="border-b border-border bg-error-soft px-4 py-3 text-sm text-error">{matchError.message}</div>
      )}

      {uploaded && (
        <>
          <div className="grid gap-px bg-border p-px sm:grid-cols-3">
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Matched</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums font-mono">{matched.length}</div>
              {amountMismatches.length > 0 && (
                <div className="mt-0.5 text-xs text-warning">{amountMismatches.length} with an amount difference</div>
              )}
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">In {SOURCE_LABEL[sourceParam]}, not booked here</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums font-mono text-warning">
                {missingFromBooks.length}
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">
                {formatINR(notYetBookedTax, { showZero: true })} not yet entered as TDS Receivable
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Booked here, not in {SOURCE_LABEL[sourceParam]}</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums font-mono text-error">
                {genuinelyMissing.length}
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">
                {formatINR(atRiskTax, { showZero: true })} credit at risk, Sec 199/Rule 37BA
              </div>
            </div>
          </div>

          <div className="border-b border-t border-border p-4">
            <h2 className="font-semibold">Booked here, not in {SOURCE_LABEL[sourceParam]} — credit at risk</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Rule 37BA allows credit only to the extent the deductor has actually deposited and reported
              it against your PAN. These amounts are debited to your TDS Receivable ledger but do not
              appear in this year&rsquo;s uploaded {SOURCE_LABEL[sourceParam]} — follow up with the
              deductor, or expect the credit to be denied at assessment if it never appears.
            </p>
          </div>
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Ledger</th>
                <th className={th}>TAN</th>
                <th className={th + " text-right"}>TDS Receivable (books)</th>
              </tr>
            </thead>
            <tbody>
              {genuinelyMissing.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-ink-faint">
                    Nothing at risk.
                  </td>
                </tr>
              )}
              {genuinelyMissing.map((r, i) => (
                <tr key={`ms-${i}`} className="border-b border-border last:border-0">
                  <td className={td}>{r.ledger_name}</td>
                  <td className={td + " font-mono text-xs"}>{r.deductor_tan}</td>
                  <td className={num}>{formatINR(Number(r.tds_receivable_register ?? 0), { showZero: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {noTan.length > 0 && (
            <p className="border-b border-border bg-warning-soft px-4 py-2 text-xs text-ink">
              {noTan.length} more debtor ledger{noTan.length === 1 ? "" : "s"} with TDS Receivable movement{" "}
              {noTan.length === 1 ? "has" : "have"} no TAN recorded, or the voucher had zero or multiple
              debtor-role ledgers on it — {noTan.map((r) => r.ledger_name).join(", ")}. These can never be
              matched by TAN and are excluded above rather than shown as a false gap. Set the customer&rsquo;s
              TAN on the ledger to make it checkable.
            </p>
          )}

          <div className="border-b border-border p-4">
            <h2 className="font-semibold">In {SOURCE_LABEL[sourceParam]}, not booked here</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              The department&rsquo;s statement shows tax deposited against your PAN by these deductors, but
              nothing debited to your TDS Receivable ledger matches their TAN — likely the receipt just
              hasn&rsquo;t been entered yet, or the customer ledger&rsquo;s TAN isn&rsquo;t set.
            </p>
          </div>
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Deductor</th>
                <th className={th}>TAN</th>
                <th className={th + " text-right"}>Paid/credited</th>
                <th className={th + " text-right"}>Tax deposited</th>
              </tr>
            </thead>
            <tbody>
              {missingFromBooks.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-ink-faint">
                    Nothing missing.
                  </td>
                </tr>
              )}
              {missingFromBooks.map((r, i) => (
                <tr key={`mb-${i}`} className="border-b border-border last:border-0">
                  <td className={td}>{r.deductor_name}</td>
                  <td className={td + " font-mono text-xs"}>{r.deductor_tan}</td>
                  <td className={num}>{formatINR(Number(r.amount_paid_credited_statement ?? 0), { showZero: true })}</td>
                  <td className={num}>{formatINR(Number(r.tax_deposited_statement ?? 0), { showZero: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="border-b border-border p-4">
            <h2 className="font-semibold">Matched ({matched.length})</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Found on both sides for this deductor TAN, summed for the whole year (26AS/AIS has no
              per-invoice key to match against — Sec 199 credit is itself an annual, deductor-aggregate
              figure). A difference over ₹2 between deposited tax and your books is flagged.
            </p>
          </div>
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Deductor</th>
                <th className={th}>TAN</th>
                <th className={th + " text-right"}>Deposited ({SOURCE_LABEL[sourceParam]})</th>
                <th className={th + " text-right"}>TDS Receivable (books)</th>
              </tr>
            </thead>
            <tbody>
              {matched.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-ink-faint">
                    Nothing matched yet.
                  </td>
                </tr>
              )}
              {matched.map((r, i) => {
                const diff = Math.abs(Number(r.amount_difference ?? 0));
                return (
                  <tr key={`mm-${i}`} className="border-b border-border last:border-0">
                    <td className={td}>{r.deductor_name}</td>
                    <td className={td + " font-mono text-xs"}>{r.deductor_tan}</td>
                    <td className={num}>{formatINR(Number(r.tax_deposited_statement ?? 0), { showZero: true })}</td>
                    <td className={num + (diff > 2 ? " text-warning" : "")}>
                      {formatINR(Number(r.tds_receivable_register ?? 0), { showZero: true })}
                      {diff > 2 && <div className="text-[10px]">Δ {formatINR(diff, { showZero: true })}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Matches by normalised deductor TAN, summed per TAN for the financial year — never LEKHA&rsquo;s own
        voucher numbers. Only one uploaded source is matched at a time (26AS and AIS substantially overlap
        — summing both would double-count the same deduction). TCS suffered and AIS&rsquo;s non-TDS/TCS
        information categories (SFT, interest/dividend, etc.) are stored but never matched — LEKHA has no
        TCS Receivable or per-category ledger to reconcile them against yet. Not a filed return and not
        submitted anywhere — a reconciliation aid only.
      </p>
    </ReportShell>
  );
}
