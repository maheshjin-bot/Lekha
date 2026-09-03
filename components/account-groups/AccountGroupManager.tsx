"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Chart of accounts — the screen that lets a company add a group to it.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * A pilot traded a brand-new company for a month and could not add a single
 * account group, because no screen anywhere created one. `seed_chart_of_accounts`
 * lays down eight primary groups and about twenty-five sub-groups when the
 * company is created, and that was the chart, for ever. Freight outward, godown
 * rent and packing material all had to be ledgers hanging directly off
 * "Indirect Expenses", and the statement of profit and loss then shows one line
 * with all of it in it.
 *
 * ============================================================================
 * WHY THE FORM IS THIS NARROW
 * ============================================================================
 * account_groups carries the three columns that decide where money lands in the
 * financial statements — nature (which statement, which side), normal_balance,
 * and ledger_role (the Schedule III sub-head, and since migration 1200 the key
 * the close postings use to FIND a ledger). A group created with the wrong
 * nature does not produce an error; it produces a balance sheet that still
 * balances and a profit figure that is wrong.
 *
 * So the only three things this form asks for are a NAME, a PARENT, and a ROLE:
 *
 *   nature          never asked. app_private.enforce_account_group_nature
 *                   (0006) forces a child's nature to its parent's, so
 *                   choosing the parent IS choosing the classification, and
 *                   there is no way to get it wrong.
 *   normal_balance  never asked. Migration 1470 ties it to nature in the
 *                   database; whatever this form sends is corrected.
 *   statement       cannot be asked. It is a GENERATED ALWAYS column.
 *   ledger_role     asked, but from a fixed list per nature — see ROLES below.
 *
 * The parent list is deliberately the PRIMARY groups only. The seeded chart is
 * two levels deep and every report reads a ledger's own group, so nesting
 * deeper would buy nothing and make the group picker on the Ledgers screen —
 * which indents exactly one level — lie about the shape of the chart.
 *
 * ============================================================================
 * WHAT IS NOT HERE, AND WHY
 * ============================================================================
 * No rename, no delete, no reclassify. Three live report functions —
 * get_sec269ss_loan_receipts, get_sec269t_loan_repayments and
 * get_sec40a3_cash_payments — still find the cash group by the literal string
 * 'Cash-in-Hand'. Renaming a seeded group would silently empty those reports,
 * which is precisely the failure 1200 was written about. Until those bind by
 * role, a rename control here would be a loaded gun. System groups are refused
 * by app_private.protect_system_group (0006) in any case.
 */

type Group = {
  id: string;
  name: string;
  nature: string;
  normal_balance: string;
  ledger_role: string;
  parent_group_id: string | null;
  is_system: boolean;
  sort_order: number;
};

/**
 * The roles this screen offers, per nature.
 *
 * A SUBSET of what app_private.account_group_roles_for_nature (1470) will
 * accept, and deliberately so. Four roles are withheld from every list here
 * because app_private.ledger_for_role (1200, message improved in 1220) RAISES
 * when a company has more than one ledger carrying them — post_closing_stock
 * and post_depreciation must bind to exactly one:
 *
 *   stock, changes_in_inventories, depreciation_amortisation,
 *   accumulated_depreciation
 *
 * Offering "Stock-in-Hand" in a dropdown means offering a second stock group,
 * which means a second stock ledger, which means a year-end close that refuses
 * to run with "This company has more than one stock ledger". The seed already
 * creates exactly one of each; nothing here should create the second.
 *
 * 'tax_expense' is withheld too. Schedule III shows tax BELOW profit before
 * tax, not inside Total Expenses, so a group carrying it silently removes real
 * expenditure from Total Expenses. ensure_deferred_tax_ledgers already creates
 * the one ledger that legitimately needs it.
 */
const ROLES: Record<string, string[]> = {
  capital: ["capital"],
  share_capital: ["capital"],
  reserves_surplus: ["capital"],
  current_asset: ["other", "cash_bank", "debtor", "loan", "investment"],
  current_liability: ["other", "creditor", "duty_tax", "provision", "loan"],
  non_current_liability: ["other", "loan", "provision"],
  long_term_borrowing: ["other", "loan"],
  long_term_provision: ["other", "provision"],
  deferred_tax: ["other"],
  fixed_asset: [
    "tangible_fixed_asset",
    "intangible_fixed_asset",
    "capital_work_in_progress",
    "investment",
  ],
  direct_expense: ["other_expenses", "cost_of_materials", "purchases_stock_in_trade"],
  direct_income: ["income"],
  indirect_expense: ["other_expenses", "employee_benefits", "finance_costs"],
  indirect_income: ["income"],
};

