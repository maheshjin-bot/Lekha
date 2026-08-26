import Link from "next/link";
import { Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { callRpc } from "@/lib/supabase/rpc";
import { NewCompanyDialog } from "@/components/companies/NewCompanyDialog";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { SendAllPendingButton, type PendingSummaryRow } from "@/components/notifications/SendAllPendingButton";

export default async function CompaniesPage() {
  const supabase = await createClient();

  // RLS scopes this to companies the signed-in user is an active member of —
  // there is no company_id filter here because there does not need to be.
  const [{ data: companies }, { data: entityTypes }, { data: states }, { data: pendingSummary }] =
    await Promise.all([
      supabase
        .from("companies")
        .select("id, name, entity_type, compliance_mode, book_beginning_date, password_protected")
        .order("name"),
      supabase.from("ref_entity_types").select("code, name").order("sort_order"),
      supabase
        .from("ref_states")
        .select("code, name")
        .eq("is_active", true)
        .not("jurisdiction", "eq", "other")
        .order("name"),
      // get_pending_notification_summary (0167) predates the next
      // regeneration of types/database.types.ts (a file this task must not
      // touch — see AGENTS.md), so it's called through callRpc's untyped
      // overload rather than the typed supabase.rpc(...) call, same as
      // every other brand-new RPC in this shared tree right now.
      callRpc<Record<string, never>, PendingSummaryRow[]>(supabase, "get_pending_notification_summary", {}),
    ]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <header className="mb-12 flex items-start justify-between gap-6">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">Companies</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Each company keeps its own books, registrations and module set.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <NewCompanyDialog entityTypes={entityTypes ?? []} states={states ?? []} />
          <SignOutButton />
        </div>
      </header>

      <SendAllPendingButton summary={pendingSummary ?? []} />

      {companies && companies.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {companies.map((c) => (
            <li key={c.id}>
              <Link
                href={`/${c.id}`}
                className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-surface-2"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-ink-faint">
                    {entityTypes?.find((e) => e.code === c.entity_type)?.name ??
                      c.entity_type}
                  </span>
                  {c.password_protected && (
                    <Lock
                      size={12}
                      className="text-ink-faint"
                      aria-label="Password protected"
                    />
                  )}
                </div>
                <span
                  className={
                    "rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide " +
                    (c.compliance_mode === "compliance"
                      ? "bg-success-soft text-success"
                      : "bg-surface-2 text-ink-soft")
                  }
                >
                  {c.compliance_mode === "compliance" ? "Compliance" : "Books only"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-border-strong px-5 py-10 text-center">
          <p className="text-sm text-ink-faint">No companies yet.</p>
          <div className="mt-4 flex justify-center">
            <NewCompanyDialog
              entityTypes={entityTypes ?? []}
              states={states ?? []}
              triggerLabel="Create your first company"
            />
          </div>
        </div>
      )}
    </main>
  );
}
