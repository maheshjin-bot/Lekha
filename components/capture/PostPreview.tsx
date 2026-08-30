"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { formatINR } from "@/lib/utils/currency";
import { loadPreviewFacts, type PreviewFacts } from "@/components/capture/previewFacts";
import {
  buildPostPreview,
  type PostPreview as Preview,
  type PreviewLineInput,
} from "@/components/capture/previewModel";

/**
 * WHAT THIS POST WILL DO TO THE BOOKS — the last screen before it does it.
 *
 * ============================================================================
 * THE GAP THIS FILLS
 * ============================================================================
 * The review screen's step 3 already compares every figure the model read off
 * the paper against every figure this draft computes, component by component,
 * and that comparison is good: it tells a preparer whether the DOCUMENT has
 * been read correctly. It says nothing at all about what pressing the button
 * does. The post is one create_invoice call away and the entry it will make —
 * which ledgers, which side, how much — is invisible until it already exists.
 *
 * For an accountant that entry IS the document. "Cr SUPER ELECTRICALS
 * 3,050.30 / Dr Purchase Account 2,585.00 / Dr Input IGST (27) 465.30" is a
 * sentence they can check in two seconds, and every mistake this screen can
 * make is visible in it: the wrong supplier, the wrong expense head, tax split
 * the wrong way, a total that does not balance.
 *
 * ============================================================================
 * IT WRITES NOTHING
 * ============================================================================
 * Opening this reads seven things (see previewFacts.ts) and calls no RPC.
 * There is no create_invoice call anywhere in this file, no insert, no update,
 * and no post button — closing it returns to the form, where the ONE post
 * button still lives. That is not caution for its own sake: the feature's
 * whole promise, printed twice on the screen behind this dialog, is that a
 * captured draft never posts itself.
 *
 * The arithmetic is mirrored from the live create_invoice definition; the long
 * argument for mirroring rather than dry-running is in previewModel.ts's own
 * header, along with the measurements behind it.
 *
 * ============================================================================
 * IT SAYS WHAT IT CANNOT KNOW
 * ============================================================================
 * A preview that quietly guesses is worse than none, because it is believed.
 * Three things are genuinely undecided until the insert happens — the voucher
 * NUMBER when the series draws it, whether the period is still open, and
 * whether a hand-typed number is already taken — and all three are printed at
 * the foot of this dialog as open questions rather than filled in with a
 * plausible answer.
 */

type LineInput = PreviewLineInput;

export type WrongCompany = {
  recipientName: string | null;
  recipientGstin: string | null;
};

const cell = "px-3 py-2";
const money = "px-3 py-2 text-right font-mono tabular-nums";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  );
}

