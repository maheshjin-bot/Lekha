-- ============================================================================
-- 0125 — Print template customization: logo, terms & conditions, footer note
-- ============================================================================
-- Prerequisite for emailing an invoice, attaching one to a document record, or
-- building a batch filing pack: the print layout
-- (app/(app)/[companyId]/vouchers/[voucherId]/print/page.tsx) currently has no
-- way to carry a company's own branding or standard fine print. Confirmed live
-- before writing this migration — a grep across supabase/migrations for
-- "logo" and a column listing of public.companies both come back empty, and
-- there is no template/terms/footer table anywhere in the schema:
--   select column_name from information_schema.columns
--     where table_schema='public' and table_name='companies'
--     and column_name in ('logo_url','print_terms_and_conditions','print_footer_note');
--   -> []
--
-- THREE PLAIN COLUMNS, NOT A NEW TABLE. All three are one-per-company,
-- overwrite-in-place settings — the same shape as upi_vpa (0111) or the four
-- employer-registration columns (0085) — not a versioned or per-voucher-type
-- template system. If per-voucher-type or multi-template needs show up later,
-- that is a genuinely new feature to design then, not something to
-- over-build here speculatively.
--
-- logo_url DOES NOT HOLD A PUBLIC URL. Per this task's own instruction to
-- reuse 0060's Storage bucket pattern rather than invent a new upload
-- mechanism: it holds a PATH inside the existing private 'documents' bucket
-- (e.g. "<company_id>/company-logo/<uuid>-<filename>.png"), not a public
-- link. That bucket's RLS (documents_bucket_read / documents_bucket_write,
-- 0060) already grants read/write to any member/writer of the company named
-- in the path's first folder segment — verified live below — which is
-- exactly the audience that should be able to see or replace a company's
-- print logo, so NO new storage.objects policy is added here; the existing
-- ones already cover an object at this path regardless of what sits in the
-- second folder segment (0060's RLS checks only element 1, company_id). The
-- 'documents' metadata table (0060) is deliberately NOT used to track the
-- logo file itself — that table models a *list* of attachments per entity,
-- one company logo is a *singleton* the company row already has a natural
-- slot for, and PrintTemplateForm (client) deletes the previous storage
-- object itself when a new logo replaces it, so nothing is orphaned without
-- a documents-table row to enumerate it.
--
-- Because the bucket is private, the print page and the PDF export route
-- (this feature's other half) both resolve logo_url to bytes via an
-- authenticated `storage.download()` call and inline them as a base64 data:
-- URI at render time, rather than link to a signed URL. This is deliberate,
-- not incidental: the server-side PDF route drives a headless-Chromium
-- render of the SAME print page, and a signed URL (60s default expiry
-- elsewhere in this codebase) would be a race against however long that
-- render takes, whereas a data: URI embedded straight into the HTML has no
-- expiry to race.
--
-- print_terms_and_conditions / print_footer_note are plain text — standard
-- boilerplate ("Goods once sold...", bank details, a thank-you line) a
-- business wants on every invoice without retyping it. Nothing here is a
-- statutory field: Rule 46 CGST Rules, 2017 (tax invoice particulars) does
-- not require or forbid a free-text terms/footer block, so this is
-- deliberately unvalidated, unbounded-format prose, gated only by a generous
-- length cap against pathological input.
--
-- COLUMN-LEVEL GRANTS — THE MISTAKE THIS APP HAS ALREADY MADE TWICE. 0044
-- locked public.companies to an explicit per-column SELECT/UPDATE allowlist
-- for `authenticated`; 0085 added four columns without extending it (a real,
-- live 42501 bug, fixed by 0112); 0111 remembered for upi_vpa. Confirmed
-- live, again, before writing this migration:
--   select grantee, privilege_type, string_agg(column_name, ', ')
--     from information_schema.column_privileges
--     where table_schema='public' and table_name='companies'
--       and grantee='authenticated' group by 1,2;
--   -> logo_url / print_terms_and_conditions / print_footer_note are absent
--      from all three privilege_type rows (SELECT/UPDATE/INSERT), as
--      expected for columns that don't exist yet. The two GRANT statements
--      below are what stop this feature joining that list a third time.
-- ============================================================================

alter table public.companies
  add column if not exists logo_url text,
  add column if not exists print_terms_and_conditions text
    check (print_terms_and_conditions is null or length(print_terms_and_conditions) <= 4000),
  add column if not exists print_footer_note text
    check (print_footer_note is null or length(print_footer_note) <= 1000);

comment on column public.companies.logo_url is
  'Storage PATH (not a public URL) of this company''s print/invoice logo, inside the private "documents" bucket (0060) — e.g. "<company_id>/company-logo/<uuid>-<name>.png". Resolved to a data: URI server-side (storage.download + base64) by the invoice print page and PDF export route, both of which need the bytes inline rather than a link. Null when no logo is set. See 0125.';

comment on column public.companies.print_terms_and_conditions is
  'Free-text terms & conditions block printed under the invoice total on the sales/purchase print layout (e.g. return policy, bank details). Not a statutory field — Rule 46 CGST Rules, 2017 neither requires nor forbids it. Length-capped at 4000 chars against pathological input, otherwise unvalidated prose. See 0125.';

comment on column public.companies.print_footer_note is
  'Free-text footer line printed at the very bottom of the invoice print layout (e.g. "Thank you for your business", a tagline). Length-capped at 1000 chars. See 0125.';

-- No new RLS policy needed: companies_read (member-gated) and companies_update
-- (admin-gated, app_private.is_company_admin) already exist from 0003 and
-- apply to a new column on an existing table automatically — RLS is row-
-- level. Only the column-level GRANT below is new work.
grant select (logo_url, print_terms_and_conditions, print_footer_note)
  on public.companies to authenticated;

grant update (logo_url, print_terms_and_conditions, print_footer_note)
  on public.companies to authenticated;
