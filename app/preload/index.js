'use strict';

/* ===========================================================================
   AI-OS // preload bridge
   ---------------------------------------------------------------------------
   The entire surface the renderer gets. No fs, no child_process, no net, no
   path: only named operations that the main process validates and gates.

   Adding a function here is adding a syscall to this machine, so the list is
   grouped by subsystem and kept boring on purpose. Nothing here holds state and
   nothing here makes a decision; every call is a message.
   =========================================================================== */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, args) => ipcRenderer.invoke(channel, args);

/** Subscribe helper that always hands back an unsubscribe function. */
function on(channel, fn) {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

contextBridge.exposeInMainWorld('aios', {
  /* --------------------------------------------------------------- boot */
  boot: () => invoke('boot:run'),
  onBootStep: (fn) => on('boot:step', fn),
  onKernelLog: (fn) => on('llama:log', fn),
  kernelBacklog: () => invoke('llama:backlog'),

  /* ----------------------------------------------------------- shutdown */
  shutdown: {
    begin: () => invoke('shutdown:begin'),
    step: (text, level) => invoke('shutdown:step', { text, level }),
    ready: () => invoke('shutdown:ready'),
    onStart: (fn) => on('shutdown:start', fn)
  },

  /* ------------------------------------------------------------- system */
  sysInfo: () => invoke('sys:info'),
  /* Version, launch mode, engines, data location, release notes. Facts only;
     nothing here is a secret and nothing here can change anything. */
  about: () => invoke('sys:about'),
  /* Interface language and text size, kept by the main process across
     sessions. `set` takes a partial: { locale } or { zoom } or both. */
  prefs: {
    get: () => invoke('prefs:get'),
    set: (patch) => invoke('prefs:set', patch || {})
  },
  /* The user's own colour themes, kept beside the preferences for the same
     reason: a cleared session must not take them away. `save` takes the whole
     record; without an id it is a new theme and the reply carries the id. */
  themes: {
    list: () => invoke('themes:list'),
    save: (theme) => invoke('themes:save', theme || {}),
    remove: (id) => invoke('themes:remove', { id }),
    /* What the page is wearing right now -- id, light/dark, the twenty colour
       variables -- so the main process's confirmation layer can match it.
       Sent by themer.js whenever the theme changes. */
    report: (snap) => invoke('themes:current', snap || {})
  },
  llamaStatus: () => invoke('llama:status'),
  geometry: () => invoke('win:geometry'),
  onGeometry: (fn) => on('win:geometry', fn),

  /* --------------------------------------------------------- core model */
  /* The model transport lives on the other side of this bridge, which is the
     whole point: an API key never enters the renderer, and the renderer's CSP
     -- which allows two loopback destinations and nothing else -- does not have
     to be widened to reach a hosted provider.

     `state` reports whether a credential exists, never what it is. There is no
     getter for a key anywhere in this file, deliberately: a bridge that can
     hand one out is a bridge that a bug in the renderer can be talked into
     handing one out through. */
  model: {
    state: () => invoke('model:state'),
    select: (id) => invoke('model:select', { id }),
    configure: (id, patch) => invoke('model:configure', { id, patch }),
    setSecret: (id, key, headers) => invoke('model:setSecret', { id, key, headers }),
    forgetSecret: (id) => invoke('model:forgetSecret', { id }),
    /* Author the preset a fresh install starts from. No key material comes back
       out through either of these -- exportPreset reports which providers had
       one, never the value. */
    exportPreset: () => invoke('model:exportPreset'),
    presetState: () => invoke('model:presetState'),
    probe: () => invoke('model:probe'),
    models: (id) => invoke('model:models', { id }),
    tokenize: (text) => invoke('model:tokenize', { text }),
    chat: (requestId, req) => invoke('model:chat', { requestId, req }),
    abort: (requestId) => invoke('model:abort', { requestId }),
    onChunk: (fn) => on('model:chunk', fn)
  },

  /* ------------------------------------------------- document extraction */
  /* The 文件萃取 program's two backends, neither of which is this machine's
     model. The prompt studio is the default and owns the categories, the
     vendors, the column layouts and the tuned prompts; the second is a cloud
     model called directly, for when the studio cannot be reached. Each has its
     own address, key, auth kind and custom headers, configured in that
     program's own window. Nothing here touches the core model above, and
     nothing above touches these.

     `state` reports each backend's address, whether a key exists, and what its
     custom headers are *called*. No secret value comes back through this bridge
     -- there is no getter for one, here or in main, for the same reason as the
     core model's: a bridge that can hand a credential out is a bridge a bug in
     the renderer can be talked into handing one out through.

     `send` and `call` name sandbox paths rather than carrying bytes. The window
     never holds the document, and the main process reads it from the place it
     already had to check containment for. */
  extract: {
    state: () => invoke('extract:state'),
    /* `which` is 'service', 'fallback', or omitted for the settings that belong
       to neither: which is preferred, whether to fall back automatically, where
       documents get filed, and the name batches are submitted under. */
    configure: (which, patch) => invoke('extract:configure', { which, patch }),
    setSecret: (which, key, headers) => invoke('extract:setSecret', { which, key, headers }),
    forgetSecret: (which) => invoke('extract:forgetSecret', { which }),
    probe: (which) => invoke('extract:probe', { which }),
    /* Which backend this batch would go through, and why. The reason is half the
       answer: a window that quietly switched engines would produce rows under
       the same heading from a different source. */
    resolve: (force) => invoke('extract:resolve', { force }),
    /* What the studio last said exists, so the window still knows the shape of
       the work when the studio is unreachable. */
    catalog: () => invoke('extract:catalog'),
    /* A batch is one spreadsheet and one folder, and the two engines disagree
       about columns, mandatory fields and naming. Binding it to one engine is
       enforced in main, not here. */
    beginBatch: (which) => invoke('extract:beginBatch', { which }),
    endBatch: (token) => invoke('extract:endBatch', { token }),
    saveCatalog: (patch) => invoke('extract:saveCatalog', { patch }),
    send: (spec) => invoke('extract:send', spec || {}),
    /* Asking the studio something (GET, from a fixed list of paths). Carries
       nothing out, so it is not behind the capability -- see ipc.js. */
    call: (spec) => invoke('extract:call', { spec }),
    /* Handing the studio something: the documents, or the rows back for a
       naming plan. `spec.paths` names sandbox files; the window never holds
       their bytes. */
    upload: (spec) => invoke('extract:upload', { spec })
  },

  policy: {
    get: () => invoke('policy:get'),
    set: (cap, value) => invoke('policy:set', { cap, value })
  },

  /* Batch authorisation. The shell asks; the main process shows the list, takes
     the answer and issues bounded grants the gate then spends. */
  gate: {
    askBatch: (op, items, what) => invoke('gate:askBatch', { op, items, what }),
    clearGrants: () => invoke('gate:clearGrants')
  },

  taint: {
    state: () => invoke('taint:state'),
    add: (source, label) => invoke('taint:add', { source, label }),
    clear: () => invoke('taint:clear'),
    /* Main pushes this the moment the set changes. Without it the shell only
       found out the next time it happened to ask, so the badge lagged behind
       the downgrade it is there to explain. */
    onChanged: (fn) => on('taint:changed', fn)
  },

  /* The user's own words for this turn. The gate uses them to tell an
     instruction the user gave from one that came out of a document. */
  intent: {
    set: (text) => invoke('intent:set', { text })
  },

  /* --------------------------------------------------------------- files */
  fs: {
    tree: () => invoke('fs:tree'),
    /* Name and content. `content: false` searches names only. */
    find: (query, opts) => invoke('fs:find', { query, dir: (opts||{}).dir, content: (opts||{}).content }),
    usage: () => invoke('fs:usage'),
    list: (dir) => invoke('fs:list', { dir }),
    read: (path) => invoke('fs:read', { path }),
    /* expectMtime is optional and means "replace exactly the version I read".
       Left out, the write is unconditional, which is right for creating a file
       or for deliberately replacing one. */
    write: (path, content, expectMtime) => invoke('fs:write', { path, content, expectMtime }),

    readBytes: (path) => invoke('fs:readBytes', { path }),
    writeBytes: (path, base64, expectMtime) =>
      invoke('fs:writeBytes', { path, base64, expectMtime }),
    copy: (from, to) => invoke('fs:copy', { from, to }),
    move: (from, to) => invoke('fs:move', { from, to }),
    mkdir: (path) => invoke('fs:mkdir', { path }),
    remove: (path) => invoke('fs:delete', { path }),
    restore: (id) => invoke('fs:restore', { id }),
    /* Main watches the sandbox directory and says so when something changed
       without going through this bridge -- a file dropped in from Explorer. */
    onChanged: (fn) => on('fs:changed', fn),
    trashList: () => invoke('fs:trashList')
  },

  /* -------------------------------------------------- user-only gestures */
  user: {
    import: (into) => invoke('user:import', { into }),
    importPaths: (paths, into) => invoke('user:importPaths', { paths, into }),
    reveal: (path) => invoke('user:reveal', { path }),
    trashEmpty: () => invoke('user:trashEmpty')
  },

  /* Resolve a dropped File to its real path. The renderer cannot invent one:
     this only answers for objects the OS actually handed to the window. */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },

  /* -------------------------------------------------------------- memory */
  memory: {
    list: () => invoke('mem:list'),
    search: (query, limit) => invoke('mem:search', { query, limit }),
    add: (item) => invoke('mem:add', item),
    update: (id, patch) => invoke('mem:update', { id, patch }),
    remove: (id) => invoke('mem:remove', { id }),
    learn: (candidates) => invoke('mem:learn', { candidates }),
    markUsed: (ids) => invoke('mem:used', { ids }),
    summary: () => invoke('mem:summary'),
    export: () => invoke('mem:export'),
    import: (payload) => invoke('mem:import', { payload })
  },

  /* ------------------------------------------------------------- session */
  session: {
    save: (payload) => invoke('session:save', { payload }),
    load: () => invoke('session:load'),
    clear: () => invoke('session:clear'),
    stat: () => invoke('session:stat')
  },

  /* ----------------------------------------------------------------- web */
  web: {
    read: (url) => invoke('web:read', { url }),
    /* A plain request on behalf of a generated program (os.net.fetch). The
       frame cannot open a socket itself; this is the one way out, and it is
       behind net.egress like every other request. */
    fetch: (url, opts) => invoke('web:fetch', { url, opts })
  },

  browser: {
    create: (url) => invoke('browser:create', { url }),
    navigate: (id, url) => invoke('browser:navigate', { id, url }),
    back: (id) => invoke('browser:back', { id }),
    forward: (id) => invoke('browser:forward', { id }),
    reload: (id) => invoke('browser:reload', { id }),
    stop: (id) => invoke('browser:stop', { id }),
    bounds: (id, bounds) => invoke('browser:bounds', { id, bounds }),
    show: (id, bounds) => invoke('browser:show', { id, bounds }),
    hide: (id) => invoke('browser:hide', { id }),
    hideAll: () => invoke('browser:hideAll'),
    destroy: (id) => invoke('browser:destroy', { id }),
    list: () => invoke('browser:list'),
    readPage: (id) => invoke('browser:readPage', { id }),
    /* For extensions: numbered text nodes out, replacements for those numbers
       back. Generated code never runs inside the page. */
    pageNodes: (id, limit) => invoke('browser:pageNodes', { id, limit }),
    applyToPage: (id, ops) => invoke('browser:applyToPage', { id, ops }),
    toPdf: (id, path) => invoke('browser:toPdf', { id, path }),
    /* The page with its structure kept, for saving as Markdown, Word or PDF.
       readPage above is the same page flattened for the model to read. */
    article: (id) => invoke('browser:article', { id }),
    /* No URL argument on purpose: what may be fetched is the tab's own record
       of what the last extraction saw the page draw, and letting the renderer
       name an address would give that list away. */
    articleImages: (id) => invoke('browser:articleImages', { id }),
    printTab: (id, path, opts) => invoke('browser:printTab', { id, path, ...(opts || {}) }),
    home: () => invoke('browser:home'),
    external: (url) => invoke('browser:external', { url }),
    onEvent: (fn) => on('browser:event', fn)
  },

  /* ------------------------------------------------------------ translate

     Web page translation. The work happens in the main process, which drives
     an agent inside the page and calls the model; nothing here carries a
     paragraph in either direction. `start` is the only gated one -- it is what
     reads the page and writes into it -- and the rest are commands about a
     translation that is already running, plus the settings. */
  translate: {
    start: (tabId, patch) => invoke('translate:start', { tabId, patch }),
    stop: (tabId) => invoke('translate:stop', { tabId }),
    retry: (tabId) => invoke('translate:retry', { tabId }),
    setVisible: (tabId, on_) => invoke('translate:setVisible', { tabId, on: on_ }),
    status: (tabId) => invoke('translate:status', { tabId }),
    settings: () => invoke('translate:settings'),
    setSettings: (patch) => invoke('translate:setSettings', patch || {}),
    autoState: (url) => invoke('translate:autoState', { url }),
    setAutoDomain: (url, on_) => invoke('translate:setAutoDomain', { url, on: on_ }),
    cacheStats: () => invoke('translate:cacheStats'),
    clearCache: () => invoke('translate:clearCache'),
    onProgress: (fn) => on('translate:progress', fn)
  },

  /* ---------------------------------------------------------------- mail */
  mail: {
    status: () => invoke('mail:status'),
    discover: (email) => invoke('mail:discover', { email }),
    configure: (conf) => invoke('mail:configure', conf),
    forget: () => invoke('mail:forget'),
    verify: () => invoke('mail:verify'),
    folders: () => invoke('mail:folders'),
    list: (folder, limit) => invoke('mail:list', { folder, limit }),
    read: (folder, uid) => invoke('mail:read', { folder, uid }),
    markSeen: (folder, uid, seen) => invoke('mail:markSeen', { folder, uid, seen }),
    send: (msg) => invoke('mail:send', msg),

    /* The local mirror. The application reads these; the live calls above are
       what the sync itself uses. */
    sync: (folder, limit) => invoke('mail:sync', { folder, limit }),
    mirrorList: (opts) => invoke('mail:mirrorList', opts || {}),
    mirrorRead: (messageId, folder, uid) => invoke('mail:mirrorRead', { messageId, folder, uid }),
    mirrorFlag: (messageId, patch) => invoke('mail:mirrorFlag', { messageId, patch }),
    setSeen: (messageId, seen, folder, uid) =>
      invoke('mail:setSeen', { messageId, seen, folder, uid }),
    syncSeenPref: (on) => invoke('mail:syncSeenPref', { on }),
    mirrorStats: () => invoke('mail:mirrorStats')
  },

  /* ----------------------------------------------------------- bookmarks */
  // (browser page access for extensions lives in the browser section below)
  bookmarks: {
    list: (opts) => invoke('bookmarks:list', opts || {}),
    folders: () => invoke('bookmarks:folders'),
    add: (url, title, folder) => invoke('bookmarks:add', { url, title, folder }),
    remove: (id) => invoke('bookmarks:remove', { id }),
    rename: (id, title, folder) => invoke('bookmarks:rename', { id, title, folder }),
    has: (url) => invoke('bookmarks:has', { url }),
    exportTo: (path) => invoke('bookmarks:export', { path }),
    importFrom: (path) => invoke('bookmarks:import', { path })
  },

  /* -------------------------------------------------------------- office */
  office: {
    readDocx: (path) => invoke('office:readDocx', { path }),
    writeDocx: (path, blocks, meta) => invoke('office:writeDocx', { path, blocks, meta }),
    readXlsx: (path, sheet) => invoke('office:readXlsx', { path, sheet }),
    writeXlsx: (path, sheetName, cells, meta) => invoke('office:writeXlsx', { path, sheetName, cells, meta }),
    /* Pictures must already be data: URIs; the caller resolves them. */
    writePptx: (path, deck) => invoke('office:writePptx', { path, deck }),
    /* Render assembled HTML to PDF. The HTML is served to an offscreen window with
       scripting disabled, so it gets measured and paged, never executed. */
    writePdf: (path, html, opts) => invoke('office:writePdf', { path, html, opts }),
    convert: (kind, payload) => invoke('office:convert', { kind, payload })
  },

  /* ----------------------------------------------------------------- pdf */
  pdf: {
    read: (path, pages) => invoke('pdf:read', { path, pages }),
    probe: (path) => invoke('pdf:probe', { path }),
    /* Grant the viewer frame the right to read one file, and get back the URL to
       point an iframe at. The main process records the path after checking
       containment; the URL carries only a random token, so the frame that parses
       the document has no way to name a different file. Revoke when done. */
    publish: (path) => invoke('pdf:publish', { path }),
    revoke: (token) => invoke('pdf:revoke', { token }),
    /* `sources` is [{from, pages}] -- one entry splits, several merge.
       `destructive` says the caller is deleting or reordering, which main
       refuses on a file whose page order it had to guess at. */
    writePages: (path, sources, opts) =>
      invoke('pdf:writePages', { path, sources, ...(opts || {}) }),
    pageSpec: (spec, count, mode) => invoke('pdf:pageSpec', { spec, count, mode }),
    /* `sheets` is [{page, html}] -- the overlay for each page, already laid out
       by the renderer at that page's exact size. Main renders and appends. */
    stamp: (path, from, sheets, opts) =>
      invoke('pdf:stamp', { path, from, sheets, ...(opts || {}) }),
    /* Write a conversion: the Markdown plus its cropped images, in one call. The
       main process derives the asset folder from the Markdown path and gives every
       file the source PDF's origin, so converting an untrusted document does not
       quietly produce trusted text. */
    saveConversion: (from, path, markdown, images) =>
      invoke('pdf:saveConversion', { from, path, markdown, images })
  },

  /* ------------------------------------------------------------ schedule */
  /* The clock is in main; the work is here. A due job arrives on onFire, the
     renderer runs it and answers with report(). ready() says a handler is
     installed, and nothing fires before it is. */
  schedule: {
    list: () => invoke('schedule:list'),
    add: (job) => invoke('schedule:add', job),
    update: (id, patch) => invoke('schedule:update', { id, patch }),
    remove: (id) => invoke('schedule:remove', { id }),
    runNow: (id) => invoke('schedule:runNow', { id }),
    report: (id, result) => invoke('schedule:report', { id, result }),
    ready: () => invoke('schedule:ready'),
    onFire: (fn) => on('schedule:fire', fn)
  },

  /* --------------------------------------------------------------- forge */
  forge: {
    list: () => invoke('forge:list'),
    load: (slug) => invoke('forge:load', { slug }),
    install: (spec) => invoke('forge:install', spec),
    /* The build button's path: ungated, because pressing the button is the
       authorisation. A confirmation dialog can be switched back on. */
    installByGesture: (spec) => invoke('forge:installByGesture', spec),
    installPrefs: () => invoke('forge:installPrefs'),
    setConfirmInstall: (on) => invoke('forge:setConfirmInstall', { on }),
    /* Whether a program that throws at runtime is rebuilt without being asked.
       Capped by the window that reports the error, not here. */
    setAutoRepair: (on) => invoke('forge:setAutoRepair', { on }),
    history: (slug) => invoke('forge:history', { slug }),
    version: (slug, version) => invoke('forge:version', { slug, version }),
    rollback: (slug, version) => invoke('forge:rollback', { slug, version }),
    approve: (slug) => invoke('forge:approve', { slug }),
    remove: (slug) => invoke('forge:remove', { slug }),
    slug: (name) => invoke('forge:slug', { name }),
    /* Share and import. `export` writes /outbox/<slug>-vN.aiosapp;
       `importPreview` reads a package back and holds it under a token;
       `importConfirm` opens the main process's own dialog and installs only
       on 匯入／取代／另外安裝. There is no channel that installs without it. */
    export: (slug, opts) => invoke('forge:export', { slug, history: !(opts && opts.history === false) }),
    importPreview: (path) => invoke('forge:importPreview', { path }),
    importConfirm: (token, checks) => invoke('forge:importConfirm', { token, checks }),
    importCancel: (token) => invoke('forge:importCancel', { token }),
    /* Does the candidate parse? Compiled and discarded in the main process, which
       is the only place that can answer without putting a compiler next to the
       shell. See the handler. */
    checkSyntax: (code) => invoke('forge:checkSyntax', { code }),
    frame: (slug, html) => invoke('forge:frame', { slug, html }),
    frameRevoke: (token) => invoke('forge:frameRevoke', { token }),
    /* Packages a program asked for: resolved on npm, fetched from jsDelivr,
       syntax-checked, hash-pinned, kept under /apps/_libs. */
    fetchLib: (name) => invoke('forge:fetchLib', { name }),
    libSource: (key) => invoke('forge:libSource', { key }),
    /* An installed program's call, answered against its manifest rather than
       the policy: the decision about a program was made when it was installed.
       Main checks the slug is installed, the code is the approved code, and
       the capability is declared; the policy gate is not consulted. */
    appCall: (slug, call, args) => invoke('app:call', { slug, call, args })
  },

  /* ----------------------------------------------------------- clipboard */
  clipboard: {
    write: (text) => invoke('clip:write', { text }),
    read: () => invoke('clip:read')
  },

  /* -------------------------------------------------------------- window */
  win: {
    setFullScreen: (on_) => invoke('win:setFullScreen', { on: on_ }),
    toggleFullScreen: () => invoke('win:toggleFullScreen'),
    minimize: () => invoke('win:minimize'),
    close: () => invoke('win:close')
  }
});
