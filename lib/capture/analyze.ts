/**
 * Shared server-side vision analysis for OCR/vision bill capture (0740).
 *
 * Mirrors app/api/support-chat/route.ts's exact Gemini pattern: same model
 * alias, same env var, same "not configured" shape when the key is missing —
 * see that file's own comments for why "gemini-flash-latest" and not a pinned
 * snapshot. This module never throws. A bad image, a missing key, a network
 * failure or a malformed model response all come back as a normal
 * CaptureExtraction with confidence "low" and a `note` explaining why —
 * never an exception the caller has to remember to catch. The caller (the
 * /api/capture/analyze route) always has something to save to
 * capture_drafts.extracted_json, even on total failure.
 *
 * DELIBERATELY NOT HERE: any database access, any Supabase import, any
 * knowledge of capture_drafts. This file takes bytes and returns a typed
 * result — the route owns storage and the table row.
 */

// Ordered fallback, not a single model. Both entries are Google-MAINTAINED
// ALIASES, never pinned snapshots: support-chat's own comment records that
// "gemini-2.5-pro" was retired for new API keys and 404'd, which is exactly
// why an alias is used here. That reasoning still holds — probing this key
// today, the pinned "gemini-2.5-flash" 404s while every alias resolves — so
// the fix for an overloaded model is a SECOND ALIAS, never a pin.
//
// Why a fallback at all: observed live in production, gemini-flash-latest
// returned 503 "This model is currently experiencing high demand" on all
// three retry attempts and on three further probes two minutes later, while
// gemini-flash-lite-latest answered 200 throughout. A sustained overload on
// one model is not something a few hundred milliseconds of backoff can ride
// out, so once the retries are spent we move to the next model rather than
// giving up and making the preparer type the whole bill in by hand.
//
// Lite is second, not first: it is a smaller model and this is OCR of a
// document whose numbers get posted to a ledger, so the stronger model is
// always tried first and lite only rescues an outage.
const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"] as const;

/** Structured extraction for one uploaded/forwarded Indian purchase bill/invoice. */
export type CaptureExtraction = {
  /** False only when GOOGLE_API_KEY is not set on this server. */
  configured: boolean;
  vendor_name: string | null;
  vendor_gstin: string | null;
  /** Best-effort ISO 8601 (yyyy-mm-dd), or null if illegible/undeterminable. */
  bill_date: string | null;
  line_items: CaptureLineItem[];
  taxable_value: number | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  total_amount: number | null;
  confidence: "high" | "medium" | "low";
  /** Always present — what the model saw, or why nothing could be extracted. */
  note: string;
};

export type CaptureLineItem = {
  description: string;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
};

