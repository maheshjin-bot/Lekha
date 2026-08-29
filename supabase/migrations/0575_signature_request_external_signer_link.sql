-- ============================================================================
-- 0575 — E-signature: a scoped external link for a signer with no LEKHA login
-- ============================================================================
-- 0175 (e-signature request workflow) shipped the internal tracker and
-- explicitly named this as deferred, in its own header: "A signer with no
-- LEKHA login of their own finds out their document is waiting for them the
-- same way this app already handles every other outbound communication it
-- has no email/SMS integration for — the requester tells them directly,
-- outside the app... Building a scoped external-signer view (a public,
-- token-authenticated read link, the shape 0063's public API already
-- establishes for a different purpose) is a real, concrete follow-up if a
-- user asks for it — not attempted here." This migration is that follow-up.
--
-- READ 0063 (public_api / authenticate_api_key) FIRST — done, and this
-- migration deliberately reuses its shape: a long random opaque secret,
-- looked up (not decoded/verified cryptographically), resolved by a
-- SECURITY DEFINER function that is explicitly GRANTed to anon — the one
-- deliberate reversal of this schema's usual "anon gets nothing" convention,
-- same as 0063's own header calls out. Two things are deliberately NOT
-- copied from 0063, both explained below: this token is scoped to exactly
-- one signer (not a whole company), and it is stored in the clear rather
-- than hashed.
--
-- ==========================================================================
-- WHY THE TOKEN IS SCOPED TO ONE SIGNER, NOT ONE REQUEST OR ONE COMPANY.
-- ==========================================================================
-- An api_key (0063) authenticates a whole company's worth of read access to
-- an external system that is trusted with that scope on purpose (a BI tool,
-- a script the company itself set up). A signature-request signer is a
-- named individual outside the company who is trusted with exactly one
-- thing: their own row. access_token lives on signature_request_signers,
-- one column per signer, so signer #2's link can never resolve signer #1's
-- name, email, decline reason, or signed copy — there is no "list signers"
-- capability behind this token at all, by construction (see
-- get_signature_request_by_token below: it joins FROM the authenticated
-- signer row, never queries the sibling rows).
--
-- ==========================================================================
-- WHY THIS TOKEN IS STORED IN THE CLEAR, UNLIKE api_keys.key_hash.
-- ==========================================================================
-- 0063 hashes API keys and shows the raw value exactly once, at creation,
-- for the same reason set_company_password (0044) hashes a password: the
-- blast radius of that secret is broad (a whole company's trial balance and
-- dashboard KPIs, indefinitely) and the product never needs to show it back
-- to anyone after the moment of creation — a lost key is simply replaced.
-- Neither is true here:
--   - BLAST RADIUS: this token unlocks exactly one signer's own metadata,
--     one already-uploaded source document, and the ability to upload back
--     a signed copy that a decline_signer/record_signed_document-shaped
--     function still separately validates against a guarded state machine.
--     A leaked token cannot read another signer, another request, or any
--     other company's data, and the worst a malicious holder can do to the
--     one request it names is upload a document to a slot record_signed_
--     document_by_token will itself refuse to double-write (see below).
--   - RE-DISPLAY IS THE WHOLE POINT: unlike an API key (typed once into a
--     script's config and forgotten), the company needs to keep re-sharing
--     this exact link — resend it if the first WhatsApp message got lost,
--     paste it into a follow-up email, hand it to a different employee who
--     is now chasing the signature. A one-time reveal, matching 0063's
--     pattern, would make the feature unusable for its own stated purpose.
--     A genuine reveal-once design (hash the token, return the raw value
--     only from send_signature_request) was considered and rejected here
--     specifically because it would require changing send_signature_
--     request's return signature from void to a row set — a real change to
--     the one function this task's own brief says not to touch beyond
--     adding token generation to its body (see below); reshaping its
--     contract is a larger, separate decision than this task owns.
--   - A company member who can already see this row (is_company_member,
--     unchanged) can already see everything the token would ever reveal
--     about the signer, and already has an authenticated path
--     (regenerate_signer_access_token, below) to invalidate a leaked token
--     immediately. This is a shareable-link model (the same trust shape as
--     a Google Docs "anyone with the link" URL), not a login-credential
--     model — and is documented here explicitly rather than left as an
--     unstated inconsistency with 0063's own hashing.
--
-- ==========================================================================
-- WHEN THE TOKEN IS GENERATED — send_signature_request, ADDITIVELY.
-- ==========================================================================
-- The task brief names this as one of two sanctioned places ("generated by
-- send_signature_request when a signer is added, or by a new dedicated
-- function"); a signer cannot usefully hold a link before the request is
-- actually sent (send_signature_request is also where enforce_signature_
-- request_signer_write's own trigger freezes the signer list — no signer
-- can be added or removed afterwards), so token issuance is folded into
-- that same moment. This is the ONE existing "core CRUD" function this
-- migration touches, and the change is purely additive: every existing
-- check, the draft->sent transition, and the function's void return type
-- are all untouched — read the diff against 0175's own version to confirm.
-- No signer is ever without a token once a request reaches 'sent', and
-- signers can no longer be added after that point, so this single pass
-- covers every signer for the request's whole lifetime.
--
-- ==========================================================================
-- THE UPLOAD-BACK PATH: A NARROW SECURITY DEFINER WRAPPER, NOT A BROADENED
-- WRITE POLICY — PER THE TASK BRIEF, WITH ONE UNAVOIDABLE EXCEPTION EXPLAINED.
-- ==========================================================================
-- record_signed_document_by_token mirrors record_signed_document's own
-- guarded logic (validate request is 'sent', signer is 'pending', then
-- flip to 'signed' and roll up to 'completed' once every signer has) but
-- authorizes via the caller's token instead of can_write_company, and —
-- because it is the only place in this schema anon is allowed to write
-- signer state at all — it does the public.documents INSERT itself, inside
-- the function, as SECURITY DEFINER. This means public.documents' own RLS
-- (authenticated-only, completely unchanged) never needs a policy anon can
-- see at all: the function validates the storage_path's prefix against the
-- company_id/signer_id the TOKEN resolved to (never a client-supplied
-- company_id/signer_id), so a caller cannot point it at an unrelated file.
--
-- THE ONE PLACE THIS MIGRATION DOES ADD NARROW anon POLICIES: storage.
-- objects, and only there, because raw file bytes physically cannot move
-- through a SQL function — Storage's object bytes live in the configured
-- backend (S3/disk), not in a Postgres column; storage.objects only ever
-- held metadata (see 0060's own header). Reaching them at all requires the
-- Storage HTTP API, which enforces authorization via RLS on storage.objects
-- for whatever role the caller's key carries — anon here, since this app
-- has (by design, see .env.example) no service_role key anywhere in its
-- code to bypass that with. Three new storage.objects policies, each as
-- narrow as the object model allows:
--   - anon SELECT, 'documents' bucket, ONLY objects whose path's 2nd folder
--     segment is 'signature_request' (the source document a requester
--     attached — never 'signature_request_signer', another signer's signed-
--     back copy, which stays fully unreadable to anon under every
--     circumstance) AND whose request (3rd path segment) is currently
--     'sent' or 'completed'.
--   - anon INSERT, same bucket, ONLY objects whose 2nd segment is
--     'signature_request_signer' AND whose signer (3rd segment) is
--     currently 'pending' on a request that is currently 'sent'.
--   - anon DELETE, identical shape to the INSERT policy, so a client that
--     uploaded bytes but then had record_signed_document_by_token reject
--     the call (e.g. a race where another tab already recorded a signature
--     first) can clean up after itself exactly like DocumentAttachments.tsx
--     and SignerRow already do today for the authenticated path.
--
-- RESIDUAL TRADE-OFF, STATED PLAINLY: none of these three storage policies
-- can check the signer's actual secret token — a storage.objects RLS policy
-- only ever sees the object's own path/columns and the caller's Postgres
-- role, never an app-level parameter passed alongside the request (Supabase
-- Storage does not forward arbitrary custom headers into a GUC the way
-- PostgREST forwards JWT claims). What gates real access is that a path
-- is a chain of THREE server-generated random UUIDs (company_id/.../entity_
-- id/random-filename) that is never once returned to anon by anything in
-- this schema except get_signature_request_by_token — which itself IS
-- token-gated. Knowledge of one exact path is therefore equivalent to
-- having gone through the token gate already, the same trust model as a
-- signed URL or a "anyone with this link" share. The bounded exception: an
-- anon caller who somehow already knows a pending signer's id (never
-- enumerable — gen_random_uuid(), and never listed anywhere anon can read)
-- could POST bytes into that signer's folder without the real token; this
-- can, at most, leave an orphaned, never-referenced file sitting in
-- storage — it cannot mark anyone as signed, since only record_signed_
-- document_by_token can do that, and it re-validates the real token from
-- scratch. No storage lifecycle cleanup job is added for such orphans —
-- cheap, low-severity, and out of this task's scope.
--
-- ==========================================================================
-- WHAT ELSE THIS MIGRATION TOUCHES, AND WHY.
-- ==========================================================================
-- enforce_signature_request_signer_write (0175's own trigger) is extended,
-- additively, to also treat access_token and the new token_last_used_at as
-- protected columns — nulled on INSERT, and only changeable by a function
-- running as current_user <> 'authenticated' (send_signature_request,
-- regenerate_signer_access_token, or the token-authenticating lookup
-- itself). Without this, any authenticated company write to a signer row
-- could silently overwrite or clear a token that has already been handed
-- to someone outside the app. Every existing column this trigger already
-- guarded, and every existing check, is untouched.
--
-- LOGGING/RATE-LIMITING — STATED, NOT BUILT, PER THE TASK BRIEF'S OWN
-- "nice-to-have, not the core ask": app_private.authenticate_signer_token
-- bumps signature_request_signers.token_last_used_at on every SUCCESSFUL
-- lookup (visible to the company on the new /signature-requests/[id]/links
-- page below) — a real, if minimal, "was this link ever opened" signal.
-- Failed lookups against an unknown/garbage token are NOT logged anywhere:
-- there is no row to attach a timestamp to without a dedicated access-log
-- table, and no throttling of repeated attempts is implemented at all. A
-- real rate limit needs infrastructure (Postgres alone cannot see or
-- reject repeated calls fast enough to matter before the query itself
-- runs) this task does not build.
--
-- UI: app/sign/[token]/page.tsx + components/signature-requests/
-- ExternalSignerView.tsx are the new public route. SignatureRequestManager.
-- tsx (the internal flow) and lib/pdf/signature-check.ts are reused
-- byte-for-byte, per the task brief — the check is imported and called
-- exactly as SignerRow already does, and the internal manager component is
-- not edited at all. That leaves company members with no in-app "copy this
-- signer's link" button inside the internal RequestCard/SignerRow UI they
-- already use — adding one is exactly a one-line change to SignerRow but
-- SignerRow lives inside the file this task was told not to touch, so
-- instead a new, additive sibling screen, app/(app)/[companyId]/signature-
-- requests/[requestId]/links/page.tsx, lists every signer's copyable
-- /sign/[token] URL and last-opened time. It has no NavRail entry (nav
-- wiring is centralised) and no link from SignatureRequestManager.tsx
-- pointing at it yet — a real, named follow-up for whoever next revises
-- that component, not a silent gap.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- signature_request_signers: the new columns this task owns.
-- ----------------------------------------------------------------------------
alter table public.signature_request_signers
  add column access_token text unique,
  add column token_last_used_at timestamptz;

create index signature_request_signers_access_token_idx
  on public.signature_request_signers (access_token)
  where access_token is not null;

comment on column public.signature_request_signers.access_token is
  'Long random opaque secret (encode(gen_random_bytes(32),''hex'') — 256 bits) minting a public, unauthenticated /sign/[token] link scoped to exactly this signer. Generated by send_signature_request when the parent request moves draft->sent; null before that. Stored in the clear, not hashed — see 0575 migration header for why that is a deliberate choice here, unlike api_keys.key_hash (0063). Protected the same way status/signed_at/etc already are (enforce_signature_request_signer_write): a direct authenticated client UPDATE cannot change it.';

comment on column public.signature_request_signers.token_last_used_at is
  'Bumped by app_private.authenticate_signer_token on every successful token lookup — a minimal "was this link ever opened" signal (0575). Failed/unknown-token lookups are not logged anywhere; there is no rate limiting. See 0575 migration header.';


-- ----------------------------------------------------------------------------
-- enforce_signature_request_signer_write — additive extension: access_token
-- and token_last_used_at join the existing protected-column set. Every other
-- line is 0175's own, unchanged.
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
    new.access_token := null;
    new.token_last_used_at := null;
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
      new.has_embedded_signature, new.signature_check_note,
      new.access_token, new.token_last_used_at)
     is distinct from
     (old.status, old.signed_at, old.signed_document_id, old.decline_reason,
      old.has_embedded_signature, old.signature_check_note,
      old.access_token, old.token_last_used_at)
  then
    if current_user = 'authenticated' then
      raise exception 'Signer status/access token can only change via decline_signer, record_signed_document, record_signed_document_by_token, send_signature_request, or regenerate_signer_access_token — not a direct update';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

comment on function app_private.enforce_signature_request_signer_write() is
  '0175''s original guard, extended by 0575 to also protect access_token/token_last_used_at (nulled on insert, changeable only by a trusted SECURITY DEFINER function, never a direct authenticated UPDATE). Every other check is unchanged from 0175.';


-- ----------------------------------------------------------------------------
-- send_signature_request — 0175's own function, additively extended to mint
-- an access_token for every signer on the request once it moves to 'sent'.
-- Every existing check and the void return type are unchanged.
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

  -- 0575: mint each signer's external-view token now, the one moment the
  -- signer list is final (enforce_signature_request_signer_write forbids
  -- add/remove from here on) and the first moment a link is meaningful to
  -- hand out.
  update public.signature_request_signers
     set access_token = encode(extensions.gen_random_bytes(32), 'hex')
   where request_id = p_request_id
     and access_token is null;
end;
$$;

revoke all on function public.send_signature_request(uuid) from public, anon;
grant execute on function public.send_signature_request(uuid) to authenticated;

comment on function public.send_signature_request(uuid) is
  'draft -> sent. Requires at least one document already attached (entity_type=''signature_request'') and at least one signer. After this, signers can no longer be added, removed, or have their name/email/order edited (enforce_signature_request_signer_write). 0575: also mints each signer''s access_token here, the point at which the signer list is frozen and an external link first becomes meaningful.';


-- ----------------------------------------------------------------------------
-- regenerate_signer_access_token — authenticated safety valve if a link
-- leaks: invalidates the old token and issues a fresh one. Only meaningful
-- while the request is still 'sent' (before that there is no token to leak;
-- after 'completed'/'cancelled' the signing process is over).
-- ----------------------------------------------------------------------------
create or replace function public.regenerate_signer_access_token(
  p_signer_id uuid
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_request_id uuid;
  v_request_status text;
  v_new_token text;
begin
  select company_id, request_id into v_company_id, v_request_id
    from public.signature_request_signers where id = p_signer_id;
  if v_company_id is null then
    raise exception 'Signer % does not exist', p_signer_id;
  end if;
  if not app_private.can_write_company(v_company_id) then
    raise exception 'Not permitted to manage this signature request';
  end if;

  select status into v_request_status
    from public.signature_requests where id = v_request_id;
  if v_request_status <> 'sent' then
    raise exception 'Can only regenerate a signer''s link while the request is sent (current status: %)', v_request_status;
  end if;

  v_new_token := encode(extensions.gen_random_bytes(32), 'hex');
  update public.signature_request_signers
     set access_token = v_new_token,
         token_last_used_at = null
   where id = p_signer_id;

  return v_new_token;
end;
$$;

revoke all on function public.regenerate_signer_access_token(uuid) from public, anon;
grant execute on function public.regenerate_signer_access_token(uuid) to authenticated;

comment on function public.regenerate_signer_access_token(uuid) is
  'Invalidates a signer''s current /sign/[token] link and issues a fresh one — e.g. if the old link was sent to the wrong address. Only while the parent request is ''sent''. Returns the new raw token (shown on the /links screen); the old one stops resolving immediately since access_token is unique and overwritten in place.';


-- ----------------------------------------------------------------------------
-- app_private.authenticate_signer_token(token) — the shared lookup, mirrors
-- app_private.authenticate_api_key (0063) exactly: same "raise a single,
-- non-distinguishing error for any invalid credential" discipline, same
-- side-effecting bump-a-timestamp-on-success behaviour. Internal only —
-- never granted to anon directly, only its two callers below are, matching
-- 0063's own precedent (authenticate_api_key isn't anon-granted either).
-- ----------------------------------------------------------------------------
create or replace function app_private.authenticate_signer_token(p_token text)
returns table (
  signer_id uuid,
  request_id uuid,
  company_id uuid,
  request_status text,
  signer_status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_signer_id uuid;
  v_request_id uuid;
  v_company_id uuid;
  v_request_status text;
  v_signer_status text;
begin
  if p_token is null or length(p_token) = 0 then
    raise exception 'Invalid signature link';
  end if;

  select s.id, s.request_id, s.company_id, r.status, s.status
    into v_signer_id, v_request_id, v_company_id, v_request_status, v_signer_status
    from public.signature_request_signers s
    join public.signature_requests r on r.id = s.request_id
   where s.access_token = p_token;

  -- Deliberately the same error regardless of why — unknown token, or a
  -- token that (structurally) could never have been issued — same
  -- reasoning as authenticate_api_key's identical "no such key"/"revoked
  -- key" merge (0063).
  if v_signer_id is null then
    raise exception 'Invalid signature link';
  end if;

  update public.signature_request_signers
     set token_last_used_at = now()
   where id = v_signer_id;

  return query select v_signer_id, v_request_id, v_company_id, v_request_status, v_signer_status;
end;
$$;

revoke all on function app_private.authenticate_signer_token(text) from public, anon, authenticated;

comment on function app_private.authenticate_signer_token(text) is
  'Validates a raw signer access_token and returns the one signer/request/company it resolves to, or raises "Invalid signature link" (same message for every failure mode). Bumps token_last_used_at on success. Called by get_signature_request_by_token and record_signed_document_by_token so external callers never need a Supabase Auth session — see 0575 migration header for why this and its two callers are SECURITY DEFINER and re-derive everything from the token on every call.';


-- ----------------------------------------------------------------------------
-- public.get_signature_request_by_token — the one narrow read-only lookup.
-- Returns exactly one row: this signer's own status fields, the parent
-- request's title/description/status, the requesting company's name, and
-- the source document(s) attached to the request (never the signer's own or
-- any other signer's signed-back copy). Never queries sibling signer rows.
-- ----------------------------------------------------------------------------
create or replace function public.get_signature_request_by_token(p_token text)
returns table (
  request_id uuid,
  company_id uuid,
  company_name text,
  request_title text,
  request_description text,
  request_status text,
  signer_id uuid,
  signer_name text,
  signer_email text,
  sign_order integer,
  signer_status text,
  signed_at timestamptz,
  decline_reason text,
  documents jsonb
)
-- VOLATILE (the default), not stable: authenticate_signer_token has a real
-- side effect (bumping token_last_used_at). Marking this stable would make
-- PostgREST open a read-only transaction, which then refuses that UPDATE —
-- exactly the failure 0063's own api_get_trial_balance comment documents
-- hitting live; not repeating that mistake here.
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
    select
      r.id, r.company_id, c.name,
      r.title, r.description, r.status,
      s.id, s.signer_name, s.signer_email, s.sign_order, s.status, s.signed_at, s.decline_reason,
      coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', d.id,
                 'file_name', d.file_name,
                 'mime_type', d.mime_type,
                 'size_bytes', d.size_bytes,
                 'storage_path', d.storage_path
               ) order by d.created_at)
          from public.documents d
         where d.entity_type = 'signature_request' and d.entity_id = r.id
      ), '[]'::jsonb)
      from app_private.authenticate_signer_token(p_token) auth
      join public.signature_requests r on r.id = auth.request_id
      join public.signature_request_signers s on s.id = auth.signer_id
      join public.companies c on c.id = r.company_id;
