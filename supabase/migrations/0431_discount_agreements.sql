-- ============================================================================
-- 0431 — Discount agreements: the Sec 15(3)(b) CGST Act gap 0147 deliberately
--        left open, now closed to the extent this schema honestly can
-- ============================================================================
-- 0147 (line-level discounts, "most-felt gap" per the Aug 23 audit) built
-- ONLY Sec 15(3)(a) — a discount agreed before/at the time of supply and
-- "duly recorded in the invoice" — and explicitly deferred Sec 15(3)(b), the
-- POST-supply case, because this schema had "no home" for an agreement
-- record, no structured link from a credit note to the invoice(s) it
-- relates to, and no way to observe the recipient's own ITC reversal. This
-- migration builds the FIRST TWO of those three gaps as an additive layer —
-- a new table plus a new linking table — and is explicit, in the report this
-- migration also ships, about why the third still can't be built here.
--
-- ----------------------------------------------------------------------------
-- THE LAW, RE-CONFIRMED LIVE FOR THIS TASK — A SECOND, SKEPTICAL PASS WAS
-- MANDATORY (the task brief flagged that an earlier AI summary of this exact
-- section inverted its polarity) AND IT FOUND SOMETHING REAL: THE LAW IS
-- MID-CHANGE RIGHT NOW, BUT THE CHANGE IS NOT YET IN FORCE.
-- ----------------------------------------------------------------------------
-- Statutory text, Sec 15(3) CGST Act 2017, AS CURRENTLY IN FORCE (confirmed
-- against the official CBIC repository, taxinformation.cbic.gov.in, whose
-- Section 34 page carries a live amendment-history footnote — see below —
-- not against a summary site):
--   "The value of the supply shall not include any discount which is given—
--    (a) before or at the time of the supply ... ; and
--    (b) after the supply has been effected, if—
--        (i)  such discount is established in terms of an agreement entered
--             into AT OR BEFORE THE TIME OF SUCH SUPPLY and SPECIFICALLY
--             LINKED TO RELEVANT INVOICES; and
--        (ii) input tax credit as is attributable to the discount ... has
--             been REVERSED BY THE RECIPIENT of the supply."
-- Three parts, exactly as 0147 stated: (1) a pre-existing agreement dated at
-- or before the ORIGINAL supply, (2) that agreement specifically linked to
-- the relevant invoice(s), (3) proportionate ITC reversed by the recipient.
-- All three remain conjunctive (AND, not OR) requirements today.
--
-- WHAT THE SKEPTICAL SECOND PASS ACTUALLY CAUGHT: the Finance Act (No. 4),
-- 2026 (assented 30-Mar-2026) already SUBSTITUTES clause (b) — omitting the
-- agreement/invoice-linkage requirement (i) entirely and replacing it with a
-- flat "credit note issued under Sec 34 + recipient reverses ITC" test — per
-- the 56th GST Council meeting (03-Sep-2025) recommendation. A first-pass
-- search reports this as if it were live law today. IT IS NOT: the official
-- CBIC repository's own footnote on Section 34 (taxinformation.cbic.gov.in,
-- fetched today, footnote 7) states this amendment's effective date is
-- "pending — not yet notified" by the Central Government under Sec 1(2) of
-- that Finance Act, which is how nearly every GST rate-of-commencement
-- clause works (a Gazette notification, separate from Presidential assent).
-- Building this migration against the NOT-YET-LIVE three-condition-minus-
-- agreement test would have been statutorily wrong for every day until that
-- notification issues — exactly the kind of dated-law trap 0119's FEMA
-- clock header already flagged this codebase needs to watch for. This
-- migration is built against the law AS IT STANDS TODAY (26-Aug-2026): the
-- full three-part test above. THE DAY THAT NOTIFICATION ISSUES, the
-- agreed_date-vs-supply-date check this migration's report performs becomes
-- informational goodwill evidence rather than a live statutory requirement
-- for NEW credit notes (existing ones filed under the old test still need
-- it) — flagged here so a future session does not have to re-discover this.
-- Sources: taxreply.com's "Finance Act 2026 Notified" summary (30-Mar-2026
-- assent date), a2ztaxcorp.net and ssburad.com on the 56th Council
-- recommendation (omission of 15(3)(b)(i)), cross-checked against the
-- authoritative taxinformation.cbic.gov.in Section 34 page's own footnote
-- showing the amendment as enacted-but-not-commenced. All fetched today.
--
-- THE SECOND THING THE SECOND PASS CAUGHT, WHICH ACTUALLY SIMPLIFIES THIS
-- MIGRATION'S SCOPE VERSUS 0147'S OWN STATED REASON FOR DEFERRING: 0147 cited
-- a "CBIC 2024 circular" requiring a CA/CMA certificate with UDIN as proof of
-- the recipient's ITC reversal, and treated capturing the agreement without
-- that certificate machinery as a dangerous half-implementation. That
-- circular (212/6/2024-GST, 26-Jun-2024) WAS WITHDRAWN on 01-Oct-2025 by
-- Circular No. 253/10/2025-GST — confirmed independently via taxguru.in and
-- a2ztaxcorp.net, both read today, both agreeing on the withdrawal circular
-- number and date. As of today there is NO prescribed certificate mechanism
-- at all; Circular 251/08/2025-GST (12-Sep-2025) separately clarifies that
-- ITC reversal is not even triggered by a purely financial/commercial credit
-- note that leaves the supplier's own declared tax liability unchanged (only
-- a genuine Sec 34 credit note that reduces output tax triggers it) — not
-- this app's situation, since every credit_note voucher here already runs
-- through the full GST computation in create_invoice/update_invoice and
-- therefore always reduces declared output tax. So: 0147's stated blocker
-- (a specific certificate format this schema would need a home for) no
-- longer exists as a live CBIC requirement. What remains genuinely
-- unbuildable is NOT a certificate format — it is condition (ii) itself:
-- whether the recipient's own GSTR-3B actually reversed the credit is a fact
-- about THEIR return, not observable from this supplier's own books under
-- any certificate regime, current or withdrawn. Said plainly in the report
-- this migration ships, not glossed over.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS MIGRATION BUILDS, AND THE DESIGN CHOICES BEHIND IT
-- ----------------------------------------------------------------------------
-- discount_agreements — one row per commercial understanding with a party:
-- who, on what terms (free text, since real agreements range from "flat 5%
-- year-end volume rebate" to a multi-slab schedule no fixed set of columns
-- would capture faithfully — a structured standard_discount_percent is
-- offered alongside as an OPTIONAL shorthand for the common single-rate
-- case, purely informational, never read by any computation), and from what
-- date. is_active is a manual flag, not inferred from any end date — real
-- agreements in this domain are typically open-ended until superseded, and
-- guessing an expiry the user never stated would be worse than asking them
-- to flip a flag when it lapses.
--
-- discount_agreement_links — the evidentiary link, deliberately a SIBLING
-- table rather than a nullable FK on voucher_items (the task's own choice to
-- make): voucher_items is written by create_invoice/update_invoice, both
-- off-limits this session, and a sibling table means this feature never has
-- to touch, or even be aware of, that write path. One row links ONE
-- discount "event" — either a specific sales-invoice LINE that already
-- carries a 0147 discount_percent (voucher_item_id set: the Sec 15(3)(a)
-- case, already valid by being on the invoice; linking it to an agreement
-- here is optional supporting evidence of WHY the discount was given, not a
-- legal necessity) or a WHOLE credit note (voucher_item_id left null: the
-- genuine Sec 15(3)(b) case, since a credit note only exists after the
-- original supply) — to exactly one agreement. A partial unique index on
-- each shape prevents double-linking the same line or the same whole-note to
-- two agreements at once; nothing stops the SAME agreement covering many
-- links, which is the normal case (one distributor agreement, many notes).
--
-- original_invoice_voucher_id — the missing "specifically linked to
-- relevant invoices" half of condition (i), which this schema had genuinely
-- nowhere to record before this migration: a credit note's own
-- reference_number is free text (confirmed live against InvoiceForm.tsx,
-- which never even collects reference_date), so nothing today ties a credit
-- note to a structured original-invoice row. This column does, but ONLY for
-- the whole-credit-note link shape (a line-level link on a sales invoice IS
-- already the invoice; there is no separate "original" to name) — enforced
-- by a trigger, not just documented, because a composite FK cannot express
-- "only when voucher_item_id is null AND the linked voucher is a
-- credit_note." Left nullable even then: a user may still record the
-- agreement link before finding time to identify the exact originating
-- invoice, and a partially-evidenced link is more useful than none.
--
-- COMPOSITE-FK TENANCY, extended one level deeper than usual: this is the
-- first place in the schema that needs to prove a voucher_item genuinely
-- BELONGS TO the voucher it is claimed to belong to (not just that both
-- share a company) — bare id FKs on both would let a caller pair up a real
-- item and a real voucher that happen to be unrelated to each other. Fixed
-- the same way the rest of this codebase fixes cross-tenant references: a
-- new 3-column unique constraint on voucher_items(id, voucher_id,
-- company_id) — trivially satisfied since id already the primary key, so
-- this adds no new rejection of existing data, only a new FK target — and
-- discount_agreement_links' own (voucher_item_id, voucher_id, company_id)
-- FK against it. A multi-column FK with any NULL component (the
-- whole-voucher-link shape) is simply not checked by Postgres (MATCH
-- SIMPLE, the default), which is exactly the behaviour wanted here.
--
-- WHAT THE REPORT (get_discount_agreement_coverage) COVERS AND DOES NOT.
-- Scope is deliberately the literal ask: every voucher_items row with 0147's
-- discount_percent > 0 on a 'sales' or 'credit_note' voucher (Sec 15 only
-- governs the value of an OUTWARD supply, so 'purchase'/'debit_note' rows —
-- where this company is the recipient, not the supplier — are out of
-- scope), PLUS any credit_note explicitly linked whole (voucher_item_id
-- null) even when none of its own lines carry a discount_percent, since
-- that is the normal real-world shape of a pure post-supply rebate (a
-- credit note for a flat rupee amount, not phrased as a percent off any one
-- line). A credit note that is neither a discount_percent line NOR
-- explicitly linked whole is NOT surfaced as an unbacked discount — this
-- schema has no way to tell a genuine-goods-return credit note apart from
-- an un-flagged rebate one, and guessing would be exactly the "automatic
-- matching" the task brief said not to build. "Backed" requires: a link
-- exists, the linked agreement is_active, AND agreed_date is on or before
-- the relevant supply date — the ORIGINAL invoice's date when
-- original_invoice_voucher_id is set, else the voucher's own date (a
-- necessary but not sufficient proxy when no original invoice is named,
-- since the true original supply can only be earlier still — the report
-- says so in its own footer, not just here). "Backed" here proves condition
-- (i) only. Condition (ii), recipient ITC reversal, is stated as
-- unverifiable from this company's own books in the report's own copy —
-- never silently implied by a green badge.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. voucher_items needs a (id, voucher_id, company_id) unique target so a
--    downstream link can prove "this item belongs to that voucher", not just
--    "both belong to this company". Purely additive: id is already the
--    primary key, so this constraint rejects nothing that exists today.
-- ----------------------------------------------------------------------------
alter table public.voucher_items
  add constraint voucher_items_id_voucher_id_company_id_key unique (id, voucher_id, company_id);

