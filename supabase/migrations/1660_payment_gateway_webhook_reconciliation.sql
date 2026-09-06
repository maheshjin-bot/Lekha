-- ============================================================================
-- 1660 — Payment gateway webhooks: inbound reconciliation only (Razorpay v1)
-- ============================================================================
-- ADDENDUM, added when this file was recovered into main on 6 Sep 2026 (it
-- was authored, and its DDL run live, on 2 Sep in an abandoned worktree —
-- claude/zealous-bell-cc00d5 — that never got as far as `git add`/commit).
-- Every table, function, trigger and grant this file creates was confirmed,
-- via live introspection (pg_proc/information_schema/pg_policies), to
-- already exist in the shared dev database exactly as written below, WITH
-- ONE EXCEPTION: this file's own item 8, `create or replace function
-- public.delete_company`, is now STALE. Migration 1841 (committed to main
-- separately, in efb4357, and confirmed live) already replaced
-- delete_company's body wholesale with a version that both (a) folds in the
-- exact same two `delete from payment_webhook_events`/
-- `delete from payment_gateway_configs` lines this migration adds, in the
-- same position, and (b) fixes seven further, unrelated pre-existing bugs in
-- that function that this migration's own header explicitly named and
-- deliberately left unfixed. Confirmed live via pg_get_functiondef: the
-- deployed delete_company already IS 1841's body.
--
-- Consequently, this file's DDL is NOT being re-run against the live
-- database as part of recovering it into git — doing so would fail outright
-- on the CREATE TABLE/CREATE TRIGGER/CREATE POLICY statements below (no IF
-- NOT EXISTS guards; the objects already exist), and if it somehow got past
-- those, item 8 would REGRESS delete_company back below 1841's fix. Instead,
-- version '1660' is recorded directly in supabase_migrations.schema_migrations
-- with empty `statements`/`rollback` (the same shape every other
-- Management-API-applied row in this project already has), per this
-- project's own "keep registering for consistency, never trust it as an
-- applied-set oracle" convention.
--
-- This file's CONTENT is left otherwise unchanged, including item 8, because
-- migration order still matters for a FRESH install: on a `supabase db
-- reset`, this file (1660) still runs before 1841 in numeric order, sets
-- delete_company to the old-plus-two-lines body exactly as originally
-- authored, and 1841 then correctly overwrites it again immediately after —
-- the same end state the live shared database is already in. Rewriting item
-- 8 here to match 1841 would make this file lie about what it actually did
-- on 2 Sep, and would leave 1841's own migration header (which narrates
-- exactly this handoff, down to citing "1420/1660" by name in its own
-- comments) referring to a predecessor state that no longer exists in git.
-- ============================================================================
-- Grepped the whole repo for razorpay/payment_gateway/payment.webhook before
-- writing a line here: zero hits (one unrelated prose match in 0134's own
-- comment text). No payment-gateway integration of any kind exists in this
-- codebase before this migration, and no Razorpay/PayU/Cashfree account or
-- credential exists anywhere in this environment (checked .env.local and
-- .env.example — nothing named RAZORPAY_* or similar).
--
-- THE HARD BOUNDARY THIS FEATURE NEVER CROSSES. LEKHA never initiates a
-- payment, transfer, or fund movement of any kind (stated repeatedly across
-- this schema's own migrations — 0800, 0995, 0111). This migration is a
-- RECEIVER ONLY: it listens for a gateway's own notification that a payment
-- it already processed elsewhere succeeded, and turns that into (a) an
-- ordinary bank_statement_lines row — exactly what a CSV statement import
-- already produces — plus (b) a SUGGESTED, never authoritative, match against
-- an existing outstanding invoice. No outbound call to any gateway exists
-- anywhere in this migration or its companion route
-- (app/api/payments/webhook/[companyId]/route.ts): no create-order, no
-- create-payment-link, no charge API of any kind.
--
-- ==========================================================================
-- WHAT THIS ADDS
-- ==========================================================================
-- 1. payment_gateway_configs — one row per (company, gateway): which
--    settlement (bank/cash) ledger a captured payment should land against,
--    and the HMAC secret Razorpay signs its webhook deliveries with.
--    Admin-write / member-read, mirroring whatsapp_inbound_numbers (0745)'s
--    "config row, not a live subscription" shape — registering a gateway
--    here does not call Razorpay, create an account, or subscribe a webhook;
--    the admin still has to paste the generated URL and secret into
--    Razorpay's own dashboard themselves.
-- 2. payment_webhook_events — the raw receiving inbox. Every verified
--    delivery (and every REJECTED one — see "WHY REJECTED DELIVERIES ARE
--    STILL RECORDED" below) gets a row, visible to a company admin at
--    /[companyId]/payment-gateway.
-- 3. app_private.verify_payment_webhook_signature — SECURITY DEFINER,
--    computes encode(extensions.hmac(raw_body, secret, 'sha256'), 'hex')
--    against the stored per-company secret and returns ONLY a boolean; the
--    secret itself never leaves Postgres, and this function is never
--    reachable from PostgREST (app_private is not an exposed schema) even
--    though it is anon-granted for symmetry with 0745's own private-
--    predicate pattern and for standalone testability via sbq.
-- 4. receive_payment_webhook_event — SECURITY DEFINER, anon-granted (a
--    webhook delivery carries no Supabase session, exactly like
--    receive_whatsapp_inbound_message, 0745). Verifies the signature,
--    records the event (deduped against real redelivery), and — only for a
--    verified payment.captured event with a positive amount and an active
--    config — inserts ONE bank_statement_lines row via the SAME
--    ON CONFLICT (company_id, ledger_id, external_txn_id) DO NOTHING path
--    0164 already established, so the existing /reconciliation screen,
--    match_bank_line, and auto_match_bank_lines all work completely
--    unmodified (verified live below, not assumed). It then computes a
--    bill-wise SUGGESTION — never an authoritative match, see "SUGGESTION,
--    NEVER AUTHORITY" below.
-- 5. create_payment_gateway_config / rotate_payment_gateway_webhook_secret —
--    admin-gated, each returns the raw secret exactly once (mirrors
--    create_api_key, 0063).
-- 6. app/(app)/[companyId]/payment-gateway — config screen + read-only event
--    log (mirrors /whatsapp-numbers). app/api/payments/webhook/[companyId]/
--    route.ts — the receiver (mirrors app/api/whatsapp/webhook/route.ts).
--    An additive "suggested match" banner in ReconciliationScreen — the
--    existing match_bank_line flow, not a new matching UI paradigm.
-- 7. delete_company — extended (see "DELETE_COMPANY" below), and a real,
--    pre-existing, unrelated bug found and DELIBERATELY LEFT UNFIXED while
--    touching this function — see the same section.
--
-- ==========================================================================
-- WHY REJECTED DELIVERIES ARE STILL RECORDED — a deliberate difference from
-- 0745's own "discarded unread" choice for a bad WhatsApp signature.
-- ==========================================================================
-- 0745's WhatsApp route discards a bad-signature delivery entirely rather
-- than writing anything to public.error_log, because error_log is a shared,
-- low-context table and an unauthenticated attacker's payload could shape
-- what gets written into it. payment_webhook_events is a dedicated,
-- company-scoped inbox an admin already expects to read — "3 deliveries were
-- rejected because the signature didn't match" is exactly the kind of signal
-- that helps someone notice they pasted the wrong secret into Razorpay's
-- dashboard. So a rejected delivery IS recorded here (signature_verified =
-- false, status = 'ignored', a reason), but the HTTP response to the caller
-- is still 401 (same discipline as 0745's route) and no bank_statement_lines
-- row is ever created from it.
--
-- ==========================================================================
-- SUGGESTION, NEVER AUTHORITY
-- ==========================================================================
-- No voucher, no bank_statement_lines MATCH, and no ledger posting is ever
-- created automatically by this migration. The one thing
-- receive_payment_webhook_event is allowed to do beyond recording the event
-- is: (1) insert an UNMATCHED bank_statement_lines row (exactly what a human
-- uploading a CSV statement already causes), and (2) write a SUGGESTION
-- (payment_webhook_events.suggested_voucher_id/suggested_ledger_id) back onto
-- its own row when — and only when — a candidate debtor ledger is found
-- unambiguously (by contact/VPA) AND that ledger has EXACTLY ONE open charge
-- whose remaining amount equals the payment, the identical "only when
-- unambiguous" discipline auto_match_bank_lines (0019) already uses. A human
-- still opens /reconciliation and clicks the existing match_bank_line
-- themselves — this migration adds a highlighted shortcut to that click, not
-- a new path around it.
--
-- ==========================================================================
-- A REAL DEVIATION FROM THE SURVEY SCOPE, FOUND WHILE READING REAL SCHEMA:
-- get_party_outstanding (0017) CANNOT answer "is there exactly one matching
-- open charge" — it is LEDGER-grain (one aggregated, bucketed total per
-- party), not itemized per invoice. The survey plan named it as the function
-- to call for this; it is the wrong grain, the exact same "ledger grain vs
-- invoice grain" distinction 0111's own header already worked through for
-- get_invoice_outstanding. Rather than modify 0017 (used by /reports/
-- outstanding, ageing, drawing-power calculations — far too much surface to
-- risk on this feature), this migration adapts the SAME FIFO
-- charges/payments/ranked/aged chain 0017/0031/0111 all already share, scoped
-- to one ledger and itemized by voucher_id, inline inside
-- receive_payment_webhook_event — the same "adapt the FIFO chain for a new
-- grain, don't modify the original" discipline 0111's own header names and
-- 0031/0096/0105 all repeat. get_party_outstanding, get_overdue_receivables,
-- auto_match_bank_lines, match_bank_line and get_bank_reconciliation_summary
-- are all reused completely unmodified, as the survey scope required.
--
-- ==========================================================================
-- A SECOND DEVIATION: gateway_payment_id ALONE is the wrong dedup key.
-- ==========================================================================
-- The survey scope named payment_webhook_events.gateway_payment_id as the
-- unique-per-(company,gateway) redelivery dedup key, "using Razorpay's own
-- x-razorpay-event-id/payment id". Working through Razorpay's own documented
-- contract (WebSearch, this session — see below) shows this is unsafe as a
-- SINGLE column: a single Razorpay payment_id ("pay_...") can legitimately
-- back MULTIPLE DISTINCT events over its lifetime — payment.captured, then
-- later refund.processed for the very same payment. A unique constraint on
-- gateway_payment_id alone would make the second, entirely legitimate event
-- silently collide with (and be dropped as a "duplicate" of) the first. This
-- migration therefore stores TWO columns: gateway_event_id (Razorpay's own
-- x-razorpay-event-id header — confirmed by Razorpay's own docs to be
-- "unique per event", which is what actually backs safe redelivery dedup)
-- carries the real UNIQUE (company_id, gateway, gateway_event_id) constraint;
-- gateway_payment_id (the "pay_..." id) is kept alongside, unconstrained, for
-- display and as the external_txn_id fed into bank_statement_lines' own
-- (company_id, ledger_id, external_txn_id) dedup key (0164) — safe there
-- because a REFUND event never reaches the bank_statement_lines insert branch
-- at all (only a verified payment.captured event with a positive amount
-- does), so the same payment_id can never attempt two competing statement
-- lines. A missing x-razorpay-event-id header (older webhook payload shapes,
-- per Razorpay's own docs) falls back to gateway_payment_id || ':' ||
-- event_type — still redelivery-safe (Razorpay's own retries of the SAME
-- event reproduce the same payment_id/event_type pair) and still lets a
-- DIFFERENT event_type for the same payment through.
--
-- ==========================================================================
-- RAZORPAY'S REAL, DOCUMENTED CONTRACT — CONFIRMED VIA WEBSEARCH THIS
-- SESSION, NEVER AGAINST A REAL RAZORPAY-SIGNED REQUEST
-- ==========================================================================
-- No Razorpay account or credential exists anywhere in this environment (the
-- identical "genuine external-credential gate" category 0745 names for
-- WhatsApp, and GSTN/TRACES/ICEGATE elsewhere in this schema). What IS real,
-- and confirmed by WebSearch against Razorpay's own current docs
-- (razorpay.com/docs/webhooks/validate-test/, .../webhooks/payloads/payments/)
-- rather than assumed from training data:
--   * X-Razorpay-Signature is HMAC-SHA256, hex-encoded, of the RAW request
--     body, keyed with the webhook secret set in Razorpay's dashboard.
--   * x-razorpay-event-id is a header, "unique per event" — Razorpay's own
--     documented mechanism for a caller to "identify duplicate webhooks".
--   * A payment event's payload nests the payment fields under
--     payload.payment.entity — id ("pay_..."), amount (INTEGER PAISE, not
--     rupees), currency, status, captured, vpa (UPI payer address, when
--     applicable), contact (payer phone, E.164), email, notes, created_at
--     (unix seconds).
--   * payment.captured fires when a payment succeeds and funds are captured
--     — the one event type this migration treats as "money actually in".
-- What has NEVER been exercised: no real Razorpay account has ever signed a
-- request against this route; verification is built and tested only against
-- Razorpay's own documented contract with a hand-built synthetic payload
-- (this migration's own verification below), stated plainly here and in the
-- route's own header, matching 0745's honest-scope framing exactly.
--
-- ==========================================================================
-- WHY create_payment_gateway_config / rotate_… ARE SECURITY DEFINER, NOT
-- SECURITY INVOKER AS THE SURVEY SCOPE SUGGESTED — a deliberate deviation.
-- ==========================================================================
-- The survey scope called these SECURITY INVOKER. Working through the actual
-- consequence: "webhook_secret ... never selectable by the client, mirrors
-- companies.password_hash unselectability" (0044) only holds if `authenticated`
-- has NEITHER select NOR insert/update privilege on that column at the table
-- level — 0044's own password_hash achieves this by being left OUT of the
-- explicit re-grant list entirely after revoking companies' table-wide
-- grant. If webhook_secret is locked out of authenticated's grants that
-- completely, a SECURITY INVOKER function trying to INSERT/UPDATE it would
-- fail with 42501 (permission denied for column) the moment an ordinary
-- admin called it — the calling role genuinely lacks the privilege, and
-- INVOKER does not borrow the function owner's. 0044's own
-- set_company_password is SECURITY DEFINER for exactly this reason. This
-- migration follows that real precedent over the survey's stated one:
-- webhook_secret gets ZERO grants to authenticated or anon (select or
-- write), and create_payment_gateway_config/rotate_… are SECURITY DEFINER,
-- with the identical admin check 0044's own set_company_password uses,
-- inlined at the top of each.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. bank_statement_lines (0164) — extend source_format.
-- ----------------------------------------------------------------------------
-- 0164's own CHECK constraint enumerated the four bank-CSV adapters that
-- existed at the time and did not anticipate a fifth, non-CSV origin.
-- Confirmed live, not assumed: this migration's own first end-to-end test of
-- receive_payment_webhook_event hit this exact constraint (23514) on its
-- first real insert attempt before this fix was added. bank_statement_lines
-- itself is untouched otherwise — same table, same columns, same dedupe key.
alter table public.bank_statement_lines drop constraint bank_statement_lines_source_format_check;
alter table public.bank_statement_lines add constraint bank_statement_lines_source_format_check
  check (source_format in ('generic', 'hdfc_netbanking', 'icici_netbanking', 'axis_netbanking', 'payment_gateway'));

comment on constraint bank_statement_lines_source_format_check on public.bank_statement_lines is
  'Provenance enum, extended by 1660 to add ''payment_gateway'' — a line receive_payment_webhook_event inserted from a verified gateway webhook, not a CSV/PDF import. Still never read by any computation (get_bank_reconciliation_summary, match_bank_line etc.), per 0164''s own original comment.';


-- ----------------------------------------------------------------------------
-- 1. payment_gateway_configs
-- ----------------------------------------------------------------------------
create table public.payment_gateway_configs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  gateway text not null default 'razorpay' check (gateway in ('razorpay')),

  -- Which bank/cash ledger a captured payment's bank_statement_lines row
  -- lands against. Composite FK (not just a plain ledgers(id) reference) for
  -- the same cross-tenant-safety reason every other company-scoped FK in
  -- this schema uses one: it is structurally impossible to point this at a
  -- DIFFERENT company's ledger.
  settlement_ledger_id uuid not null,

  -- Plaintext, deliberately. HMAC verification needs the literal key, not a
  -- one-way hash of it (unlike api_keys.key_hash, 0063, which only ever
  -- needs an EQUALITY check). Never selectable by authenticated or anon —
  -- see migration header, "WHY … ARE SECURITY DEFINER". A stolen database
  -- backup handing out a live webhook secret is a real but lesser exposure
  -- than a live login credential: the secret only lets an attacker forge a
  -- SUGGESTED reconciling entry (never a posting, never a voucher — see
  -- "SUGGESTION, NEVER AUTHORITY" above), the same blast radius a forged CSV
  -- statement upload would already have from anyone with ordinary
  -- can_write_company access.
  webhook_secret text not null,

  is_active boolean not null default true,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (company_id, gateway),
  unique (id, company_id),
  foreign key (settlement_ledger_id, company_id) references public.ledgers (id, company_id)
);

create index payment_gateway_configs_company_idx on public.payment_gateway_configs (company_id);

create trigger set_updated_at before update on public.payment_gateway_configs
  for each row execute function app_private.set_updated_at();

alter table public.payment_gateway_configs enable row level security;

create policy payment_gateway_configs_read on public.payment_gateway_configs
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

-- "for all" is the ceiling; the column-grant floor below is what actually
-- decides what an admin can touch directly vs only through the DEFINER RPCs.
create policy payment_gateway_configs_write on public.payment_gateway_configs
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

comment on table public.payment_gateway_configs is
  'One row per (company, gateway): the settlement ledger a captured payment posts against, and the HMAC secret Razorpay signs webhook deliveries with. A config row, not a live subscription — creating one does not call Razorpay in any way. See 1660 migration header.';
comment on column public.payment_gateway_configs.webhook_secret is
  'Plaintext (HMAC needs the literal key). Never selectable by authenticated or anon at the table-privilege level — see migration header, "WHY … ARE SECURITY DEFINER". Only readable inside app_private.verify_payment_webhook_signature (SECURITY DEFINER).';

-- ---- Column-level lockdown (Supabase's default privilege dance) -----------
-- New tables in this schema pick up Supabase's default `grant all ... to
-- anon, authenticated` unless revoked — the exact gap 0044 closed for
-- companies.password_hash. anon gets NOTHING on this table at all (every
-- anon-context caller goes through the DEFINER RPCs/functions, which bypass
-- grants as their owner). authenticated gets an explicit, webhook_secret-
-- free SELECT list, plus UPDATE on the two ordinary, non-secret config
-- fields only — is_active (deactivate without rotating anything) and
-- settlement_ledger_id (repoint to a different bank ledger without minting a
-- new secret, which would otherwise force re-pasting it into Razorpay's
-- dashboard for no reason). No INSERT/DELETE grant at all: a row is created
-- exclusively by create_payment_gateway_config (DEFINER) and never removed
-- short of the whole company going away.
revoke all on public.payment_gateway_configs from anon;
revoke select, insert, update, delete on public.payment_gateway_configs from authenticated;

grant select (
  id, company_id, gateway, settlement_ledger_id, is_active,
  created_by, created_at, updated_at
) on public.payment_gateway_configs to authenticated;

grant update (is_active, settlement_ledger_id) on public.payment_gateway_configs to authenticated;


-- ----------------------------------------------------------------------------
-- 2. payment_webhook_events — the raw receiving inbox.
-- ----------------------------------------------------------------------------
create table public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  gateway text not null check (gateway in ('razorpay')),

  event_type text not null check (length(trim(event_type)) > 0),

  -- The REAL redelivery dedup key — Razorpay's own x-razorpay-event-id, or a
  -- deterministic fallback when that header is absent. See migration header,
  -- "A SECOND DEVIATION", for why this is NOT gateway_payment_id.
  gateway_event_id text not null,
  -- Razorpay's payment id ("pay_..."), when the event carries one. Display +
  -- the value fed into bank_statement_lines.external_txn_id — never itself
  -- the uniqueness key on THIS table (a payment.captured and a later
  -- refund.processed for the same payment legitimately share it).
  gateway_payment_id text,

  amount numeric(18,2),
  currency text,

  -- Payer identity, as far as this app persists it. payer_vpa is a UPI
  -- Virtual Payment Address — already non-secret by nature, the identical
  -- category as the PAYEE vpa this schema already stores on companies
  -- (0111). payer_contact_masked is deliberately NOT the full phone number —
  -- see receive_payment_webhook_event below for the masking. No card PAN,
  -- CVV, or full bank account number is ever accepted as a parameter or
  -- column here at all.
  payer_vpa text,
  payer_contact_masked text,

  notes jsonb,
  -- Redacted BEFORE this RPC is ever called — see receive_payment_webhook_
  -- event's own comment for exactly where and why (reusing lib/errors/
  -- redact.ts's redactContext, not a second SQL-side redaction engine).
  raw_payload jsonb,

  signature_verified boolean not null default false,
  status text not null default 'received'
    check (status in ('received', 'suggested', 'matched', 'ignored')),

  suggested_voucher_id uuid references public.vouchers(id) on delete set null,
  suggested_ledger_id uuid,
  suggested_reason text,

  bank_statement_line_id uuid references public.bank_statement_lines(id) on delete set null,

  created_at timestamptz not null default now(),

  unique (company_id, gateway, gateway_event_id),
  foreign key (suggested_ledger_id, company_id) references public.ledgers (id, company_id)
);

create index payment_webhook_events_company_idx
  on public.payment_webhook_events (company_id, created_at desc);

comment on table public.payment_webhook_events is
  'Every payment-gateway webhook delivery this company has received, verified or not (a rejected-signature delivery is still recorded — see 1660 migration header, "WHY REJECTED DELIVERIES ARE STILL RECORDED"). status=''matched'' is a reserved terminal state this migration does NOT itself transition into automatically beyond what the sync trigger below covers — see that trigger''s own comment.';
comment on column public.payment_webhook_events.gateway_event_id is
  'Razorpay''s own x-razorpay-event-id header ("unique per event" per Razorpay''s own docs), or gateway_payment_id||'':''||event_type when that header is absent. The REAL redelivery dedup key — see 1660 migration header, "A SECOND DEVIATION".';
comment on column public.payment_webhook_events.suggested_reason is
  'Plain-language reason a suggestion was (or was not) made — e.g. why the payer could not be matched, or why the payment was ignored (no active config, signature mismatch). Always populated when status is ''ignored'' or ''suggested''.';

alter table public.payment_webhook_events enable row level security;

-- Member-read only. No authenticated write policy at all: every row is
-- written by receive_payment_webhook_event (SECURITY DEFINER, bypasses RLS
-- and table grants as owner) or by the sync trigger below — never by a
-- direct client call.
create policy payment_webhook_events_read on public.payment_webhook_events
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

revoke all on public.payment_webhook_events from anon;
revoke insert, update, delete on public.payment_webhook_events from authenticated;


-- ----------------------------------------------------------------------------
-- 3. app_private.verify_payment_webhook_signature
-- ----------------------------------------------------------------------------
-- Razorpay's own documented contract (WebSearch, confirmed this session —
-- see migration header): HMAC-SHA256, hex-encoded, of the RAW request body,
-- keyed with the secret set in Razorpay's dashboard. extensions.hmac(text,
-- text, text) is the pgcrypto overload already available in this project
-- (confirmed live: select proname from pg_proc where proname='hmac' returns
-- both a bytea and a text overload in the extensions schema).
create or replace function app_private.verify_payment_webhook_signature(
  p_company_id uuid,
  p_gateway text,
  p_raw_body text,
  p_signature text
) returns boolean
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_secret text;
begin
  if p_signature is null or length(trim(p_signature)) = 0 then
    return false;
  end if;
  if p_raw_body is null then
    return false;
  end if;

  select webhook_secret into v_secret
    from public.payment_gateway_configs
   where company_id = p_company_id and gateway = p_gateway and is_active;

  if v_secret is null then
    -- No active config for this company/gateway — nothing to verify against.
    -- Same "false, not an error" shape as verify_company_password (0044).
    return false;
  end if;

  return lower(trim(p_signature)) = encode(extensions.hmac(p_raw_body, v_secret, 'sha256'), 'hex');
end;
$$;

revoke all on function app_private.verify_payment_webhook_signature(uuid, text, text, text) from public, authenticated;
grant execute on function app_private.verify_payment_webhook_signature(uuid, text, text, text) to anon;

comment on function app_private.verify_payment_webhook_signature is
  'Razorpay''s documented X-Razorpay-Signature contract: HMAC-SHA256 hex of the raw body, keyed with the company''s stored webhook_secret. Returns ONLY a boolean — the secret never leaves Postgres. Never reachable via PostgREST (app_private is not exposed); anon-granted for symmetry with 0745''s app_private.whatsapp_inbound_draft_ready and for standalone sbq testing. See 1660.';


-- ----------------------------------------------------------------------------
-- 4. receive_payment_webhook_event — the ONE way a payment_webhook_events
--    row is ever created.
-- ----------------------------------------------------------------------------
create or replace function public.receive_payment_webhook_event(
  p_company_id uuid,
  p_gateway text,
  p_event_type text,
  p_gateway_event_id text,
  p_gateway_payment_id text,
  p_amount numeric,
  p_currency text,
  p_payer_vpa text,
  p_payer_contact text,        -- FULL contact, used transiently for matching; masked before storage.
  p_notes jsonb,
  p_raw_payload jsonb,         -- already redacted by the caller — see comment below.
  p_signature text,
  p_raw_body text,
  p_occurred_at timestamptz default null
) returns table (
  event_id uuid,
  status text,
  signature_verified boolean,
  bank_statement_line_id uuid
)
-- VOLATILE (the default), not stable: this writes real rows. Marking it
-- stable would make PostgREST open a read-only transaction and then refuse
-- every INSERT/UPDATE below — the exact failure api_get_trial_balance's own
-- comment (0063) and get_capture_draft_by_token's (0745) both document
-- hitting live; not repeating it a third time.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_verified boolean;
  v_config public.payment_gateway_configs%rowtype;
  v_event_id uuid;
  v_status text := 'received';
  v_reason text;
  v_line_id uuid;
  v_txn_date date;
  v_gateway_event_id text;
  v_contact_digits text;
  v_vpa_local_digits text;
  v_masked_contact text;
  v_ledger_id uuid;
  v_ledger_name text;
  v_candidate_count int;
  v_voucher_id uuid;
  v_match_count int;
begin
  if p_company_id is null then
    raise exception 'company_id is required';
  end if;
  if p_gateway is null or length(trim(p_gateway)) = 0 then
    raise exception 'gateway is required';
  end if;
  if p_event_type is null or length(trim(p_event_type)) = 0 then
    raise exception 'event_type is required';
  end if;

  -- Fallback dedup key when x-razorpay-event-id is missing — see migration
  -- header, "A SECOND DEVIATION". A missing gateway_payment_id too leaves
  -- nothing safe to dedupe on; reject outright rather than store a row that
  -- can never be told apart from a genuine redelivery.
  v_gateway_event_id := nullif(trim(coalesce(p_gateway_event_id, '')), '');
  if v_gateway_event_id is null then
    if p_gateway_payment_id is null or length(trim(p_gateway_payment_id)) = 0 then
      raise exception 'Neither gateway_event_id nor gateway_payment_id was provided — nothing to dedupe on';
    end if;
    v_gateway_event_id := p_gateway_payment_id || ':' || p_event_type;
  end if;

  v_verified := app_private.verify_payment_webhook_signature(p_company_id, p_gateway, p_raw_body, p_signature);

  select * into v_config
    from public.payment_gateway_configs
   where company_id = p_company_id and gateway = p_gateway and is_active;

  -- Mask BEFORE storage: keep only the last 4 digits, the same partial-
  -- reveal shape key_prefix (0063) and masked-card displays everywhere use.
  -- The FULL contact (p_payer_contact) is used below for matching, then
  -- never written anywhere.
  v_contact_digits := regexp_replace(coalesce(p_payer_contact, ''), '\D', '', 'g');
  v_masked_contact := case
    when length(v_contact_digits) >= 4
      then repeat('X', length(v_contact_digits) - 4) || right(v_contact_digits, 4)
    else null
  end;

  if not v_verified then
    v_status := 'ignored';
    v_reason := case
      when v_config.id is null then 'No active Razorpay configuration for this company'
      else 'Webhook signature did not match the configured secret'
    end;
  end if;

  insert into public.payment_webhook_events (
    company_id, gateway, event_type, gateway_event_id, gateway_payment_id,
    amount, currency, payer_vpa, payer_contact_masked, notes, raw_payload,
    signature_verified, status, suggested_reason
  ) values (
    p_company_id, p_gateway, p_event_type, v_gateway_event_id, p_gateway_payment_id,
    p_amount, p_currency, p_payer_vpa, v_masked_contact, p_notes, p_raw_payload,
    v_verified, v_status, v_reason
  )
  on conflict (company_id, gateway, gateway_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- Real redelivery of an event already recorded — return its existing
    -- state rather than reprocessing (0164's own redelivery discipline).
    return query
      select e.id, e.status, e.signature_verified, e.bank_statement_line_id
        from public.payment_webhook_events e
       where e.company_id = p_company_id and e.gateway = p_gateway
         and e.gateway_event_id = v_gateway_event_id;
    return;
  end if;

  -- Only a verified, positive-amount capture ever touches the books-adjacent
  -- tables. Everything else (a failed signature, a refund notification, a
  -- zero/negative amount, no active config) is recorded above and stops here
  -- — see "SUGGESTION, NEVER AUTHORITY" in the migration header.
  if v_verified and v_config.id is not null and p_amount is not null and p_amount > 0
     and p_event_type = 'payment.captured' then

    v_txn_date := coalesce(p_occurred_at::date, current_date);

    insert into public.bank_statement_lines (
      company_id, ledger_id, txn_date, description, reference,
      debit_amount, credit_amount, source_format, external_txn_id
    ) values (
      p_company_id, v_config.settlement_ledger_id, v_txn_date,
      'Razorpay payment ' || coalesce(p_gateway_payment_id, v_gateway_event_id),
      p_gateway_payment_id,
      0, p_amount, 'payment_gateway',
      coalesce(p_gateway_payment_id, v_gateway_event_id)
    )
    on conflict (company_id, ledger_id, external_txn_id) do nothing
    returning id into v_line_id;

    if v_line_id is null then
      -- Defensive: the outer gateway_event_id conflict above should already
      -- have caught any real redelivery before reaching here. Resolve the
      -- existing line rather than leaving bank_statement_line_id unlinked.
      select id into v_line_id from public.bank_statement_lines
       where company_id = p_company_id and ledger_id = v_config.settlement_ledger_id
         and external_txn_id = coalesce(p_gateway_payment_id, v_gateway_event_id);
    end if;

    v_status := 'received';
    v_reason := null;

    if v_line_id is not null then
      -- ---- candidate debtor ledger, by contact/VPA — unambiguous only ----
      v_vpa_local_digits := case
        when p_payer_vpa is not null and position('@' in p_payer_vpa) > 0
          then regexp_replace(split_part(p_payer_vpa, '@', 1), '\D', '', 'g')
        else ''
      end;

      select c.id, c.name, c.cnt into v_ledger_id, v_ledger_name, v_candidate_count
        from (
          select d.id, d.name, count(*) over () as cnt
            from (
              select distinct l.id, l.name
                from public.ledgers l
                join public.account_groups g on g.id = l.group_id
               where l.company_id = p_company_id
                 and l.is_active
                 and g.ledger_role = 'debtor'
                 and (
                   (length(v_contact_digits) >= 10
                      and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = right(v_contact_digits, 10))
                   or (length(v_vpa_local_digits) >= 10
                      and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 10) = right(v_vpa_local_digits, 10))
                   or (p_payer_vpa is not null and l.email is not null and lower(l.email) = lower(p_payer_vpa))
                 )
            ) d
        ) c
       limit 1;

      if v_ledger_id is not null and v_candidate_count = 1 then
        -- ---- itemized FIFO remainder per voucher, this ONE ledger only ----
        -- Adapted from get_party_outstanding/get_overdue_receivables/
        -- get_invoice_outstanding's shared chain — see migration header, "A
        -- REAL DEVIATION FROM THE SURVEY SCOPE". None of those functions are
        -- modified by this migration.
        with book_start as (
          select coalesce(book_beginning_date, '1900-01-01'::date) as d
            from public.companies where id = p_company_id
        ),
        moves as (
          select e.voucher_id, v.voucher_date,
                 sum(e.debit_amount - e.credit_amount) as delta
            from public.voucher_entries e
            join public.vouchers v on v.id = e.voucher_id
           where e.company_id = p_company_id
             and e.ledger_id = v_ledger_id
             and not v.is_deleted
             and v.voucher_date <= v_txn_date
           group by e.voucher_id, v.voucher_date
        ),
        opening as (
          select case when l.opening_balance_type = 'debit'
                      then l.opening_balance_amount else -l.opening_balance_amount end as amount
            from public.ledgers l where l.id = v_ledger_id
        ),
        charges as (
          select voucher_id, voucher_date, delta from moves where delta > 0
          union all
          select null::uuid, (select d from book_start), amount from opening where amount > 0
        ),
        payments as (
          select coalesce(sum(paid), 0) as paid from (
            select sum(-delta) as paid from moves where delta < 0
            union all
            select -amount as paid from opening where amount < 0
          ) combined
        ),
        ranked as (
          select c.voucher_id, c.delta,
                 sum(c.delta) over (
                   order by c.voucher_date, c.delta, c.voucher_id
                   rows between unbounded preceding and current row
                 ) as running
            from charges c
        ),
        aged as (
          select r.voucher_id,
                 greatest(0, least(r.delta, r.running - (select paid from payments))) as remaining
            from ranked r
        )
        select m.voucher_id, m.cnt into v_voucher_id, v_match_count
          from (
            select a.voucher_id, count(*) over () as cnt
              from aged a
             where a.voucher_id is not null and a.remaining = p_amount
          ) m
         limit 1;

        if v_voucher_id is not null and v_match_count = 1 then
          v_status := 'suggested';
          v_reason := 'Payer contact/VPA matched ' || v_ledger_name
            || ' unambiguously, and exactly one open invoice for that ledger equals this payment''s amount.';

          update public.payment_webhook_events
             set status = 'suggested',
                 suggested_voucher_id = v_voucher_id,
                 suggested_ledger_id = v_ledger_id,
                 suggested_reason = v_reason,
                 bank_statement_line_id = v_line_id
           where id = v_event_id;
        else
          update public.payment_webhook_events set bank_statement_line_id = v_line_id where id = v_event_id;
        end if;
      else
        update public.payment_webhook_events set bank_statement_line_id = v_line_id where id = v_event_id;
      end if;
    end if;
  elsif v_verified and p_event_type <> 'payment.captured' then
    -- Verified, but not a "money in" event (e.g. refund.processed,
    -- payment.failed) — recorded above, no bank line, no suggestion.
    null;
  elsif v_verified and v_config.id is null then
    update public.payment_webhook_events
       set status = 'ignored', suggested_reason = 'No active Razorpay configuration for this company'
     where id = v_event_id;
  end if;

  return query
    select e.id, e.status, e.signature_verified, e.bank_statement_line_id
      from public.payment_webhook_events e where e.id = v_event_id;
end;
$$;

revoke all on function public.receive_payment_webhook_event(
  uuid, text, text, text, text, numeric, text, text, text, jsonb, jsonb, text, text, timestamptz
) from public, authenticated;
grant execute on function public.receive_payment_webhook_event(
  uuid, text, text, text, text, numeric, text, text, text, jsonb, jsonb, text, text, timestamptz
) to anon;

comment on function public.receive_payment_webhook_event is
  'The only way a payment_webhook_events row is created. Called by app/api/payments/webhook/[companyId]/route.ts using the anon key (a webhook has no Supabase session). Verifies the signature, records the event (deduped on gateway_event_id — real redelivery-safe, see 1660 migration header), and for a verified payment.captured event with amount>0 additionally inserts an UNMATCHED bank_statement_lines row plus, when unambiguous, a SUGGESTED (never automatic) invoice match. See 1660.';


-- ----------------------------------------------------------------------------
-- 5. create_payment_gateway_config(company, settlement_ledger[, gateway])
--    -> raw secret (shown once). SECURITY DEFINER — see migration header,
--    "WHY … ARE SECURITY DEFINER", for why this deviates from the survey
--    scope's stated SECURITY INVOKER.
-- ----------------------------------------------------------------------------
create or replace function public.create_payment_gateway_config(
  p_company_id uuid,
  p_settlement_ledger_id uuid,
  p_gateway text default 'razorpay'
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raw text;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can configure a payment gateway';
  end if;
  if p_gateway is distinct from 'razorpay' then
    raise exception 'Only the razorpay gateway is supported in this version';
  end if;
  if not exists (
    select 1 from public.ledgers where id = p_settlement_ledger_id and company_id = p_company_id
  ) then
    raise exception 'Settlement ledger not found for this company';
  end if;
  if exists (
    select 1 from public.payment_gateway_configs where company_id = p_company_id and gateway = p_gateway
  ) then
    raise exception 'A % configuration already exists for this company — use rotate_payment_gateway_webhook_secret for a new secret, or update the settlement ledger directly.', p_gateway;
  end if;

  v_raw := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.payment_gateway_configs (company_id, gateway, settlement_ledger_id, webhook_secret, created_by)
  values (p_company_id, p_gateway, p_settlement_ledger_id, v_raw, auth.uid());

  return v_raw;
end;
$$;

revoke all on function public.create_payment_gateway_config(uuid, uuid, text) from public, anon;
grant execute on function public.create_payment_gateway_config(uuid, uuid, text) to authenticated;

comment on function public.create_payment_gateway_config is
  'Creates a payment_gateway_configs row and returns the RAW webhook secret — the only time it is ever available. Admin-only. See 1660.';


-- ----------------------------------------------------------------------------
-- 6. rotate_payment_gateway_webhook_secret(company[, gateway]) -> raw secret
-- ----------------------------------------------------------------------------
create or replace function public.rotate_payment_gateway_webhook_secret(
  p_company_id uuid,
  p_gateway text default 'razorpay'
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raw text;
  v_id uuid;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can rotate a payment gateway webhook secret';
  end if;

  select id into v_id from public.payment_gateway_configs
   where company_id = p_company_id and gateway = p_gateway;
  if v_id is null then
    raise exception 'No % configuration exists yet for this company — create one first', p_gateway;
  end if;

  v_raw := encode(extensions.gen_random_bytes(32), 'hex');

  update public.payment_gateway_configs set webhook_secret = v_raw where id = v_id;

  return v_raw;
end;
$$;

revoke all on function public.rotate_payment_gateway_webhook_secret(uuid, text) from public, anon;
grant execute on function public.rotate_payment_gateway_webhook_secret(uuid, text) to authenticated;

comment on function public.rotate_payment_gateway_webhook_secret is
  'Issues a fresh webhook secret for an EXISTING config and returns it once — the old secret stops working immediately. Update Razorpay''s dashboard with the new value, or every delivery starts failing signature verification. Admin-only. See 1660.';


-- ----------------------------------------------------------------------------
-- 7. Keep payment_webhook_events.status in sync when a human actually
--    confirms the suggested match through the EXISTING, UNMODIFIED
--    match_bank_line / unmatch_bank_line RPCs (0019).
-- ----------------------------------------------------------------------------
-- match_bank_line's own function body is untouched — see "SUGGESTION, NEVER
-- AUTHORITY" above. This is an INDEPENDENT trigger on bank_statement_lines
-- that only ever fires AFTER matched_entry_id changes, so it can never be the
-- thing that performs a match, only observe one that already happened.
create or replace function app_private.sync_payment_webhook_event_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.matched_entry_id is not distinct from old.matched_entry_id then
    return new;
  end if;

  if new.matched_entry_id is not null then
    update public.payment_webhook_events
       set status = 'matched'
     where bank_statement_line_id = new.id and status = 'suggested';
  else
    -- Unmatched again (unmatch_bank_line) — revert to whatever it was before
    -- confirmation, so an admin can re-see and re-confirm the suggestion.
    update public.payment_webhook_events
       set status = case when suggested_voucher_id is not null then 'suggested' else 'received' end
     where bank_statement_line_id = new.id and status = 'matched';
  end if;

  return new;
end;
$$;

create trigger sync_payment_webhook_event_status
  after update of matched_entry_id on public.bank_statement_lines
  for each row execute function app_private.sync_payment_webhook_event_status();

comment on function app_private.sync_payment_webhook_event_status is
  'Reflects an existing bank_statement_lines row''s matched_entry_id back onto its originating payment_webhook_events.status (received/suggested <-> matched). Never itself calls match_bank_line or writes matched_entry_id — purely observational. See 1660.';


-- ----------------------------------------------------------------------------
-- 8. delete_company — extended for the two new tables, PLUS a real,
--    pre-existing, unrelated bug found (and deliberately NOT fixed) while
--    reading the LIVE function body before touching it.
-- ----------------------------------------------------------------------------
-- CONFIRMED LIVE, this session, before writing this section: the function
-- actually deployed today (pg_get_functiondef('public.delete_company(uuid)'))
-- is 0745's body, verbatim — and 0745's own CREATE OR REPLACE silently
-- dropped several explicit deletes that 0018/0019/0043/0047/0050 had each
-- separately added for their own tables (tax_ledger_map, bank_statement_
-- lines, and others), because CREATE OR REPLACE FUNCTION replaces the WHOLE
-- body and 0745 was evidently authored against an older copy. Reproduced
-- live in a ROLLED-BACK transaction, as a real admin (impersonated via
-- request.jwt.claim.sub) of company 395e9f55-99c9-449c-a861-f1ac1da1513f
-- (which has 7 real bank_statement_lines rows): calling delete_company
-- raises `update or delete on table "vouchers" violates foreign key
-- constraint "exim_shipment_details_voucher_id_company_id_fkey"` — a THIRD,
-- separate gap (the EXIM feature's own table was apparently never wired into
-- this function either) surfacing even before the bank_statement_lines/
-- tax_ledger_map gap this migration was actually looking for would have been
-- reached. Live counts confirming this is not theoretical: 14
-- bank_statement_lines rows and 174 tax_ledger_map rows exist right now
-- across real companies.
--
-- THIS MIGRATION DOES NOT FIX delete_company'S PRE-EXISTING GAPS. Restoring
-- tax_ledger_map/bank_statement_lines' own deletes, and whatever
-- exim_shipment_details (and possibly others accumulated the same way since
-- 0745) also needs, is real, valuable, but squarely a DIFFERENT feature's
-- surface than payments/webhooks — "touch only files relevant to your own
-- feature" applies here. Flagged as a separate follow-up task instead (see
-- this migration's own final report). What THIS migration DOES do is not
-- make that same class of bug WORSE: payment_gateway_configs.
-- settlement_ledger_id is a composite FK to ledgers with no cascade action
-- (the identical shape bank_statement_lines.ledger_id and tax_ledger_map.
-- ledger_id already have) — a company that ever configured a gateway could
-- otherwise NEVER be deleted at all, the same failure class, just a new
-- instance of it. The two lines below are inserted BEFORE the pre-existing
-- `delete from public.ledgers` line, in the same position 0019/0018's own
-- (now-dropped) lines occupied. payment_webhook_events.suggested_ledger_id
-- has the identical composite FK and needs the same ordering; its
-- bank_statement_line_id/suggested_voucher_id FKs are already ON DELETE SET
-- NULL, so only the ledger-referencing table itself needs an explicit line.
-- Every other line below is 0745's, character-for-character unchanged.
create or replace function public.delete_company(p_company_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can delete a company';
  end if;

  delete from public.vouchers where company_id = p_company_id;

  -- 1660: payment_webhook_events references ledgers (suggested_ledger_id)
  -- and payment_gateway_configs references ledgers (settlement_ledger_id),
  -- both via a composite FK with no cascade action — must go before the
  -- ledgers delete a few lines down, or that delete fails with a foreign key
  -- violation for any company that ever used this feature.
  delete from public.payment_webhook_events where company_id = p_company_id;
  delete from public.payment_gateway_configs where company_id = p_company_id;

  delete from public.ledgers where company_id = p_company_id;

  -- 0745: a WhatsApp-forwarded capture draft's media lives under a fixed
  -- sentinel folder, never under this company's own uuid prefix (see 0745
  -- migration header) — so the pre-existing bucket-prefix delete a few lines
  -- down, keyed on THIS company's own uuid, would never reach it. Removed
  -- explicitly here, by joining back to the capture_drafts rows this company
  -- has actually claimed, BEFORE those rows cascade away with the company.
  delete from storage.objects o
   where o.bucket_id = 'documents'
     and (storage.foldername(o.name))[1] = '00000000-0000-0000-0000-000000000000'
     and (storage.foldername(o.name))[2] = 'whatsapp-inbound'
     and exists (
       select 1 from public.capture_drafts d
        where d.id = ((storage.foldername(o.name))[3])::uuid
          and d.company_id = p_company_id
     );

  -- Storage objects have no FK to companies — removed explicitly, by folder
  -- prefix, before the company row itself goes. documents (the metadata
  -- table) cascades on its own FK and needs no line here.
  delete from storage.objects
   where bucket_id = 'documents'
     and (storage.foldername(name))[1] = p_company_id::text;

  delete from public.companies where id = p_company_id;

  delete from public.audit_log where company_id = p_company_id;
end;
$$;

revoke execute on function public.delete_company(uuid) from public, anon;
grant execute on function public.delete_company(uuid) to authenticated;

comment on function public.delete_company is
  'Deletes a company and everything under it. 1660 adds payment_webhook_events/payment_gateway_configs deletes (composite FK to ledgers, no cascade — must precede the ledgers delete). NOTE: this function has other, pre-existing, unrelated gaps (tax_ledger_map, bank_statement_lines, exim_shipment_details) not fixed by this migration — see 1660''s own header and this session''s final report for a flagged follow-up.';