end;
$$;

revoke all on function public.get_signature_request_by_token(text) from public, anon;
grant execute on function public.get_signature_request_by_token(text) to anon;

comment on function public.get_signature_request_by_token(text) is
  'Public API v1-shaped, unauthenticated lookup for app/sign/[token]: given one signer''s access_token, returns that signer''s own status plus the parent request''s title/description/status/company name and its source document(s) — never any other signer''s name, email, status, or signed-back copy, and never any other request. Raises "Invalid signature link" (app_private.authenticate_signer_token) for any unknown/garbage token, the same message regardless of cause.';


-- ----------------------------------------------------------------------------
-- public.record_signed_document_by_token — token-authenticated mirror of
-- record_signed_document (0175), reused in spirit not by direct call (that
-- function authorizes via can_write_company, which a token holder never
-- has). Performs the public.documents INSERT itself, as SECURITY DEFINER,
-- so public.documents' own RLS never needs an anon-visible policy at all —
-- see migration header.
-- ----------------------------------------------------------------------------
create or replace function public.record_signed_document_by_token(
  p_token text,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_has_embedded_signature boolean default null,
  p_signature_check_note text default null
) returns void
-- VOLATILE, same reason as get_signature_request_by_token above — this one
-- also performs real INSERT/UPDATE writes of its own.
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth record;
  v_expected_prefix text;
  v_document_id uuid;
  v_remaining integer;
