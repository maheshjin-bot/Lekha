"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";

/** Every co_unlock_<companyId> cookie set by the company-password gate — a
 * session cookie by design, but sign-out is also an explicit promise (see
 * 0044's migration comment), so it doesn't wait on the browser to close. */
function clearCompanyUnlockCookies() {
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name?.startsWith("co_unlock_")) {
      document.cookie = `${name}=; Max-Age=0; path=/`;
    }
  }
}

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className ?? "w-full"}
      onClick={async () => {
        clearCompanyUnlockCookies();
        await createClient().auth.signOut();
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
