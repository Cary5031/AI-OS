/* ===========================================================================
   AI-OS // PDF viewer
   ---------------------------------------------------------------------------
   Runs inside the aios-pdf:// document, framed by the PDF application. Draws
   pages with pdf.js, which is the whole reason this file exists: Chromium's
   built-in plugin viewer never composited a single pixel inside a
   WebContentsView, so the previous viewer showed an empty rectangle.

   WHAT IT CAN REACH

   Its own token and nothing else. connect-src is 'self', so the four fetches it
   makes -- the worker, a CMap, a font substitute, the document -- all land back
   on this origin. There is no `aios` bridge in here and no path parameter in the
   scheme, so a PDF that manages to run code still cannot read a second file or
   send a byte anywhere.

   HOW IT DRAWS

   Every page gets a placeholder sized to its viewport straight away, so the
   scrollbar is honest from the first frame and does not lurch while reading.
   Pages are drawn when they come near the viewport and released when they go
   well past it: an 83-page document at 150% would otherwise hold a few hundred
   megabytes of canvas, on a machine that is already sharing its card with a
   24 GB model.

   Text is a real pdf.js text layer over the canvas -- transparent, positioned
   glyph run by glyph run -- so selection and copy work and search can highlight
   in place rather than in a separate pane.
   =========================================================================== */

import * as pdfjs from './lib/pdf.mjs';
import { convert, pageLines } from './convert.js';
import * as reader from './layout.js';

/* Everything pdf.js loads at runtime, resolved against this module's own URL so
   the token is carried along. The CMaps are not optional: a CJK document whose
   fonts are not embedded renders as blank boxes without them, which was one of
   the failures this viewer had to fix. */
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.mjs', import.meta.url).href;

const LOAD_OPTS = {
  cMapUrl: new URL('./lib/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('./lib/fonts/', import.meta.url).href,
  wasmUrl: new URL('./lib/wasm/', import.meta.url).href,
  iccUrl: new URL('./lib/iccs/', import.meta.url).href,
  // The scheme handler answers with the whole file. Asking for byte ranges over
  // it would refetch the lot each time, so both partial modes are off.
  disableRange: true,
  disableStream: true
};

/* Pages this far from the viewport stay drawn; beyond it, canvases are freed. */
const KEEP = 2;
/* Pre-render this far ahead so scrolling lands on a drawn page, not a placeholder. */
const AHEAD = '600px';

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
const STEPS = [0.25, 0.35, 0.5, 0.65, 0.75, 0.9, 1, 1.15, 1.35, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6];

/* ------------------------------------------------------------------- state -- */

let doc = null;
let count = 0;
let current = 1;
let rotation = 0;          // extra rotation on top of each page's own /Rotate
let zoomMode = 'width';    // 'width' | 'page' | number
let scale = 1;
let views = [];            // index 0 unused; views[n] = { n, el, canvas, layer, task, tl, w, h }
let observer = null;
let relayouting = false;

/* Search state. `hits` is flat and ordered by page then position, which is what
   makes next/previous a single index step. `query` doubles as the token that tells
   an in-flight scan it has been superseded. */
const textCache = new Map();   // n -> { items, norm, map }
let hits = [];                 // { page, start, end } in normalised coordinates
let hitAt = -1;
let query = '';

/* ------------------------------------------------------------------- doodads -- */

const $ = (id) => document.getElementById(id);
const elPages = $('pages');
const elScroll = $('scroll');
const elVeil = $('veil');
const elNote = $('note');

let noteTimer = 0;

function note(msg, ms = 2200) {
  elNote.textContent = String(msg);
  elNote.classList.add('on');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => elNote.classList.remove('on'), ms);
}

function veil(title, text, wantPassword) {
  $('veilTitle').textContent = title;
  $('veilText').textContent = text || '';
  $('veilRow').hidden = !wantPassword;
  elVeil.classList.add('on');
  if (wantPassword) setTimeout(() => $('pw').focus(), 30);
}

function unveil() {
  elVeil.classList.remove('on');
  $('pw').value = '';
}

/* --------------------------------------------------------------- messaging -- */
/* The shell is a file:// document, so its origin serialises to "null" and an
   origin string is worth nothing here. Identity is checked instead: only the
   window that framed this one is listened to. */

function toShell(type, data) {
  try {
    window.parent.postMessage(Object.assign({ src: 'aios-pdf', type }, data || {}), '*');
  } catch { /* the shell went away; nothing to report to */ }
}

function state() {
  toShell('state', {
    page: current,
    count,
    scale: Math.round(scale * 100),
    zoomMode: typeof zoomMode === 'number' ? 'fixed' : zoomMode,
    rotation,
    hits: hits.length,
    hitAt: hitAt >= 0 ? hitAt + 1 : 0
  });
}

