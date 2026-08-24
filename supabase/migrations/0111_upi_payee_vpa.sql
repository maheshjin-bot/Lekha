-- ============================================================================
-- 0111 — UPI payee VPA, and a payment QR on the sales invoice print layout
-- ============================================================================
-- Deliberately split out from any payment-gateway integration: no contract,
-- no licence, no gateway. NPCI's own published deep-link format —
-- upi://pay?pa=<payee-vpa>&pn=<payee-name>&am=<amount>&tn=<note>&cu=INR,
-- confirmed live (WebSearch, Aug 2026) against NPCI's UPI Linking
-- Specifications and multiple current integration guides — is a STATIC
-- STRING. It needs nothing this app doesn't already have except one new
-- fact: the company's own UPI VPA (payee address, e.g. name@bank). A grep
-- across supabase/migrations and app/components/lib for "upi"/"vpa" before
-- writing this migration found no such column anywhere in the schema.
--
-- PARAMETER SET, AND WHY tr IS INCLUDED BUT mc IS NOT.
-- pa/pn/am/cu/tn are the core parameters every source agrees on. tr
-- (transaction reference) is described everywhere as optional but commonly
-- included — "a unique transaction reference ID" — and this app already has
-- a natural value for it, the voucher number, so it is included. mc
-- (merchant category code) is skipped: it identifies a REGISTERED MERCHANT
-- category, which this app has no field for and would have to fabricate;
-- omitting an optional parameter this schema cannot honestly fill is the
-- same discipline this codebase already applies elsewhere (see STATUTORY
-- CORRECTNESS in AGENTS.md — don't fabricate a value where the honest answer
-- is "not tracked"). tid (transaction ID) is likewise skipped — it is a PSP-
-- assigned identifier, not something a static deep link from an unregistered
-- payee can meaningfully supply.
--
-- upi_vpa LIVES ON companies, NOT branches — a UPI VPA is registered to a
-- bank ACCOUNT, and unlike the branch-level GST registrations this app
-- already models (0007), there is no per-branch UPI account anywhere in this
-- schema; the print page already falls back from a branch GSTIN to
-- company.pan when no branch is selected, and this column follows that same
-- "company is the fallback identity" shape.
--
-- VALIDATION IS DELIBERATELY LOOSE. A VPA is <local-part>@<handle>: the
-- local part is 2-256 chars of letters/digits/dot/hyphen/underscore, the
-- handle is assigned by NPCI per PSP/bank and is NOT a fixed, enumerable
-- list (okhdfcbank, ybl, ibl, axl, paytm, and dozens more, added over time
-- as new PSPs onboard) — same reasoning 0085 gives for leaving the PF
-- establishment code unchecked: a pattern tight enough to be useful would
-- reject somebody's real, working VPA. The CHECK below only enforces the
-- shape (something@something), not a closed handle list.
--
-- get_invoice_outstanding — WHY THIS IS A NEW FUNCTION, NOT A REUSE.
-- The print page needs one specific fact get_party_outstanding (0017) and
-- get_overdue_receivables (0031) do not individually give: how much of THIS
-- ONE INVOICE remains unpaid, regardless of whether it is yet overdue.
-- get_party_outstanding answers at LEDGER grain (wrong: a customer with one
-- paid and one unpaid invoice would show a QR on the PAID one too, which the
-- feature spec explicitly forbids). get_overdue_receivables answers at
-- INVOICE grain but only for invoices already past their due date (wrong the
-- other way: a same-day, well-within-terms invoice would never get a QR at
-- all, which defeats the point of printing one). Neither existing function
-- is touched — both stay exactly as every other report already depends on
-- them. This is the same "adapt the FIFO chain for a new grain, don't modify
-- the original" discipline 0031 itself used on 0017's chain, and that 0096
-- and 0105 both repeated later: oldest-charge-first allocation of payments,
-- scoped here to the single debtor ledger the target voucher actually posted
-- against (found from the voucher's own entries, not assumed from
-- party_ledger_id, so it is correct even if a voucher's entries and its
-- declared party_ledger_id ever disagree) and returning the FIFO remainder
-- for that one voucher_id only. A voucher with no debtor-role leg at all —
-- purchase, journal, credit/debit note, or a sales voucher that for whatever
-- reason never touched a debtor ledger — matches no row and the function
-- returns 0, which is a second, independent reason (the print page's own
-- voucher_type === 'sales' gate is the first) such a voucher can never
-- surface a QR.
-- ============================================================================

alter table public.companies
  add column if not exists upi_vpa text;

alter table public.companies
  drop constraint if exists companies_upi_vpa_check;

alter table public.companies
  add constraint companies_upi_vpa_check
  check (
    upi_vpa is null
    -- {2,100}, not {2,256}: Postgres's regex engine caps a repetition bound
    -- at 255 (RE_DUP_MAX) and rejects anything past it outright — caught
    -- live ("invalid repetition count(s)") by this migration's own
    -- verification query, not by re-reading the pattern. 100 is still far
    -- past any VPA local part actually seen in the wild (NPCI's own
    -- published examples and every validator found in research top out
    -- around 60).
    or upi_vpa ~ '^[a-zA-Z0-9.\-_]{2,100}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$'
  );

