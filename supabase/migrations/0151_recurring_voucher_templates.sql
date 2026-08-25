-- ============================================================================
-- 0151 — Recurring vouchers: a template that generates a real voucher on a
-- schedule (monthly rent, a fixed recurring journal), on top of the
-- unmodified public.create_voucher
-- ============================================================================
-- CONFIRMED LIVE BEFORE WRITING ANY OF THIS.
--   - public.create_voucher's real signature (pg_get_function_identity_arguments,
--     read today): (p_company_id uuid, p_branch_id uuid, p_voucher_type text,
--     p_voucher_date date, p_lines jsonb, p_narration text default null,
--     p_reference_number text default null, p_reference_date date default null,
--     p_party_ledger_id uuid default null, p_txn_currency character default
--     'INR', p_exchange_rate numeric default 1, p_rate_source text default
--     null) returns uuid. It is LANGUAGE plpgsql, prosecdef = false (SECURITY
--     INVOKER, not DEFINER) — it relies entirely on the caller's own RLS
--     (vouchers_write / voucher_entries_write: can_write_company(company_id)
--     AND can_access_branch(branch_id)). This migration never redefines it —
--     every function below that posts a voucher just calls it, the exact same
--     way the CSV bulk importers do, and inherits its RLS model unchanged
--     rather than re-deciding who is allowed to post.
--   - Its p_lines shape, read from pg_get_functiondef: an array of
--     {ledger_id, debit_amount, credit_amount, branch_id?, fc_amount?,
--     dimensions?, narration?, line_order?} — branch_id/fc_amount/dimensions
--     all optional per line. This migration's templates never set a per-line
--     branch_id or dimensions; every generated line posts to the template's
--     own single branch_id, in INR only (see SCOPE below).
--   - vouchers.voucher_type's own CHECK (pg_get_constraintdef, read today)
--     allows 13 values. This migration restricts recurring templates to
--     exactly 4 of them: 'receipt', 'payment', 'contra', 'journal'.
--     'sales'/'purchase'/'credit_note'/'debit_note' need create_invoice's own
--     item/GST/TCS computation, not create_voucher's plain ledger-lines shape
--     — and create_invoice/update_invoice are explicitly off-limits to this
--     task (another task in this batch, line-level-discounts, owns them).
--     'stock_journal'/'branch_transfer'/'job_work_out'/'job_work_in'/
--     'delivery_challan_out' are item/quantity-level stock movements — a
--     recurring "monthly rent" style template has nothing to put in an item
--     line, and inventing a fake item-less stock voucher would be worse than
--     not offering the type. Both exclusions are enforced by an explicit
--     CHECK on recurring_voucher_templates.voucher_type, not left to
--     create_voucher to reject after the fact — this feature only ever
--     builds a p_lines array of plain ledger debits/credits, so calling
--     create_voucher with 'sales' would technically succeed at the SQL level
--     (create_voucher does not itself branch on voucher_type beyond number-
--     series prefixing) but would silently produce an invoice-shaped voucher
--     with no items, no GST, no HSN — a real correctness trap this migration
--     closes off at the door instead.
--   - trg_voucher_entries_balance (0007-era, read via pg_get_triggerdef
--     today): a DEFERRABLE INITIALLY DEFERRED constraint trigger enforcing
--     total debits = total credits per voucher, firing at COMMIT of the
--     whole transaction, not per-statement. This migration's own
--     app_private.validate_recurring_lines rejects an unbalanced template at
--     SAVE time (create/update), so generation should never actually reach
--     that deferred check — but because it fires at commit, not per-
--     statement, a hypothetical unbalanced line that slipped past validation
--     would fail the WHOLE generate_due_recurring_vouchers call at COMMIT,
--     not just the one template's per-template exception handler below (see
--     that function's own comment, and caveats_for_integration in the
--     session report).
--   - vouchers has an unconditional `audit` AFTER INSERT/UPDATE/DELETE
--     trigger (app_private.audit_change) and voucher_entries has the same —
--     both already fire for anything create_voucher inserts, recurring or
--     not. NO separate audit-trail work is needed here: a recurring-
--     generated voucher is indistinguishable from a manually entered one in
--     the Rule 3(1) audit-trail viewer except for its narration text and its
--     row in recurring_voucher_generation_log (this migration's own link,
--     for the UI's "generated from template X" display).
--   - vouchers also has an unconditional `enforce_period_open` BEFORE
--     trigger. A template whose next_run_date falls inside a locked
--     accounting period will have its create_voucher call raise exactly the
--     same way a manual entry into a locked period would — caught by this
--     migration's own per-run exception handler (see
--     generate_due_recurring_vouchers), reported as a 'failed' row, and
--     next_run_date is deliberately NOT advanced past it, so the same due
--     date keeps surfacing every time "Generate" is run until the period is
--     reopened or the template is deactivated. A real, stated limitation,
--     not a bug — recorded in scope_deferred.
--
-- MANUAL "GENERATE NOW", NOT A SILENT pg_cron AUTO-POST — a deliberate
-- choice, not a default followed blindly. 0122 (email-notifications
-- digest) already established the pattern for a daily pg_cron job in this
-- schema: app_private.run_notifications_digest(), read live today, is a
-- SECURITY DEFINER function revoked from authenticated, scheduled via
-- cron.schedule(...) running as the 'postgres' superuser, and it only ever
-- WRITES ROWS (notifications) — nothing in that job sends an email itself;
-- the actual send is a separate, explicitly human-triggered step (an
-- admin's "Send pending emails" click). This migration deliberately does
-- NOT follow 0122's cron half for the posting step itself, because the two
-- actions are not equivalent: a notification row is inert until a human
-- reads or sends it, but a generated journal/payment/receipt/contra voucher
-- is a REAL, LIVE ENTRY IN THE BOOKS the instant create_voucher returns —
-- it moves account balances, appears in the trial balance and every report
-- immediately, and (per enforce_period_open above) can even be rejected
-- outright by a locked period with no human in the loop to notice or react.
-- An unattended cron job silently posting journal entries with nobody
-- reviewing them first is a real risk this task's own brief calls out
-- explicitly. So: public.generate_due_recurring_vouchers is a plain
-- SECURITY INVOKER function, run under the CALLING USER's own RLS
-- (can_write_company + can_access_branch, exactly what a manual voucher
-- entry already requires) — there is no cron.schedule() call anywhere in
-- this migration. The UI (see below) shows what is due and requires one
-- click to confirm and post. list_recurring_voucher_templates's own is_due
-- flag is what a future "N recurring vouchers due" dashboard/notification
-- item could read, without this migration deciding that integration itself.
--
-- SCHEMA SHAPE: NORMALIZED LINES, NOT A BARE jsonb BLOB. Template lines are
-- their own table (recurring_voucher_template_lines), one row per ledger
-- line, mirroring how voucher_entries itself is normalized rather than
-- jsonb — editable one line at a time in the UI, FK-checked against
-- public.ledgers per line, and only ever assembled into the jsonb shape
-- create_voucher itself expects at the moment of generation (both in
-- list_recurring_voucher_templates, for the edit form, and in
-- generate_due_recurring_vouchers, for the actual call). A bare jsonb
-- column would need its own duplicate ledger-existence/company-membership
-- validation logic living only inside application code; a real table gets
-- it from the same FK machinery every other tenant-scoped table already has.
--
-- SCHEDULING: day_of_month (1-31) + frequency (monthly/quarterly/yearly), no
-- statutory basis to research here — this is a scheduling/UX convention,
-- not a tax rule. Clamped to the LAST DAY of a shorter target month exactly
-- once (a day_of_month=31 template due in February posts on the 28th/29th),
-- then RESUMES 31 in a later 31-day month, because app_private.
-- recurring_step_date re-anchors from the template's own actual last
-- next_run_date each time it steps forward, not from day_of_month alone —
-- the same "clamp for this month only, don't get stuck" convention most
-- recurring-billing schedulers use. Documented explicitly in the UI copy so
-- a Feb-clamped run doesn't look like a bug.
--
-- IMMUTABLE AFTER CREATION: branch_id, voucher_type, frequency,
-- day_of_month, start_date. public.update_recurring_voucher_template's own
-- signature has no parameter for any of them — deliberately mirroring
-- update_voucher's own real signature (read live today: no p_branch_id, no
-- p_voucher_type parameter either — an existing voucher's branch and type
-- can never be changed after the fact, only its date/lines/narration/
-- reference/party). Changing what a recurring template even IS (which
-- branch, which voucher type, how often, which day) after it may already
-- have run once is a schedule-identity change, not an edit — deactivate the
-- old template and create a new one instead. Said explicitly in the UI.
--
-- IDEMPOTENCY — THE MOST LIKELY PLACE FOR A REAL BUG, PER THE TASK BRIEF,
-- SO IT GETS TWO INDEPENDENT GUARDS, NOT ONE.
--   1. recurring_voucher_generation_log has a UNIQUE (template_id, run_date)
--      index. generate_due_recurring_vouchers INSERTs into that log FIRST,
--      via ON CONFLICT DO NOTHING, and only calls create_voucher if that
--      insert actually won a row — this is a real, DB-enforced guard against
--      two concurrent calls (two admins both clicking "Generate now" at the
--      same moment) racing to post the same run_date twice, not just a
--      "check next_run_date first" convention that a race could slip past.
--   2. Once a run succeeds, next_run_date is advanced past that run_date in
--      the same function call, so a later, non-concurrent re-run for the
--      same p_as_of simply finds nothing due for that template any more.
--   Verified live in this session's own report, not just asserted here: see
--   live_verification.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- recurring_voucher_templates
-- ----------------------------------------------------------------------------
create table public.recurring_voucher_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,

  template_name text not null check (length(trim(template_name)) > 0),
  voucher_type text not null check (voucher_type in ('receipt', 'payment', 'contra', 'journal')),
  frequency text not null check (frequency in ('monthly', 'quarterly', 'yearly')),
  day_of_month smallint not null check (day_of_month between 1 and 31),

  start_date date not null,
  end_date date,
  next_run_date date not null,
  is_active boolean not null default true,

  narration_template text,
  party_ledger_id uuid,

  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint recurring_voucher_templates_end_after_start
    check (end_date is null or end_date >= start_date),
  constraint recurring_voucher_templates_next_run_not_before_start
    check (next_run_date >= start_date),

  unique (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (party_ledger_id, company_id) references public.ledgers (id, company_id)
);

