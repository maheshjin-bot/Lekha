-- ============================================================================
-- 0063 — Public API access: read-only, key-authenticated, outside the
--         Supabase Auth session every other write path in this app relies on
-- ============================================================================
-- The `public_api` module (0004) has been registered since day one —
-- optional, code "Public API access" — with zero code behind it, the same
-- shape of gap each of this session's other Aug 21 modules closed.
--
-- WHY THIS IS DIFFERENT FROM EVERY OTHER FEATURE SHIPPED TODAY: everything
-- else this session went through RLS keyed on auth.uid() — a real signed-in
-- Supabase Auth session. An external integration (a script, a BI tool, a
-- Zapier flow) has no such session and never will; it presents a long-lived
-- API key instead. RLS cannot see that key at all, so the two dispatcher
-- functions below (api_get_trial_balance, api_get_dashboard_kpis) are
-- SECURITY DEFINER and — the one deliberate reversal of this entire
-- session's convention — explicitly GRANTed to the `anon` role. Every other
-- function this session wrote has REVOKEd anon; these two grant it on
-- purpose, because the key itself, not a Postgres role, is what's actually
-- gating access here. Each function re-derives the calling company from the
-- key on every single call — there is no session to trust between calls,
-- unlike a cookie-based sign-in.
--
-- KEYS ARE HASHED, NEVER STORED IN THE CLEAR. api_keys.key_hash is
-- sha256(raw key); the raw key itself exists only for the single moment
-- create_api_key returns it, and is never written anywhere, matching how a
-- password is handled (set_company_password, 0044) — a stolen database
-- backup must not hand out live API credentials, the same reasoning a
-- stolen backup must not hand out live passwords.
--
-- SCOPE, DELIBERATELY MINIMAL FOR V1: two read-only reports (trial balance,
-- dashboard KPIs) rather than a general-purpose data API. A real public API
-- needs versioning discipline, rate limiting, and a stable contract per
-- endpoint — committing to a wide surface on day one is exactly the kind of
-- promise that is expensive to walk back later. Two endpoints prove the
-- whole authentication and key-lifecycle path end to end; more endpoints
-- are an additive change to app/api/v1/, not a redesign, once real usage
-- shows which reports external tools actually want.
--
-- NO SCOPES/PERMISSIONS PER KEY IN V1 — every key can call every v1
-- endpoint for its own company, nothing more (no cross-company access is
-- possible under any circumstance; that boundary is not optional). Finer-
-- grained per-key scoping (read-only vs a future write endpoint, report-
-- level allow-lists) is real, separate work once a second capability tier
-- actually exists to scope against.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- api_keys
-- ----------------------------------------------------------------------------
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  -- First 8 chars of the raw key, shown in the UI list so an admin can tell
  -- keys apart without ever seeing the full secret again after creation.
  key_prefix text not null,
  key_hash text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index api_keys_company_idx on public.api_keys(company_id);
create index api_keys_hash_idx on public.api_keys(key_hash) where revoked_at is null;

alter table public.api_keys enable row level security;

-- Read/write here is the KEY MANAGEMENT surface (list names/prefixes,
-- create, revoke) — a normal authenticated company member/admin action,
-- completely separate from the api_get_* functions below that actual
-- external callers use. The hash column is never selected by the app UI,
-- but RLS alone does not hide a column — the UI's own select list is what
-- keeps it off the wire; the hash being useless without the matching raw
-- key is the real defence.
create policy api_keys_read on public.api_keys
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy api_keys_write on public.api_keys
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.api_keys is
  'API keys for the public_api module. key_hash is sha256 of the raw key — the raw value is never stored, only ever returned once by create_api_key at the moment of creation. Revoking sets revoked_at rather than deleting the row, so a key''s creation and revocation both stay in this table''s own history.';


