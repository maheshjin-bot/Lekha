-- ============================================================================
-- 1520 — Two core-integrity defects: a per-branch statement that counted the
--        company's opening balances once per branch, and a period lock that
--        held on the voucher header while leaving its lines wide open
-- ============================================================================
-- Numbered 1520 rather than 1400: 1400-1501 exist in the main checkout,
-- untracked in git but applied to the live database. Nothing in this file
-- keys on a filename; the number is only here so the two trees reconcile
-- without a collision.
--
-- Both halves were confirmed against pg_get_functiondef / pg_trigger on the
-- live database before a line of this file was written, not taken on trust
-- from a report. The evidence is quoted inline under each part.
--
--
-- ============================================================================
-- PART 1 — app_private.ledger_opening_signed branch-filtered the movements
--          but not the opening balance
-- ============================================================================
-- WHAT WAS WRONG. The helper (0009) is the shared arithmetic behind
-- get_trial_balance, get_ledger_statement, get_balance_sheet and
-- get_ledger_opening_balance (1270). It is two terms added together:
--
--   1. the ledger's own opening_balance_amount, signed;
--   2. every posted, non-deleted voucher_entries line strictly before the
--      cutoff.
--
-- Term 2 honoured p_branch_id. Term 1 did not — it read
-- public.ledgers.opening_balance_amount off the row and added it whole,
-- whatever branch was asked for. So the company's entire opening position
-- landed in EVERY branch's statement.
--
-- LIVE PROOF, Sharma Textiles (the only company in the project with two
-- branches: Head Office and Mumbai Branch), balance sheet as at 2 Sep 2026,
-- read as tester@lekha.test with RLS on:
--
--                             assets        liabilities
--   consolidated          27,14,676.32     19,08,412.82
--   Head Office only      26,94,676.32     19,08,412.82
--   Mumbai Branch only       77,500.00             0.00
--   ------------------------------------------------------
--   HO + Mumbai           27,72,176.32     19,08,412.82
--   over-statement            57,500.00
--
-- 57,500.00 is exactly the sum of that company's two opening balances
-- (Chennai Overseas Facilitators 12,500.00 Dr + Lonestar Apparel Imports LLC
-- 45,000.00 Dr). Per ledger, before this migration:
--
--   Chennai Overseas Facilitators   consolidated 12,500  HO 12,500  MUM 12,500
--   Lonestar Apparel Imports LLC    consolidated 45,000  HO 45,000  MUM 45,000
--
-- Neither party has ever been posted to from Mumbai Branch — Mumbai carries
-- 11 entries totalling 2,00,000.00 Dr / 2,00,000.00 Cr, none of them touching
-- either ledger — and both still appeared on the Mumbai balance sheet at full
-- value. With N branches the openings are counted N times across the set.
--
-- Why it went unnoticed: the consolidated statement (p_branch_id null) is
-- correct, because term 1 is then meant to be counted once and is. A prior
-- session verified that no voucher anywhere in this project splits its lines
-- across branches, which is what kept every aggregate right. Only the
-- per-branch view was wrong, and only one company can see it.
--
-- ----------------------------------------------------------------------------
-- THE DESIGN DECISION, AND WHY IT IS ONE
-- ----------------------------------------------------------------------------
-- This is not a missing predicate. An opening balance in this schema has no
-- branch dimension AT ALL: public.ledgers carries opening_balance_amount and
-- opening_balance_type and no branch_id, and there is no per-branch opening
-- balance table, column or entry screen anywhere. Nobody has ever told this
-- application which branch an opening balance belongs to. So the question is
-- not "which rows did we forget to filter" but "what should a per-branch
-- statement say about a company-level fact".
--
-- Three answers were possible. The one chosen is (a).
--
--   (a) ATTRIBUTE THE WHOLE OPENING BALANCE TO THE HEAD OFFICE.  <-- CHOSEN
--       A per-branch statement is only meaningful if the set of them adds up
--       to the consolidated one. That is the single property this defect
--       destroys and the single property the fix must restore. Head office is
--       the one branch that can carry a company-level fact without inventing
--       anything: it is where the books are kept, it is where a brought-
--       forward balance sits in every branch-accounting convention, and it is
--       already the fallback this application reaches for when something is a
--       company fact needing a place to live (0108 reads the head office
--       branch for professional-tax registration for exactly this reason).
--
--       It is also TOTAL and UNAMBIGUOUS, which matters for a helper called
--       once per ledger per report. 0005 guarantees both halves of that:
--       `branches_one_head_office_idx` is a unique partial index on
--       (company_id) where is_head_office, so there can never be two; and
--       `guard_head_office` refuses to delete or deactivate the last one, so
--       there is always exactly one and it is always active. Verified live:
--       all 16 companies have exactly one, all is_active. No null case, no
--       tie-break, no coalesce.
--
--   (b) EXCLUDE OPENINGS FROM EVERY PER-BRANCH STATEMENT AND SAY SO.
--       Rejected. It makes each per-branch balance sheet fail to balance —
--       assets would differ from liabilities-plus-equity by whatever the
--       excluded openings netted to — and makes the parts add up to LESS than
--       the whole instead of more. Trading a statement that is overstated for
--       a statement that does not balance is not an improvement, and a
--       caption explaining why a balance sheet does not balance is not a
--       feature.
--
--   (c) APPORTION THE OPENING ACROSS BRANCHES PRO-RATA BY ACTIVITY.
--       Rejected outright. It would invent a figure no human entered, and the
--       figure would silently change every time an unrelated voucher was
--       posted at another branch. Restating last year's opening position
--       because someone billed something in Mumbai today is not accounting.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MEANS FOR A READER, STATED PLAINLY
-- ----------------------------------------------------------------------------
--   * The CONSOLIDATED statement (no branch selected) is unchanged, to the
--     paisa. Nothing about the company-level trial balance, profit and loss
--     or balance sheet moves.
--   * A NON-HEAD-OFFICE branch statement now shows only what has actually
--     been posted at that branch since the books opened. Sharma Textiles'
--     Mumbai Branch balance sheet drops from 77,500.00 of assets to
--     20,000.00 — the 57,500.00 that leaves was never Mumbai's; it is the
--     company's brought-forward receivable from two parties Mumbai has never
--     traded with.
--   * The HEAD OFFICE statement carries the company's whole brought-forward
--     opening position on top of head office's own postings. That is a
--     convention, and it is the convention this file chose. A head office
--     statement is therefore NOT "head office as a standalone business"; it
--     is "head office, plus everything the company brought forward before it
--     started distinguishing branches". Anyone reading a single branch
--     statement as a standalone entity needs to know that, which is why it is
--     written down here and in the function comment rather than left implicit.
--   * The set of per-branch statements now sums exactly to the consolidated
--     one. That is asserted as a read-only invariant test (tests/db) so a
--     future regression fails a gate instead of a statement.
--
-- This changes NO row of company data. No voucher entry is created, moved or
-- re-tagged; no opening balance is edited. It is a reporting-attribution rule
-- and nothing else.
--
-- SCOPE. Eleven other callers pass p_branch_id => null (dashboard KPIs, CMA
-- ratios, deferred tax, GST set-off legs, bank reconciliation, depreciation,
-- closing stock, QIS actuals, related-party note, GSTR-3B 6.1, fixed-asset
-- reconciliation). The new predicate is only consulted when p_branch_id is
-- NOT null, so every one of them is byte-for-byte unaffected. The four that
-- do pass a branch through — get_balance_sheet, get_trial_balance,
-- get_ledger_statement, get_ledger_opening_balance — are all fixed by this
-- one helper, which is why the fix belongs here and not in four places.
--
-- A branch id belonging to a DIFFERENT company (a nonsense argument) excludes
-- the opening rather than including it: the predicate requires
-- b.company_id = p_company_id, so a wrong branch cannot smuggle another
-- company's opening balance into a statement.
--
-- RLS. The helper is SECURITY INVOKER and stays that way. public.branches has
-- a `branches_read` policy of is_company_member — the same predicate as
-- `ledgers_read`, which term 1 already depended on — so this adds no new
-- visibility requirement. Note branches_read is company-wide and deliberately
-- not narrowed by member_branches, so a member scoped to one branch can still
-- resolve which branch is head office; they simply cannot read the other
-- branch's entries, which is unchanged.
--
--
-- ============================================================================
-- PART 2 — the period lock held the voucher header and nothing under it
-- ============================================================================
-- WHAT THE APP PROMISES. /year-end says, in its own words:
--
--   "Closing a period locks every voucher dated on or before it — nothing can
--    be added, edited, or deleted there, by anyone, including an admin."
--
-- WHAT WAS TRUE. `enforce_period_open` (0007) is attached to public.vouchers
-- and to nothing else. Confirmed from pg_trigger:
--
--   vouchers         audit, enforce_period_open, release_payroll_posting,
--                    set_updated_at
--   voucher_entries  audit, set_updated_at, trg_voucher_entries_allocations,
--                    trg_voucher_entries_balance
--   voucher_items    enforce_stock_item, set_updated_at
--
-- Neither child table consults the lock. Both are directly writable: role
-- `authenticated` holds INSERT/UPDATE/DELETE on both, gated only by
-- can_write_company AND can_access_branch. So any admin or accountant could
-- rewrite a closed period's amounts straight from PostgREST while the voucher
-- header stayed untouched — and untouched means unaudited, because the audit
-- trigger fires on the row that changed, and the header did not change.
--
-- LIVE PROOF, before this migration. TEST Rangoli Spice Works Pvt Ltd,
-- lock_date set to 30 Jun 2026, acting as a freshly added NON-ADMIN member
-- (role 'accountant'), RLS on, deferred constraint triggers forced IMMEDIATE
-- so nothing hid behind the rollback. Target: HO/SAL/2026-27/00001, dated
-- 15 Jun 2026, i.e. two weeks inside the lock. Everything below ran in one
-- transaction that was rolled back, so no lock_date and no member row
-- survived the test.
--
--   voucher_entries.ledger_id 'Sales - Spices & Masala' -> 'Discount
--     Received'                                              ALLOWED
--   voucher_entries amounts + narration rewritten, one
--     statement, debit total preserved                       ALLOWED
--   voucher_items quantity 100 -> 1, rate 118.00 -> 1.00,
--     hsn_sac 09103020 -> 99999999                           ALLOWED
--   voucher_items row deleted outright                       ALLOWED
--   vouchers.narration (control)                             REFUSED
--   vouchers.voucher_date 15 Jun (locked) -> 20 Aug (open)   ALLOWED
--
-- The first line is the one that matters most: revenue silently reclassified
-- as a discount inside a closed period, with the voucher header, its
-- total_amount and the audit trail on it all completely unchanged.
--
-- EXPOSURE TODAY IS ZERO, and that was verified rather than assumed: every
-- one of the 16 companies in the live project has lock_date null, so no
-- period is closed anywhere and nothing can have been altered through this
-- hole yet. It is still a real hole, and the sentence on the Year-end screen
-- was still false.
--
-- ----------------------------------------------------------------------------
-- WHY THE EXISTING BALANCE TRIGGER WAS NOT ALREADY ENOUGH
-- ----------------------------------------------------------------------------
-- Worth writing down, because it is the reason this looked safe. Writing to
-- voucher_entries fires the deferred `trg_voucher_entries_balance`, which
-- calls app_private.check_voucher_balance, which ends with
--
--   update public.vouchers set total_amount = v_debit
--    where id = p_voucher_id and total_amount is distinct from v_debit;
--
-- If that UPDATE happens it fires enforce_period_open on vouchers and the
-- write is refused. So a closed-period edit that CHANGES the voucher's debit
-- total was already caught, by accident, at commit. But the `is distinct
-- from` means a TOTAL-PRESERVING edit updates nothing and is checked by
-- nothing — and total-preserving is exactly the damaging class: repointing a
-- line at a different ledger, moving it to a different branch, rewriting its
-- dimensions or narration, or swapping amounts between two lines. The live
-- proof above is all total-preserving.
--
-- voucher_items is worse still: it has no balance trigger, no allocation
-- trigger and, notably, no audit trigger either. Its quantities, rates,
-- discounts and HSN codes are what GSTR-1 Table 12 and the e-invoice payload
-- are built from, and they were reachable with no check of any kind.
--
-- ----------------------------------------------------------------------------
-- THE FIX, AND WHY IT DOES NOT BREAK THE LEGITIMATE REWRITE PATHS
-- ----------------------------------------------------------------------------
-- One BEFORE INSERT/UPDATE/DELETE row trigger on each child table, reading
-- the date from the PARENT voucher and consulting the SAME
-- app_private.is_period_open that the header trigger uses. One lock, one
-- predicate, two more tables — not a second notion of "closed".
--
-- update_voucher (0007/0011), update_invoice (0055) and delete_voucher (0052)
-- were all read in full before this was written, because all three rewrite
-- children wholesale by design:
--
--   update_voucher   UPDATEs vouchers first, then deletes and reinserts every
--                    voucher_entries row.
--   update_invoice   deletes voucher_items and voucher_entries FIRST, then
--                    UPDATEs vouchers, then reinserts both.
--   delete_voucher   a soft delete: it only sets vouchers.is_deleted, and
--                    never touches a child row at all.
--
-- When the period is OPEN the new trigger is a no-op for all three: it asks
-- is_period_open, gets true, and returns. Nothing about an ordinary edit
-- changes. When the period is CLOSED all three were already refused and all
-- three still are — update_voucher and delete_voucher at their UPDATE on
-- vouchers, update_invoice now at its first child DELETE instead, one
-- statement earlier and with a message that names the voucher. No legitimate
-- behaviour is lost in either direction, which is the thing that had to be
-- true and was tested in both.
--
-- CASCADE SAFETY, the bug this repo has shipped three times. voucher_entries
-- and voucher_items both reference vouchers ON DELETE CASCADE, and vouchers
-- cascades from companies. By the time RI reaches a child row its parent
-- voucher is already gone from the snapshot, so the trigger looks the parent
-- up and RETURNS EARLY when it is not there rather than raising. Without
-- that, `delete from companies` — and delete_company (0010) with it — would
-- be blocked forever by a guard defending rows that no longer have anything
-- to defend. is_period_open independently returns true when the company row
-- itself is gone, so the company-teardown path is safe twice over.
--
-- ----------------------------------------------------------------------------
-- ALSO FIXED HERE: enforce_period_open only ever tested the NEW date
-- ----------------------------------------------------------------------------
-- Found while reading 0007 to write the child trigger, and confirmed live as
-- the last line of the proof table above. The function computed
--
--   v_date date := coalesce(new.voucher_date, old.voucher_date);
--
-- On UPDATE, new.voucher_date is NOT NULL, so old.voucher_date was never
-- consulted: a voucher sitting inside the lock could simply be given a date
-- outside it. With a mid-year lock — which the Year-end screen lets a user
-- set on any date, and monthly or quarterly closes are ordinary practice —
-- that is a complete bypass of the lock for the header AND, without it being
-- fixed, for the child trigger this migration adds, since the child reads the
-- parent's date.
--
-- Now both ends of an UPDATE must be open. The message text is unchanged so
-- anything matching on it still matches, and it names whichever date was the
-- closed one. Nothing legitimate is affected: no RPC in this application
-- updates a voucher that is inside the lock — every one of them (approve_
-- voucher, delete_voucher, update_voucher, update_invoice, record_forex_
-- settlement, record_forex_revaluation, and check_voucher_balance's own
-- total_amount write) was already refused when the voucher's own date was
-- closed, because old and new were equal and the new date was tested.
--
-- ----------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT LOCKED: voucher_allocations (1490)
-- ----------------------------------------------------------------------------
-- Checked, because it is the third table hanging off vouchers and it is
-- equally client-writable. It is left alone ON PURPOSE, and that is a
-- decision rather than an omission:
--
--   * An allocation posts nothing. It is a (settlement voucher, bill voucher,
--     party ledger, amount) edge saying which receipt paid which bill. Delete
--     every row in that table and the trial balance, the profit and loss and
--     the balance sheet are byte-identical. There is no closed-period figure
--     for it to change.
--   * It carries no date of its own, so there is no period it could be "in".
--     The only two dates available belong to the two vouchers it links, and
--     both of the obvious rules are wrong: locking on the BILL's date would
--     make it impossible to allocate today's receipt against last year's
--     invoice, which is not merely legitimate but the single most common
--     thing bill-wise allocation exists to do; and locking on the
--     SETTLEMENT's date adds nothing, because a settlement voucher inside the
--     lock could not have been created there in the first place.
--   * Its amount invariants are already owned by
--     app_private.enforce_voucher_allocation, and they bound allocations by
--     the underlying vouchers' own movements on the party ledger — so an
--     allocation can never assert more settlement than the locked books
--     actually contain.
--
-- Two other live period-protection mechanisms were read before writing this
-- so as to extend rather than contradict them:
-- release_payroll_posting_on_voucher_delete (1441) frees a payroll month when
-- its voucher is soft-deleted, and the salary-structure guard (1471) refuses a
-- revision that would restate an already-posted month. Both key off
-- payroll_postings, not companies.lock_date; neither touches voucher_entries
-- or voucher_items. They are orthogonal to this file and unaffected by it.
--
-- NOT DONE, and named so it is not mistaken for done: voucher_items still has
-- no audit trigger, so a line-level edit in an OPEN period is still not in
-- audit_log the way a voucher_entries edit is. That is a real Rule 3(1) gap
-- with its own storage and volume consequences (one audit row per invoice line
-- on every save), and it is a separate change from making the lock hold.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- PART 1 — the opening balance belongs to the head office
-- ----------------------------------------------------------------------------
-- Only term 1 changes. Term 2 is byte-identical to 0009.
create or replace function app_private.ledger_opening_signed(
  p_company_id uuid,
  p_ledger_id uuid,
  p_before date,
  p_branch_id uuid
) returns numeric
language sql
stable
set search_path = ''
as $$
  select
    -- Term 1: the ledger's own opening balance. A company-level fact with no
    -- branch dimension in the schema, so a per-branch statement attributes it
    -- to the head office and a consolidated one (p_branch_id null) counts it
    -- once, exactly as before. See 1520 PART 1 for why head office and not
    -- an exclusion or an apportionment.
    coalesce((select case when l.opening_balance_type = 'debit'
                         then l.opening_balance_amount else -l.opening_balance_amount end
                from public.ledgers l
               where l.id = p_ledger_id
                 and (
                   p_branch_id is null
                   or exists (
                     select 1 from public.branches b
                      where b.id = p_branch_id
                        and b.company_id = p_company_id
                        and b.is_head_office
                   )
                 )), 0)
    -- Term 2: every posted, non-deleted line strictly before the cutoff.
    -- This half always honoured p_branch_id.
    + coalesce((select sum(e.debit_amount - e.credit_amount)
                  from public.voucher_entries e
                  join public.vouchers v on v.id = e.voucher_id
                 where e.company_id = p_company_id
                   and e.ledger_id = p_ledger_id
                   and not v.is_deleted
                   and v.voucher_date < p_before
                   and (p_branch_id is null or e.branch_id = p_branch_id)), 0);
