"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td } from "@/components/ui/Table";
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

type Meeting = {
  id: string;
  meeting_type: string;
  meeting_date: string;
  financial_year_start_year: number | null;
  notice_date: string | null;
  agenda: string;
  minutes_signed_date: string | null;
  minutes_overdue: boolean;
  days_since_meeting: number;
};

type AgmStatus = {
  applicable: boolean;
  financial_year_start_year: number | null;
  fy_label: string | null;
  fy_end_date: string | null;
  is_first_agm: boolean | null;
  deadline_date: string | null;
  agm_recorded: boolean | null;
  days_remaining: number | null;
} | null;

const TYPE_LABEL: Record<string, string> = {
  agm: "AGM",
  egm: "EGM",
  board: "Board meeting",
};

function fyLabel(year: number | null): string {
  if (year === null) return "—";
  return `FY ${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

function minutesBadge(m: Meeting) {
  if (m.minutes_signed_date) return <Badge tone="ok">Minutes signed</Badge>;
  if (m.minutes_overdue) return <Badge tone="bad">Minutes overdue</Badge>;
  return <Badge tone="warn">Minutes pending</Badge>;
}

function AgmBanner({ status }: { status: AgmStatus }) {
  if (!status || !status.applicable) {
    return (
      <div className="rounded-[14px] border border-border bg-surface-2 p-4 text-sm text-ink-soft">
        No AGM obligation applies here — Sec 96(1) exempts a One Person Company, and an LLP has
        no AGM under the LLP Act at all. Board meetings can still be logged below.
      </div>
    );
  }

  if (status.agm_recorded) {
    return (
      <div className="rounded-[14px] border border-border bg-surface p-4 text-sm">
        <span className="font-semibold text-ink">{status.fy_label}</span>
        <span className="ml-2 text-ink-soft">AGM already recorded for this financial year.</span>
      </div>
    );
  }

  const days = status.days_remaining ?? 0;
  const tone = days < 0 ? "bad" : days <= 30 ? "warn" : "ok";
  const dayText =
    days < 0 ? `${-days} day${-days === 1 ? "" : "s"} past the Sec 96 deadline` : `${days} day${days === 1 ? "" : "s"} left`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-border bg-surface p-4">
      <div className="text-sm">
        <span className="font-semibold text-ink">{status.fy_label}</span>
        <span className="ml-2 text-ink-soft">
          AGM not yet recorded. {status.is_first_agm ? "First AGM (9-month window)" : "Sec 96 deadline (6 months)"}{" "}
          is <span className="font-medium text-ink">{status.deadline_date}</span>.
        </span>
      </div>
      <Badge tone={tone}>{dayText}</Badge>
    </div>
  );
}

export function MeetingManager({
  companyId,
  meetings,
  agmStatus,
  filter,
  docs,
}: {
  companyId: string;
  meetings: Meeting[];
  agmStatus: AgmStatus;
  filter: string;
  docs: Doc[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filesOpenFor, setFilesOpenFor] = useState<string | null>(null);

  const [meetingType, setMeetingType] = useState("board");
  const [meetingDate, setMeetingDate] = useState("");
  const [fyStartYear, setFyStartYear] = useState("");
  const [noticeDate, setNoticeDate] = useState("");
  const [agenda, setAgenda] = useState("");
  const [minutesSignedDate, setMinutesSignedDate] = useState("");

  async function addMeeting(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await createClient()
      .from("meetings")
      .insert({
        company_id: companyId,
        meeting_type: meetingType,
        meeting_date: meetingDate,
        financial_year_start_year: meetingType === "agm" ? Number(fyStartYear) : null,
        notice_date: noticeDate || null,
        agenda: agenda.trim(),
        minutes_signed_date: minutesSignedDate || null,
      });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Meeting logged");
    setMeetingDate("");
    setFyStartYear("");
    setNoticeDate("");
    setAgenda("");
    setMinutesSignedDate("");
    setShowForm(false);
    router.refresh();
  }

  async function signMinutes(id: string, date: string) {
    setBusy(true);
    const { error } = await createClient()
      .from("meetings")
      .update({ minutes_signed_date: date })
      .eq("id", id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Minutes marked signed");
    router.refresh();
  }

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  return (
    <div className="flex flex-col gap-6">
      <AgmBanner status={agmStatus} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          {["all", "agm", "egm", "board"].map((f) => (
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
              {f === "all" ? "All" : TYPE_LABEL[f]}
            </a>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowForm((s) => !s)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : "Log a meeting"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={addMeeting} className="grid gap-4 rounded-[14px] border border-border bg-surface p-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Type</span>
            <select value={meetingType} onChange={(e) => setMeetingType(e.target.value)} className={field}>
              <option value="board">Board meeting</option>
              <option value="agm">AGM</option>
              <option value="egm">EGM</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Date held</span>
            <input required type="date" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} className={field} />
          </label>
          {meetingType === "agm" && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Financial year <span className="font-normal text-ink-faint">— start year, e.g. 2025 for FY 2025-26</span>
              </span>
              <input
                required
                type="number"
                min={2000}
                max={2100}
                value={fyStartYear}
                onChange={(e) => setFyStartYear(e.target.value)}
                className={field}
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Notice issued on (optional)</span>
            <input type="date" value={noticeDate} onChange={(e) => setNoticeDate(e.target.value)} className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Minutes signed on <span className="font-normal text-ink-faint">— leave blank if not yet signed</span>
            </span>
            <input
              type="date"
              value={minutesSignedDate}
              onChange={(e) => setMinutesSignedDate(e.target.value)}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">Agenda / what it was about</span>
            <textarea required value={agenda} onChange={(e) => setAgenda(e.target.value)} rows={2} className={field} />
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
              <th className={th}>Minutes</th>
              <th className={th}>Type</th>
              <th className={th}>Date held</th>
              <th className={th}>FY</th>
              <th className={th}>Notice issued</th>
              <th className={th}>Agenda</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {meetings.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
                  {filter === "all" ? "No meetings logged yet." : `No ${TYPE_LABEL[filter]?.toLowerCase()} logged yet.`}
                </td>
              </tr>
            )}
            {meetings.map((m) => (
              <Fragment key={m.id}>
                <tr className="border-b border-border last:border-0">
                  <td className={td}>{minutesBadge(m)}</td>
                  <td className={td}>{TYPE_LABEL[m.meeting_type] ?? m.meeting_type}</td>
                  <td className={td + " whitespace-nowrap"}>{m.meeting_date}</td>
                  <td className={td + " whitespace-nowrap"}>{fyLabel(m.financial_year_start_year)}</td>
                  <td className={td + " whitespace-nowrap"}>{m.notice_date ?? "—"}</td>
                  <td className={td + " max-w-xs text-ink-soft"}>{m.agenda}</td>
                  <td className={td}>
                    <div className="flex flex-col items-start gap-1">
                      {!m.minutes_signed_date && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => signMinutes(m.id, new Date().toISOString().slice(0, 10))}
                          className="text-xs text-accent underline underline-offset-2 disabled:opacity-50"
                        >
                          Mark minutes signed today
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setFilesOpenFor(filesOpenFor === m.id ? null : m.id)}
                        className="text-xs text-ink-soft underline underline-offset-2"
                      >
                        Files ({docs.filter((d) => d.entity_id === m.id).length})
                      </button>
                    </div>
                  </td>
                </tr>
                {filesOpenFor === m.id && (
                  <tr className="border-b border-border bg-bg">
                    <td colSpan={7} className="px-4 py-3">
                      <DocumentAttachments
                        companyId={companyId}
                        entityType="meeting"
                        entityId={m.id}
                        docs={docs.filter((d) => d.entity_id === m.id)}
                      />
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
