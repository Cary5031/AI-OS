'use strict';

/* ===========================================================================
   AI-OS // browser surface
   ---------------------------------------------------------------------------
   Real web pages, in a real Chromium view. An <iframe> cannot do this: most of
   the sites anyone wants to visit send X-Frame-Options or a frame-ancestors
   policy and would render as a blank rectangle.

   A WebContentsView is not a DOM element. It is a native view positioned in
   window coordinates that paints *above* everything the renderer draws, so:

     * the renderer has to tell us where the viewport rectangle is, and keep
       telling us as the window is dragged, resized or scrolled
     * it must be detached when its window is behind another one, minimized or
       closed, or a page would float over unrelated windows
     * it must be detached while a question is on screen -- the gate's consent
       window or the machine's own confirmation layer (askbox.js) -- or the
       page could cover the very question the user is being asked; suspend()
       holds that state, so the renderer cannot re-attach one in the meantime

   Every view lives in one shared non-default session, so browsing state is
   isolated from anything else this application does, and web content never
   shares a cookie jar with the machine's own pages.
   =========================================================================== */

const { WebContentsView, session, shell } = require('electron');

const articleAgent = require('./article-agent');
/* Only for validateUrl: one definition of "not an ordinary public address"
   rather than a second copy of the private-range list that drifts from it. */
const web = require('./web');

const PARTITION = 'persist:aios-web';

/* Two different ideas that used to share one name. BLANK is the empty tab --
   what a view shows before it has been asked for anything, and where an empty
   address bar goes. HOME is where the 首頁 button goes, which is a page. */
const BLANK = 'about:blank';
const HOME = 'https://www.google.com/';

/* Text this machine put on the page itself, which is not the page's content.

   A translation is a <span> inserted under each paragraph (main/translate.js),
   and it is a text node like any other -- so a snapshot taken while a page is
   translated would hand an extension both languages, and, worse, every index
   after the first translated paragraph would name a different node than it did
   before. An extension addressing node 40 would then write onto node 38's
   text. Both walkers skip it, so the indices they agree on are the page's own
   whether or not a translation is on screen. */
const AIOS_TEXT = '.aios-tr-line';

/* ---------------------------------------------------------- isolated world

   The one world AI-OS itself may run code in, and the only way it reaches a
   page at all: these views are built with `preload: undefined` on purpose, and
   an isolated world keeps that promise -- shared DOM, separate script world.
   The page cannot see what runs here, and what runs here has no IPC, no
   require and no channel except the value it returns. main/translate.js is its
   only user; see the header there. */
const ISOLATED_WORLD = 1729;

let owner = null;          // the AI-OS BrowserWindow
let notify = () => {};     // (tabId, event, payload) -> void
let onReady = () => {};    // (tabId) -> void, after a main-frame load finishes
const tabs = new Map();    // id -> { id, view, attached, bounds, title, url, loading }
let nextId = 1;
/* How many modal layers are up. While it is above zero nothing attaches: the
   renderer keeps asking (a window drag, a geometry nudge) and is told no; it
   asks again once the layer is gone and the shell is nudged. A count rather
   than a flag, because the consent window and a confirmation can overlap. */
let suspended = 0;

/**
 * Called with a tab id once a main-frame load has finished.
 *
 * Navigating destroys the isolated world with the document, so anything living
 * there has to be put back. This is how it finds out; nothing else in the
 * application needs it.
 */
function setPageReadyHook(fn) {
  if (typeof fn === 'function') onReady = fn;
}

/**
 * Run code in this tab's isolated world and return its value.
 *
 * The code is AI-OS's own, never the model's and never the page's, and it is
 * the caller's job to keep it that way: this is a script world with the page's
 * DOM in reach. The value comes back as structured JSON, which is also the
 * only direction information travels -- the world has no channel of its own.
 */
async function runIsolated(id, code) {
  const tab = get(id);
  return tab.view.webContents.executeJavaScriptInIsolatedWorld(
    ISOLATED_WORLD, [{ code: String(code) }], false);
}

