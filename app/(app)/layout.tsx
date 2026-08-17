import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth guard for everything under (app). Uses getUser() rather than
 * getSession(): getSession trusts the cookie, getUser verifies it with the
 * auth server, and a guard that trusts an unverified cookie is not a guard.
 */
export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
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

  if (!user) {
    // proxy.ts stamped where they were headed, so the trip through /login can
    // return them to it.
    const pathname = (await headers()).get("x-pathname");
    redirect(pathname ? `/login?next=${encodeURIComponent(pathname)}` : "/login");
  }

  return <>{children}</>;
}
