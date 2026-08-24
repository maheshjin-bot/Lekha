import { createClient } from "@/lib/supabase/server";
import { ChargeRegisterManager } from "@/components/charges/ChargeRegisterManager";

export default async function ChargesPage({
  params,
}: PageProps<"/[companyId]/charges">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: company }, { data: charges }, { data: summary }] = await Promise.all([
    supabase.from("companies").select("entity_type, name").eq("id", companyId).single(),
    supabase
      .from("charges")
      .select(
        "id, charge_holder_name, charge_type, amount_secured, assets_charged, date_of_creation, chg1_filing_date, chg1_srn, date_of_satisfaction, chg4_filing_date, chg4_srn, notes"
      )
      .eq("company_id", companyId)
      .order("date_of_satisfaction", { ascending: true, nullsFirst: true })
      .order("date_of_creation", { ascending: false }),
    supabase.rpc("get_charges_summary", { p_company_id: companyId }),
  ]);

  const entityType = company?.entity_type ?? null;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Register of Charges
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          The Sec 85 Companies Act 2013 register this app never had — every mortgage,
          hypothecation, pledge or other charge created over the company&rsquo;s property to
          secure a loan (Sec 77, Form CHG-1), and its eventual satisfaction on repayment or
          release (Sec 82, Form CHG-4). A charge is registrable within 30 days of creation,
          extendable up to 120 days on payment of additional/ad valorem fees before Central
          Government condonation (Sec 87) is the only route left.
        </p>
      </header>

      <ChargeRegisterManager
        companyId={companyId}
        entityType={entityType}
        charges={charges ?? []}
        summary={summary ?? []}
      />

      <p className="mt-6 max-w-2xl text-xs text-ink-faint">
        This register records who holds a charge, over what, and its CHG-1/CHG-4 filing
        particulars — it does not generate Form CHG-1, CHG-4, CHG-7 or CHG-8 itself, verify an
        SRN against the MCA portal, or hard-block a write once the statutory filing window has
        passed (the overdue counts above are informational). An LLP&rsquo;s parallel charge
        obligation is filed on Form 8 under the LLP Act, a different form under a different Act —
        not represented here.
      </p>
    </main>
  );
}
