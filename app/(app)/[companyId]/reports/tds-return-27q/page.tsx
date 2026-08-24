import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";
import { TdsDeducteeTable, type LdcInfo, type TdsDeducteeRow } from "@/components/reports/TdsDeducteeTable";
import { TdsChallanTable, type TdsChallanRow } from "@/components/reports/TdsChallanTable";
import { quarterBounds, shiftQuarter, challanWindow } from "@/components/reports/tdsReturnQuarters";

/**
 * Form 144 (was Form 27Q) prep — TDS on payments to NON-RESIDENTS (Sec 195/
 * 195A/196 etc — recodified under Sec 393, same as every other TDS section
 * in this app; confirmed by WebSearch this session, incl. the renumbering
 * itself: 27Q -> 144, alongside 24Q -> 138, 26Q -> 140, 27EQ -> 143, all
 * effective 1 Apr 2026 under the Income-tax Act, 2025).
 *
 * A GENUINE SCHEMA GAP, STATED RATHER THAN GUESSED AROUND: 27Q's entire
 * reason to exist as a SEPARATE return from 26Q is that its deductees are
 * non-residents. LEKHA has no way to know that. Checked live, twice, this
 * session:
 *   1. ledgers (0006) carries no residency/country flag at all — gstin,
 *      state_code and gst_registration_type are all GST concepts, and
 *      'overseas'/'sez' registration types are not a reliable proxy for
 *      income-tax residency either (a resident Indian branch invoicing
 *      inter-state is not "overseas"; an actual non-resident payee for a
 *      195 payment — e.g. a foreign consultant paid a one-off fee — often
 *      has no GST registration record on the ledger at all).
 *   2. ref_tds_sections (0022) seeds exactly 10 section codes, all of them
 *      domestic (194-series). No 195/195A/196 code exists, and
 *      ledgers.default_tds_section is FK-constrained to this table (0022),
 *      so a deductee ledger cannot even be TAGGED with a non-resident
 *      section today — confirmed against the live table this session.
 * So get_tds_deductee_summary (0053) — built for 26Q — cannot be filtered
 * to "non-resident deductees only" by any column this schema has. Rather
 * than fabricate a filter (e.g. guessing off gst_registration_type, which
 * would silently exclude real 195 deductees and include unrelated ones),
 * this page calls the SAME summary as 26Q, UNFILTERED, and says so above
 * the table. Building an actual is_non_resident flag is a real, separate
 * gap this task does not close — see caveats_for_integration.
 */
export default async function TdsReturn27qPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/tds-return-27q">) {
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
      <ReportShell title="TDS return prep — Form 144 (27Q)" period={label}>
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

  const base = `/${companyId}/reports/tds-return-27q`;

  return (
    <ReportShell
      title="TDS return prep — Form 144 (27Q)"
      period={`${label} · prep data, not an FVU-ready file`}
      status={{
        label: `${formatINR(totalTds, { showZero: true })} deducted (ALL deductees) · ${formatINR(totalChallan, { showZero: true })} deposited`,
        // Always "warn", never "ok": totalTds here is every deductee, not
        // the non-resident-only figure 27Q actually needs, so a clean
        // reconciliation would be misleadingly reassuring on this page.
        tone: "warn",
      }}
    >
      <div className="border-b border-border bg-warning-soft p-4 text-sm">
        <p className="font-semibold text-warning">This report cannot filter to non-resident deductees</p>
        <p className="mt-1 text-xs text-ink-faint">
          Form 144/27Q exists specifically for TDS on payments to non-residents (Sec 195/195A/196 etc). LEKHA has no
          residency flag on any ledger, and its TDS section reference data seeds only the 10 domestic (194-series)
          sections — no 195-series code exists, so a deductee ledger cannot even be tagged as a non-resident payee
          today. The table below is the SAME full deductee-wise summary 26Q shows, not pre-filtered in any way —
          identify which rows below are actually non-resident payments before using this for 27Q. See the full
          explanation at the foot of this page.
        </p>
      </div>

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
          <div className="font-medium">144 (Form 27Q under the 1961 Act)</div>
        </div>
      </div>

      <div className="border-b border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Challan summary <Badge tone="neutral">tax_payments</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Every TDS challan payment recorded for this company, dated {from} to {depositTo}. This same list also
          appears on the 24Q and 26Q pages — OLTAS challan 281 does not itself record which return it funds.
        </p>
      </div>
      <TdsChallanTable rows={challans} />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Deductee-wise TDS — ALL deductees, not filtered to non-residents <Badge tone="warn">unfiltered</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Every TDS deduction this quarter, attributed to a deductee when exactly one TDS-deductee-flagged ledger
          appears on the same voucher — identical query to /reports/tds-return-26q. Rows for RESIDENT deductees do
          not belong on an actual 27Q filing; only manual review can tell them apart here.
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
        This is filing PREP DATA laid out in Form 144&rsquo;s (27Q&rsquo;s) own section shape — deductor details,
        challan summary, deductee-wise detail — not an FVU-ready upload file, and unlike the 26Q/24Q pages it is NOT
        even scoped to the right set of deductees: LEKHA has no residency flag anywhere in its schema (confirmed live
        this session — no column on `ledgers`, and `ref_tds_sections` seeds no 195-series code, so
        `ledgers.default_tds_section`&rsquo;s own foreign key cannot represent one either), so this page cannot
        distinguish a non-resident payment from a domestic one and shows every deductee get_tds_deductee_summary
        (0053) returns for the quarter. Manual filing is not accepted: the actual return still has to be prepared in
        Protean/NSDL&rsquo;s Return Preparation Utility and validated through the File Validation Utility before
        upload. This report was not able to confirm the FVU flat-file&rsquo;s exact byte-level field positions with
        confidence, so it does not attempt to produce one. Section/PAN reflect the ledger&rsquo;s CURRENT master
        data. Nothing here is submitted anywhere — LEKHA has no TRACES or e-filing portal access.
      </p>
    </ReportShell>
  );
}
