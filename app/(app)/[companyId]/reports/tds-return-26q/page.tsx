import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";
import { TdsDeducteeTable, type LdcInfo, type TdsDeducteeRow } from "@/components/reports/TdsDeducteeTable";
import { TdsChallanTable, type TdsChallanRow } from "@/components/reports/TdsChallanTable";
import { quarterBounds, shiftQuarter, challanWindow } from "@/components/reports/tdsReturnQuarters";

/**
 * Form 140 (was Form 26Q) prep — TDS on all payments other than salary.
 * Deliberately a DATA export in the return's own section shape, not an
 * FVU-ready upload file — see the disclaimer at the foot of the page for
 * why, and 0072 (ITC-04 prep) for the precedent this follows: research
 * this session confirmed RPU/FVU remain mandatory for the actual upload
 * (manual filing is not accepted) but could not confirm the byte-level
 * field positions/lengths of that flat-file format with confidence, so
 * shipping a fabricated "FVU-shaped" file would be worse than this
 * checklist — a wrong file format is worse than an honest one.
 *
 * Three sections, matching how the actual return itself is organised:
 *   1. Deductor details        — company PAN/TAN (companies, 0003).
 *   2. Challan summary          — tax_payments (0079), tax_type = 'tds'.
 *   3. Annexure I (deductee-wise) — get_tds_deductee_summary (0053), read-
 *      only, unmodified.
 *
 * CHALLANS ARE SHOWN, NOT SPLIT, ACROSS 24Q/26Q/27Q. OLTAS challan 281 does
 * not itself record which return (24Q/26Q/27Q) it will be reported against
 * — that link is made in the return itself when a deductor allocates a
 * challan's deposited amount across deductee entries, and a single challan
 * can legitimately fund entries split across more than one return. LEKHA's
 * tax_payments.tds_section (0079) is a single free-text field per challan,
 * which cannot reliably be filtered per-return either. So every TDS challan
 * in the deposit window is shown here, unfiltered, with that fact stated
 * rather than a guessed split — the same challan legitimately also appears
 * on the 24Q and 27Q pages.
 */
export default async function TdsReturn26qPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/tds-return-26q">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const qParam = typeof sp.q === "string" ? sp.q : undefined;
  const { from, to, label, qkey } = quarterBounds(qParam);
  const depositTo = challanWindow(to);

  const { data: modules } = await supabase.rpc("get_company_modules", { p_company_id: companyId });
  const tdsOn = (modules ?? []).some((m) => m.code === "tds" && m.active);

  if (!tdsOn) {
    return (
      <ReportShell title="TDS return prep — Form 140 (26Q)" period={label}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">TDS is not on for this company</p>
          <p className="mt-1">
            TDS activates once a TAN is set —{" "}
            <Link href={`/${companyId}/settings`} className="underline">
              Settings
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const [{ data: company }, { data: deducteeRows }, { data: challanRows }] = await Promise.all([
    supabase.from("companies").select("name, legal_name, pan, tan").eq("id", companyId).maybeSingle(),
    supabase.rpc("get_tds_deductee_summary", { p_company_id: companyId, p_period_start: from, p_period_end: to }),
    supabase
      .from("tax_payments")
      .select("id, payment_date, amount, bsr_code, challan_serial, tds_section, notes")
      .eq("company_id", companyId)
      .eq("tax_type", "tds")
      .gte("payment_date", from)
      .lte("payment_date", depositTo)
      .order("payment_date"),
  ]);

  const summary = (deducteeRows ?? []) as TdsDeducteeRow[];
  const attributed = summary.filter((r) => r.deductee_ledger_id);
  const unattributed = summary.filter((r) => !r.deductee_ledger_id);
  const totalTds = summary.reduce((n, r) => n + Number(r.tds_deducted), 0);

  const challans = (challanRows ?? []) as TdsChallanRow[];
  const totalChallan = challans.reduce((n, r) => n + Number(r.amount), 0);
  const reconciles = Math.abs(totalTds - totalChallan) < 1;

  const ledgerIds = attributed
    .map((r) => r.deductee_ledger_id)
    .filter((id): id is string => Boolean(id));
  const { data: ldcRows } =
    ledgerIds.length > 0
      ? await supabase
          .from("ledgers")
          .select("id, ldc_number, ldc_rate, ldc_valid_from, ldc_valid_to")
          .in("id", ledgerIds)
      : { data: [] as ({ id: string } & LdcInfo)[] };
  const ldcById = new Map<string, LdcInfo>((ldcRows ?? []).map((l) => [l.id, l]));

  const base = `/${companyId}/reports/tds-return-26q`;

  return (
    <ReportShell
      title="TDS return prep — Form 140 (26Q)"
      period={`${label} · prep data, not an FVU-ready file`}
      status={{
        label: `${formatINR(totalTds, { showZero: true })} deducted · ${formatINR(totalChallan, { showZero: true })} deposited`,
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
          <div className="text-[11px] uppercase tracking-wide text-ink-faint">Deductor</div>
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
          <div className="font-medium">140 (Form 26Q under the 1961 Act)</div>
        </div>
      </div>

      <div className="border-b border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Challan summary <Badge tone="neutral">tax_payments</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Every TDS challan payment recorded for this company, dated {from} to {depositTo} — extended 30 days past
          quarter-end to catch the last month&rsquo;s deposit, which under law is not due at the bank until the 7th of
          the following month (30th for a March deduction). This same list also appears on the 24Q and 27Q pages —
          OLTAS challan 281 does not itself record which return it funds; see the disclaimer below.
        </p>
      </div>
      <TdsChallanTable rows={challans} />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Annexure I — deductee-wise <Badge tone="neutral">quarterly</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Every TDS deduction this quarter, attributed to a deductee when exactly one TDS-deductee-flagged ledger
          appears on the same voucher.
        </p>
      </div>
      <TdsDeducteeTable rows={attributed} ldcById={ldcById} />

      {unattributed.length > 0 && (
        <>
          <div className="border-b border-t border-border bg-warning-soft p-4">
            <h2 className="flex items-center gap-2 font-semibold text-warning">
              Needs review — could not attribute a single deductee
            </h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              These vouchers had a TDS Payable line but zero or more than one ledger flagged as a TDS deductee on the
              same voucher. Open each voucher directly to confirm who the deduction was against.
            </p>
          </div>
          <TdsDeducteeTable rows={unattributed} />
        </>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        This is filing PREP DATA laid out in Form 140&rsquo;s (26Q&rsquo;s) own section shape — deductor details,
        challan summary, Annexure I — not an FVU-ready upload file. Manual filing is not accepted: the actual return
        still has to be prepared in Protean/NSDL&rsquo;s Return Preparation Utility and validated through the File
        Validation Utility before upload to the income tax portal, exactly as before. This report was not able to
        confirm the FVU flat-file&rsquo;s exact byte-level field positions and lengths with confidence, so it does not
        attempt to produce one — an unconfirmed byte-exact file would be a wrong file format, which is worse than
        this checklist. Deductee section/PAN reflect the ledger&rsquo;s CURRENT master data, not necessarily what was
        true on the historical voucher date. Threshold applicability and Sec 234E late-fee/Sec 271H penalty exposure
        are not computed. Nothing here is submitted anywhere — LEKHA has no TRACES or e-filing portal access.
      </p>
    </ReportShell>
  );
}
