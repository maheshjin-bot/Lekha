import qrcodegen from "qrcode-generator";

/**
 * Renders a UPI payment deep link as a scannable QR. Pure computation, no
 * browser APIs — runs fine inside the print page's server component, so the
 * QR is present in the very first HTML response instead of popping in after
 * a client-side script runs (which matters here: this is a page meant to be
 * printed immediately).
 *
 * qrcode-generator (Kazuhiko Arase's implementation) was chosen over adding
 * a heavier client-rendering QR library: zero runtime dependencies, ~56KB,
 * and it is the same encoder several other popular QR packages vendor
 * internally. This app had no QR library before (html2canvas, already a
 * dependency, rasterises DOM to an image — an unrelated job).
 *
 * The QR itself is deliberately plain black-on-white rather than themed —
 * scanning apps assume standard high contrast, and a themed QR (e.g. a dark
 * background in dark mode) risks becoming unscannable, which would defeat
 * the entire point of printing it.
 */
export function UpiPaymentQr({ data, size = 148 }: { data: string; size?: number }) {
  const qr = qrcodegen(0, "M");
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
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label="Scan to pay via UPI"
    >
      <rect x={0} y={0} width={size} height={size} fill="#ffffff" />
      <path d={modules} fill="#000000" />
    </svg>
  );
}
