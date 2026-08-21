"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { TableContainer, th, td } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";

type ApiKey = {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export function ApiKeyManager({ companyId, keys }: { companyId: string; keys: ApiKey[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // Shown exactly once, right after creation — never persisted, never
  // retrievable again, matching what create_api_key itself guarantees.
  const [justCreated, setJustCreated] = useState<string | null>(null);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { data, error } = await createClient().rpc("create_api_key", {
      p_company_id: companyId,
      p_name: name.trim(),
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setJustCreated(data);
    setName("");
    router.refresh();
  }

  async function revoke(id: string) {
    setBusy(true);
    const { error } = await createClient().rpc("revoke_api_key", {
      p_company_id: companyId,
      p_key_id: id,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Key revoked — it can never be used again");
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="flex flex-col gap-4">
      {justCreated && (
        <div className="rounded-[14px] border border-accent bg-accent-soft p-4">
          <p className="text-sm font-semibold text-accent">
            Copy this key now — LEKHA cannot show it to you again.
          </p>
          <code className="mt-2 block break-all rounded-md bg-surface px-3 py-2 font-mono text-xs">
            {justCreated}
          </code>
          <button
            type="button"
            onClick={() => setJustCreated(null)}
            className="mt-2 text-xs text-ink-soft underline underline-offset-2"
          >
            I&rsquo;ve copied it, dismiss
          </button>
        </div>
      )}

      <TableContainer>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Name</th>
              <th className={th}>Key</th>
              <th className={th}>Created</th>
              <th className={th}>Last used</th>
              <th className={th}>Status</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-ink-faint">
                  No API keys yet.
                </td>
              </tr>
            )}
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-border last:border-0">
                <td className={td}>{k.name}</td>
                <td className={td + " font-mono text-xs text-ink-faint"}>{k.key_prefix}…</td>
                <td className={td + " whitespace-nowrap text-ink-soft"}>{k.created_at.slice(0, 10)}</td>
                <td className={td + " whitespace-nowrap text-ink-soft"}>
                  {k.last_used_at ? k.last_used_at.slice(0, 10) : "Never used"}
                </td>
                <td className={td}>
                  {k.revoked_at ? <Badge tone="bad">Revoked</Badge> : <Badge tone="ok">Active</Badge>}
                </td>
                <td className={td}>
                  {!k.revoked_at && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => revoke(k.id)}
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

      <form onSubmit={createKey} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">New key name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Zapier integration"
            className={field + " w-64"}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
        >
          Create key
        </button>
      </form>
    </div>
  );
}
