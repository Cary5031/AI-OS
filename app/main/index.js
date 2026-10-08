'use strict';

/* ===========================================================================
   AI-OS // main process
   ---------------------------------------------------------------------------
   Owns the window, the sandbox, the capability gate, the model host, and every
   subsystem that needs something a renderer cannot have: sockets, real paths,
   native views, the clipboard.

   The renderer gets a frameless full-screen surface and a narrow IPC bridge. It
   has no Node access and no path to the filesystem except through ipc.js.

   Shutdown is a first-class operation here, not an afterthought. A machine that
   loses your desktop because you clicked the close button is not a machine you
   trust with anything, so quitting is intercepted, the renderer is given a
   chance to persist everything, and only then does the process exit.
   =========================================================================== */

/* Started as Node rather than as Electron, which is not a thing this process can
   recover from: `require('electron')` hands back the path to the binary instead
   of the API, so every destructured name below is undefined and the first use --
   protocol.registerSchemesAsPrivileged, some seventy lines down -- throws a
   TypeError that names the wrong culprit entirely.

   The cause is almost always an inherited ELECTRON_RUN_AS_NODE=1: VS Code sets
   it for the processes it spawns, so `npm start` from an editor terminal dies
   while the same command in a plain shell is fine. process.versions.electron is
   no help, it still reads 43.4.0 in that mode; the string is the signal.

   Refusing here with the fix in the message, rather than degrading, is what
   this machine already does when index.html is opened in a browser without the
   IPC bridge. */
if (typeof require('electron') === 'string') {
  console.error('FATAL: 這個行程是以 Node 模式啟動的，拿不到 Electron 主程序 API。');
  console.error('多半是編輯器終端傳了 ELECTRON_RUN_AS_NODE=1 進來。啟動前清掉它：');
  console.error('  PowerShell  Remove-Item env:ELECTRON_RUN_AS_NODE; npm start');
  console.error('  cmd         set ELECTRON_RUN_AS_NODE= && npm start');
  console.error('  bash        env -u ELECTRON_RUN_AS_NODE npm start');
  process.exit(1);
}

const { app, BrowserWindow, ipcMain, protocol, shell, session: electronSession } = require('electron');
const path = require('node:path');

const sandbox = require('./sandbox');
const gate = require('./gate');
const llama = require('./llama');
const ipc = require('./ipc');
const memory = require('./memory');
const sessionStore = require('./session');
const browser = require('./browser');
const mail = require('./mail');
const mailtodo = require('./mailtodo');
const forge = require('./forge');
const pdf = require('./pdf');
const bookmarks = require('./bookmarks');
const schedule = require('./schedule');
const prefs = require('./prefs');
const themes = require('./themes');
const askbox = require('./askbox');
const translate = require('./translate');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ARGS = new Set(process.argv.slice(1));

/* ------------------------------------------------------------- where data goes

   Everything the user owns -- the sandbox, the capability policy, long-term
   memory, the session, installed applications, provider settings -- has to live
   somewhere writable, and where that is depends on how this copy was started.

   Running from source it is the repository, which is what it has always been and
   what the tests and the tooling expect. Installed, the application directory is
   inside an asar archive and read-only, and on a normal Windows install it sits
   under Program Files where writing needs an administrator: the only correct
   answer is the per-user data directory. Portable, the whole point is that the
   folder travels, so it is a directory beside the executable -- otherwise the
   "portable" build quietly leaves the user's files on a machine they were
   carrying it away from.

   electron-builder's portable target announces itself through
   PORTABLE_EXECUTABLE_DIR, which is the only way to tell that case from a normal
   packaged run: `app.isPackaged` is true for both. */
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR || null;

function dataHome() {
  if (PORTABLE_DIR) return path.join(PORTABLE_DIR, 'AI-OS-data');
  if (app.isPackaged) return app.getPath('userData');
  return APP_ROOT;
}

/* Redirect userData before anything reads it. Electron resolves the path lazily
   but caches it on first use, and `gate`, `memory`, `forge`, `session` and the
   provider store are all handed `app.getPath('userData')` at boot -- so moving
   it here moves all of them, with no second list to keep in step. Chromium's own
   cache and local storage follow it too, which is what makes the portable build
   actually self-contained rather than merely mostly so. */
if (PORTABLE_DIR) app.setPath('userData', dataHome());

/* ---------------------------------------------------------------- terminal */

