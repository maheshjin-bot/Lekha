import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { renderUrlToPdf } from "@/lib/server/renderPrintPdf";

export const dynamic = "force-dynamic";

/**
 * GET /api/companies/[companyId]/vouchers/[voucherId]/print-pdf
 *
 * Server-side PDF export of the invoice print layout
 * (app/(app)/[companyId]/vouchers/[voucherId]/print/page.tsx) — the
 * prerequisite this task exists to build for emailing an invoice, attaching
 * one to a document record, or generating a batch filing pack.
 *
 * REUSE, NOT DUPLICATION. This route does not re-implement the print page's
 * layout, its tax-line/UPI-QR computation, or its data-fetching in a second
 * language. It drives a real headless-Chromium navigation to the actual
 * page URL (see lib/server/renderPrintPdf.ts) and captures what that page
 * itself renders — the exact same HTML/CSS a person printing from their own
 * browser tab would see, including the logo/terms/footer this feature adds
 * to that page and the UPI QR migration 0111 added earlier. Any future
 * change to the print page's own file automatically flows through to the
 * PDF with zero change needed here.
 *
 * WHY A HEADLESS BROWSER AT ALL, AND THE OPERATIONAL COST OF THAT CHOICE.
 * Researched live (WebSearch, Aug 2026) rather than assumed: the realistic
 * options for turning a real HTML/Tailwind page into a faithful PDF from a
 * Node server are (a) a headless-Chromium-driven renderer (Puppeteer or
 * Playwright — both share the same underlying cost, see below) that
 * literally renders the page and prints it, or (b) a from-scratch PDF
 * layout library (e.g. @react-pdf/renderer, pdf-lib, pdfkit) with its OWN
 * component/primitive model that does not understand this app's Tailwind
 * classes or existing print/page.tsx at all — which would mean re-authoring
 * the entire invoice layout a second time in a different API, the exact
 * duplication this task explicitly says not to do, and a second place for
 * the two layouts to drift apart. (a) is the only option that satisfies
 * "reuse the print page's own layout" literally, so that's what this route
 * does — but it is not free: a headless-Chromium dependency is a genuine
 * production cost on this app's own server (Oracle Cloud, Ubuntu 24.04
 * ARM64 — see the lekha-production-deployment memory), not a hidden one:
 *   - Chromium itself needs to be present on that machine. Plain
 *     `puppeteer` downloads one automatically on `npm install`, but that
 *     downloaded build has NO linux-arm64 variant (confirmed live via
 *     WebSearch — this is a known, still-current gap in both Puppeteer's
 *     and Playwright's own bundled-browser distribution), so on THIS
 *     app's actual production architecture that automatic download would
 *     silently fail. `puppeteer-core` (what this app depends on instead)
 *     downloads nothing and expects a system Chromium already installed —
 *     an explicit `apt-get install -y chromium-browser` the server
 *     operator has to run once, documented in lib/server/renderPrintPdf.ts.
 *   - Each export launches a full Chromium process (tens of MB of RAM,
 *     roughly half a second of launch latency) and tears it down again —
 *     acceptable for an invoice-at-a-time export, but a real cost multiplied
 *     across a "batch filing pack" if many are ever generated back-to-back
 *     in one request; a browser instance POOL (launch once, reuse across
 *     requests) would remove the per-request launch cost, and is exactly
 *     the kind of thing to add if/when a genuine batch-export feature is
 *     built on top of this route rather than something to speculatively
 *     build now for a single-invoice export.
 *
 * AUTH: this is a Route Handler under app/api, not the key-authenticated
 * app/api/v1/* surface — it reads the SAME session cookies a Server
 * Component would (createClient() below), and is membership-gated exactly
 * like the print page itself (companies_read / vouchers RLS are both
 * member-gated, not admin-only — anyone who can view an invoice on screen
 * can export it as a PDF). The explicit membership check below runs BEFORE
 * a browser is ever launched, for two reasons: it is a much cheaper way to
 * reject a non-member than paying for a Chromium launch first, and it lets
 * renderUrlToPdf's own /login-or-/verify redirect check (see that file)
 * stay a genuine defence-in-depth backstop rather than the only gate.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ companyId: string; voucherId: string }> }
) {
  const { companyId, voucherId } = await params;
  const supabase = await createClient();

  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { data: membership, error: membershipError } = await supabase
    .from("company_members")
    .select("status")
    .eq("company_id", companyId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (membershipError) {
    return NextResponse.json({ error: membershipError.message }, { status: 500 });
  }
  if (!membership || membership.status !== "active") {
    return NextResponse.json(
      { error: "You are not an active member of this company." },
      { status: 403 }
    );
  }

  const { data: voucher, error: voucherError } = await supabase
    .from("vouchers")
    .select("voucher_number, voucher_type")
    .eq("id", voucherId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (voucherError) {
    return NextResponse.json({ error: voucherError.message }, { status: 500 });
  }
  if (!voucher) {
    return NextResponse.json({ error: "Voucher not found." }, { status: 404 });
  }

  // The incoming request's own cookies are what forwarded to the internal
  // headless-Chromium navigation authenticate it as this same user — see
  // renderUrlToPdf. Built from `new URL(request.url).origin` rather than
  // guessing protocol/host: this Route Handler already received the
  // request on the exact origin (behind nginx in production) a real
  // browser tab would use for the same page.
  const origin = new URL(request.url).origin;
  const printUrl = `${origin}/${companyId}/vouchers/${voucherId}/print`;
  const cookieHeader = request.headers.get("cookie") ?? "";

  let pdf: Buffer;
  try {
    pdf = await renderUrlToPdf(printUrl, cookieHeader);
  } catch (err) {
    const message = err instanceof Error ? err.message : "PDF generation failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const filename = `${voucher.voucher_type}-${voucher.voucher_number}.pdf`.replace(/[/\\]/g, "-");

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdf.byteLength),
    },
  });
}
