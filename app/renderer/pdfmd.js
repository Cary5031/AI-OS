/* ===========================================================================
   AI-OS // PDF to Markdown
   ---------------------------------------------------------------------------
   Runs inside the aios-pdf:// viewer document, next to pdf.js, because that is
   where the two things this needs already are: text with coordinates, and pages
   drawn on a canvas.

   WHY CONVERT AT ALL

   The extractor in main/pdf.js gives the model a flat wall of text. Headings,
   lists and tables are structure the model can use, and they are all still
   present in the PDF -- as font sizes and x positions rather than as markup. So
   this reads the geometry back out and writes Markdown.

   WHAT IT HONESTLY CANNOT DO

   Markdown has no page geometry, no columns and no absolute positions, so this
   is a reflow, not a reproduction. A two-column paper comes out as one column.
   A table whose cells wrap onto several lines comes out as several rows. A page
   with no text layer -- a scan -- comes out as one image and a note saying so,
   because there is no OCR on this machine.

   Table detection is deliberately timid. Guessing wrong turns a readable page
   into a grid of nonsense, so a run of lines has to agree on its column edges
   before it is treated as a table at all; anything less confident stays as text.

   HOW IMAGES GET OUT

   Not by decoding them. A PDF can carry JPEG, JPEG 2000, CCITT G3/G4, JBIG2 and
   raw Flate samples in half a dozen colour spaces, and main/pdf.js returns an
   empty buffer for every one of them. pdf.js has already solved all of it, so
   the page is rendered and the image's placement rectangle is cropped back out
   of the canvas. Every codec is handled for free, and so is a scan.
   =========================================================================== */

/* Render scale for cropping. 2x keeps a diagram legible without making a
   full-page scan enormous. */
const IMAGE_SCALE = 2;

/* Below this, an "image" is a rule, a spacer or a bullet glyph, and linking to it
   is worse than leaving it out. */
const MIN_IMAGE_PX = 24;
const MIN_IMAGE_AREA = 0.003;      // fraction of the page

/* Above this, it is a photo or a scan, and PNG would be several times larger for
   no visible gain. */
const PHOTO_AREA = 0.3;

/* A line this much taller than the body text is a heading. Below it, a larger
   size is more likely emphasis inside a paragraph. */
const HEADING_MIN = 1.15;
const HEADING_MAX_CHARS = 120;

/* A vertical gap this much larger than the document's own line pitch ends a
   paragraph. Measured rather than assumed: a fixed multiple of the font size
   broke every line of a 1.5-spaced document into its own paragraph, because the
   leading was already wider than the threshold. */
const PARA_GAP = 1.45;

/* Bullet glyphs, including the private-use area.
   That range is not a guess: a subset of Wingdings or Symbol maps its glyphs into
   U+E000..U+F8FF, and a document using those for its bullets arrives with
   U+F076 and U+F06C where the markers should be. Without them in this list the
   whole line reads as prose, the structure is lost, and the reader gets a row of
   tofu boxes for characters no installed font can draw. */
const PUA = /[\ue000-\uf8ff]/;
const PUA_ALL = /[\ue000-\uf8ff]/g;
const BULLET = /^[\u2022\u2023\u25aa\u25ab\u25e6\u2043\u2219\u00b7\u25cf\u25cb\u25a0\u25a1\u25c6\u25c7\u2756\u276f\u27a4\u2714\u2713\ue000-\uf8ff*+-]\s*/;
/* An ordered marker, ending either in whitespace or straight into CJK.
   The CJK alternative is not cosmetic: collapse() removes the space between a
   fullwidth stop and the character after it, so "1．結合" arrives with nothing
   between the marker and the text, and requiring whitespace turned every numbered
   list back into paragraphs. The lookahead still refuses "1.5", because a digit is
   not CJK. */
const ORDERED = /^(\d{1,3}|[\uff10-\uff19]{1,3}|[ivxlcdm]{1,6}|[a-z]|[\u2460-\u2473])\s*[.)\u3001\uff09\uff0e](\s+|(?=[\u2e80-\u9fff\uf900-\ufaff]))/i;
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const SENTENCE_END = /[.!?:;\u3002\uff01\uff1f\uff1a\uff1b\u201d\u2019)\uff09]\s*$/;

