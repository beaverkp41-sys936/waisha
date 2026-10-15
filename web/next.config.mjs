/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== "production";
const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
// script-src needs 'unsafe-inline': Next.js App Router emits unhashable inline
// hydration scripts ($RX_0/next_f pushes) in dev AND production builds, so a
// nonce-free strict script-src would break the app. XSS blast radius is instead
// bounded by connect-src (no exfil fetches), form-action, frame-ancestors and
// object-src. Revisit if a nonce scheme is ever wired through middleware.
const csp = [
  "default-src 'self'",
  `connect-src 'self' ${apiOrigin}`,
  // unpkg: leaflet default marker images; *.tile.openstreetmap.org: map tiles;
  // *.supabase.co: document signed URLs rendered in <img> (avatars/logos).
  "script-src 'self' 'unsafe-inline'" + (isDev ? " 'unsafe-eval'" : ""),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://unpkg.com https://*.tile.openstreetmap.org https://*.supabase.co",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // Production enforces; dev stays report-only (webpack/HMR injects extra inline
  // scripts and eval, so enforcing locally would cripple the dev server).
  { key: isDev ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy", value: csp }
];
export default {
  reactStrictMode: true,
  async headers() { return [{ source: "/(.*)", headers: securityHeaders }]; }
};