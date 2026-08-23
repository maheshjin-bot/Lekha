import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Verifies a company's open-company password and, on success, drops a
 * session cookie the layout checks on the way in (app/(app)/[companyId]
 * /layout.tsx). Verification itself happens in Postgres
 * (verify_company_password) — this route never sees or compares the hash.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;

  let password: string;
  try {
    const body = await request.json();
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    password = "";
  }

  const supabase = await createClient();
  const { data: ok, error } = await supabase.rpc("verify_company_password", {
    p_company_id: companyId,
    p_password: password,
  });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
  if (!ok) {
    return NextResponse.json({ ok: false, error: "Incorrect password" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(`co_unlock_${companyId}`, "1", {
    path: "/",
    sameSite: "lax",
    // No maxAge/expires — a session cookie, cleared when the browser
    // closes. SignOutButton also clears it explicitly on sign-out.
  });
  return response;
}
