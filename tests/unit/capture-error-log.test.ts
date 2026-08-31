/**
 * The capture side of migration 0950's error log.
 *
 * 0950 built public.error_log for one incident in particular — a bill capture
 * that failed with "the vision service could not process this file right now"
 * while the real cause, Google answering 503, was visible only in the server
 * journal — and then could not instrument the file it was written for, because
 * lib/capture/analyze.ts was being edited by a concurrent batch. This is that
 * instrumentation's test.
 *
 * Two things are pinned here, and the second matters more than the first.
 *
 * 1. THAT THE RIGHT FAILURES ARE REPORTED, once each, with the technical
 *    detail the returned CaptureExtraction deliberately does not carry: the
 *    status, Google's own wording, the caught error. And that a SUCCESS
 *    reports nothing — an error log nobody trusts because it is full of
 *    non-events is not an error log.
 *
 * 2. THAT THE GOOGLE API KEY NEVER SURVIVES THE TRIP. This app calls Gemini
 *    with the key IN THE URL QUERY STRING, and the capture path is the first
 *    caller that routinely hands such a URL to the error log. There are
 *    already 23 tests pinning lib/errors/redact.ts itself, but a redactor that
 *    works in isolation proves nothing about a call site that forgets to use
 *    it — so these tests take the failure THIS MODULE actually produces and
 *    run it through exactly what logError runs it through, rather than
 *    assuming the two meet.
 *
 * The fetch is stubbed; nothing here reaches Google. The key below is
 * SYNTHETIC — the real 39-character "AIza"+35 shape, invented characters —
 * because a test using an obviously-fake placeholder would pass against a
 * redactor that only catches obviously-fake placeholders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeCaptureImage,
  isUnusableExtraction,
  parseExtractionResponse,
  type CaptureFailure,
} from "@/lib/capture/analyze";
import { describeError, redact, redactContext } from "@/lib/errors/redact";

/** 39 characters: "AIza" + 35, exactly the Google API key shape. */
const FAKE_KEY = "AIzaSyD9z8Y7x6W5v4U3t2S1r0Q9p8O7n6M5l4K3";

const PAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

