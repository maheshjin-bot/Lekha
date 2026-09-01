"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/Modal";
import { friendlyLedgerError } from "@/lib/ledgers/friendlyError";

/**
 * The minimum a ledger needs to be transacted against, created without
 * leaving the entry screen you discovered it was missing from.
 *
 * Deliberately NOT a second LedgerManager. That form carries about twenty
 * fields — PAN, TDS deductee and section, LDC, MSME/Udyam, Sec 40(b), related
 * party and AS 18 relationship, Sec 269SS/T, Sec 43B category, GST
 * registration type. Every one of them matters at some point; none of them
 * matters at the moment a preparer is half-way through an invoice and finds
 * the customer does not exist yet. What is here is what a posting actually
 * needs: a name, a group (which is what decides how the ledger behaves in the
 * statements and whether it is even offered as a party), an opening balance,
 * and the two fields the invoice screen itself reads back — PAN (the TCS
 * no-PAN rate) and state (the place-of-supply default). Everything else is one
 * link away on the full screen, on a ledger that already exists by then.
 *
 * ============================================================================
 * `prefill`, AND WHY IT DOES NOT MAKE THIS FORM BIGGER
 * ============================================================================
 * OCR capture reads a whole party master off a photographed invoice — address,
 * PIN, two phone numbers, an email, GSTIN, PAN, a Udyam number, a bank block —
 * and until this prop existed it could only put those on COPY CHIPS beside the
 * "+ New" button, because this modal took no initial values at all
 * (components/capture/CaptureReviewForm.tsx's own header records that, and
 * asks for exactly this five-line prop). A preparer was left retyping a
 * fifteen-character GSTIN out of a popup that covers the text it came from.
 *
 * The reasoning above still holds for the OTHER two callers, though: the
 * invoice and voucher screens open this popup mid-entry and must not be handed
 * nine more boxes to look past. So the extra fields are rendered ONLY when a
 * prefill is passed. With no prefill this component renders and behaves
 * exactly as it did before the prop existed — same inputs, same defaults, same
 * insert — and that is the invariant to preserve when touching this file,
 * because a regression here breaks ordinary daily data entry, not capture.
 *
 * The extra fields are EDITABLE rather than a read-only "and we'll save these
 * too" summary. They were read by a vision model off a photograph; a misread
 * PIN or a transposed account digit has to be fixable at the moment it is
 * noticed, which is while the popup is open and the document is on screen.
 */

/**
 * Everything a caller can hand this popup to start from. Every field optional
 * and nullable — a caller that knows only a name passes only a name.
 *
 * Values are trusted to be SHAPED correctly (the capture analyzer normalises
 * each one to what its ledgers column accepts before it gets here) but are
 * still re-validated below, because "trusted" and "checked" are different
 * things and this popup is the last place a person can fix either.
 */
export type LedgerPrefill = {
  name?: string | null;
  gstin?: string | null;
  pan?: string | null;
  /** Two-digit GST state code, as in ref_states.code. */
  stateCode?: string | null;
  /** One of ledgers.gst_registration_type's values. */
  gstRegistrationType?: string | null;
  address?: string | null;
  city?: string | null;
  pincode?: string | null;
  phone?: string | null;
  email?: string | null;
  /** UDYAM-XX-00-0000000. Registration only — never a category. See below. */
  udyamNumber?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
};

export type QuickAddedLedger = {
  id: string;
  name: string;
  group_id: string;
  group_name: string;
  /** From the ledger's GROUP, not from ledgers.ledger_role — see below. */
  ledger_role: string;
  state_code: string | null;
  pan: string | null;
  gstin: string | null;
  gst_registration_type: string | null;
  opening_balance_amount: number;
  opening_balance_type: string;
};

type Group = {
  id: string;
  name: string;
  ledger_role: string | null;
  parent_group_id: string | null;
};

type StateOption = { code: string; name: string };

// Mirrors app_private.is_valid_pan exactly, same as LedgerManager's copy.
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// The shape half of app_private.is_valid_gstin. The check digit is the other
// half and is deliberately NOT reimplemented here — the database owns that
// arithmetic, and a second copy that drifted would reject numbers Postgres
// accepts. This catches the typo; ledgers_gstin_check catches the rest.
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * A GSTIN is a composite key: characters 1-2 are the state code and 3-12 are
 * the PAN. Deriving both from it (rather than asking for them again) is what
 * keeps this popup on the right side of ledgers_gstin_matches_state and
 * ledgers_gstin_matches_pan (0735) without the preparer having to know those
 * constraints exist.
 */
