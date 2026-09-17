'use strict';

/* ===========================================================================
   AI-OS // syscall boundary
   ---------------------------------------------------------------------------
   Every handler here follows the same shape:

     1. The op name is decided by the handler, never taken from the caller. The
        renderer cannot ask to run fs.delete under the fs.read capability.
     2. gate.authorize() runs before any filesystem work, and resolves 'ask'
        with the human in a window this process owns.
     3. sandbox.* does the work, and it re-validates every path itself.

   Handlers return { ok, ... } instead of throwing across the bridge, so the
   renderer always gets a reason it can put in the journal.
   =========================================================================== */

const { ipcMain, dialog, shell, clipboard, app } = require('electron');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const sandbox = require('./sandbox');
const preset = require('./preset');
const bookmarks = require('./bookmarks');
const gate = require('./gate');
const llama = require('./llama');
const memory = require('./memory');
const session = require('./session');
const web = require('./web');
const browser = require('./browser');
const mail = require('./mail');
const mailtodo = require('./mailtodo');
const office = require('./office');
const pdf = require('./pdf');
const pdfedit = require('./pdfedit');
const forge = require('./forge');
const schedule = require('./schedule');
const prefs = require('./prefs');
const themes = require('./themes');
const askbox = require('./askbox');
const translate = require('./translate');
const extract = require('./extract');

/**
 * Uniform wrapper: validate, authorise, run, report.
 *
 * Validation deliberately runs before authorisation. Asking the human to
 * approve an operation that cannot possibly succeed teaches them to click
 * through these dialogs, which is the fastest way to make a consent prompt
 * worthless. A request naming a path outside the sandbox is refused on the
 * spot, silently, and never becomes a question.
 */
/**
 * Wrap a handler in the capability gate.
 *
 * `op` names a syscall in the gate's table, and the consent dialog describes the
 * request with that syscall's own wording. That is right when a channel is the
 * syscall, and wrong as soon as several channels share one: four channels are
 * gated under `app.create`, whose description is 「沒有現成程式時，寫一個新的」, so
 * *uninstalling* a program asked the user to approve writing a new one. A dialog
 * that misnames the action cannot produce informed consent.
 *
 * `what` names the actual operation and wins over the syscall's description. It is
 * optional, and required in practice wherever an op is shared -- see the test that
 * enforces exactly that.
 */
function guarded(op, fn, precheck, what) {
  return async (_event, args = {}) => {
    if (precheck) {
      try {
        precheck(args);
      } catch (e) {
        return { ok: false, code: e.code || 'EINVAL', error: e.message, op, prechecked: true };
      }
    }

    let auth;
    try {
      auth = await gate.authorize(op, args, { why: args && args.__why, what: what });
    } catch (e) {
      return { ok: false, code: 'EGATE', error: e.message, op };
    }
    if (!auth.ok) {
      const code = { refused: 'EREFUSED', busy: 'EBUSY' }[auth.verdict.decision] || 'EDENIED';
      return { ok: false, code, error: auth.verdict.reason, verdict: auth.verdict, op };
    }
    try {
      const data = await fn(args);
      return { ok: true, data, verdict: auth.verdict, op };
    } catch (e) {
      return { ok: false, code: e.code || 'EFAIL', error: e.message, detail: e.detail, verdict: auth.verdict, op };
    }
  };
}

/** Unguarded, for reads of machine state that carry no file contents. */
function plain(fn) {
  return async (_event, args = {}) => {
    try {
      return { ok: true, data: await fn(args) };
    } catch (e) {
      /* `detail` is the evidence a failure carried with it -- what was asked,
         what came back, what status. Without it every remote failure arrives as
         one sentence and the window has nothing to show but that sentence, even
         when the sentence is about the wrong problem. Only set by code that
         built it deliberately, and it never carries a credential. */
      return { ok: false, code: e.code || 'EFAIL', error: e.message, detail: e.detail };
    }
  };
}

/* The machine's own message box.

   Three things here stop to ask a person: emptying the trash, installing a
   build with the confirmation switch on, and importing a program someone else
   made. Each used to be dialog.showMessageBox -- an operating-system task
   dialog, in the operating system's font and colours, floating over a machine
   that draws everything else itself. askbox.js draws the same question inside
   the AI-OS window, in the current theme and text size, as a layer this
   process owns: the renderer still cannot answer for the user, and a test can
   now press the real button through CDP instead of being routed around it
   (e2e/lib/dialog.mjs). The contract is showMessageBox's, so the three callers
   below did not change: {type, buttons, defaultId, cancelId, title, message,
   detail} in, {response} out. The one native dialog left is the file picker,
   which is the operating system's to draw. */
const askBox = askbox.ask;

