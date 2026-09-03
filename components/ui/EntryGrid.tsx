"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Keyboard navigation for a line-items grid — arrow keys between cells,
 * Enter-on-the-last-cell to grow the grid, Ctrl+D to duplicate a row,
 * Ctrl+Delete to remove one. NAVIGATION ONLY: this file never renders a
 * cell, never decides what columns a line has, and never touches what a
 * form posts to create_invoice/create_voucher — it only decides which
 * element gets focus next and when.
 *
 * InvoiceForm's line-items table already had a sliver of this (Enter on the
 * last cell of the last row adds a row — see its desktop <table>'s Rate
 * <input>). This generalizes that one handler into a full grid and offers
 * the same thing to VoucherForm, instead of each form growing its own
 * slightly-different copy. A form keeps its own table markup and its own
 * <input>/<select>/Combobox elements; it only spreads the props this hook
 * hands back onto each one.
 *
 * Usage (unchanged accounting payload, only how the cursor moves):
 *
 *   const { getCellProps } = useGridNav({
 *     rowCount: lines.length,
 *     colCount: 4,               // itemId, quantity, rate, discountPercent
 *     onAddRow: () => setLines((p) => [...p, emptyLine()]),
 *     onDuplicateRow: (i) => setLines((p) => [...p.slice(0, i + 1), { ...p[i] }, ...p.slice(i + 1)]),
 *     onRemoveRow: (i) => setLines((p) => p.filter((_, idx) => idx !== i)),
 *   });
 *   ...
 *   <input {...getCellProps(i, 1)} value={line.quantity} onChange={...} />
 */

export type GridCellProps = {
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  /**
   * Always 0. This is deliberately NOT a roving-tabindex scheme — Tab keeps
   * visiting every cell in DOM order exactly as it does today in
   * InvoiceForm/VoucherForm, so this hook changes nothing about Tab or about
   * where focus goes when the grid is left. It is included so a cell that
   * is not a bare native element — a Combobox (F2) whose focusable root is a
   * styled <div>, say — is guaranteed tabbable by spreading these props,
   * without the form having to remember tabIndex itself for that one case.
   * A native <input>/<select> is already tabbable; this is a harmless no-op
   * on those.
   */
  tabIndex: 0;
  /**
   * A callback ref, not a RefObject: cells are created and destroyed as rows
   * are added/removed, and a callback ref is what lets this hook notice a
   * cell mounting (to register it for later focus()) or unmounting (to drop
   * it) without the form telling it either has happened.
   *
   * If the element this is spread onto is a custom component rather than a
   * native <input>/<select> (a Combobox, F2), that component must forward
   * this ref to its own focusable DOM node — the same requirement any
   * ref-accepting form control has.
   */
  ref: (el: HTMLElement | null) => void;
};

export type UseGridNavOptions = {
  /** Current row count. Read fresh on every keystroke, never cached — a row
   *  added or removed elsewhere in the form is reflected immediately,
   *  without this hook needing to be told separately. */
  rowCount: number;
  /** Columns per row. Assumed uniform across rows, matching every grid this
   *  targets today: InvoiceForm and VoucherForm both lay out a fixed set of
   *  columns per line. */
  colCount: number;
  /**
   * Called with no arguments when Enter is pressed on the last cell of the
   * last row — exactly the moment InvoiceForm's own handler already fires
   * today (`setLines((p) => [...p, emptyLine()])`). This hook only decides
   * WHEN to call it and where focus lands afterwards (the new row's first
   * cell); it never decides what the new row contains — that stays whatever
   * each form's own `emptyLine()` already returns.
   */
  onAddRow: () => void;
  /**
   * Ctrl+D (or Cmd+D on macOS), called with the focused row's index. Omit it
   * and Ctrl+D is left alone — the browser's own "bookmark this page"
   * binding fires, unclaimed rather than silently swallowed for a feature
   * the form doesn't offer.
   */
  onDuplicateRow?: (rowIndex: number) => void;
  /**
   * Ctrl+Delete (or Cmd+Delete), called with the focused row's index — but
   * never when rowCount is already 1. Refusing to go below one row is this
   * hook's own job, not every caller's to re-implement: the callback simply
   * never fires in that case, rather than firing and trusting the form to
   * reject it. Omit the callback and Ctrl+Delete is left alone, same reason
   * as onDuplicateRow above.
   */
  onRemoveRow?: (rowIndex: number) => void;
};

export type UseGridNavResult = {
  /** The {onKeyDown, tabIndex, ref} props for the cell at (row, col) — spread
   *  directly onto that cell's own <input>/<select>/Combobox element. */
  getCellProps: (row: number, col: number) => GridCellProps;
};

/**
 * True when a text cell's caret already sits at the named edge, or when the
 * cell has no caret concept at all (a <select>, or anything that isn't a
 * text <input>/<textarea>). In both of the latter cases there is nothing an
 * arrow key could do INSIDE the cell, so the grid claims the key straight
 * away rather than only at a boundary.
 *
 * Wrapped in try/catch because a handful of <input> types (date, number in
 * some browsers) don't support the selection API at all and throw rather
 * than returning null — treated the same as "no caret concept" rather than
 * letting an arrow-key press ever throw out of this handler.
 */
