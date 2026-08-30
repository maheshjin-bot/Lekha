-- ============================================================================
-- 1000 — the review queue can finally NAME a document
-- ============================================================================
-- Found in production, on a real handwritten delivery challan, not in review:
-- every phone-captured document in the inbox was titled "page-001.jpg". Seven
-- rows, seven identical names, and no way to tell them apart without opening
-- each one.
--
-- The screen's title logic was never wrong. components/capture/reviewModel.ts
-- queueRowTitle already reads party name → the hint the phone typed → the
-- note → the filename. The problem is one level down: 0870's
-- get_capture_review_queue deliberately returns `has_extraction` (a boolean)
-- and NOT extracted_json, because that jsonb is large and most rows in a queue
-- are never opened. So the party name the vision model had already read
-- correctly could not reach the list, the hint is optional and usually blank,
-- and the chain fell through to the filename — which the phone assigns as
-- page-001.jpg for EVERY document it sends.
--
-- WHY SUMMARY COLUMNS AND NOT JUST RETURNING THE JSONB: returning
-- extracted_json for up to 500 queue rows would ship a large payload to draw
-- one line of text per row, and 0870's reasoning for excluding it still
-- stands. Three scalars extracted server-side cost almost nothing and answer
-- the only question the LIST needs to answer — which document is this?
-- Opening one still fetches the full extraction, exactly as before.
--
-- EVERYTHING IS ->> (text), NOTHING IS CAST. extracted_json is written by a
-- vision model reading a photograph; `bill_date` can be "31-7-26" or "not
-- legible" and `total_amount` can be blank on a challan book that carries no
-- rates at all (the very document that exposed this). A ::date or ::numeric
-- cast here would turn a bad OCR read into a 500 that takes down the whole
-- queue — for a caption. The client already formats these; it can keep doing
-- so, and a garbled value renders as itself rather than as an outage.
--
-- doc_number / doc_date coalesce challan-shaped keys with invoice-shaped ones
-- because one column has to serve both document types. Confirmed against the
-- live data (a key census over capture_drafts.extracted_json): the model
-- emits challan_number / challan_date on challans and bill_date on bills, and
-- currently emits no invoice-number key at all — so doc_number is usually
-- null for a purchase bill. That is honest: nothing is invented here that the
-- model did not read.
--
-- Same drop-and-recreate as 0871, for the same reason: the RETURNS TABLE
-- shape changes, and CREATE OR REPLACE cannot change a function's return
-- type. The 8-argument signature is named explicitly so this cannot remove
-- some other overload. The body is 0871's, with three lines added to the
-- select list and nothing else touched.
-- ============================================================================

drop function if exists public.get_capture_review_queue(uuid, text, text, uuid, uuid, integer, date, date);

