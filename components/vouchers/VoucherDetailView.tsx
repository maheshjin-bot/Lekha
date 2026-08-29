"use client";

import { useRef } from "react";
import Link from "next/link";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { ExportActions } from "@/components/ui/ExportActions";
import { ApproveVoucherButton } from "@/components/vouchers/ApproveVoucherButton";
import { DeleteVoucherButton } from "@/components/vouchers/DeleteVoucherButton";
import { editHrefFor } from "@/lib/utils/voucher";

const TYPE_LABEL: Record<string, string> = {
  receipt: "Receipt",
  payment: "Payment",
  contra: "Contra",
  journal: "Journal",
  sales: "Sales",
  purchase: "Purchase",
  credit_note: "Credit note",
  debit_note: "Debit note",
  branch_transfer: "Branch transfer",
  stock_journal: "Stock journal",
};

type Line = {
  id: string;
  debit_amount: number;
  credit_amount: number;
  narration: string | null;
  ledgers: { name: string } | null;
};

type ItemLine = {
  item_id: string;
  quantity: number;
  uom: string;
  rate: number;
  amount: number;
  hsn_sac: string | null;
  description: string | null;
  items: { name: string } | null;
};

/**
 * The on-screen working view of a voucher: what it did to the ledger, what
 * was bought or sold, and the actions an operator can take on it (approve,
 * edit, delete, export).
 *
 * THIS IS NOT THE PRINTED DOCUMENT, and the split is deliberate. The paper
 * document a customer receives is components/vouchers/VoucherDocument.tsx —
 * a pure, CGST Rule 46 tax invoice rendered by the print page and captured
 * by the PDF export route. This file is the internal screen: it keeps the
 * approval badge, the maker-checker button and the deleted-voucher warning,
 * none of which belong on an invoice, and it deliberately shows the ledger
 * postings for every voucher type because on this screen "how it posted" is
 * the question being asked. A client component because Print/CSV/JPG capture
 * needs a DOM ref; everything it renders is pre-fetched server data passed
 * straight through as props.
 */
export function VoucherDetailView({
  companyId,
  voucherId,
  voucherNumber,
  voucherType,
  voucherDate,
  branchLabel,
  totalAmount,
  txnCurrency,
  exchangeRate,
  narration,
  referenceNumber,
  financialYearLabel,
  isPending,
  isDeleted,
  canApprove,
  disabledReason,
  lines,
  items,
}: {
  companyId: string;
  voucherId: string;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  branchLabel: string | null;
  totalAmount: number;
  txnCurrency: string;
  exchangeRate: number;
  narration: string | null;
  referenceNumber: string | null;
  financialYearLabel: string;
  isPending: boolean;
  isDeleted: boolean;
  canApprove: boolean;
  disabledReason?: string;
  lines: Line[];
  /** Set for sales/purchase/credit-note/debit-note vouchers — what was
   * actually sold or bought, shown alongside (not instead of) the ledger
   * postings below, since neither substitutes for the other. */
  items?: ItemLine[];
}) {
  const captureRef = useRef<HTMLDivElement>(null);
  const dr = lines.reduce((n, l) => n + Number(l.debit_amount), 0);
  const cr = lines.reduce((n, l) => n + Number(l.credit_amount), 0);

  return (
    <>
      <div ref={captureRef}>
        <header className="mt-6 mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-mono text-xl font-semibold tracking-tight">{voucherNumber}</h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
              {TYPE_LABEL[voucherType] ?? voucherType} · {voucherDate}
              {branchLabel && ` · ${branchLabel}`}
              <Badge tone={isDeleted ? "bad" : isPending ? "warn" : "ok"} className="print:hidden">
                {isDeleted ? "Deleted" : isPending ? "Pending approval" : "Approved"}
              </Badge>
            </p>
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold tabular-nums font-mono">
              {formatINR(totalAmount, { showZero: true })}
            </div>
            {txnCurrency !== "INR" && (
              <div className="text-xs text-ink-faint">
                {txnCurrency} @ {exchangeRate}
              </div>
            )}
          </div>
        </header>

        {items && items.length > 0 && (
          <>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Items
            </h2>
            <div className="mb-6 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2.5 font-medium">Item</th>
                  <th className="px-4 py-2.5 font-medium">HSN/SAC</th>
                  <th className="px-4 py-2.5 text-right font-medium">Qty</th>
                  <th className="px-4 py-2.5 font-medium">Unit</th>
                  <th className="px-4 py-2.5 text-right font-medium">Rate</th>
                  <th className="px-4 py-2.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-medium">
                      {it.items?.name ?? "—"}
                      {it.description && (
                        <span className="block text-xs font-normal text-ink-faint">{it.description}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-ink-faint">{it.hsn_sac ?? "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono">{it.quantity}</td>
                    <td className="px-4 py-2 text-ink-faint">{it.uom}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono">{formatINR(Number(it.rate))}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono">{formatINR(Number(it.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}

        {items && items.length > 0 && (
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Ledger postings
          </h2>
        )}
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Ledger</th>
                <th className="px-4 py-2.5 font-medium">Narration</th>
                <th className="px-4 py-2.5 text-right font-medium">Debit</th>
                <th className="px-4 py-2.5 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-medium">{l.ledgers?.name ?? "—"}</td>
                  <td className="px-4 py-2 text-ink-soft">{l.narration ?? "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono">
                    {formatINR(Number(l.debit_amount))}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-mono">
                    {formatINR(Number(l.credit_amount))}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border-strong bg-bg font-semibold">
                <td className="px-4 py-2.5" colSpan={2}>
                  {lines.length} line{lines.length === 1 ? "" : "s"}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                  {formatINR(dr, { showZero: true })}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                  {formatINR(cr, { showZero: true })}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {narration && (
          <p className="mt-5 text-sm text-ink-soft">
            <span className="font-medium">Narration: </span>
            {narration}
          </p>
        )}

        {referenceNumber && (
          <p className="mt-1.5 text-sm text-ink-soft">
            <span className="font-medium">Reference: </span>
            {referenceNumber}
          </p>
        )}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3 print:hidden">
        {!isDeleted && (
          <>
            <Link
              href={editHrefFor(companyId, voucherId, voucherType)}
              className="rounded-lg border border-border-strong px-3 py-1.5 text-sm transition-colors hover:bg-accent-soft"
            >
              Edit voucher
            </Link>
            <Link
              href={`/${companyId}/vouchers/${voucherId}/print`}
              className="rounded-lg border border-border-strong px-3 py-1.5 text-sm transition-colors hover:bg-accent-soft"
            >
              Print
            </Link>
            {isPending && (
              <ApproveVoucherButton
                companyId={companyId}
                voucherId={voucherId}
                canApprove={canApprove}
                disabledReason={disabledReason}
              />
            )}
          </>
        )}
        <ExportActions captureRef={captureRef} filename={`voucher-${voucherNumber}`} showPrint={false} />
        {!isDeleted && (
          <DeleteVoucherButton
            companyId={companyId}
            voucherId={voucherId}
            redirectTo={`/${companyId}/reports/daybook`}
          />
        )}
        <span className="text-xs text-ink-faint">
          {isDeleted
            ? "This voucher has been deleted — it no longer affects any balance or report."
            : `The date can move within financial year ${financialYearLabel}, but not out of it.`}
        </span>
      </div>
    </>
  );
}
