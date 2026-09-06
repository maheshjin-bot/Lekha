-- ============================================================================
-- 1842 — Attaching a document to a meeting has never worked: 'meeting' was
-- missing from documents_entity_type_check
-- ============================================================================
-- RECONCILIATION NOTE. This exact fix (originally authored as migration 1430
-- in a different, unmerged worktree) was already applied directly to the
-- shared live database — confirmed by reading documents_entity_type_check's
-- live definition, which already includes 'meeting' alongside the other
-- eight values. 1430 itself is taken on main by an unrelated migration
-- (1430_salary_tds_estimate_projects_from_joining_date.sql), so this file
-- exists only to give the already-applied change a real migration file in
-- git — a fresh clone or `supabase migration list` should not disagree with
-- what the shared database actually has. The drop-and-recreate below is a
-- harmless no-op against the live schema (same constraint, same values).
-- ============================================================================
--
-- CONFIRMED LIVE before writing this:
--
--   * components/meetings/MeetingManager.tsx:319 renders the shared
--     attachment widget with entityType="meeting", and
--     components/documents/DocumentAttachments.tsx:74 writes that value
--     straight into public.documents.entity_type.
--   * The live constraint does not allow it:
--       CHECK (entity_type = ANY (ARRAY['voucher','notice','fixed_asset',
--         'ledger','company','other','signature_request',
--         'signature_request_signer']))
--     — no 'meeting'. So every single attempt to attach minutes, a notice
--     of meeting, or an attendance sheet to a board meeting or AGM has
--     failed with a raw check-constraint violation, for as long as the
--     Meetings screen has existed.
--   * DocumentAttachments takes entityType as a plain `string` prop
--     (line 39), so nothing in TypeScript could have caught the mismatch —
--     which is why it shipped. The three live call sites are 'meeting'
--     (MeetingManager:319), 'notice' (NoticeManager:329) and
--     'signature_request' (SignatureRequestManager:430); only 'meeting'
--     was missing from the constraint. Checked all three, not just the
--     broken one.
--
-- WHY THIS MATTERS BEYOND A FAILED UPLOAD. The meeting register exists to
-- support the statutory registers a company has to keep: Sec 118 requires
-- minutes of every board and general meeting, and AOC-4/MGT-7 are prepared
-- from what those meetings resolved. The minutes are the primary evidence,
-- and this is the one place in the app built to hold them.
--
-- SHAPE OF THE FIX. Same drop-and-recreate 0175 used to add its own two
-- values (see 0175 lines 130-137), with the full list restated — a CHECK
-- constraint cannot be extended in place. Deliberately adds ONLY 'meeting':
-- the other five entity types a reader might expect (employee, item,
-- branch, order, employee_document) have no attachment UI pointing at them
-- today, and inventing allowed values for call sites that do not exist
-- would just move the guesswork. 'other' already exists as the escape
-- hatch for anything genuinely ad hoc.
--
-- NOT ADDRESSED HERE, deliberately: DocumentAttachments.entityType stays a
-- `string` rather than a union type. Narrowing it is the real structural
-- fix — it would have turned this into a compile error instead of a
-- runtime one — but that prop is threaded through several screens owned by
-- other work in flight, so it is left as its own follow-up rather than
-- touched from a migration whose job is to unbreak the upload today.
-- ============================================================================

alter table public.documents
  drop constraint documents_entity_type_check;

alter table public.documents
  add constraint documents_entity_type_check check (entity_type in
    ('voucher','notice','fixed_asset','ledger','company','other',
     'signature_request','signature_request_signer','meeting'));

comment on constraint documents_entity_type_check on public.documents is
  'signature_request = the document(s) routed for signature (entity_id = signature_requests.id); signature_request_signer = one signer''s signed-back copy (entity_id = signature_request_signers.id). Added by 0175. meeting = minutes / notice of meeting / attendance sheet for one board or general meeting (entity_id = meetings.id) — the Meetings screen has passed this value since it shipped, but the constraint did not allow it until 1842 (this file records a change that was already applied live by an earlier, unmerged session; see the file header).';