create function public.get_capture_review_queue(
  p_company_id uuid,
  p_status text default null,
  p_document_type text default null,
  p_branch_id uuid default null,
  p_captured_by uuid default null,
  p_limit integer default 100,
  p_from date default null,
  p_to date default null
)
returns table(
  id uuid, draft_id uuid, company_id uuid, branch_id uuid, source text,
  document_type text, status text, stage text, page_count integer,
  storage_path text, vendor_hint text, note text, captured_by uuid,
  captured_by_name text, captured_by_email text,
  submitted_at timestamptz, created_at timestamptz, extracted_at timestamptz,
  has_extraction boolean, rejected_reason text, rejected_at timestamptz,
  confirmed_voucher_id uuid, is_possible_duplicate boolean,
  duplicate_of_draft_id uuid,
  -- New in 1000. Text, never cast — see the header.
  vendor_name text, doc_number text, doc_date text, total_amount text
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_limit int;
  v_status text;
  v_doc_type text;
  v_from timestamptz;
  v_to timestamptz;
begin
  if p_company_id is null then
    raise exception 'A company is required';
  end if;
  if not app_private.can_review_captures(p_company_id) then
    raise exception 'You do not have permission to review captured documents for this company';
  end if;

  v_status := nullif(btrim(coalesce(p_status, '')), '');
  if v_status = 'all' then
    v_status := null;
  end if;
  if v_status is not null and v_status not in ('pending_review', 'confirmed', 'rejected') then
    raise exception 'Unknown status filter "%" — expected pending_review, confirmed, rejected or null', v_status;
  end if;

  v_doc_type := nullif(btrim(coalesce(p_document_type, '')), '');
  if v_doc_type = 'all' then
    v_doc_type := null;
  end if;
  if v_doc_type is not null and v_doc_type not in ('sales_challan', 'purchase_invoice', 'other') then
    raise exception 'Unknown document type filter "%" — expected sales_challan, purchase_invoice, other or null', v_doc_type;
  end if;

  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'The "from" date (%) is after the "to" date (%)', p_from, p_to;
  end if;

  v_from := case when p_from is null then null
                 else p_from::timestamp at time zone 'Asia/Kolkata' end;
  v_to   := case when p_to is null then null
                 else (p_to + 1)::timestamp at time zone 'Asia/Kolkata' end;

  v_limit := least(greatest(coalesce(p_limit, 100), 1), 500);

  return query
    select
      d.id,
      d.id,
      d.company_id,
      d.branch_id,
      d.source,
      d.document_type,
      d.status,
      case
        when d.status <> 'pending_review' then d.status
        else 'pending_review'
      end::text,
      coalesce(pc.n, 0)::int,
      coalesce(p1.storage_path, d.storage_path),
      d.vendor_hint,
      d.note,
      d.created_by,
      prof.full_name,
      u.email::text,
      d.submitted_at,
      d.created_at,
      d.extracted_at,
      (d.extracted_json is not null),
      d.rejected_reason,
      d.rejected_at,
      d.confirmed_voucher_id,
      (dup.other_id is not null),
      dup.other_id,
      -- The three the list actually needs to tell one document from another.
      nullif(btrim(coalesce(d.extracted_json ->> 'vendor_name', '')), ''),
      nullif(btrim(coalesce(
        d.extracted_json ->> 'challan_number',
        d.extracted_json ->> 'invoice_number',
        d.extracted_json ->> 'bill_number',
        ''
      )), ''),
      nullif(btrim(coalesce(
        d.extracted_json ->> 'challan_date',
        d.extracted_json ->> 'bill_date',
        ''
      )), ''),
      nullif(btrim(coalesce(d.extracted_json ->> 'total_amount', '')), '')
    from public.capture_drafts d
    left join lateral (
      select count(*)::int as n
        from public.capture_draft_pages p
       where p.draft_id = d.id
    ) pc on true
    left join public.capture_draft_pages p1
      on p1.draft_id = d.id and p1.page_no = 1
    left join auth.users u on u.id = d.created_by
    left join public.profiles prof on prof.id = d.created_by
    left join lateral (
      select o.id as other_id
        from public.capture_drafts o
        join public.capture_draft_pages op
          on op.draft_id = o.id and op.page_no = 1
       where p1.sha256 is not null
         and op.sha256 = p1.sha256
         and o.company_id = d.company_id
         and o.id <> d.id
       order by o.created_at, o.id
       limit 1
    ) dup on true
    where d.company_id = p_company_id
      and d.submitted_at is not null
      and (v_status is null or d.status = v_status)
      and (v_doc_type is null or d.document_type = v_doc_type)
      and (p_branch_id is null or d.branch_id = p_branch_id)
      and (p_captured_by is null or d.created_by = p_captured_by)
      and (v_from is null or d.submitted_at >= v_from)
      and (v_to is null or d.submitted_at < v_to)
    order by d.submitted_at desc, d.created_at desc
    limit v_limit;
end;
$function$;

-- Grants, restated because the DROP took the old ones with it. Revoking from
-- anon alone is a no-op — anon inherits PUBLIC's default EXECUTE grant.
revoke all on function public.get_capture_review_queue(uuid, text, text, uuid, uuid, integer, date, date) from public;
revoke all on function public.get_capture_review_queue(uuid, text, text, uuid, uuid, integer, date, date) from anon;
grant execute on function public.get_capture_review_queue(uuid, text, text, uuid, uuid, integer, date, date) to authenticated;
