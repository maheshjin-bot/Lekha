/**
 * Credential scrubbing for anything on its way into public.error_log.
 *
 * ============================================================================
 * WHY THIS FILE IS THE POINT OF THE FEATURE, NOT A NICETY
 * ============================================================================
 * This app calls Gemini with the API key IN THE URL QUERY STRING:
 *
 *   https://generativelanguage.googleapis.com/v1beta/models/
 *     gemini-flash-latest:streamGenerateContent?alt=sse&key=AIza…
 *
 * (see app/api/support-chat/route.ts, and lib/capture/analyze.ts). It sends
 * Resend an `Authorization: Bearer re_…` header. A fetch failure, a thrown
 * TypeError, or an upstream body echoed back into an error message routinely
 * carries the whole request URL — key and all.
 *
 * An error log is written precisely so a non-technical owner can READ it, and
 * then screenshot it and send it to whoever is helping them. So an unredacted
 * log does not merely store a secret: it actively hands that secret to
 * whoever the owner shows the screen to. A log that leaks the key is worse
 * than no log, because it converts a private incident into a distributed one.
 *
 * ============================================================================
 * THE FOUR PASSES, IN ORDER (the order is load-bearing)
 * ============================================================================
 * 1. LITERAL ENV VALUES. Every process.env entry whose NAME looks like a
 *    secret and whose value is long enough to be one is replaced by exact
 *    string match, first, before any pattern matching. This is the only pass
 *    that is guaranteed correct rather than heuristic: it does not care what
 *    shape this deployment's keys happen to have, or whether a future
 *    provider invents a format nobody wrote a regex for. If GOOGLE_API_KEY is
 *    in the string, it goes — however it got there.
 *
 * 2. KNOWN CREDENTIAL SHAPES. Google AIza… keys, JWTs (which is what a
 *    Supabase publishable/secret key is), Resend re_…, Meta/WhatsApp EAA…,
 *    sk-… , GitHub gh?_…, AWS AKIA…, and PEM private-key blocks. These catch
 *    a credential that came from somewhere other than this process's own
 *    environment — an upstream error body, a config file, a pasted value.
 *
 * 3. Authorization: Bearer/Basic <token>. THIS MUST RUN BEFORE PASS 4, and
 *    that is not a stylistic preference — it is a bug that was caught by
 *    running the equivalent SQL backstop against a real header rather than by
 *    reading it. Run the other way round, pass 4 matches the word
 *    "Authorization", takes the literal word "Bearer" as its value, and
 *    yields `Authorization: [redacted] re_8Kd93JsLmQp2Xv7bNr4Tz1Wc` —
 *    redacting the scheme and leaving the actual credential in the clear
 *    right beside it. There is a test pinning this exact case.
 *
 * 4. <secret-word>=<value> / "<secret-word>": "<value>". The query-string and
 *    JSON case. `?key=…`, `&access_token=…`, `{"password": "…"}`.
 *
 * 5. LONG HIGH-ENTROPY RUNS. Anything 32+ characters from the credential
 *    alphabet that mixes upper case, lower case AND digits. This is the
 *    catch-all for a secret with no recognisable prefix. The mixed-case-plus-
 *    digit requirement is what keeps it from eating the identifiers this app
 *    is full of: a UUID is lower-case hex and has no upper case, a SHA hash
 *    likewise, a long snake_case identifier has no digits. Those all survive,
 *    which matters — an error log whose every id is redacted is unusable.
 *
 * ============================================================================
 * WHAT THIS DELIBERATELY DOES NOT TRY TO DO
 * ============================================================================
 *   * It does not attempt to be a PII redactor. GSTINs, PANs and phone
 *     numbers are business data this app stores in the clear everywhere else;
 *     pretending to strip them here would be theatre.
 *   * It never returns "" for a string it could not fully understand. Failing
 *     closed by blanking the message would defeat the whole feature (the
 *     owner learns nothing) — the design instead over-redacts inside the
 *     string and keeps the surrounding prose.
 *   * It is not the only line of defence. app_private.redact_error_text
 *     (migration 0950) runs the three highest-value patterns again inside the
 *     database on every write, so a caller who forgets this module still
 *     cannot land a live key in the table.
 */

