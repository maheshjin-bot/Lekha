import type { Metadata, Viewport } from "next";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/**
 * /scan is a SEPARATE SURFACE, not a small-screen version of the app.
 *
 * It sits at the top level, outside the `(app)` route group, and that is the
 * whole design: nothing under `(app)` — the NavRail, the company dashboard, the
 * support widget, the reports — is in this subtree, so none of it can leak onto
 * a phone that is handed to shop-floor staff. The person holding this device
 * photographs paper, tags it and sends it. They never see the books.
 *
 * Because /scan is outside `(app)`, it does NOT inherit that group's auth
 * guard, so the guard is repeated here in full — INCLUDING the second-factor
 * check. A surface that skipped it would be a documented way to reach a
 * company's data on a password alone, which is worse than not offering MFA.
 */
export const metadata: Metadata = {
  title: "Scan a document — LEKHA",
  description: "Photograph a bill or delivery challan and send it to the office.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The crop screen is a direct-manipulation surface: a double-tap that zooms
  // the page instead of doing nothing is a genuine hazard while dragging a
  // corner handle. Every tap target here is >= 48px so nothing needs pinching.
  maximumScale: 1,
  userScalable: false,
  // Draw under the notch and the home indicator; the shutter bar below pads
  // itself back out with env(safe-area-inset-bottom).
  viewportFit: "cover",
  themeColor: "#14171F",
};

export default async function ScanLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    console.error("[scan] getUser failed:", error.name, error.message);
  }

  if (!user) {
    const pathname = (await headers()).get("x-pathname");
    redirect(pathname ? `/login?next=${encodeURIComponent(pathname)}` : "/login?next=/scan");
  }

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.currentLevel === "aal1" && aal.nextLevel === "aal2") {
    const pathname = (await headers()).get("x-pathname");
    redirect(pathname ? `/verify?next=${encodeURIComponent(pathname)}` : "/verify?next=/scan");
  }

  // h-dvh, not h-screen: on a phone, 100vh is the height the browser wishes it
  // had, and the difference is the address bar sitting on top of the shutter.
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-ink">{children}</div>
  );
}
