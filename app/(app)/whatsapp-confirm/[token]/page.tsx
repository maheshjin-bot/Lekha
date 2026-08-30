import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { ConfirmWhatsAppDraftPanel } from "@/components/whatsapp/ConfirmWhatsAppDraftPanel";

type DraftByToken = {
  draft_id: string;
  source: string;
  status: "pending_review" | "confirmed" | "rejected";
  claimed: boolean;
  company_id: string | null;
  company_name: string | null;
  whatsapp_sender_phone: string | null;
  suggested_company_id: string | null;
  suggested_company_name: string | null;
  extracted_json: unknown;
  created_at: string;
};

/**
 * /whatsapp-confirm/[token] — where a real LEKHA team member picks which
 * company a WhatsApp-forwarded bill belongs to (migration 0745).
 *
 * Lives OUTSIDE [companyId] on purpose, same reason as
 * app/(app)/invite/[token]/page.tsx: the visitor does not know which company
 * this belongs to until the token tells them — there is nothing to put in a
 * company-scoped URL yet. Sits inside (app), not (auth), for the exact same
 * reason that file does too: (app)/layout.tsx's own auth guard already
 * redirects a signed-out visitor to /login?next=/whatsapp-confirm/[token]
 * and back, so by the time this component runs, get_capture_draft_by_token
 * (authenticated-only — see migration 0745's own header for why, unlike
 * 0575's anon-granted equivalent) can always be called.
 *
 * A server component for the same reason AcceptInvitePage is one: the RPC
 * call is one round trip either way, so there is no reason to pay for a
 * client-side loading flash first.
 */
export default async function WhatsAppConfirmPage({
  params,
}: PageProps<"/whatsapp-confirm/[token]">) {
  const { token } = await params;
  const supabase = await createClient();

  const { data, error } = await callRpc<{ p_token: string }, DraftByToken[]>(
    supabase,
    "get_capture_draft_by_token",
    { p_token: token }
  );
  const draft = data?.[0];

  if (error || !draft) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-xl font-semibold text-ink">Link not found</h1>
        <p className="mt-3 text-sm text-ink-soft">
          This confirmation link is invalid or no longer active. If you were sent this link recently, ask whoever
          forwarded the bill to send it again.
        </p>
      </main>
    );
  }

  if (draft.status === "rejected") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-xl font-semibold text-ink">Discarded</h1>
        <p className="mt-3 text-sm text-ink-soft">
          This forwarded bill was discarded and is no longer waiting for a company.
        </p>
      </main>
    );
  }

  if (draft.claimed) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-xl font-semibold text-ink">Already claimed</h1>
        <p className="mt-3 text-sm text-ink-soft">
          This bill was already claimed by {draft.company_name ?? "a company"}. If you have access to it, open its
          capture screen to review or post it.
        </p>
        {draft.company_id && (
          <Link
            href={`/${draft.company_id}/capture`}
            className="mt-6 text-sm text-accent underline underline-offset-2"
          >
            Open capture screen
          </Link>
        )}
      </main>
    );
  }

  // Unfiltered on purpose — RLS already scopes `companies` to memberships,
  // same shape app/(app)/companies/page.tsx already relies on.
  const { data: companies } = await supabase.from("companies").select("id, name").order("name");

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Bill forwarded over WhatsApp</h1>
      <p className="mt-2 text-sm text-ink-soft">
        {draft.whatsapp_sender_phone ? `From ${draft.whatsapp_sender_phone}. ` : ""}
        Pick which company this bill belongs to, then review and post it on the next screen — nothing is added to
        any company&rsquo;s books until you do.
      </p>
      <ConfirmWhatsAppDraftPanel
        draftId={draft.draft_id}
        companies={companies ?? []}
        suggestedCompanyId={draft.suggested_company_id}
        suggestedCompanyName={draft.suggested_company_name}
        extraction={draft.extracted_json}
      />
    </main>
  );
}
