-- ============================================================================
-- 0500 — GST on advances received for a SERVICE not yet invoiced (Sec 13(2)),
--        and GSTR-1 Table 11A/11B
-- ============================================================================
-- CONFIRMED LIVE, NOT ASSUMED, THAT THIS WAS A GENUINE GAP. `select
-- table_name from information_schema.tables where table_name ilike
-- '%advance%'` and `select column_name from information_schema.columns where
-- column_name ilike '%advance%'` both returned zero rows across this entire
-- schema before this migration. A receipt voucher today (voucher_type =
-- 'receipt') is a plain Dr Bank/Cash, Cr Party-Ledger posting —
-- indistinguishable from any other collection against a customer. Nothing
-- anywhere flags "this money arrived before the invoice, and GST is already
-- due on it."
--
-- THE GOODS-VS-SERVICES DISTINCTION THIS MIGRATION EXISTS TO GET RIGHT,
-- researched live, then deliberately re-searched skeptically for a
-- conflicting figure (none found — every independent source, including the
-- notification's own primary text, agreed):
--   - Notification No. 40/2017-Central Tax (13-Oct-2017, turnover ≤ 1.5 cr)
--     was superseded by Notification No. 66/2017-Central Tax (15-Nov-2017),
--     which extended the same relief to ALL registered persons (other than
--     composition dealers): no GST is payable on an advance received for the
--     future supply of GOODS. Time of supply for goods reverts to the
--     ordinary Sec 12(2)(a) rule — invoice date — full stop.
--   - That notification's relief is GOODS-ONLY. It says nothing about
--     services, and every independent source checked (ClearTax, TaxGuru,
--     IndiaFilings, GST Council's own site) states this in as many words:
--     "advances for services remain taxable." Sec 13(2) (time of supply of
--     services) is untouched — receipt of payment (to the extent it covers
--     the supply) is still one of the trigger events, and whichever trigger
--     lands earliest governs.
--   - Amendment found on the skeptical pass, and confirmed NOT to touch the
--     goods-vs-services line this migration turns on: Notification No.
--     50/2023-Central Tax narrowed 66/2017's own goods-side relief to
--     exclude "specified actionable claims" (the online-gaming/casino/horse-
--     racing actionable-claims regime that took effect 1-Oct-2023) — an
--     unrelated goods-side carve-out. Since this migration only ever
--     tracks SERVICE advances (services were never inside 66/2017's relief
--     to begin with), that amendment changes nothing here. Named so it is
--     not mistaken for a reason to revisit the goods/services line itself.
-- Sources: https://gstcouncil.gov.in/node/3993 (66/2017-CT primary text),
-- https://www.taxtmi.com/notifications?id=140845 (50/2023-CT, the actionable-
-- claims carve-out), https://www.indiafilings.com/learn/advance-received-
-- under-gst , https://taxguru.in/goods-and-service-tax/taxability-advances-
-- gst-regime.html — all read today, all agreeing independently.
--
-- SEC 13(2) / SEC 31(3)(d) / RULE 50 — THE RECEIPT-VOUCHER AND GROSSING-UP
-- MECHANICS, confirmed against the CGST Rules' own live text (taxinformation.
-- cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/
-- chapter6/rule50_v1.00.html, fetched today) rather than a secondary summary:
--   - Sec 31(3)(d): a supplier who receives an advance for a service must
--     issue a receipt voucher for it.
--   - Rule 50: prescribes that voucher's contents — among them "(f) amount of
--     advance taken" and "(g) rate of tax." Its own proviso: "where the rate
--     of tax is not determinable, the tax shall be paid at the rate of
--     eighteen per cent," and "where the nature of supply is not
--     determinable, the same shall be treated as inter-State supply."
--   - THE GROSSING-UP FORMULA ITSELF is not spelled out verbatim inside Rule
--     50's own text — it follows from the settled, universally-applied
--     treatment (ClearTax, TaxGuru, ICAI study material, and every GST
--     practitioner reference checked today, independently, agree) that the
--     advance received is CUM-TAX: the customer does not pay GST on top of
--     the advance separately, so the tax has to be backed out of the figure
--     actually received. taxable_value = advance × 100 / (100 + rate);
--     tax = advance − taxable_value (equivalently advance × rate / (100 +
--     rate)). Applied per-row below, at rate = gst_rate_percent +
--     cess_rate_percent combined (cess, where entered, is ad valorem on the
--     same taxable value as GST, same as everywhere else in this schema).
--   - The Rule 50 "rate not determinable → 18%" default is modelled as an
--     explicit, honest flag (rate_not_determinable) rather than silently
--     letting a user type 18 themselves — so a report reader can tell "this
--     is a real known rate" from "this is the statutory fallback because the
--     rate genuinely wasn't known yet." The mirror-image "nature not
--     determinable → treat as inter-State" proviso is NOT modelled with its
--     own flag: Table 11 itself has no "unknown" bucket for place of supply
--     (the form's own Table 11 columns are Rate | Gross Advance | Place of
--     Supply | Amount — POS is not optional), so honestly representing "we
--     do not know the state" would need a fabricated POS value either way.
--     Left as a named, deliberate gap rather than invented — see
--     scope_deferred in the final report.
-- Sources: https://taxinformation.cbic.gov.in/content/html/tax_repository/
-- gst/rules/cgst_rules/active/chapter6/rule50_v1.00.html (Rule 50 primary
-- text), https://cleartax.in/s/advance-received-under-gst, https://
-- www.taxtmi.com/article/detailed?id=11179 (worked grossing-up example,
-- cross-checked by hand below in live verification).
--
-- FORM GSTR-1 TABLE 11 STRUCTURE — read from the actual gazetted form (CBIC/
-- GSTN's own FORM GSTR-1 PDF, [See rule 59(1)], fetched and read page-by-page
-- today), not a summary blog. Table 11's own columns are Rate | Gross Advance
-- Received/adjusted | Place of supply | Amount (Integrated/Central/State/UT
-- Tax) | Cess — split into four sub-tables: 11A(1) intra-State (rate-wise),
-- 11A(2) inter-State (rate-wise), 11B(1)/11B(2) the mirror-image adjustment
-- pair. Instruction 15 to the form states this exactly: "Table 11A captures
-- information related to advances received, rate-wise, in the tax period and
-- tax to be paid thereon along with the respective PoS. It also includes
-- information in Table 11B for adjustment of tax paid on advance received and
-- reported in earlier tax periods against invoices issued in the current tax
-- period. The details of information relating to advances would be submitted
-- only if the invoice has not been issued in the same tax period in which the
-- advance was received." Two consequences taken directly from that sentence,
-- both implemented in get_gstr1_table11a/b below:
--   (1) An advance received AND invoiced in the SAME period nets to nothing
--       and appears in NEITHER table — it is already fully represented by
--       the ordinary Table 4/5/7 invoice line, so showing it again here would
--       double the reported liability. get_gstr1_table11a explicitly excludes
--       any advance whose linked invoice also falls inside the same period
--       being queried.
--   (2) Table 11B's population is advances received in an EARLIER period,
--       adjusted (i.e. the real invoice raised) inside the period being
--       queried — keyed off the ADJUSTED INVOICE's own voucher_date, not off
--       whenever the "mark adjusted" button happened to be clicked in this
--       app (adjusted_at is an app-audit timestamp, not a statutory fact).
-- Source: FORM GSTR-1 [See rule 59(1)] official PDF (page 208, "11.
-- Consolidated Statement of Advances Received/Advance adjusted..."),
-- retrieved via img-www.gstzen.in's hosted copy of the gazetted form text,
-- read in full today.
--
-- BUILT AS A MANUAL TAG/OVERLAY, NOT A NEW VOUCHER CONCEPT — the same
-- discipline Orders (0061) already established for this codebase, and
-- explicitly required by this task's own brief (create_invoice,
-- receipt-voucher posting, and VoucherForm are all off-limits for this batch
-- besides). service_advance_receipts never touches voucher_entries; it only
-- READS an existing receipt voucher's postings, through a normal foreign
-- key, and adds statutory metadata (rate, place of supply, adjustment link)
-- on top. A wrongly-tagged advance is corrected by unmark_service_advance_
-- adjusted (if merely mis-linked) or, if genuinely mistaken, by an ordinary
-- DELETE under the same can_write_company RLS every other write here uses —
-- no dedicated delete RPC is built for v1 (see scope_deferred).
--
-- WHY A SPECIFIC AMOUNT WITHIN A VOUCHER, NOT THE WHOLE VOUCHER. A real
-- receipt is commonly a mix — part settling an old invoice, part a fresh
-- advance for unbilled work — and a receipt voucher can in principle credit
-- more than one party ledger in one voucher (e.g. a single bank deposit
-- representing several customers' collections). So this migration tags an
-- AMOUNT against a (voucher, party) pair, not the voucher itself, and the
-- enforcement trigger below sums every service_advance_receipts row already
-- tagged against that same (voucher, party) and refuses to let the total
-- exceed what was actually credited to that party in that voucher — the same
-- "don't let the tag outrun the transaction" discipline batch/serial
-- tracking (0114-ish) and forex settlement already apply elsewhere.
--
-- OUT OF SCOPE, NAMED HONESTLY RATHER THAN SILENTLY DROPPED:
--   - The Sec 13(2) proviso letting a supplier treat up to ₹1,000 received in
--     EXCESS of an already-issued invoice's own value as time-of-supplied on
--     the NEXT invoice date, at the supplier's option — a real de-minimis
--     rule this schema does not model; every tagged rupee here is treated as
--     a genuine advance, full stop.
--   - Rule 50's "nature of supply not determinable → treat as inter-State"
--     proviso — see above; Table 11 itself has no "POS unknown" bucket to
--     honestly represent it in.
--   - No delete RPC (see above) — a genuinely wrong tag is removed by a
--     direct DELETE under the standing can_write_company write policy.
--   - No auto-detection of which receipt vouchers are LIKELY advances —
--     tagging is 100% user-initiated, matching Orders' fulfilled_voucher_id
--     precedent of "the user explicitly says so," never inferred.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- service_advance_receipts — one row per (receipt voucher, amount) tagged as
-- a service advance. party_ledger_id is never taken from the client — the
-- enforcement trigger below always re-derives it from the voucher itself, so
-- it can never drift from what the voucher actually says.
-- ----------------------------------------------------------------------------
create table public.service_advance_receipts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  voucher_id uuid not null,
  party_ledger_id uuid not null,

  advance_amount numeric(18,2) not null check (advance_amount > 0),
  gst_rate_percent numeric(5,2) not null check (gst_rate_percent >= 0 and gst_rate_percent <= 100),
  rate_not_determinable boolean not null default false,
  cess_rate_percent numeric(5,2) not null default 0 check (cess_rate_percent >= 0),
  place_of_supply character(2) not null,

  status text not null default 'outstanding' check (status in ('outstanding', 'adjusted')),
  adjusted_voucher_id uuid,
  adjusted_note text,
  adjusted_at timestamptz,

  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, company_id),
  foreign key (voucher_id, company_id) references public.vouchers (id, company_id),
  foreign key (party_ledger_id, company_id) references public.ledgers (id, company_id),
  foreign key (adjusted_voucher_id, company_id) references public.vouchers (id, company_id),
  foreign key (place_of_supply) references public.ref_states (code),

  check (
    (status = 'outstanding' and adjusted_voucher_id is null and adjusted_at is null)
    or
    (status = 'adjusted' and adjusted_voucher_id is not null and adjusted_at is not null)
  )
);

