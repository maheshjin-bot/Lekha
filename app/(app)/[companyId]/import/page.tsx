import { createClient } from "@/lib/supabase/server";
import { VoucherImport } from "@/components/csv/VoucherImport";

export default async function ImportPage({
  params,
}: PageProps<"/[companyId]/import">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: company }, { data: ledgers }, { data: branches }] =
    await Promise.all([
      supabase
        .from("companies")
        .select("lock_date")
        .eq("id", companyId)
        .maybeSingle(),
      supabase
        .from("ledgers")
        .select("id, name")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("branches")
        .select("id, code, name")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("is_head_office", { ascending: false }),
    ]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Import vouchers</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        One row per line item. Rows sharing a <strong>Voucher Ref</strong> become
        one voucher, so they must agree on the date, type and reference — the
        preview checks that before anything is written.
      </p>

      <VoucherImport
        companyId={companyId}
        ledgers={ledgers ?? []}
        branches={branches ?? []}
        lockDate={company?.lock_date ?? null}
      />
    </main>
  );
}
