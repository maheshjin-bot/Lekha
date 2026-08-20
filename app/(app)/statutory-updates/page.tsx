import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { StatutoryUpdateManager } from "@/components/statutory-updates/StatutoryUpdateManager";

export default async function StatutoryUpdatesPage() {
  const supabase = await createClient();

  // Not company-scoped — every ref_* table this tracks is global, shared
  // by every tenant company on this platform. See migration 0046.
  const { data: notes } = await supabase
    .from("statutory_update_notes")
    .select(
      "id, title, area, description, citation_text, citation_url, effective_date, status, applied_note"
    )
    .order("effective_date", { ascending: false });

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <div className="mb-2">
        <Link href="/companies" className="text-sm text-ink-faint hover:text-ink-soft">
          ← Companies
        </Link>
      </div>
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Statutory update log
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        A paper trail for rate and rule changes across every tax table this
        app maintains — TDS/TCS sections, GST rates, income tax slabs,
        depreciation blocks, ESI/PF figures and more. Not company-scoped:
        these tables are shared by every company on the platform. Logging
        a change here does not change any rate — the actual update still
        lands as its own reviewed migration; this just tracks that one is
        needed, where it comes from, and whether it has landed yet.
      </p>
      <StatutoryUpdateManager notes={notes ?? []} />
    </main>
  );
}
