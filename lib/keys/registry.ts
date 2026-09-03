/**
 * The keyboard-shortcut registry.
 *
 * Before this module every screen that wanted a shortcut wired its own
 * `document.addEventListener("keydown", ...)` by hand (see Modal.tsx's
 * Escape handler, CommandBar.tsx's Ctrl+K and its own separate Escape
 * handler) — each one correct in isolation, but with no shared place that
 * knows "what combos are bound right now" or "which one wins when two
 * screens bind the same key at once." This file is that shared place.
 * useShortcuts.ts (the hook screens actually call) is the only intended
 * caller of the mutation functions below; everything here is plain,
 * framework-free data and matching logic — no React import, no "use
 * client" — so it stays trivially unit-testable and, like lib/nav/context.ts,
 * safe to import from either side of the server/client line even though in
 * practice only client code ever calls the mutating half of it.
 *
 * WHAT "LIVE" MEANS, AND WHY IT MATTERS:
 *
 * The registry does not hold a hand-curated catalog of every shortcut the
 * app could ever bind (that's what lib/nav/registry.ts's static NavEntry
 * list is, for links). It holds only the shortcuts that are ACTUALLY bound
 * right now, for as long as the screen or modal that bound them stays
 * mounted — a `useShortcuts` call registers on mount and unregisters on
 * unmount. That live-ness is what lets getLiveShortcuts(scope) answer "what
 * can I press on THIS screen, right now" for a future ActionRail wiring
 * (components/nav/ActionRail.tsx already renders a `shortcut` string per
 * row; it does not yet read from this registry — that wiring is a later
 * task, not this one), and it's what makes scope stacking possible at all:
 * see resolveShortcut() below for how a modal's bindings take priority over
 * the page's while both happen to be live at once.
 *
 * COMBO SYNTAX:
 *
 * "ctrl+s", "alt+ArrowUp", "ctrl+shift+s" — '+'-separated tokens, case-
 * insensitive, order-insensitive on the modifiers. Recognised modifier
 * tokens: ctrl/control, alt/option, shift, cmd/command/meta/win/windows
 * (all four collapse to the browser's metaKey), and "mod" — resolved at
 * MATCH time (see isMacPlatform()) to ctrlKey on Windows/Linux and metaKey
 * on a Mac, the same abstraction ActionRail's own `keyLabel()` already
 * renders for display. Every other token is the key itself, matched
 * case-insensitively against KeyboardEvent.key (so "ArrowUp" and "s" both
 * just work); exactly one such token is required; a combo with zero or two-
 * plus key tokens is malformed and logged once, in development, rather than
 * silently mis-firing.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A scope is just a name two things agree on: the screen (or modal) that
 * registers shortcuts under it, and anything reading them back out via
 * getLiveShortcuts(). Left as a plain string rather than a closed union —
 * new screens must be free to pick a new scope name without editing this
 * file, the same reasoning lib/nav/registry.ts's ModuleCode union does NOT
 * apply to hrefs. 'global' is a convention for app-shell-level bindings
 * (e.g. CommandBar's Ctrl+K, if it is ever migrated onto this hook), not a
 * magic string this file treats specially — see resolveShortcut() for why
 * stacking priority does not need one. GLOBAL_SCOPE below is that
 * convention made a real export, so the handful of files that need to name
 * it (AppShell.tsx, which registers under it; ShortcutSheet.tsx, which
 * always shows it first) share one spelling instead of retyping the string.
 */
export type ShortcutScope = string;

/** The scope AppShell.tsx binds its four app-wide "new voucher" shortcuts
 * and the '?' help-sheet shortcut under — see the ShortcutScope comment
 * above for why this exists as a named export rather than a bare literal
 * repeated at each call site. Nothing below treats this value specially;
 * it is exported purely so two files can agree on it by import instead of
 * by convention. */
export const GLOBAL_SCOPE: ShortcutScope = "global";

/** The introspectable shape of one live shortcut — what getLiveShortcuts()
 * hands back for a future ActionRail (or any other "what can I press here"
 * UI) to render. Every field required: an entry only appears here at all
 * once a binding has been given a `label` (see ShortcutBinding below), so
 * by the time one reaches this type there is always something to show. */
export type ShortcutDef = {
  combo: string;
  label: string;
  scope: ShortcutScope;
};

/** What useShortcuts.ts's `defs` array actually holds. `combo` and
 * `handler` are the two things the hook cannot do its job without; `label`
 * is optional because not every interception is meant to be advertised
 * anywhere — a screen can swallow a browser default (say, blocking a
 * keystroke that would otherwise scroll the page in a dense entry grid)
 * without that ever needing to appear on an ActionRail. Only bindings that
 * DO carry a label are surfaced by getLiveShortcuts(); unlabelled ones still
 * fire normally, they are just invisible to introspection. */
