-- ============================================================================
-- 1491 — Every "is this document still unpaid?" report reads the allocations
-- ============================================================================
-- 1490 built the model and proved the arithmetic. This file is the other half:
-- the four functions that were each deriving their own answer to the same
-- question now read the one shared answer, app_private.party_document_
-- outstanding.
--
-- WHY IT HAS TO BE ALL FOUR. The pilot's complaint was about
-- /reports/outstanding, but the same FIFO guess is the input to:
--     get_party_outstanding      -> /reports/outstanding AND /reports/msme
--                                   (the Sec 43B(h) position)
--     get_ageing_schedule        -> the Schedule III trade payables/receivables
--                                   ageing note
--     get_overdue_receivables    -> the dashboard "needs attention" feed
--     get_invoice_outstanding    -> the balance printed on an invoice and the
--                                   UPI QR's amount (0111)
-- Leaving any of them on the old derivation would mean the app answering the
-- same question two ways on two screens, which is worse than answering it one
-- wrong way everywhere.
--
-- WHAT DOES NOT CHANGE. With no allocations recorded, every one of these
-- returns exactly what it returned before — verified figure-by-figure against
-- the pilot company before and after. That is the point of demoting FIFO to a
-- fallback rather than removing it: a company that never allocates anything
-- sees no difference at all.
--
-- ONE DELIBERATE BEHAVIOUR CHANGE, NAMED RATHER THAN SLIPPED IN. INVOICE
-- GRAIN, NOT ENTRY-ROW GRAIN: 0017 aged each voucher_entries row separately;
-- 0096 already argued per-invoice is the right grain, and it is the only
-- grain an allocation can point at. Checked across the whole live database
-- first: NO voucher anywhere posts more than one line to the same party
-- ledger, so this regroups nothing that exists today and is inert on current
-- data.
--
-- NO TAX RULE IS TOUCHED HERE. No rate, threshold or due date changes. The
-- only report in this family that carries a real tax liability rather than a
-- management number — get_itc_180day_reversal (Rule 37 / second proviso to
-- Sec 16(2)) — is DELIBERATELY NOT INCLUDED, even though it reads the same
-- FIFO guess and would benefit: another agent's
-- 1400_itc_180day_opening_balance_is_a_charge.sql owns that function in this
-- same wave, rewrites it by asserted targeted replacement against its current
-- body, and would refuse to apply against a wholesale replacement from here.
-- Making Rule 37 allocation-aware is a small, separate change to be made on
-- top of 1400 once it has landed; it is described in this session's report
-- rather than taken.
--
-- HOW THE REPLACEMENTS ARE MADE SAFE. Ten agents are working this tree at
-- once. Each function below is asserted to still carry the marker of the
-- migration that last owned it BEFORE being replaced, so if someone else has
-- landed a newer fix in the meantime this file refuses to run rather than
-- silently reverting them. A function this file has ALREADY converted is
-- recognised and skipped, so re-running the directory against a live database
-- is not mistaken for someone else's edit.
-- ============================================================================

do $mig$
declare
  v_check text[][] := array[
    ['get_party_outstanding',   'book_start'],
    ['get_party_outstanding',   'greatest(0, least(r.delta, r.running'],
    ['get_ageing_schedule',     'book_start'],
    ['get_ageing_schedule',     'bucket_order'],
    ['get_overdue_receivables', 'book_start'],
    ['get_overdue_receivables', 'days_overdue'],
    ['get_invoice_outstanding', 'target_ledger']
  ];
  v_def text;
  i int;
begin
  for i in 1 .. array_length(v_check, 1) loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_check[i][1] and p.prokind = 'f'
     limit 1;

    if v_def is null then
      raise exception '1491: public.% is missing; refusing to guess at its replacement.', v_check[i][1];
    end if;

    -- Already applied (a re-run of the whole directory against a live
    -- database): the marker is legitimately gone because THIS file removed
    -- it. Skip rather than refuse.
    if position('party_document_outstanding' in v_def) > 0 then
      continue;
    end if;

    if position(v_check[i][2] in v_def) = 0 then
      raise exception
        '1491: public.% no longer contains "%" — someone has changed it since 1250/0111. Reconcile by hand rather than letting this file overwrite their fix.',
        v_check[i][1], v_check[i][2];
    end if;
  end loop;
