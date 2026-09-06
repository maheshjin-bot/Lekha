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

  const [
    { data: summary },
    { data: unmatchedEntries },
    { data: unmatchedLines },
    { data: matchedLines },
    { data: existingLines },
    { data: suggestionEvents },
  ] = await Promise.all([
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
    // The other half of the reconciliation, and until now the invisible
    // half: once a line was matched it was filtered out of the query above
    // and appeared nowhere else on this screen. A wrong match — especially
    // one auto-match made in bulk — was therefore permanent and unseen, and
    // re-importing the statement cannot undo it (the upsert skips rows whose
    // fingerprint is already on file). Loading them here is what makes
    // unmatch_bank_line reachable at all.
    //
    // is_deleted is read, not filtered on: a line matched to a voucher that
    // has since been deleted is exactly the stale match that most needs
    // unmatching, so it must show rather than silently vanish again.
    supabase
      .from("bank_statement_lines")
      .select(
        "id, txn_date, description, reference, debit_amount, credit_amount, matched_at, matched_entry_id, voucher_entries!inner(id, debit_amount, credit_amount, vouchers!inner(voucher_number, voucher_date, narration, is_deleted))"
      )
      .eq("company_id", companyId)
      .eq("ledger_id", ledgerId)
      .not("matched_entry_id", "is", null)
      .order("matched_at", { ascending: false }),
    // external_txn_id (0164) predates the generated types being
    // refreshed — same "as any" escape hatch the manufacturing/backup
    // code already uses for a column/table ahead of codegen.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase.from("bank_statement_lines") as any)
      .select("external_txn_id")
      .eq("company_id", companyId)
      .eq("ledger_id", ledgerId) as Promise<{ data: { external_txn_id: string }[] | null }>,
    // payment_webhook_events (1420) predates codegen too. A SUGGESTION only
    // — never authoritative, see that migration's own header — surfaced
    // here as a highlighted banner on the matching unmatched line, never as
    // a new way to actually confirm a match (match_bank_line, below, is
    // reused completely unmodified).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any).from("payment_webhook_events")
      .select("bank_statement_line_id, suggested_voucher_id, suggested_ledger_id, suggested_reason, amount")
      .eq("company_id", companyId)
      .eq("status", "suggested")
      .not("bank_statement_line_id", "is", null) as Promise<{
      data:
        | {
            bank_statement_line_id: string;
            suggested_voucher_id: string;
            suggested_ledger_id: string;
            suggested_reason: string | null;
            amount: number;
          }[]
        | null;
    }>,
  ]);

  // Stitched client-side (here, server-side in the page) rather than via a
  // PostgREST embed — payment_webhook_events carries two separate FKs
  // (vouchers, ledgers via a composite key) and this keeps both lookups
  // simple and independently typed rather than risking an ambiguous embed
  // hint on a table PostgREST's schema cache learned about ahead of codegen.
  const suggestionRows = suggestionEvents ?? [];
  const suggestedVoucherIds = [...new Set(suggestionRows.map((s) => s.suggested_voucher_id))];
  const suggestedLedgerIds = [...new Set(suggestionRows.map((s) => s.suggested_ledger_id))];

  const [{ data: suggestedVouchers }, { data: suggestedLedgers }] = await Promise.all([
    suggestedVoucherIds.length
      ? supabase.from("vouchers").select("id, voucher_number").in("id", suggestedVoucherIds)
      : Promise.resolve({ data: [] as { id: string; voucher_number: string }[] }),
    suggestedLedgerIds.length
      ? supabase.from("ledgers").select("id, name").in("id", suggestedLedgerIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  const voucherNumberById = new Map((suggestedVouchers ?? []).map((v) => [v.id, v.voucher_number]));
  const ledgerNameById = new Map((suggestedLedgers ?? []).map((l) => [l.id, l.name]));

  const suggestionByLineId = new Map(
    suggestionRows.map((s) => [
      s.bank_statement_line_id,
      {
        ledgerName: ledgerNameById.get(s.suggested_ledger_id) ?? "an unknown ledger",
        voucherNumber: voucherNumberById.get(s.suggested_voucher_id) ?? "an invoice",
        amount: Number(s.amount),
        reason: s.suggested_reason,
      },
    ])
  );

  // The unmatched-entries query can't filter matched_entry_id from here (it
  // lives on the other table), so exclude client-side against the same
  // matched set the summary counted — now taken straight off the matched-lines
  // query above rather than fetched a second time, since it is the same set.
  const matchedSet = new Set((matchedLines ?? []).map((m) => m.matched_entry_id));
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
          suggestion: suggestionByLineId.get(l.id) ?? null,
        }))}
        matchedLines={(matchedLines ?? []).map((l) => ({
          id: l.id,
          txn_date: l.txn_date,
          description: l.description,
          reference: l.reference,
          debit_amount: Number(l.debit_amount),
          credit_amount: Number(l.credit_amount),
          matched_at: l.matched_at,
          entry_debit: Number(l.voucher_entries!.debit_amount),
          entry_credit: Number(l.voucher_entries!.credit_amount),
          voucher_number: l.voucher_entries!.vouchers!.voucher_number,
          voucher_date: l.voucher_entries!.vouchers!.voucher_date,
          narration: l.voucher_entries!.vouchers!.narration,
          voucher_is_deleted: l.voucher_entries!.vouchers!.is_deleted,
        }))}
        existingLines={(existingLines ?? []).map((l) => ({
          externalTxnId: l.external_txn_id,
        }))}
      />
    </main>
  );
}