create index service_advance_receipts_company_status_idx
  on public.service_advance_receipts (company_id, status, voucher_id);
create index service_advance_receipts_voucher_idx
  on public.service_advance_receipts (voucher_id, party_ledger_id);
create index service_advance_receipts_adjusted_voucher_idx
  on public.service_advance_receipts (adjusted_voucher_id) where adjusted_voucher_id is not null;

create trigger set_updated_at before update on public.service_advance_receipts
  for each row execute function app_private.set_updated_at();

alter table public.service_advance_receipts enable row level security;

create policy service_advance_receipts_read on public.service_advance_receipts
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy service_advance_receipts_write on public.service_advance_receipts
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.service_advance_receipts is
  'Manual tag/overlay marking a specific amount within an existing receipt voucher as an advance for a SERVICE not yet invoiced (Sec 13(2) time of supply) — never touches voucher_entries or create_invoice. Goods advances are exempt from this since Notification 66/2017-CT and are deliberately not representable here. gst_rate_percent/cess_rate_percent/place_of_supply are the Rule 50 receipt-voucher facts; the GST liability is grossed UP out of advance_amount (treated cum-tax), not added on top — see 0500 header. status=adjusted + adjusted_voucher_id is a manual link to the real invoice later raised against the SAME customer, set only by mark_service_advance_adjusted, never inferred.';

