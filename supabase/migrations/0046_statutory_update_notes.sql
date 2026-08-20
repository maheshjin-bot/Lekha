-- ============================================================================
-- 0046 — Statutory update review log
-- ============================================================================
-- Closes a gap flagged since P0: the "rules as data" principle (rates and
-- thresholds live in ref_* tables, not hardcoded in application code) has
-- been real since the first migration, but there has never been anywhere
-- to track WHEN a rate changed, WHY, or on WHOSE authority — every
-- correction this session (TDS/TCS sections, income tax slabs, ESI/PF
-- figures) has lived only in a migration file's own comment, with no
-- structured, queryable trail across all of them together.
--
-- DELIBERATELY NOT AN AUTO-APPLY SYSTEM. Researched how Avalara, Vertex,
-- Stripe Tax, Sovos, Anrok, TaxJar, ClearTax, Zoho, Tally and Busy each
-- handle statutory rate changes — none of them let a user self-apply a
-- rate/rule edit through the product; the vendor (or, for Tally/Busy, the
-- admin editing a master) stays the sole source of truth, and the closest
-- precedent for a staged "here's what's coming, here's the citation, here's
-- when" pattern is Zoho Books' preview-then-schedule banner and Tally's
-- own per-item rate-history view. Building a generic engine that runs
-- arbitrary UPDATEs against ref_* tables from user-submitted values would
-- be a real integrity and security surface for comparatively little value
-- — the actual rate change still belongs in a reviewed, tested migration
-- (exactly how every rate table in this schema has been built so far).
-- This is the missing PAPER TRAIL that precedes that migration, not a
-- replacement for it: log the change, its citation, and its effective
-- date; mark it applied — with a free-text pointer to the migration that
-- actually did it — once that migration lands.
--
-- NOT COMPANY-SCOPED. Every ref_* table this would track (TDS/TCS
-- sections, income tax slabs, GST rates, depreciation blocks, ESI/PF
-- figures) is global, shared by every tenant company on this platform —
-- there is no meaningful sense in which one company's admin "owns" a
-- proposal to change the national TDS rate table, so this does not gate
-- on company_id or app_private.is_company_admin at all. LEKHA has no
-- platform-operator role separate from company membership yet, and
-- inventing one for this alone would be real scope creep for a low-stakes
-- log (it grants no write access to any rate table); every authenticated
-- user can read and write it, the same trust level already extended to
-- every world-readable ref_* table itself.
-- ============================================================================

create table public.statutory_update_notes (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  area text not null check (area in (
    'gst', 'tds', 'tcs', 'income_tax', 'pf_esi_pt', 'companies_act', 'other'
  )),
  description text not null check (length(trim(description)) > 0),
  citation_text text,
  citation_url text,
  effective_date date not null,
  status text not null default 'proposed' check (status in (
    'proposed', 'confirmed', 'applied', 'rejected'
  )),
  applied_note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index statutory_update_notes_status_idx
  on public.statutory_update_notes(status, effective_date desc);

create trigger set_updated_at before update on public.statutory_update_notes
  for each row execute function app_private.set_updated_at();

comment on table public.statutory_update_notes is
  'Audit trail for statutory rate/rule changes across every ref_* table this app maintains — not itself a rate table, and does not write to one. proposed: logged, not yet verified. confirmed: verified against the citation, ready to build. applied: the underlying ref_* table has actually been updated (applied_note should say which migration). rejected: turned out not to apply, or was superseded. Global, not company-scoped — every ref_* table this tracks is shared by every tenant.';

-- ----------------------------------------------------------------------------
-- Row level security — read/write open to any authenticated user, same
-- trust level as the world-readable ref_* tables themselves. No company_id
-- to scope by; see the migration header for why.
-- ----------------------------------------------------------------------------
alter table public.statutory_update_notes enable row level security;

create policy statutory_update_notes_read on public.statutory_update_notes
  for select to authenticated using (true);
create policy statutory_update_notes_write on public.statutory_update_notes
  for all to authenticated using (true) with check (true);
