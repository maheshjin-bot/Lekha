/**
 * The offline capture queue: what happens to a document when there is no signal.
 *
 * WHY NOT THE BACKGROUND SYNC API. It is the obvious answer and it is the wrong
 * one. `SyncManager` does not exist in Safari on iOS — not in a tab, not in an
 * installed home-screen app — and there is no sign of it arriving. Building on
 * it would produce a feature that works on the Android handsets and silently
 * does nothing on the iPhones, and "silently does nothing" is the exact failure
 * this whole phase exists to prevent. Worse, it would licence us to write "we
 * will send it in the background" on the screen, which would be a lie on half
 * the devices. So the queue drains only while the scanner is OPEN, on three
 * triggers, and the screen says exactly that to everybody:
 *
 *   - `online`            — the browser noticed the link come back
 *   - `visibilitychange`  — the person came back to the scanner
 *   - app start           — the scanner was opened, possibly hours later
 *
 * plus a modest backoff timer, because `navigator.onLine` is a liar: it reports
 * true for a handset associated with a godown wifi access point that has no
 * upstream at all, and in that state no `online` event will ever fire. The
 * timer is not background sync — it only runs while the page is alive.
 *
 * THE SAFETY PROPERTY, above everything else in this file: a person must never
 * be left believing a document was sent when it was not. That is why a
 * permanent failure (413 too large, 401 signed out, 403 wrong company) is
 * pulled out of the retry loop and parked in a `blocked` state that the UI is
 * obliged to shout about, instead of being retried forever behind a spinner.
 */

import {
  sendScanDocument,
  type ScanDocumentJob,
  type ScanSendResume,
  type ScanTransport,
} from "./uploadQueue";
import {
  jobBytes,
  type ScanQueueRecord,
  type ScanQueueStore,
  type ScanQueueWriteResult,
} from "./queueStore";
import type { ScanDocumentType } from "./types";

/**
 * Caps, so a week of no signal cannot fill a handset's disk and take the rest
 * of the phone down with it. Both are generous for the real workload — a
 * counter does maybe thirty documents a day and a downscaled page is ~300 KB.
 */
export const MAX_QUEUED_DOCUMENTS = 40;
export const MAX_QUEUED_BYTES = 80 * 1024 * 1024;

/** 15s, 30s, 1m, 2m, 4m, then flat. Nothing here hammers a dead link. */
const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 240_000];

export type ScanQueueEntryState = "waiting" | "sending" | "blocked";

/**
 * What the screen is allowed to know about a waiting document. Note what is
 * absent: the blobs. The UI never needs them and holding them in React state
 * would put every queued photo back in memory, which is what IndexedDB is here
 * to avoid.
 */
export type ScanQueueEntry = {
  dedupeKey: string;
  documentType: ScanDocumentType;
  vendorHint: string | null;
  pageCount: number;
  bytes: number;
  queuedAt: number;
  attempts: number;
  lastError: string | null;
  state: ScanQueueEntryState;
};

export type ScanQueueSnapshot = {
  /** False until the store has been read once. Stops a "0 waiting" flash. */
  ready: boolean;
  entries: ScanQueueEntry[];
  /** Documents that will send by themselves. */
  waiting: number;
  /** Documents the server refused. A person has to do something about these. */
  blocked: number;
  draining: boolean;
  online: boolean;
  /** Set when the last enqueue was refused (phone full, no storage). */
  storageProblem: string | null;
  lastDrainAt: number | null;
  /**
   * Which of the three triggers last ran the loop — "online",
   * "visible", "start", "manual", "backoff", "enqueue", "unblock". Never shown
   * to the shop floor; it is what makes "did the queue actually wake up?"
   * answerable from a console on a handset that is behaving oddly.
   */
  lastDrainTrigger: string | null;
};

export const EMPTY_QUEUE_SNAPSHOT: ScanQueueSnapshot = {
  ready: false,
  entries: [],
  waiting: 0,
  blocked: 0,
  draining: false,
  online: true,
  storageProblem: null,
  lastDrainAt: null,
  lastDrainTrigger: null,
};