comment on column public.service_advance_receipts.rate_not_determinable is
  'True when the applicable GST rate genuinely was not known at the time the advance was received — Rule 50''s own proviso then requires 18% (the enforcement trigger forces gst_rate_percent to 18 whenever this is true), so a report reader can tell "a real known rate" from "the statutory 18% fallback" rather than seeing an indistinguishable 18.';

comment on column public.service_advance_receipts.place_of_supply is
  'Rule 50 requires a receipt voucher to state place of supply; FORM GSTR-1 Table 11 requires it as a column too (Rate | Gross Advance | Place of Supply | Amount). References ref_states(code), same domain as vouchers.place_of_supply.';


-- ----------------------------------------------------------------------------
-- app_private.enforce_service_advance_receipt — validates the linked receipt
-- voucher (and, once status=adjusted, the linked invoice), re-derives
-- party_ledger_id from the voucher itself, applies the Rule 50 18% default,
-- and enforces that tagged amounts never exceed what the voucher actually
-- credited to that party. SECURITY DEFINER, same shape as 0119's
-- enforce_exim_shipment_voucher, so this reads vouchers/voucher_entries
-- regardless of RLS nuance rather than leaning on the writer also having a
-- live SELECT path to them (in practice they always do, via
-- is_company_member, but this does not depend on that coincidence).
-- ----------------------------------------------------------------------------
create or replace function app_private.enforce_service_advance_receipt()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_voucher record;
  v_invoice record;
  v_credited numeric;
  v_already_tagged numeric;
