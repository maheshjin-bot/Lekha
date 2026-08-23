-- ============================================================================
-- 0095 — Filing register: what has actually been filed, across every statute
-- ============================================================================
-- get_compliance_calendar (0024, extended by 0062/0084/0087/0094) computes
-- every upcoming/overdue due date from generate_series and reads nothing back
-- from anywhere else. It persists nothing. A GSTR-3B filed on time on the 18th
-- keeps showing as a reminder for the rest of the month, and once its due date
-- rolls into the past it starts showing as OVERDUE forever — the function has
-- no way to know the return was ever filed at all. That function is off limits
-- to this migration (owned by the integration pass), so this does not fix
-- that. What it builds is the table a future pass would need to fix it: one
-- durable row per (company, form, period) recording whether that specific
-- filing actually happened, when, and under what acknowledgement.
--
-- SCOPE: GST returns, TDS/TCS returns, ROC forms and income tax filings — the
-- four statute families get_compliance_calendar already computes dates for —
-- plus PF/ESI (0084) and, deliberately, anything else a business actually
-- files. See FORM_CODE IS NOT AN ENUM below for why "anything else" matters.
--
-- FORM_CODE IS NOT AN ENUM, ON PURPOSE. Three reasons, not one:
--   1. get_compliance_calendar's own `label` column is not a clean form
--      code — GST rows read 'GSTR-3B — 07ABCPS1234D1Z3', with the GSTIN
--      concatenated in, because the calendar has no separate column for it
--      (see the caveat below on what a join would need). Copying that shape
--      into a CHECK constraint would bake in a formatting accident.
--   2. A real filing register needs to record filings the calendar does not
--      compute at all — GSTR-9 (annual return), GSTR-4 (composition),
--      ITC-04 (job work, see 0084's itc-04-prep report), 15CA/15CB (foreign
--      remittance) and more. Restricting form_code to only what the
--      calendar's formula currently covers would make this table unable to
--      record filings this app already has other features for.
--   3. The calendar itself will keep growing (it already has five migrations
--      behind it: 0024, 0062, 0084, 0087, 0094). An enum here would need a
--      new migration every time that one gains a form; free text with
--      UI-level suggestions does not.
-- The app's dropdown (components/filing-register/FilingRegisterManager.tsx)
-- is seeded from the exact set of labels get_compliance_calendar computes
-- today — read from pg_proc.prosrc via sbq, not recalled from training data,
-- since 0024's header is explicit that recollection is wrong on Indian
-- statutory form names as often as it is right (24Q/26Q/27EQ were renumbered
-- 138/140/143 by the Income-tax Act 2025, and the calendar's own comments
-- already carry that renaming) — plus a free-text field for anything the
-- calendar does not compute. Both write to the same unconstrained column.
--
-- GST_REGISTRATION_ID IS NULLABLE BECAUSE MOST FORMS AREN'T GST FORMS. A
-- GSTR-1/GSTR-3B filing belongs to one specific GSTIN and a company can hold
-- several (gst_registrations has no per-company cardinality limit) — the
-- composite FK below (gst_registration_id, company_id) references
-- gst_registrations(id, company_id), the same tenant-safety pattern 0090's
-- tax_ledger_map and 0085's employees.branch_id use, so a write can never
-- attach a filing to another tenant's registration even though RLS only
-- filters reads. TDS returns, ROC forms, ITR and PF/ESI have no GSTIN to
-- pick, so it is simply left null for those — there is no meaningful default.
--
-- PERIOD_LABEL IS TEXT, NOT A DATE, BECAUSE THE GRAIN GENUINELY DIFFERS BY
-- FORM. GSTR-1/3B file monthly or quarterly depending on gr.filing_frequency;
-- TDS/TCS returns file quarterly; ITR/AOC-4/MGT-7/DPT-3/DIR-3 KYC file once a
-- financial year; MSME Form-1 and ESI's Return of Contribution file
-- half-yearly on two DIFFERENT six-month splits (Apr-Sep/Oct-Mar for MSME-1,
-- but ESI's own halves land on 11 Nov/12 May, 42 days after each half closes
-- — see 0084). No single date column represents all of that without lying
-- about the grain, so this mirrors what the calendar's own `detail` column
-- already does: free text ("Aug 2026", "2026-27 Q1", "FY 2025-26").
--
-- CONSEQUENCE, STATED RATHER THAN HIDDEN: because period_label is free text,
-- "most recent period first" in the UI cannot be computed by sorting the
-- label. get_filing_register (below) sorts by form_code, then filed_date
-- descending (nulls — i.e. not-yet-filed rows — first, so open work surfaces
-- above history), then created_at descending as the final tiebreak. That is
-- recency of DATA ENTRY for anything not yet filed, not recency of the
-- statutory period; a person who backfills old periods out of order will see
-- them out of period order too. A structured period (year + month/quarter
-- number) would fix this properly and is a reasonable follow-on, not built
-- here because the task specifies period_label as the free-text grain the
-- form itself files at, matching the calendar's own `detail` shape.
--
-- STATUS IS A SEPARATE SIGNAL FROM FILED_DATE, NOT REDUNDANT WITH IT. Three
-- states: 'pending' (still to file), 'filed' (done), 'not_applicable' (this
-- form does not apply to this company for this period — e.g. a GSTR-3B
-- period before a GST registration existed, or a NIL-supply period a
-- business has decided not to track here). filed_date is required if and
-- only if status = 'filed' (enforced by CHECK below) — a pending or n/a row
-- cannot carry a filed date, and a filed row cannot omit one. This is the
-- one place this table validates internal consistency; it does not validate
-- against the calendar's own idea of what SHOULD have been filed, because
-- reading that would mean querying the off-limits function from a table
-- migration, which is a layering inversion this task deliberately avoids.
--
-- WHAT THIS DELIBERATELY DOES NOT DO:
--   * Does not suppress or alter a single row of get_compliance_calendar's
--     output. That function is unmodified by this migration. See CAVEATS in
--     the accompanying report for exactly what a future LEFT JOIN would need.
--   * Does not link to tax_payments (0079), which already records the CASH
--     side of a statutory obligation (challans: BSR code, CIN, PMT-06
--     reference). Filing and paying are legally distinct acts — a return can
--     be filed with nothing owed, and a challan can be paid before the
--     return that reports it is filed — and this table does not assume one
--     implies the other. A future feature could add a nullable FK from here
--     to tax_payments once both sides have enough live data to make the
--     link meaningful; inventing that link speculatively now would be
--     guessing at a relationship neither table's real usage has tested yet.
--   * Does not verify an acknowledgement_number's format. ARN (GST), SRN
--     (MCA) and the income-tax acknowledgement number are three unrelated
--     formats from three unrelated portals; validating one and not the
--     others would be worse than validating none, the same call 0085 made
--     for PF/PT registration numbers.
--   * Generates nothing — no XML, no JSON upload, no portal API call. This
--     is a log a business keeps of what it already filed elsewhere.
-- ============================================================================

