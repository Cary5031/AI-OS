'use strict';

/* ===========================================================================
   AI-OS // askBox: the machine's own confirmation dialog
   ---------------------------------------------------------------------------
   Three things stop to ask a person before they happen: emptying the trash,
   installing a build with the confirmation switch on, and importing a program
   somebody else made. They used to be `dialog.showMessageBox` -- a Windows
   task dialog, drawn by the operating system in the operating system's font
   and colours, floating over a machine that draws everything else itself. It
   read as a window from somewhere else, which on this machine is exactly the
   look a prompt is not supposed to have.

   This is the replacement. The question is drawn *inside* the AI-OS window,
   as a WebContentsView owned by the main process: a transparent layer over
   the whole content area, carrying os.css, the current theme and the current
   text size, with the card in the middle exactly where the shell's own
   dialogs sit. It is not a second operating-system window -- it cannot be
   dragged out of the machine, does not appear in the taskbar, and moves,
   resizes and goes full screen with the window it lives in.

   What did not change is who owns it. The view, its preload and its answer
   belong to this process. The renderer asks a question and receives an index;
   it never renders the buttons and never says "the user pressed 匯入". The
   text comes from the caller here (ipc.js composes the import summary from
   the copy of the package it holds, not from what the Forge window says about
   it), and only the one webContents that was shown the question can answer
   it. Anything else on the machine -- the shell, a generated program's frame,
   a web page in a browser view -- has no channel into it.

   The theme is the one thing the shell contributes, and it is cosmetic: the
   twenty colour variables it is currently painting with, validated here to be
   colour-shaped strings. The shell is trusted to say what colours it wears
   because these three dialogs are gesture flows the shell already initiates
   (the same renderer can install a build with no dialog at all). The gate's
   consent window stays what it is -- its own window, its own fixed theme --
   because the gate does not extend that trust.

   Browser views paint above everything the renderer draws, and would paint
   above this one too, so the modal hook detaches them while a question is on
   screen -- the same hook, and the same reason, as the consent window's.
   =========================================================================== */

const { WebContentsView, ipcMain } = require('electron');
const path = require('node:path');
const prefs = require('./prefs');

/* The custom properties a theme block in os.css sets: the eleven a person can
   edit in the theme editor and the nine derived from them. The same list, in
   the same order, as renderer/themer.js `vars()`; wiring.test.js pins them. */
const THEME_KEYS = [
  'bg-0', 'bg-1', 'fg', 'fg-dim', 'fg-faint', 'accent', 'accent-2', 'warn', 'danger', 'taint', 'on-fill',
  'glass', 'glass-2', 'hair', 'hair-2', 'pop-bg', 'pop-sel', 'grid', 'glow', 'shadow'
];
/* What a colour, or a box-shadow, is made of. No braces, semicolons or
   colons: a value that is not one of these cannot be a colour and is dropped,
   whatever `style.setProperty` would have made of it. */