window.addEventListener('message', (e) => {
  if (e.source !== window.parent) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;

  switch (m.type) {
    case 'goto': goTo(Number(m.page)); break;
    case 'zoom': setZoom(m.value); break;
    case 'rotate': rotate(Number(m.by) || 90); break;
    case 'find': runFind(String(m.text || '')); break;
    case 'findNext': step(m.back ? -1 : 1); break;
    case 'print': doPrint(); break;
    case 'sidebar': toggleSide(m.on); break;
    case 'state': state(); break;
    case 'convert': runConvert(m); break;
    case 'raster': runRaster(m); break;
    case 'layout': runLayout(m); break;
    case 'pick': setPick(!!m.on); break;
    case 'box': sendBox(Number(m.page), m.id); break;
    default: break;
  }
});

/* ----------------------------------------------------------------- picking --

   Turning a click into a place on a page.

   The shell cannot do this arithmetic. It knows the page sizes the extractor
   read out of the file; it does not know the scale this viewer settled on, how
   far the user has scrolled, or which way they have turned the page since. All
   of that lives here, and pdf.js already carries the two conversions that
   matter, so a click goes out as a point on the page rather than as a pixel on
   a screen.

   TWO VIEWPORTS, ON PURPOSE. The first is the one actually drawn -- the page's
   own /Rotate plus whatever extra turn the reader has applied -- and it is what
   turns the click into PDF user space. The second is the page as the FILE
   intends it: /Rotate only, one point per unit. Converting into that one drops
   the reader's temporary rotation, which is a way of looking at the document
   and not a fact about it, and yields points from the top-left in the same
   space the overlay is laid out in. A note placed on a page turned sideways
   for reading still belongs where the words are.

   Every path out of here reports something. A shell waiting for a click it
   will never be told about is a window that has quietly stopped working.
   -------------------------------------------------------------------------- */

let picking = false;

function setPick(on) {
  picking = !!on;
  elScroll.classList.toggle('picking', picking);
}

/**
 * The page as the file intends it, at one point per unit.
 *
 * The scale divides out /UserUnit because getViewport multiplies it back in --
 * a page declaring /UserUnit 2 would otherwise report an A4 as 1190x1684 and
 * every coordinate would come out at twice its value, which is not a rounding
 * error but a different page. Rare, and used by exactly the large-format
 * drawings where a note landing in the wrong place matters most.
 */
function shownViewport(pg) {
  return pg.getViewport({ scale: 1 / (pg.userUnit || 1), rotation: (pg.rotate || 0) });
}

/** Answer the shell's question about one page's size, in points. */
async function sendBox(n, id) {
  if (!doc || !(n >= 1 && n <= count)) { toShell('box', { id, page: n, width: 0, height: 0 }); return; }
  try {
    const pg = await doc.getPage(n);
    const vp = shownViewport(pg);
    toShell('box', { id, page: n, width: vp.width, height: vp.height });
  } catch {
    toShell('box', { id, page: n, width: 0, height: 0 });
  }
}

/* Capture phase, because the text layer sits over the canvas and would
   otherwise take the click and start a selection instead. */
elPages.addEventListener('click', async (ev) => {
  if (!picking || !doc) return;
  const box = ev.target && ev.target.closest ? ev.target.closest('.page') : null;
  if (!box) return;

  ev.preventDefault();
  ev.stopPropagation();

  const n = Number(box.dataset.n) || 0;
  setPick(false);
  if (!n) { toShell('picked', { cancelled: true }); return; }

  const r = box.getBoundingClientRect();
  /* The element's own box, not the canvas's: a page that has been released is
     still laid out at the right size and can still be pointed at, and the
     canvas is styled to the CSS size rather than to its device-pixel one. */
  const ox = ev.clientX - r.left;
  const oy = ev.clientY - r.top;

  try {
    const pg = await doc.getPage(n);
    const drawn = pg.getViewport({ scale, rotation: turn(pg) });
    /* The element is laid out at a whole number of pixels (see relayout) while
       convertToPdfPoint is calibrated to the unrounded viewport, so the offset
       is rescaled by what the box actually measures. A third of a point at the
       far edge of a zoomed page -- small, and free to get right. */
    const kx = r.width > 0 ? drawn.width / r.width : 1;
    const ky = r.height > 0 ? drawn.height / r.height : 1;
    const pt = drawn.convertToPdfPoint(ox * kx, oy * ky);
    const asWritten = shownViewport(pg);
    const at = asWritten.convertToViewportPoint(pt[0], pt[1]);
    toShell('picked', {
      page: n,
      x: Math.round(at[0] * 100) / 100,
      y: Math.round(at[1] * 100) / 100,
      width: asWritten.width,
      height: asWritten.height
    });
  } catch {
    toShell('picked', { cancelled: true });
  }
}, true);

/* ---------------------------------------------------------------- converting -- */

/**
 * Turn the document into Markdown and hand it back to the shell.
 *
 * The conversion happens here because this is where pdf.js and the rendered
 * canvases are. Writing files happens in the shell because this document has no
 * bridge to write with -- which is the arrangement the isolation is for, not an
 * inconvenience to work around.
 */
