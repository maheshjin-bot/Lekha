"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/supabase/rpc";
import { TableContainer, th, td } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";

export type TeamMember = {
  member_id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  role: string;
  status: string;
  member_since: string;
};

export type TeamInvite = {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  expires_at: string;
};

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  accountant: "Accountant",
  auditor: "Auditor (read-only)",
};

const ROLE_TONE: Record<string, "accent" | "ok" | "neutral"> = {
  admin: "accent",
  accountant: "ok",
  auditor: "neutral",
};

const INVITE_STATUS_TONE: Record<string, "warn" | "ok" | "bad" | "neutral"> = {
  pending: "warn",
  accepted: "ok",
  revoked: "bad",
  expired: "neutral",
};

export function TeamManager({
  companyId,
  isAdmin,
  members,
  invites,
}: {
  companyId: string;
  isAdmin: boolean;
  members: TeamMember[];
  invites: TeamInvite[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("accountant");
  const [busy, setBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await callRpc<
      { p_company_id: string; p_email: string; p_role: string },
      string
    >(createClient(), "create_company_invite", {
      p_company_id: companyId,
      p_email: email.trim(),
      p_role: role,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Invited ${email.trim()}`);
    setEmail("");
    router.refresh();
  }

  async function revokeInvite(id: string) {
    setRevokingId(id);
    // Plain update, not an RPC — company_invites_write (0003) already lets an
    // admin do this directly, so there is nothing an RPC would add here. The
    // .eq("status", "pending") guard just makes a stale double-click a no-op
    // instead of a confusing "already revoked" error.
    const { error } = await createClient()
      .from("company_invites")
      .update({ status: "revoked" })
      .eq("id", id)
      .eq("status", "pending");
    setRevokingId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Invite revoked");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="text-sm font-semibold text-ink">
          Members <span className="font-normal text-ink-faint">({members.length})</span>
        </h2>
        <div className="mt-3">
          <TableContainer>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className={th}>Email</th>
                  <th className={th}>Name</th>
                  <th className={th}>Role</th>
                  <th className={th}>Status</th>
                  <th className={th}>Member since</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.member_id} className="border-b border-border last:border-0">
                    <td className={td}>{m.email}</td>
                    <td className={td + " text-ink-soft"}>
                      {m.full_name ?? <span className="text-ink-faint">—</span>}
                    </td>
                    <td className={td}>
                      <Badge tone={ROLE_TONE[m.role] ?? "neutral"}>
                        {ROLE_LABEL[m.role] ?? m.role}
                      </Badge>
                    </td>
                    <td className={td}>
                      <Badge tone={m.status === "active" ? "ok" : "bad"}>
                        {m.status === "active" ? "Active" : "Revoked"}
                      </Badge>
                    </td>
                    <td className={td + " whitespace-nowrap text-ink-soft"}>
                      {m.member_since.slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        </div>
      </section>

      {isAdmin && (
        <>
          <section>
            <h2 className="text-sm font-semibold text-ink">Invites</h2>
            <p className="mt-1 text-xs text-ink-faint">
              Only admins can see this — invites are admin-only to read and write, by design.
            </p>
            <div className="mt-3">
              {invites.length === 0 ? (
                <EmptyState>No invites sent yet.</EmptyState>
              ) : (
                <TableContainer>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th className={th}>Email</th>
                        <th className={th}>Role</th>
                        <th className={th}>Status</th>
                        <th className={th}>Sent</th>
                        <th className={th}>Expires</th>
                        <th className={th}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {invites.map((inv) => (
                        <tr key={inv.id} className="border-b border-border last:border-0">
                          <td className={td}>{inv.email}</td>
                          <td className={td}>{ROLE_LABEL[inv.role] ?? inv.role}</td>
                          <td className={td}>
                            <Badge tone={INVITE_STATUS_TONE[inv.status] ?? "neutral"}>
                              {inv.status}
                            </Badge>
                          </td>
                          <td className={td + " whitespace-nowrap text-ink-soft"}>
                            {inv.created_at.slice(0, 10)}
                          </td>
                          <td className={td + " whitespace-nowrap text-ink-soft"}>
                            {inv.expires_at.slice(0, 10)}
                          </td>
                          <td className={td}>
                            {inv.status === "pending" && (
                              <button
                                type="button"
                                disabled={revokingId === inv.id}
                                onClick={() => revokeInvite(inv.id)}
                                className="text-xs text-error underline underline-offset-2 disabled:opacity-50"
                              >
                                Revoke
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableContainer>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold text-ink">Invite someone</h2>
            <form onSubmit={sendInvite} className="mt-3 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="colleague@example.com"
                  className={field + " w-64"}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Role</span>
                <select value={role} onChange={(e) => setRole(e.target.value)} className={field}>
                  <option value="accountant">Accountant</option>
                  <option value="auditor">Auditor (read-only)</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Sending…" : "Send invite"}
              </button>
            </form>
            <p className="mt-2 text-xs text-ink-faint">
              The link is valid for 14 days. Branch-scoped access (restricting a member to one
              branch) isn&rsquo;t set from here — an admin can still set it up afterwards for an
              accepted member directly.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