const stateFromGstin = (g: string) => (GSTIN_PATTERN.test(g) ? g.slice(0, 2) : "");
const panFromGstin = (g: string) => (GSTIN_PATTERN.test(g) ? g.slice(2, 12) : "");

/**
 * The three statuses that matter at entry time. The full eight
 * (composition, sez_developer, uin, deemed_export) live on the ledgers
 * screen — they change how tax is computed but not whether a number is
 * needed, which is the only question this popup has to settle.
 */
const GST_STATUSES = [
  { value: "regular", label: "Registered", needsGstin: true },
  { value: "unregistered", label: "Unregistered / consumer", needsGstin: false },
  { value: "overseas", label: "Overseas (export)", needsGstin: false },
] as const;

/**
 * The group a role's ledgers conventionally live under, when the company has
 * more than one candidate. Confirmed live on Sharma Textiles: `debtor` covers
 * three groups (Sundry Debtors, Export Debtors, Export Debtors - USA), so
 * "first match wins" would have quietly filed an ordinary domestic customer
 * under Export Debtors and mis-stated the balance sheet grouping.
 */
const CONVENTIONAL_GROUP_BY_ROLE: Record<string, string> = {
  debtor: "Sundry Debtors",
  creditor: "Sundry Creditors",
};

/*
 * The rest of the ledgers CHECK constraints this popup can now write into,
 * each mirrored here for the same reason PAN_PATTERN and GSTIN_PATTERN above
 * already are: so a bad value reads as a sentence in the preparer's own terms
 * rather than as a constraint name after a round trip. The database is still
 * the authority — every one of these is enforced there too.
 */
/** ledgers_pincode_check. */
const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;
/** ledgers_email_check. */
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
/** app_private.is_valid_udyam, via ledgers_udyam_number_check. */
const UDYAM_PATTERN = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
/** app_private.is_valid_ifsc, via ledgers_bank_ifsc_check (0995). */
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
/** ledgers_bank_account_number_check (0995), same charset as 0800's. */
const ACCOUNT_PATTERN = /^[A-Za-z0-9]{5,34}$/;

