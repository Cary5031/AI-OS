'use strict';

/* ===========================================================================
   AI-OS // PDF reader
   ---------------------------------------------------------------------------
   Two jobs, in two halves.

   The first half turns a PDF into text, page by page, plus enough metadata to
   describe it honestly. That matters on this machine because a PDF the model
   cannot read is just a picture.

   The second half, at the bottom under VIEWER HOSTING, serves the pdf.js viewer
   and one PDF's bytes over a scheme of their own, so the pages can be drawn
   where they can be seen. The text extractor here is not what draws them --
   the two halves share a file and nothing else.

   HOW IT READS THE FILE

   Not through the cross-reference table. A conforming reader starts at the
   trailer, follows /Root, and walks the xref -- and then needs a second code
   path for xref streams, a third for hybrid files, and a fourth for the
   thoroughly common case of a file whose offsets are wrong because something
   appended to it without updating them. Instead every "N G obj ... endobj" in
   the file is indexed by scanning, and object streams are expanded into the
   same index. The page tree is then walked normally, with file order as the
   fallback when the tree is unusable.

   That trades a little strictness for a lot of robustness, which is the right
   trade for a viewer: refusing to open a slightly malformed file that every
   other reader opens is not a feature.

   WHAT IT CANNOT DO, AND SAYS SO

   Scanned pages hold images, not text. There is no OCR here, so a scan comes
   back with no text and `scanned: true` rather than an empty string that looks
   like a bug. Encrypted files are detected and refused rather than decoded into
   nonsense. Both are reported, never guessed at.
   =========================================================================== */

const zlib = require('node:zlib');

const MAX_BYTES = 200 * 1024 * 1024;
const MAX_PAGES = 5000;
const MAX_TEXT_PER_PAGE = 200 * 1024;

/* ========================================================== object model ===

   PDF values map onto JavaScript as:
     number          -> number
     /Name           -> '/Name'          (a string that starts with a slash)
     (string) <hex>  -> { str: '<bytes as latin1>' }
     N 0 R           -> { ref: N }
     << ... >>       -> { dict: { '/Key': value } }
     [ ... ]         -> array
     true/false/null -> as-is

   Names stay strings because that is how they are used -- as dictionary keys
   and as tags to compare -- and wrapping them would mean unwrapping them at
   every site.
   ========================================================================= */

const WS = new Set([0x20, 0x0a, 0x0d, 0x09, 0x0c, 0x00]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

function isWs(c) { return WS.has(c); }
function isDelim(c) { return DELIM.has(c); }
function isReg(c) { return !isWs(c) && !isDelim(c); }

/** Skip whitespace and comments. */
function skip(s, i) {
  for (;;) {
    while (i < s.length && isWs(s.charCodeAt(i))) i++;
    if (s.charCodeAt(i) === 0x25) {            // '%'
      while (i < s.length && s.charCodeAt(i) !== 0x0a && s.charCodeAt(i) !== 0x0d) i++;
      continue;
    }
    return i;
  }
}

function parseValue(s, i) {
  i = skip(s, i);
  if (i >= s.length) return { value: null, end: i };
  const c = s[i];

  if (c === '<') {
    if (s[i + 1] === '<') return parseDict(s, i);
    return parseHexString(s, i);
  }
  if (c === '(') return parseLiteralString(s, i);
  if (c === '[') return parseArray(s, i);
  if (c === '/') return parseName(s, i);
  if (c === ']' || c === '>' || c === '}') return { value: null, end: i + 1 };

  // number, reference, keyword
  const start = i;
  while (i < s.length && isReg(s.charCodeAt(i))) i++;
  const tok = s.slice(start, i);

  if (tok === 'true') return { value: true, end: i };
  if (tok === 'false') return { value: false, end: i };
  if (tok === 'null') return { value: null, end: i };

  if (/^[+-]?[\d.]+$/.test(tok)) {
    // "N G R" is an indirect reference; anything else is just a number.
    const save = i;
    let j = skip(s, i);
    const g0 = j;
    while (j < s.length && isReg(s.charCodeAt(j))) j++;
    const gen = s.slice(g0, j);
    let k = skip(s, j);
    if (/^\d+$/.test(gen) && s[k] === 'R' && !isReg(s.charCodeAt(k + 1))) {
      return { value: { ref: parseInt(tok, 10) }, end: k + 1 };
    }
    i = save;
    return { value: parseFloat(tok), end: i };
  }
  return { value: { op: tok }, end: i };
}

function parseName(s, i) {
  let out = '/';
  i++;
  while (i < s.length && isReg(s.charCodeAt(i))) {
    if (s[i] === '#' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      out += s[i++];
    }
  }
  return { value: out, end: i };
}

function parseDict(s, i) {
  i += 2;
  const dict = {};
  for (;;) {
    i = skip(s, i);
    if (i >= s.length) break;
    if (s[i] === '>' && s[i + 1] === '>') { i += 2; break; }
    if (s[i] !== '/') {                       // damaged entry: resynchronise
      const step = parseValue(s, i);
      if (step.end <= i) { i++; continue; }
      i = step.end;
      continue;
    }
    const key = parseName(s, i);
    const val = parseValue(s, key.end);
    dict[key.value] = val.value;
    i = val.end;
  }
  return { value: { dict }, end: i };
}

function parseArray(s, i) {
  i++;
  const arr = [];
  for (;;) {
    i = skip(s, i);
    if (i >= s.length) break;
    if (s[i] === ']') { i++; break; }
    const v = parseValue(s, i);
    if (v.end <= i) { i++; continue; }
    arr.push(v.value);
    i = v.end;
  }
  return { value: arr, end: i };
}

function parseLiteralString(s, i) {
  i++;
  let depth = 1;
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      i += 2;
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n === '\n') { /* line continuation */ }
      else if (n === '\r') { if (s[i] === '\n') i++; }
      else if (n >= '0' && n <= '7') {
        let oct = n;
        while (oct.length < 3 && s[i] >= '0' && s[i] <= '7') oct += s[i++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      } else out += n;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') { depth--; if (!depth) { i++; break; } }
    out += c;
    i++;
  }
  return { value: { str: out }, end: i };
}

function parseHexString(s, i) {
  i++;
  let hex = '';
  while (i < s.length && s[i] !== '>') {
    if (/[0-9a-f]/i.test(s[i])) hex += s[i];
    i++;
  }
  i++;
  if (hex.length % 2) hex += '0';
  let out = '';
  for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
  return { value: { str: out }, end: i };
}

/* ============================================================== document === */

function isDict(v) { return v && typeof v === 'object' && v.dict; }
function isRef(v) { return v && typeof v === 'object' && typeof v.ref === 'number'; }

class Doc {
  constructor(buf) {
    if (!Buffer.isBuffer(buf)) throw new Error('需要 Buffer');
    if (buf.length > MAX_BYTES) throw new Error('PDF 太大');
    this.buf = buf;
    // latin1 keeps one character per byte, so string offsets are byte offsets.
    this.s = buf.toString('latin1');
    this.objects = new Map();       // num -> { value, streamStart, streamEnd }
    this.trailer = {};
    this.warnings = [];
    this.encrypted = false;
    this.version = (this.s.slice(0, 16).match(/%PDF-(\d+\.\d+)/) || [])[1] || '?';
    this.indexObjects();
    this.readTrailers();
    this.expandObjectStreams();
  }

