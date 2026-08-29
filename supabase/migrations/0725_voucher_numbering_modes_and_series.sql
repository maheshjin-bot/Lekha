-- ============================================================================
-- 0725 — Voucher numbering becomes configurable: automatic / manual / series,
--        and the CGST Rule 46(b) 16-character violation 0230 documented but
--        could not fix gets an actual fix
-- ============================================================================
-- WHAT WAS ACTUALLY TRUE BEFORE THIS MIGRATION, CONFIRMED LIVE RATHER THAN
-- RECALLED (pg_get_functiondef / pg_constraint / a full dump of
-- voucher_number_sequences, all read before a line of this file was written):
--
--   * ONE function mints every voucher number in this database —
--     app_private.next_voucher_number(uuid, uuid, text, date), defined in
--     0007 and last replaced in 0113. NINE live functions call it
--     (create_voucher, create_invoice, create_job_work_challan,
--     create_job_work_return, create_production_voucher,
--     create_delivery_challan, record_forex_settlement,
--     record_forex_revaluation, record_stock_verification — confirmed by
--     querying pg_proc.prosrc, not by grepping migration files, since most
--     of those migrations define superseded versions). Every one of the nine
--     calls it the same way: `select display_number, seq_number, fy_label
--     into ... from app_private.next_voucher_number(a, b, c, d)`, four
--     positional arguments, three named output columns. That is what makes a
--     behaviour change here land in one place, and it is why this migration
--     keeps BOTH the four-argument call shape (via a defaulted fifth
--     argument) and the exact three-column return shape. Adding a fourth
--     output column would have been convenient for recording which series
--     minted a number — see scope_deferred in this migration's report — and
--     was deliberately not done, because it buys one report a column at the
--     cost of touching nine call sites this migration otherwise never has to
--     read.
--
--   * The number is `prefix || '/' || fy_label || '/' || lpad(n, padding)`,
--     where prefix is `branch_code || '/' || three_letter_type_code`. VERIFIED
--     against real data, not assumed: rebuilding that string for all 180
--     vouchers in the database that have a matching voucher_number_sequences
--     row produced 180 exact matches and ZERO mismatches. Every one of the 66
--     sequence rows has a prefix of exactly the shape `<branch code>/<3-letter
--     code>` (checked: no row has a third '/'-separated segment, and no row's
--     first segment differs from its own branch's code).
--
--   * prefix and padding are write-once in practice: 0007/0069/0113's
--     ON CONFLICT DO UPDATE clause only ever bumps next_number, so both are
--     frozen at the instant the first voucher of that type is raised in that
--     branch and FY, and no screen anywhere sets either.
--
-- ----------------------------------------------------------------------------
-- THE COMPLIANCE PROBLEM THIS EXISTS TO SOLVE
-- ----------------------------------------------------------------------------
-- CGST Rule 46(b) requires a tax invoice to carry "a consecutive serial
-- number not exceeding sixteen characters, in one or multiple series,
-- containing alphabets or numerals or special characters hyphen or dash and
-- slash symbolised as '-' and '/' respectively, and any combination thereof,
-- unique for a financial year."
--
-- LEKHA's generated number is HO/SAL/2026-27/00002. That is TWENTY
-- characters. Migration 0230 (e-invoice capture) already found this and said
-- so in its own header, but could only surface it as a warning on the
-- e-invoice screen, because there was no way for a company to change the
-- format — the fields that control it are frozen at first use and have no
-- UI. The NIC Invoice Registration Portal rejects a 17-character document
-- number outright, so today every LEKHA company that reaches the e-invoicing
-- turnover threshold is generating numbers the government will not accept,
-- with no remedy inside the app.
--
-- The fix is configurable prefix and padding. With them, the same company
-- sets SAL/{FYS}/ and padding 4 and gets SAL/26-27/0002 — FOURTEEN
-- characters, comfortably inside the cap, still consecutive, still unique
-- within the financial year, still a legal character set. Rule 46(b)'s own
-- "in one or multiple series" wording is also what makes the third mode
-- below lawful: a company may run several parallel series in one year.
--
-- ----------------------------------------------------------------------------
-- THE THREE MODES, AND WHY MANUAL IS NOT OFFERED EVERYWHERE
-- ----------------------------------------------------------------------------
-- automatic  one continuous counter per (branch, type, FY). Today's
--            behaviour exactly, and the default for every voucher type of
--            every company forever — absence of a voucher_numbering_settings
--            row MEANS automatic, so this migration inserts no settings rows
--            at all and none will ever be required.
--
-- manual     the preparer types the number. Offered ONLY on create_voucher
--            and create_invoice, the two entry points a human actually sits
--            in front of. The other seven callers mint numbers for documents
--            nobody hand-types — a forex revaluation journal, a production
--            stock journal, a job-work challan, a delivery challan, a stock
--            verification adjustment — so the four voucher types that ONLY
--            those callers ever produce (stock_journal, job_work_out,
--            job_work_in, delivery_challan_out) are barred from manual mode
--            by a table CHECK constraint, not merely by convention.
--
--            Note the asymmetry this creates and why it is correct: 'journal'
--            IS available for manual mode even though record_forex_
--            revaluation also posts journals, and 'receipt'/'payment' are
--            available even though record_forex_settlement posts those. Those
--            three functions call the four-argument next_voucher_number and
--            supply no number, so they keep getting an auto-generated one
--            whatever the mode says. Mode only ever decides whether a
--            SUPPLIED number is accepted; it never forces a caller to supply
--            one. Barring 'journal' from manual mode to protect forex
--            revaluation would have taken hand-numbering away from ordinary
--            journal entries for no gain.
--
-- series     several user-named series per voucher type, each with its own
--            prefix, padding and INDEPENDENT counter, picked at entry time.
--            Rule 46(b)'s "multiple series" case: an exporter running
--            EXP/26-27/0001 alongside domestic SAL/26-27/0001, a company
--            with a separate series per showroom.
--
-- Mechanically, automatic and series are the SAME engine: both draw from a
-- series row, and automatic is simply "there is exactly one series, called
-- Default, and no picker is shown." That is deliberate — it means there is
-- one numbering code path in this database, not two, and a company switching
-- from automatic to series does not restart or renumber anything.
--
-- ----------------------------------------------------------------------------
-- THE MIGRATION TRAP, HANDLED EXPLICITLY
-- ----------------------------------------------------------------------------
-- voucher_number_sequences' primary key must grow a series_id, because two
-- series on one voucher type need two independent counters. series_id CANNOT
-- be nullable: Postgres treats NULLs as DISTINCT in a unique constraint (the
-- default NULLS DISTINCT behaviour), so two "no series" rows for the same
-- company/branch/type/FY would BOTH be accepted, the ON CONFLICT clause would
-- match neither reliably, that counter would silently fork, and two vouchers
-- would be handed the same number. The unique constraint on public.vouchers
-- would then reject the second one at insert time — a hard failure in a
-- perfectly ordinary posting, with no obvious cause.
--
-- So this migration BACKFILLS a real Default series for every distinct
-- (company_id, voucher_type) that has any sequence row at all, carries that
-- group's existing prefix shape and padding across unchanged, points every
-- existing sequence row at it, and only THEN sets series_id NOT NULL. The
-- backfilled template is built from each group's OWN STORED prefix (its
-- second '/'-separated segment), not from re-deriving the type code from
-- today's CASE expression — so if any historical row ever got a code today's
-- code would not produce, it is preserved rather than silently rewritten.
-- Guarded by a pre-flight assertion that every group has exactly one such
-- code and exactly one padding (verified live: zero groups violate either).
--
-- next_number is never touched. Every counter continues exactly where it
-- left off; the very next voucher of every type in every company gets the
-- same number it would have got had this migration never run.
--
-- ----------------------------------------------------------------------------
-- WHY voucher_number_sequences.prefix IS NOT REPURPOSED, AND resolved_prefix
-- EXISTS INSTEAD — A REAL REGRESSION CAUGHT BEFORE WRITING, NOT AFTER
-- ----------------------------------------------------------------------------
-- The obvious design is to let prefix hold the fully resolved leading text
-- ('HO/SAL/2026-27/') now that the series owns the template. That would have
-- broken a shipped screen. get_gstr1_table13 (0094) returns vns.prefix as
-- its series_prefix column, and app/(app)/[companyId]/reports/gstr1-summary/
-- page.tsx line 676 renders it as `{r.series_prefix}/{r.financial_year_label}`
-- — it appends the FY itself. Repurposing prefix would have made GSTR-1
-- Table 13 read 'HO/SAL/2026-27//2026-27' on a statutory report.
--
-- So prefix keeps its exact present meaning — branch code, slash, type code —
-- forever, and a NEW column resolved_prefix carries the literal text that
-- actually precedes the counter for numbers minted from that row. Backfilled
-- to prefix || '/' || financial_year_label || '/', which is byte-identical to
-- what every existing row has in fact been producing (proven by the 180/180
-- rebuild above). padding continues to live on the row as well, but is now a
-- MIRROR of the series' padding refreshed on every draw rather than a
-- write-once value — which is what unfreezes it.
--
-- What this migration deliberately does NOT fix, and the report says so
-- plainly: get_gstr1_table13 joins one row per SEQUENCE row and reports
-- serial_from/serial_to from a vouchers aggregate that is not split by
-- series. The moment a company creates a second series on 'sales' or
-- 'credit_note', Table 13 will emit two rows carrying the same aggregate.
-- Nothing changes today (every company has exactly one series after this
-- backfill) and that function is owned by another agent this session, so it
-- is flagged with its fix rather than edited here.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT SOLVE
-- ----------------------------------------------------------------------------
--   * It does not record WHICH series minted a given voucher. vouchers gains
--     no column. Deriving it after the fact from resolved_prefix is possible
--     (voucher_number LIKE resolved_prefix || '%') and is what the Table 13
--     fix above would use, but a stored FK would be better and is left for a
--     session that can afford to touch all nine call sites.
--   * It does not renumber, revalidate or migrate any existing voucher.
--     Numbers already issued stay exactly as issued, including the 20-
--     character ones. Rule 46(b) applies to the number at issue; retro-
--     rewriting issued invoice numbers would be far worse than leaving them.
--   * It does not BLOCK a series whose preview exceeds sixteen characters.
--     Rule 46(b) binds tax invoices under GST; a company outside GST, or one
--     numbering internal journals, has no such cap. The read RPC returns the
--     preview, its character count and a rule46b_ok flag so the settings
--     screen can flag it loudly — which is the instruction — rather than
--     refusing a configuration the law may not actually forbid for them.
--   * It does not make manual mode branch- or user-specific, and does not
--     reserve or gap-check manually typed numbers. GST's "consecutive"
--     requirement is the preparer's responsibility once they take the pen;
--     duplicates are still refused (see below), gaps are not.
--   * It builds no UI. A follow-on agent owns the settings screen.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. Pre-flight. The backfill below collapses every sequence row of a
--    (company, voucher_type) onto ONE series, so that group must agree on
--    both the type code embedded in its prefix and its padding, and every
--    prefix must be exactly `<branch code>/<code>` for {BRANCH} to reproduce
--    it. All three hold today (checked live: zero violations). Asserting
--    rather than assuming means a database this migration is replayed against
--    later fails loudly instead of silently renumbering someone's invoices.
-- ----------------------------------------------------------------------------
do $$
declare
  v_bad int;
