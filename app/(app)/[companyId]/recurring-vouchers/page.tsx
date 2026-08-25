import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { RecurringVoucherManager } from "@/components/recurring-vouchers/RecurringVoucherManager";

type TemplateRow = {
  id: string;
  template_name: string;
  voucher_type: string;
  frequency: string;
  day_of_month: number;
  branch_id: string;
  branch_name: string;
  start_date: string;
  end_date: string | null;
  next_run_date: string;
  is_active: boolean;
  is_due: boolean;
  narration_template: string | null;
  party_ledger_id: string | null;
  party_ledger_name: string | null;
  line_count: number;
  template_amount: number;
  lines: {
    ledger_id: string;
    ledger_name: string;
    debit_amount: number;
    credit_amount: number;
    narration: string | null;
    line_order: number;
  }[];
  last_run_date: string | null;
  last_run_voucher_id: string | null;
  last_run_voucher_number: string | null;
};

export default async function RecurringVouchersPage({
  params,
}: PageProps<"/[companyId]/recurring-vouchers">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [templatesResult, branchesResult, ledgersResult] = await Promise.all([
    callRpc<{ p_company_id: string }, TemplateRow[]>(supabase, "list_recurring_voucher_templates", {
      p_company_id: companyId,
    }),
    supabase
      .from("branches")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("ledgers")
      .select("id, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
  ]);

  const templates = templatesResult.data ?? [];
  const branches = branchesResult.data ?? [];
  const ledgers = ledgersResult.data ?? [];

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Recurring vouchers
        </h1>
        <p className="mt-1 text-sm text-ink-soft">
          A template for a payment, receipt, contra or journal entry that repeats on a schedule —
          monthly rent, a fixed standing journal. Nothing posts to the books on its own: a template
          only produces a real voucher when you click Generate, so every entry still gets a look
          before it lands in the ledger. Sales, purchase, credit note and debit note invoices are
          not offered here — those need the item and GST computation the invoice screens do.
        </p>
      </header>

      <RecurringVoucherManager
        companyId={companyId}
        templates={templates}
        branches={branches}
        ledgers={ledgers}
      />
    </main>
  );
}
