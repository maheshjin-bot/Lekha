-- EXIM / foreign-currency periodic revaluation — the AS 11 half migration
-- 0068 deliberately left out. 0068's own header comment named this
-- explicitly: "a separate (not asked-about) unrealized-revaluation variant
-- that applies to monetary items still open at a reporting date."
--
-- THE DIFFERENCE FROM SETTLEMENT (0068): settlement closes a voucher out
-- permanently once real money moves. Revaluation does the opposite — the
-- voucher stays OPEN (still unsettled, still appears in
-- get_open_fc_vouchers), but its CARRYING VALUE in the books is restated
-- to whatever the closing rate says it's worth today, with the difference
-- recognized as an unrealized gain/loss. No cash moves. Do this enough
-- times before eventual settlement and each revaluation's gain/loss must
-- be measured from the LAST revaluation, not the original transaction
-- date, or the same movement gets recognized twice.
--
-- IMPLEMENTATION: rather than editing the original voucher_entries row
-- (this app's own stated principle: "immutable posted vouchers;
-- corrections post as reversals, never edits"), a revaluation posts a new
-- journal voucher — Dr/Cr the party ledger for exactly the delta between
-- the old and new carrying value, and the offsetting amount to Exchange
-- Gain/Loss. The party ledger's own real balance (summed across every
-- voucher_entries row that has ever touched it) then naturally reflects
-- the fully-revalued figure through nothing but ordinary additive
-- postings — the same discipline every other feature this session used.
--
-- A real bug caught live while testing this against real data, not by
-- reading the code: vouchers has a CHECK constraint
-- (vouchers_fc_needs_rate_source) requiring rate_source to be non-null
-- whenever txn_currency <> 'INR' — both this migration's own
-- p_rate_source parameter AND 0068's record_forex_settlement declared it
-- optional with a `default null`, which is a guaranteed constraint
-- violation the moment a caller actually omits it, since every voucher
-- either function ever inserts is by definition non-INR. Fixed in both
-- by coalescing to 'manual' (a real allowed value alongside rbi/bank/
-- cbic) rather than passing the null straight through.
--
-- Two new nullable tracking columns record "the rate this voucher was
-- last revalued to" — coalesce(fc_last_revalued_rate, exchange_rate) is
-- the carrying rate everything else in this migration reads. Because that
-- carrying value now lives partly off-row (spread across however many
-- revaluation vouchers have been posted), record_forex_settlement (0068)
-- has to change alongside this: it previously read the ORIGINAL voucher's
-- own posted debit/credit amount directly to know what to close the
-- ledger for, which is now stale the moment a revaluation has happened —
-- fixed here to recompute fc_amount x carrying rate instead, which is
-- what the real ledger balance actually equals if every revaluation was
-- posted correctly, verified live before trusting it (see the commit
-- message for the worked numbers).

alter table public.vouchers
  add column fc_last_revalued_rate numeric,
  add column fc_last_revalued_at date,
  add column fc_revalues_voucher_id uuid references public.vouchers(id) on delete set null;

comment on column public.vouchers.fc_last_revalued_rate is
  'The exchange rate this FC voucher was last revalued to (record_forex_revaluation). Null = never revalued; the carrying rate is then just exchange_rate, the original transaction rate.';
comment on column public.vouchers.fc_last_revalued_at is
  'The reporting date of the last revaluation. Set together with fc_last_revalued_rate.';
comment on column public.vouchers.fc_revalues_voucher_id is
  'Set only on a revaluation voucher itself (never on the original) — points back to the FC voucher it revalued. A real FK rather than inferring the link from narration text, which p_narration lets a caller override.';

