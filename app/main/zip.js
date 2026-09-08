'use strict';

/* ===========================================================================
   AI-OS // minimal ZIP
   ---------------------------------------------------------------------------
   .docx and .xlsx are ZIP archives full of XML. Reading and writing them needs
   a ZIP container and nothing else, so this is a container and nothing else:
   store and deflate only, no encryption, no ZIP64, no multi-disk.

   Written by hand rather than pulled from npm because the requirement is 200
   lines of well-understood binary layout, and every dependency in the main
   process is code with filesystem access that someone else maintains.
   =========================================================================== */

const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/* ------------------------------------------------------------------- crc32 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* -------------------------------------------------------------------- read */

/**
 * Returns a Map of path -> Buffer. Entries are located through the central
 * directory rather than by scanning for local headers, because a local header
 * can legitimately carry a zero-length size with the real values in a trailing
 * data descriptor.
 */
function read(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new Error('不是有效的 zip：太短');

  // The end-of-central-directory record sits at the tail, possibly followed by
  // a comment, so search backwards for its signature.
  let eocd = -1;
  const limit = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= limit; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到 EOCD');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== SIG_CENTRAL) throw new Error('中央目錄損壞');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;   // directory entry

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error('本地檔頭損壞：' + name);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    let content;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error('不支援的壓縮方法 ' + method + '：' + name);

    files.set(name, content);
  }
  return files;
}

/* ------------------------------------------------------------------- write */

function dosTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const day = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, day };
}

/**
 * entries: Map or object of path -> string | Buffer.
 * `store` lists paths that must not be deflated: OOXML readers expect
 * [Content_Types].xml to be the first entry, and some are picky about mimetype
 * style entries being stored.
 */
function write(entries, opts = {}) {
  const list = entries instanceof Map ? [...entries.entries()] : Object.entries(entries);
  const store = new Set(opts.store || []);
  const { time, day } = dosTime(opts.date);

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [rawName, rawData] of list) {
    const name = String(rawName).replace(/\\/g, '/');
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(String(rawData), 'utf8');
    const useStore = store.has(name) || data.length < 64;
    const body = useStore ? data : zlib.deflateRawSync(data, { level: 9 });
    const method = useStore ? 0 : 8;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);            // version made by
    central.writeUInt16LE(20, 6);            // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);            // extra
    central.writeUInt16LE(0, 32);            // comment
    central.writeUInt16LE(0, 34);            // disk
    central.writeUInt16LE(0, 36);            // internal attrs
    central.writeUInt32LE(0, 38);            // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

module.exports = { read, write, crc32 };