-- ----------------------------------------------------------------------------
-- 1. discount_agreements
-- ----------------------------------------------------------------------------
create table public.discount_agreements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  party_ledger_id uuid not null,
  terms text not null check (length(trim(terms)) > 0),
  standard_discount_percent numeric(5, 2)
    check (standard_discount_percent is null or (standard_discount_percent >= 0 and standard_discount_percent <= 100)),
  agreed_date date not null,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (party_ledger_id, company_id) references public.ledgers (id, company_id)
);

create index discount_agreements_company_idx on public.discount_agreements (company_id);
create index discount_agreements_party_idx on public.discount_agreements (company_id, party_ledger_id);

create trigger set_updated_at before update on public.discount_agreements
  for each row execute function app_private.set_updated_at();

alter table public.discount_agreements enable row level security;

create policy discount_agreements_read on public.discount_agreements
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy discount_agreements_write on public.discount_agreements
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.discount_agreements is
  'A commercial discount understanding with a party, dated. The Sec 15(3)(b)(i) CGST Act "agreement entered into at or before the time of such supply" record this schema had nowhere to keep before this migration. terms is free text (a slab schedule or a one-line flat rate both fit); standard_discount_percent is an OPTIONAL structured shorthand, purely informational, never read by any tax computation. is_active is a manual flag — no inferred expiry. See 0431.';