async function runConvert(req) {
  if (!doc) { toShell('converted', { error: '還沒有載入文件' }); return; }

  const withImages = req.withImages !== false;
  const quiet = !!req.quiet;      // feeding the model: no veil, no images

  if (!quiet) veil('正在轉換', '讀取文字…', false);

  try {
    const result = await convert(pdfjs, doc, {
      withImages,
      stem: String(req.stem || 'pdf'),
      // Page number -> the model's transcription of a page with no text layer.
      ocr: req.ocr && typeof req.ocr === 'object' ? req.ocr : {},
      onProgress: ({ phase, page, of }) => {
        if (quiet) return;
        $('veilText').textContent = (phase === 'images' ? '算繪並裁切圖片：' : '讀取文字：') +
          '第 ' + page + ' / ' + of + ' 頁';
      }
    });

    if (!quiet) unveil();
    toShell('converted', {
      requestId: req.requestId || null,
      markdown: result.markdown,
      images: result.images,
      assetDir: result.assetDir,
      stats: result.stats
    });
  } catch (err) {
    if (!quiet) unveil();
    toShell('converted', {
      requestId: req.requestId || null,
      error: describeError(err)
    });
  }
}

/* ------------------------------------------------------------- pictures -- */

/**
 * Pages drawn as JPEG data URLs, for the model to read.
 *
 * Drawn here because the document is here: the shell holds a grant, never the
 * bytes. `edge` is the long side in pixels. 1600 reads a receipt's small print
 * and keeps a page under a megabyte, which is what one request can carry with
 * room for the answer.
 */
