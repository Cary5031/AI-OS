/* ===========================================================================
   AI-OS // PDF pages as pictures
   ---------------------------------------------------------------------------
   One export, `window.__raster`, called by main/pdf.js through
   executeJavaScript in an offscreen window. It renders the pages it is asked
   for and returns them as base64 JPEGs.

   WHY THIS EXISTS

   A scanned document has no text layer, so everything this machine does by
   reading a PDF -- extraction included -- gets nothing out of it. The pages are
   pictures, and the thing that can read a picture is the model. So the pages
   are handed over as pictures.

   WHY IT RE-DRAWS RATHER THAN LIFTING THE EMBEDDED IMAGE OUT

   Pulling the image XObject straight out of the file is cheaper and it is what
   the first version did. It only works when the scanner wrote JPEG. Bitonal
   scans -- the fax-shaped ones an office actually has most of -- are CCITT or
   JBIG2, which would each need a decoder written here, and a page with the scan
   plus a stamp or a signature on top is two images that have to be composed
   anyway. pdf.js already does all of that correctly, and it is already in this
   process for the viewer, so the page is drawn and the drawing is what goes.

   WHY THERE IS A BYTE BUDGET AND NOT A DPI

   The far end takes one request of a fixed size, so what matters is the total,
   not the resolution. Asking for 300 DPI and hoping is how a forty-page scan
   becomes a request that is refused after all the work. So the caller says how
   many bytes it has, and this starts at a scale worth reading, measures what it
   actually produced, and comes down if it has to -- quality first, then scale,
   because a smaller sharp page reads better than a big soft one.
   =========================================================================== */

import * as pdfjs from './lib/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.mjs', import.meta.url).href;

const LOAD_OPTS = {
  cMapUrl: new URL('./lib/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('./lib/fonts/', import.meta.url).href,
  wasmUrl: new URL('./lib/wasm/', import.meta.url).href,
  iccUrl: new URL('./lib/iccs/', import.meta.url).href,
  disableRange: true,
  disableStream: true
};

/* The long edge, in pixels, of the first attempt. 2000 is about 170 DPI on A4:
   enough that 8pt print in a delivery note stays legible, and well short of the
   4000-odd a 300 DPI scan would give, which costs four times the bytes to say
   the same thing. */
const FIRST_EDGE = 2000;
/* Above this there is no size that both fits one request and stays readable, so
   it is refused rather than attempted. Sixty A4 pages at the budget a request
   holds is about 230 KB each, which is a comfortable page; a hundred and twenty
   would be 115 KB each, which is a page you can see is a page. */
const MAX_PAGES = 60;
const MIN_EDGE = 900;
const QUALITIES = [0.82, 0.7, 0.6];

let doc = null;

async function open_() {
  if (doc) return doc;
  doc = await pdfjs.getDocument(Object.assign(
    { url: new URL('./doc.pdf', import.meta.url).href }, LOAD_OPTS)).promise;
  return doc;
}

/** Draw one page at a given long-edge size and return a data URL. */
async function draw(pg, edge, quality) {
  const at1 = pg.getViewport({ scale: 1, rotation: pg.rotate || 0 });
  const scale = Math.min(edge / Math.max(at1.width, at1.height), 4);
  const vp = pg.getViewport({ scale: scale, rotation: pg.rotate || 0 });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  const ctx = canvas.getContext('2d', { alpha: false });

  /* White, not transparent. A JPEG has no alpha channel, so an untouched canvas
     would come out black and the page would arrive unreadable rather than
     merely ugly. */
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await pg.render({ canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;

  const url = canvas.toDataURL('image/jpeg', quality);
  // Let the page go before the next one is drawn: forty A4 canvases at this size
  // is over a gigabyte held at once.
  canvas.width = 0;
  canvas.height = 0;
  return { dataUrl: url, w: vp.width, h: vp.height };
}

function bytesOf(dataUrl) {
  const i = dataUrl.indexOf(',');
  return i < 0 ? 0 : Math.floor((dataUrl.length - i - 1) * 3 / 4);
}

/**
 * Render pages and return them as base64 JPEGs.
 *
 * Every page, because a delivery note's total is on the last one and a batch
 * that read all but the last page would be wrong in a way nobody checks.
 *
 * `budget` is the total number of bytes all the pages together may take. The
 * answer says what it settled on, because a caller that asked for 300 DPI and
 * silently got 110 should be able to say so.
 */
async function raster(opts) {
  const o = opts || {};
  const d = await open_();
  const count = d.numPages;

  if (!count) return { pages: [], bytes: 0, edge: 0, quality: 0, count: count, shrunk: false };

  /* Refused up front rather than ground through. A two-hundred-page scan cannot
     fit one request at any size worth reading -- the budget divided by the page
     count is already less than a legible page costs -- and finding that out by
     drawing two hundred pages, three times, takes minutes to arrive at a
     sentence this can say now. The caller still sends the file, and the window
     still says why the pages did not come. */
  if (count > MAX_PAGES) {
    const e = new Error('這份掃描件有 ' + count + ' 頁，一次請求放不下（上限 ' + MAX_PAGES +
      ' 頁）。請先用 PDF 工具拆開再送。');
    e.code = 'E2BIG';
    throw e;
  }

  const budget = Number(o.budget) > 0 ? Number(o.budget) : 12 * 1024 * 1024;

  /* Try whole passes rather than per-page, so the set comes back consistent: a
     document whose page 1 is sharp and page 20 soft looks like a bug in the
     scan, and a model reading them has no way to know it is not. */
  let edge = FIRST_EDGE;
  for (let attempt = 0; attempt < 6; attempt++) {
    const quality = QUALITIES[Math.min(attempt, QUALITIES.length - 1)];
    const out = [];
    let total = 0;
    let over = false;

    for (let n = 1; n <= count; n++) {
      const pg = await d.getPage(n);
      const got = await draw(pg, edge, quality);
      pg.cleanup();
      total += bytesOf(got.dataUrl);
      out.push({ number: n, dataUrl: got.dataUrl, w: Math.round(got.w), h: Math.round(got.h) });
      /* Stop this pass the moment it cannot fit, instead of drawing the
         remaining thirty pages to find out what is already known. */
      if (total > budget) { over = true; break; }
    }

    if (!over) {
      return {
        pages: out.map((p) => ({
          number: p.number,
          base64: p.dataUrl.slice(p.dataUrl.indexOf(',') + 1),
          mimeType: 'image/jpeg',
          w: p.w, h: p.h
        })),
        bytes: total, edge: edge, quality: quality, count: count,
        /* Whether it had to come down to fit. Worth saying out loud: a page
           read badly at 900px looks exactly like a page read badly, and only
           this knows which one happened. */
        shrunk: edge < FIRST_EDGE || quality < QUALITIES[0]
      };
    }

    // Quality first while there is any left, then size.
    if (attempt >= QUALITIES.length - 1) {
      if (edge <= MIN_EDGE) break;
      edge = Math.max(MIN_EDGE, Math.round(edge * 0.75));
    }
  }

  const e = new Error('這份文件的頁面就算壓到最小也放不進一次請求');
  e.code = 'E2BIG';
  throw e;
}

/* The only thing main/pdf.js reaches for. Errors are returned rather than
   thrown: executeJavaScript reports a rejection as a string with no code on it,
   and the caller has to be able to tell "too big" from "could not open". */
window.__raster = async function (opts) {
  try {
    return { ok: true, data: await raster(opts) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' };
  }
};

window.__rasterReady = true;