comment on column public.discount_agreements.agreed_date is
  'The date this agreement was entered into. Sec 15(3)(b)(i) requires this be at or before the time of the SUPPLY the discount later relates to — checked by get_discount_agreement_coverage against each linked voucher''s (or its named original invoice''s) date, not enforced here since the agreement necessarily predates knowing which vouchers will ever be linked to it. See 0431.';

-- ----------------------------------------------------------------------------
-- 2. discount_agreement_links — the evidentiary link, a sibling table so
--    voucher_items/create_invoice/update_invoice never need to change.
-- ----------------------------------------------------------------------------
create table public.discount_agreement_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  agreement_id uuid not null,
  voucher_id uuid not null,
  -- Set: a specific sales-invoice line that already carries a 0147
  -- discount_percent (the Sec 15(3)(a) case — optional supporting evidence).
  -- Null: the WHOLE voucher (always a credit_note in practice — see the
  -- trigger below) is the discount (the Sec 15(3)(b) case).
  voucher_item_id uuid,
  -- Only meaningful, and only trigger-permitted, when voucher_item_id is
  -- null AND voucher_id is a credit_note: the specific ORIGINAL sales
  -- invoice this post-supply discount relates to — Sec 15(3)(b)(i)'s
  -- "specifically linked to relevant invoices", which nothing else in this
  -- schema records structurally (a credit note's reference_number is free
  -- text). Left nullable even then: a link can be recorded before the exact
  -- original invoice is identified.
  original_invoice_voucher_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (agreement_id, company_id) references public.discount_agreements (id, company_id) on delete cascade,
  foreign key (voucher_id, company_id) references public.vouchers (id, company_id) on delete cascade,
  -- Proves the item genuinely belongs to THIS voucher, not just this
  -- company — see the voucher_items constraint added in step 0. A NULL
  -- voucher_item_id (the whole-voucher shape) is simply not checked by this
  -- FK (Postgres MATCH SIMPLE), which is the behaviour wanted here.
  foreign key (voucher_item_id, voucher_id, company_id) references public.voucher_items (id, voucher_id, company_id) on delete cascade,
  foreign key (original_invoice_voucher_id, company_id) references public.vouchers (id, company_id) on delete set null
);