async function runRaster(req) {
  const id = req.requestId || null;
  if (!doc) { toShell('rastered', { requestId: id, error: '還沒有載入文件' }); return; }
  const want = (Array.isArray(req.pages) ? req.pages : []).map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= count);
  const edge = Math.min(3000, Math.max(600, Number(req.edge) || 1600));
  const quality = Math.min(0.95, Math.max(0.5, Number(req.quality) || 0.85));
  const pages = [];
  try {
    for (const n of want) {
      const pg = await doc.getPage(n);
      const at1 = pg.getViewport({ scale: 1, rotation: pg.rotate || 0 });
      const scale = Math.min(4, edge / Math.max(at1.width, at1.height));
      const vp = pg.getViewport({ scale, rotation: pg.rotate || 0 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
      pages.push({ number: n, dataUrl: canvas.toDataURL('image/jpeg', quality), w: canvas.width, h: canvas.height });
      canvas.width = 0;
      canvas.height = 0;
      pg.cleanup();
    }
    toShell('rastered', { requestId: id, pages });
  } catch (err) {
    toShell('rastered', { requestId: id, error: describeError(err) });
  }
}

/* --------------------------------------------------------------- layout -- */

/* Pixels per point when the page is drawn to read its lines back. Two keeps a
   half-point rule two pixels wide, which survives the threshold; one loses it. */
const RULE_SCALE = 2;

/**
 * One page's geometry: its text runs in points, and the lines on it.
 *
 * The runs are the converter's own (pageLines), so this and the Markdown
 * agree on what the text is. The lines are read off a drawing of the page,
 * because that is the only place a table's border exists: in the content
 * stream it is a path, and pdf.js does not hand paths out.
 */
async function pageGeometry(n) {
  const page = await pageLines(pdfjs, doc, n);
  const parts = [];
  for (const line of page.lines) {
    for (const p of line.parts) parts.push({ x: p.x, y: p.y, w: p.w, h: p.h, str: p.str });
  }
  const pg = page.page;
  const vp = pg.getViewport({ scale: RULE_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await pg.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const rules = reader.rulesFromPixels(img.data, canvas.width, canvas.height, RULE_SCALE, parts);
  canvas.width = 0;
  canvas.height = 0;
  pg.cleanup();
  return { n, parts, rules, width: page.width, height: page.height };
}

/**
 * The document as a workbook (one sheet per page) or as document blocks.
 *
 * Pages with text are read from their geometry. Pages the shell has the
 * model's OCR for -- scans -- go through the Markdown reader instead, and come
 * out as a plain grid: order and tables, not positions, because there are no
 * positions to keep.
 */
async function runLayout(req) {
  const id = req.requestId || null;
  if (!doc) { toShell('laidout', { requestId: id, error: '還沒有載入文件' }); return; }
  const kind = req.kind === 'doc' ? 'doc' : 'sheet';
  const ocr = req.ocr && typeof req.ocr === 'object' ? req.ocr : {};
  const want = Array.isArray(req.pages) && req.pages.length
    ? req.pages.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= count)
    : Array.from({ length: count }, (_, i) => i + 1);
  const quiet = !!req.quiet;
  if (!quiet) veil('正在讀版面', '讀取文字與線條…', false);

  const sheets = [];
  const blocks = [];
  const stats = { pages: 0, tables: 0, ocrPages: 0, cells: 0, merges: 0, bordered: 0 };
  try {
    for (const n of want) {
      if (!quiet) $('veilText').textContent = '讀取版面：第 ' + n + ' / ' + count + ' 頁';
      const name = '第 ' + n + ' 頁';
      const read = typeof ocr[n] === 'string' && ocr[n].trim() ? ocr[n].trim() : '';
      if (read) {
        stats.ocrPages++;
        const bl = reader.mdToBlocks(read);
        stats.tables += bl.filter((b) => b.type === 'table').length;
        if (kind === 'sheet') {
          sheets.push(reader.sheetFromBlocks(bl, name));
        } else {
          if (blocks.length) blocks.push({ type: 'break' });
          bl.forEach((b) => blocks.push(b));
        }
      } else {
        // eslint-disable-next-line no-await-in-loop
        const geometry = await pageGeometry(n);
        if (kind === 'sheet') {
          sheets.push(reader.sheetFrom(geometry, name));
        } else {
          const d = reader.docFrom(geometry);
          if (blocks.length) blocks.push({ type: 'break' });
          d.blocks.forEach((b) => blocks.push(b));
          stats.tables += d.tables;
        }
      }
      stats.pages++;
    }
    for (const s of sheets) {
      const sum = reader.summarise(s);
      stats.cells += sum.cells;
      stats.merges += sum.merges;
      stats.bordered += sum.bordered;
    }
    if (!quiet) unveil();
    toShell('laidout', Object.assign({ requestId: id, kind, stats },
      kind === 'sheet' ? { sheets } : { blocks }));
  } catch (err) {
    if (!quiet) unveil();
    toShell('laidout', { requestId: id, error: describeError(err) });
  }
}

/* ------------------------------------------------------------------ loading -- */

async function boot() {
  veil('正在載入', '解析 PDF 結構…', false);

  const task = pdfjs.getDocument(Object.assign(
    { url: new URL('./doc.pdf', import.meta.url).href }, LOAD_OPTS));

  // Encrypted files land here rather than throwing. pdf.js calls this again with
  // reason INCORRECT_PASSWORD if the first attempt is wrong.
  task.onPassword = (submit, reason) => {
    const again = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    veil('需要密碼',
      again ? '密碼不對，再試一次。' : '這份 PDF 有加密，請輸入開啟密碼。', true);
    // Leaving a rejected password in the field means the reader has to clear it
    // before they can type the next one.
    if (again) $('pw').value = '';
    const go = () => {
      const v = $('pw').value;
      if (!v) return;
      veil('正在載入', '驗證密碼…', false);
      submit(v);
    };
    $('pwGo').onclick = go;
    $('pw').onkeydown = (ev) => { if (ev.key === 'Enter') go(); };
    toShell('password', { retry: again });
  };

  task.onProgress = ({ loaded, total }) => {
    if (total) toShell('progress', { loaded, total });
  };

  try {
    doc = await task.promise;
  } catch (err) {
    const msg = describeError(err);
    veil('打不開', msg, false);
    toShell('error', { message: msg, code: err && err.name });
    return;
  }

  count = doc.numPages;
  $('count').textContent = '/ ' + count;

  await layout();
  unveil();

  loadOutline();

  let title = '';
  try {
    const md = await doc.getMetadata();
    title = (md && md.info && md.info.Title) || '';
  } catch { /* metadata is optional */ }

  toShell('ready', { count, title });
  state();
}

function describeError(err) {
  const name = err && err.name;
  if (name === 'PasswordException') return '需要密碼才能開啟，或密碼不正確。';
  if (name === 'InvalidPDFException') return '這個檔案的結構不是有效的 PDF。';
  if (name === 'MissingPDFException') return '找不到檔案，或讀取權限被撤銷了。';
  if (name === 'ResponseException') return '讀取檔案時被拒絕。';
  return (err && err.message) ? String(err.message) : '未知的錯誤。';
}

/* ------------------------------------------------------------------- layout -- */

/**
 * Work out the scale, then build or resize every page box.
 *
 * Called on load, on zoom, on rotate and on resize. Page 1's dimensions decide
 * the fit modes: sampling every page would be more correct for a document that
 * mixes portrait and landscape, and would also mean waiting for every page
 * before drawing the first one.
 */
async function layout() {
  if (!doc || relayouting) return;
  relayouting = true;

  try {
    const first = await doc.getPage(1);
    const base = first.getViewport({ scale: 1, rotation: turn(first) });

    if (zoomMode === 'width' || zoomMode === 'page') {
      // 24px of gutter either side, plus room for the scrollbar.
      const availW = Math.max(120, elScroll.clientWidth - 48);
      const availH = Math.max(120, elScroll.clientHeight - 32);
      const byW = availW / base.width;
      scale = zoomMode === 'width' ? byW : Math.min(byW, availH / base.height);
    } else {
      scale = Number(zoomMode) || 1;
    }
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

    if (!views.length) {
      views = new Array(count + 1);
      for (let n = 1; n <= count; n++) views[n] = makeBox(n);
    }

    // Sizing every page needs every page's viewport. Page 1 is known; the rest
    // are fetched as they are sized, which pdf.js serves from its own cache
    // after the first pass.
    for (let n = 1; n <= count; n++) {
      const v = views[n];
      const pg = n === 1 ? first : await doc.getPage(n);
      const vp = pg.getViewport({ scale, rotation: turn(pg) });
      v.w = Math.floor(vp.width);
      v.h = Math.floor(vp.height);
      v.el.style.width = v.w + 'px';
      v.el.style.height = v.h + 'px';
      v.el.style.setProperty('--total-scale-factor', String(scale));
      release(v);            // whatever was drawn is now the wrong size
    }

    watch();
    draw();
  } finally {
    relayouting = false;
  }
}

/** A page's own rotation plus the viewer's, normalised. */
function turn(pg) {
  return ((pg.rotate || 0) + rotation + 360) % 360;
}

function makeBox(n) {
  const el = document.createElement('div');
  el.className = 'page blank';
  el.dataset.n = String(n);

  const label = document.createElement('span');
  label.className = 'plabel';
  label.textContent = n + ' / ' + count;
  el.appendChild(label);

  elPages.appendChild(el);
  return { n, el, canvas: null, layer: null, task: null, tl: null, w: 0, h: 0 };
}

/* ------------------------------------------------------------------ drawing -- */

function watch() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(() => draw(), {
    root: elScroll,
    rootMargin: AHEAD + ' 0px'
  });
  for (let n = 1; n <= count; n++) observer.observe(views[n].el);
}

/** Draw what is near the viewport, free what is not. */
function draw() {
  if (!doc || !views.length) return;

  const top = elScroll.scrollTop;
  const bottom = top + elScroll.clientHeight;
  let seen = 0;
  let best = current;
  let bestOverlap = 0;

  for (let n = 1; n <= count; n++) {
    const v = views[n];
    const y = v.el.offsetTop - elPages.offsetTop;
    const near = y < bottom + 900 && y + v.h > top - 900;
    const far = y > bottom + 2600 || y + v.h < top - 2600;

    // Whichever page covers the most of the viewport is the one being read.
    const overlap = Math.min(bottom, y + v.h) - Math.max(top, y);
    if (overlap > bestOverlap) { bestOverlap = overlap; best = n; }

    if (near && seen < (KEEP * 2 + 3)) { render(v); seen++; } else if (far) release(v);
  }

  if (best !== current) {
    current = best;
    if (document.activeElement !== $('pageNo')) $('pageNo').value = String(current);
    state();
  }
}

async function render(v) {
  if (v.task || v.canvas) return;            // already drawing or drawn

  const mark = {};
  v.task = mark;                             // claim the slot before any await

  try {
    const pg = await doc.getPage(v.n);
    if (v.task !== mark) return;             // released while fetching

    const vp = pg.getViewport({ scale, rotation: turn(pg) });

    const canvas = document.createElement('canvas');
    // Draw at device resolution or text looks soft on a scaled display, but cap
    // it: a 400% zoom on a HiDPI screen would otherwise allocate an enormous
    // buffer for one page.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = Math.floor(vp.width) + 'px';
    canvas.style.height = Math.floor(vp.height) + 'px';

    const ctx = canvas.getContext('2d', { alpha: false });
    const task = pg.render({
      canvasContext: ctx,
      viewport: vp,
      transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
      background: '#ffffff'
    });
    v.task = task;

    await task.promise;
    if (v.task !== task) return;

    v.el.insertBefore(canvas, v.el.firstChild);
    v.el.classList.remove('blank');
    v.canvas = canvas;
    v.task = null;

    await textLayer(v, pg, vp);
    if (hits.length) paintHits(v.n);
  } catch (err) {
    v.task = null;
    // A cancelled render is the normal result of scrolling fast or zooming
    // mid-draw, not a failure worth showing anyone.
    if (err && err.name !== 'RenderingCancelledException') {
      v.el.classList.remove('blank');
      const bad = document.createElement('div');
      bad.className = 'plabel';
      bad.style.left = '6px';
      bad.style.right = 'auto';
      bad.textContent = '第 ' + v.n + ' 頁畫不出來';
      v.el.appendChild(bad);
    }
  }
}

async function textLayer(v, pg, vp) {
  const layer = document.createElement('div');
  layer.className = 'textLayer';

  const tl = new pdfjs.TextLayer({
    textContentSource: pg.streamTextContent({ includeMarkedContent: true }),
    container: layer,
    viewport: vp
  });

  try {
    await tl.render();
  } catch {
    return;                                   // no selectable text is survivable
  }
  if (!v.canvas) { tl.cancel(); return; }      // released mid-render

  v.el.appendChild(layer);
  v.layer = layer;
  v.tl = tl;
}

/** Free a page's pixels, keeping its box so the scroll height does not move. */
function release(v) {
  if (v.task && typeof v.task.cancel === 'function') {
    try { v.task.cancel(); } catch { /* already finished */ }
  }
  v.task = null;

  if (v.tl) { try { v.tl.cancel(); } catch { /* already done */ } v.tl = null; }
  if (v.layer) { v.layer.remove(); v.layer = null; }
  if (v.canvas) {
    // Zero the backing store before dropping the node: some builds hold the
    // buffer until GC notices, and these are the biggest allocations here.
    v.canvas.width = 0;
    v.canvas.height = 0;
    v.canvas.remove();
    v.canvas = null;
  }
  v.el.classList.add('blank');
}

/* --------------------------------------------------------------- navigation -- */

function goTo(n) {
  if (!count) return;
  const p = Math.min(count, Math.max(1, Math.round(Number(n) || 1)));
  current = p;
  $('pageNo').value = String(p);
  elScroll.scrollTo({ top: views[p].el.offsetTop - elPages.offsetTop - 8, behavior: 'auto' });
  draw();
  state();
}

function setZoom(value) {
  if (value === 'width' || value === 'page') zoomMode = value;
  else {
    const n = Number(value);
    if (!isFinite(n) || n <= 0) return;
    zoomMode = Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));
  }
  syncZoomSelect();
  keepPlace(layout);
}

