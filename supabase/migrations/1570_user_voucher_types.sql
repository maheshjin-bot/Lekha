-- ============================================================================
-- 1570 — User-defined voucher types: a company-chosen NAME for a voucher
--        entry point ("Cash Sale", "Credit Sale", "Bank Payment") that
--        INHERITS everything about how it posts from one of the app's fixed
--        base types, and can override nothing that would change that.
-- ============================================================================
-- WHY THIS SITS BESIDE 0725, NOT ON TOP OF IT
-- ----------------------------------------------------------------------------
-- 0725 (voucher_number_series / voucher_numbering_settings) answers "what
-- number does the next voucher of type X get". This migration answers a
-- different question a preparer actually asks: "which button do I press".
-- TallyPrime-style apps let a company rename and multiply its entry points —
-- "Cash Sale" and "Credit Sale" instead of one generic "Sales" screen — while
-- every such button still posts through the exact same accounting logic.
-- LEKHA has exactly one poster per base type (create_invoice for the four
-- invoice types, create_voucher for the rest — see 0007, extended by 0725).
-- Nothing here adds a second one. A voucher_type_definitions row is a LABEL
-- plus three UI conveniences (a numbering series to preselect, ledgers to
-- pre-fill, a print template to use); posting a voucher created "as" a
-- user-defined type still calls create_voucher/create_invoice with the
-- INHERITED base_type as p_voucher_type, exactly as if no definition existed.
--
-- ----------------------------------------------------------------------------
-- WHY INHERITANCE HERE IS TOTAL AND NON-OVERRIDABLE, BY CONSTRUCTION
-- ----------------------------------------------------------------------------
-- The brief's safety property — "a Cash Sale can never post differently from
-- a plain sales voucher" — is enforced by ABSENCE, not by a runtime check.
-- This table's columns are exhaustively:
--   base_type            which of the app's fixed types this IS, always.
--   name                 what the company calls it. Cosmetic only.
--   default_series_id    a voucher_number_series row to preselect. Reuses
--                         0725's mechanism outright rather than duplicating
--                         it — a definition's numbering behaviour is still
--                         100% governed by voucher_numbering_settings /
--                         next_voucher_number for base_type, unchanged.
--   default_ledgers      jsonb. Explicitly advisory per the brief: a UI hint
--                         for which trading/party ledger to pre-fill. NEVER
--                         read by create_voucher or create_invoice, and no
--                         column here is a foreign key into a posting path,
--                         so a wrong or stale value in it can misfire a form
--                         field, never a debit or a credit.
--   print_template        which print layout to open. Cosmetic only.
-- No column here can select a direction, a tax treatment, a ledger a voucher
-- actually posts to, or a validation rule create_voucher/create_invoice
-- enforces. There is no p_voucher_type_definition_id parameter anywhere in
-- this migration and none is added to any posting RPC — a defined type is a
-- SELECTOR that resolves to base_type before anything is created, never a
-- distinct code path. That is what makes "cannot post differently" true by
-- what does not exist here, rather than by a check this migration could get
-- wrong.
--
-- Not wired into the voucher-type selector UI or any posting call — that is
-- explicitly a separate later step per the brief. This migration only makes
-- the definitions creatable and readable.
--
-- ----------------------------------------------------------------------------
-- BASE_TYPE ENUM — VERIFIED LIVE, NOT COPIED FROM THE 0007 COMMENT THAT
-- NAMED THIS TASK, BECAUSE THAT COMMENT IS STALE
-- ----------------------------------------------------------------------------
-- The task brief pointed at 0007_voucher_engine.sql's original check
-- constraint, ten values. Queried live before writing a line of DDL:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname like '%voucher%type%check%';
-- public.vouchers_voucher_type_check today allows THIRTEEN values — later
-- migrations (job work, delivery challans) extended it after 0007 shipped —
-- and 0725's own voucher_number_series_type_check / voucher_numbering_
-- settings_type_check already carry that same thirteen-value list verbatim,
-- because a numbering series must be nameable for every type vouchers.
-- voucher_type actually accepts. Validating base_type against the stale
-- ten-value list would let a company create a "Cash Sale" fine but forbid a
-- "Job Work Challan (Out)" for no reason the live schema supports, and would
-- silently drift from 0725's own enum the moment anyone compared the two.
-- So base_type here is checked against the SAME thirteen values 0725 uses,
-- copied from that migration's own constraints rather than re-derived, for
-- the identical reason 0725 gives for not re-deriving its own type codes:
-- if this list and vouchers' real constraint ever disagree, a mismatch
-- should fail loudly, not be guessed at twice differently.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. voucher_type_definitions
-- ----------------------------------------------------------------------------
create table public.voucher_type_definitions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  base_type text not null,
  name text not null,
  -- Composite FK below requires this pair to reference a real
  -- voucher_number_series row of the SAME company. Deliberately not required
  -- to also match base_type in a CHECK (a cross-table condition cannot be a
  -- CHECK constraint) — enforced instead in the RPC below, the same division
  -- of labour 0725 itself uses (table CHECKs for single-row rules, RPC body
  -- for cross-row ones).
  default_series_id uuid,
  -- Advisory UI hint only — see header. Never read by create_voucher or
  -- create_invoice.
  default_ledgers jsonb not null default '{}'::jsonb,
  print_template text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, name),
  constraint voucher_type_definitions_base_type_check check (base_type = any (array[
    'receipt','payment','contra','journal','sales','purchase',
    'credit_note','debit_note','branch_transfer','stock_journal',
    'job_work_out','job_work_in','delivery_challan_out'])),
  constraint voucher_type_definitions_name_check
    check (length(btrim(name)) between 1 and 40),
  constraint voucher_type_definitions_print_template_check
    check (print_template is null or length(btrim(print_template)) between 1 and 60),
  constraint voucher_type_definitions_default_ledgers_is_object
    check (jsonb_typeof(default_ledgers) = 'object')
);

