-- ============================================================================
-- 0092 — Meeting register: the actual AGM date this app never recorded (T2-19)
-- ============================================================================
-- A repo-wide search for the word "meeting" across app/components/lib/supabase
-- found no meeting table anywhere. get_compliance_calendar (0062) computes the
-- AOC-4 and MGT-7 due dates by ASSUMING every company holds its AGM on the
-- latest permissible date, 30 September — its own header says so in as many
-- words: "AGM DATE IS ASSUMED, NOT TRACKED... A company that holds its AGM
-- earlier has an earlier real deadline than shown here." That is a silently
-- optimistic assumption in exactly the direction that causes a missed filing:
-- a company that actually meets on, say, 12 August has real AOC-4/MGT-7
-- deadlines several weeks earlier than the calendar shows. This migration adds
-- the table that assumption should eventually read from.
--
-- NOT WIRED INTO get_compliance_calendar HERE — deliberately, and this is the
-- single most important scope line in this migration. Four other agents are
-- working this same repo and database concurrently right now, and 0062 is a
-- large, carefully-structured shared CTE function that a previous agent today
-- (0084, payroll) already extended once. Rewriting its roc_aoc4/
-- roc_annual_return CTEs to read a real AGM date instead of assuming 30
-- September is genuinely the point of this whole feature — and it must happen
-- as its own separate, later, single-owner change to that function, never as
-- a drive-by edit from a parallel batch. Recorded explicitly in this session's
-- scope_deferred so it is not silently forgotten.
--
-- TABLE NAME: meetings, not "agm_register" — an AGM-only table could not hold
-- the board meetings this migration also records, and Sec 118 draws no
-- structural distinction between them (see below). A dedicated table, not the
-- documents (0060) polymorphic-entity approach: `select distinct entity_type
-- from public.documents` returns zero rows in this dataset, so there is no
-- existing convention being extended either way, and a meeting is a first-
-- class fact with its own date, type and FY relevance — not an attachment on
-- something else. documents IS reused, unmodified, for the minutes FILE
-- itself (entity_type = 'meeting'), the same way NoticeManager already
-- attaches files to a notice — that needs no schema change here, only a UI
-- call site, because documents.entity_type/entity_id (0060) is exactly the
-- generic hook this is for.
--
-- THREE MEETING TYPES, VERIFIED (WebSearch, Aug 2026) AGAINST THE COMPANIES
-- ACT 2013, NOT ASSUMED FROM TRAINING DATA:
--
--   AGM (Sec 96)   Annual General Meeting. Every company except an OPC (Sec
--                  96(1) proviso: "nothing... shall apply to a One Person
--                  Company") must hold one. The FIRST AGM is due within NINE
--                  months of the close of the company's first financial year
--                  (no AGM needed in the incorporation year itself); every
--                  SUBSEQUENT AGM is due within SIX months of financial year
--                  close, confirmed unchanged from 0062's own reading of the
--                  same section. (A second test — not more than 15 months
--                  between two AGMs — also applies under Sec 96(1) proviso;
--                  deliberately not modelled here, see below.)
--   EGM            Extraordinary General Meeting (Sec 100) — called as
--                  needed, no periodic deadline exists to compute, so no
--                  "days remaining" is shown for it. Recorded for the same
--                  reason a board meeting is: Sec 118 minutes discipline
--                  applies to it exactly the same as to an AGM.
--   Board meeting  Sec 173: at least 4 a year, gap between consecutive
--                  meetings never exceeding 120 days for an ordinary company;
--                  a small company, OPC or dormant company needs only 2 a
--                  year (one per calendar half), gap never LESS than 90 days,
--                  UNLESS the OPC has only one director, in which case Sec
--                  173 does not apply at all. This minimum-count/minimum-gap
--                  rule is NOT enforced or flagged by this migration — see
--                  OUT OF SCOPE below — but every meeting is recorded in this
--                  same table (not an AGM-only one) specifically so that a
--                  later feature CAN compute it without a schema change.
--
-- SEC 118 — MINUTES WITHIN 30 DAYS, THE SAME RULE FOR EVERY MEETING TYPE.
-- Minutes of "every general meeting... and every meeting of its Board" must
-- be prepared and signed within 30 days of the meeting. One column,
-- minutes_signed_date, carries this for AGM/EGM/board alike — not a separate
-- boolean plus a separate date, which could disagree with each other. Null
-- means not yet signed; get_meetings computes the 30-day breach from it, the
-- same "computed, not stored" discipline notices (0059) already uses for
-- is_overdue, for the same reason: whether a signature is now overdue shifts
-- every day a company sits on it, and storing that verdict would need a daily
-- job to keep true.
--
-- FINANCIAL_YEAR_START_YEAR — AGM-ONLY, ENFORCED BOTH WAYS. An AGM discharges
-- a specific financial year's Sec 96 obligation, so it MUST carry one (the
-- CHECK enforces this). An EGM or board meeting has no such per-FY identity —
-- Sec 173's count is a calendar fact read off meeting_date directly, not a
-- tag — so the same column is required to be NULL for them, which also keeps
-- "has FY 2025-26's AGM been recorded" answerable by a single equality test
-- rather than a date-range join. A partial unique index additionally stops
-- two AGM rows from ever claiming the same financial year for the same
-- company (adjourned/re-convened AGMs are out of scope — see below).
--
-- WHAT get_agm_status COMPUTES, AND WHY IT DOESN'T RE-DERIVE 0062's ASSUMPTION.
-- The one fact this feature exists to surface: for the financial year that
-- has most recently CLOSED (not the one in progress), how many days remain
-- until its Sec 96 deadline, if no AGM has yet been recorded against it. This
-- reads companies.financial_year_start_month directly rather than hardcoding
-- April–March the way 0062 deliberately does for its own reasons (0062's
-- header: "Always runs on the calendar April-March year; never reads
-- companies.financial_year_start_month") — every seeded company happens to
-- use month 4 today, matching Sec 2(41)'s standard April–March year for
-- companies, but reading the column rather than assuming it keeps this
-- narrower, per-company function honest about its own dependency instead of
-- silently inheriting 0062's separate, documented simplification.
--
-- FIRST-AGM DETECTION: is_first_agm is true when this company has never
-- recorded ANY agm-type meeting, giving the closed FY a 9-month window
-- instead of 6. This is a real simplification when a company was
-- incorporated so recently that the "closed FY" computed here predates its
-- existence (incorporation_date is null for every seeded company today, so
-- this exact branch is unverifiable live) — guarded explicitly: if
-- incorporation_date falls AFTER the closed FY's end date, the function
-- shifts to the CURRENTLY-IN-PROGRESS FY instead (that is the company's own
-- first financial year), reporting a first-AGM deadline that is necessarily
-- still comfortably in the future rather than a false "overdue" reading for
-- a company that could not possibly have met yet.
--
-- APPLICABLE ONLY TO pvt_ltd/ltd, NOT opc — a genuine correction to what an
-- entity-type filter copied from 0062 would have assumed: 0062's roc_aoc4/
-- roc_annual_return CTEs include 'opc' in their
-- entity-type filter because OPC still files AOC-4 and MGT-7A — but those are
-- ROC FILING obligations, not an AGM obligation; an OPC has no AGM to hold at
-- all. get_agm_status therefore reports applicable = false for entity_type
-- 'opc', which is deliberately NARROWER than 0062's own filter and is not a
-- contradiction — the two functions are answering different questions (does
-- this entity type file AOC-4/MGT-7A vs does this entity type hold an AGM).
-- This distinction is exactly why wiring the real date into 0062 later needs
-- care and its own single-owner pass, not a mechanical read-through.
--
-- OUT OF SCOPE (named, not built): quorum tracking; resolution-by-resolution
-- minutes content; e-voting records; the Sec 173 minimum-count/minimum-gap
-- compliance flag (schema supports it — every meeting is recorded, not only
-- AGMs — a later feature can compute it without touching this table); the
-- Sec 96(1) "not more than 15 months between AGMs" second test (the FY-close
-- test above is nearly always the binding one in practice, and computing
-- both correctly needs the PRIOR AGM's actual date as an extra join this
-- pass does not add); adjourned/re-convened AGMs (the partial unique index
-- would need loosening to support them, a real design question left for
-- whoever builds that).
-- ============================================================================

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  meeting_type text not null check (meeting_type in ('agm', 'egm', 'board')),
  meeting_date date not null,
  -- AGM-only, enforced both directions — see migration header.
  financial_year_start_year smallint,
  -- When the notice of meeting was issued. Not statutorily deadline-checked
  -- here (notice-period minimums vary by meeting type and by whether consent
  -- to shorter notice was obtained) — recorded for the file, not policed.
  notice_date date,
  agenda text not null check (length(trim(agenda)) > 0),
  -- Null = minutes not yet signed. See migration header re: Sec 118.
  minutes_signed_date date,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (meeting_type = 'agm' and financial_year_start_year is not null)
    or (meeting_type <> 'agm' and financial_year_start_year is null)
  ),
  check (notice_date is null or notice_date <= meeting_date),
  check (minutes_signed_date is null or minutes_signed_date >= meeting_date)
);

