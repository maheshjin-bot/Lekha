-- Delivery challan (Rule 55 CGST Rules) + GRN + partial-fulfilment tracking — v1.
-- Deliberately does NOT touch VoucherForm.tsx/InvoiceForm.tsx (locked by two
-- concurrent sessions this run): delivery challans get their own dedicated
-- entry surface, exactly like Orders (0061), Job Work (0069) and
-- Manufacturing/BOM (0070) each got their own.
--
-- STATUTORY BASIS (WebSearch-verified this session, not recalled — see the
-- two searches this migration's author ran: the CBIC tax repository text of
-- Rule 55 itself, and a second, deliberately skeptical search specifically
-- on the branch-transfer/same-GSTIN question below).
--
-- Rule 55(1) CGST Rules lets a consignor move goods on a delivery challan
-- INSTEAD OF a tax invoice for four situations: (a) supply of liquid gas
-- where the quantity at removal is not known, (b) transportation for job
-- work, (c) transportation for reasons other than by way of supply, or
-- (d) other notified supplies. Job work is already 0069's own module: THIS
-- migration covers the "(c) reasons other than supply" bucket plus the
-- SKD/CKD provision in Rule 55(5) — goods sent on approval or sale-or-return,
-- semi/completely-knocked-down consignments, branch/godown transfer,
-- exhibition, and repair, plus an 'other' escape hatch. Required fields per
-- Rule 55(1): date and place of issue; name/address/GSTIN of consignor;
-- name/address/GSTIN-or-UIN of consignee where registered; HSN and
-- description of goods; quantity; taxable value; tax rate and tax amount
-- WHERE APPLICABLE; place of supply for inter-state movement; and a serial
-- number in a series unique for the financial year (this reuses the app's
-- existing voucher-numbering machinery for that, same as every other
-- voucher type).
--
-- THE "WHERE APPLICABLE" QUALIFIER MATTERS AND WAS VERIFIED, NOT ASSUMED.
-- A same-GSTIN stock movement (goods moved between a company's own branches
-- that share one registration) is not a "supply" under Sec 7 CGST Act at
-- all — no tax, no invoice, ever, for that movement. An inter-state or
-- inter-GSTIN branch transfer between DISTINCT registrations, by contrast,
-- IS a supply between distinct persons under Schedule I and needs a real
-- TAX INVOICE with IGST — that case does not belong on a Rule 55 challan
-- and is out of this feature's scope entirely (it already has one: GST
-- multi-state's own create_invoice path, which this migration must not
-- touch). p_destination_branch_id below is therefore only accepted when
-- both branches resolve to THE SAME GST registration (or GST is not active
-- for the company at all) — a genuine inter-registration transfer is
-- refused with a message pointing at the invoice flow instead of silently
-- under-taxing it.
--
-- WHY THIS IS THE SAME "PURE STOCK MOVEMENT, NOT YET A SUPPLY" PROBLEM
-- 0069/0070 ALREADY SOLVED — reusing their exact resolution rather than
-- re-deriving one, per this session's house style. A delivery challan
-- moves real stock (out of a real godown, at a real cost) without any of
-- it being a completed sale, purchase, or any other transaction with a
-- natural debit/credit — but check_voucher_balance (0007) still demands
-- >=2 balanced voucher_entries rows. RESOLUTION: the same self-cancelling
-- pair — Dr and Cr the SAME "Delivery Challan Movement" memo ledger for
-- the SAME amount, on the SAME voucher. Its running balance is always
-- zero by construction; nothing here ever reaches the trial balance, P&L
-- or balance sheet. See 0069's header for the full reasoning.
--
-- GRN IS TRACKING ONLY — DELIBERATELY POSTS NO SECOND VOUCHER, FOR ANY
-- PURPOSE, INCLUDING BRANCH TRANSFER. This was the one real design choice
-- this migration had to make that 0069 didn't already answer, so it is
-- recorded here. "Receipt" for a Rule 55 challan is the consignee
-- acknowledging how much of what was dispatched actually arrived — proof
-- of delivery, the same fact a transporter's POD captures — not stock
-- re-entering one of THIS company's own godowns. That reading holds
-- uniformly across all seven purposes: for approval/sale-or-return/
-- exhibition/repair/SKD-CKD/other the recipient is a third party with no
-- godown of ours to receive into at all; and even for branch_transfer,
-- where the destination genuinely is another of this company's own
-- godowns, this v1 does not attempt a second stock-in voucher there,
-- because that would require deciding which destination godown received
-- it — a decision this schema does not yet ask the dispatcher to make
-- (delivery_challans records a destination BRANCH for the compliance
-- record, not a destination GODOWN for a stock posting) and because the
-- goods are, correctly, still on this company's books as stock the whole
-- time regardless of which of its own locations physically holds them —
-- get_stock_summary already reports what left the source godown; whether
-- it has arrived at a destination godown is not a fact this feature
-- claims to track. Worth revisiting if a real user needs a genuine
-- location-to-location stock ledger; the honest v1 answer is: this
-- migration tracks DISPATCHED vs ACKNOWLEDGED-RECEIVED quantities and
-- nothing about location-level on-hand stock beyond what get_stock_summary
-- already reports for the source godown.
--
-- SCOPE, deliberately narrow (same "one item, simplest shape first"
-- discipline as 0069/0070): one item per challan. No loss/waste concept
-- (unlike job_work_returns) — Rule 55 goods sent on approval, branch
-- transfer, exhibition etc. do not carry job work's ITC-04 loss-reporting
-- requirement, and the task this migration answers asked only for
-- quantity_received/received_date, not a loss/waste split. If a real user
-- needs to record damage/shrinkage in transit, that is future scope, named
-- here rather than silently bolted onto "received."
create table public.delivery_challans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  branch_id uuid not null,
  voucher_id uuid not null,
  purpose text not null
    check (purpose = any (array[
      'approval', 'sale_or_return', 'skd_ckd', 'branch_transfer', 'exhibition', 'repair', 'other'
    ])),
  -- Consignee identification (Rule 55(1)): a known ledger when one exists,
  -- or free-text name/address for the common case where the recipient is
  -- not a party this company otherwise transacts with (an exhibition hall,
  -- a courier-handled repair centre). Exactly one identification shape
  -- applies, keyed off purpose — see the two CHECK constraints below.
  party_ledger_id uuid,
  party_name text,
  party_address text,
  destination_branch_id uuid,
  item_id uuid not null,
  quantity_sent numeric(18, 3) not null check (quantity_sent > 0),
  uom text not null,
  rate numeric(18, 2) not null default 0,
  -- null = no tax shown on this challan (the honest state for a same-GSTIN
  -- branch transfer, or any movement where no supply has occurred and the
  -- business does not want a rate implied on the printed document). Where
  -- given, taxable_value/tax split is computed live in get_delivery_challans
  -- from quantity_sent * rate and the voucher's own supply_type, not stored
  -- redundantly here.
  gst_rate_percent numeric(5, 2) check (gst_rate_percent is null or gst_rate_percent between 0 and 100),
  vehicle_number text,
  transporter_name text,
  reason_for_movement text,
  challan_date date not null,
  status text not null default 'open'
    check (status = any (array['open', 'partially_received', 'closed'])),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (branch_id, company_id) references public.branches (id, company_id),
  foreign key (voucher_id, company_id) references public.vouchers (id, company_id),
  foreign key (party_ledger_id, company_id) references public.ledgers (id, company_id),
  foreign key (destination_branch_id, company_id) references public.branches (id, company_id),
  foreign key (item_id, company_id) references public.items (id, company_id),
  -- branch_transfer identifies its counterparty by branch, never a ledger or
  -- free text; every other purpose identifies it by ledger and/or free text,
  -- never a branch — the two identification shapes are mutually exclusive.
  check (
    (purpose = 'branch_transfer' and destination_branch_id is not null
       and party_ledger_id is null and party_name is null)
    or
    (purpose <> 'branch_transfer' and destination_branch_id is null
       and (party_ledger_id is not null or party_name is not null))
  ),
  check (destination_branch_id is null or destination_branch_id <> branch_id)
);

