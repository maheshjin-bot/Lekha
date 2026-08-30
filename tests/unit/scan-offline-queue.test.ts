import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScanQueue,
  MAX_QUEUED_DOCUMENTS,
  type ScanQueueController,
} from "@/lib/scan/offlineQueue";
import {
  createMemoryQueueStore,
  isQuotaError,
  jobBytes,
  type ScanQueueStore,
} from "@/lib/scan/queueStore";
import {
  ScanTransportError,
  classifyHttpStatus,
  classifyRpcError,
  classifySendError,
  type ScanDocumentJob,
  type ScanTransport,
  type ScanUploadedPage,
} from "@/lib/scan/uploadQueue";

/**
 * The offline queue.
 *
 * The property under test throughout is the one the whole phase exists for: a
 * person must never be left believing a document was sent when it was not. That
 * turns into three concrete things a test can hold onto — a bad link is retried
 * and never surfaces as a loss, a REFUSAL is pulled out of the retry loop and
 * made visible, and neither path can drop the blobs on the floor.
 *
 * IndexedDB is not in a Node environment, which is exactly why queueStore.ts
 * hides behind an interface: the drain loop is the interesting half and it is
 * tested here against a memory store. The IndexedDB implementation itself is
 * verified in a real browser (see the phase report), because a fake IndexedDB
 * would only prove that the fake works.
 */

function job(dedupeKey: string, pageCount = 2): ScanDocumentJob {
  return {
    companyId: "company-1",
    branchId: null,
    documentType: "purchase_invoice",
    vendorHint: "Ramesh Textiles",
    note: null,
    dedupeKey,
    pages: Array.from({ length: pageCount }, (_, i) => ({
      pageNo: i + 1,
      blob: new Blob(["x".repeat(1024)], { type: "image/jpeg" }),
      filename: `page-${i + 1}.jpg`,
    })),
  };
}

type TransportScript = {
  /** Throw this on every uploadPage until it is cleared. */
  failWith?: unknown;
  uploads: number[];
  submits: string[];
};

function scriptedTransport(script: TransportScript): ScanTransport {
  return {
    async uploadPage({ page, draftId }): Promise<ScanUploadedPage> {
      if (script.failWith) throw script.failWith;
      script.uploads.push(page.pageNo);
      return {
        draftId: draftId ?? "draft-1",
        pageNo: page.pageNo,
        storagePath: `company-1/captures/draft-1/${page.pageNo}.jpg`,
      };
    },
    async submitDraft({ draftId }) {
      if (script.failWith) throw script.failWith;
      script.submits.push(draftId);
    },
  };
}

