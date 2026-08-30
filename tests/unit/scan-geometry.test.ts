import { describe, expect, it } from "vitest";
import {
  applyHomography,
  defaultQuad,
  fitWithin,
  isFullFrame,
  orderCorners,
  outputSizeForQuad,
  rectQuad,
  rotatePoint,
  rotateQuad,
  rotateSize,
  solveHomography,
  clampPointToSize,
  type Point,
  type Quad,
} from "@/lib/scan/geometry";

/**
 * The crop maths, tested away from any canvas.
 *
 * This is the half of the phone scanner that can be wrong SILENTLY: a bad
 * homography does not throw, it just delivers a subtly sheared bill to the
 * back office that a reviewer half-reads and posts wrong. So the projective
 * transform is checked against a case worked out by hand, not just against
 * "it returned nine numbers".
 */

function near(a: number, b: number, tolerance = 1e-6) {
  expect(Math.abs(a - b)).toBeLessThan(tolerance);
}

function nearPoint(a: Point, b: Point, tolerance = 1e-6) {
  near(a.x, b.x, tolerance);
  near(a.y, b.y, tolerance);
}

describe("fitWithin", () => {
  it("scales the long edge down to the cap and keeps the aspect ratio", () => {
    expect(fitWithin(4000, 3000, 1800)).toEqual({ width: 1800, height: 1350 });
    expect(fitWithin(3000, 4000, 1800)).toEqual({ width: 1350, height: 1800 });
  });

  it("never scales up — a blurry small photo enlarged is bigger and no clearer", () => {
    expect(fitWithin(640, 480, 1800)).toEqual({ width: 640, height: 480 });
  });

  it("survives a zero-sized input rather than returning NaN", () => {
    expect(fitWithin(0, 500, 1800)).toEqual({ width: 0, height: 0 });
  });
});

describe("solveHomography / applyHomography", () => {
  it("maps every one of the four control points exactly", () => {
    const from = rectQuad(100, 200);
    const to: Quad = [
      { x: 12, y: 30 },
      { x: 190, y: 8 },
      { x: 205, y: 260 },
      { x: 3, y: 240 },
    ];
    const h = solveHomography(from, to)!;
    expect(h).not.toBeNull();
    from.forEach((p, i) => nearPoint(applyHomography(h, p), to[i], 1e-6));
  });

  it("reduces to the identity when source and target are the same rectangle", () => {
    const rect = rectQuad(300, 400);
    const h = solveHomography(rect, rect)!;
    nearPoint(applyHomography(h, { x: 137, y: 291 }), { x: 137, y: 291 });
  });

  it("is a plain scale when the target is a scaled rectangle", () => {
    const h = solveHomography(rectQuad(100, 100), rectQuad(300, 200))!;
    nearPoint(applyHomography(h, { x: 50, y: 50 }), { x: 150, y: 100 });
  });

  it("is genuinely projective, not affine — checked against a hand-derived value", () => {
    // A symmetric trapezium: the shape every photo of a bill taken across a
    // counter actually is. Under an AFFINE map the centre of the square would
    // land at the average of the four corners, y = 50. Under a true projective
    // map it does not, and that difference IS the correction this feature
    // exists to apply.
    //
    // The true answer, derived independently of the code under test, by
    // cross-ratio: the left edge (0,0)-(20,100) and the right edge
    // (100,0)-(80,100) meet at the vanishing point (50, 250). Along the source
    // line u = 50 the four points v = 0, 50, 100, infinity have cross-ratio
    // -1; a projective map preserves it, so the image y = c of v = 50 solves
    //   (-c / (100 - c)) / ((0 - 250) / (100 - 250)) = -1
    //   =>  3c = 500 - 5c  =>  c = 62.5
    const to: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 80, y: 100 },
      { x: 20, y: 100 },
    ];
    const h = solveHomography(rectQuad(100, 100), to)!;
    const centre = applyHomography(h, { x: 50, y: 50 });
    near(centre.x, 50, 1e-9); // symmetric, so x is unchanged
    near(centre.y, 62.5, 1e-9);
  });

  it("returns null rather than NaN when the corners are degenerate", () => {
    const collapsed: Quad = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    expect(solveHomography(rectQuad(100, 100), collapsed)).toBeNull();
  });
});