create index delivery_challans_company_status_idx on public.delivery_challans (company_id, status);
create index delivery_challans_voucher_idx on public.delivery_challans (voucher_id);

create trigger set_updated_at before update on public.delivery_challans
  for each row execute function app_private.set_updated_at();

comment on table public.delivery_challans is
  'One row per Rule 55 dispatch (the delivery_challan_out voucher that actually moved stock), one item per challan (v1 scope, matching 0069''s job-work challans). Covers the "reasons other than supply" bucket of Rule 55(1)(c) plus the SKD/CKD provision in Rule 55(5) — approval/sale-or-return, SKD/CKD, branch transfer (same GST registration only — see migration header), exhibition, repair, and an "other" escape hatch. Job work itself stays on 0069''s own job_work_challans/job_work_out voucher_type, not duplicated here.';

alter table public.delivery_challans enable row level security;

create policy delivery_challans_read on public.delivery_challans for select
  using (app_private.is_company_member(company_id));

-- No direct-write policy, same reasoning as job_work_challans (0069): the
-- voucher + self-cancelling ledger pair + challan header must be created
-- together atomically, so all writes go through create_delivery_challan
-- and create_delivery_challan_receipt (both SECURITY DEFINER).

-- ---------------------------------------------------------------------------
-- delivery_challan_receipts — the GRN. One row per acknowledged-receipt
-- event against a challan; see the migration header for why this is
-- tracking-only and posts no voucher.
-- ---------------------------------------------------------------------------
create table public.delivery_challan_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  challan_id uuid not null,
  received_date date not null,
  quantity_received numeric(18, 3) not null check (quantity_received > 0),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (challan_id, company_id) references public.delivery_challans (id, company_id)
);

