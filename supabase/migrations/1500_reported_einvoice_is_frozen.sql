-- An invoice that already carries an IRN cannot be edited into a different
-- document.
--
-- WHY. A pilot preparer opened SAL/26-27/0001 in the invoice editor and saved
-- it with different figures. The voucher changed. public.einvoice_details for
-- that voucher did not: it still holds
-- irn 66a2558e3284b935a192eb32e82b1217f0dbb7fc00a8ca6e2cf15b0bd1371fa8,
-- ack_number 112610001234567 and the SignedQRCode the IRP returned for the
-- figures that were REPORTED. The print page renders that QR next to the new
-- total, so the document leaving the building carries a government-signed
-- attestation of an amount that is no longer on it. Nothing warned anyone:
-- update_invoice has never looked at einvoice_details at all, and the
-- editor's own subtitle ("Saving replaces every line") is a promise it keeps.
--
-- The damage is not confined to the paper. The IRP's copy is what flows into
-- the buyer's GSTR-2B, so the buyer claims credit on the reported figure while
-- the seller's books carry the edited one, and the mismatch surfaces months
-- later as a Rule 36(4) / 2B-reconciliation query against the BUYER.
--
-- ---------------------------------------------------------------------------
-- THE LAW, and what the permitted window actually is
-- ---------------------------------------------------------------------------
--
-- Researched today (2 Sep 2026) and then checked a second time specifically
-- hunting for a change, because "24 hours" is exactly the kind of remembered
-- number that goes stale:
--
--   * AN E-INVOICE CANNOT BE AMENDED ON THE IRP AT ALL. Not partially, not
--     for a typo. The IRP offers cancellation and nothing else.
--   * CANCELLATION IS ALLOWED WITHIN 24 HOURS OF IRN GENERATION — measured
--     from the acknowledgement (AckDt), not from the invoice date, and it is
--     the whole document or nothing; partial cancellation does not exist.
--     The underlying reason is operational rather than statutory: the IRP is
--     not required to store an e-invoice for more than 24 hours, so after
--     that there is nothing there to cancel. The cancel action simply
--     disappears from the portal.
--   * CANCELLATION IS ALSO REFUSED, INSIDE THE 24 HOURS, IF AN ACTIVE E-WAY
--     BILL EXISTS AGAINST THAT IRN. The EWB must be cancelled first.
--   * AFTER THE WINDOW the lawful corrections are the ordinary ones:
--     a credit note or debit note under Sec 34 CGST Act (which is itself a
--     document to be reported to the IRP, as CRN / DBN), or an amendment in
--     the amendment tables of a later GSTR-1 (B2BA and friends) under
--     Sec 37(3). Both leave the original invoice standing, which is the
--     point — a reported document is not made to have never existed.
--
--   A NUMBER I DELIBERATELY DID NOT ENCODE: the 30-day limit for REPORTING an
--   invoice to the IRP (AATO >= Rs 10 crore from 1 Apr 2025, lowered from
--   Rs 100 crore). It governs how late you may register a document, not how
--   long you may cancel one, and folding the two together is a mistake this
--   guard has no need to make.
--
--   Sources read today: cleartax.in's "Amendment and Cancellation of
--   e-Invoice" (including its FAQ on the active-e-way-bill block),
--   gimbooks.com's cancellation-vs-amendment note (which is explicit that the
--   24 hours runs from IRN generation), mastersindia.co and busy.in agreeing
--   on both points; a second search aimed at finding an extension of the
--   window found none, and no NIC/GSTN advisory changing it. I could NOT
--   trace the 24 hours to a numbered CGST Rule, and I am not going to invent
--   one: it is an IRP system rule published in the e-invoice FAQ, and the
--   message below says "on the IRP" rather than citing a rule it does not
--   have. Sec 34 and Sec 37(3) ARE statute and are cited as such.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS REFUSES, AND WHAT IT STILL ALLOWS
-- ---------------------------------------------------------------------------
--
-- A blanket "this voucher is locked" would be easy and slightly wrong: it
-- would dead-end a preparer fixing a misspelt narration, and push them into
-- deleting and re-entering the voucher, which is far worse for a document
-- that has been reported.
--
-- So the guard refuses exactly what the IRN attests, and nothing else. The
-- signed QR carries seller GSTIN, BUYER GSTIN, document number, DOCUMENT
-- DATE, invoice VALUE, line count and main HSN; the payload behind it adds
-- the place of supply, which decides CGST+SGST versus IGST and therefore the
-- value. Frozen, therefore:
--
--     party_ledger_id, voucher_date, place_of_supply,
--     and every line's item / quantity / rate / discount_percent
--
-- Still editable: narration, reference number and date, challan number and
-- date, and the godown the stock moves from. None of those appear on the
-- e-invoice payload or in the signed QR, so changing one cannot make the
-- document disagree with its IRN.
--
-- The number itself was already unchangeable — update_invoice has no
-- voucher_number argument (0055), and re-dating across a financial year is
-- already refused there.
--
-- SCOPE. This binds on einvoice_details.irn being present, i.e. status
-- 'irn_obtained'. A row at 'json_ready' is NOT frozen: this app assembled a
-- payload, nobody has reported it, and rebuilding it after an edit is the
-- normal way to work. The /einvoice screen already rebuilds from the live
-- voucher.
--
-- HOW. update_invoice is rewritten off its own live body (pg_get_functiondef
-- + targeted replace + an assertion that the replace matched), the house
-- pattern of 1200/1230/1240 — its GST, RCM, TCS, discount and rounding
-- arithmetic is long-settled and must not drift on the way through a
-- migration that has nothing to do with it.

