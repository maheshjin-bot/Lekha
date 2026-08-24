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

/** GST returns run on the calendar month — same convention as gst-registers / gstr1-summary. */
function monthBounds(month?: string): { from: string; to: string; label: string; ym: string } {
  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  let y = ty;
  let m = tm;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    [y, m] = month.split("-").map(Number);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const from = `${y}-${pad(m)}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${pad(m)}-${pad(lastDay)}`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { from, to, label, ym: `${y}-${pad(m)}` };
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

type Rule89_4 = {
  export_lut_turnover: number;
  sez_zero_tax_turnover: number;
  zero_rated_turnover_goods: number;
  zero_rated_turnover_services: number;
  zero_rated_turnover_total: number;
  net_itc: number;
  net_itc_cgst: number;
  net_itc_sgst: number;
  net_itc_igst: number;
  net_itc_cess: number;
  blocked_or_exempt_linked_itc_excluded: number;
  total_turnover: number;
  exempt_turnover: number;
  adjusted_total_turnover: number;
  refund_amount: number;
};

type Rule89_5 = {
  aggregate_input_rate_percent: number;
  eligible_input_taxable_value: number;
  inverted_rated_turnover: number;
  tax_payable_on_inverted_turnover: number;
  tax_payable_cgst: number;
  tax_payable_sgst: number;
  tax_payable_igst: number;
  tax_payable_cess: number;
  net_itc: number;
  net_itc_cgst: number;
  net_itc_sgst: number;
  net_itc_igst: number;
  net_itc_cess: number;
  itc_availed_on_inputs_and_services: number;
  total_turnover: number;
  exempt_turnover: number;
  adjusted_total_turnover: number;
  refund_amount: number;
};

type Rule89_5Item = {
  item_id: string;
  item_name: string;
  hsn_sac: string | null;
  output_gst_rate_percent: number;
  taxable_turnover: number;
  is_flagged_inverted_rated: boolean;
};

type OutputRow = {
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  party_name: string | null;
  supply_type: string | null;
  taxable_value: number;
  invoice_value: number;
};

export default async function GstRefundsPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/gst-refunds">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const { from, to, label, ym } = monthBounds(monthParam);
  const regParam = typeof sp.reg === "string" ? sp.reg : undefined;

  const [{ data: modules }, { data: registrations }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase
      .from("gst_registrations")
      .select("id, gstin, state_code, lut_number, lut_valid_from, lut_valid_to")
      .eq("company_id", companyId)
      .order("gstin"),
  ]);

  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);
  const regs = registrations ?? [];
  const regId = regParam || regs[0]?.id;
  const activeReg = regs.find((r) => r.id === regId);

  if (!gstOn) {
    return (
      <ReportShell title="GST refund computation (Rule 89(4) / 89(5))" period={label}>
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

  if (!regId) {
    return (
      <ReportShell title="GST refund computation (Rule 89(4) / 89(5))" period={label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">No GST registration on file</p>
          <p className="mt-1">
            A refund claim (RFD-01) is filed per GSTIN — add a registration first.
          </p>
        </div>
      </ReportShell>
    );
  }

  const [{ data: r4Rows, error: r4Error }, { data: r5Rows, error: r5Error }, { data: itemRows }, { data: outputRows }] =
    await Promise.all([
      supabase.rpc("get_gst_refund_rule89_4", {
        p_company_id: companyId,
        p_gst_registration_id: regId,
        p_period_start: from,
        p_period_end: to,
      }),
      supabase.rpc("get_gst_refund_rule89_5", {
        p_company_id: companyId,
        p_gst_registration_id: regId,
        p_period_start: from,
        p_period_end: to,
      }),
      supabase.rpc("get_gst_refund_rule89_5_items", {
        p_company_id: companyId,
        p_gst_registration_id: regId,
        p_period_start: from,
        p_period_end: to,
      }),
      supabase.rpc("get_gst_output_register", {
        p_company_id: companyId,
        p_period_start: from,
        p_period_end: to,
        p_gst_registration_id: regId,
      }),
    ]);

  // `as unknown as` — same reason as reports/balance-sheet, reports/pt-liability
  // and others: these RPCs (0123) are not yet in the generated database.types.ts,
  // which this task must not touch (owned by the integration pass' regeneration).
  const r4 = (Array.isArray(r4Rows) ? r4Rows[0] : r4Rows) as unknown as Rule89_4 | undefined;
  const r5 = (Array.isArray(r5Rows) ? r5Rows[0] : r5Rows) as unknown as Rule89_5 | undefined;
  const items = (itemRows ?? []) as unknown as Rule89_5Item[];
  const zeroRatedRows = ((outputRows ?? []) as OutputRow[]).filter(
    (r) => r.supply_type === "export_lut" || r.supply_type === "sez"
  );

  const base = `/${companyId}/reports/gst-refunds`;
  const regQuery = regId ? `&reg=${regId}` : "";

  const refund4 = Number(r4?.refund_amount ?? 0);
  // The formula's own arithmetic can go negative (tax payable on the
  // inverted-rated turnover exceeds its share of the ratio) — that means
  // nil refund, not a negative refund. raw89_5 keeps the true computed
  // value so the breakdown table's rows still sum correctly for a reader
  // checking the arithmetic by hand; refund5 is the floored figure shown
  // on the headline tile, with an explicit "(nil)" note when it differs.
  const raw89_5 = Number(r5?.refund_amount ?? 0);
  const refund5 = Math.max(0, raw89_5);
  const lutActiveNow =
    activeReg?.lut_number &&
    activeReg.lut_valid_from &&
    to >= activeReg.lut_valid_from &&
    (!activeReg.lut_valid_to || to <= activeReg.lut_valid_to);

  return (
    <ReportShell
      title="GST refund computation (Rule 89(4) / 89(5))"
      period={`${label} · ${activeReg?.gstin ?? "no GSTIN"} · computation aid for RFD-01, not a filing`}
      status={
        r4Error || r5Error
          ? { label: "Could not compute", tone: "bad" }
          : refund4 + refund5 > 0
            ? { label: `${formatINR(refund4 + refund5, { showZero: true })} indicative refund`, tone: "ok" as const }
            : { label: "No refund indicated this period", tone: "ok" as const }
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4 print:hidden">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`${base}?month=${shiftMonth(ym, -1)}${regQuery}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            ← Prev
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link href={`${base}?month=${shiftMonth(ym, 1)}${regQuery}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            Next →
          </Link>
        </div>

        {regs.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {regs.map((r) => (
              <Link
                key={r.id}
                href={`${base}?month=${ym}&reg=${r.id}`}
                className={
                  "rounded-md border px-2.5 py-1 " +
                  (r.id === regId ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
                }
              >
                {r.gstin ?? r.state_code}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900 print:bg-transparent print:px-0">
        <p className="font-semibold">This is prep data for Form GST RFD-01, not a refund-ready or portal-integrated figure</p>
        <p className="mt-1">
          Nothing on this page files a refund claim or talks to the GST portal. Both figures below are the
          formula&rsquo;s own arithmetic, computed from vouchers already posted in this app — a preparer reviews
          and adjusts before entering anything on RFD-01. See the notes under each section for what this app&rsquo;s
          schema cannot represent.
        </p>
      </div>

      {r4Error && (
        <div className="m-4 rounded-md bg-error-soft px-4 py-3 text-sm text-error">
          Could not compute Rule 89(4): {r4Error.message}
        </div>
      )}

      {/* ============================== Rule 89(4) ============================== */}
      <div className="border-b border-t border-border bg-bg p-4">
        <h2 className="font-display text-lg font-semibold text-ink">Rule 89(4) — zero-rated supply under LUT (exports / SEZ without payment of tax)</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Refund = Turnover of zero-rated supply × Net ITC ÷ Adjusted Total Turnover.
          {!lutActiveNow && (
            <span className="ml-1 text-warning">
              No LUT is on file as active for {activeReg?.gstin} covering this period — a zero-tax export here
              would need one filed first (Form GST RFD-11).
            </span>
          )}
        </p>
      </div>

      {r4 && !r4Error && (
        <>
          <div className="grid gap-px border-b border-border bg-border sm:grid-cols-4">
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Zero-rated turnover</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(Number(r4.zero_rated_turnover_total), { showZero: true })}
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Net ITC</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(Number(r4.net_itc), { showZero: true })}
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Adjusted total turnover</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(Number(r4.adjusted_total_turnover), { showZero: true })}
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Refund amount</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-success">
                {formatINR(refund4, { showZero: true })}
              </div>
            </div>
          </div>

          <table className="w-full min-w-[720px] text-sm">
            <tbody>
              <tr className="border-b border-border">
                <td className={td}>Export under LUT (supply_type = export_lut)</td>
                <td className={num}>{formatINR(Number(r4.export_lut_turnover), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Supply to SEZ under LUT (zero tax actually posted)</td>
                <td className={num}>{formatINR(Number(r4.sez_zero_tax_turnover), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border text-ink-faint">
                <td className={td}>&nbsp;&nbsp;of which goods</td>
                <td className={num}>{formatINR(Number(r4.zero_rated_turnover_goods), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border text-ink-faint">
                <td className={td}>&nbsp;&nbsp;of which services</td>
                <td className={num}>{formatINR(Number(r4.zero_rated_turnover_services), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border bg-bg font-semibold">
                <td className={td}>= Turnover of zero-rated supply</td>
                <td className={num}>{formatINR(Number(r4.zero_rated_turnover_total), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Net ITC (eligible input tax, taxable purchases only — Sec 17(5) and exempt-linked credit excluded)</td>
                <td className={num}>{formatINR(Number(r4.net_itc), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border text-ink-faint">
                <td className={td}>&nbsp;&nbsp;excluded (blocked / exempt-linked)</td>
                <td className={num}>{formatINR(Number(r4.blocked_or_exempt_linked_itc_excluded), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Total turnover, this registration (F)</td>
                <td className={num}>{formatINR(Number(r4.total_turnover), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border text-ink-faint">
                <td className={td}>&minus; Exempt turnover (nil-rated / exempt / non-GST)</td>
                <td className={num}>({formatINR(Number(r4.exempt_turnover), { showZero: true })})</td>
              </tr>
              <tr className="border-b border-border bg-bg font-semibold">
                <td className={td}>= Adjusted total turnover</td>
                <td className={num}>{formatINR(Number(r4.adjusted_total_turnover), { showZero: true })}</td>
              </tr>
              <tr className="border-b-2 border-border-strong bg-success-soft font-semibold text-success">
                <td className={td}>Refund amount (Rule 89(4))</td>
                <td className={num}>{formatINR(refund4, { showZero: true })}</td>
              </tr>
            </tbody>
          </table>

          {zeroRatedRows.length > 0 && (
            <>
              <div className="border-b border-t border-border p-4">
                <h3 className="text-sm font-semibold">Zero-rated invoices counted above</h3>
              </div>
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className={th}>Date</th>
                    <th className={th}>Number</th>
                    <th className={th}>Party</th>
                    <th className={th}>Supply type</th>
                    <th className={th + " text-right"}>Taxable value</th>
                  </tr>
                </thead>
                <tbody>
                  {zeroRatedRows.map((r) => (
                    <tr key={r.voucher_id} className="border-b border-border last:border-0">
                      <td className={td}>{formatDate(r.voucher_date)}</td>
                      <td className={td}>{r.voucher_number}</td>
                      <td className={td}>{r.party_name}</td>
                      <td className={td}>{r.supply_type === "export_lut" ? "Export (LUT)" : "SEZ (zero tax)"}</td>
                      <td className={num}>{formatINR(Number(r.taxable_value), { showZero: true })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      <div className="space-y-2 border-t border-border px-4 py-3 text-xs text-ink-faint">
        <p>
          &ldquo;Turnover of zero-rated supply&rdquo; and Net ITC both use this app&rsquo;s posted invoice values as
          a working proxy. Two statutory refinements are <strong>not</strong> applied: the 1.5×-domestic-value cap
          on goods turnover (no &ldquo;like goods domestically supplied&rdquo; reference value is recorded anywhere
          in this app), and the payments-received basis for services turnover (no bill-wise receipt allocation is
          tracked — the same gap the 180-day and outstanding reports carry). Net ITC also cannot exclude ITC on
          capital goods, since items has no capital-goods flag distinguishing a machine bought on a purchase
          invoice from ordinary trading stock — a genuine capital purchase in this period will overstate Net ITC
          here. Any Rule 42/43 common-credit reversal for the same period (see the{" "}
          <Link href={`/${companyId}/reports/common-credit-apportionment`} className="underline">
            common-credit apportionment report
          </Link>
          ) is not netted out automatically either.
        </p>
      </div>

      {/* ============================== Rule 89(5) ============================== */}
      {r5Error && (
        <div className="m-4 rounded-md bg-error-soft px-4 py-3 text-sm text-error">
          Could not compute Rule 89(5): {r5Error.message}
        </div>
      )}

      <div className="border-b border-t border-border bg-bg p-4">
        <h2 className="font-display text-lg font-semibold text-ink">Rule 89(5) — inverted duty structure</h2>
        <Badge tone="warn" className="mt-1">
          Approximation — not claim-ready
        </Badge>
        <p className="mt-1 text-xs text-ink-faint">
          Max refund = (Turnover of inverted-rated supply × Net ITC ÷ Adjusted Total Turnover) &minus; tax payable
          on that turnover. This app has no per-transaction link from a specific sale back to the specific rated
          inputs that fed it, so an output item is flagged only when its own GST rate is below the period&rsquo;s
          <strong> aggregate</strong> eligible-input rate — a company-wide proxy, not a genuine input-to-output
          trace. Treat this as a signal to investigate, not a number to file.
        </p>
      </div>

      {r5 && !r5Error && (
        <>
          <div className="grid gap-px border-b border-border bg-border sm:grid-cols-4">
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Aggregate input rate</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {Number(r5.aggregate_input_rate_percent).toFixed(2)}%
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Inverted-rated turnover (approx.)</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(Number(r5.inverted_rated_turnover), { showZero: true })}
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Tax payable on it</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(Number(r5.tax_payable_on_inverted_turnover), { showZero: true })}
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Maximum refund amount</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-success">
                {formatINR(refund5, { showZero: true })}
                {Number(r5.refund_amount) < 0 && <span className="ml-1 text-xs text-ink-faint">(nil — formula went negative)</span>}
              </div>
            </div>
          </div>

          <table className="w-full min-w-[720px] text-sm">
            <tbody>
              <tr className="border-b border-border">
                <td className={td}>Turnover of inverted-rated supply (approx.)</td>
                <td className={num}>{formatINR(Number(r5.inverted_rated_turnover), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Net ITC (same basis as Rule 89(4) above)</td>
                <td className={num}>{formatINR(Number(r5.net_itc), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border">
                <td className={td}>Adjusted total turnover</td>
                <td className={num}>{formatINR(Number(r5.adjusted_total_turnover), { showZero: true })}</td>
              </tr>
              <tr className="border-b border-border bg-bg font-semibold">
                <td className={td}>= Turnover × Net ITC ÷ ATT</td>
                <td className={num}>
                  {formatINR(
                    Number(r5.adjusted_total_turnover) === 0
                      ? 0
                      : (Number(r5.inverted_rated_turnover) * Number(r5.net_itc)) / Number(r5.adjusted_total_turnover),
                    { showZero: true }
                  )}
                </td>
              </tr>
              <tr className="border-b border-border text-ink-faint">
                <td className={td}>&minus; Tax payable on inverted-rated turnover</td>
                <td className={num}>({formatINR(Number(r5.tax_payable_on_inverted_turnover), { showZero: true })})</td>
              </tr>
              <tr className="border-b-2 border-border-strong bg-success-soft font-semibold text-success">
                <td className={td}>= Maximum refund amount (Rule 89(5) formula)</td>
                <td className={num}>{formatINR(raw89_5, { showZero: true })}</td>
              </tr>
              {raw89_5 < 0 && (
                <tr className="border-b border-border text-ink-faint">
                  <td className={td}>Negative means nil refund, not a refund owed the other way</td>
                  <td className={num}>{formatINR(0, { showZero: true })}</td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="border-b border-t border-border p-4">
            <h3 className="text-sm font-semibold">Output items examined this period</h3>
            <p className="mt-0.5 text-xs text-ink-faint">
              Domestic taxable sales only — zero-rated exports/SEZ and nil-rated/exempt output are excluded (the
              first refunded, if at all, via Rule 89(4) above; the second by Sec 54(3)&rsquo;s own proviso).
            </p>
          </div>
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Item</th>
                <th className={th}>HSN/SAC</th>
                <th className={th + " text-right"}>Output rate</th>
                <th className={th + " text-right"}>Taxable turnover</th>
                <th className={th}>Flagged</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-ink-faint">
                    No domestic taxable output items in this period.
                  </td>
                </tr>
              )}
              {items.map((it) => (
                <tr key={it.item_id} className="border-b border-border last:border-0">
                  <td className={td}>{it.item_name}</td>
                  <td className={td}>{it.hsn_sac ?? "—"}</td>
                  <td className={num}>{Number(it.output_gst_rate_percent).toFixed(2)}%</td>
                  <td className={num}>{formatINR(Number(it.taxable_turnover), { showZero: true })}</td>
                  <td className={td}>
                    {it.is_flagged_inverted_rated ? (
                      <Badge tone="warn">Below input rate</Badge>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="space-y-2 border-t border-border px-4 py-3 text-xs text-ink-faint">
        <p>
          This app has no bill-of-materials-to-sale genealogy that would let it say WHICH specific rated inputs
          went into a specific sale, so the flag above compares each output item&rsquo;s own rate to the
          period&rsquo;s single aggregate input rate rather than that item&rsquo;s real input mix. A genuine RFD-01
          claim needs the filer&rsquo;s own knowledge of that mix — use this list to decide where to look, not as a
          number to copy.
        </p>
      </div>
    </ReportShell>
  );
}
