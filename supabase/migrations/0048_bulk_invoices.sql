-- ============================================================================
-- 0048 — Bulk invoice creation for the CSV importer
-- ============================================================================
-- 0012 built create_vouchers_bulk for plain journal-style vouchers. Invoices
-- (sales/purchase/credit_note/debit_note) go through create_invoice instead
-- (0016, superseded by 0027) because they also post voucher_items and the
-- GST/TCS tax entries — a plain create_voucher call cannot express that.
-- This is the same loop-inside-the-database shape as 0012, aimed at
-- create_invoice instead of create_voucher, for exactly the same reason:
-- one round trip per import instead of one per invoice.
--
-- security invoker, like create_invoice and create_vouchers_bulk: RLS still
-- gates the role, branch and lock-date checks as the calling user.
--
-- The voucher-balance check (0007) is a deferrable-initially-deferred
-- constraint trigger on voucher_entries, and create_invoice posts through
-- voucher_entries exactly as create_voucher does — so left alone it would
-- fire once at COMMIT and one bad invoice in a batch would abort the whole
-- import instead of being reported as one bad group. Forcing
-- `set constraints all immediate; set constraints all deferred;` right
-- after each successful call, inside the same per-group exception block, is
-- the identical fix 0012 applied for create_vouchers_bulk.
-- ============================================================================

create or replace function public.create_invoices_bulk(
  p_company_id uuid,
  -- [{"group_key":"I1","branch_id":"...","voucher_type":"sales",
  --   "voucher_date":"2026-04-01","party_ledger_id":"...",
  --   "trading_ledger_id":"...","godown_id":null,"narration":null,
  --   "reference_number":null,"reference_date":null,"place_of_supply":null,
  --   "items":[{"item_id":"...","quantity":1,"rate":100,
  --             "description":null}]}]
  p_groups jsonb
) returns table (group_key text, voucher_id uuid, error_message text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_group jsonb;
  v_voucher_id uuid;
begin
  for v_group in select * from jsonb_array_elements(p_groups) loop
    group_key := v_group->>'group_key';
    voucher_id := null;
    error_message := null;

    begin
      v_voucher_id := public.create_invoice(
        p_company_id,
        (v_group->>'branch_id')::uuid,
        v_group->>'voucher_type',
        (v_group->>'voucher_date')::date,
        (v_group->>'party_ledger_id')::uuid,
        (v_group->>'trading_ledger_id')::uuid,
        nullif(v_group->>'godown_id', '')::uuid,
        v_group->'items',
        v_group->>'narration',
        v_group->>'reference_number',
        nullif(v_group->>'reference_date', '')::date,
        nullif(v_group->>'place_of_supply', '')::char(2)
      );

      -- Same deferred-constraint trick as 0012 — see migration header.
      set constraints all immediate;
      set constraints all deferred;

      voucher_id := v_voucher_id;
    exception when others then
      -- Rolls back this group only; the loop continues with the next.
      error_message := sqlerrm;
    end;

    return next;
  end loop;
end;
$$;

revoke execute on function public.create_invoices_bulk(uuid, jsonb) from public, anon;
grant execute on function public.create_invoices_bulk(uuid, jsonb) to authenticated;
