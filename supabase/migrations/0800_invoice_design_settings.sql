-- ============================================================================
-- 0800 — Invoice/bill design settings: the knobs a business actually turns
-- ============================================================================
--
-- THE GAP THIS CLOSES. Since 0125 a company can customise exactly three
-- things about its printed invoice: a logo, a terms & conditions block and a
-- one-line footer note. Confirmed live before writing this, not assumed —
-- a column listing of public.companies returns logo_url,
-- print_terms_and_conditions and print_footer_note and nothing else with a
-- print_ prefix, and app/(app)/[companyId]/settings/print-template/page.tsx
-- reads exactly those three. Everything else about the document is hard-coded
-- in app/(app)/[companyId]/vouchers/[voucherId]/print/page.tsx: the title
-- ("Tax Invoice" for every sales voucher, from a literal TITLE map), the
-- absence of any bank/payment instruction, the absence of a named signatory
-- above the "Authorised Signatory" rule, black-and-white only, and A4 —
-- the last of those hard-coded twice over, once implicitly in the page's CSS
-- and once explicitly as `format: "A4"` in lib/server/renderPrintPdf.ts.
--
-- This migration adds the settings. It deliberately adds NO rendering: a
-- follow-on task owns the print page and the document body. Every column
-- below was chosen against one test — can the existing print layout honour
-- it with a small, obvious change? Anything that would have needed a page
-- builder, a template language, or per-document-type layout variants was
-- left out (see the end of this header).
--
-- ---------------------------------------------------------------------------
-- STATUTORY RESEARCH — the two options that are law, not taste
-- ---------------------------------------------------------------------------
--
-- (1) THE TITLE. "Tax Invoice" is NOT a free label, and printing it on the
-- wrong document is a real contravention, not a cosmetic slip.
--
--   * Section 31(3)(c) CGST Act, 2017 read with Rule 49 CGST Rules, 2017: a
--     registered person supplying EXEMPTED goods or services, or paying tax
--     under the composition levy of Section 10, shall issue a BILL OF SUPPLY
--     and not a tax invoice.
--   * Rule 5(1)(f) CGST Rules, 2017 (conditions and restrictions for
--     composition levy) requires a composition taxable person to "mention
--     the words 'composition taxable person, not eligible to collect tax on
--     supplies' at the top of the bill of supply issued by him". Verbatim
--     from the CBIC rule text; note it is at the TOP of the document, which
--     is why it is a separate flag below rather than folded into the
--     free-text declaration that prints above the signature.
--   * Rule 46A CGST Rules, 2017 (inserted by Notification 45/2017-CT dated
--     13.10.2017): where a registered person supplies taxable AND exempted
--     goods or services to an UNREGISTERED person, a single
--     "invoice-cum-bill of supply" may be issued. B2C only — it does not
--     apply to a supply to another registered person. Hence the third
--     override value below; a retailer selling both taxed and exempt lines
--     over a counter is precisely this app's quick-billing/POS user.
--
--   A CONFLICT RESOLVED AGAINST THE PRIMARY SOURCE, not by picking the
--   fresher-sounding blog. A second, deliberately skeptical search on
--   whether the word "Tax Invoice" is itself a mandatory heading turned up
--   several 2026-dated summaries asserting that the heading "is required
--   explicitly under Rule 46(a)". That is simply false: the CBIC text of
--   Rule 46(a) is "name, address and Goods and Services Tax Identification
--   Number of the supplier". Rule 46 prescribes PARTICULARS, not a title and
--   not a layout; nothing in it mandates the string "Tax Invoice". The real
--   constraint runs the other way — Section 31(3)(c) and Rule 49 name the
--   composition/exempt document a bill of supply, so calling THAT one a tax
--   invoice is what is wrong. The override below therefore exists to let a
--   company stop printing "Tax Invoice", not to let it start.
--
-- (2) THE COPY MARKINGS, and the relaxation that is real but narrow.
--
--   * Rule 48(1) CGST Rules, 2017: for a supply of GOODS the invoice shall
--     be prepared in triplicate — "ORIGINAL FOR RECIPIENT", "DUPLICATE FOR
--     TRANSPORTER", "TRIPLICATE FOR SUPPLIER".
--   * Rule 48(2): for a supply of SERVICES, in duplicate — "ORIGINAL FOR
--     RECIPIENT", "DUPLICATE FOR SUPPLIER". Two copies, and the second one
--     is for the supplier, not the transporter. A single "print three
--     copies" switch would therefore be wrong for a services business,
--     which is why the column below is a three-way mode and not a boolean.
--   * Rule 48(6), inserted by Notification 68/2019-CT dated 13.12.2019:
--     "The provisions of sub-rules (1) and (2) shall not apply to an invoice
--     prepared in the manner specified in sub-rule (4)" — i.e. an e-invoice
--     registered with the IRP. THIS is the relaxation, and it is narrow: the
--     copy markings fall away for e-invoiced documents only. They were not
--     withdrawn generally, and a skeptical second pass hunting for a later
--     omission of Rule 48(1)/(2) found none — both sub-rules are live in the
--     current CBIC text. Separately, Rule 138A(2) lets the QR code carrying
--     the IRN be produced electronically in lieu of the physical invoice
--     copy during transit, which is a documents-to-be-carried question, not
--     a how-to-prepare-the-invoice question, and does not touch Rule 48.
--
--   The consequence for the renderer, stated here so the follow-on task does
--   not have to re-derive it: when print_copy_labels is not 'none' the
--   document repeats itself once per copy with the matching marking, EXCEPT
--   where the voucher has an IRN in public.einvoice_details (0230), in which
--   case Rule 48(6) applies and exactly one unmarked copy is correct.
--
-- (3) THE SIGNATORY. Rule 46(q) requires the "signature or digital signature
--   of the supplier or his authorised representative"; the proviso removes
--   it only "in the case of issuance of an electronic invoice in accordance
--   with the provisions of the Information Technology Act, 2000". A sheet of
--   paper coming out of a printer is not that, so the widespread
--   "computer generated invoice, signature not required" line is not a
--   licence to drop the signature block from a printed document. Nothing
--   here adds or removes that block — the print page already renders
--   "For <company>" over an "Authorised Signatory" rule. These columns only
--   let the company name the human who signs and state the standard price
--   declaration above it, which is what Rule 46(q)'s "authorised
--   representative" is describing.
--
-- Sources traced to primary text: CBIC tax information portal, CGST Rules
-- 2017 — rule 46 (chapter 6), rule 46A, rule 48, rule 49, rule 5 (chapter 2),
-- rule 138A (chapter 16); Notification 45/2017-CT, Notification 68/2019-CT.
--
-- ---------------------------------------------------------------------------
-- DESIGN CALLS
-- ---------------------------------------------------------------------------
--
-- BANK DETAILS ARE FREE TEXT, NOT A REFERENCE TO A BANK LEDGER — and that is
-- the deliberate answer to the obvious "this app already has bank ledgers"
-- objection. Checked live: public.ledgers has 41 columns and NOT ONE of them
-- is an account number, an IFSC, a branch or a beneficiary name (it carries
-- address/city/pincode/gstin/pan for parties, and nothing bank-specific).
-- A foreign key to a bank ledger would therefore print a ledger NAME —
-- "HDFC Bank Current A/c" — into which no customer can actually pay. Making
-- the reference useful would mean adding an account-number/IFSC block to
-- public.ledgers, i.e. building a bank master on a table owned by the
-- reconciliation and payment-file features, to serve a printing decision.
-- It is also not true that the account to print is "whichever bank ledger" —
-- a business with four bank ledgers prints ONE designated collection
-- account, and often prints a beneficiary name that differs from both the
-- ledger name and the company name. So: five plain columns, structured
-- rather than one blob so the document can lay them out as a labelled block,
-- and validated where a real format exists — IFSC through
-- app_private.is_valid_ifsc, which has sat unused in 0001 since the first
-- migration and finally has a caller.
--
-- THE UPI QR SWITCH DEFAULTS TO **TRUE**, WHICH LOOKS WRONG AND IS NOT.
-- Every other new option here defaults to off/null so that a company that
-- touches nothing renders exactly as it does today. For UPI the honest
-- default is the opposite, because the QR is ALREADY printed today: the
-- print page renders it whenever the voucher is a sales invoice, upi_vpa is
-- set (0111) and get_invoice_outstanding returns a positive balance. A
-- boolean defaulting to false would silently REMOVE a QR that fifteen
-- existing companies' invoices may already be carrying. Defaulting to true
-- preserves the current behaviour precisely and makes this an opt-OUT, which
-- is the actual product need — a business that has published a VPA for some
-- other purpose but does not want customers paying invoices over UPI.
-- Deliberately NOT paired with a CHECK requiring upi_vpa to be present: the
-- renderer already guards on that, and a cross-column constraint here would
-- fail every existing row the moment the default landed.
--
-- ACCENT COLOUR IS NULLABLE, meaning "no accent" rather than "black". The
-- document today draws its rules and table borders in the theme's own ink
-- colour; a NOT NULL default of #000000 would be indistinguishable in
-- meaning but would rob the renderer of the ability to tell "this company
-- has never chosen" from "this company chose black", and a settings screen
-- has to be able to offer a Reset.
--
-- WHAT WAS DELIBERATELY NOT BUILT.
--   * No template table, no versioning, no per-voucher-type or per-branch
--     template, and no second saved template to switch between. Every column
--     here is one-per-company and overwrite-in-place, the same shape 0125
--     and 0111 chose, for the same reason: a multi-template system is a
--     genuinely different feature to design when someone actually asks.
--   * No font, margin, column-width, logo-position or section-order control.
--     That is a page builder. The print page is a fixed layout with knobs,
--     and it should stay one.
--   * No per-document watermark, no "DRAFT"/"PAID" stamp, no QR other than
--     the two the app can already produce (UPI, and the e-invoice signed QR
--     from 0230).
--   * No SWIFT/IBAN. The app does model exports (IEC on this very table,
--     EXIM capture in 0119, forex settlement), so an export invoice arguably
--     wants a SWIFT line — but the collection instruction for an export
--     realistically also needs correspondent-bank and IBAN fields, and half
--     of that block is worse than none. Left as a coherent follow-up.
--   * Nothing that is statutory-mandatory is exposed as a switch. Supplier
--     and recipient GSTIN, place of supply, HSN, the rate-wise tax break-up,
--     the reverse-charge indicator, the export/SEZ endorsement under the
--     first proviso to Rule 46 and the IRN/signed QR under Rule 46(r) are
--     not preferences and must never become checkboxes. Those belong to the
--     document, and the follow-on task owns them.
--
-- COLUMN-LEVEL GRANTS — THE MISTAKE THIS APP HAS NOW MADE FOUR TIMES.
-- 0044 locked public.companies to an explicit per-column SELECT/UPDATE
-- allowlist for `authenticated`; 0085, 0111, 0140 and 0141 each added a
-- column and forgot it, every time producing a 42501 that is invisible
-- locally and real in production. tests/db/invariants.test.ts now asserts
-- that every companies column except password_hash/password_protected
-- carries both grants. Verified live before writing this: SELECT and UPDATE
-- are column-level allowlists (37 of 38 columns each), while INSERT is a
-- TABLE-level grant and therefore extends to new columns automatically —
-- which is why only two GRANT statements appear below and not three.
--
-- No new RLS policy is needed. companies_read is is_company_member-gated and
-- companies_update is app_private.is_company_admin-gated; RLS is row-level,
-- so both already cover every column added here. The admin gate is the
-- intended behaviour for this screen: changing what every outgoing invoice
-- says is an admin act.
-- ============================================================================