begin
  select count(*) into v_bad from (
    select company_id, voucher_type
      from public.voucher_number_sequences
     group by company_id, voucher_type
    having count(distinct split_part(prefix, '/', 2)) > 1
        or count(distinct padding) > 1
  ) x;
  if v_bad > 0 then
    raise exception '0725 pre-flight: % (company, voucher_type) group(s) disagree on type code or padding; a single Default series cannot represent them', v_bad;
  end if;

  select count(*) into v_bad
    from public.voucher_number_sequences s
    join public.branches b on b.id = s.branch_id and b.company_id = s.company_id
   where s.prefix is distinct from (b.code || '/' || split_part(s.prefix, '/', 2))
      or split_part(s.prefix, '/', 3) <> '';
  if v_bad > 0 then
    raise exception '0725 pre-flight: % sequence row(s) have a prefix that is not exactly <branch code>/<type code>', v_bad;
  end if;
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. Small pure helpers. voucher_type_code is the SINGLE definition of the
--    three-letter code that has been copy-pasted into next_voucher_number
--    three times (0007, 0069, 0113); everything downstream now reads it here.
-- ----------------------------------------------------------------------------
create or replace function app_private.voucher_type_code(p_voucher_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_voucher_type
    when 'receipt'              then 'REC'
    when 'payment'              then 'PAY'
    when 'contra'               then 'CON'
    when 'journal'              then 'JRN'
    when 'sales'                then 'SAL'
    when 'purchase'             then 'PUR'
    when 'credit_note'          then 'CRN'
    when 'debit_note'           then 'DBN'
    when 'branch_transfer'      then 'BTR'
    when 'stock_journal'        then 'STK'
    when 'job_work_out'         then 'JWO'
    when 'job_work_in'          then 'JWI'
    when 'delivery_challan_out' then 'DCH'
    else upper(left(p_voucher_type, 3))
  end;
$$;

comment on function app_private.voucher_type_code(text) is
  'The three-letter document code used in generated voucher numbers. Lifted verbatim out of next_voucher_number (0007/0069/0113) so it has exactly one definition. See 0725.';

-- The prefix stored on a series is a TEMPLATE, not a literal, because the
-- branch code and the financial year are not known until a number is drawn
-- and the FY changes underneath the same series every 1 April. Five tokens,
-- all resolvable from the branch code and the FY label alone:
--   {BRANCH} HO        {FY} 2026-27   {FYS} 26-27   {YYYY} 2026   {YY} 26
-- {FYS} is replaced before {FY} on purpose: replacing {FY} first would turn
-- '{FYS}' into '2026-27S}'.
create or replace function app_private.resolve_number_prefix(
  p_prefix text, p_branch_code text, p_fy_label text
) returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(replace(replace(
           coalesce(p_prefix, ''),
           '{BRANCH}', coalesce(p_branch_code, '')),
           '{FYS}',    substr(coalesce(p_fy_label, ''), 3)),
           '{FY}',     coalesce(p_fy_label, '')),
           '{YYYY}',   left(coalesce(p_fy_label, ''), 4)),
           '{YY}',     substr(coalesce(p_fy_label, ''), 3, 2));
$$;

comment on function app_private.resolve_number_prefix(text, text, text) is
  'Expands a voucher_number_series prefix template ({BRANCH}, {FY}, {FYS}, {YYYY}, {YY}) into the literal text that precedes the padded counter. See 0725.';

