-- ============================================================================
-- 1250 — Ageing's 1900-01-01 sentinel was leaking to the screen; overdue
--        receivables never netted a favourable opening balance either
-- ============================================================================
-- Confirmed live by real-usage testing (30-31 Aug 2026): a customer created
-- with only an opening balance and no invoice showed up on
-- /reports/outstanding with "oldest 1900-01-01" and got bucketed as 90+ days
-- overdue — a brand-new customer shown as a 126-year-old debt. Root cause:
-- get_party_outstanding and get_ageing_schedule both treat an opening
-- balance as "the oldest possible document" for FIFO running-total purposes
-- (correct — a receipt must net against it before any later invoice), and
-- both do that by literally dating it '1900-01-01' (see their own charges
-- CTEs). That sentinel is fine internally, as long as nothing downstream
-- ever surfaces it — but get_party_outstanding's own oldest_date column IS
-- exactly that voucher_date, taken via min(), and get_ageing_schedule's own
-- bucket_order is computed directly from the same voucher_date. Both leak
-- the sentinel straight to what a lender or auditor reads.
--
-- 1050 (the same day) already fixed a distinct bug in these same two
-- functions — a favourable opening balance being dropped from `payments`
-- entirely — confirmed live and unaffected by this migration; both fixes
-- coexist in the CTE shape 1050 already established.
--
-- WHAT THIS DOES: replaces the '1900-01-01'::date literal with the
-- company's own companies.book_beginning_date in the `opening` charges
-- branch of get_party_outstanding, get_ageing_schedule, AND
-- get_overdue_receivables (which has the identical literal, confirmed by
-- reading its live definition, even though its own final SELECT filters to
-- voucher_id is not null — a real voucher row — so the sentinel never
-- reaches ITS output directly today; fixed anyway for the same reason 1050
-- fixed three copies of the same FIFO logic together, not two: consistency,
-- and because a future consumer of get_overdue_receivables' internal ranking
-- could depend on it being a real date). A company's own book-start date is
-- always a real, meaningful date rather than an arbitrary 626-year-old
-- placeholder — for a company whose books began recently, an opening
-- balance now buckets honestly (e.g. "less than 6 months" for a company
-- three months old) instead of automatically defaulting to the oldest
-- bucket regardless of how old the company's own books actually are. Still
-- sorts before any real voucher in the ordinary case; the one exception is
-- the already-named, separately-tracked gap where a voucher can be dated
-- before a company's own book_beginning_date (see the cash-flow footnote
-- fix, same day) — not attempted here, out of scope for this bug.
--
-- get_overdue_receivables ALSO gets 1050's other fix: its own `payments`
-- CTE, like the pre-fix versions of the other two, only summed `moves where
-- delta < 0` and never read a favourable opening balance at all — so a
-- customer with an advance and one overdue invoice would show the FULL
-- invoice amount as overdue rather than the amount actually still owed
-- past the advance. Confirmed by reading its live definition: this branch
-- was genuinely missing, not just differently shaped. This is the
-- dashboard/needs-attention overdue-receivables feed, not the same code
-- path /reports/outstanding uses (get_party_outstanding), so it needed its
-- own fix rather than being covered by 1050.
--
-- DELIBERATELY NOT DONE: no attempt to prevent or flag a voucher dated
-- before a company's own book_beginning_date — a separate, deliberate gap,
-- same reasoning as the cash-flow footnote fix landed the same day.

create or replace function public.get_party_outstanding(p_company_id uuid, p_as_at date default current_date, p_role text default 'debtor'::text)
returns table(ledger_id uuid, ledger_name text, outstanding numeric, not_due numeric, days_0_30 numeric, days_31_60 numeric, days_61_90 numeric, days_over_90 numeric, oldest_date date)
language sql
stable
set search_path to ''
as $function$
  with book_start as (
    select coalesce(book_beginning_date, '1900-01-01'::date) as d
      from public.companies where id = p_company_id
  ),
  party as (
    select l.id, l.name, l.credit_days
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id and g.ledger_role = p_role
  ),
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
  charges as (
    select ledger_id, voucher_date, delta from moves where delta > 0
    union all
    select ledger_id, (select d from book_start), amount from opening where amount > 0
  ),
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
$function$;