$$;

comment on function app_private.ledger_opening_signed(uuid, uuid, date, uuid) is
  'Signed opening balance of a ledger as at p_before (positive = net debit): the ledger''s own opening balance plus every posted, non-deleted entry strictly before that date. With p_branch_id null this is the company-wide figure. With a branch, the ENTRIES are filtered to that branch and the ledger''s OPENING BALANCE is attributed entirely to the company''s head office branch — an opening balance is a company-level fact with no branch dimension anywhere in the schema, and head office is where it is carried so that the set of per-branch statements sums exactly to the consolidated one. A non-head-office branch statement therefore shows only what has been posted at that branch since the books opened. Before 1520 the opening balance was added to every branch unfiltered, overstating each per-branch statement by the company''s whole opening position. See 1520 PART 1.';


-- ----------------------------------------------------------------------------
-- PART 2a — the lock, on the lines and not just the header
-- ----------------------------------------------------------------------------
-- Shared by voucher_entries and voucher_items: both hang off a voucher by
-- (voucher_id, company_id) and both take their period from that voucher's
-- date. TG_TABLE_NAME only ever picks the noun in the message.
create or replace function app_private.enforce_period_open_voucher_line()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_new_voucher uuid;
  v_old_voucher uuid;
  v_voucher_id uuid;
  v_company_id uuid;
  v_date date;
  v_number text;
  v_lock date;
  v_noun text := case TG_TABLE_NAME
                   when 'voucher_items' then 'item lines'
                   else 'ledger entries'
                 end;