begin
  select company_id, voucher_type, is_deleted, party_ledger_id, voucher_date
    into v_voucher
    from public.vouchers
   where id = new.voucher_id;

  if v_voucher.company_id is null then
    raise exception 'Voucher % does not exist', new.voucher_id;
  end if;
  if v_voucher.company_id <> new.company_id then
    raise exception 'Voucher % does not belong to company %', new.voucher_id, new.company_id;
  end if;
  if v_voucher.is_deleted then
    raise exception 'Cannot tag a deleted voucher as a service advance';
  end if;
  if v_voucher.voucher_type <> 'receipt' then
    raise exception 'A service advance can only be tagged against a receipt voucher, not a % voucher', v_voucher.voucher_type;
  end if;
  if v_voucher.party_ledger_id is null then
    raise exception 'This receipt voucher has no customer ledger attached — a service advance must be attributable to a specific customer';
  end if;

  -- Never trust the client for this — always the voucher's own party.
  new.party_ledger_id := v_voucher.party_ledger_id;

  select coalesce(sum(e.credit_amount - e.debit_amount), 0)
    into v_credited
    from public.voucher_entries e
   where e.voucher_id = new.voucher_id
     and e.ledger_id = v_voucher.party_ledger_id;

  select coalesce(sum(s.advance_amount), 0)
    into v_already_tagged
    from public.service_advance_receipts s
   where s.voucher_id = new.voucher_id
     and s.party_ledger_id = v_voucher.party_ledger_id
     and s.id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

  if new.advance_amount > (v_credited - v_already_tagged) then
    raise exception 'Cannot tag ₹% here — only ₹% of this receipt is untagged (₹% was credited to this customer in this voucher, ₹% is already tagged elsewhere)',
      new.advance_amount, (v_credited - v_already_tagged), v_credited, v_already_tagged;
  end if;

  if new.rate_not_determinable then
    new.gst_rate_percent := 18;
  end if;

  if new.status = 'adjusted' then
    if new.adjusted_voucher_id is null then
      raise exception 'adjusted_voucher_id is required when status is adjusted';
    end if;

    select company_id, voucher_type, is_deleted, party_ledger_id, voucher_date
      into v_invoice
      from public.vouchers
     where id = new.adjusted_voucher_id;

    if v_invoice.company_id is null then
      raise exception 'Invoice voucher % does not exist', new.adjusted_voucher_id;
    end if;
    if v_invoice.company_id <> new.company_id then
      raise exception 'Invoice voucher % does not belong to company %', new.adjusted_voucher_id, new.company_id;
    end if;
    if v_invoice.is_deleted then
      raise exception 'Cannot adjust a service advance against a deleted invoice voucher';
    end if;
    if v_invoice.voucher_type <> 'sales' then
      raise exception 'A service advance can only be adjusted against a sales voucher, not a % voucher', v_invoice.voucher_type;
    end if;
    if v_invoice.party_ledger_id is distinct from new.party_ledger_id then
      raise exception 'That invoice''s customer does not match this advance''s customer — an advance can only be adjusted against an invoice raised to the same customer';
    end if;
    if v_invoice.voucher_date < v_voucher.voucher_date then
      raise exception 'The invoice (%) cannot be dated before the advance receipt it is adjusting (%)', v_invoice.voucher_date, v_voucher.voucher_date;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger enforce_service_advance_receipt
  before insert or update on public.service_advance_receipts
  for each row execute function app_private.enforce_service_advance_receipt();

