import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { CaptureUploadPanel } from "@/components/capture/CaptureUploadPanel";
import {
  CaptureReviewInbox,
  type CapturerOption,
  type QueueFilters,
} from "@/components/capture/CaptureReviewInbox";
import {
  isDocumentType,
  isDraftStatus,
  normalizeQueue,
  type QueueRow,
} from "@/components/capture/reviewModel";
import {
  buildNumberingByBranch,
  type NumberingSettingsRow,
} from "@/lib/numbering/voucher-numbering";

/**
 * /[companyId]/capture — the back-office REVIEW INBOX for photographed
 * documents.
 *
 * This route used to BE the capture screen: a file picker at the top, a draft
 * list, and a review form below, all in one scroll — uploader and reviewer the
 * same person. Capture has moved to the phone surface at /scan, where the
 * person actually holding the paper is. What is left here is the accountant's
 * side of the same feature: a queue of what arrived, and the desk where it
 * becomes a voucher.
 *
 * It still fetches exactly the master data the ordinary invoice screens fetch
 * (items/ledgers/branches/godowns/modules/states/numbering), because
 * confirming a draft ends up calling the exact same create_invoice RPC — now
 * with a 'purchase' OR a 'sales' voucher type, depending on what the document
 * turned out to be (migration 0865).
 *
 * WHY THESE TWO EXTRA COLUMNS ARE FETCHED rather than derived on the client:
 *
 *   items.hsn_sac — the review form compares the HSN printed on the paper
 *   against the one on the item master, and offers to write it onto the
 *   master when that is blank. HSN lives on the ITEM (voucher_items only ever
 *   holds a copy taken at posting time), so the comparison needs the master
 *   value.
 *
 *   ledgers.gstin — "is this the right party?" is the review's first
 *   question, and the strongest evidence available is whether the fifteen
 *   characters printed on the document are the fifteen on the ledger. Without
 *   it the screen can only match on a name, which is exactly the match a
 *   reviewer most needs a second opinion on.
 *
 * FILTERS live in the URL, the same shape /audit-trail uses, so a filtered
 * queue is a link someone can send. ALL FIVE now go to the RPC — status,
 * document type, branch, capturer and the arrived-between date range. The
 * date range was applied client-side when this screen was first written,
 * because get_capture_review_queue took no from/to arguments; 0871 added
 * them precisely because a filter applied after p_limit under-reports
 * without saying so.
 */

/** Deliberately generous: this is a back-office desk, not a phone list. */
const QUEUE_LIMIT = 200;

/**
 * The date filters go to Postgres as `date` arguments now (0871), so a
 * hand-edited or stale `?from=last-tuesday` would raise on the cast and take
 * the whole screen down — the same failure the status/document-type guards
 * below already exist to prevent. Anything that is not a plain YYYY-MM-DD is
 * dropped to "no filter" rather than forwarded.
 */
