/* ===========================================================================
   AI-OS // PDF layout to Excel and Word
   ---------------------------------------------------------------------------
   Runs inside the aios-pdf:// viewer document, next to pdf.js and the Markdown
   converter, because the two things it needs are there: text with coordinates,
   and the page drawn on a canvas. Everything in this file is a pure function of
   numbers and strings, so the unit tests run it without a DOM.

   WHY A SECOND CONVERTER
   pdfmd.js reflows a document into Markdown, and says so honestly: Markdown has
   no page geometry. A spreadsheet does. A person who asks for "the PDF as Excel"
   wants the numbers where they were on the page, with the table lines where
   they were, and that is a different problem from reading order.

   HOW THE GRID IS FOUND
   Two sources, and the order matters. The page is drawn and its dark pixel runs
   are read back as rules -- the lines a table was drawn with. Those rules are
   column and row boundaries first; text that starts just to the right of a rule
   is padding inside the cell, not a new column. Only then do the places where
   text starts add boundaries of their own, so a page with no lines at all still
   comes out on a grid that follows its text.

   Cells enclosed on every side by rules but with no rule between them are one
   cell that the grid cut in two; they are merged back. That is how a header
   spanning three columns, and a paragraph wrapped onto four lines inside one
   box, come out as one cell each. Cells outside any box are never merged by
   the rules, only by their own text running across empty neighbours.

   WHAT IT HONESTLY CANNOT DO
   Bold, italics and typefaces are not read: pdf.js names fonts by an internal
   id and the real name costs a full render pass per page. Sizes are kept.
   A scanned page has no text to place, so it goes through the model's OCR as
   Markdown and comes back on a plain grid -- order and tables, not positions.
   =========================================================================== */

/* Rules: the shortest run of dark pixels worth calling a line, and the thickest
   stroke that is still a line rather than a filled area, both in points. */
export const RULE = { minLen: 18, maxThick: 3, tol: 2.5 };

/* Below this luma a pixel is ink. Table rules are often grey -- #999 is the
   default in more than one office suite -- and a threshold that only saw black
   missed them; light fills (#eee and up) stay out. */
const DARK = 200;

/* Text starting within this distance to the right of a rule is inside the
   cell that rule opens, not the start of a column of its own. */
const CELL_PAD = 8;

/* Points to CSS pixels, which is what the sheet stores widths and heights in. */
const PX = 96 / 72;

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/* A thin black line, in the vocabulary AIOS.borders and office.js share. The
   edges are keyed t / r / b / l there, and a border written with the long
   names is a border nobody reads: the writers look for the short keys only. */
const LINE = { style: 'single', width: 0.75, colour: '000000' };
const THIN = { style: 'single', width: 0.5, colour: '808080' };
const EDGES = ['t', 'r', 'b', 'l'];
const allEdges = (pen) => ({ t: { ...pen }, r: { ...pen }, b: { ...pen }, l: { ...pen } });

/* Chromium's PDF export maps some glyphs to the Kangxi radical code points --
   月 comes back as ⽉ (U+2F49), 金 as ⾦ -- and pdf.js hands them over as they
   are. They look right and compare wrong. NFKC folds each one back to the
   ideograph; applied per character, so nothing else in the text is touched. */
export function unifyRadicals(s) {
  return String(s || '').replace(/[\u2e80-\u2eff\u2f00-\u2fdf]/g, (c) => {
    const n = c.normalize('NFKC');
    return n.length === 1 ? n : c;
  });
}

/* ------------------------------------------------------------------- rules -- */

/**
 * Read the lines off a rendered page.
 *
 * `data` is the RGBA buffer of a canvas `width` x `height` pixels drawn at
 * `scale` pixels per point; the rules come back in points. A run of dark pixels
 * at least RULE.minLen long is a candidate; runs on adjacent pixel rows with the
 * same extent are one stroke; strokes thicker than RULE.maxThick are filled
 * areas (a shaded header, a photograph) and are dropped. Strokes that lie
 * inside a glyph's own box are that glyph -- the crossbar of a large 一 is as
 * long as a short rule -- so `parts` are consulted to drop them.
 */
