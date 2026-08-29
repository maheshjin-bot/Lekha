import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { ExternalSignerView, type SignatureRequestByToken } from "@/components/signature-requests/ExternalSignerView";

/**
 * Public, unauthenticated signer link — 0575's answer to the gap 0175
 * itself named: a signer with no LEKHA login has nowhere to click. Lives
 * OUTSIDE both (app) and (auth) route groups on purpose, same reasoning as
 * why (app)/layout.tsx's auth guard exists at all: that guard is what would
 * otherwise redirect a signed-out visitor to /login, which is exactly the
 * wrong outcome here — this signer may never have a LEKHA account at all.
 * proxy.ts's session refresh still runs (its matcher covers this path) but
 * it only refreshes cookies, never redirects (see proxy.ts's own header
 * comment), so an anonymous visit reaches this page untouched.
 *
 * A server component for the same reason app/(app)/invite/[token]/page.tsx
 * is one: one round trip, no loading-spinner flash, and the fetch already
 * runs unauthenticated (this server client has no session cookie for a
 * visitor who was never signed in), so it naturally executes as the same
 * `anon` role get_signature_request_by_token is granted to.
 */
export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createClient();

  const { data, error } = await callRpc<{ p_token: string }, SignatureRequestByToken[]>(
    supabase,
    "get_signature_request_by_token",
    { p_token: token }
  );

  const result = data?.[0];

  if (error || !result) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-xl font-semibold text-ink">Link not found</h1>
        <p className="mt-3 text-sm text-ink-soft">
          This signing link is invalid or no longer active. If you were sent this link recently, ask whoever sent it to
          check the link again or send a fresh one.
        </p>
      </main>
    );
  }

  return <ExternalSignerView token={token} data={result} />;
}
