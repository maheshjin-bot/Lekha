-- ============================================================================
-- 0090 — GST set-off computation and clearing journal (Sec 49/49A/49B, Rule 88A)
-- ============================================================================
-- Live audit, run moments before this migration was written:
--
--   select m.purpose, count(e.id) from tax_ledger_map m left join voucher_entries e
--     on e.ledger_id = m.ledger_id where m.purpose in (...) group by 1;
--
--   gst_payable = 0, gst_refund_receivable = 0,
--   input_cgst = 10, input_sgst = 10, input_igst = 0,
--   output_cgst = 12, output_sgst = 12, output_igst = 0
--
-- create_invoice has been posting output and input tax on every taxable
-- voucher since the GST module shipped. Nothing has ever read those eight
-- ledgers together and struck the number a business actually owes or carries
-- forward — the single most basic GST computation there is, and it did not
-- exist. get_gst_output_register/input_register (0035) report gross output
-- and input tax per voucher; they do not net one against the other, still
-- less in the legally mandated order.
--
-- THE ORDER IS NOT "JUST NET EVERYTHING". Sec 49A (inserted by the CGST
-- Amendment Act 2018, effective 1 Feb 2019) requires IGST credit to be
-- utilised in FULL — against IGST, CGST or SGST/UTGST output, in any order or
-- proportion — before a rupee of CGST or SGST credit may be touched at all.
-- Rule 88A (inserted 29 Mar 2019, effective 1 Apr 2019) is the operating rule
-- for that flexibility. Once IGST credit is exhausted (meaning: applied to
-- the maximum extent the remaining output liability across all three heads
-- allows, not merely "some amount used"), CGST credit goes first to CGST
-- output and only the remainder to IGST output; SGST credit goes first to
-- SGST output and only the remainder to IGST output. CGST credit can NEVER
-- reduce SGST output, or SGST credit CGST output — Sec 49(5)(c)/(d) bar that
-- cross-utilisation outright, and Rule 88A did not touch it. This was
-- verified with two fresh web searches rather than trusting recollection,
-- since the ITC-utilisation rules have been amended more than once since
-- 2017 (searches: "Rule 88A order of utilisation... 2026" and "Section 49A
-- 49B... IGST fully utilised first", both returning the same ordering from
-- IRIS GST, ClearTax and TaxGuru).
--
-- Within the IGST block this migration applies IGST credit to IGST output,
-- then CGST output, then SGST output — the law permits "any order", so this
-- sequence is an implementation choice, not a statutory requirement, and is
-- stated as such in the function comment.
--
-- COMPENSATION CESS IS ITS OWN LANE, NEVER MIXED. A second web search
-- (compensation cess ITC cross-utilisation) confirmed the proviso to Sec 11
-- of the GST (Compensation to States) Act specifically bars cess credit from
-- paying CGST/SGST/IGST and bars CGST/SGST/IGST credit from paying cess —
-- unlike IGST/CGST/SGST, there is no cross-utilisation gateway for cess at
-- all. So cess is computed as an entirely independent pair (input_cess only
-- ever offsets output_cess) rather than folded into the three-head cascade.
-- Every company in this database currently carries a zero cess balance, so
-- this lane is unexercised by live data — the logic is still written and
-- tested by hand below in a rolled-back transaction with synthetic figures,
-- because "nobody has cess yet" is not the same as "nobody will".
--
-- RCM PAYABLE IS DELIBERATELY UNTOUCHED. Sec 49(4): "the amount available in
-- the electronic credit ledger... may be used for making payment towards
-- output tax" and reverse-charge tax is explicitly carved out of "output
-- tax" for this purpose — RCM liability must be discharged in cash and is
-- never eligible for ITC set-off. rcm_payable was already excluded from the
-- audit query above and stays excluded here; conflating it with output
-- CGST/SGST/IGST would be a real correctness bug, not a simplification.
--
-- gst_refund_receivable IS NOT USED HERE, ON PURPOSE. It is worth reading
-- what it is before assuming this migration should credit it: it exists for
-- an actual Rule 89 REFUND CLAIM (export/inverted-duty/excess-cash-ledger
-- refunds), a separate application to the department with its own workflow.
-- Unutilised ITC at ordinary period end is not a refund — it is simply
-- carried forward inside the credit ledger until a later period's output
-- liability absorbs it, which is exactly what happens automatically here:
-- the input ledgers are credited only for what they actually fund, and
-- whatever is left over is left exactly where it already sits. Forcing it
-- into gst_refund_receivable would fabricate a refund claim that was never
-- filed. Rule 89(4)/(5) refund computation remains a separate, larger,
-- explicitly out-of-scope feature — see the audit register.
--
-- INCREMENTAL, LIKE post_closing_stock (0076) AND post_depreciation (0077).
-- The eight control ledgers are read at their CLOSING BALANCE as at the
-- chosen date (app_private.ledger_opening_signed at date + 1, the same
-- "closing as at" trick those two migrations use), not scoped to "this
-- calendar month's postings". That is what makes re-running this idempotent
-- for free, with no separate high-water-mark to track: the very first
-- clearing journal debits every output ledger down to nil and credits every
-- input ledger by whatever it funded, so the NEXT period's closing balance on
-- those same ledgers is, by construction, only the movement since — new
-- invoices posted after the last clearing. Running post_gst_setoff twice for
-- a period with nothing new to clear finds the output ledgers already at nil
-- and raises rather than posting an empty or duplicate journal.
--
-- ONE JOURNAL PER GST REGISTRATION. A GSTIN is a separate taxable person for
-- this purpose; a company with registrations in two States must clear each
-- one on its own, exactly like get_gst_output_register/input_register already
-- key everything off p_gst_registration_id. Unlike those two read functions
-- the registration id is NOT optional here — an "across all registrations"
-- clearing journal would net one State's liability against another State's
-- credit, which Sec 49A does not permit.
--
-- WHAT THIS DOES NOT DO: compute a Rule 89 refund (out of scope, noted
-- above); generate a PMT-06 challan for the resulting net_payable — that is
-- what tax_payments (0079) already exists for, and the correct next step
-- after posting this is to record a challan there against gst_payable, not a
-- second challan mechanism invented here; or format anything for GSTR-3B
-- Table 6.1 — this is the underlying computation that a 6.1 formatter would
-- eventually read, not the formatter itself.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- app_private.gst_setoff_legs — the computation, shared by the read RPC and
-- the posting RPC so the two can never drift apart.
-- ----------------------------------------------------------------------------
-- Returns one row per "leg" of the set-off: the opening position of each of
-- the eight ledgers, then each actual utilisation (which credit head funded
-- how much of which output head, in the order the law requires), then the
-- net payable left per head (what could not be covered by any credit) and
-- the ITC left carried forward per head (credit that found no liability to
-- offset, and simply stays in the input ledger it already sits in).
create or replace function app_private.gst_setoff_legs(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_as_at date
)
returns table (
  step integer,
  row_kind text,     -- 'output_opening' | 'input_opening' | 'utilisation' | 'net_payable' | 'itc_carried_forward'
  tax_head text,      -- 'cgst' | 'sgst' | 'igst' | 'cess' — the OUTPUT head a row concerns
  credit_head text,   -- utilisation rows only: which credit head funded this leg
  amount numeric,
  narration text
)
language plpgsql
stable
set search_path to ''
as $fn$
declare
  v_l_out_cgst uuid; v_l_out_sgst uuid; v_l_out_igst uuid; v_l_out_cess uuid;
  v_l_in_cgst uuid;  v_l_in_sgst uuid;  v_l_in_igst uuid;  v_l_in_cess uuid;

  v_out_cgst numeric; v_out_sgst numeric; v_out_igst numeric; v_out_cess numeric;
  v_in_cgst numeric;  v_in_sgst numeric;  v_in_igst numeric;  v_in_cess numeric;

  v_step integer := 1;
  v_leg numeric;
