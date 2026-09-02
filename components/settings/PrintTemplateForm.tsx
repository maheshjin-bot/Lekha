"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { RadioPillGroup } from "@/components/ui/RadioPillGroup";
import {
  COMPOSITION_DECLARATION,
  InvoiceDesignPreview,
  type PreviewState,
} from "@/components/settings/InvoiceDesignPreview";

// Mirrors the "documents" bucket's own allowed_mime_types (0060) minus PDF —
// a logo has to be a raster image, not a document. Not SVG either: the
// bucket's own allow-list doesn't include it, and an unsanitised SVG
// uploaded by a user is a real XSS vector if it were ever rendered directly
// rather than downloaded server-side and re-embedded as a data: URI (which
// is what this app does — see lib/server/printAssets.ts — so the risk is
// moot here, but the bucket-level restriction is the actual gate and it
// simply doesn't allow SVG).
const ALLOWED_LOGO_MIME = ["image/png", "image/jpeg", "image/webp"];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_TERMS_LEN = 4000;
const MAX_FOOTER_LEN = 1000;
const MAX_DECLARATION_LEN = 1000;

// Client-side twins of the CHECK constraints migration 0800 puts on these
// columns. Same role UPI_VPA_PATTERN plays in CompanySettingsForm: this is a
// courtesy so the user sees the problem next to the field instead of as a
// raw Postgres 23514 in a toast. The database constraint is the real gate.
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9]{5,34}$/;

/**
 * A standard declaration most Indian invoices carry. Offered as a one-click
 * fill rather than a default value: it is NOT a statutory particular (Rule 46
 * neither requires nor forbids it), so pre-filling it into every company's
 * row would be putting words in their mouth.
 */
const SUGGESTED_DECLARATION =
  "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.";

const ACCENT_PRESETS = ["#1F3A5F", "#0F766E", "#7C2D12", "#4C1D95", "#111111"];

export type PrintTemplateSettings = {
  logo_url: string | null;
  print_terms_and_conditions: string | null;
  print_footer_note: string | null;
  print_accent_color: string | null;
  print_paper_size: string;
  print_sales_title: string;
  print_composition_declaration: boolean;
  print_copy_labels: string;
  print_declaration_text: string | null;
  print_signatory_name: string | null;
  print_signatory_designation: string | null;
  print_bank_account_name: string | null;
  print_bank_name: string | null;
  print_bank_branch: string | null;
  print_bank_account_number: string | null;
  print_bank_ifsc: string | null;
  print_show_upi_qr: boolean;
};

