import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

export const dynamic = "force-dynamic";

/**
 * GET /api/companies/[companyId]/backup
 *
 * Company data export — the "get your books out of this app" feature books
 * of accounts need under Sec 36 CGST Act, 1961 (72 months' retention from
 * the due date of the relevant annual return) and Sec 128 Companies Act,
 * 2013 (8 preceding financial years). Neither statute mandates a machine-
 * readable export specifically, but both mandate the records survive well
 * past this app's own uptime, and until this route there was no user-
 * initiated way to take a company's data out of LEKHA at all.
 *
 * Admin-only, same session auth as every page in app/(app) — this is a
 * Route Handler, not a public API-key endpoint like app/api/v1/*, so it
 * reads the same cookies a Server Component would and RLS still applies
 * underneath every query. The admin check below is an extra gate on top of
 * RLS (any member can *read* this company's data one table at a time
 * already; a one-click full export is treated as a more sensitive action
 * than any single report, so it is restricted the same way ModuleManager's
 * write path and the LDC/registration edit surfaces are).
 *
 * PAGINATION IS NOT OPTIONAL HERE. PostgREST caps an unranged .select() at
 * 1000 rows; a company with a long voucher history would have its export
 * silently truncated without .range() paging, which is exactly the failure
 * mode this feature exists to avoid ("an export that silently drops rows is
 * worse than no export"). fetchAllRows below pages every table through to
 * completion regardless of size.
 *
 * SCOPE: every table in TABLES is genuinely company-scoped per this
 * schema's tenancy convention (a direct company_id column, not one reached
 * only via a parent join), which is what makes a uniform
 * `.eq("company_id", companyId)` correct for all of them. Every OTHER
 * company-scoped table in the schema (verified live against
 * information_schema.columns, not just against this comment) is named in
 * SCOPE_DEFERRED below and in the response's scope_deferred field, so
 * nobody mistakes an intentionally narrower v1 for a silently incomplete
 * one — including bom_outputs/delivery_challans/delivery_challan_receipts/
 * digital_signature_certificates/exim_shipment_details, which are sibling
 * modules built by other agents in this same batch (migrations 0113,
 * 0114, 0117, 0119) after this route was first written; picked up here so
 * the deferred list stays honest rather than stale.
 */

const PAGE_SIZE = 1000;

type ExportTable = {
  /** Table name, and the JSON key it lands under — identical for every
   * table here, kept as two fields only because a couple of names read
   * better with a label than a raw table name would in the UI later. */
  table: string;
  label: string;
};

const TABLES: ExportTable[] = [
  { table: "account_groups", label: "Chart of accounts (groups)" },
  { table: "ledgers", label: "Ledgers" },
  { table: "branches", label: "Branches" },
  { table: "godowns", label: "Godowns / warehouses" },
  { table: "gst_registrations", label: "GST registrations" },
  { table: "cost_centres", label: "Cost centres" },
  { table: "items", label: "Stock items" },
  { table: "item_batches", label: "Item batches" },
  { table: "employees", label: "Employees" },
  { table: "fixed_assets", label: "Fixed assets" },
  { table: "vouchers", label: "Vouchers" },
  { table: "voucher_entries", label: "Voucher accounting lines" },
  { table: "voucher_items", label: "Voucher stock/inventory lines" },
  { table: "voucher_item_batches", label: "Voucher batch allocations" },
  { table: "orders", label: "Sales / purchase orders" },
  { table: "order_items", label: "Order line items" },
  { table: "budgets", label: "Budgets" },
  { table: "budget_lines", label: "Budget lines" },
  { table: "notices", label: "Notices & assessments" },
  { table: "documents", label: "Document attachments (metadata only — see note)" },
];

const SCOPE_DEFERRED = [
  "company_modules", "tax_ledger_map", "banking_facilities", "bank_statement_lines",
  "bill_of_materials", "bom_components", "bom_outputs", "company_directors",
  "contingent_liabilities", "delivery_challans", "delivery_challan_receipts",
  "digital_signature_certificates", "employee_salary_structures",
  "employee_tax_declarations", "exim_shipment_details", "filing_register",
  "job_work_challans", "job_work_returns", "llp_partner_contributions", "meetings",
  "member_branches", "payroll_ledger_map", "payroll_postings", "share_classes",
  "share_holdings", "tax_payments", "voucher_number_sequences", "audit_log",
  "company_members", "company_invites", "api_keys",
];

