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

const RESEND_API_URL = "https://api.resend.com/emails";

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
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
      return { ok: false, error: `Resend API ${res.status}: ${body.slice(0, 300)}` };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: data.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email] Failed to reach Resend for "${input.subject}": ${message}`);
    return { ok: false, error: message };
  }
}
