import { createClient } from "@/lib/supabase/server";
import { ReconciliationScreen } from "@/components/reconciliation/ReconciliationScreen";

export default async function ReconciliationPage({
  params,
  searchParams,
}: PageProps<"/[companyId]/reconciliation">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: bankLedgers } = await supabase
    .from("ledgers")
    .select("id, name, account_groups!inner(ledger_role)")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .eq("account_groups.ledger_role", "cash_bank")
    .order("name");

  const ledgerId =
    typeof sp.ledger === "string" ? sp.ledger : (bankLedgers?.[0]?.id ?? null);

  if (!ledgerId) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Bank reconciliation</h1>
        <p className="mt-8 rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          No cash or bank ledger exists yet.
        </p>
      </main>
    );
  }

  const [{ data: summary }, { data: unmatchedEntries }, { data: unmatchedLines }, { data: existingLines }] =
    await Promise.all([
      supabase.rpc("get_bank_reconciliation_summary", {
        p_company_id: companyId,
        p_ledger_id: ledgerId,
      }),
      supabase
        .from("voucher_entries")
        .select("id, debit_amount, credit_amount, vouchers!inner(voucher_number, voucher_date, narration, is_deleted)")
        .eq("company_id", companyId)
        .eq("ledger_id", ledgerId)
        .eq("vouchers.is_deleted", false)
        .order("vouchers(voucher_date)"),
      supabase
        .from("bank_statement_lines")
        .select("id, txn_date, description, reference, debit_amount, credit_amount")
        .eq("company_id", companyId)
        .eq("ledger_id", ledgerId)
        .is("matched_entry_id", null)
        .order("txn_date"),
      supabase
        .from("bank_statement_lines")
        .select("txn_date, description, debit_amount, credit_amount")
        .eq("company_id", companyId)
        .eq("ledger_id", ledgerId),
    ]);

  // The unmatched-entries query can't filter matched_entry_id from here (it
  // lives on the other table), so exclude client-side against the same
  // matched set the summary counted.
  const { data: matchedIds } = await supabase
    .from("bank_statement_lines")
    .select("matched_entry_id")
    .eq("company_id", companyId)
    .eq("ledger_id", ledgerId)
    .not("matched_entry_id", "is", null);

  const matchedSet = new Set((matchedIds ?? []).map((m) => m.matched_entry_id));
  const trulyUnmatchedEntries = (unmatchedEntries ?? []).filter((e) => !matchedSet.has(e.id));

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Bank reconciliation</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        Matching a statement line to a book entry needs the opposite side on
        each: money the bank shows coming in (a credit) matches money your
        books show going into the account (a debit).
      </p>

      <ReconciliationScreen
        companyId={companyId}
        ledgerId={ledgerId}
        bankLedgers={
          (bankLedgers ?? []).map((l) => ({ id: l.id, name: l.name }))
        }
        summary={summary?.[0] ?? null}
        unmatchedEntries={trulyUnmatchedEntries.map((e) => ({
          id: e.id,
          debit_amount: Number(e.debit_amount),
          credit_amount: Number(e.credit_amount),
          voucher_number: e.vouchers!.voucher_number,
          voucher_date: e.vouchers!.voucher_date,
          narration: e.vouchers!.narration,
        }))}
        unmatchedLines={(unmatchedLines ?? []).map((l) => ({
          id: l.id,
          txn_date: l.txn_date,
          description: l.description,
          reference: l.reference,
          debit_amount: Number(l.debit_amount),
          credit_amount: Number(l.credit_amount),
        }))}
        existingLines={(existingLines ?? []).map((l) => ({
          txnDate: l.txn_date,
          description: l.description,
          debit: Number(l.debit_amount),
          credit: Number(l.credit_amount),
        }))}
      />
    </main>
  );
}
