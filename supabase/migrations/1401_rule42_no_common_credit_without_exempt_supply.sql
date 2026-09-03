-- Rule 42 must not reverse 5% of the input tax of a wholly-taxable business.
--
-- WHAT THE PILOT SAW. TEST Rangoli Spice Works sells spices. Every item it
-- buys and every item it sells is taxable; it has never made a nil-rated,
-- exempt or non-GST outward supply. /reports/common-credit-apportionment
-- nonetheless told it to reverse credit two months running:
--
--   Aug 2026   total input tax 17,080.00   E 0.00   E/F 0.000000   D2   854.00
--   Sep 2026   total input tax 30,585.00   E 0.00   E/F 0.000000   D2 1,529.25
--
-- 2,383.25 of input tax reversed on a business with nothing to apportion. It
-- reaches the return: a Rule 42 reversal is declared in GSTR-3B Table 4(B)(1).
--
-- WHY. get_common_credit_apportionment put EVERY taxable, non-blocked purchase
-- into the common pool C2 and then computed d2_reversal = round(0.05 * C2, 2)
-- unconditionally. D1 fell out correctly on its own because the E/F ratio was
-- zero; D2 has no ratio in it, so nothing stopped it. 0104's own header is
-- candid that it did this deliberately — "this schema has no way to see that a
-- specific taxable purchase was used EXCLUSIVELY for taxable output (T4), so
-- nothing is pulled out on that basis" — and reasoned that over-reversing was
-- the safe direction. For a business that makes no exempt supply at all it is
-- not conservative, it is simply wrong, and it is wrong by a number the
-- taxpayer pays.
--
-- THE RULE, READ RATHER THAN RECALLED (CBIC Rule 42(1) CGST Rules, made under
-- Sec 17(2)/(6); cross-checked against TaxGuru's and ClearTax's clause-by-
-- clause treatments, and the numeral confusion with the omitted Sec 42 of the
-- Act — invoice matching — noted in 0104 still stands):
--
--   T   total input tax on inputs and input services for the period
--   T1  exclusively non-business            T2  exclusively exempt supply
--   T3  blocked under Sec 17(5)
--   C1  = T - (T1 + T2 + T3)
--   T4  ITC on inputs/input services intended to be used EXCLUSIVELY for
--       effecting supplies other than exempted, INCLUDING zero-rated
--   C2  = C1 - T4          <- the common pool, and the ONLY thing Rule 42
--                             apportions
--   D1  = (E / F) x C2     D2 = 5% of C2      C3 = C2 - D1 - D2
--
-- Two points that decide this fix. First, D2's 5% is five per cent OF C2, not
-- of T — every source checked says so, and Rule 42(1)(j) says so. Second,
-- Rule 42(1) engages only for credit "used to make taxable as well as
-- non-taxable/exempt supply". Where a registered person makes no exempt supply,
-- every business input is intended exclusively for taxable supply, so it is T4,
-- C2 = C1 - T4 = 0, and D1 and D2 are both nil because five per cent of nothing
-- is nothing. The reversal does not need a special case switched off; the pool
-- it reverses from was never supposed to contain anything.
--
-- THE SKEPTICAL PASS, because a flat rate that vanishes is exactly the kind of
-- change that can quietly under-collect. D2 exists to catch deemed private use
-- of business inputs, and one could argue that survives whatever the output mix
-- is. It does not survive Rule 42: genuine non-business use is T1 (excluded
-- from C1 outright, a bigger reversal, not a smaller one) or it makes the input
-- common. D2 only ever bites on C2. LEKHA has no field anywhere recording
-- non-business use of a purchase, so it could not identify T1 before this
-- change and cannot now — that limitation is unchanged and is stated in the
-- report's own footnotes. What changes is only that the app stops inventing a
-- common pool where the rule says there is none.
--
-- HOW "MAKES NO EXEMPT SUPPLY" IS DECIDED, and its two honest edges. The test
-- is the same one the report's own E already uses: any non-deleted sales or
-- credit-note item line whose item.supply_nature is nil_rated, exempt or
-- non_gst — but looked for at any date up to p_period_end, not just inside the
-- window. Looking only inside the window would be wrong twice over: a business
-- that genuinely makes exempt supplies but happened to sell only taxable goods
-- in one month would escape D2 for that month, and a month with no sales at all
-- would escape it too. Looking back to p_period_end fixes both. Zero-rated
-- exports are correctly NOT exempt supplies (Sec 17(3) Explanation), and fall
-- out for free because 0081 keeps zero-rating on the transaction, not the item.
--
--   Edge one: a period BEFORE the business's first exempt supply now shows C2
--   of zero even if the same inputs later serve an exempt output. That is the
--   right answer at the time — nothing exempt had been supplied — and Rule
--   42(2)'s annual true-up is exactly the mechanism that corrects it: run this
--   same report over the financial year and the gate sees the year's exempt
--   supplies, so the full-year C2, D1 and D2 come out complete. Verified live
--   on Sharma Textiles, whose first nil-rated sale is 23 Aug 2026: its April
--   monthly figure drops to nil while its FY 2026-27 figures are untouched.
--
--   Edge two: exempt turnover invoiced without item lines is invisible to the
--   gate, exactly as it is already invisible to E. Unchanged limitation.
--
-- THE NEW COLUMN. T4 has to be reported, not just netted off, or the period's
-- input tax would stop adding up: T = T1 + T2 + T3 + T4 + C2. directly_taxable_itc
-- carries it, eligible_itc (everything not blocked) now includes it, and
-- total_input_tax is unchanged in value. The report page renders the waterfall
-- T - T3 - T2 = C2 and will need one more subtraction row for T4 to keep
-- footing; that file is not owned by this migration and the gap is called out
-- in the report accompanying it.
--
-- Rewritten off the live body with asserted replacements rather than retyped.
-- The return type changes, so the function is dropped and recreated instead of
-- replaced in place, and its grants are restated below.

