-- ============================================================================
-- What the database guarantees — run as a script, rolls itself back.
-- ============================================================================
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/guarantees.sql
--
-- Safe against a database with real data in it: everything runs inside one
-- transaction that ends in ROLLBACK, and the assertions below touch only
-- pure functions or fixtures this script creates itself.
--
-- This file grows with each migration. Sections are numbered to match.
-- ============================================================================

begin;

create or replace function pg_temp.ok(p_condition boolean, p_what text)
returns void
language plpgsql
as $$
begin
  if p_condition is not true then
    raise exception 'FAILED: %', p_what;
  end if;
  raise notice '  ok  %', p_what;
end;
$$;


-- ============================================================================
-- 0001 — helpers and validators
-- ============================================================================
\echo '0001 financial year helpers'

-- April year (the Indian default). 31 March belongs to the year that started
-- the previous April; 1 April opens the next one.
select pg_temp.ok(app_private.fy_start_date('2026-03-31'::date, 4::smallint) = '2025-04-01'::date,
  '31 Mar 2026 falls in FY starting 1 Apr 2025');
select pg_temp.ok(app_private.fy_start_date('2026-04-01'::date, 4::smallint) = '2026-04-01'::date,
  '1 Apr 2026 opens FY 2026-27');
select pg_temp.ok(app_private.fy_end_date('2026-04-01'::date, 4::smallint) = '2027-03-31'::date,
  'April FY ends 31 Mar');
select pg_temp.ok(app_private.fy_label('2026-04-01'::date, 4::smallint) = '2026-27',
  'April FY labels as 2026-27');
select pg_temp.ok(app_private.fy_label('2026-03-31'::date, 4::smallint) = '2025-26',
  '31 Mar 2026 labels as 2025-26');

-- Non-April year. HISAB's demo data uses July deliberately, because an April
-- year hides the most common class of date bug — April is also the default,
-- so a hardcoded 4 passes every April test.
select pg_temp.ok(app_private.fy_start_date('2026-06-30'::date, 7::smallint) = '2025-07-01'::date,
  '30 Jun 2026 falls in FY starting 1 Jul 2025 (July year)');
select pg_temp.ok(app_private.fy_label('2026-07-01'::date, 7::smallint) = '2026-27',
  'July FY labels as 2026-27');
select pg_temp.ok(app_private.fy_end_date('2026-07-01'::date, 7::smallint) = '2027-06-30'::date,
  'July FY ends 30 Jun');

-- Century boundary: the two-digit suffix must wrap, not overflow.
select pg_temp.ok(app_private.fy_label('2099-05-01'::date, 4::smallint) = '2099-00',
  'FY label wraps the two-digit suffix at the century');

-- Leap year.
select pg_temp.ok(app_private.fy_end_date('2024-04-01'::date, 4::smallint) = '2025-03-31'::date,
  'leap year does not shift the FY end');


\echo '0001 GSTIN checksum'

-- Verified test vectors. The check digit is Luhn mod 36 over the first 14
-- characters. These two are documented, real-format GSTINs whose check digits
-- were confirmed independently before this validator shipped.
select pg_temp.ok(app_private.gstin_check_digit('27AAPFU0939F1Z') = 'V',
  'check digit for 27AAPFU0939F1Z is V');
select pg_temp.ok(app_private.gstin_check_digit('27AABCU9603R1Z') = 'N',
  'check digit for 27AABCU9603R1Z is N');

select pg_temp.ok(app_private.is_valid_gstin('27AAPFU0939F1ZV'),
  'accepts a valid GSTIN');
select pg_temp.ok(app_private.is_valid_gstin('27AABCU9603R1ZN'),
  'accepts a second valid GSTIN');

-- The whole point of the checksum: a single wrong character must be rejected
-- even though the structure is still perfectly well formed.
select pg_temp.ok(not app_private.is_valid_gstin('27AAPFU0939F1ZX'),
  'rejects a wrong check digit');
select pg_temp.ok(not app_private.is_valid_gstin('27AABCU9603R1ZM'),
  'rejects a wrong check digit on the second vector');