  /** Scan for every "N G obj" and record where its body and stream live. */
  indexObjects() {
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(this.s))) {
      const num = parseInt(m[1], 10);
      const bodyStart = m.index + m[0].length;
      const parsed = parseValue(this.s, bodyStart);

      let streamStart = -1;
      let streamEnd = -1;
      const after = skip(this.s, parsed.end);
      if (this.s.startsWith('stream', after)) {
        let p = after + 6;
        if (this.s[p] === '\r') p++;
        if (this.s[p] === '\n') p++;
        streamStart = p;
        // Trust "endstream" over /Length. Length is frequently an indirect
        // reference, and in damaged files it is frequently just wrong.
        const end = this.s.indexOf('endstream', p);
        streamEnd = end < 0 ? this.s.length : end;
        // Back off the EOL that belongs to the keyword, not to the data.
        if (this.s[streamEnd - 1] === '\n') streamEnd--;
        if (this.s[streamEnd - 1] === '\r') streamEnd--;
        re.lastIndex = Math.max(re.lastIndex, streamEnd);
      }

      // A later definition of the same object number supersedes an earlier one,
      // which is what an incrementally updated file relies on.
      this.objects.set(num, { value: parsed.value, streamStart, streamEnd });
    }
  }

  readTrailers() {
    const re = /trailer\b/g;
    let m;
    while ((m = re.exec(this.s))) {
      const d = parseValue(this.s, m.index + 7);
      if (isDict(d.value)) Object.assign(this.trailer, d.value.dict);
    }
    // Cross-reference streams carry the trailer entries in the stream's own
    // dictionary instead, so /Root and /Encrypt have to be looked for there too.
    for (const [, obj] of this.objects) {
      if (!isDict(obj.value)) continue;
      const t = obj.value.dict['/Type'];
      if (t === '/XRef') {
        for (const k of ['/Root', '/Info', '/Encrypt', '/ID']) {
          if (obj.value.dict[k] !== undefined && this.trailer[k] === undefined) {
            this.trailer[k] = obj.value.dict[k];
          }
        }
      }
    }
    if (this.trailer['/Encrypt'] !== undefined) this.encrypted = true;
  }

  /** Objects stored inside /ObjStm containers, which modern writers prefer. */
  expandObjectStreams() {
    for (const [, obj] of [...this.objects]) {
      if (!isDict(obj.value)) continue;
      if (obj.value.dict['/Type'] !== '/ObjStm') continue;
      let data;
      try { data = this.streamOf(obj).toString('latin1'); } catch { continue; }

      const n = this.num(obj.value.dict['/N']) || 0;
      const first = this.num(obj.value.dict['/First']) || 0;
      const header = data.slice(0, first);
      const nums = header.trim().split(/\s+/).map(Number);

      for (let k = 0; k < n; k++) {
        const num = nums[k * 2];
        const off = nums[k * 2 + 1];
        if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
        // Never let a compressed object shadow one written directly in the
        // file: the direct one is the newer definition.
        if (this.objects.has(num)) continue;
        try {
          const v = parseValue(data, first + off);
          this.objects.set(num, { value: v.value, streamStart: -1, streamEnd: -1 });
        } catch { /* skip a damaged entry */ }
      }
    }
  }

  get(v) {
    let seen = 0;
    while (isRef(v)) {
      if (++seen > 32) return null;            // reference loop
      const o = this.objects.get(v.ref);
      if (!o) return null;
      v = o.value;
    }
    return v;
  }

  num(v) {
    const r = this.get(v);
    return typeof r === 'number' ? r : null;
  }

  dictOf(v) {
    const r = this.get(v);
    return isDict(r) ? r.dict : null;
  }

  /**
   * The bytes exactly as the file holds them: still filtered, never decoded.
   *
   * The one thing a writer may copy. `streamOf` below returns nothing at all
   * for a JPEG, a JBIG2 or an unsupported filter, and silently leaves a
   * predictor un-reversed -- deliberately, because nothing that reads text
   * needs any of it. A writer that round-tripped through it would therefore
   * destroy every image in the file while reporting success. These bytes go
   * out the way they came in, and the filter dictionary goes with them.
   */
  rawStreamOf(obj) {
    if (!obj || obj.streamStart < 0) return Buffer.alloc(0);
    return this.buf.subarray(obj.streamStart, obj.streamEnd);
  }

  /** Decoded bytes of an object's stream. */
  streamOf(obj) {
    if (!obj || obj.streamStart < 0) return Buffer.alloc(0);
    let raw = this.rawStreamOf(obj);
    const d = isDict(obj.value) ? obj.value.dict : {};

    let filters = this.get(d['/Filter']);
    if (!filters) return raw;
    if (!Array.isArray(filters)) filters = [filters];

    for (const f of filters) {
      const name = typeof f === 'string' ? f : null;
      if (!name) continue;
      try {
        if (name === '/FlateDecode' || name === '/Fl') raw = zlib.inflateSync(raw);
        else if (name === '/ASCIIHexDecode' || name === '/AHx') raw = hexDecode(raw);
        else if (name === '/ASCII85Decode' || name === '/A85') raw = a85Decode(raw);
        else if (name === '/RunLengthDecode' || name === '/RL') raw = rleDecode(raw);
        else if (name === '/DCTDecode' || name === '/JPXDecode' ||
                 name === '/JBIG2Decode' || name === '/CCITTFaxDecode') {
          // Image codecs. Nothing here needs the pixels, and decoding them
          // would only produce bytes no caller wants.
          return Buffer.alloc(0);
        } else {
          this.note('不支援的串流過濾器：' + name);
          return Buffer.alloc(0);
        }
      } catch (e) {
        // Truncated deflate streams are common in damaged files and usually
        // still hold most of their content.
        const partial = tryPartialInflate(raw);
        if (partial) { raw = partial; continue; }
        this.note('串流解碼失敗（' + name + '）');
        return Buffer.alloc(0);
      }
    }

    // A predictor is only used for xref and image data, neither of which this
    // module reads, so it is noted rather than implemented.
    const parms = this.dictOf(d['/DecodeParms']);
    if (parms && this.num(parms['/Predictor']) > 1) this.note('串流使用了 predictor，未還原');
    return raw;
  }

  note(msg) {
    if (this.warnings.length < 24 && !this.warnings.includes(msg)) this.warnings.push(msg);
  }

  /* ------------------------------------------------------------- page tree */

  pages() {
    const root = this.dictOf(this.trailer['/Root']);
    const out = [];

    if (root) {
      const walk = (node, inherited, depth) => {
        if (out.length >= MAX_PAGES || depth > 64) return;
        const d = this.dictOf(node);
        if (!d) return;

        // Attributes a page inherits from its ancestors when it omits them.
        const carry = {
          resources: d['/Resources'] !== undefined ? d['/Resources'] : inherited.resources,
          mediaBox: d['/MediaBox'] !== undefined ? d['/MediaBox'] : inherited.mediaBox,
          rotate: d['/Rotate'] !== undefined ? d['/Rotate'] : inherited.rotate
        };

        if (d['/Type'] === '/Page' || (d['/Contents'] !== undefined && d['/Kids'] === undefined)) {
          out.push({ dict: d, ...carry });
          return;
        }
        const kids = this.get(d['/Kids']);
        if (Array.isArray(kids)) for (const k of kids) walk(k, carry, depth + 1);
      };
      walk(root['/Pages'], { resources: null, mediaBox: null, rotate: 0 }, 0);
    }

    if (out.length) return out;

    // No usable tree. Fall back to file order, which is right often enough to
    // be worth doing and is clearly better than reporting zero pages.
    this.note('頁面樹讀不到，改用檔案中出現的順序');
    for (const [, obj] of this.objects) {
      if (!isDict(obj.value)) continue;
      if (obj.value.dict['/Type'] !== '/Page') continue;
      out.push({
        dict: obj.value.dict,
        resources: obj.value.dict['/Resources'] || null,
        mediaBox: obj.value.dict['/MediaBox'] || null,
        rotate: obj.value.dict['/Rotate'] || 0
      });
      if (out.length >= MAX_PAGES) break;
    }
    return out;
  }

  /**
   * The page tree again, for something that has to write pages back out.
   *
   * `pages()` above answers "what is on each page", so it resolves each node to
   * a dictionary and throws the object number away. A writer needs the number:
   * everything it does -- copying a subgraph, renumbering it, pointing a new
   * /Pages at it -- is keyed on object identity, and a resolved dictionary
   * cannot say which object it came from.
   *
   * It also carries /CropBox, which `pages()` does not. Four keys are
   * inheritable in PDF -- /Resources, /MediaBox, /CropBox, /Rotate -- and a
   * page copied out of its tree loses every ancestor it was inheriting from, so
   * all four have to be resolved here and flattened onto the copy. /CropBox is
   * the one the text extractor never had a use for and a writer cannot skip: a
   * page cropped by an ancestor would otherwise come out showing the bleed,
   * the crop marks, or content somebody cropped away on purpose.
   *
   * `num` is null when a /Kids entry is a direct dictionary rather than a
   * reference, which is legal and rare; the writer materialises a fresh object
   * for those rather than pretending they have an identity.
   */
  pageEntries() {
    const root = this.dictOf(this.trailer['/Root']);
    const out = [];
    this.pageTreeGuessed = false;

    if (root) {
      const walk = (node, inherited, depth) => {
        if (out.length >= MAX_PAGES || depth > 64) return;
        const d = this.dictOf(node);
        if (!d) return;

        const carry = {
          resources: d['/Resources'] !== undefined ? d['/Resources'] : inherited.resources,
          mediaBox: d['/MediaBox'] !== undefined ? d['/MediaBox'] : inherited.mediaBox,
          cropBox: d['/CropBox'] !== undefined ? d['/CropBox'] : inherited.cropBox,
          rotate: d['/Rotate'] !== undefined ? d['/Rotate'] : inherited.rotate
        };

        if (d['/Type'] === '/Page' || (d['/Contents'] !== undefined && d['/Kids'] === undefined)) {
          out.push({ num: isRef(node) ? node.ref : null, dict: d, inherited: carry });
          return;
        }
        const kids = this.get(d['/Kids']);
        if (Array.isArray(kids)) for (const k of kids) walk(k, carry, depth + 1);
      };
      walk(root['/Pages'], { resources: null, mediaBox: null, cropBox: null, rotate: 0 }, 0);
    }

    if (out.length) return out;

    /* No usable tree. File order is right often enough to be worth offering,
       but a caller that is about to delete or reorder pages has to know that
       "page 3" is now a guess -- deleting the wrong page on the strength of a
       guess is not a recoverable mistake. */
    this.pageTreeGuessed = true;
    this.note('頁面樹讀不到，改用檔案中出現的順序');
    for (const [num, obj] of this.objects) {
      if (!isDict(obj.value)) continue;
      if (obj.value.dict['/Type'] !== '/Page') continue;
      const d = obj.value.dict;
      out.push({
        num,
        dict: d,
        inherited: {
          resources: d['/Resources'] || null,
          mediaBox: d['/MediaBox'] || null,
          cropBox: d['/CropBox'] || null,
          rotate: d['/Rotate'] || 0
        }
      });
      if (out.length >= MAX_PAGES) break;
    }
    return out;
  }

  /** Concatenated, decoded content streams for one page. */
  contentOf(page) {
    const c = page.dict['/Contents'];
    const refs = Array.isArray(this.get(c)) ? this.get(c) : [c];
    const parts = [];
    for (const r of refs) {
      const obj = isRef(r) ? this.objects.get(r.ref) : null;
      if (obj) parts.push(this.streamOf(obj));
    }
    return Buffer.concat(parts).toString('latin1');
  }

  info() {
    const d = this.dictOf(this.trailer['/Info']) || {};
    const text = (k) => {
      const v = this.get(d[k]);
      return v && v.str ? decodeTextString(v.str) : null;
    };
    return {
      title: text('/Title'),
      author: text('/Author'),
      subject: text('/Subject'),
      keywords: text('/Keywords'),
      creator: text('/Creator'),
      producer: text('/Producer'),
      created: pdfDate(text('/CreationDate')),
      modified: pdfDate(text('/ModDate'))
    };
  }
}

