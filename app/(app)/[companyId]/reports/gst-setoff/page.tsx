import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { PostGstSetoffButton } from "@/components/gst/PostGstSetoffButton";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

type Leg = {
  step: number;
  row_kind: "output_opening" | "input_opening" | "utilisation" | "net_payable" | "itc_carried_forward";
  tax_head: "cgst" | "sgst" | "igst" | "cess";
  credit_head: "cgst" | "sgst" | "igst" | "cess" | null;
  amount: number;
  narration: string;
};

const HEAD_LABEL: Record<string, string> = {
  cgst: "CGST",
  sgst: "SGST/UTGST",
  igst: "IGST",
  cess: "Cess",
};

const HEADS = ["cgst", "sgst", "igst", "cess"] as const;

export default async function GstSetoffPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/gst-setoff">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const asAt = typeof sp.as_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.as_at)
    ? sp.as_at
    : todayLocal();
  const regParam = typeof sp.reg === "string" ? sp.reg : undefined;

  const [{ data: modules }, { data: registrations }, { data: branch }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase
      .from("gst_registrations")
      .select("id, gstin, state_code")
      .eq("company_id", companyId)
      .order("gstin"),
    supabase
      .from("branches")
      .select("id")
      .eq("company_id", companyId)
      .order("is_head_office", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);

  if (!gstOn) {
    return (
      <ReportShell title="GST set-off" period={`As at ${formatDate(asAt)}`}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">GST is not on for this company</p>
          <p className="mt-1">
            Add a GST registration first —{" "}
            <Link href={`/${companyId}/registrations`} className="underline">
              Registrations
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const regs = registrations ?? [];
  const regId = regParam && regs.some((r) => r.id === regParam) ? regParam : regs[0]?.id;

  if (!regId) {
    return (
      <ReportShell title="GST set-off" period={`As at ${formatDate(asAt)}`}>
        <div className="m-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-semibold">No GST registration yet</p>
          <p className="mt-1">
            Set-off is computed per registration — add one at{" "}
            <Link href={`/${companyId}/registrations`} className="underline">
              Registrations
            </Link>
            .
          </p>
        </div>
      </ReportShell>
    );
  }

  const { data: legRows, error: legError } = await supabase.rpc("get_gst_setoff_computation", {
    p_company_id: companyId,
    p_gst_registration_id: regId,
    p_as_at: asAt,
  });

  const legs = (legRows ?? []) as Leg[];

  const outputOpening: Record<string, number> = {};
  const inputOpening: Record<string, number> = {};
  const netPayable: Record<string, number> = {};
  const carriedForward: Record<string, number> = {};
  const utilByOutputHead: Record<string, { credit_head: string; amount: number }[]> = {
    cgst: [], sgst: [], igst: [], cess: [],
  };
  const utilByCreditHead: Record<string, { tax_head: string; amount: number }[]> = {
    cgst: [], sgst: [], igst: [], cess: [],
  };

  for (const leg of legs) {
    if (leg.row_kind === "output_opening") outputOpening[leg.tax_head] = Number(leg.amount);
    if (leg.row_kind === "input_opening") inputOpening[leg.tax_head] = Number(leg.amount);
    if (leg.row_kind === "net_payable") netPayable[leg.tax_head] = Number(leg.amount);
    if (leg.row_kind === "itc_carried_forward") carriedForward[leg.tax_head] = Number(leg.amount);
    if (leg.row_kind === "utilisation" && leg.credit_head) {
      utilByOutputHead[leg.tax_head]?.push({ credit_head: leg.credit_head, amount: Number(leg.amount) });
      utilByCreditHead[leg.credit_head]?.push({ tax_head: leg.tax_head, amount: Number(leg.amount) });
    }
  }

  const totalOutput = HEADS.reduce((n, h) => n + (outputOpening[h] ?? 0), 0);
  const totalInput = HEADS.reduce((n, h) => n + (inputOpening[h] ?? 0), 0);
  const totalNetPayable = HEADS.reduce((n, h) => n + (netPayable[h] ?? 0), 0);
  const totalCarriedForward = HEADS.reduce((n, h) => n + (carriedForward[h] ?? 0), 0);
  const nothingToClear = totalOutput === 0;

  const base = `/${companyId}/reports/gst-setoff`;

  return (
    <ReportShell
      title="GST set-off"
      period={`As at ${formatDate(asAt)} · Sec 49/49A/49B, Rule 88A — not a filing`}
      status={{
        label: legError
          ? "Could not compute"
          : nothingToClear
            ? "Nothing to clear"
            : `${formatINR(totalNetPayable, { showZero: true })} net payable`,
        tone: legError ? "bad" : nothingToClear ? "ok" : totalNetPayable > 0 ? "warn" : "ok",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <form className="flex items-center gap-2 text-sm" action="">
          <input type="hidden" name="reg" value={regId} />
          <label htmlFor="as_at" className="text-ink-soft">
            As at
          </label>
          <input
            type="date"
            id="as_at"
            name="as_at"
            defaultValue={asAt}
            className="rounded-md border border-border-strong bg-surface px-2 py-1"
          />
          <button
            type="submit"
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            Show
          </button>
        </form>

        {regs.length > 1 && (
          <div className="flex items-center gap-2 text-sm">
            {regs.map((r) => (
              <Link
                key={r.id}
                href={`${base}?as_at=${asAt}&reg=${r.id}`}
                className={
                  "rounded-md border px-2.5 py-1 font-mono text-xs " +
                  (regId === r.id ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
                }
              >
                {r.gstin}
              </Link>
            ))}
          </div>
        )}

        {!legError && !nothingToClear && branch?.id && (
          <PostGstSetoffButton
            companyId={companyId}
            branchId={branch.id}
            registrationId={regId}
            asAt={asAt}
            asAtLabel={formatDate(asAt)}
            netPayable={totalNetPayable}
            totalToClear={totalOutput}
          />
        )}
      </div>

      {legError && (
        <div className="m-4 rounded-md bg-error-soft px-4 py-3 text-sm text-error">
          {legError.message}
        </div>
      )}

      {!legError && (
        <>
          <div className="grid gap-px border-b border-border bg-border sm:grid-cols-4">
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Output tax outstanding</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(totalOutput, { showZero: true })}
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Input credit available</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(totalInput, { showZero: true })}
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">Net payable → GST Payable</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(totalNetPayable, { showZero: true })}
              </div>
            </div>
            <div className="bg-surface px-4 py-3">
              <div className="text-xs text-ink-faint">ITC carried forward</div>
              <div className="mt-0.5 font-mono text-lg tabular-nums text-ink">
                {formatINR(totalCarriedForward, { showZero: true })}
              </div>
            </div>
          </div>

          <div className="border-b border-border p-4">
            <h2 className="font-semibold">Output tax — covered by credit, in order</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Each output head&rsquo;s liability, which credit head(s) covered how much of it (IGST
              credit is applied first — Sec 49A — before CGST or SGST credit is touched at all),
              and what is left over as net payable.
            </p>
          </div>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Output head</th>
                <th className={th}>Liability</th>
                <th className={th}>Covered by</th>
                <th className={th + " text-right"}>Net payable</th>
              </tr>
            </thead>
            <tbody>
              {HEADS.map((h) => (
                <tr key={h} className="border-b border-border last:border-0 align-top">
                  <td className={td + " font-medium"}>{HEAD_LABEL[h]}</td>
                  <td className={num}>{formatINR(outputOpening[h] ?? 0, { showZero: true })}</td>
                  <td className={td}>
                    {(utilByOutputHead[h] ?? []).length === 0 ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {utilByOutputHead[h].map((u, i) => (
                          <li key={i}>
                            {HEAD_LABEL[u.credit_head]} credit — {formatINR(u.amount, { showZero: true })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className={num + ((netPayable[h] ?? 0) > 0 ? " font-semibold text-warning" : "")}>
                    {formatINR(netPayable[h] ?? 0, { showZero: true })}
                  </td>
                </tr>
              ))}
              <tr className="bg-bg font-semibold">
                <td className={td}>Total</td>
                <td className={num}>{formatINR(totalOutput, { showZero: true })}</td>
                <td className={td}></td>
                <td className={num}>{formatINR(totalNetPayable, { showZero: true })}</td>
              </tr>
            </tbody>
          </table>

          <div className="border-b border-t border-border p-4">
            <h2 className="font-semibold">Input credit — where it went</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Each credit head&rsquo;s available balance, which output head(s) it was applied against,
              and what is left unutilised. Carried-forward credit is not moved anywhere — it stays
              in the input ledger it already sits in until a later period&rsquo;s liability absorbs it.
            </p>
          </div>
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className={th}>Credit head</th>
                <th className={th}>Available</th>
                <th className={th}>Applied to</th>
                <th className={th + " text-right"}>Carried forward</th>
              </tr>
            </thead>
            <tbody>
              {HEADS.map((h) => (
                <tr key={h} className="border-b border-border last:border-0 align-top">
                  <td className={td + " font-medium"}>{HEAD_LABEL[h]}</td>
                  <td className={num}>{formatINR(inputOpening[h] ?? 0, { showZero: true })}</td>
                  <td className={td}>
                    {(utilByCreditHead[h] ?? []).length === 0 ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {utilByCreditHead[h].map((u, i) => (
                          <li key={i}>
                            {HEAD_LABEL[u.tax_head]} output — {formatINR(u.amount, { showZero: true })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className={num}>{formatINR(carriedForward[h] ?? 0, { showZero: true })}</td>
                </tr>
              ))}
              <tr className="bg-bg font-semibold">
                <td className={td}>Total</td>
                <td className={num}>{formatINR(totalInput, { showZero: true })}</td>
                <td className={td}></td>
                <td className={num}>{formatINR(totalCarriedForward, { showZero: true })}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Order of set-off: IGST credit is utilised first, in full, against IGST output then CGST
        output then SGST/UTGST output (Sec 49A; the order across CGST/SGST is this app&rsquo;s choice —
        the law allows any order or proportion, per Rule 88A) — before a rupee of CGST or SGST
        credit is touched at all. CGST credit then goes to CGST output, and only the remainder to
        IGST output; SGST credit to SGST/UTGST output, then IGST output. CGST credit never covers
        SGST output or vice versa — Sec 49(5)(c)/(d) bar that outright. Cess is its own lane,
        never mixed with CGST/SGST/IGST in either direction. RCM Payable is excluded — Sec 49(4)
        bars ITC from paying reverse-charge tax, which must be settled in cash.
      </p>
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Posting writes one journal dated {formatDate(asAt)}: debits each output-tax ledger to nil,
        credits each input-tax ledger by exactly what it funded, and credits GST Payable with the
        shortfall, if any. Unutilised credit is never pushed into GST Refund Receivable — that
        ledger is for an actual Rule 89 refund claim, which this screen does not compute; ordinary
        carried-forward ITC simply stays in the input ledger until a later period absorbs it. This
        reads live ledger balances, so it is safe to re-run — a period with nothing new to clear is
        refused rather than double-posted. After posting, record the payment itself as a challan on{" "}
        <Link href={`/${companyId}/tax-payments`} className="underline">
          Tax payments
        </Link>
        , against the GST Payable balance — this screen does not generate a PMT-06.
      </p>
    </ReportShell>
  );
}
