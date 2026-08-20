-- ============================================================================
-- 0042 — Form 3CD Clause 26: general (non-MSME) Sec 43B disallowance candidates
-- ============================================================================
-- Researched fresh. Sec 43B overrides normal mercantile accrual for a fixed
-- list of liabilities — they're deductible only in the year actually PAID,
-- not the year accrued, UNLESS a proviso applies: if the amount is paid on
-- or before the due date for furnishing the return of income under Sec
-- 139(1), it's still allowed in the year of accrual. Current list (Finance
-- Act-amended), clause (h) — MSME dues — already covered by 0026/0032 via
-- ledgers.msme_category, and NOT duplicated here:
--   (a) tax, duty, cess or fee payable under any law
--   (b) employer's contribution to PF/superannuation/gratuity fund or any
--       other employee-welfare fund
--   (c) bonus or commission payable to employees
--   (d)/(da)/(e) interest payable on a loan/borrowing from a public
--       financial institution, State Financial/Industrial Investment
--       Corporation, a deposit-taking or systemically-important
--       non-deposit-taking NBFC, or a scheduled/co-operative bank
--   (f) leave encashment payable to employees
--
-- CANDIDATES, NOT A COMPUTED DISALLOWANCE — same framing as 21(d)/23/31.
-- LEKHA does not track the Sec 139(1) return-filing due date (only the
-- Rule 6G tax-audit REPORT due date computed by get_tax_audit_applicability,
-- a related but distinct date), so this cannot test "paid before the return
-- due date" — it can only report the ledger's own outstanding balance as at
-- fy_end. An amount shown here may still be fully allowable if it was in
-- fact paid before the return was filed; equally, an amount that reads zero
-- here because it was paid just before fy_end tells you nothing about
-- WHETHER it was paid on time during the year, only that nothing remains
-- outstanding at the cutoff.
--
-- WHICH LEDGER IS WHICH CATEGORY IS NOT STRUCTURALLY DETECTABLE — same
-- resolution as every other Form 3CD clause this session
-- (is_partner_remuneration/is_related_party/is_loan_or_deposit): a manual
-- per-ledger category, since LEKHA has no payroll module (so PF/ESI/bonus/
-- leave-encashment ledgers are indistinguishable from any other liability
-- ledger) and does not classify a loan's lender type (so "interest payable
-- to a scheduled bank" cannot be told apart from "interest payable to a
-- director", which Sec 43B does NOT cover at all). The user is trusted to
-- only apply "specified_interest" to interest genuinely payable to a bank/
-- PFI/NBFC.
--
-- OUTSTANDING BALANCE computed the same way as the 269SS/269T running
-- balance (0041): the ledger's opening balance plus every posted movement
-- up to and including fy_end, not scoped to the current FY alone — a
-- liability that has sat unpaid since a prior year still counts.
-- ============================================================================

alter table public.ledgers
  add column sec43b_category text;

alter table public.ledgers
  add constraint ledgers_sec43b_category_check
  check (sec43b_category is null or sec43b_category in (
    'statutory_dues', 'employee_welfare_fund', 'bonus_commission',
    'specified_interest', 'leave_encashment'
  ));

comment on column public.ledgers.sec43b_category is
  'Marks this ledger as a general (non-MSME) Sec 43B category for Form 3CD Clause 26: statutory_dues (tax/duty/cess/fee), employee_welfare_fund (PF/superannuation/gratuity), bonus_commission, specified_interest (loan interest payable to a scheduled bank/PFI/NBFC ONLY — not a director or other unspecified lender), or leave_encashment. NULL means not applicable. LEKHA cannot determine this from ledger data — no payroll module exists to identify PF/bonus/leave ledgers, and loan ledgers do not record the lender''s institution type. The user states it, same as msme_category and ledgers.is_loan_or_deposit (0041).';

create or replace function public.get_general_sec43b_dues(
  p_company_id uuid,
  p_fy_start date,
  p_fy_end date
) returns table (
  ledger_id uuid,
  ledger_name text,
  category text,
  outstanding_amount numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    l.id,
    l.name,
    l.sec43b_category,
    coalesce(
      case when l.opening_balance_type = 'credit' then l.opening_balance_amount else -l.opening_balance_amount end,
      0
    ) + coalesce(sum(e.credit_amount - e.debit_amount), 0) as outstanding_amount
    from public.ledgers l
    left join public.voucher_entries e
      on e.ledger_id = l.id
     and e.company_id = p_company_id
    left join public.vouchers v
      on v.id = e.voucher_id
     and not v.is_deleted
     and v.voucher_date <= p_fy_end
   where l.company_id = p_company_id
     and l.sec43b_category is not null
     and (e.voucher_id is null or v.id is not null)
   group by l.id, l.name, l.sec43b_category, l.opening_balance_amount, l.opening_balance_type
  having coalesce(
           case when l.opening_balance_type = 'credit' then l.opening_balance_amount else -l.opening_balance_amount end,
           0
         ) + coalesce(sum(e.credit_amount - e.debit_amount), 0) > 0
   order by l.name;
$$;

comment on function public.get_general_sec43b_dues is
  'Form 3CD Clause 26 (general, non-MSME): outstanding balance as at fy_end on every ledger flagged with a sec43b_category, including its opening balance and every posted movement to date, not scoped to the current FY alone. A candidate for disallowance, not a computed one — LEKHA cannot test whether the amount was paid before the Sec 139(1) return due date, which it does not track. See the migration header for the categories covered and their scope limits.';
