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

type Screen = "place" | "shoot" | "crop" | "tag" | "send" | "recent";

const EMPTY_TAGS: ScanTags = { documentType: "purchase_invoice", vendorHint: "", note: "" };

const IDLE_SEND: SendState = {
  running: false,
  total: 0,
  currentPage: null,
  donePages: [],
  failedPage: null,
  submitting: false,
  succeeded: false,
  error: null,
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
  const cameraRef = useRef<HTMLInputElement>(null);
  const transportRef = useRef<ScanTransport | null>(null);

  const branchesByCompany = useMemo(() => {
    const map: Record<string, ScanBranch[]> = {};
    for (const b of branches) (map[b.company_id] ??= []).push(b);
    return map;
  }, [branches]);

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
  const runSend = useCallback(
    async (job: ScanDocumentJob, resume: ScanSendResume | null) => {
      transportRef.current ??= createHttpTransport(createClient());

      setSendState({
        running: true,
        total: job.pages.length,
        currentPage: null,
        donePages: resume?.uploadedPageNos ?? [],
        failedPage: null,
        submitting: false,
        succeeded: false,
        error: null,
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
          error: null,
        });
      } else {
        resumeRef.current = result.resume;
        setSendState((s) => ({
          ...s,
          running: false,
          submitting: false,
          succeeded: false,
          error: result.message,
        }));
      }
    },
    [clearPages]
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

  // The job the send screen is working on. Held so a retry after clearPages()
  // (which only runs on success) still has its blobs.
  const jobRef = useRef<ScanDocumentJob | null>(null);

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
        />
      )}

      {!showPicker && screen === "recent" && place && (
        <RecentSendsScreen
          companyId={place.companyId}
          onBack={() => setScreen("shoot")}
          onReshoot={reshoot}
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
