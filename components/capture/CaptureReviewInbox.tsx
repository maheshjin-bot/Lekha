"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import type { CaptureExtraction } from "@/lib/capture/analyze";
import type { VoucherNumberingByBranch } from "@/lib/numbering/voucher-numbering";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { CaptureDocumentViewer } from "@/components/capture/CaptureDocumentViewer";
import { CaptureReviewForm } from "@/components/capture/CaptureReviewForm";
import { RejectDraftDialog } from "@/components/capture/RejectDraftDialog";
import {
  DOC_TYPES,
  DRAFT_STATUSES,
  STATUS_LABELS,
  asExtraction,
  docConfig,
  formatWhen,
  queueRowTitle,
  type Item,
  type Ledger,
  type QueueRow,
} from "@/components/capture/reviewModel";

/**
 * The back-office review inbox: everything the counter photographed, and the
 * one desk that turns it into books.
 *
 * This screen used to be both halves at once — a file picker at the top and a
 * review form below, uploader and reviewer in the same scroll. Capture has
 * moved to the phone surface at /scan, so what is left here is a QUEUE: pick
 * a document, look at the photograph beside the fields read off it, correct
 * them, and either post it or send it back with a reason.
 *
 * OCR NOW RUNS AT REVIEW TIME. A document that has just arrived has no
 * extracted_json at all — POST /api/capture/extract is fired when the
 * reviewer opens it. That takes seconds and, on this project's Gemini free
 * tier, genuinely fails sometimes (observed 503s across every retry). So the
 * three states are all real states with real UI: reading, read, and couldn't
 * read — and the last one offers both a Retry (the support widget's own
 * pattern) and a way straight into the form to type it in by hand, because a
 * model outage must never be the reason a bill cannot be entered.
 */

type Branch = { id: string; code: string; name: string; registeredState: string | null };
type Godown = { id: string; code: string; name: string };
type StateOption = { code: string; name: string };

export type CapturerOption = { id: string; label: string };

export type QueueFilters = {
  status: string;
  documentType: string;
  branchId: string;
  capturedBy: string;
  from: string;
  to: string;
};

type ExtractionState =
  | { phase: "loading" }
  | { phase: "ready"; extraction: CaptureExtraction | null }
  | { phase: "error"; message: string };

const selectClass =
  "rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

