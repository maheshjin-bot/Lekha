-- ============================================================================
-- 0105 — Notes to accounts: contingent liabilities, AS 18 related parties,
--         and the receivable/payable ageing schedule
-- ============================================================================
-- Three Schedule III disclosure items built together because they share one
-- home (extending `notices`, which already tracks disputed tax demands) and
-- because none of them makes sense as a standalone screen — a "notes to
-- accounts" page is inherently a collection of small statutory footnotes,
-- not a single statement.
--
-- ----------------------------------------------------------------------------
-- PART 1 — CONTINGENT LIABILITIES (Schedule III General Instructions, Part I,
--          Note (i); AS 29 "Provisions, Contingent Liabilities and
--          Contingent Assets")
-- ----------------------------------------------------------------------------
-- AS 29's own definition is the reason this is a DISCLOSURE feature, not a
-- posting feature: a contingent liability is BY DEFINITION a possible
-- obligation whose existence will be confirmed only by an uncertain future
-- event, OR a present obligation that is not probable to require an outflow
-- or cannot be reliably measured — either way, AS 29 para 14 says it "should
-- not be recognised" in the books. Nothing here ever touches
-- voucher_entries; every function in this migration is read-only against
-- data a preparer enters solely for the note.
--
-- WHY `notices` IS EXTENDED RATHER THAN REPLACED, AND WHY IT ALSO NEEDS A
-- SIBLING TABLE. Confirmed live (sbq against the running schema, not
-- assumed): notices already carries authority, notice_type, notice_number,
-- notice_date, received_date, due_date, description, amount_involved,
-- status ('open'/'responded'/'closed') and response_date/response_note. A
-- disputed tax demand under appeal is a textbook contingent liability (a
-- present obligation that is not probable / not accepted), so every
-- tax-authority dispute this app already tracks belongs in this note with
-- zero new facts about the DISPUTE itself. But `authority` is NOT NULL and
-- CHECK-constrained to {gst, income_tax, tds, tcs, roc, pf_esi, other} —
-- every value names a GOVERNMENT AUTHORITY — and notice_date/received_date
-- are NOT NULL and modelled as "a notice this business received". Schedule
-- III's contingent-liabilities note has two sub-categories that are not tax
-- notices at all: (b) guarantees given (e.g. a bank guarantee furnished on
-- the company's behalf) and (c) other money for which the company is
-- contingently liable (e.g. a disputed commercial claim from a supplier or
-- customer, with no "authority" and often no single "received" date).
-- Forcing a bank guarantee into `authority = 'other'` would misclassify it
-- under a column whose every other value names a tax/company-law authority,
-- and there is no honest received_date for "a guarantee we gave". So the
-- call made here: EXTEND notices for what it already is (tax/ROC-authority
-- disputes), and add ONE NEW sibling table, `contingent_liabilities`, for
-- the two Schedule III sub-categories that are not sourced from a notice at
-- all. get_contingent_liabilities_note (below) UNIONs both sources into one
-- note so a preparer sees a single list regardless of which table a given
-- item actually lives in.
--
-- WHAT notices WAS MISSING TO SERVE THIS PURPOSE, closed by the two new
-- columns below:
--   is_disclosed_as_contingent boolean — a notice existing is not the same
--     fact as "this is currently an unprovided contingent liability". A
--     notice can be CLOSED because the demand was accepted and paid (now a
--     real, already-recognised liability — must NOT appear in a contingent
--     note, that would double-count it) or because it was dropped entirely
--     (no liability at all, also must not appear) — `status='closed'`
--     cannot distinguish these two very different outcomes from each other,
--     and neither can any other existing column. This is a fact only a
--     preparer reviewing the assessment order can supply, so it is a plain
--     boolean the preparer sets, not inferred. DEFAULTS to true on a new
--     row (a freshly received, still-open notice is presumptively an
--     unprovided contingent liability until someone says otherwise) and is
--     BACKFILLED to false for every pre-existing row with status='closed'
--     (see the UPDATE below) — an open/responded notice keeps the true
--     default, since "responded" means a reply was filed, not that the
--     matter is resolved.
--   contingent_amount numeric — the amount actually disclosed, when it
--     differs from amount_involved (e.g. the assessment order revises the
--     figure, or only part of a demand remains disputed after a partial
--     payment). Nullable and NOT auto-derived from amount_involved by a
--     generated column, because a preparer must be free to leave it blank
--     when nothing has changed; get_contingent_liabilities_note falls back
--     to amount_involved with COALESCE. Genuinely null on BOTH columns
--     (e.g. the 143(2) scrutiny notice in this project's own seed data,
--     which carries no amount_involved at all — a scrutiny notice does not
--     quantify a demand) is shown to the preparer as "amount not yet
--     quantified", never fabricated as zero.
--
-- `contingent_liabilities` (the new sibling table) covers Schedule III's
-- other two sub-categories: 'guarantee' and the residual 'other' (which
-- also absorbs a non-tax "claim against the company not acknowledged as
-- debt" — a supplier lawsuit is exactly that, and does not belong under
-- 'guarantee'). Deliberately mirrors notices' own shape (a status workflow,
-- a resolved_date instead of notices' response_date) rather than inventing
-- a different vocabulary, so the two sources read as one family in the
-- note. `related_ledger_id` is an OPTIONAL link to an existing party (the
-- bank that issued a guarantee, the claimant in a dispute) — nullable,
-- because plenty of real contingent liabilities (an ongoing High Court writ
-- against the company, a corporate guarantee to a subsidiary that has no
-- ledger in THIS company's books) name no party this company's chart of
-- accounts actually holds.
--
-- SCOPE — COMMITMENTS ARE DELIBERATELY NOT BUILT HERE. Schedule III's Note
-- (i) (contingent liabilities) sits alongside Note (ii) (commitments —
-- capital contracts remaining to be executed, uncalled liability on
-- partly-paid shares/investments) as one combined disclosure, but this
-- task's deliverable list asks only for get_contingent_liabilities_note, and
-- the schema has nowhere that records an EXECUTORY capital contract (a
-- purchase order for a fixed asset not yet delivered) — items.* and
-- orders.* both model completed or in-flight TRANSACTIONS, not undelivered
-- capital commitments. Commitments are out of scope here; see
-- scope_deferred in the structured report, not silently folded into this
-- note as if it were complete.
--
-- ----------------------------------------------------------------------------
-- PART 2 — AS 18 / IND AS 24 RELATED PARTY DISCLOSURES
-- ----------------------------------------------------------------------------
-- Confirmed live: ledgers.is_related_party and ledgers.pan already exist
-- (0087-era columns; is_related_party is NOT NULL boolean default false).
-- This migration does not rebuild that flag — it adds relationship_type on
-- top of it, and the rollup function.
--
-- A SECOND, SKEPTICAL LOOK AT WHAT is_related_party ACTUALLY MEANS — because
-- reusing a flag that already exists is exactly the kind of "obvious"
-- answer this codebase has been burned by before. Reading LedgerManager.tsx
-- (the only UI that sets this column) shows the checkbox is labelled
-- "Specified person (Sec 40A(2)(b))" with helper text describing Form 3CD
-- clause 23 — i.e. this flag was built for INCOME TAX's "specified person"
-- test, not for AS 18. WebSearched the two definitions side by side
-- (taxguru.in and vinodkothari.com, Aug 2026): Sec 40A(2)(b) turns on a 20%
-- "substantial interest" threshold (plus directors/partners/relatives
-- named outright regardless of shareholding); AS 18 turns on CONTROL or
-- SIGNIFICANT INFLUENCE, and explicitly reaches holding/subsidiary/
-- fellow-subsidiary/associate/joint-venture relationships and ALL key
-- management personnel and their relatives, with no shareholding test for
-- KMP at all. The two lists overlap heavily in an Indian SME's real cash
-- flows (a director is both a Sec 40A(2)(b) specified person AND AS 18 key
-- management personnel), but they are not the same test — a hired-in CFO
-- or manager who holds no board seat and no equity is AS 18 key management
-- personnel (disclosure mandatory) while very possibly failing Sec
-- 40A(2)(b)'s substantial-interest threshold. THE CALL MADE HERE: reuse
-- is_related_party as instructed (it already captures the common case —
-- directors, partners, relatives, substantial-interest entities — correctly
-- for both statutes at once, and the task's own brief is explicit that this
-- migration adds relationship_type "on top of" the existing flag rather
-- than rebuilding it), but flag the gap honestly rather than pretend the
-- reuse is exact: a true AS 18 related party who fails the Sec 40A(2)(b)
-- test (typically a non-director, non-shareholder KMP) will NOT be caught
-- by is_related_party and so will NOT appear in get_related_party_note
-- unless a preparer ticks the box for that reason too. Recorded here, and
-- again in scope_deferred, as a real coverage gap — not silently absorbed.
--
-- relationship_type — one column per AS 18 para 3's own relationship
-- categories, so the note can group by "nature of relationship" the way
-- every published AS 18 note does. NULLABLE, and constrained to be null
-- UNLESS is_related_party is true (a party cannot carry a related-party
-- relationship label while not flagged related at all — the two columns
-- must agree, enforced at the database, not just in the form).
--
-- get_related_party_note groups a period's postings by voucher_type
-- (sales/purchase/receipt/payment/journal/…) per related-party ledger —
-- gross debit and credit totals per type, the closest this schema's actual
-- data gets to AS 18's "volume of transactions during the period" without
-- inventing a transaction-nature taxonomy the schema has no other use for
-- — plus a closing balance computed via the SAME
-- app_private.ledger_opening_signed(...) helper get_trial_balance already
-- uses (called with p_before = p_period_end + 1 day, since that helper's
-- own contract is "balance strictly BEFORE p_before"), not a re-derived
-- balance formula.
--
-- ----------------------------------------------------------------------------
-- PART 3 — RECEIVABLE / PAYABLE AGEING SCHEDULE
-- ----------------------------------------------------------------------------
-- Schedule III's ageing-schedule note did not exist before the MCA's 24 Mar
-- 2021 amendment (G.S.R. 207(E), effective FY 2021-22) — confirmed live via
-- WebSearch, not assumed to still be the pre-2021 Schedule III shape (the
-- exact trap this project has been burned by before with a since-abolished
-- advance-tax schedule). Verified the bucket boundaries with a second,
-- skeptical search specifically because they are NOT the same on both
-- sides, which is the "obvious answer" this migration could easily have
-- gotten wrong by assuming symmetry:
--   Trade RECEIVABLES ageing (5 buckets): Less than 6 months, 6 months-1
--     year, 1-2 years, 2-3 years, More than 3 years — plus a "Not Due" row.
--   Trade PAYABLES ageing (4 buckets, no 6-month split): Less than 1 year,
--     1-2 years, 2-3 years, More than 3 years — plus a "Not Due" row, and a
--     mandatory MSME / Others split (the same amendment made the MSME split
--     mandatory for payables specifically, not receivables).
-- Sources: taxguru.in/company-law/analysis-amendments-schedule-iii-
-- companies-act-2013.html, mbgcorp.com/in/insights/amendments-in-
-- schedule-iii, consultease.com Schedule_III_Amendments.pdf (Aug 2026
-- WebSearch).
--
-- get_ageing_schedule REUSES get_party_outstanding's approach — the same
-- FIFO "receipts eat the oldest charge first" aging algorithm (opening
-- balance as the oldest possible document, then each ledger's real
-- voucher_entries consumed oldest-first by whatever reduced the balance) —
-- re-expressed here rather than called as a function, because
-- get_party_outstanding's OWN bucket boundaries (0-30/31-60/61-90/90+ days)
-- are a collections-follow-up convention, not Schedule III's calendar-month
-- buckets, and its return shape has nowhere to carry the MSME/Others split
-- payables need. This is the same "read-only reuse of the computation, not
-- a new balance formula" the task asked for — it does not touch
-- get_party_outstanding itself (which is not on this task's do-not-touch
-- list, but changing its signature would be real, uncalled-for risk to
-- every existing caller).
--
-- "Not due" and buckets are AGED FROM voucher_date, exactly like
-- get_party_outstanding — the schema has no per-invoice due_date (only
-- ledgers.credit_days, a general term never applied per invoice), so this
-- is the same honest simplification that function already makes, not a new
-- gap introduced here. Bucket cut-points use calendar interval arithmetic
-- (p_as_at - interval '6 months', not "182 days") so a 6-month or 1-year
-- cut lands on the calendar date a chartered accountant would actually
-- expect, not a fixed day-count approximation.
--
-- MSME determination for the payables split reads ledgers.udyam_number /
-- msme_category (0043-era columns) — a real, existing signal, not a new
-- assumption. Disputed/undisputed and "unbilled" sub-columns Schedule III's
-- full format also asks for are NOT built: the schema carries no per-
-- invoice disputed flag and no concept of an unbilled-but-accrued due
-- distinct from a posted voucher, so this note surfaces the aggregate
-- ageing only, stated plainly in the report page and in scope_deferred —
-- not fabricated as a false "0 disputed" line.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- notices: two new columns for the contingent-liabilities note
-- ----------------------------------------------------------------------------

alter table public.notices
  add column if not exists is_disclosed_as_contingent boolean not null default true;

alter table public.notices
  add column if not exists contingent_amount numeric;

alter table public.notices
  drop constraint if exists notices_contingent_amount_check;

alter table public.notices
  add constraint notices_contingent_amount_check
  check (contingent_amount is null or contingent_amount >= 0);

-- Backfill: a notice already closed before this migration is presumed
-- resolved (paid or dropped), not left over-included by the column's own
-- true default. Open/responded notices keep the true default. See header.
update public.notices
   set is_disclosed_as_contingent = false
 where status = 'closed';

comment on column public.notices.is_disclosed_as_contingent is
  'Whether this notice currently represents an unprovided contingent liability for Schedule III / AS 29 disclosure — NOT inferable from status (a closed notice may have been paid, in which case it is a settled liability and must be excluded, or dropped, in which case there is no liability at all). Defaults true on a new row; backfilled false for pre-existing closed rows. See 0105.';

comment on column public.notices.contingent_amount is
  'Disclosure amount when it differs from amount_involved (e.g. a revised assessment, or a partly-settled demand). Null falls back to amount_involved in get_contingent_liabilities_note; both null is shown as "not yet quantified", never fabricated as zero. See 0105.';


-- ----------------------------------------------------------------------------
-- contingent_liabilities: the non-tax-authority sibling (guarantees given,
-- disputed commercial claims, other contingently-liable money)
-- ----------------------------------------------------------------------------

create table public.contingent_liabilities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  category text not null check (category in ('claim_not_acknowledged', 'guarantee', 'other')),
  description text not null check (length(trim(description)) > 0),
  -- Optional: the bank that issued a guarantee, the claimant in a dispute —
  -- not every real contingent liability names a party in this company's own
  -- chart of accounts, so this is nullable rather than required.
  related_ledger_id uuid,
  amount numeric not null check (amount >= 0),
  raised_date date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  resolved_date date,
  resolution_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (resolved_date is null or resolved_date >= raised_date)
);

-- COMPOSITE, per this schema's own tenancy convention (see 0085/0088) — a
-- bare id-to-id FK would let a row point at another tenant's ledger.
alter table public.contingent_liabilities
  add constraint contingent_liabilities_related_ledger_id_company_id_fkey
  foreign key (related_ledger_id, company_id) references public.ledgers(id, company_id)
  on delete set null;

create index contingent_liabilities_company_status_idx
  on public.contingent_liabilities(company_id, status, raised_date);

create trigger set_updated_at before update on public.contingent_liabilities
  for each row execute function app_private.set_updated_at();

alter table public.contingent_liabilities enable row level security;

create policy contingent_liabilities_read on public.contingent_liabilities
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy contingent_liabilities_write on public.contingent_liabilities
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.contingent_liabilities is
  'Contingent liabilities NOT sourced from a government notice — guarantees given, disputed commercial claims, other contingently-liable money (Schedule III Note (i)(b)/(c)). Sibling to notices, which covers the tax/ROC-authority-notice sub-category (i)(a). Never posted to the ledger — disclosure only, per AS 29. See 0105.';


-- ----------------------------------------------------------------------------
-- ledgers.relationship_type — AS 18 / Ind AS 24 relationship category
-- ----------------------------------------------------------------------------

alter table public.ledgers
  add column if not exists relationship_type text;

alter table public.ledgers
  drop constraint if exists ledgers_relationship_type_check;

-- One value per AS 18 para 3 category (see migration header for the
-- is_related_party gap this deliberately does not paper over).
alter table public.ledgers
  add constraint ledgers_relationship_type_check
  check (
    relationship_type is null
    or relationship_type in (
      'holding_company',
      'subsidiary_or_fellow_subsidiary',
      'associate_or_joint_venture',
      'individual_with_control_or_significant_influence',
      'relative_of_such_individual',
      'key_management_personnel',
      'relative_of_kmp',
      'enterprise_influenced_by_kmp_or_relative',
      'other'
    )
  );

alter table public.ledgers
  drop constraint if exists ledgers_relationship_type_requires_flag_check;

alter table public.ledgers
  add constraint ledgers_relationship_type_requires_flag_check
  check (relationship_type is null or is_related_party);

comment on column public.ledgers.relationship_type is
  'AS 18 / Ind AS 24 relationship category — only meaningful (and only permitted to be non-null) when is_related_party is true. See 0105 for why is_related_party itself is reused from Sec 40A(2)(b) rather than rebuilt, and the coverage gap that reuse leaves.';


-- ----------------------------------------------------------------------------
-- get_contingent_liabilities_note(company, as_at)
-- ----------------------------------------------------------------------------
create or replace function public.get_contingent_liabilities_note(
  p_company_id uuid,
  p_as_at date default current_date
) returns table (
  source text,
  category text,
  reference text,
  description text,
  amount numeric,
  raised_date date,
  status text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    'notice' as source,
    'Claims against the company not acknowledged as debt' as category,
    n.authority || ' — ' || n.notice_type
      || coalesce(' #' || nullif(n.notice_number, ''), '') as reference,
    n.description,
    coalesce(n.contingent_amount, n.amount_involved) as amount,
    n.notice_date as raised_date,
    n.status
    from public.notices n
   where n.company_id = p_company_id
     and n.is_disclosed_as_contingent
     and n.notice_date <= p_as_at
  union all
  select
    'other' as source,
    case cl.category
      when 'claim_not_acknowledged' then 'Claims against the company not acknowledged as debt'
      when 'guarantee' then 'Guarantees'
      else 'Other money for which the company is contingently liable'
    end as category,
    initcap(replace(cl.category, '_', ' ')) as reference,
    cl.description,
    cl.amount,
    cl.raised_date,
    cl.status
    from public.contingent_liabilities cl
   where cl.company_id = p_company_id
     and cl.raised_date <= p_as_at
     and (cl.resolved_date is null or cl.resolved_date > p_as_at)
   order by 2, 6;
$$;

revoke all on function public.get_contingent_liabilities_note(uuid, date) from public, anon;
grant execute on function public.get_contingent_liabilities_note(uuid, date) to authenticated;

comment on function public.get_contingent_liabilities_note is
  'Schedule III / AS 29 contingent-liabilities note as at a date: UNION of disputed notices (notices.is_disclosed_as_contingent = true, notice_date <= p_as_at) and non-tax contingencies (contingent_liabilities, still open as at that date). amount is null when neither contingent_amount nor amount_involved/amount is quantified — shown to the preparer as "not yet quantified", never coerced to zero. See 0105.';


-- ----------------------------------------------------------------------------
-- get_related_party_note(company, period_start, period_end)
-- ----------------------------------------------------------------------------
create or replace function public.get_related_party_note(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
) returns table (
  ledger_id uuid,
  ledger_name text,
  relationship_type text,
  voucher_type text,
  period_debit numeric,
  period_credit numeric,
  closing_balance numeric,
  closing_balance_type text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with parties as (
    select l.id, l.name, l.relationship_type
      from public.ledgers l
     where l.company_id = p_company_id
       and l.is_related_party
  ),
  txn as (
    select e.ledger_id, v.voucher_type,
           sum(e.debit_amount) as period_debit,
           sum(e.credit_amount) as period_credit
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id
      join parties p on p.id = e.ledger_id
     where e.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date between p_period_start and p_period_end
     group by e.ledger_id, v.voucher_type
  ),
  closing as (
    select p.id as ledger_id,
           -- Same helper get_trial_balance already uses for a closing
           -- figure: signed balance strictly BEFORE p_before, so
           -- period_end + 1 day gives the balance AS AT period_end
           -- inclusive.
           app_private.ledger_opening_signed(p_company_id, p.id, p_period_end + 1, null) as signed
      from parties p
  )
  select
    p.id as ledger_id,
    p.name as ledger_name,
    p.relationship_type,
    t.voucher_type,
    round(coalesce(t.period_debit, 0), 2) as period_debit,
    round(coalesce(t.period_credit, 0), 2) as period_credit,
    round(abs(coalesce(c.signed, 0)), 2) as closing_balance,
    case when coalesce(c.signed, 0) < 0 then 'credit' else 'debit' end as closing_balance_type
    from parties p
    left join txn t on t.ledger_id = p.id
    left join closing c on c.ledger_id = p.id
   order by p.name, t.voucher_type nulls first;
$$;

revoke all on function public.get_related_party_note(uuid, date, date) from public, anon;
grant execute on function public.get_related_party_note(uuid, date, date) to authenticated;

comment on function public.get_related_party_note is
  'AS 18 / Ind AS 24 related-party note: every ledgers.is_related_party = true party, its relationship_type, gross debit/credit per voucher_type posted in the period (the volume-of-transactions disclosure), and closing_balance as at p_period_end via the same app_private.ledger_opening_signed helper get_trial_balance uses. A related party with no movement in the period still appears (voucher_type null) so its closing balance is not silently dropped. See 0105 for the is_related_party/Sec 40A(2)(b) coverage caveat.';


-- ----------------------------------------------------------------------------
-- get_ageing_schedule(company, as_at, party_type)
-- ----------------------------------------------------------------------------
create or replace function public.get_ageing_schedule(
  p_company_id uuid,
  p_as_at date default current_date,
  p_party_type text default 'receivable'
) returns table (
  segment text,
  bucket_label text,
  bucket_order smallint,
  amount numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with cfg as (
    -- Anything other than 'payable' is treated as 'receivable' — the same
    -- unvalidated-parameter looseness get_party_outstanding's own p_role
    -- already has, not a new gap.
    select case when p_party_type = 'payable' then 'payable' else 'receivable' end as ptype
  ),
  party as (
    select l.id, l.name, l.udyam_number, l.msme_category
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
      cross join cfg
     where l.company_id = p_company_id
       and g.ledger_role = (case when cfg.ptype = 'payable' then 'creditor' else 'debtor' end)
  ),
  -- Identical FIFO shape to get_party_outstanding: signed movement per role,
  -- opening balance as the oldest possible document, receipts/payments
  -- consumed against the oldest charges first. Re-expressed here (not
  -- called) because the bucket boundaries and the MSME/Others split below
  -- are not something that function's return shape can carry — see header.
  moves as (
    select e.ledger_id, v.voucher_date,
           case when cfg.ptype = 'receivable'
                then e.debit_amount - e.credit_amount
                else e.credit_amount - e.debit_amount end as delta
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id
      join party p on p.id = e.ledger_id
      cross join cfg
     where e.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
  ),
  opening as (
    select l.id as ledger_id,
           case when cfg.ptype = 'receivable'
                then case when l.opening_balance_type = 'debit'
                          then l.opening_balance_amount else -l.opening_balance_amount end
                else case when l.opening_balance_type = 'credit'
                          then l.opening_balance_amount else -l.opening_balance_amount end
           end as amount
      from public.ledgers l join party p on p.id = l.id cross join cfg
  ),
  charges as (
    select ledger_id, voucher_date, delta from moves where delta > 0
    union all
    select ledger_id, '1900-01-01'::date, amount from opening where amount > 0
  ),
  payments as (
    select ledger_id, sum(-delta) as paid from moves where delta < 0 group by ledger_id
  ),
  ranked as (
    select c.ledger_id, c.voucher_date, c.delta,
           sum(c.delta) over (partition by c.ledger_id order by c.voucher_date,
                              c.delta rows between unbounded preceding and current row) as running
      from charges c
  ),
  aged as (
    select r.ledger_id, r.voucher_date,
           greatest(0, least(r.delta, r.running - coalesce(p.paid, 0))) as remaining
      from ranked r
      left join payments p on p.ledger_id = r.ledger_id
  ),
  -- Bucket boundaries verified live (Schedule III, MCA notification 24 Mar
  -- 2021, effective FY 2021-22): receivables split the first year at 6
  -- months, payables do not. See migration header for sources.
  classified as (
    select
      a.ledger_id,
      a.remaining,
      case when a.voucher_date > p_as_at then 0
           when cfg.ptype = 'payable' then
             case
               when a.voucher_date > (p_as_at - interval '1 year')::date then 1
               when a.voucher_date > (p_as_at - interval '2 years')::date then 2
               when a.voucher_date > (p_as_at - interval '3 years')::date then 3
               else 4
             end
           else
             case
               when a.voucher_date > (p_as_at - interval '6 months')::date then 1
               when a.voucher_date > (p_as_at - interval '1 year')::date then 2
               when a.voucher_date > (p_as_at - interval '2 years')::date then 3
               when a.voucher_date > (p_as_at - interval '3 years')::date then 4
               else 5
             end
      end as bucket_order
      from aged a
      cross join cfg
     where a.remaining > 0
  ),
  segmented as (
    select
      cl.bucket_order,
      case when cfg.ptype = 'payable' then
             case when coalesce(p.udyam_number, '') <> '' or p.msme_category is not null
                  then 'MSME' else 'Others' end
           else 'All'
      end as segment,
      cl.remaining
      from classified cl
      join party p on p.id = cl.ledger_id
      cross join cfg
  ),
  -- Every (segment, bucket) combination this party_type defines is present
  -- even at zero, so the note's column set is fixed regardless of what
  -- happens to be outstanding today — matching the statutory table shape,
  -- which shows every bucket whether or not it currently has a balance.
  shell as (
    select 'All' as segment, o::smallint as bucket_order
      from generate_series(0, 5) o, cfg
     where cfg.ptype = 'receivable'
    union all
    select seg, o::smallint
      from unnest(array['MSME', 'Others']) seg, generate_series(0, 4) o, cfg
     where cfg.ptype = 'payable'
  )
  select
    s.segment,
    case
      when s.bucket_order = 0 then 'Not due'
      when (select ptype from cfg) = 'payable' then
        case s.bucket_order
          when 1 then 'Less than 1 year'
          when 2 then '1-2 years'
          when 3 then '2-3 years'
          else 'More than 3 years'
        end
      else
        case s.bucket_order
          when 1 then 'Less than 6 months'
          when 2 then '6 months - 1 year'
          when 3 then '1-2 years'
          when 4 then '2-3 years'
          else 'More than 3 years'
        end
    end as bucket_label,
    s.bucket_order,
    round(coalesce(sum(sg.remaining), 0), 2) as amount
    from shell s
    left join segmented sg on sg.segment = s.segment and sg.bucket_order = s.bucket_order
   group by s.segment, s.bucket_order
   order by s.segment, s.bucket_order;
$$;

revoke all on function public.get_ageing_schedule(uuid, date, text) from public, anon;
grant execute on function public.get_ageing_schedule(uuid, date, text) to authenticated;

comment on function public.get_ageing_schedule is
  'Schedule III receivable/payable ageing note as at a date. p_party_type ''payable'' ages Sundry Creditors into Not due/<1yr/1-2yr/2-3yr/>3yr split MSME vs Others (ledgers.udyam_number/msme_category); anything else ages Sundry Debtors into Not due/<6mo/6mo-1yr/1-2yr/2-3yr/>3yr, unsegmented. Same FIFO oldest-charge-first aging as get_party_outstanding, re-expressed here for different bucket boundaries and the MSME split — not a new balance computation. Aged from voucher_date (no per-invoice due_date exists in this schema); disputed/undisputed and unbilled sub-columns are not tracked. See 0105.';

notify pgrst, 'reload schema';
