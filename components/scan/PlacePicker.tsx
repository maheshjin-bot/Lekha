"use client";

import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import type { ScanPlace } from "@/lib/scan/deviceMemory";
import type { ScanBranch, ScanCompany } from "@/lib/scan/types";

/**
 * Asked once per handset, then never again (see lib/scan/deviceMemory.ts).
 *
 * Rows are 72px tall and the whole row is the button — a thumb on a dusty
 * screen in bad light does not reliably hit a 20px label.
 */
export function PlacePicker({
  companies,
  branchesByCompany,
  onChoose,
  onCancel,
}: {
  companies: ScanCompany[];
  branchesByCompany: Record<string, ScanBranch[]>;
  onChoose: (place: ScanPlace) => void;
  onCancel?: () => void;
}) {
  const soleCompany = companies.length === 1 ? companies[0] : null;

  // Start on the branch step when there is only one business to be in — but
  // only if it actually HAS branches to choose between, otherwise the company
  // list of one is the whole question and tapping it answers everything.
  const [companyId, setCompanyId] = useState<string | null>(
    soleCompany && (branchesByCompany[soleCompany.id] ?? []).length > 0
      ? soleCompany.id
      : null
  );

  const company = companyId ? companies.find((c) => c.id === companyId) ?? null : null;
  const branches = companyId ? branchesByCompany[companyId] ?? [] : [];
  const onBranchStep = company !== null && branches.length > 0;

  function pickCompany(c: ScanCompany) {
    // No branches at all: there is no second question, so do not invent one.
    if ((branchesByCompany[c.id] ?? []).length === 0) {
      onChoose({ companyId: c.id, branchId: null });
      return;
    }
    setCompanyId(c.id);
  }

  const canGoBack = (onBranchStep && !soleCompany) || Boolean(onCancel);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-2 px-4 pb-2 pt-5">
        {canGoBack && (
          <button
            type="button"
            onClick={() => {
              if (onBranchStep && !soleCompany) setCompanyId(null);
              else onCancel?.();
            }}
            className="-ml-2 flex h-12 w-12 items-center justify-center rounded-full text-ink-soft active:bg-surface-2"
            aria-label="Back"
          >
            <ChevronLeft size={26} />
          </button>
        )}
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          {onBranchStep ? "Which place?" : "Which business?"}
        </h1>
      </header>

      <p className="px-4 pb-5 text-base text-ink-soft">
        {onBranchStep
          ? `Where is this phone kept? ${company?.name ?? ""}`
          : "This phone will remember your answer."}
      </p>

      <ul className="flex flex-col gap-2.5 px-4 pb-10">
        {!onBranchStep &&
          companies.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => pickCompany(c)}
                className="flex min-h-[72px] w-full items-center rounded-card border border-border-strong bg-surface px-5 text-left text-lg font-semibold text-ink transition-colors active:bg-accent-soft"
              >
                {c.name}
              </button>
            </li>
          ))}

        {onBranchStep && company && (
          <>
            {branches.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => onChoose({ companyId: b.company_id, branchId: b.id })}
                  className="flex min-h-[72px] w-full flex-col justify-center rounded-card border border-border-strong bg-surface px-5 text-left transition-colors active:bg-accent-soft"
                >
                  <span className="text-lg font-semibold text-ink">{b.name}</span>
                  <span className="font-mono text-xs uppercase tracking-wide text-ink-faint">
                    {b.code}
                  </span>
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => onChoose({ companyId: company.id, branchId: null })}
                className="flex min-h-[60px] w-full items-center rounded-card border border-dashed border-border-strong px-5 text-left text-base text-ink-soft transition-colors active:bg-surface-2"
              >
                Not at any of these
              </button>
            </li>
          </>
        )}
      </ul>
    </div>
  );
}
