import type { PreviewFacts, PreviewItemFacts } from "@/components/capture/previewFacts";

/**
 * The arithmetic half of the POST PREVIEW — what public.create_invoice will
 * write, worked out before it is asked to write it.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT IS NOT A DRY RUN
 * ============================================================================
 * The honest way to preview a posting is to let the database do it: call
 * create_invoice inside a transaction and roll it back, and you get the exact
 * rows with no second copy of the logic to keep in step. That was tried
 * against the live database before this file was written, and it WORKS —
 * a plpgsql wrapper that calls create_invoice, reads voucher_entries /
 * voucher_items into a plpgsql variable and then raises a sentinel to roll the
 * subtransaction back returns the exact entries (plpgsql variables are not
 * rolled back), leaves no row behind, and does NOT burn a voucher number,
 * because app_private.next_voucher_number increments a ROW in
 * public.voucher_number_sequences with INSERT … ON CONFLICT DO UPDATE rather
 * than drawing from a Postgres sequence, so the increment rolls back with
 * everything else. Measured: sequence 4 -> 4, vouchers 12 -> 12, entries
 * 37 -> 37, and the probe still returned "HO/PUR/2026-27/00004", Cr SUPER
 * ELECTRICALS 590.00 / Dr Purchase Account 500.00 / Dr Input IGST (27) 90.00.
 *
 * It was still not chosen, for reasons that are about safety rather than
 * feasibility, and they are written out in this task's report. The short
 * version:
 *
 *   - It cannot be reached without a NEW database function. PostgREST gives
 *     the browser no way to roll a call back (`Prefer: tx=rollback` needs
 *     db-tx-end = *-allow-override, and this deployment returns no
 *     Preference-Applied for it), and even if it did, create_invoice returns
 *     only a uuid — the entries would have to be read by a SECOND request, in
 *     a SECOND transaction, which would see nothing.
 *   - So a dry run means shipping a write-capable RPC to `authenticated`
 *     whose entire "nothing was written" guarantee rests on one exception
 *     escaping a function this work is forbidden to touch. Add an
 *     `exception when others` anywhere in create_invoice's call tree and every
 *     preview silently becomes a real, numbered, posted voucher on a statutory
 *     ledger, with nothing on screen to show it. The feature states twice, in
 *     its own copy, that a draft never posts itself.
 *
 * So this file mirrors instead — and the whole discipline of it is that it
 * mirrors ONE definition, read live from pg_get_functiondef on 30 Aug 2026,
 * step for step and in the same order, including which rounding happens where.
 * Each block below names the create_invoice statement it reproduces. If that
 * function changes, this file is wrong, and the way to find out is the
 * regression test in tests/unit/capture-post-preview.test.ts plus the
 * preview-then-post comparison written up in the report.
 *
 * ============================================================================
 * WHAT IT DOES NOT GUESS
 * ============================================================================
 * Everything create_invoice resolves from the SERVER is READ from the server
 * (see previewFacts.ts), never assumed from what the review screen happens to
 * hold: the GST registration valid on the voucher date, whether the gst and
 * tcs modules are active on that date, the party's registration type, each
 * item's cess rate and RCM flag, and the actual ledgers the registration's tax
 * map points at. The review form's own `gstOn` prop, for instance, is computed
 * with no date at all, while create_invoice asks module_active on the VOUCHER
 * DATE — so a preview built from the prop would disagree with the post on any
 * back-dated document.
 *
 * What genuinely cannot be known before the insert is listed in `unpredictable`
 * and printed on the face of the preview rather than guessed at.
 *
 * ============================================================================
 * EXACT DECIMALS, NOT FLOATS
 * ============================================================================
 * create_invoice does its arithmetic in Postgres `numeric` — exact base-10 —
 * and rounds with round(x, 2), which is HALF AWAY FROM ZERO. The idiom used
 * everywhere else on the client, Math.round(x * 100) / 100, is neither: it is
 * binary floating point, and the two genuinely disagree on ordinary money.
 * Measured against a real posting (voucher HO/PUR/2026-27/00008, since
 * deleted): 1 x 1.16 less 12.5% is a discount of exactly 0.145, which Postgres
 * rounds to 0.15 and the float idiom rounds to 0.14 (0.145 * 100 is
 * 14.499999999999998); 5.75 at 18% is exactly 1.035, which Postgres rounds to
 * 1.04 and the float idiom to 1.03. On that two-line bill the float idiom
 * names a purchase debit of 6.77 against the real 6.76 and an input-tax debit
 * of 1.21 against the real 1.22 — and because the errors cancel, the totals
 * still tie and the preview looks perfectly correct while stating two wrong
 * figures. So the few lines of scaled-BigInt decimal below are the point of
 * this file, not decoration.
 *
 * The values fed in are the ones that actually travel to Postgres. supabase-js
 * JSON-encodes a JS number as its shortest round-tripping decimal, and
 * PostgREST casts that text to numeric — so parsing String(n) here reproduces,
 * digit for digit, the numeric the function will receive.
 */