-- CGST Rule 46(b): at most sixteen characters, letters/digits/hyphen/slash.
create or replace function app_private.is_rule46b_number(p_number text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_number is not null
     and length(p_number) between 1 and 16
     and p_number ~ '^[A-Za-z0-9/-]+$';
$$;

comment on function app_private.is_rule46b_number(text) is
  'True when a document number satisfies CGST Rule 46(b): 1-16 characters, only letters, digits, hyphen and slash. See 0725.';

create or replace function app_private.assert_rule46b_number(p_number text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := btrim(coalesce(p_number, ''));
begin
  if v = '' then
    raise exception 'A voucher number is required when this voucher type is set to manual numbering';
  end if;
  if length(v) > 16 then
    raise exception 'Voucher number "%" is % characters long. CGST Rule 46(b) allows at most 16.', v, length(v);
  end if;
  if v !~ '^[A-Za-z0-9/-]+$' then
    raise exception 'Voucher number "%" contains a character CGST Rule 46(b) does not allow. Use only letters, digits, hyphen (-) and slash (/).', v;
  end if;
  return v;
end;
$$;

comment on function app_private.assert_rule46b_number(text) is
  'Trims and validates a hand-typed voucher number against CGST Rule 46(b), raising a message written for the preparer rather than returning a boolean. See 0725.';


-- ----------------------------------------------------------------------------
-- 2. voucher_number_series — the named series, its template and its padding.
--    Scoped to (company, voucher_type); the per-branch, per-FY COUNTER stays
--    on voucher_number_sequences, so one series legitimately owns several
--    counters (one per branch and financial year) exactly as GST expects.
-- ----------------------------------------------------------------------------
create table public.voucher_number_series (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  voucher_type text not null,
  name text not null,
  -- Template, not a literal. The CHECK admits only characters CGST Rule
  -- 46(b) permits, plus the five known tokens — so a resolved prefix can
  -- only ever fail Rule 46(b) on LENGTH, never on character set, and the
  -- settings screen's only job is to watch the character count.
  prefix text not null,
  padding smallint not null default 5,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  unique (company_id, voucher_type, name),
  constraint voucher_number_series_type_check check (voucher_type = any (array[
    'receipt','payment','contra','journal','sales','purchase',
    'credit_note','debit_note','branch_transfer','stock_journal',
    'job_work_out','job_work_in','delivery_challan_out'])),
  constraint voucher_number_series_name_check
    check (length(btrim(name)) between 1 and 40),
  constraint voucher_number_series_prefix_check
    check (prefix ~ '^([A-Za-z0-9/-]|\{(BRANCH|FY|FYS|YY|YYYY)\})*$' and length(prefix) <= 40),
  constraint voucher_number_series_padding_check check (padding between 1 and 9)
);

-- At most one default per (company, voucher_type). A partial unique index is
-- the only construct that expresses this — a plain unique constraint would
-- also forbid two non-default series, which is the entire point of the mode.
create unique index voucher_number_series_one_default
  on public.voucher_number_series (company_id, voucher_type)
  where is_default;

create index voucher_number_series_company_type_idx
  on public.voucher_number_series (company_id, voucher_type);

create trigger set_updated_at before update on public.voucher_number_series
  for each row execute function app_private.set_updated_at();

alter table public.voucher_number_series enable row level security;

create policy voucher_number_series_read on public.voucher_number_series
  for select to authenticated using ((select app_private.is_company_member(company_id)));
-- Admin-gated, not can_write_company: this is configuration that silently
-- changes the number printed on every future tax invoice, which is not the
-- same kind of act as posting one. An accountant posts; an admin decides the
-- numbering policy. The RPCs below carry the same gate and additionally do
-- the cross-row bookkeeping (demoting the previous default, refusing to
-- strand a voucher type with no default) that a raw table write would skip.
create policy voucher_number_series_write on public.voucher_number_series
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

comment on table public.voucher_number_series is
  'A named voucher-number series: its prefix TEMPLATE, its zero-padding width and whether it is the default for its voucher type. One per voucher type in automatic mode (always called Default); several in series mode, which CGST Rule 46(b) expressly permits ("in one or multiple series"). The counters themselves live on voucher_number_sequences, one per branch and financial year. See 0725.';
comment on column public.voucher_number_series.prefix is
  'Template for the literal text preceding the padded counter. Tokens: {BRANCH} branch code, {FY} 2026-27, {FYS} 26-27, {YYYY} 2026, {YY} 26. Resolved by app_private.resolve_number_prefix at the moment a number is drawn, so the financial year rolls over inside the same series. See 0725.';
comment on column public.voucher_number_series.is_default is
  'The series used when a caller draws a number without naming one — which every one of the nine internal callers does. Exactly one per (company, voucher_type), enforced by the voucher_number_series_one_default partial unique index. See 0725.';


-- ----------------------------------------------------------------------------
-- 3. voucher_numbering_settings — the mode, one row per configured type.
--    ABSENCE OF A ROW MEANS AUTOMATIC. No row is inserted by this migration
--    and none is ever required, so no company pays a per-type row cost for a
--    setting it never changed.
-- ----------------------------------------------------------------------------
create table public.voucher_numbering_settings (
  company_id uuid not null references public.companies(id) on delete cascade,
  voucher_type text not null,
  mode text not null default 'automatic',
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, voucher_type),
  constraint voucher_numbering_settings_type_check check (voucher_type = any (array[
    'receipt','payment','contra','journal','sales','purchase',
    'credit_note','debit_note','branch_transfer','stock_journal',
    'job_work_out','job_work_in','delivery_challan_out'])),
  constraint voucher_numbering_settings_mode_check
    check (mode = any (array['automatic','manual','series'])),
  -- The system-generated four. Nobody hand-types a production stock journal
  -- or a job-work challan, and the functions that raise them supply no
  -- number, so manual mode on these types could only ever be a setting that
  -- does nothing while implying it does something. Enforced here rather than
  -- only in the RPC so a direct table write cannot create the misleading row.
  constraint voucher_numbering_settings_manual_is_user_entered_only
    check (mode <> 'manual' or voucher_type = any (array[
      'receipt','payment','contra','journal','sales','purchase',
      'credit_note','debit_note','branch_transfer']))
);

create trigger set_updated_at before update on public.voucher_numbering_settings
  for each row execute function app_private.set_updated_at();

alter table public.voucher_numbering_settings enable row level security;

create policy voucher_numbering_settings_read on public.voucher_numbering_settings
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy voucher_numbering_settings_write on public.voucher_numbering_settings
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

comment on table public.voucher_numbering_settings is
  'Numbering mode per voucher type. A MISSING ROW MEANS automatic — the default for every type of every company — so this table stays empty until someone deliberately changes something. manual is constrained to the nine user-entered types; the four system-generated ones (stock_journal, job_work_out, job_work_in, delivery_challan_out) can only ever be automatic or series. See 0725.';

create or replace function app_private.voucher_numbering_mode(
  p_company_id uuid, p_voucher_type text
) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.mode from public.voucher_numbering_settings s
      where s.company_id = p_company_id and s.voucher_type = p_voucher_type),
    'automatic');
$$;

comment on function app_private.voucher_numbering_mode(uuid, text) is
  'The effective numbering mode for a voucher type, resolving a missing settings row to automatic. SECURITY DEFINER so the SECURITY INVOKER create_voucher/create_invoice can consult it without needing a table grant. See 0725.';


-- ----------------------------------------------------------------------------
-- 4. voucher_number_sequences gains series_id — the trap this migration is
--    mostly about. Order matters: add nullable, backfill a real Default
--    series for every existing group, point every row at it, prove nothing
--    is left null, THEN set NOT NULL and move the primary key.
-- ----------------------------------------------------------------------------
alter table public.voucher_number_sequences
  add column series_id uuid,
  -- The literal text that precedes the counter for numbers minted from this
  -- row. NOT a repurposing of prefix — see the header for the GSTR-1 Table 13
  -- regression that would have caused.
  add column resolved_prefix text;

-- 4a. One Default series per (company, voucher_type) that has any history,
--     built from that group's OWN stored prefix and padding.
insert into public.voucher_number_series
  (company_id, voucher_type, name, prefix, padding, is_default, is_active)
select s.company_id,
       s.voucher_type,
       'Default',
       '{BRANCH}/' || min(split_part(s.prefix, '/', 2)) || '/{FY}/',
       min(s.padding),
       true,
       true
  from public.voucher_number_sequences s
 group by s.company_id, s.voucher_type;

-- 4b. Point every existing counter at it, and record the prefix it has in
--     fact been producing all along.
update public.voucher_number_sequences s
   set series_id = x.id,
       resolved_prefix = s.prefix || '/' || s.financial_year_label || '/'
  from public.voucher_number_series x
 where x.company_id = s.company_id
   and x.voucher_type = s.voucher_type
   and x.name = 'Default';

-- 4c. Prove it before locking it in.
do $$
declare
  v_orphans int;
begin
  select count(*) into v_orphans
    from public.voucher_number_sequences
   where series_id is null or resolved_prefix is null;
  if v_orphans > 0 then
    raise exception '0725 backfill: % voucher_number_sequences row(s) still have no series', v_orphans;
  end if;
end;
$$;

alter table public.voucher_number_sequences
  alter column series_id set not null,
  alter column resolved_prefix set not null;

alter table public.voucher_number_sequences
  drop constraint voucher_number_sequences_pkey;

alter table public.voucher_number_sequences
  add constraint voucher_number_sequences_pkey
    primary key (company_id, branch_id, voucher_type, financial_year_label, series_id);

-- Composite, per this codebase's standing tenancy rule: a bare id FK would
-- let a counter for company A point at a series belonging to company B.
alter table public.voucher_number_sequences
  add constraint voucher_number_sequences_series_fk
    foreign key (series_id, company_id)
    references public.voucher_number_series (id, company_id) on delete cascade;

comment on column public.voucher_number_sequences.series_id is
  'The series this counter belongs to. NOT NULL by design: a nullable series_id inside the primary key would let two "no series" rows coexist (Postgres treats NULLs as distinct in a unique key), forking the counter and handing out duplicate numbers. See 0725.';
comment on column public.voucher_number_sequences.prefix is
  'LEGACY, deliberately unchanged in meaning: branch code, slash, three-letter type code. Still read by get_gstr1_table13 (0094) and rendered by the GSTR-1 summary screen, which appends the financial year itself. The text actually used when minting a number is resolved_prefix. See 0725.';
comment on column public.voucher_number_sequences.resolved_prefix is
  'The literal text preceding the padded counter for numbers minted from this row, i.e. this row''s series prefix template with {BRANCH}/{FY}/... expanded. Refreshed on every draw, so editing the series takes effect from the next number. See 0725.';
comment on column public.voucher_number_sequences.padding is
  'Mirror of the owning series'' padding, refreshed on every draw. Was write-once before 0725 (the ON CONFLICT clause only ever bumped next_number), which is exactly why no company could shorten a Rule 46(b)-violating number.';


-- ----------------------------------------------------------------------------
-- 5. next_voucher_number, series-aware. DROP then CREATE, not CREATE OR
--    REPLACE: adding a fifth parameter to a function is an OVERLOAD, not a
--    replacement, and the nine existing four-argument call sites would have
--    gone on resolving to the old body forever — an exact-arity match beats a
--    defaulted one. Dropping first is what makes the defaulted fifth argument
--    actually reach them. The three output columns are unchanged for the same
--    reason: every caller selects them by name.
-- ----------------------------------------------------------------------------
drop function if exists app_private.next_voucher_number(uuid, uuid, text, date);