/* ========================================================== writing back ===

   The object model, emitted. Four small functions and a fifth that dispatches
   over them, kept here rather than in the writer because they are the exact
   inverse of the parser at the top of this file and the two have to be read
   together: every one of them exists to undo something a parser above does.

   None of this decides what to write. That is pdfedit.js's job. This is only
   the alphabet, and it is here so that a second writer -- stamping, filling,
   whatever comes next -- cannot quietly grow a second one that disagrees.
   ========================================================================= */

/** Re-escape what parseName decoded. `/A#20B` came in as `/A B` and must go back. */
function writeName(name) {
  const s = String(name || '');
  let out = '/';
  for (let i = s[0] === '/' ? 1 : 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x21 || c > 0x7e || isWs(c) || isDelim(c) || s[i] === '#') {
      out += '#' + c.toString(16).padStart(2, '0');
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * A number, in the only notation PDF has.
 *
 * Not `String(n)`. JavaScript switches to exponent form for small and large
 * magnitudes, and PDF has no exponent form -- worse, parseValue above guards
 * numbers with /^[+-]?[\d.]+$/, so `1e-7` would come back from this very
 * parser as `{op:'1e-7'}`: a keyword where a number belongs, silently
 * corrupting whatever matrix or bounding box it was part of. Annotation
 * matrices reach those magnitudes routinely.
 */
function writeNumber(n) {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  /* PDF's real range. Anything smaller than this rounds to nothing anyway, and
     writing it in exponent form would be worse than writing zero. */
  if (Math.abs(n) < 1e-6) return '0';
  if (Math.abs(n) > 1e15) return n < 0 ? '-1000000000000000' : '1000000000000000';
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * A string, always as hex.
 *
 * parseHexString round-trips this exactly, and there is no escape table to get
 * wrong. The literal form's backslash rules are needed on the way in and are
 * pure risk on the way out.
 */
function writeString(v) {
  const s = String((v && v.str) || '');
  let out = '<';
  for (let i = 0; i < s.length; i++) out += (s.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
  return out + '>';
}

/**
 * Any parsed value, back to source text.
 *
 * `{op}` is the one thing that cannot be written. The parser produces it for an
 * unrecognised keyword, which means it resynchronised over damage -- so it is a
 * marker that something was unreadable, not a value. Emitting it would put a
 * bare token where a value belongs and corrupt the dictionary around it, so the
 * caller is told to drop the key instead.
 */
function writeValue(v, depth = 0) {
  if (depth > 64) return 'null';
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return writeNumber(v);
  if (typeof v === 'string') return writeName(v);
  if (Array.isArray(v)) return '[' + v.map((x) => writeValue(x, depth + 1)).join(' ') + ']';
  if (isRef(v)) return v.ref + ' 0 R';
  if (v && typeof v.str === 'string') return writeString(v);
  if (isDict(v)) {
    let out = '<<';
    for (const k of Object.keys(v.dict)) {
      const val = v.dict[k];
      if (val && typeof val === 'object' && typeof val.op === 'string') continue;
      out += ' ' + writeName(k) + ' ' + writeValue(val, depth + 1);
    }
    return out + ' >>';
  }
  return 'null';
}

/**
 * One numbered object, ready to concatenate.
 *
 * `rawStream` non-null forces /Length to the bytes actually being written.
 * Never copy the source's: indexObjects derives the stream's end from
 * `endstream` rather than from /Length, so the two can legitimately disagree,
 * and /Length is very often an indirect reference -- which would either drag a
 * stray integer into the output or dangle.
 */
function writeObject(num, value, rawStream) {
  const head = Buffer.from(num + ' 0 obj\n', 'latin1');
  if (!rawStream) {
    return Buffer.concat([head, Buffer.from(writeValue(value) + '\nendobj\n', 'latin1')]);
  }
  const dict = isDict(value) ? { dict: { ...value.dict } } : { dict: {} };
  dict.dict['/Length'] = rawStream.length;
  return Buffer.concat([
    head,
    Buffer.from(writeValue(dict) + '\nstream\n', 'latin1'),
    rawStream,
    Buffer.from('\nendstream\nendobj\n', 'latin1')
  ]);
}

/* ================================================================ filters == */

function hexDecode(buf) {
  const s = buf.toString('latin1').replace(/[^0-9a-fA-F>]/g, '');
  const hex = s.slice(0, s.indexOf('>') < 0 ? s.length : s.indexOf('>'));
  const even = hex.length % 2 ? hex + '0' : hex;
  return Buffer.from(even, 'hex');
}

function a85Decode(buf) {
  let s = buf.toString('latin1').replace(/\s/g, '');
  if (s.startsWith('<~')) s = s.slice(2);
  const end = s.indexOf('~>');
  if (end >= 0) s = s.slice(0, end);
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === 'z') { out.push(0, 0, 0, 0); i++; continue; }
    let group = s.slice(i, i + 5);
    i += 5;
    const pad = 5 - group.length;
    group += 'u'.repeat(pad);
    let n = 0;
    for (const ch of group) n = n * 85 + (ch.charCodeAt(0) - 33);
    const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    out.push(...bytes.slice(0, 4 - pad));
  }
  return Buffer.from(out);
}

function rleDecode(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const n = buf[i++];
    if (n === 128) break;
    if (n < 128) { for (let k = 0; k <= n && i < buf.length; k++) out.push(buf[i++]); }
    else { const b = buf[i++]; for (let k = 0; k < 257 - n; k++) out.push(b); }
  }
  return Buffer.from(out);
}

/**
 * Recover what a truncated deflate stream did contain. inflateSync throws on
 * an unexpected end, discarding everything, which for a damaged PDF means
 * losing a whole page over a missing checksum.
 */
function tryPartialInflate(raw) {
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try {
      return fn(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch { /* try the next */ }
  }
  return null;
}

/* ================================================================ strings == */

/** PDF text strings are either UTF-16BE with a BOM, or PDFDocEncoding. */
function decodeTextString(s) {
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < s.length; i += 2) {
      out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    }
    return out.replace(/\u0000+$/, '');
  }
  return s;
}

