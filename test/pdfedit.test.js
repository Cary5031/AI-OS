'use strict';

/* ===========================================================================
   Writing PDFs back out
   ---------------------------------------------------------------------------
   Every fixture is assembled here, byte by byte, so there is no binary to take
   on trust -- the same rule test/pdf.test.js works under, and the same builder.

   The strongest assertion available is cheap: write a file and feed it straight
   back into `pdf.read()`. The reader was written without any knowledge of the
   writer and refuses to guess, so a document it reads back with the right pages
   and the right text is a document that is actually well formed. Where a claim
   is about the bytes rather than the content -- a rewritten /Length, an escaped
   name, a stream copied without being decoded -- the bytes are checked
   directly, because a reader that repairs damage would hide exactly that.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');

const pdf = require('../app/main/pdf');
const edit = require('../app/main/pdfedit');

/* ------------------------------------------------------------------ builder */

function build(objects, trailer) {
  const parts = ['%PDF-1.7\n'];
  for (const [num, body, stream] of objects) {
    parts.push(`${num} 0 obj\n`);
    if (stream != null) {
      const data = Buffer.isBuffer(stream) ? stream : Buffer.from(stream, 'latin1');
      parts.push(body.replace('__LEN__', String(data.length)));
      parts.push('\nstream\n');
      parts.push(data.toString('latin1'));
      parts.push('\nendstream');
    } else {
      parts.push(body);
    }
    parts.push('\nendobj\n');
  }
  parts.push(`trailer\n${trailer}\n%%EOF\n`);
  return Buffer.from(parts.join(''), 'latin1');
}