// What each role means in the statements, said in the preparer's terms rather
// than the column's.
const ROLE_LABEL: Record<string, string> = {
  other: "No special treatment",
  cash_bank: "Cash or bank — counted as cash in the cash flow statement",
  debtor: "Receivables — appears in ageing and outstanding reports",
  creditor: "Payables — appears in ageing, MSME and ITC-reversal reports",
  duty_tax: "A tax control account",
  provision: "A provision",
  loan: "A loan or advance",
  investment: "An investment — investing activity in the cash flow statement",
  capital: "Owners' funds",
  tangible_fixed_asset: "Tangible fixed asset (Schedule III)",
  intangible_fixed_asset: "Intangible asset (Schedule III)",
  capital_work_in_progress: "Capital work-in-progress (Schedule III)",
  income: "Revenue",
  other_expenses: "Other expenses (Schedule III)",
  cost_of_materials: "Cost of materials consumed (Schedule III)",
  purchases_stock_in_trade: "Purchases of stock-in-trade (Schedule III)",
  employee_benefits: "Employee benefits expense (Schedule III)",
  finance_costs: "Finance costs (Schedule III)",
};

const NATURE_LABEL: Record<string, string> = {
  capital: "Capital",
  share_capital: "Share capital",
  reserves_surplus: "Reserves and surplus",
  current_asset: "Current asset",
  current_liability: "Current liability",
  non_current_liability: "Non-current liability",
  long_term_borrowing: "Long-term borrowing",
  long_term_provision: "Long-term provision",
  deferred_tax: "Deferred tax",
  fixed_asset: "Fixed asset",
  direct_expense: "Direct expense",
  direct_income: "Direct income",
  indirect_expense: "Indirect expense",
  indirect_income: "Indirect income",
};

const STATEMENT_LABEL: Record<string, string> = {
  balance_sheet: "Balance sheet",
  trading: "Trading account",
  profit_loss: "Profit & loss",
};

const statementFor = (nature: string) =>
  nature === "direct_income" || nature === "direct_expense"
    ? "trading"
    : nature === "indirect_income" || nature === "indirect_expense"
      ? "profit_loss"
      : "balance_sheet";

