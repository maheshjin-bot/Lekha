-- ============================================================================
-- 0060 — Document management: attachments on any record
-- ============================================================================
-- The `documents` module (0004) has been registered since day one — optional,
-- code "Document management", with its own hint text "Attachments on
-- vouchers" — and zero code behind it, the same shape of gap 0024 closed for
-- compliance_calendar and 0059 closed for notices.
--
-- ENTITY-GENERIC BY DESIGN, WIRED FIRST INTO NOTICES. The `documents` table
-- carries (entity_type, entity_id) rather than a dedicated voucher_id or
-- notice_id column, so the same table and the same
-- <DocumentAttachments/> component serve vouchers, fixed assets, ledgers or
-- notices without a schema change per entity type. It is wired into the
-- Notices screen first (attach the actual scanned notice) rather than
-- vouchers, despite the module's own hint text — the voucher entry/detail
-- pages are a concurrent session's in-flight, uncommitted work in this
-- shared tree; attaching there is a follow-up once those files settle, not a
-- reason to leave the underlying capability unbuilt in the meantime.
--
-- STORAGE, NOT A BYTEA COLUMN. A Postgres row is the wrong place for a PDF —
-- it bloats every backup and every read of an unrelated column on the same
-- page. A private Storage bucket ('documents', not public, 10MB cap,
-- PDF/PNG/JPEG/WebP only) holds the bytes; this table holds the metadata and
-- is what RLS and the UI actually query. Bucket created directly via
-- storage.buckets (a plain Postgres table Supabase Storage reads at request
-- time) since project-level bucket creation is a Storage API operation, not
-- something the Management API's platform endpoints expose.
--
-- STORAGE PATH IS THE TENANCY BOUNDARY: 'company_id/entity_type/entity_id/
-- uuid-filename'. storage.foldername(name) splits that into an array, and
-- the RLS policies on storage.objects below check element 1 (company_id)
-- against the exact same app_private.is_company_member / can_write_company
-- helpers every other tenant table in this schema already uses — a file
-- gets the identical access rule as the row that describes it, not a
-- parallel one that could drift.
--
-- DELETING A COMPANY MUST ALSO DELETE ITS FILES. documents.company_id
-- cascades via FK like every other tenant table, but storage.objects has NO
-- foreign key relationship to public.companies at all — a plain DELETE FROM
-- companies would leave orphaned files in the bucket forever, invisible to
-- every RLS policy (since nothing would list them) but still occupying
-- storage. delete_company (0010) is extended to remove them explicitly,
-- by folder prefix, before the company row itself goes.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- documents
-- ----------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  entity_type text not null check (entity_type in
    ('voucher','notice','fixed_asset','ledger','company','other')),
  -- Nullable: a company-level document (e.g. a GST certificate, not tied to
  -- any one voucher or ledger) has no entity to point at.
  entity_id uuid,
  storage_path text not null unique,
  file_name text not null check (length(trim(file_name)) > 0),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index documents_company_entity_idx on public.documents(company_id, entity_type, entity_id);

alter table public.documents enable row level security;

create policy documents_read on public.documents
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy documents_write on public.documents
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.documents is
  'Metadata for files in the "documents" storage bucket. entity_type/entity_id let one table and one UI component serve attachments on any record; entity_id is null for a company-level document with no single owning row. The actual bytes live in Storage, not here — storage_path is the join key, and RLS on storage.objects (below) enforces the same tenancy boundary independently.';


-- ----------------------------------------------------------------------------
-- Storage RLS — the 'documents' bucket, path = company_id/entity_type/entity_id/filename
-- ----------------------------------------------------------------------------
create policy documents_bucket_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (select app_private.is_company_member((storage.foldername(name))[1]::uuid))
  );

create policy documents_bucket_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (select app_private.can_write_company((storage.foldername(name))[1]::uuid))
  );

create policy documents_bucket_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and (select app_private.can_write_company((storage.foldername(name))[1]::uuid))
  );

comment on policy documents_bucket_read on storage.objects is
  'documents bucket: readable by any member of the company named in the path''s first folder segment.';


-- ----------------------------------------------------------------------------
-- delete_company: also remove this company's files from storage
-- ----------------------------------------------------------------------------
-- Same signature, so this is a straight CREATE OR REPLACE — no DROP FUNCTION
-- needed (the ambiguous-overload trap only bites when the signature itself
-- changes, which it does not here).
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
  'Deletes a company and everything under it, in FK-safe order: vouchers before ledgers (entries hold the references), storage.objects under this company''s folder prefix (no FK to companies — see 0060), then the company row itself (cascades account groups/branches/registrations/members/invites/modules/tax_ledger_map/documents), then the audit trail (deliberately no FK, so it does not cascade).';
