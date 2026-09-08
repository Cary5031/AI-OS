'use strict';

/* ===========================================================================
   AI-OS // PDF writer
   ---------------------------------------------------------------------------
   main/pdf.js run backwards. It reads a document that module already parsed and
   writes a new one holding the pages somebody asked for, in the order they
   asked for: split a file into parts, pull a chapter out, drop a page, put two
   files together.

   IT COPIES BYTES, IT DOES NOT RE-ENCODE

   The reader deliberately cannot decode a JPEG, a JBIG2 or a CCITT fax, and it
   does not undo predictors -- none of that is needed to get text out, and the
   header there says so. Which means a writer that round-tripped a stream
   through `streamOf` would hand back a file with every picture missing, and
   report success. So streams are copied as the raw, still-filtered bytes
   (`rawStreamOf`) with their /Filter and /DecodeParms alongside, and this
   module never learns what a JPEG is. The one thing it rewrites is /Length,
   always, because the reader trusts `endstream` over /Length and the two can
   legitimately disagree.

   IT FLATTENS THE PAGE TREE

   Four keys in PDF are inherited from a page's ancestors: /Resources,
   /MediaBox, /CropBox and /Rotate. A page copied out of its document loses
   every one of those ancestors -- that is the point, otherwise /Parent would
   drag the whole original tree and every other page back in with it -- so all
   four are resolved and written onto the page itself. A page that inherited its
   /Resources and did not get them flattened comes out blank.

   IT DROPS WHAT IT CANNOT HONESTLY CARRY, AND SAYS SO

   Outlines, named destinations, the structure tree, article threads and form
   fields all index pages by a number or a reference that this operation
   invalidates. Half a bookmark tree pointing at pages that are gone is worse
   than no bookmark tree, and a structure tree whose /K entries name the wrong
   pages is read by assistive technology as truth. They are dropped, and every
   drop is a warning the caller shows -- the same contract office.js's writers
   have, and for the same reason: a file that quietly lost something is worse
   than one that says what it lost.

   /OCProperties is the exception that proves it. Dropping optional-content
   properties is the unsafe choice: without them a reader draws every marked
   layer, so a layer the original hid becomes visible in the output. It is
   copied whole.

   ACTIVE CONTENT NEVER SURVIVES

   A file this machine wrote is a file the person -- and the model -- will treat
   as one this machine understands. So document and page /AA, /Names
   /JavaScript, /EmbeddedFiles, and every annotation action except a same-file
   /GoTo are dropped unconditionally. /URI reaches the network, /Launch reaches
   the shell, /SubmitForm posts the document somewhere, /GoToR opens another
   file. Carrying any of those forward would hand back exactly the reach that
   serving the viewer one file and no path parameter was written to remove.

   IT REFUSES RATHER THAN MANGLES

   An encrypted file is refused: its streams and strings are ciphertext keyed on
   object number and generation, so renumbering them produces a file that opens
   and renders garbage. A file whose page tree could not be read is refused for
   anything that deletes or reorders, because "page 3" is then a guess and
   deleting the wrong page is not recoverable.

   NO PATH EVER ENTERS THIS MODULE. It takes parsed documents and returns
   bytes; ipc.js reads and writes the sandbox on either side. A page range that
   came out of a PDF must never be able to name an output file.
   =========================================================================== */

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const {
  Doc, isDict, isRef, contentTokens, writeName, writeNumber, writeValue, writeObject
} = require('./pdf');

const MAX_PAGES = 5000;
const MAX_OUT_OBJECTS = 200000;
const MAX_OUT_BYTES = 200 * 1024 * 1024;

/* Only a same-document jump survives. Everything else in this position is a
   way out of the document: to the network, to another file, to the shell. */
const SAFE_ACTION = '/GoTo';

/* Annotation subtypes that cannot be carried without the structures that give
   them meaning, which this writer does not copy. */
const DROP_ANNOT = { '/Widget': 1, '/FileAttachment': 1, '/Movie': 1, '/Screen': 1, '/3D': 1, '/RichMedia': 1 };

/* Keys removed from a page dictionary as it is copied. Each one points at
   something outside the page that is not coming with it. */
const PAGE_DROP = {
  '/Parent': 1,        // rewritten to the new flat /Pages
  '/B': 1,             // article beads, into /Threads
  '/StructParents': 1, // the structure tree
  '/AA': 1,            // page open/close actions: script
  '/Annots': 1         // filtered separately, never copied wholesale
};

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/* ============================================================ page ranges ==

   What a person types when they mean "these pages". Deliberately forgiving
   about separators, because the difference between a comma and a fullwidth
   comma is not something anybody should have to think about, and deliberately
   strict about everything else: a range nobody can read is refused by name
   rather than silently reinterpreted into the wrong pages.
   ========================================================================= */

/**
 * '1-3,7,10-' against a document of `count` pages.
 *
 * Order is kept as written and repeats are kept, so '3,1,1' really does mean
 * page three, then page one, then page one again -- that is how this doubles as
 * the reorder and the duplicate-a-page verb.
 */
