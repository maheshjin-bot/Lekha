/**
 * extractInboundMedia (lib/whatsapp/webhookPayload.ts, migration 0745) is
 * pure and network-free. Payload shapes below are copied from Meta's own
 * documented webhook payload examples
 * (developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples)
 * — field names and nesting are not invented for this test.
 */
import { describe, expect, it } from "vitest";
import { extractInboundMedia } from "@/lib/whatsapp/webhookPayload";

function envelope(value: unknown, field = "messages") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [{ field, value }],
      },
    ],
  };
}

describe("extractInboundMedia", () => {
  it("extracts an inbound image message", () => {
    const payload = envelope({
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "16505551111", phone_number_id: "123456123" },
      contacts: [{ profile: { name: "Vendor" }, wa_id: "16315551181" }],
      messages: [
        {
          from: "16315551181",
          id: "wamid.ABC",
          timestamp: "1699999999",
          type: "image",
          image: { mime_type: "image/jpeg", sha256: "abc123", id: "MEDIA_ID_1", caption: "August bill" },
        },
      ],
    });

    const result = extractInboundMedia(payload);
    expect(result).toEqual([
      {
        whatsappPhoneNumberId: "123456123",
        senderPhone: "16315551181",
        waMessageId: "wamid.ABC",
        mediaId: "MEDIA_ID_1",
        mimeType: "image/jpeg",
        messageType: "image",
        caption: "August bill",
      },
    ]);
  });

  it("extracts an inbound document message with no caption", () => {
    const payload = envelope({
      metadata: { phone_number_id: "999" },
      messages: [
        {
          from: "919876543210",
          id: "wamid.DOC",
          type: "document",
          document: { mime_type: "application/pdf", id: "MEDIA_ID_2", filename: "bill.pdf" },
        },
      ],
    });

    const result = extractInboundMedia(payload);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      mediaId: "MEDIA_ID_2",
      mimeType: "application/pdf",
      messageType: "document",
      caption: null,
    });
  });

  it("ignores a status-update delivery (no messages array)", () => {
    const payload = envelope({
      metadata: { phone_number_id: "123456123" },
      statuses: [{ id: "wamid.ABC", status: "delivered", timestamp: "1699999999", recipient_id: "16315551181" }],
    });
    expect(extractInboundMedia(payload)).toEqual([]);
  });

  it("ignores non-media message types (text, audio, location, etc.)", () => {
    const payload = envelope({
      metadata: { phone_number_id: "123456123" },
      messages: [
        { from: "1", id: "wamid.1", type: "text", text: { body: "hi" } },
        { from: "1", id: "wamid.2", type: "audio", audio: { id: "M", mime_type: "audio/ogg" } },
        { from: "1", id: "wamid.3", type: "location", location: { latitude: 1, longitude: 2 } },
        { from: "1", id: "wamid.4", type: "sticker", sticker: { id: "M", mime_type: "image/webp" } },
      ],
    });
    expect(extractInboundMedia(payload)).toEqual([]);
  });

  it("ignores a change whose field is not 'messages'", () => {
    const payload = envelope({ some: "template status update" }, "message_template_status_update");
    expect(extractInboundMedia(payload)).toEqual([]);
  });

  it("skips a media message missing an id or mime_type rather than throwing", () => {
    const payload = envelope({
      metadata: { phone_number_id: "123456123" },
      messages: [
        { from: "1", id: "wamid.1", type: "image", image: { mime_type: "image/jpeg" } }, // no id
        { from: "1", id: "wamid.2", type: "image", image: { id: "M" } }, // no mime_type
      ],
    });
    expect(extractInboundMedia(payload)).toEqual([]);
  });

  it("skips a value with no phone_number_id", () => {
    const payload = envelope({
      messages: [{ from: "1", id: "wamid.1", type: "image", image: { id: "M", mime_type: "image/jpeg" } }],
    });
    expect(extractInboundMedia(payload)).toEqual([]);
  });

  it("collects across multiple entries and changes", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "A" },
                messages: [{ from: "1", id: "wamid.1", type: "image", image: { id: "M1", mime_type: "image/png" } }],
              },
            },
          ],
        },
        {
          id: "WABA_2",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "B" },
                messages: [{ from: "2", id: "wamid.2", type: "document", document: { id: "M2", mime_type: "application/pdf" } }],
              },
            },
          ],
        },
      ],
    };
    const result = extractInboundMedia(payload);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.mediaId)).toEqual(["M1", "M2"]);
  });

  it("returns nothing for a non-WhatsApp payload shape, never throwing", () => {
    expect(extractInboundMedia(null)).toEqual([]);
    expect(extractInboundMedia(undefined)).toEqual([]);
    expect(extractInboundMedia("just a string")).toEqual([]);
    expect(extractInboundMedia({})).toEqual([]);
    expect(extractInboundMedia({ object: "page" })).toEqual([]);
    expect(extractInboundMedia({ object: "whatsapp_business_account", entry: "not an array" })).toEqual([]);
  });
});
