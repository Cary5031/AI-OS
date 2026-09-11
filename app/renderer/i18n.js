'use strict';

/* ===========================================================================
   AI-OS // interface language
   ---------------------------------------------------------------------------
   The shell was written in Traditional Chinese, and that stays the source of
   truth: every string in the markup and the code is still the Chinese one.
   This layer holds the English for the parts a person meets first -- the menu
   bar and its menus, the dock, the HUD, the intent bar, the launcher, the
   window furniture, the about and version windows, the shutdown ceremony --
   and swaps them in when the language is English.

   Two mechanisms, one dictionary:

     * Markup: an element carrying data-i18n="key" (or data-i18n-title,
       data-i18n-placeholder, data-i18n-aria) has its Chinese captured on the
       first pass and replaced from the dictionary. Switching back restores
       the captured text, so the markup never has to be written twice.
     * Code: AIOS.i18n.t('key', '中文') returns the English when the language
       is English and the key is known, the Chinese otherwise. A key that is
       missing from the dictionary is not an error -- the Chinese shows, and
       the gap is visible rather than a blank.

   Coverage is honest, not complete: the applications' own interiors (the
   document editor, the spreadsheet, the Forge log) still speak Chinese. The
   dictionary is where that grows.
   =========================================================================== */

/* global window, document */

