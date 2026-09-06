import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { TaxLedgerMapRepair } from "@/components/gst/TaxLedgerMapRepair";

export default async function TaxLedgersPage({
  params,
}: PageProps<"/[companyId]/registrations/tax-ledgers">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: registrations }, { data: mapped }, { data: membership }] =
    await Promise.all([
      supabase
        .from("gst_registrations")
        .select("id, gstin, state_code, is_active")
        .eq("company_id", companyId)
        .order("registered_from"),
      // The ledger name comes through the FK so the screen can show what a
      // purpose actually resolves to, not just that it resolves.
      supabase
        .from("tax_ledger_map")
        .select("gst_registration_id, purpose, ledgers(name)")
        .eq("company_id", companyId)
        .not("gst_registration_id", "is", null),
      supabase.from("company_members").select("role").eq("company_id", companyId),
    ]);

  const isAdmin = (membership?.[0]?.role ?? null) === "admin";

  const mappedRows = (mapped ?? []).map((m) => ({
    gst_registration_id: m.gst_registration_id,
    purpose: m.purpose,
    ledger_name:
      (m.ledgers as { name: string } | { name: string }[] | null) === null
        ? "—"
        : Array.isArray(m.ledgers)
          ? (m.ledgers[0]?.name ?? "—")
          : m.ledgers.name,
  }));

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link
        href={`/${companyId}/registrations`}
        className="text-sm text-ink-faint transition-colors hover:text-ink"
      >
        ← Registrations
      </Link>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
        Tax ledgers
      </h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-soft">
        Which ledger each GST amount posts to, per GSTIN. These are created for you
        when a registration is added — this screen is here for when one is missing,
        because an invoice cannot be saved at all while a purpose it needs has
        nowhere to post.
      </p>

      <TaxLedgerMapRepair
        companyId={companyId}
        registrations={registrations ?? []}
        mapped={mappedRows}
        isAdmin={isAdmin}
      />

      <p className="mt-8 text-xs text-ink-faint">
        Admin only. Only the eleven purposes tied to a GSTIN are shown. TCS Payable
        and the two TDS ledgers are held for the company as a whole rather than per
        registration, are seeded from the TAN instead, and are not repaired here.
        This screen never edits an existing mapping: if a purpose points at the
        wrong ledger — as opposed to at nothing — that is a correction to make on
        the ledger itself under{" "}
        <Link href={`/${companyId}/ledgers`} className="underline">
          Ledgers
        </Link>
        , not by re-pointing tax that has already been posted.
      </p>
    </main>
  );
}
