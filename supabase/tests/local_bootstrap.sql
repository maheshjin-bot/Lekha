-- ============================================================================
-- Local development only — stubs the parts of Supabase the migrations assume.
-- ============================================================================
-- Never applied to a hosted Supabase project: it already provides all of this.
-- This exists so a plain PostgreSQL install can run the migrations and, more
-- importantly, so RLS policies can be tested properly rather than skipped.
--
-- The stub is faithful on the one thing that matters: `auth.uid()` reads the
-- same `request.jwt.claims` setting that Supabase's does. That means a test
-- can impersonate a real user exactly the way PostgREST does —
--
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<user-uuid>","role":"authenticated"}';
--
-- — and every policy written against auth.uid() behaves as it will in
-- production. Without this, RLS could only be inspected, not exercised.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Roles
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  -- service_role bypasses RLS in Supabase, which is what makes it dangerous
  -- and worth modelling accurately: a test that accidentally runs as this role
  -- would pass while proving nothing.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;


-- ----------------------------------------------------------------------------
-- auth schema
-- ----------------------------------------------------------------------------
create schema if not exists auth;

-- Only the columns the migrations actually reference. Every foreign key in
-- this application points at auth.users(id) with on delete set null.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Mirrors Supabase's implementation. `true` as the second argument to
-- current_setting means "return null if unset" rather than raising, which is
-- what makes this safe to call outside a request context.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')::text;
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', '')::text;
$$;


-- ----------------------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------------------
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- Supabase grants table privileges to these roles by default; RLS is what
-- actually restricts them. Reproducing that here matters, because a policy
-- test would otherwise fail on a missing GRANT and look like a policy bug.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant select on tables to anon;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;