function init(win, onEvent) {
  owner = win;
  if (typeof onEvent === 'function') notify = onEvent;

  // Web content gets no device access at all. None of it is needed to read a
  // page, and a permission prompt inside an embedded view would be confusing
  // about which application is asking.
  const s = session.fromPartition(PARTITION);
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  return { partition: PARTITION };
}

function serialise(tab) {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    loading: tab.loading,
    canGoBack: tab.view && !tab.view.webContents.isDestroyed()
      ? tab.view.webContents.navigationHistory.canGoBack()
      : false,
    canGoForward: tab.view && !tab.view.webContents.isDestroyed()
      ? tab.view.webContents.navigationHistory.canGoForward()
      : false
  };
}

/**
 * Create a native view for a web page.
 *
 * PDFs used to come through here with `kind: 'pdf'`, rendered by Chromium's
 * plugin viewer. That never showed a single pixel inside a WebContentsView, and
 * the pages are now drawn by pdf.js in an ordinary framed document instead --
 * see VIEWER HOSTING in main/pdf.js. Nothing about local files belongs in the
 * browser, which is why toUrl below still refuses to understand file:.
 */
function create({ url } = {}) {
  if (!owner || owner.isDestroyed()) throw new Error('沒有可用的主視窗');

  const id = 'tab' + nextId++;
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      plugins: false,
      // Untrusted content must not be able to reach into the application, so
      // there is deliberately no preload script here at all.
      preload: undefined,
      // Throttling a background page saves real CPU on timers and animations.
      backgroundThrottling: true
    }
  });

  const tab = {
    id, view,
    attached: false, bounds: null,
    title: '新分頁',
    url: url || BLANK,
    loading: false,
    /* URLs the last extraction saw this page draw as an <img>. The allowlist
       for articleImages, and cleared on navigation so it can never name a
       picture from a page that is no longer open. */
    pictures: []
  };
  tabs.set(id, tab);

  const wc = view.webContents;

  wc.on('page-title-updated', (_e, title) => {
    tab.title = title || tab.url;
    notify(id, 'state', serialise(tab));
  });
  wc.on('did-start-loading', () => { tab.loading = true; notify(id, 'state', serialise(tab)); });
  wc.on('did-stop-loading', () => {
    tab.loading = false;
    tab.url = wc.getURL();
    notify(id, 'state', serialise(tab));
  });
  wc.on('did-navigate', (_e, navUrl) => {
    tab.url = navUrl;
    /* The old page's pictures are not this page's pictures. Dropping the list
       here is what keeps the allowlist honest: a fetch can only ever name
       something the extraction running against the document now put there. */
    tab.pictures = [];
    notify(id, 'state', serialise(tab));
  });
  /* A finished main-frame load is a new document, and a new document means a
     new isolated world: whatever was running in the old one is gone. */
  wc.on('did-finish-load', () => {
    try { onReady(id); } catch { /* a hook must never break a page load */ }
  });
  wc.on('did-navigate-in-page', (_e, navUrl, isMain) => {
    if (isMain) { tab.url = navUrl; notify(id, 'state', serialise(tab)); }
  });
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMain) => {
    if (!isMain || code === -3) return;   // -3 is an aborted load, not a failure
    tab.loading = false;
    notify(id, 'error', { code, desc, url: failedUrl });
  });
  wc.on('render-process-gone', (_e, details) => {
    notify(id, 'error', { code: 'crashed', desc: details.reason });
  });

  // Popups become tabs; nothing gets to open an OS-level window on its own.
  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (disposition === 'foreground-tab' || disposition === 'background-tab' || disposition === 'new-window') {
      notify(id, 'popup', { url: target });
    }
    return { action: 'deny' };
  });

  // Downloads and non-web schemes are handed to the operating system rather
  // than silently ignored, but only after the user's own shell decides.
  wc.on('will-navigate', (event, target) => {
    if (!/^(https?|about):/i.test(target)) {
      event.preventDefault();
      notify(id, 'external', { url: target });
    }
  });

  if (url) navigate(id, url);
  return serialise(tab);
}

