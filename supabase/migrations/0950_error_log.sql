-- ============================================================================
-- 0950 — error_log: what actually went wrong, readable without a terminal
-- ============================================================================
-- THE INCIDENT THIS EXISTS FOR. Bill capture failed for the owner of this app
-- and the screen said "The vision service could not process this file right
-- now." The real cause — Google answering 503 "This model is currently
-- experiencing high demand" — existed only as a console.error in the server
-- journal on the Oracle Cloud box, reachable only over SSH. The owner is not
-- technical. They had no way to learn that nothing was broken, nothing was
-- lost, and the fix was to try again in a minute. That is the whole problem:
-- this app already knew the answer and had nowhere to put it.
--
-- WHAT THIS IS NOT. public.audit_log (0008) is a statutory record under Rule
-- 3(1) of the Companies (Accounts) Rules 2014 — an append-only trail of DATA
-- CHANGES that an auditor must be able to report on, that may never be
-- switched off, and that nothing may amend. Application failures are not data
-- changes. Writing "Google returned 503" into audit_log would pollute a
-- statutory artefact with operational noise and hand an auditor rows that
-- correspond to no change in the books at all. audit_log is not touched by
-- this migration in any way; error_log is a separate, ordinary, prunable
-- operational table with none of audit_log's guarantees, and it deliberately
-- makes none of audit_log's promises.
--
-- ---------------------------------------------------------------------------
-- WHY NOT PARTITIONED, AND WHAT BOUNDS THE GROWTH INSTEAD
-- ---------------------------------------------------------------------------
-- audit_log is partitioned monthly because it is statutory (retained for
-- years, never pruned) and grows with every INSERT/UPDATE/DELETE on the
-- posting tables — many rows per voucher, unbounded by design. error_log is
-- the opposite on both counts: errors are exceptional rather than
-- proportional to normal use, and nothing requires retaining them. Monthly
-- partitioning would buy nothing here and would cost real maintenance —
-- 0008 needs app_private.secure_audit_partition precisely BECAUSE RLS does
-- not cascade from a partitioned parent to its partitions and PostgREST
-- exposes every partition as its own endpoint, so each new month is another
-- surface that has to be secured correctly or it leaks. Taking that on for a
-- table expected to hold thousands of rows, not millions, would be adding a
-- security-critical moving part to save nothing.
--
-- Growth is bounded two ways instead, both implemented below rather than
-- left as an intention:
--   1. COLLAPSE ON REPEAT. app_private.write_error_log does not insert a
--      second row for an identical (company, operation, severity, message)
--      failure seen within the last 5 minutes — it bumps repeat_count and
--      last_seen_at on the row already there. A model outage that fails 400
--      requests in a row therefore produces ONE row saying it happened 400
--      times, which is both a hard cap on flood-writes and a strictly better
--      thing for a non-technical reader to look at than 400 identical lines.
--      occurred_at is first-seen and never moves; last_seen_at, detail and
--      context are refreshed to the most recent occurrence, because someone
--      reading this while retrying wants the CURRENT detail next to a count
--      of how long it has been going on.
--   2. PRUNE AT 90 DAYS. app_private.prune_error_log deletes rows whose
--      last_seen_at is older than the retention window, scheduled nightly on
--      pg_cron below (the same mechanism 0021 and 0122 already use in this
--      database). 90 days is chosen to comfortably outlive "it broke
--      sometime last quarter, what was it" without accumulating forever. A
--      row still actively repeating is not pruned, because the prune keys on
--      last_seen_at rather than occurred_at.
--
-- ---------------------------------------------------------------------------
-- WHO MAY READ THIS — AND THE RULE FOR ROWS THAT BELONG TO NO COMPANY
-- ---------------------------------------------------------------------------
-- These messages can reveal system internals: which third-party services this
-- app calls, what they answered, which internal RPC refused a write. That is
-- exactly what makes them useful and exactly what makes them worth scoping
-- tightly. The rule implemented below, in full:
--
--   * A row WITH a company_id is visible to an ADMIN of that company, and to
--     nobody else. Not accountants, not auditors. Auditors are deliberately
--     excluded even though 0008 grants them audit_log: their role exists to
--     review the statutory record of data changes, and an application failure
--     is not part of that record. Accountants are excluded because the person
--     who needs to decide "is this my problem or the vendor's" is the person
--     who owns the account — which is precisely who asked for this screen.
--   * A row with NO company_id but WITH a user_id is visible only to THAT
--     USER. This is the support-chat case: that route is mounted above
--     company selection and genuinely has no company to attribute a failure
--     to. Such a row is never visible to a company admin on the strength of
--     being an admin — only to the one person the failure actually happened
--     to. An admin of company A therefore can never see a failure that
--     happened to a member of company B, which is the cross-tenant leak this
--     rule exists to make impossible.
--   * A row with NEITHER a company nor a user is visible to NOBODY through
--     this application. This is the inbound-webhook case — a WhatsApp
--     delivery that failed before anything was known about whose bill it was.
--     Such a row still carries real third-party data (a sender's phone
--     number, another tenant's vendor's document) and there is no role in
--     this app that legitimately spans tenants, so there is no policy that
--     makes it readable and none is invented here. It exists for an operator
--     with direct database access, and the /error-log screen says so in
--     plain words rather than quietly implying the list is complete.
--
-- get_error_log below enforces the same thing a second, independent way: it
-- filters to `company_id = p_company_id or (company_id is null and user_id =
-- auth.uid())` in its own WHERE clause, so a future mistake in the RLS policy
-- and a future mistake in the RPC would BOTH have to happen for a global row
-- to reach the wrong reader.
--
-- ---------------------------------------------------------------------------
-- REDACTION — THE POINT OF THE WHOLE FEATURE, AND WHY IT IS IN TWO PLACES
-- ---------------------------------------------------------------------------
-- This app calls Gemini with the API key IN THE URL QUERY STRING
-- (generativelanguage.googleapis.com/...:generateContent?key=SECRET — see
-- app/api/support-chat/route.ts). It sends Resend a bearer token in a header.
-- A naive log of a failed fetch — the URL, the error's message, a stack —
-- writes a live credential into a table an admin can read, and from there
-- into every screenshot they send to whoever is helping them. A log that
-- leaks the key is worse than no log.
--
-- The PRIMARY redactor is lib/errors/redact.ts, in TypeScript, on the server,
-- and it runs BEFORE anything leaves the process: literal values of every
-- secret-shaped environment variable, then query-string and JSON key/value
-- secrets, then known credential shapes (Google AIza… keys, JWTs, Resend
-- re_…, Meta EAA…, sk-…), then any long mixed-case high-entropy run. It is
-- unit-tested against a realistic Google key embedded in a real Gemini URL.
--
-- app_private.redact_error_text below is a deliberate SECOND line, not a
-- duplicate of the first. It catches only the three highest-value shapes
-- (Google keys, JWTs, and `<secret-word>=value` in a URL or JSON) and it runs
-- inside the database on every single write, including one made by a future
-- caller who forgot the TypeScript helper, or by hand in psql, or by the
-- anon-reachable entry point below. It is narrower than the TypeScript
-- redactor on purpose: keeping two full implementations in sync is how they
-- drift apart, whereas a small backstop that can only ever over-redact is
-- safe to leave alone.
--
-- ---------------------------------------------------------------------------
-- WHY THERE ARE TWO WRITE ENTRY POINTS, AND WHY ONE OF THEM IS ANON
-- ---------------------------------------------------------------------------
-- This repo has no service_role key and, per .env.local's own comment, must
-- never have one. app/api/whatsapp/webhook/route.ts therefore runs in an anon
-- Supabase context by necessity — an inbound Meta delivery carries no session
-- — and it is one of the paths whose failures are least visible and most
-- worth recording. So:
--
--   public.log_error        — granted to authenticated only, the ordinary
--                             convention. Attributes to a company the caller
--                             is actually a member of (it RAISES otherwise
--                             rather than silently writing an invisible row),
--                             and stamps user_id from auth.uid(), never from
--                             the argument.
--   public.log_error_global — granted to anon AND authenticated, the narrow
--                             exception. It CANNOT write a company_id at all
--                             (hardcoded null, not a defaulted argument), it
--                             accepts only operation codes on a short
--                             allowlist, it truncates the message it is
--                             given, and it stops writing entirely past 50
--                             rows for that operation in the trailing hour.
--                             Everything it can produce is, by the read rule
--                             above, invisible to every user of the
--                             application — so the worst an attacker holding
--                             the publishable key can do with it is write
--                             rows nobody will ever be shown, at a bounded
--                             rate, that the nightly prune removes.
--
-- Both funnel through app_private.write_error_log, which is where redaction,
-- collapse-on-repeat and every column default actually happen — so neither
-- entry point can skip them.
--
-- ---------------------------------------------------------------------------
-- DELIBERATELY NOT DONE HERE (named, not silently omitted)
-- ---------------------------------------------------------------------------
--   * NO enumerated CHECK on the operation code. The obvious design is
--     `check (operation in ('capture_vision', 'support_chat', …))`, and it is
--     wrong here for a specific reason: the write helper is required never to
--     throw, so a constraint violation would not fail loudly — it would be
--     swallowed into a console.error and produce SILENCE exactly when someone
--     was trying to add logging to a new place. The column is constrained on
--     FORMAT instead (lowercase snake_case, 3–40 chars) and the screen carries
--     the plain-language label map with a graceful fallback, so an unlabelled
--     new code degrades to showing the code itself rather than to nothing.
--   * NO delete/dismiss/acknowledge. An admin cannot clear their company's
--     errors from the UI. Age handles it. Adding a "mark as read" flag is a
--     reasonable next feature; letting someone delete the record of a failure
--     they are being asked about is not obviously one, so neither is built.
--   * NO alerting. Nothing here emails, notifies or escalates. This is a
--     place to look, not a thing that shouts. Wiring 'critical' rows into the
--     existing notifications table (0122) is a coherent follow-up and is not
--     assumed here.
--   * NO capture instrumentation. lib/capture/analyze.ts — the file from the
--     incident itself — is being edited by a concurrent session and is not
--     touched by this work. See this task's report for the exact one-line
--     call to add.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. error_log
-- ----------------------------------------------------------------------------
create table public.error_log (
  id uuid primary key default gen_random_uuid(),

  -- First seen. Never moves once written — a collapsed repeat updates
  -- last_seen_at instead, so "when did this start" survives a flood.
  occurred_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  repeat_count integer not null default 1 check (repeat_count >= 1),

  -- Stable short code identifying WHICH operation failed: capture_vision,
  -- support_chat, email_send, whatsapp_webhook, pdf_export, … Format-checked
  -- only, never against an enumerated list — see the migration header for why
  -- an enumerated CHECK would turn a typo into silence rather than a failure.
  operation text not null check (operation ~ '^[a-z][a-z0-9_]{2,39}$'),

  -- Three levels, no 'info'. An error log with informational rows in it is a
  -- mislabelled table, and the reader here is a non-technical owner deciding
  -- whether something needs their attention:
  --   warning  — degraded but handled; nothing was lost.
  --   error    — this one action failed; the user saw something not work.
  --   critical — something is broken and will keep failing until touched.
  severity text not null default 'error'
    check (severity in ('warning', 'error', 'critical')),

  -- Plain language, written for the owner, not for a developer. Capped rather
  -- than unbounded because it is rendered as a headline on the screen and,
  -- via log_error_global, can originate outside this app's own code.
  message text not null check (length(message) between 1 and 500),

  -- The raw upstream text — status line, provider message, exception string.
  -- Shown collapsed behind a disclosure on the screen, never as the headline.
  -- Redacted by app_private.redact_error_text on the way in, on top of
  -- whatever lib/errors/redact.ts already did.
  detail text,

  -- NULLABLE on purpose: a failure can happen before any company is known —
  -- an inbound WhatsApp webhook, or the company-agnostic support chat. See
  -- the header for exactly who can and cannot then read the row.
  company_id uuid references public.companies(id) on delete cascade,

  -- Always stamped from auth.uid() by the write helpers, never trusted from
  -- an argument. Null for a genuinely unauthenticated failure.
  user_id uuid references auth.users(id) on delete set null,

  -- Safe structured context: which route, which model, which status code.
  -- Every string value in it is redacted like the rest. Nothing here is
  -- interpreted by the database.
  context jsonb not null default '{}'::jsonb
);