export function rulesFromPixels(data, width, height, scale, parts) {
  const s = Number(scale) > 0 ? Number(scale) : 1;
  const minLen = Math.max(4, Math.round(RULE.minLen * s));
  const maxThick = Math.max(1, Math.round(RULE.maxThick * s));
  const dark = (x, y) => {
    const i = (y * width + x) * 4;
    return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 < DARK;
  };

  const h = strokes(width, height, minLen, maxThick, (a, b) => dark(a, b));
  const v = strokes(height, width, minLen, maxThick, (a, b) => dark(b, a));

  const glyphs = Array.isArray(parts) ? parts : [];
  const insideGlyph = (x0, x1, y0, y1) => glyphs.some((p) =>
    x0 >= p.x - 1 && x1 <= p.x + p.w + 1 && y0 >= p.y - p.h - 1 && y1 <= p.y + 1);

  const hs = h.map((r) => ({ y: (r.a0 + r.a1) / 2 / s, x0: r.b0 / s, x1: r.b1 / s }))
    .filter((r) => !insideGlyph(r.x0, r.x1, r.y, r.y));
  const vs = v.map((r) => ({ x: (r.a0 + r.a1) / 2 / s, y0: r.b0 / s, y1: r.b1 / s }))
    .filter((r) => !insideGlyph(r.x, r.x, r.y0, r.y1));

  return { h: mergeRules(hs, 'y', 'x0', 'x1'), v: mergeRules(vs, 'x', 'y0', 'y1') };
}

/**
 * Runs along one axis, joined across the other into strokes.
 *
 * `along` is the length of the axis a run lies on and `across` how many such
 * lines there are; `px(a, b)` reads the pixel at position `a` along the run on
 * line `b`. Returned strokes have `a0..a1` across (thickness) and `b0..b1` along.
 */
function strokes(along, across, minLen, maxThick, px) {
  const out = [];
  let open = [];
  for (let line = 0; line < across; line++) {
    const runs = [];
    let a = 0;
    while (a < along) {
      if (!px(a, line)) { a++; continue; }
      let e = a;
      while (e + 1 < along && px(e + 1, line)) e++;
      if (e - a + 1 >= minLen) runs.push({ b0: a, b1: e });
      a = e + 1;
    }
    const next = [];
    for (const r of runs) {
      const len = r.b1 - r.b0 + 1;
      const prev = open.find((o) => o.a1 === line - 1 &&
        Math.min(o.b1, r.b1) - Math.max(o.b0, r.b0) + 1 >= 0.8 * Math.min(len, o.b1 - o.b0 + 1));
      if (prev) {
        prev.a1 = line;
        prev.b0 = Math.min(prev.b0, r.b0);
        prev.b1 = Math.max(prev.b1, r.b1);
        next.push(prev);
      } else {
        next.push({ a0: line, a1: line, b0: r.b0, b1: r.b1 });
      }
    }
    for (const o of open) {
      if (next.indexOf(o) < 0 && o.a1 - o.a0 + 1 <= maxThick) out.push(o);
    }
    open = next;
  }
  for (const o of open) if (o.a1 - o.a0 + 1 <= maxThick) out.push(o);
  return out;
}

/** Collinear rules that touch or overlap become one; double lines become one. */
function mergeRules(rules, at, from, to) {
  const sorted = rules.slice().sort((p, q) => (p[at] - q[at]) || (p[from] - q[from]));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[at] - r[at]) <= RULE.tol && r[from] <= last[to] + RULE.tol) {
      last[to] = Math.max(last[to], r[to]);
      last[from] = Math.min(last[from], r[from]);
    } else {
      out.push({ [at]: r[at], [from]: r[from], [to]: r[to] });
    }
  }
  return out;
}

/* -------------------------------------------------------------------- text -- */

/**
 * Glyph runs into lines, and lines into cells: a gap wider than the text is
 * tall ends a cell. The same rule pdfmd.js uses, so the two converters agree on
 * where a table's columns are.
 */
export function runsOf(parts) {
  const sorted = (parts || []).filter((p) => p && typeof p.str === 'string' && p.str.trim())
    .slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const lines = [];
  for (const p of sorted) {
    const last = lines[lines.length - 1];
    const tol = Math.max(2, p.h * 0.5);
    if (last && Math.abs(p.y - last.y) <= tol) {
      last.parts.push(p);
      last.y = (last.y * (last.parts.length - 1) + p.y) / last.parts.length;
      last.h = Math.max(last.h, p.h);
    } else {
      lines.push({ y: p.y, h: p.h, parts: [p] });
    }
  }
  const runs = [];
  for (const line of lines) {
    line.parts.sort((a, b) => a.x - b.x);
    let cur = null;
    for (let i = 0; i < line.parts.length; i++) {
      const p = line.parts[i];
      const prev = line.parts[i - 1];
      const gap = prev ? p.x - (prev.x + prev.w) : 0;
      if (!cur || gap > p.h * 1.4) {
        cur = { x: p.x, x1: p.x + p.w, y: line.y, h: p.h, parts: [p] };
        runs.push(cur);
      } else {
        cur.parts.push(p);
        cur.x1 = Math.max(cur.x1, p.x + p.w);
        cur.h = Math.max(cur.h, p.h);
      }
    }
  }
  return runs.map((r) => ({ x: r.x, x1: r.x1, y: r.y, h: r.h, text: joinParts(r.parts) }))
    .filter((r) => r.text);
}

