-- ============================================================================
-- 0651 — employee_perquisites.created_by: give it the default/FK precedent
-- already established (0079, 0095, 0117) uses, missed in 0650
-- ============================================================================
-- 0650 (moments earlier, same session) added employee_perquisites with a
-- bare `created_by uuid` column — declared for future audit use but never
-- wired to anything, so every row inserted through it would carry a NULL
-- created_by forever. Three earlier migrations (0079 tax_payments_and_net_
-- tax, 0095 filing_register, 0117 dsc_register) already established the
-- right shape for this exact column: `default auth.uid()` so it self-fills
-- from the inserting user's JWT without the app having to pass it
-- explicitly, and `references auth.users(id) on delete set null` so a
-- deleted user's historical rows survive with the attribution simply
-- cleared rather than the row itself being blocked or cascaded away. This
-- migration brings employee_perquisites in line rather than leaving it as
-- the one table in this batch that quietly didn't follow the pattern.
-- Column type, nullability and every other constraint are unchanged; no
-- data has been written to created_by yet (0650's UI never sets it), so
-- there is nothing to backfill.
-- ============================================================================

alter table public.employee_perquisites
  add constraint employee_perquisites_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null;

alter table public.employee_perquisites
  alter column created_by set default auth.uid();

comment on column public.employee_perquisites.created_by is
  'Self-fills from auth.uid() on insert (0651, matching the 0079/0095/0117 precedent) — not surfaced or edited by the UI. NULL means either inserted before this default existed or the inserting user was later deleted (on delete set null, not cascaded).';
