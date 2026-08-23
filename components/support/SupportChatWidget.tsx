"use client";

import { useEffect, useRef, useState } from "react";
import { MessageCircle, X, Send, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";

type ChatMessage = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "How do I record a purchase voucher?",
  "What is GSTR-1 and when is it due?",
  "How do I file a TDS return?",
];

const MAX_TURNS_SENT = 20;

/**
 * Global floating support chat. Mounted once in app/(app)/layout.tsx so it's
 * available on every authenticated page. Deliberately ephemeral — the
 * transcript lives only in this component's state and is gone on reload;
 * see components/support/SupportChatWidget.tsx's backend at
 * app/api/support-chat/route.ts for why (no DB table, no RLS surface).
 */
export function SupportChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  // Cancel any in-flight stream if the widget unmounts mid-answer.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  /** Sends `history` (already ending in the user turn to answer) and streams
   * the reply in. Shared by send() (appends a new user turn) and retry()
   * (resends the same trailing turn after a failure, so a retry doesn't
   * duplicate the user's message in the transcript). */
  async function runRequest(history: ChatMessage[]) {
    setError(null);
    setMessages([...history, { role: "assistant", content: "" }]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/support-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-MAX_TURNS_SENT) }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(text || "The assistant is temporarily unavailable.");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        setMessages((m) => {
          const copy = m.slice();
          const lastMsg = copy[copy.length - 1];
          copy[copy.length - 1] = { ...lastMsg, content: lastMsg.content + chunk };
          return copy;
        });
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(
          err instanceof Error && err.message
            ? err.message
            : "The assistant is temporarily unavailable. Please try again."
        );
        // Drop the empty placeholder bubble so a failed turn doesn't leave a blank reply.
        setMessages((m) => (m[m.length - 1]?.content === "" ? m.slice(0, -1) : m));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    setInput("");
    void runRequest([...messages, { role: "user", content: trimmed }]);
  }

  /** Re-issues the last turn after a failure. `messages` already ends in the
   * unanswered user turn — the failed placeholder was dropped on error — so
   * this resends as-is instead of appending a duplicate user bubble. */
  function retry() {
    if (streaming || messages[messages.length - 1]?.role !== "user") return;
    void runRequest(messages);
  }

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-6 z-50 flex h-[32rem] w-96 max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--shadow)] print:hidden">
          <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">LEKHA Assistant</p>
              <p className="text-[11px] leading-snug text-ink-faint">
                AI guidance on using the app and GST/TDS — not a substitute for a CA.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="shrink-0 rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
              aria-label="Close support chat"
            >
              <X size={16} />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-ink-soft">
                  Ask how to do something in LEKHA, or a general GST/TDS question.
                </p>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="rounded-lg border border-border-strong px-3 py-2 text-left text-xs text-ink-soft transition-colors hover:bg-accent-soft hover:text-accent"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                    m.role === "user" ? "bg-accent-soft text-ink" : "bg-surface-2 text-ink"
                  )}
                >
                  {m.content.length > 0 ? (
                    m.content
                  ) : streaming && i === messages.length - 1 ? (
                    <Loader2 size={14} className="animate-spin text-ink-faint" />
                  ) : null}
                </div>
              </div>
            ))}

            {error && (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-error-soft px-3 py-2 text-xs text-error">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={retry}
                  className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline"
                >
                  Retry
                </button>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className="flex items-end gap-2 border-t border-border p-3"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              placeholder="Ask a question…"
              className="max-h-24 flex-1 resize-none rounded-lg border border-border-strong bg-bg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={streaming || !input.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Send"
            >
              <Send size={15} />
            </button>
          </form>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 right-6 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[var(--shadow)] transition-opacity hover:opacity-90 print:hidden"
        aria-label={open ? "Close support chat" : "Open support chat"}
      >
        {open ? <X size={20} /> : <MessageCircle size={20} />}
      </button>
    </>
  );
}