begin
  select ledger_id into v_l_out_cgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_cgst';
  select ledger_id into v_l_out_sgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_sgst';
  select ledger_id into v_l_out_igst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_igst';
  select ledger_id into v_l_out_cess from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_cess';
  select ledger_id into v_l_in_cgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_cgst';
  select ledger_id into v_l_in_sgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_sgst';
  select ledger_id into v_l_in_igst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_igst';
  select ledger_id into v_l_in_cess from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_cess';

  if v_l_out_cgst is null then
    raise exception
      'No GST control ledgers found for this registration. They are seeded automatically when a GST registration is added — check the registration exists for this company.';
  end if;

  -- Closing balance as at p_as_at, in each ledger's own natural-positive
  -- sign: output ledgers are liability (credit-normal), input ledgers are
  -- asset (debit-normal). A balance on the wrong side (e.g. an output ledger
  -- sitting in debit, which would mean credit notes this period outran
  -- sales) is clamped to zero rather than guessed at — it is left exactly
  -- where it sits, uncleared, same as get_stock_summary's negative-value
  -- case in 0076 is posted rather than hidden, except here there is no
  -- meaningful "post what it says" for a sign that should not occur, so it
  -- is simply excluded from this run.
  v_out_cgst := greatest(0, -app_private.ledger_opening_signed(p_company_id, v_l_out_cgst, p_as_at + 1, null));
  v_out_sgst := greatest(0, -app_private.ledger_opening_signed(p_company_id, v_l_out_sgst, p_as_at + 1, null));
  v_out_igst := greatest(0, -app_private.ledger_opening_signed(p_company_id, v_l_out_igst, p_as_at + 1, null));
  v_out_cess := greatest(0, -app_private.ledger_opening_signed(p_company_id, v_l_out_cess, p_as_at + 1, null));
  v_in_cgst  := greatest(0,  app_private.ledger_opening_signed(p_company_id, v_l_in_cgst,  p_as_at + 1, null));
  v_in_sgst  := greatest(0,  app_private.ledger_opening_signed(p_company_id, v_l_in_sgst,  p_as_at + 1, null));
  v_in_igst  := greatest(0,  app_private.ledger_opening_signed(p_company_id, v_l_in_igst,  p_as_at + 1, null));
  v_in_cess  := greatest(0,  app_private.ledger_opening_signed(p_company_id, v_l_in_cess,  p_as_at + 1, null));

  row_kind := 'output_opening'; credit_head := null;
  tax_head := 'cgst'; amount := round(v_out_cgst, 2); step := v_step; narration := 'Output CGST liability outstanding as at ' || p_as_at; return next; v_step := v_step + 1;
  tax_head := 'sgst'; amount := round(v_out_sgst, 2); step := v_step; narration := 'Output SGST/UTGST liability outstanding as at ' || p_as_at; return next; v_step := v_step + 1;
  tax_head := 'igst'; amount := round(v_out_igst, 2); step := v_step; narration := 'Output IGST liability outstanding as at ' || p_as_at; return next; v_step := v_step + 1;
  tax_head := 'cess'; amount := round(v_out_cess, 2); step := v_step; narration := 'Output Cess liability outstanding as at ' || p_as_at; return next; v_step := v_step + 1;

  row_kind := 'input_opening';
  tax_head := 'cgst'; amount := round(v_in_cgst, 2); step := v_step; narration := 'Input CGST credit available as at ' || p_as_at; return next; v_step := v_step + 1;
  tax_head := 'sgst'; amount := round(v_in_sgst, 2); step := v_step; narration := 'Input SGST/UTGST credit available as at ' || p_as_at; return next; v_step := v_step + 1;
  tax_head := 'igst'; amount := round(v_in_igst, 2); step := v_step; narration := 'Input IGST credit available as at ' || p_as_at; return next; v_step := v_step + 1;
  tax_head := 'cess'; amount := round(v_in_cess, 2); step := v_step; narration := 'Input Cess credit available as at ' || p_as_at; return next; v_step := v_step + 1;

  row_kind := 'utilisation';

  -- IGST credit first, in full, before CGST/SGST credit is touched at all
  -- (Sec 49A). Order across IGST/CGST/SGST output is "any order" per Rule
  -- 88A — IGST-output, then CGST-output, then SGST-output is this app's
  -- chosen sequence, not a statutory one.
  v_leg := least(v_in_igst, v_out_igst);
  if v_leg > 0 then
    tax_head := 'igst'; credit_head := 'igst'; amount := round(v_leg, 2); step := v_step;
    narration := 'IGST credit applied to IGST output'; return next; v_step := v_step + 1;
    v_in_igst := v_in_igst - v_leg; v_out_igst := v_out_igst - v_leg;
  end if;

  v_leg := least(v_in_igst, v_out_cgst);
  if v_leg > 0 then
    tax_head := 'cgst'; credit_head := 'igst'; amount := round(v_leg, 2); step := v_step;
    narration := 'IGST credit applied to CGST output'; return next; v_step := v_step + 1;
    v_in_igst := v_in_igst - v_leg; v_out_cgst := v_out_cgst - v_leg;
  end if;

  v_leg := least(v_in_igst, v_out_sgst);
  if v_leg > 0 then
    tax_head := 'sgst'; credit_head := 'igst'; amount := round(v_leg, 2); step := v_step;
    narration := 'IGST credit applied to SGST/UTGST output'; return next; v_step := v_step + 1;
    v_in_igst := v_in_igst - v_leg; v_out_sgst := v_out_sgst - v_leg;
  end if;

  -- CGST credit: CGST output first (mandatory), remainder to IGST output.
  -- Never SGST — Sec 49(5)(c) bars it outright.
  v_leg := least(v_in_cgst, v_out_cgst);
  if v_leg > 0 then
    tax_head := 'cgst'; credit_head := 'cgst'; amount := round(v_leg, 2); step := v_step;
    narration := 'CGST credit applied to CGST output'; return next; v_step := v_step + 1;
    v_in_cgst := v_in_cgst - v_leg; v_out_cgst := v_out_cgst - v_leg;
  end if;

  v_leg := least(v_in_cgst, v_out_igst);
  if v_leg > 0 then
    tax_head := 'igst'; credit_head := 'cgst'; amount := round(v_leg, 2); step := v_step;
    narration := 'CGST credit applied to IGST output (CGST output already nil)'; return next; v_step := v_step + 1;
    v_in_cgst := v_in_cgst - v_leg; v_out_igst := v_out_igst - v_leg;
  end if;

  -- SGST credit: SGST output first (mandatory), remainder to IGST output.
  -- Never CGST — Sec 49(5)(d) bars it outright.
  v_leg := least(v_in_sgst, v_out_sgst);
  if v_leg > 0 then
    tax_head := 'sgst'; credit_head := 'sgst'; amount := round(v_leg, 2); step := v_step;
    narration := 'SGST/UTGST credit applied to SGST/UTGST output'; return next; v_step := v_step + 1;
    v_in_sgst := v_in_sgst - v_leg; v_out_sgst := v_out_sgst - v_leg;
  end if;

  v_leg := least(v_in_sgst, v_out_igst);
  if v_leg > 0 then
    tax_head := 'igst'; credit_head := 'sgst'; amount := round(v_leg, 2); step := v_step;
    narration := 'SGST/UTGST credit applied to IGST output (SGST/UTGST output already nil)'; return next; v_step := v_step + 1;
    v_in_sgst := v_in_sgst - v_leg; v_out_igst := v_out_igst - v_leg;
  end if;

  -- Cess: its own lane, never mixed with CGST/SGST/IGST in either direction.
  v_leg := least(v_in_cess, v_out_cess);
  if v_leg > 0 then
    tax_head := 'cess'; credit_head := 'cess'; amount := round(v_leg, 2); step := v_step;
    narration := 'Cess credit applied to Cess output'; return next; v_step := v_step + 1;
    v_in_cess := v_in_cess - v_leg; v_out_cess := v_out_cess - v_leg;
  end if;

  row_kind := 'net_payable'; credit_head := null;
  tax_head := 'cgst'; amount := round(v_out_cgst, 2); step := v_step; narration := 'CGST output left unmet by any credit'; return next; v_step := v_step + 1;
  tax_head := 'sgst'; amount := round(v_out_sgst, 2); step := v_step; narration := 'SGST/UTGST output left unmet by any credit'; return next; v_step := v_step + 1;
  tax_head := 'igst'; amount := round(v_out_igst, 2); step := v_step; narration := 'IGST output left unmet by any credit'; return next; v_step := v_step + 1;
  tax_head := 'cess'; amount := round(v_out_cess, 2); step := v_step; narration := 'Cess output left unmet by any credit'; return next; v_step := v_step + 1;

  row_kind := 'itc_carried_forward';
  tax_head := 'cgst'; amount := round(v_in_cgst, 2); step := v_step; narration := 'CGST credit left unutilised — stays in Input CGST, not moved'; return next; v_step := v_step + 1;
  tax_head := 'sgst'; amount := round(v_in_sgst, 2); step := v_step; narration := 'SGST/UTGST credit left unutilised — stays in Input SGST/UTGST, not moved'; return next; v_step := v_step + 1;
  tax_head := 'igst'; amount := round(v_in_igst, 2); step := v_step; narration := 'IGST credit left unutilised — stays in Input IGST, not moved'; return next; v_step := v_step + 1;
  tax_head := 'cess'; amount := round(v_in_cess, 2); step := v_step; narration := 'Cess credit left unutilised — stays in Input Cess, not moved'; return next;

  return;
