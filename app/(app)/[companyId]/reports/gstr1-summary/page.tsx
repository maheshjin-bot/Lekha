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
  description: string | null;
  gst_rate_percent: number;
  uom: string;
  b2b_or_b2c: "b2b" | "b2c";
  total_quantity: number;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  total_value: number;
};

type Table9bRow = {
  voucher_id: string;
  note_type: string;
  note_number: string;
  note_date: string;
  party_name: string | null;
  party_gstin: string | null;
  place_of_supply: string | null;
  against_invoice_number: string | null;
  against_invoice_date: string | null;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  note_value: number;
};

/** Table 6A/6B/6C — exports, SEZ supplies, deemed exports (all zero-rated or
 * Sec 147 deemed-export, per 0087/0119). Same row shape across all three. */
type Table6Row = {
  voucher_id: string;
  voucher_number: string;
  voucher_date: string;
  party_name: string | null;
  party_gstin: string | null;
  place_of_supply: string | null;
  tax_payment: string | null;
  has_goods_line: boolean;
  shipping_bill_number: string | null;
  shipping_bill_date: string | null;
  port_code: string | null;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  invoice_value: number;
};

/** Table 11A/11B — advances received for a service not yet invoiced, and
 * their later adjustment against a real invoice (0500). Both share this row
 * shape: rate-wise and place-of-supply-wise, split intra/inter. */
type Table11Row = {
  rate_percent: number;
  cess_rate_percent: number;
  place_of_supply: string;
  place_of_supply_name: string | null;
  supply_category: "intra" | "inter";
  gross_advance: number;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
};

type Table13Row = {
  voucher_type: string;
  nature_of_document: string;
  branch_id: string;
  branch_code: string;
  series_prefix: string;
  financial_year_label: string;
  serial_from: number | null;
  serial_to: number | null;
  total_issued: number;
  cancelled: number;
  net_issued: number;
  serial_span: number;
  range_has_gap: boolean;
};

/** GSTN's own 12 "Nature of document" categories (Form GSTR-1, Table 13) — only
 * three of which LEKHA's schema can populate. The rest are listed here purely
 * so the report shows the full mandatory list rather than looking complete
 * with 9 rows quietly missing. See the migration 0094 header for why each one
 * is or isn't representable. */
const TABLE13_ALL_CATEGORIES: { nature_of_document: string; voucher_type: string | null }[] = [
  { nature_of_document: "Invoices for outward supply", voucher_type: "sales" },
  { nature_of_document: "Invoices for inward supply from unregistered person", voucher_type: null },
  { nature_of_document: "Revised Invoice", voucher_type: null },
  { nature_of_document: "Debit Note", voucher_type: null },
  { nature_of_document: "Credit Note", voucher_type: "credit_note" },
  { nature_of_document: "Receipt voucher", voucher_type: null },
  { nature_of_document: "Payment Voucher", voucher_type: null },
  { nature_of_document: "Refund voucher", voucher_type: null },
  { nature_of_document: "Delivery Challan for job work", voucher_type: "job_work_out" },
  { nature_of_document: "Delivery Challan for supply on approval", voucher_type: null },
  { nature_of_document: "Delivery Challan in case of liquid gas", voucher_type: null },
  { nature_of_document: "Delivery Challan, other (excl. job work / approval / liquid gas)", voucher_type: null },
];

function sumTax(rows: { cgst: number; sgst: number; igst: number; cess: number }[]) {
  return rows.reduce((n, r) => n + Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess), 0);
}

/** Table 6A/6B/6C — exports, SEZ supplies, deemed exports (invoice-wise, GSTR-1 shape). */
const TABLE6_KIND_LABEL: Record<"6a" | "6b" | "6c", { title: string; noRows: string; shippingBill: "required" | "optional" | "na" }> = {
  "6a": { title: "invoice", noRows: "No exports this month.", shippingBill: "required" },
  "6b": { title: "invoice", noRows: "No SEZ supplies this month.", shippingBill: "optional" },
  "6c": { title: "invoice", noRows: "No deemed exports this month.", shippingBill: "na" },
};

