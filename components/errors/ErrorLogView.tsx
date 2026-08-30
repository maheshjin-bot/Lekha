import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * The error log, written for the person who owns this business — not for the
 * person who wrote the app.
 *
 * The incident this exists for: bill capture failed, the screen said "The
 * vision service could not process this file right now", and the actual
 * answer — Google replying 503 "This model is currently experiencing high
 * demand" — sat in a server journal reachable only over SSH. The owner is not
 * technical. What they needed to know was three things this page now says out
 * loud: it was busy rather than broken, nothing was lost, and trying again in
 * a minute would work.
 *
 * So the ordering of information here is deliberate and is the opposite of a
 * developer's error console:
 *   1. What was being done, in the words the app uses for it ("Bill reader",
 *      not "capture_vision").
 *   2. What happened, in plain language.
 *   3. WHAT TO DO ABOUT IT — the line that turns a log into something
 *      actionable. Derived from the operation and from signals in the
 *      technical text (a 503, a 429, a missing setting), because those map
 *      cleanly onto genuinely different advice: wait, wait longer, or fetch
 *      someone who can change a setting.
 *   4. When, and how many times.
 *   5. The raw technical text — present, complete, and COLLAPSED. It is there
 *      for whoever helps them, not shouted at someone it will only frighten.
 *
 * No "use client" and no JavaScript: the filters are links and the detail
 * disclosure is a native <details>. A page whose whole job is to work when
 * something else is broken should have as little of its own machinery as
 * possible.
 */

export interface ErrorLogRow {
  id: string;
  occurred_at: string;
  last_seen_at: string;
  repeat_count: number;
  operation: string;
  severity: string;
  message: string;
  detail: string | null;
  context: unknown;
  scope: string;
  user_name: string | null;
}

/** Recency filter — "only show me recent failures". */
export const RANGES = [
  { key: "1h", label: "Last hour", hours: 1 },
  { key: "24h", label: "Last 24 hours", hours: 24 },
  { key: "7d", label: "Last 7 days", hours: 24 * 7 },
  { key: "30d", label: "Last 30 days", hours: 24 * 30 },
  { key: "all", label: "Everything kept", hours: 24 * 90 },
] as const;

export const DEFAULT_RANGE = "7d";

export function hoursForRange(key: string): number {
  return (RANGES.find((r) => r.key === key) ?? RANGES[2]).hours;
}

/** The instant to ask the log for, as an ISO string. Kept in a helper for the
 * same reason app/(app)/[companyId]/audit-trail/page.tsx keeps its own
 * windowFor() out of the component body: "now" is impure and the
 * react-hooks/purity rule refuses a direct Date.now() during render. */
export function sinceForRange(key: string): string {
  return new Date(Date.now() - hoursForRange(key) * 3_600_000).toISOString();
}

/**
 * Plain-language names for the operation codes. A code with no entry here is
 * shown as the code itself rather than as nothing — see migration 0950 on why
 * the column is deliberately not constrained to this list.
 */
const OPERATIONS: Record<string, { label: string; what: string }> = {
  capture_vision: {
    label: "Bill reader",
    what: "reading a photographed or uploaded bill",
  },
  support_chat: {
    label: "Help assistant",
    what: "answering a question in the help chat",
  },
  email_send: {
    label: "Email delivery",
    what: "sending an email",
  },
  notification_dispatch: {
    label: "Reminder emails",
    what: "sending out the reminders and due-date alerts",
  },
  whatsapp_webhook: {
    label: "WhatsApp bills",
    what: "receiving a bill forwarded over WhatsApp",
  },
  pdf_export: {
    label: "PDF and printing",
    what: "producing a PDF",
  },
};

/** The operations offered as filter chips, in the order an owner would look
 * for them. Anything not listed still appears under "All". */
export const OPERATION_FILTERS = [
  "capture_vision",
  "whatsapp_webhook",
  "support_chat",
  "email_send",
  "notification_dispatch",
] as const;

export function operationLabel(code: string): string {
  return OPERATIONS[code]?.label ?? code;
}

/**
 * What to do about it. Matched against the message and the technical detail
 * together, most specific first — the order matters, because a "401
 * Unauthorized" body from a service that is also returning 5xx should read as
 * a credential problem, not as "it was busy".
 */