/**
 * Convert a loaded pdf.js document to Markdown.
 *
 * `withImages` off skips rendering entirely, which is the difference between a
 * couple of hundred milliseconds and a couple of minutes on a long document. The
 * model only ever needs the text, so that is the mode used when feeding it.
 */
export async function convert(pdfjs, doc, opts = {}) {
  const withImages = opts.withImages !== false;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const stem = String(opts.stem || 'pdf');
  const assetDir = stem + '.assets';

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    onProgress({ phase: 'text', page: n, of: doc.numPages });
    pages.push(await pageLines(pdfjs, doc, n));
  }

  const body = bodySize(pages);
  const pitch = linePitch(pages, body);
  const chrome = runningText(pages);

  const images = [];
  if (withImages) {
    for (let i = 0; i < pages.length; i++) {
      onProgress({ phase: 'images', page: i + 1, of: pages.length });
      // eslint-disable-next-line no-await-in-loop
      const got = await pageImages(doc, pages[i], assetDir);
      pages[i].images = got.rects;
      got.files.forEach((f) => images.push(f));
    }
  }

  const out = [];
  const meta = await docTitle(doc);
  if (meta) { out.push('# ' + escapeText(meta)); out.push(''); }

  let scanned = 0;
  for (const page of pages) {
    if (pages.length > 1) {
      out.push('');
      out.push('<!-- 第 ' + page.n + ' 頁 -->');
      out.push('');
    }

    const kept = page.lines.filter((l) => !chrome.has(l.text));
    const blocks = classify(kept, body, page, pitch);

    if (!kept.length) {
      scanned++;
      if (!withImages) {
        out.push('*（第 ' + page.n + ' 頁沒有文字圖層，可能是掃描頁；這台機器沒有 OCR。）*');
        out.push('');
        continue;
      }
    }

    emit(out, blocks, assetDir);
  }

  return {
    markdown: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n',
    images,
    assetDir,
    stats: {
      pages: pages.length,
      textlessPages: scanned,
      images: images.length,
      bodySize: +body.toFixed(2),
      linePitch: +pitch.toFixed(2),
      droppedRunningLines: chrome.size
    }
  };
}

/* ------------------------------------------------------------------ geometry -- */

/**
 * One page's text, as lines in reading order.
 *
 * Positions come from the item transform composed with the viewport, so the
 * numbers are in the same top-left, y-down space the rendered canvas uses. That
 * matters for pages with their own /Rotate: the raw text transform is in
 * unrotated user space and would sort the lines the wrong way round.
 */
async function pageLines(pdfjs, doc, n) {
  const pg = await doc.getPage(n);
  const vp = pg.getViewport({ scale: 1 });
  const tc = await pg.getTextContent();

  const parts = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string' || it.str === '') continue;
    const p = [it.transform[4], it.transform[5]];
    pdfjs.Util.applyTransform(p, vp.transform);
    const h = Math.abs(it.height) || Math.hypot(it.transform[2], it.transform[3]) || 10;
    parts.push({ x: p[0], y: p[1], w: Math.abs(it.width) || 0, h, str: it.str });
  }

  parts.sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const lines = layout(parts, vp.width);

  for (const line of lines) {
    line.parts.sort((a, b) => a.x - b.x);
    line.x = line.parts[0].x;
    const last = line.parts[line.parts.length - 1];
    line.x1 = last.x + last.w;
    line.text = joinParts(line.parts);
    line.chars = line.text.length;
    line.cells = splitCells(line.parts);
  }

  return { n, lines, width: vp.width, height: vp.height, page: pg, images: [] };
}

/**
 * Turn glyph runs into lines, in reading order, columns first.
 *
 * The order of these two steps is the whole trick, and getting it backwards is
 * what defeated three earlier attempts at column handling. Grouping by baseline
 * first destroys the evidence: a two-column layout usually aligns its baselines
 * across the gutter, so the left and right columns merge into single lines and no
 * amount of later analysis can pull them apart. Splitting on the gutter while the
 * runs are still loose keeps each column's baselines to itself.
 *
 * Runs that straddle the gutter -- a heading over both columns, a full-width
 * footer -- are neither column. They end the current pair and start a new one, so
 * a page that alternates between one and two columns still reads in order.
 */
