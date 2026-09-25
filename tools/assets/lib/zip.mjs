// Minimal ZIP archives (PKWARE APPNOTE 6.3.x) for the public asset pack: stored or deflated entries, UTF-8 names, a
// fixed timestamp (the same files give the same archive), no ZIP64 (each pack part stays below 4 GiB and 65 535
// entries, pack_public.mjs checks). Node built-ins only. Standard tools (unzip, Explorer, 7-Zip, bsdtar) read them.
import fs from 'node:fs';
import zlib from 'node:zlib';

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;
const DOS_TIME = 0, DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;   // 2026-01-01 00:00
export const MAX_ENTRIES = 65535;
export const MAX_BYTES = 0xffffffff;

/** Local header + central record sizes of one entry (bytes the archive grows by, besides the data). */
export const entryOverhead = (name) => 30 + 46 + 2 * Buffer.byteLength(name);

/** Stored (uncompressed) form of `data`. */
export const store = (data) => ({ method: 0, body: data, crc: zlib.crc32(data) >>> 0, size: data.length });

/** Compressed form of `data`: deflate when it saves at least 3 %, else stored. -> { method, body, crc, size } */
export function compress(data, level = 6) {
  const crc = zlib.crc32(data) >>> 0;
  if (data.length >= 64) {
    const d = zlib.deflateRawSync(data, { level });
    if (d.length < data.length * 0.97) return { method: 8, body: d, crc, size: data.length };
  }
  return { method: 0, body: data, crc, size: data.length };
}

export class ZipWriter {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'w');
    this.off = 0;
    this.central = [];
  }

  /** Append an entry; `c` from compress(). */
  add(name, c) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`bad entry name ${name}`);
    const nb = Buffer.from(name, 'utf8');
    const flags = /[^\x20-\x7e]/.test(name) ? 0x0800 : 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(LOCAL, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(flags, 6); h.writeUInt16LE(c.method, 8);
    h.writeUInt16LE(DOS_TIME, 10); h.writeUInt16LE(DOS_DATE, 12); h.writeUInt32LE(c.crc, 14);
    h.writeUInt32LE(c.body.length, 18); h.writeUInt32LE(c.size, 22); h.writeUInt16LE(nb.length, 26); h.writeUInt16LE(0, 28);
    const at = this.off;
    this.write(h); this.write(nb); this.write(c.body);
    this.central.push({ nb, flags, method: c.method, crc: c.crc, csize: c.body.length, size: c.size, at });
    if (this.off > MAX_BYTES) throw new Error(`${this.file}: archive above 4 GiB (no ZIP64)`);
  }

  write(b) { fs.writeSync(this.fd, b, 0, b.length, this.off); this.off += b.length; }

  close() {
    if (this.central.length > MAX_ENTRIES) throw new Error(`${this.file}: more than ${MAX_ENTRIES} entries (no ZIP64)`);
    const start = this.off;
    for (const e of this.central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(CENTRAL, 0); h.writeUInt16LE(0x0314, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(e.flags, 8);
      h.writeUInt16LE(e.method, 10); h.writeUInt16LE(DOS_TIME, 12); h.writeUInt16LE(DOS_DATE, 14); h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20); h.writeUInt32LE(e.size, 24); h.writeUInt16LE(e.nb.length, 28);
      h.writeUInt32LE((0o100644 << 16) >>> 0, 38); h.writeUInt32LE(e.at, 42);
      this.write(h); this.write(e.nb);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0); end.writeUInt16LE(this.central.length, 8); end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(this.off - start, 12); end.writeUInt32LE(start, 16);
    this.write(end);
    fs.closeSync(this.fd);
    return this.off;
  }
}

/** Entries of a ZIP file: [{ name, method, crc, csize, size, at }] (central directory). */
export function listZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 22 + 65535));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === END) { e = i; break; }
    if (e < 0) throw new Error(`${file}: no end of central directory`);
    const n = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdAt = tail.readUInt32LE(e + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdAt);
    const out = [];
    for (let o = 0, k = 0; k < n; k++) {
      if (cd.readUInt32LE(o) !== CENTRAL) throw new Error(`${file}: bad central directory`);
      const nl = cd.readUInt16LE(o + 28), xl = cd.readUInt16LE(o + 30), cl = cd.readUInt16LE(o + 32);
      out.push({ name: cd.toString('utf8', o + 46, o + 46 + nl), method: cd.readUInt16LE(o + 10), crc: cd.readUInt32LE(o + 16),
        csize: cd.readUInt32LE(o + 20), size: cd.readUInt32LE(o + 24), at: cd.readUInt32LE(o + 42) });
      o += 46 + nl + xl + cl;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/** Data of one entry (inflated, CRC checked). `fd`: an open descriptor of the archive. */
export function readEntry(fd, e) {
  const h = Buffer.alloc(30);
  fs.readSync(fd, h, 0, 30, e.at);
  if (h.readUInt32LE(0) !== LOCAL) throw new Error(`${e.name}: bad local header`);
  const body = Buffer.alloc(e.csize);
  fs.readSync(fd, body, 0, e.csize, e.at + 30 + h.readUInt16LE(26) + h.readUInt16LE(28));
  const data = e.method === 8 ? zlib.inflateRawSync(body) : e.method === 0 ? body : null;
  if (!data) throw new Error(`${e.name}: unsupported compression method ${e.method}`);
  if (data.length !== e.size || (zlib.crc32(data) >>> 0) !== e.crc) throw new Error(`${e.name}: CRC / size mismatch`);
  return data;
}
