'use strict';

/* ===========================================================================
   ZIP container and OOXML round-trip tests
   ---------------------------------------------------------------------------
   These assert the property that matters for a document editor: what goes in
   comes back out. A silent corruption here would be discovered by the user
   opening a file in Word and finding it empty.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');

const zip = require('../app/main/zip');
const office = require('../app/main/office');

/* ------------------------------------------------------------------- zip */

test('zip round-trips text entries', () => {
  const buf = zip.write({
    'a.txt': 'hello',
    'dir/b.txt': 'second entry',
    'big.txt': 'x'.repeat(5000)          // long enough to be deflated
  });
  const files = zip.read(buf);
  assert.equal(files.get('a.txt').toString('utf8'), 'hello');
  assert.equal(files.get('dir/b.txt').toString('utf8'), 'second entry');
  assert.equal(files.get('big.txt').toString('utf8'), 'x'.repeat(5000));
});

test('zip round-trips binary and multi-byte content', () => {
  const bin = Buffer.from([0, 1, 2, 253, 254, 255, 0, 0, 42]);
  const cjk = '繁體中文內容，含標點。'.repeat(50);
  const files = zip.read(zip.write({ 'raw.bin': bin, 'cjk.txt': cjk }));
  assert.deepEqual([...files.get('raw.bin')], [...bin]);
  assert.equal(files.get('cjk.txt').toString('utf8'), cjk);
});

test('stored entries stay uncompressed and still read back', () => {
  const files = zip.read(zip.write({ 'keep.xml': '<a/>'.repeat(200) }, { store: ['keep.xml'] }));
  assert.equal(files.get('keep.xml').toString('utf8'), '<a/>'.repeat(200));
});

test('a corrupt archive is rejected rather than misread', () => {
  assert.throws(() => zip.read(Buffer.from('not a zip at all')), /zip/);
});

/* ------------------------------------------------------------------ docx */

test('docx round-trips headings, paragraphs, lists and quotes', () => {
  const blocks = [
    { type: 'heading', level: 1, text: '調校紀錄' },
    { type: 'para', runs: [{ text: '普通文字 ' }, { text: '粗體', bold: true }, { text: ' 與 ' }, { text: '斜體', italic: true }] },
    { type: 'list', ordered: false, text: '第一點' },
    { type: 'list', ordered: true, text: '有序項目' },
    { type: 'quote', text: '引用一段話' },
    { type: 'heading', level: 2, text: '次標題' }
  ];

  const back = office.readDocx(office.writeDocx(blocks));

  const heads = back.blocks.filter((b) => b.type === 'heading');
  assert.equal(heads.length, 2);
  assert.equal(heads[0].text, '調校紀錄');
  assert.equal(heads[0].level, 1);
  assert.equal(heads[1].level, 2);

  const para = back.blocks.find((b) => b.type === 'para');
  assert.equal(para.text, '普通文字 粗體 與 斜體');
  assert.ok(para.runs.some((r) => r.bold && r.text === '粗體'), 'bold survives');
  assert.ok(para.runs.some((r) => r.italic && r.text === '斜體'), 'italic survives');

  const lists = back.blocks.filter((b) => b.type === 'list');
  assert.equal(lists.length, 2);
  assert.equal(lists[0].text, '第一點');
  assert.equal(lists[1].ordered, true);

  assert.ok(back.blocks.some((b) => b.type === 'quote' && b.text === '引用一段話'));
});

test('docx preserves leading and trailing spaces in a run', () => {
  const back = office.readDocx(office.writeDocx([{ type: 'para', text: '  邊界空白  ' }]));
  assert.equal(back.blocks[0].text, '  邊界空白  ');
});

test('docx round-trips a table', () => {
  const blocks = [{ type: 'table', rows: [['名稱', '數量'], ['筆電', '2'], ['滑鼠', '5']] }];
  const back = office.readDocx(office.writeDocx(blocks));
  const t = back.blocks.find((b) => b.type === 'table');
  assert.ok(t, 'a table block comes back');
  assert.equal(t.rows.length, 3);
  assert.deepEqual(t.rows[0], ['名稱', '數量']);
  assert.deepEqual(t.rows[2], ['滑鼠', '5']);
});

test('docx round-trips merged table cells on both axes', () => {
  /* Word describes the two axes differently, and not symmetrically: a horizontal
     merge absorbs the cells to its right and they are simply absent, while a
     vertical merge needs a cell present in every row it spans. Getting the second
     one wrong shortens the table on the way back. */
  const blocks = [{
    type: 'table',
    rows: [
      ['跨三欄的標題', '', ''],
      ['靠左跨兩列', '甲', '乙'],
      ['', '丙', '丁']
    ],
    merges: [
      { c0: 0, c1: 2, r0: 0, r1: 0 },     // across the top
      { c0: 0, c1: 0, r0: 1, r1: 2 }      // down the left
    ]
  }];
  const xml = zip.read(office.writeDocx(blocks)).get('word/document.xml').toString('utf8');
  assert.match(xml, /<w:gridSpan w:val="3"\/>/, 'the wide cell says how wide');
  assert.match(xml, /<w:vMerge w:val="restart"\/>/, 'the tall cell starts a region');
  assert.match(xml, /<w:vMerge\/>/, 'and continues it in the next row');

  const back = office.readDocx(office.writeDocx(blocks));
  const t = back.blocks.find((b) => b.type === 'table');
  assert.ok(t, 'the table survives');
  assert.equal(t.rows.length, 3, 'three rows, not two: a continuation cell is still a row');
  assert.deepEqual(t.rows[0], ['跨三欄的標題', '', ''],
    'the columns a gridSpan swallowed still exist in the grid');
  assert.deepEqual(t.rows[1], ['靠左跨兩列', '甲', '乙']);
  assert.deepEqual(t.rows[2], ['', '丙', '丁']);
  assert.deepEqual(t.merges, [
    { c0: 0, c1: 2, r0: 0, r1: 0 },
    { c0: 0, c1: 0, r0: 1, r1: 2 }
  ]);
});

test('a docx table with no merges reports none rather than an empty list', () => {
  // So a plain table read from Word is byte-for-byte the shape it was before
  // merges existed, and nothing downstream has to tell [] from absent.
  const back = office.readDocx(office.writeDocx([
    { type: 'table', rows: [['a', 'b'], ['c', 'd']] }
  ]));
  const t = back.blocks.find((b) => b.type === 'table');
  assert.deepEqual(t.rows, [['a', 'b'], ['c', 'd']]);
  assert.equal(t.merges, undefined);
});

test('docx escapes XML-significant characters', () => {
  const text = 'a < b & c > d "quoted" \'single\'';
  const back = office.readDocx(office.writeDocx([{ type: 'para', text }]));
  assert.equal(back.blocks[0].text, text);
});

test('reading a non-docx zip fails with a clear message', () => {
  assert.throws(() => office.readDocx(zip.write({ 'nope.txt': 'x' })), /docx/);
});