function layout(parts, pageWidth) {
  const gutter = parts.length >= 8 ? findGutter(parts, pageWidth) : null;
  if (!gutter) return group(parts);

  const out = [];
  let left = [];
  let right = [];

  const flush = () => {
    group(left).forEach((l) => out.push(l));
    group(right).forEach((l) => out.push(l));
    left = [];
    right = [];
  };

  for (const part of parts) {
    if (part.x < gutter.x0 && part.x + part.w > gutter.x1) {
      flush();
      group([part]).forEach((l) => out.push(l));
    } else if (part.x + part.w <= gutter.x1) {
      left.push(part);
    } else {
      right.push(part);
    }
  }
  flush();
  return out;
}

/**
 * Group runs sharing a baseline into one line.
 *
 * The tolerance is a fraction of the glyph height rather than a constant:
 * superscripts and mixed sizes on one line sit slightly off the baseline, and a
 * fixed threshold either splits them off or swallows the next line.
 */
function group(parts) {
  const lines = [];
  for (const part of parts) {
    const last = lines[lines.length - 1];
    const tol = Math.max(2, part.h * 0.5);
    if (last && Math.abs(part.y - last.y) <= tol) {
      last.parts.push(part);
      last.y = (last.y * (last.parts.length - 1) + part.y) / last.parts.length;
      last.h = Math.max(last.h, part.h);
    } else {
      lines.push({ y: part.y, h: part.h, parts: [part] });
    }
  }
  return lines;
}

/**
 * The widest unused vertical band near the middle of the page, if convincing.
 *
 * Refuses to act without evidence: the gap has to be in the middle of the page,
 * wide enough to be deliberate, and have real content on both sides. A page of
 * full-width prose covers every horizontal position and produces no candidate.
 */
function findGutter(parts, pageWidth) {
  const BUCKETS = 120;
  const used = new Array(BUCKETS).fill(0);

  for (const p of parts) {
    const from = Math.max(0, Math.floor((p.x / pageWidth) * BUCKETS));
    const to = Math.min(BUCKETS - 1, Math.ceil(((p.x + p.w) / pageWidth) * BUCKETS));
    for (let i = from; i <= to; i++) used[i]++;
  }

  // Only the middle can hold a gutter: the margins are empty too, and they are
  // not a column break.
  const lo = Math.floor(BUCKETS * 0.25);
  const hi = Math.ceil(BUCKETS * 0.75);

  const empty = [];
  let run = null;
  for (let i = lo; i <= hi; i++) {
    if (!used[i]) {
      if (!run) { run = { from: i, to: i }; empty.push(run); } else run.to = i;
    } else {
      run = null;
    }
  }
  if (!empty.length) return null;

  empty.sort((a, b) => (b.to - b.from) - (a.to - a.from));
  const best = empty[0];
  const width = ((best.to - best.from + 1) / BUCKETS) * pageWidth;
  if (width < pageWidth * 0.03) return null;

  /* One gap means columns; several mean cells.
     A three-column table has two inter-column gaps of similar width, and treating
     the widest as a page gutter split the table's last column off into its own
     block. Bailing out here is the safe direction: missing a real gutter leaves
     the columns interleaved, which is untidy, while a false one reorders content
     that was never in columns. */
  const rival = empty[1];
  if (rival && (rival.to - rival.from) >= (best.to - best.from) * 0.6) return null;

  const x0 = (best.from / BUCKETS) * pageWidth;
  const x1 = ((best.to + 1) / BUCKETS) * pageWidth;

  let l = 0;
  let r = 0;
  for (const p of parts) {
    if (p.x < x0 && p.x + p.w > x1) continue;        // straddles it: neither side
    if (p.x + p.w <= x1) l++; else r++;
  }
  if (l < 3 || r < 3) return null;

  return { x0, x1 };
}

/**
 * Join a line's glyph runs into text.
 *
 * pdf.js already pads CJK runs with spaces derived from advance widths, and the
 * gaps between runs mean different things in Latin and CJK typesetting, so the
 * decision is made per boundary rather than by always inserting a separator.
 */
