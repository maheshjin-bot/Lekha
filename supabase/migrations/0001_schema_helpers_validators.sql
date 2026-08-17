-- ============================================================================
-- 0001 — Private schema, shared helpers, and statutory identifier validators
-- ============================================================================
-- Nothing here touches a table. Everything is either a trigger helper or a
-- pure function, which is deliberate: the validators below are marked
-- `immutable` so they can be used directly in CHECK constraints, and a
-- function that reads a table cannot be.
-- ============================================================================

-- Private schema for internal functions that must run with elevated
-- privileges (SECURITY DEFINER) but should never be directly callable by
-- clients via PostgREST. Only "public" is exposed to the API by default.
create schema if not exists app_private;

-- Every RLS policy calls app_private.is_company_member() or a sibling, and
-- security-invoker functions name app_private helpers as the *caller*.
-- SECURITY DEFINER changes who a function runs as, not who may reference it —
-- the caller still needs USAGE on the schema. Without this grant, policies
-- error instead of filtering and security-invoker functions return nothing.
grant usage on schema app_private to authenticated;
alter default privileges in schema app_private
  grant execute on functions to authenticated;

-- gen_random_uuid() ships built into Postgres 13+, so every ID default in
-- this schema can rely on it with no extension needed.


-- ----------------------------------------------------------------------------
-- Generic updated_at maintenance
-- ----------------------------------------------------------------------------
-- Reused by every table via
-- `create trigger set_updated_at before update ... execute function app_private.set_updated_at()`.
create or replace function app_private.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ----------------------------------------------------------------------------
-- Financial year
-- ----------------------------------------------------------------------------
-- HISAB inlined this arithmetic inside next_voucher_number(). Here it is
-- extracted, because far more now depends on it: voucher numbering, return
-- periods, the compliance calendar, depreciation, AS 11 year-end restatement
-- and the 44AB turnover test all have to agree on where a year begins. One
-- definition, or they will drift.
--
-- p_start_month is the company's financial_year_start_month (April = 4 by
-- default in India, but configurable — the demo data deliberately uses July
-- because an April year hides the most common class of date bug).

create or replace function app_private.fy_start_date(p_date date, p_start_month smallint)
returns date
language sql
immutable
parallel safe
as $$
  select make_date(
    case when extract(month from p_date)::int >= p_start_month
         then extract(year from p_date)::int
         else extract(year from p_date)::int - 1
    end,
    p_start_month,
    1
  );
$$;

create or replace function app_private.fy_end_date(p_date date, p_start_month smallint)
returns date
language sql
immutable
parallel safe
as $$
  select (app_private.fy_start_date(p_date, p_start_month) + interval '1 year' - interval '1 day')::date;
$$;

-- Renders the label used in voucher numbers and return periods: 2026-27.
create or replace function app_private.fy_label(p_date date, p_start_month smallint)
returns text
language sql
immutable
parallel safe
as $$
  select extract(year from app_private.fy_start_date(p_date, p_start_month))::int
         || '-'
         || lpad(((extract(year from app_private.fy_start_date(p_date, p_start_month))::int + 1) % 100)::text, 2, '0');
$$;


-- ----------------------------------------------------------------------------
-- Money
-- ----------------------------------------------------------------------------
-- numeric(18,2) is exact decimal, so these are about applying the *statutory*
-- rounding rule rather than fixing float error. Different taxes round
-- differently and the difference is not cosmetic: GST rounds at the invoice,
-- TDS to the nearest rupee, income tax to the nearest ten.

create or replace function app_private.round_paise(p_amount numeric)
returns numeric
language sql
immutable
parallel safe
as $$
  select round(p_amount, 2);
$$;

create or replace function app_private.round_rupee(p_amount numeric)
returns numeric
language sql
immutable
parallel safe
as $$
  select round(p_amount, 0);
$$;