-- ----------------------------------------------------------------------------
-- create_api_key(company, name) -> raw key (shown once)
-- ----------------------------------------------------------------------------
create or replace function public.create_api_key(
  p_company_id uuid,
  p_name text
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_raw text;
  v_hash text;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'You do not have permission to create an API key for this company';
  end if;

  -- 32 random bytes, hex-encoded (64 chars) — a fixed, recognisable prefix
  -- makes an accidentally-committed key greppable across a codebase, the
  -- same reason Stripe/GitHub/every major API key format starts with one.
  v_raw := 'lekha_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_raw, 'sha256'), 'hex');

  insert into public.api_keys (company_id, name, key_prefix, key_hash, created_by)
  values (p_company_id, p_name, left(v_raw, 14), v_hash, auth.uid());

  return v_raw;
end;
$$;

revoke execute on function public.create_api_key(uuid, text) from anon;

comment on function public.create_api_key is
  'Creates an API key and returns the RAW value — the only time it is ever available. Store it now; LEKHA cannot show it again, only the key_prefix for identification.';


-- ----------------------------------------------------------------------------
-- revoke_api_key(company, key_id)
-- ----------------------------------------------------------------------------
create or replace function public.revoke_api_key(
  p_company_id uuid,
  p_key_id uuid
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'You do not have permission to revoke an API key for this company';
  end if;

  update public.api_keys
     set revoked_at = now()
   where id = p_key_id and company_id = p_company_id and revoked_at is null;
end;
$$;

revoke execute on function public.revoke_api_key(uuid, uuid) from anon;

comment on function public.revoke_api_key is
  'Revokes a key immediately and permanently — there is no un-revoke; a business that still needs API access creates a new key.';


-- ----------------------------------------------------------------------------
-- app_private.authenticate_api_key(raw_key) -> company_id
-- ----------------------------------------------------------------------------
-- Shared by every api_get_* dispatcher below, so the validation logic
-- (hash, look up, check revoked, bump last_used_at) lives exactly once. Not
-- itself exposed to anon — only the api_get_* functions that call it are.
create or replace function app_private.authenticate_api_key(p_raw_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_key_id uuid;
begin
  if p_raw_key is null or length(p_raw_key) = 0 then
    raise exception 'Missing API key';
  end if;

  select k.id, k.company_id into v_key_id, v_company_id
    from public.api_keys k
   where k.key_hash = encode(extensions.digest(p_raw_key, 'sha256'), 'hex')
     and k.revoked_at is null;

  -- Deliberately the SAME error for "no such key" and "revoked key" — a
  -- distinguishable error would let a caller learn a key's revocation
  -- status by probing, which is more than a failed request needs to reveal.
  if v_company_id is null then
    raise exception 'Invalid or revoked API key';
  end if;

  update public.api_keys set last_used_at = now() where id = v_key_id;

  return v_company_id;
end;
$$;

comment on function app_private.authenticate_api_key is
  'Validates a raw API key and returns its company_id, or raises. Called by every api_get_* function so external callers never need a Supabase Auth session — see the migration header for why this and its callers are SECURITY DEFINER, granted to anon, and re-derive the company on every call rather than trusting a session.';


-- ----------------------------------------------------------------------------
-- api_get_trial_balance(raw_key, from, to)
-- ----------------------------------------------------------------------------
create or replace function public.api_get_trial_balance(
  p_api_key text,
  p_from date,
  p_to date
) returns table (
  ledger_name text,
  group_name text,
  nature text,
  opening_debit numeric,
  opening_credit numeric,
  period_debit numeric,
  period_credit numeric,
  closing_debit numeric,
  closing_credit numeric
)
language plpgsql
-- VOLATILE (the default — not stable), because authenticate_api_key has a
-- real side effect (bumping last_used_at). Marking this stable made
-- PostgREST open a read-only transaction for it, which then refused that
-- UPDATE outright — caught live, not assumed, when a real anon call failed
-- with "cannot execute UPDATE in a read-only transaction".
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  v_company_id := app_private.authenticate_api_key(p_api_key);
  return query
    select tb.ledger_name, tb.group_name, tb.nature,
           tb.opening_debit, tb.opening_credit,
           tb.period_debit, tb.period_credit,
           tb.closing_debit, tb.closing_credit
      from public.get_trial_balance(v_company_id, p_from, p_to, null) tb;
end;
$$;

grant execute on function public.api_get_trial_balance(text, date, date) to anon;

comment on function public.api_get_trial_balance is
  'Public API v1: trial balance for the key''s own company. Authenticates via the raw key in p_api_key, not a session — see the migration header.';


-- ----------------------------------------------------------------------------
-- api_get_dashboard_kpis(raw_key)
-- ----------------------------------------------------------------------------
create or replace function public.api_get_dashboard_kpis(
  p_api_key text
) returns table (
  cash_bank numeric,
  receivables numeric,
  receivables_overdue numeric,
  payables numeric,
  gst_liability numeric,
  tds_payable numeric
)
language plpgsql
-- VOLATILE, same reason as api_get_trial_balance above.
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
begin
  v_company_id := app_private.authenticate_api_key(p_api_key);
  return query select * from public.get_dashboard_kpis(v_company_id, current_date);
end;
$$;

grant execute on function public.api_get_dashboard_kpis(text) to anon;

comment on function public.api_get_dashboard_kpis is
  'Public API v1: the same six dashboard KPIs the company dashboard itself shows (0031, sign-corrected by 0054), for the key''s own company. Authenticates via the raw key, not a session.';
