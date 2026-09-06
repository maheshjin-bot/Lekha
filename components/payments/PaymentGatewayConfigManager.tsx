"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { TableContainer, th, td } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { formatINR } from "@/lib/utils/currency";

export type PaymentGatewayConfigRow = {
  id: string;
  gateway: string;
  settlement_ledger_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type PaymentWebhookEventRow = {
  id: string;
  event_type: string;
  gateway_payment_id: string | null;
  amount: number | null;
  currency: string | null;
  payer_vpa: string | null;
  payer_contact_masked: string | null;
  signature_verified: boolean;
  status: "received" | "suggested" | "matched" | "ignored";
  suggested_reason: string | null;
  created_at: string;
};

const STATUS_TONE = {
  received: "neutral",
  suggested: "accent",
  matched: "ok",
  ignored: "bad",
} as const;

/**
 * Config + read-only inbox for payment_gateway_configs / payment_webhook_
 * events (migration 1420). create/rotate go through the two DEFINER RPCs
 * (the raw secret is shown exactly once — mirrors ApiKeyManager). is_active
 * and settlement_ledger_id are plain admin-gated table updates (1420
 * deliberately grants those two non-secret columns directly, so a ledger
 * change or a pause doesn't force a secret rotation nobody asked for).
 */
export function PaymentGatewayConfigManager({
  companyId,
  initialConfig,
  bankLedgers,
  eventLog,
}: {
  companyId: string;
  initialConfig: PaymentGatewayConfigRow | null;
  bankLedgers: { id: string; name: string }[];
  eventLog: PaymentWebhookEventRow[];
}) {
  const router = useRouter();
  const [config, setConfig] = useState(initialConfig);
  const [settlementLedgerId, setSettlementLedgerId] = useState(
    initialConfig?.settlement_ledger_id ?? bankLedgers[0]?.id ?? ""
  );
  const [busy, setBusy] = useState(false);
  // Shown exactly once, right after create/rotate — never persisted, never
  // retrievable again (webhook_secret has no SELECT grant to any client
  // role — see 1420 migration header).
  const [justIssuedSecret, setJustIssuedSecret] = useState<string | null>(null);

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/payments/webhook/${companyId}`
      : `https://<this app's URL>/api/payments/webhook/${companyId}`;

  async function createConfig(e: React.FormEvent) {
    e.preventDefault();
    if (!settlementLedgerId) {
      toast.error("Choose a settlement (bank/cash) ledger first");
      return;
    }
    setBusy(true);
    const { data, error } = await callRpc<
      { p_company_id: string; p_settlement_ledger_id: string; p_gateway: string },
      string
    >(createClient(), "create_payment_gateway_config", {
      p_company_id: companyId,
      p_settlement_ledger_id: settlementLedgerId,
      p_gateway: "razorpay",
    });
    setBusy(false);
    if (error || !data) {
      toast.error(error?.message ?? "Could not create the configuration.");
      return;
    }
    setJustIssuedSecret(data);
    setConfig({
      id: "",
      gateway: "razorpay",
      settlement_ledger_id: settlementLedgerId,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    router.refresh();
  }

  async function rotateSecret() {
    if (!confirm("Rotating issues a new secret and the old one stops working immediately. Continue?")) return;
    setBusy(true);
    const { data, error } = await callRpc<{ p_company_id: string; p_gateway: string }, string>(
      createClient(),
      "rotate_payment_gateway_webhook_secret",
      { p_company_id: companyId, p_gateway: "razorpay" }
    );
    setBusy(false);
    if (error || !data) {
      toast.error(error?.message ?? "Could not rotate the secret.");
      return;
    }
    setJustIssuedSecret(data);
    toast.success("New secret issued — update Razorpay's dashboard with it now.");
    router.refresh();
  }

  async function toggleActive() {
    if (!config) return;
    setBusy(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- payment_gateway_configs predates codegen (1420)
    const { error } = await (createClient() as any)
      .from("payment_gateway_configs")
      .update({ is_active: !config.is_active })
      .eq("company_id", companyId);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setConfig({ ...config, is_active: !config.is_active });
    router.refresh();
  }

  async function saveSettlementLedger() {
    if (!config || settlementLedgerId === config.settlement_ledger_id) return;
    setBusy(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const { error } = await (createClient() as any)
      .from("payment_gateway_configs")
      .update({ settlement_ledger_id: settlementLedgerId })
      .eq("company_id", companyId);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setConfig({ ...config, settlement_ledger_id: settlementLedgerId });
    toast.success("Settlement ledger updated");
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="flex flex-col gap-8">
      {justIssuedSecret && (
        <div className="rounded-[14px] border border-accent bg-accent-soft p-4">
          <p className="text-sm font-semibold text-accent">
            Copy this secret now — LEKHA cannot show it to you again.
          </p>
          <code className="mt-2 block break-all rounded-md bg-surface px-3 py-2 font-mono text-xs">
            {justIssuedSecret}
          </code>
          <p className="mt-2 text-xs text-ink-faint">
            Paste it into Razorpay Dashboard → Settings → Webhooks, alongside the URL below.
          </p>
          <button
            type="button"
            onClick={() => setJustIssuedSecret(null)}
            className="mt-2 text-xs text-ink-soft underline underline-offset-2"
          >
            I&rsquo;ve copied it, dismiss
          </button>
        </div>
      )}

      <section className="rounded-[14px] border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold">Webhook URL</h2>
        <p className="mt-1 text-xs text-ink-faint">
          Paste this into Razorpay Dashboard → Settings → Webhooks as the endpoint, with &ldquo;Active
          Events&rdquo; including at least <code className="font-mono">payment.captured</code>.
        </p>
        <code className="mt-2 block break-all rounded-md bg-bg px-3 py-2 text-xs">{webhookUrl}</code>
      </section>

      {bankLedgers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          No cash or bank ledger exists yet — create one before configuring a gateway.
        </p>
      ) : !config ? (
        <form
          onSubmit={createConfig}
          className="flex flex-wrap items-end gap-3 rounded-[14px] border border-border bg-surface p-4"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Settlement ledger</span>
            <select
              value={settlementLedgerId}
              onChange={(e) => setSettlementLedgerId(e.target.value)}
              className={field}
            >
              {bankLedgers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            Generate webhook secret
          </button>
        </form>
      ) : (
        <section className="rounded-[14px] border border-border bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Razorpay configuration</h2>
              <p className="mt-1 text-xs text-ink-faint">
                {config.is_active ? "Active" : "Deactivated — deliveries will be ignored"}
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={toggleActive}
              className="text-xs text-accent underline underline-offset-2 disabled:opacity-50"
            >
              {config.is_active ? "Deactivate" : "Reactivate"}
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Settlement ledger</span>
              <select
                value={settlementLedgerId}
                onChange={(e) => setSettlementLedgerId(e.target.value)}
                className={field}
              >
                {bankLedgers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            {settlementLedgerId !== config.settlement_ledger_id && (
              <button
                type="button"
                disabled={busy}
                onClick={saveSettlementLedger}
                className="rounded-lg border border-border-strong px-3 py-1.5 text-sm hover:bg-accent-soft disabled:opacity-50"
              >
                Save
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={rotateSecret}
              className="ml-auto rounded-lg border border-border-strong px-3 py-1.5 text-sm hover:bg-accent-soft disabled:opacity-50"
            >
              Rotate secret
            </button>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Received deliveries ({eventLog.length})</h2>
        <TableContainer>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Received</th>
                <th className={th}>Event</th>
                <th className={th}>Payment ID</th>
                <th className={th + " text-right"}>Amount</th>
                <th className={th}>Payer</th>
                <th className={th}>Status</th>
                <th className={th}>Note</th>
              </tr>
            </thead>
            <tbody>
              {eventLog.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-ink-faint">
                    Nothing received yet.
                  </td>
                </tr>
              )}
              {eventLog.map((ev) => (
                <tr key={ev.id} className="border-b border-border last:border-0 align-top">
                  <td className={td + " whitespace-nowrap text-ink-soft"}>
                    {ev.created_at.slice(0, 16).replace("T", " ")}
                  </td>
                  <td className={td + " font-mono text-xs"}>{ev.event_type}</td>
                  <td className={td + " font-mono text-xs text-ink-faint"}>{ev.gateway_payment_id ?? "—"}</td>
                  <td className={td + " text-right tabular-nums font-mono"}>
                    {ev.amount != null ? formatINR(ev.amount, { showZero: true }) : "—"}
                  </td>
                  <td className={td + " text-xs text-ink-soft"}>
                    {ev.payer_vpa ?? ev.payer_contact_masked ?? "—"}
                  </td>
                  <td className={td}>
                    <Badge tone={STATUS_TONE[ev.status]}>{ev.status}</Badge>
                    {!ev.signature_verified && (
                      <span className="ml-1.5 text-[10px] text-error">unverified</span>
                    )}
                  </td>
                  <td className={td + " max-w-[240px] text-xs text-ink-faint"}>{ev.suggested_reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      </section>
    </div>
  );
}
