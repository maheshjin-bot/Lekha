/**
 * Canvas half of the crop. Everything here touches the DOM, so the maths it
 * depends on lives next door in geometry.ts where vitest (which runs in a
 * `node` environment in this project) can reach it.
 *
 * The single most important thing this file does is SHRINK. A photo off a
 * modern phone is 4-12 MB. Uploading that raw over shop-floor mobile data is
 * the difference between this feature being used and being abandoned, so every
 * page is re-encoded to a JPEG whose longest edge is SCAN_MAX_EDGE before it is
 * ever handed to the uploader. Re-encoding through a canvas also neutralises
 * HEIC on the devices that hand it back, and strips the EXIF payload (GPS
 * included) that a camera roll photo otherwise carries into storage.
 */

import {
  applyHomography,
  defaultQuad,
  isFullFrame,
  outputSizeForQuad,
  rectQuad,
  rotateSize,
  solveHomography,
  fitWithin,
  type Quad,
  type Size,
} from "./geometry";

/**
 * Longest edge of the image we sample FROM. Big enough that a flattened crop
 * of a corner of the frame still has real detail behind it; small enough that
 * the one getImageData() call below is ~17 MB rather than ~50 MB, which matters
 * on a 2 GB Android.
 */
export const SCAN_WORKING_MAX_EDGE = 2400;

/** Longest edge of what actually gets uploaded. A4 at ~150 dpi is legible. */
export const SCAN_MAX_EDGE = 1800;

/** Chosen by eye over document photos: 0.9 is visibly wasteful, 0.7 mushy. */
export const SCAN_JPEG_QUALITY = 0.82;

export class ScanDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanDecodeError";
  }
}

/**
 * Decode a camera file to something drawable.
 *
 * createImageBitmap is tried first because `imageOrientation: "from-image"`
 * makes it apply the EXIF rotation tag, which is what stops portrait photos
 * from arriving in the back office lying on their side. The <img> fallback
 * covers browsers without it; modern engines apply EXIF orientation to <img>
 * by default too.
 */
async function decodeImage(file: Blob): Promise<CanvasImageSource & Size> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return bitmap;
    } catch {
      // Fall through — HEIC on a browser without a decoder lands here, as does
      // an older engine that rejects the options bag.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(
          new ScanDecodeError(
            "This phone could not open that photo. Send it without cropping, or take it again."
          )
        );
      el.src = url;
    });
    return Object.assign(img, {
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  } finally {
    // Safe once decode has resolved: the bitmap is already in memory.
    URL.revokeObjectURL(url);
  }
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new ScanDecodeError("This phone's browser has no canvas support.");
  return ctx;
}

export type WorkingImage = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Object URL of the working canvas, for showing under the crop handles. */
  previewUrl: string;
};

/**
 * Downscale a camera file once, up front, into the canvas everything else
 * works against. Done here rather than per-render so dragging a corner handle
 * never re-decodes a 12 MP JPEG.
 */
export async function createWorkingImage(file: Blob): Promise<WorkingImage> {
  const source = await decodeImage(file);
  const size = fitWithin(source.width, source.height, SCAN_WORKING_MAX_EDGE);
  if (size.width === 0) {
    throw new ScanDecodeError("That photo came through empty. Take it again.");
  }
  const canvas = makeCanvas(size.width, size.height);
  const ctx = context2d(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, size.width, size.height);
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    source.close();
  }
  return {
    canvas,
    width: size.width,
    height: size.height,
    previewUrl: canvas.toDataURL("image/jpeg", 0.75),
  };
}

/** Turn a working canvas a quarter-turn clockwise `turns` times. */
export function rotateWorkingCanvas(
  canvas: HTMLCanvasElement,
  turns: number
): HTMLCanvasElement {
  const n = ((turns % 4) + 4) % 4;
  if (n === 0) return canvas;
  const out = rotateSize(canvas.width, canvas.height, n);
  const next = makeCanvas(out.width, out.height);
  const ctx = context2d(next);
  ctx.translate(next.width / 2, next.height / 2);
  ctx.rotate((n * Math.PI) / 2);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return next;
}