do $mig$
declare
  v_def text;
  v_anchor_decl text;
  v_anchor_body text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'update_invoice' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1500: public.update_invoice is missing.';
  end if;

  if position('-- 1500: the reported-e-invoice freeze.' in v_def) > 0 then
    raise notice '1500: update_invoice already carries the reported-e-invoice freeze; nothing to do.';
    return;
  end if;

  -- Deliberately ASCII-only anchors. The live body contains em dashes and a
  -- rupee-adjacent character or two; matching on those has bitten this
  -- codebase before when a definition travelled through a shell.
  v_anchor_decl := E'  v_rcm_ledger uuid;\nbegin\n';
  v_anchor_body := E'  delete from public.voucher_items where voucher_id = p_voucher_id;\n';

  if (length(v_def) - length(replace(v_def, v_anchor_decl, ''))) / length(v_anchor_decl) <> 1 then
    raise exception '1500: expected exactly one declare-block anchor in update_invoice; its body has moved. Fix by hand.';
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor_body, ''))) / length(v_anchor_body) <> 1 then
    raise exception '1500: expected exactly one voucher_items delete in update_invoice; its body has moved. Fix by hand.';
  end if;

  v_def := replace(v_def, v_anchor_decl,
    E'  v_rcm_ledger uuid;\n' ||
    E'\n' ||
    E'  -- 1500: the reported-e-invoice freeze.\n' ||
    E'  v_irn text;\n' ||
    E'  v_ack timestamptz;\n' ||
    E'  v_number text;\n' ||
    E'  v_old_party uuid;\n' ||
    E'  v_old_date date;\n' ||
    E'  v_old_pos char(2);\n' ||
    E'  v_old_lines int;\n' ||
    E'  v_changed text[] := ''{}'';\n' ||
    E'  v_lines_differ boolean;\n' ||
    E'  v_remedy text;\n' ||
    E'begin\n'
  );

  v_def := replace(v_def, v_anchor_body,
    E'  -- -------------------------------------------------------------------\n' ||
    E'  -- 1500: an invoice already reported to the IRP is frozen on every\n' ||
    E'  -- field its IRN attests. Placed here deliberately -- after the place\n' ||
    E'  -- of supply has been derived (it may arrive null and be filled in\n' ||
    E'  -- from the party, so comparing the raw argument would report a change\n' ||
    E'  -- that is not one), and before the first row is deleted.\n' ||
    E'  -- -------------------------------------------------------------------\n' ||
    E'  select e.irn, e.ack_date into v_irn, v_ack\n' ||
    E'    from public.einvoice_details e\n' ||
    E'   where e.voucher_id = p_voucher_id and e.irn is not null;\n' ||
    E'\n' ||
    E'  if v_irn is not null then\n' ||
    E'    select v.party_ledger_id, v.voucher_date, v.place_of_supply, v.voucher_number\n' ||
    E'      into v_old_party, v_old_date, v_old_pos, v_number\n' ||
    E'      from public.vouchers v where v.id = p_voucher_id;\n' ||
    E'\n' ||
    E'    if p_party_ledger_id is distinct from v_old_party then\n' ||
    E'      v_changed := v_changed || ''the party''::text;\n' ||
    E'    end if;\n' ||
    E'    if p_voucher_date is distinct from v_old_date then\n' ||
    E'      v_changed := v_changed || ''the invoice date''::text;\n' ||
    E'    end if;\n' ||
    E'    if p_place_of_supply is distinct from v_old_pos then\n' ||
    E'      v_changed := v_changed || ''the place of supply''::text;\n' ||
    E'    end if;\n' ||
    E'\n' ||
    E'    select count(*) into v_old_lines\n' ||
    E'      from public.voucher_items where voucher_id = p_voucher_id;\n' ||
    E'\n' ||
    E'    if v_old_lines <> jsonb_array_length(p_items) then\n' ||
    E'      v_lines_differ := true;\n' ||
    E'    else\n' ||
    E'      -- Compared position by position, the same order update_invoice\n' ||
    E'      -- itself writes line_order in. Only the value-bearing fields:\n' ||
    E'      -- item, quantity, rate and discount are what produce the taxable\n' ||
    E'      -- value, the tax and therefore the signed total.\n' ||
    E'      select coalesce(bool_or(\n' ||
    E'               vi.item_id  is distinct from (t.line->>''item_id'')::uuid\n' ||
    E'            or vi.quantity is distinct from (t.line->>''quantity'')::numeric\n' ||
    E'            or vi.rate     is distinct from coalesce((t.line->>''rate'')::numeric, 0)\n' ||
    E'            or coalesce(vi.discount_percent, 0)\n' ||
    E'                 is distinct from coalesce((t.line->>''discount_percent'')::numeric, 0)\n' ||
    E'             ), false)\n' ||
    E'        into v_lines_differ\n' ||
    E'        from jsonb_array_elements(p_items) with ordinality as t(line, ord)\n' ||
    E'        left join (\n' ||
    E'          select item_id, quantity, rate, discount_percent,\n' ||
    E'                 row_number() over (order by line_order) as ord\n' ||
    E'            from public.voucher_items where voucher_id = p_voucher_id\n' ||
    E'        ) vi on vi.ord = t.ord;\n' ||
    E'    end if;\n' ||
    E'\n' ||
    E'    if v_lines_differ then\n' ||
    E'      v_changed := v_changed || ''the item lines''::text;\n' ||
    E'    end if;\n' ||
    E'\n' ||
    E'    if cardinality(v_changed) > 0 then\n' ||
    E'      if v_ack is not null and v_ack + interval ''24 hours'' > now() then\n' ||
    E'        v_remedy :=\n' ||
    E'          ''The IRP still allows this IRN to be CANCELLED until ''\n' ||
    E'          || to_char((v_ack at time zone ''Asia/Kolkata'') + interval ''24 hours'', ''DD Mon YYYY HH24:MI'')\n' ||
    E'          || '' IST (24 hours from the acknowledgement). Cancel it there -- cancel any e-way bill against it first, or the IRP will refuse -- then raise a corrected invoice under a fresh number. ''\n' ||
    E'          || ''Once that window closes the only routes are a credit note or debit note under Sec 34 CGST Act, itself reported to the IRP, or an amendment in the amendment table of a later GSTR-1 under Sec 37(3).'';\n' ||
    E'      else\n' ||
    E'        v_remedy :=\n' ||
    E'          ''The 24-hour window in which the IRP would have cancelled this IRN closed on ''\n' ||
    E'          || to_char((coalesce(v_ack, now()) at time zone ''Asia/Kolkata'') + interval ''24 hours'', ''DD Mon YYYY HH24:MI'')\n' ||
    E'          || '' IST, so the IRN can no longer be cancelled or amended anywhere. Correct it with a credit note or debit note under Sec 34 CGST Act, reported to the IRP in its own right, or amend it in the amendment table of a later GSTR-1 under Sec 37(3).'';\n' ||
    E'      end if;\n' ||
    E'\n' ||
    E'      raise exception\n' ||
    E'        ''Invoice % has been reported to the Invoice Registration Portal (IRN %..., acknowledged %). You changed %, and a reported e-invoice cannot be amended -- the signed QR code printed on it attests the buyer, the date and the value that were reported, so saving this would leave the document contradicting its own IRN and the buyer''''s GSTR-2B. %  Narration, reference, challan and godown can still be corrected here.'',\n' ||
    E'        v_number,\n' ||
    E'        left(v_irn, 12),\n' ||
    E'        coalesce(to_char(v_ack at time zone ''Asia/Kolkata'', ''DD Mon YYYY HH24:MI'') || '' IST'', ''date not recorded''),\n' ||
    E'        array_to_string(v_changed, '', ''),\n' ||
    E'        v_remedy;\n' ||
    E'    end if;\n' ||
    E'  end if;\n' ||
    E'\n' ||
    v_anchor_body
  );

  execute v_def;
end;
$mig$;

-- Rule 2: a create-or-replace of an existing function keeps its ACL, but
-- restating is the house rule precisely so nobody has to know that.
revoke all on function public.update_invoice(uuid, date, uuid, uuid, uuid, jsonb, text, text, date, char, text, date) from public, anon;
grant execute on function public.update_invoice(uuid, date, uuid, uuid, uuid, jsonb, text, text, date, char, text, date) to authenticated;

comment on function public.update_invoice(uuid, date, uuid, uuid, uuid, jsonb, text, text, date, char, text, date) is
  'Edit-time twin of create_invoice: full replace of voucher_items and voucher_entries for an existing invoice, same GST/RCM/TCS computation. voucher_type, branch_id and the voucher number are not editable. Once the voucher carries an IRN (einvoice_details.irn), the party, the invoice date, the place of supply and the item lines are frozen and the save is refused with the lawful remedy (1500); narration, reference, challan and godown stay editable.';
