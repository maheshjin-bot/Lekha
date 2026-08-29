import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/invoices/PrintButton";
import { DownloadPdfButton } from "@/components/invoices/DownloadPdfButton";
import { resolveLogoDataUri } from "@/lib/server/printAssets";
import { VoucherDocument } from "@/components/vouchers/VoucherDocument";
import { isGstDocument, printPageCss } from "@/lib/invoice/taxInvoice";
import {
  buildVoucherDoc,
  type RawCompany,
  type RawShipTo,
  type RawEinvoice,
} from "@/lib/invoice/buildVoucherDoc";

/**
 * The printable document for one voucher — and, for the four voucher types
 * that are GST documents, a CGST Rule 46 compliant tax invoice.
 *
 * THIS PAGE IS ALSO THE PDF. app/api/companies/[companyId]/vouchers/
 * [voucherId]/print-pdf drives a real headless Chromium over this very URL
 * and captures what it renders — deliberately, so that there is one layout
 * rather than two that drift apart. Two consequences worth stating because
 * they are easy to forget when editing this file:
 *   - Anything added here appears in the PDF for free, and anything that
 *     only works on screen breaks the PDF silently. The print-only rules
 *     that make a long invoice paginate instead of clipping live in
 *     printPageCss (lib/invoice/taxInvoice.ts), where the verification
 *     harness can render with byte-identical rules.
 *   - The QR codes and the logo must be present in the FIRST HTML response.
 *     They are: this is a Server Component, both QR encoders are pure
 *     functions with no browser API, and the logo is resolved to a data:
 *     URI rather than a signed URL that could expire mid-render (see
 *     lib/server/printAssets.ts).
 *
 * This file's job is deliberately only three things: fetch, build, render.
 * Every decision about what the document SAYS — which tax lands in which
 * rate bucket, whether a journal grows an invoice block, whether Rule 48
 * copy markings are suppressed by an IRN — lives in
 * lib/invoice/buildVoucherDoc.ts and lib/invoice/taxInvoice.ts, which are
 * pure and therefore verifiable without a browser or a session.
 *
 * PARTICULARS THIS DATABASE GENUINELY CANNOT SUPPLY, PRINTED AS NOTHING
 * RATHER THAN INVENTED:
 *   - The name of the country of destination on an export invoice (first
 *     proviso to Rule 46). public.ledgers has no country column at all, so
 *     there is no value to read. The endorsement and the recipient's address
 *     print; the country does not.
 *   - The IRP's signed QR (Rule 46(r)) whenever einvoice_details holds an
 *     IRN but no signed_qr_payload. The IRN and acknowledgement print, and
 *     the document says the QR is not on record. A QR generated from
 *     anything other than the IRP's own JWS would scan, and be wrong, which
 *     is strictly worse than absent.
 */
