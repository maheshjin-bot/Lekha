"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td, num } from "@/components/ui/Table";
import { DocumentAttachments } from "@/components/documents/DocumentAttachments";

type Doc = {
  id: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  entity_id: string | null;
};

export type Notice = {
  id: string;
  authority: string;
  notice_type: string;
  notice_number: string | null;
  notice_date: string;
  received_date: string;
  due_date: string | null;
  description: string;
  amount_involved: number | null;
  status: string;
  response_date: string | null;
  response_note: string | null;
  is_overdue: boolean;
  days_remaining: number | null;
  // 0105's two disclosure columns. get_notices predates them and does not
  // return them, so the page reads them off the table and merges them in —
  // see app/(app)/[companyId]/notices/page.tsx for why that RPC's return type
  // is left alone.
  is_disclosed_as_contingent: boolean;
  contingent_amount: number | null;
};

const AUTHORITY_LABEL: Record<string, string> = {
  gst: "GST",
  income_tax: "Income Tax",
  tds: "TDS",
  tcs: "TCS",
  roc: "ROC",
  pf_esi: "PF/ESI",
  other: "Other",
};

function urgencyBadge(n: Notice) {
  if (n.status === "closed") return <Badge tone="neutral">Closed</Badge>;
  if (n.status === "responded") return <Badge tone="accent">Responded</Badge>;
  if (n.is_overdue) return <Badge tone="bad">Overdue</Badge>;
  if (n.days_remaining !== null && n.days_remaining <= 7) return <Badge tone="warn">Due soon</Badge>;
  return <Badge tone="ok">Open</Badge>;
}

