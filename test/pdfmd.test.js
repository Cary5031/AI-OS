'use strict';

/* ===========================================================================
   PDF to Markdown tests
   ---------------------------------------------------------------------------
   The converter is imported and actually run, against a fake pdf.js document
   built out of line positions. That is deliberate: the structural tests in
   wiring.test.js read source text and cannot tell whether the code runs at all.
   A refactor once left two calls to a helper that had been deleted, which parsed
   fine and threw the moment a real document was converted.

   `withImages: false` is what makes this possible with no DOM: the image half
   needs a canvas, the text half needs nothing but numbers.

   The fake document speaks the parts of the pdf.js API the converter uses, with
   the same conventions -- transforms with the translation in [4] and [5], y
   growing upward in user space, and the viewport transform flipping it. Getting
   those conventions wrong in the fake would make these tests agree with a broken
   converter, so `pageLines` is checked against a known layout first.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = pathToFileURL(path.join(__dirname, '..', 'app', 'renderer', 'pdfmd.js')).href;

const PAGE_W = 600;
const PAGE_H = 800;

/** The subset of pdfjs.Util the converter calls. */
const fakePdfjs = {
  Util: {
    applyTransform(p, m) {
      const x = p[0];
      const y = p[1];
      p[0] = x * m[0] + y * m[2] + m[4];
      p[1] = x * m[1] + y * m[3] + m[5];
    }
  }
};

/**
 * Build a document from plain line descriptions.
 *
 * Each line is { text, size, x, y } where y counts down from the top in the same
 * direction a reader goes, and is converted to PDF user space here.
 *
 * `runs` places several pieces on one baseline. `gap` spaces them by advance
 * width, the way a glyph run inside a word is spaced; `at` places them at fixed x
 * positions, the way a table's cells are. The distinction matters: a first attempt
 * at the table tests used `gap`, so each row's columns started wherever the
 * previous row's text happened to end, and the converter correctly refused to call
 * that a table.
 */
function doc(pages, meta = {}) {
  return {
    numPages: pages.length,
    getMetadata: async () => ({ info: meta }),
    getPage: async (n) => {
      const lines = pages[n - 1];
      return {
        rotate: 0,
        getViewport: ({ scale = 1 }) => ({
          width: PAGE_W * scale,
          height: PAGE_H * scale,
          // Flip y and scale: the same shape pdf.js produces for rotation 0.
          transform: [scale, 0, 0, -scale, 0, PAGE_H * scale]
        }),
        getTextContent: async () => ({ items: items(lines) }),
        render: () => ({ promise: Promise.resolve() }),
        imageCoordinates: null
      };
    }
  };
}

function items(lines) {
  const out = [];
  for (const line of lines) {
    const size = line.size || 10;
    const userY = PAGE_H - line.y;          // back into y-up user space
    let x = line.x == null ? 60 : line.x;
    const chunks = line.runs || [line.text];

    chunks.forEach((chunk, i) => {
      if (line.at) x = line.at[i];
      else if (i > 0) x += line.gap || 0;
      const width = chunk.length * size * 0.6;
      out.push({
        str: chunk,
        width,
        height: size,
        hasEOL: false,
        transform: [size, 0, 0, size, x, userY]
      });
      x += width;
    });
  }
  return out;
}

async function convert(pages, opts = {}, meta = {}) {
  const { convert: run } = await import(SRC);
  return run(fakePdfjs, doc(pages, meta), Object.assign({ withImages: false }, opts));
}

/* ------------------------------------------------------------------ the fake */

test('the fake document lands text where the converter expects it', async () => {
  // If this is wrong every other test in the file is meaningless.
  const out = await convert([[
    { text: 'first', y: 100 },
    { text: 'second', y: 700 }
  ]]);
  const first = out.markdown.indexOf('first');
  const second = out.markdown.indexOf('second');
  assert.ok(first >= 0 && second >= 0, 'both lines must appear');
  assert.ok(first < second, 'a line nearer the top of the page must come out first');
});

/* -------------------------------------------------------------- the pipeline */

test('the converter runs end to end and returns the documented shape', async () => {
  // The regression this file exists for: nothing here checks a heuristic, only
  // that a real call completes and every field it promises is present.
  const out = await convert([[{ text: '\u4e00\u6bb5\u6587\u5b57', y: 100 }]]);

  assert.equal(typeof out.markdown, 'string');
  assert.ok(Array.isArray(out.images));
  assert.equal(typeof out.assetDir, 'string');
  assert.equal(typeof out.stats.pages, 'number');
  assert.equal(typeof out.stats.bodySize, 'number');
  assert.equal(typeof out.stats.linePitch, 'number');
  assert.ok(out.markdown.endsWith('\n'), 'the file should end with a newline');
});