function parsePageSpec(spec, count) {
  const text = String(spec == null ? '' : spec)
    .replace(/[，、;]/g, ',')
    .replace(/[－‐-―〜～~]/g, '-')
    .replace(/\s+/g, '');
  if (!text) throw fail('EINVAL', '沒有指定頁碼');

  const out = [];
  for (const part of text.split(',')) {
    if (!part) continue;

    if (part === '-') throw fail('EINVAL', '頁碼看不懂：' + part);

    const dash = part.indexOf('-');
    if (dash < 0) {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 1) throw fail('EINVAL', '頁碼看不懂：' + part);
      if (n > count) throw fail('ERANGE', '第 ' + n + ' 頁超出範圍，這份文件只有 ' + count + ' 頁');
      out.push(n);
      continue;
    }

    const a = part.slice(0, dash);
    const b = part.slice(dash + 1);
    const from = a === '' ? 1 : Number(a);
    const to = b === '' ? count : Number(b);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
      throw fail('EINVAL', '頁碼看不懂：' + part);
    }
    if (from > count || to > count) {
      throw fail('ERANGE', '第 ' + Math.max(from, to) + ' 頁超出範圍，這份文件只有 ' + count + ' 頁');
    }
    /* Backwards is not an error, it is a reversal: '5-1' is a legitimate way to
       ask for those pages in the other order. */
    if (from <= to) for (let n = from; n <= to; n++) out.push(n);
    else for (let n = from; n >= to; n--) out.push(n);
  }

  if (!out.length) throw fail('EINVAL', '沒有選到任何頁');
  if (out.length > MAX_PAGES) throw fail('ERANGE', '一次最多 ' + MAX_PAGES + ' 頁');
  return out;
}

/** Every page except these -- how "delete page 4" is expressed. */
function invertPageSpec(spec, count) {
  const drop = new Set(parsePageSpec(spec, count));
  const out = [];
  for (let n = 1; n <= count; n++) if (!drop.has(n)) out.push(n);
  if (!out.length) throw fail('EINVAL', '這樣會把所有頁都刪掉，留不下任何一頁');
  return out;
}

/**
 * Consecutive groups of `size` pages: the "split every N pages" verb.
 *
 * Returns `[[1,2,3],[4,5,6],…]`, the last group short if it does not divide.
 */
function everyGroups(size, count) {
  const n = Number(size);
  if (!Number.isInteger(n) || n < 1) throw fail('EINVAL', '每份幾頁要是大於 0 的整數');
  if (count < 1) throw fail('EINVAL', '這份文件沒有頁面');
  const out = [];
  for (let at = 1; at <= count; at += n) {
    const group = [];
    for (let k = at; k < at + n && k <= count; k++) group.push(k);
    out.push(group);
  }
  return out;
}

/* ============================================================== the copier ==

   One worklist, keyed by source index and object number so that a merge of
   several documents cannot collide. A reference is remapped -- and its target
   queued -- before the target is serialised, which is what makes a
   self-referencing object terminate rather than recurse forever.
   ========================================================================= */