/** No real timers: a 15-second backoff would make the suite unusable. */
function makeQueue(options: {
  store?: ScanQueueStore;
  transport: ScanTransport;
  online?: () => boolean;
}): { queue: ScanQueueController; store: ScanQueueStore; runBackoff: () => void } {
  const store = options.store ?? createMemoryQueueStore();
  let pending: (() => void) | null = null;
  const queue = createScanQueue({
    store,
    transport: options.transport,
    isOnline: options.online ?? (() => true),
    now: () => 1_700_000_000_000,
    schedule: (fn) => {
      pending = fn;
      return () => {
        pending = null;
      };
    },
  });
  return {
    queue,
    store,
    runBackoff: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

describe("classifying a failure", () => {
  it("calls 5xx and the slow-down family retryable, and the rest of 4xx permanent", () => {
    expect(classifyHttpStatus(500)).toBe("retryable");
    expect(classifyHttpStatus(502)).toBe("retryable");
    expect(classifyHttpStatus(429)).toBe("retryable");
    expect(classifyHttpStatus(408)).toBe("retryable");
    // The three the brief names by hand.
    expect(classifyHttpStatus(400)).toBe("permanent");
    expect(classifyHttpStatus(401)).toBe("permanent");
    expect(classifyHttpStatus(403)).toBe("permanent");
    expect(classifyHttpStatus(413)).toBe("permanent");
  });

  it("keeps the transport's own verdict when it has one", () => {
    expect(
      classifySendError(new ScanTransportError("too big", { kind: "permanent", status: 413 }))
    ).toBe("permanent");
    expect(
      classifySendError(new ScanTransportError("no signal", { kind: "retryable" }))
    ).toBe("retryable");
  });

  it("reads a dead fetch as retryable however the browser words it", () => {
    for (const message of [
      "Failed to fetch", // Chrome
      "Load failed", // Safari
      "NetworkError when attempting to fetch resource.", // Firefox
      "The request timed out",
    ]) {
      expect(classifySendError(new TypeError(message))).toBe("retryable");
    }
    expect(classifySendError({ name: "AbortError" })).toBe("retryable");
  });

  it("treats a database refusal as permanent, but a dead RPC socket as retryable", () => {
    // A draft the reviewer already confirmed. Retrying this forever would hide
    // the document behind "waiting to send" for good.
    expect(
      classifyRpcError({ message: "This capture draft is already confirmed", code: "P0001" })
    ).toBe("permanent");
    expect(classifyRpcError({ message: "TypeError: Failed to fetch" })).toBe("retryable");
  });

  it("recognises a quota error in each shape a browser throws it", () => {
    expect(isQuotaError({ name: "QuotaExceededError" })).toBe(true);
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError(new Error("The quota has been exceeded."))).toBe(true);
    expect(isQuotaError(new Error("Connection lost"))).toBe(false);
  });
});

describe("the drain loop", () => {
  let script: TransportScript;

  beforeEach(() => {
    script = { uploads: [], submits: [] };
  });

  it("sends a queued document and then forgets it", async () => {
    const { queue, store } = makeQueue({ transport: scriptedTransport(script) });
    await queue.refresh();
    await queue.enqueue(job("doc-a"));
    // enqueue starts a drain but does not wait for it — the shooter gets
    // "saved on this phone" the instant the bytes are durable, not when the
    // upload finishes. drain() joins that in-flight loop.
    await queue.drain("test");

    // enqueue drains straight away when the link is up.
    expect(script.uploads).toEqual([1, 2]);
    expect(script.submits).toEqual(["draft-1"]);
    expect(await store.list()).toHaveLength(0);
    expect(queue.getSnapshot().waiting).toBe(0);
  });

  it("holds a document when there is no link, and sends it when there is", async () => {
    let online = false;
    const { queue, store } = makeQueue({
      transport: scriptedTransport(script),
      online: () => online,
    });
    await queue.refresh();
    await queue.enqueue(job("doc-a"), null, "No signal.");

    expect(script.uploads).toEqual([]);
    expect(await store.list()).toHaveLength(1);
    expect(queue.getSnapshot().waiting).toBe(1);
    expect(queue.getSnapshot().blocked).toBe(0);

    // The blobs are still there — this is what "durable" has to mean.
    const [held] = await store.list();
    expect(held.job.pages).toHaveLength(2);
    expect(held.bytes).toBe(jobBytes(job("doc-a")));

    online = true;
    await queue.drain("online");

    expect(script.uploads).toEqual([1, 2]);
    expect(await store.list()).toHaveLength(0);
  });

  it("stops the whole drain on a bad link instead of hammering it with the rest", async () => {
    let online = false;
    const { queue, store } = makeQueue({
      transport: scriptedTransport(script),
      online: () => online,
    });
    await queue.refresh();
    await queue.enqueue(job("doc-a"));
    await queue.enqueue(job("doc-b"));
    await queue.enqueue(job("doc-c"));
    expect(await store.list()).toHaveLength(3);

    online = true;
    script.failWith = new ScanTransportError("No signal.", { kind: "retryable" });
    await queue.drain("online");

    // One attempt, then it gave up on the batch. Three documents' worth of
    // retries over a dead two-bar link is battery and nothing else.
    const rows = await store.list();
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.attempts > 0)).toHaveLength(1);
    expect(rows.every((r) => r.state === "waiting")).toBe(true);
    expect(queue.getSnapshot().blocked).toBe(0);
  });

  it("pulls a REFUSED document out of the retry loop and keeps draining the rest", async () => {
    const perDoc: Record<string, unknown> = {
      "doc-a": new ScanTransportError("This page is larger than the 10 MB limit.", {
        kind: "permanent",
        status: 400,
      }),
    };
    const transport: ScanTransport = {
      async uploadPage({ job: j, page, draftId }) {
        const failure = perDoc[j.dedupeKey];
        if (failure) throw failure;
        script.uploads.push(page.pageNo);
        return { draftId: draftId ?? "draft-1", pageNo: page.pageNo, storagePath: "p" };
      },
      async submitDraft({ draftId }) {
        script.submits.push(draftId);
      },
    };

    let online = false;
    const { queue, store } = makeQueue({ transport, online: () => online });
    await queue.refresh();
    await queue.enqueue(job("doc-a"));
    await queue.enqueue(job("doc-b"));

    online = true;
    await queue.drain("online");

    const rows = await store.list();
    // doc-b went; doc-a is parked where a person will see it.
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe("doc-a");
    expect(rows[0].state).toBe("blocked");
    expect(rows[0].lastError).toContain("10 MB limit");
    expect(queue.getSnapshot().blocked).toBe(1);
    expect(queue.getSnapshot().waiting).toBe(0);
    expect(script.submits).toEqual(["draft-1"]);
  });

  it("never retries a blocked document on its own, but will after a person says so", async () => {
    const failure = new ScanTransportError("This phone is signed out.", {
      kind: "permanent",
      status: 401,
    });
    script.failWith = failure;
    const { queue, store } = makeQueue({ transport: scriptedTransport(script) });
    await queue.refresh();
    await queue.enqueue(job("doc-a"));
    await queue.drain("test");
    expect((await store.list())[0].state).toBe("blocked");

    // Every automatic trigger there is. None of them may touch it.
    await queue.drain("online");
    await queue.drain("visible");
    await queue.drain("start");
    expect((await store.list())[0].attempts).toBe(1);

    // They signed back in and tapped "Try it again".
    script.failWith = undefined;
    await queue.unblock("doc-a");
    expect(await store.list()).toHaveLength(0);
    expect(script.submits).toEqual(["draft-1"]);
  });

  it("resumes from where it died rather than re-uploading pages that landed", async () => {
    const seen: Array<{ pageNo: number; draftId: string | null }> = [];
    let failFrom: number | null = 2;
    const transport: ScanTransport = {
      async uploadPage({ page, draftId }) {
        if (failFrom !== null && page.pageNo >= failFrom) {
          throw new ScanTransportError("No signal.", { kind: "retryable" });
        }
        seen.push({ pageNo: page.pageNo, draftId });
        return { draftId: draftId ?? "draft-9", pageNo: page.pageNo, storagePath: "p" };
      },
      async submitDraft({ draftId }) {
        script.submits.push(draftId);
      },
    };

    const { queue, store } = makeQueue({ transport });
    await queue.refresh();
    await queue.enqueue(job("doc-a", 3));
    await queue.drain("test");

    // Page 1 landed, page 2 died. The draft id came back and must be kept.
    const [held] = await store.list();
    expect(held.resume).toEqual({ draftId: "draft-9", uploadedPageNos: [1] });

    failFrom = null;
    await queue.drain("online");

    // Page 1 is NOT sent a second time over the same bad link.
    expect(seen.map((s) => s.pageNo)).toEqual([1, 2, 3]);
    expect(seen[1].draftId).toBe("draft-9");
    expect(await store.list()).toHaveLength(0);
  });

  it("refuses to hold more than the phone can carry, and says so", async () => {
    const store = createMemoryQueueStore();
    const { queue } = makeQueue({
      transport: scriptedTransport(script),
      store,
      online: () => false,
    });
    await queue.refresh();
    for (let i = 0; i < MAX_QUEUED_DOCUMENTS; i += 1) {
      expect((await queue.enqueue(job(`doc-${i}`))).ok).toBe(true);
    }

    const overflow = await queue.enqueue(job("one-too-many"));
    expect(overflow.ok).toBe(false);
    expect(queue.getSnapshot().storageProblem).toMatch(/have not gone|as many photos/i);
    // And the caller can tell, so the pages stay in memory rather than being
    // cleared off a screen that thinks they are safe.
    expect(await store.list()).toHaveLength(MAX_QUEUED_DOCUMENTS);
  });

  it("surfaces a quota failure from the store instead of throwing under the shutter", async () => {
    const store = createMemoryQueueStore();
    store.failNextPut = {
      ok: false,
      reason: "quota",
      message: "This phone has no room left.",
    };
    const { queue } = makeQueue({
      transport: scriptedTransport(script),
      store,
      online: () => false,
    });
    await queue.refresh();

    const result = await queue.enqueue(job("doc-a"));
    expect(result.ok).toBe(false);
    expect(queue.getSnapshot().storageProblem).toBe("This phone has no room left.");
    expect(queue.getSnapshot().waiting).toBe(0);
  });

  it("updates a document already in the queue rather than duplicating it", async () => {
    const { queue, store } = makeQueue({
      transport: scriptedTransport(script),
      online: () => false,
    });
    await queue.refresh();
    await queue.enqueue(job("doc-a"));
    await queue.enqueue(job("doc-a"), { draftId: "draft-1", uploadedPageNos: [1] });

    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].resume).toEqual({ draftId: "draft-1", uploadedPageNos: [1] });
  });

  it("does not run two drains at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const transport: ScanTransport = {
      async uploadPage({ page, draftId }) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return { draftId: draftId ?? "draft-1", pageNo: page.pageNo, storagePath: "p" };
      },
      async submitDraft() {},
    };
    let online = false;
    const { queue } = makeQueue({ transport, online: () => online });
    await queue.refresh();
    await queue.enqueue(job("doc-a"));
    await queue.enqueue(job("doc-b"));

    // All three triggers firing together is not hypothetical: coming back into
    // signal with the phone in your hand fires `online` and `visibilitychange`
    // within a few milliseconds of each other.
    online = true;
    await Promise.all([queue.drain("online"), queue.drain("visible"), queue.drain("manual")]);
    expect(maxInFlight).toBe(1);
    // And the documents went exactly once between them.
    expect(queue.getSnapshot().entries).toHaveLength(0);
  });

  it("throws a document away only when asked, and then it is gone", async () => {
    const { queue, store } = makeQueue({
      transport: scriptedTransport(script),
      online: () => false,
    });
    await queue.refresh();
    await queue.enqueue(job("doc-a"));
    await queue.discard("doc-a");
    expect(await store.list()).toHaveLength(0);
    expect(queue.getSnapshot().entries).toHaveLength(0);
  });
});