/** N pages, each saying which one it is, under one shared /Resources. */
function manyPages(n, extra = {}) {
  const objects = [
    [1, '<< /Type /Catalog /Pages 2 0 R ' + (extra.catalog || '') + ' >>'],
    /* /Resources on the tree node, not on the pages: that is the inheritance
       the writer has to flatten, and the commonest real shape. */
    [2, '<< /Type /Pages /Kids [' +
        Array.from({ length: n }, (_x, i) => `${10 + i} 0 R`).join(' ') +
        '] /Count ' + n + ' /Resources << /Font << /F1 3 0 R >> >> ' +
        '/MediaBox [0 0 595 842] >>'],
    [3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  ];
  for (let i = 0; i < n; i++) {
    objects.push([10 + i, `<< /Type /Page /Parent 2 0 R /Contents ${50 + i} 0 R ` +
      (extra.page ? extra.page(i + 1) : '') + ' >>']);
    objects.push([50 + i, '<< /Length __LEN__ >>',
      `BT /F1 12 Tf 72 720 Td (Page ${i + 1}) Tj ET`]);
  }
  for (const o of (extra.objects || [])) objects.push(o);
  return build(objects, '<< /Root 1 0 R /Size 99 >>');
}

const docOf = (buf) => new (require('../app/main/pdf').Doc)(buf);

/** Write a selection and read it straight back. */
function roundTrip(buf, pages, opts) {
  const out = edit.writePages([{ doc: docOf(buf), pages }], opts || {});
  return { out, read: pdf.read(out.buffer) };
}

/* ------------------------------------------------------------ page ranges */

test('a page range is what a person would type', () => {
  assert.deepEqual(edit.parsePageSpec('1-3', 10), [1, 2, 3]);
  assert.deepEqual(edit.parsePageSpec('1,3,5', 10), [1, 3, 5]);
  assert.deepEqual(edit.parsePageSpec('8-', 10), [8, 9, 10]);
  assert.deepEqual(edit.parsePageSpec('-3', 10), [1, 2, 3]);
  assert.deepEqual(edit.parsePageSpec(' 2 , 4-5 ', 10), [2, 4, 5]);

  /* Fullwidth punctuation is what a Chinese keyboard produces without being
     asked, and refusing it would be refusing the ordinary case. */
  assert.deepEqual(edit.parsePageSpec('1、3', 10), [1, 3]);
  assert.deepEqual(edit.parsePageSpec('1，3－4', 10), [1, 3, 4]);
});

test('order and repeats are kept, because that is how reordering is asked for', () => {
  assert.deepEqual(edit.parsePageSpec('3,1', 5), [3, 1]);
  assert.deepEqual(edit.parsePageSpec('1,1', 5), [1, 1]);
  /* A backwards range reverses rather than erroring: '5-1' is a real request. */
  assert.deepEqual(edit.parsePageSpec('5-1', 5), [5, 4, 3, 2, 1]);
});

test('a range nobody can read is refused by name, not reinterpreted', () => {
  for (const bad of ['', 'abc', '0', '-', '2-x', '1..3']) {
    assert.throws(() => edit.parsePageSpec(bad, 10), /頁碼|沒有指定/, 'should refuse: ' + bad);
  }
  assert.throws(() => edit.parsePageSpec('11', 10), /超出範圍/);
  assert.throws(() => edit.parsePageSpec('9-12', 10), /超出範圍/);
});

test('deleting is expressed as keeping everything else', () => {
  assert.deepEqual(edit.invertPageSpec('2', 5), [1, 3, 4, 5]);
  assert.deepEqual(edit.invertPageSpec('1,5', 5), [2, 3, 4]);
  assert.throws(() => edit.invertPageSpec('1-5', 5), /留不下任何一頁/);
});

test('splitting every N pages leaves the remainder in a short last group', () => {
  assert.deepEqual(edit.everyGroups(2, 5), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(edit.everyGroups(10, 3), [[1, 2, 3]]);
  assert.throws(() => edit.everyGroups(0, 5), /大於 0/);
});

/* ----------------------------------------------------------- the round trip */

test('the reader reads the writer: a subset comes back as a real document', () => {
  const { out, read } = roundTrip(manyPages(5), [2, 4]);
  assert.equal(out.pageCount, 2);
  assert.equal(read.ok, true, JSON.stringify(read.warnings));
  assert.equal(read.pageCount, 2);
  assert.equal(read.pages[0].text, 'Page 2');
  assert.equal(read.pages[1].text, 'Page 4');
});

test('pages come out in the order they were asked for, repeats included', () => {
  const { read } = roundTrip(manyPages(4), [3, 1, 3]);
  assert.equal(read.pageCount, 3);
  assert.deepEqual(read.pages.map((p) => p.text), ['Page 3', 'Page 1', 'Page 3']);
});

test('an inherited /Resources is flattened onto the page, or the page is blank', () => {
  /* The fixture puts /Font on the /Pages node. The copied page loses every
     ancestor, so if the writer did not flatten, /F1 would not resolve and the
     text operators would draw with no font -- which the reader reports as an
     empty page rather than as an error. */
  const { out, read } = roundTrip(manyPages(3), [2]);
  assert.equal(read.pages[0].text, 'Page 2', 'the font came with the page');
  assert.match(out.buffer.toString('latin1'), /\/Resources/, '/Resources is written onto the page');
  assert.equal(read.pages[0].width, 595, 'and so did the page size');
  assert.equal(read.pages[0].height, 842);
});

test('an inherited /Rotate and /CropBox come with the page too', () => {
  const src = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [10 0 R] /Count 1 /MediaBox [0 0 595 842] ' +
        '/CropBox [10 10 585 832] /Rotate 90 /Resources << >> >>'],
    [10, '<< /Type /Page /Parent 2 0 R /Contents 50 0 R >>'],
    [50, '<< /Length __LEN__ >>', 'BT ET']
  ], '<< /Root 1 0 R /Size 99 >>');

  const { out, read } = roundTrip(src, [1]);
  const text = out.buffer.toString('latin1');
  assert.match(text, /\/CropBox \[10 10 585 832\]/, '/CropBox is one of the four inheritable keys');
  assert.match(text, /\/Rotate 90/);
  assert.equal(read.pages[0].rotate, 90);
});

/* --------------------------------------------------------------- the bytes */