/* ------------------------------------------------------------------ xlsx */

test('xlsx round-trips values, types and formulas', () => {
  const cells = {
    A1: { v: '品項' }, B1: { v: '單價' }, C1: { v: '數量' }, D1: { v: '小計' },
    A2: { v: '筆電' }, B2: { v: 30000 }, C2: { v: 2 }, D2: { f: '=B2*C2', v: 60000 },
    A3: { v: '滑鼠' }, B3: { v: 800 }, C3: { v: 5 }, D3: { f: '=B3*C3', v: 4000 },
    A4: { v: '總計' }, D4: { f: '=SUM(D2:D3)', v: 64000 },
    A5: { v: true }
  };

  const back = office.readXlsx(office.writeXlsx({ sheetName: '報價', cells }));

  assert.equal(back.sheet, '報價');
  assert.equal(back.cells.A1.v, '品項');
  assert.equal(back.cells.B2.v, 30000);
  assert.equal(back.cells.D2.f, '=B2*C2');
  assert.equal(back.cells.D2.v, 60000);
  assert.equal(back.cells.D4.f, '=SUM(D2:D3)');
  assert.equal(back.cells.A5.v, true);
  assert.equal(back.rows, 5);
  assert.equal(back.cols, 4);
});

test('xlsx keeps multi-byte strings intact', () => {
  const cells = { A1: { v: '繁體中文，含全形標點！' }, A2: { v: 'emoji 不常見但不能壞' } };
  const back = office.readXlsx(office.writeXlsx({ cells }));
  assert.equal(back.cells.A1.v, '繁體中文，含全形標點！');
  assert.equal(back.cells.A2.v, 'emoji 不常見但不能壞');
});

test('xlsx handles a wide sheet past column Z', () => {
  const cells = { A1: { v: 1 }, Z1: { v: 26 }, AA1: { v: 27 }, AB1: { v: 28 } };
  const back = office.readXlsx(office.writeXlsx({ cells }));
  assert.equal(back.cells.AA1.v, 27);
  assert.equal(back.cells.AB1.v, 28);
  assert.equal(back.cols, 28);
});

/* -------------------------------------------------------------- markdown */

test('markdown and blocks round-trip', () => {
  const md = [
    '# 標題',
    '',
    '一段**粗體**與*斜體*的文字',
    '',
    '- 項目一',
    '- 項目二',
    '',
    '1. 有序一',
    '',
    '> 引用',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |'
  ].join('\n');

  const blocks = office.markdownToBlocks(md);
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].text, '標題');
  assert.ok(blocks.some((b) => b.type === 'list' && b.text === '項目一'));
  assert.ok(blocks.some((b) => b.type === 'list' && b.ordered));
  assert.ok(blocks.some((b) => b.type === 'quote' && b.text === '引用'));

  const table = blocks.find((b) => b.type === 'table');
  assert.ok(table, 'the table is recognised');
  assert.deepEqual(table.rows[0], ['a', 'b']);
  assert.deepEqual(table.rows[1], ['1', '2']);

  const out = office.blocksToMarkdown(blocks);
  assert.match(out, /^# 標題/);
  assert.match(out, /\*\*粗體\*\*/);
  assert.match(out, /^- 項目一$/m);
});