create table public.filing_register (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  -- Free text with app-level suggestions, not an enum — see FORM_CODE IS NOT
  -- AN ENUM above.
  form_code text not null check (length(btrim(form_code)) > 0),

  -- Only meaningful for GST forms (GSTR-1, GSTR-3B, ...) — null for
  -- everything else. Composite FK so a write can never attach a filing to a
  -- GST registration belonging to a different company; see the migration
  -- header.
  gst_registration_id uuid,

  -- The period this specific filing covers, at whatever grain the form
  -- files at — see PERIOD_LABEL IS TEXT above.
  period_label text not null check (length(btrim(period_label)) > 0),

  -- Null = not yet filed. Required exactly when status = 'filed' (CHECK
  -- below).
  filed_date date,

  -- ARN / SRN / income-tax acknowledgement number, whichever the portal that
  -- accepted this filing issued. Format deliberately unvalidated — see the
  -- migration header.
  acknowledgement_number text,

  fee_paid numeric(14, 2) not null default 0 check (fee_paid >= 0),
  additional_fee numeric(14, 2) not null default 0 check (additional_fee >= 0),

  status text not null default 'pending'
    check (status in ('pending', 'filed', 'not_applicable')),

  notes text,

  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- filed_date and status must agree with each other in both directions —
  -- see STATUS IS A SEPARATE SIGNAL above.
  constraint filing_register_filed_date_matches_status check (
    (status = 'filed') = (filed_date is not null)
  )
);

-- Composite FK, not a bare id reference — see the migration header and
-- 0085/0090 for why a plain `references gst_registrations(id)` would let a
-- write silently attach this row to a GST registration in a different
-- tenant's company (RLS filters SELECT, never INSERT/UPDATE).
alter table public.filing_register
  add constraint filing_register_gst_registration_id_company_id_fkey
  foreign key (gst_registration_id, company_id)
  references public.gst_registrations (id, company_id)
  on delete set null;

