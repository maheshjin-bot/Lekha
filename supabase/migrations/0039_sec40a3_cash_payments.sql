-- ============================================================================
-- 0039 — Sec 40A(3): candidate cash-payment disallowances over the limit
-- ============================================================================
-- Sec 40A(3), researched fresh: any REVENUE expenditure paid in cash, to one
-- person, in a sum exceeding Rs 10,000 in a single day, otherwise than by an
-- account payee cheque/draft/prescribed electronic mode, is disallowed in
-- full — not just the excess over Rs 10,000. Rs 35,000 for payments to a
-- transporter for plying/hiring/leasing a GOODS carriage specifically (not
-- passenger transport). Multiple cash payments to the SAME person on the
-- SAME day are aggregated for the test, even across separate vouchers — one
-- Rs 6,000 payment and a second Rs 6,000 payment to the same supplier on
-- the same day breaches the limit in aggregate, even though neither
-- voucher does alone.
--
-- CANDIDATES, NOT A DISALLOWANCE — the single most important framing here.
-- Rule 6DD carves out real exceptions this schema has no way to evaluate:
-- payment to government bodies, payment where no banking facility exists
-- within the area, payment to a cultivator/grower/producer for agricultural
-- or forest produce, payment on a bank holiday, payment by book adjustment,
-- terminal/retirement dues to an employee, and several more. LEKHA cannot
-- know which of these applies to a given payee — it can only surface every
-- payment that CROSSES the statutory limit, for a human to then apply
-- Rule 6DD judgement to. Flagging conservatively (every crossing, not just
-- ones LEKHA is confident about) is the safer failure mode: a false
-- positive costs the reviewer one dismissal, a false negative costs a real
-- disallowance nobody caught. The uniform Rs 10,000 threshold is applied to
-- every payee, including transporters — LEKHA has no way to identify which
-- payees ARE transporters for the Rs 35,000 exception, so a transporter
-- paid Rs 15,000 in cash will show here as a candidate even though it is
-- actually within the transporter's own higher limit. Documented, not
-- silently wrong.
--
-- SCOPE: revenue expenditure only — Sec 40A(3)'s own text is about
-- expenditure claimed as a deduction, so this looks at cash paid against
-- either a direct/indirect EXPENSE ledger (a same-voucher cash expense,
-- purchases included — "Purchases" already sits under Direct Expenses in
-- this schema's own seeded chart) or a CREDITOR ledger (settling a bill in
-- cash, where the bill itself was the expense). Capital expenditure (fixed
-- assets, loan principal, investments) is excluded by construction — it
-- was never claimed as a deduction, so 40A(3) does not reach it directly.
-- Sec 40A(3A) — cash payment in a LATER year for an expense already claimed
-- in an earlier one, which becomes taxable as income in the payment year —
-- is a distinct, narrower, timing-specific provision and is not covered
-- here.
--
-- CASH IDENTIFIED BY THE SEEDED "Cash-in-Hand" GROUP NAME, same limitation
-- as get_tax_audit_applicability (0032) — a company that has renamed that
-- group will not have its cash payments picked up here.
-- ============================================================================

create or replace function public.get_sec40a3_cash_payments(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  payee_ledger_id uuid,
  payee_name text,
  payment_date date,
  cash_amount numeric,
  payment_count integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with cash_lines as (
    -- Every voucher with a Cash-in-Hand credit (cash paid out) in the period.
    select e.voucher_id, v.voucher_date
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
      join public.ledgers cl on cl.id = e.ledger_id
      join public.account_groups cg on cg.id = cl.group_id
     where e.company_id = p_company_id
       and cg.name = 'Cash-in-Hand'
       and e.credit_amount > 0
       and v.voucher_date between p_fy_start and p_fy_end
  ),
  payee_lines as (
    -- The debited ledger(s) on those same vouchers, where the debit is
    -- either a same-voucher cash expense (direct/indirect expense nature)
    -- or a creditor being settled in cash (the bill itself was the expense).
    select e.ledger_id, l.name as ledger_name, cl.voucher_date, e.debit_amount
      from cash_lines cl
      join public.voucher_entries e on e.voucher_id = cl.voucher_id and e.company_id = p_company_id
      join public.ledgers l on l.id = e.ledger_id
      join public.account_groups g on g.id = l.group_id
     where e.debit_amount > 0
       and (g.nature in ('direct_expense', 'indirect_expense') or g.ledger_role = 'creditor')
  )
  select ledger_id, ledger_name, voucher_date,
         sum(debit_amount) as cash_amount,
         count(*)::int as payment_count
    from payee_lines
   group by ledger_id, ledger_name, voucher_date
  having sum(debit_amount) > 10000
   order by voucher_date, sum(debit_amount) desc;
$$;

comment on function public.get_sec40a3_cash_payments is
  'Sec 40A(3) candidate disallowances: cash paid (identified via the seeded "Cash-in-Hand" group) to one payee ledger on one day, aggregated across vouchers, where it exceeds Rs 10,000. Candidates for manual Rule 6DD review, not a computed disallowance figure — LEKHA cannot evaluate Rule 6DD exceptions (government payee, no banking facility, agricultural produce, etc.) or the Rs 35,000 transporter-specific limit. See the migration header for the full scope, including why capital expenditure and Sec 40A(3A) are excluded.';