describe("orderCorners", () => {
  it("puts a shuffled rectangle back into TL, TR, BR, BL", () => {
    const tl = { x: 10, y: 10 };
    const tr = { x: 90, y: 12 };
    const br = { x: 95, y: 80 };
    const bl = { x: 5, y: 78 };
    expect(orderCorners([br, bl, tr, tl])).toEqual([tl, tr, br, bl]);
  });

  it("handles a strongly skewed quad, where sorting by x+y would not", () => {
    // The leftmost point is LOWER than the "top-left" one; a min-of-(x+y) rule
    // picks the wrong starting corner for shapes like this.
    const quad: Point[] = [
      { x: 40, y: 0 },
      { x: 200, y: 40 },
      { x: 160, y: 200 },
      { x: 0, y: 160 },
    ];
    const ordered = orderCorners([quad[2], quad[0], quad[3], quad[1]]);
    // Whatever it picks as first, the cycle must be preserved and the four
    // points must go round the shape without crossing.
    expect(new Set(ordered.map((p) => `${p.x},${p.y}`)).size).toBe(4);
    const [a, b, c, d] = ordered;
    // Signed area of the polygon, walked in order. Non-zero and consistent in
    // sign means the walk does not self-intersect.
    const cross =
      a.x * b.y - b.x * a.y + (b.x * c.y - c.x * b.y) + (c.x * d.y - d.x * c.y) + (d.x * a.y - a.x * d.y);
    expect(Math.abs(cross)).toBeGreaterThan(0);
  });

  it("refuses anything that is not four points", () => {
    expect(() => orderCorners([{ x: 0, y: 0 }])).toThrow(/4 points/);
  });
});

describe("rotatePoint / rotateQuad / rotateSize", () => {
  it("sends the top-left corner to the top-right on one clockwise turn", () => {
    // An image 100 wide by 200 tall becomes 200 x 100. Its old (0,0) must land
    // at the new top-right, which is x = old height = 200.
    nearPoint(rotatePoint({ x: 0, y: 0 }, 100, 200, 1), { x: 200, y: 0 });
    nearPoint(rotatePoint({ x: 100, y: 0 }, 100, 200, 1), { x: 200, y: 100 });
  });

  it("comes back to where it started after four turns", () => {
    const p = { x: 37, y: 129 };
    nearPoint(rotatePoint(p, 400, 300, 4), p);
  });

  it("normalises negative and oversized turn counts", () => {
    nearPoint(rotatePoint({ x: 5, y: 9 }, 100, 200, -1), rotatePoint({ x: 5, y: 9 }, 100, 200, 3));
    nearPoint(rotatePoint({ x: 5, y: 9 }, 100, 200, 5), rotatePoint({ x: 5, y: 9 }, 100, 200, 1));
  });

  it("swaps width and height on odd turns only", () => {
    expect(rotateSize(100, 200, 1)).toEqual({ width: 200, height: 100 });
    expect(rotateSize(100, 200, 2)).toEqual({ width: 100, height: 200 });
  });

  it("keeps a full-frame quad full-frame after a turn", () => {
    const quad = rectQuad(100, 200);
    const turned = rotateQuad(quad, 100, 200, 1);
    // Same four corners, just relabelled — so as a SET it is still the frame.
    const corners = new Set(turned.map((p) => `${p.x},${p.y}`));
    expect(corners).toEqual(new Set(["0,0", "200,0", "200,100", "0,100"]));
  });
});

describe("outputSizeForQuad", () => {
  it("takes the longer of each opposing edge pair, so the near edge keeps its detail", () => {
    // Top edge 100 wide, bottom edge 200 wide — the bottom was nearer the lens
    // and has twice the real pixels behind it.
    const quad: Quad = [
      { x: 50, y: 0 },
      { x: 150, y: 0 },
      { x: 200, y: 300 },
      { x: 0, y: 300 },
    ];
    const size = outputSizeForQuad(quad, 4000);
    expect(size.width).toBe(200);
    // Both slanted sides are hypot(50, 300) = 304.14…, longer than the 300 a
    // naive bounding box would give.
    expect(size.height).toBe(304);
  });

  it("still respects the upload cap", () => {
    const size = outputSizeForQuad(rectQuad(6000, 3000), 1800);
    expect(Math.max(size.width, size.height)).toBe(1800);
  });

  it("returns zero for a collapsed quad instead of a 0-divide", () => {
    const point = { x: 5, y: 5 };
    expect(outputSizeForQuad([point, point, point, point], 1800)).toEqual({
      width: 0,
      height: 0,
    });
  });
});

describe("defaultQuad / isFullFrame / clampPointToSize", () => {
  it("insets the starting crop so the handles are grabbable", () => {
    const quad = defaultQuad(1000, 500);
    expect(quad[0]).toEqual({ x: 40, y: 20 });
    expect(quad[2]).toEqual({ x: 960, y: 480 });
    expect(isFullFrame(quad, { width: 1000, height: 500 })).toBe(false);
  });

  it("recognises the untouched whole frame, so the warp can be skipped", () => {
    expect(isFullFrame(rectQuad(800, 600), { width: 800, height: 600 })).toBe(true);
  });

  it("keeps a dragged corner inside the photo", () => {
    expect(clampPointToSize({ x: -30, y: 900 }, { width: 400, height: 300 })).toEqual({
      x: 0,
      y: 300,
    });
  });
});
