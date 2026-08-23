import { createClient } from "@/lib/supabase/server";
import { ShareRegisterManager } from "@/components/shares/ShareRegisterManager";

export default async function ShareCapitalPage({
  params,
}: PageProps<"/[companyId]/share-capital">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: company }, { data: shareClasses }, { data: holdings }, { data: summary }] =
    await Promise.all([
      supabase.from("companies").select("entity_type, name").eq("id", companyId).single(),
      supabase
        .from("share_classes")
        .select("id, class_name, nominal_value_per_share, authorized_shares")
        .eq("company_id", companyId)
        .order("class_name"),
      supabase
        .from("share_holdings")
        .select(
          "id, share_class_id, holder_name, holder_pan, holder_address, holder_occupation, consideration, shares_held, date_of_allotment, date_of_cessation, folio_number"
        )
        .eq("company_id", companyId)
        .order("date_of_cessation", { ascending: true, nullsFirst: true })
        .order("date_of_allotment", { ascending: true }),
      supabase.rpc("get_share_capital_summary", { p_company_id: companyId }),
    ]);

  const entityType = company?.entity_type ?? null;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Share capital &amp; Register of Members
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
          The Sec 88 Companies Act 2013 register this app never had: who holds shares, how many,
          and at what face value — the capital structure a filing needs to reference, and the
          input the Sec 2(85) small-company test and the Sec 186 investment ceiling both need but
          neither could previously compute. A holding that ends gets a cessation date recorded
          here rather than a deleted row, because Sec 88 requires the register to show who ceased
          to be a member and when, not just who currently is one.
        </p>
      </header>

      <ShareRegisterManager
        companyId={companyId}
        entityType={entityType}
        shareClasses={shareClasses ?? []}
        holdings={holdings ?? []}
        summary={summary ?? []}
      />

      <p className="mt-6 max-w-2xl text-xs text-ink-faint">
        This register captures what this app needs — name, PAN, address, occupation, class,
        shares, folio, allotment/cessation dates and consideration type — not the full Form MGT-1
        field set. E-mail, father&rsquo;s/mother&rsquo;s/spouse&rsquo;s name, status, nationality,
        joint holders and a minor&rsquo;s guardian are real Rule 3 fields this screen does not
        capture. It does not generate Form MGT-1, MGT-7 or MGT-7A, and it does not model a share
        transfer as a linked pair — recording one is two independent edits: the outgoing
        holder&rsquo;s row gets a cessation date, the incoming holder gets a new row.
      </p>
    </main>
  );
}
