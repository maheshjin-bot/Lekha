-- ============================================================================
-- 1520 — PgUp/PgDn: the next or previous voucher, without a list screen
-- ============================================================================
-- WHY. Tally users move between vouchers with PgUp/PgDn while sitting inside
-- one — no trip back to a list, no re-picking a row. Every voucher screen in
-- this app (the generic voucher form, the invoice editor) opens by id and has
-- no notion of "what comes next", so a preparer keying in a day's vouchers one
-- after another must close each one and hunt the next row in a list that may
-- already have scrolled. This RPC is the one lookup that interaction needs:
-- given where you are, what is immediately before or after it.
--
-- ---------------------------------------------------------------------------
-- ORDERING, AND WHY IT IS A TUPLE COMPARISON
-- ---------------------------------------------------------------------------
-- The book's own order is (voucher_date, sequence_number) — sequence_number
-- is the tie-breaker within a day because it is what the numbering sequence
-- (0007) actually hands out in posting order, and voucher_date alone is not
-- unique. 'prev'/'next' are found with a single row-comparison predicate,
-- (voucher_date, sequence_number) < / > the anchor's own tuple, rather than
-- "same date and smaller sequence, OR earlier date" written out by hand: the
-- tuple form is what lets vouchers_company_type_date_idx (0007) answer it as
-- one index range scan, and it has no seam at a day boundary to get wrong.
-- Strict inequality also does the excluding-the-anchor-itself work for free,
-- including the pathological case of two vouchers of different types sharing
-- a (date, sequence_number) — sequence_number resets per
-- (branch, voucher_type, financial_year_label), so that coincidence is not
-- exotic. Guarded once more anyway with an explicit "id <> anchor" for a
-- reader who does not want to reconstruct that argument to trust the result.
--
-- p_same_type defaults true (PgUp/PgDn inside a sales voucher steps through
-- sales vouchers, not the day's payments) but can be turned off for a single
-- day-book-style walk across every voucher type.
--
-- ---------------------------------------------------------------------------
-- DELIBERATELY NOT BRANCH-SCOPED
-- ---------------------------------------------------------------------------
-- Tally's PgUp/PgDn inside a voucher screen walks the whole company's book,
-- not one branch's slice of it — a Head Office preparer keying vouchers for
-- several branches in one sitting expects the very next voucher chronologi-
-- cally, wherever it was raised. So this function adds no branch_id filter of
-- its own. What a caller sees is still bounded correctly: security invoker
-- runs it as the caller, and vouchers_read (0007) already ANDs
-- can_access_branch(branch_id) into every row, so a user without access to a
-- branch simply never has its vouchers offered as a neighbor — the same
-- guarantee every other reader of this table gets, not a special case here.
--
-- ---------------------------------------------------------------------------
-- WHY security invoker, AND WHY THE ANCHOR IS RE-DERIVED RATHER THAN TRUSTED
-- ---------------------------------------------------------------------------
-- Same rule 1510's own header states: the function runs as the caller, so
-- RLS is the entire access-control story and no p_company_id argument is
-- trusted as authorization — it is scoping, not security. Concretely: the
-- anchor voucher's own company_id/voucher_type/voucher_date/sequence_number
-- are read back from the row itself, filtered by BOTH id = p_voucher_id AND
-- company_id = p_company_id. A caller cannot walk a neighbour's book by
-- passing that company's own voucher id alongside a foreign p_company_id —
-- the lookup simply returns no anchor and the function raises rather than
-- silently answering from whatever company the id actually belongs to.
-- ============================================================================

create or replace function public.get_adjacent_voucher(
  p_company_id uuid,
  p_voucher_id uuid,
  p_direction text,
  p_same_type boolean default true
) returns table (
  id uuid,
  voucher_number text,
  voucher_type text,
  voucher_date date
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_type text;
  v_date date;
  v_seq int;
begin
  if p_direction not in ('prev', 'next') then
    raise exception
      'p_direction must be ''prev'' or ''next'', not %.', coalesce(quote_literal(p_direction), 'null');
  end if;

  select v.voucher_type, v.voucher_date, v.sequence_number
    into v_type, v_date, v_seq
    from public.vouchers v
   where v.id = p_voucher_id
     and v.company_id = p_company_id;

  if not found then
    raise exception 'Voucher not found in this company.';
  end if;

  if p_direction = 'prev' then
    return query
      select v.id, v.voucher_number, v.voucher_type, v.voucher_date
        from public.vouchers v
       where v.company_id = p_company_id
         and not v.is_deleted
         and v.id <> p_voucher_id
         and (not p_same_type or v.voucher_type = v_type)
         and (v.voucher_date, v.sequence_number) < (v_date, v_seq)
       order by v.voucher_date desc, v.sequence_number desc
       limit 1;
  else
    return query
      select v.id, v.voucher_number, v.voucher_type, v.voucher_date
        from public.vouchers v
       where v.company_id = p_company_id
         and not v.is_deleted
         and v.id <> p_voucher_id
         and (not p_same_type or v.voucher_type = v_type)
         and (v.voucher_date, v.sequence_number) > (v_date, v_seq)
       order by v.voucher_date asc, v.sequence_number asc
       limit 1;
  end if;
end;
$$;

-- Revoking from anon ALONE is a no-op in this database (anon inherits
-- PUBLIC's default EXECUTE grant) — PUBLIC must be named explicitly, per the
-- schema-wide allowlist invariant this codebase already pays for once (0064,
-- 0231, and 1510 most recently).
revoke all on function public.get_adjacent_voucher(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.get_adjacent_voucher(uuid, uuid, text, boolean) to authenticated;

comment on function public.get_adjacent_voucher(uuid, uuid, text, boolean) is
  'PgUp/PgDn for a voucher screen (1520): the closest voucher before (''prev'') or after (''next'') p_voucher_id, ordered by (voucher_date, sequence_number), company-wide rather than branch-scoped (matching Tally). Filtered to the anchor''s own voucher_type unless p_same_type is false. Zero rows if there is no neighbour. security invoker: RLS (vouchers_read, including its branch check) is the whole access-control story, and the anchor is re-derived from (id, company_id) rather than trusted from the caller.';
