import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/**
 * Minimal, session-free Supabase client for the public API routes
 * (app/api/v1/*). Deliberately NOT the cookie-based SSR client every other
 * server component uses (lib/supabase/server.ts) — a public API request
 * carries no Supabase Auth session at all, only a raw API key in the
 * Authorization header, which the api_get_* RPC functions (0063) validate
 * themselves. This client calls those functions as the anon role, exactly
 * the role an external caller's own request would use, and needs no
 * per-request cookie handling since there is no session to read or refresh.
 */
export function createApiClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
}
