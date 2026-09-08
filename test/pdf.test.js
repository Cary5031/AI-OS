'use strict';

/* ===========================================================================
   PDF reader tests
   ---------------------------------------------------------------------------
   Every fixture is built here rather than checked in, so the tests say exactly
   what shape of file they are about and there is no binary to take on trust.

   What is being asserted is narrow on purpose: that text comes out in reading
   order, that a subsetted font's ToUnicode table is honoured, and that a file
   with no text says why instead of returning an empty string. That last one is
   the property that matters most in practice -- an empty result and a scanned
   page look identical to a caller unless the reader distinguishes them.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const pdf = require('../app/main/pdf');

/* ------------------------------------------------------------------ builder */

/**
 * Assemble a PDF from numbered objects. No cross-reference table: the reader
 * indexes by scanning, and leaving the xref out proves it.
 */
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

function simpleDoc(contentStream, extra = {}) {
  return build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
        '/Resources << /Font << /F1 4 0 R >> ' + (extra.resources || '') + ' >> /Contents 5 0 R >>'],
    [4, extra.font || '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [5, '<< /Length __LEN__ >>', contentStream],
    [6, '<< /Title (\xfe\xff\x00T\x00e\x00s\x00t) /Author (AI-OS) ' +
        '/CreationDate (D:20240524115629) >>'],
    ...(extra.objects || [])
  ], '<< /Root 1 0 R /Info 6 0 R /Size 7 >>');
}

/* --------------------------------------------------------------- structure */

test('reads a file with no cross-reference table at all', () => {
  const r = pdf.read(simpleDoc('BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET'));
  assert.equal(r.ok, true);
  assert.equal(r.pageCount, 1);
  assert.equal(r.pages[0].text, 'Hello PDF');
  assert.equal(r.pages[0].width, 595);
  assert.equal(r.pages[0].height, 842);
});

test('metadata comes back decoded, including UTF-16 titles', () => {
  const r = pdf.read(simpleDoc('BT /F1 12 Tf (x) Tj ET'));
  assert.equal(r.meta.title, 'Test', 'a UTF-16BE title needs the BOM stripped');
  assert.equal(r.meta.author, 'AI-OS');
  assert.match(r.meta.created, /^2024-05-24T/);
});

test('a compressed content stream is inflated', () => {
  const raw = 'BT /F1 12 Tf 72 720 Td (deflated text) Tj ET';
  const doc = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 5 0 R ' +
        '/Resources << /Font << /F1 4 0 R >> >> >>'],
    [4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [5, '<< /Length __LEN__ /Filter /FlateDecode >>', zlib.deflateSync(Buffer.from(raw))]
  ], '<< /Root 1 0 R >>');
  assert.equal(pdf.read(doc).pages[0].text, 'deflated text');
});

test('pages come back in tree order, not file order', () => {
  // Kids deliberately lists the pages in the opposite order to the objects.
  const doc = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [11 0 R 10 0 R] /Count 2 >>'],
    [10, '<< /Type /Page /Parent 2 0 R /Contents 20 0 R /Resources << >> >>'],
    [11, '<< /Type /Page /Parent 2 0 R /Contents 21 0 R /Resources << >> >>'],
    [20, '<< /Length __LEN__ >>', 'BT (written second) Tj ET'],
    [21, '<< /Length __LEN__ >>', 'BT (written first) Tj ET']
  ], '<< /Root 1 0 R >>');
  const r = pdf.read(doc);
  assert.equal(r.pageCount, 2);
  assert.equal(r.pages[0].text, 'written first');
  assert.equal(r.pages[1].text, 'written second');
});

test('a page inherits resources from its parent', () => {
  const doc = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 400] ' +
        '/Resources << /Font << /F1 4 0 R >> >> >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>'],
    [4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [5, '<< /Length __LEN__ >>', 'BT /F1 12 Tf (inherited) Tj ET']
  ], '<< /Root 1 0 R >>');
  const r = pdf.read(doc);
  assert.equal(r.pages[0].text, 'inherited');
  assert.equal(r.pages[0].width, 200, 'MediaBox is inherited too');
});

/* -------------------------------------------------------------------- text */

