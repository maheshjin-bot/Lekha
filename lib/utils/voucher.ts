/**
 * Sales/purchase/credit-note/debit-note vouchers carry item lines
 * (voucher_items) and GST/TCS that only InvoiceForm + update_invoice know
 * how to edit correctly — the generic voucher editor only ever touches
 * voucher_entries, so pointing it at an invoice would silently desync the
 * stock/tax data from the ledger entries. Every "Edit" link in the app
 * routes through this so that split never has to be re-decided per screen.
 */
const INVOICE_TYPES = new Set(["sales", "purchase", "credit_note", "debit_note"]);

export function isInvoiceType(voucherType: string): boolean {
  return INVOICE_TYPES.has(voucherType);
}

export function editHrefFor(companyId: string, voucherId: string, voucherType: string): string {
  return isInvoiceType(voucherType)
    ? `/${companyId}/invoices/${voucherId}/edit`
    : `/${companyId}/vouchers/${voucherId}/edit`;
}
