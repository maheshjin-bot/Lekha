-- ============================================================================
-- 0870 — Phone document scanner, phase 1: multi-page capture, a submit/review
--        lifecycle, and the narrow RPC surface the whole feature runs through
-- ============================================================================
-- 0740 built capture as ONE ROW = ONE FILE, analysed at upload time, reviewed
-- and confirmed by the same person who uploaded it. 0865 made it universal
-- across document types. This migration turns it into a two-person, N-page
-- workflow: somebody on the shop floor photographs a document page by page on
-- a phone and SENDS it; somebody at a desk later REVIEWS what was sent, has
-- the vision model read it AT THAT MOMENT, edits, and posts.
--
-- ============================================================================
-- 1. THE LOAD-BEARING INVARIANT FROM 0740, RESTATED AND PRESERVED
-- ============================================================================
-- A DRAFT STILL NEVER POSTS ITSELF. Not one function added below calls
-- create_invoice, or writes vouchers / voucher_entries / voucher_items, or
-- sets confirmed_voucher_id. confirmed_voucher_id continues to be written by
-- the CLIENT, after a human has reviewed the extracted fields and the browser
-- has itself called the ordinary create_invoice RPC — exactly as if the bill
-- had been typed in by hand. app_private.enforce_capture_draft still computes
-- `status` from confirmed_voucher_id rather than trusting the client, and
-- that derivation is copied through this migration UNCHANGED (section 4).
-- Everything here is staging, routing and permissions; the ledger is reached
-- only the one way it has always been reached.
--
-- ============================================================================
-- 2. WHY EVERY ACCESS PATH IS AN RPC, NOT A TABLE READ
-- ============================================================================
-- A shop-floor `operator` role — someone who may photograph documents but may
-- see nothing else in the books — is a DELIBERATE LATER PHASE, not built here
-- (company_members.role's CHECK constraint still accepts exactly
-- 'admin' | 'accountant' | 'auditor', and this migration does not touch it).
-- But the shape chosen today decides how expensive that role is to add
-- tomorrow. If the phone screen read and wrote public.capture_drafts through
-- PostgREST directly, adding a fourth role would mean re-auditing what that
-- role can now reach across every RLS policy in a 111-table schema, because
-- `authenticated` is the role every policy in this database is written
-- against.
--
-- So: every scanner operation below is a narrow SECURITY DEFINER RPC, and
-- each one asks EXACTLY ONE of two predicates —
--
--   app_private.can_capture_documents(company)  — may photograph and send
--   app_private.can_review_captures(company)    — may read the queue, reject,
--                                                 and store an extraction
--
-- Both are `can_write_company` today, so nothing about who-can-do-what
-- changes in this migration. Adding the operator role later is then a
-- one-line edit inside can_capture_documents, with can_review_captures
-- deliberately left alone (an operator sends; an operator does not review).
-- That is the entire point of this indirection — it is not ceremony.
--
-- RLS on the new table is still written (section 3) and still mirrors
-- capture_drafts' own visibility. The RPCs are the door; RLS is the wall
-- behind it, so a direct PostgREST read is not a way around either.
--
-- ============================================================================
-- 3. HOW "STILL CAPTURING" IS REPRESENTED — submitted_at, NOT a new status
-- ============================================================================
-- A draft being assembled on a phone (page 1 taken, page 2 not yet) must not
-- appear in anybody's review queue. Two ways to say that: a fourth `status`
-- value, or a nullable timestamp. This migration uses the timestamp:
--
--     "still capturing"  ==  status = 'pending_review' AND submitted_at IS NULL
--     "sent for review"  ==  status = 'pending_review' AND submitted_at IS NOT NULL
--
-- WHY NOT A NEW STATUS VALUE. `status` is the column
-- app_private.enforce_capture_draft DERIVES rather than accepts — its final
-- CASE collapses everything the client sends to 'pending_review' unless a
-- real confirmed_voucher_id earns 'confirmed' or the client explicitly asks
-- for 'rejected'. Adding a fourth value means widening both that CASE and the
-- CHECK constraint, which means the client can once again put the column into
-- a state the trigger did not compute — the exact guarantee 0740 wrote the
-- trigger to hold, and which this migration was told not to weaken. It would
-- also silently change what every existing reader of `status` sees
-- (app/(app)/[companyId]/capture/page.tsx and components/capture/*.tsx both
-- switch on the three-value union today). A separate nullable timestamp adds
-- a fact without touching the derived column at all.
--
-- EXISTING ROWS ARE NOT BROKEN. submitted_at is added with NO default, every
-- pre-existing row is backfilled to its own created_at (all of them arrived
-- through single-shot paths — the /capture upload route and the WhatsApp
-- webhook — so they were reviewable the moment they existed), and only THEN
-- does the column get `default now()`. That default is what keeps every
-- non-scanner insert path working unchanged: receive_whatsapp_inbound_message
-- (0745) and the old upload route neither know nor need to know about
-- submitted_at, and their rows come out submitted, exactly as before. Only
-- create_capture_draft below writes submitted_at = NULL explicitly, because
-- it is the only path where more pages are still coming.
--
-- The trigger gains ONE new rule (section 4): submitted_at is monotonic — once
-- set it cannot be cleared or moved. Sending is not undoable, so a client
-- cannot pull a document back out of the reviewer's queue after the reviewer
-- has started looking at it.
--
-- WHAT THE TRIGGER DELIBERATELY DOES NOT ENFORCE: that a 'rejected' row
-- carries a rejected_reason. The reject_capture_draft RPC requires one and
-- refuses an empty string, but the existing "discard this draft" button in
-- components/capture/CaptureWorkspace.tsx sets status='rejected' directly with
-- no reason, and that path is not this migration's to break. The requirement
-- lives in the RPC, where the scanner workflow actually goes.
--
-- ============================================================================
-- 4. storage_path ON A DRAFT THAT HAS NO PAGES YET
-- ============================================================================
-- capture_drafts.storage_path is NOT NULL UNIQUE (0740) and is read by
-- app_private.whatsapp_inbound_draft_ready (0745) as an exact-match key, so
-- dropping the NOT NULL would weaken a live storage policy's precondition for
-- the sake of a transient state. It is NOT dropped. Instead
-- create_capture_draft seeds it with the draft's OWN FOLDER PREFIX —
-- '<company_id>/capture/<draft_id>/' — which is unique per draft by
-- construction, and add_capture_draft_page overwrites it with page 1's real
-- object path the instant page 1 arrives. A draft whose storage_path still
-- ends in '/' is by definition a zero-page draft nobody has sent.
--
-- Page paths are DETERMINISTIC per (draft, page number) rather than carrying
-- a fresh random UUID each time, so that a phone retrying a lost upload
-- overwrites the same object instead of leaving an orphan in the bucket
-- behind every dropped response. add_capture_draft_page additionally refuses
-- any path not under the draft's own company folder, which is the exact
-- prefix the 'documents' bucket's storage.objects RLS keys off — a page can
-- therefore never be pointed at another tenant's object.
--
-- ============================================================================
-- 5. OCR MOVES FROM CAPTURE TIME TO REVIEW TIME
-- ============================================================================
-- 0740's header says extracted_json "is set once, at creation" and names a
-- re-extraction endpoint as deliberately out of scope. THIS MIGRATION
-- REVERSES THAT, on purpose: a vision call is spent only on a document a
-- human has actually opened to review, not on every photograph a shop floor
-- takes. set_capture_draft_extraction is the write path, extracted_at records
-- when it happened (backfilled to created_at for the rows that were extracted
-- at upload time under the old rule, so the column never lies about history),
-- and app/api/capture/upload no longer calls Gemini at all.
--
-- ============================================================================
-- 6. DELIBERATELY NOT DONE HERE (named, not silently omitted)
-- ============================================================================
--   * No 'operator' role. Section 2 — the hook is built, the role is not.
--   * No new `source` value. A scanner draft is source='upload', the same as
--     a browser upload; nothing in this feature needs to tell them apart, and
--     widening that CHECK for a label nobody reads is not worth it.
--   * No per-page extraction. set_capture_draft_extraction stores ONE
--     extraction per draft, and the /api/capture/extract route reads page 1.
--     A genuinely multi-page bill whose totals are on page 3 is a known
--     limitation of phase 1, stated rather than hidden.
--   * No server-side sha256. The column is filled by whoever uploads; the
--     duplicate flag in get_capture_review_queue is therefore advisory, and
--     is only ever a flag — nothing is blocked or auto-merged on it.
--   * No deletion of a rejected draft's stored pages. Rejection is a record
--     that something was sent and sent back, and the image is the evidence.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. New columns on capture_drafts
-- ----------------------------------------------------------------------------
alter table public.capture_drafts
  add column if not exists submitted_at      timestamptz,
  add column if not exists rejected_reason   text,
  add column if not exists rejected_by       uuid references auth.users(id) on delete set null,
  add column if not exists rejected_at       timestamptz,
  add column if not exists client_dedupe_key text,
  add column if not exists vendor_hint       text,
  add column if not exists note              text,
  add column if not exists extracted_at      timestamptz;

-- THE BACKFILL HAS TO RUN WITH THE GUARD TRIGGER OFF, and that is not a
-- shortcut — it is the only correct way to do it. enforce_capture_draft
-- raises on ANY update to a row whose status is already 'confirmed' or
-- 'rejected' ("its record cannot be changed further", 0740), and 4 of the 8
-- capture_drafts rows live today are exactly that. Found the honest way: the
-- first attempt at this migration aborted on that RAISE. Disabling the
-- trigger for the two statements below is also what keeps `updated_at`
-- truthful — the trigger would otherwise stamp now() on every historic row,
-- claiming a bill confirmed weeks ago was edited by this migration. Nothing
-- here changes a status, a voucher link or any other column the trigger
-- guards; it only fills in two timestamps that describe what already
-- happened.
alter table public.capture_drafts disable trigger enforce_capture_draft;

-- Backfill BEFORE the default is attached — see header section 3. Every row
-- that exists today arrived through a single-shot path and was reviewable
-- immediately, so its own created_at is the honest submission moment.
update public.capture_drafts
   set submitted_at = created_at
 where submitted_at is null;

-- Likewise: rows extracted at upload time under 0740's rule were extracted
-- when they were created. Rows with no extraction stay null.
update public.capture_drafts
   set extracted_at = created_at
 where extracted_at is null
   and extracted_json is not null;

alter table public.capture_drafts enable trigger enforce_capture_draft;

-- Attached only now, so the backfill above could not be overwritten by it.
-- This is what keeps receive_whatsapp_inbound_message (0745) and any other
-- single-shot insert working unchanged: their rows come out already
-- submitted. create_capture_draft is the ONE path that overrides it to null.
alter table public.capture_drafts
  alter column submitted_at set default now();

-- The phone's offline retry made idempotent: the same physical document,
-- retried after a dropped response, resolves to the SAME draft rather than a
-- second one. Partial so that the overwhelming majority of rows (WhatsApp,
-- browser upload, everything before today) carry no key and are unconstrained.
create unique index if not exists capture_drafts_company_dedupe_key_idx
  on public.capture_drafts (company_id, client_dedupe_key)
  where client_dedupe_key is not null;

-- The review queue's own access path: one company, newest submissions first.
create index if not exists capture_drafts_company_submitted_idx
  on public.capture_drafts (company_id, submitted_at desc);

-- get_my_capture_drafts' access path: one capturer's own recent sends.
create index if not exists capture_drafts_created_by_idx
  on public.capture_drafts (created_by, created_at desc);

comment on column public.capture_drafts.submitted_at is
  'When the capturer SENT this document for review. NULL means it is still being assembled on the phone and must not appear in any review queue — see 0870 section 3 for why this is a timestamp rather than a fourth status value. Defaults to now() so every non-scanner insert path (WhatsApp, browser upload) is submitted on creation exactly as before; only create_capture_draft writes it null. Monotonic: enforce_capture_draft refuses to clear or move it.';

comment on column public.capture_drafts.rejected_reason is
  'Why a reviewer sent this document back, shown to the capturer on their own phone. Required and non-empty when rejecting via reject_capture_draft (0870); NOT required by the trigger, because the pre-existing "discard" button in CaptureWorkspace rejects with no reason and that path is not broken here.';

comment on column public.capture_drafts.client_dedupe_key is
  'A key the CAPTURING DEVICE chooses (per physical document, stable across retries) so that re-sending after a dropped response resolves to the same draft. Unique per company where present. Never trusted for anything but idempotency.';

comment on column public.capture_drafts.vendor_hint is
  'What the capturer typed about who the document is from, before any OCR ran — a shop-floor hint for the reviewer, never a party id and never matched against ledgers automatically.';

comment on column public.capture_drafts.extracted_at is
  'When extracted_json was last written. 0740 extracted at upload time; 0870 moves extraction to review time (set_capture_draft_extraction), so this exists to say WHICH of the two a given row went through. Backfilled to created_at for rows extracted under the old rule.';


-- ----------------------------------------------------------------------------
-- 2. capture_draft_pages — one row per photographed page
-- ----------------------------------------------------------------------------
create table if not exists public.capture_draft_pages (
  id uuid primary key default gen_random_uuid(),

  draft_id uuid not null references public.capture_drafts(id) on delete cascade,

  -- 1-based, as printed on paper. Gaps are allowed while capturing (a phone
  -- may finish page 3's upload before page 2's retry succeeds); nothing here
  -- requires contiguity, and submit_capture_draft only requires >= 1 page.
  page_no int not null check (page_no >= 1),

  -- Into the same private 'documents' bucket (0060) every other attachment
  -- uses. Unique so two drafts can never resolve to the same object, the same
  -- reason capture_drafts.storage_path is unique (0740).
  storage_path text not null unique,

  -- Filled by whoever uploaded the bytes. Advisory: it drives the duplicate
  -- FLAG in get_capture_review_queue and nothing else — see header section 6.
  sha256 text,

  created_at timestamptz not null default now(),

  constraint capture_draft_pages_draft_page_key unique (draft_id, page_no)
);

create index if not exists capture_draft_pages_draft_idx
  on public.capture_draft_pages (draft_id, page_no);

create index if not exists capture_draft_pages_sha256_idx
  on public.capture_draft_pages (sha256)
  where sha256 is not null;

comment on table public.capture_draft_pages is
  'The N page images of one capture_drafts row (0870). A draft with zero pages is one still being assembled on a phone. Deleting the draft cascades; nothing here posts to the ledger — see 0870 section 1.';

alter table public.capture_draft_pages enable row level security;

-- Mirrors capture_drafts' own visibility exactly: a page is readable iff its
-- draft is readable, writable iff its draft is writable. The membership test
-- is spelled out rather than left to the referenced table's own RLS, so the
-- rule holds identically whichever way Postgres chooses to evaluate the
-- subquery.
create policy capture_draft_pages_read on public.capture_draft_pages
  for select to authenticated
  using (
    exists (
      select 1
        from public.capture_drafts d
       where d.id = capture_draft_pages.draft_id
         and d.company_id is not null
         and (select app_private.is_company_member(d.company_id))
    )
  );

create policy capture_draft_pages_write on public.capture_draft_pages
  for all to authenticated
  using (
    exists (
      select 1
        from public.capture_drafts d
       where d.id = capture_draft_pages.draft_id
         and d.company_id is not null
         and (select app_private.can_write_company(d.company_id))
    )
  )
  with check (
    exists (
      select 1
        from public.capture_drafts d
       where d.id = capture_draft_pages.draft_id
         and d.company_id is not null
         and (select app_private.can_write_company(d.company_id))
    )
  );


-- ----------------------------------------------------------------------------
-- 3. The TWO role predicates the whole feature funnels through
-- ----------------------------------------------------------------------------
-- See header section 2. Adding the shop-floor 'operator' role later means
-- editing can_capture_documents ONLY, and leaving can_review_captures alone.
create or replace function app_private.can_capture_documents(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- Today: identical to can_write_company. Tomorrow, when company_members
  -- gains 'operator', this becomes
  --   app_private.user_role_in_company(p_company_id)
  --     in ('admin','accountant','operator')
  -- and NOTHING ELSE in the scanner changes.
  select coalesce(app_private.can_write_company(p_company_id), false);
$$;

comment on function app_private.can_capture_documents(uuid) is
  'May this caller photograph documents into this company''s capture queue? The single place the future shop-floor ''operator'' role gets added — every capture RPC in 0870 asks this and nothing else. Identical to can_write_company today.';

create or replace function app_private.can_review_captures(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- Deliberately NOT widened when 'operator' arrives: sending a document and
  -- deciding what it is worth are different jobs.
  select coalesce(app_private.can_write_company(p_company_id), false);
$$;

comment on function app_private.can_review_captures(uuid) is
  'May this caller read the capture review queue, reject a document, or store a vision extraction? Identical to can_write_company today, and deliberately NOT to be widened when the shop-floor ''operator'' role is added. See 0870 section 2.';


-- ----------------------------------------------------------------------------
-- 4. enforce_capture_draft — 0865's body VERBATIM plus one new rule
-- ----------------------------------------------------------------------------
-- The only change from the version 0865 installed is the submitted_at
-- monotonicity guard marked below. The status derivation — the guarantee that
-- 'confirmed' is computed from confirmed_voucher_id and never accepted from a
-- client — is byte-for-byte unchanged, as is every branch/company/voucher
-- validation above it. Re-stated here in full rather than ALTERed, because
-- CREATE OR REPLACE FUNCTION has no partial form.
create or replace function app_private.enforce_capture_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_company uuid;
  v_voucher record;
  v_required_voucher_type text;
begin
  if tg_op = 'UPDATE' and old.status in ('confirmed', 'rejected') then
    raise exception 'This capture draft is already % and its record cannot be changed further', old.status;
  end if;

  -- 0870: sending is not undoable. Once a capturer has put a document in
  -- somebody's review queue they cannot quietly pull it back out, and no
  -- client can rewrite when it was sent.
  if tg_op = 'UPDATE'
     and old.submitted_at is not null
     and new.submitted_at is distinct from old.submitted_at then
    raise exception 'This capture draft has already been sent for review; when it was sent cannot be changed';
  end if;

  if new.branch_id is not null then
    select company_id into v_branch_company from public.branches where id = new.branch_id;
    if v_branch_company is null then
      raise exception 'Branch % does not exist', new.branch_id;
    end if;
    if v_branch_company <> new.company_id then
      raise exception 'Branch % does not belong to company %', new.branch_id, new.company_id;
    end if;
  end if;

  if new.confirmed_voucher_id is not null then
    if new.company_id is null then
      raise exception 'A capture draft cannot be confirmed before it is attached to a company';
    end if;

    select company_id, voucher_type, is_deleted
      into v_voucher
      from public.vouchers
     where id = new.confirmed_voucher_id;

    if v_voucher.company_id is null then
      raise exception 'Voucher % does not exist', new.confirmed_voucher_id;
    end if;
    if v_voucher.company_id <> new.company_id then
      raise exception 'Voucher % does not belong to company %', new.confirmed_voucher_id, new.company_id;
    end if;
    if v_voucher.is_deleted then
      raise exception 'Cannot confirm a capture draft against a deleted voucher';
    end if;

    -- 0865: the one behavioural change. A CASE rather than an if-chain so a
    -- future document type is a single added line — see section 1 above on
    -- the 'sales_invoice' value deliberately not added today. A document
    -- type with no voucher type ('other') is refused outright rather than
    -- being allowed to confirm against anything at all.
    v_required_voucher_type := case new.document_type
      when 'sales_challan'    then 'sales'
      when 'purchase_invoice' then 'purchase'
      else null
    end;

    if v_required_voucher_type is null then
      raise exception 'A capture draft filed as "%" records a document that posts nothing, so it cannot be confirmed against voucher %. Change its document type to a sales challan or a purchase invoice first, or discard it.',
        new.document_type, new.confirmed_voucher_id;
    end if;

    if v_voucher.voucher_type <> v_required_voucher_type then
      raise exception 'A capture draft of a % can only be confirmed against a % voucher, not a % voucher',
        replace(new.document_type, '_', ' '), v_required_voucher_type, v_voucher.voucher_type;
    end if;
  end if;

  -- Unchanged from 0740. Never trust the client for 'confirmed' — only a real
  -- confirmed_voucher_id earns it. 'rejected' is the one status value a
  -- client may set directly (discarding a draft with no voucher); anything
  -- else it sends collapses to 'pending_review'.
  new.status := case
    when new.confirmed_voucher_id is not null then 'confirmed'
    when new.status = 'rejected' then 'rejected'
    else 'pending_review'
  end;

  new.updated_at := now();
  return new;
end;
$$;

comment on function app_private.enforce_capture_draft() is
  'Validates a capture_drafts row''s branch (must belong to the same company) and confirmed_voucher_id (must exist, same company, a non-deleted voucher whose type matches document_type), computes status from confirmed_voucher_id rather than trusting the client, makes confirmed/rejected terminal, and (0870) makes submitted_at monotonic once set. See 0740, 0865, 0870.';


-- ----------------------------------------------------------------------------
-- 5. create_capture_draft — idempotent on (company, client dedupe key)
-- ----------------------------------------------------------------------------
create or replace function public.create_capture_draft(
  p_company_id uuid,
  p_branch_id uuid default null,
  p_document_type text default 'purchase_invoice',
  p_vendor_hint text default null,
  p_note text default null,
  p_client_dedupe_key text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_doc_type text;
  v_key text;
begin
  if p_company_id is null then
    raise exception 'A company is required to start a capture draft';
  end if;
  if not app_private.can_capture_documents(p_company_id) then
    raise exception 'You do not have permission to capture documents for this company';
  end if;

  v_doc_type := coalesce(nullif(btrim(p_document_type), ''), 'purchase_invoice');
  if v_doc_type not in ('sales_challan', 'purchase_invoice', 'other') then
    raise exception 'Unknown document type "%" — expected sales_challan, purchase_invoice or other', v_doc_type;
  end if;

  v_key := nullif(btrim(p_client_dedupe_key), '');

  -- The common idempotent case: this exact document was already started and
  -- the phone is retrying after a dropped response.
  if v_key is not null then
    select d.id into v_id
      from public.capture_drafts d
     where d.company_id = p_company_id
       and d.client_dedupe_key = v_key;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  -- Generated up front because storage_path has to name the row's own id —
  -- see header section 4 on why this is a folder prefix and not null.
  v_id := gen_random_uuid();

  insert into public.capture_drafts (
    id, company_id, branch_id, source, storage_path,
    document_type, vendor_hint, note, client_dedupe_key,
    submitted_at, created_by
  ) values (
    v_id,
    p_company_id,
    p_branch_id,
    'upload',
    p_company_id::text || '/capture/' || v_id::text || '/',
    v_doc_type,
    nullif(btrim(p_vendor_hint), ''),
    nullif(btrim(p_note), ''),
    v_key,
    -- The ONE path that overrides the column default: more pages are coming,
    -- so this document is not in anybody's queue yet. Header section 3.
    null,
    (select auth.uid())
  )
  on conflict (company_id, client_dedupe_key) where client_dedupe_key is not null
  do nothing;

  -- Lost a race with a concurrent retry of the same key — the other caller's
  -- row is the answer.
  if not found then
    select d.id into v_id
      from public.capture_drafts d
     where d.company_id = p_company_id
       and d.client_dedupe_key = v_key;
    if v_id is null then
      raise exception 'Could not start a capture draft for this document';
    end if;
  end if;

  return v_id;
end;
$$;

revoke all on function public.create_capture_draft(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function public.create_capture_draft(uuid, uuid, text, text, text, text) to authenticated;

comment on function public.create_capture_draft is
  'Starts an empty, NOT-YET-SENT capture draft (submitted_at null) for a company. Idempotent on (company, p_client_dedupe_key): a retry with the same key returns the existing draft''s id rather than erroring, which is what makes a phone''s offline retry safe. Gated on app_private.can_capture_documents. Posts nothing — see 0870.';


-- ----------------------------------------------------------------------------
-- 6. add_capture_draft_page — upsert on (draft, page number)
-- ----------------------------------------------------------------------------
create or replace function public.add_capture_draft_page(
  p_draft_id uuid,
  p_page_no int,
  p_storage_path text,
  p_sha256 text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.capture_drafts;
  v_path text;
  v_id uuid;
begin
  if p_page_no is null or p_page_no < 1 then
    raise exception 'A page number must be 1 or greater';
  end if;

  v_path := nullif(btrim(p_storage_path), '');
  if v_path is null then
    raise exception 'A storage path is required for a capture page';
  end if;

  select * into v_draft from public.capture_drafts where id = p_draft_id for update;
  if v_draft.id is null then
    raise exception 'Capture draft % not found', p_draft_id;
  end if;
  if v_draft.company_id is null then
    raise exception 'This capture draft is not attached to a company yet';
  end if;
  if not app_private.can_capture_documents(v_draft.company_id) then
    raise exception 'You do not have permission to capture documents for this company';
  end if;
  if v_draft.status <> 'pending_review' then
    raise exception 'This capture draft is already % — no more pages can be added to it', v_draft.status;
  end if;

  -- The 'documents' bucket's own storage.objects RLS keys off the path's
  -- first folder segment (0060), so requiring that segment to be THIS draft's
  -- company means a page can never name an object in another tenant's folder.
  if v_path not like v_draft.company_id::text || '/%' then
    raise exception 'A capture page must be stored under its own company''s folder';
  end if;

  insert into public.capture_draft_pages (draft_id, page_no, storage_path, sha256)
  values (p_draft_id, p_page_no, v_path, nullif(btrim(p_sha256), ''))
  on conflict (draft_id, page_no) do update
     set storage_path = excluded.storage_path,
         sha256 = excluded.sha256
  returning id into v_id;

  -- Page 1 IS the draft's headline image, so it replaces the folder-prefix
  -- placeholder create_capture_draft seeded. Header section 4.
  if p_page_no = 1 and v_draft.storage_path is distinct from v_path then
    update public.capture_drafts set storage_path = v_path where id = p_draft_id;
  end if;

  return v_id;
end;
$$;

revoke all on function public.add_capture_draft_page(uuid, int, text, text) from public, anon;
grant execute on function public.add_capture_draft_page(uuid, int, text, text) to authenticated;

comment on function public.add_capture_draft_page is
  'Records one photographed page against a draft. UPSERTS on (draft_id, page_no) so a retried upload replaces the page rather than raising a duplicate-key error, and refuses any storage path outside the draft''s own company folder. Page 1 also becomes the draft''s own storage_path. Gated on app_private.can_capture_documents. See 0870.';


-- ----------------------------------------------------------------------------
-- 7. submit_capture_draft — hand it to the reviewers
-- ----------------------------------------------------------------------------
create or replace function public.submit_capture_draft(p_draft_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.capture_drafts;
  v_pages int;
begin
  select * into v_draft from public.capture_drafts where id = p_draft_id for update;
  if v_draft.id is null then
    raise exception 'Capture draft % not found', p_draft_id;
  end if;
  if v_draft.company_id is null then
    raise exception 'This capture draft is not attached to a company yet';
  end if;
  if not app_private.can_capture_documents(v_draft.company_id) then
    raise exception 'You do not have permission to capture documents for this company';
  end if;
  if v_draft.status <> 'pending_review' then
    raise exception 'This capture draft is already % and cannot be sent for review', v_draft.status;
  end if;

  select count(*) into v_pages
    from public.capture_draft_pages p
   where p.draft_id = p_draft_id;

  if v_pages = 0 then
    raise exception 'Take at least one photo before sending this document for review';
  end if;

  -- Already sent: succeed silently rather than raise, so a phone retrying a
  -- submit whose response it never saw does not show the capturer an error
  -- for something that actually worked.
  if v_draft.submitted_at is not null then
    return;
  end if;

  update public.capture_drafts set submitted_at = now() where id = p_draft_id;
end;
$$;

revoke all on function public.submit_capture_draft(uuid) from public, anon;
grant execute on function public.submit_capture_draft(uuid) to authenticated;

comment on function public.submit_capture_draft is
  'Marks a capture draft ready for review by stamping submitted_at. Refuses a draft with zero pages; idempotent if already submitted (a retried submit is not an error). Gated on app_private.can_capture_documents. Posts nothing. See 0870.';


-- ----------------------------------------------------------------------------
-- 8. reject_capture_draft — send it back, with a reason
-- ----------------------------------------------------------------------------
create or replace function public.reject_capture_draft(
  p_draft_id uuid,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.capture_drafts;
  v_reason text;
begin
  v_reason := nullif(btrim(p_reason), '');
  if v_reason is null then
    raise exception 'Say why you are sending this document back, so the person who sent it knows what to redo';
  end if;

  select * into v_draft from public.capture_drafts where id = p_draft_id for update;
  if v_draft.id is null then
    raise exception 'Capture draft % not found', p_draft_id;
  end if;
  if v_draft.company_id is null then
    raise exception 'This capture draft is not attached to a company yet';
  end if;
  if not app_private.can_review_captures(v_draft.company_id) then
    raise exception 'You do not have permission to review captured documents for this company';
  end if;
  if v_draft.status <> 'pending_review' then
    raise exception 'This capture draft is already % and cannot be rejected', v_draft.status;
  end if;

  -- ONE update, because enforce_capture_draft makes 'rejected' terminal — a
  -- second statement to fill in the reason afterwards would be refused.
  update public.capture_drafts
     set status = 'rejected',
         rejected_reason = v_reason,
         rejected_by = (select auth.uid()),
         rejected_at = now()
   where id = p_draft_id;
end;
$$;

revoke all on function public.reject_capture_draft(uuid, text) from public, anon;
grant execute on function public.reject_capture_draft(uuid, text) to authenticated;

comment on function public.reject_capture_draft is
  'Sends a captured document back to whoever photographed it, with a required non-empty reason. Writes status/reason/who/when in one statement because enforce_capture_draft makes ''rejected'' terminal. Gated on app_private.can_review_captures. See 0870.';


-- ----------------------------------------------------------------------------
-- 9. set_capture_draft_extraction — the review-time OCR write path
-- ----------------------------------------------------------------------------
create or replace function public.set_capture_draft_extraction(
  p_draft_id uuid,
  p_extracted jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.capture_drafts;
begin
  select * into v_draft from public.capture_drafts where id = p_draft_id for update;
  if v_draft.id is null then
    raise exception 'Capture draft % not found', p_draft_id;
  end if;
  if v_draft.company_id is null then
    raise exception 'This capture draft is not attached to a company yet';
  end if;
  if not app_private.can_review_captures(v_draft.company_id) then
    raise exception 'You do not have permission to review captured documents for this company';
  end if;
  if v_draft.status <> 'pending_review' then
    raise exception 'This capture draft is already % and its extraction cannot be changed', v_draft.status;
  end if;

  update public.capture_drafts
     set extracted_json = p_extracted,
         extracted_at = now()
   where id = p_draft_id;
end;
$$;

revoke all on function public.set_capture_draft_extraction(uuid, jsonb) from public, anon;
grant execute on function public.set_capture_draft_extraction(uuid, jsonb) to authenticated;

comment on function public.set_capture_draft_extraction is
  'Stores what the vision model read from a draft, at REVIEW time rather than upload time (0870 section 5). The shape is owned by lib/capture/analyze.ts, not constrained here — same choice 0740 made. Gated on app_private.can_review_captures. Posts nothing.';


-- ----------------------------------------------------------------------------
-- 10. get_my_capture_drafts — what the capturer sees on their own phone
-- ----------------------------------------------------------------------------
-- `id` and `draft_id` are the SAME value under two names, deliberately: this
-- RPC's consumers were written in parallel with it, and one spelling costing
-- an extra 16 bytes a row is cheaper than an integration that silently reads
-- undefined. Same in get_capture_review_queue.
create or replace function public.get_my_capture_drafts(
  p_company_id uuid,
  p_limit int default 50
) returns table (
  id uuid,
  draft_id uuid,
  document_type text,
  status text,
  stage text,
  page_count int,
  vendor_hint text,
  note text,
  rejected_reason text,
  rejected_at timestamptz,
  submitted_at timestamptz,
  extracted_at timestamptz,
  confirmed_voucher_id uuid,
  storage_path text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit int;
begin
  if p_company_id is null then
    raise exception 'A company is required';
  end if;
  if not app_private.can_capture_documents(p_company_id) then
    raise exception 'You do not have permission to capture documents for this company';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

  return query
    select
      d.id,
      d.id,
      d.document_type,
      d.status,
      case
        when d.status <> 'pending_review' then d.status
        when d.submitted_at is null then 'capturing'
        else 'pending_review'
      end::text,
      coalesce(pc.n, 0)::int,
      d.vendor_hint,
      d.note,
      d.rejected_reason,
      d.rejected_at,
      d.submitted_at,
      d.extracted_at,
      d.confirmed_voucher_id,
      d.storage_path,
      d.created_at
    from public.capture_drafts d
    left join lateral (
      select count(*)::int as n
        from public.capture_draft_pages p
       where p.draft_id = d.id
    ) pc on true
    where d.company_id = p_company_id
      and d.created_by = (select auth.uid())
    order by d.created_at desc
    limit v_limit;
end;
$$;

revoke all on function public.get_my_capture_drafts(uuid, int) from public, anon;
grant execute on function public.get_my_capture_drafts(uuid, int) to authenticated;

comment on function public.get_my_capture_drafts is
  'The CALLER''S OWN recent captures in one company — what the phone shows the person who took the photos, including why anything was sent back. `stage` collapses status + submitted_at into one word: capturing | pending_review | confirmed | rejected. Gated on app_private.can_capture_documents. See 0870.';


-- ----------------------------------------------------------------------------
-- 11. get_capture_review_queue — what the desk sees
-- ----------------------------------------------------------------------------
create or replace function public.get_capture_review_queue(
  p_company_id uuid,
  p_status text default null,
  p_document_type text default null,
  p_branch_id uuid default null,
  p_captured_by uuid default null,
  p_limit int default 100
) returns table (
  id uuid,
  draft_id uuid,
  company_id uuid,
  branch_id uuid,
  source text,
  document_type text,
  status text,
  stage text,
  page_count int,
  storage_path text,
  vendor_hint text,
  note text,
  captured_by uuid,
  captured_by_name text,
  captured_by_email text,
  submitted_at timestamptz,
  created_at timestamptz,
  extracted_at timestamptz,
  has_extraction boolean,
  rejected_reason text,
  rejected_at timestamptz,
  confirmed_voucher_id uuid,
  is_possible_duplicate boolean,
  duplicate_of_draft_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit int;
  v_status text;
  v_doc_type text;
begin
  if p_company_id is null then
    raise exception 'A company is required';
  end if;
  if not app_private.can_review_captures(p_company_id) then
    raise exception 'You do not have permission to review captured documents for this company';
  end if;

  -- A null, blank or literal 'all' filter means no filter. Anything else
  -- unrecognised RAISES rather than silently widening the queue — a typo'd
  -- filter that quietly returns everything is worse than an error.
  v_status := nullif(btrim(coalesce(p_status, '')), '');
  if v_status = 'all' then
    v_status := null;
  end if;
  if v_status is not null and v_status not in ('pending_review', 'confirmed', 'rejected') then
    raise exception 'Unknown status filter "%" — expected pending_review, confirmed, rejected or null', v_status;
  end if;

  v_doc_type := nullif(btrim(coalesce(p_document_type, '')), '');
  if v_doc_type = 'all' then
    v_doc_type := null;
  end if;
  if v_doc_type is not null and v_doc_type not in ('sales_challan', 'purchase_invoice', 'other') then
    raise exception 'Unknown document type filter "%" — expected sales_challan, purchase_invoice, other or null', v_doc_type;
  end if;

  v_limit := least(greatest(coalesce(p_limit, 100), 1), 500);

  return query
    select
      d.id,
      d.id,
      d.company_id,
      d.branch_id,
      d.source,
      d.document_type,
      d.status,
      case
        when d.status <> 'pending_review' then d.status
        else 'pending_review'
      end::text,
      coalesce(pc.n, 0)::int,
      coalesce(p1.storage_path, d.storage_path),
      d.vendor_hint,
      d.note,
      d.created_by,
      prof.full_name,
      u.email::text,
      d.submitted_at,
      d.created_at,
      d.extracted_at,
      (d.extracted_json is not null),
      d.rejected_reason,
      d.rejected_at,
      d.confirmed_voucher_id,
      (dup.other_id is not null),
      dup.other_id
    from public.capture_drafts d
    left join lateral (
      select count(*)::int as n
        from public.capture_draft_pages p
       where p.draft_id = d.id
    ) pc on true
    left join public.capture_draft_pages p1
      on p1.draft_id = d.id and p1.page_no = 1
    left join auth.users u on u.id = d.created_by
    left join public.profiles prof on prof.id = d.created_by
    left join lateral (
      -- Advisory only: another draft in the SAME company whose first page is
      -- byte-identical to this one's. Never blocks, never merges — the
      -- reviewer decides. See 0870 section 6.
      select o.id as other_id
        from public.capture_drafts o
        join public.capture_draft_pages op
          on op.draft_id = o.id and op.page_no = 1
       where p1.sha256 is not null
         and op.sha256 = p1.sha256
         and o.company_id = d.company_id
         and o.id <> d.id
       order by o.created_at, o.id
       limit 1
    ) dup on true
    where d.company_id = p_company_id
      -- Drafts still being assembled on a phone are NOT reviewable. Header
      -- section 3 — this is the whole reason submitted_at exists.
      and d.submitted_at is not null
      and (v_status is null or d.status = v_status)
      and (v_doc_type is null or d.document_type = v_doc_type)
      and (p_branch_id is null or d.branch_id = p_branch_id)
      and (p_captured_by is null or d.created_by = p_captured_by)
    order by d.submitted_at desc, d.created_at desc
    limit v_limit;
end;
$$;

revoke all on function public.get_capture_review_queue(uuid, text, text, uuid, uuid, int) from public, anon;
grant execute on function public.get_capture_review_queue(uuid, text, text, uuid, uuid, int) to authenticated;

comment on function public.get_capture_review_queue is
  'Captured documents that have actually been SENT for review in one company (submitted_at not null), newest first, with page count, who sent them (name plus the email only auth.users has — same SECURITY DEFINER reason as get_company_team, 0107), their own hint/note, and an advisory duplicate flag when another draft in the same company has a byte-identical first page. Null/blank/''all'' filter arguments mean no filter; an unrecognised one raises. Gated on app_private.can_review_captures. See 0870.';


-- ----------------------------------------------------------------------------
-- 12. The 'documents' bucket needs an UPDATE policy for a retried page upload
-- ----------------------------------------------------------------------------
-- FOUND BY READING THE LIVE POLICIES, NOT BY ASSUMING. 0060 gave the
-- 'documents' bucket exactly three policies — read (select), write (insert)
-- and delete — and no UPDATE policy exists anywhere on storage.objects for
-- this bucket. Storage's own upsert (supabase-js `upload(..., { upsert: true
-- })`, the x-upsert header) performs an UPDATE on storage.objects when the
-- object already exists, and RLS denies by default when no policy matches, so
-- a phone retrying page 1 to the SAME deterministic path — the entire reason
-- section 4 made those paths deterministic — would have been refused.
--
-- THIS GRANTS NO NEW CAPABILITY, which is why it is the right fix rather than
-- a widening: a can_write_company member can ALREADY delete an object in
-- their own company's folder (documents_bucket_delete) and insert a new one
-- at the same path (documents_bucket_write). Overwriting is a thing they can
-- do today in two statements; this lets Storage do it in one, atomically,
-- instead of leaving a window where the object is gone but its replacement
-- has not landed. The predicate is character-for-character the same
-- can_write_company((storage.foldername(name))[1]::uuid) test the insert and
-- delete policies already use, on both USING and WITH CHECK — so an object
-- cannot be updated INTO another company's folder either.
--
-- `to authenticated` only: the anon signer-token and WhatsApp-inbound
-- policies 0575/0745 added are untouched, and anon gains nothing here.
drop policy if exists documents_bucket_update on storage.objects;

create policy documents_bucket_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and (select app_private.can_write_company((storage.foldername(name))[1]::uuid))
  )
  with check (
    bucket_id = 'documents'
    and (select app_private.can_write_company((storage.foldername(name))[1]::uuid))
  );

comment on policy documents_bucket_update on storage.objects is
  'documents bucket: a writing member of the company named in the path''s first folder segment may overwrite an object in that folder — what Storage''s upsert needs, and no more than the delete+insert those members could already do in two steps. Added by 0870 so a retried scanner page overwrites rather than 403s. Both USING and WITH CHECK, so an object cannot be moved into another company''s folder.';