begin
  select * into v_auth from app_private.authenticate_signer_token(p_token);
  -- authenticate_signer_token already raised if the token itself is
  -- invalid; v_auth is guaranteed populated from here on.

  if v_auth.request_status <> 'sent' then
    raise exception 'This signature request is no longer open for uploads (status: %)', v_auth.request_status;
  end if;
  if v_auth.signer_status <> 'pending' then
    raise exception 'This signature has already been recorded as % — it cannot be uploaded again', v_auth.signer_status;
  end if;

  -- Never trust a client-supplied path outright: it must sit exactly under
  -- THIS token's own company/signer folder, derived from the token itself,
  -- not from anything the caller asserts.
  v_expected_prefix := v_auth.company_id::text || '/signature_request_signer/' || v_auth.signer_id::text || '/';
  if left(p_storage_path, length(v_expected_prefix)) <> v_expected_prefix then
    raise exception 'Uploaded file path does not belong to this signer';
  end if;

  -- Defense in depth — the 'documents' bucket (0060) already enforces this
  -- same allow-list and 10MB cap at the Storage-API layer before a byte is
  -- ever accepted; this repeats it because this function inserts the
  -- public.documents metadata row itself rather than trusting one a client
  -- already inserted (see migration header).
  if p_mime_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then
    raise exception 'Unsupported file type: %', p_mime_type;
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 10485760 then
    raise exception 'File size out of the allowed range (up to 10 MB)';
  end if;

  insert into public.documents (
    company_id, entity_type, entity_id, storage_path, file_name, mime_type, size_bytes, uploaded_by
  ) values (
    v_auth.company_id, 'signature_request_signer', v_auth.signer_id,
    p_storage_path, p_file_name, p_mime_type, p_size_bytes, null
  )
  returning id into v_document_id;

  update public.signature_request_signers
     set status = 'signed',
         signed_at = now(),
         signed_document_id = v_document_id,
         has_embedded_signature = p_has_embedded_signature,
         signature_check_note = p_signature_check_note
   where id = v_auth.signer_id;

  select count(*) into v_remaining
    from public.signature_request_signers
   where request_id = v_auth.request_id and status <> 'signed';

  if v_remaining = 0 then
    update public.signature_requests set status = 'completed' where id = v_auth.request_id;
  end if;