-- Composite, per this codebase's standing tenancy rule (see 0725's own
-- series_id FK comment): a bare id FK would let company A's definition point
-- at company B's numbering series.
alter table public.voucher_type_definitions
  add constraint voucher_type_definitions_series_fk
    foreign key (default_series_id, company_id)
    references public.voucher_number_series (id, company_id) on delete set null;

create index voucher_type_definitions_company_base_type_idx
  on public.voucher_type_definitions (company_id, base_type);

create trigger set_updated_at before update on public.voucher_type_definitions
  for each row execute function app_private.set_updated_at();

alter table public.voucher_type_definitions enable row level security;

create policy voucher_type_definitions_read on public.voucher_type_definitions
  for select to authenticated using ((select app_private.is_company_member(company_id)));
-- Admin-gated for the same reason 0725 gates voucher_number_series: this
-- configures what preparers see and pre-fill, company-wide, not a single
-- posting. Direct table writes are still possible for an admin (RLS, not the
-- RPC, is the actual privilege boundary) but the RPC below is the intended
-- entry point because it also does the cross-table base_type/series check a
-- raw insert would skip.
create policy voucher_type_definitions_write on public.voucher_type_definitions
  for all to authenticated
  using ((select app_private.is_company_admin(company_id)))
  with check ((select app_private.is_company_admin(company_id)));

comment on table public.voucher_type_definitions is
  'A company-chosen name for a voucher entry point ("Cash Sale", "Bank Payment") that INHERITS every posting behaviour from one fixed base_type and can override nothing that would change it — only a default numbering series, an advisory jsonb ledger hint, and a print template reference. Not wired into any posting RPC or the voucher-type selector UI; that is a later step. See 1570.';
comment on column public.voucher_type_definitions.base_type is
  'The fixed voucher type this definition IS. Every voucher created "as" this definition still posts via create_voucher/create_invoice with base_type as p_voucher_type — nothing here can change that. Same thirteen-value enum as voucher_number_series.voucher_type (0725), verified live rather than copied from 0007''s original ten-value comment, which later migrations outgrew. See 1570.';
comment on column public.voucher_type_definitions.default_series_id is
  'A voucher_number_series row to preselect for this definition, when the numbering mode for base_type is series (0725). Composite FK to (id, company_id) so it can only ever name a series belonging to the same company; that the series'' own voucher_type equals base_type is checked in create_voucher_type_definition, not here, because that is a cross-table condition no single-table CHECK can express.';
comment on column public.voucher_type_definitions.default_ledgers is
  'UI hint only — e.g. which trading or party ledger to pre-fill. Never read by create_voucher or create_invoice. Advisory by design: a stale or wrong value here can misfire a form field, never a debit or a credit. See 1570.';