export function CaptureReviewInbox({
  companyId,
  rows,
  filters,
  capturers,
  branches,
  queueError,
  limit,
  items,
  ledgers,
  godowns,
  gstOn,
  states,
  numbering,
}: {
  companyId: string;
  rows: QueueRow[];
  filters: QueueFilters;
  capturers: CapturerOption[];
  branches: Branch[];
  /** Set when get_capture_review_queue itself failed — never swallowed. */
  queueError: string | null;
  limit: number;
  items: Item[];
  ledgers: Ledger[];
  godowns: Godown[];
  gstOn: boolean;
  states: StateOption[];
  numbering: VoucherNumberingByBranch;
}) {
  const router = useRouter();
  const pathname = usePathname();

  /**
   * Local corrections layered over the server's rows rather than a copy of
   * them: posting, rejecting or retyping a document type changes one row, and
   * a filter change re-renders the whole list from the server. Overlaying
   * avoids the classic "state initialised from props and then out of date"
   * bug that a useState copy would have here.
   */
  const [overrides, setOverrides] = useState<Record<string, Partial<QueueRow>>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [extractions, setExtractions] = useState<Record<string, ExtractionState>>({});
  const [rejectOpen, setRejectOpen] = useState(false);

  /**
   * Drafts this session has already asked about, so opening one twice — or a
   * re-render while its request is still in flight — cannot spend two vision
   * calls on the same photograph. A ref rather than state precisely because
   * writing it must not cause a render: the effect below reads it, and state
   * set synchronously inside an effect is what the React Compiler's
   * set-state-in-effect rule exists to stop.
   */
  const askedRef = useRef<Set<string>>(new Set());

  const merged = useMemo(
    () => rows.map((r) => (overrides[r.id] ? { ...r, ...overrides[r.id] } : r)),
    [rows, overrides]
  );

  // The date range is applied in SQL now (0871), before p_limit rather than
  // after it — so what arrives here is already the honest answer for the
  // range and there is nothing further to filter out.
  const visible = merged;

  const selected =
    visible.find((r) => r.id === selectedId) ?? visible[0] ?? null;

  // `undefined` is not a missing state — it IS the loading state, for a
  // pending draft the effect below is about to ask about. Deriving it rather
  // than storing it is what lets that effect avoid a synchronous setState.
  const extractionState: ExtractionState | undefined = selected
    ? (extractions[selected.id] ??
      (selected.extraction ? { phase: "ready", extraction: selected.extraction } : undefined))
    : undefined;

  /**
   * Reads a draft whose extraction is ALREADY stored, instead of paying for
   * the model again. get_capture_review_queue returns has_extraction, not the
   * jsonb itself (it is large and most rows in a queue are never opened), so
   * the stored value is fetched one draft at a time, when one is opened.
   *
   * Returns false when there turns out to be nothing usable stored after all,
   * which is the caller's signal to fall through to the model.
   */
  const loadStoredExtraction = useCallback(async (draftId: string): Promise<boolean> => {
    const { data, error } = await createClient()
      .from("capture_drafts")
      .select("extracted_json")
      .eq("id", draftId)
      .maybeSingle();
    if (error || !data) return false;
    const extraction = asExtraction(data.extracted_json);
    if (!extraction) return false;
    setExtractions((prev) => ({ ...prev, [draftId]: { phase: "ready", extraction } }));
    return true;
  }, []);

  /**
   * Asks the server to read page 1. Deliberately does NOT set the loading
   * state itself: a selected draft with no entry in `extractions` already
   * RENDERS as loading (see extractionState below), so the automatic first
   * read needs no synchronous write at all. Retry, which is an event handler
   * and free to set state, sets it explicitly on the way in.
   */
  const runExtraction = useCallback(async (draftId: string) => {
    let res: Response;
    try {
      res = await fetch("/api/capture/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId }),
      });
    } catch {
      setExtractions((prev) => ({
        ...prev,
        [draftId]: { phase: "error", message: "Could not reach the server to read this document." },
      }));
      return;
    }

    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const message =
        (json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string"
          ? (json as { error: string }).error
          : null) ?? `The document could not be read right now (${res.status}).`;
      setExtractions((prev) => ({ ...prev, [draftId]: { phase: "error", message } }));
      return;
    }

    // The route's own envelope is { extracted }, but an extraction returned
    // bare is just as usable — asExtraction is what decides either way, and
    // anything it rejects becomes "nothing was read", which the form already
    // handles as a blank bill to type in.
    const payload = json as
      | { extracted?: unknown; extraction?: unknown; saved?: boolean; error?: string }
      | null;
    const extraction =
      asExtraction(payload?.extracted) ?? asExtraction(payload?.extraction) ?? asExtraction(json);

    // The route answers 200 with saved:false when the reading itself worked
    // but storing it did not. That is worth saying out loud rather than
    // swallowing: the fields below are usable, but leaving this document and
    // coming back will read it again.
    if (payload?.saved === false) {
      toast.message(
        `Read, but not saved against the document${payload.error ? `: ${payload.error}` : "."}`
      );
    }

    setExtractions((prev) => ({ ...prev, [draftId]: { phase: "ready", extraction } }));
  }, []);

  // Opening a waiting document is what triggers the model. Confirmed and
  // rejected drafts are never re-read: there is nothing left to decide, and
  // an outage on a closed row would be pure noise.
  useEffect(() => {
    if (!selected) return;
    // A confirmed or rejected draft is never re-read: there is nothing left to
    // decide, and a model outage on a closed row would be pure noise.
    if (selected.status !== "pending_review") return;

    const draftId = selected.id;
    if (askedRef.current.has(draftId)) return;
    askedRef.current.add(draftId);

    void (async () => {
      // An extraction already stored costs a table read; the model costs a
      // call and several seconds. Prefer the stored one, and fall through
      // only when it turns out not to be usable after all.
      if (selected.hasExtraction && (await loadStoredExtraction(draftId))) return;
      await runExtraction(draftId);
    })();
  }, [selected, runExtraction, loadStoredExtraction]);

  function setFilter(patch: Partial<QueueFilters>) {
    const next = { ...filters, ...patch };
    const sp = new URLSearchParams();
    if (next.status) sp.set("status", next.status);
    if (next.documentType) sp.set("type", next.documentType);
    if (next.branchId) sp.set("branch", next.branchId);
    if (next.capturedBy) sp.set("by", next.capturedBy);
    if (next.from) sp.set("from", next.from);
    if (next.to) sp.set("to", next.to);
    const qs = sp.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function nextWaitingAfter(draftId: string): QueueRow | null {
    const at = visible.findIndex((r) => r.id === draftId);
    for (let i = at + 1; i < visible.length; i++) {
      if (visible[i].status === "pending_review") return visible[i];
    }
    return visible.find((r) => r.id !== draftId && r.status === "pending_review") ?? null;
  }

  const anyFilter =
    filters.status || filters.documentType || filters.branchId || filters.capturedBy ||
    filters.from || filters.to;

  return (
    <div className="mt-6 flex flex-col gap-4">
      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface px-4 py-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-faint">Status</span>
          <select
            value={filters.status}
            onChange={(e) => setFilter({ status: e.target.value })}
            className={selectClass}
          >
            <option value="">All</option>
            {DRAFT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-faint">Document</span>
          <select
            value={filters.documentType}
            onChange={(e) => setFilter({ documentType: e.target.value })}
            className={selectClass}
          >
            <option value="">All</option>
            {DOC_TYPES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-faint">Branch</span>
          <select
            value={filters.branchId}
            onChange={(e) => setFilter({ branchId: e.target.value })}
            className={selectClass}
          >
            <option value="">All</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} — {b.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-faint">Sent by</span>
          <select
            value={filters.capturedBy}
            onChange={(e) => setFilter({ capturedBy: e.target.value })}
            className={selectClass}
          >
            <option value="">Anyone</option>
            {capturers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-faint">Arrived from</span>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilter({ from: e.target.value })}
            className={selectClass}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-faint">to</span>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilter({ to: e.target.value })}
            className={selectClass}
          />
        </label>

        {anyFilter && (
          <button
            type="button"
            onClick={() =>
              setFilter({ status: "", documentType: "", branchId: "", capturedBy: "", from: "", to: "" })
            }
            className="rounded-lg border border-border-strong px-2.5 py-1.5 text-sm text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            Clear
          </button>
        )}

        <span className="ml-auto text-xs text-ink-faint">
          {visible.length} of up to {limit} shown
        </span>
      </section>

      {queueError && (
        <div className="rounded-lg bg-error-soft px-4 py-3 text-sm text-error">
          <p className="font-medium">The review queue could not be read.</p>
          <p className="mt-1">
            This screen reads public.get_capture_review_queue, and the database refused it:{" "}
            {queueError}
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
        <section className="flex flex-col gap-2">
          {visible.length === 0 ? (
            <EmptyState className="text-left">
              {/* An empty list because the queue could not be READ is not an
                  empty inbox, and must not be described as one — the banner
                  above already says what actually happened. */}
              <span className="block font-medium text-ink-soft">
                {queueError
                  ? "The queue could not be listed."
                  : anyFilter
                    ? "Nothing matches these filters."
                    : "Nothing is waiting."}
              </span>
              {!queueError && (
                <span className="mt-2 block">
                  Documents arrive here when someone at the counter photographs one on their phone
                  at{" "}
                  <Link href="/scan" className="text-accent underline underline-offset-4">
                    /scan
                  </Link>
                  , or forwards it to this company&rsquo;s WhatsApp number. Nothing is read or
                  posted until you open it here.
                </span>
              )}
            </EmptyState>
          ) : (
            visible.map((row) => {
              const when = formatWhen(row.arrivedAt);
              const config = docConfig(row.documentType);
              const isSelected = selected?.id === row.id;
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  className={
                    "flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors " +
                    (isSelected
                      ? "border-accent bg-accent-soft/40"
                      : "border-border-strong hover:bg-surface-2")
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                      {queueRowTitle(row)}
                    </span>
                    <Badge
                      tone={
                        row.status === "confirmed"
                          ? "ok"
                          : row.status === "rejected"
                            ? "bad"
                            : "warn"
                      }
                    >
                      {STATUS_LABELS[row.status]}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
                    <span>{config.shortLabel}</span>
                    <span aria-hidden>·</span>
                    <span>{row.capturedByLabel ?? "Unknown sender"}</span>
                    <span aria-hidden>·</span>
                    <span>
                      {when.date} {when.time}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">
                      {row.pageCount} {row.pageCount === 1 ? "page" : "pages"}
                    </span>
                  </div>
                  {row.isDuplicate && (
                    <span className="inline-flex items-center gap-1 text-xs text-warning">
                      <Copy size={12} />
                      Same photograph as another document
                    </span>
                  )}
                </button>
              );
            })
          )}
        </section>

        <section className="min-w-0">
          {!selected ? (
            <EmptyState>Pick a document on the left to review it.</EmptyState>
          ) : (
            <div className="rounded-lg border border-border bg-surface p-4">
              <DetailHeader
                row={selected}
                onReject={() => setRejectOpen(true)}
                companyId={companyId}
              />

              <div className="mt-4 grid gap-5 xl:grid-cols-[minmax(320px,440px)_minmax(0,1fr)]">
                <div className="xl:sticky xl:top-4 xl:self-start">
                  <CaptureDocumentViewer
                    key={selected.id}
                    draftId={selected.id}
                    fallbackPath={selected.storagePath}
                  />
                </div>

                <div className="min-w-0">
                  {selected.status === "confirmed" ? (
                    <div className="rounded-lg bg-success-soft px-3 py-3 text-sm text-ink">
                      <p className="font-medium">Already posted.</p>
                      <p className="mt-1">
                        {selected.confirmedVoucherId ? (
                          <Link
                            href={`/${companyId}/vouchers/${selected.confirmedVoucherId}`}
                            className="text-accent underline underline-offset-4"
                          >
                            Open the voucher
                          </Link>
                        ) : (
                          "The voucher it was posted to is no longer recorded on this draft."
                        )}
                      </p>
                      <NextWaitingButton
                        next={nextWaitingAfter(selected.id)}
                        onGo={(id) => setSelectedId(id)}
                      />
                    </div>
                  ) : selected.status === "rejected" ? (
                    <div className="rounded-lg bg-surface-2 px-3 py-3 text-sm text-ink-soft">
                      <p className="font-medium text-ink">Sent back.</p>
                      <p className="mt-1">
                        {selected.rejectedReason
                          ? `Reason given: "${selected.rejectedReason}"`
                          : "No reason was recorded — this draft predates the reason field."}
                      </p>
                      <NextWaitingButton
                        next={nextWaitingAfter(selected.id)}
                        onGo={(id) => setSelectedId(id)}
                      />
                    </div>
                  ) : extractionState?.phase === "loading" || extractionState === undefined ? (
                    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-10 text-sm text-ink-faint">
                      <Loader2 size={16} className="animate-spin" />
                      Reading this document… this takes a few seconds.
                    </div>
                  ) : extractionState.phase === "error" ? (
                    <div className="rounded-lg bg-error-soft px-3 py-3 text-sm text-error">
                      <p className="font-medium">This document could not be read.</p>
                      <p className="mt-1">{extractionState.message}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          // Always a genuine re-read, never the stored
                          // answer: Retry exists because the stored answer is
                          // the problem.
                          onClick={() => {
                            setExtractions((prev) => ({
                              ...prev,
                              [selected.id]: { phase: "loading" },
                            }));
                            void runExtraction(selected.id);
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
                        >
                          <RefreshCw size={14} />
                          Retry
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setExtractions((prev) => ({
                              ...prev,
                              [selected.id]: { phase: "ready", extraction: null },
                            }))
                          }
                          className="rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
                        >
                          Enter it by hand instead
                        </button>
                      </div>
                    </div>
                  ) : (
                    <CaptureReviewForm
                      // Remounting on either is the whole reset story: a new
                      // document, or a corrected document type, means every
                      // field must be re-seeded rather than patched.
                      key={selected.id}
                      companyId={companyId}
                      draft={selected}
                      extraction={extractionState.extraction}
                      items={items}
                      ledgers={ledgers}
                      branches={branches}
                      godowns={godowns}
                      gstOn={gstOn}
                      states={states}
                      numbering={numbering}
                      onDocumentTypeChanged={(value) =>
                        setOverrides((prev) => ({
                          ...prev,
                          [selected.id]: { ...prev[selected.id], documentType: value },
                        }))
                      }
                      onPosted={(voucherId) => {
                        setOverrides((prev) => ({
                          ...prev,
                          [selected.id]: {
                            ...prev[selected.id],
                            status: "confirmed",
                            confirmedVoucherId: voucherId,
                          },
                        }));
                        toast.success("Posted — the document is out of the queue.");
                      }}
                    />
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      {selected && (
        <RejectDraftDialog
          // Keyed by draft: a reason typed against one document must never
          // survive into the next one.
          key={selected.id}
          open={rejectOpen}
          onClose={() => setRejectOpen(false)}
          draftId={selected.id}
          documentLabel={queueRowTitle(selected)}
          onRejected={(reason) => {
            setOverrides((prev) => ({
              ...prev,
              [selected.id]: { ...prev[selected.id], status: "rejected", rejectedReason: reason },
            }));
          }}
        />
      )}
    </div>
  );
}

function NextWaitingButton({
  next,
  onGo,
}: {
  next: QueueRow | null;
  onGo: (id: string) => void;
}) {
  if (!next) return null;
  return (
    <button
      type="button"
      onClick={() => onGo(next.id)}
      className="mt-3 rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
    >
      Review the next document →
    </button>
  );
}

function DetailHeader({
  row,
  onReject,
  companyId,
}: {
  row: QueueRow;
  onReject: () => void;
  companyId: string;
}) {
  const when = formatWhen(row.arrivedAt);
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold text-ink">{queueRowTitle(row)}</h2>
          <p className="mt-0.5 text-sm text-ink-soft">
            {row.capturedByLabel ?? "Unknown sender"} · {when.date} {when.time} ·{" "}
            {row.source === "whatsapp" ? "WhatsApp" : "Phone camera"} · {row.pageCount}{" "}
            {row.pageCount === 1 ? "page" : "pages"}
            {row.branchLabel ? ` · ${row.branchLabel}` : ""}
          </p>
        </div>
        {row.status === "pending_review" && (
          <button
            type="button"
            onClick={onReject}
            className="shrink-0 rounded-lg border border-border-strong px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            Send back…
          </button>
        )}
      </div>

      {row.note && (
        <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-ink-soft">
          <span className="font-medium text-ink">They wrote:</span> {row.note}
        </p>
      )}

      {row.isDuplicate && (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          Another document in this company has the same first page, byte for byte. Check the{" "}
          <Link
            href={`/${companyId}/capture`}
            className="underline underline-offset-4"
          >
            queue
          </Link>{" "}
          before posting — a bill entered twice is a real ledger error, not a cosmetic one.
        </p>
      )}
    </header>
  );
}
