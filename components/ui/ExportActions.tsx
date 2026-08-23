"use client";

import { useState, type RefObject } from "react";
import { Printer, Download, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { tableToCsv, downloadCsv } from "@/lib/utils/table-to-csv";
import { Button } from "@/components/ui/Button";

/**
 * Print / CSV / JPG for any report or document. Print leans on the
 * `print:` CSS already scoped per page — the browser's own print dialog
 * offers "Save as PDF" as a destination, so one button covers both without
 * a server-side renderer. CSV reads the rendered table back out (via
 * tableToCsv) rather than re-deriving it from data, so it can never
 * disagree with what's on screen. JPG rasterises whatever `captureRef`
 * points at, via html2canvas — loaded on demand so the ~200KB library
 * never ships to a page that doesn't use it.
 */
export function ExportActions({
  captureRef,
  hasTable = true,
  showPrint = true,
  filename,
  className,
}: {
  /** The element to screenshot for JPG export — also searched for a <table> for CSV export. */
  captureRef: RefObject<HTMLElement | null>;
  /** Set false to hide the CSV button when captureRef holds no table worth exporting. */
  hasTable?: boolean;
  /** Set false when the page already links to a dedicated, better-formatted print view. */
  showPrint?: boolean;
  /** Base filename, no extension. */
  filename: string;
  className?: string;
}) {
  const [exportingImage, setExportingImage] = useState(false);

  function exportCsv() {
    const table = captureRef.current?.querySelector("table");
    if (!table) return;
    downloadCsv(tableToCsv(table), filename);
  }

  async function exportJpg() {
    if (!captureRef.current) return;
    setExportingImage(true);
    try {
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(captureRef.current, {
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        scale: 2, // print-legible text, not a blurry screenshot
      });
      const url = canvas.toDataURL("image/jpeg", 0.92);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${filename}.jpg`;
      a.click();
    } catch {
      toast.error("Couldn't create the image — try Print instead.");
    } finally {
      setExportingImage(false);
    }
  }

  return (
    <div className={"flex items-center gap-1.5 print:hidden " + (className ?? "")}>
      {showPrint && (
        <Button variant="ghost" size="sm" onClick={() => window.print()} title="Print, or Save as PDF">
          <Printer size={13} />
          Print
        </Button>
      )}
      {hasTable && (
        <Button variant="ghost" size="sm" onClick={exportCsv} title="Download as CSV">
          <Download size={13} />
          CSV
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={exportJpg} busy={exportingImage} busyLabel="…" title="Download as JPG">
        <ImageIcon size={13} />
        JPG
      </Button>
    </div>
  );
}
