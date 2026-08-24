-- ============================================================================
-- 0117 — DSC (Digital Signature Certificate) register
-- ============================================================================
-- Contingent on the director/KMP master (0088) and the filing register
-- (0095), both read live before writing this. Every ROC form (0062),
-- GSTR-1/3B, and most income-tax filings this app tracks the due dates for
-- (get_compliance_calendar, 0024/0062/0084/0087/0094) is actually SIGNED
-- with a DSC on the respective portal — the certificate that makes the
-- filing legally attributable to a person. This app had nowhere to record
-- which DSCs exist, who holds them, or when they lapse; a lapsed DSC found
-- only when a filing bounces at deadline is exactly the kind of thing this
-- codebase's compliance-calendar/filing-register features exist to prevent
-- for OTHER dates, and DSC expiry had no equivalent at all.
--
-- WHICH DSC CLASS — RESEARCHED LIVE (WebSearch, Aug 2026), with a genuine
-- conflict between sources that is stated rather than papered over. Every
-- practitioner/vendor source checked (ClearTax, eBizFiling, CAonWeb,
-- multiple licensed-CA vendor sites, all independently) agrees on the same
-- specific fact: CCA guidelines dated 26 Nov 2020 discontinued Class 2
-- issuance effective 1 Jan 2021, folding it into Class 3 — from that date
-- Class 3 alone is issued and is what MCA/ROC filings, income-tax e-filing,
-- GST, EPFO, e-tendering, and audit reports all require, for individuals
-- and organisations alike. A skeptical second pass fetched CCA's own
-- (cca.gov.in) "classes_of_certificates.html" page directly: that page
-- STILL defines Class 1/Class 2/Class 3 as a structural framework and does
-- NOT itself say Class 2 is discontinued, and CCA's gazette-notification
-- archive at the same domain lists no notification withdrawing Class 2 by
-- name either. Read together, the more likely explanation is that CCA's
-- reference page documents the IT Act certificate-class definitions as a
-- framework (which still technically exist) while the OPERATIONAL
-- instruction to licensed CAs — confirmed identically by many independent
-- downstream sources citing the same Nov-2020 date — is to stop issuing
-- Class 2 and supply Class 3 for everything Class 2 used to cover. Since
-- Class 2's own maximum validity is 3 years, any Class 2 certificate still
-- validly issued before Jan 2021 would have already lapsed by Aug 2026
-- regardless. dsc_class is therefore free text (same reasoning as 0095's
-- form_code — a classification that has already consolidated once could
-- do so again, and a CHECK enum would need a migration each time), but
-- defaults to 'Class 3' as the one class a new DSC entered today actually
-- needs, rather than presenting Class 2/Class 3 as a live, current choice.
--
-- HOLDER IS NOT ALWAYS A DIRECTOR. A DSC signs filings; company_directors
-- (0088) is who runs the company. The two overlap heavily — an MD signing
-- their own ROC filings — but a company's GST returns are routinely signed
-- by a practising CA/tax consultant holding a DSC in their own name, never
-- appointed to the board at all. holder_director_id is therefore a
-- NULLABLE composite FK (this schema's tenancy convention, see AGENTS.md)
-- to company_directors, and holder_name is free text for the non-director
-- case — exactly one of the two identifies the holder (CHECK below), not
-- both required and not both optional.
--
-- WHY NO MODULE GATE. Same reasoning 0088 gave for company_directors: this
-- is a plain record of a fact (who holds what certificate, valid when),
-- not a posting/filing action gated on a module being switched on. Every
-- company can have DSCs on file regardless of which optional modules are
-- active.
-- ============================================================================

create table public.digital_signature_certificates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  -- Nullable, composite FK — a DSC holder is OFTEN but not always a
  -- director/KMP on record. See migration header.
  holder_director_id uuid,
  -- Free text for a non-director signatory (a practising CA, an outsourced
  -- compliance consultant, etc). Exactly one of holder_director_id /
  -- holder_name identifies the person — enforced below.
  holder_name text,

  certifying_authority text not null check (length(btrim(certifying_authority)) > 0),

  -- Free text, not an enum — see migration header. Defaults to the single
  -- class actually issued today.
  dsc_class text not null default 'Class 3' check (length(btrim(dsc_class)) > 0),

  valid_from date not null,
  valid_to date not null,

  -- Vendor-assigned token/USB-dongle serial, whichever the issuing CA's
  -- hardware carries. Format is not standardised across CAs (eMudhra, Sify,
  -- NSDL, Capricorn all print their own scheme) — deliberately unvalidated,
  -- same call 0095 made for acknowledgement_number.
  token_serial_number text,

  notes text,

  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (holder_director_id, company_id) references public.company_directors (id, company_id),

  check (valid_to >= valid_from),
  check (holder_director_id is not null or (holder_name is not null and length(btrim(holder_name)) > 0))
);

