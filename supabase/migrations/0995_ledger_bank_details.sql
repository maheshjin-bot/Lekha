-- ============================================================================
-- 0995 — Where a supplier banks, on the supplier's own ledger: the one field
--        on a printed Indian invoice that this schema had nowhere to put
-- ============================================================================
-- A real supplier invoice — the one that prompted this migration is SUPER
-- ELECTRICALS of Surat — prints a complete party master down its head and
-- foot: legal name, full postal address with PIN, two telephone numbers, an
-- email, GSTIN, state code, a UDYAM registration number, and a bank block
-- ("HDFC Bank Ltd, Kadodara / A/c 50200107748050 / IFSC HDFC0003127").
--
-- public.ledgers already has a column for every one of those EXCEPT the bank
-- block: address, city, pincode, state_code, phone, email, gstin, pan,
-- udyam_number, msme_category and msme_payment_days have all existed since
-- 0006. So the capture feature that reads these invoices was throwing away
-- detail the database was already shaped to hold, and the only genuinely
-- missing thing was where the money goes. This migration adds that, and
-- nothing else — the rest of this task is TypeScript.
--
-- ============================================================================
-- 1. THREE COLUMNS ON public.ledgers, NOT A ledger_bank_accounts TABLE
-- ============================================================================
-- DECIDED, and the alternative is genuinely the more "correct" data model, so
-- the reasoning is recorded rather than assumed: a supplier can hold more
-- than one bank account, which is a one-to-many, which is a child table.
--
-- It is not built as one because nothing in LEKHA can ever CHOOSE between the
-- rows. There is no payment run, no beneficiary register, no NEFT/RTGS file
-- writer, no payment advice — searched before writing this and confirmed:
-- the only bank-account fields anywhere in this schema are companies'
-- print_bank_* block (0800), which exists purely to be PRINTED on our own
-- outgoing invoice. A one-to-many table whose extra rows no reader ever
-- selects is worse than one honest column set, because the table's existence
-- ASSERTS a selection mechanism that does not exist: a second row would be
-- stored, would never be shown against a payment, and would quietly rot.
--
-- What this feature actually does is capture-and-store. One invoice prints
-- one account block — the account that supplier wants this bill paid into —
-- and the honest record of that is one account on that supplier's ledger,
-- overwritten by the next invoice that prints a different one (a change the
-- audit trail already records, since public.ledgers is audited).
--
-- If a payments feature is ever built, the migration that introduces
-- public.ledger_bank_accounts backfills from these three columns as each
-- party's first and default row and drops them. That is a mechanical
-- insert-select over one table, not a rewrite — which is the test this
-- decision was actually weighed against.
--
-- The column names deliberately DO NOT copy 0800's print_ prefix. That prefix
-- means "this is put on the paper we send out"; these three are the opposite
-- direction — somebody else's account, read off paper that came in — and
-- printing a supplier's account number on our own invoice would be a defect.
-- One vocabulary, two directions, told apart by the name.
--
-- ============================================================================
-- 2. THE VALIDATION, AND WHERE IT IS DELIBERATELY LOOSER THAN 0800's
-- ============================================================================
-- bank_ifsc reuses app_private.is_valid_ifsc (0001; first actually used by
-- 0800). There is exactly one IFSC validator in this database and this
-- migration does not write a second one — a second copy that drifted would
-- reject numbers the first accepts, on the same page.
--
-- bank_account_number reuses 0800's charset and bounds verbatim,
-- '^[A-Za-z0-9]{5,34}$': Indian bank account numbers run roughly 9-18 digits
-- and some banks issue alphanumerics, 34 is the IBAN ceiling that every
-- payment format in use tops out at, and 5 is below any real account while
-- still rejecting a stray digit picked off a letterhead.
--
-- ANCHORING — and this is the one place the rule differs from 0800 on
-- purpose. companies_print_bank_block_complete (0800) requires that an
-- account number be accompanied by BOTH a bank name and an IFSC, because an
-- account block we print for customers to pay us into is a defect if it
-- cannot be paid into. This block is the mirror image: it is what THEY
-- printed, read by a vision model off a photograph, and refusing to store a
-- perfectly legible account number because the IFSC line was cut off by the
-- edge of the page would throw away the exact detail this whole task exists
-- to stop losing. So:
--
--   ledgers_bank_block_anchored  — bank_name and bank_ifsc may be present
--                                  ONLY when bank_account_number is. A bank
--                                  name with no account is not a fact about
--                                  where to pay anybody; it is a word off a
--                                  letterhead, and letting it in would fill
--                                  this column with "HDFC Bank Ltd" for
--                                  parties whose account nobody holds.
--
-- and no completeness rule in the other direction. An account number alone is
-- a real, incomplete reading, and it is stored as one.
--
-- ============================================================================
-- 3. WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
-- * It does not verify that the account exists, belongs to that supplier, or
--   that the IFSC branch matches the printed branch name. That needs a
--   penny-drop or a bank API; the check digit inside an IFSC is the only
--   arithmetic available here and is_valid_ifsc already does the shape.
-- * It does not pay anybody, and adds no payment_instructions, no UPI VPA and
--   no beneficiary flag. Every one of those is a payments feature wearing a
--   capture feature's clothes.
-- * It does not touch msme_category or msme_payment_days, and no code in this
--   task's change set infers either from a UDYAM number. A UDYAM number is
--   conclusive proof that a supplier is REGISTERED under the MSMED Act 2006
--   and proves nothing whatever about its TIER: the format is
--   UDYAM-<state>-<district>-<7-digit serial> (app_private.is_valid_udyam)
--   and carries no class field, and the classification is a composite
--   investment/turnover test held on the certificate, not in the number.
--   That distinction is not pedantry — Sec 43B(h) of the Income-tax Act bites
--   only for MICRO and SMALL enterprises (it adopts Sec 15 of the MSMED Act,
--   which covers "micro or small"), so a fabricated tier would either invent
--   a disallowance or hide one. app/(app)/[companyId]/reports/msme/page.tsx
--   already filters on msme_category in ('micro','small') after selecting on
--   udyam_number, so a captured UDYAM with no tier correctly puts the
--   supplier on file WITHOUT putting it in the disallowance report until a
--   human sets the tier. The capture UI says so in those words.
-- * msme_payment_days is likewise left null on capture. Sec 15 gives 45 days
--   only where there is a WRITTEN AGREEMENT and 15 days where there is none;
--   which of those applies is a fact about a contract, never a fact printed
--   on an invoice. The MSME report already reads a null as the safer 15
--   (DEFAULT_DEADLINE_DAYS), so null is the correct captured value and
--   writing 45 would silently extend every supplier's deadline.
--
-- ============================================================================
-- 4. GRANTS
-- ============================================================================
-- public.ledgers is granted WHOLE-TABLE, unlike public.companies whose 0044
-- per-column allowlist has to be extended for every new column. Verified live
-- before writing this: information_schema.role_table_grants shows table-level
-- SELECT/INSERT/UPDATE/DELETE for anon and authenticated on public.ledgers,
-- and column_privileges reports all 42 pre-existing columns for each of those
-- privileges purely as the expansion of the table grant. A new column is
-- therefore covered automatically and this migration adds no grant. That is
-- re-verified after applying (the count must move 42 -> 45), because the
-- companies-allowlist gap has been hit repeatedly in this project and the
-- cost of checking is one query.
--
-- RLS is unchanged and needs no change: these are columns on an existing
-- row, and public.ledgers' company-scoped policies already govern who may
-- read or write that row at all.
-- ============================================================================

