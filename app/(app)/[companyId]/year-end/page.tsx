import { createClient } from "@/lib/supabase/server";
import { YearEndPanel } from "@/components/year-end/YearEndPanel";

export default async function YearEndPage({
  params,
}: PageProps<"/[companyId]/year-end">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: company }, { data: auditRows }] = await Promise.all([
    supabase
      .from("companies")
      .select("name, lock_date, book_beginning_date, financial_year_start_month")
      .eq("id", companyId)
      .maybeSingle(),
    supabase.rpc("get_audit_trail", {
      p_company_id: companyId,
      p_table_name: "companies",
      // Well past the lifetime of any company this young; a real close is
      // rare enough that the default 200-row cap is never a concern either.
      p_from: "2000-01-01T00:00:00Z",
    }),
  ]);

  // get_audit_trail covers every column change on companies (name edits,
  // PAN, entity type…) — narrow to the ones that actually touched lock_date.
  const closingHistory = (auditRows ?? []).filter((r) =>
    r.changed_fields?.includes("lock_date")
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Year-end closing</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Closing a period locks every voucher dated on or before it — nothing
        can be added, edited, or deleted there, by anyone, including an admin.
      </p>

      <YearEndPanel
        companyId={companyId}
        lockDate={company?.lock_date ?? null}
        bookBeginningDate={company?.book_beginning_date ?? null}
        financialYearStartMonth={company?.financial_year_start_month ?? 4}
        history={closingHistory.map((r) => ({
          id: r.id,
          changedAt: r.changed_at,
          changedByName: r.changed_by_name,
        }))}
      />
    </main>
  );
}
