/**
 * Redaction is the core of the error-log feature, not a nicety, so these are
 * the tests that matter most in it.
 *
 * The headline case is the real one from this app: app/api/support-chat and
 * lib/capture/analyze both call Gemini with the API key IN THE URL QUERY
 * STRING, so any naive log of a failed fetch writes a live Google key into a
 * table the owner can read and screenshot. Everything else here exists to
 * stop that being fixed narrowly and regressing sideways.
 *
 * The keys below are SYNTHETIC — real shapes, invented characters. They are
 * built to be indistinguishable from live credentials to the redactor, which
 * is the whole point: a test using an obviously-fake "XXXX" placeholder would
 * pass against a redactor that only matches obviously-fake placeholders.
 */
import { afterEach, describe, expect, it } from "vitest";
import { redact, redactContext, describeError } from "@/lib/errors/redact";

/** 39 characters: "AIza" + 35, exactly the Google API key shape. */
const GOOGLE_KEY = "AIzaSyD1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P";

/** The real URL this app builds, with the key where this app actually puts it. */
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest` +
  `:streamGenerateContent?alt=sse&key=${GOOGLE_KEY}`;

describe("redact — the Google key in the Gemini URL (the case this feature exists for)", () => {
  it("removes the key from the URL this app really builds", () => {
    const out = redact(`fetch failed: POST ${GEMINI_URL} -> 503`);

    // The assertion that matters: the literal key is gone.
    expect(out).not.toContain(GOOGLE_KEY);
    // And no usable prefix of it survives either — a partial key is still a
    // leak, and is exactly what a naive `slice()`-based fix would leave.
    expect(out).not.toContain(GOOGLE_KEY.slice(0, 16));
    expect(out).toContain("[redacted");
  });

  it("keeps everything a reader actually needs — which host, which model, which status", () => {
    const out = redact(`fetch failed: POST ${GEMINI_URL} -> 503`);
    expect(out).toContain("generativelanguage.googleapis.com");
    expect(out).toContain("gemini-flash-latest");
    expect(out).toContain("503");
  });

  it("catches the key even with no ?key= around it — a bare key pasted into a message", () => {
    expect(redact(`the configured key is ${GOOGLE_KEY}`)).not.toContain(GOOGLE_KEY);
  });

  it("catches the key when the URL uses ?key= but a shape rule would not fire", () => {
    // A hypothetical future key format with no AIza prefix: the key=value
    // pass has to carry it on its own.
    const out = redact("https://example.test/v1?key=Zq7bNr4Tz1WcKd93JsLmQp2Xv&status=401");
    expect(out).not.toContain("Zq7bNr4Tz1WcKd93JsLmQp2Xv");
    expect(out).toContain("status=401");
  });
});

describe("redact — the Authorization header ordering bug", () => {
  // This case is here because it was a REAL defect, found by running the
  // equivalent SQL backstop against a real header rather than by reading it.
  // With the key=value pass running before the Bearer pass, "Authorization:"
  // matched, the literal word "Bearer" was consumed as the value, and the
  // output was "Authorization: [redacted] re_8Kd93…" — the scheme redacted
  // and the actual credential left in the clear immediately after it.
  const RESEND_KEY = "re_8Kd93JsLmQp2Xv7bNr4Tz1Wc";

  it("redacts the token, not the word Bearer", () => {
    const out = redact(`Authorization: Bearer ${RESEND_KEY}`);
    expect(out).not.toContain(RESEND_KEY);
    expect(out).not.toContain(RESEND_KEY.slice(0, 12));
  });

  it("redacts a Basic credential too", () => {
    const out = redact("authorization: Basic dXNlcm5hbWU6c3VwZXJTZWNyZXQxMjM0NTY3");
    expect(out).not.toContain("dXNlcm5hbWU6c3VwZXJTZWNyZXQxMjM0NTY3");
  });
});

describe("redact — other credential shapes that reach this app", () => {
  it("redacts a JWT, which is what a Supabase key is", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9" +
      ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const out = redact(`PostgREST rejected the key ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("eyJzdWIiOiIxMjM0NTY3ODkw");
  });

  it("redacts a Meta/WhatsApp Graph token", () => {
    const meta = "EAAG7ZBxK9ZCoBO4ZBn2mQZDZD8vLpQr3sTuVwXyZ012345678";
    expect(redact(`Graph API 190: ${meta}`)).not.toContain(meta);
  });

  it("redacts secrets in a JSON body", () => {
    const out = redact('{"api_key":"sk-proj-8Kd93JsLmQp2Xv7bNr4Tz1Wc","password":"hunter2hunter2"}');
    expect(out).not.toContain("sk-proj-8Kd93JsLmQp2Xv7bNr4Tz1Wc");
    expect(out).not.toContain("hunter2hunter2");
  });

  it("redacts a PEM private key block whole, not in fragments", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1a2B3c4D\nZ9x8Y7w6V5u4T3s2R1q0\n-----END RSA PRIVATE KEY-----";
    const out = redact(`signing failed with ${pem}`);
    expect(out).not.toContain("MIIEowIBAAKCAQEA1a2B3c4D");
    expect(out).toContain("[redacted:private-key]");
  });

  it("catches a long high-entropy credential with no recognisable prefix", () => {
    const opaque = "Xr9TkQm2Zb7Lp4Wv6Hd1Nc8Ja3Fy5Gs0Ue";
    expect(redact(`upstream said: ${opaque}`)).not.toContain(opaque);
  });
});