function joinParts(parts) {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i > 0) {
      const prev = parts[i - 1];
      const gap = p.x - (prev.x + prev.w);
      const a = out.slice(-1);
      const b = p.str.slice(0, 1);
      const wide = gap > p.h * 0.22;
      // No space between CJK glyphs: the gap is typesetting, not a word break.
      if (wide && !(CJK.test(a) && CJK.test(b)) && !/\s$/.test(out) && !/^\s/.test(p.str)) {
        out += ' ';
      }
    }
    out += p.str;
  }
  return collapse(out);
}

/**
 * Tidy a line of joined text.
 *
 * pdf.js derives spacing from glyph advances, and for CJK that produces a space
 * between every character: 本 課 程 for 本課程. Dropping a space only when both of
 * its neighbours are CJK leaves ordinary mixed text -- FAX TO, Microsoft MVP --
 * spaced as written.
 */
function collapse(s) {
  let out = String(s || '').replace(/\s+/g, ' ');
  // Twice: in 本 課 程 the first pass consumes the space after 本, and the space
  // before 程 needs the already-joined 課 as its left neighbour.
  for (let i = 0; i < 2; i++) {
    out = out.replace(
      /([\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]) +(?=[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef])/g,
      '$1');
  }
  return out.trim();
}

/**
 * Split a line where the gaps are wide enough to be column separators.
 *
 * Used only as evidence for table detection. A line that is simply
 * widely-tracked prose will produce cells too, which is why a single line is
 * never enough to call something a table.
 */
function splitCells(parts) {
  const cells = [];
  let cur = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const prev = parts[i - 1];
    const gap = prev ? p.x - (prev.x + prev.w) : 0;
    if (!cur || gap > p.h * 1.4) {
      cur = { x: p.x, parts: [p] };
      cells.push(cur);
    } else {
      cur.parts.push(p);
    }
  }
  return cells.map((c) => ({ x: c.x, text: joinParts(c.parts) })).filter((c) => c.text);
}

/**
 * The document's own line spacing: the median gap between consecutive lines.
 *
 * This is what a paragraph break has to be measured against. Leading varies from
 * 1.1x the font size to well past 2x depending on who made the document, so any
 * fixed multiple of the font size is wrong for most of them -- too small and every
 * line becomes its own paragraph, too large and separate paragraphs run together.
 *
 * The median ignores the outliers that matter here: headings, the big jumps around
 * figures, and the wrap-around from the bottom of one column to the top of the
 * next.
 */
function linePitch(pages, body) {
  const gaps = [];
  for (const p of pages) {
    for (let i = 1; i < p.lines.length; i++) {
      const d = p.lines[i].y - p.lines[i - 1].y;
      if (d > 0.2 && d < body * 4) gaps.push(d);
    }
  }
  if (!gaps.length) return body * 1.3;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || body * 1.3;
}

/** The text height that covers the most characters: the body font. */
function bodySize(pages) {
  const weight = new Map();
  for (const p of pages) {
    for (const line of p.lines) {
      const key = Math.round(line.h * 2) / 2;
      weight.set(key, (weight.get(key) || 0) + line.chars);
    }
  }
  let best = 10;
  let most = -1;
  for (const [size, chars] of weight) {
    if (chars > most) { most = chars; best = size; }
  }
  return best || 10;
}

/**
 * Lines that are page furniture rather than content.
 *
 * A running head repeated on every page is noise in a document and actively
 * harmful in a model's context, where it can be read as if it mattered. Only the
 * top and bottom bands are considered, and a line has to recur before it counts,
 * so a heading that happens to sit near the top of one page survives.
 */
function runningText(pages) {
  if (pages.length < 2) return new Set();

  const seen = new Map();
  for (const p of pages) {
    const top = p.height * 0.12;
    const bottom = p.height * 0.88;
    for (const line of p.lines) {
      if (line.y > top && line.y < bottom) continue;
      if (!line.text || line.text.length > 200) continue;
      const key = line.text.replace(/\d+/g, '#');   // page numbers vary
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(line.text);
    }
  }

  const need = Math.max(2, Math.ceil(pages.length * 0.6));
  const drop = new Set();
  for (const [, texts] of seen) {
    if (texts.length >= need) texts.forEach((t) => drop.add(t));
  }
  return drop;
}

/* -------------------------------------------------------------------- images -- */