export type ShortcutBinding = {
  combo: string;
  handler: (event: KeyboardEvent) => void;
  label?: string;
};

/** What resolveShortcut() hands back to useShortcuts.ts's single shared
 * listener: which live registration owns the match, and the exact binding
 * (so the listener can call its handler) — see registry.ts's header and
 * useShortcuts.ts for why only ONE binding is ever returned per keystroke. */
export type ResolvedShortcut = {
  registrationId: number;
  scope: ShortcutScope;
  binding: ShortcutBinding;
};

// ---------------------------------------------------------------------------
// Live registrations
//
// One entry per MOUNTED `useShortcuts(scope, defs)` call, not per combo —
// several components can share a scope name, and one component's defs
// array can hold several combos. `defsRef` is a live indirection (the
// exact ref object useShortcuts.ts's useRef returns) rather than a snapshot
// copied at registration time: a screen's defs typically close over
// component state and re-create their handler functions every render, and
// re-registering on every render would reshuffle `priority` (see below) on
// every keystroke the user types elsewhere on the page. Reading
// `defsRef.current` instead means the registry always sees this render's
// handlers without ever needing to re-register.
// ---------------------------------------------------------------------------

type LiveRegistration = {
  id: number;
  scope: ShortcutScope;
  /** Assigned once, at registration, from a monotonic counter — never
   * recomputed on a defs change. This is what makes "the modal's shortcuts
   * take priority over the page's while it's open" true: the modal mounts
   * (and registers) strictly after the page beneath it, so it always has
   * the higher number, and resolveShortcut() below simply prefers higher
   * numbers. No scope name is special-cased for this — recency alone
   * produces exactly the stacking behaviour Modal.tsx's own Escape handler
   * gives you today (whichever thing opened most recently owns the key). */
  priority: number;
  defsRef: { current: ShortcutBinding[] };
};

let nextRegistrationId = 0;
let nextPriority = 0;
const liveRegistrations: LiveRegistration[] = [];

/**
 * Called once by useShortcuts.ts, inside its mount effect. Returns an id to
 * hand back to unregister(). Also runs the (development-only) duplicate-
 * combo check below — see its own comment for what it does and does not
 * guard against.
 */
export function register(scope: ShortcutScope, defsRef: { current: ShortcutBinding[] }): number {
  const id = nextRegistrationId++;
  liveRegistrations.push({ id, scope, priority: nextPriority++, defsRef });
  warnOnLiveCollisions();
  return id;
}

/** Called once by useShortcuts.ts, in its effect's cleanup — the mirror
 * image of register(), removing exactly the entry that call created. */
export function unregister(registrationId: number): void {
  const index = liveRegistrations.findIndex((entry) => entry.id === registrationId);
  if (index !== -1) liveRegistrations.splice(index, 1);
}

/**
 * "So two screens can never silently bind the same combo differently": a
 * development-only console.warn (never thrown, never blocks anything —
 * runtime behaviour is always deterministic via resolveShortcut()'s
 * priority order regardless of whether this fires) whenever two
 * SIMULTANEOUSLY LIVE bindings — anywhere, same scope or different — claim
 * the same canonical combo. Checked only at registration time, not on
 * every keystroke: cheap, and a mount is exactly the moment a collision was
 * actually just introduced. A modal deliberately shadowing a page shortcut
 * (its whole reason for existing, per the task this file was built for) is
 * a false positive by design — the warning is a nudge to double-check that
 * an overlap is intentional, not a rule that intentional overlaps break.
 */
function warnOnLiveCollisions(): void {
  if (process.env.NODE_ENV === "production") return;

  const seen = new Map<string, ShortcutScope>();
  for (const entry of liveRegistrations) {
    for (const binding of entry.defsRef.current) {
      const parsed = parseCombo(binding.combo);
      if (!parsed) continue;
      const canonical = canonicalCombo(parsed);
      const existingScope = seen.get(canonical);
      if (existingScope !== undefined && existingScope !== entry.scope) {
        console.warn(
          `[lib/keys] "${binding.combo}" is bound in both scope "${existingScope}" and ` +
            `scope "${entry.scope}" at the same time. Whichever mounted most recently wins ` +
            `— if that's not a deliberate override (a modal shadowing the page beneath it), ` +
            `rename one of the two combos.`
        );
      } else if (existingScope === undefined) {
        seen.set(canonical, entry.scope);
      }
    }
  }
}