create function app_private.next_voucher_number(
  p_company_id uuid,
  p_branch_id uuid,
  p_voucher_type text,
  p_voucher_date date,
  p_series_id uuid default null
) returns table(display_number text, seq_number integer, fy_label text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fy_start_month smallint;
  v_fy_label text;
  v_branch_code text;
  v_series_id uuid;
  v_template text;
  v_padding smallint;
  v_resolved text;
  v_number int;
  v_mode text;
begin
  select financial_year_start_month into v_fy_start_month
    from public.companies where id = p_company_id;
  if v_fy_start_month is null then raise exception 'Company not found'; end if;

  select code into v_branch_code
    from public.branches where id = p_branch_id and company_id = p_company_id;
  if v_branch_code is null then raise exception 'Branch not found in this company'; end if;

  v_fy_label := app_private.fy_label(p_voucher_date, v_fy_start_month);

  if p_series_id is not null then
    -- Naming a series is only meaningful in series mode. Silently honouring
    -- it in automatic mode would let a UI bug quietly split a company's
    -- supposedly continuous GST series in two.
    v_mode := app_private.voucher_numbering_mode(p_company_id, p_voucher_type);
    if v_mode <> 'series' then
      raise exception 'Numbering for % is set to "%", so a numbering series cannot be chosen. Switch that voucher type to series mode first.',
        p_voucher_type, v_mode;
    end if;

    select x.id, x.prefix, x.padding into v_series_id, v_template, v_padding
      from public.voucher_number_series x
     where x.id = p_series_id
       and x.company_id = p_company_id
       and x.voucher_type = p_voucher_type
       and x.is_active;
    if v_series_id is null then
      raise exception 'Numbering series % is not an active series for % in this company', p_series_id, p_voucher_type;
    end if;
  else
    select x.id, x.prefix, x.padding into v_series_id, v_template, v_padding
      from public.voucher_number_series x
     where x.company_id = p_company_id
       and x.voucher_type = p_voucher_type
       and x.is_default
       and x.is_active;

    -- Auto-provision on first use. A company that has never raised this
    -- voucher type has no series row, and demanding one before the first
    -- voucher can be posted would make this migration a breaking change for
    -- every company in the database. The template built here is exactly the
    -- pre-0725 format, so a company that never opens the settings screen
    -- keeps the numbers it has always had.
    if v_series_id is null then
      insert into public.voucher_number_series
        (company_id, voucher_type, name, prefix, padding, is_default, is_active)
      values (p_company_id, p_voucher_type, 'Default',
              '{BRANCH}/' || app_private.voucher_type_code(p_voucher_type) || '/{FY}/',
              5, true, true)
      on conflict do nothing;

      -- Re-read rather than RETURNING: under a concurrent first post the
      -- insert above legitimately does nothing, and the row we want is the
      -- one the other transaction created.
      select x.id, x.prefix, x.padding into v_series_id, v_template, v_padding
        from public.voucher_number_series x
       where x.company_id = p_company_id
         and x.voucher_type = p_voucher_type
         and x.is_default
         and x.is_active;

      if v_series_id is null then
        raise exception 'No active default numbering series for % in this company, and one could not be created', p_voucher_type;
      end if;
    end if;
  end if;

  v_resolved := app_private.resolve_number_prefix(v_template, v_branch_code, v_fy_label);

  insert into public.voucher_number_sequences
    (company_id, branch_id, voucher_type, financial_year_label, series_id,
     prefix, resolved_prefix, next_number, padding)
  values
    (p_company_id, p_branch_id, p_voucher_type, v_fy_label, v_series_id,
     v_branch_code || '/' || app_private.voucher_type_code(p_voucher_type),
     v_resolved, 2, v_padding)
  on conflict (company_id, branch_id, voucher_type, financial_year_label, series_id)
  do update set next_number = public.voucher_number_sequences.next_number + 1,
                -- Refreshed every draw so an edited series takes effect from
                -- the next number rather than staying frozen at first use,
                -- which is the defect this whole migration exists to fix.
                resolved_prefix = excluded.resolved_prefix,
                padding = excluded.padding
  returning (next_number - 1), padding into v_number, v_padding;

  return query select
    (v_resolved || lpad(v_number::text, v_padding, '0')),
    v_number,
    v_fy_label;
end;
$$;

comment on function app_private.next_voucher_number(uuid, uuid, text, date, uuid) is
  'Mints the next voucher number. Four-argument calls (all nine internal callers) draw from the voucher type''s default series, auto-provisioning it on first use with the pre-0725 format so nothing renumbers. A fifth argument names an explicit series and is only accepted in series mode. See 0725.';


-- ----------------------------------------------------------------------------
-- 6. The manual counterpart. Written as a sibling of next_voucher_number with
--    the SAME three-column return shape, so create_voucher and create_invoice
--    each change by exactly one if/else and nothing else — no duplicated
--    validation, no drift between the two entry points.
--
--    SECURITY DEFINER for a specific reason: the duplicate check must see
--    SOFT-DELETED vouchers, because the unique constraint on public.vouchers
--    counts them and RLS-filtered reads may not. A friendly refusal that
--    misses a cancelled invoice's number would just be a raw constraint error
--    one line later.
-- ----------------------------------------------------------------------------
create or replace function app_private.resolve_manual_voucher_number(
  p_company_id uuid,
  p_branch_id uuid,
  p_voucher_type text,
  p_voucher_date date,
  p_voucher_number text
) returns table(display_number text, seq_number integer, fy_label text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fy_start_month smallint;
  v_fy_label text;
  v_branch_code text;
  v_mode text;
  v_number text;
  v_seq int;
begin
  v_mode := app_private.voucher_numbering_mode(p_company_id, p_voucher_type);
  if v_mode <> 'manual' then
    raise exception 'Numbering for % is set to "%", so a voucher number cannot be supplied. Switch that voucher type to manual numbering first, or leave the number blank.',
      p_voucher_type, v_mode;
  end if;

  v_number := app_private.assert_rule46b_number(p_voucher_number);

  select financial_year_start_month into v_fy_start_month
    from public.companies where id = p_company_id;
  if v_fy_start_month is null then raise exception 'Company not found'; end if;

  select code into v_branch_code
    from public.branches where id = p_branch_id and company_id = p_company_id;
  if v_branch_code is null then raise exception 'Branch not found in this company'; end if;

  v_fy_label := app_private.fy_label(p_voucher_date, v_fy_start_month);

  if exists (
    select 1 from public.vouchers v
     where v.company_id = p_company_id
       and v.branch_id = p_branch_id
       and v.voucher_type = p_voucher_type
       and v.financial_year_label = v_fy_label
       and v.voucher_number = v_number
  ) then
    raise exception 'Voucher number % is already used for a % in % at this branch. Every number must be unique within the financial year.',
      v_number, p_voucher_type, v_fy_label;
  end if;

  -- sequence_number is LEKHA's internal ordering aid, not the printed
  -- number; in manual mode it makes no claim to match the digits the
  -- preparer typed (which may not end in digits at all). Continuing the
  -- branch's own count keeps GSTR-1 Table 13's serial_from/serial_to
  -- monotonic. No unique constraint exists on it, so the narrow race between
  -- two simultaneous manual posts costs a repeated ordering value, not a
  -- failed insert.
  select coalesce(max(v.sequence_number), 0) + 1 into v_seq
    from public.vouchers v
   where v.company_id = p_company_id
     and v.branch_id = p_branch_id
     and v.voucher_type = p_voucher_type
     and v.financial_year_label = v_fy_label;

  return query select v_number, v_seq, v_fy_label;
end;
$$;

comment on function app_private.resolve_manual_voucher_number(uuid, uuid, text, date, text) is
  'Validates a hand-typed voucher number (mode must be manual, CGST Rule 46(b) character set and 16-character cap, not already used in the branch and financial year) and returns it in next_voucher_number''s exact shape. Draws no counter. See 0725.';


-- ----------------------------------------------------------------------------
-- 7. create_voucher — two new trailing arguments, one new if/else. Everything
--    else is byte-for-byte the pre-0725 body. DROP first: the invariants
--    suite already asserts create_invoice has exactly ONE signature (the
--    ambiguous-overload trap 0065 hit), and the same hazard applies here.
-- ----------------------------------------------------------------------------
drop function if exists public.create_voucher(uuid, uuid, text, date, jsonb, text, text, date, uuid, bpchar, numeric, text);

create function public.create_voucher(
  p_company_id uuid,
  p_branch_id uuid,
  p_voucher_type text,
  p_voucher_date date,
  p_lines jsonb,
  p_narration text default null,
  p_reference_number text default null,
  p_reference_date date default null,
  p_party_ledger_id uuid default null,
  p_txn_currency bpchar default 'INR',
  p_exchange_rate numeric default 1,
  p_rate_source text default null,
  p_voucher_number text default null,
  p_number_series_id uuid default null
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_voucher_id uuid; v_display_number text; v_seq_number int; v_fy_label text; v_line jsonb;
begin
  if p_voucher_number is not null then
    select display_number, seq_number, fy_label into v_display_number, v_seq_number, v_fy_label
      from app_private.resolve_manual_voucher_number(
        p_company_id, p_branch_id, p_voucher_type, p_voucher_date, p_voucher_number);
  else
    select display_number, seq_number, fy_label into v_display_number, v_seq_number, v_fy_label
      from app_private.next_voucher_number(
        p_company_id, p_branch_id, p_voucher_type, p_voucher_date, p_number_series_id);
  end if;

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, reference_number,
    reference_date, party_ledger_id, txn_currency, exchange_rate, rate_source, created_by)
  values (
    p_company_id, p_branch_id, p_voucher_type, v_display_number, v_seq_number,
    v_fy_label, p_voucher_date, p_narration, p_reference_number,
    p_reference_date, p_party_ledger_id, p_txn_currency, p_exchange_rate, p_rate_source, auth.uid())
  returning id into v_voucher_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id,
      debit_amount, credit_amount, fc_amount, dimensions, narration, line_order)
    values (
      v_voucher_id, p_company_id,
      coalesce((v_line->>'branch_id')::uuid, p_branch_id),
      (v_line->>'ledger_id')::uuid,
      coalesce((v_line->>'debit_amount')::numeric, 0),
      coalesce((v_line->>'credit_amount')::numeric, 0),
      (v_line->>'fc_amount')::numeric,
      coalesce(v_line->'dimensions', '{}'::jsonb),
      v_line->>'narration',
      coalesce((v_line->>'line_order')::int, 0));
  end loop;

  return v_voucher_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 8. create_invoice — same two trailing arguments, same single if/else. The
--    rest of the body is reproduced verbatim from the live definition read
--    with pg_get_functiondef immediately before this file was written, so
--    0147 line discounts, 0087 zero-rating, 0102 RCM and 0027 TCS all survive
--    untouched. DROP first for the same overload reason as create_voucher,
--    and because the invariants suite asserts create_invoice has exactly one
--    signature.
-- ----------------------------------------------------------------------------
drop function if exists public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, bpchar, bpchar, numeric, text);

