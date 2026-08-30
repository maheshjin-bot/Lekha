/**
 * Pure, network-free parsing of Meta's WhatsApp Cloud API webhook payload
 * (app/api/whatsapp/webhook/route.ts, migration 0745). Field names and
 * nesting match Meta's own documented "messages" webhook payload shape —
 * developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 * ("Received Messages", the image/document media-message examples) — not
 * guessed or approximated. A typical inbound image message looks like:
 *
 *   {
 *     "object": "whatsapp_business_account",
 *     "entry": [{
 *       "id": "<WABA_ID>",
 *       "changes": [{
 *         "field": "messages",
 *         "value": {
 *           "messaging_product": "whatsapp",
 *           "metadata": { "display_phone_number": "...", "phone_number_id": "123456" },
 *           "contacts": [{ "profile": { "name": "..." }, "wa_id": "919876543210" }],
 *           "messages": [{
 *             "from": "919876543210",
 *             "id": "wamid.ID",
 *             "timestamp": "1699999999",
 *             "type": "image",
 *             "image": { "mime_type": "image/jpeg", "sha256": "...", "id": "<MEDIA_ID>" }
 *           }]
 *         }
 *       }]
 *     }]
 *   }
 *
 * A "statuses" delivery-receipt payload (sent/delivered/read updates) has
 * the same envelope but no "messages" array — extractInboundMedia correctly
 * returns nothing for it, since it only ever reads value.messages.
 *
 * This module has no knowledge of the database, Storage, or the Graph API —
 * see lib/whatsapp/graphApi.ts and the route itself for everything with a
 * side effect.
 */

export type InboundWhatsAppMedia = {
  whatsappPhoneNumberId: string;
  senderPhone: string;
  waMessageId: string;
  mediaId: string;
  mimeType: string;
  messageType: "image" | "document";
  /** WhatsApp lets a sender attach a short caption to an image/document. */
  caption: string | null;
};

type Json = Record<string, unknown>;

function asObjectArray(v: unknown): Json[] {
  return Array.isArray(v) ? v.filter((x): x is Json => !!x && typeof x === "object") : [];
}

/**
 * Walks entry[].changes[].value (only changes with field === "messages") and
 * returns one InboundWhatsAppMedia per image/document message that actually
 * carries a media id and mime type. Everything else is silently skipped:
 * non-"messages" changes (e.g. field: "message_template_status"),
 * status-update deliveries (a "statuses" array instead of "messages"), and
 * non-media message types (text, location, button, interactive, audio,
 * video, sticker, reaction, contacts, order, system, unknown/unsupported).
 * This app only ever turns a forwarded image or document into a capture
 * draft — see migration 0745's header for why voice notes and videos are
 * out of scope.
 */
export function extractInboundMedia(payload: unknown): InboundWhatsAppMedia[] {
  if (!payload || typeof payload !== "object") return [];
  const body = payload as Json;
  if (body.object !== "whatsapp_business_account") return [];

  const results: InboundWhatsAppMedia[] = [];

  for (const entry of asObjectArray(body.entry)) {
    for (const change of asObjectArray(entry.changes)) {
      if (change.field !== "messages") continue;
      const value = change.value;
      if (!value || typeof value !== "object") continue;
      const v = value as Json;

      const metadata = v.metadata;
      const phoneNumberId =
        metadata && typeof metadata === "object" && typeof (metadata as Json).phone_number_id === "string"
          ? ((metadata as Json).phone_number_id as string)
          : null;
      if (!phoneNumberId) continue;

      for (const message of asObjectArray(v.messages)) {
        const type = message.type;
        const from = typeof message.from === "string" ? message.from : null;
        const waMessageId = typeof message.id === "string" ? message.id : null;
        if (!from || !waMessageId) continue;
        if (type !== "image" && type !== "document") continue;

        const media = message[type];
        if (!media || typeof media !== "object") continue;
        const m = media as Json;
        const mediaId = typeof m.id === "string" ? m.id : null;
        const mimeType = typeof m.mime_type === "string" ? m.mime_type : null;
        if (!mediaId || !mimeType) continue;

        results.push({
          whatsappPhoneNumberId: phoneNumberId,
          senderPhone: from,
          waMessageId,
          mediaId,
          mimeType,
          messageType: type,
          caption: typeof m.caption === "string" ? m.caption : null,
        });
      }
    }
  }

  return results;
}