create index delivery_challan_receipts_challan_idx on public.delivery_challan_receipts (challan_id);

comment on table public.delivery_challan_receipts is
  'A GRN-style acknowledgment event against a challan — proof-of-delivery quantity and date, no stock voucher (see migration header). Cumulative quantity_received across a challan''s rows is capped at quantity_sent by create_delivery_challan_receipt.';

alter table public.delivery_challan_receipts enable row level security;

create policy delivery_challan_receipts_read on public.delivery_challan_receipts for select
  using (app_private.is_company_member(company_id));

-- ---------------------------------------------------------------------------
-- New voucher_type: delivery_challan_out. No _in counterpart — see migration
-- header on why GRN posts nothing. Additive to the existing CHECK, same
-- technique 0069 used for job_work_out/in.
-- ---------------------------------------------------------------------------
alter table public.vouchers drop constraint vouchers_voucher_type_check;
alter table public.vouchers add constraint vouchers_voucher_type_check
  check (voucher_type = any (array[
    'receipt','payment','contra','journal','sales','purchase',
    'credit_note','debit_note','branch_transfer','stock_journal',
    'job_work_out','job_work_in','delivery_challan_out'
  ]));

-- app_private.next_voucher_number's generic fallback (upper(left(type,3)))
-- would give delivery_challan_out the prefix "DEL" — fine on its own, but
-- naming it explicitly here keeps every voucher_type this session has
-- touched consistent (JWO/JWI got explicit prefixes in 0069, STK stayed on
-- its pre-existing default). DCH reads unambiguously as "delivery challan"
-- on a printed voucher list.
create or replace function app_private.next_voucher_number(p_company_id uuid, p_branch_id uuid, p_voucher_type text, p_voucher_date date)
returns table(display_number text, seq_number integer, fy_label text)
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_fy_start_month smallint; v_fy_label text; v_branch_code text;
  v_prefix text; v_padding smallint; v_number int;
