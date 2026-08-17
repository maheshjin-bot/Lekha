import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Next.js 16 renamed Middleware to Proxy. Same mechanism, same root-level
 * single-file convention.
 *
 * This refreshes the Supabase session on every request so Server Components
 * always see a non-expired one. It deliberately does NOT enforce auth: route
 * access is checked per-page against the session, and per-row by RLS. Proxy is
 * an optimistic layer, not an authorisation boundary.
 */
function nextWithPathname(request: NextRequest) {
  const headers = new Headers(request.headers);
  // Server Components cannot read the current pathname, so the auth guard in
  // app/(app)/layout.tsx has no way to know where a signed-out visitor was
  // headed. Stamping it here gives it one. Always `set`, never `append` — a
  // client-supplied x-pathname must not be trusted.
  headers.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export async function proxy(request: NextRequest) {
  let supabaseResponse = nextWithPathname(request);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          // Re-derived after the writes above so refreshed session cookies
          // travel on the outgoing request headers too.
          supabaseResponse = nextWithPathname(request);
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Touching auth is what actually performs the refresh and the cookie rewrite
  // above. Do not remove even though the claims are unused here.
  await supabase.auth.getClaims();

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
