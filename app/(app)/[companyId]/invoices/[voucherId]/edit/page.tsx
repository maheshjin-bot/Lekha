import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  VoucherScreen,
  type ExistingInvoice,
  type ShipTo,
  type VoucherScreenExisting,
} from "@/components/vouchers/VoucherScreen";
import { Alert } from "@/components/ui/Alert";
import { TRADING_ROLES } from "@/lib/invoices/trading-roles";

const INVOICE_TYPES = ["sales", "purchase", "credit_note", "debit_note"];

export default async function EditInvoicePage({
  params,
}: PageProps<"/[companyId]/invoices/[voucherId]/edit">) {
  const { companyId, voucherId } = await params;
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("vouchers")
    .select(
      "id, voucher_number, voucher_type, voucher_date, narration, reference_number, financial_year_label, branch_id, party_ledger_id, place_of_supply, is_deleted"
    )
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!voucher || !INVOICE_TYPES.includes(voucher.voucher_type)) notFound();

  const [
    { data: items },
    { data: ledgers },
    { data: branches },
    { data: godowns },
    { data: modules },
    { data: states },
    { data: tcsSections },
    { data: voucherItems },
    { data: tradingEntry },
    { data: priceListItemsRaw },
  ] = await Promise.all([
    // Goods and services alike — see invoices/new/page.tsx for why the
    // maintain_stock filter that used to be here had to go with migration
    // 1480 rather than before it. It matters more on this screen than on the
    // new-invoice one: without it an invoice that already carries a charge
    // line would render with that line's item missing from the dropdown, and
    // saving would silently drop the line from a document already issued.
    supabase
      .from("items")
      .select(
        "id, name, uom, sale_rate, purchase_rate, gst_rate_percent, default_tcs_section, item_type, maintain_stock, hsn_sac"
      )
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("ledgers")
      .select(
        "id, name, state_code, pan, address, city, pincode, gstin, gst_registration_type, account_groups(ledger_role)"
      )
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
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
    supabase
      .from("ref_tcs_sections")
      .select("section_code, rate_percent, no_pan_rate_percent, threshold_rupees")
      .eq("is_active", true),
    supabase
      .from("voucher_items")
      .select("item_id, quantity, rate, discount_percent, description, godown_id, line_order")
      .eq("voucher_id", voucherId)
      .order("line_order"),
    // The trading ledger isn't stored on the voucher header — create_invoice
    // only takes it as a posting instruction — so it's recovered from
    // whichever entry landed on an income/expense ledger, the same fact
    // create_invoice itself derived it from at save time.
    supabase
      .from("voucher_entries")
      .select("ledger_id, ledgers(account_groups(ledger_role))")
      .eq("voucher_id", voucherId),
    // See invoices/new/page.tsx — the company's default price list only.
    supabase
      .from("price_list_items")
      .select("item_id, price, effective_from, price_lists!inner(is_default)")
      .eq("company_id", companyId)
      .eq("price_lists.is_default", true),
  ]);

  // The invoice's delivery address, when it has one (public.voucher_ship_to,
  // migration 0805). Fetched after the Promise.all rather than inside it only
  // because voucher_ship_to is brand new and types/database.types.ts — owned
  // by the integration pass — does not know it yet, so it needs the escape
  // hatch below and cannot be destructured with the typed queries. Same
  // convention as components/einvoice/EinvoiceDetailForm.tsx.
  // The invoice's delivery-challan reference (vouchers.challan_number /
  // challan_date, migration 0865). Read separately from the typed voucher
  // query above for the same reason voucher_ship_to is: the two columns are
  // brand new and types/database.types.ts — owned by the integration pass —
  // does not know them yet, so naming them in that select would not typecheck.
  const { data: challanRow } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    .from("vouchers" as any)
    .select("challan_number, challan_date")
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle<{ challan_number: string | null; challan_date: string | null }>();

  // Has this document already been reported to the Invoice Registration
  // Portal? (public.einvoice_details, migration 0230.) If it has, migration
  // 1500 freezes the party, the date, the place of supply and every line —
  // the signed QR printed on the invoice attests those figures, so editing
  // them here would leave the paper contradicting its own IRN. update_invoice
  // refuses the save with the full remedy; this banner says it BEFORE the
  // preparer retypes an invoice they are not allowed to change.
  const { data: einvoice } = await supabase
    .from("einvoice_details")
    .select("irn, ack_date")
    .eq("voucher_id", voucherId)
    .eq("company_id", companyId)
    .not("irn", "is", null)
    .maybeSingle();

  const reportedIrn = einvoice?.irn ?? null;
  // The IRP cancels an IRN only within 24 hours of the acknowledgement, and
  // never amends one. Both halves matter to what this banner should say, so
  // the deadline is computed rather than described vaguely.
  const cancelDeadline = einvoice?.ack_date
    ? new Date(new Date(einvoice.ack_date).getTime() + 24 * 60 * 60 * 1000)
    : null;
  const cancelWindowOpen = cancelDeadline ? cancelDeadline > new Date() : false;
  const deadlineLabel = cancelDeadline
    ? cancelDeadline.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }) + " IST"
    : null;

  const { data: shipToRow } = await supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    .from("voucher_ship_to" as any)
    .select(
      "ship_to_ledger_id, ship_to_name, ship_to_address, ship_to_city, ship_to_state_code, ship_to_pincode, ship_to_gstin"
    )
    .eq("voucher_id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle<{
      ship_to_ledger_id: string | null;
      ship_to_name: string;
      ship_to_address: string;
      ship_to_city: string | null;
      ship_to_state_code: string;
      ship_to_pincode: string | null;
      ship_to_gstin: string | null;
    }>();

  const shipTo: ShipTo | null = shipToRow
    ? {
        ledgerId: shipToRow.ship_to_ledger_id ?? "",
        name: shipToRow.ship_to_name,
        address: shipToRow.ship_to_address,
        city: shipToRow.ship_to_city ?? "",
        stateCode: shipToRow.ship_to_state_code,
        pincode: shipToRow.ship_to_pincode ?? "",
        gstin: shipToRow.ship_to_gstin ?? "",
      }
    : null;

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
    // Only the ship-to disclosure reads these (migration 0805) — a delivery
    // address is prefilled from a party already on file.
    address: l.address,
    city: l.city,
    pincode: l.pincode,
    gstin: l.gstin,
    // See the same field in invoices/new/page.tsx for why.
    gst_registration_type: l.gst_registration_type,
  }));

  const flatBranches = (branches ?? []).map((b) => ({
    id: b.id,
    code: b.code,
    name: b.name,
    registeredState: b.gst_registrations?.state_code ?? null,
  }));

  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);
  const tcsOn = (modules ?? []).some((m) => m.code === "tcs" && m.active);

  // The same role list InvoiceForm's own dropdown filters on, so the two
  // cannot disagree. It used to be a local ["income", "expense"] — and
  // migration 0210 replaced 'expense' with Schedule III's own expense
  // sub-classifications without keeping it, so no group in the database
  // carries that role any more (confirmed live: 0 of 569). Every real purchase
  // entry sits under cost_of_materials. The effect was that opening any
  // purchase bill or debit note for editing found no trading ledger, blanked a
  // `required` select and made the preparer re-pick it from memory — with a
  // wrong pick silently re-posting the whole bill to a different expense head
  // on save.
  const tradingId =
    (tradingEntry ?? []).find((e) =>
      TRADING_ROLES.includes(e.ledgers?.account_groups?.ledger_role ?? "")
    )?.ledger_id ?? "";

  const existingInvoice: ExistingInvoice = {
    id: voucher.id,
    voucherNumber: voucher.voucher_number,
    voucherType: voucher.voucher_type as ExistingInvoice["voucherType"],
    financialYearLabel: voucher.financial_year_label,
    branchId: voucher.branch_id,
    date: voucher.voucher_date,
    partyId: voucher.party_ledger_id ?? "",
    tradingId,
    godownId: voucherItems?.[0]?.godown_id ?? godowns?.[0]?.id ?? "",
    placeOfSupply: voucher.place_of_supply ?? "",
    reference: voucher.reference_number ?? "",
    challanNumber: challanRow?.challan_number ?? "",
    challanDate: challanRow?.challan_date ?? "",
    narration: voucher.narration ?? "",
    lines: (voucherItems ?? []).map((vi) => ({
      itemId: vi.item_id,
      quantity: String(vi.quantity),
      rate: String(vi.rate),
      discountPercent: Number(vi.discount_percent) > 0 ? String(vi.discount_percent) : "",
      description: vi.description ?? "",
    })),
    shipTo,
  };

  // B6 of the Recon contract: an existing invoice is always tagged
  // "item-invoice", never "accounting-invoice" — migration 1480 means a
  // sales/purchase invoice can itself carry service (non-stock) lines too,
  // so "which mode" for an EDIT is really just "item-invoice" always, with
  // per-line stock/non-stock handled inside ItemInvoiceGrid regardless of
  // which type the voucher itself is (sales/purchase/credit_note/debit_note
  // all render through the same grid on this screen). Ctrl+H is hidden for
  // the whole life of an edit either way (isEdit === true), so this tag only
  // ever selects which of ExistingInvoice/ExistingVoucher `data` is.
  const existing: VoucherScreenExisting = { mode: "item-invoice", data: existingInvoice };

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href={`/${companyId}/vouchers/${voucherId}`}
        className="text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
      >
        ← Back to voucher
      </Link>

      <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight text-ink">
        Edit <span className="font-mono">{voucher.voucher_number}</span>
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        Saving replaces every line — the stock movement, GST/TCS and ledger entries are all
        recomputed together, exactly as they would be for a fresh invoice with these figures.
      </p>

      {reportedIrn && !voucher.is_deleted && (
        <Alert tone="warning" className="mt-6 max-w-3xl">
          <span className="font-semibold">
            Reported to the Invoice Registration Portal — the figures are frozen.
          </span>{" "}
          This invoice carries IRN <span className="font-mono">{reportedIrn.slice(0, 12)}…</span>
          {deadlineLabel ? ` (acknowledged, cancellable until ${deadlineLabel})` : ""}. The signed
          QR code printed on it attests the buyer, the date and the value that were reported, so
          the party, the invoice date, the place of supply and the item lines can no longer be
          changed — saving such a change is refused.{" "}
          {cancelWindowOpen ? (
            <>
              Until {deadlineLabel} you may still cancel the IRN on the IRP (cancel any e-way bill
              against it first) and raise a corrected invoice under a fresh number.
            </>
          ) : (
            <>
              The 24-hour cancellation window on the IRP has closed, and an e-invoice can never be
              amended there.
            </>
          )}{" "}
          Otherwise correct it with a credit note or debit note under Sec 34 CGST Act — itself
          reported to the IRP — or in the amendment table of a later GSTR-1. Narration, reference,
          challan and godown can still be corrected here.{" "}
          <Link
            href={`/${companyId}/einvoice/${voucherId}`}
            className="underline underline-offset-4"
          >
            Open the e-invoice record
          </Link>
        </Alert>
      )}

      {voucher.is_deleted ? (
        <p className="mt-8 rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          This voucher has been deleted and can no longer be edited.
        </p>
      ) : (
        <VoucherScreen
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
          existing={existing}
        />
      )}
    </main>
  );
}