export function QuickAddLedgerModal({
  open,
  onClose,
  companyId,
  title,
  description,
  roles,
  prefill,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  title: string;
  description?: string;
  /**
   * Restricts which account groups are offered, by the group's ledger_role.
   * The invoice screen passes ["debtor"] for a customer and ["creditor"] for
   * a supplier, because its own party dropdown filters on exactly that (the
   * role comes from a JOIN to account_groups, never from a column on the
   * ledger) — a ledger created under the wrong group would not appear in the
   * dropdown it was created from. Omitted on the journal screen, where a line
   * may legitimately hit any ledger at all.
   */
  roles?: readonly string[];
  /**
   * Values to start from, and the switch that reveals the extra fields — see
   * the file header. Omit it and this popup is byte-for-byte the popup the
   * invoice and voucher screens have always opened.
   */
  prefill?: LedgerPrefill;
  onCreated: (ledger: QuickAddedLedger) => void;
}) {
  // null means "not fetched yet" — which is also what drives the loading
  // state below, so nothing has to be set synchronously inside the effect.
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [states, setStates] = useState<StateOption[]>([]);
  const loading = open && groups === null;

  const [name, setName] = useState("");
  // The group the user picked by hand, if any. The effective group is derived
  // below — storing only the override is what keeps a hand-picked group from
  // being stamped back to the default on the next keystroke.
  const [groupIdOverride, setGroupIdOverride] = useState<string | null>(null);
  const [opening, setOpening] = useState("0");
  const [openingType, setOpeningType] = useState<"debit" | "credit">("debit");
  const [pan, setPan] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [gstStatus, setGstStatus] = useState("");
  const [gstin, setGstin] = useState("");
  // The prefill-only fields. Declared unconditionally (hooks must be), but
  // only ever rendered, validated or written when `prefill` was passed, so
  // they cost the invoice and voucher screens nothing but eleven empty
  // strings.
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [pincode, setPincode] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [udyam, setUdyam] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankIfsc, setBankIfsc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reference data is fetched here rather than threaded down as props from the
  // page, because the two screens this modal serves are served by two pages
  // and only one of them already fetches account groups. Fetching on open (not
  // on mount) keeps a screen that never opens the modal from paying for it.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [{ data: g }, { data: s }] = await Promise.all([
        supabase
          .from("account_groups")
          .select("id, name, ledger_role, parent_group_id")
          .eq("company_id", companyId)
          .order("sort_order"),
        supabase.from("ref_states").select("code, name").order("name"),
      ]);
      if (cancelled) return;
      setGroups(g ?? []);
      setStates(s ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, companyId]);

  /*
   * Seeding from the prefill — during render, not in an effect, and keyed on
   * the CONTENT of the prefill rather than on its identity. Both of those are
   * deliberate.
   *
   * NOT AN EFFECT: this is React's own "adjusting state when a prop changes"
   * pattern (react.dev, You Might Not Need an Effect). Seeding in an effect
   * would paint the popup empty for one frame and then fill it, and the
   * project's react-hooks/set-state-in-effect rule refuses it outright.
   * Setting state during render of THIS component is the supported form:
   * React discards the in-progress render and re-runs it before committing
   * anything to the DOM.
   *
   * KEYED ON CONTENT: callers build this object inline from an extraction — a
   * fresh object every render — so comparing identities would reseed on every
   * keystroke in the parent form and stamp the preparer's corrections back to
   * the model's readings. A JSON string of the values reseeds only when the
   * values themselves change.
   *
   * `open` is folded into the key so that CLOSING the popup clears the seed
   * marker and a second open starts from the prefill again; reset() has
   * emptied the fields by then, and a popup that opened blank the second time
   * would look broken.
   *
   * With no prefill activeKey is "" and the only thing that ever happens here
   * is clearing a marker that is already clear — which is the whole
   * no-prefill guarantee.
   */
  const prefillKey = prefill ? JSON.stringify(prefill) : "";
  const activeKey = open ? prefillKey : "";
  const [seededKey, setSeededKey] = useState("");
  if (activeKey !== seededKey) {
    setSeededKey(activeKey);
    if (activeKey) seedFromPrefill(JSON.parse(activeKey) as LedgerPrefill);
  }

  function seedFromPrefill(p: LedgerPrefill) {
    const g = (p.gstin ?? "").toUpperCase().slice(0, 15);

    setName(p.name ?? "");
    setGstin(g);
    // State and PAN follow the GSTIN when there is one, exactly as typing it
    // by hand does below — that is what keeps ledgers_gstin_matches_state and
    // ledgers_gstin_matches_pan (0735) satisfied without the caller having to
    // know they exist. The caller's own values are used only where the GSTIN
    // cannot supply one.
    setStateCode(stateFromGstin(g) || (p.stateCode ?? ""));
    setPan(panFromGstin(g) || (p.pan ?? "").toUpperCase());
    // A fifteen-character GSTIN on a document IS a claim to be registered, and
    // "regular" is what that means in all but the composition/SEZ/UIN corners
    // the dropdown two lines away offers. Preselecting it beats leaving the
    // strongest fact on the page as "Not stated"; the caller may override.
    setGstStatus(p.gstRegistrationType ?? (g ? "regular" : ""));
    setAddress(p.address ?? "");
    setCity(p.city ?? "");
    setPincode(p.pincode ?? "");
    setPhone(p.phone ?? "");
    setEmail(p.email ?? "");
    setUdyam((p.udyamNumber ?? "").toUpperCase());
    setBankName(p.bankName ?? "");
    setBankAccount(p.bankAccountNumber ?? "");
    setBankIfsc((p.bankIfsc ?? "").toUpperCase());
  }

  // A value, not an array identity. Callers naturally write roles={["debtor"]}
  // inline, which is a fresh array every render, so anything memoised on the
  // array itself would recompute on every keystroke.
  const rolesKey = roles ? roles.join(",") : "";

  const candidates = useMemo(() => {
    const all = groups ?? [];
    if (!rolesKey) {
      // Unrestricted: the eight primary groups are structural, so a ledger
      // normally belongs to a sub-group. Both are still offered — a company
      // may genuinely post directly to a primary group — but the default
      // below prefers a sub-group, same as LedgerManager does.
      return all;
    }
    const wanted = rolesKey.split(",");
    return all.filter((g) => g.ledger_role && wanted.includes(g.ledger_role));
  }, [groups, rolesKey]);

  // The conventional group for the role if this company has one by that name,
  // else the first sub-group, else the first candidate at all. Derived rather
  // than stored, so it simply follows the candidate set instead of needing an
  // effect to chase it.
  const defaultGroupId = useMemo(() => {
    if (!candidates.length) return "";
    const wanted = (rolesKey ? rolesKey.split(",") : [])
      .map((r) => CONVENTIONAL_GROUP_BY_ROLE[r])
      .filter(Boolean);
    const conventional = candidates.find((g) =>
      wanted.some((w) => g.name.trim().toLowerCase() === w.toLowerCase())
    );
    const fallback = candidates.find((g) => g.parent_group_id) ?? candidates[0];
    return (conventional ?? fallback).id;
  }, [candidates, rolesKey]);

  // An override only counts while it is still one of the candidates — switch
  // a sales invoice to a purchase bill with the popup open and the debtor
  // group picked a moment ago is no longer on offer.
  const groupId =
    groupIdOverride && candidates.some((g) => g.id === groupIdOverride)
      ? groupIdOverride
      : defaultGroupId;

  const panLooksValid = pan.length === 0 || PAN_PATTERN.test(pan);

  // GST status only matters for a trading party. A journal line hitting Bank
  // Charges has no GST registration, and asking would be noise — so the whole
  // block is hidden unless this popup was opened for a debtor or creditor.
  const isParty = rolesKey
    .split(",")
    .some((r) => r === "debtor" || r === "creditor");
  const gstStatusMeta = GST_STATUSES.find((g) => g.value === gstStatus);
  const gstinRequired = !!gstStatusMeta?.needsGstin;
  const gstinLooksValid = gstin.length === 0 || GSTIN_PATTERN.test(gstin);
  const selectedGroup = candidates.find((g) => g.id === groupId);

  function reset() {
    setName("");
    setGroupIdOverride(null);
    setOpening("0");
    setOpeningType("debit");
    setPan("");
    setStateCode("");
    setGstStatus("");
    setGstin("");
    setAddress("");
    setCity("");
    setPincode("");
    setPhone("");
    setEmail("");
    setUdyam("");
    setBankName("");
    setBankAccount("");
    setBankIfsc("");
    setError(null);
  }

  async function submit() {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) return setError("Give the ledger a name.");
    if (!groupId || !selectedGroup) return setError("Pick a group.");
    if (!panLooksValid)
      return setError("That doesn't match the PAN format (5 letters, 4 digits, 1 letter).");
    // The rule the database will enforce anyway (ledgers_registered_has_gstin,
    // 0735), stated here in the preparer's own terms rather than surfacing as
    // a constraint name after a round trip.
    if (gstinRequired && !gstin.trim())
      return setError(
        "A registered party needs its GSTIN — it is what puts the invoice in the B2B tables of GSTR-1 rather than B2C."
      );
    if (gstin.trim() && !GSTIN_PATTERN.test(gstin.trim()))
      return setError(
        "That doesn't look like a GSTIN (15 characters: 2-digit state, 10-character PAN, then 3 more)."
      );

    /*
     * The prefill-only fields. Every check here is a ledgers CHECK constraint
     * said in words — and every one of them is skipped entirely when there is
     * no prefill, because then the inputs were never rendered and the state
     * is empty anyway. Stated as an explicit guard rather than relying on
     * that, so the no-prefill path is provably unchanged.
     */
    if (prefill) {
      if (pincode.trim() && !PINCODE_PATTERN.test(pincode.trim()))
        return setError("A PIN code is six digits and cannot start with a zero.");
      if (email.trim() && !EMAIL_PATTERN.test(email.trim()))
        return setError("That doesn't look like an email address.");
      if (udyam.trim() && !UDYAM_PATTERN.test(udyam.trim().toUpperCase()))
        return setError(
          "A Udyam number reads UDYAM-XX-00-0000000 — two letters for the state, two digits for the district, then seven digits."
        );
      if (bankAccount.trim() && !ACCOUNT_PATTERN.test(bankAccount.trim()))
        return setError("A bank account number is 5 to 34 letters or digits, with no spaces.");
      if (bankIfsc.trim() && !IFSC_PATTERN.test(bankIfsc.trim().toUpperCase()))
        return setError(
          "An IFSC is 11 characters: four letters, then a zero, then six more (e.g. HDFC0003127)."
        );
      // ledgers_bank_block_anchored (0995) — the account number is what the
      // rest of the bank block hangs on, so say that rather than let the
      // constraint name come back from Postgres.
      if (!bankAccount.trim() && (bankName.trim() || bankIfsc.trim()))
        return setError(
          "A bank name or IFSC can only be saved together with the account number they belong to — add the account number, or clear both."
        );
    }

    setBusy(true);
    setError(null);

    const { data, error: insertError } = await createClient()
      .from("ledgers")
      .insert({
        company_id: companyId,
        group_id: groupId,
        name: trimmed,
        opening_balance_amount: Number(opening) || 0,
        opening_balance_type: openingType,
        pan: pan.trim() || null,
        state_code: stateCode || null,
        gstin: gstin.trim() || null,
        gst_registration_type: gstStatus || null,
        // The prefill block. Written as an explicit spread of an empty object
        // when there is no prefill, so the insert payload of the invoice and
        // voucher screens is EXACTLY the payload it was before this prop
        // existed — not the same payload with eleven nulls added, which would
        // overwrite nothing today but is a different statement.
        ...(prefill
          ? {
              address: address.trim() || null,
              city: city.trim() || null,
              pincode: pincode.trim() || null,
              phone: phone.trim() || null,
              email: email.trim() || null,
              // Registration only. No msme_category and no msme_payment_days
              // are written from here, ever: a Udyam number proves a supplier
              // is on the MSME register and says nothing about whether it is
              // micro, small or medium — and Sec 43B(h) bites only for micro
              // and small. The tier is set by a human on the ledgers screen;
              // the capture review screen says so in those words. See 0995.
              udyam_number: udyam.trim().toUpperCase() || null,
              // 0995's three columns are newer than types/database.types.ts,
              // which this task does not regenerate — the established hatch.
              // The bank name and IFSC are forced to null when there is no
              // account number, mirroring ledgers_bank_block_anchored: submit
              // has already refused that combination, so this only guarantees
              // the payload can never be the shape the constraint rejects.
              ...({
                bank_name: bankAccount.trim() ? bankName.trim() || null : null,
                bank_account_number: bankAccount.trim() || null,
                bank_ifsc: bankAccount.trim() ? bankIfsc.trim().toUpperCase() || null : null,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ledgers.bank_* is new (0995), not yet in generated types
              } as any),
            }
          : {}),
      })
      // Reading the row straight back is what makes the local merge possible:
      // the caller cannot select an id it has not been told about, and
      // router.refresh() alone is a race against the server re-fetch.
      .select(
        "id, name, group_id, state_code, pan, gstin, gst_registration_type, opening_balance_amount, opening_balance_type"
      )
      .single();

    if (insertError || !data) {
      // Shared with LedgerManager.tsx's own "New ledger" form — see
      // lib/ledgers/friendlyError.ts's header for why this moved out of
      // being written inline here a second time.
      setError(
        insertError ? friendlyLedgerError(insertError, trimmed) : "The ledger could not be created."
      );
      setBusy(false);
      return;
    }

    onCreated({
      id: data.id,
      name: data.name,
      group_id: data.group_id,
      group_name: selectedGroup.name,
      ledger_role: selectedGroup.ledger_role ?? "other",
      state_code: data.state_code,
      pan: data.pan,
      gstin: data.gstin,
      gst_registration_type: data.gst_registration_type,
      opening_balance_amount: Number(data.opening_balance_amount),
      opening_balance_type: data.opening_balance_type,
    });
    reset();
    setBusy(false);
    onClose();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={title}
      description={description}
      className="max-w-lg"
    >
      {/*
        A plain div, not a <form>. This modal is rendered from inside the
        invoice/voucher <form>, and a nested form would let its own submit
        event bubble to the outer one and save a half-typed invoice. The Enter
        handler below does the same job without that hazard — and its
        preventDefault is what stops an Enter in any of these inputs from
        implicitly submitting the OUTER form, which is what would otherwise
        happen to an <input> sitting inside it.
      */}
      <div
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          e.stopPropagation();
          void submit();
        }}
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={field}
          />
        </label>

        {loading ? (
          <p className="text-sm text-ink-faint">Loading groups…</p>
        ) : candidates.length === 0 ? (
          <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
            This company has no account group that can hold this kind of ledger.
            Create one on the ledgers screen first.
          </p>
        ) : candidates.length === 1 ? (
          // One candidate is not a choice — showing a select with a single
          // option only invites a click that changes nothing.
          <p className="text-sm text-ink-soft">
            Group: <span className="font-medium text-ink">{candidates[0].name}</span>
          </p>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Group</span>
            <select
              value={groupId}
              onChange={(e) => setGroupIdOverride(e.target.value)}
              className={field}
            >
              {candidates.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.parent_group_id ? "  " : ""}
                  {g.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-faint">
              The group decides how this ledger appears in the statements — and
              whether it is offered here at all.
            </span>
          </label>
        )}

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Opening balance{" "}
              <span className="font-normal text-ink-faint">optional</span>
            </span>
            <input
              inputMode="decimal"
              value={opening}
              onChange={(e) => setOpening(e.target.value)}
              className={field + " text-right tabular-nums"}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Side</span>
            <select
              value={openingType}
              onChange={(e) => setOpeningType(e.target.value as "debit" | "credit")}
              className={field}
            >
              <option value="debit">Dr</option>
              <option value="credit">Cr</option>
            </select>
          </label>
        </div>

        {isParty && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">GST status</span>
              <select
                value={gstStatus}
                onChange={(e) => {
                  const next = e.target.value;
                  setGstStatus(next);
                  // Clearing the number when the party stops being registered
                  // is what keeps ledgers_unregistered_has_no_gstin (0735)
                  // satisfiable without the preparer having to notice.
                  const stillNeeds = GST_STATUSES.find(
                    (g) => g.value === next
                  )?.needsGstin;
                  if (!stillNeeds) setGstin("");
                }}
                className={field}
              >
                <option value="">Not stated</option>
                {GST_STATUSES.map((g) => (
                  <option key={g.value} value={g.value}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                GSTIN{" "}
                <span className="font-normal text-ink-faint">
                  {gstinRequired ? "required" : "optional"}
                </span>
              </span>
              <input
                value={gstin}
                onChange={(e) => {
                  const next = e.target.value.toUpperCase().slice(0, 15);
                  setGstin(next);
                  // State and PAN are literally inside the GSTIN, so fill them
                  // from it rather than asking twice and risking a mismatch the
                  // database would then refuse.
                  const st = stateFromGstin(next);
                  if (st) setStateCode(st);
                  const pn = panFromGstin(next);
                  if (pn) setPan(pn);
                }}
                maxLength={15}
                placeholder="07AAAAA0000A1Z5"
                className={field + " font-mono uppercase"}
              />
              {gstin.length > 0 && !gstinLooksValid ? (
                <span className="text-xs text-warning">
                  A GSTIN is 15 characters: 2-digit state, 10-character PAN,
                  then 3 more.
                </span>
              ) : (
                <span className="text-xs text-ink-faint">
                  {gstinRequired
                    ? "Required for a registered party — it is what puts this invoice in GSTR-1 B2B rather than B2C."
                    : "Fills in state and PAN automatically."}
                </span>
              )}
            </label>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              PAN <span className="font-normal text-ink-faint">optional</span>
            </span>
            <input
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              maxLength={10}
              placeholder="AAAAA0000A"
              className={field + " font-mono uppercase"}
            />
            {pan.length > 0 && !panLooksValid && (
              <span className="text-xs text-warning">
                That doesn&rsquo;t match the PAN format (5 letters, 4 digits, 1
                letter).
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              State <span className="font-normal text-ink-faint">optional</span>
            </span>
            <select
              value={stateCode}
              onChange={(e) => setStateCode(e.target.value)}
              className={field}
            >
              <option value="">Not set</option>
              {states.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-faint">
              Sets the place of supply an invoice to this party defaults to.
            </span>
          </label>
        </div>

        {/*
          Everything below is rendered ONLY for a caller that passed a prefill.
          The invoice and voucher screens do not, and see the popup they have
          always seen. See the file header.
        */}
        {prefill && (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2/50 p-3">
            <div>
              <p className="text-sm font-medium text-ink">Also read off the document</p>
              <p className="mt-0.5 text-xs text-ink-faint">
                Saved onto this party as well. Correct anything the reader got wrong — the
                document is still on screen behind this popup, and this is the last easy
                moment to fix it.
              </p>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Address</span>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className={field}
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Town / city</span>
                <input value={city} onChange={(e) => setCity(e.target.value)} className={field} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">PIN code</span>
                <input
                  value={pincode}
                  onChange={(e) => setPincode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                  inputMode="numeric"
                  maxLength={6}
                  className={field + " font-mono"}
                />
                {pincode.length > 0 && !PINCODE_PATTERN.test(pincode) && (
                  <span className="text-xs text-warning">
                    Six digits, and it cannot start with a zero.
                  </span>
                )}
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Phone</span>
                <input value={phone} onChange={(e) => setPhone(e.target.value)} className={field} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Email</span>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  inputMode="email"
                  className={field}
                />
                {email.length > 0 && !EMAIL_PATTERN.test(email) && (
                  <span className="text-xs text-warning">That is not a usable address.</span>
                )}
              </label>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Udyam / MSME registration{" "}
                <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input
                value={udyam}
                onChange={(e) => setUdyam(e.target.value.toUpperCase())}
                placeholder="UDYAM-GJ-22-0090672"
                maxLength={22}
                className={field + " font-mono uppercase"}
              />
              {udyam.length > 0 && !UDYAM_PATTERN.test(udyam) ? (
                <span className="text-xs text-warning">
                  A Udyam number reads UDYAM-XX-00-0000000.
                </span>
              ) : udyam.length > 0 ? (
                // The honest statement of what this number does and does not
                // buy. Sec 43B(h) disallows a deduction only for a MICRO or
                // SMALL supplier; the Udyam number proves registration and
                // carries no tier, and the MSME dues report filters on
                // msme_category after selecting on udyam_number — so without
                // the tier this supplier is on file and out of that report.
                <span className="text-xs text-ink-faint">
                  This proves they are on the MSME register. It does{" "}
                  <span className="text-ink-soft">not</span> say whether they are micro,
                  small or medium, and the invoice does not either — so set the category on
                  the ledgers screen. Until it is set, this supplier will not appear in the
                  Sec 43B(h) MSME dues report, which covers micro and small only.
                </span>
              ) : (
                <span className="text-xs text-ink-faint">
                  Printed on the invoice if the supplier is MSME-registered.
                </span>
              )}
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Their bank <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="Bank and branch"
                className={field}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <input
                    value={bankAccount}
                    onChange={(e) => setBankAccount(e.target.value.replace(/[\s-]/g, ""))}
                    placeholder="Account number"
                    maxLength={34}
                    className={field + " font-mono"}
                  />
                  {bankAccount.length > 0 && !ACCOUNT_PATTERN.test(bankAccount) && (
                    <span className="text-xs text-warning">
                      5 to 34 letters or digits, no spaces.
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <input
                    value={bankIfsc}
                    onChange={(e) => setBankIfsc(e.target.value.toUpperCase().slice(0, 11))}
                    placeholder="IFSC"
                    maxLength={11}
                    className={field + " font-mono uppercase"}
                  />
                  {bankIfsc.length > 0 && !IFSC_PATTERN.test(bankIfsc) && (
                    <span className="text-xs text-warning">
                      Eleven characters, e.g. HDFC0003127.
                    </span>
                  )}
                </div>
              </div>
              <span className="text-xs text-ink-faint">
                {!bankAccount.trim() && (bankName.trim() || bankIfsc.trim())
                  ? "The account number is what the rest of this hangs on — add it, or clear the bank and IFSC."
                  : "Kept on the party record. LEKHA does not pay anybody: nothing here initiates a transfer."}
              </span>
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">
            {error}
          </p>
        )}

        <div className="mt-1 flex items-center justify-between gap-4">
          <Link
            href={`/${companyId}/ledgers`}
            className="text-xs text-accent underline underline-offset-4"
          >
            More options — TDS, MSME, GST type, related party…
          </Link>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                reset();
                onClose();
              }}
              className="rounded-lg border border-border-strong px-3 py-2 text-sm text-ink-soft transition-colors hover:bg-surface-2"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || loading || candidates.length === 0}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create and select"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