alter table public.ledgers
  add column if not exists bank_name text
    check (bank_name is null or length(trim(bank_name)) between 2 and 120),
  add column if not exists bank_account_number text
    check (bank_account_number is null or bank_account_number ~ '^[A-Za-z0-9]{5,34}$'),
  add column if not exists bank_ifsc text
    check (app_private.is_valid_ifsc(bank_ifsc));

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.ledgers'::regclass
       and conname = 'ledgers_bank_block_anchored'
  ) then
    alter table public.ledgers
      add constraint ledgers_bank_block_anchored
      check (
        bank_account_number is not null
        or (bank_name is null and bank_ifsc is null)
      );
  end if;
end $$;

comment on column public.ledgers.bank_name is
  'The bank and branch this party printed on its own invoice, e.g. "HDFC Bank '
  'Ltd - Kadodara". Free text on purpose: what is printed is a branch name, '
  'not an IFSC directory entry, and no table in this database holds branch '
  'names to reference. May only be set alongside bank_account_number '
  '(ledgers_bank_block_anchored). Captured, never used to pay anybody — '
  'LEKHA has no payment run. See 0995.';

comment on column public.ledgers.bank_account_number is
  'The party''s OWN bank account, as printed on the documents they send us. '
  'Same charset and bounds as companies.print_bank_account_number (0800): '
  '5-34 alphanumerics. This is the anchor of the bank block — bank_name and '
  'bank_ifsc may only be present when this is. Unlike 0800''s block it does '
  'NOT require the other two, because a legible account number read off a '
  'photograph whose IFSC line was cropped is a real reading and is kept as '
  'one. Not verified against any bank. See 0995.';

comment on column public.ledgers.bank_ifsc is
  'IFSC of the branch holding bank_account_number, validated by '
  'app_private.is_valid_ifsc (0001) — the same single validator '
  'companies.print_bank_ifsc uses. Shape only: no branch directory is '
  'consulted and no penny-drop is performed. May only be set alongside '
  'bank_account_number (ledgers_bank_block_anchored). See 0995.';