(function () {
  var AIOS = (window.AIOS = window.AIOS || {});

  var LOCALES = ['zh-TW', 'en'];
  var NAMES = { 'zh-TW': '繁體中文', en: 'English' };

  var EN = {
    /* ----------------------------------------------------------- menu bar */
    'mb.system': 'System', 'mb.view': 'View', 'mb.theme': 'Theme', 'mb.help': 'Help',
    'mb.menus': 'System menus',
    'mb.ctx': 'Context usage / budget',
    'mb.decode': 'Decode speed of the last inference',
    'mb.prefill': 'Prefill speed of the last inference',
    'mb.model': 'Current model',
    'mb.min': 'Minimise window', 'mb.full': 'Toggle full screen', 'mb.close': 'Close AI-OS',

    'sys.import': 'Import files from the OS…',
    'sys.reveal': 'Open the sandbox in Explorer',
    'sys.trash': 'Sandbox trash',
    'sys.reconnect': 'Reconnect the core',
    'sys.endpoint': 'Core model…',
    'sys.cleartaint': 'Clear the taint mark',
    'sys.lang': 'Language',
    'sys.version': 'Release notes…',
    'sys.reset': 'Clear the session',
    'sys.reboot': 'Reboot',
    'sys.shutdown': 'Shut down',

    'view.left': 'Attention / capability HUD',
    'view.right': 'Kernel trace HUD',
    'view.chips': 'Intent bar suggestions',
    'view.size': 'Text size',
    'view.size1': 'Standard (100%)',
    'view.size115': 'Large (115%)',
    'view.size130': 'Extra large (130%)',
    'view.size150': 'Largest (150%)',
    'view.tile': 'Tile windows',
    'view.closeall': 'Close all windows',

    'help.about': 'About this machine',
    'help.injection': 'Demo: prompt injection',

    'theme.midnight': 'Midnight', 'theme.void': 'Void', 'theme.ocean': 'Ocean', 'theme.forest': 'Forest',
    'theme.nord': 'Nord', 'theme.violet': 'Violet', 'theme.crimson': 'Crimson', 'theme.copper': 'Copper',
    'theme.amber': 'Amber', 'theme.mono': 'Mono', 'theme.daylight': 'Daylight', 'theme.mint': 'Mint',
    'theme.sakura': 'Sakura', 'theme.paper': 'Paper',
    'themeHint.midnight': 'Near-black indigo, the darkest', 'themeHint.void': 'Deep blue-black, the default',
    'themeHint.ocean': 'Deep teal', 'themeHint.forest': 'Deep green', 'themeHint.nord': 'Cool grey-blue, easy on the eyes',
    'themeHint.violet': 'Deep purple with teal', 'themeHint.crimson': 'Dark wine red', 'themeHint.copper': 'Warm copper brown',
    'themeHint.amber': 'Amber, like an old terminal', 'themeHint.mono': 'Pure greyscale, high contrast',
    'themeHint.daylight': 'Light, cool', 'themeHint.mint': 'Light, pale green', 'themeHint.sakura': 'Light, pale pink',
    'themeHint.paper': 'Light, warm like paper',
    'theme.current': ' (in use)',
    'theme.customSection': 'Custom themes', 'theme.customDark': 'custom, dark', 'theme.customLight': 'custom, light',
    'theme.customNew': 'Custom theme…',
    'theme.customNewTitle': 'Build a palette of your own from one colour; keep as many as you like',
    'theme.edit': 'Edit this theme', 'theme.draft': '(a draft being previewed)',

    /* ------------------------------------------------------ theme editor */
    'thm.title': 'Custom theme', 'thm.which': 'Theme', 'thm.new': '+ New theme',
    'thm.newTitle': 'Start a new one from the current theme\'s primary colour',
    'thm.name': 'Name', 'thm.namePh': 'e.g. My blue, Night sakura',
    'thm.mode': 'Light / dark', 'thm.dark': 'Dark', 'thm.light': 'Light',
    'thm.primary': 'Primary colour', 'thm.primaryHex': 'Primary colour (hex)',
    'thm.seed': 'Take the primary from a built-in theme…',
    'thm.primaryNote': 'The rest is matched to the primary by the system, with lightness adjusted until it reads (4.5:1 or better). Items you set by hand are not moved by the primary.',
    'thm.details': 'Details', 'thm.autoAll': 'Let the system match everything',
    'thm.autoAllTitle': 'Drop every manual adjustment and match again from the primary',
    'thm.detailsNote': 'Every item can be chosen by hand. Changed ones are marked "manual"; ↺ hands one back to the system.',
    'thm.hexSuffix': ' (hex)', 'thm.resetOne': 'Hand back to the system', 'thm.manual': 'manual', 'thm.auto': 'auto',
    'thm.key.bg-0': 'Base', 'thm.key.bg-1': 'Panel', 'thm.key.fg': 'Text', 'thm.key.fg-dim': 'Secondary text',
    'thm.key.fg-faint': 'Hint text', 'thm.key.accent': 'Accent', 'thm.key.accent-2': 'Second accent',
    'thm.key.warn': 'Warning', 'thm.key.danger': 'Danger', 'thm.key.taint': 'Taint mark', 'thm.key.on-fill': 'Text on a fill',
    'thm.hint.bg-0': 'The bottom-most background, behind the desktop and the windows',
    'thm.hint.bg-1': 'The desktop gradient, panels and window bodies',
    'thm.hint.fg': 'Body text', 'thm.hint.fg-dim': 'Menus, window titles, secondary content',
    'thm.hint.fg-faint': 'Notes, the status bar, placeholders',
    'thm.hint.accent': 'Buttons, links, focus, selection', 'thm.hint.accent-2': 'Success, the connection LED, a second emphasis',
    'thm.hint.warn': 'Budget exceeded, things to notice', 'thm.hint.danger': 'Errors, delete, shut down',
    'thm.hint.taint': 'The mark shown after untrusted content was read',
    'thm.hint.on-fill': 'The text on top of the accent, warning or danger colour when it is a fill',
    'thm.checkOk': 'Every text/ground pair is at 4.5:1 or better',
    'thm.checkBad': '{n} pair(s) will be hard to read:',
    'thm.fix': 'Fix the contrast', 'thm.fixTitle': 'Lightness only, hues kept; fixed items count as manual',
    'thm.preview': 'Live preview', 'thm.live': 'Also apply to the whole desktop',
    'thm.saveApply': 'Save and apply', 'thm.duplicate': 'Save as a new theme',
    'thm.duplicateTitle': 'Copy this one, manual adjustments included, into another theme',
    'thm.delete': 'Delete', 'thm.untitled': 'Untitled', 'thm.copySuffix': ' copy',
    'thm.pickNew': '(new theme)', 'thm.pickNewNow': 'New theme (not saved yet)',
    'thm.needName': 'Give the theme a name first', 'thm.saveFail': 'Not saved: {err}',
    'thm.err.EEXIST': 'a custom theme with that name already exists',
    'thm.err.EFULL': 'at most 32 custom themes; delete some first',
    'thm.unfixable': '{n} pair(s) cannot be fixed by lightness alone: change the ground or the text-on-fill colour',
    'thm.saved': 'Saved "{name}"', 'thm.savedTrace': 'Custom theme "{name}" saved',
    'thm.deleteAsk': 'Delete the custom theme "{name}"?',
    'thm.deleteNote': 'If it is in use, the desktop goes back to the default theme.',
    'thm.deleteFail': 'Not deleted: {err}', 'thm.deletedTrace': 'Custom theme "{name}" deleted',
    'thm.unsaved': 'This theme has unsaved changes',
    'thm.unsavedNote': 'Save keeps it as a custom theme; Don\'t save throws the changes away.',
    'thm.pvTitle': 'weekly-report.docx', 'thm.pvHeading': 'Text is headings and body',
    'thm.pvFg': 'This is body text: documents, memory and chat use it.',
    'thm.pvDim': 'Secondary text: menus, window titles, table headers.',
    'thm.pvFaint': 'Hint text: notes, the status bar, placeholders.',
    'thm.pvLinkPre': 'The accent paints ', 'thm.pvLink': 'links and focus', 'thm.pvLinkPost': ', and selections.',
    'thm.pvPrimary': 'Primary button', 'thm.pvPlain': 'Button', 'thm.pvDanger': 'Delete',
    'thm.pvOk': 'exec fs.write — wrote /notes/weekly.md', 'thm.pvWarn': 'context over budget, evicted 2 pages',
    'thm.pvErr': 'fail net.egress — denied by policy', 'thm.pvTaint': 'untrusted content read, elevated capabilities downgraded',
    'thm.pvChip1': 'Set a 25-minute focus timer', 'thm.pvChip2': 'Tidy up the windows',

    /* ------------------------------------------------------------ desktop */
    'wm.tagline': 'Intent is the syscall',
    'winlayer': 'Windows',
    'boot.skip': 'Skip ›',

    'hud.left': 'Kernel resources',
    'hud.sched': 'Attention scheduler',
    'hud.schedInfo': 'The scarce resource this layer manages is not CPU time but the context window.',
    'hud.budget': 'Budget',
    'hud.budgetNote': 'Lower the budget and watch the kernel evict pages — the model forgets on the spot.',
    'hud.pages': 'Resident context pages',
    'hud.composition': 'Context page composition',
    'hud.sandbox': 'Sandbox',
    'hud.sandboxInfo': 'The core sees only this directory. Files on the operating system are never touched; deleting moves to the sandbox trash.',
    'hud.sandboxUsage': 'Sandbox usage',
    'hud.clearMark': 'Clear mark',
    'hud.sbImport': 'Import from OS…',
    'hud.sbOpen': 'Open in Explorer',
    'hud.caps': 'Capability gate',
    'hud.capsInfo': 'The policy is kept and enforced by the main process. The renderer can only display it, never approve on its own.',
    'hud.capsList': 'Capability policy',
    'hud.capsNote': 'Click to cycle ALLOW / ASK / DENY.',
    'hud.memory': 'Long-term memory',
    'hud.memoryInfo': 'Retrieval is a new page: hot in the context, warm in the index, cold on disk.',
    'hud.right': 'Kernel trace',
    'hud.trace': 'Kernel trace',
    'hud.traceInfo': 'Intent → plan → gate → execute, every step visible.',
    'hud.traceLog': 'Kernel messages',
    'hud.journal': 'Action journal',
    'hud.journalInfo': 'A system without a replayable, undoable journal can be neither debugged nor audited.',
    'hud.journalList': 'Executed actions',

    'intent.label': 'Your intent',
    'intent.placeholder': 'Say what you want done, not how…',
    'intent.hideChips': 'Hide suggestions',
    'intent.showChips': 'Show suggestions',
    'intent.run': 'Run', 'intent.runAria': 'Run intent', 'intent.stop': 'Stop',
    'intent.help': 'Enter sends, Shift+Enter breaks the line, Ctrl+K focuses.',
    'intent.chips': 'Example intents',

    'chip.0': 'Set a 25-minute focus timer',
    'chip.1': 'Open Documents, I want to write this week\'s report',
    'chip.2': 'Open a new spreadsheet for this month\'s expenses',
    'chip.3': 'Open Slides, I want a three-page project status deck',
    'chip.4': 'Remember that I prefer replies in English and code comments in English',
    'chip.5': 'Tidy up the windows',

    'dock.intent': 'Intent bar (Ctrl+K)', 'dock.apps': 'All applications',
    'dock.files': 'File manager (sandbox)', 'dock.editor': 'Editor', 'dock.browser': 'Browser',
    'dock.mail': 'Mail', 'dock.docs': 'Documents', 'dock.sheets': 'Spreadsheet', 'dock.slides': 'Slides',
    'dock.pdf': 'PDF viewer', 'dock.markdown': 'Markdown viewer', 'dock.photos': 'Image viewer',
    'dock.memory': 'Long-term memory', 'dock.forge': 'App Forge: the core writes programs',
    'dock.schedule': 'Scheduler: run programs or intents on a timer',
    'dock.extract': 'Document extraction: PDFs into tables by vendor profile, then filed',
    'dock.import': 'Import files from the OS', 'dock.trash': 'Sandbox trash', 'dock.policy': 'Capability policy',
    'dock.hudLeft': 'Resource HUD', 'dock.hudRight': 'Trace HUD',

    'drop.title': 'Release to copy into the sandbox',
    'drop.note': 'The originals are neither moved nor modified',

    /* ------------------------------------------------------- applications */
    'app.files': 'Files', 'app.editor': 'Editor', 'app.browser': 'Browser', 'app.mail': 'Mail',
    'app.docs': 'Documents', 'app.sheets': 'Spreadsheet', 'app.slides': 'Slides', 'app.pdf': 'PDF viewer',
    'app.markdown': 'Markdown', 'app.memory': 'Memory', 'app.forge': 'App Forge', 'app.schedule': 'Scheduler',
    'app.photos': 'Image viewer', 'app.extract': 'Document extraction',
    'launcher.title': 'Applications',
    'launcher.intro': 'Every application runs inside the sandbox. The ✉ at the top right of each window opens that application\'s own AI chat panel, which can see what the application is showing.',
    'launcher.generated': 'made by the core',

    'win.chatOpen': 'Open AI chat', 'win.chatClose': 'Close AI chat',
    'win.new': 'Open another window', 'win.min': 'Minimise', 'win.close': 'Close window',
    'win.restore': 'Restore ',
    'win.unsaved': '"{name}" has unsaved changes',
    'win.unsavedNote': 'Closing discards them. Save writes the file; without a file name it goes to /notes.',

    'ok': 'OK', 'cancel': 'Cancel', 'choose': 'Choose', 'save': 'Save', 'discard': 'Don\'t save',
    'confirm.continue': 'Continue?', 'confirm.unsaved': 'Unsaved changes', 'prompt.input': 'Input',

    /* ----------------------------------------------------------------- HUD */
    'ui.unmounted': '(not mounted)', 'ui.over': ' over', 'ui.noActions': 'No actions yet',
    'ui.undo': 'Undo', 'ui.undone': 'Undone', 'ui.undoAria': 'Undo action ',
    'ui.memEmpty': '(empty — nothing is seeded)',
    'ui.memHint': 'Say "remember…" in the intent bar, or open Memory from the Dock.',
    'ui.learned': 'learned', 'ui.manual': 'entered by hand', 'ui.used': ', used {n} times',
    'ui.files': ' files / ', 'ui.tainted': 'Untrusted content was read: ',
    'ui.capClick': 'Click to cycle ALLOW / ASK / DENY.',
    'ui.capAria': '{cap} is {state}, click to change',
    'ui.stopSent': 'Stop signal sent',

    /* ------------------------------------------------------- desktop menu */
    'desk.apps': 'All applications', 'desk.files': 'Files', 'desk.intent': 'Intent bar',
    'desk.tile': 'Tile windows ({n})', 'desk.stack': 'Stack', 'desk.restoreAll': 'Restore all',
    'desk.theme': 'Theme: {name} (change it in the Theme menu)',
    'desk.import': 'Import files from the OS…', 'desk.trash': 'Trash', 'desk.shutdown': 'Shut down',

    /* ---------------------------------------------------------- shutdown */
    'shutdown.ask': 'Shut down AI-OS?',
    'shutdown.note': 'Every window and the session are saved first; the next start returns to this desktop.',
    'shutdown.ok': 'Shut down',
    'sd.quiesce': 'No longer accepting intents …',
    'sd.snapshot': 'Saving the state of {n} window(s) …',
    'sd.session': 'Writing the session …\n  session.json　{kb} KiB　{w} window(s)　{p} context page(s)',
    'sd.sessionFail': 'Writing the session failed: {err}',
    'sd.memory': 'Long-term memory is on disk: {text}',
    'sd.memoryUnknown': 'unknown',
    'sd.memoryCount': '{n} item(s) (manual {m} · learned {l})',

    /* --------------------------------------------------------- about / ver */
    'about.title': 'About this machine',
    'about.version': 'This is {line}. Changes by version are under System → Release notes.',
    'about.machine': 'AI-OS is a real machine: intent is its system-call interface, a language model is its intent kernel.',
    'about.core': 'Core: {model} on {provider}, n_ctx = {nctx}. Everything you type is {measured}, placed in a context page, and kept or evicted by the scheduler.{remote}',
    'about.measured': 'counted by a real tokenizer',
    'about.estimated': 'estimated in length (this provider has no tokenizer)',
    'about.remote': ' This core is remote: prompts leave this machine.',
    'about.local': ' This core runs on this machine.',
    'about.files': 'Files: real. The sandbox is at {root}; reads, writes and deletes are real file operations. The core cannot leave that directory, files on the operating system are never affected, and deleting moves into the sandbox trash — so "undo" in the action journal is a real restore.',
    'about.import': 'To bring things in: use "Import from OS" on the left, or drop files onto this window. Always a copy; the originals are neither moved nor modified. Files from outside are marked untrusted.',
    'about.lang': 'Interface language: English (menus, HUD, dock, dialogs). The applications\' interiors still speak Chinese.',
    'about.unknown': 'AI-OS (version unknown)',
    'about.notConnected': '(not connected)',
    'ver.title': 'Release notes',
    'ver.mode.portable': 'portable', 'ver.mode.installed': 'installed', 'ver.mode.source': 'from source',
    'ver.platform': 'Platform', 'ver.core': 'Core model', 'ver.data': 'Data location', 'ver.sandbox': 'Sandbox',
    'ver.copy': 'Copy version info', 'ver.copied': 'Version info copied', 'ver.copyFail': 'Copy failed',
    'ver.unreadable': 'Version info could not be read',
    'ver.remote': ' (remote)',
    'ver.thisVersion': 'Changes in this version', 'ver.noNotes': 'No notes for this version (app/release-notes.json has no entry for v{v}).',
    'ver.older': 'Earlier versions ({n})',

    /* ------------------------------------------------------ image viewer */
    'ph.none': '(no picture open)', 'ph.open': 'Open…', 'ph.prev': 'Previous (←)', 'ph.next': 'Next (→)',
    'ph.zoomOut': 'Zoom out (-)', 'ph.zoomIn': 'Zoom in (+)',
    'ph.zoomToggle': 'Switch between fit-to-window and 100% (double-click the picture does too)',
    'ph.fit': 'Fit', 'ph.fitTitle': 'Zoom so the whole picture shows (0)', 'ph.oneTitle': 'Actual size (1)',
    'ph.rotate': 'Rotate 90° clockwise (r)', 'ph.bg': 'Background: checkerboard / dark / light (for transparency)',
    'ph.reveal': 'Show in Explorer',
    'ph.emptyText': 'No picture open. Double-click one in the file manager, or press Open… to pick one from the sandbox.',
    'ph.fitted': 'Fitted to the window ({pct}%)', 'ph.noneOpen': 'No picture open', 'ph.badZoom': 'The zoom has to be a positive number',
    'ph.zoomed': 'Zoomed to {pct}%', 'ph.rotated': 'Rotated; now at {deg}°', 'ph.of': '{i} of {n}',
    'ph.infoText': '{name}: {w} × {h} pixels, {bytes}, {type}{pos}', 'ph.infoPos': ', {i} of {n} in this folder',
    'ph.pubHead': 'Picture: {path}', 'ph.pubView': 'Zoom {pct}%, rotation {deg}°',
    'ph.pubList': 'Pictures in the same folder: {list}',
    'ph.noPath': 'No path given',
    'ph.notImage': '{name} is not a format this viewer reads (png, jpg, gif, webp, bmp, avif)',
    'ph.readFail': 'Could not read {name}: {err}', 'ph.decodeFail': '{name} could not be decoded; the file may be damaged',
    'ph.opened': 'Opened {name} ({w} × {h})', 'ph.alone': 'This is the only picture in its folder',
    'ph.pickLabel': 'Open a picture', 'ph.prevMenu': 'Previous', 'ph.nextMenu': 'Next', 'ph.actual': 'Actual size',
    'ph.rotateMenu': 'Rotate 90° clockwise', 'ph.bgMenu': 'Switch background', 'ph.copyPath': 'Copy path',
    'ph.copied': 'Copied {path}', 'ph.showInFiles': 'Show in the file manager', 'ph.reload': 'Reload',
    'ph.descNone': 'No picture is open. Use open {path} to open one from the sandbox.',

    /* ------------------------------------------------------------- prefs */
    'prefs.langSet': 'Interface language: {name}. Saved; the next start uses it too.',
    'prefs.zoomSet': 'Text size: {pct}%. Saved.',
    'prefs.fail': 'Could not save the setting: {err}',
    'policy.title': 'Capability policy',
    'session.saved': 'session saved ({w} window(s) / {p} page(s))',
    'session.cleared': 'Saved session cleared; the next start is a fresh desktop'
  };

  var locale = 'zh-TW';

  function fill(s, vars) {
    if (!vars) return s;
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? String(vars[k]) : m; });
  }

  /** The English for `key` when English is on and known; the Chinese otherwise. */
  function t(key, zh, vars) {
    var s = locale === 'en' && Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : zh;
    return fill(s == null ? '' : s, vars);
  }

  var ATTRS = [
    ['data-i18n', null, 'i18nZh'],
    ['data-i18n-title', 'title', 'i18nZhTitle'],
    ['data-i18n-placeholder', 'placeholder', 'i18nZhPlaceholder'],
    ['data-i18n-aria', 'aria-label', 'i18nZhAria']
  ];

  /** Retranslate every marked element under `root` (the document by default). */
  function apply(root) {
    root = root || document;
    ATTRS.forEach(function (spec) {
      var attr = spec[0];
      var target = spec[1];
      var stash = spec[2];
      var nodes = root.querySelectorAll('[' + attr + ']');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var key = n.getAttribute(attr);
        var current = target ? n.getAttribute(target) : n.textContent;
        if (n.dataset[stash] === undefined) n.dataset[stash] = current == null ? '' : current;
        var next = t(key, n.dataset[stash]);
        if (target) n.setAttribute(target, next);
        else n.textContent = next;
      }
    });
    document.documentElement.setAttribute('lang', locale === 'en' ? 'en' : 'zh-Hant');
  }

  function set(next) {
    if (LOCALES.indexOf(next) < 0) return locale;
    var changed = next !== locale;
    locale = next;
    apply();
    if (changed) {
      try { document.dispatchEvent(new CustomEvent('aios:locale', { detail: { locale: locale } })); } catch (e) { /* old DOM */ }
    }
    return locale;
  }

  AIOS.i18n = {
    LOCALES: LOCALES,
    NAMES: NAMES,
    t: t,
    apply: apply,
    set: set,
    has: function (key) { return Object.prototype.hasOwnProperty.call(EN, key); },
    get locale() { return locale; },
    get isEnglish() { return locale === 'en'; },
    /* Exposed for the tests, which check that every key the shell asks for
       is one the dictionary answers. */
    keys: function () { return Object.keys(EN); }
  };

  /* The saved language, before the desktop paints. The boot screen is up for
     a few seconds either way, so this lands well before anyone reads a menu. */
  try {
    if (window.aios && window.aios.prefs) {
      window.aios.prefs.get().then(function (r) {
        if (r && r.ok && r.data && r.data.locale) set(r.data.locale);
      }).catch(function () { /* the Chinese default stands */ });
    }
  } catch (e) { /* the Chinese default stands */ }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { apply(); });
  else apply();
})();
