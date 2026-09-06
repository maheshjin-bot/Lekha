"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { Input, Label, Select } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { friendlyRegistrationError } from "@/lib/registrations/friendlyError";

type Registration = {
  id: string;
  gstin: string;
  state_code: string;
  registration_type: string;
  filing_frequency: string;
  registered_from: string;
  registered_to: string | null;
  is_active: boolean;
  legal_name: string | null;
  trade_name: string | null;
  lut_number: string | null;
  lut_valid_from: string | null;
  lut_valid_to: string | null;
  lut_arn: string | null;
};

type Branch = {
  id: string;
  code: string;
  name: string;
  state_code: string;
  gst_registration_id: string | null;
};

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// 0005's own check constraint, in the order a preparer meets them. 'regular'
// and 'composition' are the only two most companies will ever pick; the rest
// are here because the constraint allows them and a casual/ISD registration
// is a real thing a real business holds.
const REGISTRATION_TYPES = [
  { value: "regular", label: "Regular" },
  { value: "composition", label: "Composition (Sec 10)" },
  { value: "casual", label: "Casual taxable person" },
  { value: "non_resident", label: "Non-resident taxable person" },
  { value: "isd", label: "Input Service Distributor" },
  { value: "tds", label: "TDS deductor (Sec 51)" },
  { value: "tcs", label: "TCS collector (Sec 52)" },
] as const;

const FILING_FREQUENCIES = [
  { value: "monthly", label: "Monthly — GSTR-1 by the 11th, GSTR-3B by the 20th" },
  { value: "qrmp", label: "QRMP — quarterly GSTR-1 and GSTR-3B, monthly payment" },
] as const;

const typeLabel = (v: string) => REGISTRATION_TYPES.find((t) => t.value === v)?.label ?? v;

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

/**
 * The GST registrations screen. Three gaps closed here, all backed by
 * migration 1390 — read its header for the reasoning, this comment only
 * records what the UI does about it.
 *
 * 1. legal_name / trade_name had no writer anywhere in the app, so
 *    build_ewb_json emitted "fromTrdName": null on every payload it has ever
 *    built. Settable now both at creation and afterwards, with the copy
 *    saying explicitly that they are the names on the GST registration
 *    certificate — getting them wrong is what gets a payload rejected at the
 *    portal, so "close enough" is not good enough here.
 * 2. registered_to had no writer, so a surrendered GSTIN kept generating
 *    return due dates forever. Settable now, as a date, never a delete.
 * 3. add_gst_registration has taken p_registration_type and
 *    p_filing_frequency since 0018 and this form passed neither, freezing
 *    every registration at 'regular'/'monthly'. Both are on the create form
 *    now; filing_frequency is editable afterwards too, because QRMP is a
 *    quarterly election, and registration_type is not — see 1390's header.
 *
 * RPCs are called through callRpc because update_gst_registration is new and
 * add_gst_registration's signature changed in the same migration, so neither
 * matches types/database.types.ts yet. Regenerating that file mid-flight
 * would pull in other in-progress migrations' schema changes as well; it gets
 * regenerated on its own, which is exactly the case callRpc exists for.
 */
