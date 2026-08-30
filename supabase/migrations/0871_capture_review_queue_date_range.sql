-- ============================================================================
-- 0871 — get_capture_review_queue learns p_from / p_to
-- ============================================================================
-- 0870 shipped the review queue with four filters (status, document type,
-- branch, capturer) and a row limit, but no date range. The inbox screen still
-- offered "arrived between" — so it filtered CLIENT-SIDE, on the rows the RPC
-- had already returned.
--
-- THE BUG THAT FIXES: the limit is applied in SQL, the date filter afterwards
-- in the browser. Ask a busy company for "last Tuesday" and the RPC returns
-- the newest 200 submitted drafts, of which perhaps three are from Tuesday —
-- and the screen shows three, looking authoritative, while older Tuesday rows
-- sat outside the 200 and were never fetched at all. A filter that silently
-- under-reports is worse than one that is missing, because nothing on screen
-- says the answer is partial. Filtering BEFORE the limit is the whole fix.
--
-- WHY submitted_at AND NOT created_at: this is the "arrived" column — when the
-- phone actually sent the document, not when the operator first opened the
-- camera. The queue already restricts to `submitted_at is not null` (0870
-- section 3: a draft still being assembled on a phone is in nobody's queue),
-- so within this function submitted_at is guaranteed non-null and needs no
-- coalesce. It is also what the screen's own `arrivedAt` reads first and what
-- the ORDER BY already sorts on, so the filter, the sort and the timestamp on
-- screen are now all the same column.
--
-- WHY Asia/Kolkata AND NOT the caller's timezone: a date filter has to pick a
-- day boundary, and "the browser's local midnight" was the old client-side
-- behaviour by accident rather than by design — the same saved query run by a
-- reviewer travelling abroad silently covered a different 24 hours than it did
-- in the office. This is an Indian statutory accounting product; the business
-- day is IST. lib/scan/recentSends.ts already states that assumption in as
-- many words. Stated here too, rather than left implicit.
--
-- SARGABLE ON PURPOSE: written as a half-open range against the timestamptz
-- column (>= IST midnight of p_from, < IST midnight of the day AFTER p_to)
-- rather than the more obvious
--   (submitted_at at time zone 'Asia/Kolkata')::date between p_from and p_to
-- which would wrap the column in a function call and give up any index on it.
-- Both forms include both endpoint days; only one of them can use an index.
--
-- DROP AND RECREATE, NOT CREATE OR REPLACE: adding parameters changes the
-- signature, and CREATE OR REPLACE cannot do that — it would create a second
-- OVERLOAD alongside the 6-argument original, leaving two functions of the
-- same name where a call that omits the optional arguments is ambiguous. The
-- explicit drop names the old 6-argument signature, so this migration cannot
-- accidentally remove some other overload instead.
--
-- The body below is 0870's, unchanged except for the two new parameters,
-- their validation, and the two lines added to the WHERE clause.
-- ============================================================================

drop function if exists public.get_capture_review_queue(uuid, text, text, uuid, uuid, integer);

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
  duplicate_of_draft_id uuid
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

  -- A null, blank or literal 'all' filter means no filter. Anything else
  -- unrecognised RAISES rather than silently widening the queue — a typo'd
  -- filter that quietly returns everything is worse than an error.
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

  -- An inverted range is a mistake, not an empty result: silently returning
  -- zero rows for from=31st to=1st looks identical on screen to "nothing
  -- arrived", which is the same silent-wrong-answer failure this migration
  -- exists to remove.
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'The "from" date (%) is after the "to" date (%)', p_from, p_to;
  end if;

  -- Half-open [from 00:00 IST, day-after-to 00:00 IST) — inclusive of both
  -- endpoint days, and still able to use an index on submitted_at.
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
      dup.other_id
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
      -- Advisory only: another draft in the SAME company whose first page is
      -- byte-identical to this one's. Never blocks, never merges — the
      -- reviewer decides. See 0870 section 6.
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
      -- Drafts still being assembled on a phone are NOT reviewable. 0870
      -- header section 3 — this is the whole reason submitted_at exists.
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
-- anon ALONE is a no-op — anon inherits PUBLIC's default EXECUTE grant, the
-- exact gap 0064 and 0231 both had to be reopened to fix. Revoke from PUBLIC
-- as well, then grant to authenticated only.
revoke all on function public.get_capture_review_queue(uuid, text, text, uuid, uuid, integer, date, date) from public;
revoke all on function public.get_capture_review_queue(uuid, text, text, uuid, uuid, integer, date, date) from anon;
grant execute on function public.get_capture_review_queue(uuid, text, text, uuid, uuid, integer, date, date) to authenticated;
