-- ============================================================================
-- 1320 — update_branch: the missing entry point for a branch's own address
-- ============================================================================
-- build_einvoice_json (0230) refuses outright when the raising branch has no
-- address on file (address_line1, city, pincode — nullable on public.branches
-- since 0005) and says so: 'add it under Branches before generating the
-- e-invoice payload'. build_ewb_json (1310) hits the identical gap and now
-- warns instead of silently nulling the from-address fields. Both messages
-- promise a screen that has never existed — confirmed exhaustively (wave 7,
-- 1 Sep 2026): no /branches route, nothing in Settings, Registrations or the
-- New Company dialog, and no insert_branch/update_branch RPC anywhere in this
-- migrations directory. Every company's auto-created head office (0005) has
-- sat with a null address since the day it was seeded, which means
-- e-invoicing has never been reachable for anyone.
--
-- SCOPE. public.branches' full column list, surveyed before writing this:
--   id, company_id                 — identity, never user-editable
--   code, name                     — set at branch creation; code feeds
--                                     voucher numbering (0725, 1160) and
--                                     renaming it after vouchers exist would
--                                     make printed prefixes lie. No creation
--                                     path exists yet either (still just the
--                                     one seeded head office per company) —
--                                     a real insert_branch RPC is its own
--                                     slice, out of scope here.
--   state_code, gst_registration_id — load-bearing for the composite FK
--                                     (gst_registration_id, company_id,
--                                     state_code) 0005 defines; changing
--                                     either outside add_gst_registration's
--                                     own validated path risks a branch
--                                     claiming a registration in the wrong
--                                     state. Its own screen (/registrations,
--                                     RegistrationManager.tsx) already
--                                     attaches a registration to a branch —
--                                     not touched here.
--   is_head_office, is_active      — structural flags with their own guard
--                                     trigger (guard_head_office, 0005);
--                                     changing them is a different, riskier
--                                     feature than "fill in an address".
--   address_line1, address_line2,
--   city, pincode                  — exactly the fields build_einvoice_json
--                                     and build_ewb_json block or warn on.
--                                     THIS is the gap. Plain text/format-only
--                                     validation, no cross-table consequence.
--   created_at, updated_at         — managed by the set_updated_at trigger.
--
-- GATE. branches' own RLS (branches_write, 0005) already restricts writes to
-- app_private.is_company_admin — admin only, not can_write_company's wider
-- admin-or-accountant. This function's explicit check mirrors that exactly,
-- for the same reason delete_company/update_voucher's own explicit checks
-- exist alongside RLS: a plain-English 'Only a company admin...' beats
-- Postgres' generic row-level-security violation, same discipline as the
-- friendly-error work on the ledger forms (see lib/ledgers/friendlyError.ts).
-- SECURITY INVOKER, RLS still decides the actual write — same shape as
-- delete_company (0010).
--
-- PIN code is checked here too, ahead of the table's own
-- branches_pincode_check regex — a mistyped PIN surfacing as 'add it under
-- Branches' turning into 'new row for relation "branches" violates check
-- constraint "branches_pincode_check"' is exactly the class of bug fixed
-- today for the New Ledger form.
-- ============================================================================

create or replace function public.update_branch(
  p_branch_id uuid,
  p_address_line1 text default null,
  p_address_line2 text default null,
  p_city text default null,
  p_pincode text default null
) returns void
language plpgsql
security invoker   -- RLS decides; only an admin may write a branch
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_pincode text := nullif(trim(p_pincode), '');
begin
  select company_id into v_company_id
    from public.branches
   where id = p_branch_id;

  if v_company_id is null then
    raise exception 'Branch not found';
  end if;

  if not app_private.is_company_admin(v_company_id) then
    raise exception 'Only a company admin can edit a branch''s address';
  end if;

  if v_pincode is not null and v_pincode !~ '^[1-9][0-9]{5}$' then
    raise exception 'PIN code must be 6 digits and cannot start with 0 — got %', v_pincode;
  end if;

  update public.branches
     set address_line1 = nullif(trim(p_address_line1), ''),
         address_line2 = nullif(trim(p_address_line2), ''),
         city = nullif(trim(p_city), ''),
         pincode = v_pincode
   where id = p_branch_id;
end;
$$;

revoke all on function public.update_branch(uuid, text, text, text, text) from public, anon;
grant execute on function public.update_branch(uuid, text, text, text, text) to authenticated;

comment on function public.update_branch(uuid, text, text, text, text) is
  'Sets a branch''s address_line1/address_line2/city/pincode — the fields build_einvoice_json (0230) hard-blocks on and build_ewb_json (1310) warns on. Admin-gated to match branches_write RLS (0005). Does not touch code/name/state_code/gst_registration_id/is_head_office/is_active — see this migration''s header for why each is out of scope.';