/** The URL lib/capture/analyze.ts really builds, key where it really puts it. */
const REAL_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest` +
  `:generateContent?key=${FAKE_KEY}`;

/** A Gemini 200 carrying the model's JSON in the shape the analyzer reads. */
function geminiOk(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    }),
  } as unknown as Response;
}

let originalKey: string | undefined;

beforeEach(() => {
  originalKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = FAKE_KEY;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.GOOGLE_API_KEY;
  else process.env.GOOGLE_API_KEY = originalKey;
  vi.unstubAllGlobals();
});

describe("analyzeCaptureImage — which failures are reported", () => {
  it("reports a missing API key as a warning, and makes no request at all", async () => {
    delete process.env.GOOGLE_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const seen: CaptureFailure[] = [];

    const result = await analyzeCaptureImage(PAGE, "image/jpeg", undefined, (f) => {
      seen.push(f);
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    // The caller's contract is untouched: still a CaptureExtraction, still
    // configured:false, still never an exception.
    expect(result.configured).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe("not_configured");
    // A setting that was never made is not a broken server.
    expect(seen[0].severity).toBe("warning");
  });

  it(
    "reports an unreachable service ONCE, after both models and every retry",
    async () => {
      // Rejecting every time is what "both models are unreachable" looks like:
      // two models, three attempts each.
      const fetchSpy = vi.fn(async () => {
        throw new Error(`fetch failed: POST ${REAL_URL}`);
      });
      vi.stubGlobal("fetch", fetchSpy);
      const seen: CaptureFailure[] = [];

      const result = await analyzeCaptureImage(PAGE, "image/jpeg", undefined, (f) => {
        seen.push(f);
      });

      expect(fetchSpy).toHaveBeenCalledTimes(6);
      expect(seen).toHaveLength(1);
      expect(seen[0].reason).toBe("unreachable");
      expect(seen[0].severity).toBe("error");
      expect(seen[0].context).toMatchObject({ phase: "fetch", attemptsPerModel: 3 });
      expect(result.confidence).toBe("low");
    },
    20_000
  );

  it(
    "reports the 503 from the incident with Google's own status and wording",
    async () => {
      // The real body, near enough: this is the shape that was visible only in
      // the journal while the preparer read "could not process this file".
      const body = JSON.stringify({
        error: {
          code: 503,
          message: "The model is overloaded. Please try again later.",
          status: "UNAVAILABLE",
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, status: 503, text: async () => body }) as unknown as Response)
      );
      const seen: CaptureFailure[] = [];

      await analyzeCaptureImage(PAGE, "image/jpeg", undefined, (f) => {
        seen.push(f);
      });

      expect(seen).toHaveLength(1);
      expect(seen[0].reason).toBe("upstream_error");
      // The two facts the owner-facing sentence throws away.
      expect(seen[0].message).toContain("503");
      expect(String(seen[0].detail)).toContain("overloaded");
      expect(seen[0].context).toMatchObject({ status: 503, phase: "upstream" });
    },
    20_000
  );

  it("reports an empty 200 with the finishReason that explains it", async () => {
    // A safety block is a 200 with a candidate and no parts. "The image may be
    // unclear" — what the preparer is told — is simply wrong here, and
    // finishReason is the only place the truth appears.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ candidates: [{ finishReason: "SAFETY", content: {} }] }),
          }) as unknown as Response
      )
    );
    const seen: CaptureFailure[] = [];

    await analyzeCaptureImage(PAGE, "image/jpeg", undefined, (f) => {
      seen.push(f);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe("empty_response");
    expect(seen[0].severity).toBe("warning");
    expect(String(seen[0].detail)).toContain("SAFETY");
    expect(seen[0].context).toMatchObject({ finishReason: "SAFETY" });
  });

  it("reports a reading that came back with nothing usable on it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        geminiOk({
          vendor_name: null,
          line_items: [],
          confidence: "low",
          note: "The photograph is too dark to read.",
        })
      )
    );
    const seen: CaptureFailure[] = [];

    const result = await analyzeCaptureImage(PAGE, "image/jpeg", undefined, (f) => {
      seen.push(f);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].reason).toBe("unusable_extraction");
    // The model's own note is the most useful line in the whole record.
    expect(String(seen[0].detail)).toContain("too dark");
    // And the caller still gets a normal extraction to persist and show.
    expect(result.confidence).toBe("low");
    expect(result.line_items).toEqual([]);
  });

  it("reports NOTHING when a bill is read successfully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        geminiOk({
          vendor_name: "Sharma Textiles",
          bill_number: "ST/26-27/0042",
          line_items: [{ description: "Cotton fabric", quantity: 10, rate: 250, amount: 2500 }],
          taxable_value: 2500,
          total_amount: 2950,
          confidence: "high",
          note: "Clear image.",
        })
      )
    );
    const seen: CaptureFailure[] = [];

    const result = await analyzeCaptureImage(PAGE, "image/jpeg", undefined, (f) => {
      seen.push(f);
    });

    expect(seen).toEqual([]);
    expect(result.vendor_name).toBe("Sharma Textiles");
  });

  it("survives a reporter that throws — logging must never break the reading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => geminiOk({ line_items: [], confidence: "low", note: "nothing here" }))
    );

    const result = await analyzeCaptureImage(PAGE, "image/jpeg", undefined, () => {
      throw new Error("the error logger is itself broken");
    });

    // Unchanged from the no-reporter case: a normal low-confidence extraction.
    expect(result.configured).toBe(true);
    expect(result.confidence).toBe("low");
  });

  it("keeps working for a caller that passes no reporter at all (the WhatsApp path)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    // Two arguments, exactly as app/api/whatsapp/inbound calls it.
    const result = await analyzeCaptureImage(PAGE, "image/jpeg");
    expect(result.configured).toBe(true);
    expect(result.confidence).toBe("low");
  }, 20_000);
});

/* ========================================================================== */
/* The part that matters most: the key does not survive the trip              */
/* ========================================================================== */

describe("the Google API key never reaches the error log from the capture path", () => {
  it(
    "scrubs the key out of a real unreachable-service failure, message and stack alike",
    async () => {
      // The realistic worst case, and the reason this is instrumented at all:
      // the thrown error quotes the request URL, and this app puts the key in
      // that URL's query string.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error(`request to ${REAL_URL} failed, reason: ECONNRESET`);
        })
      );
      const seen: CaptureFailure[] = [];
      await analyzeCaptureImage(PAGE, "image/jpeg", undefined, (f) => {
        seen.push(f);
      });

      // Sanity check on the test itself: the RAW detail really does carry a
      // live-shaped key, so the assertions below are not passing vacuously.
      const raw = String((seen[0].detail as Error).message);
      expect(raw).toContain(FAKE_KEY);

      // Now exactly what lib/errors/logError.ts does with a non-string detail.
      const stored = describeError(seen[0].detail);

      expect(stored).not.toContain(FAKE_KEY);
      // Not even a usable prefix — a partial key is still a leak.
      expect(stored).not.toContain(FAKE_KEY.slice(0, 16));
      expect(stored).toContain("[redacted");
      // And it is still worth reading afterwards: the host, the model and the
      // real reason all survive.
      expect(stored).toContain("generativelanguage.googleapis.com");
      expect(stored).toContain("gemini-flash-latest");
      expect(stored).toContain("ECONNRESET");
    },
    20_000
  );

  it("scrubs it even when the key is NOT this process's own — the shape rule, not the env rule", async () => {
    // Pass 1 of the redactor removes literal process.env values, which is what
    // covers the production case. This test removes that safety net entirely to
    // prove the AIza shape rule catches a key that arrived some other way — an
    // upstream body echoing it back, a stale key in a config file.
    delete process.env.GOOGLE_API_KEY;

    const stored = redact(`request to ${REAL_URL} failed`);
    expect(stored).not.toContain(FAKE_KEY);
    expect(stored).toContain("[redacted:google-api-key]");
  });

  it("scrubs the structured context too, without eating the fields worth keeping", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, text: async () => "overloaded" }) as unknown as Response)
    );
    const seen: CaptureFailure[] = [];
    await analyzeCaptureImage(PAGE, "image/jpeg", undefined, (f) => {
      seen.push(f);
    });

    // What the route builds around the reporter's own context.
    const context = redactContext({
      route: "/api/capture/extract",
      draftId: "11111111-2222-3333-4444-555555555555",
      reason: seen[0].reason,
      ...seen[0].context,
    }) as Record<string, unknown>;

    expect(JSON.stringify(context)).not.toContain(FAKE_KEY);
    // A UUID is not a credential and must not be redacted — an error log whose
    // every id is [redacted] cannot be acted on.
    expect(context.draftId).toBe("11111111-2222-3333-4444-555555555555");
    expect(context.status).toBe(503);
    expect(context.models).toEqual(["gemini-flash-latest", "gemini-flash-lite-latest"]);
  }, 20_000);
});

/* ========================================================================== */
/* isUnusableExtraction                                                       */
/* ========================================================================== */

describe("isUnusableExtraction", () => {
  it("is true for a response that could not be parsed at all", () => {
    expect(isUnusableExtraction(parseExtractionResponse("not json {{{"))).toBe(true);
  });

  it("is true for a clean parse that read nothing off the page", () => {
    expect(
      isUnusableExtraction(
        parseExtractionResponse(
          JSON.stringify({ line_items: [], confidence: "low", note: "blank page" })
        )
      )
    ).toBe(true);
  });

  it("is false as soon as ANY of the five anchors was read", () => {
    // One line item is enough to be worth reviewing.
    expect(
      isUnusableExtraction(
        parseExtractionResponse(
          JSON.stringify({
            line_items: [{ description: "Cotton fabric" }],
            confidence: "low",
            note: "blurry",
          })
        )
      )
    ).toBe(false);
    // So is a total on its own — a preparer can post from a name and a figure.
    expect(
      isUnusableExtraction(
        parseExtractionResponse(
          JSON.stringify({ line_items: [], total_amount: 2950, confidence: "low", note: "x" })
        )
      )
    ).toBe(false);
    // And a bare counterparty name.
    expect(
      isUnusableExtraction(
        parseExtractionResponse(
          JSON.stringify({ line_items: [], vendor_name: "Sharma Textiles", confidence: "low", note: "x" })
        )
      )
    ).toBe(false);
  });

  it("is false for a confident reading even if it happens to be sparse", () => {
    // Confidence alone is not the test, but a high-confidence reading is never
    // reported as unusable — the model is telling us it read the page.
    expect(
      isUnusableExtraction(
        parseExtractionResponse(
          JSON.stringify({ line_items: [], confidence: "high", note: "an empty delivery note" })
        )
      )
    ).toBe(false);
  });
});
