import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { InvoiceForm } from "@/components/invoices/InvoiceForm";

export default async function NewInvoicePage({
  params,
}: PageProps<"/[companyId]/invoices/new">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [
    { data: items },
    { data: ledgers },
    { data: branches },
    { data: godowns },
    { data: modules },
    { data: states },
    { data: tcsSections },
    { data: priceListItemsRaw },
  ] = await Promise.all([
    supabase
      .from("items")
      .select("id, name, uom, sale_rate, purchase_rate, gst_rate_percent, default_tcs_section")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("maintain_stock", true)
      .order("name"),
    supabase
      .from("ledgers")
      .select("id, name, state_code, pan, account_groups(ledger_role)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    // Each branch's registered state, when it has one attached — needed for
    // the client-side intra/inter preview. The server's determination in
    // create_invoice is the one that actually counts.
    supabase
      .from("branches")
      .select("id, code, name, gst_registration_id, gst_registrations(state_code)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false }),
    supabase
      .from("godowns")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_default", { ascending: false }),
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase.from("ref_states").select("code, name").order("name"),
    // TCS rates/thresholds, for the client-side TCS preview — mirrors how
    // ItemManager already sources this table for its own TCS picker.
    supabase
      .from("ref_tcs_sections")
      .select("section_code, rate_percent, no_pan_rate_percent, threshold_rupees")
      .eq("is_active", true),
    // The company's DEFAULT price list only (0147) — InvoiceForm's rate-
    // prefill convenience never has to ask "which list" this way. Every
    // row for every item, not filtered by date here, since the invoice's
    // own date (which the user can still change) decides which effective_
    // from applies — that filtering happens client-side in InvoiceForm.
    supabase
      .from("price_list_items")
      .select("item_id, price, effective_from, price_lists!inner(is_default)")
      .eq("company_id", companyId)
      .eq("price_lists.is_default", true),
  ]);

  const priceListItems = (priceListItemsRaw ?? []).map((p) => ({
    item_id: p.item_id,
    price: Number(p.price),
    effective_from: p.effective_from,
  }));

  const flatLedgers = (ledgers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    ledger_role: l.account_groups?.ledger_role ?? "other",
    state_code: l.state_code,
    pan: l.pan,
  }));

  const flatBranches = (branches ?? []).map((b) => ({
    id: b.id,
    code: b.code,
    name: b.name,
    registeredState: b.gst_registrations?.state_code ?? null,
  }));

  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);
  const tcsOn = (modules ?? []).some((m) => m.code === "tcs" && m.active);

  const blocked =
    !items?.length
      ? { what: "items", href: `/${companyId}/items`, label: "Create an item" }
      : !godowns?.length
        ? { what: "a godown", href: `/${companyId}`, label: "No godown configured" }
        : flatLedgers.length < 2
          ? { what: "ledgers", href: `/${companyId}/ledgers`, label: "Create ledgers" }
          : gstOn && flatBranches.every((b) => !b.registeredState)
            ? {
                what: "a GST registration attached to a branch",
                href: `/${companyId}/registrations`,
                label: "Attach one",
              }
            : null;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">New invoice</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        Item lines drive both effects: the stock moves and the ledger entries are
        posted from the same figures, so the two cannot disagree.
      </p>

      {blocked ? (
        <p className="mt-8 rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          You need {blocked.what} before you can raise an invoice.{" "}
          <Link
            href={blocked.href}
            className="text-accent underline underline-offset-4"
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
          branches={flatBranches}
          godowns={godowns ?? []}
          gstOn={gstOn}
          tcsOn={tcsOn}
          tcsSections={tcsSections ?? []}
          states={states ?? []}
          priceListItems={priceListItems}
        />
      )}
    </main>
  );
}