export function NoticeManager({
  companyId,
  notices,
  filter,
  docs,
}: {
  companyId: string;
  notices: Notice[];
  filter: string;
  docs: Doc[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  // Which row's attachment panel is open — independent of the respond panel,
  // since a user may want to see what's attached without starting a response.
  const [filesOpenFor, setFilesOpenFor] = useState<string | null>(null);

  const [authority, setAuthority] = useState("gst");
  const [noticeType, setNoticeType] = useState("");
  const [noticeNumber, setNoticeNumber] = useState("");
  const [noticeDate, setNoticeDate] = useState("");
  const [receivedDate, setReceivedDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  // notices.is_disclosed_as_contingent defaults to true in the database
  // (0105): a freshly received demand is presumptively an unprovided
  // contingent liability. Mirrored here rather than left implicit, because
  // plenty of notices are not demands at all — a 143(1) intimation
  // confirming a return was processed with no demand raised must not be
  // disclosed as a contingent liability for a single day.
  const [discloseOnCreate, setDiscloseOnCreate] = useState(true);

  // Which row's respond panel is open — one at a time, keyed by id.
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [responseNote, setResponseNote] = useState("");
  const [responseDate, setResponseDate] = useState("");

  // Which row's close panel is open. Closing is no longer a one-click
  // status write: what closing MEANS for the contingent-liabilities note
  // (paid, dropped, or still contingent) is a fact only the preparer has.
  const [closingOn, setClosingOn] = useState<string | null>(null);
  const [stopDisclosingOnClose, setStopDisclosingOnClose] = useState(true);

  // Which row's disclosure panel is open, plus its two draft values.
  const [disclosingOn, setDisclosingOn] = useState<string | null>(null);
  const [discloseChecked, setDiscloseChecked] = useState(true);
  const [discloseAmount, setDiscloseAmount] = useState("");

  async function addNotice(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await createClient()
      .from("notices")
      .insert({
        company_id: companyId,
        authority,
        notice_type: noticeType.trim(),
        notice_number: noticeNumber.trim() || null,
        notice_date: noticeDate,
        received_date: receivedDate,
        due_date: dueDate || null,
        description: description.trim(),
        amount_involved: amount ? Number(amount) : null,
        is_disclosed_as_contingent: discloseOnCreate,
      });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Notice logged");
    setNoticeType("");
    setNoticeNumber("");
    setDescription("");
    setAmount("");
    setDiscloseOnCreate(true);
    setShowForm(false);
    router.refresh();
  }

  async function markResponded(id: string) {
    setBusy(true);
    const { error } = await createClient()
      .from("notices")
      .update({
        status: "responded",
        response_date: responseDate || new Date().toISOString().slice(0, 10),
        response_note: responseNote.trim() || null,
      })
      .eq("id", id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Marked as responded");
    setActingOn(null);
    setResponseNote("");
    router.refresh();
  }

  /**
   * Closing a notice and disclosing it as a contingent liability are two
   * different facts, and 0105 says so outright: status='closed' cannot tell
   * a demand that was PAID (now a recognised liability in the books —
   * disclosing it again double-counts it) from one that was DROPPED (no
   * liability at all). Both are excluded from the note, which is why the
   * checkbox is pre-ticked, and why 0105's own backfill set every
   * already-closed notice to false. What it cannot presume is the third case:
   * a matter closed in this app while an appeal continues elsewhere, still
   * genuinely contingent. So the preparer confirms it here at the moment they
   * have the assessment order in hand — never a silent rewrite, and never
   * left to be remembered later on a screen that filters closed notices out
   * by default.
   *
   * The flag is only ever written DOWN to false from here. Leaving the box
   * unticked sends no disclosure change at all, so a notice already excluded
   * is not quietly re-disclosed by the act of closing it.
   */
  async function markClosed(n: Notice) {
    const stopDisclosing = stopDisclosingOnClose && n.is_disclosed_as_contingent;
    setBusy(true);
    const { error } = await createClient()
      .from("notices")
      .update(
        stopDisclosing
          ? { status: "closed", is_disclosed_as_contingent: false }
          : { status: "closed" }
      )
      .eq("id", n.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(
      stopDisclosing ? "Closed and removed from the contingent-liabilities note" : "Closed"
    );
    setClosingOn(null);
    setStopDisclosingOnClose(true);
    router.refresh();
  }

  /** The two 0105 columns, written for the first time. contingent_amount is
   * nulled rather than defaulted to amount_involved: null is what makes
   * get_contingent_liabilities_note fall back to amount_involved, and a
   * fabricated copy of that figure would go stale the moment the notice's own
   * amount is revised. */
  async function saveDisclosure(id: string) {
    const trimmed = discloseAmount.trim();
    if (trimmed && !(Number(trimmed) >= 0)) {
      toast.error("The amount to disclose cannot be negative.");
      return;
    }
    setBusy(true);
    const { error } = await createClient()
      .from("notices")
      .update({
        is_disclosed_as_contingent: discloseChecked,
        contingent_amount: trimmed ? Number(trimmed) : null,
      })
      .eq("id", id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(
      discloseChecked
        ? "Disclosed as a contingent liability"
        : "Removed from the contingent-liabilities note"
    );
    setDisclosingOn(null);
    router.refresh();
  }

  function openDisclosure(n: Notice) {
    if (disclosingOn === n.id) {
      setDisclosingOn(null);
      return;
    }
    setDiscloseChecked(n.is_disclosed_as_contingent);
    setDiscloseAmount(n.contingent_amount != null ? String(n.contingent_amount) : "");
    setClosingOn(null);
    setActingOn(null);
    setDisclosingOn(n.id);
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {/* "In the note" exists because the default filter hides exactly
              the rows most likely to be disclosed wrongly: a closed notice
              still ticked as contingent is invisible under "Open only". */}
          {["open", "all", "disclosed"].map((f) => (
            <a
              key={f}
              href={`?filter=${f}`}
              className={
                "rounded-md border px-2.5 py-1 " +
                (filter === f
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border-strong hover:bg-surface-2")
              }
            >
              {f === "open" ? "Open only" : f === "all" ? "All" : "In the contingent note"}
            </a>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : "Log a notice"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={addNotice} className="grid gap-4 rounded-[14px] border border-border bg-surface p-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Authority</span>
            <select value={authority} onChange={(e) => setAuthority(e.target.value)} className={field}>
              {Object.entries(AUTHORITY_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Notice type / form</span>
            <input
              required
              value={noticeType}
              onChange={(e) => setNoticeType(e.target.value)}
              placeholder="ASMT-10, 143(2), DRC-01…"
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Reference number</span>
            <input value={noticeNumber} onChange={(e) => setNoticeNumber(e.target.value)} className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Amount involved (if any)</span>
            <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Date on the notice</span>
            <input required type="date" value={noticeDate} onChange={(e) => setNoticeDate(e.target.value)} className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Date you received it</span>
            <input required type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Response due by <span className="font-normal text-ink-faint">— as printed on the notice</span>
            </span>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={field} />
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">What it&rsquo;s about</span>
            <textarea
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className={field}
            />
          </label>
          <label className="flex items-start gap-2.5 rounded-lg border border-border bg-bg p-3 sm:col-span-2">
            <input
              type="checkbox"
              checked={discloseOnCreate}
              onChange={(e) => setDiscloseOnCreate(e.target.checked)}
              className="mt-0.5 size-4 accent-[var(--accent)]"
            />
            <span className="text-sm">
              <span className="font-medium">Disclose as a contingent liability</span>
              <span className="mt-0.5 block text-xs text-ink-faint">
                Ticked, this demand appears in the notes to accounts under &ldquo;claims against the
                company not acknowledged as debt&rdquo; (Schedule III Note (i) / AS 29) at the amount
                involved. Untick it now for a notice that raises no demand at all — an intimation
                confirming a return was processed, a routine information request.
              </span>
            </span>
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </form>
      )}

      <TableContainer>
        <table className="w-full min-w-[1040px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Status</th>
              <th className={th}>Authority</th>
              <th className={th}>Type</th>
              <th className={th}>Received</th>
              <th className={th}>Due</th>
              <th className={th + " text-right"}>Amount</th>
              <th className={th}>In the note</th>
              <th className={th}>What it&rsquo;s about</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {notices.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-ink-faint">
                  {filter === "open"
                    ? "Nothing open."
                    : filter === "disclosed"
                      ? "No notice is currently disclosed as a contingent liability."
                      : "No notices logged yet."}
                </td>
              </tr>
            )}
            {notices.map((n) => (
              <Fragment key={n.id}>
                <tr className="border-b border-border last:border-0">
                  <td className={td}>{urgencyBadge(n)}</td>
                  <td className={td}>{AUTHORITY_LABEL[n.authority] ?? n.authority}</td>
                  <td className={td}>
                    {n.notice_type}
                    {n.notice_number && (
                      <span className="ml-1 font-mono text-xs text-ink-faint">#{n.notice_number}</span>
                    )}
                  </td>
                  <td className={td + " whitespace-nowrap"}>{n.received_date}</td>
                  <td className={td + " whitespace-nowrap"}>
                    {n.due_date ?? "—"}
                    {n.status === "open" && n.days_remaining !== null && (
                      <span className={"ml-1.5 text-xs " + (n.is_overdue ? "text-error" : "text-ink-faint")}>
                        ({n.days_remaining >= 0 ? `${n.days_remaining}d left` : `${-n.days_remaining}d overdue`})
                      </span>
                    )}
                  </td>
                  <td className={num}>{n.amount_involved ? formatINR(Number(n.amount_involved)) : "—"}</td>
                  <td className={td}>
                    {n.is_disclosed_as_contingent ? (
                      <div className="flex flex-col items-start gap-0.5">
                        <Badge tone="warn">Disclosed</Badge>
                        <span className="font-mono text-xs text-ink-faint">
                          {n.contingent_amount != null
                            ? `${formatINR(Number(n.contingent_amount))} of ${
                                n.amount_involved != null ? formatINR(Number(n.amount_involved)) : "—"
                              }`
                            : n.amount_involved != null
                              ? formatINR(Number(n.amount_involved))
                              : "not quantified"}
                        </span>
                      </div>
                    ) : (
                      <Badge tone="neutral">Not disclosed</Badge>
                    )}
                  </td>
                  <td className={td + " max-w-xs text-ink-soft"}>{n.description}</td>
                  <td className={td}>
                    <div className="flex flex-col items-start gap-1">
                      {n.status === "open" && (
                        <button
                          type="button"
                          onClick={() => {
                            setDisclosingOn(null);
                            setActingOn(actingOn === n.id ? null : n.id);
                          }}
                          className="text-xs text-accent underline underline-offset-2"
                        >
                          Respond
                        </button>
                      )}
                      {n.status === "responded" && (
                        <button
                          type="button"
                          onClick={() => {
                            setDisclosingOn(null);
                            setStopDisclosingOnClose(true);
                            setClosingOn(closingOn === n.id ? null : n.id);
                          }}
                          className="text-xs text-accent underline underline-offset-2"
                        >
                          Close
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openDisclosure(n)}
                        className="text-xs text-accent underline underline-offset-2"
                      >
                        Disclosure
                      </button>
                      <button
                        type="button"
                        onClick={() => setFilesOpenFor(filesOpenFor === n.id ? null : n.id)}
                        className="text-xs text-ink-soft underline underline-offset-2"
                      >
                        Files ({docs.filter((d) => d.entity_id === n.id).length})
                      </button>
                    </div>
                  </td>
                </tr>
                {filesOpenFor === n.id && (
                  <tr className="border-b border-border bg-bg">
                    <td colSpan={9} className="px-4 py-3">
                      <DocumentAttachments
                        companyId={companyId}
                        entityType="notice"
                        entityId={n.id}
                        docs={docs.filter((d) => d.entity_id === n.id)}
                      />
                    </td>
                  </tr>
                )}
                {actingOn === n.id && (
                  <tr className="border-b border-border bg-bg">
                    <td colSpan={9} className="px-4 py-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium">Responded on</span>
                          <input
                            type="date"
                            value={responseDate}
                            onChange={(e) => setResponseDate(e.target.value)}
                            className={field}
                          />
                        </label>
                        <label className="flex flex-1 flex-col gap-1">
                          <span className="text-xs font-medium">Note (optional)</span>
                          <input
                            value={responseNote}
                            onChange={(e) => setResponseNote(e.target.value)}
                            placeholder="What was filed / who handled it"
                            className={field}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => markResponded(n.id)}
                          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                        >
                          Mark responded
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
                {closingOn === n.id && (
                  <tr className="border-b border-border bg-bg">
                    <td colSpan={9} className="px-4 py-3">
                      <p className="mb-2 max-w-3xl text-xs text-ink-soft">
                        Closing records that the matter is finished with the department. What that
                        means for the accounts is a separate question, and only you can answer it.
                      </p>
                      {n.is_disclosed_as_contingent ? (
                        <label className="mb-3 flex max-w-3xl items-start gap-2.5 rounded-lg border border-border bg-surface p-3">
                          <input
                            type="checkbox"
                            checked={stopDisclosingOnClose}
                            onChange={(e) => setStopDisclosingOnClose(e.target.checked)}
                            className="mt-0.5 size-4 accent-[var(--accent)]"
                          />
                          <span className="text-sm">
                            <span className="font-medium">
                              Stop disclosing this as a contingent liability
                            </span>
                            <span className="mt-0.5 block text-xs text-ink-faint">
                              Leave it ticked if the demand was <em>paid</em> — it is a recognised
                              liability in the books now, and disclosing it again would count it
                              twice — or if it was <em>dropped</em> or decided in the company&rsquo;s
                              favour, in which case there is no liability at all. Untick it only if
                              the matter is genuinely still contingent, e.g. an appeal continues
                              elsewhere.
                            </span>
                          </span>
                        </label>
                      ) : (
                        <p className="mb-3 max-w-3xl text-xs text-ink-faint">
                          This notice is already excluded from the contingent-liabilities note —
                          closing it changes nothing there.
                        </p>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => markClosed(n)}
                        className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                      >
                        Close notice
                      </button>
                    </td>
                  </tr>
                )}
                {disclosingOn === n.id && (
                  <tr className="border-b border-border bg-bg">
                    <td colSpan={9} className="px-4 py-3">
                      <label className="mb-3 flex max-w-3xl items-start gap-2.5 rounded-lg border border-border bg-surface p-3">
                        <input
                          type="checkbox"
                          checked={discloseChecked}
                          onChange={(e) => setDiscloseChecked(e.target.checked)}
                          className="mt-0.5 size-4 accent-[var(--accent)]"
                        />
                        <span className="text-sm">
                          <span className="font-medium">
                            Disclose in the contingent-liabilities note
                          </span>
                          <span className="mt-0.5 block text-xs text-ink-faint">
                            Schedule III Note (i) / AS 29 — while this is ticked the note lists the
                            demand as a claim against the company not acknowledged as debt, in the{" "}
                            <a
                              href={`/${companyId}/reports/notes-to-accounts`}
                              className="text-accent underline underline-offset-2"
                            >
                              notes to accounts
                            </a>
                            . Untick it once the demand has been paid, dropped or decided in the
                            company&rsquo;s favour: nothing else in this app infers that, and a
                            liability the company no longer has is a <em>wrong</em> disclosure in a
                            signed financial statement, not merely an untidy one.
                          </span>
                        </span>
                      </label>
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium">Amount to disclose</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={discloseAmount}
                            onChange={(e) => setDiscloseAmount(e.target.value)}
                            placeholder={
                              n.amount_involved != null
                                ? String(n.amount_involved)
                                : "not quantified"
                            }
                            disabled={!discloseChecked}
                            className={field + " disabled:opacity-50"}
                          />
                        </label>
                        <p className="max-w-md flex-1 text-xs text-ink-faint">
                          {n.amount_involved != null
                            ? `Leave blank to disclose the whole amount involved (${formatINR(Number(n.amount_involved))}). Enter only the still-disputed portion when part of the demand has been paid or accepted, or the revised figure when an order changes it.`
                            : "This notice carries no amount involved — a scrutiny notice does not quantify a demand — so the note shows it as “not yet quantified” unless you put a figure here."}
                        </p>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => saveDisclosure(n.id)}
                          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                        >
                          Save disclosure
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </TableContainer>
    </div>
  );
}
