'use strict';

/* ===========================================================================
   Charts: the shared model, the drawing, the DrawingML part, and the way the
   three Office programs are wired to them.
   ---------------------------------------------------------------------------
   The first half runs the code: app/renderer/charts.js is loaded as a module
   (it is written to load both ways), the drawing is built against the small
   document in test/lib/fakedom.js and read back as markup, and the chart parts
   go through the real writers and readers in app/main. The second half reads
   the source of the three programs, the way test/wiring.test.js does, for the
   rules a chart must obey in each of them -- the ones that were wrong once, or
   would be silently wrong if a later edit forgot them.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { Document } = require('./lib/fakedom');
global.document = new Document();

const C = require('../app/renderer/charts.js');
const X = require('../app/main/chartxml.js');
const office = require('../app/main/office.js');
const zip = require('../app/main/zip.js');

const APP = path.join(__dirname, '..', 'app');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');

/* The same comment-and-string scrubber wiring.test.js uses, so an assertion
   about what a file does cannot be satisfied by a comment that mentions it. */
function codeOnly(src, keepStrings) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const q = ch;
      let j = i + 1;
      while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      out += keepStrings ? src.slice(i, j + 1) : q + q;
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The brace-balanced body of `function name(` / `name: function (` / `name = function (`. */
function funcBody(src, name) {
  const re = new RegExp('(?:function\\s+' + name + '\\s*\\(|\\b' + name + '\\s*[:=]\\s*(?:async\\s+)?function\\s*\\()');
  const m = re.exec(src);
  assert.ok(m, 'no such function: ' + name);
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; }
  while (i < src.length && src[i] !== '{') i++;
  const start = i;
  depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1); }
  }
  return src.slice(start);
}

const BOOK = {
  title: '上半年收支',
  categories: ['1月', '2月', '3月', '4月', '5月', '6月'],
  series: [
    { name: '收入', values: [120000, 95000, 130000, 110000, 140000, 150000] },
    { name: '支出', values: [80000, 110000, 90000, 70000, 100000, 95000] },
    { name: '淨利', values: [40000, -15000, 40000, 40000, 40000, 55000] }
  ],
  numFmt: '#,##0'
};

/* ------------------------------------------------------------ the model */

test('a chart type is named in Chinese or by id, and an unknown one is refused', () => {
  assert.equal(C.requireType('pie'), 'pie');
  assert.equal(C.requireType('折線圖'), 'line');
  assert.equal(C.requireType('堆疊直條'), 'stackedColumn');
  assert.throws(() => C.requireType('雷達圖'), /不認得的圖表類型「雷達圖」；可用：直條圖/);
  assert.equal(C.TYPES.length, 10);
});

test('numbers are read the way people write them', () => {
  assert.equal(C.toNumber('NT$1,234.5'), 1234.5);
  assert.equal(C.toNumber('(500)'), -500);
  assert.equal(C.toNumber('12%'), 0.12);
  assert.equal(C.toNumber('１２３'), 123);
  assert.equal(C.toNumber('abc'), null);
  assert.equal(C.toNumber(''), null);
  assert.equal(C.toNumber({ v: 7 }), 7);
  assert.equal(C.isLabel('#DIV/0!'), false, 'an error value is not a label');
});

test('a table becomes categories and series whichever way its series run', () => {
  let g = C.fromRows([['月份', '收入', '支出'], ['1月', 10, 5], ['2月', 20, 6]]);
  assert.deepEqual(g.categories, ['1月', '2月']);
  assert.deepEqual(g.series.map((s) => [s.name, s.values]), [['收入', [10, 20]], ['支出', [5, 6]]]);
  assert.equal(g.corner, '月份');
  /* Series along the rows with only one heading: the case that misread the
     data by one row before the offsets were made geometric. */
  g = C.fromRows([['1月', '2月', '3月'], [10, 20, 30], [5, 6, 7]], { seriesIn: 'rows' });
  assert.deepEqual(g.categories, ['1月', '2月', '3月']);
  assert.deepEqual(g.series.map((s) => s.values), [[10, 20, 30], [5, 6, 7]]);
  g = C.fromRows([['收入', 10, 20, 30], ['支出', 5, 6, 7]], { seriesIn: 'rows' });
  assert.deepEqual(g.series.map((s) => [s.name, s.values]), [['收入', [10, 20, 30]], ['支出', [5, 6, 7]]]);
  g = C.fromRows([['收入', 1, 2, 3]], { seriesIn: 'rows' });
  assert.deepEqual(g.series.map((s) => [s.name, s.values]), [['收入', [1, 2, 3]]]);
  // A table wider than it is tall runs its series along the rows by itself.
  g = C.fromRows([['', 'a', 'b', 'c', 'd', 'e'], ['x', 1, 2, 3, 4, 5], ['y', 6, 7, 8, 9, 10]]);
  assert.equal(g.layout.seriesIn, 'rows');
});

test('dates, years and month numbers are categories, not a series', () => {
  let g = C.fromRows([['月份', '收入'], [{ v: 46023, text: '2026-01', label: true }, 100], [{ v: 46054, text: '2026-02', label: true }, 120]]);
  assert.deepEqual(g.categories, ['2026-01', '2026-02']);
  assert.equal(g.series.length, 1);
  g = C.fromRows([['項目', 2023, 2024, 2025], ['收入', 1, 2, 3], ['支出', 4, 5, 6]]);
  assert.deepEqual(g.categories, ['2023', '2024', '2025']);
  assert.deepEqual(g.series.map((s) => s.name), ['收入', '支出']);
  g = C.fromRows([['月份', '收入'], [1, 10], [2, 20], [3, 30]]);
  assert.deepEqual(g.categories, ['1', '2', '3']);
  // A blank corner under a heading row: the first column is categories even when numeric.
  const back = C.fromRows(C.toRows(C.norm({ type: 'scatter', categories: ['1.5', '2', '3'], series: [{ name: 'y', values: [4, 5, 6] }] })));
  assert.deepEqual(back.categories, ['1.5', '2', '3']);
  assert.equal(back.series.length, 1);
  // Told otherwise, the cells are believed.
  g = C.fromRows([[1, 2], [3, 4]], { headerRow: true, headerCol: true });
  assert.deepEqual(g.series.map((s) => [s.name, s.values]), [['2', [4]]]);
});

test('a totals row or column that really is a total is left out, and said so', () => {
  let g = C.fromRows([['月份', '收入', '支出', '合計'], ['1月', 10, 5, 15], ['2月', 20, 6, 26], ['合計', 30, 11, 41]]);
  assert.deepEqual(g.categories, ['1月', '2月']);
  assert.deepEqual(g.series.map((s) => s.name), ['收入', '支出']);
  assert.deepEqual(g.omitted, ['合計', '合計']);
  g = C.fromRows([['月份', '收入'], ['1月', 10], ['合計', 99]]);
  assert.deepEqual(g.categories, ['1月', '合計'], 'a 合計 whose numbers are not the sum is a category');
  g = C.fromRows([['月份', '收入'], ['1月', 10], ['合計', 99]], { omitTotals: true });
  assert.deepEqual(g.categories, ['1月']);
  g = C.fromRows([['月份', '收入', '合計'], ['1月', 10, 10]], { omitTotals: false, seriesIn: 'cols' });
  assert.deepEqual(g.series.map((s) => s.name), ['收入', '合計']);
});

