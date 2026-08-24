import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardBody } from "@/components/ui/Card";
import { BackupDownloadButton } from "@/components/settings/BackupDownloadButton";

export default async function BackupPage({
  params,
}: PageProps<"/[companyId]/settings/backup">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  const [{ data: company }, { data: membership }] = await Promise.all([
    supabase.from("companies").select("name").eq("id", companyId).maybeSingle(),
    user
      ? supabase
          .from("company_members")
          .select("role, status")
          .eq("company_id", companyId)
          .eq("user_id", user.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const isAdmin = membership?.status === "active" && membership?.role === "admin";

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link
        href={`/${companyId}/settings`}
        className="text-sm text-ink-faint transition-colors hover:text-ink"
      >
        ← Settings
      </Link>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
        Backup &amp; export
      </h1>
      <p className="mt-1.5 max-w-xl text-sm text-ink-soft">
        A complete, structured copy of {company?.name ?? "this company"}&rsquo;s data — every
        ledger, voucher, master and record this app stores for it — as one JSON file you keep
        outside LEKHA. Admin only, since this is a full data export rather than a single report.
      </p>

      <div className="mt-8">
        <Card>
          <CardBody className="flex flex-col gap-4">
            {isAdmin ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-ink">Full company export</p>
                  <p className="text-xs text-ink-faint">
                    Groups, ledgers, branches, GST registrations, items, employees, fixed
                    assets, cost centres, vouchers with their accounting and stock lines,
                    batches, orders, budgets, notices, and document attachment metadata — one
                    JSON file, generated fresh each time you click.
                  </p>
                </div>
                <BackupDownloadButton companyId={companyId} />
              </div>
            ) : (
              <p className="text-sm text-ink-soft">
                Only an active admin of this company can generate a backup. Ask a company admin
                if you need one.
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="mt-8 flex flex-col gap-3 text-xs text-ink-faint">
        <p>
          <strong className="text-ink-soft">Why this exists.</strong> Sec 36 of the CGST Act,
          2017 requires books and records to be retained for 72 months from the due date of
          filing the annual return for the relevant year, and Sec 128 of the Companies Act,
          2013 requires a company&rsquo;s books of account to be kept for the 8 financial years
          immediately preceding the current one. Neither statute mandates a specific export
          format, but both assume the records outlive whatever software produced them — this
          screen is the way to actually get a company&rsquo;s data out of LEKHA to satisfy that.
        </p>
        <p>
          <strong className="text-ink-soft">What&rsquo;s in the file.</strong> Every genuinely
          company-scoped table this app has, as structured JSON keyed by table name — close to
          the underlying database rows, not a display-formatted report, so it could in
          principle be re-imported later (this screen only builds the export; re-import is not
          built). Document attachments are included as metadata and references only (file
          name, type, size, storage path) — the underlying files in Storage are not bundled
          into this JSON and must be downloaded separately if you need the bytes themselves. A
          handful of tables (module activation state, GST/payroll ledger mappings, the audit
          trail, team membership, API keys, and a few other module-specific tables not yet
          covered by this pass) are deliberately left out for now — the file itself lists
          exactly which, so nothing is silently missing without saying so.
        </p>
      </div>
    </main>
  );
}
