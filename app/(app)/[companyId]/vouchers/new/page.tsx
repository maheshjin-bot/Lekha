import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { VoucherForm } from "@/components/vouchers/VoucherForm";

export default async function NewVoucherPage({
  params,
}: PageProps<"/[companyId]/vouchers/new">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: ledgers }, { data: branches }] = await Promise.all([
    supabase
      .from("ledgers")
      .select("id, name, account_groups(name)")
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

  const flatLedgers = (ledgers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    group_name:
      (l as unknown as { account_groups?: { name: string } }).account_groups?.name ?? null,
  }));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">New voucher</h1>
      <p className="mt-1.5 text-sm text-zinc-600 dark:text-zinc-400">
        Debits and credits must match. The database enforces it too — this is
        just the faster place to find out.
      </p>

      {flatLedgers.length < 2 ? (
        <p className="mt-8 rounded-lg border border-dashed border-zinc-300 px-5 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          You need at least two ledgers before you can post.{" "}
          <Link
            href={`/${companyId}/ledgers`}
            className="text-emerald-800 underline underline-offset-4 dark:text-emerald-400"
          >
            Create some
          </Link>
          .
        </p>
      ) : (
        <VoucherForm
          companyId={companyId}
          ledgers={flatLedgers}
          branches={branches ?? []}
        />
      )}
    </main>
  );
}
