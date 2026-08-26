-- ============================================================================
-- 0167 — Email notifications: closing the "manual click" gap 0122 flagged,
-- as far as it can honestly be closed
-- ============================================================================
-- TASK: "automatic dispatch scheduling" for 0122's email notifications —
-- the daily digest already creates 'pending' notification rows on its own
-- (app_private.run_notifications_digest, pg_cron, unattended, unmodified by
-- this migration). What still needs a human is the SEND step: a signed-in
-- admin clicking "Send pending emails" on ONE company's /notifications page,
-- which calls app/api/notifications/send/route.ts.
--
-- RESEARCHED LIVE, NOT ASSUMED: can a Postgres function make the outbound
-- HTTPS POST to Resend itself, cutting the human out of the SEND step too?
--   `select name, default_version, installed_version from
--    pg_available_extensions where name = 'pg_net'` -> exactly one row:
--    {"name":"pg_net","default_version":"0.20.4","installed_version":null}.
--   `select * from pg_extension where extname = 'pg_net'` -> zero rows.
--   pg_net IS available to this Supabase project (it ships on every project
--   as of 2026 per Supabase's own pg_net docs, read live today) but is NOT
--   enabled on THIS project specifically — installed_version is null, no
--   extension row exists. Per this task's own brief: "if pg_net is not
--   available or not enabled, do not attempt to enable a new extension
--   yourself (that is a more invasive infrastructure change)". It is not
--   enabled, so this migration does not run `create extension pg_net` and
--   does not add any net.http_post call anywhere. That is a confirmed fact
--   from this project's own catalog, not a guess.
--
--   For the record, having read Supabase's pg_net docs and the
--   supabase/pg_net GitHub repo live today: IF pg_net were enabled, the
--   approach would work — net.http_post takes a url, a jsonb body and a
--   jsonb headers argument, which is exactly what a Resend POST needs
--   (Authorization: Bearer <key> header, {from,to,subject,text} body), and
--   Supabase Vault would be the place to keep the Resend key out of the
--   function body itself. That is a real, viable follow-up for whoever next
--   touches this feature WITH the authority to enable a new extension on
--   this project — not something this task should do unilaterally.
--
-- SO WHAT DID THIS MIGRATION ACTUALLY BUILD, GIVEN THAT.
--   A cron job that "prepares/dedupes what is pending" already exists —
--   app_private.run_notifications_digest, unmodified since 0122, still the
--   thing that populates the pending queue unattended, once a day, with
--   create_notifications_from_needs_attention's own dedupe constraint doing
--   the "no repeat rows for the same open issue" work. This migration did
--   NOT touch either function: both were re-read in full first and neither
--   needed a change to keep doing that job correctly.
--
--   A genuinely different idea was considered and REJECTED as unsafe:
--   a second cron job that would mark a pending notification "superseded"
--   (never send it) once its underlying issue no longer appears in a fresh
--   call to get_needs_attention. Read get_needs_attention AND
--   get_compliance_calendar's live definitions in full before writing a
--   line of this migration, specifically to check whether that would be
--   safe. It would not be:
--     - get_needs_attention's Receivables rows are `... order by
--       r.days_overdue desc limit 10`. A real overdue invoice ranked 11th
--       would silently drop out of a fresh call the moment 10 worse ones
--       exist — not because it was paid, only because it was outranked. An
--       "expire if absent from a fresh call" job would misfile that as
--       resolved and silently kill a still-true overdue-invoice alert.
--     - get_needs_attention's calendar rows call get_compliance_calendar
--       with a hardcoded 7-day forward window (p_from = current_date,
--       p_to = current_date + 7) and get_compliance_calendar itself is a
--       pure computed due-date schedule with NO awareness of whether the
--       return was actually filed (confirmed reading its live definition —
--       it never touches filing_register or any other "was this done"
--       table). The day after a due date passes, that item falls out of
--       the window and vanishes from get_needs_attention — filed or not.
--       An "expire if absent" job would, within a day or two of almost
--       every compliance deadline, mark the matching pending notification
--       superseded and never send it — precisely destroying the "you are
--       now overdue" alert that mattered most, and doing so silently. That
--       is a worse outcome than the manual-click status quo, not a better
--       one, so it was not built. This is a real, confirmed limitation of
--       get_needs_attention's own design (narrow window, no filed-status
--       check) — recorded here and in scope_deferred, not fixed, since
--       get_needs_attention is explicitly this task's to read, not to
--       modify, and get_compliance_calendar is reserved for the
--       agm-calendar-wiring task in this same batch.
--
--   What this migration DOES add: the send step stays human-triggered (no
--   way around that without pg_net — see above), but the click a human
--   makes is widened from "one company at a time" to "every company this
--   admin administers, in one request" — the real friction this project's
--   OWN live data shows: `select cm.user_id, count(*) from
--   company_members cm where role='admin' and status='active' group by 1
--   order by 2 desc` returns tester@lekha.test as admin of TEN companies,
--   and right now, before this migration touches any data, nine of those
--   ten already sit on pending, unsent notifications (Sharma Textiles
--   alone has 9; the other eight have 1-6 each; see this session's report
--   for the exact live count). An admin in that position — realistically,
--   an accountant who signs in once every few days across every client's
--   books — previously had to open each company's /notifications page and
--   click "Send pending emails" separately, once per company, to fully
--   drain the backlog. get_pending_notification_summary + the /companies
--   page's new "Send pending emails across N companies" action below turns
--   that into the one click the task asked for — genuinely one click,
--   genuinely covering however many days and however many companies have
--   piled up, within the one hard limit that remains: a human still has to
--   be the one to make it.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- get_pending_notification_summary: "which of MY companies have pending
-- email notifications, and how many" — the cross-company counterpart to
-- 0122's get_pending_email_notifications(p_company_id), which stays
-- unmodified (still exactly what resolves ONE company's pending rows to
-- actual send-to addresses; this function only decides WHICH companies to
-- call it for).
-- ----------------------------------------------------------------------------
-- Interactive-only, unlike run_notifications_digest/create_notifications_
-- from_needs_attention which tolerate auth.uid() is null for the cron
-- context (see 0122's header). There is no service-context caller for this
-- one — it exists purely to drive an admin's own "send everywhere" click —
-- so a null auth.uid() is rejected outright rather than treated as trusted.
create or replace function public.get_pending_notification_summary()
returns table(company_id uuid, company_name text, pending_count bigint)
language plpgsql
security definer
set search_path = ''
stable
as $function$
begin
  if auth.uid() is null then
    raise exception 'Must be signed in to view pending notifications';
  end if;

  return query
    select c.id, c.name, count(n.id)
      from public.companies c
      join public.company_members cm
        on cm.company_id = c.id
       and cm.user_id = auth.uid()
       and cm.role = 'admin'
       and cm.status = 'active'
      join public.notifications n
        on n.company_id = c.id
       and n.status = 'pending'
       and n.channel = 'email'
     where c.is_active
     group by c.id, c.name
     order by c.name;
end;
$function$;

comment on function public.get_pending_notification_summary() is
  'Every company the signed-in user actively administers that currently has at least one pending, email-channel notification, with a count. Drives the /companies page''s cross-company "Send pending emails" action (0167) — the per-company send itself still goes through 0122''s get_pending_email_notifications/mark_notification_sent, unmodified.';

revoke all on function public.get_pending_notification_summary() from public, anon;
grant execute on function public.get_pending_notification_summary() to authenticated;