-- ----------------------------------------------------------------------------
-- Name normalisation
-- ----------------------------------------------------------------------------
-- Used for duplicate detection and CSV ledger matching. HISAB's importer
-- matched on trim+lower alone, so "A. B. Traders" and "A B Traders" were
-- different ledgers (defect F-09). Collapsing punctuation and whitespace here
-- means the importer and the uniqueness index agree on what "the same name"
-- means, rather than each deciding separately.
create or replace function app_private.normalize_name(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', ' ', 'g'));
$$;


-- ============================================================================
-- Statutory identifier validators
-- ============================================================================
-- All immutable and null-tolerant: a null identifier is "not supplied", which
-- is valid on an unregistered party. Only a non-null value is checked. This
-- lets every one of them sit directly in a CHECK constraint without forcing
-- the column to be NOT NULL.
-- ============================================================================

-- PAN: 5 letters, 4 digits, 1 letter. The 4th character encodes holder type
-- (P individual, C company, H HUF, F firm, A AOP, T trust, B BOI, L local
-- authority, J artificial juridical person, G government) and the 5th is the
-- first letter of the surname or entity name. Type consistency against the
-- company's entity_type is checked at the application layer, not here —
-- a mismatch is a warning worth surfacing, not a reason to reject the row.
create or replace function app_private.is_valid_pan(p_pan text)
returns boolean
language sql
immutable
parallel safe
as $$
  select p_pan is null or p_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$';
$$;

-- TAN: 4 letters, 5 digits, 1 letter.
create or replace function app_private.is_valid_tan(p_tan text)
returns boolean
language sql
immutable
parallel safe
as $$
  select p_tan is null or p_tan ~ '^[A-Z]{4}[0-9]{5}[A-Z]$';
$$;

-- IEC has been identical to the holder's PAN since the 2017 harmonisation,
-- so it carries the same shape.
create or replace function app_private.is_valid_iec(p_iec text)
returns boolean
language sql
immutable
parallel safe
as $$
  select p_iec is null or p_iec ~ '^[A-Z]{5}[0-9]{4}[A-Z]$';
$$;

-- IFSC: 4 letters (bank), a reserved 0, then 6 alphanumerics (branch).
create or replace function app_private.is_valid_ifsc(p_ifsc text)
returns boolean
language sql
immutable
parallel safe
as $$
  select p_ifsc is null or p_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$';
$$;

-- Udyam registration number: UDYAM-<state>-<district>-<7 digits>.
create or replace function app_private.is_valid_udyam(p_udyam text)
returns boolean
language sql
immutable
parallel safe
as $$
  select p_udyam is null or p_udyam ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$';
$$;


-- ----------------------------------------------------------------------------
-- GSTIN
-- ----------------------------------------------------------------------------
-- A GSTIN is 15 characters: 2-digit state code, the holder's 10-character PAN,
-- a 1-character entity number for that PAN within the state, the literal 'Z',
-- and a check digit.
--
-- The check digit is what makes this worth doing properly. A regex alone
-- accepts any transposed or mistyped GSTIN, and a wrong GSTIN on a party
-- master propagates into every invoice raised to them and then into GSTR-1,
-- where the mismatch surfaces months later as the recipient's missing credit.
-- Validating the checksum at entry costs nothing and catches most typos.
--
-- Algorithm (GSTN specification): over the first 14 characters, take each
-- character's index in the 36-character alphanumeric set, multiply by an
-- alternating weight of 1 and 2, then add the quotient and remainder of that
-- product divided by 36. The check digit is the character at
-- (36 - (sum mod 36)) mod 36.
create or replace function app_private.gstin_check_digit(p_first14 text)
returns char
language plpgsql
immutable
parallel safe
as $$
declare
  c_charset constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  v_sum int := 0;
  v_index int;
  v_product int;
  i int;
begin
  if p_first14 is null or length(p_first14) <> 14 then
    return null;
  end if;

  for i in 1..14 loop
    -- position() is 1-based; the algorithm needs a 0-based index.
    v_index := position(substr(p_first14, i, 1) in c_charset) - 1;
    if v_index < 0 then
      return null; -- character outside the permitted set
    end if;

    -- Odd positions weigh 1, even positions weigh 2.
    v_product := v_index * (case when i % 2 = 0 then 2 else 1 end);
    v_sum := v_sum + (v_product / 36) + (v_product % 36);
  end loop;

  return substr(c_charset, ((36 - (v_sum % 36)) % 36) + 1, 1);
end;
$$;

create or replace function app_private.is_valid_gstin(p_gstin text)
returns boolean
language plpgsql
immutable
parallel safe
as $$
begin
  if p_gstin is null then
    return true; -- not supplied: valid on an unregistered party
  end if;

  -- Structure. The 14th character is 'Z' for every ordinary registration.
  -- Position 13 (the entity number) may be 1-9 or A-Z once a PAN holds more
  -- than nine registrations in one state.
  if p_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
    return false;
  end if;

  -- The embedded PAN must itself be well formed.
  if not app_private.is_valid_pan(substr(p_gstin, 3, 10)) then
    return false;
  end if;

  return substr(p_gstin, 15, 1) = app_private.gstin_check_digit(substr(p_gstin, 1, 14));
end;
$$;

-- Convenience accessors — used by the tax determination engine, which has to
-- resolve a supply as intra- or inter-state from the supplier's registration
-- against the place of supply. Reading the state out of the GSTIN is cheaper
-- and less error-prone than storing it twice and hoping they agree.
create or replace function app_private.gstin_state_code(p_gstin text)
returns text
language sql
immutable
parallel safe
as $$
  select case when p_gstin is null then null else substr(p_gstin, 1, 2) end;
$$;

create or replace function app_private.gstin_pan(p_gstin text)
returns text
language sql
immutable
parallel safe
as $$
  select case when p_gstin is null then null else substr(p_gstin, 3, 10) end;
$$;
