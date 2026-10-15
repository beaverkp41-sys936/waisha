/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== "production";
const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
const csp = [
  "default-src 'self'",
  `connect-src 'self' ${apiOrigin}`,
  "script-src 'self'" + (isDev ? " 'unsafe-eval'" : ""),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
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
  // Flipped to enforcing once the browser pass shows no violations.
  { key: "Content-Security-Policy-Report-Only", value: csp }
];
export default {
  reactStrictMode: true,
  async headers() { return [{ source: "/(.*)", headers: securityHeaders }]; }
};