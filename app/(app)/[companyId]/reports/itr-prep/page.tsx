import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ReportShell, td, th } from "@/components/reports/ReportShell";
import { ItrDownloadPanel } from "@/components/itr/ItrDownloadPanel";
import {
  buildItrJson,
  FIXED_PERIOD,
  type BalanceSheetRow,
  type ProfitLossRow,
} from "@/lib/itr/build-itr-json";
import { isSupportedItrForm, type SupportedItrForm } from "@/lib/itr/types";

const FORM_LABEL: Record<SupportedItrForm, string> = {
  "ITR-3": "ITR-3 — Individuals & HUFs with business/profession income",
  "ITR-5": "ITR-5 — Firms, LLPs, AOPs/BOIs, co-operative societies",
  "ITR-6": "ITR-6 — Companies not claiming Sec 11 exemption",
};

export default async function ItrPrepPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/itr-prep">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const [{ data: profileRows }, { data: companyRow }] = await Promise.all([
    supabase.rpc("get_company_profile", { p_company_id: companyId }),
    supabase
      .from("companies")
      .select("id, name, legal_name, entity_type, pan, cin, incorporation_date, company_tax_regime")
      .eq("id", companyId)
      .single(),
  ]);

  const profile = profileRows?.[0];
  const autoForm = profile?.itr_form as string | undefined;

  if (autoForm && !isSupportedItrForm(autoForm)) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <header className="mb-8">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">ITR JSON prep</h1>
          <p className="mt-1 text-sm text-ink-soft">{profile?.name}</p>
        </header>
        <div className="rounded-[14px] border border-border bg-surface p-6 text-sm text-ink">
          <p className="font-medium">This entity&rsquo;s return ({autoForm}) is out of scope for this builder.</p>
          <p className="mt-2 text-ink-soft">
            This tool covers ITR-3, ITR-5 and ITR-6 only. {profile?.entity_name ?? "This entity type"} maps to{" "}
            {autoForm}, which is built around Sec 11-13 registration status, voluntary contributions, and an
            application-of-income schedule — an entirely different shape this app has no source data for at all
            (it is not a smaller version of ITR-3/5/6; there is nothing here it would be honest to prefill).
            Prepare {autoForm} directly in the Income Tax Department&rsquo;s own offline utility.
          </p>
        </div>
      </main>
    );
  }

  const requestedForm = typeof sp.form === "string" ? sp.form : undefined;
  const form: SupportedItrForm =
    requestedForm && isSupportedItrForm(requestedForm) ? requestedForm : isSupportedItrForm(autoForm) ? autoForm : "ITR-3";
  const overridden = isSupportedItrForm(autoForm) && form !== autoForm;

  const [
    { data: taxComp },
    { data: bsRows },
    { data: plRows },
    { data: auditRows },
    { data: headOfficeRows },
    { data: gstRegRows },
  ] = await Promise.all([
    supabase.rpc("get_income_tax_computation", { p_company_id: companyId, p_fy_start: FIXED_PERIOD.fyStart, p_fy_end: FIXED_PERIOD.fyEnd }),
    supabase.rpc("get_balance_sheet", { p_company_id: companyId, p_as_at: FIXED_PERIOD.fyEnd }),
    supabase.rpc("get_profit_and_loss", { p_company_id: companyId, p_from: FIXED_PERIOD.fyStart, p_to: FIXED_PERIOD.fyEnd }),
    supabase.rpc("get_tax_audit_applicability", { p_company_id: companyId, p_fy_start: FIXED_PERIOD.fyStart, p_fy_end: FIXED_PERIOD.fyEnd }),
    supabase.from("branches").select("address_line1, address_line2, city, pincode, state_code").eq("company_id", companyId).eq("is_head_office", true).limit(1),
    supabase.from("gst_registrations").select("state_code").eq("company_id", companyId).eq("is_active", true).order("created_at").limit(1),
  ]);

  const headOffice = headOfficeRows?.[0]
    ? { ...headOfficeRows[0], state_code: headOfficeRows[0].state_code ?? gstRegRows?.[0]?.state_code ?? null }
    : gstRegRows?.[0]
      ? { address_line1: null, address_line2: null, city: null, pincode: null, state_code: gstRegRows[0].state_code }
      : null;

  const result = buildItrJson({
    form,
    company: {
      id: companyId,
      name: companyRow?.name ?? profile?.name ?? "Company",
      legal_name: companyRow?.legal_name ?? null,
      entity_type: companyRow?.entity_type ?? profile?.entity_type ?? "",
      pan: companyRow?.pan ?? null,
      cin: companyRow?.cin ?? null,
      incorporation_date: companyRow?.incorporation_date ?? null,
      company_tax_regime: companyRow?.company_tax_regime ?? null,
      statutory_audit_rule: profile?.statutory_audit_rule ?? null,
    },
    balanceSheet: ((bsRows ?? []) as BalanceSheetRow[]).map((r) => ({ ...r, amount: Number(r.amount) })),
    profitLoss: ((plRows ?? []) as ProfitLossRow[]).map((r) => ({ ...r, amount: Number(r.amount) })),
    taxComputation: taxComp?.[0]
      ? {
          applicable: taxComp[0].applicable,
          note: taxComp[0].note,
          business_income: Number(taxComp[0].business_income),
          short_term_capital_gain: Number(taxComp[0].short_term_capital_gain),
          short_term_capital_loss: Number(taxComp[0].short_term_capital_loss),
          gross_total_income: Number(taxComp[0].gross_total_income),
          taxable_income: Number(taxComp[0].taxable_income),
          tax_before_rebate: Number(taxComp[0].tax_before_rebate),
          rebate_87a: Number(taxComp[0].rebate_87a),
          tax_after_rebate: Number(taxComp[0].tax_after_rebate),
          surcharge: Number(taxComp[0].surcharge),
          cess: Number(taxComp[0].cess),
          total_tax: Number(taxComp[0].total_tax),
          advance_tax_paid: Number(taxComp[0].advance_tax_paid),
          self_assessment_tax_paid: Number(taxComp[0].self_assessment_tax_paid),
          tds_tcs_credit: Number(taxComp[0].tds_tcs_credit),
          net_tax_payable: Number(taxComp[0].net_tax_payable),
        }
      : null,
    taxAudit: auditRows?.[0] ? { audit_required: auditRows[0].audit_required, turnover: Number(auditRows[0].turnover) } : null,
    headOffice,
  });

  const fileStem = (companyRow?.name ?? "company").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return (
    <ReportShell
      title="ITR JSON prep"
      period={`FY ${FIXED_PERIOD.fyLabel} (1 Apr 2025 – 31 Mar 2026) — Assessment Year ${FIXED_PERIOD.ay}`}
      status={
        result.structuralCheck.missing.length === 0
          ? { label: "Structurally complete", tone: "ok" }
          : { label: `${result.structuralCheck.missing.length} required field(s) missing`, tone: "bad" }
      }
    >
      <div className="border-b border-border px-4 py-3 text-sm text-ink-soft">
        Builds the JSON file the Income Tax Department&rsquo;s own offline utility can import — not a filed return. This
        app has no e-filing portal integration, ERI licence, or DSC/Aadhaar-OTP/EVC authentication, and could not
        lawfully submit anything even if it tried. Download the file, open it in the utility, review every field,
        complete the schedules listed as out of scope below, and file from there.
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-sm">
        <span className="text-ink-faint">Form:</span>
        {(["ITR-3", "ITR-5", "ITR-6"] as const).map((f) => (
          <Link
            key={f}
            href={`?form=${f}`}
            className={
              "rounded-md border px-2.5 py-1 " +
              (form === f ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
            }
          >
            {f}
            {isSupportedItrForm(autoForm) && autoForm === f ? " (auto)" : ""}
          </Link>
        ))}
      </div>
      {overridden && (
        <div className="border-b border-border bg-warning-soft px-4 py-2.5 text-xs text-ink">
          This company&rsquo;s entity type ({profile?.entity_name}) auto-selects {autoForm}. You have overridden it to{" "}
          {form} — confirm that is actually correct for this filer before using the download.
        </div>
      )}

      <div className="px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">{FORM_LABEL[form]}</h2>
      </div>

      {result.warnings.length > 0 && (
        <div className="border-t border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          <p className="mb-1.5 font-medium">Review before filing</p>
          <ul className="list-disc space-y-1 pl-4">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Populated from LEKHA ({result.populated.length} fields)</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Every field below traces to a real LEKHA figure or is explicitly labelled as a structural placeholder.
          Everything else required by the schema and not listed here is a zero/blank placeholder the offline
          utility will show as empty.
        </p>
      </div>
      <div className="max-h-[480px] overflow-y-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-border text-left">
              <th className={th}>Field</th>
              <th className={th}>Value</th>
              <th className={th}>Source</th>
            </tr>
          </thead>
          <tbody>
            {result.populated.map((f) => (
              <tr key={f.path} className="border-b border-border last:border-0">
                <td className={td}>
                  {f.label}
                  <div className="font-mono text-[10px] text-ink-faint">{f.path}</div>
                </td>
                <td className={td + " font-mono text-xs"}>{typeof f.value === "number" ? f.value.toLocaleString("en-IN") : String(f.value)}</td>
                <td className={td + " text-xs text-ink-faint"}>{f.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Explicitly out of scope ({result.deferred.length} schedules)</h2>
      </div>
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Schedule</th>
            <th className={th}>Why it isn&rsquo;t populated</th>
          </tr>
        </thead>
        <tbody>
          {result.deferred.map((d) => (
            <tr key={d.schedule} className="border-b border-border last:border-0">
              <td className={td}>{d.schedule}</td>
              <td className={td + " text-ink-soft"}>{d.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="border-t border-border px-4 py-4">
        <ItrDownloadPanel
          json={result.json}
          filename={`${fileStem}-${form.toLowerCase()}-ay${FIXED_PERIOD.ay.replace("-", "")}.json`}
          form={form}
          entityType={companyRow?.entity_type ?? ""}
          rootDefName={form.replace("-", "")}
        />
      </div>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Structural check: {result.structuralCheck.requiredPathCount} required fields present against the real AY
        2026-27 schema vendored in lib/itr/gov-schemas.{" "}
        {result.structuralCheck.missing.length === 0
          ? "None missing."
          : `Missing: ${result.structuralCheck.missing.join(", ")}.`}{" "}
        This checks required-key presence only — not pattern/enum conformance or the utility&rsquo;s own business-rule
        validation, which remains the authoritative final check.
      </p>
    </ReportShell>
  );
}
