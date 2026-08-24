-- ============================================================================
-- 0122 — Email transport + a notifications table: somewhere for
-- get_needs_attention's output to actually go
-- ============================================================================
-- CONFIRMED LIVE BEFORE WRITING ANY OF THIS.
--   - package.json's "dependencies" has no mail library at all: no resend,
--     nodemailer, sendgrid, postmark, aws-sdk, or @aws-sdk/client-ses. Grepped
--     just now, zero hits. This app has never sent an email or an SMS.
--   - `select jobname, schedule, command from cron.job` returns exactly one
--     row: 'ensure-audit-partition', monthly, calling
--     app_private.ensure_audit_partition(...) (0021). This migration adds the
--     second job that has ever existed here.
--   - public.get_needs_attention(p_company_id) already exists (0024-era
--     dashboard support) and is read here byte-for-byte, unmodified — this
--     migration does not touch its definition or add a category it doesn't
--     already emit. Read live via pg_get_functiondef just now, its category
--     column takes EXACTLY nine values: the six get_compliance_calendar
--     emits — 'GST', 'TDS', 'TCS', 'Income tax', 'ROC', 'Payroll' — plus its
--     own three aggregate rows — 'Reconciliation', 'Receivables',
--     'Approvals'. notifications.category's CHECK below is exactly that list,
--     not a category invented for this migration.
--
-- WHY THIS IS NEEDED. The dashboard's "Needs your attention" panel
-- (app/(app)/[companyId]/page.tsx) calls get_needs_attention directly, every
-- page load, and throws the result away the moment the tab closes. It is
-- STATELESS (nothing is ever written down) and PULL-ONLY (a user has to be
-- looking at the dashboard, logged in, for the information to reach them at
-- all) — there is no way today for a compliance deadline or an overdue
-- invoice to reach anyone who isn't already staring at the app. This
-- migration does not change what get_needs_attention computes. It gives that
-- computation somewhere real to land: a notifications table that survives
-- the page reload, an email transport that can put the same information in
-- someone's inbox, and a thin function that bridges the two once a day.
--
-- EXPLICITLY OUT OF SCOPE (per the task brief, not an oversight):
--   - No escalation, snoozing, retry backoff, digestion frequency
--     preferences, or "notify me differently for bad vs warn" rules. One
--     digest run a day, one notification row per genuinely new issue, done.
--   - No automatic outbound email dispatch on a schedule. See "WHAT ACTUALLY
--     SENDS AN EMAIL" below for exactly where this stops and why.
--   - No SMS/WhatsApp/push channel — channel is CHECKed to the single value
--     'email' on purpose, so widening it later is a conscious schema change,
--     not an accidental one.
--
-- TRANSPORT CHOICE: RESEND, NOT AWS SES — researched live today (24 Aug
-- 2026), not recalled from training data.
--   Resend: a free plan good for 3,000 emails/month capped at 100/day, one
--   verified domain, sending simply pauses (no surprise overage bill) once
--   the cap is hit; sourced against wpmailsmtp's 2026 Resend review and
--   nuntly's 2026 Resend pricing breakdown, both read today. Setup is a
--   single POST to https://api.resend.com/emails with a bearer token — no
--   SDK needed, so this migration's companion Node code (lib/email/resend.ts)
--   adds zero new npm dependencies, which matters in this tree specifically
--   because package.json/package-lock.json already carry a concurrent
--   session's uncommitted changes (see git status) that a `npm install`
--   here would collide with.
--
--   AWS SES: a second, skeptical search (not just re-confirming the first
--   guess) turned up a real trap the "SES is cheaper at scale" reputation
--   hides: accounts created after 15 July 2025 get NO per-service SES free
--   tier at all — just a one-time ~$200 AWS credit, then $0.10/1,000 emails
--   from the first message (sourced against saaspricepulse's 2026 SES
--   free-tier article and emercury's 2026 SES pricing breakdown, both read
--   today). Worse for a pilot: every new SES account starts in "sandbox"
--   mode, which can only send to email addresses individually VERIFIED in
--   the AWS console first — not just the sender, the recipient too — until
--   AWS Support manually approves a production-access request (~24h, but a
--   real manual step, and AWS now requires a domain with SPF/DKIM/DMARC DNS
--   records in place before that request can even be filed). Sourced
--   against docs.aws.amazon.com/ses/latest/dg/request-production-access.html
--   and oneuptime's 2026 "move out of SES sandbox" walkthrough, both read
--   today. None of that fits "a few companies, a handful of emails a day,
--   no live credentials to provision right now."
--
--   Resend has its own real limitation, also confirmed live and worth being
--   honest about: the zero-setup `onboarding@resend.dev` sender this
--   migration's code falls back to can, until a real domain is verified in
--   the Resend dashboard, ONLY deliver to the email address that signed up
--   for the Resend account — not to arbitrary company admins (sourced
--   against Resend's own "403 Error Using resend.dev Domain" knowledge-base
--   page, read today). That is a real production prerequisite — verifying a
--   domain, a one-time DNS change, is infrastructure this task does not and
--   should not perform — recorded in scope_deferred, not silently assumed
--   away.
--
-- WHAT ACTUALLY SENDS AN EMAIL, AND WHAT DOES NOT. Three layers, on purpose:
--   1. app_private.run_notifications_digest(), on pg_cron, once a day:
--      creates 'pending' notification ROWS. Pure SQL, no network call, can
--      never itself send an email. This is the "thin digest job" the task
--      asked for — nothing more.
--   2. public.get_pending_email_notifications / public.mark_notification_sent:
--      SQL-side read/write for the send step, gated the same way as (3).
--   3. lib/email/resend.ts + app/api/notifications/send/route.ts (Node,
--      this migration's companion, not SQL): actually calls the Resend API
--      and flips pending -> sent/failed. This is invoked by an admin's
--      "Send pending emails" click in the UI, not by anything in this
--      migration — wiring an unattended schedule for step 3 would need
--      either pg_net calling back into this specific deployment's own URL
--      (coupling a portable migration to one environment) or an OS-level
--      cron entry on the production host, and the task brief is explicit
--      that a "full dunning/escalation system" is out of scope. See
--      caveats_for_integration in the session report for the follow-up this
--      leaves open.
--
-- DEDUPE: "category + related_entity_id", exactly as asked, made to work
-- even though get_needs_attention's own rows don't all carry a natural
-- entity id.
--   - 'Receivables' rows do: get_needs_attention's href for that category is
--     literally '/'||company_id||'/vouchers/'||voucher_id, so the real
--     voucher_id is extracted from it (with a regex guard — a malformed href
--     produces null rather than aborting the whole company's digest on a
--     bad cast).
--   - 'Approvals' and 'Reconciliation' are aggregate, company-wide counts
--     with no per-row entity in get_needs_attention's own output — this
--     migration uses the company's own id as the dedupe key, so at most one
--     open "N vouchers pending approval" notification exists per company at
--     a time (a new one is not created just because the count changed from
--     2 to 3; the underlying issue — approvals are backed up — is the same
--     issue).
--   - The six calendar-derived categories (GST/TDS/TCS/Income tax/ROC/
--     Payroll) have no row identity in the schema at all — they are
--     recomputed on the fly by get_compliance_calendar every call, nothing
--     is stored. A deterministic key is derived instead: md5(category ||
--     label || detail)::uuid. Postgres accepts a bare 32-hex-digit string as
--     a uuid literal (confirmed live: `select md5('test')::uuid` returns
--     098f6bcd-4621-d373-cade-4e832627b4f6 without error), so the same
--     (label, detail) pair — e.g. "GSTR-3B — 27ABCDE1234F1Z5" for "Aug 2026"
--     — always hashes to the same id and is deduped, while next month's
--     different detail text is a genuinely new id and a genuinely new
--     notification. This is a dedup KEY, not a real foreign key — there is
--     no row anywhere that owns it, exactly like documents.entity_id (0060)
--     has no FK for the same reason (a polymorphic pointer to something
--     whose type varies row to row).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- notifications
-- ----------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- Null = a company-wide notification, addressed at send time to every
  -- active admin of the company (see get_pending_email_notifications below)
  -- rather than to one person. Every row this migration's own generator
  -- writes is null here; a populated value is left for a future feature that
  -- targets one specific person (e.g. "the approver") — set null on delete
  -- rather than cascade, so the notification itself (a record that a
  -- compliance issue existed on a given date) survives that person leaving.
  recipient_user_id uuid references auth.users(id) on delete set null,
  channel text not null default 'email' check (channel = 'email'),
  -- Exactly get_needs_attention's own nine category values, read live from
  -- its current definition (see this migration's header) — not a list
  -- invented here. A category get_needs_attention starts emitting later
  -- that isn't in this list is a deliberate trip-wire: the insert in
  -- create_notifications_from_needs_attention fails loudly (caught per-
  -- company by run_notifications_digest's own exception handler, logged as
  -- a warning) rather than silently mis-filing an unrecognised issue.
  category text not null check (category in (
    'GST', 'TDS', 'TCS', 'Income tax', 'ROC', 'Payroll',
    'Reconciliation', 'Receivables', 'Approvals'
  )),
  subject text not null check (length(trim(subject)) > 0),
  body_summary text not null check (length(trim(body_summary)) > 0),
  -- Polymorphic, like documents.entity_type/entity_id (0060) — no FK is
  -- possible here for the same reason: what related_entity_id points at
  -- varies by row. 'compliance_item' covers the six calendar-derived
  -- categories, which have no real row to point at at all (see header).
  related_entity_type text check (
    related_entity_type is null
    or related_entity_type in ('voucher', 'company', 'compliance_item')
  ),
  related_entity_id uuid,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_sent_at_check check (status <> 'sent' or sent_at is not null)
);

-- The dedupe key itself: "one open notification per (company, category,
-- underlying issue)". Partial (WHERE related_entity_id is not null) because
-- every row this migration's own generator writes always supplies one (see
-- header) — a hypothetical future manually-created notification with no
-- entity to point at is simply not deduped by this index, which is correct:
-- nothing about it is unresolved-by-repetition the way a recurring
-- compliance item is.
create unique index notifications_dedupe_uidx
  on public.notifications (company_id, category, related_entity_id)
  where related_entity_id is not null;

