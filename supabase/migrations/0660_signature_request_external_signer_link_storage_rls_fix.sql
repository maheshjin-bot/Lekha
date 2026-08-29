-- ============================================================================
-- 0660 — Fix: 0575's anon storage.objects policies always evaluated false
-- ============================================================================
-- CAUGHT BY LIVE HTTP VERIFICATION, NOT CODE REVIEW. 0575 added three
-- storage.objects RLS policies for role anon, each gated by a raw
-- `exists (select 1 from public.signature_requests ...)` /
-- `exists (select 1 from public.signature_request_signers ... join
-- public.signature_requests ...)` subquery. That subquery runs as the
-- CALLING role — anon — and public.signature_requests /
-- public.signature_request_signers both have their own RLS, restricted to
-- `to authenticated using (is_company_member(...))`. anon has no policy on
-- either table at all, so from anon's perspective every row is invisible
-- and the EXISTS is always false, regardless of the actual request/signer
-- status. Net effect: the three 0575 storage policies looked correct by
-- inspection but denied every anon request unconditionally.
--
-- Confirmed live end to end, not assumed:
--   - Uploaded a real object to the exact path a genuinely 'sent' request's
--     source document lives at (authenticated, as the owning company's
--     admin) — 200, object exists (Key returned).
--   - The SAME authenticated session's own POST .../storage/v1/object/sign/
--     documents/<path> for that object — 200, signed URL returned. The
--     object is real and reachable.
--   - The identical POST with only the anon apikey (no session) — 400
--     "Object not found" (Storage's own not-found-vs-forbidden merge, so
--     as not to confirm existence to a caller RLS has already rejected).
--     This should have been 200 once a valid token had already been
--     resolved via get_signature_request_by_token (itself confirmed
--     correctly scoped by the same live test) — it was not, because the
--     underlying policy's EXISTS could never see the row.
--
-- A SECOND, INDEPENDENT BUG THIS SAME LIVE PASS CAUGHT: even after fixing
-- the EXISTS-via-RLS problem above, an anon DELETE of an orphaned upload
-- (the ExternalSignerView.tsx cleanup path, when record_signed_document_by_
-- token itself rejects the call — e.g. an unsupported mime type slipped
-- past client-side validation) still came back 403 "Access denied", even
-- though app_private.signature_request_signer_upload_allowed correctly
-- returned true for that exact signer/company pair when called directly.
-- Storage's single-object DELETE endpoint resolves the object via a read
-- first, which needs a matching SELECT policy — 0575 only added an anon
-- SELECT policy for entity_type=signature_request (the source document),
-- never for signature_request_signer (a signer's own upload), so that
-- lookup had nothing to match and the delete never got as far as the
-- DELETE policy's own check. Fixed by adding a fourth, identically-scoped
-- anon SELECT policy below. Its side effect is intentional and narrow: a
-- signer can also read back their OWN just-uploaded copy, but ONLY while
-- their own status is still 'pending' — the instant record_signed_
-- document_by_token succeeds and flips them to 'signed', this same policy
-- stops matching (status is no longer 'pending'), so it never becomes a
-- standing "re-download my signed copy" feature (deliberately out of scope,
-- see 0575 migration header) — it only ever covers the brief pending-vs-
-- failed-record window this self-cleanup path needs.
--
-- FIX: exactly the pattern every other cross-table RLS check in this schema
-- already uses (app_private.is_company_member, app_private.can_write_
-- company) — wrap the lookup in a SECURITY DEFINER function so it runs as
-- the function's owner, bypassing the referenced tables' own RLS, the same
-- way 0060's own `documents_bucket_read` policy calls
-- `app_private.is_company_member(...)` rather than querying
-- company_members directly. Two new functions, each doing exactly the one
-- check its policy needs and nothing else — neither is granted execute to
-- anon or authenticated at the SQL level (a storage RLS policy invokes them
-- as part of evaluating the policy itself, the same way a table's own USING
-- clause can call a STABLE/SECURITY DEFINER function without a client ever
-- calling it directly; see is_company_member's own grants for the same
-- shape). The three policies are dropped and recreated to call these
-- instead of the raw EXISTS; every condition they encode is otherwise
-- byte-for-byte the same as 0575 shipped (source doc, sent-or-completed;
-- signer upload, pending signer on a sent request) — only the RLS-bypass
-- mechanism changed.
-- ============================================================================


create or replace function app_private.signature_request_source_doc_visible(
  p_request_id uuid,
  p_company_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.signature_requests r
     where r.id = p_request_id
       and r.company_id = p_company_id
       and r.status in ('sent', 'completed')
  );
$$;

-- A storage RLS policy is evaluated AS the calling role — anon here — so
-- anon needs actual EXECUTE on this function to invoke it at all, distinct
-- from what SECURITY DEFINER does once inside it (bypass the tables' RLS).
-- Caught live: the first version of this migration revoked anon/
-- authenticated too, and the very next verification request came back
-- "403 permission denied for function ..." — a real, second bug this same
-- live-testing pass caught, not assumed away. Matches
-- app_private.is_company_member's own grant shape (PUBLIC has EXECUTE
-- there too, for the identical reason: it backs anon-reachable-in-principle
-- policies elsewhere in this schema).
revoke all on function app_private.signature_request_source_doc_visible(uuid, uuid) from public;
grant execute on function app_private.signature_request_source_doc_visible(uuid, uuid) to anon, authenticated;

comment on function app_private.signature_request_source_doc_visible(uuid, uuid) is
  '0660: SECURITY DEFINER check backing documents_bucket_read_signature_request_anon (storage.objects) — bypasses signature_requests'' own authenticated-only RLS so the anon-role policy can actually see whether the row it names is sent/completed. Granted to anon/authenticated (not PUBLIC) because a storage policy invokes this AS its calling role, which must itself have EXECUTE before SECURITY DEFINER''s own RLS-bypass ever comes into play.';


create or replace function app_private.signature_request_signer_upload_allowed(
  p_signer_id uuid,
  p_company_id uuid
) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.signature_request_signers s
      join public.signature_requests r on r.id = s.request_id
     where s.id = p_signer_id
       and s.company_id = p_company_id
       and s.status = 'pending'
       and r.status = 'sent'
  );
