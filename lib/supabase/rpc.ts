import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Call an RPC function that isn't in types/database.types.ts yet — see
 * components/settings/TeamManager.tsx's own comment for why 0107's three new
 * functions (get_company_team, create_company_invite, accept_company_invite)
 * can't just be added to that file this session.
 *
 * NOT `(supabase.rpc as unknown as SomeFn)(fn, args)`. That extracts `.rpc`
 * off the client into a bare function reference, which drops supabase-js's
 * internal `this` binding — supabase-js's own `rpc()` reads `this.rest`
 * (its embedded PostgrestClient), so a detached call throws "Cannot read
 * properties of undefined (reading 'rest')" the instant it runs. This is not
 * a hypothetical: it is exactly what happened live, browser-testing the
 * "Send invite" button — the request never left the browser, and the error
 * only appeared as an unhandled promise rejection in the console, not in the
 * UI's own toast. `.call(supabase, ...)` below keeps the binding intact.
 */
export function callRpc<TArgs extends Record<string, unknown>, TData>(
  supabase: SupabaseClient,
  fn: string,
  args: TArgs
): Promise<{ data: TData | null; error: { message: string } | null }> {
  type RpcFn = (fn: string, args: TArgs) => Promise<{
    data: TData | null;
    error: { message: string } | null;
  }>;
  return (supabase.rpc as unknown as RpcFn).call(supabase, fn, args);
}