create index recurring_voucher_templates_due_idx
  on public.recurring_voucher_templates (company_id, next_run_date)
  where is_active;

alter table public.recurring_voucher_templates enable row level security;
revoke all on public.recurring_voucher_templates from anon;

create policy recurring_voucher_templates_read on public.recurring_voucher_templates
  for select using (app_private.is_company_member(company_id));

create policy recurring_voucher_templates_write on public.recurring_voucher_templates
  for all
  using (app_private.can_write_company(company_id) and app_private.can_access_branch(branch_id))
  with check (app_private.can_write_company(company_id) and app_private.can_access_branch(branch_id));

comment on table public.recurring_voucher_templates is
  'A schedule + a reusable set of ledger lines that public.generate_due_recurring_vouchers turns into a real posted voucher via the unmodified public.create_voucher. voucher_type is restricted to receipt/payment/contra/journal — the four types create_voucher''s plain ledger-lines shape actually supports; sales/purchase/credit_note/debit_note need create_invoice instead. branch_id/voucher_type/frequency/day_of_month/start_date are immutable after creation (see update_recurring_voucher_template) — deactivate and recreate to change any of them. See 0151.';
comment on column public.recurring_voucher_templates.day_of_month is
  'Target day, 1-31. Clamped to the last day of a shorter target month (e.g. 31 in February -> 28th/29th) by app_private.recurring_step_date, then resumes the requested day once a long-enough month comes around again — the schedule re-anchors from the template''s own actual last next_run_date each step, it does not stay clamped forever.';
