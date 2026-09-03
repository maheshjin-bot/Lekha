-- ============================================================================
-- 1490 — Bill-by-bill allocation: a receipt can finally point at the invoice
--        it actually settles
-- ============================================================================
-- WHY. A pilot opened a brand-new company, traded it for a month with four
-- preparers and closed it. Every invoice raised in that month reported as
-- fully unpaid. TEST Kanha Retail Stores paid SAL/26-27/0001 in full on
-- 20 Sep 2026 — the preparer even wrote "Receipt from Kanha Retail against
-- SAL/26-27/0001" in the narration, because the narration was the only place
-- the app let them say it — and /reports/outstanding still showed 61,425.00
-- of that invoice sitting in the 0-30 bucket, while 3,18,535.00 of opening
-- balance was reported as the thing the money had gone to.
--
-- That is not a display bug. get_party_outstanding (0017) says so in its own
-- header: "This is NOT bill-wise allocation — a receipt pointing at the
-- specific invoices it settles, which real accounting eventually needs. When
-- that arrives, this function becomes the fallback for parties that have not
-- been explicitly allocated rather than being replaced." This migration is
-- that arrival, built exactly the way 0017 said it should be: FIFO is kept,
-- demoted to the fallback for money nobody has pointed anywhere.
--
-- The consequences reach past the receivables screen. The MSME Sec 43B(h)
-- position, the Schedule III ageing note and the Rule 37 180-day ITC reversal
-- all ask "is THIS document still unpaid", and all three were answering from
-- a FIFO guess. 1491 (next file) points them at the one shared answer this
-- migration creates.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS LOOKED FOR FIRST, AND WHY NOTHING EXISTING WAS REUSED
-- ---------------------------------------------------------------------------
-- Checked before inventing a table:
--   * voucher_entries.dimensions (jsonb, 0007) — the "avoids a schema change
--     per dimension" hook cost centres (0057) uses. Rejected: an allocation
--     is a MANY-TO-MANY fact (one receipt across three invoices, one invoice
--     settled by two receipts, each with its own amount). A per-line jsonb
--     tag can carry one key, not an amount-bearing edge set, and nothing
--     could then enforce "the parts never exceed the whole".
--   * vouchers.reference_number (0007) — free text for the COUNTERPARTY's
--     document number, already load-bearing for find_duplicate_bills. It is
--     the supplier's bill number, not a foreign key, and it is null on most
--     receipts. Not a link.
--   * service_advance_receipts.adjusted_voucher_id (GSTR-1 Table 11) — a real
--     one-to-one link, but it exists to move a GST advance from Table 11A to
--     11B, is single-valued, carries no amount, and is scoped to services.
--     Not general-purpose.
--   * voucher_item_batches (0067) — not a hook, but the right SHAPE: a real
--     join table with an amount, a BEFORE trigger owning the
--     "sum never exceeds the line" invariant, and a narrow write RPC. This
--     migration copies that shape deliberately rather than reinventing it.
--
-- ---------------------------------------------------------------------------
-- THE MODEL
-- ---------------------------------------------------------------------------
-- voucher_allocations: (settlement voucher, bill voucher, party ledger,
-- amount). Which side is which is decided by the SIGN of each voucher's net
-- movement on that party ledger, never by voucher_type — so a journal that
-- books a liability is allocatable as a bill, a credit note that reduces what
-- a customer owes is allocatable as a settlement, and the pilot's own
-- journal-posted service billing is not shut out of a feature it belongs in.
--
-- TWO INVARIANTS, BOTH DATABASE-ENFORCED:
--   (a) the allocations against one bill never exceed that bill's own charge
--       to that party ledger;
--   (b) the allocations made from one settlement never exceed that
--       settlement's own reduction of that party ledger.
-- Together these are what keeps the subsidiary list tying EXACTLY to the
-- control account: outstanding always equals (total charges - total
-- settlements), whether the money was pointed at a document or left on
-- account. Break either invariant and the two stop agreeing, which is the
-- one failure mode this feature must not have.
--
-- Both are enforced twice. app_private.enforce_voucher_allocation (BEFORE
-- INSERT/UPDATE on this table) is the obvious half. The half that is easy to
-- miss — and would have been a real hole — is EDITING A VOUCHER AFTERWARDS:
-- update_invoice/update_voucher rewrite voucher_entries, so an invoice
-- allocated in full and then edited down to a smaller amount would leave the
-- allocation stranded above the bill and silently break the tie. So a
-- DEFERRED CONSTRAINT TRIGGER on voucher_entries re-checks both invariants at
-- COMMIT for any voucher that carries allocations — deferred for exactly the
-- reason 0007's own balance check is: update_invoice deletes every line and
-- re-inserts them inside one transaction, and a non-deferred check would see
-- the empty middle of that and refuse a legitimate edit. It short-circuits on
-- an indexed existence probe, so a company that has never allocated anything
-- pays one index lookup per voucher write.
--
-- ---------------------------------------------------------------------------
-- THE OPENING BALANCE IS DELIBERATELY NOT ALLOCATABLE
-- ---------------------------------------------------------------------------
-- get_party_outstanding injects a party's opening balance as a charge dated
-- at the company's own book_beginning_date (0017, re-dated by 1250) so that
-- FIFO nets receipts against it before any invoice. That behaviour is kept
-- exactly. What is NOT added is an explicit allocation against it: an opening
-- balance is not a voucher, has no id to point at, and giving it a sentinel
-- id would mean a nullable column inside the unique key — which is not a
-- constraint at all, a lesson this codebase has already paid for once.
--
-- It costs little, because the fallback already does the right thing:
-- unallocated money is applied oldest-first, and the opening balance IS the
-- oldest charge. The pilot's own "NEFT to Konkan Packaging - clearing opening
-- dues" is settled correctly by simply leaving that payment unallocated. What
-- a user cannot do is pin money to the opening balance while ALSO leaving
-- other money unallocated and expecting the second lot to skip it. Said here
-- rather than discovered later.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT DO
-- ---------------------------------------------------------------------------
--   * No auto-matching. Nothing reads a narration, guesses at an amount, or
--     allocates on the user's behalf. The pilot's narrations name the invoice
--     in plain English and it would be tempting; a wrong auto-allocation is
--     invisible in a way an unallocated receipt is not.
--   * No period lock. An allocation posts nothing — it changes no ledger
--     balance, no tax, no total — so locking the books does not freeze it,
--     the same call cost centres (0057) made for the same reason. Stated, not
--     assumed.
--   * No foreign-currency allocation. Allocation is in INR, the books' only
--     currency, which is what every consumer of it reads.
--   * No approval workflow of its own. Allocation follows can_write_company,
--     like every other non-posting record here.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table public.voucher_allocations (
  id uuid primary key default gen_random_uuid(),

  company_id uuid not null references public.companies(id) on delete cascade,

  -- The party ledger BOTH vouchers post against. Carried explicitly rather
  -- than derived, because a voucher can legitimately touch more than one
  -- party ledger and the invariants above are per (document, party ledger),
  -- not per document.
  party_ledger_id uuid not null,

  -- The money: a receipt, a payment, a credit/debit note, or a journal —
  -- anything whose net movement REDUCES what this party ledger carries.
  settlement_voucher_id uuid not null,

  -- The document being settled: anything whose net movement INCREASES it.
  bill_voucher_id uuid not null,

  amount numeric(18,2) not null check (amount > 0),

  -- Deliberately no free-text note column: set_voucher_allocations replaces
  -- the whole set for a receipt, so any note attached to a line would be
  -- silently lost the next time someone revised it. The narration belongs on
  -- the voucher, which is where a reader looks for it anyway.
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint voucher_allocations_two_documents
    check (settlement_voucher_id <> bill_voucher_id),

  -- One edge per (settlement, bill, party). Topping up an existing edge is an
  -- UPDATE, never a second row — so the invariant checks only ever have to
  -- look at one row per pair. Every column in the key is NOT NULL, so this
  -- really is a constraint.
  unique (settlement_voucher_id, bill_voucher_id, party_ledger_id),

  foreign key (party_ledger_id, company_id) references public.ledgers (id, company_id),
  foreign key (settlement_voucher_id, company_id)
    references public.vouchers (id, company_id) on delete cascade,
  foreign key (bill_voucher_id, company_id)
    references public.vouchers (id, company_id) on delete cascade
);