end;
$$;

revoke all on function public.record_signed_document_by_token(text, text, text, text, bigint, boolean, text) from public, anon;
grant execute on function public.record_signed_document_by_token(text, text, text, text, bigint, boolean, text) to anon;

comment on function public.record_signed_document_by_token(text, text, text, text, bigint, boolean, text) is
  'Token-authenticated equivalent of record_signed_document (0175), for a signer with no LEKHA session: takes a raw access_token instead of relying on can_write_company, validates the request is still ''sent'' and this signer still ''pending'', validates the already-uploaded storage_path actually sits under this token''s own company/signer folder, inserts the public.documents row itself (public.documents'' own RLS is never opened to anon), marks this signer signed, and auto-completes the parent request once every signer has. Rejects with a specific error once the signer has already signed/declined or the request is no longer sent (including cancelled) — see 0575 migration header for why these errors, unlike an invalid-token error, are allowed to be specific.';


-- ----------------------------------------------------------------------------
-- storage.objects — three narrow anon policies, and only these three. See
-- migration header for the full reasoning and the stated residual trade-off.
-- ----------------------------------------------------------------------------
create policy documents_bucket_read_signature_request_anon on storage.objects
  for select to anon
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[2] = 'signature_request'
    and exists (
      select 1 from public.signature_requests r
       where r.id = ((storage.foldername(name))[3])::uuid
         and r.company_id = ((storage.foldername(name))[1])::uuid
         and r.status in ('sent', 'completed')
    )
  );

