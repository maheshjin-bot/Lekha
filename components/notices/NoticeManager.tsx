"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td, num } from "@/components/ui/Table";

type Notice = {
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
}: {
  companyId: string;
  notices: Notice[];
  filter: string;
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const [authority, setAuthority] = useState("gst");
  const [noticeType, setNoticeType] = useState("");
  const [noticeNumber, setNoticeNumber] = useState("");
  const [noticeDate, setNoticeDate] = useState("");
  const [receivedDate, setReceivedDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");

  // Which row's respond/close panel is open — one at a time, keyed by id.
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [responseNote, setResponseNote] = useState("");
  const [responseDate, setResponseDate] = useState("");

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

  async function markClosed(id: string) {
    setBusy(true);
    const { error } = await createClient().from("notices").update({ status: "closed" }).eq("id", id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Closed");
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          {["open", "all"].map((f) => (
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
              {f === "open" ? "Open only" : "All"}
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
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>Status</th>
              <th className={th}>Authority</th>
              <th className={th}>Type</th>
              <th className={th}>Received</th>
              <th className={th}>Due</th>
              <th className={th + " text-right"}>Amount</th>
              <th className={th}>What it&rsquo;s about</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {notices.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-ink-faint">
                  {filter === "open" ? "Nothing open." : "No notices logged yet."}
                </td>
              </tr>
            )}
            {notices.map((n) => (
              <>
                <tr key={n.id} className="border-b border-border last:border-0">
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
                  <td className={td + " max-w-xs text-ink-soft"}>{n.description}</td>
                  <td className={td}>
                    {n.status === "open" && (
                      <button
                        type="button"
                        onClick={() => setActingOn(actingOn === n.id ? null : n.id)}
                        className="text-xs text-accent underline underline-offset-2"
                      >
                        Respond
                      </button>
                    )}
                    {n.status === "responded" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => markClosed(n.id)}
                        className="text-xs text-accent underline underline-offset-2 disabled:opacity-50"
                      >
                        Close
                      </button>
                    )}
                  </td>
                </tr>
                {actingOn === n.id && (
                  <tr className="border-b border-border bg-bg">
                    <td colSpan={8} className="px-4 py-3">
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
              </>
            ))}
          </tbody>
        </table>
      </TableContainer>
    </div>
  );
}
