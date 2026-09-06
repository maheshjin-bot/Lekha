-- ============================================================================
-- 1844 — Close the PUBLIC-grant hole a third time, scope seven PUBLIC
--        policies to authenticated, and stop statutory notes being erasable
-- ============================================================================
-- RECONCILIATION NOTE. This file was originally authored as migration 1560
-- in a different, unmerged worktree and applied directly to the shared live
-- database from there. 1560 is taken on main by an unrelated migration
-- (1560_screen_config.sql), so it is committed here under a fresh number
-- purely so git stops disagreeing with what the database already has.
-- Re-verified live immediately before this commit, all matching exactly:
-- 0 functions in public carry a PUBLIC EXECUTE grant, exactly 7 remain
-- anon-executable (the intended set), 0 policies in public grant to public
-- or anon, get_company_modules/get_company_profile/resolve_statutory_rule
-- are anon=false and public=false, api_get_trial_balance/
-- api_get_dashboard_kpis are anon=true (deliberate) and public=false, and
-- public.zz_gpr_copy no longer exists. This copy is being added for the
-- historical record, not executed again. The five historical migrations
-- this file's own header describes editing in place (0011, 0019, 0046,
-- 0148, 0151) have been re-applied to their files directly, as this
-- reconciliation's own deliberate exception to "fix forward only" — see
-- each of their headers for the one-line correction and a pointer back here.
-- ============================================================================
--
-- Three findings from a live audit of pg_proc.proacl and pg_policies, each
-- verified against the live project before and after this migration rather
-- than taken on the audit's word.
--
-- NONE OF THIS WAS EXPLOITABLE, and that is stated first so the rest is read
-- in proportion. Every finding below failed closed on a second layer:
--   - the seven functions are all SECURITY INVOKER, so an anon call runs with
--     anon's own RLS. Tried at the HTTP layer with the real publishable key:
--     update_voucher returned P0001 "Voucher not found" because RLS hid every
--     row from it, and the getters returned 42501 permission denied.
--   - six of the seven mis-scoped policies sit on tables anon holds no grant
--     on at all, so the policy is unreachable regardless.
--   - statutory_update_notes has zero rows, so nothing has been tampered with.
-- This is defence-in-depth restoration. It matters precisely BECAUSE the
-- second layer held: RLS should not be the only thing standing between an
-- unauthenticated visitor and a write RPC.
--
-- ----------------------------------------------------------------------------
-- 1. `revoke ... from anon` alone is a no-op. Third occurrence.
-- ----------------------------------------------------------------------------
-- Postgres grants EXECUTE on every new function to the PUBLIC pseudo-role at
-- creation time, and every real role — anon included — inherits it. Revoking
-- only from anon leaves that broader grant untouched. 0064 fixed this for
-- seven functions and wrote the reasoning down; 0231 fixed it for thirty
-- more. It has now recurred a third time, in two places that copied only the
-- second half of the pattern:
--   0011_create_voucher_optional_args.sql:181  revoke ... update_voucher from anon;
--   0019_bank_reconciliation.sql:272-274       revoke ... match_bank_line etc from anon;
-- and three functions that were never revoked from anything at all
-- (get_company_modules, get_company_profile, resolve_statutory_rule).
--
-- The leading bare `=X/postgres` entry in proacl is PUBLIC. All seven showed
-- it; all seven also carry an explicit `authenticated=X/postgres`, which is
-- why revoking PUBLIC does not take access away from the real app.
--
-- resolve_statutory_rule: REVOKED, NOT DROPPED, deliberately. It has no
-- callers anywhere — no SQL function body references it (checked pg_proc.prosrc
-- across public and app_private), no TypeScript outside the generated types —
-- and public.statutory_rules is still empty, so it is genuinely dead code
-- today. Dropping it anyway was rejected: it is foundational 0002
-- infrastructure for the "resolve rules AS AT a date" principle that 0046's
-- header still builds on, dropping it would mean editing a migration marked
-- applied-and-verified and desyncing the generated types for every other
-- session working in this shared project right now, and a revoke closes the
-- finding completely on its own — the exposure was the problem, not the
-- existence. Whether to delete unused foundations is a cleanup decision that
-- should be made on its own, not smuggled into a security fix.
-- ----------------------------------------------------------------------------

