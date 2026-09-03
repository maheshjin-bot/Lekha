-- A purchase return has to come OFF the eligible taxable value, not go onto it.
--
-- WHAT THE PILOT SAW. TEST Rangoli Spice Works raised one debit note against a
-- supplier in September — HO/DBN/2026-27/00001, taxable value 18,400, input tax
-- 920. The GST registers screen's ITC eligibility split for FY 2026-27 read:
--
--   eligible taxable value  747,440.00      eligible tax  47,665.00
--
-- 747,440.00 is the arithmetic sum of every purchase AND debit-note line in the
-- year, the return added on rather than taken off. The tax column, meanwhile,
-- had already netted the return out on its own — input tax is read from the
-- postings as debit_amount - credit_amount, and a purchase return credits the
-- input tax ledger, so 47,665.00 is 48,585.00 of purchases less 920.00 of
-- return. So the two halves of the same row disagreed about direction: value
-- overstated by twice the return, 36,800.00, while tax was right.
--
-- WHY. voucher_lines summed vi.amount raw, with nothing anywhere in the CTE
-- looking at what kind of document the line belonged to. get_gst_input_register
-- (0035) and get_common_credit_apportionment (0104) both lean on the posting
-- sign to carry the direction for them, which works for tax and cannot work for
-- a value taken straight off voucher_items — those rows are unsigned by design,
-- with the document type carrying the direction. In LEKHA a purchase return IS
-- a debit note: /reports/purchase-returns locks the list to voucher_type
-- 'debit_note', 0104's input side reads 'purchase' and 'debit_note' together,
-- and a sales return is the mirror-image credit_note on the output side.
--
-- WHAT THE WHOLE EXPRESSION NEEDED, not just the sign. Flipping the sign on
-- line_total alone would have broken the apportionment that sits underneath it.
-- The split CTE divides a voucher's posted tax between eligible and blocked by
-- each side's share of the voucher's own value, and guarded that division with
-- `line_total > 0`. Once a return's line_total is legitimately negative, that
-- guard stops being a divide-by-zero guard and starts being a document-type
-- filter: a negative line_total would fall through to the `else` branch and
-- hand the WHOLE of the return's tax to the eligible side with zero to blocked,
-- silently mis-stating any return of a Sec 17(5) item. So the guard becomes
-- `<> 0`, which is what it was always meant to be. Numerator and denominator
-- are negated together, so every share is unchanged and the eligible/blocked
-- TAX split — the figure that feeds GSTR-3B Table 4(B)(1) — comes out to the
-- rupee it did before. Only the two value columns move.
--
-- No statutory question arises here: nothing in the CGST Act or Rules is being
-- reinterpreted. Sec 34(3)/(4) debit and credit notes adjust the value of the
-- original supply, up or down, and this is simply the app failing to subtract.
--
-- Rewritten off the live body with asserted replacements rather than retyped.

do $mig$
declare
  v_def text;
  v_target text;
  v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_itc_eligibility_summary' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1402: get_itc_eligibility_summary is missing.';
  end if;

  -- 1. A debit note is a purchase return: its lines reduce the period's
  --    inward taxable value, they do not add to it.
  v_target :=
    E'  voucher_lines as (\n' ||
    E'    select vi.voucher_id,\n' ||
    E'           coalesce(sum(vi.amount), 0) as line_total,\n' ||
    E'           coalesce(sum(vi.amount) filter (where i.itc_eligibility = ''blocked''), 0) as blocked_value,\n' ||
    E'           coalesce(sum(vi.amount) filter (where i.itc_eligibility <> ''blocked''), 0) as eligible_value\n' ||
    E'      from public.voucher_items vi\n' ||
    E'      join public.items i on i.id = vi.item_id\n' ||
    E'     group by vi.voucher_id\n' ||
    E'  ),\n';
  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);
  if v_hits <> 1 then
    raise exception '1402: expected exactly one voucher_lines CTE, found %. Body has moved; fix by hand.', v_hits;
  end if;
  v_def := replace(
    v_def,
    v_target,
    E'  -- voucher_items rows are unsigned; the DOCUMENT carries the direction.\n' ||
    E'  -- A debit note is this app''s purchase return (0104''s input side pairs\n' ||
    E'  -- it with ''purchase'', /reports/purchase-returns locks to it), so its\n' ||
    E'  -- lines come OFF the period''s inward value — matching the tax column,\n' ||
    E'  -- which already nets the return out through the posting sign. See 1402.\n' ||
    E'  voucher_lines as (\n' ||
    E'    select vi.voucher_id,\n' ||
    E'           coalesce(sum(case when vv.voucher_type = ''debit_note''\n' ||
    E'                             then -vi.amount else vi.amount end), 0) as line_total,\n' ||
    E'           coalesce(sum(case when vv.voucher_type = ''debit_note''\n' ||
    E'                             then -vi.amount else vi.amount end)\n' ||
    E'                    filter (where i.itc_eligibility = ''blocked''), 0) as blocked_value,\n' ||
    E'           coalesce(sum(case when vv.voucher_type = ''debit_note''\n' ||
    E'                             then -vi.amount else vi.amount end)\n' ||
    E'                    filter (where i.itc_eligibility <> ''blocked''), 0) as eligible_value\n' ||
    E'      from public.voucher_items vi\n' ||
    E'      join public.items i on i.id = vi.item_id\n' ||
    E'      join public.vouchers vv on vv.id = vi.voucher_id\n' ||
    E'     group by vi.voucher_id\n' ||
    E'  ),\n'
  );

  -- 2. The guard on the apportionment is a divide-by-zero guard, not a
  --    positivity test. A return's line_total is now legitimately negative and
  --    must still be apportioned by share, not dumped whole into eligible.
  v_target :=
    E'      case when l.line_total > 0\n' ||
    E'           then t.input_tax * (l.eligible_value / l.line_total) else t.input_tax end as eligible_tax,\n' ||
    E'      case when l.line_total > 0\n' ||
    E'           then t.input_tax * (l.blocked_value / l.line_total) else 0 end as blocked_tax\n';
  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);
  if v_hits <> 1 then
    raise exception '1402: expected exactly one eligible/blocked apportionment pair, found %. Body has moved; fix by hand.', v_hits;
  end if;
  v_def := replace(
    v_def,
    v_target,
    E'      case when l.line_total <> 0\n' ||
    E'           then t.input_tax * (l.eligible_value / l.line_total) else t.input_tax end as eligible_tax,\n' ||
    E'      case when l.line_total <> 0\n' ||
    E'           then t.input_tax * (l.blocked_value / l.line_total) else 0 end as blocked_tax\n'
  );

  execute v_def;
end;
$mig$;

revoke all on function public.get_itc_eligibility_summary(uuid, date, date) from public, anon;
grant execute on function public.get_itc_eligibility_summary(uuid, date, date) to authenticated;

comment on function public.get_itc_eligibility_summary(uuid, date, date) is
  'Splits a period''s input tax into claimable and Sec 17(5)-blocked. Tax is posted per voucher but blocking is decided per item, so a mixed voucher is apportioned by taxable value. A debit note is a purchase return: its line values are SUBTRACTED from the period''s taxable value, the same direction the posting sign already gives the tax columns (1402). Blocked tax belongs in GSTR-3B Table 4(B)(1) as a non-reclaimable reversal. See 0082, 1402.';