function get(id) {
  const tab = tabs.get(id);
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) {
    throw Object.assign(new Error('分頁不存在：' + id), { code: 'ENOTAB' });
  }
  return tab;
}

/** Normalise what the user typed into something navigable. */
function toUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return BLANK;
  if (/^(https?|about):/i.test(raw)) return raw;
  // A single token with a dot and no spaces is a host; anything else is a search.
  if (/^[^\s/]+\.[^\s/]{2,}(\/.*)?$/.test(raw)) return 'https://' + raw;
  return 'https://www.google.com/search?q=' + encodeURIComponent(raw);
}

function navigate(id, input) {
  const tab = get(id);
  const target = toUrl(input);
  tab.url = target;
  tab.view.webContents.loadURL(target).catch(() => { /* reported via did-fail-load */ });
  return serialise(tab);
}

function goBack(id) {
  const tab = get(id);
  const h = tab.view.webContents.navigationHistory;
  if (h.canGoBack()) h.goBack();
  return serialise(tab);
}

function goForward(id) {
  const tab = get(id);
  const h = tab.view.webContents.navigationHistory;
  if (h.canGoForward()) h.goForward();
  return serialise(tab);
}

function reload(id) {
  get(id).view.webContents.reload();
  return { ok: true };
}

function stop(id) {
  get(id).view.webContents.stop();
  return { ok: true };
}

/* How long to sit watching a tab before giving up on seeing a matching request.
   A page that is already open and idle still polls its own server every few
   seconds; a page that has just been opened has to sign in first, which is why
   the caller passes a longer wait for that case. */
const LEARN_TIMEOUT_MS = 20000;

/**
 * Watch one tab and hand back the headers it sends its own server.
 *
 * Some services cannot be asked anything useful without credentials that live
 * only inside the page -- a bearer token the page fetched, a routing header its
 * own code computes. Reading the page's DOM does not reach them and neither
 * does its cookie jar. What does reach them is watching the request go out,
 * which is what a browser's own network panel does.
 *
 * Returns `{url, method, headers}` for the first request whose URL matches, or
 * null if none went out in time. The caller decides which of those headers it
 * is willing to reuse; this function makes no judgement and keeps no copy.
 *
 * The debugger is detached again on the way out, and never detached if it was
 * somebody else's -- DevTools open on this tab is a refusal, not a takeover.
 */
function learnRequest(id, { match, timeout = LEARN_TIMEOUT_MS } = {}) {
  const tab = get(id);
  const wc = tab.view.webContents;
  const re = match instanceof RegExp ? match : new RegExp(String(match || '.'));
  const dbg = wc.debugger;

  let mine = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); mine = true; }
  } catch (e) {
    throw Object.assign(new Error('這個分頁已經有別的除錯器連著：' + String(e.message || e)),
      { code: 'EDEBUGGER' });
  }

  return new Promise((resolve) => {
    const pending = new Map();
    let done = false;

    function finish(value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { dbg.removeListener('message', onMessage); } catch { /* already gone */ }
      if (mine) { try { dbg.detach(); } catch { /* already gone */ } }
      resolve(value);
    }

    function onMessage(_event, method, params) {
      if (done) return;
      if (method === 'Network.requestWillBeSent') {
        if (re.test(params.request.url)) {
          pending.set(params.requestId, { url: params.request.url, method: params.request.method });
          /* Bounded: a busy page would otherwise grow this map for as long as
             nothing matched the extra-info half. */
          if (pending.size > 64) pending.delete(pending.keys().next().value);
        }
        return;
      }
      /* The headers actually put on the wire arrive separately from the request
         itself, and only this half has the ones the network stack added. */
      if (method === 'Network.requestWillBeSentExtraInfo') {
        const base = pending.get(params.requestId);
        if (base) finish({ ...base, headers: params.headers || {} });
      }
    }

    const timer = setTimeout(() => finish(null), Math.max(1000, timeout));
    dbg.on('message', onMessage);
    dbg.sendCommand('Network.enable').catch(() => finish(null));
  });
}