function writePages(sources, opts = {}) {
  const list = (Array.isArray(sources) ? sources : []).filter((s) => s && s.doc);
  if (!list.length) throw fail('EINVAL', '沒有可以寫出的來源');

  const warnings = [];
  const note = (msg) => {
    if (warnings.length < 32 && !warnings.includes(msg)) warnings.push(msg);
  };

  /* ---------------------------------------------------- choose the pages */

  const chosen = [];      // { srcIndex, doc, entry }
  list.forEach((src, srcIndex) => {
    const doc = src.doc;
    if (!(doc instanceof Doc)) throw fail('EINVAL', '來源不是解析過的 PDF');
    if (doc.encrypted) throw fail('EENCRYPTED', '這份 PDF 有加密保護，不能改寫');

    const entries = doc.pageEntries();
    if (!entries.length) throw fail('ENOPAGES', '這份 PDF 讀不到任何頁面');

    const want = Array.isArray(src.pages) && src.pages.length
      ? src.pages
      : entries.map((_e, i) => i + 1);

    /* A tree this module had to guess at makes every page number a guess. Say
       so once; the caller decides whether a guess is good enough for what it is
       about to do, and ipc.js refuses the destructive verbs on it. */
    if (doc.pageTreeGuessed) note('原檔的頁面樹讀不到，頁序是依檔案中出現的順序推測的');

    for (const n of want) {
      const entry = entries[n - 1];
      if (!entry) throw fail('ERANGE', '第 ' + n + ' 頁超出範圍');
      if (!entry.dict || !Object.keys(entry.dict).length) {
        throw fail('EPAGE', '第 ' + n + ' 頁讀不出內容，沒有寫出空白頁');
      }
      chosen.push({ srcIndex, doc, entry });
    }

    if (doc.trailer['/Encrypt'] !== undefined) throw fail('EENCRYPTED', '這份 PDF 有加密保護，不能改寫');
  });

  if (!chosen.length) throw fail('EINVAL', '沒有選到任何頁');
  if (chosen.length > MAX_PAGES) throw fail('ERANGE', '一次最多 ' + MAX_PAGES + ' 頁');

  /* ------------------------------------------------------------ numbering

     1 is the catalogue and 2 is the flat /Pages, then the pages themselves in
     order. Pages are numbered before anything is copied so that a link
     annotation pointing at a page in the set can be rewritten during the copy
     rather than in a second pass. */

  const CATALOG = 1;
  const PAGES = 2;
  let next = 3;

  const assigned = new Map();      // 'srcIndex:num' -> newNum
  const pageNewNum = [];           // parallel to `chosen`
  const queue = [];                // { srcIndex, doc, num, newNum }

  chosen.forEach((c) => {
    const newNum = next++;
    pageNewNum.push(newNum);
    if (c.entry.num !== null) assigned.set(c.srcIndex + ':' + c.entry.num, newNum);
  });

  /** The new number for a reference, queueing its target the first time. */
  function remap(srcIndex, doc, num) {
    const key = srcIndex + ':' + num;
    const hit = assigned.get(key);
    if (hit !== undefined) return { ref: hit };
    if (next > MAX_OUT_OBJECTS) throw fail('ERANGE', '這份 PDF 的物件太多了');
    const newNum = next++;
    assigned.set(key, newNum);
    queue.push({ srcIndex, doc, num, newNum });
    return { ref: newNum };
  }

  /**
   * Is this reference a page or a page-tree node?
   *
   * The safety net under the whole traversal. /Parent and /Annots are pruned by
   * name, but a reference to a page can turn up anywhere -- a destination, a
   * /P back-pointer, a producer's own private key -- and following one would
   * drag a page that was not asked for into the output, and through its
   * /Parent, the entire original document. So any page reference that is not
   * one of the kept pages becomes null.
   */
  function pageLike(doc, num) {
    const obj = doc.objects.get(num);
    if (!obj || !isDict(obj.value)) return false;
    const t = obj.value.dict['/Type'];
    return t === '/Page' || t === '/Pages';
  }

  /* --------------------------------------------------------- copy a value */

  function copyValue(srcIndex, doc, v, depth) {
    if (depth > 64) return null;
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map((x) => copyValue(srcIndex, doc, x, depth + 1));

    if (isRef(v)) {
      const key = srcIndex + ':' + v.ref;
      if (assigned.has(key)) return { ref: assigned.get(key) };
      if (pageLike(doc, v.ref)) {
        note('有指向沒被選到的頁的參照，已移除');
        return null;
      }
      if (!doc.objects.get(v.ref)) {
        /* A reference with nothing behind it. Usually an /ObjStm the reader
           could not inflate, which it drops without a word. Writing null keeps
           the file structurally sound and the cross-reference table contiguous. */
        note('原檔有指向不存在物件的參照，已寫成 null');
        return null;
      }
      return remap(srcIndex, doc, v.ref);
    }

    if (v && typeof v.str === 'string') return v;

    if (isDict(v)) {
      const out = {};
      for (const k of Object.keys(v.dict)) {
        const val = v.dict[k];
        /* A keyword where a value belongs means the parser resynchronised over
           damage. It is a marker, not data; writing it back would corrupt the
           dictionary around it. */
        if (val && typeof val === 'object' && typeof val.op === 'string') {
          note('原檔有讀不懂的欄位，已略過');
          continue;
        }
        out[k] = copyValue(srcIndex, doc, val, depth + 1);
      }
      return { dict: out };
    }

    return null;
  }

  /* ---------------------------------------------------- annotations */

  /** The action on an annotation, if it is one that may survive. */
  function safeAction(doc, a) {
    const d = doc.dictOf(a);
    if (!d) return null;
    if (d['/S'] !== SAFE_ACTION) return null;
    return d;
  }

  function copyAnnots(srcIndex, doc, page, selfRef) {
    const raw = doc.get(page['/Annots']);
    if (!Array.isArray(raw) || !raw.length) return null;

    const kept = [];
    let dropped = 0;
    let unsafe = 0;

    for (const a of raw) {
      const d = doc.dictOf(a);
      if (!d) { dropped++; continue; }
      if (DROP_ANNOT[d['/Subtype']]) { dropped++; continue; }

      const copy = {};
      let lost = false;

      for (const k of Object.keys(d)) {
        if (k === '/P') { copy['/P'] = { ref: selfRef }; continue; }
        if (k === '/StructParent') continue;
        if (k === '/AA') { unsafe++; continue; }

        if (k === '/A') {
          const act = safeAction(doc, d[k]);
          if (!act) { unsafe++; continue; }
          /* A same-file jump, and only if it lands on a page that is here. */
          const dest = doc.get(act['/D']);
          const target = Array.isArray(dest) && isRef(dest[0])
            ? assigned.get(srcIndex + ':' + dest[0].ref)
            : undefined;
          if (target === undefined) { lost = true; continue; }
          copy['/A'] = {
            dict: {
              '/S': SAFE_ACTION,
              '/D': [{ ref: target }, ...dest.slice(1).map((x) => copyValue(srcIndex, doc, x, 1))]
            }
          };
          continue;
        }

        if (k === '/Dest') {
          const dest = doc.get(d[k]);
          const target = Array.isArray(dest) && isRef(dest[0])
            ? assigned.get(srcIndex + ':' + dest[0].ref)
            : undefined;
          if (target === undefined) { lost = true; continue; }
          copy['/Dest'] = [{ ref: target }, ...dest.slice(1).map((x) => copyValue(srcIndex, doc, x, 1))];
          continue;
        }

        copy[k] = copyValue(srcIndex, doc, d[k], 1);
      }

      /* A link whose destination is gone is not a link. Keeping it would put a
         clickable rectangle on the page that does nothing. */
      if (lost && d['/Subtype'] === '/Link') { dropped++; continue; }

      kept.push({ dict: copy });
    }

    if (dropped) note('有 ' + dropped + ' 個註解指向被刪掉的頁或需要表單欄位，已移除');
    if (unsafe) note('有 ' + unsafe + ' 個註解帶著開啟檔案或連網的動作，動作已移除');
    return kept.length ? kept : null;
  }

  /* ---------------------------------------------------------- copy a page */

  function copyPage(srcIndex, doc, entry, selfRef) {
    const d = entry.dict;
    const out = { '/Type': '/Page', '/Parent': { ref: PAGES } };

    for (const k of Object.keys(d)) {
      if (PAGE_DROP[k]) continue;
      if (k === '/Type') continue;
      out[k] = copyValue(srcIndex, doc, d[k], 1);
    }

    /* The four inheritable keys, resolved. A page that omitted one because an
       ancestor supplied it has just lost that ancestor. */
    const inh = entry.inherited || {};
    if (out['/Resources'] === undefined && inh.resources != null) {
      out['/Resources'] = copyValue(srcIndex, doc, inh.resources, 1);
    }
    if (out['/MediaBox'] === undefined && inh.mediaBox != null) {
      out['/MediaBox'] = copyValue(srcIndex, doc, inh.mediaBox, 1);
    }
    if (out['/CropBox'] === undefined && inh.cropBox != null) {
      out['/CropBox'] = copyValue(srcIndex, doc, inh.cropBox, 1);
    }
    if (out['/Rotate'] === undefined && inh.rotate) {
      out['/Rotate'] = copyValue(srcIndex, doc, inh.rotate, 1);
    }
    /* Every reader needs a page size. Without one a viewer falls back to US
       Letter and the content sits in the wrong place on the paper. */
    if (out['/MediaBox'] === undefined) {
      out['/MediaBox'] = [0, 0, 595.28, 841.89];
      note('原檔沒有指定頁面大小，已設為 A4');
    }
    if (out['/Resources'] === undefined) out['/Resources'] = { dict: {} };

    const annots = copyAnnots(srcIndex, doc, d, selfRef);
    if (annots) out['/Annots'] = annots;

    return { dict: out };
  }

  /* ------------------------------------------------------------- the build */

  const objects = new Map();   // newNum -> { value, raw }

  chosen.forEach((c, i) => {
    objects.set(pageNewNum[i], { value: copyPage(c.srcIndex, c.doc, c.entry, pageNewNum[i]), raw: null });
  });

  /* Drain. copyValue pushes onto `queue` as it meets new references, so this
     grows while it is being walked -- which is the point. */
  let guard = 0;
  while (queue.length) {
    if (++guard > MAX_OUT_OBJECTS) throw fail('ERANGE', '這份 PDF 的物件太多了');
    const job = queue.shift();
    const obj = job.doc.objects.get(job.num);
    if (!obj) { objects.set(job.newNum, { value: null, raw: null }); continue; }

    const value = copyValue(job.srcIndex, job.doc, obj.value, 0);
    let raw = null;

    if (obj.streamStart >= 0) {
      raw = job.doc.rawStreamOf(obj);
      /* The reader stops a stream at `endstream` rather than at /Length, so a
         stream whose payload happens to contain those nine bytes comes back
         short. When /Length is a number and `endstream` really is where it
         says, /Length is the better answer. */
      const declared = job.doc.num(isDict(obj.value) ? obj.value.dict['/Length'] : null);
      if (declared !== null && declared > raw.length) {
        const at = obj.streamStart + declared;
        const tail = job.doc.s.slice(at, at + 12);
        if (/^\s*endstream/.test(tail)) {
          raw = job.doc.buf.subarray(obj.streamStart, at);
          note('原檔有串流的長度與 endstream 位置不一致，已依 /Length 取回完整內容');
        } else {
          note('原檔有串流的長度與實際位元組不一致，已依實際位元組重寫');
        }
      }
    }

    objects.set(job.newNum, { value, raw });
  }

  /* -------------------------------------------------- catalogue and pages */

  const catalog = { '/Type': '/Catalog', '/Pages': { ref: PAGES } };

  /* Copied from the first source that has them: they describe how to display a
     document rather than what is in it, so they survive a page selection. */
  const first = list[0].doc;
  const rootDict = first.dictOf(first.trailer['/Root']) || {};
  for (const k of ['/Lang', '/PageLayout', '/ViewerPreferences', '/OCProperties']) {
    if (rootDict[k] === undefined) continue;
    const v = copyValue(0, first, rootDict[k], 1);
    if (v !== null) catalog[k] = v;
  }
  /* Drain again: /OCProperties in particular pulls a subgraph of optional
     content groups, and every one of them has to be written out too. */
  while (queue.length) {
    if (++guard > MAX_OUT_OBJECTS) throw fail('ERANGE', '這份 PDF 的物件太多了');
    const job = queue.shift();
    const obj = job.doc.objects.get(job.num);
    if (!obj) { objects.set(job.newNum, { value: null, raw: null }); continue; }
    objects.set(job.newNum, {
      value: copyValue(job.srcIndex, job.doc, obj.value, 0),
      raw: obj.streamStart >= 0 ? job.doc.rawStreamOf(obj) : null
    });
  }

  /* A sidebar opening onto a tree that was dropped looks broken. */
  const mode = rootDict['/PageMode'];
  if (mode && mode !== '/UseOutlines' && mode !== '/UseAttachments' && mode !== '/UseOC') {
    catalog['/PageMode'] = mode;
  }

  if (rootDict['/Outlines'] !== undefined) note('原檔的書籤大綱沒有保留');
  if (rootDict['/AcroForm'] !== undefined) note('原檔的表單欄位沒有保留；若原檔有數位簽章，改寫後也會失效');
  if (rootDict['/StructTreeRoot'] !== undefined) note('原檔的結構標籤（無障礙資訊）沒有保留');
  if (rootDict['/Names'] !== undefined) note('原檔的具名目的地、附件與文件層級指令碼沒有保留');
  if (rootDict['/AA'] !== undefined || rootDict['/OpenAction'] !== undefined) {
    note('原檔的開啟動作沒有保留');
  }

  const pagesNode = {
    '/Type': '/Pages',
    '/Kids': pageNewNum.map((n) => ({ ref: n })),
    '/Count': pageNewNum.length
  };

  /* Written fresh, never copied: the original's /Info describes the original,
     and a new file should not claim somebody else's authorship or a creation
     date it does not have. */
  const infoNum = next++;
  const info = {
    '/Producer': { str: 'AI-OS' },
    '/CreationDate': { str: pdfNow() }
  };
  if (opts.title) info['/Title'] = { str: utf16(String(opts.title)) };

  objects.set(CATALOG, { value: { dict: catalog }, raw: null });
  objects.set(PAGES, { value: { dict: pagesNode }, raw: null });
  objects.set(infoNum, { value: { dict: info }, raw: null });

  return {
    buffer: assemble(objects, next - 1, CATALOG, infoNum),
    warnings,
    pageCount: pageNewNum.length
  };
}

