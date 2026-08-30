import { describe, expect, it } from "vitest";
import { buildPostPreview, gstSupplyType, parseDec } from "@/components/capture/previewModel";
import type { PreviewFacts } from "@/components/capture/previewFacts";

/**
 * The post preview, against what public.create_invoice ACTUALLY wrote.
 *
 * Every expectation in the first two tests was copied out of the database
 * after the same payload was posted for real through create_invoice on
 * 30 Aug 2026, against Nexgen Softwares Private Limited (Maharashtra, 27)
 * buying from SUPER ELECTRICALS (Gujarat, 24) — vouchers HO/PUR/2026-27/00006
 * and HO/PUR/2026-27/00007, both deleted afterwards. They are not figures
 * this test computed and then asserted about itself; they are the ledger's.
 *
 * The three cover the two tax paths a purchase can take, and the rounding:
 *   00006  place of supply 24 -> inter-State, one Input IGST line.
 *   00007  place of supply 27 -> intra-State, Input CGST and Input SGST,
 *          with three discounted lines including a 33.333% one, which is
 *          STORED as 33.33 in numeric(5,2) while being COMPUTED on 33.333.
 *   00008  two lines chosen to land exactly on a half-paisa, which is the
 *          whole reason this preview does exact-decimal arithmetic instead of
 *          copying the Math.round(x * 100) / 100 idiom used elsewhere on the
 *          client. See the last describe block: on that voucher the idiom gets
 *          BOTH the purchase debit and the input-tax debit wrong by a paisa,
 *          in opposite directions, so even the grand total still ties and
 *          nothing looks amiss.
 */

const REGISTRATION = {
  id: "5333a6ef-4115-4675-88c8-34a35f84a0e6",
  stateCode: "27",
  gstin: "27ABCCN3456P1ZW",
  lutActive: false,
};

const TAX_LEDGERS = {
  input_cgst: "Input CGST (27)",
  input_sgst: "Input SGST (27)",
  input_igst: "Input IGST (27)",
  input_cess: "Input Cess (27)",
  output_cgst: "Output CGST (27)",
  output_sgst: "Output SGST (27)",
  output_igst: "Output IGST (27)",
  output_cess: "Output Cess (27)",
  output_tcs: "TCS Payable",
  rcm_payable: "RCM Payable (27)",
};

/** The item master rows create_invoice read for itself, as it read them. */
const ITEMS = {
  cable: {
    id: "6c4502f5-d037-41bd-b4dc-2616c9ec765e",
    name: "COPPER FLEXIBLE CABLE 1 SQ. MM 3 CORE",
    uom: "MTR",
    hsnSac: "8544",
    gstRatePercent: "18.00",
    cessRatePercent: "0.00",
    defaultTcsSection: null,
    isRcmApplicable: false,
  },
  mcb: {
    id: "d7e2ce99-169d-4a36-a1e7-54d563a91361",
    name: "SCHNEIDER MAKE MCB FOUR POLE 63 AMP. ACTI 9 (C60) RANGE 'C' Curve",
    uom: "PCS",
    hsnSac: "8536",
    gstRatePercent: "18.00",
    cessRatePercent: "0.00",
    defaultTcsSection: null,
    isRcmApplicable: false,
  },
  board: {
    id: "bc414cea-285c-408d-a252-1c27b3206637",
    name: "LIGHTING BOARD WITH 1 SWITCH + 4 SOCKET",
    uom: "PCS",
    hsnSac: "8536",
    gstRatePercent: "18.00",
    cessRatePercent: "0.00",
    defaultTcsSection: null,
    isRcmApplicable: false,
  },
  pinTop: {
    id: "afe32a5c-033d-4f06-9093-11b730ad99ae",
    name: "JAINEX MAKE 3 PIN TOP 6 AMP.",
    uom: "PCS",
    hsnSac: "8536",
    gstRatePercent: "18.00",
    cessRatePercent: "0.00",
    defaultTcsSection: null,
    isRcmApplicable: false,
  },
  clip: {
    id: "8f883b02-be28-45fe-9a3d-88319b8123c4",
    name: "CABLE CLIP 6 MM",
    uom: "PAC",
    hsnSac: "3925",
    gstRatePercent: "18.00",
    cessRatePercent: "0.00",
    defaultTcsSection: null,
    isRcmApplicable: false,
  },
} as const;

