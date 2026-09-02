-- ============================================================================
-- 1570 — create_branch: you could edit a branch's address but never add a
-- branch, so the Multi-branch module had nothing to manage
-- ============================================================================
-- 1320 added update_branch and a /[companyId]/branches screen, which closed
-- the gap that had made e-invoicing unreachable (no branch address could be
-- set). It left the other half open: there is still no way to CREATE a
-- branch. Confirmed live before writing this — the only branch-related
-- functions in either schema are branch_registration, can_access_branch,
-- prefix_names_the_branch and update_branch. Nothing inserts a branch except
-- create_company's own seeded head office (0014:85).
--
-- Live consequence: 15 of 17 companies have exactly one branch, and the
-- optional Multi-branch module can be switched on to manage a list that can
-- never grow. A real business with a depot in another state cannot represent
-- it at all, which also means it cannot hold that depot's own GSTIN
-- (add_gst_registration attaches a registration TO a branch) or raise an
-- invoice from it.
--
-- WHY AN RPC, when RLS already allows a direct insert. branches_write (0005)
-- is `for all to authenticated` gated on is_company_admin, so an admin can
-- already `insert into branches` straight from the client — and something
-- did exactly that today. The reason this is a function anyway is the
-- side-effect, which a client-side two-step cannot make atomic:
--
--   A BRANCH WITHOUT A GODOWN CANNOT RECORD STOCK. create_company creates
--   one per branch for exactly this reason (0014:89), and 0014 shipped a
--   backfill for older companies whose own comment says so outright:
--   "without one they cannot record stock". Nothing has created a godown for
--   a new branch since, because nothing has created a branch.
--
--   Live proof, found while writing this: 2 of 22 branches have no godown.
--   One is a throwaway from another agent's test today; the other is
--   Sharma Textiles' real "Mumbai Branch", created 22 Aug 2026, which has
--   been unable to record stock ever since. Backfilled at the end of this
--   migration, the same way and for the same reason 0014 backfilled.
--
-- THE GODOWN CODE IS THE FIDDLY PART. godowns_company_id_code_key is unique
-- per COMPANY, not per branch, so a second branch cannot also use 'MAIN' —
-- while godowns_one_default_per_branch_idx is per BRANCH, so each branch
-- does get its own default. The code is therefore derived from the branch
-- code (already unique per company, already ^[A-Z0-9]{1,6}$) rather than
-- fixed, with a numeric suffix as the collision escape. Deriving it from a
-- value the database already guarantees unique is what keeps this from being
-- a guess.
--
-- OUT OF SCOPE, deliberately:
--   * is_head_office — a company has exactly one, enforced by
--     branches_one_head_office_idx and defended by guard_head_office (0005).
--     A new branch is never the head office; moving it is a different
--     operation with its own consequences and belongs in its own change.
--   * gst_registration_id — set by add_gst_registration's own p_branch_id
--     argument, on the Registrations screen. The composite FK
--     (gst_registration_id, company_id, state_code) means attaching a
--     registration is only valid when the states already agree, so it stays
--     where that validation already lives. Same call 1320 made.
--   * Numbering sequences need no seeding: next_voucher_number (0007:80)
--     creates its row lazily with an ON CONFLICT upsert keyed on
--     (company_id, branch_id, voucher_type, financial_year_label), so a new
--     branch's first voucher materialises its own sequence. Verified, not
--     assumed — this was the main thing that could have made a new branch
--     unusable, and it does not.
-- ============================================================================