create policy documents_bucket_write_signer_token_anon on storage.objects
  for insert to anon
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[2] = 'signature_request_signer'
    and exists (
      select 1
        from public.signature_request_signers s
        join public.signature_requests r on r.id = s.request_id
       where s.id = ((storage.foldername(name))[3])::uuid
         and s.company_id = ((storage.foldername(name))[1])::uuid
         and s.status = 'pending'
         and r.status = 'sent'
    )
  );

create policy documents_bucket_delete_signer_token_anon on storage.objects
  for delete to anon
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[2] = 'signature_request_signer'
    and exists (
      select 1
        from public.signature_request_signers s
        join public.signature_requests r on r.id = s.request_id
       where s.id = ((storage.foldername(name))[3])::uuid
         and s.company_id = ((storage.foldername(name))[1])::uuid
         and s.status = 'pending'
         and r.status = 'sent'
    )
  );

comment on policy documents_bucket_read_signature_request_anon on storage.objects is
  '0575: lets an anon caller (the public /sign/[token] page) download a signature request''s SOURCE document (entity_type=signature_request only — never a signer''s signed-back copy) while the request is sent or completed. Gated on the object path alone, not the caller''s token (storage RLS cannot see it) — see 0575 migration header for why the path itself is the effective secret.';

comment on policy documents_bucket_write_signer_token_anon on storage.objects is
  '0575: lets an anon caller upload bytes into a specific PENDING signer''s own folder on a SENT request. Uploading here alone changes nothing — only record_signed_document_by_token (which does check the real access_token) can turn this into a recorded signature. See 0575 migration header for the residual-risk statement.';