function nudgeZoom(dir) {
  const cur = scale;
  let next = cur;
  if (dir > 0) next = STEPS.find((s) => s > cur + 0.001) || MAX_SCALE;
  else {
    const under = STEPS.filter((s) => s < cur - 0.001);
    next = under.length ? under[under.length - 1] : MIN_SCALE;
  }
  setZoom(next);
}

function syncZoomSelect() {
  const sel = $('zoom');
  const want = typeof zoomMode === 'number' ? String(zoomMode) : zoomMode;
  const has = [...sel.options].some((o) => o.value === want);
  if (!has) {
    // Show the odd value rather than lying about which mode is active.
    const o = document.createElement('option');
    o.value = want;
    o.textContent = Math.round(Number(want) * 100) + '%';
    sel.appendChild(o);
  }
  sel.value = want;
}

function rotate(by) {
  rotation = ((rotation + by) % 360 + 360) % 360;
  keepPlace(layout);
}

/** Run a relayout without losing the reader's place. */
async function keepPlace(fn) {
  const at = current;
  await fn();
  goTo(at);
}

function toggleSide(on) {
  const side = $('side');
  const next = typeof on === 'boolean' ? on : !side.classList.contains('on');
  side.classList.toggle('on', next);
  $('btnSide').classList.toggle('on', next);
  // The scroll area just changed width, so a fit mode needs recomputing.
  if (zoomMode === 'width' || zoomMode === 'page') keepPlace(layout);
}