export type ScanQueueController = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ScanQueueSnapshot;
  getServerSnapshot(): ScanQueueSnapshot;
  /** Attach the listeners and do the first drain. Returns the detach. */
  start(): () => void;
  enqueue(
    job: ScanDocumentJob,
    resume?: ScanSendResume | null,
    lastError?: string | null
  ): Promise<ScanQueueWriteResult>;
  drain(trigger: string): Promise<void>;
  /** Drop one document from the phone. The paper has to be photographed again. */
  discard(dedupeKey: string): Promise<void>;
  /** Move a blocked document back into the retry loop, e.g. after signing in. */
  unblock(dedupeKey: string): Promise<void>;
  refresh(): Promise<void>;
};

function toEntry(record: ScanQueueRecord, sendingKey: string | null): ScanQueueEntry {
  return {
    dedupeKey: record.dedupeKey,
    documentType: record.job.documentType,
    vendorHint: record.job.vendorHint,
    pageCount: record.job.pages.length,
    bytes: record.bytes,
    queuedAt: record.queuedAt,
    attempts: record.attempts,
    lastError: record.lastError,
    state:
      record.state === "blocked"
        ? "blocked"
        : record.dedupeKey === sendingKey
          ? "sending"
          : "waiting",
  };
}

export function createScanQueue(options: {
  store: ScanQueueStore;
  /** Lazy, because building a Supabase client on the server would explode. */
  transport: ScanTransport | (() => ScanTransport);
  isOnline?: () => boolean;
  now?: () => number;
  /** Injected in tests so a backoff does not make the suite take four minutes. */
  schedule?: (fn: () => void, ms: number) => () => void;
}): ScanQueueController {
  const { store } = options;
  const now = options.now ?? (() => Date.now());
  const isOnline =
    options.isOnline ??
    (() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  const schedule =
    options.schedule ??
    ((fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    });

  let resolvedTransport: ScanTransport | null =
    typeof options.transport === "function" ? null : options.transport;
  const getTransport = (): ScanTransport => {
    if (!resolvedTransport) {
      resolvedTransport = (options.transport as () => ScanTransport)();
    }
    return resolvedTransport;
  };

  const listeners = new Set<() => void>();
  let records: ScanQueueRecord[] = [];
  let sendingKey: string | null = null;
  let draining = false;
  /**
   * The drain in flight, if there is one. `drain()` hands this back rather than
   * returning immediately, so a second trigger arriving mid-drain (an `online`
   * event landing while a `visibilitychange` drain is halfway through a
   * six-page bill) WAITS for the real thing instead of resolving to a promise
   * that means nothing.
   */
  let inFlight: Promise<void> | null = null;
  let ready = false;
  let storageProblem: string | null = null;
  let lastDrainAt: number | null = null;
  let lastDrainTrigger: string | null = null;
  let consecutiveFailures = 0;
  let cancelBackoff: (() => void) | null = null;

  // Cached so useSyncExternalStore gets a referentially stable value; rebuilding
  // it on every getSnapshot() is the classic infinite-render trap.
  let snapshot: ScanQueueSnapshot = EMPTY_QUEUE_SNAPSHOT;

  function publish(): void {
    const entries = records.map((record) => toEntry(record, sendingKey));
    snapshot = {
      ready,
      entries,
      waiting: entries.filter((e) => e.state !== "blocked").length,
      blocked: entries.filter((e) => e.state === "blocked").length,
      draining,
      online: isOnline(),
      storageProblem,
      lastDrainAt,
      lastDrainTrigger,
    };
    for (const listener of listeners) listener();
  }

  async function refresh(): Promise<void> {
    records = await store.list();
    ready = true;
    publish();
  }

  function clearBackoff(): void {
    if (cancelBackoff) {
      cancelBackoff();
      cancelBackoff = null;
    }
  }

  function armBackoff(): void {
    clearBackoff();
    if (records.every((r) => r.state === "blocked")) return;
    const delay = BACKOFF_MS[Math.min(consecutiveFailures, BACKOFF_MS.length - 1)];
    cancelBackoff = schedule(() => {
      cancelBackoff = null;
      void drain("backoff");
    }, delay);
  }

  async function enqueue(
    job: ScanDocumentJob,
    resume: ScanSendResume | null = null,
    lastError: string | null = null
  ): Promise<ScanQueueWriteResult> {
    const existing = records.find((r) => r.dedupeKey === job.dedupeKey);
    const bytes = jobBytes(job);

    if (!existing) {
      // The caps apply to NEW documents only — an update to something already
      // queued must never be refused, or a retry would lose its resume point.
      const totalBytes = records.reduce((sum, r) => sum + r.bytes, 0);
      if (records.length >= MAX_QUEUED_DOCUMENTS) {
        storageProblem = `This phone is already holding ${records.length} documents that have not gone. Get to signal and send them before photographing more.`;
        publish();
        return { ok: false, reason: "quota", message: storageProblem };
      }
      if (totalBytes + bytes > MAX_QUEUED_BYTES) {
        storageProblem =
          "This phone is holding as many photos as it can. Get to signal and send them before photographing more.";
        publish();
        return { ok: false, reason: "quota", message: storageProblem };
      }
    }

    const record: ScanQueueRecord = {
      dedupeKey: job.dedupeKey,
      job,
      queuedAt: existing?.queuedAt ?? now(),
      updatedAt: now(),
      attempts: existing?.attempts ?? 0,
      lastError,
      state: "waiting",
      resume: resume ?? existing?.resume ?? null,
      bytes,
    };

    const result = await store.put(record);
    if (!result.ok) {
      storageProblem = result.message;
      publish();
      return result;
    }
    storageProblem = null;
    await refresh();
    // A document queued while the link is actually fine (a one-off 502, say)
    // should not sit there until the person backgrounds the app.
    if (isOnline()) void drain("enqueue");
    else armBackoff();
    return result;
  }

  function drain(trigger: string): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = runDrain(trigger).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function runDrain(trigger: string): Promise<void> {
    lastDrainTrigger = trigger;
    clearBackoff();
    if (!ready) await refresh();
    if (!isOnline()) {
      publish();
      return;
    }

    const pending = records
      .filter((r) => r.state !== "blocked")
      .sort((a, b) => a.queuedAt - b.queuedAt);
    if (pending.length === 0) {
      publish();
      return;
    }

    draining = true;
    publish();

    try {
      for (const record of pending) {
        // One document at a time, and one page at a time inside it. Parallel
        // uploads over a two-bar link share the same tiny uplink, time out
        // together, and produce a confusing half-sent mess — the same reason
        // sendScanDocument is sequential.
        sendingKey = record.dedupeKey;
        publish();

        const result = await sendScanDocument(record.job, {
          transport: getTransport(),
          resume: record.resume,
        });

        if (result.ok) {
          await store.remove(record.dedupeKey);
          consecutiveFailures = 0;
          continue;
        }

        const updated: ScanQueueRecord = {
          ...record,
          attempts: record.attempts + 1,
          updatedAt: now(),
          lastError: result.message,
          resume: result.resume ?? record.resume,
          state: result.kind === "permanent" ? "blocked" : "waiting",
        };
        await store.put(updated);

        if (result.kind === "permanent") {
          // This one is a person's problem now. The rest of the queue may still
          // be perfectly sendable, so keep going.
          continue;
        }

        // Retryable means the LINK is bad. Pushing thirty more documents at it
        // would achieve nothing but burn the battery.
        consecutiveFailures += 1;
        break;
      }
    } finally {
      sendingKey = null;
      draining = false;
      lastDrainAt = now();
      await refresh();
      if (records.some((r) => r.state !== "blocked")) armBackoff();
      else clearBackoff();
    }
  }

  async function discard(dedupeKey: string): Promise<void> {
    await store.remove(dedupeKey);
    storageProblem = null;
    await refresh();
  }

  async function unblock(dedupeKey: string): Promise<void> {
    const record = records.find((r) => r.dedupeKey === dedupeKey);
    if (!record) return;
    await store.put({ ...record, state: "waiting", updatedAt: now() });
    consecutiveFailures = 0;
    await refresh();
    // Awaited, unlike enqueue's drain. This one came from a person tapping
    // "Try it again" on a document they were just told had been refused; the
    // outcome of that tap is the whole reason they tapped it.
    await drain("unblock");
  }

  function start(): () => void {
    const onOnline = () => {
      consecutiveFailures = 0;
      void drain("online");
    };
    const onOffline = () => {
      clearBackoff();
      publish();
    };
    const onVisible = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      consecutiveFailures = 0;
      void drain("visible");
    };

    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
      window.addEventListener("offline", onOffline);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }

    void drain("start");

    return () => {
      clearBackoff();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY_QUEUE_SNAPSHOT,
    start,
    enqueue,
    drain,
    discard,
    unblock,
    refresh,
  };
}
