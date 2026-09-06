import { createClient } from "@/lib/supabase/server";
import { PaymentGatewayConfigManager, type PaymentGatewayConfigRow, type PaymentWebhookEventRow } from "@/components/payments/PaymentGatewayConfigManager";

/**
 * /[companyId]/payment-gateway — register a Razorpay webhook (migration
 * 1420), generate/rotate the secret Razorpay's dashboard needs (shown once),
 * and read the inbox of everything received. A config + log screen, not a
 * live integration — creating a config here does not call Razorpay, create
 * an order, or move money in any way. See app/api/payments/webhook/
 * [companyId]/route.ts and the 1420 migration header for what is and is not
 * built.
 *
 * Not linked from NavRail yet — same "additive, unlinked for now" shape
 * 0745's /whatsapp-numbers page and 0575's /links screen both use; reachable
 * directly at this URL until a separate integration pass adds a link.
 */
export default async function PaymentGatewayPage({
  params,
}: PageProps<"/[companyId]/payment-gateway">) {
  const { companyId } = await params;
  const supabase = await createClient();

  // payment_gateway_configs/payment_webhook_events are brand new (1420) —
  // types/database.types.ts does not know them in this session (no
  // opportunity to regenerate types here). Same untyped-select escape hatch
  // WhatsAppNumbersManager's own page.tsx already uses.
  const [{ data: bankLedgers }, { data: configRows }, { data: eventRows }] = await Promise.all([
    supabase
      .from("ledgers")
      .select("id, name, account_groups!inner(ledger_role)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("account_groups.ledger_role", "cash_bank")
      .order("name"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    (supabase as any).from("payment_gateway_configs")
      .select("id, gateway, settlement_ledger_id, is_active, created_at, updated_at")
      .eq("company_id", companyId)
      .maybeSingle() as Promise<{ data: PaymentGatewayConfigRow | null }>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    (supabase as any).from("payment_webhook_events")
      .select(
        "id, event_type, gateway_payment_id, amount, currency, payer_vpa, payer_contact_masked, signature_verified, status, suggested_reason, created_at"
      )
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(50) as Promise<{ data: PaymentWebhookEventRow[] | null }>,
  ]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Payment gateway (Razorpay)
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          LEKHA never initiates a payment — this only LISTENS for Razorpay&rsquo;s own notification that a
          payment already succeeded, and turns it into an ordinary unmatched bank statement line (exactly
          what a CSV import would produce) plus, when unambiguous, a highlighted suggestion for which
          outstanding invoice it looks like. A human still confirms the match on the{" "}
          <a href={`/${companyId}/reconciliation`} className="text-accent underline underline-offset-2">
            Bank reconciliation
          </a>{" "}
          screen — nothing here posts a voucher or moves money on its own.
        </p>
      </header>

      <PaymentGatewayConfigManager
        companyId={companyId}
        initialConfig={configRows ?? null}
        bankLedgers={(bankLedgers ?? []).map((l) => ({ id: l.id, name: l.name }))}
        eventLog={eventRows ?? []}
      />
    </main>
  );
}
