import { ImageResponse } from "next/og";

// Same design as app/icon-192/route.tsx, scaled up — see that file for why
// this is generated rather than a static asset, and why it's padded for
// maskable use.
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
            fontSize: 280,
            fontWeight: 700,
            color: "#F7F7F5",
            fontFamily: "serif",
          }}
        >
          L
        </div>
      </div>
    ),
    { width: 512, height: 512 }
  );
}
