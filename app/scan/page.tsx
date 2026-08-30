import { createClient } from "@/lib/supabase/server";
import { ScanApp } from "@/components/scan/ScanApp";
import type { ScanBranch, ScanCompany } from "@/lib/scan/types";

/**
 * The only server-side read the scanner needs: which places may this person
 * send into. Names and codes only — deliberately not `select("*")`, because
 * a company row carries compliance mode, book-beginning date and registration
 * details that have no business being shipped to a godown handset.
 *
 * RLS scopes both queries to the caller's own memberships; there is no
 * company_id filter here because there does not need to be.
 */
export default async function ScanPage() {
  const supabase = await createClient();

  const [{ data: companies, error: companiesError }, { data: branches }] =
    await Promise.all([
      supabase.from("companies").select("id, name").order("name"),
      supabase
        .from("branches")
        .select("id, company_id, code, name")
        .eq("is_active", true)
        .order("name"),
    ]);

  if (companiesError) {
    console.error("[scan] companies query failed:", companiesError.message);
  }

  return (
    <ScanApp
      companies={(companies ?? []) as ScanCompany[]}
      branches={(branches ?? []) as ScanBranch[]}
    />
  );
}
