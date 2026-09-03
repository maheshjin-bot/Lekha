-- Rule 37 must age an opening creditor balance like any other charge.
--
-- WHAT THE PILOT SAW. TEST Rangoli Spice Works opened its books on 1 Apr 2026
-- with three creditor ledgers carrying opening balances — Saurashtra Agro
-- 412,000 Cr, Konkan Packaging 158,000 Cr, Sahyadri Farm 62,000 Cr — then
-- traded a month and paid some of them off. /reports/itc-180day-reversal
-- reported 20,678.43 of ITC to reverse. Hand-derived from voucher_entries and
-- ledgers.opening_balance_amount the answer is 48,810.00. The report was
-- 28,131.57 short, and it disagreed with the app's OWN payables ageing on the
-- identical data, which is what made a preparer look twice.
--
-- WHY. get_itc_180day_reversal builds its FIFO pool from voucher_entries only.
-- get_party_outstanding (0017, extended by 1050) does not: it injects each
-- party ledger's opening_balance_amount as a charge dated at the company's
-- book_beginning_date, precisely because money owed from before the books
-- began is still money owed. This report skipped that half — but its
-- `payments` CTE still summed EVERY negative delta on the ledger. So a payment
-- made against an opening creditor balance was counted as settling something,
-- while the thing it settled was invisible, and the payment silently ate into
-- purchase invoices that were in fact still wholly unpaid.
--
-- Konkan Packaging is the clean case. Opening 158,000; one payment of 158,000
-- on 5 Sep clearing exactly that; then two purchase bills of 59,967 and 47,016
-- that nobody paid. The ageing report shows both bills outstanding. This report
-- showed NEITHER — the orphaned 158,000 payment cancelled them out — so
-- 8,817 + 6,966 = 15,783 of ITC on two bills over 180 days old never appeared
-- at all. Saurashtra's first bill was shown at 106,600 outstanding instead of
-- its full 325,920 (the 219,320 of payments and debit notes belonged against
-- the 412,000 opening, which is older), understating its reversal by 10,443.81.
-- Sahyadri's by 1,904.76 for the same reason.
--
-- THE RULE, RE-CHECKED RATHER THAN RECALLED. Second proviso to Sec 16(2) CGST
-- Act with Rule 37 CGST Rules: ITC availed on an inward supply must be added
-- back if the supplier is not paid the invoice value including tax within 180
-- days of the invoice date. Sub-rules (1) and (2) as substituted w.e.f.
-- 1 Oct 2022 (Notification 19/2022-CT) with "proportionate to the amount not
-- paid to the supplier" inserted by Notification 26/2022-CT make the reversal
-- proportionate to the UNPAID FRACTION, not the whole invoice, and the add-back
-- goes in the GSTR-3B of the tax period following the 180 days. Re-availment
-- on later payment is not time-barred by Sec 16(4). All of that is 0096's
-- arithmetic and NONE of it changes here — 0096 read the rule correctly. What
-- changes is only which charges are in the pool the FIFO runs over, i.e. how
-- much of an invoice this app believes is still unpaid. Rule 37A (supplier has
-- not filed, a different trigger) is still not built and is not touched.
--
-- WHAT THIS DOES NOT CHANGE. An opening balance is not an invoice: it carries
-- no voucher, no invoice date and no input-tax posting, so it can never itself
-- become a reversal row — the `computed` CTE's inner join to vouchers drops it,
-- exactly as it already drops journals and debit notes. It only takes its
-- rightful place in the queue, so that payments are consumed oldest-first the
-- way get_party_outstanding already consumes them. Same reason, same
-- convention, same book_beginning_date anchor, so the two reports can no longer
-- disagree.
--
-- A DEBIT opening balance on a creditor ledger (we are in advance to the
-- supplier) becomes a negative charge and is therefore picked up by `payments`,
-- which is the same treatment 0017/1050 gives it.
--
-- Rewritten off the live body with asserted replacements rather than retyped,
-- so the 180-day threshold, the proportionate reversal, the 18% Sec 50(1)
-- interest and the rounding order are all carried through untouched.

