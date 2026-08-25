import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";
import { TcsCollecteeTable, type TcsCollecteeRow } from "@/components/reports/TcsCollecteeTable";
import { TdsChallanTable, type TdsChallanRow } from "@/components/reports/TdsChallanTable";
import { quarterBounds, shiftQuarter, challanWindow, financialYearLabel } from "@/components/reports/tdsReturnQuarters";

/**
 * Form 143 (was Form 27EQ) prep — quarterly TCS return under Sec 206C
 * (recodified Sec 394(1) of the Income-tax Act 2025). The TCS mirror of the
 * tds-return-26q page (Form 140/26Q) — same three-section shape (collector
 * details, challan summary, collectee-wise annexure), the same "prep data,
 * not an FVU-ready upload" honesty, for the same reason: RPU/FVU remain
 * mandatory for the actual e-filing upload and this session could not
 * confirm the flat-file's byte-level field positions with confidence. See
 * migration 0146 for full statutory sourcing.
 *
 * Reuses TdsChallanTable unmodified for the challan section — its column
 * shape (payment_date, bsr_code, challan_serial, tds_section reused as a
 * generic "section as recorded" field, amount) is tax_payments' own schema,
 * not TDS-specific, and OLTAS challan 281 does not tag itself to one return
 * for TCS either, exactly the same reason 24Q/26Q/27Q already share it.
 *
 * SCOPE, stated here and at the foot of the page, not silently assumed:
 *   - Sec 206C(1)/(1F) specified-goods and motor-vehicle TCS only. Sec
 *     206C(1G) (LRS/foreign remittance, overseas tour packages) is not
 *     representable by this schema — it is not an item sale, and nothing
 *     in create_invoice/create_voucher computes or posts it. A company
 *     that also collects TCS under 206C(1G) needs a separate feature.
 *   - Form 27C exemption declarations (buyer will use the goods for
 *     manufacturing, not resale — no TCS due) are not tracked anywhere in
 *     this schema, so a collectee showing zero TCS on a TCS-sectioned
 *     purchase cannot be distinguished here from a data-entry gap.
 */