-- Serves both the read RPC's (company, optional operation, newest first) and
-- the write helper's collapse lookup.
create index error_log_company_operation_time_idx
  on public.error_log (company_id, operation, last_seen_at desc);

-- The user's own company-less rows: the support-chat case, and the read RPC's
-- second branch.
create index error_log_user_time_idx
  on public.error_log (user_id, last_seen_at desc)
  where company_id is null;

-- The nightly prune's scan.
create index error_log_last_seen_idx on public.error_log (last_seen_at);

comment on table public.error_log is
  'Operational record of application failures, written so a non-technical owner can read what went wrong at /[companyId]/error-log without SSH. NOT audit_log: this is not statutory, carries none of Rule 3(1)''s guarantees, and is pruned at 90 days. company_id is null for a failure that happened before any company was known; see 0950 for the exact rule on who may then read it (nobody, unless it was their own).';

comment on column public.error_log.operation is
  'Stable short code for what was being attempted (capture_vision, support_chat, email_send, whatsapp_webhook, pdf_export, …). Format-checked, deliberately NOT checked against an enumerated list — see 0950.';

comment on column public.error_log.repeat_count is
  'How many times this identical failure was seen. app_private.write_error_log collapses an identical (company, operation, severity, message) repeat inside a 5-minute window onto the existing row instead of inserting again, so an outage is one row with a count, not thousands of rows.';

