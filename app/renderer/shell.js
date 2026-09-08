'use strict';

/* ===========================================================================
   AI-OS // shell services
   ---------------------------------------------------------------------------
   Three things that belong to the machine rather than to any application:

     * the application launcher
     * session persistence, so the desktop survives a power cycle
     * the shutdown ceremony, which is the boot sequence run backwards

   Shutdown matters more than it sounds. A machine that loses your open windows
   because you clicked the close button is not one you would trust with an hour
   of work, so quitting here is a sequence with visible steps: flush the journal,
   write the session, close windows, save memory, reclaim the kernel. The process
   does not exit until those have actually happened.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var A = window.aios;
  var K = AIOS.kernel;
  var S = AIOS.state;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ######################################################### launcher #### */

  function T(key, zh, vars) { return AIOS.i18n ? AIOS.i18n.t(key, zh, vars) : zh; }

  function renderLauncher(body) {
    body.textContent = '';
    body.appendChild(el('p', 'micro', T('launcher.intro',
      '所有程式都在沙箱裡運作。每個視窗右上角的 \u2709 會打開該程式自己的 AI 對話面板，' +
      '那個面板看得到程式目前的狀態。')));

    var grid = el('div', 'launcher');
    AIOS.apps.list().forEach(function (def) {
      if (def.id === 'launcher') return;
      var tile = el('button', 'launch-tile' + (def.generated ? ' generated' : ''));
      tile.type = 'button';
      tile.title = def.purpose || def.name;
      tile.appendChild(el('span', 'launch-ico', def.icon));
      tile.appendChild(el('span', 'launch-name', def.generated ? def.name : T('app.' + def.id, def.name)));
      tile.appendChild(el('span', 'launch-sub', def.generated ? T('launcher.generated', '核心自製') : def.kind));
      tile.addEventListener('click', function () {
        AIOS.apps.launch(def.id, undefined, { forceNew: !def.singleton });
      });
      grid.appendChild(tile);
    });
    body.appendChild(grid);
  }

  AIOS.launcher = {
    open: function () {
      AIOS.wm.open({
        id: 'launcher',
        kind: 'APPS',
        title: T('launcher.title', '應用程式'),
        w: 560,
        h: 400,
        render: renderLauncher
      });
    },

    /**
     * Repaint the list if it is open.
     *
     * The window renders once, so installing or uninstalling a generated app left
     * it showing a program that no longer existed -- and clicking it failed on a
     * load the main process had already revoked. Anything that changes the set of
     * apps calls this.
     */
    refresh: function () {
      var win = AIOS.wm.find('launcher');
      // Same way the rest of the shell reaches into a window it did not build.
      var body = win && win.el ? win.el.querySelector('.win-body') : null;
      if (body) renderLauncher(body);
    }
  };

  /* ################################################### desktop menu #### */

  /**
   * Right-click on the desktop itself: the space behind the windows.
   *
   * Registered on #desktop rather than the document so it never competes with
   * an application's own menu -- a window that swallowed the event has already
   * shown one, and two menus for one click is how someone picks the wrong item.
   */
  AIOS.desktopMenu = {
    install: function () {
      var desk = document.getElementById('desktop');
      if (!desk) return;

      desk.addEventListener('contextmenu', function (ev) {
        // Only the bare desktop. Anything inside a window, the dock or a rail
        // has its own menu, or deliberately has none.
        if (ev.target !== desk && ev.target.id !== 'winlayer') return;

        var wins = AIOS.wm.list();
        var minimized = wins.filter(function (w) { return w.minimized; });
        var theme = document.documentElement.getAttribute('data-theme');

        AIOS.menu.open(desk, ev.clientX, ev.clientY, [
          { label: T('desk.apps', '所有應用程式'), hint: '\u229e', run: function () { AIOS.launcher.open(); } },
          { label: T('desk.files', '檔案總管'), run: function () { AIOS.apps.launch('files'); } },
          { label: T('desk.intent', '意圖列'), hint: 'Ctrl+K', run: function () {
            var input = document.getElementById('intent-input');
            if (input) { input.focus(); input.select(); }
          } },
          { sep: true },
          { label: T('desk.tile', '並排視窗（{n}）', { n: wins.length }), disabled: wins.length < 2, run: function () { AIOS.wm.tile(); } },
          { label: T('desk.stack', '疊起來'), disabled: wins.length < 2, run: function () { AIOS.wm.stack(); } },
          { label: T('desk.restoreAll', '全部還原'), disabled: !minimized.length, run: function () {
            minimized.forEach(function (w) { AIOS.wm.restore(w); });
          } },
          { sep: true },
          /* Eight of them now, so the desktop menu points at the 主題 menu
             instead of listing them: a right-click menu with eight colour
             entries in the middle is a colour picker with a few other things
             attached. */
          { label: T('desk.theme', '主題：{name}（在上方「主題」選單切換）', { name: T('theme.' + theme, AIOS.themes.labelOf(theme)) }),
            disabled: true },
          { sep: true },
          { label: T('desk.import', '從作業系統匯入檔案…'), run: function () { AIOS.userImport('/inbox'); } },
          { label: T('desk.trash', '回收桶'), run: function () { AIOS.openTrash(); } },
          { sep: true },
          { label: T('desk.shutdown', '關機'), danger: true, run: function () { AIOS.shutdown.ask(); } }
        ]);
        ev.preventDefault();
      });
    }
  };

  /* ########################################################## session #### */

  AIOS.session = {
    /** Collect everything worth restoring and hand it to the main process. */
    collect: function () {
      var hudLeft = document.getElementById('hud-left');
      var hudRight = document.getElementById('hud-right');
      var chipRow = document.getElementById('chips');
      return {
        /* Never the draft the theme editor may be trying on the desktop: a
           session that remembered 'u-draft' would come back to no palette. */
        theme: AIOS.themes.persistable ? AIOS.themes.persistable() : (document.documentElement.getAttribute('data-theme') || 'void'),
        budget: S.budget,
        spend: S.spend,
        endpoint: S.endpoint,
        hud: {
          left: !!(hudLeft && !hudLeft.classList.contains('off')),
          right: !!(hudRight && !hudRight.classList.contains('off')),
          chips: !!(chipRow && !chipRow.classList.contains('off'))
        },
        windows: AIOS.apps.snapshot(),
        // Turn pages and retrieved data are worth keeping; the pinned system
        // prompt is rebuilt at boot from the live syscall table instead.
        context: S.pages.filter(function (p) { return p.kind !== 'sys'; }).map(function (p) {
          /* The token count is deliberately not written. It is derived from the
             text, and a derived number in a file outlives the text it was
             derived from: a stale ui/machine count of 210 against 910 tokens of
             content survived a restart and went straight back into the budget.
             The text is here; pricing it again at boot costs nothing. */
          return {
            id: p.id, kind: p.kind, label: p.label, text: p.text,
            priority: p.priority, pinned: p.pinned, tainted: p.tainted,
            source: p.source, role: p.role
          };
        }),
        journal: S.journal.map(function (j) {
          return { seq: j.seq, ts: j.ts, op: j.op, status: j.status, note: j.note, reason: j.reason };
        }),
        turnSeq: S.turnSeq,
        seq: S.seq
      };
    },

    save: async function (why) {
      try {
        var res = await A.session.save(AIOS.session.collect());
        if (res.ok && why !== 'auto' && AIOS.ui) {
          AIOS.ui.trace(T('session.saved', 'session 已保存（{w} 個視窗 / {p} 個分頁）',
            { w: res.data.windows, p: res.data.pages }), 't-info');
        }
        return res.ok ? res.data : null;
      } catch (e) {
        if (AIOS.ui) AIOS.ui.trace('session 保存失敗：' + (e.message || e), 't-err');
        return null;
      }
    },

    /**
     * Rebuild the previous desktop. Context and journal come back first so the
     * kernel has continuity, then the windows, in their old stacking order.
     */
    restore: async function (sess) {
      if (!sess) return { windows: 0, pages: 0 };

      /* Only a theme that still exists. A custom one deleted since, or a name
         from a newer version, would leave the page on a block that is not
         there: the default palette wearing another theme's name. */
      if (sess.theme && AIOS.themes.has(sess.theme)) AIOS.themes.apply(sess.theme);
      /* The running spend carries over: a total that starts again every launch
         answers a question nobody asked. A session from before this existed has
         no field, and starts from zero. */
      if (sess.spend) {
        S.spend = {
          prompt: sess.spend.prompt || 0, output: sess.spend.output || 0,
          thinking: sess.spend.thinking || 0, total: sess.spend.total || 0,
          turns: sess.spend.turns || 0, since: sess.spend.since || Date.now()
        };
      }
      if (sess.budget) {
        S.budget = sess.budget;
        var slider = document.getElementById('budget-slider');
        var out = document.getElementById('budget-out');
        if (slider) slider.value = String(sess.budget);
        if (out) out.value = String(sess.budget);
      }
      if (sess.hud) {
        ['left', 'right'].forEach(function (side) {
          var hud = document.getElementById('hud-' + side);
          if (hud && sess.hud[side] === false) hud.classList.add('off');
        });
        /* Only an explicit false hides it, so a session written before this
           existed comes back with the chips showing rather than gone. */
        if (sess.hud.chips === false) {
          var row = document.getElementById('chips');
          var btn = document.getElementById('btn-chips');
          if (row) row.classList.add('off');
          if (btn) {
            btn.setAttribute('aria-expanded', 'false');
            btn.textContent = '\u25b4';
            btn.title = '顯示建議詞';
          }
        }
      }

      // No tokens passed on purpose -- see the snapshot above. page() prices the
      // restored text, and measure() refines it later where a tokenizer exists.
      (sess.context || []).forEach(function (p) {
        K.page(p.id, {
          kind: p.kind, label: p.label, text: p.text, priority: p.priority,
          pinned: p.pinned, tainted: p.tainted, source: p.source, role: p.role
        });
      });

      // Restored journal entries carry no undo: a closure cannot be persisted,
      // and offering a button that silently does nothing would be worse.
      (sess.journal || []).forEach(function (j) {
        S.journal.push({
          seq: j.seq, ts: j.ts, op: j.op, status: j.status,
          note: j.note, reason: j.reason, undo: null, restored: true
        });
      });
      S.seq = sess.seq || S.journal.length;
      S.turnSeq = sess.turnSeq || 0;

      var windows = await AIOS.apps.restore(sess.windows || []);
      return { windows: windows, pages: (sess.context || []).length };
    },

    clear: async function () {
      await A.session.clear();
      if (AIOS.ui) AIOS.ui.trace(T('session.cleared', '已清除保存的工作階段，下次啟動會是全新桌面'), 't-warn');
    }
  };

  /* ######################################################### shutdown #### */

  /* ########################################################### themes #### */

  /**
   * Every theme this machine has, in one list.
   *
   * The names used to be written out in four places -- the CSS, the syscall's
   * validator, the menu markup and the desktop's context menu -- and adding one
   * meant remembering all four. The palette itself still lives in os.css, which
   * is the only place that can hold it; this is the list of what exists, and
   * everything that needs to enumerate or validate a theme reads it here.
   */
  AIOS.themes = {
    list: [
      /* Ordered dark to light, so the menu reads as one gradient and the two
         kinds do not interleave. Hints stay short enough to fit the row without
         being clipped -- a description cut off at 「適合…」 is worse than a
         shorter one. */
      { id: 'midnight', label: '午夜', hint: '近黑靛藍，最暗' },
      { id: 'void', label: '深空', hint: '深藍近黑，預設' },
      { id: 'ocean', label: '深海', hint: '深青藍' },
      { id: 'forest', label: '深林', hint: '深綠' },
      { id: 'nord', label: '極地', hint: '冷灰藍，柔和好讀' },
      { id: 'violet', label: '靛紫', hint: '深紫配青綠' },
      { id: 'crimson', label: '緋紅', hint: '暗酒紅' },
      { id: 'copper', label: '赤銅', hint: '暖褐銅色' },
      { id: 'amber', label: '琥珀', hint: '琥珀，像老終端機' },
      { id: 'mono', label: '單色', hint: '純灰階，高對比' },
      { id: 'daylight', label: '日光', hint: '淺色，冷調' },
      { id: 'mint', label: '薄荷', hint: '淺色，淡綠' },
      { id: 'sakura', label: '櫻', hint: '淺色，淡粉' },
      { id: 'paper', label: '紙張', hint: '淺色，暖調像紙' }
    ],
    /* The user's own. Loaded from the main process at boot (custom-themes.json)
       and kept here as {id, name, mode, primary, overrides}; themer.js fills
       the list and generates their CSS. The list above never changes while the
       machine runs. This one does. */
    custom: [],
    has: function (id) {
      return AIOS.themes.list.some(function (t) { return t.id === id; }) ||
        AIOS.themes.custom.some(function (t) { return t.id === id; });
    },
    isCustom: function (id) {
      return AIOS.themes.custom.some(function (t) { return t.id === id; });
    },
    /** The saved record of a custom theme, or null for a built-in or an unknown id. */
    find: function (id) {
      return AIOS.themes.custom.filter(function (t) { return t.id === id; })[0] || null;
    },
    /** Built-in and custom as one list of {id, label, hint, custom}, for anything that enumerates. */
    all: function () {
      return AIOS.themes.list.map(function (t) {
        return { id: t.id, label: t.label, hint: t.hint, custom: false };
      }).concat(AIOS.themes.custom.map(function (t) {
        return { id: t.id, label: t.name, hint: t.mode === 'light' ? '自訂，淺色' : '自訂，深色', custom: true };
      }));
    },
    /**
     * The id for a name a person would say: 「深林」, "Forest", or whatever they
     * called a theme of their own. A custom theme's id is random and nobody
     * would type it, so the name is the only handle it has.
     */
    byName: function (name) {
      var q = String(name == null ? '' : name).trim().toLowerCase();
      if (!q) return null;
      /* Built-ins first: their names are the ones the syscall signature
         promises the model, and a custom theme that borrowed one is still
         reachable from the menu. */
      var hit = AIOS.themes.list.filter(function (t) {
        return t.id === q || t.label === q || T('theme.' + t.id, t.label).toLowerCase() === q;
      })[0] || AIOS.themes.custom.filter(function (t) { return t.name.toLowerCase() === q; })[0];
      return hit ? hit.id : null;
    },
    current: function () {
      return document.documentElement.getAttribute('data-theme') || 'void';
    },
    labelOf: function (id) {
      var hit = AIOS.themes.list.filter(function (t) { return t.id === id; })[0];
      if (hit) return hit.label;
      var own = AIOS.themes.find(id);
      if (own) return own.name;
      return id === 'u-draft' ? T('theme.draft', '（預覽中的草稿）') : id;
    }
  };

  AIOS.shutdown = {
    running: false,

    /** Ask the machine to shut down. The main process drives the sequence. */
    request: function () {
      if (AIOS.shutdown.running) return;
      A.shutdown.begin();
    },

    /**
     * Confirm first, then shut down. Both the desktop's context menu and the
     * 系統 menu land here rather than each asking in their own words -- two
     * entry points to one irreversible action should not be able to describe it
     * differently, or promise different things about what is saved.
     */
    ask: async function () {
      if (AIOS.shutdown.running) return false;
      var ok = await AIOS.confirm({
        label: T('shutdown.ask', '關閉 AI-OS？'),
        note: T('shutdown.note', '會先保存所有視窗與工作階段，下次啟動回到這個桌面。'),
        okLabel: T('shutdown.ok', '關機'),
        danger: true
      });
      if (ok) AIOS.shutdown.request();
      return ok;
    },

    /** Called when the main process says the ceremony has started. */
    run: async function () {
      if (AIOS.shutdown.running) return;
      AIOS.shutdown.running = true;

      var overlay = el('div', 'shutdown');
      var inner = el('div', 'shutdown-inner');

      var mark = el('div', 'shutdown-mark');
      mark.appendChild(el('span', 'shutdown-glyph', '\u25c8'));
      var titleWrap = el('div', 'shutdown-title');
      titleWrap.appendChild(el('b', null, 'AI-OS'));
      titleWrap.appendChild(el('small', null, 'SHUTTING DOWN'));
      mark.appendChild(titleWrap);
      inner.appendChild(mark);

      var log = el('pre', 'shutdown-log');
      log.setAttribute('role', 'log');
      log.setAttribute('aria-live', 'polite');
      inner.appendChild(log);

      var meter = el('div', 'shutdown-meter');
      var fill = el('i');
      meter.appendChild(fill);
      inner.appendChild(meter);

      var foot = el('div', 'shutdown-foot', 'SAVING');
      inner.appendChild(foot);
      overlay.appendChild(inner);
      document.body.appendChild(overlay);

      var total = 7;
      var done = 0;

      /**
       * One ceremony step, in two forms.
       *
       * `text` is what the human reads on the overlay, in their language.
       * `ascii` is what goes to the terminal, and it is ASCII on purpose: the
       * main process cannot know how its stdout will be consumed. Piped through
       * a shell, redirected to a file, or read by an IDE terminal, each end
       * decodes with its own code page, and on a zh-TW console UTF-8 Chinese
       * comes out as mojibake. Keeping the machine-facing log ASCII removes the
       * question instead of guessing the answer.
       *
       * Falling back to `text` would quietly reintroduce the problem, so a step
       * with no ascii form logs nothing at all.
       */
      function step(text, cls, ascii) {
        var line = el('span', cls, text + '\n');
        log.appendChild(line);
        while (log.childNodes.length > 40) log.removeChild(log.firstChild);
        if (ascii) A.shutdown.step(ascii, cls === 'no' ? 'error' : 'info');
        return line;
      }
      function tick(label) {
        done++;
        fill.style.width = Math.min(100, Math.round((done / total) * 100)) + '%';
        if (label) foot.textContent = label;
      }
      function wait(ms) { return new Promise(function (r) { window.setTimeout(r, ms); }); }

      try {
        step(T('sd.quiesce', '停止接受新的意圖 …'), 'hi', 'QUIESCE  stopped accepting new intents');
        K.abort('*');   // everything: the intent, a background build, a chat panel
        var input = document.getElementById('intent-input');
        if (input) input.disabled = true;
        tick('QUIESCE');
        await wait(160);

        var wins = AIOS.apps.instances();
        step(T('sd.snapshot', '保存 {n} 個視窗的狀態 …', { n: wins.length }), null,
          'SNAPSHOT ' + wins.length + ' window(s)');
        var snap = AIOS.session.collect();
        tick('SNAPSHOT');
        await wait(120);

        var saved = await A.session.save(snap);
        if (saved.ok) {
          step(T('sd.session', '寫入工作階段 …\n  session.json　{kb} KiB　{w} 個視窗　{p} 個 context 分頁',
            { kb: (saved.data.bytes / 1024).toFixed(1), w: saved.data.windows, p: saved.data.pages }), 'ok',
            'SESSION  session.json ' + (saved.data.bytes / 1024).toFixed(1) + ' KiB, ' +
            saved.data.windows + ' window(s), ' + saved.data.pages + ' context page(s)');
        } else {
          step(T('sd.sessionFail', '寫入工作階段失敗：{err}', { err: saved.error }), 'no', 'SESSION  write failed');
        }
        tick('SESSION');
        await wait(120);

        var mem = await A.memory.summary();
        step('長期記憶已落地：' + (mem.ok ? mem.data.count + ' 筆（手動 ' +
          (mem.data.bySource.manual || 0) + ' · 學習 ' + (mem.data.bySource.learned || 0) + '）' : '未知'), 'ok',
          mem.ok
            ? 'MEMORY   ' + mem.data.count + ' item(s) (' + (mem.data.bySource.manual || 0) +
              ' manual, ' + (mem.data.bySource.learned || 0) + ' learned)'
            : 'MEMORY   summary unavailable');
        tick('MEMORY');
        await wait(120);

        var u = await A.fs.usage();
        if (u.ok) {
          step('沙箱：' + u.data.files + ' 個檔案　' + AIOS.bytes(u.data.bytes) + '　（保留在磁碟上）', 'ok',
            'SANDBOX  ' + u.data.files + ' file(s), ' + Math.round(u.data.bytes / 1024) +
            ' KiB, kept on disk');
        }
        tick('SANDBOX');
        await wait(120);

        step('關閉 ' + wins.length + ' 個視窗 …', null, 'WINDOWS  closing ' + wins.length);
        /* Forced, and not because the question is inconvenient: the snapshot two
           steps up already holds every open document's unsaved text, so the next
           boot brings it back as it was. Asking here would put a dialog nobody
           can see -- this overlay is on top of them -- between the user and the
           power button. */
        AIOS.wm.closeAll({ force: true });
        await A.browser.hideAll();
        tick('WINDOWS');
        await wait(200);

        step('交還模型核心 …', 'hi', 'KERNEL   handing back to the main process');
        tick('KERNEL');
        await wait(200);

        step('');
        step('可以安全關閉。下次啟動會回到這個桌面。', 'ok', 'HALT     safe to power off');
        foot.textContent = 'HALT';
        await wait(700);
      } catch (e) {
        step('關機過程出錯：' + (e.message || e), 'no', 'ERROR    ceremony failed, continuing');
        await wait(900);
      }

      // Hand control back to the main process, which reclaims llama-server and
      // exits for real.
      A.shutdown.ready();
    }
  };

  /* Periodic session write. A crash should cost seconds, not a session. */
  AIOS.session.startAutosave = function () {
    window.setInterval(function () {
      if (!AIOS.shutdown.running) AIOS.session.save('auto');
    }, 60000);
    window.addEventListener('beforeunload', function () {
      // Best effort only: the reliable path is the ceremony above.
      A.session.save(AIOS.session.collect());
    });
  };
})();