export function AccountGroupManager({
  companyId,
  groups,
  ledgerCounts,
}: {
  companyId: string;
  groups: Group[];
  /** group_id -> number of ledgers filed under it. */
  ledgerCounts: Record<string, number>;
}) {
  const router = useRouter();

  const primaries = groups
    .filter((g) => !g.parent_group_id)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  const [parentId, setParentId] = useState(primaries[0]?.id ?? "");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parent = groups.find((g) => g.id === parentId);
  const roleOptions = parent ? (ROLES[parent.nature] ?? ["other"]) : ["other"];
  // The parent's own role is the sensible default whenever it is on offer —
  // "a sub-group of Indirect Expenses is another kind of other expense" is
  // right far more often than it is wrong.
  const effectiveRole =
    role && roleOptions.includes(role)
      ? role
      : parent && roleOptions.includes(parent.ledger_role)
        ? parent.ledger_role
        : roleOptions[0];

  const trimmed = name.trim();
  // Advisory, not a constraint: the database's unique index is per parent, and
  // some seeded charts legitimately carry the same name at two levels (every
  // company has both a "Share Capital" primary group and a "Share Capital"
  // child under Non-current Liabilities). What this catches is the case that
  // actually bites — a second group called 'Cash-in-Hand', which would widen
  // the literal-name match in get_sec269ss_loan_receipts and its two siblings.
  const nameClash =
    trimmed.length > 0 &&
    groups.some((g) => g.name.trim().toLowerCase() === trimmed.toLowerCase());

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!parent) return;
    setBusy(true);
    setError(null);

    const siblingMax = groups
      .filter((g) => g.parent_group_id === parent.id)
      .reduce((m, g) => Math.max(m, g.sort_order), 0);

    const { error: insertError } = await createClient()
      .from("account_groups")
      .insert({
        company_id: companyId,
        parent_group_id: parent.id,
        name: trimmed,
        // Both of these are overwritten by the database — nature by
        // enforce_account_group_nature (0006), normal_balance by
        // enforce_account_group_presentation (1470). Sending the parent's own
        // values means the row is already right before either trigger runs,
        // and the columns are NOT NULL with no default, so something has to be
        // sent. `statement` is generated and must NOT be sent.
        nature: parent.nature,
        normal_balance: parent.normal_balance,
        ledger_role: effectiveRole,
        sort_order: Math.min(siblingMax + 1, 32767),
        is_system: false,
      });

    if (insertError) {
      setError(
        insertError.code === "23505"
          ? `"${trimmed}" already exists under ${parent.name}.`
          : insertError.message
      );
      setBusy(false);
      return;
    }

    setName("");
    setRole("");
    setBusy(false);
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_340px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Group</th>
                <th className="px-4 py-2.5 font-medium">Appears in</th>
                <th className="px-4 py-2.5 font-medium">Treated as</th>
                <th className="px-4 py-2.5 text-right font-medium">Ledgers</th>
              </tr>
            </thead>
            <tbody>
              {primaries.map((p) => {
                const children = groups
                  .filter((g) => g.parent_group_id === p.id)
                  .sort(
                    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
                  );
                return [
                  <tr key={p.id} className="border-b border-border bg-surface-2/40">
                    <td className="px-4 py-2.5 font-semibold">
                      {p.name}
                      {p.is_system && (
                        <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                          system
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-ink-soft">
                      {STATEMENT_LABEL[statementFor(p.nature)]}
                      <span className="ml-1.5 text-xs text-ink-faint">
                        {NATURE_LABEL[p.nature] ?? p.nature} ·{" "}
                        {p.normal_balance === "debit" ? "Dr" : "Cr"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-soft">
                      {ROLE_LABEL[p.ledger_role] ?? p.ledger_role}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">
                      {ledgerCounts[p.id] ?? 0}
                    </td>
                  </tr>,
                  ...children.map((c) => (
                    <tr key={c.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 pl-8 text-ink">
                        {c.name}
                        {c.is_system && (
                          <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                            system
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-ink-faint">
                        {NATURE_LABEL[c.nature] ?? c.nature} ·{" "}
                        {c.normal_balance === "debit" ? "Dr" : "Cr"}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-ink-soft">
                        {ROLE_LABEL[c.ledger_role] ?? c.ledger_role}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-ink-soft">
                        {ledgerCounts[c.id] ?? 0}
                      </td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">New group</h2>
        <p className="mt-1 text-xs text-ink-faint">
          A new group always sits under one of the primary groups above and is
          classified exactly as that parent is. That is what stops a new group
          moving money between the balance sheet and the profit &amp; loss.
        </p>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Under</span>
            <select
              value={parentId}
              onChange={(e) => {
                setParentId(e.target.value);
                setRole("");
              }}
              className={field}
            >
              {primaries.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {parent && (
              <span className="text-xs text-ink-faint">
                Everything filed here appears in the{" "}
                <strong className="font-medium text-ink-soft">
                  {STATEMENT_LABEL[statementFor(parent.nature)]}
                </strong>{" "}
                as {NATURE_LABEL[parent.nature] ?? parent.nature}, on the{" "}
                {parent.normal_balance === "debit" ? "debit" : "credit"} side.
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Freight Outward"
              className={field}
            />
            {nameClash && (
              <span className="text-xs text-warning">
                This company already has a group called &ldquo;{trimmed}&rdquo;.
                Two groups with the same name are hard to tell apart in the
                ledger picker, and a few reports still match certain groups by
                name — pick a different one.
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Treated as{" "}
              <span className="font-normal text-ink-faint">
                the Schedule III sub-head
              </span>
            </span>
            <select
              value={effectiveRole}
              onChange={(e) => setRole(e.target.value)}
              className={field}
            >
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r] ?? r}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-faint">
              This only decides which sub-total the group is added into. It
              never changes which statement the group appears in — the parent
              decides that.
            </span>
          </label>

          {error && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || trimmed.length === 0 || nameClash || !parent}
            className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add group"}
          </button>

          <p className="text-xs text-ink-faint">
            Groups cannot be renamed or removed here. A few reports still find
            certain seeded groups by their exact name, so a rename would empty
            them silently — see this file&rsquo;s header.
          </p>
        </form>
      </section>
    </div>
  );
}
