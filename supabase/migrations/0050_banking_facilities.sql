-- ============================================================================
-- 0050 — Multi-facility banking: one drawing power per bank facility
-- ============================================================================
-- 0034 shipped drawing power as one facility per company — its own header
-- named this the explicit scope cut: "P4 'Banking & stock statement' in the
-- roadmap is explicitly broader... a company with two facilities from two
-- different banks, each with its own margins, is not representable yet".
-- This migration is that broadening: banking_facilities holds one row per
-- CC/OD/term loan a company actually has, each with its OWN margins and
-- sanctioned limit — a company financed by two banks, or two facilities
-- from the same bank, computes a real drawing power for each, not one
-- blended figure.
--
-- BACKFILL, NOT A BREAKING CHANGE. Every company that already has non-
-- default margin settings gets exactly one facility row created from those
-- settings, named "Primary Facility" — get_drawing_power's OLD single-
-- facility behaviour (called with p_facility_id = null) is preserved by
-- falling back to a company's first active facility if one exists, so no
-- existing report link or bookmark breaks. companies.stock_margin_percent
-- etc. are NOT dropped — a genuinely single-facility company can keep
-- using them as-is; a company that adds a second facility explicitly
-- moves to the multi-facility model for that report.
--
-- SANCTIONED LIMIT is stored and shown, but the drawing power figure never
-- factors it in for the calculation itself — 0034's own footer already
-- says why: "compare this against the actual sanction letter's limit
-- yourself, the lower of the two is the real drawing power" — this
-- migration surfaces that comparison directly instead of asking the reader
-- to hold the sanctioned figure in their head.
-- ============================================================================

create table public.banking_facilities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_name text not null check (length(trim(bank_name)) > 0),
  facility_type text not null default 'cc_od' check (facility_type in ('cc_od', 'term_loan', 'other')),
  sanctioned_limit numeric not null default 0 check (sanctioned_limit >= 0),
  stock_margin_percent numeric(5,2) not null default 25
    check (stock_margin_percent >= 0 and stock_margin_percent <= 100),
  debtor_margin_percent numeric(5,2) not null default 40
    check (debtor_margin_percent >= 0 and debtor_margin_percent <= 100),
  debtor_eligibility_days smallint not null default 90
    check (debtor_eligibility_days in (30, 60, 90)),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index banking_facilities_company_idx on public.banking_facilities(company_id, is_active);

create trigger set_updated_at before update on public.banking_facilities
  for each row execute function app_private.set_updated_at();

comment on table public.banking_facilities is
  'One row per bank CC/OD/term loan facility a company holds, each with its own margins for get_drawing_power. Supersedes the single-facility companies.stock_margin_percent/debtor_margin_percent/debtor_eligibility_days columns (0034) for any company that has more than one — those columns stay in place and still work for a genuinely single-facility company.';

alter table public.banking_facilities enable row level security;

create policy banking_facilities_read on public.banking_facilities
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy banking_facilities_write on public.banking_facilities
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

-- ----------------------------------------------------------------------------
-- Backfill: one "Primary Facility" per company that already has the
-- stock_statement module active, seeded from its current company-level
-- settings, so every company that was already using the single-facility
-- report gets an equivalent facility row for free.
-- ----------------------------------------------------------------------------
insert into public.banking_facilities (company_id, bank_name, facility_type, sanctioned_limit, stock_margin_percent, debtor_margin_percent, debtor_eligibility_days)
select c.id, 'Primary Facility', 'cc_od', 0, c.stock_margin_percent, c.debtor_margin_percent, c.debtor_eligibility_days
  from public.companies c
 where exists (
   select 1 from public.company_modules m
    where m.company_id = c.id and m.module_code = 'stock_statement'
      and (m.effective_to is null or m.effective_to > now())
 );

-- ----------------------------------------------------------------------------
-- 0034's original 2-arg signature must be dropped explicitly — adding a
-- third parameter (even with a default) makes CREATE OR REPLACE create a
-- second overload instead of replacing it, which then makes every existing
-- 2-arg call site ambiguous. One function, three args, the third optional.
-- ----------------------------------------------------------------------------
drop function if exists public.get_drawing_power(uuid, date);

