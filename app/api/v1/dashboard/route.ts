import { NextRequest, NextResponse } from "next/server";
import { createApiClient } from "@/lib/supabase/api";

// Reads a per-request Authorization header and hits the database on every
// call — must never be statically optimized away.
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/dashboard
 * Authorization: Bearer <api key>
 *
 * Returns the same six KPIs the company dashboard itself shows. See
 * migration 0063 for why this authenticates via a raw key rather than a
 * Supabase Auth session — there is no session for an external caller to have.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const apiKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing API key. Send it as: Authorization: Bearer <key>" },
      { status: 401 }
    );
  }

  const supabase = createApiClient();
  const { data, error } = await supabase.rpc("api_get_dashboard_kpis", { p_api_key: apiKey });

  if (error) {
    // The RPC's own error text is already safe to show the caller — it never
    // distinguishes "no such key" from "revoked key" (see 0063's own
    // comment on authenticate_api_key for why), so there is nothing here to
    // filter before passing it through.
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  return NextResponse.json({ data: data?.[0] ?? null });
}