end;
$fn$;

-- ----------------------------------------------------------------------------
-- public.get_gst_setoff_computation — read-only, for the report screen
-- ----------------------------------------------------------------------------
create or replace function public.get_gst_setoff_computation(
  p_company_id uuid,
  p_gst_registration_id uuid,
  p_as_at date
)
returns table (
  step integer,
  row_kind text,
  tax_head text,
  credit_head text,
  amount numeric,
  narration text
)
language sql
stable
set search_path to ''
as $fn$
  select * from app_private.gst_setoff_legs(p_company_id, p_gst_registration_id, p_as_at);
$fn$;

revoke all on function public.get_gst_setoff_computation(uuid, uuid, date) from public, anon;
grant execute on function public.get_gst_setoff_computation(uuid, uuid, date) to authenticated;

comment on function public.get_gst_setoff_computation(uuid, uuid, date) is
  'Sec 49/49A/49B + Rule 88A GST set-off, computed but not posted: IGST credit exhausted first against IGST/CGST/SGST output in that order, then CGST credit to CGST-then-IGST output, then SGST credit to SGST-then-IGST output, cess as its own independent lane, RCM excluded (Sec 49(4) bars ITC against reverse charge). Reads the eight control ledgers'' own closing balance as at the date, so a second call after nothing new posts returns all zeros. See 0090.';

