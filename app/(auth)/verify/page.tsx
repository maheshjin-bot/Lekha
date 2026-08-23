import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MfaChallengeForm } from "@/components/auth/MfaChallengeForm";

/**
 * The second factor, asked for once per session.
 *
 * Deliberately lives under (auth) rather than (app): the guard in
 * app/(app)/layout.tsx redirects here when a session is aal1 but the account
 * requires aal2, so a page inside that group would redirect to itself forever.
 *
 * The factor lookup happens here on the server rather than in a mount effect,
 * so the page has what it needs on first render and there is no flash of an
 * empty form while a client fetch resolves.
 */
export default async function VerifyPage({ searchParams }: PageProps<"/verify">) {
  const sp = await searchParams;
  const rawNext = typeof sp.next === "string" ? sp.next : "/companies";
  // Only ever return the user to a path on this site. An open redirect on a
  // login-adjacent page is a phishing primitive, and `next` arrives in a URL
  // anyone can hand out.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/companies";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const verified = (factors?.totp ?? []).filter((f) => f.status === "verified");

  // Nothing to challenge — the guard should not have sent anyone here, and
  // sitting on a form that cannot be completed would be a dead end.
  if (verified.length === 0) {
    redirect(next);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <MfaChallengeForm
        factorId={verified[0].id}
        factorName={verified[0].friendly_name || "your authenticator"}
        next={next}
      />
    </main>
  );
}
