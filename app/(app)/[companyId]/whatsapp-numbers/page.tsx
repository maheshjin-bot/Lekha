import { createClient } from "@/lib/supabase/server";
import { WhatsAppNumbersManager, type WhatsAppNumberRow } from "@/components/whatsapp/WhatsAppNumbersManager";

/**
 * /[companyId]/whatsapp-numbers — register which of a company's WhatsApp
 * Business phone_number_id(s) should SUGGEST this company on the
 * /whatsapp-confirm/[token] screen (migration 0745). A config screen, not a
 * live integration — see the migration header's "SUGGESTION, NEVER
 * AUTHORITY" section for why registering a number here never assigns a
 * forwarded bill to this company automatically.
 *
 * Not linked from NavRail yet — nav wiring for this whole batch of features
 * is centralised in a separate integration pass (see AGENTS.md task brief);
 * reachable directly at this URL until that pass adds a link, the same
 * "additive, unlinked for now" shape 0575's own /links screen used.
 */
export default async function WhatsAppNumbersPage({
  params,
}: PageProps<"/[companyId]/whatsapp-numbers">) {
  const { companyId } = await params;
  const supabase = await createClient();

  // whatsapp_inbound_numbers is brand new (0745) — types/database.types.ts
  // does not know it in this session (no live DB connection was available
  // to regenerate it here; see this task's own final report). Same escape
  // hatch InvoiceForm's page already uses for get_voucher_numbering_settings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  const { data } = await (supabase as any)
    .from("whatsapp_inbound_numbers")
    .select("id, whatsapp_phone_number_id, display_phone_number, is_active, created_at")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">WhatsApp inbound numbers</h1>
      <p className="mt-1.5 max-w-xl text-sm text-ink-soft">
        Register the phone_number_id of a WhatsApp Business number you plan to forward supplier bills from
        (Meta&rsquo;s own identifier for that number — found in your WhatsApp Business API app&rsquo;s settings, not
        the phone number itself). This app has no WhatsApp Business API app or access token of its own, so this
        does not subscribe, verify, or contact WhatsApp in any way — see /api/whatsapp/webhook for what is and is
        not built. Registering a number here only makes this company the SUGGESTED (not automatic) match on the
        confirm screen a person still has to open and accept.
      </p>
      <WhatsAppNumbersManager companyId={companyId} initialRows={(data ?? []) as WhatsAppNumberRow[]} />
    </main>
  );
}
