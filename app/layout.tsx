import type { Metadata } from "next";
import { Source_Serif_4, Source_Sans_3, IBM_Plex_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

// The LEKHA Design System's 3-typeface system: a display serif for headings
// and report titles, a matched sans for everything read, and a genuine
// monospace reserved only for money, GSTIN/PAN and voucher numbers — so a
// tired eye can follow a column of figures down five hundred rows without
// losing its place. next/font self-hosts these; no request ever leaves for
// Google at runtime.
const lekhaDisplay = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-lekha-display",
  display: "swap",
});

const lekhaBody = Source_Sans_3({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-lekha-body",
  display: "swap",
});

const lekhaMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-lekha-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "LEKHA — Statutory Accounting",
  description: "Accounting and statutory compliance for Indian businesses",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${lekhaDisplay.variable} ${lekhaBody.variable} ${lekhaMono.variable}`}
    >
      <body className="min-h-screen bg-bg font-body text-ink antialiased">
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast: "!bg-surface !border-border !text-ink !shadow-[var(--shadow)]",
              success: "!text-success",
              error: "!text-error",
            },
          }}
        />
      </body>
    </html>
  );
}
