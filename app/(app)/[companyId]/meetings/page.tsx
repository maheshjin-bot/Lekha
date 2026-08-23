import { createClient } from "@/lib/supabase/server";
import { MeetingManager } from "@/components/meetings/MeetingManager";

export default async function MeetingsPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/meetings">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const filter =
    typeof sp.filter === "string" && ["agm", "egm", "board"].includes(sp.filter) ? sp.filter : "all";

  const [{ data: meetings }, { data: agmStatus }, { data: docs }] = await Promise.all([
    supabase.rpc("get_meetings", {
      p_company_id: companyId,
      p_type_filter: filter === "all" ? undefined : filter,
    }),
    supabase.rpc("get_agm_status", { p_company_id: companyId }).single(),
    supabase
      .from("documents")
      .select("id, storage_path, file_name, mime_type, size_bytes, created_at, entity_id")
      .eq("company_id", companyId)
      .eq("entity_type", "meeting"),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Meeting register
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          AGMs, EGMs and board meetings actually held — the real dates this app never used to
          record. The compliance calendar still assumes every AGM happens by 30 September until
          it is wired to read the dates recorded here; that is tracked as separate follow-on
          work, not done by this screen.
        </p>
      </header>

      <MeetingManager
        companyId={companyId}
        meetings={meetings ?? []}
        agmStatus={agmStatus ?? null}
        filter={filter}
        docs={docs ?? []}
      />
    </main>
  );
}
