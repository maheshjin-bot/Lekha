-- ============================================================================
-- 0116 — Sec 186 inter-corporate loan/guarantee/investment register (MBP-2)
-- ============================================================================
-- Nothing in this schema previously represented a loan given, a guarantee
-- given, or an investment made BY the company (as opposed to money the
-- company itself borrowed, which the existing ledgers already show as
-- non_current_liability/current_liability balances) — a repo-wide search for
-- "mbp" / "186" against migrations 0001-0115 returns nothing except this
-- session's own 0101 header, which named Sec 186's ceiling formula as a
-- reason get_share_capital_summary needed to exist, without building the
-- register itself. This migration is that register.
--
-- LEGAL BASIS (WebSearch, Aug 2026, two passes — the second specifically
-- skeptical about whether the register is mandatory only above the ceiling
-- or for every transaction regardless of size, since getting that backwards
-- would silently under-record).
--
-- Sec 186(9) Companies Act 2013, read with Rule 12(1) Companies (Meetings of
-- Board and its Powers) Rules 2014: EVERY company must maintain a register,
-- in Form MBP-2, of every loan given, guarantee given or security provided,
-- and every investment/acquisition of securities made — regardless of
-- whether that particular transaction is within or beyond the ceiling in
-- Sec 186(2). The ceiling in Sec 186(2)/(3) governs which APPROVAL is needed
-- (board resolution always; ADDITIONALLY a special resolution at a general
-- meeting when the AGGREGATE crosses the limit below), not whether the
-- transaction gets a row in this register at all. Confirmed live in-schema:
-- the task column list built below has no "exceeds ceiling?" gate on
-- insertability, consistent with that reading.
--
-- THE CEILING FORMULA — Sec 186(2): the aggregate of loans given + guarantees
-- given/security provided + investments made cannot exceed the HIGHER of (a)
-- 60% of (paid-up share capital + free reserves + securities premium
-- account), or (b) 100% of (free reserves + securities premium account).
-- Beyond that, Sec 186(3) requires PRIOR approval by special resolution at a
-- general meeting, in addition to the board resolution Sec 186(2) always
-- requires (passed unanimously at a physical board meeting — not by circular
-- resolution). Both resolution facts are represented below; see why the
-- ceiling itself is NOT enforced as a write-blocking constraint.
--
-- WHY board_resolution_date IS NOT NULL BUT shareholder_resolution_date IS
-- NULLABLE. Sec 186(2)'s board-approval requirement applies to every
-- transaction this register covers, with no size threshold — so a row
-- without SOME board resolution date represents a transaction this app has
-- no evidence was ever lawfully approved at all, which is worse than
-- refusing to record it that way. The special resolution is conditional —
-- only required once the AGGREGATE (not this transaction alone) crosses the
-- Sec 186(2) ceiling — so it stays nullable, exactly like company_directors.
-- date_of_cessation and share_holdings.date_of_cessation are nullable for
-- their own "only sometimes applies" facts.
--
-- date <= ... ORDERING CHECKS ARE REAL Sec 186(2)/(3) REQUIREMENTS, NOT
-- HOUSEKEEPING. Both subsections require PRIOR approval — "no investment...
-- shall be made... unless the transaction is previously approved" (186(2))
-- and "previously authorised by a special resolution" (186(3)) — so a
-- resolution dated AFTER the transaction it purports to approve is not a
-- technicality, it describes an approval that could not have authorised
-- anything. Enforced below as real CHECK constraints, the same discipline
-- 0101 used for the authorized-share-capital ceiling.
--
-- THE CEILING ITSELF IS DELIBERATELY NOT ENFORCED AS A CONSTRAINT, AND
-- get_sec186_ceiling_check IS DELIBERATELY LABELLED APPROXIMATE. This is
-- the one part of this migration's task that could not be built to the same
-- standard as 0101's authorized-capital trigger, and said so rather than
-- faked. get_share_capital_summary (0101) gives an EXACT paid-up capital
-- figure. "Free reserves + securities premium" is a different story —
-- confirmed live against this schema (get_balance_sheet's own function body,
-- and account_groups' nature/ledger_role CHECK constraints): the only
-- classification this schema has above ledger-name-as-free-text is
-- nature = 'reserves_surplus', a single bucket covering EVERY reserve a
-- company might set up — general reserve, retained earnings/P&L, capital
-- reserve, revaluation reserve, AND securities premium all land in the same
-- nature with no ledger_role value (cash_bank/debtor/creditor/income/
-- expense/capital/loan/duty_tax/stock/investment/provision/other/
-- tangible_fixed_asset/intangible_fixed_asset/capital_work_in_progress —
-- checked live, none of these is "securities_premium" or "free_reserve")
-- distinguishing them. Sec 2(43)'s definition of "free reserves" SPECIFICALLY
-- EXCLUDES capital redemption reserve and revaluation reserve, and securities
-- premium is a SEPARATE line Sec 186(2) adds on top of free reserves, not a
-- reserve itself. This schema cannot currently tell those apart — summing
-- everything under reserves_surplus will overstate the true free-reserves-
-- plus-securities-premium figure for any company that has set up a capital
-- redemption or revaluation reserve ledger (checked live: none of the 15
-- seeded companies currently has, so today's numbers happen to be exact, but
-- the FUNCTION cannot promise that in general). get_sec186_ceiling_check
-- below computes the number anyway (an approximate ceiling is more useful
-- than none), but returns is_approximate = true and a caveat column
-- explaining exactly this, every time, rather than a bare figure that reads
-- as more certain than it is.
--
-- total_recorded_loans_investments IS CUMULATIVE, NOT NET OF REPAYMENT — a
-- SECOND, SEPARATE approximation, also disclosed rather than hidden. The
-- task's own column list for sec186_investments has no repayment/closure
-- date, so a loan given and later fully repaid still counts toward this
-- register's running total forever. MBP-2 itself is a record of transactions
-- made, not a live receivables ledger, so this is a reasonably honest reading
-- of what the form wants — but it does mean the ceiling-headroom figure below
-- can UNDERSTATE real headroom for a company that has since collected on an
-- old loan. Said in the same caveat column, not silently assumed away.
--
-- WHICH ENTITY TYPES — pvt_ltd/ltd/opc, the same gate 0101 established and
-- 0115 (this session's companion migration) reuses. Sec 186 is a Companies
-- Act provision; it has no LLP/partnership/proprietorship/HUF/AOP/trust/
-- society equivalent, and this app's entity_type enum has no separate
-- "guarantee company" value (re-confirmed live, same ten values 0101 found)
-- for the other Sec 186-applicable but share-capital-inapplicable case.
-- (A private-company exemption from Sec 186 exists in principle via a 2015
-- MCA notification for a company meeting specific conditions on borrowings
-- and inter-corporate investment — but the register duty under Sec 186(9)
-- is the one part of Sec 186 that notification does NOT touch, so gating
-- register-keeping by whether a specific pvt_ltd happens to qualify for that
-- exemption would be solving a problem this table doesn't have.)
--
-- RLS MIRRORS company_directors (0088) EXACTLY — same reasoning as 0115.
--
-- WHAT THIS DOES NOT DO: generate Form MBP-2 itself, compute or enforce the
-- Sec 186(2) ceiling as a write-blocking rule (see above — the inputs are
-- honestly approximate), track repayment/closure of a loan given, or record
-- the "time period" and "listed/unlisted recipient" fields Form MBP-2 itself
-- asks for beyond what the task's column list already specifies. All said
-- here and repeated in scope_deferred.
-- ============================================================================

create table public.sec186_investments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,

  transaction_type text not null check (transaction_type = any (array[
    'loan', 'guarantee', 'security', 'investment'
  ])),
  recipient_entity_name text not null check (length(trim(recipient_entity_name)) > 0),
  amount numeric(18,2) not null check (amount > 0),
  date date not null,

  -- Sec 186(2) — board approval is mandatory for every row regardless of
  -- size, so NOT NULL. See migration header.
  board_resolution_date date not null,
  -- Sec 186(3) — only needed once the AGGREGATE crosses the ceiling, so
  -- nullable. See migration header.
  shareholder_resolution_date date,

  purpose text not null check (length(trim(purpose)) > 0),

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Both subsections require PRIOR approval — a resolution cannot authorise
  -- a transaction it postdates. See migration header.
  check (board_resolution_date <= date),
  check (shareholder_resolution_date is null or shareholder_resolution_date <= date)
);

create index sec186_investments_company_date_idx on public.sec186_investments (company_id, date);

create trigger set_updated_at before update on public.sec186_investments
  for each row execute function app_private.set_updated_at();

-- ----------------------------------------------------------------------------
-- app_private.check_company_subject_to_sec186 — the pvt_ltd/ltd/opc gate.
-- ----------------------------------------------------------------------------
create or replace function app_private.check_company_subject_to_sec186()
returns trigger
language plpgsql
set search_path to ''
as $fn$
declare
  v_entity_type text;
begin
  select entity_type into v_entity_type from public.companies where id = new.company_id;
  if v_entity_type is null or v_entity_type not in ('pvt_ltd', 'ltd', 'opc') then
    raise exception
      'Sec 186 Companies Act 2013 (Form MBP-2) does not apply to this company''s entity type (%). Only a company limited by shares — pvt_ltd, ltd or opc in this app''s own entity types — is subject to Sec 186; an LLP, partnership, proprietorship, HUF, AOP, trust or society has no equivalent obligation.',
      coalesce(v_entity_type, 'unknown');
  end if;
  return new;
end;
$fn$;

create trigger sec186_investments_entity_type_check
  before insert on public.sec186_investments
  for each row execute function app_private.check_company_subject_to_sec186();

-- ----------------------------------------------------------------------------
-- RLS — mirrors company_directors (0088) exactly.
-- ----------------------------------------------------------------------------
alter table public.sec186_investments enable row level security;

create policy sec186_investments_read on public.sec186_investments
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy sec186_investments_write on public.sec186_investments
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.sec186_investments is
  'Form MBP-2 register, Sec 186(9) Companies Act 2013 — every loan given, guarantee/security given, or investment made by the company, regardless of size (the Sec 186(2) ceiling governs approval level, not whether a row belongs here). Only insertable for pvt_ltd/ltd/opc (enforced by check_company_subject_to_sec186). board_resolution_date is mandatory (Sec 186(2), every transaction); shareholder_resolution_date is nullable, needed only once the running aggregate crosses the ceiling (Sec 186(3)). No repayment/closure tracking — see 0116 header.';

comment on column public.sec186_investments.board_resolution_date is
  'Sec 186(2): every transaction this register covers needs prior board approval (unanimous, at a physical meeting — not by circular resolution), regardless of amount. Must not be after the transaction date itself (CHECK enforced) — a resolution cannot authorise what it postdates.';

comment on column public.sec186_investments.shareholder_resolution_date is
  'Sec 186(3): needed only once the AGGREGATE of loans/guarantees/securities/investments crosses the Sec 186(2) ceiling — see get_sec186_ceiling_check for this app''s (approximate — see 0116 header) attempt at that figure. Null is normal for a transaction that stayed within the board-only limit.';

-- ----------------------------------------------------------------------------
-- public.get_sec186_ceiling_check — reuses get_share_capital_summary (0101,
-- exact) for paid-up capital, and get_balance_sheet (reserves_surplus nature,
-- approximate — see header) for free reserves + securities premium. Every
-- figure derived from the approximate input is labelled as such via
-- is_approximate/caveat, not presented as filing-ready.
-- ----------------------------------------------------------------------------
create or replace function public.get_sec186_ceiling_check(p_company_id uuid)
returns table (
  paid_up_capital numeric,
  reserves_and_securities_premium_approx numeric,
  ceiling_60pct_capital_plus_reserves numeric,
  ceiling_100pct_reserves numeric,
  board_only_limit numeric,
  total_recorded_loans_investments numeric,
  headroom_before_shareholder_approval numeric,
  is_approximate boolean,
  caveat text
)
language plpgsql
stable
set search_path to ''
as $fn$
declare
  v_paid_up numeric;
  v_reserves numeric;
  v_total numeric;
  v_ceiling_60 numeric;
  v_ceiling_100 numeric;
  v_board_limit numeric;
begin
  if not app_private.is_company_member(p_company_id) then
    raise exception 'Not permitted to view this company''s Sec 186 ceiling check.';
  end if;

  select coalesce(sum(s.paid_up_capital), 0) into v_paid_up
    from public.get_share_capital_summary(p_company_id) s;

  select coalesce(sum(b.amount), 0) into v_reserves
    from public.get_balance_sheet(p_company_id, current_date) b
   where b.nature = 'reserves_surplus';

  select coalesce(sum(i.amount), 0) into v_total
    from public.sec186_investments i
   where i.company_id = p_company_id;

  v_ceiling_60 := round(0.6 * (v_paid_up + v_reserves), 2);
  v_ceiling_100 := round(v_reserves, 2);
  v_board_limit := greatest(v_ceiling_60, v_ceiling_100);

  return query select
    v_paid_up,
    v_reserves,
    v_ceiling_60,
    v_ceiling_100,
    v_board_limit,
    v_total,
    v_board_limit - v_total,
    true,
    'Approximate. Paid-up capital is exact (get_share_capital_summary). "Free reserves + securities premium" is approximated as every ledger under this company''s Reserves & Surplus nature — this schema does not separately identify securities premium, or exclude capital redemption/revaluation reserve, both of which Sec 2(43) excludes from "free reserves". total_recorded_loans_investments is every row ever entered here, not adjusted for repayment (this register does not track closure). Treat this as directional guidance for when a special resolution is likely needed, not a filing-ready Sec 186(2) computation.'::text;
end;
$fn$;

revoke all on function public.get_sec186_ceiling_check(uuid) from public, anon;
grant execute on function public.get_sec186_ceiling_check(uuid) to authenticated;

comment on function public.get_sec186_ceiling_check(uuid) is
  'Sec 186(2) ceiling — higher of 60% of (paid-up capital + reserves) or 100% of reserves — against this register''s cumulative recorded total. Both the reserves figure and the cumulative total are approximations; is_approximate is always true and caveat explains exactly why. See 0116.';