const PROMPT = `You are extracting structured data from a photograph or scan of an Indian
purchase bill / tax invoice for accounting entry. Read every visible field
carefully and return ONLY the fields you can actually read.

Rules:
- If a field is illegible, absent, or you are not confident, use null for it
  rather than guessing a plausible-looking value.
- bill_date must be ISO 8601 (yyyy-mm-dd) if you can determine it, else null.
  Indian bills are usually dd/mm/yyyy or dd-mm-yyyy — convert, do not assume
  mm/dd/yyyy.
- vendor_gstin, if visible, is exactly 15 characters (2-digit state code + 10-
  character PAN + entity code + 'Z' + checksum). Do not fabricate one.
- line_items should list every distinct item/service line you can read, with
  its description text as printed, and quantity/rate/amount as plain numbers
  (no currency symbols or thousands separators). Use null for any of those
  three you cannot read for a given line, but still include the line if its
  description is legible.
- taxable_value is the pre-tax subtotal if shown or derivable; cgst/sgst/igst
  are the tax amounts actually printed (not rates); total_amount is the final
  payable amount.
- confidence: "high" if the image is clear and every major field was read
  with confidence; "medium" if legible but some fields are uncertain or
  missing; "low" if the image is blurry, cropped, not a bill at all, or most
  fields could not be read.
- note: one or two plain sentences on what you read and any doubts — e.g.
  which fields you could not read and why (blur, glare, cut off, handwritten,
  not a bill). Never leave this empty.

Return JSON matching the given schema only.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    vendor_name: { type: "STRING", nullable: true },
    vendor_gstin: { type: "STRING", nullable: true },
    bill_date: { type: "STRING", nullable: true },
    line_items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          description: { type: "STRING" },
          quantity: { type: "NUMBER", nullable: true },
          rate: { type: "NUMBER", nullable: true },
          amount: { type: "NUMBER", nullable: true },
        },
        required: ["description"],
      },
    },
    taxable_value: { type: "NUMBER", nullable: true },
    cgst: { type: "NUMBER", nullable: true },
    sgst: { type: "NUMBER", nullable: true },
    igst: { type: "NUMBER", nullable: true },
    total_amount: { type: "NUMBER", nullable: true },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    note: { type: "STRING" },
  },
  required: ["line_items", "confidence", "note"],
} as const;

/** What every "nothing usable happened" path returns — never thrown. */
function fallback(note: string): CaptureExtraction {
  return {
    configured: true,
    vendor_name: null,
    vendor_gstin: null,
    bill_date: null,
    line_items: [],
    taxable_value: null,
    cgst: null,
    sgst: null,
    igst: null,
    total_amount: null,
    confidence: "low",
    note,
  };
}

function notConfigured(): CaptureExtraction {
  return {
    ...fallback(
      "Vision capture isn't configured on this server yet (missing GOOGLE_API_KEY). Fill in the bill details manually below."
    ),
    configured: false,
  };
}

// Same retry shape as app/api/support-chat/route.ts, for the same reason:
// Gemini's free tier occasionally 429s/503s and clears a moment later.
const RETRYABLE_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [400, 1000];

async function fetchGeminiWithRetry(urls: readonly string[], body: string): Promise<Response> {
  let lastRetryable: Response | null = null;
  let lastError: unknown = null;

  // Each model gets the full backoff before we move on, so an ordinary blip
  // is still ridden out on the preferred model rather than silently demoting
  // every request to the weaker one.
  for (const url of urls) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        // A non-retryable status is this model's real answer — return it
        // rather than asking another model the same question.
        if (res.ok || !RETRYABLE_STATUSES.has(res.status)) return res;
        lastRetryable = res;
        if (isLastAttempt) break;
      } catch (err) {
        lastError = err;
        if (isLastAttempt) break;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }

  // Every model exhausted. Hand back the last real response if there was one,
  // so the caller logs Google's own status and message rather than a generic
  // failure it would have to guess at.
  if (lastRetryable) return lastRetryable;
  throw lastError ?? new Error("fetchGeminiWithRetry: exhausted attempts without returning");
}

function isFiniteNumberOrNull(v: unknown): v is number | null {
  return v === null || v === undefined || (typeof v === "number" && Number.isFinite(v));
}

function toNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isPlainLineItem(v: unknown): v is CaptureLineItem {
  if (!v || typeof v !== "object") return false;
  const { description, quantity, rate, amount } = v as Record<string, unknown>;
  return (
    typeof description === "string" &&
    description.trim().length > 0 &&
    isFiniteNumberOrNull(quantity) &&
    isFiniteNumberOrNull(rate) &&
    isFiniteNumberOrNull(amount)
  );
}

/**
 * Parses and validates Gemini's own JSON text into a CaptureExtraction.
 * Pure and synchronous — no network — so it is unit-testable without mocking
 * fetch. Never throws: an unparseable or wrongly-shaped response degrades to
 * a "low confidence, could not extract" result rather than propagating.
 */
export function parseExtractionResponse(rawJsonText: string): CaptureExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJsonText);
  } catch {
    return fallback(
      "The vision model's response could not be read as JSON. Fill in the bill details manually below."
    );
  }

  if (!parsed || typeof parsed !== "object") {
    return fallback("The vision model returned an unexpected response. Fill in the bill details manually below.");
  }

  const p = parsed as Record<string, unknown>;
  const lineItemsRaw = Array.isArray(p.line_items) ? p.line_items : [];
  const lineItems = lineItemsRaw.filter(isPlainLineItem).map((li) => ({
    description: li.description.trim(),
    quantity: toNumberOrNull(li.quantity),
    rate: toNumberOrNull(li.rate),
    amount: toNumberOrNull(li.amount),
  }));

  const confidence = p.confidence === "high" || p.confidence === "medium" || p.confidence === "low"
    ? p.confidence
    : "low";

  return {
    configured: true,
    vendor_name: typeof p.vendor_name === "string" && p.vendor_name.trim() ? p.vendor_name.trim() : null,
    vendor_gstin: typeof p.vendor_gstin === "string" && p.vendor_gstin.trim() ? p.vendor_gstin.trim().toUpperCase() : null,
    bill_date: typeof p.bill_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(p.bill_date) ? p.bill_date : null,
    line_items: lineItems,
    taxable_value: toNumberOrNull(p.taxable_value),
    cgst: toNumberOrNull(p.cgst),
    sgst: toNumberOrNull(p.sgst),
    igst: toNumberOrNull(p.igst),
    total_amount: toNumberOrNull(p.total_amount),
    confidence,
    note: typeof p.note === "string" && p.note.trim() ? p.note.trim() : "The model returned no notes.",
  };
}

/**
 * Analyzes one uploaded/forwarded bill image or PDF. Never throws — every
 * failure mode (no API key, network error, non-OK response, unparseable
 * output) returns a CaptureExtraction with confidence "low" and a `note`
 * explaining what happened, so the caller always has something to persist
 * and show for review.
 */
export async function analyzeCaptureImage(
  fileBuffer: Buffer,
  mimeType: string
): Promise<CaptureExtraction> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return notConfigured();
  }

  const base64 = fileBuffer.toString("base64");

  let upstream: Response;
  try {
    upstream = await fetchGeminiWithRetry(
      MODELS.map(
        (m) =>
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`
      ),
      JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: PROMPT }, { inlineData: { mimeType, data: base64 } }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      })
    );
  } catch (err) {
    console.error("[capture/analyze] failed to reach Gemini", err);
    return fallback(
      "Could not reach the vision service right now. Fill in the bill details manually below."
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    console.error("[capture/analyze] Gemini error", upstream.status, errText.slice(0, 500));
    return fallback(
      "The vision service could not process this file right now. Fill in the bill details manually below."
    );
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return fallback(
      "The vision service's response could not be read. Fill in the bill details manually below."
    );
  }

  const text = (
    body as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    }
  )?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof text !== "string" || !text.trim()) {
    return fallback(
      "The vision service returned no readable content — the image may be unclear or not a bill. Fill in the bill details manually below."
    );
  }

  return parseExtractionResponse(text);
}