/* ============================================================== assembling ==

   A classic file: a plain cross-reference table, no xref stream and no object
   streams. Both readers that matter take it -- pdf.js treats a plain table as
   the baseline, and this project's own reader ignores the table entirely and
   scans for objects -- and it is the shape that can be checked by eye when
   something is wrong.
   ========================================================================= */

function assemble(objects, maxNum, rootNum, infoNum) {
  const parts = [];
  let at = 0;
  const push = (buf) => { parts.push(buf); at += buf.length; };

  push(Buffer.from('%PDF-1.7\n', 'latin1'));
  /* Four bytes above 127 on the second line. Without them a transport that
     sniffs the head of a file can decide it is text and mangle the line
     endings, which destroys every stream in it. */
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets = new Map();
  for (let num = 1; num <= maxNum; num++) {
    const rec = objects.get(num);
    if (!rec) continue;                       // a gap: written as free below
    offsets.set(num, at);
    push(writeObject(num, rec.value, rec.raw));
    if (at > MAX_OUT_BYTES) throw fail('ERANGE', '產生的 PDF 太大了');
  }

  const xrefAt = at;
  const rows = ['xref\n0 ' + (maxNum + 1) + '\n', '0000000000 65535 f \n'];
  for (let num = 1; num <= maxNum; num++) {
    const off = offsets.get(num);
    rows.push(off === undefined
      ? '0000000000 65535 f \n'
      : String(off).padStart(10, '0') + ' 00000 n \n');
  }
  push(Buffer.from(rows.join(''), 'latin1'));

  const id = crypto.randomBytes(16).toString('hex').toUpperCase();
  push(Buffer.from(
    'trailer\n<< /Size ' + (maxNum + 1) +
    ' /Root ' + rootNum + ' 0 R' +
    ' /Info ' + infoNum + ' 0 R' +
    ' /ID [<' + id + '> <' + id + '>] >>\n' +
    'startxref\n' + xrefAt + '\n%%EOF\n', 'latin1'));

  return Buffer.concat(parts);
}