/* ------------------------------------------------------------------ outline -- */

async function loadOutline() {
  const host = $('toc');
  host.textContent = '';

  let tree = null;
  try { tree = await doc.getOutline(); } catch { /* not all files have one */ }

  if (!tree || !tree.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = '這份文件沒有大綱。';
    host.appendChild(p);
    toShell('outline', { count: 0 });
    return;
  }

  let n = 0;
  const walk = (items, depth) => {
    for (const it of items) {
      n++;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tocItem';
      b.style.paddingLeft = (6 + depth * 12) + 'px';
      b.textContent = it.title || '(未命名)';
      b.addEventListener('click', () => jumpToDest(it.dest));
      host.appendChild(b);
      if (it.items && it.items.length) walk(it.items, depth + 1);
    }
  };
  walk(tree, 0);

  toShell('outline', { count: n });
}

/**
 * Resolve an outline destination to a page and go there.
 *
 * A destination is either an explicit array whose first element references a
 * page, or a named string that has to be looked up first.
 */
async function jumpToDest(dest) {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit.length) return;
    const idx = await doc.getPageIndex(explicit[0]);
    goTo(idx + 1);
  } catch {
    note('這個目錄項目指不到頁面');
  }
}

/* ------------------------------------------------------------------- search -- */

/**
 * A page's text, indexed so a match can be pointed back at the exact glyph runs
 * that produced it.
 *
 * `items` mirrors TextLayer.textDivs one for one. That is not a convention worth
 * assuming: pdf.js skips every content item without a `str` -- the marked-content
 * begin/end pairs, which on a real page outnumber the text items two to one --
 * and pushes neither a string nor a div for them. Building `items` from the full
 * item list instead put highlights on the wrong spans.
 *
 * `norm` is what gets searched, and it is deliberately not the same length as the
 * text: whitespace is dropped and case is folded, because pdf.js inserts spaces
 * between CJK glyphs from their advance widths, so a document reading 本課程 comes
 * out as "本 課 程" and a reader searching for 本課程 would find nothing. `map`
 * carries each normalised character back to { item, offset }, which is what makes
 * dropping characters safe.
 */
async function pageText(n) {
  if (textCache.has(n)) return textCache.get(n);

  const pg = await doc.getPage(n);
  const tc = await pg.getTextContent({ includeMarkedContent: true });

  const items = [];
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;      // marked content: no div either
    items.push(it.str);
  }

  let norm = '';
  const map = [];
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    for (let o = 0; o < s.length; o++) {
      const ch = s[o];
      if (BLANK.test(ch)) continue;
      const low = ch.toLowerCase();
      norm += low.length === 1 ? low : ch;
      map.push({ i, o });
    }
  }

  const rec = { items, norm, map };
  textCache.set(n, rec);
  return rec;
}

