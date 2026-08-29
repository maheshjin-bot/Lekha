/**
 * Which account-group roles an invoice's TRADING ledger may carry.
 *
 * The trading ledger is not stored on the voucher header — create_invoice only
 * ever takes it as a posting instruction — so the edit screen has to recover it
 * from whichever entry landed on an income or expense ledger. That means two
 * screens ask the same question, and they must not disagree: if the entry form
 * offers a role the edit screen does not recognise, opening a saved invoice
 * silently blanks a `required` field and the preparer has to guess it again.
 *
 * A PLAIN module, deliberately, and NOT an export from InvoiceForm.tsx. That
 * file carries "use client", and every value exported from a client module
 * becomes a client REFERENCE when a server component imports it — a proxy
 * object, not the array. It typechecks perfectly and then throws
 * "tradingRoles.includes is not a function" at request time, which is exactly
 * what happened when this list first lived there.
 *
 * This used to be the single role 'expense'. Migration 0210 replaced that one
 * role with Schedule III's own expense sub-classifications and did not keep
 * 'expense' — it is no longer accepted by account_groups_ledger_role_check,
 * and confirmed live there are zero groups carrying it across all 569 groups
 * in the database. Real purchase vouchers debit "Purchase Account", whose
 * group role is cost_of_materials.
 *
 * Deliberately not the whole Schedule III expense list: depreciation, changes
 * in inventories and tax expense are period-end computations, never something
 * a supplier bills you for, so offering them would only invite a mis-posting.
 * 'expense' stays in the list purely so a company predating 0210, if one is
 * ever restored, still works.
 */
export const PURCHASE_TRADING_ROLES = [
  "cost_of_materials",
  "purchases_stock_in_trade",
  "other_expenses",
  "employee_benefits",
  "finance_costs",
  "expense",
] as const;

export const SALE_TRADING_ROLES = ["income"] as const;

/** Either side — what the edit screen recovers a saved invoice's trading ledger by. */
export const TRADING_ROLES: readonly string[] = [
  ...SALE_TRADING_ROLES,
  ...PURCHASE_TRADING_ROLES,
];
