import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/**
 * Resolves a company's print logo — a PATH inside the private "documents"
 * Storage bucket (companies.logo_url, see migration 0125), not a public URL
 * — to an inline `data:` URI, for embedding directly in server-rendered
 * HTML.
 *
 * A data: URI rather than a signed URL is deliberate. The other consumer of
 * this same print page is the server-side PDF export route
 * (app/api/companies/[companyId]/vouchers/[voucherId]/print-pdf), which
 * drives a headless-Chromium render of this exact page rather than
 * re-implementing its layout — see that route for why. A signed URL has a
 * fixed expiry (60s is what this codebase already uses elsewhere,
 * DocumentAttachments.tsx) this app cannot guarantee outlives however long
 * that render takes; a data: URI embedded straight into the HTML response
 * has nothing to expire and nothing extra for headless Chrome to fetch.
 *
 * Returns null (never throws) on any failure — a missing/unreadable logo
 * should degrade the print layout to "no logo", not break it.
 */
export async function resolveLogoDataUri(
  supabase: SupabaseClient<Database>,
  storagePath: string | null
): Promise<string | null> {
  if (!storagePath) return null;

  const { data, error } = await supabase.storage.from("documents").download(storagePath);
  if (error || !data) return null;

  const mime = data.type || "image/png";
  const buffer = Buffer.from(await data.arrayBuffer());
  return `data:${mime};base64,${buffer.toString("base64")}`;
}
