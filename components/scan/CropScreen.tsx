"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, RotateCw, X } from "lucide-react";
import {
  clampPointToSize,
  defaultQuad,
  orderCorners,
  rectQuad,
  rotateQuad,
  type Point,
  type Quad,
} from "@/lib/scan/geometry";
import {
  createWorkingImage,
  renderCroppedPage,
  rotateWorkingCanvas,
  ScanDecodeError,
  type WorkingImage,
} from "@/lib/scan/imagePipeline";
import type { ScanPage } from "@/lib/scan/types";
import { newDedupeKey } from "@/lib/scan/uploadQueue";

const HANDLE_LABELS = ["Top left", "Top right", "Bottom right", "Bottom left"];

/**
 * Confirm one shot: drag the four corners onto the paper, turn it if it came
 * out sideways, then keep it.
 *
 * The corners are the whole reason this screen exists. A photo taken over a
 * counter is always a trapezium, and the back office reads these later — an
 * un-flattened, un-cropped photo of a bill lying on a wooden table with half a
 * calculator in frame is measurably worse to work from. The flattening itself
 * is a plain projective warp done in lib/scan/imagePipeline.ts; there is no CV
 * library here on purpose (8 MB of WASM over shop-floor data is not a trade
 * this feature can make).
 */
export function CropScreen({
  file,
  pageNo,
  onAccept,
  onRetake,
  onCancel,
}: {
  file: File;
  pageNo: number;
  onAccept: (page: ScanPage) => void;
  onRetake: () => void;
  onCancel: () => void;
}) {
  const [working, setWorking] = useState<WorkingImage | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "saving" | "undecodable">(
    "loading"
  );
  const [error, setError] = useState<string | null>(null);
  // Which handle is under the finger. Kept in BOTH a ref and state on purpose:
  // the ref is what the move handler tests, because it is set synchronously by
  // pointerdown, while a state update is not — a fast flick can deliver its
  // first pointermove before React has re-rendered, and reading state there
  // silently drops that move. The state copy exists only to grow the dot.
  const draggingRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  // --- decode -------------------------------------------------------------
  // No synchronous setState in the effect body: "loading" and a null error are
  // this component's INITIAL state, and it is mounted fresh for every shot
  // (ScanApp only renders it while there is a pending file), so there is
  // nothing to reset. Resetting here instead would be a cascading render, and
  // this project's react-hooks lint rejects one.
  useEffect(() => {
    let cancelled = false;
    createWorkingImage(file)
      .then((image) => {
        if (cancelled) return;
        setWorking(image);
        setQuad(defaultQuad(image.width, image.height));
        setPhase("ready");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof ScanDecodeError
            ? cause.message
            : "This phone could not open that photo."
        );
        // Not a dead end: the photo itself is fine, this browser just cannot
        // decode it (HEIC on an older Android is the usual cause). The office
        // can still read it, so offer to send the original untouched.
        setPhase("undecodable");
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  // --- measure the stage --------------------------------------------------
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setStage({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [phase]);

  const scale =
    working && stage.width > 0 && stage.height > 0
      ? Math.min(stage.width / working.width, stage.height / working.height)
      : 0;
  const shownWidth = working ? working.width * scale : 0;
  const shownHeight = working ? working.height * scale : 0;

  // --- corner dragging ----------------------------------------------------
  const moveCorner = useCallback(
    (index: number, clientX: number, clientY: number) => {
      const node = stageRef.current;
      if (!node || !working || scale <= 0) return;
      const rect = node.getBoundingClientRect();
      const originX = rect.left + (rect.width - shownWidth) / 2;
      const originY = rect.top + (rect.height - shownHeight) / 2;
      const raw: Point = {
        x: (clientX - originX) / scale,
        y: (clientY - originY) / scale,
      };
      const clamped = clampPointToSize(raw, {
        width: working.width,
        height: working.height,
      });
      setQuad((current) => {
        if (!current) return current;
        const next = [...current] as Quad;
        next[index] = clamped;
        return next;
      });
    },
    [scale, shownHeight, shownWidth, working]
  );

  // Both of these read `working` straight out of the closure rather than using
  // a setState updater. Kicking off a second setState from INSIDE an updater
  // makes that updater impure, and React is entitled to run it twice — which
  // would turn one tap on Rotate into two quarter-turns of the crop quad.
  const rotate = useCallback(() => {
    if (!working) return;
    const canvas = rotateWorkingCanvas(working.canvas, 1);
    setQuad((q) => (q ? rotateQuad(q, working.width, working.height, 1) : q));
    setWorking({
      canvas,
      width: canvas.width,
      height: canvas.height,
      previewUrl: canvas.toDataURL("image/jpeg", 0.75),
    });
  }, [working]);

  const resetCrop = useCallback(() => {
    if (!working) return;
    setQuad(rectQuad(working.width, working.height));
  }, [working]);

  const keepOriginal = useCallback(() => {
    onAccept({
      id: newDedupeKey(),
      blob: file,
      previewUrl: URL.createObjectURL(file),
      width: 0,
      height: 0,
      bytes: file.size,
    });
  }, [file, onAccept]);

  const accept = useCallback(async () => {
    if (!working || !quad) return;
    setPhase("saving");
    setError(null);
    // Give the browser a moment to paint "Preparing…" before the pixel loop
    // takes the main thread for a few hundred milliseconds on a slow phone.
    //
    // A plain `await requestAnimationFrame` would be the obvious way to do
    // that, and it HANGS. Confirmed live: in a page that is not being
    // composited — an occluded window, a backgrounded WebView, and this
    // project's own preview pane — rAF simply never fires, while
    // document.visibilityState still reads "visible", so there is no flag to
    // branch on. The crop screen then sits on "Preparing the page…" forever
    // with the photo un-saveable. A timeout cannot be starved the same way.
    await new Promise((resolve) => setTimeout(resolve, 32));
    try {
      const ordered = orderCorners(quad);
      const rendered = await renderCroppedPage(working.canvas, ordered);
      onAccept({
        id: newDedupeKey(),
        blob: rendered.blob,
        previewUrl: URL.createObjectURL(rendered.blob),
        width: rendered.width,
        height: rendered.height,
        bytes: rendered.blob.size,
      });
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : "Could not save that crop. Try again."
      );
      setPhase("ready");
    }
  }, [onAccept, quad, working]);

  // --- undecodable --------------------------------------------------------
  if (phase === "undecodable") {
    return (
      <div className="flex flex-1 flex-col justify-between px-5 pb-8 pt-8">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <p className="font-display text-2xl font-semibold text-ink">
            Cannot open that photo here
          </p>
          <p className="max-w-sm text-base text-ink-soft">{error}</p>
          <p className="max-w-sm text-sm text-ink-faint">
            The office can still open it. Sending it uncropped is fine.
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={keepOriginal}
            className="min-h-[60px] rounded-card bg-accent px-4 text-lg font-semibold text-accent-ink active:opacity-90"
          >
            Send it uncropped
          </button>
          <button
            type="button"
            onClick={onRetake}
            className="min-h-[56px] rounded-card border border-border-strong px-4 text-base font-semibold text-ink active:bg-surface-2"
          >
            Take it again
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[48px] text-base text-ink-soft active:text-ink"
          >
            Throw it away
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-ink">
      <header className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-semibold uppercase tracking-wide text-white/70">
          Page {pageNo}
        </span>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Throw this photo away"
          className="flex h-11 w-11 items-center justify-center rounded-full text-white/80 active:bg-white/10"
        >
          <X size={24} />
        </button>
      </header>

      <div ref={stageRef} className="relative flex-1 touch-none overflow-hidden">
        {phase === "loading" && (
          <p className="absolute inset-0 flex items-center justify-center text-base text-white/70">
            Opening the photo…
          </p>
        )}

        {working && quad && scale > 0 && (
          <div
            className="absolute"
            style={{
              left: (stage.width - shownWidth) / 2,
              top: (stage.height - shownHeight) / 2,
              width: shownWidth,
              height: shownHeight,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- an in-memory data URL of the photo just taken, not a static asset Next's <Image> can optimise. */}
            <img
              src={working.previewUrl}
              alt="The photo you just took"
              className="h-full w-full select-none"
              draggable={false}
            />

            {/* The crop outline. pointer-events-none so the SVG never eats a
                drag meant for a handle underneath it. */}
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox={`0 0 ${working.width} ${working.height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <polygon
                points={quad.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="rgba(54, 84, 214, 0.16)"
                stroke="#7C93F0"
                /* viewBox units, so divide by the display scale to land on a
                   constant ~3 physical pixels whatever the photo's size. */
                strokeWidth={3 / scale}
              />
            </svg>

            {quad.map((p, index) => (
              <button
                key={index}
                type="button"
                aria-label={`${HANDLE_LABELS[index]} corner`}
                data-testid={`scan-handle-${index}`}
                onPointerDown={(event) => {
                  // Capture so the corner keeps following the finger even when
                  // it slides off the 56px target, which on a real drag it
                  // immediately does.
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // Some engines refuse capture for a pointer they no longer
                    // consider active; dragging still works without it.
                  }
                  draggingRef.current = index;
                  setDragging(index);
                }}
                onPointerMove={(event) => {
                  if (draggingRef.current !== index) return;
                  moveCorner(index, event.clientX, event.clientY);
                }}
                onPointerUp={() => {
                  draggingRef.current = null;
                  setDragging(null);
                }}
                onPointerCancel={() => {
                  draggingRef.current = null;
                  setDragging(null);
                }}
                className="absolute flex h-14 w-14 items-center justify-center rounded-full"
                style={{
                  left: p.x * scale - 28,
                  top: p.y * scale - 28,
                  touchAction: "none",
                }}
              >
                {/* 56px of invisible grab area around a 20px visible dot: the
                    dot has to stay small enough to see the paper edge under
                    it, the target has to stay big enough for a thumb. */}
                <span
                  className={
                    "block rounded-full border-[3px] border-white shadow-card transition-transform " +
                    (dragging === index ? "h-7 w-7 scale-110" : "h-5 w-5")
                  }
                  style={{ backgroundColor: "#3654D6" }}
                />
              </button>
            ))}
          </div>
        )}

        {phase === "saving" && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink/70 text-lg font-semibold text-white">
            Preparing the page…
          </div>
        )}
      </div>

      {/* The undecodable case returned above, so anything left here is a
          crop/encode failure the user can retry from. */}
      {error && (
        <p className="px-4 pb-2 text-sm font-semibold text-white" role="alert">
          {error}
        </p>
      )}

      <div
        className="flex items-center gap-3 border-t border-white/10 px-4 pt-3"
        style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          onClick={rotate}
          disabled={!working || phase === "saving"}
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-white/25 text-white disabled:opacity-40 active:bg-white/10"
          aria-label="Turn the photo"
        >
          <RotateCw size={24} />
        </button>
        <button
          type="button"
          onClick={resetCrop}
          disabled={!working || phase === "saving"}
          className="h-14 shrink-0 rounded-full border border-white/25 px-4 text-sm font-semibold text-white disabled:opacity-40 active:bg-white/10"
        >
          Whole photo
        </button>
        <button
          type="button"
          onClick={onRetake}
          disabled={phase === "saving"}
          className="h-14 shrink-0 rounded-full border border-white/25 px-4 text-sm font-semibold text-white disabled:opacity-40 active:bg-white/10"
        >
          Retake
        </button>
        <button
          type="button"
          onClick={() => void accept()}
          disabled={!working || phase === "saving"}
          data-testid="scan-accept-crop"
          className="flex h-14 flex-1 items-center justify-center gap-2 rounded-full bg-accent text-lg font-semibold text-accent-ink disabled:opacity-40 active:opacity-90"
        >
          <Check size={24} />
          {phase === "saving" ? "Wait…" : "Keep"}
        </button>
      </div>
    </div>
  );
}