/** A PDF date for right now, in the only format the spec defines. */
function pdfNow() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  return 'D:' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
    sign + p(Math.floor(Math.abs(off) / 60)) + "'" + p(Math.abs(off) % 60) + "'";
}

/**
 * A text string a PDF reader will show correctly in any script.
 *
 * PDFDocEncoding covers Latin and nothing else, so a Traditional Chinese title
 * written in it comes out as mojibake in every viewer. The alternative the spec
 * gives is UTF-16BE behind a byte-order mark, which is what this writes.
 */
function utf16(s) {
  let out = 'þÿ';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c > 0xffff) {
      const v = c - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out += String.fromCharCode(hi >> 8, hi & 0xff, lo >> 8, lo & 0xff);
    } else {
      out += String.fromCharCode(c >> 8, c & 0xff);
    }
  }
  return out;
}

/* ================================================================ stamping ==

   Putting something new onto a page that already exists: a note, a heading, a
   highlight over a paragraph.

   THE NEW CONTENT IS DRAWN BY CHROMIUM, NOT BY THIS FILE

   Writing text into a PDF means embedding a font, and embedding a font that can
   set Traditional Chinese means subsetting a 20 MB CJK TrueType and building
   the CID maps to address it. Chromium already does all of that, correctly,
   every time this machine exports a PDF. So the overlay is laid out as HTML at
   the exact size of the target page, run through the existing `toPdf`, and the
   one-page document that comes back is imported here as a form XObject. Fonts,
   shaping, colour and transparency all arrive for free, and the text stays
   selectable and searchable in the finished file -- which no annotation route
   would have given.

   WHY A FORM XOBJECT AND NOT A CONCATENATED STREAM

   Chromium's content stream opens with an unbalanced top-level `cm` -- a flip
   and a 300-dpi scale it never undoes, because nothing follows it in a document
   of its own. Concatenated onto somebody else's page that transform would apply
   to everything after it. A form has an implicit save and restore around `Do`,
   so it cannot leak.

   The other direction has to be guarded explicitly: the target page's own
   content may leave the graphics stack unbalanced, and then the overlay is
   drawn under whatever transform was left behind. So the page's net q/Q depth
   is counted and unwound before the stamp is drawn.

   IT IS AN INCREMENTAL UPDATE, NOT A REWRITE

   The original bytes are kept exactly as they are and the new objects are
   appended after them. That is what keeps the bookmarks, the form fields, the
   structure tree and the attachments that `writePages` above has to drop --
   they are still in the file, untouched, because nothing was copied.
   ========================================================================= */

