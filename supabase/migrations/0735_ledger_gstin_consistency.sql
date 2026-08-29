-- A party's GSTIN: make it enterable, and keep it consistent with the two
-- fields it structurally contains.
--
-- THE GAP THIS CLOSES. public.ledgers has carried a `gstin` column with a
-- full validity CHECK (app_private.is_valid_gstin — format, embedded PAN,
-- and check digit) since 0006, and a dozen migrations read it: the GST
-- registers, ISD distribution, GSTR-1 Tables 6A/6B/6C, 12 and 13, GSTR-2B
-- match, ITC-04, the Tally export. But NO screen in the application has ever
-- written it. Confirmed live before writing this: grepping every .ts/.tsx
-- under app/, components/ and lib/ finds not one write to ledgers.gstin —
-- the full ledger screen sets gst_registration_type and stops there, and the
-- quick-add popup did not offer either field. Of 42 party ledgers in this
-- database only 10 carry a GSTIN, every one of them put there by SQL
-- seeding rather than by a user.
--
-- That is a real compliance gap, not a cosmetic one. A registered customer
-- saved without a GSTIN is indistinguishable from an unregistered one, so
-- the invoice lands in the B2C tables of GSTR-1 instead of B2B Table 4A, and
-- build_einvoice_json (0230) refuses it outright because the IRP requires a
-- recipient GSTIN. The number is captured in the UI in the same commit; this
-- migration makes the database refuse the inconsistent states that becomes
-- possible once people can actually type one.
--
-- WHAT IS ENFORCED. A GSTIN is not free text — it is a composite key whose
-- own substrings duplicate two other columns on this row:
--     chars 1-2   state code
--     chars 3-12  PAN
--     char 15     check digit (already enforced by is_valid_gstin)
-- Left unconstrained, a party could claim GSTIN 27ABCDE1234F1Z5 while
-- carrying state_code 07, and every downstream place-of-supply and
-- intra/inter determination would then disagree with the number printed on
-- the invoice. So:
--   1. a GSTIN forces state_code to be its own first two characters;
--   2. a GSTIN and a PAN, both present, must agree;
--   3. a registration type that means "registered" requires a GSTIN;
--   4. 'unregistered' and 'overseas' forbid one — an export customer has no
--      Indian GSTIN, and saying otherwise would be a fabricated number.
--
-- Deliberately NOT enforced: a null gst_registration_type stays permissive.
-- Ten party ledgers predate the field being asked for and there is no honest
-- way to infer whether they are registered; forcing a value would mean
-- guessing on real data.
--
-- SAFE ON EXISTING DATA, verified before writing rather than hoped for. All
-- four conditions were counted live across every ledger in the database:
-- 0 state mismatches, 0 PAN mismatches, 0 registered-without-GSTIN, and
-- 0 unregistered-with-GSTIN. The invariant already held in practice, so this
-- adds no backfill and rejects nothing that exists — it only stops the drift
-- that becomes possible now the fields are editable.

alter table public.ledgers
  add constraint ledgers_gstin_matches_state check (
    gstin is null
    or state_code = substr(gstin, 1, 2)
  );

alter table public.ledgers
  add constraint ledgers_gstin_matches_pan check (
    gstin is null
    or pan is null
    or pan = substr(gstin, 3, 10)
  );

alter table public.ledgers
  add constraint ledgers_registered_has_gstin check (
    gst_registration_type is null
    or gst_registration_type not in
         ('regular', 'composition', 'sez', 'sez_developer', 'uin', 'deemed_export')
    or gstin is not null
  );

alter table public.ledgers
  add constraint ledgers_unregistered_has_no_gstin check (
    gst_registration_type is null
    or gst_registration_type not in ('unregistered', 'overseas')
    or gstin is null
  );

comment on column public.ledgers.gstin is
  'The party''s GSTIN. Its first two characters must equal state_code and '
  'characters 3-12 must equal pan (0735), because those substrings are the '
  'same facts and a disagreement would put the invoice''s place of supply at '
  'odds with the number printed on it. Required when gst_registration_type '
  'says the party is registered; forbidden when unregistered or overseas.';
