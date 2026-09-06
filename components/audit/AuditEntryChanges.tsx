import {
  displayLines,
  fieldChanges,
  isLineSet,
  snapshotFields,
  type AuditEvent,
} from "@/lib/audit/snapshot";

/**
 * The "What changed" cell of the audit trail: the actual values, before and
 * after.
 *
 * The trigger has captured full snapshots since 0008 and the reader threw
 * them away until 1580, so "what did this used to be?" — the whole point of
 * an edit log — could not be answered through the app while the answer sat in
 * the table. Three shapes, because an audit_log row has three shapes:
 *
 *   a set of a document's stock lines  -> the lines, as a table
 *   an UPDATE of one row               -> each changed field, before → after
 *   an INSERT or DELETE of one row     -> the record's own fields
 *
 * Every entry also carries its complete snapshot in a collapsed <details>.
 * That is deliberately plain JSON: it is the record, and a reviewer checking
 * a figure should see it exactly as stored rather than as something a
 * component decided to summarise. No client JavaScript is involved — this is
 * a server component and <details> is a browser element.
 */

/** Fields listed in the cell before the rest are left to the full record. */
const INLINE_FIELD_LIMIT = 6;

export function AuditEntryChanges({ event }: { event: AuditEvent }) {
  const beforeIsSet = isLineSet(event.before_data);
  const afterIsSet = isLineSet(event.after_data);

  if (beforeIsSet || afterIsSet) {
    return (
      <div className="space-y-2">
        {beforeIsSet && (
          <LineTable
            caption={afterIsSet ? "Before" : "Removed"}
            lines={displayLines(event.before_data)}
          />
        )}
        {afterIsSet && (
          <LineTable
            caption={beforeIsSet ? "After" : "Written"}
            lines={displayLines(event.after_data)}
          />
        )}
        <FullRecord event={event} />
      </div>
    );
  }

  if (event.operation === "UPDATE") {
    const changes = fieldChanges(event);
    return (
      <div className="space-y-1.5">
        {changes.length === 0 ? (
          <span className="text-ink-faint">No field changed</span>
        ) : (
          <dl className="space-y-1">
            {changes.map((c) => (
              <div key={c.field} className="flex flex-wrap items-baseline gap-x-1.5">
                <dt className="text-xs text-ink-faint">{c.label}</dt>
                <dd className="flex flex-wrap items-baseline gap-x-1.5 font-mono text-xs">
                  <span className="text-ink-soft line-through decoration-ink-faint">{c.before}</span>
                  <span aria-hidden className="text-ink-faint">&rarr;</span>
                  <span className="text-ink">{c.after}</span>
                  <span className="sr-only">changed to</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
        <FullRecord event={event} />
      </div>
    );
  }

  const snapshot = event.operation === "DELETE" ? event.before_data : event.after_data;
  const fields = snapshotFields(snapshot);
  return (
    <div className="space-y-1.5">
      {fields.length === 0 ? (
        <span className="text-ink-faint">Nothing recorded</span>
      ) : (
        <dl className="space-y-1">
          {fields.slice(0, INLINE_FIELD_LIMIT).map((f) => (
            <div key={f.field} className="flex flex-wrap items-baseline gap-x-1.5">
              <dt className="text-xs text-ink-faint">{f.label}</dt>
              <dd className="font-mono text-xs text-ink">{f.after}</dd>
            </div>
          ))}
        </dl>
      )}
      {fields.length > INLINE_FIELD_LIMIT && (
        <p className="text-xs text-ink-faint">
          and {fields.length - INLINE_FIELD_LIMIT} more field
          {fields.length - INLINE_FIELD_LIMIT === 1 ? "" : "s"} in the full record
        </p>
      )}
      <FullRecord event={event} />
    </div>
  );
}

function LineTable({
  caption,
  lines,
}: {
  caption: string;
  lines: ReturnType<typeof displayLines>;
}) {
  if (lines.length === 0) {
    return (
      <p className="text-xs text-ink-faint">
        {caption}: no lines
      </p>
    );
  }
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{caption}</p>
      <table className="mt-1 w-full text-xs">
        <thead>
          <tr className="text-left text-ink-faint">
            <th className="pr-2 font-normal">#</th>
            <th className="pr-2 font-normal">Item</th>
            <th className="pr-2 text-right font-normal">Qty</th>
            <th className="pr-2 text-right font-normal">Rate</th>
            <th className="pr-2 text-right font-normal">Disc %</th>
            <th className="pr-2 text-right font-normal">Amount</th>
            <th className="font-normal">HSN/SAC</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={`${caption}-${line.order}-${i}`} className="align-baseline">
              <td className="pr-2 font-mono text-ink-faint">{line.order}</td>
              <td className="pr-2 text-ink">{line.item}</td>
              <td className="pr-2 text-right font-mono tabular-nums text-ink">{line.quantity}</td>
              <td className="pr-2 text-right font-mono tabular-nums text-ink">{line.rate}</td>
              <td className="pr-2 text-right font-mono tabular-nums text-ink">{line.discount}</td>
              <td className="pr-2 text-right font-mono tabular-nums text-ink">{line.amount}</td>
              <td className="font-mono text-ink-soft">{line.hsn}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FullRecord({ event }: { event: AuditEvent }) {
  if (event.before_data === null && event.after_data === null) return null;
  return (
    <details className="print:hidden">
      <summary className="cursor-pointer text-xs text-ink-faint hover:text-ink-soft">
        Full record as stored
      </summary>
      <div className="mt-1 space-y-2">
        {event.before_data !== null && (
          <SnapshotJson label="Before" value={event.before_data} />
        )}
        {event.after_data !== null && <SnapshotJson label="After" value={event.after_data} />}
      </div>
    </details>
  );
}

function SnapshotJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{label}</p>
      <pre className="mt-0.5 max-h-64 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11px] leading-relaxed text-ink-soft">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
