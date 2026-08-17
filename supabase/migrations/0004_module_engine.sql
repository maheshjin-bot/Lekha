-- ============================================================================
-- 0004 — The module on/off engine
-- ============================================================================
-- Three tiers, because a plain on/off switch is unsafe here. If GST were
-- merely a preference, a company holding an active GSTIN could switch it off
-- and post three months of unfilable invoices. So:
--
--   core        always on; no row can disable it
--   conditional the system decides from the company profile; the user sets
--               the *facts* (registrations, entity type) and module state
--               follows
--   optional    genuinely the user's choice
--
-- And module state is effective-dated, never boolean. A company that registers
-- for GST in October must keep April–September as legitimately tax-free rather
-- than retroactively invalid. Every check therefore asks "was this module live
-- on this voucher's date?", never "is it on now?".
-- ============================================================================

-- Needed for the no-overlap exclusion constraint below: btree_gist lets a GiST
-- index mix equality columns (company_id, module_code) with a range overlap.
create extension if not exists btree_gist with schema extensions;


-- ----------------------------------------------------------------------------
-- The catalog
-- ----------------------------------------------------------------------------
create table public.ref_modules (
  code text primary key,
  name text not null,
  tier text not null check (tier in ('core','conditional','optional')),
  -- Modules that must be active before this one can be.
  depends_on text[] not null default '{}',
  -- Conditional tier only: the predicate evaluated against the company
  -- profile. See app_private.module_condition_met().
  activates_when jsonb,
  description text,
  sort_order smallint not null default 0,
  constraint ref_modules_conditional_has_rule
    check (tier <> 'conditional' or activates_when is not null),
  constraint ref_modules_rule_only_when_conditional
    check (tier = 'conditional' or activates_when is null)
);

comment on table public.ref_modules is
  'Module catalog. Tier decides who controls activation: nobody (core), the system (conditional), or the user (optional).';

insert into public.ref_modules (code, name, tier, depends_on, activates_when, description, sort_order) values
  -- Core — always on, no toggle exists.
  ('accounting','Accounting core','core','{}',null,'Chart of accounts, ledgers, the six voucher types',1),
  ('reports','Financial reports','core','{}',null,'Daybook, Ledger, Trial Balance, P&L, Balance Sheet',2),
  ('audit_trail','Audit trail','core','{}',null,'Before/after snapshots of every change',3),
  ('notes','Credit and debit notes','core','{}',null,'Sales returns happen without GST',4),
  ('bank_recon','Bank reconciliation','core','{}',null,'Universal, and stock statements and audit both depend on it',5),
  ('csv_io','CSV import and export','core','{}',null,'Migration path in and out',6),
  ('year_end','Year-end closing','core','{}',null,'Books must roll over',7),

  -- Conditional — the system decides.
  ('compliance_calendar','Compliance calendar','conditional','{}','{"compliance_mode":"compliance"}','Due dates derived from the company profile',20),
  ('fixed_assets','Fixed assets and depreciation','conditional','{}','{"compliance_mode":"compliance"}','Companies Act and Income Tax Act books in parallel',21),
  ('income_tax','Income tax computation','conditional','{fixed_assets}','{"compliance_mode":"compliance"}','Everyone files a return',22),
  ('msme','MSME and Sec 43B(h)','conditional','{}','{"compliance_mode":"compliance"}','The 45-day payment clock applies to every buyer',23),
  ('tds','TDS','conditional','{}','{"has_tan":true}','Mandatory for companies regardless of turnover',24),
  ('tcs','TCS','conditional','{}','{"has_tan":true}','206C, including 1H and the 194Q precedence rule',25),
  ('gst','GST','conditional','{}','{"has_gstin":true}','Returns, registers, input credit',26),
  ('gst_multistate','Multi-state GST','conditional','{gst,multi_branch}','{"gstin_count_min":2}','Separate returns and ITC pool per registration',27),
  ('gst_isd','Input Service Distributor','conditional','{gst_multistate}','{"gstin_count_min":2}','GSTR-6 and Rule 39 distribution',28),
  ('exim','Export and import','conditional','{foreign_currency}','{"has_iec":true}','LUT, shipping bills, BOE, landed cost, realisation',29),
  ('foreign_currency','Foreign currency transactions','conditional','{}','{"has_iec":true}','Transaction-level currency and AS 11 restatement. Books stay INR',30),
  ('tax_audit','Tax audit 3CA/3CB and 3CD','conditional','{income_tax,fixed_assets}','{"compliance_mode":"compliance"}','Activates on crossing the 44AB threshold',31),
  ('schedule_iii','Schedule III statements','conditional','{}','{"statement_format":"schedule_iii"}','Required presentation for companies',32),
  ('roc','ROC filings','conditional','{}','{"roc_applicable":true}','AOC-4, MGT-7, Form 8/11',33),
  ('remuneration_40b','Sec 40(b) remuneration cap','conditional','{income_tax}','{"remuneration_section":"40(b)"}','Book-profit-based cap for firms and LLPs',34),

  -- Optional — the user's call.
  ('multi_branch','Multi-branch','optional','{}',null,'Branches and locations as a reporting dimension',50),
  ('branch_current_accounts','Branch current accounts','optional','{multi_branch}',null,'Per-branch balance sheets that tally independently',51),
  ('inventory','Inventory','optional','{}',null,'Items, godowns, valuation, movement',52),
  ('manufacturing','Manufacturing and BOM','optional','{inventory}',null,'Bill of materials and production',53),
  ('job_work','Job work','optional','{inventory,gst}',null,'ITC-04',54),
  ('batch_serial','Batch, serial and expiry','optional','{inventory}',null,null,55),
  ('cost_centres','Cost centres and projects','optional','{}',null,'Analytical dimension on entry lines',56),
  ('payroll','Payroll','optional','{}',null,'Salary, and the input to Form 24Q',57),
  ('payroll_statutory','PF, ESI and Professional Tax','conditional','{payroll}','{"compliance_mode":"compliance"}','Activates past the headcount thresholds',58),
  ('banking','Banking and loans','optional','{}',null,'Term loans, CC, OD, limits',59),
  ('stock_statement','Stock statement and drawing power','optional','{banking,inventory}',null,'Monthly submission to the lender',60),
  ('budgets','Budgets and variance','optional','{}',null,null,61),
  ('ratios','Ratio analysis and CMA data','optional','{banking}',null,null,62),
  ('documents','Document management','optional','{}',null,'Attachments on vouchers',63),
  ('notices','Notice and assessment tracking','optional','{}',null,null,64),
  ('orders','Sales and purchase orders','optional','{inventory}',null,null,65),
  ('pos','POS and counter billing','optional','{inventory}',null,null,66),
  ('tally_connector','Tally import and export','optional','{}',null,'Migration in, and CA handover out',67),
  ('public_api','Public API access','optional','{}',null,'Scoped tokens mapping to a real membership',68);


