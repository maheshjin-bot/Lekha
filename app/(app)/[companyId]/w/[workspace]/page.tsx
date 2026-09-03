import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { navEntries, WORKSPACES } from "@/lib/nav/registry";

/**
 * The landing page for one of the ten workspaces WORKSPACES defines — every
 * screen lib/nav/registry.ts files under that workspace, rendered as a card.
 *
 * This exists for a reason bigger than "a nicer overview page": NavRail
 * today lists all ~120 routes directly, and this task's brief is explicit
 * that shrinking it to ten top-level entries is a follow-up, not done here,
 * and that the follow-up is only SAFE once every route the rail used to link
 * to directly is still one click away from somewhere. This page is that
 * somewhere — /w/<workspace> for each of the ten ids is a complete substitute
 * index for whatever the rail used to show under that heading, so nothing
 * becomes unreachable when NavRail later gets shorter.
 *
 * `params` is typed by hand rather than through the generated PageProps
 * helper. PageProps<"/[companyId]/w/[workspace]"> resolves against
 * .next/types, which only learns about a route after `next dev` or
 * `next build` has scanned the app directory for it — this route did not
 * appear in .next/types/routes.d.ts as of integration, so the helper failed
 * to typecheck (see account-groups/page.tsx's identical comment for the same
 * situation on an earlier new route). The shape below is what the helper
 * resolves to once .next/types does catch up, so switching back is safe any
 * time after that happens.
 */
export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ companyId: string; workspace: string }>;
}) {
  const { companyId, workspace } = await params;

  const meta = WORKSPACES.find((w) => w.id === workspace);
  if (!meta) notFound();

  // Registry order (transactions, then masters, then GST, then reports, then
  // the bottom/orphan list) is preserved as-is — it already reads as a
  // reasonable within-workspace grouping without this page needing its own
  // sort.
  const entries = navEntries.filter((e) => e.workspace === workspace);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      {/* Every workspace, one tap away — a reader who lands here from a
          search result or a bookmark should never have to backtrack through
          NavRail just to get to a neighbouring domain. */}
      <nav aria-label="Workspaces" className="mb-6 flex flex-wrap gap-1.5">
        {WORKSPACES.map((w) => (
          <Link
            key={w.id}
            href={`/${companyId}/w/${w.id}`}
            aria-current={w.id === workspace ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              w.id === workspace
                ? "border-accent bg-accent-soft text-accent"
                : "border-border-strong text-ink-soft hover:bg-surface-2 hover:text-ink"
            )}
          >
            {w.label}
          </Link>
        ))}
      </nav>

      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        {meta.label}
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">{meta.description}</p>

      {entries.length === 0 ? (
        // Unreachable with today's registry (every workspace id currently in
        // use has at least four entries) but not something to assume stays
        // true forever — a workspace added to WORKSPACES without any entry
        // pointed at it yet should render an honest empty state, not a blank
        // grid.
        <EmptyState className="mt-8">Nothing filed under this workspace yet.</EmptyState>
      ) : (
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map((entry) => (
            <Link
              key={entry.href}
              // Registry hrefs carry the literal token ":companyId" in place
              // of a real path segment (see registry.ts's own header) —
              // resolving one back to a working link means substituting the
              // token for `/${companyId}`, WITH the leading slash, since the
              // token itself carries none. The two routes that aren't
              // company-scoped (/scan, /security) contain no such token, so
              // this replace is a no-op for them.
              href={entry.href.replace(":companyId", `/${companyId}`)}
              className="group flex flex-col gap-1 rounded-[14px] border border-border bg-surface p-4 shadow-card transition-colors hover:bg-surface-2"
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">{entry.label}</span>
                <ChevronRight
                  size={14}
                  className="shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </span>
              {/* Keywords double as the card's one-line description —
                  registry.ts curates them as "what someone would TYPE to
                  find this" (Indian-accounting synonyms and Tally-equivalent
                  names), which reads just as well as a plain gloss of what
                  the screen is for, without this page needing a second,
                  separately-maintained description field per entry. */}
              <span className="truncate text-xs text-ink-faint">
                {entry.keywords.slice(0, 4).join(" · ")}
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