function facts(overrides: Partial<PreviewFacts> = {}): PreviewFacts {
  return {
    gstModuleActive: true,
    tcsModuleActive: true,
    registration: REGISTRATION,
    registrationOutOfPeriod: false,
    partyStateCode: "24",
    partyPan: "AEMPB3576L",
    partyRegistrationType: "regular",
    items: Object.fromEntries(Object.values(ITEMS).map((i) => [i.id, { ...i }])),
    taxLedgers: { ...TAX_LEDGERS },
    tcsSections: {
      "TCS-SCRAP": { ratePercent: "2.00", noPanRatePercent: "5.00", thresholdRupees: null },
    },
    ...overrides,
  };
}

const HEADER = {
  voucherType: "purchase" as const,
  voucherDate: "2026-07-30",
  partyLedgerName: "SUPER ELECTRICALS",
  tradingLedgerName: "Purchase Account",
};

function line(
  item: { id: string },
  quantity: number,
  rate: number,
  discountPercent = 0,
  readAmount: number | null = null
) {
  return {
    itemId: item.id,
    quantity,
    rate,
    discountPercent,
    description: null,
    readAmount,
    readDescription: null,
  };
}

describe("the inter-State path — voucher HO/PUR/2026-27/00006 as posted", () => {
  const preview = buildPostPreview(
    {
      ...HEADER,
      placeOfSupply: "24",
      lines: [
        line(ITEMS.cable, 20, 59),
        line(ITEMS.mcb, 1, 6279),
        line(ITEMS.board, 5, 275),
        line(ITEMS.pinTop, 5, 50),
      ],
    },
    facts()
  );

  it("nothing blocks it", () => {
    expect(preview.blockers).toEqual([]);
  });

  it("reads the supply as inter-State, which is what vouchers.supply_type says", () => {
    expect(preview.supplyType).toBe("inter");
    expect(preview.intrastate).toBe(false);
  });

  it("writes the three entries the database wrote, on the sides it wrote them", () => {
    expect(preview.entries).toEqual([
      { ledgerName: "SUPER ELECTRICALS", ledgerNote: null, debit: 0, credit: 10719.12 },
      { ledgerName: "Purchase Account", ledgerNote: null, debit: 9084, credit: 0 },
      {
        ledgerName: "Input IGST (27)",
        ledgerNote: "resolved by the database from this registration's tax-ledger map",
        debit: 1635.12,
        credit: 0,
      },
    ]);
  });

  it("balances, which trg_voucher_entries_balance also demands", () => {
    expect(preview.debitTotal).toBe(10719.12);
    expect(preview.creditTotal).toBe(10719.12);
    expect(preview.balanced).toBe(true);
  });

  it("moves the same stock, in, at the same amounts and the master's own units", () => {
    expect(preview.stock.map((s) => [s.itemName, s.direction, s.quantity, s.uom, s.amount])).toEqual(
      [
        [ITEMS.cable.name, "in", 20, "MTR", 1180],
        [ITEMS.mcb.name, "in", 1, "PCS", 6279],
        [ITEMS.board.name, "in", 5, "PCS", 1375],
        [ITEMS.pinTop.name, "in", 5, "PCS", 250],
      ]
    );
  });

  it("splits the tax by rate", () => {
    expect(preview.taxRows).toEqual([
      { ratePercent: 18, taxable: 9084, cgst: 0, sgst: 0, igst: 1635.12, cess: 0, rcm: 0 },
    ]);
  });
});

