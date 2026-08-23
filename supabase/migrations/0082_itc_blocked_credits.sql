-- ============================================================================
-- 0082 — Sec 17(5) blocked credits: ITC the business must not claim
-- ============================================================================
-- The codebase admits this gap in its own words, three times. 0035's function
-- comment: "Does not distinguish eligible from blocked ITC (Sec 17(5)) —
-- LEKHA does not track that per line." And the GST registers page says twice
-- more that the eligibility split is not tracked. Every rupee of input tax was
-- therefore presented as claimable, including tax the business is forbidden
-- from claiming.
--
-- Sec 17(5) blocks ITC on specific inward supplies however genuine the
-- business purpose: motor vehicles seating 13 or fewer, food and beverages and
-- outdoor catering, club and gym membership, life and health insurance,
-- employee travel benefits, works contract and construction of immovable
-- property, supplies from a composition dealer, CSR spending, goods given away
-- as gifts or free samples, and goods lost, stolen or written off. Claiming it
-- anyway invites interest under Sec 50 and a penalty, and it is a standard
-- audit-scope item.
--
-- WHERE THE FLAG LIVES, AND WHY. On `items`, not on the voucher. Blocking is a
-- property of WHAT WAS BOUGHT — a car is blocked whoever sells it, stationery
-- never is — so the item master is where the fact belongs and where it only
-- has to be stated once. It is also sufficient in practice here: all input tax
-- in this database arrives through `purchase` vouchers (verified: 10 vouchers,
-- 1,44,000 of input tax, no other voucher type carries any), and create_invoice
-- refuses a voucher with no item lines, so every input-tax voucher has items to
-- attribute to.
--
-- WHICH GSTR-3B TABLE — a real correction worth recording. It is natural to
-- assume blocked ITC belongs in Table 4(D), and that WAS the format until
-- August 2022. The revamp moved it: Sec 17(5) is now reported as a
-- NON-RECLAIMABLE REVERSAL in Table 4(B)(1), alongside Rule 38, 42 and 43,
-- while Table 4(D)(1) became ITC reclaimed and 4(D)(2) covers Sec 16(4)
-- time-barred credit and place-of-supply restrictions. Secondary sources still
-- disagree about this — several describe 4(D)(1) as covering 17(5), which is
-- the pre-revamp reading — so the report names Table 4(B)(1) and says the
-- older format put it in 4(D), rather than silently picking one and being
-- confidently wrong at a filer who remembers the other.
--
-- HOW THE SPLIT IS COMPUTED. Input tax is posted at VOUCHER level (one line
-- per tax ledger), while blocking is decided per ITEM, so a voucher that mixes
-- a blocked item with an eligible one has to be apportioned. It is split
-- across the voucher's item lines in proportion to their taxable value — the
-- same technique get_gstr1_hsn_summary (0051) already uses to allocate tax to
-- HSN codes, so this introduces no new approach. Where a voucher's items are
-- entirely one way or the other, apportionment is exact rather than an
-- estimate; only genuinely mixed invoices carry rounding.
-- ============================================================================

alter table public.items
  add column if not exists itc_eligibility text not null default 'eligible';

alter table public.items
  add column if not exists itc_blocked_clause text;

alter table public.items
  drop constraint if exists items_itc_eligibility_check;

alter table public.items
  add constraint items_itc_eligibility_check
  check (itc_eligibility in ('eligible', 'blocked'));

-- The sub-clauses as the section itself enumerates them. Stored so an auditor
-- can be told WHICH limb blocks a given item rather than just that something
-- does, and so a future change to one limb can be found.
alter table public.items
  drop constraint if exists items_itc_blocked_clause_check;

alter table public.items
  add constraint items_itc_blocked_clause_check
  check (
    itc_blocked_clause is null
    or itc_blocked_clause in (
      '17(5)(a)',   -- motor vehicles seating 13 or fewer
      '17(5)(aa)',  -- vessels and aircraft
      '17(5)(ab)',  -- insurance, servicing and repair of the above
      '17(5)(b)',   -- food, catering, beauty, health, club, insurance, LTC
      '17(5)(c)',   -- works contract for immovable property
      '17(5)(d)',   -- goods/services for construction on own account
      '17(5)(e)',   -- supplies taxed under the composition scheme
      '17(5)(f)',   -- supplies to a non-resident taxable person
      '17(5)(fa)',  -- CSR expenditure (Finance Act 2023)
      '17(5)(g)',   -- goods/services for personal consumption
      '17(5)(h)',   -- gifts, free samples, goods lost/stolen/written off
      '17(5)(i)'    -- tax paid under Sec 74, 129 or 130
    )
  );