/** D:YYYYMMDDHHmmSSOHH'mm' -> ISO string, or null. */
function pdfDate(s) {
  if (!s) return null;
  const m = String(s).match(/D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const iso = `${y}-${mo || '01'}-${d || '01'}T${h || '00'}:${mi || '00'}:${sec || '00'}`;
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? null : dt.toISOString();
}

/* ================================================================== cmaps == */

/**
 * A /ToUnicode CMap: the only reliable way to read text set in a subsetted
 * embedded font, where the byte in the content stream is a glyph index with no
 * relation to any character set. Without this, such a page decodes to
 * plausible-looking rubbish -- which is worse than decoding to nothing, because
 * nobody notices.
 */
function parseCMap(text) {
  const map = new Map();
  let bytes = 1;

  const csr = text.match(/begincodespacerange([\s\S]*?)endcodespacerange/);
  if (csr) {
    const first = csr[1].match(/<([0-9a-fA-F]+)>/);
    if (first) bytes = Math.max(1, Math.min(4, Math.ceil(first[1].length / 2)));
  }

  const hexToStr = (hex) => {
    let out = '';
    for (let i = 0; i + 3 < hex.length + 1 && i < hex.length; i += 4) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    }
    return out;
  };

  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = charRe.exec(text))) {
    const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g;
    let p;
    while ((p = pairRe.exec(m[1]))) {
      map.set(parseInt(p[1], 16), hexToStr(p[2]));
      bytes = Math.max(bytes, Math.ceil(p[1].length / 2));
    }
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = rangeRe.exec(text))) {
    const body = m[1];
    // <lo> <hi> [<a> <b> ...]
    const listRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
    let r;
    while ((r = listRe.exec(body))) {
      const lo = parseInt(r[1], 16);
      const items = r[3].match(/<([0-9a-fA-F]*)>/g) || [];
      items.forEach((it, k) => map.set(lo + k, hexToStr(it.replace(/[<>]/g, ''))));
      bytes = Math.max(bytes, Math.ceil(r[1].length / 2));
    }
    // <lo> <hi> <dst>
    const seqRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    while ((r = seqRe.exec(body))) {
      const lo = parseInt(r[1], 16);
      const hi = parseInt(r[2], 16);
      const dst = parseInt(r[3], 16);
      if (hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(dst + (c - lo)));
      bytes = Math.max(bytes, Math.ceil(r[1].length / 2));
    }
  }

  return { map, bytes };
}

/* WinAnsi differs from Latin-1 only in 0x80-0x9f, but that range holds the
   quotes and dashes that real documents are full of. */
const WIN_ANSI_HIGH = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02c6', 0x89: '\u2030', 0x8a: '\u0160',
  0x8b: '\u2039', 0x8c: '\u0152', 0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201c', 0x94: '\u201d', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a', 0x9c: '\u0153',
  0x9e: '\u017e', 0x9f: '\u0178'
};

function decodeWithFont(raw, font) {
  if (!font || !font.cmap) {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      out += WIN_ANSI_HIGH[c] || String.fromCharCode(c);
    }
    return out;
  }
  const { map, bytes } = font.cmap;
  let out = '';
  for (let i = 0; i < raw.length; i += bytes) {
    let code = 0;
    for (let k = 0; k < bytes && i + k < raw.length; k++) code = (code << 8) | raw.charCodeAt(i + k);
    const hit = map.get(code);
    if (hit !== undefined) out += hit;
    else if (bytes === 1) out += WIN_ANSI_HIGH[code] || String.fromCharCode(code);
    // A 2-byte code with no mapping is a glyph nobody can name; emitting
    // something for it would be inventing content.
  }
  return out;
}

