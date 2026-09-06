import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { redactContext } from "@/lib/errors/redact";
import { fromPaise } from "@/lib/utils/currency";
import { logError } from "@/lib/errors/logError";

export const dynamic = "force-dynamic";

/**
 * Razorpay payment webhook receiver (migration 1420) — inbound reconciliation
 * only. See that migration's header for the full design and its two
 * deliberate deviations from the original survey scope. This route is one
 * URL per company (unlike app/api/whatsapp/webhook/route.ts, which is one
 * URL for every company): Razorpay's own webhook setup is per-account, so
 * the company is already known from the path, and there is no "suggested
 * company" ambiguity to resolve the way 0745's WhatsApp receiver has to.
 *
 * ============================================================================
 * WHAT IS REAL HERE VS WHAT NEEDS CREDENTIALS THIS APP DOES NOT HAVE
 * ============================================================================
 * No Razorpay account or credential exists anywhere in this environment —
 * confirmed by grep before 1420 existed. That is the identical "genuine
 * external-credential gate" category 0745 names for WhatsApp.
 *
 * REAL, and exercised by this migration's own hand-built synthetic-payload
 * test (a JSON body shaped exactly like Razorpay's documented payment.entity
 * payload, with its signature computed independently by openssl to cross-
 * check Postgres's own extensions.hmac — see 1420's report for the exact
 * numbers):
 *   - X-Razorpay-Signature verification: Razorpay's documented HMAC-SHA256-
 *     hex-of-the-raw-body contract (app_private.verify_payment_webhook_
 *     signature, 1420).
 *   - x-razorpay-event-id-based redelivery dedup.
 *   - receive_payment_webhook_event (1420) actually creates a real,
 *     RLS-protected payment_webhook_events row and, for a verified
 *     payment.captured event, a real bank_statement_lines row plus (when
 *     unambiguous) a suggested invoice match.
 *
 * NOT REAL, and cannot be, without a credential this app does not have: no
 * real Razorpay account has ever signed a request against this route. Do not
 * point a real Razorpay webhook at this URL without first registering a
 * gateway config at /[companyId]/payment-gateway (which mints the secret
 * Razorpay's dashboard needs) and confirming this app is reachable from the
 * public internet.
 */

type RazorpayEntity = {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  captured?: boolean;
  vpa?: string | null;
  contact?: string | null;
  email?: string | null;
  notes?: Record<string, unknown>;
  created_at?: number;
};

type RazorpayWebhookPayload = {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayEntity };
    order?: { entity?: RazorpayEntity };
    refund?: { entity?: RazorpayEntity };
  };
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature");
  // Razorpay's own documented redelivery-dedup header (WebSearch-confirmed,
  // see 1420 migration header) — "unique per event". A synthetic fallback
  // ('<payment_id>:<event_type>') is computed server-side by
  // receive_payment_webhook_event itself when this header is absent.
  const eventIdHeader = request.headers.get("x-razorpay-event-id");

  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const entity: RazorpayEntity | undefined =
    payload.payload?.payment?.entity ?? payload.payload?.order?.entity ?? payload.payload?.refund?.entity;

  const eventType = payload.event ?? "unknown";
  const amountRupees = typeof entity?.amount === "number" ? fromPaise(entity.amount) : null;
  const occurredAt =
    typeof entity?.created_at === "number" ? new Date(entity.created_at * 1000).toISOString() : null;

  // Redacted BEFORE it ever reaches Postgres — reuses the exact module
  // lib/errors/redact.ts already uses for error_log, rather than a second
  // SQL-side redaction engine. See 1420 migration header for why this
  // happens here, in the route, and not inside the anon-granted RPC.
  const redactedPayload = redactContext(payload) as Record<string, unknown>;

  const supabase = await createClient();

  const { data: rows, error } = await callRpc<
    {
      p_company_id: string;
      p_gateway: string;
      p_event_type: string;
      p_gateway_event_id: string | null;
      p_gateway_payment_id: string | null;
      p_amount: number | null;
      p_currency: string | null;
      p_payer_vpa: string | null;
      p_payer_contact: string | null;
      p_notes: unknown;
      p_raw_payload: unknown;
      p_signature: string | null;
      p_raw_body: string;
      p_occurred_at: string | null;
    },
    { event_id: string; status: string; signature_verified: boolean; bank_statement_line_id: string | null }[]
  >(supabase, "receive_payment_webhook_event", {
    p_company_id: companyId,
    p_gateway: "razorpay",
    p_event_type: eventType,
    p_gateway_event_id: eventIdHeader,
    p_gateway_payment_id: entity?.id ?? null,
    p_amount: amountRupees,
    p_currency: entity?.currency ?? null,
    p_payer_vpa: entity?.vpa ?? null,
    p_payer_contact: entity?.contact ?? null,
    p_notes: entity?.notes ?? {},
    p_raw_payload: redactedPayload,
    p_signature: signature,
    p_raw_body: rawBody,
    p_occurred_at: occurredAt,
  });

  const row = rows?.[0];

  if (error || !row) {
    console.error("[payments/webhook] receive_payment_webhook_event failed", error?.message);
    // No Supabase session on a real gateway delivery — global:true, the same
    // narrow anon-reachable path 0745's route uses for the identical reason.
    await logError({
      global: true,
      operation: "payment_webhook",
      message: "A payment gateway notification arrived but could not be recorded.",
      detail: error?.message ?? "receive_payment_webhook_event returned no row",
      context: { company_id: companyId, event_type: eventType },
    });
    return NextResponse.json({ error: "Could not process this delivery" }, { status: 400 });
  }

  if (!row.signature_verified) {
    // Same discipline as 0745's route: a bad signature gets a fast 401, not
    // a 200 that would tell Razorpay the delivery succeeded.
    console.warn(`[payments/webhook] rejected delivery for company ${companyId}: signature did not verify`);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  return NextResponse.json({
    received: true,
    status: row.status,
    bank_statement_line_created: row.bank_statement_line_id !== null,
  });
}
