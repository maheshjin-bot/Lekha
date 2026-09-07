"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

type Branch = {
  id: string;
  code: string;
  name: string;
  state_code: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  pincode: string | null;
  is_head_office: boolean;
  is_active: boolean;
  gst_registration_id: string | null;
  // A to-one embed off the single-row branches_gst_registration_id_..._fkey
  // — PostgREST returns an object here, not an array (confirmed against the
  // identical embed in app/(app)/[companyId]/invoices/new/page.tsx).
  gst_registrations: { gstin: string } | null;
};

type StateOption = { code: string; name: string };

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

/** Mirrors create_branch/update_branch's own pincode check, so a bad value
 * is caught here rather than round-tripping to the RPC first. Six digits,
 * not starting with 0 — matches `^[1-9][0-9]{5}$` server-side. */
function pincodeLooksValid(v: string): boolean {
  const t = v.trim();
  return t === "" || /^[1-9][0-9]{5}$/.test(t);
}

export function BranchManager({
  companyId,
  branches,
  states,
  isAdmin,
}: {
  companyId: string;
  branches: Branch[];
  states: StateOption[];
  isAdmin: boolean;
}) {
  const router = useRouter();

  // ---- Add branch -----------------------------------------------------
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [stateCode, setStateCode] = useState(states[0]?.code ?? "");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressLine2, setAddressLine2] = useState("");
  const [city, setCity] = useState("");
  const [pincode, setPincode] = useState("");
  const [creating, setCreating] = useState(false);

  const addAllowed = isAdmin;
  const pincodeOk = pincodeLooksValid(pincode);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!pincodeOk) return;
    setCreating(true);

    // create_branch/update_branch aren't in database.types.ts yet — callRpc
    // (see lib/supabase/rpc.ts) keeps supabase-js's internal `this` binding
    // intact, which a bare `(rpc as unknown as Fn)(...)` cast would drop.
    const { error } = await callRpc(createClient(), "create_branch", {
      p_company_id: companyId,
      p_code: code.trim().toUpperCase(),
      p_name: name.trim(),
      p_state_code: stateCode,
      p_address_line1: addressLine1.trim() || null,
      p_address_line2: addressLine2.trim() || null,
      p_city: city.trim() || null,
      p_pincode: pincode.trim() || null,
    });

    setCreating(false);
    if (error) {
      toast.error(error.message);
      return;
    }

    toast.success(`Branch ${code.trim().toUpperCase()} added`);
    setCode("");
    setName("");
    setAddressLine1("");
    setAddressLine2("");
    setCity("");
    setPincode("");
    router.refresh();
  }

  // ---- Edit branch address ---------------------------------------------
  const [editing, setEditing] = useState<Branch | null>(null);
  const [editAddressLine1, setEditAddressLine1] = useState("");
  const [editAddressLine2, setEditAddressLine2] = useState("");
  const [editCity, setEditCity] = useState("");
  const [editPincode, setEditPincode] = useState("");
  const [saving, setSaving] = useState(false);

  function openEdit(b: Branch) {
    setEditing(b);
    setEditAddressLine1(b.address_line1 ?? "");
    setEditAddressLine2(b.address_line2 ?? "");
    setEditCity(b.city ?? "");
    setEditPincode(b.pincode ?? "");
  }

  const editPincodeOk = pincodeLooksValid(editPincode);

  async function onSaveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing || !editPincodeOk) return;
    setSaving(true);

    const { error } = await callRpc(createClient(), "update_branch", {
      p_branch_id: editing.id,
      p_address_line1: editAddressLine1.trim() || null,
      p_address_line2: editAddressLine2.trim() || null,
      p_city: editCity.trim() || null,
      p_pincode: editPincode.trim() || null,
    });

    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }

    toast.success(`${editing.name} updated`);
    setEditing(null);
    router.refresh();
  }

  const stateName = (stateCd: string) => states.find((s) => s.code === stateCd)?.name ?? stateCd;

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_320px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Code</th>
                <th className="px-4 py-2.5 font-medium">Branch</th>
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">City</th>
                <th className="px-4 py-2.5 font-medium">GST registration</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {branches.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
                    No branches yet — the head office was created with the company.
                  </td>
                </tr>
              )}
              {branches.map((b) => (
                <tr key={b.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 font-mono text-xs">{b.code}</td>
                  <td className="px-4 py-2.5 font-medium">
                    {b.name}
                    {b.is_head_office && (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-soft">
                        Head office
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-ink-soft">{stateName(b.state_code)}</td>
                  <td className="px-4 py-2.5 text-ink-soft">{b.city ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    {b.gst_registrations ? (
                      <Link
                        href={`/${companyId}/registrations`}
                        className="font-mono text-xs text-accent transition-colors hover:underline"
                      >
                        {b.gst_registrations.gstin}
                      </Link>
                    ) : (
                      <span className="text-ink-faint">Not linked</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={b.is_active ? "ok" : "neutral"}>
                      {b.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!isAdmin}
                      title={!isAdmin ? "Only an admin can edit a branch's address" : undefined}
                      onClick={() => openEdit(b)}
                    >
                      Edit address
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">New branch</h2>
        {!addAllowed && (
          <p className="mt-1 text-xs text-ink-faint">
            Only a company admin can add a branch.
          </p>
        )}
        <form onSubmit={onCreate} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Code <span className="font-normal text-ink-faint">up to 6, A–Z and 0–9 — locked once set</span>
            </span>
            <input
              required
              disabled={!addAllowed}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              maxLength={6}
              className={field + " font-mono disabled:opacity-50"}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Name <span className="font-normal text-ink-faint">locked once set</span></span>
            <input
              required
              disabled={!addAllowed}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={field + " disabled:opacity-50"}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">State <span className="font-normal text-ink-faint">locked once set — feeds GST registration</span></span>
            <select
              disabled={!addAllowed}
              value={stateCode}
              onChange={(e) => setStateCode(e.target.value)}
              className={field + " disabled:opacity-50"}
            >
              {states.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Address line 1 <span className="font-normal text-ink-faint">optional</span>
            </span>
            <input
              disabled={!addAllowed}
              value={addressLine1}
              onChange={(e) => setAddressLine1(e.target.value)}
              className={field + " disabled:opacity-50"}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Address line 2 <span className="font-normal text-ink-faint">optional</span>
            </span>
            <input
              disabled={!addAllowed}
              value={addressLine2}
              onChange={(e) => setAddressLine2(e.target.value)}
              className={field + " disabled:opacity-50"}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                City <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input
                disabled={!addAllowed}
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className={field + " disabled:opacity-50"}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                PIN code <span className="font-normal text-ink-faint">optional</span>
              </span>
              <input
                disabled={!addAllowed}
                value={pincode}
                onChange={(e) => setPincode(e.target.value.replace(/[^0-9]/g, ""))}
                maxLength={6}
                className={
                  field +
                  " font-mono disabled:opacity-50 " +
                  (pincodeOk ? "" : "border-error focus-visible:border-error")
                }
              />
            </label>
          </div>
          {!pincodeOk && (
            <p className="text-xs text-error">6 digits, cannot start with 0.</p>
          )}

          <Button
            type="submit"
            disabled={!addAllowed || !pincodeOk}
            busy={creating}
            busyLabel="Adding…"
            title={!addAllowed ? "Only an admin can add a branch" : undefined}
            className="mt-1"
          >
            Add branch
          </Button>
        </form>
      </section>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Edit address — ${editing.name}` : "Edit address"}
        description="Code, name and state are locked once a branch is created — they feed voucher numbering and GST registration. Only the address can change here."
      >
        {editing && (
          <form onSubmit={onSaveEdit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Address line 1</span>
              <input
                value={editAddressLine1}
                onChange={(e) => setEditAddressLine1(e.target.value)}
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Address line 2</span>
              <input
                value={editAddressLine2}
                onChange={(e) => setEditAddressLine2(e.target.value)}
                className={field}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">City</span>
                <input
                  value={editCity}
                  onChange={(e) => setEditCity(e.target.value)}
                  className={field}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">PIN code</span>
                <input
                  value={editPincode}
                  onChange={(e) => setEditPincode(e.target.value.replace(/[^0-9]/g, ""))}
                  maxLength={6}
                  className={
                    field +
                    " font-mono " +
                    (editPincodeOk ? "" : "border-error focus-visible:border-error")
                  }
                />
              </label>
            </div>
            {!editPincodeOk && (
              <p className="text-xs text-error">6 digits, cannot start with 0.</p>
            )}

            <div className="mt-2 flex items-center justify-end gap-3">
              <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" busy={saving} busyLabel="Saving…" disabled={!editPincodeOk}>
                Save address
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