comment on column public.recurring_voucher_templates.next_run_date is
  'The next date this template is due to generate a voucher for. Advanced by generate_due_recurring_vouchers only after a voucher for the current next_run_date has actually been posted (and logged in recurring_voucher_generation_log) — never advanced on failure, so a failed run keeps surfacing as due until it succeeds or the template is deactivated.';
comment on column public.recurring_voucher_templates.narration_template is
  'Plain text copied verbatim onto every generated voucher''s narration (falls back to "<template name> (recurring)" if left blank) — not a mail-merge template with date substitution; that is out of scope for this pass, see scope_deferred.';


-- ----------------------------------------------------------------------------
-- recurring_voucher_template_lines
-- ----------------------------------------------------------------------------
create table public.recurring_voucher_template_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  template_id uuid not null,
  ledger_id uuid not null,

  debit_amount numeric(14, 2) not null default 0,
  credit_amount numeric(14, 2) not null default 0,
  narration text,
  line_order int not null default 0,

  constraint recurring_voucher_template_lines_amount_check check (
    debit_amount >= 0 and credit_amount >= 0
    and not (debit_amount > 0 and credit_amount > 0)
    and (debit_amount > 0 or credit_amount > 0)
  ),

  foreign key (template_id, company_id) references public.recurring_voucher_templates (id, company_id) on delete cascade,
  foreign key (ledger_id, company_id) references public.ledgers (id, company_id)
);

create index recurring_voucher_template_lines_template_idx
  on public.recurring_voucher_template_lines (template_id);

alter table public.recurring_voucher_template_lines enable row level security;
revoke all on public.recurring_voucher_template_lines from anon;

create policy recurring_voucher_template_lines_read on public.recurring_voucher_template_lines
  for select using (app_private.is_company_member(company_id));

create policy recurring_voucher_template_lines_write on public.recurring_voucher_template_lines
  for all
  using (app_private.can_write_company(company_id))
  with check (app_private.can_write_company(company_id));

