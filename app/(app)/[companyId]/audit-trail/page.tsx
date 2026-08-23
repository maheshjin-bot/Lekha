import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ReportShell, td, th } from "@/components/reports/ReportShell";

const RANGES = [
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "365", label: "Last year", days: 365 },
] as const;

/** Tables worth offering as a filter, in the order an auditor would ask for
 * them: the postings first, then the masters they refer to, then the
 * governance trail. Anything not listed still appears under "All". */
const TABLE_FILTERS = [
  { value: "vouchers", label: "Vouchers" },
  { value: "voucher_entries", label: "Voucher lines" },
  { value: "voucher_items", label: "Voucher stock lines" },
  { value: "ledgers", label: "Ledgers" },
  { value: "account_groups", label: "Account groups" },
  { value: "companies", label: "Company settings" },
  { value: "company_members", label: "Users and roles" },
  { value: "company_modules", label: "Modules" },
];

/** The window to ask the trail for, as ISO instants. Kept in a helper because
 * "now" is impure and may not be read directly in a component body. */
function windowFor(days: number): { from: string; to: string } {
  const now = Date.now();
  return {
    from: new Date(now - days * 86400000).toISOString(),
    to: new Date(now).toISOString(),
  };
}

function formatWhen(ts: string): { date: string; time: string } {
  const d = new Date(ts);
  return {
    date: d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  };
}

const OPERATION_TONE: Record<string, string> = {
  INSERT: "bg-success-soft text-ink",
  UPDATE: "bg-warning-soft text-ink",
  DELETE: "bg-error-soft text-ink",
};

export default async function AuditTrailPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/audit-trail">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const rangeKey = typeof sp.range === "string" && RANGES.some((r) => r.key === sp.range)
    ? sp.range
    : "30";
  const days = RANGES.find((r) => r.key === rangeKey)!.days;
  const tableName = typeof sp.table === "string" && sp.table !== "" ? sp.table : undefined;

  const { from, to } = windowFor(days);

  const { data: rows, error } = await supabase.rpc("get_audit_trail", {
    p_company_id: companyId,
    p_from: from,
    p_to: to,
    p_table_name: tableName,
    p_limit: 500,
  });

  const entries = rows ?? [];
  const base = `/${companyId}/audit-trail`;
  const qs = (over: { range?: string; table?: string }) => {
    const r = over.range ?? rangeKey;
    const t = over.table ?? tableName ?? "";
    return `${base}?range=${r}${t ? `&table=${t}` : ""}`;
  };

  return (
    <ReportShell
      title="Audit trail"
      period={`${RANGES.find((r) => r.key === rangeKey)!.label} · showing up to 500 entries`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-sm print:hidden">
        {RANGES.map((r) => (
          <Link
            key={r.key}
            href={qs({ range: r.key })}
            className={
              "rounded-md border px-2.5 py-1 " +
              (rangeKey === r.key
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong hover:bg-surface-2")
            }
          >
            {r.label}
          </Link>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-sm print:hidden">
        <Link
          href={qs({ table: "" })}
          className={
            "rounded-md border px-2.5 py-1 " +
            (!tableName
              ? "border-accent bg-accent-soft text-accent"
              : "border-border-strong hover:bg-surface-2")
          }
        >
          All
        </Link>
        {TABLE_FILTERS.map((t) => (
          <Link
            key={t.value}
            href={qs({ table: t.value })}
            className={
              "rounded-md border px-2.5 py-1 " +
              (tableName === t.value
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong hover:bg-surface-2")
            }
          >
            {t.label}
          </Link>
        ))}
      </div>

      {error && (
        <div className="border-b border-border bg-error-soft px-4 py-3 text-sm text-ink">
          <p className="font-medium">This trail is not visible to you.</p>
          <p className="mt-1">
            The audit trail is readable only by a company&rsquo;s <strong>admin</strong> or{" "}
            <strong>auditor</strong>. That restriction is the point: a record that everyone can read
            and nobody can alter is worth more than one everybody can browse. ({error.message})
          </p>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>When</th>
              <th className={th}>Who</th>
              <th className={th}>What changed</th>
              <th className={th}>Action</th>
              <th className={th}>Fields</th>
            </tr>
          </thead>
          <tbody>
            {!error && entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-ink-faint">
                  Nothing was recorded in this period.
                </td>
              </tr>
            )}
            {entries.map((e) => {
              const when = formatWhen(e.changed_at);
              return (
                <tr key={e.id} className="border-b border-border last:border-0">
                  <td className={td}>
                    {when.date}
                    <div className="font-mono text-xs text-ink-faint">{when.time}</div>
                  </td>
                  <td className={td}>
                    {e.changed_by_name ?? (
                      <span className="text-ink-faint">
                        System
                        <div className="text-xs">no signed-in user</div>
                      </span>
                    )}
                  </td>
                  <td className={td}>
                    {e.table_name}
                    {e.derived_note && (
                      <div className="text-xs text-ink-faint">{e.derived_note}</div>
                    )}
                    <div className="font-mono text-[11px] text-ink-faint">
                      {String(e.record_id).slice(0, 8)}…
                    </div>
                  </td>
                  <td className={td}>
                    <span
                      className={
                        "inline-block rounded px-1.5 py-0.5 text-xs font-medium " +
                        (OPERATION_TONE[e.operation] ?? "bg-surface-2 text-ink-soft")
                      }
                    >
                      {e.operation}
                    </span>
                  </td>
                  <td className={td}>
                    {e.changed_fields && e.changed_fields.length > 0 ? (
                      <span className="font-mono text-xs">{e.changed_fields.join(", ")}</span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Rule 3(1) of the Companies (Accounts) Rules 2014 has required accounting software to keep an
        edit log since 1 April 2023: every change recorded with its date, and the log itself not
        capable of being switched off. An auditor has to report on whether it operated throughout
        the year, so this page exists to be shown to them. It reads the same append-only log the
        database writes automatically on every insert, update and delete — nothing here is entered
        by hand, and there is no control anywhere in this app that turns it off.
      </p>
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        &ldquo;System&rdquo; in the Who column means a change made without a signed-in user —
        a migration, a seeding routine, or a maintenance script run directly against the database.
        Those are genuine changes and are shown rather than hidden. Entries are capped at 500 per
        view; narrow the period or pick a table to see further back. Deletions in this app are
        usually soft (a voucher is marked deleted, not removed), so a DELETE here generally means a
        master record — a ledger or a group — being removed, and a cancelled voucher will appear as
        an UPDATE. To see what a specific voucher looks like now rather than what changed, open it
        from the{" "}
        <Link href={`/${companyId}/reports/daybook`} className="underline">
          daybook
        </Link>
        .
      </p>
    </ReportShell>
  );
}
