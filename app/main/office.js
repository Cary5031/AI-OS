'use strict';

/* ===========================================================================
   AI-OS // office formats
   ---------------------------------------------------------------------------
   Real .docx and .xlsx round-trips, built on zip.js.

   Scope, stated plainly rather than discovered later: this reads and writes the
   parts of OOXML that carry meaning for a text document and a grid of values --
   paragraphs, headings, bold/italic runs, lists, tables, cell values, formulas,
   sheet names, and charts (the one kind of drawing it carries, as DrawingML
   chart parts built in chartxml.js). It does not preserve the untouched
   remainder of a file byte-for-byte the way Word does, and it does not attempt
   themes, numbering definitions, pictures in documents, pivot tables or
   conditional formatting.

   That means a document authored here opens correctly in Word, and a document
   authored in Word opens here with its text and structure intact, but a
   Word file with heavy formatting will lose that formatting if it is saved from
   here. The UI says so before overwriting anything.

   The native format for full fidelity is .aiosdoc / .aiossheet / .aiosdeck,
   which are just JSON and lose nothing.
   =========================================================================== */

const zip = require('./zip');
const chartxml = require('./chartxml');
/* The chart model is the renderer's, loaded here for the pure half (a chart's
   data as a table and back) so the .md bridge reads a chart the way the editors
   build one. */
const charts = require('../renderer/charts.js');

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function unesc(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
}

/* ###########################################################################
   docx
   ######################################################################### */

/**
 * Read a .docx into a block list. Runs keep bold/italic because those survive
 * a round trip; everything else is deliberately flattened rather than kept in a
 * half-understood state.
 */
function readDocx(buffer) {
  const files = zip.read(buffer);
  const docXml = files.get('word/document.xml');
  if (!docXml) throw new Error('這不是 .docx（找不到 word/document.xml）');
  const xml = docXml.toString('utf8');

  const blocks = [];

  // Tables first, so their paragraphs are not also emitted as loose text.
  const consumed = [];
  const tableRe = /<w:tbl>([\s\S]*?)<\/w:tbl>/g;
  let tm;
  while ((tm = tableRe.exec(xml))) {
    consumed.push([tm.index, tm.index + tm[0].length]);
    /* Rebuilding the grid from Word's asymmetric description. A gridSpan means
       cells are missing from this row, so the column index has to be advanced by
       the span rather than by one; a vMerge continuation is a cell that is present
       but belongs to a region that started higher up. Both are turned back into
       rectangles, and the grid is filled out to full width so every row has a cell
       for every column -- which is what the editor and the merge algebra assume. */
    const rows = [];
    const merges = [];
    const cellStyles = {};
    const open = {};                  // column -> the region still descending
    const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
    let rm;
    while ((rm = rowRe.exec(tm[1]))) {
      const r = rows.length;
      const cells = [];
      const cellRe = /<w:tc>([\s\S]*?)<\/w:tc>/g;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        const inner = cm[1];
        const pr = (inner.match(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/) || [])[1] || '';

        /* The cell's own borders and shading, keyed the way the app keys them.
           Read before the merge bookkeeping runs, because that is what decides
           which column index this cell sits at. */
        const style = {};
        const cellBorder = readTcBorders(pr);
        if (cellBorder) style.border = cellBorder;
        const shade = (pr.match(/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/) || [])[1];
        if (shade && shade.toLowerCase() !== 'auto') style.bg = shade.toUpperCase();
        const span = Number((pr.match(/<w:gridSpan\s+w:val="(\d+)"/) || [])[1] || 1);
        const vRaw = pr.match(/<w:vMerge(\s[^>]*)?\/?>/);
        const restart = vRaw && /w:val="restart"/.test(vRaw[0]);
        const continues = vRaw && !restart;

        const c = cells.length;
        if (Object.keys(style).length) cellStyles[c + ',' + r] = style;
        if (continues) {
          // Part of a region from an earlier row: extend it, contribute no text.
          const m = open[c];
          if (m) m.r1 = r;
          cells.push('');
        } else {
          cells.push(plainText(inner));
          if (span > 1 || restart) {
            const m = { c0: c, c1: c + span - 1, r0: r, r1: r };
            merges.push(m);
            if (restart) open[c] = m; else delete open[c];
          } else {
            delete open[c];
          }
        }
        // The columns a gridSpan swallowed exist in the grid even though the file
        // does not mention them.
        for (let k = 1; k < span; k++) cells.push('');
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) {
      const wide = rows.reduce((n, row) => Math.max(n, row.length), 0);
      rows.forEach((row) => { while (row.length < wide) row.push(''); });
      const real = merges.filter((m) => m.c1 > m.c0 || m.r1 > m.r0);
      blocks.push(Object.assign({ at: tm.index, type: 'table', rows },
        real.length ? { merges: real } : {},
        Object.keys(cellStyles).length ? { cellStyles } : {}));
    }
  }

  /* Relationships, for the parts a paragraph points at. The running head and
     foot are found by their fixed names further down; a chart's part is
     whatever its id says it is. */
  const docRelMap = {};
  const docRelsXml = files.get('word/_rels/document.xml.rels');
  if (docRelsXml) {
    const rels = docRelsXml.toString('utf8');
    const rRe = /<Relationship\b[^>]*\/?>/g;
    let rm;
    while ((rm = rRe.exec(rels))) {
      const id = /\bId="([^"]+)"/.exec(rm[0]);
      const target = /\bTarget="([^"]+)"/.exec(rm[0]);
      if (id && target) docRelMap[id[1]] = target[1].replace(/^\/?word\//, '').replace(/^\//, '');
    }
  }

  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let pm;
  while ((pm = paraRe.exec(xml))) {
    if (consumed.some(([a, b]) => pm.index >= a && pm.index < b)) continue;
    const inner = pm[1];
    const style = (inner.match(/<w:pStyle\s+w:val="([^"]+)"/) || [])[1] || '';

    /* A chart is a drawing whose graphic data is a chart part. Read before the
       runs are, or the paragraph would come back as an empty one. */
    const drawn = /<w:drawing\b/.test(inner) ? /<c:chart\b[^>]*\br:id="(rId\d+)"/.exec(inner) : null;
    if (drawn) {
      const target = docRelMap[drawn[1]];
      const part = target ? files.get('word/' + target) : null;
      const read = part ? chartxml.readChartSpace(part.toString('utf8')) : null;
      if (read) {
        const ext = /<wp:extent\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(inner);
        const aspect = ext && Number(ext[2]) > 0 ? Number(ext[1]) / Number(ext[2]) : 1.8;
        blocks.push({
          at: pm.index, type: 'chart', chart: read.spec,
          aspect: Math.round(Math.max(1.2, Math.min(4, aspect)) * 100) / 100, ...readParaProps(inner)
        });
        continue;
      }
    }

    /* A page break is a run holding nothing but the break. Checked before the
       runs are read, because readRuns turns a <w:br> into a newline and the
       paragraph would come back as an empty one. */
    if (/<w:br\b[^>]*w:type="page"/.test(inner) && !/<w:t[\s>]/.test(inner)) {
      blocks.push({ at: pm.index, type: 'break' });
      continue;
    }

    const runs = readRuns(inner);
    const text = runs.map((r) => r.text).join('');
    const numbered = /<w:numPr>/.test(inner);
    const para = readParaProps(inner);

    if (/^Heading(\d)$/i.test(style)) {
      blocks.push({ at: pm.index, type: 'heading', level: Number(style.replace(/\D/g, '')) || 1, text, ...para });
    } else if (numbered) {
      blocks.push({ at: pm.index, type: 'list', ordered: /w:numId\s+w:val="[2-9]/.test(inner), text, ...para });
    } else if (/^(Quote|IntenseQuote)$/i.test(style)) {
      blocks.push({ at: pm.index, type: 'quote', text, ...para });
    } else {
      blocks.push({ at: pm.index, type: 'para', runs, text, ...para });
    }
  }

  blocks.sort((a, b) => a.at - b.at);

  /* The running head and foot, if the section names any. Read from the parts
     rather than reconstructed, and flattened to text: this reader keeps the
     header a person can retype, not Word's field codes. */
  const meta = {};
  const first = files.get('word/header1.xml');
  const foot = files.get('word/footer1.xml');
  if (first) meta.header = plainText(first.toString('utf8'));
  if (foot) {
    const raw = foot.toString('utf8');
    meta.footer = plainText(raw);
    // A PAGE field is how Word writes a page number; its rendered value is not
    // in the file, so its presence is the whole signal.
    if (/w:instr="[^"]*\bPAGE\b/.test(raw) || /<w:fldChar/.test(raw)) meta.pageNumbers = true;
  }

  return { blocks: blocks.map(({ at, ...rest }) => rest), format: 'docx', ...meta };
}

/**
 * Paragraph geometry, in the units this app uses.
 *
 * OOXML measures indents and spacing in twips (a twentieth of a point) and line
 * height in 240ths of a line. Converting on the way in means the rest of the
 * program never sees a twip.
 */
function readParaProps(inner) {
  const pr = (inner.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || '';
  if (!pr) return {};
  const out = {};

  const jc = (pr.match(/<w:jc\s+w:val="([^"]+)"/) || [])[1];
  if (jc === 'center' || jc === 'right' || jc === 'both') {
    out.align = jc === 'both' ? 'justify' : jc;
  }

  const left = Number((pr.match(/<w:ind\b[^>]*w:left="(-?\d+)"/) || [])[1] ||
                      (pr.match(/<w:ind\b[^>]*w:start="(-?\d+)"/) || [])[1] || 0);
  // One level is 720 twips, the half inch Word's indent button uses.
  if (left >= 720) out.indent = Math.min(8, Math.round(left / 720));

  const sp = pr.match(/<w:spacing\b[^>]*>/);
  if (sp) {
    const before = Number((sp[0].match(/w:before="(\d+)"/) || [])[1] || 0);
    const after = Number((sp[0].match(/w:after="(\d+)"/) || [])[1] || 0);
    const line = Number((sp[0].match(/w:line="(\d+)"/) || [])[1] || 0);
    const rule = (sp[0].match(/w:lineRule="([^"]+)"/) || [])[1] || '';
    if (before > 0) out.spaceBefore = Math.round(before / 20);
    if (after > 0) out.spaceAfter = Math.round(after / 20);
    // "auto" means a multiple of the line height, 240 being single spacing.
    if (line > 0 && rule === 'auto') {
      const mult = Math.round((line / 240) * 100) / 100;
      if (mult !== 1) out.lineHeight = mult;
    }
  }
  return out;
}

/* Word's highlighter pen names its colours instead of giving hex. These are the
   values Word writes, so a highlighted document read here keeps its highlight
   instead of losing it silently. */
const HIGHLIGHTS = {
  yellow: 'FFFF00', green: '00FF00', cyan: '00FFFF', magenta: 'FF00FF',
  blue: '0000FF', red: 'FF0000', darkBlue: '000080', darkCyan: '008080',
  darkGreen: '008000', darkMagenta: '800080', darkRed: '800000',
  darkYellow: '808000', darkGray: '808080', lightGray: 'C0C0C0', black: '000000'
};

/**
 * Is a toggle property on?
 *
 * OOXML toggles are present-means-on, except that `w:val="0"` or `"false"` means
 * explicitly off -- which is how Word switches bold back off inside a style that
 * turns it on. Reading presence alone gets those backwards.
 */
function toggleOn(rpr, tag) {
  const m = rpr.match(new RegExp('<w:' + tag + '\\b([^>]*)>'));
  if (!m) return false;
  return !/w:val="(0|false|none)"/.test(m[1]);
}

function readRuns(inner) {
  const runs = [];
  const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  let m;
  while ((m = runRe.exec(inner))) {
    const rpr = (m[1].match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || '';
    const bold = toggleOn(rpr, 'b');
    const italic = toggleOn(rpr, 'i');
    const strike = toggleOn(rpr, 'strike') || toggleOn(rpr, 'dstrike');
    // w:u carries the line style in w:val, so "none" is off and anything else on.
    const under = toggleOn(rpr, 'u');
    const vert = (rpr.match(/<w:vertAlign\s+w:val="([^"]+)"/) || [])[1] || '';
    /* Word has no inline-code character format, so the convention in both
       directions is a named character style. Deliberately not sniffing for a
       monospace w:rFonts as well: someone who chose Consolas on purpose would
       then get their typeface turned into a code format and lose the name. */
    const code = /<w:rStyle\s+w:val="(HTMLCode|Code|VerbatimChar)"/i.test(rpr);
    const colour = (rpr.match(/<w:color\s+w:val="([0-9A-Fa-f]{6})"/) || [])[1] || null;
    /* Two ways to mark text. w:shd is shading with an exact colour, which is what
       this writer emits; w:highlight is the highlighter pen, which names one of
       sixteen colours -- read as well, because that is what a Word user's file has. */
    const mark = (rpr.match(/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/) || [])[1] ||
                 HIGHLIGHTS[(rpr.match(/<w:highlight\s+w:val="([a-zA-Z]+)"/) || [])[1]] || null;

    // eastAsia before ascii: a Word document written by someone typing Chinese
    // usually names the real typeface there and leaves ascii as a Latin
    // fallback, so preferring ascii would report the wrong font.
    const rf = rpr.match(/<w:rFonts\b[^>]*>/);
    let font = null;
    if (rf) {
      font = (rf[0].match(/w:eastAsia="([^"]+)"/) || [])[1] ||
             (rf[0].match(/w:ascii="([^"]+)"/) || [])[1] ||
             (rf[0].match(/w:hAnsi="([^"]+)"/) || [])[1] || null;
    }
    const szHalf = Number((rpr.match(/<w:sz\s+w:val="(\d+)"/) || [])[1]);
    const size = Number.isFinite(szHalf) && szHalf > 0 ? szHalf / 2 : null;

    let text = '';
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) text += unesc(t[1]);
    if (/<w:tab\b/.test(m[1])) text += '\t';
    if (/<w:br\b/.test(m[1])) text += '\n';
    if (text) {
      const r = { text, bold, italic };
      if (under) r.under = true;
      if (strike) r.strike = true;
      if (vert === 'superscript') r.sup = true;
      if (vert === 'subscript') r.sub = true;
      if (code) r.code = true;
      // "auto" is Word's way of saying "whatever the theme says", which is what a
      // run with no colour already means here.
      if (colour && colour.toLowerCase() !== 'auto') r.colour = colour.toUpperCase();
      if (mark && mark.toLowerCase() !== 'auto') r.mark = mark.toUpperCase();
      if (font) r.font = font;
      if (size) r.size = size;
      runs.push(r);
    }
  }
  return runs;
}

function plainText(fragment) {
  let out = '';
  const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = tRe.exec(fragment))) out += unesc(m[1]);
  return out.trim();
}

