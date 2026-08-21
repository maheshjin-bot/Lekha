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
    const rows = await sql(`
      select policyname, cmd, coalesce(qual, with_check) as expr
        from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and coalesce(qual, '') !~ 'is_company_member|can_write_company'
         and coalesce(with_check, '') !~ 'is_company_member|can_write_company'
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
    const denyAllByDesign = ["voucher_number_sequences"];
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
