import { createClient } from "@/lib/supabase/server";
import { DirectorManager } from "@/components/directors/DirectorManager";

export default async function DirectorsPage({
  params,
}: PageProps<"/[companyId]/directors">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: directors }, { data: companies }] = await Promise.all([
    supabase
      .from("company_directors")
      .select(
        "id, name, din, din_allotment_date, designation, pan, date_of_appointment, date_of_cessation, is_opc_nominee"
      )
      .eq("company_id", companyId)
      .order("date_of_cessation", { ascending: true, nullsFirst: true })
      .order("date_of_appointment", { ascending: true }),
    supabase.from("companies").select("entity_type").eq("id", companyId).single(),
  ]);

  const entityType = companies?.entity_type ?? null;
  const currentCount = (directors ?? []).filter((d) => !d.date_of_cessation).length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Directors &amp; KMP
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          The record of who directs this company and who holds key managerial
          roles — DIN, designation, and the appointment/cessation dates that
          decide who is currently serving. This is the people master the
          compliance calendar&rsquo;s annual DIR-3 KYC reminder still can&rsquo;t
          see: that reminder fires once per ROC-applicable company, not once
          per DIN holder, and reading it that way isn&rsquo;t wired up here — see
          the note below the table.
        </p>
        <p className="mt-1.5 text-sm text-ink-soft">
          <span className="font-semibold text-ink">{currentCount}</span>{" "}
          currently serving
          {entityType === "opc" && (
            <span className="text-ink-faint">
              {" "}
              — an OPC also needs exactly one Sec 3(1) member nominee, tracked
              here as its own flag, separate from any board designation.
            </span>
          )}
        </p>
      </header>

      <DirectorManager companyId={companyId} directors={directors ?? []} entityType={entityType} />

      <p className="mt-6 max-w-2xl text-xs text-ink-faint">
        This screen records who the directors/KMP are and when they served —
        it does not generate MGT-7/MGT-7A, link an auditor for ADT-1, file
        DIR-12, or verify a DIN against the MCA database (no API access for
        that). Those stay separate, deliberately unbuilt gaps.
      </p>
    </main>
  );
}
