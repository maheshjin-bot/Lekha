"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";

// Mirrors the "documents" bucket's own allowed_mime_types (0060) minus PDF —
// a logo has to be a raster image, not a document. Not SVG either: the
// bucket's own allow-list doesn't include it, and an unsanitised SVG
// uploaded by a user is a real XSS vector if it were ever rendered directly
// rather than downloaded server-side and re-embedded as a data: URI (which
// is what this app does — see lib/server/printAssets.ts — so the risk is
// moot here, but the bucket-level restriction is the actual gate and it
// simply doesn't allow SVG).
const ALLOWED_LOGO_MIME = ["image/png", "image/jpeg", "image/webp"];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const MAX_TERMS_LEN = 4000;
const MAX_FOOTER_LEN = 1000;

const field =
  "w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-sm focus:border-accent focus:outline-none";

export function PrintTemplateForm({
  companyId,
  logoStoragePath,
  logoPreviewUrl,
  termsAndConditions,
  footerNote,
}: {
  companyId: string;
  logoStoragePath: string | null;
  logoPreviewUrl: string | null;
  termsAndConditions: string | null;
  footerNote: string | null;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [storagePath, setStoragePath] = useState(logoStoragePath);
  const [previewUrl, setPreviewUrl] = useState(logoPreviewUrl);
  const [terms, setTerms] = useState(termsAndConditions ?? "");
  const [footer, setFooter] = useState(footerNote ?? "");
  const [busyLogo, setBusyLogo] = useState(false);
  const [busySave, setBusySave] = useState(false);

  async function uploadLogo(file: File) {
    if (!ALLOWED_LOGO_MIME.includes(file.type)) {
      toast.error("Logo must be a PNG, JPEG or WebP image.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error("Logo must be under 2 MB.");
      return;
    }

    setBusyLogo(true);
    const client = createClient();
    // Path is the tenancy boundary storage RLS actually checks (0060's
    // documents_bucket_* policies read only the first folder segment) — the
    // "company-logo" segment is just a label, any value here is equally
    // valid against RLS, but this one keeps a company's logo files visually
    // grouped from Notices/other attachments landing in the same bucket.
    const path = `${companyId}/company-logo/${crypto.randomUUID()}-${file.name}`;

    const { error: uploadError } = await client.storage.from("documents").upload(path, file, {
      contentType: file.type,
    });
    if (uploadError) {
      setBusyLogo(false);
      toast.error(uploadError.message);
      return;
    }

    const { error: updateError } = await client
      .from("companies")
      .update({ logo_url: path })
      .eq("id", companyId);
    if (updateError) {
      // Row update failed — clean up the orphaned object rather than leave
      // it sitting in the bucket with nothing pointing at it (same
      // discipline DocumentAttachments.tsx already uses).
      await client.storage.from("documents").remove([path]);
      setBusyLogo(false);
      toast.error(updateError.message);
      return;
    }

    // Only remove the OLD file after the new one is confirmed live in the
    // row — so a mid-upload failure never leaves the company with no logo
    // file at all.
    if (storagePath) {
      await client.storage.from("documents").remove([storagePath]);
    }

    setStoragePath(path);
    setPreviewUrl(URL.createObjectURL(file));
    setBusyLogo(false);
    if (fileInput.current) fileInput.current.value = "";
    toast.success("Logo updated.");
    router.refresh();
  }

  async function removeLogo() {
    if (!storagePath) return;
    setBusyLogo(true);
    const client = createClient();

    const { error } = await client.from("companies").update({ logo_url: null }).eq("id", companyId);
    if (error) {
      setBusyLogo(false);
      toast.error(error.message);
      return;
    }
    await client.storage.from("documents").remove([storagePath]);

    setStoragePath(null);
    setPreviewUrl(null);
    setBusyLogo(false);
    toast.success("Logo removed.");
    router.refresh();
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusySave(true);
    const client = createClient();

    const { error } = await client
      .from("companies")
      .update({
        print_terms_and_conditions: terms.trim() || null,
        print_footer_note: footer.trim() || null,
      })
      .eq("id", companyId);

    setBusySave(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Saved.");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-4 py-3">
          <h2 className="font-semibold text-ink">Logo</h2>
          <p className="mt-0.5 text-xs text-ink-faint">
            Shown at the top of every printed or exported invoice, bill, credit note and debit
            note. PNG, JPEG or WebP, up to 2 MB.
          </p>
        </div>
        <div className="flex items-center gap-4 p-4">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-dashed border-border-strong bg-surface-2">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- data:/blob: preview, not a static asset Next's <Image> can optimise.
              <img src={previewUrl} alt="Company logo" className="h-full w-full object-contain" />
            ) : (
              <span className="text-[10px] text-ink-faint">No logo</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border-strong px-3 py-2 text-xs text-ink-soft hover:bg-surface-2">
              {busyLogo ? "Uploading…" : storagePath ? "Replace logo" : "Upload logo"}
              <input
                ref={fileInput}
                type="file"
                accept={ALLOWED_LOGO_MIME.join(",")}
                disabled={busyLogo}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) uploadLogo(file);
                }}
                className="sr-only"
              />
            </label>
            {storagePath && (
              <button
                type="button"
                disabled={busyLogo}
                onClick={removeLogo}
                className="text-xs text-error underline underline-offset-2 disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </section>

      <form onSubmit={onSave} className="flex flex-col gap-6">
        <section className="rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h2 className="font-semibold text-ink">Terms &amp; conditions</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              Printed below the total on every invoice — return policy, bank details, or
              whatever standard fine print this business always attaches.
            </p>
          </div>
          <div className="p-4">
            <textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value.slice(0, MAX_TERMS_LEN))}
              rows={5}
              maxLength={MAX_TERMS_LEN}
              placeholder="e.g. Goods once sold will not be taken back. Subject to Ahmedabad jurisdiction."
              className={field}
            />
            <div className="mt-1 text-right text-[10px] text-ink-faint">
              {terms.length}/{MAX_TERMS_LEN}
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h2 className="font-semibold text-ink">Footer note</h2>
            <p className="mt-0.5 text-xs text-ink-faint">
              One short line at the very bottom of the page — a thank-you note or tagline.
            </p>
          </div>
          <div className="p-4">
            <input
              value={footer}
              onChange={(e) => setFooter(e.target.value.slice(0, MAX_FOOTER_LEN))}
              maxLength={MAX_FOOTER_LEN}
              placeholder="e.g. Thank you for your business."
              className={field}
            />
            <div className="mt-1 text-right text-[10px] text-ink-faint">
              {footer.length}/{MAX_FOOTER_LEN}
            </div>
          </div>
        </section>

        <div>
          <Button type="submit" busy={busySave} busyLabel="Saving…">
            Save
          </Button>
        </div>
      </form>
    </div>
  );
}