export function PostPreview({
  open,
  onClose,
  companyId,
  branchId,
  branchLabel,
  voucherType,
  voucherDate,
  partyLedgerId,
  partyLedgerName,
  tradingLedgerName,
  godownLabel,
  placeOfSupply,
  placeOfSupplyLabel,
  lines,
  documentLabel,
  referenceLabel,
  referenceNumber,
  challanLabel,
  challanNumber,
  challanDate,
  narration,
  numberFact,
  numberCaveat,
  wrongCompany,
  missing,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  branchId: string;
  branchLabel: string;
  voucherType: "sales" | "purchase";
  voucherDate: string;
  partyLedgerId: string;
  partyLedgerName: string;
  tradingLedgerName: string;
  godownLabel: string;
  placeOfSupply: string;
  placeOfSupplyLabel: string;
  lines: LineInput[];
  documentLabel: string;
  referenceLabel: string;
  referenceNumber: string;
  challanLabel: string;
  challanNumber: string;
  challanDate: string;
  narration: string;
  /** What will appear in vouchers.voucher_number, as far as it is knowable. */
  numberFact: string;
  /** Null when the number is exactly known — i.e. manual mode. */
  numberCaveat: string | null;
  /** Set only while the bill-to warning is still unacknowledged. */
  wrongCompany: WrongCompany | null;
  /** Form-level problems that stop the post before create_invoice is reached. */
  missing: string[];
}) {
  /**
   * The distinct item ids as a stable STRING. `lines` is rebuilt by the form on
   * every keystroke, so depending on the array itself would refetch forever;
   * and the effect below reads this string rather than `lines` so that the
   * dependency list is honest rather than merely quiet.
   */
  const itemKey = [...new Set(lines.map((l) => l.itemId).filter(Boolean))].sort().join(",");

  /**
   * Everything create_invoice's own lookups depend on, as one string. Held ON
   * the result too, so a result that arrives after the preparer has changed
   * the date behind the dialog is recognised as stale and ignored rather than
   * shown against figures it was not read for.
   */
  const requestKey = `${companyId}|${branchId}|${voucherDate}|${partyLedgerId}|${itemKey}`;

  const [loaded, setLoaded] = useState<{
    key: string;
    facts: PreviewFacts | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // One setState, in the callback — never synchronously in the effect body,
    // which would cascade a render on every open.
    void loadPreviewFacts({
      companyId,
      branchId,
      voucherDate,
      partyLedgerId,
      itemIds: itemKey ? itemKey.split(",") : [],
    }).then((result) => {
      if (cancelled) return;
      setLoaded({ key: requestKey, facts: result.facts, error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [open, companyId, branchId, voucherDate, partyLedgerId, itemKey, requestKey]);

  const current = loaded && loaded.key === requestKey ? loaded : null;
  const facts = current?.facts ?? null;
  const loadError = current?.error ?? null;
  const loading = open && current === null;

  const preview: Preview | null =
    facts && missing.length === 0
      ? buildPostPreview(
          {
            voucherType,
            voucherDate,
            placeOfSupply,
            lines,
            partyLedgerName,
            tradingLedgerName,
          },
          facts
        )
      : null;

  const blockers = [...missing, ...(preview?.blockers ?? [])];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="What posting this will do"
      description="The entry create_invoice will write, worked out from the same figures it will be given. Nothing below has been written — close this and press the post button when it reads right."
      className="max-w-4xl"
    >
      {loading && <p className="text-sm text-ink-soft">Reading the ledgers and registrations…</p>}

      {loadError && (
        <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
          The facts this preview needs could not be read ({loadError}), so nothing is shown rather
          than something guessed. Close and try again.
        </p>
      )}

      {!loading && !loadError && (
        <>
          {/* ── Anything already known to be off, first. This is the last
              moment before the books change, so a warning printed after the
              arithmetic is a warning read after the decision. ───────────── */}
          {wrongCompany && (
            <div className="rounded-lg border border-warning bg-warning-soft p-3">
              <p className="text-sm font-medium text-warning">
                This bill is addressed to someone else
              </p>
              <p className="mt-1 text-sm text-ink-soft">
                It is made out to{" "}
                <span className="font-medium text-ink">
                  {wrongCompany.recipientName ?? "another party"}
                </span>
                {wrongCompany.recipientGstin ? (
                  <> (<span className="font-mono text-xs">{wrongCompany.recipientGstin}</span>)</>
                ) : null}
                , not this company. The entry below would book another firm&rsquo;s purchase into
                your accounts and claim their input credit as yours.
              </p>
            </div>
          )}

          {blockers.length > 0 && (
            <div className="mt-3 rounded-lg border border-error bg-error-soft p-3">
              <p className="text-sm font-medium text-error">
                This cannot post yet, so there is no entry to show
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          {preview?.notices.map((n) => (
            <div
              key={n.title}
              className={
                "mt-3 rounded-lg border p-3 " +
                (n.tone === "warning"
                  ? "border-warning bg-warning-soft"
                  : "border-border bg-surface-2")
              }
            >
              <p
                className={
                  "text-sm font-medium " + (n.tone === "warning" ? "text-warning" : "text-ink")
                }
              >
                {n.title}
              </p>
              <p className="mt-1 text-sm text-ink-soft">{n.body}</p>
            </div>
          ))}

          {/* ── Header facts ───────────────────────────────────────────── */}
          <Section title="The voucher">
            <dl className="grid gap-3 rounded-lg border border-border bg-bg p-3 sm:grid-cols-3">
              <Fact
                label="Voucher type"
                value={
                  <>
                    <span className="font-medium">{voucherType}</span>{" "}
                    <span className="text-ink-faint">— {documentLabel.toLowerCase()}</span>
                  </>
                }
              />
              <Fact label="Date" value={voucherDate || "—"} />
              <Fact
                label="Number"
                value={
                  <>
                    {numberFact}
                    {numberCaveat && (
                      <span className="mt-0.5 block text-xs text-ink-faint">{numberCaveat}</span>
                    )}
                  </>
                }
              />
              <Fact label="Party" value={partyLedgerName || "—"} />
              <Fact label="Branch" value={branchLabel || "—"} />
              <Fact label="Godown" value={godownLabel || "—"} />
              <Fact
                label="Place of supply"
                value={
                  placeOfSupply ? (
                    <>
                      {placeOfSupplyLabel || placeOfSupply}{" "}
                      <span className="text-ink-faint">({placeOfSupply})</span>
                      {preview?.supplyType && (
                        <span className="mt-0.5 block text-xs text-ink-faint">
                          {preview.intrastate === true
                            ? "same state as this branch's registration — CGST + SGST"
                            : "a different state from this branch's registration — IGST"}
                          {preview.supplyType !== "intra" && preview.supplyType !== "inter"
                            ? ` (${preview.supplyType})`
                            : ""}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-faint">not set</span>
                  )
                }
              />
              <Fact label={referenceLabel} value={referenceNumber || <span className="text-ink-faint">none</span>} />
              <Fact
                label={challanLabel}
                value={
                  challanNumber || challanDate ? (
                    <>
                      {challanNumber || "—"}
                      {challanDate && (
                        <span className="mt-0.5 block text-xs text-ink-faint">
                          dated {challanDate}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-faint">none</span>
                  )
                }
              />
              {narration.trim() && (
                <div className="sm:col-span-3">
                  <Fact label="Narration" value={narration.trim()} />
                </div>
              )}
            </dl>
          </Section>

          {/* ── The double entry ───────────────────────────────────────── */}
          {preview && preview.entries.length > 0 && (
            <Section title="The entry that will be written">
              <div className="overflow-x-auto rounded-lg border border-border bg-bg">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="text-xs text-ink-faint">
                      <th scope="col" className={cell + " text-left font-medium"}>
                        Ledger
                      </th>
                      <th scope="col" className={cell + " text-right font-medium"}>
                        Debit
                      </th>
                      <th scope="col" className={cell + " text-right font-medium"}>
                        Credit
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.entries.map((e, i) => (
                      <tr key={`${e.ledgerName}-${i}`} className="border-t border-border">
                        <th scope="row" className={cell + " text-left font-normal"}>
                          {e.ledgerName}
                          {e.ledgerNote && (
                            <span className="mt-0.5 block text-xs text-ink-faint">
                              {e.ledgerNote}
                            </span>
                          )}
                        </th>
                        <td className={money}>{e.debit ? formatINR(e.debit) : ""}</td>
                        <td className={money}>{e.credit ? formatINR(e.credit) : ""}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border-strong font-semibold">
                      <th scope="row" className={cell + " text-left"}>
                        Total
                      </th>
                      <td className={money}>{formatINR(preview.debitTotal, { showZero: true })}</td>
                      <td className={money}>{formatINR(preview.creditTotal, { showZero: true })}</td>
                    </tr>
                  </tbody>
                </table>
                <p
                  className={
                    "border-t border-border px-3 py-2 text-xs " +
                    (preview.balanced ? "text-success" : "text-error")
                  }
                >
                  {preview.balanced
                    ? "Debits equal credits. The database enforces this too — trg_voucher_entries_balance refuses a voucher whose sides differ."
                    : "Debits do not equal credits. trg_voucher_entries_balance will refuse this, which means the preview and the function disagree — do not post it; report it."}
                </p>
              </div>
            </Section>
          )}

          {/* ── Stock ──────────────────────────────────────────────────── */}
          {preview && preview.stock.length > 0 && (
            <Section
              title={
                preview.stock[0].direction === "in"
                  ? `Stock coming IN to ${godownLabel}`
                  : `Stock going OUT of ${godownLabel}`
              }
            >
              <div className="overflow-x-auto rounded-lg border border-border bg-bg">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="text-xs text-ink-faint">
                      <th scope="col" className={cell + " text-left font-medium"}>
                        Item
                      </th>
                      <th scope="col" className={cell + " text-left font-medium"}>
                        HSN
                      </th>
                      <th scope="col" className={cell + " text-right font-medium"}>
                        Quantity
                      </th>
                      <th scope="col" className={cell + " text-right font-medium"}>
                        Rate
                      </th>
                      <th scope="col" className={cell + " text-right font-medium"}>
                        Discount
                      </th>
                      <th scope="col" className={cell + " text-right font-medium"}>
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.stock.map((s, i) => (
                      <tr key={`${s.itemName}-${i}`} className="border-t border-border">
                        <th scope="row" className={cell + " text-left font-normal"}>
                          {s.itemName}
                        </th>
                        <td className={cell + " font-mono text-xs text-ink-soft"}>
                          {s.hsnSac ?? "—"}
                        </td>
                        <td className={money}>
                          {s.direction === "in" ? "+" : "−"}
                          {s.quantity} <span className="text-ink-faint">{s.uom}</span>
                        </td>
                        <td className={money}>{formatINR(s.rate, { showZero: true })}</td>
                        <td className={money}>
                          {s.discountPercent ? `${s.discountPercent}%` : "—"}
                        </td>
                        <td className={money}>{formatINR(s.amount, { showZero: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t border-border px-3 py-2 text-xs text-ink-faint">
                  The unit is the ITEM MASTER&rsquo;s, not the one printed on the paper — a voucher
                  line has no unit of its own, so create_invoice copies the master&rsquo;s.
                </p>
              </div>
            </Section>
          )}

          {/* ── Tax by rate ────────────────────────────────────────────── */}
          {preview && preview.taxRows.length > 0 && (
            <Section title="Tax, split by rate">
              <div className="overflow-x-auto rounded-lg border border-border bg-bg">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead>
                    <tr className="text-xs text-ink-faint">
                      <th scope="col" className={cell + " text-left font-medium"}>
                        Rate
                      </th>
                      <th scope="col" className={cell + " text-right font-medium"}>
                        Taxable
                      </th>
                      <th scope="col" className={cell + " text-right font-medium"}>
                        CGST
                      </th>
                      <th scope="col" className={cell + " text-right font-medium"}>
                        SGST
                      </th>
                      <th scope="col" className={cell + " text-right font-medium"}>
                        IGST
                      </th>
                      <th scope="col" className={cell + " text-right font-medium"}>
                        Cess
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.taxRows.map((r) => (
                      <tr key={r.ratePercent} className="border-t border-border">
                        <th scope="row" className={cell + " text-left font-normal"}>
                          {r.ratePercent}%{r.rcm ? " (reverse charge)" : ""}
                        </th>
                        <td className={money}>{formatINR(r.taxable, { showZero: true })}</td>
                        <td className={money}>{formatINR(r.cgst)}</td>
                        <td className={money}>{formatINR(r.sgst)}</td>
                        <td className={money}>{formatINR(r.igst)}</td>
                        <td className={money}>{formatINR(r.cess)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-border-strong font-semibold">
                      <th scope="row" className={cell + " text-left"}>
                        Total
                      </th>
                      <td className={money}>
                        {formatINR(preview.totals.taxable, { showZero: true })}
                      </td>
                      <td className={money}>{formatINR(preview.totals.cgst)}</td>
                      <td className={money}>{formatINR(preview.totals.sgst)}</td>
                      <td className={money}>{formatINR(preview.totals.igst)}</td>
                      <td className={money}>{formatINR(preview.totals.cess)}</td>
                    </tr>
                  </tbody>
                </table>
                <div className="space-y-1 border-t border-border px-3 py-2 text-xs text-ink-faint">
                  <p>
                    Invoice total, what the party is debited or credited:{" "}
                    <span className="font-mono text-ink">
                      {formatINR(preview.totals.grand, { showZero: true })}
                    </span>
                    {preview.totals.tcs > 0 && (
                      <> — including TCS of {formatINR(preview.totals.tcs)} under Sec 206C.</>
                    )}
                  </p>
                  {preview.totals.rcm > 0 && (
                    <p>
                      {formatINR(preview.totals.rcm)} of reverse-charge tax is self-assessed under
                      Sec 9(3). The supplier charges none of it, so it is not in the invoice total
                      above — it is credited to RCM Payable with a matching debit to the
                      purchase/expense ledger.
                    </p>
                  )}
                </div>
              </div>
            </Section>
          )}

          {/* ── The honest footer ──────────────────────────────────────── */}
          <Section title="What this preview cannot promise">
            <ul className="list-disc space-y-1 rounded-lg border border-border bg-surface-2 py-3 pl-8 pr-3 text-xs text-ink-soft">
              {numberCaveat && <li>{numberCaveat}</li>}
              {(preview?.unpredictable ?? []).map((u) => (
                <li key={u}>{u}</li>
              ))}
              <li>
                The tax ledgers named above are resolved by the database from this
                registration&rsquo;s tax-ledger map at the moment of posting. They are read here,
                not guessed, but an edit to that map between now and the post would change them.
              </li>
              <li>
                Everything above is arithmetic this screen performs. The figures come from the same
                inputs create_invoice will be given and follow its own formulas in its own order,
                but the authority is the function, not this dialog.
              </li>
            </ul>
          </Section>

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border-strong px-4 py-2 text-sm text-ink-soft transition-colors hover:bg-surface-2"
            >
              Close
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