function register(getWindow) {
  gate.registerConsentChannels();
  askbox.registerChannels();

  /* Translation progress. The events are pushed from here rather than from
     translate.js so that every channel this renderer listens on is registered
     in one file, which is what the wiring test checks and what makes the
     bridge readable. Counts and phase only -- never a paragraph. */
  translate.setProgressHook((p) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('translate:progress', p);
  });

  /* ---------------------------------------------------------- system ---- */

  /* What is running. The version lived only in the exe's file name, in
     package.json and in the file-properties dialog -- none of them visible
     from inside the machine, and a bug report that says "the portable one"
     names nothing. This is the identity block the 版本說明 window shows and
     copies: version, how it was launched, the engines, where the data is,
     and the release notes shipped beside the code. `app.isPackaged` is true
     for both the installer and the portable exe; PORTABLE_EXECUTABLE_DIR is
     what tells them apart, the same way index.js decides where data lives. */
  ipcMain.handle('sys:about', plain(async () => {
    const portable = !!process.env.PORTABLE_EXECUTABLE_DIR;
    const mode = portable ? 'portable' : app.isPackaged ? 'installed' : 'source';
    let notes = [];
    try {
      notes = JSON.parse(nodeFs.readFileSync(nodePath.join(__dirname, '..', 'release-notes.json'), 'utf8'));
      if (!Array.isArray(notes)) notes = [];
    } catch { notes = []; }
    return {
      name: app.getName(),
      version: app.getVersion(),
      mode,
      modeLabel: mode === 'portable' ? '免安裝版' : mode === 'installed' ? '安裝版' : '從原始碼執行',
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform + ' ' + process.arch,
      dataHome: app.getPath('userData'),
      notes
    };
  }));

  ipcMain.handle('sys:info', plain(async () => ({
    sandboxRoot: sandbox.root(),
    quota: sandbox.QUOTA,
    ops: gate.OPS,
    elevated: gate.ELEVATED,
    policy: gate.getPolicy(),
    capNotes: gate.CAP_NOTES,
    taint: gate.taintState(),
    usage: await sandbox.usage(),
    llama: llama.status(),
    memory: memory.summary(),
    mail: mail.status(),
    apps: await forge.listApps(),
    appCaps: forge.APP_CAPS,
    /* Which of them stop an install to ask. The build log needs it to say it is
       waiting for a dialog rather than showing 「4/4　安裝…」 while a modal sits
       unnoticed behind the window -- an install that waited four minutes read as
       a hang. Shipped from here so main stays the only place the line is drawn. */
    appCapsNeedingConsent: forge.CAPS_REACHING_OUT,
    /* Interface language and text size, in the same reply the boot already
       makes, so the shell can paint once in the right language and size. */
    prefs: prefs.get()
  })));

  /* Interface preferences. Ungated: the language of the menus and the size of
     the type are nobody's secret and change nothing outside this window. The
     zoom is applied here, by the process that owns the window, so a stale
     renderer cannot leave it at odds with what was saved. */
  ipcMain.handle('prefs:get', plain(async () => prefs.get()));
  ipcMain.handle('prefs:set', plain(async (patch = {}) => {
    const out = await prefs.set(patch);
    const w = getWindow();
    if (w && patch.zoom !== undefined) w.webContents.setZoomFactor(out.zoom);
    return out;
  }));

  /* Custom themes. Ungated like the preferences beside them -- a palette
     changes nothing outside this window -- and validated in the store, which
     refuses anything that is not a colour before it can reach a stylesheet. */
  ipcMain.handle('themes:list', plain(async () => themes.list()));
  ipcMain.handle('themes:save', plain(async (theme = {}) => themes.save(theme)));
  ipcMain.handle('themes:remove', plain(async ({ id } = {}) => themes.remove(id)));
  /* The theme the shell is painting with, reported whenever it changes, so the
     confirmation layer (askbox.js) wears the same colours. Cosmetic, and
     validated there: colour-shaped values under the twenty theme keys, nothing
     else. */
  ipcMain.handle('themes:current', plain(async (snap = {}) => askbox.setTheme(snap)));

  ipcMain.handle('policy:set', plain(async ({ cap, value }) => gate.setPolicy(cap, value)));
  ipcMain.handle('policy:get', plain(async () => gate.getPolicy()));

  /* One question about a whole batch, asked and granted by this process.
     The shell may ask for it and will be shown the answer; it cannot approve
     anything itself, which is the same rule every other gated call follows. */
  ipcMain.handle('gate:askBatch', plain(async ({ op, items, what } = {}) =>
    gate.askBatch({ op: String(op || ''), items: Array.isArray(items) ? items : [], what })));
  ipcMain.handle('gate:clearGrants', plain(async () => gate.clearGrants()));

  /* The shell saying 「接下來這段是排程在跑，沒有人在」. Ungated, and safe
     ungated, because it only ever narrows what the gate will do: while it is
     set, anything that would have opened a consent dialog is refused instead.
     A renderer that set it dishonestly would be denying itself. */
  ipcMain.handle('gate:unattended', plain(async ({ on } = {}) => gate.setUnattended(!!on)));

  ipcMain.handle('taint:state', plain(async () => gate.taintState()));

  /* What the user typed, so the gate can tell an instruction they gave from one
     that arrived inside a document. Needs no capability for the same reason
     taint:add needs none: the only thing a caller can do with it is describe the
     request, and a request that names nothing gets asked about exactly as
     before. Naming a target it was never given cannot manufacture authority
     either -- the operation still has to be one the policy allows. */
  ipcMain.handle('intent:set', plain(async ({ text } = {}) => ({
    intent: gate.setIntent(text)
  })));
  ipcMain.handle('taint:clear', plain(async () => gate.clearTaint()));

  // Arming taint is a request to *reduce* the renderer's own authority, so it
  // needs no capability: the worst a compromised renderer can do with it is
  // make the machine ask the user more often. Clearing stays user-only.
  ipcMain.handle('taint:add', plain(async ({ source, label } = {}) => {
    if (!source) throw new Error('沒有給來源');
    return gate.addTaint(String(source).slice(0, 300), String(label || source).slice(0, 300));
  }));

  ipcMain.handle('llama:status', plain(async () => llama.status()));

  /* --------------------------------------------------- core model host ---- */

  /* None of these pass through the gate, and each for its own reason.
     Reading provider state carries no secret -- it reports whether a key exists,
     never the key -- so it is machine state like llama:status. Choosing a
     provider and storing its credentials are user gestures made in this shell's
     own window, which is how the mail account is configured too; a model cannot
     reach them, because they are not in the syscall table.

     model:chat is the one that would seem to want a capability, and must not
     have one: it is the call the machine makes to think. A consent prompt on
     every turn is a consent prompt nobody reads. The real decision -- that
     prompts, including file contents that were read into context, will leave
     this machine -- is made once when a remote provider is selected, and it is
     stated there in those words. */
  ipcMain.handle('model:state', plain(async () => llama.providerState()));
  ipcMain.handle('model:select', plain(async ({ id } = {}) => llama.selectProvider(String(id || ''))));
  ipcMain.handle('model:configure', plain(async ({ id, patch } = {}) =>
    llama.configureProvider(String(id || ''), patch || {})));
  ipcMain.handle('model:setSecret', plain(async ({ id, key, headers } = {}) =>
    llama.setSecret(String(id || ''), { key: key, headers: headers })));
  ipcMain.handle('model:forgetSecret', plain(async ({ id } = {}) => llama.forgetSecret(String(id || ''))));

  /* Freeze the current core settings into the build's shipped preset, so a fresh
     install arrives already configured. Authoring only: refused in a packaged
     application, where the target path is inside a read-only asar and nobody has
     a reason to be making one. `app.isPackaged` is read here rather than trusted
     from the renderer. */
  ipcMain.handle('model:exportPreset', plain(async () =>
    llama.exportPreset({ packaged: app.isPackaged })));
  ipcMain.handle('model:presetState', plain(async () => ({
    exists: await preset.exists(),
    canAuthor: !app.isPackaged,
    file: preset.PRESET_FILE
  })));
  ipcMain.handle('model:probe', plain(async () => llama.probeActive()));
  ipcMain.handle('model:models', plain(async ({ id } = {}) => llama.listModels(String(id || ''))));
  ipcMain.handle('model:tokenize', plain(async ({ text } = {}) => ({
    tokens: await llama.tokenizeActive(text)
  })));
  ipcMain.handle('model:abort', plain(async ({ requestId } = {}) =>
    llama.abortActive(requestId == null ? null : String(requestId))));

  /**
   * One streamed completion.
   *
   * Frames are forwarded as they arrive and the promise settles when the stream
   * ends, so the caller gets both the live tokens and one place to find out how
   * it finished. The frames are the provider's own SSE payloads, unchanged: the
   * renderer already knows how to read a delta, a reasoning trace and llama.cpp's
   * timings, and none of that reading is provider-specific.
   */
  ipcMain.handle('model:chat', async (_event, args = {}) => {
    const requestId = String((args && args.requestId) || '');
    if (!requestId) return { ok: false, code: 'EINVAL', error: '沒有給 requestId' };
    try {
      const out = await llama.chatActive(requestId, (args && args.req) || {}, (frame) => {
        const w = getWindow();
        if (w && !w.isDestroyed()) {
          w.webContents.send('model:chunk', { requestId, frame });
        }
      });
      return { ok: true, data: out };
    } catch (e) {
      // An abort is the stop button working, not a failure to report as one.
      if (e && e.name === 'AbortError') return { ok: false, code: 'EABORT', error: '已中止' };
      /* `detail` is the evidence a failure carried with it -- what was asked,
         what came back, what status. Without it every remote failure arrives as
         one sentence and the window has nothing to show but that sentence, even
         when the sentence is about the wrong problem. Only set by code that
         built it deliberately, and it never carries a credential. */
      return { ok: false, code: e.code || 'EFAIL', error: e.message, detail: e.detail };
    }
  });

  /* ------------------------------------------------ document extraction ---- */

  /* Two backends belonging to one program rather than to the machine, and they
     are not equals: the prompt studio is the default, and a cloud model called
     directly is what happens when the studio cannot be reached. Separate
     endpoints, separate keys, separate settings file. Nothing here reads or
     writes the core model's configuration, and nothing there reads this one's.

     The settings calls are plain() for the same reason the core model's are:
     they are user gestures made in this shell's own window, they report whether
     a credential exists and never what it is, and no model can reach them
     because they are not in the syscall table. `resolve` is a health check
     against an address the user typed, carrying no document, so it belongs with
     them rather than behind the gate.

     The two that actually carry a document answer to doc.extract, which is a
     switch of its own in the capability panel -- see gate.js. */
  ipcMain.handle('extract:state', plain(async () => extract.state()));
  ipcMain.handle('extract:configure', plain(async ({ which, patch } = {}) =>
    extract.configure(which === undefined ? null : which, patch || {})));
  ipcMain.handle('extract:setSecret', plain(async ({ which, key, headers } = {}) =>
    extract.setSecret(which, { key, headers })));
  ipcMain.handle('extract:forgetSecret', plain(async ({ which } = {}) => extract.forgetSecret(which)));
  ipcMain.handle('extract:probe', plain(async ({ which } = {}) => extract.probe(which)));
  ipcMain.handle('extract:resolve', plain(async ({ force } = {}) => extract.resolve({ force: !!force })));

  /* What the studio last said exists. Kept in this process beside the settings,
     because its job is to still be there when the studio is not. */
  ipcMain.handle('extract:catalog', plain(async () => extract.catalog()));

  /* Bind the work that follows to one engine, and let go of it. Enforced in
     main because mixing two engines inside one result set is wrong in a way
     nothing on the resulting page admits to -- see extract.js beginBatch. */
  ipcMain.handle('extract:beginBatch', plain(async ({ which } = {}) => extract.beginBatch(which)));
  ipcMain.handle('extract:endBatch', plain(async ({ token } = {}) => extract.endBatch(token)));
  ipcMain.handle('extract:saveCatalog', plain(async ({ patch } = {}) => {
    const wrote = await extract.saveCatalog(patch || {});
    return Object.assign(extract.catalog(), { persisted: wrote });
  }));

  /* One document to the FALLBACK model, with a prompt the window supplies from a
     local profile. Not the usual path: the usual path is extract:call below,
     which hands the batch to the prompt studio.

     The renderer names a sandbox path, never bytes: a 10 MiB PDF would otherwise
     cross the bridge twice to get somewhere the main process could have read it
     from directly, and the window would be holding the document for no reason. */
  ipcMain.handle('extract:send', guarded('extract.send', async (args = {}) => {
    const r = await sandbox.safe(args.path, { kind: 'file', mustExist: true });
    const file = await sandbox.readBytes(args.path);
    /* The document is untrusted content, and the rows coming back are its words
       rearranged. Armed here, in the process that enforces it, exactly as
       fs:readBytes does -- routing a file through a model does not launder it. */
    if (file.untrusted) gate.addTaint(file.vpath, file.vpath);

    /* A PDF with no text layer is a picture, and a picture read as a PDF gives
       nothing back. Drawing its pages out is done HERE rather than in the
       window, for the same reason the bytes are read here: the renderer names a
       sandbox path and never handles the document.

       Only for a PDF, and only when it really has no text anywhere. A file that
       has a text layer already carries the association between a part number and
       the quantity printed beside it, which is the thing worth protecting -- see
       "WHY THE PDF GOES WHOLE" in extract.js. Pictures are added for the file
       that has none of that, and the file still goes with them. */
    let images = [];
    let rastered = null;
    const looksPdf = String(args.mimeType || 'application/pdf').toLowerCase() === 'application/pdf';
    if (looksPdf) {
      try {
        const doc = pdf.read(Buffer.from(file.base64, 'base64'));
        if (doc.ok && doc.textless && (doc.emptyReasons || []).includes('image')) {
          /* The pages get the room, not the leftovers. Budgeting them against
             what the file left over is how a 13 MiB scan ends up drawn at 900px
             to make space for the very bytes those pages already are -- the file
             and the drawing are the same picture. So: keep both when there is
             comfortably enough for both, and otherwise give the pages the whole
             request and let generate() drop the file, which for a scan costs
             nothing. The slack is the prompt and the schema, which travel in the
             same body. */
          const slack = 256 * 1024;
          const alongside = extract.MAX_INLINE - file.bytes - slack;
          const budget = alongside >= 4 * 1024 * 1024
            ? alongside
            : extract.MAX_INLINE - slack;
          const shot = await pdf.rasterize({ real: r.real, vpath: r.vpath }, { budget });
          images = shot.pages || [];
          rastered = { pages: images.length, bytes: shot.bytes, shrunk: !!shot.shrunk };
        }
      } catch (e) {
        /* A document that could not be drawn is still a document worth sending:
           the backends read PDFs too, and this is the path that makes a scan
           work rather than the path that makes anything work. The window is told
           so it can say the pages did not come out, instead of silently getting
           the empty rows a scan gives on its own. */
        rastered = { pages: 0, error: e.message || String(e) };
      }
    }

    const out = await extract.generate({
      base64: file.base64,
      images: images,
      filename: String(file.vpath || '').split('/').pop(),
      mimeType: args.mimeType,
      prompt: args.prompt,
      columns: args.columns,
      temperature: args.temperature
    });
    return Object.assign(out, { path: file.vpath, untrusted: !!file.untrusted, rastered });
  }, (args) => { sandbox.resolve(args.path); }, '把一份沙箱文件送到備援的萃取模型'));

  /* Asking the studio something. Listing the categories, the vendors, a
     column layout, how a job is getting on, what it produced.

     Ungated, and the path allowlist is why that is safe: these carry nothing
     out of this machine, the renderer cannot name a path outside the list, and
     a job that takes ten minutes polls several hundred times. Putting those
     behind the capability would mean an operator who set doc.extract to ASK
     answers a dialog every two seconds, each one claiming a document is being
     sent -- which is both untrue and the surest way to teach somebody to press
     allow without reading. Enforced here rather than by trusting the window's
     own idea of what it is doing. */
  ipcMain.handle('extract:call', plain(async ({ spec } = {}) => {
    const s = Object.assign({}, spec || {});
    if (extract.classifyRequest(s.method || 'GET', s.path) !== 'read') {
      throw Object.assign(new Error('這不是一個唯讀的工作室請求：' +
        String(s.method || 'GET') + ' ' + String(s.path || '')), { code: 'EINVAL' });
    }
    delete s.files;
    delete s.paths;
    delete s.json;
    delete s.fields;
    s.method = 'GET';
    return extract.call(s);
  }));

  /* Handing the studio something: a batch of PDFs to parse, the rows back for
     a naming plan, a nudge to retry the ones that failed.

     `spec.paths` names sandbox files, and the bytes are read here rather than
     in the window for the same reason as extract:send -- a 10 MiB PDF would
     otherwise cross the bridge twice to reach a process that could have read
     it directly.

     Reading a document arms the taint downgrade even though the extraction is
     happening elsewhere. Sending a file to a service and getting its contents
     back as rows does not launder it. */
  ipcMain.handle('extract:upload', guarded('extract.send', async ({ spec } = {}) => {
    const s = Object.assign({}, spec || {});
    if (extract.classifyRequest(s.method || 'POST', s.path) !== 'write') {
      throw Object.assign(new Error('這不是一個工作室接受的送出請求：' +
        String(s.method || 'POST') + ' ' + String(s.path || '')), { code: 'EINVAL' });
    }
    s.method = 'POST';
    const paths = Array.isArray(s.paths) ? s.paths : [];
    delete s.paths;
    if (paths.length) {
      s.files = [];
      for (const p of paths) {
        const file = await sandbox.readBytes(p);
        if (file.untrusted) gate.addTaint(file.vpath, file.vpath);
        s.files.push({
          field: 'files',
          filename: String(file.vpath || '').split('/').pop(),
          type: 'application/pdf',
          base64: file.base64
        });
      }
    }
    return extract.call(s);
  }, (args) => {
    ((args && args.spec && args.spec.paths) || []).forEach((p) => sandbox.resolve(p));
  }, '把文件或萃取結果送到提示詞工作室'));

  /* ------------------------------------------------------ filesystem ---- */

  // Names and sizes only, no file contents: this is machine state, and the
  // model needs it every turn to keep from inventing paths. Gating it behind a
  // prompt would make the machine ask permission to know what it owns.
  /* Search by name and by content. Gated on fs.read like every other look at
     the sandbox: it reads files, so it answers to the capability for reading
     files. Bounded inside sandbox.find, and the result says when it stopped
     early -- a search that quietly gave up reports 「找不到」 about a file that
     is there. */
  ipcMain.handle('fs:find', guarded('fs.read', async ({ query, dir, content } = {}) =>
    sandbox.find(query, { dir, content }), null, '搜尋沙箱裡的檔案名稱與內容'));

  ipcMain.handle('fs:tree', plain(async () => sandbox.tree()));
  ipcMain.handle('fs:usage', plain(async () => sandbox.usage()));
  ipcMain.handle('fs:trashList', plain(async () => sandbox.trashList()));

  // Cheap, purely syntactic path checks, run before anyone is asked anything.
  const okPath = (key) => (args) => { sandbox.resolve(args[key]); };
  const okPair = (a, b) => (args) => { sandbox.resolve(args[a]); sandbox.resolve(args[b]); };

  ipcMain.handle('fs:list', guarded('fs.list',
    async ({ dir }) => sandbox.list(dir || '/'),
    (args) => { if (args.dir && args.dir !== '/') sandbox.resolve(args.dir); }));

  ipcMain.handle('fs:read', guarded('fs.read', async ({ path: p }) => {
    const out = await sandbox.read(p);
    // Reading hostile content is what arms the gate for the rest of the
    // session. Recorded here, in the process that enforces it.
    if (out.untrusted) gate.addTaint(out.vpath, out.vpath);
    return out;
  }, okPath('path'), '讀取一個沙箱檔案的內容'));

  /* expectMtime rides along so an editor can say which version it is replacing.
     Checked in sandbox.write, next to the stat it already does -- the renderer
     cannot be the one to decide whether its own write is safe. */
  ipcMain.handle('fs:write', guarded('fs.write',
    async ({ path: p, content, expectMtime }) =>
      sandbox.write(p, content, { origin: 'local', expectMtime }),
    okPath('path')));

  // Byte-level access for the binary formats. Same capabilities as the text
  // paths: what matters is read versus write, not the encoding.
  ipcMain.handle('fs:readBytes', guarded('fs.read', async ({ path: p }) => {
    const out = await sandbox.readBytes(p);
    if (out.untrusted) gate.addTaint(out.vpath, out.vpath);
    return out;
  }, okPath('path'), '讀取一個沙箱檔案的位元組'));

  ipcMain.handle('fs:writeBytes', guarded('fs.write',
    async ({ path: p, base64, expectMtime }) =>
      sandbox.writeBytes(p, base64, { origin: 'local', expectMtime }),
    okPath('path'), '寫入一個二進位檔到沙箱'));

  ipcMain.handle('fs:copy', guarded('fs.copy',
    async ({ from, to }) => sandbox.copy(from, to), okPair('from', 'to')));
  ipcMain.handle('fs:move', guarded('fs.move',
    async ({ from, to }) => sandbox.move(from, to), okPair('from', 'to')));
  ipcMain.handle('fs:mkdir', guarded('fs.mkdir',
    async ({ path: p }) => sandbox.mkdir(p), okPath('path')));

  ipcMain.handle('fs:delete', guarded('fs.delete',
    async ({ path: p }) => sandbox.trash(p), okPath('path')));

  // Restore is the inverse of a delete this machine already authorised, so it
  // needs no fresh grant: it can only ever put back what was taken.
  ipcMain.handle('fs:restore', plain(async ({ id }) => sandbox.restore(id)));

  /* --------------------------------------------------------- user only ---- */
  /* Not in the syscall table. Reachable only from a real user gesture, which
     is why these may touch paths outside the sandbox at all. */

  ipcMain.handle('user:import', plain(async ({ into } = {}) => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win, {
      title: '從作業系統匯入檔案到沙箱',
      buttonLabel: '複製進沙箱',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent']
    });
    if (res.canceled || !res.filePaths.length) return { imported: [], skipped: [], canceled: true };
    return sandbox.importFiles(res.filePaths, into || '/inbox');
  }));

  // Drag and drop. The renderer resolves File objects to real paths through
  // webUtils in the preload; it cannot fabricate a path it was not handed.
  ipcMain.handle('user:importPaths', plain(async ({ paths, into } = {}) => {
    if (!Array.isArray(paths) || !paths.length) return { imported: [], skipped: [] };
    return sandbox.importFiles(paths.slice(0, 50), into || '/inbox');
  }));

  ipcMain.handle('user:reveal', plain(async ({ path: p } = {}) => {
    if (p) {
      const r = await sandbox.safe(p, { mustExist: true });
      shell.showItemInFolder(r.real);
      return { revealed: r.vpath };
    }
    await shell.openPath(sandbox.root());
    return { revealed: '/' };
  }));

  ipcMain.handle('user:trashEmpty', plain(async () => {
    const win = getWindow();
    const { response } = await askBox(win, {
      type: 'warning',
      buttons: ['取消', '永久刪除'],
      defaultId: 0,
      cancelId: 0,
      title: '清空回收桶',
      message: '永久刪除沙箱回收桶裡的所有檔案？',
      detail: '這是沙箱裡唯一無法復原的操作。作業系統上的檔案不受影響。'
    });
    if (response !== 1) return { removed: 0, canceled: true };
    return sandbox.trashEmpty();
  }));

  ipcMain.handle('win:setFullScreen', plain(async ({ on } = {}) => {
    const win = getWindow();
    if (win) win.setFullScreen(!!on);
    return { fullScreen: win ? win.isFullScreen() : false };
  }));

  ipcMain.handle('win:toggleFullScreen', plain(async () => {
    const win = getWindow();
    if (win) win.setFullScreen(!win.isFullScreen());
    return { fullScreen: win ? win.isFullScreen() : false };
  }));

  ipcMain.handle('win:minimize', plain(async () => {
    const win = getWindow();
    if (win) win.minimize();
    return { minimized: true };
  }));

  ipcMain.handle('win:close', plain(async () => {
    const win = getWindow();
    if (win) win.close();
    return { closed: true };
  }));

  /* ------------------------------------------------------------ memory ---- */
  /* Reading memory is gated by mem.read, writing by mem.write, so the model has
     to earn both. The manager UI drives the same handlers the model does: there
     is no privileged back door for the interface. */

  ipcMain.handle('mem:list', guarded('memory.recall', async () => memory.list(), null, '列出長期記憶'));
  ipcMain.handle('mem:search', guarded('memory.recall',
    async ({ query, limit }) => memory.search(query, limit), null, '搜尋長期記憶'));
  ipcMain.handle('mem:add', guarded('memory.remember',
    async ({ text, tags, source, pinned }) => memory.add({ text, tags, source, pinned }), null, '記住一件新的事'));
  ipcMain.handle('mem:update', guarded('memory.remember',
    async ({ id, patch }) => memory.update(id, patch || {}), null, '修改一筆既有的記憶'));
  ipcMain.handle('mem:remove', guarded('memory.forget', async ({ id }) => memory.remove(id)));
  ipcMain.handle('mem:learn', guarded('memory.remember',
    async ({ candidates }) => memory.learn(candidates), null, '從這次對話裡整理出要記住的事'));
  ipcMain.handle('mem:used', plain(async ({ ids }) => { memory.markUsed(ids); return { ok: true }; }));
  ipcMain.handle('mem:summary', plain(async () => memory.summary()));
  ipcMain.handle('mem:export', guarded('memory.recall', async () => memory.exportAll(), null, '把長期記憶匯出成檔案'));
  ipcMain.handle('mem:import', guarded('memory.remember',
    async ({ payload }) => memory.importAll(payload), null, '從檔案匯入長期記憶'));

  /* ----------------------------------------------------------- session ---- */

  ipcMain.handle('session:save', plain(async ({ payload }) => session.save(payload)));
  ipcMain.handle('session:load', plain(async () => session.load()));
  ipcMain.handle('session:clear', plain(async () => session.clear()));
  ipcMain.handle('session:stat', plain(async () => session.stat()));

  /* --------------------------------------------------------------- web ---- */

  ipcMain.handle('web:read', guarded('web.read',
    async ({ url }) => web.read(url),
    (args) => { web.validateUrl(args.url); }));

  /* os.net.fetch for generated programs. The frame's CSP is default-src 'none',
     so this is the only way a program reaches the network, and it answers to
     net.egress like the planner's own web.read. The URL is screened before the
     gate asks, so a request to loopback or a private range never reaches a
     dialog. */
  ipcMain.handle('web:fetch', guarded('web.fetch',
    async ({ url, opts }) => web.fetchRaw(url, opts && typeof opts === 'object' ? opts : {}),
    (args) => { web.validateUrl(args.url); }));

  ipcMain.handle('browser:create', guarded('web.open',
    async ({ url }) => browser.create({ url }),
    (args) => { if (args.url) web.validateUrl(args.url); }));

  /* Publish one PDF to the viewer frame. Gated on fs.read rather than
     net.egress: it draws a local file and, unlike the browser, cannot navigate
     anywhere at all.

     This is the only place a path is named. Containment is checked here, and the
     result is a URL carrying a random token -- the frame that then parses the
     file has no path parameter available to it, so a malicious PDF cannot reach
     a second file even if it gets code running. See VIEWER HOSTING in pdf.js. */
  ipcMain.handle('pdf:publish', guarded('fs.read', async ({ path: p }) => {
    const r = await sandbox.safe(p, { kind: 'file', mustExist: true });
    if (!/\.pdf$/i.test(r.vpath)) throw Object.assign(new Error('不是 PDF 檔'), { code: 'EINVAL' });
    const v = pdf.publishView({ real: r.real, vpath: r.vpath });
    return { ...v, bytes: r.stat.size, untrusted: sandbox.isUntrusted(r.vpath) };
  }, okPath('path'), '把一個 PDF 交給檢視器算繪'));

  // Dropping a grant needs no grant of its own.
  ipcMain.handle('pdf:revoke', plain(async ({ token }) => ({ revoked: pdf.revokeView(token) })));

  /* Write a converted PDF: the Markdown, plus the images cropped out of it.
     One call rather than one per file, because this is the only place that knows
     the files are derived from a particular PDF -- and that is what decides their
     origin.

     A conversion must not launder a taint. The Markdown of an untrusted PDF is
     untrusted text that will end up in the model's context, so it inherits the
     source's origin instead of being written as local content the way fs:write
     would. sandbox.copy already works this way; this is the same rule for a
     derived file rather than a copied one.

     The asset directory is derived here from the Markdown path. The renderer
     supplies leaf filenames only, and they are pattern-checked: it has no way to
     write outside the folder that belongs to the document it just converted. */
  ipcMain.handle('pdf:saveConversion', guarded('fs.write', async (args) => {
    const { from, path: p, markdown } = args;
    const images = Array.isArray(args.images) ? args.images : [];
    if (images.length > 500) throw Object.assign(new Error('圖片太多'), { code: 'EINVAL' });

    const src = await sandbox.safe(from, { kind: 'file', mustExist: true });
    const o = sandbox.originOf(src.vpath);
    const origin = o ? o.origin : (sandbox.isUntrusted(src.vpath) ? 'external' : 'local');

    const md = await sandbox.write(p, String(markdown || ''), { origin, source: src.vpath });

    const dir = md.vpath.replace(/\.[^./]*$/, '') + '.assets';
    const written = [];
    if (images.length) {
      await sandbox.mkdir(dir);
      for (const img of images) {
        const name = String(img && img.name || '');
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpg|jpeg)$/.test(name)) {
          throw Object.assign(new Error('圖片檔名不合法：' + name.slice(0, 40)), { code: 'EINVAL' });
        }
        const b64 = String(img.base64 || '');
        if (!/^[A-Za-z0-9+/=]*$/.test(b64)) {
          throw Object.assign(new Error('圖片內容不是 base64'), { code: 'EINVAL' });
        }
        // eslint-disable-next-line no-await-in-loop
        const w = await sandbox.writeBytes(dir + '/' + name, b64, { origin, source: src.vpath });
        written.push({ vpath: w.vpath, bytes: w.bytes });
      }
    }

    return {
      vpath: md.vpath,
      bytes: md.bytes,
      assetDir: images.length ? dir : null,
      images: written,
      origin,
      untrusted: sandbox.isUntrusted(md.vpath)
    };
  }, okPair('from', 'path'), '把 PDF 轉出的 Markdown 與圖片寫進沙箱'));

  ipcMain.handle('browser:navigate', guarded('web.open',
    async ({ id, url }) => browser.navigate(id, url),
    null, '把一個已開啟的分頁導到別的網址'));

  // Chrome-level controls need no fresh grant: they cannot reach anywhere the
  // tab has not already been authorised to go.
  ipcMain.handle('browser:back', plain(async ({ id }) => browser.goBack(id)));
  ipcMain.handle('browser:forward', plain(async ({ id }) => browser.goForward(id)));
  ipcMain.handle('browser:reload', plain(async ({ id }) => browser.reload(id)));
  ipcMain.handle('browser:stop', plain(async ({ id }) => browser.stop(id)));
  ipcMain.handle('browser:bounds', plain(async ({ id, bounds }) => browser.setBounds(id, bounds)));
  ipcMain.handle('browser:show', plain(async ({ id, bounds }) => browser.show(id, bounds)));
  ipcMain.handle('browser:hide', plain(async ({ id }) => browser.hide(id)));
  ipcMain.handle('browser:hideAll', plain(async () => browser.hideAll()));
  /* A closed tab takes its translation with it: the loop stops now rather than
     on its next poll, and the session stops holding a tab that is gone. */
  ipcMain.handle('browser:destroy', plain(async ({ id }) => {
    translate.forget(id);
    return browser.destroy(id);
  }));
  ipcMain.handle('browser:list', plain(async () => browser.list()));
  ipcMain.handle('browser:readPage', guarded('fs.read', async ({ id }) => browser.readPage(id), null, '把目前分頁的正文讀進來'));
  /* Gated as `fs.read` like readPage, because it is the same act -- reading the
     page -- in a form that keeps its structure. What is done with the result
     afterwards is a separate decision: writing it out goes through
     `office:write*` or `fs:write`, which are gated on `fs.write` of their own.

     Deliberately does NOT arm the taint gate, which is where this differs from
     `browser:readPage` beside it. The taint is about the planner: it arms when
     a stranger's text enters the model's context, because from there it can
     steer what the machine does next. This text goes to a file the person
     named and nowhere else. Arming here would mean every page saved as a PDF
     costs a consent dialog for the write that the same person just asked for,
     to defend against nothing -- and if that file is later read into context,
     that read is what arms the gate, on the path that already does it. */
  ipcMain.handle('browser:article', guarded('fs.read', async ({ id }) => browser.article(id),
    null, '把目前分頁的正文抓成可轉檔的格式'));

  /* Reading the page was `fs.read`; going back out for its pictures is not the
     same act, so it does not travel on the same permission. It opens sockets,
     and a request is visible to whoever is on the other end -- so it answers to
     `net.egress` like every other thing on this machine that reaches the
     network, and it says what it is for.

     What it may reach is not the caller's choice. The URLs come from the tab's
     own record of what the extraction watched the page draw; the renderer sends
     an id, never an address. See the header above articleImages. */
  ipcMain.handle('browser:articleImages', guarded('page.images',
    async ({ id }) => browser.articleImages(id), null, '把這一頁的圖片抓下來夾進轉存的檔案'));

  ipcMain.handle('browser:external', plain(async ({ url }) => browser.openExternal(url)));
  ipcMain.handle('browser:home', plain(async () => ({ url: browser.HOME })));

  /* ------------------------------------------------------- translation ----

     Starting a translation is the one call that reaches the page: it reads
     every paragraph and writes a translation under each. So it is gated as
     both of those things at once -- `fs.read`, like readPage and pageNodes,
     with its own wording, because a person approving this is approving the
     page being sent to the model, not a file being opened.

     Everything below it is about a translation that is already running, or is
     a preference; none of them can start one, and none of them carries page
     text. The progress events go the other way and carry counts, never
     content. See the header of main/translate.js for why the work itself is
     not in the renderer. */
  ipcMain.handle('translate:start', guarded('fs.read',
    async ({ tabId, patch }) => translate.start(tabId, patch),
    null, '把這個分頁的內容交給模型翻譯，並把譯文插在原文下面'));

  ipcMain.handle('translate:stop', plain(async ({ tabId }) => translate.stop(tabId)));
  ipcMain.handle('translate:retry', plain(async ({ tabId }) => translate.retry(tabId)));
  ipcMain.handle('translate:setVisible', plain(async ({ tabId, on }) => translate.setVisible(tabId, on)));
  ipcMain.handle('translate:status', plain(async ({ tabId }) => translate.status(tabId)));
  ipcMain.handle('translate:settings', plain(async () => translate.getSettings()));
  ipcMain.handle('translate:setSettings', plain(async (patch = {}) => translate.setSettings(patch)));
  ipcMain.handle('translate:autoState', plain(async ({ url }) => translate.autoState(url)));
  ipcMain.handle('translate:setAutoDomain', plain(async ({ url, on }) => translate.setAutoDomain(url, on)));
  ipcMain.handle('translate:cacheStats', plain(async () => translate.cacheStats()));
  ipcMain.handle('translate:clearCache', plain(async () => translate.clearCache()));

  /* ------------------------------------------------ extensions on a page ----

     `pageNodes` is gated like `readPage`: it is the same content in a different
     shape, so it must not be a cheaper way to reach it.

     `applyToPage` is gated on `ui.surface` rather than on a capability of its
     own. It changes what is on screen and nothing else -- no navigation, no
     network, no storage -- and the narrow vocabulary is what keeps that true:
     text-node replacements addressed by index, never markup. */
  ipcMain.handle('browser:pageNodes', guarded('fs.read',
    async ({ id, limit }) => browser.pageNodes(id, limit),
    null, '把目前分頁的文字節點讀進來（給擴充功能用）'));

  ipcMain.handle('browser:applyToPage', guarded('page.apply',
    async ({ id, ops }) => browser.applyToPage(id, ops)));

  /* Shared by the gated browser channel and the installed-program channel
     below: one rendering of a page to PDF, whoever asked. */
  async function pageToPdf(id, p) {
    const page = await browser.readPage(id, 400000);
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const html = '<!DOCTYPE html><meta charset="utf-8"><style>' +
      'body{font:12pt/1.7 "Noto Sans TC",sans-serif;margin:0;white-space:pre-wrap}' +
      'h1{font-size:18pt;margin:0 0 6pt}小{color:#555}</style>' +
      '<h1>' + esc(page.title || page.url) + '</h1>' +
      '<p style="color:#555;font-size:9pt">' + esc(page.url) + '</p>' +
      esc(page.text || '');
    const target = p || ('/downloads/' + String(page.title || 'page')
      .replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.pdf');
    const buf = await pdf.toPdf(html, {});
    const out = await sandbox.writeBytes(target, buf.toString('base64'), { origin: 'local' });
    return { vpath: out.vpath, bytes: out.bytes, title: page.title };
  }

  ipcMain.handle('browser:toPdf', guarded('page.pdf', async ({ id, path: p }) => pageToPdf(id, p),
    okPath('path'), '把目前分頁存成 PDF'));

  /* The page as it looks, rather than the page as it reads.

     pageToPdf above and the browser app's 轉存 both go through an extraction:
     they keep the article and drop the layout, which is the right answer for
     something that will be read. This is the other answer. Chromium prints the
     live document, so the stylesheets, the columns and every picture already on
     screen come out as rendered -- and so do the navigation bar and the advert
     beside it, which is the trade and is said in the menu.

     Same capability as pageToPdf: it is the same act, differing only in how
     faithful the result is. */
  ipcMain.handle('browser:printTab', guarded('page.pdf', async ({ id, path: p, ...rest }) => {
    const buf = await browser.printTab(id, rest || {});
    const out = await sandbox.writeBytes(p, buf.toString('base64'), { origin: 'local' });
    return { vpath: out.vpath, bytes: out.bytes };
  }, okPath('path'), '把目前分頁照原樣印成 PDF'));

  /* ---------------------------------------------------------- schedule ----

     Adding or changing a job answers to sys.timer, the capability timer.set
     already uses: a schedule is a timer that does something. What the job does
     when it fires is gated on its own when it fires -- an intent goes through
     the planner and every op it plans through the gate, an action through
     whatever the program's verb does -- so this is not a second decision about
     that, only about whether this machine may set itself a clock. */
  ipcMain.handle('schedule:list', plain(async () => schedule.list()));
  ipcMain.handle('schedule:add', guarded('schedule.set', async (args) => schedule.add(args)));
  ipcMain.handle('schedule:update', guarded('schedule.set',
    async ({ id, patch }) => schedule.update(id, patch), null, '修改一個排程'));
  ipcMain.handle('schedule:remove', guarded('schedule.cancel', async ({ id }) => schedule.remove(id)));
  ipcMain.handle('schedule:runNow', plain(async ({ id }) => schedule.runNow(id)));
  ipcMain.handle('schedule:report', plain(async ({ id, result }) => schedule.report(id, result || {})));
  ipcMain.handle('schedule:ready', plain(async () => { schedule.setReady(true); return { ready: true }; }));

  /* ---------------------------------------------------------- bookmarks ----

     Ungated. A bookmark is a note about a URL: adding one reaches nothing and
     opening one goes through `net.egress` like any other navigation, which is
     where the decision belongs. */
  ipcMain.handle('bookmarks:list', plain(async (args = {}) => bookmarks.list(args)));
  ipcMain.handle('bookmarks:folders', plain(async () => bookmarks.folders()));
  ipcMain.handle('bookmarks:add', plain(async ({ url, title, folder }) =>
    bookmarks.add({ url, title, folder })));
  ipcMain.handle('bookmarks:remove', plain(async ({ id }) => bookmarks.remove(id)));
  ipcMain.handle('bookmarks:rename', plain(async ({ id, title, folder }) =>
    bookmarks.rename(id, { title, folder })));
  ipcMain.handle('bookmarks:has', plain(async ({ url }) => ({ has: bookmarks.has(url) })));

  /* Export and import write and read through the sandbox, so the file lands
     somewhere the user can see and the capability check happens once. */
  ipcMain.handle('bookmarks:export', guarded('fs.write', async ({ path: p }) => {
    const target = p || '/notes/bookmarks.html';
    const out = await sandbox.write(target, bookmarks.toHtml(), { origin: 'local' });
    return { vpath: out.vpath, bytes: out.bytes };
  }, okPath('path'), '把書籤匯出成 HTML 檔'));

  ipcMain.handle('bookmarks:import', guarded('fs.read', async ({ path: p }) => {
    const f = await sandbox.read(p);
    return bookmarks.fromHtml(f.content || '');
  }, okPath('path'), '從 HTML 檔匯入書籤'));

  /* -------------------------------------------------------------- mail ---- */

  ipcMain.handle('mail:status', plain(async () => mail.status()));
  /* Ungated for the same reason `mail:configure` is: this is the account form
     talking, and the form is only ever driven by the person sitting here. It
     reaches the network -- DNS, and two public config endpoints -- but it holds
     no mailbox and returns no mail, so `mail.read` has nothing to protect. The
     model cannot reach it either way: it drives this application through the
     actions in apps/mail.js, and discovery is not one of them. */
  ipcMain.handle('mail:discover', plain(async ({ email }) => mail.discover(email)));
  ipcMain.handle('mail:configure', plain(async (args) => mail.configure(args)));
  ipcMain.handle('mail:forget', plain(async () => mail.forget()));
  ipcMain.handle('mail:verify', guarded('mail.list', async () => mail.verify(), null, '確認信箱連線設定可用'));
  ipcMain.handle('mail:folders', guarded('mail.list', async () => mail.folders(), null, '列出信箱的資料夾'));
  ipcMain.handle('mail:list', guarded('mail.list',
    async ({ folder, limit }) => mail.list({ folder, limit }), null, '列出一個資料夾裡的信件'));

  ipcMain.handle('mail:read', guarded('mail.read', async ({ folder, uid }) => {
    const msg = await mail.read({ folder, uid });
    // Mail is the channel a stranger can write to, so every message arms the
    // taint gate exactly as reading a hostile file does.
    gate.addTaint('mail:' + msg.uid, `信件「${msg.subject}」（${msg.from}）`);
    // Names and sizes cross the bridge; the bytes stay in the mirror.
    return Object.assign({}, msg, {
      attachments: (msg.attachments || []).map((a) => ({ name: a.name, type: a.type, bytes: a.bytes }))
    });
  }));

  /* Search the mirror: subject, sender, and the text of the messages.

     Bodies are what make this worth having -- 「哪封信提到我」 is a question
     about text -- and bodies are also what makes the answer untrusted content.
     A body hit comes back with a snippet, and a snippet is a piece of somebody
     else's mail entering this machine's reasoning, so the gate is armed the
     same way reading the message would arm it. A hit on the subject alone is
     what the list already shows and does not. */
  /**
   * Search the mirror, and optionally bring the bodies back with the hits.
   *
   * `withBody` is why this is one call and not one call plus a read per hit.
   * Measured, on the scheduled run that this whole line of work exists for:
   * eight matching messages became eight separate `mail.read` actions, at most
   * six actions fit in a round, one read failed and cost a repair round, and
   * the five-round budget was gone before the note was ever written. The work
   * was not too large -- it was shaped wrong. Asking "which messages, and what
   * do they say" is one question, so it is one syscall.
   *
   * Bounded on purpose: each missing body is a fetch from the server, and the
   * point is to make a search cheap enough to plan around, not to make one
   * action able to pull a mailbox.
   */
  ipcMain.handle('mail:search', guarded('mail.read', async (opts = {}) => {
    if (!mail.store.ready()) throw Object.assign(new Error('還沒有同步過的信'), { code: 'ENOACCOUNT' });
    if (opts.messageId) {
      const found = mail.store.resolve(opts.messageId);
      if (found) opts = { ...opts, messageId: found };
    }
    const out = await mail.store.search(opts);
    /* The handle travels with every hit, because it is what the core will write
       into a note and what a link will arrive back as. */
    out.hits.forEach((h) => { h.handle = mail.store.shortOf(h.messageId); });

    const want = Math.max(0, Math.min(Number(opts.withBody) || 0, 12));
    if (want) {
      for (const hit of out.hits.slice(0, want)) {
        try {
          if (!hit.hasBody) await mail.syncBody({ messageId: hit.messageId, folder: hit.folder, uid: hit.uid });
          hit.text = String((await mail.store.body(hit.messageId)) || '').slice(0, 4000);
        } catch (e) {
          /* One message that will not open does not fail the search. Say so on
             the hit, so the answer built from this is visibly short rather than
             quietly short. */
          hit.bodyError = String(e.message || e).slice(0, 160);
        }
      }
      out.bodies = out.hits.filter((h) => h.text).length;
    }

    /* Reading a body is reading a stranger's writing, whether it arrived as a
       search snippet or in full. Both arm the gate. */
    const bodies = out.hits.filter((h) => h.where === 'body' || h.text);
    if (bodies.length) {
      const asked = String(opts.text || opts.from || opts.to || '').slice(0, 40);
      gate.addTaint('mail:search:' + asked,
        `信件搜尋「${asked}」的內文（${bodies.length} 封）`);
    }
    return out;
  }, null, '在本機已同步的信裡搜尋主旨、寄件人、收件者與內文'));

  /* Put an attachment into the sandbox, as a file that remembers it came from
     mail. The bytes were kept by the mirror when the message was read; this
     copies them out to wherever the person said. Origin 'mail' is what makes
     the gate treat the file as untrusted afterwards, wherever it lands. */
  ipcMain.handle('mail:saveAttachment', guarded('fs.write', async ({ messageId, index, to } = {}) => {
    let a = await mail.store.attachment(messageId, index);
    if (!a) throw Object.assign(new Error('沒有這個附件'), { code: 'ENOENT' });
    if (!a.data) {
      /* Fetch it again rather than telling the user to re-sync, which used to be
         the advice and did nothing: the body is already stored, so the sync that
         would have re-fetched the attachment returns early. One attempt, then
         the honest failure with the source's own reason in it. */
      try {
        await mail.refreshAttachments({ messageId });
        a = await mail.store.attachment(messageId, index);
      } catch (e) { /* the error below is the one worth showing */ }
    }
    if (!a || !a.data) {
      throw Object.assign(
        new Error('這個附件的內容拿不到' + (a && a.reason ? '（' + a.reason + '）' : '')),
        { code: 'ENODATA' });
    }
    const out = await sandbox.writeBytes(to, a.data.toString('base64'), {
      origin: 'mail', source: 'mail:' + String(messageId)
    });
    return Object.assign({ name: a.name, type: a.type, bytes: a.bytes }, out);
  }, (args) => { sandbox.resolve(args.to); }, '把一封信的附件另存到沙箱'));

  ipcMain.handle('mail:markSeen', guarded('mail.read',
    async ({ folder, uid, seen }) => mail.markSeen({ folder, uid, seen }),
    null, '把一封信標記為已讀或未讀'));
  ipcMain.handle('mail:send', guarded('mail.send',
    async ({ to, cc, subject, body, inReplyTo, references }) =>
      mail.send({ to, cc, subject, body, inReplyTo, references })));

  /* ------------------------------------------------------- mail mirror ----

     The application reads these, not the server. Fetching is gated on
     `mail.list` / `mail.read` exactly as the live calls are -- the mirror is a
     copy of the same content, so it cannot be a cheaper way to reach it.

     Reading a stored message arms the taint gate for the same reason the live
     read does: it is still the channel a stranger can write to, and having been
     fetched an hour ago does not make it trusted. */

  ipcMain.handle('mail:sync', guarded('mail.list',
    async ({ folder, limit, deep, days }) => mail.syncFolder({ folder, limit, deep, days }),
    null, '把信箱裡的新信同步到本機'));

  ipcMain.handle('mail:mirrorList', guarded('mail.list',
    async ({ folder, includeDeleted, limit, search } = {}) =>
      mail.store.list({ folder, includeDeleted, limit, search }),
    null, '列出本機已同步的信件'));

  ipcMain.handle('mail:mirrorRead', guarded('mail.read', async ({ messageId, folder, uid }) => {
    /* A link may carry the full Message-ID or the ten-character handle the
       search results hand out; both name the same row. */
    const id = mail.store.resolve(messageId) || messageId;
    const held = mail.store.get(id);
    if (!held) {
      throw Object.assign(
        new Error('本機沒有這封信。連結上的編號在這台機器的鏡像裡找不到——可能是還沒同步，也可能那個編號本來就不存在。'),
        { code: 'ENOMSG' });
    }
    messageId = id;
    if (!held.hasBody || !held.htmlTried) await mail.syncBody({ folder: folder || held.folder, uid: uid != null ? uid : held.uid, messageId });
    const body = await mail.store.body(messageId);
    gate.addTaint('mail:' + messageId, `信件「${held.subject}」（${held.from}）`);
    return {
      ...mail.store.get(messageId),
      handle: mail.store.shortOf(messageId),
      text: body || '',
      /* The message as it was written. The window shows this one and reads the
         text; both are the same message, and the text is derived from it. */
      html: await mail.store.html(messageId)
    };
  }, null, '讀一封本機的信'));

  /* Local-only edits: no capability, because nothing leaves this machine and
     nothing on the server changes. Marking read is the exception and has its
     own channel below. */
  ipcMain.handle('mail:mirrorFlag', plain(async ({ messageId, patch }) => {
    const out = mail.store.setLocal(messageId, patch || {});
    await mail.store.flush();
    return out;
  }));

  ipcMain.handle('mail:setSeen', guarded('mail.read',
    async ({ folder, uid, messageId, seen }) => mail.setSeen({ folder, uid, messageId, seen }),
    null, '把一封信標記為已讀（會依設定同步回伺服器）'));

  ipcMain.handle('mail:syncSeenPref', plain(async ({ on }) => mail.setSyncSeen(on)));
  ipcMain.handle('mail:mirrorStats', plain(async () =>
    (mail.store.ready() ? mail.store.stats() : null)));
  ipcMain.handle('mail:coverage', plain(async ({ folder } = {}) =>
    (mail.store.ready() ? mail.store.coverage(folder || 'INBOX') : null)));

  /* ------------------------------------------------- Outlook on the web --- */
  /* Signing in is the user's job in a browser tab, so this channel hands back a
     URL and nothing else -- no window is opened from here, no form is touched,
     and no password ever reaches this process. Ungated for the same reason the
     account form is: it is the user asking where to go.

     Checking the session, on the other hand, makes a real request to the real
     mailbox, so it answers `mail.list` exactly as an IMAP connection test does. */

  /* ------------------------------------------------------- mail todo ---- */
  /* Rules and the work they turned up. Nothing here reaches the mailbox or the
     model: the window does the searching through `mail:search` and the
     summarising through the kernel, and hands the result back to be kept. So
     these are local edits to local state, which is why they are ungated -- the
     same reason `mail:mirrorFlag` is. */

  ipcMain.handle('mailtodo:state', plain(async () => ({
    ...mailtodo.state(), counts: mailtodo.counts()
  })));
  ipcMain.handle('mailtodo:addRule', plain(async ({ rule } = {}) => {
    const out = mailtodo.addRule(rule || {});
    await mailtodo.flush();
    return out;
  }));
  ipcMain.handle('mailtodo:updateRule', plain(async ({ id, patch } = {}) => {
    const out = mailtodo.updateRule(id, patch || {});
    await mailtodo.flush();
    return out;
  }));
  ipcMain.handle('mailtodo:removeRule', plain(async ({ id } = {}) => {
    const out = mailtodo.removeRule(id);
    await mailtodo.flush();
    return out;
  }));
  ipcMain.handle('mailtodo:putItems', plain(async ({ ruleId, items } = {}) => {
    const out = mailtodo.putItems(ruleId, items || []);
    await mailtodo.flush();
    return out;
  }));
  ipcMain.handle('mailtodo:patchItem', plain(async ({ id, patch } = {}) => {
    const out = mailtodo.patchItem(id, patch || {});
    await mailtodo.flush();
    return out;
  }));
  ipcMain.handle('mailtodo:removeItem', plain(async ({ id } = {}) => {
    const out = mailtodo.removeItem(id);
    await mailtodo.flush();
    return out;
  }));
  ipcMain.handle('mailtodo:clearDone', plain(async ({ ruleId } = {}) => {
    const out = mailtodo.clearDone(ruleId || null);
    await mailtodo.flush();
    return out;
  }));

  ipcMain.handle('owa:loginUrl', plain(async () => ({
    url: mail.owa.loginUrl(),
    configured: mail.owa.configured()
  })));

  /* Keep the mailbox session alive while this machine is open, the way an open
     Outlook tab does. Reaches the network, so it answers `mail.list` like the
     other things that do. */
  ipcMain.handle('owa:keepAlive', plain(async () => mail.owa.keepAlive()));
  ipcMain.handle('owa:refreshSession', guarded('mail.list',
    async () => mail.owa.refreshSession(), null, '讓 Outlook 的登入不要過期'));

  ipcMain.handle('owa:probe', guarded('mail.list',
    async ({ open } = {}) => mail.owa.probe({ open: open !== false }),
    null, '確認 Outlook 網頁信箱還登入著'));

  /* What is actually happening between here and the mailbox, in facts rather
     than in one sentence that may be about the wrong problem. Never carries a
     cookie value, a token or any message content -- see owa.js diagnose(). */
  ipcMain.handle('owa:diagnose', guarded('mail.list',
    /* `shapes: 'apply'` is the only way the measurement is written back. A plain
       diagnosis reads and reports; it does not change how the module asks. */
    async ({ shapes } = {}) => mail.owa.diagnose({ shapes: shapes === 'apply' ? 'apply' : shapes !== false }),
    null, '檢查 Outlook 網頁信箱的連線與請求形狀'));

  /* ------------------------------------------------------------ office ---- */
  /* Format conversion is pure computation on bytes the caller already had, so it
     needs no capability of its own; the read or write around it is what counts. */

  ipcMain.handle('office:readDocx', guarded('fs.read', async ({ path: p }) => {
    const f = await sandbox.readBytes(p);
    return {
      ...office.readDocx(Buffer.from(f.base64, 'base64')),
      vpath: f.vpath, untrusted: f.untrusted,
      // The version read, so the editor can claim it when it saves back.
      mtime: f.mtime
    };
  }, okPath('path'), '讀取一個 .docx 的內容'));

  ipcMain.handle('office:writeDocx', guarded('fs.write', async ({ path: p, blocks, meta }) => {
    const buf = office.writeDocx(blocks || [], meta || {});
    return sandbox.writeBytes(p, buf.toString('base64'), { origin: 'local' });
  }, okPath('path'), '把文件匯出成 .docx 寫進沙箱'));

  ipcMain.handle('office:readXlsx', guarded('fs.read', async ({ path: p, sheet }) => {
    const f = await sandbox.readBytes(p);
    return { ...office.readXlsx(Buffer.from(f.base64, 'base64'), { sheet }), vpath: f.vpath, mtime: f.mtime };
  }, okPath('path'), '讀取一個 .xlsx 的內容'));

  /* Render a document to PDF. The renderer sends assembled HTML; Chromium's print
     engine does the paging. Gated on fs.write because the only lasting effect is
     the file it leaves behind. */
  ipcMain.handle('office:writePdf', guarded('fs.write', async ({ path: p, html, opts }) => {
    const buf = await pdf.toPdf(html, opts || {});
    const out = await sandbox.writeBytes(p, buf.toString('base64'), { origin: 'local' });
    return { ...out, bytes: buf.length };
  }, okPath('path'), '把文件算繪成 PDF 寫進沙箱'));

  ipcMain.handle('office:writeXlsx', guarded('fs.write', async ({ path: p, sheetName, cells, meta }) => {
    // `meta.sheets` carries a whole workbook; `cells` is the one-sheet form.
    const buf = office.writeXlsx({
      sheetName,
      cells: cells || {},
      sheets: meta && meta.sheets,
      font: meta && meta.font,
      size: meta && meta.size
    });
    return sandbox.writeBytes(p, buf.toString('base64'), { origin: 'local' });
  }, okPath('path'), '把試算表匯出成 .xlsx 寫進沙箱'));

  /* The deck arrives with its pictures already inlined as data: URIs -- the
     renderer resolves sandbox paths before calling, the same as the PDF export
     does, so main never reaches into the sandbox on the strength of a string
     found inside a document. `warnings` comes back rather than being logged
     here, because the surface that asked is the one that can say it. */
  ipcMain.handle('office:writePptx', guarded('fs.write', async ({ path: p, deck }) => {
    const out = office.writePptx(deck || {});
    const w = await sandbox.writeBytes(p, out.buffer.toString('base64'), { origin: 'local' });
    return { ...w, bytes: out.buffer.length, warnings: out.warnings };
  }, okPath('path'), '把簡報匯出成 .pptx 寫進沙箱'));

  /* Reading somebody else's deck brings their words into this machine's
     reasoning -- the window publishes what is on the slides to the model
     through `describe()` -- so an untrusted source arms the gate here, on the
     path that does it, exactly as reading the file any other way would.

     No `mtime` comes back, and that is the point: there is nothing to claim to
     be replacing, because this is an import and not an open. See readPptx's
     header for why writing a .pptx back is not offered at all. */
  ipcMain.handle('office:readPptx', guarded('fs.read', async ({ path: p }) => {
    const f = await sandbox.readBytes(p);
    if (f.untrusted) gate.addTaint(f.vpath, f.vpath);
    return {
      ...office.readPptx(Buffer.from(f.base64, 'base64')),
      vpath: f.vpath, untrusted: f.untrusted
    };
  }, okPath('path'), '讀取一個 .pptx 的內容'));

  /* ---------------------------------------------------------------- pdf --- */

  /* Reading a PDF is reading a file, so it needs fs.read and nothing more. The
     text it produces came from outside this machine, so it arms the taint gate
     exactly like a fetched page or a mail body would. */

  ipcMain.handle('pdf:read', guarded('fs.read', async ({ path: p, pages }) => {
    const f = await sandbox.readBytes(p);
    const out = pdf.read(Buffer.from(f.base64, 'base64'), { pages });
    if (f.untrusted) gate.addTaint(f.vpath, f.vpath);
    return { ...out, vpath: f.vpath, untrusted: f.untrusted, bytes: f.bytes };
  }, okPath('path'), '把一個 PDF 的文字抽出來'));

  ipcMain.handle('pdf:probe', guarded('fs.read', async ({ path: p }) => {
    const f = await sandbox.readBytes(p);
    return { ...pdf.probe(Buffer.from(f.base64, 'base64')), vpath: f.vpath, bytes: f.bytes };
  }, okPath('path'), '看一個 PDF 的頁數與基本資訊'));

  /* ------------------------------------------------------- rewriting a pdf

     Splitting, extracting, deleting, reordering and merging are one operation
     with different page lists, so they are one route. The renderer sends source
     paths and page numbers; pdfedit.js never sees a path, and the pages it is
     given are numbers -- so nothing inside a PDF can name a file, in either
     direction.

     Origin follows pdf:saveConversion above, not the office writers beside it.
     Their inputs came from this machine's own editors; this one's came from a
     file that may have arrived from anywhere, and pages taken out of an
     untrusted PDF are still untrusted. For a merge the strictest input wins:
     one untrusted source makes the output untrusted, because it is the source
     that would have to be trusted for the output to be.

     Deleting or reordering is refused when the page tree could not be read.
     "Page 3" is a guess in that case, and deleting the wrong page on the
     strength of a guess is not something the person can undo. Extracting in
     file order is still allowed -- it keeps everything, so a wrong guess costs
     an order, not a page. */
  ipcMain.handle('pdf:writePages', guarded('fs.write', async (args) => {
    const { path: p, sources, title, destructive } = args || {};
    const list = Array.isArray(sources) ? sources : [];
    if (!list.length) throw Object.assign(new Error('沒有指定來源'), { code: 'EINVAL' });
    if (list.length > 32) throw Object.assign(new Error('一次最多合併 32 個檔案'), { code: 'EINVAL' });

    const docs = [];
    let untrusted = false;
    let origin = 'local';
    let source = null;

    for (const s of list) {
      const src = await sandbox.safe(s && s.from, { kind: 'file', mustExist: true });
      const f = await sandbox.readBytes(src.vpath);
      const doc = new pdf.Doc(Buffer.from(f.base64, 'base64'));

      if (destructive && doc.pageEntries() && doc.pageTreeGuessed) {
        throw Object.assign(
          new Error('這份 PDF 的頁面樹讀不出來，頁碼只能用檔案順序推測，所以不做刪除或重排'),
          { code: 'EGUESS' });
      }

      docs.push({ doc, pages: Array.isArray(s.pages) ? s.pages.map(Number) : null });

      if (f.untrusted) untrusted = true;
      const o = sandbox.originOf(src.vpath);
      if (!source) { source = src.vpath; origin = o ? o.origin : 'local'; }
      if (f.untrusted && (!o || o.origin === 'local')) origin = 'external';
    }
    if (untrusted && origin === 'local') origin = 'external';

    const out = pdfedit.writePages(docs, { title });
    const w = await sandbox.writeBytes(p, out.buffer.toString('base64'), { origin, source });
    return { vpath: w.vpath, bytes: out.buffer.length, pageCount: out.pageCount, warnings: out.warnings };
  }, okPath('path'), '把 PDF 的頁面寫成一個新檔'));

  /* ---------------------------------------------------- stamping a page

     Adding something to a page that already exists. The renderer lays each
     sheet out as HTML at the exact size of the page it will cover; main renders
     it with the same offscreen, scripting-off window every other PDF export
     uses -- so the fonts, the CJK shaping and the colour come from Chromium and
     nothing new gets to touch a page -- and then appends it.

     `tagged` and `outline` off: a stamp's content stream is about to be lifted
     out and put on somebody else's page, where structure markers reference
     nothing or collide with that page's own.

     Origin follows sandbox.copy, not the office writers: this file IS the
     original, byte for byte, with an append on the end. Writing it back as
     local content would be a laundering primitive -- read an untrusted PDF,
     stamp a space onto it, get back a file the gate trusts with every one of
     the original's actions and attachments still in it. */
  ipcMain.handle('pdf:stamp', guarded('fs.write', async (args) => {
    const { path: p, from, sheets, title } = args || {};
    const list = Array.isArray(sheets) ? sheets : [];
    if (!list.length) throw Object.assign(new Error('沒有要蓋上去的內容'), { code: 'EINVAL' });
    if (list.length > 200) throw Object.assign(new Error('一次最多蓋 200 頁'), { code: 'EINVAL' });

    const src = await sandbox.safe(from, { kind: 'file', mustExist: true });
    const f = await sandbox.readBytes(src.vpath);
    /* Reading a PDF is reading a PDF: the same gate arming pdf:read does, on
       the same grounds -- what comes out of this file is a stranger's content
       and some of it is about to be laid out as HTML. */
    if (f.untrusted) gate.addTaint(f.vpath, f.vpath);

    const overlays = [];
    for (const sheet of list) {
      const buf = await pdf.toPdf(String(sheet.html || ''), {
        margins: { marginType: 'none' },
        tagged: false,
        outline: false
      });
      overlays.push({ page: Number(sheet.page), overlay: buf });
    }

    const out = pdfedit.stamp(Buffer.from(f.base64, 'base64'), overlays, { title });
    const o = sandbox.originOf(src.vpath);
    const origin = o ? o.origin : (f.untrusted ? 'external' : 'local');
    const w = await sandbox.writeBytes(p, out.buffer.toString('base64'),
      { origin, source: src.vpath });
    return { vpath: w.vpath, bytes: out.buffer.length, pages: out.pages, warnings: out.warnings };
  }, okPath('path'), '把加上去的文字或標記寫進一份新的 PDF'));

  /* Turning what a person typed into page numbers. No capability: it reads
     nothing and writes nothing, it only parses -- and doing it in main means
     the range the writer acts on is the range this parsed, rather than two
     implementations that can disagree about what 「1-3,7」 means. */
  ipcMain.handle('pdf:pageSpec', plain(async ({ spec, count, mode }) => {
    const n = Math.max(0, Number(count) || 0);
    if (mode === 'delete') return { pages: pdfedit.invertPageSpec(spec, n) };
    if (mode === 'every') return { groups: pdfedit.everyGroups(spec, n) };
    return { pages: pdfedit.parsePageSpec(spec, n) };
  }));


  ipcMain.handle('office:convert', plain(async ({ kind, payload }) => {
    if (kind === 'md->blocks') return office.markdownToBlocks(payload);
    if (kind === 'blocks->md') return office.blocksToMarkdown(payload);
    if (kind === 'csv->rows') return office.parseCsv(payload);
    if (kind === 'rows->csv') return office.toCsv(payload);
    throw new Error('不支援的轉換：' + kind);
  }));

  /* ------------------------------------------------------------- forge ---- */

  ipcMain.handle('forge:list', plain(async () => forge.listApps()));
  ipcMain.handle('forge:load', guarded('app.run', async ({ slug }) => forge.load(slug)));
  /* All four are gated under app.create, so each has to say what it actually does.
     Without the fourth argument every one of them announced itself with that
     syscall's description, 「沒有現成程式時，寫一個新的」, which made the uninstall
     dialog describe the opposite of what it was about to do. */
  ipcMain.handle('forge:install', guarded('app.create', async (args) => forge.install(args),
    null, '安裝或更新一個生成的程式'));

  /* The build button in App Forge. Ungated, like the `user:*` channels above and
     for the same reason: a person who typed a description and pressed 「建置」 is
     not a request the kernel needs to relay back to that same person for
     approval. `app.create` stays ASK for the model's path -- running new code is
     one of the few things this machine cannot take back -- and `forge:install`
     above still enforces it.

     What replaces the gate is friction proportional to what the program asks
     for, decided here from the payload rather than taken on the renderer's word:
     a capability that reaches past the program's own sandbox gets a dialog,
     anything else installs silently. `caps.length` was the test once, and it
     made `storage` -- a 512 KB key only that program can read -- stop the build
     as firmly as reading the user's files did. Six of the first eight generated
     apps declared it, so the prompt fired on nearly every build and became
     something to click through. `forge.capsNeedingConsent` owns the line.

     Understating the list cannot dodge the dialog usefully, because the list
     *is* the manifest -- claim less and the installed program gets less. The
     explicit `capabilities` on the way to install() matters for the same reason:
     install() falls back to the previous version's capabilities when the field
     is absent, so omitting it would hand new code the old program's grants with
     nothing shown.

     The dialog is off by default now (`forge.installPrefs().confirmInstall`).
     Pressing 「建置」 is the authorisation; asking the same person again a few
     minutes later produces a habit, not a decision. The capabilities are stated
     in the build log before the install and in the app's row after it, so what
     was granted is said twice without a modal. Turn it back on in App Forge. */
  ipcMain.handle('forge:installByGesture', plain(async (args = {}) => {
    const caps = forge.sanitiseCaps(args.capabilities);
    if (forge.installPrefs().confirmInstall && forge.capsNeedingConsent(caps).length) {
      const { response } = await askBox(getWindow(), {
        type: 'question',
        buttons: ['取消', '安裝'],
        defaultId: 1,
        cancelId: 0,
        title: '安裝生成的程式',
        message: '安裝「' + String(args.name || args.slug || '未命名') + '」？',
        // Every declared capability, not only the ones that raised the dialog:
        // this is the manifest being granted, and a person deciding on `ai`
        // should still see what else comes with it.
        detail: '這個程式要求以下能力：\n\n' +
          caps.map((c) => '  · ' + c + '　' + (forge.APP_CAP_NOTES[c] || '')).join('\n') +
          '\n\n能力只在這個程式自己的沙箱視窗內有效。之後可以在 App Forge 裡解除安裝。'
      });
      if (response !== 1) return { installed: false, canceled: true };
    }
    return forge.install({ ...args, capabilities: caps });
  }));
  ipcMain.handle('forge:installPrefs', plain(async () => forge.installPrefs()));
  ipcMain.handle('forge:setConfirmInstall', plain(async ({ on }) => forge.setConfirmInstall(on)));
  ipcMain.handle('forge:setAutoRepair', plain(async ({ on }) => forge.setAutoRepair(on)));
  ipcMain.handle('forge:history', plain(async ({ slug }) => forge.listHistory(slug)));
  ipcMain.handle('forge:version', plain(async ({ slug, version }) => forge.getVersion(slug, version)));
  ipcMain.handle('forge:rollback', guarded('app.create',
    async ({ slug, version }) => forge.rollback(slug, version),
    null, '把一個生成的程式回復到舊版本'));
  ipcMain.handle('forge:approve', guarded('app.create', async ({ slug }) => forge.approveCurrent(slug),
    null, '核准一個被改動過的程式，讓它可以再次執行'));
  ipcMain.handle('forge:remove', guarded('app.create', async ({ slug }) => forge.remove(slug),
    null, '解除安裝一個生成的程式（撤銷執行許可，檔案保留）'));
  ipcMain.handle('forge:slug', plain(async ({ name }) => ({ slug: forge.toSlug(name) })));

  /* ------------------------------------------------- share and import ----

     Export writes one file into the sandbox and is a write like any other,
     so it answers to fs.write; the model may ask for it through the Forge
     app's `share` action, and a package is only what the sandbox already
     holds. Import is the other direction and is not a syscall at all: the
     preview reads a sandbox file (fs.read, like opening any document), and
     the install happens only after the dialog below, which nothing in this
     process opens except a person's request from the Forge window. */
  ipcMain.handle('forge:export', guarded('fs.write',
    async ({ slug, history }) => forge.exportApp(slug, { history: history !== false, appVersion: app.getVersion() }),
    null, '把一個生成的程式打包成 .aiosapp 放到 /outbox'));

  ipcMain.handle('forge:importPreview', guarded('fs.read',
    async ({ path: p }) => forge.importPreview(p),
    okPath('path'), '讀取一個 .aiosapp 程式包，看看裡面是什麼'));

  ipcMain.handle('forge:importCancel', plain(async ({ token }) => ({ dropped: forge.dropImport(token) })));

  /* The dialog. Always, whatever the program asks for: the gesture install
     may go without one because the person asked for that program minutes
     ago, and a file somebody sent is not that. The text is composed here from
     the held copy of the package, not from anything the renderer says about
     it -- the one line the renderer contributes, its check result, is
     labelled as its. Three buttons when the name is taken, because "replace
     or install beside" is a decision with no safe default. */
  ipcMain.handle('forge:importConfirm', plain(async ({ token, checks } = {}) => {
    const p = forge.pendingImport(token);
    if (!p) throw Object.assign(new Error('這個匯入已經過期或不存在，重新開啟程式包'), { code: 'ENOENT' });
    const { pkg } = p;
    const caps = pkg.app.capabilities;
    const reaching = forge.capsNeedingConsent(caps);
    const have = forge.installedMeta(pkg.app.id);
    const beside = have ? forge.freeSlug(pkg.app.id) : null;
    const kb = (n) => Math.max(1, Math.round(n / 1024)) + ' KB';
    const lines = [
      '來源：' + p.vpath + (pkg.exportedBy ? '（由 ' + pkg.exportedBy + ' 匯出' +
        (pkg.exportedAt ? '，' + new Date(pkg.exportedAt).toLocaleString('zh-TW') : '') + '）' : ''),
      '說明：' + (pkg.app.purpose || '（沒有）'),
      '原版本 v' + pkg.app.version + '　程式碼 ' + kb(pkg.code.length) +
        '　套件：' + (pkg.libs.length ? pkg.libs.map((l) => l.name + '@' + l.version).join('、') : '無') +
        '　歷史：' + (pkg.history.length ? pkg.history.length + ' 筆' : '無'),
      '',
      caps.length
        ? '這個程式要求以下能力：\n' + caps.map((c) => '  · ' + c + '　' + (forge.APP_CAP_NOTES[c] || '')).join('\n')
        : '這個程式不要求任何能力（純運算與介面）。',
      '',
      'Forge 在這台機器上的檢查：' + (checks && checks.ok ? '靜態檢查與冒煙測試通過' : '沒有通過或沒有跑'),
      '',
      '這是別人寫的程式碼。能力只在它自己的沙箱視窗內有效' +
        (reaching.length ? '，但 ' + reaching.join('、') + ' 會讓它讀到或送出你的資料' : '') +
        '。之後可以在 App Forge 解除安裝。'
    ];
    if (have) {
      lines.push('', '已經有一個「' + have.name + '」（v' + have.version + '）。' +
        '「取代」會裝成 v' + (have.version + 1) + ' 並保留歷史；「另外安裝」會裝成「' + beside + '」。');
    }
    const buttons = have
      ? ['取消', '另外安裝（' + beside + '）', '取代（v' + (have.version + 1) + '）']
      : ['取消', '匯入'];
    const { response } = await askBox(getWindow(), {
      type: reaching.length ? 'warning' : 'question',
      buttons,
      defaultId: 0,
      cancelId: 0,
      title: '匯入程式',
      message: '匯入「' + pkg.app.name + '」？',
      detail: lines.join('\n')
    });
    if (response === 0) {
      forge.dropImport(token);
      return { installed: false, canceled: true };
    }
    const choice = have ? (response === 2 ? 'replace' : 'beside') : 'new';
    const out = await forge.importInstall(token, choice);
    return { installed: true, ...out };
  }));

  /* Ungated: it compiles a string to find out whether it parses and throws the
     result away. Nothing is executed -- a SyntaxError happens during compilation,
     before any statement could run -- and nothing is written. */
  ipcMain.handle('forge:checkSyntax', plain(async ({ code }) => forge.checkSyntax(code)));

  // Hand the frame HTML to the main process and get back a one-shot URL to put
  // in the iframe. Ungated: this grants nothing the caller does not already
  // have -- the renderer composed the markup and the code inside it came from
  // forge.load(), which refuses anything whose hash was not approved. What it
  // buys is a document with its own CSP instead of the shell's inherited one.
  /* A package the planner asked for, fetched from npm/jsDelivr and pinned.
     Gated as a network request -- it is one, made on the user's behalf --
     and described, because web.read's own wording is about reading a page. */
  ipcMain.handle('forge:fetchLib', guarded('web.read', async ({ name }) => forge.fetchLib(name),
    null, '下載生成程式需要的套件（從 npm）'));
  ipcMain.handle('forge:libSource', plain(async ({ key }) => forge.libSource(key)));

  ipcMain.handle('forge:frame', plain(async ({ slug, html }) => forge.publishFrame(slug, html)));
  ipcMain.handle('forge:frameRevoke', plain(async ({ token }) => ({ revoked: forge.revokeFrame(token) })));

  /* An installed program reaching the machine. Ungated by policy on purpose:
     the decision about a program is made at planning time and at install, and
     a program that was allowed to exist is not stopped afterwards -- not by an
     ASK on fs.write, not by the taint downgrade. What replaces the gate is the
     manifest, checked in forge.assertGrant against the index outside the
     sandbox: installed, hash intact, capability declared. Everything below it
     still confines the call: appdata paths stay in the program's folder, the
     URL screen still refuses loopback and private ranges, the tab is the one
     on screen. The frame itself never reaches this channel; the shell's broker
     does, on the program's behalf, which is why the slug can be trusted. */
  ipcMain.handle('app:call', plain(async ({ slug, call, args = {} } = {}) => {
    const g = await forge.assertGrant(slug, call);
    switch (call) {
      case 'files.list': {
        try {
          return await sandbox.list(forge.appDataPath(g.id, args.dir || ''));
        } catch (e) {
          if (e.code === 'ENOENT') return { vpath: g.appDir, entries: [] };
          throw e;
        }
      }
      case 'files.read':
        return (await sandbox.read(forge.appDataPath(g.id, args.path))).content;
      case 'files.write': {
        await sandbox.mkdir(g.appDir).catch(() => {});
        const target = forge.appDataPath(g.id, args.path);
        const parent = target.slice(0, target.lastIndexOf('/'));
        if (parent && parent !== g.appDir) await sandbox.mkdir(parent).catch(() => {});
        return sandbox.write(target, String(args.content == null ? '' : args.content), { origin: 'local' });
      }
      case 'sandbox.list':
        return sandbox.list(String(args.dir || '/'));
      case 'sandbox.read': {
        const f = await sandbox.read(String(args.path || ''));
        return { content: f.content, untrusted: f.untrusted, vpath: f.vpath };
      }
      /* Anywhere in the sandbox, which is the whole of what the manifest
         grants; the reserved names (.mail, .trash) are refused by resolve()
         as they are for everyone. */
      case 'sandbox.write':
        return sandbox.write(String(args.path || ''), String(args.content == null ? '' : args.content), { origin: 'local' });
      case 'sandbox.mkdir':
        return sandbox.mkdir(String(args.path || ''));
      case 'net.fetch':
        web.validateUrl(args.url);
        return web.fetchRaw(args.url, args.opts && typeof args.opts === 'object' ? args.opts : {});
      case 'clipboard.write':
        clipboard.writeText(String(args.text || '').slice(0, 200000));
        return true;
      case 'page.read':
        return browser.pageNodes(args.tab, Math.min(4000, Number(args.limit) || 1200));
      case 'page.apply':
        return browser.applyToPage(args.tab, Array.isArray(args.ops) ? args.ops : []);
      case 'page.pdf':
        return pageToPdf(args.tab, String(args.path || ''));
      default:
        throw Object.assign(new Error('程式不能發出這種呼叫：' + call), { code: 'EINVAL' });
    }
  }));

  /* --------------------------------------------------------- clipboard ---- */

  ipcMain.handle('clip:write', plain(async ({ text }) => {
    clipboard.writeText(String(text || '').slice(0, 200000));
    return { ok: true };
  }));
  ipcMain.handle('clip:read', plain(async () => ({ text: clipboard.readText().slice(0, 200000) })));
}


module.exports = { register };
