-- ============================================================================
-- 0010 — Deleting a company
-- ============================================================================
-- A company could not be deleted at all, even after 0006b fixed the three
-- guards that were blocking their own cascade. The remaining obstacle is
-- ordering: voucher_entries references branches and ledgers with no ON DELETE
-- action, so during the cascade Postgres reached branches while entries still
-- pointed at them, and RESTRICT refused.
--
-- The fix is deliberately NOT to make those foreign keys cascade. Deleting a
-- ledger that has postings must stay refused — silently destroying history to
-- satisfy a delete is the wrong trade, and RESTRICT is doing its job there.
-- What was missing is an ordered teardown for the one case where removing
-- everything is legitimate.
--
-- Found by actually deleting something. Nothing in the schema or the type
-- checker would have surfaced it.
-- ============================================================================

create or replace function public.delete_company(p_company_id uuid)
returns void
language plpgsql
security invoker   -- RLS decides; only an admin may delete a company
set search_path = ''
as $$
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can delete a company';
  end if;

  -- Vouchers first. Their entries hold the branch and ledger references that
  -- would otherwise block the deletes below; entries cascade from the voucher.
  delete from public.vouchers where company_id = p_company_id;
  delete from public.ledgers where company_id = p_company_id;

  -- Everything else cascades from the company row: account groups, branches,
  -- registrations, members, invites, modules, tax ledger map.
  delete from public.companies where id = p_company_id;

  -- The audit trail deliberately has no foreign key to companies, so a record
  -- of a change outlives the row it describes. That means it does not cascade
  -- either, and rows left behind are unreadable by anyone yet still hold a
  -- former tenant's before/after snapshots. Remove them explicitly.
  delete from public.audit_log where company_id = p_company_id;
end;
$$;

revoke execute on function public.delete_company(uuid) from public, anon;
grant execute on function public.delete_company(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Note on 0011
-- ----------------------------------------------------------------------------
-- create_voucher and update_voucher took narration and the reference fields as
-- required positional arguments ahead of p_lines, so they could not be given
-- defaults and a client without a reference number could not call them at all.
-- Corrected in 0011.