test('a stream is copied as bytes, never decoded and re-encoded', () => {
  /* The reader returns an empty buffer for a JPEG rather than decoding it, so
     anything that round-tripped through streamOf would write an empty stream
     and report success. The marker bytes prove the original arrived intact. */
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const src = manyPages(1, {
    page: () => '/Resources << /XObject << /Im1 70 0 R >> >>',
    objects: [[70, '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 ' +
                   '/Filter /DCTDecode /Length __LEN__ >>', jpeg]]
  });

  const { out } = roundTrip(src, [1]);
  const bytes = out.buffer;
  assert.ok(bytes.includes(jpeg), 'the JPEG bytes are in the output unchanged');
  assert.match(bytes.toString('latin1'), /\/Filter \/DCTDecode/, 'and so is the filter that reads them');
});

test('/Length is rewritten to the bytes actually written, never copied', () => {
  /* A source whose declared /Length is a lie. The reader trusts `endstream`,
     so the writer must emit what it really copied -- a copied /Length would
     describe a stream that is not there. */
  const src = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [10 0 R] /Count 1 /MediaBox [0 0 200 200] /Resources << >> >>'],
    [10, '<< /Type /Page /Parent 2 0 R /Contents 50 0 R >>'],
    [50, '<< /Length 99999 >>', 'BT ET']
  ], '<< /Root 1 0 R /Size 99 >>');

  const { out, read } = roundTrip(src, [1]);
  assert.doesNotMatch(out.buffer.toString('latin1'), /\/Length 99999/, 'the lie is not carried');
  assert.equal(read.ok, true);
  assert.equal(read.pageCount, 1);
});

test('a name that arrived escaped goes back out escaped', () => {
  /* parseName turns `/A#20B` into `/A B` in memory. Writing that back raw
     produces two tokens and a corrupt dictionary. */
  assert.equal(edit.writeName('/A B'), '/A#20B');
  assert.equal(edit.writeName('/plain'), '/plain');
  assert.equal(edit.writeName('/has#hash'), '/has#23hash');

  const src = manyPages(1, {
    page: () => '/Resources << /Font << /F#20one 3 0 R >> >>'
  });
  const { out } = roundTrip(src, [1]);
  assert.match(out.buffer.toString('latin1'), /\/F#20one/, 'round-tripped through the writer');
});

test('a value the parser could not read is dropped, not written back', () => {
  /* `{op}` means the parser resynchronised over damage. Emitting it would put a
     bare keyword where a value belongs and corrupt the dictionary around it. */
  const written = edit.writeValue({ dict: { '/Good': 1, '/Bad': { op: 'garbage' } } });
  assert.match(written, /\/Good 1/);
  assert.doesNotMatch(written, /garbage/);
});

/* ------------------------------------------------------------- what is cut */

test('a link to a page that came along is kept and repointed; one to a page that did not is cut', () => {
  const src = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [10 0 R 11 0 R 12 0 R] /Count 3 ' +
        '/MediaBox [0 0 200 200] /Resources << >> >>'],
    [10, '<< /Type /Page /Parent 2 0 R /Contents 50 0 R /Annots [60 0 R 61 0 R] >>'],
    [11, '<< /Type /Page /Parent 2 0 R /Contents 50 0 R >>'],
    [12, '<< /Type /Page /Parent 2 0 R /Contents 50 0 R >>'],
    [50, '<< /Length __LEN__ >>', 'BT ET'],
    // to page 2, which is kept
    [60, '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest [11 0 R /XYZ null null null] >>'],
    // to page 3, which is not
    [61, '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest [12 0 R /XYZ null null null] >>']
  ], '<< /Root 1 0 R /Size 99 >>');

  const { out, read } = roundTrip(src, [1, 2]);
  assert.equal(read.pageCount, 2, 'the third page did not sneak in through the link');
  const text = out.buffer.toString('latin1');
  assert.equal((text.match(/\/Subtype \/Link/g) || []).length, 1, 'one link survives, one is cut');
  assert.ok(out.warnings.some((w) => /註解/.test(w)), 'and the cut is reported: ' + out.warnings);
});

