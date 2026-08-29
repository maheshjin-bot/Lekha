import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { InvoiceForm } from "@/components/invoices/InvoiceForm";
import {
  buildNumberingByBranch,
  type NumberingSettingsRow,
} from "@/lib/numbering/voucher-numbering";

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
    // maintain_stock is NOT a presentational preference here, it is exactly
    // the predicate the database enforces on the other side. voucher_items
    // carries a BEFORE INSERT trigger (app_private.enforce_stock_item, 0013)
    // that refuses any item which is not `item_type = 'goods' and
    // maintain_stock` — and items_service_has_no_stock guarantees a service
    // can never have maintain_stock set, so this one filter already selects
    // precisely the set create_invoice will accept. Offering a service here
    // would not make it invoiceable; it would make the save fail after the
    // voucher header had already been numbered. See the quick-add item
    // popup, which blocks the service option for the same reason.
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

  // The numbering policy per voucher type (migration 0725) — fetched here, as
  // a prop, for the same reason every other master on this page is: the form
  // is a client component and must not go looking for its own data.
  //
  // Once per BRANCH, and only after the branch list is known, hence the second
  // wave rather than a slot in the Promise.all above. The mode and the series
  // list are company-scoped and identical across branches, but the preview
  // number is not — {BRANCH} is the commonest token in a prefix and each
  // branch keeps its own counter — and showing a preview for the wrong branch
  // would be worse than showing none. Companies here carry one or two active
  // branches (max 2 across the whole database), so this is one or two parallel
  // calls, not a fan-out.
  //
  // get_voucher_numbering_settings is brand new and types/database.types.ts —
  // owned by the integration pass, not regenerated by this task — does not
  // know it yet, hence the disabled rule below. Same convention as
  // components/einvoice/EinvoiceDetailForm.tsx.
  const numbering = buildNumberingByBranch(
    await Promise.all(
      flatBranches.map(async (b) => {
        const { data } = await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .rpc("get_voucher_numbering_settings" as any, {
            p_company_id: companyId,
            p_branch_id: b.id,
          });
        return [b.id, (data ?? []) as unknown as NumberingSettingsRow[]] as const;
      })
    )
  );

  // Only what the form genuinely cannot get past on its own. A missing item or
  // a missing ledger used to send the preparer away to a master screen and
  // back; both can now be created from inside the form itself, so blocking on
  // them would be refusing to open a door that is already unlocked. A godown
  // and a branch GST registration are different in kind: nothing in this form
  // creates either, and create_invoice raises outright without the
  // registration, so those two still stop the form from rendering.
  const blocked = !godowns?.length
    ? { what: "a godown", href: `/${companyId}`, label: "No godown configured" }
    : gstOn && flatBranches.every((b) => !b.registeredState)
      ? {
          what: "a GST registration attached to a branch",
          href: `/${companyId}/registrations`,
          label: "Attach one",
        }
      : null;

  // Said once, up front, rather than leaving someone on an empty form to
  // wonder whether the screen is broken.
  const emptyMasters = [
    !items?.length ? "items" : null,
    flatLedgers.length < 2 ? "ledgers" : null,
  ].filter(Boolean) as string[];

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
        <>
          {emptyMasters.length > 0 && (
            <p className="mt-6 rounded-lg border border-dashed border-border-strong px-4 py-3 text-sm text-ink-soft">
              This company has no {emptyMasters.join(" and no ")} yet. Use the
              <span className="mx-1 font-medium text-accent">+ New</span>
              links below to create them without leaving this invoice.
            </p>
          )}
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
            numbering={numbering}
          />
        </>
      )}
    </main>
  );
}
