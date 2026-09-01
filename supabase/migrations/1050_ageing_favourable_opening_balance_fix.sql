-- ============================================================================
-- 1050 — Ageing drops a favourable opening balance instead of netting it
-- ============================================================================
-- Confirmed live earlier today: Nexgen Softwares' party "Metro Enterprises"
-- carries an opening balance of 1,000 CR (a debtor who had already paid an
-- advance before this ledger's opening date — the FAVOURABLE direction for a
-- debtor). One 8,260 sales invoice was raised against them after that. Both
-- /reports/outstanding and the Notes to Accounts ageing note show the full
-- 8,260 as outstanding — the 1,000 advance is never netted off — overstating
-- receivables by exactly that amount against what Trial Balance shows
-- (7,260 net).
--
-- ROOT CAUSE, traced in both 0017's get_party_outstanding and 0105's
-- get_ageing_schedule (the latter's own header says it re-implements 0017's
-- FIFO logic rather than calling it, so both carry the identical defect):
--
--   opening as (
--     select ... case when <role> then ... else -<amount> end as amount ...
--   ),
--   charges as (
--     select ledger_id, voucher_date, delta from moves where delta > 0
--     union all
--     select ledger_id, '1900-01-01'::date, amount from opening where amount > 0
--   ),
--   payments as (
--     select ledger_id, sum(-delta) as paid from moves where delta < 0 group by ledger_id
--   ),
--
-- `opening` is signed so that an UNFAVOURABLE balance (a debtor's opening
-- debit, a creditor's opening credit — the normal "they owe us" / "we owe
-- them" case) comes out positive, and a FAVOURABLE balance (a debtor's
-- opening CREDIT — an advance already received; a creditor's opening DEBIT —
-- a prepayment already made) comes out negative. `charges` only takes
-- `amount > 0` from `opening`, so a favourable opening is excluded from
-- charges correctly (it is not a charge — it should never have been one).
-- But `payments` is built ONLY from `moves where delta < 0` — it never looks
-- at `opening` at all. So a negative opening amount is not a charge (rightly
-- excluded from `charges`) and not counted as a payment either (wrongly
-- excluded from `payments`) — it is simply dropped on the floor. The dollar
-- value of every favourable opening balance vanishes from the ageing
-- calculation entirely, instead of standing as an existing credit against
-- the party from day one, the same way any other receipt/payment already
-- does.
--
-- THE FIX — one line changed in each function's `payments` CTE, everything
-- else (including `charges`, `ranked`, `aged`, the bucket logic) untouched:
-- `payments` now UNIONs in `-amount from opening where amount < 0` alongside
-- the existing `-delta from moves where delta < 0`, summed together per
-- ledger. A favourable opening balance becomes exactly what it economically
-- is — money already received/paid before any of this ledger's recorded
-- vouchers — and `aged`'s existing `running - paid` FIFO consumption (a flat
-- per-ledger `paid` total subtracted off the running sum of charges, oldest
-- first) then nets it against the earliest charge(s) automatically, with no
-- other change needed. An unfavourable opening balance's path (through
-- `charges`, unaffected by this migration) is completely untouched, so the
-- normal, everyday case behaves exactly as before.
--
-- Both functions are CREATE OR REPLACE with their existing signatures
-- unchanged (same params, same return columns/types) — this is a pure
-- internal-logic fix. No frontend file calls anything new: grepped every
-- caller (app/(app)/[companyId]/reports/outstanding/page.tsx,
-- .../reports/msme/page.tsx, .../reports/notes-to-accounts/page.tsx,
-- tests/db/invariants.test.ts) and all of them already call these two
-- functions by their existing names/params and read the existing column
-- names generically — nothing here requires a matching frontend change, and
-- nothing here changes behaviour for anyone until this migration is applied.
--
-- WHY THIS DOES NOT BREAK THE EXISTING CROSS-FUNCTION INVARIANT TEST
-- ("the receivable ageing total matches the sum of get_party_outstanding's
-- own positive (receivable) balances", tests/db/invariants.test.ts) — both
-- functions carried the identical bug, so the test was passing by both sides
-- being identically wrong together, not because either was right. This
-- migration fixes both the same way, so the two totals still agree
-- afterwards — now because both sides are correct, not coincidentally.
-- ============================================================================

create or replace function public.get_party_outstanding(
  p_company_id uuid,
  p_as_at date default current_date,
  -- 'debtor' for receivables, 'creditor' for payables.
  p_role text default 'debtor'
) returns table (
  ledger_id uuid,
  ledger_name text,
  outstanding numeric,
  not_due numeric,
  days_0_30 numeric,
  days_31_60 numeric,
  days_61_90 numeric,
  days_over_90 numeric,
  oldest_date date
)
language sql
stable
security invoker
set search_path = ''
as $$
  with party as (
    select l.id, l.name, l.credit_days
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id and g.ledger_role = p_role
  ),
  -- Signed movement: for a debtor a debit increases what they owe; for a
  -- creditor it is the other way round.
  moves as (
    select e.ledger_id, v.voucher_date,
           case when p_role = 'debtor'
                then e.debit_amount - e.credit_amount
                else e.credit_amount - e.debit_amount end as delta
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id
      join party p on p.id = e.ledger_id
     where e.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
  ),
  -- Opening balance counts as the oldest possible document. Positive here
  -- means UNFAVOURABLE (a debtor's opening debit, a creditor's opening
  -- credit — they owe us / we owe them, same direction a charge already
  -- moves); negative means FAVOURABLE (a debtor's opening credit — an
  -- advance already received; a creditor's opening debit — a prepayment
  -- already made).
  opening as (
    select l.id as ledger_id,
           case when p_role = 'debtor'
                then case when l.opening_balance_type = 'debit'
                          then l.opening_balance_amount else -l.opening_balance_amount end
                else case when l.opening_balance_type = 'credit'
                          then l.opening_balance_amount else -l.opening_balance_amount end
           end as amount
      from public.ledgers l join party p on p.id = l.id
  ),
  -- Everything that increased the balance, oldest first, plus the total that
  -- reduced it. Receipts are then eaten off the top of that list.
  charges as (
    select ledger_id, voucher_date, delta from moves where delta > 0
    union all
    select ledger_id, '1900-01-01'::date, amount from opening where amount > 0
  ),
  -- A FAVOURABLE opening balance (opening.amount < 0) is money already
  -- received/paid before this ledger's earliest recorded voucher — it must
  -- net against the earliest charge(s) exactly like any other receipt or
  -- payment does. Previously this branch did not exist at all, so a
  -- favourable opening balance was silently excluded from both `charges`
  -- (correctly) and `payments` (incorrectly) and simply vanished. See header.
  payments as (
    select ledger_id, sum(paid) as paid
      from (
        select ledger_id, sum(-delta) as paid from moves where delta < 0 group by ledger_id
        union all
        select ledger_id, -amount as paid from opening where amount < 0
      ) combined
     group by ledger_id
  ),
  ranked as (
    select c.ledger_id, c.voucher_date, c.delta,
           sum(c.delta) over (partition by c.ledger_id order by c.voucher_date,
                              c.delta rows between unbounded preceding and current row) as running
      from charges c
  ),
  -- What remains of each charge after the running total of payments has been
  -- applied to everything older than it.
  aged as (
    select r.ledger_id, r.voucher_date,
           greatest(0, least(r.delta, r.running - coalesce(p.paid, 0))) as remaining
      from ranked r
      left join payments p on p.ledger_id = r.ledger_id
  ),
  bucketed as (
    select a.ledger_id,
           sum(a.remaining) as outstanding,
           sum(a.remaining) filter (where p_as_at - a.voucher_date < 0)               as not_due,
           sum(a.remaining) filter (where p_as_at - a.voucher_date between 0 and 30)  as b0,
           sum(a.remaining) filter (where p_as_at - a.voucher_date between 31 and 60) as b1,
           sum(a.remaining) filter (where p_as_at - a.voucher_date between 61 and 90) as b2,
           sum(a.remaining) filter (where p_as_at - a.voucher_date > 90)              as b3,
           min(a.voucher_date) filter (where a.remaining > 0)                         as oldest
      from aged a
     where a.remaining > 0
     group by a.ledger_id
  )
  select p.id, p.name,
         coalesce(b.outstanding, 0),
         coalesce(b.not_due, 0), coalesce(b.b0, 0), coalesce(b.b1, 0),
         coalesce(b.b2, 0), coalesce(b.b3, 0),
         b.oldest
    from party p
    left join bucketed b on b.ledger_id = p.id
   where coalesce(b.outstanding, 0) <> 0
   order by coalesce(b.b3, 0) desc, coalesce(b.outstanding, 0) desc;
$$;

comment on function public.get_party_outstanding is
  'FIFO ageing: receipts applied oldest-first. Inferred, not bill-wise allocated — a lender reading a drawing power calculation is entitled to know which. A favourable opening balance (an advance already received from a debtor, a prepayment already made to a creditor) is netted against the earliest charge(s) as an existing payment/credit from day one — see 1050.';


-- ----------------------------------------------------------------------------
-- get_ageing_schedule(company, as_at, party_type) — 0105's Schedule III note.
-- Identical fix, mirrored into its independently-expressed copy of the same
-- FIFO CTEs (0105's own header explains why it re-expresses rather than
-- calls get_party_outstanding: different bucket boundaries and the MSME
-- split, not a different balance formula).
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
  -- Positive = UNFAVOURABLE (they owe us / we owe them); negative =
  -- FAVOURABLE (an advance already received from a debtor, a prepayment
  -- already made to a creditor). See get_party_outstanding and this
  -- migration's header.
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
  -- A favourable opening balance nets against the earliest charge(s) as an
  -- existing payment/credit from day one — see 1050 header. Previously this
  -- branch did not exist and the amount was silently dropped.
  payments as (
    select ledger_id, sum(paid) as paid
      from (
        select ledger_id, sum(-delta) as paid from moves where delta < 0 group by ledger_id
        union all
        select ledger_id, -amount as paid from opening where amount < 0
      ) combined
     group by ledger_id
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
  -- months, payables do not. See 0105's header for sources.
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
  'Schedule III receivable/payable ageing note as at a date. p_party_type ''payable'' ages Sundry Creditors into Not due/<1yr/1-2yr/2-3yr/>3yr split MSME vs Others (ledgers.udyam_number/msme_category); anything else ages Sundry Debtors into Not due/<6mo/6mo-1yr/1-2yr/2-3yr/>3yr, unsegmented. Same FIFO oldest-charge-first aging as get_party_outstanding, re-expressed here for different bucket boundaries and the MSME split — not a new balance computation. Aged from voucher_date (no per-invoice due_date exists in this schema); disputed/undisputed and unbilled sub-columns are not tracked. A favourable opening balance is netted against the earliest charge(s) from day one — see 1050. See 0105.';

notify pgrst, 'reload schema';
