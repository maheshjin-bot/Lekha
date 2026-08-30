import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { CaptureWorkspace } from "@/components/capture/CaptureWorkspace";
import {
  buildNumberingByBranch,
  type NumberingSettingsRow,
} from "@/lib/numbering/voucher-numbering";

/**
 * /[companyId]/capture — OCR/vision bill capture (0740).
 *
 * Same master-fetching shape as app/(app)/[companyId]/invoices/new/page.tsx
 * (items/ledgers/branches/godowns/modules/states/numbering), because
 * confirming a draft here ends up calling the exact same create_invoice RPC
 * with a 'purchase' voucher type — this screen needs everything that screen
 * needs, plus the drafts themselves.
 */
export default async function CapturePage({
  params,
}: PageProps<"/[companyId]/capture">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [
    { data: items },
    { data: ledgers },
    { data: branches },
    { data: godowns },
    { data: modules },
    { data: states },
    { data: draftsRaw, error: draftsError },
  ] = await Promise.all([
    supabase
      .from("items")
      .select("id, name, uom, sale_rate, purchase_rate, gst_rate_percent, default_tcs_section")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .eq("maintain_stock", true)
      .order("name"),
    supabase
      .from("ledgers")
      .select("id, name, state_code, pan, account_groups(ledger_role)")
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
    // capture_drafts is brand new (0740) — types/database.types.ts does not
    // know it in this session (no live DB connection was available to
    // regenerate it here; see this task's own final report). Same escape
    // hatch InvoiceForm's page already uses for get_voucher_numbering_settings.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
    (supabase as any)
      .from("capture_drafts")
      .select("id, source, storage_path, extracted_json, status, confirmed_voucher_id, created_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(30),
  ]);

  const flatLedgers = (ledgers ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    ledger_role: l.account_groups?.ledger_role ?? "other",
    state_code: l.state_code,
    pan: l.pan,
  }));

  const flatBranches = (branches ?? []).map((b) => ({
    id: b.id,
    code: b.code,
    name: b.name,
    registeredState: b.gst_registrations?.state_code ?? null,
  }));

  const gstOn = (modules ?? []).some((m) => m.code === "gst" && m.active);

  // Numbering policy for 'purchase' vouchers only, per branch — same
  // per-branch fan-out invoices/new/page.tsx already does, narrowed to the
  // one voucher type this screen ever posts.
  const numbering = buildNumberingByBranch(
    await Promise.all(
      flatBranches.map(async (b) => {
        const { data } = await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .rpc("get_voucher_numbering_settings" as any, {
            p_company_id: companyId,
            p_branch_id: b.id,
          });
        return [b.id, (data ?? []) as unknown as NumberingSettingsRow[]] as const;
      })
    )
  );

  type DraftRow = {
    id: string;
    source: string;
    storage_path: string;
    extracted_json: unknown;
    status: "pending_review" | "confirmed" | "rejected";
    confirmed_voucher_id: string | null;
    created_at: string;
  };
  const drafts = (draftsError ? [] : (draftsRaw as DraftRow[] | null)) ?? [];

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
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
        Capture a bill
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        Upload a photo or PDF of a supplier&rsquo;s bill. This app reads it and
        drafts the fields below for you to check — nothing is posted to your
        books until you review the draft and press &ldquo;Post as purchase
        bill&rdquo; yourself. A draft never posts itself.
      </p>

      {blocked ? (
        <p className="mt-8 rounded-lg border border-dashed border-border-strong px-5 py-8 text-center text-sm text-ink-faint">
          You need {blocked.what} before you can capture a bill.{" "}
          <Link href={blocked.href} className="text-accent underline underline-offset-4">
            {blocked.label}
          </Link>
          .
        </p>
      ) : (
        <CaptureWorkspace
          companyId={companyId}
          items={items ?? []}
          ledgers={flatLedgers}
          branches={flatBranches}
          godowns={godowns ?? []}
          gstOn={gstOn}
          states={states ?? []}
          numbering={numbering}
          initialDrafts={drafts}
        />
      )}
    </main>
  );
}
