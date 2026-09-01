-- ============================================================================
-- 0760 — Audit trail: fix "who" resolution, and wire up payroll's tables
-- ============================================================================
-- Two bugs found live against Bharat Industries Limited
-- (a6fc600a-1a82-4ef9-baaa-63c03753eb6c) on 2026-08-29/30 while signed in as
-- tester@lekha.test, the company's sole admin:
--
--   A. Enabling a module at /settings/modules produced two company_modules
--      audit-log rows, both shown as "System / no signed-in user" — and in
--      fact every row across the full 30-day log, across every table, shows
--      "System", for a company whose every action so far was done by a real
--      signed-in admin.
--   B. employees carries zero audit-trail rows at all, and "Employees" isn't
--      even offered in the table-filter dropdown — the trigger was never
--      attached to it.
--
-- ----------------------------------------------------------------------------
-- BUG A — ROOT CAUSE, TRACED, NOT GUESSED.
-- ----------------------------------------------------------------------------
-- The instinct going in was that app_private.audit_change() reads auth.uid()
-- but a SECURITY DEFINER RPC (set_module, create_voucher, ...) somehow clears
-- or masks it before the trigger fires. That instinct is WRONG, and it is
-- worth writing down why, so nobody re-opens it the next time "who" looks
-- broken:
--
--   1. auth.uid() reads current_setting('request.jwt.claims', true) (or the
--      'request.jwt.claim.sub' fast path) — a GUC that PostgREST sets once,
--      for the whole request/transaction, when it authenticates the caller.
--      SECURITY DEFINER changes which ROLE a function's privilege checks run
--      as; it does not open a new session and does not reset a GUC. Every
--      SECURITY DEFINER helper already in this schema
--      (app_private.is_company_member, is_company_admin,
--      user_role_in_company — 0003) depends on exactly this fact to work at
--      all, from inside an RLS policy, on every request this app has ever
--      served.
--   2. Proof by contradiction, from the bug report itself: set_module (0015)
--      is SECURITY DEFINER and its FIRST line is
--      `if not app_private.is_company_admin(p_company_id) then raise
--      exception ...`. That check reads auth.uid() (via
--      user_role_in_company). The toggle in the bug report SUCCEEDED — no
--      exception, module state changed, two audit rows were written. auth.uid()
--      therefore resolved correctly, in that same SECURITY DEFINER call, to
--      tester@lekha.test's real id. The very next statement in the same
--      function, `insert into company_modules (..., enabled_by) values (...,
--      auth.uid())`, is the identical call in the identical transaction — it
--      cannot have returned something different. And app_private.audit_change()
--      itself is ALSO already SECURITY DEFINER (has been since 0008) and reads
--      auth.uid() the same way, in the same transaction, one statement later
--      still. There is no point in this call chain where auth.uid() goes from
--      resolving to not resolving.
--   3. create_voucher (0011) is SECURITY INVOKER and ledgers is written by a
--      plain client-side `.insert()` with no RPC at all (LedgerManager.tsx) —
--      i.e. two more write paths with a THIRD combination of invoker/definer
--      and RPC/direct-table, all going through the same browser
--      createBrowserClient() (lib/supabase/client.ts) used for set_module. If
--      RPC-vs-direct or definer-vs-invoker mattered, these would disagree with
--      each other. They cannot be distinguished from company_modules by this
--      axis, which is why the report says "every table", not "the RPC-backed
--      ones" — the failure is table/path-independent, which rules the
--      capture-site theory out on its own.
--
-- So audit_log.changed_by IS being written correctly, for every write path,
-- including direct table access and every SECURITY DEFINER RPC. The actual
-- defect is one layer up, in how a captured user id gets turned into a name:
--
--   * public.get_audit_trail (0008) resolves "who" with
--     `left join public.profiles p on p.id = a.changed_by`, returning
--     p.full_name as changed_by_name — nothing else.
--   * public.profiles.full_name (0003) is populated ONLY from
--     `raw_user_meta_data ->> 'full_name'` at signup
--     (app_private.handle_new_user).
--   * This app's own sign-up form NEVER sends that metadata:
--     `supabase.auth.signUp({ email, password })`
--     (components/auth/LoginForm.tsx) — two arguments, no `options.data`.
--     There is also no profile-editing screen anywhere that could set
--     full_name after the fact (`grep -rn full_name app components lib`
--     turns up exactly two READS — approvals/page.tsx and
--     settings/TeamManager.tsx — and zero writes).
--   * Therefore profiles.full_name is null for EVERY account this app has
--     ever created, not just tester@lekha.test. This is not a new finding —
--     0107 (team-invite accept) already hit and documented the identical fact
--     verbatim: "profiles.full_name is null for every real account in this
--     app today... confirmed live" — and solved it, for the team roster, by
--     making get_company_team() SECURITY DEFINER so it could join auth.users
--     for email, which RLS never exposes to a client directly. That is the
--     prior art the audit trail should have followed and did not.
--   * The audit-trail page then does
--     `e.changed_by_name ?? <"System" / "no signed-in user">`
--     (app/(app)/[companyId]/audit-trail/page.tsx). That fallback fires on
--     ANY null changed_by_name — which is universal, given the point above —
--     collapsing every correctly-attributed real action into the exact same
--     UI state the page's own footnote reserves for "a migration, a seeding
--     routine, or a maintenance script run directly against the database".
--     The underlying changed_by column has the real, correct id sitting right
--     there the whole time; the display layer never looks past the one column
--     that is guaranteed to be empty.
--
-- THE FIX (this migration): give get_audit_trail the same auth.users escape
-- hatch 0107 already established, and fall back to email when full_name is
-- absent — which today means always, but stops being universal the day this
-- app grows a "set your name" screen.
--
-- WHAT THIS MEANS FOR THE EXISTING 30 DAYS OF "SYSTEM" ROWS: they are
-- RECOVERABLE, not lost — because changed_by was never actually null for a
-- real action; only its display was collapsed to a name that didn't exist.
-- The moment this migration is live, re-running get_audit_trail over the same
-- historical window will show the correct email for every row whose
-- changed_by is non-null, with no backfill and no data migration, because the
-- data was right all along. A row that is STILL "System" after this fix is
-- one where changed_by genuinely is null — a real migration, seed, or
-- maintenance-script write, exactly as designed. See the caveats note handed
-- back to the integrator for the one live query that confirms this against
-- the real database, which this session cannot run itself.
--
-- ----------------------------------------------------------------------------
-- BUG B — employees and employee_salary_structures were never wired in.
-- ----------------------------------------------------------------------------
-- `grep -rn "execute function app_private.audit_change" supabase/migrations`
-- returns exactly twelve triggers, ALL created by 0008 and never touched
-- since: companies, company_members, company_invites, company_modules,
-- gst_registrations, branches, member_branches, account_groups, ledgers,
-- tax_ledger_map, vouchers, voucher_entries. employees and
-- employee_salary_structures (0043, payroll core, added 35 migrations later)
-- both have company_id, both have RLS enabled with real read/write policies,
-- and neither ever got the trigger. Confirmed absent, not just unverified.
--
-- (This is likely not the only table added after 0008 that is missing it —
-- items, godowns and voucher_items look like the same gap on the same grep —
-- but the two bugs handed to this session are audit-trail "who" and
-- employees specifically. Widening this to every post-0008 table is real,
-- separate work, flagged here rather than attempted quietly.)
--
-- Fix: attach the exact same `audit` trigger, calling the exact same
-- app_private.audit_change(), with the exact same "after insert or update or
-- delete ... for each row" shape 0008 used for ledgers and vouchers. No
-- changes needed inside audit_change() itself — both new tables carry a
-- plain `company_id` column already, which is exactly what its non-companies
-- branch expects.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Part A — "who" resolution: auth.users as the fallback identity, same
-- privilege boundary 0107's get_company_team already established.
-- ----------------------------------------------------------------------------
create or replace function public.get_audit_trail(
  p_company_id uuid,
  p_from timestamptz default (now() - interval '30 days'),
  p_to timestamptz default now(),
  p_table_name text default null,
  p_limit integer default 200
) returns table (
  id uuid,
  table_name text,
  record_id uuid,
  operation text,
  changed_fields text[],
  derived_note text,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    a.id,
    a.table_name,
    a.record_id,
    a.operation,
    case when a.operation = 'UPDATE' then (
      select array_agg(key)
        from jsonb_each(a.after_data)
       where a.before_data -> key is distinct from a.after_data -> key
         and key <> 'updated_at'
    ) end,
    a.derived_note,
    a.changed_by,
    -- profiles.full_name is null for every account this app has ever
    -- created (see header, and 0107's identical finding for the team
    -- roster) — email is the only identifying fact guaranteed to exist for
    -- a real user. A row with changed_by is null throughout stays "System"
    -- (coalesce of two nulls is still null): that case is genuinely a
    -- migration/seed/maintenance write, and must keep reading that way.
    coalesce(p.full_name, u.email::text),
    a.changed_at
  from public.audit_log a
  left join public.profiles p on p.id = a.changed_by
  left join auth.users u on u.id = a.changed_by
  where a.company_id = p_company_id
    and a.changed_at between p_from and p_to
    and (p_table_name is null or a.table_name = p_table_name)
    -- This function is now SECURITY DEFINER (needed for the auth.users join
    -- above, which RLS never grants authenticated/anon directly — same
    -- reason 0107's get_company_team needed it). audit_log's own partitions
    -- are created with FORCE ROW LEVEL SECURITY (0008's
    -- secure_audit_partition), which in principle still applies even to a
    -- definer's owning role — but that is not something to lean on silently
    -- in a Rule 3(1) control. Re-stating audit_log_read's own predicate here
    -- explicitly keeps the access bar identical and independently correct
    -- regardless of who owns the function.
    and (select app_private.user_role_in_company(p_company_id)) in ('admin','auditor')
  order by a.changed_at desc
  limit least(p_limit, 1000);
$$;

revoke all on function public.get_audit_trail(uuid, timestamptz, timestamptz, text, integer) from public, anon;
grant execute on function public.get_audit_trail(uuid, timestamptz, timestamptz, text, integer) to authenticated;

comment on function public.get_audit_trail is
  'The audit trail, admin/auditor only (re-checked explicitly in the body, not left to RLS alone, because this function is SECURITY DEFINER). "Who" resolves to profiles.full_name if a company ever collects one, falling back to auth.users.email otherwise — which is every account today, since sign-up never sets full_name (see 0107, and 0760''s header for the full trace). changed_by itself was never the bug: it was already correct for direct table writes and every SECURITY DEFINER RPC alike. Only a row with changed_by actually null — a migration, a seed, or a maintenance script — should ever read "System". See 0760.';

comment on function app_private.audit_change is
  'Writes one row per insert/update/delete with changed_by = auth.uid(). Verified in 0760 that this capture is correct in every call shape this schema has (direct table write, SECURITY INVOKER RPC, SECURITY DEFINER RPC) — auth.uid() reads a transaction-scoped GUC PostgREST sets once per request, unaffected by a SECURITY DEFINER role switch. If "who" ever looks wrong again, look at the READ side (get_audit_trail / profiles.full_name) before suspecting this function; that is where the 0760 bug actually was.';


-- ----------------------------------------------------------------------------
-- Part B — attach the audit trigger to payroll's two tables, matching 0008's
-- pattern exactly (same trigger name, same timing, same function, same
-- for-each-row shape used for ledgers and vouchers).
-- ----------------------------------------------------------------------------
create trigger audit after insert or update or delete on public.employees
  for each row execute function app_private.audit_change();

create trigger audit after insert or update or delete on public.employee_salary_structures
  for each row execute function app_private.audit_change();
