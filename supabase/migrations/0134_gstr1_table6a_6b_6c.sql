-- ============================================================================
-- 0134 — GSTR-1 Tables 6A (exports), 6B (SEZ supplies), 6C (deemed exports)
-- ============================================================================
-- The two prerequisites this feature needed both landed live earlier today,
-- confirmed again just now rather than assumed from the migration files:
--
--   select pg_get_functiondef(oid) from pg_proc
--    where proname = 'gst_supply_type' and pronamespace = 'app_private'::regnamespace;
--     -> the 4-argument overload from 0087 is live: overseas -> export_lut/
--        export_igst by LUT-active date check, sez/sez_developer -> 'sez',
--        deemed_export -> 'deemed_export'.
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.vouchers'::regclass and conname like '%supply_type%';
--     -> vouchers_supply_type_check allows intra/inter/export_lut/export_igst/
--        sez/deemed_export, live.
--   select column_name from information_schema.columns
--    where table_name = 'exim_shipment_details';
--     -> voucher_id, document_type, document_number, document_date, port_code,
--        brc_number/brc_date, export_realisation_due_date, realised_date, all
--        live from 0119, unique(voucher_id) — one row per voucher.
--
-- THE LAW THIS ENCODES — GSTR-1's "6. Zero rated supplies and Deemed
-- Exports" section, sub-tables 6A/6B/6C. WebSearch'd today (not recalled from
-- training data), a first pass and then a second, deliberately skeptical pass
-- specifically on whether SEZ supplies (6B) need the same shipping-bill
-- fields exports (6A) do — they do not, confirmed independently by two
-- sources below, which is the exact fact this migration's LEFT JOIN design
-- depends on:
--
--   - Table 6A (Exports): invoice-wise. GSTIN of recipient is left BLANK
--     (foreign buyer, not GST-registered). Fields: invoice number/date/value,
--     shipping bill/bill of export number, shipping bill date, port code
--     (ICEGATE's own 6-character alphanumeric code — exactly what 0119's
--     port_code CHECK already enforces), rate, taxable value, integrated tax
--     amount, and a with/without-payment indicator (WPAY/WOPAY). "For export
--     of services, the shipping bill, port code and shipping date fields may
--     be left blank" — services genuinely have no shipping bill, this is not
--     a gap for a services invoice. Sourced against cleartax.in's Table 6A
--     explainer, taxguru.in's GSTN advisory for exporters, and
--     mastersindia.co's Table 6A guide, all read today, all agreeing.
--
--   - Table 6B (SEZ supplies): same invoice-wise shape as 6A, but WITH the
--     recipient's GSTIN (the SEZ unit/developer is a GST-registered Indian
--     entity, unlike an overseas buyer) and WITHOUT a mandatory shipping
--     bill — "for SEZ supplies in Table 6B, the shipping bill and port code
--     are not strictly required and can be left blank if unavailable."
--     Sourced against suvit.io's "Managing Supplies to SEZ Units And
--     Developers in GSTR-1" and piceapp.com's "Supply To SEZ Under GSTR 1",
--     both read today, both agreeing SEZ movement is not gated on a customs
--     shipping-bill the way a physical export is. Also WPAY/WOPAY, same as
--     6A ("SEZ supplies with payment" / "SEZ supplies without payment").
--
--   - Table 6C (Deemed exports): same invoice-wise shape again, GSTIN of
--     recipient present (EOU/EHTP/STP/BTP units and Advance-Authorisation/
--     EPCG holders are registered Indian entities), but genuinely NO
--     shipping bill at all — the goods never leave India (Sec 147 CGST Act,
--     already the basis 0087 built its tax computation on), so there is no
--     customs document to reference in the first place, not merely an
--     optional one. No WPAY/WOPAY field either: per the 3rd proviso to Rule
--     89(1) (already cited in 0087's own header, re-confirmed today against
--     dripcapital.com's and razorpay.com's deemed-export guides, both read
--     today), a deemed export CANNOT be supplied under LUT/bond at all — the
--     supplier always charges full GST at the time of supply, and only the
--     tax itself is refunded afterwards (to the supplier or the recipient,
--     an ELECTION made in the refund application under Rule 89/Statement 5B
--     — a fact about who claims the refund, not a fact GSTR-1 Table 6C
--     itself records, and out of scope here for the same reason 0072's
--     ITC-04 prep left Statement 5B/5C out: "not representable by the
--     schema, said so explicitly").
--
-- INVOICE-WISE, NOT RATE-SPLIT — same simplification 0094's Table 9B and the
-- existing get_gst_output_register (Table 4A) already make, deliberately not
-- revisited here. GSTN's actual Table 6 JSON schema nests a nominal rate per
-- invoice item; a single invoice mixing two GST rates would need two rows in
-- a real filing. LEKHA has never split Table 4A/9B by rate either — only
-- Table 12 (HSN summary, 0051/0098) does real per-(HSN,rate) splitting,
-- because the HSN summary is naturally grouped that way already. Extending
-- 6A/6B/6C to the same per-rate granularity as Table 12 is a real
-- enhancement, not attempted here — flagged in the report footer, not
-- silently assumed away.
--
-- TAX_PAYMENT (WPAY/WOPAY) — READ FROM THE VOUCHER FOR 6A, INFERRED FROM THE
-- POSTED TAX FOR 6B, ALWAYS 'WPAY' FOR 6C. Exports genuinely carry the
-- distinction in vouchers.supply_type itself (export_lut vs export_igst) —
-- get_gstr1_table6a reads it directly, no inference needed. SEZ does not:
-- 0087's own header already flagged that vouchers.supply_type has only ONE
-- 'sez' value for both routes, because widening the CHECK for a sez_lut/
-- sez_igst split "would be schema for its own sake" until something
-- downstream actually needed it — this migration is that downstream need,
-- but rather than touch 0087's CHECK constraint (out of scope creep for a
-- reporting migration), get_gstr1_table6b infers the route from the tax
-- actually posted: igst > 0 -> WPAY, igst = 0 -> WOPAY. This is correct for
-- every real invoice EXCEPT the theoretical edge case of a 0%-rated item
-- sold to an SEZ under the WPAY route, which would post zero tax regardless
-- of route and misclassify as WOPAY — stated here, not hidden, and expected
-- to be vanishingly rare (SEZ supplies are not typically 0%-rated line
-- items). Table 6C skips the question entirely: per the 3rd proviso above,
-- deemed exports are never zero-rated, so tax_payment is hard-coded 'WPAY'
-- for every row — a statutory fact, not an inference.
--
-- THE SHIPPING-BILL LEFT JOIN, AND WHY A SERVICES EXPORT MUST NOT BE FLAGGED
-- AS A GAP. The task brief's own framing — "an actual export_igst/export_lut
-- voucher genuinely needs one, and its absence should be visible in the
-- output as a real gap" — is only true for a GOODS export; per the sourcing
-- above, a services export leaves shipping-bill fields blank BY RULE, not by
-- omission. items.item_type already distinguishes 'goods' from 'service'
-- (confirmed live: `select conname, pg_get_constraintdef(oid) from
-- pg_constraint where conrelid = 'public.items'::regclass and conname =
-- 'items_item_type_check'` -> CHECK (item_type = ANY (ARRAY['goods',
-- 'service']))), so get_gstr1_table6a resolves has_goods_line per voucher
-- (true if ANY line item is item_type = 'goods') and returns it alongside
-- shipping_bill_number. The report page treats a missing shipping bill as a
-- real, hand-checkable gap ONLY when has_goods_line is true — a pure-services
-- export with no shipping bill is correct, not a gap, and is shown as such.
-- get_gstr1_table6b/6c also return has_goods_line for the same UI, though
-- neither table treats its absence as an error (see above: SEZ optional,
-- deemed export never applicable).
--
-- TAX SIGN CONVENTION — credit_amount - debit_amount, NOT debit_amount -
-- credit_amount. All three functions here only ever query voucher_type =
-- 'sales' (never credit_note), and a sales voucher's output-tax ledger lines
-- are CREDITED (see create_invoice: v_party_side = 'debit' for a sale, so
-- every non-party entry — trading ledger AND each tax ledger — gets its
-- amount on the credit side). Table 9B's own tax CTE (0094) uses debit_amount
-- - credit_amount because IT queries credit_note vouchers, where the tax
-- ledgers are debited instead — the opposite convention for the opposite
-- voucher type. This function's own hand-verification (see final report)
-- caught a real sign-and-total bug from copying 9B's CTE verbatim without
-- re-deriving it for 'sales': it produced a NEGATIVE igst and an
-- invoice_value net of tax rather than inclusive of it. Fixed here to match
-- get_gst_output_register's own convention (credit_amount - debit_amount),
-- which is what Table 4A already reuses for the same voucher_type.
--
-- WHAT REMAINS A REAL, STATED GAP: party_gstin. Table 6B/6C both require a
-- registered recipient GSTIN by the return's own design (an SEZ unit or a
-- deemed-export recipient is definitionally a registered Indian entity), but
-- ledgers.gst_registration_type = 'sez'/'sez_developer'/'deemed_export' does
-- NOT itself require ledgers.gstin to be filled in — nothing in this schema
-- enforces that pairing. A row with a null party_gstin here is not
-- computable-away; the report surfaces it plainly (a blank GSTIN column) so
-- the preparer fixes the ledger before filing, exactly the same "don't hide
-- it" discipline the shipping-bill gap gets.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- get_gstr1_table6a(company, period_start, period_end, registration) — exports
-- ----------------------------------------------------------------------------
create or replace function public.get_gstr1_table6a(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
) returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  party_name text,
  party_gstin text,
  place_of_supply char(2),
  tax_payment text,
  has_goods_line boolean,
  shipping_bill_number text,
  shipping_bill_date date,
  port_code text,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  cess numeric,
  invoice_value numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'output_cgst' then e.credit_amount - e.debit_amount else 0 end) as cgst,
           sum(case when m.purpose = 'output_sgst' then e.credit_amount - e.debit_amount else 0 end) as sgst,
           sum(case when m.purpose = 'output_igst' then e.credit_amount - e.debit_amount else 0 end) as igst,
           sum(case when m.purpose = 'output_cess' then e.credit_amount - e.debit_amount else 0 end) as cess
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
     where e.company_id = p_company_id
       and m.purpose in ('output_cgst', 'output_sgst', 'output_igst', 'output_cess')
     group by e.voucher_id
  ),
  taxable as (
    select vi.voucher_id, sum(vi.amount) as amt,
           bool_or(i.item_type = 'goods') as has_goods
      from public.voucher_items vi
      join public.items i on i.id = vi.item_id
     where vi.company_id = p_company_id
     group by vi.voucher_id
  )
  select
    v.id,
    v.voucher_number,
    v.voucher_date,
    l.name,
    l.gstin,
    v.place_of_supply,
    case v.supply_type when 'export_lut' then 'WOPAY' when 'export_igst' then 'WPAY' end,
    coalesce(t.has_goods, false),
    s.document_number,
    s.document_date,
    s.port_code,
    coalesce(t.amt, 0),
    coalesce(tx.cgst, 0), coalesce(tx.sgst, 0), coalesce(tx.igst, 0), coalesce(tx.cess, 0),
    coalesce(t.amt, 0) + coalesce(tx.cgst, 0) + coalesce(tx.sgst, 0) + coalesce(tx.igst, 0) + coalesce(tx.cess, 0)
  from public.vouchers v
  join public.ledgers l on l.id = v.party_ledger_id
  left join tax tx on tx.voucher_id = v.id
  left join taxable t on t.voucher_id = v.id
  left join public.exim_shipment_details s on s.voucher_id = v.id and s.document_type = 'shipping_bill'
 where v.company_id = p_company_id
   and not v.is_deleted
   and v.voucher_type = 'sales'
   and v.supply_type in ('export_lut', 'export_igst')
   and v.voucher_date between p_period_start and p_period_end
   and (p_gst_registration_id is null
        or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
 order by v.voucher_date, v.voucher_number;
$$;

comment on function public.get_gstr1_table6a is
  'GSTR-1 Table 6A (Exports) prep: sales vouchers with supply_type export_lut/export_igst, LEFT JOINed to their exim_shipment_details (0119) shipping bill. tax_payment is read directly from supply_type (export_lut -> WOPAY, export_igst -> WPAY) — no inference needed for exports, unlike Table 6B. has_goods_line is true when any line item is item_type = ''goods''; a null shipping_bill_number is a real, hand-checkable gap only when has_goods_line is true — a services export legitimately has no shipping bill per GSTN''s own rule. Invoice-wise, not rate-split — same simplification as Table 4A/9B, see migration header.';

revoke all on function public.get_gstr1_table6a(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_gstr1_table6a(uuid, date, date, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- get_gstr1_table6b(company, period_start, period_end, registration) — SEZ
-- ----------------------------------------------------------------------------
create or replace function public.get_gstr1_table6b(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
) returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  party_name text,
  party_gstin text,
  place_of_supply char(2),
  tax_payment text,
  has_goods_line boolean,
  shipping_bill_number text,
  shipping_bill_date date,
  port_code text,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  cess numeric,
  invoice_value numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'output_cgst' then e.credit_amount - e.debit_amount else 0 end) as cgst,
           sum(case when m.purpose = 'output_sgst' then e.credit_amount - e.debit_amount else 0 end) as sgst,
           sum(case when m.purpose = 'output_igst' then e.credit_amount - e.debit_amount else 0 end) as igst,
           sum(case when m.purpose = 'output_cess' then e.credit_amount - e.debit_amount else 0 end) as cess
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
     where e.company_id = p_company_id
       and m.purpose in ('output_cgst', 'output_sgst', 'output_igst', 'output_cess')
     group by e.voucher_id
  ),
  taxable as (
    select vi.voucher_id, sum(vi.amount) as amt,
           bool_or(i.item_type = 'goods') as has_goods
      from public.voucher_items vi
      join public.items i on i.id = vi.item_id
     where vi.company_id = p_company_id
     group by vi.voucher_id
  )
  select
    v.id,
    v.voucher_number,
    v.voucher_date,
    l.name,
    l.gstin,
    v.place_of_supply,
    -- Inferred, not stored — see migration header. vouchers.supply_type has
    -- only one 'sez' value for both WPAY/WOPAY routes (0087's own documented
    -- gap); the actual IGST posted is the best available signal.
    case when coalesce(tx.igst, 0) > 0 then 'WPAY' else 'WOPAY' end,
    coalesce(t.has_goods, false),
    s.document_number,
    s.document_date,
    s.port_code,
    coalesce(t.amt, 0),
    coalesce(tx.cgst, 0), coalesce(tx.sgst, 0), coalesce(tx.igst, 0), coalesce(tx.cess, 0),
    coalesce(t.amt, 0) + coalesce(tx.cgst, 0) + coalesce(tx.sgst, 0) + coalesce(tx.igst, 0) + coalesce(tx.cess, 0)
  from public.vouchers v
  join public.ledgers l on l.id = v.party_ledger_id
  left join tax tx on tx.voucher_id = v.id
  left join taxable t on t.voucher_id = v.id
  left join public.exim_shipment_details s on s.voucher_id = v.id and s.document_type = 'shipping_bill'
 where v.company_id = p_company_id
   and not v.is_deleted
   and v.voucher_type = 'sales'
   and v.supply_type = 'sez'
   and v.voucher_date between p_period_start and p_period_end
   and (p_gst_registration_id is null
        or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
 order by v.voucher_date, v.voucher_number;
$$;

comment on function public.get_gstr1_table6b is
  'GSTR-1 Table 6B (Supplies to SEZ unit/developer) prep: sales vouchers with supply_type = sez, LEFT JOINed to exim_shipment_details (0119) — SEZ movement does not require a customs shipping bill (confirmed via WebSearch, see migration header), so a null shipping_bill_number here is informational, not a gap, unless the report chooses to show it as one. tax_payment is INFERRED from whether IGST was actually posted (igst > 0 -> WPAY), because vouchers.supply_type has only one sez value for both routes (0087) — misclassifies only the theoretical case of a 0%-rated item sold to an SEZ under WPAY, stated in the header. party_gstin should always be present for a real SEZ recipient but is not enforced by the schema; a null value here is a real gap to fix before filing.';

revoke all on function public.get_gstr1_table6b(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_gstr1_table6b(uuid, date, date, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- get_gstr1_table6c(company, period_start, period_end, registration) — deemed exports
-- ----------------------------------------------------------------------------
create or replace function public.get_gstr1_table6c(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_gst_registration_id uuid default null
) returns table (
  voucher_id uuid,
  voucher_number text,
  voucher_date date,
  party_name text,
  party_gstin text,
  place_of_supply char(2),
  tax_payment text,
  has_goods_line boolean,
  shipping_bill_number text,
  shipping_bill_date date,
  port_code text,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  cess numeric,
  invoice_value numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with tax as (
    select e.voucher_id,
           sum(case when m.purpose = 'output_cgst' then e.credit_amount - e.debit_amount else 0 end) as cgst,
           sum(case when m.purpose = 'output_sgst' then e.credit_amount - e.debit_amount else 0 end) as sgst,
           sum(case when m.purpose = 'output_igst' then e.credit_amount - e.debit_amount else 0 end) as igst,
           sum(case when m.purpose = 'output_cess' then e.credit_amount - e.debit_amount else 0 end) as cess
      from public.voucher_entries e
      join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
     where e.company_id = p_company_id
       and m.purpose in ('output_cgst', 'output_sgst', 'output_igst', 'output_cess')
     group by e.voucher_id
  ),
  taxable as (
    select vi.voucher_id, sum(vi.amount) as amt,
           bool_or(i.item_type = 'goods') as has_goods
      from public.voucher_items vi
      join public.items i on i.id = vi.item_id
     where vi.company_id = p_company_id
     group by vi.voucher_id
  )
  select
    v.id,
    v.voucher_number,
    v.voucher_date,
    l.name,
    l.gstin,
    v.place_of_supply,
    -- Statutory fact, not inferred: Rule 89(1)'s 3rd proviso bars LUT/bond
    -- for deemed exports entirely (see migration header) — full GST is
    -- always charged, so this is always 'WPAY'.
    'WPAY'::text,
    coalesce(t.has_goods, false),
    s.document_number,
    s.document_date,
    s.port_code,
    coalesce(t.amt, 0),
    coalesce(tx.cgst, 0), coalesce(tx.sgst, 0), coalesce(tx.igst, 0), coalesce(tx.cess, 0),
    coalesce(t.amt, 0) + coalesce(tx.cgst, 0) + coalesce(tx.sgst, 0) + coalesce(tx.igst, 0) + coalesce(tx.cess, 0)
  from public.vouchers v
  join public.ledgers l on l.id = v.party_ledger_id
  left join tax tx on tx.voucher_id = v.id
  left join taxable t on t.voucher_id = v.id
  left join public.exim_shipment_details s on s.voucher_id = v.id and s.document_type = 'shipping_bill'
 where v.company_id = p_company_id
   and not v.is_deleted
   and v.voucher_type = 'sales'
   and v.supply_type = 'deemed_export'
   and v.voucher_date between p_period_start and p_period_end
   and (p_gst_registration_id is null
        or app_private.branch_registration(v.branch_id, v.voucher_date) = p_gst_registration_id)
 order by v.voucher_date, v.voucher_number;
$$;

comment on function public.get_gstr1_table6c is
  'GSTR-1 Table 6C (Deemed Exports, Sec 147 CGST Act) prep: sales vouchers with supply_type = deemed_export. tax_payment is always WPAY (Rule 89(1) 3rd proviso bars LUT/bond for deemed exports — full GST is always charged, see migration header), and cgst/sgst/igst reflect the ORDINARY domestic split by real place of supply, exactly as 0087''s create_invoice computes it — deemed exports are never zero-rated. shipping_bill_number is expected to be null for every row: the goods never leave India, so there is no customs document at all (not merely an optional one, unlike Table 6B). Refund-route election (whether the supplier or the recipient claims the refund, Rule 89/Statement 5B) is not represented — that is a refund-application fact, not a GSTR-1 field, same scoping ITC-04 prep (0072) already applied to Statement 5B/5C.';

revoke all on function public.get_gstr1_table6c(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_gstr1_table6c(uuid, date, date, uuid) to authenticated;

notify pgrst, 'reload schema';
