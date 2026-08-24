import fs from "node:fs";

/**
 * Locates a Chromium/Chrome executable puppeteer-core can drive.
 *
 * puppeteer-core (not plain "puppeteer") is deliberate — see the PDF export
 * route's own header comment for the full tradeoff. In short: plain
 * puppeteer bundles a ~300MB Chrome-for-Testing download as a postinstall
 * step, and that download has NO linux-arm64 build at all (confirmed live
 * via WebSearch, Aug 2026 — neither Puppeteer's nor Playwright's own
 * bundled-Chromium ships one), which is exactly the architecture this app's
 * actual production server runs (Oracle Cloud Ubuntu 24.04 ARM64, see the
 * lekha-production-deployment memory) — that install would silently fail
 * there. puppeteer-core ships no browser at all and expects the caller to
 * point it at one that already exists on the machine, which is the only
 * approach that actually works on both this repo's x86_64 Windows dev
 * machines (Chrome/Edge, confirmed present here via Test-Path before
 * writing this) and the arm64 Linux production host (system-packaged
 * Chromium via `apt-get install chromium-browser`, an operator-side step —
 * see README/deploy notes, not something `npm install` can do for a system
 * package).
 *
 * PDF_CHROMIUM_PATH is the explicit override; the fallback list below covers
 * every path this codebase's own two real environments are expected to use.
 */
export function resolveChromeExecutablePath(): string {
  const envPath = process.env.PDF_CHROMIUM_PATH;
  if (envPath) {
    if (!fs.existsSync(envPath)) {
      throw new Error(`PDF_CHROMIUM_PATH is set to "${envPath}", but no file exists there.`);
    }
    return envPath;
  }

  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            // Ubuntu's package name for this has varied by release
            // (chromium vs chromium-browser); both are checked.
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
          ];

  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      "No Chromium/Chrome executable found for PDF export. Set the PDF_CHROMIUM_PATH " +
        "environment variable to one, or install a system browser (on the production " +
        "Ubuntu server: `sudo apt-get install -y chromium-browser`, then set " +
        "PDF_CHROMIUM_PATH=/usr/bin/chromium-browser in the app's environment)."
    );
  }
  return found;
}

/**
 * Renders one internal, already-authenticated URL of THIS app to a PDF
 * buffer, by driving a real headless-Chromium navigation to it — not by
 * re-implementing the target page's markup. See the PDF export route for
 * why this is the reuse strategy (the print page's own layout/data-fetching
 * logic is used completely unmodified, including any future change to it).
 *
 * cookieHeader carries the calling request's own session cookies so the
 * internal navigation is authenticated as the same user — the print page is
 * a Server Component gated by the ordinary (app) layout's auth guard and by
 * RLS underneath every query it makes, exactly like a real browser tab, and
 * headless Chrome here IS a real browser tab that happens to be driven by
 * this process instead of a person.
 */
export async function renderUrlToPdf(url: string, cookieHeader: string): Promise<Buffer> {
  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: resolveChromeExecutablePath(),
    headless: true,
    // --no-sandbox: standard for a headless browser driven by a server
    // process rather than a logged-in desktop user — Chromium's own sandbox
    // relies on OS primitives (user namespaces / SUID helper) that are
    // routinely unavailable or restricted for a service account, and the
    // production deployment already has its own process-level isolation
    // (systemd unit, non-root `ubuntu` user, nginx in front). Documented
    // here rather than silently added, per this app's own discipline of not
    // burying an operational tradeoff in an unexplained flag.
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    if (cookieHeader) {
      await page.setExtraHTTPHeaders({ Cookie: cookieHeader });
    }

    const response = await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 });

    if (!response || !response.ok()) {
      throw new Error(`Print page responded with HTTP ${response?.status() ?? "no response"}.`);
    }
    // A redirect to /login or /verify means the forwarded session did not
    // authenticate the internal navigation (expired cookie, MFA pending,
    // etc.) — the caller already checked membership before starting this
    // render, so if we land here anyway, generating a PDF of the login
    // screen would be silently wrong rather than loudly failing.
    const finalUrl = response.url();
    if (finalUrl.includes("/login") || finalUrl.includes("/verify")) {
      throw new Error("The print page redirected to sign-in — the export session was not authenticated.");
    }

    // page.pdf() defaults to CSS media type "print" (relied on deliberately,
    // not re-asserted with emulateMediaType), which is exactly what makes
    // the print page's own `print:hidden` / `print:*` Tailwind classes
    // (already used to hide the on-screen Print/Download buttons) apply
    // here for free — the same CSS a person printing from their own browser
    // would trigger.
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