test('an annotation that can open a file or reach the network loses the action', () => {
  const src = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [10 0 R] /Count 1 /MediaBox [0 0 200 200] /Resources << >> >>'],
    [10, '<< /Type /Page /Parent 2 0 R /Contents 50 0 R /Annots [60 0 R 61 0 R] >>'],
    [50, '<< /Length __LEN__ >>', 'BT ET'],
    [60, '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] ' +
         '/A << /S /URI /URI (http://example.com/) >> >>'],
    [61, '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] ' +
         '/A << /S /Launch /F (C:\\\\Windows\\\\System32\\\\calc.exe) >> >>']
  ], '<< /Root 1 0 R /Size 99 >>');

  const { out } = roundTrip(src, [1]);
  const text = out.buffer.toString('latin1');
  assert.doesNotMatch(text, /\/Launch/, 'nothing that reaches the shell survives');
  assert.doesNotMatch(text, /\/URI/, 'nothing that reaches the network survives');
  assert.doesNotMatch(text, /example\.com/);
  assert.ok(out.warnings.some((w) => /動作/.test(w)), 'and it is reported: ' + out.warnings);
});

test('document-level script and attachments do not come with the pages', () => {
  const src = manyPages(2, {
    catalog: '/Names << /JavaScript 80 0 R /EmbeddedFiles 81 0 R >> ' +
             '/OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> ' +
             '/Outlines 82 0 R /AcroForm << /Fields [] >>',
    objects: [
      [80, '<< /Names [(evil) 83 0 R] >>'],
      [81, '<< /Names [(x) 84 0 R] >>'],
      [82, '<< /Type /Outlines /Count 0 >>'],
      [83, '<< /S /JavaScript /JS (app.alert\\(2\\)) >>'],
      [84, '<< /Type /Filespec /F (secret.txt) >>']
    ]
  });

  const { out, read } = roundTrip(src, [1, 2]);
  const text = out.buffer.toString('latin1');
  assert.doesNotMatch(text, /JavaScript/, 'no document-level script');
  assert.doesNotMatch(text, /EmbeddedFiles|secret\.txt/, 'no attachments');
  assert.doesNotMatch(text, /\/OpenAction/, 'nothing runs on open');
  assert.equal(read.pageCount, 2, 'and the pages are still fine');

  for (const re of [/書籤/, /表單/, /具名目的地/]) {
    assert.ok(out.warnings.some((w) => re.test(w)), 'the loss is reported: ' + out.warnings);
  }
});

test('optional content is carried, because dropping it would reveal a hidden layer', () => {
  /* The one catalogue key where dropping is the unsafe choice: with no
     /OCProperties a reader draws every marked layer, so a layer the original
     turned off becomes visible in the copy. */
  const src = manyPages(1, {
    catalog: '/OCProperties << /OCGs [90 0 R] /D << /OFF [90 0 R] >> >>',
    objects: [[90, '<< /Type /OCG /Name (\\376\\377\\000H) >>']]
  });
  const { out } = roundTrip(src, [1]);
  const text = out.buffer.toString('latin1');
  assert.match(text, /\/OCProperties/);
  assert.match(text, /\/OCG/, 'the group itself came with it, not just the pointer');
  assert.match(text, /\/OFF/, 'and so did the list saying it starts hidden');
});

/* -------------------------------------------------------------- refusals */

test('an encrypted file is refused rather than turned into nonsense', () => {
  const src = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [10 0 R] /Count 1 /MediaBox [0 0 200 200] /Resources << >> >>'],
    [10, '<< /Type /Page /Parent 2 0 R /Contents 50 0 R >>'],
    [50, '<< /Length __LEN__ >>', 'BT ET'],
    [90, '<< /Filter /Standard /V 2 /R 3 >>']
  ], '<< /Root 1 0 R /Encrypt 90 0 R /Size 99 >>');

  assert.throws(() => edit.writePages([{ doc: docOf(src), pages: [1] }]),
    (e) => e.code === 'EENCRYPTED' && /加密/.test(e.message));
});

test('a page out of range, or none at all, is refused', () => {
  const doc = docOf(manyPages(2));
  assert.throws(() => edit.writePages([{ doc, pages: [9] }]), (e) => e.code === 'ERANGE');
  assert.throws(() => edit.writePages([]), (e) => e.code === 'EINVAL');
});

/* ---------------------------------------------------------------- merging */