create function public.create_invoice(
  p_company_id uuid,
  p_branch_id uuid,
  p_voucher_type text,
  p_voucher_date date,
  p_party_ledger_id uuid,
  p_trading_ledger_id uuid,
  p_godown_id uuid,
  p_items jsonb,
  p_narration text default null,
  p_reference_number text default null,
  p_reference_date date default null,
  p_place_of_supply bpchar default null,
  p_txn_currency bpchar default 'INR',
  p_exchange_rate numeric default 1,
  p_rate_source text default null,
  p_voucher_number text default null,
  p_number_series_id uuid default null
) returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_voucher_id uuid;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_item jsonb;
  v_qty numeric;
  v_rate numeric;
  v_gst_rate numeric;
  v_cess_rate numeric;
  v_amount numeric;
  v_gross_amount numeric;
  v_discount_percent numeric;
  v_discount_amount numeric;
  v_taxable_total numeric := 0;
  v_direction text;
  v_party_side text;
  v_line_no int := 0;
  v_uom text;
  v_hsn text;

  v_gst_on boolean;
  v_registration_id uuid;
  v_supplier_state char(2);
  v_supply_type text;
  v_party_reg_type text;
  v_lut_active boolean;
  v_intrastate boolean;
  v_tax_prefix text;
  v_line_cgst numeric; v_line_sgst numeric; v_line_igst numeric; v_line_cess numeric;
  v_cgst_total numeric := 0; v_sgst_total numeric := 0; v_igst_total numeric := 0; v_cess_total numeric := 0;
  v_grand_total numeric;
  v_ledger uuid;
  v_entry_line int;

  v_tcs_on boolean;
  v_party_pan text;
  v_tcs_section text;
  v_tcs_rate numeric;
  v_tcs_no_pan_rate numeric;
  v_tcs_threshold numeric;
  v_line_gst_total numeric;
  v_line_tcs numeric;
  v_tcs_total numeric := 0;

  -- Sec 9(3)/9(4) reverse charge (0102). v_rcm_tax_total is the
  -- self-assessed tax the RECIPIENT owes the government on notified
  -- inward supplies — never charged by the supplier, so it never touches
  -- v_grand_total (what the party is owed) or the normal input_cgst/
  -- input_sgst/input_igst accumulators (those represent tax the SUPPLIER
  -- charged and that is available for immediate set-off; RCM tax is
  -- neither). See migration header for why the matching debit lands on
  -- the trading ledger rather than an Input GST ledger.
  v_is_rcm_applicable boolean;
  v_line_rcm numeric;
  v_rcm_tax_total numeric := 0;
  v_rcm_ledger uuid;