describe("the intra-State path with discounts — voucher HO/PUR/2026-27/00007 as posted", () => {
  const preview = buildPostPreview(
    {
      ...HEADER,
      placeOfSupply: "27",
      lines: [
        line(ITEMS.cable, 20, 59, 12.5),
        line(ITEMS.mcb, 1, 6279),
        line(ITEMS.board, 5, 275, 7.5),
        line(ITEMS.pinTop, 5, 50, 33.333),
        line(ITEMS.clip, 1, 172.3, 5),
      ],
    },
    facts()
  );

  it("reads the supply as intra-State", () => {
    expect(preview.supplyType).toBe("intra");
    expect(preview.intrastate).toBe(true);
  });

  it("writes the four entries the database wrote", () => {
    expect(preview.entries).toEqual([
      { ledgerName: "SUPER ELECTRICALS", ledgerNote: null, debit: 0, credit: 10518.2 },
      { ledgerName: "Purchase Account", ledgerNote: null, debit: 8913.72, credit: 0 },
      {
        ledgerName: "Input CGST (27)",
        ledgerNote: "resolved by the database from this registration's tax-ledger map",
        debit: 802.24,
        credit: 0,
      },
      {
        ledgerName: "Input SGST (27)",
        ledgerNote: "resolved by the database from this registration's tax-ledger map",
        debit: 802.24,
        credit: 0,
      },
    ]);
    expect(preview.balanced).toBe(true);
  });

  it("reproduces every discounted line amount, to the paisa", () => {
    expect(preview.stock.map((s) => s.amount)).toEqual([1032.5, 6279, 1271.87, 166.67, 163.68]);
  });

  it("stores the discount at numeric(5,2) while computing on the full value", () => {
    // 33.333 is written to voucher_items.discount_percent as 33.33, but the
    // line amount is 250 - round(250 * 33.333 / 100, 2) = 250 - 83.33 = 166.67,
    // NOT 250 - round(250 * 33.33 / 100, 2) = 166.68.
    expect(preview.stock[3].discountPercent).toBe(33.33);
    expect(preview.stock[3].amount).toBe(166.67);
  });

  it("reproduces the undiscounted line untouched", () => {
    expect(preview.stock[1].amount).toBe(6279);
    expect(preview.stock[1].discountPercent).toBe(0);
  });

  it("warns that the place of supply is not the supplier's own state", () => {
    // The real defect this warning exists for: a Gujarat supplier's bill
    // computed as CGST + SGST inside a Maharashtra company.
    const note = preview.notices.find((n) => n.title.startsWith("Place of supply"));
    expect(note?.tone).toBe("warning");
    expect(note?.title).toContain("(27)");
    expect(note?.title).toContain("(24)");
  });
});

describe("half-paisa rounding — voucher HO/PUR/2026-27/00008 as posted", () => {
  /**
   * The one thing a preview must not get wrong quietly.
   *
   * Line 1 is 1 x 1.16 less 12.5%: the discount is 0.145 exactly, and Postgres
   * round(0.145, 2) is 0.15 (half AWAY FROM ZERO), leaving 1.01.
   * Line 2 is 1 x 5.75 at 18%: the tax is 1.035 exactly, and Postgres gives
   * 1.04.
   *
   * The client idiom used elsewhere on this screen gets both wrong, because
   * 0.145 * 100 is 14.499999999999998 and 1.035 * 100 is 103.49999999999999 in
   * binary floating point: it would show a purchase debit of 6.77 against the
   * real 6.76 and an Input IGST debit of 1.21 against the real 1.22. The two
   * errors cancel in the grand total, so the preview would look perfectly
   * balanced while naming two wrong figures. Both are asserted below against
   * what the ledger actually holds.
   */
  const preview = buildPostPreview(
    {
      ...HEADER,
      placeOfSupply: "24",
      lines: [line(ITEMS.clip, 1, 1.16, 12.5), line(ITEMS.clip, 1, 5.75)],
    },
    facts()
  );

  it("matches the posted entries to the paisa", () => {
    expect(preview.entries).toEqual([
      { ledgerName: "SUPER ELECTRICALS", ledgerNote: null, debit: 0, credit: 7.98 },
      { ledgerName: "Purchase Account", ledgerNote: null, debit: 6.76, credit: 0 },
      {
        ledgerName: "Input IGST (27)",
        ledgerNote: "resolved by the database from this registration's tax-ledger map",
        debit: 1.22,
        credit: 0,
      },
    ]);
  });

  it("matches the posted line amounts", () => {
    expect(preview.stock.map((s) => s.amount)).toEqual([1.01, 5.75]);
  });

  it("is a case the float idiom on this screen genuinely gets wrong", () => {
    // Not a claim about floats in general — this is the exact expression
    // CaptureReviewForm.lineAmounts and its tax memo evaluate.
    const naiveDiscount = Math.round(((1.16 * 12.5) / 100) * 100) / 100;
    const naiveTax = Math.round(((5.75 * 18) / 100) * 100) / 100;
    expect(naiveDiscount).toBe(0.14); // Postgres: 0.15
    expect(naiveTax).toBe(1.03); // Postgres: 1.04
  });
});

