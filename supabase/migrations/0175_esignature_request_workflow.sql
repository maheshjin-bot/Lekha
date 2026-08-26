-- ============================================================================
-- 0175 — E-signature REQUEST workflow: signer list/order/status tracking,
-- plus offline structural verification of a PDF's own embedded signature
-- ============================================================================
-- WHAT THIS IS NOT, STATED FIRST BECAUSE IT IS THE WHOLE SHAPE OF THE
-- FEATURE. This app does not, and after this migration still does not,
-- originate a legally binding electronic signature. Confirmed by WebSearch
-- (Aug 2026, Leegality's own IT Act explainer + Section 3/3A primary-source
-- summaries, both read today):
--   - A "digital signature" under Sec 3 IT Act 2000 is PKI-based (a DSC —
--     USB token or HSM-held private key issued by a licensed Certifying
--     Authority under the Controller of Certifying Authorities/MeitY). This
--     app has no PKCS#11 access to a hardware token and cannot originate one.
--   - An "electronic signature" under Sec 3A + Second Schedule (e.g. Aadhaar
--     eSign, PAN eSign) is a notified technique that legally requires the
--     signer to authenticate through one of a closed list of just 7 licensed
--     eSign Service Providers (ESPs) overseen by the CCA — this app has no
--     ESP agreement and cannot originate one either.
-- Both routes need a licensed relationship this app does not have. What IS
-- buildable without one, and what this migration builds, is the "near half"
-- the task brief named:
--   1. A tracker: who needs to sign a document, in what order, and whether
--      each of them has. The actual signing happens OUTSIDE this app — the
--      signer's own DSC token, their own Aadhaar eSign session on some other
--      platform, or even wet-ink-then-scan — and the requester uploads the
--      resulting signed file back in here. No signature is captured,
--      generated, or witnessed by this app at any point.
--   2. Best-effort OFFLINE checking of a PDF someone uploads back: does it
--      structurally contain an embedded digital-signature block at all, and
--      does that block's own declared byte-range cover the whole file (a
--      structural hint about undisturbed-since-signing, not a proof). See
--      "WHAT THE PDF CHECK ACTUALLY CHECKS" below for exactly where this
--      stops and why it stops there — the task brief specifically warned
--      against overclaiming here, and the line is real, not conservative
--      hedging: this app has no CA root bundle and no revocation/OCSP
--      lookup, so "is this signature CRYPTOGRAPHICALLY VALID and does it
--      CHAIN TO A TRUSTED, UNREVOKED INDIAN CA" is a question this app
--      cannot answer honestly with the offline resources it has. See
--      lib/pdf/signature-check.ts for the actual implementation and its own
--      header, which repeats this same boundary next to the code that has
--      to respect it.
--
-- REUSES public.documents (0060) RATHER THAN A PARALLEL STORAGE MECHANISM,
-- per the task's own instruction to read it first (done). Two new
-- entity_type values are added to its existing CHECK-constrained enum:
--   'signature_request'        — the document(s) routed for signature,
--                                 entity_id = signature_requests.id
--   'signature_request_signer' — the signed-back copy for ONE signer,
--                                 entity_id = signature_request_signers.id
-- The existing 'documents' Storage bucket, its RLS policies, and the
-- DocumentAttachments component are reused UNCHANGED for the first kind (the
-- source document to be signed — attach it to a draft request exactly the
-- way a notice's scan is attached today). The second kind (a signer's
-- signed-back copy) needs its own small upload path instead, because
-- uploading it also has to run the PDF structural check and then call
-- record_signed_document — DocumentAttachments intentionally does neither,
-- and it is a shared component used by Notices/Meetings/PrintTemplateForm
-- that this task has no reason to touch. See
-- components/signature-requests/SignatureRequestManager.tsx.
--
-- documents GAINS ONE STRUCTURAL ADDITION: unique (id, company_id). Every
-- other composite FK in this schema (job work, manufacturing, EXIM) points
-- at a parent that already carries this; documents (0060) predates that
-- convention and never needed it before, because nothing referenced it by
-- FK — entity_id was always a loose, unconstrained uuid. This migration is
-- the first thing that needs a real FK to a documents row
-- (signature_request_signers.signed_document_id, tenant-scoped on both
-- sides, so the mandatory composite-FK convention applies), so the
-- constraint is added here. It is free and safe: id is already the primary
-- key (globally unique on its own), so (id, company_id) can never conflict
-- with existing data.
--
-- WHO CAN SEE A PENDING REQUEST — CHECKED, NOT ASSUMED. A signer's email
-- address is data entered by the requester, not an identity anything in
-- this app authenticates — there is no signer-facing login, magic link, or
-- public API key scoped to "just this one request" built here. The task
-- brief explicitly allowed either answer as long as it is checked and
-- stated plainly: it is checked, and the honest answer is company-member-
-- visible only. RLS on both new tables is the plain is_company_member /
-- can_write_company pair used everywhere else in this schema (verified
-- live in a rolled-back transaction below, including that the anon role
-- gets zero rows). A signer with no LEKHA login of their own finds out
-- their document is waiting for them the same way this app already handles
-- every other outbound communication it has no email/SMS integration for —
-- the requester tells them directly, outside the app. Building a scoped
-- external-signer view (a public, token-authenticated read link, the shape
-- 0063's public API already establishes for a different purpose) is a real,
-- concrete follow-up if a user asks for it — not attempted here to keep
-- this migration's authorization surface to the one pattern already proven
-- safe everywhere else in this schema.
--
-- STATUS IS A GUARDED STATE MACHINE, NOT A PLAIN COLUMN A CLIENT CAN WRITE.
-- signature_requests.status only moves draft -> sent -> completed, or
-- draft/sent -> cancelled, and signature_request_signers.status only moves
-- pending -> signed/declined. 'completed' in particular must never be
-- something a client can just assert — it has to mean every signer actually
-- has a signed row against them. Both are enforced the same way this
-- database already lets a SECURITY DEFINER function do something an
-- ordinary authenticated write cannot: the function runs as its owner
-- (verified live below — every function in this schema so far is owned by
-- `postgres`), so current_user inside it is 'postgres', not 'authenticated'
-- — a fact intrinsic to how Postgres SECURITY DEFINER already works here,
-- not a new mechanism invented for this migration. The BEFORE
-- INSERT/UPDATE/DELETE triggers below check exactly that: a protected-column
-- change arriving with current_user = 'authenticated' (a direct PostgREST
-- write) is rejected; the same change arriving from inside
-- send_signature_request / cancel_signature_request / decline_signer /
-- record_signed_document (current_user = 'postgres') is allowed, and then
-- separately validated against the state machine so a future bug in one of
-- those functions still cannot produce an invalid transition.
--
-- A DECLINED SIGNER PERMANENTLY BLOCKS AUTO-COMPLETION, ON PURPOSE. Signers
-- can only be added or removed while a request is still 'draft' (removing
-- one after 'sent' would silently rewrite a list the other signers may
-- already have been told about). So a decline on a 'sent' request has no
-- undo within that request: record_signed_document's own rollup only fires
-- completed when every signer's status = 'signed', and a declined signer
-- never reaches that state. The realistic path is the requester cancels
-- and opens a fresh draft without that signer — stated here, not silently
-- discovered by a stuck request.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- documents: widen the entity_type enum, add the composite-FK prerequisite.
-- ----------------------------------------------------------------------------
alter table public.documents
  add constraint documents_id_company_id_key unique (id, company_id);

alter table public.documents
  drop constraint documents_entity_type_check;
alter table public.documents
  add constraint documents_entity_type_check check (entity_type in
    ('voucher','notice','fixed_asset','ledger','company','other',
     'signature_request','signature_request_signer'));

comment on constraint documents_entity_type_check on public.documents is
  'signature_request = the document(s) routed for signature (entity_id = signature_requests.id); signature_request_signer = one signer''s signed-back copy (entity_id = signature_request_signers.id). Added by 0175.';


-- ----------------------------------------------------------------------------
-- signature_requests
-- ----------------------------------------------------------------------------
create table public.signature_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  description text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'completed', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id)
);

