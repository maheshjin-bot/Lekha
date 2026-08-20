"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";

type Ledger = {
  id: string;
  name: string;
  group_id: string;
  opening_balance_amount: number;
  opening_balance_type: string;
  is_active: boolean;
  pan: string | null;
  is_tds_deductee: boolean;
  default_tds_section: string | null;
  udyam_number: string | null;
  msme_category: string | null;
  msme_payment_days: number | null;
  is_partner_remuneration: boolean;
  is_related_party: boolean;
};

type Group = {
  id: string;
  name: string;
  nature: string;
  ledger_role: string;
  parent_group_id: string | null;
};

type TdsSection = { section_code: string; description: string; rate_percent: number };

// Mirrors app_private.is_valid_udyam exactly.
const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
// Mirrors app_private.is_valid_pan exactly.
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function LedgerManager({
  companyId,
  initialLedgers,
  groups,
  tdsSections,
  tdsOn,
  msmeOn,
  partnerRemunerationOn,
  relatedPartyOn,
}: {
  companyId: string;
  initialLedgers: Ledger[];
  groups: Group[];
  tdsSections: TdsSection[];
  tdsOn: boolean;
  msmeOn: boolean;
  partnerRemunerationOn: boolean;
  relatedPartyOn: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  // Sub-groups are where ledgers normally live; the eight primary groups are
  // structural. Default to the first sub-group so the common case is one click.
  const [groupId, setGroupId] = useState(
    groups.find((g) => g.parent_group_id)?.id ?? groups[0]?.id ?? ""
  );
  const [opening, setOpening] = useState("0");
  const [openingType, setOpeningType] = useState<"debit" | "credit">("debit");
  const [pan, setPan] = useState("");
  const [isTdsDeductee, setIsTdsDeductee] = useState(false);
  const [tdsSection, setTdsSection] = useState("");
  const [isMsme, setIsMsme] = useState(false);
  const [udyam, setUdyam] = useState("");
  const [msmeCategory, setMsmeCategory] = useState("");
  const [msmePaymentDays, setMsmePaymentDays] = useState("");
  const [isPartnerRemuneration, setIsPartnerRemuneration] = useState(false);
  const [isRelatedParty, setIsRelatedParty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? "—";
  const sectionRate = (code: string | null) =>
    tdsSections.find((s) => s.section_code === code)?.rate_percent;
  const udyamLooksValid = udyam.length === 0 || UDYAM_PATTERN.test(udyam);
  const panLooksValid = pan.length === 0 || PAN_PATTERN.test(pan);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient().from("ledgers").insert({
      company_id: companyId,
      group_id: groupId,
      name: name.trim(),
      opening_balance_amount: Number(opening) || 0,
      opening_balance_type: openingType,
      pan: pan.trim() || null,
      is_tds_deductee: isTdsDeductee,
      default_tds_section: isTdsDeductee ? tdsSection || null : null,
      udyam_number: isMsme ? udyam.trim() || null : null,
      msme_category: isMsme ? msmeCategory || null : null,
      msme_payment_days: isMsme && msmePaymentDays ? Number(msmePaymentDays) : null,
      is_partner_remuneration: isPartnerRemuneration,
      is_related_party: isRelatedParty,
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    setName("");
    setOpening("0");
    setPan("");
    setIsTdsDeductee(false);
    setTdsSection("");
    setIsMsme(false);
    setUdyam("");
    setMsmeCategory("");
    setMsmePaymentDays("");
    setIsPartnerRemuneration(false);
    setIsRelatedParty(false);
    setBusy(false);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Ledger</th>
                <th className="px-4 py-2.5 font-medium">Group</th>
                <th className="px-4 py-2.5 font-medium">PAN</th>
                {tdsOn && <th className="px-4 py-2.5 font-medium">TDS</th>}
                {msmeOn && <th className="px-4 py-2.5 font-medium">MSME</th>}
                {partnerRemunerationOn && <th className="px-4 py-2.5 font-medium">Sec 40(b)</th>}
                {relatedPartyOn && <th className="px-4 py-2.5 font-medium">Related party</th>}
                <th className="px-4 py-2.5 text-right font-medium">Opening</th>
              </tr>
            </thead>
            <tbody>
              {initialLedgers.length === 0 && (
                <tr>
                  <td
                    colSpan={
                      4 +
                      (tdsOn ? 1 : 0) +
                      (msmeOn ? 1 : 0) +
                      (partnerRemunerationOn ? 1 : 0) +
                      (relatedPartyOn ? 1 : 0)
                    }
                    className="px-4 py-10 text-center text-ink-faint"
                  >
                    No ledgers yet. Create one on the right.
                  </td>
                </tr>
              )}
              {initialLedgers.map((l) => (
                <tr
                  key={l.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-4 py-2.5 font-medium">{l.name}</td>
                  <td className="px-4 py-2.5 text-ink-soft">
                    {groupName(l.group_id)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-soft">
                    {l.pan ?? <span className="text-ink-faint">—</span>}
                  </td>
                  {tdsOn && (
                    <td className="px-4 py-2.5 text-ink-soft">
                      {l.is_tds_deductee ? (
                        <span className="font-mono text-xs">
                          {l.default_tds_section ?? "—"}
                          {sectionRate(l.default_tds_section) != null && (
                            <span className="ml-1 text-ink-faint">
                              {sectionRate(l.default_tds_section)}%
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  )}
                  {msmeOn && (
                    <td className="px-4 py-2.5 text-ink-soft">
                      {l.udyam_number ? (
                        <span className="text-xs capitalize">
                          {l.msme_category ?? "MSME"}
                          <span className="ml-1 text-ink-faint">
                            {l.msme_payment_days ?? 15}d
                          </span>
                        </span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  )}
                  {partnerRemunerationOn && (
                    <td className="px-4 py-2.5 text-ink-soft">
                      {l.is_partner_remuneration ? (
                        <span className="text-xs">Remuneration</span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  )}
                  {relatedPartyOn && (
                    <td className="px-4 py-2.5 text-ink-soft">
                      {l.is_related_party ? (
                        <span className="text-xs">Sec 40A(2)(b)</span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-right tabular-nums font-mono">
                    {l.opening_balance_amount > 0 ? (
                      <>
                        {formatINR(l.opening_balance_amount)}
                        <span className="ml-1.5 text-[10px] uppercase text-ink-faint">
                          {l.opening_balance_type === "debit" ? "Dr" : "Cr"}
                        </span>
                      </>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">New ledger</h2>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              PAN{" "}
              <span className="font-normal text-ink-faint">
                optional — sets the TCS no-PAN rate, shown on GST documents
              </span>
            </span>
            <input
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              maxLength={10}
              placeholder="AAAAA0000A"
              className={field + " font-mono uppercase"}
            />
            {pan.length > 0 && !panLooksValid && (
              <span className="text-xs text-warning">
                That doesn&rsquo;t match the PAN format (5 letters, 4 digits,
                1 letter).
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Group</span>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className={field}
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.parent_group_id ? "  " : ""}
                  {g.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-[1fr_auto] gap-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Opening balance</span>
              <input
                inputMode="decimal"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                className={field + " text-right tabular-nums"}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Side</span>
              <select
                value={openingType}
                onChange={(e) => setOpeningType(e.target.value as "debit" | "credit")}
                className={field}
              >
                <option value="debit">Dr</option>
                <option value="credit">Cr</option>
              </select>
            </label>
          </div>

          {tdsOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isTdsDeductee}
                  onChange={(e) => {
                    setIsTdsDeductee(e.target.checked);
                    if (!e.target.checked) setTdsSection("");
                  }}
                />
                TDS deductee
              </label>
              {isTdsDeductee && (
                <label className="mt-2 flex flex-col gap-1.5">
                  <span className="text-xs text-ink-faint">
                    Default section — a starting point offered when this ledger
                    is used in a voucher; the threshold is yours to check, not
                    checked automatically
                  </span>
                  <select
                    value={tdsSection}
                    onChange={(e) => setTdsSection(e.target.value)}
                    className={field}
                  >
                    <option value="">Not set</option>
                    {tdsSections.map((s) => (
                      <option key={s.section_code} value={s.section_code}>
                        {s.section_code} — {s.rate_percent}%
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {/* Lower/nil deduction certificates (Sec 197) are a real but
                  uncommon case — left to a future edit surface rather than
                  crowding the create form; ledgers.ldc_* columns already
                  support it, this form just doesn't set them yet. */}
            </div>
          )}

          {msmeOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isMsme}
                  onChange={(e) => {
                    setIsMsme(e.target.checked);
                    if (!e.target.checked) {
                      setUdyam("");
                      setMsmeCategory("");
                      setMsmePaymentDays("");
                    }
                  }}
                />
                MSME supplier (Sec 43B(h))
              </label>
              {isMsme && (
                <div className="mt-2 flex flex-col gap-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-ink-faint">Udyam number</span>
                    <input
                      value={udyam}
                      onChange={(e) => setUdyam(e.target.value.toUpperCase())}
                      placeholder="UDYAM-XX-00-0000000"
                      className={field + " font-mono uppercase"}
                    />
                    {udyam.length > 0 && !udyamLooksValid && (
                      <span className="text-xs text-warning">
                        That doesn&rsquo;t match the Udyam number format.
                      </span>
                    )}
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-ink-faint">Category</span>
                      <select
                        value={msmeCategory}
                        onChange={(e) => setMsmeCategory(e.target.value)}
                        className={field}
                      >
                        <option value="">Not set</option>
                        <option value="micro">Micro</option>
                        <option value="small">Small</option>
                        <option value="medium">Medium</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-ink-faint">
                        Payment deadline (days)
                      </span>
                      <input
                        inputMode="numeric"
                        value={msmePaymentDays}
                        onChange={(e) => setMsmePaymentDays(e.target.value)}
                        placeholder="15"
                        className={field}
                      />
                    </label>
                  </div>
                  <span className="text-xs text-ink-faint">
                    45 days only applies with a written agreement — leave this
                    blank to use the safer 15-day default.
                  </span>
                </div>
              )}
            </div>
          )}

          {partnerRemunerationOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isPartnerRemuneration}
                  onChange={(e) => setIsPartnerRemuneration(e.target.checked)}
                />
                Partner remuneration (Sec 40(b))
              </label>
              <span className="mt-1 block text-xs text-ink-faint">
                Salary/bonus/commission paid to a working partner — the
                income tax report tests what&rsquo;s posted here against the
                slab ceiling and flags any excess.
              </span>
            </div>
          )}

          {relatedPartyOn && (
            <div className="rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={isRelatedParty}
                  onChange={(e) => setIsRelatedParty(e.target.checked)}
                />
                Specified person (Sec 40A(2)(b))
              </label>
              <span className="mt-1 block text-xs text-ink-faint">
                A director, partner, their relative, or an entity in which
                the assessee/director/partner has a substantial interest —
                the tax audit report lists actual payments made to this
                ledger under Form 3CD clause 23.
              </span>
            </div>
          )}

          {error && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add ledger"}
          </button>
        </form>
      </section>
    </div>
  );
}
