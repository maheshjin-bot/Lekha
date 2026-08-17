import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/database.types";

/**
 * Server-side Supabase client for Server Components and Route Handlers.
 *
 * The setAll catch is deliberate: a Server Component cannot write cookies, and
 * it does not need to — proxy.ts already refreshed the session on the way in.
 * Without the catch, every Server Component read would throw.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component render pass — proxy.ts owns the refresh.
          }
        },
      },
    }
  );
}
