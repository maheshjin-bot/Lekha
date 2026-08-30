import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc } from "@/lib/supabase/rpc";
import { redact, redactContext, describeError } from "@/lib/errors/redact";

/**
 * The server-side write helper for public.error_log (migration 0950).
 *
 * ============================================================================
 * THE TWO PROMISES THIS FILE MAKES, AND WHY THEY MATTER MORE THAN THE FEATURE
 * ============================================================================
 * 1. IT NEVER THROWS. Every call is wrapped, including the client
 *    construction, the redaction, and the RPC itself. Logging an error must
 *    not become a second error: a route that fell over because its error
 *    logger fell over is strictly worse than one that never logged anything.
 *
 * 2. IT NEVER CHANGES WHAT THE CALLER RETURNS. logError resolves to void, in
 *    every case — success, RPC refusal, timeout, no session, no database. The
 *    caller's own control flow, status code and user-facing message are
 *    untouched by whether the log write worked. It is added ALONGSIDE the
 *    existing console.error in every instrumented file, never instead of it,
 *    so the server journal keeps everything it had before.
 *
 * A corollary of both: when the insert fails, the fallback is console.error
 * and nothing else. The original failure has already been logged by the
 * caller; this file's fallback reports only its own failure to record it, so
 * the two are distinguishable in the journal.
 *
 * ============================================================================
 * THE TIMEOUT
 * ============================================================================
 * Awaiting a database round trip inside an error path can stall a response
 * that was already going to be slow. The whole write races a 3-second timer,
 * so the worst case a user experiences is three seconds added to a request
 * that had already failed — never a hung one. On timeout the write may still
 * land server-side; that is fine, since a duplicate is collapsed by
 * write_error_log's repeat handling rather than producing a second row.
 *
 * ============================================================================
 * WHICH RPC, AND WHY THERE ARE TWO
 * ============================================================================
 * `log_error` is granted to authenticated only and is what almost every
 * caller wants. `log_error_global` is the narrow anon-reachable one, for a
 * failure that happens with no session at all — the inbound WhatsApp webhook
 * being the only such caller today. Pass `global: true` to reach it. Note
 * what that costs: by the read rule in 0950, a row with neither company nor
 * user is visible to NOBODY in the app, so a global row is a record for an
 * operator with database access, not something the owner will see on screen.
 * Use it only where there genuinely is no session — never as a way to avoid
 * thinking about attribution.
 */

export type ErrorSeverity = "warning" | "error" | "critical";

export interface LogErrorInput {
  /** Stable short code for what was being attempted: capture_vision,
   * support_chat, email_send, whatsapp_webhook, pdf_export, … Lowercase
   * snake_case, 3-40 characters (enforced by a CHECK on the column). */
  operation: string;
  /** Plain language, written for a non-technical owner, not for a developer.
   * "The bill reader was busy" — not "GenerateContent 503". */
  message: string;
  severity?: ErrorSeverity;
  /** The raw technical text: an Error, a response body, a status line.
   * Anything at all — it is stringified, redacted and stored collapsed. */
  detail?: unknown;
  /** The company this failure belongs to, when one is known. The caller must
   * be a member of it; log_error raises otherwise (and this helper swallows
   * that into console.error, as it does any other failure). */
  companyId?: string | null;
  /** Safe structured context — route, model, status code. String values are
   * redacted; a key that names a secret has its value dropped entirely. */
  context?: Record<string, unknown>;
  /** Reuse the caller's Supabase client rather than building a new one.
   * Always pass it when you have one: it keeps the session (and therefore
   * the user_id stamp and the membership check) identical to the caller's. */
  supabase?: SupabaseClient;
  /** Route through log_error_global — for a failure with no session at all.
   * See the note above on what this costs in visibility. */
  global?: boolean;
}

const WRITE_TIMEOUT_MS = 3_000;

/** Races a promise against a timer, clearing the timer either way so a
 * pending timeout can never hold a serverless invocation open. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`error-log write timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

async function write(input: LogErrorInput): Promise<void> {
  let supabase = input.supabase;
  if (!supabase) {
    // Imported lazily and inside the try: lib/supabase/server reaches for
    // next/headers cookies(), which throws outside a request scope. A caller
    // logging from somewhere without one should get the console fallback,
    // not a crash.
    const { createClient } = await import("@/lib/supabase/server");
    supabase = (await createClient()) as unknown as SupabaseClient;
  }

  const message = redact(input.message);
  const detail =
    input.detail === undefined || input.detail === null
      ? null
      : typeof input.detail === "string"
        ? redact(input.detail)
        : describeError(input.detail);
  const context = redactContext(input.context ?? {}) as Record<string, unknown>;
  const severity: ErrorSeverity = input.severity ?? "error";

  const { error } = input.global
    ? await callRpc<Record<string, unknown>, unknown>(supabase, "log_error_global", {
        p_operation: input.operation,
        p_message: message,
        p_severity: severity,
        p_detail: detail,
        p_context: context,
      })
    : await callRpc<Record<string, unknown>, unknown>(supabase, "log_error", {
        p_operation: input.operation,
        p_message: message,
        p_severity: severity,
        p_detail: detail,
        p_company_id: input.companyId ?? null,
        p_context: context,
      });

  if (error) throw new Error(error.message);
}

/**
 * Record one application failure durably. Resolves to void always; never
 * throws; never alters the caller's own result. Add it beside an existing
 * console.error, not in place of one.
 */
export async function logError(input: LogErrorInput): Promise<void> {
  try {
    await withTimeout(write(input), WRITE_TIMEOUT_MS);
  } catch (err) {
    // Second-order failure. The caller has already logged the ORIGINAL
    // problem to the journal; this line reports only that we could not make a
    // durable record of it, so the two never get confused for each other.
    // Redacted like everything else — this message can carry an RPC error
    // string that quotes the arguments back.
    try {
      console.error(
        `[error-log] could not record "${input.operation}": ${redact(
          err instanceof Error ? err.message : String(err)
        )}`
      );
    } catch {
      // Even console.error is not allowed to break the caller.
    }
  }
}
