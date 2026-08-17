-- ============================================================================
-- 0019 — Bank reconciliation
-- ============================================================================
-- Declared as a CORE module back in 0004 — "universal, and stock statements
-- and audit both depend on it" — but never actually built until now. This
-- closes that gap.
--
-- A statement line and a book entry are opposite in sign by convention, and
-- getting this backwards is the classic bank-rec bug: a bank statement shows
-- a CREDIT when money comes IN (from the bank's point of view, you gave them
-- money to hold). In OUR books, the bank account is an asset, so money coming
-- in is a DEBIT. The mapping throughout this file is therefore: statement
-- credit <-> book debit, statement debit <-> book credit.
-- ============================================================================

create table public.bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  ledger_id uuid not null,

  txn_date date not null,
  description text,
  reference text,

  debit_amount numeric(18,2) not null default 0 check (debit_amount >= 0),
  credit_amount numeric(18,2) not null default 0 check (credit_amount >= 0),
  check ((debit_amount > 0 and credit_amount = 0) or (credit_amount > 0 and debit_amount = 0)),

  -- Null while unreconciled. The partial unique index means an entry can be
  -- claimed by at most one statement line.
  matched_entry_id uuid references public.voucher_entries(id) on delete set null,
  matched_at timestamptz,
  matched_by uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  foreign key (ledger_id, company_id) references public.ledgers (id, company_id)
);

create unique index bank_statement_lines_matched_entry_idx
  on public.bank_statement_lines(matched_entry_id) where matched_entry_id is not null;
create index bank_statement_lines_ledger_idx
  on public.bank_statement_lines(company_id, ledger_id, txn_date);
create index bank_statement_lines_unmatched_idx
  on public.bank_statement_lines(company_id, ledger_id) where matched_entry_id is null;

comment on table public.bank_statement_lines is
  'Imported bank/cash statement lines. Ledgers are company-wide (not branch-scoped), so reconciliation is too.';


