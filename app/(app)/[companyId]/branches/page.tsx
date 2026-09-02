import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { BranchesManager } from "@/components/branches/BranchesManager";

export default async function BranchesPage({
  params,
}: PageProps<"/[companyId]/branches">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: branches }, { data: states }] = await Promise.all([
    supabase
      .from("branches")
      .select(
        "id, code, name, state_code, address_line1, address_line2, city, pincode, is_head_office"
      )
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false })
      .order("name"),
    supabase.from("ref_states").select("code, name").order("name"),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Branches</h1>
      <p className="mt-1.5 max-w-xl text-sm text-ink-soft">
        Every place of business this company invoices from. An e-invoice or e-way bill payload
        is built from a branch&rsquo;s own address — set it here before generating either.
      </p>

      <div className="mt-8">
        <BranchesManager companyId={companyId} branches={branches ?? []} states={states ?? []} />
      </div>

      <p className="mt-8 text-xs text-ink-faint">
        Admin only. A branch&rsquo;s code, name and state are set when it&rsquo;s created and
        can&rsquo;t be changed afterwards — the code prefixes every voucher number raised from
        the branch, so changing it would make already-printed numbers lie about what they
        name. A GST registration is attached to a branch under{" "}
        <Link href={`/${companyId}/registrations`} className="underline">
          Registrations
        </Link>
        . Professional tax and labour welfare registrations, also held per branch, live under{" "}
        <Link href={`/${companyId}/settings/employer-registrations`} className="underline">
          Employer registrations
        </Link>
        .
      </p>
    </main>
  );
}