end;
$mig$;


-- ---------------------------------------------------------------------------
-- 1. get_party_outstanding — per-party ageing (the receivables/payables screen
--    and the MSME Sec 43B(h) report)
-- ---------------------------------------------------------------------------
-- Signature, column list, bucket boundaries, ordering and the
-- "only parties with something outstanding" filter are all unchanged. p_role
-- is still passed straight through rather than normalised, so an unrecognised
-- role still matches no party and returns nothing, exactly as before.
create or replace function public.get_party_outstanding(
  p_company_id uuid,
  p_as_at date default current_date,
  p_role text default 'debtor'::text
)
returns table(ledger_id uuid, ledger_name text, outstanding numeric, not_due numeric,
              days_0_30 numeric, days_31_60 numeric, days_61_90 numeric,
              days_over_90 numeric, oldest_date date)
language sql
stable
set search_path to ''
as $function$
  with d as (
    select * from app_private.party_document_outstanding(p_company_id, p_as_at, p_role)
  ),
  bucketed as (
    select d.ledger_id, d.ledger_name,
           sum(d.outstanding) as outstanding,
           sum(d.outstanding) filter (where p_as_at - d.voucher_date < 0)               as not_due,
           sum(d.outstanding) filter (where p_as_at - d.voucher_date between 0 and 30)  as b0,
           sum(d.outstanding) filter (where p_as_at - d.voucher_date between 31 and 60) as b1,
           sum(d.outstanding) filter (where p_as_at - d.voucher_date between 61 and 90) as b2,
           sum(d.outstanding) filter (where p_as_at - d.voucher_date > 90)              as b3,
           min(d.voucher_date)                                                          as oldest
      from d
     where d.outstanding > 0
     group by d.ledger_id, d.ledger_name
  )
  select b.ledger_id, b.ledger_name,
         coalesce(b.outstanding, 0),
         coalesce(b.not_due, 0), coalesce(b.b0, 0), coalesce(b.b1, 0),
         coalesce(b.b2, 0), coalesce(b.b3, 0),
         b.oldest
    from bucketed b
   where coalesce(b.outstanding, 0) <> 0
   order by coalesce(b.b3, 0) desc, coalesce(b.outstanding, 0) desc;
$function$;

revoke all on function public.get_party_outstanding(uuid, date, text) from public, anon;
grant execute on function public.get_party_outstanding(uuid, date, text) to authenticated;

comment on function public.get_party_outstanding(uuid, date, text) is
  'Per-party ageing (receivable or payable), now bill-wise: a receipt allocated to specific invoices ages against THOSE invoices, and only money left on account falls back to oldest-first (1490/1491). Opening balance still treated as the oldest document, dated at book_beginning_date (1250); favourable opening balances still net against the earliest charge (1050). Ties exactly to the party control account either way.';


