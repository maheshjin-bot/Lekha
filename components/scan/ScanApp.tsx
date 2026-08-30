"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createClient } from "@/lib/supabase/client";
import {
  createHttpTransport,
  newDedupeKey,
  pageFilename,
  sendScanDocument,
  type ScanDocumentJob,
  type ScanSendResume,
  type ScanTransport,
} from "@/lib/scan/uploadQueue";
import { getScanQueue } from "@/lib/scan/queueClient";
import { registerScanServiceWorker } from "@/lib/scan/registerScanServiceWorker";
import {
  SCAN_PLACE_SERVER_SNAPSHOT,
  getScanPlaceServerSnapshot,
  getScanPlaceSnapshot,
  parseScanPlace,
  resolveScanPlace,
  subscribeScanPlace,
  writeScanPlace,
  type ScanPlace,
} from "@/lib/scan/deviceMemory";
import type {
  ScanBranch,
  ScanCompany,
  ScanDocumentType,
  ScanPage,
  ScanTags,
} from "@/lib/scan/types";
import { PlacePicker } from "./PlacePicker";
import { ShootScreen } from "./ShootScreen";
import { CropScreen } from "./CropScreen";
import { TagScreen } from "./TagScreen";
import { SendScreen, type SendState } from "./SendScreen";
import { RecentSendsScreen } from "./RecentSendsScreen";
import { QueueBar } from "./QueueBar";
import { QueueScreen } from "./QueueScreen";

type Screen = "place" | "shoot" | "crop" | "tag" | "send" | "recent" | "queue";

const EMPTY_TAGS: ScanTags = { documentType: "purchase_invoice", vendorHint: "", note: "" };

const IDLE_SEND: SendState = {
  running: false,
  total: 0,
  currentPage: null,
  donePages: [],
  failedPage: null,
  submitting: false,
  succeeded: false,
  queued: false,
  queuedKey: null,
  error: null,
  permanent: false,
};

/**
 * The whole phone scanner, as one small state machine.
 *
 * Five screens, one linear path: pick where you are (once, ever) -> shoot ->
 * crop each shot -> tag it in three taps -> watch it go. Plus one side branch,
 * "my recent sends", which exists for a single reason: it is where a document
 * the office pushed back shows up with the reason attached. That loop is what
 * makes the feature work at all — without it a rejected bill just silently
 * never becomes a voucher and nobody on the shop floor ever finds out.
 *
 * Deliberately NOT here: any balance, amount, ledger, report, company
 * dashboard or navigation rail. See app/scan/layout.tsx.
 */
