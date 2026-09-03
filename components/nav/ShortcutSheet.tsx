"use client";

import { useSyncExternalStore } from "react";
import { Modal } from "@/components/ui/Modal";
import { getAllLiveShortcuts, GLOBAL_SCOPE, type ShortcutDef } from "@/lib/keys/registry";

/**
 * The '?' help sheet — every keyboard shortcut currently bound anywhere in
 * the app, grouped by the scope that bound it. AppShell.tsx owns opening
 * this (both from the "shift+?" global shortcut and from its own visible
 * "Keyboard shortcuts" button, per useShortcuts.ts's own rule that a combo
 * must never be the only way to reach the thing it triggers) and passes
 * `open`/`onClose` straight through; this component does no registration of
 * its own, it only reads.
 *
 * WHY THIS READS registry.ts DIRECTLY, ON EVERY OPEN, RATHER THAN SUBSCRIBING:
 *
 * getAllLiveShortcuts() is a plain synchronous snapshot of "what's live
 * right now" (see that function's own header in registry.ts) — not a
 * subscription with a change event to hook into. That is exactly the right
 * shape for a modal that only exists while `open` is true: each time it
 * opens it re-reads the current set, so navigating from a report screen to
 * a voucher-entry screen and THEN pressing '?' correctly shows that screen's
 * own scope alongside "Global", with nothing stale left over from wherever
 * the sheet was last opened.
 */
export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const isMac = useSyncExternalStore(subscribeToNothing, getIsMacSnapshot, getIsMacServerSnapshot);

  // Reading is free even while closed, but there is no point paying for it
  // (or matching against a stale registration count) on a render where the
  // modal is not going to show anything — mirrors Modal.tsx's own `if
  // (!open) return null` short-circuit one level up.
  const groups = open ? groupByScope(getAllLiveShortcuts()) : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Every shortcut bound anywhere in the app right now, grouped by where it works."
    >
      {groups.length === 0 ? (
        <p className="text-sm text-ink-faint">
          Nothing is bound yet — shortcuts only appear here once the screen that owns them has
          mounted.
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <div key={group.scope}>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                {scopeHeading(group.scope)}
              </p>
              <ul className="flex flex-col gap-2">
                {group.defs.map((def) => (
                  <li
                    key={`${def.combo}:${def.label}`}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="text-ink-soft">{def.label}</span>
                    <ComboBadge combo={def.combo} isMac={isMac} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Grouping — Global first (it's the one section every screen shares, so it
// belongs at the top regardless of mount order), then every other live scope
// alphabetically. Sorting by name rather than by mount order keeps the
// sheet's own section order stable across opens instead of reshuffling
// depending on which screen happened to register first.
// ---------------------------------------------------------------------------

function groupByScope(defs: ShortcutDef[]): { scope: string; defs: ShortcutDef[] }[] {
  const byScope = new Map<string, ShortcutDef[]>();
  for (const def of defs) {
    const list = byScope.get(def.scope);
    if (list) list.push(def);
    else byScope.set(def.scope, [def]);
  }

  const scopes = [...byScope.keys()].sort((a, b) => {
    if (a === GLOBAL_SCOPE) return -1;
    if (b === GLOBAL_SCOPE) return 1;
    return a.localeCompare(b);
  });

  return scopes.map((scope) => ({ scope, defs: byScope.get(scope) ?? [] }));
}

/** Scope names are free-form identifiers a screen picks for itself (see
 * registry.ts's own ShortcutScope comment) — "voucher-entry", not a label
 * anyone chose for display. This is the one place that has to turn one into
 * words a reader would recognise, so it does the cheapest thing that could
 * work: title-case the words a hyphen/underscore/space already separates. */
function scopeHeading(scope: string): string {
  if (scope === GLOBAL_SCOPE) return "Global";
  return scope
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Combo display — deliberately duplicated in miniature from ActionRail.tsx's
// own (unexported) keyLabel()/isMac plumbing rather than imported: this is
// the only other file that needs it, ActionRail does not export it, and this
// task's file list does not include creating a new shared module to hold it.
// Kept intentionally smaller than ActionRail's version: registry.ts combos
// are always the plain "ctrl+s"-style strings useShortcuts.ts documents (no
// "then"-sequences, which are ActionRail's own display-only convention for
// something registry.ts's combo grammar cannot express at all), so there is
// no sequence-splitting step here.
// ---------------------------------------------------------------------------

function keyLabel(token: string, isMac: boolean): string {
  switch (token) {
    case "mod":
      return isMac ? "⌘" : "Ctrl";
    case "cmd":
    case "command":
    case "meta":
    case "win":
    case "windows":
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
    case " ":
      return "Space";
    // Every other token is the literal key itself ("s", "?", "arrowup", ...)
    // — a single character is upper-cased for readability (registry.ts's own
    // combos are always lower-case, unlike ActionRail's callers who write
    // their own display casing by hand), anything longer is left as-is.
    default:
      return token.length === 1 ? token.toUpperCase() : token;
  }
}

function ComboBadge({ combo, isMac }: { combo: string; isMac: boolean }) {
  const tokens = combo.split("+").map((raw) => keyLabel(raw.trim(), isMac));
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {tokens.map((token, index) => (
        <kbd
          key={`${token}-${index}`}
          className="rounded border border-border-strong bg-surface-2 px-1 py-px font-mono text-[10px] leading-4 text-ink-faint"
        >
          {token}
        </kbd>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// isMac — same useSyncExternalStore-over-navigator.userAgent shape
// ActionRail.tsx uses (see that file's own header for why a plain useEffect
// setState would trip this project's react-hooks/set-state-in-effect lint),
// duplicated here for the same "no new shared module" reason as above.
// ---------------------------------------------------------------------------

function subscribeToNothing() {
  return () => {};
}

function getIsMacSnapshot(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function getIsMacServerSnapshot(): boolean {
  return false;
}
