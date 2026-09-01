/**
 * The close must not depend on what anybody named a ledger, and the balance
 * sheet must agree with the subledger behind it.
 *
 * WHY THIS FILE EXISTS. A pilot company closed its first month reporting a
 * profit of 4,11,788.02 when it had lost 5,72,211.98 — a swing of exactly
 * 9,84,000.00, its opening stock, counted twice. post_closing_stock located
 * the inventory ledger by matching the literal string 'Stock-in-Hand'; the
 * preparer had called theirs 'Stock in Hand', so a second ledger was created
 * and the whole closing valuation went into it.
 *
 * Nothing caught it. The balance sheet balanced, the P&L agreed with it, and
 * the cash flow reconciliation still read nil — they agreed on the wrong
 * number. Every check in the system was a SELF-consistency check, and
 * self-consistency is exactly what this class of bug preserves.
 *
 * So there are two assertions here, and the second is the important one:
 *
 *   1. no function may bind one of these ledgers by its English name
 *      (structural — catches the bug being reintroduced, in any function,
 *      including ones that do not exist yet)
 *
 *   2. balance-sheet inventory must equal the stock summary
 *      (a control-versus-subsidiary check, and the ONLY control account the
 *      app never checked. This one assertion would have caught the entire
 *      incident.)
 *
 * Both are read-only and safe to point at the live project.
 */
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, hasDb, noDbReason, sql } from "../helpers/db";

afterAll(closeDb);

const describeDb = describe.skipIf(!hasDb);

function offenders(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

describeDb(`close postings bind by role (${hasDb ? "live" : noDbReason})`, () => {
  /**
   * The three exceptions are deliberate and each is safe for a different
   * reason:
   *
   *   seed_chart_of_accounts       names GROUPS. The app creates those itself
   *                                and a preparer never types them, so the
   *                                string genuinely is reliable there.
   *   ensure_stock_ledgers,        name a LEDGER only when creating one that
   *   ensure_depreciation_ledgers  does not exist. A default name for a new
   *                                row is not a lookup key; both now find
   *                                existing ledgers via ledger_for_role.
   */
  it("no function looks a close ledger up by its English name", async () => {
    const rows = await sql<{ fn: string }>(`
      select n.nspname || '.' || p.proname as fn
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'app_private')
         and p.prokind = 'f'
         and p.proname not in (
           'seed_chart_of_accounts', 'ensure_stock_ledgers', 'ensure_depreciation_ledgers'
         )
         and pg_get_functiondef(p.oid) ~
             '(l?\\.?name = ''(Stock-in-Hand|Changes in Inventories|Depreciation|Accumulated Depreciation)''|ledger_name (=|<>) ''(Depreciation|Accumulated Depreciation)'')'
       order by 1`);

    expect(
      rows,
      `These bind a close ledger by name. Use app_private.ledger_for_role instead — ` +
        `a preparer chooses these names and the chart of accounts seeds none of them:\n${offenders(rows)}`
    ).toEqual([]);
  });

  it("no company has two ledgers competing for the same close role", async () => {
    const rows = await sql<{ company: string; role: string; ledgers: string }>(`
      select c.name as company,
             coalesce(l.ledger_role, g.ledger_role) as role,
             string_agg(l.name, ' | ' order by l.name) as ledgers
        from public.ledgers l
        join public.account_groups g on g.id = l.group_id
        join public.companies c on c.id = l.company_id
       where coalesce(l.ledger_role, g.ledger_role) in (
               'stock', 'changes_in_inventories',
               'depreciation_amortisation', 'accumulated_depreciation'
             )
       group by c.name, coalesce(l.ledger_role, g.ledger_role)
      having count(*) > 1
       order by 1, 2`);

    expect(
      rows,
      `A duplicate makes every close posting for that company refuse. Keep the one ` +
        `holding the bookkeeping and re-group or delete the other:\n${offenders(rows)}`
    ).toEqual([]);
  });
});

describeDb(`inventory agrees with its subledger (${hasDb ? "live" : noDbReason})`, () => {
  /**
   * The control-versus-subsidiary check the app never had.
   *
   * Deliberately only asserted for companies that have actually posted closing
   * stock. Before that posting the ledger legitimately carries the opening
   * balance while the valuation has moved on — that gap is the whole point of
   * the closing-stock screen, not an error. Checking every company would fail
   * loudly on correct books and teach everyone to ignore this test.
   */
  it("balance-sheet inventory equals the stock summary, wherever closing stock was posted", async () => {
    const rows = await sql<
      {
        company: string;
        as_at: string;
        balance_sheet: string;
        stock_summary: string;
        difference: string;
      }
    >(`
      with posted as (
        -- The latest closing-stock journal per company, found by the ledger it
        -- touches rather than by narration text.
        select distinct on (v.company_id)
               v.company_id, v.voucher_date as as_at
          from public.vouchers v
          join public.voucher_entries e on e.voucher_id = v.id
          join public.ledgers l on l.id = e.ledger_id
          join public.account_groups g on g.id = l.group_id
         where not v.is_deleted
           and v.voucher_type = 'journal'
           and coalesce(l.ledger_role, g.ledger_role) = 'stock'
         order by v.company_id, v.voucher_date desc
      )
      select c.name as company,
             p.as_at::text,
             round(bs.amount, 2)::text as balance_sheet,
             round(ss.value, 2)::text as stock_summary,
             round(bs.amount - ss.value, 2)::text as difference
        from posted p
        join public.companies c on c.id = p.company_id
        cross join lateral (
          select coalesce(sum(b.amount), 0) as amount
            from public.get_balance_sheet(p.company_id, p.as_at, null) b
           where b.ledger_role = 'stock'
        ) bs
        cross join lateral (
          select coalesce(sum(s.closing_value), 0) as value
            from public.get_stock_summary(p.company_id, p.as_at, null) s
        ) ss
       where round(bs.amount - ss.value, 2) <> 0
       order by 1`);

    expect(
      rows,
      `Inventory on the balance sheet disagrees with the stock it is supposed to ` +
        `represent. Both statements can still balance while this is wrong — that is ` +
        `exactly how a 9,84,000 error once turned a loss into a profit:\n${offenders(rows)}`
    ).toEqual([]);
  });
});