test('two documents become one, and neither one\'s pages are lost', () => {
  const a = manyPages(2);
  const b = manyPages(3);
  const out = edit.writePages([
    { doc: docOf(a), pages: [1, 2] },
    { doc: docOf(b), pages: [3] }
  ], {});
  const read = pdf.read(out.buffer);
  assert.equal(out.pageCount, 3);
  assert.equal(read.pageCount, 3);
  assert.deepEqual(read.pages.map((p) => p.text), ['Page 1', 'Page 2', 'Page 3']);
});

test('two documents that both numbered an object 10 do not collide', () => {
  /* Every fixture here uses the same object numbers, which is the whole point:
     the remap is keyed by source as well as by number, so page 10 of one file
     and page 10 of another are different objects in the output. */
  const out = edit.writePages([
    { doc: docOf(manyPages(1)), pages: [1] },
    { doc: docOf(manyPages(1)), pages: [1] }
  ], {});
  const read = pdf.read(out.buffer);
  assert.equal(read.pageCount, 2);
  assert.deepEqual(read.pages.map((p) => p.text), ['Page 1', 'Page 1']);
});

/* -------------------------------------------------------------- metadata */

test('the new file does not claim the old one\'s authorship', () => {
  const src = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [10 0 R] /Count 1 /MediaBox [0 0 200 200] /Resources << >> >>'],
    [10, '<< /Type /Page /Parent 2 0 R /Contents 50 0 R >>'],
    [50, '<< /Length __LEN__ >>', 'BT ET'],
    [60, '<< /Author (\\376\\377\\000S\\000o\\000m\\000e\\000o\\000n\\000e) /Producer (Acrobat) >>']
  ], '<< /Root 1 0 R /Info 60 0 R /Size 99 >>');

  const { out, read } = roundTrip(src, [1], { title: '第一章' });
  assert.equal(read.meta.author, null, 'the original author does not carry over');
  assert.equal(read.meta.producer, 'AI-OS');
  assert.equal(read.meta.title, '第一章', 'a Chinese title survives as UTF-16, not as mojibake');
});

/* --------------------------------------------------------------- stamping */

/** A one-page document to lay over another, with its own font resource. */
function overlayDoc(text, extra = {}) {
  return build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [10 0 R] /Count 1 >>'],
    [10, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
         '/Resources << /Font << /F9 11 0 R >> >> /Contents 50 0 R ' + (extra.page || '') + ' >>'],
    [11, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [50, '<< /Length __LEN__ >>', `BT /F9 14 Tf 72 700 Td (${text}) Tj ET`]
  ], '<< /Root 1 0 R /Size 99 >>');
}

/** The fixture builder above emits no xref; stamping needs one to chain to. */
function withXref(buf) {
  const at = buf.length;
  const tail = 'xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R /Size 99 >>\n' +
    'startxref\n' + at + '\n%%EOF\n';
  return Buffer.concat([buf, Buffer.from(tail, 'latin1')]);
}

test('a stamp adds to the page without taking anything off it', () => {
  const target = withXref(manyPages(3));
  const out = edit.stamp(target, [{ page: 2, overlay: overlayDoc('STAMPED') }], {});
  const read = pdf.read(out.buffer);

  assert.equal(read.ok, true, JSON.stringify(read.warnings));
  assert.equal(read.pageCount, 3, 'the page count is unchanged');
  assert.match(read.pages[1].text, /Page 2/, 'the page still says what it said');
  assert.match(read.pages[1].text, /STAMPED/, 'and now says the new thing too');

  assert.match(read.pages[0].text, /Page 1/, 'the other pages are untouched');
  assert.ok(!read.pages[0].text.includes('STAMPED'));
  assert.ok(!read.pages[2].text.includes('STAMPED'));
});

test('a stamp is an append: the original bytes are still there, unchanged', () => {
  /* This is the whole reason stamping is not a rewrite. Bookmarks, form fields,
     attachments and the structure tree are all still in the file because
     nothing was copied -- only added after. */
  const target = withXref(manyPages(2));
  const out = edit.stamp(target, [{ page: 1, overlay: overlayDoc('X') }], {});
  assert.ok(out.buffer.subarray(0, target.length).equals(target),
    'the file starts with the original, byte for byte');
  assert.match(out.buffer.toString('latin1'), /\/Prev \d+/, 'and chains to its xref');
});

