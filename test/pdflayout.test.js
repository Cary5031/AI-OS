'use strict';
/* ===========================================================================
   PDF layout tests
   ---------------------------------------------------------------------------
   The layout reader is imported and run, the same way pdfmd.test.js runs the
   Markdown converter: against pages built out of numbers. Two kinds of input
   are faked here and nowhere else.

   The first is a drawing. rulesFromPixels reads a canvas's RGBA buffer, so the
   tests draw lines into a Uint8ClampedArray by hand -- a table's frame, a grey
   rule, a filled block, a large glyph's crossbar -- and check what comes back
   as a rule and what does not.

   The second is text with coordinates, in the shape pdfmd's pageLines hands
   over: x, a baseline y, width, height, the string. Everything from there --
   the grid, the merges, the borders, the sheet and the document -- is checked
   on the values, because the e2e spec can only check that an .xlsx came out.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = pathToFileURL(path.join(__dirname, '..', 'app', 'renderer', 'pdflayout.js')).href;
let L = null;
test.before(async () => { L = await import(SRC); });

/* ------------------------------------------------------------- drawing -- */

/** A white canvas of `w` x `h` points drawn at `scale`, with a pen. */
function canvas(w, h, scale) {
  const W = w * scale;
  const H = h * scale;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const px = (x, y, v) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
  };
  return {
    data, W, H, scale,
    /** A horizontal line at y from x0 to x1 (points), `thick` pixels, grey level `v`. */
    hline(y, x0, x1, thick = 2, v = 0) {
      for (let t = 0; t < thick; t++) for (let x = x0 * scale; x <= x1 * scale; x++) px(x, y * scale + t, v);
    },
    vline(x, y0, y1, thick = 2, v = 0) {
      for (let t = 0; t < thick; t++) for (let y = y0 * scale; y <= y1 * scale; y++) px(x * scale + t, y, v);
    },
    fill(x0, y0, x1, y1, v = 0) {
      for (let y = y0 * scale; y <= y1 * scale; y++) for (let x = x0 * scale; x <= x1 * scale; x++) px(x, y, v);
    },
    rules(parts) { return L.rulesFromPixels(data, W, H, scale, parts || []); }
  };
}

/** A text run: x, baseline y, width, height (all points). */
const run = (x, y, str, w = str.length * 6, h = 10) => ({ x, y, w, h, str });

/** The fixture most tests share: a title, a 3-column table with a spanning
    header row, a paragraph under it. The table is 50..350 wide, rows at 100,
    130, 160, 190; the header row has no inner verticals. */
function quotePage() {
  const c = canvas(400, 300, 2);
  [100, 130, 160, 190].forEach((y) => c.hline(y, 50, 350));
  c.vline(50, 100, 190);
  c.vline(350, 100, 190);
  c.vline(150, 130, 190);
  c.vline(250, 130, 190);
  const parts = [
    run(50, 60, '報價單', 120, 18),
    run(150, 120, '九月報價', 60),
    run(54, 150, '品名', 30), run(154, 150, '數量', 30), run(254, 150, '金額', 30),
    run(54, 180, '螺絲 M6', 60), run(200, 180, '100', 20), run(320, 180, '1,200', 26),
    run(50, 230, '以上報價有效期限三十天，', 300),
    run(50, 244, '請於期限內回覆。', 100)
  ];
  return { n: 1, parts, rules: c.rules(parts), width: 400, height: 300 };
}

/* --------------------------------------------------------------- rules -- */

test('lines on the drawn page come back as rules, in points', () => {
  const c = canvas(200, 100, 2);
  c.hline(40, 20, 180);
  c.vline(60, 10, 90);
  const r = c.rules();
  assert.equal(r.h.length, 1);
  assert.ok(Math.abs(r.h[0].y - 40) <= 1, 'y in points: ' + r.h[0].y);
  assert.ok(Math.abs(r.h[0].x0 - 20) <= 1 && Math.abs(r.h[0].x1 - 180) <= 1);
  assert.equal(r.v.length, 1);
  assert.ok(Math.abs(r.v[0].x - 60) <= 1);
  assert.ok(Math.abs(r.v[0].y0 - 10) <= 1 && Math.abs(r.v[0].y1 - 90) <= 1);
});