begin
  select financial_year_start_month into v_fy_start_month from public.companies where id = p_company_id;
  if v_fy_start_month is null then raise exception 'Company not found'; end if;

  select code into v_branch_code from public.branches where id = p_branch_id and company_id = p_company_id;
  if v_branch_code is null then raise exception 'Branch not found in this company'; end if;

  v_fy_label := app_private.fy_label(p_voucher_date, v_fy_start_month);

  v_prefix := v_branch_code || '/' || case p_voucher_type
    when 'receipt' then 'REC' when 'payment' then 'PAY' when 'contra' then 'CON'
    when 'journal' then 'JRN' when 'sales' then 'SAL' when 'purchase' then 'PUR'
    when 'credit_note' then 'CRN' when 'debit_note' then 'DBN'
    when 'branch_transfer' then 'BTR' when 'stock_journal' then 'STK'
    when 'job_work_out' then 'JWO' when 'job_work_in' then 'JWI'
    when 'delivery_challan_out' then 'DCH'
    else upper(left(p_voucher_type, 3)) end;

  insert into public.voucher_number_sequences
    (company_id, branch_id, voucher_type, financial_year_label, prefix, next_number)
  values (p_company_id, p_branch_id, p_voucher_type, v_fy_label, v_prefix, 2)
  on conflict (company_id, branch_id, voucher_type, financial_year_label)
  do update set next_number = voucher_number_sequences.next_number + 1
  returning (next_number - 1), padding into v_number, v_padding;

  return query select
    (v_prefix || '/' || v_fy_label || '/' || lpad(v_number::text, v_padding, '0')), v_number, v_fy_label;
end;
$$;

-- ---------------------------------------------------------------------------
-- The module: optional, depends on inventory (it moves stock) and gst (Rule
-- 55 is a GST-rules concept end to end) — same dependency shape as job_work.
-- ---------------------------------------------------------------------------
insert into public.ref_modules (code, name, tier, depends_on, activates_when, description, sort_order) values
  ('delivery_challan', 'Delivery challans (Rule 55)', 'optional', '{inventory,gst}', null,
   'Goods sent on approval, SKD/CKD, branch transfer, exhibition or repair — moved without an invoice', 69);

-- ---------------------------------------------------------------------------
-- ensure_delivery_challan_movement_ledger — idempotent auto-provision, same
-- shape as 0069's ensure_job_work_movement_ledger / 0070's ensure_
-- manufacturing_clearing_ledger.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_delivery_challan_movement_ledger(p_company_id uuid)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_group uuid;
  v_ledger uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to set up ledgers for this company';
  end if;

  select id into v_group
    from public.account_groups
   where company_id = p_company_id and name = 'Current Assets'
   limit 1;

  if v_group is null then
    raise exception 'Chart of accounts is not set up for this company yet (no Current Assets group)';
  end if;

  select id into v_ledger
    from public.ledgers
   where company_id = p_company_id and group_id = v_group and name = 'Delivery Challan Movement'
   limit 1;

  if v_ledger is not null then
    return v_ledger;
  end if;

  insert into public.ledgers (company_id, group_id, name, opening_balance_type, opening_balance_amount)
  values (p_company_id, v_group, 'Delivery Challan Movement', 'debit', 0)
  returning id into v_ledger;

  return v_ledger;
end;
$$;

revoke all on function public.ensure_delivery_challan_movement_ledger(uuid) from public, anon;
grant execute on function public.ensure_delivery_challan_movement_ledger(uuid) to authenticated;

comment on function public.ensure_delivery_challan_movement_ledger(uuid) is
  'Idempotently returns the self-cancelling "Delivery Challan Movement" memo ledger — delivery_challan_out vouchers debit and credit it for the SAME amount on the SAME voucher, so its running balance is always zero. Exists purely so those vouchers satisfy check_voucher_balance while carrying a real total_amount.';