const ADVICE: Array<{ test: RegExp; advice: string }> = [
  {
    test: /is not set|not configured|missing [A-Z_]{4,}/,
    advice:
      "This part of the app has not been switched on for this server yet — a setting is missing rather than anything being broken. It needs whoever set up the app; there is nothing for you to fix here.",
  },
  {
    test: /\b40[13]\b|unauthori[sz]|permission denied|api[ _]key not valid|invalid[ _]api[ _]key|invalid_?key|expired/i,
    advice:
      "The other service refused the connection — almost always because a key or password it uses has expired or been changed. Nothing you did caused this, and retrying will not help until someone renews it.",
  },
  {
    test: /\b429\b|rate limit|quota|resource[ _]exhausted|too many requests/i,
    advice:
      "The free allowance for this service has run out for the moment. It normally resets within the hour, or by the next day. Nothing was lost — try again later.",
  },
  {
    test: /\b503\b|high demand|overload|currently unavailable|temporarily unavailable|try again later/i,
    advice:
      "The service was busy, not broken. Nothing was lost — wait a minute and try again.",
  },
  {
    test: /timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network/i,
    advice:
      "We could not reach the other service at all, which is usually a brief network problem at one end or the other. Try again in a minute. If it is still happening after ten, it is worth reporting.",
  },
  {
    test: /\b404\b|\bnot found\b/i,
    advice:
      "The other service said the thing we asked for does not exist. That normally means it has moved or been renamed at their end, and needs whoever set up the app to point at the new one.",
  },
  {
    test: /\b5\d\d\b|internal server error|bad gateway/i,
    advice:
      "The other service had a problem at its end, not in your books. Trying again a little later is usually enough.",
  },
];

const FALLBACK_ADVICE =
  "Try the same thing once more. If it happens again, show this entry — including the technical detail below — to whoever helps you with the app.";

export function adviceFor(row: ErrorLogRow): string {
  const haystack = `${row.message}\n${row.detail ?? ""}`;
  for (const rule of ADVICE) {
    if (rule.test.test(haystack)) return rule.advice;
  }
  return FALLBACK_ADVICE;
}

