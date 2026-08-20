-- ============================================================================
-- 0047 — Payroll posting: post a computed run to the books
-- ============================================================================
-- 0043 built Payroll as report-only, deliberately, mirroring the fixed-
-- assets precedent (book depreciation reported before it was ever journal-
-- posted). This closes that gap: post_payroll_run(company, branch, period)
-- takes get_payroll_run's own totals for a month and posts ONE journal
-- voucher —
--   Dr Salary Expense            = sum(gross_pay)
--   Dr Employer PF Contribution  = sum(pf_employer)
--   Dr Employer ESI Contribution = sum(esi_employer)
--   Cr PF Payable                = sum(pf_employee + pf_employer)
--   Cr ESI Payable                = sum(esi_employee + esi_employer)
--   Cr Professional Tax Payable  = sum(professional_tax)
--   Cr Salaries Payable          = sum(net_pay)
-- Balances by construction: Dr total = gross + employer_pf + employer_esi;
-- Cr total = (employee_pf+employer_pf) + (employee_esi+employer_esi) + pt +
-- (gross - employee_pf - employee_esi - pt), which reduces to the same
-- gross + employer_pf + employer_esi. Zero-amount lines (e.g. no employee
-- had ESI applicable this month) are omitted — voucher_entries' own check
-- constraint requires exactly one of debit/credit to be POSITIVE, so a
-- zero/zero line would be rejected outright, not just redundant.
--
-- ONE LEDGER PER PURPOSE, NOT PER EMPLOYEE. Salaries Payable is a single
-- aggregate liability ledger, the same simplification real practice makes
-- (Tally-style charts of accounts don't carry one ledger per employee
-- either) — the payroll register (0043) is the per-employee detail this
-- aggregate is built from, the same relationship the Outstanding report
-- already has with Sundry Debtors/Creditors.
--
-- LEDGERS ARE LAZILY PROVISIONED, not seeded unconditionally at company
-- creation like TDS Payable (0030) was. TDS Payable is special-cased
-- because ANY voucher can unpredictably need a TDS split; payroll ledgers
-- are only ever needed once a company actually posts payroll, the same
-- shape as seed_gst_ledgers (fires when a GST registration is added) and
-- seed_tcs_ledger (fires when a TAN is added) — event-driven, not
-- universal. Reuses an existing same-named ledger if the company already
-- has one, same reuse-not-blind-insert discipline as seed_tds_ledgers.
--
-- ONE POST PER MONTH, ENFORCED. payroll_postings has a unique (company_id,
-- period_month) — re-running post_payroll_run for an already-posted month
-- raises rather than double-posting. No unpost/reversal function is built
-- here; a correction is an ordinary reversing journal entry, same as any
-- other voucher mistake in this app.
--
-- ADMIN-ONLY, deliberately narrower than an ordinary voucher's
-- can_write_company bar (which any company member with write access
-- already has) — posting payroll is closer in weight to closing a period
-- than to entering a routine voucher, so it uses the same is_company_admin
-- bar already set for employees/employee_salary_structures (0043).
-- ============================================================================

create table public.payroll_ledger_map (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  purpose text not null check (purpose in (
    'salary_expense', 'employer_pf_expense', 'employer_esi_expense',
    'pf_payable', 'esi_payable', 'professional_tax_payable', 'net_pay_payable'
  )),
  ledger_id uuid not null,
  unique (company_id, purpose),
  foreign key (ledger_id, company_id) references public.ledgers (id, company_id) on delete cascade
);

comment on table public.payroll_ledger_map is
  'Maps each payroll posting purpose to one company ledger, lazily provisioned by app_private.seed_payroll_ledgers the first time post_payroll_run runs for a company. Same shape as tax_ledger_map (0006), kept separate since payroll purposes aren''t GST/TDS/TCS.';

create table public.payroll_postings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  period_month date not null,
  voucher_id uuid not null references public.vouchers(id) on delete cascade,
  posted_by uuid references auth.users(id),
  posted_at timestamptz not null default now(),
  unique (company_id, period_month)
);

comment on table public.payroll_postings is
  'One row per month a company has posted payroll for — the unique (company_id, period_month) is what stops post_payroll_run from double-posting the same month. Points at the single journal voucher that posting created.';

alter table public.payroll_ledger_map enable row level security;
alter table public.payroll_postings enable row level security;

create policy payroll_ledger_map_read on public.payroll_ledger_map
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy payroll_ledger_map_write on public.payroll_ledger_map
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

create policy payroll_postings_read on public.payroll_postings
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy payroll_postings_write on public.payroll_postings
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

