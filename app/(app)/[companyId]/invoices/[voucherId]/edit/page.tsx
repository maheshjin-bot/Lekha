import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InvoiceForm, type ExistingInvoice } from "@/components/invoices/InvoiceForm";

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
      .select("item_id, quantity, rate, description, godown_id, line_order")
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
  ]);

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

  const tradingId =
    (tradingEntry ?? []).find((e) =>
      ["income", "expense"].includes(e.ledgers?.account_groups?.ledger_role ?? "")
    )?.ledger_id ?? "";

  const existing: ExistingInvoice = {
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
    narration: voucher.narration ?? "",
    lines: (voucherItems ?? []).map((vi) => ({
      itemId: vi.item_id,
      quantity: String(vi.quantity),
      rate: String(vi.rate),
      description: vi.description ?? "",
    })),
  };

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

      {voucher.is_deleted ? (
        <p className="mt-8 rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          This voucher has been deleted and can no longer be edited.
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
          existing={existing}
        />
      )}
    </main>
  );
}