export default async function PrintVoucherPage({
  params,
}: PageProps<"/[companyId]/vouchers/[voucherId]/print">) {
  const { companyId, voucherId } = await params;
  const supabase = await createClient();

  const { data: voucher } = await supabase
    .from("vouchers")
    .select(
      "id, voucher_number, voucher_type, voucher_date, narration, reference_number, reference_date, total_amount, party_ledger_id, branch_id, place_of_supply, supply_type, txn_currency, exchange_rate"
    )
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (!voucher) notFound();

  const isGst = isGstDocument(voucher.voucher_type);

  const [
    { data: items },
    { data: party },
    { data: branch },
    { data: taxMap },
    { data: states },
    { data: entries },
    { data: outstandingRaw },
  ] = await Promise.all([
    // gst_rate_percent / cess_rate_percent / is_rcm_applicable are NOT
    // denormalised onto voucher_items, so they come from the item master —
    // the same source, and the same caveat, GSTR-1 Table 12 carries (0098):
    // a later rate change on the master is reflected on a reprint.
    isGst
      ? supabase
          .from("voucher_items")
          .select(
            "id, quantity, uom, rate, amount, discount_percent, amount_before_discount, hsn_sac, description, line_order, items(name, gst_rate_percent, cess_rate_percent, is_rcm_applicable)"
          )
          .eq("voucher_id", voucherId)
          .order("line_order")
      : Promise.resolve({ data: null }),
    voucher.party_ledger_id
      ? supabase
          .from("ledgers")
          .select("name, address, city, pincode, gstin, state_code, phone, email")
          .eq("id", voucher.party_ledger_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("branches")
      .select(
        "name, address_line1, address_line2, city, pincode, state_code, gst_registration_id, gst_registrations(gstin)"
      )
      .eq("id", voucher.branch_id)
      .maybeSingle(),
    supabase.from("tax_ledger_map").select("purpose, ledger_id").eq("company_id", companyId),
    supabase.from("ref_states").select("code, name"),
    supabase
      .from("voucher_entries")
      .select("id, ledger_id, debit_amount, credit_amount, narration, line_order, ledgers(name)")
      .eq("voucher_id", voucherId)
      .order("line_order"),
    // Only a sales invoice can ever show a payment QR (the only voucher type
    // this company is the payee for), so the RPC is skipped entirely for
    // every other type rather than paying for a round trip whose result
    // would be discarded.
    voucher.voucher_type === "sales"
      ? supabase.rpc("get_invoice_outstanding", {
          p_company_id: companyId,
          p_voucher_id: voucherId,
        })
      : Promise.resolve({ data: null }),
  ]);

  // companies carries the 14 invoice-design columns migration 0800 added,
  // voucher_ship_to is the table 0805 added, and einvoice_details came in
  // 0230; types/database.types.ts — owned by the integration pass — knows
  // none of the three yet, so all three use the established escape hatch.
  // Same convention as components/einvoice/EinvoiceDetailForm.tsx.
  const [{ data: companyRaw }, { data: shipToRaw }, { data: einvoiceRaw }] = await Promise.all([
    supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .from("companies" as any)
      .select(
        "name, legal_name, pan, upi_vpa, logo_url, print_terms_and_conditions, print_footer_note, print_accent_color, print_paper_size, print_sales_title, print_composition_declaration, print_copy_labels, print_declaration_text, print_signatory_name, print_signatory_designation, print_bank_account_name, print_bank_name, print_bank_branch, print_bank_account_number, print_bank_ifsc, print_show_upi_qr"
      )
      .eq("id", companyId)
      .maybeSingle(),
    isGst
      ? supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .from("voucher_ship_to" as any)
          .select(
            "ship_to_name, ship_to_address, ship_to_city, ship_to_state_code, ship_to_pincode, ship_to_gstin"
          )
          .eq("voucher_id", voucherId)
          .eq("company_id", companyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    isGst
      ? supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .from("einvoice_details" as any)
          .select("irn, ack_number, ack_date, signed_qr_payload")
          .eq("voucher_id", voucherId)
          .eq("company_id", companyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const company = (companyRaw ?? null) as unknown as (RawCompany & { logo_url: string | null }) | null;
  const shipTo = (shipToRaw ?? null) as unknown as RawShipTo | null;
  const einvoice = (einvoiceRaw ?? null) as unknown as RawEinvoice | null;

  const logoDataUri = await resolveLogoDataUri(supabase, company?.logo_url ?? null);

  const { doc, copies, paper } = buildVoucherDoc({
    voucher,
    company,
    branch: branch ?? null,
    party: party ?? null,
    shipTo,
    einvoice,
    items: items ?? [],
    entries: entries ?? [],
    taxMap: taxMap ?? [],
    states: states ?? [],
    logoDataUri,
    outstandingAmount: Number(outstandingRaw ?? 0),
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 print:max-w-none print:px-0 print:py-0">
      <style>{printPageCss(paper)}</style>

      <div className="mb-6 flex items-center justify-end gap-3 print:hidden">
        <Link
          href={`/${companyId}/settings/print-template`}
          className="text-xs text-ink-faint underline underline-offset-2 hover:text-ink"
        >
          Invoice design
        </Link>
        <DownloadPdfButton companyId={companyId} voucherId={voucherId} />
        <PrintButton />
      </div>

      {copies.map((copyLabel, i) => (
        <div
          key={copyLabel ?? i}
          className={i < copies.length - 1 ? "invoice-copy mb-10" : undefined}
        >
          <VoucherDocument doc={{ ...doc, copyLabel }} />
        </div>
      ))}
    </main>
  );
}
