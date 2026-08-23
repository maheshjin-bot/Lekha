import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { KpiTile } from "@/components/ui/KpiTile";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

const TIER_LABEL: Record<string, string> = {
  core: "Always on",
  conditional: "Set by your profile",
  optional: "Your choice",
};

const SEVERITY_TONE: Record<string, "warn" | "bad"> = { warn: "warn", bad: "bad" };

export default async function CompanyPage({
  params,
}: PageProps<"/[companyId]">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: profile }, { data: modules }, { data: branches }, { data: kpis }, { data: attention }] =
    await Promise.all([
      supabase.rpc("get_company_profile", { p_company_id: companyId }),
      supabase.rpc("get_company_modules", { p_company_id: companyId }),
      supabase
        .from("branches")
        .select("id, code, name, state_code, is_head_office")
        .eq("company_id", companyId)
        .order("is_head_office", { ascending: false }),
      supabase.rpc("get_dashboard_kpis", { p_company_id: companyId }),
      supabase.rpc("get_needs_attention", { p_company_id: companyId }),
    ]);

  const company = profile?.[0];
  if (!company) notFound();

  const active = (modules ?? []).filter((m) => m.active);
  const inactive = (modules ?? []).filter((m) => !m.active);
  const kpi = kpis?.[0];
  const attentionRows = attention ?? [];

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
          {company.name}
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          {company.entity_name} ·{" "}
          {company.compliance_mode === "compliance" ? "Books + compliance" : "Books only"}
        </p>
      </header>

      {/* The first thing an owner sees is not a chart — it's the answer to
          "where do I stand today, and what needs me right now?" */}
      {kpi && (
        <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label="Cash & Bank" value={formatINR(kpi.cash_bank, { showZero: true })} />
          <KpiTile
            label="Receivable"
            value={formatINR(kpi.receivables, { showZero: true })}
            delta={kpi.receivables_overdue > 0 ? `Overdue ${formatINR(kpi.receivables_overdue)}` : undefined}
            deltaTone={kpi.receivables_overdue > 0 ? "warn" : "neutral"}
          />
          <KpiTile label="GST Liability" value={formatINR(kpi.gst_liability, { showZero: true })} />
          <KpiTile label="TDS Payable" value={formatINR(kpi.tds_payable, { showZero: true })} />
        </section>
      )}

      <section className="mb-12 grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Needs your attention</h2>
          </div>
          {attentionRows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-faint">
              Nothing needs you right now.
            </p>
          ) : (
            <ul>
              {attentionRows.map((r, i) => (
                <li key={i}>
                  <Link
                    href={r.href ?? `/${companyId}`}
                    className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 text-sm transition-colors last:border-0 hover:bg-surface-2"
                  >
                    <span className="min-w-0 truncate">{r.label}</span>
                    <Badge tone={SEVERITY_TONE[r.severity] ?? "neutral"} className="shrink-0">
                      {r.detail || r.category}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">This company</h2>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 text-sm">
            <dt className="text-ink-faint">Statements</dt>
            <dd className="text-right font-medium">
              {company.statement_format === "schedule_iii" ? "Schedule III" : "Simple"}
            </dd>
            <dt className="text-ink-faint">Income tax return</dt>
            <dd className="text-right font-medium">{company.itr_form}</dd>
            <dt className="text-ink-faint">Tax audit report</dt>
            <dd className="text-right font-medium">
              {company.tax_audit_report_form.toUpperCase().replace("_OR_", " or ")}
            </dd>
            <dt className="text-ink-faint">Modules active</dt>
            <dd className="text-right font-medium">
              {active.length} of {modules?.length ?? 0}
            </dd>
          </dl>
        </Card>
      </section>

      {company.special_provisions?.length ? (
        <section className="mb-12 rounded-lg border border-warning/30 bg-warning-soft p-5">
          <h2 className="text-sm font-semibold text-warning">Applies to this entity type</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-warning">
            {company.special_provisions.map((p: string) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mb-12">
        <h2 className="mb-4 text-lg font-semibold">
          Active modules{" "}
          <span className="text-sm font-normal text-ink-faint">
            {active.length} of {modules?.length ?? 0}
          </span>
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {active.map((m) => (
            <li key={m.code} className="rounded-md border border-border bg-surface p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{m.name}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">
                  {TIER_LABEL[m.tier]}
                </span>
              </div>
              {m.locked_reason && (
                <p className="mt-1 text-xs text-ink-faint">{m.locked_reason}</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-12">
        <h2 className="mb-4 text-lg font-semibold">Available but off</h2>
        {inactive.length === 0 ? (
          <EmptyState>Every optional module is already on.</EmptyState>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {inactive.map((m) => (
              <li
                key={m.code}
                className="rounded border border-dashed border-border-strong px-2.5 py-1 text-xs text-ink-faint"
                title={m.locked_reason ?? m.description ?? undefined}
              >
                {m.name}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Branches</h2>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {branches?.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span className="font-mono text-xs text-ink-faint">{b.code}</span>
              <span className="font-medium">{b.name}</span>
              {b.is_head_office && (
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-soft">
                  Head office
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