create or replace function public.get_ageing_schedule(p_company_id uuid, p_as_at date default current_date, p_party_type text default 'receivable'::text)
returns table(segment text, bucket_label text, bucket_order smallint, amount numeric)
language sql
stable
set search_path to ''
as $function$
  with book_start as (
    select coalesce(book_beginning_date, '1900-01-01'::date) as d
      from public.companies where id = p_company_id
  ),
  cfg as (
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
    select ledger_id, (select d from book_start), amount from opening where amount > 0
  ),
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
$function$;

create or replace function public.get_overdue_receivables(
  p_company_id uuid,
  p_as_at date default current_date
)
returns table(voucher_id uuid, voucher_number text, party_name text, voucher_date date, due_date date, outstanding numeric, days_overdue integer)
language sql
stable
set search_path to ''
as $function$
  with book_start as (
    select coalesce(book_beginning_date, '1900-01-01'::date) as d
      from public.companies where id = p_company_id
  ),
  party as (
    select l.id, l.name, l.credit_days
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id and g.ledger_role = 'debtor'
  ),
  moves as (
    select e.voucher_id, e.ledger_id, v.voucher_date, v.voucher_number,
           sum(e.debit_amount - e.credit_amount) as delta
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id
      join party p on p.id = e.ledger_id
     where e.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
     group by e.voucher_id, e.ledger_id, v.voucher_date, v.voucher_number
  ),
  opening as (
    select l.id as ledger_id,
           case when l.opening_balance_type = 'debit'
                then l.opening_balance_amount else -l.opening_balance_amount end as amount
      from public.ledgers l join party p on p.id = l.id
  ),
  charges as (
    select ledger_id, voucher_id, voucher_number, voucher_date, delta
      from moves where delta > 0
    union all
    select ledger_id, null::uuid, null::text, (select d from book_start), amount
      from opening where amount > 0
  ),
  -- The fix 1050 already applied to get_party_outstanding/get_ageing_schedule
  -- the same day: a favourable opening balance (a debtor's opening CREDIT —
  -- an advance already received) must net against the earliest charge like
  -- any other payment. This branch was missing entirely before this
  -- migration, so a customer with an advance and one overdue invoice showed
  -- the full invoice amount as overdue rather than what's actually still
  -- owed past the advance.
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
    select c.ledger_id, c.voucher_id, c.voucher_number, c.voucher_date, c.delta,
           sum(c.delta) over (partition by c.ledger_id order by c.voucher_date,
                              c.delta, c.voucher_id rows between unbounded preceding and current row) as running
      from charges c
  ),
  aged as (
    select r.ledger_id, r.voucher_id, r.voucher_number, r.voucher_date,
           greatest(0, least(r.delta, r.running - coalesce(pmt.paid, 0))) as remaining
      from ranked r
      left join payments pmt on pmt.ledger_id = r.ledger_id
  )
  select a.voucher_id, a.voucher_number, p.name,
         a.voucher_date,
         (a.voucher_date + coalesce(p.credit_days, 30)) as due_date,
         a.remaining as outstanding,
         (p_as_at - (a.voucher_date + coalesce(p.credit_days, 30)))::int as days_overdue
    from aged a
    join party p on p.id = a.ledger_id
   where a.voucher_id is not null
     and a.remaining > 0
     and p_as_at > (a.voucher_date + coalesce(p.credit_days, 30))
   order by days_overdue desc, a.voucher_date;
$function$;

comment on function public.get_party_outstanding is
  'Per-party ageing (receivable or payable) via FIFO consumption of charges by payments, opening balance treated as the oldest document dated at the company''s own book_beginning_date rather than an arbitrary sentinel (1250) — favourable opening balances net against the earliest charge (1050).';

comment on function public.get_ageing_schedule is
  'Schedule III ageing note (MSME/Others split for payables, flat for receivables) via the identical FIFO shape as get_party_outstanding, re-expressed rather than called since the bucket/segment shape differs. Opening balance dated at book_beginning_date (1250); favourable opening balances net against the earliest charge (1050).';

comment on function public.get_overdue_receivables is
  'Individual overdue invoices (not aggregated by party) for the dashboard and needs-attention feed. Opening balance treated as the oldest document dated at book_beginning_date (1250, though never itself returned — voucher_id is not null filters it out); favourable opening balances now net against the earliest real invoice (1250, the same fix 1050 applied to the two ageing-aggregate functions the same day).';
