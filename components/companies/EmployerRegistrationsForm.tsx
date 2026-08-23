"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const field =
  "rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none";

type Branch = {
  id: string;
  code: string;
  name: string;
  state_code: string | null;
  pt_registration_number: string | null;
  pt_enrolment_number: string | null;
  lwf_establishment_code: string | null;
};

export function EmployerRegistrationsForm({
  companyId,
  company,
  branches,
}: {
  companyId: string;
  company: {
    pf_establishment_code: string | null;
    esi_employer_code: string | null;
    lin: string | null;
    shops_establishment_reg: string | null;
  };
  branches: Branch[];
}) {
  const router = useRouter();
  const [pf, setPf] = useState(company.pf_establishment_code ?? "");
  const [esi, setEsi] = useState(company.esi_employer_code ?? "");
  const [lin, setLin] = useState(company.lin ?? "");
  const [shops, setShops] = useState(company.shops_establishment_reg ?? "");
  const [branchState, setBranchState] = useState<Branch[]>(branches);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Mirrors the database check: 17 digits once separators are stripped, so the
  // user finds out here rather than from a constraint violation.
  const esiDigits = esi.replace(/[^0-9]/g, "").length;
  const esiLooksValid = esi.trim().length === 0 || esiDigits === 17;

  function updateBranch(id: string, patch: Partial<Branch>) {
    setBranchState((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const supabase = createClient();

    const { error: companyError } = await supabase
      .from("companies")
      .update({
        pf_establishment_code: pf.trim() || null,
        esi_employer_code: esi.trim() || null,
        lin: lin.trim() || null,
        shops_establishment_reg: shops.trim() || null,
      })
      .eq("id", companyId);

    if (companyError) {
      setBusy(false);
      setError(companyError.message);
      return;
    }

    for (const b of branchState) {
      const { error: branchError } = await supabase
        .from("branches")
        .update({
          pt_registration_number: b.pt_registration_number?.trim() || null,
          pt_enrolment_number: b.pt_enrolment_number?.trim() || null,
          lwf_establishment_code: b.lwf_establishment_code?.trim() || null,
        })
        .eq("id", b.id);
      if (branchError) {
        setBusy(false);
        setError(`${b.name}: ${branchError.message}`);
        return;
      }
    }

    setBusy(false);
    setNotice("Saved.");
    router.refresh();
  }

  return (
    <form onSubmit={onSave} className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-semibold text-ink">The employer</h2>
          <p className="mt-0.5 text-xs text-ink-faint">
            One set for the business as a whole. Each of these appears in the header of the return
            it belongs to.
          </p>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">PF establishment code</span>
            <input
              value={pf}
              onChange={(e) => setPf(e.target.value)}
              placeholder="MH/BAN/0000064/000"
              className={field + " font-mono"}
            />
            <span className="text-xs text-ink-faint">
              Region, office, establishment number and extension. Written with or without slashes —
              either is accepted.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">ESI employer code</span>
            <input
              value={esi}
              onChange={(e) => setEsi(e.target.value)}
              placeholder="11-00-123456-000-1001"
              className={
                field + " font-mono " + (esiLooksValid ? "" : "border-error focus:border-error")
              }
            />
            <span className={"text-xs " + (esiLooksValid ? "text-ink-faint" : "text-error")}>
              {esiLooksValid
                ? "17 digits, from your C-11 registration letter. Punctuation optional."
                : `17 digits required — this has ${esiDigits}.`}
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              LIN <span className="font-normal text-ink-faint">optional</span>
            </span>
            <input
              value={lin}
              onChange={(e) => setLin(e.target.value)}
              className={field + " font-mono"}
            />
            <span className="text-xs text-ink-faint">
              Labour Identification Number, if you have one under Shram Suvidha.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Shops &amp; Establishment <span className="font-normal text-ink-faint">optional</span>
            </span>
            <input
              value={shops}
              onChange={(e) => setShops(e.target.value)}
              className={field + " font-mono"}
            />
            <span className="text-xs text-ink-faint">Registration number, issued by the State.</span>
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-semibold text-ink">Professional tax and labour welfare, by State</h2>
          <p className="mt-0.5 text-xs text-ink-faint">
            Both are State levies, so they are held per branch rather than once for the company — an
            employer operating in three States holds three registrations, with different rates and
            different due dates.
          </p>
        </div>

        {branchState.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-ink-faint">
            This company has no branches on record.
          </p>
        )}

        {branchState.map((b) => (
          <div key={b.id} className="border-b border-border p-4 last:border-0">
            <div className="mb-2 text-sm font-medium text-ink">
              {b.name}
              <span className="ml-2 font-mono text-xs text-ink-faint">{b.code}</span>
              {b.state_code && (
                <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-ink-soft">
                  State {b.state_code}
                </span>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">PT registration (PTRC)</span>
                <input
                  value={b.pt_registration_number ?? ""}
                  onChange={(e) => updateBranch(b.id, { pt_registration_number: e.target.value })}
                  className={field + " font-mono"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">PT enrolment (PTEC)</span>
                <input
                  value={b.pt_enrolment_number ?? ""}
                  onChange={(e) => updateBranch(b.id, { pt_enrolment_number: e.target.value })}
                  className={field + " font-mono"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-ink-faint">LWF code</span>
                <input
                  value={b.lwf_establishment_code ?? ""}
                  onChange={(e) => updateBranch(b.id, { lwf_establishment_code: e.target.value })}
                  className={field + " font-mono"}
                />
              </label>
            </div>
          </div>
        ))}
      </section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !esiLooksValid}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {error && <p className="text-sm text-error">{error}</p>}
        {notice && <p className="text-sm text-ink-soft">{notice}</p>}
      </div>
    </form>
  );
}
