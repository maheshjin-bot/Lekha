/**
 * The two 0870 scanner Route Handlers, invoked directly as plain functions —
 * a Route Handler is just (Request) => Response, so this exercises the REAL
 * exported POST, not a reimplementation of it.
 *
 * What is mocked and what is not, stated plainly: lib/supabase/server's
 * client is mocked (there is no live session or bucket in a unit test) and
 * lib/capture/analyze's analyzeCaptureImage is mocked (it would otherwise
 * make a real Gemini call). Everything else — the validation, the ordering of
 * storage vs database writes, the compensating delete, the deterministic
 * path, the sha256 — is the route's own code running for real.
 *
 * The database RPCs these routes call have all been applied to and exercised
 * against the live LEKHA database; what is asserted here is that the ROUTE
 * calls them with the right arguments in the right order, not that they work
 * (which SQL proved separately).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetUser, mockRpc, mockUpload, mockRemove, mockDownload, mockFrom, mockAnalyze } =
  vi.hoisted(() => ({
    mockGetUser: vi.fn(),
    mockRpc: vi.fn(),
    mockUpload: vi.fn(),
    mockRemove: vi.fn(),
    mockDownload: vi.fn(),
    mockFrom: vi.fn(),
    mockAnalyze: vi.fn(),
  }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
    rpc: mockRpc,
    storage: {
      from: () => ({ upload: mockUpload, remove: mockRemove, download: mockDownload }),
    },
  }),
}));

vi.mock("@/lib/capture/analyze", () => ({ analyzeCaptureImage: mockAnalyze }));

import { POST as uploadPost } from "@/app/api/capture/upload/route";
import { POST as extractPost } from "@/app/api/capture/extract/route";

const CO = "9321ef74-8b82-45e4-bcab-fbe50d659e1f";
const DRAFT = "11111111-2222-3333-4444-555555555555";
const USER = "5d0be511-d7f6-4d2d-9793-925d2bd96fda";

/**
 * A `.from(table)` whose chain ends in maybeSingle(), answering per table.
 * Every link returns the same object, so .select().eq().eq().maybeSingle()
 * works regardless of how many filters the route applies.
 */
function tableResults(results: Record<string, { data: unknown; error?: unknown }>) {
  return (table: string) => {
    const result = () => results[table] ?? { data: null, error: null };
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = self;
    chain.eq = self;
    chain.order = self;
    chain.limit = self;
    chain.maybeSingle = async () => result();
    chain.single = async () => result();
    // A PostgREST builder is itself awaitable when no row-shaping terminator
    // is used (`.select().eq()` on a list query), so the fake must be too.
    chain.then = (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(ok, no);
    return chain;
  };
}

function uploadRequest(fields: Record<string, string>, file?: File) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append("file", file);
  return new Request("http://localhost/api/capture/upload", { method: "POST", body: fd });
}

function jpeg(bytes = [1, 2, 3], name = "bill.jpg", type = "image/jpeg") {
  return new File([new Uint8Array(bytes)], name, { type });
}

beforeEach(() => {
  mockGetUser.mockReset();
  mockRpc.mockReset();
  mockUpload.mockReset();
  mockRemove.mockReset();
  mockDownload.mockReset();
  mockFrom.mockReset();
  mockAnalyze.mockReset();

  mockGetUser.mockResolvedValue({ data: { user: { id: USER } } });
  mockUpload.mockResolvedValue({ error: null });
  mockRemove.mockResolvedValue({ error: null });
  mockFrom.mockImplementation(
    tableResults({
      companies: { data: { id: CO }, error: null },
      capture_draft_pages: { data: null, error: null },
    })
  );
  mockRpc.mockImplementation(async (name: string) => {
    if (name === "create_capture_draft") return { data: DRAFT, error: null };
    return { data: null, error: null };
  });
});

