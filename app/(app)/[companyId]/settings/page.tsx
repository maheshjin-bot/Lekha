import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { CompanySettingsForm } from "@/components/companies/CompanySettingsForm";
import { DocumentAttachments } from "@/components/documents/DocumentAttachments";

export default async function SettingsPage({
  params,
}: PageProps<"/[companyId]/settings">) {
  const { companyId } = await params;
  const supabase = await createClient();

  // The GSTINs are read only so the PAN section can name, up front, what a PAN
  // change would contradict: app_private.enforce_company_pan_matches_
  // registrations (1360) refuses one that does, and being told which
  // registration is in the way beats finding out on the round trip.
  const [{ data: company }, { data: docs }, { data: registrations }] = await Promise.all([
    supabase
      .from("companies")
      .select(
        "id, name, pan, tan, cin, iec, udyam_number, udyam_category, entity_type, company_tax_regime, is_professional, stock_margin_percent, debtor_margin_percent, debtor_eligibility_days, password_protected, upi_vpa"
      )
      .eq("id", companyId)
      .maybeSingle(),
    // The incorporation certificate, a lease deed, a board resolution — filed
    // once against the company itself rather than any one voucher or asset.
    // DocumentAttachments (0060) was already built entity-generic for this
    // exact call site; nothing wired it in until now.
    supabase
      .from("documents")
      .select("id, storage_path, file_name, mime_type, size_bytes, created_at")
      .eq("company_id", companyId)
      .eq("entity_type", "company")
      .eq("entity_id", companyId),
    supabase.from("gst_registrations").select("gstin").eq("company_id", companyId),
  ]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Settings</h1>
      <p className="mt-1.5 max-w-xl text-sm text-ink-soft">
        Admin only. What this company is registered as, in the numbers every
        statutory output is filed under.
      </p>

      <CompanySettingsForm
        companyId={companyId}
        entityType={company?.entity_type ?? ""}
        pan={company?.pan ?? null}
        tan={company?.tan ?? null}
        cin={company?.cin ?? null}
        iec={company?.iec ?? null}
        registeredGstins={(registrations ?? []).map((r) => r.gstin)}
        udyamNumber={company?.udyam_number ?? null}
        udyamCategory={company?.udyam_category ?? null}
        companyTaxRegime={company?.company_tax_regime ?? "default_30"}
        isProfessional={company?.is_professional ?? false}
        stockMarginPercent={Number(company?.stock_margin_percent ?? 25)}
        debtorMarginPercent={Number(company?.debtor_margin_percent ?? 40)}
        debtorEligibilityDays={Number(company?.debtor_eligibility_days ?? 90)}
        passwordProtected={company?.password_protected ?? false}
        upiVpa={company?.upi_vpa ?? null}
      />

      <Link
        href={`/${companyId}/settings/modules`}
        className="mt-8 flex items-center justify-between rounded-lg border border-border bg-surface p-5 transition-colors hover:bg-surface-2"
      >
        <span>
          <span className="block font-semibold text-ink">Modules</span>
          <span className="mt-0.5 block text-sm text-ink-soft">
            What this company runs — core, conditional and optional, one screen.
          </span>
        </span>
        <span aria-hidden className="text-ink-faint">→</span>
      </Link>

      <Link
        href={`/${companyId}/settings/numbering`}
        className="mt-3 flex items-center justify-between rounded-lg border border-border bg-surface p-5 transition-colors hover:bg-surface-2"
      >
        <span>
          <span className="block font-semibold text-ink">Voucher numbering</span>
          <span className="mt-0.5 block text-sm text-ink-soft">
            Prefix, counter digits and numbering mode per document type — and whether
            the numbers fit the sixteen characters CGST Rule 46(b) allows.
          </span>
        </span>
        <span aria-hidden className="text-ink-faint">→</span>
      </Link>

      {/* Reachable from Settings rather than the nav rail: components/nav/
          NavRail.tsx is owned by a concurrent session and must not be edited
          here. This card is what makes the screen findable at all today —
          the integration pass should add a proper nav entry. */}
      <Link
        href={`/${companyId}/error-log`}
        className="mt-3 flex items-center justify-between rounded-lg border border-border bg-surface p-5 transition-colors hover:bg-surface-2"
      >
        <span>
          <span className="block font-semibold text-ink">Error log</span>
          <span className="mt-0.5 block text-sm text-ink-soft">
            When something in the app did not work — what went wrong, in plain language,
            and what to do about it.
          </span>
        </span>
        <span aria-hidden className="text-ink-faint">&rarr;</span>
      </Link>

      <Link
        href={`/${companyId}/settings/team`}
        className="mt-3 flex items-center justify-between rounded-lg border border-border bg-surface p-5 transition-colors hover:bg-surface-2"
      >
        <span>
          <span className="block font-semibold text-ink">Team</span>
          <span className="mt-0.5 block text-sm text-ink-soft">
            Who has access, invite a colleague by email, and what role they get.
          </span>
        </span>
        <span aria-hidden className="text-ink-faint">→</span>
      </Link>

      <div className="mt-8">
        <h2 className="font-display text-lg font-semibold tracking-tight text-ink">
          Company documents
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Filed against the company itself — the incorporation certificate,
          a lease deed, a board resolution — rather than any one voucher or
          asset.
        </p>
        <div className="mt-3">
          <DocumentAttachments
            companyId={companyId}
            entityType="company"
            entityId={companyId}
            docs={docs ?? []}
          />
        </div>
      </div>
    </main>
  );
}