export function RegistrationManager({
  companyId,
  registrations,
  branches,
  states,
}: {
  companyId: string;
  registrations: Registration[];
  branches: Branch[];
  states: { code: string; name: string }[];
}) {
  const router = useRouter();
  const stateName = (code: string) => states.find((s) => s.code === code)?.name ?? code;
  const [gstin, setGstin] = useState("");
  const [registeredFrom, setRegisteredFrom] = useState(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  const [branchId, setBranchId] = useState("");
  const [newLegalName, setNewLegalName] = useState("");
  const [newTradeName, setNewTradeName] = useState("");
  const [newType, setNewType] = useState<string>("regular");
  const [newFrequency, setNewFrequency] = useState<string>("monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // LUT (Letter of Undertaking, Form GST RFD-11 under Rule 96A) is set per
  // registration, not at create time — it is usually filed months after the
  // GSTIN itself, and refiled every financial year, so this is an edit
  // affordance on an existing row rather than a field on the create form.
  const [lutEditId, setLutEditId] = useState<string | null>(null);
  const [lutNumber, setLutNumber] = useState("");
  const [lutFrom, setLutFrom] = useState("");
  const [lutTo, setLutTo] = useState("");
  const [lutArn, setLutArn] = useState("");
  const [lutBusy, setLutBusy] = useState(false);
  const [lutError, setLutError] = useState<string | null>(null);

  // The registration's own identity and lifecycle: the certificate names, the
  // QRMP election, and the surrender date.
  const [editId, setEditId] = useState<string | null>(null);
  const [editLegalName, setEditLegalName] = useState("");
  const [editTradeName, setEditTradeName] = useState("");
  const [editFrequency, setEditFrequency] = useState<string>("monthly");
  const [editRegisteredTo, setEditRegisteredTo] = useState("");
  const [editFrom, setEditFrom] = useState("");
  const [editOriginalFrequency, setEditOriginalFrequency] = useState<string>("monthly");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function openLutEdit(r: Registration) {
    setEditId(null);
    setLutEditId(r.id);
    setLutNumber(r.lut_number ?? "");
    setLutFrom(r.lut_valid_from ?? "");
    setLutTo(r.lut_valid_to ?? "");
    setLutArn(r.lut_arn ?? "");
    setLutError(null);
  }

  function openEdit(r: Registration) {
    setLutEditId(null);
    setEditId(r.id);
    setEditLegalName(r.legal_name ?? "");
    setEditTradeName(r.trade_name ?? "");
    setEditFrequency(r.filing_frequency);
    setEditOriginalFrequency(r.filing_frequency);
    setEditRegisteredTo(r.registered_to ?? "");
    setEditFrom(r.registered_from);
    setEditError(null);
  }

  async function onLutSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!lutEditId) return;
    setLutBusy(true);
    setLutError(null);

    const { error } = await createClient()
      .from("gst_registrations")
      .update({
        lut_number: lutNumber.trim() || null,
        lut_valid_from: lutFrom || null,
        lut_valid_to: lutTo || null,
        lut_arn: lutArn.trim() || null,
      })
      .eq("id", lutEditId);

    if (error) {
      setLutError(friendlyRegistrationError(error));
      setLutBusy(false);
      return;
    }

    setLutEditId(null);
    setLutBusy(false);
    toast.success("LUT saved.");
    router.refresh();
  }

  // The database refuses this too (gst_registrations_period_valid, and
  // update_gst_registration's own plain-English pre-check), but catching it
  // here saves a round trip on an obvious slip.
  const surrenderTooEarly = !!editRegisteredTo && !!editFrom && editRegisteredTo < editFrom;

  async function onEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editId) return;
    if (surrenderTooEarly) {
      setEditError(
        `The surrender date cannot be earlier than the date this GSTIN was registered from (${formatDate(editFrom)}).`
      );
      return;
    }
    setEditBusy(true);
    setEditError(null);

    const { error: rpcError } = await callRpc(createClient(), "update_gst_registration", {
      p_registration_id: editId,
      p_legal_name: editLegalName.trim() || null,
      p_trade_name: editTradeName.trim() || null,
      p_registered_to: editRegisteredTo || null,
      p_filing_frequency: editFrequency,
    });

    setEditBusy(false);
    if (rpcError) {
      setEditError(rpcError.message);
      return;
    }

    setEditId(null);
    toast.success("Registration saved.");
    router.refresh();
  }

  // Structural validity only — a well-formed but wrong GSTIN still reaches
  // the server, where the real checksum in app_private.is_valid_gstin decides.
  // This just saves a round trip on an obvious typo.
  const looksValid = GSTIN_PATTERN.test(gstin);

  // The state is literally the GSTIN's first two characters — no checksum
  // needed to read it — which is what lets the branch list narrow itself as
  // soon as the prefix is typed, before the rest of the number is even valid.
  const gstinState = gstin.length >= 2 ? gstin.slice(0, 2) : null;
  const eligibleBranches = branches.filter(
    (b) => !b.gst_registration_id && (gstinState === null || b.state_code === gstinState)
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error: rpcError } = await callRpc(createClient(), "add_gst_registration", {
      p_company_id: companyId,
      p_gstin: gstin,
      p_registered_from: registeredFrom,
      p_branch_id: branchId || null,
      p_registration_type: newType,
      p_filing_frequency: newFrequency,
      p_legal_name: newLegalName.trim() || null,
      p_trade_name: newTradeName.trim() || null,
    });

    if (rpcError) {
      setError(friendlyRegistrationError(rpcError, gstin));
      setBusy(false);
      return;
    }

    setGstin("");
    setBranchId("");
    setNewLegalName("");
    setNewTradeName("");
    setNewType("regular");
    setNewFrequency("monthly");
    setBusy(false);
    toast.success("Registration added.");
    router.refresh();
  }

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">GSTIN</th>
                <th className="px-4 py-2.5 font-medium">Name on certificate</th>
                <th className="px-4 py-2.5 font-medium">Type &amp; filing</th>
                <th className="px-4 py-2.5 font-medium">Branch</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">LUT</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {registrations.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
                    No registrations yet. GST stays off until one is added.
                  </td>
                </tr>
              )}
              {registrations.map((r) => {
                const attached = branches.find((b) => b.gst_registration_id === r.id);
                const today = new Date().toISOString().slice(0, 10);
                const lutActive =
                  !!r.lut_number &&
                  !!r.lut_valid_from &&
                  r.lut_valid_from <= today &&
                  (!r.lut_valid_to || r.lut_valid_to >= today);
                const certName = r.trade_name ?? r.legal_name;
                const surrendered = !!r.registered_to && r.registered_to < today;
                return (
                  <Fragment key={r.id}>
                    <tr className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5">
                        <div className="font-mono text-xs text-ink">{r.gstin}</div>
                        <div className="text-xs text-ink-faint">{stateName(r.state_code)}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        {certName ? (
                          <>
                            <div className="text-ink">{certName}</div>
                            {r.legal_name && r.trade_name && r.legal_name !== r.trade_name && (
                              <div className="text-xs text-ink-faint">Legal: {r.legal_name}</div>
                            )}
                          </>
                        ) : (
                          <Badge tone="warn">Missing — blocks e-way bills</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-ink-soft">
                        <div>{typeLabel(r.registration_type)}</div>
                        <div className="text-xs text-ink-faint">
                          {r.filing_frequency === "qrmp" ? "QRMP (quarterly)" : "Monthly"}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        {attached ? (
                          `${attached.code} — ${attached.name}`
                        ) : (
                          <span className="text-warning">Not attached — cannot invoice yet</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {r.registered_to ? (
                          <>
                            <Badge tone={surrendered ? "neutral" : "warn"}>
                              {surrendered ? "Surrendered" : "Surrendering"}
                            </Badge>
                            <div className="mt-0.5 text-xs text-ink-faint">
                              {surrendered ? "on " : "effective "}
                              {formatDate(r.registered_to)}
                            </div>
                          </>
                        ) : (
                          <>
                            <Badge tone="ok">Active</Badge>
                            <div className="mt-0.5 text-xs text-ink-faint">
                              from {formatDate(r.registered_from)}
                            </div>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => (lutEditId === r.id ? setLutEditId(null) : openLutEdit(r))}
                          className="text-xs underline decoration-dotted underline-offset-2 hover:text-accent"
                        >
                          {r.lut_number ? (
                            <span className={lutActive ? "text-ink-soft" : "text-warning"}>
                              {r.lut_number} {lutActive ? "" : "(expired/inactive)"}
                            </span>
                          ) : (
                            <span className="text-ink-faint">Not on file</span>
                          )}
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => (editId === r.id ? setEditId(null) : openEdit(r))}
                          className="text-xs font-medium text-accent hover:underline"
                        >
                          {editId === r.id ? "Cancel" : certName ? "Edit" : "Add names"}
                        </button>
                      </td>
                    </tr>

                    {editId === r.id && (
                      <tr className="border-b border-border bg-surface-2 last:border-0">
                        <td colSpan={7} className="px-4 py-4">
                          <form onSubmit={onEditSubmit} className="flex flex-col gap-4">
                            <div>
                              <h3 className="text-sm font-semibold text-ink">
                                Names on the GST registration certificate
                              </h3>
                              <p className="mt-1 max-w-2xl text-xs text-ink-soft">
                                Copy these exactly as they appear on Form REG-06 for{" "}
                                <span className="font-mono">{r.gstin}</span>. They are what LEKHA
                                sends as <span className="font-mono">fromTrdName</span> on an e-way
                                bill, and NIC rejects a payload whose name does not match the GSTIN
                                on record.
                              </p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <label className="flex flex-col gap-1.5">
                                <Label>Legal name</Label>
                                <Input
                                  value={editLegalName}
                                  onChange={(e) => setEditLegalName(e.target.value)}
                                  placeholder="As registered — usually the PAN holder's name"
                                />
                                <span className="text-xs text-ink-faint">
                                  The registered name of the business, i.e. the name the PAN is held
                                  in.
                                </span>
                              </label>
                              <label className="flex flex-col gap-1.5">
                                <Label>
                                  Trade name{" "}
                                  <span className="font-normal text-ink-faint">
                                    optional if the same
                                  </span>
                                </Label>
                                <Input
                                  value={editTradeName}
                                  onChange={(e) => setEditTradeName(e.target.value)}
                                  placeholder="The name you trade under"
                                />
                                <span className="text-xs text-ink-faint">
                                  Leave blank if it is the same as the legal name — the legal name is
                                  used in its place.
                                </span>
                              </label>
                            </div>

                            <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
                              <label className="flex flex-col gap-1.5">
                                <Label>Return filing frequency (QRMP)</Label>
                                <Select
                                  value={editFrequency}
                                  onChange={(e) => setEditFrequency(e.target.value)}
                                >
                                  {FILING_FREQUENCIES.map((f) => (
                                    <option key={f.value} value={f.value}>
                                      {f.label}
                                    </option>
                                  ))}
                                </Select>
                                <span className="text-xs text-ink-faint">
                                  QRMP is a quarterly election. This drives the GSTR-1 and GSTR-3B
                                  due dates on the compliance calendar.
                                </span>
                              </label>
                              <label className="flex flex-col gap-1.5">
                                <Label>
                                  Surrendered / cancelled on{" "}
                                  <span className="font-normal text-ink-faint">
                                    blank while active
                                  </span>
                                </Label>
                                <Input
                                  type="date"
                                  value={editRegisteredTo}
                                  min={editFrom}
                                  onChange={(e) => setEditRegisteredTo(e.target.value)}
                                  className={
                                    surrenderTooEarly ? "border-error focus-visible:border-error" : ""
                                  }
                                />
                                <span className="text-xs text-ink-faint">
                                  This is not a delete. Vouchers dated on or before this date stay
                                  valid and keep reporting in their own period exactly as they do
                                  now; from the next day this GSTIN stops generating return due
                                  dates. Registered from {formatDate(r.registered_from)}.
                                </span>
                              </label>
                            </div>

                            {editFrequency !== editOriginalFrequency && (
                              <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
                                LEKHA stores one filing frequency per registration and keeps no
                                history of it, so this change applies to past periods too: the
                                compliance calendar and the GSTR-3B interest / late-fee working will
                                recompute due dates for periods you have already filed on the{" "}
                                {editFrequency === "qrmp" ? "quarterly" : "monthly"} basis. Record
                                what you actually filed, and when, in the Filing register.
                              </p>
                            )}

                            <p className="text-xs text-ink-faint">
                              The GSTIN itself and the registration type (
                              {typeLabel(r.registration_type)}) are not editable. A
                              composition&nbsp;/&nbsp;regular change takes effect from a specific
                              date under Sec 10(3) and 10(5) — surrender this registration on that
                              date and add the new one from the day after, so each period reports
                              under the registration that was actually in force.
                            </p>

                            <div className="flex items-center gap-3">
                              <Button
                                type="submit"
                                busy={editBusy}
                                busyLabel="Saving…"
                                size="sm"
                                disabled={surrenderTooEarly}
                              >
                                Save
                              </Button>
                              <button
                                type="button"
                                onClick={() => setEditId(null)}
                                className="text-xs font-medium text-ink-soft hover:underline"
                              >
                                Cancel
                              </button>
                              {editError && <p className="text-xs text-error">{editError}</p>}
                            </div>
                          </form>
                        </td>
                      </tr>
                    )}

                    {lutEditId === r.id && (
                      <tr className="border-b border-border bg-surface-2 last:border-0">
                        <td colSpan={7} className="px-4 py-3">
                          <form onSubmit={onLutSubmit} className="flex flex-wrap items-end gap-3">
                            <label className="flex flex-col gap-1">
                              <span className="text-xs font-medium">LUT number (RFD-11)</span>
                              <Input
                                value={lutNumber}
                                onChange={(e) => setLutNumber(e.target.value)}
                                className="w-48"
                              />
                            </label>
                            <label className="flex flex-col gap-1">
                              <span className="text-xs font-medium">Valid from</span>
                              <Input
                                type="date"
                                value={lutFrom}
                                onChange={(e) => setLutFrom(e.target.value)}
                                className="w-auto"
                              />
                            </label>
                            <label className="flex flex-col gap-1">
                              <span className="text-xs font-medium">Valid to</span>
                              <Input
                                type="date"
                                value={lutTo}
                                onChange={(e) => setLutTo(e.target.value)}
                                className="w-auto"
                              />
                            </label>
                            <label className="flex flex-col gap-1">
                              <span className="text-xs font-medium">ARN</span>
                              <Input
                                value={lutArn}
                                onChange={(e) => setLutArn(e.target.value)}
                                className="w-40"
                              />
                            </label>
                            <Button type="submit" busy={lutBusy} busyLabel="Saving…" size="sm">
                              Save
                            </Button>
                            <button
                              type="button"
                              onClick={() => setLutEditId(null)}
                              className="text-xs font-medium text-ink-soft hover:underline"
                            >
                              Cancel
                            </button>
                            {lutError && <p className="w-full text-xs text-error">{lutError}</p>}
                            <p className="w-full text-xs text-ink-faint">
                              Filed annually (1 Apr – 31 Mar) on the GST portal. While active, a sale
                              to an Overseas or SEZ party on this registration goes out with zero GST
                              instead of full IGST — set the party&rsquo;s GST registration type on
                              the Ledgers page.
                            </p>
                          </form>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">New registration</h2>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">GSTIN</span>
            <Input
              required
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              maxLength={15}
              placeholder="27AAPFU0939F1ZV"
              className="font-mono"
            />
            {gstin.length === 15 && !looksValid && (
              <span className="text-xs text-warning">
                That doesn&rsquo;t match the GSTIN format.
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Legal name on the certificate</span>
            <Input
              value={newLegalName}
              onChange={(e) => setNewLegalName(e.target.value)}
              placeholder="As registered — usually the PAN holder's name"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Trade name <span className="font-normal text-ink-faint">optional if the same</span>
            </span>
            <Input
              value={newTradeName}
              onChange={(e) => setNewTradeName(e.target.value)}
              placeholder="The name you trade under"
            />
            <span className="text-xs text-ink-faint">
              Both are printed on Form REG-06. Copy them exactly — LEKHA sends the trade name (or
              the legal name if there is none) as <span className="font-mono">fromTrdName</span> on
              every e-way bill, and NIC rejects a payload where it is blank or does not match the
              GSTIN.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Registration type</span>
            <Select value={newType} onChange={(e) => setNewType(e.target.value)}>
              {REGISTRATION_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
            <span className="text-xs text-ink-faint">
              Set once, here. It cannot be changed later — a composition&nbsp;/&nbsp;regular switch
              is effective from a date, so it is done by surrendering this registration and adding
              the replacement from the day after.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Return filing frequency</span>
            <Select value={newFrequency} onChange={(e) => setNewFrequency(e.target.value)}>
              {FILING_FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
            <span className="text-xs text-ink-faint">
              Changeable later — QRMP is a quarterly election.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Registered from</span>
            <Input
              type="date"
              required
              value={registeredFrom}
              onChange={(e) => setRegisteredFrom(e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Attach to branch{" "}
              <span className="font-normal text-ink-faint">optional now, required to invoice</span>
            </span>
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">Not yet</option>
              {eligibleBranches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name} ({stateName(b.state_code)})
                </option>
              ))}
            </Select>
            <span className="text-xs text-ink-faint">
              {gstinState
                ? "Only unattached branches in this GSTIN's own state are listed — a branch elsewhere is refused by the database too."
                : "Start typing the GSTIN to narrow this to branches in its state."}
            </span>
          </label>

          {error && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
          )}

          <Button type="submit" busy={busy} busyLabel="Adding…" className="mt-1">
            Add registration
          </Button>
        </form>
      </section>
    </div>
  );
}
