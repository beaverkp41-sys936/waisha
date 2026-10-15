import { describe, expect, it } from "vitest";
import { sniffFileType } from "../src/util/upload.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 74, 70, 73, 70, 0, 1, 1]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(16)]);

describe("sniffFileType", () => {
  it("recognises the four accepted formats", () => {
    expect(sniffFileType(PNG)).toBe("image/png");
    expect(sniffFileType(JPEG)).toBe("image/jpeg");
    expect(sniffFileType(WEBP)).toBe("image/webp");
    expect(sniffFileType(PDF)).toBe("application/pdf");
  });

  it("rejects content that only pretends to be an image or pdf", () => {
    expect(sniffFileType(Buffer.from("<html><script>alert(1)</script></html>".padEnd(16)))).toBeNull();
    expect(sniffFileType(Buffer.from("MZ\u0090\u0003".padEnd(16)))).toBeNull();          // PE executable
    expect(sniffFileType(Buffer.from("PK\u0003\u0004".padEnd(16)))).toBeNull();          // zip/docx
    expect(sniffFileType(Buffer.from("%PDFX".padEnd(16)))).toBeNull();               // fake pdf magic
    expect(sniffFileType(Buffer.alloc(4))).toBeNull();                                 // too short
  });
});