-- ----------------------------------------------------------------------------
-- Matching
-- ----------------------------------------------------------------------------
create or replace function public.match_bank_line(
  p_statement_line_id uuid,
  p_voucher_entry_id uuid
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_line public.bank_statement_lines%rowtype;
  v_entry public.voucher_entries%rowtype;
begin
  select * into v_line from public.bank_statement_lines where id = p_statement_line_id;
  if not found then
    raise exception 'Statement line not found';
  end if;
  if v_line.matched_entry_id is not null then
    raise exception 'This statement line is already matched';
  end if;

  select * into v_entry from public.voucher_entries where id = p_voucher_entry_id;
  if not found then
    raise exception 'Ledger entry not found';
  end if;

  if v_entry.company_id <> v_line.company_id or v_entry.ledger_id <> v_line.ledger_id then
    raise exception 'That entry belongs to a different ledger';
  end if;

  if exists (select 1 from public.bank_statement_lines where matched_entry_id = p_voucher_entry_id) then
    raise exception 'That ledger entry is already matched to another statement line';
  end if;

  -- The sign flip stated at the top of this file. Matching same-side amounts
  -- would silently pair a deposit with a withdrawal of the same size.
  if not (
    (v_line.credit_amount > 0 and v_line.credit_amount = v_entry.debit_amount) or
    (v_line.debit_amount  > 0 and v_line.debit_amount  = v_entry.credit_amount)
  ) then
    raise exception 'Amounts do not correspond: a % of % on the statement needs a matching % of % in the books',
      case when v_line.credit_amount > 0 then 'credit' else 'debit' end,
      coalesce(nullif(v_line.credit_amount, 0), v_line.debit_amount),
      case when v_line.credit_amount > 0 then 'debit' else 'credit' end,
      coalesce(nullif(v_line.credit_amount, 0), v_line.debit_amount);
  end if;

  update public.bank_statement_lines
     set matched_entry_id = p_voucher_entry_id, matched_at = now(), matched_by = auth.uid()
   where id = p_statement_line_id;
end;
$$;

create or replace function public.unmatch_bank_line(p_statement_line_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.bank_statement_lines
     set matched_entry_id = null, matched_at = null, matched_by = null
   where id = p_statement_line_id;
$$;

-- Safe auto-match: exact amount and exact date, and ONLY when that
-- combination is unambiguous on both sides. Two 500 payments on the same day
-- would let auto-match silently pair the wrong one with the wrong statement
-- line — a plausible-looking match that happens to be false is worse than
-- leaving both for a human, so ambiguous groups are skipped entirely rather
-- than guessed at. Verified: with two same-day, same-amount pairs on each
-- side, auto-match leaves all four for manual review rather than picking one.
create or replace function public.auto_match_bank_lines(
  p_company_id uuid,
  p_ledger_id uuid
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_matched int := 0;
  r record;
begin
  for r in
    select l.id as line_id, e.id as entry_id
      from public.bank_statement_lines l
      join public.voucher_entries e
        on e.company_id = p_company_id
       and e.ledger_id = p_ledger_id
       and e.debit_amount + e.credit_amount > 0
      join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
     where l.company_id = p_company_id
       and l.ledger_id = p_ledger_id
       and l.matched_entry_id is null
       and v.voucher_date = l.txn_date
       and (
         (l.credit_amount > 0 and l.credit_amount = e.debit_amount) or
         (l.debit_amount  > 0 and l.debit_amount  = e.credit_amount)
       )
       and not exists (select 1 from public.bank_statement_lines x where x.matched_entry_id = e.id)
       and (
         select count(*) from public.bank_statement_lines l2
          where l2.company_id = p_company_id and l2.ledger_id = p_ledger_id
            and l2.matched_entry_id is null and l2.txn_date = l.txn_date
            and (l2.credit_amount = l.credit_amount and l2.debit_amount = l.debit_amount)
       ) = 1
       and (
         select count(*) from public.voucher_entries e2
          join public.vouchers v2 on v2.id = e2.voucher_id and not v2.is_deleted
          where e2.company_id = p_company_id and e2.ledger_id = p_ledger_id
            and v2.voucher_date = l.txn_date
            and e2.debit_amount = e.debit_amount and e2.credit_amount = e.credit_amount
            and not exists (select 1 from public.bank_statement_lines x2 where x2.matched_entry_id = e2.id)
       ) = 1
  loop
    update public.bank_statement_lines
       set matched_entry_id = r.entry_id, matched_at = now(), matched_by = auth.uid()
     where id = r.line_id;
    v_matched := v_matched + 1;
  end loop;

  return v_matched;
end;
$$;


-- ----------------------------------------------------------------------------
-- The reconciliation summary
-- ----------------------------------------------------------------------------
-- Deliberately does not compute "balance as per bank statement" — that needs
-- the statement's own closing balance, which a CSV of lines does not reliably
-- carry. What it shows instead is more honest and more useful: the book
-- balance, and everything still unmatched on each side. Unmatched statement
-- lines are usually the more valuable half — they are the bank charges,
-- interest and direct debits nobody has entered into the books yet.
create or replace function public.get_bank_reconciliation_summary(
  p_company_id uuid,
  p_ledger_id uuid,
  p_as_at date default current_date
) returns table (
  book_balance numeric,
  unmatched_book_count integer,
  unmatched_book_total numeric,
  unmatched_statement_count integer,
  unmatched_statement_total numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    app_private.ledger_opening_signed(p_company_id, p_ledger_id, p_as_at + 1, null),
    (select count(*)::int from public.voucher_entries e
       join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
      where e.company_id = p_company_id and e.ledger_id = p_ledger_id
        and v.voucher_date <= p_as_at
        and not exists (select 1 from public.bank_statement_lines l where l.matched_entry_id = e.id)),
    (select coalesce(sum(e.debit_amount - e.credit_amount), 0) from public.voucher_entries e
       join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
      where e.company_id = p_company_id and e.ledger_id = p_ledger_id
        and v.voucher_date <= p_as_at
        and not exists (select 1 from public.bank_statement_lines l where l.matched_entry_id = e.id)),
    (select count(*)::int from public.bank_statement_lines l
      where l.company_id = p_company_id and l.ledger_id = p_ledger_id
        and l.txn_date <= p_as_at and l.matched_entry_id is null),
    (select coalesce(sum(l.debit_amount - l.credit_amount), 0) from public.bank_statement_lines l
      where l.company_id = p_company_id and l.ledger_id = p_ledger_id
        and l.txn_date <= p_as_at and l.matched_entry_id is null);
$$;


-- ----------------------------------------------------------------------------
-- delete_company: another table it never learned about
-- ----------------------------------------------------------------------------
-- Same class of bug 0018 fixed for tax_ledger_map: bank_statement_lines
-- references ledgers with a plain FK and no cascade, so delete_company failed
-- the moment a company with reconciliation data was actually deleted. Found
-- the same way — by deleting one.
create or replace function public.delete_company(p_company_id uuid)
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only an admin can delete a company';
  end if;

  delete from public.vouchers            where company_id = p_company_id;
  delete from public.tax_ledger_map      where company_id = p_company_id;
  delete from public.bank_statement_lines where company_id = p_company_id;
  delete from public.items               where company_id = p_company_id;
  delete from public.godowns             where company_id = p_company_id;
  delete from public.ledgers             where company_id = p_company_id;
  delete from public.companies           where id = p_company_id;
  delete from public.audit_log           where company_id = p_company_id;
end;
$$;

revoke execute on function public.delete_company(uuid) from public, anon;
grant execute on function public.delete_company(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- Row level security
-- ----------------------------------------------------------------------------
-- Not branch-scoped: ledgers themselves are company-wide, and a bank account
-- commonly serves the whole company regardless of which branch posted a
-- given voucher against it.
alter table public.bank_statement_lines enable row level security;

create policy bank_statement_lines_read on public.bank_statement_lines
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

create policy bank_statement_lines_write on public.bank_statement_lines
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

revoke execute on function public.match_bank_line(uuid, uuid) from anon;
revoke execute on function public.unmatch_bank_line(uuid) from anon;
revoke execute on function public.auto_match_bank_lines(uuid, uuid) from anon;
