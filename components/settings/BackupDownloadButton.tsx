"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";

/**
 * Fetches the full export from the API route as a blob and triggers a
 * browser download — same client-side download mechanics as
 * components/tally/TallyExportPanel.tsx's downloadFile helper, just with a
 * fetch()+blob step in front since the file here is server-assembled from
 * ~20 tables rather than built from data the page already has in hand.
 * Going through fetch (rather than a plain <a href> to the route) is what
 * lets a 403/500 surface as a toast instead of the browser silently
 * navigating to a JSON error page.
 */
export function BackupDownloadButton({ companyId }: { companyId: string }) {
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      const res = await fetch(`/api/companies/${companyId}/backup`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        toast.error(body.error ?? `Export failed (HTTP ${res.status}).`);
        return;
      }
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? "backup.json";

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${filename}.`);
    } catch {
      toast.error("Could not reach the export endpoint.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" onClick={download} busy={busy} busyLabel="Preparing export…">
      Download full backup (JSON)
    </Button>
  );
}