-- One agreement per discount event — a picker, never automatic matching,
-- and never more than one agreement claiming the same line or note.
create unique index discount_agreement_links_line_unique
  on public.discount_agreement_links (voucher_item_id) where voucher_item_id is not null;
create unique index discount_agreement_links_voucher_unique
  on public.discount_agreement_links (voucher_id) where voucher_item_id is null;

create index discount_agreement_links_company_idx on public.discount_agreement_links (company_id);
create index discount_agreement_links_agreement_idx on public.discount_agreement_links (agreement_id);

alter table public.discount_agreement_links enable row level security;

create policy discount_agreement_links_read on public.discount_agreement_links
  for select to authenticated using ((select app_private.is_company_member(company_id)));
create policy discount_agreement_links_write on public.discount_agreement_links
  for all to authenticated
  using ((select app_private.can_write_company(company_id)))
  with check ((select app_private.can_write_company(company_id)));

comment on table public.discount_agreement_links is
  'Links ONE discounted line (voucher_item_id set) or ONE whole credit note (voucher_item_id null) to exactly one discount_agreements row, recorded at the time the credit note or discounted line is entered by a manual picker — never automatic matching. See 0431.';

-- ----------------------------------------------------------------------------
-- 3. Cross-table validation a composite FK cannot express: the voucher must
--    be a sales invoice or credit note, its party must match the agreement's
--    party, and original_invoice_voucher_id (when set) must be a same-party
--    sales invoice dated on or before the credit note, only ever attached to
--    a whole-credit-note link. security invoker + RLS — the caller already
--    has read access to every row this touches (they hold write access to
--    the same company these rows already belong to, per the composite FKs).
-- ----------------------------------------------------------------------------
create or replace function app_private.validate_discount_agreement_link()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_type text;
  v_party uuid;
  v_date date;
  a_party uuid;
  item_discount numeric;
  o_type text;
  o_party uuid;
  o_date date;
