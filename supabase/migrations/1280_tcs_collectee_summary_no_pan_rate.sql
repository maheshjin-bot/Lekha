-- ============================================================================
-- 1280 — TCS collectee summary (27EQ prep) was displaying the base rate even
-- when Sec 206CC's higher no-PAN rate is what actually got collected
-- ============================================================================
-- get_tcs_collectee_summary (0146) always selected ref_tcs_sections.rate_percent
-- — the base, with-PAN rate — and never substituted no_pan_rate_percent for a
-- collectee with no PAN on file. create_invoice (0027 onward, every later
-- copy through 0865) has always applied the correct rate at posting time:
-- `coalesce(case when v_party_pan is null then v_tcs_no_pan_rate else
-- v_tcs_rate end, 0)`. So the amount actually collected was always right;
-- only this report's own displayed rate was wrong.
--
-- Found live: Verma & Associates' real scrap sale to a no-PAN collectee
-- collected TCS at the correct 5% (₹1,180 on ₹23,600), but the 27EQ
-- annexure showed "Rate 2%" next to it — a figure that cannot reconcile by
-- hand with the amount beside it, and exactly the kind of thing Sec 206CC
-- compliance needs flagged, not silently hidden behind a mislabeled rate.
--
-- Fix: section_rate_percent now reflects the rate that actually applied
-- (mirroring create_invoice's own l.pan is null condition, keyed off the
-- same ledgers.pan column), plus a new no_pan_rate_applied flag so the
-- screen can call it out explicitly rather than leave a reader to notice
-- the number doesn't add up on their own.
-- ============================================================================

create or replace function public.get_tcs_collectee_summary(
  p_company_id uuid,
  p_financial_year_label text,
  p_quarter integer
) returns table (
  collectee_ledger_id uuid,
  collectee_name text,
  pan text,
  section_code text,
  section_description text,
  section_rate_percent numeric,
  no_pan_rate_applied boolean,
  voucher_count integer,
  tcs_collected numeric,
  party_ledger_movement numeric
)
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_fy_start int;
  v_period_start date;
  v_period_end date;
begin
  if p_financial_year_label !~ '^\d{4}-\d{2}$' then
    raise exception 'p_financial_year_label must look like "2026-27"';
  end if;
  if p_quarter not in (1, 2, 3, 4) then
    raise exception 'p_quarter must be 1, 2, 3 or 4';
  end if;

  v_fy_start := split_part(p_financial_year_label, '-', 1)::int;
  v_period_start := case p_quarter
    when 1 then make_date(v_fy_start, 4, 1)
    when 2 then make_date(v_fy_start, 7, 1)
    when 3 then make_date(v_fy_start, 10, 1)
    when 4 then make_date(v_fy_start + 1, 1, 1)
  end;
  v_period_end := (v_period_start + interval '3 months' - interval '1 day')::date;

  return query
    with tcs_lines as (
      select e.voucher_id, sum(e.credit_amount - e.debit_amount) as tcs_amount
        from public.voucher_entries e
        join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
        join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
       where e.company_id = p_company_id
         and m.purpose = 'output_tcs'
         and (e.credit_amount > 0 or e.debit_amount > 0)
         and not v.is_deleted
         and v.voucher_date between v_period_start and v_period_end
       group by e.voucher_id
    ),
    section_candidates as (
      select vi.voucher_id, i.default_tcs_section as section_code
        from public.voucher_items vi
        join public.items i on i.id = vi.item_id and i.company_id = vi.company_id
        join tcs_lines t on t.voucher_id = vi.voucher_id
       where vi.company_id = p_company_id
         and i.default_tcs_section is not null
    ),
    voucher_section as (
      select sc.voucher_id,
             case when count(distinct sc.section_code) = 1
                  then (array_agg(distinct sc.section_code))[1] end as section_code
        from section_candidates sc
       group by sc.voucher_id
    ),
    party_movement as (
      select e.voucher_id, abs(e.debit_amount - e.credit_amount) as movement
        from public.voucher_entries e
        join tcs_lines t on t.voucher_id = e.voucher_id
        join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
       where e.company_id = p_company_id
         and v.party_ledger_id is not null
         and e.ledger_id = v.party_ledger_id
    ),
    attributed as (
      select
        t.voucher_id,
        t.tcs_amount,
        v.party_ledger_id as collectee_ledger_id,
        vs.section_code,
        coalesce(pm.movement, 0) as party_ledger_movement
        from tcs_lines t
        join public.vouchers v on v.id = t.voucher_id and v.company_id = p_company_id
        left join voucher_section vs on vs.voucher_id = t.voucher_id
        left join party_movement pm on pm.voucher_id = t.voucher_id
    )
    select
      a.collectee_ledger_id,
      coalesce(l.name, '(unattributed — voucher has no party ledger on file)') as collectee_name,
      l.pan,
      a.section_code,
      s.description as section_description,
      -- The rate that ACTUALLY applied — same l.pan is null condition
      -- create_invoice itself uses to pick between rate_percent and
      -- no_pan_rate_percent at posting time. See this migration's header.
      case when l.pan is null then s.no_pan_rate_percent else s.rate_percent end as section_rate_percent,
      (l.pan is null and s.no_pan_rate_percent is not null) as no_pan_rate_applied,
      count(*)::integer as voucher_count,
      sum(a.tcs_amount) as tcs_collected,
      sum(a.party_ledger_movement) as party_ledger_movement
      from attributed a
      left join public.ledgers l on l.id = a.collectee_ledger_id
      left join public.ref_tcs_sections s on s.section_code = a.section_code
     group by a.collectee_ledger_id, l.name, l.pan, a.section_code, s.description, s.rate_percent, s.no_pan_rate_percent
     order by (a.collectee_ledger_id is null), (a.section_code is null), s.description nulls last, l.name nulls last;
end;
$function$;

revoke all on function public.get_tcs_collectee_summary(uuid, text, integer) from public, anon;
grant execute on function public.get_tcs_collectee_summary(uuid, text, integer) to authenticated;

comment on function public.get_tcs_collectee_summary(uuid, text, integer) is
  'Per-collectee-per-section TCS summary for one Apr-Jun/Jul-Sep/Oct-Dec/Jan-Mar quarter of p_financial_year_label ("2026-27"-shaped) — the collectee-wise annexure for Form 143/27EQ (Sec 206C, recodified Sec 394(1)). Collectee is read directly off vouchers.party_ledger_id (reliable here because create_invoice/update_invoice always set it on the only voucher types that ever post output_tcs — see migration 0146 for why this is NOT the same voting mechanism get_tds_deductee_summary uses). Section comes from items.default_tcs_section, attributed to a voucher''s whole TCS total only when every TCS-tagged item line on it shares one section; a voucher mixing sections gets section_code null, the "needs review" bucket. section_rate_percent (1280) is the rate that ACTUALLY applied — ref_tcs_sections.no_pan_rate_percent when the collectee has no PAN on file, matching create_invoice''s own condition, not the base rate_percent regardless of PAN as 0146 originally computed it; no_pan_rate_applied flags this explicitly rather than leaving a reader to notice the number does not reconcile. tcs_collected nets credit-minus-debit on the output_tcs-mapped ledger per voucher (a TCS-bearing credit_note reverses correctly). Sec 206C(1G) LRS/foreign-remittance/overseas-tour-package TCS is out of scope — not item-based, nothing in this schema posts it. See 0146''s header for full statutory sourcing and scope.';