/**
 * The shell's page zoom (系統 → 文字大小), read from the process that set it.
 * 1 when there is no window to ask.
 */
function zoom() {
  try {
    const f = owner && !owner.isDestroyed() ? owner.webContents.getZoomFactor() : 1;
    return Number.isFinite(f) && f > 0 ? f : 1;
  } catch {
    return 1;
  }
}

/**
 * Place the view. Called by the renderer whenever the browser window moves,
 * resizes or changes stacking order; cheap enough to call on every drag frame.
 *
 * The renderer measures the slot in CSS pixels of a page that may be zoomed
 * (the text size is Chromium's page zoom, applied by main/index.js); a native
 * view is placed in device-independent pixels, which is CSS × zoom. The factor
 * is applied here rather than guessed at by the page, because this process is
 * the one that set it. Without this, at 115% the page sat up and to the left of
 * its frame at 87% of its size -- separated from the window around it, the day
 * 115% became the default.
 */
function setBounds(id, bounds) {
  const tab = get(id);
  const z = zoom();
  const b = {
    x: Math.round((Number(bounds.x) || 0) * z),
    y: Math.round((Number(bounds.y) || 0) * z),
    width: Math.max(0, Math.round((Number(bounds.width) || 0) * z)),
    height: Math.max(0, Math.round((Number(bounds.height) || 0) * z))
  };
  tab.bounds = b;
  if (tab.attached) tab.view.setBounds(b);
  return b;
}

function show(id, bounds) {
  const tab = get(id);
  if (bounds) setBounds(id, bounds);
  if (suspended) return { attached: false, suspended: true };
  if (!tab.attached) {
    owner.contentView.addChildView(tab.view);
    tab.attached = true;
  }
  if (tab.bounds) tab.view.setBounds(tab.bounds);
  return { attached: true };
}

function hide(id) {
  const tab = tabs.get(id);
  if (!tab || !tab.attached) return { attached: false };
  try { owner.contentView.removeChildView(tab.view); } catch { /* already gone */ }
  tab.attached = false;
  return { attached: false };
}

/** Detach every view. Used when a modal opens or the app is shutting down. */
function hideAll() {
  let n = 0;
  for (const id of tabs.keys()) {
    const tab = tabs.get(id);
    if (tab && tab.attached) { hide(id); n++; }
  }
  return { hidden: n };
}

/**
 * A modal layer went up (true) or came down (false). Up: every view is
 * detached and stays detached whatever the renderer asks. Down: attaching is
 * allowed again; the caller nudges the shell, which lays the views out anew.
 */
function suspend(on) {
  suspended = Math.max(0, suspended + (on ? 1 : -1));
  if (suspended) hideAll();
  return { suspended };
}

function destroy(id) {
  const tab = tabs.get(id);
  if (!tab) return { ok: true };
  hide(id);
  try {
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  } catch { /* best effort */ }
  tabs.delete(id);
  return { ok: true };
}

function destroyAll() {
  for (const id of [...tabs.keys()]) destroy(id);
  return { ok: true };
}

/**
 * What the user is actually looking at, as text. This is how a page becomes
 * something the model can reason about; the caller fences it as untrusted.
 */
async function readPage(id, limit = 40000) {
  const tab = get(id);
  const js = `(() => {
    const drop = ['script','style','noscript','nav','aside','footer','header','svg','${AIOS_TEXT}'];
    const root = document.querySelector('article, main') || document.body;
    if (!root) return { title: document.title, text: '' };
    const clone = root.cloneNode(true);
    drop.forEach(sel => clone.querySelectorAll(sel).forEach(n => n.remove()));
    return {
      title: document.title,
      url: location.href,
      text: (clone.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim()
    };
  })()`;
  const out = await tab.view.webContents.executeJavaScript(js, true);
  return {
    id,
    url: out.url || tab.url,
    title: out.title || tab.title,
    text: String(out.text || '').slice(0, limit)
  };
}

