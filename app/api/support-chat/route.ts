import { createClient } from "@/lib/supabase/server";
import { logError } from "@/lib/errors/logError";

/**
 * Backend for the floating support chat (components/support/SupportChatWidget.tsx).
 * Deliberately stateless and ephemeral: the client holds the whole transcript
 * and resends it each turn; nothing here touches the database or a user's
 * company/ledger data, so there's no risk of ledger figures leaking into a
 * third-party model's free-tier training data. See
 * [[lekha-ai-cost-comparison-artifact]] in project memory for why Gemini.
 */

// "gemini-2.5-pro" (pinned) was retired for new API keys as of this writing,
// and the Pro tier's replacements need billing enabled — this key's project
// is free-tier only. "gemini-flash-latest" is a Google-maintained alias that
// always points at their current flash model, works on the free tier, and
// won't 404 again the way a pinned snapshot did. Swap to a Pro model name
// once billing is set up, if the flash tier's answers aren't sharp enough.
// Ordered fallback. Both are Google-MAINTAINED ALIASES, never pinned
// snapshots — the comment below records why a pin was wrong, and probing
// this key today still bears it out: pinned gemini-2.5-flash 404s while
// every *-latest alias resolves. So the answer to an overloaded model is a
// SECOND ALIAS, never a pin.
//
// Why a fallback at all: observed live in production, gemini-flash-latest
// returned 503 "This model is currently experiencing high demand" on three
// retries and on three further probes minutes later, while
// gemini-flash-lite-latest answered 200 throughout. A sustained overload is
// not something a second of backoff rides out. Same fix, same reasoning as
// lib/capture/analyze.ts.
const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"] as const;

const SYSTEM_PROMPT = `You are the in-app support assistant for LEKHA, an accounting and statutory
compliance app for Indian businesses (GST, TDS, MSME, income tax, payroll,
fixed assets, year-end closing).

Help with two kinds of questions:
1. "How do I do X in LEKHA" — e.g. recording vouchers/invoices, running
   imports, reconciling a bank statement, generating GSTR-1/GSTR-3B/TDS
   reports, closing a year. Answer with concrete steps (which screen, which
   button) where you can reasonably infer them from how an accounting app is
   normally organised, but say so if you're inferring rather than certain.
2. General GST/TDS/accounting concept questions (e.g. "what is GSTR-1",
   "when is TDS return due", "what's the difference between debit and credit
   notes").

Rules:
- Be concise. Prefer short paragraphs or numbered steps over long essays.
- Plain text only — the chat window doesn't render Markdown. Never use
  **bold**, ### headings, backticks, or --- separators; those would show up
  as literal asterisks and hash marks. For steps, just write "1.", "2." on
  their own lines with a blank line between them.
- You cannot see this user's company data, ledgers, invoices or filings —
  never claim to check their account or give them a number from their books.
  If they ask about a figure in their own data, point them to the report or
  screen where they can look it up instead of guessing.
- For anything where getting it wrong has real consequences — specific
  rates, thresholds, due dates, or edge cases in GST/TDS/Income Tax law —
  say plainly that you may be out of date or oversimplifying, and recommend
  confirming with a Chartered Accountant or the relevant government portal
  (GST portal, Income Tax e-filing, TRACES) before relying on it. You are a
  guide, not a substitute for professional or legal advice.
- Don't ask the user to paste GSTINs, PANs, bank account numbers, passwords,
  or other identifying data into the chat, and don't repeat such numbers
  back if they do.
- If asked something unrelated to accounting/GST/TDS/using LEKHA, briefly
  say that's outside what you can help with here.`;

type ChatMessage = { role: "user" | "assistant"; content: string };

function isChatMessage(v: unknown): v is ChatMessage {
  if (!v || typeof v !== "object") return false;
  const { role, content } = v as Record<string, unknown>;
  return (role === "user" || role === "assistant") && typeof content === "string";
}

const MAX_TURNS = 20; // trailing messages sent as context, oldest dropped first
const MAX_MESSAGE_LENGTH = 4000;

// Gemini's free tier occasionally answers with "model is currently
// experiencing high demand" (503) or a rate-limit 429 — both transient,
// both gone a second later in practice. Retry those in place rather than
// surfacing an error the first time it happens.
const RETRYABLE_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [400, 1000];

