import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PrintTemplateForm } from "@/components/settings/PrintTemplateForm";

export default async function PrintTemplatePage({
  params,
}: PageProps<"/[companyId]/settings/print-template">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: company } = await supabase
    .from("companies")
    .select("name, logo_url, print_terms_and_conditions, print_footer_note")
    .eq("id", companyId)
    .maybeSingle();

  // Short-lived signed URL, only for the settings-page preview <img> —
  // the print page and PDF export route never use a signed URL for this;
  // see lib/server/printAssets.ts for why they inline a data: URI instead.
  let logoPreviewUrl: string | null = null;
  if (company?.logo_url) {
    const { data } = await supabase.storage.from("documents").createSignedUrl(company.logo_url, 300);
    logoPreviewUrl = data?.signedUrl ?? null;
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link
        href={`/${companyId}/settings`}
        className="text-sm text-ink-faint transition-colors hover:text-ink"
      >
        ← Settings
      </Link>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
        Print template
      </h1>
      <p className="mt-1.5 max-w-xl text-sm text-ink-soft">
        The logo, terms &amp; conditions and footer note that appear on every invoice, bill,
        credit note and debit note this company prints or exports as a PDF.
      </p>

      <div className="mt-8">
        <PrintTemplateForm
          companyId={companyId}
          logoStoragePath={company?.logo_url ?? null}
          logoPreviewUrl={logoPreviewUrl}
          termsAndConditions={company?.print_terms_and_conditions ?? null}
          footerNote={company?.print_footer_note ?? null}
        />
      </div>

      <p className="mt-8 text-xs text-ink-faint">
        None of this is a statutory requirement — Rule 46 of the CGST Rules, 2017 lists what a
        tax invoice must contain, and a logo, terms block or footer line is not on that list.
        This screen exists only so a printed or exported invoice looks like it came from your
        business.
      </p>
    </main>
  );
}
