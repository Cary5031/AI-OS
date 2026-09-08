'use strict';

/* ===========================================================================
   AI-OS // browser
   ---------------------------------------------------------------------------
   Real pages in a real Chromium view. The awkward part is that the view is not
   a DOM node: it is a native surface the main process positions in window
   coordinates, and it paints above everything this document draws.

   So this app spends most of its effort on one job -- keeping the view's
   rectangle glued to a placeholder <div> as the window is dragged, resized,
   focused, minimized, or covered by another window -- and detaching it whenever
   it should not be visible. Get that wrong and a web page floats over unrelated
   parts of the machine.

   Reader mode is the other half. `web.read` fetches and extracts prose without a
   browser view at all, which is the form the model can actually use, and the
   result is fenced as untrusted before it reaches context.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var A = window.aios;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* One subscription for every browser window; events are routed by tab id. */
  var routes = {};
  A.browser.onEvent(function (msg) {
    var fn = routes[msg.tabId];
    if (fn) fn(msg.event, msg.payload);
  });

  AIOS.apps.register({
    id: 'browser',
    /* Pages are tabs in one window. A native view per window was cheap
       until a plan opened several; see the note by sheets. */
    tabs: true,
    name: '瀏覽器',
    icon: '\u25c8',
    kind: 'WEB',
    width: 980,
    height: 640,
    purpose: '瀏覽網頁，並把頁面內容交給核心閱讀',
    chatHint: '可以說「幫我看這頁在講什麼」或「開 news.ycombinator.com」。頁面內容一律當不可信資料。',

    accepts: function () { return false; },

    actions: {
      goto: {
        args: '{url}', desc: '在這個分頁開啟網址',
        run: async function (args, ctx) {
          await ctx.api.navigate(args.url);
          return { note: args.url };
        }
      },
      readPage: {
        args: '{}', desc: '把目前頁面的內容讀進 context',
        run: async function (_a, ctx) {
          var r = await ctx.api.readIntoContext();
          return { note: r };
        }
      },
      reader: {
        args: '{url}', desc: '用閱讀模式抓一個網址的正文（不開瀏覽器視圖）',
        run: async function (args, ctx) {
          var r = await ctx.api.reader(args.url);
          return { note: r };
        }
      },
      savePage: {
        args: '{format}',
        desc: '把目前這一頁存成檔案（format: md / docx / pdf；page 是整頁原樣，含版面與圖片）',
        run: async function (args, ctx) {
          return { note: await ctx.api.exportPage(String(args.format || 'md').toLowerCase()) };
        }
      },
      bookmark: {
        args: '{title, folder}', desc: '把目前這一頁加入書籤',
        run: async function (args, ctx) {
          return { note: await ctx.api.bookmark(args.title, args.folder) };
        }
      },
      openBookmark: {
        args: '{query}', desc: '從書籤裡找一個標題或網址含 query 的並開啟',
        run: async function (args, ctx) {
          return { note: await ctx.api.openBookmark(args.query) };
        }
      },
      back: { args: '{}', desc: '上一頁', run: async function (_a, ctx) { await A.browser.back(ctx.api.tabId()); return { note: '上一頁' }; } },
      forward: { args: '{}', desc: '下一頁', run: async function (_a, ctx) { await A.browser.forward(ctx.api.tabId()); return { note: '下一頁' }; } },
      reload: { args: '{}', desc: '重新載入', run: async function (_a, ctx) { await A.browser.reload(ctx.api.tabId()); return { note: '已重載' }; } }
    },

    mount: function (ctx) {
      ctx.body.classList.add('flush');

      /* One window, N pages.
         `sheet` is what the native side calls a tab -- a WebContentsView with
         its own id -- and only the active one is ever attached. Before this each
         page was a whole window, and a handful of them turned the shell into a
         slideshow: every window is a composited layer with a blurred backdrop,
         so scrolling made content blank out and reappear while the compositor
         rebuilt tiles. */
      var sheets = [];        // [{ id, title, url }]
      var at = -1;            // index of the active sheet
      var tabId = null;       // the active sheet's native id, or null
      var state = { url: '', title: '', loading: false, canGoBack: false, canGoForward: false };
      var lastRead = null;
      var mode = (ctx.state && ctx.state.mode) || 'live';   // 'live' | 'reader'
      var visible = true;
      /* Is the load now in flight the restored one, and did the last restore
         fail? Together they stop a dead saved page from failing loudly on every
         launch. Set below, once the restore decision is made. */
      var restoring = false;
      var restoreFailed = false;
      /* The last failure, kept so the state event that follows it does not
         overwrite the only explanation on screen. */
      var failNote = null;

      /** A URL short enough to read in a toast, cut where it stops being useful. */
      function short(url) {
        var s = String(url || '');
        return s.length > 72 ? s.slice(0, 69) + '…' : s;
      }

      /* ---------------------------------------------------------- chrome */

      /* The tab strip. Same shape as the editor's, and the same class prefix on
         purpose -- one row of documents belonging to one window is one idea, and
         it should not look like two. */
      var tabbar = el('div', 'ed-tabs br-tabs');
      ctx.body.appendChild(tabbar);

      var bar = el('div', 'br-bar');
      var back = el('button', 'br-nav', '\u2039');
      back.type = 'button'; back.title = '上一頁';
      var fwd = el('button', 'br-nav', '\u203a');
      fwd.type = 'button'; fwd.title = '下一頁';
      var reload = el('button', 'br-nav', '\u21bb');
      reload.type = 'button'; reload.title = '重新載入';
      var form = el('form', 'br-addr-form');
      var addr = el('input', 'br-addr');
      addr.placeholder = '輸入網址或搜尋…';
      addr.setAttribute('aria-label', '網址');
      form.appendChild(addr);
      var go = el('button', 'br-go', '\u21b5');
      go.type = 'submit'; go.title = '前往';
      form.appendChild(go);

      var homeBtn = el('button', 'fbtn', '⌂');
      homeBtn.type = 'button';
      homeBtn.title = '首頁';
      homeBtn.setAttribute('aria-label', '首頁');

      /* A word, not an icon. This bar is `flex-wrap: wrap` and already carries
         nine controls, so the worry was a second row costing every browser
         window a strip of page height -- but measured at the default window
         size the bar is 39.65px either way, with the address field taking the
         slack. There is room, and 「轉存」 is findable in a way that an arrow
         with a tooltip is not. */
      var saveBtn = el('button', 'fbtn', '轉存');
      saveBtn.type = 'button';
      saveBtn.title = '把這一頁的正文存成 Markdown、Word 或 PDF';
      saveBtn.setAttribute('aria-label', '轉存');

      var readerBtn = el('button', 'fbtn', '閱讀模式');
      readerBtn.type = 'button';
      readerBtn.title = '抓取正文，不用瀏覽器視圖（給模型讀的形式）';
      var grabBtn = el('button', 'fbtn', '讀進 context');
      grabBtn.type = 'button';
      grabBtn.title = '把目前頁面的文字交給核心（標記為不可信）';

      /* A star rather than a labelled button: it has to say whether the current
         page is already saved, and a word cannot do that at a glance. */
      var starBtn = el('button', 'fbtn br-star', '☆');
      starBtn.type = 'button';
      starBtn.title = '把這一頁加入書籤';
      var marksBtn = el('button', 'fbtn', '書籤');
      marksBtn.type = 'button';
      marksBtn.title = '開啟書籤清單';

      /* Web translation. The buttons are built by renderer/translate.js and
         driven by the main process; this window supplies only what it alone
         knows -- which native tab is in front, and what it is showing. */
      var tr = AIOS.translate.controls(ctx, {
        tabId: function () { return tabId; },
        url: function () { return state.url || addr.value || ''; },
        openSettings: function () { openTrConf(); },
        onProgress: function (p) { showProgress(p); }
      });

      [back, fwd, reload, homeBtn].forEach(function (b) { bar.appendChild(b); });
      bar.appendChild(form);
      bar.appendChild(starBtn);
      bar.appendChild(marksBtn);
      bar.appendChild(saveBtn);
      bar.appendChild(readerBtn);
      bar.appendChild(grabBtn);
      bar.appendChild(tr.button);
      bar.appendChild(tr.more);
      ctx.body.appendChild(bar);

      /* The bookmarks bar. Hidden when empty rather than showing an empty
         strip: a row of nothing is worse than no row. */
      var marksBar = el('div', 'br-marks');
      marksBar.hidden = true;
      ctx.body.appendChild(marksBar);

      /* The live view is a native surface; this element only reserves space and
         reports where that space is. Nothing is ever rendered inside it. */
      var slot = el('div', 'br-slot');
      slot.setAttribute('aria-label', '網頁內容（原生視圖）');
      var placeholder = el('div', 'br-placeholder');
      placeholder.appendChild(el('div', 'br-ph-mark', '\u25c8'));
      placeholder.appendChild(el('p', null, '輸入網址開始瀏覽。'));
      placeholder.appendChild(el('p', 'micro',
        '網頁跑在獨立的 session 裡，跟這台機器的其他部分不共用 cookie。' +
        '頁面內容永遠被當成不可信資料。'));
      slot.appendChild(placeholder);
      ctx.body.appendChild(slot);

      var readerPane = el('div', 'br-reader');
      readerPane.hidden = true;
      ctx.body.appendChild(readerPane);

      /* The translation settings, in place of the page rather than floating
         over it: a native view paints above this document, so a panel drawn on
         top of the slot would be invisible. Reader mode already works this
         way, and for the same reason. */
      var trPane = el('div', 'br-reader br-trconf');
      trPane.hidden = true;
      ctx.body.appendChild(trPane);
      var trForm = null;

      /* Where to go back to. Reader mode has already fetched and laid out an
         article; sending it back to 'live' would throw that away and show the
         page it was extracted from instead. */
      var beforeTrConf = 'live';

      function openTrConf() {
        if (mode === 'trconf') return closeTrConf();
        if (tabId) A.browser.hide(tabId);
        beforeTrConf = mode === 'reader' ? 'reader' : 'live';
        mode = 'trconf';
        slot.hidden = true;
        readerPane.hidden = true;
        trPane.hidden = false;
        trPane.innerHTML = '';
        var head = el('div', 'br-trconf-head');
        head.appendChild(el('h3', 'br-reader-title', '網頁翻譯設定'));
        var done = el('button', 'fbtn', '回到頁面');
        done.type = 'button';
        done.addEventListener('click', closeTrConf);
        head.appendChild(done);
        trPane.appendChild(head);
        trForm = AIOS.translate.settingsForm(trPane, { onChange: function () { tr.refresh(); } });
      }

      function closeTrConf() {
        if (mode !== 'trconf') return;
        trPane.hidden = true;
        trForm = null;
        mode = beforeTrConf;
        if (mode === 'reader') {
          readerPane.hidden = false;
          slot.hidden = true;
          return;
        }
        slot.hidden = false;
        scheduleSync();
      }

      var status = el('div', 'br-status');
      ctx.body.appendChild(status);

      /* The page carries its own progress strip, bottom right, because that is
         where a person is reading. This line is the same facts for the moments
         the page is not on screen -- the settings pane open, the window
         covered -- and for the failure the strip cannot explain. */
      function showProgress(p) {
        if (!p) return;
        /* Stopped is not a number to keep showing. The line described a
           translation that is over until something else happened to write to
           it, which on a quiet tab was never. */
        if (p.phase === 'stopped' && !p.note) { status.textContent = ''; return; }
        if (p.phase === 'error' || (p.note && !p.running)) {
          status.textContent = '翻譯：' + (p.note || '失敗');
          return;
        }
        if (!p.running && p.phase !== 'done') return;
        var bits = ['翻譯 ' + p.done + ' / ' + Math.max(p.total, p.done + p.failed) + ' 段'];
        if (p.failed) bits.push(p.failed + ' 段失敗');
        if (p.cached) bits.push(p.cached + ' 段來自快取');
        if (p.spend && p.spend.total) bits.push(p.spend.total + ' tok');
        if (p.note) bits.push(p.note);
        status.textContent = bits.join('　');
      }

      /* ------------------------------------------------- view positioning */

      /**
       * The native view has to sit exactly where the slot is, in window
       * coordinates. Recomputed on every drag frame, resize, scroll and focus
       * change, and skipped entirely when the window cannot be seen.
       */
      function syncBounds() {
        if (!tabId || mode !== 'live') return;
        var w = ctx.win;
        if (!w || !w.el || w.minimized || !visible) { A.browser.hide(tabId); return; }
        /* A menu or a popover in this window is renderer DOM, and this view
           paints above it. Detaching while one is open is what makes the
           toolbar's own menus visible at all. */
        if (AIOS.overlay && AIOS.overlay.activeIn(w.el)) { A.browser.hide(tabId); return; }

        var r = slot.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) { A.browser.hide(tabId); return; }

        // A WebContentsView is positioned in the window's content coordinates,
        // which is exactly what getBoundingClientRect returns here: the renderer
        // document fills the content area, so no offset conversion is needed.
        A.browser.show(tabId, {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
        });
      }

      var syncTimer = null;
      function scheduleSync() {
        if (syncTimer) return;
        syncTimer = window.requestAnimationFrame(function () {
          syncTimer = null;
          syncBounds();
        });
      }

      /* A window being dragged fires pointermove on its bar; resizing fires on
         the grip. Both need the view to follow immediately. */
      ctx.win.el.addEventListener('pointermove', scheduleSync);
      ctx.win.el.addEventListener('pointerup', scheduleSync);
      window.addEventListener('resize', scheduleSync);
      A.onGeometry(scheduleSync);
      // An overlay opening hides the page; one closing brings it back.
      var offOverlay = AIOS.overlay ? AIOS.overlay.onChange(scheduleSync) : null;

      /* Being covered by another window is the case a native view cannot see for
         itself, so the window manager is asked about stacking each time. */
      var watch = window.setInterval(function () {
        if (!ctx.win || !ctx.win.el) return;

        /* Every getBoundingClientRect here forces a synchronous layout, and this
           runs four times a second forever. Asking about each window above this
           one, from inside a filter over every window, made that a handful of
           forced layouts per tick per browser window -- landing in the middle of
           whatever the user was scrolling. So: decide the cheap cases without
           measuring anything, and measure at most once per candidate. */
        var hidden = document.hidden || ctx.win.minimized;
        if (hidden) {
          if (visible) { visible = false; if (tabId) A.browser.hide(tabId); }
          return;
        }

        var mine = slot.getBoundingClientRect();
        var covered = false;
        if (mine.width >= 8 && mine.height >= 8) {
          var list = AIOS.wm.list();
          for (var i = 0; i < list.length; i++) {
            var o = list[i];
            if (o === ctx.win || o.minimized || (o.z || 0) <= (ctx.win.z || 0)) continue;
            if (overlaps(o.el.getBoundingClientRect(), mine)) { covered = true; break; }
          }
        }

        var shouldShow = !covered;
        if (shouldShow !== visible) {
          visible = shouldShow;
          if (visible) syncBounds(); else if (tabId) A.browser.hide(tabId);
          placeholder.hidden = visible && !!state.url;
        }
      }, 320);

      function overlaps(ra, rb) {
        return !(ra.right < rb.left || ra.left > rb.right || ra.bottom < rb.top || ra.top > rb.bottom);
      }

      /* -------------------------------------------------------- behaviour */

      /* ------------------------------------------------------------ tabs */

      function renderTabs() {
        tabbar.innerHTML = '';
        sheets.forEach(function (s, i) {
          var b = el('div', 'ed-tab' + (i === at ? ' on' : ''));
          var name = el('button', 'ed-tab-name', s.title || hostOf(s.url) || '新分頁');
          name.type = 'button';
          name.title = s.url || '新分頁';
          name.addEventListener('click', function () { activate(i); });
          b.appendChild(name);
          var x = el('button', 'ed-tab-x', '×');
          x.type = 'button';
          x.title = '關閉分頁';
          x.addEventListener('click', function (e) { e.stopPropagation(); closeSheet(i); });
          b.appendChild(x);
          tabbar.appendChild(b);
        });
        var add = el('button', 'ed-tab-add', '+');
        add.type = 'button';
        add.title = '開新分頁';
        add.addEventListener('click', function () { newSheet(); });
        tabbar.appendChild(add);
        /* One page is not a set of tabs. The strip stays out of the way until
           there is a choice to make. */
        tabbar.hidden = sheets.length < 2;
      }

      function hostOf(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
      }

      /** Make sheet `i` the visible one; every other native view is detached. */
      function activate(i) {
        if (i < 0 || i >= sheets.length) { at = -1; tabId = null; renderTabs(); return; }
        at = i;
        sheets.forEach(function (s, n) { if (n !== i) A.browser.hide(s.id); });
        tabId = sheets[i].id;
        mode = 'live';
        readerPane.hidden = true;
        trPane.hidden = true;
        slot.hidden = false;
        addr.value = sheets[i].url === 'about:blank' ? '' : (sheets[i].url || '');
        /* The button describes a tab, so it has to be re-read when the tab
           under it changes -- otherwise it says 已翻譯 about the page you just
           left, and pressing it acts on the one you just opened. */
        tr.refresh();
        ctx.setTitle(sheets[i].title ? '瀏覽器 — ' + sheets[i].title : '瀏覽器');
        renderTabs();
        if (typeof syncStar === 'function') syncStar();
        syncBounds();
        ctx.save();
      }

      async function newSheet(url) {
        var res = await A.browser.create(null);
        if (!res.ok) throw new Error(res.error);
        var id = res.data.id;
        routes[id] = function (event, payload) { onEvent(event, payload, id); };
        sheets.push({ id: id, title: '', url: '' });
        activate(sheets.length - 1);
        if (url) await navigate(url);
        return id;
      }

      function closeSheet(i) {
        var s = sheets[i];
        if (!s) return;
        A.browser.destroy(s.id);
        delete routes[s.id];
        sheets.splice(i, 1);
        /* Closing the last one leaves an empty window rather than closing it:
           the window is the user's, and a click on × should not make it vanish. */
        activate(Math.min(i, sheets.length - 1));
        if (!sheets.length) {
          slot.hidden = false;
          placeholder.hidden = false;
          addr.value = '';
          status.textContent = '';
          ctx.setTitle('瀏覽器');
        }
        ctx.save();
      }

      async function ensureTab() {
        if (tabId) return tabId;
        return newSheet();
      }

      function onEvent(event, payload, from) {
        /* Every sheet in this window reports here, so the first question is
           whose event this is. A background tab still has to keep its own title
           and address -- that is what the strip shows -- but it must not touch
           the toolbar, the status line or the window title, which belong to the
           page the user is looking at. */
        var mine = sheets.findIndex(function (s) { return s.id === from; });
        if (mine >= 0 && event === 'state') {
          sheets[mine].title = payload.title || '';
          sheets[mine].url = payload.url || '';
          renderTabs();
        }
        if (from !== undefined && mine >= 0 && mine !== at) return;

        if (event === 'state') {
          state = payload;
          addr.value = state.url === 'about:blank' ? '' : state.url;
          back.disabled = !state.canGoBack;
          fwd.disabled = !state.canGoForward;
          reload.textContent = state.loading ? '\u00d7' : '\u21bb';
          reload.title = state.loading ? '停止載入' : '重新載入';
          ctx.setTitle(state.title ? '瀏覽器 — ' + state.title : '瀏覽器');
          /* A failure is followed by a state event saying the load stopped, and
             that used to overwrite the only lasting explanation with the URL
             that just failed -- so the window ended up showing the address as
             though nothing had happened. The note stays until something is
             actually asked for. */
          status.textContent = state.loading ? '載入中… ' + state.url
            : (failNote && failNote.url === state.url ? failNote.text : (state.url || ''));
          placeholder.hidden = !!state.url && state.url !== 'about:blank';
          // The star describes the page on screen, so it follows every
          // navigation rather than only the moment a bookmark is added.
          if (typeof syncStar === 'function') syncStar();
          ctx.save();
        } else if (event === 'error') {
          /* The URL belongs in the message. Without it the toast reads
             「載入失敗：ERR_CONNECTION_REFUSED」 with nothing to act on -- and at
             boot, when the page was restored rather than asked for, the reader
             has no idea what the machine was even trying to reach. */
          var where = payload.url ? '　' + short(payload.url) : '';
          if (restoring) {
            /* A restored page that will not load must not fail again on every
               launch. It stays in the address bar and one press of ↻ retries it;
               what stops is the machine reaching for it unasked. */
            restoreFailed = true;
            addr.value = payload.url || addr.value;
            failNote = { url: payload.url, text: '上次開著的頁面連不上：' + payload.desc + '。按 ↻ 重試' };
            ctx.toast('上次開著的頁面連不上（' + payload.desc + '）' + where +
              '，開機不會再自動開啟它。按 ↻ 可以重試', 't-warn');
          } else {
            failNote = { url: payload.url, text: '載入失敗（' + payload.code + '）：' + payload.desc };
            ctx.toast('載入失敗：' + payload.desc + where, 't-err');
          }
          status.textContent = failNote.text;
          restoring = false;
          ctx.save();
        } else if (event === 'popup') {
          /* A popup asked for a new window and gets a new tab. It used to
             replace the current page, which loses whatever the user was reading
             -- and now that this window holds tabs, the honest translation of
             "open somewhere else" is available. */
          newSheet(payload.url);
        } else if (event === 'external') {
          ctx.toast('這個連結不是網頁（' + payload.url.slice(0, 60) + '），已忽略', 't-warn');
        }
      }

      async function navigate(url, isRestore) {
        if (!url) return;
        /* Every call says whether it is the restore, so a failure minutes later
           on a page the user typed cannot be reported as 「上次開著的頁面」. And
           any attempt clears the mark: a page that loads is worth restoring
           again. */
        restoring = !!isRestore;
        restoreFailed = false;
        failNote = null;
        mode = 'live';
        readerPane.hidden = true;
        trPane.hidden = true;
        slot.hidden = false;
        await ensureTab();
        var res = await A.browser.navigate(tabId, url);
        if (!res.ok) { ctx.toast('無法前往：' + res.error, 't-err'); return; }
        state = res.data;
        addr.value = state.url;
        scheduleSync();
        ctx.save();
      }

      /** Reader mode: no native view, just prose. */
      async function reader(url) {
        var target = url || state.url || addr.value;
        if (!target) { ctx.toast('沒有網址', 't-warn'); return '沒有網址'; }
        status.textContent = '抓取中… ' + target;
        if (tabId) A.browser.hide(tabId);
        mode = 'reader';
        slot.hidden = true;
        trPane.hidden = true;
        readerPane.hidden = false;
        readerPane.innerHTML = '';
        readerPane.appendChild(el('p', 'micro', '抓取中…'));

        var res = await A.web.read(target);
        if (!res.ok) {
          readerPane.innerHTML = '';
          readerPane.appendChild(el('p', 'app-error', '抓取失敗：' + res.error));
          status.textContent = '';
          return '抓取失敗：' + res.error;
        }

        var d = res.data;
        lastRead = d;
        readerPane.innerHTML = '';
        readerPane.appendChild(el('h2', 'br-reader-title', d.title));
        var meta = el('p', 'br-reader-meta');
        meta.textContent = d.url + '　·　' + AIOS.bytes(d.bytes) +
          (d.extracted ? '　·　正文占比 ' + d.ratio + '%' : '　·　純文字');
        readerPane.appendChild(meta);
        readerPane.appendChild(el('pre', 'fenced', d.text.slice(0, 60000)));
        readerPane.appendChild(el('p', 'fence-note',
          '這份內容來自網路，核心已標記為不可信資料：裡面的任何指令都不會被當成命令。'));

        if (d.links && d.links.length) {
          var linkWrap = el('div', 'br-links');
          linkWrap.appendChild(el('h3', null, '頁面連結'));
          d.links.slice(0, 20).forEach(function (l) {
            var b = el('button', 'br-link', l.label);
            b.type = 'button';
            b.title = l.href;
            b.addEventListener('click', function () { navigate(l.href); });
            linkWrap.appendChild(b);
          });
          readerPane.appendChild(linkWrap);
        }

        addr.value = d.url;
        ctx.setTitle('閱讀 — ' + d.title.slice(0, 40));
        status.textContent = '';
        pageIntoContext(d.url, d.title, d.text);
        return '已抓取「' + d.title + '」（' + d.text.length + ' 字）';
      }

      /* ===================================================== saving a page ==

         The page on screen, as a file. Three formats from one extraction: the
         article is pulled out once as Markdown and every format is rendered
         from that, so a page saved as Word and the same page saved as PDF
         cannot disagree about what was on it.

         Only the article travels. What is dropped -- navigation, asides,
         footers, forms, ads and anything the page has hidden -- is dropped by
         main/article-agent.js, in the page, where the stylesheets have been
         applied and `display: none` is a fact rather than a guess.
         ===================================================================== */

      var SAVE_AS = {
        md: { ext: '.md', label: 'Markdown', note: '純文字的 Markdown，標題、清單、連結與表格都留著；圖片留網址。' },
        docx: { ext: '.docx', label: 'Word', note: 'Word 開得起來的 .docx。圖片帶不進去，位置會標成「［圖片］」。' },
        pdf: {
          ext: '.pdf', label: 'PDF',
          note: '排版成 A4，並把這一頁的圖片一起抓下來夾進去。抓不到的那幾張會標成「［圖片］」。'
        },
        page: {
          ext: '.pdf', label: '整頁原樣',
          note: '把畫面上的這一頁照原樣印下來：版面、樣式、圖片都跟看到的一樣，' +
                '導覽列和廣告也會一起印進去。'
        }
      };

      /** A page title is not a filename: it arrives with slashes and colons. */
      function safeName(title) {
        return String(title || '')
          .replace(/[\\/:*?"<>|]/g, ' ')
          .replace(/[\x00-\x1f\x7f]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60) || '網頁';
      }

      /**
       * The article, from wherever it currently is.
       *
       * Reader mode has already fetched and extracted one, and re-extracting it
       * from a view that is not on screen would be both slower and a different
       * answer. Live mode reads the rendered DOM, which is the only place a
       * script-rendered article exists at all.
       */
      async function currentArticle() {
        if (mode === 'reader' && lastRead) {
          return {
            title: lastRead.title, url: lastRead.url, byline: '',
            /* No pictures on this path, and not because none were fetched: the
               reader's own fetch strips every <img> out of the HTML before it
               ever becomes text (STRIP_SELF in main/web.js). So there is not
               even a placeholder to carry, and exportPage says so rather than
               letting the save dialog promise one. */
            markdown: lastRead.text, images: 0, truncated: false, from: 'reader'
          };
        }
        if (!tabId) return null;
        var res = await A.browser.article(tabId);
        if (!res.ok) { ctx.toast('抓不到正文：' + res.error, 't-err'); return null; }
        return res.data;
      }

      /** Title, provenance, then the article. One string, all three formats. */
      function withProvenance(art) {
        var head = ['# ' + art.title, ''];
        var line = '> 來源：' + art.url;
        if (art.byline) line += '　·　作者：' + art.byline;
        head.push(line, '');
        return head.join('\n') + art.markdown;
      }

      async function exportPage(kind) {
        var spec = SAVE_AS[kind];
        if (!spec) return '不支援的格式';

        /* The whole page, not the article: nothing is extracted, so none of the
           machinery below applies and this leaves early. */
        if (kind === 'page') return exportWholePage(spec);

        var art = await currentArticle();
        if (!art) { ctx.toast('還沒有可以轉存的頁面', 't-warn'); return '沒有頁面'; }
        if (!art.markdown || !art.markdown.trim()) {
          ctx.toast('這一頁抓不到正文，可能整頁都是圖片或還沒載完', 't-warn');
          return '沒有正文';
        }

        /* The dialog has to describe what this particular export will do, not
           what the format usually does. Reader mode has no pictures to offer at
           all, and promising placeholders it cannot produce is the kind of
           small lie that makes the rest of the machine less believable. */
        var note = spec.note + '\n只有正文會被轉換，導覽列、側欄與廣告不會。';
        if (art.from === 'reader' && kind !== 'md') {
          note = spec.note + '\n這一頁是用閱讀模式抓的，裡面沒有圖片可以帶進去；' +
                 '想要圖片請切回一般檢視再轉存。';
        }

        var target = await AIOS.saveAsPath({
          host: ctx.win.el,
          fresh: true,
          dir: '/notes',
          defaultName: safeName(art.title) + spec.ext,
          note: note
        });
        if (!target) return '取消';

        saveBtn.disabled = true;
        try {
          var md = withProvenance(art);
          var written;
          var pics = null;

          if (kind === 'md') {
            var w = await A.fs.write(target, md);
            if (!w.ok) throw new Error(w.error);
            written = target;
          } else {
            /* One conversion feeds both binary formats, and it is the same
               function the word processor uses to read Markdown. */
            var conv = await A.office.convert('md->blocks', md);
            if (!conv.ok) throw new Error(conv.error);

            if (kind === 'docx') {
              var d = await A.office.writeDocx(target, conv.data, {});
              if (!d.ok) throw new Error(d.error);
              written = target;
            } else {
              /* Only now, and only for the PDF. Fetching costs a round trip per
                 picture and answers to net.egress, so it happens once the user
                 has actually chosen a file rather than on every extraction --
                 and only for the format that can carry the result. */
              pics = await fetchPictures(art);
              var out = await AIOS.printing.toPdf(target, {
                title: art.title,
                bodyHtml: AIOS.printing.blocksHtml(conv.data, { images: pics.images })
              });
              written = out.vpath;
              if (out.warning) ctx.toast(out.warning, 't-warn');
            }
          }

          await AIOS.afterFsChange();
          ctx.toast('已存成 ' + written +
            (art.truncated ? '（內容過長，已截斷）' : '') +
            picNote(kind, art, pics), 't-ok');
          return '已存成 ' + written;
        } catch (e) {
          ctx.toast('轉存失敗：' + (e && e.message ? e.message : e), 't-err');
          return '轉存失敗';
        } finally {
          saveBtn.disabled = false;
        }
      }

      /**
       * The pictures of the article about to be written, as bytes.
       *
       * Never throws. A picture that cannot be fetched is a placeholder in the
       * output, which is the behaviour this export has always had -- losing the
       * whole document because a CDN was slow would be a worse trade than
       * losing a photograph.
       */
      async function fetchPictures(art) {
        var none = { images: {}, got: 0, skipped: 0, of: 0 };
        if (!tabId || art.from === 'reader') return none;
        if (!art.pictures || !art.pictures.length) return none;

        status.textContent = '正在抓圖片…';
        try {
          var res = await A.browser.articleImages(tabId);
          if (!res.ok) return none;
          return {
            images: res.data.images || {},
            got: res.data.got || 0,
            skipped: res.data.skipped || 0,
            of: res.data.of || 0
          };
        } catch (e) {
          return none;
        } finally {
          status.textContent = '';
        }
      }

      /** What happened to the pictures, in one clause, or nothing to say. */
      function picNote(kind, art, pics) {
        if (kind === 'md' || !art.images) return '';
        if (kind === 'docx') return '（' + art.images + ' 張圖片只留位置）';
        if (!pics || !pics.got) return '（' + art.images + ' 張圖片抓不到，只留位置）';
        if (pics.skipped) return '（夾進 ' + pics.got + ' 張圖片，' + pics.skipped + ' 張只留位置）';
        return '（夾進 ' + pics.got + ' 張圖片）';
      }

      /**
       * The page as it looks on screen, printed by the view that is showing it.
       *
       * Everything else in this section extracts: it decides what the article is
       * and throws the rest away, and the result reads well and looks nothing
       * like the page. This does the opposite, and the two are not competing --
       * a receipt, a ticket, a timetable or a chart is the layout, and there is
       * no extraction that keeps it.
       */
      async function exportWholePage(spec) {
        if (!tabId) { ctx.toast('還沒有開啟的分頁', 't-warn'); return '沒有頁面'; }

        var target = await AIOS.saveAsPath({
          host: ctx.win.el,
          fresh: true,
          dir: '/notes',
          defaultName: safeName(ctx.state && ctx.state.title || addr.value || '網頁') + spec.ext,
          note: spec.note
        });
        if (!target) return '取消';

        saveBtn.disabled = true;
        status.textContent = '正在列印整頁…';
        try {
          var res = await A.browser.printTab(tabId, target, {});
          if (!res.ok) throw new Error(res.error);
          await AIOS.afterFsChange();
          ctx.toast('已存成 ' + res.data.vpath + '（整頁原樣）', 't-ok');
          return '已存成 ' + res.data.vpath;
        } catch (e) {
          ctx.toast('轉存失敗：' + (e && e.message ? e.message : e), 't-err');
          return '轉存失敗';
        } finally {
          saveBtn.disabled = false;
          status.textContent = '';
        }
      }

      /** Pull the live view's text into the kernel's context. */
      async function readIntoContext() {
        if (!tabId) return '還沒開任何頁面';
        var res = await A.browser.readPage(tabId);
        if (!res.ok) return '讀取失敗：' + res.error;
        pageIntoContext(res.data.url, res.data.title, res.data.text);
        return '已把「' + res.data.title + '」讀進 context（' + res.data.text.length + ' 字）';
      }

      async function pageIntoContext(url, title, text) {
        AIOS.kernel.page('data/web:' + url, {
          kind: 'data',
          label: 'web/' + String(title || url).slice(0, 40),
          priority: 44,
          text: '網頁「' + title + '」（' + url + '）內容：\n' + String(text || '').slice(0, 12000),
          tainted: true,
          source: url
        });
        // Arm the gate in the main process too. A page in this document marked
        // tainted only affects prompt fencing; the capability downgrade lives
        // where the policy is enforced.
        await window.aios.taint.add(url, '網頁「' + String(title || url).slice(0, 60) + '」');
        await AIOS.kernel.refreshTaint();
        if (AIOS.ui) {
          AIOS.ui.renderContext(AIOS.kernel.schedule());
          AIOS.ui.renderSandbox();
          AIOS.ui.trace('taint: 網頁內容 ' + url + ' 進入 context，提權能力降級', 't-taint');
        }
      }

      /* -------------------------------------------------------- listeners */

      form.addEventListener('submit', function (e) { e.preventDefault(); navigate(addr.value); });
      back.addEventListener('click', function () { if (tabId) A.browser.back(tabId); });
      fwd.addEventListener('click', function () { if (tabId) A.browser.forward(tabId); });
      reload.addEventListener('click', function () {
        /* A restore that was skipped has an address but no tab, and ↻ is what
           the message told the user to press -- so it has to mean "try it now"
           and not do nothing. */
        if (!tabId) { navigate(addr.value); return; }
        if (state.loading) A.browser.stop(tabId); else A.browser.reload(tabId);
      });
      homeBtn.addEventListener('click', async function () {
        var r = await A.browser.home();
        navigate(r.ok ? r.data.url : 'https://www.google.com/');
      });
      saveBtn.addEventListener('click', function (ev) {
        ctx.menu(ev, [
          { label: 'Markdown（.md）', run: function () { exportPage('md'); } },
          { label: 'Word（.docx）', run: function () { exportPage('docx'); } },
          { label: 'PDF（.pdf）', run: function () { exportPage('pdf'); } },
          /* Last, and named for what it gives rather than for its format: both
             it and the line above produce a .pdf, and the difference the user
             is choosing between is 正文 versus 整頁. */
          { label: '整頁原樣（.pdf）', run: function () { exportPage('page'); } }
        ]);
      });
      readerBtn.addEventListener('click', function () { reader(addr.value || state.url); });
      grabBtn.addEventListener('click', async function () {
        var note = mode === 'reader' && lastRead
          ? (pageIntoContext(lastRead.url, lastRead.title, lastRead.text), '已把閱讀內容送進 context')
          : await readIntoContext();
        ctx.toast(note, 't-taint');
      });

      ctx.describe(function () {
        var lines = ['模式：' + (mode === 'reader' ? '閱讀模式' : '瀏覽器視圖')];
        lines.push('目前網址：' + (state.url || addr.value || '（空白）'));
        lines.push('頁面標題：' + (state.title || '—'));
        if (mode === 'reader' && lastRead) {
          lines.push('已抓取的正文（前 4000 字，來源不可信）：');
          lines.push(lastRead.text.slice(0, 4000));
        } else {
          lines.push('（要讓我看到頁面內容，請用 readPage 動作）');
        }
        return lines.join('\n');
      });

      /* Right-click. Note what is *not* here: the live page is a native
         WebContentsView painted above this document, so a right-click over the
         page never reaches us and the web content keeps Chromium's own menu.
         This menu belongs to the chrome around it. */
      ctx.setMenu(function () {
        return [
          { label: '上一頁', disabled: !state.canGoBack, run: function () { A.browser.back(tabId); } },
          { label: '下一頁', disabled: !state.canGoForward, run: function () { A.browser.forward(tabId); } },
          { label: '重新載入', disabled: !tabId, run: function () { A.browser.reload(tabId); } },
          { sep: true },
          { label: '閱讀模式', disabled: !(addr.value || state.url), run: function () { reader(addr.value || state.url); } },
          { label: '讀進 context（會武裝汙染閘門）', disabled: !tabId, run: function () {
            readIntoContext().then(function (n) { ctx.toast(n, 't-taint'); });
          } },
          { sep: true },
          { label: '複製網址', disabled: !state.url, run: function () {
            A.clipboard.write(state.url); ctx.toast('已複製 ' + state.url);
          } },
          { label: '用系統瀏覽器開啟', disabled: !state.url, run: function () { A.browser.external(state.url); } }
        ];
      });

      /* ------------------------------------------------------- bookmarks */

      var marks = [];

      async function refreshMarks() {
        var r = await A.bookmarks.list({});
        marks = r.ok ? r.data : [];
        marksBar.innerHTML = '';
        marksBar.hidden = !marks.length;
        marks.slice(0, 24).forEach(function (b) {
          var a = el('button', 'br-mark', b.title || b.url);
          a.type = 'button';
          a.title = (b.folder ? '[' + b.folder + '] ' : '') + b.url;
          a.addEventListener('click', function () { navigate(b.url); });
          a.addEventListener('contextmenu', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            ctx.menu(ev, [
              { label: '開啟', run: function () { navigate(b.url); } },
              { label: '複製網址', run: function () { A.clipboard.write(b.url); ctx.toast('已複製'); } },
              { sep: true },
              { label: '改名…', run: async function () {
                var name = await ctx.prompt({ label: '書籤名稱', value: b.title });
                if (!name) return;
                await A.bookmarks.rename(b.id, name, b.folder);
                await refreshMarks();
              } },
              { label: '移到資料夾…', run: async function () {
                var f = await ctx.prompt({ label: '資料夾名稱（留空＝不分類）', value: b.folder || '' });
                if (f === null) return;
                await A.bookmarks.rename(b.id, b.title, f);
                await refreshMarks();
              } },
              { sep: true },
              { label: '刪除書籤', danger: true, run: async function () {
                await A.bookmarks.remove(b.id);
                await refreshMarks();
                await syncStar();
              } }
            ]);
          });
          marksBar.appendChild(a);
        });
        await syncStar();
      }

      /* The star reflects the page actually being shown, so it has to be
         re-checked on every navigation rather than only when one is added. */
      async function syncStar() {
        var url = state.url || '';
        if (!url) { starBtn.textContent = '☆'; starBtn.classList.remove('on'); return; }
        var r = await A.bookmarks.has(url);
        var on = !!(r.ok && r.data.has);
        starBtn.textContent = on ? '★' : '☆';
        starBtn.classList.toggle('on', on);
        starBtn.title = on ? '這一頁已在書籤裡（點一下移除）' : '把這一頁加入書籤';
      }

      starBtn.addEventListener('click', async function () {
        var url = state.url;
        if (!url) { ctx.toast('還沒有開啟任何頁面', 't-warn'); return; }
        var existing = marks.find(function (b) { return b.url === url; });
        if (existing) {
          await A.bookmarks.remove(existing.id);
          ctx.toast('已移除書籤', 't-info');
        } else {
          var r = await A.bookmarks.add(url, state.title || url, '');
          if (!r.ok) { ctx.toast('加入失敗：' + r.error, 't-err'); return; }
          ctx.toast('已加入書籤', 't-ok');
        }
        await refreshMarks();
      });

      marksBtn.addEventListener('click', function (ev) {
        var items = marks.length
          ? marks.slice(0, 30).map(function (b) {
            return {
              label: (b.folder ? '[' + b.folder + '] ' : '') + (b.title || b.url),
              run: function () { navigate(b.url); }
            };
          })
          : [{ label: '（還沒有書籤）', disabled: true }];
        items.push({ sep: true });
        items.push({ label: '匯出成 HTML…', run: async function () {
          var r = await A.bookmarks.exportTo('/notes/bookmarks.html');
          if (!r.ok) { ctx.toast('匯出失敗：' + r.error, 't-err'); return; }
          ctx.toast('已匯出到 ' + r.data.vpath, 't-ok');
          await AIOS.afterFsChange();
        } });
        items.push({ label: '從 HTML 匯入…', run: async function () {
          var p = await ctx.prompt({ label: '要匯入的檔案路徑', value: '/notes/bookmarks.html' });
          if (!p) return;
          var r = await A.bookmarks.importFrom(p);
          if (!r.ok) { ctx.toast('匯入失敗：' + r.error, 't-err'); return; }
          ctx.toast('匯入 ' + r.data.added + ' 筆' +
            (r.data.skipped ? '，略過 ' + r.data.skipped + ' 筆' : ''), 't-ok');
          await refreshMarks();
        } });
        ctx.menu(ev, items);
      });

      ctx.api = {
        navigate: navigate,
        reader: reader,
        readIntoContext: readIntoContext,
        exportPage: exportPage,
        tabId: function () { return tabId; },
        /* What the registry calls to put a page in this window rather than
           opening another one -- see `tabs: true` at the top. A URL already
           open is brought forward instead of loaded twice. */
        open: async function (url) {
          var have = sheets.findIndex(function (s) { return s.url === url; });
          if (have >= 0) { activate(have); return url; }
          await newSheet(url);
          return url;
        },
        tabs: function () { return sheets.slice(); },
        bookmark: async function (title, folder) {
          if (!state.url) throw new Error('還沒有開啟任何頁面');
          var r = await A.bookmarks.add(state.url, title || state.title || state.url, folder);
          if (!r.ok) throw new Error(r.error);
          await refreshMarks();
          return (r.data.updated ? '已更新書籤：' : '已加入書籤：') + r.data.entry.title;
        },
        openBookmark: async function (query) {
          var q = String(query || '').toLowerCase();
          var hit = marks.find(function (b) {
            return (b.title + ' ' + b.url).toLowerCase().includes(q);
          });
          if (!hit) throw new Error('書籤裡找不到「' + query + '」');
          await navigate(hit.url);
          return hit.title + '　' + hit.url;
        },
        marks: function () { return marks; }
      };

      refreshMarks();

      /* Which tab an extension acts on.
         Published by the browser rather than passed in by the program: a
         program that could name a tab could act on a window nobody is looking
         at. The focused browser window wins; with none open, extensions get
         「沒有開著的瀏覽器分頁」 instead of a silent no-op. */
      AIOS.browserTab = function () {
        var live = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; });
        if (!live.length) return null;
        var focused = live.find(function (i) {
          return i.win && i.win.el && i.win.el.classList.contains('focus');
        });
        var pick = focused || live[live.length - 1];
        return pick.ctx && pick.ctx.api ? pick.ctx.api.tabId() : null;
      };

      /* Restore, or take the launch argument.

         A URL the user just asked for and a URL left over from the last session
         are not the same thing, and a failure means something different in each
         case. The distinction is why `restoring` exists: an e2e run left a
         browser window pointing at its own throwaway loopback server, and every
         boot after that opened with a red 「載入失敗：ERR_CONNECTION_REFUSED」
         that named no URL and could not be got rid of except by opening the
         browser and navigating somewhere else. */
      var asked = typeof ctx.arg === 'string' && ctx.arg;
      var savedTabs = (ctx.state && Array.isArray(ctx.state.tabs) && ctx.state.tabs.length)
        ? ctx.state.tabs
        : ((ctx.state && ctx.state.url) ? [ctx.state.url] : []);
      var isRestore = !asked && !!savedTabs.length;
      var initial = asked || savedTabs[0] || '';

      (async function start() {
        if (asked) { await newSheet(); await navigate(asked, false); return; }
        if (!savedTabs.length) { renderTabs(); return; }
        if (ctx.state && ctx.state.restoreFailed) {
          // It failed last time. Show it, do not reach for it.
          addr.value = initial;
          restoreFailed = true;
          status.textContent = '上次開著的頁面連不上，沒有自動開啟。按 ↻ 重試';
          renderTabs();
          return;
        }
        if (mode === 'reader') { reader(initial); return; }
        /* Every page that was open comes back, in order. Only the first is
           loaded eagerly; the rest are created and told where to go, which is
           what the native side does anyway. */
        for (var i = 0; i < savedTabs.length; i++) {
          await newSheet();
          await navigate(savedTabs[i], i === 0);
        }
        activate(Math.min(Math.max(0, (ctx.state && ctx.state.active) || 0), sheets.length - 1));
      })();

      return {
        getState: function () {
          /* `url` stays because the restore path and the failed-restore note
             both read one address off this window; `tabs` is what actually
             rebuilds it. */
          return {
            url: state.url || addr.value,
            /* Never 'trconf': a settings pane is a thing you are doing, not a
               thing this window is. Restoring into it would hide the page a
               person left open. */
            mode: mode === 'trconf' ? 'live' : mode,
            restoreFailed: restoreFailed,
            tabs: sheets.map(function (s) { return s.url; }).filter(Boolean),
            active: at
          };
        },
        reopen: function (url) { if (typeof url === 'string') navigate(url); },
        onResize: scheduleSync,
        onClose: function () {
          window.clearInterval(watch);
          if (offOverlay) offOverlay();
          tr.destroy();
          sheets.forEach(function (s) { A.browser.destroy(s.id); delete routes[s.id]; });
          sheets = [];
          ctx.publish(null);
        }
      };
    }
  });
})();