async function fetchGeminiWithRetry(urls: readonly string[], body: string): Promise<Response> {
  let lastRetryable: Response | null = null;
  let lastError: unknown = null;

  // Each model gets the full backoff before the next is tried, so an ordinary
  // blip is ridden out on the preferred model rather than silently demoting
  // every conversation to the weaker one.
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
        const errText = await res.text().catch(() => "");
        console.warn(
          `[support-chat] Gemini ${res.status} on attempt ${attempt + 1}, retrying:`,
          errText.slice(0, 300)
        );
        lastRetryable = res;
        if (isLastAttempt) break;
      } catch (err) {
        console.warn(`[support-chat] fetch failed on attempt ${attempt + 1}, retrying:`, err);
        lastError = err;
        if (isLastAttempt) break;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }

  // Every model exhausted. Return the last real response so the caller logs
  // Google's own status and message rather than a generic failure.
  if (lastRetryable) return lastRetryable;
  throw lastError ?? new Error("fetchGeminiWithRetry: exhausted attempts without returning");
}

export async function POST(request: Request) {
  // Any signed-in user gets this — it's a stateless usage/compliance Q&A
  // assistant, not scoped to a company, so it sits ahead of company
  // selection (mounted in app/(app)/layout.tsx).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    // Durable record alongside the response the user already gets: from the
    // owner's side "the help chat says it isn't configured" and "a setting is
    // missing on the server" are the same fact, and only the second one is
    // actionable. Never awaited into the response path in a way that could
    // change it — logError resolves void whatever happens.
    await logError({
      operation: "support_chat",
      severity: "warning",
      message: "The help assistant is not switched on for this server yet.",
      detail: "GOOGLE_API_KEY is not set in the server environment, so no request was made to Gemini at all.",
      supabase,
      context: { route: "/api/support-chat", reason: "missing_env" },
    });
    return new Response(
      "Support chat isn't configured on this server yet (missing GOOGLE_API_KEY).",
      { status: 503 }
    );
  }

  let messages: ChatMessage[];
  try {
    const body = await request.json();
    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      throw new Error("empty");
    }
    if (!body.messages.every(isChatMessage)) throw new Error("bad shape");
    messages = body.messages.slice(-MAX_TURNS);
  } catch {
    return new Response("Invalid request body", { status: 400 });
  }

  const last = messages[messages.length - 1];
  if (last.role !== "user" || last.content.trim().length === 0) {
    return new Response("Last message must be a non-empty user message", { status: 400 });
  }
  if (last.content.length > MAX_MESSAGE_LENGTH) {
    return new Response("Message is too long", { status: 400 });
  }

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  let upstream: Response;
  try {
    upstream = await fetchGeminiWithRetry(
      MODELS.map(
        (m) =>
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:streamGenerateContent?alt=sse&key=${apiKey}`
      ),
      JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
      })
    );
  } catch (err) {
    console.error("[support-chat] failed to reach Gemini", err);
    await logError({
      operation: "support_chat",
      message: "The help assistant could not reach Google at all.",
      // `err` here routinely carries the request URL, and this app puts the
      // API key IN that URL's query string — logError redacts before it
      // stores anything. See lib/errors/redact.ts.
      detail: err,
      supabase,
      context: { route: "/api/support-chat", models: MODELS },
    });
    return new Response("The assistant is temporarily unavailable. Please try again.", {
      status: 502,
    });
  }

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    console.error("[support-chat] Gemini error", upstream.status, errText);
    // This is the shape of the incident that prompted this whole feature: a
    // 503 "This model is currently experiencing high demand" that the user
    // saw only as "temporarily unavailable". The status and Google's own
    // wording are what let the screen say "it was busy, try again" instead.
    await logError({
      operation: "support_chat",
      message: `The help assistant could not answer — Google replied ${upstream.status}.`,
      detail: errText.slice(0, 2000) || `HTTP ${upstream.status} with an empty body`,
      supabase,
      context: { route: "/api/support-chat", status: upstream.status, models: MODELS },
    });
    return new Response("The assistant is temporarily unavailable. Please try again.", {
      status: 502,
    });
  }

  // Gemini's stream is SSE frames of JSON candidates; re-emit just the text
  // deltas as a plain stream so the client can append chunks directly.
  const upstreamBody = upstream.body;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;
            try {
              const parsed = JSON.parse(jsonStr);
              const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (typeof text === "string" && text.length > 0) {
                controller.enqueue(encoder.encode(text));
              }
            } catch {
              // Malformed/partial SSE frame — skip rather than break the stream.
            }
          }
        }
      } catch (err) {
        console.error("[support-chat] stream read error", err);
        // Runs after the Response has already been handed to the client, so
        // it cannot and must not change what the user got — the answer they
        // were reading simply stops. The supabase client is passed explicitly
        // because cookies() is no longer reachable this far outside the
        // request scope.
        await logError({
          operation: "support_chat",
          severity: "warning",
          message: "The help assistant's answer was cut off part-way through.",
          detail: err,
          supabase,
          context: { route: "/api/support-chat", phase: "stream" },
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
