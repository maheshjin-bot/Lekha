import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

// The safer of the two Sec 43B(h) deadlines: 45 days applies only with a
// written agreement; without one it's 15. A ledger with no
// msme_payment_days set is assumed to have no agreement on file.
const DEFAULT_DEADLINE_DAYS = 15;
// A supplier crossing this many days before its own deadline is flagged as
// due soon, so it surfaces before it becomes a disallowance rather than after.
const DUE_SOON_WINDOW_DAYS = 7;

function daysBetween(from: string, to: string): number {
  const parse = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    // Date.UTC takes a 0-indexed month; the date string's month is 1-indexed.
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((parse(to) - parse(from)) / 86400000);
}

export default async function MsmeDuesPage({
  params,
}: PageProps<"/[companyId]/reports/msme">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month")
    .eq("id", companyId)
    .maybeSingle();

  // Same local-date-then-noon-UTC "today" every other report in this app
  // uses — see lib/utils/period.ts. Only .to is used here; there's no range
  // for this report, just a point-in-time snapshot.
  const today = defaultPeriod(company?.financial_year_start_month ?? 4).to;

  const [{ data: payables }, { data: ledgers }] = await Promise.all([
    supabase.rpc("get_party_outstanding", {
      p_company_id: companyId,
      p_as_at: today,
      p_role: "creditor",
    }),
    supabase
      .from("ledgers")
      .select("id, name, udyam_number, msme_category, msme_payment_days")
      .eq("company_id", companyId)
      .not("udyam_number", "is", null),
  ]);

  const msmeLedgers = new Map((ledgers ?? []).map((l) => [l.id, l]));

  // Sec 43B(h) applies to micro and small enterprises only — a Medium-flagged
  // supplier is excluded by the section itself, not by an oversight here.
  const rows = (payables ?? [])
    .map((p) => ({ ...p, ledger: msmeLedgers.get(p.ledger_id) }))
    .filter((r) => r.ledger && Number(r.outstanding) > 0)
    .filter((r) => r.ledger!.msme_category === "micro" || r.ledger!.msme_category === "small")
    .map((r) => {
      const deadlineDays = r.ledger!.msme_payment_days ?? DEFAULT_DEADLINE_DAYS;
      const daysElapsed = r.oldest_date ? daysBetween(r.oldest_date, today) : 0;
      const status: "ok" | "due_soon" | "disallowed" =
        daysElapsed > deadlineDays
          ? "disallowed"
          : daysElapsed > deadlineDays - DUE_SOON_WINDOW_DAYS
            ? "due_soon"
            : "ok";
      return { ...r, deadlineDays, daysElapsed, status };
    })
    .sort((a, b) => b.daysElapsed - a.daysElapsed);

  const mediumExcludedCount = (payables ?? []).filter(
    (p) => Number(p.outstanding) > 0 && msmeLedgers.get(p.ledger_id)?.msme_category === "medium"
  ).length;

  const disallowedTotal = rows
    .filter((r) => r.status === "disallowed")
    .reduce((n, r) => n + Number(r.outstanding), 0);

  return (
    <ReportShell
      title="MSME dues (Sec 43B(h))"
      period={`As at ${today} · payables to micro/small suppliers`}
      status={
        disallowedTotal > 0
          ? { label: `${formatINR(disallowedTotal)} past deadline`, tone: "bad" }
          : { label: "Nothing past deadline", tone: "ok" }
      }
    >
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-zinc-200 text-left dark:border-zinc-800">
            <th className={th}>Supplier</th>
            <th className={th}>Category</th>
            <th className={th}>Udyam</th>
            <th className={th}>Oldest since</th>
            <th className={th}>Deadline</th>
            <th className={th + " text-right"}>Outstanding</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-12 text-center text-zinc-500">
                No outstanding dues to a micro or small supplier.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr
              key={r.ledger_id}
              className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60"
            >
              <td className={td + " font-medium"}>{r.ledger_name}</td>
              <td className={td + " capitalize text-zinc-600 dark:text-zinc-400"}>
                {r.ledger!.msme_category}
              </td>
              <td className={td + " font-mono text-xs text-zinc-500"}>
                {r.ledger!.udyam_number}
              </td>
              <td className={td}>{r.oldest_date ?? "—"}</td>
              <td className={td + " text-zinc-600 dark:text-zinc-400"}>
                {r.deadlineDays} days
              </td>
              <td className={num + " font-medium"}>{formatINR(Number(r.outstanding))}</td>
              <td className={td}>
                <span
                  className={
                    "rounded px-2 py-0.5 text-xs font-medium " +
                    (r.status === "disallowed"
                      ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                      : r.status === "due_soon"
                        ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"
                        : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300")
                  }
                >
                  {r.status === "disallowed"
                    ? "Past deadline"
                    : r.status === "due_soon"
                      ? "Due soon"
                      : "OK"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {mediumExcludedCount > 0 && (
        <p className="border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500 dark:border-zinc-800">
          {mediumExcludedCount} Medium-flagged supplier
          {mediumExcludedCount === 1 ? "" : "s"} with dues outstanding not shown
          — Sec 43B(h) applies only to Micro and Small enterprises.
        </p>
      )}
      <p className="border-t border-zinc-200 px-4 py-3 text-xs text-zinc-500 dark:border-zinc-800">
        &ldquo;Oldest since&rdquo; is inferred the same way as the Payables
        report — receipts and payments applied to the oldest bill first, not
        matched to the bill they actually settle. A supplier with no payment
        deadline set is assumed to have no written agreement on file (the
        15-day rule) — worth confirming before treating &ldquo;Past
        deadline&rdquo; here as an actual disallowance.
      </p>
    </ReportShell>
  );
}
