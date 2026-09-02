"use client";

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { formatINR } from "@/lib/utils/currency";
import { Badge } from "@/components/ui/Badge";
import { TableContainer, th, td, num } from "@/components/ui/Table";

/**
 * The non-tax half of Schedule III Note (i) / AS 29 — guarantees given,
 * claims not acknowledged as debt, other contingently-liable money.
 *
 * public.contingent_liabilities has existed since 0105 with RLS and policies
 * in place, and get_contingent_liabilities_note has been UNIONing it into the
 * Notes to Accounts report all along — but nothing anywhere could write a row
 * to it, so a company with bank guarantees outstanding filed a note that
 * simply omitted them. This screen is that missing write path. Plain table
 * writes, not an RPC: contingent_liabilities_write (0105) already gates them
 * on app_private.can_write_company, there is no cross-table consequence to
 * enforce, and nothing here ever posts to the ledger — AS 29 para 14 says a
 * contingent liability "should not be recognised", so this is disclosure data
 * and nothing else.
 *
 * THE FIELDS ARE THE NOTE'S FIELDS. get_contingent_liabilities_note prints
 * category (mapped to Schedule III's own three headings), description
 * verbatim, amount, raised_date and status — and, critically, decides
 * membership of the note from resolved_date alone:
 *     raised_date <= as_at and (resolved_date is null or resolved_date > as_at)
 * so the two dates are not bookkeeping metadata here, they are what makes the
 * note right or wrong at a given as-at date. Hence: resolving asks for the
 * date and refuses without it, and the table says out loud whether each row
 * is in today's note. 1540 makes the contradictory states (closed with no
 * resolved_date, open with one) impossible at the database too.
 */

export type ContingentLiability = {
  id: string;
  category: string;
  description: string;
  related_ledger_id: string | null;
  amount: number;
  raised_date: string;
  status: string;
  resolved_date: string | null;
  resolution_note: string | null;
};

export type CounterpartyLedger = {
  id: string;
  name: string;
};

// Values match contingent_liabilities_category_check (0105) exactly; labels
// are the Schedule III headings get_contingent_liabilities_note maps each one
// to, so what a preparer picks here is what they will read in the note.
const CATEGORY_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "guarantee",
    label: "Guarantee given",
    hint: "A bank guarantee furnished on the company's behalf, a corporate guarantee to a subsidiary, a letter of comfort.",
  },
  {
    value: "claim_not_acknowledged",
    label: "Claim against the company not acknowledged as debt",
    hint: "A supplier or customer claim the company disputes. Tax and ROC demands belong on the notices list above instead, not here.",
  },
  {
    value: "other",
    label: "Other money for which the company is contingently liable",
    hint: "Anything else Schedule III's residual sub-category covers — a bill discounted with recourse, an indemnity given.",
  },
];

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(
  CATEGORY_OPTIONS.map((c) => [c.value, c.label])
);

const field =
  "rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30";

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The same membership test get_contingent_liabilities_note applies, as at
 * today — so the register can say what the note currently says rather than
 * leaving a preparer to infer it from two dates. */
function inNoteToday(cl: ContingentLiability): boolean {
  const today = todayLocal();
  return cl.raised_date <= today && (cl.resolved_date === null || cl.resolved_date > today);
}

type FormState = {
  id: string | null;
  category: string;
  description: string;
  relatedLedgerId: string;
  amount: string;
  raisedDate: string;
};

function blankForm(): FormState {
  return {
    id: null,
    category: "guarantee",
    description: "",
    relatedLedgerId: "",
    amount: "",
    raisedDate: todayLocal(),
  };
}

