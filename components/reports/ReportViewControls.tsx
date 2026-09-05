"use client";

/**
 * The one client island <ReportView> mounts (see components/reports/ReportView.tsx
 * section 8 of this wave's contract) for everything genuinely interactive:
 * cycling views, toggling the comparative column, and saving the current
 * query string as a named view.
 *
 * WHY THIS IS A SEPARATE FILE, NOT PART OF ReportView.tsx's OWN MODULE:
 * ReportView is, and must stay, an async Server Component — its whole job is
 * awaited Supabase calls exactly like every report page today. A "use client"
 * directive is a *file-level* boundary in this Next.js version (see
 * node_modules/next/dist/docs/ — every export of a "use client" module
 * becomes a client reference), so a hooks-using island and an async
 * data-fetching Server Component can never share one module. This file is
 * that unavoidable second module; lib/nav/context.ts's own header documents
 * the opposite mistake (a function that turns into an opaque proxy when a
 * "use client" module's export is pulled into a Server Component) already
 * having shipped once in this codebase.
 *
 * Every prop is serializable (companyId, definition.key, plain arrays of
 * strings, the current query string) — the Server Component boundary allows
 * nothing else across it.
 */

import { useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useShortcuts } from "@/lib/keys/useShortcuts";
import { useScreenConfig } from "@/lib/config/useScreenConfig";
import { createClient } from "@/lib/supabase/client";

/** One saved bookmark, as list_report_views (1550, new RPC — see this wave's
 * `contract`) returns it. */
type SavedReportView = {
  id: string;
  name: string;
  query_string: string;
  created_at: string;
};

export function ReportViewControls({
  companyId,
  screenKey,
  views,
  comparativeEnabled,
}: {
  companyId: string;
  /** Equals definition.key — the same screen_key ReportShell's own gear
   *  derives from the pathname, so Alt+C and the gear agree on one row. */
  screenKey: string;
  /** Present only when definition.views has more than one option — Ctrl+H
   *  has nothing to cycle through otherwise, so it is simply not bound. */
  views: { paramName: string; keys: string[]; defaultKey: string; activeKey: string } | null;
  /** True only when the report both declares a `comparative` AND lists
   *  "showComparative" in `config.keys` — see defineReport.ts's own comment
   *  on why an undeclared key is never gated at all, hence never toggleable. */
  comparativeEnabled: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { config, setConfig } = useScreenConfig(companyId, screenKey);
  const showComparative = (config.showComparative as boolean | undefined) ?? true;

  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SavedReportView[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(false);

  // Refetched every time the dialog opens rather than kept live in the
  // background — this is a rarely-opened picker, not a synced list, so there
  // is no reason to pay a subscription's complexity for it.
  //
  // Flip to loading the instant the dialog opens, during render rather than
  // in the effect below — same reasoning as lib/config/useScreenConfig.ts's
  // own loadingFor guard: a setState called unconditionally at the top of an
  // effect body is exactly what this project's react-hooks/set-state-in-effect
  // rule refuses.
  const [prevSaveOpen, setPrevSaveOpen] = useState(saveOpen);
  if (saveOpen !== prevSaveOpen) {
    setPrevSaveOpen(saveOpen);
    if (saveOpen) setLoadingSaved(true);
  }

  useEffect(() => {
    if (!saveOpen) return;
    let cancelled = false;
    const supabase = createClient();
    supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- list_report_views (1550) is this wave's own new RPC; see `contract`.
      .rpc("list_report_views" as any, { p_company_id: companyId, p_screen_key: screenKey })
      .then(({ data, error }) => {
        if (cancelled) return;
        setLoadingSaved(false);
        if (error) {
          console.error(`ReportViewControls: list_report_views failed: ${error.message}`);
          return;
        }
        setSaved((data as SavedReportView[] | null) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [saveOpen, companyId, screenKey]);

  function currentQueryString(): string {
    return searchParams.toString();
  }

  function navigateToQuery(query: string) {
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function cycleView() {
    if (!views || views.keys.length < 2) return;
    const currentIndex = Math.max(0, views.keys.indexOf(views.activeKey));
    const next = views.keys[(currentIndex + 1) % views.keys.length];
    const params = new URLSearchParams(searchParams.toString());
    // Omit the param entirely when it lands back on the default — the same
    // "only emit what differs from the default" convention lib/nav/context.ts's
    // contextParams() already applies to fy/from/to/branch.
    if (next === views.defaultKey) params.delete(views.paramName);
    else params.set(views.paramName, next);
    navigateToQuery(params.toString());
  }

  function toggleComparative() {
    setConfig((prev) => ({ ...prev, showComparative: !showComparative }));
  }

  async function submitSave() {
    const trimmed = name.trim();
    if (trimmed === "") return;
    setSaving(true);
    const supabase = createClient();
    const { error } = await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- save_report_view (1550) is this wave's own new RPC; see `contract`.
      .rpc("save_report_view" as any, {
        p_company_id: companyId,
        p_screen_key: screenKey,
        p_name: trimmed,
        p_query_string: currentQueryString(),
      });
    setSaving(false);
    if (error) {
      toast.error(`Could not save this view: ${error.message}`);
      return;
    }
    toast.success(`Saved as "${trimmed}"`);
    setName("");
    setSaveOpen(false);
  }

  useShortcuts(`report-view:${screenKey}`, [
    ...(views && views.keys.length > 1
      ? [{ combo: "ctrl+h", label: "Switch view", handler: () => cycleView() }]
      : []),
    ...(comparativeEnabled
      ? [{ combo: "alt+c", label: "Toggle comparative column", handler: () => toggleComparative() }]
      : []),
    { combo: "ctrl+l", label: "Save current view as…", handler: () => setSaveOpen(true) },
  ]);

  return (
    <Modal
      open={saveOpen}
      onClose={() => setSaveOpen(false)}
      title="Save current view as…"
      description="Bookmarks this exact period, branch and view — your own display toggles (zero-balance rows, exact figures, comparative) are a personal preference and are never part of a saved view."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitSave();
        }}
        className="flex flex-col gap-4"
      >
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium text-ink">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q1 export customers"
            maxLength={100}
            className="rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
          />
        </label>

        <button
          type="submit"
          disabled={saving || name.trim() === ""}
          className="inline-flex items-center justify-center gap-2 self-start rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save size={14} />
          {saving ? "Saving…" : "Save view"}
        </button>

        <div className="border-t border-border pt-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
            Your saved views
          </p>
          {loadingSaved ? (
            <p className="text-sm text-ink-faint">Loading…</p>
          ) : saved.length === 0 ? (
            <p className="text-sm text-ink-faint">Nothing saved yet on this report.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {saved.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSaveOpen(false);
                      navigateToQuery(v.query_string);
                    }}
                    className="w-full rounded-md px-2 py-1.5 text-left text-sm text-ink-soft transition-colors hover:bg-accent-soft hover:text-ink"
                  >
                    {v.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </form>
    </Modal>
  );
}
