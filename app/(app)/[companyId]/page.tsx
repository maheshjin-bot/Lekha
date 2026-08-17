import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const TIER_LABEL: Record<string, string> = {
  core: "Always on",
  conditional: "Set by your profile",
  optional: "Your choice",
};

export default async function CompanyPage({
  params,
}: PageProps<"/[companyId]">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: profile }, { data: modules }, { data: branches }] =
    await Promise.all([
      supabase.rpc("get_company_profile", { p_company_id: companyId }),
      supabase.rpc("get_company_modules", { p_company_id: companyId }),
      supabase
        .from("branches")
        .select("id, code, name, state_code, is_head_office")
        .eq("company_id", companyId)
        .order("is_head_office", { ascending: false }),
    ]);

  const company = profile?.[0];
  if (!company) notFound();

  const active = (modules ?? []).filter((m) => m.active);
  const inactive = (modules ?? []).filter((m) => !m.active);

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <Link
        href="/companies"
        className="text-sm text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        ← All companies
      </Link>

      <header className="mt-6 mb-12">
        <h1 className="text-3xl font-semibold tracking-tight">{company.name}</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {company.entity_name} ·{" "}
          {company.compliance_mode === "compliance"
            ? "Books + compliance"
            : "Books only"}
        </p>
      </header>

      <section className="mb-12 grid gap-4 sm:grid-cols-3">
        <Stat label="Statements" value={company.statement_format === "schedule_iii" ? "Schedule III" : "Simple"} />
        <Stat label="Income tax return" value={company.itr_form} />
        <Stat
          label="Tax audit report"
          value={company.tax_audit_report_form.toUpperCase().replace("_OR_", " or ")}
        />
      </section>

      {company.special_provisions?.length ? (
        <section className="mb-12 rounded-lg border border-amber-300 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/40">
          <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Applies to this entity type
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900 dark:text-amber-200/90">
            {company.special_provisions.map((p: string) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mb-12">
        <h2 className="mb-4 text-lg font-semibold">
          Active modules{" "}
          <span className="text-sm font-normal text-zinc-500">
            {active.length} of {modules?.length ?? 0}
          </span>
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {active.map((m) => (
            <li
              key={m.code}
              className="rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{m.name}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-500">
                  {TIER_LABEL[m.tier]}
                </span>
              </div>
              {m.locked_reason && (
                <p className="mt-1 text-xs text-zinc-500">{m.locked_reason}</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-12">
        <h2 className="mb-4 text-lg font-semibold">Available but off</h2>
        <ul className="flex flex-wrap gap-2">
          {inactive.map((m) => (
            <li
              key={m.code}
              className="rounded border border-dashed border-zinc-300 px-2.5 py-1 text-xs text-zinc-500 dark:border-zinc-700"
              title={m.locked_reason ?? m.description ?? undefined}
            >
              {m.name}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Branches</h2>
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {branches?.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <span className="font-mono text-xs text-zinc-500">{b.code}</span>
              <span className="font-medium">{b.name}</span>
              {b.is_head_office && (
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
