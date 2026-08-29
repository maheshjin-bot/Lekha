-- GSTR-1 Table 13 ("Documents issued") — split by numbering series.
--
-- WHY THIS IS URGENT, not cosmetic. Migration 0725 made numbering
-- series-aware: voucher_number_sequences now holds one row per SERIES, where
-- it previously held one row per (branch, voucher_type, FY). Table 13 built
-- its `series` CTE straight off that table but aggregated its `docs` CTE by
-- (branch_id, voucher_type) only. The LEFT JOIN therefore attached the SAME
-- document aggregate to EVERY series row.
--
-- Observed live on Sharma Textiles the moment a second sales series existed:
-- Table 13 returned TWO identical 'sales' rows, each reporting
-- serial_from 1, serial_to 22, total_issued 22 — i.e. 44 invoices where 22
-- exist, both mislabelled with the same legacy prefix HO/SAL. Table 13 is a
-- filed GST return table; that is a real filing error, not a display glitch.
--
-- WHAT CHANGED
--
-- 1. `docs` now resolves each voucher to the series that actually minted it,
--    by matching voucher_number against voucher_number_sequences.resolved_
--    prefix (the real generation string 0725 added), longest prefix first so
--    that a series whose prefix is itself a prefix of another cannot swallow
--    the wrong rows. Aggregation is grouped by that series.
--
-- 2. Vouchers that match NO series are still reported, under a synthetic
--    "Manually numbered or retired series" row. They must not be dropped:
--    Rule 46 requires every issued document to appear in Table 13, and there
--    are two real ways to get one — a manual number (0725 lets an admin put
--    a voucher type in manual mode, and manual numbers deliberately follow
--    no series template) and a series whose prefix was edited after some
--    documents had already been issued under the old one.
--
-- 3. `series_prefix` is now DISPLAY-READY: the resolved prefix with its
--    trailing slash trimmed, e.g. 'HO/SAL/2026-27' or 'EXP/26-27'. It
--    previously returned the legacy `prefix` column ('HO/SAL'), which the
--    report page had to concatenate with the FY itself to make sense of.
--    That page is updated in the same commit — the two must move together,
--    or Table 13 renders 'HO/SAL/2026-27//2026-27'.
--
-- 4. New `series_name` column, so a reader can tell two series of the same
--    voucher type apart rather than inferring it from the prefix.
--
-- WHAT IS DELIBERATELY NOT CHANGED
--
-- serial_from/serial_to still come from vouchers.sequence_number. Within a
-- single series that column is monotonic and correct. Across series it now
-- genuinely collides (verified live: EXP/26-27/0002 and HO/SAL/2026-27/00002
-- both carry sequence_number 2) — which is exactly why grouping by series is
-- the fix rather than switching column. A manual voucher continues the
-- branch's own max instead, so a manual row's span is indicative rather than
-- a true series range; its `range_has_gap` flag is the honest signal there.
--
-- The legacy voucher_number_sequences.prefix column is left untouched and
-- keeps its original meaning (branch code + 3-letter type code). 0725 chose
-- that deliberately and this migration does not revisit it.

drop function if exists public.get_gstr1_table13(uuid, date, date, uuid);