-- ----------------------------------------------------------------------------
-- app_private.seed_one_payroll_ledger — get-or-create one ledger for one
-- purpose, reusing an existing same-named ledger if present (same reuse
-- discipline as seed_tds_ledgers). Small helper so seed_payroll_ledgers
-- below isn't seven near-identical copies of the same fifteen lines.
-- ----------------------------------------------------------------------------
create or replace function app_private.seed_one_payroll_ledger(
  p_company_id uuid,
  p_group_id uuid,
  p_name text,
  p_purpose text,
  p_opening_type text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ledger uuid;
begin
  if exists (
    select 1 from public.payroll_ledger_map
     where company_id = p_company_id and purpose = p_purpose
  ) then
    return;
  end if;

  select id into v_ledger
    from public.ledgers
   where company_id = p_company_id and lower(name) = lower(p_name)
   limit 1;

  if v_ledger is null then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type)
    values (p_company_id, p_group_id, p_name, p_opening_type)
    returning id into v_ledger;
  end if;

  insert into public.payroll_ledger_map (company_id, purpose, ledger_id)
  values (p_company_id, p_purpose, v_ledger)
  on conflict (company_id, purpose) do nothing;
end;
$$;

comment on function app_private.seed_one_payroll_ledger is
  'Get-or-create one ledger for one payroll_ledger_map purpose. Reuses an existing same-named ledger if the company already has one, same discipline as seed_tds_ledgers (0030). Idempotent via the payroll_ledger_map existence check.';

-- ----------------------------------------------------------------------------
-- app_private.seed_payroll_ledgers — all seven, resolving each target group
-- by exact seeded name (Indirect Expenses / Duties & Taxes / Outstanding
-- Expenses) rather than ledger_role, since ledger_role='expense' is shared
-- by BOTH Direct and Indirect Expenses (0006) and would be ambiguous.
-- ----------------------------------------------------------------------------
create or replace function app_private.seed_payroll_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_indirect_expense uuid;
  v_duty_tax uuid;
  v_outstanding uuid;