export function ContingentLiabilityManager({
  companyId,
  items,
  ledgers,
}: {
  companyId: string;
  items: ContingentLiability[];
  ledgers: CounterpartyLedger[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm());

  // Which row's resolve panel is open — one at a time, keyed by id, the same
  // shape NoticeManager's respond panel uses.
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolvedDate, setResolvedDate] = useState(todayLocal());
  const [resolutionNote, setResolutionNote] = useState("");

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const ledgerName = (id: string | null) =>
    id ? ledgers.find((l) => l.id === id)?.name ?? "(party no longer in the books)" : null;

  const inNoteCount = items.filter(inNoteToday).length;

  function startEdit(cl: ContingentLiability) {
    setForm({
      id: cl.id,
      category: cl.category,
      description: cl.description,
      relatedLedgerId: cl.related_ledger_id ?? "",
      amount: String(cl.amount),
      raisedDate: cl.raised_date,
    });
    setResolving(null);
    setShowForm(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const description = form.description.trim();
    if (!description) {
      toast.error("Say what is being disclosed — this text is printed in the note.");
      return;
    }
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error("Amount cannot be negative.");
      return;
    }
    setBusy(true);
    const payload = {
      company_id: companyId,
      category: form.category,
      description,
      related_ledger_id: form.relatedLedgerId || null,
      amount,
      raised_date: form.raisedDate,
    };
    const supabase = createClient();
    const { error } = form.id
      ? await supabase.from("contingent_liabilities").update(payload).eq("id", form.id)
      : await supabase.from("contingent_liabilities").insert(payload);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(form.id ? "Disclosure updated" : "Added to the contingent-liabilities note");
    setForm(blankForm());
    setShowForm(false);
    router.refresh();
  }

  /** Resolving sets status and resolved_date together — 1540 rejects one
   * without the other, and resolved_date is what actually takes the item out
   * of the note from that date forward. */
  async function resolve(cl: ContingentLiability) {
    if (!resolvedDate) {
      toast.error("A resolution date is required — it is what takes this out of the note.");
      return;
    }
    if (resolvedDate < cl.raised_date) {
      toast.error(`It cannot be resolved (${resolvedDate}) before it arose (${cl.raised_date}).`);
      return;
    }
    setBusy(true);
    const { error } = await createClient()
      .from("contingent_liabilities")
      .update({
        status: "closed",
        resolved_date: resolvedDate,
        resolution_note: resolutionNote.trim() || null,
      })
      .eq("id", cl.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Resolved — out of the note from ${resolvedDate}`);
    setResolving(null);
    setResolutionNote("");
    router.refresh();
  }

  async function reopen(cl: ContingentLiability) {
    if (
      !window.confirm(
        "Reopen this contingent liability? It goes back into the note for every as-at date from now on, and the resolution note is cleared."
      )
    ) {
      return;
    }
    setBusy(true);
    const { error } = await createClient()
      .from("contingent_liabilities")
      .update({ status: "open", resolved_date: null, resolution_note: null })
      .eq("id", cl.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Reopened — back in the note");
    router.refresh();
  }

  async function remove(cl: ContingentLiability) {
    if (
      !window.confirm(
        "Delete this disclosure? It vanishes from the note for every period, including ones already signed. If it genuinely existed and has since ended, resolve it instead so earlier periods still disclose it."
      )
    ) {
      return;
    }
    setBusy(true);
    const { error } = await createClient().from("contingent_liabilities").delete().eq("id", cl.id);
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Deleted");
    router.refresh();
  }

  const selectedCategory = CATEGORY_OPTIONS.find((c) => c.value === form.category);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-ink-soft">
          Guarantees given, disputed commercial claims and other contingently-liable money — the
          half of Schedule III Note (i) that does not come from a government notice. Nothing here is
          posted to the ledger: AS 29 says a contingent liability is <em>not</em> recognised, only
          disclosed.{" "}
          {inNoteCount > 0 ? (
            <span className="text-ink">
              {inNoteCount} {inNoteCount === 1 ? "item is" : "items are"} in today&rsquo;s note.
            </span>
          ) : (
            <span className="text-ink-faint">Nothing here is in today&rsquo;s note.</span>
          )}
        </p>
        <button
          type="button"
          onClick={() => {
            if (showForm) setForm(blankForm());
            setShowForm((s) => !s);
          }}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90"
        >
          {showForm ? "Cancel" : "Add a contingent liability"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={save}
          className="grid gap-4 rounded-[14px] border border-border bg-surface p-4 sm:grid-cols-2"
        >
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">Sub-category of the note</span>
            <select value={form.category} onChange={(e) => set("category", e.target.value)} className={field}>
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-faint">{selectedCategory?.hint}</span>
          </label>

          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">
              What to disclose{" "}
              <span className="font-normal text-ink-faint">— printed in the note word for word</span>
            </span>
            <textarea
              required
              rows={2}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Bank guarantee furnished to HDFC Bank in favour of the State Electricity Board as tender security, valid to 31 Mar 2027"
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Amount</span>
            <input
              required
              type="number"
              min={0}
              step="0.01"
              value={form.amount}
              onChange={(e) => set("amount", e.target.value)}
              className={field}
            />
            <span className="text-xs text-ink-faint">
              The amount the company is contingently liable for. Enter 0 if it genuinely is not
              quantifiable yet — the note then prints a dash rather than a made-up figure.
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Date it arose</span>
            <input
              required
              type="date"
              value={form.raisedDate}
              onChange={(e) => set("raisedDate", e.target.value)}
              className={field}
            />
            <span className="text-xs text-ink-faint">
              A note drawn up as at an earlier date will not include it.
            </span>
          </label>

          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">
              Counterparty <span className="font-normal text-ink-faint">— optional</span>
            </span>
            <select
              value={form.relatedLedgerId}
              onChange={(e) => set("relatedLedgerId", e.target.value)}
              className={field}
            >
              <option value="">Not a party in these books</option>
              {ledgers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-ink-faint">
              The bank that issued the guarantee, or the claimant. Leave it blank when the other
              side has no ledger here — a High Court writ, or a guarantee to a subsidiary this
              company does not trade with.
            </span>
          </label>

          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {form.id ? "Save changes" : "Save"}
            </button>
          </div>
        </form>
      )}

      <TableContainer>
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className={th}>In the note</th>
              <th className={th}>Sub-category</th>
              <th className={th}>What is disclosed</th>
              <th className={th}>Counterparty</th>
              <th className={th}>Arose</th>
              <th className={th + " text-right"}>Amount</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-ink-faint">
                  Nothing recorded. A company with bank guarantees outstanding, or a disputed
                  supplier claim, has to disclose it here — the notes to accounts cannot know about
                  it otherwise.
                </td>
              </tr>
            )}
            {items.map((cl) => (
              <Fragment key={cl.id}>
                <tr className="border-b border-border last:border-0">
                  <td className={td}>
                    {inNoteToday(cl) ? (
                      <Badge tone="warn">In note</Badge>
                    ) : (
                      <Badge tone="neutral">Not in note</Badge>
                    )}
                  </td>
                  <td className={td}>{CATEGORY_LABEL[cl.category] ?? cl.category}</td>
                  <td className={td + " max-w-sm text-ink-soft"}>
                    {cl.description}
                    {cl.resolution_note && (
                      <span className="mt-0.5 block text-xs text-ink-faint">
                        Resolution: {cl.resolution_note}
                      </span>
                    )}
                  </td>
                  <td className={td + " text-ink-soft"}>{ledgerName(cl.related_ledger_id) ?? "—"}</td>
                  <td className={td + " whitespace-nowrap"}>
                    {cl.raised_date}
                    {cl.resolved_date && (
                      <span className="block text-xs text-ink-faint">resolved {cl.resolved_date}</span>
                    )}
                  </td>
                  <td className={num}>{formatINR(Number(cl.amount))}</td>
                  <td className={td}>
                    <div className="flex flex-col items-start gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(cl)}
                        className="text-xs text-accent underline underline-offset-2"
                      >
                        Edit
                      </button>
                      {cl.status === "open" ? (
                        <button
                          type="button"
                          onClick={() => {
                            setResolving(resolving === cl.id ? null : cl.id);
                            setResolvedDate(todayLocal());
                            setResolutionNote("");
                          }}
                          className="text-xs text-accent underline underline-offset-2"
                        >
                          Resolve
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => reopen(cl)}
                          className="text-xs text-accent underline underline-offset-2 disabled:opacity-50"
                        >
                          Reopen
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove(cl)}
                        className="text-xs text-ink-soft underline underline-offset-2 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
                {resolving === cl.id && (
                  <tr className="border-b border-border bg-bg">
                    <td colSpan={7} className="px-4 py-3">
                      <p className="mb-2 max-w-3xl text-xs text-ink-soft">
                        The guarantee was released, the claim was settled or withdrawn, the
                        contingency ended. It stays in any note drawn up as at a date{" "}
                        <em>before</em> the date below — which is how last year&rsquo;s signed
                        accounts keep disclosing it — and drops out of every note from that date on.
                      </p>
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium">Resolved on</span>
                          <input
                            required
                            type="date"
                            value={resolvedDate}
                            onChange={(e) => setResolvedDate(e.target.value)}
                            className={field}
                          />
                        </label>
                        <label className="flex flex-1 flex-col gap-1">
                          <span className="text-xs font-medium">Note (optional)</span>
                          <input
                            value={resolutionNote}
                            onChange={(e) => setResolutionNote(e.target.value)}
                            placeholder="Guarantee released by the bank / claim settled at Rs 40,000"
                            className={field}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => resolve(cl)}
                          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
                        >
                          Mark resolved
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