/**
 * Every labelled, currently-live shortcut bound under one scope — what a
 * future ActionRail wiring reads to show "the shortcuts you can press on
 * this screen right now." Plain synchronous read, not a subscription: this
 * task only needs the data to exist and be correct at call time, not to
 * push updates to a mounted rail — an actual reactive consumer can layer
 * useSyncExternalStore on top later (ActionRail.tsx already uses that hook
 * for its isMac read, so the pattern is established) without this file
 * changing shape.
 */
export function getLiveShortcuts(scope: ShortcutScope): ShortcutDef[] {
  const defs: ShortcutDef[] = [];
  for (const entry of liveRegistrations) {
    if (entry.scope !== scope) continue;
    for (const binding of entry.defsRef.current) {
      if (binding.label === undefined) continue;
      defs.push({ combo: binding.combo, label: binding.label, scope });
    }
  }
  return defs;
}

/**
 * Every labelled, currently-live shortcut across EVERY scope at once — what
 * ShortcutSheet.tsx reads to render "every currently-registered shortcut,
 * grouped by scope" without first having to know the full set of scope
 * names live in the app right now, which getLiveShortcuts(scope) above
 * cannot answer on its own (it only ever looks inside one named scope).
 * Same plain-synchronous-read shape as that function and for the same
 * reason: a help sheet only needs to be correct at the moment someone opens
 * it, not to push live updates into one that is already open.
 */
export function getAllLiveShortcuts(): ShortcutDef[] {
  const defs: ShortcutDef[] = [];
  for (const entry of liveRegistrations) {
    for (const binding of entry.defsRef.current) {
      if (binding.label === undefined) continue;
      defs.push({ combo: binding.combo, label: binding.label, scope: entry.scope });
    }
  }
  return defs;
}

// ---------------------------------------------------------------------------
// Dispatch — resolving a single keydown event to at most one binding.
//
// This is what makes scope stacking work with a SINGLE shared document
// listener (see useShortcuts.ts) instead of one listener per mounted
// screen fighting over the same keystroke: given an event, walk every live
// registration from highest priority (most recently mounted) to lowest,
// and return the first binding whose combo matches. If the page and an
// open modal both bound "ctrl+enter", only the modal's — the higher-
// priority one — is ever returned; the page's binding is simply never
// reached for that keystroke, exactly as if it were not registered at all.
// If they bound DIFFERENT combos, both keep working independently, because
// each is only ever a candidate for its own keystroke.
// ---------------------------------------------------------------------------

export function resolveShortcut(event: KeyboardEvent): ResolvedShortcut | null {
  const editable = isEditableTarget(event.target);

  // Sorted freshly per event rather than kept sorted incrementally — the
  // list is at most a handful of entries (one per mounted screen/modal),
  // so an O(n log n) sort on every keydown is immaterial, and it avoids
  // this file having to keep a second, separately-maintained ordering in
  // sync with register()/unregister().
  const ordered = [...liveRegistrations].sort((a, b) => b.priority - a.priority);

  for (const entry of ordered) {
    for (const binding of entry.defsRef.current) {
      const parsed = parseCombo(binding.combo);
      if (!parsed) continue; // malformed — already warned about at parse time
      if (!comboMatchesEvent(parsed, event)) continue;
      // The input-focus guard: a combo with no ctrl/alt/cmd component must
      // yield to whatever the focused editable field would otherwise do
      // with the same key (typing, Enter-to-submit-a-form, Tab to the next
      // field). Shift alone does NOT count as an override here — Shift+
      // Enter/Shift+Tab are ordinary field behaviour, not accelerators —
      // which is why comboHasBypassModifier ignores `shift` entirely below.
      if (editable && !comboHasBypassModifier(parsed)) continue;
      return { registrationId: entry.id, scope: entry.scope, binding };
    }
  }
  return null;
}

/**
 * <input>, <textarea>, [contenteditable], or a combobox/listbox widget has
 * focus. Read off event.target (the element that actually received the
 * keydown) rather than document.activeElement — for a real DOM keydown
 * they are the same element, and target is simpler to reason about here
 * with no risk of a shadow-DOM boundary changing what activeElement reports.
 *
 * The `[role="listbox"], [role="combobox"]` check exists for widgets built
 * like CommandBar.tsx's palette — its own header comment explains that its
 * rows are plain `role="option"` divs with DOM focus staying on the
 * `<input role="combobox">` the whole time, so in practice that specific
 * widget is already covered by the plain INPUT check above. This closest()
 * check is the belt-and-braces case: any OTHER combobox/listbox this app
 * builds later that instead moves real focus onto a `role="option"` row
 * (or any element nested inside one) is still caught, because closest()
 * walks up through it to the ancestor role.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  if (target.closest('[role="listbox"], [role="combobox"]')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Combo parsing and matching.
// ---------------------------------------------------------------------------

type ParsedCombo = {
  /** Lowercased, alias-resolved (e.g. "esc" -> "escape"). Compared against
   * event.key.toLowerCase(), so "ArrowUp"/"arrowup"/"s"/"S" all just work. */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Resolved to ctrl (Windows/Linux) or meta (Mac) at MATCH time, not at
   * parse time — see comboMatchesEvent(). Kept as its own flag rather than
   * eagerly folded into ctrl/meta because parseCombo() has no event to
   * check the platform against, and the parsed-combo cache below must stay
   * platform-independent so it cannot go stale if that ever changed. */
  mod: boolean;
};