/* Every kind of gap pdf.js might have inserted, plus the ones a document can
   contain: ASCII space and tab, no-break space, and the ideographic space that
   turns up in CJK typesetting. */
const BLANK = /[\s\u00a0\u3000]/;

/** Fold a query the same way the page text was folded, or nothing matches. */
function normalise(s) {
  let out = '';
  for (const ch of String(s || '')) {
    if (BLANK.test(ch)) continue;
    const low = ch.toLowerCase();
    out += low.length === 1 ? low : ch;
  }
  return out;
}

/**
 * Search the whole document.
 *
 * Concurrency matters here because scanning a long document takes long enough for
 * the reader to keep typing. An earlier version bailed out when a scan was already
 * running, which silently threw the newer query away and left the box reporting
 * counts for a term the reader had already replaced. Instead every run collects
 * into its own array and checks, before committing, that it is still the current
 * query -- so a superseded scan abandons its work rather than fighting for the
 * results.
 */
async function runFind(text) {
  const q = String(text || '');
  query = q;

  // Whatever is highlighted belongs to the previous term, so it goes now rather
  // than after the new scan finishes.
  hits = [];
  hitAt = -1;
  repaintAll();

  const needle = normalise(q);
  if (!needle) { $('hits').textContent = ''; state(); return; }

  $('hits').textContent = '搜尋中';

  const found = [];
  for (let n = 1; n <= count; n++) {
    if (query !== q) return;                   // a newer query replaced this one
    const rec = await pageText(n);
    let from = 0;
    for (;;) {
      const at = rec.norm.indexOf(needle, from);
      if (at < 0) break;
      found.push({ page: n, start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }
  if (query !== q) return;

  hits = found;
  repaintAll();

  if (!hits.length) {
    $('hits').textContent = '沒有結果';
    state();
    return;
  }

  // Start from whatever is on screen rather than sending the reader to page 1.
  const near = hits.findIndex((h) => h.page >= current);
  hitAt = near < 0 ? 0 : near;
  showHit();
}

function step(dir) {
  if (!hits.length) return;
  hitAt = (hitAt + dir + hits.length) % hits.length;
  showHit();
}

/** Every drawn page, since the current-match marker moves between pages. */
function repaintAll() {
  for (let n = 1; n <= count; n++) if (views[n] && views[n].layer) paintHits(n);
}

function showHit() {
  const h = hits[hitAt];
  if (!h) return;
  $('hits').textContent = (hitAt + 1) + ' / ' + hits.length;

  const v = views[h.page];
  if (h.page !== current) goTo(h.page);

  repaintAll();

  // The page may still be drawing, in which case render() paints hits when it
  // finishes. If it is already up, scroll the marker into view.
  const marker = v.layer && v.layer.querySelector('.hit.now');
  if (marker) marker.scrollIntoView({ block: 'center', behavior: 'auto' });

  state();
}

/**
 * Wrap this page's matches in the text layer.
 *
 * Each matched character is looked up through the page's map to find the item and
 * offset it came from, then consecutive characters within one item are merged into
 * a range. Going character by character is what lets the normalised search string
 * differ in length from the text: a match that spans a space pdf.js invented, or
 * a line break, still lands on exactly the right glyphs.
 *
 * Every div is rebuilt from its cached item string rather than from the DOM, so
 * repainting is idempotent -- highlights never nest or accumulate.
 */
function paintHits(n) {
  const v = views[n];
  const rec = textCache.get(n);
  if (!v || !v.layer || !v.tl || !rec) return;

  const divs = v.tl.textDivs || [];
  const nowHit = hits[hitAt];

  const byItem = new Map();
  const add = (i, from, to, now) => {
    if (!byItem.has(i)) byItem.set(i, []);
    byItem.get(i).push({ from, to, now });
  };

  for (const h of hits) {
    if (h.page !== n) continue;
    const now = h === nowHit;

    let run = null;                 // { i, from, to } being extended
    for (let k = h.start; k < h.end && k < rec.map.length; k++) {
      const at = rec.map[k];
      if (run && run.i === at.i && run.to === at.o) { run.to = at.o + 1; continue; }
      if (run) add(run.i, run.from, run.to, now);
      run = { i: at.i, from: at.o, to: at.o + 1 };
    }
    if (run) add(run.i, run.from, run.to, now);
  }

  for (let i = 0; i < divs.length; i++) {
    const div = divs[i];
    if (!div || div.nodeName !== 'SPAN') continue;

    const ranges = byItem.get(i);
    const text = rec.items[i] || '';

    if (!ranges) {
      // Only rewrite if this div is currently marked up, or every repaint would
      // churn the whole layer.
      if (div.firstElementChild) {
        div.textContent = '';
        div.appendChild(document.createTextNode(text));
      }
      continue;
    }

    ranges.sort((a, b) => a.from - b.from);
    div.textContent = '';
    let at = 0;
    for (const r of ranges) {
      // Two hits can land on the same glyph run when one is the current match and
      // the other is not. Clamp rather than let the slices cross.
      const from = Math.max(r.from, at);
      if (r.to <= from) continue;
      if (from > at) div.appendChild(document.createTextNode(text.slice(at, from)));
      const mark = document.createElement('span');
      mark.className = r.now ? 'hit now' : 'hit';
      mark.appendChild(document.createTextNode(text.slice(from, r.to)));
      div.appendChild(mark);
      at = r.to;
    }
    if (at < text.length) div.appendChild(document.createTextNode(text.slice(at)));
  }
}

/* ------------------------------------------------------------------ printing -- */

/**
 * Print every page.
 *
 * The pages on screen are drawn lazily, so printing the live DOM would emit
 * blanks for everything nobody scrolled past. Each page is redrawn into an
 * offscreen canvas, converted to an image and the canvas dropped, which keeps
 * one page's pixels in memory at a time instead of all of them.
 */
async function doPrint() {
  if (!doc || !count) return;

  const host = $('print');
  host.textContent = '';
  veil('準備列印', '正在算繪第 1 頁，共 ' + count + ' 頁…', false);

  try {
    for (let n = 1; n <= count; n++) {
      $('veilText').textContent = '正在算繪第 ' + n + ' 頁，共 ' + count + ' 頁…';

      const pg = await doc.getPage(n);
      const at1 = pg.getViewport({ scale: 1, rotation: turn(pg) });
      // Roughly 150 dpi across the page, which is enough for text and keeps a
      // long document from exhausting memory.
      const s = Math.min(3, Math.max(0.5, 1240 / at1.width));
      const vp = pg.getViewport({ scale: s, rotation: turn(pg) });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      await pg.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;

      const img = document.createElement('img');
      img.src = canvas.toDataURL('image/jpeg', 0.85);
      img.alt = '第 ' + n + ' 頁';
      host.appendChild(img);

      canvas.width = 0;
      canvas.height = 0;
    }

    unveil();
    // Let the images decode before the print dialog snapshots the document.
    await new Promise((r) => setTimeout(r, 120));
    window.print();
  } catch (err) {
    unveil();
    note('列印準備失敗：' + describeError(err), 4000);
  }
}

window.addEventListener('afterprint', () => { $('print').textContent = ''; });

/* -------------------------------------------------------------------- wiring -- */

$('btnSide').addEventListener('click', () => toggleSide());
$('btnPrev').addEventListener('click', () => goTo(current - 1));
$('btnNext').addEventListener('click', () => goTo(current + 1));
$('btnIn').addEventListener('click', () => nudgeZoom(1));
$('btnOut').addEventListener('click', () => nudgeZoom(-1));
$('btnRot').addEventListener('click', () => rotate(90));
$('btnPrint').addEventListener('click', () => doPrint());
$('zoom').addEventListener('change', (e) => setZoom(e.target.value));

$('pageNo').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { goTo($('pageNo').value); elScroll.focus(); }
});
$('pageNo').addEventListener('blur', () => { $('pageNo').value = String(current); });

let findTimer = 0;
$('find').addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => runFind($('find').value), 220);
});
$('find').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
});
$('btnUp').addEventListener('click', () => step(-1));
$('btnDown').addEventListener('click', () => step(1));