const VALUE_RE = /^[#\w\s(),.%\-\/]{1,160}$/;
const THEME_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const TYPES = ['question', 'warning', 'info'];

let theme = null;             // the shell's last report: { id, light, vars }
let onModal = () => {};       // (up: boolean) -> void
let current = null;           // the one question on screen
let chain = Promise.resolve(); // questions wait for each other; none is dropped
let closing = false;          // the shutdown ceremony has begun: no more questions
let seq = 0;

function log(...args) {
  console.log('[askbox] ' + args[0], ...args.slice(1));
}

/* Called with true when a dialog is about to appear and false when it is
   gone. Native browser views paint above the renderer and above this view, so
   they have to be detached first -- a web page floating over the question
   would let the page dress up what the user is answering. */
function setModalHook(fn) {
  if (typeof fn === 'function') onModal = fn;
}

/**
 * The shell reports the theme it is painting with, so the dialog can wear it.
 * Every value is checked to be colour-shaped; an id that is not a theme id,
 * or a key that is not a theme key, is dropped rather than forwarded.
 */
function setTheme(snap) {
  if (!snap || typeof snap !== 'object') { theme = null; return { ok: true, keys: 0 }; }
  const vars = {};
  const src = snap.vars && typeof snap.vars === 'object' ? snap.vars : {};
  for (const k of THEME_KEYS) {
    const v = src[k];
    if (typeof v === 'string' && VALUE_RE.test(v.trim())) vars[k] = v.trim();
  }
  theme = {
    id: typeof snap.id === 'string' && THEME_ID_RE.test(snap.id) ? snap.id : 'void',
    light: !!snap.light,
    vars
  };
  return { ok: true, keys: Object.keys(vars).length };
}

function getTheme() {
  return theme ? { id: theme.id, light: theme.light, vars: { ...theme.vars } } : null;
}

/** The message-box contract, checked: every field the page will render. */
function normalise(opts = {}) {
  const buttons = (Array.isArray(opts.buttons) ? opts.buttons : []).map((b) => String(b)).filter(Boolean);
  if (!buttons.length) buttons.push('確定');
  const inRange = (n) => Number.isInteger(n) && n >= 0 && n < buttons.length;
  const cancelId = inRange(opts.cancelId) ? opts.cancelId : 0;
  const defaultId = inRange(opts.defaultId) ? opts.defaultId : cancelId;
  return {
    type: TYPES.includes(opts.type) ? opts.type : 'question',
    title: String(opts.title || ''),
    message: String(opts.message || ''),
    detail: String(opts.detail || ''),
    buttons,
    defaultId,
    cancelId
  };
}

/**
 * Ask, and resolve with `{ response }` -- the index of the button pressed,
 * exactly as dialog.showMessageBox resolved, so the callers did not change.
 * Escape, a destroyed view and a closed window all answer with `cancelId`.
 * Questions are shown one after another: a second one waits for the first
 * instead of stacking on top of it, which is how a person ends up answering
 * the wrong question.
 */
function ask(win, opts) {
  const clean = normalise(opts);
  const turn = chain.then(() => show(win, clean), () => show(win, clean));
  chain = turn.then(() => undefined, () => undefined);
  return turn;
}

function show(win, opts) {
  return new Promise((resolve) => {
    if (closing || !win || win.isDestroyed()) {
      log('%s, 「%s」 answered as cancel', closing ? 'shutting down' : 'no window to ask in', opts.title);
      resolve({ response: opts.cancelId });
      return;
    }

    const rec = { seq: ++seq, resolve, opts, win, view: null, settled: false, teardown: () => {} };
    current = rec;
    log('#%d asking 「%s」 (%s)', rec.seq, opts.title, opts.buttons.join(' / '));
    try { onModal(true); } catch { /* never block the question on a hook */ }

    /* From here on the hook has been raised, so whatever fails must lower it
       again: a suspend counter left at one would keep every browser view
       detached for the rest of the session. */
    try {
      mount(rec);
    } catch (e) {
      log('#%d could not open a view: %s', rec.seq, (e && e.message) || e);
      rec.settled = true;
      if (current === rec) current = null;
      try { rec.teardown(); } catch { /* nothing was mounted */ }
      try { onModal(false); } catch { /* ignore */ }
      resolve({ response: opts.cancelId });
    }
  });
}

/** Create the view for `rec`, wire its lifetime, and load the document. */
function mount(rec) {
  const { win } = rec;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'askbox.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  rec.view = view;
  const wc = view.webContents;

  /* Transparent, so the layer is the scrim and the card and nothing else:
     the shell stays visible, dimmed, behind the question. */
  view.setBackgroundColor('#00000000');

  /* The layer covers the content area, and keeps covering it: the window can
     be resized, or go in and out of full screen, while the question waits. */
  const fit = () => {
    if (win.isDestroyed()) return;
    const b = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  };
  /* Adding a child that is already a child moves it to the top, so this is
     also how the layer stays above anything attached after it. */
  const raise = () => {
    if (win.isDestroyed() || rec.settled) return;
    fit();
    win.contentView.addChildView(view);
  };
  const onClosed = () => settle(rec, null, '視窗被關閉');

  win.on('resize', fit);
  win.on('enter-full-screen', fit);
  win.on('leave-full-screen', fit);
  win.once('closed', onClosed);

  rec.teardown = () => {
    win.off('resize', fit);
    win.off('enter-full-screen', fit);
    win.off('leave-full-screen', fit);
    win.off('closed', onClosed);
    try { if (!win.isDestroyed()) win.contentView.removeChildView(view); } catch { /* already gone */ }
    try { if (!wc.isDestroyed()) wc.close(); } catch { /* best effort */ }
    try { if (!win.isDestroyed()) win.webContents.focus(); } catch { /* ignore */ }
    try { onModal(false); } catch { /* ignore */ }
  };

  /* Same text size as the shell: Chromium's page zoom is what the person
     chose under 系統 → 文字大小, applied by the process that owns the view.
     Always set, 1 included: the zoom of a file: document is shared with the
     shell's, and this must never be the stale value from an earlier
     setting. */
  wc.on('dom-ready', () => {
    const z = prefs.get().zoom;
    wc.setZoomFactor(Number.isFinite(z) && z > 0 ? z : 1);
  });
  /* Attached only once it has painted, so the layer never appears as an
     unstyled rectangle over the desktop. */
  wc.once('did-finish-load', () => {
    if (rec.settled) return;
    raise();
    wc.focus();
  });
  wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    // -3 is a load that was aborted, which is not a failure of the document.
    if (isMainFrame && code !== -3) settle(rec, null, 'page failed to load: ' + code + ' ' + desc);
  });
  wc.on('render-process-gone', (_e, d) => settle(rec, null, 'renderer gone: ' + (d && d.reason)));
  wc.on('destroyed', () => settle(rec, null, 'view destroyed'));
  // A dialog is a document with one job; it opens nothing and goes nowhere.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event) => event.preventDefault());

  wc.loadFile(path.join(__dirname, '..', 'renderer', 'askbox.html'))
    .catch((e) => settle(rec, null, 'could not load the document: ' + (e && e.message)));
}

