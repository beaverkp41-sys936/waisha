/**
 * A ZIP archive writer with no dependency.
 *
 * The batch export streams hundreds of megabytes of already-compressed PDFs and photos,
 * so the two things a general-purpose zip library would buy us — deflate levels and
 * directory walking — are both things this archive does not need. Every entry is
 * stored (method 0): a scanned manifest does not shrink, and paying a compression pass
 * per document on the API box only slows the download down.
 *
 * `add()` and `finish()` hand back the Buffers they produced instead of writing them
 * somewhere, so the caller owns backpressure against the socket. Nothing is retained
 * after a chunk is written — the archive keeps only its central directory.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Bit 11 of the general flags: the entry name is UTF-8, not codepage 437. */
const FLAG_UTF8 = 0x0800;
const VERSION = 20;
/** Owner read/write, others read — the conventional mode a zip records for a file. */
const FILE_MODE = 0o644 << 16;
/**
 * "Made by UNIX, version 3.0". The mode above is only honoured by a reader that was
 * told the creator was UNIX — under a DOS creator the same four bytes mean DOS
 * attributes, and `unzip` would then invent permissions from the umask instead.
 */
const VERSION_MADE_BY = 0x031e;
const MAX_UINT32 = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** MS-DOS stamps carry two-second seconds and a 1980 epoch, so pre-1980 clamps. */
function dosStamp(at: Date): { time: number; date: number } {
  const d = at.getFullYear() < 1980 ? new Date(1980, 0, 1, 0, 0, 0) : at;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

const BAD_SEGMENT = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * An entry name is built from a file number and an uploaded document's own name, and
 * the second of those is typed by whoever uploaded it. So: no parent traversal, no
 * drive letters, no characters a Windows explorer refuses to extract, and a length a
 * shell can still read.
 */
export function safeEntryPath(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/")
    .map((s) => s.replace(BAD_SEGMENT, "").replace(/\s+/g, " ").trim().slice(0, 80))
    .filter((s) => s && s !== "." && s !== "..");
  const out = segments.join("/").slice(0, 200);
  return out || "file";
}

/** The buffers the caller must write, in order, to put this entry in the archive. */
export type ZipEntry = { name: string; bytes: number; chunks: Buffer[] };

export class ZipWriter {
  private readonly records: {
    name: Buffer; crc: number; size: number; offset: number; time: number; date: number;
  }[] = [];
  private readonly taken = new Set<string>();
  private offset = 0;
  private closed = false;

  get entryCount(): number { return this.records.length; }
  get bytesWritten(): number { return this.offset; }

  /** Stored under a unique path: a second `BL.pdf` becomes `BL (2).pdf`, never overwritten. */
  add(name: string, data: Buffer, at: Date = new Date()): ZipEntry {
    if (this.closed) throw new Error("ZipWriter is closed");
    const unique = this.uniqueName(safeEntryPath(name));
    const { time, date } = dosStamp(at);
    const crc = crc32(data);
    if (data.length > MAX_UINT32 || this.offset > MAX_UINT32) {
      throw new Error("A ZIP entry exceeded 4 GB — the batch needs splitting.");
    }

    const nameBuf = Buffer.from(unique, "utf8");
    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL_SIG, 0);
    head.writeUInt16LE(VERSION, 4);
    head.writeUInt16LE(FLAG_UTF8, 6);
    head.writeUInt16LE(0, 8);            // method: stored
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); // compressed
    head.writeUInt32LE(data.length, 22); // uncompressed
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);           // no extra field

    const chunks = [head, nameBuf, data];
    this.records.push({ name: nameBuf, crc, size: data.length, offset: this.offset, time, date });
    this.offset += head.length + nameBuf.length + data.length;
    return { name: unique, bytes: data.length, chunks };
  }

  /** The central directory and its end-of-archive record. */
  finish(): Buffer[] {
    if (this.closed) return [];
    this.closed = true;
    const chunks: Buffer[] = [];
    const start = this.offset;
    for (const r of this.records) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(CENTRAL_SIG, 0);
      head.writeUInt16LE(VERSION_MADE_BY, 4); // made by
      head.writeUInt16LE(VERSION, 6);    // version needed
      head.writeUInt16LE(FLAG_UTF8, 8);
      head.writeUInt16LE(0, 10);         // method: stored
      head.writeUInt16LE(r.time, 12);
      head.writeUInt16LE(r.date, 14);
      head.writeUInt32LE(r.crc, 16);
      head.writeUInt32LE(r.size, 20);
      head.writeUInt32LE(r.size, 24);
      head.writeUInt16LE(r.name.length, 28);
      head.writeUInt16LE(0, 30);         // extra
      head.writeUInt16LE(0, 32);         // comment
      head.writeUInt16LE(0, 34);         // disk
      head.writeUInt16LE(0, 36);         // internal attrs
      head.writeUInt32LE(FILE_MODE, 38);
      head.writeUInt32LE(r.offset, 42);
      chunks.push(head, r.name);
    }
    const directory = Buffer.concat(chunks);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.records.length, 8);
    eocd.writeUInt16LE(this.records.length, 10);
    eocd.writeUInt32LE(directory.length, 12);
    eocd.writeUInt32LE(start, 16);
    eocd.writeUInt16LE(0, 20);
    this.offset += directory.length + eocd.length;
    return [directory, eocd];
  }

  private uniqueName(name: string): string {
    if (!this.taken.has(name)) { this.taken.add(name); return name; }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 2; n < 1000; n++) {
      const candidate = `${stem} (${n})${ext}`.slice(0, 200);
      if (!this.taken.has(candidate)) { this.taken.add(candidate); return candidate; }
    }
    throw new Error("Too many identically named entries in one archive.");
  }
}
