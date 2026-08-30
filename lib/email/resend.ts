/**
 * Email transport — Resend, over a plain fetch() call, no SDK.
 *
 * WHY RESEND AND WHY NO SDK: see supabase/migrations/0122_email_notifications.sql's
 * header for the researched-live pricing/limits comparison against AWS SES.
 * The short version: Resend's free tier (3,000/month, 100/day, no card, no
 * sandbox-approval wait) fits "a few companies, a handful of emails a day"
 * far better than SES's 2026 shape (no free tier at all for any account
 * created after 15 Jul 2025, and a sandbox that requires verifying every
 * recipient individually until AWS manually approves production access).
 * Resend's entire API is one authenticated POST — reaching for their npm
 * package would add a dependency for a single fetch() call, and this repo's
 * package.json/package-lock.json already carry a concurrent session's
 * uncommitted changes (see git status at the time this was written) that a
 * fresh `npm install` here would collide with. Raw fetch avoids that
 * entirely.
 *
 * GRACEFUL NO-OP WITHOUT CREDENTIALS: this task explicitly does not
 * provision a live RESEND_API_KEY. Every caller of sendTransactionalEmail
 * gets a normal, awaitable result either way — { skipped: true } when the
 * env var is absent, never a thrown exception — so this ships safely today
 * and starts actually delivering the moment an operator sets the two env
 * vars below, with no code change.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logError } from "@/lib/errors/logError";

const RESEND_API_URL = "https://api.resend.com/emails";

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  /**
   * Optional attribution for the durable error log (public.error_log, 0950).
   * This module is a pure transport and knows nothing about companies, so a
   * failure logged from here would otherwise land with no company_id and be
   * visible to almost nobody. Callers that DO know whose email this was —
   * lib/notifications/dispatchPending, today the only one — pass it, and the
   * failure shows up on that company's own error-log screen.
   *
   * Logging happens HERE rather than in the caller so there is exactly one
   * record per failed send: the transport knows the status code and the
   * provider's own wording, which is what the screen turns into advice.
   */
  errorScope?: { supabase?: SupabaseClient; companyId?: string | null };
}

export interface SendEmailResult {
  ok: boolean;
  /** True when no attempt was made at all because RESEND_API_KEY is unset. */
  skipped?: boolean;
  error?: string;
  /** Resend's own message id, when a send actually succeeded. */
  id?: string;
}

/**
 * Sends one transactional email via the Resend API. Never throws — a
 * missing key, a network failure, or a non-2xx response are all reported
 * back in the returned result so callers (the notifications send route) can
 * record success/failure per notification without a try/catch of their own.
 */
export async function sendTransactionalEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  // onboarding@resend.dev works with zero setup but — confirmed live, see
  // the migration header — can only deliver to the email address that
  // signed up for the Resend account until a real domain is verified.
  // RESEND_FROM_EMAIL lets an operator switch to a verified domain's
  // address without a code change once one exists.
  const from = process.env.RESEND_FROM_EMAIL || "LEKHA <onboarding@resend.dev>";

  if (!apiKey) {
    const to = Array.isArray(input.to) ? input.to.join(", ") : input.to;
    console.log(
      `[email] RESEND_API_KEY is not set — skipping send to ${to}: "${input.subject}". ` +
        "Set RESEND_API_KEY (and RESEND_FROM_EMAIL once a domain is verified in Resend) to enable real delivery."
    );
    // Recorded as a warning, not an error: nothing broke. But "my reminder
    // emails never arrive" is otherwise completely silent from the owner's
    // side, and this is the one line that explains it. Repeats collapse onto
    // a single row with a count (see 0950), so a nightly digest of thirty
    // notifications does not produce thirty entries.
    await logError({
      operation: "email_send",
      severity: "warning",
      message: "Emails are not switched on for this server, so nothing was sent.",
      detail:
        "RESEND_API_KEY is not set in the server environment. No request was made to Resend; " +
        `the message "${input.subject}" was skipped and is still marked pending.`,
      companyId: input.errorScope?.companyId ?? null,
      supabase: input.errorScope?.supabase,
      context: { provider: "resend", reason: "missing_env", recipients: Array.isArray(input.to) ? input.to.length : 1 },
    });
    return { ok: false, skipped: true };
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[email] Resend API returned ${res.status} for "${input.subject}": ${body}`);
      await logError({
        operation: "email_send",
        message: `An email could not be sent — Resend replied ${res.status}.`,
        // Resend's error bodies quote the request back, and this request
        // carries an `Authorization: Bearer re_…` header. Redaction is not
        // optional here. See lib/errors/redact.ts.
        detail: `Subject: "${input.subject}"
HTTP ${res.status}
${body.slice(0, 1500)}`,
        companyId: input.errorScope?.companyId ?? null,
        supabase: input.errorScope?.supabase,
        context: { provider: "resend", status: res.status },
      });
      return { ok: false, error: `Resend API ${res.status}: ${body.slice(0, 300)}` };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email] Failed to reach Resend for "${input.subject}": ${message}`);
    await logError({
      operation: "email_send",
      message: "An email could not be sent — we could not reach the email service at all.",
      detail: err,
      companyId: input.errorScope?.companyId ?? null,
      supabase: input.errorScope?.supabase,
      context: { provider: "resend", subject: input.subject },
    });
    return { ok: false, error: message };
  }
}
