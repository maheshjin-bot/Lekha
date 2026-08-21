import { NextRequest, NextResponse } from "next/server";
import { createApiClient } from "@/lib/supabase/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/trial-balance?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Authorization: Bearer <api key>
 *
 * Defaults to the whole of time (1900-01-01 to 2999-12-31) when from/to are
 * omitted, matching how this app's own reports read a company's full
 * history when no period is given — an external caller should not need to
 * already know the company's financial-year start just to get a number.
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

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "1900-01-01";
  const to = url.searchParams.get("to") ?? "2999-12-31";

  const supabase = createApiClient();
  const { data, error } = await supabase.rpc("api_get_trial_balance", {
    p_api_key: apiKey,
    p_from: from,
    p_to: to,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  return NextResponse.json({ data: data ?? [] });
}