const MODIFIER_ALIASES: Record<string, "ctrl" | "alt" | "shift" | "meta" | "mod"> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  win: "meta",
  windows: "meta",
  mod: "mod",
};

/** Aliases for the key token itself, not the modifiers — mirrors the small
 * set ActionRail.tsx's own keyLabel() already recognises for display, so a
 * combo string and its on-screen label can agree on what to call a key. */
const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  space: " ",
  spacebar: " ",
};

// Parsing a combo string is pure and the set of distinct combo strings the
// app ever binds is small and static, so caching avoids re-splitting the
// same "ctrl+s" on every keydown across every mounted scope.
const parseCache = new Map<string, ParsedCombo | null>();

function parseCombo(raw: string): ParsedCombo | null {
  const cached = parseCache.get(raw);
  if (cached !== undefined) return cached;
  const parsed = parseComboUncached(raw);
  parseCache.set(raw, parsed);
  return parsed;
}

function parseComboUncached(raw: string): ParsedCombo | null {
  const tokens = raw
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== "");

  if (tokens.length === 0) {
    warnMalformed(raw, "empty combo");
    return null;
  }

  const parsed: ParsedCombo = { key: "", ctrl: false, alt: false, shift: false, meta: false, mod: false };
  let keyToken: string | null = null;

  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token];
    if (modifier) {
      parsed[modifier] = true;
      continue;
    }
    if (keyToken !== null) {
      warnMalformed(raw, `more than one key ("${keyToken}" and "${token}") — a combo takes exactly one`);
      return null;
    }
    keyToken = token;
  }

  if (keyToken === null) {
    warnMalformed(raw, "no key — only modifiers were given");
    return null;
  }

  parsed.key = KEY_ALIASES[keyToken] ?? keyToken;
  return parsed;
}

function warnMalformed(raw: string, reason: string): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[lib/keys] malformed shortcut combo "${raw}" (${reason}) — it will never fire.`);
  }
}

/** navigator.userAgent read fresh on every call rather than cached at
 * module load: this module has no mount/hydration lifecycle of its own to
 * hook a one-time read into (unlike ActionRail's useSyncExternalStore
 * read), and it is only ever actually called from inside a real keydown
 * handler — which by definition only fires in a browser — so there is no
 * SSR call site to guard against. */
function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function comboMatchesEvent(parsed: ParsedCombo, event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== parsed.key) return false;

  const wantsMod = parsed.mod;
  const macMod = wantsMod && isMacPlatform();
  const wantCtrl = parsed.ctrl || (wantsMod && !macMod);
  const wantMeta = parsed.meta || macMod;

  // Every flag is compared EXACTLY, not "at least" — otherwise "ctrl+s"
  // would also match a keystroke of Ctrl+Shift+S that some other binding
  // owns on purpose, and one keystroke could resolve to two different
  // combos depending on which was checked first.
  return (
    event.ctrlKey === wantCtrl &&
    event.metaKey === wantMeta &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift
  );
}

/** ctrl/alt/cmd (in any of their aliased forms, including "mod") justify
 * firing even while an editable field has focus. Shift is deliberately
 * excluded — see resolveShortcut()'s own comment on why. */
function comboHasBypassModifier(parsed: ParsedCombo): boolean {
  return parsed.ctrl || parsed.alt || parsed.meta || parsed.mod;
}

/** A canonical string for equality/collision checks — same combo, any
 * modifier order, always produces the same key, which is what makes
 * warnOnLiveCollisions()'s Map lookup order-insensitive without every
 * caller having to normalise their own combo strings by hand. */
function canonicalCombo(parsed: ParsedCombo): string {
  const mods = [
    parsed.ctrl && "ctrl",
    parsed.meta && "meta",
    parsed.alt && "alt",
    parsed.shift && "shift",
    parsed.mod && "mod",
  ].filter((m): m is string => Boolean(m));
  return [...mods, parsed.key].join("+");
}