/**
 * The article on screen, as Markdown, for saving as Markdown, Word or PDF.
 *
 * `readPage` above flattens the page for the model to reason about; this keeps
 * the structure, because a heading that arrives as a sentence is a heading
 * that is gone from the exported document. Both drop the same furniture --
 * navigation, asides, footers -- and this one also drops what the page itself
 * has hidden, which is a check only the live DOM can answer.
 *
 * See article-agent.js for what counts as the article and why.
 */
async function article(id) {
  const tab = get(id);
  const out = await runIsolated(id, articleAgent.SOURCE);
  if (!out || typeof out.markdown !== 'string') {
    throw Object.assign(new Error('這一頁抓不出正文'), { code: 'ENOARTICLE' });
  }
  const pictures = (Array.isArray(out.pictures) ? out.pictures : [])
    .filter((p) => p && typeof p.src === 'string' && /^https?:/i.test(p.src))
    .slice(0, MAX_PICTURES)
    .map((p) => ({
      src: p.src,
      alt: String(p.alt || '').slice(0, 200),
      w: Number(p.w) || 0,
      h: Number(p.h) || 0,
      loaded: !!p.loaded
    }));
  tab.pictures = pictures;

  return {
    id,
    url: out.url || tab.url,
    title: out.title || tab.title || tab.url,
    byline: out.byline || '',
    how: out.how || '',
    markdown: out.markdown,
    chars: out.chars || out.markdown.length,
    images: out.images || 0,
    pictures,
    truncated: !!out.truncated,
    /* Said out loud at every boundary this crosses: it is a stranger's text. */
    untrusted: true
  };
}

/* ===========================================================================
   PICTURES, AS BYTES
   ---------------------------------------------------------------------------
   An exported document has to carry its pictures, and something has to turn a
   URL into bytes. Three places could: the page, the print window, and here.

   Not the page. An isolated world shares the DOM, so it can see every picture
   -- but reading the pixels back out means a canvas, and an image from another
   origin without CORS headers taints it, so `toDataURL` throws. That is most of
   the pictures on most articles: they come from a CDN. What came back would be
   an unpredictable subset, which is worse than an honest placeholder.

   Not the print window. It is served under `default-src 'none'; img-src data:`
   precisely so that a document assembled out of somebody else's content cannot
   open a socket or name a path. See serveView in main/pdf.js.

   So: here, before the document is assembled, and under two rules.

   PROVENANCE, NOT ORIGIN. The allowlist is `tab.pictures` -- the URLs the
   extraction just watched this page draw. An origin rule would be both looser
   and less useful: article pictures live on CDNs, so matching the page's origin
   would drop most of them while still allowing any other URL from that origin.
   "This document is open, and it drew this exact picture seconds ago" is the
   stronger claim, and it is immune to a URL smuggled in through prose.

   THE SAME SESSION THE PAGE USED. Requests go through the browsing partition,
   so they hit the same HTTP cache -- usually no new socket at all -- and a
   picture behind a login resolves with the cookies that loaded it. It also
   keeps this off the machine's own session, which has never touched the web.
   ========================================================================= */

const MAX_PICTURES = 60;
/* What one export may carry. The print document is capped at 8 MiB of HTML and
   base64 costs a third on top of the bytes, so this leaves room for the text. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_FETCH = 24;
const IMAGE_TIMEOUT_MS = 12000;

/* Formats a print window will draw. SVG is deliberately absent: it is a
   document, not a picture -- it can carry script and reference other files, and
   putting one in a data: URI would hand the print document exactly the reach
   the CSP exists to deny. */
const IMAGE_MIME = {
  'image/png': 1, 'image/jpeg': 1, 'image/gif': 1, 'image/webp': 1, 'image/avif': 1
};

