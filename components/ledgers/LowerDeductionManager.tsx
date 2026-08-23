"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const field =
  "rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none";

type Deductee = {
  id: string;
  name: string;
  default_tds_section: string | null;
  ldc_number: string | null;
  ldc_rate: number | null;
  ldc_valid_from: string | null;
  ldc_valid_to: string | null;
  ldc_amount_cap: number | null;
};

type Section = { section_code: string; description: string; rate_percent: number };

export function LowerDeductionManager({
  deductees,
  sections,
  today,
}: {
  deductees: Deductee[];
  sections: Section[];
  today: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [number, setNumber] = useState("");
  const [rate, setRate] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sectionRate = (code: string | null) =>
    sections.find((s) => s.section_code === code)?.rate_percent ?? null;

  function startEdit(d: Deductee) {
    setEditing(d.id);
    setNumber(d.ldc_number ?? "");
    setRate(d.ldc_rate != null ? String(d.ldc_rate) : "");
    setFrom(d.ldc_valid_from ?? "");
    setTo(d.ldc_valid_to ?? "");
    setCap(d.ldc_amount_cap != null ? String(d.ldc_amount_cap) : "");
    setError(null);
  }

  async function onSave(e: React.FormEvent, d: Deductee) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient()
      .from("ledgers")
      .update({
        ldc_number: number.trim() || null,
        // The database refuses a rate without a window, and VoucherForm would
        // ignore one anyway — so send the whole certificate or none of it.
        ldc_rate: number.trim() ? Number(rate) : null,
        ldc_valid_from: number.trim() ? from : null,
        ldc_valid_to: number.trim() ? to : null,
        ldc_amount_cap: number.trim() && cap.trim() ? Number(cap) : null,
      })
      .eq("id", d.id);

    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setEditing(null);
    router.refresh();
  }

  async function onClear(d: Deductee) {
    if (!confirm(`Remove the certificate on ${d.name}? TDS will go back to the full section rate.`))
      return;
    setBusy(true);
    const { error } = await createClient()
      .from("ledgers")
      .update({
        ldc_number: null,
        ldc_rate: null,
        ldc_valid_from: null,
        ldc_valid_to: null,
        ldc_amount_cap: null,
      })
      .eq("id", d.id);
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.refresh();
  }

  const withCert = deductees.filter((d) => d.ldc_number);
  const without = deductees.filter((d) => !d.ldc_number);

  function status(d: Deductee) {
    if (!d.ldc_valid_from || !d.ldc_valid_to) return null;
    if (today > d.ldc_valid_to) return { label: "Expired", tone: "bg-error-soft" };
    if (today < d.ldc_valid_from) return { label: "Not yet in force", tone: "bg-warning-soft" };
    return { label: "Active", tone: "bg-success-soft" };
  }

  function renderRow(d: Deductee) {
    const s = status(d);
    const normal = sectionRate(d.default_tds_section);
    const higherThanSection = d.ldc_rate != null && normal != null && d.ldc_rate > normal;

    return (
      <div key={d.id} className="border-b border-border p-4 last:border-0">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="text-sm font-medium text-ink">
              {d.name}
              {s && (
                <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${s.tone}`}>{s.label}</span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-ink-faint">
              {d.default_tds_section ? (
                <>
                  Section {d.default_tds_section}
                  {normal != null && ` — normally ${normal}%`}
                </>
              ) : (
                <span className="text-warning">
                  No TDS section set on this ledger — a certificate has nothing to override
                </span>
              )}
            </div>
            {d.ldc_number && editing !== d.id && (
              <div className="mt-1 text-xs text-ink-soft">
                <span className="font-mono">{d.ldc_number}</span> · deduct at{" "}
                <strong className="font-medium text-ink">{d.ldc_rate}%</strong> from{" "}
                {d.ldc_valid_from} to {d.ldc_valid_to}
                {d.ldc_amount_cap != null && (
                  <> · only up to ₹{Number(d.ldc_amount_cap).toLocaleString("en-IN")} per line</>
                )}
              </div>
            )}
          </div>
          {editing !== d.id && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => startEdit(d)}
                className="text-xs underline hover:text-ink"
              >
                {d.ldc_number ? "Edit" : "Add certificate"}
              </button>
              {d.ldc_number && (
                <button
                  type="button"
                  onClick={() => onClear(d)}
                  disabled={busy}
                  className="text-xs text-ink-faint underline hover:text-error disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
          )}
        </div>

        {editing === d.id && (
          <form onSubmit={(e) => onSave(e, d)} className="mt-3 flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Certificate number</span>
                <input
                  required
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  className={field + " font-mono"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Deduct at (%)</span>
                <input
                  required
                  inputMode="decimal"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">
                  Amount cap <span className="text-ink-faint">optional</span>
                </span>
                <input
                  inputMode="decimal"
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  className={field + " text-right tabular-nums"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Valid from</span>
                <input
                  required
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className={field}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">Valid to</span>
                <input
                  required
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className={field}
                />
              </label>
            </div>

            {higherThanSection && (
              <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-ink">
                {rate}% is above the {normal}% this section normally attracts. A Sec 197 certificate
                lowers a rate; check the figure before saving.
              </p>
            )}
            {error && <p className="text-xs text-error">{error}</p>}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save certificate"}
              </button>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="text-sm text-ink-faint underline hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    );
  }

  return (
    <div>
      {deductees.length === 0 && (
        <p className="px-4 py-10 text-center text-sm text-ink-faint">
          No ledger is marked as a TDS deductee yet. Mark a vendor as one on the Ledgers screen
          first — a certificate belongs to a party you deduct from.
        </p>
      )}

      {withCert.length > 0 && (
        <>
          <div className="border-b border-border bg-bg px-4 py-2 text-xs font-medium text-ink-soft">
            With a certificate
          </div>
          {withCert.map(renderRow)}
        </>
      )}

      {without.length > 0 && (
        <>
          <div className="border-b border-t border-border bg-bg px-4 py-2 text-xs font-medium text-ink-soft">
            Deducted at the full section rate
          </div>
          {without.map(renderRow)}
        </>
      )}
    </div>
  );
}
