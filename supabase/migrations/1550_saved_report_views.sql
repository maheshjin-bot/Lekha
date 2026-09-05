-- ============================================================================
-- 1550 — Saved report views: a user's own named bookmark of a report's query
--        string (fy/branch/from/to + its view/limit params — see the
--        defineReport/ReportView recon this migration was built against),
--        so Ctrl+L on a report can offer "load this again" without the user
--        re-picking every filter by hand.
-- ============================================================================
-- SHAPE AND REASONING MODELED DIRECTLY ON 1560_screen_config's OWN TABLE: a
-- personal, per-user row is exactly the kind of self-service write RLS alone
-- is designed to express (like company_members reading its own membership
-- row). Unlike screen_config, though, there is no company-wide-default
-- branch here at all — every row in this table is one person's own bookmark,
-- never a shared or admin-authored default. That is a deliberate scope cut,
-- not an oversight: a future "shared saved view" requirement would need its
-- own sharing rule (who can see it, who can edit it) and is out of this
-- migration's scope. Because of that, user_id is NOT NULL here (contrast
-- screen_config.user_id, which is nullable precisely to hold the
-- company-default row) — there is no sentinel row to make room for.
--
-- RLS alone is therefore the whole door: no SECURITY DEFINER RPC layer is
-- needed the way 0725's numbering RPCs need one (those write rows no
-- ordinary member should ever write directly). Both RPCs below are
-- SECURITY INVOKER — they run as the calling user and live or dies by the
-- single policy below, exactly like 1560's get_screen_config/set_screen_config.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. The table.
-- ----------------------------------------------------------------------------
create table public.saved_report_views (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Same screen_key convention ReportShell's reportConfigScope() derives from
  -- the pathname and screen_config already keys on — same CHECK constraint
  -- text as screen_config_screen_key_check, deliberately kept byte-identical.
  screen_key text not null check (screen_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  -- Everything after '?', no leading '?'. '' is valid and means "the bare
  -- default view with nothing pinned" — a legitimate thing to name and save.
  -- Never includes a screen_config-backed toggle (e.g. showComparative) —
  -- those are a private preference, not shareable/saveable view state; see
  -- the ReportView recon this migration was built against.
  query_string text not null default '',
  created_at timestamptz not null default now(),
  unique (company_id, user_id, screen_key, name)
);

-- The unique constraint's own index already covers "list my saved views for
-- this screen" (company_id, user_id, screen_key is its leftmost prefix), so
-- no separate lookup index is added.

alter table public.saved_report_views enable row level security;

-- Self-service, same reasoning 1560 gives for a user's OWN override row (not
-- screen_config's company-default branch, which that migration gates behind
-- is_company_admin in an RPC body): every row here is one person's own named
-- bookmark, so RLS alone — select/insert/update/delete where user_id =
-- auth.uid() and the caller is a member of that company — is the correct and
-- sufficient door. No company-shared branch exists (see header).
create policy saved_report_views_self on public.saved_report_views
  for all to authenticated
  using (
    user_id = auth.uid()
    and (select app_private.is_company_member(company_id))
  )
  with check (
    user_id = auth.uid()
    and (select app_private.is_company_member(company_id))
  );

comment on table public.saved_report_views is
  'A user''s own named bookmark of one report''s query string (fy/branch/from/to + its view/limit params), keyed by the same screen_key convention screen_config (1560) uses. Every row is a personal bookmark — there is no company-shared row like screen_config''s user_id-null default; RLS (saved_report_views_self) is the only access door. save_report_view/list_report_views (1550) are the intended callers, though the policy independently enforces the same rule for any direct table write. See 1550.';
comment on column public.saved_report_views.screen_key is
  'Must equal ReportShell''s own reportConfigScope() output for the route this view was saved from (path segments after companyId, "-"-joined) — the same value screen_config keys its rows on. Format enforced by the same CHECK regex as screen_config_screen_key_check.';
comment on column public.saved_report_views.query_string is
  'Everything after "?", no leading "?". "" is valid (the bare default view). Never a screen_config-backed toggle (those are a private preference, not saveable view state) — see migration header.';


-- ----------------------------------------------------------------------------
-- 2. save_report_view — the single writer. Upserts on the table's own unique
--    key, so saving again under a name already used for this screen quietly
--    replaces that bookmark's query string rather than raising a duplicate-
--    name error — the natural behavior for a "Save current view as…" prompt
--    (Ctrl+L) re-used on an existing name. Returns the row's id, matching the
--    create_recurring_voucher_template (0151) convention of a create-style
--    RPC returning the new/affected row's id rather than void.
-- ----------------------------------------------------------------------------
create or replace function public.save_report_view(
  p_company_id uuid,
  p_screen_key text,
  p_name text,
  p_query_string text default ''
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not (select app_private.is_company_member(p_company_id)) then
    raise exception 'You are not a member of this company';
  end if;

  insert into public.saved_report_views (company_id, user_id, screen_key, name, query_string)
  values (p_company_id, auth.uid(), p_screen_key, p_name, coalesce(p_query_string, ''))
  on conflict (company_id, user_id, screen_key, name)
  do update set query_string = excluded.query_string
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.save_report_view(uuid, text, text, text) from public, anon;
grant execute on function public.save_report_view(uuid, text, text, text) to authenticated;

comment on function public.save_report_view(uuid, text, text, text) is
  'Saves (or, if p_name already exists for this company/screen_key/caller, replaces) one of the calling user''s own named report-view bookmarks. security invoker: the insert lives or dies by saved_report_views_self, same as 1560''s set_screen_config. Returns the saved row''s id. See 1550.';


-- ----------------------------------------------------------------------------
-- 3. list_report_views — the calling user's own saved views for one screen,
--    alphabetically (a bookmark menu, not an activity feed). security
--    invoker + stable, same shape as 1560's get_screen_config; the explicit
--    user_id filter mirrors that function's own belt-and-braces style even
--    though saved_report_views_self would already confine the result set.
-- ----------------------------------------------------------------------------
create or replace function public.list_report_views(
  p_company_id uuid,
  p_screen_key text
) returns table (
  id uuid,
  name text,
  query_string text,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select v.id, v.name, v.query_string, v.created_at
  from public.saved_report_views v
  where v.company_id = p_company_id
    and v.screen_key = p_screen_key
    and v.user_id = auth.uid()
  order by lower(v.name);
$$;

revoke all on function public.list_report_views(uuid, text) from public, anon;
grant execute on function public.list_report_views(uuid, text) to authenticated;

comment on function public.list_report_views(uuid, text) is
  'The calling user''s own saved views for one report screen, alphabetically by name. Never returns another user''s bookmark — there is no shared row in this table (see 1550''s header). See 1550.';
