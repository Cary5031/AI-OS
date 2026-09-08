'use strict';

/* ===========================================================================
   AI-OS // application framework
   ---------------------------------------------------------------------------
   One registry, one launch path, one shape for every program on this machine --
   the built-in file manager and a program the model wrote ten seconds ago are
   the same kind of object here.

   An application declares:

     id, name, icon, kind          identity and window chrome
     width / height                preferred size
     singleton                     whether a second launch focuses the first
     accepts(path)                 whether it can open a given file
     mount(ctx)                    build the UI, return a controller
     actions                       named operations its chat pane may call

   `actions` is the important one. Every window carries an AI chat panel, and
   rather than letting the model poke at an app's DOM, each app publishes a small
   verb list with a schema. That is the same arrangement as the kernel's syscall
   table, scoped to one window: the model proposes a named action with arguments,
   and the app decides what that means.

   An application may also declare:

     menu(event, ctx)            right-click menu items for this window

   The framework owns the gesture, the positioning and the dismissal; the app
   owns what is on the menu. Apps differ enough that one shared menu would be
   wrong for all of them -- a spreadsheet cell, an editor tab and a mail message
   have almost nothing in common -- so the provider gets the raw event and
   decides from whatever was actually clicked.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var K = AIOS.kernel;

  function T(key, zh, vars) { return AIOS.i18n ? AIOS.i18n.t(key, zh, vars) : zh; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var defs = {};        // id -> definition
  var live = {};        // windowId -> instance
  var order = [];       // registration order, for the launcher

  var registry = {

    /* ------------------------------------------------------------ define */

    register: function (def) {
      if (!def || !def.id) throw new Error('app 定義缺少 id');
      if (defs[def.id]) throw new Error('app id 重複：' + def.id);
      defs[def.id] = Object.assign({
        name: def.id,
        icon: '\u25c8',
        kind: def.id.toUpperCase().slice(0, 8),
        width: 560,
        height: 380,
        singleton: false,
        chat: true,
        generated: false,
        accepts: function () { return false; },
        actions: {},
        menu: null
      }, def);
      order.push(def.id);
      return defs[def.id];
    },

    /** Replace a definition in place. Used when a forged app is rebuilt. */
    redefine: function (def) {
      if (!defs[def.id]) return registry.register(def);
      var keep = order.indexOf(def.id);
      defs[def.id] = Object.assign({}, defs[def.id], def);
      if (keep < 0) order.push(def.id);
      return defs[def.id];
    },

    unregister: function (id) {
      delete defs[id];
      order = order.filter(function (x) { return x !== id; });
    },

    get: function (id) { return defs[id] || null; },

    list: function () {
      return order.map(function (id) { return defs[id]; }).filter(Boolean);
    },

    /** Which app should open this file. First match wins, so order matters. */
    forPath: function (vpath) {
      var hit = registry.list().find(function (d) {
        try { return d.accepts(vpath); } catch (e) { return false; }
      });
      return hit || defs.editor || null;
    },

    /* ------------------------------------------------------------ launch */

    launch: async function (id, arg, opts) {
      var def = defs[id];
      if (!def) throw new Error('沒有這個程式：' + id);
      opts = opts || {};

      /* A window is identified by what it is showing, not by which app drew it.
         For a singleton that is the app itself. For everything else it is the
         document: two files open two windows, and opening a file that is already
         open lands on the window that has it -- which is what every editor does,
         and what stops two windows of one file from saving over each other. That
         failure was measured: two editors on one path, each saving in turn, and
         the first one's work was gone with nothing reported anywhere.

         `arg` undefined means no document was named -- a new, blank one -- and
         every one of those is a different document, so they do not share a key. */
      var hasDoc = arg !== undefined && arg !== null && arg !== '';

      /* An application that collects documents into tabs gets one window and N
         tabs, not N windows. `def.tabs` says it keeps them itself, and its
         `ctx.api.open` is what adds one.

         Measured, and the reason this exists: a run that produced a hundred
         notes opened a hundred windows. Past a few dozen the shell stops being
         usable -- every window is a composited layer with a blurred backdrop, so
         scrolling anything makes content blank out and come back while the
         compositor rebuilds tiles, which reads exactly like running out of
         memory on a machine with plenty of it. */
      if (def.tabs && hasDoc && !opts.forceNew) {
        var host = Object.keys(live).map(function (k) { return live[k]; })
          .find(function (inst) { return inst.def.id === id; });
        if (host && host.ctx && host.ctx.api && typeof host.ctx.api.open === 'function') {
          AIOS.wm.restore(host.win);
          AIOS.wm.focus(host.win);
          await host.ctx.api.open(arg);
          return host.win;
        }
      }

      var key = def.singleton ? 'app:' + id
        : (hasDoc ? 'app:' + id + ':' + arg : null);

      if (key && !opts.forceNew) {
        var found = Object.keys(live).map(function (k) { return live[k]; })
          .find(function (inst) {
            if (inst.def.id !== id) return false;
            return def.singleton || String(inst.arg) === String(arg);
          });
        if (found) {
          AIOS.wm.restore(found.win);
          AIOS.wm.focus(found.win);
          /* Only a singleton is asked to reopen. A document window found by its
             own path is already showing that document, and reloading it would
             throw away whatever has not been saved yet. */
          if (def.singleton && arg !== undefined && found.ctrl && found.ctrl.reopen) {
            await found.ctrl.reopen(arg);
          }
          return found.win;
        }
      }

      var instance = { def: def, arg: arg, chat: null, ctrl: null, win: null };

      var win = AIOS.wm.open({
        id: key || undefined,
        kind: def.kind,
        title: def.generated ? def.name : T('app.' + def.id, def.name),
        w: opts.width || def.width,
        h: opts.height || def.height,

        /**
         * Asked before this window is thrown away.
         *
         * A document application's controller may publish `unsaved()`; if it says
         * there are changes, this is where the user gets to keep them. Kept in the
         * registry rather than in each app so the question is worded once and
         * cannot be forgotten by the next document app somebody writes.
         *
         * A save that fails does not close the window. That is the whole point:
         * the file is the only copy, and a refused fs.write with the window gone
         * would have lost the work while reporting success.
         */
        confirmClose: async function () {
          var ctrl = instance.ctrl;
          if (!ctrl || typeof ctrl.unsaved !== 'function') return true;
          var dirty = false;
          try { dirty = !!ctrl.unsaved(); } catch (e) { dirty = false; }
          if (!dirty) return true;

          var name = typeof ctrl.docName === 'function' ? ctrl.docName() : def.name;
          var answer = await AIOS.confirmSave({
            host: instance.win ? instance.win.el : undefined,
            label: T('win.unsaved', '「{name}」有未儲存的變更', { name: name }),
            note: T('win.unsavedNote', '關閉之後這些變更就沒有了。「儲存」會寫回檔案；沒有檔名的話會存進 /notes。')
          });
          if (answer === 'cancel') return false;
          if (answer === 'discard') return true;

          try {
            await ctrl.save();
          } catch (e) {
            // Still dirty and still open, which is the honest outcome.
            if (instance.ctx) instance.ctx.toast('儲存失敗，視窗保持開著：' + (e.message || e), 't-err');
            return false;
          }
          return true;
        },
        barExtras: def.chat ? [{
          key: 'chat',
          label: '\u2709',
          title: 'AI 對話面板 (Ctrl+/)',
          pressed: false,
          onClick: function (btn) {
            var open = instance.chat.toggle();
            btn.setAttribute('aria-pressed', open ? 'true' : 'false');
          }
        }] : [],
        render: function (body, w) {
          instance.win = w;

          var split = el('div', 'app-split');
          var main = el('div', 'app-main');
          split.appendChild(main);
          body.appendChild(split);
          body.classList.add('app-body');

          var ctx = makeContext(instance, main, arg, opts.state || null);
          // Kept on the instance so an action can be invoked from outside the
          // chat panel -- the kernel's syscalls and the tests both need this.
          instance.ctx = ctx;

          if (def.chat) {
            instance.chat = AIOS.chatpane.attach(split, ctx, instance, opts.chat || null);
          } else {
            instance.chat = { toggle: function () { return false; }, isOpen: function () { return false; } };
          }

          try {
            instance.ctrl = def.mount(ctx) || {};
          } catch (e) {
            main.appendChild(el('p', 'app-error', '程式啟動失敗：' + (e.message || e)));
            if (AIOS.ui) AIOS.ui.trace('app ' + id + ' 啟動失敗：' + (e.message || e), 't-err');
          }

          // Right-click anywhere in the app. Registered after mount so a
          // provider can rely on whatever mount() built, and on the window
          // rather than the body so the chat panel gets the menu too.
          w.el.addEventListener('contextmenu', function (ev) {
            /* Editable targets used to return here, on the grounds that a text
               field keeps "the platform menu". It does not: nothing in this
               machine implements one, so right-clicking inside a paragraph, a
               formula bar or a table cell produced no menu at all -- which is
               how a table's own commands became unreachable from the one place a
               person looks for them.

               So every target gets a menu now, and an editable one gets the
               editing verbs prepended, because those are what would have been
               lost. */
            var editItems = editMenuFor(ev.target);

            // A provider registered from mount() wins over a declared one: it
            // closes over the app's own state, which is what a useful menu
            // needs. `def.menu` stays for apps with nothing local to read.
            var provider = instance.menuProvider || def.menu;
            var items = null;
            if (typeof provider === 'function') {
              try {
                items = provider(ev, ctx, instance);
              } catch (e) {
                if (AIOS.ui) AIOS.ui.trace(id + ' 選單失敗：' + (e.message || e), 't-err');
              }
            }
            items = editItems.concat((items || []).filter(Boolean));
            // Every window gets the same tail, so there is always a menu and
            // window-level actions are in one predictable place.
            items = items.concat(windowMenuTail(instance, def));

            ev.preventDefault();
            ev.stopPropagation();
            AIOS.menu.open(w.el, ev.clientX, ev.clientY, items);
          });
        },
        onClose: function () {
          var inst = live[win && win.id];
          if (inst && inst.ctrl && inst.ctrl.onClose) {
            try { inst.ctrl.onClose(); } catch (e) { /* ignore */ }
          }
          delete live[win && win.id];
          AIOS.apps.requestSave();
        }
      });

      live[win.id] = instance;
      instance.win = win;
      if (opts.chatOpen && instance.chat) {
        instance.chat.toggle(true);
        if (win.barButtons && win.barButtons.chat) win.barButtons.chat.setAttribute('aria-pressed', 'true');
      }
      AIOS.apps.requestSave();
      return win;
    },

    /* Open a file with whatever app claims it.

       forceNew is false on purpose: opening a document is a request to see it,
       not a request for another window, and `launch` keys windows by document so
       a file already open is brought forward instead of opened twice. Wanting a
       second view of one document is a different gesture, and it has to stay a
       deliberate one -- two windows on one path save over each other. */
    openPath: async function (vpath) {
      var def = registry.forPath(vpath);
      if (!def) throw new Error('沒有程式可以開啟 ' + vpath);
      return registry.launch(def.id, vpath, { forceNew: false });
    },

    instances: function () {
      return Object.keys(live).map(function (k) { return live[k]; });
    },

    instanceFor: function (win) {
      return live[win && win.id] || null;
    },

    /**
     * Run one of an app's published actions against a live window. This is the
     * same entry point the chat panel uses, so anything reachable by asking the
     * model is reachable programmatically -- which is what makes the apps
     * testable without a model in the loop.
     */
    /**
     * Run one of an app's published actions against a live window.
     *
     * `win` names which window when more than one is open. Without it this takes
     * the first instance it finds, which was wrong the moment documents began
     * opening windows of their own: converting a PDF after opening it acted on
     * whichever PDF happened to be first, not the one just opened.
     */
    /**
     * Run one of an application's published actions.
     *
     * With no window named, the choice used to be `live[0]` -- the oldest window
     * of that application. That is the wrong end of the list. Measured:
     * 「幫我算出差申請單的總金額，做成表存到 /notes/出差彙總.xlsx」 planned
     * app.open on the CSV, which opened a second spreadsheet window, and then
     * every app.do went to the first one -- last hour's 客訴分析 sheet. The
     * numbers were correct and they were written on top of somebody else's
     * table, and that is what got saved.
     *
     * So: the window the user is looking at, then the newest. `app.open` raises
     * what it opens, so a plan that opens a document and then works on it now
     * works on the one it opened.
     */
    invoke: async function (appId, action, args, win) {
      var live = registry.instances().filter(function (i) { return i.def.id === appId; });
      var inst = win
        ? live.find(function (i) { return i.win === win; })
        : (live.find(function (i) {
          return i.win && i.win.el && i.win.el.classList.contains('focus');
        }) || live[live.length - 1]);
      if (!inst) {
        throw new Error(win
          ? appId + ' 這個視窗已經不在了'
          : appId + ' 沒有開啟的視窗');
      }
      var spec = (inst.def.actions || {})[action];
      if (!spec) throw new Error(appId + ' 沒有這個動作：' + action);
      return spec.run(args || {}, inst.ctx, inst);
    },

    /* --------------------------------------------------- session support */

    /** Serialise every open window so the next boot can rebuild the desktop. */
    snapshot: function () {
      return registry.instances().map(function (inst) {
        var w = inst.win;
        var state = null;
        if (inst.ctrl && inst.ctrl.getState) {
          try { state = inst.ctrl.getState(); } catch (e) { state = null; }
        }
        return {
          appId: inst.def.id,
          title: w.title,
          kind: w.kind,
          rect: {
            x: w.el.offsetLeft, y: w.el.offsetTop,
            w: w.el.offsetWidth, h: w.el.offsetHeight
          },
          minimized: !!w.minimized,
          z: w.z || 0,
          chatOpen: inst.chat ? inst.chat.isOpen() : false,
          /* The panel's thread rides alongside the document rather than inside
             it: they are capped separately in the session file, so a long
             conversation cannot push a document's unsaved state over its limit.
             Losing an editor tab in order to have remembered chat would be a bad
             trade to make silently. */
          chat: inst.chat && inst.chat.export ? inst.chat.export() : null,
          state: state
        };
      });
    },

    /** Rebuild windows from a snapshot, in their original stacking order. */
    restore: async function (windows) {
      var ok = 0;
      var sorted = (windows || []).slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); });
      for (var i = 0; i < sorted.length; i++) {
        var w = sorted[i];
        if (!defs[w.appId]) continue;
        try {
          var win = await registry.launch(w.appId, undefined, {
            state: w.state && w.state.__truncated ? null : w.state,
            chatOpen: w.chatOpen,
            chat: w.chat && w.chat.__truncated ? null : w.chat,
            width: w.rect ? w.rect.w : undefined,
            height: w.rect ? w.rect.h : undefined,
            forceNew: false
          });
          if (w.rect && win && win.el) {
            win.el.style.left = Math.max(0, w.rect.x) + 'px';
            win.el.style.top = Math.max(0, w.rect.y) + 'px';
            win.el.style.width = w.rect.w + 'px';
            win.el.style.height = w.rect.h + 'px';
          }
          if (w.minimized && win) AIOS.wm.minimize(win);
          ok++;
        } catch (e) {
          if (AIOS.ui) AIOS.ui.trace('restore ' + w.appId + ' 失敗：' + (e.message || e), 't-warn');
        }
      }
      return ok;
    },

    /* Debounced session write. Called on every meaningful change so a crash
       loses seconds of work rather than a session. */
    requestSave: (function () {
      var timer = null;
      return function () {
        if (timer) return;
        timer = window.setTimeout(function () {
          timer = null;
          if (AIOS.session && AIOS.session.save) AIOS.session.save('auto');
        }, 1500);
      };
    })()
  };

  /**
   * The editing verbs, for a right-click that landed in editable text.
   *
   * Built here so every application gets the same four in the same order, and so
   * an app's own menu provider does not have to think about whether the click was
   * in text.
   *
   * The selection has to be captured now and put back before each command runs:
   * opening the menu moves focus to its own scrim, and by the time a command runs
   * the caret is gone -- so execCommand would act on nothing, or on the wrong
   * element. Capturing the range at build time and restoring it is the difference
   * between a menu that works and one that only looks like it does.
   */
  function editMenuFor(target) {
    var tag = target && target.tagName;
    var field = tag === 'INPUT' || tag === 'TEXTAREA';
    var rich = !!(target && target.isContentEditable);
    if (!field && !rich) return [];

    var sel = window.getSelection();
    var range = rich && sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    var from = field ? target.selectionStart : 0;
    var to = field ? target.selectionEnd : 0;
    var hasSelection = field ? to > from : !!(range && !range.collapsed);

    function restore() {
      target.focus();
      if (field) {
        target.setSelectionRange(from, to);
      } else if (range) {
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(range);
      }
    }

    /* insertText rather than execCommand('paste'): paste from a menu is a
       programmatic clipboard read, which the bridge already owns and gates.
       insertText also lands in the browser's own undo stack, so Ctrl+Z after a
       paste does what it does after typing. */
    async function paste() {
      restore();
      var read = await window.aios.clipboard.read();
      var text = read && read.ok && read.data ? String(read.data.text || '') : '';
      if (!text) return;
      restore();
      document.execCommand('insertText', false, text);
    }

    return [
      { label: '剪下', hint: 'Ctrl+X', disabled: !hasSelection,
        run: function () { restore(); document.execCommand('cut'); } },
      { label: '複製', hint: 'Ctrl+C', disabled: !hasSelection,
        run: function () { restore(); document.execCommand('copy'); } },
      { label: '貼上', hint: 'Ctrl+V', run: paste },
      { label: '全選', hint: 'Ctrl+A', run: function () {
        target.focus();
        if (field) target.select();
        else document.execCommand('selectAll');
      } },
      { sep: true }
    ];
  }

  /**
   * Menu entries every window has, appended after whatever the app supplied.
   * Kept here rather than in each app so the window-level verbs never drift
   * apart between programs.
   */
  function windowMenuTail(instance, def) {
    var w = instance.win;
    var tail = [{ sep: true }];

    if (def.chat && instance.chat) {
      tail.push({
        label: instance.chat.isOpen() ? T('win.chatClose', '關閉 AI 對話') : T('win.chatOpen', '開啟 AI 對話'),
        hint: 'Ctrl+/',
        run: function () {
          var open = instance.chat.toggle();
          var btn = w.barButtons && w.barButtons.chat;
          if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
        }
      });
    }
    tail.push({ label: T('win.new', '重新開一個視窗'), run: function () { AIOS.apps.launch(def.id, undefined, { forceNew: true }); } });
    tail.push({ label: T('win.min', '最小化'), run: function () { AIOS.wm.minimize(w); } });
    tail.push({ label: T('win.close', '關閉視窗'), danger: true, run: function () { AIOS.wm.close(w); } });
    return tail;
  }

  /* --------------------------------------------------------------- context */

  function makeContext(instance, main, arg, state) {
    var def = instance.def;
    return {
      app: def,
      arg: arg,
      state: state,
      body: main,

      get win() { return instance.win; },

      el: el,

      setTitle: function (t) {
        if (!instance.win) return;
        instance.win.title = t;
        var node = instance.win.el.querySelector('.win-title');
        if (node) node.textContent = t;
        instance.win.el.setAttribute('aria-label', t);
        AIOS.apps.requestSave();
      },

      toast: function (msg, level) {
        if (AIOS.ui) AIOS.ui.trace('[' + def.name + '] ' + msg, level || 't-info');
      },

      /** Report app state to the chat panel and the kernel's context pages. */
      describe: function (fn) { instance.describe = fn; },

      /**
       * Supply this window's right-click menu. Called with the raw event so the
       * app can decide from what was clicked; return an array of items, or
       * nothing for "only the standard window entries".
       */
      setMenu: function (fn) { instance.menuProvider = fn; },

      /** Ask the model a one-off question with this app's context attached. */
      ask: function (prompt) { return AIOS.chatpane.ask(instance, prompt); },

      /* Window furniture, hosted inside this window so a prompt cannot be
         mistaken for something the system is asking. */

      prompt: function (opts) {
        return AIOS.prompt(Object.assign({ host: instance.win.el }, opts || {}));
      },

      confirm: function (opts) {
        return AIOS.confirm(Object.assign({ host: instance.win.el }, opts || {}));
      },

      /**
       * Save a document without silently replacing a version this window never
       * saw.
       *
       * `stamp` is the mtime the window last read or wrote; `write(expect)` does
       * the actual write with it. If the file has moved on -- another window, the
       * kernel, an import -- the write is refused by the sandbox and the choice
       * comes back here instead of the other version disappearing. Saying yes
       * repeats the write with no claim attached, which is the deliberate
       * overwrite; saying no leaves both versions intact.
       *
       * Passing a stamp of null or undefined skips the check, which is what a
       * save-as or a first save should do: there is no earlier version to lose.
       */
      saveDoc: async function (vpath, stamp, write) {
        var res = await write(Number.isFinite(stamp) ? stamp : undefined);
        if (!res || res.ok || res.code !== 'ECONFLICT') return res;

        var go = await AIOS.confirm({
          host: instance.win.el,
          label: vpath.split('/').pop() + ' 在你編輯期間被改過了',
          note: '可能是另一個視窗、核心，或匯入動作寫過它。' +
                '要用你這份覆蓋掉磁碟上的版本嗎？對方的修改會消失。',
          okLabel: '覆蓋',
          cancelLabel: '取消儲存'
        });
        if (!go) return { ok: false, canceled: true, error: '已取消儲存' };
        return write(undefined);
      },

      menu: function (ev, items) {
        if (ev && ev.preventDefault) ev.preventDefault();
        return AIOS.menu.open(instance.win.el, ev.clientX, ev.clientY, items);
      },

      /**
       * Bind Ctrl+S and Ctrl+Shift+S for this window.
       *
       * Bound once at the window rather than per field: a document app has many
       * focusable pieces -- a grid, a formula bar, contenteditable blocks, a
       * notes box -- and Ctrl+S has to mean the same thing in all of them.
       * Rejections are swallowed on purpose; the app has already told the user
       * what went wrong through its own toast.
       */
      saveKeys: function (save, saveAs) {
        instance.win.el.addEventListener('keydown', function (e) {
          if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
          e.preventDefault();
          var fn = e.shiftKey ? saveAs : save;
          if (typeof fn !== 'function') return;
          try {
            var out = fn();
            if (out && typeof out.catch === 'function') out.catch(function () {});
          } catch (err) { /* reported by the app */ }
        });
      },

      save: function () { AIOS.apps.requestSave(); },

      close: function () { if (instance.win) AIOS.wm.close(instance.win); },

      /* Publish the app's current document into the kernel's context so the
         main intent bar can reason about what is on screen, not just the model
         inside this window. */
      publish: function (text, label) {
        if (!text) { K.drop('app/' + def.id); return; }
        K.page('app/' + def.id, {
          kind: 'ui', label: label || ('app/' + def.id), priority: 66,
          text: text.slice(0, 6000)
        });
        if (AIOS.ui) AIOS.ui.renderContext();
      },

      fs: window.aios.fs,
      aios: window.aios
    };
  }

  AIOS.apps = registry;
})();