-- ----------------------------------------------------------------------------
-- public.post_gst_setoff — the clearing journal
-- ----------------------------------------------------------------------------
-- Debits each output-tax ledger down to nil for its full opening balance,
-- credits each input-tax ledger down by exactly what it funded, and credits
-- the shortfall — if any — to GST Payable. Whatever credit found no
-- liability to offset is left exactly where it already sits; nothing is
-- pushed into GST Refund Receivable (see the migration header for why).
create or replace function public.post_gst_setoff(
  p_company_id uuid,
  p_branch_id uuid,
  p_gst_registration_id uuid,
  p_as_at date,
  p_narration text default null
)
returns uuid
language plpgsql
set search_path to ''
as $fn$
declare
  v_l_out_cgst uuid; v_l_out_sgst uuid; v_l_out_igst uuid; v_l_out_cess uuid;
  v_l_in_cgst uuid;  v_l_in_sgst uuid;  v_l_in_igst uuid;  v_l_in_cess uuid;
  v_l_payable uuid;

  v_out_cgst numeric; v_out_sgst numeric; v_out_igst numeric; v_out_cess numeric;
  v_util_igst numeric; v_util_cgst numeric; v_util_sgst numeric; v_util_cess numeric;
  v_net_payable numeric;

  v_lines jsonb := '[]'::jsonb;
  v_voucher_id uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to post for this company';
  end if;

  select ledger_id into v_l_out_cgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_cgst';
  select ledger_id into v_l_out_sgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_sgst';
  select ledger_id into v_l_out_igst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_igst';
  select ledger_id into v_l_out_cess from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'output_cess';
  select ledger_id into v_l_in_cgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_cgst';
  select ledger_id into v_l_in_sgst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_sgst';
  select ledger_id into v_l_in_igst from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_igst';
  select ledger_id into v_l_in_cess from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'input_cess';
  select ledger_id into v_l_payable from public.tax_ledger_map
   where company_id = p_company_id and gst_registration_id = p_gst_registration_id and purpose = 'gst_payable';

  if v_l_out_cgst is null or v_l_payable is null then
    raise exception
      'GST control ledgers are missing for this registration — check the registration was set up correctly.';
  end if;

  select
      coalesce(sum(amount) filter (where row_kind = 'output_opening' and tax_head = 'cgst'), 0),
      coalesce(sum(amount) filter (where row_kind = 'output_opening' and tax_head = 'sgst'), 0),
      coalesce(sum(amount) filter (where row_kind = 'output_opening' and tax_head = 'igst'), 0),
      coalesce(sum(amount) filter (where row_kind = 'output_opening' and tax_head = 'cess'), 0),
      coalesce(sum(amount) filter (where row_kind = 'utilisation' and credit_head = 'igst'), 0),
      coalesce(sum(amount) filter (where row_kind = 'utilisation' and credit_head = 'cgst'), 0),
      coalesce(sum(amount) filter (where row_kind = 'utilisation' and credit_head = 'sgst'), 0),
      coalesce(sum(amount) filter (where row_kind = 'utilisation' and credit_head = 'cess'), 0),
      coalesce(sum(amount) filter (where row_kind = 'net_payable'), 0)
    into v_out_cgst, v_out_sgst, v_out_igst, v_out_cess,
         v_util_igst, v_util_cgst, v_util_sgst, v_util_cess,
         v_net_payable
    from app_private.gst_setoff_legs(p_company_id, p_gst_registration_id, p_as_at);

  if v_out_cgst + v_out_sgst + v_out_igst + v_out_cess = 0 then
    raise exception
      'Output tax ledgers for this registration already carry a zero balance as at % — there is nothing to clear.',
      p_as_at;
  end if;

  if v_out_cgst > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_l_out_cgst, 'debit_amount', v_out_cgst));
  end if;
  if v_out_sgst > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_l_out_sgst, 'debit_amount', v_out_sgst));
  end if;
  if v_out_igst > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_l_out_igst, 'debit_amount', v_out_igst));
  end if;
  if v_out_cess > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_l_out_cess, 'debit_amount', v_out_cess));
  end if;

  if v_util_igst > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_l_in_igst, 'credit_amount', v_util_igst));
  end if;
  if v_util_cgst > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_l_in_cgst, 'credit_amount', v_util_cgst));
  end if;
  if v_util_sgst > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_l_in_sgst, 'credit_amount', v_util_sgst));
  end if;
  if v_util_cess > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_l_in_cess, 'credit_amount', v_util_cess));
  end if;

  if v_net_payable > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('ledger_id', v_l_payable, 'credit_amount', v_net_payable));
  end if;

  v_voucher_id := public.create_voucher(
    p_company_id := p_company_id,
    p_branch_id := p_branch_id,
    p_voucher_type := 'journal',
    p_voucher_date := p_as_at,
    p_lines := v_lines,
    p_narration := coalesce(
      p_narration,
      'GST set-off as at ' || to_char(p_as_at, 'DD Mon YYYY')
        || ' — net payable ' || round(v_net_payable, 2)
    )
  );

  return v_voucher_id;
end;
$fn$;

revoke all on function public.post_gst_setoff(uuid, uuid, uuid, date, text) from public, anon;
grant execute on function public.post_gst_setoff(uuid, uuid, uuid, date, text) to authenticated;

comment on function public.post_gst_setoff(uuid, uuid, uuid, date, text) is
  'Posts the Sec 49/49A/49B + Rule 88A GST set-off as one journal: Dr each output-tax ledger to nil, Cr each input-tax ledger by what it funded, Cr GST Payable with the shortfall (nothing is forced into GST Refund Receivable — see 0090). Reads closing ledger balances, so it is additive and safe to re-run; a period with nothing new to clear raises rather than double-posting. One registration per call — never nets one GSTIN''s liability against another''s credit.';
