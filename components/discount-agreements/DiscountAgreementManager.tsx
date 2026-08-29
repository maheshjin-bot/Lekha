"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";

export type DiscountAgreement = {
  id: string;
  party_ledger_id: string;
  terms: string;
  standard_discount_percent: number | null;
  agreed_date: string;
  is_active: boolean;
};
export type DiscountAgreementLink = {
  id: string;
  agreement_id: string;
  voucher_id: string;
  voucher_item_id: string | null;
  original_invoice_voucher_id: string | null;
  created_at: string;
};
export type LinkableLedger = { id: string; name: string; ledger_role: string };
export type LinkableVoucher = {
  id: string;
  voucher_number: string;
  voucher_date: string;
  voucher_type: string;
  party_ledger_id: string;
  total_amount: number;
};
export type LinkableVoucherItem = {
  id: string;
  voucher_id: string;
  discount_percent: number;
  discount_amount: number;
  amount: number;
  item_name: string;
};

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

/**
 * Two linked concerns on one screen, matching PriceListManager's shape
 * (components/price-lists/PriceListManager.tsx): a list-plus-create panel
 * for discount_agreements, and a second list-plus-create panel for
 * discount_agreement_links — the manual picker the task brief asked for,
 * never automatic matching. See 0431.
 */
export function DiscountAgreementManager({
  companyId,
  agreements,
  links,
  ledgers,
  vouchers,
  discountedItems,
}: {
  companyId: string;
  agreements: DiscountAgreement[];
  links: DiscountAgreementLink[];
  ledgers: LinkableLedger[];
  vouchers: LinkableVoucher[];
  discountedItems: LinkableVoucherItem[];
}) {
  const router = useRouter();
  const ledgerName = (id: string) => ledgers.find((l) => l.id === id)?.name ?? "—";
  const voucherById = useMemo(() => new Map(vouchers.map((v) => [v.id, v])), [vouchers]);
  const itemById = useMemo(() => new Map(discountedItems.map((i) => [i.id, i])), [discountedItems]);

  // ---- New agreement form ----
  const [partyId, setPartyId] = useState("");
  const [terms, setTerms] = useState("");
  const [stdPct, setStdPct] = useState("");
  const [agreedDate, setAgreedDate] = useState(todayLocal);
  const [agreementBusy, setAgreementBusy] = useState(false);
  const [agreementError, setAgreementError] = useState<string | null>(null);

  async function onCreateAgreement(e: React.FormEvent) {
    e.preventDefault();
    setAgreementBusy(true);
    setAgreementError(null);
    const { error } = await createClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discount_agreements is new (0431), not yet in generated types
      .from("discount_agreements" as any)
      .insert({
        company_id: companyId,
        party_ledger_id: partyId,
        terms: terms.trim(),
        standard_discount_percent: stdPct.trim() === "" ? null : Number(stdPct),
        agreed_date: agreedDate,
      });
    if (error) {
      setAgreementError(error.message);
      setAgreementBusy(false);
      return;
    }
    setPartyId("");
    setTerms("");
    setStdPct("");
    setAgreementBusy(false);
    router.refresh();
  }

  async function toggleActive(a: DiscountAgreement) {
    await createClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .from("discount_agreements" as any)
      .update({ is_active: !a.is_active })
      .eq("id", a.id);
    router.refresh();
  }

  // ---- New link form ----
  const [linkScope, setLinkScope] = useState<"line" | "whole_voucher">("line");
  const [linkAgreementId, setLinkAgreementId] = useState("");
  const [linkVoucherItemId, setLinkVoucherItemId] = useState("");
  const [linkVoucherId, setLinkVoucherId] = useState("");
  const [linkOriginalInvoiceId, setLinkOriginalInvoiceId] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const activeAgreements = agreements.filter((a) => a.is_active);
  const linkAgreement = activeAgreements.find((a) => a.id === linkAgreementId);

  const alreadyLinkedItemIds = new Set(links.filter((l) => l.voucher_item_id).map((l) => l.voucher_item_id));
  const alreadyLinkedWholeVoucherIds = new Set(
    links.filter((l) => !l.voucher_item_id).map((l) => l.voucher_id)
  );

  // Candidate discounted lines: same party as the chosen agreement, not
  // already linked to some other agreement.
  const candidateLines = linkAgreement
    ? discountedItems.filter((it) => {
        if (alreadyLinkedItemIds.has(it.id)) return false;
        const v = voucherById.get(it.voucher_id);
        return v && v.party_ledger_id === linkAgreement.party_ledger_id;
      })
    : [];

  // Candidate credit notes: same party, not already whole-linked.
  const candidateCreditNotes = linkAgreement
    ? vouchers.filter(
        (v) =>
          v.voucher_type === "credit_note" &&
          v.party_ledger_id === linkAgreement.party_ledger_id &&
          !alreadyLinkedWholeVoucherIds.has(v.id)
      )
    : [];

  const chosenCreditNote = vouchers.find((v) => v.id === linkVoucherId);
  const candidateOriginalInvoices =
    linkAgreement && chosenCreditNote
      ? vouchers.filter(
          (v) =>
            v.voucher_type === "sales" &&
            v.party_ledger_id === linkAgreement.party_ledger_id &&
            v.voucher_date <= chosenCreditNote.voucher_date
        )
      : [];

  async function onCreateLink(e: React.FormEvent) {
    e.preventDefault();
    setLinkBusy(true);
    setLinkError(null);

    const lineVoucherId = linkScope === "line" ? itemById.get(linkVoucherItemId)?.voucher_id : linkVoucherId;
    if (!lineVoucherId) {
      setLinkError("Could not resolve the voucher for the selected line — pick it again.");
      setLinkBusy(false);
      return;
    }
    // One shared shape for both branches (not a discriminated union) so the
    // insert call has a single, unambiguous type to check against.
    const payload: {
      company_id: string;
      agreement_id: string;
      voucher_id: string;
      voucher_item_id: string | null;
      original_invoice_voucher_id: string | null;
    } =
      linkScope === "line"
        ? {
            company_id: companyId,
            agreement_id: linkAgreementId,
            voucher_id: lineVoucherId,
            voucher_item_id: linkVoucherItemId,
            original_invoice_voucher_id: null,
          }
        : {
            company_id: companyId,
            agreement_id: linkAgreementId,
            voucher_id: linkVoucherId,
            voucher_item_id: null,
            original_invoice_voucher_id: linkOriginalInvoiceId || null,
          };

    const { error } = await createClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- discount_agreement_links is new (0431), not yet in generated types
      .from("discount_agreement_links" as any)
      .insert(payload);

    if (error) {
      setLinkError(error.message);
      setLinkBusy(false);
      return;
    }
    setLinkAgreementId("");
    setLinkVoucherItemId("");
    setLinkVoucherId("");
    setLinkOriginalInvoiceId("");
    setLinkBusy(false);
    router.refresh();
  }

  async function onUnlink(id: string) {
    await createClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .from("discount_agreement_links" as any)
      .delete()
      .eq("id", id);
    router.refresh();
  }

  return (
    <div className="mt-8 space-y-10">
      {/* ---------------- Agreements ---------------- */}
      <section>
        <h2 className="font-semibold text-ink">Agreements</h2>
        <div className="mt-3 grid gap-8 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2.5 font-medium">Party</th>
                  <th className="px-4 py-2.5 font-medium">Terms</th>
                  <th className="px-4 py-2.5 text-right font-medium">Std %</th>
                  <th className="px-4 py-2.5 font-medium">Agreed</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {agreements.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-ink-faint">
                      No discount agreements recorded yet.
                    </td>
                  </tr>
                )}
                {agreements.map((a) => (
                  <tr key={a.id} className="border-b border-border align-top last:border-0">
                    <td className="px-4 py-2.5 font-medium">{ledgerName(a.party_ledger_id)}</td>
                    <td className="max-w-[320px] px-4 py-2.5 text-ink-soft">{a.terms}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {a.standard_discount_percent != null ? `${a.standard_discount_percent}%` : "—"}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-ink-soft">{a.agreed_date}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={a.is_active ? "ok" : "neutral"}>{a.is_active ? "Active" : "Inactive"}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => toggleActive(a)}
                        className="text-xs text-accent underline underline-offset-4"
                      >
                        {a.is_active ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-border bg-surface p-5">
            <h3 className="font-semibold text-ink">New agreement</h3>
            <form onSubmit={onCreateAgreement} className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Party</span>
                <select required value={partyId} onChange={(e) => setPartyId(e.target.value)} className={field}>
                  <option value="">Select customer…</option>
                  {ledgers.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Terms</span>
                <textarea
                  required
                  rows={3}
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  placeholder="e.g. 10% off list price on orders above ₹50,000, agreed by email 1-Aug-2026"
                  className={field}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Standard % (optional)</span>
                <input
                  inputMode="decimal"
                  value={stdPct}
                  onChange={(e) => setStdPct(e.target.value)}
                  placeholder="e.g. 10"
                  className={field}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Agreed date</span>
                <input
                  type="date"
                  required
                  value={agreedDate}
                  onChange={(e) => setAgreedDate(e.target.value)}
                  className={field}
                />
              </label>
              {agreementError && (
                <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{agreementError}</p>
              )}
              <button
                type="submit"
                disabled={agreementBusy}
                className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {agreementBusy ? "Creating…" : "Create agreement"}
              </button>
            </form>
          </div>
        </div>
      </section>

      {/* ---------------- Links ---------------- */}
      <section>
        <h2 className="font-semibold text-ink">Linked discounts</h2>
        <p className="mt-1 text-xs text-ink-faint">
          Pick which credit note, or which specific discounted invoice line, a discount actually
          came from. Nothing here is matched automatically.
        </p>
        <div className="mt-3 grid gap-8 lg:grid-cols-[1fr_360px]">
          <div className="min-w-0 overflow-x-auto rounded-lg border border-border bg-surface">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2.5 font-medium">Voucher</th>
                  <th className="px-4 py-2.5 font-medium">What&apos;s linked</th>
                  <th className="px-4 py-2.5 font-medium">Agreement</th>
                  <th className="px-4 py-2.5 font-medium">Original invoice</th>
                  <th className="px-4 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {links.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-ink-faint">
                      No links recorded yet.
                    </td>
                  </tr>
                )}
                {links.map((l) => {
                  const v = voucherById.get(l.voucher_id);
                  const item = l.voucher_item_id ? itemById.get(l.voucher_item_id) : null;
                  const agreement = agreements.find((a) => a.id === l.agreement_id);
                  const orig = l.original_invoice_voucher_id ? voucherById.get(l.original_invoice_voucher_id) : null;
                  return (
                    <tr key={l.id} className="border-b border-border align-top last:border-0">
                      <td className="px-4 py-2.5">
                        {v?.voucher_number ?? "—"}
                        <div className="text-xs text-ink-faint">{v?.voucher_date}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        {item ? (
                          <>
                            {item.item_name}
                            <div className="text-xs text-ink-faint">
                              {item.discount_percent}% — {formatINR(item.discount_amount)}
                            </div>
                          </>
                        ) : (
                          <>
                            Entire credit note
                            <div className="text-xs text-ink-faint">{v ? formatINR(v.total_amount) : ""}</div>
                          </>
                        )}
                      </td>
                      <td className="max-w-[240px] px-4 py-2.5 text-ink-soft">
                        {agreement?.terms ?? "—"}
                        <div className="text-xs text-ink-faint">Agreed {agreement?.agreed_date}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        {orig ? (
                          <>
                            {orig.voucher_number}
                            <div className="text-xs text-ink-faint">{orig.voucher_date}</div>
                          </>
                        ) : (
                          <span className="text-ink-faint">Not named</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => onUnlink(l.id)}
                          className="text-xs text-error underline underline-offset-4"
                        >
                          Unlink
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-border bg-surface p-5">
            <h3 className="font-semibold text-ink">Link a discount</h3>
            <form onSubmit={onCreateLink} className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Agreement</span>
                <select
                  required
                  value={linkAgreementId}
                  onChange={(e) => {
                    setLinkAgreementId(e.target.value);
                    setLinkVoucherItemId("");
                    setLinkVoucherId("");
                    setLinkOriginalInvoiceId("");
                  }}
                  className={field}
                >
                  <option value="">Select active agreement…</option>
                  {activeAgreements.map((a) => (
                    <option key={a.id} value={a.id}>
                      {ledgerName(a.party_ledger_id)} — {a.terms.slice(0, 40)}
                      {a.terms.length > 40 ? "…" : ""}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={linkScope === "line"}
                    onChange={() => setLinkScope("line")}
                  />
                  Invoice line
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    checked={linkScope === "whole_voucher"}
                    onChange={() => setLinkScope("whole_voucher")}
                  />
                  Whole credit note
                </label>
              </div>

              {linkScope === "line" ? (
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium">Discounted line</span>
                  <select
                    required
                    value={linkVoucherItemId}
                    onChange={(e) => setLinkVoucherItemId(e.target.value)}
                    className={field}
                    disabled={!linkAgreementId}
                  >
                    <option value="">Select line…</option>
                    {candidateLines.map((it) => {
                      const v = voucherById.get(it.voucher_id);
                      return (
                        <option key={it.id} value={it.id}>
                          {v?.voucher_number} — {it.item_name} ({it.discount_percent}%)
                        </option>
                      );
                    })}
                  </select>
                  {linkAgreementId && candidateLines.length === 0 && (
                    <p className="text-xs text-ink-faint">
                      No unlinked discounted line exists for this party yet.
                    </p>
                  )}
                </label>
              ) : (
                <>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Credit note</span>
                    <select
                      required
                      value={linkVoucherId}
                      onChange={(e) => {
                        setLinkVoucherId(e.target.value);
                        setLinkOriginalInvoiceId("");
                      }}
                      className={field}
                      disabled={!linkAgreementId}
                    >
                      <option value="">Select credit note…</option>
                      {candidateCreditNotes.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.voucher_number} — {v.voucher_date} — {formatINR(v.total_amount)}
                        </option>
                      ))}
                    </select>
                    {linkAgreementId && candidateCreditNotes.length === 0 && (
                      <p className="text-xs text-ink-faint">
                        No unlinked credit note exists for this party yet.
                      </p>
                    )}
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium">Original invoice (optional, recommended)</span>
                    <select
                      value={linkOriginalInvoiceId}
                      onChange={(e) => setLinkOriginalInvoiceId(e.target.value)}
                      className={field}
                      disabled={!linkVoucherId}
                    >
                      <option value="">Not named</option>
                      {candidateOriginalInvoices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.voucher_number} — {v.voucher_date}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-ink-faint">
                      Sec 15(3)(b)(i) requires the discount be &ldquo;specifically linked to relevant
                      invoices&rdquo; — name the invoice this credit note discounts.
                    </p>
                  </label>
                </>
              )}

              {linkError && <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{linkError}</p>}

              <button
                type="submit"
                disabled={linkBusy || !linkAgreementId}
                className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {linkBusy ? "Linking…" : "Link"}
              </button>
            </form>
          </div>
        </div>
      </section>
    </div>
  );
}
