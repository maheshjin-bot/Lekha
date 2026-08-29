"use client";

import {
  RULE46B_MAX_LENGTH,
  validateManualNumber,
  type NumberingSeriesOption,
  type TypeNumbering,
} from "@/lib/numbering/voucher-numbering";

/**
 * The one header field the numbering policy adds to an entry form.
 *
 * Shared by InvoiceForm and VoucherForm so the two cannot drift: the same
 * character counter, the same Rule 46(b) sentence, the same series copy on
 * both screens. Which of the three shapes it takes is decided entirely by the
 * mode the server fetched:
 *
 *   automatic  renders NOTHING — returns null before any markup. Automatic is
 *              what every company has until someone deliberately changes it,
 *              and 0725's whole promise is that such a company sees no
 *              difference at all. A greyed-out "the app will number this"
 *              caption would be a difference.
 *   manual     a required text input with a live character count against
 *              Rule 46(b)'s sixteen.
 *   series     a picker over that voucher type's ACTIVE series, showing the
 *              exact next number of whichever is selected.
 *
 * Never rendered while editing: the number is fixed once issued. Both callers
 * gate on that, and update_voucher / update_invoice have no number argument to
 * pass one to even if they did not.
 */

const fieldClass =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

export function VoucherNumberField({
  policy,
  manualNumber,
  onManualNumberChange,
  seriesId,
  onSeriesIdChange,
}: {
  policy: TypeNumbering | undefined;
  manualNumber: string;
  onManualNumberChange: (value: string) => void;
  /** The resolved selection — never raw state, so it is always a real option. */
  seriesId: string | null;
  onSeriesIdChange: (value: string | null) => void;
}) {
  if (!policy || policy.mode === "automatic") return null;

  if (policy.mode === "manual") {
    const trimmed = manualNumber.trim();
    // Only complain about something actually typed. An untouched field is
    // caught on submit instead, which is where "required" belongs.
    const problem = trimmed ? validateManualNumber(manualNumber) : null;
    const over = trimmed.length > RULE46B_MAX_LENGTH;

    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">Voucher number</span>
          <span
            className={
              "text-xs tabular-nums font-mono " + (over ? "text-error" : "text-ink-faint")
            }
          >
            {trimmed.length}/{RULE46B_MAX_LENGTH}
          </span>
        </div>
        <input
          required
          value={manualNumber}
          onChange={(e) => onManualNumberChange(e.target.value)}
          // Deliberately NOT maxLength={16}: silently swallowing the
          // seventeenth keystroke teaches nothing. Typing it is allowed, the
          // count turns red, the reason is stated, and the save is refused
          // here rather than at the database.
          placeholder="e.g. SAL/26-27/0021"
          aria-invalid={problem ? true : undefined}
          spellCheck={false}
          autoComplete="off"
          className={
            fieldClass +
            " font-mono" +
            (problem ? " border-error focus-visible:border-error" : "")
          }
        />
        <span className={"text-xs " + (problem ? "text-error" : "text-ink-faint")}>
          {problem ??
            `Letters, digits, hyphen and slash only, up to ${RULE46B_MAX_LENGTH} characters — CGST Rule 46(b). Numbers must run consecutively; the app checks each one is unused but cannot check the order for you.`}
        </span>
      </div>
    );
  }

  const selected =
    policy.series.find((s) => s.id === seriesId) ?? policy.series[0] ?? null;

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">Numbering series</span>
      <select
        aria-label="Numbering series"
        value={seriesId ?? ""}
        onChange={(e) => onSeriesIdChange(e.target.value || null)}
        className={fieldClass}
      >
        {policy.series.map((s) => (
          <option key={s.id ?? "unprovisioned"} value={s.id ?? ""}>
            {seriesLabel(s)}
          </option>
        ))}
      </select>
      {selected && (
        <span
          className={"text-xs " + (selected.rule46bOk ? "text-ink-faint" : "text-warning")}
        >
          Next: <span className="font-mono">{selected.previewNumber}</span> for{" "}
          {policy.branchCode} in {policy.financialYearLabel}
          {/* Stated without claiming the cap binds THIS document. Rule 46(b)
              governs GST documents — an invoice, a credit or debit note, a
              challan — and says nothing about an internal journal or contra.
              Which types are GST-facing is a judgement the settings screen
              already makes and explains at length; repeating that call here,
              in a one-line caption, would only risk the two disagreeing. */}
          {selected.rule46bOk
            ? "."
            : ` — ${selected.previewLength} characters. CGST Rule 46(b) caps a GST document number at 16.`}{" "}
          Each series keeps its own counter. Changing the branch or moving the
          date into another financial year draws from that year&rsquo;s counter
          instead.
        </span>
      )}
    </label>
  );
}

function seriesLabel(s: NumberingSeriesOption): string {
  const suffix = s.isDefault ? " (default)" : "";
  // A never-used voucher type has no series row yet — the database provisions
  // it on the first post. Saying so beats showing a number with no history.
  return s.id === null ? `${s.name}${suffix} — created on the first voucher` : `${s.name}${suffix}`;
}
