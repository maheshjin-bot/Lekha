-- ============================================================================
-- 0118 — DPT-3 return content: what the deposits return actually discloses
-- ============================================================================
-- get_compliance_calendar already computes DPT-3's DUE DATE (0062: 30 June
-- annually, pvt_ltd/ltd only per this app's own seeded
-- ref_entity_types.roc_forms — not opc, confirmed there and not
-- re-litigated here). This migration is the CONTENT half that date has
-- never had anything behind it: DPT-3 (Form pursuant to Rule 16, Companies
-- (Acceptance of Deposits) Rules 2014) discloses, as on 31 March, both
-- genuine deposits AND amounts received that are NOT deposits because
-- Rule 2(1)(c) exempts them (director loans, bank borrowings, etc) — a
-- company files it even with a NIL deposit balance if it holds any such
-- exempted amount, and every source checked agrees the return is filed by
-- every company other than a government company covered by the Rules
-- (WebSearch, Aug 2026: taxmann.com/post/blog/reporting-exempted-deposits-
-- under-companies-act-deposit-rules, taxguru.in, the ICSI/vjmglobal DPT-3
-- guides — mutually consistent, not a single-source claim).
--
-- WHAT THIS SCHEMA CAN ACTUALLY DETERMINE, RESEARCHED CLAUSE BY CLAUSE
-- (WebSearch, Aug 2026, second skeptical pass on each citation below since
-- this app's own history (0062) has already caught a wrong "obvious"
-- DPT-3 claim once):
--
--   Rule 2(1)(c)(viii) — an amount received from a person who WAS A
--   DIRECTOR of the company at the time of receipt is an exempted deposit
--   for EVERY company, private or public, provided the director gives a
--   written declaration the money is not itself borrowed. A relative of a
--   director gets the SAME exemption, but ONLY for a private company —
--   confirmed via taxmann.com's own quote of the rule text ("a director of
--   the company OR a relative of the director OF THE PRIVATE COMPANY").
--   This schema has no data on relatives at all (company_directors, 0088,
--   holds only the director/KMP themselves) — a genuine relative-of-
--   director loan is therefore INVISIBLE to this function and will fall
--   into the unclassified bucket below, not into this category. Matching
--   here is also restricted to designations that are actually a board
--   seat (director/managing_director/whole_time_director/independent_
--   director/nominee_director/additional_director/alternate_director/
--   designated_partner for an LLP's equivalent) — company_secretary,
--   chief_financial_officer, manager, ceo and opc_nominee are KMP or
--   membership facts, not necessarily a directorship, and Rule
--   2(1)(c)(viii) names "director" specifically, so a CS/CFO loan is left
--   unclassified rather than assumed covered.
--
--   Rule 2(1)(c)(iii)/(iv) — a loan/borrowing from a banking company, SBI
--   or a subsidiary, a Sec 51 Banking Regulation Act notified banking
--   institution, or a co-operative bank ((iii)), or from a Central-
--   Government-notified public financial institution/regional financial
--   institution/insurance company/RBI-scheduled bank ((iv)), is an
--   exempted deposit. This schema's only structural signal is
--   ledgers.party_type = 'bank' — a blunt instrument that cannot tell a
--   scheduled/co-operative bank or a Sec 4A public financial institution
--   apart from an ordinary NBFC or private lender a user happened to mark
--   'bank'. Reported as exempted on that basis with the caveat stated
--   plainly in the output, not silently assumed reliable.
--
--   THIS SCHEMA CANNOT DETECT: share application money pending allotment
--   (Rule 2(1)(c)(vii) — no ledger/group in this schema is earmarked for
--   it; a seeded "Share Application Money" group search came back empty
--   company-wide), advances from customers against a future supply (Rule
--   2(1)(c)(xii), <=365 days), employee security deposits capped at annual
--   salary (Rule 2(1)(c)(x)), inter-corporate loans (Rule 2(1)(c)(v)/(vi)),
--   or a "specified sum" property-transfer advance. None of these get a
--   category here — they are exactly the reason the unclassified bucket
--   exists rather than this function silently defaulting every unmatched
--   loan to "genuine deposit" or to "exempted", either of which would be a
--   fabricated confidence this schema cannot back up.
--
--   THE FUNCTION THEREFORE NEVER EMITS A "genuine deposit" ROW ON ITS OWN
--   JUDGEMENT — determining that ALL exemptions fail is precisely the
--   sub-part above that is not representable, so a ledger that cannot be
--   matched to a director or a bank/FI is returned as unclassified,
--   needing the filer's own judgement, not silently defaulted into either
--   "Deposit" or "Exempted deposit". See scope_deferred in this task's
--   report for the honest framing.
--
-- REUSES ledgers.is_loan_or_deposit READ-ONLY (0041) — "a loan or deposit
-- accepted from one specific lender/depositor", the exact fact DPT-3
-- discloses. Not modified here. OUTSTANDING BALANCE is the ledger's own
-- running balance as on p_fy_end (opening_balance_amount as a pseudo-
-- movement, same convention 0041's get_sec269ss_loan_receipts already
-- established, plus every posted, non-deleted voucher_entries row dated on
-- or before p_fy_end) — Rule 16 asks for the position "as on the 31st day
-- of March", a snapshot, not a period movement, hence the single
-- p_fy_end parameter (no p_fy_start) this task specifies.
--
-- MATCHING A LEDGER TO A DIRECTOR IS NAME/PAN-BASED, NOT A REAL FK, AND
-- THAT CAPS THE CONFIDENCE OF THE OUTPUT — stated plainly, not hidden.
-- ledgers has no FK to company_directors (nothing in this schema needed one
-- before this). Priority order: (1) exact PAN match — both ledgers.pan and
-- company_directors.pan are validated by app_private.is_valid_pan and PAN
-- is unique to the person for life, so this is high confidence; (2) exact
-- normalised name match; (3) the director's name appearing as a substring
-- of the ledger name (e.g. "Rajesh Nair - Director's Loan"), the weakest
-- of the three and the one most likely to false-positive on a coincidental
-- name. match_basis is returned on every matched row so the report can
-- show exactly which of the three applies, rather than presenting a
-- fuzzy substring hit with the same confidence as a PAN match. None of the
-- three confirms the director actually held that designation AT THE TIME
-- the money was received (company_directors has no per-transaction
-- history) — a lapsed director's old loan, or someone who was appointed
-- AFTER accepting a personal loan from the company under a different
-- ledger, would still match on current master data. A false match is a
-- misclassification risk that stays in this function's honest caveats,
-- not a blocker to shipping it, same call this codebase already made for
-- get_sec269ss_loan_receipts (0041)'s "candidates, not a computed
-- violation" framing.
-- ============================================================================

create or replace function public.get_dpt3_return_content(
  p_company_id uuid,
  p_fy_end date
) returns table (
  ledger_id uuid,
  ledger_name text,
  category text,
  rule_reference text,
  outstanding_amount numeric,
  matched_director_id uuid,
  matched_director_name text,
  match_basis text,
  party_type text,
  caveat text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with balances as (
    select
      l.id as ledger_id,
      l.name as ledger_name,
      l.pan as ledger_pan,
      l.party_type,
      (
        (case when l.opening_balance_type = 'credit' then l.opening_balance_amount else -l.opening_balance_amount end)
        + coalesce((
            select sum(ve.credit_amount - ve.debit_amount)
              from public.voucher_entries ve
              join public.vouchers v on v.id = ve.voucher_id
             where ve.ledger_id = l.id
               and ve.company_id = p_company_id
               and not v.is_deleted
               and v.voucher_date <= p_fy_end
          ), 0)
      ) as outstanding_amount
    from public.ledgers l
    where l.company_id = p_company_id
      and l.is_loan_or_deposit
  ),
  matched as (
    select
      b.*,
      d.id as matched_director_id,
      d.name as matched_director_name,
      d.match_basis
    from balances b
    left join lateral (
      select
        cd.id,
        cd.name,
        case
          when cd.pan is not null and b.ledger_pan is not null and cd.pan = b.ledger_pan
            then 'pan_exact'
          when upper(btrim(cd.name)) = upper(btrim(b.ledger_name))
            then 'name_exact'
          when position(upper(btrim(cd.name)) in upper(b.ledger_name)) > 0
            then 'name_fuzzy'
        end as match_basis
      from public.company_directors cd
      where cd.company_id = p_company_id
        and cd.designation = any(array[
          'director', 'managing_director', 'whole_time_director', 'independent_director',
          'nominee_director', 'additional_director', 'alternate_director', 'designated_partner'
        ])
        and (
          (cd.pan is not null and b.ledger_pan is not null and cd.pan = b.ledger_pan)
          or upper(btrim(cd.name)) = upper(btrim(b.ledger_name))
          or position(upper(btrim(cd.name)) in upper(b.ledger_name)) > 0
        )
      order by
        case
          when cd.pan is not null and b.ledger_pan is not null and cd.pan = b.ledger_pan then 0
          when upper(btrim(cd.name)) = upper(btrim(b.ledger_name)) then 1
          else 2
        end,
        (cd.date_of_cessation is not null),
        cd.date_of_appointment desc
      limit 1
    ) d on true
  )
  select
    ledger_id,
    ledger_name,
    case
      when matched_director_id is not null then 'exempted_director_loan'
      when party_type = 'bank' then 'exempted_bank_or_fi_loan'
      else 'unclassified_needs_manual_review'
    end as category,
    case
      when matched_director_id is not null then 'Rule 2(1)(c)(viii)'
      when party_type = 'bank' then 'Rule 2(1)(c)(iii)/(iv)'
      else null
    end as rule_reference,
    outstanding_amount,
    matched_director_id,
    matched_director_name,
    match_basis,
    party_type,
    case
      when matched_director_id is not null then
        'Matched to a director on record (' || match_basis || '). Exemption requires the director''s written declaration that the funds are not themselves borrowed — not verifiable from ledger data.'
      when party_type = 'bank' then
        'Ledger''s party type is set to bank. This schema cannot verify the lender is actually a scheduled/co-operative bank or a Sec 4A-notified financial institution — confirm before relying on the exemption.'
      else
        'Could not be matched to a director or a bank/FI party. May be a relative-of-director loan (private companies only, not tracked by this schema), an inter-corporate loan, a genuine deposit, or another Rule 2(1)(c) exemption this schema does not represent — needs the filer''s own review before categorising.'
    end as caveat
  from matched
  where outstanding_amount > 0.005
  order by category, outstanding_amount desc, ledger_name;
$$;

revoke all on function public.get_dpt3_return_content(uuid, date) from public, anon;
grant execute on function public.get_dpt3_return_content(uuid, date) to authenticated;

comment on function public.get_dpt3_return_content(uuid, date) is
  'DPT-3 return content as on p_fy_end: every ledgers.is_loan_or_deposit (0041) ledger with a positive outstanding credit balance, classified into DPT-3''s disclosure categories as far as this schema''s data can support — exempted_director_loan (Rule 2(1)(c)(viii), matched to company_directors by PAN/name, see migration header for match_basis confidence), exempted_bank_or_fi_loan (Rule 2(1)(c)(iii)/(iv), from ledgers.party_type=bank only), or unclassified_needs_manual_review for everything this schema cannot determine (relative-of-director loans, share application money pending allotment, inter-corporate loans, and genuine deposits alike — see migration header for the full list of what is NOT representable). Never emits a "genuine deposit" classification on its own judgement.';