function Table6Table({ rows, kind }: { rows: Table6Row[]; kind: "6a" | "6b" | "6c" }) {
  const cfg = TABLE6_KIND_LABEL[kind];
  const taxTotal = sumTax(rows);
  const taxableTotal = rows.reduce((n, r) => n + Number(r.taxable_value), 0);
  return (
    <table className="w-full min-w-[1000px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Date</th>
          <th className={th}>Invoice no.</th>
          <th className={th}>Party</th>
          <th className={th}>GSTIN</th>
          <th className={th}>POS</th>
          <th className={th}>Payment</th>
          <th className={th}>Shipping bill</th>
          <th className={th + " text-right"}>Taxable</th>
          <th className={th + " text-right"}>Tax</th>
          <th className={th + " text-right"}>Invoice value</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={10} className="px-4 py-8 text-center text-ink-faint">
              {cfg.noRows}
            </td>
          </tr>
        )}
        {rows.map((r) => {
          // Only a GOODS export genuinely needs a shipping bill (Table 6A) —
          // per GSTN's own rule, a services export leaves it blank by
          // design, not by omission. SEZ (6B) never treats it as mandatory;
          // deemed export (6C) never has one at all (goods stay in India).
          const missingIsGap = cfg.shippingBill === "required" && r.has_goods_line && !r.shipping_bill_number;
          return (
            <tr key={r.voucher_id} className="border-b border-border last:border-0">
              <td className={td + " whitespace-nowrap"}>{r.voucher_date}</td>
              <td className={td + " font-mono text-xs"}>{r.voucher_number}</td>
              <td className={td}>{r.party_name ?? "—"}</td>
              <td className={td + " font-mono text-xs"}>
                {r.party_gstin ?? (kind === "6a" ? <span className="text-ink-faint">n/a (overseas)</span> : <Badge tone="warn">missing</Badge>)}
              </td>
              <td className={td}>{r.place_of_supply ?? "—"}</td>
              <td className={td}>
                <Badge tone="neutral">{r.tax_payment ?? "—"}</Badge>
              </td>
              <td className={td + " text-xs"}>
                {r.shipping_bill_number ? (
                  <>
                    {r.shipping_bill_number}
                    {r.shipping_bill_date ? <span className="text-ink-faint"> · {r.shipping_bill_date}</span> : null}
                    {r.port_code ? <span className="text-ink-faint"> · {r.port_code}</span> : null}
                  </>
                ) : missingIsGap ? (
                  <Badge tone="warn">not entered — check by hand</Badge>
                ) : cfg.shippingBill === "na" ? (
                  <span className="text-ink-faint">not applicable</span>
                ) : (
                  <span className="text-ink-faint">not entered</span>
                )}
              </td>
              <td className={num}>{formatINR(Number(r.taxable_value), { showZero: true })}</td>
              <td className={num}>
                {formatINR(Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess), { showZero: true })}
              </td>
              <td className={num + " font-medium"}>{formatINR(Number(r.invoice_value), { showZero: true })}</td>
            </tr>
          );
        })}
        {rows.length > 0 && (
          <tr className="bg-bg font-semibold">
            <td className={td} colSpan={7}>
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

/** Table 12 — HSN-wise summary, one sub-table per GSTN's mandatory B2B/B2C tab.
 * Rows are already keyed by (hsn_sac, gst_rate_percent, uom) server-side, so
 * the same HSN billed at two different rates prints as two separate rows
 * here rather than one blended one. */
function HsnTable({ rows, heading }: { rows: HsnRow[]; heading: string }) {
  const taxTotal = sumTax(rows);
  const taxableTotal = rows.reduce((n, r) => n + Number(r.taxable_value), 0);
  return (
    <div className="border-b border-border">
      <h3 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">{heading}</h3>
      <table className="w-full min-w-[960px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>HSN/SAC</th>
            <th className={th}>Description</th>
            <th className={th + " text-right"}>Rate %</th>
            <th className={th}>UOM</th>
            <th className={th + " text-right"}>Quantity</th>
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
              <td colSpan={11} className="px-4 py-8 text-center text-ink-faint">
                Nothing this month.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.hsn_sac}-${r.gst_rate_percent}-${r.uom}`} className="border-b border-border last:border-0">
              <td className={td + " font-mono text-xs"}>{r.hsn_sac}</td>
              <td className={td + " text-xs text-ink-soft"}>{r.description ?? "—"}</td>
              <td className={num}>{Number(r.gst_rate_percent)}%</td>
              <td className={td}>{r.uom}</td>
              <td className={num}>{Number(r.total_quantity).toLocaleString("en-IN")}</td>
              <td className={num}>{formatINR(Number(r.taxable_value), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.cgst), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.sgst), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.igst), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.cess), { showZero: true })}</td>
              <td className={num + " font-medium"}>{formatINR(Number(r.total_value), { showZero: true })}</td>
            </tr>
          ))}
          {rows.length > 0 && (
            <tr className="bg-bg font-semibold">
              <td className={td} colSpan={4}>
                Total
              </td>
              <td className={num}>{rows.reduce((n, r) => n + Number(r.total_quantity), 0).toLocaleString("en-IN")}</td>
              <td className={num}>{formatINR(taxableTotal, { showZero: true })}</td>
              <td className={num}>{formatINR(rows.reduce((n, r) => n + Number(r.cgst), 0), { showZero: true })}</td>
              <td className={num}>{formatINR(rows.reduce((n, r) => n + Number(r.sgst), 0), { showZero: true })}</td>
              <td className={num}>{formatINR(rows.reduce((n, r) => n + Number(r.igst), 0), { showZero: true })}</td>
              <td className={num}>{formatINR(rows.reduce((n, r) => n + Number(r.cess), 0), { showZero: true })}</td>
              <td className={num}>{formatINR(taxableTotal + taxTotal, { showZero: true })}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Table 9B — CDNR: credit/debit notes against registered recipients. */
function Table9bTable({ rows }: { rows: Table9bRow[] }) {
  const taxTotal = sumTax(rows);
  const valueTotal = rows.reduce((n, r) => n + Number(r.note_value), 0);
  return (
    <table className="w-full min-w-[920px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Note date</th>
          <th className={th}>Note no.</th>
          <th className={th}>Type</th>
          <th className={th}>Party GSTIN</th>
          <th className={th}>Against invoice</th>
          <th className={th + " text-right"}>Taxable</th>
          <th className={th + " text-right"}>Tax</th>
          <th className={th + " text-right"}>Note value</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={8} className="px-4 py-8 text-center text-ink-faint">
              No credit/debit notes against registered parties this month.
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr key={r.voucher_id} className="border-b border-border last:border-0">
            <td className={td + " whitespace-nowrap"}>{r.note_date}</td>
            <td className={td + " font-mono text-xs"}>{r.note_number}</td>
            <td className={td}>
              <Badge tone={r.note_type === "credit" ? "ok" : "neutral"}>{r.note_type}</Badge>
            </td>
            <td className={td + " font-mono text-xs"}>{r.party_gstin ?? "—"}</td>
            <td className={td + " text-xs"}>
              {r.against_invoice_number ? (
                <>
                  {r.against_invoice_number}
                  {r.against_invoice_date ? <span className="text-ink-faint"> · {r.against_invoice_date}</span> : null}
                </>
              ) : (
                <span className="text-ink-faint">not entered</span>
              )}
            </td>
            <td className={num}>{formatINR(Number(r.taxable_value), { showZero: true })}</td>
            <td className={num}>
              {formatINR(Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess), { showZero: true })}
            </td>
            <td className={num + " font-medium"}>{formatINR(Number(r.note_value), { showZero: true })}</td>
          </tr>
        ))}
        {rows.length > 0 && (
          <tr className="bg-bg font-semibold">
            <td className={td} colSpan={5}>
              Total ({rows.length} notes)
            </td>
            <td className={num}>
              {formatINR(rows.reduce((n, r) => n + Number(r.taxable_value), 0), { showZero: true })}
            </td>
            <td className={num}>{formatINR(taxTotal, { showZero: true })}</td>
            <td className={num}>{formatINR(valueTotal, { showZero: true })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** Table 11A/11B — advances for a service received (11A) or adjusted against
 * a real invoice (11B), rate-wise and place-of-supply-wise, split intra/inter
 * (0500). Same row shape for both; `heading`/`noRows` are the only
 * difference between the two call sites below. */
function Table11Table({ rows, heading, noRows }: { rows: Table11Row[]; heading: string; noRows: string }) {
  const taxTotal = rows.reduce((n, r) => n + Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess), 0);
  const grossTotal = rows.reduce((n, r) => n + Number(r.gross_advance), 0);
  return (
    <div className="border-b border-border">
      <h3 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">{heading}</h3>
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={th}>Supply</th>
            <th className={th}>Place of supply</th>
            <th className={th + " text-right"}>Rate</th>
            <th className={th + " text-right"}>Gross advance</th>
            <th className={th + " text-right"}>Taxable value</th>
            <th className={th + " text-right"}>CGST</th>
            <th className={th + " text-right"}>SGST</th>
            <th className={th + " text-right"}>IGST</th>
            <th className={th + " text-right"}>Cess</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="px-4 py-8 text-center text-ink-faint">
                {noRows}
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr
              key={`${r.supply_category}-${r.place_of_supply}-${r.rate_percent}-${r.cess_rate_percent}`}
              className="border-b border-border last:border-0"
            >
              <td className={td}>
                <Badge tone={r.supply_category === "intra" ? "neutral" : "accent"}>
                  {r.supply_category === "intra" ? "Intra-State" : "Inter-State"}
                </Badge>
              </td>
              <td className={td}>{r.place_of_supply_name ?? r.place_of_supply}</td>
              <td className={num}>
                {Number(r.rate_percent)}%{r.cess_rate_percent > 0 ? ` +${Number(r.cess_rate_percent)}%` : ""}
              </td>
              <td className={num}>{formatINR(Number(r.gross_advance), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.taxable_value), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.cgst), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.sgst), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.igst), { showZero: true })}</td>
              <td className={num}>{formatINR(Number(r.cess), { showZero: true })}</td>
            </tr>
          ))}
          {rows.length > 0 && (
            <tr className="bg-bg font-semibold">
              <td className={td} colSpan={3}>
                Total
              </td>
              <td className={num}>{formatINR(grossTotal, { showZero: true })}</td>
              <td className={num}>{formatINR(grossTotal - taxTotal, { showZero: true })}</td>
              <td className={num} colSpan={4}>
                {formatINR(taxTotal, { showZero: true })} tax
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Table 13 — Documents Issued: the full GSTN 12-row list, LEKHA-populated where possible. */
function Table13Table({ rows }: { rows: Table13Row[] }) {
  const byCategory = new Map<string, Table13Row[]>();
  for (const r of rows) {
    const list = byCategory.get(r.nature_of_document) ?? [];
    list.push(r);
    byCategory.set(r.nature_of_document, list);
  }
  return (
    <table className="w-full min-w-[920px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Nature of document</th>
          <th className={th}>Series</th>
          <th className={th}>Sr. No. from</th>
          <th className={th}>Sr. No. to</th>
          <th className={th + " text-right"}>Total number</th>
          <th className={th + " text-right"}>Cancelled</th>
          <th className={th + " text-right"}>Net issued</th>
        </tr>
      </thead>
      <tbody>
        {TABLE13_ALL_CATEGORIES.map((cat) => {
          if (cat.voucher_type === null) {
            return (
              <tr key={cat.nature_of_document} className="border-b border-border last:border-0 text-ink-faint">
                <td className={td}>{cat.nature_of_document}</td>
                <td className={td + " text-xs italic"} colSpan={6}>
                  Not tracked by LEKHA — enter manually (or NIL) if this category applies.
                </td>
              </tr>
            );
          }
          const seriesRows = byCategory.get(cat.nature_of_document) ?? [];
          if (seriesRows.length === 0) {
            return (
              <tr key={cat.nature_of_document} className="border-b border-border last:border-0">
                <td className={td}>{cat.nature_of_document}</td>
                <td className={td + " text-xs text-ink-faint"} colSpan={6}>
                  NIL — no series active for this branch/year, or nothing issued this month.
                </td>
              </tr>
            );
          }
          return seriesRows.map((r, i) => (
            <tr key={`${cat.nature_of_document}-${r.branch_id}`} className="border-b border-border last:border-0">
              <td className={td}>{i === 0 ? cat.nature_of_document : <span className="text-ink-faint">↳</span>}</td>
              <td className={td + " font-mono text-xs"}>
                {r.series_prefix}/{r.financial_year_label}
              </td>
              <td className={num}>{r.serial_from ?? "—"}</td>
              <td className={num}>
                {r.serial_to ?? "—"}
                {r.range_has_gap && (
                  <span title="A document numbered inside this range is dated outside this period — check by hand before filing.">
                    {" "}
                    <Badge tone="warn">check range</Badge>
                  </span>
                )}
              </td>
              <td className={num}>{r.total_issued}</td>
              <td className={num}>{r.cancelled}</td>
              <td className={num + " font-medium"}>{r.net_issued}</td>
            </tr>
          ));
        })}
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

  const [
    { data: outputRows },
    { data: hsnRows },
    { data: table9bRows },
    { data: table13Rows },
    { data: table6aRows },
    { data: table6bRows },
    { data: table6cRows },
  ] = await Promise.all([
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
    supabase.rpc("get_gstr1_table9b", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
    supabase.rpc("get_gstr1_table13", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
    // Tables 6A/6B/6C (0134) — brand new RPCs, not yet in the generated
    // database.types.ts (same "cast after the integration pass regenerates
    // types" situation as get_gstr1_hsn_summary above).
    supabase.rpc("get_gstr1_table6a", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
    supabase.rpc("get_gstr1_table6b", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
    supabase.rpc("get_gstr1_table6c", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
  ]);

  // Table 11A/11B (0500) — separate Promise.all so a failure/slowness here
  // (both are brand-new RPCs) never blocks the tables above from rendering;
  // additive only, per this task's own scope.
  const [{ data: table11aRows }, { data: table11bRows }] = await Promise.all([
    supabase.rpc("get_gstr1_table11a", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
    supabase.rpc("get_gstr1_table11b", {
      p_company_id: companyId,
      p_period_start: from,
      p_period_end: to,
      p_gst_registration_id: regId,
    }),
  ]);

  const output = (outputRows ?? []) as OutputRow[];
  // `as unknown as` — same reason as reports/balance-sheet after 0089: the
  // generated database.types.ts still describes get_gstr1_hsn_summary's PRE-
  // 0098 return shape until the integration pass regenerates it.
  const hsn = (hsnRows ?? []) as unknown as HsnRow[];
  const table9b = (table9bRows ?? []) as Table9bRow[];
  const table13 = (table13Rows ?? []) as Table13Row[];
  const table6a = (table6aRows ?? []) as unknown as Table6Row[];
  const table6b = (table6bRows ?? []) as unknown as Table6Row[];
  const table6c = (table6cRows ?? []) as unknown as Table6Row[];
  const table11a = (table11aRows ?? []) as unknown as Table11Row[];
  const table11b = (table11bRows ?? []) as unknown as Table11Row[];

  // Tables 4A/5A/7 are DOMESTIC supply tables — confirmed live via WebSearch
  // while building 0134: "Table 4 B2B specifically excludes SEZ supplies and
  // exports, which are instead reported separately in Table 6." A
  // export_lut/export_igst/sez/deemed_export row must never also appear
  // here, or it double-counts against the Table 6A/6B/6C section below. This
  // was a real, latent bug: before 0087 landed today, zero vouchers had ever
  // carried one of these four supply_type values (confirmed live by 0087's
  // own header), so the filter below was a no-op and the bug was invisible.
  // Caught by this session's own hand-verification once real zero-rated/
  // deemed-export test data existed, not by code review — see the final
  // report. A GSTIN-bearing SEZ/deemed-export party would otherwise have
  // landed in B2B (Table 4A) purely because it has a GSTIN, which is wrong.
  const ZERO_RATED_OR_DEEMED = new Set(["export_lut", "export_igst", "sez", "deemed_export"]);
  const domesticOutput = output.filter((r) => !ZERO_RATED_OR_DEEMED.has(r.supply_type ?? ""));

  // Re-bucket 0035's own output register into GSTR-1's table structure — no
  // new tax computation, so this can never drift from the register's own
  // figures. party_gstin present → registered counterparty → B2B (Table 4A).
  // Otherwise unregistered: inter-state over the threshold is invoice-wise
  // B2C(Large) (Table 5A); everything else is state-wise consolidated
  // B2C(Small) (Table 7).
  const b2b = domesticOutput.filter((r) => r.party_gstin);
  const b2cLarge = domesticOutput.filter(
    (r) => !r.party_gstin && r.supply_type === "inter" && Math.abs(Number(r.invoice_value)) > B2C_LARGE_THRESHOLD
  );
  const b2cSmallRows = domesticOutput.filter(
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
          Table 6A — Exports <Badge tone="neutral">invoice-wise</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Sales with supply_type export_lut (WOPAY, under LUT) or export_igst (WPAY, IGST charged and
          refundable). Payment status is read directly from the voucher, not inferred. A missing shipping
          bill is flagged only when the invoice has at least one goods line — a services export legitimately
          has none, per GSTN&rsquo;s own rule.
        </p>
      </div>
      <Table6Table rows={table6a} kind="6a" />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Table 6B — Supplies to SEZ <Badge tone="neutral">invoice-wise</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Sales with supply_type sez. LEKHA cannot store a WPAY/WOPAY route on an SEZ voucher separately from
          export (0087&rsquo;s own gap) — payment status here is inferred from the IGST actually posted, not
          read from a stored flag. Shipping bill is optional for SEZ movement, so its absence is shown
          plainly and never flagged as an error.
        </p>
      </div>
      <Table6Table rows={table6b} kind="6b" />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Table 6C — Deemed exports <Badge tone="neutral">Sec 147</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Sales with supply_type deemed_export. Always full GST at the ordinary domestic CGST+SGST/IGST split
          (deemed exports can never be zero-rated under LUT — Rule 89(1), 3rd proviso) and never a shipping
          bill (the goods do not leave India).
        </p>
      </div>
      <Table6Table rows={table6c} kind="6c" />

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
          Sales and credit notes grouped by HSN/SAC and rate, split into GSTN&rsquo;s two mandatory tabs
          (Phase-3, since the B2B/B2C split of Table 12 became mandatory). The same HSN billed at two
          different rates now prints as two rows, never one blended rate — see the report footer.
        </p>
      </div>
      <HsnTable rows={hsn.filter((r) => r.b2b_or_b2c === "b2b")} heading="B2B supplies" />
      <HsnTable rows={hsn.filter((r) => r.b2b_or_b2c === "b2c")} heading="B2C supplies" />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Table 9B — Credit/debit notes (registered) <Badge tone="neutral">CDNR</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Credit notes issued this month against a GST-registered party. Will never show a debit note —
          see the report footer for why. &ldquo;Against invoice&rdquo; is whatever was typed into the
          note&rsquo;s own Reference field; it is not checked against a real sales voucher.
        </p>
      </div>
      <Table9bTable rows={table9b} />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Table 11A — Advances received <Badge tone="neutral">services only</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-soft">
          Advances tagged this period against a customer for a SERVICE not yet invoiced (Sec 13(2)), rate-
          wise and place-of-supply-wise. Goods advances have been exempt from this since Notification
          66/2017-Central Tax and are not represented here. Excludes any advance also invoiced within this
          same period — it nets to nothing and shows up as an ordinary invoice line above instead, per
          Instruction 15 to FORM GSTR-1. Tag a receipt as a service advance, or mark one adjusted, at{" "}
          <Link href={`/${companyId}/service-advances`} className="underline">
            Service advances
          </Link>
          .
        </p>
      </div>
      <Table11Table rows={table11a} heading="11A(1)/11A(2) — Rate-wise" noRows="No service advances tagged this month." />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Table 11B — Advances adjusted <Badge tone="neutral">services only</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-soft">
          The mirror image of 11A: advances received in an EARLIER period, now adjusted against a real
          invoice raised this period — keyed off that invoice&rsquo;s own date, not whenever &ldquo;mark
          adjusted&rdquo; happened to be clicked. Reverses exactly what 11A showed for that advance back in
          its own period.
        </p>
      </div>
      <Table11Table rows={table11b} heading="11B(1)/11B(2) — Rate-wise" noRows="No service advances adjusted this month." />

      <div className="border-b border-t border-border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          Table 13 — Documents issued <Badge tone="warn">mandatory, incl. NIL</Badge>
        </h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          GSTN&rsquo;s own 12 document categories. LEKHA can compute a serial range for 3 of them; the
          other 9 are shown so the return&rsquo;s full mandatory list is visible, not silently missing.
        </p>
      </div>
      <Table13Table rows={table13} />

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        GSTR-1 prep — B2B/B2C(Large)/B2C(Small) is a straight re-bucketing of the GST output register
        (Reports → GST registers) by registration status, supply direction and invoice value; it carries
        the same figures, so the two reports always reconcile. Table 12 is grouped by (HSN/SAC, GST rate,
        UOM) and split B2B/B2C by whether the party ledger carries a registered gst_registration_type —
        per GSTN&rsquo;s Phase-3 rules, which now reject a blended rate on the same HSN. The rate itself is
        read from the item master (voucher_items has no rate column of its own, only hsn_sac), so a rate
        changed on an item AFTER a historical invoice was raised will group that old line under today&rsquo;s
        rate, not the one actually charged — the rupee totals still reconcile exactly to real ledger
        postings (each line&rsquo;s share of its voucher&rsquo;s actual tax is weighted by that line&rsquo;s
        own taxable value × its own rate, not by taxable value alone), only the rate LABEL and which bucket
        a historical line falls into can drift. Description is a locally-sourced item name, not GSTN&rsquo;s
        own HSN-master text, which LEKHA does not hold. Zero-rated exports, nil-rated and exempt
        supplies are not distinguished from standard-rated supplies — this schema does not track that
        bifurcation. As of Aug 2026, GSTR-3B&rsquo;s own outward-supply table is hard-locked and auto-populated
        FROM GSTR-1 (no longer independently editable) — this is exactly why LEKHA targets GSTR-1 rather
        than GSTR-3B. Table 9B shows only credit notes: LEKHA&rsquo;s debit_note voucher type is always a
        purchase return (input side), never the output-side price-increase note GSTR-1 means by a debit
        note, so there is currently nowhere in this app to record one — it must be reported outside LEKHA
        if you issue one. Table 13&rsquo;s serial ranges are built from voucher DATES, not the raw numbering
        sequence, because LEKHA assigns a voucher its number when it is entered, not when it is dated — a
        back-dated entry can leave a number inside a range that a date filter would not otherwise select;
        a range flagged &ldquo;check range&rdquo; means exactly that, and should be hand-checked before
        filing. Table 13&rsquo;s Cancelled column counts soft-deleted vouchers (LEKHA&rsquo;s only
        correction mechanism) in that same range — the closest available proxy, not a certified count of
        formally cancelled invoices. Not a filing-ready JSON for GSTN&rsquo;s offline tool, and nothing here
        is submitted anywhere — LEKHA has no GSTN API access. Tables 6A/6B/6C (exports, SEZ, deemed exports)
        read supply_type export_lut/export_igst/sez/deemed_export (0087) and LEFT JOIN each voucher to its
        exim_shipment_details shipping bill (0119) — a genuinely missing shipping bill on a GOODS export is
        shown as a real gap to hand-check before filing; a blank one on a services export, an SEZ supply, or
        a deemed export is not, since none of those three require one. B2B/B2C(Large)/B2C(Small) above now
        explicitly EXCLUDE these four supply_type values, matching GSTN&rsquo;s own rule that Table 4 never
        includes an export or SEZ supply even when the recipient carries a GSTIN — before today no voucher had
        ever used one of these supply_type values, so this exclusion was a silent no-op; it is a real fix now
        that real zero-rated/deemed-export data exists. Table 6B&rsquo;s payment status (WPAY/WOPAY) is
        inferred from whether IGST was actually posted, not read from a stored flag — vouchers.supply_type has
        only one &lsquo;sez&rsquo; value for both routes (0087), so a 0%-rated item sold to an SEZ under the
        WPAY route would misclassify as WOPAY; genuinely rare in practice. Table 6A&rsquo;s payment status, by
        contrast, is read directly off supply_type (export_lut/export_igst), no inference needed. Table 6C is
        always WPAY: deemed exports cannot be supplied under LUT/bond at all (Rule 89(1), 3rd proviso) — the
        WHO of a deemed-export refund claim (supplier vs. recipient, Rule 89/Statement 5B) is a refund-application
        fact, not a GSTR-1 field, and is not represented here, the same scoping ITC-04 prep already applied to
        Statement 5B/5C. All three tables are invoice-wise, not split by rate the way Table 12 is — a single
        invoice mixing two GST rates prints as one blended row, same simplification as Table 4A/9B. Tables
        11A/11B (0500) read a manual tag/overlay — service_advance_receipts — never anything inferred from a
        plain receipt voucher automatically; a business that never uses the Service advances screen will
        correctly show NIL here even if it does, in fact, collect advances, because LEKHA cannot tell an
        advance apart from an ordinary settlement without being told. GST liability is grossed UP out of the
        tagged advance amount (Rule 50&rsquo;s cum-tax treatment), not added on top of it. Rule 50&rsquo;s own
        further proviso — treat the supply as inter-State when its nature genuinely cannot be determined — has
        no representation here, since Table 11 itself has no &ldquo;place of supply unknown&rdquo; bucket to
        honestly show it in.
      </p>
    </ReportShell>
  );
}