-- ---------------------------------------------------------------------------
-- record_forex_revaluation — restates one open FC voucher's carrying value
-- to a new closing rate, recognizing the delta as unrealized gain/loss.
-- ---------------------------------------------------------------------------
create or replace function public.record_forex_revaluation(
  p_company_id uuid,
  p_branch_id uuid,
  p_original_voucher_id uuid,
  p_as_at date,
  p_closing_rate numeric,
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
  v_baseline_rate numeric;
  v_old_carrying numeric;
  v_new_carrying numeric;
  v_delta numeric;
  v_gain_loss numeric;
  v_gain_loss_ledger uuid;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_new_voucher_id uuid;
  v_line int := 0;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to record a revaluation for this company';
  end if;
  if not (p_closing_rate > 0) then
    raise exception 'Closing rate must be greater than zero';
  end if;

  select id, voucher_date, txn_currency, exchange_rate, fc_settled_at,
         fc_last_revalued_rate, fc_last_revalued_at
    into v_original
    from public.vouchers
   where id = p_original_voucher_id and company_id = p_company_id and not is_deleted;

  if v_original.id is null then
    raise exception 'Voucher % does not exist in this company', p_original_voucher_id;
  end if;
  if v_original.txn_currency is null or trim(v_original.txn_currency) = 'INR' then
    raise exception 'That voucher is an INR voucher — there is no foreign-currency exposure to revalue';
  end if;
  if v_original.fc_settled_at is not null then
    raise exception 'That voucher is already settled — nothing left to revalue';
  end if;
  if p_as_at < v_original.voucher_date then
    raise exception 'Revaluation date cannot be before the original voucher''s own date (%)', v_original.voucher_date;
  end if;
  if v_original.fc_last_revalued_at is not null and p_as_at < v_original.fc_last_revalued_at then
    raise exception 'Revaluation date cannot be before the last revaluation (%) — revaluations must move forward in time',
      v_original.fc_last_revalued_at;
  end if;

  select e.ledger_id, e.fc_amount, e.debit_amount, e.credit_amount
    into v_fc_leg
    from public.voucher_entries e
   where e.voucher_id = p_original_voucher_id and e.fc_amount is not null;

  if v_fc_leg.ledger_id is null then
    raise exception 'This voucher has no line carrying a foreign-currency amount — nothing to revalue';
  end if;
  if exists (
    select 1 from public.voucher_entries
     where voucher_id = p_original_voucher_id and fc_amount is not null
       and ledger_id <> v_fc_leg.ledger_id
  ) then
    raise exception 'This voucher has more than one foreign-currency line — automatic revaluation only supports a single FC leg per voucher';
  end if;

  v_baseline_rate := coalesce(v_original.fc_last_revalued_rate, v_original.exchange_rate);
  v_old_carrying := round(v_fc_leg.fc_amount * v_baseline_rate, 2);
  v_new_carrying := round(v_fc_leg.fc_amount * p_closing_rate, 2);
  v_delta := v_new_carrying - v_old_carrying;

  if v_delta = 0 then
    raise exception 'The carrying value is already % at this rate — nothing to revalue', v_old_carrying;
  end if;

  v_gain_loss_ledger := public.ensure_exchange_gain_loss_ledger(p_company_id);

  select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
    from app_private.next_voucher_number(p_company_id, p_branch_id, 'journal', p_as_at);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, party_ledger_id,
    txn_currency, exchange_rate, rate_source, fc_revalues_voucher_id, created_by)
  values (
    p_company_id, p_branch_id, 'journal', v_display_number, v_seq,
    v_fy, p_as_at,
    coalesce(p_narration, 'Forex revaluation for voucher ' || (select voucher_number from public.vouchers where id = p_original_voucher_id)),
    v_fc_leg.ledger_id, trim(v_original.txn_currency), p_closing_rate, coalesce(p_rate_source, 'manual'),
    p_original_voucher_id, auth.uid())
  returning id into v_new_voucher_id;

  if v_fc_leg.debit_amount > 0 then
    -- Receivable: carrying value rising is a gain (Dr party ledger the
    -- delta, credit-natured Exchange Gain/Loss); falling is a loss (Cr
    -- party ledger, debit Exchange Gain/Loss). gain_loss's sign matches
    -- the delta directly for a receivable — see 0068's header for why
    -- this flips for a payable below.
    v_gain_loss := v_delta;

    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (
      v_new_voucher_id, p_company_id, p_branch_id, v_fc_leg.ledger_id,
      case when v_delta > 0 then v_delta else 0 end,
      case when v_delta < 0 then abs(v_delta) else 0 end,
      v_line);
    v_line := v_line + 1;
  else
    -- Payable: carrying value rising means we now owe MORE — a loss (Cr
    -- party ledger the delta, debit Exchange Gain/Loss); falling is a
    -- gain. Mirror image of the receivable case, same as 0068's
    -- settlement sign convention.
    v_gain_loss := -v_delta;

    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (
      v_new_voucher_id, p_company_id, p_branch_id, v_fc_leg.ledger_id,
      case when v_delta < 0 then abs(v_delta) else 0 end,
      case when v_delta > 0 then v_delta else 0 end,
      v_line);
    v_line := v_line + 1;
  end if;

  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (
    v_new_voucher_id, p_company_id, p_branch_id, v_gain_loss_ledger,
    case when v_gain_loss < 0 then abs(v_gain_loss) else 0 end,
    case when v_gain_loss > 0 then v_gain_loss else 0 end,
    v_line);

  update public.vouchers
     set fc_last_revalued_rate = p_closing_rate, fc_last_revalued_at = p_as_at
   where id = p_original_voucher_id;

  return v_new_voucher_id;
