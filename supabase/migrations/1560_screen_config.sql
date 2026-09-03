-- ============================================================================
-- 1560 — Screen-config layer: one row per (company, user?, screen), so a
--        screen can remember a preference (a chosen density, a hidden column,
--        a default filter, ...) at two independent scopes — a company-wide
--        default an admin sets once, and a per-user override that wins over
--        it — without either scope needing its own table.
-- ============================================================================
-- THIS MIGRATION DELIBERATELY BUILDS ONLY THE STORAGE LAYER AND ITS TWO RPCs.
-- No screen reads or writes it yet. The plan calls for roughly a dozen
-- specific config keys, and those are chosen once a real screen is being
-- adapted to use them, not guessed here. Wiring this into a screen — and
-- picking that screen's own config shape — is later, separate work.
--
-- WHY ONE TABLE WITH A NULLABLE user_id RATHER THAN TWO TABLES (a
-- company_screen_defaults and a user_screen_overrides): the merge the read
-- RPC below performs (user row layered over company row) is naturally one
-- query against one table filtered by "user_id is null or user_id = mine",
-- not a join across two. It also means a company that has never set a
-- default and a user who has never set an override both cost zero rows —
-- nothing is pre-seeded, exactly like voucher_numbering_settings (0725):
-- absence means "nothing configured", not "configured to some default value
-- someone had to remember to insert".
--
-- WHY NULL, NOT A SENTINEL COMPANY-ROW USER: Postgres treats NULLs as
-- DISTINCT in a plain unique constraint (the same trap 0725's header
-- documents for voucher_number_sequences.series_id), which is exactly why a
-- bare `unique (company_id, user_id, screen_key)` would let a second
-- "company default" row for the same screen slip in — the ON CONFLICT clause
-- in set_screen_config would then match neither reliably, and a company's
-- default could silently fork into two disagreeing rows. The fix is the same
-- one 0725 used for series_id, in the opposite direction: rather than making
-- the nullable column NOT NULL, this migration makes the UNIQUE INDEX itself
-- NULL-safe with a coalesce-to-a-fixed-uuid expression, so exactly one
-- company-default row and one row per real user can exist per screen.
--
-- WHY security invoker RPCs over a table with its own RLS, rather than the
-- security definer + in-body admin check every other write RPC in this
-- codebase uses (0725's set_voucher_numbering_mode, create_voucher_number_
-- series, ...): those RPCs write rows no ordinary member should ever be able
-- to write directly (a numbering series, a posted voucher's allocations), so
-- the table itself grants nothing and the RPC's SECURITY DEFINER body is the
-- only door. Here, half of what this table stores — a user's OWN screen
-- preference — is precisely the kind of self-service write RLS is designed
-- to express directly (like company_members reading its own membership row).
-- Making set_screen_config's own body ALSO check is_company_admin for the
-- company-default branch (below, same phrasing as 0725's admin RPCs) is
-- therefore belt-and-braces on top of RLS, not a substitute for it: the
-- table's write policy encodes the exact same rule a second time, so a
-- future direct table write (a migration backfill, a script) cannot bypass
-- it by skipping the RPC.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The table.
-- ----------------------------------------------------------------------------
create table public.screen_config (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- NULL means "the company-wide default for this screen". A real user id
  -- means "this one person's override". Never any other sentinel.
  user_id uuid references auth.users(id) on delete cascade,
  -- A route- or component-scoped key the calling screen picks for itself,
  -- e.g. 'invoices-list' or 'pos-quick-billing' — same informal naming style
  -- as useShortcuts' ShortcutScope strings, but this table enforces the
  -- shape rather than only relying on convention.
  screen_key text not null,
  config jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint screen_config_screen_key_check
    check (screen_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  constraint screen_config_config_is_object
    check (jsonb_typeof(config) = 'object')
);

-- The NULL-safe uniqueness this table's whole correctness rests on — see
-- header. The fixed uuid is never a real auth.users id (it is the all-zero
-- nil uuid), so it can never collide with an actual user's override row.
create unique index screen_config_company_user_screen_key
  on public.screen_config (
    company_id,
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    screen_key
  );

-- Company-default rows (user_id is null) vastly outnumber lookups scoped to
-- one user across many screens, but a user switching screens repeatedly
-- benefits from this too: covers both get_screen_config's two-row fetch.
create index screen_config_company_screen_idx
  on public.screen_config (company_id, screen_key);

create trigger set_updated_at before update on public.screen_config
  for each row execute function app_private.set_updated_at();

alter table public.screen_config enable row level security;

-- Read: any company member may see the company-wide default (user_id is
-- null) plus their OWN override — never another member's override. A
-- personal density/column preference is not something a teammate needs to
-- read, and keeping the policy this narrow means get_screen_config's merge
-- query needs no extra filtering to get that for free.
create policy screen_config_read on public.screen_config
  for select to authenticated
  using (
    (select app_private.is_company_member(company_id))
    and (user_id is null or user_id = auth.uid())
  );

-- Write: a member may always write their OWN row. The company-default row
-- (user_id is null) may only be written by a company admin — same authority
-- split 0725 draws between an accountant posting and an admin deciding
-- numbering policy: a personal preference is self-service, but a company-
-- wide default is a decision that affects every teammate's screen.
create policy screen_config_write on public.screen_config
  for all to authenticated
  using (
    (select app_private.is_company_member(company_id))
    and (
      user_id = auth.uid()
      or (user_id is null and (select app_private.is_company_admin(company_id)))
    )
  )
  with check (
    (select app_private.is_company_member(company_id))
    and (
      user_id = auth.uid()
      or (user_id is null and (select app_private.is_company_admin(company_id)))
    )
  );

comment on table public.screen_config is
  'Per-screen configuration, at two scopes: a company-wide default (user_id null, admin-writable) and a per-user override (user_id set, writable only by that user). get_screen_config (1560) merges the two; set_screen_config (1560) is the only intended writer, though the RLS policies above independently enforce the same rule for any direct table write. Not yet read by any screen — see migration header.';
comment on column public.screen_config.user_id is
  'NULL = the company-wide default row for this screen. A real user id = that user''s personal override. NULLs are made safe for uniqueness by screen_config_company_user_screen_key''s coalesce-to-nil-uuid expression, not by a NOT NULL column — see migration header for why a bare unique constraint would not do this.';
comment on column public.screen_config.config is
  'Arbitrary screen-chosen JSON object (screen_config_config_is_object requires an object, never an array or scalar, so a screen can always safely spread it). No shape is imposed here — each screen_key owns its own keys.';


-- ----------------------------------------------------------------------------
-- 2. get_screen_config — the merged read. security invoker: it runs as the
--    calling user, so screen_config_read above is what actually decides
--    which rows it can see; a non-member sees neither row and gets back
--    '{}'::jsonb, the same quiet-empty-result convention
--    get_bill_wise_outstanding (1490) already uses for a non-member caller
--    rather than a raised exception.
-- ----------------------------------------------------------------------------
create or replace function public.get_screen_config(
  p_company_id uuid,
  p_screen_key text
) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce(
      (select c.config from public.screen_config c
        where c.company_id = p_company_id
          and c.screen_key = p_screen_key
          and c.user_id is null),
      '{}'::jsonb
    )
    ||
    coalesce(
      (select c.config from public.screen_config c
        where c.company_id = p_company_id
          and c.screen_key = p_screen_key
          and c.user_id = auth.uid()),
      '{}'::jsonb
    );
$$;

revoke all on function public.get_screen_config(uuid, text) from public, anon;
grant execute on function public.get_screen_config(uuid, text) to authenticated;

comment on function public.get_screen_config(uuid, text) is
  'The effective config for one screen: the company default with the calling user''s own override shallow-merged on top (jsonb ||, so an overridden top-level key wins outright and every other company-default key still comes through). Neither row existing returns {}. See 1560.';


-- ----------------------------------------------------------------------------
-- 3. set_screen_config — the single writer both branches share. security
--    invoker, same reasoning as get_screen_config: the actual insert/update
--    below is executed as the calling user and lives or dies by
--    screen_config_write. The is_company_admin check here exists so a
--    non-admin gets set_voucher_numbering_mode's kind of friendly, specific
--    error INSTEAD of a raw RLS violation on the p_for_company branch — the
--    RLS policy would refuse the write regardless if this check were
--    somehow bypassed.
-- ----------------------------------------------------------------------------
create or replace function public.set_screen_config(
  p_company_id uuid,
  p_screen_key text,
  p_config jsonb,
  p_for_company boolean default false
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_target_user uuid;
begin
  if not (select app_private.is_company_member(p_company_id)) then
    raise exception 'You are not a member of this company';
  end if;

  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'Screen config must be a JSON object, not %', coalesce(jsonb_typeof(p_config), 'null');
  end if;

  if p_for_company then
    if not (select app_private.is_company_admin(p_company_id)) then
      raise exception 'Only a company admin can set the company-wide default for this screen';
    end if;
    v_target_user := null;
  else
    v_target_user := auth.uid();
  end if;

  insert into public.screen_config (company_id, user_id, screen_key, config, updated_by)
  values (p_company_id, v_target_user, p_screen_key, p_config, auth.uid())
  on conflict (company_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), screen_key)
  do update set config = excluded.config, updated_by = excluded.updated_by;
end;
$$;

revoke all on function public.set_screen_config(uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.set_screen_config(uuid, text, jsonb, boolean) to authenticated;

comment on function public.set_screen_config(uuid, text, jsonb, boolean) is
  'Writes the calling user''s own override row for a screen, or (p_for_company true, admin only) the company-wide default row. Replaces that row''s config wholesale — callers wanting a partial update must merge client-side against get_screen_config''s result first, the same optimistic-merge shape lib/config/useScreenConfig.ts''s setConfig follows. See 1560.';