/* ========================================================= text extraction = */

/** Tokenise a content stream into operands and operators. */
function* contentTokens(s) {
  let i = 0;
  while (i < s.length) {
    i = skip(s, i);
    if (i >= s.length) return;
    const before = i;
    const v = parseValue(s, i);
    i = v.end;
    if (i <= before) { i = before + 1; continue; }
    yield v.value;
  }
}

/* How deep a form may nest before this stops following. Real documents reach
   two or three; anything past this is a producer being strange or a cycle the
   visited set did not catch because the same form arrived by two routes. */
const MAX_FORM_DEPTH = 8;

/**
 * The form XObject a `Do` names, resolved and ready to read.
 *
 * Returns null for an image, for a name the resources do not have, and for
 * anything already on this branch -- a form that draws itself is rare and
 * cheap to guard against, and the alternative is a stack overflow on a file
 * somebody could write on purpose.
 */
function formOf(into, name) {
  const doc = into.doc;
  if (!doc || (into.depth || 0) >= MAX_FORM_DEPTH) return null;

  const res = doc.dictOf(into.resources) || {};
  const xobjects = doc.dictOf(res['/XObject']);
  if (!xobjects) return null;

  const ref = xobjects[name];
  const obj = isRef(ref) ? doc.objects.get(ref.ref) : null;
  if (!obj || !isDict(obj.value)) return null;
  if (obj.value.dict['/Subtype'] !== '/Form') return null;

  const visited = into.visited || new Set();
  if (visited.has(ref.ref)) return null;

  let content;
  try { content = doc.streamOf(obj).toString('latin1'); } catch { return null; }
  if (!content) return null;

  /* A form may bring its own resources or inherit the page's. Its font names
     mean whatever its own dictionary says they mean, so the two must not be
     merged -- /F1 in a form and /F1 on the page are routinely different fonts. */
  const resources = obj.value.dict['/Resources'] !== undefined
    ? obj.value.dict['/Resources']
    : into.resources;

  return {
    content,
    resources,
    fonts: fontsIn(doc, resources),
    visited: new Set(visited).add(ref.ref)
  };
}

/**
 * Turn one page's content stream into text.
 *
 * Line breaks are inferred from the text matrix, because a PDF has no lines:
 * it has glyphs at coordinates. A vertical move ends a line; a horizontal gap
 * wide enough to be deliberate becomes a space. Getting this wrong is what
 * makes extracted PDF text read as one endless paragraph.
 */
function extractText(content, fonts, ctx) {
  const into = ctx || {};
  let out = '';
  let font = null;
  let leading = 0;
  let x = 0;
  let y = 0;
  let lastY = null;
  let lastX = null;
  const stack = [];

  /* Counted so a page with no text can say *why* it has none. "Scanned" and
     "the text was converted to outlines" are different problems with the same
     symptom, and telling the user the wrong one sends them looking in the wrong
     place. */
  const seen = { show: 0, image: 0, path: 0 };

  const show = (raw) => {
    seen.show++;
    const t = decodeWithFont(raw, font);
    if (t) out += t;
  };

  const newline = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };

  for (const tok of contentTokens(content)) {
    if (!tok || typeof tok !== 'object' || !tok.op) { stack.push(tok); continue; }
    const op = tok.op;
    const a = stack;

    switch (op) {
      case 'BT':
        x = 0; y = 0; lastY = null; lastX = null;
        break;
      case 'ET':
        newline();
        break;
      case 'Tf': {
        const name = a[a.length - 2];
        font = (typeof name === 'string' && fonts[name]) || null;
        break;
      }
      case 'TL':
        leading = Number(a[a.length - 1]) || 0;
        break;
      case 'Td': case 'TD': {
        const dy = Number(a[a.length - 1]) || 0;
        const dx = Number(a[a.length - 2]) || 0;
        if (op === 'TD') leading = -dy;
        x += dx; y += dy;
        if (Math.abs(dy) > 0.01) newline();
        lastX = null;
        break;
      }
      case 'Tm': {
        const ny = Number(a[a.length - 1]) || 0;
        const nx = Number(a[a.length - 2]) || 0;
        // A new matrix on a different baseline is a new line. The threshold
        // keeps superscripts and small kerning adjustments from splitting text.
        if (lastY !== null && Math.abs(ny - lastY) > 1.5) newline();
        x = nx; y = ny; lastY = ny; lastX = null;
        break;
      }
      case 'T*':
        y -= leading;
        newline();
        lastX = null;
        break;
      case 'Tj':
        if (a.length && a[a.length - 1] && a[a.length - 1].str !== undefined) show(a[a.length - 1].str);
        break;
      case '\'':
        newline();
        if (a.length && a[a.length - 1] && a[a.length - 1].str !== undefined) show(a[a.length - 1].str);
        break;
      case '"':
        newline();
        if (a.length && a[a.length - 1] && a[a.length - 1].str !== undefined) show(a[a.length - 1].str);
        break;
      case 'TJ': {
        const arr = a[a.length - 1];
        if (Array.isArray(arr)) {
          for (const part of arr) {
            if (part && part.str !== undefined) show(part.str);
            else if (typeof part === 'number' && part < -180 && out && !/\s$/.test(out)) {
              // A large negative adjustment is the writer moving on rather than
              // kerning: that gap is a word break.
              out += ' ';
            }
          }
        }
        break;
      }
      /* An XObject is drawn. Which kind matters, and for a long time this
         counted every one of them as a picture.

         A form XObject is a piece of a page held separately -- and real text
         lives in them: Word, LaTeX and Illustrator all emit them, and so does
         anything this machine stamps onto a page. Counting one as an image
         meant a page whose words were all inside a form came back with no text
         and `empty: 'image'`, which this module then reported as 「掃描檔」 --
         a confident wrong answer that sends somebody looking for an OCR that
         would not have helped.

         So: recurse into a form, count only a real image as an image. The
         form's own /Resources are used when it has them, because its font names
         are its own; depth and a visited set stop a form that draws itself. */
      case 'Do': {
        const name = a[a.length - 1];
        const form = typeof name === 'string' ? formOf(into, name) : null;
        if (!form) { seen.image++; break; }

        const inner = extractText(form.content, form.fonts, {
          doc: into.doc,
          resources: form.resources,
          depth: (into.depth || 0) + 1,
          visited: form.visited
        });
        if (inner.text) {
          if (out && !out.endsWith('\n')) out += '\n';
          out += inner.text;
        }
        seen.show += inner.seen.show;
        seen.image += inner.seen.image;
        seen.path += inner.seen.path;
        break;
      }
      case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*':
        seen.path++;
        break;
      case 'q': stack.length = 0; break;
      case 'Q': stack.length = 0; break;
      default: break;
    }

    if (op) stack.length = 0;
    if (out.length > MAX_TEXT_PER_PAGE) break;
  }

  return { text: out, seen };
}

/** Build name -> { cmap } for the fonts a page's resources name. */
function pageFonts(doc, page) {
  return fontsIn(doc, page.resources);
}

