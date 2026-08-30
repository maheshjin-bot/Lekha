-- ============================================================================
-- 0740 — OCR/vision bill capture: capture_drafts staging table
-- ============================================================================
-- Confirmed absent today: grepping the whole repo for ocr|vision|tesseract|
-- textract turns up nothing real — no capture pipeline, no staging table, no
-- vision API call anywhere in app/, lib/ or supabase/migrations/. This
-- migration builds the SHARED staging table two features need: an authenticated
-- user photographing/uploading a bill at the new /[companyId]/capture screen
-- (this session), and a later WhatsApp-forwarding feature (not built here)
-- where an inbound message may arrive before any human has said which company
-- it belongs to.
--
-- WHAT THIS ADDS: capture_drafts, one row per uploaded/forwarded document —
-- company_id (nullable at insert, see below), branch_id (nullable, checked
-- against company_id when both are present), source ('upload' | 'whatsapp'),
-- storage_path (into the EXISTING private 'documents' bucket from 0060 — see
-- "STORAGE" below), extracted_json (the vision model's raw structured guess:
-- vendor, date, line items, amounts, a confidence note — shape owned by
-- lib/capture/analyze.ts, not constrained by a column-level CHECK here, the
-- same "app owns the shape, the column just holds jsonb" choice 0230 makes
-- for einvoice_details.generated_json), status, confirmed_voucher_id, and who/
-- when. app_private.enforce_capture_draft (trigger, below) computes status
-- from confirmed_voucher_id the same way 0230's enforce_einvoice_voucher
-- computes its own status column — never trusted from the client.
--
-- A DRAFT NEVER POSTS ITSELF. There is no function here that calls
-- create_invoice on a draft's behalf. confirmed_voucher_id is filled in by the
-- CLIENT, after a human has reviewed and edited the extracted fields in the
-- /capture screen and the browser has itself called the EXISTING
-- create_invoice RPC (0725's current signature, unmodified) — exactly as if
-- they had typed the bill in by hand on the ordinary invoice screen. This
-- table only records that it happened; app_private.enforce_capture_draft
-- (below) checks the voucher named actually exists, belongs to the same
-- company, is a 'purchase' voucher, and is not deleted, but it does not and
-- cannot create one. This is the same "the tax layer generates
-- voucher_entries, it never bypasses them" discipline applied one level up:
-- capture never bypasses create_invoice.
--
-- WHY 'purchase' ONLY: the capture screen's own button reads "Post as
-- purchase bill" and this is the only case OCR bill capture actually serves —
-- a vendor's paper/photographed bill arriving after the fact. Confirming a
-- draft against a sales invoice, credit note or debit note is refused outright
-- by the trigger, not silently allowed and left to the UI to avoid.
--
-- WHO CAN SEE AN UNCLAIMED (company_id IS NULL) ROW — the actual design
-- decision this migration was asked to think through, not skip:
-- An unclaimed draft exists only via the future WhatsApp path (never via this
-- session's own /capture screen, which always knows its company from the URL
-- before it ever uploads anything — see the route, app/api/capture/analyze).
-- Before it is claimed, NOBODY has any predictable path to that row's
-- CONTENTS: the SELECT policy below reads `company_id is not null and
-- is_company_member(company_id)`, so a null company_id satisfies neither
-- half and the row is invisible under ordinary RLS to every authenticated
-- user, full stop — there is no blanket "anyone can see unclaimed drafts"
-- policy, because an inbound WhatsApp photo of somebody else's vendor bill
-- (potentially carrying a stranger's GSTIN, bank details, amounts) has no
-- business being listable by every signed-in user of this multi-tenant
-- database while it waits for a human to say whose it is. The ONLY door in is
-- claim_capture_draft(p_draft_id, p_company_id, p_branch_id), a narrow
-- SECURITY DEFINER RPC (bypasses RLS internally, the same way
-- record_signed_document_by_token, 0575, does for its own token-gated case)
-- that requires the CALLER to already be an authenticated, can_write_company
-- member of the company they are claiming into, AND to already know the
-- draft's own unguessable UUID. How a legitimate claimant actually learns
-- that UUID (matching an inbound phone number to a company's registered
-- contact, most likely) is NOT decided here — that is the later WhatsApp
-- feature's own problem to solve, named explicitly rather than silently
-- assumed. What this migration guarantees is narrower and unconditional:
-- knowing the UUID is necessary but not sufficient — the caller must also
-- separately be a real member of the company they name, so a leaked or
-- guessed draft ID alone cannot move someone else's bill into an attacker's
-- own company's books.
--
-- STORAGE: reuses the EXISTING private 'documents' bucket (0060), not a new
-- one. That bucket's own storage.objects RLS already keys purely off the
-- path's first folder segment (`(storage.foldername(name))[1]::uuid`) checked
-- against is_company_member/can_write_company — nothing bucket-side requires
-- a matching public.documents row, so storing a capture under
-- '<company_id>/capture/<draft id>/<filename>' is covered by the policies
-- 0060 already wrote, with no new storage.objects policy needed for the
-- 'upload' source this migration's own route actually uses. DELIBERATELY NOT
-- SOLVED HERE: an unclaimed 'whatsapp' draft has no company_id yet and so
-- cannot be given a path any existing policy would let a human read even
-- after claiming (today's bucket RLS is keyed on the path's OWN folder
-- segment, not on a row lookup) — the later WhatsApp feature will need either
-- a service-role write plus a follow-up copy/re-path on claim, or a new
-- narrow policy in the 0575 style. Not guessed at here.
--
-- GUARD-TRIGGER/CASCADE INTERACTION: app_private.enforce_capture_draft fires
-- BEFORE INSERT OR UPDATE only — never BEFORE DELETE — so it can never be the
-- thing standing in the way of `ON DELETE CASCADE` when a company row is
-- removed. company_id itself cascades from companies; confirmed_voucher_id
-- and branch_id both go ON DELETE SET NULL rather than cascade or restrict,
-- so deleting a voucher or a branch never blocks on a capture_drafts row
-- either.
--
-- DELIBERATELY NOT DONE HERE (named, not silently omitted):
--   * No WhatsApp inbound handler — 'whatsapp' is an accepted source value
--     and the unclaimed-row shape exists, but nothing in this repo yet
--     receives a WhatsApp message. That is a separate, later feature.
--   * No re-extraction / re-analysis endpoint — a draft's extracted_json is
--     set once, at creation, by the route in this same session. Editing it
--     after that happens in the browser's own review form state, not by
--     calling the vision model again.
--   * No confidence-score enforcement — extracted_json.confidence is
--     advisory text the model itself writes (or "not configured"/"could not
--     extract" wording this app supplies when the model can't help), never
--     something the database gates a confirm on. A human can post from a
--     "low confidence" draft if they choose to; this app does not decide
--     that for them.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. capture_drafts
-- ----------------------------------------------------------------------------
create table public.capture_drafts (
  id uuid primary key default gen_random_uuid(),

  -- Nullable ONLY for a not-yet-claimed inbound draft (the future WhatsApp
  -- path) — see migration header. This session's own /capture screen always
  -- inserts with company_id already set, since it only ever runs inside an
  -- already-selected company.
  company_id uuid references public.companies(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null,

  source text not null check (source in ('upload', 'whatsapp')),

  -- Into the EXISTING 'documents' Storage bucket (0060) — see header. unique
  -- because two drafts sharing one file would let confirming/rejecting one
  -- silently affect what the other's storage_path resolves to.
  storage_path text not null unique,

  -- The vision model's raw structured guess — shape owned by
  -- lib/capture/analyze.ts's CaptureExtraction type, not by a column CHECK
  -- here (same choice 0230 makes for einvoice_details.generated_json). Null
  -- only if analysis was never attempted at all, which this session's own
  -- route never does — it always writes SOMETHING, including the "vision
  -- capture isn't configured on this server" case.
  extracted_json jsonb,

  -- System-computed by enforce_capture_draft below from confirmed_voucher_id
  -- — never trusted from the client for the 'confirmed' value. A client MAY
  -- set 'rejected' directly (discarding a draft with no voucher); anything
  -- else it sends is overridden to 'pending_review'. See trigger.
  status text not null default 'pending_review'
    check (status in ('pending_review', 'confirmed', 'rejected')),

  -- Filled in by the CLIENT once a human has reviewed the draft and the
  -- browser has itself called the EXISTING create_invoice RPC — never
  -- written by any function in this migration. See header.
  confirmed_voucher_id uuid,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A branch cannot be attached before the company that owns it is known,
  -- and (when both are known) must actually belong to that company — the
  -- second half is DB-enforced by the composite FK below; MATCH SIMPLE alone
  -- would silently skip that check if company_id were null while branch_id
  -- was not, so this CHECK closes that gap explicitly.
  constraint capture_drafts_branch_needs_company
    check (branch_id is null or company_id is not null),
  foreign key (branch_id, company_id) references public.branches (id, company_id),

  -- A confirmed draft always names a real voucher in the SAME company — see
  -- 0230's einvoice_details for the identical (voucher_id, company_id)
  -- composite-FK precedent this copies verbatim. company_id being null and
  -- confirmed_voucher_id being set at the same time is additionally refused
  -- by enforce_capture_draft (a plain CHECK cannot express "not null"
  -- against a column that IS allowed to be null in the unclaimed case).
  foreign key (confirmed_voucher_id, company_id) references public.vouchers (id, company_id)
);

create index capture_drafts_company_status_idx
  on public.capture_drafts (company_id, status);

comment on table public.capture_drafts is
  'Staging area for a photographed/uploaded/forwarded bill before a human turns it into a real voucher. company_id is null only for an unclaimed inbound draft (source=''whatsapp'', not yet built) — see 0740 for why no blanket SELECT policy exists for that case and what claim_capture_draft alone allows. confirmed_voucher_id is set by the CLIENT after calling the ordinary create_invoice RPC; nothing here posts a voucher on its own.';

comment on column public.capture_drafts.status is
  'System-computed by enforce_capture_draft from confirmed_voucher_id: pending_review (default) -> confirmed (confirmed_voucher_id set) or -> rejected (client explicitly discards). Both confirmed and rejected are terminal — the trigger refuses any further UPDATE once reached. See 0740.';

comment on column public.capture_drafts.extracted_json is
  'The vision model''s raw structured extraction (lib/capture/analyze.ts''s CaptureExtraction shape) — vendor/date/line-item/amount guesses and a confidence note, never trusted for posting on its own. A human reviews and edits it in the /capture screen before anything is posted.';

alter table public.capture_drafts enable row level security;

-- SELECT/write both require company_id to be set AND the caller to be a
-- member/writer of THAT company. An unclaimed (company_id null) row matches
-- neither half of either policy, for any authenticated user — there is no
-- policy anywhere that makes an unclaimed row visible. See migration header
-- for why that is the deliberate choice and how claim_capture_draft (below)
-- is the one narrow door around it.
create policy capture_drafts_read on public.capture_drafts
  for select to authenticated
  using (company_id is not null and (select app_private.is_company_member(company_id)));

create policy capture_drafts_write on public.capture_drafts
  for all to authenticated
  using (company_id is not null and (select app_private.can_write_company(company_id)))
  with check (company_id is not null and (select app_private.can_write_company(company_id)));


-- ----------------------------------------------------------------------------
-- 2. app_private.enforce_capture_draft — validates branch/company and
--    confirmed-voucher/company consistency, computes status, and makes
--    'confirmed'/'rejected' terminal. SECURITY DEFINER, same shape as
--    app_private.enforce_einvoice_voucher (0230). Fires BEFORE INSERT OR
--    UPDATE only — see migration header on why that can never block a
--    company/branch/voucher's own ON DELETE CASCADE or SET NULL.
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_capture_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branch_company uuid;
  v_voucher record;
begin
  if tg_op = 'UPDATE' and old.status in ('confirmed', 'rejected') then
    raise exception 'This capture draft is already % and its record cannot be changed further', old.status;
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
    if v_voucher.voucher_type <> 'purchase' then
      raise exception 'A capture draft can only be confirmed against a purchase bill, not a % voucher', v_voucher.voucher_type;
    end if;
  end if;

  -- Never trust the client for 'confirmed' — only a real confirmed_voucher_id
  -- earns it. 'rejected' is the one status value a client may set directly
  -- (discarding a draft with no voucher); anything else it sends collapses
  -- to 'pending_review'.
  new.status := case
    when new.confirmed_voucher_id is not null then 'confirmed'
    when new.status = 'rejected' then 'rejected'
    else 'pending_review'
  end;

  new.updated_at := now();
  return new;
end;
$$;

create trigger enforce_capture_draft
  before insert or update on public.capture_drafts
  for each row execute function app_private.enforce_capture_draft();

comment on function app_private.enforce_capture_draft() is
  'Validates a capture_drafts row''s branch (must belong to the same company) and confirmed_voucher_id (must exist, same company, a non-deleted purchase voucher), computes status from confirmed_voucher_id rather than trusting the client, and makes confirmed/rejected terminal. See 0740.';


-- ----------------------------------------------------------------------------
-- 3. claim_capture_draft — the ONE narrow door onto an unclaimed
--    (company_id IS NULL) draft. SECURITY DEFINER so it can see past the
--    RLS policies above, which otherwise hide an unclaimed row from every
--    authenticated user without exception. See migration header for the
--    full "who could see this" reasoning.
-- ----------------------------------------------------------------------------
create or replace function public.claim_capture_draft(
  p_draft_id uuid,
  p_company_id uuid,
  p_branch_id uuid default null
) returns public.capture_drafts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft public.capture_drafts;
begin
  if not (select app_private.can_write_company(p_company_id)) then
    raise exception 'You do not have write access to company %', p_company_id;
  end if;

  select * into v_draft from public.capture_drafts where id = p_draft_id for update;

  if v_draft.id is null then
    raise exception 'Capture draft % not found', p_draft_id;
  end if;
  if v_draft.company_id is not null then
    raise exception 'This capture draft has already been claimed by a company';
  end if;
  if v_draft.status <> 'pending_review' then
    raise exception 'Only a pending, unclaimed draft can be claimed';
  end if;

  update public.capture_drafts
     set company_id = p_company_id,
         branch_id = p_branch_id
   where id = p_draft_id
  returning * into v_draft;

  return v_draft;
end;
$$;

revoke all on function public.claim_capture_draft(uuid, uuid, uuid) from public, anon;
grant execute on function public.claim_capture_draft(uuid, uuid, uuid) to authenticated;

comment on function public.claim_capture_draft is
  'The only way to attach a company to a not-yet-claimed (company_id IS NULL) capture draft — every RLS policy on capture_drafts hides such a row from everyone otherwise. Requires the caller to already be a can_write_company member of the company they name AND to already know the draft''s own unguessable id; refuses a draft that is already claimed or no longer pending_review. See 0740 for the full reasoning and what it deliberately leaves to a later feature.';