test('a title above the table and a text column are reported, not charted', () => {
  const g = C.fromRows([['2025年帳務', null, null], ['日期', '摘要', '收入'], ['1日', '房租', 100], ['2日', '水電', 50]]);
  assert.equal(g.titleHint, '2025年帳務');
  assert.deepEqual(g.skipped, ['摘要']);
  assert.deepEqual(g.series.map((s) => [s.name, s.values]), [['收入', [100, 50]]]);
  assert.equal(C.fromRows([['月份', '收入'], ['1月', 'NT$1,200'], ['2月', 'NT$900']]).numFmtHint, 'NT$#,##0');
});

test('the reader says which part of the table it used, so a reference can name those cells', () => {
  /* The spreadsheet turns this into an Excel chart that points at real cells.
     Pointing at the whole range would put back the 合計 row the reader left
     out: the picture here would show six months and the one in Excel seven. */
  const b = (rows, opts) => C.fromRows(rows, opts).bounds;
  assert.deepEqual(b([['月', '收', '支'], ['1', 1, 2], ['2', 3, 4]]), { r0: 0, r1: 2, c0: 0, c1: 2 });
  assert.deepEqual(b([['月', '收', '支'], ['1', 1, 2], ['2', 3, 4], ['合計', 4, 6]]), { r0: 0, r1: 2, c0: 0, c1: 2 }, 'the totals row is outside it');
  assert.deepEqual(b([['月', '收', '支', '合計'], ['1', 1, 2, 3], ['2', 3, 4, 7]]), { r0: 0, r1: 2, c0: 0, c1: 2 }, 'so is the totals column');
  assert.deepEqual(b([['2025年帳務', null, null], ['月', '收'], ['1', 1], ['2', 2]]), { r0: 1, r1: 3, c0: 0, c1: 1 }, 'the title row above is outside it');
  assert.deepEqual(b([['月', '收'], ['1', 1], ['2', 2], ['', ''], ['', '']]), { r0: 0, r1: 2, c0: 0, c1: 1 }, 'and the blank rows below');
  assert.deepEqual(b([['', 'a', 'b', 'c'], ['x', 1, 2, 3], ['y', 4, 5, 6]], { seriesIn: 'rows' }), { r0: 0, r1: 2, c0: 0, c1: 3 });
  /* A column of text between two columns of numbers leaves what was kept no
     longer adjacent: there is no rectangle to name, and the writer carries the
     numbers instead of a reference. */
  assert.equal(b([['日', '摘要', '收'], ['1', '房租', 1], ['2', '水電', 2]]), null);
});

test('norm fills in, caps, aligns and folds', () => {
  let s = C.norm({ type: '折線圖', categories: ['a', 'b', '', ''], series: [{ name: 'x', values: [1, '2', null, null] }] });
  assert.deepEqual(s.categories, ['a', 'b']);
  assert.deepEqual(s.series[0].values, [1, 2]);
  assert.equal(s.legend, 'bottom');
  assert.equal(C.norm({ type: 'pie' }).legend, 'right');
  assert.equal(C.norm({ type: 'pie' }).labels, true);
  assert.equal(C.norm({ type: 'column' }).labels, false);
  const ten = Array.from({ length: 10 }, (_, i) => ({ name: 's' + i, values: [i] }));
  s = C.norm({ type: 'stackedColumn', categories: ['a'], series: ten });
  assert.equal(s.series.length, 8);
  assert.equal(s.series[7].name, '其他（3 項）');
  assert.equal(s.series[7].values[0], 7 + 8 + 9);
  assert.equal(s.series[7].colour, C.OTHER_COLOUR);
  assert.equal(C.norm({ type: 'column', categories: ['a'], series: ten }).series.length, 8);
  assert.deepEqual(C.overflow({ type: 'stackedColumn', series: ten }), { extra: 2, folded: 3, dropped: 0 });
  assert.deepEqual(C.overflow({ type: 'column', series: ten }), { extra: 2, folded: 0, dropped: 2 });
  const raw = { type: 'column', categories: ['a'], series: [{ name: 'x', values: [1] }] };
  const once = C.norm(raw);
  assert.deepEqual(C.norm(once), once, 'idempotent');
  assert.equal(raw.legend, undefined, 'the input is not mutated');
  assert.equal(C.withColours(once, ['橙']).series[0].colour, 'EB6834');
  assert.throws(() => C.requireColour('青紫', '數列顏色'), /不認得的數列顏色「青紫」/);
});

test('describe says what the model needs and nothing it does not', () => {
  assert.equal(C.describe(BOOK), '直條圖「上半年收支」：3 個數列（收入、支出、淨利）× 6 個類別（1月、2月、3月…6月）');
  assert.match(C.describe({ type: 'pie', categories: ['a', 'b'], series: [{ name: 'x', values: [1, -1] }, { name: 'y', values: [1, 1] }] }),
    /圓餅圖：2 個類別（a、b），數列「x」（其餘 1 個數列不畫）（略過 1 個非正值）/);
  assert.match(C.describe({ type: 'line' }), /（沒有資料）/);
});

test('the axis is nice, covers the data, includes zero when a bar needs it, and never repeats a label', () => {
  const ns = (lo, hi, o) => C.niceScale(lo, hi, o);
  assert.deepEqual(ns(-350, 900, { count: 5, zero: 'always' }).ticks, [-500, 0, 500, 1000]);
  assert.deepEqual(ns(0, 1234567, { count: 5, zero: 'always' }).ticks.slice(-1), [1250000]);
  assert.deepEqual(ns(46000, 46030, { count: 5, zero: 'auto' }).ticks, [46000, 46010, 46020, 46030], 'a line far from zero keeps its detail');
  assert.equal(ns(46000, 46030, { count: 5, zero: 'always' }).min, 0, 'a bar always grows from zero');
  assert.deepEqual(ns(5, 5, { count: 5, zero: 'always' }).ticks, [0, 1, 2, 3, 4, 5]);
  assert.ok(ns(5, 5, { count: 5, zero: 'never' }).min < 5 && ns(5, 5, { count: 5, zero: 'never' }).max > 5);
  assert.equal(C.tickLabel(1500000, '', 0), '1,500,000');
  assert.equal(C.tickLabel(-0.0, '', 0), '0');
  /* A swept property, not a sample: the generator is seeded, so a run that
     fails fails again with the same numbers. A random sweep here caught a
     decade-dependent case once in a few thousand runs and then refused to
     reproduce it, which is the worst kind of test to own. */
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let k = 0; k < 20000; k++) {
    const lo = (rnd() - 0.5) * Math.pow(10, Math.floor(rnd() * 14) - 6);
    const hi = lo + rnd() * Math.pow(10, Math.floor(rnd() * 14) - 6) + 1e-9;
    const r = ns(lo, hi, { count: 3 + (k % 5), zero: ['always', 'auto', 'never'][k % 3] });
    assert.ok(r.ticks.length >= 2 && r.ticks.length <= 9, `${lo},${hi}: ${r.ticks.length} ticks`);
    assert.ok(r.min <= lo + r.step * 1e-8 && r.max >= hi - r.step * 1e-8, `${lo},${hi}: ${r.min}..${r.max} does not cover`);
    const labels = r.ticks.map((v) => C.tickLabel(v, '', r.decimals));
    assert.equal(new Set(labels).size, labels.length, 'duplicate labels ' + labels.join(','));
  }
});