elScroll.addEventListener('scroll', () => {
  // The observer covers arriving pages; this keeps the page number and the
  // release pass current while scrolling through already-drawn ones.
  clearTimeout(elScroll._t);
  elScroll._t = setTimeout(draw, 60);
}, { passive: true });

let sizeTimer = 0;
window.addEventListener('resize', () => {
  if (zoomMode !== 'width' && zoomMode !== 'page') return;
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => keepPlace(layout), 180);
});

// Selected text is offered to the shell so it can be sent to the model without
// the shell ever reaching into this document.
document.addEventListener('mouseup', () => {
  const s = String(window.getSelection() || '').trim();
  if (s) toShell('selection', { text: s.slice(0, 8000) });
});

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.nodeName);

  /* Before everything else, and whatever has focus: a mode you cannot leave is
     a trap, and Escape is where a person's hand goes. */
  if (picking && e.key === 'Escape') {
    e.preventDefault();
    setPick(false);
    toShell('picked', { cancelled: true });
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    $('find').focus();
    $('find').select();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'p') { e.preventDefault(); doPrint(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); nudgeZoom(1); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); nudgeZoom(-1); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setZoom('width'); return; }

  if (typing) return;

  if (e.key === 'F3') { e.preventDefault(); step(e.shiftKey ? -1 : 1); return; }
  if (e.key === 'Home') { e.preventDefault(); goTo(1); return; }
  if (e.key === 'End') { e.preventDefault(); goTo(count); return; }
  if (e.key === 'PageDown') { e.preventDefault(); goTo(current + 1); return; }
  if (e.key === 'PageUp') { e.preventDefault(); goTo(current - 1); return; }
  if (e.key === 'r') { e.preventDefault(); rotate(90); }
});

// The shell frames this document; without focus the keyboard shortcuts above
// would go to the shell instead.
window.addEventListener('load', () => elScroll.focus());

boot();
