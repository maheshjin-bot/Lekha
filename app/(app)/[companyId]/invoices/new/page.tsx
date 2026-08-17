import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { InvoiceForm } from "@/components/invoices/InvoiceForm";

export default async function NewInvoicePage({
  params,
}: PageProps<"/[companyId]/invoices/new">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: items }, { data: ledgers }, { data: branches }, { data: godowns }] =
    await Promise.all([
      supabase
        .from("items")
        .select("id, name, uom, sale_rate, purchase_rate")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .eq("maintain_stock", true)
        .order("name"),
      supabase
        .from("ledgers")
        .select("id, name, account_groups(ledger_role)")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("branches")
        .select("id, code, name")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("is_head_office", { ascending: false }),
      supabase
        .from("godowns")
        .select("id, code, name")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .order("is_default", { ascending: false }),
    ]);

  // The ledger's role lives on its group; flattened here so the form can
  // hard-filter the party side without a second lookup per render.
  const flatLedgers = (ledgers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    ledger_role: l.account_groups?.ledger_role ?? "other",
  }));

  const blocked =
    !items?.length
      ? { what: "items", href: `/${companyId}/items`, label: "Create an item" }
      : !godowns?.length
        ? { what: "a godown", href: `/${companyId}`, label: "No godown configured" }
        : flatLedgers.length < 2
          ? { what: "ledgers", href: `/${companyId}/ledgers`, label: "Create ledgers" }
          : null;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">New invoice</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Item lines drive both effects: the stock moves and the ledger entries are
        posted from the same figures, so the two cannot disagree.
      </p>

      {blocked ? (
        <p className="mt-8 rounded-lg border border-dashed border-zinc-300 px-5 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          You need {blocked.what} before you can raise an invoice.{" "}
          <Link
            href={blocked.href}
            className="text-emerald-800 underline underline-offset-4 dark:text-emerald-400"
          >
            {blocked.label}
          </Link>
          .
        </p>
      ) : (
        <InvoiceForm
          companyId={companyId}
          items={items ?? []}
          ledgers={flatLedgers}
          branches={branches ?? []}
          godowns={godowns ?? []}
        />
      )}
    </main>
  );
}
