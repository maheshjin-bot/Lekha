import { describe, it, expect } from "vitest";
import {
  equityPlan,
  gapCoverage,
  gapOrigin,
  openingImbalance,
  round2,
  signedOf,
  type EquityLedger,
  type OpeningGapRow,
} from "@/lib/reports/openingBalanceGap";

/** A row shaped like public.get_unbalanced_opening_balances returns. */
function row(
  name: string,
  amount: number,
  type: "debit" | "credit",
  total: number
): OpeningGapRow {
  return {
    ledger_id: name,
    ledger_name: name,
    group_name: "Sundry Debtors",
    opening_balance_amount: amount,
    opening_balance_type: type,
    opening_signed: type === "credit" ? -amount : amount,
    company_total_imbalance: total,
  };
}

describe("signedOf", () => {
  it("treats credit as negative and debit as positive", () => {
    expect(signedOf(12500, "debit")).toBe(12500);
    expect(signedOf(12500, "credit")).toBe(-12500);
  });
});

describe("openingImbalance", () => {
  it("is zero for a healthy company, which returns no rows at all", () => {
    expect(openingImbalance([])).toBe(0);
  });

  it("reads the repeated company total rather than re-summing the rows", () => {
    // Deliberately inconsistent: the rows here sum to 100 but the diagnostic
    // says 57,500. The company total is the authoritative figure — the row
    // list is filtered to nonzero opening balances and is not guaranteed to be
    // the whole story.
    const rows = [row("A", 100, "debit", 57500)];
    expect(openingImbalance(rows)).toBe(57500);
  });
});

describe("gapCoverage", () => {
  it("Verma & Associates: the opening balances are the whole difference", () => {
    // Live, 2 Sep 2026: trial balance closing Dr 28,16,882.78 vs Cr
    // 27,59,382.78, and get_unbalanced_opening_balances reports 57,500.00.
    const c = gapCoverage(2816882.78 - 2759382.78, 57500);
    expect(c.explained).toBe(57500);
    expect(c.unexplained).toBe(0);
    expect(c.explainsAll).toBe(true);
  });

  it("Nexgen Softwares: a credit-side difference is covered the same way", () => {
    // Live: balance sheet assets 15,75,020.00 against liabilities 37,14,824.43
    // plus profit 8,08,695.57, and an opening imbalance of -29,48,500.00.
    const c = gapCoverage(1575020 - (3714824.43 + 808695.57), -2948500);
    expect(c.reportGap).toBe(-2948500);
    expect(c.explainsAll).toBe(true);
  });

  it("reports a partial explanation rather than overclaiming", () => {
    const c = gapCoverage(100000, 57500);
    expect(c.explained).toBe(57500);
    expect(c.unexplained).toBe(42500);
    expect(c.explainsAll).toBe(false);
  });

  it("does not let float noise pass for an exact match, or block one", () => {
    // 0.1 + 0.2 arithmetic must not leave explainsAll false on a real match.
    expect(gapCoverage(0.1 + 0.2, 0.3).explainsAll).toBe(true);
    expect(gapCoverage(57500.01, 57500).explainsAll).toBe(false);
  });
});

describe("gapOrigin", () => {
  it("no Opening Balance Equity ledger means the books predate the safeguard", () => {
    // After 0755 the first nonzero opening balance written creates this ledger
    // as a side effect, so its absence alongside a nonzero total is structural
    // evidence, not a guess.
    expect(gapOrigin(null)).toBe("before_safeguard");
  });

  it("an existing ledger means the difference came from editing it by hand", () => {
    const equity: EquityLedger = {
      id: "obe",
      opening_balance_amount: 0,
      opening_balance_type: "debit",
    };
    expect(gapOrigin(equity)).toBe("equity_ledger_edited");
  });
});

describe("equityPlan", () => {
  it("Nexgen: -29,48,500 becomes a 29,48,500 Dr opening balance on a new ledger", () => {
    // Verified live inside a rolled-back transaction: balance_opening_balances
    // returned new_amount 2948500.00, new_type 'debit', ledger_created true,
    // and the trial balance then tallied at 47,31,999.24 both sides.
    const plan = equityPlan(-2948500, null);
    expect(plan.creates).toBe(true);
    expect(plan.previousSigned).toBe(0);
    expect(plan.targetAmount).toBe(2948500);
    expect(plan.targetType).toBe("debit");
  });

  it("Verma / Sharma: +57,500 becomes a 57,500 Cr opening balance", () => {
    const plan = equityPlan(57500, null);
    expect(plan.targetAmount).toBe(57500);
    expect(plan.targetType).toBe("credit");
  });

  it("subtracts the difference from the ledger's own balance, never just negates it", () => {
    // The imbalance already INCLUDES Opening Balance Equity's own balance. A
    // plain negation would double-count here: it would give 20,000 Cr instead
    // of the correct 30,000 Cr, and leave the books out by 10,000.
    const equity: EquityLedger = {
      id: "obe",
      opening_balance_amount: 10000,
      opening_balance_type: "credit",
    };
    const plan = equityPlan(20000, equity);
    expect(plan.previousSigned).toBe(-10000);
    expect(plan.targetSigned).toBe(-30000);
    expect(plan.targetAmount).toBe(30000);
    expect(plan.targetType).toBe("credit");
    expect(plan.creates).toBe(false);

    // The property that matters: after the plan is applied, everything else's
    // opening balances plus the new equity balance net to zero.
    const everythingElse = plan.imbalance - plan.previousSigned;
    expect(round2(everythingElse + plan.targetSigned)).toBe(0);
  });

  it("holds that property across a spread of starting positions", () => {
    for (const imbalance of [-2948500, -1, -0.01, 0.01, 1, 57500, 123456.78]) {
      for (const prev of [null, -50000, -0.01, 0, 0.01, 50000]) {
        const equity: EquityLedger =
          prev === null
            ? null
            : {
                id: "obe",
                opening_balance_amount: Math.abs(prev),
                opening_balance_type: prev < 0 ? "credit" : "debit",
              };
        const plan = equityPlan(imbalance, equity);
        const everythingElse = plan.imbalance - plan.previousSigned;
        expect(round2(everythingElse + plan.targetSigned)).toBe(0);
        expect(plan.targetAmount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("a zero target is written as a debit, matching the SQL's >= 0 branch", () => {
    // balance_opening_balances writes
    //   opening_balance_type = case when v_target_signed >= 0 then 'debit' else 'credit' end
    // so the preview must agree on the boundary or the confirmation would show
    // a Cr the database then stores as a Dr.
    const equity: EquityLedger = {
      id: "obe",
      opening_balance_amount: 500,
      opening_balance_type: "debit",
    };
    const plan = equityPlan(500, equity);
    expect(plan.targetAmount).toBe(0);
    expect(plan.targetType).toBe("debit");
  });
});