/* A form name that cannot collide with the page's own: stamping twice adds
   /AiosOvl1 and then /AiosOvl2, and neither is a name a producer would emit. */
const OVL_PREFIX = '/AiosOvl';

/** A box as four ascending numbers, or null. */
function normBox(doc, v) {
  const arr = doc.get(v);
  if (!Array.isArray(arr) || arr.length !== 4) return null;
  const n = arr.map((x) => doc.num(x));
  if (n.some((x) => x === null || !Number.isFinite(x))) return null;
  return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
}

/**
 * Where to put the overlay, given which way the page is turned.
 *
 * The sheet is laid out over the page as a reader sees it -- that is the only
 * corner a person can point at -- but a form is drawn in the page's own
 * unturned coordinates, and /Rotate is applied afterwards by the reader. So on
 * a turned page the two spaces differ and the difference has to be undone here,
 * or a note lands off the paper and sideways.
 *
 * Derived rather than guessed: /Rotate 90 means the page is shown turned a
 * quarter clockwise, so its left edge becomes the top. Sending the sheet's
 * bottom-left corner through each matrix should land on the page corner that
 * ends up bottom-left after that turn -- 90 puts it at the page's bottom-right,
 * 180 at the top-right, 270 at the top-left. The box origin is added last,
 * because a page whose box does not start at 0,0 is offset in page space by
 * exactly that much whichever way it is turned.
 */
function placeMatrix(box, rotate) {
  const x0 = box[0];
  const y0 = box[1];
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  const r = ((Math.round((rotate || 0) / 90) * 90) % 360 + 360) % 360;

  if (r === 90) return [0, 1, -1, 0, x0 + w, y0];
  if (r === 180) return [-1, 0, 0, -1, x0 + w, y0 + h];
  if (r === 270) return [0, -1, 1, 0, x0, y0 + h];
  return [1, 0, 0, 1, x0, y0];
}

/** How unbalanced the page's own content leaves the graphics stack. */
function graphicsDepth(content) {
  let depth = 0;
  let deepest = 0;
  for (const tok of contentTokens(content)) {
    if (!tok || typeof tok !== 'object' || !tok.op) continue;
    if (tok.op === 'q') { depth++; if (depth > deepest) deepest = depth; }
    else if (tok.op === 'Q' && depth > 0) depth--;
  }
  /* An inline image's binary payload can look like operators to a tokeniser --
     `BI … ID <bytes> EI` is the one place a content stream stops being tokens --
     so an absurd count means the scan went wrong, not that the page really is
     forty levels deep. Fall back to unwinding nothing, which is what a balanced
     page needs anyway. */
  if (depth < 0 || depth > 32 || deepest > 256) return 0;
  return depth;
}

/** The highest object number in a document, so new ones start above it. */
function topObject(doc) {
  let top = 0;
  for (const num of doc.objects.keys()) if (num > top) top = num;
  return top;
}

/** Where the file's last cross-reference section starts, for /Prev. */
function lastStartXref(doc) {
  const tail = doc.s.slice(Math.max(0, doc.s.length - 4096));
  let at = -1;
  const re = /startxref\s+(\d+)/g;
  let m;
  while ((m = re.exec(tail))) at = Number(m[1]);
  return at >= 0 && at < doc.buf.length ? at : null;
}

/**
 * Draw one-page overlay documents onto the pages of another document.
 *
 * `stamps` is `[{ page, overlay }]` -- a 1-based page number in the target and
 * the bytes of a one-page PDF the same size as that page. Several stamps may
 * name the same page; each becomes its own form and they compose in order.
 */