-- ---------------------------------------------------------------------------
-- 2. get_ageing_schedule — the Schedule III note
-- ---------------------------------------------------------------------------
-- Bucket boundaries (payables 1/2/3 years, receivables 6 months then 1/2/3
-- years), the MSME/Others segmentation for payables, the empty-bucket shell
-- and the output shape are all 1250's, unchanged. Only the source of
-- "what is still outstanding on this document" moves.
create or replace function public.get_ageing_schedule(
  p_company_id uuid,
  p_as_at date default current_date,
  p_party_type text default 'receivable'::text
)
returns table(segment text, bucket_label text, bucket_order smallint, amount numeric)
language sql
stable
set search_path to ''
as $function$
  with cfg as (
    select case when p_party_type = 'payable' then 'payable' else 'receivable' end as ptype
  ),
  d as (
    select * from app_private.party_document_outstanding(
      p_company_id, p_as_at,
      (select case when cfg.ptype = 'payable' then 'creditor' else 'debtor' end from cfg))
  ),
  classified as (
    select
      d.ledger_id,
      d.outstanding as remaining,
      case when d.voucher_date > p_as_at then 0
           when cfg.ptype = 'payable' then
             case
               when d.voucher_date > (p_as_at - interval '1 year')::date then 1
               when d.voucher_date > (p_as_at - interval '2 years')::date then 2
               when d.voucher_date > (p_as_at - interval '3 years')::date then 3
               else 4
             end
           else
             case
               when d.voucher_date > (p_as_at - interval '6 months')::date then 1
               when d.voucher_date > (p_as_at - interval '1 year')::date then 2
               when d.voucher_date > (p_as_at - interval '2 years')::date then 3
               when d.voucher_date > (p_as_at - interval '3 years')::date then 4
               else 5
             end
      end as bucket_order
      from d
      cross join cfg
     where d.outstanding > 0
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
      join public.ledgers p on p.id = cl.ledger_id
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

revoke all on function public.get_ageing_schedule(uuid, date, text) from public, anon;
grant execute on function public.get_ageing_schedule(uuid, date, text) to authenticated;

comment on function public.get_ageing_schedule(uuid, date, text) is
  'Schedule III ageing note (MSME/Others split for payables, flat for receivables), now bill-wise via the shared app_private.party_document_outstanding (1490/1491). Opening balance dated at book_beginning_date (1250); favourable opening balances net against the earliest charge (1050).';


-- ---------------------------------------------------------------------------
-- 3. get_overdue_receivables — the per-invoice dashboard feed
-- ---------------------------------------------------------------------------
-- The one place the old code already reported per document rather than per
-- party, and therefore the place where the pilot's complaint was most visible:
-- an invoice paid in full still appeared here until the opening balance had
-- been cleared. Due date is still voucher_date + coalesce(credit_days, 30);
-- the opening-balance row is still filtered out by voucher_id is not null.
create or replace function public.get_overdue_receivables(
  p_company_id uuid,
  p_as_at date default current_date
)
returns table(voucher_id uuid, voucher_number text, party_name text, voucher_date date,
              due_date date, outstanding numeric, days_overdue integer)
language sql
stable
set search_path to ''
as $function$
  select d.voucher_id, d.voucher_number, d.ledger_name, d.voucher_date,
         (d.voucher_date + coalesce(l.credit_days, 30)) as due_date,
         d.outstanding,
         (p_as_at - (d.voucher_date + coalesce(l.credit_days, 30)))::int as days_overdue
    from app_private.party_document_outstanding(p_company_id, p_as_at, 'debtor') d
    join public.ledgers l on l.id = d.ledger_id
   where d.voucher_id is not null
     and d.outstanding > 0
     and p_as_at > (d.voucher_date + coalesce(l.credit_days, 30))
   order by days_overdue desc, d.voucher_date;
$function$;

revoke all on function public.get_overdue_receivables(uuid, date) from public, anon;
grant execute on function public.get_overdue_receivables(uuid, date) to authenticated;

comment on function public.get_overdue_receivables(uuid, date) is
  'Individual overdue invoices (not aggregated by party) for the dashboard and needs-attention feed, now bill-wise: an invoice a receipt was actually allocated to drops off this list even while an older opening balance stays open (1490/1491). Opening balance participates in the ageing but is never itself listed (voucher_id is not null).';


-- ---------------------------------------------------------------------------
-- 4. get_invoice_outstanding — the balance printed on an invoice, and the
--    amount inside its UPI QR (0111)
-- ---------------------------------------------------------------------------
-- Still debtor-side only, exactly as 0111 built it: a purchase voucher has no
-- QR and passing one still returns 0. What changes is that a sales invoice a
-- receipt was actually allocated to now prints as settled instead of printing
-- a "please pay" QR for money the customer has already sent.
create or replace function public.get_invoice_outstanding(
  p_company_id uuid,
  p_voucher_id uuid,
  p_as_at date default current_date
) returns numeric
language sql
stable
set search_path to ''
as $function$
  select coalesce(
    (select d.outstanding
       from app_private.party_document_outstanding(p_company_id, p_as_at, 'debtor') d
      where d.voucher_id = p_voucher_id
      limit 1),
    0);
$function$;

revoke all on function public.get_invoice_outstanding(uuid, uuid, date) from public, anon;
grant execute on function public.get_invoice_outstanding(uuid, uuid, date) to authenticated;

comment on function public.get_invoice_outstanding(uuid, uuid, date) is
  'What is still owed on ONE sales invoice at a date — the printed balance and the UPI QR amount (0111). Now reads the shared bill-wise outstanding (1490/1491): a receipt allocated to this invoice settles this invoice, rather than the oldest open document. Debtor side only, as it always was; 0 for anything that is not a charge to a customer.';
