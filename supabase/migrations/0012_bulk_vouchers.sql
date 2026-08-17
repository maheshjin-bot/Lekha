-- ============================================================================
-- 0012 — Bulk voucher creation for the CSV importer
-- ============================================================================
-- Looping create_voucher per group from the client means one round trip per
-- voucher — a 2,000-voucher file becomes 2,000 sequential requests. This loops
-- inside the database and returns one row per group so the importer can report
-- partial failure exactly as a per-voucher loop would.
--
-- security invoker, like create_voucher itself: RLS must still gate the role,
-- branch and lock-date checks as the calling user. Importing is not a way to
-- write rows you could not write one at a time.
-- ============================================================================

create or replace function public.create_vouchers_bulk(
  p_company_id uuid,
  -- [{"group_key":"V1","branch_id":"...","voucher_type":"payment",
  --   "voucher_date":"2026-04-01","narration":null,"reference_number":null,
  --   "lines":[{"ledger_id":"...","debit_amount":100,"credit_amount":0,
  --             "narration":null,"line_order":0}]}]
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
      v_voucher_id := public.create_voucher(
        p_company_id,
        (v_group->>'branch_id')::uuid,
        v_group->>'voucher_type',
        (v_group->>'voucher_date')::date,
        v_group->'lines',
        v_group->>'narration',
        v_group->>'reference_number',
        nullif(v_group->>'reference_date', '')::date
      );

      -- The balance and minimum-line triggers are deferrable initially
      -- deferred, so left alone they fire at COMMIT and one unbalanced group
      -- would abort the entire import instead of being reported as one bad
      -- group. Forcing them now checks only what this block queued, inside its
      -- own subtransaction, so a failure rolls back just this voucher.
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

revoke execute on function public.create_vouchers_bulk(uuid, jsonb) from public, anon;
grant execute on function public.create_vouchers_bulk(uuid, jsonb) to authenticated;