describe("POST /api/capture/upload", () => {
  it("refuses an unauthenticated caller before touching storage", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await uploadPost(uploadRequest({ companyId: CO, pageNo: "1" }, jpeg()));
    expect(res.status).toBe(401);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("requires companyId, a file and a valid pageNo", async () => {
    expect((await uploadPost(uploadRequest({ pageNo: "1" }, jpeg()))).status).toBe(400);
    expect((await uploadPost(uploadRequest({ companyId: CO, pageNo: "1" }))).status).toBe(400);
    expect((await uploadPost(uploadRequest({ companyId: CO, pageNo: "0" }, jpeg()))).status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("refuses a file type that is not a document page", async () => {
    const res = await uploadPost(
      uploadRequest({ companyId: CO, pageNo: "1" }, jpeg([1], "x.gif", "image/gif"))
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("HEIC") });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("accepts an iPhone HEIC whose browser sent no content type at all", async () => {
    const res = await uploadPost(
      uploadRequest({ companyId: CO, pageNo: "1" }, jpeg([9], "IMG_0421.HEIC", ""))
    );
    expect(res.status).toBe(200);
    expect(mockUpload).toHaveBeenCalledWith(
      `${CO}/capture/${DRAFT}/page-001.heic`,
      expect.anything(),
      { contentType: "image/heic", upsert: true }
    );
  });

  it("refuses a page over the 10 MB cap without uploading it", async () => {
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.jpg", { type: "image/jpeg" });
    const res = await uploadPost(uploadRequest({ companyId: CO, pageNo: "1" }, big));
    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("refuses a company the caller cannot see, before storing anything", async () => {
    mockFrom.mockImplementation(tableResults({ companies: { data: null, error: null } }));
    const res = await uploadPost(uploadRequest({ companyId: CO, pageNo: "1" }, jpeg()));
    expect(res.status).toBe(403);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("NEVER calls the vision model — extraction moved to review time (0870)", async () => {
    const res = await uploadPost(
      uploadRequest(
        { companyId: CO, pageNo: "1", documentType: "sales_challan", vendorHint: " Sharma " },
        jpeg()
      )
    );
    expect(res.status).toBe(200);
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("creates the draft on page 1 and records the page with its sha256", async () => {
    const bytes = [7, 7, 7, 7];
    const res = await uploadPost(
      uploadRequest(
        {
          companyId: CO,
          pageNo: "1",
          documentType: "purchase_invoice",
          vendorHint: "  Sharma Textiles  ",
          note: "  counter book  ",
          dedupeKey: " dev-abc ",
          branchId: "  ",
        },
        jpeg(bytes)
      )
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      draftId: DRAFT,
      pageNo: 1,
      storagePath: `${CO}/capture/${DRAFT}/page-001.jpg`,
      createdDraft: true,
    });

    expect(mockRpc).toHaveBeenCalledWith("create_capture_draft", {
      p_company_id: CO,
      // A blank branchId is dropped entirely rather than sent as null:
      // supabase-js JSON-encodes the payload, so an undefined value is omitted
      // and the SQL parameter's own DEFAULT applies.
      p_branch_id: undefined,
      p_document_type: "purchase_invoice",
      p_vendor_hint: "Sharma Textiles",
      p_note: "counter book",
      p_client_dedupe_key: "dev-abc",
    });

    const { createHash } = await import("node:crypto");
    expect(mockRpc).toHaveBeenCalledWith("add_capture_draft_page", {
      p_draft_id: DRAFT,
      p_page_no: 1,
      p_storage_path: `${CO}/capture/${DRAFT}/page-001.jpg`,
      p_sha256: createHash("sha256").update(Buffer.from(new Uint8Array(bytes))).digest("hex"),
    });
  });

  it("reuses an existing draft for page 2 instead of creating a second one", async () => {
    const res = await uploadPost(
      uploadRequest({ companyId: CO, pageNo: "2", draftId: DRAFT }, jpeg())
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      draftId: DRAFT,
      pageNo: 2,
      storagePath: `${CO}/capture/${DRAFT}/page-002.jpg`,
      createdDraft: false,
    });
    const called = mockRpc.mock.calls.map((c) => c[0]);
    expect(called).not.toContain("create_capture_draft");
    expect(called).toContain("add_capture_draft_page");
  });

  it("removes the uploaded object when recording the page fails (new page)", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "create_capture_draft") return { data: DRAFT, error: null };
      return { data: null, error: { message: "draft is already rejected" } };
    });
    const res = await uploadPost(uploadRequest({ companyId: CO, pageNo: "1" }, jpeg()));
    expect(res.status).toBe(400);
    expect(mockRemove).toHaveBeenCalledWith([`${CO}/capture/${DRAFT}/page-001.jpg`]);
  });

  it("does NOT remove the object when the page already existed — it is not ours to delete", async () => {
    mockFrom.mockImplementation(
      tableResults({
        companies: { data: { id: CO }, error: null },
        capture_draft_pages: { data: { id: "page-row" }, error: null },
      })
    );
    mockRpc.mockImplementation(async () => ({ data: null, error: { message: "nope" } }));
    const res = await uploadPost(
      uploadRequest({ companyId: CO, pageNo: "1", draftId: DRAFT }, jpeg())
    );
    expect(res.status).toBe(400);
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("reports a failed storage write without recording a page", async () => {
    mockUpload.mockResolvedValue({ error: { message: "bucket is full" } });
    const res = await uploadPost(
      uploadRequest({ companyId: CO, pageNo: "1", draftId: DRAFT }, jpeg())
    );
    expect(res.status).toBe(400);
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain("add_capture_draft_page");
  });
});

describe("POST /api/capture/extract", () => {
  const EXTRACTION = {
    configured: true,
    vendor_name: "Sharma Textiles",
    confidence: "high",
    note: "read cleanly",
  };

  function extractRequest(body: unknown) {
    return new Request("http://localhost/api/capture/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function blob(bytes = [4, 5, 6], type = "image/jpeg") {
    return new Blob([new Uint8Array(bytes)], { type });
  }

  beforeEach(() => {
    mockAnalyze.mockResolvedValue(EXTRACTION);
    mockDownload.mockResolvedValue({ data: blob(), error: null });
  });

  it("refuses an unauthenticated caller", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await extractPost(extractRequest({ draftId: DRAFT }));
    expect(res.status).toBe(401);
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("requires a draftId", async () => {
    expect((await extractPost(extractRequest({}))).status).toBe(400);
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("404s a draft the caller cannot see (RLS returns no row)", async () => {
    mockFrom.mockImplementation(tableResults({ capture_drafts: { data: null, error: null } }));
    const res = await extractPost(extractRequest({ draftId: DRAFT }));
    expect(res.status).toBe(404);
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("refuses to spend a vision call on an already-confirmed document", async () => {
    mockFrom.mockImplementation(
      tableResults({
        capture_drafts: { data: { id: DRAFT, storage_path: "p.jpg", status: "confirmed" }, error: null },
      })
    );
    const res = await extractPost(extractRequest({ draftId: DRAFT }));
    expect(res.status).toBe(409);
    expect(mockAnalyze).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("refuses a draft that has no pages yet (storage_path is still the folder)", async () => {
    mockFrom.mockImplementation(
      tableResults({
        capture_drafts: {
          data: { id: DRAFT, storage_path: `${CO}/capture/${DRAFT}/`, status: "pending_review" },
          error: null,
        },
        capture_draft_pages: { data: null, error: null },
      })
    );
    const res = await extractPost(extractRequest({ draftId: DRAFT }));
    expect(res.status).toBe(400);
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it("reads page 1, analyses it, and stores the result through the RPC", async () => {
    const pagePath = `${CO}/capture/${DRAFT}/page-001.jpg`;
    mockFrom.mockImplementation(
      tableResults({
        capture_drafts: {
          data: { id: DRAFT, company_id: CO, storage_path: pagePath, status: "pending_review" },
          error: null,
        },
        capture_draft_pages: { data: { storage_path: pagePath }, error: null },
        companies: { data: { name: "Agarwal HUF" }, error: null },
        gst_registrations: { data: [{ gstin: "09AAACH7409R1ZZ" }, { gstin: "  " }], error: null },
      })
    );

    const res = await extractPost(extractRequest({ draftId: DRAFT }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draftId: DRAFT, extracted: EXTRACTION, saved: true });

    expect(mockDownload).toHaveBeenCalledWith(pagePath);
    expect(mockAnalyze).toHaveBeenCalledTimes(1);
    expect(mockAnalyze.mock.calls[0][1]).toBe("image/jpeg");
    expect(Buffer.isBuffer(mockAnalyze.mock.calls[0][0])).toBe(true);
    // Tells the model whose books these are, so a bill we ISSUED is not read
    // as one we received. Blank GSTINs are dropped, not passed through.
    expect(mockAnalyze.mock.calls[0][2]).toEqual({
      companyName: "Agarwal HUF",
      companyGstins: ["09AAACH7409R1ZZ"],
    });
    expect(mockRpc).toHaveBeenCalledWith("set_capture_draft_extraction", {
      p_draft_id: DRAFT,
      p_extracted: EXTRACTION,
    });
  });

  it("still extracts when the company has no name or GSTIN to offer", async () => {
    const pagePath = `${CO}/capture/${DRAFT}/page-001.jpg`;
    mockFrom.mockImplementation(
      tableResults({
        capture_drafts: {
          data: { id: DRAFT, company_id: CO, storage_path: pagePath, status: "pending_review" },
          error: null,
        },
        capture_draft_pages: { data: { storage_path: pagePath }, error: null },
        companies: { data: null, error: null },
        gst_registrations: { data: [], error: null },
      })
    );
    const res = await extractPost(extractRequest({ draftId: DRAFT }));
    expect(res.status).toBe(200);
    expect(mockAnalyze.mock.calls[0][2]).toBeUndefined();
  });

  it("falls back to the draft's own storage_path for a pre-0870 single-shot upload", async () => {
    const legacyPath = `${CO}/capture/abc-bill.pdf`;
    mockFrom.mockImplementation(
      tableResults({
        capture_drafts: {
          data: { id: DRAFT, storage_path: legacyPath, status: "pending_review" },
          error: null,
        },
        capture_draft_pages: { data: null, error: null },
      })
    );
    mockDownload.mockResolvedValue({ data: blob([1], "application/octet-stream"), error: null });

    const res = await extractPost(extractRequest({ draftId: DRAFT }));
    expect(res.status).toBe(200);
    expect(mockDownload).toHaveBeenCalledWith(legacyPath);
    // A generic blob type must not be handed to the model as-is — the stored
    // path's extension is the better answer.
    expect(mockAnalyze.mock.calls[0][1]).toBe("application/pdf");
  });

  it("still returns the reading when it could not be saved, and says so", async () => {
    const pagePath = `${CO}/capture/${DRAFT}/page-001.jpg`;
    mockFrom.mockImplementation(
      tableResults({
        capture_drafts: {
          data: { id: DRAFT, storage_path: pagePath, status: "pending_review" },
          error: null,
        },
        capture_draft_pages: { data: { storage_path: pagePath }, error: null },
      })
    );
    mockRpc.mockResolvedValue({ data: null, error: { message: "permission denied" } });

    const res = await extractPost(extractRequest({ draftId: DRAFT }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      draftId: DRAFT,
      extracted: EXTRACTION,
      saved: false,
      error: "permission denied",
    });
  });
});
