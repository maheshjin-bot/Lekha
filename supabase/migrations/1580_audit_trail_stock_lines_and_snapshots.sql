-- ============================================================================
-- 1580 — The audit trail: stock lines were never logged, and the reader threw
-- away the before/after snapshots it already had
-- ============================================================================
-- Rule 3(1) of the Companies (Accounts) Rules requires books kept in
-- electronic mode to carry an edit log, and the auditor has to report on
-- whether it operated throughout the year. Three holes, all confirmed against
-- the live database on 2 Sep 2026 before anything here was written:
--
-- HOLE 1 — voucher_items has no audit trigger at all.
--   `select tgrelid::regclass from pg_trigger where tgfoid =
--   'app_private.audit_change'::regproc and not tgisinternal` returns exactly
--   fourteen tables live: the twelve 0008 created plus employees and
--   employee_salary_structures from 0760. public has 120 tables, 104 of them
--   carrying a company_id. voucher_items is not among the fourteen — and it
--   holds the quantity, rate, discount, HSN and per-line taxable value of
--   every invoice in the system. update_invoice (0055, redefined as recently
--   as 1500) rewrites that table wholesale on every edit:
--     delete from public.voucher_items where voucher_id = p_voucher_id;
--   followed by a fresh insert per line. So the priced lines of an invoice
--   could be rewritten from top to bottom with not one row recorded anywhere,
--   while the voucher header and the voucher_entries either side of them were
--   both logged. 0760's own header flagged this ("items, godowns and
--   voucher_items look like the same gap on the same grep") and deliberately
--   left it; this migration closes it.
--
-- HOLE 2 — get_audit_trail returned the NAMES of the changed fields and threw
--   the values away. The trigger has captured full before/after snapshots
--   since 0008 and 1,979 live rows carry a populated before_data, but the only
--   reader in the app computed `array_agg(key) ... where before_data -> key is
--   distinct from after_data -> key` and returned that array. "What was this
--   value before?" — the entire point of an edit log — was unanswerable
--   through the application while the answer sat in the table.
--
-- HOLE 3 — the viewer's "Voucher stock lines" filter could never return a
--   row, being a filter on table_name = 'voucher_items'. Fixed by hole 1
--   rather than by deleting the control.
--
-- ----------------------------------------------------------------------------
-- ROW-LEVEL OR VOUCHER-LEVEL? The volume question, answered with numbers.
-- ----------------------------------------------------------------------------
-- Attaching 0008's row-level app_private.audit_change() to voucher_items is
-- the one-line fix, and it is the wrong one. Because update_invoice replaces
-- the whole line set, a row-level trigger turns one human edit into
-- 2 x (number of lines) audit rows — a DELETE of every old line and an INSERT
-- of every new one — none of which, read on its own, says what the person
-- actually did. Measured on this database: a ten-line invoice edit would log
-- twenty voucher_items rows. voucher_entries, already logged row-level since
-- 0008, contributes eight more (party + trading + CGST + SGST, deleted and
-- reinserted) and the header one. Twenty-nine rows for one edit, and an
-- auditor cannot see from any of them that the quantity on line 3 went from
-- 10 to 12.
--
-- So voucher_items is logged at STATEMENT level, aggregated per voucher, using
-- transition tables (PG 17.6 live, supported since 10):
--
--   one INSERT/DELETE/UPDATE statement  ->  one audit_log row per voucher
--                                           touched, carrying every line of
--                                           that voucher in a `lines` array
--
-- MEASURED, not assumed — this was dry-run against the live database inside a
-- rolled-back transaction before it was applied, editing a real two-line
-- invoice (Sharma Textiles HO/SAL/2026-27/00023) through update_invoice, and
-- the measurement corrected the design:
--
--   voucher_items DELETE  1 row   ← all lines, one `delete from voucher_items
--                                   where voucher_id = ...` statement
--   voucher_items INSERT  2 rows  ← NOT one. update_invoice inserts inside a
--                                   `for v_item in select * from
--                                   jsonb_array_elements(p_items) loop`, so
--                                   each line is its own INSERT STATEMENT and
--                                   fires the statement trigger separately.
--
-- So an N-line invoice edit writes 1 + N voucher_items rows, against 2N for a
-- row-level trigger: 11 rather than 20 for ten lines, 3 rather than 4 for two.
-- Halving it is worth having, but the honest reading is that the write-side
-- aggregation only fully pays off on set-based writers, and update_invoice
-- and create_invoice are not that. Rewriting their per-line loops into one
-- set-based insert would make it exactly 2 — it is the right fix and it is a
-- change to the invoice engine, not to the audit trail, so it is written down
-- here as a follow-up rather than smuggled into this migration.
--
-- What closes the readability gap regardless of the count is that everything
-- one transaction wrote for one voucher shares a changed_at (now() is the
-- transaction timestamp, fixed for the whole transaction) and the same
-- record_id — so the viewer folds them into ONE event per operation before
-- rendering: "stock lines removed, 2 lines" then "stock lines written, 2
-- lines". Two events, both complete, from an append-only log that was never
-- amended to make them look tidy. The alternative — having the trigger update
-- the row it wrote a statement earlier so the count came out at 2 — was
-- rejected: a log whose rows can be amended, even by its own trigger, even
-- inside the writing transaction, is not an audit log.
--
-- get_audit_trail orders ties DELETE-before-INSERT within a changed_at, so the
-- pair always reads old-set-then-new-set.
--
-- Nothing is lost against a row-level trigger — every column of every line is
-- in the snapshot, which is strictly more than a row-level entry records,
-- because the lines arrive as a set with their sibling context intact — and
-- record_id is the VOUCHER, so an entry points at a document a reader can
-- open rather than at a line id that exists nowhere else.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: it does not convert voucher_entries to
-- the same statement-level shape. That trigger is applied, working, and has
-- 1,201 rows of real history behind it; changing its granularity now would
-- split the log's own semantics at a date an auditor would have to be told
-- about, to fix readability on a table whose row-level entries become
-- perfectly legible the moment hole 2 is closed (a voucher_entries row is one
-- debit or one credit — its snapshot IS the fact). Its 8-rows-per-edit cost is
-- bounded by the number of ledgers a document posts to, not by line count, and
-- it is reported as a follow-up rather than fixed quietly here.
--
-- app_private.audit_voucher_lines() is written to be reusable by any other
-- voucher-child line table (voucher_allocations, voucher_item_batches,
-- voucher_ship_to are the obvious next three) with no dynamic SQL: it needs
-- only company_id, voucher_id and id on the table, and reads TG_TABLE_NAME for
-- the rest. Attaching the next table is three CREATE TRIGGER statements.
--
-- ----------------------------------------------------------------------------
-- WHAT THE SNAPSHOTS ARE ALLOWED TO SHOW
-- ----------------------------------------------------------------------------
-- Surfacing before/after means surfacing whole rows, so what the rows hold was
-- checked live rather than assumed:
--
--   * Cross-tenant: not possible. audit_log's company_id is NOT NULL and the
--     audit_log_read policy filters on it; RLS and a policy are present on the
--     parent AND on all fifteen partitions (fourteen monthly + default), each
--     with FORCE ROW LEVEL SECURITY, and the policy is restricted to
--     ('admin','auditor'). Verified in pg_policies for every partition.
--     get_audit_trail re-states that role check in its own body as well, since
--     0760 made it SECURITY DEFINER.
--
--   * companies.password_hash — present as a key in 25 live audit rows, and
--     null in every one of them today (no company has set a password yet, so
--     nothing is exposed at this moment — this is a latent leak, not a live
--     one, and it goes live the first time somebody uses the feature). It is
--     the one genuine escalation of the set: password_hash is NOT in the
--     column-level SELECT allowlist granted to `authenticated` (checked in
--     information_schema.column_privileges), so it is unreadable through the
--     API by design, and returning it inside a snapshot would newly expose a
--     credential hash. REDACTED.
--
--   * company_invites.token — a bearer credential that accepts an invite.
--     Readable directly only by an admin (company_invites_read =
--     is_company_admin), while the audit trail is also open to an AUDITOR, who
--     is not an admin. Returning it would hand an auditor a live invite token.
--     REDACTED — that an invite was created, to whom and in what role is the
--     auditable fact; the token value is not.
--
--   * ledgers.bank_account_number (150 live rows) and
--     companies.print_bank_account_number — MASKED to the last four digits.
--     A supplier's bank account being changed is exactly the change an auditor
--     is looking for, so the field must stay visible and must stay diffable;
--     printing full account numbers across a 500-row log page is not needed to
--     show that. The masked pair still differs when the account changed, and
--     changed_fields is computed from the RAW snapshots, so a change is
--     reported as changed even where the mask hides it.
--
--   * employee_salary_structures (basic/HRA/allowances, 7 live rows) and
--     employees (PAN, UAN, ESI) — shown in full, deliberately. Both tables are
--     readable by every company MEMBER under their own RLS policies
--     (employee_salary_structures_read = is_company_member); the audit trail is
--     admin/auditor only, which is strictly narrower. Redacting here would
--     hide a salary revision from the reviewer while leaving the current
--     figure one screen away, which protects nothing.
--
--   * api_keys.key_hash, payment_gateway_configs.webhook_secret,
--     signature_request_signers.access_token, capture_drafts.confirm_token —
--     no audit trigger on those tables today, so none of these is in the log.
--     They are in the redaction list anyway, so that attaching a trigger to
--     one of them later cannot leak a secret by omission.
--
-- Redaction happens in the READER, not in the trigger: the log keeps the whole
-- truth (that is what makes it evidence), and what a screen may display is a
-- separate question from what the record must contain.
--
-- ----------------------------------------------------------------------------
-- Also closed here: items and godowns, the other two tables 0760's header
-- named. An item's HSN/SAC and GST rate decide the tax on every future
-- invoice that uses it, and both are edited by hand from the item screens;
-- they get 0008's ordinary row-level trigger, which is the right shape for a
-- master edited one row at a time.
--
-- Partitioning is untouched: this migration adds no column to audit_log,
-- creates no partition, and writes through the parent exactly as
-- app_private.audit_change() has since 0008.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Statement-level, per-voucher logging for a document's line tables.
-- ----------------------------------------------------------------------------
-- Three separate triggers rather than one: Postgres allows transition tables
-- only on a single-event trigger.
--
-- The transition tables are named by hand as audit_old / audit_new and read by
-- static SQL inside the plpgsql body, which is what makes one function serve
-- every line table. Two things this cannot be written as, both tried first:
--   * a `language sql` helper selecting from audit_old — a SQL function body
--     is parse-analysed at CREATE time with no query environment, so the
--     transition table does not resolve and the function will not even be
--     created;
--   * one trigger for all three events — a trigger declaring transition tables
--     may name only a single event.
-- Each branch below is prepared by plpgsql lazily, on first execution of that
-- branch, so the DELETE branch's reference to audit_old costs nothing when the
-- function is invoked from the insert trigger, which never declares it.
--
-- Every line snapshot drops company_id and voucher_id (both already on the
-- audit_log row itself, so repeating them per line is pure bulk) and
-- updated_at (set_updated_at bumps it on every UPDATE, so leaving it in would
-- make a no-op update look like a change). Columns are read out of
-- to_jsonb(t) rather than by name so that a table without a line_order is
-- still handled; item_name is added, resolved at capture time, because an
-- audit entry has to stay readable after the item is renamed or deleted and
-- "item_id: 7f3a…" tells a reviewer nothing.
create or replace function app_private.audit_voucher_lines()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    with lines as (
      select (to_jsonb(t) ->> 'company_id')::uuid as company_id,
             (to_jsonb(t) ->> 'voucher_id')::uuid as voucher_id,
             (to_jsonb(t) ->> 'id')::uuid as line_id,
             (to_jsonb(t) ->> 'line_order')::numeric as ord,
             app_private.audit_line_snapshot(to_jsonb(t)) as snap
        from audit_new t
    )
    insert into public.audit_log (
      company_id, table_name, record_id, operation,
      before_data, after_data, changed_by
    )
    select l.company_id, TG_TABLE_NAME, l.voucher_id, 'INSERT',
           null,
           jsonb_build_object(
             'line_count', count(*),
             'lines', jsonb_agg(l.snap order by l.ord nulls last, l.line_id)
           ),
           auth.uid()
      from lines l
     -- A row with no resolvable company cannot be shown to anyone under RLS,
     -- so recording it would be write-only noise (0008's own rule).
     where l.company_id is not null and l.voucher_id is not null
     group by l.company_id, l.voucher_id;

  elsif TG_OP = 'DELETE' then
    with lines as (
      select (to_jsonb(t) ->> 'company_id')::uuid as company_id,
             (to_jsonb(t) ->> 'voucher_id')::uuid as voucher_id,
             (to_jsonb(t) ->> 'id')::uuid as line_id,
             (to_jsonb(t) ->> 'line_order')::numeric as ord,
             app_private.audit_line_snapshot(to_jsonb(t)) as snap
        from audit_old t
    )
    insert into public.audit_log (
      company_id, table_name, record_id, operation,
      before_data, after_data, changed_by
    )
    select l.company_id, TG_TABLE_NAME, l.voucher_id, 'DELETE',
           jsonb_build_object(
             'line_count', count(*),
             'lines', jsonb_agg(l.snap order by l.ord nulls last, l.line_id)
           ),
           null,
           auth.uid()
      from lines l
     where l.company_id is not null and l.voucher_id is not null
     group by l.company_id, l.voucher_id;

  else
    -- An in-place update of existing lines (a landed-cost allocation, a
    -- moves_stock correction). Grouped on both sides and full-joined, because
    -- an update is allowed to move a line from one voucher to another.
    with old_sets as (
      select (to_jsonb(t) ->> 'company_id')::uuid as company_id,
             (to_jsonb(t) ->> 'voucher_id')::uuid as voucher_id,
             jsonb_build_object(
               'line_count', count(*),
               'lines', jsonb_agg(
                 app_private.audit_line_snapshot(to_jsonb(t))
                 order by (to_jsonb(t) ->> 'line_order')::numeric nulls last,
                          (to_jsonb(t) ->> 'id')::uuid)
             ) as snap
        from audit_old t
       where (to_jsonb(t) ->> 'company_id') is not null
         and (to_jsonb(t) ->> 'voucher_id') is not null
       group by 1, 2
    ), new_sets as (
      select (to_jsonb(t) ->> 'company_id')::uuid as company_id,
             (to_jsonb(t) ->> 'voucher_id')::uuid as voucher_id,
             jsonb_build_object(
               'line_count', count(*),
               'lines', jsonb_agg(
                 app_private.audit_line_snapshot(to_jsonb(t))
                 order by (to_jsonb(t) ->> 'line_order')::numeric nulls last,
                          (to_jsonb(t) ->> 'id')::uuid)
             ) as snap
        from audit_new t
       where (to_jsonb(t) ->> 'company_id') is not null
         and (to_jsonb(t) ->> 'voucher_id') is not null
       group by 1, 2
    )
    insert into public.audit_log (
      company_id, table_name, record_id, operation,
      before_data, after_data, changed_by
    )
    select coalesce(o.company_id, n.company_id),
           TG_TABLE_NAME,
           coalesce(o.voucher_id, n.voucher_id),
           'UPDATE',
           o.snap, n.snap, auth.uid()
      from old_sets o
      full join new_sets n
        on n.company_id = o.company_id and n.voucher_id = o.voucher_id
     -- Nothing of substance changed: updated_at is already out of both
     -- snapshots, so equal snapshots mean a no-op edit, which 0008's
     -- row-level trigger skips too.
     where o.snap is distinct from n.snap;
  end if;

  -- Statement-level trigger: the return value is ignored.
  return null;
end;
$$;

comment on function app_private.audit_voucher_lines is
  'Audit trail for a document''s line table, one audit_log row per voucher per statement rather than one per line — because update_invoice (0055) replaces every line of an invoice on every edit, and 2 x lines rows of delete-then-insert is a record nobody can read. record_id is the VOUCHER id, not a line id; the lines themselves are in before_data/after_data as a `lines` array with a line_count. Reusable as-is by any table carrying company_id, voucher_id and id, provided its triggers name the transition tables audit_old / audit_new. See 1580.';


create or replace function app_private.audit_line_snapshot(p_row jsonb)
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  select (p_row - 'company_id' - 'voucher_id' - 'updated_at')
         || case
              when p_row ? 'item_id' then jsonb_build_object(
                'item_name', (select i.name from public.items i
                               where i.id = (p_row ->> 'item_id')::uuid))
              else '{}'::jsonb
            end;
$$;

comment on function app_private.audit_line_snapshot is
  'One line of a document, as it goes into an audit_log snapshot: the whole row less company_id, voucher_id (both on the audit row already) and updated_at (bumped by set_updated_at on every write, so keeping it would make a no-op update read as a change), plus the item name resolved now so the entry survives a rename or a deleted item. See 1580.';

create trigger audit_lines_insert
  after insert on public.voucher_items
  referencing new table as audit_new
  for each statement execute function app_private.audit_voucher_lines();

create trigger audit_lines_update
  after update on public.voucher_items
  referencing old table as audit_old new table as audit_new
  for each statement execute function app_private.audit_voucher_lines();

create trigger audit_lines_delete
  after delete on public.voucher_items
  referencing old table as audit_old
  for each statement execute function app_private.audit_voucher_lines();


-- ----------------------------------------------------------------------------
-- 2. items and godowns — 0008's row-level trigger, the right shape for a
--    master record edited one row at a time.
-- ----------------------------------------------------------------------------
create trigger audit after insert or update or delete on public.items
  for each row execute function app_private.audit_change();

create trigger audit after insert or update or delete on public.godowns
  for each row execute function app_private.audit_change();


-- ----------------------------------------------------------------------------
-- 3. Redaction, applied on the way out.
-- ----------------------------------------------------------------------------
-- Keyed on the column name and not on the table, so a table that grows one of
-- these columns later — or gains an audit trigger later — is covered without
-- anyone remembering to come back here. Keys are kept in the object with their
-- value replaced, never dropped, so the shape of a snapshot never depends on
-- who is looking at it.
create or replace function app_private.audit_redact(p_data jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_data is null then null
    when jsonb_typeof(p_data) <> 'object' then p_data
    else coalesce(
      (select jsonb_object_agg(e.key,
                case
                  when e.value = 'null'::jsonb then e.value
                  when e.key in (
                    'password_hash', 'token', 'key_hash', 'access_token',
                    'webhook_secret', 'confirm_token'
                  ) then to_jsonb('[redacted]'::text)
                  when e.key in ('bank_account_number', 'print_bank_account_number')
                    then to_jsonb('xxxx' || right(e.value #>> '{}', 4))
                  else e.value
                end)
         from jsonb_each(p_data) e),
      '{}'::jsonb)
  end;
$$;

comment on function app_private.audit_redact is
  'What an audit snapshot may be shown as. Credentials (companies.password_hash — not even in the column allowlist granted to authenticated — company_invites.token, and the secrets on tables that have no audit trigger yet) come back as [redacted]; bank account numbers keep their last four digits, because a supplier''s account being changed is precisely what a reviewer is looking for. The stored row is untouched: this is a display rule, not a retention rule. changed_fields is computed from the raw snapshots, so a change to a redacted column is still reported as a change. See 1580.';


-- ----------------------------------------------------------------------------
-- 4. The reader, now returning the snapshots.
-- ----------------------------------------------------------------------------
-- DROP and CREATE, not CREATE OR REPLACE: two output columns are being added
-- and a RETURNS TABLE signature cannot be replaced in place. Dropping resets
-- privileges to the default, which on a function means EXECUTE to PUBLIC —
-- and anon inherits PUBLIC. The revoke below is therefore not boilerplate;
-- 0064 and 0231 both had to clean this exact footgun up after the fact.
drop function if exists public.get_audit_trail(uuid, timestamptz, timestamptz, text, integer);

create function public.get_audit_trail(
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
  changed_at timestamptz,
  before_data jsonb,
  after_data jsonb
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
    -- Computed from the RAW snapshots, before redaction: a changed
    -- password_hash must still be reported as a changed field even though its
    -- value is never shown.
    case when a.operation = 'UPDATE' then (
      select array_agg(key)
        from jsonb_each(a.after_data)
       where a.before_data -> key is distinct from a.after_data -> key
         and key <> 'updated_at'
    ) end,
    a.derived_note,
    a.changed_by,
    -- 0760: profiles.full_name is null for every account this app has ever
    -- created, so email is the only identifying fact guaranteed to exist. A
    -- row with changed_by null throughout stays "System" — a migration, a
    -- seed, or a maintenance script, exactly as designed.
    coalesce(p.full_name, u.email::text),
    a.changed_at,
    app_private.audit_redact(a.before_data),
    app_private.audit_redact(a.after_data)
  from public.audit_log a
  left join public.profiles p on p.id = a.changed_by
  left join auth.users u on u.id = a.changed_by
  where a.company_id = p_company_id
    and a.changed_at between p_from and p_to
    and (p_table_name is null or a.table_name = p_table_name)
    -- Re-stated rather than left to audit_log_read, because this function is
    -- SECURITY DEFINER (it joins auth.users, which no client may read
    -- directly — same reason 0107's get_company_team needed it). See 0760.
    and (select app_private.user_role_in_company(p_company_id)) in ('admin','auditor')
  order by a.changed_at desc,
    -- Everything one transaction wrote shares a changed_at, now() being the
    -- transaction timestamp. Without a tiebreaker the delete-then-insert pair
    -- that an invoice edit produces would come back in an arbitrary order;
    -- this puts the old set above the new one, every time.
    a.table_name,
    case a.operation when 'DELETE' then 0 when 'UPDATE' then 1 else 2 end,
    a.id
  limit least(p_limit, 1000);
$$;

revoke all on function public.get_audit_trail(uuid, timestamptz, timestamptz, text, integer) from public, anon;
grant execute on function public.get_audit_trail(uuid, timestamptz, timestamptz, text, integer) to authenticated;

comment on function public.get_audit_trail is
  'The audit trail, admin/auditor only (re-checked in the body, not left to RLS alone, because this function is SECURITY DEFINER). Returns the before/after snapshots the trigger has captured since 0008 and this reader discarded until 1580 — passed through app_private.audit_redact, which blanks credentials and masks bank account numbers. changed_fields is computed from the unredacted snapshots. For voucher_items the row is per VOUCHER per statement, not per line: record_id is the voucher and the lines are in the snapshot. "Who" resolves to profiles.full_name, falling back to auth.users.email (see 0760).';
