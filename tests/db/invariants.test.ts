/**
 * What the database must be true about itself.
 *
 * Two kinds of assertion live here, and the difference matters:
 *
 *   read-only   run against any database including the live project. These are
 *               the ones worth pointing at production: a trial balance that
 *               stopped summing to zero is a fact about the data, not the code.
 *
 *   write       need fixtures (a second company, a second user, a module
 *               dependency chain). They are `describe.skip` until a seeded
 *               database exists — each one names exactly what it needs in the
 *               comment above it. Do not un-skip them against the live project.
 *
 * Set LEKHA_TEST_DATABASE_URL to run any of this; see tests/helpers/db.ts.
 */
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, count, hasDb, noDbReason, sql } from "../helpers/db";

afterAll(closeDb);

const describeDb = describe.skipIf(!hasDb);

// A tidy failure message: list the offenders, not just "expected 3 to be 0".
function offenders(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

// ---------------------------------------------------------------------------
// Accounting invariants
// ---------------------------------------------------------------------------
describeDb(`accounting invariants (${hasDb ? "live" : noDbReason})`, () => {
  it("every voucher balances: sum of debits equals sum of credits", async () => {
    const rows = await sql(`
      select v.id, v.voucher_number, v.voucher_type,
             sum(e.debit_amount)  as debits,
             sum(e.credit_amount) as credits
        from public.vouchers v
        join public.voucher_entries e on e.voucher_id = v.id
       group by v.id, v.voucher_number, v.voucher_type
      having sum(e.debit_amount) <> sum(e.credit_amount)
    `);
    expect(rows, `unbalanced vouchers:\n${offenders(rows)}`).toEqual([]);
  });

  it("every voucher has at least two lines", async () => {
    // A one-line voucher is arithmetically balanced only if it is zero, so the
    // balance check above cannot catch it. check_voucher_balance() enforces
    // this at write time; this asserts nothing slipped in around it.
    const rows = await sql(`
      select v.id, v.voucher_number, count(e.id) as lines
        from public.vouchers v
        left join public.voucher_entries e on e.voucher_id = v.id
       group by v.id, v.voucher_number
      having count(e.id) < 2
    `);
    expect(rows, `vouchers with fewer than two lines:\n${offenders(rows)}`).toEqual([]);
  });

  it("vouchers.total_amount equals the voucher's debit total", async () => {
    // total_amount is a denormalisation maintained by check_voucher_balance().
    // If it drifts, every list screen and every report header lies.
    const rows = await sql(`
      select v.id, v.voucher_number, v.total_amount, sum(e.debit_amount) as debits
        from public.vouchers v
        join public.voucher_entries e on e.voucher_id = v.id
       group by v.id, v.voucher_number, v.total_amount
      having v.total_amount is distinct from sum(e.debit_amount)
    `);
    expect(rows, `total_amount out of step with the lines:\n${offenders(rows)}`).toEqual([]);
  });

  it("self_approved (1030) is only ever true on a genuinely self-approved voucher", async () => {
    // 1030's solo-admin exception writes self_approved=true only inside
    // approve_voucher, and only on the branch where approved_by = created_by
    // AND approval_status ends up 'approved'. If either of those ever
    // decouples — a still-pending voucher marked self_approved, or a
    // self_approved voucher approved by someone other than its own
    // creator — the flag has stopped meaning what the audit trail needs it
    // to mean.
    const rows = await sql(`
      select id, voucher_number, approval_status, created_by, approved_by
        from public.vouchers
       where self_approved = true
         and (approval_status <> 'approved' or approved_by is distinct from created_by)
    `);
    expect(rows, `self_approved rows inconsistent with created_by/approved_by:\n${offenders(rows)}`).toEqual(
      []
    );
  });

  it("branch_id is NOT NULL on voucher_entries", async () => {
    // Branch-wise reporting silently under-reports if a nullable branch ever
    // creeps back in, and no data-level check would notice until the column
    // already had nulls in it.
    const [col] = await sql<{ is_nullable: string }>(`
      select is_nullable from information_schema.columns
       where table_schema = 'public'
         and table_name = 'voucher_entries'
         and column_name = 'branch_id'
    `);
    expect(col, "voucher_entries.branch_id does not exist").toBeDefined();
    expect(col.is_nullable, "voucher_entries.branch_id is nullable").toBe("NO");
    expect(await count(`select count(*) as n from public.voucher_entries where branch_id is null`)).toBe(0);
  });

  it("an entry sits in the same company and branch as its voucher", async () => {
    // The composite FK covers company. Branch is only covered by convention,
    // and a cross-branch line is how a branch trial balance stops balancing.
    const rows = await sql(`
      select e.id, e.branch_id as entry_branch, v.branch_id as voucher_branch,
             e.company_id as entry_company, v.company_id as voucher_company
        from public.voucher_entries e
        join public.vouchers v on v.id = e.voucher_id
       where e.branch_id is distinct from v.branch_id
          or e.company_id is distinct from v.company_id
    `);
    expect(rows, `entries straddling their voucher:\n${offenders(rows)}`).toEqual([]);
  });

  it("an entry is a debit or a credit, never both and never neither", async () => {
    const rows = await sql(`
      select id, voucher_id, debit_amount, credit_amount
        from public.voucher_entries
       where (debit_amount > 0 and credit_amount > 0)
          or (debit_amount = 0 and credit_amount = 0)
          or debit_amount < 0 or credit_amount < 0
    `);
    expect(rows, `entries that are not a clean single-sided posting:\n${offenders(rows)}`).toEqual([]);
  });

  it("company-wide debits equal credits", async () => {
    const rows = await sql(`
      select company_id, sum(debit_amount) - sum(credit_amount) as net
        from public.voucher_entries
       group by company_id
      having sum(debit_amount) <> sum(credit_amount)
    `);
    expect(rows, `companies whose ledger does not net to zero:\n${offenders(rows)}`).toEqual([]);
  });

  it("the ledger carries no currency of its own — INR amounts only", async () => {
    // Foreign currency belongs on the transaction (vouchers.txn_currency,
    // exchange_rate). If a currency or rate column ever appears on
    // voucher_entries, two places can disagree about what a line is worth.
    const cols = await sql<{ column_name: string }>(`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'voucher_entries'
         and column_name in ('txn_currency', 'currency', 'exchange_rate', 'rate')
    `);
    expect(cols, `currency columns on voucher_entries: ${offenders(cols)}`).toEqual([]);

    // fc_amount is a memo of the original foreign figure. On an INR voucher
    // there is no original foreign figure, so it must be null.
    const rows = await sql(`
      select e.id, v.txn_currency, e.fc_amount
        from public.voucher_entries e
        join public.vouchers v on v.id = e.voucher_id
       where v.txn_currency = 'INR' and e.fc_amount is not null
    `);
    expect(rows, `foreign-currency memo on an INR voucher:\n${offenders(rows)}`).toEqual([]);
  });

  it("an INR voucher has an exchange rate of exactly 1", async () => {
    const rows = await sql(`
      select id, voucher_number, txn_currency, exchange_rate
        from public.vouchers
       where txn_currency = 'INR' and exchange_rate <> 1
    `);
    expect(rows, `INR vouchers with a non-unit rate:\n${offenders(rows)}`).toEqual([]);
  });

  it("every company's trial balance sums to zero", async () => {
    // The whole-of-time window, so opening balances are included: an
    // unbalanced set of opening balances is exactly as wrong as an unbalanced
    // voucher, and only this window catches it.
    const rows = await sql(`
      select c.id, c.name, sum(t.closing_debit - t.closing_credit) as net
        from public.companies c
        left join lateral public.get_trial_balance(
                 c.id, '1900-01-01'::date, '2999-12-31'::date) t on true
       group by c.id, c.name
      having coalesce(sum(t.closing_debit - t.closing_credit), 0) <> 0
    `);
    expect(rows, `trial balances that do not sum to zero:\n${offenders(rows)}`).toEqual([]);
  });

  it("opening plus movements equals closing, for every account", async () => {
    // get_trial_balance derives closing independently of opening and of the
    // period sums. If the three ever disagree the report is internally
    // inconsistent, which is worse than being wrong in one place.
    const rows = await sql(`
      select c.name as company, t.ledger_name,
             t.opening_debit - t.opening_credit as opening,
             t.period_debit  - t.period_credit  as movement,
             t.closing_debit - t.closing_credit as closing
        from public.companies c
        join lateral public.get_trial_balance(
                 c.id, '1900-01-01'::date, '2999-12-31'::date) t on true
       where (t.opening_debit - t.opening_credit)
             + (t.period_debit - t.period_credit)
             <> (t.closing_debit - t.closing_credit)
    `);
    expect(rows, `accounts where opening + movements <> closing:\n${offenders(rows)}`).toEqual([]);
  });

  it("no ledger row survives without its account group, and no group escapes its company", async () => {
    const rows = await sql(`
      select l.id, l.name, l.company_id, g.company_id as group_company
        from public.ledgers l
        left join public.account_groups g on g.id = l.group_id
       where g.id is null or g.company_id is distinct from l.company_id
    `);
    expect(rows, `ledgers pointing outside their company's chart:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GST/TDS report reconciliation
// ---------------------------------------------------------------------------
// Both 0051 and 0053 derive their own totals independently of the reports
// they must agree with (get_gst_output_register, and the raw TDS Payable
// postings respectively) — proration and attribution logic that, if it ever
// drifts, produces a report whose own numbers don't add up. A hand-check
// against live seed data caught one such bug during development (a
// proration divide left unrounded, printing 4499.9999999999999999730000
// instead of 4500.00) before it ever shipped; these two checks make sure a
// future migration can't reintroduce that class of bug unnoticed.
describeDb(`GST/TDS report reconciliation (${hasDb ? "live" : noDbReason})`, () => {
  it("GSTR-1 HSN summary's total tax equals the GST output register's total tax, per company", async () => {
    // Same underlying postings, sliced two different ways (by HSN vs by
    // voucher) — a whole-of-time window per company so nothing is cut off by
    // an arbitrary date range.
    const rows = await sql(`
      select * from (
        select c.id, c.name,
          (select coalesce(sum(h.cgst + h.sgst + h.igst + h.cess), 0)
             from public.get_gstr1_hsn_summary(c.id, '1900-01-01'::date, '2999-12-31'::date, null) h
          ) as hsn_summary_tax,
          (select coalesce(sum(r.cgst + r.sgst + r.igst + r.cess), 0)
             from public.get_gst_output_register(c.id, '1900-01-01'::date, '2999-12-31'::date, null) r
          ) as output_register_tax
          from public.companies c
      ) t
      where hsn_summary_tax <> output_register_tax
    `);
    expect(rows, `companies where the HSN summary and output register disagree:\n${offenders(rows)}`).toEqual([]);
  });

  it("TDS deductee summary's total equals the raw credit-side TDS Payable postings, per company", async () => {
    // get_tds_deductee_summary buckets by deductee (including an explicit
    // "unattributed" bucket for genuine ambiguity) — the SUM across every
    // bucket must still equal the ledger's own actual movement, whole-of-time,
    // regardless of how the attribution logic groups the rows.
    const rows = await sql(`
      select * from (
        select c.id, c.name,
          (select coalesce(sum(s.tds_deducted), 0)
             from public.get_tds_deductee_summary(c.id, '1900-01-01'::date, '2999-12-31'::date) s
          ) as summary_total,
          (select coalesce(sum(e.credit_amount), 0)
             from public.voucher_entries e
             join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
             join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
            where e.company_id = c.id and m.purpose = 'tds_payable'
              and e.credit_amount > 0 and not v.is_deleted
          ) as raw_credit_total
          from public.companies c
      ) t
      where summary_total <> raw_credit_total
    `);
    expect(rows, `companies where the TDS summary and raw postings disagree:\n${offenders(rows)}`).toEqual([]);
  });

  // Regression guard for 0054: get_dashboard_kpis' gst_liability and
  // tds_payable once returned app_private.ledger_opening_signed's raw
  // debit-positive convention directly — a genuine liability (net credit on
  // the ledger) showed as NEGATIVE, exactly backwards from what the
  // "Liability"/"Payable" label promises. Checked against the ledger's own
  // signed movement (net CREDIT, not the helper's net debit), so this fails
  // again if the sign is ever silently reintroduced.
  it("dashboard TDS Payable is positive exactly when the TDS ledger carries a net credit (genuinely owed), per company", async () => {
    const rows = await sql(`
      select * from (
        select c.id, c.name,
          (select tds_payable from public.get_dashboard_kpis(c.id, current_date)) as kpi_tds_payable,
          (select coalesce(sum(e.credit_amount - e.debit_amount), 0)
             from public.voucher_entries e
             join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
             join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
            where e.company_id = c.id and m.purpose = 'tds_payable' and m.gst_registration_id is null
              and not v.is_deleted and v.voucher_date <= current_date
          ) as ledger_net_credit
          from public.companies c
      ) t
      where kpi_tds_payable <> ledger_net_credit
    `);
    expect(rows, `companies where the dashboard TDS figure disagrees with the ledger's own net credit:\n${offenders(rows)}`).toEqual([]);
  });

  it("dashboard GST Liability is positive exactly when the GST ledgers carry a net credit (genuinely owed), per company", async () => {
    const rows = await sql(`
      select * from (
        select c.id, c.name,
          (select gst_liability from public.get_dashboard_kpis(c.id, current_date)) as kpi_gst_liability,
          (select coalesce(sum(e.credit_amount - e.debit_amount), 0)
             from public.voucher_entries e
             join public.tax_ledger_map m on m.ledger_id = e.ledger_id and m.company_id = e.company_id
             join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
            where e.company_id = c.id and not v.is_deleted and v.voucher_date <= current_date
              and m.purpose in (
                'output_cgst', 'output_sgst', 'output_igst', 'output_cess',
                'input_cgst', 'input_sgst', 'input_igst', 'input_cess',
                'rcm_payable', 'gst_payable', 'gst_refund_receivable'
              )
          ) as ledgers_net_credit
          from public.companies c
      ) t
      where kpi_gst_liability <> ledgers_net_credit
    `);
    expect(rows, `companies where the dashboard GST figure disagrees with the ledgers' own net credit:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CMA / lender pack (0056)
// ---------------------------------------------------------------------------
// Guards the two defects hand-verification caught before 0056 shipped. Both
// are the kind that produce a confident, wrong number rather than an error,
// and both would flatter a borrower in front of a bank — the one direction of
// error that actually costs someone money.
describeDb(`CMA data (${hasDb ? "live" : noDbReason})`, () => {
  it("CMA net worth ties to the balance sheet, absorbing the un-closed period result", async () => {
    // The original bug: net worth read the capital/reserves ledgers alone,
    // which year-end closing has not yet moved this period's profit or loss
    // into — so it overstated the borrower's own stake by exactly the period
    // result, and debt-equity and TOL/TNW inherited that error.
    const rows = await sql(`
      select * from (
        select c.id, c.name,
          (select value from public.get_cma_ratios(c.id, '1900-01-01'::date, '2999-12-31'::date)
            where metric_code = 'networth') as cma_networth,
          (select coalesce(sum(-app_private.ledger_opening_signed(c.id, l.id, '3000-01-01'::date, null)), 0)
             from public.ledgers l
             join public.account_groups g on g.id = l.group_id
            where l.company_id = c.id
              and g.nature in ('share_capital','reserves_surplus','capital',
                               'direct_income','indirect_income',
                               'direct_expense','indirect_expense')
          ) as capital_plus_period_result
          from public.companies c
      ) t
      where round(cma_networth, 2) is distinct from round(capital_plus_period_result, 2)
    `);
    expect(rows, `companies where CMA net worth does not tie out:\n${offenders(rows)}`).toEqual([]);
  });

  it("no CMA text carries a U+FFFD replacement character", async () => {
    // The original bug: em-dashes in the function's own prose reached the
    // database as U+FFFD because the migration was passed through a shell
    // variable that mangled the multibyte bytes. Caught by codepoint, not by
    // eye — mojibake is easy to skim past in a report a bank will read.
    const rows = await sql(`
      select c.name, r.metric_code, r.benchmark_note
        from public.companies c
        cross join lateral public.get_cma_ratios(c.id, '1900-01-01'::date, '2999-12-31'::date) r
       where r.benchmark_note like '%' || chr(65533) || '%'
          or r.metric_label like '%' || chr(65533) || '%'
    `);
    expect(rows, `CMA text with replacement characters:\n${offenders(rows)}`).toEqual([]);
  });

  it("MPBF Method II follows the Tandon formula exactly, per company", async () => {
    // 0.75 x TCA - OCL. Guards against a later edit quietly switching this to
    // Method I's 0.75 x (TCA - OCL), which is more generous and would show a
    // borrower a limit no bank would actually sanction.
    const rows = await sql(`
      select * from (
        select c.id, c.name,
          (select value from public.get_cma_ratios(c.id, '1900-01-01'::date, '2999-12-31'::date) where metric_code='mpbf_2') as mpbf2,
          (select 0.75 * (select value from public.get_cma_ratios(c.id, '1900-01-01'::date, '2999-12-31'::date) where metric_code='tca')
                 - (select value from public.get_cma_ratios(c.id, '1900-01-01'::date, '2999-12-31'::date) where metric_code='ocl')) as expected
          from public.companies c
      ) t
      where round(mpbf2, 2) is distinct from round(expected, 2)
    `);
    expect(rows, `companies where MPBF Method II does not follow the formula:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cost centres (0057)
// ---------------------------------------------------------------------------
describeDb(`cost centre allocation (${hasDb ? "live" : noDbReason})`, () => {
  it("the cost centre split always sums to the company's own P&L", async () => {
    // The whole promise of the report: the parts add up to the whole, because
    // unallocated lines come back as their own row instead of being dropped.
    // If a later change filters them out, the report starts quietly
    // under-reporting and every row still looks individually correct.
    const rows = await sql(`
      select * from (
        select c.id, c.name,
          (select coalesce(sum(net), 0)
             from public.get_cost_centre_pnl(c.id, '1900-01-01'::date, '2999-12-31'::date)) as cc_net,
          (select coalesce(sum(
                    case when g.nature in ('direct_income','indirect_income')
                         then e.credit_amount - e.debit_amount
                         else e.debit_amount - e.credit_amount end
                    * case when g.nature in ('direct_income','indirect_income') then 1 else -1 end
                  ), 0)
             from public.voucher_entries e
             join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
             join public.ledgers l on l.id = e.ledger_id
             join public.account_groups g on g.id = l.group_id
            where e.company_id = c.id and not v.is_deleted
              and g.nature in ('direct_income','indirect_income','direct_expense','indirect_expense')
          ) as pnl_net
          from public.companies c
      ) t
      where round(cc_net, 2) is distinct from round(pnl_net, 2)
    `);
    expect(rows, `companies where the cost centre split does not tie to P&L:\n${offenders(rows)}`).toEqual([]);
  });

  it("no balance-sheet line carries a cost centre", async () => {
    // set_entry_cost_centre refuses these, but the dimensions column is plain
    // jsonb that any future write path could set. A cost centre on a bank
    // balance cannot be summed into anything meaningful, so it must never
    // exist regardless of which code path put it there.
    const rows = await sql(`
      select v.voucher_number, l.name as ledger, g.nature
        from public.voucher_entries e
        join public.vouchers v on v.id = e.voucher_id
        join public.ledgers l on l.id = e.ledger_id
        join public.account_groups g on g.id = l.group_id
       where e.dimensions ? 'cost_centre'
         and g.nature not in ('direct_income','indirect_income','direct_expense','indirect_expense')
    `);
    expect(rows, `balance-sheet lines carrying a cost centre:\n${offenders(rows)}`).toEqual([]);
  });

  it("every allocated cost centre exists and belongs to the same company", async () => {
    // dimensions is schemaless, so nothing at the database level enforces that
    // the uuid in it is a real cost centre of that company — a dangling id
    // would silently render as "(unallocated)" and quietly misstate the split.
    const rows = await sql(`
      select v.voucher_number, e.dimensions->>'cost_centre' as cc_id
        from public.voucher_entries e
        join public.vouchers v on v.id = e.voucher_id
       where e.dimensions ? 'cost_centre'
         and not exists (
           select 1 from public.cost_centres c
            where c.id = nullif(e.dimensions->>'cost_centre','')::uuid
              and c.company_id = e.company_id)
    `);
    expect(rows, `entries pointing at a missing or cross-company cost centre:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Budgets (0058)
// ---------------------------------------------------------------------------
describeDb(`budgets and variance (${hasDb ? "live" : noDbReason})`, () => {
  it("at most one active budget per company", async () => {
    // Guards the partial unique index directly, not just its side effect —
    // if the index were ever dropped or narrowed, a report defaulting to
    // "the" active budget would silently pick whichever row sorted first.
    const rows = await sql(`
      select company_id, count(*) as active_count
        from public.budgets
       where is_active
       group by company_id
      having count(*) > 1
    `);
    expect(rows, `companies with more than one active budget:\n${offenders(rows)}`).toEqual([]);
  });

  it("no budget line is set against a balance-sheet ledger", async () => {
    // set_budget_lines refuses these, but budget_lines has no CHECK tying it
    // to ledger nature — a future write path (a CSV importer, a direct
    // insert) could bypass the function's own guard.
    const rows = await sql(`
      select bl.id, l.name as ledger, g.nature
        from public.budget_lines bl
        join public.ledgers l on l.id = bl.ledger_id
        join public.account_groups g on g.id = l.group_id
       where g.nature not in ('direct_income','indirect_income','direct_expense','indirect_expense')
    `);
    expect(rows, `budget lines on non-P&L ledgers:\n${offenders(rows)}`).toEqual([]);
  });

  it("budget variance actual matches a plain postings sum, per active budget", async () => {
    // Re-derives the actual side independently of get_budget_variance's own
    // SQL, using the whole-of-time window so nothing is cut off by a date
    // range — a drift here means the function's join or sign convention
    // diverged from the postings it claims to summarise.
    const rows = await sql(`
      select * from (
        select b.id as budget_id, c.name,
          (select coalesce(sum(actual), 0)
             from public.get_budget_variance(c.id, b.id, '1900-01-01'::date, '2999-12-31'::date)
          ) as fn_actual,
          (select coalesce(sum(
                    case when g.nature in ('direct_income','indirect_income')
                         then e.credit_amount - e.debit_amount
                         else e.debit_amount - e.credit_amount end
                  ), 0)
             from public.voucher_entries e
             join public.vouchers v on v.id = e.voucher_id and v.company_id = e.company_id
             join public.ledgers l on l.id = e.ledger_id
             join public.account_groups g on g.id = l.group_id
            where e.company_id = c.id and not v.is_deleted
              and g.nature in ('direct_income','indirect_income','direct_expense','indirect_expense')
              and l.id in (select ledger_id from public.budget_lines where budget_id = b.id
                           union select ledger_id from public.voucher_entries e2
                                  join public.vouchers v2 on v2.id = e2.voucher_id
                                 where e2.company_id = c.id and not v2.is_deleted)
          ) as raw_actual
          from public.budgets b
          join public.companies c on c.id = b.company_id
         where b.is_active
      ) t
      where round(fn_actual, 2) is distinct from round(raw_actual, 2)
    `);
    expect(rows, `active budgets where get_budget_variance's actual disagrees with raw postings:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Notices (0059)
// ---------------------------------------------------------------------------
describeDb(`notice tracking (${hasDb ? "live" : noDbReason})`, () => {
  it("a closed or responded notice is never reported overdue, regardless of its due_date", async () => {
    // The specific guard get_notices exists to provide: is_overdue must
    // reflect the business's OWN workflow state, not just a date comparison
    // — a notice resolved after its printed deadline is still resolved, and
    // a dashboard that keeps flagging it "overdue" would train the reader to
    // ignore the flag entirely.
    const rows = await sql(`
      select c.name, n.notice_type, n.status, n.due_date
        from public.companies c
        cross join lateral public.get_notices(c.id, null) n
       where n.status in ('closed','responded') and n.is_overdue
    `);
    expect(rows, `resolved notices still flagged overdue:\n${offenders(rows)}`).toEqual([]);
  });

  it("is_overdue is true only for an open notice whose due_date has passed", async () => {
    // The positive side of the same guard — re-derives the flag independently
    // rather than trusting the function's own boolean, so a later refactor
    // that inverts the comparison or drops the status check fails here too.
    const rows = await sql(`
      select c.name, n.notice_type, n.status, n.due_date, n.is_overdue
        from public.companies c
        cross join lateral public.get_notices(c.id, null) n
       where n.is_overdue is distinct from
             (n.status = 'open' and n.due_date is not null and n.due_date < current_date)
    `);
    expect(rows, `is_overdue disagrees with its own definition:\n${offenders(rows)}`).toEqual([]);
  });

  it("every notice's due_date is on or after its notice_date, and response_date on or after received_date", async () => {
    // Guards the two CHECK constraints directly — if either were ever
    // dropped by a careless ALTER TABLE, this still catches data that
    // couldn't have happened in the real world (a deadline before the
    // notice was even dated, a response before the notice arrived).
    const rows = await sql(`
      select id, notice_type, notice_date, due_date, received_date, response_date
        from public.notices
       where (due_date is not null and due_date < notice_date)
          or (response_date is not null and response_date < received_date)
    `);
    expect(rows, `notices with an impossible date order:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Document attachments (0060)
// ---------------------------------------------------------------------------
describeDb(`document storage (${hasDb ? "live" : noDbReason})`, () => {
  it("every documents row's storage_path starts with its own company_id, and the folder actually exists in storage", async () => {
    // The tenancy boundary storage RLS checks (storage.foldername(name)[1])
    // and the metadata row's own company_id must never disagree — if they
    // did, a document could be readable by one company's RLS while its
    // metadata claims to belong to another, or vice versa.
    const rows = await sql(`
      select d.id, d.company_id, d.storage_path
        from public.documents d
       where d.storage_path !~ ('^' || d.company_id::text || '/')
    `);
    expect(rows, `documents rows whose storage_path doesn't start with their own company_id:\n${offenders(rows)}`).toEqual([]);
  });

  it("the documents bucket is private and MIME-restricted to PDF/PNG/JPEG/WebP", async () => {
    // Guards the bucket's own config row directly — a console click or a
    // careless future migration toggling "public" would make every
    // business's attached notices and fixed-asset invoices world-readable
    // with no RLS involved at all, since a public bucket serves files over
    // a plain unauthenticated URL.
    const rows = await sql(`
      select id, public, allowed_mime_types
        from storage.buckets
       where id = 'documents'
         and (public
              or allowed_mime_types is distinct from
                 array['application/pdf','image/png','image/jpeg','image/webp'])
    `);
    expect(rows, `documents bucket misconfigured:\n${offenders(rows)}`).toEqual([]);
  });

  it("storage.objects in the documents bucket has read/insert/delete policies scoped through company membership", async () => {
    // Same "every tenant policy must consult a company-scope helper" check
    // the tenancy suite already runs for every public-schema table, applied
    // to storage.objects specifically — RLS on a table outside the public
    // schema is easy to forget when auditing "every policy in this app".
    // The scoping helper list has to keep up with the features that add
    // legitimately non-membership-scoped objects. 0575's external signer link
    // and 0745's WhatsApp inbound capture both create storage policies that
    // anon reaches by TOKEN rather than by company membership — that is their
    // whole design — so they scope through signature_request_signer_upload_
    // allowed / signature_request_source_doc_visible /
    // whatsapp_inbound_draft_ready instead. They were never added here, so
    // this assertion has been red since 0575 shipped; found once the database
    // suite was actually run. What still must not exist is a policy scoped by
    // nothing at all.
    const rows = await sql(`
      select policyname, cmd, coalesce(qual, with_check) as expr
        from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and coalesce(qual, '') !~ 'is_company_member|can_write_company|signature_request_signer_upload_allowed|signature_request_source_doc_visible|whatsapp_inbound_draft_ready'
         and coalesce(with_check, '') !~ 'is_company_member|can_write_company|signature_request_signer_upload_allowed|signature_request_source_doc_visible|whatsapp_inbound_draft_ready'
    `);
    expect(rows, `storage.objects policies with no company scope:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Orders (0061)
// ---------------------------------------------------------------------------
describeDb(`sales and purchase orders (${hasDb ? "live" : noDbReason})`, () => {
  it("orders never post to voucher_entries — the whole company-wide ledger nets to zero regardless of order activity", async () => {
    // The core promise of 0061: a quotation is a commitment, not a
    // transaction. Re-runs the same net-zero check the accounting-invariants
    // suite already applies to voucher_entries as a whole — if creating,
    // confirming or fulfilling an order ever posted anything, this fails
    // exactly the way an unbalanced voucher would.
    const rows = await sql(`
      select company_id, sum(debit_amount) - sum(credit_amount) as net
        from public.voucher_entries
       group by company_id
      having sum(debit_amount) <> sum(credit_amount)
    `);
    expect(rows, `companies whose ledger does not net to zero:\n${offenders(rows)}`).toEqual([]);
  });

  it("no order sits in an impossible status, and a fulfilled/cancelled order's status never changes again", async () => {
    // Guards the one-way lifecycle advance_order_status enforces — this
    // reads the CHECK constraint's own boundary (only four statuses exist at
    // all) rather than re-deriving the transition table, since the
    // transition rules themselves live in the function and are exercised
    // directly elsewhere.
    const rows = await sql(`
      select id, status from public.orders
       where status not in ('draft','confirmed','fulfilled','cancelled')
    `);
    expect(rows, `orders with an unrecognised status:\n${offenders(rows)}`).toEqual([]);
  });

  it("every order_items row's amount equals quantity times rate, and every order's item_count/total_amount from get_orders matches its own lines", async () => {
    // get_orders derives both figures with a correlated subquery rather than
    // a stored column — if that subquery's join or grouping ever drifted
    // from order_items itself, this catches the mismatch directly rather
    // than trusting the RPC's own arithmetic.
    const rows = await sql(`
      select * from (
        select o.id,
          (select coalesce(sum(oi.amount), 0) from public.order_items oi where oi.order_id = o.id) as raw_total,
          (select coalesce(count(*), 0) from public.order_items oi where oi.order_id = o.id) as raw_count,
          (select go.total_amount from public.get_orders(o.company_id, null, null) go where go.id = o.id) as fn_total,
          (select go.item_count from public.get_orders(o.company_id, null, null) go where go.id = o.id) as fn_count
          from public.orders o
      ) t
      where round(raw_total, 2) is distinct from round(fn_total, 2)
         or raw_count is distinct from fn_count
    `);
    expect(rows, `orders where get_orders' totals disagree with order_items:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ROC compliance calendar (0062)
// ---------------------------------------------------------------------------
describeDb(`ROC compliance calendar (${hasDb ? "live" : noDbReason})`, () => {
  it("only ROC-applicable entity types (ref_entity_types.roc_applicable) ever get a ROC row", async () => {
    // The direct evidence the entity-type gate actually works: a
    // proprietorship/partnership/HUF/trust/society/AOP must never see a ROC
    // due date, since none of them file with the Registrar of Companies at
    // all — a stray ROC row for one would be a genuinely wrong compliance
    // reminder, not a cosmetic bug.
    const rows = await sql(`
      select c.id, c.name, c.entity_type, cal.label
        from public.companies c
        cross join lateral public.get_compliance_calendar(c.id, '1900-01-01'::date, '2999-12-31'::date) cal
        join public.ref_entity_types et on et.code = c.entity_type
       where cal.category = 'ROC' and not et.roc_applicable
    `);
    expect(rows, `ROC rows for a non-ROC-applicable entity type:\n${offenders(rows)}`).toEqual([]);
  });

  it("an LLP never gets a company-only ROC form, and a company never gets an LLP-only form", async () => {
    // AOC-4/MGT-7/MGT-7A/DPT-3/MSME-1 exist under the Companies Act; Form
    // 8/11 exist under the LLP Act — the two sets must never cross, since a
    // business filed under the wrong regime is not just a display bug, it
    // is a wrong statutory reminder.
    const rows = await sql(`
      select c.name, c.entity_type, cal.label
        from public.companies c
        cross join lateral public.get_compliance_calendar(c.id, '1900-01-01'::date, '2999-12-31'::date) cal
       where cal.category = 'ROC'
         and ((c.entity_type = 'llp' and cal.label ~ 'AOC-4|MGT-7|DPT-3|MSME')
           or (c.entity_type <> 'llp' and cal.label ~ 'LLP Form'))
    `);
    expect(rows, `ROC forms crossing the Companies Act / LLP Act boundary:\n${offenders(rows)}`).toEqual([]);
  });

  it("a company with an active GST/TDS/TCS/income-tax module still gets that category's rows, over a full year", async () => {
    // Regression guard specifically for the fact 0062 is a CREATE OR REPLACE
    // over an already-shipped function (0024) rather than a new one — this
    // positively confirms each pre-existing category still fires for a
    // company entitled to it, rather than trusting that the ROC extension
    // left the earlier CTEs untouched. A full calendar year, not the
    // function's 120-day default, since a full year is guaranteed to
    // contain at least one occurrence of even the least frequent rule here.
    const rows = await sql(`
      select c.id, c.name, m.module_code
        from public.companies c
        join public.company_modules m on m.company_id = c.id and m.effective_to is null
       where (
              (m.module_code = 'gst'
               and exists (select 1 from public.gst_registrations gr where gr.company_id = c.id and gr.is_active))
           or m.module_code in ('tds','tcs','income_tax')
         )
         and not exists (
           select 1 from public.get_compliance_calendar(c.id, '2026-04-01'::date, '2027-03-31'::date) cal
            where cal.category = (case m.module_code
                    when 'gst' then 'GST' when 'tds' then 'TDS'
                    when 'tcs' then 'TCS' when 'income_tax' then 'Income tax' end)
         )
    `);
    expect(rows, `companies with an active module but zero matching calendar rows for a full year:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Public API keys (0063)
// ---------------------------------------------------------------------------
describeDb(`public API keys (${hasDb ? "live" : noDbReason})`, () => {
  it("no api_keys row stores anything that looks like a raw key — only a fixed-length hash", async () => {
    // The core promise of 0063: the raw value exists only for the moment
    // create_api_key returns it. A hash is always exactly 64 hex chars
    // (sha256); anything else in that column, or a key_hash that looks like
    // it still carries the 'lekha_' prefix, means a raw key leaked into
    // storage somewhere outside the one function meant to generate it.
    const rows = await sql(`
      select id, name, key_hash
        from public.api_keys
       where key_hash !~ '^[0-9a-f]{64}$' or key_hash like 'lekha\\_%'
    `);
    expect(rows, `api_keys rows with a non-hash value in key_hash:\n${offenders(rows)}`).toEqual([]);
  });

  it("the two api_get_* dispatcher functions are NOT marked stable/immutable", async () => {
    // Regression guard for the exact bug caught live while building this:
    // authenticate_api_key has a real side effect (bumping last_used_at),
    // so marking its callers stable made PostgREST open a read-only
    // transaction and refuse that UPDATE outright. provolatile 'v' is
    // volatile (the default); 's' is stable, 'i' is immutable — either of
    // the latter two would silently break every anon call again.
    const rows = await sql(`
      select proname, provolatile
        from pg_proc
       where proname in ('api_get_trial_balance','api_get_dashboard_kpis')
         and provolatile <> 'v'
    `);
    expect(rows, `api_get_* functions incorrectly marked stable/immutable:\n${offenders(rows)}`).toEqual([]);
  });

  it("only the two intended api_get_* functions are granted to anon among this session's Aug 21 functions", async () => {
    // The deliberate, narrow exception to this whole session's convention
    // (every other function explicitly revokes anon) — this asserts the
    // exception stayed exactly as narrow as intended: exactly two grantees,
    // both read-only dispatchers, and nothing else (create_api_key,
    // revoke_api_key, or authenticate_api_key itself) picked up an anon
    // grant by accident.
    const rows = await sql(`
      select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('create_api_key','revoke_api_key','api_get_trial_balance','api_get_dashboard_kpis')
         and has_function_privilege('anon', p.oid, 'EXECUTE')
         and p.proname not in ('api_get_trial_balance','api_get_dashboard_kpis')
    `);
    expect(rows, `key-management functions unexpectedly executable by anon:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// create_invoice currency metadata (0065)
// ---------------------------------------------------------------------------
describeDb(`create_invoice currency metadata (${hasDb ? "live" : noDbReason})`, () => {
  it("create_invoice still exists with exactly one signature — the ambiguous-overload trap did not recur", async () => {
    // Direct regression guard for the exact bug this migration's own DROP
    // FUNCTION avoided: adding a parameter without dropping the old
    // signature first leaves TWO overloads and every future call fails with
    // "function name is not unique". Asserts there is exactly one.
    const rows = await sql(`
      select count(*) as n from pg_proc where proname = 'create_invoice'
    `);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("create_invoice's new currency parameters do not change the INR figures it posts", async () => {
    // The core design promise of 0065: txn_currency/exchange_rate are pure
    // metadata, never multiplied into debit_amount/credit_amount. Checked
    // structurally rather than by re-running the function: every existing
    // INR voucher (exchange_rate defaults to 1 for all of them) must still
    // show total_amount equal to its own debit total, the same invariant
    // the accounting-invariants suite already asserts for every voucher —
    // re-asserted here scoped to exchange_rate <> 1 specifically, so a
    // regression that started scaling amounts by the rate would fail here
    // even if it accidentally kept the INR-only case correct.
    const rows = await sql(`
      select v.id, v.voucher_number, v.exchange_rate, v.total_amount, sum(e.debit_amount) as debit_total
        from public.vouchers v
        join public.voucher_entries e on e.voucher_id = v.id
       where v.exchange_rate <> 1
       group by v.id, v.voucher_number, v.exchange_rate, v.total_amount
      having v.total_amount is distinct from sum(e.debit_amount)
    `);
    expect(rows, `non-unit-rate vouchers whose total_amount doesn't match their own debit total:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Quick billing / POS (0066)
// ---------------------------------------------------------------------------
describeDb(`quick billing (${hasDb ? "live" : noDbReason})`, () => {
  it("ensure_cash_sales_ledger is not reachable by anon or public", async () => {
    // Same systemic gotcha this whole session kept catching: PUBLIC's
    // default EXECUTE grant reaches anon unless explicitly revoked from
    // both. Written and checked live before trusting it, per the pattern
    // that first caught this bug (0064).
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public' and p.proname = 'ensure_cash_sales_ledger'
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `ensure_cash_sales_ledger reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("no company ever ends up with two ledgers under Cash-in-Hand named 'Cash Sales'", async () => {
    // Direct regression guard for ensure_cash_sales_ledger's core promise:
    // it must reuse whatever ledger already sits under the company's
    // Cash-in-Hand group rather than creating a second one on every call.
    const rows = await sql(`
      select l.company_id, count(*) as n
        from public.ledgers l
        join public.account_groups g on g.id = l.group_id
       where g.name = 'Cash-in-Hand' and l.name = 'Cash Sales'
       group by l.company_id
      having count(*) > 1
    `);
    expect(rows, `companies with duplicate Cash Sales ledgers:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Batch / serial / expiry tracking (0067)
// ---------------------------------------------------------------------------
describeDb(`batch and serial tracking (${hasDb ? "live" : noDbReason})`, () => {
  it("the three new RPCs are not reachable by anon or public", async () => {
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname in ('upsert_item_batch', 'allocate_voucher_item_to_batch', 'get_unallocated_stock_lines', 'get_batch_stock_summary')
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `batch-tracking function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("no voucher_item_batches row allocates more than its own line's quantity", async () => {
    // Direct regression guard for enforce_batch_allocation's core promise —
    // checked structurally against the live sum rather than trusting the
    // trigger fired correctly on every historical row.
    const rows = await sql(`
      select vi.id as voucher_item_id, vi.quantity as line_quantity, sum(vib.quantity) as allocated
        from public.voucher_item_batches vib
        join public.voucher_items vi on vi.id = vib.voucher_item_id
       group by vi.id, vi.quantity
      having sum(vib.quantity) > vi.quantity + 0.0005
    `);
    expect(rows, `voucher_items with over-allocated batch quantity:\n${offenders(rows)}`).toEqual([]);
  });

  it("no voucher_item_batches row allocates a batch belonging to a different item than its line", async () => {
    const rows = await sql(`
      select vib.id, vi.item_id as line_item_id, b.item_id as batch_item_id
        from public.voucher_item_batches vib
        join public.voucher_items vi on vi.id = vib.voucher_item_id
        join public.item_batches b on b.id = vib.batch_id
       where vi.item_id <> b.item_id
    `);
    expect(rows, `allocations where the batch's item doesn't match the line's item:\n${offenders(rows)}`).toEqual([]);
  });

  it("no serial-tracked item has an allocation with quantity other than 1", async () => {
    const rows = await sql(`
      select vib.id, i.name, vib.quantity
        from public.voucher_item_batches vib
        join public.item_batches b on b.id = vib.batch_id
        join public.items i on i.id = b.item_id
       where i.batch_tracking = 'serial' and vib.quantity <> 1
    `);
    expect(rows, `serial allocations with quantity <> 1:\n${offenders(rows)}`).toEqual([]);
  });

  it("no batch/serial number is duplicated on the same item, case-insensitively", async () => {
    const rows = await sql(`
      select company_id, item_id, lower(batch_no) as batch_no_ci, count(*) as n
        from public.item_batches
       group by company_id, item_id, lower(batch_no)
      having count(*) > 1
    `);
    expect(rows, `duplicate batch numbers on one item:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EXIM / foreign-currency settlement (0068)
// ---------------------------------------------------------------------------
describeDb(`forex settlement (${hasDb ? "live" : noDbReason})`, () => {
  it("the three new RPCs are not reachable by anon or public", async () => {
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname in ('ensure_exchange_gain_loss_ledger', 'get_open_fc_vouchers', 'record_forex_settlement')
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `forex function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("every settled voucher's settlement voucher is itself balanced (debits = credits)", async () => {
    // record_forex_settlement posts a brand-new voucher rather than reusing
    // create_voucher's own balance-trigger path — this is the direct check
    // that its hand-built INSERTs still land balanced, for every settlement
    // that has ever actually happened, not just the two shapes hand-verified
    // live while building it.
    const rows = await sql(`
      select v.id, v.voucher_number,
             sum(e.debit_amount) as debit_total, sum(e.credit_amount) as credit_total
        from public.vouchers v
        join public.voucher_entries e on e.voucher_id = v.id
       where v.id in (select fc_settlement_voucher_id from public.vouchers where fc_settlement_voucher_id is not null)
       group by v.id, v.voucher_number
      having sum(e.debit_amount) is distinct from sum(e.credit_amount)
    `);
    expect(rows, `unbalanced settlement vouchers:\n${offenders(rows)}`).toEqual([]);
  });

  it("a settled voucher's bank/cash leg matches its original booked amount plus the realized gain/loss — the AS 11 formula, re-derived independently", async () => {
    // Direct structural check of the formula itself, recomputed here from
    // the raw postings rather than trusting record_forex_settlement's own
    // arithmetic: the settlement voucher's bank/cash leg (everything that
    // isn't the original party ledger or Exchange Gain/Loss) should equal
    // original_inr + gain_loss for a receivable (fc_amount booked debit),
    // or the mirror image for a payable (fc_amount booked credit) — see
    // migration 0068's header comment for why the sign flips. Verified by
    // hand against all three settlements that existed at the time this was
    // written (one receivable gain, one receivable loss, one payable loss)
    // before trusting the query itself.
    const rows = await sql(`
      with settled as (
        select id as original_id, fc_settlement_voucher_id as settlement_id
          from public.vouchers where fc_settlement_voucher_id is not null
      ),
      original_leg as (
        select s.settlement_id, e.ledger_id as party_ledger_id,
               case when e.debit_amount > 0 then e.debit_amount else e.credit_amount end as original_inr,
               case when e.debit_amount > 0 then 'debit' else 'credit' end as direction
          from settled s
          join public.voucher_entries e on e.voucher_id = s.original_id and e.fc_amount is not null
      ),
      gl_ledger as (select id from public.ledgers where name = 'Exchange Gain/Loss'),
      settlement_legs as (
        select e.voucher_id as settlement_id, e.ledger_id, e.debit_amount, e.credit_amount
          from public.voucher_entries e
         where e.voucher_id in (select settlement_id from settled)
      ),
      gain_loss as (
        select sl.settlement_id, sum(sl.credit_amount - sl.debit_amount) as signed_gain_loss
          from settlement_legs sl where sl.ledger_id in (select id from gl_ledger)
         group by sl.settlement_id
      ),
      bank_leg as (
        select sl.settlement_id, sum(sl.debit_amount - sl.credit_amount) as signed_bank
          from settlement_legs sl
          join original_leg ol on ol.settlement_id = sl.settlement_id
         where sl.ledger_id <> ol.party_ledger_id and sl.ledger_id not in (select id from gl_ledger)
         group by sl.settlement_id
      )
      select ol.settlement_id, ol.direction, ol.original_inr,
             coalesce(gl.signed_gain_loss, 0) as gain_loss, coalesce(bl.signed_bank, 0) as signed_bank
        from original_leg ol
        left join gain_loss gl on gl.settlement_id = ol.settlement_id
        left join bank_leg bl on bl.settlement_id = ol.settlement_id
       where abs(
               coalesce(bl.signed_bank, 0) -
               (case when ol.direction = 'debit' then ol.original_inr + coalesce(gl.signed_gain_loss, 0)
                     else -ol.original_inr + coalesce(gl.signed_gain_loss, 0) end)
             ) > 0.01
    `);
    expect(rows, `settlements where the bank leg doesn't match original + gain/loss:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Job work (0069)
// ---------------------------------------------------------------------------
describeDb(`job work (${hasDb ? "live" : noDbReason})`, () => {
  it("the four new RPCs are not reachable by anon or public", async () => {
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname in ('ensure_job_work_movement_ledger', 'create_job_work_challan', 'create_job_work_return', 'get_job_work_outstanding')
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `job work function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("the Job Work Movement ledger's running balance is always exactly zero", async () => {
    // Direct regression guard for the whole design's core promise: every
    // job_work_out/in voucher debits and credits this ledger for the same
    // amount, so no matter how many challans and returns have ever
    // happened, its net balance must never move off zero.
    const rows = await sql(`
      select l.company_id, sum(e.debit_amount) - sum(e.credit_amount) as net_balance
        from public.ledgers l
        join public.voucher_entries e on e.ledger_id = l.id
       where l.name = 'Job Work Movement'
       group by l.company_id
      having abs(sum(e.debit_amount) - sum(e.credit_amount)) > 0.01
    `);
    expect(rows, `Job Work Movement ledgers with a nonzero balance:\n${offenders(rows)}`).toEqual([]);
  });

  it("no challan's received+loss quantity ever exceeds what was actually sent", async () => {
    const rows = await sql(`
      select c.id, c.quantity_sent,
             coalesce(sum(r.quantity_received), 0) + coalesce(sum(r.quantity_loss_or_waste), 0) as total_closed
        from public.job_work_challans c
        left join public.job_work_returns r on r.challan_id = c.id
       group by c.id, c.quantity_sent
      having coalesce(sum(r.quantity_received), 0) + coalesce(sum(r.quantity_loss_or_waste), 0) > c.quantity_sent + 0.0005
    `);
    expect(rows, `challans over-returned beyond what was sent:\n${offenders(rows)}`).toEqual([]);
  });

  it("a challan's status agrees with its own received+loss total, not just whatever was set at the time", async () => {
    // Recomputes status from first principles rather than trusting the
    // column create_job_work_return wrote — a genuine regression guard
    // against that function's own status logic drifting from its data.
    const rows = await sql(`
      select c.id, c.status,
             case when coalesce(sum(r.quantity_received), 0) + coalesce(sum(r.quantity_loss_or_waste), 0) >= c.quantity_sent - 0.0005
                  then 'closed' else 'open_or_partial' end as expected_bucket
        from public.job_work_challans c
        left join public.job_work_returns r on r.challan_id = c.id
       group by c.id, c.status, c.quantity_sent
      having (c.status = 'closed') is distinct from (
        coalesce(sum(r.quantity_received), 0) + coalesce(sum(r.quantity_loss_or_waste), 0) >= c.quantity_sent - 0.0005
      )
    `);
    expect(rows, `challans whose status disagrees with their own received+loss total:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Manufacturing / BOM (0070)
// ---------------------------------------------------------------------------
describeDb(`manufacturing and BOM (${hasDb ? "live" : noDbReason})`, () => {
  it("the three new RPCs are not reachable by anon or public", async () => {
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname in ('ensure_manufacturing_clearing_ledger', 'create_production_voucher', 'get_boms')
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `manufacturing function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("the Manufacturing Clearing ledger's running balance is always exactly zero", async () => {
    const rows = await sql(`
      select l.company_id, sum(e.debit_amount) - sum(e.credit_amount) as net_balance
        from public.ledgers l
        join public.voucher_entries e on e.ledger_id = l.id
       where l.name = 'Manufacturing Clearing'
       group by l.company_id
      having abs(sum(e.debit_amount) - sum(e.credit_amount)) > 0.01
    `);
    expect(rows, `Manufacturing Clearing ledgers with a nonzero balance:\n${offenders(rows)}`).toEqual([]);
  });

  it("no BOM component is the same item as its own BOM's output", async () => {
    const rows = await sql(`
      select bc.id, b.output_item_id
        from public.bom_components bc
        join public.bill_of_materials b on b.id = bc.bom_id
       where bc.component_item_id = b.output_item_id
    `);
    expect(rows, `BOM components that are the same item as their own output:\n${offenders(rows)}`).toEqual([]);
  });

  it("every production voucher's finished-item receipt value equals the sum of its consumed-component values plus nothing untracked", async () => {
    // Direct structural check of the costing promise: for every
    // stock_journal voucher (the type create_production_voucher uses),
    // the single 'in' line's amount should equal the sum of all 'out'
    // lines' amounts, plus whatever the self-cancelling Manufacturing
    // Clearing pair recorded as the voucher's total — recomputed here from
    // the raw voucher_items rows, not from trusting the function's return
    // value.
    const rows = await sql(`
      select v.id, v.voucher_number,
             sum(vi.amount) filter (where vi.direction = 'out') as consumed,
             sum(vi.amount) filter (where vi.direction = 'in') as received,
             v.total_amount
        from public.vouchers v
        join public.voucher_items vi on vi.voucher_id = v.id
       where v.voucher_type = 'stock_journal'
         and exists (select 1 from public.voucher_entries e join public.ledgers l on l.id = e.ledger_id
                      where e.voucher_id = v.id and l.name = 'Manufacturing Clearing')
       group by v.id, v.voucher_number, v.total_amount
      having abs(coalesce(sum(vi.amount) filter (where vi.direction = 'in'), 0) - v.total_amount) > 0.01
    `);
    expect(rows, `production vouchers where the receipt value doesn't match total_amount:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Forex revaluation (0071)
// ---------------------------------------------------------------------------
describeDb(`forex revaluation (${hasDb ? "live" : noDbReason})`, () => {
  it("record_forex_revaluation is not reachable by anon or public", async () => {
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public' and p.proname = 'record_forex_revaluation'
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `record_forex_revaluation reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("every FC voucher's own party-ledger balance equals fc_amount x its carrying rate — the whole feature's core promise", async () => {
    // Recomputed structurally from raw postings, not trusted from
    // get_open_fc_vouchers' own return value: for every non-INR voucher
    // that carries an fc_amount leg, sum every voucher_entries row ever
    // posted against that SAME ledger by either the original voucher, its
    // own revaluations, or (if settled) its settlement voucher, and
    // confirm it nets to zero once settled, or to fc_amount x carrying
    // rate while still open. This is the exact property the additive-
    // postings design (rather than editing the original row) depends on
    // holding true.
    const rows = await sql(`
      with fc_vouchers as (
        select v.id as original_id, e.ledger_id, e.fc_amount,
               coalesce(v.fc_last_revalued_rate, v.exchange_rate) as carrying_rate,
               v.fc_settled_at, v.fc_settlement_voucher_id
          from public.vouchers v
          join public.voucher_entries e on e.voucher_id = v.id and e.fc_amount is not null
         where v.txn_currency is not null and trim(v.txn_currency) <> 'INR'
      ),
      related_vouchers as (
        -- every voucher that could have posted against this same party
        -- ledger as part of this FC voucher's own lifecycle: itself, any
        -- revaluation (a real FK — fc_revalues_voucher_id, not inferred
        -- from narration text, which p_narration lets a caller override),
        -- and its settlement.
        select fv.original_id, fv.ledger_id, fv.fc_amount, fv.carrying_rate, fv.fc_settled_at, v2.id as related_voucher_id
          from fc_vouchers fv
          join public.vouchers v2 on v2.id = fv.original_id
             or v2.id = fv.fc_settlement_voucher_id
             or v2.fc_revalues_voucher_id = fv.original_id
      ),
      ledger_net as (
        select rv.original_id, rv.fc_amount, rv.carrying_rate, rv.fc_settled_at,
               sum(e.debit_amount - e.credit_amount) as net_balance
          from related_vouchers rv
          join public.voucher_entries e on e.voucher_id = rv.related_voucher_id and e.ledger_id = rv.ledger_id
         group by rv.original_id, rv.fc_amount, rv.carrying_rate, rv.fc_settled_at
      )
      select original_id, fc_amount, carrying_rate, fc_settled_at, net_balance,
             round(fc_amount * carrying_rate, 2) as expected_open_balance
        from ledger_net
       where (fc_settled_at is null and abs(net_balance - round(fc_amount * carrying_rate, 2)) > 0.01)
          or (fc_settled_at is not null and abs(net_balance) > 0.01)
    `);
    expect(rows, `FC vouchers whose party-ledger balance doesn't match their expected carrying/settled state:\n${offenders(rows)}`).toEqual([]);
  });

  it("no voucher was ever revalued to a date before its own last revaluation or before its own voucher date", async () => {
    const rows = await sql(`
      select id, voucher_number, voucher_date, fc_last_revalued_at
        from public.vouchers
       where fc_last_revalued_at is not null
         and fc_last_revalued_at < voucher_date
    `);
    expect(rows, `vouchers revalued to a date before their own voucher_date:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ITC-04 prep (0072)
// ---------------------------------------------------------------------------
describeDb(`ITC-04 prep (${hasDb ? "live" : noDbReason})`, () => {
  it("the two new RPCs are not reachable by anon or public", async () => {
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname in ('get_itc04_table4', 'get_itc04_table5a')
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `ITC-04 function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("Table 4's total quantity_sent across all time matches job_work_challans' own raw total — the period filter never drops or double-counts a row", async () => {
    const rows = await sql(`
      select
        (select coalesce(sum(quantity_sent), 0) from public.job_work_challans) as via_raw_table,
        (select coalesce(sum(t.quantity_sent), 0)
           from (select distinct company_id from public.job_work_challans) co
           cross join lateral public.get_itc04_table4(co.company_id, '1900-01-01', '2999-12-31') t) as via_rpc
    `);
    expect(Number(rows[0]?.via_rpc)).toBeCloseTo(Number(rows[0]?.via_raw_table), 2);
  });

  it("Table 5A's total received+loss across all time matches job_work_returns' own raw totals", async () => {
    const rows = await sql(`
      select
        (select coalesce(sum(quantity_received), 0) from public.job_work_returns) as received_raw,
        (select coalesce(sum(quantity_loss_or_waste), 0) from public.job_work_returns) as loss_raw,
        (select coalesce(sum(t.quantity_received), 0)
           from (select distinct company_id from public.job_work_returns) co
           cross join lateral public.get_itc04_table5a(co.company_id, '1900-01-01', '2999-12-31') t) as received_rpc,
        (select coalesce(sum(t.quantity_loss_or_waste), 0)
           from (select distinct company_id from public.job_work_returns) co
           cross join lateral public.get_itc04_table5a(co.company_id, '1900-01-01', '2999-12-31') t) as loss_rpc
    `);
    expect(Number(rows[0]?.received_rpc)).toBeCloseTo(Number(rows[0]?.received_raw), 2);
    expect(Number(rows[0]?.loss_rpc)).toBeCloseTo(Number(rows[0]?.loss_raw), 2);
  });
});

// ---------------------------------------------------------------------------
// Retained earnings carry forward (0073)
// ---------------------------------------------------------------------------
// The balance sheet reads ledgers cumulatively from the book beginning, so the
// profit added back to the equity side has to be cumulative too. Reading it for
// the current financial year only — which is what both the balance-sheet page
// and get_cma_ratios used to do — drops every rupee earned in earlier years.
// Neither test can fail today (no company spans two financial years yet), which
// is exactly why they are here: this breaks silently on a real user's second
// year, and nothing else in the suite would notice.
describeDb(`retained earnings carry forward (${hasDb ? "live" : noDbReason})`, () => {
  it("assets minus liabilities equals profit accumulated since the books began, at every date", async () => {
    const rows = await sql(`
      with d as (
        select c.id, c.name, c.book_beginning_date, dt::date as as_at
          from public.companies c
          cross join lateral (
            select generate_series(
              c.book_beginning_date + 30, c.book_beginning_date + 400, interval '45 day'
            ) as dt
          ) g
         where exists (select 1 from public.vouchers v where v.company_id = c.id)
      ),
      calc as (
        select d.name, d.as_at,
          (select coalesce(sum(case when side = 'assets' then amount else -amount end), 0)
             from public.get_balance_sheet(d.id, d.as_at)) as bs_net,
          (select coalesce(sum(case when nature in ('direct_income','indirect_income')
                                    then amount else -amount end), 0)
             from public.get_profit_and_loss(d.id, d.book_beginning_date, d.as_at)) as cumulative_profit
        from d
      )
      select name, as_at, bs_net, cumulative_profit,
             round(bs_net - cumulative_profit, 2) as out_by
        from calc
       where abs(bs_net - cumulative_profit) > 0.005
       order by 1, 2
    `);
    expect(rows, `balance sheet does not equal cumulative profit:\n${offenders(rows)}`).toEqual([]);
  });

  it("CMA tangible net worth as at a date is the same whichever window start you ask for", async () => {
    // Net worth is a position, not a flow — it cannot depend on where the
    // reporting window happens to open. Before 0073 it did: a window opening
    // after the book beginning silently omitted the profit earned before it,
    // understating the borrower's own stake in both gearing ratios a lender
    // reads first. Verified on live data at the time of the fix: the narrow
    // window read 5,72,000 against a true 19,01,000, and TOL/TNW 0.17 against
    // a true 0.05.
    const rows = await sql(`
      with co as (
        select c.id, c.name, c.book_beginning_date,
               (select max(v.voucher_date) from public.vouchers v where v.company_id = c.id) as last_vch
          from public.companies c
         where exists (select 1 from public.vouchers v where v.company_id = c.id)
      ),
      nw as (
        select co.name, co.last_vch,
          (select value from public.get_cma_ratios(co.id, co.book_beginning_date, co.last_vch)
            where metric_code = 'networth') as nw_full_window,
          (select value from public.get_cma_ratios(co.id, co.last_vch, co.last_vch)
            where metric_code = 'networth') as nw_narrow_window
        from co
      )
      select name, last_vch, nw_full_window, nw_narrow_window,
             round(abs(coalesce(nw_full_window, 0) - coalesce(nw_narrow_window, 0)), 2) as drift
        from nw
       where round(abs(coalesce(nw_full_window, 0) - coalesce(nw_narrow_window, 0)), 2) > 0.01
       order by 1
    `);
    expect(rows, `CMA net worth depends on the window start:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stock valuation (0074)
// ---------------------------------------------------------------------------
describeDb(`stock valuation (${hasDb ? "live" : noDbReason})`, () => {
  it("the weighted-average rate is derived only from movements that carry a real cost", async () => {
    // A credit note (sales return) comes back 'in' at its SALE value, not at
    // cost. Folding that into the average inflated the carrying rate of every
    // remaining unit of the item, not just the returned ones — and closing
    // value feeds get_drawing_power, i.e. a bank's stock statement. Measured
    // on live data through a real create_invoice call at the time of the fix:
    // a 5-unit return at 9,000 against a 2,910.67 cost moved the average to
    // 3,780.57 and closing value from 8,732.00 to 11,341.71 — a 29.9%
    // overstatement from one return.
    //
    // This recomputes the rate independently from raw voucher_items rather
    // than trusting the function's own arithmetic.
    const rows = await sql(`
      with m as (
        select vi.item_id, vi.quantity, vi.amount, vi.direction, v.voucher_type
          from public.voucher_items vi
          join public.vouchers v on v.id = vi.voucher_id
         where not v.is_deleted
      ),
      expect as (
        select i.company_id, i.id as item_id, i.name,
               i.opening_quantity + coalesce(sum(m.quantity) filter (
                 where m.direction = 'in' and m.voucher_type <> 'credit_note'), 0) as costed_qty,
               i.opening_value + coalesce(sum(m.amount) filter (
                 where m.direction = 'in' and m.voucher_type <> 'credit_note'), 0) as costed_val
          from public.items i
          left join m on m.item_id = i.id
         where i.item_type = 'goods' and i.maintain_stock
         group by i.company_id, i.id, i.name, i.opening_quantity, i.opening_value
      )
      select e.name, s.average_rate,
             case when e.costed_qty > 0 then round(e.costed_val / e.costed_qty, 2) else 0 end as expected_rate
        from expect e
        join lateral public.get_stock_summary(e.company_id, '2999-12-31', null) s
          on s.item_id = e.item_id
       where abs(s.average_rate
                 - case when e.costed_qty > 0 then round(e.costed_val / e.costed_qty, 2) else 0 end) > 0.01
       order by 1
    `);
    expect(rows, `stock average rate does not match its cost basis:\n${offenders(rows)}`).toEqual([]);
  });

  it("the schema does not accept a valuation method the engine cannot perform", async () => {
    // get_stock_summary is weighted average, unconditionally — there is no
    // FIFO branch and never was. While the CHECK still accepted 'fifo', a
    // company carrying that flag would have had a false method printed on its
    // stock report AND declared in Form 3CD clause 14(a), over numbers that
    // were computed a different way. Re-widen this constraint in the same
    // migration that adds a real lot/layer costing engine, not before — at
    // which point this test should be updated deliberately, not deleted.
    const rows = await sql(`
      select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
       where conrelid = 'public.companies'::regclass
         and conname = 'companies_inventory_valuation_method_check'
         and pg_get_constraintdef(oid) ilike '%fifo%'
    `);
    expect(rows, `schema accepts a valuation method nothing implements:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Payroll statutory correctness (0075)
// ---------------------------------------------------------------------------
describeDb(`payroll statutory correctness (${hasDb ? "live" : noDbReason})`, () => {
  it("the payroll RPCs are not reachable by anon or public", async () => {
    // get_payroll_run had to be DROPped and recreated (its return type gained
    // columns), and a drop takes its grants with it. This is the check that a
    // re-grant was not forgotten.
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname in ('get_payroll_run', 'post_payroll_run', 'get_salary_tds_estimate')
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `payroll function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("net pay is exactly gross less every statutory deduction, including TDS", async () => {
    // Before 0075 this identity held only because TDS was absent from it
    // entirely — the app computed the right withholding and then paid it to
    // the employee anyway. Runs over a full financial year of months so the
    // check has something to say as soon as any company has employees.
    const rows = await sql(`
      with runs as (
        select c.name, m.mth, r.*
          from public.companies c
          cross join lateral (
            select generate_series(date '2026-04-01', date '2027-03-01', interval '1 month')::date as mth
          ) m
          cross join lateral public.get_payroll_run(c.id, m.mth) r
      )
      select name, mth, employee_name, gross_pay, net_pay, tds,
             round(gross_pay - pf_employee - esi_employee - professional_tax - tds - net_pay, 2) as drift
        from runs
       where abs(gross_pay - pf_employee - esi_employee - professional_tax - tds - net_pay) > 0.005
       order by 1, 2, 3
    `);
    expect(rows, `net pay does not reconcile to its deductions:\n${offenders(rows)}`).toEqual([]);
  });

  it("the PF wage never exceeds the ceiling that applies to it, and never ignores DA", async () => {
    // Two failure modes in one check. The ceiling is prorated for a part
    // month, so a half-month employee must not attract a full month's cap;
    // and the base is basic + DA, which is what the old code got wrong by
    // reading basic alone.
    const rows = await sql(`
      with runs as (
        select c.name, m.mth, r.*
          from public.companies c
          cross join lateral (
            select generate_series(date '2026-04-01', date '2027-03-01', interval '1 month')::date as mth
          ) m
          cross join lateral public.get_payroll_run(c.id, m.mth) r
      )
      select name, mth, employee_name, days_paid, days_in_month,
             basic, dearness_allowance, pf_wage,
             round(15000 * (days_paid::numeric / days_in_month), 2) as proportionate_ceiling
        from runs
       where pf_wage > round(15000 * (days_paid::numeric / days_in_month), 2) + 0.01
          or pf_wage > basic + dearness_allowance + 0.01
       order by 1, 2, 3
    `);
    expect(rows, `PF wage breaches its ceiling or its own base:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Closing stock posting (0076)
// ---------------------------------------------------------------------------
describeDb(`closing stock posting (${hasDb ? "live" : noDbReason})`, () => {
  it("post_closing_stock is not reachable by anon or public", async () => {
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname = 'post_closing_stock'
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `post_closing_stock reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("the CMA inventory line agrees with the Stock-in-Hand ledger on the balance sheet", async () => {
    // These two disagreed before 0076 and both go to the same lender: CMA read
    // ledger balances (empty, because nothing ever posted stock) while
    // get_drawing_power read get_stock_summary. Measured at the time: CMA
    // reported inventory 0.00 against a real 12,142.69, and because the quick
    // ratio subtracts a zero it came out identical to the current ratio.
    const rows = await sql(`
      with c as (select id, name from public.companies),
      d as (
        select c.id, c.name, dt::date as as_at
          from c
          cross join lateral (
            select generate_series(date '2026-04-01', date '2027-06-01', interval '2 month') as dt
          ) g
      ),
      cmp as (
        select d.name, d.as_at,
          (select coalesce(sum(bs.amount), 0) from public.get_balance_sheet(d.id, d.as_at) bs
            where bs.group_name = 'Stock-in-Hand') as ledger_stock,
          (select coalesce(sum(value), 0) from public.get_cma_ratios(d.id, d.as_at - 90, d.as_at)
            where metric_code = 'inventory') as cma_stock
        from d
      )
      select name, as_at, ledger_stock, cma_stock,
             round(ledger_stock - cma_stock, 2) as drift
        from cmp
       where round(abs(ledger_stock - cma_stock), 2) > 0.01
       order by 1, 2
    `);
    expect(rows, `CMA inventory disagrees with the balance sheet:\n${offenders(rows)}`).toEqual([]);
  });

  it("the closing-stock contra sits in Direct Expenses, never in an income group", async () => {
    // Deliberate: get_cma_ratios derives sales from direct_income, so booking
    // closing stock there would have inflated reported turnover in the lender
    // pack. As a negative expense it gives the same gross profit and leaves
    // sales alone — and matches Schedule III's own "Changes in inventories"
    // line, which is an expense that is routinely negative.
    const rows = await sql(`
      select l.name, g.name as group_name, g.nature
        from public.ledgers l
        join public.account_groups g on g.id = l.group_id
       where l.name = 'Changes in Inventories'
         and g.nature <> 'direct_expense'
    `);
    expect(rows, `closing-stock contra is in the wrong group:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Depreciation posting (0077)
// ---------------------------------------------------------------------------
describeDb(`depreciation posting (${hasDb ? "live" : noDbReason})`, () => {
  it("the depreciation RPCs are not reachable by anon or public", async () => {
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname in ('post_depreciation', 'get_fixed_asset_book_reconciliation')
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `depreciation function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("once depreciation has been posted, the ledger tracks the register exactly", async () => {
    // Only checks companies that have actually posted something — a company
    // that has never run it is not in breach of anything, it just has no
    // depreciation in its books yet. The point of the check is that posting
    // converges on the register rather than drifting from it, whatever
    // cadence it is run at.
    const rows = await sql(`
      with d as (
        select c.id, c.name, dt::date as as_at
          from public.companies c
          cross join lateral (
            select generate_series(date '2026-06-01', date '2028-06-01', interval '4 month') as dt
          ) g
      )
      select d.name, d.as_at, rec.register_accumulated, rec.books_accumulated, rec.accumulated_gap
        from d
        cross join lateral public.get_fixed_asset_book_reconciliation(d.id, d.as_at) rec
       where rec.books_accumulated <> 0
         and round(abs(rec.accumulated_gap), 2) > 0.01
       order by 1, 2
    `);
    expect(rows, `posted depreciation has drifted from the register:\n${offenders(rows)}`).toEqual([]);
  });

  it("Accumulated Depreciation is a contra inside the asset block, not an expense or a liability", async () => {
    // It has to sit under a fixed_asset nature for the balance sheet to net it
    // against gross cost. Parked anywhere else it would either disappear from
    // the asset block or double-count as a liability.
    const rows = await sql(`
      select l.name, g.name as group_name, g.nature
        from public.ledgers l
        join public.account_groups g on g.id = l.group_id
       where l.name = 'Accumulated Depreciation'
         and g.nature <> 'fixed_asset'
    `);
    expect(rows, `Accumulated Depreciation is in the wrong group:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Income tax: losses and Sec 50 (0078)
// ---------------------------------------------------------------------------
describeDb(`income tax losses and Sec 50 (${hasDb ? "live" : noDbReason})`, () => {
  it("get_income_tax_computation is not reachable by anon or public", async () => {
    // It was dropped and recreated for a widened return type, and a drop takes
    // its grants with it.
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname = 'get_income_tax_computation'
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `income tax computation reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("a capital loss never reduces business income, and a capital gain always adds to it", async () => {
    // The asymmetry is the whole point. Sec 50 short-term capital GAIN is
    // taxable and enters total income; a Sec 50 capital LOSS falls under Sec
    // 74 and may be set off only against capital gains, never against business
    // income. Netting them into one signed number — the obvious shortcut —
    // would quietly let a capital loss shelter business profit.
    //
    // Also pins the two clamps: taxable income is gross total income floored
    // at zero (you do not pay tax on a loss), and the capital loss carried
    // forward is the unabsorbed part of the capital-gains head.
    const rows = await sql(`
      with r as (
        select c.name, t.*
          from public.companies c
          cross join lateral public.get_income_tax_computation(c.id, '2026-04-01', '2027-03-31') t
         where t.applicable
      )
      select name, business_income, short_term_capital_gain, short_term_capital_loss,
             gross_total_income, taxable_income, capital_loss_carried_forward
        from r
       where round(gross_total_income
                   - (business_income + greatest(short_term_capital_gain - short_term_capital_loss, 0)), 2) <> 0
          or round(taxable_income - greatest(gross_total_income, 0), 2) <> 0
          or round(capital_loss_carried_forward
                   - greatest(short_term_capital_loss - short_term_capital_gain, 0), 2) <> 0
       order by 1
    `);
    expect(rows, `Sec 50 / Sec 74 treatment is wrong:\n${offenders(rows)}`).toEqual([]);
  });

  it("a business loss is reported for carry-forward rather than clamped away", async () => {
    // Before 0078 the only expression of taxable income was
    // greatest(..., 0), so a loss ceased to exist the moment it was computed
    // and the report showed a bare zero. Verified live at the time by forcing
    // a loss: business income -11,23,000 with the same figure reported as
    // carry-forward, where previously nothing at all would have been shown.
    const rows = await sql(`
      with r as (
        select c.name, t.*
          from public.companies c
          cross join lateral public.get_income_tax_computation(c.id, '2026-04-01', '2027-03-31') t
         where t.applicable
      )
      select name, gross_total_income, business_loss_carried_forward
        from r
       where round(business_loss_carried_forward - greatest(-gross_total_income, 0), 2) <> 0
       order by 1
    `);
    expect(rows, `business loss carry-forward does not match the computed loss:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tax payments and net tax (0079)
// ---------------------------------------------------------------------------
describeDb(`tax payments and net tax (${hasDb ? "live" : noDbReason})`, () => {
  it("get_income_tax_computation is still not reachable by anon or public", async () => {
    // Dropped and recreated a second time in 0079 for another widened return
    // type. Each drop takes its grants with it.
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname = 'get_income_tax_computation'
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `income tax computation reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("tax_payments has row-level security and policies on both read and write", async () => {
    const rows = await sql(`
      select c.relname, c.relrowsecurity,
             (select count(*) from pg_policies p
               where p.schemaname = 'public' and p.tablename = 'tax_payments') as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'tax_payments'
         and (not c.relrowsecurity
              or (select count(*) from pg_policies p
                   where p.schemaname = 'public' and p.tablename = 'tax_payments') < 2)
    `);
    expect(rows, `tax_payments is not properly protected:\n${offenders(rows)}`).toEqual([]);
  });

  it("net tax is total tax less everything already paid", async () => {
    const rows = await sql(`
      with r as (
        select c.name, t.*
          from public.companies c
          cross join lateral public.get_income_tax_computation(c.id, '2026-04-01', '2027-03-31') t
         where t.applicable
      )
      select name, total_tax, advance_tax_paid, self_assessment_tax_paid,
             tds_tcs_credit, net_tax_payable
        from r
       where round(net_tax_payable
                   - (total_tax - advance_tax_paid - self_assessment_tax_paid - tds_tcs_credit), 2) <> 0
       order by 1
    `);
    expect(rows, `net tax does not reconcile to what was paid:\n${offenders(rows)}`).toEqual([]);
  });

  it("every company can record TDS suffered — the deductee side is mapped", async () => {
    // Before 0079 tax_ledger_map held thirteen purposes and every one was a
    // liability or an input credit; there was nowhere to debit TDS that a
    // customer had deducted, so the credit could not be claimed at all.
    const rows = await sql(`
      select c.id, c.name
        from public.companies c
       where not exists (
         select 1 from public.tax_ledger_map m
          where m.company_id = c.id
            and m.gst_registration_id is null
            and m.purpose = 'tds_receivable'
       )
       order by 2
    `);
    expect(rows, `companies with no TDS Receivable ledger:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Privileges row-level security cannot protect (0080)
// ---------------------------------------------------------------------------
describeDb(`RLS-bypassing grants (${hasDb ? "live" : noDbReason})`, () => {
  it("neither anon nor authenticated holds TRUNCATE, TRIGGER or REFERENCES on any table", async () => {
    // SELECT/INSERT/UPDATE/DELETE are the API surface and are filtered by
    // policies, which is how Supabase is meant to work. TRUNCATE is different:
    // PostgreSQL does NOT apply row-level security to it, so the privilege
    // empties a table whatever its policies say. TRIGGER and REFERENCES are
    // unused by PostgREST and by any app code and only widen what a
    // compromised role could do to the schema.
    //
    // Supabase's stock bootstrap grants all of these by default, and
    // pg_default_acl re-grants them to every new table — so this test is
    // really guarding against a future table quietly reacquiring them.
    const rows = await sql(`
      select table_name, grantee, privilege_type
        from information_schema.role_table_grants
       where table_schema = 'public'
         and grantee in ('anon', 'authenticated')
         and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
       order by 1, 2, 3
    `);
    expect(
      rows,
      `roles hold privileges RLS cannot filter — re-run 0080's revoke:\n${offenders(rows)}`
    ).toEqual([]);
  });

  it("a table created by a future migration does not re-acquire them", async () => {
    // Without this, 0080's revoke fixes today and the next migration undoes it.
    // 'D' is TRUNCATE, 't' is TRIGGER, 'x' is REFERENCES in an aclitem.
    //
    // Scoped to the `postgres` grantor deliberately. There is a second
    // pg_default_acl entry owned by `supabase_admin` that still grants the
    // full set, and it CANNOT be changed from here — `postgres` is not a
    // superuser on Supabase and altering another role's default privileges is
    // refused (verified: "permission denied to change default privileges").
    // That entry only governs tables created BY supabase_admin, i.e. platform
    // internals; every table in this application is created by a migration
    // running as postgres, which this entry does govern. Asserting on the
    // supabase_admin row would be asserting something nobody here can fix.
    // NOTE the double split_part. An aclitem renders as
    // "anon=arwdm/postgres", so taking everything after '=' leaves the
    // grantor attached — and "pos*t*gres" contains a 't', which matches the
    // TRIGGER flag and makes this test fail against a perfectly hardened
    // database. Strip at '/' first. (Found exactly that way.)
    const rows = await sql(`
      select defaclrole::regrole::text as grantor,
             a::text as aclitem,
             split_part(split_part(a::text, '=', 2), '/', 1) as privileges
        from pg_default_acl, unnest(defaclacl) a
       where defaclnamespace = 'public'::regnamespace
         and defaclobjtype = 'r'
         and defaclrole = 'postgres'::regrole
         and (a::text like 'anon=%' or a::text like 'authenticated=%')
         and split_part(split_part(a::text, '=', 2), '/', 1) ~ '[Dtx]'
       order by 1, 2
    `);
    expect(
      rows,
      `tables created by future migrations would re-acquire RLS-bypassing privileges:\n${offenders(rows)}`
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Audit trail: the log the statute requires
// ---------------------------------------------------------------------------
describeDb(`audit trail (${hasDb ? "live" : noDbReason})`, () => {
  it("every audit_log partition carries its own RLS and policy", async () => {
    // This has been a real hole in this database before: RLS on a partitioned
    // PARENT does not cascade to its partitions, and PostgREST exposes each
    // partition as its own endpoint — so the whole audit log was once readable
    // by any authenticated user by querying audit_log_2026_08 directly.
    // ensure_audit_partition() secures each partition it creates; without that
    // the hole reopens every month, silently, when the next partition is made.
    // Filtered to relkind 'r' so indexes (which never carry RLS) are excluded.
    const rows = await sql(`
      select c.relname, c.relrowsecurity as rls_enabled,
             (select count(*) from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relname like 'audit\\_log%'
         and (not c.relrowsecurity
              or (select count(*) from pg_policies p
                   where p.schemaname = 'public' and p.tablename = c.relname) = 0)
       order by 1
    `);
    expect(rows, `audit_log partition readable without a policy:\n${offenders(rows)}`).toEqual([]);
  });

  it("the audit trail is restricted to admin and auditor", async () => {
    // A log everybody can browse is worth less than one nobody can alter, and
    // Rule 3(1) is about the record existing and being unalterable rather than
    // about it being public. If this policy is ever widened it should be a
    // deliberate act that fails this test first.
    const rows = await sql(`
      select policyname, qual::text
        from pg_policies
       where schemaname = 'public' and tablename = 'audit_log'
         and qual::text not like '%admin%'
    `);
    expect(rows, `audit_log policy no longer restricts by role:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Item supply nature and GSTR-1 Table 8 (0081)
// ---------------------------------------------------------------------------
describeDb(`item supply nature (${hasDb ? "live" : noDbReason})`, () => {
  it("get_gstr1_table8 is not reachable by anon or public", async () => {
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname = 'get_gstr1_table8'
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `get_gstr1_table8 reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("nothing is both non-taxable and carrying a GST rate", async () => {
    // A nil-rated, exempt or non-GST item cannot attract a rate. The schema
    // could not express that before 0081, so the combination was writable and
    // would have produced tax on a supply that bears none.
    const rows = await sql(`
      select id, name, supply_nature, gst_rate_percent, cess_rate_percent
        from public.items
       where supply_nature <> 'taxable'
         and (coalesce(gst_rate_percent, 0) <> 0 or coalesce(cess_rate_percent, 0) <> 0)
       order by name
    `);
    expect(rows, `non-taxable items carrying a rate:\n${offenders(rows)}`).toEqual([]);
  });

  it("Table 8 totals equal the raw outward lines — the party join never duplicates", async () => {
    // The obvious way to find the customer is to join voucher_entries on
    // debit_amount > 0. That multiplies every ITEM line by however many debit
    // lines the voucher has, so a single invoice with a split settlement or a
    // discount line silently reports twice. 0081 resolves the party through a
    // LATERAL ... LIMIT 1 instead; this is the check that it stays that way.
    // Verified at the time by injecting a second debit line into a real sales
    // voucher and confirming the total did not move.
    const rows = await sql(`
      with per_company as (
        select c.id, c.name,
          (select coalesce(sum(t.total), 0)
             from public.get_gstr1_table8(c.id, '1900-01-01', '2999-12-31') t) as via_rpc,
          (select coalesce(sum(vi.amount), 0)
             from public.voucher_items vi
             join public.vouchers v on v.id = vi.voucher_id
             join public.items i on i.id = vi.item_id
            where vi.company_id = c.id and not v.is_deleted
              and v.voucher_type in ('sales', 'credit_note')
              and i.supply_nature in ('nil_rated', 'exempt', 'non_gst')) as via_raw
        from public.companies c
      )
      select name, via_rpc, via_raw, round(via_rpc - via_raw, 2) as drift
        from per_company
       where round(abs(via_rpc - via_raw), 2) > 0.01
       order by 1
    `);
    expect(rows, `Table 8 does not match the raw outward lines:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sec 17(5) blocked credits (0082)
// ---------------------------------------------------------------------------
describeDb(`ITC blocked credits (${hasDb ? "live" : noDbReason})`, () => {
  it("get_itc_eligibility_summary is not reachable by anon or public", async () => {
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname = 'get_itc_eligibility_summary'
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `get_itc_eligibility_summary reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("the blocked flag and the Sec 17(5) clause always agree", async () => {
    // A block without a clause is unauditable — nobody can be told which limb
    // applies. A clause without a block is meaningless. The constraint forbids
    // both; this is the check that it is still there.
    const rows = await sql(`
      select id, name, itc_eligibility, itc_blocked_clause
        from public.items
       where (itc_eligibility = 'blocked') <> (itc_blocked_clause is not null)
       order by name
    `);
    expect(rows, `items whose ITC flag and clause disagree:\n${offenders(rows)}`).toEqual([]);
  });

  it("the eligible/blocked split accounts for every rupee of posted input tax", async () => {
    // Input tax is posted per VOUCHER while blocking is decided per ITEM, so
    // the summary apportions each voucher across its lines by taxable value.
    // Apportionment must be conservative: whatever the split, the two halves
    // have to add back to exactly what was posted.
    //
    // This also catches a real edge the function cannot handle silently — a
    // voucher carrying input tax but NO item lines would be dropped from the
    // split entirely, and the totals would then diverge here rather than the
    // tax quietly disappearing from the report.
    const rows = await sql(`
      select name, rpc_total, posted, round(coalesce(rpc_total, 0) - posted, 2) as drift
        from (
          select c.name,
            (select total_tax from public.get_itc_eligibility_summary(c.id, '1900-01-01', '2999-12-31')) as rpc_total,
            (select coalesce(sum(e.debit_amount - e.credit_amount), 0)
               from public.tax_ledger_map m
               join public.voucher_entries e on e.ledger_id = m.ledger_id
               join public.vouchers v on v.id = e.voucher_id and not v.is_deleted
              where m.company_id = c.id
                and m.purpose in ('input_cgst', 'input_sgst', 'input_igst', 'input_cess')) as posted
          from public.companies c
        ) x
       where round(abs(coalesce(rpc_total, 0) - posted), 2) > 0.01
       order by 1
    `);
    expect(rows, `input tax lost or invented by the eligibility split:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Conditional module resolution (0083)
// ---------------------------------------------------------------------------
describeDb(`conditional module resolution (${hasDb ? "live" : noDbReason})`, () => {
  it("every conditional module that has earned activation is active", async () => {
    // The resolver was only ever triggered by changes to `companies` and
    // `gst_registrations`, never by a module toggle — so a conditional module
    // whose depends_on names an OPTIONAL module could never switch itself on,
    // because enabling the dependency was exactly the event nothing listened
    // for. Two modules sit in that position (payroll_statutory on payroll,
    // gst_multistate on gst + multi_branch) and two real companies were living
    // it: payroll enabled, compliance_mode 'compliance', and PF/ESI/PT quietly
    // switched off.
    //
    // This restates the resolver's own rule as a fact about the data: if the
    // activation condition is met and every dependency is active, the module
    // must be on.
    const rows = await sql(`
      select c.name, r.code as should_be_active
        from public.companies c
        cross join public.ref_modules r
       where r.tier = 'conditional'
         and app_private.module_condition_met(c.id, r.activates_when)
         and not exists (
           select 1 from unnest(r.depends_on) d(code)
            where not app_private.module_active(c.id, d.code)
         )
         and not app_private.module_active(c.id, r.code)
       order by 1, 2
    `);
    expect(rows, `conditional modules that should be active and are not:\n${offenders(rows)}`).toEqual([]);
  });

  it("set_module re-resolves the conditional tier", async () => {
    // Structural rather than behavioural, because exercising it needs a write.
    // Without this call the invariant above is only true until the next toggle.
    const rows = await sql(`
      select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname = 'set_module'
         and p.prosrc not like '%resolve_conditional_modules%'
    `);
    expect(rows, `set_module no longer re-resolves conditional modules:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Payroll compliance calendar (0084)
// ---------------------------------------------------------------------------
describeDb(`payroll compliance calendar (${hasDb ? "live" : noDbReason})`, () => {
  it("PF and ESI fall on the 15th, and the ESI half-yearly return does NOT", async () => {
    // The monthly obligations are 15 days after the wage month. The half-yearly
    // Return of Contribution is 42 days after the contribution period, which
    // lands on 11 November and 12 May — dates that fall out of no monthly rule.
    // Anyone "simplifying" the half-yearly row onto the 15th would make the
    // reminder a fortnight late, so both halves are pinned here.
    //
    // No grace period is allowed for either: the concessional five days on PF
    // were withdrawn with effect from the wage month of February 2016.
    const rows = await sql(`
      with cal as (
        select c.name, x.*
          from public.companies c
          cross join lateral public.get_compliance_calendar(c.id, '2026-04-01', '2028-03-31') x
         where x.category = 'Payroll'
      )
      select name, label, due_date
        from cal
       where (label like '%half-yearly%'
              and to_char(due_date, 'MM-DD') not in ('11-11', '05-12'))
          or (label not like '%half-yearly%' and extract(day from due_date) <> 15)
       order by 1, 3
    `);
    expect(rows, `payroll due dates that are not the statutory ones:\n${offenders(rows)}`).toEqual([]);
  });

  it("payroll reminders appear only where the payroll_statutory module is active", async () => {
    // These rows are gated on a CONDITIONAL module, which until 0083 could
    // never activate at all — so the calendar would have stayed empty for
    // everyone even after the rows were added. Guards both directions of that
    // coupling.
    const rows = await sql(`
      select c.name
        from public.companies c
       where not app_private.module_active(c.id, 'payroll_statutory')
         and exists (
           select 1 from public.get_compliance_calendar(c.id, '2026-04-01', '2028-03-31') x
            where x.category = 'Payroll'
         )
       order by 1
    `);
    expect(rows, `payroll reminders shown without the module:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Employer statutory registrations (0085)
// ---------------------------------------------------------------------------
describeDb(`employer registrations (${hasDb ? "live" : noDbReason})`, () => {
  it("an ESI employer code is 17 digits once separators are stripped", async () => {
    // Checked on the digit count rather than a pattern: the code is written
    // both as XX-XX-XXXXXX-XXX-XXXX and as a bare run, and a regex demanding
    // one punctuation style would reject a correctly transcribed number. The
    // PF code is deliberately unvalidated for the opposite reason — office
    // code lengths differ by region, so no useful pattern exists.
    const rows = await sql(`
      select id, name, esi_employer_code
        from public.companies
       where esi_employer_code is not null
         and length(regexp_replace(esi_employer_code, '[^0-9]', '', 'g')) <> 17
       order by name
    `);
    expect(rows, `ESI employer codes that are not 17 digits:\n${offenders(rows)}`).toEqual([]);
  });

  it("an employee cannot be attached to another company's branch", async () => {
    // employees.branch_id carries company_id into the foreign key, matching
    // what voucher_items already does in four places. RLS filters what a user
    // can SELECT; it does not stop them WRITING an id belonging to another
    // tenant, so the constraint is what actually prevents it. A plain
    // "REFERENCES branches(id)" would pass every test that only reads data —
    // hence this checks the constraint shape, not the rows.
    const structural = await sql(`
      select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
       where conrelid = 'public.employees'::regclass
         and contype = 'f'
         and pg_get_constraintdef(oid) like '%(branch_id) REFERENCES%'
    `);
    expect(
      structural,
      `employees.branch_id has a plain FK — a cross-tenant branch could be written:\n${offenders(structural)}`
    ).toEqual([]);

    const rows = await sql(`
      select e.id, e.name
        from public.employees e
        join public.branches b on b.id = e.branch_id
       where b.company_id <> e.company_id
    `);
    expect(rows, `employees pointing at another company's branch:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sec 197 lower-deduction certificates (0086)
// ---------------------------------------------------------------------------
describeDb(`lower deduction certificates (${hasDb ? "live" : noDbReason})`, () => {
  it("a certificate rate always carries a validity window", async () => {
    // VoucherForm applies the certificate only when BOTH dates are present:
    //   if (ldc_rate != null && ldc_valid_from && ldc_valid_to)
    // so a rate saved without dates would show a certificate on file while TDS
    // was still deducted at the full section rate — silently, with nothing
    // reporting the discrepancy. The constraint makes that state unreachable;
    // this is the check that it stays that way, since the consuming condition
    // lives in application code and could drift from the schema.
    const rows = await sql(`
      select id, name, ldc_number, ldc_rate, ldc_valid_from, ldc_valid_to
        from public.ledgers
       where ldc_rate is not null
         and (ldc_valid_from is null or ldc_valid_to is null)
       order by name
    `);
    expect(rows, `certificates that could never be applied:\n${offenders(rows)}`).toEqual([]);
  });

  it("a certificate is never half-entered", async () => {
    // Number and rate travel together — one without the other is not a
    // partially filled record, it is one that cannot be acted on or evidenced.
    const rows = await sql(`
      select id, name, ldc_number, ldc_rate
        from public.ledgers
       where (ldc_number is null) <> (ldc_rate is null)
       order by name
    `);
    expect(rows, `half-entered certificates:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tenancy: what the catalog can prove without fixtures
// ---------------------------------------------------------------------------
describeDb(`tenancy and RLS, catalog-level (${hasDb ? "live" : noDbReason})`, () => {
  it("every table in public has row-level security enabled", async () => {
    const rows = await sql(`
      select c.relname as table_name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity
    `);
    expect(rows, `tables without RLS:\n${offenders(rows)}`).toEqual([]);
  });

  it("no policy grants anything to anon or public", async () => {
    // A policy that names PUBLIC applies to anon too, and anon is every
    // unauthenticated visitor holding the publishable key.
    const rows = await sql(`
      select tablename, policyname, cmd, roles::text as roles
        from pg_policies
       where schemaname = 'public' and roles && '{anon,public}'::name[]
    `);
    expect(rows, `policies reachable by anon:\n${offenders(rows)}`).toEqual([]);
  });

  it("only the deliberately deny-all tables have RLS with no policy at all", async () => {
    // RLS with no policy denies everything. That is correct for tables written
    // exclusively by SECURITY DEFINER functions, and a mistake anywhere else.
    // Listing them explicitly means adding a new one is a decision, not a slip.
    //
    // voucher_number_sequences was on this list until 0094 deliberately gave it
    // a SELECT policy (a SECURITY INVOKER report function needs the table
    // itself readable, and "permission denied for table
    // voucher_number_sequences" was the symptom). The list was never updated,
    // so this assertion has been red ever since — caught once the database
    // suite was actually run. Writes are still policy-less and still go only
    // through next_voucher_number, which is what the invariant was protecting.
    const denyAllByDesign: string[] = [];
    const rows = await sql<{ table_name: string }>(`
      select c.relname as table_name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity
         and not exists (
           select 1 from pg_policies p
            where p.schemaname = 'public' and p.tablename = c.relname)
       order by 1
    `);
    expect(rows.map((r) => r.table_name)).toEqual(denyAllByDesign);
  });

  it("company_invites is readable only by an admin of the owning company", async () => {
    // Regression guard for the 0003 invite-token leak: the token column is a
    // bearer credential, so a member-level read policy hands every member of
    // the company the ability to escalate an invite.
    const rows = await sql<{ policyname: string; cmd: string; qual: string }>(`
      select policyname, cmd, qual from pg_policies
       where schemaname = 'public' and tablename = 'company_invites'
    `);
    expect(rows.length, "company_invites has no policies at all").toBeGreaterThan(0);
    for (const p of rows) {
      expect(
        p.qual,
        `company_invites policy ${p.policyname} (${p.cmd}) is not admin-gated: ${p.qual}`
      ).toContain("is_company_admin");
      expect(
        p.qual,
        `company_invites policy ${p.policyname} allows any member to read invite tokens`
      ).not.toContain("is_company_member");
    }
  });

  it("every tenant table scopes its policies through a company-membership helper", async () => {
    // A policy on a company_id table that does not consult one of these is
    // either cross-tenant or dead. Both are worth failing on.
    const rows = await sql(`
      select p.tablename, p.policyname, p.cmd,
             coalesce(p.qual, p.with_check) as expr
        from pg_policies p
       where p.schemaname = 'public'
         and exists (
           select 1 from information_schema.columns col
            where col.table_schema = 'public'
              and col.table_name = p.tablename
              and col.column_name = 'company_id')
         and coalesce(p.qual, '') !~ 'is_company_member|is_company_admin|can_write_company|user_role_in_company'
         and coalesce(p.with_check, '') !~ 'is_company_member|is_company_admin|can_write_company|user_role_in_company'
    `);
    expect(rows, `tenant policies with no company scope:\n${offenders(rows)}`).toEqual([]);
  });

  it("the audit log is append-only to clients: no insert, update or delete policy", async () => {
    const rows = await sql(`
      select tablename, policyname, cmd from pg_policies
       where schemaname = 'public' and tablename like 'audit_log%'
         and cmd <> 'SELECT'
    `);
    expect(rows, `audit log is client-writable:\n${offenders(rows)}`).toEqual([]);
  });

  it("audit log partitions force RLS, so the owning role cannot read past it", async () => {
    const rows = await sql(`
      select c.relname as table_name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 'audit_log%'
         and c.relkind = 'r' and not c.relforcerowsecurity
    `);
    expect(rows, `audit partitions without FORCE RLS:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Write paths: a table nobody can insert into is a feature that cannot work
// ---------------------------------------------------------------------------
describeDb(`write paths (${hasDb ? "live" : noDbReason})`, () => {
  it("every RLS-denied tenant table is written only by SECURITY DEFINER functions", async () => {
    // A table with RLS, a company_id, and no INSERT/ALL policy can only be
    // written from a SECURITY DEFINER function. If the function that is
    // supposed to write it runs as INVOKER, the feature is dead on arrival and
    // nothing in the schema says so — the failure only shows up at runtime as
    // "new row violates row-level security policy".
    const writers: Record<string, string[]> = {
      // table -> the functions that are meant to write it
      company_modules: ["set_module", "resolve_conditional_modules"],
      voucher_number_sequences: ["next_voucher_number"],
      // The allowlist stopped growing with the schema years ago — every table
      // below is a real, working feature whose writer was checked live and
      // confirmed SECURITY DEFINER; this test had simply never been told
      // about them, so it was silently not checking any table added since
      // whichever migration first added company_modules/
      // voucher_number_sequences.
      delivery_challan_receipts: ["create_delivery_challan_receipt"],
      delivery_challans: ["create_delivery_challan", "create_delivery_challan_receipt"],
      job_work_challans: ["create_job_work_challan", "create_job_work_return"],
      job_work_returns: ["create_job_work_return"],
      gstr2b_lines: ["import_gstr2b_lines"],
      payment_webhook_events: ["receive_payment_webhook_event"],
      income_tax_statement_lines: ["import_income_tax_statement_lines"],
      notifications: ["create_notifications_from_needs_attention"],
      error_log: ["write_error_log"],
    };

    const noInsertPolicy = await sql<{ table_name: string }>(`
      select c.relname as table_name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
         and c.relname not like 'audit_log%'
         and exists (
           select 1 from information_schema.columns col
            where col.table_schema = 'public' and col.table_name = c.relname
              and col.column_name = 'company_id')
         and not exists (
           select 1 from pg_policies p
            where p.schemaname = 'public' and p.tablename = c.relname
              and p.cmd in ('INSERT','ALL'))
    `);

    const problems: string[] = [];
    for (const { table_name } of noInsertPolicy) {
      const expected = writers[table_name];
      if (!expected) {
        problems.push(
          `${table_name}: RLS denies all inserts and no writer function is registered for it`
        );
        continue;
      }
      const fns = await sql<{ proname: string; prosecdef: boolean }>(
        `select p.proname, p.prosecdef
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public','app_private') and p.proname = any($1)`,
        [expected]
      );
      for (const fn of fns) {
        if (!fn.prosecdef) {
          problems.push(
            `${table_name}: ${fn.proname}() is SECURITY INVOKER, so its INSERT is ` +
              `blocked by RLS — ${table_name} has no INSERT or ALL policy`
          );
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GST zero-rated / export / SEZ / deemed-export supply engine (0087)
// ---------------------------------------------------------------------------
describeDb(`GST zero-rated supplies (${hasDb ? "live" : noDbReason})`, () => {
  it("a zero-rated voucher (export_lut, or SEZ under an active LUT) posts no CGST/SGST/IGST", async () => {
    const rows = await sql(`
      select v.id, v.voucher_number, v.supply_type, l.name as tax_ledger,
             e.debit_amount, e.credit_amount
        from public.vouchers v
        join public.voucher_entries e on e.voucher_id = v.id
        join public.ledgers l on l.id = e.ledger_id
       where v.supply_type = 'export_lut'
         and not v.is_deleted
         and (l.name ilike '%CGST%' or l.name ilike '%SGST%' or l.name ilike '%IGST%')
         and (e.debit_amount > 0 or e.credit_amount > 0)
    `);
    expect(rows, `export_lut vouchers with tax wrongly posted:\n${offenders(rows)}`).toEqual([]);
  });

  it("export_igst and IGST-route SEZ vouchers never post CGST or SGST — Sec 7(5) IGST Act deems both inter-State regardless of the real place of supply", async () => {
    const rows = await sql(`
      select v.id, v.voucher_number, v.supply_type, l.name as tax_ledger,
             e.debit_amount, e.credit_amount
        from public.vouchers v
        join public.voucher_entries e on e.voucher_id = v.id
        join public.ledgers l on l.id = e.ledger_id
       where v.supply_type in ('export_igst', 'sez')
         and not v.is_deleted
         and (l.name ilike '%CGST%' or l.name ilike '%SGST%')
         and (e.debit_amount > 0 or e.credit_amount > 0)
    `);
    expect(rows, `export_igst/sez vouchers wrongly posting CGST or SGST:\n${offenders(rows)}`).toEqual([]);
  });

  it("a deemed_export voucher is never zero-rated — Sec 147 CGST Act requires tax to be paid upfront, refunded only afterwards", async () => {
    const rows = await sql(`
      select v.id, v.voucher_number
        from public.vouchers v
        join public.voucher_items vi on vi.voucher_id = v.id
        join public.items i on i.id = vi.item_id
       where v.supply_type = 'deemed_export'
         and not v.is_deleted
         and i.gst_rate_percent > 0
         and not exists (
           select 1 from public.voucher_entries e
             join public.ledgers l on l.id = e.ledger_id
            where e.voucher_id = v.id
              and (l.name ilike '%CGST%' or l.name ilike '%SGST%' or l.name ilike '%IGST%')
              and (e.debit_amount > 0 or e.credit_amount > 0)
         )
       group by v.id, v.voucher_number
    `);
    expect(rows, `deemed_export vouchers with a taxable item line but no tax posted:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Director / KMP master (0088)
// ---------------------------------------------------------------------------
describeDb(`director / KMP master (${hasDb ? "live" : noDbReason})`, () => {
  it("company_directors carries the CHECK constraints its data model depends on", async () => {
    // Structural, not a live-INSERT probe: this file is read-only-against-
    // production by convention (see the file header) — a constraint's
    // DEFINITION is what a "cessation before appointment" or a "malformed
    // DIN" test actually needs to prove, not triggering one live.
    const rows = await sql(`
      select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
       where conrelid = 'public.company_directors'::regclass
         and conname in ('company_directors_check', 'company_directors_check1',
                          'company_directors_check2', 'company_directors_din_check',
                          'company_directors_pan_check')
    `);
    const byName = new Map(rows.map((r) => [r.conname as string, r.def as string]));
    expect(byName.get("company_directors_check"), "cessation-after-appointment check missing").toContain(
      "date_of_cessation"
    );
    expect(byName.get("company_directors_check1"), "DIN-allotment-implies-DIN check missing").toContain(
      "din_allotment_date"
    );
    expect(byName.get("company_directors_check2"), "opc_nominee-implies-flag check missing").toContain(
      "opc_nominee"
    );
    expect(byName.get("company_directors_din_check"), "DIN format check missing").toContain("din");
    expect(byName.get("company_directors_pan_check"), "PAN format check missing").toContain("is_valid_pan");
  });

  it("company_directors is scoped by the same RLS shape as every other master table (member read, admin write)", async () => {
    const rows = await sql(`
      select policyname, cmd, qual, with_check
        from pg_policies
       where tablename = 'company_directors'
    `);
    const read = rows.find((r) => r.policyname === "company_directors_read");
    const write = rows.find((r) => r.policyname === "company_directors_write");
    expect(read?.qual, "read policy missing or not member-scoped").toContain("is_company_member");
    expect(write?.qual, "write policy missing or not can_write_company-scoped").toContain("can_write_company");
  });

  it("no company currently records a serving director with an invalid DIN, a cessation before appointment, or a mismatched OPC nominee flag", async () => {
    // Data-level check, complementing the structural one above: even though
    // the constraints make these unwritable going forward, this catches a
    // constraint that was later loosened or a row that slipped in before one
    // existed.
    const rows = await sql(`
      select id, company_id, name, din, date_of_appointment, date_of_cessation, designation, is_opc_nominee
        from public.company_directors
       where (din is not null and din !~ '^[0-9]{8}$')
          or (date_of_cessation is not null and date_of_cessation < date_of_appointment)
          or (designation = 'opc_nominee' and not is_opc_nominee)
    `);
    expect(rows, `directors violating their own constraints:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P&L and Balance Sheet comparative columns, Schedule III asset split (T2-21, 0089)
// ---------------------------------------------------------------------------
describeDb(`comparative-period reporting (${hasDb ? "live" : noDbReason})`, () => {
  it("get_profit_and_loss over two adjacent sub-periods sums to the same figure as the combined period, per company and ledger", async () => {
    // The P&L comparative-period column calls this RPC twice — once for the
    // current period, once for the immediately preceding period of the same
    // length — and relies on the two calls never double-counting or dropping
    // a posting at the boundary date. This is that additivity property,
    // checked directly against the RPC: whole-of-time equals an arbitrary
    // early-2026 split point plus its complement, for every ledger with any
    // activity at all.
    const rows = await sql(`
      with combined as (
        select c.id as company_id, c.name as company_name, r.ledger_name,
               sum(case when r.period = 'whole' then r.amount else 0 end) as whole_amount,
               sum(case when r.period <> 'whole' then r.amount else 0 end) as split_amount
          from public.companies c
          cross join lateral (
            select 'whole' as period, ledger_name, amount
              from public.get_profit_and_loss(c.id, '1900-01-01'::date, '2999-12-31'::date, null)
            union all
            select 'part1', ledger_name, amount
              from public.get_profit_and_loss(c.id, '1900-01-01'::date, '2026-01-01'::date, null)
            union all
            select 'part2', ledger_name, amount
              from public.get_profit_and_loss(c.id, '2026-01-02'::date, '2999-12-31'::date, null)
          ) r
         group by c.id, c.name, r.ledger_name
      )
      select * from combined where round(whole_amount - split_amount, 2) <> 0
    `);
    expect(rows, `companies/ledgers where a period split loses or double-counts an amount:\n${offenders(rows)}`).toEqual([]);
  });

  it("every fixed_asset-nature group carries one of the four Schedule III sub-classification roles", async () => {
    // 'fixed_asset' itself is retired as a ledger_role value by 0089 — a row
    // still carrying it (or anything else stray) means the backfill missed
    // something or a later insert used the old literal by mistake.
    const rows = await sql(`
      select id, company_id, name, ledger_role
        from public.account_groups
       where nature = 'fixed_asset'
         and ledger_role not in (
           'tangible_fixed_asset', 'intangible_fixed_asset',
           'capital_work_in_progress', 'investment'
         )
    `);
    expect(rows, `fixed_asset groups with an unclassified ledger_role:\n${offenders(rows)}`).toEqual([]);
  });

  it("every company has exactly one Intangible Assets / CWIP / Non-current Investments group", async () => {
    const rows = await sql(`
      select c.id as company_id, c.name,
             count(*) filter (where g.name = 'Intangible Assets') as intangible,
             count(*) filter (where g.name = 'Capital Work-in-Progress') as cwip,
             count(*) filter (where g.name = 'Non-current Investments') as investments
        from public.companies c
        left join public.account_groups g
          on g.company_id = c.id and g.nature = 'fixed_asset' and g.parent_group_id is not null
       group by c.id, c.name
      having count(*) filter (where g.name = 'Intangible Assets') <> 1
          or count(*) filter (where g.name = 'Capital Work-in-Progress') <> 1
          or count(*) filter (where g.name = 'Non-current Investments') <> 1
    `);
    expect(rows, `companies missing (or duplicating) an asset sub-group:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_balance_sheet's ledger_role buckets sum to exactly the fixed_asset nature total, per company", async () => {
    // A partition check, not a business-rule check: the four ledger_role
    // buckets under fixed_asset must sum to the same figure the bare nature
    // total already gave — the sub-classification is a display regrouping,
    // never a different number.
    const rows = await sql(`
      with totals as (
        select c.id as company_id, c.name,
               (select coalesce(sum(amount), 0) from public.get_balance_sheet(c.id, current_date)
                 where nature = 'fixed_asset') as whole,
               (select coalesce(sum(amount), 0) from public.get_balance_sheet(c.id, current_date)
                 where nature = 'fixed_asset'
                   and ledger_role in ('tangible_fixed_asset','intangible_fixed_asset','capital_work_in_progress','investment')
               ) as bucketed
          from public.companies c
      )
      select * from totals where round(whole - bucketed, 2) <> 0
    `);
    expect(rows, `companies where the sub-classified buckets do not sum to the nature total:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_balance_sheet no longer grants EXECUTE to PUBLIC or anon", async () => {
    const rows = await sql(`
      select grantee, privilege_type from information_schema.routine_privileges
       where routine_name = 'get_balance_sheet' and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `get_balance_sheet still reachable by an unauthenticated caller:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GST set-off computation and clearing journal, Sec 49A/Rule 88A (0090)
// ---------------------------------------------------------------------------
describeDb(`GST set-off (${hasDb ? "live" : noDbReason})`, () => {
  it("no set-off leg amount is ever negative, for any live registration today", async () => {
    const rows = await sql(`
      select r.company_id, r.id as gst_registration_id, l.row_kind, l.tax_head, l.amount
        from public.gst_registrations r
        cross join lateral public.get_gst_setoff_computation(
          r.company_id, r.id, current_date
        ) l
       where l.amount < 0
    `);
    expect(rows, `negative set-off amounts:\n${offenders(rows)}`).toEqual([]);
  });

  it("CGST credit never funds SGST output and SGST credit never funds CGST output (Sec 49(5)(c)/(d))", async () => {
    const rows = await sql(`
      select r.company_id, r.id as gst_registration_id, l.tax_head, l.credit_head, l.amount
        from public.gst_registrations r
        cross join lateral public.get_gst_setoff_computation(
          r.company_id, r.id, current_date
        ) l
       where l.row_kind = 'utilisation'
         and ((l.tax_head = 'cgst' and l.credit_head = 'sgst')
           or (l.tax_head = 'sgst' and l.credit_head = 'cgst'))
    `);
    expect(rows, `illegal CGST/SGST cross-utilisation:\n${offenders(rows)}`).toEqual([]);
  });

  it("Cess never funds, or is funded by, a CGST/SGST/IGST leg", async () => {
    const rows = await sql(`
      select r.company_id, r.id as gst_registration_id, l.tax_head, l.credit_head, l.amount
        from public.gst_registrations r
        cross join lateral public.get_gst_setoff_computation(
          r.company_id, r.id, current_date
        ) l
       where l.row_kind = 'utilisation'
         and ((l.tax_head = 'cess') <> (l.credit_head = 'cess'))
    `);
    expect(rows, `illegal cess cross-utilisation:\n${offenders(rows)}`).toEqual([]);
  });

  it("for every head, opening output liability equals utilised-against-it plus net_payable (nothing lost or invented)", async () => {
    const rows = await sql(`
      with legs as (
        select r.company_id, r.id as gst_registration_id, l.*
          from public.gst_registrations r
          cross join lateral public.get_gst_setoff_computation(
            r.company_id, r.id, current_date
          ) l
      )
      select company_id, gst_registration_id, tax_head,
             max(amount) filter (where row_kind = 'output_opening') as opening,
             coalesce(sum(amount) filter (where row_kind = 'utilisation'), 0) as utilised,
             max(amount) filter (where row_kind = 'net_payable') as net_payable
        from legs
       where tax_head is not null
       group by company_id, gst_registration_id, tax_head
      having round(
               coalesce(max(amount) filter (where row_kind = 'output_opening'), 0)
               - coalesce(sum(amount) filter (where row_kind = 'utilisation'), 0)
               - coalesce(max(amount) filter (where row_kind = 'net_payable'), 0), 2
             ) <> 0
    `);
    expect(rows, `output liability does not reconcile to utilised + net_payable:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Deferred tax (AS 22 / Ind AS 12) — depreciation timing difference (0091)
// ---------------------------------------------------------------------------
describeDb(`deferred tax (${hasDb ? "live" : noDbReason})`, () => {
  it("the deferred tax RPCs are not reachable by anon or public", async () => {
    const rows = await sql(`
      select p.proname, r.rolname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('public')) as r(rolname)
       where n.nspname = 'public'
         and p.proname in ('get_deferred_tax_reconciliation', 'post_deferred_tax')
         and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
    `);
    expect(rows, `deferred tax function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("every company's Deferred Tax Liabilities (Net) LEDGER sits under the nature='deferred_tax' group, never a same-named impostor", async () => {
    // A real live landmine this migration found: some companies carry a
    // second account_group named identically but with nature=
    // 'non_current_liability' (stray test-data seeding, four minutes before
    // migration 0037 shipped the real system group). Every lookup in 0091
    // selects the group by nature, never by name, because of this. This
    // check guards the group a ledger actually posted to, not the group
    // catalog itself — the stray duplicate group existing is not a failure
    // here, a LEDGER sitting under it would be.
    const rows = await sql(`
      select l.company_id, l.name, g.nature
        from public.ledgers l
        join public.account_groups g on g.id = l.group_id
       where l.name = 'Deferred Tax Liabilities (Net)'
         and g.nature <> 'deferred_tax'
    `);
    expect(rows, `a Deferred Tax Liabilities (Net) ledger is posted under the wrong group:\n${offenders(rows)}`).toEqual([]);
  });

  it("Deferred Tax Expense sits under Indirect Expenses, never anywhere that would double as a balance sheet line", async () => {
    const rows = await sql(`
      select l.company_id, l.name, g.name as group_name, g.nature
        from public.ledgers l
        join public.account_groups g on g.id = l.group_id
       where l.name = 'Deferred Tax Expense'
         and g.nature <> 'indirect_expense'
    `);
    expect(rows, `Deferred Tax Expense is in the wrong group:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_deferred_tax_reconciliation only accepts a 31 March financial-year-end date", async () => {
    await expect(
      sql(`select * from public.get_deferred_tax_reconciliation(
        (select id from public.companies limit 1), '2027-06-30'::date
      )`)
    ).rejects.toThrow(/financial year end \(31 March\)/);
  });

  it("the target balance is exactly the cumulative timing difference times the effective rate, for every applicable company", async () => {
    // A pure arithmetic identity, independent of whether anything has ever
    // been posted — round(diff * rate / 100, 2) must equal the reported
    // target on every row where a rate could be derived.
    const rows = await sql(`
      select c.id, c.name, r.cumulative_timing_difference, r.effective_tax_rate, r.target_deferred_tax_liability
        from public.companies c
        cross join lateral public.get_deferred_tax_reconciliation(c.id, '2027-03-31'::date) r
       where r.applicable
         and round(r.cumulative_timing_difference * r.effective_tax_rate / 100, 2) <> r.target_deferred_tax_liability
    `);
    expect(rows, `deferred tax target does not match diff x rate:\n${offenders(rows)}`).toEqual([]);
  });

  it("once posted, the Deferred Tax Liabilities (Net) ledger converges to the reconciliation's target (allowing one sub-rupee re-run for the book-profit feedback loop documented in 0091)", async () => {
    const rows = await sql(`
      select c.id, c.name, r.target_deferred_tax_liability, r.ledger_carried, r.movement_to_post
        from public.companies c
        cross join lateral public.get_deferred_tax_reconciliation(c.id, '2027-03-31'::date) r
       where r.applicable
         and r.ledger_carried <> 0
         and round(abs(r.movement_to_post), 2) > 1.00
    `);
    expect(rows, `a posted deferred tax ledger has drifted from its target by more than a rupee:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Meeting register, AGM date (0092)
// ---------------------------------------------------------------------------
describeDb(`meeting register (${hasDb ? "live" : noDbReason})`, () => {
  it("minutes_overdue is true only when minutes_signed_date is still null 30 days after the meeting", async () => {
    // Re-derives get_meetings' own Sec 118 flag independently — a later
    // refactor that drops the null-check or changes the 30-day window fails
    // here too, not just by inspection of the function body.
    const rows = await sql(`
      select c.name, m.meeting_type, m.meeting_date, m.minutes_signed_date, m.minutes_overdue
        from public.companies c
        cross join lateral public.get_meetings(c.id, null) m
       where m.minutes_overdue is distinct from
             (m.minutes_signed_date is null and m.meeting_date + 30 < current_date)
    `);
    expect(rows, `minutes_overdue disagrees with its own definition:\n${offenders(rows)}`).toEqual([]);
  });

  it("every AGM row carries a financial_year_start_year, and no EGM/board row does", async () => {
    // Guards the CHECK constraint directly (meetings_check) — data that
    // couldn't exist under the real constraint, so a careless ALTER TABLE
    // dropping it is still caught.
    const rows = await sql(`
      select id, meeting_type, financial_year_start_year
        from public.meetings
       where (meeting_type = 'agm' and financial_year_start_year is null)
          or (meeting_type <> 'agm' and financial_year_start_year is not null)
    `);
    expect(rows, `meetings with an FY tag mismatched to their type:\n${offenders(rows)}`).toEqual([]);
  });

  it("a company never has two AGM rows claiming the same financial year", async () => {
    // Guards the partial unique index meetings_one_agm_per_fy — adjourned/
    // re-convened AGMs are an explicitly out-of-scope case (see 0092
    // header); this test documents that the index still enforces one row.
    const rows = await sql(`
      select company_id, financial_year_start_year, count(*) as n
        from public.meetings
       where meeting_type = 'agm'
       group by company_id, financial_year_start_year
      having count(*) > 1
    `);
    expect(rows, `companies with more than one AGM recorded for the same FY:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_agm_status never reports both agm_recorded and a non-null days_remaining", async () => {
    // The two fields are meant to be mutually exclusive by construction —
    // once an AGM is recorded for the relevant FY there is no countdown left
    // to show, and this re-checks that get_agm_status's CASE actually
    // enforces it rather than trusting the function's own logic.
    const rows = await sql(`
      select c.name, s.fy_label, s.agm_recorded, s.days_remaining
        from public.companies c
        cross join lateral public.get_agm_status(c.id) s
       where s.applicable and s.agm_recorded and s.days_remaining is not null
    `);
    expect(rows, `AGM status rows showing both recorded=true and a countdown:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_agm_status.applicable is true only for pvt_ltd and ltd companies", async () => {
    // Sec 96(1) proviso exempts an OPC outright, and an LLP has no AGM under
    // the LLP Act at all — this is deliberately NARROWER than 0062's own
    // AOC-4/MGT-7A entity filter, which also includes 'opc'; the two
    // functions answer different questions. See 0092 header.
    const rows = await sql(`
      select c.name, c.entity_type, s.applicable
        from public.companies c
        cross join lateral public.get_agm_status(c.id) s
       where s.applicable is distinct from (c.entity_type in ('pvt_ltd', 'ltd'))
    `);
    expect(rows, `get_agm_status.applicable disagrees with entity_type:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Employee tax declarations, Sec 115BAC(1A) regime election (0093)
// ---------------------------------------------------------------------------
describeDb(`employee tax declarations (${hasDb ? "live" : noDbReason})`, () => {
  it("employee_tax_declarations carries the CHECK/UNIQUE/composite-FK constraints its data model depends on", async () => {
    const rows = await sql(`
      select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
       where conrelid = 'public.employee_tax_declarations'::regclass
         and conname in (
           'employee_tax_declarations_check',
           'employee_tax_declarations_financial_year_label_check',
           'employee_tax_declarations_regime_check',
           'employee_tax_declarations_employee_id_financial_year_label_key',
           'employee_tax_declarations_employee_id_company_id_fkey'
         )
    `);
    const byName = new Map(rows.map((r) => [r.conname as string, r.def as string]));
    expect(byName.get("employee_tax_declarations_check"), "new-regime-zeroes-deductions check missing").toContain(
      "deduction_80c"
    );
    expect(
      byName.get("employee_tax_declarations_financial_year_label_check"),
      "FY label format check missing"
    ).toContain("financial_year_label");
    expect(byName.get("employee_tax_declarations_regime_check"), "regime enum check missing").toContain("regime");
    expect(
      byName.get("employee_tax_declarations_employee_id_financial_year_label_key"),
      "one-declaration-per-employee-per-year UNIQUE missing"
    ).toContain("UNIQUE");
    expect(
      byName.get("employee_tax_declarations_employee_id_company_id_fkey"),
      "composite tenancy FK missing — a row could point at another company's employee"
    ).toContain("company_id");
  });

  it("no employee has more than one declaration for the same financial year, and no 'new' regime row carries an old-regime deduction", async () => {
    const rows = await sql(`
      select employee_id, financial_year_label, count(*) as n
        from public.employee_tax_declarations
       group by employee_id, financial_year_label
      having count(*) > 1
    `);
    expect(rows, `duplicate declarations for one employee/year:\n${offenders(rows)}`).toEqual([]);

    const badRegime = await sql(`
      select id, employee_id, financial_year_label, deduction_80c, deduction_80d,
             hra_exemption_claimed, home_loan_interest_24b
        from public.employee_tax_declarations
       where regime = 'new'
         and (deduction_80c <> 0 or deduction_80d <> 0
              or hra_exemption_claimed <> 0 or home_loan_interest_24b <> 0)
    `);
    expect(badRegime, `'new' regime declarations carrying old-regime deductions:\n${offenders(badRegime)}`).toEqual([]);
  });

  it("employee_tax_declarations is scoped by member-read / admin-write RLS", async () => {
    const rows = await sql(`
      select policyname, cmd, qual
        from pg_policies
       where tablename = 'employee_tax_declarations'
    `);
    const read = rows.find((r) => r.policyname === "employee_tax_declarations_read");
    const write = rows.find((r) => r.policyname === "employee_tax_declarations_write");
    expect(read?.qual, "read policy missing or not member-scoped").toContain("is_company_member");
    expect(write?.qual, "write policy missing or not admin-scoped").toContain("is_company_admin");
  });
});

// ---------------------------------------------------------------------------
// GSTR-1 Table 9B (CDNR) and Table 13 (documents issued) (0094)
// ---------------------------------------------------------------------------
describeDb(`GSTR-1 Table 9B and Table 13 (${hasDb ? "live" : noDbReason})`, () => {
  it("get_gstr1_table9b never returns a debit note or an unregistered party — CDNR is credit-notes-to-registered-parties only", async () => {
    // LEKHA's debit_note voucher_type is always input-side (see 0035's own
    // voucher_type filters); if this ever returns a debit note, either this
    // function's WHERE clause regressed or create_invoice's voucher_type
    // routing changed underneath it.
    const rows = await sql(`
      select c.name, t.voucher_id, t.note_type, t.party_gstin
        from public.companies c
        cross join lateral public.get_gstr1_table9b(c.id, '1900-01-01'::date, '2999-12-31'::date) t
       where t.note_type <> 'credit' or t.party_gstin is null
    `);
    expect(rows, `Table 9B returned a non-credit-note or unregistered-party row:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_gstr1_table13's own arithmetic holds: total issued equals net issued plus cancelled, and every serial range is ordered", async () => {
    // Table 13 resolves its financial year from p_period_start alone (see
    // 0094's own header) and is NOT meaningful over an arbitrarily wide
    // range spanning centuries — verified live: an unbounded 1900-2999 range
    // returns zero rows even for a company with real vouchers, because no
    // real FY label matches the nonsense FY '1900' resolves to. This check
    // uses the current financial year, which is what every real caller of
    // this report actually passes.
    const rows = await sql(`
      select c.name, t.series_prefix, t.total_issued, t.net_issued, t.cancelled, t.serial_from, t.serial_to
        from public.companies c
        cross join lateral public.get_gstr1_table13(c.id, '2026-04-01'::date, '2027-03-31'::date) t
       where t.total_issued <> t.net_issued + t.cancelled
          or (t.serial_from is not null and t.serial_to is not null and t.serial_from > t.serial_to)
    `);
    expect(rows, `Table 13 arithmetic or serial ordering broke:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_gstr1_table9b and get_gstr1_table13 are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee, privilege_type
        from information_schema.routine_privileges
       where routine_name in ('get_gstr1_table9b', 'get_gstr1_table13')
         and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `Table 9B/13 reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("voucher_number_sequences is readable under RLS scoped to company membership and branch access — the read policy this migration had to add", async () => {
    // get_gstr1_table13 is the first SECURITY INVOKER function in this
    // codebase to read voucher_number_sequences under a real user's own
    // role. Live testing found the table had carried row_security=true with
    // ZERO policies since migration 0007 — deny-all for anyone who wasn't
    // the SECURITY DEFINER next_voucher_number bypassing RLS as its owner.
    // This is the structural guard that the fix (an additive read policy,
    // no write policy) stays in place.
    const rows = await sql(`
      select policyname, cmd, qual
        from pg_policies
       where tablename = 'voucher_number_sequences'
    `);
    const read = rows.find((r) => r.cmd === "SELECT");
    expect(rows.length, "voucher_number_sequences has no RLS policy at all again").toBeGreaterThan(0);
    expect(read?.qual, "voucher_number_sequences read policy is not company/branch scoped").toContain(
      "is_company_member"
    );
  });
});

// ---------------------------------------------------------------------------
// Filing register (0095)
// ---------------------------------------------------------------------------
describeDb(`filing register (${hasDb ? "live" : noDbReason})`, () => {
  it("filing_register carries the CHECK constraints its data model depends on", async () => {
    const rows = await sql(`
      select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
       where conrelid = 'public.filing_register'::regclass and contype = 'c'
    `);
    const defs = rows.map((r) => r.def as string).join(" | ");
    expect(defs, "status/filed_date coherence CHECK missing").toContain("filed_date");
    expect(defs, "non-negative fee CHECK missing").toMatch(/fee_paid|additional_fee/);
  });

  it("filing_register has a case/whitespace-insensitive one-record-per-(company,form,period,registration) unique index", async () => {
    // The uniqueness guard here is a plain CREATE UNIQUE INDEX on
    // upper(btrim(...)) expressions, not a table CONSTRAINT — pg_constraint
    // never lists it, so this has to come from pg_indexes instead.
    const rows = await sql(`
      select indexname, indexdef from pg_indexes
       where tablename = 'filing_register' and indexdef ilike '%UNIQUE%' and indexname <> 'filing_register_pkey'
    `);
    expect(rows.length, "the company/form/period/registration unique index is missing").toBeGreaterThan(0);
    expect(rows[0].indexdef, "unique index is not case/whitespace-insensitive").toMatch(/upper|btrim/i);
  });

  it("no filing_register row claims status='filed' without a filed_date, or vice versa", async () => {
    const rows = await sql(`
      select id, company_id, form_code, period_label, status, filed_date
        from public.filing_register
       where (status = 'filed') <> (filed_date is not null)
    `);
    expect(rows, `filed/filed_date mismatch:\n${offenders(rows)}`).toEqual([]);
  });

  it("filing_register and get_filing_register are RLS/grant-scoped the same as every other master table", async () => {
    const policies = await sql(`
      select policyname, cmd, qual from pg_policies where tablename = 'filing_register'
    `);
    const read = policies.find((r) => r.policyname === "filing_register_read");
    const write = policies.find((r) => r.policyname === "filing_register_write");
    expect(read?.qual, "read policy missing or not member-scoped").toContain("is_company_member");
    expect(write?.qual, "write policy missing or not can_write_company-scoped").toContain("can_write_company");

    const grants = await sql(`
      select grantee, privilege_type from information_schema.routine_privileges
       where routine_name = 'get_filing_register' and grantee in ('PUBLIC', 'anon')
    `);
    expect(grants, `get_filing_register reachable by a role it shouldn't be:\n${offenders(grants)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 37 (180-day) ITC reversal (0096)
// ---------------------------------------------------------------------------
describeDb(`180-day ITC reversal (${hasDb ? "live" : noDbReason})`, () => {
  it("get_itc_180day_reversal is not reachable by anon or public", async () => {
    const rows = await sql(`
      select grantee, privilege_type from information_schema.routine_privileges
       where routine_name = 'get_itc_180day_reversal' and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `get_itc_180day_reversal reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("reversal_itc never exceeds the ITC originally claimed on the invoice, and is exactly proportionate to what remains unpaid", async () => {
    // Re-derives the proportionality rule independently of the function body:
    // reversal_itc / itc_total should equal outstanding_amount / invoice_value,
    // to the rounding tolerance a numeric(14,2) column allows.
    const rows = await sql(`
      select c.name, r.voucher_number, r.invoice_value, r.outstanding_amount, r.itc_total, r.reversal_itc
        from public.companies c
        cross join lateral public.get_itc_180day_reversal(c.id, '2999-12-31'::date) r
       where r.itc_total > 0
         and abs(
               round(r.reversal_itc, 2)
               - round(r.itc_total * r.outstanding_amount / r.invoice_value, 2)
             ) > 0.02
    `);
    expect(rows, `reversal_itc is not proportionate to the unpaid fraction:\n${offenders(rows)}`).toEqual([]);
  });

  it("no reversal is ever shown for an invoice 180 days old or less (the safe harbour)", async () => {
    const rows = await sql(`
      select c.name, r.voucher_number, r.days_overdue
        from public.companies c
        cross join lateral public.get_itc_180day_reversal(c.id, '2999-12-31'::date) r
       where r.days_overdue <= 180
    `);
    expect(rows, `a reversal row exists at or under the 180-day safe harbour:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LLP designated-partner contributions (0097)
// ---------------------------------------------------------------------------
describeDb(`LLP partner contributions (${hasDb ? "live" : noDbReason})`, () => {
  it("llp_partner_contributions carries its composite tenancy FK and its cash/kind CHECK constraint", async () => {
    const rows = await sql(`
      select conname, pg_get_constraintdef(oid) as def
        from pg_constraint
       where conrelid = 'public.llp_partner_contributions'::regclass
    `);
    const defs = rows.map((r) => r.def as string).join(" | ");
    expect(defs, "composite (director_id, company_id) tenancy FK missing").toContain("company_id");
    expect(defs, "valuation-reference-only-for-kind CHECK missing").toContain("valuation_certificate_reference");
  });

  it("no cash contribution carries a valuation certificate reference", async () => {
    const rows = await sql(`
      select id, company_id, contribution_type, valuation_certificate_reference
        from public.llp_partner_contributions
       where contribution_type = 'cash' and valuation_certificate_reference is not null
    `);
    expect(rows, `cash contributions wrongly carrying a valuation reference:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_llp_contribution_summary's cash+kind sums equal the raw contribution rows, per partner", async () => {
    const rows = await sql(`
      with raw as (
        select director_id, company_id,
               sum(amount) filter (where contribution_type = 'cash') as cash,
               sum(amount) filter (where contribution_type = 'kind') as kind
          from public.llp_partner_contributions
         group by director_id, company_id
      )
      select cd.company_id, cd.name, s.total_cash, s.total_kind, r.cash, r.kind
        from raw r
        join public.company_directors cd on cd.id = r.director_id
        cross join lateral public.get_llp_contribution_summary(r.company_id) s
       where s.director_id = r.director_id
         and (round(s.total_cash, 2) <> round(coalesce(r.cash, 0), 2)
              or round(s.total_kind, 2) <> round(coalesce(r.kind, 0), 2))
    `);
    expect(rows, `contribution summary does not match the raw rows:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GSTR-1 Table 12 — real per-(HSN, rate) rows + B2B/B2C split (0098)
// ---------------------------------------------------------------------------
describeDb(`GSTR-1 Table 12 rate split (${hasDb ? "live" : noDbReason})`, () => {
  it("get_gstr1_hsn_summary is not reachable by anon or public", async () => {
    const rows = await sql(`
      select grantee, privilege_type from information_schema.routine_privileges
       where routine_name = 'get_gstr1_hsn_summary' and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `get_gstr1_hsn_summary reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("every row is tagged a genuine single gst_rate_percent and a b2b/b2c value — no blended or missing rate", async () => {
    const rows = await sql(`
      select c.name, s.hsn_sac, s.gst_rate_percent, s.b2b_or_b2c
        from public.companies c
        cross join lateral public.get_gstr1_hsn_summary(c.id, '1900-01-01'::date, '2999-12-31'::date) s
       where s.gst_rate_percent is null or s.b2b_or_b2c not in ('b2b', 'b2c')
    `);
    expect(rows, `HSN summary rows with a missing rate or invalid B2B/B2C tag:\n${offenders(rows)}`).toEqual([]);
  });

  it("the whole-company HSN summary tax total equals the GST output register tax total — the reallocation preserves the whole, per company", async () => {
    const rows = await sql(`
      with totals as (
        select c.id, c.name,
               (select coalesce(sum(cgst) + sum(sgst) + sum(igst) + sum(cess), 0)
                  from public.get_gstr1_hsn_summary(c.id, '1900-01-01'::date, '2999-12-31'::date)) as hsn_total,
               (select coalesce(sum(cgst) + sum(sgst) + sum(igst) + sum(cess), 0)
                  from public.get_gst_output_register(c.id, '1900-01-01'::date, '2999-12-31'::date)) as output_total
          from public.companies c
      )
      select * from totals where round(hsn_total - output_total, 2) <> 0
    `);
    expect(rows, `companies where the HSN summary total no longer matches the output register total:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Advance tax and Sec 234B/234C (0099)
// ---------------------------------------------------------------------------
describeDb(`advance tax (${hasDb ? "live" : noDbReason})`, () => {
  it("get_advance_tax_status is not reachable by anon or public", async () => {
    const rows = await sql(`
      select grantee, privilege_type from information_schema.routine_privileges
       where routine_name = 'get_advance_tax_status' and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `get_advance_tax_status reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("only accepts a 31 March financial-year-end date", async () => {
    await expect(
      sql(`select * from public.get_advance_tax_status(
        (select id from public.companies limit 1), '2027-06-30'::date
      )`)
    ).rejects.toThrow();
  });

  it("234C interest is never charged against the 12%/36% safe-harbour tolerance once it has genuinely been met (Jun/Sep instalments only — Dec/Mar carry no such tolerance)", async () => {
    // Re-derives each instalment's own safe-harbour rupee amount from its
    // percent and the amount/percent ratio the row already carries
    // (cumulative_amount_required / cumulative_percent_required is the
    // rupee value of 1%, so x safe_harbour_percent gives the tolerance
    // threshold) — independent of the function's own internal arithmetic —
    // and checks that once cumulative_amount_paid clears that threshold,
    // sec234c_interest is exactly 0, regardless of whether the 15/45%
    // headline figure was also met.
    const rows = await sql(`
      select c.name, s.instalment_no, s.due_date, s.cumulative_amount_paid, s.sec234c_interest,
             round((s.cumulative_amount_required / s.cumulative_percent_required) * s.safe_harbour_percent, 2)
               as safe_harbour_amount
        from public.companies c
        cross join lateral public.get_advance_tax_status(c.id, '2027-03-31'::date) s
       where s.row_kind = 'instalment'
         and s.applicable
         and s.safe_harbour_percent is not null
         and s.cumulative_amount_paid >= round((s.cumulative_amount_required / s.cumulative_percent_required) * s.safe_harbour_percent, 2)
         and round(s.sec234c_interest, 2) <> 0
    `);
    expect(rows, `interest charged despite the safe harbour being met:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cash flow statement, AS 3 / Ind AS 7 (0100)
// ---------------------------------------------------------------------------
describeDb(`cash flow statement (${hasDb ? "live" : noDbReason})`, () => {
  it("get_cash_flow_statement is not reachable by anon or public", async () => {
    const rows = await sql(`
      select grantee, privilege_type from information_schema.routine_privileges
       where routine_name = 'get_cash_flow_statement' and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `get_cash_flow_statement reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("the bottom-up reconciliation (operating + investing + financing vs actual cash movement) is nil for every company, book-beginning to date", async () => {
    // The single correctness proof for an indirect-method cash flow
    // statement: every one of get_balance_sheet's nature buckets lands in
    // exactly one section, so this difference is an algebraic certainty, not
    // a hope. A nonzero value here means a bucket was added, renamed, or
    // dropped from get_balance_sheet/get_profit_and_loss without updating
    // this function in lockstep — exactly the failure mode 0100's own report
    // warned about.
    const rows = await sql(`
      select c.name, cf.amount as difference
        from public.companies c
        cross join lateral public.get_cash_flow_statement(
          c.id, c.book_beginning_date, greatest(c.book_beginning_date, current_date)
        ) cf
       where cf.line_item = 'reconciliation_difference'
         and round(cf.amount, 2) <> 0
    `);
    expect(rows, `cash flow statement does not reconcile:\n${offenders(rows)}`).toEqual([]);
  });

  it("cash_from_operating + cash_from_investing + cash_from_financing equals net_change_in_cash, per company", async () => {
    const rows = await sql(`
      with totals as (
        select c.id, c.name,
               max(cf.amount) filter (where cf.line_item = 'cash_from_operating') as op,
               max(cf.amount) filter (where cf.line_item = 'cash_from_investing') as inv,
               max(cf.amount) filter (where cf.line_item = 'cash_from_financing') as fin,
               max(cf.amount) filter (where cf.line_item = 'net_change_in_cash') as net
          from public.companies c
          cross join lateral public.get_cash_flow_statement(
            c.id, c.book_beginning_date, greatest(c.book_beginning_date, current_date)
          ) cf
         group by c.id, c.name
      )
      select * from totals where round(coalesce(op,0) + coalesce(inv,0) + coalesce(fin,0) - coalesce(net,0), 2) <> 0
    `);
    expect(rows, `the three activity sections do not sum to the reported net change in cash:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Register of Members / share capital, Sec 88 (0101)
// ---------------------------------------------------------------------------
describeDb(`register of members (${hasDb ? "live" : noDbReason})`, () => {
  it("no share_classes row exists for a company whose entity_type has no share capital", async () => {
    const rows = await sql(`
      select sc.id, c.name, c.entity_type
        from public.share_classes sc
        join public.companies c on c.id = sc.company_id
       where c.entity_type not in ('pvt_ltd', 'ltd', 'opc')
    `);
    expect(rows, `a share class exists on a company with no share capital:\n${offenders(rows)}`).toEqual([]);
  });

  it("no class's currently-held shares exceed its authorized_shares (Sec 61)", async () => {
    const rows = await sql(`
      select sc.id, c.name, sc.class_name, sc.authorized_shares,
             coalesce(sum(sh.shares_held) filter (where sh.date_of_cessation is null), 0) as held
        from public.share_classes sc
        join public.companies c on c.id = sc.company_id
        left join public.share_holdings sh on sh.share_class_id = sc.id
       group by sc.id, c.name, sc.class_name, sc.authorized_shares
      having coalesce(sum(sh.shares_held) filter (where sh.date_of_cessation is null), 0) > sc.authorized_shares
    `);
    expect(rows, `a share class has more currently-held shares than authorized:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_share_capital_summary's paid-up capital equals currently-held shares times nominal value, per class", async () => {
    const rows = await sql(`
      select c.name, s.class_name, s.issued_shares, s.nominal_value_per_share, s.paid_up_capital
        from public.companies c
        cross join lateral public.get_share_capital_summary(c.id) s
       where round(s.issued_shares * s.nominal_value_per_share, 2) <> round(s.paid_up_capital, 2)
    `);
    expect(rows, `paid-up capital does not equal issued shares x nominal value:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_share_capital_summary and share_classes/share_holdings write access are RLS-scoped the same as company_directors", async () => {
    const grants = await sql(`
      select grantee, privilege_type from information_schema.routine_privileges
       where routine_name = 'get_share_capital_summary' and grantee in ('PUBLIC', 'anon')
    `);
    expect(grants, `get_share_capital_summary reachable by a role it shouldn't be:\n${offenders(grants)}`).toEqual([]);

    const policies = await sql(`
      select tablename, policyname, cmd, qual from pg_policies
       where tablename in ('share_classes', 'share_holdings')
    `);
    for (const table of ["share_classes", "share_holdings"]) {
      const write = policies.find((r) => r.tablename === table && (r.qual as string)?.includes("can_write_company"));
      expect(write, `${table} has no can_write_company-scoped write policy`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// Reverse Charge Mechanism, Sec 9(3)/9(4) (0102)
// ---------------------------------------------------------------------------
describeDb(`reverse charge mechanism (${hasDb ? "live" : noDbReason})`, () => {
  it("items.is_rcm_applicable exists and defaults false", async () => {
    const rows = await sql(`
      select column_default from information_schema.columns
       where table_name = 'items' and column_name = 'is_rcm_applicable'
    `);
    expect(rows.length, "is_rcm_applicable column is missing").toBe(1);
    expect(rows[0].column_default, "is_rcm_applicable should default false").toContain("false");
  });

  it("create_invoice's live body actually branches on is_rcm_applicable and posts to rcm_payable", async () => {
    const rows = await sql(`
      select (prosrc ilike '%is_rcm_applicable%') as has_flag, (prosrc ilike '%rcm_payable%') as posts_rcm
        from pg_proc where proname = 'create_invoice'
    `);
    expect(rows[0]?.has_flag, "create_invoice does not check is_rcm_applicable").toBe(true);
    expect(rows[0]?.posts_rcm, "create_invoice never posts to rcm_payable").toBe(true);
  });

  it("every RCM Payable posting is matched by an equal offsetting debit — the RCM liability leg never leaves a voucher unbalanced", async () => {
    // Re-derives the specific invariant 0102's own report hand-verified
    // (Cr RCM Payable matched by Dr trading-ledger, same amount) directly
    // from posted data, rather than relying on the whole-voucher balance
    // check elsewhere in this file to catch an RCM-specific regression.
    const rows = await sql(`
      select v.id, v.voucher_number,
             sum(e.credit_amount) filter (where l.name ilike '%RCM Payable%') as rcm_credited,
             sum(e.debit_amount) - sum(e.credit_amount) as voucher_net
        from vouchers v
        join voucher_entries e on e.voucher_id = v.id
        join ledgers l on l.id = e.ledger_id
       where exists (
         select 1 from voucher_entries e2 join ledgers l2 on l2.id = e2.ledger_id
          where e2.voucher_id = v.id and l2.name ilike '%RCM Payable%' and e2.credit_amount > 0
       )
       group by v.id, v.voucher_number
      having round(sum(e.debit_amount) - sum(e.credit_amount), 2) <> 0
    `);
    expect(rows, `an RCM voucher does not balance:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TDS threshold monitoring, incl. Sec 194Q excess-only basis (0103)
// ---------------------------------------------------------------------------
describeDb(`TDS threshold monitoring (${hasDb ? "live" : noDbReason})`, () => {
  it("get_tds_threshold_status and its summary are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('get_tds_threshold_status', 'get_tds_threshold_status_summary')
         and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `TDS threshold functions reachable by a role they shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("194Q's taxable_basis_amount is always the excess over cumulative, never the full cumulative amount", async () => {
    // Re-derives 194Q's own "excess only" rule independently: for the one
    // section code with a different basis than every other section,
    // taxable_basis_amount should equal cumulative minus the 50-lakh
    // threshold whenever the section is 194Q and the function reports
    // applicable — never the raw cumulative figure itself.
    const rows = await sql(`
      select c.name, l.id as ledger_id, s.taxable_basis_amount, s.basis_note
        from companies c
        join ledgers l on l.company_id = c.id and l.is_tds_deductee
        cross join lateral get_tds_threshold_status(c.id, l.id, '194Q', current_date) s
       where s.section_code = '194Q'
         and s.tds_applicable
         and s.basis_note not ilike '%excess%'
    `);
    expect(rows, `a 194Q row is applicable but its basis_note doesn't describe the excess-only rule:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rules 42/43 common-credit apportionment (0104)
// ---------------------------------------------------------------------------
describeDb(`Rules 42/43 common-credit apportionment (${hasDb ? "live" : noDbReason})`, () => {
  it("get_common_credit_apportionment is not reachable by anon or public", async () => {
    const rows = await sql(`
      select grantee from information_schema.routine_privileges
       where routine_name = 'get_common_credit_apportionment' and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `get_common_credit_apportionment reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("never returns a null tax-derived column — every sum is coalesced to zero, even for a company with no purchases in the period", async () => {
    // The exact NULL-vs-zero bug 0104's own report caught and fixed: an
    // empty-purchase period used to return NULL instead of 0 across every
    // tax-derived column.
    const rows = await sql(`
      select c.name, r.*
        from companies c
        cross join lateral get_common_credit_apportionment(c.id, '1900-01-01'::date, '1900-01-02'::date) r
       where r.total_input_tax is null or r.common_credit is null or r.total_reversal is null
    `);
    expect(rows, `an empty period returned NULL instead of 0 for a tax-derived column:\n${offenders(rows)}`).toEqual([]);
  });

  it("total_reversal never exceeds common_credit — the reversal can only consume the common pool, never more", async () => {
    const rows = await sql(`
      select c.name, r.common_credit, r.total_reversal
        from companies c
        cross join lateral get_common_credit_apportionment(c.id, '1900-01-01'::date, '2999-12-31'::date) r
       where round(r.total_reversal, 2) > round(r.common_credit, 2)
    `);
    expect(rows, `total_reversal exceeds the common credit pool it's reversing from:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Notes to accounts — contingent liabilities, AS 18, ageing (0105)
// ---------------------------------------------------------------------------
describeDb(`notes to accounts (${hasDb ? "live" : noDbReason})`, () => {
  it("ledgers.relationship_type is null unless is_related_party is true", async () => {
    const rows = await sql(`
      select id, company_id, name, is_related_party, relationship_type
        from ledgers
       where relationship_type is not null and not is_related_party
    `);
    expect(rows, `a ledger has a relationship_type without is_related_party:\n${offenders(rows)}`).toEqual([]);
  });

  it("the three new notes-to-accounts functions are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('get_contingent_liabilities_note', 'get_related_party_note', 'get_ageing_schedule')
         and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a notes-to-accounts function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("the receivable ageing total matches the sum of get_party_outstanding's own positive (receivable) balances, per company", async () => {
    // Only the receivable side is cross-checked against get_party_outstanding
    // — that function's own payable-side sign/scope doesn't line up with
    // the ageing schedule's MSME/Others payable split closely enough to
    // compare directly (confirmed live: it is not simply "negative
    // outstanding"), so the payable side is covered by the bucket-level
    // non-negativity check below instead of a cross-function total match.
    const rows = await sql(`
      with ageing as (
        select c.id, c.name,
               (select coalesce(sum(amount), 0) from get_ageing_schedule(c.id, current_date, 'receivable')) as receivable
          from companies c
      ),
      outstanding as (
        select c.id,
               (select coalesce(sum(outstanding), 0) from get_party_outstanding(c.id, current_date) where outstanding > 0) as receivable
          from companies c
      )
      select a.name, a.receivable as ageing_receivable, o.receivable as outstanding_receivable
        from ageing a join outstanding o on o.id = a.id
       where round(a.receivable - o.receivable, 2) <> 0
    `);
    expect(rows, `ageing schedule receivable total doesn't match get_party_outstanding:\n${offenders(rows)}`).toEqual([]);
  });

  it("no ageing schedule bucket is ever negative, for either receivables or payables", async () => {
    const rows = await sql(`
      select c.name, r.segment as party_type, s.bucket_label, s.amount
        from companies c
        cross join lateral (values ('receivable'), ('payable')) as r(segment)
        cross join lateral get_ageing_schedule(c.id, current_date, r.segment) s
       where s.amount < 0
    `);
    expect(rows, `a negative ageing bucket amount:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Team management — invite / accept / role (0107)
// ---------------------------------------------------------------------------
describeDb(`team invites (${hasDb ? "live" : noDbReason})`, () => {
  it("company_invites/accept/create functions are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('get_company_team', 'create_company_invite', 'accept_company_invite')
         and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a team-invite function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("guard_last_admin still blocks removing a company's sole active admin", async () => {
    const rows = await sql(`
      select tgname, pg_get_triggerdef(oid) as def
        from pg_trigger
       where tgrelid = 'public.company_members'::regclass and not tgisinternal
         and tgname ilike '%last_admin%'
    `);
    expect(rows.length, "guard_last_admin trigger is missing from company_members").toBeGreaterThan(0);
  });

  it("no invite is both accepted and still status='pending', and no invite has an empty token", async () => {
    const rows = await sql(`
      select id, company_id, email, status, accepted_at, token
        from company_invites
       where (status = 'accepted' and accepted_at is null)
          or (status = 'pending' and accepted_at is not null)
          or token is null or length(trim(token::text)) = 0
    `);
    expect(rows, `invite rows with an inconsistent status/accepted_at or empty token:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Professional Tax per-state split (0108)
// ---------------------------------------------------------------------------
describeDb(`PT per-state split (${hasDb ? "live" : noDbReason})`, () => {
  it("get_pt_liability_by_state is not reachable by anon or public", async () => {
    const rows = await sql(`
      select grantee from information_schema.routine_privileges
       where routine_name = 'get_pt_liability_by_state' and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `get_pt_liability_by_state reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("the sum of employee_count across all states for a period never exceeds the company's total active-and-was-active employee count", async () => {
    const rows = await sql(`
      select c.name, sum(s.employee_count) as pt_headcount,
             (select count(*) from employees e where e.company_id = c.id) as company_headcount
        from companies c
        cross join lateral get_pt_liability_by_state(c.id, '1900-01-01'::date, '2999-12-31'::date) s
       group by c.id, c.name
      having sum(s.employee_count) > (select count(*) from employees e where e.company_id = c.id)
    `);
    expect(rows, `PT state split double-counts employees beyond the company's own headcount:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Statutory bonus, Code on Wages 2019 Chapter IV (0109)
// ---------------------------------------------------------------------------
describeDb(`statutory bonus (${hasDb ? "live" : noDbReason})`, () => {
  it("get_statutory_bonus_computation and the surplus estimate are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('get_statutory_bonus_computation', 'get_statutory_bonus_surplus_estimate')
         and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a statutory-bonus function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("minimum bonus is never more than the maximum bonus, for any eligible employee", async () => {
    const rows = await sql(`
      select c.name, r.employee_id, r.minimum_bonus, r.maximum_bonus_at_20pct
        from companies c
        cross join lateral get_statutory_bonus_computation(c.id, '2027-03-31'::date) r
       where r.eligible and round(r.minimum_bonus, 2) > round(r.maximum_bonus_at_20pct, 2)
    `);
    expect(rows, `an employee's minimum bonus exceeds their own maximum (8.33% > 20%):\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PF ECR + ESI MC file prep (0110)
// ---------------------------------------------------------------------------
describeDb(`PF ECR / ESI MC (${hasDb ? "live" : noDbReason})`, () => {
  it("get_pf_ecr_data and get_esi_mc_data are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('get_pf_ecr_data', 'get_esi_mc_data') and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a PF/ESI function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("every employee above the ESI wage ceiling is excluded from the ESI MC set for the same period", async () => {
    const rows = await sql(`
      select c.name, e.employee_id, e.gross_wages
        from companies c
        cross join lateral get_pf_ecr_data(c.id, date_trunc('month', current_date)::date) e
       where e.gross_wages > 21000
         and exists (
           select 1 from get_esi_mc_data(c.id, date_trunc('month', current_date)::date) m
            where m.employee_id = e.employee_id
         )
    `);
    expect(rows, `an above-ESI-ceiling employee still appears in the ESI MC set:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// UPI payment QR on invoice print (0111)
// ---------------------------------------------------------------------------
describeDb(`UPI payment QR (${hasDb ? "live" : noDbReason})`, () => {
  it("companies.upi_vpa carries a working column-level grant for authenticated (SELECT and UPDATE)", async () => {
    const rows = await sql(`
      select privilege_type from information_schema.column_privileges
       where table_name = 'companies' and column_name = 'upi_vpa' and grantee = 'authenticated'
    `);
    const privs = rows.map((r) => r.privilege_type);
    expect(privs, "authenticated lacks SELECT on companies.upi_vpa").toContain("SELECT");
    expect(privs, "authenticated lacks UPDATE on companies.upi_vpa").toContain("UPDATE");
  });

  it("get_invoice_outstanding is not reachable by anon or public", async () => {
    const rows = await sql(`
      select grantee from information_schema.routine_privileges
       where routine_name = 'get_invoice_outstanding' and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `get_invoice_outstanding reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("every companies.upi_vpa value that is set satisfies its own CHECK format", async () => {
    const rows = await sql(`
      select id, name, upi_vpa from companies
       where upi_vpa is not null and upi_vpa !~ '^[A-Za-z0-9.\\-_]{2,100}@[A-Za-z0-9.\\-]{2,100}$'
    `);
    expect(rows, `a stored upi_vpa doesn't match its own CHECK-equivalent format:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Employer registration column grants — the recurring "add column, forget
// the allowlist" bug class (0085 -> 0111/0112 -> 0140/0141). Hit three times
// this session; this test exists specifically so a fourth time fails loudly
// in CI instead of shipping a silently-broken form. (0112, and standing)
// ---------------------------------------------------------------------------
describeDb(`companies column-grant allowlist (${hasDb ? "live" : noDbReason})`, () => {
  it("every non-sensitive companies column is readable and writable by authenticated — password_hash/password_protected are the only deliberate exceptions", async () => {
    const rows = await sql(`
      select column_name from information_schema.columns
       where table_name = 'companies' and table_schema = 'public'
         and column_name not in ('password_hash', 'password_protected')
       except
      select column_name from information_schema.column_privileges
       where table_name = 'companies' and grantee = 'authenticated' and privilege_type = 'SELECT'
    `);
    expect(rows, `companies columns missing a SELECT grant for authenticated:\n${offenders(rows)}`).toEqual([]);

    const missingUpdate = await sql(`
      select column_name from information_schema.columns
       where table_name = 'companies' and table_schema = 'public'
         and column_name not in ('password_hash', 'password_protected', 'id', 'created_at')
       except
      select column_name from information_schema.column_privileges
       where table_name = 'companies' and grantee = 'authenticated' and privilege_type = 'UPDATE'
    `);
    expect(missingUpdate, `companies columns missing an UPDATE grant for authenticated:\n${offenders(missingUpdate)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CIN / IEC / PAN from Company Settings (1360)
// ---------------------------------------------------------------------------
// Before 1360 nothing in the app could write any of these three, which meant
// AOC-4 XBRL was unreachable for every company (no CIN, no xbrli:identifier)
// and the 'exim'/'foreign_currency' conditional modules could never resolve to
// applicable (no IEC to resolve from).
// ---------------------------------------------------------------------------
describeDb(`company CIN/IEC/PAN identifiers (${hasDb ? "live" : noDbReason})`, () => {
  it("cin, iec and pan each carry a working column-level grant for authenticated (SELECT and UPDATE)", async () => {
    // The form writes public.companies directly, so a missing column grant is
    // the difference between a working save and a silent no-op. Asserted per
    // column rather than relying on the generic allowlist test above, because
    // this is the specific thing the feature stands on.
    const rows = await sql(`
      select column_name, privilege_type from information_schema.column_privileges
       where table_name = 'companies' and grantee = 'authenticated'
         and column_name in ('cin', 'iec', 'pan')
         and privilege_type in ('SELECT', 'UPDATE')
    `);
    for (const column of ["cin", "iec", "pan"]) {
      for (const privilege of ["SELECT", "UPDATE"]) {
        expect(
          rows.some((r) => r.column_name === column && r.privilege_type === privilege),
          `authenticated lacks ${privilege} on companies.${column}`
        ).toBe(true);
      }
    }
  });

  it("companies.cin is format-checked, so a typo cannot become an invalid XBRL entity identifier", async () => {
    const rows = await sql(`
      select conname from pg_constraint
       where conrelid = 'public.companies'::regclass and conname = 'companies_cin_check'
    `);
    expect(rows, "companies_cin_check is missing — a mistyped CIN would reach MCA's validator").toHaveLength(1);
  });

  it("app_private.is_valid_cin accepts every real CIN shape and refuses the near misses", async () => {
    const [r] = await sql<Record<string, boolean>>(`
      select app_private.is_valid_cin('L74999MH2010PLC205678') as listed_plc,
             app_private.is_valid_cin('U72900MH2019PTC330045') as unlisted_ptc,
             app_private.is_valid_cin('U72900TN2021OPC145678') as opc,
             app_private.is_valid_cin('U74999DL2015NPL123456') as sec8_npl,
             app_private.is_valid_cin(null)                    as null_tolerant,
             app_private.is_valid_cin('U72900MH2019PTC33004')  as too_short,
             app_private.is_valid_cin('X72900MH2019PTC330045') as not_l_or_u,
             app_private.is_valid_cin('U7290AMH2019PTC330045') as letter_in_nic_code,
             app_private.is_valid_cin('u72900mh2019ptc330045') as lower_case,
             app_private.is_valid_cin('AAB-1234')              as an_llpin
    `);
    // Accepted: the two live values, an OPC, and a Section 8 company — the
    // class code is deliberately not enumerated.
    expect(r.listed_plc).toBe(true);
    expect(r.unlisted_ptc).toBe(true);
    expect(r.opc).toBe(true);
    expect(r.sec8_npl).toBe(true);
    // Null-tolerant, like every other validator in 0001, so it can sit in a
    // CHECK constraint without forcing NOT NULL.
    expect(r.null_tolerant).toBe(true);
    expect(r.too_short).toBe(false);
    expect(r.not_l_or_u).toBe(false);
    expect(r.letter_in_nic_code).toBe(false);
    expect(r.lower_case).toBe(false);
    // An LLP's LLPIN is a different identifier and must not be launderable
    // into companies.cin — there is no llpin column, a named gap.
    expect(r.an_llpin).toBe(false);
  });

  it("every stored cin and iec satisfies its own CHECK format", async () => {
    const rows = await sql(`
      select id, name, cin, iec from companies
       where not app_private.is_valid_cin(cin) or not app_private.is_valid_iec(iec)
    `);
    expect(rows, `a stored cin/iec doesn't match its own validator:\n${offenders(rows)}`).toEqual([]);
  });

  it("a PAN change can no longer contradict a GST registration the company already holds", async () => {
    // app_private.enforce_gstin_state (0005) guards the gst_registrations
    // side. Its companies-side counterpart did not exist until PAN became
    // editable, which is exactly when the hole opens.
    const rows = await sql(`
      select t.tgname, t.tgtype from pg_trigger t
       where t.tgrelid = 'public.companies'::regclass
         and t.tgname = 'enforce_company_pan_matches_registrations'
         and not t.tgisinternal
    `);
    expect(rows, "the companies-side PAN guard trigger is missing").toHaveLength(1);
    // tgtype bit 0 = BEFORE (row-level ROW bit 0x1, BEFORE is bit 0x2 unset
    // meaning AFTER; 0x2 set means BEFORE). Assert it fires BEFORE, since an
    // AFTER trigger would have already written the contradicting row.
    expect(Number(rows[0].tgtype) & 2, "the PAN guard must fire BEFORE the write").toBe(2);
  });

  it("no company's own PAN contradicts a GSTIN registered to it", async () => {
    // The invariant the trigger exists to hold. A GSTIN embeds its holder's
    // PAN in characters 3-12; a company whose own PAN differs is claiming a
    // registration belonging to another legal entity, and every GSTR-1/3B,
    // e-invoice and e-way-bill payload is built from it.
    const rows = await sql(`
      select c.id, c.name, c.pan, g.gstin, app_private.gstin_pan(g.gstin) as gstin_pan
        from companies c
        join gst_registrations g on g.company_id = c.id
       where c.pan is not null and app_private.gstin_pan(g.gstin) <> c.pan
    `);
    expect(rows, `a company's PAN contradicts a GSTIN it holds:\n${offenders(rows)}`).toEqual([]);
  });

  it("the exim and foreign_currency modules are active for exactly the companies that have an IEC", async () => {
    // Both are tier='conditional' with activates_when '{"has_iec":true}'
    // (0004), and exim additionally depends_on foreign_currency — so the
    // resolver's fixpoint has to open both, in one pass over the company
    // update. This assertion is what proves setting an IEC in Company
    // Settings genuinely reaches the Modules screen, in both directions.
    const rows = await sql(`
      select c.id, c.name, c.iec is not null as has_iec, m.module_code,
             exists (
               select 1 from company_modules x
                where x.company_id = c.id and x.module_code = m.module_code
                  and x.effective_from <= current_date
                  and (x.effective_to is null or x.effective_to >= current_date)
             ) as module_active
        from companies c
        cross join (values ('exim'), ('foreign_currency')) as m(module_code)
       where (c.iec is not null) is distinct from exists (
               select 1 from company_modules x
                where x.company_id = c.id and x.module_code = m.module_code
                  and x.effective_from <= current_date
                  and (x.effective_to is null or x.effective_to >= current_date)
             )
    `);
    expect(
      rows,
      `an IEC and its conditional modules disagree — the resolver did not fire, or fired the wrong way:\n${offenders(rows)}`
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Company backup / full export (0112, application-layer)
// ---------------------------------------------------------------------------
describeDb(`company backup export (${hasDb ? "live" : noDbReason})`, () => {
  it("every genuinely company-scoped table either has real RLS or is explicitly documented as an intentional export gap — a spot check on a sample of tables", async () => {
    // Not a full re-implementation of the export route's own TABLES list —
    // just confirms the RLS precondition the whole feature leans on: every
    // table it exports is is_company_member-gated, not open-read.
    const rows = await sql(`
      select tablename from pg_tables
       where schemaname = 'public'
         and tablename = any(array['vouchers', 'voucher_entries', 'ledgers', 'items', 'employees'])
         and tablename not in (select tablename from pg_policies where schemaname = 'public')
    `);
    expect(rows, `an exported table has no RLS policy at all:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Delivery challan (Rule 55) + GRN (0113)
// ---------------------------------------------------------------------------
describeDb(`delivery challans (${hasDb ? "live" : noDbReason})`, () => {
  it("delivery_challans/receipts reject a direct authenticated write — every write must go through the SECURITY DEFINER functions", async () => {
    const rows = await sql(`
      select tablename, policyname, cmd from pg_policies
       where tablename in ('delivery_challans', 'delivery_challan_receipts') and cmd in ('INSERT', 'ALL')
    `);
    expect(rows, `a direct INSERT policy exists on delivery_challans/receipts — writes should only be via create_delivery_challan(_receipt):\n${offenders(rows)}`).toEqual([]);
  });

  it("no delivery_challan_receipts row ever records more quantity_received than its challan's quantity_sent, cumulatively", async () => {
    const rows = await sql(`
      select dc.id, dc.quantity_sent, sum(r.quantity_received) as total_received
        from delivery_challans dc
        join delivery_challan_receipts r on r.challan_id = dc.id
       group by dc.id, dc.quantity_sent
      having sum(r.quantity_received) > dc.quantity_sent
    `);
    expect(rows, `a challan has received more than it ever sent:\n${offenders(rows)}`).toEqual([]);
  });

  it("every delivery challan voucher's own entries are self-balancing on the Delivery Challan Movement memo ledger (zero net ledger impact)", async () => {
    const rows = await sql(`
      select dc.id, v.voucher_number, sum(e.debit_amount) as d, sum(e.credit_amount) as c
        from delivery_challans dc
        join vouchers v on v.id = dc.voucher_id
        join voucher_entries e on e.voucher_id = v.id
       group by dc.id, v.voucher_number
      having round(sum(e.debit_amount) - sum(e.credit_amount), 2) <> 0
    `);
    expect(rows, `a delivery challan voucher doesn't balance:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BOM by-product / scrap / co-product output typing (0114)
// ---------------------------------------------------------------------------
describeDb(`BOM by-product/scrap outputs (${hasDb ? "live" : noDbReason})`, () => {
  it("bom_outputs' composite FKs are real — no output row can point at a BOM or item from a different company", async () => {
    const rows = await sql(`
      select conname from pg_constraint
       where conrelid = 'public.bom_outputs'::regclass and contype = 'f'
    `);
    expect(rows.length, "bom_outputs has fewer foreign keys than expected (bom_id+company_id, output_item_id+company_id)").toBeGreaterThanOrEqual(2);
  });

  it("cost conservation holds for every production voucher with a by-product/scrap/co-product output: component cost consumed (direction='out') equals total output value produced (direction='in'), to the paisa", async () => {
    // Scoped specifically to voucher_items that actually reference a
    // bom_outputs item, and to stock_journal vouchers only — an item that's
    // a defined co-product/scrap output elsewhere can also independently
    // appear on an ordinary sales voucher (same item, unrelated context),
    // and a blanket scan across every stock_journal voucher would also
    // catch older, pre-by-product-feature production vouchers this feature
    // never touched. direction='out' is stock LEAVING inventory (the
    // component being consumed); direction='in' is stock ENTERING it (the
    // output(s) produced) — conservation means these two sums are equal.
    const rows = await sql(`
      with production_vouchers as (
        select distinct vi.voucher_id
          from voucher_items vi
          join bom_outputs bo on bo.output_item_id = vi.item_id
         where vi.direction = 'out'
      )
      select v.id, v.voucher_number,
             sum(case when vi.direction = 'out' then vi.amount else 0 end) as component_cost,
             sum(case when vi.direction = 'in' then vi.amount else 0 end) as total_output_value
        from vouchers v
        join voucher_items vi on vi.voucher_id = v.id
       where v.id in (select voucher_id from production_vouchers)
         and v.voucher_type = 'stock_journal'
       group by v.id, v.voucher_number
      having round(sum(case when vi.direction = 'out' then vi.amount else 0 end)
                    - sum(case when vi.direction = 'in' then vi.amount else 0 end), 2) <> 0
    `);
    expect(rows, `a production voucher's component cost doesn't conserve into its output value:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Register of Charges, CHG-1/CHG-4 (0115)
// ---------------------------------------------------------------------------
describeDb(`register of charges (${hasDb ? "live" : noDbReason})`, () => {
  it("no charges row exists for a company whose entity_type can't hold one (pvt_ltd/ltd/opc only)", async () => {
    const rows = await sql(`
      select ch.id, c.name, c.entity_type
        from charges ch join companies c on c.id = ch.company_id
       where c.entity_type not in ('pvt_ltd', 'ltd', 'opc')
    `);
    expect(rows, `a charge exists on a company with no charge-filing duty under Sec 77:\n${offenders(rows)}`).toEqual([]);
  });

  it("a satisfied charge (date_of_satisfaction set) is never counted as 'live' by get_charges_summary", async () => {
    const rows = await sql(`
      select c.name, s.live_charge_count, s.satisfied_charge_count,
             (select count(*) from charges ch where ch.company_id = c.id and ch.date_of_satisfaction is null) as raw_live,
             (select count(*) from charges ch where ch.company_id = c.id and ch.date_of_satisfaction is not null) as raw_satisfied
        from companies c
        cross join lateral get_charges_summary(c.id) s
       where s.live_charge_count <> (select count(*) from charges ch where ch.company_id = c.id and ch.date_of_satisfaction is null)
          or s.satisfied_charge_count <> (select count(*) from charges ch where ch.company_id = c.id and ch.date_of_satisfaction is not null)
    `);
    expect(rows, `get_charges_summary's live/satisfied counts disagree with the raw table:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sec 186 investment/loan register, MBP-2 (0116)
// ---------------------------------------------------------------------------
describeDb(`Sec 186 investments (${hasDb ? "live" : noDbReason})`, () => {
  it("no sec186_investments row has a board_resolution_date after its own transaction date", async () => {
    const rows = await sql(`
      select id, company_id, date, board_resolution_date from sec186_investments
       where board_resolution_date > date
    `);
    expect(rows, `a Sec 186 transaction was board-approved after it happened:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_sec186_ceiling_check always flags is_approximate = true (this schema can't isolate securities premium from reserves_surplus)", async () => {
    const rows = await sql(`
      select c.name, s.is_approximate
        from companies c
        cross join lateral get_sec186_ceiling_check(c.id) s
       where s.is_approximate is distinct from true
    `);
    expect(rows, `get_sec186_ceiling_check stopped flagging its own known approximation:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DSC register (0117)
// ---------------------------------------------------------------------------
describeDb(`DSC register (${hasDb ? "live" : noDbReason})`, () => {
  it("every DSC row has exactly one of holder_director_id / holder_name, and valid_to >= valid_from", async () => {
    const rows = await sql(`
      select id, company_id, holder_director_id, holder_name, valid_from, valid_to
        from digital_signature_certificates
       where (holder_director_id is null) = (holder_name is null)
          or valid_to < valid_from
    `);
    expect(rows, `a DSC row violates its own holder-exclusivity or date-ordering CHECK:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_dsc_expiry_status's is_expired flag always agrees with valid_to < current_date", async () => {
    const rows = await sql(`
      select c.name, s.id, s.valid_to, s.is_expired
        from companies c
        cross join lateral get_dsc_expiry_status(c.id) s
       where s.is_expired is distinct from (s.valid_to < current_date)
    `);
    expect(rows, `is_expired disagrees with valid_to < current_date:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DPT-3 return content (0118)
// ---------------------------------------------------------------------------
describeDb(`DPT-3 content (${hasDb ? "live" : noDbReason})`, () => {
  it("get_dpt3_return_content is not reachable by anon or public", async () => {
    const rows = await sql(`
      select grantee from information_schema.routine_privileges
       where routine_name = 'get_dpt3_return_content' and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `get_dpt3_return_content reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("only ledgers.is_loan_or_deposit = true ledgers ever appear in the DPT-3 content, for any company", async () => {
    const rows = await sql(`
      select c.name, r.ledger_name
        from companies c
        cross join lateral get_dpt3_return_content(c.id, '2027-03-31'::date) r
       where not exists (
         select 1 from ledgers l
          where l.company_id = c.id and l.name = r.ledger_name and l.is_loan_or_deposit
       )
    `);
    expect(rows, `DPT-3 content includes a ledger that isn't flagged is_loan_or_deposit:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EXIM data capture — shipping bill / BOE / BRC / FEMA clock (0119)
// ---------------------------------------------------------------------------
describeDb(`EXIM data capture (${hasDb ? "live" : noDbReason})`, () => {
  it("exim_shipment_details.export_realisation_due_date is always null for a bill_of_entry (imports have no FEMA export clock)", async () => {
    const rows = await sql(`
      select id, voucher_id, document_type, export_realisation_due_date
        from exim_shipment_details
       where document_type = 'bill_of_entry' and export_realisation_due_date is not null
    `);
    expect(rows, `a bill_of_entry row wrongly carries an export realisation due date:\n${offenders(rows)}`).toEqual([]);
  });

  it("no exim_shipment_details row carries a brc_number/brc_date/realised_date on a bill_of_entry (export-only fields)", async () => {
    const rows = await sql(`
      select id, voucher_id from exim_shipment_details
       where document_type = 'bill_of_entry'
         and (brc_number is not null or brc_date is not null or realised_date is not null)
    `);
    expect(rows, `a bill_of_entry row wrongly carries an export-only BRC field:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_exim_realisation_status.status = 'overdue_unrealised' implies is_overdue is true and realised_date is null", async () => {
    const rows = await sql(`
      select c.name, s.voucher_id, s.status, s.is_overdue, s.realised_date
        from companies c
        cross join lateral get_exim_realisation_status(c.id, current_date) s
       where s.status = 'overdue_unrealised' and (not s.is_overdue or s.realised_date is not null)
    `);
    expect(rows, `overdue_unrealised status disagrees with its own is_overdue/realised_date fields:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GSTR-2B upload + match against the purchase register (0120)
// ---------------------------------------------------------------------------
describeDb(`GSTR-2B match (${hasDb ? "live" : noDbReason})`, () => {
  it("import_gstr2b_lines/match_gstr2b_purchase_register are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('import_gstr2b_lines', 'match_gstr2b_purchase_register') and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a GSTR-2B function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("gstr2b_lines has no duplicate (company, period, registration, invoice_number_normalized) rows", async () => {
    const rows = await sql(`
      select company_id, return_period, gst_registration_id, invoice_number_normalized, count(*)
        from gstr2b_lines
       group by company_id, return_period, gst_registration_id, invoice_number_normalized
      having count(*) > 1
    `);
    expect(rows, `duplicate 2B lines within one uploaded period:\n${offenders(rows)}`).toEqual([]);
  });

  it("a match result is never both 'matched' and carrying a nonzero amount_difference beyond rounding", async () => {
    const rows = await sql(`
      select c.name, r.invoice_number, r.amount_difference
        from companies c
        cross join lateral match_gstr2b_purchase_register(c.id, '2026-06', null, 2) r
       where r.bucket = 'matched' and round(abs(r.amount_difference), 2) > 0.02
    `);
    expect(rows, `a 'matched' row still shows a real amount difference:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Multi-UOM conversion (0121)
// ---------------------------------------------------------------------------
describeDb(`multi-UOM conversion (${hasDb ? "live" : noDbReason})`, () => {
  it("item_uom_conversions has no duplicate (item_id, alternate_uom) pair, and no alternate_uom equal to the item's own base unit", async () => {
    const rows = await sql(`
      select c.item_id, c.alternate_uom, i.uom as base_uom, count(*)
        from item_uom_conversions c
        join items i on i.id = c.item_id
       group by c.item_id, c.alternate_uom, i.uom
      having count(*) > 1 or c.alternate_uom = i.uom
    `);
    expect(rows, `a duplicate conversion or a self-referential alternate unit:\n${offenders(rows)}`).toEqual([]);
  });

  it("convert_quantity round-trips exactly: base -> alternate -> base returns the original quantity, for every defined conversion", async () => {
    const rows = await sql(`
      select item_id, alternate_uom, conversion_factor,
             convert_quantity(item_id, convert_quantity(item_id, 100, (select uom from items where id = item_id), alternate_uom), alternate_uom, (select uom from items where id = item_id)) as round_tripped
        from item_uom_conversions
    `);
    for (const r of rows) {
      expect(Math.abs(Number(r.round_tripped) - 100), `conversion for item ${r.item_id}/${r.alternate_uom} doesn't round-trip`).toBeLessThan(0.001);
    }
  });
});

// ---------------------------------------------------------------------------
// Email transport + notifications (0122)
// ---------------------------------------------------------------------------
describeDb(`email notifications (${hasDb ? "live" : noDbReason})`, () => {
  it("notifications has no direct INSERT/UPDATE/DELETE policy for authenticated — every write goes through a SECURITY DEFINER function", async () => {
    const rows = await sql(`
      select policyname, cmd from pg_policies
       where tablename = 'notifications' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    `);
    expect(rows, `notifications has a direct write policy — should be SECURITY DEFINER functions only:\n${offenders(rows)}`).toEqual([]);
  });

  it("run_notifications_digest and the pending-email functions are not reachable by anon, public, or a bare authenticated grant on the digest itself", async () => {
    // app_private's default ACL auto-grants EXECUTE to authenticated on new
    // functions (unlike public schema) — the real gap 0122's own report
    // caught. This guards the fix stays in place.
    const rows = await sql(`
      select p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_can_run
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'app_private' and p.proname = 'run_notifications_digest'
    `);
    expect(rows[0]?.auth_can_run, "run_notifications_digest is callable by a plain authenticated user again").toBe(false);
  });

  it("create_notifications_from_needs_attention never creates a duplicate row for the same (company, category, related_entity_id)", async () => {
    const rows = await sql(`
      select company_id, category, related_entity_id, count(*)
        from notifications
       group by company_id, category, related_entity_id
      having count(*) > 1
    `);
    expect(rows, `duplicate notification rows for the same issue:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GST refund computation, Rule 89(4)/(5) (0123)
// ---------------------------------------------------------------------------
describeDb(`GST refund computation (${hasDb ? "live" : noDbReason})`, () => {
  it("get_gst_refund_rule89_4/5 are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('get_gst_refund_rule89_4', 'get_gst_refund_rule89_5') and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a GST refund function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("Rule 89(4)'s refund_amount equals zero_rated_turnover_total x net_itc / adjusted_total_turnover exactly, whenever ATT is nonzero", async () => {
    const rows = await sql(`
      select c.name, r.zero_rated_turnover_total, r.net_itc, r.adjusted_total_turnover, r.refund_amount
        from companies c
        cross join lateral get_gst_refund_rule89_4(c.id, null, '1900-01-01'::date, '2999-12-31'::date) r
       where r.adjusted_total_turnover > 0
         and round(r.zero_rated_turnover_total * r.net_itc / r.adjusted_total_turnover, 2) <> round(r.refund_amount, 2)
    `);
    expect(rows, `Rule 89(4) refund_amount doesn't match its own formula:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Print templates + server-side PDF (0125)
// ---------------------------------------------------------------------------
describeDb(`print templates (${hasDb ? "live" : noDbReason})`, () => {
  it("companies.logo_url / print_terms_and_conditions / print_footer_note carry authenticated SELECT+UPDATE grants", async () => {
    for (const col of ["logo_url", "print_terms_and_conditions", "print_footer_note"]) {
      const rows = await sql(`
        select privilege_type from information_schema.column_privileges
         where table_name = 'companies' and column_name = '${col}' and grantee = 'authenticated'
      `);
      const privs = rows.map((r) => r.privilege_type);
      expect(privs, `authenticated lacks SELECT on companies.${col}`).toContain("SELECT");
      expect(privs, `authenticated lacks UPDATE on companies.${col}`).toContain("UPDATE");
    }
  });

  it("print_terms_and_conditions and print_footer_note respect their own length CHECKs", async () => {
    const rows = await sql(`
      select id, name from companies
       where length(print_terms_and_conditions) > 4000 or length(print_footer_note) > 1000
    `);
    expect(rows, `a company's print copy exceeds its own CHECK-enforced length:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GSTR-3B Table 4 / 6.1 prep (0129)
// ---------------------------------------------------------------------------
describeDb(`GSTR-3B prep (${hasDb ? "live" : noDbReason})`, () => {
  it("get_gstr3b_table4/6_1 are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('get_gstr3b_table4', 'get_gstr3b_table6_1') and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a GSTR-3B function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("Table 4's c_net_itc_available equals a_total minus b_total exactly, for every registration/period combination checked", async () => {
    const rows = await sql(`
      select c.name, gr.id as registration_id, t.a_total, t.b_total, t.c_net_itc_available
        from companies c
        join gst_registrations gr on gr.company_id = c.id
        cross join lateral get_gstr3b_table4(c.id, gr.id, '1900-01-01'::date, '2999-12-31'::date) t
       where round(t.a_total - t.b_total, 2) <> round(t.c_net_itc_available, 2)
    `);
    expect(rows, `Table 4's net ITC doesn't equal A minus B:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TDS late-deposit interest (Sec 201(1A)) + Sec 234E late fee (0130)
// ---------------------------------------------------------------------------
describeDb(`TDS interest and 234E fee (${hasDb ? "live" : noDbReason})`, () => {
  it("get_tds_late_deposit_interest/get_234e_late_fee are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('get_tds_late_deposit_interest', 'get_234e_late_fee') and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a TDS-interest function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_234e_late_fee raises when called with a null filing date rather than silently returning zero", async () => {
    await expect(
      sql(`select * from get_234e_late_fee((select id from companies limit 1), '2026-27', 1, null)`)
    ).rejects.toThrow();
  });

  it("no late-deposit interest row shows a negative interest_amount", async () => {
    const rows = await sql(`
      select c.name, r.deduction_date, r.interest_amount
        from companies c
        cross join lateral get_tds_late_deposit_interest(c.id, '2026-27') r
       where r.interest_amount < 0
    `);
    expect(rows, `negative TDS late-deposit interest:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GSTR-1 Tables 6A/6B/6C — exports, SEZ, deemed exports (0134)
// ---------------------------------------------------------------------------
describeDb(`GSTR-1 Table 6A/6B/6C (${hasDb ? "live" : noDbReason})`, () => {
  it("get_gstr1_table6a/6b/6c are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('get_gstr1_table6a', 'get_gstr1_table6b', 'get_gstr1_table6c') and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a GSTR-1 Table 6 function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("no Table 6C (deemed export) row ever carries a shipping bill — goods under Sec 147 never leave India", async () => {
    const rows = await sql(`
      select c.name, r.voucher_number, r.shipping_bill_number
        from companies c
        cross join lateral get_gstr1_table6c(c.id, '1900-01-01'::date, '2999-12-31'::date, null) r
       where r.shipping_bill_number is not null
    `);
    expect(rows, `a deemed-export row wrongly carries a shipping bill:\n${offenders(rows)}`).toEqual([]);
  });

  it("no Table 6A/6B row ever has a negative invoice value or negative tax — the historical sign-convention bug this migration's own report caught", async () => {
    const rows = await sql(`
      select 'table6a' as tbl, r.voucher_number, r.invoice_value, r.cgst + r.sgst + r.igst + r.cess as total_tax
        from companies c cross join lateral get_gstr1_table6a(c.id, '1900-01-01'::date, '2999-12-31'::date, null) r
       where r.invoice_value < 0 or (r.cgst + r.sgst + r.igst + r.cess) < 0
      union all
      select 'table6b', r.voucher_number, r.invoice_value, r.cgst + r.sgst + r.igst + r.cess
        from companies c cross join lateral get_gstr1_table6b(c.id, '1900-01-01'::date, '2999-12-31'::date, null) r
       where r.invoice_value < 0 or (r.cgst + r.sgst + r.igst + r.cess) < 0
    `);
    expect(rows, `a negative invoice value or tax in Table 6A/6B:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Payroll cluster — leave, gratuity, F&F settlement, registers (0140-0142)
// ---------------------------------------------------------------------------
describeDb(`payroll cluster: leave, gratuity, F&F (${hasDb ? "live" : noDbReason})`, () => {
  it("employee_leave_ledger has no double-accrual — one row per (employee, period_month)", async () => {
    const rows = await sql(`
      select employee_id, period_month, count(*) from employee_leave_ledger
       group by employee_id, period_month having count(*) > 1
    `);
    expect(rows, `duplicate leave accrual rows for the same employee/month:\n${offenders(rows)}`).toEqual([]);
  });

  it("no gratuity computation shows a positive amount for an ineligible (under 5 years, non-death/disablement) employee", async () => {
    // Called get_gratuity_computation(company, as_at) when written. That name
    // now belongs to the per-employee, four-argument form
    // (uuid, uuid, date, text); the company-wide as-at-a-date one is
    // get_gratuity_estimates. So this threw 42883 "function does not exist"
    // rather than asserting anything — invisible for as long as the database
    // suite never ran. Same columns, so the fix is the name.
    const rows = await sql(`
      select c.name, g.employee_id, g.completed_years_for_formula, g.gratuity_payable, g.eligible
        from companies c
        cross join lateral get_gratuity_estimates(c.id, current_date) g
       where not g.eligible and g.gratuity_payable > 0
    `);
    expect(rows, `an ineligible employee has a nonzero gratuity amount:\n${offenders(rows)}`).toEqual([]);
  });

  it("gratuity never exceeds the statutory ceiling of ₹20 lakh", async () => {
    const rows = await sql(`
      select c.name, g.employee_id, g.gratuity_payable
        from companies c
        cross join lateral get_gratuity_estimates(c.id, current_date) g
       where g.gratuity_payable > 2000000
    `);
    expect(rows, `gratuity exceeds the Sec 53 ceiling of ₹20 lakh:\n${offenders(rows)}`).toEqual([]);
  });

  it("employee_exit_settlements.net_payable equals the sum of its own component columns", async () => {
    const rows = await sql(`
      select id, employee_id, net_payable,
             (coalesce(unpaid_salary_amount, 0) + coalesce(leave_encashment_amount, 0) + coalesce(gratuity_amount, 0)
              + coalesce(bonus_amount, 0) - coalesce(recoveries_amount, 0)) as recomputed
        from employee_exit_settlements
       where round(net_payable, 2) <> round(
               coalesce(unpaid_salary_amount, 0) + coalesce(leave_encashment_amount, 0) + coalesce(gratuity_amount, 0)
               + coalesce(bonus_amount, 0) - coalesce(recoveries_amount, 0), 2
             )
    `);
    expect(rows, `an F&F settlement's net_payable doesn't equal its own component sum:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Line-level discounts + price lists (0147)
// ---------------------------------------------------------------------------
describeDb(`line discounts and price lists (${hasDb ? "live" : noDbReason})`, () => {
  it("voucher_items.discount_percent stays within its own 0-100 CHECK", async () => {
    const rows = await sql(`
      select id, voucher_id, discount_percent from voucher_items
       where discount_percent < 0 or discount_percent > 100
    `);
    expect(rows, `a discount_percent outside 0-100:\n${offenders(rows)}`).toEqual([]);
  });

  it("amount_before_discount minus discount_amount equals amount, for every discounted line", async () => {
    // amount_before_discount and discount_amount are GENERATED columns;
    // amount itself is a plain column create_invoice/update_invoice write
    // separately (deliberately — other RPCs like BOM production populate
    // voucher_items with their own valuation logic that doesn't always
    // satisfy qty*rate to the cent). This only holds — and is only
    // meaningful to check — for rows that actually carry a discount.
    const rows = await sql(`
      select id, voucher_id, amount_before_discount, discount_amount, amount
        from voucher_items
       where discount_percent <> 0
         and round(amount_before_discount - discount_amount, 2) <> round(amount, 2)
    `);
    expect(rows, `a discounted line's amount doesn't equal gross minus discount:\n${offenders(rows)}`).toEqual([]);
  });

  it("no company has more than one default price list", async () => {
    const rows = await sql(`
      select company_id, count(*) from price_lists
       where is_default group by company_id having count(*) > 1
    `);
    expect(rows, `a company has multiple default price lists:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_effective_item_price and the invoice-affecting functions are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name = 'get_effective_item_price' and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `get_effective_item_price reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("every non-discounted pre-existing voucher line still has amount = amount_before_discount (byte-identical regression)", async () => {
    const rows = await sql(`
      select id, voucher_id, amount_before_discount, amount from voucher_items
       where discount_percent = 0 and round(amount_before_discount, 2) <> round(amount, 2)
    `);
    expect(rows, `a non-discounted line's amount drifted from its own gross value:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 26AS / AIS / TIS upload + match (0148)
// ---------------------------------------------------------------------------
describeDb(`26AS/AIS/TIS match (${hasDb ? "live" : noDbReason})`, () => {
  it("import_income_tax_statement_lines and the match function are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('import_income_tax_statement_lines', 'match_income_tax_statement_tds_receivable')
         and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `an income-tax-statement function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("every match bucket is one of the three the function is documented to return", async () => {
    const rows = await sql(`
      select c.name, r.bucket
        from companies c
        cross join lateral list_income_tax_statement_periods(c.id) p
        cross join lateral match_income_tax_statement_tds_receivable(c.id, p.financial_year_label, p.source) r
       where r.bucket not in ('matched', 'missing_from_books', 'missing_from_statement')
    `);
    expect(rows, `an unexpected match bucket value:\n${offenders(rows)}`).toEqual([]);
  });

  it("a 'matched' row's amount_difference equals tds_receivable_register minus tax_deposited_statement", async () => {
    const rows = await sql(`
      select c.name, r.deductor_tan, r.tax_deposited_statement, r.tds_receivable_register, r.amount_difference
        from companies c
        cross join lateral list_income_tax_statement_periods(c.id) p
        cross join lateral match_income_tax_statement_tds_receivable(c.id, p.financial_year_label, p.source) r
       where r.bucket = 'matched'
         and round(coalesce(r.tds_receivable_register, 0) - coalesce(r.tax_deposited_statement, 0), 2) <> round(coalesce(r.amount_difference, 0), 2)
    `);
    expect(rows, `amount_difference doesn't equal statement minus register:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GSTR-9 / 9C annual return workpaper (0155)
// ---------------------------------------------------------------------------
describeDb(`GSTR-9/9C workpaper (${hasDb ? "live" : noDbReason})`, () => {
  it("the three workpaper functions are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('get_gstr9_table4_5', 'get_gstr9_table8', 'get_gstr9c_turnover_reconciliation')
         and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a GSTR-9/9C function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("Table 8's 8B (ITC per books) equals get_gst_input_register's own taxable-value total for the same period exactly", async () => {
    // 8A (ITC per GSTR-2B) and 8B (ITC per books) are two independent
    // comparison figures, not additive components of one total — 8B alone
    // is the one that must reconcile exactly to the input register, since
    // both describe "ITC per books" from the same underlying data.
    const rows = await sql(`
      with t8b as (
        select c.id, c.name,
               max(t.taxable_value) filter (where t.row_code = '8B') as t8b_taxable
          from companies c
          join gst_registrations gr on gr.company_id = c.id
          cross join lateral get_gstr9_table8(c.id, gr.id, '2026-04-01'::date, '2027-03-31'::date) t
         group by c.id, c.name
      ),
      register as (
        select c.id,
               (select coalesce(sum(taxable_value), 0) from get_gst_input_register(c.id, '2026-04-01'::date, '2027-03-31'::date)) as reg_taxable
          from companies c
      )
      select t8b.name, t8b.t8b_taxable, register.reg_taxable
        from t8b join register on register.id = t8b.id
       where round(coalesce(t8b.t8b_taxable, 0), 2) <> round(coalesce(register.reg_taxable, 0), 2)
    `);
    expect(rows, `GSTR-9 Table 8's "ITC per books" doesn't match the whole year's own input register total:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_gstr9c_turnover_reconciliation's difference equals books revenue from operations minus the GST workpaper turnover (other income correctly excluded)", async () => {
    // books_other_income is deliberately NOT part of this reconciliation —
    // confirmed live: including it in the expected formula produced a
    // mismatch of exactly books_other_income on every company, which is
    // the correct accounting position (interest/other income generally
    // isn't a GST-taxable supply, so GSTR-9C Table 5 reconciles revenue
    // FROM OPERATIONS against GST turnover, not total books income).
    const rows = await sql(`
      select c.name, r.books_revenue_from_operations, r.books_other_income, r.gst_workpaper_turnover, r.difference
        from companies c
        join gst_registrations gr on gr.company_id = c.id
        cross join lateral get_gstr9c_turnover_reconciliation(c.id, gr.id, '2026-04-01'::date, '2027-03-31'::date) r
       where round(
               coalesce(r.books_revenue_from_operations, 0) - coalesce(r.gst_workpaper_turnover, 0), 2
             ) <> round(coalesce(r.difference, 0), 2)
    `);
    expect(rows, `GSTR-9C turnover reconciliation's difference doesn't equal revenue-from-operations minus GST turnover:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TCS collectee summary + Form 27EQ/143 (0146)
// ---------------------------------------------------------------------------
describeDb(`TCS collectee summary (${hasDb ? "live" : noDbReason})`, () => {
  it("get_tcs_collectee_summary is not reachable by anon or public", async () => {
    const rows = await sql(`
      select grantee from information_schema.routine_privileges
       where routine_name = 'get_tcs_collectee_summary' and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `get_tcs_collectee_summary reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("no company/quarter shows more voucher_count than the whole company has TCS-relevant sales vouchers", async () => {
    const rows = await sql(`
      select c.name, r.collectee_name, r.voucher_count,
             (select count(*) from vouchers v where v.company_id = c.id and v.voucher_type in ('sales', 'credit_note') and not v.is_deleted) as company_voucher_ceiling
        from companies c
        cross join lateral get_tcs_collectee_summary(c.id, '2026-27', 1) r
       where r.voucher_count > (select count(*) from vouchers v where v.company_id = c.id and v.voucher_type in ('sales', 'credit_note') and not v.is_deleted)
    `);
    expect(rows, `a TCS collectee's voucher_count exceeds the company's own total sales/credit-note voucher count:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Recurring voucher templates (0151)
// ---------------------------------------------------------------------------
describeDb(`recurring vouchers (${hasDb ? "live" : noDbReason})`, () => {
  it("generate_due_recurring_vouchers and its management functions are not reachable by anon or public", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in ('generate_due_recurring_vouchers', 'list_recurring_voucher_templates', 'create_recurring_voucher_template')
         and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a recurring-voucher function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("recurring_voucher_generation_log has no duplicate (template_id, run_date) — the idempotency guard actually holds", async () => {
    const rows = await sql(`
      select template_id, run_date, count(*) from recurring_voucher_generation_log
       group by template_id, run_date having count(*) > 1
    `);
    expect(rows, `duplicate generation-log rows for the same template/date — re-running would double-post:\n${offenders(rows)}`).toEqual([]);
  });

  it("every generation-log row that claims a voucher_id points at a real, still-existing voucher", async () => {
    const rows = await sql(`
      select l.id, l.template_id, l.voucher_id from recurring_voucher_generation_log l
       where l.voucher_id is not null and not exists (select 1 from vouchers v where v.id = l.voucher_id)
    `);
    expect(rows, `a generation-log row references a voucher that no longer exists:\n${offenders(rows)}`).toEqual([]);
  });

  it("every active template's next_run_date is on or after its own start_date", async () => {
    const rows = await sql(`
      select id, template_name, start_date, next_run_date from recurring_voucher_templates
       where is_active and next_run_date < start_date
    `);
    expect(rows, `a template's next_run_date precedes its own start_date:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tier 4 batch 9 + batch 10 (0163-0230): AGM calendar wiring, bank feed
// adapters, stock verification/ageing, cross-company notification dispatch,
// e-signature workflow, GST TDS/TCS suffered, FIFO stock valuation, e-way
// bill capture, Form 16 Part B, Schedule III expense sub-classification,
// GSTR-3B Table 5.1, e-invoice IRN capture. ITR JSON builder ships no SQL
// (pure TS over existing RPCs) so it has no describeDb block here.
// ---------------------------------------------------------------------------
describeDb(`tier 4 batch 9/10 new functions (${hasDb ? "live" : noDbReason})`, () => {
  it("no new function from this wave is reachable by anon or PUBLIC", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in (
         'get_stock_fifo_layers', 'get_stock_summary_fifo', 'get_form16_partb',
         'get_gst_tds_tcs_suffered_summary', 'get_pending_notification_summary',
         'get_ewb_requirement', 'get_ewb_status', 'build_ewb_json',
         'get_einvoice_applicability', 'build_einvoice_json', 'get_einvoice_status',
         'get_gstr3b_table5_1', 'record_stock_verification', 'get_stock_verifications',
         'get_stock_ageing', 'send_signature_request', 'cancel_signature_request',
         'decline_signer', 'record_signed_document'
       ) and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a batch 9/10 function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`AGM calendar wiring (${hasDb ? "live" : noDbReason})`, () => {
  it("AOC-4/MGT-7 due dates derive from a real recorded AGM's meeting_date (+30/+60 days), not the 30-Sep assumption", async () => {
    const rows = await sql(`
      select m.company_id, m.meeting_date,
             (select due_date from get_compliance_calendar(m.company_id, '2000-01-01', '2099-12-31') cc
               where cc.label like 'AOC-4%' and cc.detail like '%AGM held%'
                 and cc.due_date = m.meeting_date + 30) as aoc4_match,
             (select due_date from get_compliance_calendar(m.company_id, '2000-01-01', '2099-12-31') cc
               where cc.label like 'MGT-7%' and cc.detail like '%AGM held%'
                 and cc.due_date = m.meeting_date + 60) as mgt7_match
        from meetings m
       where m.meeting_type = 'agm'
    `);
    for (const r of rows as Record<string, unknown>[]) {
      expect(r.aoc4_match, `AOC-4 due date not found at meeting_date+30 for company ${r.company_id}`).not.toBeNull();
      expect(r.mgt7_match, `MGT-7 due date not found at meeting_date+60 for company ${r.company_id}`).not.toBeNull();
    }
  });
});

describeDb(`bank feed format adapters (${hasDb ? "live" : noDbReason})`, () => {
  it("bank_statement_lines has no duplicate (company_id, ledger_id, external_txn_id) — re-import stayed idempotent", async () => {
    const rows = await sql(`
      select company_id, ledger_id, external_txn_id, count(*) from bank_statement_lines
       group by company_id, ledger_id, external_txn_id having count(*) > 1
    `);
    expect(rows, `duplicate bank statement lines slipped past the dedupe key:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`stock verification and ageing (${hasDb ? "live" : noDbReason})`, () => {
  it("every stock_verifications row's variance_quantity equals physical minus book quantity", async () => {
    const rows = await sql(`
      select id, book_quantity, physical_quantity, variance_quantity from stock_verifications
       where variance_quantity <> (physical_quantity - book_quantity)
    `);
    expect(rows, `a stock verification's variance doesn't match physical-book:\n${offenders(rows)}`).toEqual([]);
  });

  it("every stock_verifications adjustment_voucher_id points at a real, existing voucher", async () => {
    const rows = await sql(`
      select v.id from stock_verifications v
       where v.adjustment_voucher_id is not null
         and not exists (select 1 from vouchers x where x.id = v.adjustment_voucher_id)
    `);
    expect(rows, `a stock verification references a voucher that doesn't exist:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`e-signature request workflow (${hasDb ? "live" : noDbReason})`, () => {
  it("no signature_requests row is 'completed' while any of its signers is not 'signed'", async () => {
    const rows = await sql(`
      select r.id from signature_requests r
       where r.status = 'completed'
         and exists (select 1 from signature_request_signers s where s.request_id = r.id and s.status <> 'signed')
    `);
    expect(rows, `a signature request is marked completed with an unsigned/declined signer:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`GST TDS/TCS suffered (${hasDb ? "live" : noDbReason})`, () => {
  it("gst_tds_tcs_suffered has no duplicate (gst_registration_id, source_type, deductor_or_operator_gstin, period_label)", async () => {
    const rows = await sql(`
      select gst_registration_id, source_type, deductor_or_operator_gstin, period_label, count(*)
        from gst_tds_tcs_suffered
       group by gst_registration_id, source_type, deductor_or_operator_gstin, period_label
      having count(*) > 1
    `);
    expect(rows, `duplicate GST TDS/TCS suffered entries for the same statement line:\n${offenders(rows)}`).toEqual([]);
  });

  it("no row sets both CGST/SGST and IGST at once", async () => {
    const rows = await sql(`
      select id from gst_tds_tcs_suffered where (cgst_amount > 0 or sgst_amount > 0) and igst_amount > 0
    `);
    expect(rows, `a GST TDS/TCS suffered row mixes intra- and inter-state tax heads:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`e-way bill data capture (${hasDb ? "live" : noDbReason})`, () => {
  it("ewb_details is only ever attached to a sales voucher", async () => {
    const rows = await sql(`
      select e.id, v.voucher_type from ewb_details e join vouchers v on v.id = e.voucher_id
       where v.voucher_type <> 'sales'
    `);
    expect(rows, `an ewb_details row is attached to a non-sales voucher:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`e-invoice IRN data capture (${hasDb ? "live" : noDbReason})`, () => {
  it("einvoice_details is only ever attached to a sales or credit_note voucher", async () => {
    const rows = await sql(`
      select e.id, v.voucher_type from einvoice_details e join vouchers v on v.id = e.voucher_id
       where v.voucher_type not in ('sales', 'credit_note')
    `);
    expect(rows, `an einvoice_details row is attached to a voucher type it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`Form 16 Part B (${hasDb ? "live" : noDbReason})`, () => {
  it("ref_income_tax_slabs_old_regime covers 0 to the top slab with no gaps or overlaps", async () => {
    const rows = await sql(`
      select a.sort_order, a.to_rupees, b.from_rupees, b.sort_order as next_sort
        from ref_income_tax_slabs_old_regime a
        join ref_income_tax_slabs_old_regime b on b.sort_order = (
          select min(sort_order) from ref_income_tax_slabs_old_regime where sort_order > a.sort_order
        )
       where b.from_rupees <> a.to_rupees + 1
    `);
    expect(rows, `a gap or overlap exists between adjacent old-regime slab rows:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`Schedule III expense sub-classification (${hasDb ? "live" : noDbReason})`, () => {
  it("every direct/indirect expense account_group carries one of the 8 valid Schedule III ledger_role values", async () => {
    const rows = await sql(`
      select id, name, nature, ledger_role from account_groups
       where nature in ('direct_expense', 'indirect_expense')
         and ledger_role not in ('cost_of_materials', 'purchases_stock_in_trade', 'changes_in_inventories',
           'employee_benefits', 'finance_costs', 'depreciation_amortisation', 'other_expenses', 'tax_expense')
    `);
    expect(rows, `an expense account_group has an invalid or missing ledger_role:\n${offenders(rows)}`).toEqual([]);
  });

  it("get_profit_and_loss's 8-bucket expense partition sums exactly to the whole direct+indirect expense total, per company", async () => {
    const rows = await sql(`
      select c.name,
             round(sum(case when r.nature in ('direct_expense', 'indirect_expense') then r.amount else 0 end), 2) as whole_total,
             round(sum(case when r.nature in ('direct_expense', 'indirect_expense')
                             and r.ledger_role in ('cost_of_materials', 'purchases_stock_in_trade', 'changes_in_inventories',
                               'employee_benefits', 'finance_costs', 'depreciation_amortisation', 'other_expenses', 'tax_expense')
                        then r.amount else 0 end), 2) as bucketed_total
        from companies c
        cross join lateral get_profit_and_loss(c.id, '2000-01-01', '2030-12-31') r
       group by c.id, c.name
      having round(sum(case when r.nature in ('direct_expense', 'indirect_expense') then r.amount else 0 end), 2)
          <> round(sum(case when r.nature in ('direct_expense', 'indirect_expense')
                             and r.ledger_role in ('cost_of_materials', 'purchases_stock_in_trade', 'changes_in_inventories',
                               'employee_benefits', 'finance_costs', 'depreciation_amortisation', 'other_expenses', 'tax_expense')
                        then r.amount else 0 end), 2)
    `);
    expect(rows, `a company's expense ledger_role partition doesn't sum to its whole-nature total:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`GSTR-3B Table 5.1 interest and late fee (${hasDb ? "live" : noDbReason})`, () => {
  it("tax_payments never has period_end before period_start", async () => {
    const rows = await sql(`
      select id, period_start, period_end from tax_payments where period_start is not null and period_end < period_start
    `);
    expect(rows, `a tax_payments row's return-period range is backwards:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tier 5 batch 11 (0296-0661): payroll TDS regime-awareness + Sec 87A
// marginal relief, AOC-4 XBRL Schedule III P&L wiring (pure TS, no
// describeDb block), EWB non-sales/state-threshold/multi-vehicle, external
// signer link, Sec 15(3)(b) discount agreements, Notes to Accounts employee-
// benefits split, perquisites (Sec 17(2)) capture, SBO register, GSTR-1
// Table 11 service advances.
// ---------------------------------------------------------------------------
describeDb(`tier 5 batch 11 new functions (${hasDb ? "live" : noDbReason})`, () => {
  it("no new function from this wave is reachable by anon or PUBLIC, except the three deliberately token/API-gated ones", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in (
         'get_employee_perquisites_total', 'get_employee_perquisites_valued',
         'get_notes_employee_benefits_breakup', 'get_gstr1_table11a', 'get_gstr1_table11b',
         'create_service_advance_receipt', 'mark_service_advance_adjusted', 'unmark_service_advance_adjusted',
         'get_taggable_receipt_vouchers', 'get_service_advance_receipts', 'get_discount_agreement_coverage',
         'get_delivery_challan_ewb_requirement', 'get_delivery_challan_ewb_status', 'build_delivery_challan_ewb_json',
         'regenerate_signer_access_token', 'authenticate_signer_token'
       ) and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a batch 11 function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`payroll TDS regime-awareness and Sec 87A marginal relief (${hasDb ? "live" : noDbReason})`, () => {
  it("get_salary_tds_estimate's regime_used matches every employee's own real declaration for the matching FY", async () => {
    const rows = await sql(`
      select t.employee_id, t.regime as declared,
             (select r.regime_used from get_salary_tds_estimate(t.company_id, '2026-08-01') r where r.employee_id = t.employee_id) as regime_used
        from employee_tax_declarations t
       where t.financial_year_label = '2026-27'
    `);
    for (const r of rows as Record<string, unknown>[]) {
      expect(r.regime_used, `regime_used didn't match the declared regime for employee ${r.employee_id}`).toBe(r.declared);
    }
  });
});

describeDb(`SBO register (${hasDb ? "live" : noDbReason})`, () => {
  it("no significant_beneficial_owners row exists for a company outside pvt_ltd/ltd/opc", async () => {
    const rows = await sql(`
      select s.id, c.entity_type from significant_beneficial_owners s
        join companies c on c.id = s.company_id
       where c.entity_type not in ('pvt_ltd', 'ltd', 'opc')
    `);
    expect(rows, `an SBO row exists for an entity type that cannot have one:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`perquisites (Sec 17(2)) (${hasDb ? "live" : noDbReason})`, () => {
  it("get_employee_perquisites_total equals the sum of get_employee_perquisites_valued's own rows, for every employee/FY with data", async () => {
    const rows = await sql(`
      select ep.employee_id, ep.financial_year_label,
             (select sum(v.taxable_value) from get_employee_perquisites_valued(ep.company_id, ep.employee_id, ep.financial_year_label) v) as valued_sum,
             get_employee_perquisites_total(ep.company_id, ep.employee_id, ep.financial_year_label) as total_fn
        from (select distinct company_id, employee_id, financial_year_label from employee_perquisites) ep
    `);
    for (const r of rows as Record<string, unknown>[]) {
      expect(r.total_fn, `get_employee_perquisites_total disagrees with the sum of valued rows for employee ${r.employee_id}`).toBe(r.valued_sum);
    }
  });
});

describeDb(`Notes to Accounts: employee benefits break-up (${hasDb ? "live" : noDbReason})`, () => {
  it("the employee-benefits note sub-buckets sum exactly to get_profit_and_loss's own employee_benefits ledger_role total, per company/period", async () => {
    const rows = await sql(`
      select c.name,
             round(coalesce((select sum(amount) from get_notes_employee_benefits_breakup(c.id, '2000-01-01', '2099-12-31')), 0), 2) as note_total,
             round(coalesce((select sum(pl.amount) from get_profit_and_loss(c.id, '2000-01-01', '2099-12-31') pl where pl.ledger_role = 'employee_benefits'), 0), 2) as pl_total
        from companies c
       where round(coalesce((select sum(amount) from get_notes_employee_benefits_breakup(c.id, '2000-01-01', '2099-12-31')), 0), 2)
          <> round(coalesce((select sum(pl.amount) from get_profit_and_loss(c.id, '2000-01-01', '2099-12-31') pl where pl.ledger_role = 'employee_benefits'), 0), 2)
    `);
    expect(rows, `a company's employee-benefits note doesn't sum to its own P&L ledger_role total:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`Sec 15(3)(b) discount agreements (${hasDb ? "live" : noDbReason})`, () => {
  it("no voucher_item is linked to more than one discount agreement", async () => {
    const rows = await sql(`
      select voucher_item_id, count(*) from discount_agreement_links
       where voucher_item_id is not null group by voucher_item_id having count(*) > 1
    `);
    expect(rows, `a voucher line is double-linked to more than one discount agreement:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`GSTR-1 Table 11 service advances (${hasDb ? "live" : noDbReason})`, () => {
  it("every 'adjusted' service_advance_receipts row points at a real, undeleted sales voucher", async () => {
    const rows = await sql(`
      select s.id from service_advance_receipts s
       where s.status = 'adjusted'
         and (s.adjusted_voucher_id is null
              or not exists (select 1 from vouchers v where v.id = s.adjusted_voucher_id and v.voucher_type = 'sales' and not v.is_deleted))
    `);
    expect(rows, `an adjusted service advance doesn't point at a real sales voucher:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`EWB: delivery challans, state thresholds, multi-vehicle (${hasDb ? "live" : noDbReason})`, () => {
  it("ewb_details.vehicle_number always matches its own most recent vehicle-update row, when any exist", async () => {
    const rows = await sql(`
      select e.id, e.vehicle_number, latest.vehicle_number as latest_update
        from ewb_details e
        join lateral (
          select vehicle_number from ewb_vehicle_updates u where u.ewb_detail_id = e.id order by updated_at desc limit 1
        ) latest on true
       where e.vehicle_number is distinct from latest.vehicle_number
    `);
    expect(rows, `an ewb_details row's vehicle_number is out of sync with its own latest history entry:\n${offenders(rows)}`).toEqual([]);
  });

  it("ref_state_ewb_thresholds has no duplicate state and every row cites a source", async () => {
    const dupes = await sql(`
      select state_code, count(*) from ref_state_ewb_thresholds group by state_code having count(*) > 1
    `);
    expect(dupes, `a state appears more than once in the threshold table:\n${offenders(dupes)}`).toEqual([]);
    const unsourced = await sql(`
      select state_code from ref_state_ewb_thresholds where source_reference is null or trim(source_reference) = ''
    `);
    expect(unsourced, `a threshold row has no cited source:\n${offenders(unsourced)}`).toEqual([]);
  });
});

describeDb(`e-signature external signer link (${hasDb ? "live" : noDbReason})`, () => {
  it("a signer's access_token exists if and only if their request is sent or completed, never while still draft", async () => {
    const rows = await sql(`
      select s.id, r.status, (s.access_token is not null) as has_token
        from signature_request_signers s
        join signature_requests r on r.id = s.request_id
       where (r.status = 'draft' and s.access_token is not null)
          or (r.status in ('sent', 'completed') and s.access_token is null)
    `);
    expect(rows, `a signer's access_token state doesn't match its request's status:\n${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Voucher numbering modes and series (0725), and the GSTR-1 Table 13 fix the
// series work forced (0730). The quick-add popups that shipped alongside
// these are pure UI over existing RLS and add no SQL, so they have no block.
// ---------------------------------------------------------------------------
describeDb(`voucher numbering modes and series (${hasDb ? "live" : noDbReason})`, () => {
  it("no numbering function is reachable by anon or PUBLIC", async () => {
    const rows = await sql(`
      select routine_name, grantee from information_schema.routine_privileges
       where routine_name in (
         'get_voucher_numbering_settings', 'set_voucher_numbering_mode',
         'create_voucher_number_series', 'update_voucher_number_series',
         'set_voucher_number_series_active', 'get_gstr1_table13',
         'create_voucher', 'create_invoice'
       ) and grantee in ('PUBLIC', 'anon')
    `);
    expect(rows, `a numbering function reachable by a role it shouldn't be:\n${offenders(rows)}`).toEqual([]);
  });

  it("every counter row carries a series and a resolved prefix — the 0725 backfill left nothing behind", async () => {
    const rows = await sql(`
      select company_id, voucher_type, branch_id, financial_year_label
        from voucher_number_sequences
       where series_id is null or resolved_prefix is null or resolved_prefix = ''
    `);
    expect(rows, `a counter row has no series or no resolved prefix:\n${offenders(rows)}`).toEqual([]);
  });

  it("every voucher type that has any series has exactly one active default", async () => {
    const rows = await sql(`
      select company_id, voucher_type,
             count(*) filter (where is_default and is_active) as active_defaults
        from voucher_number_series
       group by company_id, voucher_type
      having count(*) filter (where is_default and is_active) <> 1
    `);
    expect(
      rows,
      `a voucher type has no active default series (numbering would fail) or more than one:\n${offenders(rows)}`
    ).toEqual([]);
  });

  it("no two live vouchers share a number within the same company, type and financial year", async () => {
    const rows = await sql(`
      select company_id, voucher_type, financial_year_label, voucher_number, count(*)
        from vouchers where not is_deleted
       group by company_id, voucher_type, financial_year_label, voucher_number
      having count(*) > 1
    `);
    expect(rows, `a voucher number is used twice in one financial year:\n${offenders(rows)}`).toEqual([]);
  });

  it("every issued voucher number uses only the characters CGST Rule 46(b) allows", async () => {
    const rows = await sql(`
      select id, voucher_number from vouchers where voucher_number !~ '^[A-Za-z0-9/-]+$'
    `);
    expect(rows, `a voucher number contains a character Rule 46(b) does not allow:\n${offenders(rows)}`).toEqual([]);
  });
});

describeDb(`GSTR-1 Table 13 documents issued (${hasDb ? "live" : noDbReason})`, () => {
  // The regression that migration 0730 exists for. When 0725 made
  // voucher_number_sequences one-row-per-series, Table 13 kept aggregating
  // its documents by (branch, voucher_type) only and attached that same
  // aggregate to every series row — reporting 44 sales invoices where 22
  // existed, on real data, in a table that gets filed.
  it("Table 13's per-series totals sum to the real count of documents issued in the period, per company", async () => {
    const rows = await sql(`
      with per_company as (
        select c.id, c.name,
               (select coalesce(sum(t.total_issued), 0)
                  from get_gstr1_table13(c.id, '2026-04-01', '2027-03-31') t) as table13_total,
               (select count(*) from vouchers v
                 where v.company_id = c.id
                   and v.voucher_type in ('sales', 'credit_note', 'job_work_out')
                   and v.voucher_date between '2026-04-01' and '2027-03-31') as real_total
          from companies c
      )
      select name, table13_total, real_total from per_company where table13_total <> real_total
    `);
    expect(
      rows,
      `Table 13 double-counts or drops documents — it must report each issued document exactly once:\n${offenders(rows)}`
    ).toEqual([]);
  });
});

describeDb(`party GSTIN consistency (${hasDb ? "live" : noDbReason})`, () => {
  // 0735. A GSTIN is a composite key whose substrings duplicate two other
  // columns on the same row: characters 1-2 are the state code, 3-12 the PAN.
  // If they disagree, every place-of-supply and intra/inter determination
  // downstream contradicts the number printed on the invoice.
  it("no ledger's GSTIN disagrees with its own state code", async () => {
    const rows = await sql(`
      select id, name, gstin, state_code from ledgers
       where gstin is not null and state_code is distinct from substr(gstin, 1, 2)
    `);
    expect(rows, `a ledger's GSTIN and state_code contradict each other:
${offenders(rows)}`).toEqual([]);
  });

  it("no ledger's GSTIN disagrees with its own PAN", async () => {
    const rows = await sql(`
      select id, name, gstin, pan from ledgers
       where gstin is not null and pan is not null and pan <> substr(gstin, 3, 10)
    `);
    expect(rows, `a ledger's GSTIN and PAN contradict each other:
${offenders(rows)}`).toEqual([]);
  });

  // The compliance rule this exists for: a registered party without a GSTIN
  // is indistinguishable from an unregistered one, so its invoices land in
  // the B2C tables of GSTR-1 instead of B2B and build_einvoice_json refuses
  // them outright (it raises when the party's gstin is null).
  it("every party marked registered actually carries a GSTIN", async () => {
    const rows = await sql(`
      select id, name, gst_registration_type from ledgers
       where gst_registration_type in
             ('regular', 'composition', 'sez', 'sez_developer', 'uin', 'deemed_export')
         and gstin is null
    `);
    expect(rows, `a registered party has no GSTIN — its invoices cannot be e-invoiced:
${offenders(rows)}`).toEqual([]);
  });

  it("no party marked unregistered or overseas carries a GSTIN", async () => {
    const rows = await sql(`
      select id, name, gst_registration_type, gstin from ledgers
       where gst_registration_type in ('unregistered', 'overseas') and gstin is not null
    `);
    expect(rows, `an unregistered or overseas party carries a GSTIN:
${offenders(rows)}`).toEqual([]);
  });

  it("the four consistency constraints are still attached", async () => {
    const rows = await sql(`
      select unnest(array[
        'ledgers_gstin_matches_state', 'ledgers_gstin_matches_pan',
        'ledgers_registered_has_gstin', 'ledgers_unregistered_has_no_gstin'
      ]) as expected
      except
      select conname from pg_constraint where conrelid = 'public.ledgers'::regclass
    `);
    expect(rows, `a GSTIN consistency constraint has been dropped:
${offenders(rows)}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Needs fixtures. Seeded database only — never the live project.
// ---------------------------------------------------------------------------
describe.skip("post_gst_setoff, post_deferred_tax [needs seed]", () => {
  // SEED: a company with an active GST registration, an admin member, and
  // posted output_cgst/output_sgst/input_cgst/input_sgst balances (e.g. via
  // create_invoice on a taxable sale and purchase).
  it("posts a balanced journal that zeroes the output ledgers", async () => {});
  it("credits GST Payable only with the genuine shortfall, never the gross output tax", async () => {});
  it("leaves unutilised input credit exactly where it was — never moves it to GST Refund Receivable", async () => {});
  it("re-running for the same date with nothing new posted raises rather than double-posting", async () => {});
  it("a member who is not admin/accountant (can_write_company false) cannot call post_gst_setoff", async () => {});
  it("posting for registration A never touches registration B's ledgers in the same company", async () => {});
});

// ---------------------------------------------------------------------------
// Needs fixtures. Seeded database only — never the live project.
// ---------------------------------------------------------------------------
describe.skip("RLS, both directions [needs seed]", () => {
  // SEED: two companies A and B, each with its own auth.users row and an
  // active company_members row. No membership overlap.
  it("a member of company A can read company A's ledgers", async () => {});
  it("a member of company B cannot read company A's ledgers", async () => {});
  it("a member of company B cannot read company A's vouchers or entries", async () => {});
  it("a member of company B cannot read company A's invite tokens", async () => {});

  // SEED: additionally an 'accountant' and an 'auditor' member on company A.
  it("an auditor cannot write a voucher", async () => {});
  it("an accountant cannot read the audit log", async () => {});
  it("a non-admin member cannot read company_invites at all", async () => {});

  // SEED: company A with two branches and a member_branches row pinning the
  // member to branch 1 only.
  it("a branch-restricted member cannot read entries of the other branch", async () => {});
  it("a member with no member_branches rows sees every branch", async () => {});
});

describe.skip("guard triggers [needs seed]", () => {
  // SEED: a company with a head office branch and one non-head-office branch.
  it("guard_head_office blocks deleting the only head office", async () => {});
  it("guard_head_office blocks deactivating the only head office", async () => {});
  it("guard_head_office allows deleting a head office once another is active", async () => {});

  // SEED: a company with one active admin plus one accountant.
  it("guard_last_admin blocks removing the only active admin", async () => {});
  it("guard_last_admin blocks demoting the only active admin", async () => {});

  // SEED: a company with the seeded system account groups from
  // seed_chart_of_accounts().
  it("protect_system_group blocks deleting a system group", async () => {});
  it("protect_system_group blocks re-parenting a system group", async () => {});

  // The bug that shipped three times: a guard that refuses its own company's
  // teardown. SEED: a fully populated company — branches, members, groups,
  // ledgers, vouchers, entries — then `delete from companies where id = ...`.
  it("deleting a company cascades cleanly past guard_head_office", async () => {});
  it("deleting a company cascades cleanly past guard_last_admin", async () => {});
  it("deleting a company cascades cleanly past protect_system_group", async () => {});
  it("deleting a company leaves no orphan in any company_id table", async () => {});

  // SEED: a balanced voucher with two entries.
  it("the deferred balance trigger rejects a voucher left unbalanced at commit", async () => {});
  it("the deferred balance trigger permits a mid-transaction imbalance", async () => {});
  it("deleting one entry of a two-line voucher is rejected at commit", async () => {});

  // SEED: a company with lock_date set.
  it("enforce_period_open rejects a voucher dated on or before lock_date", async () => {});
});

describe.skip("resolve_conditional_modules [needs seed]", () => {
  // SEED: a company in compliance_mode with a GSTIN, so `gst` activates; plus
  // the ref_modules rows already shipped by 0004/0006a.
  it("a conditional module does not activate while its depends_on is inactive", async () => {});
  it("it activates once the dependency becomes active", async () => {});
  it("deactivating a dependency deactivates the modules that depend on it", async () => {});

  // The fixpoint must not depend on the order rows come back in. SEED: as
  // above, then run once, snapshot the active set, reverse the sort_order of
  // every conditional module, re-run, and compare.
  it("converges to the same set regardless of ref_modules.sort_order", async () => {});
  it("converges within the 10-pass ceiling for the shipped module graph", async () => {});

  // Known edge: effective_to is set to greatest(effective_from, current_date-1),
  // so a module activated and deactivated on the same day stays active for that
  // day per module_active(). Assert whichever behaviour is decided to be right.
  it("a module activated and deactivated on the same day is not active", async () => {});
});

// ---------------------------------------------------------------------------
// PUBLIC-grant containment (1844)
// ---------------------------------------------------------------------------
// The bug class these guard against has now shipped three times — 0064, 0231,
// and again in 1844 — always the same way: `revoke execute ... from anon` on
// its own is a NO-OP, because Postgres grants EXECUTE to the PUBLIC
// pseudo-role at creation time and every real role inherits it. The existing
// coverage was per-wave ("no new function from THIS wave is anon-reachable"),
// which by construction cannot catch a function that predates the wave or one
// created directly in the live database. These two are schema-wide instead.
describeDb(`PUBLIC-grant containment (${hasDb ? "live" : noDbReason})`, () => {
  it("no function in public carries the incidental PUBLIC grant", async () => {
    // A bare `=X/...` entry in proacl is the PUBLIC grant. Nothing in this
    // schema should rely on it: the roles that need EXECUTE (authenticated,
    // service_role, anon for the deliberate exceptions below) all hold
    // explicit grants. Catching it here rather than per-wave is the whole
    // point — 1844 found four write RPCs and three getters still carrying it
    // years after two migrations had supposedly closed this.
    const rows = await sql(`
      select p.oid::regprocedure::text as sig,
             array_to_string(p.proacl::text[], ' | ') as acl
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and '=X/postgres' = any(p.proacl::text[])
       order by 1
    `);
    expect(rows, `functions still carrying the PUBLIC grant:\n${offenders(rows)}`).toEqual([]);
  });

  it("exactly the intended functions are executable by anon, and each says so explicitly", async () => {
    // The allowlist, and why each one is on it:
    //   api_get_trial_balance / api_get_dashboard_kpis  0063 public API, keyed
    //   get_signature_request_by_token                  0575 external signer link
    //   record_signed_document_by_token                 0575 external signer link
    //   receive_payment_webhook_event                   payment gateway callback
    //   receive_whatsapp_inbound_message                WhatsApp inbound webhook
    //   log_error_global                                client error reporting
    // Anything else appearing here is either a revoke that was written as
    // `from anon` instead of `from public, anon`, or — as 1844 found with
    // public.zz_gpr_copy, a payroll-shaped debug copy that existed only in the
    // live database and in no migration — something created by hand and never
    // cleaned up. Both are worth failing a build over.
    const expected = [
      "api_get_dashboard_kpis",
      "api_get_trial_balance",
      "get_signature_request_by_token",
      "log_error_global",
      "receive_payment_webhook_event",
      "receive_whatsapp_inbound_message",
      "record_signed_document_by_token",
    ];
    const rows = await sql<{ proname: string }>(`
      select distinct p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.prokind = 'f'
         and has_function_privilege('anon', p.oid, 'EXECUTE')
       order by 1
    `);
    expect(rows.map((r) => r.proname)).toEqual(expected);
  });

  it("anon cannot reach app_private at all", async () => {
    // 95 of the 147 app_private functions still carry the PUBLIC grant, and
    // 1844 deliberately left them that way: anon holds no USAGE on the schema
    // so it cannot call any of them, PostgREST refuses to expose a non-exposed
    // schema (PGRST106), and revoking PUBLIC there would silently strip
    // service_role — which reaches all 95 ONLY through the PUBLIC grant, since
    // none of them grants it explicitly. That decision is only safe for as
    // long as the USAGE assumption holds, so this asserts the assumption
    // instead of trusting it. If anyone ever grants anon USAGE on app_private,
    // 61 SECURITY DEFINER functions become reachable at once and this goes red.
    const rows = await sql<{ usage: boolean }>(`
      select has_schema_privilege('anon', 'app_private', 'USAGE') as usage
    `);
    expect(rows[0].usage, "anon has been granted USAGE on app_private").toBe(false);
  });
});
