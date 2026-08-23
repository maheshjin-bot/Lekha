-- ============================================================================
-- 0030 — TDS Payable ledger: closing the gap VoucherForm's TDS split left open
-- ============================================================================
-- VoucherForm's splitLineForTds (components/vouchers/VoucherForm.tsx) already
-- shrinks a deductee's line to its net amount and inserts a second line for
-- the TDS withheld — but leaves that second line's ledger blank, because
-- "this app doesn't auto-select a 'TDS Payable' ledger the way GST auto-posts
-- through tax_ledger_map", since none was ever seeded. This migration seeds
-- one, the same way 0006's seed_gst_ledgers and 0027's seed_tcs_ledger do.
--
-- SHAPE: company-wide, not per-registration — TDS is deducted under a single
-- company TAN/PAN, not per GSTIN, exactly the case tax_ledger_map's own
-- gst_registration_id-nullable design already anticipates (0006's comment on
-- the table names "TDS payable" as the worked example of a company-wide
-- purpose). One ledger, purpose 'tds_payable', gst_registration_id null.
--
-- LIFECYCLE: folded into seed_chart_of_accounts itself rather than into
-- create_company separately — seed_chart_of_accounts is the one function
-- every company-creation path already calls (its only call site is
-- create_company, 0014), so a TDS Payable ledger becomes exactly as
-- unconditional and automatic as the rest of the chart, with no second call
-- site to keep in sync. Harmless for a company that never deducts TDS from
-- anyone, same as the unused sub-groups already seeded alongside it.
--
-- IDEMPOTENCY: seed_tds_ledgers checks tax_ledger_map first (a no-op if
-- already mapped), so it is safe to call twice: once implicitly for every
-- new company (via seed_chart_of_accounts) and once explicitly here as a
-- one-time backfill for the ten companies that already exist.
--
-- REUSE, NOT BLIND INSERT. All ten existing companies already carry a ledger
-- literally named "TDS Payable" under Duties & Taxes (created ahead of this
-- migration, apparently in anticipation of it, but never wired into
-- tax_ledger_map) — a plain insert collided with ledgers_company_name_idx
-- the first time this was run against the live database. The same situation
-- is entirely plausible in production too: a company may already have set
-- up its own "TDS Payable" ledger by hand before this feature shipped. So
-- seed_tds_ledgers looks for an existing ledger by that exact name first and
-- wires *that* one in; it only creates a new ledger when none exists.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- seed_tds_ledgers
-- ----------------------------------------------------------------------------
create or replace function app_private.seed_tds_ledgers(p_company_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_group uuid;
  v_ledger uuid;
begin
  -- Idempotent: called from seed_chart_of_accounts for every new company AND
  -- from the one-time backfill below, so a second call for the same company
  -- (or a re-run of this migration) must not create a duplicate ledger or
  -- map row.
  if exists (
    select 1 from public.tax_ledger_map
     where company_id = p_company_id and gst_registration_id is null and purpose = 'tds_payable'
  ) then
    return;
  end if;

  select id into v_group
    from public.account_groups
   where company_id = p_company_id and ledger_role = 'duty_tax'
   order by sort_order limit 1;
  if v_group is null then
    raise exception 'No Duties & Taxes group found; seed the chart of accounts first';
  end if;

  -- Reuse a ledger already named "TDS Payable" if one exists (see migration
  -- header) rather than blindly inserting and colliding with
  -- ledgers_company_name_idx's case-insensitive uniqueness. Only when none
  -- exists is a new one created.
  select id into v_ledger
    from public.ledgers
   where company_id = p_company_id and lower(name) = 'tds payable'
   limit 1;

  if v_ledger is null then
    insert into public.ledgers (company_id, group_id, name, opening_balance_type)
    values (p_company_id, v_group, 'TDS Payable', 'credit')
    returning id into v_ledger;
  end if;

  insert into public.tax_ledger_map (company_id, gst_registration_id, purpose, ledger_id)
  values (p_company_id, null, 'tds_payable', v_ledger);
end;
$$;

comment on function app_private.seed_tds_ledgers is
  'Seeds (or reuses an existing) company-wide "TDS Payable" ledger under Duties & Taxes and wires it into tax_ledger_map (purpose=tds_payable, gst_registration_id null — TDS is TAN-level, not GSTIN-level). Idempotent: a no-op if already mapped.';


-- ----------------------------------------------------------------------------
-- seed_chart_of_accounts, extended to seed the TDS Payable ledger alongside
-- the rest of the chart. Every existing line is unchanged.
-- ----------------------------------------------------------------------------
create or replace function app_private.seed_chart_of_accounts(p_company_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  v_capital uuid;
  v_current_assets uuid;
  v_current_liabilities uuid;
  v_fixed_assets uuid;
begin
  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Capital Account', 'capital', 'credit', 'capital', true, 1)
  returning id into v_capital;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Current Assets', 'current_asset', 'debit', 'other', true, 2)
  returning id into v_current_assets;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Current Liabilities', 'current_liability', 'credit', 'other', true, 3)
  returning id into v_current_liabilities;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values (p_company_id, 'Fixed Assets', 'fixed_asset', 'debit', 'fixed_asset', true, 4)
  returning id into v_fixed_assets;

  insert into public.account_groups (company_id, name, nature, normal_balance, ledger_role, is_system, sort_order)
  values
    (p_company_id, 'Direct Expenses',   'direct_expense',   'debit',  'expense', true, 5),
    (p_company_id, 'Direct Incomes',    'direct_income',    'credit', 'income',  true, 6),
    (p_company_id, 'Indirect Expenses', 'indirect_expense', 'debit',  'expense', true, 7),
    (p_company_id, 'Indirect Incomes',  'indirect_income',  'credit', 'income',  true, 8);

  -- Conventional sub-groups. Deletable and renameable, unlike the eight above.
  insert into public.account_groups (company_id, parent_group_id, name, nature, normal_balance, ledger_role, sort_order)
  values
    (p_company_id, v_current_assets,      'Bank Accounts',        'current_asset',     'debit',  'cash_bank',  1),
    (p_company_id, v_current_assets,      'Cash-in-Hand',         'current_asset',     'debit',  'cash_bank',  2),
    (p_company_id, v_current_assets,      'Sundry Debtors',       'current_asset',     'debit',  'debtor',     3),
    (p_company_id, v_current_assets,      'Loans & Advances',     'current_asset',     'debit',  'loan',       4),
    (p_company_id, v_current_assets,      'Stock-in-Hand',        'current_asset',     'debit',  'stock',      5),
    (p_company_id, v_current_liabilities, 'Sundry Creditors',     'current_liability', 'credit', 'creditor',   1),
    (p_company_id, v_current_liabilities, 'Duties & Taxes',       'current_liability', 'credit', 'duty_tax',   2),
    (p_company_id, v_current_liabilities, 'Provisions',           'current_liability', 'credit', 'provision',  3),
    (p_company_id, v_current_liabilities, 'Outstanding Expenses', 'current_liability', 'credit', 'other',      4),
    (p_company_id, v_fixed_assets,        'Plant & Machinery',    'fixed_asset',       'debit',  'fixed_asset', 1),
    (p_company_id, v_fixed_assets,        'Office Equipment',     'fixed_asset',       'debit',  'fixed_asset', 2),
    (p_company_id, v_fixed_assets,        'Furniture',            'fixed_asset',       'debit',  'fixed_asset', 3);

  -- TDS Payable, same as Duties & Taxes above: unconditional and harmless
  -- for a company that never deducts TDS from anyone, seeded here so it is
  -- available the moment a TDS-deductee vendor first shows up, with no
  -- separate "configure TDS first" step.
  perform app_private.seed_tds_ledgers(p_company_id);
end;
$$;

comment on function app_private.seed_chart_of_accounts is
  'Eight system groups plus the conventional sub-groups. Duties & Taxes and Stock-in-Hand are seeded here because GST and inventory both need somewhere to post before their modules are configured. Also seeds the company-wide TDS Payable ledger (app_private.seed_tds_ledgers).';


-- ----------------------------------------------------------------------------
-- Backfill: every company created before this migration needs the ledger
-- provisioned once, now. seed_tds_ledgers's own guard makes this safe to run
-- even for a company that (somehow) already has one.
-- ----------------------------------------------------------------------------
select app_private.seed_tds_ledgers(id) from public.companies;