/**
 * Resolve the question if, and only if, it is `rec` and it is still open.
 * Everything that ends a dialog goes through here, so ownership is checked in
 * one place and the view is taken down exactly once.
 */
function settle(rec, response, why) {
  if (!rec || rec.settled) return false;
  rec.settled = true;
  if (current === rec) current = null;
  const r = Number.isInteger(response) ? response : rec.opts.cancelId;
  log('#%d 「%s」 -> %d 「%s」 (%s)', rec.seq, rec.opts.title, r, rec.opts.buttons[r], why);
  try { rec.teardown(); } catch (e) { log('teardown failed: %s', e && e.message); }
  rec.resolve({ response: r });
  return true;
}

/** Whether a question is on screen. */
function isOpen() {
  return !!current;
}

/**
 * The shutdown ceremony: the question on screen is answered as cancel, and so
 * is every question still waiting its turn or asked from now on. Nothing
 * installs or deletes on the way out, and no new layer appears over the
 * shutdown screen.
 */
function shutdown(why) {
  closing = true;
  return current ? settle(current, null, why || 'shutdown') : false;
}

function registerChannels() {
  ipcMain.handle('askbox:payload', (event) => {
    // A view only ever gets its own question, and only the view gets it.
    if (!current || !current.view || current.view.webContents.isDestroyed()) return null;
    if (event.sender !== current.view.webContents) return null;
    const o = current.opts;
    return {
      type: o.type,
      title: o.title,
      message: o.message,
      detail: o.detail,
      buttons: o.buttons.slice(),
      defaultId: o.defaultId,
      cancelId: o.cancelId,
      theme: getTheme()
    };
  });

  ipcMain.on('askbox:respond', (event, index) => {
    if (!current || current.settled) return;
    // Only the view that asked may answer. Compared by webContents identity,
    // because that document has no origin worth checking.
    const wc = current.view && current.view.webContents;
    if (!wc || wc.isDestroyed() || event.sender !== wc) {
      log('rejected an answer from an unexpected sender');
      return;
    }
    const n = Number(index);
    const ok = Number.isInteger(n) && n >= 0 && n < current.opts.buttons.length;
    settle(current, ok ? n : null, ok ? '使用者作答' : '不是一個按鈕的編號，視為取消');
  });
}

module.exports = {
  ask,
  setModalHook,
  setTheme,
  getTheme,
  registerChannels,
  isOpen,
  shutdown,
  normalise,
  THEME_KEYS,
  VALUE_RE,
  THEME_ID_RE
};