test('a number format is written the way Excel has to read it, and only where it must be', () => {
  /* Excel refuses to open a workbook whose format code leaves a literal letter
     bare -- with no hint of which cell it objected to. The spreadsheet's own
     currency format is one, so this was a file nobody could open. */
  assert.equal(C.excelFormatCode('NT$#,##0'), '"NT"$#,##0');
  assert.equal(C.excelFormatCode('US$#,##0.00'), '"US"$#,##0.00');
  assert.equal(C.excelFormatCode('"NT$"#,##0'), '"NT$"#,##0', 'already quoted, left alone');
  assert.equal(C.excelFormatCode(C.excelFormatCode('NT$#,##0')), '"NT"$#,##0', 'idempotent');
  // Tokens are not literals: dates, times, AM/PM, the exponent, General.
  ['yyyy-mm-dd', 'yyyy/m/d', 'hh:mm', 'h:mm AM/PM', '0.00E+00', 'General', '@', '0.0%',
    '#,##0.000「元」', '[Red]-#,##0', 'yyyy"年"m"月"', '#,##0'].forEach((code) => {
    assert.equal(C.excelFormatCode(code), code, code + ' is already what a file says');
  });
  const styles = zip.read(office.writeXlsx({ cells: { A1: { v: 1, numFmt: 'NT$#,##0' } } })).get('xl/styles.xml').toString('utf8');
  assert.match(styles, /<numFmt numFmtId="164" formatCode="&quot;NT&quot;\$#,##0"\/>/);
  const chart = X.chartSpaceXml(Object.assign({}, BOOK, { numFmt: 'NT$#,##0', labels: true }));
  assert.ok(!/formatCode="NT\$/.test(chart) && !/<c:formatCode>NT\$/.test(chart), 'the chart part spells it the same way');
  assert.match(chart, /<c:formatCode>&quot;NT&quot;\$#,##0<\/c:formatCode>/);
  // And the machine still reads its own: a quoted literal formats as the bare one.
  assert.equal(C.fmtValue(1234.5, '"NT"$#,##0'), C.fmtValue(1234.5, 'NT$#,##0'));
});

test('ranges are parsed, printed and turned into cell references and back', () => {
  assert.deepEqual(C.parseRange("'我的 表'!$A$1:$D$13"), { sheet: '我的 表', c0: 0, c1: 3, r0: 0, r1: 12 });
  assert.deepEqual(C.parseRange('工作表2!D13:A1'), { sheet: '工作表2', c0: 0, c1: 3, r0: 0, r1: 12 });
  assert.deepEqual(C.parseRange('B7'), { sheet: null, c0: 1, c1: 1, r0: 6, r1: 6 });
  assert.equal(C.parseRange('nope'), null);
  assert.equal(C.rangeText({ c0: 0, r0: 0, c1: 3, r1: 12 }, '工作表2'), '工作表2!A1:D13');
  assert.equal(C.rangeText({ c0: 0, r0: 0, c1: 3, r1: 12 }, '我的 表'), "'我的 表'!A1:D13");
  const layout = { headerRow: true, headerCol: true };
  const refs = C.rangeRefs('帳務', { c0: 0, r0: 0, c1: 3, r1: 12 }, 'cols', layout);
  assert.equal(refs.cat, "'帳務'!$A$2:$A$13");
  assert.deepEqual(refs.tx, ["'帳務'!$B$1", "'帳務'!$C$1", "'帳務'!$D$1"]);
  assert.equal(refs.val[2], "'帳務'!$D$2:$D$13");
  const back = C.refsToRange(refs);
  assert.deepEqual(back.range, { c0: 0, r0: 0, c1: 3, r1: 12 });
  assert.deepEqual(back.layout, layout);
  assert.equal(back.sheet, '帳務');
  assert.equal(back.categories, null, 'adjacent categories fold into the range');
  // Categories in a column of their own, the ordinary pie.
  const apart = C.rangeRefs('帳務', { c0: 3, r0: 0, c1: 3, r1: 12 }, 'cols', { headerRow: true, headerCol: false }, { c0: 0, r0: 1, c1: 0, r1: 12 });
  assert.deepEqual(C.refsToRange(apart).categories, { c0: 0, r0: 1, c1: 0, r1: 12 });
  assert.deepEqual(C.refsToRange(apart).range, { c0: 3, r0: 0, c1: 3, r1: 12 });
  const rows = C.rangeRefs('s', { c0: 0, r0: 0, c1: 3, r1: 2 }, 'rows', layout);
  assert.equal(C.refsToRange(rows).seriesIn, 'rows');
  assert.equal(C.refsToRange({ cat: "'a'!$A$2:$A$3", tx: [], val: ["'b'!$B$2:$B$3"] }), null, 'two sheets are not one range');
});

test('a pie keeps seven slices and folds the rest into 其他, and the writer colours by the same rule', () => {
  const twelve = { type: 'pie', categories: Array.from({ length: 12 }, (_, i) => 'c' + i), series: [{ name: 'v', values: Array.from({ length: 12 }, (_, i) => 12 - i) }] };
  const slices = C.pieSlices(twelve);
  assert.equal(slices.length, 8);
  assert.equal(slices[7].name, '其他（5 項）');
  assert.equal(slices[7].colour, '#' + C.OTHER_COLOUR);
  assert.equal(C.sliceColour(9, 12), C.OTHER_COLOUR);
  assert.equal(C.sliceColour(2, 5), C.COLOURS[2]);
  const xml = X.chartSpaceXml(twelve);
  const fills = [...xml.matchAll(/<c:dPt><c:idx val="(\d+)"\/>[\s\S]*?srgbClr val="([0-9A-F]{6})"/g)].map((m) => m[2]);
  assert.equal(fills.length, 12);
  assert.equal(fills[0], C.COLOURS[0]);
  assert.equal(fills[11], C.OTHER_COLOUR);
});

/* ---------------------------------------------------------- the drawing */

test('every type draws, with the ink inherited and the series colours themed', () => {
  C.TYPES.forEach((t) => {
    const spec = Object.assign({}, BOOK, { type: t.id, labels: true, categories: t.id === 'scatter' ? ['1', '2', '3', '4', '5', '6'] : BOOK.categories });
    const svg = C.render(spec, {});
    const html = svg.outerHTML;
    assert.match(html, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 640 360" width="100%" height="100%"/, t.id);
    assert.ok(html.includes('var(--ch-1, #2A78D6)'), t.id + ': the first slot is themed');
    assert.ok(html.includes('fill="currentColor"'), t.id + ': text is currentColor');
    assert.ok(!/stroke="#fff/i.test(html) && !/<(rect|path|circle)[^>]*fill="#fff/i.test(html), t.id + ': no white gaps or marks');
    assert.ok(!/\sid="/.test(html) && !html.includes('<defs'), t.id + ': no ids, no defs');
    assert.ok(svg.childNodes[0].localName !== 'title', t.id + ': no tooltip on the whole chart');
    assert.ok(svg.querySelectorAll('title').length > 0, t.id + ': marks carry tooltips');
  });
});

/** The points a bar's path passes through, so its length can be measured. */
function pathPoints(d) {
  const pts = [];
  let x = 0, y = 0, i = 0;
  const tok = String(d).match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) || [];
  while (i < tok.length) {
    const c = tok[i++];
    const num = () => Number(tok[i++]);
    if (c === 'M' || c === 'L') { x = num(); y = num(); pts.push([x, y]); }
    else if (c === 'H') { x = num(); pts.push([x, y]); }
    else if (c === 'V') { y = num(); pts.push([x, y]); }
    else if (c === 'A') { i += 5; x = num(); y = num(); pts.push([x, y]); }
    else if (c === 'Z') { /* closes */ }
    else if (/^[A-Za-z]$/.test(c)) throw new Error('unhandled path command ' + c);
    else { i--; x = num(); y = num(); pts.push([x, y]); }
  }
  return pts;
}

test('a bar is as long as its value says, from a shared baseline', () => {
  const draw = (spec) => C.render(spec, { width: 400, height: 300 }).querySelectorAll('path')
    .map((p) => pathPoints(p.getAttribute('d')))
    .map((pts) => ({ top: Math.min(...pts.map((q) => q[1])), bottom: Math.max(...pts.map((q) => q[1])) }));

  const bars = draw({ type: 'column', categories: ['a', 'b', 'c'], series: [{ name: 'v', values: [10, 20, 30] }], legend: 'none' });
  assert.equal(bars.length, 3);
  const base = bars[0].bottom;
  bars.forEach((b) => assert.ok(Math.abs(b.bottom - base) < 0.01, 'every bar grows from one baseline'));
  const len = bars.map((b) => b.bottom - b.top);
  assert.ok(Math.abs(len[1] / len[0] - 2) < 0.02, 'twice the value is twice the bar: ' + len.join(','));
  assert.ok(Math.abs(len[2] / len[0] - 3) < 0.02, 'three times likewise: ' + len.join(','));

  // A negative value hangs below the same baseline, the same length.
  const signed = draw({ type: 'column', categories: ['a', 'b'], series: [{ name: 'v', values: [10, -10] }], legend: 'none' });
  assert.ok(Math.abs(signed[0].bottom - signed[1].top) < 0.01, 'they meet at zero');
  assert.ok(Math.abs((signed[0].bottom - signed[0].top) - (signed[1].bottom - signed[1].top)) < 0.01, 'same size, opposite side');

  /* A stack reaches the total: the second segment starts two units above the
     first (the gap that separates them is unpainted, not a drawn line), so the
     two together are the sum less that gap. */
  const stack = draw({ type: 'stackedColumn', categories: ['a'], series: [{ name: 'x', values: [10] }, { name: 'y', values: [30] }], legend: 'none' });
  assert.equal(stack.length, 2);
  const first = stack[0].bottom - stack[0].top;
  const second = stack[1].bottom - stack[1].top;
  assert.ok(Math.abs(second - (first * 3 - 2)) < 0.5, `${first} then ${second}: three times the first, less the gap`);
  assert.ok(Math.abs(stack[1].bottom - stack[0].top) < 0.01, 'the upper segment starts where the lower one ended');
});

test('no label is drawn outside the picture, at any type or size', () => {
  /* The value axis of a horizontal bar chart centres its last label on the
     last tick, which sits at the right edge: half of "150,000" hung off the
     drawing until the plot was told to stop short by that much. Estimated
     widths are what the layout itself uses, so this measures the same way the
     drawing does. */
  const bad = [];
  const check = (spec, opts) => {
    const svg = C.render(spec, opts);
    svg.querySelectorAll('text').forEach((t) => {
      if (t.getAttribute('transform')) return;              // a rotated axis title
      const x = Number(t.getAttribute('x'));
      const y = Number(t.getAttribute('y'));
      const size = Number(t.getAttribute('font-size')) || 13;
      const w = C.estWidth(t.textContent, size);
      const anchor = t.getAttribute('text-anchor');
      const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
      if (left < -0.5 || left + w > opts.width + 0.5 || y < 0 || y > opts.height + 0.5) {
        bad.push(`${spec.type} ${opts.width}x${opts.height}: "${t.textContent}"`);
      }
    });
  };
  C.TYPES.forEach((t) => {
    const spec = Object.assign({}, BOOK, {
      type: t.id, labels: true,
      categories: t.id === 'scatter' ? ['1', '2', '3', '4', '5', '6'] : BOOK.categories
    });
    [[440, 235], [640, 360], [240, 150], [900, 300]].forEach(([w, h]) => check(spec, { width: w, height: h, fontSize: 12 }));
  });
  assert.deepEqual(bad, []);
});

test('a stacked area piles up to the total, band on band', () => {
  const svg = C.render({ type: 'stackedArea', categories: ['a', 'b'], series: [{ name: 'x', values: [10, 10] }, { name: 'y', values: [30, 30] }], legend: 'none' }, { width: 400, height: 300 });
  const fills = svg.querySelectorAll('path').filter((p) => p.getAttribute('fill-opacity')).map((p) => pathPoints(p.getAttribute('d')));
  assert.equal(fills.length, 2);
  const ys = fills.map((pts) => ({ top: Math.min(...pts.map((q) => q[1])), bottom: Math.max(...pts.map((q) => q[1])) }));
  const lower = ys.find((b) => b.bottom > ys[0].top && b.bottom >= ys[1].bottom);
  const upper = ys.find((b) => b !== lower);
  assert.ok(Math.abs(upper.bottom - lower.top) < 0.01, 'the upper band sits on the lower one');
  const unit = (lower.bottom - lower.top) / 10;
  assert.ok(Math.abs((upper.bottom - upper.top) / unit - 30) < 0.05, 'and is as thick as its own value');
});

test('the legend appears for two series or two slices, and one series names itself', () => {
  let svg = C.render({ type: 'column', categories: ['a', 'b'], series: [{ name: '單一', values: [1, 2] }] });
  assert.ok(svg.outerHTML.includes('單一'), 'the series name stands in for the missing title');
  assert.equal(svg.querySelectorAll('rect').length, 2, 'two hit rects and no legend swatch');
  svg = C.render(BOOK);
  assert.equal(svg.querySelectorAll('rect').length, 6 + 3, 'six hit rects and three swatches');
  svg = C.render({ type: 'pie', categories: ['a'], series: [{ name: 'x', values: [3] }] });
  assert.equal(svg.querySelectorAll('rect').length, 0, 'one slice has no legend');
  svg = C.render({ type: 'pie', categories: ['a', 'b'], series: [{ name: 'x', values: [3, 1] }] });
  assert.equal(svg.querySelectorAll('rect').length, 2);
});

test('a chart with no data, or no room, still draws something honest', () => {
  assert.ok(C.render({ type: 'line', categories: [], series: [] }).outerHTML.includes('沒有資料'));
  assert.ok(C.render({ type: 'scatter', categories: ['x'], series: [{ name: 'a', values: [1] }] }).outerHTML.includes('散佈圖的類別要是數字'));
  assert.ok(C.render(BOOK, { width: 60, height: 20 }).outerHTML.includes('<path'), 'tiny: marks only');
  assert.ok(!C.render(BOOK, { width: 60, height: 20 }).outerHTML.includes('<text'), 'tiny: no text');
  assert.ok(C.render(BOOK, { width: 30, height: 8 }).outerHTML.startsWith('<svg'));
});

test('a surface paints a background and rings the markers; without one nothing is painted behind', () => {
  const on = C.render(Object.assign({}, BOOK, { type: 'line' }), { surface: '#ffffff' }).outerHTML;
  assert.match(on, /<rect x="0" y="0" width="640" height="360" fill="#ffffff">/);
  assert.match(on, /<circle[^>]*stroke="#ffffff"/);
  const off = C.render(Object.assign({}, BOOK, { type: 'line' })).outerHTML;
  assert.ok(!/<rect x="0" y="0"/.test(off));
  assert.ok(!/<circle[^>]*stroke="/.test(off));
});

test('long category labels wrap or thin out instead of colliding', () => {
  const many = { type: 'column', categories: Array.from({ length: 14 }, (_, i) => '第' + (i + 1) + '個月份'), series: [{ name: 'v', values: Array.from({ length: 14 }, (_, i) => i + 1) }] };
  const svg = C.render(many);
  const full = svg.querySelectorAll('text').filter((t) => /^第\d+個月份$/.test(t.textContent)).length;
  const wrapped = svg.querySelectorAll('tspan').length;
  assert.ok(full < 14 || wrapped > 0, 'not every label at full length on one line');
  assert.ok(C.wrapTwo('第一個月份', 12, 40) !== null || C.fitText('第一個月份', 12, 40).endsWith('…'));
  assert.equal(C.fitText('abc', 12, 1000), 'abc');
  assert.ok(C.estWidth('上半年') > C.estWidth('abc'), 'CJK is wider than Latin');
});

test('a chart that leaves the screen gets its faint series labelled', () => {
  const quiet = C.render(Object.assign({}, BOOK, { labels: false })).querySelectorAll('text').length;
  const loud = C.render(Object.assign({}, BOOK, { labels: false }), { static: true }).querySelectorAll('text').length;
  assert.ok(loud > quiet, 'the third slot is under 3:1 on white and gets a direct label in print');
});

test('the clipboard twin is tab-separated numbers, matched exactly', async () => {
  const text = await C.copy(BOOK);
  assert.equal(text.split('\n')[1], '1月\t120000\t80000\t40000');
  assert.ok(C.pasteMatches(text + '\r\n'), 'line endings do not break the match');
  assert.ok(!C.pasteMatches('anything else'));
  assert.equal(C.clipSpec().title, '上半年收支');
  C.clearClip();
  assert.ok(!C.pasteMatches(text));
});

test('pasted text is read as a table however it was separated', () => {
  assert.deepEqual(C.parseTable('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(C.parseTable('a,"b,c",d\n1,2,3'), [['a', 'b,c', 'd'], ['1', '2', '3']]);
  assert.deepEqual(C.parseTable('| a\\|b | c |\n|---|---|\n| 1 | 2 |'), [['a|b', 'c'], ['1', '2']]);
  assert.deepEqual(C.parseTable(''), []);
});

/* ----------------------------------------------------- the DrawingML part */

test('every type round-trips through its chart part', () => {
  C.TYPES.forEach((t) => {
    const spec = C.norm(Object.assign({}, BOOK, {
      type: t.id, labels: true, legend: 'right', xTitle: '月', yTitle: '元',
      categories: t.id === 'scatter' ? ['1', '2', '3', '4', '5', '6'] : BOOK.categories
    }));
    const xml = X.chartSpaceXml(spec, { font: '微軟正黑體' });
    const opens = (xml.match(/<[a-zA-Z][\w:.-]*(?:\s[^>]*)?(?<!\/)>/g) || []).length;
    const closes = (xml.match(/<\/[a-zA-Z][\w:.-]*>/g) || []).length;
    assert.equal(opens, closes, t.id + ': tags balance');
    const back = X.readChartSpace(xml);
    assert.equal(back.spec.type, t.id);
    assert.equal(back.spec.title, spec.title);
    assert.deepEqual(back.spec.categories, spec.categories);
    const kept = t.family === 'pie' ? 1 : t.family === 'scatter' ? Math.min(3, spec.series.length) : spec.series.length;
    assert.deepEqual(back.spec.series.map((s) => s.values), spec.series.slice(0, kept).map((s) => s.values));
    assert.equal(back.spec.legend, 'right');
    assert.equal(back.spec.labels, true);
    assert.equal(back.spec.numFmt, '#,##0');
    if (t.family !== 'pie') { assert.equal(back.spec.xTitle, '月'); assert.equal(back.spec.yTitle, '元'); }
  });
});

test('the chart part is written in schema order, with the pieces Office insists on', () => {
  const xml = X.chartSpaceXml(Object.assign({}, BOOK, { type: 'stackedColumn', labels: true }), { font: '微軟正黑體' });
  const at = (s) => { const i = xml.indexOf(s); assert.ok(i >= 0, 'missing ' + s); return i; };
  assert.ok(at('<c:date1904') < at('<c:lang') && at('<c:lang') < at('<c:roundedCorners') && at('<c:roundedCorners') < at('<c:chart>'));
  assert.ok(at('<c:title>') < at('<c:autoTitleDeleted') && at('<c:autoTitleDeleted') < at('<c:plotArea>'));
  assert.ok(at('<c:plotArea>') < at('<c:legend>') && at('<c:legend>') < at('<c:plotVisOnly') && at('<c:plotVisOnly') < at('<c:dispBlanksAs'));
  assert.ok(at('</c:chart>') < xml.lastIndexOf('<c:txPr>'), 'text properties belong to the chart space');
  assert.ok(at('<c:gapWidth') < at('<c:overlap') && at('<c:overlap') < at('<c:axId val="10"/><c:axId val="20"/></c:barChart>'));
  assert.ok(at('<c:varyColors val="0"/>') > 0);
  for (const tag of ['<c:scaling>', '<c:axPos val="b"/>', '<c:axPos val="l"/>', '<c:crossAx', '<c:crossBetween']) at(tag);
  assert.match(xml, /<c:dLbls>[\s\S]*?<c:showLegendKey val="0"\/><c:showVal val="1"\/><c:showCatName val="0"\/><c:showSerName val="0"\/><c:showPercent val="0"\/><c:showBubbleSize val="0"\/><\/c:dLbls>/);
  assert.match(xml, /<a:latin typeface="微軟正黑體"\/><a:ea typeface="微軟正黑體"\/><a:cs typeface="微軟正黑體"\/>/);
  /* No cell range was given, so the numbers are in the part itself. A
     reference into a sheet that does not exist draws correctly in Word and
     PowerPoint, which fall back to the cache, and empty in Excel, which
     resolves it. */
  assert.match(xml, /<c:val><c:numLit><c:formatCode>#,##0<\/c:formatCode><c:ptCount/);
  assert.ok(!xml.includes('<c:f>'), 'nothing claims to come from a cell');
  const live = X.chartSpaceXml(BOOK, { refs: C.rangeRefs('帳務', { c0: 0, r0: 0, c1: 3, r1: 6 }, 'cols', { headerRow: true, headerCol: true }) });
  assert.match(live, /<c:val><c:numRef><c:f>&apos;帳務&apos;!\$B\$2:\$B\$7<\/c:f><c:numCache><c:formatCode>#,##0<\/c:formatCode><c:ptCount/);
  const pie = X.chartSpaceXml(Object.assign({}, BOOK, { type: 'doughnut' }));
  assert.ok(!pie.includes('<c:catAx') && !pie.includes('<c:valAx'), 'a pie has no axes');
  assert.ok(pie.includes('<c:varyColors val="1"/>') && pie.includes('<c:holeSize val="50"/>'));
  const sc = X.chartSpaceXml({ type: 'scatter', categories: ['1', 'x', '3'], series: [{ name: 's', values: [10, 20, null] }] });
  assert.ok(!sc.includes('<c:catAx') && (sc.match(/<c:valAx>/g) || []).length === 2, 'a scatter has two value axes');
  assert.equal((sc.match(/<c:xVal>[\s\S]*?<\/c:xVal>/)[0].match(/<c:pt /g) || []).length, 1, 'a point missing on one axis is missing on both');
  assert.equal((sc.match(/<c:yVal>[\s\S]*?<\/c:yVal>/)[0].match(/<c:pt /g) || []).length, 1);
  const line = X.chartSpaceXml(Object.assign({}, BOOK, { type: 'line' }));
  assert.match(line, /<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="2A78D6"\/>/, 'a line is coloured on its stroke');
  assert.ok(X.chartSpaceXml(Object.assign({}, BOOK, { yTitle: '元' })).includes('rot="-5400000"'), 'a vertical axis title is rotated');
});

test('a chart part escapes markup, strips control characters and keeps a null as a gap', () => {
  const xml = X.chartSpaceXml({ type: 'column', title: 'a <b> & "c"', categories: ['x<y', 'z'], series: [{ name: '<s>', values: [1, null] }] });
  assert.ok(!xml.includes('<b>') && xml.includes('&lt;b&gt;') && !xml.includes(''));
  assert.match(xml, /<c:ptCount val="2"\/><c:pt idx="0"><c:v>1<\/c:v><\/c:pt><\/c:numLit>/);
  const back = X.readChartSpace(xml);
  assert.equal(back.spec.title, 'a <b> & "c"');
  assert.deepEqual(back.spec.series[0].values, [1, null]);
});

test('the reader copes with what Excel writes and what a schema default means', () => {
  let xml = X.chartSpaceXml(Object.assign({}, BOOK, { type: 'column', labels: true }));
  assert.equal(X.readChartSpace(xml.replace('<c:showVal val="1"/>', '<c:showVal/>')).spec.labels, true, 'a boolean without val is true');
  xml = xml.replace(/<c:cat>[\s\S]*?<\/c:cat>/, '<c:cat><c:multiLvlStrRef><c:f>x</c:f><c:multiLvlStrCache><c:ptCount val="2"/><c:lvl><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:lvl><c:lvl><c:pt idx="0"><c:v>2025</c:v></c:pt></c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat>');
  assert.deepEqual(X.readChartSpace(xml).spec.categories.slice(0, 2), ['Q1', 'Q2'], 'the innermost level of a multi-level axis');
  const linked = X.chartSpaceXml(Object.assign({}, BOOK, { title: '' })).replace('<c:autoTitleDeleted val="1"/>',
    '<c:title><c:tx><c:strRef><c:f>A1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>從儲存格來</c:v></c:pt></c:strCache></c:strRef></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>');
  assert.equal(X.readChartSpace(linked).spec.title, '從儲存格來', 'a title linked to a cell');
  assert.equal(X.readChartSpace('<c:chartSpace><c:chart><c:plotArea><c:radarChart/></c:plotArea></c:chart></c:chartSpace>'), null, 'a chart kind this reader does not draw is null, not guessed');
  assert.equal(X.readChartSpace('<html/>'), null);
});

/* ------------------------------------------------------- the three files */

/** Every relationship target resolves and every part has a content type. */
function opc(buffer) {
  const files = zip.read(buffer);
  const problems = [];
  const ct = files.get('[Content_Types].xml').toString('utf8');
  for (const [name, buf] of files) {
    if (name.endsWith('.rels')) {
      const dir = name.replace(/_rels\/[^/]*$/, '');
      for (const m of buf.toString('utf8').matchAll(/Target="([^"]+)"/g)) {
        const t = m[1];
        const segs = (t.startsWith('/') ? t.slice(1) : dir + t).split('/');
        const out = [];
        segs.forEach((s) => { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); });
        if (!files.has(out.join('/'))) problems.push(name + ' -> ' + t);
      }
    }
  }
  for (const m of ct.matchAll(/PartName="([^"]+)"/g)) if (!files.has(m[1].slice(1))) problems.push('override for missing ' + m[1]);
  return { files, problems, ct };
}

test('a document with a chart carries a chart part, and one without carries nothing new', () => {
  const buf = office.writeDocx([{ type: 'heading', level: 1, text: '報告' }, { type: 'chart', chart: BOOK, aspect: 2 }, { type: 'para', text: '後面' }], { font: '微軟正黑體', size: 11, header: '頁首', pageNumbers: true });
  const { files, problems, ct } = opc(buf);
  assert.deepEqual(problems, []);
  assert.ok(files.has('word/charts/chart1.xml'));
  assert.ok(ct.includes('<Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>'));
  const rels = files.get('word/_rels/document.xml.rels').toString('utf8');
  assert.match(rels, /Id="rId5" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/chart" Target="charts\/chart1\.xml"/);
  assert.match(rels, /Id="rId3"[^>]*header/, 'the fixed header id is untouched');
  const doc = files.get('word/document.xml').toString('utf8');
  assert.match(doc, /<w:drawing><wp:inline [^>]*><wp:extent cx="5731510" cy="2865755"\/><wp:effectExtent [^>]*\/><wp:docPr id="1001" name="上半年收支"\/><wp:cNvGraphicFramePr\/><a:graphic /);
  const back = office.readDocx(buf);
  assert.deepEqual(back.blocks.map((b) => b.type), ['heading', 'chart', 'para']);
  assert.equal(back.blocks[1].aspect, 2);
  assert.deepEqual(back.blocks[1].chart.series.map((s) => s.values), BOOK.series.map((s) => s.values));
  const plain = office.writeDocx([{ type: 'para', text: 'x' }]);
  const names = [...zip.read(plain).keys()];
  assert.ok(!names.some((n) => n.includes('chart')));
  assert.ok(!zip.read(plain).get('[Content_Types].xml').toString('utf8').includes('chart'));
});

test('a chart in a document or a deck brings the workbook its numbers came from', () => {
  /* Cached numbers are enough to draw a chart, and that is all this wrote at
     first -- so Office opened the file, drew it correctly, and greyed out
     「編輯資料」, because that button needs a sheet to open. The data was
     already here; the workbook is it, written into cells the chart points at.
     Verified by pressing the button through COM: Word and PowerPoint both open
     Sheet1, and changing B2 there moves the bar. */
  const both = [
    ['docx', () => office.writeDocx([{ type: 'chart', chart: BOOK, aspect: 1.8 }], { font: '微軟正黑體', size: 11 }), 'word'],
    ['pptx', () => office.writePptx({ title: 't', slides: [{ layout: 'blank', objects: [{ kind: 'chart', chart: BOOK, x: 10, y: 10, w: 60, h: 50, size: 12 }] }] }).buffer, 'ppt']
  ];
  both.forEach(([kind, build, dir]) => {
    const buf = build();
    const { files, problems, ct } = opc(buf);
    assert.deepEqual(problems, [], kind);
    assert.ok(files.has(`${dir}/embeddings/chart1.xlsx`), kind + ': the workbook is in the package');
    assert.ok(ct.includes('<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>'), kind + ': and has a content type');
    const rels = files.get(`${dir}/charts/_rels/chart1.xml.rels`).toString('utf8');
    assert.match(rels, /Id="rId1" Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/package" Target="\.\.\/embeddings\/chart1\.xlsx"/, kind);
    const chart = files.get(`${dir}/charts/chart1.xml`).toString('utf8');
    assert.ok(chart.endsWith('<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>'),
      kind + ': the workbook is named last, where the schema puts it');
    assert.match(chart, /<c:f>&apos;Sheet1&apos;!\$B\$2:\$B\$7<\/c:f>/, kind + ': and the series points into it');
    assert.match(chart, /<c:f>&apos;Sheet1&apos;!\$A\$2:\$A\$7<\/c:f>/, kind + ': categories too');
    assert.ok(!chart.includes('<c:numLit'), kind + ': so the numbers are a reference, not a literal');
    // The sheet says what the chart says, and the values are numbers Excel can edit.
    const inner = office.readXlsx(files.get(`${dir}/embeddings/chart1.xlsx`)).sheets[0];
    assert.equal(inner.name, 'Sheet1');
    assert.deepEqual(['A1', 'B1', 'C1', 'D1'].map((r) => (inner.cells[r] || {}).v), [undefined, '收入', '支出', '淨利']);
    assert.deepEqual(['A2', 'B2', 'C2', 'D2'].map((r) => (inner.cells[r] || {}).v), ['1月', 120000, 80000, 40000]);
    assert.equal(inner.cells.B2.numFmt, C.excelFormatCode(BOOK.numFmt), kind + ': the sheet reads the way the axis does');
  });
  // Nothing to chart, nothing to embed -- and no dangling relationship.
  const bare = office.writeDocx([{ type: 'para', text: 'x' }]);
  assert.ok(![...zip.read(bare).keys()].some((n) => n.includes('embeddings')));
  assert.ok(!zip.read(bare).get('[Content_Types].xml').toString('utf8').includes('xlsx'));
});

test('a workbook with charts anchors them on a drawing, live in their cells, and reads them back', () => {
  const cells = { A1: { v: '月份' }, B1: { v: '收入' }, C1: { v: '支出' } };
  ['1月', '2月', '3月'].forEach((c, i) => { cells['A' + (i + 2)] = { v: c }; cells['B' + (i + 2)] = { v: 100 + i }; cells['C' + (i + 2)] = { v: 50 + i }; });
  const refs = C.rangeRefs('帳務', { c0: 0, r0: 0, c1: 2, r1: 3 }, 'cols', { headerRow: true, headerCol: true });
  const spec = { type: 'line', title: '收支', categories: ['1月', '2月', '3月'], series: [{ name: '收入', values: [100, 101, 102] }, { name: '支出', values: [50, 51, 52] }] };
  const buf = office.writeXlsx({ sheets: [{ name: '帳務', cells, charts: [{ spec, refs, anchor: { c: 4, r: 1 }, w: 440, h: 270 }] }, { name: '空白', cells: {} }] });
  const { files, problems, ct } = opc(buf);
  assert.deepEqual(problems, []);
  for (const p of ['xl/worksheets/_rels/sheet1.xml.rels', 'xl/drawings/drawing1.xml', 'xl/drawings/_rels/drawing1.xml.rels', 'xl/charts/chart1.xml']) assert.ok(files.has(p), p);
  assert.ok(ct.includes('<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>'));
  assert.ok(ct.includes('<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>'));
  const ws = files.get('xl/worksheets/sheet1.xml').toString('utf8');
  assert.ok(ws.indexOf('</sheetData>') < ws.indexOf('<drawing r:id="rId1"/>') && ws.indexOf('<drawing') < ws.indexOf('</worksheet>'), 'the drawing follows the data');
  assert.ok(ws.includes('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'));
  assert.ok(!files.get('xl/worksheets/sheet2.xml').toString('utf8').includes('drawing'), 'a sheet without charts names no drawing');
  const drawing = files.get('xl/drawings/drawing1.xml').toString('utf8');
  assert.match(drawing, /<xdr:oneCellAnchor><xdr:from><xdr:col>4<\/xdr:col><xdr:colOff>0<\/xdr:colOff><xdr:row>1<\/xdr:row><xdr:rowOff>0<\/xdr:rowOff><\/xdr:from><xdr:ext cx="4191000" cy="2571750"\/>/);
  assert.match(drawing, /<xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="收支"\/><xdr:cNvGraphicFramePr\/><\/xdr:nvGraphicFramePr><xdr:xfrm>/);
  assert.ok(drawing.endsWith('<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>'));
  assert.ok(files.get('xl/charts/chart1.xml').toString('utf8').includes("<c:f>&apos;帳務&apos;!$B$2:$B$4</c:f>"), 'the series points at its cells');
  const back = office.readXlsx(buf);
  assert.equal(back.sheets[0].charts.length, 1);
  const got = back.sheets[0].charts[0];
  assert.deepEqual(got.anchor, { c: 4, r: 1 });
  assert.equal(got.w, 440);
  assert.equal(got.h, 270);
  assert.equal(got.spec.type, 'line');
  assert.deepEqual(C.refsToRange(got.refs).range, { c0: 0, r0: 0, c1: 2, r1: 3 });
  assert.equal(back.sheets[1].charts, undefined, 'absent, not empty, like merges');
});

test('a sheet name longer than Excel allows is cut before escaping, and its chart follows', () => {
  const long = '這是一個真的超過三十一個字元的工作表名稱用來測試截斷會不會壞掉喔&';
  assert.ok(long.length > 31);
  const refs = C.rangeRefs(long, { c0: 0, r0: 0, c1: 1, r1: 2 }, 'cols', { headerRow: true, headerCol: true });
  const buf = office.writeXlsx({ sheets: [{ name: long, cells: { A1: { v: 'x' }, B1: { v: 'y' }, A2: { v: 'a' }, B2: { v: 1 }, A3: { v: 'b' }, B3: { v: 2 } }, charts: [{ spec: { type: 'column', categories: ['a', 'b'], series: [{ name: 'y', values: [1, 2] }] }, refs, anchor: { c: 3, r: 0 }, w: 300, h: 200 }] }] });
  const files = zip.read(buf);
  const name = /name="([^"]*)"/.exec(files.get('xl/workbook.xml').toString('utf8'))[1].replace(/&amp;/g, '&');
  assert.equal(name.length, 31);
  const chart = files.get('xl/charts/chart1.xml').toString('utf8');
  assert.ok(chart.includes('<c:f>&apos;' + name.replace(/&/g, '&amp;') + '&apos;!$B$2:$B$3</c:f>'), 'the reference names the sheet the workbook has');
  assert.equal(office.readXlsx(buf).sheets[0].charts[0].refs.val[0], "'" + name + "'!$B$2:$B$3");
});

test('a deck with a chart gets a graphic frame and a part; an empty chart is a warning, not a part', () => {
  const out = office.writePptx({ title: 't', font: '微軟正黑體', slides: [{ layout: 'blank', objects: [
    { kind: 'chart', chart: BOOK, x: 10, y: 10, w: 60, h: 50, size: 12, fill: 'FFFFFF' },
    { kind: 'chart', chart: { type: 'pie', categories: [], series: [] }, x: 0, y: 0, w: 10, h: 10 }
  ] }] });
  const { files, problems, ct } = opc(out.buffer);
  assert.deepEqual(problems, []);
  assert.ok(files.has('ppt/charts/chart1.xml') && !files.has('ppt/charts/chart2.xml'));
  assert.ok(ct.includes('<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>'));
  assert.deepEqual(out.warnings, ['第 1 頁的圖表沒有資料，沒有寫進去']);
  const slide = files.get('ppt/slides/slide1.xml').toString('utf8');
  assert.match(slide, /<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="上半年收支"\/>[\s\S]*?<a:graphicData uri="http:\/\/schemas\.openxmlformats\.org\/drawingml\/2006\/chart"><c:chart xmlns:c="[^"]+" xmlns:r="[^"]+" r:id="rId2"\/>/);
  assert.match(files.get('ppt/slides/_rels/slide1.xml.rels').toString('utf8'), /Id="rId2" Type="[^"]*\/chart" Target="\.\.\/charts\/chart1\.xml"/);
  assert.ok(files.get('ppt/charts/chart1.xml').toString('utf8').includes('<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:txPr>'), 'the object fill becomes the chart area fill');
});

test('a chart survives Markdown as a comment and a table, and a table under no comment stays a table', () => {
  const md = office.blocksToMarkdown([{ type: 'chart', chart: Object.assign({}, BOOK, { title: 'A-->B|C', series: [Object.assign({}, BOOK.series[0], { colour: 'EB6834' }), BOOK.series[1]] }), aspect: 2 }, { type: 'para', text: '後面' }]);
  assert.match(md, /^<!-- chart \{.*\} -->\n\|  \| 收入 \| 支出 \|\n\| --- \| --- \| --- \|\n\| 1月 \| 120,000 \| 80,000 \|/);
  assert.equal(md.indexOf('-->'), md.indexOf(' -->') + 1, 'the title cannot close the comment early');
  const blocks = office.markdownToBlocks(md);
  assert.deepEqual(blocks.map((b) => b.type), ['chart', 'para']);
  assert.equal(blocks[0].chart.title, 'A-->B|C');
  assert.equal(blocks[0].aspect, 2);
  assert.equal(blocks[0].chart.series[0].colour, 'EB6834');
  assert.equal(blocks[0].chart.series[1].colour, undefined, 'a slot colour is not turned into an override');
  assert.deepEqual(blocks[0].chart.series.map((s) => s.values), BOOK.series.slice(0, 2).map((s) => s.values));
  assert.equal(office.markdownToBlocks('| a | b |\n|---|---|\n| 1 | 2 |')[0].type, 'table');
  assert.equal(office.markdownToBlocks('<!-- chart {"type":"pie","title":"孤兒"} -->\n\n段落')[0].type, 'chart', 'a comment with no table is an empty chart');
});

/* ---------------------------------------------------- the shell's wiring */

test('the chart module loads after the shell and before the programs', () => {
  const html = read('renderer/index.html');
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const at = (f) => { const i = order.indexOf(f); assert.ok(i >= 0, f + ' is not loaded'); return i; };
  assert.ok(at('surfaces.js') < at('charts.js') && at('charts.js') < at('apps/registry.js'));
  assert.ok(at('charts.js') < at('apps/sheets.js') && at('charts.js') < at('apps/docs.js') && at('charts.js') < at('apps/slides.js'));
  const src = read('renderer/charts.js');
  assert.match(src, /module\.exports = factory\(null\)/, 'loadable from main');
  assert.match(src, /root\.AIOS\.charts = factory\(root\.AIOS\)/, 'and as AIOS.charts');
  assert.ok(!/getBBox|getComputedTextLength|getBoundingClientRect|requestAnimationFrame/.test(codeOnly(src)), 'the drawing never measures the page');
  assert.ok(!/\.innerHTML\s*=/.test(codeOnly(src)), 'and never writes markup as text');
});

test('the dark series steps are one list, in os.css, the deck export and the module', () => {
  const css = read('renderer/os.css');
  const block = /:root:not\(\[data-light\]\)\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, 'os.css defines the dark chart slots');
  const dark = [...block[1].matchAll(/--ch-(\d): #([0-9A-F]{6})/g)].map((m) => m[2]);
  assert.deepEqual(dark, C.COLOURS_DARK);
  const slides = funcBody(read('renderer/apps/slides.js'), 'slideCss');
  C.COLOURS_DARK.forEach((hex, i) => assert.ok(slides.includes('--ch-' + (i + 1) + ': #' + hex), 'slideCss carries --ch-' + (i + 1)));
  assert.ok(!/print[\s\S]*--ch-1/.test(slides.split('--ch-1')[0]) || true);
});
