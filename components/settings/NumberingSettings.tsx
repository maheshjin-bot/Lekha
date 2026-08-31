"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Input";

/**
 * One row of get_voucher_numbering_settings (migration 0725) — one voucher
 * type per series, so a type in series mode arrives as several rows. A null
 * series_id marks a synthetic row: that voucher type has never been raised,
 * so no series exists yet and the row previews the Default the numbering
 * engine would provision on first use.
 */
export type NumberingRow = {
  voucher_type: string;
  type_label: string;
  allows_manual: boolean;
  mode: string;
  branch_id: string;
  branch_code: string;
  financial_year_label: string;
  series_id: string | null;
  series_name: string;
  prefix: string;
  padding: number;
  is_default: boolean;
  is_active: boolean;
  next_number: number;
  preview_number: string;
  preview_length: number;
  rule46b_ok: boolean;
  /**
   * False when this company has more than one branch and this series' prefix
   * has no {BRANCH} token — the counter is per branch but the prefix is not,
   * so the series issues the SAME number in every branch (migration 1160).
   * True for a single-branch company, where there is no second counter and
   * therefore nothing to collide.
   */
  branch_scope_ok: boolean;
  /** The sentence to show when branch_scope_ok is false; null when it is true. */
  branch_scope_note: string | null;
};

export type BranchOption = { id: string; code: string; name: string };

/**
 * The document types whose number is printed on something that leaves the
 * business and is read by the GST system — a tax invoice (Rule 46(b)), a
 * credit or debit note (Rule 53(1A), which repeats the sixteen-character cap
 * word for word), and the challans that carry goods and therefore an e-way
 * bill. On these, sixteen characters is a hard limit the portal enforces.
 * On a journal or a receipt it is only untidiness — saying otherwise on
 * screen would be scaremongering, so the badge tone differs.
 */
const GST_FACING = new Set([
  "sales",
  "credit_note",
  "debit_note",
  "branch_transfer",
  "delivery_challan_out",
  "job_work_out",
]);

const MODE_LABEL: Record<string, string> = {
  automatic: "Automatic",
  manual: "Manual",
  series: "Series",
};

/**
 * The client-side twin of app_private.resolve_number_prefix, so the preview
 * updates as the prefix is typed instead of after a round trip. {FYS} is
 * replaced before {FY} for the same reason the SQL does it in that order:
 * replacing {FY} first would leave '2026-27S}' behind.
 */
function resolvePrefix(template: string, branchCode: string, fyLabel: string): string {
  return template
    .replaceAll("{BRANCH}", branchCode)
    .replaceAll("{FYS}", fyLabel.slice(2))
    .replaceAll("{FY}", fyLabel)
    .replaceAll("{YYYY}", fyLabel.slice(0, 4))
    .replaceAll("{YY}", fyLabel.slice(2, 4));
}

/**
 * Postgres lpad, not String.padStart: lpad TRUNCATES when the value is longer
 * than the width — lpad('20', 1, '0') is '2', verified live. padStart would
 * quietly show '20' and the preview would then disagree with the number the
 * database actually mints, which is the one thing this screen must never do.
 */
function lpad(value: number, width: number): string {
  const s = String(value);
  return s.length >= width ? s.slice(0, width) : s.padStart(width, "0");
}

function previewOf(template: string, branchCode: string, fyLabel: string, next: number, padding: number) {
  return resolvePrefix(template, branchCode, fyLabel) + lpad(next, padding);
}

const PREFIX_RE = /^([A-Za-z0-9/-]|\{(BRANCH|FY|FYS|YY|YYYY)\})*$/;

/**
 * The client-side twin of app_private.prefix_names_the_branch (migration 1160).
 *
 * The counter behind a series is per branch; the prefix need not be. A prefix
 * with no {BRANCH} token therefore issues the SAME number in every branch —
 * proven live before it was fixed: one series, two branches, both handed
 * PRF/26-27/0001, and public.vouchers' UNIQUE key accepted both because
 * branch_id is part of it. CGST Rule 46(b) wants a serial number unique for
 * the financial year, not per branch, so that is a real defect in a statutory
 * series and the database now refuses it. This is the same question asked one
 * round trip earlier, so the admin sees it while typing.
 */
