import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { MfaManager } from "@/components/auth/MfaManager";

/**
 * Account security. Deliberately NOT under /[companyId]: a factor belongs to
 * the person, not to a company, and someone who works on six companies should
 * enrol once rather than six times.
 */
export default async function SecurityPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Fetched here rather than in a mount effect so the panel renders with the
  // real state on first paint, and so a change only has to router.refresh().
  const { data: factors } = await supabase.auth.mfa.listFactors();

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Account security
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        Signed in as {user?.email}. These settings cover your own sign-in and follow you across
        every company you have access to.
      </p>

      <section className="mt-8 rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-semibold text-ink">Two-factor authentication</h2>
          <p className="mt-0.5 text-xs text-ink-faint">
            A code from your phone, in addition to your password.
          </p>
        </div>
        <MfaManager initialFactors={factors?.totp ?? []} />
      </section>

      <p className="mt-6 text-xs text-ink-faint">
        Once an authenticator is active you will be asked for a code each time you sign in, and any
        session that has not supplied one cannot reach the app — enrolling genuinely changes what a
        stolen password gets someone, rather than only appearing to. There is no self-service
        recovery: if you lose the device, an administrator of the Supabase project has to remove the
        factor before you can sign in again, so keep a second authenticator or a backup of the setup
        key somewhere safe.
      </p>
      <p className="mt-3 text-xs text-ink-faint">
        Company-level settings — modules, password protection on a company, API keys — live under{" "}
        <Link href="/companies" className="underline">
          each company
        </Link>{" "}
        instead.
      </p>
    </main>
  );
}
