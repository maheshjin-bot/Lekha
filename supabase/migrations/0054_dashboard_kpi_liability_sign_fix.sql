-- ============================================================================
-- 0054 — Dashboard KPIs: GST Liability and TDS Payable had an inverted sign
-- ============================================================================
-- Found during a manual QA sweep, not reported by a user: on the dashboard,
-- a company with 5,000 of TDS genuinely deducted and not yet paid to the
-- government showed "TDS Payable: -5,000.00", and a company whose GST input
-- credit exceeded its output liability (i.e. a company that owes NOTHING and
-- in fact carries excess credit) showed "GST Liability: 1,800.00" — reading
-- exactly backwards from what both labels promise.
--
-- ROOT CAUSE: app_private.ledger_opening_signed (0009) is documented and
-- correctly implemented as "positive = net debit, negative = net credit" —
-- a neutral, ledger-nature-agnostic convention. Every OTHER caller flips
-- that sign where the label demands it: get_balance_sheet (0009) negates it
-- for liability-nature groups, and get_dashboard_kpis' OWN "payables" column
-- goes through get_party_outstanding (0017), which already returns "amount
-- owed" the right way round. gst_liability and tds_payable were the two
-- columns in get_dashboard_kpis (0031) that used the raw signed helper
-- directly with no such flip — a genuine credit balance (the normal, owed
-- direction for a liability account) came out negative, and a genuine debit
-- balance (excess input credit, i.e. NOT owed) came out positive.
--
-- FIX: negate both, exactly as get_balance_sheet already does for the same
-- account nature. A company that owes GST or TDS now shows a positive
-- figure; a company sitting on excess GST input credit now correctly shows
-- a negative (or, once the UI is asked to floor it, zero) "liability".
--
-- Deliberately not touched: the UI (app/(app)/[companyId]/page.tsx) needs no
-- change — it calls formatINR(kpi.gst_liability, ...) directly with no sign
-- logic of its own, confirmed by reading it before writing this fix, so
-- correcting the function alone fixes what renders. That file also carries
-- unrelated uncommitted changes from a concurrent session in this shared
-- working tree, so it was worth ruling out a UI-side fix before touching it.
-- ============================================================================

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

    -- Negated: a genuine liability (net credit) must show positive, matching
    -- the label. See migration header — this is the actual fix.
    coalesce((
      select -sum(app_private.ledger_opening_signed(p_company_id, m.ledger_id, p_as_at + 1, null))
        from public.tax_ledger_map m
       where m.company_id = p_company_id
         and m.purpose in (
           'output_cgst', 'output_sgst', 'output_igst', 'output_cess',
           'input_cgst', 'input_sgst', 'input_igst', 'input_cess',
           'rcm_payable', 'gst_payable', 'gst_refund_receivable'
         )
    ), 0) as gst_liability,

    -- Negated: same fix, same reason.
    coalesce((
      select -app_private.ledger_opening_signed(p_company_id, m.ledger_id, p_as_at + 1, null)
        from public.tax_ledger_map m
       where m.company_id = p_company_id
         and m.gst_registration_id is null
         and m.purpose = 'tds_payable'
    ), 0) as tds_payable;
$$;

comment on function public.get_dashboard_kpis is
  'Six headline numbers for the company dashboard: cash/bank, receivables (total and overdue), payables, GST liability, TDS payable. Every column coalesces to 0, never null. gst_liability and tds_payable are negated from ledger_opening_signed''s raw debit-positive convention (0054) so a genuine amount owed shows positive, matching the label — a company with excess GST input credit (not owed) shows negative, not positive.';