/**
 * name -> { cmap } for one /Resources dictionary.
 *
 * Split out from pageFonts because a form XObject has resources of its own and
 * its font names mean what its own dictionary says -- so reading text inside a
 * form needs this against the form's resources, not the page's.
 */
function fontsIn(doc, resources) {
  const res = doc.dictOf(resources) || {};
  const fontDict = doc.dictOf(res['/Font']) || {};
  const out = {};

  for (const [name, ref] of Object.entries(fontDict)) {
    const f = doc.dictOf(ref);
    if (!f) continue;
    let cmap = null;

    const tu = f['/ToUnicode'];
    if (isRef(tu)) {
      const obj = doc.objects.get(tu.ref);
      if (obj) {
        try {
          const text = doc.streamOf(obj).toString('latin1');
          if (text) cmap = parseCMap(text);
        } catch { /* fall through to the encoding guess */ }
      }
    }

    // No ToUnicode. A composite font still uses two-byte codes, so at least get
    // the width right; a simple font is close enough to WinAnsi to read.
    if (!cmap && f['/Subtype'] === '/Type0') cmap = { map: new Map(), bytes: 2 };

    out[name] = { cmap, subtype: f['/Subtype'] || null, base: f['/BaseFont'] || null };
  }
  return out;
}

/* ==================================================================== api == */

/**
 * Read a PDF and return its text and metadata.
 *
 * Never throws for a merely awkward file: problems are reported in `warnings`
 * and the caller gets whatever was readable, because a viewer that refuses to
 * open a file is less useful than one that opens it with a caveat.
 */
function read(buf, opts = {}) {
  const doc = new Doc(buf);
  const meta = doc.info();

  if (doc.encrypted) {
    return {
      ok: false,
      code: 'EENCRYPTED',
      error: '這份 PDF 有加密保護，無法取出文字',
      version: doc.version,
      pageCount: 0,
      pages: [],
      chars: 0,
      meta,
      warnings: doc.warnings,
      encrypted: true,
      scanned: false
    };
  }

  const pageList = doc.pages();
  const wanted = opts.pages && opts.pages.length
    ? opts.pages.filter((n) => n >= 1 && n <= pageList.length)
    : null;

  const pages = [];
  pageList.forEach((p, idx) => {
    const number = idx + 1;
    if (wanted && !wanted.includes(number)) return;
    let text = '';
    let seen = { show: 0, image: 0, path: 0 };
    try {
      const got = extractText(doc.contentOf(p), pageFonts(doc, p),
        { doc, resources: p.resources, depth: 0 });
      text = got.text;
      seen = got.seen;
    } catch (e) {
      doc.note('第 ' + number + ' 頁抽取失敗：' + e.message);
    }
    const clean = tidy(text);
    const repaired = lastRepaired;
    const box = (doc.get(p.mediaBox) || []).map((v) => doc.num(v) || 0);
    pages.push({
      number,
      text: clean,
      chars: clean.length,
      /* Radical lookalikes this page had before they were put back. The text
         above is correct; the file is not, and the exporter has to be able to
         say so. */
      radicals: repaired,
      // Why an empty page is empty, which is the difference between "get a
      // better copy" and "there is nothing to get".
      empty: clean.length === 0 ? emptyReason(seen) : null,
      width: box.length === 4 ? Math.round(Math.abs(box[2] - box[0])) : null,
      height: box.length === 4 ? Math.round(Math.abs(box[3] - box[1])) : null,
      rotate: doc.num(p.rotate) || 0
    });
  });

  const totalChars = pages.reduce((n, p) => n + p.chars, 0);
  const textless = pages.length > 0 && totalChars === 0;
  const reasons = [...new Set(pages.map((p) => p.empty).filter(Boolean))];
  const scanned = textless && reasons.includes('image');

  if (textless) {
    if (reasons.length === 1 && reasons[0] === 'image') {
      doc.note('每一頁都只有影像，沒有文字圖層：這是掃描檔，而這裡沒有 OCR');
    } else if (reasons.length === 1 && reasons[0] === 'outlined') {
      doc.note('文字被轉成向量外框，檔案裡沒有任何文字可取出（不是掃描檔，OCR 也幫不上）');
    } else {
      doc.note('每一頁都取不到文字（' + reasons.join('、') + '）；這裡沒有 OCR');
    }
  }

  return {
    ok: true,
    version: doc.version,
    pageCount: pageList.length,
    pages,
    chars: totalChars,
    meta,
    warnings: doc.warnings,
    encrypted: false,
    scanned,
    textless,
    emptyReasons: reasons
  };
}

/**
 * Classify a page that produced no text.
 *   'image'    -- drew XObjects and showed no text: a scan
 *   'outlined' -- drew paths and showed no text: text converted to curves
 *   'blank'    -- drew nothing worth noting
 */
function emptyReason(seen) {
  if (seen.image > 0) return 'image';
  if (seen.path > 0) return 'outlined';
  return 'blank';
}

/** Metadata and page count without paying for text extraction. */
function probe(buf) {
  const doc = new Doc(buf);
  return {
    ok: !doc.encrypted,
    version: doc.version,
    pageCount: doc.encrypted ? 0 : doc.pages().length,
    meta: doc.info(),
    encrypted: doc.encrypted,
    warnings: doc.warnings
  };
}

/**
 * Collapse the whitespace noise that glyph-by-glyph placement produces, and
 * drop private-use codepoints.
 *
 * Subset fonts routinely map decorative glyphs -- logos, bullets, icons -- into
 * U+E000..U+F8FF, where they mean nothing outside that one font. Keeping them
 * puts boxes in the reader's text and noise in the model's context, so they go.
 */
/**
 * Kangxi Radicals and the CJK Radicals Supplement, put back as the ideographs
 * they stand for.
 *
 * These blocks exist to talk *about* radicals in a dictionary. They are not the
 * characters, and a font whose reverse cmap picks one produces a text layer that
 * looks perfect and is wrong: \u65e5 written as U+2F47, \u7528 as U+2F64, \u884c as U+2F8F.
 * Measured on this machine's own PDF export -- 12 of 13 common characters for
 * \u5fae\u8edf\u6b63\u9ed1\u9ad4 and Noto Sans TC, 0 for \u65b0\u7d30\u660e\u9ad4 and \u6a19\u6977\u9ad4 -- and confirmed against
 * pdf.js, which agrees codepoint for codepoint. The defect is in the file.
 *
 * Repaired here rather than only warned about, because the reader is where it
 * costs: search misses, copy produces characters nobody can type, and a page
 * read into the model's context teaches it words spelled with codepoints that
 * are not the word. It fixes documents this machine did not write, too.
 *
 * NFKC does the mapping and it is exact -- all 214 Kangxi radicals carry a
 * compatibility decomposition to their unified ideograph. Applied per character
 * and only inside these two blocks: NFKC over the whole string would also fold
 * full-width punctuation to ASCII, and \u300c\uff08\uff09\uff01\u300d are not decoration in Chinese
 * text, they are the punctuation.
 */
/* How many characters the last unifyRadicals() put back.
   Counted rather than inferred: once the text is repaired the damage is
   invisible, and the export warning -- \u300c\u9019\u500b\u5b57\u578b\u8b93 PDF \u7684\u6587\u5b57\u5c64\u6709 N \u8655\u8b8a\u6210\u5eb7\u7199\u90e8
   \u9996\u78bc\u4f4d\u300d -- exists precisely to say that the *file* is still wrong for every
   reader that is not this one. Repairing silently turned a true warning into a
   false all-clear, which was measured the first time: the deck exported, the
   file still had the defect, and nothing said so any more. */