/* ---------------------------------------------------------------- fonts ---

   Typeface names are written into three OOXML attributes because Word picks a
   different one depending on the script of each character: w:ascii for Latin,
   w:eastAsia for CJK, w:cs for complex scripts. Setting only w:ascii is the
   classic bug where a document looks right in the editor and reverts to the
   default the moment it contains Chinese.

   Sizes are half-points in OOXML, so 12 pt is w:sz 24.
   -------------------------------------------------------------------------- */

function fontXml(family) {
  if (!family) return '';
  const f = esc(String(family).slice(0, 64));
  return `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`;
}

function sizeXml(pt) {
  const n = Number(pt);
  if (!Number.isFinite(n) || n <= 0) return '';
  const half = Math.round(Math.max(4, Math.min(200, n)) * 2);
  return `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`;
}

/**
 * Build a .docx that Word opens without complaint.
 *
 * `meta.font` / `meta.size` become the document default, applied through the
 * Normal style rather than stamped onto every run, so a reader that overrides
 * styles still behaves sensibly. Per-block and per-run values override it.
 */
function writeDocx(blocks, meta = {}) {
  const docFont = meta.font || null;
  const docSize = meta.size || null;
  const header = String(meta.header || '').trim();
  const footer = String(meta.footer || '').trim();
  const pageNumbers = !!meta.pageNumbers;

  /**
   * The paragraph's own geometry, in OOXML units.
   *
   * Emitted only for values the block actually states, so a paragraph that says
   * nothing inherits the style -- writing `w:jc w:val="left"` everywhere would
   * override a style that centres, which is the sort of thing that makes an
   * exported document impossible to restyle.
   */
  function paraXml(b, styleXml) {
    let pr = styleXml || '';
    if (b.align) pr += `<w:jc w:val="${b.align === 'justify' ? 'both' : b.align}"/>`;
    if (b.indent) pr += `<w:ind w:left="${b.indent * 720}"/>`;
    const before = Number(b.spaceBefore) > 0 ? Math.round(b.spaceBefore * 20) : null;
    const after = Number(b.spaceAfter) > 0 ? Math.round(b.spaceAfter * 20) : null;
    const line = Number(b.lineHeight) > 0 ? Math.round(b.lineHeight * 240) : null;
    if (before || after || line) {
      pr += '<w:spacing' +
        (before ? ` w:before="${before}"` : '') +
        (after ? ` w:after="${after}"` : '') +
        (line ? ` w:line="${line}" w:lineRule="auto"` : '') + '/>';
    }
    return pr ? `<w:pPr>${pr}</w:pPr>` : '';
  }

  /* Charts are the one drawing this writer carries. Each becomes its own part
     under word/charts/, referenced from an inline drawing in the body. Their
     relationship ids follow the four fixed ones (styles, numbering, header,
     footer) so those stay where the reader expects them. */
  const chartParts = [];
  const TEXT_WIDTH_EMU = (11906 - 1440 - 1440) * 635;   // the page's text width

  const body = (blocks || []).map((b) => {
    // A block's own font applies to every run in it unless the run overrides.
    const base = { font: b.font || null, size: b.size || null };

    if (b.type === 'chart') {
      const spec = b.chart && typeof b.chart === 'object' ? b.chart : {};
      const n = chartParts.length + 1;
      const rid = 'rId' + (4 + n);
      chartParts.push({
        name: `charts/chart${n}.xml`, rid,
        xml: chartxml.chartSpaceXml(spec, { font: docFont, size: docSize ? Math.max(6, docSize - 1) : 10 })
      });
      // The drawing spans the text width; the block's aspect ratio sets its height.
      const aspect = Math.max(1.2, Math.min(4, Number(b.aspect) || 1.8));
      const cx = TEXT_WIDTH_EMU;
      const cy = Math.round(cx / aspect);
      const title = spec.title ? String(spec.title) : `圖表 ${n}`;
      return `<w:p>${paraXml(b, '')}<w:r><w:drawing>` +
        '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">' +
        `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
        `<wp:docPr id="${1000 + n}" name="${esc(title)}"/><wp:cNvGraphicFramePr/>` +
        `<a:graphic xmlns:a="${chartxml.NS_A}"><a:graphicData uri="${chartxml.CHART_GRAPHIC_URI}">` +
        chartxml.chartRefXml(rid) + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    }

    if (b.type === 'break') {
      // A paragraph holding nothing but the break, which is how Word writes one.
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    }
    if (b.type === 'heading') {
      const lvl = Math.min(6, Math.max(1, b.level || 1));
      return `<w:p>${paraXml(b, `<w:pStyle w:val="Heading${lvl}"/>`)}${runs(b, base)}</w:p>`;
    }
    if (b.type === 'list') {
      const style = '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/>' +
                    `<w:numId w:val="${b.ordered ? 2 : 1}"/></w:numPr>`;
      return `<w:p>${paraXml(b, style)}${runs(b, base)}</w:p>`;
    }
    if (b.type === 'quote') {
      return `<w:p>${paraXml(b, '<w:pStyle w:val="Quote"/>')}${runs(b, base)}</w:p>`;
    }
    if (b.type === 'table') {
      /* Merged cells. Word expresses the two axes differently and it is not
         symmetric: a horizontal merge absorbs the cells to its right, which are
         then simply absent, while a vertical merge needs a cell present in every
         row it spans -- the first marked `restart` and the rest marked to
         continue. Emitting nothing for the continuation rows loses the merge and
         shortens the table. */
      const merges = Array.isArray(b.merges) ? b.merges : [];
      const spanAt = (c, r) => merges.find((m) => m.c0 === c && m.r0 <= r && m.r1 >= r &&
        (m.c1 > m.c0 || m.r1 > m.r0));
      const swallowed = (c, r) => merges.some((m) =>
        c > m.c0 && c <= m.c1 && r >= m.r0 && r <= m.r1);

      const styles = b.cellStyles || {};
      const styleAt = (c, r) => styles[c + ',' + r] || {};

      const rows = (b.rows || []).map((cells, r) =>
        '<w:tr>' + cells.map((c, ci) => {
          if (swallowed(ci, r)) return '';           // absorbed by a gridSpan
          const m = spanAt(ci, r);
          let pr = '<w:tcW w:w="0" w:type="auto"/>';
          let text = c;
          if (m) {
            if (m.c1 > m.c0) pr += `<w:gridSpan w:val="${m.c1 - m.c0 + 1}"/>`;
            if (m.r1 > m.r0) {
              pr += r === m.r0 ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>';
              // A continuation cell carries no text of its own.
              if (r !== m.r0) text = '';
            }
          }
          /* The cell's own borders and shading. Per cell rather than per table,
             because that is where the model keeps them and because a table border
             set on the table applies to its outside only. */
          const st = styleAt(ci, r);
          pr += tcBordersXml(st.border);
          if (hex6(st.bg)) pr += `<w:shd w:val="clear" w:color="auto" w:fill="${hex6(st.bg)}"/>`;
          // The cell's paragraph carries the table block's alignment, so a
          // centred table is centred inside its cells too.
          const cellPr = b.align ? `<w:pPr><w:jc w:val="${b.align === 'justify' ? 'both' : b.align}"/></w:pPr>` : '';
          return `<w:tc><w:tcPr>${pr}</w:tcPr><w:p>${cellPr}${run(text, base)}</w:p></w:tc>`;
        }).join('') + '</w:tr>').join('');

      /* The table's own frame is written only when no cell states its own. A
         document whose cells carry borders and which also has a table border ends
         up with both, and the one it did not ask for is the one on top. */
      const anyCellBorder = Object.keys(styles).some((k) => styles[k] && styles[k].border);
      const tblBorders = anyCellBorder ? '' :
        '<w:tblBorders>' +
        ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
          .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('') +
        '</w:tblBorders>';

      return '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>' +
             '<w:tblW w:w="0" w:type="auto"/>' +
             (b.align === 'center' ? '<w:jc w:val="center"/>' :
              b.align === 'right' ? '<w:jc w:val="right"/>' : '') +
             tblBorders + '</w:tblPr>' + rows + '</w:tbl>';
    }
    return `<w:p>${paraXml(b, '')}${runs(b, base)}</w:p>`;
  }).join('');

  /** Every run format, falling back to the block's typeface. */
  function runs(b, base) {
    if (Array.isArray(b.runs) && b.runs.length) {
      return b.runs.map((r) => run(r.text, {
        bold: r.bold, italic: r.italic, under: r.under, strike: r.strike,
        sup: r.sup, sub: r.sub, code: r.code, colour: r.colour, mark: r.mark,
        font: r.font || base.font,
        size: r.size || base.size
      })).join('');
    }
    return run(b.text || '', base);
  }

  function run(text, fmt) {
    const f = fmt || {};
    /* Inline code as a named character style plus an explicit monospace face.
       The style alone is what a reader identifies it by; the face is what makes
       it look right in a Word that has never heard of the style. */
    const mono = f.code ? '<w:rStyle w:val="HTMLCode"/>' + fontXml('Consolas') : '';
    const inner =
      mono +
      (f.code ? '' : fontXml(f.font)) +
      (f.bold ? '<w:b/>' : '') +
      (f.italic ? '<w:i/>' : '') +
      (f.under ? '<w:u w:val="single"/>' : '') +
      (f.strike ? '<w:strike/>' : '') +
      (f.sup ? '<w:vertAlign w:val="superscript"/>'
             : f.sub ? '<w:vertAlign w:val="subscript"/>' : '') +
      (f.colour ? `<w:color w:val="${hex6(f.colour)}"/>` : '') +
      // Shading rather than the highlighter pen: w:highlight can only name one of
      // sixteen colours, and the palette here is not a subset of them.
      (f.mark ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex6(f.mark)}"/>` : '') +
      sizeXml(f.size);
    const props = inner ? `<w:rPr>${inner}</w:rPr>` : '';
    // xml:space="preserve" or Word eats leading and trailing spaces.
    return `<w:r>${props}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
  }

  /* ------------------------------------------------ the running head and foot

     Separate parts, referenced from the section. They cannot live in the body:
     the header repeats on every page and nothing in the body knows where the
     page boundaries fall. The page number is a field -- Word computes its value
     when it lays the document out, so the file holds the instruction rather than
     a number.
     -------------------------------------------------------------------------- */

  const wantHf = !!(header || footer || pageNumbers);

  const hfPara = (text, withNumber) => {
    let inner = text ? run(text, { size: docSize ? Math.max(6, docSize - 2) : 9 }) : '';
    if (withNumber) {
      if (text) inner += run('　·　', { size: docSize ? Math.max(6, docSize - 2) : 9 });
      inner += '<w:r><w:t xml:space="preserve">第 </w:t></w:r>' +
               '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>' +
               '<w:r><w:t xml:space="preserve"> / </w:t></w:r>' +
               '<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple>' +
               '<w:r><w:t xml:space="preserve"> 頁</w:t></w:r>';
    }
    return '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' + inner + '</w:p>';
  };

  const headerXml = XML_DECL +
    '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    hfPara(header, false) + '</w:hdr>';
  const footerXml = XML_DECL +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    hfPara(footer, pageNumbers) + '</w:ftr>';

  const sectRefs = wantHf
    ? '<w:headerReference w:type="default" r:id="rId3"/>' +
      '<w:footerReference w:type="default" r:id="rId4"/>'
    : '';

  const document = XML_DECL +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}<w:sectPr>${sectRefs}<w:pgSz w:w="11906" w:h="16838"/>` +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"' +
    ' w:header="720" w:footer="720"/></w:sectPr></w:body></w:document>';

  const contentTypes = XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    (wantHf
      ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
        '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
      : '') +
    chartParts.map((c) =>
      `<Override PartName="/word/${c.name}" ContentType="${chartxml.CHART_CONTENT_TYPE}"/>`).join('') +
    '</Types>';

  const rels = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const docRels = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    (wantHf
      ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
        '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
      : '') +
    chartParts.map((c) =>
      `<Relationship Id="${c.rid}" Type="${chartxml.CHART_REL_TYPE}" Target="${c.name}"/>`).join('') +
    '</Relationships>';

  // Headings inherit the document typeface but keep their own size. Naming the
  // font here as well as in Normal matters: Word resolves a style's rPr without
  // falling back to Normal for attributes the style itself mentions.
  const headingStyles = [1, 2, 3, 4, 5, 6].map((n) => {
    const sz = docSize ? Math.round(docSize * 2 * (1 + (6 - n) * 0.12)) : (36 - n * 3);
    return `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>` +
      '<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="' + (n - 1) + '"/>' +
      `<w:spacing w:before="${240 - n * 20}" w:after="120"/></w:pPr>` +
      `<w:rPr>${fontXml(docFont)}<w:b/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`;
  }).join('');

  // The document default. w:docDefaults is what Word consults for anything the
  // Normal style does not state, so setting both is what makes an empty
  // paragraph and a styled heading agree on the typeface.
  const defaultRpr = fontXml(docFont) + (sizeXml(docSize) || '<w:sz w:val="22"/><w:szCs w:val="22"/>');
  const docDefaults =
    '<w:docDefaults><w:rPrDefault><w:rPr>' + defaultRpr + '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault/></w:docDefaults>';

  const styles = XML_DECL +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    docDefaults +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>' +
    '<w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr>' +
    `<w:rPr>${defaultRpr}</w:rPr></w:style>` +
    headingStyles +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>' +
    '<w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>' +
    // The character style inline code is identified by, in both directions.
    '<w:style w:type="character" w:styleId="HTMLCode"><w:name w:val="HTML Code"/>' +
    '<w:rPr>' + fontXml('Consolas') + '</w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>' +
    '</w:styles>';

  const numbering = XML_DECL +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/>' +
    '<w:lvlText w:val="\u2022"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>' +
    '<w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>';

  const parts = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rels,
    'word/document.xml': document,
    'word/_rels/document.xml.rels': docRels,
    'word/styles.xml': styles,
    'word/numbering.xml': numbering
  };
  if (wantHf) {
    parts['word/header1.xml'] = headerXml;
    parts['word/footer1.xml'] = footerXml;
  }
  chartParts.forEach((c) => { parts['word/' + c.name] = c.xml; });
  return zip.write(parts, { store: ['[Content_Types].xml'] });
}

/* ###########################################################################
   xlsx
   ######################################################################### */

function colToIndex(ref) {
  const letters = String(ref).replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/* Format codes that xlsx already has an id for. Using them means a reader does
   not need the definition to understand the cell, and it keeps the file smaller.
   Only the exact spellings are listed: `#,##0.00` is id 4, but `#,##0.000` is not
   a built-in and has to be written out. */
const BUILTIN_NUMFMT = new Map([
  ['0', 1], ['0.00', 2], ['#,##0', 3], ['#,##0.00', 4],
  ['0%', 9], ['0.00%', 10], ['0.00E+00', 11], ['@', 49]
]);
const NUMFMT_BY_ID = new Map([...BUILTIN_NUMFMT].map(([code, id]) => [id, code]));

/** `#1F4E79` or `1f4e79` -> `1F4E79`, and anything else -> null. */
function hex6(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim().replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(s) ? s : null;
}

/* ------------------------------------------------------------- borders ---

   A border is a set of edges, each one { style, width, colour } or absent. The
   renderer's AIOS.borders owns the vocabulary; this is the translation to and
   from the two file formats, and they are not the same kind of translation.

   docx measures line weight in eighths of a point, so every width the app offers
   is exact there. xlsx has no width at all -- it has a dozen named styles, each
   of which bakes in a weight -- so a spreadsheet border snaps to the nearest one
   Excel can express. That is a limit of the format, and the mapping below is
   written out so the snapping is visible rather than surprising.
   ------------------------------------------------------------------------ */

const EDGES = ['t', 'r', 'b', 'l'];
const EDGE_TAG = { t: 'top', r: 'right', b: 'bottom', l: 'left' };

/* Which xlsx style name carries which (app style, weight). Read in order, so the
   first entry that matches a style id wins for the width bands under it. */
const XLSX_BORDER = [
  { name: 'hair',         style: 'single',  width: 0.25 },
  { name: 'thin',         style: 'single',  width: 0.5 },
  { name: 'medium',       style: 'single',  width: 1.5 },
  { name: 'thick',        style: 'single',  width: 3 },
  { name: 'double',       style: 'double',  width: 0.5 },
  { name: 'dotted',       style: 'dotted',  width: 0.5 },
  { name: 'dashed',       style: 'dashed',  width: 0.5 },
  { name: 'mediumDashed', style: 'dashed',  width: 1.5 },
  { name: 'dashDot',      style: 'dashDot', width: 0.5 },
  { name: 'slantDashDot', style: 'dashDot', width: 1.5 }
];

/** One edge -> the xlsx style name that comes closest. */
function xlsxBorderName(edge) {
  const candidates = XLSX_BORDER.filter((b) => b.style === edge.style);
  if (!candidates.length) return 'thin';
  /* Nearest, and a tie goes to the lighter line: a border that came back thinner
     than asked is a smaller surprise than one that came back heavier, because the
     heavy one changes the look of the whole table. 1pt ties between thin and
     medium and becomes thin. */
  return candidates.reduce((best, b) =>
    Math.abs(b.width - edge.width) < Math.abs(best.width - edge.width) ? b : best).name;
}

function xlsxBorderEdge(name) {
  return XLSX_BORDER.find((b) => b.name === name) || null;
}

/** An edge, cleaned, or null. The same rules as the renderer's AIOS.borders. */
function normEdge(raw) {
  if (!raw) return null;
  const style = ['single', 'double', 'dashed', 'dotted', 'dashDot']
    .includes(raw.style) ? raw.style : 'single';
  const w = Number(raw.width);
  return {
    style,
    width: Number.isFinite(w) && w > 0 ? Math.min(12, Math.max(0.25, w)) : 0.5,
    colour: hex6(raw.colour) || '808080'
  };
}

/**
 * A border set, cleaned.
 *
 * The old letter form -- `tblr`, capitals for a medium weight -- is still read,
 * because files saved before a border had a style or a colour contain it.
 */
function normBorder(spec) {
  if (!spec) return null;
  const out = {};
  if (typeof spec === 'string') {
    EDGES.forEach((e) => {
      if (spec.includes(e.toUpperCase())) out[e] = normEdge({ style: 'single', width: 1.5, colour: '8A8A8A' });
      else if (spec.includes(e)) out[e] = normEdge({ style: 'single', width: 0.5, colour: '8A8A8A' });
    });
  } else {
    /* Three states per edge, and the difference matters in both formats: an edge
       that says nothing inherits the table's own border, an edge that says none
       overrides it. See the note on AIOS.borders.norm. */
    EDGES.forEach((e) => {
      if (!Object.prototype.hasOwnProperty.call(spec, e)) return;
      out[e] = normEdge(spec[e]);
    });
  }
  return Object.keys(out).length ? out : null;
}

/**
 * One spelling per border set, so interning works and so "did this survive being
 * saved" is a string comparison rather than an object walk that reports a
 * difference in key order as a difference in the border.
 */
function borderKey(spec) {
  const b = normBorder(spec);
  if (!b) return '';
  return EDGES.map((e) => {
    if (!Object.prototype.hasOwnProperty.call(b, e)) return e + ':-';
    return e + ':' + (b[e] ? `${b[e].style}:${b[e].width}:${b[e].colour}` : 'none');
  }).join('|');
}

/* docx measures line weight in eighths of a point, so every width the app offers
   is exact. Clamped to the range the schema allows -- Word rejects a w:sz outside
   it rather than clamping for you. */
const DOCX_STYLE = { single: 'single', double: 'double', dashed: 'dashed', dotted: 'dotted', dashDot: 'dashDotStroked' };
const DOCX_STYLE_BACK = {
  single: 'single', thick: 'single', wave: 'single',
  double: 'double', doubleWave: 'double', triple: 'double',
  dashed: 'dashed', dashSmallGap: 'dashed', dotDash: 'dashDot',
  dotted: 'dotted', dotDotDash: 'dashDot', dashDotStroked: 'dashDot'
};

function eighths(pt) {
  return Math.min(96, Math.max(2, Math.round(Number(pt) * 8)));
}

/**
 * `<w:tcBorders>` for one cell, or '' when it states nothing.
 *
 * An edge that states none is written as `w:val="nil"`, which is how a cell
 * overrides the table's own border. Leaving it out instead would let the table
 * border show and 無框線 would appear to do nothing.
 */
function tcBordersXml(spec) {
  const b = normBorder(spec);
  if (!b) return '';
  // The schema fixes the order: top, left, bottom, right.
  const order = [['t', 'top'], ['l', 'left'], ['b', 'bottom'], ['r', 'right']];
  const inner = order.map(([e, tag]) => {
    if (!Object.prototype.hasOwnProperty.call(b, e)) return '';
    const edge = b[e];
    if (!edge) return `<w:${tag} w:val="nil"/>`;
    return `<w:${tag} w:val="${DOCX_STYLE[edge.style] || 'single'}" w:sz="${eighths(edge.width)}"` +
           ` w:space="0" w:color="${edge.colour}"/>`;
  }).join('');
  return inner ? `<w:tcBorders>${inner}</w:tcBorders>` : '';
}

/** The reverse: a cell's `<w:tcPr>` back into the app's border set. */
function readTcBorders(pr) {
  const body = (pr.match(/<w:tcBorders>([\s\S]*?)<\/w:tcBorders>/) || [])[1];
  if (!body) return null;
  const out = {};
  [['t', 'top'], ['l', 'left'], ['b', 'bottom'], ['r', 'right']].forEach(([e, tag]) => {
    const m = body.match(new RegExp('<w:' + tag + '\\b([^>]*)/?>'));
    if (!m) return;
    const val = (m[1].match(/w:val="([^"]+)"/) || [])[1] || 'single';
    // An explicit nil is a fact about the cell, not the absence of one.
    if (val === 'none' || val === 'nil') { out[e] = null; return; }
    const sz = Number((m[1].match(/w:sz="(\d+)"/) || [])[1] || 4);
    out[e] = normEdge({
      style: DOCX_STYLE_BACK[val] || 'single',
      width: sz / 8,
      colour: (m[1].match(/w:color="([0-9A-Fa-f]{6})"/) || [])[1] || '808080'
    });
  });
  return normBorder(out);
}

/* Column widths in xlsx are measured in characters of the default font, not in
   pixels. The conversion is the one Excel documents: a column of n characters is
   n * maxDigitWidth + padding wide, which for an 11pt body font is 7px a
   character plus 5px of padding. Approximate by construction -- it is a different
   unit, not a different number for the same unit. */
function pxToChars(px) {
  return Math.max(1, Math.round(((Number(px) || 0) - 5) / 7 * 100) / 100);
}
function charsToPx(chars) {
  return Math.max(24, Math.round((Number(chars) || 0) * 7 + 5));
}

function indexToCol(n) {
  let s = '';
  let i = n + 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/**
 * Read a workbook: every worksheet, plus the one asked for as the headline.
 *
 * `cells`/`sheet`/`cols`/`rows` describe the requested sheet (the first, unless
 * named) and are kept because that is what the older single-sheet caller reads.
 * `sheets` is the whole book.
 */
/**
 * The charts anchored on a worksheet, with the cell references they draw from.
 *
 * Follows the chain of parts Excel writes: the worksheet names a drawing in its
 * relationships, the drawing anchors graphic frames, and each frame names a
 * chart part in the drawing's relationships. A link that does not resolve
 * skips that chart; nothing is invented from a broken chain.
 */
function readSheetCharts(files, target, wsXml) {
  const out = [];
  const dm = /<drawing\b[^>]*r:id="(rId\d+)"/.exec(wsXml);
  if (!dm) return out;
  const base = target.replace(/^\/?xl\//, '');           // worksheets/sheet1.xml
  const dir = base.replace(/[^/]*$/, '');                 // worksheets/
  const name = base.slice(dir.length);
  const relsPart = files.get('xl/' + dir + '_rels/' + name + '.rels');
  if (!relsPart) return out;
  const drawingTarget = relTarget(relsPart.toString('utf8'), dm[1]);
  if (!drawingTarget) return out;
  const drawingPath = resolvePart('xl/' + dir, drawingTarget);
  const drawing = files.get(drawingPath);
  if (!drawing) return out;
  const drawingDir = drawingPath.replace(/[^/]*$/, '');
  const dRels = files.get(drawingDir + '_rels/' + drawingPath.slice(drawingDir.length) + '.rels');
  const dRelText = dRels ? dRels.toString('utf8') : '';
  const text = drawing.toString('utf8');
  const anchorRe = /<xdr:(oneCellAnchor|twoCellAnchor|absoluteAnchor)\b[^>]*>([\s\S]*?)<\/xdr:\1>/g;
  let am;
  while ((am = anchorRe.exec(text))) {
    const body = am[2];
    const cm = /<c:chart\b[^>]*\br:id="(rId\d+)"/.exec(body);
    if (!cm) continue;
    const chartTarget = relTarget(dRelText, cm[1]);
    const part = chartTarget ? files.get(resolvePart(drawingDir, chartTarget)) : null;
    const read = part ? chartxml.readChartSpace(part.toString('utf8')) : null;
    if (!read) { out.skipped = (out.skipped || 0) + 1; continue; }
    const from = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(body);
    const num = (xml, tag, dflt) => Number((new RegExp('<xdr:' + tag + '>(-?\\d+)</xdr:' + tag + '>').exec(xml || '') || [])[1] || dflt);
    const col = from ? num(from[1], 'col', 0) : 0;
    const row = from ? num(from[1], 'row', 0) : 0;
    let w = 440, h = 270;
    if (am[1] === 'twoCellAnchor') {
      // Excel's own anchors span cells; sized here with the app's default grid.
      const to = /<xdr:to>([\s\S]*?)<\/xdr:to>/.exec(body);
      if (to) {
        w = (num(to[1], 'col', col) - col) * 78 + num(to[1], 'colOff', 0) / 9525;
        h = (num(to[1], 'row', row) - row) * 22 + num(to[1], 'rowOff', 0) / 9525;
      }
    } else {
      const ext = /<xdr:ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(body);
      if (ext) { w = Number(ext[1]) / 9525; h = Number(ext[2]) / 9525; }
    }
    out.push({
      spec: read.spec, refs: read.refs, anchor: { c: col, r: row },
      w: Math.round(Math.max(120, w)), h: Math.round(Math.max(80, h))
    });
  }
  return out;
}

function relTarget(relsXml, rid) {
  const re = /<Relationship\b[^>]*\/?>/g;
  let m;
  while ((m = re.exec(relsXml || ''))) {
    const id = /\bId="([^"]+)"/.exec(m[0]);
    const target = /\bTarget="([^"]+)"/.exec(m[0]);
    if (id && target && id[1] === rid) return target[1];
  }
  return null;
}

