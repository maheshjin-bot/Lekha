import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { SupportChatWidget } from "@/components/support/SupportChatWidget";

/**
 * Timed getUser() wrapper, kept outside the component. Date.now() is fine
 * here but flagged by react-hooks/purity as render-time impurity if called
 * directly in AppLayout's body — this function isn't component/hook-shaped,
 * so the compiler's purity check doesn't look inside it.
 */
async function getUserTimed(supabase: Awaited<ReturnType<typeof createClient>>) {
  const started = Date.now();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  // Never swallow this. A failed getUser() and a signed-out visitor are
  // indistinguishable at the call site, and treating the first as the second
  // produces a silent redirect loop with nothing in the logs.
  if (error) {
    console.error(
      `[auth] getUser failed after ${Date.now() - started}ms:`,
      error.name,
      error.message,
      (error as { status?: number }).status ?? ""
    );
  }

  return user;
}

/**
 * Auth guard for everything under (app). Uses getUser() rather than
 * getSession(): getSession trusts the cookie, getUser verifies it with the
 * auth server, and a guard that trusts an unverified cookie is not a guard.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
  const user = await getUserTimed(supabase);

  if (!user) {
    // proxy.ts stamped where they were headed, so the trip through /login can
    // return them to it.
    const pathname = (await headers()).get("x-pathname");
    redirect(pathname ? `/login?next=${encodeURIComponent(pathname)}` : "/login");
  }

  // Second factor. This check is what makes enrolment mean anything — without
  // it a user could enrol an authenticator and still reach every page on a
  // password alone, which is worse than not offering MFA at all because it
  // looks like protection.
  //
  // Reading the assurance level from the session is sound HERE specifically:
  // getUser() above verified the token against the auth server, and `aal` is a
  // claim inside that same signed token, so it cannot be raised by editing a
  // cookie. Doing this before getUser() would not be safe.
  //
  // Only redirect when the account HAS a verified factor and this session has
  // not used it (currentLevel aal1, nextLevel aal2). A user with no factor has
  // nextLevel 'aal1' and is untouched, so this cannot lock anyone out of an
  // account they never secured.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.currentLevel === "aal1" && aal.nextLevel === "aal2") {
    const pathname = (await headers()).get("x-pathname");
    redirect(pathname ? `/verify?next=${encodeURIComponent(pathname)}` : "/verify");
  }

  return (
    <>
      {children}
      <SupportChatWidget />
    </>
  );
}