let lastRepaired = 0;

function unifyRadicals(s) {
  lastRepaired = 0;
  return s.replace(/[\u2e80-\u2eff\u2f00-\u2fdf]/g, (c) => {
    const n = c.normalize('NFKC');
    if (n.length === 1 && n !== c) { lastRepaired++; return n; }
    return c;
  });
}

function tidy(s) {
  return unifyRadicals(String(s || ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[\ue000-\uf8ff]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/* ===========================================================================
   VIEWER HOSTING
   ---------------------------------------------------------------------------
   Everything above turns a PDF into text. This part is about showing it.

   Chromium's own PDF plugin was the first attempt and it did not work: inside a
   WebContentsView the plugin's surface never made it into the window, so the
   viewer showed a blank rectangle. Rather than keep guessing at compositing,
   the pages are now drawn by pdf.js into a canvas in an ordinary document,
   which is a thing this project can actually verify by looking at it.

   pdf.js parses the file, so it must not run in the shell's document -- that
   one has a preload bridge and every capability in the machine hanging off it.
   It gets a scheme of its own instead:

     aios-pdf://<token>/viewer.html      the viewer document
     aios-pdf://<token>/viewer.js        what draws the pages
     aios-pdf://<token>/convert.js       what turns them into Markdown
     aios-pdf://<token>/doc.pdf          the bytes of one specific file
     aios-pdf://<token>/lib/<name>       pdf.js and its data files

   The isolation is not a sandbox attribute. `sandbox="allow-scripts"` would put
   the frame in an opaque origin, and then its own same-origin fetch() calls
   become cross-origin and its module worker is refused -- pdf.js stops working
   entirely. What isolates it instead:

     - a separate origin, so it cannot touch the file:// shell document
     - no preload, so there is no `aios` object to reach for
     - a CSP set by this process (see index.js), not by the document
     - connect-src 'self', so the only thing it can fetch is its own token

   THE TOKEN IS THE POINT

   `doc.pdf` resolves to a path recorded when the view was published, after the
   sandbox containment check. The renderer names a file once, through IPC; the
   frame that then parses that file cannot name anything. So a malicious PDF
   that gets code running in the viewer still cannot read a second file, because
   there is no path parameter anywhere in this scheme for it to use.
   =========================================================================== */

const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const VIEW_SCHEME = 'aios-pdf';

/* pdfjs-dist lives in node_modules, which is outside anything the sandbox can
   write. Resolved once, from this file's location, so a different cwd cannot
   change what gets served. */
const LIB_ROOT = path.join(__dirname, '..', '..', 'node_modules', 'pdfjs-dist');

/* Files served from the library, mapped by hand. A mapping table rather than a
   path join because "serve whatever is under node_modules" is a bigger promise
   than this needs to make. */
const LIB_FILES = {
  'pdf.mjs': 'build/pdf.min.mjs',
  'pdf.worker.mjs': 'build/pdf.worker.min.mjs'
};

/* Directories served wholesale, because their contents are looked up by name at
   runtime: 168 CMap files for CJK encodings, the 14 standard font substitutes,
   the wasm image decoders, and one colour profile. Nothing here is optional --
   a CJK PDF without its CMap renders as blanks, which is exactly the failure
   this rewrite exists to remove. */
const LIB_DIRS = {
  cmaps: { dir: 'cmaps', ext: /\.bcmap$/i },
  fonts: { dir: 'standard_fonts', ext: /\.(pfb|ttf|otf)$/i },
  wasm: { dir: 'wasm', ext: /\.(wasm|js)$/i },
  iccs: { dir: 'iccs', ext: /\.icc$/i }
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.icc': 'application/octet-stream'
};

/* A single leaf name: no separators, no dots leading anywhere, nothing that
   could climb out of the directory it is being looked up in. */
const LEAF = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const views = new Map();   // token -> { real, vpath, at }
const prints = new Map();  // token -> { html, at }  documents waiting to be printed

/**
 * Grant one frame the right to read one file.
 *
 * `real` must already have been through sandbox.safe(): this function records a
 * path, it does not check one. The caller is ipc.js, which does the containment
 * check first -- see the pdf:publish handler.
 */
function publishView({ real, vpath }) {
  const abs = String(real || '');
  if (!abs) throw new Error('沒有檔案可以呈現');

  const token = crypto.randomBytes(16).toString('hex');
  views.set(token, { real: abs, vpath: String(vpath || ''), at: Date.now() });

  // A viewer left open for a day is fine; a token left live after every window
  // that used it has gone is just a stale grant. Trim the oldest when the map
  // grows past what a person could plausibly have open.
  if (views.size > 32) {
    const oldest = [...views.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) views.delete(oldest[0]);
  }

  return { url: `${VIEW_SCHEME}://${token}/viewer.html`, token, vpath };
}

function revokeView(token) {
  return views.delete(String(token || ''));
}

/**
 * Resolve a request on the viewer scheme to a file on disk.
 *
 * Returns `{ file, type }` for the caller to stream, or null for anything that
 * is not an exact path this scheme publishes. Never returns a path built from
 * request text: the document's own bytes come from the token record, and library
 * files come from a fixed table.
 */
function serveView(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== VIEW_SCHEME + ':') return null;

  /* A document on its way to becoming a PDF. Served from memory, and under a much
     tighter policy than the viewer needs: it is a static page being measured for
     print, so it has no business running a script or fetching anything.
     Not a file:// URL, which was the obvious alternative and the wrong one -- a
     print document is assembled from document content, and some of that content
     came out of an untrusted PDF. On file:// it could have pulled any readable
     file on the machine into the output through an <img src>. */
  if (u.pathname === '/print.html') {
    const job = prints.get(u.hostname);
    if (!job) return null;
    return {
      body: job.html,
      type: MIME['.html'],
      csp: "default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
           "font-src 'none'; script-src 'none'; object-src 'none'; " +
           "form-action 'none'; base-uri 'none'"
    };
  }

  const rec = views.get(u.hostname);
  if (!rec) return null;

  const p = u.pathname;

  // The viewer document and its script. Real files on disk rather than a string
  // in this module, so they can be read, linted and edited like code.
  if (p === '/viewer.html') {
    return { file: path.join(__dirname, '..', 'renderer', 'pdfview.html'), type: MIME['.html'] };
  }
  if (p === '/viewer.js') {
    return { file: path.join(__dirname, '..', 'renderer', 'pdfview.js'), type: MIME['.js'] };
  }
  if (p === '/convert.js') {
    return { file: path.join(__dirname, '..', 'renderer', 'pdfmd.js'), type: MIME['.js'] };
  }

  /* The rasteriser, which is the viewer's opposite number: same origin, same
     policy, no screen. Loaded by rasterize() below into a window nobody sees. */
  if (p === '/raster.html') {
    return { file: path.join(__dirname, '..', 'renderer', 'pdfraster.html'), type: MIME['.html'] };
  }
  if (p === '/raster.js') {
    return { file: path.join(__dirname, '..', 'renderer', 'pdfraster.js'), type: MIME['.js'] };
  }

  // The one file this token is for. No path in the request.
  if (p === '/doc.pdf') {
    return { file: rec.real, type: MIME['.pdf'] };
  }

  const lib = p.match(/^\/lib\/([A-Za-z0-9._-]+)$/);
  if (lib) {
    const rel = LIB_FILES[lib[1]];
    if (!rel) return null;
    return { file: path.join(LIB_ROOT, ...rel.split('/')), type: MIME['.mjs'] };
  }

  const sub = p.match(/^\/lib\/([a-z]+)\/(.+)$/);
  if (sub) {
    const spec = LIB_DIRS[sub[1]];
    if (!spec) return null;

    const name = decodeURIComponent(sub[2]);
    if (!LEAF.test(name) || !spec.ext.test(name)) return null;

    const dir = path.join(LIB_ROOT, spec.dir);
    const file = path.join(dir, name);

    // LEAF should already have made this impossible. Checked anyway, because the
    // cost of being wrong here is serving an arbitrary file.
    if (path.dirname(file) !== dir) return null;

    return { file, type: MIME[path.extname(name).toLowerCase()] || 'application/octet-stream' };
  }

  return null;
}

/** Read a resolved view file. Kept here so the protocol handler stays short. */
async function readViewFile(file) {
  return fsp.readFile(file);
}

/* ===========================================================================
   PDF OUTPUT
   ---------------------------------------------------------------------------
   The machine could read a PDF and not produce one: documents exported to .docx
   and .md, sheets to .csv and .xlsx, decks to HTML, and nothing to PDF.

   Chromium is already here, so its print engine does the work -- no new
   dependency, and paged layout, page breaks, embedded font subsets and
   selectable text all come with it. The alternative was a JSX-to-PDF renderer
   whose entire selling point is not needing a browser, which is not a problem
   this project has.

   The document is served over the viewer's scheme rather than written to a temp
   file, so a print job cannot reach the filesystem. See the /print.html branch
   in serveView for why that matters.
   =========================================================================== */

const MAX_PRINT_HTML = 8 * 1024 * 1024;

/** Hold one assembled document, addressable only by its token. */
function publishPrint(html) {
  const body = String(html || '');
  if (!body) throw Object.assign(new Error('沒有內容可以列印'), { code: 'EINVAL' });
  if (body.length > MAX_PRINT_HTML) {
    throw Object.assign(new Error('要列印的內容太大'), { code: 'EINVAL' });
  }

  const token = crypto.randomBytes(16).toString('hex');
  prints.set(token, { html: body, at: Date.now() });

  // A job is consumed within seconds. Anything still here is a leak.
  if (prints.size > 8) {
    const oldest = [...prints.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) prints.delete(oldest[0]);
  }

  return { url: `${VIEW_SCHEME}://${token}/print.html`, token };
}

/**
 * Render HTML to PDF bytes.
 *
 * An offscreen window with scripting off: the document is being measured, not
 * run. `preferCSSPageSize` lets the document's own @page rule win, which is how
 * a deck asks for landscape without the caller having to know.
 */
async function toPdf(html, opts = {}) {
  const { BrowserWindow } = require('electron');
  const job = publishPrint(html);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      javascript: false,
      images: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      preload: undefined
    }
  });

  try {
    await win.loadURL(job.url);
    // Give web fonts and any data: images a moment to settle; printToPDF does
    // not wait for them on its own.
    await new Promise((r) => setTimeout(r, 120));

    /* preferCSSPageSize is dropped when a running head is wanted: the engine
       draws the header and footer in the page margin it was given, and with the
       CSS page box authoritative there is no margin it knows the size of, so
       both come out invisible. The caller passes explicit margins in that case. */
    const headerFooter = !!opts.displayHeaderFooter;
    return await win.webContents.printToPDF({
      printBackground: opts.printBackground !== false,
      landscape: !!opts.landscape,
      pageSize: opts.pageSize || 'A4',
      preferCSSPageSize: !headerFooter,
      margins: opts.margins || { marginType: 'default' },
      displayHeaderFooter: headerFooter,
      headerTemplate: opts.headerTemplate || '',
      footerTemplate: opts.footerTemplate || '',
      /* Off for an overlay. A tagged PDF writes `/NonStruct <</MCID 0>> BDC`
         markers into the content stream and a /StructTreeRoot beside it -- and
         an overlay's content stream is about to be lifted out and dropped onto
         somebody else's page, where those MCIDs reference nothing, or worse,
         collide with that page's own /StructParents. An outline is meaningless
         for a document that is one stamp. */
      generateDocumentOutline: opts.outline !== false,
      generateTaggedPDF: opts.tagged !== false
    });
  } finally {
    prints.delete(job.token);
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * Draw a PDF's pages and hand them back as JPEGs.
 *
 * For documents that are pictures. A scan has no text layer, so everything that
 * works by reading a PDF gets nothing from it -- and the reader that can still
 * read it is the model, which needs to be shown the page rather than told about
 * it. Used by the document extractor; see the note above `generate` in
 * extract.js for why the pages go WITH the file rather than instead of it.
 *
 * Offscreen, exactly like toPdf: a window with no screen, destroyed in a
 * `finally`. Unlike toPdf this one has to run a script -- pdf.js is the thing
 * doing the work -- so it gets the viewer's origin and the viewer's policy,
 * which has no http: or https: in it. The page cannot send anything anywhere;
 * the only way a byte leaves is the value this function reads back.
 *
 * The token is minted here and revoked in the `finally`, so the grant lives
 * exactly as long as the window that needs it.
 */
async function rasterize({ real, vpath }, opts = {}) {
  const { BrowserWindow } = require('electron');
  const view = publishView({ real, vpath });

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      javascript: true,
      images: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      preload: undefined
    }
  });

  try {
    /* The token's own page, not the viewer's: publishView hands back a viewer
       URL because that is what every other caller wants, and the grant is on the
       token rather than on a document name. */
    await win.loadURL(`${VIEW_SCHEME}://${view.token}/raster.html`);

    /* Wait for the module to have run, not for a number of milliseconds: it
       pulls in pdf.js and a worker, and how long that takes is a fact about the
       machine rather than about this code. */
    const deadline = Date.now() + 30000;
    for (;;) {
      const ready = await win.webContents.executeJavaScript('!!window.__rasterReady')
        .catch(() => false);
      if (ready) break;
      if (Date.now() > deadline) throw new Error('算繪頁面的視窗沒有備妥');
      await new Promise((r) => setTimeout(r, 50));
    }

    const req = JSON.stringify({ budget: Number(opts.budget) > 0 ? Number(opts.budget) : undefined });
    const out = await win.webContents.executeJavaScript('window.__raster(' + req + ')');
    if (!out || !out.ok) {
      throw Object.assign(new Error((out && out.error) || '算繪頁面失敗'),
        { code: (out && out.code) || 'ERASTER' });
    }
    return out.data;
  } finally {
    revokeView(view.token);
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = {
  read, probe, tidy, parseCMap, decodeTextString, pdfDate,
  publishView, revokeView, serveView, readViewFile, VIEW_SCHEME,
  publishPrint, toPdf, rasterize,
  /* For pdfedit.js. The parser and the emitter are one pair and belong to one
     module; what is built out of them does not. */
  Doc, isDict, isRef, contentTokens,
  writeName, writeNumber, writeString, writeValue, writeObject
};
