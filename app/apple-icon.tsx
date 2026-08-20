import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS's "Add to Home Screen" reads apple-touch-icon specifically — it
// doesn't use the web manifest (manifest.ts) at all, so this is a genuinely
// separate piece of installability, not a duplicate of icon-192/icon-512.
// Same generated-not-static approach; see app/icon-192/route.tsx.
export default function AppleIcon() {
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
            fontSize: 100,
            fontWeight: 700,
            color: "#F7F7F5",
            fontFamily: "serif",
          }}
        >
          L
        </div>
      </div>
    ),
    { ...size }
  );
}
