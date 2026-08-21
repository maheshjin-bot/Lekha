-- Quick / counter billing ("POS") — a standalone screen and RPC.
-- Deliberately never touches components/invoices/InvoiceForm.tsx or the
-- create_invoice RPC's own definition: this is a NEW, separate entry
-- surface that calls the existing, unmodified create_invoice exactly the
-- way InvoiceForm already does, just with different (walk-in) defaults.
--
-- Researched pattern (Tally, Vyapar, Zoho, Busy — 21 Aug 2026 session):
-- every Indian retail-billing tool uses a single default walk-in party
-- (Tally's "Not Applicable" Party A/c Name, Vyapar's "Cash Sale") rather
-- than forcing full customer creation for a counter sale. A counter sale
-- is still an ordinary GST tax invoice — there is no separate "POS
-- invoice" document type in GST law — so this reuses create_invoice
-- as-is rather than inventing new posting logic.
--
-- Design choice: post to a dedicated "Cash Sales" ledger, NOT straight
-- into "Cash-in-Hand" itself. Posting revenue directly into the cash
-- account only models reality if every rupee is collected in physical
-- cash and never batched into a till/drawer reconciliation step — a
-- dedicated ledger keeps that reconciliation possible later without
-- reworking this feature, at the cost of one extra ledger in the debtors
-- view (harmless; it behaves like any other debtor with a running
-- balance that gets cleared by a receipt voucher against Cash-in-Hand).
--
-- IMPORTANT, verified LIVE against the seeded companies before writing
-- this (do not trust "a Cash-in-Hand ledger already exists on every
-- company" without checking — it does not): every one of the 15 seeded
-- companies has an account_groups row literally named 'Cash-in-Hand' (the
-- seeded primary group from seed_chart_of_accounts), but only ONE company
-- has ever had a LEDGER created under that group. The group is seeded;
-- the ledger is not. This function provisions the ledger itself, once,
-- idempotently — mirroring app_private.seed_tcs_ledger's (0027) exact
-- shape: look up the group by name, reuse whatever ledger the company
-- already has under it (so a company that already made its own "Cash"
-- ledger there isn't given a confusing second one), else create one.

create or replace function public.ensure_cash_sales_ledger(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_group uuid;
  v_ledger uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to set up ledgers for this company';
  end if;

  select id into v_group
    from public.account_groups
   where company_id = p_company_id and name = 'Cash-in-Hand'
   limit 1;

  if v_group is null then
    raise exception 'Chart of accounts is not set up for this company yet (no Cash-in-Hand group) — open Settings first.';
  end if;

  -- Reuse whatever ledger already sits under Cash-in-Hand, if any (e.g. a
  -- plain "Cash" ledger the company created by hand) rather than adding a
  -- confusing second one.
  select id into v_ledger
    from public.ledgers
   where company_id = p_company_id and group_id = v_group
   order by created_at
   limit 1;

  if v_ledger is not null then
    return v_ledger;
  end if;

  insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
  values (p_company_id, v_group, 'Cash Sales', 'debit', 0)
  returning id into v_ledger;

  return v_ledger;
end;
$$;

-- Every write-capable function this session grants EXECUTE to PUBLIC by
-- default at creation, and every real role (anon included) is implicitly
-- a PUBLIC member — revoking only from the named role is not enough (the
-- finding that produced migration 0064). Revoke from both explicitly.
revoke all on function public.ensure_cash_sales_ledger(uuid) from public, anon;
grant execute on function public.ensure_cash_sales_ledger(uuid) to authenticated;

comment on function public.ensure_cash_sales_ledger(uuid) is
  'Idempotently returns the walk-in "Cash Sales" ledger for quick/counter billing, creating it under the seeded Cash-in-Hand group on first use. Used by the POS screen only; create_invoice itself is unmodified.';
