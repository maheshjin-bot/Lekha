"use client";

import { useEffect, useRef } from "react";
import { register, unregister, resolveShortcut, type ShortcutBinding, type ShortcutScope } from "./registry";

/**
 * The hook every screen with a keyboard shortcut calls.
 *
 *     useShortcuts("voucher-entry", [
 *       { combo: "ctrl+s", label: "Save", handler: save },
 *       { combo: "alt+ArrowDown", handler: addLine }, // no label: works, just not listed anywhere
 *     ]);
 *
 * IMPORTANT — an accelerator, never a requirement: every action a combo
 * here triggers MUST already be reachable some other way (a visible button,
 * a menu item) before it is ever wired into useShortcuts. This hook only
 * gives that existing action a faster path for someone who has learned the
 * key; it must never be the only way to do the thing, the same way
 * ActionRail.tsx's own rows are built to sit next to a button that already
 * works, not replace it (see that file's header comment).
 *
 * WHAT THIS HOOK DOES NOT DO, ON PURPOSE:
 *
 *   - It does not attach its own listener per screen. Every mounted
 *     `useShortcuts` call shares ONE document-level "keydown" listener
 *     (reference-counted below), which asks registry.ts's resolveShortcut()
 *     "given this exact keystroke, which live registration — across every
 *     currently mounted scope — owns it?" and, if the answer belongs to
 *     THIS keystroke at all, fires that one handler. That single point of
 *     resolution is what makes scope stacking well-defined: when a modal
 *     is open, its `useShortcuts` call registered strictly after the
 *     page's (see registry.ts's `priority` field), so if both happen to
 *     bind the same combo, only the modal's fires — the page's binding is
 *     simply never reached for that keystroke. Different combos on
 *     different scopes never compete at all; each only ever matches its
 *     own keystroke. This mirrors Modal.tsx's own Escape handling in
 *     spirit (a document-level listener, added while relevant and removed
 *     on cleanup) while generalising it to more than one combo and more
 *     than one simultaneously-mounted scope.
 *
 *   - It does not re-register on every render. `defs` — and the handler
 *     closures inside it — routinely have a new identity every render
 *     (they close over component state), but re-registering on every
 *     keystroke typed elsewhere on the page would reshuffle the mount-order
 *     `priority` registry.ts's stacking depends on. Instead, `defs` is
 *     written into a ref in its own effect that runs after EVERY render (no
 *     dependency array — deliberately not `useLayoutEffect`, since nothing
 *     here needs to run before paint), and only that stable ref object is
 *     registered once, in a second, separate mount effect keyed on `scope`.
 *     registry.ts reads `ref.current` fresh on every keydown, so handlers
 *     are always current without ever re-registering. The write itself must
 *     live in an effect rather than a plain render-body assignment — this
 *     project's react-hooks/refs rule refuses mutating a ref during render
 *     (same reasoning as lib/config/useScreenConfig.ts's own configRef).
 *
 *   - It does not itself decide whether the currently focused element is
 *     "editable" (an <input>, a combobox, ...) or whether a given combo is
 *     allowed to fire there anyway. Both live in registry.ts's
 *     resolveShortcut(), because that decision has to be made against the
 *     SAME global, cross-scope view of "what's live right now" the
 *     stacking logic already needs — duplicating it here would be a second
 *     place for the two to quietly disagree.
 */
export function useShortcuts(scope: ShortcutScope, defs: ShortcutBinding[]): void {
  const defsRef = useRef<ShortcutBinding[]>(defs);

  // Keeps the ref pointing at the latest `defs` without re-running the
  // registration effect below — see the file header for why. No dependency
  // array: this runs after every render, same timing as the render-body
  // assignment it replaces, just moved somewhere ref mutation is allowed.
  useEffect(() => {
    defsRef.current = defs;
  });

  useEffect(() => {
    const registrationId = register(scope, defsRef);
    addGlobalListener();
    return () => {
      unregister(registrationId);
      removeGlobalListener();
    };
    // Deliberately just `scope`: `defsRef` is a useRef result (React's own
    // exhaustive-deps rule already treats those as stable and does not
    // require them here), and `defs` itself is read through the ref above,
    // not closed over directly — see the file header for why re-running
    // this effect on every `defs` change would break stacking order.
  }, [scope]);
}

// ---------------------------------------------------------------------------
// One shared document-level listener for every mounted useShortcuts call,
// reference-counted so the first mount attaches it and the last unmount
// removes it — same lifecycle shape as CommandBar.tsx's module-level
// `openListeners` Set, just counting instead of collecting callbacks,
// because here there is only ever one thing to call per keystroke
// (resolveShortcut already picked it) rather than one per listener.
// ---------------------------------------------------------------------------

let sharedListenerCount = 0;

function handleKeyDown(event: KeyboardEvent): void {
  const resolved = resolveShortcut(event);
  if (!resolved) return;
  // Only prevented once a real match fires — an unmatched keystroke, or one
  // the input-focus guard inside resolveShortcut() declined, falls through
  // to whatever the browser or the focused field would normally do with it.
  event.preventDefault();
  resolved.binding.handler(event);
}

function addGlobalListener(): void {
  if (sharedListenerCount === 0) {
    document.addEventListener("keydown", handleKeyDown);
  }
  sharedListenerCount++;
}

function removeGlobalListener(): void {
  sharedListenerCount = Math.max(0, sharedListenerCount - 1);
  if (sharedListenerCount === 0) {
    document.removeEventListener("keydown", handleKeyDown);
  }
}
