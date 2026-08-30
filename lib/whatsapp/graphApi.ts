import crypto from "node:crypto";

/**
 * Meta WhatsApp Cloud API helpers for app/api/whatsapp/webhook/route.ts
 * (migration 0745).
 *
 * This app has no WhatsApp Business API app, verified phone number, or
 * access token in any environment it has been built in — WHATSAPP_ACCESS_TOKEN
 * and WHATSAPP_APP_SECRET are unset everywhere, confirmed by grepping
 * .env.local before writing this file. Every function below is written
 * against Meta's real, documented Cloud API contract
 * (developers.facebook.com/docs/whatsapp/cloud-api) but has never actually
 * executed a request against Meta's servers. See the webhook route's own
 * header for the full "what's real vs what needs credentials" statement.
 */

// Meta bumps this periodically; unlike Gemini's "-latest" alias there is no
// version-independent name to pin instead. Whoever adds real credentials
// should confirm this is still a supported version at that time.
const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type DownloadedMedia = { buffer: Buffer; mimeType: string } | { error: string };

/**
 * Two-step fetch, per Meta's documented "Download Media" flow: a
 * bearer-authenticated GET on /<MEDIA_ID> returns a short-lived signed `url`
 * field (and the media's own mime_type), then a second bearer-authenticated
 * GET on THAT url returns the raw bytes. Never throws — every failure mode
 * returns `{ error }` so the route can log and skip this one attachment
 * without losing any others in the same webhook delivery.
 */
export async function downloadWhatsAppMedia(mediaId: string, accessToken: string): Promise<DownloadedMedia> {
  try {
    const metaRes = await fetch(`${GRAPH_API_BASE}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!metaRes.ok) {
      return { error: `Media metadata lookup failed: ${metaRes.status} ${await metaRes.text().catch(() => "")}` };
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url) {
      return { error: "Media metadata response had no url field" };
    }

    const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!fileRes.ok) {
      return { error: `Media download failed: ${fileRes.status} ${await fileRes.text().catch(() => "")}` };
    }
    const arrayBuffer = await fileRes.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type ?? "application/octet-stream" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unknown error downloading WhatsApp media" };
  }
}

export type SendResult = { ok: true } | { ok: false; error: string };

/**
 * Sends a plain-text WhatsApp message via Meta's documented "Send Messages"
 * endpoint (POST /<PHONE_NUMBER_ID>/messages). fromPhoneNumberId is always
 * the SAME phone_number_id the inbound webhook reported
 * (value.metadata.phone_number_id) — the business number that RECEIVED the
 * original message is the one that replies, so no separate "which of our
 * numbers do we send from" configuration is needed. Never throws.
 */
export async function sendWhatsAppTextMessage(
  fromPhoneNumberId: string,
  to: string,
  body: string,
  accessToken: string
): Promise<SendResult> {
  try {
    const res = await fetch(`${GRAPH_API_BASE}/${encodeURIComponent(fromPhoneNumberId)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${await res.text().catch(() => "")}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error sending WhatsApp message" };
  }
}

/**
 * Verifies Meta's X-Hub-Signature-256 header against the raw request body,
 * per Meta's documented webhook payload-validation contract
 * (developers.facebook.com/docs/graph-api/webhooks/getting-started —
 * "Validating Payloads"): HMAC-SHA256 of the exact raw body bytes, keyed by
 * the app's App Secret, hex-encoded and prefixed "sha256=". Pure and
 * synchronous — no network — so it is unit-testable without a real Meta
 * request. Returns false (never throws) for a missing/malformed header or a
 * mismatch, including when the two hex strings differ in length (which
 * would otherwise throw inside timingSafeEqual).
 */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return false;
  }
}
