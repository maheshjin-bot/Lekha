-- ============================================================================
-- 1340 — The DEFAULT voucher number every company gets is twenty characters
--        and CGST Rule 46(b) allows sixteen. Ship a default that fits, and
--        tell the companies already sitting on the one that doesn't.
-- ============================================================================
-- WHAT IS ACTUALLY TRUE BEFORE THIS MIGRATION, READ LIVE RATHER THAN RECALLED
--
--   * Every default series in this database has prefix '{BRANCH}/<CODE>/{FY}/'
--     and padding 5 — all 73 series rows across all 16 companies, one query,
--     no exceptions except two hand-made export series ('EXP/{FYS}/', padding
--     4, 14 characters) that somebody had to build by hand to get under the
--     cap.
--
--   * Minted through the real path, that produces a TWENTY-character number.
--     Proven, not computed: inside a rolled-back transaction, for a real
--     company that has never raised a sales voucher and therefore takes the
--     auto-provisioning branch,
--
--         app_private.next_voucher_number(<Indian Onliners>, HO, 'sales',
--                                         current_date)
--           -> HO/SAL/2026-27/00001, 20 characters,
--              app_private.is_rule46b_number(...) = false
--
--     Structurally: branch code (1-6) + '/' + 3-letter type code + '/' +
--     7-character FY label + '/' + 5 digits. With the shortest branch code in
--     this database, 'HO', that is 20; a 6-character branch code makes it 24.
--
--   * CGST Rule 46(b) requires "a consecutive serial number not exceeding
--     sixteen characters, in one or multiple series, containing alphabets or
--     numerals or special characters hyphen or dash and slash symbolised as
--     '-' and '/' respectively, and any combination thereof, unique for a
--     financial year." Rule 53(1A) repeats the sixteen-character cap word for
--     word for credit and debit notes, and Rule 55 for delivery challans. The
--     NIC Invoice Registration Portal refuses a longer DocDtls.No outright,
--     so an e-invoice cannot be raised against one of these numbers at all.
--
--   * The app already KNOWS. components/settings/NumberingSettings.tsx badges
--     any preview over 16 as "over the 16 allowed", leads its banner with the
--     offending document type, and the e-invoice screen has carried a warning
--     since 0230. 0725 built the whole configurable-prefix engine expressly so
--     this could be fixed. What nobody ever changed is the DEFAULT the screen
--     is judging — so the app has been shipping a format it tells you off for.
--
-- ----------------------------------------------------------------------------
-- WHERE THE DEFAULT ACTUALLY LIVES (the trace, verified against the live
-- catalog rather than against the migration files, which define superseded
-- versions of two of these)
-- ----------------------------------------------------------------------------
-- public.create_company seeds NO numbering rows at all (its source contains
-- the string 'voucher_number' zero times). Nothing is seeded at company
-- creation; the Default series is provisioned lazily, on first use, and the
-- literal '{BRANCH}/' || voucher_type_code(...) || '/{FY}/' with padding 5 is
-- written out in exactly three live functions:
--
--   1. app_private.next_voucher_number        (0725, replaced by 1160)
--        auto-provisions the Default the first time a voucher type is raised.
--   2. app_private.ensure_default_number_series (0725)
--        provisions it when an admin switches a type into series mode before
--        it has ever been raised.
--   3. public.get_voucher_numbering_settings  (0725, replaced by 1160)
--        SYNTHESISES it for the settings screen so a never-used type still
--        previews, with a null series_id.
--
-- Three copies of one constant is how a fix gets applied to two places and
-- forgotten in the third: the screen would then promise a number the engine
-- does not mint. So this migration first gives the constant one home
-- (app_private.default_series_prefix / default_series_padding) and then
-- changes it there.
--
-- ----------------------------------------------------------------------------
-- THE NEW DEFAULT, AND THE ARITHMETIC IT HAS TO SURVIVE
-- ----------------------------------------------------------------------------
--     prefix template   '{BRANCH}' || <3-letter type code> || '{YY}/'
--     padding           4
--
--     HO,     sales, FY 2026-27  ->  HOSAL26/0001        12 characters
--     MUM,    sales, FY 2026-27  ->  MUMSAL26/0001       13 characters
--     BLRWH1, sales, FY 2026-27  ->  BLRWH1SAL26/0001    16 characters
--
-- THE WORST CASE THIS IS DESIGNED FOR IS A SIX-CHARACTER BRANCH CODE, because
-- that is the longest the schema permits: branches_code_check is
-- '^[A-Z0-9]{1,6}$'. At six the number is exactly 16 characters — at the cap,
-- not over it — so there is no branch code any company can create for which
-- this default breaks Rule 46(b). That is why the slashes around the type code
-- are gone: the budget at a 6-character branch code is
--
--     16 = 6 (branch) + 3 (type code) + 2 (year) + 1 (separator) + 4 (digits)
--
-- which leaves room for exactly ONE separator, and the useful place for it is
-- immediately before the counter, where it separates the part that changes
-- from the part that does not. '{BRANCH}/SAL/{YY}/' with 4 digits — the shape
-- the settings screen has been recommending — is 18 characters at a
-- 6-character branch code and 17 at five, so it could not be the shipped
-- default without silently breaking for some companies. This migration also
-- corrects that recommendation on the screen to the shape it now ships.
--
-- WHAT HAPPENS BEYOND THE WORST CASE. Not the branch code — six is the
-- schema's own ceiling. The reachable limit is the COUNTER: 4 digits hold
-- 9,999 documents per branch, per voucher type, per financial year, where the
-- old default's 5 held 99,999. Two things follow, and both are deliberate:
--
--   * At the 10,000th document the number grows a fifth digit
--     (HOSAL26/10000, 13 characters, 17 at a 6-character branch code) rather
--     than being truncated. Postgres lpad TRUNCATES when the value is longer
--     than the width — lpad('10000', 4, '0') is '1000' — so the pre-existing
--     behaviour at overflow was to reissue document 1,000's number and be
--     refused by vouchers' UNIQUE key, mid-year, as a constraint name. That
--     was already wrong at padding 5; lowering the width to 4 makes it
--     reachable, so app_private.pad_voucher_counter below pads without ever
--     truncating. The number stays unique and consecutive, which is what Rule
--     46(b) actually requires, and its LENGTH breach is then reported by the
--     same two surfaces that report every other one (the settings screen and,
--     new here, the dashboard). A company issuing 10,000 documents a year in
--     one branch can widen the padding or start a second series; a company
--     whose posting is refused in November cannot do anything.
--
--   * A 2-digit year repeats after a century. FY 2126-27 would resolve {YY}
--     to '26' again. The counter is keyed by financial year, so numbers are
--     unique within their year either way, which is exactly what Rule 46(b)
--     asks. Noted rather than solved.
--
-- WHY THE YEAR STAYS IN THE NUMBER AT ALL. Dropping '{YY}' would have bought
-- two characters and let the default keep both slashes and 5 digits
-- ('{BRANCH}/SAL/' + 5 = 'HO/SAL/00001'). It was rejected: the counter resets
-- every 1 April, so a number with no year in it is issued again next year,
-- and a company would hold two different invoices both numbered HO/SAL/00001.
-- Rule 46(b) permits that (it asks for uniqueness within a financial year),
-- but nearly every Indian tax invoice carries the year, the app's own settings
-- screen recommends including it, and two identical numbers in one set of
-- books is a real cost to pay for two characters.
--
-- WHY {BRANCH} STAYS, NON-NEGOTIABLY. 1160 proved live that a series whose
-- prefix omits {BRANCH} issues the SAME number in every branch (the counter is
-- per branch, the prefix was not), refuses such a prefix outright for a
-- multi-branch company, and refuses the second branch's first draw. The
-- default series is drawn from by every branch and by all nine internal
-- callers, so a default without {BRANCH} would be a landmine that arms itself
-- the day a company opens its second branch. Two to six characters is what
-- that guarantee costs and it is worth it.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * It does not touch ONE existing row. No UPDATE, no INSERT, no DELETE
--     anywhere in this file: not on voucher_number_series, not on
--     voucher_number_sequences, not on vouchers. Every existing company keeps
--     the series it has, every counter keeps its next_number, and every number
--     already issued keeps its digits. 0725 made that call in its own header
--     ("Rule 46(b) applies to the number at issue; retro-rewriting issued
--     invoice numbers would be far worse than leaving them") and it stands: a
--     number on a document already sent to a counterparty is not ours to
--     rewrite. The post-flight at the end of this file re-reads the
--     fingerprint of both tables to prove it.
--
--   * It therefore leaves existing companies non-compliant until an admin
--     changes their prefix, which only they can decide. What it adds is that
--     they find out: section 6 puts it on the dashboard, where the numbering
--     format has never been surfaced before.
--
--   * It does not make an existing company's formats consistent with each
--     other. An existing company that has raised sales but never a debit note
--     keeps '{BRANCH}/SAL/{FY}/' for sales and gets the new default for its
--     first debit note. Mixed, and correct: the alternative is to knowingly
--     mint a 20-character number on a document Rule 53(1A) caps at 16, purely
--     for visual consistency with a number that is already wrong.
--
--   * It does not change public.create_voucher_number_series' p_padding
--     default of 5. That parameter default applies to a series an admin
--     creates and names by hand, always with an explicit padding from the
--     screen; the Default series is what this migration is about.
--
--   * It does not add a Rule 46(b) check to the voucher-posting path. 0725
--     settled that deliberately (a company outside GST, or one numbering
--     internal journals, has no such cap) and this migration honours it in
--     the same way in the notice below: a company with no active GST
--     registration is not told anything, because Rule 46(b) does not bind it.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. Fingerprint both numbering tables before anything runs, so the claim
--    "this migration rewrites nobody's issued numbers" is PROVEN at the end of
--    this file rather than asserted in its header.
--
--    Stashed in session settings rather than a temp table so this file creates
--    no object and can be replayed against any database — the fingerprints of
--    THIS database at the time of writing (73 series rows, 80 counter rows,
--    0b18deb4... / 91e0456e...) are evidence in a comment, not a constant to
--    compare against, which would have made the file unreplayable and would
--    have failed the moment another session in this shared project posted a
--    voucher of a type that had none.
-- ----------------------------------------------------------------------------
do $$
begin
  perform set_config('lekha.mig1340_series',
    coalesce((select md5(string_agg(company_id::text||'|'||voucher_type||'|'||name||'|'||prefix||'|'||padding||'|'||is_default||'|'||is_active, E'\n'
                         order by company_id::text, voucher_type, name))
                from public.voucher_number_series), 'none')
    || ':' || (select count(*) from public.voucher_number_series), false);

  perform set_config('lekha.mig1340_counters',
    coalesce((select md5(string_agg(company_id::text||'|'||branch_id::text||'|'||voucher_type||'|'||financial_year_label||'|'||series_id::text||'|'||prefix||'|'||resolved_prefix||'|'||next_number||'|'||padding, E'\n'
                         order by company_id::text, branch_id::text, voucher_type, financial_year_label, series_id::text))
                from public.voucher_number_sequences), 'none')
    || ':' || (select count(*) from public.voucher_number_sequences), false);
end;
$$;


-- ----------------------------------------------------------------------------
-- 1. The default, with one home. Both functions are immutable and pure, so
--    they can be called from the CHECK-shaped assertions at the end of this
--    file and from the three provisioning sites below alike.
-- ----------------------------------------------------------------------------
create or replace function app_private.default_series_prefix(p_voucher_type text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- No slashes around the type code, so the resolved number is exactly 16
  -- characters at the longest branch code branches_code_check allows. The
  -- single slash sits before the counter, where it separates the part that
  -- changes from the part that does not: HOSAL26/0001.
  select '{BRANCH}' || app_private.voucher_type_code(p_voucher_type) || '{YY}/';
$$;

comment on function app_private.default_series_prefix(text) is
  'The prefix TEMPLATE for the Default numbering series of a voucher type: {BRANCH}<CODE>{YY}/, e.g. HOSAL26/. Resolves to 16 characters with a 4-digit counter at the longest branch code the schema allows (6), which is what CGST Rule 46(b) caps a document number at. Single definition, read by all three sites that provision or preview a Default series. See 1340.';

create or replace function app_private.default_series_padding()
returns smallint
language sql
immutable
set search_path = ''
as $$
  select 4::smallint;
$$;

comment on function app_private.default_series_padding() is
  'Zero-padding width for the Default numbering series: 4, i.e. 9,999 documents per branch per voucher type per financial year, after which the counter grows a digit rather than being truncated (see app_private.pad_voucher_counter). Was 5 before 1340, which put the generated number at 20 characters against Rule 46(b)''s 16. See 1340.';


-- ----------------------------------------------------------------------------
-- 2. Padding that never truncates.
--
--    lpad(text, width) TRUNCATES when the value is longer than the width:
--    lpad('10000', 4, '0') is '1000'. On the minting path that means the
--    10,000th document of a 4-digit series is handed document 1,000's number
--    and refused by vouchers' UNIQUE key as a constraint name, mid-year, with
--    no way forward. That was already the behaviour at padding 5 (at 100,000);
--    this migration lowers the default width to 4 and so must define what
--    overflow does. It grows the number instead of corrupting it — still
--    unique, still consecutive, and its length breach is reported by the
--    settings screen and by the dashboard notice added below.
-- ----------------------------------------------------------------------------
create or replace function app_private.pad_voucher_counter(
  p_number integer, p_padding smallint
) returns text
language sql
immutable
set search_path = ''
as $$
  select lpad(p_number::text,
              greatest(coalesce(p_padding, 1)::int, length(p_number::text)),
              '0');
$$;

comment on function app_private.pad_voucher_counter(integer, smallint) is
  'Zero-pads a voucher counter to the series'' padding width, and NEVER truncates: Postgres lpad silently shortens a value longer than the width, which on the minting path would reissue an earlier document''s number. Beyond the width the number grows a digit instead. See 1340.';


-- ----------------------------------------------------------------------------
-- 3. next_voucher_number — 1160's body verbatim, with the auto-provisioned
--    template and padding read from section 1 and the counter padded by
--    section 2. Nothing else changes, including the signature: CREATE OR
--    REPLACE keeps the nine internal four-argument callers resolving to it and
--    keeps its grants.
-- ----------------------------------------------------------------------------
create or replace function app_private.next_voucher_number(
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
  v_clash_branch text;
  v_clash_series text;
  v_clash_type text;
  v_clash_example text;
  v_this_series text;
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
    -- voucher can be posted would make 0725 a breaking change for every
    -- company in the database.
    --
    -- Since 1340 the template provisioned here is the Rule 46(b)-compliant
    -- one ({BRANCH}SAL{YY}/ + 4 digits, at most 16 characters for any branch
    -- code the schema allows) rather than the 20-character pre-0725 format.
    -- It still contains {BRANCH}, so an auto-provisioned series can never be
    -- the one that collides across branches (1160). An EXISTING series is
    -- never rewritten — only a type that has no series yet gets the new
    -- format, so no number already issued changes.
    if v_series_id is null then
      insert into public.voucher_number_series
        (company_id, voucher_type, name, prefix, padding, is_default, is_active)
      values (p_company_id, p_voucher_type, 'Default',
              app_private.default_series_prefix(p_voucher_type),
              app_private.default_series_padding(), true, true)
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

  -- ---- 1160: is some OTHER counter already printing this same text? -------
  -- Two ways to get here, both proved live in 1160's header: a series with no
  -- {BRANCH} in its prefix drawn from a second branch, and two voucher types
  -- configured with the same prefix. Either would hand this voucher a number
  -- that has already been issued this financial year. Refusing the posting is
  -- the lesser harm: an issued duplicate serial cannot be withdrawn, and CGST
  -- Rule 46(b) binds the number at issue.
  select b2.code,
         s2.name,
         s2.voucher_type,
         q.resolved_prefix || lpad('1', q.padding, '0')
    into v_clash_branch, v_clash_series, v_clash_type, v_clash_example
    from public.voucher_number_sequences q
    join public.branches b2 on b2.id = q.branch_id
    join public.voucher_number_series s2 on s2.id = q.series_id
   where q.company_id = p_company_id
     and q.financial_year_label = v_fy_label
     and q.resolved_prefix = v_resolved
     and not (q.branch_id = p_branch_id and q.series_id = v_series_id)
   limit 1;

  if v_clash_branch is not null then
    select x.name into v_this_series
      from public.voucher_number_series x where x.id = v_series_id;

    if v_clash_branch is distinct from v_branch_code then
      raise exception
        'Numbering series "%" has no {BRANCH} in its prefix, so it issues the same numbers in every branch — and it has already issued numbers beginning "%" at branch %. Raising this % at branch % would reissue a number this company has already used, which CGST Rule 46(b) forbids: a serial number must be unique for the whole financial year, not just within one branch. Fix it in Settings > Voucher numbering: add {BRANCH} to the prefix, or give branch % its own series with a different prefix.',
        coalesce(v_this_series, '?'), v_resolved, v_clash_branch,
        p_voucher_type, v_branch_code, v_branch_code;
    else
      raise exception
        'Numbering series "%" (%) and series "%" (%) both start their numbers with "%", so both would issue %. Two counters cannot share a prefix — each starts at 1, so every number would be issued twice, and CGST Rule 46(b) requires a serial number to be unique for the financial year. Give one of them a different prefix in Settings > Voucher numbering.',
        coalesce(v_this_series, '?'), p_voucher_type,
        v_clash_series, v_clash_type, v_resolved, v_clash_example;
    end if;
  end if;
  -- ------------------------------------------------------------------------

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
                -- which is the defect 0725 exists to fix.
                resolved_prefix = excluded.resolved_prefix,
                padding = excluded.padding
  returning (next_number - 1), padding into v_number, v_padding;

  return query select
    -- 1340: pads, never truncates. See app_private.pad_voucher_counter.
    (v_resolved || app_private.pad_voucher_counter(v_number, v_padding)),
    v_number,
    v_fy_label;
end;
$$;

comment on function app_private.next_voucher_number(uuid, uuid, text, date, uuid) is
  'Mints the next voucher number. Four-argument calls (all nine internal callers) draw from the voucher type''s default series, auto-provisioning it on first use — since 1340 with the Rule 46(b)-compliant default format ({BRANCH}<CODE>{YY}/ and 4 digits, at most 16 characters), which changes nothing for a series that already exists. A fifth argument names an explicit series and is only accepted in series mode. Since 1160 it refuses, in a sentence, to draw from a counter whose leading text another counter in the same company and financial year is already using. See 0725, 1160, 1340.';


-- ----------------------------------------------------------------------------
-- 4. ensure_default_number_series — the second copy of the constant. Reached
--    when an admin switches a voucher type into series mode before it has ever
--    been raised, so it must provision exactly what next_voucher_number would.
-- ----------------------------------------------------------------------------
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
          app_private.default_series_prefix(p_voucher_type),
          app_private.default_series_padding(), true, true)
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
  'Idempotently provisions the Default series for a voucher type, with exactly the template next_voucher_number would have auto-provisioned, so switching numbering modes never changes what the next voucher is numbered. Both read app_private.default_series_prefix / default_series_padding since 1340. See 0725, 1340.';


-- ----------------------------------------------------------------------------
-- 5. get_voucher_numbering_settings — the third copy, and the one that would
--    have lied if it had been missed: it synthesises the Default series for a
--    voucher type that has never been raised, so the screen's preview must
--    show the format the engine will actually provision.
--
--    1160's body verbatim, with the two constants and the pad swapped.
--    CREATE OR REPLACE (1160 needed DROP/CREATE because it was adding output
--    columns; the shape here is byte-identical, so grants survive).
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
  rule46b_ok boolean,
  branch_scope_ok boolean,
  branch_scope_note text
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
  v_branch_count int;
  v_all_codes text;
begin
  if not app_private.is_company_member(p_company_id) then
    raise exception 'Not permitted to read numbering settings for this company';
  end if;

  select c.financial_year_start_month into v_fy_start
    from public.companies c where c.id = p_company_id;
  if v_fy_start is null then raise exception 'Company not found'; end if;
  v_fy := app_private.fy_label(p_on_date, v_fy_start);

  select count(*), string_agg(b.code, ', ' order by b.code)
    into v_branch_count, v_all_codes
    from public.branches b where b.company_id = p_company_id;

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
    -- Since 1340 that synthesised default is read from the same two functions
    -- next_voucher_number provisions from, so the preview cannot drift from
    -- what gets minted.
    select t.vtype,
           t.vlabel,
           t.vmanual,
           x.id as s_id,
           coalesce(x.name, 'Default') as s_name,
           coalesce(x.prefix, app_private.default_series_prefix(t.vtype)) as s_prefix,
           coalesce(x.padding, app_private.default_series_padding()) as s_padding,
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
         app_private.is_rule46b_number(p.n),
         scope.ok,
         scope.note
    from s
    left join public.voucher_number_sequences q
      on q.company_id = p_company_id
     and q.branch_id = v_branch
     and q.voucher_type = s.vtype
     and q.financial_year_label = v_fy
     and q.series_id = s.s_id
    cross join lateral (
      select app_private.resolve_number_prefix(s.s_prefix, v_code, v_fy)
             -- 1340: same pad as the minting path, so a counter that has
             -- outgrown its padding previews as the number that will actually
             -- be issued rather than as a truncated one.
             || app_private.pad_voucher_counter(coalesce(q.next_number, 1), s.s_padding) as n
    ) p
    cross join lateral (
      select v_branch_count <= 1 or app_private.prefix_names_the_branch(s.s_prefix) as ok
    ) okx
    cross join lateral (
      select okx.ok as ok,
             case when okx.ok then null else
               'This prefix has no {BRANCH} token, so it issues the same number in every branch. '
               || 'This company has ' || v_branch_count || ' branches (' || v_all_codes || '). '
               || coalesce(
                    (select 'So far it has only been used at ' ||
                            string_agg(distinct b3.code, ' and ') || '. '
                       from public.voucher_number_sequences q3
                       join public.branches b3 on b3.id = q3.branch_id
                      where q3.company_id = p_company_id and q3.series_id = s.s_id),
                    'It has not issued any number yet. ')
               || case when s.s_is_default
                    then 'It is the DEFAULT series, which every branch numbers from, so the next '
                         || lower(s.vlabel) || ' raised in another branch will be refused rather '
                         || 'than issued a duplicate. Fix this before it happens.'
                    else 'Using it in another branch will be refused rather than issued a '
                         || 'duplicate, because CGST Rule 46(b) requires a serial number to be '
                         || 'unique for the whole financial year, not per branch.'
                  end
               || ' Add {BRANCH} to the prefix, or give each branch its own series.'
             end as note
    ) scope
   order by s.vlabel, s.s_is_default desc, s.s_name;
end;
$$;

comment on function public.get_voucher_numbering_settings(uuid, uuid, date) is
  'Every voucher type with its numbering mode, its series (or the Default that would be provisioned on first use, distinguishable by a null series_id), the live counter, the exact number that would be issued next, its character count and whether it satisfies CGST Rule 46(b). Since 1160 it also returns branch_scope_ok / branch_scope_note. Since 1340 the synthesised Default and the counter padding come from the same functions the minting path uses, so a preview cannot differ from the number that gets issued. See 0725, 1160, 1340.';


-- ----------------------------------------------------------------------------
-- 6. Tell the companies that are already on the old default.
--
--    Changing the default only helps a company that has not raised the voucher
--    type yet. Eleven of the sixteen companies in this database hold a
--    '{BRANCH}/<CODE>/{FY}/' series that has already issued numbers, and this
--    migration will not rewrite it (see the header). Their admins would find
--    out only by opening Settings > Voucher numbering, a screen nobody visits
--    without a reason.
--
--    So the dashboard's own "Needs your attention" list gets a row. That list
--    is the first thing on the company home page, every row is already a link,
--    and this one links straight to the numbering screen — which since 0725
--    explains what is wrong, gives the prefix to use, and says in as many
--    words that "Nothing already issued is renumbered — the change applies
--    from the next voucher." The row is the pointer; that screen is the
--    explanation and the fix, and duplicating its paragraph into a truncated
--    one-line label would say it worse.
--
--    WHO IS NOT TOLD, and why that is the point:
--      * a company with no ACTIVE GST REGISTRATION. Rule 46(b) is a CGST rule
--        about a tax invoice. 0725's header made exactly this point when it
--        declined to block long numbers outright, and nagging an unregistered
--        company about a GST document format would be telling it off for
--        nothing. Five of the sixteen live companies have no active GSTIN.
--      * a voucher type whose number is not printed on a GST document. Same
--        set the settings screen already uses for its loud-versus-quiet badge
--        (sales, credit and debit notes under Rule 53(1A), branch transfers,
--        and the challans that carry goods under Rule 55). A 20-character
--        journal or receipt number is untidy, not unlawful.
--      * a series that cannot actually be drawn from: a non-default series
--        while its voucher type is in automatic mode is unreachable
--        (next_voucher_number only accepts an explicit series in series mode),
--        so it issues nothing and is not worth a word.
--      * a company whose numbers already fit. The test is
--        app_private.is_rule46b_number on the very same preview string
--        get_voucher_numbering_settings shows — not a third hand-rolled copy
--        of "16 characters", of which there were already two (that predicate
--        and NumberingSettings.tsx's own arithmetic, which has to be
--        client-side because it previews a prefix still being typed).
--
--    Evaluated per branch and reported at the WORST branch, because the number
--    grows with the branch code: Sharma Textiles is 20 characters at HO and 21
--    at MUM, and a compliance notice that quotes the shorter one is a notice
--    that under-reports. The label names no branch, so the figure reads as
--    what it is: the longest number this company would issue.
--
--    get_needs_attention stays SECURITY INVOKER and every table it reads here
--    is RLS'd to company members, so a non-member still gets an empty list
--    rather than an error — which is what it did before this migration.
-- ----------------------------------------------------------------------------
create or replace function public.get_needs_attention(p_company_id uuid)
returns table(category text, label text, detail text, severity text, href text)
language plpgsql
stable
set search_path = ''
as $$
begin
  return query
  with bank_ledgers as (
    select l.id
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id and g.ledger_role = 'cash_bank'
  ),
  bank_summary as (
    select coalesce(sum(s.unmatched_statement_count), 0)::int as total_unmatched
      from bank_ledgers bl
      cross join lateral public.get_bank_reconciliation_summary(p_company_id, bl.id, current_date) s
  ),
  pending as (
    select count(*)::int as cnt
      from public.vouchers
     where company_id = p_company_id and is_deleted = false and approval_status = 'pending'
  ),
  calendar_rows as (
    select r.category, r.label, r.detail,
           case when r.due_date <= current_date + 2 then 'bad' else 'warn' end as severity,
           '/' || p_company_id || '/reports/compliance-calendar' as href,
           (r.due_date - current_date) as sort_num
      from public.get_compliance_calendar(p_company_id, current_date, current_date + 7) r
  ),
  recon_rows as (
    select 'Reconciliation'::text as category,
           bs.total_unmatched || ' bank line' ||
             (case when bs.total_unmatched = 1 then '' else 's' end) || ' unmatched' as label,
           null::text as detail,
           'warn'::text as severity,
           '/' || p_company_id || '/reconciliation' as href,
           0 as sort_num
      from bank_summary bs
     where bs.total_unmatched > 0
  ),
  overdue_rows as (
    select 'Receivables'::text as category,
           'Invoice ' || r.voucher_number || ' overdue' as label,
           r.days_overdue || ' days' as detail,
           case when r.days_overdue > 30 then 'bad' else 'warn' end as severity,
           '/' || p_company_id || '/vouchers/' || r.voucher_id as href,
           -r.days_overdue as sort_num
      from public.get_overdue_receivables(p_company_id, current_date) r
     order by r.days_overdue desc
     limit 10
  ),
  approval_rows as (
    select 'Approvals'::text as category,
           pd.cnt || ' voucher' || (case when pd.cnt = 1 then '' else 's' end) || ' pending approval' as label,
           null::text as detail,
           'warn'::text as severity,
           '/' || p_company_id || '/approvals' as href,
           0 as sort_num
      from pending pd
     where pd.cnt > 0
  ),
  -- ---- 1340: document numbers that break CGST Rule 46(b) -----------------
  gst_registered as (
    select exists (
      select 1 from public.gst_registrations g
       where g.company_id = p_company_id and g.is_active
    ) as yes
  ),
  numbering_types as (
    -- The document types whose number is printed on something that leaves the
    -- business and is read by the GST system. Same set, and the same reasons,
    -- as GST_FACING in components/settings/NumberingSettings.tsx.
    select * from (values
      ('sales',                'Sales invoice'),
      ('credit_note',          'Credit note'),
      ('debit_note',           'Debit note'),
      ('branch_transfer',      'Branch transfer'),
      ('delivery_challan_out', 'Delivery challan'),
      ('job_work_out',         'Job work challan')
    ) as v(vtype, vlabel)
  ),
  numbering_fy as (
    select app_private.fy_label(current_date, c.financial_year_start_month) as label
      from public.companies c where c.id = p_company_id
  ),
  numbering_breaches as (
    select nt.vtype,
           nt.vlabel,
           length(pv.n) as preview_length
      from public.voucher_number_series x
      join numbering_types nt on nt.vtype = x.voucher_type
      cross join numbering_fy fy
      join public.branches b on b.company_id = x.company_id
      left join public.voucher_number_sequences q
        on q.company_id = x.company_id
       and q.series_id = x.id
       and q.branch_id = b.id
       and q.voucher_type = x.voucher_type
       and q.financial_year_label = fy.label
      cross join lateral (
        select app_private.resolve_number_prefix(x.prefix, b.code, fy.label)
               || app_private.pad_voucher_counter(coalesce(q.next_number, 1), x.padding) as n
      ) pv
     where x.company_id = p_company_id
       and x.is_active
       and (select gr.yes from gst_registered gr)
       -- Only a series a document can actually be issued from.
       and (x.is_default
            or app_private.voucher_numbering_mode(p_company_id, x.voucher_type) = 'series')
       and not app_private.is_rule46b_number(pv.n)
  ),
  numbering_worst as (
    -- Lead with the sales invoice when it is one of the offenders: it is the
    -- document a reader recognises and the one the IRP actually refuses.
    select nb.vlabel, max(nb.preview_length) as preview_length,
           (select count(distinct nb2.vtype) from numbering_breaches nb2) as type_count
      from numbering_breaches nb
     group by nb.vtype, nb.vlabel
     order by case when nb.vtype = 'sales' then 0 else 1 end,
              max(nb.preview_length) desc,
              nb.vlabel
     limit 1
  ),
  numbering_rows as (
    select 'Numbering'::text as category,
           nw.vlabel || ' numbers are ' || nw.preview_length
             || ' characters, over the 16 GST allows'
             || case when nw.type_count > 1
                     then ' (+' || (nw.type_count - 1) || ' more document type'
                          || case when nw.type_count = 2 then '' else 's' end || ')'
                     else '' end as label,
           'Rule 46(b)'::text as detail,
           'warn'::text as severity,
           '/' || p_company_id || '/settings/numbering' as href,
           0 as sort_num
      from numbering_worst nw
  ),
  -- ------------------------------------------------------------------------
  all_rows as (
    select * from calendar_rows
    union all select * from recon_rows
    union all select * from overdue_rows
    union all select * from approval_rows
    union all select * from numbering_rows
  )
  select ar.category, ar.label, ar.detail, ar.severity, ar.href
    from all_rows ar
   order by case ar.severity when 'bad' then 0 else 1 end, ar.category, ar.sort_num;
end;
$$;

comment on function public.get_needs_attention(uuid) is
  'The company home page''s "Needs your attention" list: compliance due dates, unmatched bank lines, overdue receivables, vouchers awaiting approval, and since 1340 a document-numbering row for a GST-registered company whose next tax invoice, credit or debit note, branch transfer or challan would carry a number longer than the sixteen characters CGST Rule 46(b) allows. Links to Settings > Voucher numbering, which explains the fix and that it applies only from the next voucher. See 0031, 1340.';


-- ----------------------------------------------------------------------------
-- 7. Grants. The house rule, restated in full for every function this file
--    creates or replaces, so this file is the whole truth about them. All were
--    CREATE OR REPLACE with unchanged signatures, so nothing was dropped and
--    no grant was lost; these lines match the ACLs read live before the change
--    (authenticated + service_role, nothing for PUBLIC or anon).
-- ----------------------------------------------------------------------------
revoke all on function app_private.default_series_prefix(text) from public, anon;
grant execute on function app_private.default_series_prefix(text) to authenticated, service_role;

revoke all on function app_private.default_series_padding() from public, anon;
grant execute on function app_private.default_series_padding() to authenticated, service_role;

revoke all on function app_private.pad_voucher_counter(integer, smallint) from public, anon;
grant execute on function app_private.pad_voucher_counter(integer, smallint) to authenticated, service_role;

revoke all on function app_private.next_voucher_number(uuid, uuid, text, date, uuid) from public, anon;
grant execute on function app_private.next_voucher_number(uuid, uuid, text, date, uuid) to authenticated, service_role;

revoke all on function app_private.ensure_default_number_series(uuid, text) from public, anon;
grant execute on function app_private.ensure_default_number_series(uuid, text) to authenticated, service_role;

revoke all on function public.get_voucher_numbering_settings(uuid, uuid, date) from public, anon;
grant execute on function public.get_voucher_numbering_settings(uuid, uuid, date) to authenticated, service_role;

revoke all on function public.get_needs_attention(uuid) from public, anon;
grant execute on function public.get_needs_attention(uuid) to authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 8. Post-flight, in the same transaction that made the change.
--
--    (a) The arithmetic, for every voucher type, at the LONGEST branch code
--        the schema permits — asserted through app_private.is_rule46b_number
--        rather than a hand-written length test, so this assertion and the
--        dashboard notice and the settings screen are all judging by the same
--        predicate.
--    (b) The new default template is still something the series table would
--        accept and something 1160 would not refuse.
--    (c) Nothing existing moved: both numbering tables still hold exactly the
--        rows, prefixes, paddings and counters they held before this file ran,
--        compared against the fingerprints section 0 took on the way in.
-- ----------------------------------------------------------------------------
do $$
declare
  v_types text[] := array[
    'receipt','payment','contra','journal','sales','purchase',
    'credit_note','debit_note','branch_transfer','stock_journal',
    'job_work_out','job_work_in','delivery_challan_out'];
  v_type text;
  v_prefix text;
  v_number text;
begin
  foreach v_type in array v_types loop
    v_prefix := app_private.default_series_prefix(v_type);

    -- (a) 'ABCDEF' is a 6-character branch code, the longest
    --     branches_code_check ('^[A-Z0-9]{1,6}$') allows, and 9999 is the
    --     largest counter the default padding holds: the worst case on both
    --     axes at once.
    v_number := app_private.resolve_number_prefix(v_prefix, 'ABCDEF', '2026-27')
                || app_private.pad_voucher_counter(9999, app_private.default_series_padding());
    if not app_private.is_rule46b_number(v_number) then
      raise exception '1340 post-flight: the default numbering for % gives "%" (% characters) at a 6-character branch code, which CGST Rule 46(b) does not allow',
        v_type, v_number, length(v_number);
    end if;

    -- (b) The prefix CHECK on voucher_number_series, and 1160's requirement
    --     that a default series name its branch.
    if v_prefix !~ '^([A-Za-z0-9/-]|\{(BRANCH|FY|FYS|YY|YYYY)\})*$'
       or length(v_prefix) > 40 then
      raise exception '1340 post-flight: default prefix "%" for % would be rejected by voucher_number_series_prefix_check', v_prefix, v_type;
    end if;
    if not app_private.prefix_names_the_branch(v_prefix) then
      raise exception '1340 post-flight: default prefix "%" for % has no {BRANCH}, so it would issue the same number in every branch (1160)', v_prefix, v_type;
    end if;
  end loop;

  -- Two distinct voucher types must still resolve to two distinct prefixes,
  -- or the unique index 1160 added over (company, FY, resolved_prefix) would
  -- refuse the second type's first voucher.
  if (select count(distinct app_private.resolve_number_prefix(
                              app_private.default_series_prefix(t), 'ABCDEF', '2026-27'))
        from unnest(v_types) t) <> array_length(v_types, 1) then
    raise exception '1340 post-flight: two voucher types share a default resolved prefix';
  end if;
end;
$$;

do $$
declare
  v_series_fp text;
  v_counter_fp text;
  v_series_before text := current_setting('lekha.mig1340_series', true);
  v_counter_before text := current_setting('lekha.mig1340_counters', true);
begin
  -- A missing fingerprint means section 0 did not run in this session, so the
  -- comparison below would silently pass on a null. Fail instead.
  if coalesce(v_series_before, '') = '' or coalesce(v_counter_before, '') = '' then
    raise exception '1340 post-flight: the before-fingerprints from section 0 are not present in this session, so "nothing was rewritten" cannot be proven';
  end if;

  select coalesce(md5(string_agg(company_id::text||'|'||voucher_type||'|'||name||'|'||prefix||'|'||padding||'|'||is_default||'|'||is_active, E'\n'
                      order by company_id::text, voucher_type, name)), 'none')
         || ':' || count(*)
    into v_series_fp from public.voucher_number_series;

  select coalesce(md5(string_agg(company_id::text||'|'||branch_id::text||'|'||voucher_type||'|'||financial_year_label||'|'||series_id::text||'|'||prefix||'|'||resolved_prefix||'|'||next_number||'|'||padding, E'\n'
                      order by company_id::text, branch_id::text, voucher_type, financial_year_label, series_id::text)), 'none')
         || ':' || count(*)
    into v_counter_fp from public.voucher_number_sequences;

  -- This file contains no INSERT, UPDATE or DELETE on either table, so both
  -- fingerprints must still be what section 0 recorded. If they are not,
  -- something in here rewrote a company's issued numbering, and that is worth
  -- failing the migration over rather than discovering from a customer.
  if v_series_fp <> v_series_before then
    raise exception '1340 post-flight: voucher_number_series changed while this migration ran (% -> %)',
      v_series_before, v_series_fp;
  end if;
  if v_counter_fp <> v_counter_before then
    raise exception '1340 post-flight: voucher_number_sequences changed while this migration ran (% -> %)',
      v_counter_before, v_counter_fp;
  end if;
end;
$$;
