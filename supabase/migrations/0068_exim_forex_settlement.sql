-- EXIM / foreign-currency settlement — realized forex gain/loss, v1.
-- Deliberately does NOT touch VoucherForm.tsx/InvoiceForm.tsx (locked by a
-- concurrent session), and does NOT touch create_voucher/create_invoice
-- either — both already accept txn_currency/exchange_rate/rate_source
-- (0007, 0011, and this session's own 0065 for create_invoice), so a
-- foreign-currency journal/receipt/payment voucher can already be created
-- today through the existing, unmodified create_voucher RPC. What was
-- actually missing, confirmed by research before writing a line of SQL: no
-- UI anywhere ever passes those parameters, so zero non-INR vouchers exist
-- in the live app, and there was no way to close one out and record the
-- realized gain or loss when it's actually settled at a different rate.
--
-- SCOPE, deliberately narrow: full settlement of one foreign-currency
-- voucher by one settlement voucher, in one shot. Partial settlement
-- (splitting an invoice's fc_amount across several receipts — realistic
-- for real exports: advance now, balance on shipment) is NOT attempted
-- here, because there is no bill-wise allocation engine to build it on —
-- get_party_outstanding (0017) explicitly documents itself as FIFO-
-- inferred ageing, "NOT bill-wise allocation," and names bill-wise
-- matching as a known future gap. Tracking full-settlement-only as two
-- plain nullable columns on vouchers rather than a new table keeps this
-- honestly scoped to what it actually does.
--
-- Formula (AS 11 / Ind AS 21, both agree, verified by research): realized
-- gain/loss = settlement-date-rate value minus transaction-date-rate value
-- of the same foreign-currency amount. Worked out and verified algebraically
-- for both directions before writing the INSERT below:
--   receivable (fc_amount booked as a DEBIT — e.g. Dr Debtors-USD on an
--   export): gain_loss = settlement_inr - original_inr_amount. A positive
--   gain_loss is credited to Exchange Gain/Loss (rate moved in our favour
--   as the holder of the receivable); negative is debited.
--   payable (fc_amount booked as a CREDIT — e.g. Cr Loan-USD on a foreign
--   borrowing): gain_loss = original_inr_amount - settlement_inr (rate
--   rising is now a LOSS, the sign flips vs. the receivable case). Same
--   credit-if-positive/debit-if-negative rule against Exchange Gain/Loss.
-- Both cases self-balance by construction — see the migration commit
-- message for the full four-way worked arithmetic that was checked before
-- this shipped.

alter table public.vouchers
  add column fc_settled_at timestamptz,
  add column fc_settlement_voucher_id uuid references public.vouchers(id) on delete set null;

comment on column public.vouchers.fc_settled_at is
  'When this foreign-currency voucher was fully settled by record_forex_settlement. Null = still open. v1 is full-settlement-only — there is no partial-settlement tracking (see migration 0068''s header comment for why).';
comment on column public.vouchers.fc_settlement_voucher_id is
  'The receipt/payment voucher that settled this one, if any. Set together with fc_settled_at, always by record_forex_settlement — never edited directly.';

-- ---------------------------------------------------------------------------
-- ensure_exchange_gain_loss_ledger — idempotent auto-provision, mirroring
-- app_private.seed_tcs_ledger (0027) and this session's own
-- ensure_cash_sales_ledger (0066) exactly. One bidirectional P&L ledger
-- under Indirect Incomes (verified live: seeded on all 15 companies) —
-- a gain credits it, a loss debits it, same convention as letting
-- "Discount Received" run a debit balance in a bad month. No dedicated
-- "Rounding Off"-style precedent existed elsewhere in the chart of
-- accounts to crib from (checked before deciding this).
-- ---------------------------------------------------------------------------
create or replace function public.ensure_exchange_gain_loss_ledger(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_group uuid;
  v_ledger uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to set up ledgers for this company';
  end if;

  select id into v_group
    from public.account_groups
   where company_id = p_company_id and name = 'Indirect Incomes'
   limit 1;

  if v_group is null then
    raise exception 'Chart of accounts is not set up for this company yet (no Indirect Incomes group)';
  end if;

  select id into v_ledger
    from public.ledgers
   where company_id = p_company_id and group_id = v_group and name = 'Exchange Gain/Loss'
   limit 1;

  if v_ledger is not null then
    return v_ledger;
  end if;

  insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
  values (p_company_id, v_group, 'Exchange Gain/Loss', 'credit', 0)
  returning id into v_ledger;

  return v_ledger;
end;
$$;

revoke all on function public.ensure_exchange_gain_loss_ledger(uuid) from public, anon;
grant execute on function public.ensure_exchange_gain_loss_ledger(uuid) to authenticated;

comment on function public.ensure_exchange_gain_loss_ledger(uuid) is
  'Idempotently returns the company''s "Exchange Gain/Loss" ledger under Indirect Incomes, creating it on first settlement. One bidirectional ledger, not two — a gain credits it, a loss debits it.';

-- ---------------------------------------------------------------------------
-- get_open_fc_vouchers — the settlement screen's picklist: every non-INR
-- voucher not yet settled, with the one foreign-currency-carrying leg's
-- ledger, amount and fc_amount.
-- ---------------------------------------------------------------------------
create or replace function public.get_open_fc_vouchers(p_company_id uuid)
returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  voucher_type text,
  txn_currency text,
  exchange_rate numeric,
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
    e.ledger_id, l.name,
    e.fc_amount,
    case when e.debit_amount > 0 then e.debit_amount else e.credit_amount end,
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
  'Picklist for the settlement screen: non-INR, not-yet-settled vouchers with exactly the fc_amount-carrying leg''s own ledger/amount. A voucher with zero or more than one fc_amount leg is invisible here by construction (the join requires exactly the shape record_forex_settlement can actually close) — see that function''s own guard for the explicit error a malformed voucher gets instead.';

-- ---------------------------------------------------------------------------
-- record_forex_settlement — closes one open FC voucher, posts the realized
-- gain/loss. See the migration header comment for the formula and the
-- worked four-way sign arithmetic.
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

  select id, voucher_date, txn_currency, fc_settled_at
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

  v_settlement_inr := round(v_fc_leg.fc_amount * p_settlement_rate, 2);

  v_gain_loss_ledger := public.ensure_exchange_gain_loss_ledger(p_company_id);

  -- A receivable (fc_amount booked debit) is settled by money coming in —
  -- a receipt; a payable (fc_amount booked credit) is settled by money
  -- going out — a payment.
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
    v_fc_leg.ledger_id, trim(v_original.txn_currency), p_settlement_rate, p_rate_source, auth.uid())
  returning id into v_new_voucher_id;

  if v_fc_leg.debit_amount > 0 then
    -- Receivable being settled: Dr settlement ledger (money coming in),
    -- Cr the original party ledger to close it, gain (if any) credited to
    -- Exchange Gain/Loss, loss (if any) debited.
    v_gain_loss := v_settlement_inr - v_fc_leg.debit_amount;

    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_new_voucher_id, p_company_id, p_branch_id, p_settlement_ledger_id, v_settlement_inr, 0, v_line);
    v_line := v_line + 1;

    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_new_voucher_id, p_company_id, p_branch_id, v_fc_leg.ledger_id, 0, v_fc_leg.debit_amount, v_line);
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
    -- Payable being settled: Dr the original party ledger to close it,
    -- Cr settlement ledger (money going out), gain/loss the mirror image
    -- of the receivable case above (see header comment for the algebra).
    v_gain_loss := v_fc_leg.credit_amount - v_settlement_inr;

    insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (v_new_voucher_id, p_company_id, p_branch_id, v_fc_leg.ledger_id, v_fc_leg.credit_amount, 0, v_line);
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
  'Full settlement (v1 has no partial settlement — see migration header) of one open foreign-currency voucher. Posts a new receipt/payment voucher: settlement ledger, the original party ledger closed for exactly its original INR amount, and the realized gain/loss (AS 11 / Ind AS 21 formula) to Exchange Gain/Loss when nonzero. Marks the original voucher fc_settled_at/fc_settlement_voucher_id so it drops out of get_open_fc_vouchers.';