function stamp(targetBuf, stamps, opts = {}) {
  const doc = new Doc(targetBuf);
  if (doc.encrypted) throw fail('EENCRYPTED', '這份 PDF 有加密保護，不能改寫');

  const list = (Array.isArray(stamps) ? stamps : []).filter((s) => s && Buffer.isBuffer(s.overlay));
  if (!list.length) throw fail('EINVAL', '沒有要蓋上去的內容');

  const entries = doc.pageEntries();
  if (!entries.length) throw fail('ENOPAGES', '這份 PDF 讀不到任何頁面');
  if (doc.pageTreeGuessed) {
    throw fail('EGUESS', '這份 PDF 的頁面樹讀不出來，頁碼只能用檔案順序推測，所以不蓋上去');
  }

  const prev = lastStartXref(doc);
  if (prev === null) {
    throw fail('ENOXREF', '這份 PDF 沒有可以接續的交叉參照表，改用「抽出頁面」另存一份');
  }

  const warnings = [];
  const note = (msg) => {
    if (warnings.length < 32 && !warnings.includes(msg)) warnings.push(msg);
  };

  let next = topObject(doc) + 1;
  const out = new Map();              // num -> { value, raw }
  const byPage = new Map();           // page index -> [formNum, …]

  for (const s of list) {
    const idx = Number(s.page) - 1;
    const entry = entries[idx];
    if (!entry) throw fail('ERANGE', '第 ' + s.page + ' 頁超出範圍');
    if (entry.num === null) throw fail('EPAGE', '第 ' + s.page + ' 頁沒有自己的物件編號，不能蓋上去');

    const ov = new Doc(s.overlay);
    if (ov.encrypted) throw fail('EINVAL', '要蓋上去的內容讀不出來');
    const ovPages = ov.pageEntries();
    if (!ovPages.length) throw fail('EINVAL', '要蓋上去的內容沒有頁面');
    const ovPage = ovPages[0];

    /* The overlay's resources are a graph, not a dictionary: a font reaches a
       descendant font, a descriptor and an embedded file, and Chromium nests
       blended content in forms of its own. All of it is copied into this
       document's numbering. */
    const remap = new Map();
    const queue = [];
    const take = (num) => {
      if (remap.has(num)) return { ref: remap.get(num) };
      const to = next++;
      remap.set(num, to);
      queue.push({ from: num, to });
      return { ref: to };
    };
    const copy = (v, depth) => {
      if (depth > 64) return null;
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
      if (Array.isArray(v)) return v.map((x) => copy(x, depth + 1));
      if (isRef(v)) return ov.objects.get(v.ref) ? take(v.ref) : null;
      if (v && typeof v.str === 'string') return v;
      if (isDict(v)) {
        const d = {};
        for (const k of Object.keys(v.dict)) {
          const val = v.dict[k];
          if (val && typeof val === 'object' && typeof val.op === 'string') continue;
          d[k] = copy(val, depth + 1);
        }
        return { dict: d };
      }
      return null;
    };

    const ovResources = copy(
      ovPage.dict['/Resources'] !== undefined ? ovPage.dict['/Resources'] : ovPage.inherited.resources,
      1);

    while (queue.length) {
      const job = queue.shift();
      const obj = ov.objects.get(job.from);
      if (!obj) { out.set(job.to, { value: null, raw: null }); continue; }
      /* Raw, so a 13 KB deflated font subset is not inflated to 678 KB on its
         way through. Same rule as writePages above, same reason. */
      out.set(job.to, {
        value: copy(obj.value, 0),
        raw: obj.streamStart >= 0 ? ov.rawStreamOf(obj) : null
      });
    }

    /* Through normBox like the target's, so a sheet whose box was written
       descending is not read as a negative size. */
    const mediaBox = normBox(ov, ovPage.dict['/MediaBox'] !== undefined
      ? ovPage.dict['/MediaBox'] : ovPage.inherited.mediaBox) || [0, 0, 595.28, 841.89];

    const formNum = next++;
    const body = Buffer.from(ov.contentOf(ovPage), 'latin1');
    out.set(formNum, {
      value: {
        dict: {
          '/Type': '/XObject',
          '/Subtype': '/Form',
          '/BBox': mediaBox.length === 4 ? mediaBox : [0, 0, 595.28, 841.89],
          '/Resources': ovResources === null ? { dict: {} } : ovResources,
          '/Filter': '/FlateDecode'
        }
      },
      raw: zlib.deflateSync(body)
    });

    if (!byPage.has(idx)) byPage.set(idx, []);
    byPage.get(idx).push({ num: formNum, box: mediaBox });
  }

  /* --------------------------------------------------- rewrite each page */

  for (const [idx, forms] of byPage) {
    const entry = entries[idx];
    const page = entry.dict;

    /* The page's resources, as a dictionary of its own. Written direct rather
       than as a new version of whatever object held them, because that object
       is very often shared by every page in the document and adding a form to
       it would put the stamp on all of them. The values inside stay indirect
       and still point at the same objects -- this is the same file. */
    const res = { ...(doc.dictOf(entry.inherited.resources) || {}) };
    const xobjects = { ...(doc.dictOf(res['/XObject']) || {}) };
    let n = 1;
    const names = [];
    for (const form of forms) {
      while (xobjects[OVL_PREFIX + n] !== undefined) n++;
      const name = OVL_PREFIX + n++;
      xobjects[name] = { ref: form.num };
      names.push({ name, box: form.box });
    }
    res['/XObject'] = { dict: xobjects };

    /* The box a reader shows this page with -- a /CropBox where there is one,
       the /MediaBox otherwise -- because that is the box the caller laid the
       sheet out over. Using the media box here while the viewer used the crop
       box is how a stamp lands a few millimetres out on a document trimmed for
       print, which is exactly the kind of wrong nobody notices until it is
       printed. */
    const media = normBox(doc, entry.inherited.mediaBox) || [0, 0, 595.28, 841.89];
    const crop = normBox(doc, entry.inherited.cropBox);
    /* Intersected, not just preferred. The spec says a /CropBox lies inside the
       /MediaBox and files exist that say otherwise; pdf.js intersects the two,
       so a reader lays the page out at the intersection while a writer that
       took the crop box raw would place the sheet against something bigger. */
    const pageBox = crop ? [
      Math.max(crop[0], media[0]), Math.max(crop[1], media[1]),
      Math.min(crop[2], media[2]), Math.min(crop[3], media[3])
    ] : media;
    const rotate = doc.num(entry.inherited.rotate) || 0;
    const place = placeMatrix(pageBox, rotate);

    /* A sheet that is not the size of the page it is going onto lands in the
       wrong place, silently: it is drawn from a corner either way. Said rather
       than corrected, because the caller knows what it meant and this does not. */
    const turned = ((Math.round(rotate / 90) * 90) % 360 + 360) % 360;
    const flip = turned === 90 || turned === 270;
    const wantW = flip ? pageBox[3] - pageBox[1] : pageBox[2] - pageBox[0];
    const wantH = flip ? pageBox[2] - pageBox[0] : pageBox[3] - pageBox[1];
    for (const nm of names) {
      const gotW = nm.box[2] - nm.box[0];
      const gotH = nm.box[3] - nm.box[1];
      if (Math.abs(gotW - wantW) > 1 || Math.abs(gotH - wantH) > 1) {
        note('第 ' + (idx + 1) + ' 頁蓋上去的內容尺寸和頁面不一樣（' +
          Math.round(gotW) + '×' + Math.round(gotH) + ' 對 ' +
          Math.round(wantW) + '×' + Math.round(wantH) + ' 點），位置可能不對');
      }
    }

    const depth = graphicsDepth(doc.contentOf(entry));
    if (depth) note('第 ' + (idx + 1) + ' 頁原本的繪圖狀態沒有收乾淨，已先還原再蓋');

    /* One `q` in front of everything the page already draws, and the matching
       `Q` -- plus however many the page itself left open -- after it. Then the
       stamp, at the page's own coordinates. */
    const preNum = next++;
    const postNum = next++;
    out.set(preNum, {
      value: { dict: { '/Filter': '/FlateDecode' } },
      raw: zlib.deflateSync(Buffer.from('q\n', 'latin1'))
    });
    out.set(postNum, {
      value: { dict: { '/Filter': '/FlateDecode' } },
      raw: zlib.deflateSync(Buffer.from(
        'Q\n'.repeat(depth + 1) +
        names.map((nm) => 'q ' + place.map(writeNumber).join(' ') + ' cm ' +
          writeName(nm.name) + ' Do Q\n').join(''), 'latin1'))
    });

    const current = doc.get(page['/Contents']);
    const contents = [{ ref: preNum }];
    if (Array.isArray(current)) {
      for (const c of current) contents.push(c);
    } else if (isRef(page['/Contents'])) {
      contents.push(page['/Contents']);
    } else if (page['/Contents'] !== undefined) {
      note('第 ' + (idx + 1) + ' 頁的內容不是串流參照，蓋上去的東西可能位置不對');
    }
    contents.push({ ref: postNum });

    const newPage = { ...page, '/Contents': contents, '/Resources': { dict: res } };
    /* The four inheritable keys are read off the tree by every reader, and this
       page keeps its /Parent, so only /Resources needed flattening -- it was
       replaced above and would otherwise still be inherited. */
    out.set(entry.num, { value: { dict: newPage }, raw: null });
  }

  return {
    buffer: appendUpdate(doc, out, prev, opts),
    warnings,
    pages: [...byPage.keys()].map((i) => i + 1)
  };
}