/* -------------------------------------------------------------------------- */
/* Exact decimal arithmetic                                                    */
/* -------------------------------------------------------------------------- */

/** value = v / 10^s, exactly. Mirrors one Postgres `numeric`. */
type Dec = { v: bigint; s: number };

// BigInt LITERALS (0n) are a syntax error under this project's ES2017
// compile target, so every constant below goes through the BigInt()
// constructor instead. The arithmetic is identical.
const B0 = BigInt(0);
const B1 = BigInt(1);
const B2 = BigInt(2);
const B5 = BigInt(5);
const B10 = BigInt(10);

function pow10(n: number): bigint {
  return B10 ** BigInt(n);
}

const ZERO: Dec = { v: B0, s: 0 };

/**
 * A JS number as the plain decimal string it is sent as. String(1e-7) is
 * "1e-7", which no numeric parser accepts, so exponent form is expanded here
 * rather than left to throw on a rate somebody typed as 1e3.
 */
function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = String(n);
  if (!/e/i.test(s)) return s;
  const [mantissa, expText] = s.split(/e/i);
  const exp = Number(expText);
  const negative = mantissa.startsWith("-");
  const m = negative ? mantissa.slice(1) : mantissa;
  const dot = m.indexOf(".");
  const intPart = dot === -1 ? m : m.slice(0, dot);
  const fracPart = dot === -1 ? "" : m.slice(dot + 1);
  const digits = intPart + fracPart;
  const point = intPart.length + exp;
  const body =
    point <= 0
      ? "0." + "0".repeat(-point) + digits
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : digits.slice(0, point) + "." + digits.slice(point);
  return (negative ? "-" : "") + body;
}

/**
 * Anything a numeric column or a form field can hand over, as an exact
 * decimal. PostgREST returns `numeric` as a JSON number and this project's SQL
 * console returns it as a string, so both are accepted; anything unparseable
 * becomes zero, which is what create_invoice's own coalesce(…, 0) does with a
 * missing rate.
 */
export function parseDec(x: number | string | null | undefined): Dec {
  if (x === null || x === undefined) return ZERO;
  const text = typeof x === "number" ? numberToPlain(x) : String(x).trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return ZERO;
  const negative = text.startsWith("-");
  const body = /^[+-]/.test(text) ? text.slice(1) : text;
  const dot = body.indexOf(".");
  const digits = dot === -1 ? body : body.slice(0, dot) + body.slice(dot + 1);
  const scale = dot === -1 ? 0 : body.length - dot - 1;
  const v = BigInt(digits || "0");
  return { v: negative ? -v : v, s: scale };
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [a.v * pow10(s - a.s), b.v * pow10(s - b.s), s];
}

function add(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return { v: x + y, s };
}

function sub(a: Dec, b: Dec): Dec {
  const [x, y, s] = align(a, b);
  return { v: x - y, s };
}

function mul(a: Dec, b: Dec): Dec {
  return { v: a.v * b.v, s: a.s + b.s };
}

/**
 * Division by 2 and by 100 — the only two divisors create_invoice uses, and
 * both exact in base 10 (x/2 = x*5/10, x/100 shifts the point two places), so
 * neither can lose a digit the way a general numeric division could.
 */
function divBy(a: Dec, k: 2 | 100): Dec {
  return k === 2 ? { v: a.v * B5, s: a.s + 1 } : { v: a.v, s: a.s + 2 };
}

