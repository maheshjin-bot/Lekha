/**
 * verifyMetaSignature (lib/whatsapp/graphApi.ts, migration 0745) is pure and
 * synchronous. downloadWhatsAppMedia/sendWhatsAppTextMessage are covered
 * here against a mocked global fetch — no real network call, and certainly
 * no real Meta credentials, are exercised by this file. See
 * app/api/whatsapp/webhook/route.ts's own header for the honest statement
 * that these functions have never executed against Meta's real servers.
 */
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadWhatsAppMedia, sendWhatsAppTextMessage, verifyMetaSignature } from "@/lib/whatsapp/graphApi";

describe("verifyMetaSignature", () => {
  const secret = "app-secret-for-test";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  function sign(rawBody: string, key: string) {
    return "sha256=" + crypto.createHmac("sha256", key).update(rawBody, "utf8").digest("hex");
  }

  it("accepts a correctly signed body", () => {
    expect(verifyMetaSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    expect(verifyMetaSignature(body, sign(body, "wrong-secret"), secret)).toBe(false);
  });

  it("rejects a signature computed over a different body", () => {
    expect(verifyMetaSignature(body, sign("{}", secret), secret)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyMetaSignature(body, null, secret)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    expect(verifyMetaSignature(body, crypto.createHmac("sha256", secret).update(body).digest("hex"), secret)).toBe(
      false
    );
  });

  it("rejects a malformed/short hex value rather than throwing", () => {
    expect(verifyMetaSignature(body, "sha256=not-valid-hex", secret)).toBe(false);
    expect(verifyMetaSignature(body, "sha256=ab", secret)).toBe(false);
  });
});

describe("downloadWhatsAppMedia", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("performs the documented two-step fetch and returns the bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi
      .fn()
      // Step 1: media metadata lookup
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "https://lookaside.example/media/abc", mime_type: "image/jpeg" }),
      })
      // Step 2: the actual file bytes
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => bytes.buffer,
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadWhatsAppMedia("MEDIA_ID", "test-token");
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.mimeType).toBe("image/jpeg");
      expect(Buffer.compare(result.buffer, Buffer.from(bytes))).toBe(0);
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("MEDIA_ID");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token");
  });

  it("returns an error rather than throwing when the metadata lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "not found" })
    );
    const result = await downloadWhatsAppMedia("MEDIA_ID", "test-token");
    expect("error" in result).toBe(true);
  });

  it("returns an error rather than throwing on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    const result = await downloadWhatsAppMedia("MEDIA_ID", "test-token");
    expect(result).toEqual({ error: "network down" });
  });
});

describe("sendWhatsAppTextMessage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the documented Send Messages payload shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendWhatsAppTextMessage("PHONE_NUMBER_ID", "919876543210", "hello", "test-token");
    expect(result).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("PHONE_NUMBER_ID/messages");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      messaging_product: "whatsapp",
      to: "919876543210",
      type: "text",
      text: { body: "hello" },
    });
  });

  it("returns ok:false rather than throwing on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" }));
    const result = await sendWhatsAppTextMessage("PHONE_NUMBER_ID", "919876543210", "hello", "bad-token");
    expect(result.ok).toBe(false);
  });
});