create index voucher_allocations_bill_idx
  on public.voucher_allocations (company_id, bill_voucher_id);
create index voucher_allocations_settlement_idx
  on public.voucher_allocations (company_id, settlement_voucher_id);
create index voucher_allocations_party_idx
  on public.voucher_allocations (company_id, party_ledger_id);

create trigger set_updated_at
  before update on public.voucher_allocations
  for each row execute function app_private.set_updated_at();

comment on table public.voucher_allocations is
  'Bill-by-bill allocation (1490): which specific bill(s) a receipt/payment/credit note settles, and for how much. The unallocated remainder of a settlement stays on account and is applied oldest-first by the FIFO fallback get_party_outstanding has always used. Which voucher is the bill and which is the settlement is decided by the SIGN of each one''s net movement on the party ledger, never by voucher_type.';

comment on column public.voucher_allocations.amount is
  'INR. Constrained twice over: never more than the bill''s own charge to this party ledger, never more than the settlement''s own reduction of it — checked on write by enforce_voucher_allocation and re-checked at COMMIT by trg_voucher_entries_allocations when the underlying voucher is edited. Those two bounds are what keeps the bill-wise list tying exactly to the control account.';

alter table public.voucher_allocations enable row level security;

create policy voucher_allocations_read on public.voucher_allocations
  for select to authenticated
  using ((select app_private.is_company_member(company_id)));