-- ---------------------------------------------------------------------------
-- create_delivery_challan — creates the delivery_challan_out voucher (real
-- stock movement out of the godown), the self-cancelling ledger pair, and
-- the challan header, atomically.
-- ---------------------------------------------------------------------------
create or replace function public.create_delivery_challan(
  p_company_id uuid,
  p_branch_id uuid,
  p_purpose text,
  p_item_id uuid,
  p_quantity numeric,
  p_uom text,
  p_godown_id uuid,
  p_rate numeric,
  p_challan_date date,
  p_party_ledger_id uuid default null,
  p_destination_branch_id uuid default null,
  p_party_name text default null,
  p_party_address text default null,
  p_gst_rate_percent numeric default null,
  -- Only needed when p_gst_rate_percent is given AND it cannot be resolved
  -- from a party ledger's state-on-file or a destination branch's own GST
  -- registration (see the resolution block below) — the common case for a
  -- free-text consignee (an exhibition hall, a repair vendor with no ledger
  -- yet) that the business still wants a real tax rate shown for.
  p_place_of_supply char(2) default null,
  p_vehicle_number text default null,
  p_transporter_name text default null,
  p_reason_for_movement text default null,
  p_narration text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_movement_ledger uuid;
  v_display_number text;
  v_seq int;
  v_fy text;
  v_voucher_id uuid;
  v_amount numeric;
  v_challan_id uuid;
  v_gst_on boolean;
  v_source_reg uuid;
  v_dest_reg uuid;
  v_supplier_state char(2);
  v_place_of_supply char(2);
  v_supply_type text;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to record delivery challans for this company';
  end if;
  if not app_private.module_active(p_company_id, 'delivery_challan', p_challan_date) then
    raise exception 'Delivery challans is not an active module for this company — turn it on in Settings first';
  end if;
  if p_purpose not in ('approval', 'sale_or_return', 'skd_ckd', 'branch_transfer', 'exhibition', 'repair', 'other') then
    raise exception '% is not a recognised delivery challan purpose', p_purpose;
  end if;
  if not (p_quantity > 0) then
    raise exception 'Quantity must be greater than zero';
  end if;

  if p_purpose = 'branch_transfer' then
    if p_destination_branch_id is null then
      raise exception 'A destination branch is required for a branch transfer challan';
    end if;
    if p_destination_branch_id = p_branch_id then
      raise exception 'The destination branch must differ from the dispatching branch';
    end if;
    if p_party_ledger_id is not null or p_party_name is not null then
      raise exception 'A branch transfer challan is identified by its destination branch, not a party';
    end if;
    -- The statutory check verified this session: Rule 55 covers movement
    -- that is NOT a supply. Between two branches under the SAME GST
    -- registration that is correct; between two DISTINCT registrations
    -- (e.g. two different states, or the ISD case) the movement is a
    -- supply between distinct persons under Schedule I and needs a real
    -- tax invoice, not a challan. Refuse rather than silently under-tax it.
    if app_private.module_active(p_company_id, 'gst', p_challan_date) then
      v_source_reg := app_private.branch_registration(p_branch_id, p_challan_date);
      v_dest_reg := app_private.branch_registration(p_destination_branch_id, p_challan_date);
      if v_source_reg is not null and v_dest_reg is not null and v_source_reg <> v_dest_reg then
        raise exception 'These two branches hold different GST registrations — that transfer is a supply between distinct persons under Schedule I and needs a tax invoice, not a Rule 55 challan';
      end if;
    end if;
  else
    if p_destination_branch_id is not null then
      raise exception 'destination_branch_id only applies to a branch_transfer challan';
    end if;
    if p_party_ledger_id is null and (p_party_name is null or length(trim(p_party_name)) = 0) then
      raise exception 'A consignee — either an existing ledger or a name — is required for this purpose';
    end if;
  end if;

  v_amount := round(p_quantity * coalesce(p_rate, 0), 2);
  v_movement_ledger := public.ensure_delivery_challan_movement_ledger(p_company_id);

  -- Place of supply / supply type, informational only (never posted — see
  -- migration header). Computed the same way create_invoice (0018) computes
  -- it, from whichever party identification this challan actually has.
  v_gst_on := app_private.module_active(p_company_id, 'gst', p_challan_date);
  if v_gst_on then
    v_source_reg := app_private.branch_registration(p_branch_id, p_challan_date);
    if v_source_reg is not null then
      select state_code into v_supplier_state from public.gst_registrations where id = v_source_reg;
      if p_place_of_supply is not null then
        v_place_of_supply := p_place_of_supply;
      elsif p_party_ledger_id is not null then
        select l.state_code into v_place_of_supply from public.ledgers l where l.id = p_party_ledger_id;
      elsif p_destination_branch_id is not null then
        v_dest_reg := app_private.branch_registration(p_destination_branch_id, p_challan_date);
        if v_dest_reg is not null then
          select state_code into v_place_of_supply from public.gst_registrations where id = v_dest_reg;
        end if;
      end if;
      if v_supplier_state is not null and v_place_of_supply is not null then
        -- Inlined rather than calling app_private.gst_supply_type: a
        -- concurrent migration running alongside this one added a second,
        -- default-bearing overload of that function, which makes a plain
        -- 2-argument call ambiguous ("not unique") — verified live while
        -- testing this migration. The underlying rule is one line and
        -- unlikely to change; inlining it keeps this function correct
        -- regardless of how that other migration's overload resolves.
        v_supply_type := case when v_supplier_state = v_place_of_supply then 'intra' else 'inter' end;
      end if;
    end if;
  end if;

  -- Loud, not silent (same discipline create_invoice applies): a tax rate
  -- the caller asked to show on the printed challan, with no place of
  -- supply to classify it CGST+SGST vs IGST, would otherwise render as a
  -- total that disagrees with its own zero/zero/zero split. Refuse rather
  -- than publish that.
  if p_gst_rate_percent is not null and p_gst_rate_percent > 0 and v_gst_on and v_place_of_supply is null then
    raise exception 'Cannot determine a place of supply to classify the tax rate shown on this challan as CGST+SGST or IGST — pick a party ledger with a state on file, or supply a place of supply explicitly.';
  end if;

  select display_number, seq_number, fy_label into v_display_number, v_seq, v_fy
    from app_private.next_voucher_number(p_company_id, p_branch_id, 'delivery_challan_out', p_challan_date);

  insert into public.vouchers (
    company_id, branch_id, voucher_type, voucher_number, sequence_number,
    financial_year_label, voucher_date, narration, party_ledger_id,
    place_of_supply, supply_type, created_by)
  values (
    p_company_id, p_branch_id, 'delivery_challan_out', v_display_number, v_seq,
    v_fy, p_challan_date, coalesce(p_narration, initcap(replace(p_purpose, '_', ' ')) || ' — delivery challan'),
    p_party_ledger_id, v_place_of_supply, v_supply_type, auth.uid())
  returning id into v_voucher_id;

  insert into public.voucher_items (
    voucher_id, company_id, branch_id, godown_id, item_id,
    direction, quantity, uom, rate, amount, hsn_sac, description, line_order)
  select v_voucher_id, p_company_id, p_branch_id, p_godown_id, p_item_id,
         'out', p_quantity, p_uom, coalesce(p_rate, 0), v_amount, i.hsn_sac,
         coalesce(p_reason_for_movement, initcap(replace(p_purpose, '_', ' '))), 0
    from public.items i where i.id = p_item_id;

  -- Self-cancelling pair — see migration header for why.
  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_movement_ledger, v_amount, 0, 0);
  insert into public.voucher_entries (voucher_id, company_id, branch_id, ledger_id, debit_amount, credit_amount, line_order)
  values (v_voucher_id, p_company_id, p_branch_id, v_movement_ledger, 0, v_amount, 1);

  insert into public.delivery_challans (
    company_id, branch_id, voucher_id, purpose, party_ledger_id, party_name, party_address,
    destination_branch_id, item_id, quantity_sent, uom, rate, gst_rate_percent,
    vehicle_number, transporter_name, reason_for_movement, challan_date, created_by)
  values (
    p_company_id, p_branch_id, v_voucher_id, p_purpose, p_party_ledger_id, p_party_name, p_party_address,
    p_destination_branch_id, p_item_id, p_quantity, p_uom, coalesce(p_rate, 0), p_gst_rate_percent,
    p_vehicle_number, p_transporter_name, p_reason_for_movement, p_challan_date, auth.uid())
  returning id into v_challan_id;

  return v_challan_id;
