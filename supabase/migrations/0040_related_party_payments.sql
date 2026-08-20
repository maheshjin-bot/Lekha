-- ============================================================================
-- 0040 — Form 3CD Clause 23: payments to Sec 40A(2)(b) specified persons
-- ============================================================================
-- Researched fresh: Clause 23 wants actual PAYMENTS made during the year to
-- persons specified under Sec 40A(2)(b) — directors (for a company),
-- partners (for a firm/LLP), their relatives, and any individual/firm/
-- company/AOP in which the assessee or a director/partner has a
-- substantial interest — name, PAN, and the amount actually paid. Two
-- things the clause is explicit about, both load-bearing for this design:
-- actual payments ONLY, not amounts merely debited/claimed in the P&L and
-- not outstanding balances; and the tax auditor is not asked to opine on
-- whether the payment is excessive or unreasonable — that is the assessing
-- officer's call, not something to compute or flag here.
--
-- WHO IS A "SPECIFIED PERSON" IS NOT AUTO-DETECTABLE. LEKHA tracks no
-- shareholding, directorship, partnership share, or relative relationship
-- data — determining Sec 40A(2)(b) status is a legal judgement about the
-- assessee's own ownership and management structure, not something that
-- falls out of ledger postings. Same resolution as Sec 40(b) partner
-- remuneration (0029, ledgers.is_partner_remuneration) and MSME status
-- (ledgers.msme_category): a manual flag the user sets on the specific
-- ledger representing that person, not an inference.
--
-- "ACTUAL PAYMENT", COMPUTED: a flagged ledger's own debit movement (money
-- effectively flowing to them, whether settling a payable balance or a
-- same-voucher cash/bank expense) on a voucher that ALSO touches a
-- cash_bank-role ledger. A pure journal entry between two non-cash ledgers
-- (e.g., accruing remuneration payable without paying it) does not count —
-- correctly, since the clause explicitly excludes book entries and
-- outstanding amounts, only what actually left the bank or cash-in-hand.
-- ============================================================================

alter table public.ledgers
  add column is_related_party boolean not null default false;

comment on column public.ledgers.is_related_party is
  'Marks this ledger as a Sec 40A(2)(b) "specified person" (director, partner, their relative, or an entity in which the assessee/director/partner has a substantial interest) for Form 3CD Clause 23. LEKHA cannot determine this from ledger data — it depends on shareholding, directorship and family relationships this schema does not track. The user states it, same as ledgers.is_partner_remuneration (0029) and msme_category.';


create or replace function public.get_related_party_payments(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  ledger_id uuid,
  ledger_name text,
  pan text,
  amount_paid numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with cash_bank_vouchers as (
    -- Every voucher that touches a cash/bank ledger at all, in the period —
    -- the signal that a line elsewhere on the same voucher was an actual
    -- payment, not a pure book entry.
    select distinct e.voucher_id
      from public.voucher_entries e
      join public.ledgers l on l.id = e.ledger_id
      join public.account_groups g on g.id = l.group_id
      join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
     where e.company_id = p_company_id
       and g.ledger_role = 'cash_bank'
       and v.voucher_date between p_fy_start and p_fy_end
  )
  select l.id, l.name, l.pan, sum(e.debit_amount) as amount_paid
    from public.voucher_entries e
    join public.ledgers l on l.id = e.ledger_id
    join cash_bank_vouchers cbv on cbv.voucher_id = e.voucher_id
   where e.company_id = p_company_id
     and l.is_related_party
     and e.debit_amount > 0
   group by l.id, l.name, l.pan
  having sum(e.debit_amount) > 0
   order by sum(e.debit_amount) desc;
$$;

comment on function public.get_related_party_payments is
  'Form 3CD Clause 23: actual payments (not accruals or outstanding balances) made during the period to ledgers flagged is_related_party — a voucher-level debit to the flagged ledger on a voucher that also touches a cash/bank ledger. Does not evaluate whether a payment is excessive or unreasonable, per the clause''s own scope (that is the assessing officer''s call).';
