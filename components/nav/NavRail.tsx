"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { navEntries, navGroups as registryNavGroups } from "@/lib/nav/registry";

type NavItem = { href: string; label: string };
type NavGroup = { label: string; items: NavItem[] };

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "—";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Exact match for a leaf route, prefix match for anything with children (so
 * /vouchers/new and /vouchers/abc123/edit both light up "New voucher"'s
 * neighbours correctly rather than every /vouchers/* link at once). */
function isActive(activePath: string, href: string): boolean {
  return activePath === href;
}

export function NavRail({
  companyId,
  companyName,
  activePath,
  mobileOpen = false,
  onMobileClose,
}: {
  companyId: string;
  companyName: string;
  activePath: string;
  /**
   * Below `lg:` this rail is an off-canvas drawer, not a permanent sidebar —
   * AppShell owns the open/closed boolean (it also renders the hamburger
   * button that flips it) and passes it straight through. At `lg:` and up
   * these two props are simply never touched: the rail's classes fall back
   * to their always-visible, in-flow desktop shape regardless of their
   * value, so nothing here needs a separate desktop code path.
   */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const base = `/${companyId}`;

  /**
   * Every href in lib/nav/registry.ts carries the literal token ":companyId"
   * in place of this rail's own `${base}` interpolation (see that file's own
   * header comment for why: one place to add a link, searchable by a future
   * command palette). Resolving a real link is a plain string substitution
   * back to `base` — NOT to the bare companyId, because the token itself
   * carries no leading slash (registry hrefs read literally ":companyId/…",
   * so substituting the raw id would drop the leading "/" the old inline
   * `${base}/…` template always had). The two routes that are NOT
   * company-scoped (/scan, /security) simply contain no such token, so this
   * replace is a harmless no-op for them, exactly as registry.ts documents.
   */
  const resolveHref = (href: string) => href.replace(":companyId", base);

  // The four accordions, resolved straight off the registry — same labels,
  // same items, same order this file used to hard-code (registry.ts's own
  // header guarantees navGroups reproduces NavRail's pre-registry order and
  // membership exactly).
  const groups: NavGroup[] = registryNavGroups.map((g) => ({
    label: g.label,
    items: g.items.map((i) => ({ href: resolveHref(i.href), label: i.label })),
  }));

  // Overview and the bottom account/settings list are the registry entries
  // that carry no `group` at all — registry.ts's own header explains why
  // (neither renders inside an accordion). Overview is the one such entry
  // whose href is exactly the bare company root; everything else without a
  // group is the old 13-item bottomItems list, now with two more routes
  // appended at the end: /allocations and /account-groups, real screens that
  // existed on disk but that NavRail never linked to before registry.ts
  // catalogued them as "orphans". Appending (rather than interleaving) keeps
  // the original 13 links in their exact original order and position.
  const overviewEntry = navEntries.find((e) => !e.group && e.href === ":companyId");
  const bottomItems: NavItem[] = navEntries
    .filter((e) => !e.group && e.href !== ":companyId")
    .map((e) => ({ href: resolveHref(e.href), label: e.label }));

  const [openGroup, setOpenGroup] = useState<string | null>(() => {
    const active = groups.find((g) => g.items.some((i) => isActive(activePath, i.href)));
    return active?.label ?? null;
  });

  return (
    <>
      {/* Backdrop — below lg: only, and only while the drawer is open. A tap
          anywhere outside the rail closes it, same as every other overlay in
          this app. */}
      {mobileOpen && (
        <div
          onClick={onMobileClose}
          aria-hidden="true"
          className="fixed inset-0 z-30 bg-ink/40 lg:hidden"
        />
      )}

      {/* Below lg: fixed and off-canvas by default, shown as an overlay
          drawer only while mobileOpen — a click on any link inside closes it
          via the delegated handler below, the same "navigating away closes
          the drawer" behaviour every mobile nav pattern uses. At lg: and up
          this is the original always-visible, in-flow sidebar.
          Plain hidden/flex display toggling on purpose, not a translate-x
          slide-in: confirmed live, twice, with two different class shapes,
          that Tailwind's translate-x-* utilities (backed by the registered
          --tw-translate-x custom property) get stuck displaying whichever
          value was first computed for this element and never re-resolve on
          a later class swap, even well past the transition's own duration.
          display has none of that custom-property machinery — hidden/flex
          is the same pattern virtually every Tailwind responsive nav uses,
          and it actually works. */}
      <nav
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) onMobileClose?.();
        }}
        className={cn(
          "fixed inset-y-0 left-0 z-40 h-screen w-60 shrink-0 flex-col border-r border-border bg-surface print:hidden lg:static lg:z-auto lg:flex",
          mobileOpen ? "flex" : "hidden"
        )}
      >
        {/* Company switcher — pinned at the very top of the rail, above the
            menu. For a firm juggling several GST-registered entities,
            changing companies is a navigational act, not a settings screen. */}
        <div className="flex items-center border-b border-border">
          <Link
            href="/companies"
            className="flex min-w-0 flex-1 items-center gap-2.5 px-4 py-3.5 transition-colors hover:bg-surface-2"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-soft font-mono text-[11px] font-semibold text-accent">
              {initials(companyName)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink">{companyName}</span>
              <span className="block text-[11px] text-ink-faint">Switch company</span>
            </span>
          </Link>
          <button
            type="button"
            onClick={onMobileClose}
            aria-label="Close menu"
            className="mr-2 shrink-0 rounded-md p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink-soft lg:hidden"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2.5 py-3">
        {overviewEntry && (
          <NavLink
            href={resolveHref(overviewEntry.href)}
            label={overviewEntry.label}
            active={isActive(activePath, resolveHref(overviewEntry.href))}
          />
        )}

        {groups.map((group) => {
          const groupActive = group.items.some((i) => isActive(activePath, i.href));
          const open = openGroup === group.label || groupActive;
          return (
            <div key={group.label} className="mt-1">
              <button
                type="button"
                onClick={() => setOpenGroup(open ? null : group.label)}
                className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint transition-colors hover:text-ink-soft"
              >
                {group.label}
                <ChevronDown
                  size={13}
                  className={cn("transition-transform", open && "rotate-180")}
                />
              </button>
              {open && (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <NavLink
                      key={item.href}
                      href={item.href}
                      label={item.label}
                      active={isActive(activePath, item.href)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="mt-3 flex flex-col gap-0.5 border-t border-border pt-3">
          {bottomItems.map((item) => (
            <NavLink
              key={item.href}
              label={item.label}
              href={item.href}
              active={isActive(activePath, item.href)}
            />
          ))}
        </div>
      </div>

      <div className="border-t border-border px-3 py-3">
        <SignOutButton />
      </div>
    </nav>
    </>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "block rounded-md px-2.5 py-1.5 text-sm transition-colors",
        active
          ? "border-l-2 border-accent bg-accent-soft pl-2 font-medium text-accent"
          : "border-l-2 border-transparent text-ink-soft hover:bg-surface-2 hover:text-ink"
      )}
    >
      {label}
    </Link>
  );
}