test('markdown survives a docx trip', () => {
  const md = '# 標題\n\n第一段\n\n- 甲\n- 乙';
  const blocks = office.markdownToBlocks(md);
  const back = office.readDocx(office.writeDocx(blocks));
  const again = office.blocksToMarkdown(back.blocks);
  assert.match(again, /^# 標題/);
  assert.match(again, /^- 甲$/m);
  assert.match(again, /^- 乙$/m);
});

/* -------------------------------------------------------------------- csv */

test('csv handles quotes, commas and newlines', () => {
  const rows = [
    ['name', 'note'],
    ['a,b', 'says "hi"'],
    ['multi\nline', 'plain']
  ];
  const text = office.toCsv(rows);
  const back = office.parseCsv(text);
  assert.deepEqual(back, rows);
});

test('csv parses a trailing row without a newline', () => {
  assert.deepEqual(office.parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

/* ------------------------------------------------------------------ fonts */

test('a document font reaches every place Word looks for one', () => {
  const buf = office.writeDocx(
    [{ type: 'heading', level: 1, text: '標題' }, { type: 'para', text: '正文' }],
    { font: '標楷體', size: 14 }
  );
  const styles = zip.read(buf).get('word/styles.xml').toString('utf8');

  // docDefaults, Normal and the heading styles each have to name it: Word does
  // not fall back from a style to Normal for attributes the style mentions.
  assert.match(styles, /<w:docDefaults>/);
  assert.ok(styles.split('標楷體').length - 1 >= 8,
    'the family should appear in docDefaults, Normal and all six headings');
  assert.match(styles, /w:eastAsia="標楷體"/, 'CJK text needs w:eastAsia');
  assert.match(styles, /w:ascii="標楷體"/, 'Latin text needs w:ascii');
  assert.match(styles, /<w:sz w:val="28"\/>/, '14 pt is 28 half-points');
});

test('per-run and per-block fonts override the document default', () => {
  const buf = office.writeDocx([
    { type: 'para', font: 'Consolas', size: 9, text: '整段等寬' },
    {
      type: 'para',
      runs: [
        { text: '一般' },
        { text: '這段不同', font: 'Georgia', size: 20, bold: true }
      ]
    }
  ], { font: '微軟正黑體', size: 11 });
  const doc = zip.read(buf).get('word/document.xml').toString('utf8');

  assert.match(doc, /w:ascii="Consolas"[^>]*\/><w:sz w:val="18"\/>/,
    'a block font applies to its run at 9 pt');
  assert.match(doc, /w:ascii="Georgia"[^>]*\/><w:b\/><w:sz w:val="40"\/>/,
    'a run keeps its own font, weight and 20 pt');
  // The run with no font of its own must not be stamped with one, so that the
  // Normal style still governs it.
  const runs = doc.match(/<w:r>[\s\S]*?<\/w:r>/g) || [];
  const plain = runs.find((r) => r.includes('一般'));
  assert.ok(plain && !/w:rFonts/.test(plain), 'an unstyled run stays unstyled');
});

test('docx fonts survive a read-back', () => {
  const buf = office.writeDocx([{
    type: 'para',
    runs: [{ text: '楷體字', font: '標楷體', size: 16 }]
  }]);
  const back = office.readDocx(buf);
  const run = back.blocks[0].runs[0];
  assert.equal(run.text, '楷體字');
  assert.equal(run.font, '標楷體');
  assert.equal(run.size, 16);
});

test('xlsx interns one font per distinct combination and points cells at it', () => {
  const buf = office.writeXlsx({
    sheetName: '字型',
    font: '微軟正黑體',
    size: 12,
    cells: {
      A1: { v: '預設' },
      A2: { v: '粗體', bold: true },
      A3: { v: '大字', size: 24 },
      A4: { v: '也是粗體', bold: true },          // same combination as A2
      A5: { v: '換字型', font: 'Consolas' }
    }
  });
  const files = zip.read(buf);
  const styles = files.get('xl/styles.xml').toString('utf8');
  const sheet = files.get('xl/worksheets/sheet1.xml').toString('utf8');

  const count = Number((styles.match(/<fonts count="(\d+)"/) || [])[1]);
  assert.equal(count, 4, 'default plus bold, 24 pt and Consolas -- A4 reuses A2');
  assert.match(styles, /<name val="微軟正黑體"\/>/);
  /* cellXfs is its own table. It happens to have four entries here because a
     typeface is the only thing these cells carry, but the two are not parallel --
     a cell with a fill as well needs an xf the font table cannot express. */
  assert.match(styles, /<cellXfs count="4"/);

  // A1 uses the default, so it must carry no style index at all.
  assert.match(sheet, /<c r="A1" t="inlineStr">/);
  const a2 = (sheet.match(/<c r="A2" s="(\d+)"/) || [])[1];
  const a4 = (sheet.match(/<c r="A4" s="(\d+)"/) || [])[1];
  assert.ok(a2, 'A2 must reference a style');
  assert.equal(a2, a4, 'identical formatting must share one style index');
});

test('an empty cell that only carries formatting is still written', () => {
  const buf = office.writeXlsx({ cells: { B2: { v: '', font: 'Georgia' } } });
  const sheet = zip.read(buf).get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.match(sheet, /<c r="B2" s="1"\/>/,
    'otherwise the formatting is silently dropped on export');
});

test('xlsx round-trips a whole workbook, not just the sheet in front of you', () => {
  const buf = office.writeXlsx({
    font: '微軟正黑體',
    sheets: [
      { name: '收入', cells: { A1: { v: 100 }, A2: { v: 200 } } },
      { name: '摘要', cells: { B1: { f: '=SUM(收入!A1:A2)', v: 300 } } }
    ]
  });
  const files = zip.read(buf);
  // One part per sheet, each declared in the content types and the relationships.
  assert.ok(files.get('xl/worksheets/sheet1.xml'), 'sheet 1 part');
  assert.ok(files.get('xl/worksheets/sheet2.xml'), 'sheet 2 part');
  const types = files.get('[Content_Types].xml').toString('utf8');
  assert.match(types, /worksheets\/sheet2\.xml/);
  const rels = files.get('xl/_rels/workbook.xml.rels').toString('utf8');
  assert.match(rels, /Id="rId2"[^>]*worksheets\/sheet2\.xml/);
  assert.match(rels, /Id="rId3"[^>]*styles\.xml/, 'styles take the id after the last sheet');

  const back = office.readXlsx(buf);
  assert.deepEqual(back.sheetNames, ['收入', '摘要']);
  assert.equal(back.sheets.length, 2);
  assert.equal(back.sheets[0].cells.A2.v, 200);
  assert.equal(back.sheets[1].cells.B1.f, '=SUM(收入!A1:A2)',
    'and the cross-sheet reference survives');
  assert.equal(back.sheet, '收入', 'the headline fields describe the first sheet');
});

test('xlsx round-trips number formats, colours, borders and alignment', () => {
  const cells = {
    A1: { v: 1234.5, numFmt: '#,##0.00' },
    A2: { v: 0.125, numFmt: '0.0%' },
    A3: { v: 46249, numFmt: 'yyyy-mm-dd' },
    A4: { v: 'left', align: 'left' },
    A5: { v: 'wrapped', wrap: true },
    B1: { v: '底色', bg: 'FFF2CC' },
    B2: { v: '文字色', fg: 'C00000' },
    B3: { v: '框線', border: 'tblr' },
    B4: { v: '粗下線', border: 'B' },
    B5: { v: '全部', bold: true, italic: true, under: true, strike: true,
      bg: 'DDEBF7', fg: '1F4E79', border: 'b', numFmt: '0.00', align: 'right', wrap: true }
  };
  const back = office.readXlsx(office.writeXlsx({ sheetName: '樣式', cells }));

  for (const ref of Object.keys(cells)) {
    for (const key of Object.keys(cells[ref])) {
      // A border is a set of edges rather than a scalar; see the test below.
      if (key === 'border') continue;
      assert.equal(back.cells[ref][key], cells[ref][key],
        `${ref}.${key} did not survive the round trip`);
    }
  }

  /* The letter form is what files saved before borders had a style or a colour
     contain, so it is still read -- upgraded on the way in rather than kept as a
     second vocabulary. A capital meant "medium", which was 1.5pt in all but name. */
  assert.deepEqual(Object.keys(back.cells.B3.border).sort(), ['b', 'l', 'r', 't']);
  assert.equal(back.cells.B3.border.t.style, 'single');
  assert.equal(back.cells.B3.border.t.width, 0.5);
  assert.deepEqual(Object.keys(back.cells.B4.border), ['b']);
  assert.equal(back.cells.B4.border.b.width, 1.5, 'a capital was a medium weight');
  assert.deepEqual(Object.keys(back.cells.B5.border), ['b']);
});

test('xlsx round-trips a border style, weight and colour per edge', () => {
  const cells = {
    A1: { v: '四邊不同', border: {
      t: { style: 'single', width: 0.5, colour: 'C00000' },
      r: { style: 'double', width: 0.5, colour: '1F4E79' },
      b: { style: 'dashed', width: 1.5, colour: '548235' },
      l: { style: 'dotted', width: 0.5, colour: '7030A0' }
    } },
    A2: { v: '粗', border: { b: { style: 'single', width: 3, colour: '000000' } } },
    A3: { v: '髮線', border: { t: { style: 'single', width: 0.25, colour: '808080' } } }
  };
  const back = office.readXlsx(office.writeXlsx({ cells }));

  for (const [ref, want] of Object.entries(cells)) {
    const got = back.cells[ref].border;
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want.border).sort(), ref + ' edges');
    for (const e of Object.keys(want.border)) {
      assert.equal(got[e].style, want.border[e].style, `${ref}.${e} style`);
      assert.equal(got[e].width, want.border[e].width, `${ref}.${e} weight`);
      assert.equal(got[e].colour, want.border[e].colour, `${ref}.${e} colour`);
    }
  }
});

test('a spreadsheet border snaps to a weight Excel can express, and says which', () => {
  /* xlsx has no line width: it has named styles, each of which bakes one in. So a
     3/4pt border cannot be stored and becomes the nearest that can. Asserted
     rather than glossed over -- a round trip that silently returns a different
     number is worse than one that documents which numbers survive. */
  const back = office.readXlsx(office.writeXlsx({
    cells: {
      A1: { v: 1, border: { b: { style: 'single', width: 0.75, colour: '000000' } } },
      A2: { v: 2, border: { b: { style: 'single', width: 1, colour: '000000' } } },
      A3: { v: 3, border: { b: { style: 'single', width: 6, colour: '000000' } } }
    }
  }));
  assert.equal(back.cells.A1.border.b.width, 0.5, '3/4pt is nearest thin');
  // A tie goes to the lighter line: coming back thinner than asked is a smaller
  // surprise than coming back heavier, which changes the look of the whole table.
  assert.equal(back.cells.A2.border.b.width, 0.5, '1pt ties, and ties round down');
  assert.equal(back.cells.A3.border.b.width, 3, '6pt is nearest thick');
});

test('an edge a cell does not draw is absent, not "none"', () => {
  /* An explicit style="none" overrides the neighbour's edge, so a cell with no
     bottom would erase the top of the cell below it. */
  const styles = zip.read(office.writeXlsx({
    cells: { A1: { v: 1, border: { b: { style: 'single', width: 0.5, colour: '000000' } } } }
  })).get('xl/styles.xml').toString('utf8');
  assert.match(styles, /<bottom style="thin"><color rgb="FF000000"\/><\/bottom>/);
  assert.match(styles, /<top\/>/, 'the edges it does not draw are empty elements');
  assert.ok(!/style="none"/.test(styles));
  // The schema fixes the order of the five children of <border>.
  assert.match(styles, /<border><left[\s\S]*?<right[\s\S]*?<top[\s\S]*?<bottom[\s\S]*?<diagonal\/><\/border>/);
});

test('a built-in number format is written by id, a custom one by definition', () => {
  const styles = zip.read(office.writeXlsx({
    cells: { A1: { v: 1, numFmt: '#,##0.00' }, A2: { v: 2, numFmt: '#,##0.000「元」' } }
  })).get('xl/styles.xml').toString('utf8');

  // 4 is the built-in id for #,##0.00, so no definition is needed for it.
  assert.match(styles, /numFmtId="4"/);
  assert.ok(!/formatCode="#,##0\.00"/.test(styles), 'a built-in needs no definition');
  // Anything else is a document format, numbered from the first id reserved for one.
  assert.match(styles, /<numFmt numFmtId="164" formatCode="#,##0\.000「元」"\/>/);
});

test('xlsx round-trips column widths, row heights and frozen panes', () => {
  const back = office.readXlsx(office.writeXlsx({
    sheets: [{
      name: '幾何',
      cells: { A1: { v: 1 } },
      colWidths: { 0: 180, 2: 40 },
      rowHeights: { 0: 44 },
      freeze: { rows: 2, cols: 1 }
    }]
  }));
  const s = back.sheets[0];
  /* Widths are characters in the file and pixels in the app, so the trip is a
     unit conversion and lands within a pixel rather than exactly. */
  assert.ok(Math.abs(s.colWidths[0] - 180) <= 2, 'column A width, got ' + s.colWidths[0]);
  assert.ok(Math.abs(s.colWidths[2] - 40) <= 2, 'column C width, got ' + s.colWidths[2]);
  assert.equal(s.colWidths[1], undefined, 'a column nobody resized carries nothing');
  assert.ok(Math.abs(s.rowHeights[0] - 44) <= 2, 'row 1 height, got ' + s.rowHeights[0]);
  assert.deepEqual({ rows: s.freeze.rows, cols: s.freeze.cols }, { rows: 2, cols: 1 });
});

test('xlsx round-trips merged regions', () => {
  const back = office.readXlsx(office.writeXlsx({
    sheets: [{
      name: '合併',
      cells: { A1: { v: '跨欄標題', align: 'center' }, A3: { v: '側標' }, B3: { v: 1 } },
      merges: [{ c0: 0, c1: 4, r0: 0, r1: 0 }, { c0: 0, c1: 0, r0: 2, r1: 3 }]
    }]
  }));
  const s = back.sheets[0];
  assert.deepEqual(s.merges, [
    { c0: 0, c1: 4, r0: 0, r1: 0 },
    { c0: 0, c1: 0, r0: 2, r1: 3 }
  ]);
  assert.equal(s.cells.A1.v, '跨欄標題');
  /* A region reaches past the last cell that holds anything, so the sheet is as
     wide as the merge says: five columns here, from a single populated cell. */
  assert.ok(s.cols >= 5, 'the merge widens the sheet, got ' + s.cols);
  assert.ok(s.rows >= 4, 'and lengthens it, got ' + s.rows);
});

test('mergeCells is written where the schema puts it', () => {
  /* The order of a worksheet's children is fixed by the schema, and mergeCells
     comes after sheetData. Emitting it earlier produces a file Excel offers to
     repair -- which is the worst kind of wrong, because every other reader
     accepts it and the one that matters does not. */
  const sheet = zip.read(office.writeXlsx({
    sheets: [{ name: 'x', cells: { A1: { v: 1 } }, merges: [{ c0: 0, c1: 1, r0: 0, r1: 0 }] }]
  })).get('xl/worksheets/sheet1.xml').toString('utf8');

  assert.match(sheet, /<mergeCells count="1"><mergeCell ref="A1:B1"\/><\/mergeCells>/);
  assert.ok(sheet.indexOf('</sheetData>') < sheet.indexOf('<mergeCells'),
    'mergeCells must follow sheetData');
  assert.ok(sheet.indexOf('<mergeCells') < sheet.indexOf('</worksheet>'));

  // And a sheet with no merges emits no element at all, rather than an empty one.
  const plain = zip.read(office.writeXlsx({ cells: { A1: { v: 1 } } }))
    .get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.ok(!/mergeCells/.test(plain));
});

test('a sheet with no styles at all still reads', () => {
  // Files from other writers may omit styles.xml entirely.
  const buf = zip.write({
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Plain" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData><row r="1"><c r="A1" s="7"><v>5</v></c></row></sheetData></worksheet>'
  });
  const back = office.readXlsx(buf);
  assert.equal(back.cells.A1.v, 5, 'an unknown style index is no style, not a crash');
  assert.equal(back.cells.A1.numFmt, undefined);
});

/* ---------------------------------------------------------------------------
   Run formats, paragraph geometry, page breaks and the running head
   ---------------------------------------------------------------------------
   The word processor grew from bold-and-italic to nine character formats, five
   paragraph properties, a page break block and a header and footer. Each of
   those is worth exactly as much as its round trip: a format that is written and
   not read back is a format the user loses by saving and reopening.
   ------------------------------------------------------------------------- */

test('docx round-trips every character format', () => {
  const runs = [
    { text: '粗', bold: true },
    { text: '斜', italic: true },
    { text: '底', under: true },
    { text: '刪', strike: true },
    { text: '上', sup: true },
    { text: '下', sub: true },
    { text: 'code', code: true },
    { text: '色', colour: 'C0392B' },
    { text: '螢', mark: 'F1C40F' },
    { text: '合', bold: true, italic: true, under: true, colour: '2E86DE' }
  ];
  const back = office.readDocx(office.writeDocx([{ type: 'para', runs }]));
  const out = back.blocks.find((b) => b.type === 'para').runs;

  const find = (t) => out.find((r) => r.text === t);
  assert.equal(find('粗').bold, true);
  assert.equal(find('斜').italic, true);
  assert.equal(find('底').under, true);
  assert.equal(find('刪').strike, true);
  assert.equal(find('上').sup, true);
  assert.equal(find('下').sub, true);
  assert.equal(find('code').code, true);
  assert.equal(find('色').colour, 'C0392B');
  assert.equal(find('螢').mark, 'F1C40F');

  const all = find('合');
  assert.equal(all.bold, true);
  assert.equal(all.italic, true);
  assert.equal(all.under, true);
  assert.equal(all.colour, '2E86DE');

  // Superscript and subscript are one axis; nothing may come back as both.
  assert.ok(!out.some((r) => r.sup && r.sub), 'no run is superscript and subscript at once');
});

test('a toggle switched off in the file is read as off, not as present', () => {
  /* OOXML toggles are present-means-on, except that w:val="0" or "false" means
     explicitly off -- which is how Word turns bold off inside a style that turns
     it on. Reading presence alone gets exactly those runs backwards. */
  const xml = '<w:p><w:r><w:rPr><w:b w:val="0"/><w:i w:val="false"/><w:u w:val="none"/>' +
              '</w:rPr><w:t>普通</w:t></w:r></w:p>';
  const back = office.readDocx(zip.write({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': '<w:document><w:body>' + xml + '</w:body></w:document>'
  }));
  const r = back.blocks[0].runs[0];
  assert.equal(r.bold, false);
  assert.equal(r.italic, false);
  assert.ok(!r.under, 'w:u val="none" is not an underline');
});

test("Word's highlighter pen is read as a colour", () => {
  /* This writer emits w:shd with exact hex, but a file that came from Word uses
     w:highlight, which names one of sixteen colours. Reading only our own form
     would drop the highlight from every document a person actually brings in. */
  const xml = '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>畫起來</w:t></w:r></w:p>';
  const back = office.readDocx(zip.write({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': '<w:document><w:body>' + xml + '</w:body></w:document>'
  }));
  assert.equal(back.blocks[0].runs[0].mark, 'FFFF00');
});

test('docx round-trips paragraph alignment, indent, spacing and line height', () => {
  const blocks = [
    { type: 'para', text: '置中', align: 'center' },
    { type: 'para', text: '靠右', align: 'right' },
    { type: 'para', text: '兩端', align: 'justify' },
    { type: 'para', text: '縮排', indent: 2 },
    { type: 'para', text: '間距', spaceBefore: 12, spaceAfter: 6 },
    { type: 'para', text: '行距', lineHeight: 1.5 },
    { type: 'heading', level: 2, text: '標題也吃', align: 'center', spaceBefore: 18 }
  ];
  const back = office.readDocx(office.writeDocx(blocks));
  const at = (t) => back.blocks.find((b) => b.text === t);

  assert.equal(at('置中').align, 'center');
  assert.equal(at('靠右').align, 'right');
  // OOXML calls it "both"; the model calls it justify, and the names must not leak.
  assert.equal(at('兩端').align, 'justify');
  assert.equal(at('縮排').indent, 2);
  assert.equal(at('間距').spaceBefore, 12);
  assert.equal(at('間距').spaceAfter, 6);
  assert.equal(at('行距').lineHeight, 1.5);
  assert.equal(at('標題也吃').align, 'center');
  assert.equal(at('標題也吃').spaceBefore, 18);
});

test('a paragraph that states nothing writes no paragraph properties', () => {
  /* Emitting w:jc="left" on every paragraph would override a style that centres,
     which makes the exported document impossible to restyle in Word. */
  const xml = office.writeDocx([{ type: 'para', text: '一般' }]);
  const doc = zip.read(xml).get('word/document.xml').toString('utf8');
  assert.ok(!/<w:jc\b/.test(doc), 'no alignment is stated');
  assert.ok(!/<w:ind\b/.test(doc), 'no indent is stated');
  assert.ok(!/<w:spacing\b/.test(doc), 'no spacing is stated');
});

test('a page break survives docx and Markdown', () => {
  const blocks = [
    { type: 'para', text: '第一頁' },
    { type: 'break' },
    { type: 'para', text: '第二頁' }
  ];

  const back = office.readDocx(office.writeDocx(blocks));
  assert.deepEqual(back.blocks.map((b) => b.type), ['para', 'break', 'para']);
  // A break carries nothing. Coming back as an empty paragraph would make it
  // look like content to everything that reads the block list.
  assert.ok(!back.blocks[1].text, 'the break has no text');

  const md = office.blocksToMarkdown(blocks);
  assert.match(md, /<!-- pagebreak -->/);
  const round = office.markdownToBlocks(md);
  assert.deepEqual(round.map((b) => b.type), ['para', 'break', 'para']);
});

test('the running head and foot survive a docx trip', () => {
  const buf = office.writeDocx([{ type: 'para', text: '內容' }], {
    header: '調校報告', footer: '內部文件', pageNumbers: true
  });
  const files = zip.read(buf);

  // The parts have to exist, be declared, and be referenced from the section --
  // Word rejects a document that references a part it cannot resolve.
  assert.ok(files.get('word/header1.xml'), 'header part written');
  assert.ok(files.get('word/footer1.xml'), 'footer part written');
  const types = files.get('[Content_Types].xml').toString('utf8');
  assert.match(types, /header1\.xml/);
  assert.match(types, /footer1\.xml/);
  const rels = files.get('word/_rels/document.xml.rels').toString('utf8');
  assert.match(rels, /Target="header1\.xml"/);
  const doc = files.get('word/document.xml').toString('utf8');
  assert.match(doc, /<w:headerReference w:type="default" r:id="rId3"\/>/);
  assert.match(doc, /<w:footerReference w:type="default" r:id="rId4"\/>/);
  assert.match(doc, /xmlns:r=/, 'the r: prefix the references use is declared');
  // A page number is a field: Word computes the value when it lays out the page.
  assert.match(files.get('word/footer1.xml').toString('utf8'), /w:instr=" PAGE "/);

  const back = office.readDocx(buf);
  assert.equal(back.header, '調校報告');
  assert.match(back.footer, /內部文件/);
  assert.equal(back.pageNumbers, true);
});

test('a document with no header writes no header part', () => {
  const files = zip.read(office.writeDocx([{ type: 'para', text: '內容' }]));
  assert.equal(files.get('word/header1.xml'), undefined);
  const doc = files.get('word/document.xml').toString('utf8');
  assert.ok(!/headerReference/.test(doc), 'and references none');
});

test('inline code and strikethrough survive Markdown', () => {
  const blocks = [{
    type: 'para',
    runs: [
      { text: '呼叫 ' },
      { text: 'fs.write', code: true },
      { text: ' 之後 ' },
      { text: '刪掉', strike: true },
      { text: ' 這行' }
    ]
  }];
  const md = office.blocksToMarkdown(blocks);
  assert.match(md, /`fs\.write`/);
  assert.match(md, /~~刪掉~~/);

  const back = office.markdownToBlocks(md)[0].runs;
  assert.ok(back.some((r) => r.code && r.text === 'fs.write'));
  assert.ok(back.some((r) => r.strike && r.text === '刪掉'));
});

test('emphasis markers inside a code span stay literal', () => {
  /* `*ptr` is a dereference, not the start of an italic. Scanning code spans for
     emphasis is the usual way a code sample comes out mangled. */
  const runs = office.markdownToBlocks('用 `*ptr = *a * b` 算')[0].runs;
  const code = runs.find((r) => r.code);
  assert.equal(code.text, '*ptr = *a * b');
  assert.ok(!runs.some((r) => r.italic), 'nothing inside the span became italic');
});

/* ---------------------------------------------------------------------------
   Cell borders and shading in a document's table
   ------------------------------------------------------------------------- */

test('docx round-trips a border and a shade per table cell', () => {
  const blocks = [{
    type: 'table',
    rows: [['甲', '乙'], ['丙', '丁']],
    cellStyles: {
      '0,0': {
        bg: 'DDEBF7',
        border: {
          t: { style: 'single', width: 1.5, colour: 'C00000' },
          b: { style: 'double', width: 0.75, colour: '1F4E79' }
        }
      },
      '1,1': { border: { r: { style: 'dashed', width: 3, colour: '548235' } } }
    }
  }];
  const back = office.readDocx(office.writeDocx(blocks));
  const t = back.blocks.find((b) => b.type === 'table');

  assert.equal(t.cellStyles['0,0'].bg, 'DDEBF7');
  // Eighths of a point, so every width the app offers is exact here -- unlike
  // xlsx, which has named styles and no width at all.
  assert.equal(t.cellStyles['0,0'].border.t.width, 1.5);
  assert.equal(t.cellStyles['0,0'].border.t.colour, 'C00000');
  assert.equal(t.cellStyles['0,0'].border.b.style, 'double');
  assert.equal(t.cellStyles['0,0'].border.b.width, 0.75);
  assert.equal(t.cellStyles['1,1'].border.r.style, 'dashed');
  assert.equal(t.cellStyles['1,1'].border.r.width, 3);
});

test('an edge that says none is not the same as an edge that says nothing', () => {
  /* Three states, and the third is what makes the feature work: an edge that says
     nothing inherits the table's own border, an edge that says none overrides it.
     Collapsing them would force a choice between "下框線 erases the rest of the
     grid" and "無框線 does nothing". */
  const blocks = [{
    type: 'table',
    rows: [['甲', '乙']],
    cellStyles: { '0,0': { border: { t: null, b: { style: 'single', width: 0.5, colour: '000000' } } } }
  }];
  const xml = zip.read(office.writeDocx(blocks)).get('word/document.xml').toString('utf8');
  assert.match(xml, /<w:top w:val="nil"\/>/, 'a cleared edge overrides the table border');
  assert.match(xml, /<w:bottom w:val="single" w:sz="4"/);
  assert.ok(!/<w:left\b/.test(xml.split('<w:tcBorders>')[1].split('</w:tcBorders>')[0]),
    'an edge that says nothing is not written at all');

  const t = office.readDocx(office.writeDocx(blocks)).blocks.find((b) => b.type === 'table');
  const edges = t.cellStyles['0,0'].border;
  assert.ok('t' in edges && edges.t === null, 'and the difference survives the trip');
  assert.ok(!('l' in edges));
});

test('a table whose cells carry borders does not also get a table frame', () => {
  /* Both would be drawn, and the one the user did not ask for is the one on top. */
  const plain = zip.read(office.writeDocx([{ type: 'table', rows: [['甲']] }]))
    .get('word/document.xml').toString('utf8');
  assert.match(plain, /<w:tblBorders>/, 'an unstyled table keeps the default frame');

  const styled = zip.read(office.writeDocx([{
    type: 'table', rows: [['甲']],
    cellStyles: { '0,0': { border: { t: { style: 'single', width: 0.5, colour: '000000' } } } }
  }])).get('word/document.xml').toString('utf8');
  assert.ok(!/<w:tblBorders>/.test(styled), 'a styled one is described by its cells');
});

test('a table with no styled cells carries no cellStyles field', () => {
  const back = office.readDocx(office.writeDocx([{ type: 'table', rows: [['甲', '乙']] }]));
  const t = back.blocks.find((b) => b.type === 'table');
  assert.equal(t.cellStyles, undefined, 'an untouched table costs nothing');
});

/* ###########################################################################
   pptx
   ---------------------------------------------------------------------------
   A presentation is written, never read back, so a round-trip cannot be the
   test. What can be tested is the thing that actually went wrong: PowerPoint
   refusing the package. These assert the OPC invariants it enforces -- every
   relationship resolves, every part has a content type, every override names a
   part that exists -- plus the two specific rules that were learned the hard
   way by watching it refuse a file.
   ######################################################################### */

/** Every part a package's relationships and content types claim to have. */
function opc(buffer) {
  const files = zip.read(buffer);
  const names = new Set(files.keys());
  const problems = [];

  const resolve = (dir, target) => {
    const parts = (dir ? dir.split('/') : []).concat(target.split('/'));
    const out = [];
    parts.forEach((p) => {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    });
    return out.join('/');
  };

  for (const [name, buf] of files) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const xml = buf.toString('utf8');
    /* Not a parser -- a check that nothing wrote a stray unescaped angle
       bracket or left a tag open, which is what a bad substitution produces. */
    const opens = (xml.match(/<[a-zA-Z][^>]*[^/]>/g) || []).length;
    const closes = (xml.match(/<\/[a-zA-Z]/g) || []).length;
    if (opens !== closes) problems.push(`${name}: ${opens} open tags, ${closes} closing`);

    if (!name.endsWith('.rels')) continue;
    const dir = name.replace(/_rels\/[^/]*$/, '').replace(/\/$/, '');
    for (const m of xml.matchAll(/Target="([^"]+)"/g)) {
      if (/^https?:/.test(m[1])) continue;
      const to = resolve(dir, m[1]);
      if (!names.has(to)) problems.push(`${name} -> ${m[1]} (no part ${to})`);
    }
  }

  const ct = files.get('[Content_Types].xml').toString('utf8');
  const defaults = new Set([...ct.matchAll(/Default Extension="([^"]+)"/g)].map((m) => m[1]));
  const overrides = new Set([...ct.matchAll(/Override PartName="\/([^"]+)"/g)].map((m) => m[1]));
  overrides.forEach((p) => {
    if (!names.has(p)) problems.push(`content type names a missing part: ${p}`);
  });
  names.forEach((n) => {
    if (n === '[Content_Types].xml') return;
    if (overrides.has(n)) return;
    if (!defaults.has(n.split('.').pop())) problems.push(`no content type for ${n}`);
  });

  return { files, names, problems };
}

const DECK = {
  title: '測試簡報',
  font: 'Noto Sans TC',
  scale: 110,
  slides: [
    { layout: 'title', title: '封面', body: ['副標\n\n第二行'], notes: '', objects: [] },
    { layout: 'bullets', title: '項目', body: ['甲\n乙'], notes: '講稿', objects: [] },
    { layout: 'two', title: '雙欄', body: ['左', '右'], notes: '', objects: [] },
    { layout: 'quote', title: '', body: ['引言'], notes: '', objects: [] },
    { layout: 'section', title: '章節', body: [''], notes: '', objects: [] },
    { layout: 'blank', title: '', body: [''], notes: '', objects: [
      { kind: 'text', x: 5, y: 10, w: 40, h: 16, size: 24, text: '文字', align: 'left', valign: 'top' },
      { kind: 'shape', shape: 'hexagon', x: 50, y: 10, w: 26, h: 20, size: 18, fill: '1F4E79', text: '圖案', align: 'center', valign: 'middle' },
      { kind: 'table', x: 5, y: 40, w: 60, h: 30, size: 14, header: true, banded: true, fill: '1F4E79', rows: [['項目', '值'], ['甲', '1']], merges: [] }
    ] }
  ]
};

test('a written presentation is a well-formed OPC package', () => {
  const { problems } = opc(office.writePptx(DECK).buffer);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('a deck with no notes carries no notes parts at all', () => {
  const quiet = { ...DECK, slides: DECK.slides.map((s) => ({ ...s, notes: '' })) };
  const { names, problems } = opc(office.writePptx(quiet).buffer);
  assert.deepEqual(problems, []);
  assert.ok(![...names].some((n) => /notes/i.test(n)), 'nothing to say, nothing written');
  assert.ok(!names.has('ppt/theme/theme2.xml'), 'and no second theme either');
});

test('the notes master gets a theme of its own', () => {
  /* Two masters pointing at one theme part is the whole reason PowerPoint would
     not open the file -- every other feature opened cleanly and a deck with one
     line of speaker notes did not. The package validated as OPC either way, so
     only naming the rule keeps it. */
  const { files, names } = opc(office.writePptx(DECK).buffer);
  assert.ok(names.has('ppt/theme/theme2.xml'), 'a notes master needs its own theme');
  const nm = files.get('ppt/notesMasters/_rels/notesMaster1.xml.rels').toString('utf8');
  assert.match(nm, /Target="\.\.\/theme\/theme2\.xml"/);
  const sm = files.get('ppt/slideMasters/_rels/slideMaster1.xml.rels').toString('utf8');
  assert.match(sm, /Target="\.\.\/theme\/theme1\.xml"/);
});

test('speaker notes go into placeholders, not loose text boxes', () => {
  /* A free box floats over the notes page and does not appear in the notes pane;
     the body placeholder is what PowerPoint treats as the notes. */
  const { files } = opc(office.writePptx(DECK).buffer);
  const n = files.get('ppt/notesSlides/notesSlide1.xml').toString('utf8');
  assert.match(n, /<p:ph type="body" idx="1"\/>/, 'the text belongs to the notes placeholder');
  assert.match(n, /<p:ph type="sldImg"\/>/, 'and the page shows the slide it belongs to');
  assert.match(n, /<a:t>講稿<\/a:t>/);
});

test('every slide becomes a part, a relationship and an id', () => {
  const { files } = opc(office.writePptx(DECK).buffer);
  const n = DECK.slides.length;
  for (let i = 1; i <= n; i++) {
    assert.ok(files.has(`ppt/slides/slide${i}.xml`), `slide ${i} is a part`);
    assert.ok(files.has(`ppt/slides/_rels/slide${i}.xml.rels`), `slide ${i} has rels`);
  }
  const pres = files.get('ppt/presentation.xml').toString('utf8');
  assert.equal((pres.match(/<p:sldId /g) || []).length, n, 'and is listed once');
  assert.match(pres, /<p:sldSz cx="12192000" cy="6858000"\/>/, '16:9');
  /* The notes page is a portrait sheet of paper, not the slide rotated. */
  assert.match(pres, /<p:notesSz cx="6858000" cy="9144000"\/>/);
});

test('the deck scale is baked into the exported type sizes', () => {
  /* On screen the scale multiplies every size. An export that ignored it came
     out at a different size from the deck that was designed. */
  const one = (scale) => {
    const xml = zip.read(office.writePptx({
      title: 't', font: 'X', scale,
      slides: [{ layout: 'bullets', title: '標題', body: ['甲'], notes: '', objects: [] }]
    }).buffer).get('ppt/slides/slide1.xml').toString('utf8');
    return [...xml.matchAll(/sz="(\d+)"/g)].map((m) => Number(m[1]));
  };
  const plain = one(100);
  const bigger = one(200);
  assert.ok(plain.length >= 2);
  plain.forEach((v, i) => assert.equal(bigger[i], v * 2, 'every size scales together'));
});

test('the deck font is set for Latin and East Asian text together', () => {
  /* Leaving `ea` unset makes PowerPoint substitute its own East Asian font, so
     a deck set to a CJK face silently comes out in something else. */
  const xml = zip.read(office.writePptx(DECK).buffer)
    .get('ppt/slides/slide1.xml').toString('utf8');
  assert.match(xml, /<a:latin typeface="Noto Sans TC"\/><a:ea typeface="Noto Sans TC"\/><a:cs typeface="Noto Sans TC"\/>/);
});

test('a blank line survives as a blank line, and carries the font with it', () => {
  /* Blank lines are the only spacing control this deck format has. They also
     have to state the font: a box whose paragraphs disagree reports itself as
     mixed, and typing into the gap jumps to PowerPoint's default face. */
  const xml = zip.read(office.writePptx(DECK).buffer)
    .get('ppt/slides/slide1.xml').toString('utf8');
  const empty = xml.match(/<a:endParaRPr[^>]*>[\s\S]*?<\/a:endParaRPr>/);
  assert.ok(empty, 'the blank line is still a paragraph');
  assert.match(empty[0], /typeface="Noto Sans TC"/);
});

test('bullets appear on a bulleted layout and nowhere else', () => {
  const files = zip.read(office.writePptx(DECK).buffer);
  assert.match(files.get('ppt/slides/slide2.xml').toString('utf8'), /<a:buChar/);
  assert.ok(!/<a:buChar/.test(files.get('ppt/slides/slide1.xml').toString('utf8')),
    'a cover page is not a list');
});

test('a table keeps its grid, its header and its shading', () => {
  const xml = zip.read(office.writePptx(DECK).buffer)
    .get('ppt/slides/slide6.xml').toString('utf8');
  assert.match(xml, /<a:tbl>/);
  assert.equal((xml.match(/<a:gridCol /g) || []).length, 2);
  assert.equal((xml.match(/<a:tr /g) || []).length, 2);
  assert.match(xml, /firstRow="1"/);
  assert.match(xml, /<a:srgbClr val="1F4E79"\/>/, 'the header keeps its fill');
});

test('a merged region is written once, and its covered cells are flagged', () => {
  /* `{c0, r0, c1, r1}`, inclusive: what AIOS.grid normalises every merge list
     to and what a saved deck holds. This test used to pass `{c, r, w, h}` --
     the shape the writer read -- so the two agreed with each other and not with
     the application. Nothing merged for real, and the table still opened. */
  const xml = zip.read(office.writePptx({
    title: 't',
    slides: [{ layout: 'blank', title: '', body: [''], notes: '', objects: [{
      kind: 'table', x: 5, y: 5, w: 60, h: 30, size: 14, rows: [['甲', '乙', '丙'], ['a', 'b', 'c']],
      merges: [{ c0: 0, r0: 0, c1: 1, r1: 1 }]
    }] }]
  }).buffer).get('ppt/slides/slide1.xml').toString('utf8');
  assert.match(xml, /gridSpan="2" rowSpan="2"/, 'the origin carries the span');
  assert.match(xml, /hMerge="1"/, 'and the cells it covers say so');
  assert.match(xml, /vMerge="1"/);
  /* Every cell is still present: the schema wants the rectangle filled in. */
  assert.equal((xml.match(/<a:tc[ >]/g) || []).length, 6);
});

test('a merge wider than the table it arrived with is ignored, not clamped', () => {
  /* A file that disagrees with itself gets the table it describes, not a table
     invented by guessing which half was right. */
  const xml = zip.read(office.writePptx({
    title: 't',
    slides: [{ layout: 'blank', title: '', body: [''], notes: '', objects: [{
      kind: 'table', x: 5, y: 5, w: 60, h: 30, rows: [['甲', '乙']], merges: [{ c0: 0, r0: 0, c1: 4, r1: 2 }]
    }] }]
  }).buffer).get('ppt/slides/slide1.xml').toString('utf8');
  assert.ok(!/gridSpan/.test(xml) && !/hMerge/.test(xml));
  assert.equal((xml.match(/<a:tc[ >]/g) || []).length, 2);
});

test('a picture is embedded once however many slides use it', () => {
  const png = 'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const img = (x) => ({ kind: 'image', x, y: 10, w: 20, h: 20, src: png, alt: '點' });
  const out = office.writePptx({
    title: 't',
    slides: [
      { layout: 'blank', title: '', body: [''], notes: '', objects: [img(5)] },
      { layout: 'blank', title: '', body: [''], notes: '', objects: [img(30)] }
    ]
  });
  const { files, names, problems } = opc(out.buffer);
  assert.deepEqual(problems, []);
  assert.deepEqual(out.warnings, []);
  const media = [...names].filter((n) => n.startsWith('ppt/media/'));
  assert.deepEqual(media, ['ppt/media/image1.png'], 'the same bytes go in once');
  ['1', '2'].forEach((i) => {
    assert.match(files.get(`ppt/slides/slide${i}.xml`).toString('utf8'), /<p:pic>/);
    assert.match(files.get(`ppt/slides/_rels/slide${i}.xml.rels`).toString('utf8'),
      /Target="\.\.\/media\/image1\.png"/, 'and each slide relates to it');
  });
});

test('a picture that cannot be embedded is reported, not silently dropped', () => {
  /* The renderer resolves sandbox paths to data URIs before calling. One that
     did not resolve arrives as a path, and a deck that quietly lost a picture is
     worse than one that says it did. */
  const out = office.writePptx({
    title: 't',
    slides: [{ layout: 'blank', title: '', body: [''], notes: '', objects: [
      { kind: 'image', x: 5, y: 5, w: 20, h: 20, src: '/notes/沒有.png', alt: '缺' }
    ] }]
  });
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /第 1 頁/);
  assert.deepEqual(opc(out.buffer).problems, [], 'and the file is still valid');
});

test('an empty deck still produces an openable one-slide file', () => {
  const { files, problems } = opc(office.writePptx({ title: '空的' }).buffer);
  assert.deepEqual(problems, []);
  assert.ok(files.has('ppt/slides/slide1.xml'));
  assert.match(files.get('docProps/core.xml').toString('utf8'), /<dc:title>空的<\/dc:title>/);
});

test('text that looks like markup is escaped everywhere it appears', () => {
  const nasty = '<a:t>&"惡意"</a:t>';
  const { files, problems } = opc(office.writePptx({
    title: nasty,
    slides: [{ layout: 'bullets', title: nasty, body: [nasty], notes: nasty, objects: [
      { kind: 'table', x: 5, y: 5, w: 50, h: 20, rows: [[nasty]] }
    ] }]
  }).buffer);
  assert.deepEqual(problems, [], 'a stray bracket would break the package');
  const xml = files.get('ppt/slides/slide1.xml').toString('utf8');
  assert.ok(!xml.includes(nasty), 'the raw text must not appear');
  assert.match(xml, /&lt;a:t&gt;&amp;&quot;惡意&quot;&lt;\/a:t&gt;/);
});

/* ------------------------------------------------------------- CSV encoding */

/**
 * A `.csv` is bytes with no declared encoding, so Excel guesses from the system
 * codepage -- CP950 on a Traditional Chinese Windows -- and UTF-8 Chinese comes
 * out as 「憪?」. Measured, opening the same bytes both ways in real Excel:
 * 「姓名」 read back as 「憪?」 without a byte-order mark and 「姓名」 with one.
 * Notepad++ sniffs the content and was right either way, which is exactly how
 * this stays unnoticed until somebody opens a spreadsheet.
 */
test('an exported CSV carries a byte-order mark', () => {
  const csv = office.toCsv([['姓名', '部門'], ['陳品瑜', '產品部']]);
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'Excel needs the mark to read UTF-8');
  assert.deepEqual([...Buffer.from(csv, 'utf8').slice(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.match(csv, /姓名,部門\r\n陳品瑜,產品部$/, 'and nothing else changed');
});

test('a byte-order mark is stripped when reading, whoever wrote it', () => {
  /* Both directions were broken in the same place. Left in, the mark becomes
     part of the first column's name, so a file exported from Excel has a header
     called "\uFEFF姓名" that no {{欄位}} template ever matches. */
  const back = office.parseCsv(office.toCsv([['姓名', '編號'], ['甲', 'A001']]));
  assert.deepEqual(back[0], ['姓名', '編號'], 'our own round trip is clean');
  assert.equal(back[0][0], '姓名');

  const fromExcel = office.parseCsv('\uFEFF姓名,部門\r\n甲,乙');
  assert.deepEqual(fromExcel[0], ['姓名', '部門'], 'and so is a file Excel wrote');

  // Only a leading one, and only one: a mark in the middle is data.
  assert.deepEqual(office.parseCsv('a,b\r\nc,\uFEFFd')[1], ['c', '\uFEFFd']);
});