end;
$$;

revoke all on function public.record_forex_revaluation(uuid, uuid, uuid, date, numeric, text, text) from public, anon;
grant execute on function public.record_forex_revaluation(uuid, uuid, uuid, date, numeric, text, text) to authenticated;

comment on function public.record_forex_revaluation(uuid, uuid, uuid, date, numeric, text, text) is
  'Restates one open FC voucher''s carrying value to p_closing_rate as at p_as_at, posting the delta as unrealized gain/loss — the voucher stays open (fc_settled_at untouched), only fc_last_revalued_rate/at move forward. Cannot run before the voucher''s own date or before its own last revaluation date. Purely a journal entry — no cash moves, unlike record_forex_settlement.';

-- ---------------------------------------------------------------------------
-- get_open_fc_vouchers — now reports the CARRYING value (post-revaluation),
-- not the stale original posted amount, plus the last-revalued date.
-- ---------------------------------------------------------------------------
drop function if exists public.get_open_fc_vouchers(uuid);
create function public.get_open_fc_vouchers(p_company_id uuid)
returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  voucher_type text,
  txn_currency text,
  exchange_rate numeric,
  carrying_rate numeric,
  last_revalued_at date,
  party_ledger_id uuid,
  party_ledger_name text,
  fc_amount numeric,
  inr_amount numeric,
  direction text
)
language sql
stable
set search_path to ''
as $$
  select
    v.id, v.voucher_number, v.voucher_date, v.voucher_type,
    trim(v.txn_currency), v.exchange_rate,
    coalesce(v.fc_last_revalued_rate, v.exchange_rate),
    v.fc_last_revalued_at,
    e.ledger_id, l.name,
    e.fc_amount,
    round(e.fc_amount * coalesce(v.fc_last_revalued_rate, v.exchange_rate), 2),
    case when e.debit_amount > 0 then 'debit' else 'credit' end
  from public.vouchers v
  join public.voucher_entries e on e.voucher_id = v.id and e.fc_amount is not null
  join public.ledgers l on l.id = e.ledger_id
  where v.company_id = p_company_id
    and not v.is_deleted
    and v.txn_currency is not null
    and trim(v.txn_currency) <> 'INR'
    and v.fc_settled_at is null
  order by v.voucher_date, v.voucher_number;
$$;

revoke all on function public.get_open_fc_vouchers(uuid) from public, anon;
grant execute on function public.get_open_fc_vouchers(uuid) to authenticated;

comment on function public.get_open_fc_vouchers(uuid) is
  'Picklist for both settlement and revaluation: non-INR, not-yet-settled vouchers with exactly the fc_amount-carrying leg. inr_amount is the CURRENT CARRYING value (fc_amount x carrying_rate, i.e. the last revaluation''s rate if one exists, else the original transaction rate) — not the stale amount originally posted, which drifts the moment a revaluation happens. carrying_rate and last_revalued_at are exposed so the UI can show what the figure is actually based on.';

-- ---------------------------------------------------------------------------
-- record_forex_settlement — updated to close at the CARRYING value, not
-- the stale original posted amount, so a voucher revalued one or more
-- times before eventual settlement doesn't double-count what revaluation
-- already recognized. Signature unchanged from 0068, no DROP needed.
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

  -- The ledger's real balance now equals fc_amount x carrying_rate, not
  -- the original row's own debit/credit — a prior revaluation (0071) adds
  -- the difference as a separate posting rather than editing this row.
  v_carrying_rate := coalesce(v_original.fc_last_revalued_rate, v_original.exchange_rate);
  v_carrying_inr := round(v_fc_leg.fc_amount * v_carrying_rate, 2);
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
  'Full settlement of one open foreign-currency voucher. Closes the party ledger at its CURRENT CARRYING value (fc_amount x the last revaluation''s rate, or the original transaction rate if never revalued — see 0071) rather than the stale amount originally posted, so a prior revaluation''s already-recognized gain/loss is never double-counted at settlement. Posts the realized gain/loss (AS 11 / Ind AS 21 formula) to Exchange Gain/Loss when nonzero. Marks the original voucher fc_settled_at/fc_settlement_voucher_id so it drops out of get_open_fc_vouchers.';
