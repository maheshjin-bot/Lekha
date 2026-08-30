import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { analyzeCaptureImage } from "@/lib/capture/analyze";
import { extractInboundMedia } from "@/lib/whatsapp/webhookPayload";
import { downloadWhatsAppMedia, sendWhatsAppTextMessage, verifyMetaSignature } from "@/lib/whatsapp/graphApi";
import { logError } from "@/lib/errors/logError";

export const dynamic = "force-dynamic";

/**
 * WhatsApp bill forwarding — the receiving half (migration 0745, fast-follow
 * on 0740's OCR/vision capture).
 *
 * ============================================================================
 * WHAT IS REAL HERE VS WHAT NEEDS CREDENTIALS THIS APP DOES NOT HAVE
 * ============================================================================
 * This app has no WhatsApp Business API app, no verified business phone
 * number, and no access token — confirmed by grep before this file existed:
 * zero real WhatsApp integration hits anywhere in this repo before migration
 * 0745. That is a genuine external-credential gate, the same category as
 * GSTN/TRACES/ICEGATE elsewhere in this codebase, and it cannot be closed
 * from inside this session.
 *
 * REAL, and exercised by this session's own synthetic-payload test (a
 * hand-built JSON body shaped exactly like Meta's documented webhook
 * payload, POSTed to this route directly — see this migration's own report
 * for the exact request/response captured):
 *   - The GET handshake below: reads hub.mode/hub.verify_token/hub.challenge
 *     exactly as Meta's webhook-setup UI sends them, and returns hub.challenge
 *     verbatim on a match — this is precisely what Meta calls once, when a
 *     developer first points a webhook URL at this endpoint.
 *   - The POST payload parser (lib/whatsapp/webhookPayload.ts,
 *     extractInboundMedia): walks entry[].changes[].value.messages exactly as
 *     Meta's own "Received Messages" payload-example documents it, and
 *     correctly ignores status-update deliveries and non-media message types.
 *   - The X-Hub-Signature-256 verification (lib/whatsapp/graphApi.ts,
 *     verifyMetaSignature): Meta's documented HMAC-SHA256-of-the-raw-body
 *     contract, gated on WHATSAPP_APP_SECRET.
 *   - receive_whatsapp_inbound_message (0745) actually creates a real,
 *     RLS-protected, unclaimed capture_drafts row and a real confirm_token.
 *
 * NOT REAL, and CANNOT be, without credentials this app does not have:
 *   - downloadWhatsAppMedia/sendWhatsAppTextMessage (lib/whatsapp/graphApi.ts)
 *     are written against Meta's real, documented Graph API endpoints but
 *     have never executed against Meta's servers — there is no
 *     WHATSAPP_ACCESS_TOKEN anywhere in this environment to authenticate
 *     with. Without it, this route cannot download a real attachment at all
 *     (see the early-return below) — it can receive Meta's notification
 *     that SOMETHING arrived, but not the bytes themselves.
 *   - No real WhatsApp message has ever been sent by sendWhatsAppTextMessage.
 *     When it would be called, this route logs and RETURNS the confirm link
 *     it would have sent (see the loop below) rather than pretending
 *     delivery happened.
 *   - No real Meta app has ever called this route's GET or POST handler.
 *
 * Env vars, all optional and all gracefully-missing (same pattern as
 * GOOGLE_API_KEY elsewhere in this app — never a hard crash):
 *   WHATSAPP_VERIFY_TOKEN  — a secret THIS APP chooses and enters into Meta's
 *                            webhook-setup UI; the GET handshake below checks
 *                            the inbound hub.verify_token against it.
 *   WHATSAPP_APP_SECRET    — the Meta app's own secret, used only to verify
 *                            X-Hub-Signature-256. If unset, verification is
 *                            skipped (logged), not silently bypassed.
 *   WHATSAPP_ACCESS_TOKEN  — bearer token for the Graph API (media download
 *                            AND sending a reply). If unset, this route
 *                            cannot process any attachment at all.
 */

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