function joinParts(parts) {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i > 0) {
      const prev = parts[i - 1];
      const gap = p.x - (prev.x + prev.w);
      const a = out.slice(-1);
      const b = p.str.slice(0, 1);
      if (gap > p.h * 0.22 && !(CJK.test(a) && CJK.test(b)) && !/\s$/.test(out) && !/^\s/.test(p.str)) {
        out += ' ';
      }
    }
    out += p.str;
  }
  return unifyRadicals(out).replace(/([぀-ヿ㐀-䶿一-鿿豈-﫿]) (?=[぀-ヿ㐀-䶿一-鿿豈-﫿])/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

/* -------------------------------------------------------------------- grid -- */

/** Sorted positions, with any two closer than `tol` collapsed into one. */
function cluster(values, tol) {
  const sorted = values.slice().sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) {
    if (out.length && v - out[out.length - 1] <= tol) continue;
    out.push(v);
  }
  return out;
}

/** The index of the last boundary at or before `v` (with tolerance), or -1. */
function bandAt(bounds, v, tol) {
  let i = -1;
  for (let k = 0; k < bounds.length; k++) {
    if (bounds[k] <= v + tol) i = k; else break;
  }
  return i;
}

/**
 * The page as a grid: column and row boundaries, which edges between cells are
 * closed by a rule, the enclosed regions merged back into one cell each, and
 * every text run placed in its cell. Everything downstream -- the sheet and the
 * document -- reads this.
 */
