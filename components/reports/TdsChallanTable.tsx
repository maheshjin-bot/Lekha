import { formatINR } from "@/lib/utils/currency";
import { num, td, th } from "@/components/ui/Table";

/**
 * Every tax_payments (0079) row with tax_type = 'tds' (or 'tcs' — see
 * 27EQ's page, 0146) in the return's deposit window. Shared by 24Q/26Q/27Q/
 * 27EQ's prep pages because OLTAS itself does not tag a challan to one
 * specific return — see each page's own disclaimer for why the SAME list
 * can legitimately appear on more than one of them. Column shape is
 * tax_payments' own schema, not TDS-specific, despite the type name.
 */
export type TdsChallanRow = {
  id: string;
  payment_date: string;
  amount: number;
  bsr_code: string | null;
  challan_serial: string | null;
  tds_section: string | null;
  notes: string | null;
};

export function TdsChallanTable({ rows }: { rows: TdsChallanRow[] }) {
  const total = rows.reduce((n, r) => n + Number(r.amount), 0);
  return (
    <table className="w-full min-w-[820px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Date of deposit</th>
          <th className={th}>BSR code</th>
          <th className={th}>Challan serial no.</th>
          <th className={th}>Section (as recorded)</th>
          <th className={th + " text-right"}>Amount deposited</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={5} className="px-4 py-10 text-center text-ink-faint">
              No challan payments recorded for this company in this window.
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-border last:border-0">
            <td className={td}>{r.payment_date}</td>
            <td className={td + " font-mono text-xs"}>{r.bsr_code ?? "—"}</td>
            <td className={td + " font-mono text-xs"}>{r.challan_serial ?? "—"}</td>
            <td className={td + " font-mono text-xs"}>{r.tds_section ?? "—"}</td>
            <td className={num}>{formatINR(Number(r.amount), { showZero: true })}</td>
          </tr>
        ))}
        {rows.length > 0 && (
          <tr className="bg-bg font-semibold">
            <td className={td} colSpan={4}>
              Total deposited
            </td>
            <td className={num}>{formatINR(total, { showZero: true })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
