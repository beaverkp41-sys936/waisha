/**
 * Read the text layer of a PDF held in our own storage. Nothing is rendered and
 * no byte leaves this process; a scanned image has no text layer, so it returns
 * no lines and the caller marks the file for manual entry.
 */
export type PdfText = { lines: string[]; pageCount: number; truncated: boolean };

const MAX_PAGES = 8;
const MAX_LINES = 900;

/** pdfjs is ~4MB of code, so it is loaded only when a file is actually read. */
async function loadPdfjs(): Promise<any> {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

export async function extractTextLines(bytes: Buffer): Promise<PdfText> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false
  }).promise;

  const lines: string[] = [];
  let truncated = false;
  try {
    const pages = Math.min(doc.numPages, MAX_PAGES);
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent({ includeMarkedContent: false });
      let current = "";
      for (const item of content.items as any[]) {
        if (typeof item.str !== "string") continue;
        current += item.str;
        if (item.hasEOL) {
          const line = current.replace(/\s+/g, " ").trim();
          if (line) {
            if (lines.length >= MAX_LINES) { truncated = true; break; }
            lines.push(line);
          }
          current = "";
        }
      }
      const tail = current.replace(/\s+/g, " ").trim();
      if (tail && lines.length < MAX_LINES) lines.push(tail);
      else if (tail) truncated = true;
    }
    truncated = truncated || doc.numPages > MAX_PAGES;
  } finally {
    await doc.destroy().catch(() => undefined);
  }

  return { lines, pageCount: doc.numPages, truncated };
}