describe("the snapshot the screen reads", () => {
  it("is referentially stable between changes", async () => {
    const { queue } = makeQueue({
      transport: scriptedTransport({ uploads: [], submits: [] }),
      online: () => false,
    });
    await queue.refresh();
    const a = queue.getSnapshot();
    expect(queue.getSnapshot()).toBe(a);
    await queue.enqueue(job("doc-a"));
    expect(queue.getSnapshot()).not.toBe(a);
    const b = queue.getSnapshot();
    expect(queue.getSnapshot()).toBe(b);
  });

  it("tells subscribers when the queue changes", async () => {
    const listener = vi.fn();
    const { queue } = makeQueue({
      transport: scriptedTransport({ uploads: [], submits: [] }),
      online: () => false,
    });
    queue.subscribe(listener);
    await queue.refresh();
    await queue.enqueue(job("doc-a"));
    expect(listener).toHaveBeenCalled();
  });

  it("hands the server an empty, ready-false snapshot so nothing flashes on hydration", () => {
    const { queue } = makeQueue({
      transport: scriptedTransport({ uploads: [], submits: [] }),
    });
    const server = queue.getServerSnapshot();
    expect(server.ready).toBe(false);
    expect(server.entries).toEqual([]);
    expect(queue.getServerSnapshot()).toBe(server);
  });
});
