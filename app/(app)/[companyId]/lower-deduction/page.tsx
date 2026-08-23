import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ReportShell } from "@/components/reports/ReportShell";
import { LowerDeductionManager } from "@/components/ledgers/LowerDeductionManager";

/** Today as a local wall-clock date — not toISOString(), which is UTC. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default async function LowerDeductionPage({
  params,
}: PageProps<"/[companyId]/lower-deduction">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: deductees }, { data: sections }] = await Promise.all([
    supabase
      .from("ledgers")
      .select(
        "id, name, default_tds_section, ldc_number, ldc_rate, ldc_valid_from, ldc_valid_to, ldc_amount_cap"
      )
      .eq("company_id", companyId)
      .eq("is_tds_deductee", true)
      .order("name"),
    supabase.from("ref_tds_sections").select("section_code, description, rate_percent"),
  ]);

  const today = todayLocal();
  const rows = deductees ?? [];
  const expiring = rows.filter(
    (d) => d.ldc_valid_to && d.ldc_valid_to >= today && d.ldc_valid_to <= addDays(today, 30)
  );
  const expired = rows.filter((d) => d.ldc_valid_to && d.ldc_valid_to < today);

  return (
    <ReportShell
      title="Lower deduction certificates"
      period="Section 197"
      status={{
        label: expired.length > 0 ? `${expired.length} expired` : `${rows.length} deductees`,
        tone: expired.length > 0 ? "warn" : "ok",
      }}
    >
      {(expiring.length > 0 || expired.length > 0) && (
        <div className="border-b border-border bg-warning-soft px-4 py-3 text-xs text-ink">
          {expired.length > 0 && (
            <p>
              <strong className="font-medium">
                {expired.length === 1 ? "One certificate has" : `${expired.length} certificates have`}{" "}
                expired.
              </strong>{" "}
              TDS is already being deducted at the full section rate for{" "}
              {expired.map((d) => d.name).join(", ")} — the lower rate stops applying on the day
              after the certificate ends, with no warning at the point of entry.
            </p>
          )}
          {expiring.length > 0 && (
            <p className={expired.length > 0 ? "mt-1" : ""}>
              Expiring within 30 days: {expiring.map((d) => d.name).join(", ")}. A renewal has to be
              applied for and issued before the current one lapses.
            </p>
          )}
        </div>
      )}

      <LowerDeductionManager deductees={rows} sections={sections ?? []} today={today} />

      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Under Sec 197 a deductee can obtain a certificate directing TDS at a lower rate, or nil, and
        the deductor must honour it for the period it covers. Entering one here changes what the{" "}
        <Link href={`/${companyId}/vouchers/new`} className="underline">
          voucher form
        </Link>{" "}
        deducts: inside the validity window, and at or under the amount cap if one is set, it
        applies the certificate rate instead of the section rate.
      </p>
      <p className="border-t border-border px-4 py-3 text-xs text-ink-faint">
        Two behaviours worth knowing. The cap is a per-line test, not a running total — an amount
        above it is deducted entirely at the full section rate rather than split across the two
        rates, which is the simplification this app makes rather than pretending to a precision it
        does not track. And a certificate needs both dates: a rate without a validity window would
        never be applied, so it cannot be saved without one. A nil certificate is entered as 0%.
      </p>
    </ReportShell>
  );
}

/** Date arithmetic at noon UTC so it cannot slip a day either way. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