/**
 * Write a diagnostic line to the terminal.
 *
 * When stdout is a console, Node hands the string to WriteConsoleW and any
 * script renders correctly whatever the code page is. When stdout is a pipe --
 * `| Tee-Object`, a redirect to a file, an IDE terminal -- Node writes raw
 * UTF-8 and the *consumer* decodes it. On a zh-TW machine that consumer is
 * usually CP950, and multi-byte UTF-8 arrives as mojibake with the line breaks
 * eaten along with it.
 *
 * We cannot reach the consumer from here, so anything non-ASCII is escaped in
 * the piped case: \uXXXX is ugly but lossless and greppable, which beats
 * garbage. Our own log vocabulary is ASCII already; this exists for text we do
 * not control, chiefly forwarded renderer errors.
 */
function term(line, stream = 'log') {
  let s = String(line);
  if (!process.stdout.isTTY) {
    s = s.replace(/[^\x00-\x7f]/g, (ch) =>
      '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  console[stream](s);
}

/* This machine shares a 12 GB card with a 24 GB model, and Chromium's
   compositor is not free. Opt out of GPU acceleration to hand a few hundred MB
   back to llama.cpp, at the cost of smooth animation. */
if (ARGS.has('--disable-gpu-accel')) app.disableHardwareAcceleration();

/* The scheme generated applications are served from. Has to be declared before
   the app is ready, which is why it sits up here rather than next to the
   handler. `standard` so the URL has a host to key on and so an iframe will
   load it at all; `secure` so it is a trustworthy origin and Chromium does not
   treat it as mixed content. Deliberately *not* fetch- or CORS-enabled: the
   frame has no business making requests, and its own CSP says default-src
   'none' as well. See forge.js for why a scheme is needed instead of srcdoc. */
/* The PDF viewer's scheme, declared alongside for the same reason. Unlike the
   frame scheme this one *is* fetch-enabled: pdf.js fetches its own worker, the
   CMap for a CJK encoding, a standard font substitute, a wasm image decoder and
   the document itself. `stream` so a 2 MB worker and a 90 MB scan do not have to
   be buffered whole. Its CSP still pins connect-src to 'self', so all that
   reach ends at its own token. See the VIEWER HOSTING section in main/pdf.js. */
protocol.registerSchemesAsPrivileged([{
  scheme: forge.FRAME_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false }
}, {
  scheme: pdf.VIEW_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

let win = null;
let shuttingDown = false;
let shutdownDone = false;

function getWindow() {
  return win && !win.isDestroyed() ? win : null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 940,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#05070d',
    title: 'AI-OS',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Embedded web content uses WebContentsView in its own session, never a
      // webview inside this document.
      webviewTag: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  /* The saved text size, applied by the process that owns the window as soon
     as there is a document to apply it to. Chromium's page zoom scales every
     CSS pixel -- type, icons, spacing -- which is what "one step larger"
     means to a person, and is the same thing Ctrl+plus does in a browser. */
  win.webContents.on('dom-ready', () => {
    const z = prefs.get().zoom;
    if (z && z !== 1) win.webContents.setZoomFactor(z);
  });

  /* Showing the window is belt and braces, on purpose.
     `ready-to-show` is the signal we want: it means the renderer has painted,
     so the window never appears as a blank rectangle. But it is not
     guaranteed to arrive. It stopped arriving on the development machine
     entirely -- measured, with the renderer fully booted and painting (a CDP
     screenshot of the invisible window came back as a complete desktop) while
     the event never fired -- and the failure of a frameless window that is
     never shown is indistinguishable from the application not starting: no
     window, no error, nothing in the terminal.
     So the load event arms a deadline as well. Whichever comes first reveals
     the window, once, and says which one did it: a machine that has to fall
     back is a machine with something else wrong, and that should be visible
     rather than silently papered over. */
  let shown = false;
  const reveal = (why) => {
    if (shown) return;
    const w = getWindow();
    if (!w) return;
    shown = true;
    w.show();
    if (!ARGS.has('--windowed')) w.setFullScreen(true);
    if (why !== 'ready-to-show') {
      term(`window shown via ${why} -- ready-to-show never fired`, 'error');
    }
  };
  win.once('ready-to-show', () => reveal('ready-to-show'));
  /* The grace period is for the ordinary case: the document has loaded, the
     first paint is milliseconds away, and waiting lets ready-to-show win the
     race so a slow machine still shows a painted window rather than the
     background colour. */
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => reveal('did-finish-load'), 1200);
  });

  // Nothing in this application should open a second window or navigate the
  // shell document somewhere else.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  // Surface renderer errors in the terminal. Without this a frameless
  // full-screen app fails silently, which is a miserable way to debug.
  win.webContents.on('console-message', (...a) => {
    const d = a[1] && typeof a[1] === 'object'
      ? a[1]
      : { level: a[1], message: a[2], lineNumber: a[3], sourceId: a[4] };
    const level = String(d.level);
    if (['error', '3', 'warning', '2'].includes(level)) {
      const where = d.sourceId ? ` (${String(d.sourceId).split('/').pop()}:${d.lineNumber})` : '';
      term(`[renderer:${level}] ${d.message}${where}`, 'error');
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    term(`[renderer gone] ${details.reason} ${details.exitCode}`, 'error');
  });
  win.webContents.on('preload-error', (_e, p, err) => {
    term(`[preload error] ${p} ${err && err.message}`, 'error');
  });

  // Window geometry changes move every attached browser view with it.
  const nudge = nudgeGeometry;
  win.on('resize', nudge);
  win.on('move', nudge);
  win.on('minimize', () => browser.hideAll());
  win.on('restore', nudge);

  // Closing the window is a request to shut down, not the shutdown itself. The
  // first close starts the ceremony and is cancelled; the window is destroyed
  // for real once the renderer has persisted everything.
  win.on('close', (event) => {
    if (shutdownDone) return;
    event.preventDefault();
    beginShutdown('window-close');
  });

  win.on('closed', () => { win = null; });
  gate.setOwnerWindow(win);
  return win;
}

function geometry() {
  const w = getWindow();
  if (!w) return null;
  const b = w.getContentBounds();
  return { width: b.width, height: b.height, fullScreen: w.isFullScreen() };
}

/* Tell the shell the geometry changed, so it lays the browser views out again.
   Also how those views come back after a modal layer had them detached: the
   shell re-measures and re-attaches on this event. */
function nudgeGeometry() {
  const w = getWindow();
  if (w) w.webContents.send('win:geometry', geometry());
}

/** Push kernel log lines to the boot screen as they arrive. */
function wireBootLog() {
  const backlog = llama.onLog((entry) => {
    const w = getWindow();
    if (w) w.webContents.send('llama:log', entry);
  });
  ipcMain.handle('llama:backlog', () => backlog);
}

/**
 * Boot is driven from the renderer so the screen can narrate it, but the work
 * happens here. Resolves with everything the renderer needs to come up.
 */
function wireBoot() {
  ipcMain.handle('boot:run', async () => {
    const steps = [];
    const say = (text, level = 'info') => {
      steps.push({ text, level });
      const w = getWindow();
      if (w) w.webContents.send('boot:step', { text, level });
    };

    try {
      /* Not APP_ROOT: packaged, that is inside the asar and read-only. See
         dataHome() -- the repository when run from source, so nothing about
         development changes. */
      const sb = await sandbox.init(path.join(dataHome(), 'sandbox'));
      say(`sandbox mounted at ${sb.root}`, 'ok');
      const usage = await sandbox.usage();
      say(`  ${usage.files} objects, ${(usage.bytes / 1024).toFixed(1)} KiB of ` +
          `${Math.round(sb.quota.totalBytes / 1024 / 1024)} MiB quota`, 'info');

      const userData = app.getPath('userData');
      await gate.init(userData, getWindow());
      /* While a question is on screen -- the gate's consent window or the
         machine's own confirmation layer -- browser views stay detached, or a
         web page could paint over the very question being asked. When it is
         gone the shell is nudged and lays them out again. */
      const modal = (up) => { browser.suspend(up); if (!up) nudgeGeometry(); };
      gate.setModalHook(modal);
      askbox.setModalHook(modal);
      /* Push the taint state instead of waiting to be asked: this process
         downgrades the elevated capabilities the moment untrusted content is
         read, and the shell has to be able to say so at that moment. */
      gate.setTaintHook((state) => {
        const w = getWindow();
        if (w) w.webContents.send('taint:changed', state);
      });

      /* The sandbox is a real directory, so files arrive in it without asking
         this process first -- dragged in from Explorer, saved there by another
         program. Until this, the shell read the listing at boot and refreshed it
         after its own writes only, so a file added from outside stayed invisible
         until restart, and the machine would answer 「找不到指定檔案」 about a file
         sitting right there. */
      sandbox.watch(() => {
        const w = getWindow();
        if (w) w.webContents.send('fs:changed');
      });
      const pol = gate.getPolicy();
      const deny = Object.values(pol).filter((v) => v === 'deny').length;
      const ask = Object.values(pol).filter((v) => v === 'ask').length;
      say(`capability policy: ${Object.keys(pol).length} caps (${deny} deny, ${ask} ask)`, 'ok');

      const mem = await memory.init(userData);
      say(`long-term memory: ${mem.count} item(s)` +
          (mem.count ? ` (${mem.bySource.manual || 0} manual, ${mem.bySource.learned || 0} learned)` : ' — empty, nothing is seeded'),
          'ok');

      const apps = await forge.init(userData);
      say(`forged applications: ${apps.apps} registered`, 'ok');

      const ui = prefs.get();
      say(`interface: ${ui.locale}, text ${Math.round(ui.zoom * 100)}%`, 'ok');

      const own = await themes.init(userData);
      say(`custom themes: ${own.count}` + (own.dropped ? ` (${own.dropped} unreadable, dropped)` : ''),
          own.dropped ? 'warn' : 'info');

      const marks = await bookmarks.init(userData);
      say(`bookmarks: ${marks.count}`, 'info');

      /* The clock is here; the work is in the renderer. A due job crosses the
         bridge as `schedule:fire`, and the renderer says `schedule:ready`
         once it can catch one -- until then nothing fires, so a job cannot be
         marked running with nobody there to run it. */
      const jobs = await schedule.init(userData);
      schedule.setSender((payload) => {
        const w = getWindow();
        if (w) w.webContents.send('schedule:fire', payload);
      });
      schedule.start();
      say(`scheduler: ${jobs.count} job(s)`, 'info');

      const providers = await llama.initProviders(userData);
      const activeProvider = providers.providers.find((p) => p.id === providers.active);
      say(`core model provider: ${activeProvider.label}` +
          (activeProvider.remote ? ' (remote — prompts leave this machine)' : '') +
          (providers.sealed ? '' : ' — no OS keychain, credentials cannot be stored'),
          activeProvider.remote ? 'warn' : 'ok');

      const mailStatus = await mail.init(userData);
      say(mailStatus.configured
        ? `mail account: ${mailStatus.email} via ${mailStatus.imapHost || mailStatus.base || 'web'}`
        : 'mail account: not configured', mailStatus.configured ? 'ok' : 'info');

      const todo = await mailtodo.init(userData);
      say(`mail todo: ${todo.rules.length} rules, ${todo.items.length} items`, 'info');

      await sessionStore.init(userData);
      const restored = await sessionStore.load();
      say(restored.ok
        ? `previous session found (${restored.session.windows.length} window(s), ${restored.session.context.length} context page(s))`
        : 'no previous session to restore', 'info');

      browser.init(getWindow(), (tabId, event, payload) => {
        const w = getWindow();
        if (w) w.webContents.send('browser:event', { tabId, event, payload });
      });
      say('browser session isolated at ' + browser.PARTITION, 'ok');

      /* Page translation. Reads its settings and its cache from userData, and
         takes the page-ready hook off browser.js so a tab that was being
         translated gets its agent back after a navigation. */
      const tr = await translate.init(userData);
      say(`translate: ${tr.settings.target}, cache ${tr.cache.entries} segments` +
          (tr.settings.auto !== 'off' ? `, auto ${tr.settings.auto}` : ''), 'info');

      say('starting model host ...', 'hi');
      /* Not being able to start a model host is the same class of problem as a
         handshake that fails, and gets the same answer: say so and carry on.
         Letting it throw took the whole boot with it, and the boot is what
         carries the sandbox root, the capability policy, the syscall table, the
         installed applications and the restored session -- so a missing model
         left a machine with no files, no policy and no apps, which looks like a
         far worse fault than the one that happened.

         It is the first run of a fresh copy that finds this: the default
         provider is the local one, and the local one is started by a script that
         lives outside this project. Nobody who has just installed this has that
         script, and the fix -- choosing a provider -- is in the window that
         failed to come up. */
      try {
        const started = await llama.start(APP_ROOT, { noSpawn: ARGS.has('--no-spawn-llama') });
        if (started.reason === 'no-spawn') {
          say('  --no-spawn-llama: no local model host will be started', 'warn');
        } else if (started.skipped) {
          say('  hosted core selected, no local server needed', 'info');
        } else {
          say(started.attached ? '  attached to a running kernel' : '  kernel spawned', 'ok');
        }
      } catch (e) {
        say('  model host did not start: ' + e.message, 'error');
        say('  open 系統 → 核心模型 to choose a core', 'info');
      }

      /* A handshake that fails must not fail the boot. A wrong key or an expired
         one is fixed in the provider window, and that window is in the shell
         that is trying to come up -- refusing to start would leave the user with
         no way to correct the setting that stopped it. */
      let p = { model: null, nCtx: 0, nCtxSource: '', nCtxSourceName: '', maxOut: 0, tokenizer: true };
      try {
        p = await llama.probeActive();
        say(`  model .... ${p.model}`, 'ok');
        if (p.nCtx) say(`  n_ctx .... ${p.nCtx.toLocaleString()}`, 'ok');
        if (!p.tokenizer) say('  tokenizer  none, the scheduler will estimate', 'warn');
      } catch (e) {
        say('  handshake failed: ' + e.message, 'error');
        say('  open 系統 → 核心模型 to fix the provider settings', 'info');
      }

      return {
        ok: true,
        sandboxRoot: sb.root,
        quota: sb.quota,
        ops: gate.OPS,
        elevated: gate.ELEVATED,
        policy: pol,
        // What each capability permits, for the gate's tooltips. One source, in
        // the process that enforces the policy.
        capNotes: gate.CAP_NOTES,
        taint: gate.taintState(),
        memory: mem,
        mail: mailStatus,
        apps: await forge.listApps(),
        session: restored.ok ? restored.session : null,
        sessionFromBackup: !!restored.fromBackup,
        model: p.model,
        nCtx: p.nCtx,
        /* Where the number came from, so the line that shows it can say. */
        nCtxSource: p.nCtxSource || '',
        nCtxSourceName: p.nCtxSourceName || '',
        maxOut: p.maxOut || 0,
        tokenizer: p.tokenizer !== false,
        providers,
        endpoint: llama.localEndpoint(),
        geometry: geometry(),
        /* The user's own themes travel with the boot reply so the renderer has
           them installed before it restores a session that may name one. */
        themes: themes.list(),
        prefs: prefs.get(),
        steps
      };
    } catch (e) {
      say('boot failed: ' + e.message, 'error');
      return { ok: false, error: e.message, steps, endpoint: llama.localEndpoint() };
    }
  });
}

/* ===========================================================================
   Shutdown
   ---------------------------------------------------------------------------
   Closing the window starts a ceremony rather than ending the process. The
   renderer runs the visible part and calls back when its state is safe on disk;
   this side enforces a deadline so a wedged renderer cannot keep the machine
   alive forever.
   =========================================================================== */

const SHUTDOWN_DEADLINE_MS = 20000;

function wireShutdown() {
  // The renderer reports progress purely so the log ends up in one place. It
  // sends an ASCII form of each step, not the localised sentence it puts on
  // screen -- see the note on term() and the ceremony in renderer/shell.js.
  ipcMain.handle('shutdown:step', async (_e, { text } = {}) => {
    term(`[shutdown] ${text}`);
    return { ok: true };
  });

  // Called by the renderer once every subsystem it owns has been persisted.
  ipcMain.handle('shutdown:ready', async () => {
    await finishShutdown('renderer-ready');
    return { ok: true };
  });

  ipcMain.handle('shutdown:begin', async () => {
    beginShutdown('requested');
    return { ok: true };
  });
}

function beginShutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  term('[shutdown] begin: ' + why);

  /* Browser views come down and stay down: suspended rather than hidden, so
     the nudge that follows a closing dialog cannot bring one back over the
     shutdown screen. Then the question on screen, if any, is answered as
     cancel and no later one is shown -- nothing installs or deletes on the
     way out. */
  browser.suspend(true);
  askbox.shutdown('shutdown');
  const w = getWindow();
  if (w) w.webContents.send('shutdown:start', { why });

  // A renderer that never answers must not strand the model in memory.
  setTimeout(() => {
    if (!shutdownDone) {
      term('[shutdown] renderer did not finish in time, continuing anyway', 'warn');
      finishShutdown('deadline');
    }
  }, SHUTDOWN_DEADLINE_MS);
}

async function finishShutdown(why) {
  if (shutdownDone) return;
  shutdownDone = true;
  term('[shutdown] finishing: ' + why);

  try { await memory.flush(); } catch (e) { term('[shutdown] memory flush failed: ' + e.message, 'error'); }
  /* Translation loops stop and the translation cache goes to disk. It is
     written on a timer while the machine runs, so quitting inside that window
     would throw away work that has already been paid for. */
  try {
    const tr = await translate.shutdown();
    if (tr && tr.written) term(`[shutdown] translation cache: ${tr.written} segments`);
  } catch (e) { term('[shutdown] translate flush failed: ' + e.message, 'error'); }
  try { browser.destroyAll(); } catch { /* ignore */ }
  reclaimKernel('shutdown');

  const w = getWindow();
  if (w) w.destroy();      // shutdownDone is set, so the close guard stands down
  app.quit();
}

let reclaimed = false;
function reclaimKernel(why) {
  if (reclaimed) return;
  reclaimed = true;
  const r = llama.stop();
  term(`[kernel] reclaim on ${why}: ${JSON.stringify(r)}`);
}

/* ============================================================== lifecycle */

app.whenReady().then(() => {
  // Deny every permission request outright: this document has no legitimate
  // need for camera, microphone, geolocation or notifications.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));

  // Serve generated applications. The policy travels with the response so the
  // frame's limits are set by this process, not by markup the model wrote.
  protocol.handle(forge.FRAME_SCHEME, (request) => {
    const hit = forge.serveFrame(request.url);
    if (!hit) return new Response('not found', { status: 404 });
    return new Response(hit.html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // Inline script and style are unavoidable: there is no origin to load
        // assets from. Everything that could reach off this machine is off.
        // No frame-ancestors: the shell document is file:// and would not match
        // 'self', which would block the very embedding this exists for. Nothing
        // else can reach these URLs anyway -- the token is random and the
        // scheme is only handled inside this process.
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
          "img-src data:; form-action 'none'; base-uri 'none'"
      }
    });
  });

  /* Serve the PDF viewer. Same principle as above -- the policy is set here, not
     by the document -- but the allowances differ because pdf.js has real work to
     do:

       script-src 'self' 'wasm-unsafe-eval'   its own modules, plus compiling the
                                              JBIG2/JPEG2000/colour decoders
       worker-src 'self' blob:                the parser runs off the main thread
       connect-src 'self'                     CMaps, fonts, wasm, the document
       img-src / font-src blob: data:         canvases and embedded font faces
       style-src 'unsafe-inline'              the text layer positions every span
                                              with a style attribute

     Note what is absent: no https:, no http:, no frame-src. A document that gets
     script running in here can draw and can read its own token, and cannot send
     a single byte off this machine. frame-ancestors is omitted for the same
     reason as the frame scheme: the shell is file:// and would not match 'self'.
     Content is inert regardless -- form-action and object-src are 'none'. */
  protocol.handle(pdf.VIEW_SCHEME, async (request) => {
    const hit = pdf.serveView(request.url);
    if (!hit) return new Response('not found', { status: 404 });

    let body;
    if (hit.body !== undefined) {
      // Assembled in memory: a document on its way to becoming a PDF.
      body = hit.body;
    } else {
      try {
        body = await pdf.readViewFile(hit.file);
      } catch {
        return new Response('not found', { status: 404 });
      }
    }

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': hit.type,
        'cache-control': 'no-store',
        /* The route may ask for something stricter than the viewer needs. A print
           document is static, so it gets script-src 'none' -- see serveView. */
        'content-security-policy': hit.csp ||
          "default-src 'none'; " +
          "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; " +
          "style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; " +
          "font-src 'self' blob: data:; connect-src 'self'; " +
          "object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"
      }
    });
  });

  wireBootLog();
  wireBoot();
  wireShutdown();
  ipc.register(getWindow);
  /* Before the window: the language and the text size have to be known by
     the time the document asks for them, and the file is tiny. */
  prefs.init(app.getPath('userData')).then(() => {
    const w = getWindow();
    if (w && prefs.get().zoom !== 1) w.webContents.setZoomFactor(prefs.get().zoom);
  }).catch(() => { /* defaults stand */ });
  createWindow();

  ipcMain.handle('win:geometry', () => geometry());

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

// Intercept the quit so the ceremony gets to run first.
app.on('before-quit', (event) => {
  if (shutdownDone) return;
  event.preventDefault();
  beginShutdown('before-quit');
});

app.on('window-all-closed', () => {
  if (shutdownDone) app.quit();
  else beginShutdown('window-all-closed');
});

// A crash or an external signal should not leave a 24 GB model resident.
process.on('exit', () => reclaimKernel('exit'));
process.on('SIGINT', () => { reclaimKernel('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { reclaimKernel('SIGTERM'); process.exit(0); });