/**
 * GET — Meta's webhook verification handshake
 * (developers.facebook.com/docs/graph-api/webhooks/getting-started):
 * ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=... . Reply with
 * hub.challenge, verbatim, as plain text, only if the token matches.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) {
    return new Response(
      "WhatsApp webhook isn't configured on this server yet (missing WHATSAPP_VERIFY_TOKEN).",
      { status: 503 }
    );
  }

  if (mode === "subscribe" && challenge && token === verifyToken) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Verification failed", { status: 403 });
}

/**
 * POST — an inbound message notification. Always returns 200 quickly for
 * anything it recognises as a well-formed webhook delivery, even one it
 * takes no action on (a status update, a non-media message, missing
 * credentials) — Meta retries a delivery that doesn't get a fast 2xx, and
 * "we saw it but didn't act on it" is not an error condition.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (appSecret) {
    const signature = request.headers.get("x-hub-signature-256");
    if (!verifyMetaSignature(rawBody, signature, appSecret)) {
      console.warn("[whatsapp/webhook] rejected: X-Hub-Signature-256 did not match");
      // `global: true` throughout this file: an inbound Meta delivery carries
      // no Supabase session, so these go through log_error_global (the narrow
      // anon-reachable RPC, migration 0950). Note what that costs — a row
      // with neither a company nor a user is deliberately visible to NOBODY
      // on the /error-log screen; it exists for whoever runs the server. The
      // rawBody is NOT logged: it is unauthenticated third-party content and
      // an attacker could otherwise choose what gets written into this table.
      await logError({
        global: true,
        operation: "whatsapp_webhook",
        severity: "warning",
        message: "A WhatsApp delivery was rejected because its signature did not match.",
        detail: "X-Hub-Signature-256 did not verify against WHATSAPP_APP_SECRET. The payload was discarded unread.",
        context: { signature_present: Boolean(signature) },
      });
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else {
    console.warn(
      "[whatsapp/webhook] WHATSAPP_APP_SECRET is not set — skipping payload signature verification. Set it once a real Meta app exists."
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const mediaMessages = extractInboundMedia(payload);
  if (mediaMessages.length === 0) {
    // Most deliveries are status updates or message types this app doesn't
    // act on — not an error.
    return NextResponse.json({ received: true, processed: 0 });
  }

  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) {
    console.warn(
      `[whatsapp/webhook] received ${mediaMessages.length} attachment notification(s) but WHATSAPP_ACCESS_TOKEN is not set — cannot call the Graph API to download them. Nothing was captured.`
    );
    await logError({
      global: true,
      operation: "whatsapp_webhook",
      severity: "warning",
      message: "A bill was forwarded over WhatsApp but could not be collected — WhatsApp is not switched on for this server.",
      detail:
        "WHATSAPP_ACCESS_TOKEN is not set, so the Graph API call that downloads the attachment could not be made. " +
        `${mediaMessages.length} attachment notification(s) were received and discarded.`,
      context: { attachments: mediaMessages.length, reason: "missing_env" },
    });
    return NextResponse.json({
      received: true,
      processed: 0,
      note: "WHATSAPP_ACCESS_TOKEN not configured — attachment metadata was received but the file itself could not be downloaded.",
    });
  }

  // Anon-context on purpose — a webhook has no Supabase session, exactly
  // like receive_whatsapp_inbound_message (0745) expects.
  const supabase = await createClient();
  const origin = new URL(request.url).origin;

  const results: Array<{ waMessageId: string; ok: boolean; detail: string }> = [];

  for (const msg of mediaMessages) {
    if (!ALLOWED_MIME.includes(msg.mimeType)) {
      const detail = `Unsupported attachment type: ${msg.mimeType}`;
      console.warn(`[whatsapp/webhook] ${detail}`);
      results.push({ waMessageId: msg.waMessageId, ok: false, detail });
      continue;
    }

    const media = await downloadWhatsAppMedia(msg.mediaId, accessToken);
    if ("error" in media) {
      console.error("[whatsapp/webhook] media download failed", media.error);
      // media.error is Meta's own text and can quote the request back — the
      // Graph API takes its access token as a bearer header and sometimes as
      // a query parameter, so this string is exactly the kind that carries a
      // live credential. logError redacts before storing.
      await logError({
        global: true,
        operation: "whatsapp_webhook",
        message: "A bill forwarded over WhatsApp could not be downloaded.",
        detail: media.error,
        context: { media_id: msg.mediaId, mime_type: msg.mimeType },
      });
      results.push({ waMessageId: msg.waMessageId, ok: false, detail: media.error });
      continue;
    }

    // Same shared analyzer the 'upload' path (0740) uses — never a second
    // implementation of the vision call.
    const extracted = await analyzeCaptureImage(media.buffer, media.mimeType);

    // receive_whatsapp_inbound_message / capture_drafts are brand new
    // (0745/0740) — types/database.types.ts does not know them in this
    // session (no live DB connection was available to regenerate it here;
    // see this task's own final report). Same untyped-RPC escape hatch the
    // sibling capture feature already uses.
    const { data: created, error: rpcError } = await callRpc<
      {
        p_whatsapp_phone_number_id: string;
        p_sender_phone: string;
        p_mime_type: string;
        p_extracted_json: unknown;
      },
      { draft_id: string; storage_path: string; confirm_token: string }[]
    >(supabase, "receive_whatsapp_inbound_message", {
      p_whatsapp_phone_number_id: msg.whatsappPhoneNumberId,
      p_sender_phone: msg.senderPhone,
      p_mime_type: media.mimeType,
      p_extracted_json: extracted,
    });

    const row = created?.[0];
    if (rpcError || !row) {
      console.error("[whatsapp/webhook] receive_whatsapp_inbound_message failed", rpcError?.message);
      await logError({
        global: true,
        operation: "whatsapp_webhook",
        message: "A bill arrived over WhatsApp but could not be saved as a draft.",
        detail: rpcError?.message ?? "receive_whatsapp_inbound_message returned no row",
        context: { step: "receive_whatsapp_inbound_message", mime_type: media.mimeType },
      });
      results.push({
        waMessageId: msg.waMessageId,
        ok: false,
        detail: rpcError?.message ?? "receive_whatsapp_inbound_message returned no row",
      });
      continue;
    }

    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(row.storage_path, media.buffer, { contentType: media.mimeType });
    if (uploadError) {
      // The draft row already exists at this point (see 0745 migration
      // header, "DELIBERATELY NOT DONE" — no compensating cleanup for this
      // narrow failure window) — flagged loudly rather than silently.
      console.error("[whatsapp/webhook] storage upload failed after draft was created", uploadError.message);
      // Critical rather than error: the draft row exists but its file does
      // not, so someone will open a capture draft that shows nothing and has
      // no way to find out why. 0745's own header records that there is
      // deliberately no compensating cleanup for this window; this at least
      // makes the window visible instead of silent.
      await logError({
        global: true,
        operation: "whatsapp_webhook",
        severity: "error",
        message: "A bill arrived over WhatsApp and a draft was created, but the file itself could not be stored.",
        detail: `Draft ${row.draft_id} exists with no file behind it: ${uploadError.message}`,
        context: { step: "storage_upload", draft_id: row.draft_id },
      });
      results.push({
        waMessageId: msg.waMessageId,
        ok: false,
        detail: `Draft ${row.draft_id} was created but the file upload failed: ${uploadError.message}`,
      });
      continue;
    }

    const confirmLink = `${origin}/whatsapp-confirm/${row.confirm_token}`;
    const replyText = `LEKHA received your bill. Sign in and open this link to confirm which company it belongs to: ${confirmLink}`;

    const sendResult = await sendWhatsAppTextMessage(msg.whatsappPhoneNumberId, msg.senderPhone, replyText, accessToken);
    if (!sendResult.ok) {
      // The draft exists regardless of whether the reply could be sent — a
      // failed/impossible reply never blocks capture. Logged, not thrown.
      console.warn(
        `[whatsapp/webhook] would reply to ${msg.senderPhone} with: "${replyText}" — send failed: ${sendResult.error}`
      );
      // The draft exists either way — a failed reply never blocks capture —
      // but the sender is now waiting for a confirmation link that will never
      // arrive, which is worth a record. The phone number and the confirm
      // link are both deliberately left out of the stored text: the link is a
      // bearer token, and the number belongs to a third party.
      await logError({
        global: true,
        operation: "whatsapp_webhook",
        severity: "warning",
        message: "A bill was captured from WhatsApp, but the confirmation reply could not be sent back.",
        detail: sendResult.error,
        context: { step: "send_reply" },
      });
    }

    results.push({ waMessageId: msg.waMessageId, ok: true, detail: confirmLink });
  }

  return NextResponse.json({ received: true, processed: results.length, results });
}