end;
$$;

revoke all on function public.create_delivery_challan(uuid, uuid, text, uuid, numeric, text, uuid, numeric, date, uuid, uuid, text, text, numeric, char, text, text, text, text) from public, anon;
grant execute on function public.create_delivery_challan(uuid, uuid, text, uuid, numeric, text, uuid, numeric, date, uuid, uuid, text, text, numeric, char, text, text, text, text) to authenticated;

comment on function public.create_delivery_challan(uuid, uuid, text, uuid, numeric, text, uuid, numeric, date, uuid, uuid, text, text, numeric, char, text, text, text, text) is
  'Creates the delivery_challan_out voucher (real stock movement out of the godown, valued at p_rate), the self-cancelling Delivery Challan Movement ledger pair that satisfies check_voucher_balance, and the challan header, atomically. Refuses a branch_transfer between two branches on different GST registrations (that is a taxable supply, not a Rule 55 movement). v1 is one item per challan.';

-- ---------------------------------------------------------------------------
-- create_delivery_challan_receipt — records a GRN-style acknowledgment
-- against an open challan. Tracking only — see migration header for why
-- this posts no voucher.
-- ---------------------------------------------------------------------------
create or replace function public.create_delivery_challan_receipt(
  p_company_id uuid,
  p_challan_id uuid,
  p_received_date date,
  p_quantity_received numeric,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_challan record;
  v_already_received numeric;
  v_new_total numeric;
  v_receipt_id uuid;
begin
  if not app_private.can_write_company(p_company_id) then
    raise exception 'Not permitted to record delivery challan receipts for this company';
  end if;
  if not (p_quantity_received > 0) then
    raise exception 'Quantity received must be greater than zero';
  end if;

  select quantity_sent, status into v_challan
    from public.delivery_challans
   where id = p_challan_id and company_id = p_company_id;

  if v_challan.quantity_sent is null then
    raise exception 'Challan % does not exist in this company', p_challan_id;
  end if;
  if v_challan.status = 'closed' then
    raise exception 'This challan is already fully received';
  end if;

  select coalesce(sum(quantity_received), 0) into v_already_received
    from public.delivery_challan_receipts
   where challan_id = p_challan_id;

  v_new_total := v_already_received + p_quantity_received;
  if v_new_total > v_challan.quantity_sent + 0.0005 then
    raise exception 'This receipt would take the challan''s received total to % — only % was sent',
      v_new_total, v_challan.quantity_sent;
  end if;

  insert into public.delivery_challan_receipts (
    company_id, challan_id, received_date, quantity_received, notes, created_by)
  values (
    p_company_id, p_challan_id, p_received_date, p_quantity_received, p_notes, auth.uid())
  returning id into v_receipt_id;

  update public.delivery_challans
     set status = case when v_new_total >= quantity_sent - 0.0005 then 'closed' else 'partially_received' end,
         updated_at = now()
   where id = p_challan_id;

  return v_receipt_id;
end;
$$;

revoke all on function public.create_delivery_challan_receipt(uuid, uuid, date, numeric, text) from public, anon;
grant execute on function public.create_delivery_challan_receipt(uuid, uuid, date, numeric, text) to authenticated;

comment on function public.create_delivery_challan_receipt(uuid, uuid, date, numeric, text) is
  'Records a GRN-style acknowledgment against a challan — no voucher, no stock movement (see migration header). Guards cumulative quantity_received never exceeding quantity_sent, and auto-closes the challan when it does.';

-- ---------------------------------------------------------------------------
-- get_delivery_challans — list with reconciliation and the informational
-- (never-posted) tax split, for the challan screen and the printed document.
-- ---------------------------------------------------------------------------
create or replace function public.get_delivery_challans(
  p_company_id uuid,
  p_status_filter text default null
)
returns table (
  challan_id uuid,
  challan_number text,
  challan_date date,
  purpose text,
  party_display text,
  item_id uuid,
  item_name text,
  hsn_sac text,
  uom text,
  quantity_sent numeric,
  quantity_received numeric,
  quantity_outstanding numeric,
  rate numeric,
  taxable_value numeric,
  gst_rate_percent numeric,
  cgst_amount numeric,
  sgst_amount numeric,
  igst_amount numeric,
  tax_amount numeric,
  supply_type text,
  vehicle_number text,
  transporter_name text,
  reason_for_movement text,
  status text
)
language sql
stable
set search_path to ''
as $$
  select
    c.id, v.voucher_number, c.challan_date, c.purpose,
    coalesce(l.name, c.party_name, b.name),
    i.id, i.name, i.hsn_sac, c.uom,
    c.quantity_sent,
    coalesce(r.received, 0),
    c.quantity_sent - coalesce(r.received, 0),
    c.rate,
    round(c.quantity_sent * c.rate, 2),
    c.gst_rate_percent,
    case when c.gst_rate_percent is not null and v.supply_type = 'intra'
      then round(c.quantity_sent * c.rate * c.gst_rate_percent / 2 / 100, 2) else 0 end,
    case when c.gst_rate_percent is not null and v.supply_type = 'intra'
      then round(c.quantity_sent * c.rate * c.gst_rate_percent / 2 / 100, 2) else 0 end,
    case when c.gst_rate_percent is not null and v.supply_type = 'inter'
      then round(c.quantity_sent * c.rate * c.gst_rate_percent / 100, 2) else 0 end,
    case when c.gst_rate_percent is not null
      then round(c.quantity_sent * c.rate * c.gst_rate_percent / 100, 2) else 0 end,
    v.supply_type,
    c.vehicle_number, c.transporter_name, c.reason_for_movement,
    c.status
  from public.delivery_challans c
  join public.vouchers v on v.id = c.voucher_id
  join public.items i on i.id = c.item_id
  left join public.ledgers l on l.id = c.party_ledger_id
  left join public.branches b on b.id = c.destination_branch_id
  left join (
    select challan_id, sum(quantity_received) as received
      from public.delivery_challan_receipts
     group by challan_id
  ) r on r.challan_id = c.id
  where c.company_id = p_company_id
    and (p_status_filter is null or c.status = p_status_filter)
  order by c.status = 'closed', c.challan_date desc;
$$;

revoke all on function public.get_delivery_challans(uuid, text) from public, anon;
grant execute on function public.get_delivery_challans(uuid, text) to authenticated;

comment on function public.get_delivery_challans(uuid, text) is
  'Per-challan reconciliation (sent - received = outstanding) plus the Rule 55 taxable-value/tax-rate fields, computed live from quantity_sent * rate and the voucher''s own place_of_supply/supply_type — never stored redundantly, never posted to any ledger. tax_amount/cgst/sgst/igst are all zero when gst_rate_percent is null, which is the honest state for a same-GSTIN movement that carries no tax at all.';