/** Beyond this, regex passes are skipped and the string is cut — a bound on
 * pathological input, not on real error text (a Gemini error body is a few
 * hundred bytes). The env-literal pass in step 1 runs on the FULL string
 * before this cut, so a key sitting past the boundary is already gone by the
 * time the truncation could have sliced it into a usable prefix. */
const MAX_SCAN_LENGTH = 20_000;

/** An env var whose NAME matches this is treated as holding a secret. */
const SECRET_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DSN|SIGNATURE)/i;

/** Below this length an env value is assumed to be a flag or a mode name
 * ("true", "postgres", "production"), not a credential. Every real key this
 * app holds is far longer: a Google key is 39 characters, a JWT hundreds. */
const MIN_SECRET_ENV_VALUE_LENGTH = 12;

const REDACTED = "[redacted]";

/** Pass 2 — shapes, most specific first. */
const CREDENTIAL_SHAPES: Array<[RegExp, string]> = [
  // PEM blocks first: they contain base64 that later rules would chew up
  // piecemeal, leaving a recognisable half.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted:private-key]"],
  // Google API keys — literal "AIza" plus 35 URL-safe characters. This is the
  // exact shape of GOOGLE_API_KEY in this deployment and the exact thing the
  // Gemini URL carries in ?key=.
  [/AIza[0-9A-Za-z_-]{35}/g, "[redacted:google-api-key]"],
  // JWTs: three base64url segments, the first starting with the `{"alg":`
  // header every JWT opens with. A Supabase publishable or secret key is one.
  [/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[redacted:jwt]"],
  // Supabase's newer non-JWT key format.
  [/sb_(?:publishable|secret)_[A-Za-z0-9_-]{10,}/g, "[redacted:supabase-key]"],
  // Resend.
  [/\bre_[A-Za-z0-9]{16,}/g, "[redacted:resend-key]"],
  // OpenAI / Anthropic style.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, "[redacted:api-key]"],
  // Meta / WhatsApp Graph API access tokens.
  [/\bEAA[A-Za-z0-9]{20,}/g, "[redacted:meta-token]"],
  // GitHub.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted:github-token]"],
  // AWS access key id.
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted:aws-key-id]"],
];