revoke execute on function public.update_voucher(uuid, date, jsonb, text, text, date, uuid) from public, anon;
revoke execute on function public.match_bank_line(uuid, uuid) from public, anon;
revoke execute on function public.unmatch_bank_line(uuid) from public, anon;
revoke execute on function public.auto_match_bank_lines(uuid, uuid) from public, anon;
revoke execute on function public.get_company_modules(uuid, date) from public, anon;
revoke execute on function public.get_company_profile(uuid) from public, anon;
revoke execute on function public.resolve_statutory_rule(text, text, date, jsonb) from public, anon;

-- The two public-API dispatchers are a different case: anon calling them is
-- the whole point (0063 key-authenticated read endpoints), and they keep that
-- access because 0063 granted it EXPLICITLY. What they should not also carry
-- is the incidental PUBLIC grant Postgres left on them at creation, which
-- nobody asked for and which extends them to every future role as well.
-- Verified before revoking that both already hold explicit anon,
-- authenticated, service_role and postgres grants, so this takes nothing real
-- away — it just makes "anon can call this" a deliberate statement rather
-- than a default. That in turn lets the new invariant assert the crisp
-- version of the rule: any function anon can execute must say so explicitly.
revoke execute on function public.api_get_trial_balance(text, date, date) from public;
revoke execute on function public.api_get_dashboard_kpis(text) from public;

-- ----------------------------------------------------------------------------
-- 1a. A stray debug function the audit's list of seven did not include.
-- ----------------------------------------------------------------------------
-- Scanning every function in public rather than only the seven reported found
-- an eighth: public.zz_gpr_copy(uuid, date), a verbatim copy of
-- get_payroll_register (gpr) that exists ONLY in the live database — it is in
-- no migration file in this repo and is referenced by no SQL and no
-- application code. It carries both the PUBLIC grant and an explicit
-- `anon=X/postgres` one, and it returns salary, PF, ESI and TDS figures.
-- Someone created it live while debugging and never cleaned it up.
--
-- Dropped rather than revoked: unlike resolve_statutory_rule there is no
-- design intent to preserve here, it duplicates a function that already
-- exists, and leaving an unversioned payroll-shaped function in a live
-- schema means the repo no longer describes the database. `if exists` so
-- this migration is still replayable on a fresh database, where it never
-- existed in the first place.
-- ----------------------------------------------------------------------------

drop function if exists public.zz_gpr_copy(uuid, date);