/** A relationship target resolved against its part's directory. */
function resolvePart(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = [];
  (dir + target).split('/').forEach((seg) => {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  });
  return out.join('/');
}

function readXlsx(buffer, opts = {}) {
  const files = zip.read(buffer);

  const wbXml = files.get('xl/workbook.xml');
  if (!wbXml) throw new Error('這不是 .xlsx（找不到 xl/workbook.xml）');
  const wb = wbXml.toString('utf8');

  const sheets = [];
  const sheetRe = /<sheet\b[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"[^>]*\/?>/g;
  let sm;
  while ((sm = sheetRe.exec(wb))) sheets.push({ name: unesc(sm[1]), rid: sm[2] });

  const relsXml = files.get('xl/_rels/workbook.xml.rels');
  const relMap = {};
  if (relsXml) {
    const rels = relsXml.toString('utf8');
    const rRe = /<Relationship\b[^>]*Id="(rId\d+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
    let rm;
    while ((rm = rRe.exec(rels))) relMap[rm[1]] = rm[2].replace(/^\/?xl\//, '').replace(/^\//, '');
  }

  // Shared strings, if the writer used them.
  const shared = [];
  const ssXml = files.get('xl/sharedStrings.xml');
  if (ssXml) {
    const ss = ssXml.toString('utf8');
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let si;
    while ((si = siRe.exec(ss))) {
      let text = '';
      const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
      let t;
      while ((t = tRe.exec(si[1]))) text += unesc(t[1]);
      shared.push(text);
    }
  }

  if (!sheets.length) throw new Error('這個 .xlsx 沒有工作表');

  /* ------------------------------------------------------------- styles ---

     styles.xml is a set of parallel tables that cells point into by index. Read
     once for the whole book, because cellXfs is a workbook-level part: two sheets
     using the same style are the same index, not two definitions.
  */
  const styleFor = (function () {
    const stylesXml = files.get('xl/styles.xml');
    if (!stylesXml) return () => ({});
    const sx = stylesXml.toString('utf8');

    const numFmts = new Map(NUMFMT_BY_ID);
    const nfRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/?>/g;
    let nf;
    while ((nf = nfRe.exec(sx))) numFmts.set(Number(nf[1]), unesc(nf[2]));

    const section = (name) => {
      const m = sx.match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>'));
      return m ? m[1] : '';
    };

    const fonts = [];
    const fontRe = /<font>([\s\S]*?)<\/font>/g;
    let fm;
    const fontsSection = section('fonts');
    while ((fm = fontRe.exec(fontsSection))) {
      const body = fm[1];
      const f = {};
      const name = (body.match(/<name\s+val="([^"]*)"/) || [])[1];
      const sz = Number((body.match(/<sz\s+val="([\d.]+)"/) || [])[1]);
      const colour = (body.match(/<color\b[^>]*rgb="([0-9A-Fa-f]{6,8})"/) || [])[1];
      if (name) f.font = name;
      if (Number.isFinite(sz) && sz > 0) f.size = sz;
      if (/<b\b[^\/>]*\/?>/.test(body)) f.bold = true;
      if (/<i\b[^\/>]*\/?>/.test(body)) f.italic = true;
      if (/<u\b[^\/>]*\/?>/.test(body)) f.under = true;
      if (/<strike\b[^\/>]*\/?>/.test(body)) f.strike = true;
      if (colour) f.fg = colour.slice(-6).toUpperCase();
      fonts.push(f);
    }

    const fills = [];
    const fillRe = /<fill>([\s\S]*?)<\/fill>/g;
    let fl;
    const fillsSection = section('fills');
    while ((fl = fillRe.exec(fillsSection))) {
      const solid = /patternType="solid"/.test(fl[1]);
      const rgb = (fl[1].match(/<fgColor\b[^>]*rgb="([0-9A-Fa-f]{6,8})"/) || [])[1];
      fills.push(solid && rgb ? rgb.slice(-6).toUpperCase() : null);
    }

    /* Borders, back into the app's own shape. The style name carries the weight
       in xlsx, so it is read as a (style, width) pair; the colour is its own
       element. An edge with no style attribute is absent, not "none" -- Excel
       writes <top/> for an edge a cell does not draw. */
    const borders = [];
    const borderRe = /<border\b[^>]*>([\s\S]*?)<\/border>|<border\b[^>]*\/>/g;
    let bd;
    const bordersSection = section('borders');
    while ((bd = borderRe.exec(bordersSection))) {
      const body = bd[1] || '';
      const spec = {};
      EDGES.forEach((e) => {
        const tag = EDGE_TAG[e];
        const m = body.match(new RegExp('<' + tag + '\\b[^>]*style="([^"]+)"[^>]*>([\\s\\S]*?)</' + tag + '>' +
                                        '|<' + tag + '\\b[^>]*style="([^"]+)"[^>]*/>'));
        if (!m) return;
        const name = m[1] || m[3];
        const known = xlsxBorderEdge(name);
        if (!known) return;
        const rgb = (String(m[2] || '').match(/rgb="([0-9A-Fa-f]{6,8})"/) || [])[1];
        spec[e] = normEdge({
          style: known.style,
          width: known.width,
          colour: rgb ? rgb.slice(-6) : '808080'
        });
      });
      borders.push(normBorder(spec));
    }

    const xfs = [];
    const xfRe = /<xf\b([^>]*)(?:\/>|>([\s\S]*?)<\/xf>)/g;
    let xm;
    const xfsSection = section('cellXfs');
    while ((xm = xfRe.exec(xfsSection))) {
      const attrs = xm[1] || '';
      const body = xm[2] || '';
      const pick = (k) => Number((attrs.match(new RegExp(k + '="(\\d+)"')) || [])[1] || 0);
      const align = (body.match(/horizontal="([a-z]+)"/) || [])[1];
      xfs.push({
        font: pick('fontId'), fill: pick('fillId'),
        border: pick('borderId'), numFmt: pick('numFmtId'),
        align: align && ['left', 'center', 'right'].indexOf(align) >= 0 ? align : null,
        wrap: /wrapText="1"/.test(body)
      });
    }

    return function (index) {
      const xf = xfs[index];
      if (!xf) return {};
      const out = Object.assign({}, fonts[xf.font] || {});
      const fill = fills[xf.fill];
      if (fill) out.bg = fill;
      const border = borders[xf.border];
      if (border) out.border = border;
      const code = numFmts.get(xf.numFmt);
      if (code && !/^general$/i.test(code)) out.numFmt = code;
      if (xf.align) out.align = xf.align;
      if (xf.wrap) out.wrap = true;
      return out;
    };
  })();

  /** One worksheet's cells, from its XML. */
  function readSheetXml(xml) {
    const cells = {};
    let maxRow = 0;
    let maxCol = 0;

    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm;
    while ((cm = cRe.exec(xml))) {
      const attrs = cm[1] || cm[3] || '';
      const inner = cm[2] || '';
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      if (!ref) continue;
      const type = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';

      const row = Number(ref.replace(/\D/g, '')) - 1;
      const col = colToIndex(ref);
      maxRow = Math.max(maxRow, row);
      maxCol = Math.max(maxCol, col);

      const formula = (inner.match(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/) || [])[1];
      const vRaw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      const isRaw = (inner.match(/<is>([\s\S]*?)<\/is>/) || [])[1];

      let value;
      if (type === 's' && vRaw !== undefined) value = shared[Number(vRaw)] ?? '';
      else if (type === 'inlineStr' && isRaw !== undefined) {
        value = unesc((isRaw.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/) || [])[1] || '');
      } else if (type === 'str' && vRaw !== undefined) value = unesc(vRaw);
      else if (type === 'b' && vRaw !== undefined) value = vRaw === '1';
      else if (vRaw !== undefined) value = Number(vRaw);
      else value = '';

      const style = styleFor(Number((attrs.match(/s="(\d+)"/) || [])[1] || 0));
      const base = formula ? { f: '=' + unesc(formula), v: value } : { v: value };
      cells[ref] = Object.assign(base, style);
    }

    /* Geometry: widths in characters, heights in points, both converted to the
       pixels the grid works in. Keyed by zero-based index, as the app keys them. */
    const colWidths = {};
    const colRe = /<col\b[^>]*min="(\d+)"[^>]*max="(\d+)"[^>]*width="([\d.]+)"[^>]*\/?>/g;
    let cw;
    while ((cw = colRe.exec(xml))) {
      if (!/customWidth="1"/.test(cw[0])) continue;
      for (let i = Number(cw[1]); i <= Number(cw[2]); i++) colWidths[i - 1] = charsToPx(cw[3]);
    }

    const rowHeights = {};
    const rowRe = /<row\b([^>]*)>/g;
    let rm;
    while ((rm = rowRe.exec(xml))) {
      const r = Number((rm[1].match(/r="(\d+)"/) || [])[1]);
      const ht = Number((rm[1].match(/ht="([\d.]+)"/) || [])[1]);
      if (r && Number.isFinite(ht) && ht > 0 && /customHeight="1"/.test(rm[1])) {
        rowHeights[r - 1] = Math.round(ht / 0.75);
      }
    }

    const pane = xml.match(/<pane\b[^>]*state="frozen"[^>]*\/?>/);
    const freeze = { rows: 0, cols: 0 };
    if (pane) {
      freeze.cols = Number((pane[0].match(/xSplit="(\d+)"/) || [])[1] || 0);
      freeze.rows = Number((pane[0].match(/ySplit="(\d+)"/) || [])[1] || 0);
    }

    /* Merged regions, as zero-based inclusive rectangles -- the shape the grid
       keeps them in. A region also widens the sheet: `<mergeCell ref="A1:H1"/>`
       with nothing in H means the sheet really is that wide. */
    const merges = [];
    const mergeRe = /<mergeCell\b[^>]*ref="([A-Z]+\d+):([A-Z]+\d+)"[^>]*\/?>/g;
    let mg;
    while ((mg = mergeRe.exec(xml))) {
      const a = { col: colToIndex(mg[1]), row: Number(mg[1].replace(/\D/g, '')) - 1 };
      const b = { col: colToIndex(mg[2]), row: Number(mg[2].replace(/\D/g, '')) - 1 };
      if (!Number.isFinite(a.row) || !Number.isFinite(b.row)) continue;
      merges.push({
        c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col),
        r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row)
      });
      maxCol = Math.max(maxCol, a.col, b.col);
      maxRow = Math.max(maxRow, a.row, b.row);
    }

    return { cells, rows: maxRow + 1, cols: maxCol + 1, colWidths, rowHeights, freeze, merges };
  }

  const all = sheets.map((s, i) => {
    const target = relMap[s.rid] || `worksheets/sheet${i + 1}.xml`;
    const wsXml = files.get('xl/' + target) || files.get(`xl/worksheets/sheet${i + 1}.xml`);
    if (!wsXml) {
      return {
        name: s.name, cells: {}, rows: 1, cols: 1,
        colWidths: {}, rowHeights: {}, freeze: { rows: 0, cols: 0 },
        merges: [], missing: true
      };
    }
    const wsText = wsXml.toString('utf8');
    const out = Object.assign({ name: s.name }, readSheetXml(wsText));
    // Absent rather than empty when the sheet has none, like merges.
    const found = readSheetCharts(files, target, wsText);
    if (found.length) out.charts = found;
    // A chart of a kind this reader does not know is counted, not invented.
    if (found.skipped) out.chartsSkipped = found.skipped;
    return out;
  });

  const wanted = (opts.sheet && all.find((s) => s.name === opts.sheet)) || all[0];

  return {
    format: 'xlsx',
    sheetNames: all.map((s) => s.name),
    sheets: all,
    // The requested sheet, flattened out for the single-sheet caller.
    sheet: wanted.name,
    cells: wanted.cells,
    rows: wanted.rows,
    cols: wanted.cols
  };
}

