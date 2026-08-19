-- ============================================================================
-- 0036 — Input Service Distributor: the Rule 39 distribution calculation
-- ============================================================================
-- ref_modules has named gst_isd since 0004 ("GSTR-6 and Rule 39
-- distribution"); registration_type already accepts 'isd' (0005) and
-- excludes it from company_gstin_count on purpose. Nothing computed the
-- actual distribution until now.
--
-- MECHANICS (Sec 20 CGST Act, Rule 39, researched fresh): a company with
-- common input services billed to one office (the ISD) redistributes that
-- office's input tax credit pro-rata by turnover to its other GST
-- registrations ("recipients") under the same PAN, monthly, reported on
-- GSTR-6. Two things this migration computes precisely because they are
-- easy to get wrong:
--
--   Turnover ratio = recipient's turnover in the PRECEDING financial year
--   / aggregate turnover of every operational recipient in that year. Falls
--   back to an EQUAL split across recipients (Rule 39(1)(d)) only when NO
--   recipient has any turnover on record for that year — not per-recipient,
--   which would misrepresent a genuinely zero-turnover branch as excluded
--   rather than sharing equally.
--
--   Tax-type conversion: IGST credit at the ISD is ALWAYS distributed as
--   IGST, to every recipient, regardless of location. CGST/SGST credit is
--   distributed as CGST/SGST when the recipient is in the SAME state as the
--   ISD, and CONVERTED to IGST when the recipient is in a DIFFERENT state —
--   a recipient's distributed_igst therefore sums two different sources
--   depending on its own state, not a simple per-tax-type pass-through.
--   Cess follows the same always-cess treatment as IGST (no CGST/SGST/IGST
--   distinction applies to compensation cess).
--
-- TURNOVER SOURCE: reuses get_gst_output_register (0035) per recipient
-- registration rather than re-deriving taxable-value logic a second time —
-- one tested source of truth for "what did this registration sell", not two
-- that could quietly disagree.
--
-- RELEVANT PERIOD: the preceding calendar April-March financial year
-- containing p_period_start, same convention as every other statutory
-- report in this app (never this company's own FY). Rule 39's own fallback
-- for a registration with no turnover in that year — use the last quarter
-- for which turnover data exists — is NOT implemented; a registration that
-- is genuinely new (no history in the preceding FY) reads as zero turnover
-- for its own share, correct only in the all-recipients-zero case where the
-- equal-split fallback above applies instead. Documented, not guessed.
--
-- COMPUTATION ONLY, NOT AUTO-POSTING. This returns the split GSTR-6 prep
-- needs; it does not journal-post the actual ITC transfer entries (which
-- would need new voucher_entries across potentially several branches/
-- registrations in one voucher, is genuinely separate work, and — same
-- restraint as every other filing-adjacent feature this session — LEKHA
-- has no GSTN API to file GSTR-6 through regardless).
-- ============================================================================

create or replace function public.get_isd_distribution(
  p_company_id uuid,
  p_isd_registration_id uuid,
  p_period_start date,
  p_period_end date
) returns table (
  recipient_registration_id uuid,
  recipient_gstin text,
  recipient_state char(2),
  same_state boolean,
  recipient_turnover numeric,
  turnover_ratio numeric,
  distributed_cgst numeric,
  distributed_sgst numeric,
  distributed_igst numeric,
  distributed_cess numeric,
  distributed_total numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_isd_state char(2);
  v_avail_cgst numeric := 0;
  v_avail_sgst numeric := 0;
  v_avail_igst numeric := 0;
  v_avail_cess numeric := 0;
  v_fy_start_year int;
  v_fy_start date;
  v_fy_end date;
begin
  select r.state_code into v_isd_state
    from public.gst_registrations r
   where r.id = p_isd_registration_id and r.company_id = p_company_id;

  if v_isd_state is null then
    return; -- unknown registration, or it doesn't belong to this company
  end if;

  -- ITC available for distribution: input tax posted under the ISD
  -- registration itself during the period -- common input services billed
  -- to that office. Signed the same way every input-side figure in this
  -- app is (debit increases the ITC asset), same as get_gst_input_register.
  select
      coalesce(sum(case when m.purpose = 'input_cgst' then e.debit_amount - e.credit_amount else 0 end), 0),
      coalesce(sum(case when m.purpose = 'input_sgst' then e.debit_amount - e.credit_amount else 0 end), 0),
      coalesce(sum(case when m.purpose = 'input_igst' then e.debit_amount - e.credit_amount else 0 end), 0),
      coalesce(sum(case when m.purpose = 'input_cess' then e.debit_amount - e.credit_amount else 0 end), 0)
    into v_avail_cgst, v_avail_sgst, v_avail_igst, v_avail_cess
    from public.voucher_entries e
    join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
    join public.tax_ledger_map m
      on m.ledger_id = e.ledger_id
     and m.company_id = e.company_id
     and m.gst_registration_id = p_isd_registration_id
   where e.company_id = p_company_id
     and m.purpose in ('input_cgst', 'input_sgst', 'input_igst', 'input_cess')
     and v.voucher_date between p_period_start and p_period_end;

  -- Preceding calendar April-March FY containing p_period_start.
  v_fy_start_year := extract(year from p_period_start)::int
    - case when extract(month from p_period_start) >= 4 then 0 else 1 end;
  v_fy_start := make_date(v_fy_start_year - 1, 4, 1);
  v_fy_end := make_date(v_fy_start_year, 3, 31);

  return query
  with recipients as (
    select r.id, r.gstin, r.state_code
      from public.gst_registrations r
     where r.company_id = p_company_id
       and r.id <> p_isd_registration_id
       and r.registration_type <> 'isd'
       and r.registered_from <= p_period_end
       and (r.registered_to is null or r.registered_to >= p_period_start)
  ),
  turnovers as (
    select
      rec.id, rec.gstin, rec.state_code,
      coalesce((
        select sum(o.taxable_value)
          from public.get_gst_output_register(p_company_id, v_fy_start, v_fy_end, rec.id) o
      ), 0) as turnover
      from recipients rec
  ),
  totals as (
    select sum(turnover) as total_turnover, count(*) as recipient_count from turnovers
  )
  select
    tv.id,
    tv.gstin::text,
    tv.state_code,
    (tv.state_code = v_isd_state),
    tv.turnover,
    -- Ratio: turnover share, or an equal split when nobody has turnover.
    round(
      case when t.total_turnover > 0 then tv.turnover / t.total_turnover
           else 1.0 / nullif(t.recipient_count, 0)
      end,
      6
    ),
    case when tv.state_code = v_isd_state then
      round(v_avail_cgst * (case when t.total_turnover > 0 then tv.turnover / t.total_turnover else 1.0 / nullif(t.recipient_count, 0) end), 2)
    else 0 end,
    case when tv.state_code = v_isd_state then
      round(v_avail_sgst * (case when t.total_turnover > 0 then tv.turnover / t.total_turnover else 1.0 / nullif(t.recipient_count, 0) end), 2)
    else 0 end,
    case when tv.state_code = v_isd_state then
      round(v_avail_igst * (case when t.total_turnover > 0 then tv.turnover / t.total_turnover else 1.0 / nullif(t.recipient_count, 0) end), 2)
    else
      round((v_avail_igst + v_avail_cgst + v_avail_sgst) * (case when t.total_turnover > 0 then tv.turnover / t.total_turnover else 1.0 / nullif(t.recipient_count, 0) end), 2)
    end,
    round(v_avail_cess * (case when t.total_turnover > 0 then tv.turnover / t.total_turnover else 1.0 / nullif(t.recipient_count, 0) end), 2),
    -- Total: recomputed from the four just-rounded columns above, not a
    -- fifth independent multiplication, so this always ties out to what the
    -- reader can add up themselves.
    (case when tv.state_code = v_isd_state then
       round(v_avail_cgst * (case when t.total_turnover > 0 then tv.turnover / t.total_turnover else 1.0 / nullif(t.recipient_count, 0) end), 2)
     else 0 end)
    + (case when tv.state_code = v_isd_state then
       round(v_avail_sgst * (case when t.total_turnover > 0 then tv.turnover / t.total_turnover else 1.0 / nullif(t.recipient_count, 0) end), 2)
     else 0 end)
    + (case when tv.state_code = v_isd_state then
       round(v_avail_igst * (case when t.total_turnover > 0 then tv.turnover / t.total_turnover else 1.0 / nullif(t.recipient_count, 0) end), 2)
     else
       round((v_avail_igst + v_avail_cgst + v_avail_sgst) * (case when t.total_turnover > 0 then tv.turnover / t.total_turnover else 1.0 / nullif(t.recipient_count, 0) end), 2)
     end)
    + round(v_avail_cess * (case when t.total_turnover > 0 then tv.turnover / t.total_turnover else 1.0 / nullif(t.recipient_count, 0) end), 2)
  from turnovers tv
  cross join totals t
  order by tv.gstin;
end;
$$;

comment on function public.get_isd_distribution is
  'Rule 39 ISD distribution calculation, GSTR-6 prep: this office''s available input tax credit for the period, split pro-rata by each other registration''s preceding-FY turnover (equal split if none has turnover), converting CGST/SGST to IGST for out-of-state recipients per Rule 39. Computation only - does not post the transfer entries or file anything. See the migration header for the full scope.';
