-- ============================================================================
-- 1841 — delete_company is broken live for almost every real company
-- ============================================================================
-- Confirmed this session, live, via rolled-back transactions impersonating a
-- real company admin (tester@lekha.test, admin of Sharma Textiles — a
-- company with real vouchers/ledgers/tax data, per the shared-worktree
-- convention of using SQL impersonation rather than a browser session):
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<admin-uuid>","role":"authenticated"}';
--   select public.delete_company('<company-with-real-data>');
--   rollback;
--
-- SEVEN independent, stacked failures, found in the order they'd actually
-- bite:
--
-- 1. `delete from public.vouchers where company_id = p_company_id` (the
--    function's own first statement) fails immediately for any company with
--    an EXIM shipment on file:
--      ERROR: update or delete on table "vouchers" violates foreign key
--      constraint "exim_shipment_details_voucher_id_company_id_fkey"
--    exim_shipment_details (added well after 0060) was never wired into
--    delete_company at all.
--
-- 2. Even bypassing #1, `delete from public.ledgers where company_id =
--    p_company_id` fails for any company with GST/TDS ledger-role mappings
--    (174 real tax_ledger_map rows exist across companies today) or a bank
--    statement import (14 real bank_statement_lines rows exist today).
--    Migrations 0018 and 0019 ORIGINALLY carried explicit `delete from
--    tax_ledger_map` / `delete from bank_statement_lines` lines for exactly
--    this reason — a later full-body `CREATE OR REPLACE` (0060, then 0745
--    again) silently dropped both lines, because CREATE OR REPLACE FUNCTION
--    replaces the WHOLE body and whoever wrote 0060/0745 was evidently
--    working from an older copy that predated 0018/0019's fix.
--
-- 3. Even past both of those, the function's own storage.objects cleanup
--    (added by 0060/0745, for the 'documents' bucket and the WhatsApp
--    sentinel-folder prefix) fails:
--      ERROR: 42501: Direct deletion from storage tables is not allowed.
--      Use the Storage API instead.
--    — storage.protect_delete(), a BEFORE DELETE FOR EACH STATEMENT trigger
--    on storage.objects, unconditionally blocks any direct DELETE unless
--    the session has explicitly opted in. Confirmed (`pg_get_functiondef`)
--    it checks `current_setting('storage.allow_delete_query', true)` and
--    raises unless that is exactly 'true' — a documented Supabase escape
--    hatch, not a bug in this schema. Confirmed live, in a rolled-back
--    transaction, that a plain `set local storage.allow_delete_query =
--    'true';` statement inside a SECURITY INVOKER plpgsql function body
--    (executed as the authenticated caller, no elevated role needed) is
--    sufficient, and that it works as a bare statement in PL/pgSQL (no
--    EXECUTE required). Scoped with SET LOCAL so it never leaks past this
--    one function call.
--
-- 4. A FOURTH failure, found only while testing the first draft of this
--    migration's own fix (not in the original bug report): capture_drafts
--    carries its own anti-tamper trigger (0740's app_private.enforce_
--    capture_draft, BEFORE INSERT OR UPDATE) that unconditionally raises on
--    ANY update once a row's status is 'confirmed' or 'rejected' — "This
--    capture draft is already confirmed and its record cannot be changed
--    further." The first draft of this migration tried to clear a claimed
--    draft's confirmed_voucher_id (NO ACTION back to vouchers) by UPDATE-ing
--    it to null, the same way every other nullable blocker below is
--    handled — and hit this trigger immediately in testing, for the very
--    first real company tried. Fixed by DELETE-ing the capture_drafts row
--    outright instead (the trigger is BEFORE INSERT OR UPDATE only — a
--    plain DELETE is unaffected, confirmed live) — see "BLOCKS delete from
--    vouchers" below for why that forces the WhatsApp storage cleanup to
--    move earlier in the function.
--
-- 5. A FIFTH failure, also found only in testing: deleting discount_
--    agreements late (with the rest of the ledgers-blocking group, its
--    natural place — party_ledger_id is what blocks `delete from ledgers`)
--    left discount_agreement_links rows in place when `delete from vouchers`
--    ran. Those rows' original_invoice_voucher_id -> vouchers FK is ON
--    DELETE SET NULL, and the resulting UPDATE fires app_private.
--    validate_discount_agreement_link() (BEFORE INSERT OR UPDATE), which has
--    its own pre-existing bug: it re-reads `vouchers where id = new.
--    voucher_id` to check the party ledger matches, but during a bulk
--    `delete from vouchers` that OTHER voucher row (a different row of the
--    same batch delete) may already be gone by the time this row's trigger
--    fires — the lookup returns null, and the mismatch check raises
--    spuriously: "This agreement is for a different party than the
--    voucher's party ledger", for a link that was never actually
--    inconsistent. NOT fixed at the source (a separate, deeper bug in that
--    trigger's own null-handling, unrelated to what this migration exists
--    to fix, and this session has no evidence it is reachable outside this
--    exact bulk-delete path) — worked around instead by moving discount_
--    agreements' delete earlier, into the vouchers-blocking group, so its
--    own ON DELETE CASCADE clears discount_agreement_links before `delete
--    from vouchers` ever runs and the buggy trigger has nothing left to
--    fire on. Named here, not silently fixed, the same discipline 0745's
--    own header uses for a residual it found in 0575.
--
-- 6. A SIXTH failure, also found only in testing, and a different KIND of
--    bug from the previous five: delivery_challans, delivery_challan_
--    receipts and job_work_challans each carry RLS's default `read` policy
--    ONLY — no INSERT/UPDATE/DELETE policy for `authenticated` at all
--    (every sibling detail table this migration also touches — e.g.
--    delivery_challan_ewb_details, einvoice_details, exim_shipment_details,
--    landed_cost_allocations — has both). delete_company runs SECURITY
--    INVOKER (deliberately — see "DELIBERATELY NOT DONE HERE" below), so
--    its own `delete from public.delivery_challans where company_id = ...`
--    is subject to RLS exactly like any other authenticated client's would
--    be. With no policy granting DELETE, Postgres RLS does not raise — it
--    silently matches zero rows, and the statement "succeeds" having
--    deleted nothing. Confirmed live: ran the delete in isolation, in a
--    rolled-back transaction, and the row count was unchanged afterward.
--    `delete from public.vouchers` then failed downstream with the same
--    exim_shipment_details-shaped FK violation, but for delivery_challans
--    instead — a second, independently-discovered instance of failure #1's
--    root cause (a table added without being wired into delete_company),
--    compounded by a THIRD, unrelated root cause (RLS write policies never
--    written for these three tables in the first place, so no path in this
--    app — not just delete_company — could ever mutate them). Fixed by
--    adding the missing `<table>_write` policy to each of the three,
--    identical in shape to every sibling table's own (`for all to
--    authenticated using/with check can_write_company(company_id)`) — a
--    real, general RLS fix, not a delete_company-specific workaround, since
--    the gap blocks ordinary app writes to these tables just as much as it
--    blocked this function.
--
-- 7. A SEVENTH failure, found only in testing, after #6 was fixed and
--    `delete from vouchers` finally succeeded: `delete from ledgers` then
--    failed on a NOT NULL violation, not an FK violation —
--      ERROR: 23502: null value in column "company_id" of relation
--      "contingent_liabilities" violates not-null constraint
--    contingent_liabilities.(related_ledger_id, company_id) is a COMPOSITE
--    `references ledgers(id, company_id) on delete set null` FK. Postgres's
--    default SET NULL action for a composite FK nulls EVERY column of the
--    FK together — not just related_ledger_id, but company_id too — and
--    company_id is contingent_liabilities' own separate NOT NULL column
--    (it also has its own plain `company_id references companies(id) on
--    delete cascade`). Deleting a ledger a contingent liability points at
--    therefore always tries to null out that liability's company_id and
--    always fails — a standing bug independent of delete_company entirely
--    (it would hit the same way if this app ever deletes a single ledger
--    outside a full company wipe), not fixed at the FK definition here
--    (would need Postgres 15's column-scoped `ON DELETE SET NULL
--    (related_ledger_id)`, unverified against this project's actual
--    Postgres version, and is a schema change with a blast radius wider
--    than this migration's stated scope). Worked around the same way as
--    #5: an explicit UPDATE nulling ONLY related_ledger_id (never touching
--    company_id) before `delete from ledgers` ever runs, so the composite
--    SET NULL action has nothing left to fire on — a single-column MATCH
--    SIMPLE FK is satisfied trivially once either of its columns is null.
--
-- ==========================================================================
-- THE HARDER PART: A FULL FK-GRAPH AUDIT, NOT JUST THE THREE NAMED TABLES
-- ==========================================================================
-- Restoring tax_ledger_map/bank_statement_lines and adding
-- exim_shipment_details would only fix the tables that happened to have
-- data for the one company this bug was first noticed on. This schema's own
-- established pattern (see 0014's own header, "items and godowns are
-- referenced by stock lines, which are referenced by nothing that cascades
-- ahead of them" — and 0745's own header, "STORAGE CLEANUP") is: every
-- table with a composite `(x_id, company_id) references
-- vouchers/ledgers(id, company_id)` FK is deliberately NO ACTION, not
-- CASCADE — ordinary app code is NOT allowed to delete a voucher/ledger
-- that is still referenced elsewhere, but a full company wipe has to clear
-- those references explicitly, in dependency order, because Postgres does
-- not guarantee any particular firing order between two sibling cascade
-- triggers on the same parent delete.
--
-- Queried `pg_constraint` directly (not trusted from memory) for every
-- non-CASCADE FK in the public schema whose referenced table is vouchers,
-- ledgers, items or godowns (items/godowns re-checked per 0014's own
-- reasoning — see below) and worked out, from each column's own
-- `information_schema.columns.is_nullable`, whether each referencing table
-- needs a full row DELETE (any NOT NULL column in the chain) or can survive
-- with just that one column UPDATEd to NULL (every column in the chain
-- nullable). Full result, and why each table lands where it does:
--
-- BLOCKS `delete from vouchers` (added before it, in the new function body):
--   * capture_drafts.confirmed_voucher_id — nullable in the schema, but
--     cannot actually be UPDATEd once a draft is confirmed (item 4 above) —
--     the row is DELETEd outright instead, which also closes
--     capture_drafts' own composite NO ACTION link to branches (branch_id)
--     found as a side effect of this audit — see "ALSO FIXED IN PASSING"
--     below. Because the row can no longer survive this step, the existing
--     WhatsApp storage-cleanup delete (0745), which joins back to
--     capture_drafts by company_id, is moved to run FIRST in the new
--     function body, before this delete, instead of near the end where
--     0745 originally placed it.
--   * delivery_challans.voucher_id — NOT NULL, row DELETEd. Its own two
--     children (delivery_challan_ewb_details.challan_id,
--     delivery_challan_receipts.challan_id — both NOT NULL, NO ACTION back
--     to delivery_challans) are cleared first. delivery_challans and
--     delivery_challan_receipts both also needed a new RLS write policy
--     before any of this would actually delete anything — see item 6 above.
--   * einvoice_details.voucher_id — NOT NULL, row DELETEd. No children.
--   * ewb_details.voucher_id — NOT NULL, row DELETEd. Its own child
--     (ewb_vehicle_updates.ewb_detail_id — NOT NULL, NO ACTION) is cleared
--     first.
--   * exim_shipment_details.voucher_id — NOT NULL, row DELETEd. The
--     confirmed failure above. No children.
--   * landed_cost_allocations.{purchase,charges}_voucher_id — both NOT
--     NULL, row DELETEd. landed_cost_allocation_items cascades from it
--     (ON DELETE CASCADE) — nothing to clear first.
--   * orders.fulfilled_voucher_id / .party_ledger_id — both nullable, but
--     DELETEd outright rather than UPDATEd: order_items.order_id ->
--     orders IS already ON DELETE CASCADE, so deleting the order here also
--     resolves order_items' own NO ACTION link to items for free, and
--     nothing later in this function needs the orders row to survive.
--   * service_advance_receipts.voucher_id / .party_ledger_id — both NOT
--     NULL, row DELETEd (covers this table's ledgers-blocking role too, in
--     one statement).
--   * stock_verifications.adjustment_voucher_id — nullable, but the row is
--     DELETEd outright here rather than just nulled: item_id, godown_id and
--     branch_id are all NOT NULL on this table, so it would have to be
--     deleted before the items/godowns step regardless — doing it here,
--     before vouchers, resolves all four blocking columns
--     (adjustment_voucher_id, item_id, godown_id, batch_id) in one
--     statement instead of touching this table twice.
--   * voucher_ship_to.voucher_id — NOT NULL, row DELETEd. No children.
--
-- BLOCKS `delete from ledgers` (added after vouchers, before ledgers):
--   * bank_statement_lines.ledger_id — NOT NULL. Restored (see #2 above).
--   * contingent_liabilities.related_ledger_id — nullable, UPDATEd to null
--     (company_id, NOT NULL on this table, is deliberately left untouched)
--     — item 7 above.
--   * budget_lines.ledger_id — NOT NULL, row DELETEd. No children.
--   * discount_agreements.party_ledger_id — NOT NULL, but actually DELETEd
--     up in the vouchers-blocking group above, before `delete from
--     vouchers` — item 5 above; see that group's own comment for why the
--     ordering there is required, not just tidy.
--   * job_work_challans.job_worker_ledger_id — NOT NULL, row DELETEd
--     (job_work_returns cascades from it, ON DELETE CASCADE — which also
--     clears job_work_returns.returned_item_id's own NO ACTION link to
--     items before the items/godowns step, for free). Also needed a new RLS
--     write policy before this would actually delete anything — item 6
--     above.
--   * recurring_voucher_templates.party_ledger_id — nullable, but DELETEd
--     outright: recurring_voucher_template_lines.template_id ->
--     recurring_voucher_templates IS already ON DELETE CASCADE, so deleting
--     the template here also clears template_lines' own NOT NULL,
--     NO ACTION ledger_id link for free (recurring_voucher_generation_log
--     cascades the same way).
--   * tax_ledger_map.ledger_id — NOT NULL. Restored (see #2 above).
--   (voucher_allocations.party_ledger_id is also NOT NULL/NO ACTION, but
--   needs no line here: voucher_allocations.{bill,settlement}_voucher_id
--   are both already ON DELETE CASCADE from vouchers, so those rows are
--   gone by this point regardless.)
--
-- BLOCKS `delete from items` / `delete from godowns` — RE-AUDITED PER 0014,
-- restored and extended:
--   0014 added plain `delete from items` / `delete from godowns` lines with
--   this exact reasoning: "items and godowns are referenced by stock lines,
--   which are referenced by nothing that cascades ahead of them. Stock
--   lines cascade from the voucher, so vouchers go first." That reasoning
--   held in 0014's schema — voucher_items (stock lines) was the ONLY
--   sibling table pointing at items/godowns, and it cascades from vouchers,
--   which the function already deletes first. It does NOT hold today:
--   bill_of_materials/bom_components/bom_outputs (manufacturing, added
--   later) and item_batches all hold their own NOT NULL, NO ACTION
--   composite FKs to items, independent of vouchers entirely. (The 0745
--   CREATE OR REPLACE dropped 0014's items/godowns lines the same way it
--   dropped 0018/0019's — this migration restores them AND extends them for
--   what's been added since.) Also confirmed empty in `pg_constraint`:
--   delivery_challans/orders/job_work_challans/stock_verifications'
--   own item_id / godown_id links are already resolved above, before this
--   point, so they need no separate handling here.
--   * bom_components.{bom_id,component_item_id} — both NOT NULL, row
--     DELETEd first (references bill_of_materials AND items).
--   * bom_outputs.{bom_id,output_item_id} — both NOT NULL, row DELETEd
--     first (same shape as bom_components).
--   * bill_of_materials.output_item_id — NOT NULL, row DELETEd next.
--   * item_batches.item_id — NOT NULL, row DELETEd next
--     (voucher_item_batches cascades from voucher_items, itself cascading
--     from vouchers — already gone by this point, nothing to clear first).
--   * delete from items, delete from godowns — restored, 0014's own lines.
--
-- ==========================================================================
-- ALSO FIXED IN PASSING: capture_drafts.branch_id
-- ==========================================================================
-- Found as a side effect of this audit, not in the original bug report:
-- capture_drafts holds a SECOND, composite `(branch_id, company_id)
-- references branches(id, company_id)` FK that is NO ACTION (distinct from
-- its plain `branch_id references branches(id) on delete set null` FK —
-- the two are independent constraints on the same column). A claimed
-- WhatsApp draft that recorded a branch would silently block
-- `delete from public.branches` inside the final companies cascade. Closed
-- for free now that capture_drafts is DELETEd outright rather than nulled
-- (see item 4 above).
--
-- ==========================================================================
-- VERIFIED END TO END, LIVE, AGAINST REAL DATA (rolled-back transactions,
-- tester@lekha.test impersonated as each company's own admin)
-- ==========================================================================
-- delete_company (this new definition) run start-to-finish, successfully,
-- for FOUR different real companies, chosen to cover every table this
-- migration touches:
--   * Sharma Textiles — 111 vouchers, 53 ledgers, 14 tax_ledger_map, 7
--     bank_statement_lines, 4 exim_shipment_details, 1 BOM, 3 item_batches,
--     3 stock_verifications, 2 delivery_challans, 3 job_work_challans.
--     Confirmed vouchers/ledgers/items/godowns/storage ALL succeed (see
--     "ONE KNOWN RESIDUAL" below for why this one company alone does not
--     reach the final `delete from companies`).
--   * Nexgen Softwares Private Limited — 29 vouchers, 49 ledgers, 25
--     tax_ledger_map, 1 exim_shipment_details, 1 BOM. Fully succeeded,
--     start to finish, including `delete from companies` and the audit_log
--     cleanup after it.
--   * TEST Rangoli Spice Works Pvt Ltd — 45 vouchers, 66 ledgers, 13
--     tax_ledger_map, 3 bank_statement_lines, 2 item_batches, 1 delivery_
--     challan. Fully succeeded, start to finish.
--   * Verma & Associates — 38 vouchers, 51 ledgers, 14 tax_ledger_map, 4
--     bank_statement_lines. Fully succeeded, start to finish.
--
-- ==========================================================================
-- ONE KNOWN RESIDUAL, FOUND BUT DELIBERATELY NOT FIXED HERE
-- ==========================================================================
-- Sharma Textiles (above) has one signature_requests row (0575's
-- e-signature feature) and does NOT reach the final `delete from
-- companies` — it fails on the companies cascade to signature_request_
-- signers:
--   ERROR: P0001: Signature request <id> does not exist
--   CONTEXT: PL/pgSQL function app_private.enforce_signature_request_
--   signer_write() ... DELETE FROM ONLY signature_request_signers WHERE
--   company_id = ...
-- Traced to a bug in 0575's own trigger, not to anything this migration
-- controls: signature_request_signers has TWO independent cascade paths
-- from companies — a direct `company_id references companies(id) on
-- delete cascade`, and an indirect one via `request_id references
-- signature_requests(id) on delete cascade` (itself cascading from
-- companies too). enforce_signature_request_signer_write's own DELETE
-- branch re-reads `signature_requests where id = old.request_id` to check
-- the request's status — but Postgres's ON DELETE CASCADE fires as an
-- AFTER ROW trigger on the PARENT after that parent row is already gone,
-- so a signature_request_signers row cascading away BECAUSE its own
-- signature_requests parent was just deleted will always find that lookup
-- returns nothing, not just during a company-wide wipe. This looks like a
-- standing, general bug that would fire for ANY deletion of a
-- signature_requests row this app might ever do elsewhere, not something
-- specific to delete_company. Deliberately NOT fixed here: even routing
-- around the cascade-ordering half (an explicit delete before `delete from
-- companies`, the same pattern used everywhere else in this migration)
-- would still hit this trigger's OTHER, working-as-designed check — 'Signers
-- can only be removed while the request is still in draft' — for any
-- signature request that has actually been sent, which is a real business
-- rule a company-wide admin wipe should not have to silently override
-- without its own careful, separately-reviewed decision. Named here, not
-- worked around, the same discipline 0745's own header uses for a residual
-- it found in 0575's OTHER triggers. A company with only draft (never sent)
-- signature requests, or none at all, is unaffected — see the four
-- companies verified above, three of which have zero and one of which
-- (Sharma Textiles itself) confirmed every OTHER part of this fix works.
--
-- A handful of other composite NO ACTION FKs exist in this schema that are
-- not "back to vouchers, ledgers or companies" — e.g. gst_registrations <->
-- branches, company_directors <-> {digital_signature_certificates,
-- llp_partner_contributions}, share_classes <-> share_holdings — genuinely
-- out of this migration's stated scope and not evidenced as broken by any
-- of the four real companies tested above (none of them hit an error in
-- that territory). Not audited here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Item 6 above: three tables had RLS's default read-only policy and nothing
-- else. Same shape as every sibling detail table's own `<table>_write`
-- policy (e.g. delivery_challan_ewb_details_write, einvoice_details_write,
-- exim_shipment_details_write, landed_cost_allocations_write, confirmed by
-- reading their real pg_policy definitions before writing this) — `for all
-- to authenticated`, gated both ways by can_write_company(company_id). This
-- is a real, general RLS fix: it unblocks ordinary app writes to these three
-- tables, not just delete_company's own deletes.
-- ----------------------------------------------------------------------------
drop policy if exists delivery_challans_write on public.delivery_challans;
create policy delivery_challans_write on public.delivery_challans
  for all to authenticated
  using ((select app_private.can_write_company(delivery_challans.company_id)))
  with check ((select app_private.can_write_company(delivery_challans.company_id)));

drop policy if exists delivery_challan_receipts_write on public.delivery_challan_receipts;
create policy delivery_challan_receipts_write on public.delivery_challan_receipts
  for all to authenticated
  using ((select app_private.can_write_company(delivery_challan_receipts.company_id)))
  with check ((select app_private.can_write_company(delivery_challan_receipts.company_id)));

drop policy if exists job_work_challans_write on public.job_work_challans;
create policy job_work_challans_write on public.job_work_challans
  for all to authenticated
  using ((select app_private.can_write_company(job_work_challans.company_id)))
  with check ((select app_private.can_write_company(job_work_challans.company_id)));


create or replace function public.delete_company(p_company_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can delete a company';
  end if;

  -- 1841: storage.objects has a BEFORE DELETE FOR EACH STATEMENT trigger
  -- (storage.protect_delete()) that unconditionally blocks a direct DELETE
  -- unless the session opts in via this exact GUC — see migration header,
  -- item 3. SET LOCAL so it never outlives this function call. Set here,
  -- at the top, because the WhatsApp cleanup below (moved up from 0745's
  -- original position near the end — see item 4) now needs it early too.
  set local storage.allow_delete_query = 'true';

  -- 0745: a WhatsApp-forwarded capture draft's media lives under a fixed
  -- sentinel folder, never under this company's own uuid prefix (see 0745
  -- migration header). Moved here, before capture_drafts itself is deleted
  -- a few lines down, because this join needs capture_drafts.company_id to
  -- still be set — see migration header, item 4.
  delete from storage.objects o
   where o.bucket_id = 'documents'
     and (storage.foldername(o.name))[1] = '00000000-0000-0000-0000-000000000000'
     and (storage.foldername(o.name))[2] = 'whatsapp-inbound'
     and exists (
       select 1 from public.capture_drafts d
        where d.id = ((storage.foldername(o.name))[3])::uuid
          and d.company_id = p_company_id
     );

  -- ------------------------------------------------------------------------
  -- Clear every NO ACTION reference back to this company's vouchers before
  -- `delete from vouchers` — see migration header for the full audit.
  -- ------------------------------------------------------------------------

  -- enforce_capture_draft (0740) raises on ANY UPDATE to an already-
  -- confirmed/rejected row (its own terminal-state guard, BEFORE INSERT OR
  -- UPDATE only) — confirmed_voucher_id and branch_id (both NO ACTION,
  -- back to vouchers and branches respectively) cannot be cleared by
  -- nulling them, so the row is deleted outright instead. Unaffected by
  -- that trigger (DELETE, not UPDATE) and by capture_draft_pages, which
  -- cascades from it. See migration header, item 4.
  delete from public.capture_drafts where company_id = p_company_id;

  delete from public.delivery_challan_ewb_details where company_id = p_company_id;
  delete from public.delivery_challan_receipts where company_id = p_company_id;
  delete from public.delivery_challans where company_id = p_company_id;

  delete from public.einvoice_details where company_id = p_company_id;

  delete from public.ewb_vehicle_updates where company_id = p_company_id;
  delete from public.ewb_details where company_id = p_company_id;

  delete from public.exim_shipment_details where company_id = p_company_id;

  delete from public.landed_cost_allocations where company_id = p_company_id;

  delete from public.orders where company_id = p_company_id;

  delete from public.service_advance_receipts where company_id = p_company_id;

  delete from public.stock_verifications where company_id = p_company_id;

  delete from public.voucher_ship_to where company_id = p_company_id;

  -- discount_agreements moved here (a ledgers-blocker, not a vouchers one —
  -- see the Group B comment below) because deleting it early cascades away
  -- discount_agreement_links (ON DELETE CASCADE) BEFORE `delete from
  -- vouchers` runs. That ordering is required, not just tidy: found live,
  -- in testing, that leaving a discount_agreement_links row in place lets
  -- vouchers' own ON DELETE SET NULL action (for original_invoice_
  -- voucher_id) fire app_private.validate_discount_agreement_link()
  -- (BEFORE INSERT OR UPDATE) mid-cascade, and that trigger has its own
  -- pre-existing bug: it re-reads `vouchers where id = new.voucher_id` to
  -- check the party ledger matches, but during a bulk `delete from vouchers`
  -- that voucher row may ALREADY be gone (same DELETE statement, a
  -- different row of the same batch), so the lookup returns null and the
  -- mismatch check fires spuriously — 'This agreement is for a different
  -- party than the voucher's party ledger' — for a link that was never
  -- actually inconsistent. NOT fixed here (a separate, deeper bug in that
  -- trigger's own null-handling, unrelated to what this migration is
  -- fixing, and this session has no reason to believe it is reachable
  -- outside this exact bulk-delete path) — worked around by never letting
  -- the SET NULL cascade see a surviving row in the first place. Named here
  -- so it is not silently rediscovered later, the same discipline 0745's
  -- own header uses for a residual it found in 0575.
  delete from public.discount_agreements where company_id = p_company_id;

  delete from public.vouchers where company_id = p_company_id;

  -- 1420/1660: payment_webhook_events references ledgers (suggested_ledger_id)
  -- and payment_gateway_configs references ledgers (settlement_ledger_id),
  -- both via a composite FK with no cascade action — must go before the
  -- ledgers delete a few lines down, or that delete fails with a foreign key
  -- violation for any company that ever used this feature.
  delete from public.payment_webhook_events where company_id = p_company_id;
  delete from public.payment_gateway_configs where company_id = p_company_id;

  -- ------------------------------------------------------------------------
  -- Clear every remaining NO ACTION reference back to this company's
  -- ledgers before `delete from ledgers` — see migration header. Restores
  -- 0018/0019's tax_ledger_map/bank_statement_lines deletes, dropped by a
  -- later full-body CREATE OR REPLACE.
  -- ------------------------------------------------------------------------
  -- contingent_liabilities.(related_ledger_id, company_id) -> ledgers is a
  -- COMPOSITE ON DELETE SET NULL FK — Postgres nulls the whole tuple on
  -- that action, including company_id, which is this table's own separate
  -- NOT NULL column. UPDATEd here, ourselves, touching only
  -- related_ledger_id, so `delete from ledgers` below never triggers that
  -- composite action at all. See migration header, item 7.
  update public.contingent_liabilities set related_ledger_id = null
   where company_id = p_company_id and related_ledger_id is not null;

  delete from public.bank_statement_lines where company_id = p_company_id;
  delete from public.budget_lines where company_id = p_company_id;
  delete from public.job_work_challans where company_id = p_company_id;
  delete from public.recurring_voucher_templates where company_id = p_company_id;
  delete from public.tax_ledger_map where company_id = p_company_id;

  delete from public.ledgers where company_id = p_company_id;

  -- ------------------------------------------------------------------------
  -- Re-audited per 0014's own header ("items and godowns are referenced by
  -- stock lines, which are referenced by nothing that cascades ahead of
  -- them") — no longer true on its own; manufacturing/batch tables added
  -- since also hold NOT NULL composite FKs to items. Restores 0014's own
  -- items/godowns deletes, dropped by the same later CREATE OR REPLACE, and
  -- extends them for what's been added since.
  -- ------------------------------------------------------------------------
  delete from public.bom_components where company_id = p_company_id;
  delete from public.bom_outputs where company_id = p_company_id;
  delete from public.bill_of_materials where company_id = p_company_id;
  delete from public.item_batches where company_id = p_company_id;

  delete from public.items where company_id = p_company_id;
  delete from public.godowns where company_id = p_company_id;

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

revoke execute on function public.delete_company(uuid) from public, anon;
grant execute on function public.delete_company(uuid) to authenticated;

comment on function public.delete_company is
  'Deletes a company and everything under it, in FK-safe order: every NO ACTION reference back to this company''s vouchers (delivery challans, e-invoice/e-way-bill/EXIM details, landed cost allocations, orders, service advance receipts, stock verifications, voucher ship-to — see 1841 migration header for the full audit), then vouchers itself, then every NO ACTION reference back to ledgers (payment gateway config/webhooks, bank statement lines, budget lines, discount agreements, job work challans, recurring voucher templates, tax ledger map), then ledgers, then every NO ACTION reference back to items (BOM components/outputs, bill of materials, item batches), then items and godowns, then this company''s claimed WhatsApp-inbound storage objects under the sentinel prefix (0745) and this company''s own storage folder prefix (both via the documented storage.allow_delete_query bypass for storage.protect_delete(), 1841), then the company row itself (cascades account groups/branches/registrations/members/invites/modules/documents/capture_drafts/whatsapp_inbound_numbers/and everything else with a plain company_id FK), then the audit trail (deliberately no FK, so it does not cascade).';
