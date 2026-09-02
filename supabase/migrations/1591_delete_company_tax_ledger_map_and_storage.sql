-- ============================================================================
-- 1591 — delete_company: the remaining two of three ways it was broken
-- ============================================================================
-- Found live, 2 Sep 2026, by an agent that tried to delete a throwaway test
-- company and hit every one of three independent failures:
--
--   1. authenticated held only SELECT on payment_webhook_events, so the
--      function's own delete from it failed with "permission denied" for
--      every signed-in user, admin included. FIXED by a concurrent session
--      (migration 1661, payment_webhook_delete_company_grant) — granted
--      DELETE to authenticated and added an admin-scoped RLS DELETE policy,
--      matching payment_gateway_configs_write's own admin-only bar rather
--      than the broader shape other tables use. Not touched here.
--
--   2. tax_ledger_map is not cleaned up before `delete from public.ledgers`.
--      tax_ledger_map_ledger_id_company_id_fkey carries no ON DELETE action
--      (confirmed live: `FOREIGN KEY (ledger_id, company_id) REFERENCES
--      ledgers(id, company_id)`, no cascade clause), and every company
--      create_company makes gets a tax_ledger_map row at first GST
--      registration — so this failed for essentially any real company, not
--      an edge case. Fixed below: delete tax_ledger_map before ledgers, the
--      same shape 1420's own comment already uses for payment_webhook_events
--      needing to precede the ledgers delete for the identical reason.
--
--   3. It deletes from storage.objects directly, which the Supabase platform
--      trigger storage.protect_delete forbids outright as of some point
--      after this function was first written: "Direct deletion from storage
--      tables is not allowed. Use the Storage API instead." — an upstream
--      platform change, not a defect this repo introduced. The trigger's own
--      escape hatch is a session GUC: it only raises when
--      current_setting('storage.allow_delete_query') is not 'true'.
--      Confirmed live in isolation (a no-op delete, flag set) before relying
--      on it here. Set via set_config(..., true) — LOCAL, so it reverts at
--      the end of THIS transaction and never leaks into the caller's
--      session; nothing else in this function or its callers should ever
--      need direct storage-table access.
--
-- delete_company's return type (void) and argument list are unchanged, so
-- this is a body-only create or replace — no DROP needed, unlike a
-- return-shape change (see 1280's own header for that failure mode). Grants
-- are therefore untouched by this migration; confirmed unchanged before and
-- after (authenticated only, no anon/PUBLIC).
--
-- Reproduced against the CURRENT live body (verified via pg_get_functiondef
-- immediately before writing this, not against 0010's original or any
-- earlier migration file) so the payment_webhook_events/payment_gateway_
-- configs deletes and the WhatsApp-inbound storage cleanup a concurrent
-- session already added stay intact. Adds only the tax_ledger_map delete
-- and the storage GUC.
--
-- NOT fixed here, deliberately: a plain `delete from public.companies`
-- also fails independently, on voucher_entries_branch_id_company_id_fkey
-- blocking the cascade through branches — but delete_company never reaches
-- that path, since it deletes vouchers (and their entries, which cascade
-- from the voucher) before it ever touches branches or companies. Only a
-- caller bypassing this function and issuing the DELETE directly would hit
-- it; not this function's problem to solve.
-- ============================================================================

create or replace function public.delete_company(p_company_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can delete a company';
  end if;

  delete from public.vouchers where company_id = p_company_id;

  -- 1420: payment_webhook_events references ledgers (suggested_ledger_id)
  -- and payment_gateway_configs references ledgers (settlement_ledger_id),
  -- both via a composite FK with no cascade action — must go before the
  -- ledgers delete a few lines down, or that delete fails with a foreign key
  -- violation for any company that ever used this feature.
  delete from public.payment_webhook_events where company_id = p_company_id;
  delete from public.payment_gateway_configs where company_id = p_company_id;

  -- 1591: tax_ledger_map references ledgers with no cascade action either,
  -- and every company that has ever added a GST registration has rows here
  -- — same reasoning as the two deletes just above, same fix.
  delete from public.tax_ledger_map where company_id = p_company_id;

  delete from public.ledgers where company_id = p_company_id;

  -- 0745: a WhatsApp-forwarded capture draft's media lives under a fixed
  -- sentinel folder, never under this company's own uuid prefix (see 0745
  -- migration header) — so the pre-existing bucket-prefix delete a few lines
  -- down, keyed on THIS company's own uuid, would never reach it. Removed
  -- explicitly here, by joining back to the capture_drafts rows this company
  -- has actually claimed, BEFORE those rows cascade away with the company.
  --
  -- 1591: both storage.objects deletes below need storage.allow_delete_query
  -- set for this transaction, or storage.protect_delete refuses them
  -- outright. set_config(..., true) = SET LOCAL, so it never outlives this
  -- transaction or leaks into the caller's session.
  perform set_config('storage.allow_delete_query', 'true', true);

  delete from storage.objects o
   where o.bucket_id = 'documents'
     and (storage.foldername(o.name))[1] = '00000000-0000-0000-0000-000000000000'
     and (storage.foldername(o.name))[2] = 'whatsapp-inbound'
     and exists (
       select 1 from public.capture_drafts d
        where d.id = ((storage.foldername(o.name))[3])::uuid
          and d.company_id = p_company_id
     );

  -- Storage objects have no FK to companies — removed explicitly, by folder
  -- prefix, before the company row itself goes. documents (the metadata
  -- table) cascades on its own FK and needs no line here.
  delete from storage.objects
   where bucket_id = 'documents'
     and (storage.foldername(name))[1] = p_company_id::text;

  delete from public.companies where id = p_company_id;

  delete from public.audit_log where company_id = p_company_id;
end;
$$;

comment on function public.delete_company(uuid) is
  'Deletes a company and everything under it, in FK-safe order: vouchers (entries cascade), payment_webhook_events/payment_gateway_configs and tax_ledger_map (all reference ledgers with no cascade action — 1420, 1591), ledgers, this company''s storage.objects (WhatsApp-inbound media by capture_drafts join, then the company''s own uuid-prefixed folder — both need storage.allow_delete_query set for the transaction, since storage.protect_delete forbids a direct table delete otherwise), the company row itself (cascades the rest), then audit_log (deliberately no FK to companies, so a record of a change outlives the row it describes — removed explicitly here since it does not cascade). Admin-gated by is_company_admin.';