test('a grey rule is a rule; a light fill is not', () => {
  const c = canvas(200, 100, 2);
  c.hline(30, 20, 180, 2, 0x99);       // the grey most office suites draw tables in
  c.fill(20, 50, 180, 70, 0xee);       // a shaded band
  const r = c.rules();
  assert.equal(r.h.length, 1, 'the grey line is read');
  assert.ok(Math.abs(r.h[0].y - 30) <= 1);
});

test('a filled block is not a stack of rules, and a glyph crossbar is not a rule', () => {
  const c = canvas(200, 100, 2);
  c.fill(20, 20, 180, 40, 0);          // a black header box: 20pt thick
  c.hline(70, 100, 140);               // the crossbar of a huge 一
  const parts = [run(100, 74, '一', 40, 40)];
  const r = c.rules(parts);
  assert.equal(r.h.length, 0, 'neither the fill nor the glyph stroke: ' + JSON.stringify(r.h));
  assert.equal(r.v.length, 0);
});

test('a double line is one rule and short scratches are none', () => {
  const c = canvas(200, 100, 2);
  c.hline(50, 20, 180);
  c.hline(52, 20, 180);                // the second line of a double rule
  c.hline(80, 20, 30);                 // 10pt: a dash, not a rule
  const r = c.rules();
  assert.equal(r.h.length, 1);
});

/* ---------------------------------------------------------------- grid -- */

test('rules are boundaries first, and text just inside a cell does not add a column', () => {
  const g = L.gridOf(quotePage());
  /* 54, 154, 254 are padding inside the cells opened by the rules at 50, 150,
     250; 200 and 320 are runs that start mid-cell and do add boundaries,
     which the merges then fold back. */
  assert.deepEqual(g.colX.map(Math.round), [50, 150, 200, 250, 320, 350]);
  assert.deepEqual(g.rowY.map(Math.round), [42, 100, 130, 160, 190, 220, 234]);
});

test('boxes with no rule between their halves are merged back into one cell', () => {
  const g = L.gridOf(quotePage());
  const merged = g.regions.filter((r) => r.merged).map((r) => [r.c0, r.r0, r.c1, r.r1]);
  assert.ok(merged.some((m) => m.join() === [0, 1, 4, 1].join()), 'the header spans the table: ' + JSON.stringify(merged));
  assert.ok(merged.some((m) => m.join() === [1, 3, 2, 3].join()), 'the quantity cell is whole');
  assert.ok(merged.some((m) => m.join() === [3, 3, 4, 3].join()), 'the amount cell is whole');
});

test('text lands in the cell it was printed in, and the number that started mid-cell with it', () => {
  const s = L.sheetFrom(quotePage(), '第 1 頁');
  assert.equal(s.cells.A2.v, '九月報價');
  assert.equal(s.cells.A3.v, '品名');
  assert.equal(s.cells.B3.v, '數量');
  assert.equal(s.cells.D3.v, '金額');
  assert.equal(s.cells.A4.v, '螺絲 M6');
  assert.equal(s.cells.B4.v, '100', 'the quantity is in the quantity cell, not a column of its own');
  assert.equal(s.cells.D4.v, '1,200');
  assert.equal(s.cells.A1.v, '報價單');
  assert.equal(s.cells.A1.size, 18, 'the title keeps its size');
  assert.equal(s.cells.A6.v, '以上報價有效期限三十天，');
});