begin
  select voucher_type, party_ledger_id, voucher_date into v_type, v_party, v_date
    from public.vouchers where id = new.voucher_id;

  if v_type not in ('sales', 'credit_note') then
    raise exception 'A discount agreement can only be linked to a sales invoice or a credit note, not a % voucher', v_type;
  end if;

  select party_ledger_id into a_party from public.discount_agreements where id = new.agreement_id;
  if a_party is distinct from v_party then
    raise exception 'This agreement is for a different party than the voucher''s party ledger';
  end if;

  if new.voucher_item_id is not null then
    select discount_percent into item_discount from public.voucher_items where id = new.voucher_item_id;
    if item_discount is null or item_discount <= 0 then
      raise exception 'Can only link a line that actually carries a discount (discount_percent > 0)';
    end if;
    if new.original_invoice_voucher_id is not null then
      raise exception 'original_invoice_voucher_id only applies to a whole-voucher (credit note) link, not a specific line';
    end if;
  end if;

  if new.original_invoice_voucher_id is not null then
    if v_type <> 'credit_note' then
      raise exception 'original_invoice_voucher_id only applies when linking a credit note';
    end if;
    if new.original_invoice_voucher_id = new.voucher_id then
      raise exception 'original_invoice_voucher_id cannot be the credit note itself';
    end if;
    select voucher_type, party_ledger_id, voucher_date into o_type, o_party, o_date
      from public.vouchers where id = new.original_invoice_voucher_id;
    if o_type <> 'sales' then
      raise exception 'original_invoice_voucher_id must reference a sales invoice, got a % voucher', o_type;
    end if;
    if o_party is distinct from v_party then
      raise exception 'The original invoice belongs to a different party than the credit note';
    end if;
    if o_date > v_date then
      raise exception 'The original invoice (%) is dated after the credit note (%) — check you picked the right invoice', o_date, v_date;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function app_private.validate_discount_agreement_link() from public, anon;
grant execute on function app_private.validate_discount_agreement_link() to authenticated;

create trigger discount_agreement_links_validate
  before insert or update on public.discount_agreement_links
  for each row execute function app_private.validate_discount_agreement_link();