/**
 * May this export go and get this picture?
 *
 * Provenance already says the page drew it. This is the second question, and it
 * is about the address rather than the picture: everything else on this machine
 * that opens a socket refuses loopback and the private ranges, because "fetch
 * this for me" is otherwise a way to probe the network the machine is sitting
 * on. That refusal stays -- with one exemption.
 *
 * The exemption is the host the tab is already on. A page served from an
 * intranet or from a development server is a page the user opened deliberately
 * and is looking at right now; its own pictures are already on screen, and the
 * connection to that host is already open. Refusing them would not withhold any
 * reach the machine does not already have, it would just export the page with
 * holes in it. A picture from anywhere ELSE still has to be a public address,
 * so a page cannot use its own privileged position to point the export at the
 * router next to it.
 */
function mayFetchPicture(src, pageUrl) {
  let u;
  let page;
  try { u = new URL(src); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  try { page = new URL(pageUrl); } catch { page = null; }
  if (page && page.host && page.host === u.host) return true;
  try { web.validateUrl(src); return true; } catch { return false; }
}

/** What the first bytes say it is, which is the claim that counts. */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  const riff = buf.toString('latin1', 0, 4);
  if (riff === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  // ISO base media: "ftyp" at 4, with an AVIF brand.
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1') return 'image/avif';
  }
  return null;
}

/**
 * Fetch the pictures of the article this tab last handed out.
 *
 * Returns a `{ url: dataUri }` map plus a count of what was refused, so the
 * caller can tell the user how many pictures made it rather than quietly
 * producing a document with holes in it.
 */
async function articleImages(id, opts = {}) {
  const tab = get(id);
  const allow = new Set((tab.pictures || []).map((p) => p.src));
  if (!allow.size) return { images: {}, got: 0, skipped: 0, bytes: 0 };

  /* Order matters once a budget is involved: the biggest pictures on the page
     are the illustrations, and a budget spent on thumbnails first would leave
     nothing for them. */
  const wanted = (tab.pictures || [])
    .slice()
    .sort((a, b) => (b.w * b.h) - (a.w * a.h))
    .slice(0, MAX_FETCH);

  const ses = session.fromPartition(PARTITION);
  const images = {};
  let bytes = 0;
  let skipped = 0;

  for (const pic of wanted) {
    if (bytes >= MAX_TOTAL_BYTES) { skipped++; continue; }
    if (!allow.has(pic.src)) { skipped++; continue; }
    if (!mayFetchPicture(pic.src, tab.url)) { skipped++; continue; }

    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), IMAGE_TIMEOUT_MS);
    try {
      const res = await ses.fetch(pic.src, {
        signal: stop.signal,
        /* The page's own cookies, and the page as the referrer -- a CDN that
           checks either would otherwise hand back a placeholder or a 403. */
        credentials: 'include',
        headers: { Referer: tab.url || '', Accept: 'image/*' }
      });
      if (!res.ok) { skipped++; continue; }

      const declared = String(res.headers.get('content-type') || '')
        .split(';')[0].trim().toLowerCase();
      if (declared && !IMAGE_MIME[declared]) { skipped++; continue; }

      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_IMAGE_BYTES) { skipped++; continue; }
      if (bytes + buf.length > MAX_TOTAL_BYTES) { skipped++; continue; }

      /* The header is a claim; the bytes are the fact. A file that says it is a
         PNG and is not gets refused rather than handed to a decoder. */
      const real = sniffImage(buf);
      if (!real) { skipped++; continue; }

      images[pic.src] = 'data:' + real + ';base64,' + buf.toString('base64');
      bytes += buf.length;
    } catch {
      skipped++;
    } finally {
      clearTimeout(timer);
    }
  }

  /* Anything the extraction listed but the budget never reached is a picture
     the document will show as a placeholder, and the user is told the number. */
  skipped += Math.max(0, (tab.pictures || []).length - wanted.length);

  return { images, got: Object.keys(images).length, skipped, bytes, of: (tab.pictures || []).length };
}

/**
 * The whole page, printed as it looks, straight from the tab that is showing it.
 *
 * The article export is a reflow: it keeps what the page said and throws away
 * how it looked. Sometimes how it looked is the point -- a receipt, a ticket, a
 * form, a chart-heavy report -- and no extraction will ever reproduce that. This
 * is Chromium printing its own live page, so the layout, the stylesheets and
 * every picture already on screen come out exactly as rendered.
 *
 * Returns the bytes; the caller decides where they go.
 */
