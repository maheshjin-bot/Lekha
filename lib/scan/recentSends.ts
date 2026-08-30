/**
 * "Did the office get it, and did they take it?"
 *
 * This is the only read the phone ever performs against company data, and it is
 * deliberately routed through a single narrow RPC rather than a table select:
 * `get_my_capture_drafts` returns THIS person's own recent sends and nothing
 * else — no amounts, no ledgers, no other shooter's documents. The restraint is
 * the point. A dedicated restricted `operator` role is a later phase; until it
 * exists, the narrowness of this call is what keeps the books off this screen.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc } from "@/lib/supabase/rpc";
import type { ScanRecentSend } from "./types";

export const SCAN_RECENT_LIMIT = 20;

export type ScanRecentResult = {
  rows: ScanRecentSend[];
  /** Null when the read succeeded. A message the shooter can act on if not. */
  error: string | null;
};

function coerceRow(value: unknown): ScanRecentSend | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const draftId = row.draft_id ?? row.id;
  if (typeof draftId !== "string") return null;
  return {
    draft_id: draftId,
    status: typeof row.status === "string" ? row.status : "pending_review",
    stage: typeof row.stage === "string" ? row.stage : null,
    rejected_reason:
      typeof row.rejected_reason === "string" && row.rejected_reason.trim()
        ? row.rejected_reason
        : null,
    page_count: typeof row.page_count === "number" ? row.page_count : 0,
    document_type: typeof row.document_type === "string" ? row.document_type : null,
    vendor_hint:
      typeof row.vendor_hint === "string" && row.vendor_hint.trim()
        ? row.vendor_hint
        : null,
    created_at: typeof row.created_at === "string" ? row.created_at : "",
  };
}

/** `stage` when the RPC supplies it, plain `status` otherwise. */
export function effectiveStage(row: ScanRecentSend): string {
  return row.stage ?? row.status;
}

export async function fetchRecentSends(
  supabase: SupabaseClient,
  companyId: string,
  limit = SCAN_RECENT_LIMIT
): Promise<ScanRecentResult> {
  const { data, error } = await callRpc<
    { p_company_id: string; p_limit: number },
    unknown[]
  >(supabase, "get_my_capture_drafts", {
    p_company_id: companyId,
    p_limit: limit,
  });

  if (error) {
    // PGRST202 is PostgREST for "no such function in the schema cache", which is
    // exactly what this looks like while the backend half of the feature is
    // still being deployed. Say so plainly instead of showing a raw code.
    const missing = /PGRST202|Could not find the function|does not exist/i.test(
      error.message
    );
    return {
      rows: [],
      error: missing
        ? "Your recent sends are not available on this server yet."
        : "Could not load your recent sends. Pull down to try again.",
    };
  }

  const rows = (Array.isArray(data) ? data : [])
    .map(coerceRow)
    .filter((r): r is ScanRecentSend => r !== null);

  return { rows, error: null };
}

/**
 * "2:40 pm today" beats an ISO string on a 5-inch screen held at arm's length.
 * Asia/Kolkata is the only timezone this product runs in.
 */
export function formatSentAt(iso: string, now = new Date()): string {
  if (!iso) return "";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";

  const time = when.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  if (sameDay) return `Today, ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const wasYesterday =
    when.getFullYear() === yesterday.getFullYear() &&
    when.getMonth() === yesterday.getMonth() &&
    when.getDate() === yesterday.getDate();
  if (wasYesterday) return `Yesterday, ${time}`;

  return `${when.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  })}, ${time}`;
}