describe("redact — what must SURVIVE, so the log stays usable", () => {
  it("leaves UUIDs alone", () => {
    const companyId = "395e9f55-99c9-449c-a861-f1ac1da1513f";
    expect(redact(`company ${companyId} had no purchase ledger`)).toContain(companyId);
  });

  it("does not mistake monkey= for key= or tokenizer: for token:", () => {
    const out = redact("monkey=banana, tokenizer: on, keyboard=present");
    expect(out).toContain("monkey=banana");
    expect(out).toContain("tokenizer: on");
    expect(out).toContain("keyboard=present");
  });

  it("leaves ordinary prose, hostnames and status codes intact", () => {
    const text = "Resend API 422 for \"GSTR-1 due in 3 days\": domain is not verified";
    expect(redact(text)).toBe(text);
  });

  it("leaves a lowercase hex hash alone — no upper case, so not credential-shaped", () => {
    const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    expect(redact(`checksum ${sha}`)).toContain(sha);
  });

  it("never blanks the whole string", () => {
    const out = redact(`${GEMINI_URL} exploded`);
    expect(out.length).toBeGreaterThan(20);
    expect(out).toContain("exploded");
  });
});

describe("redact — this process's own environment values, whatever their shape", () => {
  const ORIGINAL = process.env.SOME_PROVIDER_SECRET;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SOME_PROVIDER_SECRET;
    else process.env.SOME_PROVIDER_SECRET = ORIGINAL;
  });

  it("removes a live env secret even when it matches no known shape at all", () => {
    // Deliberately shaped like nothing: lowercase, no prefix, no entropy mix.
    // Only the env pass can catch this, which is why that pass exists.
    process.env.SOME_PROVIDER_SECRET = "correcthorsebatterystaple";
    const out = redact("upstream rejected correcthorsebatterystaple with 401");
    expect(out).not.toContain("correcthorsebatterystaple");
    expect(out).toContain("401");
  });

  it("does not redact a short env value that is plainly a flag, not a secret", () => {
    process.env.SOME_PROVIDER_SECRET = "true";
    expect(redact("the flag was true")).toContain("true");
  });
});

describe("redactContext — structured context", () => {
  it("drops the value of any key that names a secret, however short", () => {
    const out = redactContext({ apiKey: "abc", model: "gemini-flash-latest" }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.model).toBe("gemini-flash-latest");
  });

  it("scrubs string values at any depth, and leaves keys and numbers alone", () => {
    const out = redactContext({
      status: 503,
      request: { url: GEMINI_URL, retries: [{ note: `tried ${GOOGLE_KEY}` }] },
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain(GOOGLE_KEY);
    expect(json).toContain("503");
    expect(json).toContain("request");
    expect(json).toContain("retries");
  });

  it("does not recurse without limit on a cyclic-looking deep structure", () => {
    let deep: Record<string, unknown> = { leaf: GOOGLE_KEY };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    const json = JSON.stringify(redactContext(deep));
    expect(json).not.toContain(GOOGLE_KEY);
  });
});

describe("describeError", () => {
  it("keeps the name, message and cause, and redacts every one of them", () => {
    const cause = new Error(`connect ECONNREFUSED while calling ${GEMINI_URL}`);
    const err = new Error("fetch failed", { cause });
    const out = describeError(err);
    expect(out).not.toContain(GOOGLE_KEY);
    expect(out).toContain("fetch failed");
    expect(out).toContain("ECONNREFUSED");
  });

  it("handles a thrown non-Error without throwing itself", () => {
    expect(describeError({ status: 503, key: GOOGLE_KEY })).not.toContain(GOOGLE_KEY);
    expect(describeError("plain string")).toContain("plain string");
    expect(describeError(null)).toBe("");
  });
});