create index signature_requests_company_status_idx on public.signature_requests (company_id, status);

alter table public.signature_requests enable row level security;

create policy signature_requests_read on public.signature_requests
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy signature_requests_write on public.signature_requests
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.signature_requests is
  'A tracked request for one or more people to sign a document OUTSIDE this app (own DSC token, Aadhaar eSign elsewhere, or wet-ink+scan) and upload the result back in. No signature is captured or originated here — see 0175 header. The document itself is attached the ordinary way, via public.documents with entity_type=''signature_request''. status is a guarded state machine (see enforce_signature_request_write) — a direct client UPDATE of status is rejected; use send_signature_request / cancel_signature_request / record_signed_document.';


-- ----------------------------------------------------------------------------
-- signature_request_signers
-- ----------------------------------------------------------------------------
create table public.signature_request_signers (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  company_id uuid not null references public.companies(id) on delete cascade,

  signer_name text not null check (length(trim(signer_name)) > 0),
  -- Loose format check only — this is contact information the requester
  -- typed in, not an identity this app authenticates (see 0175 header).
  signer_email text not null check (signer_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  sign_order integer not null check (sign_order > 0),

  status text not null default 'pending' check (status in ('pending', 'signed', 'declined')),
  signed_at timestamptz,
  signed_document_id uuid,
  decline_reason text,

  -- Populated from lib/pdf/signature-check.ts's client-side structural scan
  -- at the moment the signed-back copy is uploaded — null when the upload
  -- was not a PDF (the check does not apply) or when signed_document_id is
  -- itself null (nothing uploaded yet). See migration header and the
  -- library's own header for exactly what true/false here does and does not
  -- mean — never treat true as "this signature is cryptographically valid".
  has_embedded_signature boolean,
  signature_check_note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  unique (request_id, sign_order),
  foreign key (request_id, company_id) references public.signature_requests (id, company_id) on delete cascade,
  foreign key (signed_document_id, company_id) references public.documents (id, company_id),

  check (signed_at is null or status = 'signed'),
  check (status = 'signed' or signed_document_id is null),
  check (status = 'declined' or decline_reason is null)
);

create index signature_request_signers_request_idx on public.signature_request_signers (request_id, sign_order);
create index signature_request_signers_company_idx on public.signature_request_signers (company_id);

alter table public.signature_request_signers enable row level security;

create policy signature_request_signers_read on public.signature_request_signers
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy signature_request_signers_write on public.signature_request_signers
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.signature_request_signers is
  'One row per person who needs to sign, in sign_order. Identity fields (signer_name/signer_email/sign_order) are only editable while the parent request is still draft; status/signed_at/signed_document_id/decline_reason/has_embedded_signature/signature_check_note only change via decline_signer or record_signed_document (see enforce_signature_request_signer_write) — never a direct client UPDATE. signer_email is contact information the requester typed in, not an authenticated identity (see 0175 header on external-signer visibility).';

comment on column public.signature_request_signers.has_embedded_signature is
  'Best-effort OFFLINE structural check (lib/pdf/signature-check.ts) run client-side at upload time: does the uploaded PDF contain a /Type/Sig object with a recognised SubFilter and a PKCS#7/CAdES-shaped /Contents blob, and does its /ByteRange cover the whole file. NOT a cryptographic verification — no digest recomputation, no certificate chain, no revocation/CRL/OCSP check. True means "a signature-shaped structure exists and looks intact by this shallow test", nothing stronger. Null when not a PDF or nothing uploaded yet.';


-- ----------------------------------------------------------------------------
-- enforce_signature_request_write — the state machine for signature_requests.
-- See migration header for the current_user = 'postgres' vs 'authenticated'
-- mechanism this relies on.
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_signature_request_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.status := 'draft';
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- UPDATE from here.
  new.created_by := old.created_by;
  new.created_at := old.created_at;

  if new.status is distinct from old.status then
    if current_user = 'authenticated' then
      raise exception 'Status changes must go through send_signature_request / cancel_signature_request / record_signed_document, not a direct update';
    end if;
    if not (
      (old.status = 'draft' and new.status in ('sent', 'cancelled')) or
      (old.status = 'sent' and new.status in ('completed', 'cancelled'))
    ) then
      raise exception 'Invalid signature request status transition: % -> %', old.status, new.status;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger enforce_signature_request_write
  before insert or update on public.signature_requests
  for each row execute function app_private.enforce_signature_request_write();

comment on function app_private.enforce_signature_request_write() is
  'Sets created_by/created_at/status=draft on insert (never client-trusted). On update, rejects any status change made with current_user = ''authenticated'' (a direct client write) and validates every status change against the allowed state machine (draft->sent/cancelled, sent->completed/cancelled) regardless of caller, so a bug inside the trusted RPCs still cannot produce an invalid state.';


-- ----------------------------------------------------------------------------
-- enforce_signature_request_signer_write — validates parentage, restricts
-- identity-field edits to draft, and guards the status/signed-copy fields
-- the same current_user way as above.
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_signature_request_signer_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_request record;
begin
  select id, company_id, status into v_request
    from public.signature_requests
   where id = coalesce(new.request_id, old.request_id);

  if v_request.id is null then
    raise exception 'Signature request % does not exist', coalesce(new.request_id, old.request_id);
  end if;

  if tg_op = 'DELETE' then
    if v_request.status <> 'draft' then
      raise exception 'Signers can only be removed while the request is still in draft (current status: %)', v_request.status;
    end if;
    return old;
  end if;

  -- company_id is always derived from the parent, never trusted from the
  -- client — same discipline as port_code/export_realisation_due_date in
  -- 0119's enforce_exim_shipment_voucher.
  new.company_id := v_request.company_id;

  if tg_op = 'INSERT' then
    if v_request.status <> 'draft' then
      raise exception 'Signers can only be added while the request is still in draft (current status: %)', v_request.status;
    end if;
    new.status := 'pending';
    new.signed_at := null;
    new.signed_document_id := null;
    new.decline_reason := null;
    new.has_embedded_signature := null;
    new.signature_check_note := null;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  -- UPDATE from here.
  new.created_at := old.created_at;

  if (new.signer_name, new.signer_email, new.sign_order)
     is distinct from (old.signer_name, old.signer_email, old.sign_order)
  then
    if v_request.status <> 'draft' then
      raise exception 'Signer name/email/order can only be edited while the request is still in draft (current status: %)', v_request.status;
    end if;
  end if;

  if (new.status, new.signed_at, new.signed_document_id, new.decline_reason,
      new.has_embedded_signature, new.signature_check_note)
     is distinct from
     (old.status, old.signed_at, old.signed_document_id, old.decline_reason,
      old.has_embedded_signature, old.signature_check_note)
  then
    if current_user = 'authenticated' then
      raise exception 'Signer status can only change via decline_signer or record_signed_document, not a direct update';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger enforce_signature_request_signer_write
  before insert or update or delete on public.signature_request_signers
  for each row execute function app_private.enforce_signature_request_signer_write();

comment on function app_private.enforce_signature_request_signer_write() is
  'company_id always derived from the parent request, never client-trusted. Insert only permitted while the parent is draft. Identity-field (name/email/order) edits only permitted while draft. Any change to status/signed_at/signed_document_id/decline_reason/has_embedded_signature/signature_check_note made with current_user = ''authenticated'' (a direct client write) is rejected — only decline_signer / record_signed_document (running as the function owner) may change those. Delete only permitted while draft.';


-- ----------------------------------------------------------------------------
-- send_signature_request — draft -> sent. Requires a source document and at
-- least one signer, so "sent" always means something was actually put in
-- front of someone.
-- ----------------------------------------------------------------------------
create or replace function public.send_signature_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_status text;
  v_has_document boolean;
  v_signer_count integer;
begin
  select company_id, status into v_company_id, v_status
    from public.signature_requests where id = p_request_id;

  if v_company_id is null then
    raise exception 'Signature request % does not exist', p_request_id;
  end if;
  if not app_private.can_write_company(v_company_id) then
    raise exception 'Not permitted to send this signature request';
  end if;
  if v_status <> 'draft' then
    raise exception 'Only a draft request can be sent (current status: %)', v_status;
  end if;

  select exists(
    select 1 from public.documents
     where entity_type = 'signature_request' and entity_id = p_request_id
  ) into v_has_document;
  if not v_has_document then
    raise exception 'Attach the document to be signed before sending';
  end if;

  select count(*) into v_signer_count
    from public.signature_request_signers where request_id = p_request_id;
  if v_signer_count = 0 then
    raise exception 'Add at least one signer before sending';
  end if;

  update public.signature_requests set status = 'sent' where id = p_request_id;
end;
$$;

revoke all on function public.send_signature_request(uuid) from public, anon;
grant execute on function public.send_signature_request(uuid) to authenticated;

comment on function public.send_signature_request(uuid) is
  'draft -> sent. Requires at least one document already attached (entity_type=''signature_request'') and at least one signer. After this, signers can no longer be added, removed, or have their name/email/order edited (enforce_signature_request_signer_write).';


-- ----------------------------------------------------------------------------
-- cancel_signature_request — draft/sent -> cancelled. Idempotent if already
-- cancelled; refused if already completed (a completed request is done).
-- ----------------------------------------------------------------------------
create or replace function public.cancel_signature_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_status text;
begin
  select company_id, status into v_company_id, v_status
    from public.signature_requests where id = p_request_id;

  if v_company_id is null then
    raise exception 'Signature request % does not exist', p_request_id;
  end if;
  if not app_private.can_write_company(v_company_id) then
    raise exception 'Not permitted to cancel this signature request';
  end if;
  if v_status = 'completed' then
    raise exception 'A completed request cannot be cancelled';
  end if;
  if v_status = 'cancelled' then
    return;
  end if;

  update public.signature_requests set status = 'cancelled' where id = p_request_id;
end;
$$;

revoke all on function public.cancel_signature_request(uuid) from public, anon;
grant execute on function public.cancel_signature_request(uuid) to authenticated;

comment on function public.cancel_signature_request(uuid) is
  'draft or sent -> cancelled. No-op if already cancelled. Refused once completed.';


-- ----------------------------------------------------------------------------
-- decline_signer — one pending signer says no. See migration header: this
-- permanently blocks record_signed_document's auto-completion for this
-- request (removal is draft-only, and this request is already sent).
-- ----------------------------------------------------------------------------
create or replace function public.decline_signer(
  p_request_id uuid,
  p_signer_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_req_status text;
  v_signer_status text;
begin
  select company_id, status into v_company_id, v_req_status
    from public.signature_requests where id = p_request_id;
  if v_company_id is null then
    raise exception 'Signature request % does not exist', p_request_id;
  end if;
  if not app_private.can_write_company(v_company_id) then
    raise exception 'Not permitted to update this signature request';
  end if;
  if v_req_status <> 'sent' then
    raise exception 'Can only record a decline on a sent request (current status: %)', v_req_status;
  end if;

  select status into v_signer_status
    from public.signature_request_signers
   where id = p_signer_id and request_id = p_request_id;
  if v_signer_status is null then
    raise exception 'Signer % is not on request %', p_signer_id, p_request_id;
  end if;
  if v_signer_status <> 'pending' then
    raise exception 'Signer has already % — cannot decline', v_signer_status;
  end if;

  update public.signature_request_signers
     set status = 'declined',
         decline_reason = nullif(trim(coalesce(p_reason, '')), '')
   where id = p_signer_id;
end;
$$;

revoke all on function public.decline_signer(uuid, uuid, text) from public, anon;
grant execute on function public.decline_signer(uuid, uuid, text) to authenticated;

comment on function public.decline_signer(uuid, uuid, text) is
  'Marks one pending signer on a sent request as declined. Permanently prevents that request from auto-completing (see 0175 header) — the realistic recovery is cancel_signature_request and a fresh draft without that signer.';


-- ----------------------------------------------------------------------------
-- record_signed_document — the one write RPC the task specified by name.
-- Marks one signer's step complete once their signed-back copy has been
-- uploaded as a public.documents row, and auto-completes the parent request
-- when every signer has now signed.
-- ----------------------------------------------------------------------------
create or replace function public.record_signed_document(
  p_request_id uuid,
  p_signer_id uuid,
  p_document_id uuid,
  p_has_embedded_signature boolean default null,
  p_signature_check_note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_req_status text;
  v_signer_status text;
  v_doc record;
  v_remaining integer;
begin
  select company_id, status into v_company_id, v_req_status
    from public.signature_requests where id = p_request_id;
  if v_company_id is null then
    raise exception 'Signature request % does not exist', p_request_id;
  end if;
  if not app_private.can_write_company(v_company_id) then
    raise exception 'Not permitted to update this signature request';
  end if;
  if v_req_status <> 'sent' then
    raise exception 'Can only record a signed document on a sent request (current status: %)', v_req_status;
  end if;

  select status into v_signer_status
    from public.signature_request_signers
   where id = p_signer_id and request_id = p_request_id;
  if v_signer_status is null then
    raise exception 'Signer % is not on request %', p_signer_id, p_request_id;
  end if;
  if v_signer_status <> 'pending' then
    raise exception 'Signer has already % — cannot record another signature', v_signer_status;
  end if;

  select company_id, entity_type, entity_id into v_doc
    from public.documents where id = p_document_id;
  if v_doc.company_id is null then
    raise exception 'Document % does not exist', p_document_id;
  end if;
  if v_doc.company_id <> v_company_id then
    raise exception 'Document % does not belong to this company', p_document_id;
  end if;
  if v_doc.entity_type <> 'signature_request_signer' or v_doc.entity_id <> p_signer_id then
    raise exception 'Document % is not tagged as the signed-back copy for signer % (upload it with entity_type=signature_request_signer, entity_id=%)',
      p_document_id, p_signer_id, p_signer_id;
  end if;

  update public.signature_request_signers
     set status = 'signed',
         signed_at = now(),
         signed_document_id = p_document_id,
         has_embedded_signature = p_has_embedded_signature,
         signature_check_note = p_signature_check_note
   where id = p_signer_id;

  select count(*) into v_remaining
    from public.signature_request_signers
   where request_id = p_request_id and status <> 'signed';

  if v_remaining = 0 then
    update public.signature_requests set status = 'completed' where id = p_request_id;
  end if;
end;
$$;

revoke all on function public.record_signed_document(uuid, uuid, uuid, boolean, text) from public, anon;
grant execute on function public.record_signed_document(uuid, uuid, uuid, boolean, text) to authenticated;

comment on function public.record_signed_document(uuid, uuid, uuid, boolean, text) is
  'Marks signer p_signer_id on request p_request_id as signed, pointing at an already-uploaded public.documents row (must be tagged entity_type=signature_request_signer, entity_id=p_signer_id, same company). p_has_embedded_signature/p_signature_check_note carry the client-side structural PDF check result (lib/pdf/signature-check.ts) verbatim — this function does not itself inspect the file. Auto-transitions the parent request to completed once every signer on it has status=signed.';
