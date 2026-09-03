"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Building2, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { readContext, withContext, type AppContext } from "@/lib/nav/context";
import {
  defaultPeriod,
  financialYearLabel,
  periodPreset,
  periodRangeLabel,
  type PeriodPresetKey,
} from "@/lib/utils/period";

/**
 * The bar every screen in the company workspace sits under: the four things
 * an accountant must always be able to see and change without leaving the
 * report they are on — Company, Financial year, Branch, Period.
 *
 *     Ashoka Traders ▾   FY 2026-27 ▾   Head Office ▾   1 Apr – 31 Aug ▾
 *
 * All of the actual date/branch reasoning is lib/nav/context.ts's — this file
 * only renders it and turns a click into a `router.push` of a URL that keeps
 * everything else about the current screen intact. That "everything else"
 * guarantee is `withContext()`'s job (see F4): every `go()` call below reads
 * as "here, but with these one or two keys changed."
 *
 * This is a Client Component (it needs useRouter/useSearchParams and click
 * handlers), so it reads its own AppContext from `useSearchParams()` rather
 * than being handed one — the two things it CANNOT get from the URL alone
 * (the company's financial-year-start month, and the branch list) arrive as
 * props from whoever mounts this against a Server Component that already
 * queried the company row.
 */

/** A patch to the current URL's context keys — `null` clears a key, anything
 * else sets it. Exactly `withContext`'s own `extra` shape, named locally so
 * every handler below can be typed without repeating the inline generic. */
type ContextPatch = Record<string, string | number | null | undefined>;

export type ContextBarBranch = { id: string; name: string };