comment on column public.error_log.detail is
  'Raw upstream/technical text, redacted twice on the way in (lib/errors/redact.ts, then app_private.redact_error_text). Shown collapsed on the screen, never as the headline.';


-- ----------------------------------------------------------------------------
-- 2. app_private.redact_error_text — the in-database backstop
--
--    NOT the primary redactor. lib/errors/redact.ts is far more thorough and
--    runs first, in the server process, before the text is ever sent here.
--    This exists so that a caller who forgets that helper — or writes a row
--    by hand, or comes in through the anon entry point — still cannot land a
--    live credential in a table an admin will screenshot. It handles only the
--    three shapes that matter most and can only ever over-redact. See the
--    migration header for why it is deliberately narrower than its
--    TypeScript counterpart rather than a second full copy of it.
-- ----------------------------------------------------------------------------
create or replace function app_private.redact_error_text(p_text text)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v text := p_text;
begin
  if v is null then
    return null;
  end if;

  -- Google API keys: literal "AIza" + 35 chars of the URL-safe alphabet.
  -- This is the exact shape of GOOGLE_API_KEY in this deployment, and the
  -- exact thing the Gemini URL carries in ?key=.
  v := regexp_replace(v, 'AIza[0-9A-Za-z_-]{35}', '[redacted:google-api-key]', 'g');

  -- JWTs — Supabase publishable/secret keys and any bearer token of that
  -- shape. Three dot-separated base64url segments starting with the
  -- "{"alg":" header prefix every JWT begins with.
  v := regexp_replace(
         v,
         'eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}',
         '[redacted:jwt]', 'g');

  -- Authorization: Bearer <token> / Basic <token>.
  --
  -- THIS MUST RUN BEFORE THE <secret-word>=<value> RULE BELOW, and the
  -- reason is a real bug caught by testing this function live rather than by
  -- reading it. Run the other way round, the word rule matches
  -- "Authorization:" and treats the literal word "Bearer" as the value —
  -- producing "Authorization: [redacted] re_8Kd93JsLmQp2Xv7bNr4Tz1Wc", i.e.
  -- redacting the word "Bearer" and leaving the actual credential sitting in
  -- the clear immediately after it. Ordering is load-bearing here.
  v := regexp_replace(
         v,
         '((?:^|[[:space:]:"''])(?:bearer|basic)[[:space:]]+)[A-Za-z0-9._~+/=-]{8,}',
         '\1[redacted]', 'gi');

  -- <secret-word>=<value> / "<secret-word>": "<value>", in a query string, a
  -- JSON body or a log line. The leading character class anchors the word so
  -- "monkey=" and "tokenizer:" are not mistaken for "key=" and "token:".
  --
  -- The value is matched with a POSITIVE character class rather than a
  -- negated one: a negated class would need `]` and `}` inside it, whose
  -- placement rules inside a POSIX bracket expression are a well-known way to
  -- write a regex that silently means something else. This class covers every
  -- character a real credential or URL-encoded value uses, and stops of its
  -- own accord at `&`, a quote, a brace or whitespace.
  --
  -- The lookahead keeps this rule off a scheme word the Bearer/Basic rule
  -- above has already dealt with, so the output reads "Authorization: Bearer
  -- [redacted]" rather than redacting the scheme word a second time.
  v := regexp_replace(
         v,
         '((?:^|[?&#;,{[:space:]"''(])(?:api[_-]?key|apikey|key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|signature|auth|authorization)["'']?[[:space:]]*[=:][[:space:]]*["'']?)(?![Bb]earer[[:space:]]|[Bb]asic[[:space:]])[A-Za-z0-9._~%+/=-]{6,}',
         '\1[redacted]', 'gi');

  return v;
