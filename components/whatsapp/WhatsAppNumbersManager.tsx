"use client";

import { useState } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";

export type WhatsAppNumberRow = {
  id: string;
  whatsapp_phone_number_id: string;
  display_phone_number: string | null;
  is_active: boolean;
  created_at: string;
};

/**
 * CRUD for whatsapp_inbound_numbers (migration 0745) — plain table
 * read/write through ordinary RLS (admin-write, member-read), no RPC needed.
 * See app/(app)/[companyId]/whatsapp-numbers/page.tsx for what this is and
 * is not (a config row, never a live subscription).
 */
export function WhatsAppNumbersManager({
  companyId,
  initialRows,
}: {
  companyId: string;
  initialRows: WhatsAppNumberRow[];
}) {
  const [rows, setRows] = useState(initialRows);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [displayNumber, setDisplayNumber] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!phoneNumberId.trim()) {
      toast.error("Enter the WhatsApp phone_number_id");
      return;
    }
    setBusy(true);
    // whatsapp_inbound_numbers is brand new (0745) — same untyped escape
    // hatch used throughout this feature (see page.tsx's own comment).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const { data, error } = await (createClient() as any)
      .from("whatsapp_inbound_numbers")
      .insert({
        company_id: companyId,
        whatsapp_phone_number_id: phoneNumberId.trim(),
        display_phone_number: displayNumber.trim() || null,
      })
      .select("id, whatsapp_phone_number_id, display_phone_number, is_active, created_at")
      .single();
    setBusy(false);
    if (error || !data) {
      toast.error(error?.message ?? "Could not register this number.");
      return;
    }
    setRows((prev) => [data as WhatsAppNumberRow, ...prev]);
    setPhoneNumberId("");
    setDisplayNumber("");
    toast.success("Registered");
  }

  async function toggleActive(row: WhatsAppNumberRow) {
    setBusy(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    const { error } = await (createClient() as any)
      .from("whatsapp_inbound_numbers")
      .update({ is_active: !row.is_active })
      .eq("id", row.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, is_active: !r.is_active } : r)));
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="mt-8 flex flex-col gap-6">
      <form onSubmit={add} className="flex flex-wrap items-end gap-3 rounded-[14px] border border-border bg-surface p-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">WhatsApp phone_number_id</span>
          <input
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
            placeholder="e.g. 109876543212345"
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">
            Display number <span className="font-normal text-ink-faint">optional</span>
          </span>
          <input
            value={displayNumber}
            onChange={(e) => setDisplayNumber(e.target.value)}
            placeholder="+91 98765 43210"
            className={field}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
        >
          Register
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="text-sm text-ink-faint">No numbers registered yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">phone_number_id</th>
                <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Display</th>
                <th className="px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-mono text-xs">{r.whatsapp_phone_number_id}</td>
                  <td className="px-4 py-2 text-ink-soft">{r.display_phone_number ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-xs " +
                        (r.is_active ? "bg-success-soft text-success" : "bg-surface-2 text-ink-faint")
                      }
                    >
                      {r.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => toggleActive(r)}
                      className="text-xs text-accent underline underline-offset-2 disabled:opacity-50"
                    >
                      {r.is_active ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