test('a border is written on every edge a rule ran along, and nowhere else', () => {
  const s = L.sheetFrom(quotePage(), '第 1 頁');
  const sides = (ref) => Object.keys((s.cells[ref] || {}).border || {}).sort().join(',');
  /* t / r / b / l: the keys office.js and AIOS.borders read. */
  assert.equal(sides('A3'), 'b,l,r,t');
  assert.equal(sides('B3'), 'b,l,t', 'the merged cell\'s right edge is on its last column');
  assert.equal(sides('C3'), 'b,r,t');
  assert.equal(sides('A2'), 'b,l,t', 'the header row has no inner verticals');
  assert.equal(sides('A6'), '', 'the paragraph under the table has no border');
  assert.equal(sides('A7'), '');
  assert.equal(sides('A1'), '', 'the title above the table has no line under it: the line is the table\'s top');
  assert.equal(sides('E2'), 'b,r,t', 'the table\'s right edge is on its last column');
  assert.equal(sides('F2'), '', 'and not on the empty band beyond it');
  const pen = s.cells.A3.border.t;
  assert.equal(pen.style, 'single');
  assert.equal(pen.colour, '000000');
});

test('merges cover the boxes and the text that ran across empty cells', () => {
  const s = L.sheetFrom(quotePage(), '第 1 頁');
  const has = (c0, r0, c1, r1) => s.merges.some((m) => m.c0 === c0 && m.r0 === r0 && m.c1 === c1 && m.r1 === r1);
  assert.ok(has(0, 1, 4, 1), 'header box');
  assert.ok(has(1, 3, 2, 3), 'quantity box');
  assert.ok(has(0, 0, 1, 0), 'the title reached into the next column');
  assert.ok(has(0, 5, 4, 5), 'the paragraph line reached across the page');
  assert.ok(!s.merges.some((m) => m.r0 === 6), 'the short last line stays in one cell');
});

test('column widths and row heights follow the bands, in pixels', () => {
  const s = L.sheetFrom(quotePage(), '第 1 頁');
  assert.equal(s.colWidths[0], Math.round(100 * 96 / 72), 'A is the 100pt first column');
  assert.equal(s.rowHeights[1], 40, 'a 30pt table row');
  assert.ok(s.rowHeights[0] > 60, 'the band above the table keeps its height');
  assert.equal(s.name, '第 1 頁');
});

test('a page with nothing on it is an empty sheet, not a crash', () => {
  const s = L.sheetFrom({ n: 1, parts: [], rules: { h: [], v: [] }, width: 400, height: 300 }, 'x');
  assert.deepEqual(s.cells, {});
  assert.deepEqual(s.merges, []);
});

test('a page with no lines still lands on a grid that follows its text', () => {
  const parts = [
    run(40, 50, 'Item', 30), run(200, 50, 'Qty', 20),
    run(40, 70, 'Bolt', 30), run(200, 70, '12', 12),
    run(40, 90, 'Nut', 24), run(200, 90, '7', 6)
  ];
  const s = L.sheetFrom({ n: 1, parts, rules: { h: [], v: [] }, width: 300, height: 200 }, 'x');
  assert.equal(s.cells.A1.v, 'Item');
  assert.equal(s.cells.B1.v, 'Qty');
  assert.equal(s.cells.B3.v, '7');
  assert.equal(Object.keys(s.cells).filter((k) => s.cells[k].border).length, 0, 'no rules, no borders');
});

test('right-aligned numbers are right-aligned cells', () => {
  const c = canvas(300, 100, 2);
  [20, 50].forEach((y) => c.hline(y, 20, 220));
  c.vline(20, 20, 50); c.vline(120, 20, 50); c.vline(220, 20, 50);
  const parts = [run(24, 40, 'Total', 30), run(190, 40, '1,234', 28)];
  const s = L.sheetFrom({ n: 1, parts, rules: c.rules(parts), width: 300, height: 100 }, 'x');
  assert.equal(s.cells.B1.v, '1,234');
  assert.equal(s.cells.B1.align, 'right');
  assert.equal(s.cells.A1.align, undefined, 'text sitting on the left edge is simply left');
});

/* ------------------------------------------------------------ document -- */

