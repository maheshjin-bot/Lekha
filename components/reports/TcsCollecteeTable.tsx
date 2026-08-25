import { formatINR } from "@/lib/utils/currency";
import { num, td, th } from "@/components/ui/Table";

/**
 * Collectee-wise TCS rows, get_tcs_collectee_summary's (0146) return shape —
 * the TCS mirror of TdsDeducteeTable, used by the 27EQ return-prep page. See
 * 0146's migration header for why collectee attribution here is a direct
 * read of vouchers.party_ledger_id (not a vote across flagged ledgers the
 * way TDS's deductee is) and why the aggregation grain is per
 * (collectee, section) pair rather than per collectee alone — the same
 * buyer can appear on more than one row if they were charged TCS under more
 * than one section in the period.
 *
 * No Sec 197-style certificate column: TCS has no lower-rate certificate
 * equivalent in this schema. Sec 206C(1A)/Form 27C ("buyer will use these
 * goods for manufacturing, not resale — no TCS") is a full exemption
 * declaration, not a rate reduction, and this schema does not track it
 * anywhere — see 0146's header. A row with zero TCS despite a
 * TCS-sectioned item usually means exactly this, and cannot be
 * distinguished here from a simple data-entry gap.
 */
export type TcsCollecteeRow = {
  collectee_ledger_id: string | null;
  collectee_name: string;
  pan: string | null;
  section_code: string | null;
  section_description: string | null;
  section_rate_percent: number | null;
  voucher_count: number;
  tcs_collected: number;
  party_ledger_movement: number;
};

export function TcsCollecteeTable({ rows }: { rows: TcsCollecteeRow[] }) {
  const total = rows.reduce((n, r) => n + Number(r.tcs_collected), 0);
  return (
    <table className="w-full min-w-[920px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Collectee</th>
          <th className={th}>PAN</th>
          <th className={th}>Section</th>
          <th className={th + " text-right"}>Rate</th>
          <th className={th + " text-right"}>Vouchers</th>
          <th className={th + " text-right"}>Party ledger movement</th>
          <th className={th + " text-right"}>TCS collected</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
              No TCS collections this quarter.
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <tr
            key={`${r.collectee_ledger_id ?? "unattributed"}-${r.section_code ?? "mixed"}`}
            className="border-b border-border last:border-0"
          >
            <td className={td}>
              {r.collectee_ledger_id ? r.collectee_name : <span className="text-warning">{r.collectee_name}</span>}
            </td>
            <td className={td + " font-mono text-xs text-ink-faint"}>{r.pan ?? "—"}</td>
            <td className={td + " font-mono text-xs"}>{r.section_code ?? "—"}</td>
            <td className={num}>{r.section_rate_percent != null ? `${Number(r.section_rate_percent)}%` : "—"}</td>
            <td className={num}>{r.voucher_count}</td>
            <td className={num}>{formatINR(Number(r.party_ledger_movement), { showZero: true })}</td>
            <td className={num + " font-medium"}>{formatINR(Number(r.tcs_collected), { showZero: true })}</td>
          </tr>
        ))}
        {rows.length > 0 && (
          <tr className="bg-bg font-semibold">
            <td className={td} colSpan={6}>
              Total
            </td>
            <td className={num}>{formatINR(total, { showZero: true })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