begin
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'An invoice needs at least one item line';
  end if;

  case p_voucher_type
    when 'sales'       then v_direction := 'out'; v_party_side := 'debit';  v_tax_prefix := 'output';
    when 'purchase'    then v_direction := 'in';  v_party_side := 'credit'; v_tax_prefix := 'input';
    when 'credit_note' then v_direction := 'in';  v_party_side := 'credit'; v_tax_prefix := 'output';
    when 'debit_note'  then v_direction := 'out'; v_party_side := 'debit';  v_tax_prefix := 'input';
    else raise exception '% is not an invoice type', p_voucher_type;
  end case;

  v_gst_on := app_private.module_active(p_company_id, 'gst', p_voucher_date);
  v_tcs_on := v_tax_prefix = 'output' and app_private.module_active(p_company_id, 'tcs', p_voucher_date);

  if v_gst_on then
    v_registration_id := app_private.branch_registration(p_branch_id, p_voucher_date);
    if v_registration_id is null then
      raise exception 'GST is active for this company but branch % has no GST registration attached for %. Attach one before invoicing from it.',
        p_branch_id, p_voucher_date;
    end if;

    select state_code,
           lut_number is not null
             and p_voucher_date >= lut_valid_from
             and (lut_valid_to is null or p_voucher_date <= lut_valid_to)
      into v_supplier_state, v_lut_active
      from public.gst_registrations where id = v_registration_id;

    select gst_registration_type into v_party_reg_type
      from public.ledgers where id = p_party_ledger_id;

    if p_place_of_supply is null then
      select state_code into p_place_of_supply
        from public.ledgers where id = p_party_ledger_id;

      if p_place_of_supply is null then
        raise exception 'Cannot determine place of supply: % has no state on file and none was given', p_party_ledger_id;
      end if;
    end if;

    v_supply_type := app_private.gst_supply_type(v_supplier_state, p_place_of_supply, v_party_reg_type, v_lut_active);
    v_intrastate := v_supplier_state = p_place_of_supply;
  end if;

  if v_tcs_on then
    select pan into v_party_pan from public.ledgers where id = p_party_ledger_id;
  end if;

  -- 0725: the ONLY change to this functions body. Everything above and
  -- below is byte-for-byte what create_invoice did before, including every
  -- GST, RCM and TCS branch, which this migration deliberately does not read
  -- past to avoid.
  if p_voucher_number is not null then
    select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
      from app_private.resolve_manual_voucher_number(
        p_company_id, p_branch_id, p_voucher_type, p_voucher_date, p_voucher_number);
  else
    select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
      from app_private.next_voucher_number(
        p_company_id, p_branch_id, p_voucher_type, p_voucher_date, p_number_series_id);
  end if;

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, reference_number,
    reference_date, party_ledger_id, place_of_supply, supply_type,
    txn_currency, exchange_rate, rate_source, created_by)
  values (
    p_company_id, p_branch_id, p_voucher_type, v_display_number, v_seq,
    v_fy, p_voucher_date, p_narration, p_reference_number,
    p_reference_date, p_party_ledger_id, p_place_of_supply, v_supply_type,
    p_txn_currency, p_exchange_rate, p_rate_source, auth.uid())
  returning id into v_voucher_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty  := (v_item->>'quantity')::numeric;
    v_rate := (v_item->>'rate')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every item line needs a quantity greater than zero';
    end if;

    -- Sec 15(3)(a) / Rule 46(k): taxable value is NET of any discount
    -- recorded on this invoice. Absent from p_items (every caller before
    -- this migration's own UI change, and every other create_invoice
    -- caller that has not been taught about discounts) this resolves to
    -- exactly 0, so v_amount = v_gross_amount unchanged — byte-identical
    -- to the pre-0147 formula. See migration header.
    v_discount_percent := coalesce((v_item->>'discount_percent')::numeric, 0);
    if v_discount_percent < 0 or v_discount_percent > 100 then
      raise exception 'Discount percent must be between 0 and 100, got % for item %',
        v_discount_percent, v_item->>'item_id';
    end if;

    v_gross_amount := round(v_qty * coalesce(v_rate, 0), 2);
    v_discount_amount := round(v_gross_amount * v_discount_percent / 100, 2);
    v_amount := v_gross_amount - v_discount_amount;
    v_taxable_total := v_taxable_total + v_amount;

    select uom, hsn_sac, gst_rate_percent, cess_rate_percent, default_tcs_section, is_rcm_applicable
      into v_uom, v_hsn, v_gst_rate, v_cess_rate, v_tcs_section, v_is_rcm_applicable
      from public.items where id = (v_item->>'item_id')::uuid;

    insert into public.voucher_items (
      voucher_id, company_id, branch_id, godown_id, item_id,
      direction, quantity, uom, rate, amount, discount_percent, hsn_sac, description, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, p_godown_id,
      (v_item->>'item_id')::uuid,
      v_direction, v_qty, coalesce(v_uom, 'NOS'), coalesce(v_rate, 0), v_amount, v_discount_percent,
      v_hsn, v_item->>'description', v_line_no);

    v_line_cgst := 0; v_line_sgst := 0; v_line_igst := 0; v_line_cess := 0;

    if v_gst_on then
      -- RCM (0102): only on purchases, only lines the item master flags as
      -- notified under Sec 9(3) (or the narrow Sec 9(4) real-estate-
      -- promoter case a preparer represents the same way — see header).
      -- MUTUALLY EXCLUSIVE with the ordinary tax branch below, not
      -- additional to it: under reverse charge the SUPPLIER charges no
      -- tax at all — that is the entire premise of RCM — so v_line_cgst/
      -- sgst/igst/cess stay at the zero they were just set to. Getting
      -- this wrong (computing both) would double the tax: once funded by
      -- the party via v_grand_total as if the supplier had charged it,
      -- and again self-assessed via rcm_payable below. Computed straight
      -- from the item's own rate, deliberately NOT routed through the
      -- export/SEZ zero-rating branch: that branch answers "is OUR
      -- outward supply zero-rated", a question about sales with no
      -- bearing on a self-assessed inward-supply liability.
      if p_voucher_type = 'purchase' and coalesce(v_is_rcm_applicable, false) then
        v_line_rcm := round(v_amount * (coalesce(v_gst_rate, 0) + coalesce(v_cess_rate, 0)) / 100, 2);
        v_rcm_tax_total := v_rcm_tax_total + v_line_rcm;
      else
        if v_supply_type = 'export_lut' or (v_supply_type = 'sez' and v_lut_active) then
          -- Sec 16(3)(a): zero-rated under LUT — no CGST/SGST/IGST/cess at all.
          null;
        elsif v_supply_type = 'export_igst' or (v_supply_type = 'sez' and not v_lut_active) then
          -- Sec 16(3)(b): zero-rated via the IGST-refund route — full IGST is
          -- charged (refunded later), always inter-State per Sec 7(5) IGST Act
          -- regardless of whether the two states actually differ.
          v_line_igst := round(v_amount * coalesce(v_gst_rate, 0) / 100, 2);
          v_line_cess := round(v_amount * coalesce(v_cess_rate, 0) / 100, 2);
        elsif v_intrastate then
          -- Ordinary domestic split by the real place of supply. Reached by
          -- plain 'intra' sales exactly as before, and by 'deemed_export'
          -- (Sec 147 supplies are taxed normally, never zero-rated — see this
          -- migration's header).
          v_line_cgst := round(v_amount * coalesce(v_gst_rate, 0) / 2 / 100, 2);
          v_line_sgst := v_line_cgst;
          v_line_cess := round(v_amount * coalesce(v_cess_rate, 0) / 100, 2);
        else
          v_line_igst := round(v_amount * coalesce(v_gst_rate, 0) / 100, 2);
          v_line_cess := round(v_amount * coalesce(v_cess_rate, 0) / 100, 2);
        end if;

        v_cgst_total := v_cgst_total + v_line_cgst;
        v_sgst_total := v_sgst_total + v_line_sgst;
        v_igst_total := v_igst_total + v_line_igst;
        v_cess_total := v_cess_total + v_line_cess;
      end if;
    end if;

    if v_tcs_on and v_tcs_section is not null then
      select rate_percent, no_pan_rate_percent, threshold_rupees
        into v_tcs_rate, v_tcs_no_pan_rate, v_tcs_threshold
        from public.ref_tcs_sections
       where section_code = v_tcs_section and is_active;

      if v_tcs_rate is not null and (v_tcs_threshold is null or v_amount > v_tcs_threshold) then
        v_line_gst_total := case when v_gst_on
          then v_line_cgst + v_line_sgst + v_line_igst + v_line_cess
          else 0 end;

        v_line_tcs := round(
          (v_amount + v_line_gst_total) *
          coalesce(case when v_party_pan is null then v_tcs_no_pan_rate else v_tcs_rate end, 0)
          / 100, 2);
        v_tcs_total := v_tcs_total + v_line_tcs;
      end if;
    end if;

    v_line_no := v_line_no + 1;
  end loop;

  if v_taxable_total <= 0 then
    raise exception 'An invoice must come to more than zero';
  end if;

  v_grand_total := v_taxable_total + v_cgst_total + v_sgst_total + v_igst_total + v_cess_total + v_tcs_total;

  insert into public.voucher_entries (
    voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values
    (v_voucher_id, p_company_id, p_branch_id, p_party_ledger_id,
     case when v_party_side = 'debit'  then v_grand_total else 0 end,
     case when v_party_side = 'credit' then v_grand_total else 0 end, 0),
    (v_voucher_id, p_company_id, p_branch_id, p_trading_ledger_id,
     case when v_party_side = 'debit'  then 0 else v_taxable_total end,
     case when v_party_side = 'credit' then 0 else v_taxable_total end, 1);

  v_entry_line := 2;

  if v_gst_on then
    for v_ledger, v_amount in
      select app_private.tax_ledger(p_company_id, v_tax_prefix || '_' || t.kind, v_registration_id), t.amt
        from (values ('cgst', v_cgst_total), ('sgst', v_sgst_total),
                     ('igst', v_igst_total), ('cess', v_cess_total)) as t(kind, amt)
       where t.amt > 0
    loop
      if v_ledger is null then
        raise exception 'No % ledger configured for this registration. Seed the GST ledgers for it first.', v_tax_prefix;
      end if;
      insert into public.voucher_entries (
        voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
      values (
        v_voucher_id, p_company_id, p_branch_id, v_ledger,
        case when v_party_side = 'debit'  then 0 else v_amount end,
        case when v_party_side = 'credit' then 0 else v_amount end,
        v_entry_line);
      v_entry_line := v_entry_line + 1;
    end loop;
  end if;

  -- RCM (0102): the self-assessed liability, and its matching debit.
  -- Never folded into the loop above — rcm_payable is its own purpose,
  -- always a straight Cr regardless of v_party_side (this block is only
  -- reached when p_voucher_type = 'purchase', so v_party_side is always
  -- 'credit' here, but the liability direction is written out plainly
  -- rather than through the case-when idiom the other loop reuses across
  -- four voucher types, since RCM only ever has one). The matching debit
  -- lands on the SAME trading ledger as the taxable value, not on Input
  -- CGST/SGST/IGST — see migration header for why: Sec 49(4) bars using
  -- this tax to pay output tax until the recipient has actually remitted
  -- it in cash, and LEKHA has no event representing that remittance
  -- separately from the ordinary GST-payable postings a later payment
  -- voucher already makes. Booking it as an immediate Input GST credit
  -- here would let get_gst_setoff_clearing (0090) treat it as usable
  -- same-voucher, which is exactly the fabricated-credit outcome this
  -- migration is written to avoid. Capitalising it into the trading
  -- ledger instead is conservative, not final — see scope_deferred.
  if v_rcm_tax_total > 0 then
    v_rcm_ledger := app_private.tax_ledger(p_company_id, 'rcm_payable', v_registration_id);
    if v_rcm_ledger is null then
      raise exception 'No RCM Payable ledger configured for this registration. Seed the GST ledgers for it first.';
    end if;
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, v_rcm_ledger,
      0, v_rcm_tax_total, v_entry_line);
    v_entry_line := v_entry_line + 1;

    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, p_trading_ledger_id,
      v_rcm_tax_total, 0, v_entry_line);
    v_entry_line := v_entry_line + 1;
  end if;

  if v_tcs_total > 0 then
    v_ledger := app_private.tax_ledger(p_company_id, 'output_tcs', null);
    if v_ledger is null then
      raise exception 'No TCS Payable ledger configured for this company. Set a TAN in Settings first — that provisions it automatically.';
    end if;
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
    values (
      v_voucher_id, p_company_id, p_branch_id, v_ledger,
      case when v_party_side = 'debit'  then 0 else v_tcs_total end,
      case when v_party_side = 'credit' then 0 else v_tcs_total end,
      v_entry_line);
  end if;

  return v_voucher_id;
end;
$$;


-- ----------------------------------------------------------------------------
-- 9. Settings RPCs. All SECURITY DEFINER, all admin-gated: fact F of this
--    task's brief is real — 0021 revoked every client write privilege on
--    voucher_number_sequences and 0094 gave it a read-only policy, and the
--    two new tables above are admin-write by policy for the reasons stated
--    there. These functions are the supported way in, because each does
--    cross-row bookkeeping (demoting a previous default, refusing to strand a
--    voucher type without one, provisioning a Default before series mode is
--    switched on) that a raw table write would skip.
-- ----------------------------------------------------------------------------

-- Internal: create the Default series for a type that has none yet, so a
-- company can be switched into series mode before it has ever raised that
-- voucher type. Same template next_voucher_number would have provisioned, so
-- switching modes never changes the number the next voucher gets.
create or replace function app_private.ensure_default_number_series(
  p_company_id uuid, p_voucher_type text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select x.id into v_id
    from public.voucher_number_series x
   where x.company_id = p_company_id
     and x.voucher_type = p_voucher_type
     and x.is_default
     and x.is_active;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.voucher_number_series
    (company_id, voucher_type, name, prefix, padding, is_default, is_active)
  values (p_company_id, p_voucher_type, 'Default',
          '{BRANCH}/' || app_private.voucher_type_code(p_voucher_type) || '/{FY}/',
          5, true, true)
  on conflict do nothing;

  select x.id into v_id
    from public.voucher_number_series x
   where x.company_id = p_company_id
     and x.voucher_type = p_voucher_type
     and x.is_default
     and x.is_active;
  return v_id;
end;
$$;

comment on function app_private.ensure_default_number_series(uuid, text) is
  'Idempotently provisions the Default series for a voucher type, with exactly the template next_voucher_number would have auto-provisioned, so switching numbering modes never changes what the next voucher is numbered. See 0725.';


create or replace function public.set_voucher_numbering_mode(
  p_company_id uuid,
  p_voucher_type text,
  p_mode text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can change voucher numbering';
  end if;

  if p_mode not in ('automatic', 'manual', 'series') then
    raise exception 'Numbering mode must be automatic, manual or series, not %', p_mode;
  end if;

  if p_voucher_type not in (
       'receipt','payment','contra','journal','sales','purchase',
       'credit_note','debit_note','branch_transfer','stock_journal',
       'job_work_out','job_work_in','delivery_challan_out') then
    raise exception '% is not a voucher type this app raises', p_voucher_type;
  end if;

  -- The friendly version of the table CHECK. Said in the preparer's terms
  -- rather than as a constraint name, per the standing house rule.
  if p_mode = 'manual' and p_voucher_type in
     ('stock_journal','job_work_out','job_work_in','delivery_challan_out') then
    raise exception 'Numbering for % cannot be manual: this app raises those documents itself (production, job work, delivery challans, stock verification) and nobody hand-types the number. Use automatic or series.',
      p_voucher_type;
  end if;

  -- Series mode with nothing to pick from would be a dead screen.
  if p_mode = 'series' then
    perform app_private.ensure_default_number_series(p_company_id, p_voucher_type);
  end if;

  insert into public.voucher_numbering_settings (company_id, voucher_type, mode, updated_by)
  values (p_company_id, p_voucher_type, p_mode, auth.uid())
  on conflict (company_id, voucher_type)
  do update set mode = excluded.mode, updated_by = excluded.updated_by;
end;
$$;

comment on function public.set_voucher_numbering_mode(uuid, text, text) is
  'Sets the numbering mode (automatic | manual | series) for one voucher type. Admin only. Provisions a Default series when switching to series mode; refuses manual on the four system-generated voucher types. See 0725.';


create or replace function public.create_voucher_number_series(
  p_company_id uuid,
  p_voucher_type text,
  p_name text,
  p_prefix text,
  p_padding smallint default 5,
  p_is_default boolean default false
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_has_default boolean;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can create a numbering series';
  end if;

  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'A numbering series needs a name';
  end if;
  if p_prefix is null or p_prefix !~ '^([A-Za-z0-9/-]|\{(BRANCH|FY|FYS|YY|YYYY)\})*$' then
    raise exception 'Prefix "%" may only contain letters, digits, hyphen, slash and the tokens {BRANCH}, {FY}, {FYS}, {YYYY}, {YY} — CGST Rule 46(b) allows no other characters in a document number.', p_prefix;
  end if;
  if p_padding is null or p_padding < 1 or p_padding > 9 then
    raise exception 'Padding must be between 1 and 9 digits, not %', p_padding;
  end if;

  if exists (select 1 from public.voucher_number_series x
              where x.company_id = p_company_id
                and x.voucher_type = p_voucher_type
                and x.name = btrim(p_name)) then
    raise exception 'This company already has a % numbering series called "%"', p_voucher_type, btrim(p_name);
  end if;

  -- The first series of a voucher type is always the default, whatever the
  -- caller asked for: a type with series but no default would strand every
  -- four-argument next_voucher_number call.
  select exists (select 1 from public.voucher_number_series x
                  where x.company_id = p_company_id
                    and x.voucher_type = p_voucher_type
                    and x.is_default)
    into v_has_default;

  if p_is_default and v_has_default then
    update public.voucher_number_series
       set is_default = false
     where company_id = p_company_id
       and voucher_type = p_voucher_type
       and is_default;
  end if;

  insert into public.voucher_number_series
    (company_id, voucher_type, name, prefix, padding, is_default, is_active, created_by)
  values (p_company_id, p_voucher_type, btrim(p_name), p_prefix, p_padding,
          p_is_default or not v_has_default, true, auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_voucher_number_series(uuid, text, text, text, smallint, boolean) is
  'Creates a named numbering series. Admin only. The first series of a voucher type is forced to be the default; making a later one default demotes the previous one in the same statement, since the partial unique index permits only one. Returns the new series id. See 0725.';


create or replace function public.update_voucher_number_series(
  p_company_id uuid,
  p_series_id uuid,
  p_name text default null,
  p_prefix text default null,
  p_padding smallint default null,
  p_is_default boolean default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can change a numbering series';
  end if;

  select x.voucher_type into v_type
    from public.voucher_number_series x
   where x.id = p_series_id and x.company_id = p_company_id;
  if v_type is null then
    raise exception 'Numbering series % does not belong to this company', p_series_id;
  end if;

  if p_prefix is not null and p_prefix !~ '^([A-Za-z0-9/-]|\{(BRANCH|FY|FYS|YY|YYYY)\})*$' then
    raise exception 'Prefix "%" may only contain letters, digits, hyphen, slash and the tokens {BRANCH}, {FY}, {FYS}, {YYYY}, {YY} — CGST Rule 46(b) allows no other characters in a document number.', p_prefix;
  end if;
  if p_padding is not null and (p_padding < 1 or p_padding > 9) then
    raise exception 'Padding must be between 1 and 9 digits, not %', p_padding;
  end if;

  -- Demoting a default is refused rather than silently done, because a
  -- voucher type with no default cannot mint at all.
  if p_is_default = false then
    raise exception 'A voucher type must always have a default series. Make another series the default instead of clearing this one.';
  end if;

  if p_is_default then
    update public.voucher_number_series
       set is_default = false
     where company_id = p_company_id
       and voucher_type = v_type
       and is_default
       and id <> p_series_id;
  end if;

  -- Prefix and padding changes are deliberately permitted MID-YEAR, which is
  -- the whole point: a company already sitting on 20-character
  -- HO/SAL/2026-27/00002 numbers must be able to shorten them NOW, not next
  -- April. Rule 46(b) expressly allows multiple series within one financial
  -- year, so the numbers before and after the change are simply two series;
  -- the counter is not reset, so nothing is reissued and no number repeats.
  update public.voucher_number_series x
     set name       = coalesce(btrim(p_name), x.name),
         prefix     = coalesce(p_prefix, x.prefix),
         padding    = coalesce(p_padding, x.padding),
         is_default = coalesce(p_is_default, x.is_default)
   where x.id = p_series_id and x.company_id = p_company_id;
end;
$$;

comment on function public.update_voucher_number_series(uuid, uuid, text, text, smallint, boolean) is
  'Edits a numbering series in place. Admin only; every argument optional, null meaning "leave alone". Prefix and padding changes are allowed MID-YEAR on purpose — that is how a company escapes a Rule 46(b)-violating format without waiting for April — and take effect from the next number drawn, never retroactively. See 0725.';


create or replace function public.set_voucher_number_series_active(
  p_company_id uuid,
  p_series_id uuid,
  p_is_active boolean
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_is_default boolean;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can retire or restore a numbering series';
  end if;

  select x.voucher_type, x.is_default into v_type, v_is_default
    from public.voucher_number_series x
   where x.id = p_series_id and x.company_id = p_company_id;
  if v_type is null then
    raise exception 'Numbering series % does not belong to this company', p_series_id;
  end if;

  if not p_is_active and v_is_default then
    raise exception 'This is the default series for %, so retiring it would leave nothing to number with. Make another series the default first.', v_type;
  end if;

  update public.voucher_number_series
     set is_active = p_is_active
   where id = p_series_id and company_id = p_company_id;
end;
$$;

-- Named as a setter taking a boolean rather than a one-way deactivate(): the
-- brief asked for "deactivate", but a retired series that could never be
-- restored is a trap — a company that retires the wrong one would otherwise
-- have to create a differently-named duplicate, since the (company, type,
-- name) uniqueness blocks recreating it. Deactivation is still the guarded
-- direction; reactivation needs no guard.
comment on function public.set_voucher_number_series_active(uuid, uuid, boolean) is
  'Retires (false) or restores (true) a numbering series. Admin only. Refuses to retire the default series, since a voucher type with no default cannot mint a number. Never deletes: a retired series keeps its counters, so its already-issued numbers stay explicable. See 0725.';


-- ----------------------------------------------------------------------------
-- 10. The read RPC the settings screen renders. Returns EVERY voucher type,
--     not only configured ones, with its mode, its series (or the Default
--     that would be auto-provisioned if it has never been used), the live
--     counter, a PREVIEW of the next number and that preview's character
--     count against CGST Rule 46(b)'s sixteen.
--
--     Member-gated, not admin-gated, on purpose: the voucher entry form needs
--     this same list to offer a series picker in series mode, and an
--     accountant who cannot read it could not post.
-- ----------------------------------------------------------------------------
create or replace function public.get_voucher_numbering_settings(
  p_company_id uuid,
  p_branch_id uuid default null,
  p_on_date date default current_date
) returns table (
  voucher_type text,
  type_label text,
  allows_manual boolean,
  mode text,
  branch_id uuid,
  branch_code text,
  financial_year_label text,
  series_id uuid,
  series_name text,
  prefix text,
  padding smallint,
  is_default boolean,
  is_active boolean,
  next_number integer,
  preview_number text,
  preview_length integer,
  rule46b_ok boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_branch uuid;
  v_code text;
  v_fy text;
  v_fy_start smallint;
begin
  if not app_private.is_company_member(p_company_id) then
    raise exception 'Not permitted to read numbering settings for this company';
  end if;

  select c.financial_year_start_month into v_fy_start
    from public.companies c where c.id = p_company_id;
  if v_fy_start is null then raise exception 'Company not found'; end if;
  v_fy := app_private.fy_label(p_on_date, v_fy_start);

  -- The preview needs a concrete branch to resolve {BRANCH}. Falls back to
  -- the company's lowest-coded branch and returns which one it used, so the
  -- screen can say "preview for HO" rather than implying the format is
  -- branch-independent (it is not — {BRANCH} is the commonest token).
  select b.id, b.code into v_branch, v_code
    from public.branches b
   where b.company_id = p_company_id
     and (p_branch_id is null or b.id = p_branch_id)
   order by b.code
   limit 1;
  if v_branch is null then
    raise exception 'This company has no branch to preview a number for';
  end if;

  return query
  with t as (
    select * from (values
      ('receipt',              'Receipt',           true),
      ('payment',              'Payment',           true),
      ('contra',               'Contra',            true),
      ('journal',              'Journal',           true),
      ('sales',                'Sales invoice',     true),
      ('purchase',             'Purchase invoice',  true),
      ('credit_note',          'Credit note',       true),
      ('debit_note',           'Debit note',        true),
      ('branch_transfer',      'Branch transfer',   true),
      ('stock_journal',        'Stock journal',     false),
      ('job_work_out',         'Job work challan',  false),
      ('job_work_in',          'Job work return',   false),
      ('delivery_challan_out', 'Delivery challan',  false)
    ) as v(vtype, vlabel, vmanual)
  ),
  s as (
    -- LEFT JOIN, so a voucher type that has never been used still previews:
    -- it shows the Default series next_voucher_number would provision on
    -- first use, with series_id null so the screen can tell the difference.
    select t.vtype,
           t.vlabel,
           t.vmanual,
           x.id as s_id,
           coalesce(x.name, 'Default') as s_name,
           coalesce(x.prefix,
                    '{BRANCH}/' || app_private.voucher_type_code(t.vtype) || '/{FY}/') as s_prefix,
           coalesce(x.padding, 5::smallint) as s_padding,
           coalesce(x.is_default, true) as s_is_default,
           coalesce(x.is_active, true) as s_is_active
      from t
      left join public.voucher_number_series x
        on x.company_id = p_company_id and x.voucher_type = t.vtype
  )
  select s.vtype,
         s.vlabel,
         s.vmanual,
         app_private.voucher_numbering_mode(p_company_id, s.vtype),
         v_branch,
         v_code,
         v_fy,
         s.s_id,
         s.s_name,
         s.s_prefix,
         s.s_padding,
         s.s_is_default,
         s.s_is_active,
         coalesce(q.next_number, 1),
         p.n,
         length(p.n),
         app_private.is_rule46b_number(p.n)
    from s
    left join public.voucher_number_sequences q
      on q.company_id = p_company_id
     and q.branch_id = v_branch
     and q.voucher_type = s.vtype
     and q.financial_year_label = v_fy
     and q.series_id = s.s_id
    cross join lateral (
      select app_private.resolve_number_prefix(s.s_prefix, v_code, v_fy)
             || lpad(coalesce(q.next_number, 1)::text, s.s_padding, '0') as n
    ) p
   order by s.vlabel, s.s_is_default desc, s.s_name;
end;
$$;

comment on function public.get_voucher_numbering_settings(uuid, uuid, date) is
  'Every voucher type with its numbering mode, its series (or the Default that would be provisioned on first use, distinguishable by a null series_id), the live counter, the exact number that would be issued next, its character count and whether it satisfies CGST Rule 46(b). One row per series, so a type in series mode returns several. See 0725.';


-- ----------------------------------------------------------------------------
-- 11. Grants. The standing house rule, applied to every function this file
--     creates or recreates — a DROP wipes existing grants, so create_voucher
--     and create_invoice are re-granted here explicitly rather than assumed.
--
--     One real finding while doing it: public.create_voucher held an EXECUTE
--     grant for PUBLIC before this migration (create_invoice did not),
--     meaning anon inherited it — the exact gotcha 0064 and 0231 were written
--     for, still live on the most central write function in the app. RLS on
--     public.vouchers made it unusable in practice (create_voucher is
--     SECURITY INVOKER, so the insert runs as anon and the policy refuses),
--     but it should never have been reachable. The DROP/CREATE above clears
--     it; not re-granting it is the fix.
--
--     service_role is re-granted on both entry points because both carried it
--     before this migration and dropping it would break any server-side
--     caller that relies on it.
-- ----------------------------------------------------------------------------
revoke all on function app_private.voucher_type_code(text) from public, anon;
grant execute on function app_private.voucher_type_code(text) to authenticated, service_role;

revoke all on function app_private.resolve_number_prefix(text, text, text) from public, anon;
grant execute on function app_private.resolve_number_prefix(text, text, text) to authenticated, service_role;

revoke all on function app_private.is_rule46b_number(text) from public, anon;
grant execute on function app_private.is_rule46b_number(text) to authenticated, service_role;

revoke all on function app_private.assert_rule46b_number(text) from public, anon;
grant execute on function app_private.assert_rule46b_number(text) to authenticated, service_role;

revoke all on function app_private.voucher_numbering_mode(uuid, text) from public, anon;
grant execute on function app_private.voucher_numbering_mode(uuid, text) to authenticated, service_role;

revoke all on function app_private.ensure_default_number_series(uuid, text) from public, anon;
grant execute on function app_private.ensure_default_number_series(uuid, text) to authenticated, service_role;

revoke all on function app_private.next_voucher_number(uuid, uuid, text, date, uuid) from public, anon;
grant execute on function app_private.next_voucher_number(uuid, uuid, text, date, uuid) to authenticated, service_role;

revoke all on function app_private.resolve_manual_voucher_number(uuid, uuid, text, date, text) from public, anon;
grant execute on function app_private.resolve_manual_voucher_number(uuid, uuid, text, date, text) to authenticated, service_role;

revoke all on function public.create_voucher(uuid, uuid, text, date, jsonb, text, text, date, uuid, bpchar, numeric, text, text, uuid) from public, anon;
grant execute on function public.create_voucher(uuid, uuid, text, date, jsonb, text, text, date, uuid, bpchar, numeric, text, text, uuid) to authenticated, service_role;

revoke all on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, bpchar, bpchar, numeric, text, text, uuid) from public, anon;
grant execute on function public.create_invoice(uuid, uuid, text, date, uuid, uuid, uuid, jsonb, text, text, date, bpchar, bpchar, numeric, text, text, uuid) to authenticated, service_role;

revoke all on function public.set_voucher_numbering_mode(uuid, text, text) from public, anon;
grant execute on function public.set_voucher_numbering_mode(uuid, text, text) to authenticated;

revoke all on function public.create_voucher_number_series(uuid, text, text, text, smallint, boolean) from public, anon;
grant execute on function public.create_voucher_number_series(uuid, text, text, text, smallint, boolean) to authenticated;

revoke all on function public.update_voucher_number_series(uuid, uuid, text, text, smallint, boolean) from public, anon;
grant execute on function public.update_voucher_number_series(uuid, uuid, text, text, smallint, boolean) to authenticated;

revoke all on function public.set_voucher_number_series_active(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_voucher_number_series_active(uuid, uuid, boolean) to authenticated;

revoke all on function public.get_voucher_numbering_settings(uuid, uuid, date) from public, anon;
grant execute on function public.get_voucher_numbering_settings(uuid, uuid, date) to authenticated;

-- Table grants. Reads go through PostgREST for the settings screen; writes go
-- through the RPCs above, but the admin-gated policies mean a direct write by
-- an admin is a supported (if unvalidated) fallback rather than a hole.
grant select, insert, update, delete on public.voucher_number_series to authenticated;
grant select, insert, update, delete on public.voucher_numbering_settings to authenticated;
