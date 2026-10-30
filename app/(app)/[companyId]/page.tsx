import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatINR, formatINRWithSymbol } from "@/lib/utils/currency";
import { periodPreset } from "@/lib/utils/period";
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

  // Needed up front (not inside the Promise.all below) because the
  // role-aware ordering below (company_members.role) has to filter on it —
  // company_members_read (0003) is `is_company_member(company_id)`, which
  // lets any active member read every member row for the company, not just
  // their own; without an explicit `.eq("user_id", user.id)` the first row
  // returned could belong to a co-worker, not the signed-in user. Same
  // gotcha app/(app)/[companyId]/approvals/page.tsx documents and guards
  // against the same way — several other pages in this codebase (trial
  // balance, branches, team settings) skip the `.eq("user_id", ...)` and
  // only happen to work for single-admin companies.
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  const [
    { data: profile },
    { data: modules },
    { data: branches },
    { data: kpis },
    { data: attention },
    { count: pendingNotifications },
    { data: unallocatedDebtor },
    { data: unallocatedCreditor },
    { data: membership },
  ] = await Promise.all([
      supabase.rpc("get_company_profile", { p_company_id: companyId }),
      supabase.rpc("get_company_modules", { p_company_id: companyId }),
      supabase
        .from("branches")
        .select("id, code, name, state_code, is_head_office")
        .eq("company_id", companyId)
        .order("is_head_office", { ascending: false }),
      supabase.rpc("get_dashboard_kpis", { p_company_id: companyId }),
      supabase.rpc("get_needs_attention", { p_company_id: companyId }),
      // Notifications (0122) — RLS-filtered head count, so a non-admin sees
      // only their own; an admin sees the company's. Purely a badge on the
      // link below; the actual list lives at /notifications.
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("status", "pending"),
      // Unallocated settlements (G2) — receipts/payments nobody has pointed
      // at a bill yet. get_unallocated_settlements (1490) predates the
      // generated types, same `as any` escape hatch the /allocations screen
      // itself uses. Its default args (p_as_at = today, p_include_allocated
      // = false) already filter to on_account > 0, so a bare company+role
      // call is exactly "what still needs a person's attention" — no extra
      // client-side filtering needed. Two calls (debtor/creditor), not one:
      // the RPC takes a single p_role and there is no combined variant, and
      // rule 6 forbids inventing one.
      supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        .rpc("get_unallocated_settlements" as any, { p_company_id: companyId, p_role: "debtor" }),
      supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        .rpc("get_unallocated_settlements" as any, { p_company_id: companyId, p_role: "creditor" }),
      // The signed-in user's own role in THIS company, for the role-aware
      // ordering below — see the comment above `user` for why `user.id` has
      // to be in the filter, not just `company_id`.
      user
        ? supabase
            .from("company_members")
            .select("role")
            .eq("company_id", companyId)
            .eq("user_id", user.id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  const company = profile?.[0];
  if (!company) notFound();

  // Role-aware ordering (Phase 1 audit item #2). company_members.role is a
  // three-way CHECK ('admin','accountant','auditor' — 0003), not a literal
  // Owner/Accountant/CA/Staff taxonomy, so this maps pragmatically: admin
  // keeps the owner-style ordering that shipped before this change (cash
  // position and profit first, compliance numbers and the action feed
  // after); accountant and auditor — the schema's only non-admin roles,
  // both compliance-facing in practice — get a compliance/action-first
  // ordering instead. A null role (should not happen; get_company_profile
  // above would already have 404'd a non-member) defensively falls back to
  // the owner-style default rather than guessing.
  const complianceFirst = membership?.role === "accountant" || membership?.role === "auditor";

  // Profit · This Month (Phase 1 audit item #1) — reuses get_profit_and_loss
  // (0009/0210) exactly as the Profit & Loss report does
  // (app/(app)/[companyId]/reports/profit-loss/page.tsx: netProfit = direct
  // + indirect income minus direct + indirect expense), rather than
  // duplicating that computation in SQL. periodPreset's "currentMonth"/
  // "previousMonth" keys (lib/utils/period.ts) are calendar-month, not
  // FY-relative — startMonth is threaded through anyway for the same reason
  // every other report page does, and because a future preset could become
  // FY-relative without this call site needing to change. get_profit_and_loss
  // already filters `not v.is_deleted` server-side, the same soft-delete
  // convention every other balance/report RPC in this codebase uses.
  const startMonth = company.financial_year_start_month ?? 4;
  const thisMonth = periodPreset("currentMonth", startMonth);
  const prevMonth = periodPreset("previousMonth", startMonth);

  const [{ data: plThisMonth }, { data: plPrevMonth }] = await Promise.all([
    supabase.rpc("get_profit_and_loss", {
      p_company_id: companyId,
      p_from: thisMonth.from,
      p_to: thisMonth.to,
    }),
    supabase.rpc("get_profit_and_loss", {
      p_company_id: companyId,
      p_from: prevMonth.from,
      p_to: prevMonth.to,
    }),
  ]);

  const netProfit = (rows: { nature: string; amount: number }[] | null) =>
    (rows ?? []).reduce(
      (n, r) => n + (r.nature.includes("income") ? 1 : -1) * Number(r.amount),
      0
    );
  const thisMonthProfit = netProfit(plThisMonth);
  const prevMonthProfit = netProfit(plPrevMonth);

  // "vs last month" is a full prior calendar month against a month-to-date
  // figure, so it is directional, not a precise comparison — the same
  // caveat any month-to-date KPI carries. formatVariance's own convention
  // (reports/profit-loss/page.tsx): an em dash when there is nothing
  // meaningful to divide by (a zero-profit prior month), never a fake 0% or
  // "Infinity%".
  const profitDeltaPct =
    prevMonthProfit !== 0 ? ((thisMonthProfit - prevMonthProfit) / Math.abs(prevMonthProfit)) * 100 : null;
  const profitDelta =
    profitDeltaPct === null
      ? undefined
      : `${profitDeltaPct >= 0 ? "+" : ""}${profitDeltaPct.toFixed(1)}% vs last month`;
  const profitDeltaTone: "ok" | "bad" | "neutral" =
    profitDeltaPct === null ? "neutral" : profitDeltaPct >= 0 ? "ok" : "bad";

  const active = (modules ?? []).filter((m) => m.active);
  const inactive = (modules ?? []).filter((m) => !m.active);
  const kpi = kpis?.[0];

  // A sibling row on top of get_needs_attention's own list, not a
  // replacement for it: an unallocated receipt/payment isn't wrong the way
  // an overdue invoice or a pending approval is, so it isn't worth teaching
  // the SQL function a new opinion about severity — it just needs a door
  // back to /allocations when there is one to open. An empty needs-attention
  // list must stay empty, so this only appends when the combined count is
  // actually nonzero (never a "0 unallocated" row nobody would ever act on).
  const unallocatedRows = [...(unallocatedDebtor ?? []), ...(unallocatedCreditor ?? [])] as unknown as Array<{
    on_account: number;
  }>;
  const unallocatedCount = unallocatedRows.length;
  const attentionRows = attention ?? [];
  if (unallocatedCount > 0) {
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    const unallocatedTotal = round2(unallocatedRows.reduce((n, r) => n + Number(r.on_account ?? 0), 0));
    attentionRows.push({
      category: "Allocations",
      label: `${unallocatedCount} ${unallocatedCount === 1 ? "receipt/payment" : "receipts/payments"} awaiting allocation`,
      detail: `totalling ${formatINRWithSymbol(unallocatedTotal)}`,
      severity: "warn",
      href: `/${companyId}/allocations`,
    });
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
            {company.name}
          </h1>
          <p className="mt-2 text-sm text-ink-soft">
            {company.entity_name} ·{" "}
            {company.compliance_mode === "compliance" ? "Books + compliance" : "Books only"}
          </p>
        </div>
        <Link
          href={`/${companyId}/notifications`}
          className="mt-1 flex shrink-0 items-center gap-1.5 rounded-full border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
        >
          Notifications
          {Boolean(pendingNotifications) && (
            <Badge tone="warn" className="ml-0.5">
              {pendingNotifications}
            </Badge>
          )}
        </Link>
      </header>

      {(() => {
        // Tile order is role-aware (see `complianceFirst` above): an owner
        // wants cash position and profit first; an accountant/auditor wants
        // the compliance numbers first. Same five tiles either way, just
        // reordered — this is a pure rendering choice, not a data one.
        const kpiByKey = kpi && {
          cash_bank: (
            <KpiTile
              key="cash_bank"
              label="Cash & Bank"
              value={formatINR(kpi.cash_bank, { showZero: true })}
            />
          ),
          profit: (
            <KpiTile
              key="profit"
              label="Profit · This Month"
              value={formatINR(thisMonthProfit, { showZero: true })}
              delta={profitDelta}
              deltaTone={profitDeltaTone}
              href={`/${companyId}/reports/profit-loss?from=${thisMonth.from}&to=${thisMonth.to}`}
            />
          ),
          receivable: (
            <KpiTile
              key="receivable"
              label="Receivable"
              value={formatINR(kpi.receivables, { showZero: true })}
              delta={kpi.receivables_overdue > 0 ? `Overdue ${formatINR(kpi.receivables_overdue)}` : undefined}
              deltaTone={kpi.receivables_overdue > 0 ? "warn" : "neutral"}
            />
          ),
          gst_liability: (
            <KpiTile
              key="gst_liability"
              label="GST Liability"
              value={formatINR(kpi.gst_liability, { showZero: true })}
            />
          ),
          tds_payable: (
            <KpiTile
              key="tds_payable"
              label="TDS Payable"
              value={formatINR(kpi.tds_payable, { showZero: true })}
            />
          ),
        };
        const kpiOrder: (keyof NonNullable<typeof kpiByKey>)[] = complianceFirst
          ? ["gst_liability", "tds_payable", "receivable", "cash_bank", "profit"]
          : ["cash_bank", "profit", "receivable", "gst_liability", "tds_payable"];
        const kpiSection = kpiByKey && (
          <section key="kpis" className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {kpiOrder.map((k) => kpiByKey[k])}
          </section>
        );

        const attentionSection = (
          <section key="attention-and-company" className="mb-12 grid gap-4 lg:grid-cols-2">
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
        );

        // The section-level swap: an accountant/auditor sees what needs
        // action before the headline numbers; an admin (or a null role,
        // defensively) sees the headline numbers first, same as before this
        // change.
        return complianceFirst
          ? <>{attentionSection}{kpiSection}</>
          : <>{kpiSection}{attentionSection}</>;
      })()}

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
