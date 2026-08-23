"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const field =
  "rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none";

type Payment = {
  id: string;
  tax_type: string;
  minor_head: string | null;
  financial_year_label: string;
  payment_date: string;
  amount: number;
  bsr_code: string | null;
  challan_serial: string | null;
  challan_reference: string | null;
  tds_section: string | null;
};

const TAX_TYPE_LABEL: Record<string, string> = {
  income_tax: "Income tax (280)",
  tds: "TDS deposited (281)",
  tcs: "TCS deposited (281)",
  gst: "GST (PMT-06)",
};

const MINOR_HEAD_LABEL: Record<string, string> = {
  "100": "100 — Advance tax",
  "300": "300 — Self-assessment",
  "400": "400 — Regular assessment",
};

export function TaxPaymentManager({
  companyId,
  financialYearLabel,
  payments,
}: {
  companyId: string;
  financialYearLabel: string;
  payments: Payment[];
}) {
  const router = useRouter();
  const [taxType, setTaxType] = useState("income_tax");
  const [minorHead, setMinorHead] = useState("100");
  const [fyLabel, setFyLabel] = useState(financialYearLabel);
  const [paymentDate, setPaymentDate] = useState("");
  const [amount, setAmount] = useState("");
  const [bsrCode, setBsrCode] = useState("");
  const [challanSerial, setChallanSerial] = useState("");
  const [challanReference, setChallanReference] = useState("");
  const [tdsSection, setTdsSection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isIncomeTax = taxType === "income_tax";
  const isGst = taxType === "gst";
  const isTdsOrTcs = taxType === "tds" || taxType === "tcs";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient()
      .from("tax_payments")
      .insert({
        company_id: companyId,
        tax_type: taxType,
        // The CHECK requires a minor head for income tax and forbids it elsewhere.
        minor_head: isIncomeTax ? minorHead : null,
        financial_year_label: fyLabel,
        payment_date: paymentDate,
        amount: Number(amount) || 0,
        bsr_code: bsrCode.trim() || null,
        challan_serial: challanSerial.trim() || null,
        challan_reference: challanReference.trim() || null,
        tds_section: isTdsOrTcs ? tdsSection.trim() || null : null,
      });

    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setAmount("");
    setBsrCode("");
    setChallanSerial("");
    setChallanReference("");
    setTdsSection("");
    router.refresh();
  }

  async function onDelete(id: string) {
    if (!confirm("Remove this challan record? It does not reverse any voucher.")) return;
    const { error } = await createClient().from("tax_payments").delete().eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="border-b border-border p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Tax</span>
            <select value={taxType} onChange={(e) => setTaxType(e.target.value)} className={field}>
              {Object.entries(TAX_TYPE_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>

          {isIncomeTax && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">Minor head</span>
              <select
                value={minorHead}
                onChange={(e) => setMinorHead(e.target.value)}
                className={field}
              >
                {Object.entries(MINOR_HEAD_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Financial year</span>
            <input
              value={fyLabel}
              onChange={(e) => setFyLabel(e.target.value)}
              placeholder="2026-27"
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Date of deposit</span>
            <input
              type="date"
              required
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-ink-faint">Amount</span>
            <input
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={field + " text-right tabular-nums"}
            />
          </label>

          {!isGst && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">BSR code</span>
                <input
                  value={bsrCode}
                  onChange={(e) => setBsrCode(e.target.value)}
                  placeholder="7 digits"
                  className={field + " font-mono"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Challan serial</span>
                <input
                  value={challanSerial}
                  onChange={(e) => setChallanSerial(e.target.value)}
                  placeholder="5 digits"
                  className={field + " font-mono"}
                />
              </label>
            </>
          )}

          {isGst && (
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-xs text-ink-faint">CIN / BRN</span>
              <input
                value={challanReference}
                onChange={(e) => setChallanReference(e.target.value)}
                className={field + " font-mono"}
              />
            </label>
          )}

          {isTdsOrTcs && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-ink-faint">Section</span>
              <input
                value={tdsSection}
                onChange={(e) => setTdsSection(e.target.value)}
                placeholder="194C"
                className={field}
              />
            </label>
          )}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Record challan"}
          </button>
          {error && <p className="text-xs text-error">{error}</p>}
        </div>
      </form>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-2 font-medium text-ink-soft">Tax</th>
              <th className="px-4 py-2 font-medium text-ink-soft">For FY</th>
              <th className="px-4 py-2 font-medium text-ink-soft">Deposited</th>
              <th className="px-4 py-2 font-medium text-ink-soft">CIN</th>
              <th className="px-4 py-2 text-right font-medium text-ink-soft">Amount</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {payments.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-ink-faint">
                  No challan recorded yet.
                </td>
              </tr>
            )}
            {payments.map((p) => (
              <tr key={p.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2">
                  {TAX_TYPE_LABEL[p.tax_type] ?? p.tax_type}
                  {p.minor_head && (
                    <div className="text-xs text-ink-faint">
                      {MINOR_HEAD_LABEL[p.minor_head] ?? p.minor_head}
                    </div>
                  )}
                  {p.tds_section && (
                    <div className="text-xs text-ink-faint">Sec {p.tds_section}</div>
                  )}
                </td>
                <td className="px-4 py-2">{p.financial_year_label}</td>
                <td className="px-4 py-2">{p.payment_date}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  {p.challan_reference
                    ? p.challan_reference
                    : p.bsr_code && p.challan_serial
                      ? `${p.bsr_code} / ${p.payment_date} / ${p.challan_serial}`
                      : "—"}
                </td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">
                  {Number(p.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => onDelete(p.id)}
                    className="text-xs text-ink-faint underline hover:text-error"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
