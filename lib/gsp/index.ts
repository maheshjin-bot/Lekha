import type { GspAdapter } from "./types";
import { mockGspAdapter } from "./mockAdapter";

/**
 * The one place a caller asks "which GspAdapter should I use right now?".
 * Today there is exactly one honest answer: the mock — no GSP has been
 * chosen yet (Sandbox.co.in and MasterGST were the two candidates prior
 * research turned up; see lib/gsp/types.ts's header), and picking one is a
 * business decision this function does not get to make.
 *
 * This is also the seam a real adapter arrives through once that decision is
 * made: add its case here (e.g. selected by an env var such as
 * GSP_PROVIDER), and every future caller of getGspAdapter() picks it up
 * without needing to know an adapter changed. Nothing currently calls this —
 * see lib/gsp/types.ts's header on why no screen has been wired up yet.
 */
export function getGspAdapter(): GspAdapter {
  return mockGspAdapter;
}

export * from "./types";
export { mockGspAdapter } from "./mockAdapter";