/**
 * Crop this page's images out of a rendered canvas.
 *
 * pdf.js reports where it drew each image as three corners of a parallelogram,
 * normalised to the canvas. Only the axis-aligned bounding box is used: a rotated
 * photo is saved upright-boxed rather than deskewed, which is the right trade for
 * something a reader is going to look at inline.
 */
async function pageImages(doc, page, assetDir) {
  const pg = page.page;
  const vp = pg.getViewport({ scale: IMAGE_SCALE });

  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false });

  try {
    await pg.render({
      canvasContext: ctx,
      viewport: vp,
      background: '#ffffff',
      recordImages: true
    }).promise;
  } catch {
    canvas.width = 0;
    canvas.height = 0;
    return { rects: [], files: [] };
  }

  const coords = pg.imageCoordinates;
  const rects = [];
  const pageArea = canvas.width * canvas.height;

  if (coords && coords.length >= 6) {
    for (let i = 0; i + 5 < coords.length; i += 6) {
      const xs = [coords[i], coords[i + 2], coords[i + 4]];
      const ys = [coords[i + 1], coords[i + 3], coords[i + 5]];
      // The fourth corner of the parallelogram, so a rotated image is not clipped.
      xs.push(xs[1] + xs[2] - xs[0]);
      ys.push(ys[1] + ys[2] - ys[0]);

      const x0 = Math.max(0, Math.min(...xs) * canvas.width);
      const x1 = Math.min(canvas.width, Math.max(...xs) * canvas.width);
      const y0 = Math.max(0, Math.min(...ys) * canvas.height);
      const y1 = Math.min(canvas.height, Math.max(...ys) * canvas.height);

      const w = Math.round(x1 - x0);
      const h = Math.round(y1 - y0);
      if (w < MIN_IMAGE_PX || h < MIN_IMAGE_PX) continue;
      if ((w * h) / pageArea < MIN_IMAGE_AREA) continue;

      rects.push({ x: Math.round(x0), y: Math.round(y0), w, h });
    }
  }

  // A scan has no text and often no recorded image either, because the page is
  // one big painted bitmap that pdf.js may draw in pieces. Falling back to the
  // whole page keeps the content rather than losing it to a heuristic.
  if (!rects.length && !page.lines.length) {
    rects.push({ x: 0, y: 0, w: canvas.width, h: canvas.height, whole: true });
  }

  const files = [];
  const merged = dedupe(rects);
  for (let k = 0; k < merged.length; k++) {
    const r = merged[k];
    const photo = (r.w * r.h) / pageArea >= PHOTO_AREA;
    const name = 'p' + page.n + '-' + (k + 1) + (photo ? '.jpg' : '.png');

    const cut = document.createElement('canvas');
    cut.width = r.w;
    cut.height = r.h;
    cut.getContext('2d', { alpha: false }).drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);

    r.name = name;
    r.href = assetDir + '/' + name;
    files.push({
      name,
      page: page.n,
      dataUrl: photo ? cut.toDataURL('image/jpeg', 0.85) : cut.toDataURL('image/png')
    });

    cut.width = 0;
    cut.height = 0;
  }

  canvas.width = 0;
  canvas.height = 0;
  return { rects: merged, files };
}

/**
 * Drop rectangles that sit inside another.
 *
 * A single visual figure is often painted as a stack -- a background, a mask, the
 * picture -- and each paint is recorded separately. Saving all of them would put
 * three near-identical images in the document.
 */
function dedupe(rects) {
  const sorted = rects.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h));
  const kept = [];
  for (const r of sorted) {
    const inside = kept.some((k) =>
      r.x >= k.x - 2 && r.y >= k.y - 2 &&
      r.x + r.w <= k.x + k.w + 2 && r.y + r.h <= k.y + k.h + 2);
    if (!inside) kept.push(r);
  }
  return kept.sort((a, b) => a.y - b.y || a.x - b.x);
}