export function PrintTemplateForm({
  companyId,
  companyName,
  upiVpa,
  isComposition,
  isAdmin,
  logoPreviewUrl,
  settings,
}: {
  companyId: string;
  companyName: string;
  upiVpa: string | null;
  /** True when this company holds an ACTIVE composition GST registration. */
  isComposition: boolean;
  isAdmin: boolean;
  logoPreviewUrl: string | null;
  settings: PrintTemplateSettings;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [storagePath, setStoragePath] = useState(settings.logo_url);
  const [previewUrl, setPreviewUrl] = useState(logoPreviewUrl);
  const [busyLogo, setBusyLogo] = useState(false);
  const [busySave, setBusySave] = useState(false);

  const [s, setS] = useState<PreviewState>({
    accentColor: settings.print_accent_color,
    paperSize: settings.print_paper_size,
    salesTitle: settings.print_sales_title,
    compositionDeclaration: settings.print_composition_declaration,
    copyLabels: settings.print_copy_labels,
    declarationText: settings.print_declaration_text ?? "",
    signatoryName: settings.print_signatory_name ?? "",
    signatoryDesignation: settings.print_signatory_designation ?? "",
    bankAccountName: settings.print_bank_account_name ?? "",
    bankName: settings.print_bank_name ?? "",
    bankBranch: settings.print_bank_branch ?? "",
    bankAccountNumber: settings.print_bank_account_number ?? "",
    bankIfsc: settings.print_bank_ifsc ?? "",
    showUpiQr: settings.print_show_upi_qr,
    termsAndConditions: settings.print_terms_and_conditions ?? "",
    footerNote: settings.print_footer_note ?? "",
  });

  const set = <K extends keyof PreviewState>(key: K, value: PreviewState[K]) =>
    setS((prev) => ({ ...prev, [key]: value }));

  const accountNumber = s.bankAccountNumber.trim();
  const bankErrors: string[] = [];
  if (accountNumber && !ACCOUNT_PATTERN.test(accountNumber)) {
    bankErrors.push("Account number must be 5–34 letters or digits, no spaces.");
  }
  if (accountNumber && !s.bankName.trim()) {
    bankErrors.push("A bank name is required once an account number is set.");
  }
  if (accountNumber && !IFSC_PATTERN.test(s.bankIfsc.trim().toUpperCase())) {
    bankErrors.push("A valid IFSC (e.g. HDFC0000123) is required once an account number is set.");
  }
  if (
    !accountNumber &&
    (s.bankName.trim() || s.bankBranch.trim() || s.bankIfsc.trim() || s.bankAccountName.trim())
  ) {
    bankErrors.push(
      "Enter an account number, or clear the other bank fields — a payment block without an account number cannot be printed."
    );
  }
  const accentInvalid = s.accentColor !== null && !HEX_COLOR.test(s.accentColor);
  const canSave = isAdmin && bankErrors.length === 0 && !accentInvalid;

  async function uploadLogo(file: File) {
    if (!ALLOWED_LOGO_MIME.includes(file.type)) {
      toast.error("Logo must be a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error("Logo must be under 2 MB.");
      return;
    }

    setBusyLogo(true);
    const client = createClient();
    // Path is the tenancy boundary storage RLS actually checks (0060's
    // documents_bucket_* policies read only the first folder segment) — the
    // "company-logo" segment is just a label, any value here is equally
    // valid against RLS, but this one keeps a company's logo files visually
    // grouped from Notices/other attachments landing in the same bucket.
    const path = `${companyId}/company-logo/${crypto.randomUUID()}-${file.name}`;

    const { error: uploadError } = await client.storage.from("documents").upload(path, file, {
      contentType: file.type,
    });
    if (uploadError) {
      setBusyLogo(false);
      toast.error(uploadError.message);
      return;
    }

    const { error: updateError } = await client
      .from("companies")
      .update({ logo_url: path })
      .eq("id", companyId);
    if (updateError) {
      // Row update failed — clean up the orphaned object rather than leave
      // it sitting in the bucket with nothing pointing at it (same
      // discipline DocumentAttachments.tsx already uses).
      await client.storage.from("documents").remove([path]);
      setBusyLogo(false);
      toast.error(updateError.message);
      return;
    }

    // Only remove the OLD file after the new one is confirmed live in the
    // row — so a mid-upload failure never leaves the company with no logo
    // file at all.
    if (storagePath) {
      await client.storage.from("documents").remove([storagePath]);
    }

    setStoragePath(path);
    setPreviewUrl(URL.createObjectURL(file));
    setBusyLogo(false);
    if (fileInput.current) fileInput.current.value = "";
    toast.success("Logo updated.");
    router.refresh();
  }

  async function removeLogo() {
    if (!storagePath) return;
    setBusyLogo(true);
    const client = createClient();

    const { error } = await client.from("companies").update({ logo_url: null }).eq("id", companyId);
    if (error) {
      setBusyLogo(false);
      toast.error(error.message);
      return;
    }
    await client.storage.from("documents").remove([storagePath]);

    setStoragePath(null);
    setPreviewUrl(null);
    setBusyLogo(false);
    toast.success("Logo removed.");
    router.refresh();
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusySave(true);
    const client = createClient();

    const trimmed = (v: string) => v.trim() || null;
    const payload = {
      print_terms_and_conditions: trimmed(s.termsAndConditions),
      print_footer_note: trimmed(s.footerNote),
      print_accent_color: s.accentColor,
      print_paper_size: s.paperSize,
      print_sales_title: s.salesTitle,
      print_composition_declaration: s.compositionDeclaration,
      print_copy_labels: s.copyLabels,
      print_declaration_text: trimmed(s.declarationText),
      print_signatory_name: trimmed(s.signatoryName),
      print_signatory_designation: trimmed(s.signatoryDesignation),
      // The bank block is anchored on the account number by
      // companies_print_bank_block_anchored (0800): with no account number
      // every other bank field must go back to NULL, so clearing the anchor
      // clears the block rather than leaving orphaned fragments the database
      // would reject anyway.
      print_bank_account_name: accountNumber ? trimmed(s.bankAccountName) : null,
      print_bank_name: accountNumber ? trimmed(s.bankName) : null,
      print_bank_branch: accountNumber ? trimmed(s.bankBranch) : null,
      print_bank_account_number: accountNumber || null,
      print_bank_ifsc: accountNumber ? s.bankIfsc.trim().toUpperCase() : null,
      print_show_upi_qr: s.showUpiQr,
    };

    const { error } = await client
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- types/database.types.ts is owned by the integration pass and does not know migration 0800's columns yet; the row shape is verified live against information_schema.
      .from("companies" as any)
      .update(payload)
      .eq("id", companyId);

    setBusySave(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Invoice design saved.");
    router.refresh();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <form onSubmit={onSave} className="flex min-w-0 flex-col gap-5">
        {!isAdmin && (
          <Alert tone="warning">
            You can see this company&rsquo;s invoice design, but only an admin can change it.
          </Alert>
        )}

        {/* ---------------------------------------------------------- Look */}
        <Card>
          <CardHeader>
            <h2 className="font-semibold text-ink">Logo &amp; look</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              What the document looks like before anyone reads a word of it.
            </p>
          </CardHeader>
          <CardBody className="flex flex-col gap-5">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed border-border-strong bg-surface-2">
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed/blob preview URL, not a static asset Next's <Image> can optimise.
                  <img
                    src={previewUrl}
                    alt="Company logo"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <span className="text-[10px] text-ink-faint">No logo</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label
                  className={`inline-flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2 text-xs text-ink-soft ${
                    isAdmin ? "cursor-pointer hover:bg-surface-2" : "cursor-not-allowed opacity-50"
                  }`}
                >
                  {busyLogo ? "Uploading…" : storagePath ? "Replace logo" : "Upload logo"}
                  <input
                    ref={fileInput}
                    type="file"
                    accept={ALLOWED_LOGO_MIME.join(",")}
                    disabled={busyLogo || !isAdmin}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadLogo(file);
                    }}
                    className="sr-only"
                  />
                </label>
                {storagePath && isAdmin && (
                  <button
                    type="button"
                    disabled={busyLogo}
                    onClick={removeLogo}
                    className="text-xs text-error underline underline-offset-2 disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
                <span className="text-[11px] text-ink-faint">PNG, JPEG or WebP, up to 2 MB.</span>
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-sm font-medium text-ink">Accent colour</div>
              <div className="flex flex-wrap items-center gap-2">
                {ACCENT_PRESETS.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    disabled={!isAdmin}
                    aria-label={`Use accent ${hex}`}
                    aria-pressed={s.accentColor?.toUpperCase() === hex}
                    onClick={() => set("accentColor", hex)}
                    style={{ backgroundColor: hex }}
                    className={`h-7 w-7 rounded-full border-2 transition-transform disabled:opacity-50 ${
                      s.accentColor?.toUpperCase() === hex
                        ? "scale-110 border-ink"
                        : "border-transparent"
                    }`}
                  />
                ))}
                <input
                  type="color"
                  disabled={!isAdmin}
                  value={s.accentColor ?? "#111111"}
                  onChange={(e) => set("accentColor", e.target.value.toUpperCase())}
                  aria-label="Custom accent colour"
                  className="h-7 w-10 cursor-pointer rounded border border-border-strong bg-surface disabled:opacity-50"
                />
                <button
                  type="button"
                  disabled={!isAdmin || s.accentColor === null}
                  onClick={() => set("accentColor", null)}
                  className="text-xs text-ink-soft underline underline-offset-2 disabled:opacity-40"
                >
                  No accent
                </button>
              </div>
              <p className="mt-1.5 text-xs text-ink-faint">
                Used for the header rule, the item-table head and the total row.{" "}
                {s.accentColor === null
                  ? "Currently plain black-on-white, exactly as the invoice prints today."
                  : s.accentColor}
              </p>
            </div>

            <Field
              label="Paper size"
              hint="Applies to the browser print dialog and the PDF download alike."
            >
              <fieldset disabled={!isAdmin} className="min-w-0 border-0 p-0">
                <RadioPillGroup
                  name="paper-size"
                  value={s.paperSize}
                  onChange={(v) => isAdmin && set("paperSize", v)}
                  options={[
                    { value: "a4", label: "A4", description: "210 × 297 mm — the Indian standard." },
                    {
                      value: "letter",
                      label: "Letter",
                      description: "216 × 279 mm — for customers who file in US paper.",
                    },
                  ]}
                />
              </fieldset>
            </Field>
          </CardBody>
        </Card>

        {/* ------------------------------------------- What it calls itself */}
        <Card>
          <CardHeader>
            <h2 className="font-semibold text-ink">What the document calls itself</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Not a style choice. Section 31(3)(c) of the CGST Act and Rule 49 decide which of
              these names is correct for what you sell.
            </p>
          </CardHeader>
          <CardBody className="flex flex-col gap-5">
            {isComposition && s.salesTitle !== "bill_of_supply" && (
              <Alert tone="warning">
                This company holds an active <strong>composition</strong> GST registration. A
                composition taxable person may not issue a tax invoice — Section 31(3)(c) with
                Rule 49 requires a <strong>Bill of Supply</strong>, and Rule 5(1)(f) requires the
                declaration below on it.
              </Alert>
            )}

            <Field label="Title on a sales document">
              <fieldset disabled={!isAdmin} className="min-w-0 border-0 p-0">
                <RadioPillGroup
                  name="sales-title"
                  value={s.salesTitle}
                  onChange={(v) => isAdmin && set("salesTitle", v)}
                  options={[
                    {
                      value: "auto",
                      label: "Leave as it is",
                      description: "Prints “Tax Invoice”, the same as today.",
                    },
                    {
                      value: "tax_invoice",
                      label: "Tax Invoice",
                      description: "A taxable supply by a regular registered supplier.",
                    },
                    {
                      value: "bill_of_supply",
                      label: "Bill of Supply",
                      description:
                        "Required for a composition dealer, or for wholly exempt supplies — Sec 31(3)(c) with Rule 49.",
                    },
                    {
                      value: "invoice_cum_bill_of_supply",
                      label: "Invoice-cum-Bill of Supply",
                      description:
                        "Rule 46A — one document for a mix of taxable and exempt supplies to an unregistered (B2C) customer.",
                    },
                    {
                      value: "invoice",
                      label: "Invoice",
                      description: "For a business outside GST, keeping books only.",
                    },
                  ]}
                />
              </fieldset>
            </Field>

            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border-strong p-3">
              <input
                type="checkbox"
                checked={s.compositionDeclaration}
                disabled={!isAdmin}
                onChange={(e) => set("compositionDeclaration", e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block text-sm font-medium text-ink">
                  Print the composition declaration at the top
                </span>
                <span className="mt-0.5 block text-xs text-ink-soft">
                  “{COMPOSITION_DECLARATION}” — Rule 5(1)(f) of the CGST Rules requires these exact
                  words at the top of every bill of supply a composition taxable person issues.
                </span>
              </span>
            </label>

            <Field
              label="Copy markings"
              hint="Rule 48(6): these fall away automatically on any document registered as an e-invoice, so a document carrying an IRN prints once, unmarked, whatever is set here."
            >
              <fieldset disabled={!isAdmin} className="min-w-0 border-0 p-0">
                <RadioPillGroup
                  name="copy-labels"
                  value={s.copyLabels}
                  onChange={(v) => isAdmin && set("copyLabels", v)}
                  options={[
                    {
                      value: "none",
                      label: "One copy, unmarked",
                      description: "What prints today.",
                    },
                    {
                      value: "goods",
                      label: "Goods — three copies",
                      description:
                        "Rule 48(1): Original for Recipient, Duplicate for Transporter, Triplicate for Supplier.",
                    },
                    {
                      value: "services",
                      label: "Services — two copies",
                      description:
                        "Rule 48(2): Original for Recipient, Duplicate for Supplier. The second copy is yours, not the transporter’s.",
                    },
                  ]}
                />
              </fieldset>
            </Field>
          </CardBody>
        </Card>

        {/* ----------------------------------------------------- Signature */}
        <Card>
          <CardHeader>
            <h2 className="font-semibold text-ink">Declaration &amp; signatory</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Rule 46(q) requires the signature of the supplier or an authorised representative on
              a printed invoice. The document already draws the signature rule — this names the
              person on it.
            </p>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            <div>
              <Field label="Declaration printed above the signature">
                <Textarea
                  value={s.declarationText}
                  disabled={!isAdmin}
                  rows={3}
                  maxLength={MAX_DECLARATION_LEN}
                  placeholder={SUGGESTED_DECLARATION}
                  onChange={(e) =>
                    set("declarationText", e.target.value.slice(0, MAX_DECLARATION_LEN))
                  }
                />
              </Field>
              <div className="mt-1 flex items-center justify-between">
                <button
                  type="button"
                  disabled={!isAdmin}
                  onClick={() => set("declarationText", SUGGESTED_DECLARATION)}
                  className="text-xs text-accent underline underline-offset-2 disabled:opacity-40"
                >
                  Use the standard wording
                </button>
                <span className="text-[10px] text-ink-faint">
                  {s.declarationText.length}/{MAX_DECLARATION_LEN}
                </span>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Authorised signatory" hint="Leave blank to print the rule alone.">
                <Input
                  value={s.signatoryName}
                  disabled={!isAdmin}
                  maxLength={120}
                  placeholder="e.g. Rakesh Sharma"
                  onChange={(e) => set("signatoryName", e.target.value)}
                />
              </Field>
              <Field label="Designation">
                <Input
                  value={s.signatoryDesignation}
                  disabled={!isAdmin || !s.signatoryName.trim()}
                  maxLength={120}
                  placeholder="e.g. Proprietor"
                  onChange={(e) => set("signatoryDesignation", e.target.value)}
                />
              </Field>
            </div>
          </CardBody>
        </Card>

        {/* ------------------------------------------------------- Payment */}
        <Card>
          <CardHeader>
            <h2 className="font-semibold text-ink">How customers pay you</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Printed as a payment block under the totals. Free text, not one of your bank ledgers
              — a ledger stores no account number or IFSC, and most businesses collect into one
              designated account whatever their books look like.
            </p>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            {bankErrors.length > 0 && (
              <Alert tone="error">
                {bankErrors.map((msg) => (
                  <span key={msg} className="block">
                    {msg}
                  </span>
                ))}
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Account number"
                hint="Clearing this removes the whole payment block."
                className="sm:col-span-2"
              >
                <Input
                  value={s.bankAccountNumber}
                  disabled={!isAdmin}
                  maxLength={34}
                  inputMode="numeric"
                  placeholder="e.g. 50100123456789"
                  onChange={(e) => set("bankAccountNumber", e.target.value.replace(/\s/g, ""))}
                />
              </Field>
              <Field label="Bank">
                <Input
                  value={s.bankName}
                  disabled={!isAdmin}
                  maxLength={120}
                  placeholder="e.g. HDFC Bank"
                  onChange={(e) => set("bankName", e.target.value)}
                />
              </Field>
              <Field label="IFSC">
                <Input
                  value={s.bankIfsc}
                  disabled={!isAdmin}
                  maxLength={11}
                  placeholder="e.g. HDFC0000123"
                  onChange={(e) => set("bankIfsc", e.target.value.toUpperCase())}
                  className="font-mono"
                />
              </Field>
              <Field label="Branch" hint="Optional.">
                <Input
                  value={s.bankBranch}
                  disabled={!isAdmin}
                  maxLength={120}
                  placeholder="e.g. Ring Road, Surat"
                  onChange={(e) => set("bankBranch", e.target.value)}
                />
              </Field>
              <Field
                label="Account name"
                hint="Optional — only if the beneficiary name differs from the company name."
              >
                <Input
                  value={s.bankAccountName}
                  disabled={!isAdmin}
                  maxLength={200}
                  placeholder={companyName}
                  onChange={(e) => set("bankAccountName", e.target.value)}
                />
              </Field>
            </div>

            <label
              className={`flex items-start gap-3 rounded-lg border border-border-strong p-3 ${
                upiVpa ? "cursor-pointer" : "opacity-60"
              }`}
            >
              <input
                type="checkbox"
                checked={s.showUpiQr}
                disabled={!isAdmin}
                onChange={(e) => set("showUpiQr", e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block text-sm font-medium text-ink">Print the UPI payment QR</span>
                <span className="mt-0.5 block text-xs text-ink-soft">
                  {upiVpa ? (
                    <>
                      Scannable for the balance still outstanding on the invoice, paying{" "}
                      <span className="font-mono">{upiVpa}</span>. Shown on sales invoices only,
                      and only while money is still owed.
                    </>
                  ) : (
                    <>
                      No UPI ID is set for this company yet, so nothing prints either way. Add one
                      under{" "}
                      <Link href={`/${companyId}/settings`} className="underline">
                        Settings
                      </Link>
                      , in the &ldquo;UPI payment QR&rdquo; section.
                    </>
                  )}
                </span>
              </span>
            </label>
          </CardBody>
        </Card>

        {/* --------------------------------------------- Terms &amp; footer */}
        <Card>
          <CardHeader>
            <h2 className="font-semibold text-ink">Fine print</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Neither block is a statutory particular — Rule 46 neither requires nor forbids them.
            </p>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            <div>
              <Field
                label="Terms &amp; conditions"
                hint="Printed below the total — return policy, jurisdiction, whatever standard fine print this business always attaches."
              >
                <Textarea
                  value={s.termsAndConditions}
                  disabled={!isAdmin}
                  rows={4}
                  maxLength={MAX_TERMS_LEN}
                  placeholder="e.g. Goods once sold will not be taken back. Subject to Ahmedabad jurisdiction."
                  onChange={(e) =>
                    set("termsAndConditions", e.target.value.slice(0, MAX_TERMS_LEN))
                  }
                />
              </Field>
              <div className="mt-1 text-right text-[10px] text-ink-faint">
                {s.termsAndConditions.length}/{MAX_TERMS_LEN}
              </div>
            </div>

            <div>
              <Field label="Footer note" hint="One short line at the very bottom of the page.">
                <Input
                  value={s.footerNote}
                  disabled={!isAdmin}
                  maxLength={MAX_FOOTER_LEN}
                  placeholder="e.g. Thank you for your business."
                  onChange={(e) => set("footerNote", e.target.value.slice(0, MAX_FOOTER_LEN))}
                />
              </Field>
              <div className="mt-1 text-right text-[10px] text-ink-faint">
                {s.footerNote.length}/{MAX_FOOTER_LEN}
              </div>
            </div>
          </CardBody>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" busy={busySave} busyLabel="Saving…" disabled={!canSave}>
            Save invoice design
          </Button>
          {!canSave && isAdmin && (
            <span className="text-xs text-ink-faint">Fix the highlighted fields to save.</span>
          )}
        </div>
      </form>

      <div className="lg:sticky lg:top-6 lg:self-start">
        <InvoiceDesignPreview
          companyName={companyName}
          upiVpa={upiVpa}
          logoPreviewUrl={previewUrl}
          state={s}
        />
      </div>
    </div>
  );
}
