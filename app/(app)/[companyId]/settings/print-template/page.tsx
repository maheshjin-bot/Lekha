import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Alert } from "@/components/ui/Alert";
import {
  PrintTemplateForm,
  type PrintTemplateSettings,
} from "@/components/settings/PrintTemplateForm";

const SETTINGS_COLUMNS = [
  "name",
  "legal_name",
  "upi_vpa",
  "logo_url",
  "print_terms_and_conditions",
  "print_footer_note",
  "print_accent_color",
  "print_paper_size",
  "print_sales_title",
  "print_composition_declaration",
  "print_copy_labels",
  "print_declaration_text",
  "print_signatory_name",
  "print_signatory_designation",
  "print_bank_account_name",
  "print_bank_name",
  "print_bank_branch",
  "print_bank_account_number",
  "print_bank_ifsc",
  "print_show_upi_qr",
].join(", ");

type CompanyRow = PrintTemplateSettings & {
  name: string | null;
  legal_name: string | null;
  upi_vpa: string | null;
};

export default async function PrintTemplatePage({
  params,
}: PageProps<"/[companyId]/settings/print-template">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: companyRaw }, { data: registrations }, { data: membership }] = await Promise.all([
    supabase
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- types/database.types.ts is owned by the integration pass and does not know migration 0800's columns yet; the row shape is verified live against information_schema.
      .from("companies" as any)
      .select(SETTINGS_COLUMNS)
      .eq("id", companyId)
      .maybeSingle(),
    // Whether a composition registration is live decides which document name
    // is legally correct (Sec 31(3)(c) with Rule 49), so the form warns on it
    // rather than letting a composition dealer quietly keep printing
    // "Tax Invoice".
    supabase
      .from("gst_registrations")
      .select("registration_type, is_active")
      .eq("company_id", companyId),
    supabase.from("company_members").select("role").eq("company_id", companyId),
  ]);

  const company = companyRaw as unknown as CompanyRow | null;
  const isComposition = (registrations ?? []).some(
    (r) => r.is_active && r.registration_type === "composition"
  );
  // companies_update is app_private.is_company_admin-gated (0003), so a
  // non-admin's save would fail at the database anyway. Reading the role here
  // turns that into a disabled form and one honest sentence instead of a
  // silent no-op followed by an RLS error toast.
  const isAdmin = (membership?.[0]?.role ?? null) === "admin";

  // Short-lived signed URL, only for this screen's preview <img> — the print
  // page and PDF export route never use a signed URL for the logo; see
  // lib/server/printAssets.ts for why they inline a data: URI instead.
  let logoPreviewUrl: string | null = null;
  if (company?.logo_url) {
    const { data } = await supabase.storage.from("documents").createSignedUrl(company.logo_url, 300);
    logoPreviewUrl = data?.signedUrl ?? null;
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href={`/${companyId}/settings`}
        className="text-sm text-ink-faint transition-colors hover:text-ink"
      >
        ← Settings
      </Link>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
        Invoice design
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        How every invoice, bill, credit note and debit note this company prints or exports as a PDF
        presents itself — its logo and accent, the paper it prints on, what the document calls
        itself, who signs it, and how customers are told to pay.
      </p>

      {!company ? (
        <Alert tone="error" className="mt-8">
          This company could not be loaded.
        </Alert>
      ) : (
        <div className="mt-8">
          <PrintTemplateForm
            companyId={companyId}
            companyName={company.legal_name || company.name || "Your company"}
            upiVpa={company.upi_vpa}
            isComposition={isComposition}
            isAdmin={isAdmin}
            logoPreviewUrl={logoPreviewUrl}
            settings={company}
          />
        </div>
      )}

      <p className="mt-8 max-w-3xl text-xs text-ink-faint">
        Most of this is presentation, not law. Two things on this screen are not: what the document
        calls itself (Section 31(3)(c) of the CGST Act with Rules 49 and 46A — a composition dealer
        or a wholly exempt supply must say <em>Bill of Supply</em>, never <em>Tax Invoice</em>), and
        the copy markings (Rule 48(1) and 48(2), which Rule 48(6) switches off for an e-invoice).
        The particulars Rule 46 actually mandates — both GSTINs, place of supply, HSN, the
        rate-wise tax break-up, the reverse-charge indicator — are printed by the document itself
        and are deliberately not switchable here.
      </p>
    </main>
  );
}