test('heading level follows size relative to the body text', async () => {
  const body = [];
  for (let i = 0; i < 12; i++) body.push({ text: '\u672c\u6587'.repeat(20), y: 300 + i * 14 });

  const out = await convert([[
    { text: 'Huge title', size: 24, y: 60 },
    { text: 'Section', size: 15, y: 120 },
    { text: 'Sub', size: 13, y: 180 },
    { text: 'Minor', size: 11.5, y: 240 },
    ...body
  ]]);

  assert.match(out.markdown, /^# Huge title$/m);
  assert.match(out.markdown, /^## Section$/m);
  assert.match(out.markdown, /^### Sub$/m);
  assert.match(out.markdown, /^#### Minor$/m);
  assert.equal(out.stats.bodySize, 10, 'the body size is the one covering the most characters');
});

test('a title that wraps becomes one heading, not two', async () => {
  // Enough body text to establish the body size. That is not test scaffolding for
  // its own sake: the size covering the most characters is what "body" means, so a
  // page that is mostly title has no body to compare against and nothing on it
  // reads as a heading. Real documents are mostly body text.
  const body = [];
  for (let i = 0; i < 10; i++) body.push({ text: 'ordinary body text on a line'.repeat(2), y: 200 + i * 14 });

  const out = await convert([[
    { text: 'A very long document title that', size: 22, y: 60 },
    { text: 'runs onto a second line', size: 22, y: 86 },
    ...body
  ]]);
  const h1 = (out.markdown.match(/^# /gm) || []).length;
  assert.equal(h1, 1, 'two adjacent lines at the same size are one title');
  assert.match(out.markdown, /^# A very long document title that runs onto a second line$/m);
});

test('lines of a paragraph are joined, and a wide gap starts a new one', async () => {
  // 14pt pitch inside the paragraph, then a 40pt gap.
  const out = await convert([[
    { text: 'Sentence one continues', y: 100 },
    { text: 'onto the next line here', y: 114 },
    { text: 'and a third line too', y: 128 },
    { text: 'A separate paragraph', y: 168 },
    { text: 'with its own second line', y: 182 }
  ]]);

  const paras = out.markdown.trim().split(/\n{2,}/).filter((p) => !p.startsWith('<!--'));
  assert.equal(paras.length, 2, 'expected exactly two paragraphs, got: ' + JSON.stringify(paras));
  assert.match(paras[0], /Sentence one continues onto the next line here and a third line too/);
  assert.match(paras[1], /A separate paragraph with its own second line/);
});

test('a CJK line break joins without a space, a latin one with', async () => {
  const out = await convert([[
    { text: '\u4e2d\u6587\u7b2c\u4e00\u884c', y: 100 },
    { text: '\u7b2c\u4e8c\u884c\u6587\u5b57', y: 114 }
  ]]);
  assert.match(out.markdown, /\u4e2d\u6587\u7b2c\u4e00\u884c\u7b2c\u4e8c\u884c\u6587\u5b57/,
    'no space belongs between CJK characters across a line break');

  const latin = await convert([[
    { text: 'hello', y: 100 },
    { text: 'world', y: 114 }
  ]]);
  assert.match(latin.markdown, /hello world/);
});

test('spaces pdf.js inserts between CJK glyphs are removed', async () => {
  // This is what a CJK run actually arrives as: one item per glyph, spaced by
  // advance width. Left alone it reads "本 課 程".
  const out = await convert([[
    { text: '', runs: ['\u672c', '\u8ab2', '\u7a0b'], gap: 4, y: 100 },
    { text: 'FAX TO: 02-1234', y: 140 }
  ]]);
  assert.match(out.markdown, /\u672c\u8ab2\u7a0b/, 'CJK glyphs must close up');
  assert.match(out.markdown, /FAX TO: 02-1234/, 'latin spacing must survive');
});

test('bullets and numbers become lists, and indentation nests them', async () => {
  const out = await convert([[
    { text: '\u2022 top level item', x: 60, y: 100 },
    { text: '\u2022 nested item', x: 90, y: 118 },
    { text: '1. first numbered', x: 60, y: 136 },
    { text: '2. second numbered', x: 60, y: 154 }
  ]]);

  assert.match(out.markdown, /^- top level item$/m);
  assert.match(out.markdown, /^ {2,}- nested item$/m, 'a deeper x becomes a nested item');
  assert.match(out.markdown, /^1\. first numbered$/m);
  assert.equal((out.markdown.match(/^1\. /gm) || []).length, 2,
    'Markdown renumbers ordered items, so both are emitted as 1.');
});

test('a marker running straight into CJK is still a marker', async () => {
  // collapse() removes the space after a fullwidth stop, so requiring whitespace
  // after the marker turned every numbered CJK list back into paragraphs.
  const out = await convert([[
    { text: '1\uff0e\u7d50\u5408\u5927\u578b\u8a9e\u8a00\u6a21\u578b', y: 100 },
    { text: '2\uff0e\u638c\u63e1\u67e5\u8a62\u6280\u5de7', y: 118 }
  ]]);
  assert.equal((out.markdown.match(/^1\. /gm) || []).length, 2);
});

test('a version number is not a list item', async () => {
  const out = await convert([[{ text: '1.5 times the width', y: 100 }]]);
  assert.ok(!/^1\. /m.test(out.markdown), '"1.5" must stay in the paragraph');
});

test('private-use bullets are recognised and never left in the text', async () => {
  // A subset of Wingdings maps its glyphs into U+E000..U+F8FF. Those codepoints
  // render as tofu boxes in every font, and they carry the list structure.
  const out = await convert([[
    { text: '\uf076 \u8ab2\u7a0b\u76ee\u6a19', y: 100 },
    { text: '\uf06c \u8ab2\u7a0b\u7279\u8272', y: 118 }
  ]]);
  assert.match(out.markdown, /^- \u8ab2\u7a0b\u76ee\u6a19$/m);
  assert.match(out.markdown, /^- \u8ab2\u7a0b\u7279\u8272$/m);
  assert.ok(!/[\ue000-\uf8ff]/.test(out.markdown), 'no private-use codepoint may survive');
});

test('bullets set side by side on one line become separate items', async () => {
  const out = await convert([[
    { text: '', runs: ['\uf06c left item', '\uf06c right item'], gap: 120, y: 100 }
  ]]);
  assert.match(out.markdown, /^- left item$/m);
  assert.match(out.markdown, /^- right item$/m);
});

test('a running header repeated across pages is dropped', async () => {
  const header = { text: 'Confidential draft', y: 30 };
  const footer = { text: 'Page footer text', y: 780 };
  const page = (body) => [header, { text: body, y: 300 }, footer];

  const out = await convert([page('First page body'), page('Second page body'), page('Third page body')]);

  assert.ok(!out.markdown.includes('Confidential draft'), 'the header repeats and is furniture');
  assert.ok(!out.markdown.includes('Page footer text'), 'so is the footer');
  assert.match(out.markdown, /First page body/);
  assert.match(out.markdown, /Third page body/);
  assert.equal(out.stats.droppedRunningLines, 2);
});

test('a heading near the top of a single page is not mistaken for furniture', async () => {
  const out = await convert([[
    { text: 'Introduction', size: 18, y: 40 },
    { text: 'body text', y: 200 }
  ]]);
  assert.match(out.markdown, /Introduction/);
});

test('aligned rows become a table, and prose does not', async () => {
  // Fixed column positions, which is what makes a table a table.
  const row = (a, b, c, y) => ({ text: '', runs: [a, b, c], at: [60, 200, 340], y });
  const out = await convert([[
    row('Name', 'Size', 'Date', 100),
    row('one', '10', 'Jan', 118),
    row('two', '20', 'Feb', 136),
    row('three', '30', 'Mar', 154)
  ]]);

  assert.match(out.markdown, /^\| Name \| Size \| Date \|$/m);
  assert.match(out.markdown, /^\| --- \| --- \| --- \|$/m);
  assert.match(out.markdown, /^\| three \| 30 \| Mar \|$/m);

  // Two lines that happen to have a gap are not evidence of a table.
  const prose = await convert([[
    { text: '', runs: ['a phrase', 'and another'], gap: 80, y: 100 },
    { text: 'ordinary following line', y: 118 }
  ]]);
  assert.ok(!/\| --- \|/.test(prose.markdown), 'one row is not a table');
});

test('a pipe inside a cell is escaped so the table survives', async () => {
  const row = (a, b, c, y) => ({ text: '', runs: [a, b, c], at: [60, 200, 340], y });
  const out = await convert([[
    row('a|b', 'c', 'd', 100),
    row('e', 'f', 'g', 118),
    row('h', 'i', 'j', 136)
  ]]);
  assert.match(out.markdown, /a\\\|b/);
});

test('text that looks like markup is escaped', async () => {
  const out = await convert([[
    { text: '# not a heading', y: 100 },
    { text: '> not a quote', y: 200 },
    { text: '| not a table', y: 300 }
  ]]);
  assert.match(out.markdown, /^\\# not a heading$/m);
  assert.match(out.markdown, /^\\> not a quote$/m);
  assert.match(out.markdown, /^\\\| not a table$/m);
});

test('the document title becomes the top heading', async () => {
  const out = await convert([[{ text: 'body', y: 100 }]], {}, { Title: 'Real Title' });
  assert.match(out.markdown, /^# Real Title$/m);
});

test('page markers appear only when there is more than one page', async () => {
  const one = await convert([[{ text: 'only page', y: 100 }]]);
  assert.ok(!/<!-- /.test(one.markdown), 'a single page needs no marker');

  const two = await convert([[{ text: 'a', y: 100 }], [{ text: 'b', y: 100 }]]);
  assert.equal((two.markdown.match(/<!-- \u7b2c \d+ \u9801 -->/g) || []).length, 2);
});

test('a page with no text layer says so rather than coming out blank', async () => {
  const out = await convert([[{ text: 'page one has text', y: 100 }], []]);
  assert.match(out.markdown, /\u6ca1\u6709 OCR|\u6389\u5340|\u6389\u5716\u5c64|\u6587\u5b57\u5716\u5c64/,
    'the empty page must be explained');
  assert.equal(out.stats.textlessPages, 1);
});

test('line pitch is measured from the document, not assumed', async () => {
  const tight = [];
  for (let i = 0; i < 10; i++) tight.push({ text: 'line ' + i, y: 100 + i * 11 });
  const loose = [];
  for (let i = 0; i < 10; i++) loose.push({ text: 'line ' + i, y: 100 + i * 26 });

  const a = await convert([tight]);
  const b = await convert([loose]);

  assert.ok(a.stats.linePitch < b.stats.linePitch);
  // Whatever the spacing, a run of evenly spaced lines is one paragraph.
  const paras = (md) => md.trim().split(/\n{2,}/).filter(Boolean).length;
  assert.equal(paras(a.markdown), 1, 'tight spacing: one paragraph');
  assert.equal(paras(b.markdown), 1, 'loose spacing: still one paragraph');
});

test('two columns are read down, even when their baselines align', async () => {
  // Shared baselines is the normal case, not an edge case: most two-column layouts
  // line up across the gutter. It is also what defeated three earlier attempts at
  // this, because grouping runs into lines before looking for the gutter merges the
  // two columns into single lines and destroys the evidence.
  const lines = [];
  for (let i = 0; i < 5; i++) {
    lines.push({ text: 'left ' + i, x: 60, y: 200 + i * 14 });
    lines.push({ text: 'right ' + i, x: 380, y: 200 + i * 14 });
  }

  const out = await convert([lines]);
  const last = out.markdown.indexOf('left 4');
  const first = out.markdown.indexOf('right 0');
  assert.ok(last >= 0 && first >= 0, 'both columns must be present');
  assert.ok(last < first, 'the whole left column comes before the right one');
});

test('a full-width line separates one pair of columns from the next', async () => {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push({ text: 'aleft ' + i, x: 60, y: 100 + i * 14 });
    lines.push({ text: 'aright ' + i, x: 380, y: 100 + i * 14 });
  }
  lines.push({ text: 'A heading that spans the entire width of the page here', x: 60, y: 300 });
  for (let i = 0; i < 4; i++) {
    lines.push({ text: 'bleft ' + i, x: 60, y: 400 + i * 14 });
    lines.push({ text: 'bright ' + i, x: 380, y: 400 + i * 14 });
  }

  const out = await convert([lines]);
  const order = ['aleft 0', 'aright 0', 'A heading that spans', 'bleft 0', 'bright 0']
    .map((s) => out.markdown.indexOf(s));
  assert.ok(order.every((i) => i >= 0), 'every part must survive: ' + JSON.stringify(order));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i - 1] < order[i],
      'out of order at ' + i + ': ' + JSON.stringify(order));
  }
});

test('a single-column page is left alone by the column pass', async () => {
  const lines = [];
  for (let i = 0; i < 8; i++) {
    lines.push({ text: 'paragraph line number ' + i + ' running the full width', x: 60, y: 100 + i * 14 });
  }
  const out = await convert([lines]);
  const at3 = out.markdown.indexOf('number 3');
  const at5 = out.markdown.indexOf('number 5');
  assert.ok(at3 >= 0 && at3 < at5, 'reading order must be unchanged');
});

test('a page with no text layer carries the model\'s reading when the caller has one', async () => {
  const out = await convert([[{ text: 'page one has text', y: 100 }], []],
    { ocr: { 2: '| 品名 | 數量 |\n|---|---|\n| 螺絲 | 100 |' } });
  assert.match(out.markdown, /\| 螺絲 \| 100 \|/, 'the transcription stands where the text would have been');
  assert.doesNotMatch(out.markdown, /沒有文字圖層/, 'and the note about the missing layer is gone');
  assert.equal(out.stats.textlessPages, 1);
  assert.equal(out.stats.ocrPages, 1);

  const without = await convert([[{ text: 'page one has text', y: 100 }], []]);
  assert.equal(without.stats.ocrPages, 0);
  assert.match(without.markdown, /OCR/, 'without one, the note says how to get it');
});