-- ----------------------------------------------------------------------------
-- 2. create_voucher_type_definition — the one RPC this migration owns.
--    Modelled on 0725's public.create_voucher_number_series: security
--    definer (RLS gates the table for direct writes; the RPC is definer so
--    it can run the cross-table series/base_type check as one privileged
--    statement rather than depending on the caller also being able to read
--    voucher_number_series), search_path pinned empty, admin-gated via
--    app_private.is_company_admin, friendly exceptions in the preparer's own
--    terms rather than raw constraint names.
-- ----------------------------------------------------------------------------
create or replace function public.create_voucher_type_definition(
  p_company_id uuid,
  p_base_type text,
  p_name text,
  p_default_series_id uuid default null,
  p_default_ledgers jsonb default '{}'::jsonb,
  p_print_template text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_series_type text;
begin
  if not app_private.is_company_admin(p_company_id) then
    raise exception 'Only a company admin can create a voucher type';
  end if;

  if p_base_type not in (
       'receipt','payment','contra','journal','sales','purchase',
       'credit_note','debit_note','branch_transfer','stock_journal',
       'job_work_out','job_work_in','delivery_challan_out') then
    raise exception '% is not a voucher type this app posts. A user-defined voucher type must inherit one of: receipt, payment, contra, journal, sales, purchase, credit_note, debit_note, branch_transfer, stock_journal, job_work_out, job_work_in, delivery_challan_out.',
      p_base_type;
  end if;

  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'A voucher type needs a name';
  end if;

  if p_print_template is not null and length(btrim(p_print_template)) = 0 then
    raise exception 'Print template reference cannot be blank — leave it null instead';
  end if;

  if jsonb_typeof(coalesce(p_default_ledgers, '{}'::jsonb)) <> 'object' then
    raise exception 'Default ledgers must be a JSON object, e.g. {"trading_ledger_id": "..."}, not %', jsonb_typeof(p_default_ledgers);
  end if;

  if exists (select 1 from public.voucher_type_definitions x
              where x.company_id = p_company_id
                and x.name = btrim(p_name)) then
    raise exception 'This company already has a voucher type called "%"', btrim(p_name);
  end if;

  -- A default series that names a DIFFERENT base type would be a UI trap: the
  -- picker would preselect a series next_voucher_number can never actually
  -- draw from for this definition's base_type (0725's next_voucher_number
  -- matches series by voucher_type, not by definition). Caught here, not by
  -- a CHECK, because it is a cross-table condition.
  if p_default_series_id is not null then
    select s.voucher_type into v_series_type
      from public.voucher_number_series s
     where s.id = p_default_series_id and s.company_id = p_company_id;
    if v_series_type is null then
      raise exception 'Numbering series % does not belong to this company', p_default_series_id;
    end if;
    if v_series_type <> p_base_type then
      raise exception 'Numbering series % is a % series, not %. A voucher type''s default series must be one raised for its own base type.',
        p_default_series_id, v_series_type, p_base_type;
    end if;
  end if;

  insert into public.voucher_type_definitions
    (company_id, base_type, name, default_series_id, default_ledgers, print_template, created_by)
  values (p_company_id, p_base_type, btrim(p_name), p_default_series_id,
          coalesce(p_default_ledgers, '{}'::jsonb), nullif(btrim(coalesce(p_print_template, '')), ''), auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_voucher_type_definition(uuid, text, text, uuid, jsonb, text) is
  'Creates a company-scoped voucher type definition naming and inheriting one fixed base_type. Admin only. Validates base_type against the same thirteen-value enum voucher_number_series uses, and — if a default series is named — that it was raised for the same base_type. Overrides only cosmetic/UI fields; posting behaviour is entirely the inherited base_type''s. See 1570.';


-- ----------------------------------------------------------------------------
-- 3. Grants. No table grant statement needed — confirmed live that
--    voucher_number_series (0725) carries no explicit table grant either,
--    because an earlier baseline migration's ALTER DEFAULT PRIVILEGES
--    already hands every new public table SELECT/INSERT/UPDATE/DELETE to
--    anon and authenticated, with RLS (enabled above) as the actual
--    boundary — not the grant. The RPC is the intended write path and is
--    revoked from public/anon, granted to authenticated only — matching
--    0725's own admin-gated RPCs (create_voucher_number_series etc.), which
--    grant to authenticated alone, not service_role, since nothing
--    server-side calls this.
-- ----------------------------------------------------------------------------
revoke all on function public.create_voucher_type_definition(uuid, text, text, uuid, jsonb, text) from public, anon;
grant execute on function public.create_voucher_type_definition(uuid, text, text, uuid, jsonb, text) to authenticated;