-- A clause without a block is meaningless, and a block without a clause is
-- unauditable. Require them to agree.
alter table public.items
  drop constraint if exists items_itc_clause_matches_eligibility;

alter table public.items
  add constraint items_itc_clause_matches_eligibility
  check (
    (itc_eligibility = 'blocked' and itc_blocked_clause is not null)
    or (itc_eligibility = 'eligible' and itc_blocked_clause is null)
  );

comment on column public.items.itc_eligibility is
  'Whether input tax on this item may be claimed. ''blocked'' means Sec 17(5) forbids the credit — reported as a non-reclaimable reversal in GSTR-3B Table 4(B)(1) since the Aug 2022 revamp. See 0082.';

-- ----------------------------------------------------------------------------
-- Eligible versus blocked input tax for a period
-- ----------------------------------------------------------------------------
create or replace function public.get_itc_eligibility_summary(
  p_company_id uuid,
  p_from date,
  p_to date
)
returns table (
  eligible_taxable_value numeric,
  eligible_tax numeric,
  blocked_taxable_value numeric,
  blocked_tax numeric,
  total_tax numeric
)
language sql
stable
set search_path to ''
as $fn$
  with voucher_tax as (
    -- Input tax as actually posted, one figure per voucher.
    select v.id as voucher_id,
           coalesce(sum(e.debit_amount - e.credit_amount), 0) as input_tax
      from public.vouchers v
      join public.voucher_entries e on e.voucher_id = v.id
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id
     where v.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date between p_from and p_to
       and m.purpose in ('input_cgst', 'input_sgst', 'input_igst', 'input_cess')
     group by v.id
  ),
  voucher_lines as (
    select vi.voucher_id,
           coalesce(sum(vi.amount), 0) as line_total,
           coalesce(sum(vi.amount) filter (where i.itc_eligibility = 'blocked'), 0) as blocked_value,
           coalesce(sum(vi.amount) filter (where i.itc_eligibility <> 'blocked'), 0) as eligible_value
      from public.voucher_items vi
      join public.items i on i.id = vi.item_id
     group by vi.voucher_id
  ),
  split as (
    select
      l.eligible_value,
      l.blocked_value,
      -- Apportion the voucher's posted tax by taxable value. Exact whenever a
      -- voucher is wholly one way; only mixed invoices carry rounding.
      case when l.line_total > 0
           then t.input_tax * (l.eligible_value / l.line_total) else t.input_tax end as eligible_tax,
      case when l.line_total > 0
           then t.input_tax * (l.blocked_value / l.line_total) else 0 end as blocked_tax
      from voucher_tax t
      join voucher_lines l on l.voucher_id = t.voucher_id
  )
  select
    round(coalesce(sum(eligible_value), 0), 2),
    round(coalesce(sum(eligible_tax), 0), 2),
    round(coalesce(sum(blocked_value), 0), 2),
    round(coalesce(sum(blocked_tax), 0), 2),
    round(coalesce(sum(eligible_tax), 0) + coalesce(sum(blocked_tax), 0), 2)
  from split;
$fn$;

revoke all on function public.get_itc_eligibility_summary(uuid, date, date) from public, anon;
grant execute on function public.get_itc_eligibility_summary(uuid, date, date) to authenticated;

comment on function public.get_itc_eligibility_summary(uuid, date, date) is
  'Splits a period''s input tax into claimable and Sec 17(5)-blocked. Tax is posted per voucher but blocking is decided per item, so a mixed voucher is apportioned by taxable value — the same allocation get_gstr1_hsn_summary uses. Blocked tax belongs in GSTR-3B Table 4(B)(1) as a non-reclaimable reversal. See 0082.';
