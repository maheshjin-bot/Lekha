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

/**
 * GST's own financial year is always 1 April - 31 March — the CGST/IGST Acts
 * never define "financial year" themselves, so GST borrows the General
 * Clauses Act, 1897 definition, the same calendar-year position this app's
 * own reports/income-tax/page.tsx already takes for the same reason. This
 * deliberately ignores the company's own financial_year_start_month.
 */
function fyBounds(startYear: number): { from: string; to: string; label: string } {
  return {
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
    label: `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
  };
}

function currentFyStartYear(): number {
  const today = todayLocal();
  const [y, m] = today.split("-").map(Number);
  return m >= 4 ? y : y - 1;
}

// ₹2 crore / ₹5 crore — confirmed live for FY 2024-25 onward, see migration
// 0155's own header (Notification 15/2025-CT makes the ₹2cr GSTR-9 exemption
// standing rather than year-by-year; GSTR-9C's ₹5cr threshold is separate
// and higher, self-certified since FY 2020-21).
const GSTR9_THRESHOLD = 20000000;
const GSTR9C_THRESHOLD = 50000000;

type T45Row = {
  table_ref: string;
  row_code: string;
  description: string;
  taxable_value: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  cess: number | null;
  tax_total: number | null;
  note: string | null;
};

type Table8Row = {
  row_code: string;
  description: string;
  document_count: number | null;
  taxable_value: number | null;
  tax_total: number | null;
  note: string | null;
};

/** null means "this schema cannot compute this row" — distinct from a
 * confirmed zero. Never route a null through formatINR, which would render
 * it as "0.00" and erase that distinction. */
function amt(v: number | null): string {
  return v === null ? "N/A" : formatINR(v, { showZero: true });
}

export default async function Gstr9WorkpaperPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/gstr9-workpaper">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const fyParam = typeof sp.fy === "string" && /^\d{4}$/.test(sp.fy) ? Number(sp.fy) : currentFyStartYear();
  const { from, to, label } = fyBounds(fyParam);
  const regParam = typeof sp.reg === "string" ? sp.reg : undefined;

  const [{ data: modules }, { data: registrations }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase.from("gst_registrations").select("id, gstin").eq("company_id", companyId).order("gstin"),
  ]);

  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);
  const base = `/${companyId}/reports/gstr9-workpaper`;

  if (!gstOn) {
    return (
      <ReportShell title="GSTR-9 / 9C workpaper" period={label}>
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
  const regQuery = regId ? `&reg=${regId}` : "";

  if (!regId) {
    return (
      <ReportShell title="GSTR-9 / 9C workpaper" period={label}>
        <p className="px-4 py-12 text-center text-ink-faint">
          No GST registration on file for this company yet.
        </p>
      </ReportShell>
    );
  }

  const [
    { data: t45, error: t45Error },
    { data: t3b4 },
    { data: t3b61 },
    { data: t8, error: t8Error },
    { data: hsn },
    { data: turnoverRecon },
    { data: filings },
  ] = await Promise.all([
    supabase.rpc("get_gstr9_table4_5", {
      p_company_id: companyId,
      p_gst_registration_id: regId,
      p_fy_start: from,
      p_fy_end: to,
    }),
    supabase.rpc("get_gstr3b_table4", {
      p_company_id: companyId,
      p_gst_registration_id: regId,
      p_period_start: from,
      p_period_end: to,
    }),
    supabase.rpc("get_gstr3b_table6_1", {
      p_company_id: companyId,
      p_gst_registration_id: regId,
      p_period_start: from,
      p_period_end: to,
    }),
    supabase.rpc("get_gstr9_table8", {
      p_company_id: companyId,
      p_gst_registration_id: regId,
      p_fy_start: from,
      p_fy_end: to,
    }),
    supabase.rpc("get_gstr1_hsn_summary", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
    supabase.rpc("get_gstr9c_turnover_reconciliation", {
      p_company_id: companyId,
      p_gst_registration_id: regId,
      p_fy_start: from,
      p_fy_end: to,
    }),
    supabase.rpc("get_filing_register", { p_company_id: companyId }),
  ]);

  const rows45 = (t45 ?? []) as T45Row[];
  const table4 = rows45.filter((r) => r.table_ref === "4");
  const table5 = rows45.filter((r) => r.table_ref === "5");
  const t4Info = t3b4?.[0] ?? null;
  const t61 = t3b61 ?? [];
  const rows8 = (t8 ?? []) as Table8Row[];
  const recon = turnoverRecon?.[0] ?? null;

  const approxTurnover = rows45.reduce((n, r) => n + (r.taxable_value ?? 0), 0);

  // Tables 10-14: a manual cross-reference only, not computed table data —
  // see migration 0155's header for why LEKHA cannot isolate "declared in
  // the NEXT FY's returns" from voucher_date alone. Shown as the GSTR-1 /
  // GSTR-3B filings on record for Apr-Nov of the year following this FY.
  const nextFyMonths = (filings ?? []).filter((f) => {
    if (!f.form_code?.toUpperCase().startsWith("GSTR-1") && !f.form_code?.toUpperCase().startsWith("GSTR-3B")) return false;
    if (!f.filed_date) return false;
    const d = f.filed_date as string;
    return d >= to && d <= `${fyParam + 1}-11-30`;
  });

  return (
    <ReportShell
      title="GSTR-9 / 9C workpaper"
      period={`${label} · 1 Apr ${fyParam} to 31 Mar ${fyParam + 1} — GST's own financial year, not this company's book year`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 print:hidden">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`${base}?fy=${fyParam - 1}${regQuery}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            ← {fyBounds(fyParam - 1).label}
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link href={`${base}?fy=${fyParam + 1}${regQuery}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            {fyBounds(fyParam + 1).label} →
          </Link>
        </div>
        {(registrations ?? []).length > 1 && (
          <div className="flex items-center gap-2 text-sm">
            {(registrations ?? []).map((r) => (
              <Link
                key={r.id}
                href={`${base}?fy=${fyParam}&reg=${r.id}`}
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

      <div className="border-b border-border bg-blue-50 px-4 py-3 text-sm text-blue-900">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">Applicability, for your awareness — this report does not gate on it</span>
          <Badge tone={approxTurnover > GSTR9_THRESHOLD ? "warn" : "neutral"}>
            GSTR-9 {approxTurnover > GSTR9_THRESHOLD ? "likely mandatory" : "likely exempt"} (₹2cr line)
          </Badge>
          <Badge tone={approxTurnover > GSTR9C_THRESHOLD ? "warn" : "neutral"}>
            GSTR-9C {approxTurnover > GSTR9C_THRESHOLD ? "likely mandatory" : "not required"} (₹5cr line)
          </Badge>
        </p>
        <p className="mt-1">
          GSTR-9 is mandatory above ₹2 crore aggregate turnover for the FY (Notification 15/2025-CT made this
          a standing exemption below that from FY 2024-25 onward); GSTR-9C above ₹5 crore, separately. This
          registration&rsquo;s outward taxable value for {label} in this workpaper is approximately{" "}
          <strong>{formatINR(approxTurnover, { showZero: true })}</strong> — a per-registration figure, NOT the
          Sec 2(6) PAN-wide &ldquo;aggregate turnover&rdquo; the threshold actually tests. A company with more
          than one GST registration must add every registration&rsquo;s turnover by hand; this app has no
          cross-registration rollup.
        </p>
      </div>

      {(t45Error || t8Error) && (
        <div className="border-b border-border bg-error-soft px-4 py-3 text-sm text-error">
          {t45Error?.message ?? t8Error?.message}
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      <div className="px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Table 4 — Outward supplies on which tax is payable</h2>
      </div>
      <TableRows rows={table4} />

      <div className="border-t border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Table 5 — Outward supplies on which tax is not payable</h2>
      </div>
      <TableRows rows={table5} />

      {/* ---------------------------------------------------------------- */}
      <div className="border-t border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Tables 6 &amp; 7 — ITC availed and reversed</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          From get_gstr3b_table4, called across the whole FY rather than a single return period — this app&rsquo;s
          own computed figure, not what was actually typed into the portal each month. 6E/6F (import of goods/
          services) and 6C/6D (RCM) always read ₹0: 0102&rsquo;s own design never posts an ITC leg for RCM, and no
          import flag exists on a purchase voucher — see migration 0155&rsquo;s header. Table 6&rsquo;s
          Input/Input-Service/Capital-Goods split and Rule 43 (7D) are not computed anywhere in this app.
        </p>
      </div>
      {t4Info ? (
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Row</th>
              <th className={th}>Description</th>
              <th className={th + " text-right"}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <Row code="6A" desc="Total ITC availed through FORM GSTR-3B (as computed by this app for the FY)" v={t4Info.a_total} />
            <Row code="6B" desc="ITC on inward supplies (other than imports and RCM) — ordinary purchases" v={t4Info.a5_all_other_itc} />
            <Row code="6C+6D" desc="ITC on inward supplies liable to reverse charge (registered + unregistered)" v={0} note="Always 0 — see note above" />
            <Row code="6E" desc="ITC on import of goods" v={0} note="Always 0 — no import flag on a purchase voucher" />
            <Row code="6F" desc="ITC on import of services" v={0} note="Always 0 — same reason as 6E" />
            <Row code="7A" desc="ITC reversed — Rule 37 (180-day non-payment)" v={t4Info.b2_others_rule37} />
            <Row code="7C" desc="ITC reversed — Rule 42 (inputs/input services, common credit)" v={t4Info.b1_rule42_reversal} />
            <Row code="7D" desc="ITC reversed — Rule 43 (capital goods)" v={null} note="Not computed — see 0104's own scope cut" />
            <Row code="7E" desc="ITC reversed — Sec 17(5) blocked credit" v={t4Info.b1_sec17_5_blocked} />
            <Row code="—" desc="Net ITC available (this app's coverage of Table 6 minus Table 7)" v={t4Info.c_net_itc_available} strong />
          </tbody>
        </table>
      ) : (
        <p className="px-4 py-8 text-center text-ink-faint">No data.</p>
      )}

      {/* ---------------------------------------------------------------- */}
      <div className="border-t border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Table 8 — ITC as per GSTR-2B vs availed vs difference</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Sums match_gstr2b_purchase_register across the FY&rsquo;s 12 months — needs a GSTR-2B upload for every
          period via /import to be complete; a month with nothing uploaded contributes 0 to 8A silently. See
          /reports/gstr2b-match for the month-by-month, invoice-level detail this rolls up.
        </p>
      </div>
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Row</th>
            <th className={th}>Description</th>
            <th className={th + " text-right"}>Docs</th>
            <th className={th + " text-right"}>Taxable value</th>
            <th className={th + " text-right"}>Tax</th>
          </tr>
        </thead>
        <tbody>
          {rows8.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-ink-faint">
                No data.
              </td>
            </tr>
          )}
          {rows8.map((r) => (
            <tr key={r.row_code} className="border-b border-border last:border-0">
              <td className={td + " font-mono text-xs"}>{r.row_code}</td>
              <td className={td}>
                {r.description}
                {r.note && <div className="mt-0.5 text-xs text-ink-faint">{r.note}</div>}
              </td>
              <td className={num}>{r.document_count ?? "—"}</td>
              <td className={num}>{amt(r.taxable_value)}</td>
              <td className={num}>{amt(r.tax_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ---------------------------------------------------------------- */}
      <div className="border-t border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Table 9 — Tax paid</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          From get_gstr3b_table6_1, called across the whole FY. &ldquo;Paid&rdquo; here is what this app computed
          as payable and its own cash-vs-ITC set-off — not a record of what was actually remitted on the portal.
        </p>
      </div>
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Tax head</th>
            <th className={th + " text-right"}>Payable</th>
            <th className={th + " text-right"}>Paid via ITC</th>
            <th className={th + " text-right"}>Paid via cash</th>
            <th className={th + " text-right"}>Interest</th>
            <th className={th + " text-right"}>Late fee</th>
          </tr>
        </thead>
        <tbody>
          {(t61 ?? []).map((r) => (
            <tr key={r.tax_head} className="border-b border-border last:border-0">
              <td className={td + " uppercase"}>{r.tax_head}</td>
              <td className={num}>{amt(r.tax_payable)}</td>
              <td className={num}>{amt(r.itc_total_utilised)}</td>
              <td className={num}>{amt(r.cash_tax_payable)}</td>
              <td className={num}>{amt(r.interest_payable)}</td>
              <td className={num}>{amt(r.late_fee_payable)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ---------------------------------------------------------------- */}
      <div className="border-t border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Table 17 — HSN-wise summary of outward supplies</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Reuses get_gstr1_hsn_summary (GSTR-1&rsquo;s own Table 12) called across the whole FY — same real
          per-(HSN, rate) rows GSTR-1 files monthly, just summed over the year. GSTR-9&rsquo;s Table 18 (HSN of
          INWARD supplies) has no equivalent function anywhere in this app and is not attempted here.
        </p>
      </div>
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>HSN</th>
            <th className={th}>Description</th>
            <th className={th + " text-right"}>Rate %</th>
            <th className={th + " text-right"}>Qty</th>
            <th className={th + " text-right"}>Taxable value</th>
            <th className={th + " text-right"}>Total tax</th>
          </tr>
        </thead>
        <tbody>
          {(hsn ?? []).length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-ink-faint">
                No outward HSN activity in this FY.
              </td>
            </tr>
          )}
          {(hsn ?? []).map((r, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className={td + " font-mono text-xs"}>{r.hsn_sac}</td>
              <td className={td}>{r.description ?? "—"}</td>
              <td className={num}>{r.gst_rate_percent}</td>
              <td className={num}>{formatINR(Number(r.total_quantity), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.taxable_value), { showZero: true })}</td>
              <td className={num}>
                {formatINR(Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess), { showZero: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ---------------------------------------------------------------- */}
      <div className="border-t border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Tables 10-14 — prior-FY transactions declared in this FY&rsquo;s returns</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Not computed: LEKHA has no &ldquo;which return period this voucher was actually filed in&rdquo; fact —
          every report here derives a period from the voucher date alone. For your own manual cross-check, these
          are the GSTR-1 / GSTR-3B filings on record ({" "}
          <Link href={`/${companyId}/filing-register`} className="underline">
            Filing register
          </Link>
          ) between 1 Apr {fyParam + 1} and 30 Nov {fyParam + 1}, the window Tables 10/11/14 cover:
        </p>
      </div>
      <div className="px-4 pb-4">
        {nextFyMonths.length === 0 ? (
          <p className="text-sm text-ink-faint">No matching filings on record.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {nextFyMonths.map((f) => (
              <li key={f.id} className="flex items-center gap-2">
                <Badge tone="neutral">{f.form_code}</Badge>
                <span>{f.period_label}</span>
                <span className="text-ink-faint">filed {f.filed_date}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      <div className="border-t border-border bg-warning-soft px-4 py-3 text-sm text-ink">
        <p className="font-semibold">GSTR-9C — Table 5 turnover reconciliation, workpaper only</p>
        <p className="mt-1 text-xs">
          Both figures below are computed from the SAME voucher ledger in this app — there is no separately
          maintained &ldquo;audited books&rdquo; figure and no record of what was actually typed into the
          GST portal at filing time if it ever diverged. A real GSTR-9C needs the actual audited financial
          statements and the actual as-filed GSTR-9, both external to this schema. Treat this as an internal
          review aid, not a substitute for that reconciliation — see migration 0155&rsquo;s header.
        </p>
      </div>
      {recon ? (
        <table className="w-full min-w-[760px] text-sm">
          <tbody>
            <tr className="border-b border-border">
              <td className={td}>Revenue from operations per books (direct_income ledgers, FY total)</td>
              <td className={num}>{amt(recon.books_revenue_from_operations)}</td>
            </tr>
            <tr className="border-b border-border">
              <td className={td}>
                Other income per books (indirect_income ledgers, FY total)
                <div className="text-xs text-ink-faint">Shown separately — whether this belongs in a Table 5 reconciliation is a preparer judgement call.</div>
              </td>
              <td className={num}>{amt(recon.books_other_income)}</td>
            </tr>
            <tr className="border-b border-border">
              <td className={td}>Turnover per this workpaper&rsquo;s own Table 4 + 5 (taxable value)</td>
              <td className={num}>{amt(recon.gst_workpaper_turnover)}</td>
            </tr>
            <tr>
              <td className={td + " font-semibold"}>Difference</td>
              <td className={num + " font-semibold"}>{amt(recon.difference)}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <p className="px-4 py-8 text-center text-ink-faint">No data.</p>
      )}

      <div className="border-t border-border px-4 py-3 text-sm text-ink">
        <p className="font-semibold">GSTR-9C — Tables 9 &amp; 12 (tax paid / ITC reconciliation)</p>
        <p className="mt-1 text-xs text-ink-faint">
          Not built as separate figures: this app has no independently-sourced &ldquo;tax paid per books&rdquo;
          or &ldquo;ITC per books&rdquo; distinct from the Table 9 and Table 8 figures above — both sides of a
          real 9C reconciliation would read identically here, since they come from the same ledger. Use Table 9
          above for tax paid and Table 8 above for ITC; a genuine 9C still needs the audited figures compared
          by hand.
        </p>
      </div>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        A workpaper to assemble a GSTR-9/9C filing from, not a validated match to GSTN&rsquo;s offline utility
        upload format and not submitted anywhere. Tables 4/5/8/17 are built for this registration; Tables 6/7/9
        are computed company-wide within this registration&rsquo;s scope for the Rule 42/Rule 37 components (see
        each section&rsquo;s own note) — a genuine multi-registration company should treat those as an estimate
        needing manual reconciliation across GSTINs. Tables 4F, 4J, 6&rsquo;s Input/Input-Service/Capital-Goods
        split, 7D (Rule 43), 10-14, 15, 16, 18 and 19, and GSTR-9C Part V, are not computed anywhere in this
        report — see migration 0155&rsquo;s header for why each one specifically.
      </p>
    </ReportShell>
  );
}

function TableRows({ rows }: { rows: T45Row[] }) {
  return (
    <table className="w-full min-w-[900px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Row</th>
          <th className={th}>Description</th>
          <th className={th + " text-right"}>Taxable value</th>
          <th className={th + " text-right"}>Tax</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={4} className="px-4 py-8 text-center text-ink-faint">
              No data.
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr key={r.row_code} className="border-b border-border last:border-0">
            <td className={td + " font-mono text-xs"}>{r.row_code}</td>
            <td className={td}>
              {r.description}
              {r.note && <div className="mt-0.5 text-xs text-ink-faint">{r.note}</div>}
            </td>
            <td className={num}>{amt(r.taxable_value)}</td>
            <td className={num}>{amt(r.tax_total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Row({ code, desc, v, note, strong }: { code: string; desc: string; v: number | null; note?: string; strong?: boolean }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className={td + " font-mono text-xs"}>{code}</td>
      <td className={td + (strong ? " font-semibold" : "")}>
        {desc}
        {note && <div className="mt-0.5 text-xs text-ink-faint">{note}</div>}
      </td>
      <td className={num + (strong ? " font-semibold" : "")}>{amt(v)}</td>
    </tr>
  );
}
