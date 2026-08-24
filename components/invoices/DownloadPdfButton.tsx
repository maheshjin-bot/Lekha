"use client";

import { useState } from "react";
import { toast } from "sonner";

/**
 * Fetches the server-rendered PDF from the print-pdf route as a blob and
 * triggers a browser download — same fetch+blob download mechanics as
 * components/settings/BackupDownloadButton.tsx, so a slow render or a
 * failure surfaces as a toast instead of the browser navigating to a raw
 * error response. A plain <a href> was deliberately not used: PDF
 * generation here launches a headless browser server-side and can
 * genuinely take a few seconds, which a fetch call can show busy state for
 * and a bare link cannot.
 */
export function DownloadPdfButton({
  companyId,
  voucherId,
}: {
  companyId: string;
  voucherId: string;
}) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/vouchers/${voucherId}/print-pdf`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        toast.error(body.error ?? `PDF export failed (HTTP ${res.status}).`);
        return;
      }
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? "invoice.pdf";

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Could not reach the PDF export endpoint.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={download}
      disabled={busy}
      className="rounded-lg border border-border-strong px-3 py-1.5 text-sm transition-colors hover:bg-accent-soft disabled:opacity-50"
    >
      {busy ? "Preparing PDF…" : "Download PDF"}
    </button>
  );
}