end;
$fn$;

revoke all on function app_private.redact_error_text(text) from public, anon, authenticated;

comment on function app_private.redact_error_text(text) is
  'Second-line credential scrub applied to every error_log message/detail/context string on write. Handles Google AIza… keys, JWTs, <secret-word>=value pairs and Bearer/Basic headers. The primary, more thorough redactor is lib/errors/redact.ts, which runs first in the server process — this one exists to catch a caller that skipped it. See 0950.';


-- ----------------------------------------------------------------------------
-- 3. app_private.redact_error_context — the same scrub, over a jsonb's
--    string leaves. Keys are left alone (they are field names this app
--    chooses, not values); every string value at any depth is redacted.
-- ----------------------------------------------------------------------------
create or replace function app_private.redact_error_context(p_context jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_key text;
  v_val jsonb;
  v_out jsonb;
  v_elem jsonb;
begin
  if p_context is null then
    return '{}'::jsonb;
  end if;

  case jsonb_typeof(p_context)
    when 'string' then
      return to_jsonb(app_private.redact_error_text(p_context #>> '{}'));
    when 'object' then
      v_out := '{}'::jsonb;
      for v_key, v_val in select * from jsonb_each(p_context) loop
        v_out := v_out || jsonb_build_object(v_key, app_private.redact_error_context(v_val));
      end loop;
      return v_out;
    when 'array' then
      v_out := '[]'::jsonb;
      for v_elem in select * from jsonb_array_elements(p_context) loop
        v_out := v_out || jsonb_build_array(app_private.redact_error_context(v_elem));
      end loop;
      return v_out;
    else
      -- number, boolean, null — nothing to scrub.
      return p_context;
  end case;
end;
$fn$;

revoke all on function app_private.redact_error_context(jsonb) from public, anon, authenticated;

comment on function app_private.redact_error_context(jsonb) is
  'Applies app_private.redact_error_text to every string leaf of an error_log context jsonb, at any depth. Object keys are left alone — they are field names this app chooses, not values. See 0950.';


-- ----------------------------------------------------------------------------
-- 4. app_private.write_error_log — the one place a row is actually written.
--    Both public entry points funnel through here, so neither can skip
--    redaction, collapse-on-repeat, or the user_id stamp.
-- ----------------------------------------------------------------------------
create or replace function app_private.write_error_log(
  p_operation text,
  p_message text,
  p_severity text,
  p_detail text,
  p_company_id uuid,
  p_context jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_message text;
  v_detail text;
  v_context jsonb;
  v_severity text;
  v_existing uuid;
begin
  v_severity := coalesce(nullif(lower(trim(p_severity)), ''), 'error');
  if v_severity not in ('warning', 'error', 'critical') then
    v_severity := 'error';
  end if;

  -- Redact BEFORE truncating, so a credential sitting near the cut is
  -- replaced by its marker rather than sliced into a still-usable prefix.
  v_message := left(app_private.redact_error_text(
                      coalesce(nullif(trim(p_message), ''), 'Something went wrong.')), 500);
  v_detail := left(app_private.redact_error_text(p_detail), 4000);
  v_context := app_private.redact_error_context(coalesce(p_context, '{}'::jsonb));

  -- Collapse an identical failure seen in the last 5 minutes onto the row
  -- already there — see the migration header. `is not distinct from` rather
  -- than `=` so the global (company_id is null) rows collapse too.
  select id into v_existing
    from public.error_log
   where company_id is not distinct from p_company_id
     and operation = p_operation
     and severity = v_severity
     and message = v_message
     and last_seen_at > now() - interval '5 minutes'
   order by last_seen_at desc
   limit 1;

  if v_existing is not null then
    update public.error_log
       set repeat_count = repeat_count + 1,
           last_seen_at = now(),
           -- Refreshed to the latest occurrence: someone reading this while
           -- retrying wants the current detail beside the count. occurred_at
           -- deliberately stays at first-seen.
           detail = v_detail,
           context = v_context
     where id = v_existing;
    return v_existing;
  end if;

  insert into public.error_log (
    operation, severity, message, detail, company_id, user_id, context
  ) values (
    p_operation, v_severity, v_message, v_detail, p_company_id,
    (select auth.uid()), v_context
  )
  returning id into v_existing;

  return v_existing;
end;
$fn$;

revoke all on function app_private.write_error_log(text, text, text, text, uuid, jsonb)
  from public, anon, authenticated;

comment on function app_private.write_error_log is
  'The only place an error_log row is written. Redacts message/detail/context, normalises severity, stamps user_id from auth.uid() (never from an argument), and collapses an identical failure seen within 5 minutes onto the existing row (repeat_count + last_seen_at) instead of inserting again. Not reachable from PostgREST — public.log_error and public.log_error_global are the doors. See 0950.';


-- ----------------------------------------------------------------------------
-- 5. public.log_error — the ordinary, authenticated entry point.
--
--    Refuses to attribute a failure to a company the caller is not a member
--    of. It RAISES rather than quietly downgrading company_id to null,
--    because a null-company row is invisible to almost everyone and a
--    "successful" write nobody can ever read is a worse outcome than the
--    caller's own console.error fallback firing.
-- ----------------------------------------------------------------------------
create or replace function public.log_error(
  p_operation text,
  p_message text,
  p_severity text default 'error',
  p_detail text default null,
  p_company_id uuid default null,
  p_context jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if (select auth.uid()) is null then
    raise exception 'log_error requires a signed-in caller; use log_error_global for a pre-authentication failure';
  end if;

  if p_company_id is not null
     and not (select app_private.is_company_member(p_company_id)) then
    raise exception 'Cannot record an error against company % — you are not a member of it', p_company_id;
  end if;

  return app_private.write_error_log(
    p_operation, p_message, p_severity, p_detail, p_company_id, p_context);
end;
$fn$;

revoke all on function public.log_error(text, text, text, text, uuid, jsonb) from public, anon;
grant execute on function public.log_error(text, text, text, text, uuid, jsonb) to authenticated;

comment on function public.log_error is
  'Records one application failure for a signed-in caller, optionally attributed to a company they are a member of (raises if they are not). user_id is taken from auth.uid(), never from an argument. Message, detail and context are redacted on the way in. Called from lib/errors/logError.ts, which never lets a failure here reach the user. See 0950.';


-- ----------------------------------------------------------------------------
-- 6. public.log_error_global — the narrow anon-reachable exception.
--
--    THE DELIBERATE DEVIATION from this schema's "authenticated only"
--    convention, and the reasoning is in the migration header: this repo has
--    no service_role key and must never have one, so the inbound WhatsApp
--    webhook — which carries no session and whose failures are the least
--    visible in the app — has no other way to leave a durable record.
--
--    What that exception can actually do is bounded on four sides:
--      * company_id is HARDCODED null. Not a defaulted argument an attacker
--        could pass; there is no parameter for it at all.
--      * the operation must be on a two-entry allowlist.
--      * the message is truncated and the severity forced to 'warning' or
--        'error' (never 'critical' — nothing anonymous gets to raise an
--        alarm).
--      * past 50 rows for that operation in the trailing hour it stops
--        writing and returns null.
--    And by the read rule in the header, everything it can produce carries
--    neither a company nor a user, so it is invisible to every user of this
--    application regardless.
-- ----------------------------------------------------------------------------
create or replace function public.log_error_global(
  p_operation text,
  p_message text,
  p_severity text default 'error',
  p_detail text default null,
  p_context jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_recent integer;
  v_severity text;
begin
  if p_operation not in ('whatsapp_webhook', 'inbound_webhook') then
    raise exception 'log_error_global does not accept the operation code %', p_operation;
  end if;

  v_severity := case when lower(coalesce(p_severity, '')) = 'warning' then 'warning' else 'error' end;

  select count(*) into v_recent
    from public.error_log
   where company_id is null
     and operation = p_operation
     and last_seen_at > now() - interval '1 hour';

  if v_recent >= 50 then
    -- Bounded on purpose. Dropping the 51st distinct message in an hour is
    -- the correct trade against letting anyone holding the publishable key
    -- fill this table.
    return null;
  end if;

  return app_private.write_error_log(
    p_operation, p_message, v_severity, p_detail, null, p_context);
end;
$fn$;

revoke all on function public.log_error_global(text, text, text, text, jsonb) from public;
grant execute on function public.log_error_global(text, text, text, text, jsonb) to anon, authenticated;

comment on function public.log_error_global is
  'Records a failure that happened before any company or user was known — the inbound-webhook case. Reachable by anon BY DESIGN (this repo has no service_role key and must never have one), and bounded accordingly: company_id is hardcoded null with no parameter for it, the operation must be on a two-entry allowlist, severity cannot be ''critical'', and it stops writing past 50 rows per operation per hour. Everything it writes is invisible to every user of the application. See 0950.';


-- ----------------------------------------------------------------------------
-- 7. Row level security
--
--    The rule from the migration header, in policy form. There is no INSERT,
--    UPDATE or DELETE policy at all: rows arrive only through the two
--    SECURITY DEFINER entry points above, and nobody may amend or remove one
--    from the application. (RLS with a SELECT policy only is what makes that
--    true; the deny-all-tables invariant test in tests/db/invariants.test.ts
--    checks for tables with NO policy, which this is not.)
-- ----------------------------------------------------------------------------
alter table public.error_log enable row level security;

create policy error_log_read on public.error_log
  for select to authenticated
  using (
    -- A company's failures: that company's admins, nobody else. Not
    -- accountants; not auditors (see header — audit_log is their record, and
    -- an application failure is not part of it).
    (company_id is not null and (select app_private.is_company_admin(company_id)))
    -- A company-less failure: only the user it actually happened to. Never
    -- an admin on the strength of being an admin — that would be the
    -- cross-tenant leak. A row with no user_id either matches nothing here,
    -- for anyone, and is unreachable from the application by design.
    or (company_id is null and user_id is not null and user_id = (select auth.uid()))
  );


-- ----------------------------------------------------------------------------
-- 8. public.get_error_log — the read RPC.
--
--    security invoker, so the policy above applies to it as it stands rather
--    than being re-implemented. The WHERE clause then enforces the same
--    scoping a SECOND, independent time: a mistake in the policy and a
--    mistake here would both have to happen before a global row could reach
--    the wrong reader.
-- ----------------------------------------------------------------------------
create or replace function public.get_error_log(
  p_company_id uuid,
  p_operation text default null,
  p_since timestamptz default null,
  p_severity text default null,
  p_limit integer default 200
) returns table (
  id uuid,
  occurred_at timestamptz,
  last_seen_at timestamptz,
  repeat_count integer,
  operation text,
  severity text,
  message text,
  detail text,
  context jsonb,
  scope text,
  user_name text
)
language plpgsql
stable
security invoker
set search_path = ''
as $fn$
begin
  if not (select app_private.is_company_admin(p_company_id)) then
    raise exception 'Only an admin of this company can read its error log';
  end if;

  return query
    select
      e.id,
      e.occurred_at,
      e.last_seen_at,
      e.repeat_count,
      e.operation,
      e.severity,
      e.message,
      e.detail,
      e.context,
      case when e.company_id is null then 'personal' else 'company' end,
      p.full_name
    from public.error_log e
    left join public.profiles p on p.id = e.user_id
    where (
            e.company_id = p_company_id
            -- The caller's own company-less failures (the support-chat case).
            -- Never anyone else's: user_id is compared to auth.uid(), not to
            -- membership of p_company_id.
            or (e.company_id is null and e.user_id = (select auth.uid()))
          )
      and (p_operation is null or e.operation = p_operation)
      and (p_severity is null or e.severity = p_severity)
      and (p_since is null or e.last_seen_at >= p_since)
    order by e.last_seen_at desc
    limit least(coalesce(p_limit, 200), 500);
end;
$fn$;

revoke all on function public.get_error_log(uuid, text, timestamptz, text, integer) from public, anon;
grant execute on function public.get_error_log(uuid, text, timestamptz, text, integer) to authenticated;

comment on function public.get_error_log is
  'Company-scoped error list, newest activity first, for an ADMIN of that company only (raises otherwise). Returns that company''s rows plus the caller''s OWN company-less rows (scope = ''personal''), never another user''s and never a row belonging to no user at all. security invoker, so error_log''s RLS applies on top of this WHERE clause rather than instead of it. See 0950.';


-- ----------------------------------------------------------------------------
-- 9. Retention: prune at 90 days, nightly, on the pg_cron schedule this
--    database already runs (0021, 0122). Not exposed through PostgREST at
--    all — there is no grant, so no role reachable from the API can call it,
--    and a company admin cannot delete their own failures. See the header on
--    why no dismiss/delete is offered.
-- ----------------------------------------------------------------------------
create or replace function app_private.prune_error_log(p_keep_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_deleted integer;
begin
  delete from public.error_log
   where last_seen_at < now() - make_interval(days => greatest(coalesce(p_keep_days, 90), 1));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

revoke all on function app_private.prune_error_log(integer) from public, anon, authenticated;

comment on function app_private.prune_error_log(integer) is
  'Deletes error_log rows whose last_seen_at is older than the retention window (90 days by default). Keyed on last_seen_at rather than occurred_at so a still-repeating failure is not pruned mid-incident. Called nightly by the ''prune-error-log'' pg_cron job; deliberately has no grant, so nothing reachable from the API can call it. See 0950.';

select cron.schedule(
  'prune-error-log',
  '15 3 * * *',
  $$ select app_private.prune_error_log(90); $$
);
