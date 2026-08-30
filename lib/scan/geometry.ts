/**
 * The maths behind the 4-corner crop, kept deliberately free of any DOM or
 * canvas reference so it is unit-testable in this project's `environment:
 * "node"` vitest setup.
 *
 * WHY THERE IS NO CV LIBRARY HERE
 * OpenCV.js is ~8 MB of WASM. The person using this is on shop-floor mobile
 * data on a cheap Android; an 8 MB download before the first photo is the
 * difference between "they use it" and "they go back to the paper tray". The
 * whole of the perspective correction we actually need is one 8x8 linear solve
 * and a per-pixel inverse map, which is what this file is.
 */

export type Point = { x: number; y: number };

/** Four corners, in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

/**
 * Row-major 3x3 projective transform:
 *   [ h0 h1 h2 ]
 *   [ h3 h4 h5 ]
 *   [ h6 h7 h8 ]
 */
export type Homography = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export type Size = { width: number; height: number };

/**
 * Scale (w, h) down so neither side exceeds `max`, preserving aspect ratio.
 * Never scales UP — a blurry 640px photo blown up to 1600px is bigger to
 * upload and no easier to read.
 */
export function fitWithin(width: number, height: number, max: number): Size {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  if (longest <= max) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const scale = max / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * How big the flattened page should come out.
 *
 * A quad photographed at an angle has two different "widths" (its top edge and
 * its bottom edge) and two different "heights". Taking the LONGER of each pair
 * rather than the average means the near edge — the one with the most real
 * pixels behind it — is reproduced at full detail instead of being squeezed,
 * which is what the back-office OCR will later be reading.
 */
export function outputSizeForQuad(quad: Quad, maxEdge: number): Size {
  const [tl, tr, br, bl] = quad;
  const width = Math.max(distance(tl, tr), distance(bl, br));
  const height = Math.max(distance(tl, bl), distance(tr, br));
  if (width < 1 || height < 1) return { width: 0, height: 0 };
  return fitWithin(width, height, maxEdge);
}

/**
 * Put four arbitrarily-dragged corners back into TL, TR, BR, BL order.
 *
 * Sorting by angle around the centroid (rather than the common min/max-of-sum
 * trick) survives the case a shop-floor user actually produces: a strongly
 * skewed quad where the "top-left" point is not the one with the smallest
 * x + y. Ties are broken deterministically so the function is pure.
 */
export function orderCorners(points: Point[]): Quad {
  if (points.length !== 4) {
    throw new Error(`orderCorners needs exactly 4 points, got ${points.length}`);
  }
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;

  // Screen coordinates: y grows downward, so atan2 increases clockwise. Sorting
  // ascending therefore walks the quad clockwise, which is the TL→TR→BR→BL
  // order we want once we pick the right starting corner.
  const withAngle = points.map((p) => ({
    p,
    angle: Math.atan2(p.y - cy, p.x - cx),
  }));
  withAngle.sort((a, b) => a.angle - b.angle || a.p.x - b.p.x || a.p.y - b.p.y);

  // Start at whichever corner is furthest up-and-left of the centroid.
  let startIndex = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const { p } = withAngle[i];
    const score = p.x - cx + (p.y - cy);
    if (score < best) {
      best = score;
      startIndex = i;
    }
  }

  const ordered = [0, 1, 2, 3].map((i) => withAngle[(startIndex + i) % 4].p);
  return [ordered[0], ordered[1], ordered[2], ordered[3]];
}

/**
 * Solve the 8x8 system by Gaussian elimination with partial pivoting.
 * Returns null for a singular system (three collinear corners, a collapsed
 * quad) rather than emitting NaNs into a render loop.
 */
function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  // Work on copies — callers keep their matrices.
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const swap = m[pivot];
      m[pivot] = m[col];
      m[col] = swap;
    }
    const pivotValue = m[col][col];
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row][col] / pivotValue;
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) {
        m[row][k] -= factor * m[col][k];
      }
    }
  }

  const solution = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    solution[i] = m[i][n] / m[i][i];
    if (!Number.isFinite(solution[i])) return null;
  }
  return solution;
}

/**
 * The projective transform that carries each `from[i]` onto `to[i]`.
 *
 * For the crop we want the INVERSE map — destination pixel to source pixel —
 * so callers pass the flat output rectangle as `from` and the photographed
 * quad as `to`. That way the render loop can walk output pixels in order
 * (cache-friendly, no holes) and simply sample wherever each one came from.
 */
export function solveHomography(from: Quad, to: Quad): Homography | null {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = from[i];
    const { x, y } = to[i];
    a.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    a.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  const s = solveLinearSystem(a, b);
  if (!s) return null;
  return [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], 1];
}

export function applyHomography(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  if (w === 0) return { x: NaN, y: NaN };
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  };
}

/** The corners of an axis-aligned w x h rectangle, in TL, TR, BR, BL order. */
export function rectQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

/**
 * Where a point lands after the image it sits on is turned a quarter-turn
 * clockwise `turns` times. An image W x H becomes H x W on an odd number of
 * turns, so the dimensions are swapped as we go.
 *
 * One clockwise turn: (x, y) -> (H - y, x). Check it against the corners —
 * the old top-left (0,0) becomes (H, 0), the new top-RIGHT, which is exactly
 * what turning a sheet of paper clockwise does to its top-left corner.
 */
export function rotatePoint(
  p: Point,
  width: number,
  height: number,
  turns: number
): Point {
  let w = width;
  let h = height;
  let out = { x: p.x, y: p.y };
  const n = ((turns % 4) + 4) % 4;
  for (let i = 0; i < n; i++) {
    out = { x: h - out.y, y: out.x };
    const swap = w;
    w = h;
    h = swap;
  }
  return out;
}

export function rotateQuad(
  quad: Quad,
  width: number,
  height: number,
  turns: number
): Quad {
  const r = quad.map((p) => rotatePoint(p, width, height, turns));
  return [r[0], r[1], r[2], r[3]];
}

/** Image size after `turns` quarter-turns. */
export function rotateSize(width: number, height: number, turns: number): Size {
  const n = ((turns % 4) + 4) % 4;
  return n % 2 === 0
    ? { width, height }
    : { width: height, height: width };
}

export function clampPointToSize(p: Point, size: Size): Point {
  return {
    x: Math.min(Math.max(p.x, 0), size.width),
    y: Math.min(Math.max(p.y, 0), size.height),
  };
}

/**
 * The default crop: the whole frame, pulled in slightly.
 *
 * Starting at the exact edges would leave the handles half off-screen and
 * impossible to grab with a thumb, which is the single most common way a
 * corner-crop UI fails on a phone.
 */
export function defaultQuad(width: number, height: number, inset = 0.04): Quad {
  const dx = width * inset;
  const dy = height * inset;
  return [
    { x: dx, y: dy },
    { x: width - dx, y: dy },
    { x: width - dx, y: height - dy },
    { x: dx, y: height - dy },
  ];
}

/**
 * True when the quad is (near enough) the full frame — used to skip the
 * expensive per-pixel warp entirely for the common "the photo is already fine"
 * case. Tolerance is in source pixels.
 */
export function isFullFrame(quad: Quad, size: Size, tolerance = 1): boolean {
  const target = rectQuad(size.width, size.height);
  return quad.every(
    (p, i) =>
      Math.abs(p.x - target[i].x) <= tolerance &&
      Math.abs(p.y - target[i].y) <= tolerance
  );
}
