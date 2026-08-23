import { createClient } from "@/lib/supabase/server";
import { FilingRegisterManager, type FilingRecord } from "@/components/filing-register/FilingRegisterManager";

const STATUS_VALUES = ["pending", "filed", "not_applicable"];

export default async function FilingRegisterPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/filing-register">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const filter = typeof sp.filter === "string" && STATUS_VALUES.includes(sp.filter) ? sp.filter : "all";

  const [{ data: records, error }, { data: registrations }] = await Promise.all([
    supabase.rpc("get_filing_register", { p_company_id: companyId }),
    supabase
      .from("gst_registrations")
      .select("id, gstin, state_code")
      .eq("company_id", companyId)
      .order("gstin"),
  ]);

  const filedCount = (records ?? []).filter((r) => r.status === "filed").length;
  const pendingCount = (records ?? []).filter((r) => r.status === "pending").length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Filing register
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          What has actually been filed, across GST returns, TDS/TCS returns, ROC forms and income
          tax — one row per form and period, with the ARN/SRN/acknowledgement number, fee paid and
          any late fee. The Compliance Calendar computes due dates from a formula and does not read
          this table, so a filing recorded here does not yet make its calendar reminder disappear —
          that is separate, not-yet-built follow-on work.
        </p>
        <p className="mt-1.5 text-sm text-ink-soft">
          <span className="font-semibold text-ink">{filedCount}</span> filed,{" "}
          <span className="font-semibold text-ink">{pendingCount}</span> pending
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-[14px] border border-error/30 bg-error-soft p-4 text-sm text-error">
          Could not load the filing register: {error.message}
        </div>
      )}

      <FilingRegisterManager
        companyId={companyId}
        // status is a checked text column ('pending' | 'filed' |
        // 'not_applicable'), not a generated enum, so Supabase's typegen
        // widens it to `string` — the CHECK constraint is what actually
        // guarantees the narrower shape.
        records={(records ?? []) as FilingRecord[]}
        registrations={registrations ?? []}
        filter={filter}
      />

      <p className="mt-6 max-w-2xl text-xs text-ink-faint">
        This is a log, not a filer — nothing here generates a return, uploads anything to a portal,
        or verifies an acknowledgement number&rsquo;s format. It also does not link to a Tax Payments
        challan; filing and paying are recorded separately because one does not imply the other.
      </p>
    </main>
  );
}
