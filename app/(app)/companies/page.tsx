import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { CreateCompanyForm } from "@/components/companies/CreateCompanyForm";
import { SignOutButton } from "@/components/auth/SignOutButton";

export default async function CompaniesPage() {
  const supabase = await createClient();

  // RLS scopes this to companies the signed-in user is an active member of —
  // there is no company_id filter here because there does not need to be.
  const [{ data: companies }, { data: entityTypes }, { data: states }] =
    await Promise.all([
      supabase
        .from("companies")
        .select("id, name, entity_type, compliance_mode, book_beginning_date")
        .order("name"),
      supabase.from("ref_entity_types").select("code, name").order("sort_order"),
      supabase
        .from("ref_states")
        .select("code, name")
        .eq("is_active", true)
        .not("jurisdiction", "eq", "other")
        .order("name"),
    ]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <header className="mb-12 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Companies</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Each company keeps its own books, registrations and module set.
          </p>
        </div>
        <SignOutButton />
      </header>

      {companies && companies.length > 0 ? (
        <ul className="mb-14 divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {companies.map((c) => (
            <li key={c.id}>
              <Link
                href={`/${c.id}`}
                className="flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
              >
                <div>
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-3 text-xs text-zinc-500">
                    {entityTypes?.find((e) => e.code === c.entity_type)?.name ??
                      c.entity_type}
                  </span>
                </div>
                <span
                  className={
                    "rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide " +
                    (c.compliance_mode === "compliance"
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                      : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400")
                  }
                >
                  {c.compliance_mode === "compliance" ? "Compliance" : "Books only"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-14 rounded-lg border border-dashed border-zinc-300 px-5 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No companies yet. Create your first one below.
        </p>
      )}

      <CreateCompanyForm
        entityTypes={entityTypes ?? []}
        states={states ?? []}
      />
    </main>
  );
}