begin
  -- OLD and NEW are addressed only where they exist, rather than leaning on
  -- coalesce(new.x, old.x) across all three operations.
  if TG_OP = 'INSERT' then
    v_new_voucher := new.voucher_id;
  elsif TG_OP = 'DELETE' then
    v_old_voucher := old.voucher_id;
  else
    v_new_voucher := new.voucher_id;
    -- An UPDATE that re-points a line at a different voucher has to satisfy
    -- the lock at BOTH ends: it removes an amount from one document and adds
    -- it to another. When it is the same voucher there is only one thing to
    -- check.
    if old.voucher_id is distinct from new.voucher_id then
      v_old_voucher := old.voucher_id;
    end if;
  end if;

  for v_voucher_id in
    select x from unnest(array[v_new_voucher, v_old_voucher]) as t(x) where x is not null
  loop
    select v.company_id, v.voucher_date, v.voucher_number
      into v_company_id, v_date, v_number
      from public.vouchers v
     where v.id = v_voucher_id;

    -- The parent is already gone: this row is being cascaded away by the
    -- deletion of its voucher, or of the whole company. There is nothing left
    -- to protect and raising here would block ON DELETE CASCADE outright.
    if not found then
      continue;
    end if;

    if not app_private.is_period_open(v_company_id, v_date) then
      select c.lock_date into v_lock from public.companies c where c.id = v_company_id;
      raise exception
        'The books are closed up to and including %; voucher % is dated % and its % cannot be added, changed or removed. Reopen the period on the Year-end screen first.',
        to_char(v_lock, 'DD Mon YYYY'), v_number, to_char(v_date, 'DD Mon YYYY'), v_noun;
    end if;
  end loop;

  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function app_private.enforce_period_open_voucher_line is
  'Applies companies.lock_date to voucher_entries and voucher_items, taking the date from the parent voucher and asking the same app_private.is_period_open that enforce_period_open asks on the header. Before 1520 the lock was attached to public.vouchers alone, so a closed period''s amounts, ledger allocations, quantities, rates and HSN codes could be rewritten straight from PostgREST by any admin or accountant while the voucher header stayed untouched and therefore unaudited. Returns early when the parent voucher is already gone, so ON DELETE CASCADE from vouchers or companies is never blocked. See 1520 PART 2.';