/**
 * Write a workbook. Strings go inline rather than into a shared table: it costs
 * a few bytes and removes an entire class of index-desync bug.
 *
 * Either one sheet (`sheetName` + `cells`) or a whole book (`sheets`). The style
 * table is shared across every sheet, which is what xlsx requires -- cellXfs is a
 * workbook-level part, so interning has to happen once for the book and not once
 * per sheet.
 */
function writeXlsx({ sheetName = '工作表1', cells = {}, sheets = null, font = null, size = null } = {}) {
  const book = Array.isArray(sheets) && sheets.length
    ? sheets.map((s, i) => ({
      name: s.name || `工作表${i + 1}`,
      cells: s.cells || {},
      colWidths: s.colWidths || {},
      rowHeights: s.rowHeights || {},
      freeze: s.freeze || { rows: 0, cols: 0 },
      merges: Array.isArray(s.merges) ? s.merges : [],
      charts: Array.isArray(s.charts) ? s.charts : []
    }))
    : [{
      name: sheetName, cells: cells,
      colWidths: {}, rowHeights: {}, freeze: { rows: 0, cols: 0 }, merges: [], charts: []
    }];
  /* Style table.
     xlsx does not let a cell name a typeface directly: it points at an index in
     cellXfs, which points at an index in fonts. So every distinct combination
     used in the sheet has to be interned first, and index 0 has to stay the
     default because a cell with no s= attribute means "style 0". */
  const baseFont = {
    name: font || 'Calibri',
    size: Number(size) > 0 ? Number(size) : 11,
    bold: false, italic: false, under: false, strike: false, colour: null
  };
  const fontKey = (f) =>
    `${f.name}|${f.size}|${f.bold ? 1 : 0}|${f.italic ? 1 : 0}|${f.under ? 1 : 0}|${f.strike ? 1 : 0}|${f.colour || ''}`;
  const fontList = [baseFont];
  const fontIndex = new Map([[fontKey(baseFont), 0]]);

  function internFont(spec) {
    const f = {
      name: spec.font || baseFont.name,
      size: Number(spec.size) > 0 ? Number(spec.size) : baseFont.size,
      bold: !!spec.bold,
      italic: !!spec.italic,
      under: !!spec.under,
      strike: !!spec.strike,
      colour: hex6(spec.fg)
    };
    const key = fontKey(f);
    if (fontIndex.has(key)) return fontIndex.get(key);
    fontList.push(f);
    fontIndex.set(key, fontList.length - 1);
    return fontList.length - 1;
  }

  /* Fills. Index 0 and 1 are reserved by the format itself -- every reader expects
     "none" then "gray125" -- so real fills start at 2. */
  const fillList = [null, null];
  const fillIndex = new Map();
  function internFill(hex) {
    const h = hex6(hex);
    if (!h) return 0;
    if (fillIndex.has(h)) return fillIndex.get(h);
    fillList.push(h);
    fillIndex.set(h, fillList.length - 1);
    return fillList.length - 1;
  }

  /* Borders, described the way the app stores them: up to four edges, each with a
     style, a weight and a colour. Index 0 is no border. */
  const borderList = [null];
  const borderIndex = new Map([['', 0]]);
  function internBorder(spec) {
    const b = normBorder(spec);
    const k = borderKey(b);
    if (!k) return 0;
    if (borderIndex.has(k)) return borderIndex.get(k);
    borderList.push(b);
    borderIndex.set(k, borderList.length - 1);
    return borderList.length - 1;
  }

  /* Number formats. The built-in ids are used where one matches exactly, because a
     file that says numFmtId="4" is understood by every reader without carrying a
     definition. Anything else becomes a custom format, and those start at 164 --
     the first id the format reserves for the document. */
  const numFmtList = [];
  const numFmtIndex = new Map();
  function internNumFmt(code) {
    const c = String(code || '');
    if (!c || /^general$/i.test(c)) return 0;
    if (BUILTIN_NUMFMT.has(c)) return BUILTIN_NUMFMT.get(c);
    if (numFmtIndex.has(c)) return numFmtIndex.get(c);
    const id = 164 + numFmtList.length;
    numFmtList.push({ id, code: c });
    numFmtIndex.set(c, id);
    return id;
  }

  /* One cellXfs entry per distinct *combination*. The old table kept xf i pointing
     at font i, which works only while a font is the only thing a cell can carry;
     the moment a cell has a fill as well, the parallel arrays cannot express it. */
  const xfList = [{ font: 0, fill: 0, border: 0, numFmt: 0, align: '', wrap: false }];
  const xfIndex = new Map();
  const xfKey = (x) => `${x.font}|${x.fill}|${x.border}|${x.numFmt}|${x.align}|${x.wrap ? 1 : 0}`;
  xfIndex.set(xfKey(xfList[0]), 0);

  function styleFor(cell) {
    if (!cell || typeof cell !== 'object') return 0;
    const xf = {
      font: (cell.font || cell.size || cell.bold || cell.italic || cell.under || cell.strike || cell.fg)
        ? internFont(cell) : 0,
      fill: internFill(cell.bg),
      border: internBorder(cell.border),
      numFmt: internNumFmt(cell.numFmt),
      align: ['left', 'center', 'right'].indexOf(cell.align) >= 0 ? cell.align : '',
      wrap: !!cell.wrap
    };
    const key = xfKey(xf);
    if (xfIndex.has(key)) return xfIndex.get(key);
    xfList.push(xf);
    xfIndex.set(key, xfList.length - 1);
    return xfList.length - 1;
  }

  function sheetXml(sheetCells, geom) {
  const byRow = new Map();
  for (const [ref, cell] of Object.entries(sheetCells)) {
    if (!/^[A-Z]+\d+$/.test(ref)) continue;
    const row = Number(ref.replace(/\D/g, ''));
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push([ref, cell]);
  }

  const g = geom || {};
  const heights = g.rowHeights || {};
  const widths = g.colWidths || {};
  const frozen = g.freeze || { rows: 0, cols: 0 };
  const merged = Array.isArray(g.merges) ? g.merges : [];

  const rowsXml = [...byRow.keys()].sort((a, b) => a - b).map((row) => {
    // Row heights are points in the file and pixels in the app.
    const px = heights[row - 1];
    const htAttr = px ? ` ht="${Math.round(px * 0.75 * 100) / 100}" customHeight="1"` : '';
    const cs = byRow.get(row)
      .sort((a, b) => colToIndex(a[0]) - colToIndex(b[0]))
      .map(([ref, cell]) => {
        const raw = cell && typeof cell === 'object' ? cell : { v: cell };
        const f = raw.f ? String(raw.f).replace(/^=/, '') : null;
        const v = raw.v;
        const s = styleFor(raw);
        const sAttr = s ? ` s="${s}"` : '';

        if (f) {
          const numeric = typeof v === 'number' && Number.isFinite(v);
          return `<c r="${ref}"${sAttr}${numeric ? '' : ' t="str"'}><f>${esc(f)}</f>` +
                 `<v>${numeric ? v : esc(v == null ? '' : v)}</v></c>`;
        }
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
        if (typeof v === 'boolean') return `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
        if (v === '' || v == null) {
          // An empty cell that only carries formatting still has to be written,
          // or the formatting is silently dropped on export.
          return s ? `<c r="${ref}"${sAttr}/>` : '';
        }
        return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }).join('');
    return `<row r="${row}"${htAttr}>${cs}</row>`;
  }).join('');

    /* Frozen panes. `topLeftCell` is the first cell of the scrolling area and
       the split is measured in whole rows and columns, so this is the same
       "freeze above and left of here" the app stores. */
    let views = '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    if (frozen.rows || frozen.cols) {
      const topLeft = indexToCol(frozen.cols) + (frozen.rows + 1);
      const pane = frozen.rows && frozen.cols ? 'bottomRight'
        : frozen.rows ? 'bottomLeft' : 'topRight';
      views = '<sheetViews><sheetView workbookViewId="0">' +
        `<pane${frozen.cols ? ` xSplit="${frozen.cols}"` : ''}` +
        `${frozen.rows ? ` ySplit="${frozen.rows}"` : ''}` +
        ` topLeftCell="${topLeft}" activePane="${pane}" state="frozen"/>` +
        `<selection pane="${pane}" activeCell="${topLeft}" sqref="${topLeft}"/>` +
        '</sheetView></sheetViews>';
    }

    const colsXml = Object.keys(widths).length
      ? '<cols>' + Object.keys(widths).sort((a, b) => Number(a) - Number(b)).map((k) => {
        const i = Number(k) + 1;
        return `<col min="${i}" max="${i}" width="${pxToChars(widths[k])}" customWidth="1"/>`;
      }).join('') + '</cols>'
      : '';

    /* Merged regions. The element order inside <worksheet> is not a style
       preference: the schema fixes the sequence, and mergeCells belongs after
       sheetData. Emit it before and Excel reports the file as needing repair. */
    const mergeXml = merged.length
      ? `<mergeCells count="${merged.length}">` +
        merged.map((m) =>
          `<mergeCell ref="${indexToCol(m.c0)}${m.r0 + 1}:${indexToCol(m.c1)}${m.r1 + 1}"/>`).join('') +
        '</mergeCells>'
      : '';

    /* The drawing that anchors the sheet's charts, after mergeCells -- the
       schema fixes that order too. A sheet with no charts names no drawing and
       declares no relationship namespace, so it is byte-identical to before. */
    const withCharts = Array.isArray(g.charts) && g.charts.length > 0;
    return XML_DECL +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
      (withCharts ? ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' : '') + '>' +
      views + colsXml +
      `<sheetData>${rowsXml}</sheetData>${mergeXml}` +
      (withCharts ? '<drawing r:id="rId1"/>' : '') + '</worksheet>';
  }

  /* Sheets are written before the workbook part, because writing the rows is
     what discovers which fonts are used -- and the style table they point at is
     shared by the whole book. */
  const sheetParts = book.map((s) => sheetXml(s.cells, s));

  /* Excel caps a sheet name at 31 characters. The cap is applied before
     escaping (slicing an escaped name can cut an entity in half), and a chart
     reference that named the long form is rewritten to the short one, or every
     series would point at a sheet the workbook does not contain. */
  function sheetTitle(name) { return String(name || '').slice(0, 31); }
  function shortRef(ref, name) {
    const short = sheetTitle(name);
    if (!ref || short === name) return ref;
    const q = (n) => "'" + String(n).replace(/'/g, "''") + "'!";
    return String(ref).split(q(name)).join(q(short));
  }

  /* Charts. Each sheet with any gets one drawing part anchoring them to cells,
     and every chart its own part, numbered across the whole book. The
     spreadsheet passes the cell references its chart was drawn from, so the
     chart Excel opens is live in the same cells. Sizes arrive in pixels and
     leave as EMU (9525 to the pixel at 96 dpi). */
  const drawingParts = [];   // { sheet, xml, rels, charts: [{ name, xml }] }
  let chartCount = 0;
  book.forEach((s, i) => {
    const list = (s.charts || []).filter((c) => c && typeof c === 'object');
    if (!list.length) return;
    const anchors = [];
    const drels = [];
    const cparts = [];
    list.forEach((c, j) => {
      const spec = c.spec || c.chart || c;
      const n = ++chartCount;
      const rid = 'rId' + (j + 1);
      const refs = c.refs ? {
        cat: shortRef(c.refs.cat, s.name),
        tx: (c.refs.tx || []).map((r) => shortRef(r, s.name)),
        val: (c.refs.val || []).map((r) => shortRef(r, s.name))
      } : null;
      cparts.push({
        name: `charts/chart${n}.xml`,
        xml: chartxml.chartSpaceXml(spec, {
          font, size: size ? Math.max(6, size - 1) : 10, refs, sheet: sheetTitle(s.name)
        })
      });
      drels.push(`<Relationship Id="${rid}" Type="${chartxml.CHART_REL_TYPE}" Target="../charts/chart${n}.xml"/>`);
      const a = c.anchor || {};
      const col = Math.max(0, Math.floor(Number(a.c) || 0));
      const row = Math.max(0, Math.floor(Number(a.r) || 0));
      const cx = Math.round(Math.max(120, Number(c.w) || 440) * 9525);
      const cy = Math.round(Math.max(80, Number(c.h) || 270) * 9525);
      const name = spec && spec.title ? String(spec.title) : `圖表 ${n}`;
      anchors.push('<xdr:oneCellAnchor>' +
        `<xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${cx}" cy="${cy}"/>` +
        '<xdr:graphicFrame macro="">' +
        `<xdr:nvGraphicFramePr><xdr:cNvPr id="${j + 2}" name="${esc(name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
        '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
        `<a:graphic><a:graphicData uri="${chartxml.CHART_GRAPHIC_URI}">${chartxml.chartRefXml(rid)}</a:graphicData></a:graphic>` +
        '</xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>');
    });
    drawingParts.push({
      sheet: i,
      xml: XML_DECL +
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
        `xmlns:a="${chartxml.NS_A}">` + anchors.join('') + '</xdr:wsDr>',
      rels: XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        drels.join('') + '</Relationships>',
      charts: cparts
    });
  });

  // Styles take the relationship id after the last worksheet.
  const stylesRid = 'rId' + (book.length + 1);

  const workbook = XML_DECL +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    book.map((s, i) =>
      `<sheet name="${esc(sheetTitle(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>';

  const wbRels = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    book.map((_s, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';

  const contentTypes = XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    book.map((_s, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    drawingParts.map((d, k) =>
      `<Override PartName="/xl/drawings/drawing${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` +
      d.charts.map((c) => `<Override PartName="/xl/${c.name}" ContentType="${chartxml.CHART_CONTENT_TYPE}"/>`).join('')).join('') +
    '</Types>';

  const rels = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const fontsXml = fontList.map((f) =>
    '<font>' + (f.bold ? '<b/>' : '') + (f.italic ? '<i/>' : '') +
    (f.under ? '<u/>' : '') + (f.strike ? '<strike/>' : '') +
    (f.colour ? `<color rgb="FF${f.colour}"/>` : '') +
    `<sz val="${f.size}"/><name val="${esc(f.name)}"/></font>`).join('');

  const fillsXml =
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    fillList.slice(2).map((hex) =>
      `<fill><patternFill patternType="solid"><fgColor rgb="FF${hex}"/>` +
      '<bgColor indexed="64"/></patternFill></fill>').join('');

  /* A border definition per distinct edge set. An edge the cell does not draw is
     written as an empty element rather than style="none" -- an explicit none
     overrides the neighbour's edge, so a cell with no bottom would erase the top
     of the cell below it.

     Order matters: the schema wants left, right, top, bottom, diagonal. */
  const borderEdgeXml = (spec, e) => {
    const tag = EDGE_TAG[e];
    // In a sheet, an edge that says nothing and one that says none are both
    // drawn the same: the gridline underneath is Excel's, not a border.
    const edge = spec && spec[e];
    if (!edge) return `<${tag}/>`;
    return `<${tag} style="${xlsxBorderName(edge)}"><color rgb="FF${edge.colour}"/></${tag}>`;
  };
  const bordersXml = borderList.map((spec) =>
    '<border>' +
    borderEdgeXml(spec, 'l') +
    borderEdgeXml(spec, 'r') +
    borderEdgeXml(spec, 't') +
    borderEdgeXml(spec, 'b') +
    '<diagonal/></border>').join('');

  const numFmtsXml = numFmtList.length
    ? `<numFmts count="${numFmtList.length}">` +
      numFmtList.map((n) => `<numFmt numFmtId="${n.id}" formatCode="${esc(charts.excelFormatCode(n.code))}"/>`).join('') +
      '</numFmts>'
    : '';

  const xfsXml = xfList.map((x) => {
    const applied =
      (x.font ? ' applyFont="1"' : '') +
      (x.fill ? ' applyFill="1"' : '') +
      (x.border ? ' applyBorder="1"' : '') +
      (x.numFmt ? ' applyNumberFormat="1"' : '') +
      (x.align || x.wrap ? ' applyAlignment="1"' : '');
    const alignment = x.align || x.wrap
      ? `<alignment${x.align ? ` horizontal="${x.align}"` : ''}${x.wrap ? ' wrapText="1"' : ''}/>`
      : '';
    return `<xf numFmtId="${x.numFmt}" fontId="${x.font}" fillId="${x.fill}" ` +
      `borderId="${x.border}" xfId="0"${applied}>${alignment}</xf>`;
  }).join('');

  const styles = XML_DECL +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    numFmtsXml +
    `<fonts count="${fontList.length}">${fontsXml}</fonts>` +
    `<fills count="${fillList.length}">${fillsXml}</fills>` +
    `<borders count="${borderList.length}">${bordersXml}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfList.length}">${xfsXml}</cellXfs>` +
    '</styleSheet>';

  const parts = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rels,
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': wbRels,
    'xl/styles.xml': styles
  };
  sheetParts.forEach((xml, i) => { parts[`xl/worksheets/sheet${i + 1}.xml`] = xml; });
  drawingParts.forEach((d, k) => {
    parts[`xl/worksheets/_rels/sheet${d.sheet + 1}.xml.rels`] = XML_DECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${k + 1}.xml"/>` +
      '</Relationships>';
    parts[`xl/drawings/drawing${k + 1}.xml`] = d.xml;
    parts[`xl/drawings/_rels/drawing${k + 1}.xml.rels`] = d.rels;
    d.charts.forEach((c) => { parts['xl/' + c.name] = c.xml; });
  });

  return zip.write(parts, { store: ['[Content_Types].xml'] });
}

/* ###########################################################################
   pptx
   ---------------------------------------------------------------------------
   Same scope rule as the other two: this writes the parts of a presentation
   that carry meaning -- slide text, layout, placed objects, speaker notes --
   and does not attempt animations, transitions, SmartArt or a designed master.

   It is a writer only. A .pptx opened here goes through the reader for .docx-
   style text extraction elsewhere; round-tripping a presentation authored in
   PowerPoint is not offered, because the half of it this format cannot describe
   is the half people would miss.
   ######################################################################### */

/* A 16:9 slide in EMU. 914400 EMU to the inch; 13.333in x 7.5in.

   The editor's own geometry is percentages of the slide box and its type sizes
   are points against a 540pt-tall slide (PT_PER_CQH in slides.js). Both convert
   here and nowhere else, so the numbers in a saved deck and the numbers in the
   file mean the same thing. */
const EMU_W = 12192000;
const EMU_H = 6858000;
const EMU_PER_PT = EMU_H / 540;

const pctX = (v) => Math.round((Number(v) || 0) / 100 * EMU_W);
const pctY = (v) => Math.round((Number(v) || 0) / 100 * EMU_H);
const ptEmu = (v) => Math.round((Number(v) || 0) * EMU_PER_PT);
/** Type size, in the hundredths of a point the schema wants. */
const sz = (pt) => Math.round(Math.max(1, Math.min(400, Number(pt) || 18)) * 100);

/* PowerPoint's preset geometries for the editor's shape gallery. The clip-path
   polygons in slides.js are how a browser draws them; these are how PowerPoint
   does, and they are chosen to match what the polygon looks like rather than by
   name -- `plus` is `mathPlus` there, and `callout` is the rounded rectangular
   callout because the polygon has a square body with a tail. */
const PPT_SHAPES = {
  rect: 'rect', round: 'roundRect', pill: 'roundRect', ellipse: 'ellipse',
  triangle: 'triangle', rtri: 'rtTriangle', diamond: 'diamond',
  pentagon: 'pentagon', hexagon: 'hexagon', star: 'star5', plus: 'mathPlus',
  para: 'parallelogram', trapezoid: 'trapezoid', arrowR: 'rightArrow',
  arrowL: 'leftArrow', arrowU: 'upArrow', arrowD: 'downArrow',
  chevron: 'chevron', callout: 'wedgeRectCallout'
};

const ALIGN_ATTR = { left: 'l', center: 'ctr', right: 'r' };
const VALIGN_ATTR = { top: 't', middle: 'ctr', bottom: 'b' };

/** `<a:solidFill>` for a six-hex colour, or '' for "inherit". */
function solid(hex) {
  const h = hex6(hex);
  return h ? `<a:solidFill><a:srgbClr val="${h}"/></a:solidFill>` : '';
}

/**
 * Run properties. The font goes on `latin`, `ea` and `cs` together: a deck set
 * to a CJK face renders in it for Latin text too, which is what the editor
 * shows, and leaving `ea` unset makes PowerPoint substitute its own East Asian
 * font and quietly change the look of every Chinese slide.
 */
function rPr(o = {}) {
  const font = o.font ? esc(String(o.font).slice(0, 64)) : '';
  const face = font
    ? `<a:latin typeface="${font}"/><a:ea typeface="${font}"/><a:cs typeface="${font}"/>`
    : '';
  return `<a:rPr lang="zh-TW" altLang="en-US" sz="${sz(o.size)}"` +
    (o.bold ? ' b="1"' : '') + (o.italic ? ' i="1"' : '') + ' dirty="0">' +
    solid(o.colour) + face + '</a:rPr>';
}

/**
 * Text lines to paragraphs.
 *
 * A blank line is emitted as an empty paragraph rather than dropped, because in
 * this deck format a blank line is the only spacing control there is -- the
 * model uses it to separate a figure from its explanation, and a deck that
 * silently closes those gaps reads as a wall of text.
 */
function paras(text, opts = {}) {
  const lines = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  const algn = ALIGN_ATTR[opts.align] || 'l';
  const pPr = (bullet) => `<a:pPr algn="${algn}">` +
    (bullet ? '<a:buChar char="&#8226;"/>' : '<a:buNone/>') + '</a:pPr>';

  /* The run properties of a blank line matter twice: typing into it should
     continue in the same face rather than jump to PowerPoint's default, and a
     box whose paragraphs disagree about the font reports itself as mixed --
     which is how the missing font on the empty line was found. */
  const endRPr = rPr(opts)
    .replace('<a:rPr ', '<a:endParaRPr ').replace('</a:rPr>', '</a:endParaRPr>');

  return lines.map((line) => {
    const t = line.replace(/^[-*•]\s*/, '');
    /* An empty line carries no bullet even inside a bulleted block: a bullet
       with nothing after it is a typo on a slide, not a blank line. */
    if (!t.trim()) return `<a:p>${pPr(false)}${endRPr}</a:p>`;
    return `<a:p>${pPr(!!opts.bullet)}<a:r>${rPr(opts)}<a:t>${esc(t)}</a:t></a:r></a:p>`;
  }).join('');
}

/** One `<p:sp>`: a positioned box with text in it. */
function textBox(id, name, box, body, opts = {}) {
  const geom = opts.geom || 'rect';
  const shapeFill = opts.fill !== undefined ? solid(opts.fill) : '';
  const line = opts.stroke
    ? `<a:ln w="12700">${solid(opts.stroke)}</a:ln>`
    : (opts.fill !== undefined && !opts.fill ? '<a:ln><a:noFill/></a:ln>' : '');
  return '<p:sp>' +
    '<p:nvSpPr>' +
      `<p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/>` +
    '</p:nvSpPr>' +
    '<p:spPr>' +
      `<a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
      `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>` +
      (shapeFill || '<a:noFill/>') + line +
    '</p:spPr>' +
    '<p:txBody>' +
      `<a:bodyPr wrap="square" anchor="${VALIGN_ATTR[opts.valign] || 't'}">` +
        '<a:normAutofit/></a:bodyPr><a:lstStyle/>' +
      body +
    '</p:txBody>' +
  '</p:sp>';
}

/** One `<a:tbl>` inside a graphicFrame, from the editor's rows/merges shape. */
function tableXml(id, o, font) {
  const rows = o.rows || [];
  const cols = (rows[0] || []).length || 1;
  const colW = Math.round(pctX(o.w) / cols);
  const rowH = Math.round(pctY(o.h) / Math.max(1, rows.length));

  /* The editor's merges are regions; the schema wants each covered cell present
     and flagged, with the origin carrying the span. A region that reaches past
     the rows actually here is ignored rather than clamped -- a table narrower
     than its merge list is a file that disagrees with itself, and guessing which
     half is right produces a table nobody asked for. */
  const spanAt = new Map();
  const coveredBy = new Map();
  (o.merges || []).forEach((m) => {
    const c0 = m.c, r0 = m.r, c1 = m.c + m.w - 1, r1 = m.r + m.h - 1;
    if (r1 >= rows.length || c1 >= cols) return;
    spanAt.set(r0 + ',' + c0, { w: m.w, h: m.h });
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (r === r0 && c === c0) continue;
        coveredBy.set(r + ',' + c, { hMerge: r === r0 ? false : c > c0, right: c > c0, down: r > r0 });
      }
    }
  });

  const gridCols = Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join('');
  const body = rows.map((row, r) => {
    const cells = Array.from({ length: cols }, (_, c) => {
      const span = spanAt.get(r + ',' + c);
      const cover = coveredBy.get(r + ',' + c);
      const attrs = span
        ? (span.w > 1 ? ` gridSpan="${span.w}"` : '') + (span.h > 1 ? ` rowSpan="${span.h}"` : '')
        : cover ? (cover.right ? ' hMerge="1"' : '') + (cover.down ? ' vMerge="1"' : '') : '';
      const isHeader = o.header !== false && r === 0;
      const shade = isHeader ? o.fill
        : (o.banded !== false && r % 2 === 0 ? 'F2F5F8' : '');
      const text = cover ? '' : String((row || [])[c] == null ? '' : row[c]);
      return `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>` +
        paras(text, {
          size: o.size, font,
          bold: isHeader || o.bold, italic: o.italic,
          colour: isHeader ? 'FFFFFF' : o.colour,
          align: o.align, bullet: false
        }) +
        '</a:txBody><a:tcPr marL="45720" marR="45720" marT="27432" marB="27432" anchor="ctr">' +
        (shade ? solid(shade) : '') + '</a:tcPr></a:tc>';
    }).join('');
    return `<a:tr h="${rowH}">${cells}</a:tr>`;
  }).join('');

  return '<p:graphicFrame>' +
    `<p:nvGraphicFramePr><p:cNvPr id="${id}" name="表格"/>` +
      '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>' +
      '<p:nvPr/></p:nvGraphicFramePr>' +
    `<p:xfrm><a:off x="${pctX(o.x)}" y="${pctY(o.y)}"/>` +
      `<a:ext cx="${pctX(o.w)}" cy="${pctY(o.h)}"/></p:xfrm>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
    '<a:tbl><a:tblPr firstRow="' + (o.header === false ? 0 : 1) + '" bandRow="' +
      (o.banded === false ? 0 : 1) + '"/>' +
    `<a:tblGrid>${gridCols}</a:tblGrid>${body}</a:tbl>` +
    '</a:graphicData></a:graphic></p:graphicFrame>';
}

/** A `<p:graphicFrame>` holding a chart part -- the same frame a table sits in. */
function chartFrameXml(id, o, rid) {
  return '<p:graphicFrame>' +
    `<p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc((o.chart && o.chart.title) || '圖表')}"/>` +
    '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr>' +
    '<p:nvPr/></p:nvGraphicFramePr>' +
    `<p:xfrm><a:off x="${pctX(o.x)}" y="${pctY(o.y)}"/>` +
    `<a:ext cx="${pctX(o.w)}" cy="${pctY(o.h)}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="${chartxml.CHART_GRAPHIC_URI}">` +
    chartxml.chartRefXml(rid) +
    '</a:graphicData></a:graphic></p:graphicFrame>';
}

/** A `<p:pic>` for an image whose bytes are already in the package. */
function pictureXml(id, o, rid) {
  return '<p:pic>' +
    `<p:nvPicPr><p:cNvPr id="${id}" name="${esc(o.alt || '圖片')}"` +
      (o.alt ? ` descr="${esc(o.alt)}"` : '') + '/>' +
      '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
    `<p:blipFill><a:blip r:embed="${rid}"/>` +
      /* `contain` letterboxes and `cover` crops. A stretch fill is the first;
         the second needs the crop expressed as a srcRect, which needs the image's
         own pixel size, which is not in the deck -- so `cover` falls back to
         `contain` rather than silently distorting the picture. */
      '<a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    `<p:spPr><a:xfrm><a:off x="${pctX(o.x)}" y="${pctY(o.y)}"/>` +
      `<a:ext cx="${pctX(o.w)}" cy="${pctY(o.h)}"/></a:xfrm>` +
      `<a:prstGeom prst="${o.round ? 'roundRect' : 'rect'}"><a:avLst/></a:prstGeom></p:spPr>` +
  '</p:pic>';
}

const IMG_TYPES = {
  png: ['png', 'image/png'], jpeg: ['jpeg', 'image/jpeg'], jpg: ['jpeg', 'image/jpeg'],
  gif: ['gif', 'image/gif'], bmp: ['bmp', 'image/bmp'], webp: ['webp', 'image/webp'],
  'svg+xml': ['svg', 'image/svg+xml']
};

/** Bytes and an extension out of a data: URI, or null for anything else. */
function decodeDataUri(src) {
  const m = /^data:image\/([a-z+]+);base64,([\s\S]+)$/i.exec(String(src || ''));
  if (!m) return null;
  const known = IMG_TYPES[m[1].toLowerCase()];
  if (!known) return null;
  return { ext: known[0], mime: known[1], buffer: Buffer.from(m[2], 'base64') };
}

/**
 * A deck -> a .pptx.
 *
 * Takes the editor's own save shape, so what is written is what is on screen:
 * `{title, font, scale, slides:[{layout, title, body[], notes, objects[]}]}`.
 *
 * Images must already be data: URIs. The renderer resolves sandbox paths before
 * calling, the same way it does for the PDF export -- main has no business
 * reaching into the sandbox on the strength of a string inside a document.
 *
 * Returns `{buffer, warnings}`. The warnings name what could not be carried;
 * they are shown, not swallowed, because a presentation that quietly lost a
 * picture is worse than one that says it did.
 */
function writePptx(deck = {}) {
  const warnings = [];
  const slides = Array.isArray(deck.slides) && deck.slides.length
    ? deck.slides : [{ layout: 'title', title: deck.title || '', body: [''], objects: [] }];
  const font = deck.font || null;
  /* The editor's scale is a percentage applied to every type size on screen, so
     it has to be baked into the point sizes here or the exported deck comes out
     at a different size from the one that was designed. */
  const k = Math.max(50, Math.min(300, Number(deck.scale) || 100)) / 100;
  const at = (pt) => pt * k;

  const media = [];   // {name, buffer, mime}
  const byData = new Map();
  const chartParts = [];   // {name, xml}, numbered across the deck

  /** Bytes into the package once, however many slides show the same picture. */
  function addImage(src) {
    if (byData.has(src)) return byData.get(src);
    const img = decodeDataUri(src);
    if (!img) return null;
    const name = `image${media.length + 1}.${img.ext}`;
    media.push({ name, buffer: img.buffer, mime: img.mime });
    byData.set(src, name);
    return name;
  }

  const slideParts = [];
  const slideRels = [];
  const notesParts = [];

  slides.forEach((raw, i) => {
    const s = raw || {};
    const layout = s.layout || 'bullets';
    const body = Array.isArray(s.body) ? s.body : [String(s.body == null ? '' : s.body)];
    const shapes = [];
    const rels = [
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
    ];
    let nextId = 2;
    let nextRel = 2;

    const title = String(s.title || '');
    const col = (n, of) => ({
      x: pctX(7 + n * (86 / of)), cx: pctX(86 / of - (of > 1 ? 4 : 0))
    });

    if (layout === 'title' || layout === 'section') {
      const big = layout === 'title' ? 44 : 40;
      shapes.push(textBox(nextId++, '標題', {
        x: pctX(8), y: pctY(layout === 'title' ? 34 : 40), cx: pctX(84), cy: pctY(20)
      }, paras(title, { size: at(big), font, bold: true, align: 'center', bullet: false }),
      { valign: 'middle' }));
      if (String(body[0] || '').trim()) {
        shapes.push(textBox(nextId++, '副標題', {
          x: pctX(8), y: pctY(layout === 'title' ? 56 : 60), cx: pctX(84), cy: pctY(22)
        }, paras(body[0], { size: at(18), font, align: 'center', bullet: false, colour: '5A6672' }),
        { valign: 'top' }));
      }
    } else if (layout === 'quote') {
      shapes.push(textBox(nextId++, '引言', {
        x: pctX(10), y: pctY(24), cx: pctX(80), cy: pctY(52)
      }, paras(body[0] || title, { size: at(32), font, italic: true, align: 'center', bullet: false }),
      { valign: 'middle' }));
    } else if (layout !== 'blank') {
      if (title) {
        shapes.push(textBox(nextId++, '標題', {
          x: pctX(7), y: pctY(8), cx: pctX(86), cy: pctY(13)
        }, paras(title, { size: at(28), font, bold: true, bullet: false }), { valign: 'middle' }));
      }
      const cols = layout === 'two' ? 2 : 1;
      for (let c = 0; c < cols; c++) {
        const geom = col(c, cols);
        shapes.push(textBox(nextId++, '內文' + (c + 1), {
          x: geom.x, y: pctY(24), cx: geom.cx, cy: pctY(66)
        }, paras(body[c] || '', {
          size: at(layout === 'bullets' ? 18 : 17), font,
          bullet: layout === 'bullets'
        }), { valign: 'top' }));
      }
    }

    (s.objects || []).forEach((o) => {
      if (!o) return;
      if (o.kind === 'table') {
        shapes.push(tableXml(nextId++, Object.assign({}, o, { size: at(o.size || 14) }), font));
        return;
      }
      if (o.kind === 'image') {
        const name = o.src ? addImage(o.src) : null;
        if (!name) {
          warnings.push('第 ' + (i + 1) + ' 頁的圖片沒有寫進去：' +
            (o.src ? '不是可嵌入的影像資料' : '還沒選圖片'));
          return;
        }
        const rid = 'rId' + nextRel++;
        rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/>`);
        shapes.push(pictureXml(nextId++, o, rid));
        return;
      }
      if (o.kind === 'chart') {
        const spec = o.chart && typeof o.chart === 'object' ? o.chart : null;
        const hasData = !!spec && Array.isArray(spec.series) && spec.series.some((ser) =>
          ser && Array.isArray(ser.values) && ser.values.some((v) => v !== null && v !== '' && isFinite(Number(v))));
        if (!hasData) {
          warnings.push('第 ' + (i + 1) + ' 頁的圖表沒有資料，沒有寫進去');
          return;
        }
        const n = chartParts.length + 1;
        chartParts.push({
          name: `chart${n}.xml`,
          xml: chartxml.chartSpaceXml(spec, {
            font, size: at(o.size || 12), colour: o.colour || '404040', fill: o.fill || null
          })
        });
        const rid = 'rId' + nextRel++;
        rels.push(`<Relationship Id="${rid}" Type="${chartxml.CHART_REL_TYPE}" Target="../charts/chart${n}.xml"/>`);
        shapes.push(chartFrameXml(nextId++, o, rid));
        return;
      }
      const opts = {
        size: at(o.size), font, bold: o.bold, italic: o.italic,
        colour: o.colour || (o.kind === 'shape' && o.fill ? 'FFFFFF' : ''),
        align: o.align, bullet: false
      };
      shapes.push(textBox(nextId++, o.kind === 'shape' ? '圖案' : '文字方塊', {
        x: pctX(o.x), y: pctY(o.y), cx: pctX(o.w), cy: pctY(o.h)
      }, paras(o.text || '', opts), {
        geom: o.kind === 'shape' ? (PPT_SHAPES[o.shape] || 'rect') : 'rect',
        fill: o.kind === 'shape' ? (o.fill || '') : (o.fill || undefined),
        stroke: o.stroke, valign: o.valign
      }));
    });

    const notes = String(s.notes || '').trim();
    if (notes) {
      const nrid = 'rId' + nextRel++;
      rels.push(`<Relationship Id="${nrid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${notesParts.length + 1}.xml"/>`);
      notesParts.push({ slide: i + 1, xml: notes });
    }

    slideParts.push(XML_DECL +
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:cSld><p:spTree>' +
      '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
      '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
      shapes.join('') +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');
    slideRels.push(XML_DECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join('') + '</Relationships>');
  });

  const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

  const emptyTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

  const theme = XML_DECL +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="AI-OS">' +
    '<a:themeElements><a:clrScheme name="AI-OS">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="1F3040"/></a:dk2><a:lt2><a:srgbClr val="EEF2F6"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="1F4E79"/></a:accent1><a:accent2><a:srgbClr val="2E75B6"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="548235"/></a:accent3><a:accent4><a:srgbClr val="BF8F00"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="C55A11"/></a:accent5><a:accent6><a:srgbClr val="7030A0"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="2E75B6"/></a:hlink><a:folHlink><a:srgbClr val="7030A0"/></a:folHlink>' +
    '</a:clrScheme>' +
    `<a:fontScheme name="AI-OS"><a:majorFont><a:latin typeface="${esc(font || 'Calibri Light')}"/>` +
    '<a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    `<a:minorFont><a:latin typeface="${esc(font || 'Calibri')}"/>` +
    '<a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    '<a:fmtScheme name="AI-OS">' +
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
    '<a:lnStyleLst>' +
    '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
    '</a:fmtScheme></a:themeElements></a:theme>';

  const master = XML_DECL + `<p:sldMaster ${NS_P}>` +
    `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>` +
    '<a:effectLst/></p:bgPr></p:bg>' +
    `<p:spTree>${emptyTree}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
    'hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '</p:sldMaster>';

  const layout1 = XML_DECL + `<p:sldLayout ${NS_P} type="blank" preserve="1">` +
    `<p:cSld name="空白"><p:spTree>${emptyTree}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

  /* A notes page is portrait 7.5in x 10in, and it is built out of placeholders
     rather than free boxes: the `sldImg` placeholder is what puts the slide's
     own picture at the top of the printed page, and the `body` placeholder is
     what makes the text land in the notes pane in PowerPoint instead of being a
     stray text box sitting on top of it. Both geometries are the ones PowerPoint
     itself writes, so a notes page printed from here matches one printed there. */
  const ph = (id, name, type, idx, box, extra) =>
    '<p:sp><p:nvSpPr>' +
      `<p:cNvPr id="${id}" name="${esc(name)}"/>` +
      `<p:cNvSpPr><a:spLocks noGrp="1"${extra || ''}/></p:cNvSpPr>` +
      `<p:nvPr><p:ph type="${type}"${idx === null ? '' : ` idx="${idx}"`}/></p:nvPr>` +
    '</p:nvSpPr>' +
    (box
      ? `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/>` +
        `<a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
      : '<p:spPr/>');

  const notesMaster = XML_DECL + `<p:notesMaster ${NS_P}>` +
    '<p:cSld><p:spTree>' + emptyTree +
      ph(2, '投影片圖像版面配置區 1', 'sldImg', null,
        { x: 685800, y: 1143000, cx: 5486400, cy: 3086100 }, ' noRot="1" noChangeAspect="1"') +
      '</p:sp>' +
      ph(3, '備忘稿版面配置區 2', 'body', 1,
        { x: 685800, y: 4400550, cx: 5486400, cy: 3600450 }) +
      '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" ' +
        'rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>' +
        '<a:p><a:endParaRPr lang="zh-TW"/></a:p></p:txBody></p:sp>' +
    '</p:spTree></p:cSld>' +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" ' +
    'hlink="hlink" folHlink="folHlink"/>' +
    '<p:notesStyle>' +
      Array.from({ length: 9 }, (_, i) =>
        `<a:lvl${i + 1}pPr marL="${i * 457200}" algn="l" rtl="0">` +
        '<a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
        '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>' +
        `</a:defRPr></a:lvl${i + 1}pPr>`).join('') +
    '</p:notesStyle></p:notesMaster>';

  const sldIds = slides.map((_, i) =>
    `<p:sldId id="${256 + i}" r:id="rId${2 + i}"/>`).join('');
  const presentation = XML_DECL + `<p:presentation ${NS_P} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    (notesParts.length
      ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${2 + slides.length}"/></p:notesMasterIdLst>`
      : '') +
    `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
    /* The notes page is a portrait sheet of paper, not the slide turned on its
       side: 7.5in by 10in, whatever shape the slides are. */
    `<p:sldSz cx="${EMU_W}" cy="${EMU_H}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    '</p:presentation>';

  const presRels = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
  ].concat(slides.map((_, i) =>
    `<Relationship Id="rId${2 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`));
  if (notesParts.length) {
    presRels.push(`<Relationship Id="rId${2 + slides.length}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>`);
  }
  presRels.push(`<Relationship Id="rId${2 + slides.length + (notesParts.length ? 1 : 0)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>`);

  const seenExt = new Set(media.map((m) => m.name.split('.').pop()));
  const contentTypes = XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    [...seenExt].map((e) => {
      const mime = (media.find((m) => m.name.endsWith('.' + e)) || {}).mime || 'image/png';
      return `<Default Extension="${e}" ContentType="${mime}"/>`;
    }).join('') +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    (notesParts.length
      ? '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      : '') +
    slides.map((_, i) =>
      `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('') +
    chartParts.map((c) =>
      `<Override PartName="/ppt/charts/${c.name}" ContentType="${chartxml.CHART_CONTENT_TYPE}"/>`).join('') +
    (notesParts.length
      ? '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>' +
        notesParts.map((_, i) =>
          `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join('')
      : '') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = XML_DECL +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(deck.title || '簡報')}</dc:title>` +
    '<cp:lastModifiedBy>AI-OS</cp:lastModifiedBy>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    '</cp:coreProperties>';

  const app = XML_DECL +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>AI-OS</Application>' +
    `<Slides>${slides.length}</Slides><Words>0</Words>` +
    '</Properties>';

  const parts = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': XML_DECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>',
    'docProps/core.xml': core,
    'docProps/app.xml': app,
    'ppt/presentation.xml': presentation,
    'ppt/_rels/presentation.xml.rels': XML_DECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      presRels.join('') + '</Relationships>',
    'ppt/theme/theme1.xml': theme,
    'ppt/slideMasters/slideMaster1.xml': master,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': XML_DECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
      '</Relationships>',
    'ppt/slideLayouts/slideLayout1.xml': layout1,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': XML_DECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
      '</Relationships>'
  };

  slideParts.forEach((xml, i) => { parts[`ppt/slides/slide${i + 1}.xml`] = xml; });
  slideRels.forEach((xml, i) => { parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = xml; });
  media.forEach((m) => { parts['ppt/media/' + m.name] = m.buffer; });
  chartParts.forEach((c) => { parts['ppt/charts/' + c.name] = c.xml; });

  if (notesParts.length) {
    parts['ppt/notesMasters/notesMaster1.xml'] = notesMaster;
    /* Its own theme part, not the presentation's. Two masters pointing at one
       theme is the single thing that made PowerPoint refuse to open the file at
       all -- every other feature here opened cleanly, and a deck with one line
       of speaker notes did not. */
    parts['ppt/theme/theme2.xml'] = theme;
    parts['ppt/notesMasters/_rels/notesMaster1.xml.rels'] = XML_DECL +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme2.xml"/>' +
      '</Relationships>';
    notesParts.forEach((n, i) => {
      parts[`ppt/notesSlides/notesSlide${i + 1}.xml`] = XML_DECL + `<p:notes ${NS_P}>` +
        '<p:cSld><p:spTree>' + emptyTree +
        ph(2, '投影片圖像版面配置區 1', 'sldImg', null, null,
          ' noRot="1" noChangeAspect="1"') + '</p:sp>' +
        ph(3, '備忘稿版面配置區 2', 'body', 1, null) +
        '<p:txBody><a:bodyPr/><a:lstStyle/>' +
        paras(n.xml, { size: 12, font, bullet: false }) + '</p:txBody></p:sp>' +
        '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
      parts[`ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`] = XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/>' +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${n.slide}.xml"/>` +
        '</Relationships>';
    });
  }

  return {
    buffer: zip.write(parts, { store: ['[Content_Types].xml'] }),
    warnings
  };
}

/* ###########################################################################
   markdown bridge
   ######################################################################### */

/**
 * Blocks -> Markdown. Used for export and for showing a document to the model.
 * Consecutive list items are joined with a single newline: a blank line between
 * them is valid Markdown but renders as separate lists in most viewers.
 */
function blocksToMarkdown(blocks) {
  const parts = (blocks || []).map((b) => {
    if (b.type === 'heading') return '#'.repeat(Math.min(6, b.level || 1)) + ' ' + (b.text || '');
    if (b.type === 'list') return (b.ordered ? '1. ' : '- ') + (b.text || '');
    if (b.type === 'quote') return '> ' + (b.text || '');
    if (b.type === 'table') {
      const rows = b.rows || [];
      if (!rows.length) return '';
      const head = '| ' + rows[0].join(' | ') + ' |';
      const sep = '| ' + rows[0].map(() => '---').join(' | ') + ' |';
      const rest = rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |');
      return [head, sep, ...rest].join('\n');
    }
    /* Markdown has no page break, so it gets an HTML comment -- invisible in
       every renderer and recognised again by the reader, which is better than
       dropping the break or borrowing `---` from the thematic rule. */
    if (b.type === 'break') return '<!-- pagebreak -->';
    /* Nor a chart. It becomes its data as a table under a comment that says
       what the table was drawn as: every renderer shows the numbers, and the
       reader turns the pair back into a chart. */
    if (b.type === 'chart') {
      const spec = charts.norm(b.chart);
      const meta = {
        type: spec.type, title: spec.title, legend: spec.legend, labels: spec.labels,
        numFmt: spec.numFmt, xTitle: spec.xTitle, yTitle: spec.yTitle,
        colours: spec.series.map((s) => s.colour || '')
      };
      if (Number(b.aspect) > 0) meta.aspect = Number(b.aspect);
      const cell = (c) => String(c == null ? '' : c).replace(/\|/g, '\\|');
      const rows = charts.toRows(spec);
      const head = '| ' + rows[0].map(cell).join(' | ') + ' |';
      const sep = '| ' + rows[0].map(() => '---').join(' | ') + ' |';
      const rest = rows.slice(1).map((r) => '| ' + r.map(cell).join(' | ') + ' |');
      // A comment ends at the first `-->`, so the JSON may hold no double dash.
      return '<!-- chart ' + JSON.stringify(meta).replace(/--/g, '-\\u002d') + ' -->\n' +
        [head, sep, ...rest].join('\n');
    }
    if (Array.isArray(b.runs) && b.runs.length) {
      return b.runs.map((r) => {
        let t = r.text || '';
        /* Code first: what is inside a backtick span is literal, so wrapping it
           in asterisks afterwards would show the asterisks. Strikethrough is
           GitHub's extension and widely enough understood to use. Underline,
           super/subscript, colour and highlight have no Markdown at all and are
           dropped -- an export to a plain-text format loses what the format
           cannot say, and inventing HTML tags here would make the file no longer
           plain text. */
        if (r.code) return '`' + t + '`';
        if (r.bold) t = '**' + t + '**';
        if (r.italic) t = '*' + t + '*';
        if (r.strike) t = '~~' + t + '~~';
        return t;
      }).join('');
    }
    return b.text || '';
  });

  let out = '';
  (blocks || []).forEach((b, i) => {
    if (i > 0) {
      const prev = blocks[i - 1];
      const bothList = prev.type === 'list' && b.type === 'list';
      out += bothList ? '\n' : '\n\n';
    }
    out += parts[i];
  });
  return out;
}

/** Markdown -> blocks. Handles the subset blocksToMarkdown produces. */
function markdownToBlocks(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let table = null;
  let pendingChart = null;   // a chart comment waiting for the table under it

  const flushPara = () => {
    if (!para.length) return;
    blocks.push({ type: 'para', runs: inlineRuns(para.join(' ')), text: para.join(' ') });
    para = [];
  };
  const flushTable = () => {
    if (table && table.length) {
      if (pendingChart) {
        /* The table under a chart comment is the chart's data, read the way
           the editors read a table into a chart. */
        const got = charts.fromRows(table);
        const spec = charts.norm(Object.assign({}, pendingChart, { categories: got.categories, series: got.series }));
        if (Array.isArray(pendingChart.colours)) {
          spec.series.forEach((s, k) => { if (pendingChart.colours[k]) s.colour = pendingChart.colours[k]; });
        }
        const block = { type: 'chart', chart: charts.norm(spec) };
        if (Number(pendingChart.aspect) > 0) block.aspect = Number(pendingChart.aspect);
        blocks.push(block);
      } else {
        blocks.push({ type: 'table', rows: table });
      }
    } else if (pendingChart) {
      blocks.push({ type: 'chart', chart: charts.norm(pendingChart) });
    }
    table = null;
    pendingChart = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (/^\s*<!--\s*pagebreak\s*-->\s*$/i.test(line)) {
      flushPara();
      flushTable();
      blocks.push({ type: 'break' });
      continue;
    }

    const chartMark = /^\s*<!--\s*chart\s+(\{[\s\S]*\})\s*-->\s*$/i.exec(line);
    if (chartMark) {
      flushPara();
      flushTable();
      try { pendingChart = JSON.parse(chartMark[1]); } catch (e) { pendingChart = null; }
      if (pendingChart && typeof pendingChart !== 'object') pendingChart = null;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      // A cell may hold an escaped pipe, which the chart writer emits for a
      // label that contains one; it is not a column boundary.
      const cells = line.trim().replace(/^\||\|$/g, '').replace(/\\\|/g, '\u0000')
        .split('|').map((c) => c.trim().replace(/\u0000/g, '|'));
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;   // separator row
      (table = table || []).push(cells);
      continue;
    }
    flushTable();

    if (!line.trim()) { flushPara(); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) { flushPara(); blocks.push({ type: 'list', ordered: false, text: ul[1].trim() }); continue; }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { flushPara(); blocks.push({ type: 'list', ordered: true, text: ol[1].trim() }); continue; }

    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flushPara(); blocks.push({ type: 'quote', text: q[1].trim() }); continue; }

    para.push(line.trim());
  }
  flushPara();
  flushTable();
  return blocks;
}

/**
 * Inline Markdown to runs.
 *
 * Backticks are matched first and their contents are not scanned again: a
 * `*pointer` inside code is a literal asterisk, and treating it as emphasis is
 * the classic way a code sample comes out mangled.
 */
function inlineRuns(text) {
  const runs = [];
  /* The image rule comes before the emphasis rules and after code, for the same
     reason code comes first: whatever matches first wins, and a URL is full of
     characters the later rules would eat. Without it `![圖](https://a/b_c.png)`
     reached Word as literal text with `_c.png)` in italics -- the underscore
     read as emphasis -- which is worse than either a picture or a placeholder. */
  const re = /(`+)([\s\S]+?)\1|!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|(~~)(.+?)\5|(\*\*|__)(.+?)\7|(\*|_)(.+?)\9/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[2] !== undefined) runs.push({ text: m[2], code: true });
    /* Where a picture was. A .docx cannot carry one from here -- writeDocx has
       no media part -- so it says so, in the same words the PDF uses, rather
       than printing the address of a file the reader cannot see. */
    else if (m[4] !== undefined) runs.push({ text: '［圖片' + (m[3] ? '：' + m[3] : '') + '］' });
    else if (m[6] !== undefined) runs.push({ text: m[6], strike: true });
    else if (m[8] !== undefined) runs.push({ text: m[8], bold: true });
    else runs.push({ text: m[10], italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}

/* ###########################################################################
   csv
   ######################################################################### */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  /* A byte-order mark, dropped rather than parsed. Every CSV Excel writes for a
     non-Latin locale starts with one, and left in place it becomes part of the
     first column's name -- so a file exported from Excel and read back here has
     a header called "﻿姓名" that no template ever matches. */
  const s = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Rows -> CSV, with a byte-order mark.
 *
 * The BOM is the difference between a file that opens and a file that does not.
 * A `.csv` is bytes with no declared encoding, so Excel guesses from the system
 * codepage -- CP950 on a Traditional Chinese Windows -- and UTF-8 Chinese comes
 * out as 「憪?」. Measured, opening the same bytes both ways: 「姓名,部門」 read
 * back as 「憪?」 without the mark and 「姓名」 with it. Notepad++ sniffs the
 * content and was right either way, which is exactly how this stays unnoticed.
 *
 * Everything that reads CSV here strips a leading mark (see parseCsv), so the
 * round trip is unaffected, and a file exported from Excel now reads correctly
 * too -- that direction was broken in the same place for the same reason.
 */
function toCsv(rows) {
  return '﻿' + (rows || []).map((r) => (r || []).map((cell) => {
    const s = cell == null ? '' : String(cell);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

module.exports = {
  readDocx, writeDocx,
  readXlsx, writeXlsx,
  writePptx,
  blocksToMarkdown, markdownToBlocks,
  parseCsv, toCsv,
  colToIndex, indexToCol,
  readSheetCharts
};
