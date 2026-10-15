import { ImageResponse } from "next/og";

// ROOKIE CRM favicon — gold "R" with crown on deep black background.
// Next.js renders this at build time and auto-injects <link rel="icon">
// into <head>. This route takes precedence over src/app/favicon.ico.

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0D0D0D", // ROOKIE deep black
          borderRadius: 6,
        }}
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 32 32"
          fill="#D4AA32"
        >
          {/* Crown */}
          <path d="M8 9l4-4 4 3 4-3 4 4v2H8V9z" />
          {/* R letter */}
          <path d="M11 13h6c2.2 0 4 1.3 4 3s-1.8 3-4 3l4 6h-3.5l-3.5-5.5V26h-3V13zm3 2.5v3h3c1.1 0 1.5-.6 1.5-1.5s-.4-1.5-1.5-1.5h-3z" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