-- Trigger name matches the header's, and sorts before set_updated_at and
-- enforce_stock_item, so the lock is the first thing consulted on either
-- table.
drop trigger if exists enforce_period_open on public.voucher_entries;
create trigger enforce_period_open
  before insert or update or delete on public.voucher_entries
  for each row execute function app_private.enforce_period_open_voucher_line();

drop trigger if exists enforce_period_open on public.voucher_items;
create trigger enforce_period_open
  before insert or update or delete on public.voucher_items
  for each row execute function app_private.enforce_period_open_voucher_line();


-- ----------------------------------------------------------------------------
-- PART 2b — an UPDATE must satisfy the lock at both dates, not just the new one
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_period_open()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  v_company uuid := case TG_OP when 'DELETE' then old.company_id else new.company_id end;
begin
  -- INSERT and UPDATE: the date the voucher is being given.
  if TG_OP <> 'DELETE' and not app_private.is_period_open(v_company, new.voucher_date) then
    raise exception 'The books are locked on or before this date; % is in a closed period', new.voucher_date;
  end if;

  -- UPDATE and DELETE: the date the voucher already has. Untested from 0007
  -- until 1520, because voucher_date is NOT NULL and so
  -- coalesce(new.voucher_date, old.voucher_date) never reached old on an
  -- UPDATE. That let a voucher inside the lock be given a date outside it,
  -- which is a complete bypass whenever the lock is mid-year.
  if TG_OP <> 'INSERT' and not app_private.is_period_open(v_company, old.voucher_date) then
    raise exception 'The books are locked on or before this date; % is in a closed period', old.voucher_date;
  end if;

  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function app_private.enforce_period_open is
  'Applies companies.lock_date to public.vouchers. An INSERT or UPDATE must have an open new date; an UPDATE or DELETE must also have an open OLD date — before 1520 only the new date was ever tested, so a voucher inside the lock could be dated out of it. The lock is a property of the voucher date, not of the user: an admin cannot post into a closed period either. voucher_entries and voucher_items are held by app_private.enforce_period_open_voucher_line (1520).';