test('the document keeps order: heading, the table with its borders and merge, the paragraph', () => {
  const d = L.docFrom(quotePage());
  assert.equal(d.tables, 1);
  const types = d.blocks.map((b) => b.type);
  assert.deepEqual(types, ['heading', 'table', 'para'], 'the two wrapped lines are one paragraph');
  assert.equal(d.blocks[0].text, '報價單');
  const t = d.blocks[1];
  assert.deepEqual(t.rows, [['九月報價', '', ''], ['品名', '數量', '金額'], ['螺絲 M6', '100', '1,200']],
    'three visual columns, not the six bands the page grid needed');
  assert.deepEqual(t.merges, [{ c0: 0, r0: 0, c1: 2, r1: 0 }]);
  assert.deepEqual(Object.keys(t.cellStyles['1,1'].border).sort(), ['b', 'l', 'r', 't']);
  assert.equal(t.cellStyles['0,0'].border.r.style, 'single', 'the header box is closed on its far side');
  assert.equal(d.blocks[2].text, '以上報價有效期限三十天，請於期限內回覆。');
});

test('a table between two lines ends the paragraph, whatever the median gap says', () => {
  const page = quotePage();
  // One loose line above the table and one below; nothing else loose but the title.
  page.parts = page.parts.filter((p) => !/以上報價|請於期限/.test(p.str))
    .concat([run(50, 90, '客戶：LAYOUTMARK 有限公司', 150), run(50, 230, '以上報價有效期限三十天。', 150)]);
  const d = L.docFrom(page);
  const types = d.blocks.map((b) => b.type + ':' + (b.text || '').slice(0, 4));
  assert.deepEqual(types, ['heading:報價單', 'para:客戶：L', 'table:', 'para:以上報價'],
    'the customer line, the table, then the footnote -- not one paragraph around the table');
});

test('centred lines are centred paragraphs and bullets are list items', () => {
  const parts = [
    run(150, 30, '會議紀錄', 60, 16),                 // centred on a 0..360 page of text
    run(40, 60, '• 第一項', 60),
    run(40, 74, '• 第二項', 60),
    run(40, 100, '一般段落第一行', 300),
    run(40, 114, '一般段落第二行', 120),
    run(20, 200, 'x', 6), run(334, 200, 'x', 6)        // the page's text edges
  ];
  const d = L.docFrom({ n: 1, parts, rules: { h: [], v: [] }, width: 400, height: 300 });
  const head = d.blocks.find((b) => b.type === 'heading');
  assert.ok(head, 'the big line is a heading');
  assert.equal(head.align, 'center');
  const items = d.blocks.filter((b) => b.type === 'list');
  assert.equal(items.length, 2);
  assert.equal(items[0].text, '第一項', 'the bullet glyph is stripped');
  const para = d.blocks.find((b) => b.type === 'para' && /一般段落/.test(b.text));
  assert.equal(para.text, '一般段落第一行一般段落第二行', 'wrapped CJK lines join without a space');
});

/* ------------------------------------------------------------- from OCR -- */

test('the model\'s Markdown becomes blocks: heading, pipe table, list, paragraphs, page breaks', () => {
  const md = [
    '# 統一發票',
    '',
    '| 品名 | 數量 | 金額 |',
    '|---|---|---|',
    '| 螺絲 | 100 | 1,200 |',
    '| 墊片 | 50 | **300** |',
    '',
    '合計 1,500 元',
    '含稅',
    '',
    '<!-- 第 2 頁 -->',
    '',
    '- 備註一',
    '1. 編號項',
    '![第 2 頁](x.jpg)'
  ].join('\n');
  const b = L.mdToBlocks(md);
  assert.deepEqual(b.map((x) => x.type), ['heading', 'table', 'para', 'break', 'list', 'list']);
  assert.deepEqual(b[1].rows, [['品名', '數量', '金額'], ['螺絲', '100', '1,200'], ['墊片', '50', '300']],
    'the separator row is dropped and emphasis is stripped');
  assert.ok(b[1].cellStyles['2,2'].border.t, 'a transcribed table gets thin borders on every cell');
  assert.equal(b[2].text, '合計 1,500 元含稅', 'consecutive lines are one paragraph');
  assert.equal(b[4].ordered, false);
  assert.equal(b[5].ordered, true);
});