function isCaretAt(el: HTMLElement, edge: "start" | "end"): boolean {
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return true;
  try {
    const { selectionStart, selectionEnd, value } = el;
    if (selectionStart == null || selectionEnd == null) return true;
    // A live selection means Left/Right is meant to collapse it first, same
    // as a browser's own default behaviour — never treated as "at the edge".
    if (selectionStart !== selectionEnd) return false;
    return edge === "start" ? selectionStart === 0 : selectionStart === value.length;
  } catch {
    return true;
  }
}

export function useGridNav({
  rowCount,
  colCount,
  onAddRow,
  onDuplicateRow,
  onRemoveRow,
}: UseGridNavOptions): UseGridNavResult {
  // Keyed "row-col" -> the live DOM node, so a key press on one cell can
  // call .focus() on another it never rendered itself. A ref, not state:
  // this map is only ever read at the moment a key is pressed, and writing
  // to it must never itself trigger a re-render.
  const cellsRef = useRef(new Map<string, HTMLElement>());

  // Where Enter's "move focus to the new first cell" wants to land, set the
  // instant Enter fires — before the caller's setState has even flushed, so
  // it has to be consumed later rather than acted on immediately: the new
  // row's cell 0 does not exist in the DOM yet at the moment Enter is
  // pressed, only after the resulting re-render commits.
  const pendingFocusRef = useRef<{ row: number; col: number } | null>(null);

  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    cellsRef.current.get(`${pending.row}-${pending.col}`)?.focus();
  }, [rowCount]);

  const focusCell = useCallback((row: number, col: number) => {
    cellsRef.current.get(`${row}-${col}`)?.focus();
  }, []);

  const getCellProps = useCallback(
    (row: number, col: number): GridCellProps => ({
      tabIndex: 0,
      ref: (el) => {
        const key = `${row}-${col}`;
        if (el) cellsRef.current.set(key, el);
        else cellsRef.current.delete(key);
      },
      onKeyDown: (e) => {
        const key = e.key;
        const ctrlOrCmd = e.ctrlKey || e.metaKey;

        if (ctrlOrCmd && key.toLowerCase() === "d") {
          if (!onDuplicateRow) return; // unclaimed — let the browser bookmark the page
          e.preventDefault();
          onDuplicateRow(row);
          return;
        }

        if (ctrlOrCmd && key === "Delete") {
          if (!onRemoveRow) return; // unclaimed — native word-delete-forward stands
          e.preventDefault();
          if (rowCount > 1) onRemoveRow(row);
          return;
        }

        // A Combobox (F2) with its own dropdown open owns arrow keys and
        // Enter while it is open, for choosing among its own suggestions —
        // this grid must not steal them out from under it. Read via
        // aria-expanded, the WAI-ARIA combobox pattern's own signal for
        // "the listbox is open", rather than anything specific to F2's
        // actual implementation. A plain <input>/<select> never sets this
        // attribute, so getAttribute reads null here and every check below
        // behaves exactly as it would without this line.
        if (e.currentTarget.getAttribute("aria-expanded") === "true") return;

        if (key === "Enter") {
          if (row === rowCount - 1 && col === colCount - 1) {
            e.preventDefault();
            pendingFocusRef.current = { row: rowCount, col: 0 };
            onAddRow();
          }
          return;
        }

        // Up/Down always move a row: a single-line cell has no vertical
        // caret position to preserve, so there is nothing for the browser
        // to do with these keys that this grid would be overriding.
        if (key === "ArrowDown") {
          if (row >= rowCount - 1) return; // clamped — does not wrap
          e.preventDefault();
          focusCell(row + 1, col);
          return;
        }
        if (key === "ArrowUp") {
          if (row <= 0) return;
          e.preventDefault();
          focusCell(row - 1, col);
          return;
        }

        // Left/Right first move the text caret, same as a browser's default
        // — the grid only claims the key once the caret is already at that
        // edge (or the cell has no caret concept at all). Hits-the-edge-
        // then-jumps is the same feel Tally's own entry grid has, and is why
        // this is not a blanket hijack the way Up/Down are above.
        if (key === "ArrowLeft") {
          if (!isCaretAt(e.currentTarget, "start")) return;
          if (col <= 0) return; // clamped — does not wrap
          e.preventDefault();
          focusCell(row, col - 1);
          return;
        }
        if (key === "ArrowRight") {
          if (!isCaretAt(e.currentTarget, "end")) return;
          if (col >= colCount - 1) return;
          e.preventDefault();
          focusCell(row, col + 1);
          return;
        }
      },
    }),
    [rowCount, colCount, onAddRow, onDuplicateRow, onRemoveRow, focusCell]
  );

  return { getCellProps };
}