test('line breaks follow the text matrix, not the byte order', () => {
  const r = pdf.read(simpleDoc(
    'BT /F1 12 Tf 1 0 0 1 72 720 Tm (first) Tj 1 0 0 1 72 700 Tm (second) Tj ET'
  ));
  assert.equal(r.pages[0].text, 'first\nsecond',
    'a baseline change is the only thing that makes a line in a PDF');
});

test('a wide kerning gap in TJ becomes a space', () => {
  const r = pdf.read(simpleDoc('BT /F1 12 Tf [(one) -400 (two)] TJ ET'));
  assert.equal(r.pages[0].text, 'one two');
  // A small adjustment is kerning inside a word and must not split it.
  const tight = pdf.read(simpleDoc('BT /F1 12 Tf [(clo) -20 (se)] TJ ET'));
  assert.equal(tight.pages[0].text, 'close');
});

test('a subsetted font is read through its ToUnicode table', () => {
  // Codes 1..3 are glyph indices with no relation to any character set; only
  // the CMap says they mean these three characters.
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    '3 beginbfchar',
    '<0001> <7A0B>',        // 程
    '<0002> <5F0F>',        // 式
    '<0003> <0041>',        // A
    'endbfchar',
    'endcmap end end'
  ].join('\n');

  const r = pdf.read(simpleDoc(
    'BT /F1 12 Tf <000100020003> Tj ET',
    {
      font: '<< /Type /Font /Subtype /Type0 /BaseFont /Subset+Font ' +
            '/Encoding /Identity-H /ToUnicode 7 0 R >>',
      objects: [[7, '<< /Length __LEN__ >>', cmap]]
    }
  ));
  assert.equal(r.pages[0].text, '程式A',
    'without the CMap these bytes decode to rubbish that looks like text');
});

test('bfrange maps a run of codes', () => {
  const cmap = [
    'begincmap',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    '1 beginbfrange <41> <43> <0061> endbfrange',
    'endcmap'
  ].join('\n');
  const parsed = pdf.parseCMap(cmap);
  assert.equal(parsed.bytes, 1);
  assert.equal(parsed.map.get(0x41), 'a');
  assert.equal(parsed.map.get(0x42), 'b');
  assert.equal(parsed.map.get(0x43), 'c');
});

test('WinAnsi punctuation survives, where plain Latin-1 would not', () => {
  // 0x92 is a right single quote in WinAnsi and undefined in Latin-1.
  const r = pdf.read(simpleDoc('BT /F1 12 Tf (it\x92s \x93quoted\x94 \x96 dash) Tj ET'));
  assert.equal(r.pages[0].text, 'it\u2019s \u201cquoted\u201d \u2013 dash');
});

test('object streams are expanded so their pages are found', () => {
  const inner = '<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << >> >>';
  const first = '3 0 ';
  const objstm = first + inner;
  const doc = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [5, '<< /Length __LEN__ >>', 'BT (from an object stream) Tj ET'],
    [9, `<< /Type /ObjStm /N 1 /First ${first.length} /Length __LEN__ >>`, objstm]
  ], '<< /Root 1 0 R >>');
  const r = pdf.read(doc);
  assert.equal(r.pageCount, 1);
  assert.equal(r.pages[0].text, 'from an object stream');
});

/* ------------------------------------------------- honest about what is not */

test('an encrypted file is refused rather than decoded into nonsense', () => {
  const doc = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << >> >>'],
    [5, '<< /Length __LEN__ >>', 'BT (would be garbage) Tj ET'],
    [8, '<< /Filter /Standard /V 2 /R 3 /Length 128 >>']
  ], '<< /Root 1 0 R /Encrypt 8 0 R >>');
  const r = pdf.read(doc);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EENCRYPTED');
  assert.equal(r.chars, 0, 'callers read chars; it must not be undefined');
  assert.equal(r.encrypted, true);
});

test('an image-only page is reported as scanned, not as empty', () => {
  const r = pdf.read(simpleDoc(
    'q 595 0 0 842 0 0 cm /Im0 Do Q',
    { resources: '/XObject << /Im0 7 0 R >>',
      objects: [[7, '<< /Subtype /Image /Width 10 /Height 10 /Length 0 >>', '']] }
  ));
  assert.equal(r.chars, 0);
  assert.equal(r.scanned, true);
  assert.equal(r.textless, true);
  assert.equal(r.pages[0].empty, 'image');
  assert.match(r.warnings.join(' '), /掃描檔/);
});

