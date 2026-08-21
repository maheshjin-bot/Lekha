-- ============================================================================
-- 0059 — Notice and assessment tracking
-- ============================================================================
-- The `notices` module (0004) has been registered since day one — optional,
-- code 'Notice and assessment tracking' — with zero code behind it, the same
-- shape of gap 0024 closed for compliance_calendar. This is that module's
-- first implementation.
--
-- A TRACKING LOG, NOT A DUE-DATE CALCULATOR — the deliberate difference from
-- compliance_calendar (0024). Every compliance_calendar date is a
-- deterministic formula (Nth of the month after a period); a notice's
-- response deadline is whatever the ISSUING OFFICER wrote on that specific
-- notice, and genuinely varies even for the same form — verified live
-- (WebSearch, Aug 2026): an ASMT-10 scrutiny notice typically carries 30
-- days, a show-cause notice under Sec 73/74 (DRC-01) also commonly 30, but
-- an SCN can run anywhere 7-30 days at the officer's own discretion. There is
-- no formula to compute here, so due_date is entered by the user from the
-- notice itself, not derived.
--
-- NOTICE_TYPE IS FREE TEXT, AUTHORITY IS THE CONSTRAINED FIELD. GST alone
-- spans ASMT-10, DRC-01/03/07, REG-17/23/24 and more; income tax spans
-- 143(2), 148, 156 and more; TDS and ROC have their own forms again — a
-- closed enum of specific form numbers would need editing every time a
-- business receives a form this migration's author had not thought of.
-- `authority` (which government body) is the field reports and filters
-- actually need, and it is a short, genuinely closed list.
--
-- STATUS IS THE BUSINESS'S OWN WORKFLOW STATE, not the notice's legal
-- outcome — 'open' (received, not yet acted on), 'responded' (a reply was
-- filed, awaiting the department), 'closed' (resolved, either way), so a
-- dashboard can show "what still needs my attention" without this app
-- needing to understand assessment law well enough to know whether a
-- response actually succeeded.
--
-- URGENCY IS COMPUTED, NOT STORED. is_overdue and days_remaining shift every
-- day the notice sits open; storing either would need a daily job to keep
-- them true. get_notices computes both from today's date at query time,
-- exactly once, in one place.
-- ============================================================================


create table public.notices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  authority text not null check (authority in ('gst','income_tax','tds','tcs','roc','pf_esi','other')),
  notice_type text not null check (length(trim(notice_type)) > 0),
  notice_number text,
  notice_date date not null,
  -- Deadlines commonly run from RECEIPT, not the date printed on the notice
  -- itself (which can predate delivery by days on a physically posted
  -- notice) — tracked separately so a business can show it actually replied
  -- within the window that mattered, not the window the department printed.
  received_date date not null,
  due_date date,
  description text not null check (length(trim(description)) > 0),
  amount_involved numeric(18,2),
  status text not null default 'open' check (status in ('open','responded','closed')),
  response_date date,
  response_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (due_date is null or due_date >= notice_date),
  check (response_date is null or response_date >= received_date)
);

create index notices_company_status_idx on public.notices(company_id, status, due_date);

create trigger set_updated_at before update on public.notices
  for each row execute function app_private.set_updated_at();

alter table public.notices enable row level security;

create policy notices_read on public.notices
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy notices_write on public.notices
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.notices is
  'Government notices and assessments received, tracked to response — not a due-date calculator (see migration header for why, contrast compliance_calendar 0024). status is this business''s own workflow state (open/responded/closed), not a legal outcome.';


-- ----------------------------------------------------------------------------
-- get_notices(company, status_filter)
-- ----------------------------------------------------------------------------
-- status_filter null returns everything; a specific status filters to it.
-- is_overdue / days_remaining are computed against current_date at query
-- time — see the migration header for why neither is a stored column.
create or replace function public.get_notices(
  p_company_id uuid,
  p_status_filter text default null
) returns table (
  id uuid,
  authority text,
  notice_type text,
  notice_number text,
  notice_date date,
  received_date date,
  due_date date,
  description text,
  amount_involved numeric,
  status text,
  response_date date,
  response_note text,
  is_overdue boolean,
  days_remaining integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    n.id, n.authority, n.notice_type, n.notice_number,
    n.notice_date, n.received_date, n.due_date, n.description,
    n.amount_involved, n.status, n.response_date, n.response_note,
    (n.status = 'open' and n.due_date is not null and n.due_date < current_date) as is_overdue,
    case when n.due_date is not null then (n.due_date - current_date)::integer end as days_remaining
  from public.notices n
 where n.company_id = p_company_id
   and (p_status_filter is null or n.status = p_status_filter)
 order by
   (n.status = 'open') desc,
   n.due_date nulls last,
   n.notice_date desc;
$$;

comment on function public.get_notices is
  'Notices for a company, optionally filtered by status. is_overdue is true only for a still-open notice past its due_date — a responded or closed notice is never "overdue" regardless of when it was resolved. days_remaining is negative once overdue, null when no due_date was recorded.';
