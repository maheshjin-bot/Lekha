-- ============================================================================
-- 0041 — Form 3CD Clause 31: Sec 269SS/269T cash loan/deposit candidates
-- ============================================================================
-- Researched fresh. Sec 269SS: a person cannot ACCEPT a loan, deposit, or
-- "specified sum" (an advance related to a transfer of immovable property)
-- otherwise than by account-payee cheque/draft/ECS/prescribed electronic
-- mode, if the amount of that loan/deposit TOGETHER WITH the aggregate
-- amount already remaining unpaid from the same lender is Rs 20,000 or
-- more. Sec 269T is the mirror image for REPAYMENT: cannot repay in cash
-- if the amount being repaid, or the aggregate held from that lender as of
-- the repayment date (either together with interest), is Rs 20,000 or
-- more. Both provisions test an AGGREGATE outstanding balance, not just
-- the single transaction in front of you — a Rs 5,000 cash top-up on an
-- existing Rs 18,000 balance breaches Sec 269SS even though Rs 5,000 alone
-- is under the limit. Form 3CD Clause 31 asks the auditor to particularise
-- every such acceptance/repayment.
--
-- CANDIDATES, NOT A COMPUTED VIOLATION — same framing as Sec 40A(3) (0039).
-- "Specified sum" (property-transfer advances) is not covered: nothing in
-- this schema distinguishes a property-advance ledger from any other
-- deposit-received ledger. Interest payable is not added to the repayment
-- test — this schema does not require loan interest to be booked on the
-- same ledger as principal, so a same-ledger interest+principal aggregate
-- would double-count or miss postings depending on how the user has set
-- their books up; only principal movement on the flagged ledger is tested.
--
-- WHICH LEDGERS ARE "A LOAN OR DEPOSIT ACCEPTED BY THE ASSESSEE" IS NOT
-- STRUCTURALLY DETECTABLE. The seeded ledger_role='loan' group ("Loans &
-- Advances") is the ASSET side — loans the company has GIVEN, the opposite
-- of what 269SS/269T cares about — and liability-side borrowing groups
-- (Long-term Borrowings, Secured/Unsecured Loans) only exist in the
-- Schedule III inner structure (0037), which is opc/pvt_ltd/ltd only, and
-- even there a company may book a director's personal loan through an
-- ordinary creditor ledger instead. So this is a manual flag, same
-- resolution as is_partner_remuneration (0029), msme_category, and
-- is_related_party (0040): the user marks the specific ledger representing
-- one lender/depositor relationship. One ledger per lender is assumed —
-- the same assumption this schema already makes for Sundry Debtors/
-- Creditors — so a flagged ledger's own running balance IS "the aggregate
-- amount remaining unpaid from that person."
--
-- CASH IDENTIFIED BY THE SEEDED "Cash-in-Hand" GROUP NAME, same limitation
-- as get_sec40a3_cash_payments (0039) and get_tax_audit_applicability
-- (0032) — a renamed group won't be picked up. Bank-mode movements are
-- treated as compliant throughout, since this schema has no way to tell
-- an account-payee instrument from a bearer one.
--
-- RUNNING BALANCE includes the ledger's own opening_balance_amount as a
-- pseudo-movement dated before any real voucher, so a loan that pre-dates
-- this company's book start in LEKHA still has its brought-forward balance
-- counted toward the aggregate test — otherwise a company migrating in
-- mid-loan would silently under-count.
-- ============================================================================

alter table public.ledgers
  add column is_loan_or_deposit boolean not null default false;

comment on column public.ledgers.is_loan_or_deposit is
  'Marks this ledger as recording a loan or deposit accepted from one specific lender/depositor, for Form 3CD Clause 31 (Sec 269SS/269T). LEKHA cannot determine this structurally — the seeded ledger_role=''loan'' group is loans GIVEN by the company, the opposite side. The user states it, same as ledgers.is_partner_remuneration (0029) and is_related_party (0040). Assumes one ledger per lender, so the ledger''s own running balance is the aggregate outstanding from that person.';

create or replace function public.get_sec269ss_loan_receipts(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  ledger_id uuid,
  ledger_name text,
  voucher_id uuid,
  receipt_date date,
  amount_received numeric,
  balance_after numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with loan_movements as (
    select
      l.id as ledger_id,
      l.name as ledger_name,
      null::uuid as voucher_id,
      date '1900-01-01' as move_date,
      timestamptz '1900-01-01' as move_at,
      case when l.opening_balance_type = 'credit' then l.opening_balance_amount else 0 end as credit_amount,
      case when l.opening_balance_type = 'debit' then l.opening_balance_amount else 0 end as debit_amount,
      false as cash_funded
      from public.ledgers l
     where l.company_id = p_company_id
       and l.is_loan_or_deposit
       and l.opening_balance_amount > 0
    union all
    select
      e.ledger_id,
      l.name,
      e.voucher_id,
      v.voucher_date,
      v.created_at,
      e.credit_amount,
      e.debit_amount,
      exists (
        select 1
          from public.voucher_entries ce
          join public.ledgers cl on cl.id = ce.ledger_id
          join public.account_groups cg on cg.id = cl.group_id
         where ce.voucher_id = e.voucher_id
           and cg.name = 'Cash-in-Hand'
           and ce.debit_amount > 0
      ) as cash_funded
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
      join public.ledgers l on l.id = e.ledger_id
     where e.company_id = p_company_id
       and l.is_loan_or_deposit
  ),
  running as (
    select *,
      sum(credit_amount - debit_amount) over (
        partition by ledger_id order by move_date, move_at, ledger_id
        rows between unbounded preceding and current row
      ) as balance_after
      from loan_movements
  )
  select ledger_id, ledger_name, voucher_id, move_date, credit_amount, balance_after
    from running
   where credit_amount > 0
     and cash_funded
     and balance_after >= 20000
     and move_date between p_fy_start and p_fy_end
   order by move_date, ledger_name;
$$;

comment on function public.get_sec269ss_loan_receipts is
  'Form 3CD Clause 31 / Sec 269SS candidates: cash accepted (via the seeded "Cash-in-Hand" group) on a ledger flagged is_loan_or_deposit, where the ledger''s running balance — including its opening balance, so pre-existing loans count — is Rs 20,000 or more immediately after the receipt. Candidates for manual review, not a computed penalty; "specified sum" advances are not covered. See the migration header for full scope.';

create or replace function public.get_sec269t_loan_repayments(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  ledger_id uuid,
  ledger_name text,
  voucher_id uuid,
  repayment_date date,
  amount_repaid numeric,
  balance_before numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with loan_movements as (
    select
      l.id as ledger_id,
      l.name as ledger_name,
      null::uuid as voucher_id,
      date '1900-01-01' as move_date,
      timestamptz '1900-01-01' as move_at,
      case when l.opening_balance_type = 'credit' then l.opening_balance_amount else 0 end as credit_amount,
      case when l.opening_balance_type = 'debit' then l.opening_balance_amount else 0 end as debit_amount,
      false as cash_funded
      from public.ledgers l
     where l.company_id = p_company_id
       and l.is_loan_or_deposit
       and l.opening_balance_amount > 0
    union all
    select
      e.ledger_id,
      l.name,
      e.voucher_id,
      v.voucher_date,
      v.created_at,
      e.credit_amount,
      e.debit_amount,
      exists (
        select 1
          from public.voucher_entries ce
          join public.ledgers cl on cl.id = ce.ledger_id
          join public.account_groups cg on cg.id = cl.group_id
         where ce.voucher_id = e.voucher_id
           and cg.name = 'Cash-in-Hand'
           and ce.credit_amount > 0
      ) as cash_funded
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
      join public.ledgers l on l.id = e.ledger_id
     where e.company_id = p_company_id
       and l.is_loan_or_deposit
  ),
  running as (
    select *,
      coalesce(sum(credit_amount - debit_amount) over (
        partition by ledger_id order by move_date, move_at, ledger_id
        rows between unbounded preceding and 1 preceding
      ), 0) as balance_before
      from loan_movements
  )
  select ledger_id, ledger_name, voucher_id, move_date, debit_amount, balance_before
    from running
   where debit_amount > 0
     and cash_funded
     and balance_before >= 20000
     and move_date between p_fy_start and p_fy_end
   order by move_date, ledger_name;
$$;

comment on function public.get_sec269t_loan_repayments is
  'Form 3CD Clause 31 / Sec 269T candidates: cash repaid (via the seeded "Cash-in-Hand" group) on a ledger flagged is_loan_or_deposit, where the ledger''s running balance — including its opening balance — was already Rs 20,000 or more immediately before the repayment. Candidates for manual review, not a computed penalty. See the migration header for full scope.';
