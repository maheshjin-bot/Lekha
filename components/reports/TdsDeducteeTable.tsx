import { formatINR } from "@/lib/utils/currency";
import { num, td, th } from "@/components/ui/Table";

/**
 * Deductee-wise TDS rows, exactly get_tds_deductee_summary's (0053) return
 * shape. Shared by the 26Q and 27Q return-prep pages (and reachable by any
 * future one) rather than copy-pasted per page, because both call the same
 * RPC and render it the same way — see the 0053/tds-summary header for what
 * "unattributed" means and why party_ledger_movement is not a gross invoice
 * value.
 */
export type TdsDeducteeRow = {
  deductee_ledger_id: string | null;
  deductee_name: string;
  pan: string | null;
  section_code: string | null;
  section_description: string | null;
  section_rate_percent: number | null;
  voucher_count: number;
  tds_deducted: number;
  party_ledger_movement: number;
};

/** Sec 197 lower/nil-deduction certificate detail, keyed by ledger id — a
 * separate query against `ledgers` (0006/0086), joined in the page rather
 * than added to get_tds_deductee_summary's own return shape, which this
 * task does not touch. Only certificates whose validity window covers the
 * return's own quarter are meaningful here; the page decides that, this
 * component just renders whatever it is given. */
export type LdcInfo = {
  ldc_number: string | null;
  ldc_rate: number | null;
  ldc_valid_from: string | null;
  ldc_valid_to: string | null;
};

export function TdsDeducteeTable({
  rows,
  ldcById,
}: {
  rows: TdsDeducteeRow[];
  ldcById?: Map<string, LdcInfo>;
}) {
  const total = rows.reduce((n, r) => n + Number(r.tds_deducted), 0);
  return (
    <table className="w-full min-w-[980px] text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className={th}>Deductee</th>
          <th className={th}>PAN</th>
          <th className={th}>Section</th>
          <th className={th + " text-right"}>Rate</th>
          <th className={th}>Sec 197 certificate</th>
          <th className={th + " text-right"}>Vouchers</th>
          <th className={th + " text-right"}>Party ledger movement</th>
          <th className={th + " text-right"}>TDS deducted</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={8} className="px-4 py-10 text-center text-ink-faint">
              No TDS deductions this quarter.
            </td>
          </tr>
        )}
        {rows.map((r) => {
          const ldc = r.deductee_ledger_id ? ldcById?.get(r.deductee_ledger_id) : undefined;
          return (
            <tr key={r.deductee_ledger_id ?? "unattributed"} className="border-b border-border last:border-0">
              <td className={td}>
                {r.deductee_ledger_id ? r.deductee_name : <span className="text-warning">{r.deductee_name}</span>}
              </td>
              <td className={td + " font-mono text-xs text-ink-faint"}>{r.pan ?? "—"}</td>
              <td className={td + " font-mono text-xs"}>{r.section_code ?? "—"}</td>
              <td className={num}>{r.section_rate_percent != null ? `${Number(r.section_rate_percent)}%` : "—"}</td>
              <td className={td + " text-xs text-ink-faint"}>
                {ldc?.ldc_number ? (
                  <>
                    {ldc.ldc_number}
                    {ldc.ldc_rate != null && <> · {Number(ldc.ldc_rate)}%</>}
                    {ldc.ldc_valid_to && <> · valid to {ldc.ldc_valid_to}</>}
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className={num}>{r.voucher_count}</td>
              <td className={num}>{formatINR(Number(r.party_ledger_movement), { showZero: true })}</td>
              <td className={num + " font-medium"}>{formatINR(Number(r.tds_deducted), { showZero: true })}</td>
            </tr>
          );
        })}
        {rows.length > 0 && (
          <tr className="bg-bg font-semibold">
            <td className={td} colSpan={7}>
              Total
            </td>
            <td className={num}>{formatINR(total, { showZero: true })}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