-- ----------------------------------------------------------------------------
-- get_drawing_power(company, as_at, facility_id) — extended, not replaced.
-- p_facility_id null preserves the old single-facility behaviour: falls
-- back to the company's own settings columns exactly as before, UNLESS
-- the company has active facility rows, in which case it uses the first
-- one (oldest created) so a company that has since added real facilities
-- gets a real facility's figures instead of possibly-stale company-level
-- defaults.
-- ----------------------------------------------------------------------------
create or replace function public.get_drawing_power(
  p_company_id uuid,
  p_as_at date default current_date,
  p_facility_id uuid default null
) returns table (
  facility_id uuid,
  bank_name text,
  sanctioned_limit numeric,
  closing_stock_value numeric,
  sundry_creditors numeric,
  paid_stock numeric,
  stock_margin_percent numeric,
  dp_from_stock numeric,
  total_debtors numeric,
  ineligible_debtors numeric,
  eligible_debtors numeric,
  debtor_eligibility_days smallint,
  debtor_margin_percent numeric,
  dp_from_debtors numeric,
  total_drawing_power numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_facility_id uuid;
  v_bank_name text;
  v_sanctioned numeric := 0;
  v_stock_margin numeric;
  v_debtor_margin numeric;
  v_elig_days smallint;
  v_stock numeric := 0;
  v_creditors numeric := 0;
  v_paid_stock numeric;
  v_total_debtors numeric := 0;
  v_ineligible numeric := 0;
  v_eligible numeric;
begin
  if p_facility_id is not null then
    select f.id, f.bank_name, f.sanctioned_limit, f.stock_margin_percent, f.debtor_margin_percent, f.debtor_eligibility_days
      into v_facility_id, v_bank_name, v_sanctioned, v_stock_margin, v_debtor_margin, v_elig_days
      from public.banking_facilities f
     where f.id = p_facility_id and f.company_id = p_company_id;
  else
    select f.id, f.bank_name, f.sanctioned_limit, f.stock_margin_percent, f.debtor_margin_percent, f.debtor_eligibility_days
      into v_facility_id, v_bank_name, v_sanctioned, v_stock_margin, v_debtor_margin, v_elig_days
      from public.banking_facilities f
     where f.company_id = p_company_id and f.is_active
     order by f.created_at
     limit 1;
  end if;

  -- No facility row at all (company never created one, or the id given
  -- doesn't belong to it) — fall back to the company's own settings
  -- columns, exactly 0034's original single-facility behaviour.
  if v_stock_margin is null then
    select c.stock_margin_percent, c.debtor_margin_percent, c.debtor_eligibility_days
      into v_stock_margin, v_debtor_margin, v_elig_days
      from public.companies c
     where c.id = p_company_id;
    v_bank_name := null;
    v_sanctioned := 0;
  end if;

  if v_stock_margin is null then
    return; -- company not found
  end if;

  select coalesce(sum(s.closing_value), 0) into v_stock
    from public.get_stock_summary(p_company_id, p_as_at) s;

  select coalesce(sum(o.outstanding), 0) into v_creditors
    from public.get_party_outstanding(p_company_id, p_as_at, 'creditor') o;

  v_paid_stock := greatest(v_stock - v_creditors, 0);

  select
      coalesce(sum(o.outstanding), 0),
      coalesce(sum(
        case v_elig_days
          when 30 then o.outstanding - o.not_due - o.days_0_30
          when 60 then o.outstanding - o.not_due - o.days_0_30 - o.days_31_60
          else        o.outstanding - o.not_due - o.days_0_30 - o.days_31_60 - o.days_61_90
        end
      ), 0)
    into v_total_debtors, v_ineligible
    from public.get_party_outstanding(p_company_id, p_as_at, 'debtor') o;

  v_eligible := greatest(v_total_debtors - v_ineligible, 0);

  facility_id := v_facility_id;
  bank_name := v_bank_name;
  sanctioned_limit := round(v_sanctioned, 2);
  closing_stock_value := round(v_stock, 2);
  sundry_creditors := round(v_creditors, 2);
  paid_stock := round(v_paid_stock, 2);
  stock_margin_percent := v_stock_margin;
  dp_from_stock := round(v_paid_stock * (1 - v_stock_margin / 100), 2);
  total_debtors := round(v_total_debtors, 2);
  ineligible_debtors := round(greatest(v_ineligible, 0), 2);
  eligible_debtors := round(v_eligible, 2);
  debtor_eligibility_days := v_elig_days;
  debtor_margin_percent := v_debtor_margin;
  dp_from_debtors := round(v_eligible * (1 - v_debtor_margin / 100), 2);
  total_drawing_power := dp_from_stock + dp_from_debtors;
  return next;
end;
$$;

comment on function public.get_drawing_power is
  'Monthly stock statement / drawing power for one bank facility: paid stock (closing stock less sundry creditors) and eligible debtors (within debtor_eligibility_days), each margined per the facility''s own settings. p_facility_id selects a specific banking_facilities row; null falls back to the company''s first active facility, or its legacy company-level settings columns if it has none. sanctioned_limit is shown for direct comparison — the LOWER of drawing power and the sanctioned limit is the real usable figure, this function does not cap one against the other itself.';

-- ----------------------------------------------------------------------------
-- delete_company: cascade the new table too.
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

  delete from public.banking_facilities  where company_id = p_company_id;
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