create policy voucher_allocations_write on public.voucher_allocations
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));


-- ---------------------------------------------------------------------------
-- 2. app_private.party_voucher_delta — the sign convention, in one place
-- ---------------------------------------------------------------------------
-- Positive = this voucher INCREASED what the party ledger carries (a charge:
-- a sales invoice for a debtor, a purchase bill for a creditor). Negative =
-- it reduced it (a settlement). The same convention get_party_outstanding has
-- always used, extracted so the trigger, the RPCs and the reports cannot
-- drift apart on it.
create or replace function app_private.party_voucher_delta(
  p_company_id uuid,
  p_voucher_id uuid,
  p_ledger_id uuid,
  p_role text
) returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(
           case when p_role = 'debtor'
                then e.debit_amount - e.credit_amount
                else e.credit_amount - e.debit_amount end), 0)
    from public.voucher_entries e
    join public.vouchers v on v.id = e.voucher_id
   where e.voucher_id = p_voucher_id
     and e.company_id = p_company_id
     and e.ledger_id = p_ledger_id
     and not v.is_deleted;
$$;

revoke all on function app_private.party_voucher_delta(uuid, uuid, uuid, text) from public, anon;
grant execute on function app_private.party_voucher_delta(uuid, uuid, uuid, text) to authenticated;

comment on function app_private.party_voucher_delta(uuid, uuid, uuid, text) is
  'Net movement of one voucher on one party ledger, signed so positive always means "the party owes more" (1490). The single definition of charge-vs-settlement.';


-- ---------------------------------------------------------------------------
-- 3. app_private.assert_allocations_fit — both invariants, one function
-- ---------------------------------------------------------------------------
-- Called by the deferred constraint trigger on voucher_entries, so an
-- allocation that was legal when written cannot be left illegal by a later
-- edit to either of its two vouchers.
create or replace function app_private.assert_allocations_fit(
  p_company_id uuid,
  p_voucher_id uuid
) returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
  v_limit numeric;
begin
  -- As a BILL: what is pointed at it must not exceed what it charged.
  for r in
    select a.party_ledger_id, sum(a.amount) as allocated,
           coalesce(g.ledger_role, '') as role, l.name as ledger_name,
           v.voucher_number
      from public.voucher_allocations a
      join public.ledgers l on l.id = a.party_ledger_id
      join public.account_groups g on g.id = l.group_id
      join public.vouchers v on v.id = a.bill_voucher_id
     where a.company_id = p_company_id
       and a.bill_voucher_id = p_voucher_id
     group by a.party_ledger_id, g.ledger_role, l.name, v.voucher_number
  loop
    v_limit := app_private.party_voucher_delta(p_company_id, p_voucher_id, r.party_ledger_id, r.role);
    if r.allocated > v_limit then
      raise exception
        '% has % allocated against it for %, but after this change the document is only worth %. Reduce or remove the allocation first.',
        r.voucher_number, to_char(r.allocated, 'FM9999999990.00'), r.ledger_name,
        to_char(v_limit, 'FM9999999990.00')
        using errcode = '23514';
    end if;
  end loop;

  -- As a SETTLEMENT: what it has been spread across must not exceed itself.
  for r in
    select a.party_ledger_id, sum(a.amount) as allocated,
           coalesce(g.ledger_role, '') as role, l.name as ledger_name,
           v.voucher_number
      from public.voucher_allocations a
      join public.ledgers l on l.id = a.party_ledger_id
      join public.account_groups g on g.id = l.group_id
      join public.vouchers v on v.id = a.settlement_voucher_id
     where a.company_id = p_company_id
       and a.settlement_voucher_id = p_voucher_id
     group by a.party_ledger_id, g.ledger_role, l.name, v.voucher_number
  loop
    v_limit := -app_private.party_voucher_delta(p_company_id, p_voucher_id, r.party_ledger_id, r.role);
    if r.allocated > v_limit then
      raise exception
        '% has % spread across bills for %, but after this change only % came in on it. Reduce the allocation first.',
        r.voucher_number, to_char(r.allocated, 'FM9999999990.00'), r.ledger_name,
        to_char(v_limit, 'FM9999999990.00')
        using errcode = '23514';
    end if;
  end loop;
