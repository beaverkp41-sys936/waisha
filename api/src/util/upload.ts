/**
 * Upload content sniffing — the browser-declared mimetype is attacker
 * controlled, so every accepted file must ALSO match its magic bytes.
 * Returns the real mime type or null for anything else (executables,
 * HTML/SVG, zip/doc containers, scripts pasted into a .png name).
 */
export function sniffFileType(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | "application/pdf" | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
      bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}