comment on table public.recurring_voucher_template_lines is
  'One row per ledger line of a recurring_voucher_templates row — exactly one of debit_amount/credit_amount is greater than zero per line, same convention voucher_entries itself uses. Written only through create_recurring_voucher_template / update_recurring_voucher_template (both full-replace the line set), never a direct partial-line edit. See 0151.';


-- ----------------------------------------------------------------------------
-- recurring_voucher_generation_log — the idempotency guard + audit trail of
-- which template generated which real voucher, for which due date.
-- ----------------------------------------------------------------------------
create table public.recurring_voucher_generation_log (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  template_id uuid not null,
  run_date date not null,
  voucher_id uuid references public.vouchers(id) on delete set null,
  generated_by uuid references auth.users(id) on delete set null,
  generated_at timestamptz not null default now(),

  foreign key (template_id, company_id) references public.recurring_voucher_templates (id, company_id) on delete cascade,
  unique (template_id, run_date)
);

create index recurring_voucher_generation_log_template_idx
  on public.recurring_voucher_generation_log (template_id, run_date desc);

alter table public.recurring_voucher_generation_log enable row level security;
revoke all on public.recurring_voucher_generation_log from anon;

create policy recurring_voucher_generation_log_read on public.recurring_voucher_generation_log
  for select using (app_private.is_company_member(company_id));

create policy recurring_voucher_generation_log_write on public.recurring_voucher_generation_log
  for all
  using (app_private.can_write_company(company_id))
  with check (app_private.can_write_company(company_id));

comment on table public.recurring_voucher_generation_log is
  'One row per (template, run_date) that has actually been generated. The UNIQUE (template_id, run_date) index IS the idempotency guarantee: generate_due_recurring_vouchers inserts here (ON CONFLICT DO NOTHING) BEFORE calling create_voucher, and only posts if that insert won a row — a second concurrent or repeated call for the same due date finds the conflict and skips, it never posts twice. voucher_id set null on the referenced voucher''s own deletion deliberately preserves the row: "this due date already ran" must survive someone deleting the resulting voucher, or it would silently regenerate on the next run. See 0151.';


-- ----------------------------------------------------------------------------
-- app_private.recurring_step_date — the one place month-arithmetic +
-- day-of-month clamping happens, used both to seed next_run_date at
-- creation and to advance it after each successful generation.
-- ----------------------------------------------------------------------------
create or replace function app_private.recurring_step_date(
  p_anchor date,
  p_frequency text,
  p_day_of_month int,
  p_period_offset int default 0
) returns date
language plpgsql
immutable
set search_path to ''
as $function$
declare
  v_months int;
  v_month_start date;
  v_month_end date;
  v_day int;
begin
  v_months := case p_frequency
    when 'monthly' then 1
    when 'quarterly' then 3
    when 'yearly' then 12
    else null
  end;
  if v_months is null then
    raise exception '% is not a recognised recurring-voucher frequency (expected monthly, quarterly or yearly)', p_frequency;
  end if;
  if p_day_of_month is null or p_day_of_month < 1 or p_day_of_month > 31 then
    raise exception 'day_of_month must be between 1 and 31, got %', p_day_of_month;
  end if;

  v_month_start := (date_trunc('month', p_anchor) + make_interval(months => v_months * p_period_offset))::date;
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;
  v_day := least(p_day_of_month, extract(day from v_month_end)::int);

  return v_month_start + (v_day - 1);
end;
$function$;

comment on function app_private.recurring_step_date(date, text, int, int) is
  'Given an anchor date, steps p_period_offset whole periods (monthly=1/quarterly=3/yearly=12 months) forward from the START OF THE ANCHOR''S MONTH, landing on p_day_of_month clamped to that target month''s actual last day. p_period_offset=0 with p_anchor=start_date is how create_recurring_voucher_template seeds the first next_run_date; p_period_offset=1 with p_anchor=the run_date just generated is how generate_due_recurring_vouchers advances past it. Re-anchoring from the actual last run (not the original start_date) is what stops a day_of_month=31 template from getting stuck at 28 forever after one February. See 0151.';

revoke all on function app_private.recurring_step_date(date, text, int, int) from public, anon;
grant execute on function app_private.recurring_step_date(date, text, int, int) to authenticated;


