import { createClient } from "@/lib/supabase/server";
import { DscRegisterManager, type DscRow } from "@/components/dsc/DscRegisterManager";

export default async function DscRegisterPage({
  params,
}: PageProps<"/[companyId]/dsc-register">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: dscRows }, { data: expiry }, { data: directors }] = await Promise.all([
    supabase
      .from("digital_signature_certificates")
      .select(
        "id, holder_director_id, holder_name, certifying_authority, dsc_class, valid_from, valid_to, token_serial_number, notes"
      )
      .eq("company_id", companyId),
    supabase.rpc("get_dsc_expiry_status", { p_company_id: companyId }),
    supabase
      .from("company_directors")
      .select("id, name, designation, date_of_cessation")
      .eq("company_id", companyId)
      .order("date_of_cessation", { ascending: true, nullsFirst: true })
      .order("name"),
  ]);

  // get_dsc_expiry_status LEFT JOINs company_directors, so designation is
  // genuinely nullable at runtime for a free-text (non-director) holder —
  // Supabase's typegen can't see through that join and marks it non-null.
  type ExpiryRow = Omit<NonNullable<typeof expiry>[number], "designation"> & {
    designation: string | null;
  };
  const expiryRows = (expiry ?? []) as unknown as ExpiryRow[];
  const expiryById = new Map(expiryRows.map((e) => [e.id, e]));

  // Merge the raw editable row with its computed expiry status — the RPC is
  // the single source of truth for urgency (never stored, see 0117), the
  // table read is what the edit form needs (notes, token serial, raw
  // holder fields the RPC's holder_label collapses into one string).
  const rows: DscRow[] = (dscRows ?? [])
    .map((r) => {
      const e = expiryById.get(r.id);
      if (!e) return null;
      return {
        ...r,
        holder_label: e.holder_label,
        designation: e.designation,
        days_remaining: e.days_remaining,
        is_expired: e.is_expired,
        expiring_within_30_days: e.expiring_within_30_days,
        expiring_within_60_days: e.expiring_within_60_days,
        expiring_within_90_days: e.expiring_within_90_days,
      };
    })
    .filter((r): r is DscRow => r !== null)
    .sort((a, b) => a.valid_to.localeCompare(b.valid_to));

  const expiringSoon = rows.filter((r) => !r.is_expired && r.expiring_within_30_days).length;
  const expired = rows.filter((r) => r.is_expired).length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          DSC register
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          Every Digital Signature Certificate used to sign this company&rsquo;s ROC, GST and
          income-tax filings — who holds it, which authority issued it, and when it lapses. A DSC
          holder is often a director but just as often a practising CA or outsourced signatory
          with no board role.
        </p>
        {(expired > 0 || expiringSoon > 0) && (
          <p className="mt-2 text-sm">
            {expired > 0 && <span className="font-semibold text-error">{expired} expired</span>}
            {expired > 0 && expiringSoon > 0 && <span className="text-ink-faint"> · </span>}
            {expiringSoon > 0 && (
              <span className="font-semibold text-warning">
                {expiringSoon} expiring within 30 days
              </span>
            )}
          </p>
        )}
      </header>

      <DscRegisterManager companyId={companyId} rows={rows} directors={directors ?? []} />

      <p className="mt-6 max-w-2xl text-xs text-ink-faint">
        This is a record of what the business already holds — it does not verify a certificate
        against the CCA/MCA database (no API access for that), does not renew or issue a DSC, and
        does not attach the certificate file itself. Class 2 DSCs have not been newly issued since
        1 Jan 2021 (folded into Class 3) — a certificate on file dated after that should ordinarily
        read Class 3.
      </p>
    </main>
  );
}
