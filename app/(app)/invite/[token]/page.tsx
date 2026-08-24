import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";

type AcceptResult = { company_id: string; company_name: string; role: string };

/**
 * Lives OUTSIDE [companyId] on purpose — the invitee does not know which
 * company invited them until the token tells them, so there is nothing to
 * put in a company-scoped URL. Sits inside (app), not (auth): AppLayout's own
 * auth guard already does exactly what this page needs first (redirect to
 * /login?next=/invite/[token] for a signed-out visitor, who now actually
 * returns here — see LoginForm's own comment for the bug that used to
 * silently drop that), and the second-factor guard runs before this ever
 * does too.
 *
 * A server component, not a client page with a loading spinner: the RPC call
 * is one round trip either way, and this lets the redirect on success happen
 * before anything renders at all, rather than after a flash of "joining…".
 */
export default async function AcceptInvitePage({
  params,
}: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const supabase = await createClient();

  const { data, error } = await callRpc<{ p_token: string }, AcceptResult[]>(
    supabase,
    "accept_company_invite",
    { p_token: token }
  );

  const result = data?.[0];

  if (error || !result) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-xl font-semibold text-ink">Invite not accepted</h1>
        <p className="mt-3 text-sm text-ink-soft">
          {error?.message ??
            "This invite link could not be used."}
        </p>
        <Link
          href="/companies"
          className="mt-6 text-sm text-accent underline underline-offset-2"
        >
          Go to your companies
        </Link>
      </main>
    );
  }

  redirect(`/${result.company_id}`);
}