create index notifications_recipient_idx
  on public.notifications (recipient_user_id)
  where recipient_user_id is not null;

create index notifications_company_status_idx
  on public.notifications (company_id, status);

alter table public.notifications enable row level security;

-- Defense-in-depth in the exact spirit of 0021's F5 finding: RLS alone
-- already denies anon everything (no policy below grants it anything), but
-- an unused table-level grant sitting there is one fewer thing that has to
-- go wrong before a future accidental policy could leak this table.
revoke all on public.notifications from anon;

-- Read-only for authenticated: recipient sees their own; a company admin
-- sees every notification for their company regardless of recipient
-- (including the null-recipient, "addressed to whichever admin reads it
-- first" rows this migration's own generator always creates). No
-- insert/update/delete policy exists for authenticated at all — every write
-- happens through the SECURITY DEFINER functions below, never a direct
-- client insert.
create policy notifications_read on public.notifications
  for select to authenticated
  using (
    recipient_user_id = auth.uid()
    or (select app_private.is_company_admin(company_id))
  );

comment on table public.notifications is
  'One row per notification the app has generated or will generate — the persistent record get_needs_attention (stateless, pull-only) has never had. Populated only by create_notifications_from_needs_attention below (or a future targeted equivalent); no direct client INSERT policy exists. status tracks EMAIL DELIVERY, not read/unread — this table does not track whether a person has seen a notification, only whether the app has sent it. See 0122.';
comment on column public.notifications.recipient_user_id is
  'Null = addressed to every active admin of the company (resolved at send time, see get_pending_email_notifications) rather than one person. Every auto-generated row is null; a specific value is reserved for a future per-person targeting feature this migration does not build.';
comment on column public.notifications.related_entity_id is
  'A dedupe key, not always a real foreign key — see the table comment and this migration''s header for how it is derived per category (a real voucher_id for Receivables, the company''s own id for the two aggregate categories, a deterministic hash for the six calendar-derived categories that have no row of their own).';


-- ----------------------------------------------------------------------------
-- create_notifications_from_needs_attention: the digest, per company
-- ----------------------------------------------------------------------------
-- Reads get_needs_attention (unmodified — see header) for one company and
-- inserts one notification row per item that is not already an open,
-- unresolved duplicate. Returns the count actually inserted, so both the
-- UI's "Generate now" button and this session's live verification can report
-- a real number rather than eyeballing row counts.
--
-- auth.uid() IS NULL is treated as the trusted, service-context caller
-- (pg_cron's job runs as the 'postgres' superuser, which never has a JWT and
-- so always sees auth.uid() = null here) — the INVERSE of 0014's own
-- `if auth.uid() is null then raise exception` pattern, deliberately: 0014
-- guards a function only a logged-in human should ever call, this one is
-- also the payload of a scheduled job that has no human attached to it at
-- all. A real logged-in caller who is not that company's admin is still
-- rejected.
create or replace function public.create_notifications_from_needs_attention(p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_inserted int;
begin
  if auth.uid() is not null and not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can generate notifications for this company';
  end if;

  with candidates as (
    select
      r.category,
      r.label,
      r.detail,
      r.severity,
      case
        when r.category = 'Receivables' then 'voucher'
        when r.category in ('Approvals', 'Reconciliation') then 'company'
        else 'compliance_item'
      end as related_entity_type,
      case
        -- get_needs_attention's Receivables href is always exactly
        -- '/'||company_id||'/vouchers/'||voucher_id (see
        -- get_overdue_receivables via get_needs_attention) — the regex
        -- guard means a future change to that shape produces null (no
        -- notification for that one row) rather than a cast error that
        -- would abort every OTHER category's rows in the same company too.
        when r.category = 'Receivables' and r.href ~ '^/[0-9a-fA-F-]{36}/vouchers/([0-9a-fA-F-]{36})$'
          then split_part(r.href, '/', 4)::uuid
        when r.category = 'Receivables' then null
        when r.category in ('Approvals', 'Reconciliation') then p_company_id
        else md5(r.category || '|' || r.label || '|' || coalesce(r.detail, ''))::uuid
      end as related_entity_id
    from public.get_needs_attention(p_company_id) r
  ),
  ins as (
    insert into public.notifications (
      company_id, recipient_user_id, channel, category, subject, body_summary,
      related_entity_type, related_entity_id, status)
    select
      p_company_id,
      null,
      'email',
      c.category,
      c.category || ': ' || c.label,
      coalesce(c.detail, 'No further detail available.') ||
        (case c.severity when 'bad' then ' — overdue, needs action now.' else ' — coming up, worth a look.' end),
      c.related_entity_type,
      c.related_entity_id,
      'pending'
    from candidates c
    where c.related_entity_id is not null
    on conflict (company_id, category, related_entity_id) where related_entity_id is not null
    do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return coalesce(v_inserted, 0);
end;
$function$;

comment on function public.create_notifications_from_needs_attention(uuid) is
  'Reads get_needs_attention (unmodified) for one company and inserts one notifications row per item not already an open duplicate (deduped on category + a derived related_entity_id — see 0122''s header). Returns the count of rows actually inserted. Called per-company by app_private.run_notifications_digest on the daily cron schedule, and directly by an admin''s "Generate now" action in the UI.';

revoke all on function public.create_notifications_from_needs_attention(uuid) from public, anon;
grant execute on function public.create_notifications_from_needs_attention(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- app_private.run_notifications_digest: the pg_cron payload
-- ----------------------------------------------------------------------------
-- Loops every active company and calls the function above for each,
-- isolating one company's failure (a check-constraint trip-wire, a bad cast
-- that slipped past the regex guard, anything) from every other company's
-- run — logged as a warning, not a job-wide abort. NOT granted to
-- authenticated, and the revoke below is NOT redundant here the way it
-- would be in public — confirmed live via pg_default_acl that THIS
-- project's app_private schema carries its own default ACL
-- (`{authenticated=X/postgres}`, distinct from public schema's own default
-- ACL that names anon/authenticated/service_role all at once) that grants
-- every brand-new app_private function EXECUTE to authenticated
-- automatically, on creation, with no ALTER DEFAULT PRIVILEGES statement
-- anywhere in this migration — almost certainly so the app_private.is_*
-- helper functions RLS policies call (is_company_admin, is_company_member)
-- work without a grant line each; a side effect this function inherits
-- unless explicitly revoked. Without the explicit revoke below,
-- has_function_privilege('authenticated', 'app_private.run_notifications_
-- digest()', 'EXECUTE') is true (confirmed live before this line existed)
-- despite no GRANT statement anywhere granting it. The impact of leaving
-- that in place would have been small, not zero: create_notifications_from_
-- needs_attention's own per-company admin check still holds since auth.uid()
-- is read from the session's JWT regardless of SECURITY DEFINER, so a non-
-- admin caller could not have written into a company they don't administer
-- — only wastefully looped every active company on the server's behalf.
-- Revoked anyway, to make the grant actually match this function's own
-- "service-context only" design rather than relying on that inner check as
-- an accidental second line of defence. pg_cron itself runs as the
-- 'postgres' role (cron.job.username, confirmed live) — a superuser bypasses
-- grants entirely, so no explicit grant is needed for the schedule below to
-- actually run it.
create or replace function app_private.run_notifications_digest()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company record;
begin
  for v_company in select id from public.companies where is_active loop
    begin
      perform public.create_notifications_from_needs_attention(v_company.id);
    exception when others then
      raise warning 'notifications digest failed for company %: %', v_company.id, sqlerrm;
    end;
  end loop;
end;
$function$;

comment on function app_private.run_notifications_digest() is
  'The pg_cron payload (job "notifications-digest", 02:30 UTC / ~08:00 IST daily): calls create_notifications_from_needs_attention for every active company, catching and logging each company''s failure independently rather than aborting the whole run. Deliberately revoked from authenticated (app_private''s own default ACL grants it automatically otherwise — see the comment above this function) — see 0122''s header.';

-- authenticated is named explicitly here, unlike the public-schema
-- functions below — see the long comment above this function for exactly
-- why that is necessary in this schema and was not a copy-paste accident.
revoke all on function app_private.run_notifications_digest() from public, anon, authenticated;

select cron.schedule(
  'notifications-digest',
  '30 2 * * *',
  $$ select app_private.run_notifications_digest(); $$
);


-- ----------------------------------------------------------------------------
-- get_pending_email_notifications / mark_notification_sent: the send step
-- ----------------------------------------------------------------------------
-- Pure SQL-side halves of the Node-side send flow (lib/email/resend.ts,
-- app/api/notifications/send/route.ts) — resolving WHO to email lives here,
-- not in application code, the same way this schema already keeps every
-- other piece of "who is allowed to see/do this" logic in Postgres rather
-- than duplicating it in TypeScript. Neither function sends anything itself;
-- get_pending_email_notifications only reads, mark_notification_sent only
-- flips a status the Node caller already knows the outcome of.
create or replace function public.get_pending_email_notifications(p_company_id uuid)
returns table(notification_id uuid, to_email text, subject text, body_summary text)
language plpgsql
security definer
set search_path = ''
stable
as $function$
begin
  if auth.uid() is not null and not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can view pending notifications for this company';
  end if;

  return query
    with pending as (
      select p.id, p.recipient_user_id, p.company_id, p.subject, p.body_summary
        from public.notifications p
       where p.status = 'pending' and p.channel = 'email' and p.company_id = p_company_id
    )
    -- Explicitly addressed rows (recipient_user_id set): exactly that person.
    select p.id, u.email::text, p.subject, p.body_summary
      from pending p
      join auth.users u on u.id = p.recipient_user_id
     where p.recipient_user_id is not null
    union all
    -- Company-wide rows (recipient_user_id null): every active admin.
    select p.id, u.email::text, p.subject, p.body_summary
      from pending p
      join public.company_members cm
        on cm.company_id = p.company_id and cm.role = 'admin' and cm.status = 'active'
      join auth.users u on u.id = cm.user_id
     where p.recipient_user_id is null;
end;
$function$;

comment on function public.get_pending_email_notifications(uuid) is
  'Resolves pending, email-channel notifications for one company to actual (notification_id, to_email) pairs — a null recipient_user_id expands to every active admin of the company, a set one resolves to exactly that person. Read-only; the Node-side send route (app/api/notifications/send) calls this, sends via Resend, then calls mark_notification_sent per row.';

revoke all on function public.get_pending_email_notifications(uuid) from public, anon;
grant execute on function public.get_pending_email_notifications(uuid) to authenticated;

create or replace function public.mark_notification_sent(p_notification_id uuid, p_success boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id from public.notifications where id = p_notification_id;
  if v_company_id is null then
    raise exception 'Notification % not found', p_notification_id;
  end if;

  if auth.uid() is not null and not app_private.is_company_admin(v_company_id) then
    raise exception 'Only a company admin can update this notification';
  end if;

  update public.notifications
     set status = case when p_success then 'sent' else 'failed' end,
         sent_at = case when p_success then now() else sent_at end
   where id = p_notification_id;
end;
$function$;

comment on function public.mark_notification_sent(uuid, boolean) is
  'Records the outcome of one attempted send: true -> status ''sent'', sent_at = now(); false -> status ''failed'', sent_at left untouched. Called by the Node-side send route once per (notification, recipient) attempt — see get_pending_email_notifications.';

revoke all on function public.mark_notification_sent(uuid, boolean) from public, anon;
grant execute on function public.mark_notification_sent(uuid, boolean) to authenticated;
