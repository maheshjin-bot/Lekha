import { createClient } from "@/lib/supabase/server";
import { defaultPeriod } from "@/lib/utils/period";
import { ReportShell, td, th } from "@/components/reports/ReportShell";

// How far ahead to look — matches get_compliance_calendar's own SQL default,
// kept explicit here so the page's "today" (the safe local-date one) and the
// window it asks for stay in lock-step rather than one trusting the other.
const WINDOW_DAYS = 120;
// A due date inside this many days is flagged, so it surfaces before the
// week it is actually due in rather than only on the day itself.
const DUE_SOON_WINDOW_DAYS = 7;

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  // Date.UTC takes a 0-indexed month; the date string's month is 1-indexed —
  // the same fix the MSME report needed for the same reason.
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const parse = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / 86400000);
}

const CATEGORY_TONE: Record<string, string> = {
  GST: "bg-blue-100 text-blue-800  ",
  TDS: "bg-violet-100 text-violet-800  ",
  TCS: "bg-warning-soft text-warning",
  "Income tax": "bg-success-soft text-success",
};

export default async function ComplianceCalendarPage({
  params,
}: PageProps<"/[companyId]/reports/compliance-calendar">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("financial_year_start_month, compliance_mode")
    .eq("id", companyId)
    .maybeSingle();

  const today = defaultPeriod(company?.financial_year_start_month ?? 4).to;
  const windowEnd = addDays(today, WINDOW_DAYS);

  const { data: rows } = await supabase.rpc("get_compliance_calendar", {
    p_company_id: companyId,
    p_from: today,
    p_to: windowEnd,
  });

  const items = (rows ?? []).map((r) => ({
    ...r,
    daysLeft: daysBetween(today, r.due_date!),
  }));

  const dueSoonCount = items.filter((r) => r.daysLeft <= DUE_SOON_WINDOW_DAYS).length;

  return (
    <ReportShell
      title="Compliance calendar"
      period={`${today} to ${windowEnd} · statutory due dates, calendar April–March year`}
      status={
        dueSoonCount > 0
          ? { label: `${dueSoonCount} due within ${DUE_SOON_WINDOW_DAYS} days`, tone: "warn" }
          : { label: items.length > 0 ? "Nothing due soon" : "Nothing scheduled", tone: "ok" }
      }
    >
      <table className="w-full min-w-[680px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Due</th>
            <th className={th}>In</th>
            <th className={th}>Category</th>
            <th className={th}>What&rsquo;s due</th>
            <th className={th}>Detail</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-12 text-center text-ink-faint">
                {company?.compliance_mode === "books_only"
                  ? "This company is in books-only mode, so no statutory return dates apply. Switch to compliance mode in Settings to see them."
                  : "Nothing due in this window — check GST registrations, TAN and module settings if that looks wrong."}
              </td>
            </tr>
          )}
          {items.map((r, i) => (
            <tr
              key={`${r.due_date}-${r.label}-${i}`}
              className="border-b border-border last:border-0"
            >
              <td className={td + " whitespace-nowrap font-medium tabular-nums"}>{r.due_date}</td>
              <td
                className={
                  td +
                  " whitespace-nowrap tabular-nums " +
                  (r.daysLeft <= DUE_SOON_WINDOW_DAYS
                    ? "font-semibold text-warning"
                    : "text-ink-faint")
                }
              >
                {r.daysLeft === 0 ? "today" : r.daysLeft === 1 ? "1 day" : `${r.daysLeft} days`}
              </td>
              <td className={td}>
                <span
                  className={
                    "rounded px-2 py-0.5 text-xs font-medium " +
                    (CATEGORY_TONE[r.category ?? ""] ??
                      "bg-surface-2 text-ink-soft  ")
                  }
                >
                  {r.category}
                </span>
              </td>
              <td className={td + " font-medium"}>{r.label}</td>
              <td className={td + " text-ink-soft "}>{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Every date here is computed from a formula (Nth of the month after a
        period), not looked up, and always follows the calendar April–March
        year regardless of this company&rsquo;s own financial year setting —
        statutory due dates never follow a company&rsquo;s books. A handful of
        narrower rules (presumptive-taxation single-instalment advance tax,
        transfer-pricing dates, government-deductor TDS timing) are not
        modelled; see the migration that introduced this report for the full
        list.
      </p>
    </ReportShell>
  );
}
