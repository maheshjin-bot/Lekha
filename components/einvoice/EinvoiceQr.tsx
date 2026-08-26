import qrcodegen from "qrcode-generator";

/**
 * Renders the IRP's own SignedQRCode (a JWS token, obtained elsewhere and
 * pasted in — this app never calls an IRP) as a scannable QR, exactly the
 * way the real e-invoice print copy shows it. Same encoder as
 * components/invoices/UpiPaymentQr.tsx (qrcode-generator, already a
 * dependency, zero extra weight) — kept as its own small component rather
 * than reused directly because the two have different alt text and, more
 * materially, different capacity needs: a UPI deep link is short, but a
 * SignedQRCode can run to a few thousand characters on an invoice with many
 * item lines, so this uses error-correction level 'L' (the loosest,
 * highest-capacity level) rather than UpiPaymentQr's 'M', to keep headroom
 * for a long payload rather than risk qrcode-generator picking a version
 * that cannot fit it.
 */
export function EinvoiceQr({ data, size = 180 }: { data: string; size?: number }) {
  const qr = qrcodegen(0, "L");
  qr.addData(data);
  qr.make();

  const count = qr.getModuleCount();
  const cell = size / count;

  let modules = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        modules += `M${(col * cell).toFixed(2)},${(row * cell).toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
      }
    }
  }

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="e-Invoice signed QR code">
      <rect x={0} y={0} width={size} height={size} fill="#ffffff" />
      <path d={modules} fill="#000000" />
    </svg>
  );
}
