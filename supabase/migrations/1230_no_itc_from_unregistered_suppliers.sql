-- A purchase from an unregistered supplier must not book tax nobody charged.
--
-- WHY. Two pilot preparers found this independently, working from opposite
-- ends of the ledger — the strongest signal the run produced.
--
-- app_private.gst_supply_type has branches for overseas, sez, sez_developer
-- and deemed_export, then falls through to intra/inter on the state codes.
-- There is no branch for 'unregistered' or 'composition', and create_invoice
-- never looks at the party's registration type again after handing it over.
-- So a supplier who legally CANNOT charge GST is taxed at the item master's
-- rate anyway:
--
--   Purchases - Raw Spices          Dr  52,800.00
--   Input CGST (27)                 Dr   1,320.00   <- nobody charged this
--   Input SGST (27)                 Dr   1,320.00   <- nor this
--      TEST Sahyadri Farm Produce       Cr  55,440.00  <- the bill says 52,800
--
-- Three things go wrong at once, and the third is the one that costs real
-- money outside the books: input credit overstated by 2,640, trade payables
-- overstated by 2,640, and a clerk who pays the bill in full pays the
-- supplier 2,640 MORE than the paper in their hand. It reaches the returns
-- too — the input register lists it with a null counterparty GSTIN and the
-- GSTR-3B prep folds it into Table 4(A)(5), which is credit claimed on a
-- document that cannot support a claim.
--
-- THE LAW. An unregistered person cannot collect GST at all (Sec 32(1) CGST
-- Act: only a registered person may). A composition dealer cannot either —
-- Sec 10(4) forbids collecting tax, and Rule 49 has them issue a BILL OF
-- SUPPLY rather than a tax invoice, which by definition carries no tax and
-- supports no credit. Both are therefore zero, for the same reason.
--
-- WHAT IS DELIBERATELY LEFT ALONE
--
-- RCM is untouched, and this is the distinction that matters. Reverse charge
-- is driven by items.is_rcm_applicable — a property of WHAT is bought, not of
-- who sold it — and it is already mutually exclusive with the ordinary tax
-- branch, precisely because under reverse charge the supplier charges nothing.
-- A notified Sec 9(3) item bought from an unregistered supplier still
-- self-assesses its rcm_payable exactly as before; that liability is ours to
-- declare and is entirely correct. The new guard sits inside the non-RCM
-- branch so it cannot interfere.
--
-- SALES are untouched. Selling TO an unregistered customer is ordinary B2C
-- and we charge tax normally — the guard is scoped to v_tax_prefix = 'input',
-- which is exactly the two documents on which we would claim credit
-- (purchase and debit note) and no others.
--
-- 'uin' is NOT included. A UIN holder is an embassy or UN body; buying FROM
-- one is not the case this bug is about, and guessing at it would be
-- over-reach. Left to be decided by someone with a real example.
--
-- The rest of create_invoice is preserved byte-for-byte: rewritten off its own
-- live body rather than retyped, so the numbering, stock, TCS, RCM and
-- rounding behaviour cannot drift on the way through.

do $mig$
declare
  v_def text;
  v_target text;
  v_hits int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_invoice' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1230: create_invoice is missing.';
  end if;

  v_target :=
    E'      else\n' ||
    E'        if v_supply_type = ''export_lut'' or (v_supply_type = ''sez'' and v_lut_active) then';

  v_hits := (length(v_def) - length(replace(v_def, v_target, ''))) / length(v_target);

  if v_hits <> 1 then
    raise exception
      '1230: expected exactly one tax branch to patch in create_invoice, found %. Its body has moved; fix by hand.',
      v_hits;
  end if;

  v_def := replace(
    v_def,
    v_target,
    E'      else\n' ||
    E'        if v_tax_prefix = ''input''\n' ||
    E'           and v_party_reg_type in (''unregistered'', ''composition'') then\n' ||
    E'          -- This supplier cannot lawfully have charged us any tax: an\n' ||
    E'          -- unregistered person may not collect it (Sec 32(1)) and a\n' ||
    E'          -- composition dealer may not either (Sec 10(4)), issuing a bill\n' ||
    E'          -- of supply instead of a tax invoice (Rule 49). So there is no\n' ||
    E'          -- input credit to take and nothing to add to what we owe them.\n' ||
    E'          -- Reached only when the line is NOT reverse-charge: RCM is a\n' ||
    E'          -- property of the item, applies whoever sold it, and is still\n' ||
    E'          -- self-assessed above.\n' ||
    E'          null;\n' ||
    E'        elsif v_supply_type = ''export_lut'' or (v_supply_type = ''sez'' and v_lut_active) then'
  );

  execute v_def;
end;
$mig$;

comment on function public.create_invoice is
  'Posts a tax invoice, bill, credit or debit note with its GST, RCM and TCS. No input tax is computed on a purchase or debit note from an unregistered or composition supplier — neither may lawfully collect it, so there is no credit to claim and nothing to add to the payable (1230). RCM is unaffected: it follows the item, not the supplier.';
