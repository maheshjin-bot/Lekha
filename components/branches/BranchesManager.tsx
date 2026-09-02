"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { Input, Label, Select } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

type Branch = {
  id: string;
  code: string;
  name: string;
  state_code: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  pincode: string | null;
  is_head_office: boolean;
};

const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;

/**
 * Sets address_line1/address_line2/city/pincode on a branch via update_branch
 * (1320) — the one entry point build_einvoice_json (0230) and build_ewb_json
 * (1310) have been asking for since either was written. Table + inline
 * edit-row expansion, same shape as RegistrationManager.tsx's LUT editor.
 */
export function BranchesManager({
  companyId,
  branches,
  states,
}: {
  companyId: string;
  branches: Branch[];
  states: { code: string; name: string }[];
}) {
  const router = useRouter();
  const stateName = (code: string | null) => (code ? states.find((s) => s.code === code)?.name ?? code : "—");

  const [editId, setEditId] = useState<string | null>(null);
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [pincode, setPincode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adding a branch (1570). Its own state, so opening the New-branch form
  // doesn't disturb an address edit already in progress on a row above.
  const [adding, setAdding] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newState, setNewState] = useState("");
  const [newLine1, setNewLine1] = useState("");
  const [newCity, setNewCity] = useState("");
  const [newPincode, setNewPincode] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  function openEdit(b: Branch) {
    setEditId(b.id);
    setLine1(b.address_line1 ?? "");
    setLine2(b.address_line2 ?? "");
    setCity(b.city ?? "");
    setPincode(b.pincode ?? "");
    setError(null);
  }

  const pincodeLooksValid = pincode.trim().length === 0 || PINCODE_PATTERN.test(pincode.trim());

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editId) return;
    if (!pincodeLooksValid) {
      setError("PIN code must be 6 digits and cannot start with 0.");
      return;
    }
    setBusy(true);
    setError(null);

    const { error: rpcError } = await callRpc(createClient(), "update_branch", {
      p_branch_id: editId,
      p_address_line1: line1.trim() || null,
      p_address_line2: line2.trim() || null,
      p_city: city.trim() || null,
      p_pincode: pincode.trim() || null,
    });

    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setEditId(null);
    toast.success("Address saved.");
    router.refresh();
  }

  const newCodeLooksValid = newCode.length === 0 || /^[A-Z0-9]{1,6}$/.test(newCode);
  const newPincodeLooksValid =
    newPincode.trim().length === 0 || PINCODE_PATTERN.test(newPincode.trim());
  const canAdd =
    newCode.length > 0 && newCodeLooksValid && newName.trim().length > 0 && newState.length > 0 && newPincodeLooksValid;

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!canAdd) return;
    setAddBusy(true);
    setAddError(null);

    const { error: rpcError } = await callRpc(createClient(), "create_branch", {
      p_company_id: companyId,
      p_code: newCode,
      p_name: newName.trim(),
      p_state_code: newState,
      p_address_line1: newLine1.trim() || null,
      p_city: newCity.trim() || null,
      p_pincode: newPincode.trim() || null,
    });

    setAddBusy(false);
    if (rpcError) {
      setAddError(rpcError.message);
      return;
    }

    setAdding(false);
    setNewCode("");
    setNewName("");
    setNewState("");
    setNewLine1("");
    setNewCity("");
    setNewPincode("");
    toast.success("Branch added.");
    router.refresh();
  }

  const field = "font-mono";

  return (
    <div className="flex flex-col gap-4">
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
            <th className="px-4 py-2.5 font-medium">Branch</th>
            <th className="px-4 py-2.5 font-medium">State</th>
            <th className="px-4 py-2.5 font-medium">Address on file</th>
            <th className="px-4 py-2.5 font-medium" />
          </tr>
        </thead>
        <tbody>
          {branches.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-10 text-center text-ink-faint">
                This company has no branches on record.
              </td>
            </tr>
          )}
          {branches.map((b) => {
            const complete = !!b.address_line1 && !!b.city && !!b.pincode;
            return (
              <Fragment key={b.id}>
                <tr className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-ink">
                      {b.name}
                      {b.is_head_office && (
                        <Badge tone="accent" className="ml-2 align-middle">
                          Head office
                        </Badge>
                      )}
                    </div>
                    <div className="font-mono text-xs text-ink-faint">{b.code}</div>
                  </td>
                  <td className="px-4 py-2.5 text-ink-soft">{stateName(b.state_code)}</td>
                  <td className="px-4 py-2.5">
                    {complete ? (
                      <span className="text-ink-soft">
                        {[b.address_line1, b.address_line2, b.city, b.pincode].filter(Boolean).join(", ")}
                      </span>
                    ) : (
                      <Badge tone="warn">Incomplete — blocks e-invoicing</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => (editId === b.id ? setEditId(null) : openEdit(b))}
                      className="text-xs font-medium text-accent hover:underline"
                    >
                      {editId === b.id ? "Cancel" : complete ? "Edit" : "Add address"}
                    </button>
                  </td>
                </tr>
                {editId === b.id && (
                  <tr className="border-b border-border bg-surface-2 last:border-0">
                    <td colSpan={4} className="px-4 py-4">
                      <form onSubmit={onSave} className="flex flex-col gap-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="flex flex-col gap-1.5">
                            <Label>Address line 1</Label>
                            <Input
                              value={line1}
                              onChange={(e) => setLine1(e.target.value)}
                              placeholder="Building, street"
                              className={field}
                            />
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <Label>
                              Address line 2 <span className="font-normal text-ink-faint">optional</span>
                            </Label>
                            <Input
                              value={line2}
                              onChange={(e) => setLine2(e.target.value)}
                              placeholder="Area, landmark"
                              className={field}
                            />
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <Label>City</Label>
                            <Input value={city} onChange={(e) => setCity(e.target.value)} className={field} />
                          </label>
                          <label className="flex flex-col gap-1.5">
                            <Label>PIN code</Label>
                            <Input
                              value={pincode}
                              onChange={(e) => setPincode(e.target.value)}
                              placeholder="400001"
                              maxLength={6}
                              className={
                                field + " " + (pincodeLooksValid ? "" : "border-error focus-visible:border-error")
                              }
                            />
                          </label>
                        </div>
                        <p className="text-xs text-ink-faint">
                          State is set from this branch&rsquo;s GST registration, if any, and isn&rsquo;t edited
                          here.
                        </p>
                        <div className="flex items-center gap-3">
                          <Button type="submit" busy={busy} busyLabel="Saving…" size="sm">
                            Save
                          </Button>
                          {error && <p className="text-xs text-error">{error}</p>}
                        </div>
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

      {adding ? (
        <form
          onSubmit={onAdd}
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5"
        >
          <h2 className="font-semibold text-ink">New branch</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <Label>Code</Label>
              <Input
                value={newCode}
                onChange={(e) => setNewCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
                placeholder="BLR"
                className={field + " " + (newCodeLooksValid ? "" : "border-error")}
              />
              <span className="text-xs text-ink-faint">
                Up to 6 letters or digits. This prefixes every voucher number raised from
                the branch, so it can&rsquo;t be changed later.
              </span>
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Bengaluru Depot"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>State</Label>
              <Select value={newState} onChange={(e) => setNewState(e.target.value)}>
                <option value="">Select a state…</option>
                {states.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <span className="text-xs text-ink-faint">
                Decides whether a sale from here is intra- or inter-state, and which GSTIN
                the branch can be attached to.
              </span>
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>
                Address line 1 <span className="font-normal text-ink-faint">optional now</span>
              </Label>
              <Input value={newLine1} onChange={(e) => setNewLine1(e.target.value)} className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>
                City <span className="font-normal text-ink-faint">optional now</span>
              </Label>
              <Input value={newCity} onChange={(e) => setNewCity(e.target.value)} className={field} />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>
                PIN code <span className="font-normal text-ink-faint">optional now</span>
              </Label>
              <Input
                value={newPincode}
                onChange={(e) => setNewPincode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                placeholder="560025"
                className={field + " " + (newPincodeLooksValid ? "" : "border-error")}
              />
            </label>
          </div>
          <p className="text-xs text-ink-faint">
            The branch gets its own default godown automatically — without one it
            couldn&rsquo;t record stock. Attach a GSTIN to it under Registrations; leave the
            address blank now and fill it in above later, though an e-invoice or e-way bill
            needs address line 1, city and PIN code.
          </p>
          <div className="flex items-center gap-3">
            <Button type="submit" busy={addBusy} busyLabel="Adding…" disabled={!canAdd}>
              Add branch
            </Button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setAddError(null);
              }}
              className="text-sm text-ink-soft hover:underline"
            >
              Cancel
            </button>
            {addError && <p className="text-sm text-error">{addError}</p>}
          </div>
        </form>
      ) : (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(true)}>
            Add a branch
          </Button>
        </div>
      )}
    </div>
  );
}