async function fetchAllRows(
  supabase: SupabaseClient<Database>,
  table: string,
  companyId: string
): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  const rows: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    // Table name is dynamic across 20 tables here; a per-table generic
    // overload isn't worth 20 near-identical branches for what is,
    // underneath, one query shape (select * where company_id = x, paged).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from(table as any) as any)
      .select("*")
      .eq("company_id", companyId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) return { rows, error: error.message };
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { rows, error: null };
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ companyId: string }> }
) {
  const { companyId } = await params;
  const supabase = await createClient();

  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // Admin gate, on top of RLS: fetch this user's own membership row
  // explicitly (filtered by user_id, unlike the loose "first row wins"
  // read elsewhere in this codebase's settings/approvals pages — a
  // full-company export is exactly the kind of action where picking up an
  // arbitrary OTHER member's role by accident would be a real bug, not a
  // cosmetic one).
  const { data: membership, error: membershipError } = await supabase
    .from("company_members")
    .select("role, status")
    .eq("company_id", companyId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (membershipError) {
    return NextResponse.json({ error: membershipError.message }, { status: 500 });
  }
  if (!membership || membership.status !== "active" || membership.role !== "admin") {
    return NextResponse.json(
      { error: "Only an active admin of this company can generate a backup." },
      { status: 403 }
    );
  }

  const { data: company, error: companyError } = await supabase
    .from("companies")
    .select(
      "id, name, legal_name, entity_type, compliance_mode, pan, tan, iec, cin, udyam_number, udyam_category, incorporation_date, financial_year_start_month, base_currency, book_beginning_date, lock_date, is_active, created_at, updated_at, inventory_valuation_method, company_tax_regime, is_professional, pf_establishment_code, esi_employer_code, lin, shops_establishment_reg"
    )
    // password_hash and password_protected are deliberately excluded —
    // this export is a books-of-account backup, not a credentials dump.
    .eq("id", companyId)
    .maybeSingle();

  if (companyError || !company) {
    return NextResponse.json({ error: companyError?.message ?? "Company not found." }, { status: 404 });
  }

  const data: Record<string, Record<string, unknown>[]> = {};
  const rowCounts: Record<string, number> = {};
  const errors: Record<string, string> = {};

  for (const { table } of TABLES) {
    const { rows, error } = await fetchAllRows(supabase, table, companyId);
    if (error) {
      errors[table] = error;
      continue;
    }
    data[table] = rows;
    rowCounts[table] = rows.length;
  }

  if (Object.keys(errors).length > 0) {
    // Fail loudly rather than hand back a file that looks complete and
    // isn't — a partial export with no indication of what's missing is
    // strictly worse than no export at all.
    return NextResponse.json(
      { error: "Export failed for one or more tables — no file was generated.", details: errors },
      { status: 500 }
    );
  }

  const documentsNote =
    "This section lists metadata/references only (id, entity_type, entity_id, storage_path, " +
    "file_name, mime_type, size_bytes, uploaded_by, created_at) for every row in the documents " +
    "table for this company. The underlying files live in Supabase Storage's private 'documents' " +
    "bucket (see migration 0060) and are NOT bundled into this JSON — binary files are out of " +
    "scope for this export pass. Re-download each file separately via its storage_path if you " +
    "need the bytes themselves before switching systems.";

  const payload = {
    export_version: 1,
    generated_at: new Date().toISOString(),
    generated_by: user.email ?? user.id,
    company,
    row_counts: rowCounts,
    data,
    documents_note: documentsNote,
    scope_deferred: SCOPE_DEFERRED,
    scope_deferred_note:
      "Tables listed here are genuinely company-scoped but not included in this export pass " +
      "(access/identity data, or modules not yet covered) — see the backup screen for why.",
  };

  const json = JSON.stringify(payload, null, 2);
  const filename = `${slugify(company.name)}-backup-${new Date().toISOString().slice(0, 10)}.json`;

  return new NextResponse(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