$$;

revoke all on function app_private.signature_request_signer_upload_allowed(uuid, uuid) from public;
grant execute on function app_private.signature_request_signer_upload_allowed(uuid, uuid) to anon, authenticated;

comment on function app_private.signature_request_signer_upload_allowed(uuid, uuid) is
  '0660: SECURITY DEFINER check backing documents_bucket_write_signer_token_anon / documents_bucket_delete_signer_token_anon (storage.objects) — bypasses signature_request_signers/signature_requests'' own authenticated-only RLS for the same reason as signature_request_source_doc_visible above, and granted to anon/authenticated for the same call-permission reason (see that function''s comment). Still does not check the caller''s actual access_token (storage RLS cannot see it — see 0575 migration header); record_signed_document_by_token remains the only place that check happens.';


drop policy documents_bucket_read_signature_request_anon on storage.objects;
create policy documents_bucket_read_signature_request_anon on storage.objects
  for select to anon
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[2] = 'signature_request'
    and app_private.signature_request_source_doc_visible(
          ((storage.foldername(name))[3])::uuid,
          ((storage.foldername(name))[1])::uuid
        )
  );

drop policy documents_bucket_write_signer_token_anon on storage.objects;
create policy documents_bucket_write_signer_token_anon on storage.objects
  for insert to anon
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[2] = 'signature_request_signer'
    and app_private.signature_request_signer_upload_allowed(
          ((storage.foldername(name))[3])::uuid,
          ((storage.foldername(name))[1])::uuid
        )
  );

drop policy documents_bucket_delete_signer_token_anon on storage.objects;
create policy documents_bucket_delete_signer_token_anon on storage.objects
  for delete to anon
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[2] = 'signature_request_signer'
    and app_private.signature_request_signer_upload_allowed(
          ((storage.foldername(name))[3])::uuid,
          ((storage.foldername(name))[1])::uuid
        )
  );

comment on policy documents_bucket_read_signature_request_anon on storage.objects is
  '0575, fixed by 0660: lets an anon caller (the public /sign/[token] page) download a signature request''s SOURCE document (entity_type=signature_request only) while the request is sent or completed. Gated on the object path alone via a SECURITY DEFINER lookup (app_private.signature_request_source_doc_visible), not the caller''s token — storage RLS cannot see it. See 0575 migration header for why the path itself is the effective secret.';

comment on policy documents_bucket_write_signer_token_anon on storage.objects is
  '0575, fixed by 0660: lets an anon caller upload bytes into a specific PENDING signer''s own folder on a SENT request, via app_private.signature_request_signer_upload_allowed (SECURITY DEFINER). Uploading here alone changes nothing — only record_signed_document_by_token (which does check the real access_token) can turn this into a recorded signature.';

create policy documents_bucket_read_signer_token_anon on storage.objects
  for select to anon
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[2] = 'signature_request_signer'
    and app_private.signature_request_signer_upload_allowed(
          ((storage.foldername(name))[3])::uuid,
          ((storage.foldername(name))[1])::uuid
        )
  );

comment on policy documents_bucket_read_signer_token_anon on storage.objects is
  '0660: lets an anon caller read back an object it just uploaded into a PENDING signer''s own folder — needed because Storage''s single-object DELETE resolves via a read first, and the ExternalSignerView.tsx cleanup path (an uploaded-but-then-rejected-by-record_signed_document_by_token file) needs to remove it. Same allowed() check as the write/delete policies, so this stops matching the instant the signer''s status leaves ''pending'' (signed, declined, or the request itself leaves ''sent'') — it is not a standing "re-download your signed copy" capability (deliberately out of scope, see 0575 migration header).';
