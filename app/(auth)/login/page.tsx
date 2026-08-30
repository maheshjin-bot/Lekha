import { LoginForm } from "@/components/auth/LoginForm";

/**
 * Reads and sanitises `?next=` the same way /verify already does for
 * MfaChallengeForm — see LoginForm's own comment for why this needs to exist
 * at all. Server component so the sanitised value is available on first
 * render rather than behind a useSearchParams() mount effect.
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const rawNext = typeof sp.next === "string" ? sp.next : "/companies";
  // Only ever return the user to a path on this site — `next` arrives in a
  // URL anyone can hand out, and an open redirect on a sign-in page is a
  // phishing primitive. Same guard as /verify, deliberately identical.
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/companies";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <LoginForm next={next} />
    </main>
  );
}