async function docTitle(doc) {
  try {
    const md = await doc.getMetadata();
    const t = md && md.info && md.info.Title;
    return t && String(t).trim() ? String(t).trim() : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- classification -- */

/**
 * Turn a page's lines into blocks, interleaving its images by vertical position.
 */
function classify(lines, body, page, pitch) {
  const gapLimit = Math.max(body * 0.6, pitch * PARA_GAP);
  const blocks = [];
  const tables = findTables(lines, body);
  const inTable = new Set();
  for (const t of tables) for (const i of t.rows) inTable.add(i);

  const left = lines.length ? Math.min(...lines.map((l) => l.x)) : 0;
  let para = null;

  const flush = () => { if (para) { blocks.push(para); para = null; } };

  for (let i = 0; i < lines.length; i++) {
    const table = tables.find((t) => t.rows[0] === i);
    if (table) {
      flush();
      blocks.push({ t: 'table', y: lines[i].y, table, lines });
      continue;
    }
    if (inTable.has(i)) continue;

    const line = lines[i];
    const prev = lines[i - 1];
    const ratio = line.h / body;

    /* A row of bullets set side by side on one visual line: "* A   * B". Two items
       laid out across the page are still two items, and leaving them as one
       paragraph buries the markers in the text.

       Split on the markers and keep the reading order of the line. Grouping the
       fragments by column was tried and abandoned: in this layout the left and
       right columns share their text lines, the gap between one column's last word
       and the next column's marker is not reliably wider than the gaps inside a
       column, and cell-level grouping merged unrelated fragments into single items.
       Interleaved-but-intact beats reordered-and-mangled, and the limitation is in
       the README. */
    const inlineBullets = PUA.test(line.text.slice(1)) ? line.text.split(PUA_ALL) : null;
    if (inlineBullets && inlineBullets.filter((s) => s.trim()).length > 1) {
      flush();
      const lead = inlineBullets.shift().trim();
      if (lead) blocks.push({ t: 'para', y: line.y, text: lead });
      for (const frag of inlineBullets) {
        const t = frag.trim();
        if (t) blocks.push({ t: 'item', y: line.y, ordered: false, indent: 0, text: t });
      }
      continue;
    }

    // Heading: bigger than the body, and short enough that the size is a title
    // rather than emphasis running through a paragraph.
    if (ratio >= HEADING_MIN && line.chars <= HEADING_MAX_CHARS) {
      flush();
      const level = ratio >= 1.9 ? 1 : ratio >= 1.5 ? 2 : ratio >= 1.28 ? 3 : 4;

      // A title that wraps is still one title. Two adjacent lines at the same size,
      // close together, become one heading rather than two -- otherwise every
      // two-line document title arrives as a pair of H1s.
      const above = blocks[blocks.length - 1];
      if (above && above.t === 'head' && above.level === level && prev &&
          line.y - prev.y < line.h * 1.7) {
        above.text = joinText(above.text, line.text);
        continue;
      }

      blocks.push({ t: 'head', y: line.y, level, text: line.text });
      continue;
    }

    const bullet = BULLET.exec(line.text);
    const ordered = !bullet && ORDERED.exec(line.text);
    if (bullet || ordered) {
      flush();
      const marker = bullet ? bullet[0] : ordered[0];
      blocks.push({
        t: 'item',
        y: line.y,
        ordered: !!ordered,
        indent: Math.max(0, Math.round((line.x - left) / Math.max(1, body * 1.6))),
        text: line.text.slice(marker.length).trim()
      });
      continue;
    }

    // A continuation of the previous list item: same visual block, indented past
    // the marker, no marker of its own.
    const lastBlock = blocks[blocks.length - 1];
    if (!para && lastBlock && lastBlock.t === 'item' && prev &&
        line.y - prev.y <= gapLimit && line.x > prev.x + body * 0.4) {
      lastBlock.text = joinText(lastBlock.text, line.text);
      continue;
    }

    const broke = !prev || (line.y - prev.y) > gapLimit ||
      Math.abs(line.h - prev.h) > body * 0.35 ||
      // A finished sentence followed by a fresh indent is a new paragraph even
      // when the spacing gives nothing away.
      (para && SENTENCE_END.test(para.text) && line.x > left + body * 0.9);

    if (para && !broke) {
      para.text = joinText(para.text, line.text);
    } else {
      flush();
      para = { t: 'para', y: line.y, text: line.text };
    }
  }
  flush();

  for (const img of page.images || []) {
    blocks.push({ t: 'image', y: img.y, href: img.href, page: page.n, whole: !!img.whole });
  }

  return blocks.sort((a, b) => a.y - b.y);
}

/** Join two lines of one paragraph, spacing them the way their scripts want. */
function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  const left = a.slice(-1);
  const right = b.slice(0, 1);
  // A line break inside a CJK paragraph is not a space; inside a Latin one it is.
  if (CJK.test(left) && CJK.test(right)) return a + b;
  if (/[-\u2010-\u2015]$/.test(a)) return a.slice(0, -1) + b;   // hyphenated across lines
  return a + ' ' + b;
}

/**
 * Find runs of lines that agree on their column edges.
 *
 * The agreement is what makes this safe to act on. Prose with wide tracking
 * produces cells too, but its gaps land in different places on every line, so it
 * never accumulates the matching edges a real table has.
 */
function findTables(lines, body) {
  const out = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].cells.length < 2) { i++; continue; }

    const edges = lines[i].cells.map((c) => c.x);
    const rows = [i];
    let j = i + 1;

    while (j < lines.length) {
      const line = lines[j];
      if (line.cells.length !== edges.length) break;
      if (line.y - lines[j - 1].y > body * 2.6) break;
      const aligns = line.cells.every((c, k) => Math.abs(c.x - edges[k]) <= body * 0.9);
      if (!aligns) break;
      rows.push(j);
      j++;
    }

    // Two rows of two columns is as likely to be a caption beside a figure as a
    // table. Three rows, or two rows of three columns, is evidence.
    const enough = rows.length >= 3 || (rows.length === 2 && edges.length >= 3);
    if (enough) {
      out.push({ rows, columns: edges.length });
      i = j;
    } else {
      i++;
    }
  }

  return out;
}