comment on column public.companies.upi_vpa is
  'This company''s own UPI Virtual Payment Address (payee VPA, e.g. name@bank) used to render a payment QR on the sales invoice print layout. Format-checked loosely (local-part@handle) only — NPCI PSP handles are not a fixed list, so no handle whitelist is enforced. See 0111.';

-- No new RLS policy: companies already has companies_update (0003), gated by
-- app_private.is_company_admin(id), and Postgres RLS is row-level, not
-- column-level — a column added to an existing table is covered by that
-- table's existing policies automatically. companies_read (0003, member-
-- gated) already covers SELECT for anyone who can open the company, which is
-- who needs to see the print page.
--
-- COLUMN-LEVEL GRANT — REQUIRED, AND EASY TO FORGET (confirmed live, not
-- theoretical). 0044 revoked authenticated's table-wide SELECT/UPDATE on
-- companies (to keep password_hash unreadable/unwritable outside its own
-- RPCs) and re-granted an explicit column list instead. Any column added to
-- companies AFTER 0044 inherits NEITHER the table-wide grant (revoked) NOR a
-- column-level one (never added) unless its own migration adds it — RLS
-- alone is not enough, because Postgres checks the underlying GRANT before
-- it ever reaches the RLS policy. This was verified live, live, while
-- writing this migration, on FOUR PRE-EXISTING columns: 0085
-- (pf_establishment_code, esi_employer_code, lin, shops_establishment_reg)
-- added company columns with a working UI (EmployerRegistrationsForm) that
-- reads and writes them via plain `.from("companies").select/update(...)`,
-- but never extended 0044's grant list —
-- `select pf_establishment_code from companies ...` as the real authenticated
-- admin user (rolled-back transaction) fails with 42501 permission denied
-- for table companies. That bug is 0085's, not this migration's to fix
-- silently as a drive-by — flagged separately in this session instead. It
-- is named here only so upi_vpa does not join it.
grant select (upi_vpa) on public.companies to authenticated;
grant update (upi_vpa) on public.companies to authenticated;


-- ----------------------------------------------------------------------------
-- get_invoice_outstanding(company, voucher, as_at) — FIFO remainder for ONE
-- invoice, at any age, not only once it is overdue. See migration header.
-- ----------------------------------------------------------------------------
create or replace function public.get_invoice_outstanding(
  p_company_id uuid,
  p_voucher_id uuid,
  p_as_at date default current_date
) returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  with target_ledger as (
    -- The debtor-role ledger this specific voucher actually posted against,
    -- read from its own entries rather than trusted from vouchers.party_
    -- ledger_id, so a mismatch between the two (if one ever existed) cannot
    -- silently misprice the QR. limit 1: a voucher legitimately touching two
    -- different debtor ledgers is not a shape this schema's invoicing flow
    -- produces, but if it ever did, picking one deterministically is safer
    -- than an unbounded fan-out here.
    select l.id
      from public.voucher_entries e
      join public.ledgers l on l.id = e.ledger_id
      join public.account_groups g on g.id = l.group_id
     where e.voucher_id = p_voucher_id
       and e.company_id = p_company_id
       and g.ledger_role = 'debtor'
     limit 1
  ),
  -- Every posting against that one ledger, up to p_as_at — needed in full
  -- because FIFO allocation of payments to charges requires the whole
  -- history, even though only one voucher_id's remainder is returned below.
  moves as (
    select e.voucher_id, v.voucher_date,
           sum(e.debit_amount - e.credit_amount) as delta
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id
      join target_ledger tl on true
     where e.company_id = p_company_id
       and e.ledger_id = tl.id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
     group by e.voucher_id, v.voucher_date
  ),
  opening as (
    select case when l.opening_balance_type = 'debit'
                then l.opening_balance_amount else -l.opening_balance_amount end as amount
      from public.ledgers l
      join target_ledger tl on tl.id = l.id
  ),
  charges as (
    select voucher_id, voucher_date, delta from moves where delta > 0
    union all
    select null::uuid, '1900-01-01'::date, amount from opening where amount > 0
  ),
  payments as (
    select coalesce(sum(-delta), 0) as paid from moves where delta < 0
  ),
  ranked as (
    select c.voucher_id, c.delta,
           sum(c.delta) over (
             order by c.voucher_date, c.delta, c.voucher_id
             rows between unbounded preceding and current row
           ) as running
      from charges c
  )
  select coalesce(
    (select greatest(0, least(r.delta, r.running - (select paid from payments)))
       from ranked r
      where r.voucher_id = p_voucher_id),
    0
  );
$$;

comment on function public.get_invoice_outstanding is
  'FIFO-remaining balance for ONE invoice (any age, not only overdue) — adapted from get_overdue_receivables (0031)/get_party_outstanding (0017)''s payment-allocation chain for the print-page QR grain, without modifying either. Returns 0 for any voucher with no debtor-role posting (purchase, journal, credit/debit note). See 0111.';

revoke all on function public.get_invoice_outstanding(uuid, uuid, date) from public, anon;
grant execute on function public.get_invoice_outstanding(uuid, uuid, date) to authenticated;