create or replace function public.create_branch(
  p_company_id uuid,
  p_code text,
  p_name text,
  p_state_code char(2),
  p_address_line1 text default null,
  p_address_line2 text default null,
  p_city text default null,
  p_pincode text default null
) returns uuid
language plpgsql
security invoker   -- RLS decides; only an admin may write a branch
set search_path = ''
as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_name text := trim(coalesce(p_name, ''));
  v_pincode text := nullif(trim(p_pincode), '');
  v_branch_id uuid;
  v_godown_code text;
  v_suffix integer := 1;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can add a branch';
  end if;

  if v_code !~ '^[A-Z0-9]{1,6}$' then
    raise exception 'Branch code must be 1 to 6 characters, letters and digits only — got %',
      coalesce(nullif(v_code, ''), '(blank)');
  end if;

  if v_name = '' then
    raise exception 'Branch name is required';
  end if;

  if exists (select 1 from public.branches
              where company_id = p_company_id and code = v_code) then
    raise exception 'This company already has a branch with code % — codes must be unique because they prefix the branch''s voucher numbers', v_code;
  end if;

  if not exists (select 1 from public.ref_states where code = p_state_code) then
    raise exception '% is not a valid state code', coalesce(p_state_code, '(none)');
  end if;

  if v_pincode is not null and v_pincode !~ '^[1-9][0-9]{5}$' then
    raise exception 'PIN code must be 6 digits and cannot start with 0 — got %', v_pincode;
  end if;

  insert into public.branches (
    company_id, code, name, state_code,
    address_line1, address_line2, city, pincode,
    is_head_office
  ) values (
    p_company_id, v_code, v_name, p_state_code,
    nullif(trim(p_address_line1), ''), nullif(trim(p_address_line2), ''),
    nullif(trim(p_city), ''), v_pincode,
    false
  )
  returning id into v_branch_id;

  -- The godown, without which this branch cannot record stock. Code derived
  -- from the branch code (unique per company by construction, and already
  -- the right character class); numeric suffix only if a godown already
  -- holds that code, since godown codes are unique per company.
  v_godown_code := v_code;
  while exists (
    select 1 from public.godowns
     where company_id = p_company_id and code = v_godown_code
  ) loop
    v_godown_code := left(v_code, 5) || v_suffix::text;
    v_suffix := v_suffix + 1;
    if v_suffix > 9 then
      raise exception 'Could not derive a free godown code from branch code % — rename or remove an existing godown first', v_code;
    end if;
  end loop;

  insert into public.godowns (company_id, branch_id, code, name, is_default)
  values (p_company_id, v_branch_id, v_godown_code, v_name || ' Store', true);

  return v_branch_id;
end;
$$;

revoke all on function public.create_branch(uuid, text, text, char, text, text, text, text) from public, anon;
grant execute on function public.create_branch(uuid, text, text, char, text, text, text, text) to authenticated;

comment on function public.create_branch(uuid, text, text, char, text, text, text, text) is
  'Adds a place of business and, atomically, the default godown without which it could not record stock (the pairing create_company makes at 0014:85-90). Admin-gated to match branches_write RLS (0005). Never creates a head office (exactly one per company, guarded by guard_head_office) and never attaches a GST registration (that is add_gst_registration''s p_branch_id, where the state-match validation already lives). Voucher numbering needs no seeding — next_voucher_number upserts its own sequence row on first use. See 1570 header.';


-- ----------------------------------------------------------------------------
-- Backfill: branches that already exist with no godown
-- ----------------------------------------------------------------------------
-- Same shape and same reason as 0014's own backfill. Sharma Textiles'
-- "Mumbai Branch" (22 Aug 2026) has been unable to record stock since it was
-- created; it is the only real one, the other is a test throwaway that its
-- own agent will remove. Codes derived per company from the branch code with
-- a numeric suffix on collision, matching the function above.
with missing as (
  select b.id as branch_id, b.company_id, b.code, b.name,
         row_number() over (partition by b.company_id order by b.created_at) as n
    from public.branches b
   where not exists (select 1 from public.godowns g where g.branch_id = b.id)
)
insert into public.godowns (company_id, branch_id, code, name, is_default)
select m.company_id, m.branch_id,
       case when exists (
              select 1 from public.godowns g
               where g.company_id = m.company_id and g.code = m.code
            )
            then left(m.code, 5) || m.n::text
            else m.code
       end,
       m.name || ' Store',
       true
  from missing m;
