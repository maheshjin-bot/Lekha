import { createClient } from "@/lib/supabase/server";
import { ApiKeyManager } from "@/components/settings/ApiKeyManager";

export default async function ApiKeysPage({
  params,
}: PageProps<"/[companyId]/settings/api-keys">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: keys } = await supabase
    .from("api_keys")
    .select("id, name, key_prefix, created_at, last_used_at, revoked_at")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          API keys
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Read-only access to this company&rsquo;s data from your own scripts or
          tools — no Supabase sign-in required, just the key. Currently exposes the
          trial balance and the same dashboard KPIs the Overview page shows.
        </p>
      </header>

      <ApiKeyManager companyId={companyId} keys={keys ?? []} />

      <div className="mt-8 rounded-[14px] border border-border bg-surface p-4 text-sm">
        <h2 className="font-semibold">Using a key</h2>
        <pre className="mt-2 overflow-x-auto rounded-md bg-bg p-3 text-xs">
          {`curl -H "Authorization: Bearer <your key>" \\
  https://<this app's URL>/api/v1/dashboard

curl -H "Authorization: Bearer <your key>" \\
  "https://<this app's URL>/api/v1/trial-balance?from=2026-04-01&to=2027-03-31"`}
        </pre>
        <p className="mt-2 text-xs text-ink-faint">
          A revoked key stops working immediately and cannot be un-revoked — create a
          new one if you still need access. Every request is logged against the key
          (last used date, above), not against your own sign-in.
        </p>
      </div>
    </main>
  );
}