-- ----------------------------------------------------------------------------
-- app_private.validate_recurring_lines — shared by create + update, exactly
-- the discipline create_invoice/create_voucher themselves apply at insert
-- time (a line needs a real ledger in this company, a real amount on
-- exactly one side, the whole set must balance) — checked eagerly here so a
-- template can never be SAVED unbalanced, which is what lets
-- generate_due_recurring_vouchers trust the deferred balance trigger will
-- never actually fire (see this migration's header).
-- ----------------------------------------------------------------------------
create or replace function app_private.validate_recurring_lines(p_company_id uuid, p_lines jsonb)
returns void
language plpgsql
set search_path to ''
as $function$
declare
  v_line jsonb;
  v_ledger_id uuid;
  v_debit numeric;
  v_credit numeric;
  v_debit_total numeric := 0;
  v_credit_total numeric := 0;
begin
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) < 2 then
    raise exception 'A recurring voucher template needs at least two ledger lines';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_ledger_id := (v_line ->> 'ledger_id')::uuid;
    v_debit := coalesce((v_line ->> 'debit_amount')::numeric, 0);
    v_credit := coalesce((v_line ->> 'credit_amount')::numeric, 0);

    if v_ledger_id is null then
      raise exception 'Every line needs a ledger';
    end if;
    if not exists (select 1 from public.ledgers where id = v_ledger_id and company_id = p_company_id) then
      raise exception 'Ledger % does not belong to this company', v_ledger_id;
    end if;
    if v_debit < 0 or v_credit < 0 then
      raise exception 'Amounts cannot be negative';
    end if;
    if v_debit > 0 and v_credit > 0 then
      raise exception 'A line cannot carry both a debit and a credit amount';
    end if;
    if v_debit = 0 and v_credit = 0 then
      raise exception 'Every line needs either a debit or a credit amount greater than zero';
    end if;

    v_debit_total := v_debit_total + v_debit;
    v_credit_total := v_credit_total + v_credit;
  end loop;

  if round(v_debit_total, 2) <> round(v_credit_total, 2) then
    raise exception 'This template does not balance: debits % vs credits %', round(v_debit_total, 2), round(v_credit_total, 2);
  end if;
  if v_debit_total <= 0 then
    raise exception 'A recurring voucher template must come to more than zero';
  end if;
end;
$function$;

revoke all on function app_private.validate_recurring_lines(uuid, jsonb) from public, anon;
grant execute on function app_private.validate_recurring_lines(uuid, jsonb) to authenticated;


-- ----------------------------------------------------------------------------
-- create_recurring_voucher_template
-- ----------------------------------------------------------------------------
create or replace function public.create_recurring_voucher_template(
  p_company_id uuid,
  p_branch_id uuid,
  p_template_name text,
  p_voucher_type text,
  p_frequency text,
  p_day_of_month int,
  p_start_date date,
  p_lines jsonb,
  p_end_date date default null,
  p_party_ledger_id uuid default null,
  p_narration_template text default null
) returns uuid
language plpgsql
set search_path to ''
as $function$
declare
  v_template_id uuid;
  v_next_run_date date;
  v_line jsonb;
  v_line_order int := 0;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to create a recurring voucher template for this company';
  end if;
  if not app_private.can_access_branch(p_branch_id) then
    raise exception 'Not permitted to post to this branch';
  end if;
  if p_voucher_type not in ('receipt', 'payment', 'contra', 'journal') then
    raise exception '% cannot be used as a recurring voucher template — only receipt, payment, contra and journal are supported (sales/purchase/credit_note/debit_note need create_invoice''s own tax computation; stock/job-work/branch-transfer vouchers need item-level detail this template does not carry)', p_voucher_type;
  end if;

  perform app_private.validate_recurring_lines(p_company_id, p_lines);

  v_next_run_date := app_private.recurring_step_date(p_start_date, p_frequency, p_day_of_month, 0);
  if v_next_run_date < p_start_date then
    v_next_run_date := app_private.recurring_step_date(p_start_date, p_frequency, p_day_of_month, 1);
  end if;

  insert into public.recurring_voucher_templates (
    company_id, branch_id, template_name, voucher_type, frequency, day_of_month,
    start_date, end_date, next_run_date, narration_template, party_ledger_id,
    created_by, updated_by
  ) values (
    p_company_id, p_branch_id, trim(p_template_name), p_voucher_type, p_frequency, p_day_of_month,
    p_start_date, p_end_date, v_next_run_date, nullif(trim(coalesce(p_narration_template, '')), ''), p_party_ledger_id,
    auth.uid(), auth.uid()
  ) returning id into v_template_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into public.recurring_voucher_template_lines (
      company_id, template_id, ledger_id, debit_amount, credit_amount, narration, line_order
    ) values (
      p_company_id, v_template_id, (v_line ->> 'ledger_id')::uuid,
      coalesce((v_line ->> 'debit_amount')::numeric, 0), coalesce((v_line ->> 'credit_amount')::numeric, 0),
      nullif(v_line ->> 'narration', ''), v_line_order
    );
    v_line_order := v_line_order + 1;
  end loop;

  return v_template_id;