describe("what it refuses to show", () => {
  it("blocks rather than guessing when the branch has no registration for the date", () => {
    const preview = buildPostPreview(
      {
        ...HEADER,
        placeOfSupply: "24",
        lines: [line(ITEMS.cable, 20, 59)],
      },
      facts({ registration: null, registrationOutOfPeriod: true })
    );
    expect(preview.entries).toEqual([]);
    expect(preview.blockers[0]).toContain("does not cover it");
  });

  it("blocks when a tax ledger the post needs is not mapped", () => {
    const preview = buildPostPreview(
      { ...HEADER, placeOfSupply: "24", lines: [line(ITEMS.cable, 20, 59)] },
      facts({ taxLedgers: {} })
    );
    expect(preview.entries).toEqual([]);
    expect(preview.blockers.join(" ")).toContain("IGST ledger is mapped");
  });

  it("shows no tax at all when the gst module is not active on the voucher date", () => {
    // The review screen's own gstOn prop is computed with NO date, so this is
    // exactly the case a preview built from the prop would get wrong.
    const preview = buildPostPreview(
      { ...HEADER, placeOfSupply: "24", lines: [line(ITEMS.cable, 20, 59)] },
      facts({ gstModuleActive: false })
    );
    expect(preview.totals.igst).toBe(0);
    expect(preview.entries).toEqual([
      { ledgerName: "SUPER ELECTRICALS", ledgerNote: null, debit: 0, credit: 1180 },
      { ledgerName: "Purchase Account", ledgerNote: null, debit: 1180, credit: 0 },
    ]);
  });
});

describe("reverse charge, Sec 9(3)", () => {
  it("charges the supplier nothing and books the self-assessed tax on both sides", () => {
    const rcmItem = { ...ITEMS.cable, isRcmApplicable: true };
    const preview = buildPostPreview(
      { ...HEADER, placeOfSupply: "24", lines: [line(rcmItem, 20, 59)] },
      facts({ items: { [rcmItem.id]: rcmItem } })
    );
    // The party is credited the taxable value only — no tax was charged.
    expect(preview.totals.grand).toBe(1180);
    expect(preview.totals.igst).toBe(0);
    expect(preview.totals.rcm).toBe(212.4);
    expect(preview.entries).toEqual([
      { ledgerName: "SUPER ELECTRICALS", ledgerNote: null, debit: 0, credit: 1180 },
      { ledgerName: "Purchase Account", ledgerNote: null, debit: 1180, credit: 0 },
      {
        ledgerName: "RCM Payable (27)",
        ledgerNote: "resolved by the database from this registration's tax-ledger map",
        debit: 0,
        credit: 212.4,
      },
      {
        ledgerName: "Purchase Account",
        ledgerNote:
          "the matching debit for reverse charge — create_invoice capitalises it here, not into Input GST, because Sec 49(4) bars using it until it has actually been paid in cash",
        debit: 212.4,
        credit: 0,
      },
    ]);
    expect(preview.balanced).toBe(true);
  });
});

describe("app_private.gst_supply_type, mirrored", () => {
  it("answers what the SQL answers", () => {
    expect(gstSupplyType("27", "27", "regular", false)).toBe("intra");
    expect(gstSupplyType("27", "24", "regular", false)).toBe("inter");
    expect(gstSupplyType("27", "24", "overseas", true)).toBe("export_lut");
    expect(gstSupplyType("27", "24", "overseas", false)).toBe("export_igst");
    // coalesce(p_lut_active, false) — a NULL flag is NOT an active LUT here.
    expect(gstSupplyType("27", "24", "overseas", null)).toBe("export_igst");
    expect(gstSupplyType("27", "24", "sez", false)).toBe("sez");
    expect(gstSupplyType("27", "24", "sez_developer", false)).toBe("sez");
    expect(gstSupplyType("27", "27", "deemed_export", false)).toBe("deemed_export");
  });
});

describe("the decimal parser", () => {
  it("takes a numeric column as a string or a number, and a rate in exponent form", () => {
    // PostgREST hands numeric back as a JSON number; this project's SQL console
    // hands it back as a string. Both have to mean the same thing.
    expect(parseDec("18.00")).toEqual({ v: BigInt(1800), s: 2 });
    expect(parseDec(18)).toEqual({ v: BigInt(18), s: 0 });
    // String(1.5e-7) is "1.5e-7", which no decimal parser accepts as written.
    expect(parseDec(1.5e-7)).toEqual({ v: BigInt(15), s: 8 });
    expect(parseDec(-2.5)).toEqual({ v: BigInt(-25), s: 1 });
    expect(parseDec(null)).toEqual({ v: BigInt(0), s: 0 });
    expect(parseDec("not a number")).toEqual({ v: BigInt(0), s: 0 });
  });
});
