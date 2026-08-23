-- ============================================================================
-- 0031 — Dashboard summary: KPIs, overdue receivables, needs-attention feed
-- ============================================================================
-- Three read-only reporting RPCs for the company dashboard, following the
-- existing convention (0009, 0017, 0019, 0024): stable, security invoker,
-- set search_path = '', p_company_id first, no explicit is_company_member
-- check — tenant isolation is inherited for free because every function here
-- runs invoker-rights against tables whose own RLS already gates on company
-- membership.
--
-- ORDER: get_overdue_receivables is defined first because get_dashboard_kpis
-- calls it (a plain `select ... from public.get_overdue_receivables(...)`
-- inside a `create or replace function` body is resolved at call time, not
-- deferred like a trigger — the function must already exist).
--
-- get_dashboard_kpis wraps app_private.ledger_opening_signed (0009) and
-- public.get_party_outstanding (0017) for the aggregate numbers, but does
-- NOT reuse get_party_outstanding's own (broken, by design — see 0017's
-- comment) not_due bucketing for receivables_overdue. That column runs off
-- voucher_date alone and never reads ledgers.credit_days, so it cannot answer
-- "how much is actually overdue". get_overdue_receivables is the fix, at
-- invoice grain: it adapts 0017's FIFO payment-allocation CTE chain (charges
-- = positive ledger movements, payments = negative ones, applied
-- oldest-first) but groups the final "how much of THIS voucher survives" by
-- voucher_id instead of collapsing straight to ledger_id, and is the first
-- thing in this codebase to actually read ledgers.credit_days.
--
-- gst_liability enumerates the 11 GST purposes from 0006's seed_gst_ledgers
-- explicitly rather than summing "everything in tax_ledger_map" — that table
-- also carries the unrelated tds_payable row since 0030, and a company can
-- gain further company-wide purposes later that have nothing to do with GST
-- output/input liability.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- get_overdue_receivables
-- ----------------------------------------------------------------------------
-- Per-invoice grain, adapted from 0017's get_party_outstanding FIFO chain.
-- Movements on a debtor ledger are signed exactly as 0017 signs them (debit
-- increases what the party owes); a positive movement is a "charge" and a
-- negative one is a "payment" applied oldest-charge-first — the same
-- technique 0017 uses, generalised over voucher_type rather than filtered to
-- specific types, which is what keeps this function's totals reconcilable
-- against get_party_outstanding's for the same party (a journal adjustment on
-- a debtor ledger is exactly as real a "charge" or "payment" as an invoice or
-- receipt voucher is, and both functions must agree on that).
--
-- The opening balance is folded into the FIFO run (as the oldest possible
-- charge, same as 0017) so it still absorbs payments in the right order, but
-- it has no voucher_id/voucher_number of its own and is excluded from the
-- final per-invoice output — there is no invoice to report it against.
create or replace function public.get_overdue_receivables(
  p_company_id uuid,
  p_as_at date default current_date
) returns table (
  voucher_id uuid,
  voucher_number text,
  party_name text,
  voucher_date date,
  due_date date,
  outstanding numeric,
  days_overdue integer
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
     where l.company_id = p_company_id and g.ledger_role = 'debtor'
  ),
  -- Signed movement per voucher (not per entry — a voucher with more than one
  -- line on the same debtor ledger must still collapse to one invoice-grain
  -- row), summed the same way 0017 sums per entry: debit increases what a
  -- debtor owes.
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
    select ledger_id, null::uuid, null::text, '1900-01-01'::date, amount
      from opening where amount > 0
  ),
  payments as (
    select ledger_id, sum(-delta) as paid from moves where delta < 0 group by ledger_id
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
$$;

comment on function public.get_overdue_receivables is
  'Per-invoice overdue receivables: 0017''s FIFO payment-allocation logic, grouped by voucher_id instead of ledger_id. Due date = voucher_date + coalesce(ledgers.credit_days, 30) — the first reader of that column.';


-- ----------------------------------------------------------------------------
-- get_dashboard_kpis
-- ----------------------------------------------------------------------------
create or replace function public.get_dashboard_kpis(
  p_company_id uuid,
  p_as_at date default current_date
) returns table (
  cash_bank numeric,
  receivables numeric,
  receivables_overdue numeric,
  payables numeric,
  gst_liability numeric,
  tds_payable numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    -- Cash/bank: every ledger_role='cash_bank' ledger, closing balance as-at
    -- p_as_at (ledger_opening_signed at p_as_at + 1 — the same "opening of
    -- tomorrow is closing of today" trick get_balance_sheet uses).
    coalesce((
      select sum(app_private.ledger_opening_signed(p_company_id, l.id, p_as_at + 1, null))
        from public.ledgers l
        join public.account_groups g on g.id = l.group_id
       where l.company_id = p_company_id
         and g.ledger_role = 'cash_bank'
    ), 0) as cash_bank,

    coalesce((
      select sum(o.outstanding)
        from public.get_party_outstanding(p_company_id, p_as_at, 'debtor') o
    ), 0) as receivables,

    coalesce((
      select sum(o.outstanding)
        from public.get_overdue_receivables(p_company_id, p_as_at) o
    ), 0) as receivables_overdue,

    coalesce((
      select sum(o.outstanding)
        from public.get_party_outstanding(p_company_id, p_as_at, 'creditor') o
    ), 0) as payables,

    -- GST liability: the 11 GST purposes from 0006's seed_gst_ledgers,
    -- enumerated explicitly — NOT "everything in tax_ledger_map", which also
    -- holds the unrelated tds_payable purpose since 0030.
    coalesce((
      select sum(app_private.ledger_opening_signed(p_company_id, m.ledger_id, p_as_at + 1, null))
        from public.tax_ledger_map m
       where m.company_id = p_company_id
         and m.purpose in (
           'output_cgst', 'output_sgst', 'output_igst', 'output_cess',
           'input_cgst', 'input_sgst', 'input_igst', 'input_cess',
           'rcm_payable', 'gst_payable', 'gst_refund_receivable'
         )
    ), 0) as gst_liability,

    -- TDS payable: the single company-wide (gst_registration_id is null)
    -- ledger 0030 guarantees exists for every company.
    coalesce((
      select app_private.ledger_opening_signed(p_company_id, m.ledger_id, p_as_at + 1, null)
        from public.tax_ledger_map m
       where m.company_id = p_company_id
         and m.gst_registration_id is null
         and m.purpose = 'tds_payable'
    ), 0) as tds_payable;
$$;

comment on function public.get_dashboard_kpis is
  'Six headline numbers for the company dashboard: cash/bank, receivables (total and overdue), payables, GST liability, TDS payable. Every column coalesces to 0, never null, so a company with no bank ledgers or no GST registration still returns a clean zero row.';


-- ----------------------------------------------------------------------------
-- get_needs_attention
-- ----------------------------------------------------------------------------
-- Unions four differently-shaped sources into one feed: filings due within a
-- week (get_compliance_calendar), unmatched bank lines (one summary row
-- across every cash_bank ledger, via get_bank_reconciliation_summary),
-- overdue invoices capped at the 10 worst (get_overdue_receivables), and
-- pending voucher approvals (a plain count against vouchers.approval_status,
-- 0028). plpgsql only because the shapes differ enough that building this as
-- CTEs is clearer than juggling five separate RETURN QUERY statements whose
-- combined ordering would then be impossible to control in one place — a
-- single RETURN QUERY over a UNION ALL keeps "bad before warn" as one ORDER
-- BY instead of five uncoordinated ones.
create or replace function public.get_needs_attention(
  p_company_id uuid
) returns table (
  category text,
  label text,
  detail text,
  severity text,
  href text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  return query
  with bank_ledgers as (
    select l.id
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id and g.ledger_role = 'cash_bank'
  ),
  bank_summary as (
    select coalesce(sum(s.unmatched_statement_count), 0)::int as total_unmatched
      from bank_ledgers bl
      cross join lateral public.get_bank_reconciliation_summary(p_company_id, bl.id, current_date) s
  ),
  pending as (
    select count(*)::int as cnt
      from public.vouchers
     where company_id = p_company_id and is_deleted = false and approval_status = 'pending'
  ),
  calendar_rows as (
    select r.category, r.label, r.detail,
           case when r.due_date <= current_date + 2 then 'bad' else 'warn' end as severity,
           '/' || p_company_id || '/reports/compliance-calendar' as href,
           (r.due_date - current_date) as sort_num
      from public.get_compliance_calendar(p_company_id, current_date, current_date + 7) r
  ),
  recon_rows as (
    select 'Reconciliation'::text as category,
           bs.total_unmatched || ' bank line' ||
             (case when bs.total_unmatched = 1 then '' else 's' end) || ' unmatched' as label,
           null::text as detail,
           'warn'::text as severity,
           '/' || p_company_id || '/reconciliation' as href,
           0 as sort_num
      from bank_summary bs
     where bs.total_unmatched > 0
  ),
  overdue_rows as (
    select 'Receivables'::text as category,
           'Invoice ' || r.voucher_number || ' overdue' as label,
           r.days_overdue || ' days' as detail,
           case when r.days_overdue > 30 then 'bad' else 'warn' end as severity,
           '/' || p_company_id || '/vouchers/' || r.voucher_id as href,
           -r.days_overdue as sort_num
      from public.get_overdue_receivables(p_company_id, current_date) r
     order by r.days_overdue desc
     limit 10
  ),
  approval_rows as (
    select 'Approvals'::text as category,
           pd.cnt || ' voucher' || (case when pd.cnt = 1 then '' else 's' end) || ' pending approval' as label,
           null::text as detail,
           'warn'::text as severity,
           '/' || p_company_id || '/approvals' as href,
           0 as sort_num
      from pending pd
     where pd.cnt > 0
  ),
  all_rows as (
    select * from calendar_rows
    union all select * from recon_rows
    union all select * from overdue_rows
    union all select * from approval_rows
  )
  select ar.category, ar.label, ar.detail, ar.severity, ar.href
    from all_rows ar
   order by case ar.severity when 'bad' then 0 else 1 end, ar.category, ar.sort_num;
end;
$$;

comment on function public.get_needs_attention is
  'Dashboard feed: filings due within 7 days, unmatched bank lines, the 10 most-overdue invoices, and pending voucher approvals. Ordered bad-severity first, then warn, then category.';
