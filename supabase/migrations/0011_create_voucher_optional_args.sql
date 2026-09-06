-- ============================================================================
-- 0011 — Voucher RPC argument order
-- ============================================================================
-- create_voucher took narration and the reference fields as REQUIRED
-- positional arguments, so a client that simply did not have a reference
-- number could not call it.
--
-- PostgREST resolves an RPC by the exact set of argument names in the request
-- body, and supabase-js omits undefined keys. The failure therefore surfaced
-- as:
--
--   Could not find the function public.create_voucher(p_branch_id,
--   p_company_id, p_lines, p_narration, p_voucher_date, p_voucher_type)
--   in the schema cache
--
-- — which reads like a deployment or migration problem rather than a
-- signature mismatch, and sent me looking in the wrong place first.
--
-- They could not simply be given defaults: p_lines followed them without one,
-- and Postgres requires every parameter after the first defaulted one to be
-- defaulted too. The order was wrong — required arguments must come first.
--
-- Worth noting how this escaped: every SQL-level test passed, because a
-- hand-written call supplies all twelve arguments. Only the real client,
-- omitting what it does not have, exercises the resolution path.
-- ============================================================================

drop function if exists public.create_voucher(uuid, uuid, text, date, text, text, date, jsonb, uuid, char, numeric, text);

create or replace function public.create_voucher(
  p_company_id uuid,
  p_branch_id uuid,
  p_voucher_type text,
  p_voucher_date date,
  p_lines jsonb,
  p_narration text default null,
  p_reference_number text default null,
  p_reference_date date default null,
  p_party_ledger_id uuid default null,
  p_txn_currency char(3) default 'INR',
  p_exchange_rate numeric default 1,
  p_rate_source text default null
) returns uuid
language plpgsql
security invoker   -- RLS gates role and period checks as the calling user
set search_path = ''
as $$
declare
  v_voucher_id uuid;
  v_display_number text;
  v_seq_number int;
  v_fy_label text;
  v_line jsonb;
begin
  select display_number, seq_number, fy_label
    into v_display_number, v_seq_number, v_fy_label
    from app_private.next_voucher_number(p_company_id, p_branch_id, p_voucher_type, p_voucher_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, reference_number,
    reference_date, party_ledger_id, txn_currency, exchange_rate, rate_source,
    created_by
  )
  values (
    p_company_id, p_branch_id, p_voucher_type, v_display_number, v_seq_number,
    v_fy_label, p_voucher_date, p_narration, p_reference_number,
    p_reference_date, p_party_ledger_id, p_txn_currency, p_exchange_rate,
    p_rate_source, auth.uid()
  )
  returning id into v_voucher_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id,
      debit_amount, credit_amount, fc_amount, dimensions, narration, line_order
    )
    values (
      v_voucher_id,
      p_company_id,
      -- A line may sit in a different branch from the header — an inter-branch
      -- journal is one voucher touching two.
      coalesce((v_line->>'branch_id')::uuid, p_branch_id),
      (v_line->>'ledger_id')::uuid,
      coalesce((v_line->>'debit_amount')::numeric, 0),
      coalesce((v_line->>'credit_amount')::numeric, 0),
      (v_line->>'fc_amount')::numeric,
      coalesce(v_line->'dimensions', '{}'::jsonb),
      v_line->>'narration',
      coalesce((v_line->>'line_order')::int, 0)
    );
  end loop;

  return v_voucher_id;
end;
$$;

revoke execute on function public.create_voucher(uuid, uuid, text, date, jsonb, text, text, date, uuid, char, numeric, text) from anon;


-- Same defect in update_voucher. The financial-year guard is unchanged: a
-- voucher's number belongs to its year's series and may already be printed on
-- a document sent to the other party, so moving it is refused rather than
-- silently renumbered.
drop function if exists public.update_voucher(uuid, date, text, text, date, jsonb, uuid);

create or replace function public.update_voucher(
  p_voucher_id uuid,
  p_voucher_date date,
  p_lines jsonb,
  p_narration text default null,
  p_reference_number text default null,
  p_reference_date date default null,
  p_party_ledger_id uuid default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_branch_id uuid;
  v_existing_fy text;
  v_new_fy text;
  v_fy_start_month smallint;
  v_line jsonb;
begin
  select company_id, branch_id, financial_year_label
    into v_company_id, v_branch_id, v_existing_fy
    from public.vouchers where id = p_voucher_id;

  if v_company_id is null then
    raise exception 'Voucher not found';
  end if;

  select financial_year_start_month into v_fy_start_month
    from public.companies where id = v_company_id;

  v_new_fy := app_private.fy_label(p_voucher_date, v_fy_start_month);

  if v_new_fy is distinct from v_existing_fy then
    raise exception
      'Cannot move this voucher from financial year % to %: its number belongs to the % series. Delete it and re-enter under the correct year.',
      v_existing_fy, v_new_fy, v_existing_fy;
  end if;

  update public.vouchers
     set voucher_date = p_voucher_date,
         narration = p_narration,
         reference_number = p_reference_number,
         reference_date = p_reference_date,
         party_ledger_id = coalesce(p_party_ledger_id, party_ledger_id),
         updated_by = auth.uid()
   where id = p_voucher_id;

  delete from public.voucher_entries where voucher_id = p_voucher_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into public.voucher_entries (
      voucher_id, company_id, branch_id, ledger_id,
      debit_amount, credit_amount, fc_amount, dimensions, narration, line_order
    )
    values (
      p_voucher_id,
      v_company_id,
      coalesce((v_line->>'branch_id')::uuid, v_branch_id),
      (v_line->>'ledger_id')::uuid,
      coalesce((v_line->>'debit_amount')::numeric, 0),
      coalesce((v_line->>'credit_amount')::numeric, 0),
      (v_line->>'fc_amount')::numeric,
      coalesce(v_line->'dimensions', '{}'::jsonb),
      v_line->>'narration',
      coalesce((v_line->>'line_order')::int, 0)
    );
  end loop;

  return p_voucher_id;
end;
$$;

-- `from anon` alone is a NO-OP: Postgres grants EXECUTE to the PUBLIC
-- pseudo-role at creation time and anon inherits it, so the function stayed
-- anon-callable until 1844. Must revoke from both. Corrected in place.
revoke execute on function public.update_voucher(uuid, date, jsonb, text, text, date, uuid) from public, anon;