-- The same (company, form, period) cannot be recorded twice by accident.
-- Three things make this more than a plain UNIQUE(...) on the raw columns:
--   * form_code/period_label are compared case- and whitespace-insensitively
--     (upper + btrim) so "GSTR-3B" and "gstr-3b " do not slip past each
--     other as different rows — the dropdown always writes one canonical
--     case, but the field is free text and a hand-typed entry should not be
--     able to create a silent duplicate the UI would then never show
--     together.
--   * gst_registration_id is folded through COALESCE to a fixed nil-UUID
--     sentinel. Plain multi-column UNIQUE constraints treat NULL as
--     distinct from every other NULL (including itself), so two rows that
--     are both "GSTR-3B / Aug 2026 / no registration" would NOT collide
--     under an ordinary UNIQUE(company_id, form_code, period_label,
--     gst_registration_id) — exactly the case for every non-GST form, which
--     is most of them. The sentinel makes "no registration" a single
--     comparable value instead of an ever-distinct NULL.
--   * Folding gst_registration_id in at all (rather than leaving it out of
--     the key) is what lets a company with two GSTINs record GSTR-3B for
--     the same calendar period against each registration as two separate,
--     legitimate rows — leaving it out would have made the second one an
--     accidental duplicate.
create unique index filing_register_company_form_period_key
  on public.filing_register (
    company_id,
    upper(btrim(form_code)),
    upper(btrim(period_label)),
    coalesce(gst_registration_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create index filing_register_company_form_idx
  on public.filing_register (company_id, form_code);
create index filing_register_gst_registration_idx
  on public.filing_register (gst_registration_id)
  where gst_registration_id is not null;

create trigger set_updated_at before update on public.filing_register
  for each row execute function app_private.set_updated_at();

alter table public.filing_register enable row level security;

-- Read for any member of the company; write for anyone with write access —
-- filing status is operational record-keeping, not salary/admin-sensitive
-- data, so this follows the meetings (0092) / notices (0059) precedent
-- rather than the is_company_admin one.
create policy filing_register_read on public.filing_register
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));
create policy filing_register_write on public.filing_register
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.filing_register is
  'What has actually been filed, per (company, form, period) — GST returns, TDS/TCS returns, ROC forms, income tax filings, PF/ESI, and anything else a business files, whether or not get_compliance_calendar (0024/0062/0084/0087/0094) computes a due date for it. That function still persists nothing and is unmodified by this table — a filed period keeps showing as a reminder there until a future pass joins the two. See 0095 for the full design and the caveats on what that join would need.';

comment on column public.filing_register.form_code is
  'Free text, not an enum — see 0095''s FORM_CODE IS NOT AN ENUM. App UI suggests values drawn from get_compliance_calendar''s own current labels plus common forms the calendar does not compute (GSTR-9, ITC-04, ...).';

comment on column public.filing_register.gst_registration_id is
  'Which GSTIN this filing belongs to — meaningful only for GST forms (GSTR-1, GSTR-3B, ...), null for everything else. Composite FK with company_id so a write cannot cross tenants.';

comment on column public.filing_register.period_label is
  'The statutory period this filing covers, at whatever grain the form files at (e.g. "Aug 2026", "2026-27 Q1", "FY 2025-26") — see 0095 for why this is text and what it costs the "most recent first" ordering.';

comment on column public.filing_register.status is
  'pending = not yet filed, filed = done (filed_date required), not_applicable = this form/period does not apply to this company. filed_date is required exactly when status = filed — enforced by filing_register_filed_date_matches_status.';

-- ----------------------------------------------------------------------------
-- get_filing_register(company) — read, with the form_code grouping the UI
-- wants computed once here rather than in the client.
-- ----------------------------------------------------------------------------
create or replace function public.get_filing_register(
  p_company_id uuid
) returns table (
  id uuid,
  form_code text,
  gst_registration_id uuid,
  gstin text,
  period_label text,
  filed_date date,
  acknowledgement_number text,
  fee_paid numeric,
  additional_fee numeric,
  status text,
  notes text,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    fr.id, fr.form_code, fr.gst_registration_id, gr.gstin,
    fr.period_label, fr.filed_date, fr.acknowledgement_number,
    fr.fee_paid, fr.additional_fee, fr.status, fr.notes, fr.created_at
  from public.filing_register fr
  left join public.gst_registrations gr on gr.id = fr.gst_registration_id
 where fr.company_id = p_company_id
 order by fr.form_code, fr.filed_date desc nulls first, fr.created_at desc;
$$;

revoke all on function public.get_filing_register(uuid) from public, anon;
grant execute on function public.get_filing_register(uuid) to authenticated;

comment on function public.get_filing_register is
  'Every filing_register row for a company, with the GSTIN resolved for display, ordered form_code then filed_date desc nulls first (open/pending rows surface above history within a form) then created_at desc. See 0095 for why period_label itself cannot be the sort key.';
