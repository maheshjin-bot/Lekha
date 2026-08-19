import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * GST returns run on the calendar month, never the company's own financial
 * year — same principle as every other statutory report in this app
 * (compliance calendar, tax depreciation, income tax, tax audit). `month`
 * is "YYYY-MM"; defaults to the current calendar month.
 */
function monthBounds(month?: string): { from: string; to: string; label: string; ym: string } {
  const today = todayLocal();
  const [ty, tm] = today.split("-").map(Number);
  let y = ty;
  let m = tm;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    [y, m] = month.split("-").map(Number);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const from = `${y}-${pad(m)}-01`;
  // Day 0 of next month = last day of this month.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${pad(m)}-${pad(lastDay)}`;
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return { from, to, label, ym: `${y}-${pad(m)}` };
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type RegisterRow = {
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  voucher_type: string;
  party_name: string | null;
  party_gstin: string | null;
  place_of_supply: string | null;
  supply_type: string | null;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  invoice_value: number;
};

const TYPE_LABEL: Record<string, string> = {
  sales: "Sales",
  credit_note: "Credit note",
  purchase: "Purchase",
  debit_note: "Debit note",
};

function RegisterTable({ rows }: { rows: RegisterRow[] }) {
  const totals = rows.reduce(
    (acc, r) => ({
      taxable: acc.taxable + Number(r.taxable_value),
      cgst: acc.cgst + Number(r.cgst),
      sgst: acc.sgst + Number(r.sgst),
      igst: acc.igst + Number(r.igst),
      cess: acc.cess + Number(r.cess),
      total: acc.total + Number(r.invoice_value),
    }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 }
  );

  return (
    <table className="w-full min-w-[900px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Date</th>
          <th className={th}>Number</th>
          <th className={th}>Type</th>
          <th className={th}>Party</th>
          <th className={th}>GSTIN</th>
          <th className={th}>Supply</th>
          <th className={th + " text-right"}>Taxable</th>
          <th className={th + " text-right"}>CGST</th>
          <th className={th + " text-right"}>SGST</th>
          <th className={th + " text-right"}>IGST</th>
          <th className={th + " text-right"}>Cess</th>
          <th className={th + " text-right"}>Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={12} className="px-4 py-10 text-center text-ink-faint">
              Nothing this month.
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr key={r.voucher_id} className="border-b border-border last:border-0">
            <td className={td + " whitespace-nowrap"}>{r.voucher_date}</td>
            <td className={td + " font-mono text-xs"}>{r.voucher_number}</td>
            <td className={td}>{TYPE_LABEL[r.voucher_type] ?? r.voucher_type}</td>
            <td className={td}>{r.party_name ?? "—"}</td>
            <td className={td + " font-mono text-xs text-ink-faint"}>
              {r.party_gstin ?? "Unregistered"}
            </td>
            <td className={td + " text-ink-soft "}>
              {r.place_of_supply
                ? `${r.place_of_supply} · ${r.supply_type === "intra" ? "Intra" : "Inter"}`
                : "—"}
            </td>
            <td className={num}>{formatINR(Number(r.taxable_value), { showZero: true })}</td>
            <td className={num}>{formatINR(Number(r.cgst), { showZero: true })}</td>
            <td className={num}>{formatINR(Number(r.sgst), { showZero: true })}</td>
            <td className={num}>{formatINR(Number(r.igst), { showZero: true })}</td>
            <td className={num}>{formatINR(Number(r.cess), { showZero: true })}</td>
            <td className={num + " font-medium"}>
              {formatINR(Number(r.invoice_value), { showZero: true })}
            </td>
          </tr>
        ))}
        {rows.length > 0 && (
          <tr className="bg-bg font-semibold">
            <td className={td} colSpan={6}>
              Total
            </td>
            <td className={num}>{formatINR(totals.taxable, { showZero: true })}</td>
            <td className={num}>{formatINR(totals.cgst, { showZero: true })}</td>
            <td className={num}>{formatINR(totals.sgst, { showZero: true })}</td>
            <td className={num}>{formatINR(totals.igst, { showZero: true })}</td>
            <td className={num}>{formatINR(totals.cess, { showZero: true })}</td>
            <td className={num}>{formatINR(totals.total, { showZero: true })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default async function GstRegistersPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/gst-registers">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const monthParam = typeof sp.month === "string" ? sp.month : undefined;
  const regParam = typeof sp.reg === "string" ? sp.reg : undefined;
  const { from, to, label, ym } = monthBounds(monthParam);

  const [{ data: modules }, { data: registrations }] = await Promise.all([
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase
      .from("gst_registrations")
      .select("id, gstin, state_code")
      .eq("company_id", companyId)
      .order("gstin"),
  ]);

  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);

  if (!gstOn) {
    return (
      <ReportShell title="GST registers" period={label}>
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

  const regId = regParam || undefined;

  const [{ data: outputRows }, { data: inputRows }] = await Promise.all([
    supabase.rpc("get_gst_output_register", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
    supabase.rpc("get_gst_input_register", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
  ]);

  const output = (outputRows ?? []) as RegisterRow[];
  const input = (inputRows ?? []) as RegisterRow[];

  const outputTax = output.reduce((n, r) => n + Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess), 0);
  const inputTax = input.reduce((n, r) => n + Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess), 0);
  const netPayable = outputTax - inputTax;

  const base = `/${companyId}/reports/gst-registers`;
  const regQuery = regId ? `&reg=${regId}` : "";

  return (
    <ReportShell
      title="GST registers"
      period={`${label} · GSTR-1/3B source data, not a filing`}
      status={{
        label: `${formatINR(netPayable, { showZero: true })} net payable`,
        tone: netPayable >= 0 ? "ok" : "warn",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={`${base}?month=${shiftMonth(ym, -1)}${regQuery}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            ← Prev
          </Link>
          <span className="px-2 font-medium">{label}</span>
          <Link
            href={`${base}?month=${shiftMonth(ym, 1)}${regQuery}`}
            className="rounded-md border border-border-strong px-2.5 py-1 hover:bg-surface-2"
          >
            Next →
          </Link>
        </div>

        {(registrations ?? []).length > 1 && (
          <div className="flex items-center gap-2 text-sm">
            <Link
              href={`${base}?month=${ym}`}
              className={
                "rounded-md border px-2.5 py-1 " +
                (!regId ? "border-accent bg-accent-soft text-accent" : "border-border-strong hover:bg-surface-2")
              }
            >
              All registrations
            </Link>
            {(registrations ?? []).map((r) => (
              <Link
                key={r.id}
                href={`${base}?month=${ym}&reg=${r.id}`}
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
      </div>

      <div className="border-b border-border p-4">
        <h2 className="font-semibold">Output register — outward supplies (GSTR-1)</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Sales and credit notes. A credit note shows its own value negative
          so the total column nets correctly.
        </p>
      </div>
      <RegisterTable rows={output} />

      <div className="border-b border-t border-border p-4">
        <h2 className="font-semibold">Input register — inward supplies (GSTR-3B ITC)</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Purchases and debit notes. Does not distinguish eligible from
          blocked ITC (Sec 17(5)) — this schema does not track that per line.
        </p>
      </div>
      <RegisterTable rows={input} />

      <div className="border-t border-border p-4">
        <table className="w-full max-w-sm text-sm">
          <tbody>
            <tr className="border-b border-border">
              <td className={td}>Output tax</td>
              <td className={num}>{formatINR(outputTax, { showZero: true })}</td>
            </tr>
            <tr className="border-b border-border">
              <td className={td}>− Input tax credit</td>
              <td className={num}>{formatINR(inputTax, { showZero: true })}</td>
            </tr>
            <tr className="bg-accent-soft">
              <td className={td + " font-bold"}>Net payable</td>
              <td className={num + " font-bold"}>{formatINR(netPayable, { showZero: true })}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Source data for preparing GSTR-1 and GSTR-3B by hand or handing to a
        CA — not a filing-ready B2B/B2C/HSN-summary bifurcation, and not
        submitted anywhere. LEKHA has no GSTN API access to file directly.
        Tax figures are read back from actual ledger postings, not
        recomputed from item rates. RCM liability, nil-rated/exempt
        bifurcation, and the ITC eligibility split under Sec 17(5) are not
        shown separately.
      </p>
    </ReportShell>
  );
}