test('stamping twice does not let the second stamp overwrite the first', () => {
  const target = withXref(manyPages(1));
  const once = edit.stamp(target, [{ page: 1, overlay: overlayDoc('FIRST') }], {});
  const twice = edit.stamp(once.buffer, [{ page: 1, overlay: overlayDoc('SECOND') }], {});
  const read = pdf.read(twice.buffer);
  assert.match(read.pages[0].text, /FIRST/, 'the first stamp survives the second');
  assert.match(read.pages[0].text, /SECOND/);
  assert.match(read.pages[0].text, /Page 1/);
});

test('two stamps on one page compose rather than fighting over a name', () => {
  const target = withXref(manyPages(1));
  const out = edit.stamp(target, [
    { page: 1, overlay: overlayDoc('ONE') },
    { page: 1, overlay: overlayDoc('TWO') }
  ], {});
  const read = pdf.read(out.buffer);
  assert.match(read.pages[0].text, /ONE/);
  assert.match(read.pages[0].text, /TWO/);
  assert.match(out.buffer.toString('latin1'), /\/AiosOvl1/);
  assert.match(out.buffer.toString('latin1'), /\/AiosOvl2/);
});

test('a page that leaves the graphics stack open is unwound before the stamp', () => {
  /* Without this the stamp is drawn under whatever transform the page left
     behind, which is how a note ends up rotated, off the page, or invisible. */
  assert.equal(edit.graphicsDepth('q 1 0 0 1 0 0 cm BT ET'), 1);
  assert.equal(edit.graphicsDepth('q q BT ET Q'), 1);
  assert.equal(edit.graphicsDepth('q BT ET Q'), 0);
  /* A string full of q characters is a string, not fifty operators. */
  assert.equal(edit.graphicsDepth('BT (qqqqq) Tj ET'), 0);
  /* An absurd count means the scan went wrong, so it unwinds nothing. */
  assert.equal(edit.graphicsDepth('q '.repeat(40)), 0);

  const target = withXref(manyPages(1, { page: () => '' }));
  const out = edit.stamp(target, [{ page: 1, overlay: overlayDoc('OK') }], {});
  assert.match(pdf.read(out.buffer).pages[0].text, /OK/);
});

test('the stamped page keeps its own resources as well as the new form', () => {
  /* Resources are written onto the page as a direct dictionary rather than as a
     new version of the object that held them, because that object is very often
     shared by every page -- and then the stamp would appear on all of them. */
  const target = withXref(manyPages(3));
  const out = edit.stamp(target, [{ page: 2, overlay: overlayDoc('ONLY HERE') }], {});
  const read = pdf.read(out.buffer);
  assert.match(read.pages[1].text, /Page 2/, 'the shared font still resolves');
  assert.ok(!read.pages[0].text.includes('ONLY HERE'), 'and the other pages did not get it');
  assert.ok(!read.pages[2].text.includes('ONLY HERE'));
});

test('a turned page gets the stamp put back where the reader will see it', () => {
  /* The sheet is laid out over the page as a reader sees it, because that is
     the only corner a person can point at. A form is drawn in the page's own
     unturned coordinates and /Rotate is applied afterwards, so on a turned page
     the two spaces differ. Sending the sheet's bottom-left corner through each
     matrix must land on the page corner that ends up bottom-left after the
     turn. */
  const box = [0, 0, 600, 800];
  const at = (r) => {
    const m = edit.placeMatrix(box, r);
    // (0,0) through [a b c d e f] is just (e, f).
    return [m[4], m[5]];
  };
  assert.deepEqual(at(0), [0, 0], 'unturned: the corners already agree');
  assert.deepEqual(at(90), [600, 0], 'turned a quarter clockwise: bottom-right');
  assert.deepEqual(at(180), [600, 800], 'upside down: top-right');
  assert.deepEqual(at(270), [0, 800], 'turned the other way: top-left');

  /* And the axes come with it, not just the origin. On a 90 page the sheet's x
     runs up the page and its y runs back along it. */
  const m90 = edit.placeMatrix(box, 90);
  assert.deepEqual(m90.slice(0, 4), [0, 1, -1, 0]);
  assert.deepEqual(edit.placeMatrix(box, 270).slice(0, 4), [0, -1, 1, 0]);
  assert.deepEqual(edit.placeMatrix(box, 180).slice(0, 4), [-1, 0, 0, -1]);
});