const SEVERITY: Record<string, { label: string; tone: "warn" | "bad" }> = {
  warning: { label: "Handled", tone: "warn" },
  error: { label: "Failed", tone: "bad" },
  critical: { label: "Needs attention", tone: "bad" },
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today at ${time}`;
  const yesterday = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
  return `${d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} at ${time}`;
}

function chipClass(active: boolean): string {
  return (
    "rounded-md border px-2.5 py-1 text-sm transition-colors " +
    (active
      ? "border-accent bg-accent-soft text-accent"
      : "border-border-strong text-ink-soft hover:bg-surface-2")
  );
}

export function ErrorLogView({
  companyId,
  rows,
  rangeKey,
  operation,
  errorMessage,
}: {
  companyId: string;
  rows: ErrorLogRow[];
  rangeKey: string;
  operation?: string;
  errorMessage?: string | null;
}) {
  const base = `/${companyId}/error-log`;
  const href = (over: { range?: string; op?: string | null }) => {
    const r = over.range ?? rangeKey;
    const o = over.op === null ? "" : (over.op ?? operation ?? "");
    return `${base}?range=${r}${o ? `&op=${o}` : ""}`;
  };

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Error log</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          When something in the app does not work, what actually went wrong is recorded here — in
          plain language, with the technical detail tucked away underneath for whoever helps you.
          An empty list is good news.
        </p>
      </header>

      {errorMessage ? (
        <div className="mt-6 rounded-lg border border-border bg-error-soft px-4 py-3 text-sm text-ink">
          <p className="font-medium">This log is not visible to you.</p>
          <p className="mt-1">
            The error log is readable only by an <strong>admin</strong> of this company. These
            entries can describe how the app is put together internally, so they are kept to the
            person who owns the account rather than shown to everyone who can enter a voucher.
          </p>
          <p className="mt-1 text-ink-soft">({errorMessage})</p>
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              When
            </span>
            {RANGES.map((r) => (
              <Link key={r.key} href={href({ range: r.key })} className={chipClass(rangeKey === r.key)}>
                {r.label}
              </Link>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              What
            </span>
            <Link href={href({ op: null })} className={chipClass(!operation)}>
              Everything
            </Link>
            {OPERATION_FILTERS.map((code) => (
              <Link key={code} href={href({ op: code })} className={chipClass(operation === code)}>
                {operationLabel(code)}
              </Link>
            ))}
          </div>

          <div className="mt-6 space-y-3">
            {rows.length === 0 && (
              <EmptyState>
                Nothing went wrong in this period. If you came here looking for a specific problem,
                widen the time range above — entries are kept for 90 days.
              </EmptyState>
            )}

            {rows.map((row) => {
              const sev = SEVERITY[row.severity] ?? SEVERITY.error;
              const op = OPERATIONS[row.operation];
              const contextJson =
                row.context && Object.keys(row.context as object).length > 0
                  ? JSON.stringify(row.context, null, 2)
                  : null;

              return (
                <article
                  key={row.id}
                  className="rounded-lg border border-border bg-surface p-5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={sev.tone}>{sev.label}</Badge>
                    <span className="text-sm font-semibold text-ink">
                      {operationLabel(row.operation)}
                    </span>
                    {/* A failure that happened to this signed-in user with no
                        company attached — the help chat sits above company
                        selection and genuinely has none. Labelled so the
                        reader is not left wondering why a company screen is
                        showing something that is not about the company. */}
                    {row.scope === "personal" && <Badge tone="neutral">Yours only</Badge>}
                  </div>

                  <p className="mt-2.5 text-base text-ink">{row.message}</p>

                  {op && (
                    <p className="mt-1 text-sm text-ink-faint">
                      This happened while {op.what}.
                    </p>
                  )}

                  <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-sm text-ink-soft">
                    {adviceFor(row)}
                  </p>

                  <p className="mt-3 text-xs text-ink-faint">
                    {row.repeat_count > 1 ? (
                      <>
                        Happened <strong>{row.repeat_count} times</strong> — first{" "}
                        {formatWhen(row.occurred_at)}, most recently {formatWhen(row.last_seen_at)}.
                      </>
                    ) : (
                      formatWhen(row.occurred_at)
                    )}
                    {row.user_name ? ` · ${row.user_name}` : ""}
                  </p>

                  {(row.detail || contextJson) && (
                    <details className="group mt-3">
                      <summary className="cursor-pointer list-none text-xs font-medium text-ink-faint underline decoration-dotted underline-offset-4 hover:text-ink-soft">
                        Technical detail — for whoever helps you with the app
                      </summary>
                      <div className="mt-2 overflow-x-auto rounded-md border border-border bg-surface-2 p-3">
                        {row.detail && (
                          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-soft">
                            {row.detail}
                          </pre>
                        )}
                        {contextJson && (
                          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-faint">
                            {contextJson}
                          </pre>
                        )}
                      </div>
                    </details>
                  )}
                </article>
              );
            })}
          </div>

          <div className="mt-8 space-y-3 border-t border-border pt-4 text-xs text-ink-faint">
            <p>
              Passwords and keys are stripped out before anything is written here, so this page is
              safe to screenshot and send to someone who is helping you. If you ever see something
              that looks like a password on this screen, say so — that would be a bug worth fixing
              immediately.
            </p>
            <p>
              Entries are kept for 90 days and then removed automatically. The same failure
              happening repeatedly is shown once with a count rather than as hundreds of separate
              lines.
            </p>
            <p>
              This is not the{" "}
              <Link href={`/${companyId}/audit-trail`} className="underline">
                audit trail
              </Link>
              . That one records every change to your books and is the one an auditor asks for; this
              one records when a part of the app itself did not work, and has no bearing on your
              accounts.
            </p>
            <p>
              A few failures happen before the app knows whose they are — a bill forwarded over
              WhatsApp that could not be downloaded at all, for instance, arrives with nothing on it
              to say which company it belongs to. Those are recorded but deliberately not shown to
              anyone here, because showing them would mean showing one business another business&rsquo;s
              documents. They are only reachable directly in the database, by whoever runs the
              server.
            </p>
          </div>
        </>
      )}
    </main>
  );
}