revoke all on function app_private.enforce_service_advance_receipt() from public, anon;
grant execute on function app_private.enforce_service_advance_receipt() to authenticated;

comment on function app_private.enforce_service_advance_receipt() is
  'Validates voucher_id is a non-deleted receipt voucher in the same company with a party ledger, re-derives party_ledger_id from it, applies the Rule 50 18%-when-not-determinable default, refuses to let tagged amounts exceed what the voucher actually credited to that party, and (once status=adjusted) validates the linked invoice is a same-company non-deleted sales voucher to the SAME customer dated on/after the advance.';


-- ----------------------------------------------------------------------------
-- create_service_advance_receipt(company, voucher, amount, rate, POS, cess,
--   rate_not_determinable, notes) -> id
-- ----------------------------------------------------------------------------
create or replace function public.create_service_advance_receipt(
  p_company_id uuid,
  p_voucher_id uuid,
  p_advance_amount numeric,
  p_gst_rate_percent numeric,
  p_place_of_supply character,
  p_cess_rate_percent numeric default 0,
  p_rate_not_determinable boolean default false,
  p_notes text default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.service_advance_receipts (
    company_id, voucher_id, advance_amount, gst_rate_percent,
    rate_not_determinable, cess_rate_percent, place_of_supply, notes, created_by
  ) values (
    p_company_id, p_voucher_id, p_advance_amount, p_gst_rate_percent,
    p_rate_not_determinable, coalesce(p_cess_rate_percent, 0), p_place_of_supply, p_notes, auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.create_service_advance_receipt(uuid, uuid, numeric, numeric, character, numeric, boolean, text) from public, anon;
grant execute on function public.create_service_advance_receipt(uuid, uuid, numeric, numeric, character, numeric, boolean, text) to authenticated;

comment on function public.create_service_advance_receipt is
  'Tags an amount within an existing receipt voucher as a service advance. party_ledger_id is deliberately not a parameter — app_private.enforce_service_advance_receipt always derives it from the voucher. Posts nothing to voucher_entries.';


-- ----------------------------------------------------------------------------
-- mark_service_advance_adjusted / unmark_service_advance_adjusted — the
-- manual link to the real invoice, and its reversal. Mirrors
-- mark_order_converted (0061): the caller states the fact after creating the
-- invoice through the ordinary invoice screens; nothing here pre-fills or
-- drives InvoiceForm.
-- ----------------------------------------------------------------------------
create or replace function public.mark_service_advance_adjusted(
  p_company_id uuid,
  p_advance_id uuid,
  p_adjusted_voucher_id uuid,
  p_adjusted_note text default null
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status
    from public.service_advance_receipts
   where id = p_advance_id and company_id = p_company_id
   for update;

  if v_status is null then
    raise exception 'Service advance not found';
  end if;
  if v_status = 'adjusted' then
    raise exception 'Already marked adjusted — unmark it first if you need to change the linked invoice';
  end if;

  update public.service_advance_receipts
     set status = 'adjusted',
         adjusted_voucher_id = p_adjusted_voucher_id,
         adjusted_at = now(),
         adjusted_note = p_adjusted_note
   where id = p_advance_id and company_id = p_company_id;
end;
$$;

revoke all on function public.mark_service_advance_adjusted(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.mark_service_advance_adjusted(uuid, uuid, uuid, text) to authenticated;

comment on function public.mark_service_advance_adjusted is
  'Links a service advance to the real invoice later raised for it. app_private.enforce_service_advance_receipt validates the invoice is a same-company, non-deleted sales voucher to the SAME customer, dated on/after the advance. Manual link only — never auto-matched.';

create or replace function public.unmark_service_advance_adjusted(
  p_company_id uuid,
  p_advance_id uuid
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  select status into v_status
    from public.service_advance_receipts
   where id = p_advance_id and company_id = p_company_id
   for update;

  if v_status is null then
    raise exception 'Service advance not found';
  end if;
  if v_status = 'outstanding' then
    raise exception 'Already outstanding';
  end if;

  update public.service_advance_receipts
     set status = 'outstanding',
         adjusted_voucher_id = null,
         adjusted_note = null,
         adjusted_at = null
   where id = p_advance_id and company_id = p_company_id;
end;
$$;

revoke all on function public.unmark_service_advance_adjusted(uuid, uuid) from public, anon;
grant execute on function public.unmark_service_advance_adjusted(uuid, uuid) to authenticated;

comment on function public.unmark_service_advance_adjusted is
  'Reverts a wrongly-linked adjustment back to outstanding, so mark_service_advance_adjusted can be called again with the correct invoice. A genuinely mistaken tag (not just a wrong link) is removed with an ordinary DELETE under the standing can_write_company RLS — no dedicated delete RPC in v1.';


-- ----------------------------------------------------------------------------
-- get_taggable_receipt_vouchers(company) — receipt vouchers with a party
-- ledger and at least some untagged amount still credited to that party.
-- Feeds the "tag a new advance" picker.
-- ----------------------------------------------------------------------------
create or replace function public.get_taggable_receipt_vouchers(p_company_id uuid)
returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  party_ledger_id uuid,
  party_name text,
  received_amount numeric,
  already_tagged_amount numeric,
  available_amount numeric
)
language sql
stable
set search_path = ''
as $$
  with party_credit as (
    select e.voucher_id, e.ledger_id, sum(e.credit_amount - e.debit_amount) as amt
      from public.voucher_entries e
     where e.company_id = p_company_id
     group by e.voucher_id, e.ledger_id
  ),
  tagged as (
    select s.voucher_id, s.party_ledger_id, sum(s.advance_amount) as amt
      from public.service_advance_receipts s
     where s.company_id = p_company_id
     group by s.voucher_id, s.party_ledger_id
  )
  select
    v.id, v.voucher_number, v.voucher_date, v.party_ledger_id, l.name,
    coalesce(pc.amt, 0),
    coalesce(t.amt, 0),
    coalesce(pc.amt, 0) - coalesce(t.amt, 0)
  from public.vouchers v
  join public.ledgers l on l.id = v.party_ledger_id
  left join party_credit pc on pc.voucher_id = v.id and pc.ledger_id = v.party_ledger_id
  left join tagged t on t.voucher_id = v.id and t.party_ledger_id = v.party_ledger_id
  where v.company_id = p_company_id
    and not v.is_deleted
    and v.voucher_type = 'receipt'
    and v.party_ledger_id is not null
    and coalesce(pc.amt, 0) - coalesce(t.amt, 0) > 0
  order by v.voucher_date desc, v.voucher_number desc;
$$;

revoke all on function public.get_taggable_receipt_vouchers(uuid) from public, anon;
grant execute on function public.get_taggable_receipt_vouchers(uuid) to authenticated;

comment on function public.get_taggable_receipt_vouchers is
  'Receipt vouchers with a party ledger and a still-untagged amount credited to that party (received minus already tagged, across every service_advance_receipts row so far). Feeds the tagging screen''s voucher picker.';


-- ----------------------------------------------------------------------------
-- get_service_advance_receipts(company, status_filter) — the tagging
-- screen's own list, with the Rule 50 grossed-up liability computed per row.
-- This IS the outstanding-liability view: filter status_filter='outstanding'
-- for what is still owed, 'adjusted' for what has been squared against a
-- real invoice.
-- ----------------------------------------------------------------------------
create or replace function public.get_service_advance_receipts(
  p_company_id uuid,
  p_status_filter text default null
)
returns table (
  id uuid,
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  party_ledger_id uuid,
  party_name text,
  advance_amount numeric,
  gst_rate_percent numeric,
  rate_not_determinable boolean,
  cess_rate_percent numeric,
  place_of_supply character,
  place_of_supply_name text,
  taxable_value numeric,
  gst_amount numeric,
  cess_amount numeric,
  status text,
  adjusted_voucher_id uuid,
  adjusted_voucher_number text,
  adjusted_voucher_date date,
  adjusted_note text,
  adjusted_at timestamptz,
  notes text,
  created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    s.id, s.voucher_id, v.voucher_number, v.voucher_date,
    s.party_ledger_id, l.name,
    s.advance_amount, s.gst_rate_percent, s.rate_not_determinable, s.cess_rate_percent,
    s.place_of_supply, st.name,
    round(s.advance_amount * 100 / (100 + s.gst_rate_percent + s.cess_rate_percent), 2),
    round(s.advance_amount * s.gst_rate_percent / (100 + s.gst_rate_percent + s.cess_rate_percent), 2),
    round(s.advance_amount * s.cess_rate_percent / (100 + s.gst_rate_percent + s.cess_rate_percent), 2),
    s.status, s.adjusted_voucher_id, av.voucher_number, av.voucher_date,
    s.adjusted_note, s.adjusted_at, s.notes, s.created_at
  from public.service_advance_receipts s
  join public.vouchers v on v.id = s.voucher_id
  join public.ledgers l on l.id = s.party_ledger_id
  left join public.ref_states st on st.code = s.place_of_supply
  left join public.vouchers av on av.id = s.adjusted_voucher_id
  where s.company_id = p_company_id
    and (p_status_filter is null or s.status = p_status_filter)
  order by (s.status = 'outstanding') desc, v.voucher_date desc;
$$;

revoke all on function public.get_service_advance_receipts(uuid, text) from public, anon;
grant execute on function public.get_service_advance_receipts(uuid, text) to authenticated;

comment on function public.get_service_advance_receipts is
  'Every tagged service advance for a company, with taxable_value/gst_amount/cess_amount grossed UP out of advance_amount (Rule 50 cum-tax treatment — see 0500 header). p_status_filter=''outstanding'' is the real-time GST-still-owed view; ''adjusted'' is what has been squared against a real invoice.';


-- ----------------------------------------------------------------------------
-- get_gstr1_table11a / get_gstr1_table11b — see 0500 header for the exact
-- Table 11 column structure and the same-period-nets-to-nothing rule this
-- implements. Both are rate-wise AND place-of-supply-wise, split intra/inter
-- against the receiving branch's own registered state (11A) or the
-- adjusting invoice's own registered state (11B) — each table's natural
-- registration owner, not necessarily the same one.
-- ----------------------------------------------------------------------------
create or replace function public.get_gstr1_table11a(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
)
returns table (
  rate_percent numeric,
  cess_rate_percent numeric,
  place_of_supply character,
  place_of_supply_name text,
  supply_category text,
  gross_advance numeric,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  cess numeric
)
language sql
stable
set search_path = ''
as $$
  with base as (
    select
      s.gst_rate_percent, s.cess_rate_percent, s.place_of_supply, s.advance_amount,
      v.branch_id, v.voucher_date as advance_date
    from public.service_advance_receipts s
    join public.vouchers v on v.id = s.voucher_id
    left join public.vouchers av on av.id = s.adjusted_voucher_id
    where s.company_id = p_company_id
      and v.voucher_date between p_period_start and p_period_end
      and (p_gst_registration_id is null
           or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
      -- Instruction 15 to FORM GSTR-1: an advance received AND invoiced in
      -- the SAME tax period never appears in Table 11 at all — it is already
      -- fully represented by the ordinary Table 4/5/7 invoice line.
      and not (
        s.adjusted_voucher_id is not null
        and av.voucher_date between p_period_start and p_period_end
      )
  ),
  computed as (
    select
      b.gst_rate_percent, b.cess_rate_percent, b.place_of_supply,
      case when b.place_of_supply = r.state_code then 'intra' else 'inter' end as supply_category,
      b.advance_amount,
      round(b.advance_amount * 100 / (100 + b.gst_rate_percent + b.cess_rate_percent), 2) as taxable_value,
      round(b.advance_amount * b.gst_rate_percent / (100 + b.gst_rate_percent + b.cess_rate_percent), 2) as gst_amount,
      round(b.advance_amount * b.cess_rate_percent / (100 + b.gst_rate_percent + b.cess_rate_percent), 2) as cess_amount
    from base b
    left join public.gst_registrations r on r.id = app_private.branch_registration(b.branch_id, b.advance_date)
  )
  select
    gst_rate_percent, cess_rate_percent, place_of_supply, st.name, supply_category,
    sum(advance_amount), sum(taxable_value),
    sum(case when supply_category = 'intra' then round(gst_amount / 2, 2) else 0 end),
    sum(case when supply_category = 'intra' then gst_amount - round(gst_amount / 2, 2) else 0 end),
    sum(case when supply_category = 'inter' then gst_amount else 0 end),
    sum(cess_amount)
  from computed
  left join public.ref_states st on st.code = place_of_supply
  group by gst_rate_percent, cess_rate_percent, place_of_supply, st.name, supply_category
  order by supply_category, place_of_supply, gst_rate_percent;
$$;

revoke all on function public.get_gstr1_table11a(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_gstr1_table11a(uuid, date, date, uuid) to authenticated;

comment on function public.get_gstr1_table11a is
  'GSTR-1 Table 11A(1)/11A(2): advances received in the period for a service not yet invoiced, rate-wise and place-of-supply-wise, split intra/inter against the RECEIVING branch''s own registered state. Excludes any advance also invoiced within the same period (nets to nothing per Instruction 15 to FORM GSTR-1). Amounts are grossed UP out of advance_amount, cum-tax — see 0500 header.';

create or replace function public.get_gstr1_table11b(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
)
returns table (
  rate_percent numeric,
  cess_rate_percent numeric,
  place_of_supply character,
  place_of_supply_name text,
  supply_category text,
  gross_advance numeric,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  cess numeric
)
language sql
stable
set search_path = ''
as $$
  with base as (
    select
      s.gst_rate_percent, s.cess_rate_percent, s.place_of_supply, s.advance_amount,
      av.branch_id as invoice_branch_id, av.voucher_date as invoice_date
    from public.service_advance_receipts s
    join public.vouchers v on v.id = s.voucher_id
    join public.vouchers av on av.id = s.adjusted_voucher_id
    where s.company_id = p_company_id
      and s.status = 'adjusted'
      -- Received in an EARLIER period than the one being queried...
      and v.voucher_date < p_period_start
      -- ...and adjusted (the real invoice raised) inside this period.
      and av.voucher_date between p_period_start and p_period_end
      and (p_gst_registration_id is null
           or app_private.branch_registration(av.branch_id, av.voucher_date) = p_gst_registration_id)
  ),
  computed as (
    select
      b.gst_rate_percent, b.cess_rate_percent, b.place_of_supply,
      case when b.place_of_supply = r.state_code then 'intra' else 'inter' end as supply_category,
      b.advance_amount,
      round(b.advance_amount * 100 / (100 + b.gst_rate_percent + b.cess_rate_percent), 2) as taxable_value,
      round(b.advance_amount * b.gst_rate_percent / (100 + b.gst_rate_percent + b.cess_rate_percent), 2) as gst_amount,
      round(b.advance_amount * b.cess_rate_percent / (100 + b.gst_rate_percent + b.cess_rate_percent), 2) as cess_amount
    from base b
    left join public.gst_registrations r on r.id = app_private.branch_registration(b.invoice_branch_id, b.invoice_date)
  )
  select
    gst_rate_percent, cess_rate_percent, place_of_supply, st.name, supply_category,
    sum(advance_amount), sum(taxable_value),
    sum(case when supply_category = 'intra' then round(gst_amount / 2, 2) else 0 end),
    sum(case when supply_category = 'intra' then gst_amount - round(gst_amount / 2, 2) else 0 end),
    sum(case when supply_category = 'inter' then gst_amount else 0 end),
    sum(cess_amount)
  from computed
  left join public.ref_states st on st.code = place_of_supply
  group by gst_rate_percent, cess_rate_percent, place_of_supply, st.name, supply_category
  order by supply_category, place_of_supply, gst_rate_percent;
$$;

revoke all on function public.get_gstr1_table11b(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_gstr1_table11b(uuid, date, date, uuid) to authenticated;

comment on function public.get_gstr1_table11b is
  'GSTR-1 Table 11B(1)/11B(2): advances received in an EARLIER period, now adjusted against a real invoice raised inside the period being queried — keyed off the invoice''s own voucher_date, not the app timestamp of when "mark adjusted" was clicked. Same rate-wise/POS-wise/intra-inter shape as Table 11A, split against the ADJUSTING INVOICE''s own registered state (its natural registration owner). Reverses exactly what 11A would have shown for that advance in its own, earlier period.';
