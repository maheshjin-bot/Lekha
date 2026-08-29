import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Alert } from "@/components/ui/Alert";
import {
  NumberingSettings,
  type BranchOption,
  type NumberingRow,
} from "@/components/settings/NumberingSettings";

export default async function NumberingSettingsPage({
  params,
}: PageProps<"/[companyId]/settings/numbering">) {
  const { companyId } = await params;
  const supabase = await createClient();

  // get_voucher_numbering_settings is brand new (migration 0725) and
  // types/database.types.ts — owned by the integration pass, not regenerated
  // by this task — doesn't know it yet, hence the disabled rule below. Purely
  // a compile-time typing gap; the row shape is verified live against the
  // function's own return table (see the structured report).
  const [{ data: rows, error: rowsError }, { data: branches }, { data: membership }] =
    await Promise.all([
      supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
        .rpc("get_voucher_numbering_settings" as any, { p_company_id: companyId }),
      supabase.from("branches").select("id, code, name").eq("company_id", companyId).order("code"),
      supabase.from("company_members").select("role").eq("company_id", companyId),
    ]);

  const isAdmin = (membership?.[0]?.role ?? null) === "admin";
  const numberingRows = (rows ?? []) as unknown as NumberingRow[];
  const branchOptions = (branches ?? []) as BranchOption[];

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href={`/${companyId}/settings`}
        className="text-sm text-ink-faint transition-colors hover:text-ink"
      >
        ← Settings
      </Link>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
        Voucher numbering
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        The shape of the number on every invoice, note, receipt and challan this company raises —
        its prefix, how many digits the counter runs to, and whether the app numbers a document or
        you type the number in yourself.
        {!isAdmin && " You can view this, but only an admin can change it."}
      </p>

      {rowsError ? (
        <Alert tone="error" className="mt-8">
          {rowsError.message}
        </Alert>
      ) : numberingRows.length === 0 ? (
        <Alert tone="warning" className="mt-8">
          Nothing to show — this company has no branch yet, and a voucher number can&rsquo;t be
          previewed without one.
        </Alert>
      ) : (
        <NumberingSettings
          companyId={companyId}
          branches={branchOptions}
          initialRows={numberingRows}
          isAdmin={isAdmin}
        />
      )}

      <p className="mt-8 text-xs text-ink-faint">
        Changing a series here never renumbers a voucher that has already been raised. CGST Rule
        46(b) binds the serial number at the moment the document is issued, so the numbers already
        printed and filed stay exactly as they were; a new format applies from the next voucher
        onwards, which the rule expressly allows by permitting a serial &ldquo;in one or multiple
        series&rdquo;.
      </p>
    </main>
  );
}