create index digital_signature_certificates_company_idx
  on public.digital_signature_certificates (company_id, valid_to);
create index digital_signature_certificates_holder_idx
  on public.digital_signature_certificates (holder_director_id)
  where holder_director_id is not null;

create trigger set_updated_at before update on public.digital_signature_certificates
  for each row execute function app_private.set_updated_at();

alter table public.digital_signature_certificates enable row level security;

-- RLS mirrors company_directors (0088) exactly, per this task's own
-- instruction: read for any company member, write for anyone with write
-- access — a DSC record is operational bookkeeping (who holds what
-- certificate), not salary/admin-sensitive data, same call 0088 made for
-- the director master itself.
create policy digital_signature_certificates_read on public.digital_signature_certificates
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy digital_signature_certificates_write on public.digital_signature_certificates
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.digital_signature_certificates is
  'DSC register — who holds which Digital Signature Certificate used to sign ROC/GST/income-tax filings, and its validity window. holder_director_id is nullable (composite FK to company_directors, 0088): a DSC holder is often a director but is just as often a practising CA or outsourced signatory with no board role, captured instead in holder_name. Exactly one of the two must be set. dsc_class defaults to Class 3 — see migration header for the live research on Class 2 having been discontinued for new issuance since 1 Jan 2021, and the one genuine conflict that research turned up (CCA''s own reference page still lists Class 2 structurally; no gazette notification withdrawing it by name was found either) rather than silently picking a side.';

comment on column public.digital_signature_certificates.holder_name is
  'Free-text holder name, used when the DSC holder is not a director/KMP on record (e.g. a practising CA signing on the company''s behalf). Ignored for display when holder_director_id is set — see get_dsc_expiry_status, which resolves the director''s name from company_directors in that case.';

comment on column public.digital_signature_certificates.dsc_class is
  'Free text, not an enum — classification has already consolidated once (Class 1/2 issuance folded into Class 3 from 1 Jan 2021) and could again; see migration header. Defaults to ''Class 3'', the one class actually issued today for MCA/GST/income-tax filings.';

-- ---------------------------------------------------------------------------
-- get_dsc_expiry_status — every DSC on record for a company with expiry
-- worked out against today, same is_overdue/days_remaining shape as
-- get_notices (0059): computed at query time, never stored, so it never
-- drifts.
-- ---------------------------------------------------------------------------
create or replace function public.get_dsc_expiry_status(
  p_company_id uuid
) returns table (
  id uuid,
  holder_director_id uuid,
  holder_label text,
  designation text,
  certifying_authority text,
  dsc_class text,
  valid_from date,
  valid_to date,
  days_remaining integer,
  is_expired boolean,
  expiring_within_30_days boolean,
  expiring_within_60_days boolean,
  expiring_within_90_days boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    dsc.id,
    dsc.holder_director_id,
    coalesce(cd.name, dsc.holder_name) as holder_label,
    cd.designation,
    dsc.certifying_authority,
    dsc.dsc_class,
    dsc.valid_from,
    dsc.valid_to,
    (dsc.valid_to - current_date)::integer as days_remaining,
    dsc.valid_to < current_date as is_expired,
    (dsc.valid_to >= current_date and dsc.valid_to <= current_date + 30) as expiring_within_30_days,
    (dsc.valid_to >= current_date and dsc.valid_to <= current_date + 60) as expiring_within_60_days,
    (dsc.valid_to >= current_date and dsc.valid_to <= current_date + 90) as expiring_within_90_days
  from public.digital_signature_certificates dsc
  left join public.company_directors cd on cd.id = dsc.holder_director_id
  where dsc.company_id = p_company_id
  order by dsc.valid_to asc;
$$;

revoke all on function public.get_dsc_expiry_status(uuid) from public, anon;
grant execute on function public.get_dsc_expiry_status(uuid) to authenticated;

comment on function public.get_dsc_expiry_status(uuid) is
  'Every DSC for a company with expiry urgency computed against current_date (never stored, so it never drifts) — is_expired, and three nested expiring_within_N_days flags (30 implies 60 implies 90) for badge/reminder colouring. holder_label resolves to the linked director''s name when holder_director_id is set, else the free-text holder_name.';
