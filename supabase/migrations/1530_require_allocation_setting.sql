-- ============================================================================
-- 1530 — A mandatory-allocation setting
-- ============================================================================
-- WHY. AllocationDrawer lets a preparer pick which open bills a payment or
-- receipt settles, but nothing requires them to use it — a Payment voucher
-- posts today exactly as happily against "no allocation chosen" as against a
-- fully-allocated one. For a company that actually manages bill-wise credit
-- (chases specific overdue invoices, reports debtor ageing that means
-- something), an unallocated receipt is a hole: the cash lands, the party's
-- net balance drops, and nobody can say which invoice it paid. FIFO-only
-- settlement hides the hole rather than closing it — it invents an allocation
-- the preparer never made.
--
-- The fix is a company-level choice, not a global rule. A brand-new trader
-- posting five vouchers a day should not be blocked from saving a payment
-- because they have not yet decided which of three old bills it covers —
-- that friction is exactly what drove most of this app's users off spreadsheet
-- discipline in the first place. A company running real bill-wise credit
-- control should be able to make the discipline mandatory. So: optional tier,
-- off for every company (new or existing) until an admin turns it on via the
-- same set_module() every other optional module already uses. No seeding at
-- company creation — confirmed by reading public.create_company (0014,
-- latest definition): it inserts companies/company_members/branches/godowns
-- rows, calls seed_chart_of_accounts, then only
-- app_private.resolve_conditional_modules, which loops over
-- `tier = 'conditional'` rows exclusively (0004). No company_modules row is
-- ever written for an optional-tier module at creation time; every optional
-- module starts absent, not merely inactive, and this one is no different.
--
-- This migration lays down ONLY the catalog row and the one predicate
-- VoucherScreen's submit path will call before posting a Payment/Receipt/
-- Journal that touches a bill-wise ledger. It does not touch
-- create_voucher, create_invoice, or set_voucher_allocations — enforcing the
-- setting is a client-side gate in front of those calls, not a change to what
-- they accept.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. The catalog row
-- ----------------------------------------------------------------------------
-- Confirmed live before writing this: `select code from ref_modules where
-- code ilike '%alloc%'` returns nothing, so there is no prior module to
-- collide with or rename. sort_order 69 continues straight on from
-- public_api (68), the last optional-tier row in 0004.
insert into public.ref_modules (code, name, tier, depends_on, activates_when, description, sort_order)
values (
  'strict_allocation',
  'Mandatory bill allocation',
  'optional',
  '{}',
  null,
  'Requires every payment, receipt and journal against a bill-wise ledger to be allocated to specific bills before it can be posted, instead of allowing an unallocated settlement.',
  69
);

-- ----------------------------------------------------------------------------
-- 2. The predicate VoucherScreen's submit logic calls
-- ----------------------------------------------------------------------------
-- Mirrors app_private.module_active exactly (effective_from <= today,
-- effective_to null or in the future) — deliberately today-relative rather
-- than voucher-date-relative. Unlike a GST or TDS rate, "does this company
-- currently insist on allocation" is a workflow rule about the person typing
-- right now, not a fact that has to hold retroactively for old vouchers to
-- stay valid; a voucher posted before the setting was switched on is not
-- retroactively wrong, and one being typed after it was switched off should
-- not suddenly demand allocation because of its backdated voucher date.
--
-- security invoker (not definer): this has no privileged work to do — it
-- delegates straight to app_private.module_active, which is itself already
-- SECURITY DEFINER and already callable by authenticated (confirmed live:
-- has_function_privilege('authenticated', 'app_private.module_active(uuid,
-- text,date)', 'execute') = true). Wrapping it in another DEFINER layer here
-- would add privilege for no reason.
create or replace function public.is_strict_allocation_required(
  p_company_id uuid
) returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select app_private.module_active(p_company_id, 'strict_allocation');
$$;

comment on function public.is_strict_allocation_required(uuid) is
  'Is the mandatory-allocation setting (module strict_allocation) currently on for this company? VoucherScreen checks this before submitting a Payment/Receipt/Journal against a bill-wise ledger with no allocation lines. See 1530.';

-- Revoking from anon ALONE is a no-op in this database (anon inherits
-- PUBLIC's default EXECUTE grant) — PUBLIC must be named explicitly, per the
-- schema-wide allowlist invariant this codebase already pays for once (0064,
-- 0231, 1510, 1520 most recently).
revoke all on function public.is_strict_allocation_required(uuid) from public, anon;
grant execute on function public.is_strict_allocation_required(uuid) to authenticated;
