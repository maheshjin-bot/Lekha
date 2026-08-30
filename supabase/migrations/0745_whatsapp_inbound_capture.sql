-- ============================================================================
-- 0745 — WhatsApp bill forwarding: receiving half of OCR/vision capture (0740)
-- ============================================================================
-- Fast-follow on 0740 (capture_drafts), built in the same batch. Confirmed
-- before writing a line here: grepping the whole repo for "whatsapp"
-- (case-insensitive) turns up exactly three kinds of hit — 0740's own header
-- naming this as future work, this migration's own file, and one unrelated
-- instructional sentence in 0122 ("No SMS/WhatsApp/push channel"). There is
-- no WhatsApp integration anywhere in this codebase before this migration.
--
-- THE HONEST SCOPE, STATED UP FRONT. WhatsApp Business Cloud API messaging
-- needs a real Meta developer app, a verified business phone number, and an
-- access token — this app has none of those (no such credential exists in
-- .env.example, .env.local, or anywhere in this repo). That is a genuine
-- external-credential gate, the same category as GSTN/TRACES/ICEGATE
-- elsewhere in this schema: this migration and its companion route
-- (app/api/whatsapp/webhook/route.ts) build everything that does NOT require
-- Meta's servers to ever call back — the schema, the routing/claim logic,
-- the confirm-link flow, and code written against Meta's real documented
-- webhook contract — and say plainly, here and in the route's own header,
-- that no message has ever actually been received or sent, because the
-- credentials to do so do not exist in this environment.
--
-- ==========================================================================
-- WHAT THIS ADDS
-- ==========================================================================
-- 1. public.whatsapp_inbound_numbers — a company registers which of its own
--    WhatsApp Business phone_number_id(s) forward bills to it. A config row,
--    not a live integration: nothing here calls Meta, subscribes a webhook,
--    or verifies the number is real. See "SUGGESTION, NEVER AUTHORITY" below
--    for the one thing this table is actually allowed to influence.
--
-- 2. Four additive columns on 0740's capture_drafts: whatsapp_sender_phone,
--    whatsapp_phone_number_id, confirm_token, confirm_token_used_at — all
--    four null for an 'upload' draft (0740's own screen never touches them)
--    and all four required for a 'whatsapp' draft, enforced by a new CHECK
--    constraint. This is the same additive-extension shape 0575 used on
--    0175's signature_request_signers (access_token/token_last_used_at) —
--    read 0575 in full before this file; it is mirrored deliberately below.
--
-- 3. public.receive_whatsapp_inbound_message — the ONE way an unclaimed
--    'whatsapp' capture_drafts row is ever created. SECURITY DEFINER,
--    granted to anon (the same deliberate, documented reversal of this
--    schema's "anon gets nothing" convention that 0575's send/record
--    functions make for the identical reason: the caller, a webhook route
--    with no Supabase session, is not lying about being unauthenticated —
--    it genuinely is, and the door has to open for it specifically).
--
-- 4. public.get_capture_draft_by_token — the confirm-link lookup, mirroring
--    get_signature_request_by_token (0575) in spirit but NOT in one
--    important respect: it is granted to `authenticated` only, never `anon`.
--    0575's signer has no LEKHA account and never will; a WhatsApp sender's
--    forwarded bill, by contrast, is only ever useful once a real LEKHA team
--    member with real company access picks it up — this migration's whole
--    point is "a WhatsApp sender's phone number doesn't map to a company or
--    a login", so the confirm page requires a login FIRST (via (app)'s own
--    layout guard, exactly the pattern app/(app)/invite/[token]/page.tsx
--    already uses for the identical "not-yet-authenticated visitor" problem)
--    and only resolves the token afterwards.
--
-- 5. public.claim_capture_draft (0740) is reused UNCHANGED. It already does
--    exactly what claiming a WhatsApp draft needs — caller must independently
--    be a can_write_company member of the company they name, and the draft
--    must still be unclaimed and pending — so nothing about it is
--    WhatsApp-specific enough to justify a second function.
--
-- 6. public.delete_company (0060, last touched 0060 itself) gets one more
--    additive line — see "STORAGE CLEANUP" below for why it needs one.
--
-- 7. app_private.whatsapp_inbound_draft_ready, a narrow SECURITY DEFINER
--    predicate, plus two new storage.objects policies (one anon INSERT, one
--    authenticated DELETE) — see "A SECOND RLS TRAP" below for why the
--    predicate function exists at all rather than a plain EXISTS.
--
-- ==========================================================================
-- SUGGESTION, NEVER AUTHORITY: why whatsapp_inbound_numbers never sets
-- company_id.
-- ==========================================================================
-- It would be technically possible for receive_whatsapp_inbound_message to
-- look up whatsapp_inbound_numbers by the receiving phone_number_id and set
-- capture_drafts.company_id directly on insert, skipping the confirm-link
-- step entirely when a mapping exists. This migration deliberately does NOT
-- do that. A vendor's bill landing in the wrong company's books is a real
-- statutory-compliance mistake (wrong GSTIN claims ITC, wrong company's P&L
-- absorbs an expense), and the whole reason 0740 requires a human to press
-- "Post as purchase bill" rather than auto-posting a vision-model guess is
-- that the same discipline should apply one layer up: WHICH company a draft
-- belongs to is exactly as consequential as what account it posts to, so it
-- gets exactly the same "always a human, never inferred silently" treatment.
-- Instead, get_capture_draft_by_token computes a SUGGESTED company (joining
-- whatsapp_inbound_numbers by the phone_number_id the message actually
-- arrived on) and returns it for the confirm page to preselect in a dropdown
-- — a real convenience, zero automatic authority. claim_capture_draft still
-- requires an explicit p_company_id from the caller and still independently
-- re-checks can_write_company against whatever company that caller actually
-- picked, suggested or not.
--
-- ==========================================================================
-- THE STORAGE PATH PROBLEM 0740 NAMED, AND THE SENTINEL-FOLDER FIX
-- ==========================================================================
-- 0740's own header named this exact gap and left it unsolved: "an unclaimed
-- 'whatsapp' draft has no company_id yet and so cannot be given a path any
-- existing policy would let a human read even after claiming... the later
-- WhatsApp feature will need either a service-role write plus a follow-up
-- copy/re-path on claim, or a new narrow policy in the 0575 style." This
-- migration takes the second option, with one refinement 0575's own three
-- policies did not need to consider: EVERY existing policy on storage.objects
-- in this schema (0060's documents_bucket_read/write/delete, unconditionally;
-- 0575's three, after first checking a literal path segment) eventually casts
-- (storage.foldername(name))[1] or [3] to ::uuid. 0060's own policies do that
-- cast on element 1 with NO preceding guard at all — they assume, correctly
-- for every path this schema has ever written before now, that element 1 IS
-- always a real or plausible company_id. Storing a WhatsApp-forwarded file
-- under a literal first segment like 'whatsapp/...' would make element 1
-- something Postgres cannot cast to uuid at all, and — unlike 0575's own
-- policies, which check a literal at element [2] BEFORE ever touching a uuid
-- cast at [3] — 0060's policies have no such guard to protect an unconfident
-- reader from a hard runtime cast error the moment an authenticated user's
-- own query happens to visit such a row.
--
-- The fix: use a fixed, reserved, well-formed UUID
-- ('00000000-0000-0000-0000-000000000000') as element 1 instead of a literal
-- word. It always casts successfully, and app_private.is_company_member /
-- can_write_company both simply return false for a uuid that names no real
-- company row (gen_random_uuid(), what every real company_id is generated
-- with, cannot ever collide with the all-zero UUID) — so 0060's existing
-- policies harmlessly DENY authenticated access to this path with no error,
-- exactly the outcome wanted, and this migration's own new anon policy
-- (below) is the only one that ever grants anything under this prefix. Full
-- path shape: '00000000-0000-0000-0000-000000000000/whatsapp-inbound/
-- <capture_drafts.id>/media.<ext>'.
--
-- RESIDUAL LIMITATION, STATED PLAINLY (same discipline 0575's own header
-- uses for its own residual trade-off): once a WhatsApp-sourced draft is
-- CLAIMED, its file is NOT moved or copied into the claiming company's own
-- '<company_id>/...' prefix — it stays under the sentinel folder forever.
-- No authenticated read policy is added for that sentinel prefix either,
-- because — checked against components/capture/CaptureWorkspace.tsx (0740)
-- before deciding this — the existing capture review screen never renders
-- or downloads a draft's original image/PDF for either source today, only
-- the vision model's extracted_json fields; adding a viewer for the
-- 'upload' source's own files was already out of 0740's scope, so adding one
-- only for 'whatsapp' would be a worse inconsistency, not a better one. A
-- real consequence of leaving the file at the sentinel path: STORAGE CLEANUP
-- below.
--
-- ==========================================================================
-- STORAGE CLEANUP — delete_company needed one more line
-- ==========================================================================
-- delete_company (0060) already removes a company's own storage objects by
-- its own uuid prefix before the company row (and everything that cascades
-- from it) is gone. Because a claimed WhatsApp draft's file lives under the
-- SENTINEL prefix, not the claiming company's own, that existing delete
-- would never reach it — a silent, permanent storage orphan every time a
-- company that had ever claimed a WhatsApp bill was deleted. Fixed by one
-- additive DELETE, inserted (in the CREATE OR REPLACE below) BEFORE
-- `delete from public.companies`, since it has to run while the
-- capture_drafts rows it joins against still exist — company_id's cascade a
-- few lines later would otherwise erase the very rows this join needs first.
-- Every existing line of 0060's delete_company is unchanged.
--
-- ==========================================================================
-- WHAT get_capture_draft_by_token DOES AND DOES NOT REVEAL
-- ==========================================================================
-- Knowing the token is the authorization (0575's own "shareable-link model",
-- unchanged here) — but unlike a signature request's status (which stays
-- meaningful and low-sensitivity for the life of the request), a bill's
-- vendor name, amounts and GSTIN are real company data. So: while a draft is
-- still unclaimed and pending_review, the full extracted_json is returned
-- (the whole point — a human needs to SEE what arrived before picking a
-- company for it). The instant a draft is claimed, extracted_json is
-- withheld from every future token lookup, even a valid one — the response
-- says only that it was claimed, by which company, and links to that
-- company's own (ordinarily RLS-protected) /capture screen for anyone who
-- actually has real membership there. A stale or forwarded confirm link
-- therefore cannot be used to keep reading a company's bill contents after
-- the moment a real team member has taken ownership of the draft through the
-- app's own authenticated screens.
--
-- ==========================================================================
-- ANTI-TAMPER: DELIBERATELY NOT EXTENDING enforce_capture_draft's TRIGGER
-- ==========================================================================
-- 0575 protects access_token from a direct authenticated UPDATE by checking
-- `current_user = 'authenticated'` inside a NON-definer trigger (0175's
-- enforce_signature_request_signer_write), which works because current_user
-- there tracks whatever role is ACTUALLY active when the trigger fires —
-- 'authenticated' for a direct client write, or send_signature_request's own
-- elevated owner when called from inside that SECURITY DEFINER function.
-- 0740's enforce_capture_draft, unlike 0175's trigger, is ITSELF declared
-- SECURITY DEFINER — which means current_user inside its own body is ALWAYS
-- its owner, never 'authenticated', regardless of who originally issued the
-- statement, so copying 0575's exact guard into that function would not
-- discriminate anything (checked this before writing a line of trigger code
-- — did not just assume 0575's idiom ports over unchanged). Rather than
-- change 0740's trigger security context to make that check meaningful, this
-- migration accepts a narrower, explicitly-stated residual instead: RLS
-- already REQUIRES company_id to be non-null for any authenticated INSERT
-- (capture_drafts_write's own WITH CHECK), so an authenticated user can never
-- create an actually-unclaimed row — the worst they could do is insert a
-- source='whatsapp' row already carrying THEIR OWN company_id with a
-- self-chosen confirm_token. That token would only ever unlock (via
-- get_capture_draft_by_token) a "claimed by company_id" response for a row
-- they already fully own and can already see through ordinary RLS — no new
-- privilege, no other company's data reachable. Accepted, not fixed, for the
-- same reason 0575 accepted its own anon-storage-path residual: the fix
-- (destabilizing a sibling migration's trigger security context this session
-- has no live database to re-verify against) costs more than the risk it
-- would close.
--
-- ==========================================================================
-- A SECOND RLS TRAP, FOUND BEFORE SHIPPING: A POLICY'S OWN SUBQUERY IS STILL
-- SUBJECT TO THE SUBQUERIED TABLE'S RLS FOR THE CURRENT ROLE.
-- ==========================================================================
-- The first draft of the anon storage policy below wrote the SAME shape
-- 0575's own three anon storage policies use: a raw
-- `exists (select 1 from public.capture_drafts d where ...)` inside the
-- policy expression. That is wrong, and would have silently denied every
-- single upload: capture_drafts' own RLS policies (0740) are `to
-- authenticated` only — there is no policy granting `anon` anything on that
-- table — and a table subquery referenced from INSIDE another table's policy
-- expression is not exempt from the referenced table's own row security. It
-- is enforced exactly as if `anon` had queried capture_drafts directly, which
-- returns zero rows, which makes any `exists(...)` referencing it evaluate to
-- false for every anon caller, always. app_private.is_company_member /
-- can_write_company avoid exactly this trap by being SECURITY DEFINER
-- (confirmed by reading their real definitions, 0003, before writing this
-- paragraph) — that is WHY every other RLS policy in this schema can safely
-- call them from inside its own USING/WITH CHECK clause. The fix here is the
-- same shape: app_private.whatsapp_inbound_draft_ready, a narrow SECURITY
-- DEFINER predicate, explicitly granted to anon (this migration's usual
-- grant-hygiene discipline: revoke from public/authenticated, grant only to
-- the one role that needs it), stands in for the raw subquery.
--
-- Note for whoever next touches 0575: its three anon storage.objects
-- policies have this exact same shape (raw EXISTS against
-- signature_requests/signature_request_signers, both `to authenticated`
-- only, no anon policy) and, by the same reasoning, likely have the same
-- bug — worth a real, isolated look, but out of THIS migration's scope to
-- change a previously-shipped, unrelated feature's file on a hunch this
-- session has no live database to actually reproduce or verify the failure
-- against. Named here so it is not silently rediscovered later.
--
-- The delete_company extension (below) does NOT need this fix: it runs
-- SECURITY INVOKER as the calling authenticated admin, and capture_drafts'
-- EXISTING authenticated read policy already legitimately covers a real
-- company admin reading their own company's rows (is_company_member is
-- itself SECURITY DEFINER, so it does not re-trigger this same trap). What
-- delete_company DOES still need is a new storage.objects DELETE policy FOR
-- authenticated on the sentinel prefix — 0060's own documents_bucket_delete
-- only matches a path whose first segment is a real company_id, which the
-- sentinel deliberately never is (see above) — added below, alongside the
-- anon INSERT policy.
--
-- ==========================================================================
-- DELIBERATELY NOT DONE HERE (named, not silently omitted)
-- ==========================================================================
--   * No live WhatsApp message has ever been sent or received by this code —
--     see the honest-scope paragraph above and the webhook route's own
--     header for the exact boundary.
--   * No re-analysis / retry path if analyzeCaptureImage (0740, reused
--     unmodified) degrades to "low confidence" for a WhatsApp-forwarded
--     image — same limit 0740 already accepted for the upload path.
--   * No cleanup job for an unclaimed draft nobody ever confirms (a bill
--     forwarded to a wrong/mistyped number, or one nobody gets around to
--     claiming) — it sits in capture_drafts forever, pending_review, company
--     id null, exactly as 0740's own header already flagged as out of scope.
--   * No signature-based replay/dedup guard against Meta redelivering the
--     same webhook event (Meta's own docs say deliveries can be retried) —
--     redelivery of the same message creates a second, independent draft
--     with its own confirm link rather than being recognised as a duplicate.
--     wa_message_id is parsed by the route but not persisted or checked
--     against past deliveries; a real dedup would need it stored and
--     unique-constrained, deferred as a separate, small follow-up.
--   * WHATSAPP_APP_SECRET-based payload signature verification is written
--     into the route (Meta's own documented X-Hub-Signature-256 contract)
--     but, like every other WhatsApp credential here, has never been
--     exercised against a real Meta-signed request.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. whatsapp_inbound_numbers — company config, not a live subscription.
--    Write is admin-gated, matching 0725's voucher_number_series precedent:
--    this changes which company a future bill gets SUGGESTED into, the same
--    "configuration decision, not a day-to-day posting act" category 0725's
--    own header argues for numbering policy.
-- ----------------------------------------------------------------------------
create table public.whatsapp_inbound_numbers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  -- Meta's own stable identifier for one of the company's WhatsApp Business
  -- numbers (metadata.phone_number_id in every inbound webhook payload) —
  -- globally unique because one real Meta number can only ever forward its
  -- messages to one LEKHA company.
  whatsapp_phone_number_id text not null unique check (length(trim(whatsapp_phone_number_id)) > 0),

  -- Purely descriptive (e.g. "+91 98765 43210") — never used for routing or
  -- matching, since Meta's own phone_number_id (above) is the real key and
  -- display formatting can vary or change without notice.
  display_phone_number text,

  is_active boolean not null default true,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index whatsapp_inbound_numbers_company_idx on public.whatsapp_inbound_numbers (company_id);

create trigger set_updated_at before update on public.whatsapp_inbound_numbers
  for each row execute function app_private.set_updated_at();

alter table public.whatsapp_inbound_numbers enable row level security;

create policy whatsapp_inbound_numbers_read on public.whatsapp_inbound_numbers
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

create policy whatsapp_inbound_numbers_write on public.whatsapp_inbound_numbers
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

comment on table public.whatsapp_inbound_numbers is
  'A company-registered WhatsApp Business phone_number_id, used ONLY to compute a SUGGESTED company on the /whatsapp-confirm/[token] screen (get_capture_draft_by_token) — never to set capture_drafts.company_id automatically. See 0745 migration header, "SUGGESTION, NEVER AUTHORITY". A config row; registering one here does not subscribe, verify, or contact Meta in any way.';
comment on column public.whatsapp_inbound_numbers.whatsapp_phone_number_id is
  'Meta''s own phone_number_id for this WhatsApp Business number (metadata.phone_number_id in the Cloud API webhook payload) — not the displayed phone number itself, which can be formatted differently or changed without notice.';


-- ----------------------------------------------------------------------------
-- 2. capture_drafts (0740) — four additive columns for the 'whatsapp' source.
-- ----------------------------------------------------------------------------
alter table public.capture_drafts
  add column whatsapp_sender_phone text,
  add column whatsapp_phone_number_id text,
  add column confirm_token text unique,
  add column confirm_token_used_at timestamptz;

alter table public.capture_drafts
  add constraint capture_drafts_whatsapp_fields_check check (
    case source
      when 'whatsapp' then
        whatsapp_sender_phone is not null
        and whatsapp_phone_number_id is not null
        and confirm_token is not null
      else
        whatsapp_sender_phone is null
        and whatsapp_phone_number_id is null
        and confirm_token is null
        and confirm_token_used_at is null
    end
  );

comment on column public.capture_drafts.whatsapp_sender_phone is
  'The WhatsApp wa_id (E.164, no leading +) that forwarded this bill. Null for source=''upload''. See 0745.';
comment on column public.capture_drafts.whatsapp_phone_number_id is
  'Which of a company''s (or nobody''s, if unregistered) WhatsApp Business numbers received this message — Meta''s metadata.phone_number_id, joined against whatsapp_inbound_numbers to compute a SUGGESTED company. Null for source=''upload''. See 0745.';
comment on column public.capture_drafts.confirm_token is
  'Long random opaque secret (encode(gen_random_bytes(32),''hex'') — 256 bits) minting the public /whatsapp-confirm/[token] link. Generated once, at creation, by receive_whatsapp_inbound_message. Null for source=''upload'' — an authenticated /capture screen user never needs one. See 0745.';
comment on column public.capture_drafts.confirm_token_used_at is
  'Bumped by get_capture_draft_by_token on every successful lookup — the same minimal "was this link ever opened" signal 0575''s token_last_used_at provides. See 0745.';


-- ----------------------------------------------------------------------------
-- 3. receive_whatsapp_inbound_message — the ONE way an unclaimed 'whatsapp'
--    draft is created. SECURITY DEFINER, granted to anon — see migration
--    header for why that reversal is deliberate here, same as 0575's own
--    send_signature_request/record_signed_document_by_token precedent.
-- ----------------------------------------------------------------------------
create or replace function public.receive_whatsapp_inbound_message(
  p_whatsapp_phone_number_id text,
  p_sender_phone text,
  p_mime_type text,
  p_extracted_json jsonb default null
) returns table (
  draft_id uuid,
  storage_path text,
  confirm_token text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft_id uuid := gen_random_uuid();
  v_confirm_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_ext text;
  v_storage_path text;
begin
  if p_whatsapp_phone_number_id is null or length(trim(p_whatsapp_phone_number_id)) = 0 then
    raise exception 'whatsapp_phone_number_id is required';
  end if;
  if p_sender_phone is null or length(trim(p_sender_phone)) = 0 then
    raise exception 'sender phone is required';
  end if;

  -- Same allow-list as 0740's own /api/capture/analyze route (ALLOWED_MIME):
  -- defense in depth, mirroring record_signed_document_by_token's (0575) own
  -- reasoning for repeating a check the caller SHOULD already have made.
  v_ext := case p_mime_type
    when 'image/jpeg' then 'jpg'
    when 'image/png' then 'png'
    when 'image/webp' then 'webp'
    when 'application/pdf' then 'pdf'
    else null
  end;
  if v_ext is null then
    raise exception 'Unsupported media type: %', p_mime_type;
  end if;

  -- Fixed sentinel folder, not this (nonexistent) draft's eventual company —
  -- see migration header, "THE STORAGE PATH PROBLEM 0740 NAMED, AND THE
  -- SENTINEL-FOLDER FIX", for why a real uuid that names no company is used
  -- here instead of a literal word.
  v_storage_path := '00000000-0000-0000-0000-000000000000/whatsapp-inbound/'
    || v_draft_id::text || '/media.' || v_ext;

  insert into public.capture_drafts (
    id, company_id, branch_id, source, storage_path, extracted_json,
    whatsapp_sender_phone, whatsapp_phone_number_id, confirm_token, created_by
  ) values (
    v_draft_id, null, null, 'whatsapp', v_storage_path, p_extracted_json,
    p_sender_phone, p_whatsapp_phone_number_id, v_confirm_token, null
  );

  return query select v_draft_id, v_storage_path, v_confirm_token;
end;
$$;

revoke all on function public.receive_whatsapp_inbound_message(text, text, text, jsonb) from public, authenticated;
grant execute on function public.receive_whatsapp_inbound_message(text, text, text, jsonb) to anon;

comment on function public.receive_whatsapp_inbound_message is
  'The only way an unclaimed (company_id IS NULL) ''whatsapp''-sourced capture_drafts row is created. Called by app/api/whatsapp/webhook/route.ts using the anon key (a webhook has no Supabase session) after it has already downloaded the attachment from Meta''s Graph API and run it through the same lib/capture/analyze.ts the upload path (0740) uses. Returns the draft id, the storage path the caller must upload the raw bytes to next (gated by a matching anon INSERT policy on storage.objects), and the confirm_token that becomes /whatsapp-confirm/<token>. See 0745.';


-- ----------------------------------------------------------------------------
-- 4. get_capture_draft_by_token — the confirm-link lookup. Authenticated
--    only (never anon) — see migration header for why this differs from
--    0575's own anon-granted get_signature_request_by_token.
-- ----------------------------------------------------------------------------
create or replace function public.get_capture_draft_by_token(p_token text)
-- VOLATILE (the default), not stable: this bumps confirm_token_used_at, a
-- real side effect. Marking this stable would make PostgREST open a
-- read-only transaction that then refuses that UPDATE — the exact failure
-- 0063's own api_get_trial_balance comment documents hitting live, and 0575
-- repeats for get_signature_request_by_token; not repeating it a third time.
returns table (
  draft_id uuid,
  source text,
  status text,
  claimed boolean,
  company_id uuid,
  company_name text,
  whatsapp_sender_phone text,
  suggested_company_id uuid,
  suggested_company_name text,
  extracted_json jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.capture_drafts;
  v_company_name text;
  v_suggested_id uuid;
  v_suggested_name text;
begin
  if p_token is null or length(p_token) = 0 then
    raise exception 'Invalid confirmation link';
  end if;

  select * into v_draft from public.capture_drafts where confirm_token = p_token;
  if v_draft.id is null then
    -- Same "one message for any invalid credential" discipline as
    -- authenticate_signer_token/authenticate_api_key.
    raise exception 'Invalid confirmation link';
  end if;

  -- Only while still pending_review: enforce_capture_draft (0740) raises on
  -- ANY update once a row is confirmed/rejected (its own terminal-state
  -- guard applies to every column, not just the ones a client meant to
  -- change), so unconditionally bumping this timestamp would turn "someone
  -- re-opened an old link after the bill was already posted" into a hard
  -- error instead of the friendly "already claimed" response below. A
  -- claimed-but-not-yet-posted row is still status='pending_review' (claim_
  -- capture_draft only touches company_id/branch_id), so this still covers
  -- the claim flow's own repeat visits.
  if v_draft.status = 'pending_review' then
    update public.capture_drafts set confirm_token_used_at = now() where id = v_draft.id;
  end if;

  if v_draft.company_id is not null then
    select name into v_company_name from public.companies where id = v_draft.company_id;
  else
    select n.company_id, c.name into v_suggested_id, v_suggested_name
      from public.whatsapp_inbound_numbers n
      join public.companies c on c.id = n.company_id
     where n.whatsapp_phone_number_id = v_draft.whatsapp_phone_number_id
       and n.is_active
     limit 1;
  end if;

  return query select
    v_draft.id,
    v_draft.source,
    v_draft.status,
    v_draft.company_id is not null,
    v_draft.company_id,
    v_company_name,
    v_draft.whatsapp_sender_phone,
    v_suggested_id,
    v_suggested_name,
    -- Withheld once claimed, regardless of token validity — see migration
    -- header, "WHAT get_capture_draft_by_token DOES AND DOES NOT REVEAL".
    case when v_draft.company_id is null and v_draft.status = 'pending_review'
      then v_draft.extracted_json else null end,
    v_draft.created_at;
end;
$$;

revoke all on function public.get_capture_draft_by_token(text) from public, anon;
grant execute on function public.get_capture_draft_by_token(text) to authenticated;

comment on function public.get_capture_draft_by_token is
  'Resolves a capture_drafts.confirm_token for the (already-authenticated — see 0745 migration header) /whatsapp-confirm/[token] page. While the draft is unclaimed and pending_review, returns its full extracted_json plus a SUGGESTED company (from whatsapp_inbound_numbers, never authoritative) for the confirm page''s picker. Once claimed, extracted_json is withheld and only claimed/company_id/company_name are returned. Raises "Invalid confirmation link" for any unknown/garbage token.';


-- ----------------------------------------------------------------------------
-- 5. delete_company (0060) — one additive line, inserted before the company
--    row's own delete. Every other line is 0060's, unchanged. See migration
--    header, "STORAGE CLEANUP".
-- ----------------------------------------------------------------------------
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
  'Deletes a company and everything under it, in FK-safe order: vouchers before ledgers (entries hold the references), this company''s claimed WhatsApp-inbound storage objects under the sentinel prefix (0745), storage.objects under this company''s own folder prefix (no FK to companies — see 0060), then the company row itself (cascades account groups/branches/registrations/members/invites/modules/tax_ledger_map/documents/capture_drafts/whatsapp_inbound_numbers), then the audit trail (deliberately no FK, so it does not cascade).';


-- ----------------------------------------------------------------------------
-- 6. app_private.whatsapp_inbound_draft_ready — SECURITY DEFINER predicate
--    used by the anon storage policy below, so that policy's own check does
--    not fall into the RLS-nesting trap described in the migration header.
--    Same shape as app_private.is_company_member (0003): `language sql
--    security definer ... stable`, a single SELECT, nothing else.
-- ----------------------------------------------------------------------------
create or replace function app_private.whatsapp_inbound_draft_ready(p_draft_id uuid, p_storage_path text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.capture_drafts d
     where d.id = p_draft_id
       and d.source = 'whatsapp'
       and d.status = 'pending_review'
       and d.storage_path = p_storage_path
  );
$$;

revoke all on function app_private.whatsapp_inbound_draft_ready(uuid, text) from public, authenticated;
grant execute on function app_private.whatsapp_inbound_draft_ready(uuid, text) to anon;

comment on function app_private.whatsapp_inbound_draft_ready(uuid, text) is
  'True only for a still-pending, WhatsApp-sourced capture_drafts row whose OWN storage_path matches exactly. SECURITY DEFINER so the anon storage.objects policy that calls it is not itself subject to capture_drafts'' authenticated-only RLS (see 0745 migration header, "A SECOND RLS TRAP"). Granted to anon ONLY — this is not a general-purpose lookup.';


-- ----------------------------------------------------------------------------
-- 7. storage.objects — one new anon INSERT policy (the webhook route's own
--    upload, immediately after receive_whatsapp_inbound_message creates the
--    matching row) and one new authenticated DELETE policy (so
--    delete_company's new cleanup line, above, actually has permission to
--    remove anything — see migration header for why 0060's own delete policy
--    does not cover the sentinel prefix).
-- ----------------------------------------------------------------------------
create policy documents_bucket_write_whatsapp_inbound_anon on storage.objects
  for insert to anon
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000000'
    and (storage.foldername(name))[2] = 'whatsapp-inbound'
    and (select app_private.whatsapp_inbound_draft_ready(((storage.foldername(name))[3])::uuid, name))
  );

comment on policy documents_bucket_write_whatsapp_inbound_anon on storage.objects is
  '0745: lets the anon-context WhatsApp webhook route upload one attachment''s bytes, immediately after receive_whatsapp_inbound_message creates the matching capture_drafts row naming that EXACT path. Goes through app_private.whatsapp_inbound_draft_ready (SECURITY DEFINER) rather than a raw EXISTS — see migration header, "A SECOND RLS TRAP" — and requiring storage_path = name means this can never be used to write a second, different file into an already-used draft folder.';

create policy documents_bucket_delete_whatsapp_inbound_authenticated on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000000'
    and (storage.foldername(name))[2] = 'whatsapp-inbound'
    and exists (
      select 1 from public.capture_drafts d
       where d.id = ((storage.foldername(name))[3])::uuid
         and d.company_id is not null
         and (select app_private.can_write_company(d.company_id))
    )
  );

comment on policy documents_bucket_delete_whatsapp_inbound_authenticated on storage.objects is
  '0745: lets delete_company''s new cleanup line (above) actually remove a claimed WhatsApp draft''s file — 0060''s own documents_bucket_delete only matches a path whose first segment is a real company_id, which the sentinel prefix deliberately never is. Unlike the anon INSERT policy above, a raw EXISTS against capture_drafts is safe HERE: capture_drafts already grants `authenticated` read access to a company''s own rows (is_company_member/can_write_company are themselves SECURITY DEFINER), so this does not hit the same RLS-nesting trap.';