export function gridOf(page) {
  const rules = page.rules || { h: [], v: [] };
  const hs = rules.h || [];
  const vs = rules.v || [];
  const runs = runsOf(page.parts);
  const tol = RULE.tol;

  /* Boundaries: rules first, then the text that is not inside a cell's padding. */
  const ruleX = cluster(vs.map((r) => r.x), tol);
  const ruleY = cluster(hs.map((r) => r.y), tol);
  const textX = runs.map((r) => r.x)
    .filter((x) => !ruleX.some((rx) => x >= rx - tol && x <= rx + CELL_PAD));
  const textY = runs.map((r) => r.y - r.h)
    .filter((top, i) => !ruleY.some((ry) => ry >= top - runs[i].h && ry <= top + runs[i].h * 0.3));
  const colX = cluster(ruleX.concat(textX), tol);
  const rowY = cluster(ruleY.concat(textY), tol);
  if (!colX.length || !rowY.length) {
    return { cols: 0, rows: 0, colX: [], rowY: [], right: 0, bottom: 0, closedV: [], closedH: [], regions: [], cells: {}, runs: [] };
  }

  const right = Math.max(colX[colX.length - 1] + 20, ...runs.map((r) => r.x1),
    ...hs.map((r) => r.x1));
  const bottom = Math.max(rowY[rowY.length - 1] + 12, ...runs.map((r) => r.y + r.h * 0.3),
    ...vs.map((r) => r.y1));
  const cols = colX.length;
  const rows = rowY.length;
  const colEnd = (i) => (i + 1 < cols ? colX[i + 1] : right);
  const rowEnd = (j) => (j + 1 < rows ? rowY[j + 1] : bottom);

  /* closedV[i][j]: the edge on the LEFT of column i at row j is a rule.
     closedH[i][j]: the edge on the TOP of row j at column i is a rule.
     Both have one extra entry for the far side of the last column / row. */
  const closedV = [];
  for (let i = 0; i <= cols; i++) {
    closedV[i] = [];
    const x = i < cols ? colX[i] : right;
    for (let j = 0; j < rows; j++) {
      const mid = (rowY[j] + rowEnd(j)) / 2;
      closedV[i][j] = vs.some((r) => Math.abs(r.x - x) <= tol && r.y0 <= mid + tol && r.y1 >= mid - tol);
    }
  }
  const closedH = [];
  for (let i = 0; i < cols; i++) {
    closedH[i] = [];
    const mid = (colX[i] + colEnd(i)) / 2;
    for (let j = 0; j <= rows; j++) {
      const y = j < rows ? rowY[j] : bottom;
      closedH[i][j] = hs.some((r) => Math.abs(r.y - y) <= tol && r.x0 <= mid + tol && r.x1 >= mid - tol);
    }
  }

  /* Regions: flood through open edges. A region whose every outer edge is closed
     is one box on the page; if it is rectangular it becomes one merged cell. */
  const region = [];
  for (let i = 0; i < cols; i++) region[i] = new Array(rows).fill(-1);
  const regions = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (region[i][j] >= 0) continue;
      const id = regions.length;
      const members = [];
      let enclosed = true;
      const stack = [[i, j]];
      region[i][j] = id;
      while (stack.length) {
        const [c, r] = stack.pop();
        members.push([c, r]);
        const step = (nc, nr, open) => {
          if (!open) return;
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) { enclosed = false; return; }
          if (region[nc][nr] >= 0) return;
          region[nc][nr] = id;
          stack.push([nc, nr]);
        };
        step(c - 1, r, !closedV[c][r]);
        step(c + 1, r, !closedV[c + 1][r]);
        step(c, r - 1, !closedH[c][r]);
        step(c, r + 1, !closedH[c][r + 1]);
      }
      const c0 = Math.min(...members.map((m) => m[0]));
      const c1 = Math.max(...members.map((m) => m[0]));
      const r0 = Math.min(...members.map((m) => m[1]));
      const r1 = Math.max(...members.map((m) => m[1]));
      const rect = members.length === (c1 - c0 + 1) * (r1 - r0 + 1);
      regions.push({ id, c0, c1, r0, r1, enclosed, rect, merged: enclosed && rect && members.length > 1 });
    }
  }
  const anchor = (c, r) => {
    const g = regions[region[c][r]];
    return g.merged ? [g.c0, g.r0] : [c, r];
  };

  /* Place the text. A run that crosses into empty, unboxed neighbours takes them. */
  const cells = {};
  const placed = [];
  for (const run of runs) {
    let c = bandAt(colX, run.x, 1.5);
    let r = bandAt(rowY, run.y - run.h * 0.5, 0);
    if (c < 0) c = 0;
    if (r < 0) r = 0;
    const [ac, ar] = anchor(c, r);
    const key = ac + ',' + ar;
    let cell = cells[key];
    if (!cell) {
      const g = regions[region[ac][ar]];
      cell = { c: ac, r: ar, c1: g.merged ? g.c1 : ac, r1: g.merged ? g.r1 : ar, runs: [], boxed: g.enclosed };
      cells[key] = cell;
    }
    cell.runs.push(run);
    placed.push({ run, key });
  }
  for (const key of Object.keys(cells)) {
    const cell = cells[key];
    cell.runs.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    const g = regions[region[cell.c][cell.r]];
    if (!g.merged && cell.runs.length === 1) {
      /* Reach right across empty cells that are not boxed by anything. */
      const run = cell.runs[0];
      let end = cell.c;
      while (end + 1 < cols && colX[end + 1] < run.x1 - 1.5) {
        const nk = (end + 1) + ',' + cell.r;
        const ng = regions[region[end + 1][cell.r]];
        if (cells[nk] || ng.enclosed || closedV[end + 1][cell.r]) break;
        end++;
      }
      cell.c1 = end;
    }
    cell.h = Math.max(...cell.runs.map((x) => x.h));
    cell.text = textOfRuns(cell.runs);
    cell.lines = linesOfRuns(cell.runs);
    cell.align = alignOf(cell, colX[cell.c], colEnd(cell.c1));
  }

  return { cols, rows, colX, rowY, right, bottom, closedV, closedH, regions, region, cells, runs };
}

function linesOfRuns(runs) {
  const lines = [];
  for (const r of runs) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(r.y - last.y) <= Math.max(2, r.h * 0.5)) {
      last.text += (CJK.test(last.text.slice(-1)) && CJK.test(r.text.slice(0, 1)) ? '' : ' ') + r.text;
      last.x1 = Math.max(last.x1, r.x1);
    } else {
      lines.push({ y: r.y, h: r.h, x: r.x, x1: r.x1, text: r.text });
    }
  }
  return lines;
}