-- One AGM per company per financial year. Deliberately does not allow an
-- adjourned/re-convened AGM to be recorded as a second row for the same FY —
-- see OUT OF SCOPE.
create unique index meetings_one_agm_per_fy
  on public.meetings (company_id, financial_year_start_year)
  where meeting_type = 'agm';

create index meetings_company_type_date_idx
  on public.meetings (company_id, meeting_type, meeting_date);

create trigger set_updated_at before update on public.meetings
  for each row execute function app_private.set_updated_at();

alter table public.meetings enable row level security;

-- Matches public.notices (0059) exactly — read for anyone on the company,
-- write for anyone with write access to it.
create policy meetings_read on public.meetings
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy meetings_write on public.meetings
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.meetings is
  'AGM/EGM/board meeting register — Sec 96 AGM timing and Sec 118 minutes-within-30-days, for every meeting type so a later Sec 173 board-meeting-count feature needs no schema change. See 0092 for what is and is not modelled.';

comment on column public.meetings.financial_year_start_year is
  'Which financial year this AGM discharges (e.g. 2025 = FY 2025-26). Required for meeting_type=agm, forbidden otherwise — see 0092 header.';

comment on column public.meetings.minutes_signed_date is
  'When Sec 118 minutes were signed. Null = not yet signed; get_meetings computes the 30-day breach from this at query time, the same pattern notices.is_overdue (0059) uses.';