export type RenderedPage = {
  blob: Blob;
  width: number;
  height: number;
};

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new ScanDecodeError("This phone could not save the cropped photo."));
      },
      "image/jpeg",
      quality
    );
  });
}

/**
 * Flatten `quad` out of `canvas` into an upright rectangle and encode it.
 *
 * The warp is an inverse map: for every pixel of the OUTPUT we ask the
 * homography where it came from in the source and sample there bilinearly.
 * Walking the output in order means no holes and no seams — the artefacts you
 * get from the forward-mapping / triangle-splitting trick people reach for
 * when they find out canvas 2D transforms are only affine.
 */
export async function renderCroppedPage(
  canvas: HTMLCanvasElement,
  quad: Quad,
  options?: { maxEdge?: number; quality?: number }
): Promise<RenderedPage> {
  const maxEdge = options?.maxEdge ?? SCAN_MAX_EDGE;
  const quality = options?.quality ?? SCAN_JPEG_QUALITY;
  const sourceSize: Size = { width: canvas.width, height: canvas.height };

  // Fast path: the user never moved the handles off the frame edge, so there is
  // nothing projective to do — just scale and encode. Saves a couple of hundred
  // milliseconds of JS pixel loop on a slow phone, every single page.
  if (isFullFrame(quad, sourceSize, 1.5)) {
    const size = fitWithin(sourceSize.width, sourceSize.height, maxEdge);
    const flat = makeCanvas(size.width, size.height);
    const flatCtx = context2d(flat);
    flatCtx.imageSmoothingEnabled = true;
    flatCtx.imageSmoothingQuality = "high";
    flatCtx.drawImage(canvas, 0, 0, size.width, size.height);
    return { blob: await toBlob(flat, quality), width: size.width, height: size.height };
  }

  const out = outputSizeForQuad(quad, maxEdge);
  if (out.width === 0 || out.height === 0) {
    throw new ScanDecodeError("Those corners do not make a shape. Reset the crop.");
  }

  // Output rectangle -> photographed quad, i.e. the destination-to-source map.
  const h = solveHomography(rectQuad(out.width, out.height), quad);
  if (!h) {
    throw new ScanDecodeError("Those corners do not make a shape. Reset the crop.");
  }

  const srcCtx = context2d(canvas);
  const src = srcCtx.getImageData(0, 0, sourceSize.width, sourceSize.height);
  const srcData = src.data;
  const sw = src.width;
  const sh = src.height;

  const dest = makeCanvas(out.width, out.height);
  const destCtx = context2d(dest);
  const destImage = destCtx.createImageData(out.width, out.height);
  const destData = destImage.data;

  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      // Sample from pixel centres, or the whole image drifts half a pixel.
      const p = applyHomography(h, { x: x + 0.5, y: y + 0.5 });
      const di = (y * out.width + x) * 4;

      const fx = p.x - 0.5;
      const fy = p.y - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;

      // Clamp rather than skip: a corner dragged a pixel outside the frame
      // should smear the edge, not punch a black hole in the page.
      const x0c = x0 < 0 ? 0 : x0 >= sw ? sw - 1 : x0;
      const x1c = x0 + 1 < 0 ? 0 : x0 + 1 >= sw ? sw - 1 : x0 + 1;
      const y0c = y0 < 0 ? 0 : y0 >= sh ? sh - 1 : y0;
      const y1c = y0 + 1 < 0 ? 0 : y0 + 1 >= sh ? sh - 1 : y0 + 1;

      const i00 = (y0c * sw + x0c) * 4;
      const i10 = (y0c * sw + x1c) * 4;
      const i01 = (y1c * sw + x0c) * 4;
      const i11 = (y1c * sw + x1c) * 4;

      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;

      for (let c = 0; c < 3; c++) {
        destData[di + c] =
          srcData[i00 + c] * w00 +
          srcData[i10 + c] * w10 +
          srcData[i01 + c] * w01 +
          srcData[i11 + c] * w11;
      }
      destData[di + 3] = 255;
    }
  }

  destCtx.putImageData(destImage, 0, 0);
  return { blob: await toBlob(dest, quality), width: out.width, height: out.height };
}

export { defaultQuad };