function textOfRuns(runs) {
  return linesOfRuns(runs).map((l) => l.text).join('\n');
}

/** Where a single run sits inside its band, when the band is wider than it. */
function alignOf(cell, x0, x1) {
  if (cell.runs.length !== 1) return '';
  const run = cell.runs[0];
  const slack = (x1 - x0) - (run.x1 - run.x);
  if (slack < 6) return '';
  const left = run.x - x0;
  const rightGap = x1 - run.x1;
  if (rightGap <= 3 && left > 3) return 'right';
  if (Math.abs(left - rightGap) <= 3 && left > 3) return 'center';
  return '';
}

/* ------------------------------------------------------------------- sheet -- */

export function colName(i) {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

/**
 * One page as one worksheet: a cell per grid cell, merges for the boxes, a
 * border wherever a rule ran, widths and heights from the bands.
 */
export function sheetFrom(page, name) {
  const g = gridOf(page);
  const cells = {};
  const merges = [];
  const colWidths = {};
  const rowHeights = {};
  if (!g.cols) return { name: name || '工作表1', cells, colWidths, rowHeights, merges, freeze: { rows: 0, cols: 0 } };

  const colEnd = (i) => (i + 1 < g.cols ? g.colX[i + 1] : g.right);
  const rowEnd = (j) => (j + 1 < g.rows ? g.rowY[j + 1] : g.bottom);
  for (let i = 0; i < g.cols; i++) colWidths[i] = Math.round(Math.min(600, Math.max(12, (colEnd(i) - g.colX[i]) * PX)));
  for (let j = 0; j < g.rows; j++) rowHeights[j] = Math.round(Math.min(300, Math.max(14, (rowEnd(j) - g.rowY[j]) * PX)));

  const at = (c, r) => {
    const k = colName(c) + (r + 1);
    if (!cells[k]) cells[k] = { v: '' };
    return cells[k];
  };

  /* Borders: every closed edge, written on the boxed side of it. A table's
     top rule is the top border of its first row, not the bottom border of the
     title sitting above the table -- a title with a line under it is a
     different thing from a table, and Excel draws the line once either way.
     A rule with no box on either side (a three-line table, an underline)
     goes on both cells, or it would be lost. */
  const boxed = (c, r) => c >= 0 && c < g.cols && r >= 0 && r < g.rows &&
    g.regions[g.region[c][r]].enclosed;
  for (let i = 0; i <= g.cols; i++) {
    for (let j = 0; j < g.rows; j++) {
      if (!g.closedV[i][j]) continue;
      const rightBoxed = boxed(i, j);
      const leftBoxed = boxed(i - 1, j);
      const both = !rightBoxed && !leftBoxed;
      if (i < g.cols && (rightBoxed || both)) edge(at(i, j), 'l');
      if (i > 0 && (leftBoxed || both)) edge(at(i - 1, j), 'r');
    }
  }
  for (let i = 0; i < g.cols; i++) {
    for (let j = 0; j <= g.rows; j++) {
      if (!g.closedH[i][j]) continue;
      const belowBoxed = boxed(i, j);
      const aboveBoxed = boxed(i, j - 1);
      const both = !belowBoxed && !aboveBoxed;
      if (j < g.rows && (belowBoxed || both)) edge(at(i, j), 't');
      if (j > 0 && (aboveBoxed || both)) edge(at(i, j - 1), 'b');
    }
  }

  /* Merges: the boxes, and text that reached across empty neighbours. */
  for (const reg of g.regions) {
    if (reg.merged) merges.push({ c0: reg.c0, r0: reg.r0, c1: reg.c1, r1: reg.r1 });
  }
  for (const key of Object.keys(g.cells)) {
    const cell = g.cells[key];
    const cv = at(cell.c, cell.r);
    cv.v = cell.text;
    const size = Math.round(cell.h);
    if (size >= 6 && size <= 72 && size !== 11) cv.size = size;
    if (cell.align) cv.align = cell.align;
    if (cell.lines.length > 1) cv.wrap = true;
    const boxed = g.regions[g.region[cell.c][cell.r]].merged;
    if (!boxed && cell.c1 > cell.c) merges.push({ c0: cell.c, r0: cell.r, c1: cell.c1, r1: cell.r });
  }

  return { name: name || '工作表1', cells, colWidths, rowHeights, merges, freeze: { rows: 0, cols: 0 } };
}

function edge(cell, side, pen) {
  if (!cell.border) cell.border = {};
  cell.border[side] = Object.assign({}, pen || LINE);
}

/* ---------------------------------------------------------------- document -- */

/**
 * One page as document blocks: tables where the rules drew boxes, paragraphs
 * everywhere else, in reading order down the page.
 *
 * A table is a connected set of boxes. Its columns and rows are the boundaries
 * that some rule actually closes, so the extra boundaries the text inside a
 * box added to the page grid do not become empty columns in Word.
 */
export function docFrom(page) {
  const g = gridOf(page);
  if (!g.cols) return { blocks: [], tables: 0 };

  /* Group enclosed regions that touch into tables. */
  const boxes = g.regions.filter((r) => r.enclosed && r.rect);
  const parent = boxes.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touching = (a, b) =>
    (a.c1 + 1 === b.c0 || b.c1 + 1 === a.c0) && a.r0 <= b.r1 && b.r0 <= a.r1 ||
    (a.r1 + 1 === b.r0 || b.r1 + 1 === a.r0) && a.c0 <= b.c1 && b.c0 <= a.c1;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (touching(boxes[i], boxes[j])) parent[find(i)] = find(j);
    }
  }
  const groups = {};
  boxes.forEach((b, i) => { (groups[find(i)] = groups[find(i)] || []).push(b); });

  const tables = [];
  for (const members of Object.values(groups)) {
    const c0 = Math.min(...members.map((m) => m.c0));
    const c1 = Math.max(...members.map((m) => m.c1));
    const r0 = Math.min(...members.map((m) => m.r0));
    const r1 = Math.max(...members.map((m) => m.r1));
    /* The boundaries a rule closes somewhere inside this table. */
    const cols = [c0];
    for (let i = c0 + 1; i <= c1; i++) {
      let closed = false;
      for (let j = r0; j <= r1; j++) if (g.closedV[i][j]) { closed = true; break; }
      if (closed) cols.push(i);
    }
    const rows = [r0];
    for (let j = r0 + 1; j <= r1; j++) {
      let closed = false;
      for (let i = c0; i <= c1; i++) if (g.closedH[i][j]) { closed = true; break; }
      if (closed) rows.push(j);
    }
    const colOf = (c) => { let k = 0; while (k + 1 < cols.length && cols[k + 1] <= c) k++; return k; };
    const rowOf = (r) => { let k = 0; while (k + 1 < rows.length && rows[k + 1] <= r) k++; return k; };

    const grid = [];
    for (let r = 0; r < rows.length; r++) grid.push(new Array(cols.length).fill(''));
    const merges = [];
    const cellStyles = {};
    for (const m of members) {
      const tc0 = colOf(m.c0), tc1 = colOf(m.c1), tr0 = rowOf(m.r0), tr1 = rowOf(m.r1);
      const cell = g.cells[m.c0 + ',' + m.r0];
      if (cell) grid[tr0][tc0] = cell.text;
      if (tc1 > tc0 || tr1 > tr0) merges.push({ c0: tc0, r0: tr0, c1: tc1, r1: tr1 });
      const border = {};
      if (g.closedH[m.c0][m.r0]) border.t = Object.assign({}, LINE);
      if (g.closedH[m.c0][m.r1 + 1]) border.b = Object.assign({}, LINE);
      if (g.closedV[m.c0][m.r0]) border.l = Object.assign({}, LINE);
      if (g.closedV[m.c1 + 1][m.r0]) border.r = Object.assign({}, LINE);
      for (let tc = tc0; tc <= tc1; tc++) {
        for (let tr = tr0; tr <= tr1; tr++) cellStyles[tc + ',' + tr] = { border };
      }
    }
    tables.push({
      y: g.rowY[r0], c0, c1, r0, r1,
      block: Object.assign({ type: 'table', rows: grid },
        merges.length ? { merges } : {},
        { cellStyles })
    });
  }

  /* Everything not in a table, as lines, then paragraphs. */
  const inTable = (c, r) => tables.some((t) => c >= t.c0 && c <= t.c1 && r >= t.r0 && r <= t.r1);
  const loose = [];
  for (const key of Object.keys(g.cells)) {
    const cell = g.cells[key];
    if (inTable(cell.c, cell.r)) continue;
    for (const line of cell.lines) loose.push(Object.assign({ row: cell.r }, line));
  }
  loose.sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const body = bodySize(loose);
  /* The median gap, but never more than two lines' worth: a page with three
     loose lines and a table between two of them has a median gap the height
     of the table, and 1.45 times that joins everything into one paragraph. */
  const pitch = Math.min(linePitch(loose), body * 2);
  const tableBetween = (a, b) => tables.some((t) => t.r0 > a.row && t.r1 < b.row);
  const left = loose.length ? Math.min(...loose.map((l) => l.x)) : 0;
  const rightEdge = loose.length ? Math.max(...loose.map((l) => l.x1)) : 0;
  const centre = (left + rightEdge) / 2;

  const paras = [];
  let cur = null;
  for (const line of loose) {
    const isHead = line.h >= body * 1.15 && line.text.length <= 120;
    const marker = listMarker(line.text);
    const gap = cur ? line.y - cur.lastY : 0;
    const breaks = !cur || isHead || cur.head || marker || cur.marker ||
      gap > pitch * 1.45 || Math.abs(line.h - cur.h) > 1 || tableBetween(cur.last, line);
    if (breaks) {
      cur = { lines: [line], h: line.h, head: isHead, marker, lastY: line.y, last: line, x: line.x, x1: line.x1, y: line.y };
      paras.push(cur);
    } else {
      cur.lines.push(line);
      cur.lastY = line.y;
      cur.last = line;
      cur.x = Math.min(cur.x, line.x);
      cur.x1 = Math.max(cur.x1, line.x1);
    }
  }

  const items = paras.map((p) => {
    const text = p.lines.map((l) => l.text).join(CJK.test(p.lines[0].text.slice(-1)) ? '' : ' ')
      .replace(/\s+/g, ' ').trim();
    let block;
    if (p.head) {
      const ratio = p.h / body;
      block = { type: 'heading', level: ratio >= 1.9 ? 1 : ratio >= 1.5 ? 2 : 3, text };
    } else if (p.marker) {
      block = { type: 'list', ordered: p.marker === 'ordered', text: text.replace(LIST_RE, '') };
    } else {
      block = { type: 'para', text };
    }
    if (p.lines.length === 1 && !p.marker) {
      const w = rightEdge - left;
      const mid = (p.x + p.x1) / 2;
      if (p.x - left > 20 && Math.abs(mid - centre) <= Math.max(6, w * 0.04)) block.align = 'center';
      else if (p.x - left > 20 && rightEdge - p.x1 <= 3) block.align = 'right';
    }
    return { y: p.y, block };
  });
  for (const t of tables) items.push({ y: t.y, block: t.block });
  items.sort((a, b) => a.y - b.y);

  return { blocks: items.map((i) => i.block), tables: tables.length };
}

