import { ImageResponse } from "next/og";

// Generated at request time (cached by Next.js — see the ImageResponse/
// icon file-convention docs) via Satori, not a static asset — no image-
// editing tool needed. Padded to roughly the inner 80% so the same glyph
// also reads correctly once Android crops a "maskable" icon to a circle
// or squircle (see manifest.ts, which lists this same URL for both
// purpose:"any" and purpose:"maskable").
export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#3654D6",
        }}
      >
        <div
          style={{
            fontSize: 104,
            fontWeight: 700,
            color: "#F7F7F5",
            fontFamily: "serif",
          }}
        >
          L
        </div>
      </div>
    ),
    { width: 192, height: 192 }
  );
}