do $mig$
declare
  v_def text;
  v_target text;
  v_hits int;

  procedure_missing constant text := '1401: get_common_credit_apportionment is missing.';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_common_credit_apportionment' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '%', procedure_missing;
  end if;

  -- 1. Report T4 alongside T2 and T3 so the period's input tax still foots.
  v_target := 'exempt_linked_itc numeric, common_credit numeric';
  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);
  if v_hits <> 1 then
    raise exception '1401: expected exactly one exempt_linked_itc/common_credit pair in the signature, found %.', v_hits;
  end if;
  v_def := replace(v_def, v_target,
    'exempt_linked_itc numeric, directly_taxable_itc numeric, common_credit numeric');

  -- 2. Does this company make any exempt supply at all, up to the end of the
  --    period being reported? Same three supply_nature values E uses.
  v_target := E'  with input_vouchers as (\n';
  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);
  if v_hits <> 1 then
    raise exception '1401: expected exactly one `with input_vouchers as (` opener, found %.', v_hits;
  end if;
  v_def := replace(v_def, v_target,
    E'  -- Rule 42(1) only reaches credit used for taxable AND exempt supply. If\n' ||
    E'  -- this company has never made an exempt supply, every business input is\n' ||
    E'  -- intended exclusively for taxable supply — T4 — and the common pool it\n' ||
    E'  -- would otherwise be apportioned from does not exist. Looked for up to\n' ||
    E'  -- p_period_end rather than only inside the window, so a month in which\n' ||
    E'  -- an exempt-supplying business happens to sell nothing exempt still\n' ||
    E'  -- carries D2. See 1401.\n' ||
    E'  with makes_exempt_supply as (\n' ||
    E'    select exists (\n' ||
    E'      select 1\n' ||
    E'        from public.voucher_items vi\n' ||
    E'        join public.vouchers v on v.id = vi.voucher_id\n' ||
    E'        join public.items i on i.id = vi.item_id and i.company_id = vi.company_id\n' ||
    E'       where vi.company_id = p_company_id\n' ||
    E'         and not v.is_deleted\n' ||
    E'         and v.voucher_type in (''sales'', ''credit_note'')\n' ||
    E'         and v.voucher_date <= p_period_end\n' ||
    E'         and i.supply_nature in (''nil_rated'', ''exempt'', ''non_gst'')\n' ||
    E'    ) as yes\n' ||
    E'  ),\n' ||
    E'  input_vouchers as (\n'
  );

  -- 3. Send the taxable, non-blocked share of each voucher to C2 or to T4.
  --    Mutually exclusive on the same value, so the three shares still sum to
  --    one and no rupee of posted tax is lost or double-counted.
  v_target := E'      case when l.line_total = 0 then 0 else l.common_value / l.line_total end as common_share,\n';
  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);
  if v_hits <> 1 then
    raise exception '1401: expected exactly one common_share expression, found %.', v_hits;
  end if;
  v_def := replace(v_def, v_target,
    E'      case when l.line_total = 0 or not (select yes from makes_exempt_supply) then 0\n' ||
    E'           else l.common_value / l.line_total end as common_share,\n' ||
    E'      case when l.line_total = 0 or (select yes from makes_exempt_supply) then 0\n' ||
    E'           else l.common_value / l.line_total end as t4_share,\n'
  );

  -- 4. Bucket T4 per tax head the same way the other three are bucketed.
  v_target :=
    E'      coalesce(sum(common_share * cess), 0) as common_cess\n' ||
    E'      from split\n';
  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);
  if v_hits <> 1 then
    raise exception '1401: expected exactly one common_cess bucket, found %.', v_hits;
  end if;
  v_def := replace(v_def, v_target,
    E'      coalesce(sum(common_share * cess), 0) as common_cess,\n' ||
    E'      coalesce(sum(t4_share * cgst), 0) as t4_cgst,\n' ||
    E'      coalesce(sum(t4_share * sgst), 0) as t4_sgst,\n' ||
    E'      coalesce(sum(t4_share * igst), 0) as t4_igst,\n' ||
    E'      coalesce(sum(t4_share * cess), 0) as t4_cess\n' ||
    E'      from split\n'
  );

  -- 5. T is still the whole of the period's posted input tax: T3 + T2 + T4 + C2.
  v_target :=
    E'    round(\n' ||
    E'      (common_cgst + common_sgst + common_igst + common_cess)\n' ||
    E'      + (blocked_cgst + blocked_sgst + blocked_igst + blocked_cess)\n' ||
    E'      + (exempt_cgst + exempt_sgst + exempt_igst + exempt_cess), 2\n' ||
    E'    ) as total_input_tax,\n';
  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);
  if v_hits <> 1 then
    raise exception '1401: expected exactly one total_input_tax expression, found %.', v_hits;
  end if;
  v_def := replace(v_def, v_target,
    E'    round(\n' ||
    E'      (common_cgst + common_sgst + common_igst + common_cess)\n' ||
    E'      + (blocked_cgst + blocked_sgst + blocked_igst + blocked_cess)\n' ||
    E'      + (exempt_cgst + exempt_sgst + exempt_igst + exempt_cess)\n' ||
    E'      + (t4_cgst + t4_sgst + t4_igst + t4_cess), 2\n' ||
    E'    ) as total_input_tax,\n'
  );

  -- 6. Eligible = everything not blocked, which now includes T4.
  v_target :=
    E'    round(\n' ||
    E'      (common_cgst + common_sgst + common_igst + common_cess)\n' ||
    E'      + (exempt_cgst + exempt_sgst + exempt_igst + exempt_cess), 2\n' ||
    E'    ) as eligible_itc,\n';
  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);
  if v_hits <> 1 then
    raise exception '1401: expected exactly one eligible_itc expression, found %.', v_hits;
  end if;
  v_def := replace(v_def, v_target,
    E'    round(\n' ||
    E'      (common_cgst + common_sgst + common_igst + common_cess)\n' ||
    E'      + (exempt_cgst + exempt_sgst + exempt_igst + exempt_cess)\n' ||
    E'      + (t4_cgst + t4_sgst + t4_igst + t4_cess), 2\n' ||
    E'    ) as eligible_itc,\n'
  );

  -- 7. Emit T4 in the position the new signature declares it.
  v_target := E'    round(exempt_cgst + exempt_sgst + exempt_igst + exempt_cess, 2) as exempt_linked_itc,\n';
  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);
  if v_hits <> 1 then
    raise exception '1401: expected exactly one exempt_linked_itc output expression, found %.', v_hits;
  end if;
  v_def := replace(v_def, v_target,
    E'    round(exempt_cgst + exempt_sgst + exempt_igst + exempt_cess, 2) as exempt_linked_itc,\n' ||
    E'    round(t4_cgst + t4_sgst + t4_igst + t4_cess, 2) as directly_taxable_itc,\n'
  );

  drop function if exists public.get_common_credit_apportionment(uuid, date, date);
  execute v_def;
end;
$mig$;

revoke all on function public.get_common_credit_apportionment(uuid, date, date) from public, anon;
grant execute on function public.get_common_credit_apportionment(uuid, date, date) to authenticated;

comment on function public.get_common_credit_apportionment(uuid, date, date) is
  'CGST Rule 42 apportionment of common credit for a window — call it with a month for the provisional monthly figure or a financial year for the Rule 42(2) annual true-up. Credit on a taxable, non-blocked purchase is T4 (exclusively for taxable supply) and stays OUT of the common pool unless the company has actually made a nil-rated/exempt/non-GST outward supply on or before p_period_end, so a wholly-taxable business no longer has 5% of its input tax reversed as D2 against an empty exempt ratio (1401). D2 is 5% of C2, not of T. Rule 43 (capital goods) is not built. Report only; no posting RPC. See 0104, 1401.';