const LIST_RE = /^(?:[-*•●■▪–·⁃◦∙‣•]|\(?\d{1,3}[.)、]|[①-⑳]|[-])\s*/;

function listMarker(text) {
  const m = LIST_RE.exec(text);
  if (!m) return '';
  return /^\(?\d/.test(m[0]) ? 'ordered' : 'bullet';
}

function bodySize(lines) {
  const weight = {};
  for (const l of lines) {
    const k = Math.round(l.h * 2) / 2;
    weight[k] = (weight[k] || 0) + l.text.length;
  }
  let best = 0, at = 10;
  for (const k of Object.keys(weight)) if (weight[k] > best) { best = weight[k]; at = Number(k); }
  return at || 10;
}

function linePitch(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i].y - lines[i - 1].y;
    if (d > 0.5) gaps.push(d);
  }
  if (!gaps.length) return 14;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/* -------------------------------------------------------------- from OCR -- */

/**
 * Markdown, as the model transcribes a scanned page, into document blocks.
 * Headings, pipe tables, lists, quotes and paragraphs; a page marker becomes a
 * page break; pictures and rules are dropped.
 */
export function mdToBlocks(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let table = null;
  const flush = () => {
    if (para.length) {
      blocks.push({ type: 'para', text: joinMdLines(para) });
      para = [];
    }
    if (table) {
      const width = Math.max(...table.map((r) => r.length));
      const rows = table.map((r) => r.concat(new Array(width - r.length).fill('')));
      const cellStyles = {};
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < width; c++) cellStyles[c + ',' + r] = { border: allEdges(THIN) };
      }
      blocks.push({ type: 'table', rows, cellStyles });
      table = null;
    }
  };
  for (const raw of lines) {
    /* Two trailing spaces are Markdown's hard line break, and the model uses
       them for what the page had on separate lines -- an invoice's number,
       buyer and seller. Each such line is its own paragraph, so it lands in a
       row of its own rather than being run together with the next. */
    const hardBreak = /( {2,}|\\)$/.test(raw.replace(/[\r\n]+$/, ''));
    const line = raw.replace(/\\$/, '').replace(/\s+$/, '');
    const t = line.trim();
    const page = /^<!--\s*第\s*(\d+)\s*頁\s*-->$/.exec(t);
    if (page) {
      flush();
      if (blocks.length) blocks.push({ type: 'break' });
      continue;
    }
    if (!t) { flush(); continue; }
    if (/^```/.test(t)) continue;
    if (/^!\[/.test(t) || /^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); continue; }
    if (/^\|/.test(t) || (/\|/.test(t) && table)) {
      if (para.length) { const keep = table; table = null; flush(); table = keep; }
      if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t)) continue;
      const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => unmark(c.trim()));
      if (!table) table = [];
      table.push(cells);
      continue;
    }
    if (table) flush();
    const head = /^(#{1,6})\s+(.*)$/.exec(t);
    if (head) { flush(); blocks.push({ type: 'heading', level: head[1].length, text: unmark(head[2]) }); continue; }
    const item = /^(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/.exec(t);
    if (item) { flush(); blocks.push({ type: 'list', ordered: /^\d/.test(t), text: unmark(item[1]) }); continue; }
    const quote = /^>\s?(.*)$/.exec(t);
    if (quote) { flush(); blocks.push({ type: 'quote', text: unmark(quote[1]) }); continue; }
    para.push(unmark(t));
    if (hardBreak) flush();
  }
  flush();
  return blocks;
}

function joinMdLines(lines) {
  let out = '';
  for (const l of lines) {
    if (!out) { out = l; continue; }
    out += (CJK.test(out.slice(-1)) && CJK.test(l.slice(0, 1)) ? '' : ' ') + l;
  }
  return out;
}

/** Inline emphasis off, so a cell holds the words and not the asterisks. */
function unmark(s) {
  return String(s || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1')
    .trim();
}

/**
 * Blocks onto a plain grid: every table row is a sheet row with borders, and
 * any other block is one row with its text across the table's width.
 */
export function sheetFromBlocks(blocks, name) {
  const cells = {};
  const merges = [];
  const colWidths = {};
  let row = 0;
  let width = 1;
  for (const b of blocks) if (b.type === 'table') width = Math.max(width, ...(b.rows || []).map((r) => r.length));
  const widest = new Array(width).fill(0);
  for (const b of blocks || []) {
    if (!b || b.type === 'break') continue;
    if (b.type === 'table') {
      for (const r of b.rows || []) {
        for (let c = 0; c < width; c++) {
          const v = c < r.length ? r[c] : '';
          cells[colName(c) + (row + 1)] = { v, border: allEdges(THIN) };
          widest[c] = Math.max(widest[c], textWidth(v));
        }
        row++;
      }
      continue;
    }
    const text = b.type === 'list' ? (b.ordered ? '1. ' : '• ') + (b.text || '') : String(b.text || '');
    if (!text) continue;
    const cell = { v: text };
    if (b.type === 'heading') { cell.bold = true; cell.size = b.level <= 1 ? 16 : b.level === 2 ? 14 : 12; }
    cells[colName(0) + (row + 1)] = cell;
    if (width > 1) merges.push({ c0: 0, r0: row, c1: width - 1, r1: row });
    if (width === 1) widest[0] = Math.max(widest[0], textWidth(text));
    row++;
  }
  for (let c = 0; c < width; c++) colWidths[c] = Math.round(Math.min(360, Math.max(64, widest[c] * 7.5 + 16)));
  return { name: name || '工作表1', cells, colWidths, rowHeights: {}, merges, freeze: { rows: 0, cols: 0 } };
}

function textWidth(s) {
  let n = 0;
  for (const ch of String(s || '')) n += CJK.test(ch) ? 2 : 1;
  return n;
}

/* ----------------------------------------------------------------- summary -- */

void EDGES;

/** How many cells and merged boxes a sheet came out with, for the receipt. */
export function summarise(sheet) {
  const cells = Object.keys(sheet.cells || {}).filter((k) => sheet.cells[k] && String(sheet.cells[k].v || '').trim() !== '').length;
  const bordered = Object.keys(sheet.cells || {}).filter((k) => sheet.cells[k] && sheet.cells[k].border).length;
  return { cells, bordered, merges: (sheet.merges || []).length };
}
