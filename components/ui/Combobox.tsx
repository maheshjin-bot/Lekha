"use client";

import { useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * The type-ahead replacement for a native `<select>` — party/item/ledger/
 * godown pickers across the app. This one component is expected to carry
 * most of the perceived speed difference against Tally, so the keyboard
 * interaction (below) is the point of the exercise, not the visuals.
 *
 * INTEGRATION SURFACE: this file owns ONLY the picker itself — matching a
 * label to an id out of a list, with search and keyboard control. It does
 * NOT know about quick-add. A caller that wants "no match? create one" wires
 * `onCreateNew` to open its own components/ledgers/QuickAddLedgerModal.tsx or
 * components/items/QuickAddItemModal.tsx (both already read, both already
 * take `{ open, onClose, onCreated }` and, on ledgers, a `prefill.name` this
 * component's typed text drops straight into) and, from that modal's
 * `onCreated`, appends the new row to `options` and calls this component's
 * `onChange` with its id. That round trip is what closes this popup again —
 * see the value-sync block below. This file is never wired into a form by
 * itself; a later task does that per-screen.
 *
 * ============================================================================
 * ARIA PATTERN — copied from components/nav/CommandBar.tsx, not reinvented
 * ============================================================================
 * Same "editable combobox with list autocomplete" shape CommandBar already
 * established: DOM focus never leaves the `<input>` (role="combobox"); every
 * result row is a plain `<div role="option">`, never a `<button>`, so a click
 * on one cannot itself blur the input (a non-focusable element receiving a
 * click does not move focus in any browser — that fact is what keeps the
 * click-to-select and blur-to-revert logic below from racing each other); and
 * the highlighted row is communicated purely via `aria-activedescendant`,
 * mirrored onto the row's own `aria-selected` exactly as CommandBar does it.
 *
 * ============================================================================
 * TWO DISPLAY MODES: "browsing" vs "filtering" — and why NEITHER touches
 * `value` until the user does something deliberate
 * ============================================================================
 * Opening the popup (by focus OR by typing, per the brief) does not, by
 * itself, mean the user has expressed an opinion about which row they want.
 * Two different opens need two different lists:
 *
 *   - Tabbing/clicking into a field that already holds a value should show
 *     the FULL option list, exactly like a native `<select>` does when you
 *     open it — not the list filtered down to just the current value's own
 *     text (which is what naively filtering on `query` from the first frame
 *     would do, since `query` starts equal to the selected label).
 *   - Typing narrows that same list by substring, same as any type-ahead.
 *
 * `hasEdited` is the flag that tells the two apart: false the instant the
 * popup opens (by focus), true the instant a keystroke actually changes the
 * text. `filteredOptions` below ignores `query` entirely until `hasEdited`
 * flips true (or the field is empty, where "all options" and "options
 * matching nothing" are the same set anyway).
 *
 * ============================================================================
 * WHY `activeIndex` STARTS AT -1, NOT 0 — the one deviation from CommandBar
 * ============================================================================
 * CommandBar defaults its highlighted row to index 0 the moment it has
 * anything to show, because Enter there is pure navigation (open a page) —
 * an accidental Enter on an untouched command bar costs nothing. Enter (or a
 * passive Tab) here WRITES which ledger/item/godown a real voucher line
 * posts against. Defaulting to "the first row in the whole list" would mean
 * tabbing into a never-before-touched, still-empty field and straight back
 * out of it (a completely ordinary thing to do while filling a form) could
 * silently stamp some arbitrary alphabetically-first ledger onto the line.
 * So nothing is highlighted until the user does something deliberate — types
 * a character (`hasEdited` → true, activeIndex snaps to 0 over the NARROWED
 * list, same "type then Enter picks the top match" feel CommandBar has) or
 * presses an arrow key. Tab and Enter both refuse to act while
 * `activeIndex < 0`, which given the paragraph above is now equivalent to
 * "nothing deliberate has happened yet" — no separate flag needed for that.
 *
 * ============================================================================
 * "Create <text>" — WHY SELECTING IT DOES NOT CLOSE THE POPUP
 * ============================================================================
 * The brief's own wording: selecting it "calls onCreateNew(typedText)
 * INSTEAD OF closing" — read literally, not "closes and also calls it". A
 * caller wires `onCreateNew` to open its quick-add modal (a full-screen
 * overlay, z-50, per Modal.tsx) on top of this field, so whether THIS popup
 * is technically open or closed underneath is invisible either way while
 * that modal is up. What it changes is what happens if the modal is
 * cancelled: leaving this popup's `open`/`query` untouched means the search
 * text the user already typed is still sitting right here to keep browsing
 * or retry create — closing it would have thrown that typing away for no
 * reason. If instead the modal succeeds, its `onCreated` calls this
 * component's `onChange` with the new id, and the value-sync block below
 * (which reacts to `value` changing no matter what `open` was) is what
 * actually closes the popup and shows the new selection — not this handler.
 *
 * Alt+C is Tally's own keyboard shortcut for "create a new master from
 * inside a lookup field" — offered here as a direct alias for the same
 * action, independent of whether a "Create" row is even being shown (unlike
 * selecting the row, Alt+C works the instant the field has focus).
 *
 * ============================================================================
 * WHY BLUR NEEDS A REF, NOT JUST STATE
 * ============================================================================
 * Tab is handled in `onKeyDown`, synchronously, before the browser's own
 * default action (moving focus, which fires this input's blur) runs. Row
 * selection sets `query` to the picked label immediately, in that same
 * synchronous handler — but `onBlur` is a SEPARATE handler defined by the
 * same render, and whether React has re-rendered with the new state before
 * blur fires is not something this file should have to reason about frame by
 * frame. `justSelectedRef` sidesteps the race outright: selection sets it,
 * blur reads-and-clears it, and if it was set, blur skips the "revert to the
 * last committed label" step it would otherwise always run. A `ref` rather
 * than `useState` on purpose — this is communication between two handlers in
 * the same tick, not a value the render output depends on.
 */

export type ComboboxOption = {
  /** Stable id — this is what `value`/`onChange` traffic in, matching a
   * native `<select>`'s own value contract. */
  id: string;
  label: string;
  /** Rendered faded under the label, same visual language as CommandBar's
   * result rows (group / HSN / balance, depending on what's being picked). */
  sublabel?: string | null;
};

export type ComboboxProps = {
  /** The selected option's id, or null/empty for "nothing chosen yet". Must
   * be found in `options` for its label to display — a value that is not (a
   * stale id, or a newly-created row the caller has not yet appended to
   * `options`) displays as empty, same as a native `<select>` whose `value`
   * matches no `<option>`. */
  value: string | null | undefined;
  /** Fired ONLY when the user deliberately commits a row — a click, Enter or
   * Tab on a highlighted option. Never fired with an empty/null value by
   * this component itself: Escape, Tab-with-nothing-highlighted and blur all
   * leave `value` exactly as they found it, per the brief. */
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  /** Renders a "Create <text>" row when there is typed text and it matches
   * no option — see the file header for exactly when it fires and why
   * selecting it does not itself close the popup. Omit it and this is a
   * plain, closed set of options — the "no matches" empty state is all a
   * caller gets for text nothing matches. */
  onCreateNew?: (typedText: string) => void;
  disabled?: boolean;
  /** For a `<label htmlFor>` elsewhere on the form. */
  id?: string;
  className?: string;
  "aria-label"?: string;
};

/** 2 = label starts with the query, 1 = label or sublabel contains it
 * anywhere, 0 = no match. Coarser than CommandBar's own four-tier registry
 * score (no keyword-synonym list here — options are plain rows, not nav
 * entries) but the same shape, for the same reason: closest matches first. */
function scoreOption(option: ComboboxOption, q: string): number {
  const label = option.label.toLowerCase();
  if (label.startsWith(q)) return 2;
  if (label.includes(q)) return 1;
  if (option.sublabel && option.sublabel.toLowerCase().includes(q)) return 1;
  return 0;
}

const fieldClass =
  "w-full rounded-lg border border-border-strong bg-surface py-2 pl-3 pr-8 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50";

export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  onCreateNew,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
}: ComboboxProps) {
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  // See "WHY BLUR NEEDS A REF, NOT JUST STATE" above.
  const justSelectedRef = useRef(false);

  const selectedOption = options.find((o) => o.id === value) ?? null;
  const selectedLabel = selectedOption?.label ?? "";

  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const [hasEdited, setHasEdited] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  // Tracks the last external `value` this component has already reflected
  // into `query`/`open` — the marker the block below compares against so it
  // can tell "the caller changed `value` out from under us" apart from
  // "nothing changed since last render", the same seed-marker technique
  // QuickAddLedgerModal/QuickAddItemModal use for their own `prefill` props.
  const [lastSyncedValue, setLastSyncedValue] = useState(value ?? null);

  /*
   * Adjusting state when a prop changes — React's own supported pattern
   * (react.dev, "You Might Not Need an Effect"), not an effect: doing this
   * in an effect would paint the old label for one frame before snapping to
   * the new one, and would run one render late for the "Tab already set
   * `query` itself, this is a no-op" case discussed in the file header.
   *
   * This is what actually finishes the onCreateNew flow: the caller's
   * quick-add modal calls this component's `onChange(newId)` from its own
   * `onCreated`, `value` changes, and — regardless of whatever `open`/
   * `query` this popup was left in by "instead of closing" above — this
   * block snaps straight to showing the new selection, closed. It is also
   * what makes selecting a row here correct without this component having
   * to trust its own optimistic state: if `onChange` does not result in
   * `value` actually changing (a caller that ignores it, or a same-value
   * reselect), `selectOption` below still closes the popup itself — this
   * block is what re-confirms the display against the source of truth once
   * the prop round-trip actually lands.
   */
  if ((value ?? null) !== lastSyncedValue) {
    setLastSyncedValue(value ?? null);
    setQuery(selectedLabel);
    setOpen(false);
    setHasEdited(false);
    setActiveIndex(-1);
  }

  // A caller disabling the field mid-interaction (e.g. the moment a save
  // starts) should not leave a stale popup floating over a now-inert input.
  if (disabled && open) {
    setOpen(false);
    setHasEdited(false);
    setActiveIndex(-1);
    setQuery(selectedLabel);
  }

  const trimmedQuery = query.trim();

  const filteredOptions = useMemo(() => {
    if (!hasEdited || trimmedQuery === "") return options;
    const q = trimmedQuery.toLowerCase();
    return options
      .map((o) => ({ o, score: scoreOption(o, q) }))
      .filter((x) => x.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.o.label.length - b.o.label.length ||
          a.o.label.localeCompare(b.o.label)
      )
      .map((x) => x.o);
  }, [options, hasEdited, trimmedQuery]);

  // Only reachable when there is typed text NONE of the options matched —
  // never alongside real matches, so keyboard nav below never has to choose
  // between a real row and the create row at the same index.
  const showCreateRow = !!onCreateNew && trimmedQuery !== "" && filteredOptions.length === 0;
  const totalItems = showCreateRow ? 1 : filteredOptions.length;
  const createRowId = `${listboxId}-create`;
  const activeId =
    activeIndex < 0
      ? undefined
      : showCreateRow
        ? createRowId
        : `${listboxId}-opt-${activeIndex}`;

  function scrollActiveIntoView(index: number) {
    itemRefs.current[index]?.scrollIntoView({ block: "nearest" });
  }

  function selectOption(option: ComboboxOption) {
    justSelectedRef.current = true;
    onChange(option.id);
    setQuery(option.label);
    setOpen(false);
    setHasEdited(false);
    setActiveIndex(-1);
  }

  function triggerCreate() {
    if (!onCreateNew) return;
    onCreateNew(trimmedQuery);
    // Deliberately no state change here — see "WHY SELECTING IT DOES NOT
    // CLOSE THE POPUP" above.
  }

  /** Escape, and Tab/blur with nothing deliberately highlighted: leave
   * `value` untouched, snap the visible text back to what is actually
   * selected. */
  function closeWithoutSelecting() {
    setOpen(false);
    setHasEdited(false);
    setActiveIndex(-1);
    setQuery(selectedLabel);
  }

  function handleFocus(e: React.FocusEvent<HTMLInputElement>) {
    setOpen(true);
    setHasEdited(false);
    setActiveIndex(-1);
    // Existing text ready to be typed straight over, same as tabbing into a
    // field in Tally/BUSY does — the first keystroke replaces it via the
    // browser's own "typing over a selection" behaviour, no extra wiring.
    e.target.select();
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value);
    setHasEdited(true);
    setOpen(true);
    setActiveIndex(0);
  }

  function handleBlur() {
    if (justSelectedRef.current) {
      justSelectedRef.current = false;
      setOpen(false);
      return;
    }
    closeWithoutSelecting();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.altKey && e.key.toLowerCase() === "c" && onCreateNew) {
      e.preventDefault();
      triggerCreate();
      return;
    }

    if (e.key === "ArrowDown") {
      if (!open) {
        setOpen(true);
        return;
      }
      e.preventDefault();
      if (totalItems === 0) return;
      setActiveIndex((i) => {
        const next = Math.min(i + 1, totalItems - 1);
        scrollActiveIntoView(next);
        return next;
      });
    } else if (e.key === "ArrowUp") {
      if (!open) return;
      e.preventDefault();
      if (totalItems === 0) return;
      setActiveIndex((i) => {
        const next = Math.max(i - 1, 0);
        scrollActiveIntoView(next);
        return next;
      });
    } else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      if (showCreateRow && activeIndex === 0) {
        triggerCreate();
      } else if (!showCreateRow && activeIndex >= 0 && activeIndex < filteredOptions.length) {
        selectOption(filteredOptions[activeIndex]);
      }
    } else if (e.key === "Escape") {
      if (!open) return;
      e.preventDefault();
      closeWithoutSelecting();
    } else if (e.key === "Tab") {
      // No preventDefault anywhere in this branch — Tab must still move
      // focus on. It only decides whether to commit a row FIRST. The create
      // row is deliberately excluded (only Enter/click/Alt+C trigger
      // create) — see the file header on why Tab does not just abandon a
      // real match but also should never fire a side-effecting create as a
      // side effect of routine field-to-field navigation.
      if (open && !showCreateRow && activeIndex >= 0 && activeIndex < filteredOptions.length) {
        selectOption(filteredOptions[activeIndex]);
      } else if (open) {
        closeWithoutSelecting();
      }
    }
  }

  return (
    <div className={cn("relative", className)}>
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-label={ariaLabel}
        value={query}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        className={fieldClass}
      />
      <ChevronDown
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
      />

      {open && !disabled && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute z-40 mt-1 max-h-72 w-full overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface p-1 shadow-card"
        >
          {filteredOptions.length > 0
            ? filteredOptions.map((option, index) => {
                const active = index === activeIndex;
                return (
                  <div
                    key={option.id}
                    id={`${listboxId}-opt-${index}`}
                    role="option"
                    aria-selected={active}
                    ref={(el) => {
                      itemRefs.current[index] = el;
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectOption(option)}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2",
                      active ? "bg-accent-soft" : "hover:bg-surface-2"
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">{option.label}</span>
                      {option.sublabel && (
                        <span className="block truncate text-xs text-ink-faint">
                          {option.sublabel}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })
            : showCreateRow && (
                <div
                  id={createRowId}
                  role="option"
                  aria-selected={activeIndex === 0}
                  ref={(el) => {
                    itemRefs.current[0] = el;
                  }}
                  onMouseEnter={() => setActiveIndex(0)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={triggerCreate}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2",
                    activeIndex === 0 ? "bg-accent-soft" : "hover:bg-surface-2"
                  )}
                >
                  <Plus size={14} className="shrink-0 text-accent" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm text-accent">
                    Create &ldquo;{trimmedQuery}&rdquo;
                  </span>
                  <kbd className="shrink-0 rounded border border-border-strong bg-surface-2 px-1 py-px font-mono text-[10px] leading-4 text-ink-faint">
                    Alt+C
                  </kbd>
                </div>
              )}

          {filteredOptions.length === 0 && !showCreateRow && (
            <p className="px-3 py-6 text-center text-sm text-ink-faint">
              {options.length === 0 && trimmedQuery === "" ? "No options available." : "No matches."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