/**
 * The original file, then the new objects, then a cross-reference section that
 * points at them and chains to the one that was already there.
 *
 * Subsections rather than one run from zero: the new objects are a handful at
 * the top of the numbering, and claiming every number below them would mean
 * writing offsets for objects this update never touched.
 */
function appendUpdate(doc, objects, prev, opts) {
  const parts = [doc.buf];
  let at = doc.buf.length;
  /* A file that does not end in a newline would otherwise run `%%EOF` straight
     into the first `N 0 obj`. */
  if (doc.buf[at - 1] !== 0x0a) { parts.push(Buffer.from('\n', 'latin1')); at++; }

  const nums = [...objects.keys()].sort((a, b) => a - b);
  const offsets = new Map();
  for (const num of nums) {
    const rec = objects.get(num);
    offsets.set(num, at);
    const buf = writeObject(num, rec.value, rec.raw);
    parts.push(buf);
    at += buf.length;
    if (at > MAX_OUT_BYTES) throw fail('ERANGE', '產生的 PDF 太大了');
  }

  const xrefAt = at;
  let table = 'xref\n';
  let i = 0;
  while (i < nums.length) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    table += nums[i] + ' ' + (j - i + 1) + '\n';
    for (let k = i; k <= j; k++) {
      table += String(offsets.get(nums[k])).padStart(10, '0') + ' 00000 n \n';
    }
    i = j + 1;
  }

  const root = doc.trailer['/Root'];
  const info = doc.trailer['/Info'];
  const id = doc.get(doc.trailer['/ID']);
  const fresh = crypto.randomBytes(16).toString('hex').toUpperCase();

  let trailer = 'trailer\n<< /Size ' + (nums[nums.length - 1] + 1) +
    ' /Prev ' + prev +
    (isRef(root) ? ' /Root ' + root.ref + ' 0 R' : '') +
    (isRef(info) ? ' /Info ' + info.ref + ' 0 R' : '');
  /* The first half of /ID identifies the document and must not change across an
     update; the second half identifies this revision and must. */
  if (Array.isArray(id) && id[0] && typeof id[0].str === 'string') {
    trailer += ' /ID [' + writeValue(id[0]) + ' <' + fresh + '>]';
  } else {
    trailer += ' /ID [<' + fresh + '> <' + fresh + '>]';
  }
  trailer += ' >>\nstartxref\n' + xrefAt + '\n%%EOF\n';

  parts.push(Buffer.from(table + trailer, 'latin1'));
  return Buffer.concat(parts);
}

module.exports = {
  writePages, stamp, parsePageSpec, invertPageSpec, everyGroups,
  graphicsDepth, placeMatrix,
  MAX_PAGES,
  /* For the tests, which check the emitter's edge cases directly rather than
     inferring them from a finished file. */
  assemble, utf16, writeName, writeValue
};