alter table public.companies
  -- ---- Look -------------------------------------------------------------
  add column if not exists print_accent_color text
    check (print_accent_color is null or print_accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  add column if not exists print_paper_size text not null default 'a4'
    check (print_paper_size in ('a4', 'letter')),

  -- ---- What the document calls itself -----------------------------------
  add column if not exists print_sales_title text not null default 'auto'
    check (print_sales_title in (
      'auto', 'tax_invoice', 'bill_of_supply', 'invoice_cum_bill_of_supply', 'invoice'
    )),
  add column if not exists print_composition_declaration boolean not null default false,
  add column if not exists print_copy_labels text not null default 'none'
    check (print_copy_labels in ('none', 'goods', 'services')),

  -- ---- Who signs it -----------------------------------------------------
  add column if not exists print_declaration_text text
    check (print_declaration_text is null or length(print_declaration_text) <= 1000),
  add column if not exists print_signatory_name text
    check (print_signatory_name is null or length(print_signatory_name) between 1 and 120),
  add column if not exists print_signatory_designation text
    check (print_signatory_designation is null or length(print_signatory_designation) between 1 and 120),

  -- ---- How to pay it ----------------------------------------------------
  add column if not exists print_bank_account_name text
    check (print_bank_account_name is null or length(print_bank_account_name) between 1 and 200),
  add column if not exists print_bank_name text
    check (print_bank_name is null or length(print_bank_name) between 1 and 120),
  add column if not exists print_bank_branch text
    check (print_bank_branch is null or length(print_bank_branch) between 1 and 120),
  add column if not exists print_bank_account_number text
    check (print_bank_account_number is null or print_bank_account_number ~ '^[A-Za-z0-9]{5,34}$'),
  add column if not exists print_bank_ifsc text
    check (app_private.is_valid_ifsc(print_bank_ifsc)),
  add column if not exists print_show_upi_qr boolean not null default true;

-- The bank block is all-or-nothing around its anchor. A stored IFSC or
-- branch with no account number cannot be printed as a payment instruction —
-- it is just orphaned data that the renderer would have to decide what to do
-- with, and every renderer would decide differently.
alter table public.companies
  add constraint companies_print_bank_block_anchored check (
    print_bank_account_number is not null
    or (print_bank_account_name is null
        and print_bank_name is null
        and print_bank_branch is null
        and print_bank_ifsc is null)
  );

-- And an account number alone is not payable. A domestic transfer needs the
-- bank and the IFSC; without both, printing the block would invite a failed
-- NEFT rather than help anyone.
alter table public.companies
  add constraint companies_print_bank_block_payable check (
    print_bank_account_number is null
    or (print_bank_name is not null and print_bank_ifsc is not null)
  );

comment on column public.companies.print_accent_color is
  'Optional #RRGGBB accent for the printed document — the header rule, the '
  'item-table head and the total row. NULL (the default, and every existing '
  'row) means no accent: the document renders in its current ink-on-paper '
  'palette exactly as it does today. See 0800.';

comment on column public.companies.print_paper_size is
  '''a4'' (default) or ''letter''. Drives the print page''s @page size rule '
  'AND the headless-Chromium PDF export, which currently hard-codes '
  'format: "A4" in lib/server/renderPrintPdf.ts. Both must read this or the '
  'browser print and the PDF download will disagree about the page. See 0800.';

comment on column public.companies.print_sales_title is
  'What a SALES voucher''s printed document calls itself. ''auto'' (default) '
  'keeps the print page''s existing hard-coded TITLE map, i.e. "Tax Invoice". '
  'The overrides exist because that map is wrong for some suppliers: '
  'Sec 31(3)(c) CGST Act with Rule 49 requires a BILL OF SUPPLY for an '
  'exempt supply or a composition dealer, and Rule 46A allows a single '
  'INVOICE-CUM-BILL OF SUPPLY for a B2C mix of taxable and exempt supplies. '
  '''invoice'' is for a books-only company outside GST. Purchase bills and '
  'credit/debit notes are NOT affected — Sec 34 names those. See 0800.';

comment on column public.companies.print_composition_declaration is
  'When true, the document prints "Composition taxable person, not eligible '
  'to collect tax on supplies" AT THE TOP, which Rule 5(1)(f) CGST Rules '
  'requires of a composition taxable person on every bill of supply. '
  'Default false. See 0800.';

comment on column public.companies.print_copy_labels is
  'Rule 48(1)/(2) copy markings. ''none'' (default) prints one unmarked copy, '
  'today''s behaviour. ''goods'' prints three copies marked ORIGINAL FOR '
  'RECIPIENT / DUPLICATE FOR TRANSPORTER / TRIPLICATE FOR SUPPLIER; '
  '''services'' prints two, ORIGINAL FOR RECIPIENT / DUPLICATE FOR SUPPLIER '
  '(the second copy is the supplier''s, not the transporter''s). The '
  'renderer must suppress the markings entirely for a voucher that has an '
  'IRN in einvoice_details: Rule 48(6) disapplies sub-rules (1) and (2) to '
  'an invoice prepared under Rule 48(4). See 0800.';

comment on column public.companies.print_declaration_text is
  'Free-text declaration printed immediately above the signature block — '
  'typically the standard "We declare that this invoice shows the actual '
  'price of the goods described and that all particulars are true and '
  'correct." Not a statutory particular; Rule 46 neither requires nor '
  'forbids it. NULL (default) prints nothing, as today. Capped at 1000 '
  'chars. See 0800.';

comment on column public.companies.print_signatory_name is
  'Name of the person who signs outgoing documents, printed under '
  '"For <company>" and above the Authorised Signatory rule the print page '
  'already draws. Rule 46(q) requires the signature of the supplier or his '
  'authorised representative; naming that representative is what this is. '
  'NULL (default) leaves the block exactly as it prints today. See 0800.';

comment on column public.companies.print_signatory_designation is
  'Designation printed beneath print_signatory_name (e.g. "Director", '
  '"Proprietor", "Authorised Signatory"). Ignored when the name is NULL. '
  'See 0800.';

comment on column public.companies.print_bank_account_name is
  'Beneficiary name to print in the payment block — often not identical to '
  'the company''s own legal_name. Only meaningful alongside '
  'print_bank_account_number (enforced by companies_print_bank_block_anchored). '
  'See 0800.';

comment on column public.companies.print_bank_name is
  'Bank name for the printed payment block. Required whenever an account '
  'number is set (companies_print_bank_block_payable). See 0800.';

comment on column public.companies.print_bank_branch is
  'Branch name for the printed payment block. Optional. See 0800.';

comment on column public.companies.print_bank_account_number is
  'The account customers should pay into, and the ANCHOR of the payment '
  'block: when NULL the renderer prints no bank block at all, and every '
  'other print_bank_* column must also be NULL. Free text rather than a '
  'reference to a bank ledger because public.ledgers stores no account '
  'number, IFSC or branch — see this migration''s header. 5-34 alphanumerics. '
  'See 0800.';

comment on column public.companies.print_bank_ifsc is
  'IFSC of the branch holding print_bank_account_number, validated by '
  'app_private.is_valid_ifsc (0001). Required whenever an account number is '
  'set. See 0800.';

comment on column public.companies.print_show_upi_qr is
  'Whether to print the UPI payment QR. Defaults to TRUE, unlike every other '
  'option here, because the QR is ALREADY printed today whenever the voucher '
  'is a sales invoice, companies.upi_vpa is set (0111) and '
  'get_invoice_outstanding returns a positive balance — a false default '
  'would silently remove it from existing companies'' invoices. Setting this '
  'false suppresses the QR even when a VPA is on file. See 0800.';

-- The two grants this migration exists to not forget. INSERT is table-level
-- on public.companies and needs no restatement; SELECT and UPDATE are
-- per-column allowlists and do.
grant select (
  print_accent_color,
  print_paper_size,
  print_sales_title,
  print_composition_declaration,
  print_copy_labels,
  print_declaration_text,
  print_signatory_name,
  print_signatory_designation,
  print_bank_account_name,
  print_bank_name,
  print_bank_branch,
  print_bank_account_number,
  print_bank_ifsc,
  print_show_upi_qr
) on public.companies to authenticated;

grant update (
  print_accent_color,
  print_paper_size,
  print_sales_title,
  print_composition_declaration,
  print_copy_labels,
  print_declaration_text,
  print_signatory_name,
  print_signatory_designation,
  print_bank_account_name,
  print_bank_name,
  print_bank_branch,
  print_bank_account_number,
  print_bank_ifsc,
  print_show_upi_qr
) on public.companies to authenticated;
