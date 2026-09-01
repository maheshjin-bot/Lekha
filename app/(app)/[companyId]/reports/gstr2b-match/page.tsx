import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

type MatchRow = {
  bucket: "matched" | "missing_from_register" | "missing_from_2b" | "no_gstin_on_file";
  supplier_gstin: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  taxable_value_2b: number | null;
  tax_2b: number | null;
  taxable_value_register: number | null;
  tax_register: number | null;
  amount_difference: number | null;
  itc_availability: string | null;
  itc_reason: string | null;
  voucher_id: string | null;
  voucher_number: string | null;
  voucher_date: string | null;
};

const ITC_TONE: Record<string, "ok" | "bad" | "warn" | "neutral"> = {
  available: "ok",
  not_available: "bad",
  reversal: "warn",
  rejected: "bad",
};

export default async function Gstr2bMatchPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/gstr2b-match">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const today = todayLocal();
  const defaultYm = today.slice(0, 7);
  const monthParam = typeof sp.month === "string" && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : defaultYm;
  const regParam = typeof sp.reg === "string" ? sp.reg : undefined;

  const [{ data: modules }, { data: registrations }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase.from("gst_registrations").select("id, gstin").eq("company_id", companyId).order("gstin"),
  ]);

  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);

  if (!gstOn) {
    return (
      <ReportShell title="GSTR-2B match" period={monthLabel(monthParam)}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">GST is not on for this company</p>
          <p className="mt-1">
            Add a GST registration first —{" "}
            <Link href={`/${companyId}/registrations`} className="underline">
              Registrations
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const regId = regParam || registrations?.[0]?.id;

  const [{ data: periods }, { data: matchRows, error: matchError }] = await Promise.all([
    supabase.rpc("list_gstr2b_periods", { p_company_id: companyId }),
    regId
      ? supabase.rpc("match_gstr2b_purchase_register", {
          p_company_id: companyId,
          p_return_period: monthParam,
          p_gst_registration_id: regId,
        })
      : Promise.resolve({ data: [], error: null }),
  ]);

  const rows = (matchRows ?? []) as MatchRow[];
  const uploaded = (periods ?? []).find((p) => p.return_period === monthParam && p.gst_registration_id === regId);

  const matched = rows.filter((r) => r.bucket === "matched");
  const missingFromRegister = rows.filter((r) => r.bucket === "missing_from_register");
  const missingFrom2b = rows.filter((r) => r.bucket === "missing_from_2b");
  const noGstin = rows.filter((r) => r.bucket === "no_gstin_on_file");
  const noReference = missingFrom2b.filter((r) => r.invoice_number === "(no reference number entered)");
  const genuinelyMissing = missingFrom2b.filter((r) => r.invoice_number !== "(no reference number entered)");

  const atRiskTax = missingFrom2b.reduce((n, r) => n + Number(r.tax_register ?? 0), 0);
  const missedBookingTax = missingFromRegister.reduce((n, r) => n + Number(r.tax_2b ?? 0), 0);
  const amountMismatches = matched.filter((r) => Math.abs(Number(r.amount_difference ?? 0)) > 2);

  const base = `/${companyId}/reports/gstr2b-match`;
  const regQuery = regId ? `&reg=${regId}` : "";

  return (
    <ReportShell
      title="GSTR-2B match"
      period={`${monthLabel(monthParam)} · ITC available under Sec 16(2)(aa) only if the invoice is in 2B`}
      status={
        uploaded
          ? {
              label: `${atRiskTax > 0 ? formatINR(atRiskTax, { showZero: true }) + " ITC at risk" : "Nothing at risk"}`,
              tone: atRiskTax > 0 ? "bad" : "ok",
            }
          : { label: "Nothing uploaded for this period", tone: "warn" }
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`${base}?month=${shiftMonth(monthParam, -1)}${regQuery}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            ← Prev
          </Link>
          <span className="px-2 font-medium">{monthLabel(monthParam)}</span>
          <Link
            href={`${base}?month=${shiftMonth(monthParam, 1)}${regQuery}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            Next →
          </Link>
        </div>

        {(registrations ?? []).length > 1 && (
          <div className="flex items-center gap-2 text-sm">
            {(registrations ?? []).map((r) => (
              <Link
                key={r.id}
                href={`${base}?month=${monthParam}&reg=${r.id}`}
                className={
                  "rounded-md border px-2.5 py-1 font-mono text-xs " +
                  (regId === r.id ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
                }
              >
                {r.gstin}
              </Link>
            ))}
          </div>
        )}
      </div>

      {!uploaded && (
        <div className="border-b border-border bg-warning-soft px-4 py-3 text-sm text-ink">
          Nothing has been uploaded for {monthLabel(monthParam)} yet.{" "}
          <Link href={`/${companyId}/import?tab=gstr2b`} className="underline">
            Upload the GSTR-2B for this period
          </Link>{" "}
          to see the match.
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
              <div className="text-xs text-ink-faint">In 2B, not booked here</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums font-mono text-warning">
                {missingFromRegister.length}
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">{formatINR(missedBookingTax, { showZero: true })} ITC not yet claimed</div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Booked here, not in 2B</div>
              <div className="mt-0.5 text-lg font-semibold tabular-nums font-mono text-error">
                {genuinelyMissing.length}
              </div>
              <div className="mt-0.5 text-xs text-ink-faint">{formatINR(atRiskTax, { showZero: true })} ITC at risk, Sec 16(2)(aa)</div>
            </div>
          </div>

          <div className="border-b border-t border-border p-4">
            <h2 className="font-semibold">Booked here, not in 2B — ITC at risk</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Sec 16(2)(aa) makes credit conditional on the invoice being communicated to you in
              GSTR-2B. These purchases are in your books but not in this period&rsquo;s uploaded 2B —
              follow up with the supplier, or expect to reverse the credit if it never appears.
            </p>
          </div>
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Voucher</th>
                <th className={th}>Supplier</th>
                <th className={th}>Reference #</th>
                <th className={th + " text-right"}>Taxable</th>
                <th className={th + " text-right"}>Tax</th>
              </tr>
            </thead>
            <tbody>
              {genuinelyMissing.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-ink-faint">
                    Nothing at risk.
                  </td>
                </tr>
              )}
              {genuinelyMissing.map((r, i) => (
                <tr key={`m2b-${i}`} className="border-b border-border last:border-0">
                  <td className={td}>
                    {r.voucher_number}
                    <div className="text-xs text-ink-faint">{r.voucher_date}</div>
                  </td>
                  <td className={td}>
                    {r.supplier_name}
                    <div className="font-mono text-xs text-ink-faint">{r.supplier_gstin}</div>
                  </td>
                  <td className={td + " font-mono text-xs"}>{r.invoice_number}</td>
                  <td className={num}>{formatINR(Number(r.taxable_value_register ?? 0), { showZero: true })}</td>
                  <td className={num}>{formatINR(Number(r.tax_register ?? 0), { showZero: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {noReference.length > 0 && (
            <p className="border-b border-border bg-warning-soft px-4 py-2 text-xs text-ink">
              {noReference.length} more purchase{noReference.length === 1 ? "" : "s"} this month{" "}
              {noReference.length === 1 ? "has" : "have"} no supplier reference number entered — they
              can never be matched by invoice number and are excluded above rather than shown as a false
              gap. Add the reference number on the voucher to make them checkable.
            </p>
          )}
          {noGstin.length > 0 && (
            <p className="border-b border-border bg-surface-2 px-4 py-2 text-xs text-ink-faint">
              {noGstin.length} more purchase{noGstin.length === 1 ? "" : "s"} this month{" "}
              {noGstin.length === 1 ? "is" : "are"} against a party with no GSTIN on file — an
              unregistered supplier can never appear in a GSTR-2B, so {noGstin.length === 1 ? "it isn't" : "these aren't"}{" "}
              counted as ITC at risk. Shown here only so nothing silently disappears from the report:{" "}
              {noGstin.map((r, i) => (
                <span key={`ng-${i}`}>
                  {i > 0 && ", "}
                  {r.supplier_name} ({formatINR(Number(r.tax_register ?? 0), { showZero: true })} tax)
                </span>
              ))}
              .
            </p>
          )}

          <div className="border-b border-border p-4">
            <h2 className="font-semibold">In 2B, not booked here — a missed purchase entry</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Your supplier reported these to GSTN and they reached your 2B, but nothing matching them
              is booked in your purchase register — likely just not entered yet.
            </p>
          </div>
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Supplier</th>
                <th className={th}>Invoice #</th>
                <th className={th}>Date</th>
                <th className={th + " text-right"}>Taxable</th>
                <th className={th + " text-right"}>Tax</th>
                <th className={th}>ITC</th>
              </tr>
            </thead>
            <tbody>
              {missingFromRegister.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-ink-faint">
                    Nothing missing.
                  </td>
                </tr>
              )}
              {missingFromRegister.map((r, i) => (
                <tr key={`mr-${i}`} className="border-b border-border last:border-0">
                  <td className={td}>
                    {r.supplier_name}
                    <div className="font-mono text-xs text-ink-faint">{r.supplier_gstin}</div>
                  </td>
                  <td className={td + " font-mono text-xs"}>{r.invoice_number}</td>
                  <td className={td}>{r.invoice_date}</td>
                  <td className={num}>{formatINR(Number(r.taxable_value_2b ?? 0), { showZero: true })}</td>
                  <td className={num}>{formatINR(Number(r.tax_2b ?? 0), { showZero: true })}</td>
                  <td className={td}>
                    {r.itc_availability && (
                      <Badge tone={ITC_TONE[r.itc_availability] ?? "neutral"}>
                        {r.itc_availability.replace("_", " ")}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="border-b border-border p-4">
            <h2 className="font-semibold">Matched ({matched.length})</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Found on both sides, matched by supplier GSTIN and invoice number. A difference over ₹2
              between the two amounts is flagged — usually a data-entry or rounding difference worth a
              second look.
            </p>
          </div>
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Voucher</th>
                <th className={th}>Supplier</th>
                <th className={th}>Invoice #</th>
                <th className={th + " text-right"}>2B value</th>
                <th className={th + " text-right"}>Register value</th>
                <th className={th}>ITC</th>
              </tr>
            </thead>
            <tbody>
              {matched.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-ink-faint">
                    Nothing matched yet.
                  </td>
                </tr>
              )}
              {matched.map((r, i) => {
                const diff = Math.abs(Number(r.amount_difference ?? 0));
                return (
                  <tr key={`mm-${i}`} className="border-b border-border last:border-0">
                    <td className={td}>
                      {r.voucher_number}
                      <div className="text-xs text-ink-faint">{r.voucher_date}</div>
                    </td>
                    <td className={td}>
                      {r.supplier_name}
                      <div className="font-mono text-xs text-ink-faint">{r.supplier_gstin}</div>
                    </td>
                    <td className={td + " font-mono text-xs"}>{r.invoice_number}</td>
                    <td className={num}>
                      {formatINR(Number(r.taxable_value_2b ?? 0) + Number(r.tax_2b ?? 0), { showZero: true })}
                    </td>
                    <td className={num + (diff > 2 ? " text-warning" : "")}>
                      {formatINR(Number(r.taxable_value_register ?? 0) + Number(r.tax_register ?? 0), { showZero: true })}
                      {diff > 2 && <div className="text-[10px]">Δ {formatINR(diff, { showZero: true })}</div>}
                    </td>
                    <td className={td}>
                      {r.itc_availability && (
                        <Badge tone={ITC_TONE[r.itc_availability] ?? "neutral"}>
                          {r.itc_availability.replace("_", " ")}
                        </Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Matches by supplier GSTIN and the supplier&rsquo;s own invoice number (your voucher&rsquo;s
        Reference Number field) — not LEKHA&rsquo;s own voucher number, which has nothing to do with
        the supplier&rsquo;s document. Looks back 2 months from this period for a late-filed match, but
        only flags a purchase as at-risk when it is dated inside this period&rsquo;s own month. B2B and
        CDNR lines only — ISD credit, import-of-goods (IMPG/IMPGSEZ) and e-commerce Sec 9(5) (ECO) lines
        in 2B are not represented, since LEKHA has no matching entries to reconcile them against. Not a
        filed return and not submitted anywhere — a reconciliation aid only.
      </p>
    </ReportShell>
  );
}
