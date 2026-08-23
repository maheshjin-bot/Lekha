-- ============================================================================
-- 0081 — Four different GST categories were all being stored as "rate = 0"
-- ============================================================================
-- `items` carried gst_rate_percent and nothing else, so a zero rate was the
-- only way to express FOUR legally distinct things, and the item form said as
-- much out loud: its rate dropdown renders "0% — Nil / exempt", which merges
-- two of them and silently omits the other two.
--
--   TAXABLE     attracts GST at a rate. A taxable supply at 0% is possible
--               and is not the same as nil-rated.
--   NIL-RATED   taxable under GST, tariff rate 0%. No ITC on inputs.
--   EXEMPT      exempted by notification under Sec 11 CGST / Sec 6 IGST.
--               No ITC on inputs.
--   NON-GST     outside GST altogether — petrol, diesel, ATF, natural gas,
--               crude, and alcohol for human consumption.
--
-- They are not interchangeable in a return. GSTR-1 Table 8 reports nil-rated,
-- exempted and non-GST outward supplies in three SEPARATE columns, split
-- four ways by registered/unregistered and inter/intra-State. GSTR-3B splits
-- them too: 3.1(c) for nil-rated and exempt, 3.1(e) for non-GST. And Rule
-- 42/43 needs exempt turnover as the DENOMINATOR when apportioning common
-- credit, which cannot be computed at all while exempt supplies are
-- indistinguishable from taxable ones that happen to be zero-rated.
--
-- ZERO-RATED IS DELIBERATELY NOT ONE OF THE VALUES. Exports and SEZ supplies
-- are zero-rated, they carry full ITC, and they are reported in GSTR-1 Table 6
-- rather than Table 8 — but zero-rating is a property of the TRANSACTION, not
-- of the item. The same steel bar is taxable domestically and zero-rated when
-- exported. That belongs on vouchers.supply_type, whose CHECK already allows
-- export_lut / export_igst / sez and which nothing currently writes — a
-- separate gap, and folding it in here would make the item master lie about
-- goods that are only sometimes zero-rated.
--
-- BACKFILL IS UNAMBIGUOUS, which is luck rather than design: all 27 items in
-- the database today carry gst_rate_percent > 0, so every one is genuinely
-- taxable and 'taxable' is the correct value for all of them, not a guess. Had
-- any sat at 0% the honest backfill would have been to leave them
-- unclassified, because which of the four they were is not recoverable from
-- the rate alone — that is the whole point of this migration.
--
-- The CHECK also enforces the consistency the schema could not previously
-- express: a supply that is nil-rated, exempt or non-GST cannot simultaneously
-- carry a positive GST rate. That combination has no meaning and was
-- previously writable.
-- ============================================================================

alter table public.items
  add column if not exists supply_nature text not null default 'taxable';

alter table public.items
  drop constraint if exists items_supply_nature_check;

alter table public.items
  add constraint items_supply_nature_check
  check (supply_nature in ('taxable', 'nil_rated', 'exempt', 'non_gst'));

-- A non-taxable supply cannot carry a rate. Kept as its own named constraint
-- so a violation says which rule was broken.
alter table public.items
  drop constraint if exists items_non_taxable_has_no_rate;

alter table public.items
  add constraint items_non_taxable_has_no_rate
  check (
    supply_nature = 'taxable'
    or (coalesce(gst_rate_percent, 0) = 0 and coalesce(cess_rate_percent, 0) = 0)
  );

comment on column public.items.supply_nature is
  'GST character of the item: taxable / nil_rated / exempt / non_gst. NOT zero-rated — that is a property of the transaction (export or SEZ) and lives on vouchers.supply_type. Drives GSTR-1 Table 8, GSTR-3B 3.1(c) and 3.1(e), and the exempt-turnover denominator in Rule 42/43. See 0081.';

-- ----------------------------------------------------------------------------
-- GSTR-1 Table 8 — nil-rated, exempted and non-GST outward supplies
-- ----------------------------------------------------------------------------
-- Table 8 is item-level, so it reads voucher_items rather than the
-- voucher-level output register (get_gst_output_register, 0035), which has no
-- way to see an item's supply nature.
--
-- The four rows are Table 8's own: 8A inter-State to registered, 8B
-- intra-State to registered, 8C inter-State to unregistered, 8D intra-State
-- to unregistered. "Registered" is decided by whether the party ledger holds
-- a GSTIN, which is the only signal this schema has.
create or replace function public.get_gstr1_table8(
  p_company_id uuid,
  p_from date,
  p_to date
)
returns table (
  table_ref text,
  description text,
  nil_rated numeric,
  exempted numeric,
  non_gst numeric,
  total numeric
)
language sql
stable
set search_path to ''
as $fn$
  with lines as (
    select
      i.supply_nature,
      v.supply_type,
      party.party_registered,
      vi.amount
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id
      join public.items i on i.id = vi.item_id
      -- Resolve the party as exactly ONE row per voucher. Joining
      -- voucher_entries directly on debit_amount > 0 looks equivalent — the
      -- customer is the debited side of a sale — but it multiplies every
      -- item line by however many debit lines the voucher happens to have,
      -- silently double-counting the moment an invoice carries a second
      -- debit (a split settlement, a discount line, a TDS receivable).
      -- LATERAL with LIMIT 1 makes that impossible rather than unlikely.
      left join lateral (
        select (l.gstin is not null and l.gstin <> '') as party_registered
          from public.voucher_entries e
          join public.ledgers l on l.id = e.ledger_id
         where e.voucher_id = v.id
           and e.debit_amount > 0
         order by e.debit_amount desc
         limit 1
      ) party on true
     where vi.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date between p_from and p_to
       and v.voucher_type in ('sales', 'credit_note')
       and i.supply_nature in ('nil_rated', 'exempt', 'non_gst')
  ),
  buckets as (
    select
      case
        when party_registered and supply_type = 'inter' then '8A'
        when party_registered then '8B'
        when supply_type = 'inter' then '8C'
        else '8D'
      end as table_ref,
      supply_nature,
      amount
      from lines
  ),
  refs as (
    select * from (values
      ('8A', 'Inter-State supplies to registered persons'),
      ('8B', 'Intra-State supplies to registered persons'),
      ('8C', 'Inter-State supplies to unregistered persons'),
      ('8D', 'Intra-State supplies to unregistered persons')
    ) as r(table_ref, description)
  )
  select
    r.table_ref,
    r.description,
    coalesce(sum(b.amount) filter (where b.supply_nature = 'nil_rated'), 0),
    coalesce(sum(b.amount) filter (where b.supply_nature = 'exempt'), 0),
    coalesce(sum(b.amount) filter (where b.supply_nature = 'non_gst'), 0),
    coalesce(sum(b.amount), 0)
  from refs r
  left join buckets b on b.table_ref = r.table_ref
  group by r.table_ref, r.description
  order by r.table_ref;
$fn$;

revoke all on function public.get_gstr1_table8(uuid, date, date) from public, anon;
grant execute on function public.get_gstr1_table8(uuid, date, date) to authenticated;

comment on function public.get_gstr1_table8(uuid, date, date) is
  'GSTR-1 Table 8 prep: nil-rated, exempted and non-GST outward supplies, split 8A-8D by registered/unregistered and inter/intra-State. Item-level, so it reads voucher_items — the voucher-level output register cannot see an item''s supply nature. Depends on items.supply_nature (0081); every row reads zero until items are classified.';