export default async function TdsReturn27eqPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/tds-return-27eq">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const qParam = typeof sp.q === "string" ? sp.q : undefined;
  const { from, to, label, qkey, fyStart, qNum } = quarterBounds(qParam);
  const depositTo = challanWindow(to);

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const tcsOn = (modules ?? []).some((m) => m.code === "tcs" && m.active);

  if (!tcsOn) {
    return (
      <ReportShell title="TCS return prep — Form 143 (27EQ)" period={label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">TCS is not on for this company</p>
          <p className="mt-1">
            TCS activates once a TAN is set —{" "}
            <Link href={`/${companyId}/settings`} className="underline">
              Settings
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const [{ data: company }, { data: collecteeRows }, { data: challanRows }] = await Promise.all([
    supabase.from("companies").select("name, legal_name, pan, tan").eq("id", companyId).maybeSingle(),
    supabase.rpc("get_tcs_collectee_summary", {
      p_company_id: companyId,
      p_financial_year_label: financialYearLabel(fyStart),
      p_quarter: qNum,
    }),
    supabase
      .from("tax_payments")
      .select("id, payment_date, amount, bsr_code, challan_serial, tds_section, notes")
      .eq("company_id", companyId)
      .eq("tax_type", "tcs")
      .gte("payment_date", from)
      .lte("payment_date", depositTo)
      .order("payment_date"),
  ]);

  const summary = (collecteeRows ?? []) as TcsCollecteeRow[];
  const attributed = summary.filter((r) => r.collectee_ledger_id && r.section_code);
  const needsReview = summary.filter((r) => !r.collectee_ledger_id || !r.section_code);
  const totalTcs = summary.reduce((n, r) => n + Number(r.tcs_collected), 0);

  const challans = (challanRows ?? []) as TdsChallanRow[];
  const totalChallan = challans.reduce((n, r) => n + Number(r.amount), 0);
  const reconciles = Math.abs(totalTcs - totalChallan) < 1;

  const base = `/${companyId}/reports/tds-return-27eq`;

  return (
    <ReportShell
      title="TCS return prep — Form 143 (27EQ)"
      period={`${label} · prep data, not an FVU-ready file`}
      status={{
        label: `${formatINR(totalTcs, { showZero: true })} collected · ${formatINR(totalChallan, { showZero: true })} deposited`,
        tone: reconciles ? "ok" : "warn",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="flex items-center gap-2 text-sm">
          <Link href={`${base}?q=${shiftQuarter(qkey, -1)}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            ← Prev
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link href={`${base}?q=${shiftQuarter(qkey, 1)}`} className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2">
            Next →
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 border-b border-border p-4 text-sm sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Collector</div>
          <div className="font-medium">{company?.legal_name || company?.name || "—"}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">PAN</div>
          <div className="font-mono">{company?.pan || <span className="text-error">not set</span>}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">TAN</div>
          <div className="font-mono">{company?.tan || <span className="text-error">not set</span>}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Form</div>
          <div className="font-medium">143 (Form 27EQ under the 1961 Act)</div>
        </div>
      </div>

      <div className="border-b border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Challan summary <Badge tone="neutral">tax_payments</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Every TCS challan payment recorded for this company, dated {from} to {depositTo} — extended 30 days past
          quarter-end to catch the last month&rsquo;s deposit. OLTAS challan 281 does not itself record which return
          it funds, the same reason this list format is shared with the TDS return pages.
        </p>
      </div>
      <TdsChallanTable rows={challans} />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Annexure — collectee-wise <Badge tone="neutral">quarterly</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Every TCS collection this quarter, one row per collectee per Sec 206C section — the buyer is read directly
          off the sales/credit-note invoice, and a buyer charged TCS under more than one section in the period
          appears on more than one row.
        </p>
      </div>
      <TcsCollecteeTable rows={attributed} />

      {needsReview.length > 0 && (
        <>
          <div className="border-b border-t border-border bg-warning-soft p-4">
            <h2 className="flex items-center gap-2 font-semibold text-warning">
              Needs review — collectee or section could not be attributed
            </h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Either the voucher had no party ledger on file, or its item lines carried more than one different TCS
              section (this schema attributes a voucher&rsquo;s TCS total to one section only when every
              TCS-sectioned item on it agrees). Open each voucher directly to confirm the section split by hand.
            </p>
          </div>
          <TcsCollecteeTable rows={needsReview} />
        </>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        This is filing PREP DATA laid out in Form 143&rsquo;s (27EQ&rsquo;s) own section shape — collector details,
        challan summary, collectee-wise annexure — not an FVU-ready upload file. Manual filing is not accepted: the
        actual return still has to be prepared in Protean/NSDL&rsquo;s Return Preparation Utility and validated
        through the File Validation Utility before upload, exactly as 26Q. Only Sec 206C(1) specified-goods TCS
        (scrap, minerals, liquor, timber, tendu leaves) and Sec 206C(1F) motor-vehicle TCS are covered — both driven
        by items.default_tcs_section on the invoice. Sec 206C(1G) TCS on outward foreign remittance under LRS and
        overseas tour packages is NOT covered: it is not an item sale, and nothing in this schema&rsquo;s invoicing
        path computes or posts it. Form 27C exemption declarations (buyer will use the goods for manufacturing, not
        resale) are not tracked anywhere in this schema, so a collectee shown with zero TCS on a TCS-sectioned
        purchase cannot be told apart here from a data-entry gap. Section and PAN reflect the ledger&rsquo;s CURRENT
        master data, not necessarily what was true on the historical voucher date. Sec 206C(7) interest for late
        collection/deposit and the Sec 271CA penalty are not computed. Nothing here is submitted anywhere — LEKHA
        has no TRACES or e-filing portal access.
      </p>
    </ReportShell>
  );
}