export function ContextBar({
  companyId,
  companyName,
  fyStartMonth,
  branches,
  className,
}: {
  companyId: string;
  companyName: string;
  /**
   * `companies.financial_year_start_month`, passed straight through — this
   * component does not re-derive it, it forwards it to readContext(), which
   * already owns the null/out-of-range normalisation (defaults to April).
   */
  fyStartMonth: number | null;
  /**
   * Every branch of this company, in the order they should list. Zero or one
   * entry renders the branch slot as plain text — a one-option dropdown is
   * noise, per this component's own brief — two or more renders it as a
   * real control.
   */
  branches: ContextBarBranch[];
  className?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const ctx = readContext(companyId, searchParams, fyStartMonth);
  // ctx.fyStart is, by construction, the first day of the financial year, so
  // its month IS the normalised start month — the same recovery trick every
  // report page already uses (see trial-balance/page.tsx) rather than
  // re-deriving it from the raw prop, which could still be null.
  const startMonth = Number(ctx.fyStart.slice(5, 7));

  /**
   * Pushes "the current URL, with these keys changed" — the one operation
   * every control below performs. `scroll: false` because changing the
   * period should not yank a reader who is halfway down a long statement
   * back to the top of the page.
   *
   * withContext() is handed `pathname` PLUS the current query string, not
   * `pathname` alone — a bare pathname carries none of a screen's own
   * params (e.g. the ledger statement's `?ledger=<id>`), so `go()` would
   * silently drop them on every click: confirmed live during I1 integration
   * — picking "This month" from the ledger statement for HDFC Bank Current
   * A/c re-rendered with `ledger` gone from the URL entirely and the page
   * fell back to a different ledger, not the one on screen. withContext()
   * itself already preserves an href's existing query (see F4's own
   * contract) — the bug was only ever here, in what got handed to it.
   */
  const currentQuery = searchParams.toString();
  function go(extra: ContextPatch) {
    router.push(
      withContext(currentQuery ? `${pathname}?${currentQuery}` : pathname, ctx, extra),
      { scroll: false }
    );
  }

  return (
    <div
      className={cn(
        // Sticky at the content area's own top, not the viewport's — whatever
        // mounts this owns where that top actually is. print:hidden because
        // a statement should leave as a document, not a screenshot of chrome.
        "sticky top-0 z-20 flex flex-wrap items-center gap-1.5 border-b border-border bg-surface px-3 py-2 text-sm print:hidden lg:flex-nowrap lg:gap-2",
        className
      )}
    >
      <Link
        href="/companies"
        title="Switch company"
        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 py-1.5 text-ink transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <Building2 size={14} className="shrink-0 text-ink-faint" aria-hidden="true" />
        <span className="max-w-[10rem] truncate font-medium">{companyName}</span>
      </Link>

      <FyControl ctx={ctx} startMonth={startMonth} onChange={go} />
      <BranchControl branches={branches} ctx={ctx} onChange={go} />
      <PeriodControl ctx={ctx} startMonth={startMonth} onChange={go} />
    </div>
  );
}

/**
 * The one dropdown shape all three real controls share: a bordered chip that
 * opens a small menu below it, closed by an outside click or Escape — the
 * same two closes Modal.tsx already uses, reimplemented here because this is
 * an anchored popover, not a full-screen overlay.
 */
function Dropdown({
  label,
  value,
  align = "left",
  children,
}: {
  label: string;
  value: ReactNode;
  /** "right" for the rightmost control, so its menu opens inward rather than
   * off the edge of the viewport. */
  align?: "left" | "right";
  /** Receives `close`, so a menu item can dismiss the menu itself right
   * before navigating — closing after the click has already fired would
   * otherwise flash the menu open on the destination's first paint. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg border border-border-strong px-2.5 py-1.5 text-ink transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
      >
        <span className="text-ink-faint">{label}</span>
        <span className="max-w-[9rem] truncate font-medium">{value}</span>
        <ChevronDown
          size={13}
          className={cn("shrink-0 text-ink-faint transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute top-full z-30 mt-1.5 min-w-[13rem] rounded-[14px] border border-border bg-surface p-1.5 shadow-card",
            align === "right" ? "right-0" : "left-0"
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "flex w-full items-center rounded-lg px-3 py-1.5 text-left text-sm transition-colors",
        active ? "bg-accent-soft font-medium text-ink" : "text-ink-soft hover:bg-surface-2 hover:text-ink"
      )}
    >
      {children}
    </button>
  );
}

function FyControl({
  ctx,
  startMonth,
  onChange,
}: {
  ctx: AppContext;
  startMonth: number;
  onChange: (extra: ContextPatch) => void;
}) {
  // Anchored on the FY that ACTUALLY contains today — via defaultPeriod(),
  // the one sanctioned source of "today" in this app (see period.ts's own
  // header on why a raw `new Date()` read through UTC fields is a bug, not a
  // shortcut) — never on ctx.fyLabel, which is whichever year happens to be
  // ON SCREEN right now and would make the offered year window drift as the
  // user picks around it.
  const currentFyStartYear = Number(defaultPeriod(startMonth).from.slice(0, 4));
  const selectedFyStartYear = Number(ctx.fyLabel.slice(0, 4));

  // One year ahead (books opened early for a year not yet running) through
  // six years back — enough for an assessment-year lookback without a query
  // for "which years does this company actually have postings in".
  const years = Array.from({ length: 8 }, (_, i) => currentFyStartYear + 1 - i);

  return (
    <Dropdown label="FY" value={ctx.fyLabel}>
      {(close) => (
        <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {years.map((year) => {
            const label = financialYearLabel(startMonth, new Date(Date.UTC(year, startMonth - 1, 15)));
            return (
              <MenuItem
                key={year}
                active={year === selectedFyStartYear}
                onClick={() => {
                  close();
                  // An explicit from/to always outranks `?fy=` (readContext's
                  // own stated precedence), so clearing them is what actually
                  // lets the picked year take effect — otherwise a custom
                  // range left over from before this click would silently
                  // keep winning. The real current year needs no `fy=` key
                  // at all (that IS the default), so it is stated only when
                  // it says something the bare URL would not already say.
                  onChange(
                    year === currentFyStartYear
                      ? { fy: null, from: null, to: null }
                      : { fy: label, from: null, to: null }
                  );
                }}
              >
                FY {label}
              </MenuItem>
            );
          })}
        </div>
      )}
    </Dropdown>
  );
}

function BranchControl({
  branches,
  ctx,
  onChange,
}: {
  branches: ContextBarBranch[];
  ctx: AppContext;
  onChange: (extra: ContextPatch) => void;
}) {
  if (branches.length === 0) return null;

  // A single-branch company has nothing to switch between — render the name
  // and stop, rather than a dropdown whose only option is "select the thing
  // already selected".
  if (branches.length === 1) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-ink-soft">
        {branches[0].name}
      </span>
    );
  }

  const selected = ctx.branchId ? branches.find((b) => b.id === ctx.branchId) : undefined;
  // Same fallback wording the trial balance page already uses for a branch id
  // that no longer resolves (deleted after the link/bookmark was made).
  const value = ctx.branchId ? (selected?.name ?? "Unknown branch") : "All branches";

  return (
    <Dropdown label="Branch" value={value}>
      {(close) => (
        <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          <MenuItem
            active={!ctx.branchId}
            onClick={() => {
              close();
              onChange({ branch: null });
            }}
          >
            All branches
          </MenuItem>
          {branches.map((b) => (
            <MenuItem
              key={b.id}
              active={b.id === ctx.branchId}
              onClick={() => {
                close();
                onChange({ branch: b.id });
              }}
            >
              {b.name}
            </MenuItem>
          ))}
        </div>
      )}
    </Dropdown>
  );
}

/** The three presets whose dates move with "today" rather than with whichever
 * financial year is currently selected — periodPreset()'s own contract. */
const RELATIVE_PRESETS: { key: PeriodPresetKey; label: string }[] = [
  { key: "currentMonth", label: "This month" },
  { key: "previousMonth", label: "Last month" },
  { key: "thisQuarter", label: "This quarter" },
];

function PeriodControl({
  ctx,
  startMonth,
  onChange,
}: {
  ctx: AppContext;
  startMonth: number;
  onChange: (extra: ContextPatch) => void;
}) {
  const bare = defaultPeriod(startMonth); // the ACTUAL current FY, to date
  const isFyToDate = ctx.from === bare.from && ctx.to === bare.to;
  const isFullFy = ctx.from === ctx.fyStart && ctx.to === ctx.fyEnd;

  const relativeMatch = RELATIVE_PRESETS.find((p) => {
    const range = periodPreset(p.key, startMonth);
    return ctx.from === range.from && ctx.to === range.to;
  });

  // The compact label shown on the closed control, for whichever one preset
  // best names the period on screen. A real if rare collision — 1 April on
  // an April-start company is simultaneously "This month" and "FY to date" —
  // is resolved by this priority order; the menu itself marks every match
  // active independently underneath, so nothing is hidden, only summarised.
  const value = relativeMatch
    ? relativeMatch.label
    : isFyToDate
      ? "FY to date"
      : isFullFy
        ? "Full FY"
        : periodRangeLabel(ctx.from, ctx.to);

  return (
    <Dropdown label="Period" value={value} align="right">
      {(close) => (
        <div className="flex flex-col gap-0.5">
          {RELATIVE_PRESETS.map((p) => {
            const range = periodPreset(p.key, startMonth);
            return (
              <MenuItem
                key={p.key}
                active={ctx.from === range.from && ctx.to === range.to}
                onClick={() => {
                  close();
                  // fy is cleared alongside: an explicit from/to always wins
                  // and determines the FY label anyway (readContext derives
                  // it fresh from `from`), so a `?fy=` left over from a
                  // previously-picked year would only be dead weight in the
                  // URL, never a second source of truth.
                  onChange({ from: range.from, to: range.to, fy: null });
                }}
              >
                {p.label}
              </MenuItem>
            );
          })}
          <MenuItem
            active={isFyToDate}
            onClick={() => {
              close();
              // Names the books that are actually running right now — always
              // the real current year, whatever year happened to be selected,
              // the same way the three presets above already behave.
              onChange({ from: null, to: null, fy: null });
            }}
          >
            FY to date
          </MenuItem>
          <MenuItem
            active={isFullFy}
            onClick={() => {
              close();
              // Unlike "FY to date", this respects whichever year the FY
              // control currently has selected: "all of the year I am
              // looking at", not "jump back to the running year".
              onChange({ from: ctx.fyStart, to: ctx.fyEnd, fy: null });
            }}
          >
            Full FY
          </MenuItem>
          <div className="my-1 border-t border-border" />
          <CustomPeriodFields
            ctx={ctx}
            onApply={(from, to) => {
              close();
              onChange({ from, to, fy: null });
            }}
          />
        </div>
      )}
    </Dropdown>
  );
}

function CustomPeriodFields({
  ctx,
  onApply,
}: {
  ctx: AppContext;
  onApply: (from: string, to: string) => void;
}) {
  // Seeded from the period on screen right now, and remounted fresh every
  // time the menu opens — its parent's `{open && ...}` unmounts this whole
  // subtree on close — so these never go stale the way a useEffect resync
  // against a changing ctx would risk.
  const [from, setFrom] = useState(ctx.from);
  const [to, setTo] = useState(ctx.to);
  const valid = from !== "" && to !== "" && from <= to;

  return (
    <div className="flex flex-col gap-2 px-1 pb-1 pt-2">
      <p className="px-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Custom</p>
      <div className="flex items-center gap-2 px-2">
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-[8.5rem] px-2 py-1 text-xs"
          aria-label="From date"
        />
        <span className="text-ink-faint">to</span>
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-[8.5rem] px-2 py-1 text-xs"
          aria-label="To date"
        />
      </div>
      <Button
        type="button"
        size="sm"
        className="mx-2"
        disabled={!valid}
        onClick={() => onApply(from, to)}
      >
        Apply
      </Button>
    </div>
  );
}
