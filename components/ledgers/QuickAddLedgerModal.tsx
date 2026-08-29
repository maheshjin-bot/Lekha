"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/Modal";

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
 */

export type QuickAddedLedger = {
  id: string;
  name: string;
  group_id: string;
  group_name: string;
  /** From the ledger's GROUP, not from ledgers.ledger_role — see below. */
  ledger_role: string;
  state_code: string | null;
  pan: string | null;
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

export function QuickAddLedgerModal({
  open,
  onClose,
  companyId,
  title,
  description,
  roles,
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
  const selectedGroup = candidates.find((g) => g.id === groupId);

  function reset() {
    setName("");
    setGroupIdOverride(null);
    setOpening("0");
    setOpeningType("debit");
    setPan("");
    setStateCode("");
    setError(null);
  }

  async function submit() {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) return setError("Give the ledger a name.");
    if (!groupId || !selectedGroup) return setError("Pick a group.");
    if (!panLooksValid)
      return setError("That doesn't match the PAN format (5 letters, 4 digits, 1 letter).");

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
      })
      // Reading the row straight back is what makes the local merge possible:
      // the caller cannot select an id it has not been told about, and
      // router.refresh() alone is a race against the server re-fetch.
      .select("id, name, group_id, state_code, pan, opening_balance_amount, opening_balance_type")
      .single();

    if (insertError || !data) {
      setError(
        insertError?.code === "23505"
          ? `This company already has a ledger called "${trimmed}".`
          : insertError?.message ?? "The ledger could not be created."
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