end;
$function$;

comment on function public.create_recurring_voucher_template(uuid, uuid, text, text, text, int, date, jsonb, date, uuid, text) is
  'Creates a recurring voucher template and its lines (full set, p_lines shape: [{"ledger_id","debit_amount","credit_amount","narration"}]). Computes the first next_run_date from p_start_date/p_frequency/p_day_of_month via app_private.recurring_step_date — the earliest valid occurrence on or after p_start_date, never before it. See 0151.';

revoke all on function public.create_recurring_voucher_template(uuid, uuid, text, text, text, int, date, jsonb, date, uuid, text) from public, anon;
grant execute on function public.create_recurring_voucher_template(uuid, uuid, text, text, text, int, date, jsonb, date, uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- update_recurring_voucher_template — deliberately narrow, see migration
-- header ("IMMUTABLE AFTER CREATION"). Full-replace of the line set, same
-- discipline update_voucher/update_invoice already use for voucher_entries.
-- ----------------------------------------------------------------------------
create or replace function public.update_recurring_voucher_template(
  p_template_id uuid,
  p_template_name text,
  p_lines jsonb,
  p_end_date date default null,
  p_party_ledger_id uuid default null,
  p_narration_template text default null
) returns uuid
language plpgsql
set search_path to ''
as $function$
declare
  v_company_id uuid;
  v_start_date date;
  v_line jsonb;
  v_line_order int := 0;
begin
  select company_id, start_date into v_company_id, v_start_date
    from public.recurring_voucher_templates where id = p_template_id;

  if v_company_id is null then
    raise exception 'Recurring voucher template not found';
  end if;
  if not app_private.can_write_company(v_company_id) then
    raise exception 'Not permitted to edit this recurring voucher template';
  end if;
  if p_end_date is not null and p_end_date < v_start_date then
    raise exception 'End date cannot be before the template''s start date (%)', v_start_date;
  end if;

  perform app_private.validate_recurring_lines(v_company_id, p_lines);

  update public.recurring_voucher_templates
     set template_name = trim(p_template_name),
         end_date = p_end_date,
         party_ledger_id = p_party_ledger_id,
         narration_template = nullif(trim(coalesce(p_narration_template, '')), ''),
         updated_by = auth.uid(),
         updated_at = now()
   where id = p_template_id;

  delete from public.recurring_voucher_template_lines where template_id = p_template_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    insert into public.recurring_voucher_template_lines (
      company_id, template_id, ledger_id, debit_amount, credit_amount, narration, line_order
    ) values (
      v_company_id, p_template_id, (v_line ->> 'ledger_id')::uuid,
      coalesce((v_line ->> 'debit_amount')::numeric, 0), coalesce((v_line ->> 'credit_amount')::numeric, 0),
      nullif(v_line ->> 'narration', ''), v_line_order
    );
    v_line_order := v_line_order + 1;
  end loop;

  return p_template_id;
end;
$function$;

comment on function public.update_recurring_voucher_template(uuid, text, jsonb, date, uuid, text) is
  'Edits a recurring voucher template''s name, lines, end date, party ledger and narration template — full-replace of the line set. Deliberately has NO parameter for branch_id/voucher_type/frequency/day_of_month/start_date (mirrors update_voucher''s own real signature, which likewise omits branch_id/voucher_type) — those define what the schedule IS, not what it says; deactivate and recreate to change any of them. See 0151.';

revoke all on function public.update_recurring_voucher_template(uuid, text, jsonb, date, uuid, text) from public, anon;
grant execute on function public.update_recurring_voucher_template(uuid, text, jsonb, date, uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- set_recurring_voucher_template_active — pause/resume without touching the
-- schedule or lines.
-- ----------------------------------------------------------------------------
create or replace function public.set_recurring_voucher_template_active(p_template_id uuid, p_is_active boolean)
returns void
language plpgsql
set search_path to ''
as $function$
declare
  v_company_id uuid;
begin
  select company_id into v_company_id from public.recurring_voucher_templates where id = p_template_id;
  if v_company_id is null then
    raise exception 'Recurring voucher template not found';
  end if;
  if not app_private.can_write_company(v_company_id) then
    raise exception 'Not permitted to change this recurring voucher template';
  end if;

  update public.recurring_voucher_templates
     set is_active = p_is_active, updated_by = auth.uid(), updated_at = now()
   where id = p_template_id;
end;
$function$;

comment on function public.set_recurring_voucher_template_active(uuid, boolean) is
  'Pauses (is_active=false) or resumes (true) a template without touching next_run_date, so resuming a paused template picks up exactly where it left off rather than skipping the paused period. See 0151.';

revoke all on function public.set_recurring_voucher_template_active(uuid, boolean) from public, anon;
grant execute on function public.set_recurring_voucher_template_active(uuid, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- list_recurring_voucher_templates — powers the /recurring-vouchers screen:
-- the list, the edit form's pre-fill (lines as jsonb), and the "due" badge.
-- ----------------------------------------------------------------------------
create or replace function public.list_recurring_voucher_templates(p_company_id uuid)
returns table (
  id uuid,
  template_name text,
  voucher_type text,
  frequency text,
  day_of_month smallint,
  branch_id uuid,
  branch_name text,
  start_date date,
  end_date date,
  next_run_date date,
  is_active boolean,
  is_due boolean,
  narration_template text,
  party_ledger_id uuid,
  party_ledger_name text,
  line_count integer,
  template_amount numeric,
  lines jsonb,
  last_run_date date,
  last_run_voucher_id uuid,
  last_run_voucher_number text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    t.id, t.template_name, t.voucher_type, t.frequency, t.day_of_month,
    t.branch_id, b.name,
    t.start_date, t.end_date, t.next_run_date, t.is_active,
    (t.is_active and t.next_run_date <= current_date
      and (t.end_date is null or t.next_run_date <= t.end_date)) as is_due,
    t.narration_template, t.party_ledger_id, pl.name,
    (select count(*) from public.recurring_voucher_template_lines l where l.template_id = t.id)::int,
    (select coalesce(sum(l.debit_amount), 0) from public.recurring_voucher_template_lines l where l.template_id = t.id),
    (select coalesce(jsonb_agg(jsonb_build_object(
        'ledger_id', l.ledger_id, 'ledger_name', led.name,
        'debit_amount', l.debit_amount, 'credit_amount', l.credit_amount,
        'narration', l.narration, 'line_order', l.line_order
      ) order by l.line_order), '[]'::jsonb)
     from public.recurring_voucher_template_lines l
     join public.ledgers led on led.id = l.ledger_id
     where l.template_id = t.id),
    lr.last_run_date, lr.voucher_id, v.voucher_number
  from public.recurring_voucher_templates t
  join public.branches b on b.id = t.branch_id
  left join public.ledgers pl on pl.id = t.party_ledger_id
  left join lateral (
    select g.run_date as last_run_date, g.voucher_id
      from public.recurring_voucher_generation_log g
     where g.template_id = t.id
     order by g.run_date desc
     limit 1
  ) lr on true
  left join public.vouchers v on v.id = lr.voucher_id
  where t.company_id = p_company_id
  order by t.is_active desc, t.next_run_date, t.template_name;
$$;

comment on function public.list_recurring_voucher_templates(uuid) is
  'One row per recurring voucher template with its lines pre-assembled as jsonb (for the edit form) and its most recent generation (last_run_date/last_run_voucher_id/last_run_voucher_number, from recurring_voucher_generation_log). is_due mirrors exactly the WHERE clause generate_due_recurring_vouchers itself uses, evaluated against current_date, so the UI''s "due" badge and the generator''s own selection can never silently disagree. See 0151.';

revoke all on function public.list_recurring_voucher_templates(uuid) from public, anon;
grant execute on function public.list_recurring_voucher_templates(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- generate_due_recurring_vouchers — the manual "Generate now" action. See
-- migration header for why this is not a pg_cron job. SECURITY INVOKER
-- (the default — no security definer here), so every voucher it posts goes
-- through create_voucher under the CALLING USER's own RLS, exactly as if
-- they had entered it by hand.
-- ----------------------------------------------------------------------------
create or replace function public.generate_due_recurring_vouchers(
  p_company_id uuid,
  p_as_of date default current_date,
  p_template_ids uuid[] default null
) returns table (
  template_id uuid,
  template_name text,
  run_date date,
  voucher_id uuid,
  voucher_number text,
  status text
)
language plpgsql
set search_path to ''
as $function$
declare
  v_template record;
  v_lines jsonb;
  v_run_date date;
  v_log_id uuid;
  v_voucher_id uuid;
  v_voucher_number text;
  v_iterations int;
  v_new_next_run_date date;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to generate recurring vouchers for this company';
  end if;

  for v_template in
    select t.* from public.recurring_voucher_templates t
     where t.company_id = p_company_id
       and t.is_active
       and t.next_run_date <= p_as_of
       and (t.end_date is null or t.next_run_date <= t.end_date)
       and (p_template_ids is null or t.id = any (p_template_ids))
     order by t.next_run_date, t.template_name
  loop
    if not app_private.can_access_branch(v_template.branch_id) then
      -- Caller cannot post to this template's branch — skip it silently
      -- rather than aborting every OTHER due template's generation in the
      -- same call. RLS on the eventual create_voucher insert would reject it
      -- anyway; checking here avoids paying for a failed insert to find out.
      continue;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
             'ledger_id', l.ledger_id,
             'debit_amount', l.debit_amount,
             'credit_amount', l.credit_amount,
             'narration', l.narration,
             'line_order', l.line_order
           ) order by l.line_order), '[]'::jsonb)
      into v_lines
      from public.recurring_voucher_template_lines l
     where l.template_id = v_template.id;

    v_iterations := 0;

    -- A while-loop, not a single generate: a template last run two months
    -- ago and only just re-enabled catches up one voucher per missed period
    -- (real rent that was genuinely due each of those months), not silently
    -- fast-forwarded to today. Capped at 60 periods (5 years of monthly) as
    -- a sanity backstop against a corrupted next_run_date looping forever.
    while v_iterations < 60
      and v_template.is_active
      and v_template.next_run_date <= p_as_of
      and (v_template.end_date is null or v_template.next_run_date <= v_template.end_date)
    loop
      v_iterations := v_iterations + 1;
      v_run_date := v_template.next_run_date;

      -- THE IDEMPOTENCY GUARD (see migration header): claim this run_date
      -- before doing anything else. A concurrent call that loses this race
      -- gets zero rows back and moves on without posting.
      -- ON CONFLICT ON CONSTRAINT, not a bare (template_id, run_date) column
      -- list: this function's own RETURNS TABLE declares an OUT parameter
      -- also named template_id, and plpgsql's expression substitution makes
      -- a bare column-list conflict target genuinely ambiguous between that
      -- variable and the table column (confirmed live — see
      -- live_verification in the session report for the exact error this
      -- produced before being fixed). Naming the constraint sidesteps it.
      insert into public.recurring_voucher_generation_log (company_id, template_id, run_date, generated_by)
      values (p_company_id, v_template.id, v_run_date, auth.uid())
      on conflict on constraint recurring_voucher_generation_log_template_id_run_date_key do nothing
      returning id into v_log_id;

      if v_log_id is null then
        return query select v_template.id, v_template.template_name, v_run_date,
                             null::uuid, null::text, 'already_generated'::text;
        exit;
      end if;

      begin
        v_voucher_id := public.create_voucher(
          p_company_id, v_template.branch_id, v_template.voucher_type, v_run_date,
          v_lines,
          coalesce(v_template.narration_template, v_template.template_name || ' (recurring)'),
          null, null, v_template.party_ledger_id, 'INR', 1, null
        );

        -- Table-alias-qualified for the same reason the ON CONFLICT target
        -- above is: this function's own OUT parameter list also declares a
        -- voucher_number column, and a bare, unqualified reference is
        -- ambiguous between that variable and vouchers.voucher_number
        -- (confirmed live).
        select vch.voucher_number into v_voucher_number from public.vouchers vch where vch.id = v_voucher_id;

        update public.recurring_voucher_generation_log set voucher_id = v_voucher_id where id = v_log_id;

        v_new_next_run_date := app_private.recurring_step_date(v_run_date, v_template.frequency, v_template.day_of_month, 1);

        update public.recurring_voucher_templates
           set next_run_date = v_new_next_run_date, updated_at = now()
         where id = v_template.id
        returning * into v_template;

        return query select v_template.id, v_template.template_name, v_run_date,
                             v_voucher_id, v_voucher_number, 'generated'::text;
      exception when others then
        -- Release the claimed run_date so a genuine retry (after e.g.
        -- reopening a locked period) is possible — next_run_date is NOT
        -- advanced, so this same due date surfaces again on the next call.
        delete from public.recurring_voucher_generation_log where id = v_log_id;
        return query select v_template.id, v_template.template_name, v_run_date,
                             null::uuid, null::text, ('failed: ' || sqlerrm)::text;
        exit;
      end;
    end loop;
  end loop;
end;
$function$;

comment on function public.generate_due_recurring_vouchers(uuid, date, uuid[]) is
  'Manual "Generate now" — for every active template due on or before p_as_of (optionally restricted to p_template_ids), posts one real voucher per missed period via the unmodified public.create_voucher, catching up multiple missed periods in one call. Idempotent by construction: claims (template_id, run_date) in recurring_voucher_generation_log via ON CONFLICT DO NOTHING before ever calling create_voucher, so a repeated or concurrent call for the same due date returns status=''already_generated'' rather than posting twice. SECURITY INVOKER — runs under the calling user''s own RLS, exactly like a manual voucher entry. See 0151.';

revoke all on function public.generate_due_recurring_vouchers(uuid, date, uuid[]) from public, anon;
grant execute on function public.generate_due_recurring_vouchers(uuid, date, uuid[]) to authenticated;
