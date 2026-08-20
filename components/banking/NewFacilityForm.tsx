"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function NewFacilityForm({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [bankName, setBankName] = useState("");
  const [facilityType, setFacilityType] = useState("cc_od");
  const [sanctionedLimit, setSanctionedLimit] = useState("0");
  const [stockMargin, setStockMargin] = useState("25");
  const [debtorMargin, setDebtorMargin] = useState("40");
  const [eligibilityDays, setEligibilityDays] = useState("90");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient().from("banking_facilities").insert({
      company_id: companyId,
      bank_name: bankName.trim(),
      facility_type: facilityType,
      sanctioned_limit: Number(sanctionedLimit) || 0,
      stock_margin_percent: Number(stockMargin) || 0,
      debtor_margin_percent: Number(debtorMargin) || 0,
      debtor_eligibility_days: Number(eligibilityDays),
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    setBankName("");
    setFacilityType("cc_od");
    setSanctionedLimit("0");
    setStockMargin("25");
    setDebtorMargin("40");
    setEligibilityDays("90");
    setBusy(false);
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border-strong px-2.5 py-1 text-sm hover:bg-surface-2"
      >
        + Add facility
      </button>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-3"
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-faint">Bank / facility name</span>
        <input
          required
          value={bankName}
          onChange={(e) => setBankName(e.target.value)}
          placeholder="e.g. HDFC Bank CC"
          className={field}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-faint">Type</span>
        <select value={facilityType} onChange={(e) => setFacilityType(e.target.value)} className={field}>
          <option value="cc_od">CC / OD</option>
          <option value="term_loan">Term loan</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-faint">Sanctioned limit</span>
        <input
          inputMode="decimal"
          value={sanctionedLimit}
          onChange={(e) => setSanctionedLimit(e.target.value)}
          className={field + " w-32 text-right tabular-nums"}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-faint">Stock margin %</span>
        <input
          inputMode="decimal"
          value={stockMargin}
          onChange={(e) => setStockMargin(e.target.value)}
          className={field + " w-20 text-right tabular-nums"}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-faint">Debtor margin %</span>
        <input
          inputMode="decimal"
          value={debtorMargin}
          onChange={(e) => setDebtorMargin(e.target.value)}
          className={field + " w-20 text-right tabular-nums"}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-faint">Eligibility (days)</span>
        <select
          value={eligibilityDays}
          onChange={(e) => setEligibilityDays(e.target.value)}
          className={field}
        >
          <option value="30">30</option>
          <option value="60">60</option>
          <option value="90">90</option>
        </select>
      </label>
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Adding…" : "Add"}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:bg-surface-2"
      >
        Cancel
      </button>
      {error && <p className="w-full text-xs text-error">{error}</p>}
    </form>
  );
}
