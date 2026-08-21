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
