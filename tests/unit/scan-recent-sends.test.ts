import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  effectiveStage,
  fetchRecentSends,
  formatSentAt,
} from "@/lib/scan/recentSends";
import {
  describeSendStatus,
  scanDocumentTypeLabel,
  type ScanRecentSend,
} from "@/lib/scan/types";
import { resolveScanPlace, readScanPlace } from "@/lib/scan/deviceMemory";

function fakeSupabase(response: { data?: unknown; error?: { message: string } }) {
  return {
    rpc: async () => ({ data: response.data ?? null, error: response.error ?? null }),
  } as unknown as SupabaseClient;
}

describe("fetchRecentSends", () => {
  it("reads the rows the 0870 RPC actually returns", async () => {
    const result = await fetchRecentSends(
      fakeSupabase({
        data: [
          {
            id: "d1",
            draft_id: "d1",
            status: "rejected",
            stage: "rejected",
            rejected_reason: "The bottom of the bill is cut off",
            page_count: 2,
            document_type: "purchase_invoice",
            vendor_hint: "Ramesh Textiles",
            created_at: "2026-08-30T09:15:00+05:30",
          },
        ],
      }),
      "company-1"
    );

    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].rejected_reason).toBe("The bottom of the bill is cut off");
    expect(result.rows[0].page_count).toBe(2);
  });

  it("falls back to `id` when only that spelling is present", async () => {
    const result = await fetchRecentSends(
      fakeSupabase({ data: [{ id: "d9", status: "pending_review" }] }),
      "company-1"
    );
    expect(result.rows[0].draft_id).toBe("d9");
  });

  it("drops a row with no id at all rather than rendering an undefined key", async () => {
    const result = await fetchRecentSends(
      fakeSupabase({ data: [{ status: "pending_review" }, { id: "ok" }] }),
      "company-1"
    );
    expect(result.rows.map((r) => r.draft_id)).toEqual(["ok"]);
  });

  it("blanks a whitespace-only reject reason, so no empty red box is drawn", async () => {
    const result = await fetchRecentSends(
      fakeSupabase({ data: [{ id: "d1", status: "rejected", rejected_reason: "   " }] }),
      "company-1"
    );
    expect(result.rows[0].rejected_reason).toBeNull();
  });

  it("says the feature is not deployed rather than showing a PostgREST code", async () => {
    const result = await fetchRecentSends(
      fakeSupabase({
        error: {
          message:
            "Could not find the function public.get_my_capture_drafts(p_company_id, p_limit) in the schema cache (PGRST202)",
        },
      }),
      "company-1"
    );
    expect(result.rows).toEqual([]);
    expect(result.error).toMatch(/not available on this server yet/);
  });

  it("gives an ordinary retry message for an ordinary failure", async () => {
    const result = await fetchRecentSends(
      fakeSupabase({ error: { message: "network timeout" } }),
      "company-1"
    );
    expect(result.error).toMatch(/try again/i);
  });
});

describe("describeSendStatus", () => {
  it("speaks shop-floor English, not database English", () => {
    expect(describeSendStatus("confirmed").label).toBe("Posted");
    expect(describeSendStatus("rejected").label).toBe("Sent back");
    expect(describeSendStatus("pending_review").label).toBe("Pending review");
  });

  it("only 'rejected' offers a re-shoot with a reason", () => {
    expect(describeSendStatus("rejected").sentBack).toBe(true);
    expect(describeSendStatus("pending_review").sentBack).toBe(false);
    expect(describeSendStatus("confirmed").sentBack).toBe(false);
  });

  it("separates 'nobody has looked at it yet' from 'it never left the phone'", () => {
    // Both are status = 'pending_review' in the table; only `stage` tells them
    // apart, and getting this wrong hides a bill in nobody's queue forever.
    const unsent = describeSendStatus("capturing");
    expect(unsent.label).toBe("Not sent");
    expect(unsent.unsent).toBe(true);
    expect(unsent.sentBack).toBe(false);
    expect(describeSendStatus("pending_review").unsent).toBe(false);
  });

  it("shows an unknown status verbatim rather than swallowing it", () => {
    expect(describeSendStatus("something_new").label).toBe("something_new");
  });
});

describe("effectiveStage", () => {
  const base: ScanRecentSend = {
    draft_id: "d",
    status: "pending_review",
    stage: null,
    rejected_reason: null,
    page_count: 1,
    document_type: null,
    vendor_hint: null,
    created_at: "",
  };

  it("prefers stage when the RPC supplies it", () => {
    expect(effectiveStage({ ...base, stage: "capturing" })).toBe("capturing");
  });

  it("falls back to status on an older backend", () => {
    expect(effectiveStage(base)).toBe("pending_review");
  });
});

describe("scanDocumentTypeLabel", () => {
  it("names the three kinds of paper in words a godown uses", () => {
    expect(scanDocumentTypeLabel("sales_challan")).toBe("Delivery challan");
    expect(scanDocumentTypeLabel("purchase_invoice")).toBe("Supplier bill");
    expect(scanDocumentTypeLabel("other")).toBe("Something else");
  });

  it("does not blow up on a null or unknown type", () => {
    expect(scanDocumentTypeLabel(null)).toBe("Document");
    expect(scanDocumentTypeLabel("who_knows")).toBe("Document");
  });
});

describe("formatSentAt", () => {
  const now = new Date("2026-08-30T18:00:00+05:30");

  it("says Today for something sent this morning", () => {
    expect(formatSentAt("2026-08-30T09:15:00+05:30", now)).toMatch(/^Today, /);
  });

  it("says Yesterday across the midnight boundary", () => {
    expect(formatSentAt("2026-08-29T23:50:00+05:30", now)).toMatch(/^Yesterday, /);
  });

  it("falls back to a date for anything older", () => {
    const out = formatSentAt("2026-08-20T10:00:00+05:30", now);
    expect(out).not.toMatch(/Today|Yesterday/);
    expect(out).toMatch(/20 Aug/);
  });

  it("returns an empty string rather than 'Invalid Date' for junk", () => {
    expect(formatSentAt("", now)).toBe("");
    expect(formatSentAt("not-a-date", now)).toBe("");
  });
});

describe("device memory", () => {
  it("reads nothing at all on the server, without throwing", () => {
    // vitest runs this suite in a `node` environment: no window, which is
    // exactly the server-render case the guard exists for.
    expect(readScanPlace()).toBeNull();
  });

  it("forgets a company this login can no longer send into", () => {
    expect(
      resolveScanPlace({ companyId: "gone", branchId: null }, ["a", "b"], {})
    ).toBeNull();
  });

  it("keeps the company but drops a branch that no longer belongs to it", () => {
    expect(
      resolveScanPlace({ companyId: "a", branchId: "stale" }, ["a"], { a: ["b1"] })
    ).toEqual({ companyId: "a", branchId: null });
  });

  it("keeps a still-valid place untouched", () => {
    const place = { companyId: "a", branchId: "b1" };
    expect(resolveScanPlace(place, ["a"], { a: ["b1", "b2"] })).toEqual(place);
  });

  it("has nothing to resolve when the device has never been set up", () => {
    expect(resolveScanPlace(null, ["a"], {})).toBeNull();
  });
});
