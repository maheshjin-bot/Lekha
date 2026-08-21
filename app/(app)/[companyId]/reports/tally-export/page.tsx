import { createClient } from "@/lib/supabase/server";
import { defaultPeriod } from "@/lib/utils/period";
import { TallyExportPanel } from "@/components/tally/TallyExportPanel";

export default async function TallyExportPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/tally-export">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: profile } = await supabase.rpc("get_company_profile", { p_company_id: companyId });
  const period = defaultPeriod(profile?.[0]?.financial_year_start_month ?? 4, {
    from: typeof sp.from === "string" ? sp.from : undefined,
    to: typeof sp.to === "string" ? sp.to : undefined,
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Export to Tally
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          One-directional XML export — LEKHA to Tally, not the other way. Structurally
          correct per Tally Solutions&rsquo; own documentation, but this environment has no
          licensed TallyPrime install to test-import against, so treat the first real
          import as a trial run: import into a spare/test company first, check TallyPrime&rsquo;s
          own Exceptions report afterward, and keep a backup either way.
        </p>
      </header>

      <TallyExportPanel companyId={companyId} companyName={profile?.[0]?.name ?? "Company"} period={period} />
    </main>
  );
}
