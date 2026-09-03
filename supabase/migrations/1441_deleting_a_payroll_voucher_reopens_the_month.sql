-- ============================================================================
-- 1441 — Deleting a payroll voucher must give the month back
-- ============================================================================
-- WHAT THE PILOT SAW. A preparer posted a payroll month, noticed it was wrong,
-- and deleted the journal voucher — the one correction the app offers for any
-- voucher. The month then became impossible to post again, from anywhere in
-- the app, for ever:
--
--   post_payroll_run(...,'2027-03-01')  -> voucher HO/JRN/2026-27/00008
--   delete_voucher(company, that voucher)
--   post_payroll_run(...,'2027-03-01')  -> ERROR: Payroll for Mar 2027 has
--                                          already been posted
--   select from payroll_postings ...    -> the row is still there
--
-- and /reports/payroll-register, which decides whether to show the Post button
-- by looking up exactly that row, shows "posted to the books" with a link to a
-- voucher that no longer exists, and no Post button. There is no unpost
-- function and no screen that can delete a payroll_postings row.
--
-- THE CAUSE, and why the schema already thought it had handled this. 0047 gave
-- payroll_postings.voucher_id "references public.vouchers(id) on delete
-- cascade" — which is the right rule and does nothing at all here, because
-- delete_voucher does not delete anything. It is a SOFT delete:
--
--   update public.vouchers set is_deleted = true, updated_by = auth.uid()
--    where id = p_voucher_id;
--
-- The row survives, so the cascade never fires, so the posting outlives the
-- voucher it exists to point at. Every other consumer of vouchers filters on
-- is_deleted = false; payroll_postings has no such filter because it was
-- relying on a cascade.
--
-- THE FIX, in two places on purpose.
--   1. A trigger on vouchers releases the payroll_postings row the moment
--      is_deleted goes true. This is what makes the app self-correcting: the
--      register goes back to showing the Post button, 1471's lock on the
--      month's salary structures lifts, and the month is postable again — no
--      SQL, no support call. It is the cascade 0047 intended, expressed
--      against the delete this app actually performs.
--   2. post_payroll_run itself no longer treats a posting whose voucher is
--      gone as a posting. This clears anything stranded BEFORE the trigger
--      existed (none today, but the pilot hit exactly this) and any future
--      path that sets is_deleted without going through an UPDATE the trigger
--      sees.
--
-- Releasing the row cascades payroll_posting_lines (1440) with it, which is
-- right: the month was not posted, so there is nothing it paid. The deletion
-- of the voucher itself stays in audit_log, which is where the history of a
-- reversed payroll month belongs.
--
-- AND THE MESSAGE. While the guard is being touched: "Payroll for Mar 2027 has
-- already been posted" does not say what to do about it. It now names the
-- voucher, which is both the evidence and the way out.
-- ============================================================================

create or replace function app_private.release_payroll_posting_on_voucher_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- SECURITY DEFINER because payroll_postings is admin-write (0047) while any
  -- member with voucher write access can delete the voucher. Whoever is
  -- allowed to delete the voucher must not be able to leave the posting
  -- behind — an orphan posting is the bug, not a safeguard.
  delete from public.payroll_postings where voucher_id = new.id;
  return null;
end;
$$;

revoke all on function app_private.release_payroll_posting_on_voucher_delete() from public, anon;
grant execute on function app_private.release_payroll_posting_on_voucher_delete() to authenticated;

comment on function app_private.release_payroll_posting_on_voucher_delete is
  'Releases the payroll_postings row (and, by cascade, its payroll_posting_lines) when the payroll journal voucher it points at is soft-deleted. delete_voucher sets vouchers.is_deleted rather than deleting the row, so the on-delete-cascade payroll_postings was given in 0047 never fires — without this, deleting a payroll voucher locked that month out of being posted again for ever. See 1441.';

drop trigger if exists release_payroll_posting on public.vouchers;

create trigger release_payroll_posting
  after update of is_deleted on public.vouchers
  for each row
  when (new.is_deleted and not coalesce(old.is_deleted, false))
  execute function app_private.release_payroll_posting_on_voucher_delete();

-- ----------------------------------------------------------------------------
-- post_payroll_run: a posting whose voucher is gone is not a posting.
-- Targeted replace over the live definition, asserted — same house pattern as
-- 1200/1230/1240 and 1440.
-- ----------------------------------------------------------------------------
do $mig$
declare
  v_def text;
  v_new text;
  v_from constant text := $a1$  if exists (
    select 1 from public.payroll_postings
     where company_id = p_company_id and period_month = v_period_start
  ) then
    raise exception 'Payroll for % has already been posted', to_char(v_period_start, 'Mon YYYY');
  end if;$a1$;
  v_to constant text := $a2$  -- Deleting the payroll voucher is a legitimate correction, and the month
  -- has to come back when it happens. The trigger added in 1441 releases the
  -- posting as the voucher is deleted; this clears anything stranded before
  -- that trigger existed, or by any path that does not go through an UPDATE
  -- it can see. delete_voucher is a SOFT delete, so "the voucher is gone"
  -- means is_deleted, not a missing row.
  delete from public.payroll_postings pp
   where pp.company_id = p_company_id
     and pp.period_month = v_period_start
     and not exists (
           select 1 from public.vouchers v
            where v.id = pp.voucher_id
              and not v.is_deleted);

  select v.voucher_number into v_posted_as
    from public.payroll_postings pp
    join public.vouchers v on v.id = pp.voucher_id
   where pp.company_id = p_company_id and pp.period_month = v_period_start;

  if v_posted_as is not null then
    raise exception
      'Payroll for % has already been posted, as voucher %. Delete that voucher first if the month has to be posted again.',
      to_char(v_period_start, 'Mon YYYY'), v_posted_as;
  end if;$a2$;
  v_decl_from constant text := $b1$  v_posting_id uuid;
begin$b1$;
  v_decl_to constant text := $b2$  v_posting_id uuid;
  v_posted_as text;
begin$b2$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_payroll_run' and p.prokind = 'f'
   limit 1;

  if v_def is null then
    raise exception '1441: public.post_payroll_run is missing.';
  end if;

  if (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from) <> 1 then
    raise exception '1441: post_payroll_run''s already-posted guard has moved; fix by hand.';
  end if;
  if (length(v_def) - length(replace(v_def, v_decl_from, ''))) / length(v_decl_from) <> 1 then
    raise exception '1441: post_payroll_run''s declare block has moved (1440 not applied?); fix by hand.';
  end if;

  v_new := replace(replace(v_def, v_from, v_to), v_decl_from, v_decl_to);
  execute v_new;
end;
$mig$;

revoke all on function public.post_payroll_run(uuid, uuid, date) from public, anon;
grant execute on function public.post_payroll_run(uuid, uuid, date) to authenticated;

-- Anything already stranded, from before the trigger existed. None on this
-- database at the time of writing (all four postings point at live vouchers);
-- this is here so the fix is complete on any database, not only this one.
delete from public.payroll_postings pp
 where not exists (
   select 1 from public.vouchers v
    where v.id = pp.voucher_id and not v.is_deleted);

comment on table public.payroll_postings is
  'One row per month a company has posted payroll for — the unique (company_id, period_month) is what stops post_payroll_run from double-posting the same month. Points at the single journal voucher that posting created, and is released automatically when that voucher is deleted (1441), so a deleted payroll voucher gives the month back instead of locking it out for ever.';
