import { createClient } from "@/lib/supabase/server";
import { SignatureRequestManager } from "@/components/signature-requests/SignatureRequestManager";
import type { ComponentProps } from "react";

type ManagerProps = ComponentProps<typeof SignatureRequestManager>;

export default async function SignatureRequestsPage({ params }: PageProps<"/[companyId]/signature-requests">) {
  const { companyId } = await params;
  const supabase = await createClient();

  const [{ data: requests }, { data: signers }, { data: docs }] = await Promise.all([
    supabase
      .from("signature_requests")
      .select("id, title, description, status, created_at, updated_at")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false }),
    supabase
      .from("signature_request_signers")
      .select(
        "id, request_id, signer_name, signer_email, sign_order, status, signed_at, signed_document_id, decline_reason, has_embedded_signature, signature_check_note"
      )
      .eq("company_id", companyId)
      .order("sign_order", { ascending: true }),
    supabase
      .from("documents")
      .select("id, storage_path, file_name, mime_type, size_bytes, created_at, entity_id, entity_type")
      .eq("company_id", companyId)
      .in("entity_type", ["signature_request", "signature_request_signer"]),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Signature requests</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          Track who needs to sign a document, in what order, and whether they have. Signing itself happens{" "}
          <strong>outside this app</strong> — a signer&rsquo;s own DSC token, their own Aadhaar eSign session
          elsewhere, or wet-ink then scan — and you upload the signed copy back in here per signer. This app does
          not originate or capture a legally binding signature; that needs a licensed Certifying Authority (for a
          DSC) or a licensed eSign Service Provider (for Aadhaar eSign), neither of which this app has an agreement
          with.
        </p>
      </header>

      <SignatureRequestManager
        companyId={companyId}
        // status is a CHECK-constrained text column, not a Postgres enum, so
        // Supabase's generated type widens it to `string` — narrowed back to
        // this component's own literal-union prop type here, the same way
        // every other report page bridges a generated row type to its props.
        requests={(requests ?? []) as ManagerProps["requests"]}
        signers={(signers ?? []) as ManagerProps["signers"]}
        docs={docs ?? []}
      />
    </main>
  );
}