-- ----------------------------------------------------------------------------
-- get_meetings(company, type_filter)
-- ----------------------------------------------------------------------------
create or replace function public.get_meetings(
  p_company_id uuid,
  p_type_filter text default null
) returns table (
  id uuid,
  meeting_type text,
  meeting_date date,
  financial_year_start_year smallint,
  notice_date date,
  agenda text,
  minutes_signed_date date,
  minutes_overdue boolean,
  days_since_meeting integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    m.id, m.meeting_type, m.meeting_date, m.financial_year_start_year,
    m.notice_date, m.agenda, m.minutes_signed_date,
    (m.minutes_signed_date is null and m.meeting_date + 30 < current_date) as minutes_overdue,
    (current_date - m.meeting_date)::integer as days_since_meeting
  from public.meetings m
 where m.company_id = p_company_id
   and (p_type_filter is null or m.meeting_type = p_type_filter)
 order by m.meeting_date desc;
$$;

comment on function public.get_meetings is
  'Meetings for a company, optionally filtered by type (agm/egm/board). minutes_overdue is true only when minutes_signed_date is still null 30 days after the meeting — Sec 118. See 0092.';

revoke all on function public.get_meetings(uuid, text) from public, anon;
grant execute on function public.get_meetings(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- get_agm_status(company) — the single fact this feature exists to surface
-- ----------------------------------------------------------------------------
-- For the most recently CLOSED financial year, how many days remain until
-- its Sec 96 AGM deadline, if no AGM has yet been recorded against it. See
-- the migration header for the full reasoning, the OPC exclusion, and the
-- incorporation-date guard.
create or replace function public.get_agm_status(
  p_company_id uuid
) returns table (
  applicable boolean,
  financial_year_start_year smallint,
  fy_label text,
  fy_end_date date,
  is_first_agm boolean,
  deadline_date date,
  agm_recorded boolean,
  days_remaining integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_entity_type text;
  v_fy_start_month smallint;
  v_incorporation_date date;
  v_today date := current_date;
  v_current_fy_start_year int;
  v_target_fy_start_year int;
  v_fy_end date;
  v_ever_agm boolean;
  v_is_first boolean;
  v_recorded boolean;
  v_deadline date;
begin
  select c.entity_type, c.financial_year_start_month, c.incorporation_date
    into v_entity_type, v_fy_start_month, v_incorporation_date
    from public.companies c
   where c.id = p_company_id;

  -- Sec 96(1) proviso: an OPC has no AGM to hold at all. Deliberately
  -- narrower than 0062's own AOC-4/MGT-7A entity filter — see migration
  -- header for why that is not a contradiction.
  if v_entity_type not in ('pvt_ltd', 'ltd') then
    return query select false, null::smallint, null::text, null::date,
                         null::boolean, null::date, null::boolean, null::integer;
    return;
  end if;

  -- FY in progress right now: starts this calendar year if we're already
  -- past the FY-start month, else last calendar year.
  if extract(month from v_today) >= v_fy_start_month then
    v_current_fy_start_year := extract(year from v_today)::int;
  else
    v_current_fy_start_year := extract(year from v_today)::int - 1;
  end if;

  -- The FY whose AGM is the live question is the one that just closed.
  v_target_fy_start_year := v_current_fy_start_year - 1;
  v_fy_end := make_date(v_target_fy_start_year + 1, v_fy_start_month, 1) - 1;

  select exists(
    select 1 from public.meetings mt
     where mt.company_id = p_company_id and mt.meeting_type = 'agm'
  ) into v_ever_agm;

  -- Guard: the closed FY computed above may predate this company's own
  -- existence. Shift to the FY currently in progress instead — that is this
  -- company's real first financial year, and there is genuinely no earlier
  -- AGM obligation to report.
  if v_incorporation_date is not null and v_incorporation_date > v_fy_end then
    v_target_fy_start_year := v_current_fy_start_year;
    v_fy_end := make_date(v_target_fy_start_year + 1, v_fy_start_month, 1) - 1;
    v_is_first := true;
  else
    v_is_first := not v_ever_agm;
  end if;

  -- Table alias required: financial_year_start_year is also this function's
  -- own RETURNS TABLE column name, and plpgsql treats that as a declared
  -- variable in scope too — a bare column reference is genuinely ambiguous
  -- between the two, and Postgres correctly refuses to guess (42702) rather
  -- than silently picking one. Caught live by this migration's own
  -- verification query, not by re-reading the code.
  select exists(
    select 1 from public.meetings mt
     where mt.company_id = p_company_id and mt.meeting_type = 'agm'
       and mt.financial_year_start_year = v_target_fy_start_year
  ) into v_recorded;

  v_deadline := v_fy_end + (case when v_is_first then interval '9 months' else interval '6 months' end);

  return query select
    true,
    v_target_fy_start_year::smallint,
    ('FY ' || v_target_fy_start_year::text || '-' || right((v_target_fy_start_year + 1)::text, 2)),
    v_fy_end,
    v_is_first,
    v_deadline::date,
    v_recorded,
    case when v_recorded then null else (v_deadline::date - v_today)::integer end;
end;
$$;

comment on function public.get_agm_status is
  'Sec 96 AGM deadline status for the most recently closed financial year: days remaining if not yet recorded, or agm_recorded=true if it has been. applicable=false for anything other than pvt_ltd/ltd (OPC has no AGM under Sec 96(1) proviso; LLP has no AGM at all). Does NOT feed get_compliance_calendar (0062) — see 0092 header for why that is deferred to its own change.';

revoke all on function public.get_agm_status(uuid) from public, anon;
grant execute on function public.get_agm_status(uuid) to authenticated;