async function printTab(id, opts = {}) {
  const tab = get(id);
  const wc = tab.view.webContents;
  if (wc.isDestroyed()) throw new Error('這個分頁已經關閉了');
  return wc.printToPDF({
    printBackground: opts.printBackground !== false,
    landscape: !!opts.landscape,
    pageSize: opts.pageSize || 'A4',
    margins: opts.margins || { marginType: 'default' },
    generateDocumentOutline: true,
    generateTaggedPDF: true
  });
}

function openExternal(url) {
  if (!/^https?:/i.test(String(url || ''))) throw new Error('只允許把 http/https 交給系統開啟');
  shell.openExternal(url);
  return { ok: true };
}

function list() {
  return [...tabs.values()].map(serialise);
}

/* ===========================================================================
   What an extension is allowed to do to a page
   ---------------------------------------------------------------------------
   Generated code never runs in the page. It receives the page as data and
   answers with a list of proposed changes, which this applies.

   The reason is the combination: the code was written by a model and the page
   is hostile input. A real extension model -- inject the script, let it do what
   it likes -- means model-written code with full DOM access on somebody's bank
   page, and a page that can reach back into it. Here the worst a wrong answer
   can do is replace the wrong text.

   So the vocabulary is small and every operation is a whole-node replacement of
   text. No HTML, no attributes, no event handlers, no script: a string in,
   `textContent` out. `innerHTML` would hand the model a way to write markup
   into a page it does not control, which is the hole this shape exists to
   avoid.
   ========================================================================= */

const MAX_OPS = 2000;


/**
 * Apply text replacements to the page, addressed by the index the snapshot gave.
 *
 * Indices rather than selectors: a selector is a small language the model can
 * get wrong in ways that silently hit the wrong element, while an index either
 * names a node the snapshot listed or does not.
 */
async function applyToPage(id, ops) {
  const tab = get(id);
  const list = (Array.isArray(ops) ? ops : []).slice(0, MAX_OPS)
    .filter((o) => o && Number.isInteger(o.node) && o.node >= 0 && typeof o.text === 'string')
    .map((o) => ({ node: o.node, text: String(o.text).slice(0, 20000) }));
  if (!list.length) return { applied: 0, skipped: 0 };

  const js = `(() => {
    const ops = ${JSON.stringify(list)};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        if (p.closest('${AIOS_TEXT}')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let applied = 0, skipped = 0;
    for (const op of ops) {
      const n = nodes[op.node];
      if (!n) { skipped++; continue; }
      n.nodeValue = op.text;
      applied++;
    }
    return { applied, skipped, nodes: nodes.length };
  })()`;
  return tab.view.webContents.executeJavaScript(js, true);
}

/**
 * The page's text nodes, numbered, for an extension to work on.
 *
 * Separate from `readPage`, which flattens the page into prose for the model to
 * reason about. This keeps the structure, because an extension that wants to
 * translate has to be able to put each piece back where it came from.
 */
async function pageNodes(id, limit = 4000) {
  const tab = get(id);
  const js = `(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        if (p.closest('${AIOS_TEXT}')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const out = [];
    let i = 0;
    while (walker.nextNode() && out.length < ${Number(limit) || 4000}) {
      const n = walker.currentNode;
      out.push({ node: i, tag: n.parentElement.tagName.toLowerCase(), text: n.nodeValue.trim().slice(0, 2000) });
      i++;
    }
    return { url: location.href, title: document.title, nodes: out };
  })()`;
  const out = await tab.view.webContents.executeJavaScript(js, true);
  return { id, ...out };
}

module.exports = {
  init, create, navigate, goBack, goForward, reload, stop,
  setBounds, show, hide, hideAll, suspend, destroy, destroyAll,
  runIsolated, setPageReadyHook, ISOLATED_WORLD, learnRequest,
  readPage, pageNodes, article, articleImages, printTab, applyToPage,
  openExternal, list, toUrl,
  PARTITION, HOME, BLANK
};
