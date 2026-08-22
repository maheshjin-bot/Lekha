-- ITC-04 prep — Table 4 (goods sent for job work) and Table 5A (goods
-- received back from the SAME job worker, including losses/waste) for a
-- chosen period. Zero new tables — purely additive read RPCs over
-- job_work_challans/job_work_returns (0069), the same relationship
-- get_job_work_outstanding already reads, just reshaped period-by-period
-- (as filed) instead of cumulative-to-date (as get_job_work_outstanding
-- itself reports).
--
-- RESEARCHED, NOT GUESSED (21-22 Aug 2026): ITC-04 actually has FOUR
-- tables, not one — Table 4 (sent), Table 5A (received back from the SAME
-- job worker + losses), Table 5B (received back from a DIFFERENT job
-- worker than the one goods were sent to), Table 5C (supplied onward
-- directly from the job worker's premises, never returned to the
-- principal at all). This migration deliberately covers Table 4 and 5A
-- only — the two scenarios job_work_challans/job_work_returns (0069) can
-- actually represent, since that schema never distinguishes "returned by
-- a different job worker" or "sold on directly from the job worker's own
-- premises" as their own event types. 5B/5C are real GST scenarios this
-- v1 does not attempt, stated here rather than silently omitted.
--
-- SAME CAVEAT AS THE TALLY EXPORT (0070's era): this is a prep REPORT in
-- ITC-04's own table shape (same framing as GSTR-1 prep, 0051) sourced
-- from LEKHA's own postings, not a validated match to the GSTN offline
-- utility's exact upload column format — that level of field-by-field
-- detail could not be confirmed against official documentation during
-- research (the offline utility's own Excel template, not the public
-- manual pages, is the actual source of truth for that, and wasn't
-- accessible here). Treat the exported CSV as a checklist to key into the
-- real utility, not as a ready-to-upload file.

create or replace function public.get_itc04_table4(
  p_company_id uuid,
  p_from date,
  p_to date
)
returns table (
  challan_id uuid,
  challan_number text,
  challan_date date,
  job_worker_gstin text,
  job_worker_name text,
  item_name text,
  hsn_sac text,
  uom text,
  quantity_sent numeric,
  nature_of_job_work text
)
language sql
stable
set search_path to ''
as $$
  select
    c.id, v.voucher_number, c.challan_date,
    l.gstin, l.name,
    i.name, i.hsn_sac, c.uom, c.quantity_sent, c.nature_of_job_work
  from public.job_work_challans c
  join public.vouchers v on v.id = c.voucher_id
  join public.ledgers l on l.id = c.job_worker_ledger_id
  join public.items i on i.id = c.item_id
  where c.company_id = p_company_id
    and c.challan_date >= p_from and c.challan_date <= p_to
  order by c.challan_date, v.voucher_number;
$$;

revoke all on function public.get_itc04_table4(uuid, date, date) from public, anon;
grant execute on function public.get_itc04_table4(uuid, date, date) to authenticated;

comment on function public.get_itc04_table4(uuid, date, date) is
  'ITC-04 Table 4 prep: every job work challan dispatched within [p_from, p_to]. Period-scoped (as filed), unlike get_job_work_outstanding (0069) which is cumulative-to-date.';

create or replace function public.get_itc04_table5a(
  p_company_id uuid,
  p_from date,
  p_to date
)
returns table (
  return_id uuid,
  original_challan_number text,
  original_challan_date date,
  return_date date,
  job_worker_gstin text,
  job_worker_name text,
  returned_item_name text,
  hsn_sac text,
  uom text,
  quantity_received numeric,
  quantity_loss_or_waste numeric
)
language sql
stable
set search_path to ''
as $$
  select
    r.id, v.voucher_number, c.challan_date, r.return_date,
    l.gstin, l.name,
    -- A pure loss/waste report (quantity_received = 0) may carry no
    -- returned_item_id at all — fall back to the original challan's own
    -- item, since a loss is still reported against what was sent.
    coalesce(ri.name, oi.name), coalesce(ri.hsn_sac, oi.hsn_sac), c.uom,
    r.quantity_received, r.quantity_loss_or_waste
  from public.job_work_returns r
  join public.job_work_challans c on c.id = r.challan_id
  join public.vouchers v on v.id = c.voucher_id
  join public.ledgers l on l.id = c.job_worker_ledger_id
  join public.items oi on oi.id = c.item_id
  left join public.items ri on ri.id = r.returned_item_id
  where r.company_id = p_company_id
    and r.return_date >= p_from and r.return_date <= p_to
  order by r.return_date, v.voucher_number;
$$;

revoke all on function public.get_itc04_table5a(uuid, date, date) from public, anon;
grant execute on function public.get_itc04_table5a(uuid, date, date) to authenticated;

comment on function public.get_itc04_table5a(uuid, date, date) is
  'ITC-04 Table 5A prep: every return/loss event recorded within [p_from, p_to] against a challan, assuming the goods came back from the SAME job worker they were sent to (this schema''s only tracked scenario — see migration header for Table 5B/5C, which it does not attempt).';