test('text inside a form XObject is text, not a picture', () => {
  /* Word, LaTeX and Illustrator all put real text inside forms, and so does
     anything this machine stamps onto a page. Counting a form as an image was
     a confident wrong answer: the page came back with no text and `scanned`,
     which tells somebody to go and find an OCR that would not have helped. */
  const r = pdf.read(simpleDoc(
    'BT /F1 12 Tf 72 800 Td (On the page) Tj ET /Fx Do',
    { resources: '/XObject << /Fx 7 0 R >>',
      objects: [[7, '<< /Subtype /Form /BBox [0 0 595 842] ' +
                    '/Resources << /Font << /F1 4 0 R >> >> /Length __LEN__ >>',
                 'BT /F1 12 Tf 72 700 Td (Inside the form) Tj ET']] }
  ));
  assert.equal(r.scanned, false, 'a form full of text is not a scan');
  assert.match(r.pages[0].text, /On the page/);
  assert.match(r.pages[0].text, /Inside the form/, 'the form was read, not counted');
});

test('a form names its own fonts, and the page does not lend it theirs', () => {
  /* /F1 in a form and /F1 on the page are routinely different fonts. Merging
     the two resource dictionaries decodes one of them with the other\'s map,
     which produces plausible-looking rubbish rather than an error. */
  const r = pdf.read(simpleDoc(
    '/Fx Do',
    { resources: '/XObject << /Fx 7 0 R >>',
      objects: [
        [7, '<< /Subtype /Form /BBox [0 0 595 842] ' +
            '/Resources << /Font << /F1 8 0 R >> >> /Length __LEN__ >>',
         'BT /F1 12 Tf 10 10 Td <0001> Tj ET'],
        [8, '<< /Type /Font /Subtype /Type0 /BaseFont /Sub /ToUnicode 9 0 R >>'],
        [9, '<< /Length __LEN__ >>',
         '/CIDInit /ProcSet findresource begin\n' +
         'begincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
         '1 beginbfchar\n<0001> <4E2D>\nendbfchar\nendcmap\nend']
      ] }
  ));
  assert.equal(r.pages[0].text, '中', 'decoded with the form\'s own /ToUnicode');
});

test('a form that draws itself stops rather than recursing forever', () => {
  const r = pdf.read(simpleDoc(
    '/Fx Do',
    { resources: '/XObject << /Fx 7 0 R >>',
      objects: [[7, '<< /Subtype /Form /BBox [0 0 10 10] ' +
                    '/Resources << /XObject << /Fx 7 0 R >> /Font << /F1 4 0 R >> >> ' +
                    '/Length __LEN__ >>',
                 'BT /F1 12 Tf 0 0 Td (loop) Tj ET /Fx Do']] }
  ));
  assert.equal(r.ok, true, 'it returns rather than overflowing the stack');
  assert.match(r.pages[0].text, /loop/, 'and it read the form once');
});

test('an image inside a form is still an image', () => {
  const r = pdf.read(simpleDoc(
    '/Fx Do',
    { resources: '/XObject << /Fx 7 0 R >>',
      objects: [
        [7, '<< /Subtype /Form /BBox [0 0 10 10] ' +
            '/Resources << /XObject << /Im0 8 0 R >> >> /Length __LEN__ >>',
         'q 10 0 0 10 0 0 cm /Im0 Do Q'],
        [8, '<< /Subtype /Image /Width 10 /Height 10 /Length 0 >>', '']
      ] }
  ));
  assert.equal(r.pages[0].empty, 'image', 'the picture inside the form still counts as one');
  assert.equal(r.scanned, true);
});

test('text converted to outlines is distinguished from a scan', () => {
  const r = pdf.read(simpleDoc('0 0 m 10 10 l 20 0 l h f  5 5 m 8 8 l h f'));
  assert.equal(r.chars, 0);
  assert.equal(r.textless, true);
  assert.equal(r.scanned, false, 'no image was drawn, so calling it a scan would be wrong');
  assert.equal(r.pages[0].empty, 'outlined');
  assert.match(r.warnings.join(' '), /向量外框/);
});