/** Pass 3 — Authorization headers. Runs BEFORE pass 4; see the header. */
const BEARER_RE = /((?:^|[\s:"'])(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** Pass 4 — <secret-word> = <value> in a URL, a JSON body or a log line.
 * The leading class anchors the word so "monkey=" is not read as "key=" and
 * "tokenizer:" is not read as "token:". The negative lookahead keeps this off
 * a scheme word pass 3 has already handled. The value uses a POSITIVE
 * character class so it stops of its own accord at `&`, a quote or a brace. */
const KEY_VALUE_RE =
  /((?:^|[?&#;,{\s"'(])(?:api[_-]?key|apikey|key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|signature|auth|authorization|session|cookie)["']?\s*[=:]\s*["']?)(?!bearer\s|basic\s)[A-Za-z0-9._~%+/=-]{6,}/gi;

/** Pass 5 — long high-entropy runs. */
const LONG_RUN_RE = /[A-Za-z0-9_-]{32,}/g;
const BASE64ISH_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;

function looksHighEntropy(token: string): boolean {
  // Upper AND lower AND a digit. A UUID (lower hex + dashes), a SHA-1/256
  // hash, and a long snake_case identifier each fail at least one of these
  // and are therefore left alone — which is deliberate, because an error log
  // in which every id has been replaced by [redacted] cannot be acted on.
  return /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token);
}

/**
 * Pass 1. Exact-match removal of this process's own secrets, whatever shape
 * they happen to be. Read from process.env on every call rather than cached
 * at module load, so a value rotated (or set by a test) at runtime is still
 * covered.
 */
function redactEnvSecrets(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value !== "string") continue;
    if (value.length < MIN_SECRET_ENV_VALUE_LENGTH) continue;
    if (!SECRET_ENV_NAME.test(name)) continue;
    // split/join rather than replaceAll with a RegExp: the value is arbitrary
    // text and must never be interpreted as a pattern.
    if (out.includes(value)) {
      out = out.split(value).join(`[redacted:${name}]`);
    }
  }
  return out;
}

/**
 * Scrub one string. Never throws, never returns null, and never blanks the
 * whole string — it replaces the secret parts and leaves the prose that makes
 * the entry readable.
 */
export function redact(input: unknown): string {
  let text: string;
  try {
    text = typeof input === "string" ? input : String(input);
  } catch {
    return "[unprintable value]";
  }
  if (text.length === 0) return text;

  try {
    // 1 — literal env values, on the FULL string, before any truncation.
    let out = redactEnvSecrets(text);

    if (out.length > MAX_SCAN_LENGTH) {
      out = `${out.slice(0, MAX_SCAN_LENGTH)}… [truncated]`;
    }

    // 2 — known shapes.
    for (const [pattern, replacement] of CREDENTIAL_SHAPES) {
      out = out.replace(pattern, replacement);
    }

    // 3 — Authorization headers. Before pass 4, always.
    out = out.replace(BEARER_RE, `$1${REDACTED}`);

    // 4 — key=value pairs.
    out = out.replace(KEY_VALUE_RE, `$1${REDACTED}`);

    // 5 — long high-entropy runs with no recognisable prefix.
    out = out.replace(LONG_RUN_RE, (m) => (looksHighEntropy(m) ? "[redacted:credential]" : m));
    out = out.replace(BASE64ISH_RE, (m) => (looksHighEntropy(m) ? "[redacted:credential]" : m));

    return out;
  } catch {
    // A redactor that throws would either take down the caller or (worse)
    // tempt someone into logging the raw string instead. Fail to a constant.
    return "[redaction failed — original text withheld]";
  }
}

/** Object keys whose VALUE is a secret regardless of what it looks like.
 * The textual passes above cannot see structure — `{ apiKey: "abc" }` has no
 * `=` and a value too short for any shape rule — so context objects get this
 * name-based check as well. */
const SECRET_KEY_NAME =
  /^(?:.*[_-])?(?:api[_-]?key|apikey|key|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd|auth|authorization|credential|signature|cookie|session)$/i;

/**
 * Scrub a structured context object, recursively. Object KEYS are left alone
 * — they are field names this app chooses, not values — but a key that names
 * a secret has its whole value replaced, at any depth, whatever its type.
 */
export function redactContext(input: unknown, depth = 0): unknown {
  if (depth > 8) return "[redacted:too deep]";
  if (input === null || input === undefined) return input;

  if (typeof input === "string") return redact(input);
  if (typeof input === "number" || typeof input === "boolean") return input;

  if (Array.isArray(input)) {
    return input.slice(0, 50).map((v) => redactContext(v, depth + 1));
  }

  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = SECRET_KEY_NAME.test(key) ? REDACTED : redactContext(value, depth + 1);
    }
    return out;
  }

  // Functions, symbols, bigints — stringified and scrubbed like anything else.
  return redact(input);
}

/** Longest stack we will keep. Enough for the frames that matter, short
 * enough that the detail pane stays readable. */
const MAX_STACK_CHARS = 1500;

/**
 * Turn a caught value into the technical detail line, redacted. Keeps the
 * error's own name and message, plus a trimmed stack, plus `cause` when there
 * is one — a fetch failure's real reason (ECONNREFUSED, ENOTFOUND) lives on
 * `cause` and is the single most useful thing in it.
 */
export function describeError(err: unknown): string {
  if (err === null || err === undefined) return "";
  try {
    if (err instanceof Error) {
      const parts = [`${err.name}: ${err.message}`];
      if (err.stack) parts.push(err.stack.slice(0, MAX_STACK_CHARS));
      const cause = (err as Error & { cause?: unknown }).cause;
      if (cause !== undefined && cause !== null) {
        parts.push(
          `caused by: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`
        );
      }
      return redact(parts.join("\n"));
    }
    if (typeof err === "object") return redact(JSON.stringify(err));
    return redact(err);
  } catch {
    return "[could not describe this error]";
  }
}
