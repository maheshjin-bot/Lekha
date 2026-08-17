-- ============================================================================
-- 0017 — Party outstanding with ageing
-- ============================================================================
-- FIFO ageing: receipts are applied to the oldest invoices first, then what
-- survives is bucketed by age. This is NOT bill-wise allocation — a receipt
-- pointing at the specific invoices it settles, which real accounting
-- eventually needs. When that arrives, this function becomes the fallback for
-- parties that have not been explicitly allocated rather than being replaced.
--
-- Saying which it is matters: a lender reading a drawing-power calculation is
-- entitled to know whether "over 90 days" is allocated or inferred, and the
-- report screen repeats this in its own words for the same reason.
-- ============================================================================

create or replace function public.get_party_outstanding(
  p_company_id uuid,
  p_as_at date default current_date,
  -- 'debtor' for receivables, 'creditor' for payables.
  p_role text default 'debtor'
) returns table (
  ledger_id uuid,
  ledger_name text,
  outstanding numeric,
  not_due numeric,
  days_0_30 numeric,
  days_31_60 numeric,
  days_61_90 numeric,
  days_over_90 numeric,
  oldest_date date
)
language sql
stable
security invoker
set search_path = ''
as $$
  with party as (
    select l.id, l.name, l.credit_days
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id and g.ledger_role = p_role
  ),
  -- Signed movement: for a debtor a debit increases what they owe; for a
  -- creditor it is the other way round.
  moves as (
    select e.ledger_id, v.voucher_date,
           case when p_role = 'debtor'
                then e.debit_amount - e.credit_amount
                else e.credit_amount - e.debit_amount end as delta
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id
      join party p on p.id = e.ledger_id
     where e.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
  ),
  -- Opening balance counts as the oldest possible document.
  opening as (
    select l.id as ledger_id,
           case when p_role = 'debtor'
                then case when l.opening_balance_type = 'debit'
                          then l.opening_balance_amount else -l.opening_balance_amount end
                else case when l.opening_balance_type = 'credit'
                          then l.opening_balance_amount else -l.opening_balance_amount end
           end as amount
      from public.ledgers l join party p on p.id = l.id
  ),
  -- Everything that increased the balance, oldest first, plus the total that
  -- reduced it. Receipts are then eaten off the top of that list.
  charges as (
    select ledger_id, voucher_date, delta from moves where delta > 0
    union all
    select ledger_id, '1900-01-01'::date, amount from opening where amount > 0
  ),
  payments as (
    select ledger_id, sum(-delta) as paid from moves where delta < 0 group by ledger_id
  ),
  ranked as (
    select c.ledger_id, c.voucher_date, c.delta,
           sum(c.delta) over (partition by c.ledger_id order by c.voucher_date,
                              c.delta rows between unbounded preceding and current row) as running
      from charges c
  ),
  -- What remains of each charge after the running total of payments has been
  -- applied to everything older than it.
  aged as (
    select r.ledger_id, r.voucher_date,
           greatest(0, least(r.delta, r.running - coalesce(p.paid, 0))) as remaining
      from ranked r
      left join payments p on p.ledger_id = r.ledger_id
  ),
  bucketed as (
    select a.ledger_id,
           sum(a.remaining) as outstanding,
           sum(a.remaining) filter (where p_as_at - a.voucher_date < 0)               as not_due,
           sum(a.remaining) filter (where p_as_at - a.voucher_date between 0 and 30)  as b0,
           sum(a.remaining) filter (where p_as_at - a.voucher_date between 31 and 60) as b1,
           sum(a.remaining) filter (where p_as_at - a.voucher_date between 61 and 90) as b2,
           sum(a.remaining) filter (where p_as_at - a.voucher_date > 90)              as b3,
           min(a.voucher_date) filter (where a.remaining > 0)                         as oldest
      from aged a
     where a.remaining > 0
     group by a.ledger_id
  )
  select p.id, p.name,
         coalesce(b.outstanding, 0),
         coalesce(b.not_due, 0), coalesce(b.b0, 0), coalesce(b.b1, 0),
         coalesce(b.b2, 0), coalesce(b.b3, 0),
         b.oldest
    from party p
    left join bucketed b on b.ledger_id = p.id
   where coalesce(b.outstanding, 0) <> 0
   order by coalesce(b.b3, 0) desc, coalesce(b.outstanding, 0) desc;
$$;

comment on function public.get_party_outstanding is
  'FIFO ageing: receipts applied oldest-first. Inferred, not bill-wise allocated — a lender reading a drawing power calculation is entitled to know which.';