export function ScanApp({
  companies,
  branches,
}: {
  companies: ScanCompany[];
  branches: ScanBranch[];
}) {
  const [screen, setScreen] = useState<Screen>("shoot");
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [tags, setTags] = useState<ScanTags>(EMPTY_TAGS);
  const [sendState, setSendState] = useState<SendState>(IDLE_SEND);

  const dedupeKeyRef = useRef<string | null>(null);
  const resumeRef = useRef<ScanSendResume | null>(null);
  /**
   * The job the send screen is working on, held so a retry after clearPages()
   * still has its blobs. Declared up here with the other refs rather than down
   * beside startSend, because queueJob below writes it — and a ref first
   * mentioned inside a useCallback and only declared later is what this
   * project's react-hooks/immutability rule rejects.
   */
  const jobRef = useRef<ScanDocumentJob | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const transportRef = useRef<ScanTransport | null>(null);

  const branchesByCompany = useMemo(() => {
    const map: Record<string, ScanBranch[]> = {};
    for (const b of branches) (map[b.company_id] ??= []).push(b);
    return map;
  }, [branches]);

  // ---------------------------------------------------------------------
  // The offline queue. Read as an external store for the same reason
  // localStorage is above: it lives outside React, it changes from `online`
  // and `visibilitychange` listeners that React knows nothing about, and
  // copying it into state inside an effect would be a cascading render this
  // project's lint rejects outright.
  // ---------------------------------------------------------------------
  const queue = useMemo(() => getScanQueue(), []);
  const queueState = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getServerSnapshot
  );

  // Attaching the listeners also performs the first drain — which is the
  // "app start" trigger, and the one that actually matters: a phone that was
  // carried out of signal yesterday empties itself the moment the scanner is
  // reopened today.
  useEffect(() => queue.start(), [queue]);

  // The other half of offline: making /scan LOAD with no signal. Registered
  // from here rather than from the layout because this is the only client root
  // under /scan, and it runs before the early returns below.
  useEffect(() => {
    void registerScanServiceWorker();
  }, []);

  // ---------------------------------------------------------------------
  // Where am I? Answered once and remembered on the handset.
  //
  // localStorage is an external store, so it is READ as one. Copying it into
  // React state inside an effect would be a cascading render (and this
  // project's react-hooks lint rejects it outright); useSyncExternalStore also
  // gives a clean answer to "has the client read the device yet", which is
  // what stops the picker flashing at someone who set this up weeks ago.
  // ---------------------------------------------------------------------
  const rawPlace = useSyncExternalStore(
    subscribeScanPlace,
    getScanPlaceSnapshot,
    getScanPlaceServerSnapshot
  );
  const hydrated = rawPlace !== SCAN_PLACE_SERVER_SNAPSHOT;

  const place = useMemo(() => {
    if (!hydrated) return null;
    const companyIds = companies.map((c) => c.id);
    const branchIds: Record<string, string[]> = {};
    for (const c of companies) {
      branchIds[c.id] = (branchesByCompany[c.id] ?? []).map((b) => b.id);
    }
    return resolveScanPlace(parseScanPlace(rawPlace), companyIds, branchIds);
  }, [branchesByCompany, companies, hydrated, rawPlace]);

  // Exactly one company, and at most one branch in it: there is nothing to
  // ask, so do not ask. Two branches and we still need to know which gate this
  // handset is standing at. This writes to the STORE, not to React state, so
  // the re-render comes back through useSyncExternalStore above.
  useEffect(() => {
    if (!hydrated || place || companies.length !== 1) return;
    const only = companies[0];
    const list = branchesByCompany[only.id] ?? [];
    if (list.length > 1) return;
    writeScanPlace({ companyId: only.id, branchId: list[0]?.id ?? null });
  }, [branchesByCompany, companies, hydrated, place]);

  const company = place ? companies.find((c) => c.id === place.companyId) ?? null : null;
  const branch =
    place?.branchId != null ? branches.find((b) => b.id === place.branchId) ?? null : null;

  const choosePlace = useCallback((next: ScanPlace) => {
    writeScanPlace(next);
    setScreen("shoot");
  }, []);

  // ---------------------------------------------------------------------
  // Pages held in memory. Every object URL created here is revoked when its
  // page goes away — six leaked 400 KB blobs is how a cheap phone gets its
  // tab killed halfway through the seventh document.
  // ---------------------------------------------------------------------
  const dropPage = useCallback((id: string) => {
    setPages((current) => {
      const victim = current.find((p) => p.id === id);
      if (victim) URL.revokeObjectURL(victim.previewUrl);
      return current.filter((p) => p.id !== id);
    });
  }, []);

  const movePage = useCallback((id: string, delta: number) => {
    setPages((current) => {
      const index = current.findIndex((p) => p.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved);
      return next;
    });
  }, []);

  const clearPages = useCallback(() => {
    setPages((current) => {
      for (const p of current) URL.revokeObjectURL(p.previewUrl);
      return [];
    });
  }, []);

  const openCamera = useCallback(() => {
    // Resetting value first means shooting the same file twice in a row (which
    // a desktop file picker makes easy, and a retake makes likely) still fires
    // a change event.
    if (cameraRef.current) {
      cameraRef.current.value = "";
      cameraRef.current.click();
    }
  }, []);

  const onCameraChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setScreen("crop");
  }, []);

  const acceptCrop = useCallback(
    (page: ScanPage) => {
      setPages((current) => [...current, page]);
      setPendingFile(null);
      setScreen("shoot");
    },
    []
  );

  const cancelCrop = useCallback(() => {
    setPendingFile(null);
    setScreen("shoot");
  }, []);

  const retake = useCallback(() => {
    setPendingFile(null);
    setScreen("shoot");
    openCamera();
  }, [openCamera]);

  // ---------------------------------------------------------------------
  // Sending. Kicked off from a button, never from an effect — an effect that
  // re-fires on a re-render would double-send a document.
  // ---------------------------------------------------------------------
  /**
   * Hand the whole document to the phone's own disk and tell the shooter the
   * truth about where it is. Used both when there was never any signal to try
   * with, and when a try died on a retryable error.
   */
  const queueJob = useCallback(
    async (job: ScanDocumentJob, resume: ScanSendResume | null, reason: string | null) => {
      const stored = await queue.enqueue(job, resume, reason);
      if (stored.ok) {
        resumeRef.current = null;
        dedupeKeyRef.current = null;
        jobRef.current = null;
        clearPages();
        setSendState({
          running: false,
          total: job.pages.length,
          currentPage: null,
          donePages: resume?.uploadedPageNos ?? [],
          failedPage: null,
          submitting: false,
          succeeded: false,
          queued: true,
          queuedKey: job.dedupeKey,
          error: null,
          permanent: false,
        });
        return true;
      }
      // The phone could not hold it. The pages are still in memory, so the one
      // honest thing to do is keep them there and say so.
      setSendState((s) => ({
        ...s,
        running: false,
        submitting: false,
        succeeded: false,
        queued: false,
        queuedKey: null,
        error: stored.message,
        permanent: false,
      }));
      return false;
    },
    [clearPages, queue]
  );

  const runSend = useCallback(
    async (job: ScanDocumentJob, resume: ScanSendResume | null) => {
      // No point burning thirty seconds of a shooter's time on a fetch that
      // cannot possibly leave the handset. Straight to the queue.
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        await queueJob(job, resume, null);
        return;
      }

      transportRef.current ??= createHttpTransport(createClient());

      setSendState({
        running: true,
        total: job.pages.length,
        currentPage: null,
        donePages: resume?.uploadedPageNos ?? [],
        failedPage: null,
        submitting: false,
        succeeded: false,
        queued: false,
        queuedKey: null,
        error: null,
        permanent: false,
      });

      const result = await sendScanDocument(job, {
        transport: transportRef.current,
        resume,
        onEvent: (event) => {
          setSendState((s) => {
            switch (event.type) {
              case "page:start":
                return {
                  ...s,
                  currentPage: event.pageNo,
                  failedPage: null,
                  error: null,
                };
              case "page:done":
                return {
                  ...s,
                  currentPage: null,
                  donePages: s.donePages.includes(event.pageNo)
                    ? s.donePages
                    : [...s.donePages, event.pageNo],
                };
              case "submit:start":
                return { ...s, submitting: true };
              case "submit:done":
                return { ...s, submitting: false };
              case "error":
                // Clearing currentPage matters: a page that just failed was
                // otherwise left reading "sending…" under a red error box,
                // which is the one thing on this screen that must not lie.
                return {
                  ...s,
                  error: event.message,
                  currentPage: null,
                  failedPage: event.pageNo ?? null,
                };
              default:
                return s;
            }
          });
        },
      });

      if (result.ok) {
        resumeRef.current = null;
        dedupeKeyRef.current = null;
        clearPages();
        setSendState({
          running: false,
          total: job.pages.length,
          currentPage: null,
          donePages: job.pages.map((p) => p.pageNo),
          failedPage: null,
          submitting: false,
          succeeded: true,
          queued: false,
          queuedKey: null,
          error: null,
          permanent: false,
        });
        return;
      }

      resumeRef.current = result.resume;

      // A bad link is the queue's job. A refusal is a person's job, and dropping
      // it into a retry loop would hide it forever behind "waiting to send" —
      // which is the one thing this feature must never do.
      if (result.kind === "retryable") {
        await queueJob(job, result.resume, result.message);
        return;
      }

      setSendState((s) => ({
        ...s,
        running: false,
        submitting: false,
        succeeded: false,
        queued: false,
        queuedKey: null,
        error: result.message,
        permanent: true,
      }));
    },
    [clearPages, queueJob]
  );

  const buildJob = useCallback(
    (sourcePages: ScanPage[]): ScanDocumentJob | null => {
      if (!place || sourcePages.length === 0) return null;
      dedupeKeyRef.current ??= newDedupeKey();
      return {
        companyId: place.companyId,
        branchId: place.branchId,
        documentType: tags.documentType,
        vendorHint: tags.vendorHint.trim() || null,
        note: tags.note.trim() || null,
        dedupeKey: dedupeKeyRef.current,
        pages: sourcePages.map((p, index) => ({
          pageNo: index + 1,
          blob: p.blob,
          filename: pageFilename(p.blob, index + 1),
        })),
      };
    },
    [place, tags]
  );

  const startSend = useCallback(() => {
    const job = buildJob(pages);
    if (!job) return;
    jobRef.current = job;
    resumeRef.current = null;
    setScreen("send");
    void runSend(job, null);
  }, [buildJob, pages, runSend]);

  const retrySend = useCallback(() => {
    const job = jobRef.current;
    if (!job) return;
    void runSend(job, resumeRef.current);
  }, [runSend]);

  const startNewDocument = useCallback(
    (prefill?: Partial<ScanTags>) => {
      clearPages();
      jobRef.current = null;
      resumeRef.current = null;
      dedupeKeyRef.current = null;
      setTags({ ...EMPTY_TAGS, ...prefill });
      setSendState(IDLE_SEND);
      setScreen("shoot");
    },
    [clearPages]
  );

  const reshoot = useCallback(
    (documentType: string | null) => {
      const known: ScanDocumentType | undefined =
        documentType === "sales_challan" ||
        documentType === "purchase_invoice" ||
        documentType === "other"
          ? documentType
          : undefined;
      startNewDocument(known ? { documentType: known } : undefined);
      openCamera();
    },
    [openCamera, startNewDocument]
  );

  // Revoke everything still held if this component goes away mid-document.
  //
  // Via a ref, not by listing `pages` as a dependency. An empty dependency
  // array would close over the FIRST render's `pages` — an empty array — and
  // silently revoke nothing, while listing `pages` would tear down every
  // preview URL on every single shot. The ref is the only shape that gets the
  // live list at unmount and only at unmount.
  const pagesRef = useRef<ScanPage[]>([]);
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);
  useEffect(() => {
    return () => {
      for (const p of pagesRef.current) URL.revokeObjectURL(p.previewUrl);
    };
  }, []);

  if (companies.length === 0) {
    return (
      <NoAccess message="This login is not attached to any company yet. Ask the office to add you." />
    );
  }

  // No remembered place means the picker, whatever `screen` says — otherwise a
  // "Change" tap followed by a browser back button could leave the shooter on
  // a shutter that has nowhere to send to.
  const showPicker = !place || screen === "place";

  // "Saved on this phone" is only true while it stays true. If the drain
  // running behind this screen gets the very document it queued REFUSED, the
  // reassuring paragraph has to become the refusal — a screen left promising
  // that a rejected bill will go by itself is the precise failure this phase
  // exists to prevent. Derived during render from the queue snapshot, so it
  // updates the moment the drain does.
  const queuedRefusal =
    sendState.queued && sendState.queuedKey
      ? (queueState.entries.find(
          (e) => e.dedupeKey === sendState.queuedKey && e.state === "blocked"
        )?.lastError ?? null)
      : null;

  if (!hydrated) {
    return (
      <div className="flex flex-1 items-center justify-center px-8 text-center text-base text-ink-soft">
        Getting ready…
      </div>
    );
  }

  return (
    <>
      {/*
        One camera input for the whole app, sitting outside every screen so a
        retake from the crop screen and a first shot from the shutter both hit
        the same element. `capture="environment"` is what makes an Android open
        the rear camera straight away instead of the gallery chooser.
      */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onCameraChange}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        data-testid="scan-camera-input"
      />

      {/*
        The waiting count, above every screen the shooter works on. NOT on the
        crop screen (a full-bleed direct-manipulation surface where a strip
        appearing under the thumb mid-drag would be a hazard) and not on the
        place picker (which has nothing to send into yet).
      */}
      {!showPicker && screen !== "crop" && screen !== "queue" && (
        <QueueBar
          snapshot={queueState}
          onOpen={() => setScreen("queue")}
          onTryNow={() => void queue.drain("manual")}
        />
      )}

      {showPicker && (
        <PlacePicker
          companies={companies}
          branchesByCompany={branchesByCompany}
          onChoose={choosePlace}
          onCancel={place ? () => setScreen("shoot") : undefined}
        />
      )}

      {!showPicker && screen === "shoot" && (
        <ShootScreen
          companyName={company?.name ?? "—"}
          branchName={branch?.name ?? null}
          pages={pages}
          onShoot={openCamera}
          onDelete={dropPage}
          onMove={movePage}
          onNext={() => setScreen("tag")}
          onChangePlace={() => setScreen("place")}
          onOpenRecent={() => setScreen("recent")}
        />
      )}

      {!showPicker && screen === "crop" && pendingFile && (
        <CropScreen
          file={pendingFile}
          pageNo={pages.length + 1}
          onAccept={acceptCrop}
          onRetake={retake}
          onCancel={cancelCrop}
        />
      )}

      {!showPicker && screen === "tag" && (
        <TagScreen
          pageCount={pages.length}
          tags={tags}
          onChange={setTags}
          onBack={() => setScreen("shoot")}
          onSend={startSend}
        />
      )}

      {!showPicker && screen === "send" && (
        <SendScreen
          state={sendState}
          onRetry={retrySend}
          onDone={() => startNewDocument()}
          onBack={() => setScreen("tag")}
          onOpenRecent={() => setScreen("recent")}
          onOpenQueue={() => setScreen("queue")}
          queuedRefusal={queuedRefusal}
        />
      )}

      {!showPicker && screen === "recent" && place && (
        <RecentSendsScreen
          companyId={place.companyId}
          onBack={() => setScreen("shoot")}
          onReshoot={reshoot}
        />
      )}

      {!showPicker && screen === "queue" && (
        <QueueScreen
          snapshot={queueState}
          onBack={() => setScreen("shoot")}
          onTryNow={() => void queue.drain("manual")}
          onDiscard={(key) => void queue.discard(key)}
          onUnblock={(key) => void queue.unblock(key)}
        />
      )}
    </>
  );
}

function NoAccess({ message }: { message: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <p className="font-display text-2xl font-semibold text-ink">Nothing to scan into</p>
      <p className="text-base text-ink-soft">{message}</p>
    </div>
  );
}
