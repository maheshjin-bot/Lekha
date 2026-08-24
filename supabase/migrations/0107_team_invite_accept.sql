-- ============================================================================
-- 0107 — Team invites: a token the invitee can actually redeem
-- ============================================================================
-- public.company_invites and public.company_members have existed, fully
-- specified with RLS, since 0003 — the very first migration. Nothing in the
-- app has ever read or written company_invites: `grep -rl company_invites
-- app/ components/` (before this migration) finds only 0008's audit-trail
-- filter list. Live before writing anything here: every one of the 15 rows in
-- company_members today is role='admin' — nobody has ever accepted an invite,
-- because there was no way to. This migration is the accept-flow gap, not new
-- infrastructure: the table, the token column, the 14-day expiry default, the
-- pending-invite partial unique index, guard_last_admin, and the three-role
-- CHECK constraint (admin/accountant/auditor) are all exactly as 0003 left
-- them.
--
-- THE ACTUAL PROBLEM.
-- company_invites_read (0003) is `using (is_company_admin(company_id))` — an
-- invite is only SELECT-able by an admin of the company it belongs to. That
-- is correct for admins browsing their own outstanding invites, and it is
-- exactly what makes the invite unreadable by the one person who most needs
-- to read it: the invitee, who by construction is not yet a member of that
-- company and so is_company_admin() (and is_company_member()) are both false
-- for them no matter what. A raw `select * from company_invites where token
-- = ...` from the invitee's own session returns zero rows under RLS, not the
-- row they hold the secret token for. 0003's own comment anticipated this
-- exactly: "redemption happens through a security-definer RPC that looks the
-- token up server-side, never by letting a client read the invite table."
-- That RPC is accept_company_invite, below — the piece 0003 named but never
-- built.
--
-- WHY THE RPC TAKES A TOKEN, NOT A COMPANY_ID + TOKEN PAIR. The invitee does
-- not know which company invited them until the token tells them — asking for
-- company_id up front would require the very read that RLS blocks. The token
-- is a `uuid` with its own unique index (company_invites_token_idx, 0003),
-- effectively 122 bits of entropy from gen_random_uuid(); that is the whole
-- security boundary here, the same trust model as a password-reset link or a
-- Slack/Notion invite URL. Anyone who *holds* the link becomes the member,
-- not specifically the person whose email address is on the invite row — see
-- accept_company_invite's own comment for why that is a deliberate choice and
-- not an oversight.
--
-- CREATE_COMPANY_INVITE: A GENUINE GAP, NOT A DUPLICATE OF WORKING RLS.
-- company_invites_write (0003) is `for all ... using/with check
-- (is_company_admin(company_id))` — an admin can already INSERT a row
-- directly today; the token, status and expires_at defaults already exist on
-- the column definitions. A thin RPC purely to do that insert would be
-- exactly the kind of duplicate this task says not to write. What a plain
-- client-side insert genuinely cannot do:
--   1. Tell an admin "Priya is already on this team" BEFORE they submit,
--      rather than after a cryptic 23505 from company_invites_pending_unique_
--      idx (which only catches a second *pending invite* for the same email —
--      it says nothing about someone who is already an ACTIVE MEMBER, and
--      inviting an existing member is a confusing thing to let through
--      silently). Answering that needs to resolve an email to a user_id via
--      auth.users, which RLS does not expose to a client at all — no table or
--      view over auth.users exists anywhere in this schema. SECURITY DEFINER
--      is the only way to look one email up, and it is exactly the same
--      privilege boundary get_company_team (below) uses for the same reason.
--   2. Give a human-readable message for the duplicate-pending-invite case
--      instead of a raw constraint-violation string.
-- Everything else about invite creation (which company, expiry, the token
-- itself, the pending-uniqueness guarantee) is left to the columns and the
-- constraint exactly as 0003 defined them; this function does not re-specify
-- any of it, it only adds the two checks above and then does the ordinary
-- insert an admin's own RLS would have allowed anyway.
--
-- GET_COMPANY_TEAM: THE SAME AUTH.USERS PROBLEM, FROM THE OTHER SIDE.
-- "An admin can see current members" (this task's own
-- words) needs to show WHO each member is. public.profiles (0003) carries
-- full_name and avatar_url, populated from raw_user_meta_data ->> 'full_name'
-- at signup — and nothing in this app's sign-up form (app/(auth)/login) ever
-- collects a name; `select full_name from profiles` against the live project
-- returns null for both real accounts that exist today. A member list built
-- from company_members + profiles alone would show two blank rows with no
-- way to tell them apart. Email is the only identifying fact this schema
-- actually has, and — as above — no client-readable table exposes
-- auth.users.email. get_company_team is SECURITY DEFINER for that single
-- reason: to join company_members to auth.users and hand back the email.
-- Gated on is_company_member (not is_company_admin) deliberately, matching
-- profiles_read's own bar (0003: "your own, plus anyone you share a company
-- with") — a name is already visible company-wide today via profiles_read,
-- so putting email behind that identical membership bar, rather than a
-- stricter admin-only one, keeps the two consistent instead of making email
-- a new, narrower privacy class than the name sitting right next to it.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT TOUCH.
--   - member_branches (branch-scoped membership, 0005) — an invite has no
--     branch picker here. A branch-restricted member is still something an
--     admin sets up separately, after the invite is accepted, by writing
--     member_branches rows directly (its own RLS already allows that). Adding
--     that to the invite form is a real feature, not a one-line addition, and
--     it is not in scope for "invite a colleague, they accept, they get a
--     role."
--   - Removing an existing member, or changing an existing member's role.
--     company_members_write (0003) already lets an admin do both directly —
--     no new RPC is needed for either — but no UI ships for it here because
--     the task this migration answers asks for exactly four things: see
--     members, invite, accept, revoke a pending invite. Listed explicitly in
--     scope_deferred/caveats_for_integration so it is not mistaken for an
--     oversight.
--   - Any change to get_compliance_calendar, create_invoice, VoucherForm or
--     InvoiceForm — untouched, per this session's own instructions.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Email format on company_invites — never checked before this migration.
-- ----------------------------------------------------------------------------
-- email has no FK (by design — an invite must work before the invitee has an
-- account, 0003's own comment), so a format check is the only guard against
-- garbage input at all. Table is empty in production today (confirmed live:
-- `select count(*) from company_invites` = 0), so adding this cannot break an
-- existing row. Same pattern as ledgers.email (0006), copied verbatim rather
-- than re-derived so the two do not quietly drift apart.
alter table public.company_invites
  drop constraint if exists company_invites_email_format_check;

alter table public.company_invites
  add constraint company_invites_email_format_check
  check (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');


-- ----------------------------------------------------------------------------
-- get_company_team(company_id) — the roster, with the one fact profiles can't
-- give: an identifying email. See header for why this needs SECURITY DEFINER.
-- ----------------------------------------------------------------------------
create or replace function public.get_company_team(p_company_id uuid)
returns table (
  member_id uuid,
  user_id uuid,
  email text,
  full_name text,
  role text,
  status text,
  member_since timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if not app_private.is_company_member(p_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  return query
    select
      cm.id,
      cm.user_id,
      u.email::text,
      p.full_name,
      cm.role,
      cm.status,
      cm.created_at
    from public.company_members cm
    join auth.users u on u.id = cm.user_id
    left join public.profiles p on p.id = cm.user_id
    where cm.company_id = p_company_id
    order by
      case cm.role when 'admin' then 0 when 'accountant' then 1 else 2 end,
      cm.created_at;
end;
$$;

revoke all on function public.get_company_team(uuid) from public, anon;
grant execute on function public.get_company_team(uuid) to authenticated;

comment on function public.get_company_team is
  'Company roster with email — profiles.full_name is null for every real account in this app today, so email is the only identifying fact available. SECURITY DEFINER solely to read auth.users.email; gated on is_company_member, the same bar profiles_read already uses for full_name. See 0107.';


-- ----------------------------------------------------------------------------
-- create_company_invite(company_id, email, role) — the two checks a plain
-- admin insert genuinely cannot make (see header). Not a replacement for that
-- insert's own permission model: re-checks is_company_admin itself, exactly
-- as company_invites_write already requires, because SECURITY DEFINER means
-- RLS is bypassed and the check has to be made by hand.
-- ----------------------------------------------------------------------------
create or replace function public.create_company_invite(
  p_company_id uuid,
  p_email text,
  p_role text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  v_existing_user_id uuid;
  v_invite_id uuid;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin of this company can send an invite.';
  end if;

  if p_role not in ('admin', 'accountant', 'auditor') then
    raise exception 'Role must be admin, accountant or auditor.';
  end if;

  if v_email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' then
    raise exception 'That does not look like a valid email address.';
  end if;

  -- Resolve the email to an existing account, if one exists — invites also
  -- work for an email with no account yet (0003), so "not found" is not an
  -- error here, only "found AND already an active member of this company" is.
  select id into v_existing_user_id from auth.users where lower(email) = v_email;

  if v_existing_user_id is not null and exists (
    select 1 from public.company_members
    where company_id = p_company_id
      and user_id = v_existing_user_id
      and status = 'active'
  ) then
    raise exception 'This person is already a member of this company.';
  end if;

  if exists (
    select 1 from public.company_invites
    where company_id = p_company_id
      and lower(email) = v_email
      and status = 'pending'
  ) then
    raise exception 'There is already a pending invite for this email — revoke it first to send a new one.';
  end if;

  insert into public.company_invites (company_id, email, role, invited_by)
  values (p_company_id, v_email, p_role, auth.uid())
  returning id into v_invite_id;

  return v_invite_id;
-- Belt-and-suspenders for the race the two pre-checks above cannot fully
-- close (two admins submitting the same email in the same instant):
-- company_invites_pending_unique_idx (0003) is the real guarantee, this just
-- gives it the same friendly wording as the pre-check above instead of a raw
-- constraint name.
exception
  when unique_violation then
    raise exception 'There is already a pending invite for this email — revoke it first to send a new one.';
end;
$$;

revoke all on function public.create_company_invite(uuid, text, text) from public, anon;
grant execute on function public.create_company_invite(uuid, text, text) to authenticated;

comment on function public.create_company_invite is
  'Admin-only invite creation. The insert itself is already legal under company_invites_write RLS; this adds the two checks a plain insert cannot make — already-a-member, and a friendly duplicate-pending message — both of which need to resolve email to auth.users, which RLS never exposes to a client. See 0107.';


-- ----------------------------------------------------------------------------
-- accept_company_invite(token) — the piece 0003 named but never built.
-- ----------------------------------------------------------------------------
-- Deliberately does NOT check that the accepting user's own email matches
-- invite.email. The token itself (effectively 122 bits from
-- gen_random_uuid(), delivered out of band) is the entire security boundary,
-- the same trust model as a password-reset link: whoever holds the link and
-- is signed in redeems it. Requiring an email match would also break the
-- ordinary case of someone who signs up with a different email than the one
-- an admin typed the invite for (a personal vs. work address, a typo an
-- admin can't see, a Google-auth email that differs from what payroll has on
-- file) — this app's sign-in page has no way to pre-lock the sign-up email
-- to the invite's email, so an email-match requirement would just be a
-- second, unrelated way for a legitimate invite to fail. Recorded here and in
-- caveats_for_integration, not silently assumed.
create or replace function public.accept_company_invite(p_token text)
returns table (
  company_id uuid,
  company_name text,
  role text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
-- Without this pragma, the RETURNS TABLE column `company_id` is ALSO an
-- OUT-parameter variable name in scope through the whole body, and it
-- collides with the bare `company_id` in `on conflict (company_id, user_id)`
-- below — ON CONFLICT's target list cannot be table-qualified, so
-- qualification cannot resolve it the way `cm.company_id` would elsewhere.
-- Caught live: applying this function without the pragma raised "column
-- reference company_id is ambiguous" the first time this was hand-verified
-- against the real database, not by inspection. The pragma tells plpgsql to
-- prefer the table column whenever a bare name is ambiguous; nothing in this
-- function ever needs the OUT-parameter reading, so this is safe everywhere.
declare
  v_token uuid;
  v_invite public.company_invites%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'You must be signed in to accept an invite.';
  end if;

  begin
    v_token := p_token::uuid;
  exception
    when invalid_text_representation then
      raise exception 'This invite link is not valid.';
  end;

  -- Row lock: two tabs (or a double-click) hitting accept on the same token
  -- at once must not both succeed as if the invite were unlimited-use.
  select * into v_invite
  from public.company_invites
  where token = v_token
  for update;

  if not found then
    raise exception 'This invite link is not valid.';
  end if;

  if v_invite.status = 'accepted' then
    raise exception 'This invite has already been used.';
  end if;

  if v_invite.status = 'revoked' then
    raise exception 'This invite has been revoked.';
  end if;

  if v_invite.status = 'expired' or v_invite.expires_at <= now() then
    if v_invite.status = 'pending' then
      update public.company_invites set status = 'expired' where id = v_invite.id;
    end if;
    raise exception 'This invite link has expired.';
  end if;

  -- ON CONFLICT DO UPDATE, not DO NOTHING: the one case company_members
  -- (company_id, user_id) can already hold a row for this exact pair is a
  -- previously REVOKED member being re-invited (create_company_invite already
  -- refuses to invite an email that is currently an ACTIVE member, so that is
  -- the only path here). DO NOTHING would leave a rejoining member's row
  -- silently stuck at status='revoked' while telling them acceptance
  -- succeeded — a real access bug, not a hypothetical one. guard_last_admin
  -- (0003) only fires when OLD.status = 'active', so reactivating a revoked
  -- row never trips the last-admin guard.
  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_invite.company_id, v_uid, v_invite.role, 'active', v_invite.invited_by)
  on conflict (company_id, user_id) do update
    set role = excluded.role, status = 'active', updated_at = now();

  update public.company_invites
  set status = 'accepted', accepted_by = v_uid, accepted_at = now()
  where id = v_invite.id;

  return query
    select c.id, c.name, v_invite.role
    from public.companies c
    where c.id = v_invite.company_id;
end;
$$;

revoke all on function public.accept_company_invite(text) from public, anon;
grant execute on function public.accept_company_invite(text) to authenticated;

comment on function public.accept_company_invite is
  'The redemption path company_invites_read (0003) deliberately blocks a client from doing directly: looks up an invite by bearer token (not company_id — the invitee does not know it yet), validates pending/unexpired, and creates the company_members row for the CALLING user, whoever they are signed in as. See 0107 for why no email match is required.';
