"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Note = {
  id: string;
  title: string;
  area: string;
  description: string;
  citation_text: string | null;
  citation_url: string | null;
  effective_date: string;
  status: string;
  applied_note: string | null;
};

const AREA_LABEL: Record<string, string> = {
  gst: "GST",
  tds: "TDS",
  tcs: "TCS",
  income_tax: "Income tax",
  pf_esi_pt: "PF/ESI/PT",
  companies_act: "Companies Act",
  other: "Other",
};

const STATUS_TONE: Record<string, string> = {
  proposed: "bg-surface-2 text-ink-soft",
  confirmed: "bg-blue-50 text-blue-900",
  applied: "bg-success-soft text-success",
  rejected: "bg-error-soft text-error",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={
        "rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide " +
        (STATUS_TONE[status] ?? "bg-surface-2 text-ink-soft")
      }
    >
      {status}
    </span>
  );
}

function NoteRow({ note }: { note: Note }) {
  const router = useRouter();
  const [status, setStatus] = useState(note.status);
  const [appliedNote, setAppliedNote] = useState(note.applied_note ?? "");
  const [busy, setBusy] = useState(false);

  async function onStatusChange(newStatus: string) {
    setBusy(true);
    const { error } = await createClient()
      .from("statutory_update_notes")
      .update({
        status: newStatus,
        applied_note: newStatus === "applied" ? appliedNote.trim() || null : note.applied_note,
      })
      .eq("id", note.id);
    if (!error) {
      setStatus(newStatus);
      router.refresh();
    }
    setBusy(false);
  }

  return (
    <tr className="border-b border-border last:border-0 align-top">
      <td className="px-4 py-3">
        <span className="font-medium">{note.title}</span>
        <div className="mt-0.5 text-xs text-ink-faint">{AREA_LABEL[note.area] ?? note.area}</div>
        <p className="mt-1.5 max-w-md text-xs text-ink-soft">{note.description}</p>
        {(note.citation_text || note.citation_url) && (
          <p className="mt-1 text-xs text-ink-faint">
            {note.citation_text}
            {note.citation_url && (
              <>
                {note.citation_text ? " — " : ""}
                <a
                  href={note.citation_url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  source
                </a>
              </>
            )}
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-ink-soft">{note.effective_date}</td>
      <td className="px-4 py-3">
        <StatusBadge status={status} />
        <div className="mt-2 flex flex-col gap-1.5">
          {status === "applied" && (
            <input
              value={appliedNote}
              onChange={(e) => setAppliedNote(e.target.value)}
              placeholder="e.g. migration 0047"
              className="rounded border border-border-strong bg-surface px-2 py-1 text-xs"
            />
          )}
          <select
            value={status}
            disabled={busy}
            onChange={(e) => onStatusChange(e.target.value)}
            className="rounded border border-border-strong bg-surface px-2 py-1 text-xs"
          >
            <option value="proposed">Proposed</option>
            <option value="confirmed">Confirmed</option>
            <option value="applied">Applied</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
      </td>
    </tr>
  );
}

export function StatutoryUpdateManager({ notes }: { notes: Note[] }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [area, setArea] = useState("other");
  const [description, setDescription] = useState("");
  const [citationText, setCitationText] = useState("");
  const [citationUrl, setCitationUrl] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field =
    "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await createClient().from("statutory_update_notes").insert({
      title: title.trim(),
      area,
      description: description.trim(),
      citation_text: citationText.trim() || null,
      citation_url: citationUrl.trim() || null,
      effective_date: effectiveDate,
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    setTitle("");
    setArea("other");
    setDescription("");
    setCitationText("");
    setCitationUrl("");
    setEffectiveDate("");
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px]">
      <section className="min-w-0">
        <div className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Change</th>
                <th className="px-4 py-2.5 font-medium">Effective</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {notes.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center text-ink-faint">
                    Nothing logged yet. Add one on the right.
                  </td>
                </tr>
              )}
              {notes.map((n) => (
                <NoteRow key={n.id} note={n} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="font-semibold">Log a change</h2>
        <p className="mt-1 text-xs text-ink-faint">
          A paper trail, not an apply button — the actual rate/rule change
          still lands as a reviewed migration. This just tracks that it
          exists, where it came from, and whether it&rsquo;s landed yet.
        </p>
        <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Title</span>
            <input required value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Area</span>
            <select value={area} onChange={(e) => setArea(e.target.value)} className={field}>
              {Object.entries(AREA_LABEL).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Description</span>
            <textarea
              required
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              Citation <span className="font-normal text-ink-faint">optional</span>
            </span>
            <input
              value={citationText}
              onChange={(e) => setCitationText(e.target.value)}
              placeholder="e.g. CBDT Notification 45/2026"
              className={field}
            />
            <input
              value={citationUrl}
              onChange={(e) => setCitationUrl(e.target.value)}
              placeholder="https://…"
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Effective date</span>
            <input
              required
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className={field}
            />
          </label>

          {error && (
            <p className="rounded-md bg-error-soft px-3 py-2 text-sm text-error">{error}</p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="mt-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Logging…" : "Log change"}
          </button>
        </form>
      </section>
    </div>
  );
}
