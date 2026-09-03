"use client";

import Link from "next/link";
import { useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * One row of the rail. `href` and `onClick` are both optional and both may be
 * absent: a row with neither is a pure teaching row — a shortcut that exists
 * in the app but has no button of its own (search, for instance) — which is
 * half the point of this surface.
 *
 * `onClick` is a function, so it can only be passed from a client component.
 * Every report page in this app is a Server Component, so those pages pass
 * `href` (a plain string, which serializes fine) and let ReportShell supply
 * the handler-backed rows it builds itself.
 */
export type ActionRailItem = {
  label: string;
  /**
   * Written the way a person says it: "mod+P", "Shift+?", "G then T".
   * `mod` is deliberately abstract — it renders ⌘ on a Mac and Ctrl
   * everywhere else, so one string is right on both.
   */
  shortcut?: string;
  href?: string;
  onClick?: () => void;
  /** Rendered as-is; pass a sized lucide icon, e.g. `<Printer size={14} />`. */
  icon?: ReactNode;
};

/** A shortcut string, broken into what the eye should read as separate keys. */
type ShortcutToken = { kind: "key" | "sep"; text: string };

/**
 * "mod+P" -> [⌘][P]; "G then T" -> [G] then [T]. Sequences are split first
 * (on the literal word "then") because they mean "press these one after the
 * other", which is the opposite of the simultaneous "+" combination, and
 * showing both as one undifferentiated run of chips would teach the wrong
 * thing.
 */
function shortcutTokens(shortcut: string, isMac: boolean): ShortcutToken[] {
  const tokens: ShortcutToken[] = [];
  const sequence = shortcut.split(/\s+then\s+/i).filter((part) => part.trim() !== "");

  sequence.forEach((combo, index) => {
    if (index > 0) tokens.push({ kind: "sep", text: "then" });
    for (const raw of combo.split("+")) {
      const key = raw.trim();
      if (key === "") continue;
      tokens.push({ kind: "key", text: keyLabel(key, isMac) });
    }
  });

  return tokens;
}

/**
 * Only the modifier names get rewritten. Everything else ("P", "Esc", "/",
 * "↑") is passed through verbatim, because the caller wrote what the user
 * actually presses and second-guessing it (upper-casing, say) would mangle
 * punctuation shortcuts.
 */
function keyLabel(key: string, isMac: boolean): string {
  switch (key.toLowerCase()) {
    case "mod":
      return isMac ? "⌘" : "Ctrl";
    case "cmd":
    case "meta":
      return isMac ? "⌘" : "Win";
    case "ctrl":
    case "control":
      return isMac ? "⌃" : "Ctrl";
    case "alt":
    case "option":
      return isMac ? "⌥" : "Alt";
    case "shift":
      return isMac ? "⇧" : "Shift";
    case "enter":
    case "return":
      return isMac ? "↩" : "Enter";
    case "esc":
    case "escape":
      return "Esc";
    default:
      return key;
  }
}

/**
 * navigator.userAgent is a real external store, not React state: it never
 * changes for the life of a tab, but it does not exist on the server and
 * reading it eagerly on the client's first render (before hydration
 * reconciles) would make that render disagree with the SSR markup.
 *
 * useSyncExternalStore is this project's standard way to read exactly that
 * shape of value — see lib/scan/queueClient.ts and components/scan/ScanApp.tsx
 * for the same pattern — because it returns the server snapshot until
 * hydration and the real one after, with no setState call inside an effect.
 * A plain `useEffect(() => setIsMac(...), [])` does the same job but is a
 * synchronous setState-in-an-effect, which this project's react-hooks lint
 * (react-hooks/set-state-in-effect) rejects outright.
 */
function subscribeToNothing() {
  // navigator.userAgent cannot change under us, so there is nothing to
  // subscribe to — the snapshot functions below are read once, after mount.
  return () => {};
}

function getIsMacSnapshot(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function getIsMacServerSnapshot(): boolean {
  // Windows wins the server pass — it is what nearly every user of this app
  // is on — and the Mac glyph swaps in on the client once
  // useSyncExternalStore re-reads the real navigator.userAgent after mount.
  return false;
}

/**
 * A right-hand column of the actions that belong to the screen you are on,
 * each one showing the keyboard shortcut that does the same thing.
 *
 * The point is not the buttons — most of them exist elsewhere on the page
 * already. The point is that the shortcut sits *next to* the button somebody
 * is already clicking twenty times a day, which is the only way anyone ever
 * learns one. A help modal listing the same keys teaches nobody, because it
 * is only opened by people who already know the shortcuts exist.
 *
 * Hidden below `lg:` (there is no room beside the content on a phone, and no
 * keyboard to teach) and in print (it is chrome, not report content). It also
 * carries `data-html2canvas-ignore` so the JPG export of a report — which
 * rasterises the whole page container, print rules and all — keeps rendering
 * exactly the report and not this rail.
 */
export function ActionRail({
  actions,
  heading = "Actions",
  className,
}: {
  actions: ActionRailItem[];
  /** Also the accessible name of the landmark; keep it short. */
  heading?: string;
  className?: string;
}) {
  const isMac = useSyncExternalStore(subscribeToNothing, getIsMacSnapshot, getIsMacServerSnapshot);

  if (actions.length === 0) return null;

  return (
    <aside
      aria-label={heading}
      data-html2canvas-ignore
      className={cn("hidden w-52 shrink-0 lg:block print:hidden", className)}
    >
      {/* Sticky so the rail is still there at the bottom of a 400-row trial
          balance — an action you have to scroll back up to reach is an action
          people stop using. */}
      <div className="sticky top-10 rounded-[14px] border border-border bg-surface p-2 shadow-card">
        <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          {heading}
        </p>
        <ul className="flex flex-col gap-0.5">
          {actions.map((action) => (
            <li key={action.label}>
              <ActionRow action={action} isMac={isMac} />
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

/** Shared between the link, button and inert shapes so all three line up. */
const rowClass =
  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-ink-soft transition-colors duration-150";
const interactiveRowClass =
  "hover:bg-accent-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

function ActionRow({ action, isMac }: { action: ActionRailItem; isMac: boolean }) {
  const body = (
    <>
      {action.icon && <span className="shrink-0 text-ink-faint">{action.icon}</span>}
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
      {action.shortcut && <Shortcut shortcut={action.shortcut} isMac={isMac} />}
    </>
  );

  if (action.href) {
    return (
      <Link href={action.href} className={cn(rowClass, interactiveRowClass)}>
        {body}
      </Link>
    );
  }

  if (action.onClick) {
    return (
      <button type="button" onClick={action.onClick} className={cn(rowClass, interactiveRowClass)}>
        {body}
      </button>
    );
  }

  // Neither: a shortcut with no clickable twin. Rendered flat and unhoverable
  // so it never looks like a dead button.
  return <span className={rowClass}>{body}</span>;
}

function Shortcut({ shortcut, isMac }: { shortcut: string; isMac: boolean }) {
  const tokens = shortcutTokens(shortcut, isMac);
  if (tokens.length === 0) return null;

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {tokens.map((token, index) =>
        token.kind === "sep" ? (
          <span key={`${token.text}-${index}`} className="px-0.5 text-[10px] text-ink-faint">
            {token.text}
          </span>
        ) : (
          <kbd
            key={`${token.text}-${index}`}
            className="rounded border border-border-strong bg-surface-2 px-1 py-px font-mono text-[10px] leading-4 text-ink-faint"
          >
            {token.text}
          </kbd>
        )
      )}
    </span>
  );
}
