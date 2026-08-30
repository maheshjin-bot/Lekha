/**
 * Where a document waits when there is no signal.
 *
 * IndexedDB, not localStorage and not memory. The three reasons are all the
 * same reason — the tab is going to die:
 *
 *   1. A photographed page is a Blob of a few hundred KB. localStorage takes
 *      strings, caps out around 5 MB, and would need the bytes base64'd (a 33%
 *      tax) to hold them at all. IndexedDB stores a Blob natively.
 *   2. An object URL is a pointer into THIS page's memory. It dies when the tab
 *      does, so the queue has to hold the Blob itself; a queue full of
 *      `blob:` URLs after a reload is a queue full of broken images.
 *   3. A cheap Android in a godown gets its background tab killed by the OS
 *      constantly. Anything not on disk before the person locks their phone is
 *      a bill nobody will ever see again.
 *
 * This file is deliberately a dumb CRUD layer behind an interface. The retry
 * policy, the caps and the drain loop all live in offlineQueue.ts, and the
 * interface is what lets those be tested in Node without an IndexedDB at all.
 */

import type { ScanDocumentJob, ScanSendResume } from "./uploadQueue";

export const SCAN_QUEUE_DB = "lekha-scan-queue";
export const SCAN_QUEUE_STORE = "documents";
export const SCAN_QUEUE_DB_VERSION = 1;

/**
 * What one waiting document looks like on disk.
 *
 * The whole `ScanDocumentJob` is stored, blobs and all, rather than a
 * reference to something else — that is what "durable" means here. `dedupeKey`
 * is the primary key precisely because the server treats it as idempotent, so
 * the same physical document can never occupy two rows however many times a
 * flaky link makes us write it (verified against the live database: three
 * create_capture_draft calls with one key produce one draft).
 */
export type ScanQueueRecord = {
  dedupeKey: string;
  job: ScanDocumentJob;
  /** When the shutter closed on the last page, roughly. Drain order. */
  queuedAt: number;
  updatedAt: number;
  attempts: number;
  lastError: string | null;
  /**
   * "waiting"  — the link was bad; it will go on its own.
   * "blocked"  — the SERVER refused it. No amount of waiting fixes this and a
   *              person has to be told, which is the entire safety property of
   *              this feature.
   */
  state: "waiting" | "blocked";
  /** How far a previous attempt got, so a retry does not re-upload page 1..4. */
  resume: ScanSendResume | null;
  bytes: number;
};

export type ScanQueueWriteResult =
  | { ok: true }
  | { ok: false; reason: "quota" | "unavailable"; message: string };

export interface ScanQueueStore {
  /** Oldest first. */
  list(): Promise<ScanQueueRecord[]>;
  put(record: ScanQueueRecord): Promise<ScanQueueWriteResult>;
  remove(dedupeKey: string): Promise<void>;
  clear(): Promise<void>;
}

export function jobBytes(job: ScanDocumentJob): number {
  let total = 0;
  for (const page of job.pages) total += page.blob?.size ?? 0;
  return total;
}

/**
 * A quota error arrives in more than one shape depending on the browser: a
 * DOMException named QuotaExceededError on Chrome, legacy code 22, and on some
 * WebKit builds only a message. Treat all of them the same, because the answer
 * is identical — tell the person the phone is full instead of throwing under a
 * shutter button.
 */
export function isQuotaError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return true;
  }
  if ((error as { code?: unknown }).code === 22) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /quota|storage is full|exceeded the storage/i.test(message);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser has no offline storage."));
      return;
    }
    const open = indexedDB.open(SCAN_QUEUE_DB, SCAN_QUEUE_DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(SCAN_QUEUE_STORE)) {
        const store = db.createObjectStore(SCAN_QUEUE_STORE, {
          keyPath: "dedupeKey",
        });
        store.createIndex("queuedAt", "queuedAt", { unique: false });
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      // Another tab upgrading the schema must not be left blocked forever
      // waiting on this one's open handle.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    open.onerror = () =>
      reject(open.error ?? new Error("Could not open offline storage."));
    // Private-mode Safari and a locked-down WebView can leave `open` hanging
    // rather than firing either handler; without this the first enqueue would
    // await forever and the shutter would appear to have eaten the document.
    open.onblocked = () => reject(new Error("Offline storage is busy."));
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode
): { store: IDBObjectStore; done: Promise<void> } {
  const transaction = db.transaction(SCAN_QUEUE_STORE, mode);
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    // The write that blows the quota usually fails on the TRANSACTION, not on
    // the request, so this rejection is the one that actually carries the
    // QuotaExceededError. Missing it is how a full phone looks like a hang.
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Offline storage write was aborted."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Offline storage write failed."));
  });
  return { store: transaction.objectStore(SCAN_QUEUE_STORE), done };
}

export function createIndexedDbQueueStore(): ScanQueueStore {
  return {
    async list() {
      try {
        const db = await openDb();
        const { store, done } = tx(db, "readonly");
        const rows = await request<ScanQueueRecord[]>(
          store.getAll() as IDBRequest<ScanQueueRecord[]>
        );
        await done;
        return rows
          .filter((row) => row && typeof row.dedupeKey === "string")
          .sort((a, b) => a.queuedAt - b.queuedAt);
      } catch {
        // A queue that cannot be read is an empty queue as far as the screen is
        // concerned. It must not be a crash on first paint.
        return [];
      }
    },

    async put(record) {
      try {
        const db = await openDb();
        const { store, done } = tx(db, "readwrite");
        store.put(record);
        await done;
        return { ok: true };
      } catch (error) {
        if (isQuotaError(error)) {
          return {
            ok: false,
            reason: "quota",
            message:
              "This phone has no room left. Send what is waiting, then photograph this again.",
          };
        }
        return {
          ok: false,
          reason: "unavailable",
          message:
            "This phone cannot hold documents offline. Stay in signal until it sends.",
        };
      }
    },

    async remove(dedupeKey) {
      try {
        const db = await openDb();
        const { store, done } = tx(db, "readwrite");
        store.delete(dedupeKey);
        await done;
      } catch {
        // A delete that fails leaves a record that will be re-sent, and the
        // server's own idempotency makes that harmless — see 0870.
      }
    },

    async clear() {
      try {
        const db = await openDb();
        const { store, done } = tx(db, "readwrite");
        store.clear();
        await done;
      } catch {
        /* same as above */
      }
    },
  };
}

/**
 * An in-memory stand-in with the same contract. Used by the unit tests (Node
 * has no IndexedDB) and as the fallback when `indexedDB` is missing entirely —
 * a private window still gets a working queue for as long as the tab lives,
 * which is strictly better than a shutter button that throws.
 */
export function createMemoryQueueStore(
  seed: ScanQueueRecord[] = []
): ScanQueueStore & { failNextPut?: ScanQueueWriteResult } {
  const rows = new Map<string, ScanQueueRecord>();
  for (const record of seed) rows.set(record.dedupeKey, record);
  const self: ScanQueueStore & { failNextPut?: ScanQueueWriteResult } = {
    async list() {
      return [...rows.values()].sort((a, b) => a.queuedAt - b.queuedAt);
    },
    async put(record) {
      if (self.failNextPut) {
        const failure = self.failNextPut;
        self.failNextPut = undefined;
        return failure;
      }
      rows.set(record.dedupeKey, record);
      return { ok: true };
    },
    async remove(dedupeKey) {
      rows.delete(dedupeKey);
    },
    async clear() {
      rows.clear();
    },
  };
  return self;
}

export function supportsIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}