-- ----------------------------------------------------------------------------
-- Per-company module state
-- ----------------------------------------------------------------------------
create table public.company_modules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  module_code text not null references public.ref_modules(code),
  effective_from date not null,
  -- null = still active. Closing a period is how a module is "disabled":
  -- existing data stays, history still renders, no new entries accepted.
  effective_to date,
  config jsonb not null default '{}'::jsonb,
  -- Entitlement, kept separate from activation. The module system doubles as
  -- the pricing tiering, and conflating "the customer pays for this" with
  -- "this company uses it" gets tangled the moment a plan changes.
  licensed boolean not null default true,
  enabled_by uuid references auth.users(id) on delete set null,
  -- Set on conditional modules to explain, in the UI, why there is no toggle.
  locked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint company_modules_period_valid
    check (effective_to is null or effective_to >= effective_from),

  -- A module cannot be active twice over the same dates. Without this, two
  -- overlapping rows would make module_active() depend on row order.
  constraint company_modules_no_overlap
    exclude using gist (
      company_id with =,
      module_code with =,
      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
    )
);

create index company_modules_lookup_idx
  on public.company_modules (company_id, module_code, effective_from desc);

create trigger set_updated_at
  before update on public.company_modules
  for each row execute function app_private.set_updated_at();


-- ----------------------------------------------------------------------------
-- The enforcement predicate
-- ----------------------------------------------------------------------------
-- Called from RLS policies and from triggers on every module-gated table.
-- Takes the *transaction* date, not today's, so a voucher is judged against
-- the module state that applied when it happened.
--
-- Core modules short-circuit to true: they are always on by definition, and
-- requiring a row for them would mean a company could be broken by deleting
-- one.
create or replace function app_private.module_active(
  p_company_id uuid,
  p_module_code text,
  p_on_date date default current_date
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((select tier = 'core' from public.ref_modules where code = p_module_code), false)
    or exists (
      select 1
        from public.company_modules m
       where m.company_id = p_company_id
         and m.module_code = p_module_code
         and m.licensed
         and m.effective_from <= p_on_date
         and (m.effective_to is null or m.effective_to >= p_on_date)
    );
$$;

comment on function app_private.module_active is
  'Was this module live for this company on this date? Enforcement lives here, not in the UI — a disabled module must be unwritable even via a direct API call.';


-- ----------------------------------------------------------------------------
-- Conditional activation
-- ----------------------------------------------------------------------------
-- Evaluates one catalog rule against a company profile. The predicate
-- vocabulary is deliberately small and closed — a general expression language
-- here would be a foot-gun, since these decide statutory behaviour.
--
-- 0005 replaces this function to add the GSTIN-count predicates, once
-- gst_registrations exists. Keys not understood evaluate to false rather than
-- raising: an unknown rule must fail closed.
create or replace function app_private.module_condition_met(
  p_company_id uuid,
  p_rule jsonb
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_company public.companies%rowtype;
  v_entity public.ref_entity_types%rowtype;
  v_key text;
  v_val jsonb;
begin
  if p_rule is null or p_rule = '{}'::jsonb then
    return false;
  end if;

  select * into v_company from public.companies where id = p_company_id;
  if not found then
    return false;
  end if;

  select * into v_entity from public.ref_entity_types where code = v_company.entity_type;

  -- Every key must hold; an empty rule was rejected above.
  for v_key, v_val in select * from jsonb_each(p_rule) loop
    case v_key
      when 'compliance_mode' then
        if v_company.compliance_mode is distinct from (v_val #>> '{}') then return false; end if;
      when 'has_tan' then
        if (v_company.tan is not null) is distinct from (v_val::boolean) then return false; end if;
      when 'has_iec' then
        if (v_company.iec is not null) is distinct from (v_val::boolean) then return false; end if;
      when 'has_pan' then
        if (v_company.pan is not null) is distinct from (v_val::boolean) then return false; end if;
      when 'entity_type' then
        if v_company.entity_type is distinct from (v_val #>> '{}') then return false; end if;
      when 'statement_format' then
        if v_entity.statement_format is distinct from (v_val #>> '{}') then return false; end if;
      when 'roc_applicable' then
        if v_entity.roc_applicable is distinct from (v_val::boolean) then return false; end if;
      when 'remuneration_section' then
        if v_entity.remuneration_section is distinct from (v_val #>> '{}') then return false; end if;
      when 'has_gstin', 'gstin_count_min' then
        -- Registrations arrive in 0005; until then these cannot be satisfied.
        return false;
      else
        return false; -- unknown predicate: fail closed
    end case;
  end loop;

  return true;
end;
$$;

-- Brings a company's conditional modules into line with its profile. Opens a
-- period for any newly-satisfied rule; closes one whose rule no longer holds.
--
-- Closing sets effective_to to yesterday rather than deleting: a company that
-- drops below the tax-audit threshold this year still had an audit last year,
-- and that history has to survive.
--
-- A conditional module needs BOTH its rule satisfied AND every dependency
-- already active. Without the dependency check, PF/ESI/PT activates for a
-- company in compliance mode that has no payroll at all — its rule is only
-- "compliance_mode = compliance", and the depends_on is what carries the rest
-- of the meaning.
--
-- Resolution runs to a fixpoint rather than in a single pass, because one
-- conditional module can depend on another and sort_order is not a dependency
-- order. Bounded, so a mis-declared cycle in the catalog cannot spin forever.
create or replace function app_private.resolve_conditional_modules(p_company_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_module public.ref_modules%rowtype;
  v_should boolean;
  v_is_open boolean;
  v_dep text;
  v_changed boolean;
  v_pass int := 0;
begin
  loop
    v_pass := v_pass + 1;
    v_changed := false;

    for v_module in
      select * from public.ref_modules where tier = 'conditional' order by sort_order
    loop
      v_should := app_private.module_condition_met(p_company_id, v_module.activates_when);

      -- Every dependency must be live for the module to be meaningful.
      if v_should then
        foreach v_dep in array v_module.depends_on loop
          if not app_private.module_active(p_company_id, v_dep) then
            v_should := false;
            exit;
          end if;
        end loop;
      end if;

      select exists (
        select 1 from public.company_modules
         where company_id = p_company_id
           and module_code = v_module.code
           and effective_to is null
      ) into v_is_open;

      if v_should and not v_is_open then
        insert into public.company_modules (company_id, module_code, effective_from, locked_reason)
        values (
          p_company_id,
          v_module.code,
          current_date,
          'Activated automatically: ' || coalesce(v_module.description, v_module.name)
        )
        -- A closed period ending today would collide with a new one starting
        -- today. Leave it be; the module is already active for today.
        on conflict do nothing;
        v_changed := true;

      elsif not v_should and v_is_open then
        update public.company_modules
           set effective_to = greatest(effective_from, current_date - 1)
         where company_id = p_company_id
           and module_code = v_module.code
           and effective_to is null;
        v_changed := true;
      end if;
    end loop;

    exit when not v_changed or v_pass >= 10;
  end loop;
end;
$$;

-- Re-resolve whenever a fact that a rule reads changes.
create or replace function app_private.trg_resolve_modules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.resolve_conditional_modules(new.id);
  return new;
end;
$$;

create trigger resolve_modules_on_company_change
  after insert or update of compliance_mode, entity_type, pan, tan, iec
  on public.companies
  for each row execute function app_private.trg_resolve_modules();


-- ----------------------------------------------------------------------------
-- User-facing toggle
-- ----------------------------------------------------------------------------
-- Optional tier only. Core and conditional raise, with a message the UI can
-- show verbatim — "you cannot turn this off" is only acceptable when it also
-- says why.
create or replace function public.set_module(
  p_company_id uuid,
  p_module_code text,
  p_enabled boolean,
  p_from_date date default current_date
) returns void
language plpgsql
security invoker   -- RLS decides whether the caller may touch this company
set search_path = ''
as $$
declare
  v_module public.ref_modules%rowtype;
  v_dep text;
  v_dependent text;
begin
  select * into v_module from public.ref_modules where code = p_module_code;
  if not found then
    raise exception 'Unknown module %', p_module_code;
  end if;

  if v_module.tier = 'core' then
    raise exception '% is part of the accounting core and cannot be switched off', v_module.name;
  end if;

  if v_module.tier = 'conditional' then
    raise exception '% is governed by this company''s registrations and entity type, not by a setting. Change the underlying detail instead.', v_module.name;
  end if;

  if p_enabled then
    -- Every dependency must already be live on the start date.
    foreach v_dep in array v_module.depends_on loop
      if not app_private.module_active(p_company_id, v_dep, p_from_date) then
        raise exception '% requires % to be enabled first',
          v_module.name,
          coalesce((select name from public.ref_modules where code = v_dep), v_dep);
      end if;
    end loop;

    if app_private.module_active(p_company_id, p_module_code, p_from_date) then
      return; -- already on; nothing to do
    end if;

    insert into public.company_modules (company_id, module_code, effective_from, enabled_by)
    values (p_company_id, p_module_code, p_from_date, auth.uid());

  else
    -- Refuse while something still depends on it.
    select r.name into v_dependent
      from public.ref_modules r
     where p_module_code = any(r.depends_on)
       and app_private.module_active(p_company_id, r.code, p_from_date)
     limit 1;

    if v_dependent is not null then
      raise exception 'Disable % first — it depends on %', v_dependent, v_module.name;
    end if;

    -- Close the period rather than deleting the row: the data posted while it
    -- was on has to stay readable.
    update public.company_modules
       set effective_to = greatest(effective_from, p_from_date - 1)
     where company_id = p_company_id
       and module_code = p_module_code
       and effective_to is null;
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- Read model
-- ----------------------------------------------------------------------------
-- One call for the whole navigation. Returns every catalog entry with whether
-- it is live, so the UI can distinguish "absent because off" from "absent
-- because this company can never have it".
create or replace function public.get_company_modules(
  p_company_id uuid,
  p_as_at date default current_date
) returns table (
  code text,
  name text,
  tier text,
  active boolean,
  licensed boolean,
  can_toggle boolean,
  locked_reason text,
  depends_on text[],
  description text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    r.code,
    r.name,
    r.tier,
    app_private.module_active(p_company_id, r.code, p_as_at),
    coalesce(m.licensed, true),
    r.tier = 'optional',
    case r.tier
      when 'core' then 'Part of the accounting core'
      when 'conditional' then coalesce(m.locked_reason, 'Determined by this company''s registrations and entity type')
      else null
    end,
    r.depends_on,
    r.description
  from public.ref_modules r
  left join public.company_modules m
    on m.company_id = p_company_id
   and m.module_code = r.code
   and m.effective_from <= p_as_at
   and (m.effective_to is null or m.effective_to >= p_as_at)
  order by r.sort_order;
$$;


-- ----------------------------------------------------------------------------
-- Row level security
-- ----------------------------------------------------------------------------
alter table public.ref_modules enable row level security;
alter table public.company_modules enable row level security;

create policy ref_modules_read on public.ref_modules
  for select to authenticated using (true);

create policy company_modules_read on public.company_modules
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

-- No direct write policy. Module state changes only through set_module() and
-- the conditional resolver, both of which enforce the tier rules. Letting a
-- client INSERT here would bypass every one of them.