end;
$$;

revoke all on function app_private.assert_allocations_fit(uuid, uuid) from public, anon;
grant execute on function app_private.assert_allocations_fit(uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. The write-time guard on voucher_allocations itself
-- ---------------------------------------------------------------------------
create or replace function app_private.enforce_voucher_allocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_bill record;
  v_settle record;
  v_charge numeric;
  v_received numeric;
  v_other_on_bill numeric;
  v_other_on_settlement numeric;
begin
  select coalesce(g.ledger_role, '') into v_role
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
   where l.id = new.party_ledger_id and l.company_id = new.company_id;

  if coalesce(v_role, '') not in ('debtor', 'creditor') then
    raise exception
      'Money can only be allocated against a sundry debtor or sundry creditor ledger. That ledger is neither.'
      using errcode = '23514';
  end if;

  select voucher_number, is_deleted into v_bill
    from public.vouchers where id = new.bill_voucher_id and company_id = new.company_id;
  if v_bill.voucher_number is null then
    raise exception 'The bill named does not exist in this company.' using errcode = '23503';
  end if;
  if v_bill.is_deleted then
    raise exception 'Bill % has been deleted and cannot be allocated against.', v_bill.voucher_number
      using errcode = '23514';
  end if;

  select voucher_number, is_deleted into v_settle
    from public.vouchers where id = new.settlement_voucher_id and company_id = new.company_id;
  if v_settle.voucher_number is null then
    raise exception 'The receipt or payment named does not exist in this company.' using errcode = '23503';
  end if;
  if v_settle.is_deleted then
    raise exception 'Receipt/payment % has been deleted and cannot be allocated.', v_settle.voucher_number
      using errcode = '23514';
  end if;

  v_charge   :=  app_private.party_voucher_delta(new.company_id, new.bill_voucher_id, new.party_ledger_id, v_role);
  v_received := -app_private.party_voucher_delta(new.company_id, new.settlement_voucher_id, new.party_ledger_id, v_role);

  if v_charge <= 0 then
    raise exception
      '% does not charge this party anything, so there is nothing on it to settle. Pick the invoice or bill the money was for.',
      v_bill.voucher_number using errcode = '23514';
  end if;

  if v_received <= 0 then
    raise exception
      '% does not reduce this party''s balance, so there is no money on it to allocate.',
      v_settle.voucher_number using errcode = '23514';
  end if;

  select coalesce(sum(amount), 0) into v_other_on_bill
    from public.voucher_allocations
   where company_id = new.company_id
     and bill_voucher_id = new.bill_voucher_id
     and party_ledger_id = new.party_ledger_id
     and id <> new.id;

  if v_other_on_bill + new.amount > v_charge then
    raise exception
      'Allocating % would take the total settled against % to %, and that document is only worth %. % is still open on it.',
      to_char(new.amount, 'FM9999999990.00'), v_bill.voucher_number,
      to_char(v_other_on_bill + new.amount, 'FM9999999990.00'),
      to_char(v_charge, 'FM9999999990.00'),
      to_char(v_charge - v_other_on_bill, 'FM9999999990.00')
      using errcode = '23514';
  end if;

  select coalesce(sum(amount), 0) into v_other_on_settlement
    from public.voucher_allocations
   where company_id = new.company_id
     and settlement_voucher_id = new.settlement_voucher_id
     and party_ledger_id = new.party_ledger_id
     and id <> new.id;

  if v_other_on_settlement + new.amount > v_received then
    raise exception
      'Allocating % would spread % across more bills than it can cover: only % came in on it and % of that is already allocated.',
      to_char(new.amount, 'FM9999999990.00'), v_settle.voucher_number,
      to_char(v_received, 'FM9999999990.00'),
      to_char(v_other_on_settlement, 'FM9999999990.00')
      using errcode = '23514';
  end if;

  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end;
$$;

create trigger enforce_voucher_allocation
  before insert or update on public.voucher_allocations
  for each row execute function app_private.enforce_voucher_allocation();


-- ---------------------------------------------------------------------------
-- 5. The edit-time guard: a voucher cannot be shrunk below what is allocated
-- ---------------------------------------------------------------------------
-- DEFERRED, for the same reason 0007's balance check is: update_invoice
-- deletes every line and re-inserts them inside one transaction, and an
-- immediate check would see the empty middle. The existence probe comes
-- first, so the overwhelming majority of voucher writes (nothing allocated)
-- cost one index lookup.
create or replace function app_private.trg_voucher_entries_allocations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_voucher uuid := coalesce(new.voucher_id, old.voucher_id);
  v_company uuid := coalesce(new.company_id, old.company_id);
begin
  if not exists (
    select 1 from public.voucher_allocations a
     where a.company_id = v_company
       and (a.bill_voucher_id = v_voucher or a.settlement_voucher_id = v_voucher)
  ) then
    return coalesce(new, old);
  end if;

  -- The header may have been deleted in this same transaction (0007's own
  -- balance check makes the identical allowance); the allocation rows will
  -- have cascaded away with it.
  if not exists (select 1 from public.vouchers where id = v_voucher) then
    return coalesce(new, old);
  end if;

  perform app_private.assert_allocations_fit(v_company, v_voucher);
  return coalesce(new, old);
end;
$$;

create constraint trigger trg_voucher_entries_allocations
  after insert or update or delete on public.voucher_entries
  deferrable initially deferred
  for each row execute function app_private.trg_voucher_entries_allocations();


-- ---------------------------------------------------------------------------
-- 6. app_private.party_document_outstanding — THE shared answer
-- ---------------------------------------------------------------------------
-- One row per charge document per party ledger, plus one row for the party's
-- opening balance (voucher_id null, dated at the company's own
-- book_beginning_date exactly as 1250 established). Every consumer — the
-- receivables/payables ageing, the Schedule III note, the overdue feed, the
-- Rule 37 reversal and the new bill-wise screen — reads THIS, so there is one
-- answer to "is this document still unpaid" rather than five that can drift.
--
-- HOW THE TIE TO THE CONTROL ACCOUNT IS FORCED, not merely hoped for:
--   residual charge  = charge - (allocated, clamped at the charge)
--   unallocated cash = total settlements - (that same clamped allocated total)
-- Both sides subtract the SAME number, so residual charges less unallocated
-- cash is always exactly (total charges - total settlements) — the ledger's
-- own closing balance — no matter how the allocations are arranged. An
-- allocation counts only when BOTH its documents are inside the as-at window,
-- which is why money received after the reporting date correctly leaves the
-- invoice open on that date.
create or replace function app_private.party_document_outstanding(
  p_company_id uuid,
  p_as_at date,
  p_role text
) returns table (
  ledger_id uuid,
  ledger_name text,
  voucher_id uuid,
  voucher_number text,
  voucher_type text,
  voucher_date date,
  bill_amount numeric,
  allocated numeric,
  fifo_applied numeric,
  outstanding numeric
)
language sql
stable
set search_path = ''
as $$
  with book_start as (
    select coalesce(book_beginning_date, '1900-01-01'::date) as d
      from public.companies where id = p_company_id
  ),
  party as (
    select l.id, l.name
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
     where l.company_id = p_company_id and g.ledger_role = p_role
  ),
  -- One net movement per (party ledger, voucher). 0017 aged each
  -- voucher_entries ROW separately; 0096 already argued invoice grain is the
  -- right one, and it is the only grain an allocation can point at. Checked
  -- across the whole live database before changing it: no voucher anywhere
  -- posts more than one line to the same party ledger, so this regroups
  -- nothing that exists today.
  moves as (
    select e.ledger_id, e.voucher_id, v.voucher_date, v.voucher_number, v.voucher_type,
           sum(case when p_role = 'debtor'
                    then e.debit_amount - e.credit_amount
                    else e.credit_amount - e.debit_amount end) as delta
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id
      join party p on p.id = e.ledger_id
     where e.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
     group by e.ledger_id, e.voucher_id, v.voucher_date, v.voucher_number, v.voucher_type
  ),
  opening as (
    select l.id as ledger_id,
           case when p_role = 'debtor'
                then case when l.opening_balance_type = 'debit'
                          then l.opening_balance_amount else -l.opening_balance_amount end
                else case when l.opening_balance_type = 'credit'
                          then l.opening_balance_amount else -l.opening_balance_amount end
           end as amount
      from public.ledgers l join party p on p.id = l.id
  ),
  -- Only allocations whose BOTH ends are visible at p_as_at count.
  alloc as (
    select a.party_ledger_id as ledger_id, a.bill_voucher_id, a.amount
      from public.voucher_allocations a
      join moves b on b.voucher_id = a.bill_voucher_id
                  and b.ledger_id = a.party_ledger_id and b.delta > 0
      join moves s on s.voucher_id = a.settlement_voucher_id
                  and s.ledger_id = a.party_ledger_id and s.delta < 0
     where a.company_id = p_company_id
  ),
  -- Every unqualified reference below is deliberately table-qualified: the
  -- RETURNS TABLE column names are OUT parameters inside a SQL-language body,
  -- so a bare `ledger_id` or `allocated` here is genuinely ambiguous.
  alloc_bill as (
    select alloc.ledger_id, alloc.bill_voucher_id, sum(alloc.amount) as allocated
      from alloc group by alloc.ledger_id, alloc.bill_voucher_id
  ),
  charges as (
    select m.ledger_id, m.voucher_id, m.voucher_number, m.voucher_type, m.voucher_date,
           m.delta as bill_amount,
           least(coalesce(ab.allocated, 0), m.delta) as allocated
      from moves m
      left join alloc_bill ab
        on ab.ledger_id = m.ledger_id and ab.bill_voucher_id = m.voucher_id
     where m.delta > 0
    union all
    select o.ledger_id, null::uuid, null::text, null::text, (select d from book_start),
           o.amount, 0::numeric
      from opening o where o.amount > 0
  ),
  -- Everything that reduced the balance, including a favourable opening
  -- balance (1050's fix, kept), LESS whatever has been pointed at a specific
  -- bill. The subtraction uses the same clamped total the charges used.
  settlements as (
    select s.ledger_id, sum(s.paid) as paid
      from (
        select m.ledger_id, -m.delta as paid from moves m where m.delta < 0
        union all
        select o.ledger_id, -o.amount from opening o where o.amount < 0
      ) s
     group by s.ledger_id
  ),
  allocated_total as (
    select charges.ledger_id, sum(charges.allocated) as allocated
      from charges group by charges.ledger_id
  ),
  on_account as (
    select p.id as ledger_id,
           coalesce(st.paid, 0) - coalesce(alt.allocated, 0) as paid
      from party p
      left join settlements st on st.ledger_id = p.id
      left join allocated_total alt on alt.ledger_id = p.id
  ),
  ranked as (
    select c.ledger_id, c.voucher_id, c.voucher_number, c.voucher_type, c.voucher_date,
           c.bill_amount, c.allocated,
           (c.bill_amount - c.allocated) as residual,
           sum(c.bill_amount - c.allocated) over (
             partition by c.ledger_id
             order by c.voucher_date, (c.bill_amount - c.allocated), c.voucher_id nulls first
             rows between unbounded preceding and current row
           ) as running
      from charges c
  )
  select r.ledger_id, p.name, r.voucher_id, r.voucher_number, r.voucher_type, r.voucher_date,
         r.bill_amount, r.allocated,
         r.residual - greatest(0, least(r.residual, r.running - coalesce(oa.paid, 0))) as fifo_applied,
         greatest(0, least(r.residual, r.running - coalesce(oa.paid, 0))) as outstanding
    from ranked r
    join party p on p.id = r.ledger_id
    left join on_account oa on oa.ledger_id = r.ledger_id;
$$;

revoke all on function app_private.party_document_outstanding(uuid, date, text) from public, anon;
grant execute on function app_private.party_document_outstanding(uuid, date, text) to authenticated;

comment on function app_private.party_document_outstanding(uuid, date, text) is
  'One row per charge document per party ledger (plus the opening balance as a voucher_id-null row dated at book_beginning_date), split into what was explicitly allocated to it and what the oldest-first fallback applied. The single source every outstanding/ageing/Rule-37 report reads (1490) — residual charges less unallocated cash is arithmetically forced to equal the ledger''s own closing balance.';


-- ---------------------------------------------------------------------------
-- 7. Read RPCs the allocation screen and the bill-wise report use
-- ---------------------------------------------------------------------------

-- Every charge document that still has something on it — either genuinely
-- outstanding, or fully covered by the FIFO fallback but with nothing
-- explicitly pointed at it yet (still allocatable, and the screen must offer
-- it). The opening balance comes back as a voucher_id-null row so the list
-- adds up to the control account.
create or replace function public.get_bill_wise_outstanding(
  p_company_id uuid,
  p_role text default 'debtor',
  p_as_at date default current_date
) returns table (
  ledger_id uuid,
  ledger_name text,
  voucher_id uuid,
  voucher_number text,
  voucher_type text,
  voucher_date date,
  due_date date,
  bill_amount numeric,
  allocated numeric,
  fifo_applied numeric,
  outstanding numeric,
  allocatable numeric,
  days_overdue integer
)
language sql
stable
set search_path = ''
as $$
  select d.ledger_id, d.ledger_name, d.voucher_id, d.voucher_number, d.voucher_type,
         d.voucher_date,
         (d.voucher_date + coalesce(l.credit_days, 30)) as due_date,
         round(d.bill_amount, 2), round(d.allocated, 2),
         round(d.fifo_applied, 2), round(d.outstanding, 2),
         case when d.voucher_id is null then 0
              else round(d.bill_amount - d.allocated, 2) end as allocatable,
         greatest(0, p_as_at - (d.voucher_date + coalesce(l.credit_days, 30)))::int as days_overdue
    from app_private.party_document_outstanding(
           p_company_id, p_as_at,
           case when p_role = 'creditor' then 'creditor' else 'debtor' end) d
    join public.ledgers l on l.id = d.ledger_id
   where d.outstanding > 0
      or (d.voucher_id is not null and (d.bill_amount - d.allocated) > 0)
      -- A bill settled to the last rupee BY AN EXPLICIT ALLOCATION is still
      -- returned, with outstanding 0: the allocation screen has to be able to
      -- show and revise what it already did, and a caller reporting only
      -- unpaid bills filters on outstanding > 0 anyway.
      or d.allocated > 0
   order by d.ledger_name, d.voucher_date, d.voucher_number nulls first;
$$;

revoke all on function public.get_bill_wise_outstanding(uuid, text, date) from public, anon;
grant execute on function public.get_bill_wise_outstanding(uuid, text, date) to authenticated;

comment on function public.get_bill_wise_outstanding(uuid, text, date) is
  'The subsidiary list: which specific invoices/bills are still unpaid, split into what a receipt was explicitly allocated to and what the oldest-first fallback merely inferred (1490). Includes the opening balance as a voucher_id-null row so the list adds up to the party control account exactly. Rows with nothing outstanding are still returned while they remain allocatable or already carry an allocation, because the allocation screen has to be able to offer and revise them — filter on outstanding > 0 for a pure unpaid-bills report.';


-- Money sitting on account: receipts/payments (and credit notes) whose amount
-- has not been pointed at any bill. This is the work queue the screen opens on.
create or replace function public.get_unallocated_settlements(
  p_company_id uuid,
  p_role text default 'debtor',
  p_as_at date default current_date,
  p_include_allocated boolean default false
) returns table (
  ledger_id uuid,
  ledger_name text,
  voucher_id uuid,
  voucher_number text,
  voucher_type text,
  voucher_date date,
  reference_number text,
  narration text,
  settlement_amount numeric,
  allocated numeric,
  on_account numeric
)
language sql
stable
set search_path = ''
as $$
  with cfg as (
    select case when p_role = 'creditor' then 'creditor' else 'debtor' end as r
  ),
  party as (
    select l.id, l.name
      from public.ledgers l
      join public.account_groups g on g.id = l.group_id
      cross join cfg
     where l.company_id = p_company_id and g.ledger_role = cfg.r
  ),
  moves as (
    select e.ledger_id, e.voucher_id, v.voucher_date, v.voucher_number, v.voucher_type,
           v.reference_number, v.narration,
           sum(case when (select cfg.r from cfg) = 'debtor'
                    then e.debit_amount - e.credit_amount
                    else e.credit_amount - e.debit_amount end) as delta
      from public.voucher_entries e
      join public.vouchers v on v.id = e.voucher_id
      join party p on p.id = e.ledger_id
     where e.company_id = p_company_id
       and not v.is_deleted
       and v.voucher_date <= p_as_at
     group by e.ledger_id, e.voucher_id, v.voucher_date, v.voucher_number, v.voucher_type,
              v.reference_number, v.narration
  ),
  alloc as (
    select a.party_ledger_id as ledger_id, a.settlement_voucher_id, sum(a.amount) as allocated
      from public.voucher_allocations a
     where a.company_id = p_company_id
     group by a.party_ledger_id, a.settlement_voucher_id
  )
  select m.ledger_id, p.name, m.voucher_id, m.voucher_number, m.voucher_type, m.voucher_date,
         m.reference_number, m.narration,
         round(-m.delta, 2) as settlement_amount,
         round(coalesce(al.allocated, 0), 2) as allocated,
         round(-m.delta - coalesce(al.allocated, 0), 2) as on_account
    from moves m
    join party p on p.id = m.ledger_id
    left join alloc al on al.ledger_id = m.ledger_id and al.settlement_voucher_id = m.voucher_id
   where m.delta < 0
     and (p_include_allocated or (-m.delta - coalesce(al.allocated, 0)) > 0)
   order by m.voucher_date desc, m.voucher_number desc;
$$;

revoke all on function public.get_unallocated_settlements(uuid, text, date, boolean) from public, anon;
grant execute on function public.get_unallocated_settlements(uuid, text, date, boolean) to authenticated;

comment on function public.get_unallocated_settlements(uuid, text, date, boolean) is
  'Receipts/payments (and any other reduction of a party balance) with money still on account — nothing pointed at a specific bill (1490). p_include_allocated returns fully-allocated ones too, so an earlier allocation can be found and revised.';


-- What one settlement is currently pointed at. Read back by the editor so a
-- previous allocation can be revised rather than blindly re-entered.
create or replace function public.get_voucher_allocations(
  p_company_id uuid,
  p_settlement_voucher_id uuid
) returns table (
  id uuid,
  party_ledger_id uuid,
  bill_voucher_id uuid,
  bill_voucher_number text,
  bill_voucher_date date,
  amount numeric,
  created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select a.id, a.party_ledger_id, a.bill_voucher_id, v.voucher_number, v.voucher_date,
         a.amount, a.created_at
    from public.voucher_allocations a
    join public.vouchers v on v.id = a.bill_voucher_id
   where a.company_id = p_company_id
     and a.settlement_voucher_id = p_settlement_voucher_id
   order by v.voucher_date, v.voucher_number;
$$;

revoke all on function public.get_voucher_allocations(uuid, uuid) from public, anon;
grant execute on function public.get_voucher_allocations(uuid, uuid) to authenticated;

comment on function public.get_voucher_allocations(uuid, uuid) is
  'The bills one receipt/payment is currently allocated against (1490).';


-- ---------------------------------------------------------------------------
-- 8. set_voucher_allocations — the write path
-- ---------------------------------------------------------------------------
-- Replace-the-whole-set semantics rather than 0067's additive top-up, because
-- the screen this serves is a FORM over one receipt: the user sees every line
-- at once, edits amounts up and down, and presses Apply. An additive RPC
-- would silently double a corrected figure. Delete-then-insert inside the one
-- transaction, so a rejected line leaves the previous allocation intact
-- rather than half-applied.
create or replace function public.set_voucher_allocations(
  p_company_id uuid,
  p_settlement_voucher_id uuid,
  p_party_ledger_id uuid,
  p_allocations jsonb default '[]'::jsonb
) returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_received numeric;
  v_total numeric := 0;
  v_item jsonb;
  v_bill uuid;
  v_amount numeric;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to allocate receipts for this company';
  end if;

  if jsonb_typeof(coalesce(p_allocations, '[]'::jsonb)) <> 'array' then
    raise exception 'Allocations must be a list of {bill_voucher_id, amount} entries.';
  end if;

  select coalesce(g.ledger_role, '') into v_role
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
   where l.id = p_party_ledger_id and l.company_id = p_company_id;

  if coalesce(v_role, '') not in ('debtor', 'creditor') then
    raise exception
      'Money can only be allocated against a sundry debtor or sundry creditor ledger. That ledger is neither.';
  end if;

  v_received := -app_private.party_voucher_delta(
                   p_company_id, p_settlement_voucher_id, p_party_ledger_id, v_role);

  if v_received <= 0 then
    raise exception
      'That voucher does not reduce this party''s balance, so there is no money on it to allocate.';
  end if;

  delete from public.voucher_allocations
   where company_id = p_company_id
     and settlement_voucher_id = p_settlement_voucher_id
     and party_ledger_id = p_party_ledger_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    v_bill := nullif(v_item->>'bill_voucher_id', '')::uuid;
    v_amount := round(coalesce(nullif(v_item->>'amount', ''), '0')::numeric, 2);

    if v_bill is null then
      raise exception 'Every allocation line must name the bill it settles.';
    end if;

    -- A zero line is how the screen says "unallocate this bill"; skipping it
    -- is the whole point of replace-the-set semantics.
    if v_amount = 0 then
      continue;
    end if;

    if v_amount < 0 then
      raise exception 'An allocation cannot be negative.';
    end if;

    insert into public.voucher_allocations
      (company_id, party_ledger_id, settlement_voucher_id, bill_voucher_id, amount, created_by)
    values
      (p_company_id, p_party_ledger_id, p_settlement_voucher_id, v_bill, v_amount, auth.uid());

    v_total := v_total + v_amount;
  end loop;

  return round(v_received - v_total, 2);
end;
$$;

revoke all on function public.set_voucher_allocations(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_voucher_allocations(uuid, uuid, uuid, jsonb) to authenticated;

comment on function public.set_voucher_allocations(uuid, uuid, uuid, jsonb) is
  'Replaces the entire set of bills one receipt/payment is allocated against for one party ledger, and returns what is left on account (1490). Replace-not-append, because the screen it serves is a form over the whole receipt; a zero amount is how a line is removed. Every line still passes enforce_voucher_allocation, so a rejected line rolls the whole call back rather than leaving a half-applied allocation.';
