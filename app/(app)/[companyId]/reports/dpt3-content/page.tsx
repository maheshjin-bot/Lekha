import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const CATEGORY_LABEL: Record<string, string> = {
  exempted_director_loan: "Exempted deposit — loan from a director",
  exempted_bank_or_fi_loan: "Exempted deposit — bank / financial institution",
  unclassified_needs_manual_review: "Unclassified — needs manual review",
};

const MATCH_BASIS_LABEL: Record<string, string> = {
  pan_exact: "PAN match",
  name_exact: "Exact name match",
  name_fuzzy: "Partial name match",
};

export default async function Dpt3ContentPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/dpt3-content">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  // FY runs 1 Apr - 31 Mar. currentFyStartYear is the calendar year the
  // ONGOING financial year started in (see itc-04-prep's identical helper).
  const currentFyStartYear = tm >= 4 ? ty : ty - 1;
  // Rule 16 asks for the position "as on 31 March" — the most recently
  // CLOSED year end is the one a filer actually needs, so that is the
  // default; "current year to date" is offered as the running alternative.
  const closedFyEnd = `${currentFyStartYear}-03-31`;
  const currentFyEnd = `${currentFyStartYear + 1}-03-31`;

  const period = sp.period === "current" ? "current" : "closed";
  const fyEnd = period === "current" ? currentFyEnd : closedFyEnd;
  const fyEndLabel = period === "current" ? `${currentFyEnd} (year in progress)` : closedFyEnd;

  const [{ data: companyRow }, { data: rows }] = await Promise.all([
    supabase.from("companies").select("entity_type, name").eq("id", companyId).single(),
    supabase.rpc("get_dpt3_return_content", { p_company_id: companyId, p_fy_end: fyEnd }),
  ]);

  const entityType = companyRow?.entity_type ?? null;
  const rocApplicable = entityType === "pvt_ltd" || entityType === "ltd";
  const content = rows ?? [];

  const totalsByCategory = new Map<string, number>();
  for (const r of content) {
    totalsByCategory.set(
      r.category,
      (totalsByCategory.get(r.category) ?? 0) + Number(r.outstanding_amount)
    );
  }
  const grandTotal = content.reduce((sum, r) => sum + Number(r.outstanding_amount), 0);

  return (
    <ReportShell title="DPT-3 return content" period={`As on ${fyEndLabel}`}>
      <div className="flex flex-wrap gap-2 border-b border-border px-4 py-2.5 text-sm print:hidden">
        {(["closed", "current"] as const).map((p) => (
          <Link
            key={p}
            href={`?period=${p}`}
            className={
              "rounded-md border px-2.5 py-1 " +
              (period === p
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong hover:bg-surface-2")
            }
          >
            {p === "closed" ? `As on ${closedFyEnd}` : `As on ${currentFyEnd} (in progress)`}
          </Link>
        ))}
      </div>

      {!rocApplicable && (
        <div className="border-b border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          This app&rsquo;s own seeded reference data (ref_entity_types.roc_forms) does not list
          DPT-3 for entity type &ldquo;{entityType ?? "unknown"}&rdquo; — DPT-3 applies to
          pvt_ltd/ltd companies only, not LLPs (governed by the LLP Act, not the Companies Act
          deposit rules) or an OPC. Figures below are still computed if this company happens to
          have loan/deposit ledgers flagged, but this return would not ordinarily be filed for
          this entity type.
        </div>
      )}

      <div className="px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Summary</h2>
      </div>
      <table className="w-full min-w-[620px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Category</th>
            <th className={num}>Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {["exempted_director_loan", "exempted_bank_or_fi_loan", "unclassified_needs_manual_review"].map(
            (cat) => (
              <tr key={cat} className="border-b border-border last:border-0">
                <td className={td}>{CATEGORY_LABEL[cat]}</td>
                <td className={num}>{formatINR(totalsByCategory.get(cat) ?? 0, { showZero: true })}</td>
              </tr>
            )
          )}
          <tr className="bg-surface-2 font-semibold">
            <td className={td}>Total outstanding (all flagged loan/deposit ledgers)</td>
            <td className={num}>{formatINR(grandTotal, { showZero: true })}</td>
          </tr>
        </tbody>
      </table>

      <div className="border-t border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-ink">Ledger-level detail</h2>
      </div>
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Ledger</th>
            <th className={th}>Category</th>
            <th className={th}>Rule</th>
            <th className={th}>Matched to</th>
            <th className={num}>Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {content.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-ink-faint">
                No ledger is flagged as a loan/deposit (ledgers.is_loan_or_deposit) with an
                outstanding balance as on this date.
              </td>
            </tr>
          )}
          {content.map((r) => (
            <tr key={r.ledger_id} className="border-b border-border last:border-0 align-top">
              <td className={td}>{r.ledger_name}</td>
              <td className={td}>{CATEGORY_LABEL[r.category] ?? r.category}</td>
              <td className={td + " font-mono text-xs text-ink-soft"}>{r.rule_reference ?? "—"}</td>
              <td className={td + " text-xs text-ink-soft"}>
                {r.matched_director_name ? (
                  <>
                    {r.matched_director_name}
                    {r.match_basis && (
                      <div className="text-ink-faint">{MATCH_BASIS_LABEL[r.match_basis] ?? r.match_basis}</div>
                    )}
                  </>
                ) : r.party_type === "bank" ? (
                  "Ledger party type: bank"
                ) : (
                  "—"
                )}
              </td>
              <td className={num}>{formatINR(Number(r.outstanding_amount), { showZero: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Return content in DPT-3&rsquo;s own disclosure shape (Rule 16, Companies (Acceptance of
        Deposits) Rules 2014), sourced from every ledger this company has flagged
        is_loan_or_deposit — not a validated match to the MCA e-form&rsquo;s exact upload fields.
        Use this as a checklist to key into the actual DPT-3 form, not as a ready-to-file
        submission. Two things this schema genuinely cannot determine, stated rather than
        guessed: (1) director/bank matches are by PAN or name, not a real link, so double-check
        each match before relying on it — see the &ldquo;Matched to&rdquo; column; (2) a loan
        from a director&rsquo;s <em>relative</em> (also exempted, private companies only), share
        application money pending allotment, advances from customers, and inter-corporate loans
        are not tracked anywhere in this schema at all, so any of those will show up
        &ldquo;Unclassified&rdquo; here rather than in their true category — never as a confident
        &ldquo;Deposit&rdquo; or &ldquo;Exempted&rdquo; this app cannot actually back up.
      </p>
    </ReportShell>
  );
}