create or replace function public.get_gstr1_table13(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
) returns table(
  voucher_type text,
  nature_of_document text,
  branch_id uuid,
  branch_code text,
  series_name text,
  series_prefix text,
  financial_year_label text,
  serial_from integer,
  serial_to integer,
  total_issued integer,
  cancelled integer,
  net_issued integer,
  serial_span integer,
  range_has_gap boolean
)
language sql
stable
set search_path = ''
as $$
  with company_fy as (
    -- Unchanged from the original: Table 13's period does not cross a
    -- financial-year boundary in normal use (GST periods are calendar
    -- months or quarters, all of which sit inside one FY), so the FY is
    -- resolved from p_period_start only.
    select app_private.fy_label(p_period_start, c.financial_year_start_month) as fy_label
      from public.companies c
     where c.id = p_company_id
  ),
  category as (
    select * from (values
      ('sales', 'Invoices for outward supply'),
      ('credit_note', 'Credit Note'),
      ('job_work_out', 'Delivery Challan for job work')
    ) as t(voucher_type, nature_of_document)
  ),
  series as (
    select vns.branch_id,
           b.code as branch_code,
           vns.voucher_type,
           vns.series_id,
           s.name as series_name,
           vns.resolved_prefix,
           vns.financial_year_label
      from public.voucher_number_sequences vns
      join public.branches b
        on b.id = vns.branch_id and b.company_id = vns.company_id
      join public.voucher_number_series s
        on s.id = vns.series_id and s.company_id = vns.company_id
      join company_fy cf on cf.fy_label = vns.financial_year_label
     where vns.company_id = p_company_id
       and vns.voucher_type in (select voucher_type from category)
       and (p_gst_registration_id is null
            or app_private.branch_registration(vns.branch_id, p_period_end) = p_gst_registration_id)
  ),
  -- Each in-period voucher resolved to the series that actually minted it.
  -- Longest resolved_prefix wins, so a shorter series prefix that happens to
  -- be a prefix of a longer one cannot claim the longer one's documents.
  matched as (
    select v.branch_id,
           v.voucher_type,
           v.sequence_number,
           v.is_deleted,
           m.series_id
      from public.vouchers v
      left join lateral (
        select s2.series_id
          from series s2
         where s2.branch_id = v.branch_id
           and s2.voucher_type = v.voucher_type
           and v.voucher_number like s2.resolved_prefix || '%'
         order by length(s2.resolved_prefix) desc
         limit 1
      ) m on true
     where v.company_id = p_company_id
       and v.voucher_type in (select voucher_type from category)
       and v.voucher_date between p_period_start and p_period_end
  ),
  docs as (
    select branch_id,
           voucher_type,
           series_id,
           count(*)::int as total_n,
           min(sequence_number) as serial_from,
           max(sequence_number) as serial_to,
           count(*) filter (where is_deleted)::int as cancelled_n
      from matched
     group by branch_id, voucher_type, series_id
  )
  -- Every known series, whether or not it issued anything this period.
  select
    s.voucher_type,
    c.nature_of_document,
    s.branch_id,
    s.branch_code,
    s.series_name,
    rtrim(s.resolved_prefix, '/'),
    s.financial_year_label,
    d.serial_from,
    d.serial_to,
    coalesce(d.total_n, 0),
    coalesce(d.cancelled_n, 0),
    coalesce(d.total_n, 0) - coalesce(d.cancelled_n, 0),
    case when d.serial_from is not null then d.serial_to - d.serial_from + 1 else 0 end,
    case when d.serial_from is not null
              and (d.serial_to - d.serial_from + 1) <> d.total_n
         then true else false end
    from series s
    join category c on c.voucher_type = s.voucher_type
    left join docs d
      on d.branch_id = s.branch_id
     and d.voucher_type = s.voucher_type
     and d.series_id = s.series_id

  union all

  -- Documents no live series explains. Never dropped: Rule 46 wants every
  -- issued document listed. serial_span/range_has_gap are computed the same
  -- way, but read them as indicative here — a manual number follows the
  -- branch's own running max, not a series counter.
  select
    m.voucher_type,
    c.nature_of_document,
    m.branch_id,
    b.code,
    'Manually numbered or retired series',
    null::text,
    cf.fy_label,
    min(m.sequence_number),
    max(m.sequence_number),
    count(*)::int,
    count(*) filter (where m.is_deleted)::int,
    (count(*) - count(*) filter (where m.is_deleted))::int,
    (max(m.sequence_number) - min(m.sequence_number) + 1),
    ((max(m.sequence_number) - min(m.sequence_number) + 1) <> count(*))
    from matched m
    join category c on c.voucher_type = m.voucher_type
    join public.branches b on b.id = m.branch_id
    cross join company_fy cf
   where m.series_id is null
     and (p_gst_registration_id is null
          or app_private.branch_registration(m.branch_id, p_period_end) = p_gst_registration_id)
   group by m.voucher_type, c.nature_of_document, m.branch_id, b.code, cf.fy_label

  order by 2, 4, 5;
$$;

revoke all on function public.get_gstr1_table13(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_gstr1_table13(uuid, date, date, uuid) to authenticated;

comment on function public.get_gstr1_table13(uuid, date, date, uuid) is
  'GSTR-1 Table 13 (Documents issued), one row per numbering series (0730). '
  'Vouchers matching no live series are reported under a "Manually numbered '
  'or retired series" row rather than being dropped. series_prefix is '
  'display-ready with its trailing slash trimmed.';