-- ----------------------------------------------------------------------------
-- 4. get_discount_agreement_coverage — the read-only report: which discounts
--    already given are, and are not, backed by a linked active agreement as
--    at the relevant supply date. security invoker + RLS, exactly like
--    get_itc_180day_reversal (0096) and get_effective_item_price (0147) —
--    the read policies above already scope every joined table correctly per
--    caller, so this adds no privilege beyond what the caller already has.
-- ----------------------------------------------------------------------------
create or replace function public.get_discount_agreement_coverage(
  p_company_id uuid,
  p_from date,
  p_to date
) returns table (
  row_scope text,
  voucher_id uuid,
  voucher_number text,
  voucher_type text,
  voucher_date date,
  party_ledger_id uuid,
  party_name text,
  voucher_item_id uuid,
  item_description text,
  amount_before_discount numeric,
  discount_percent numeric,
  discount_amount numeric,
  net_amount numeric,
  agreement_id uuid,
  agreement_terms text,
  agreement_agreed_date date,
  agreement_is_active boolean,
  original_invoice_voucher_id uuid,
  original_invoice_number text,
  original_invoice_date date,
  is_backed boolean,
  backed_reason text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with events as (
    -- Sec 15(3)(a)-recorded line discounts (0147) and Sec 15(3)(b)
    -- candidate whole credit notes, on outward supplies only.
    select vi.id as ev_voucher_item_id, vi.voucher_id as ev_voucher_id, 'line'::text as ev_scope,
           vi.amount_before_discount as ev_gross, vi.discount_percent as ev_pct,
           vi.discount_amount as ev_discount, vi.amount as ev_net,
           coalesce(it.name, vi.description, 'Line item') as ev_description
      from public.voucher_items vi
      join public.vouchers v on v.id = vi.voucher_id and v.company_id = p_company_id
      left join public.items it on it.id = vi.item_id
     where vi.company_id = p_company_id
       and v.voucher_type in ('sales', 'credit_note')
       and coalesce(v.is_deleted, false) = false
       and vi.discount_percent > 0
       and v.voucher_date between p_from and p_to
    union all
    select null::uuid, v.id, 'whole_voucher'::text,
           v.total_amount, null::numeric, v.total_amount, v.total_amount,
           'Entire credit note'::text
      from public.vouchers v
     where v.company_id = p_company_id
       and v.voucher_type = 'credit_note'
       and coalesce(v.is_deleted, false) = false
       and v.voucher_date between p_from and p_to
       and exists (
             select 1 from public.discount_agreement_links dal
              where dal.company_id = p_company_id
                and dal.voucher_id = v.id
                and dal.voucher_item_id is null
           )
  )
  select
    e.ev_scope,
    v.id,
    v.voucher_number,
    v.voucher_type,
    v.voucher_date,
    v.party_ledger_id,
    l.name,
    e.ev_voucher_item_id,
    e.ev_description,
    e.ev_gross,
    e.ev_pct,
    e.ev_discount,
    e.ev_net,
    da.id,
    da.terms,
    da.agreed_date,
    da.is_active,
    dal.original_invoice_voucher_id,
    ov.voucher_number,
    ov.voucher_date,
    coalesce(
      da.id is not null
        and da.is_active
        and da.agreed_date <= coalesce(ov.voucher_date, v.voucher_date),
      false
    ) as is_backed,
    case
      when da.id is null then 'No agreement linked'
      when not da.is_active then 'Linked agreement is not active'
      when da.agreed_date > coalesce(ov.voucher_date, v.voucher_date) then
        'Linked agreement is dated after the supply it covers — fails the "at or before the time of supply" test'
      when dal.original_invoice_voucher_id is null and e.ev_scope = 'whole_voucher' then
        'Linked and dated in time, but no specific original invoice named — the "specifically linked to relevant invoices" limb is only partly evidenced'
      else 'Linked, active, and dated at or before the relevant supply'
    end as backed_reason
    from events e
    join public.vouchers v on v.id = e.ev_voucher_id
    join public.ledgers l on l.id = v.party_ledger_id
    left join public.discount_agreement_links dal
      on dal.company_id = p_company_id
     and dal.voucher_id = e.ev_voucher_id
     and dal.voucher_item_id is not distinct from e.ev_voucher_item_id
    left join public.discount_agreements da on da.id = dal.agreement_id and da.company_id = p_company_id
    left join public.vouchers ov on ov.id = dal.original_invoice_voucher_id
   order by v.voucher_date desc, v.voucher_number, e.ev_voucher_item_id nulls last;
$$;

revoke all on function public.get_discount_agreement_coverage(uuid, date, date) from public, anon;
grant execute on function public.get_discount_agreement_coverage(uuid, date, date) to authenticated;

comment on function public.get_discount_agreement_coverage(uuid, date, date) is
  'Every 0147 line discount (discount_percent > 0) on a sales/credit_note voucher, plus every credit note explicitly linked whole, in [p_from, p_to] by voucher_date — with whether it is backed by a linked, active discount_agreements row dated at or before the relevant supply (the original invoice''s date when named, else the voucher''s own date as a necessary-but-not-sufficient proxy). "Backed" proves Sec 15(3)(b)(i) only; the recipient''s actual ITC reversal (condition (ii)) is not observable from this company''s own books and is never implied. See 0431.';
