import { createClient } from "@/lib/supabase/server";
import { NoticeManager } from "@/components/notices/NoticeManager";

export default async function NoticesPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/notices">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const filter = typeof sp.filter === "string" && sp.filter === "all" ? "all" : "open";

  const [{ data: notices }, { data: docs }] = await Promise.all([
    supabase.rpc("get_notices", {
      p_company_id: companyId,
      p_status_filter: filter === "open" ? "open" : undefined,
    }),
    supabase
      .from("documents")
      .select("id, storage_path, file_name, mime_type, size_bytes, created_at, entity_id")
      .eq("company_id", companyId)
      .eq("entity_type", "notice"),
  ]);

  const overdueCount = (notices ?? []).filter((n) => n.is_overdue).length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
            Notices &amp; assessments
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            Government notices received, tracked through to response. Response deadlines
            are whatever the notice itself says — they are not computed here.
          </p>
        </div>
        {overdueCount > 0 && (
          <span className="rounded-full bg-error-soft px-3 py-1 text-sm font-semibold text-error">
            {overdueCount} overdue
          </span>
        )}
      </header>

      <NoticeManager companyId={companyId} notices={notices ?? []} filter={filter} docs={docs ?? []} />
    </main>
  );
}