do $mig$
declare
  v_def text;
  v_target text;
  v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_itc_180day_reversal' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1400: get_itc_180day_reversal is missing.';
  end if;

  -- 1. Anchor the opening balance to the company's own book_beginning_date,
  --    the identical anchor get_party_outstanding uses.
  v_target := E'  with party as (\n';
  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);
  if v_hits <> 1 then
    raise exception '1400: expected exactly one `with party as (` opener, found %. Body has moved; fix by hand.', v_hits;
  end if;
  v_def := replace(
    v_def,
    v_target,
    E'  with book_start as (\n' ||
    E'    select coalesce(book_beginning_date, ''1900-01-01''::date) as d\n' ||
    E'      from public.companies where id = p_company_id\n' ||
    E'  ),\n' ||
    E'  party as (\n'
  );

  -- 2. Put the opening balance into the same dated charge list the FIFO runs
  --    over. Null voucher_id and an empty voucher_number: the empty string
  --    sorts before every real number on the same date, so the opening is
  --    consumed first, and the null is dropped by `computed`'s inner join to
  --    vouchers so it is never reported as a reversal row of its own.
  v_target :=
    E'  dated_charges as (\n' ||
    E'    select c.voucher_id, c.ledger_id, c.delta, v.voucher_date, v.voucher_number\n' ||
    E'      from charges c\n' ||
    E'      join public.vouchers v on v.id = c.voucher_id\n' ||
    E'  ),\n';
  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);
  if v_hits <> 1 then
    raise exception '1400: expected exactly one dated_charges CTE, found %. Body has moved; fix by hand.', v_hits;
  end if;
  v_def := replace(
    v_def,
    v_target,
    E'  -- Money owed to a supplier from before the books began is still money\n' ||
    E'  -- owed, and a payment against it is not a payment against a later\n' ||
    E'  -- invoice. get_party_outstanding has injected this since 0017; leaving\n' ||
    E'  -- it out here while still counting the payments that settle it is what\n' ||
    E'  -- understated the reversal. See 1400.\n' ||
    E'  opening as (\n' ||
    E'    select l.id as ledger_id,\n' ||
    E'           case when l.opening_balance_type = ''credit''\n' ||
    E'                then l.opening_balance_amount else -l.opening_balance_amount end as amount\n' ||
    E'      from public.ledgers l\n' ||
    E'      join party p on p.ledger_id = l.id\n' ||
    E'  ),\n' ||
    E'  dated_charges as (\n' ||
    E'    select c.voucher_id, c.ledger_id, c.delta, v.voucher_date, v.voucher_number\n' ||
    E'      from charges c\n' ||
    E'      join public.vouchers v on v.id = c.voucher_id\n' ||
    E'    union all\n' ||
    E'    select null::uuid, o.ledger_id, o.amount, (select d from book_start), ''''\n' ||
    E'      from opening o\n' ||
    E'     where o.amount <> 0\n' ||
    E'  ),\n'
  );

  execute v_def;
end;
$mig$;

revoke all on function public.get_itc_180day_reversal(uuid, date) from public, anon;
grant execute on function public.get_itc_180day_reversal(uuid, date) to authenticated;

comment on function public.get_itc_180day_reversal(uuid, date) is
  'Rule 37 / second proviso to Sec 16(2): purchase invoices more than 180 days old as at p_as_at with an outstanding balance, the ITC availed on each, the proportionate reversal on the unpaid share and interest at 18% p.a. under Sec 50(1). FIFO ageing now includes each creditor ledger''s opening balance as a charge dated at book_beginning_date, the same way get_party_outstanding does, so a payment made against an opening balance no longer silently discharges a later purchase bill (1400). An opening balance is never itself reported — it has no invoice and no input tax. Cannot exclude reverse-charge purchases: no per-voucher RCM flag exists. Report only; no posting RPC. See 0096, 1400.';