/** Postgres round(x, 2): half away from zero, on the exact decimal value. */
function round2(a: Dec): Dec {
  if (a.s <= 2) return { v: a.v * pow10(2 - a.s), s: 2 };
  const factor = pow10(a.s - 2);
  const quotient = a.v / factor; // BigInt division truncates toward zero
  const remainder = a.v % factor;
  const magnitude = remainder < B0 ? -remainder : remainder;
  if (magnitude * B2 >= factor) return { v: quotient + (a.v < B0 ? -B1 : B1), s: 2 };
  return { v: quotient, s: 2 };
}

function isPositive(a: Dec): boolean {
  return a.v > B0;
}

/** Only ever called on values already rounded to 2, so this is lossless. */
function toNumber(a: Dec): number {
  return Number(a.v) / 10 ** a.s;
}

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

/** One line, in exactly the form the review form puts into p_items. */
export type PreviewLineInput = {
  itemId: string;
  quantity: number;
  rate: number;
  discountPercent: number;
  description: string | null;
  /** What the model read for this line's amount. Only used for the notices. */
  readAmount: number | null;
  /** The description as printed, for naming a line the notices complain about. */
  readDescription: string | null;
};

export type PreviewInput = {
  voucherType: "sales" | "purchase";
  voucherDate: string;
  /** '' when the review form has none — create_invoice then falls back. */
  placeOfSupply: string;
  lines: PreviewLineInput[];
  partyLedgerName: string;
  tradingLedgerName: string;
};

export type PreviewEntry = {
  ledgerName: string;
  /** Why this ledger, when it was not chosen on the form. */
  ledgerNote: string | null;
  debit: number;
  credit: number;
};

export type PreviewStockLine = {
  itemName: string;
  direction: "in" | "out";
  quantity: number;
  uom: string;
  rate: number;
  discountPercent: number;
  amount: number;
  hsnSac: string | null;
};

export type PreviewTaxRow = {
  ratePercent: number;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  rcm: number;
};

export type PreviewNotice = {
  tone: "warning" | "info";
  title: string;
  body: string;
};

export type PostPreview = {
  /** Reasons create_invoice would raise, or this preview cannot be built. */
  blockers: string[];
  supplyType: string | null;
  intrastate: boolean | null;
  entries: PreviewEntry[];
  debitTotal: number;
  creditTotal: number;
  balanced: boolean;
  stock: PreviewStockLine[];
  taxRows: PreviewTaxRow[];
  totals: {
    taxable: number;
    cgst: number;
    sgst: number;
    igst: number;
    cess: number;
    tcs: number;
    rcm: number;
    grand: number;
  };
  notices: PreviewNotice[];
  /** What the database decides at insert time and this cannot know. */
  unpredictable: string[];
};

/* -------------------------------------------------------------------------- */
/* app_private.gst_supply_type, mirrored                                       */
/* -------------------------------------------------------------------------- */

/**
 * The four-argument overload, value for value. The `intra`/`inter` tail is the
 * ONLY branch an ordinary domestic bill reaches; the three above it exist
 * because a party marked overseas or SEZ changes the tax to zero (or to full
 * IGST) without changing anything visible on this screen, and a preview that
 * quietly showed CGST/SGST for an SEZ customer would be exactly the kind of
 * lie this component is written to avoid.
 */
export function gstSupplyType(
  supplierState: string,
  placeOfSupply: string,
  partyRegistrationType: string | null,
  lutActive: boolean | null
): string {
  // create_invoice hands this coalesce(p_lut_active, false), so a null LUT
  // flag reads as "no LUT" HERE even though the tax branch below treats the
  // same null as neither true nor false. Both are faithful; they differ
  // because the SQL does.
  if (partyRegistrationType === "overseas")
    return lutActive === true ? "export_lut" : "export_igst";
  if (partyRegistrationType === "sez" || partyRegistrationType === "sez_developer") return "sez";
  if (partyRegistrationType === "deemed_export") return "deemed_export";
  return supplierState === placeOfSupply ? "intra" : "inter";
}

/* -------------------------------------------------------------------------- */
/* The preview itself                                                          */
/* -------------------------------------------------------------------------- */

const RATE_KEY = (d: Dec) => toNumber(round2(d));