test('a page whose box does not start at the origin is offset by exactly that much', () => {
  /* A trimmed print PDF. Getting this wrong shifts every stamp by the bleed. */
  const box = [20, 30, 620, 830];
  assert.deepEqual(edit.placeMatrix(box, 0).slice(4), [20, 30]);
  assert.deepEqual(edit.placeMatrix(box, 90).slice(4), [620, 30]);
  assert.deepEqual(edit.placeMatrix(box, 180).slice(4), [620, 830]);
  assert.deepEqual(edit.placeMatrix(box, 270).slice(4), [20, 830]);
});

test('a /Rotate nobody should have written is rounded rather than refused', () => {
  /* The spec says a multiple of 90. Files exist that say otherwise, and
     refusing to stamp one is worse than putting the note a degree out. */
  assert.deepEqual(edit.placeMatrix([0, 0, 600, 800], 91), edit.placeMatrix([0, 0, 600, 800], 90));
  assert.deepEqual(edit.placeMatrix([0, 0, 600, 800], -90), edit.placeMatrix([0, 0, 600, 800], 270));
  assert.deepEqual(edit.placeMatrix([0, 0, 600, 800], 450), edit.placeMatrix([0, 0, 600, 800], 90));
});

test('a sheet that is not the size of the page says so', () => {
  const target = withXref(manyPages(1));
  /* manyPages is 595x842; the overlay fixture is 595x842 too, so make one that
     is not. */
  const wrong = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [10 0 R] /Count 1 >>'],
    [10, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] ' +
         '/Resources << /Font << /F9 11 0 R >> >> /Contents 50 0 R >>'],
    [11, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [50, '<< /Length __LEN__ >>', 'BT /F9 14 Tf 10 10 Td (SMALL) Tj ET']
  ], '<< /Root 1 0 R /Size 99 >>');

  const out = edit.stamp(target, [{ page: 1, overlay: wrong }], {});
  assert.ok(out.warnings.some((w) => /尺寸/.test(w)),
    'a mismatched sheet is reported, not silently misplaced: ' + out.warnings);
  /* It is still written -- a warning, not a refusal. */
  assert.equal(pdf.read(out.buffer).pageCount, 1);
});

test('an encrypted or unreadable target is refused', () => {
  const enc = withXref(build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [10 0 R] /Count 1 /MediaBox [0 0 200 200] /Resources << >> >>'],
    [10, '<< /Type /Page /Parent 2 0 R /Contents 50 0 R >>'],
    [50, '<< /Length __LEN__ >>', 'BT ET'],
    [90, '<< /Filter /Standard /V 2 /R 3 >>']
  ], '<< /Root 1 0 R /Encrypt 90 0 R /Size 99 >>'));
  assert.throws(() => edit.stamp(enc, [{ page: 1, overlay: overlayDoc('X') }]),
    (e) => e.code === 'EENCRYPTED');

  /* No xref to chain to. Refused with a way forward rather than a file that
     opens in this project's scanning reader and nowhere else. */
  assert.throws(() => edit.stamp(manyPages(1), [{ page: 1, overlay: overlayDoc('X') }]),
    (e) => e.code === 'ENOXREF' && /抽出頁面/.test(e.message));

  assert.throws(() => edit.stamp(withXref(manyPages(1)), [{ page: 9, overlay: overlayDoc('X') }]),
    (e) => e.code === 'ERANGE');
});

test('a title is written as UTF-16 with a byte-order mark', () => {
  /* PDFDocEncoding has no Chinese in it, so a title written that way is
     mojibake in every viewer. */
  const s = edit.utf16('中');
  assert.equal(s.charCodeAt(0), 0xfe);
  assert.equal(s.charCodeAt(1), 0xff);
  assert.equal(s.charCodeAt(2), 0x4e);
  assert.equal(s.charCodeAt(3), 0x2d);
});