function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export default async function CapturePage({
  params,
  searchParams,
}: PageProps<"/[companyId]/capture">) {
  const { companyId } = await params;
  const sp = await searchParams;
  const supabase = await createClient();

  const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

  // Validated here, not merely passed through: get_capture_review_queue RAISES
  // on an unrecognised status or document type rather than silently widening
  // the queue, so a stale or hand-edited URL would otherwise take the whole
  // screen down instead of showing an unfiltered list.
  const filters: QueueFilters = {
    status: isDraftStatus(one(sp.status)) ? one(sp.status) : "",
    documentType: isDocumentType(one(sp.type)) ? one(sp.type) : "",
    branchId: one(sp.branch),
    capturedBy: one(sp.by),
    from: isIsoDate(one(sp.from)) ? one(sp.from) : "",
    to: isIsoDate(one(sp.to)) ? one(sp.to) : "",
  };

  const [
    { data: items },
    { data: ledgers },
    { data: branches },
    { data: godowns },
    { data: modules },
    { data: states },
    { data: queueRaw, error: queueError },
    { data: allRaw },
  ] = await Promise.all([
    supabase
      .from("items")
      .select("id, name, uom, hsn_sac, sale_rate, purchase_rate, gst_rate_percent, default_tcs_section")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("maintain_stock", true)
      .order("name"),
    supabase
      .from("ledgers")
      .select("id, name, state_code, pan, gstin, account_groups(ledger_role)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("branches")
      .select("id, code, name, gst_registration_id, gst_registrations(state_code)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_head_office", { ascending: false }),
    supabase
      .from("godowns")
      .select("id, code, name")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .order("is_default", { ascending: false }),
    supabase.rpc("get_company_modules", { p_company_id: companyId }),
    supabase.from("ref_states").select("code, name").order("name"),
    // The queue itself (0870). An OMITTED filter argument means "no filter" —
    // the RPC defaults each one to null — so an unset dropdown sends undefined
    // rather than a sentinel string the function would raise on.
    supabase.rpc("get_capture_review_queue", {
      p_company_id: companyId,
      p_status: filters.status || undefined,
      p_document_type: filters.documentType || undefined,
      p_branch_id: filters.branchId || undefined,
      p_captured_by: filters.capturedBy || undefined,
      p_limit: QUEUE_LIMIT,
      // 0871. These used to be applied in the browser, AFTER p_limit had
      // already cut the result set — so a narrow range on a busy company
      // showed a handful of rows and looked authoritative while older
      // matching rows had never been fetched at all. Filtering here happens
      // before the limit, so the range is now honest.
      p_from: filters.from || undefined,
      p_to: filters.to || undefined,
    }),
    // A second, UNFILTERED read, purely to populate the "Sent by" picker: the
    // filtered call can only ever name the one person already filtered to, so
    // the options have to come from a read the filter has not been applied to.
    supabase.rpc("get_capture_review_queue", {
      p_company_id: companyId,
      p_limit: QUEUE_LIMIT,
    }),
  ]);

  const rows: QueueRow[] = queueError ? [] : normalizeQueue(queueRaw);

  // Distinct senders, one entry each, sorted by the name the reviewer will
  // actually read rather than by a uuid.
  const capturerMap = new Map<string, CapturerOption>();
  for (const r of normalizeQueue(allRaw)) {
    if (r.capturedById && !capturerMap.has(r.capturedById)) {
      capturerMap.set(r.capturedById, {
        id: r.capturedById,
        label: r.capturedByLabel ?? "Unknown sender",
      });
    }
  }
  const capturers = [...capturerMap.values()].sort((a, b) => a.label.localeCompare(b.label));

  const flatLedgers = (ledgers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    ledger_role: l.account_groups?.ledger_role ?? "other",
    state_code: l.state_code,
    pan: l.pan,
    // ledgers.gstin is a real column (0735 constrains it against state and
    // PAN) and comes back through the generated types, so no hatch is needed
    // for it — only the capture RPCs above need one.
    gstin: l.gstin,
  }));

  const flatBranches = (branches ?? []).map((b) => ({
    id: b.id,
    code: b.code,
    name: b.name,
    registeredState: b.gst_registrations?.state_code ?? null,
  }));

  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);

  // Numbering policy per branch — the same per-branch fan-out
  // invoices/new/page.tsx does, and deliberately NOT narrowed to one voucher
  // type: since 0865 this screen posts a sales OR a purchase voucher depending
  // on the document type the reviewer confirms, and that choice is made
  // client-side with no reload.
  const numbering = buildNumberingByBranch(
    await Promise.all(
      flatBranches.map(async (b) => {
        const { data } = await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- get_voucher_numbering_settings predates the generated types.
          .rpc("get_voucher_numbering_settings" as any, {
            p_company_id: companyId,
            p_branch_id: b.id,
          });
        return [b.id, (data ?? []) as unknown as NumberingSettingsRow[]] as const;
      })
    )
  );

  const blocked = !godowns?.length
    ? { what: "a godown", href: `/${companyId}`, label: "No godown configured" }
    : gstOn && flatBranches.every((b) => !b.registeredState)
      ? {
          what: "a GST registration attached to a branch",
          href: `/${companyId}/registrations`,
          label: "Attach one",
        }
      : flatLedgers.length === 0
        ? { what: "at least one ledger", href: `/${companyId}/ledgers`, label: "Add one" }
        : null;

  return (
    <main className="mx-auto max-w-[1600px] px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Document inbox
      </h1>
      <p className="mt-1.5 max-w-3xl text-sm text-ink-soft">
        Everything photographed at the counter arrives here. Open a document, check what was read
        against the picture beside it, and post it — or send it back with a reason, so the next
        photograph is a usable one. Nothing reaches your books until you press post yourself: a
        draft never posts itself.
      </p>

      <CaptureUploadPanel companyId={companyId} />

      {blocked ? (
        <p className="mt-8 rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          You need {blocked.what} before a captured document can be posted.{" "}
          <Link href={blocked.href} className="text-accent underline underline-offset-4">
            {blocked.label}
          </Link>
          .
        </p>
      ) : (
        <CaptureReviewInbox
          companyId={companyId}
          rows={rows}
          filters={filters}
          capturers={capturers}
          branches={flatBranches}
          queueError={queueError?.message ?? null}
          limit={QUEUE_LIMIT}
          items={items ?? []}
          ledgers={flatLedgers}
          godowns={godowns ?? []}
          gstOn={gstOn}
          states={states ?? []}
          numbering={numbering}
        />
      )}
    </main>
  );
}