test('a Markdown hard break ends the paragraph, so each line the page had is a row', () => {
  /* Measured on a real invoice read by the model: 發票號碼, 買受人 and 賣方 came
     back as three lines joined by two-space breaks, and the first version put
     all three in one cell, run together. */
  const md = '發票號碼：AB-1  \n買受人：大同  \n賣方：宏昇\n\n銷售額合計：4,440  \n**總計：4,662**';
  const b = L.mdToBlocks(md);
  assert.deepEqual(b.map((x) => x.text), ['發票號碼：AB-1', '買受人：大同', '賣方：宏昇', '銷售額合計：4,440', '總計：4,662']);
  const s = L.sheetFromBlocks(b, 'x');
  assert.equal(s.cells.A2.v, '買受人：大同');
  assert.equal(s.cells.A5.v, '總計：4,662');
});

test('blocks onto a plain grid: table rows are rows, other blocks span the width', () => {
  const s = L.sheetFromBlocks(L.mdToBlocks('# 發票\n\n| 品名 | 數量 |\n|---|---|\n| 螺絲 | 100 |\n\n合計 1,200'), '第 1 頁');
  assert.equal(s.cells.A1.v, '發票');
  assert.equal(s.cells.A1.bold, true);
  assert.equal(s.cells.A2.v, '品名');
  assert.equal(s.cells.B3.v, '100');
  assert.ok(s.cells.B3.border && s.cells.B3.border.l, 'table cells carry borders');
  assert.equal(s.cells.A4.v, '合計 1,200');
  assert.ok(s.merges.some((m) => m.r0 === 0 && m.c1 === 1), 'the heading spans the table width');
  assert.ok(s.merges.some((m) => m.r0 === 3 && m.c1 === 1), 'so does the paragraph');
  assert.ok(s.colWidths[0] >= 64);
});

test('the borders survive the office writers, and radicals fold back to ideographs', () => {
  /* The first version wrote top / left / bottom / right and every border
     vanished on the way to the file: office.js reads t / r / b / l and nothing
     else. Round-tripped here so the key names are pinned by the writer itself. */
  const office = require(path.join(__dirname, '..', 'app', 'main', 'office.js'));
  const page = quotePage();
  page.parts[1].str = '九\u2f49報價';                       // ⽉, the Kangxi radical
  const sheet = L.sheetFrom(page, '第 1 頁');
  const back = office.readXlsx(office.writeXlsx({ sheets: [sheet] })).sheets[0];
  assert.deepEqual(Object.keys(back.cells.A3.border).sort(), ['b', 'l', 'r', 't']);
  assert.equal(back.cells.A3.border.t.colour, '000000');
  assert.equal(back.cells.A6.border, undefined);
  assert.equal(back.cells.A2.v, '九月報價', 'U+2F49 came back as 月');
  const doc = office.readDocx(office.writeDocx(L.docFrom(page).blocks, {}));
  const table = doc.blocks.find((b) => b.type === 'table');
  assert.ok(table.cellStyles && table.cellStyles['1,1'].border.l, 'Word cells keep their borders');
  assert.equal(table.rows[0][0], '九月報價');
});

test('column names and the receipt\'s numbers', () => {
  assert.equal(L.colName(0), 'A');
  assert.equal(L.colName(25), 'Z');
  assert.equal(L.colName(26), 'AA');
  assert.equal(L.colName(701), 'ZZ');
  const sum = L.summarise(L.sheetFrom(quotePage(), 'x'));
  assert.equal(sum.cells, 10, 'ten runs, ten cells with text');
  assert.ok(sum.bordered >= 12);
  assert.equal(sum.merges, 7);
});
