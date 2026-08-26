import { createClient } from "@/lib/supabase/server";
import { Aoc4XbrlPanel } from "@/components/xbrl/Aoc4XbrlPanel";

// Same three entity-type codes ref_entity_types.roc_forms already lists
// "AOC-4" against (confirmed live — see this feature's build report):
// pvt_ltd, ltd, opc. LLPs file Form 8/Form 11, never AOC-4; proprietorships,
// partnerships, HUFs, trusts, societies and AOP/BOIs have no ROC filing at
// all. Reusing the app's own existing classification rather than inventing
// a second one.
const AOC4_ENTITY_TYPES = new Set(["pvt_ltd", "ltd", "opc"]);

export default async function Aoc4XbrlPage({
  params,
}: PageProps<"/[companyId]/reports/aoc4-xbrl">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: profile }, { data: company }] = await Promise.all([
    supabase.rpc("get_company_profile", { p_company_id: companyId }),
    supabase
      .from("companies")
      .select("name, cin, financial_year_start_month, book_beginning_date, entity_type")
      .eq("id", companyId)
      .single(),
  ]);

  const entityType = profile?.[0]?.entity_type ?? company?.entity_type ?? "";
  const eligible = AOC4_ENTITY_TYPES.has(entityType);
  const entityLabel = profile?.[0]?.entity_name ?? entityType;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          AOC-4 XBRL instance document
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          Generates the Balance Sheet and Profit &amp; Loss XBRL instance documents behind an
          AOC-4 XBRL filing, tagged against the MCA C&amp;I taxonomy&rsquo;s documented structure.
        </p>
      </header>

      <div className="mb-6 flex flex-col gap-3 rounded-lg border border-warning bg-warning-soft px-4 py-3.5 text-sm text-warning">
        <p className="font-semibold">This produces an unfiled XBRL instance document, not a filing.</p>
        <p>
          Actual submission needs the MCA21 V3 portal — which exposes no third-party filing API —
          and a Class 3 Digital Signature Certificate on a physical USB token, authenticated
          through emSigner. Both are permanently out of reach for any unattended app, this one
          included. Since 14 Jul 2025, filing also requires signed PDF copies of the financial
          statements, Board&rsquo;s Report and Auditor&rsquo;s Report attached alongside the
          instance document — this app cannot produce those either, since signing needs the same
          DSC.
        </p>
        <p>
          <strong>Most SME users of this app do not need XBRL filing at all.</strong> Under Rule 3
          of the Companies (Filing of Documents and Forms in XBRL) Rules, 2015, only companies
          listed on a stock exchange (or their Indian subsidiaries), companies with paid-up
          capital of ₹5 crore or more, companies with turnover of ₹100 crore or more, or companies
          required to follow Ind AS must file in XBRL — everyone else files the plain AOC-4 e-form
          instead. The panel below includes a rough, ledger-based applicability estimate; it is a
          starting point, not a ruling.
        </p>
        <p>
          The individual line-item tag names in the generated files are LEKHA&rsquo;s best-effort
          rendering of Schedule III&rsquo;s own captions into the C&amp;I taxonomy&rsquo;s
          documented naming convention — they are <strong>not</strong> independently verified
          against the live current taxonomy (MCA&rsquo;s own site blocks automated access, and its
          taxonomy files are binary schemas, not readable text). MCA&rsquo;s Validation Tool will
          reject any element name that does not exactly match the live taxonomy, and MCA&rsquo;s
          own rules disallow extensions entirely, so treat every download here as a structural
          draft that a licensed XBRL tool must re-tag before real use — never as filing-ready.
        </p>
      </div>

      {!eligible ? (
        <div className="rounded-lg border border-border bg-surface-2 px-4 py-3.5 text-sm text-ink-soft">
          AOC-4 (XBRL or otherwise) is filed only by companies — Private Limited, Public Limited,
          or One Person Company. This company is registered as{" "}
          <strong>{entityLabel || "a non-company entity"}</strong>, which does not file AOC-4 at
          all (an LLP files Form 8/Form 11 instead; proprietorships, partnerships, HUFs, trusts,
          societies and AOP/BOIs have no ROC filing).
        </div>
      ) : (
        <Aoc4XbrlPanel
          companyId={companyId}
          companyName={company?.name ?? "Company"}
          cin={company?.cin ?? null}
          financialYearStartMonth={company?.financial_year_start_month ?? 4}
          bookBeginningDate={company?.book_beginning_date ?? "1900-01-01"}
        />
      )}
    </main>
  );
}