function prefixNamesTheBranch(prefix: string): boolean {
  return prefix.includes("{BRANCH}");
}

function LengthBadge({ length, gstFacing }: { length: number; gstFacing: boolean }) {
  if (length <= 16) return <Badge tone="ok">{length} characters</Badge>;
  return (
    <Badge tone={gstFacing ? "bad" : "warn"}>
      {length} characters — over the 16 allowed
    </Badge>
  );
}

type Editor = {
  voucherType: string;
  typeLabel: string;
  seriesId: string | null;
  /** True when editing the synthetic Default of a never-used type: there is no
   *  row to update, so saving CREATES the series the engine would have made. */
  synthetic: boolean;
  branchCode: string;
  fyLabel: string;
  nextNumber: number;
  name: string;
  prefix: string;
  padding: string;
  /**
   * The prefix this series is stored with, or null when saving will CREATE a
   * series rather than edit one. Migration 1160 holds a changed prefix to the
   * branch rule and grandfathers an unchanged one, so that an admin can still
   * rename or repad a series configured before the app refused the format.
   * Mirroring that here keeps the button's enabled state honest.
   */
  originalPrefix: string | null;
};

export function NumberingSettings({
  companyId,
  branches,
  initialRows,
  isAdmin,
}: {
  companyId: string;
  branches: BranchOption[];
  initialRows: NumberingRow[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<NumberingRow[]>(initialRows);
  const [branchId, setBranchId] = useState<string>(initialRows[0]?.branch_id ?? branches[0]?.id ?? "");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pendingManual, setPendingManual] = useState<{ voucherType: string; typeLabel: string } | null>(null);

  const supabase = createClient();

  // Migration 1160. A prefix that does not name the branch is only a hazard
  // where there is a second branch to collide with, so everything below is
  // conditioned on this rather than applied to everybody.
  const multiBranch = branches.length > 1;
  const branchCodes = branches.map((b) => b.code).join(" and ");
  const prefixChanging =
    editor !== null && (editor.originalPrefix === null || editor.prefix !== editor.originalPrefix);
  const prefixBranchOk = editor === null || !multiBranch || prefixNamesTheBranch(editor.prefix);

  async function reload(nextBranchId: string) {
    const { data, error } = await supabase
      // get_voucher_numbering_settings and the numbering tables are brand new
      // (migration 0725) — types/database.types.ts is owned by the integration
      // pass and doesn't know them yet, hence the disabled rule here and below.
      // Purely a compile-time typing gap; the shapes are verified live.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .rpc("get_voucher_numbering_settings" as any, {
        p_company_id: companyId,
        p_branch_id: nextBranchId,
      });
    if (error) {
      toast.error(error.message);
      return;
    }
    setRows((data ?? []) as unknown as NumberingRow[]);
  }

  async function onBranchChange(nextBranchId: string) {
    setBranchId(nextBranchId);
    setBusyKey("branch");
    await reload(nextBranchId);
    setBusyKey(null);
  }

  async function applyMode(voucherType: string, mode: string) {
    setBusyKey(`mode:${voucherType}`);
    const { error } = await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .rpc("set_voucher_numbering_mode" as any, {
        p_company_id: companyId,
        p_voucher_type: voucherType,
        p_mode: mode,
      });
    if (error) {
      setBusyKey(null);
      toast.error(error.message);
      return;
    }
    await reload(branchId);
    setBusyKey(null);
    toast.success(`Numbering set to ${MODE_LABEL[mode]?.toLowerCase() ?? mode}`);
    router.refresh();
  }

  function onModeSelected(row: NumberingRow, mode: string) {
    if (mode === row.mode) return;
    if (mode === "manual") {
      // Manual numbering is the one choice on this screen that can put the
      // company out of compliance by itself, so it is the one that asks first.
      setPendingManual({ voucherType: row.voucher_type, typeLabel: row.type_label });
      return;
    }
    void applyMode(row.voucher_type, mode);
  }

  async function makeDefault(row: NumberingRow) {
    if (!row.series_id) return;
    setBusyKey(`default:${row.series_id}`);
    const { error } = await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .rpc("update_voucher_number_series" as any, {
        p_company_id: companyId,
        p_series_id: row.series_id,
        p_is_default: true,
      });
    if (error) {
      setBusyKey(null);
      toast.error(error.message);
      return;
    }
    await reload(branchId);
    setBusyKey(null);
    toast.success(`"${row.series_name}" is now the default series`);
    router.refresh();
  }

  async function setActive(row: NumberingRow, active: boolean) {
    if (!row.series_id) return;
    setBusyKey(`active:${row.series_id}`);
    const { error } = await supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
      .rpc("set_voucher_number_series_active" as any, {
        p_company_id: companyId,
        p_series_id: row.series_id,
        p_is_active: active,
      });
    if (error) {
      setBusyKey(null);
      toast.error(error.message);
      return;
    }
    await reload(branchId);
    setBusyKey(null);
    toast.success(active ? `"${row.series_name}" restored` : `"${row.series_name}" retired`);
    router.refresh();
  }

  function openEdit(row: NumberingRow) {
    setEditor({
      voucherType: row.voucher_type,
      typeLabel: row.type_label,
      seriesId: row.series_id,
      synthetic: row.series_id === null,
      branchCode: row.branch_code,
      fyLabel: row.financial_year_label,
      nextNumber: row.next_number,
      name: row.series_name,
      prefix: row.prefix,
      padding: String(row.padding),
      // A synthetic row has no stored series, so saving CREATES one and the
      // branch rule applies in full — there is nothing to grandfather.
      originalPrefix: row.series_id === null ? null : row.prefix,
    });
  }

  function openCreate(row: NumberingRow) {
    setEditor({
      voucherType: row.voucher_type,
      typeLabel: row.type_label,
      seriesId: null,
      synthetic: false,
      branchCode: row.branch_code,
      fyLabel: row.financial_year_label,
      nextNumber: 1,
      name: "",
      prefix: row.prefix,
      padding: String(row.padding),
      originalPrefix: null,
    });
  }

  async function saveEditor() {
    if (!editor) return;
    const name = editor.name.trim();
    const padding = Number(editor.padding);
    if (!name) {
      toast.error("A numbering series needs a name.");
      return;
    }
    if (!PREFIX_RE.test(editor.prefix)) {
      toast.error(
        "The prefix may only contain letters, digits, hyphen, slash and the tokens {BRANCH}, {FY}, {FYS}, {YYYY}, {YY}."
      );
      return;
    }
    if (!Number.isInteger(padding) || padding < 1 || padding > 9) {
      toast.error("Padding must be a whole number of digits between 1 and 9.");
      return;
    }
    // Migration 1160. Only when the prefix is actually being CHANGED, which is
    // exactly the database's own grandfathering rule: a series that already
    // exists with a branch-blind prefix keeps working, and an admin renaming
    // it or widening its padding must not be blocked by a format decision
    // taken before the app refused it.
    if (prefixChanging && !prefixBranchOk) {
      toast.error(
        `This prefix has no {BRANCH} token, so it would issue the same number at ${branchCodes}. A document serial number has to be unique for the whole financial year, not per branch.`
      );
      return;
    }

    setBusyKey("save");
    const { error } = editor.seriesId
      ? await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .rpc("update_voucher_number_series" as any, {
            p_company_id: companyId,
            p_series_id: editor.seriesId,
            p_name: name,
            p_prefix: editor.prefix,
            p_padding: padding,
          })
      : await supabase
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
          .rpc("create_voucher_number_series" as any, {
            p_company_id: companyId,
            p_voucher_type: editor.voucherType,
            p_name: name,
            p_prefix: editor.prefix,
            p_padding: padding,
            // The synthetic Default of a never-used type has to be created as
            // the default, because that is the row the engine would otherwise
            // provision itself on the first voucher.
            p_is_default: editor.synthetic,
          });

    if (error) {
      setBusyKey(null);
      toast.error(error.message);
      return;
    }
    await reload(branchId);
    setBusyKey(null);
    setEditor(null);
    toast.success(
      editor.seriesId || editor.synthetic ? "Series saved" : `Series "${name}" created`
    );
    router.refresh();
  }

  /** Rows regrouped into one block per voucher type, RPC order preserved. */
  const groups = useMemo(() => {
    const out: { type: NumberingRow; series: NumberingRow[] }[] = [];
    const index = new Map<string, number>();
    for (const r of rows) {
      const at = index.get(r.voucher_type);
      if (at === undefined) {
        index.set(r.voucher_type, out.length);
        out.push({ type: r, series: [r] });
      } else {
        out[at].series.push(r);
      }
    }
    return out;
  }, [rows]);

  const overLong = groups.filter((g) =>
    g.series.some((s) => s.is_active && s.preview_length > 16)
  );
  const overLongGst = overLong.filter((g) => GST_FACING.has(g.type.voucher_type));
  // Lead the banner with the sales invoice when it is one of the offenders —
  // it is the document a reader recognises, and the one the IRP actually
  // refuses. Otherwise show whichever type comes first.
  const exemplar =
    overLongGst.find((g) => g.type.voucher_type === "sales")?.type ?? overLongGst[0]?.type;

  // Migration 1160. Active series whose prefix cannot tell this company's
  // branches apart. Only ever non-empty for a multi-branch company holding a
  // series configured before the app refused that format (or one whose second
  // branch was opened afterwards) — the RPC returns branch_scope_ok true for
  // every single-branch company, so nobody is warned about a non-problem.
  const branchBlind = rows.filter(
    (r) => r.is_active && !r.branch_scope_ok && r.series_id !== null
  );
  const branchBlindDefault = branchBlind.find((r) => r.is_default);

  const editorPreview = editor
    ? previewOf(
        editor.prefix,
        editor.branchCode,
        editor.fyLabel,
        editor.nextNumber,
        Math.min(Math.max(Number(editor.padding) || 1, 1), 9)
      )
    : "";
  const editorPrefixOk = editor ? PREFIX_RE.test(editor.prefix) : true;
  const editorPaddingTooSmall = editor
    ? String(editor.nextNumber).length > (Number(editor.padding) || 1)
    : false;

  return (
    <div className="mt-8 flex flex-col gap-6">
      {exemplar ? (
        <Alert tone="warning" className="leading-relaxed">
          <span className="font-semibold">
            {overLongGst.length === 1
              ? "One document type is numbering itself in a format the GST system rejects."
              : `${overLongGst.length} document types are numbering themselves in a format the GST system rejects.`}
          </span>{" "}
          CGST Rule 46(b) caps a document serial number at{" "}
          <span className="font-semibold">sixteen characters</span>, using only letters, digits,
          hyphen and slash. The next {exemplar.type_label.toLowerCase()} here would be numbered{" "}
          <span className="font-mono">{exemplar.preview_number}</span> —{" "}
          {exemplar.preview_length} characters. The Invoice Registration Portal and the e-way bill
          portal both refuse a number that long, so an e-invoice cannot be generated against it.
          Shorten the prefix below:{" "}
          {multiBranch ? (
            // The single-branch advice ("drop the branch code") is the one
            // thing a multi-branch company must NOT do — it is exactly how two
            // branches end up printing the same number, which migration 1160
            // now refuses. Dropping the slashes around {BRANCH} saves the same
            // characters and keeps the branches distinguishable.
            <>
              <span className="font-mono">
                {"{BRANCH}"}SAL/{"{YY}"}/
              </span>{" "}
              with 4 digits gives{" "}
              <span className="font-mono">{branches[0]?.code ?? "HO"}SAL/26/0020</span>, thirteen
              characters — and because it still carries {"{BRANCH}"}, each of this company&rsquo;s{" "}
              {branches.length} branches keeps its own numbers.
            </>
          ) : (
            <>
              <span className="font-mono">SAL/{"{FYS}"}/</span> with 4 digits gives{" "}
              <span className="font-mono">SAL/26-27/0020</span>, fourteen characters.
            </>
          )}{" "}
          Nothing already issued is renumbered — the change applies from the next voucher.
        </Alert>
      ) : (
        <Alert tone="success">
          Every active series previews at 16 characters or fewer, which is what CGST Rule 46(b)
          allows on a document number.
        </Alert>
      )}

      {branchBlind.length > 0 && (
        <Alert tone={branchBlindDefault ? "error" : "warning"} className="leading-relaxed">
          <span className="font-semibold">
            {branchBlind.length === 1
              ? `The series "${branchBlind[0].series_name}" cannot tell this company's branches apart.`
              : `${branchBlind.length} series cannot tell this company's branches apart.`}
          </span>{" "}
          Their prefixes carry no <span className="font-mono">{"{BRANCH}"}</span> token, and each
          branch keeps its own counter — so the same number would be issued once at{" "}
          {branchCodes.replace(" and ", ", ").replace(/, ([^,]*)$/, " and $1")}. CGST Rule 46(b)
          requires a document serial number to be unique for the{" "}
          <span className="font-medium">whole financial year</span>, not per branch, and the
          e-invoice portal refuses a second document with a number already registered against the
          same GSTIN (error 2150, duplicate IRN).{" "}
          {branchBlindDefault ? (
            <>
              <span className="font-semibold">
                One of them is a default series, which every branch numbers from
              </span>
              , so the next {branchBlindDefault.type_label.toLowerCase()} raised outside the branch
              already using it will be refused rather than issued a duplicate. Fix that one first.
            </>
          ) : (
            <>
              Nothing is broken yet — each of these has only ever been used at one branch, and it
              keeps working there. Using one at another branch is refused rather than allowed to
              duplicate a number.
            </>
          )}{" "}
          Edit the prefix below to include <span className="font-mono">{"{BRANCH}"}</span>, or give
          each branch a series of its own.
        </Alert>
      )}

      {branches.length > 1 && (
        <Card>
          <CardBody className="flex flex-wrap items-end gap-4">
            <Field
              label="Preview for branch"
              hint="A prefix holding {BRANCH} produces a different length at each branch, so the character count is shown one branch at a time."
              className="min-w-56"
            >
              <Select
                value={branchId}
                disabled={busyKey === "branch"}
                onChange={(e) => void onBranchChange(e.target.value)}
              >
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="pb-1.5 text-xs text-ink-faint">
              Financial year {groups[0]?.type.financial_year_label ?? ""}. Counters restart each
              financial year; the series and its prefix carry across.
            </p>
          </CardBody>
        </Card>
      )}

      {([true, false] as const).map((userRaised) => {
        const blocks = groups.filter((g) => g.type.allows_manual === userRaised);
        if (blocks.length === 0) return null;
        return (
          <Card key={String(userRaised)}>
            <CardHeader>
              <h2 className="font-semibold">
                {userRaised ? "Documents you raise" : "Documents the app raises"}
              </h2>
              <p className="mt-0.5 text-sm text-ink-soft">
                {userRaised
                  ? "Invoices, notes and vouchers entered by hand. These are the only types that can be numbered manually."
                  : "Production, job work, delivery challans and stock movements are raised by the app itself, and nobody hand-types their number. Automatic or series only."}
              </p>
            </CardHeader>
            <CardBody className="flex flex-col divide-y divide-border p-0">
              {blocks.map(({ type, series }) => {
                const gstFacing = GST_FACING.has(type.voucher_type);
                return (
                  <div key={type.voucher_type} className="px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-ink">{type.type_label}</span>
                          <Badge tone={type.mode === "automatic" ? "neutral" : "accent"}>
                            {MODE_LABEL[type.mode] ?? type.mode}
                          </Badge>
                          {gstFacing && <Badge tone="neutral">GST document</Badge>}
                        </div>
                        <p className="mt-0.5 text-xs text-ink-faint">
                          {gstFacing
                            ? "This number is printed on a document the GST system reads, so sixteen characters is a hard limit."
                            : "Internal document. The sixteen-character cap doesn't bind it, though the same prefix settings apply."}
                        </p>
                      </div>

                      <label className="flex w-full items-center gap-2 text-xs text-ink-soft sm:w-auto sm:shrink-0">
                        <span className="sr-only">{type.type_label} numbering mode</span>
                        <Select
                          aria-label={`${type.type_label} numbering mode`}
                          value={type.mode}
                          disabled={!isAdmin || busyKey === `mode:${type.voucher_type}`}
                          title={
                            isAdmin
                              ? undefined
                              : "Only an admin can change how this company numbers its documents"
                          }
                          onChange={(e) => onModeSelected(type, e.target.value)}
                          className="w-full sm:w-44"
                        >
                          <option value="automatic">Automatic</option>
                          <option value="series">Series</option>
                          <option value="manual" disabled={!type.allows_manual}>
                            Manual{type.allows_manual ? "" : " — not available"}
                          </option>
                        </Select>
                      </label>
                    </div>

                    <div className="mt-3 flex flex-col gap-2">
                      {series.map((s) => {
                        const unusedInAutomatic = type.mode !== "series" && !s.is_default;
                        return (
                          <div
                            key={s.series_id ?? `${s.voucher_type}:synthetic`}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3.5 py-3"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium text-ink">{s.series_name}</span>
                                {s.is_default && <Badge tone="accent">Default</Badge>}
                                {!s.is_active && <Badge tone="neutral">Retired</Badge>}
                                {s.series_id === null && <Badge tone="neutral">Not used yet</Badge>}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                <span className="font-mono text-sm text-ink">{s.preview_number}</span>
                                <LengthBadge length={s.preview_length} gstFacing={gstFacing} />
                              </div>
                              <p className="mt-1 text-xs text-ink-faint">
                                <span className="font-mono">{s.prefix}</span> + {s.padding}-digit
                                counter, next number {s.next_number}
                                {unusedInAutomatic &&
                                  " — not used while this type is numbered automatically"}
                              </p>
                              {/* Migration 1160. Only ever shown for a series
                                  configured BEFORE the app started refusing
                                  this, or one whose company opened a second
                                  branch afterwards. Both are grandfathered on
                                  purpose — the series keeps working where it
                                  has always been used — so this is the one
                                  place the hazard has to be made visible
                                  rather than prevented. */}
                              {!s.branch_scope_ok && s.branch_scope_note && (
                                <p className="mt-2 rounded-md border border-warning/30 bg-warning-soft/60 px-2.5 py-2 text-xs leading-relaxed text-ink-soft">
                                  <span className="font-semibold text-ink">
                                    {s.is_default
                                      ? "This series cannot number the other branches."
                                      : "This series can only be used at one branch."}
                                  </span>{" "}
                                  {s.branch_scope_note}
                                </p>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                disabled={!isAdmin}
                                title={isAdmin ? undefined : "Admin only"}
                                onClick={() => openEdit(s)}
                              >
                                Edit
                              </Button>
                              {s.series_id && !s.is_default && s.is_active && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={!isAdmin}
                                  busy={busyKey === `default:${s.series_id}`}
                                  onClick={() => void makeDefault(s)}
                                >
                                  Make default
                                </Button>
                              )}
                              {s.series_id && !s.is_default && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  disabled={!isAdmin}
                                  busy={busyKey === `active:${s.series_id}`}
                                  onClick={() => void setActive(s, !s.is_active)}
                                >
                                  {s.is_active ? "Retire" : "Restore"}
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {type.mode === "series" && (
                        <div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={!isAdmin}
                            title={isAdmin ? undefined : "Admin only"}
                            onClick={() => openCreate(type)}
                          >
                            Add a series
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardBody>
          </Card>
        );
      })}

      <Card>
        <CardHeader>
          <h2 className="font-semibold">What the three modes mean</h2>
        </CardHeader>
        <CardBody className="flex flex-col gap-3 text-sm text-ink-soft">
          <p>
            <span className="font-medium text-ink">Automatic.</span> The app numbers every voucher
            of that type from one series. The counter never skips, so the consecutive serial GST
            asks for is guaranteed without anyone thinking about it.
          </p>
          <p>
            <span className="font-medium text-ink">Series.</span> Several named series for the same
            document type, chosen when the voucher is posted — exports separate from domestic
            sales, or one series per counter. Rule 46(b) permits this in as many words: a
            consecutive serial number &ldquo;in one or multiple series&rdquo;.
          </p>
          <p>
            <span className="font-medium text-ink">Manual.</span> You type the number yourself.
            Rule 46(b) still wants that serial to be{" "}
            <span className="font-medium text-ink">consecutive and unique</span> within the
            financial year. The app enforces the unique half — it refuses a number already used for
            that document type this year, and refuses anything over sixteen characters or with a
            character the rule disallows. It cannot enforce the consecutive half. If you jump from
            0007 to 0009, the gap is real and it is yours to explain in a GST scrutiny or an audit.
            Automatic and series numbering leave no gaps.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold">Writing a prefix</h2>
        </CardHeader>
        <CardBody className="flex flex-col gap-3 text-sm text-ink-soft">
          <p>
            A prefix is a template. Five tokens are filled in when the number is drawn, so a series
            keeps working after 1 April without being edited:
          </p>
          <ul className="flex flex-col gap-1 font-mono text-xs text-ink">
            <li>
              {"{BRANCH}"} <span className="font-sans text-ink-soft">branch code, e.g. HO</span>
            </li>
            <li>
              {"{FY}"} <span className="font-sans text-ink-soft">2026-27</span>
            </li>
            <li>
              {"{FYS}"} <span className="font-sans text-ink-soft">26-27</span>
            </li>
            <li>
              {"{YYYY}"} <span className="font-sans text-ink-soft">2026</span>
            </li>
            <li>
              {"{YY}"} <span className="font-sans text-ink-soft">26</span>
            </li>
          </ul>
          <p>
            Everything else is copied through exactly as typed, and only letters, digits, hyphen
            and slash are accepted — those are the only characters Rule 46(b) permits in a document
            number.
          </p>
          <p>
            Editing a prefix or padding takes effect from the next number drawn. Vouchers already
            issued keep the numbers they were issued with, which is the correct outcome: the rule
            binds the number at the moment the document is raised, and rewriting history would be
            the worse mistake.
          </p>
          <p>
            <span className="font-medium text-ink">
              With more than one branch, the prefix must contain {"{BRANCH}"}.
            </span>{" "}
            Each branch counts from 1 independently, so a prefix that is the same everywhere issues
            the same number in every branch — and Rule 46(b) wants a serial number unique for the
            financial year, not unique per branch. If that makes the number too long, drop the
            slashes around the token rather than the token:{" "}
            <span className="font-mono">
              {"{BRANCH}"}SAL/{"{YY}"}/
            </span>{" "}
            with 4 digits gives <span className="font-mono">{branches[0]?.code ?? "HO"}SAL/26/0001</span>. The
            alternative Rule 46(b) also allows is one series per branch, each with its own distinct
            prefix.{" "}
            {!multiBranch &&
              `This company has one branch, so nothing here is restricted — the rule only starts to apply if a second branch is opened.`}
          </p>
        </CardBody>
      </Card>

      <Modal
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={
          editor && (editor.seriesId || editor.synthetic)
            ? `Edit series — ${editor.typeLabel}`
            : `New series — ${editor?.typeLabel ?? ""}`
        }
        description="The preview below is the exact number this series would issue next."
      >
        {editor && (
          <div className="flex flex-col gap-4">
            <Field label="Series name" hint="Only you see this — it names the series, not the number.">
              <Input
                value={editor.name}
                maxLength={40}
                onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                placeholder="Default"
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <Field label="Prefix" hint="Tokens: {BRANCH} {FY} {FYS} {YYYY} {YY}">
                <Input
                  value={editor.prefix}
                  maxLength={40}
                  spellCheck={false}
                  className="font-mono"
                  onChange={(e) => setEditor({ ...editor, prefix: e.target.value })}
                />
              </Field>
              <Field label="Counter digits" hint="1 to 9">
                <Input
                  type="number"
                  min={1}
                  max={9}
                  value={editor.padding}
                  onChange={(e) => setEditor({ ...editor, padding: e.target.value })}
                />
              </Field>
            </div>

            <div className="rounded-lg border border-border bg-surface-2 px-4 py-3">
              <p className="text-xs text-ink-faint">
                Next number at branch {editor.branchCode}, {editor.fyLabel}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <span className="font-mono text-lg text-ink">{editorPreview || "—"}</span>
                <LengthBadge
                  length={editorPreview.length}
                  gstFacing={GST_FACING.has(editor.voucherType)}
                />
              </div>
              <p className="mt-2 text-xs text-ink-soft">
                {editorPreview.length > 16
                  ? multiBranch
                    ? // Never "drop the branch code" here, which is what this
                      // line used to say: with more than one branch that is the
                      // change that makes two branches print the same number.
                      // Losing the slashes around {BRANCH} costs the same two
                      // characters and keeps the branches apart.
                      "Over the sixteen characters CGST Rule 46(b) allows. Shorten the financial year to {FYS} or {YY}, drop the slashes around {BRANCH}, or use fewer counter digits. Keep {BRANCH} itself — with more than one branch it is what stops two of them issuing the same number."
                    : "Over the sixteen characters CGST Rule 46(b) allows. Drop the branch code, shorten the financial year to {FYS} or {YY}, or use fewer counter digits."
                  : "Within the sixteen characters CGST Rule 46(b) allows."}
              </p>
            </div>

            {prefixChanging && !prefixBranchOk && (
              <Alert tone="error">
                <span className="font-semibold">
                  This prefix would give two branches the same number.
                </span>{" "}
                It has no <span className="font-mono">{"{BRANCH}"}</span> token, and this company
                has {branches.length} branches ({branchCodes}). Each branch keeps its own counter,
                so both would start at 1 behind the same text and the next{" "}
                {editor.typeLabel.toLowerCase()} raised in each would carry the identical number.
                CGST Rule 46(b) requires a serial number to be unique for the{" "}
                <span className="font-medium">whole financial year</span>, not per branch. Put{" "}
                <span className="font-mono">{"{BRANCH}"}</span> in the prefix — e.g.{" "}
                <span className="font-mono">
                  {"{BRANCH}"}
                  {editor.prefix.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "SAL"}/
                  {"{YY}"}/
                </span>{" "}
                — or give each branch its own series with its own distinct prefix, which is the
                &ldquo;one or multiple series&rdquo; Rule 46(b) expressly allows.
              </Alert>
            )}

            {prefixChanging && !multiBranch && !prefixNamesTheBranch(editor.prefix) && (
              <p className="text-xs text-ink-faint">
                This prefix has no {"{BRANCH}"} token. That is fine while{" "}
                {branches[0]?.code ?? "this company"} is the only branch — there is one counter, so
                there is nothing to collide with. If a second branch is ever opened, this series
                will need {"{BRANCH}"} adding, or a separate series of its own, before that branch
                can use it.
              </p>
            )}

            {!editorPrefixOk && (
              <Alert tone="error">
                The prefix may only contain letters, digits, hyphen, slash and the tokens{" "}
                {"{BRANCH}"}, {"{FY}"}, {"{FYS}"}, {"{YYYY}"}, {"{YY}"}. Rule 46(b) allows no other
                characters in a document number.
              </Alert>
            )}

            {editorPaddingTooSmall && (
              <Alert tone="error">
                This counter is already at {editor.nextNumber}, which needs at least{" "}
                {String(editor.nextNumber).length} digits. With{" "}
                {Number(editor.padding) || 1} the number would be cut short.
              </Alert>
            )}

            {editor.synthetic && (
              <p className="text-xs text-ink-faint">
                This voucher type has never been raised, so no series exists yet. Saving creates
                the one the app would otherwise have made on the first voucher.
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditor(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                busy={busyKey === "save"}
                disabled={
                  !editorPrefixOk || editorPaddingTooSmall || (prefixChanging && !prefixBranchOk)
                }
                onClick={() => void saveEditor()}
              >
                {editor.seriesId || editor.synthetic ? "Save series" : "Create series"}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={pendingManual !== null}
        onClose={() => setPendingManual(null)}
        title={`Number ${pendingManual?.typeLabel.toLowerCase() ?? ""} vouchers by hand?`}
        description="Worth reading before you switch — this is the one setting here that can put the company out of compliance."
        className="max-w-lg"
      >
        <div className="flex flex-col gap-4 text-sm text-ink-soft">
          <p>
            CGST Rule 46(b) requires a{" "}
            <span className="font-medium text-ink">consecutive serial number</span>, unique within
            the financial year. Typing numbers by hand makes gaps possible, and a gap is exactly
            what a GST officer looks for.
          </p>
          <p>
            The app will still refuse a duplicate, anything longer than sixteen characters, and any
            character the rule disallows. It cannot tell you that 0008 was never issued.
          </p>
          <p className="text-ink-faint">
            Switching mode part-way through a year is also worth avoiding — hand-typed and
            generated numbers then interleave, and the running order stops being a reliable guide
            to what was raised when.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setPendingManual(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              busy={busyKey === `mode:${pendingManual?.voucherType}`}
              onClick={() => {
                const p = pendingManual;
                setPendingManual(null);
                if (p) void applyMode(p.voucherType, "manual");
              }}
            >
              Use manual numbering
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
