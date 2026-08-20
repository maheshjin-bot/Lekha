import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatINR } from "@/lib/utils/currency";
import { ReportShell, num, td, th } from "@/components/reports/ReportShell";
import { Badge } from "@/components/ui/Badge";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** GST returns run on the calendar month — same convention as gst-registers. */
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

// Effective 1 Aug 2024 (Notification amending CGST Rule 59(4)), reduced from
// the original ₹2.5 lakh — verified live via web search while building this,
// not from training-data memory, since this exact figure changed after most
// AI training cutoffs and getting it wrong would misfile invoices into the
// wrong GSTR-1 table.
const B2C_LARGE_THRESHOLD = 100000;

type OutputRow = {
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

type HsnRow = {
  hsn_sac: string;
  uom: string;
  total_quantity: number;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  total_value: number;
  effective_rate_percent: number;
};

function sumTax(rows: { cgst: number; sgst: number; igst: number; cess: number }[]) {
  return rows.reduce((n, r) => n + Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess), 0);
}

/** Table 4A — B2B, invoice-wise: every line with a registered counterparty GSTIN. */
function B2BTable({ rows }: { rows: OutputRow[] }) {
  const taxTotal = sumTax(rows);
  const taxableTotal = rows.reduce((n, r) => n + Number(r.taxable_value), 0);
  return (
    <table className="w-full min-w-[860px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Date</th>
          <th className={th}>Invoice no.</th>
          <th className={th}>GSTIN</th>
          <th className={th}>Party</th>
          <th className={th}>POS</th>
          <th className={th + " text-right"}>Taxable</th>
          <th className={th + " text-right"}>Tax</th>
          <th className={th + " text-right"}>Invoice value</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={8} className="px-4 py-8 text-center text-ink-faint">
              No B2B supplies this month.
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr key={r.voucher_id} className="border-b border-border last:border-0">
            <td className={td + " whitespace-nowrap"}>{r.voucher_date}</td>
            <td className={td + " font-mono text-xs"}>{r.voucher_number}</td>
            <td className={td + " font-mono text-xs"}>{r.party_gstin}</td>
            <td className={td}>{r.party_name ?? "—"}</td>
            <td className={td}>{r.place_of_supply ?? "—"}</td>
            <td className={num}>{formatINR(Number(r.taxable_value), { showZero: true })}</td>
            <td className={num}>
              {formatINR(Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess), { showZero: true })}
            </td>
            <td className={num + " font-medium"}>{formatINR(Number(r.invoice_value), { showZero: true })}</td>
          </tr>
        ))}
        {rows.length > 0 && (
          <tr className="bg-bg font-semibold">
            <td className={td} colSpan={5}>
              Total ({rows.length} invoices)
            </td>
            <td className={num}>{formatINR(taxableTotal, { showZero: true })}</td>
            <td className={num}>{formatINR(taxTotal, { showZero: true })}</td>
            <td className={num}>{formatINR(taxableTotal + taxTotal, { showZero: true })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** Table 5A — B2C(Large), invoice-wise: unregistered + inter-state + invoice value over the threshold. */
function B2CLargeTable({ rows }: { rows: OutputRow[] }) {
  const taxTotal = sumTax(rows);
  const taxableTotal = rows.reduce((n, r) => n + Number(r.taxable_value), 0);
  return (
    <table className="w-full min-w-[760px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Date</th>
          <th className={th}>Invoice no.</th>
          <th className={th}>Place of supply</th>
          <th className={th + " text-right"}>Taxable</th>
          <th className={th + " text-right"}>Tax</th>
          <th className={th + " text-right"}>Invoice value</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={6} className="px-4 py-8 text-center text-ink-faint">
              No B2C(Large) supplies this month.
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr key={r.voucher_id} className="border-b border-border last:border-0">
            <td className={td + " whitespace-nowrap"}>{r.voucher_date}</td>
            <td className={td + " font-mono text-xs"}>{r.voucher_number}</td>
            <td className={td}>{r.place_of_supply ?? "—"}</td>
            <td className={num}>{formatINR(Number(r.taxable_value), { showZero: true })}</td>
            <td className={num}>
              {formatINR(Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess), { showZero: true })}
            </td>
            <td className={num + " font-medium"}>{formatINR(Number(r.invoice_value), { showZero: true })}</td>
          </tr>
        ))}
        {rows.length > 0 && (
          <tr className="bg-bg font-semibold">
            <td className={td} colSpan={3}>
              Total ({rows.length} invoices)
            </td>
            <td className={num}>{formatINR(taxableTotal, { showZero: true })}</td>
            <td className={num}>{formatINR(taxTotal, { showZero: true })}</td>
            <td className={num}>{formatINR(taxableTotal + taxTotal, { showZero: true })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

type B2csBucket = { place_of_supply: string; taxable_value: number; cgst: number; sgst: number; igst: number; cess: number };

/** Table 7 — B2C(Small), state-wise consolidated (not invoice-wise, per GSTN's own table structure). */
function B2CSmallTable({ buckets }: { buckets: B2csBucket[] }) {
  const taxTotal = sumTax(buckets);
  const taxableTotal = buckets.reduce((n, r) => n + r.taxable_value, 0);
  return (
    <table className="w-full min-w-[600px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Place of supply</th>
          <th className={th + " text-right"}>Taxable</th>
          <th className={th + " text-right"}>Tax</th>
          <th className={th + " text-right"}>Total</th>
        </tr>
      </thead>
      <tbody>
        {buckets.length === 0 && (
          <tr>
            <td colSpan={4} className="px-4 py-8 text-center text-ink-faint">
              No B2C(Small) supplies this month.
            </td>
          </tr>
        )}
        {buckets.map((b) => (
          <tr key={b.place_of_supply} className="border-b border-border last:border-0">
            <td className={td}>{b.place_of_supply}</td>
            <td className={num}>{formatINR(b.taxable_value, { showZero: true })}</td>
            <td className={num}>{formatINR(b.cgst + b.sgst + b.igst + b.cess, { showZero: true })}</td>
            <td className={num + " font-medium"}>{formatINR(b.taxable_value + b.cgst + b.sgst + b.igst + b.cess, { showZero: true })}</td>
          </tr>
        ))}
        {buckets.length > 0 && (
          <tr className="bg-bg font-semibold">
            <td className={td}>Total</td>
            <td className={num}>{formatINR(taxableTotal, { showZero: true })}</td>
            <td className={num}>{formatINR(taxTotal, { showZero: true })}</td>
            <td className={num}>{formatINR(taxableTotal + taxTotal, { showZero: true })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** Table 12 — HSN-wise summary. */
function HsnTable({ rows }: { rows: HsnRow[] }) {
  const taxTotal = sumTax(rows);
  const taxableTotal = rows.reduce((n, r) => n + Number(r.taxable_value), 0);
  return (
    <table className="w-full min-w-[820px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>HSN/SAC</th>
          <th className={th}>UOM</th>
          <th className={th + " text-right"}>Quantity</th>
          <th className={th + " text-right"}>Taxable</th>
          <th className={th + " text-right"}>Rate %</th>
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
            <td colSpan={10} className="px-4 py-8 text-center text-ink-faint">
              Nothing this month.
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr key={`${r.hsn_sac}-${r.uom}`} className="border-b border-border last:border-0">
            <td className={td + " font-mono text-xs"}>{r.hsn_sac}</td>
            <td className={td}>{r.uom}</td>
            <td className={num}>{Number(r.total_quantity).toLocaleString("en-IN")}</td>
            <td className={num}>{formatINR(Number(r.taxable_value), { showZero: true })}</td>
            <td className={num}>{Number(r.effective_rate_percent)}%</td>
            <td className={num}>{formatINR(Number(r.cgst), { showZero: true })}</td>
            <td className={num}>{formatINR(Number(r.sgst), { showZero: true })}</td>
            <td className={num}>{formatINR(Number(r.igst), { showZero: true })}</td>
            <td className={num}>{formatINR(Number(r.cess), { showZero: true })}</td>
            <td className={num + " font-medium"}>{formatINR(Number(r.total_value), { showZero: true })}</td>
          </tr>
        ))}
        {rows.length > 0 && (
          <tr className="bg-bg font-semibold">
            <td className={td} colSpan={3}>
              Total
            </td>
            <td className={num}>{formatINR(taxableTotal, { showZero: true })}</td>
            <td className={num}></td>
            <td className={num}>{formatINR(rows.reduce((n, r) => n + Number(r.cgst), 0), { showZero: true })}</td>
            <td className={num}>{formatINR(rows.reduce((n, r) => n + Number(r.sgst), 0), { showZero: true })}</td>
            <td className={num}>{formatINR(rows.reduce((n, r) => n + Number(r.igst), 0), { showZero: true })}</td>
            <td className={num}>{formatINR(rows.reduce((n, r) => n + Number(r.cess), 0), { showZero: true })}</td>
            <td className={num}>{formatINR(taxableTotal + taxTotal, { showZero: true })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export default async function Gstr1SummaryPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reports/gstr1-summary">) {
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
      <ReportShell title="GSTR-1 summary" period={label}>
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

  const [{ data: outputRows }, { data: hsnRows }] = await Promise.all([
    supabase.rpc("get_gst_output_register", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
    supabase.rpc("get_gstr1_hsn_summary", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
  ]);

  const output = (outputRows ?? []) as OutputRow[];
  const hsn = (hsnRows ?? []) as HsnRow[];

  // Re-bucket 0035's own output register into GSTR-1's table structure — no
  // new tax computation, so this can never drift from the register's own
  // figures. party_gstin present → registered counterparty → B2B (Table 4A).
  // Otherwise unregistered: inter-state over the threshold is invoice-wise
  // B2C(Large) (Table 5A); everything else is state-wise consolidated
  // B2C(Small) (Table 7).
  const b2b = output.filter((r) => r.party_gstin);
  const b2cLarge = output.filter(
    (r) => !r.party_gstin && r.supply_type === "inter" && Math.abs(Number(r.invoice_value)) > B2C_LARGE_THRESHOLD
  );
  const b2cSmallRows = output.filter(
    (r) => !r.party_gstin && !(r.supply_type === "inter" && Math.abs(Number(r.invoice_value)) > B2C_LARGE_THRESHOLD)
  );
  const b2cSmallByState = new Map<string, B2csBucket>();
  for (const r of b2cSmallRows) {
    const key = r.place_of_supply ?? "Unknown";
    const existing = b2cSmallByState.get(key) ?? { place_of_supply: key, taxable_value: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
    existing.taxable_value += Number(r.taxable_value);
    existing.cgst += Number(r.cgst);
    existing.sgst += Number(r.sgst);
    existing.igst += Number(r.igst);
    existing.cess += Number(r.cess);
    b2cSmallByState.set(key, existing);
  }
  const b2cSmall = Array.from(b2cSmallByState.values()).sort((a, b) => a.place_of_supply.localeCompare(b.place_of_supply));

  const totalTaxable = output.reduce((n, r) => n + Number(r.taxable_value), 0);
  const totalTax = sumTax(output);

  const base = `/${companyId}/reports/gstr1-summary`;
  const regQuery = regId ? `&reg=${regId}` : "";

  return (
    <ReportShell
      title="GSTR-1 summary"
      period={`${label} · B2B / B2C(Large) / B2C(Small) / HSN — GSTR-1 prep, not a filing`}
      status={{
        label: `${formatINR(totalTaxable + totalTax, { showZero: true })} total outward supply`,
        tone: "ok",
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
        <h2 className="flex items-center gap-2 font-semibold">
          Table 4A — B2B <Badge tone="neutral">invoice-wise</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">Supplies to GST-registered counterparties.</p>
      </div>
      <B2BTable rows={b2b} />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Table 5A — B2C (Large) <Badge tone="neutral">invoice-wise</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Unregistered, inter-state, invoice value over ₹1,00,000 (Rule 59(4), effective 1 Aug 2024).
        </p>
      </div>
      <B2CLargeTable rows={b2cLarge} />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Table 7 — B2C (Small) <Badge tone="neutral">state-wise</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Everything else unregistered — intra-state at any value, or inter-state at ₹1,00,000 or below.
          Consolidated by place of supply, per GSTN&rsquo;s own table structure — not invoice-wise.
        </p>
      </div>
      <B2CSmallTable buckets={b2cSmall} />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Table 12 — HSN-wise summary <Badge tone="neutral">outward only</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Sales and credit notes grouped by HSN/SAC. Tax allocated from actual postings, not the item
          master&rsquo;s current rate — see the report footer.
        </p>
      </div>
      <HsnTable rows={hsn} />

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        GSTR-1 prep — B2B/B2C(Large)/B2C(Small) is a straight re-bucketing of the GST output register
        (Reports → GST registers) by registration status, supply direction and invoice value; it carries
        the same figures, so the two reports always reconcile. HSN quantities and tax are read back from
        actual voucher_items and ledger postings, allocated proportionally where an invoice carries more
        than one HSN — not recomputed from the item master&rsquo;s current GST rate, which can have changed
        since the invoice was raised. A single HSN billed at genuinely different rates within the month
        shows one blended effective rate, not separate rows. Zero-rated exports, nil-rated and exempt
        supplies are not distinguished from standard-rated supplies — this schema does not track that
        bifurcation. As of Aug 2026, GSTR-3B&rsquo;s own outward-supply table is hard-locked and auto-populated
        FROM GSTR-1 (no longer independently editable) — this is exactly why LEKHA targets GSTR-1 rather
        than GSTR-3B. Not a filing-ready JSON for GSTN&rsquo;s offline tool, and nothing here is submitted
        anywhere — LEKHA has no GSTN API access.
      </p>
    </ReportShell>
  );
}