-- ----------------------------------------------------------------------------
-- 1b. app_private's ~95 PUBLIC grants are DELIBERATELY LEFT ALONE.
-- ----------------------------------------------------------------------------
-- 95 of the 147 app_private functions carry the same PUBLIC grant. They are
-- not being hardened here, and this is a decision, not an oversight:
--
--   - anon cannot reach them. It holds no USAGE on the app_private schema
--     (has_schema_privilege('anon','app_private','USAGE') is false), and
--     PostgREST refuses to expose a non-exposed schema at all (PGRST106).
--     So the exposure reduction available here is exactly zero.
--   - revoking would take real access away. All 95 carry an explicit
--     `authenticated=X/postgres`, so authenticated is safe — but ZERO of them
--     grant service_role explicitly, meaning service_role reaches all 95
--     ONLY through the PUBLIC grant. Revoking PUBLIC would silently strip
--     service_role's access to every privilege helper in the schema. 61 of
--     them are SECURITY DEFINER, and app_private.run_notifications_digest is
--     exactly the kind of thing a service-role job calls.
--
-- Trading a real chance of breaking a server-side path for no reduction in
-- attack surface is a bad trade. What this migration does instead is convert
-- "it's fine because anon has no USAGE" from an assumption into an enforced
-- invariant — see the two new assertions in tests/db/invariants.test.ts, which
-- go red the moment anyone grants anon USAGE on app_private. If service_role
-- is ever given explicit grants across app_private, revoking PUBLIC there
-- becomes safe and should be done then.
--
-- ----------------------------------------------------------------------------
-- 2. Seven RLS policies name PUBLIC because `to authenticated` was omitted.
-- ----------------------------------------------------------------------------
-- A `create policy` with no `to` clause defaults to PUBLIC, which includes
-- anon. 0148:243 and every policy in 0151 omitted it. The repo's own
-- invariant — "no policy grants anything to anon or public" in
-- tests/db/invariants.test.ts — has been RED on exactly these seven for as
-- long as they have existed, and nobody saw it, because the whole database
-- suite skips silently without LEKHA_TEST_DATABASE_URL (see finding 4 in
-- this migration's companion notes and the new .env.example entry).
--
-- The three recurring_* tables have no anon grant, so those six were
-- unreachable anyway. income_tax_statement_lines is the sharp one: anon DOES
-- hold SELECT on it, and the only thing stopping an unauthenticated read of
-- real data was app_private.is_company_member returning false. Verified
-- before this fix: GET /rest/v1/income_tax_statement_lines with the
-- publishable key returned [] at HTTP 200 against 2 real rows — correct
-- behaviour, but produced by the USING clause rather than by the policy
-- refusing to apply to anon at all.
--
-- The predicates below are unchanged from 0148/0151; only the role scope is
-- added. Both original migrations have been corrected in place as well, so a
-- fresh database never reproduces this.
-- ----------------------------------------------------------------------------

drop policy if exists income_tax_statement_lines_read on public.income_tax_statement_lines;
create policy income_tax_statement_lines_read on public.income_tax_statement_lines
  for select to authenticated
  using (app_private.is_company_member(company_id));

drop policy if exists recurring_voucher_templates_read on public.recurring_voucher_templates;
create policy recurring_voucher_templates_read on public.recurring_voucher_templates
  for select to authenticated
  using (app_private.is_company_member(company_id));

drop policy if exists recurring_voucher_templates_write on public.recurring_voucher_templates;
create policy recurring_voucher_templates_write on public.recurring_voucher_templates
  for all to authenticated
  using (app_private.can_write_company(company_id) and app_private.can_access_branch(branch_id))
  with check (app_private.can_write_company(company_id) and app_private.can_access_branch(branch_id));

drop policy if exists recurring_voucher_template_lines_read on public.recurring_voucher_template_lines;
create policy recurring_voucher_template_lines_read on public.recurring_voucher_template_lines
  for select to authenticated
  using (app_private.is_company_member(company_id));

drop policy if exists recurring_voucher_template_lines_write on public.recurring_voucher_template_lines;
create policy recurring_voucher_template_lines_write on public.recurring_voucher_template_lines
  for all to authenticated
  using (app_private.can_write_company(company_id))
  with check (app_private.can_write_company(company_id));

drop policy if exists recurring_voucher_generation_log_read on public.recurring_voucher_generation_log;
create policy recurring_voucher_generation_log_read on public.recurring_voucher_generation_log
  for select to authenticated
  using (app_private.is_company_member(company_id));

drop policy if exists recurring_voucher_generation_log_write on public.recurring_voucher_generation_log;
create policy recurring_voucher_generation_log_write on public.recurring_voucher_generation_log
  for all to authenticated
  using (app_private.can_write_company(company_id))
  with check (app_private.can_write_company(company_id));

-- ----------------------------------------------------------------------------
-- 3. statutory_update_notes: keep it global, stop it being erasable.
-- ----------------------------------------------------------------------------
-- statutory_update_notes_write was `for all to authenticated using (true)
-- with check (true)` on a table with no company_id column — the only
-- unscoped write policy in the schema. Any user of any company could create,
-- rewrite or DELETE notes every other company's users see.
--
-- WHAT IS NOT CHANGING, and why. 0046's header decides two things explicitly
-- and at length, and both are respected here:
--   - NOT COMPANY-SCOPED. Every ref_* table these notes track (TDS/TCS
--     sections, slabs, GST rates, ESI/PF figures) is national and shared by
--     every tenant; no company's admin "owns" a proposal to change the TDS
--     rate table. Adding a company_id would reverse a decision that was made
--     deliberately, with reasons, and would turn one shared editorial list
--     into ten identical private ones.
--   - NO PLATFORM-OPERATOR ROLE. 0046 considered gating writes to an operator
--     and rejected inventing that role for one low-stakes log as scope creep.
--     That is still true, so "make writes admin-or-service-only" is also
--     rejected: it would break the screen outright, since any authenticated
--     user filing a note is the intended workflow, and a second user moving
--     someone else's note from proposed to confirmed IS the review step the
--     whole table exists for.
--
-- WHAT IS CHANGING is the one thing 0046 never actually decided. Its header
-- reasons about open READ and open WRITE; it never says anyone should be able
-- to destroy someone else's entry. The table's own comment calls it an
-- "Audit trail", and an audit trail any user can silently erase does not do
-- the job it is named for. So:
--   - the single `for all` policy is split into explicit INSERT and UPDATE
--     policies, both still open to any authenticated user exactly as designed;
--   - there is deliberately NO DELETE policy. RLS denies what no policy
--     permits, so notes become append-and-amend only. This matches the
--     application exactly: StatutoryUpdateManager.tsx inserts (line 144) and
--     updates status/applied_note (line 58), and never deletes. A rejected or
--     superseded note is what the 'rejected' status is already for.
--   - created_by gets `default auth.uid()`. It has never had a default and
--     the screen never sets it, so every note this table could hold would
--     have been authorless — a real defect in something called an audit
--     trail, free to fix at zero rows and painful later.
--   - a BEFORE UPDATE trigger pins created_by and created_at, so the open
--     UPDATE that the review workflow needs cannot be used to rewrite
--     authorship. Note content stays editable by anyone: fixing a typo or a
--     citation in a shared editorial list is legitimate, and locking that
--     down would need the operator role 0046 declined to invent.
--
-- Zero rows today, so none of this needs a backfill.
-- ----------------------------------------------------------------------------

alter table public.statutory_update_notes
  alter column created_by set default auth.uid();

drop policy if exists statutory_update_notes_write on public.statutory_update_notes;
drop policy if exists statutory_update_notes_insert on public.statutory_update_notes;
drop policy if exists statutory_update_notes_update on public.statutory_update_notes;

create policy statutory_update_notes_insert on public.statutory_update_notes
  for insert to authenticated
  with check (true);

create policy statutory_update_notes_update on public.statutory_update_notes
  for update to authenticated
  using (true)
  with check (true);

-- No statutory_update_notes_delete policy, on purpose. See above.

create or replace function app_private.statutory_update_notes_keep_authorship()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Anyone may amend a note — that is the shared review workflow. Nobody may
  -- reassign who filed it or when.
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  return new;
end;
$$;

-- Fires after set_updated_at (triggers run in name order, 'se' before 'st')
-- and touches a disjoint set of columns, so the two do not interact.
drop trigger if exists statutory_update_notes_keep_authorship on public.statutory_update_notes;
create trigger statutory_update_notes_keep_authorship
  before update on public.statutory_update_notes
  for each row execute function app_private.statutory_update_notes_keep_authorship();

comment on table public.statutory_update_notes is
  'Audit trail for statutory rate/rule changes across every ref_* table this app maintains — not itself a rate table, and does not write to one. proposed: logged, not yet verified. confirmed: verified against the citation, ready to build. applied: the underlying ref_* table has actually been updated (applied_note should say which migration). rejected: turned out not to apply, or was superseded. Global, not company-scoped — every ref_* table this tracks is shared by every tenant. Append-and-amend only: any authenticated user may file a note and any other may advance or correct it, but nobody can delete one (there is no DELETE policy) and nobody can reassign its authorship (1844). Use the rejected status instead of deleting.';