begin
  select id into v_indirect_expense from public.account_groups
   where company_id = p_company_id and parent_group_id is null and name = 'Indirect Expenses';
  select id into v_duty_tax from public.account_groups
   where company_id = p_company_id and name = 'Duties & Taxes';
  select id into v_outstanding from public.account_groups
   where company_id = p_company_id and name = 'Outstanding Expenses';

  if v_indirect_expense is null or v_duty_tax is null or v_outstanding is null then
    raise exception 'Chart of accounts is missing a standard group; seed it first';
  end if;

  perform app_private.seed_one_payroll_ledger(p_company_id, v_indirect_expense, 'Salary Expense', 'salary_expense', 'debit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_indirect_expense, 'Employer PF Contribution', 'employer_pf_expense', 'debit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_indirect_expense, 'Employer ESI Contribution', 'employer_esi_expense', 'debit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_duty_tax, 'PF Payable', 'pf_payable', 'credit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_duty_tax, 'ESI Payable', 'esi_payable', 'credit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_duty_tax, 'Professional Tax Payable', 'professional_tax_payable', 'credit');
  perform app_private.seed_one_payroll_ledger(p_company_id, v_outstanding, 'Salaries Payable', 'net_pay_payable', 'credit');
end;
$$;

comment on function app_private.seed_payroll_ledgers is
  'Lazily provisions all seven payroll ledgers (Salary Expense, Employer PF/ESI Contribution under Indirect Expenses; PF/ESI/Professional Tax Payable under Duties & Taxes; Salaries Payable under Outstanding Expenses) the first time a company posts payroll. Called from post_payroll_run, not from company creation — see the migration header for why this differs from TDS Payable''s unconditional seeding.';

-- ----------------------------------------------------------------------------
-- post_payroll_run(company, branch, period_month)
-- ----------------------------------------------------------------------------
create or replace function public.post_payroll_run(
  p_company_id uuid,
  p_branch_id uuid,
  p_period_month date
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_period_start date := date_trunc('month', p_period_month)::date;
  v_period_end date := (date_trunc('month', p_period_month) + interval '1 month - 1 day')::date;
  v_voucher_id uuid;
  v_gross numeric; v_pf_employee numeric; v_pf_employer numeric;
  v_esi_employee numeric; v_esi_employer numeric; v_pt numeric; v_net_pay numeric;
  v_salary_exp uuid; v_pf_exp uuid; v_esi_exp uuid;
  v_pf_pay uuid; v_esi_pay uuid; v_pt_pay uuid; v_net_pay_ledger uuid;
  v_lines jsonb := '[]'::jsonb;
begin
  if exists (
    select 1 from public.payroll_postings
     where company_id = p_company_id and period_month = v_period_start
  ) then
    raise exception 'Payroll for % has already been posted', to_char(v_period_start, 'Mon YYYY');
  end if;

  select
      coalesce(sum(gross_pay), 0), coalesce(sum(pf_employee), 0), coalesce(sum(pf_employer), 0),
      coalesce(sum(esi_employee), 0), coalesce(sum(esi_employer), 0),
      coalesce(sum(professional_tax), 0), coalesce(sum(net_pay), 0)
    into v_gross, v_pf_employee, v_pf_employer, v_esi_employee, v_esi_employer, v_pt, v_net_pay
    from public.get_payroll_run(p_company_id, v_period_start);

  if v_gross = 0 then
    raise exception 'No employee has an active salary structure for %', to_char(v_period_start, 'Mon YYYY');
  end if;

  perform app_private.seed_payroll_ledgers(p_company_id);

  select ledger_id into v_salary_exp from public.payroll_ledger_map where company_id = p_company_id and purpose = 'salary_expense';
  select ledger_id into v_pf_exp from public.payroll_ledger_map where company_id = p_company_id and purpose = 'employer_pf_expense';
  select ledger_id into v_esi_exp from public.payroll_ledger_map where company_id = p_company_id and purpose = 'employer_esi_expense';
  select ledger_id into v_pf_pay from public.payroll_ledger_map where company_id = p_company_id and purpose = 'pf_payable';
  select ledger_id into v_esi_pay from public.payroll_ledger_map where company_id = p_company_id and purpose = 'esi_payable';
  select ledger_id into v_pt_pay from public.payroll_ledger_map where company_id = p_company_id and purpose = 'professional_tax_payable';
  select ledger_id into v_net_pay_ledger from public.payroll_ledger_map where company_id = p_company_id and purpose = 'net_pay_payable';

  -- Omit zero-amount lines: voucher_entries' own check constraint requires
  -- exactly one of debit_amount/credit_amount to be strictly positive, so a
  -- zero/zero line (e.g. no employee had ESI applicable this month) would
  -- be rejected, not just redundant.
  if v_gross > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_salary_exp, 'debit_amount', v_gross));
  end if;
  if v_pf_employer > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_pf_exp, 'debit_amount', v_pf_employer));
  end if;
  if v_esi_employer > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_esi_exp, 'debit_amount', v_esi_employer));
  end if;
  if (v_pf_employee + v_pf_employer) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_pf_pay, 'credit_amount', v_pf_employee + v_pf_employer));
  end if;
  if (v_esi_employee + v_esi_employer) > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_esi_pay, 'credit_amount', v_esi_employee + v_esi_employer));
  end if;
  if v_pt > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_pt_pay, 'credit_amount', v_pt));
  end if;
  if v_net_pay > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_net_pay_ledger, 'credit_amount', v_net_pay));
  end if;

  v_voucher_id := public.create_voucher(
    p_company_id := p_company_id,
    p_branch_id := p_branch_id,
    p_voucher_type := 'journal',
    p_voucher_date := v_period_end,
    p_lines := v_lines,
    p_narration := 'Payroll for ' || to_char(v_period_start, 'Mon YYYY')
  );

  insert into public.payroll_postings (company_id, period_month, voucher_id, posted_by)
  values (p_company_id, v_period_start, v_voucher_id, auth.uid());

  return v_voucher_id;
end;
$$;

comment on function public.post_payroll_run is
  'Posts one month''s payroll (from get_payroll_run) as a single journal voucher: Dr Salary Expense + Employer PF/ESI Contribution, Cr PF/ESI/Professional Tax Payable + Salaries Payable. Lazily provisions the seven payroll ledgers on first use. Raises if the month is already posted (payroll_postings has a unique company/period constraint) or if no employee has an active salary structure for the period. No reversal function — a correction is an ordinary reversing journal entry.';

-- ----------------------------------------------------------------------------
-- delete_company: cascade the two new tables too, same belt-and-braces
-- pattern as every prior addition to this function this session.
-- ----------------------------------------------------------------------------
create or replace function public.delete_company(p_company_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can delete a company';
  end if;

  delete from public.payroll_postings     where company_id = p_company_id;
  delete from public.payroll_ledger_map   where company_id = p_company_id;
  delete from public.employee_salary_structures where company_id = p_company_id;
  delete from public.employees            where company_id = p_company_id;
  delete from public.vouchers            where company_id = p_company_id;
  delete from public.tax_ledger_map      where company_id = p_company_id;
  delete from public.bank_statement_lines where company_id = p_company_id;
  delete from public.items               where company_id = p_company_id;
  delete from public.godowns             where company_id = p_company_id;
  delete from public.ledgers             where company_id = p_company_id;
  delete from public.companies           where id = p_company_id;
  delete from public.audit_log           where company_id = p_company_id;
end;
$$;
