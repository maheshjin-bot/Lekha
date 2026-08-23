import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils/cn";
import { VoucherImport } from "@/components/csv/VoucherImport";
import { InvoiceImport } from "@/components/csv/InvoiceImport";
import { ItemImport } from "@/components/csv/ItemImport";
import { LedgerImport } from "@/components/csv/LedgerImport";

const TABS = [
  { key: "vouchers", label: "Vouchers" },
  { key: "invoices", label: "Sales & purchase" },
  { key: "items", label: "Items" },
  { key: "ledgers", label: "Ledgers" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const COPY: Record<TabKey, { title: string; description: string }> = {
  vouchers: {
    title: "Import vouchers",
    description:
      "One row per line item. Rows sharing a Voucher Ref become one voucher, so they must agree on the date, type and reference — the preview checks that before anything is written.",
  },
  invoices: {
    title: "Import sales & purchase",
    description:
      "One row per invoice line. Rows sharing an Invoice Ref become one invoice — GST and TCS are computed the same way they are when typed into the Invoice form, not from anything in the file.",
  },
  items: {
    title: "Import items",
    description: "One row per item — the same fields the Items form takes, ready in bulk.",
  },
  ledgers: {
    title: "Import ledgers",
    description: "One row per ledger — the same fields the Ledgers form takes, ready in bulk.",
  },
};

export default async function ImportPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/import">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "vouchers";
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("lock_date")
    .eq("id", companyId)
    .maybeSingle();

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        {COPY[tab].title}
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">{COPY[tab].description}</p>

      <nav className="mt-6 flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/${companyId}/import?tab=${t.key}`}
            className={cn(
              "border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              t.key === tab
                ? "border-accent text-accent"
                : "border-transparent text-ink-soft hover:text-ink"
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "vouchers" && <VouchersTab companyId={companyId} lockDate={company?.lock_date ?? null} />}
      {tab === "invoices" && <InvoicesTab companyId={companyId} lockDate={company?.lock_date ?? null} />}
      {tab === "items" && <ItemsTab companyId={companyId} />}
      {tab === "ledgers" && <LedgersTab companyId={companyId} />}
    </main>
  );
}

async function VouchersTab({ companyId, lockDate }: { companyId: string; lockDate: string | null }) {
  const supabase = await createClient();
  const [{ data: ledgers }, { data: branches }] = await Promise.all([
    supabase.from("ledgers").select("id, name").eq("company_id", companyId).eq("is_active", true).order("name"),
    supabase
      .from("branches")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false }),
  ]);
  return (
    <VoucherImport companyId={companyId} ledgers={ledgers ?? []} branches={branches ?? []} lockDate={lockDate} />
  );
}

async function InvoicesTab({ companyId, lockDate }: { companyId: string; lockDate: string | null }) {
  const supabase = await createClient();
  const [{ data: items }, { data: ledgers }, { data: branches }, { data: godowns }] = await Promise.all([
    supabase
      .from("items")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("ledgers")
      .select("id, name, account_groups(ledger_role), state_code")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("branches")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false }),
    supabase
      .from("godowns")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_default", { ascending: false }),
  ]);

  const flatLedgers = (ledgers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    ledger_role: l.account_groups?.ledger_role ?? "other",
    state_code: l.state_code,
  }));

  return (
    <InvoiceImport
      companyId={companyId}
      items={items ?? []}
      ledgers={flatLedgers}
      branches={branches ?? []}
      godowns={godowns ?? []}
      lockDate={lockDate}
    />
  );
}

async function ItemsTab({ companyId }: { companyId: string }) {
  const supabase = await createClient();
  const [{ data: uoms }, { data: tcsSections }, { data: existing }] = await Promise.all([
    supabase.from("ref_uom").select("code, name").order("name"),
    supabase.from("ref_tcs_sections").select("section_code").eq("is_active", true),
    supabase.from("items").select("name").eq("company_id", companyId),
  ]);
  return (
    <ItemImport
      companyId={companyId}
      uoms={uoms ?? []}
      tcsSections={tcsSections ?? []}
      existingNames={(existing ?? []).map((r) => r.name)}
    />
  );
}

async function LedgersTab({ companyId }: { companyId: string }) {
  const supabase = await createClient();
  const [{ data: groups }, { data: tdsSections }, { data: existing }] = await Promise.all([
    supabase
      .from("account_groups")
      .select("id, name, parent_group_id")
      .eq("company_id", companyId)
      .order("sort_order"),
    supabase.from("ref_tds_sections").select("section_code").eq("is_active", true),
    supabase.from("ledgers").select("name").eq("company_id", companyId),
  ]);
  return (
    <LedgerImport
      companyId={companyId}
      groups={groups ?? []}
      tdsSections={tdsSections ?? []}
      existingNames={(existing ?? []).map((r) => r.name)}
    />
  );
}
