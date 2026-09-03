-- ============================================================================
-- 1590 — the foreign-currency exposure an INVOICE never retained
-- ============================================================================
-- create_invoice has accepted p_txn_currency/p_exchange_rate/p_rate_source
-- since 0065, and settlement (0068) and revaluation (0071) were built on top
-- of that. But both of those read the exposure off ONE PLACE — a
-- voucher_entries row carrying fc_amount:
--
--   get_open_fc_vouchers (0071):  join ... on e.voucher_id = v.id and e.fc_amount is not null
--   record_forex_settlement:      'This voucher has no line carrying a
--                                  foreign-currency amount — nothing to settle'
--
-- and create_invoice never wrote fc_amount on anything. create_voucher and
-- update_voucher DO (both read `fc_amount` out of each p_lines element, which
-- is how the /forex screen's own journal/receipt/payment form works), so the
-- gap was invoices only. Proved live before writing this, on real data in the
-- shared project — Sharma Textiles' HO/SAL/2026-27/00010, a USD export sale
-- posted through create_invoice:
--
--   txn_currency USD, exchange_rate 83.5, supply_type export_igst
--   Dr Global Overseas Buyer (Export)  59000.00   fc_amount NULL
--   Cr Sales Account                   50000.00   fc_amount NULL
--   Cr Output IGST (07)                 9000.00   fc_amount NULL
--
-- i.e. a foreign-currency invoice could be recorded, and was then invisible
-- to /forex and permanently unsettleable — the AS 11 chain had nothing to
-- operate on. That is the defect this migration closes.
--
-- WHY A TRIGGER RATHER THAN RE-ISSUING create_invoice's BODY. The exposure is
-- a DERIVED fact about the party leg of a non-INR invoice, and it is wanted on
-- every path that posts one, not just the two functions this migration would
-- otherwise have had to restate: create_invoice, update_invoice (which
-- full-replaces voucher_entries and would strip the stamp back off on the
-- first edit), bulk invoice import (0048), quick billing/POS, the capture
-- review queue and the recurring-voucher generator all end up in the same
-- INSERT. A BEFORE INSERT trigger stamps all of them at once, in ~20 lines,
-- instead of adding the same block to a 400-line function body five times and
-- getting it wrong in one of them.
--
-- NARROWLY SCOPED SO IT CANNOT LEAK. It only ever fires on:
--   * an invoice-type voucher (sales/purchase/credit_note/debit_note) — this
--     is what keeps it away from record_forex_settlement's own receipt/payment
--     voucher and record_forex_revaluation's journal, which are non-INR too.
--     Stamping THOSE would make every settlement receipt show up in
--     get_open_fc_vouchers as a fresh open exposure needing settlement,
--     forever, which is worse than the bug being fixed;
--   * whose txn_currency is not INR;
--   * on the line hitting the voucher's own party_ledger_id;
--   * when the caller did not set fc_amount itself (so create_voucher's
--     explicit per-line fc_amount always wins);
--   * when no other line on the voucher carries one already (settlement and
--     revaluation both refuse a voucher with two FC legs, so "the first one
--     wins" is the only safe rule).
--
-- THE ARITHMETIC, and why it is this way round. The INR figures are the books
-- (LEKHA is INR-only; currency is metadata on the transaction), so the
-- exposure is derived FROM the posted rupee amount, not the other way:
--
--   fc_amount := round(party_leg_inr / exchange_rate, 2)
--
-- The invariant that matters is that settlement can CLOSE the party ledger:
-- record_forex_settlement credits round(fc_amount x carrying_rate, 2), so
-- round(round(G/r,2) x r, 2) has to come back to G. Over the 2-decimal grid
-- fc_amount lives on, round(G/r,2) is provably the closest available value —
-- but it is not always exactly G: the residue is bounded by half a paise of
-- FC times the rate (about 44 paise at USD 88), and is exactly zero whenever
-- G/r lands on a 2-decimal figure, which is the normal case for an invoice
-- priced in the foreign currency. An exposure taken from the user's own
-- stated FC total instead would be off by RUPEES, not paise, the moment
-- per-line rate rounding moved the posted total — so this is the better of
-- the two, not a free choice. Called out in full in the task report rather
-- than buried: fc_amount numeric(18,2) plus a free-form rate cannot express
-- every pair exactly, and no arithmetic here can change that.
--
-- ALSO IN THIS MIGRATION, because the first one makes them reachable:
--   2. a guard that refuses to rewrite the lines of a SETTLED or REVALUED
--      foreign-currency voucher (update_invoice/update_voucher full-replace
--      their lines, which would silently leave the settlement closing an
--      amount the invoice no longer carries);
--   3. delete_voucher releasing the fc_settled_at / fc_last_revalued_rate
--      markers when the settlement or revaluation voucher is itself deleted.
--      Without (3), (2) would be a dead end — and on its own (3) fixes a real
--      pre-existing hole: deleting a settlement voucher left the original
--      flagged settled forever, out of get_open_fc_vouchers, with nothing in
--      the app able to reopen it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The exposure itself.
-- ---------------------------------------------------------------------------
create or replace function app_private.set_invoice_fc_exposure()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_type text;
  v_party uuid;
  v_currency text;
  v_rate numeric;
  v_inr numeric;
begin
  -- The caller was explicit (create_voucher/update_voucher take fc_amount per
  -- line, which is how the /forex screen posts). Never second-guessed.
  if new.fc_amount is not null then
    return new;
  end if;

  v_inr := coalesce(new.debit_amount, 0) + coalesce(new.credit_amount, 0);
  if v_inr = 0 then
    return new;
  end if;

  select v.voucher_type, v.party_ledger_id, btrim(v.txn_currency), v.exchange_rate
    into v_type, v_party, v_currency, v_rate
    from public.vouchers v
   where v.id = new.voucher_id;

  -- The parent is already gone: this row is being cascaded away. Same reason
  -- app_private.enforce_period_open_voucher_line steps aside here — raising,
  -- or reading a null row's columns, would break ON DELETE CASCADE.
  if not found then
    return new;
  end if;

  if v_type not in ('sales', 'purchase', 'credit_note', 'debit_note')
     or v_currency is null or v_currency = 'INR'
     or v_party is null or new.ledger_id <> v_party
     or v_rate is null or v_rate <= 0 then
    return new;
  end if;

  -- One FC leg per voucher, first one wins — see the header. Reached only on
  -- the party line of a non-INR invoice, so this costs nothing on the INR path
  -- every other voucher in the database takes.
  if exists (
    select 1 from public.voucher_entries e
     where e.voucher_id = new.voucher_id and e.fc_amount is not null
  ) then
    return new;
  end if;

  new.fc_amount := round(v_inr / v_rate, 2);
  return new;
end;
$$;

comment on function app_private.set_invoice_fc_exposure() is
  'BEFORE INSERT on voucher_entries: stamps the foreign-currency exposure (fc_amount = party leg INR / exchange_rate, 2dp) on the party line of a non-INR sales/purchase/credit-note/debit-note voucher, which is the one place get_open_fc_vouchers and record_forex_settlement/record_forex_revaluation look for it. Never touches a line the caller gave an fc_amount to, a second FC leg, or a receipt/payment/journal — settlement and revaluation post those themselves and must not reappear as fresh open exposures. See migration 1590.';

drop trigger if exists set_invoice_fc_exposure on public.voucher_entries;
create trigger set_invoice_fc_exposure
  before insert on public.voucher_entries
  for each row execute function app_private.set_invoice_fc_exposure();

-- ---------------------------------------------------------------------------
-- 2. Don't let a settled or revalued FC voucher be rewritten underneath its
--    settlement. update_invoice and update_voucher both full-replace
--    voucher_entries (delete, then re-insert), so guarding the DELETE guards
--    the edit — and it guards it for every future editor too.
-- ---------------------------------------------------------------------------
create or replace function app_private.guard_settled_fc_voucher_line()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v record;
begin
  select v2.company_id, v2.voucher_number, btrim(v2.txn_currency) as txn_currency,
         v2.fc_settled_at, v2.fc_last_revalued_at, v2.fc_settlement_voucher_id
    into v
    from public.vouchers v2
   where v2.id = old.voucher_id;

  -- The voucher itself is already going: an ordinary cascade, nothing to
  -- protect.
  if not found then
    return old;
  end if;

  -- The whole company is going. Checked separately and explicitly, because
  -- voucher_entries cascades from vouchers which cascades from companies, and
  -- the voucher row can still be visible while its company is mid-delete —
  -- raising here would block ON DELETE CASCADE outright.
  if not exists (select 1 from public.companies c where c.id = v.company_id) then
    return old;
  end if;

  if v.txn_currency is null or v.txn_currency = 'INR' then
    return old;
  end if;

  if v.fc_settled_at is not null then
    raise exception
      'Voucher % has already been settled in %, and its settlement voucher closes the party ledger for exactly the amount posted here. Changing these lines now would leave that settlement closing an amount this voucher no longer carries. Delete the settlement voucher first (that reopens this one), then edit it.',
      v.voucher_number, v.txn_currency;
  end if;

  if v.fc_last_revalued_at is not null then
    raise exception
      'Voucher % has been revalued to a later closing rate (as at %), and that revaluation posted the difference against the amount currently on these lines. Changing them now would leave the revaluation restating a figure this voucher no longer carries. Delete the revaluation journal first (that rolls this one back to its previous carrying rate), then edit it.',
      v.voucher_number, to_char(v.fc_last_revalued_at, 'DD Mon YYYY');
  end if;

  return old;
end;
$$;

comment on function app_private.guard_settled_fc_voucher_line() is
  'BEFORE DELETE on voucher_entries: refuses to let the lines of a settled or revalued foreign-currency voucher be replaced, which is how update_invoice/update_voucher edit a document. Steps aside when the parent voucher — or the whole company — is already being cascaded away. The way out is deleting the settlement or revaluation voucher, which delete_voucher now releases the marker for. See migration 1590.';

drop trigger if exists guard_settled_fc_voucher_line on public.voucher_entries;
create trigger guard_settled_fc_voucher_line
  before delete on public.voucher_entries
  for each row execute function app_private.guard_settled_fc_voucher_line();

-- ---------------------------------------------------------------------------
-- 3. Deleting a settlement or revaluation voucher releases what it marked.
--    Two partial indexes first: delete_voucher now looks up "is anything
--    pointing at me", once per deletion.
-- ---------------------------------------------------------------------------
create index if not exists vouchers_fc_settlement_voucher_id_idx
  on public.vouchers (fc_settlement_voucher_id)
  where fc_settlement_voucher_id is not null;

create index if not exists vouchers_fc_revalues_voucher_id_idx
  on public.vouchers (fc_revalues_voucher_id)
  where fc_revalues_voucher_id is not null;

create or replace function public.delete_voucher(p_company_id uuid, p_voucher_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_company_id uuid;
  v_is_deleted boolean;
  v_revalues uuid;
  v_rate numeric;
  v_date date;
begin
  select company_id, is_deleted, fc_revalues_voucher_id
    into v_company_id, v_is_deleted, v_revalues
    from public.vouchers
   where id = p_voucher_id;

  if v_company_id is null or v_company_id <> p_company_id then
    raise exception 'Voucher not found';
  end if;

  -- Idempotent: already deleted is a harmless no-op, not an error.
  if v_is_deleted then
    return;
  end if;

  if exists (
    select 1
      from public.voucher_entries e
      join public.bank_statement_lines l on l.matched_entry_id = e.id
     where e.voucher_id = p_voucher_id
  ) then
    raise exception 'This voucher has a bank-reconciled entry — unmatch it in Reconciliation before deleting.';
  end if;

  update public.vouchers
     set is_deleted = true,
         updated_by = auth.uid()
   where id = p_voucher_id;

  -- 1590. Everything below is new; everything above is delete_voucher exactly
  -- as it has been since 0007.
  --
  -- This voucher was the SETTLEMENT of a foreign-currency voucher (0068). Its
  -- postings are gone now, so the exposure it closed is open again — without
  -- this the original stayed flagged fc_settled_at forever, dropped out of
  -- get_open_fc_vouchers, and nothing in the app could reopen it.
  update public.vouchers
     set fc_settled_at = null,
         fc_settlement_voucher_id = null,
         updated_by = auth.uid()
   where fc_settlement_voucher_id = p_voucher_id;

  -- This voucher was a REVALUATION (0071). The original's carrying rate rolls
  -- back to whichever revaluation still stands — or to null, meaning "never
  -- revalued", when this was the only one. Both columns are set from the same
  -- row so they can never disagree, and a null v_rate/v_date is exactly the
  -- reset case (coalesce(fc_last_revalued_rate, exchange_rate) then reads the
  -- original transaction rate again, which is what every consumer expects).
  if v_revalues is not null then
    select r.exchange_rate, r.voucher_date
      into v_rate, v_date
      from public.vouchers r
     where r.fc_revalues_voucher_id = v_revalues
       and r.id <> p_voucher_id
       and not r.is_deleted
     order by r.voucher_date desc, r.created_at desc
     limit 1;

    update public.vouchers
       set fc_last_revalued_rate = v_rate,
           fc_last_revalued_at = v_date,
           updated_by = auth.uid()
     where id = v_revalues;
  end if;
end;
$$;

revoke all on function public.delete_voucher(uuid, uuid) from public, anon;
grant execute on function public.delete_voucher(uuid, uuid) to authenticated;

comment on function public.delete_voucher(uuid, uuid) is
  'Soft-deletes a voucher (is_deleted), refusing while any of its lines is matched to a bank statement line. Since 1590 it also releases what the deleted voucher had marked on a foreign-currency voucher: a settlement voucher''s deletion clears fc_settled_at/fc_settlement_voucher_id on the voucher it closed, and a revaluation journal''s deletion rolls fc_last_revalued_rate/at back to the latest revaluation still standing (or to null when none is left).';

-- ---------------------------------------------------------------------------
-- 4. record_forex_settlement: stop introducing a rounding residue on the
--    (common) never-revalued path.
--
-- Proved with real numbers before writing this, not assumed: an invoice
-- posted Dr Debtors 11800.00 at exchange_rate 88 gets fc_amount =
-- round(11800 / 88, 2) = 134.09 from part 1 of this migration. 134.09 is the
-- closest available value on the 2-decimal grid fc_amount lives on, but it
-- does not round-trip: round(134.09 * 88, 2) = 11799.92, eight paise short
-- of the 11800.00 actually posted. 0071's record_forex_settlement computes
-- exactly that recomputed figure (v_carrying_inr := round(fc_amount x
-- carrying_rate, 2)) and credits it to close the party ledger — so settling
-- this voucher at ANY rate, including its own original rate, would leave
-- 8 paise sitting in Debtors forever, never reconciled by anything in the
-- app. That is a real defect, not a rounding nitpick: "branch current
-- accounts net to zero" and an exact ledger are the whole point of this
-- product.
--
-- THE FIX, narrowly targeted: when the voucher has NEVER been revalued
-- (fc_last_revalued_rate is null — the ordinary case, and the one this
-- migration's own part 1 just made reachable for the first time from an
-- invoice), the party ledger's real outstanding balance is not a derived
-- quantity at all — it is exactly what got posted, v_fc_leg.debit_amount or
-- credit_amount, already sitting in the row with no rounding involved.
-- Reading it directly instead of recomputing through fc_amount closes the
-- ledger to precisely zero. Once a revaluation HAS happened, 0071's own
-- recompute is kept exactly as it was: there is genuinely no single posted
-- row left holding "the current amount" (0071's entire premise — it is
-- spread across however many revaluation vouchers have since been posted),
-- so fc_amount x carrying_rate is still the only way to get it.
--
-- This also strictly improves the ForexManager path, where fc_amount is
-- typed by hand rather than derived: reading the posted amount directly
-- closes the ledger for what is actually outstanding on it regardless of
-- whether the preparer's typed fc_amount happens to multiply back to it
-- exactly.
--
-- Signature unchanged from 0068/0071, so CREATE OR REPLACE is safe — no DROP
-- needed, matching how 0071 itself re-issued this same function.
-- ---------------------------------------------------------------------------
create or replace function public.record_forex_settlement(
  p_company_id uuid,
  p_branch_id uuid,
  p_original_voucher_id uuid,
  p_settlement_date date,
  p_settlement_rate numeric,
  p_settlement_ledger_id uuid,
  p_rate_source text default null,
  p_narration text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_original record;
  v_fc_leg record;
  v_carrying_rate numeric;
  v_carrying_inr numeric;
  v_settlement_inr numeric;
  v_gain_loss numeric;
  v_gain_loss_ledger uuid;
  v_voucher_type text;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_new_voucher_id uuid;
  v_line int := 0;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to record a settlement for this company';
  end if;
  if not (p_settlement_rate > 0) then
    raise exception 'Settlement rate must be greater than zero';
  end if;

  select id, voucher_date, txn_currency, exchange_rate, fc_settled_at,
         fc_last_revalued_rate
    into v_original
    from public.vouchers
   where id = p_original_voucher_id and company_id = p_company_id and not is_deleted;

  if v_original.id is null then
    raise exception 'Voucher % does not exist in this company', p_original_voucher_id;
  end if;
  if v_original.txn_currency is null or trim(v_original.txn_currency) = 'INR' then
    raise exception 'That voucher is an INR voucher — there is no foreign-currency exposure to settle';
  end if;
  if v_original.fc_settled_at is not null then
    raise exception 'That voucher is already settled';
  end if;
  if p_settlement_date < v_original.voucher_date then
    raise exception 'Settlement date cannot be before the original voucher''s own date (%)', v_original.voucher_date;
  end if;

  select e.ledger_id, e.fc_amount, e.debit_amount, e.credit_amount
    into v_fc_leg
    from public.voucher_entries e
   where e.voucher_id = p_original_voucher_id and e.fc_amount is not null;

  if v_fc_leg.ledger_id is null then
    raise exception 'This voucher has no line carrying a foreign-currency amount — nothing to settle';
  end if;
  if exists (
    select 1 from public.voucher_entries
     where voucher_id = p_original_voucher_id and fc_amount is not null
       and ledger_id <> v_fc_leg.ledger_id
  ) then
    raise exception 'This voucher has more than one foreign-currency line — automatic settlement only supports a single FC leg per voucher';
  end if;

  v_carrying_rate := coalesce(v_original.fc_last_revalued_rate, v_original.exchange_rate);

  -- 1590: never revalued -> the exact posted amount, no rounding. Revalued
  -- at least once -> 0071's own recompute, unchanged.
  if v_original.fc_last_revalued_rate is null then
    v_carrying_inr := coalesce(nullif(v_fc_leg.debit_amount, 0), v_fc_leg.credit_amount);
  else
    v_carrying_inr := round(v_fc_leg.fc_amount * v_carrying_rate, 2);
  end if;
  v_settlement_inr := round(v_fc_leg.fc_amount * p_settlement_rate, 2);

  v_gain_loss_ledger := public.ensure_exchange_gain_loss_ledger(p_company_id);

  v_voucher_type := case when v_fc_leg.debit_amount > 0 then 'receipt' else 'payment' end;

  select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
    from app_private.next_voucher_number(p_company_id, p_branch_id, v_voucher_type, p_settlement_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, party_ledger_id,
    txn_currency, exchange_rate, rate_source, created_by)
  values (
    p_company_id, p_branch_id, v_voucher_type, v_display_number, v_seq,
    v_fy, p_settlement_date,
    coalesce(p_narration, 'Forex settlement for voucher ' || (select voucher_number from public.vouchers where id = p_original_voucher_id)),
    v_fc_leg.ledger_id, trim(v_original.txn_currency), p_settlement_rate, coalesce(p_rate_source, 'manual'), auth.uid())
  returning id into v_new_voucher_id;

  if v_fc_leg.debit_amount > 0 then
    v_gain_loss := v_settlement_inr - v_carrying_inr;

    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_new_voucher_id, p_company_id, p_branch_id, p_settlement_ledger_id, v_settlement_inr, 0, v_line);
    v_line := v_line + 1;

    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_new_voucher_id, p_company_id, p_branch_id, v_fc_leg.ledger_id, 0, v_carrying_inr, v_line);
    v_line := v_line + 1;

    if v_gain_loss <> 0 then
      insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
      values (
        v_new_voucher_id, p_company_id, p_branch_id, v_gain_loss_ledger,
        case when v_gain_loss < 0 then abs(v_gain_loss) else 0 end,
        case when v_gain_loss > 0 then v_gain_loss else 0 end,
        v_line);
    end if;
  else
    v_gain_loss := v_carrying_inr - v_settlement_inr;

    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_new_voucher_id, p_company_id, p_branch_id, v_fc_leg.ledger_id, v_carrying_inr, 0, v_line);
    v_line := v_line + 1;

    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_new_voucher_id, p_company_id, p_branch_id, p_settlement_ledger_id, 0, v_settlement_inr, v_line);
    v_line := v_line + 1;

    if v_gain_loss <> 0 then
      insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
      values (
        v_new_voucher_id, p_company_id, p_branch_id, v_gain_loss_ledger,
        case when v_gain_loss < 0 then abs(v_gain_loss) else 0 end,
        case when v_gain_loss > 0 then v_gain_loss else 0 end,
        v_line);
    end if;
  end if;

  update public.vouchers
     set fc_settled_at = now(), fc_settlement_voucher_id = v_new_voucher_id
   where id = p_original_voucher_id;

  return v_new_voucher_id;
end;
$$;

revoke all on function public.record_forex_settlement(uuid, uuid, uuid, date, numeric, uuid, text, text) from public, anon;
grant execute on function public.record_forex_settlement(uuid, uuid, uuid, date, numeric, uuid, text, text) to authenticated;

comment on function public.record_forex_settlement(uuid, uuid, uuid, date, numeric, uuid, text, text) is
  'Full settlement of one open foreign-currency voucher. Closes the party ledger at its CURRENT CARRYING value — the exact amount originally posted when never revalued (1590: avoids a real rounding residue fc_amount x rate can introduce), or fc_amount x the last revaluation''s rate when it has been (0071) — rather than the stale amount originally posted before any revaluation. Posts the realized gain/loss (AS 11 / Ind AS 21 formula) to Exchange Gain/Loss when nonzero. Marks the original voucher fc_settled_at/fc_settlement_voucher_id so it drops out of get_open_fc_vouchers.';