/* ------------------------------------------------------------------ emitting -- */

function emit(out, blocks, assetDir) {
  let lastList = null;

  for (const b of blocks) {
    if (b.t !== 'item') lastList = null;

    switch (b.t) {
      case 'head':
        out.push('');
        out.push('#'.repeat(b.level) + ' ' + escapeText(b.text));
        out.push('');
        break;

      case 'item': {
        if (lastList === null) out.push('');
        const pad = '  '.repeat(Math.min(4, b.indent));
        out.push(pad + (b.ordered ? '1. ' : '- ') + escapeText(b.text));
        lastList = b.indent;
        break;
      }

      case 'table':
        emitTable(out, b);
        break;

      case 'image':
        out.push('');
        out.push('![' + (b.whole ? '第 ' + b.page + ' 頁（掃描影像）' : '第 ' + b.page + ' 頁的圖') +
          '](' + b.href + ')');
        if (b.whole) {
          out.push('');
          out.push('*（這一頁沒有文字圖層，上面是整頁的影像；這台機器沒有 OCR，所以沒有文字可讀。）*');
        }
        out.push('');
        break;

      case 'para':
        out.push('');
        out.push(escapeText(b.text));
        out.push('');
        break;

      default:
        break;
    }
  }

  void assetDir;
}

function emitTable(out, block) {
  const rows = block.table.rows.map((i) => block.lines[i].cells.map((c) => escapeCell(c.text)));
  if (!rows.length) return;

  out.push('');
  out.push('| ' + rows[0].join(' | ') + ' |');
  out.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');
  for (let r = 1; r < rows.length; r++) out.push('| ' + rows[r].join(' | ') + ' |');
  out.push('');
}

/**
 * Keep text from being read as markup.
 *
 * Only the constructs that would change the document's shape are escaped. Going
 * further -- every asterisk and underscore, everywhere -- makes the file unreadable
 * for the person who has to look at it, and this file is meant for both.
 */
function escapeText(s) {
  return String(s || '')
    // Any private-use glyph still in the text is a symbol-font decoration whose
    // meaning died with its font. It would render as a tofu box wherever this
    // Markdown is read, so it goes.
    .replace(PUA_ALL, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^(\s*)(#{1,6})(\s)/, '$1\\$2$3')
    .replace(/^(\s*)>/, '$1\\>')
    .replace(/^(\s*)([-*+])(\s)/, '$1\\$2$3')
    .replace(/^(\s*)(\d{1,3})\.(\s)/, '$1$2\\.$3')
    .replace(/^(\s*)\|/, '$1\\|')
    .replace(/^(\s*)(={3,}|-{3,}|_{3,})\s*$/, '$1\\$2');
}

function escapeCell(s) {
  return String(s || '').replace(PUA_ALL, '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}