-- Transposition — the error a regex can never catch.
select pg_temp.ok(not app_private.is_valid_gstin('27AAPFU9039F1ZV'),
  'rejects transposed digits inside the PAN');

-- Structural rejections.
select pg_temp.ok(not app_private.is_valid_gstin('27AAPFU0939F1AV'),
  'rejects a 14th character that is not Z');
select pg_temp.ok(not app_private.is_valid_gstin('27AAPFU0939F0ZV'),
  'rejects entity number 0');
select pg_temp.ok(not app_private.is_valid_gstin('27AAPFU0939F1Z'),
  'rejects a 14-character GSTIN');
select pg_temp.ok(not app_private.is_valid_gstin('27aapfu0939f1zv'),
  'rejects lowercase');
select pg_temp.ok(not app_private.is_valid_gstin('2AAPFU0939F1ZVX'),
  'rejects a malformed state code');

-- Null means "not supplied", which is valid on an unregistered party. This is
-- what lets the validator sit in a CHECK constraint without forcing NOT NULL.
select pg_temp.ok(app_private.is_valid_gstin(null),
  'null GSTIN is permitted');

-- Accessors must agree with the string they were derived from.
select pg_temp.ok(app_private.gstin_state_code('27AAPFU0939F1ZV') = '27',
  'extracts the state code');
select pg_temp.ok(app_private.gstin_pan('27AAPFU0939F1ZV') = 'AAPFU0939F',
  'extracts the embedded PAN');
select pg_temp.ok(app_private.is_valid_pan(app_private.gstin_pan('27AAPFU0939F1ZV')),
  'the embedded PAN is itself valid');


\echo '0001 other identifiers'

select pg_temp.ok(app_private.is_valid_pan('AAPFU0939F'), 'accepts a valid PAN');
select pg_temp.ok(not app_private.is_valid_pan('AAPFU0939'), 'rejects a short PAN');
select pg_temp.ok(not app_private.is_valid_pan('AAPF00939F'), 'rejects digits in the letter block');
select pg_temp.ok(app_private.is_valid_pan(null), 'null PAN is permitted');

select pg_temp.ok(app_private.is_valid_tan('MUMA12345B'), 'accepts a valid TAN');
select pg_temp.ok(not app_private.is_valid_tan('MUM12345B'), 'rejects a short TAN');

select pg_temp.ok(app_private.is_valid_iec('AAPFU0939F'), 'accepts an IEC (PAN-shaped since 2017)');

select pg_temp.ok(app_private.is_valid_ifsc('HDFC0001234'), 'accepts a valid IFSC');
select pg_temp.ok(not app_private.is_valid_ifsc('HDFC1001234'), 'rejects IFSC without the reserved 0');

select pg_temp.ok(app_private.is_valid_udyam('UDYAM-MH-26-0001234'), 'accepts a valid Udyam number');
select pg_temp.ok(not app_private.is_valid_udyam('UDYAM-MH-26-1234'), 'rejects a short Udyam number');


\echo '0001 name normalisation'

-- Defect F-09 in the old app: the importer matched on trim+lower only, so
-- punctuation differences created duplicate ledgers. These must collapse.
select pg_temp.ok(app_private.normalize_name('A. B. Traders') = app_private.normalize_name('A B Traders'),
  'punctuation does not distinguish two names');
select pg_temp.ok(app_private.normalize_name('  Acme   Pvt.  Ltd. ') = 'acme pvt ltd',
  'collapses whitespace and trims');
select pg_temp.ok(app_private.normalize_name('Shah & Co') = app_private.normalize_name('Shah  Co'),
  'ampersand collapses to a separator');
select pg_temp.ok(app_private.normalize_name(null) = '',
  'null normalises to empty rather than null');


\echo '0001 rounding'

select pg_temp.ok(app_private.round_paise(100.005) = 100.01, 'paise rounds half away from zero');
select pg_temp.ok(app_private.round_rupee(100.50) = 101, 'rupee rounds half away from zero');
select pg_temp.ok(app_private.round_rupee(100.49) = 100, 'rupee rounds down below half');


\echo ''
\echo 'All guarantees held.'

rollback;