export function buildPostPreview(input: PreviewInput, facts: PreviewFacts): PostPreview {
  const blockers: string[] = [];
  const notices: PreviewNotice[] = [];
  const unpredictable: string[] = [];

  // create_invoice: `if jsonb_array_length(coalesce(p_items,'[]')) = 0`
  if (input.lines.length === 0) {
    blockers.push("An invoice needs at least one item line.");
  }

  // create_invoice: the CASE on p_voucher_type.
  const direction: "in" | "out" = input.voucherType === "sales" ? "out" : "in";
  const partySide: "debit" | "credit" = input.voucherType === "sales" ? "debit" : "credit";
  const taxPrefix = input.voucherType === "sales" ? "output" : "input";

  // create_invoice: module_active(company, 'gst'|'tcs', VOUCHER DATE).
  const gstOn = facts.gstModuleActive;
  const tcsOn = taxPrefix === "output" && facts.tcsModuleActive;

  let supplierState = "";
  let lutActive: boolean | null = false;
  let supplyType: string | null = null;
  let intrastate: boolean | null = null;
  let placeOfSupply = input.placeOfSupply;

  if (gstOn) {
    // create_invoice: branch_registration(p_branch_id, p_voucher_date) — and it
    // RAISES when there is none, so this is a blocker and not a warning.
    if (!facts.registration) {
      blockers.push(
        facts.registrationOutOfPeriod
          ? "GST is active on this date, but the branch's GST registration does not cover it — its own registered-from/registered-to period excludes this voucher date. create_invoice refuses the post outright."
          : "GST is active for this company on this date, but the branch has no GST registration attached. create_invoice refuses the post outright — attach one before this document can be posted from this branch."
      );
    } else {
      supplierState = facts.registration.stateCode ?? "";
      lutActive = facts.registration.lutActive;
    }

    if (!placeOfSupply) {
      // create_invoice: `select state_code into p_place_of_supply from ledgers`.
      placeOfSupply = facts.partyStateCode ?? "";
      if (!placeOfSupply) {
        blockers.push(
          "No place of supply was chosen and the party ledger has no state on file, so create_invoice cannot determine one and refuses the post."
        );
      } else {
        notices.push({
          tone: "info",
          title: "Place of supply comes from the party ledger",
          body: `Nothing was chosen on the form, so create_invoice falls back to the state on the party ledger — ${placeOfSupply}. That is what the split below is computed from.`,
        });
      }
    }

    if (facts.registration && placeOfSupply) {
      supplyType = gstSupplyType(
        supplierState,
        placeOfSupply,
        facts.partyRegistrationType,
        lutActive
      );
      intrastate = supplierState === placeOfSupply;

      /* ------------------------------------------------------------------ *
       * The place of supply against the party's own state.
       *
       * This is the check worth having at exactly this moment. create_invoice
       * decides intra vs inter by comparing OUR registration's state with the
       * place of supply — it is written from the seller's chair — so on a
       * PURCHASE the place of supply has to be the SUPPLIER's state for the
       * bill to come out as IGST. Leave it on our own state and a Gujarat
       * supplier's bill computes as CGST + SGST and looks perfectly correct,
       * because the two halves still add up to the number printed on the
       * paper. Seen on real captured data: a Gujarat supplier (24) into a
       * Maharashtra company (27), where the totals agreed only because the
       * document was addressed to a different, Gujarat, buyer.
       * ------------------------------------------------------------------ */
      if (facts.partyStateCode && facts.partyStateCode !== placeOfSupply) {
        notices.push({
          tone: "warning",
          title: `Place of supply (${placeOfSupply}) is not the party's own state (${facts.partyStateCode})`,
          body:
            input.voucherType === "purchase"
              ? `On a purchase, the place of supply must be the SUPPLIER's state for the bill to compute as inter-State IGST — create_invoice compares it against your own registration's state (${supplierState || "—"}). As it stands this posts as ${intrastate ? "intra-State CGST + SGST" : "inter-State IGST"}. Check the supplier's own bill: if it charges IGST and this shows CGST + SGST, the place of supply is wrong, and the two halves will still add up to the printed total while the input credit lands in the wrong pot.`
              : `create_invoice compares the place of supply against your own registration's state (${supplierState || "—"}), so this posts as ${intrastate ? "intra-State CGST + SGST" : "inter-State IGST"} even though the customer ledger is in ${facts.partyStateCode}. That is right for a supply delivered elsewhere, and wrong if the state was simply not updated.`,
        });
      }
    }
  }

  /* ---- the per-line loop, in create_invoice's own order ------------------ */

  let taxableTotal = ZERO;
  let cgstTotal = ZERO;
  let sgstTotal = ZERO;
  let igstTotal = ZERO;
  let cessTotal = ZERO;
  let tcsTotal = ZERO;
  let rcmTotal = ZERO;

  const stock: PreviewStockLine[] = [];
  const byRate = new Map<number, PreviewTaxRow>();

  input.lines.forEach((line, index) => {
    const label = line.readDescription?.trim() || line.description?.trim() || `Line ${index + 1}`;

    const qty = parseDec(line.quantity);
    const rate = parseDec(line.rate);
    if (!isPositive(qty)) {
      blockers.push(`${label}: every item line needs a quantity greater than zero.`);
      return;
    }

    const discountPercent = parseDec(line.discountPercent);
    if (discountPercent.v < B0 || toNumber(discountPercent) > 100) {
      blockers.push(`${label}: discount percent must be between 0 and 100.`);
      return;
    }

    const item: PreviewItemFacts | undefined = facts.items[line.itemId];
    if (!item) {
      blockers.push(
        `${label}: this item could not be read back from the item master, so what it would post cannot be shown.`
      );
      return;
    }

    // create_invoice: round(qty * coalesce(rate,0), 2), then the Sec 15(3)(a)
    // discount, then amount = gross - discount. Not one expression: the
    // discount is rounded to paise on its own before it is subtracted.
    const gross = round2(mul(qty, rate));
    const discount = round2(divBy(mul(gross, discountPercent), 100));
    const amount = sub(gross, discount);
    taxableTotal = add(taxableTotal, amount);

    const gstRate = parseDec(item.gstRatePercent);
    const cessRate = parseDec(item.cessRatePercent);

    stock.push({
      itemName: item.name,
      direction,
      quantity: toNumber(qty),
      // create_invoice: coalesce(v_uom, 'NOS'), off the ITEM MASTER — a voucher
      // line has no unit of its own.
      uom: item.uom ?? "NOS",
      rate: toNumber(rate),
      // voucher_items.discount_percent is numeric(5,2), so 33.333 is STORED as
      // 33.33 even though the taxable value is computed from the full 33.333.
      // Shown as stored — this table claims to be the row that will be written.
      discountPercent: toNumber(round2(discountPercent)),
      amount: toNumber(amount),
      hsnSac: item.hsnSac,
    });

    let lineCgst = ZERO;
    let lineSgst = ZERO;
    let lineIgst = ZERO;
    let lineCess = ZERO;
    let lineRcm = ZERO;
    let reverseCharged = false;

    if (gstOn && supplyType) {
      if (input.voucherType === "purchase" && item.isRcmApplicable) {
        // Sec 9(3): the supplier charges nothing, so the four accumulators stay
        // at zero and the self-assessed tax is tracked on its own. MUTUALLY
        // EXCLUSIVE with the branch below, exactly as in the SQL — computing
        // both would double the tax.
        reverseCharged = true;
        lineRcm = round2(divBy(mul(amount, add(gstRate, cessRate)), 100));
        rcmTotal = add(rcmTotal, lineRcm);
      } else if (supplyType === "export_lut" || (supplyType === "sez" && lutActive === true)) {
        // Sec 16(3)(a) — zero-rated under LUT. No tax at all.
      } else if (supplyType === "export_igst" || (supplyType === "sez" && lutActive === false)) {
        // `=== false`, not `!lutActive`: a NULL lut flag makes this condition
        // NULL in Postgres, so the SQL falls through to the intrastate test
        // rather than taking this branch. See PreviewRegistration.lutActive.
        lineIgst = round2(divBy(mul(amount, gstRate), 100));
        lineCess = round2(divBy(mul(amount, cessRate), 100));
      } else if (intrastate) {
        // Note the order create_invoice divides in: amount * rate / 2 / 100.
        lineCgst = round2(divBy(divBy(mul(amount, gstRate), 2), 100));
        lineSgst = lineCgst; // copied by the function, never recomputed
        lineCess = round2(divBy(mul(amount, cessRate), 100));
      } else {
        lineIgst = round2(divBy(mul(amount, gstRate), 100));
        lineCess = round2(divBy(mul(amount, cessRate), 100));
      }

      if (!reverseCharged) {
        cgstTotal = add(cgstTotal, lineCgst);
        sgstTotal = add(sgstTotal, lineSgst);
        igstTotal = add(igstTotal, lineIgst);
        cessTotal = add(cessTotal, lineCess);
      }
    }

    // Sec 206C. Computed here for the same reason everything else is: the
    // review screen used to say the posted total would simply be higher than
    // the figure it showed, which is a preview that knows it is incomplete.
    if (tcsOn && item.defaultTcsSection) {
      const section = facts.tcsSections[item.defaultTcsSection];
      if (section) {
        const threshold = section.thresholdRupees == null ? null : parseDec(section.thresholdRupees);
        const overThreshold = threshold === null || isPositive(sub(amount, threshold));
        if (overThreshold) {
          const lineGst = gstOn
            ? add(add(lineCgst, lineSgst), add(lineIgst, lineCess))
            : ZERO;
          const applicable = parseDec(
            facts.partyPan == null ? section.noPanRatePercent : section.ratePercent
          );
          const lineTcs = round2(divBy(mul(add(amount, lineGst), applicable), 100));
          tcsTotal = add(tcsTotal, lineTcs);
        }
      } else {
        notices.push({
          tone: "warning",
          title: `TCS section ${item.defaultTcsSection} is not on file`,
          body: `${label} carries that section but no active row exists for it in ref_tcs_sections, so create_invoice will collect no TCS on it. Nothing here is wrong — it just will not be collected.`,
        });
      }
    }

    const key = RATE_KEY(gstRate);
    const row = byRate.get(key) ?? {
      ratePercent: key,
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
      cess: 0,
      rcm: 0,
    };
    row.taxable = toNumber(round2(add(parseDec(row.taxable), amount)));
    row.cgst = toNumber(round2(add(parseDec(row.cgst), lineCgst)));
    row.sgst = toNumber(round2(add(parseDec(row.sgst), lineSgst)));
    row.igst = toNumber(round2(add(parseDec(row.igst), lineIgst)));
    row.cess = toNumber(round2(add(parseDec(row.cess), lineCess)));
    row.rcm = toNumber(round2(add(parseDec(row.rcm), lineRcm)));
    byRate.set(key, row);

    // The one comparison the totals table on the form cannot make: per LINE.
    if (line.readAmount != null) {
      const readAmount = parseDec(line.readAmount);
      const difference = sub(amount, readAmount);
      if (toNumber(difference) > 1 || toNumber(difference) < -1) {
        notices.push({
          tone: "warning",
          title: `${label} does not agree with the document`,
          body: `The bill shows ${toNumber(round2(readAmount)).toFixed(2)} against this line; what will post is ${toNumber(amount).toFixed(2)}. Check the quantity, the rate and the discount before this becomes a voucher.`,
        });
      }
    }
  });

  // create_invoice: `if v_taxable_total <= 0 then raise`.
  if (!isPositive(taxableTotal) && input.lines.length > 0) {
    blockers.push("An invoice must come to more than zero.");
  }

  const grandTotal = add(
    add(add(taxableTotal, cgstTotal), add(sgstTotal, igstTotal)),
    add(cessTotal, tcsTotal)
  );

  /* ---- the entries, in create_invoice's own insert order ----------------- */

  const entries: PreviewEntry[] = [];

  if (blockers.length === 0) {
    // line_order 0 — the party, at the WHOLE invoice including tax and TCS.
    entries.push({
      ledgerName: input.partyLedgerName,
      ledgerNote: null,
      debit: partySide === "debit" ? toNumber(grandTotal) : 0,
      credit: partySide === "credit" ? toNumber(grandTotal) : 0,
    });

    // line_order 1 — the trading ledger, at the taxable value only.
    entries.push({
      ledgerName: input.tradingLedgerName,
      ledgerNote: null,
      debit: partySide === "debit" ? 0 : toNumber(taxableTotal),
      credit: partySide === "debit" ? toNumber(taxableTotal) : 0,
    });

    if (gstOn) {
      // The VALUES list create_invoice loops over, in its order, skipping any
      // component that came to zero exactly as `where t.amt > 0` does.
      const components: [string, Dec][] = [
        ["cgst", cgstTotal],
        ["sgst", sgstTotal],
        ["igst", igstTotal],
        ["cess", cessTotal],
      ];
      for (const [kind, amt] of components) {
        if (!isPositive(amt)) continue;
        const purpose = `${taxPrefix}_${kind}`;
        const resolved = facts.taxLedgers[purpose] ?? null;
        if (!resolved) {
          blockers.push(
            `No ${taxPrefix} ${kind.toUpperCase()} ledger is mapped for this registration, so create_invoice refuses the post. Open Registrations → Tax ledgers and press Repair for this GSTIN.`
          );
          continue;
        }
        entries.push({
          ledgerName: resolved,
          ledgerNote: "resolved by the database from this registration's tax-ledger map",
          debit: partySide === "debit" ? 0 : toNumber(amt),
          credit: partySide === "debit" ? toNumber(amt) : 0,
        });
      }
    }

    if (isPositive(rcmTotal)) {
      const rcmLedger = facts.taxLedgers["rcm_payable"] ?? null;
      if (!rcmLedger) {
        blockers.push(
          "A line on this bill is flagged for reverse charge but no RCM Payable ledger is mapped for this registration, so create_invoice refuses the post. Open Registrations → Tax ledgers and press Repair for this GSTIN."
        );
      } else {
        entries.push({
          ledgerName: rcmLedger,
          ledgerNote: "resolved by the database from this registration's tax-ledger map",
          debit: 0,
          credit: toNumber(rcmTotal),
        });
        entries.push({
          ledgerName: input.tradingLedgerName,
          ledgerNote:
            "the matching debit for reverse charge — create_invoice capitalises it here, not into Input GST, because Sec 49(4) bars using it until it has actually been paid in cash",
          debit: toNumber(rcmTotal),
          credit: 0,
        });
      }
    }

    if (isPositive(tcsTotal)) {
      const tcsLedger = facts.taxLedgers["output_tcs"] ?? null;
      if (!tcsLedger) {
        blockers.push(
          "TCS is collectible on this invoice but no TCS Payable ledger is mapped for this company, so create_invoice refuses the post. Set a TAN in Settings — that provisions it."
        );
      } else {
        entries.push({
          ledgerName: tcsLedger,
          ledgerNote: "resolved by the database from this company's tax-ledger map",
          debit: partySide === "debit" ? 0 : toNumber(tcsTotal),
          credit: partySide === "debit" ? toNumber(tcsTotal) : 0,
        });
      }
    }
  }

  const debitTotal = toNumber(
    round2(entries.reduce((total, e) => add(total, parseDec(e.debit)), ZERO))
  );
  const creditTotal = toNumber(
    round2(entries.reduce((total, e) => add(total, parseDec(e.credit)), ZERO))
  );

  /* ---- what cannot be known until the insert happens --------------------- */

  unpredictable.push(
    "Whether the accounting period is still open. app_private.enforce_period_open fires on the voucher insert and can refuse the post after everything above has been agreed."
  );

  return {
    blockers: [...new Set(blockers)],
    supplyType,
    intrastate,
    entries: blockers.length === 0 ? entries : [],
    debitTotal: blockers.length === 0 ? debitTotal : 0,
    creditTotal: blockers.length === 0 ? creditTotal : 0,
    balanced: blockers.length === 0 && debitTotal === creditTotal,
    stock,
    taxRows: [...byRate.values()].sort((a, b) => a.ratePercent - b.ratePercent),
    totals: {
      taxable: toNumber(round2(taxableTotal)),
      cgst: toNumber(round2(cgstTotal)),
      sgst: toNumber(round2(sgstTotal)),
      igst: toNumber(round2(igstTotal)),
      cess: toNumber(round2(cessTotal)),
      tcs: toNumber(round2(tcsTotal)),
      rcm: toNumber(round2(rcmTotal)),
      grand: toNumber(round2(grandTotal)),
    },
    notices,
    unpredictable,
  };
}
