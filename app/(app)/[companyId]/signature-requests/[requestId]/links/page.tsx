import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignerLinksPanel } from "@/components/signature-requests/SignerLinksPanel";

type LinkSigner = Parameters<typeof SignerLinksPanel>[0]["signers"][number];

/**
 * 0575's additive companion screen for the internal side of the external
 * signer link: company members come here to copy (or regenerate) each
 * signer's /sign/[token] URL and see when it was last opened. Deliberately
 * a new, separate page rather than a change to SignatureRequestManager.tsx
 * / its RequestCard — that file is off-limits for this task (see the 0575
 * migration header). No NavRail entry and no link from the request list
 * yet; reachable directly at this URL until a follow-up adds a "Copy link"
 * button into SignerRow itself.
 */
export default async function SignatureRequestLinksPage({
  params,
}: {
  params: Promise<{ companyId: string; requestId: string }>;
}) {
  const { companyId, requestId } = await params;
  const supabase = await createClient();

  const [{ data: request }, { data: signers }] = await Promise.all([
    supabase
      .from("signature_requests")
      .select("id, title, status")
      .eq("company_id", companyId)
      .eq("id", requestId)
      .maybeSingle(),
    supabase
      .from("signature_request_signers")
      .select("id, signer_name, signer_email, sign_order, status, access_token, token_last_used_at")
      .eq("company_id", companyId)
      .eq("request_id", requestId)
      .order("sign_order", { ascending: true }),
  ]);

  if (!request) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-sm text-ink-soft">
          Signature request not found.{" "}
          <Link href={`/${companyId}/signature-requests`} className="text-accent underline underline-offset-2">
            Back to signature requests
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6">
        <Link
          href={`/${companyId}/signature-requests`}
          className="text-xs text-ink-faint underline underline-offset-2"
        >
          Back to signature requests
        </Link>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">Signer links — {request.title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Copy each signer&rsquo;s link and send it to them yourself (email, WhatsApp, however you&rsquo;d reach them) — this
          app has no outbound email/SMS integration to do that for you. Each link works without a LEKHA account and shows
          only that one signer&rsquo;s own document and status.
        </p>
      </header>

      <SignerLinksPanel signers={(signers ?? []) as unknown as LinkSigner[]} />
    </main>
  );
}