test('private-use glyphs are dropped instead of shown as boxes', () => {
  const cmap = [
    'begincmap',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    '2 beginbfchar <0001> <F0B7> <0002> <5B57> endbfchar',
    'endcmap'
  ].join('\n');
  const r = pdf.read(simpleDoc('BT /F1 12 Tf <00010002> Tj ET', {
    font: '<< /Type /Font /Subtype /Type0 /ToUnicode 7 0 R >>',
    objects: [[7, '<< /Length __LEN__ >>', cmap]]
  }));
  assert.equal(r.pages[0].text, '字', 'U+F0B7 is a decorative bullet in one font only');
});

test('a damaged file yields what it can instead of throwing', () => {
  const doc = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R 99 0 R] /Count 2 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 5 0 R /Resources << >> >>'],
    [5, '<< /Length 999999 >>', 'BT (readable page) Tj ET']   // Length is a lie
  ], '<< /Root 1 0 R >>');
  const r = pdf.read(doc);
  assert.equal(r.ok, true);
  assert.equal(r.pages[0].text, 'readable page',
    'endstream has to win over a wrong /Length');
  assert.equal(r.pageCount, 1, 'a missing kid is skipped, not fatal');
});

test('probe reports the shape without extracting text', () => {
  const p = pdf.probe(simpleDoc('BT /F1 12 Tf (ignored) Tj ET'));
  assert.equal(p.ok, true);
  assert.equal(p.pageCount, 1);
  assert.equal(p.meta.author, 'AI-OS');
  assert.equal(p.text, undefined, 'probe must not pay for extraction');
});

test('only the requested pages are extracted', () => {
  const doc = build([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /Contents 10 0 R /Resources << >> >>'],
    [4, '<< /Type /Page /Parent 2 0 R /Contents 11 0 R /Resources << >> >>'],
    [5, '<< /Type /Page /Parent 2 0 R /Contents 12 0 R /Resources << >> >>'],
    [10, '<< /Length __LEN__ >>', 'BT (one) Tj ET'],
    [11, '<< /Length __LEN__ >>', 'BT (two) Tj ET'],
    [12, '<< /Length __LEN__ >>', 'BT (three) Tj ET']
  ], '<< /Root 1 0 R >>');
  const r = pdf.read(doc, { pages: [2] });
  assert.equal(r.pageCount, 3, 'the count is of the whole document');
  assert.equal(r.pages.length, 1);
  assert.equal(r.pages[0].number, 2);
  assert.equal(r.pages[0].text, 'two');
});

/* ------------------------------------------------------- radical lookalikes */

/**
 * Kangxi Radicals look identical to the ideographs they stand for and are not
 * them. A PDF whose font reverse-maps into that block has a text layer that
 * looks perfect and is wrong: 日 as U+2F47, 用 as U+2F64, 行 as U+2F8F.
 *
 * Two things have to be true at once, and the first attempt broke the second:
 * the extracted text must be repaired, and the count must survive the repair.
 * A file that has the defect is still wrong for Adobe, for Chrome's viewer and
 * for Windows search -- so a check that finds nothing because the damage was
 * fixed for it is a false all-clear.
 */
test('the extractor repairs radical lookalikes and still reports how many', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'app', 'main', 'pdf.js'), 'utf8');

  assert.match(src, /let lastRepaired = 0;/, 'the tally has to outlive the repair');
  assert.match(src, /lastRepaired\+\+/, 'and be incremented where the repair happens');
  assert.match(src, /const repaired = lastRepaired;/,
    'read it once per page, before the next page resets it');
  assert.match(src, /radicals: repaired/, 'and put it on the page');

  /* Only the two radical blocks, and only per character. NFKC over the whole
     string would fold full-width punctuation to ASCII, and 「（）！」 are not
     decoration in Chinese text -- they are the punctuation. */
  assert.match(src, /\/\[\\u2e80-\\u2eff\\u2f00-\\u2fdf\]\/g|\/\[⺀-⻿⼀-⿟\]\/g/,
    'the range has to be the radical blocks and nothing else');
});
