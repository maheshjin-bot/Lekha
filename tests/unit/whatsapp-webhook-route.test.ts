/**
 * app/api/whatsapp/webhook/route.ts (migration 0745), invoked directly as a
 * plain function — GET/POST Route Handlers are just (Request) => Response,
 * so this exercises the REAL exported handler, not a reimplementation of it.
 *
 * What this does and does not prove, stated plainly (the same honesty this
 * migration's own header insists on elsewhere): this POSTs a payload shaped
 * exactly like Meta's own documented webhook JSON (see
 * tests/unit/whatsapp-webhook-payload.test.ts for the citation) to the real
 * route function. lib/whatsapp/graphApi.ts's network calls and
 * lib/supabase/server.ts's Supabase client are mocked — there is no live
 * WhatsApp Business account, and the 0745 migration this route depends on
 * (receive_whatsapp_inbound_message) has not been applied to any live
 * database in this session (see this task's own final report for why). This
 * is a synthetic-payload test of the route's OWN control flow and call
 * shapes, not a live end-to-end run against Meta or a real database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDownload, mockSend, mockRpcImpl, mockUpload } = vi.hoisted(() => ({
  mockDownload: vi.fn(),
  mockSend: vi.fn(),
  mockRpcImpl: vi.fn(),
  mockUpload: vi.fn(),
}));

vi.mock("@/lib/whatsapp/graphApi", () => ({
  downloadWhatsAppMedia: mockDownload,
  sendWhatsAppTextMessage: mockSend,
  verifyMetaSignature: () => true,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: mockRpcImpl,
    storage: { from: () => ({ upload: mockUpload }) },
  }),
}));

import { GET, POST } from "@/app/api/whatsapp/webhook/route";

// Shaped exactly like Meta's documented "Received Messages" image example —
// see tests/unit/whatsapp-webhook-payload.test.ts for the citation.
const SYNTHETIC_IMAGE_PAYLOAD = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "16505551111", phone_number_id: "123456123" },
            contacts: [{ profile: { name: "Test Vendor" }, wa_id: "16315551181" }],
            messages: [
              {
                from: "16315551181",
                id: "wamid.SYNTHETIC1",
                timestamp: "1699999999",
                type: "image",
                image: { mime_type: "image/jpeg", sha256: "abc123", id: "MEDIA_ID_SYNTHETIC" },
              },
            ],
          },
        },
      ],
    },
  ],
};

function postRequest(body: unknown) {
  return new Request("http://localhost/api/whatsapp/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/whatsapp/webhook (verification handshake)", () => {
  const OLD_ENV = process.env.WHATSAPP_VERIFY_TOKEN;
  afterEach(() => {
    process.env.WHATSAPP_VERIFY_TOKEN = OLD_ENV;
  });

  it("returns 503 when WHATSAPP_VERIFY_TOKEN is not configured", async () => {
    delete process.env.WHATSAPP_VERIFY_TOKEN;
    const res = await GET(new Request("http://localhost/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=123"));
    expect(res.status).toBe(503);
  });

  it("echoes hub.challenge back on a matching verify token, per Meta's documented handshake", async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "my-secret-token";
    const res = await GET(
      new Request("http://localhost/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=my-secret-token&hub.challenge=1158201444")
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
  });

  it("rejects a mismatched verify token", async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "my-secret-token";
    const res = await GET(
      new Request("http://localhost/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1158201444")
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/whatsapp/webhook (inbound message)", () => {
  beforeEach(() => {
    mockDownload.mockReset();
    mockSend.mockReset();
    mockRpcImpl.mockReset();
    mockUpload.mockReset();
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_APP_SECRET;
  });

  it("acknowledges a status-update delivery (no messages array) with processed: 0", async () => {
    const res = await POST(
      postRequest({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "W",
            changes: [
              {
                field: "messages",
                value: { metadata: { phone_number_id: "1" }, statuses: [{ id: "wamid.1", status: "delivered" }] },
              },
            ],
          },
        ],
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, processed: 0 });
    expect(mockRpcImpl).not.toHaveBeenCalled();
  });

  it("receives Meta's notification but cannot download without WHATSAPP_ACCESS_TOKEN", async () => {
    const res = await POST(postRequest(SYNTHETIC_IMAGE_PAYLOAD));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    expect(json.processed).toBe(0);
    expect(json.note).toMatch(/WHATSAPP_ACCESS_TOKEN/);
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockRpcImpl).not.toHaveBeenCalled();
  });

  it("with WHATSAPP_ACCESS_TOKEN configured: downloads, creates a draft, uploads it, and returns the confirm link it would send", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
    mockDownload.mockResolvedValue({ buffer: Buffer.from("fake-image-bytes"), mimeType: "image/jpeg" });
    mockRpcImpl.mockResolvedValue({
      data: [
        {
          draft_id: "11111111-1111-1111-1111-111111111111",
          storage_path: "00000000-0000-0000-0000-000000000000/whatsapp-inbound/11111111-1111-1111-1111-111111111111/media.jpg",
          confirm_token: "synthetic-confirm-token",
        },
      ],
      error: null,
    });
    mockUpload.mockResolvedValue({ error: null });
    mockSend.mockResolvedValue({ ok: true });

    const res = await POST(postRequest(SYNTHETIC_IMAGE_PAYLOAD));
    expect(res.status).toBe(200);
    const json = await res.json();

    // The route actually reached the Graph API download call with the
    // media id Meta's payload named.
    expect(mockDownload).toHaveBeenCalledWith("MEDIA_ID_SYNTHETIC", "test-access-token");

    // receive_whatsapp_inbound_message (0745) was called with exactly the
    // fields the payload and the (unconfigured-in-this-test-env, hence
    // deterministic) vision analyzer produced.
    expect(mockRpcImpl).toHaveBeenCalledTimes(1);
    const [fnName, args] = mockRpcImpl.mock.calls[0];
    expect(fnName).toBe("receive_whatsapp_inbound_message");
    expect(args.p_whatsapp_phone_number_id).toBe("123456123");
    expect(args.p_sender_phone).toBe("16315551181");
    expect(args.p_mime_type).toBe("image/jpeg");
    expect(args.p_extracted_json.configured).toBe(false); // GOOGLE_API_KEY unset in this test env

    // The raw bytes were uploaded to EXACTLY the path the RPC returned.
    expect(mockUpload).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000000/whatsapp-inbound/11111111-1111-1111-1111-111111111111/media.jpg",
      expect.any(Buffer),
      { contentType: "image/jpeg" }
    );

    // The reply is sent from the SAME phone_number_id that received the
    // message, to the original sender, containing a working confirm link.
    expect(mockSend).toHaveBeenCalledWith(
      "123456123",
      "16315551181",
      expect.stringContaining("/whatsapp-confirm/synthetic-confirm-token"),
      "test-access-token"
    );

    expect(json.processed).toBe(1);
    expect(json.results[0]).toMatchObject({ waMessageId: "wamid.SYNTHETIC1", ok: true });
    expect(json.results[0].detail).toContain("/whatsapp-confirm/synthetic-confirm-token");
  });

  it("still creates the draft even when the Graph API reply send fails", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
    mockDownload.mockResolvedValue({ buffer: Buffer.from("bytes"), mimeType: "image/jpeg" });
    mockRpcImpl.mockResolvedValue({
      data: [{ draft_id: "d1", storage_path: "p", confirm_token: "tok" }],
      error: null,
    });
    mockUpload.mockResolvedValue({ error: null });
    mockSend.mockResolvedValue({ ok: false, error: "no real WhatsApp number to send to" });

    const res = await POST(postRequest(SYNTHETIC_IMAGE_PAYLOAD));
    const json = await res.json();
    expect(json.results[0].ok).toBe(true); // the draft/reply-link generation still succeeded
  });

  it("skips an attachment type outside the allow-list without calling the Graph API", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-access-token";
    const res = await POST(
      postRequest({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "W",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "123456123" },
                  messages: [
                    {
                      from: "16315551181",
                      id: "wamid.DOC",
                      type: "document",
                      document: { mime_type: "application/msword", id: "MEDIA_ID_DOC" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
    );
    const json = await res.json();
    expect(json.results[0]).toMatchObject({ ok: false });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const res = await POST(
      new Request("http://localhost/api/whatsapp/webhook", { method: "POST", body: "not json" })
    );
    expect(res.status).toBe(400);
  });
});
