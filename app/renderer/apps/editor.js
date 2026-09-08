'use strict';

/* ===========================================================================
   AI-OS // text and code editor
   ---------------------------------------------------------------------------
   Tabs, line numbers, find and replace, dirty tracking, and a chat panel that
   can rewrite the selection.

   Deliberately built on a plain <textarea> with a synchronised gutter rather
   than a code-editor library. A contenteditable rebuild of the text buffer is
   where these things usually go wrong -- lost undo, mangled IME input, broken
   selection on Chinese text -- and IME behaviour matters a lot when the whole
   interface is Chinese. Highlighting is a rendered overlay, so the buffer the
   user types into stays a real textarea with real native editing.
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

  var CODE_EXT = ['js', 'json', 'css', 'html', 'md', 'yaml', 'yml', 'ts', 'py', 'ps1', 'sh', 'xml', 'csv'];

  function ext(p) {
    var m = String(p || '').match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  }

  AIOS.apps.register({
    id: 'editor',
    contentApp: true,   // its chat panel gets the intent-enrichment guide
    /* Documents are tabs in one window, not one window each. */
    tabs: true,
    name: '編輯器',
    icon: '\u270e',
    kind: 'EDIT',
    width: 720,
    height: 480,
    purpose: '編輯沙箱裡的文字與程式碼檔案',
    chatHint: '選一段文字，然後說「把這段改寫得更精簡」或「這段程式有什麼問題」。',

    accepts: function (vpath) {
      var e = ext(vpath);
      return CODE_EXT.indexOf(e) >= 0 || e === 'txt' || e === '';
    },

    actions: {
      replaceSelection: {
        args: '{text}', desc: '用新內容取代使用者選取的範圍',
        run: async function (args, ctx) {
          if (args.text == null) throw new Error('沒有給 text');
          ctx.api.replaceSelection(String(args.text));
          return { note: '已取代 ' + String(args.text).length + ' 字' };
        }
      },
      replaceAll: {
        args: '{text}', desc: '取代整個檔案內容',
        run: async function (args, ctx) {
          if (args.text == null) throw new Error('沒有給 text');
          ctx.api.setContent(String(args.text));
          return { note: '已重寫整份檔案' };
        }
      },
      insertAtCursor: {
        args: '{text}', desc: '在游標位置插入文字',
        run: async function (args, ctx) {
          ctx.api.insert(String(args.text || ''));
          return { note: '已插入' };
        }
      },
      save: {
        args: '{}', desc: '儲存目前檔案',
        run: async function (_args, ctx) {
          var r = await ctx.api.save();
          return { note: r };
        }
      },
      saveAs: {
        args: '{path}', desc: '另存新檔到指定路徑（不給 path 就問使用者）',
        run: async function (args, ctx) {
          var r = await ctx.api.saveAs(args.path || null);
          return { note: r };
        }
      },
      open: {
        args: '{path}', desc: '在新分頁開啟另一個檔案',
        run: async function (args, ctx) {
          await ctx.api.open(args.path);
          return { note: args.path };
        }
      },
      findReplace: {
        args: '{find, replace, all}', desc: '尋找並取代',
        run: async function (args, ctx) {
          var n = ctx.api.findReplace(args.find, args.replace, args.all !== false);
          return { note: '取代了 ' + n + ' 處' };
        }
      }
    },

    mount: function (ctx) {
      ctx.body.classList.add('flush');

      /* tabs: [{ path, content, saved, cursor }] */
      var tabs = [];
      var active = -1;

      /* ------------------------------------------------------------- DOM */

      var tabbar = el('div', 'ed-tabs');
      ctx.body.appendChild(tabbar);

      var toolbar = el('div', 'ed-tools');
      var btnSave = el('button', 'fbtn', '儲存');
      btnSave.type = 'button'; btnSave.title = '儲存 (Ctrl+S)';
      var btnSaveAs = el('button', 'fbtn', '另存');
      btnSaveAs.type = 'button'; btnSaveAs.title = '另存新檔 (Ctrl+Shift+S)';
      var btnFind = el('button', 'fbtn', '尋找');
      btnFind.type = 'button'; btnFind.title = '尋找取代 (Ctrl+F)';
      var btnOpen = el('button', 'fbtn', '開啟…');
      btnOpen.type = 'button';
      var btnWrap = el('button', 'fbtn', '自動換行');
      btnWrap.type = 'button';
      btnWrap.setAttribute('aria-pressed', 'true');
      var info = el('span', 'ed-info');
      [btnSave, btnSaveAs, btnFind, btnOpen, btnWrap].forEach(function (b) { toolbar.appendChild(b); });
      toolbar.appendChild(info);
      ctx.body.appendChild(toolbar);

      var findBar = el('form', 'ed-find');
      findBar.hidden = true;
      var findInput = el('input', 'ed-find-input');
      findInput.placeholder = '尋找';
      findInput.setAttribute('aria-label', '尋找');
      var replInput = el('input', 'ed-find-input');
      replInput.placeholder = '取代為';
      replInput.setAttribute('aria-label', '取代為');
      var btnNext = el('button', 'fbtn', '下一個');
      btnNext.type = 'submit';
      var btnRepl = el('button', 'fbtn', '取代');
      btnRepl.type = 'button';
      var btnReplAll = el('button', 'fbtn', '全部取代');
      btnReplAll.type = 'button';
      var findCount = el('span', 'ed-find-count');
      [findInput, replInput, btnNext, btnRepl, btnReplAll, findCount].forEach(function (n) { findBar.appendChild(n); });
      ctx.body.appendChild(findBar);

      var pane = el('div', 'ed-pane');
      var gutter = el('div', 'ed-gutter');
      gutter.setAttribute('aria-hidden', 'true');
      var area = el('textarea', 'ed-area');
      area.spellcheck = false;
      area.setAttribute('aria-label', '檔案內容');
      area.wrap = 'soft';
      pane.appendChild(gutter);
      pane.appendChild(area);
      ctx.body.appendChild(pane);

      var status = el('div', 'ed-status');
      ctx.body.appendChild(status);

      /* ------------------------------------------------------------ state */

      function cur() { return active >= 0 ? tabs[active] : null; }

      function renderTabs() {
        tabbar.innerHTML = '';
        tabs.forEach(function (t, i) {
          var b = el('div', 'ed-tab' + (i === active ? ' on' : '') + (t.saved ? '' : ' dirty'));
          var name = el('button', 'ed-tab-name', t.path.split('/').pop() + (t.saved ? '' : ' \u25cf'));
          name.type = 'button';
          name.title = t.path;
          name.addEventListener('click', function () { activate(i); });
          b.appendChild(name);
          var x = el('button', 'ed-tab-x', '\u2715');
          x.type = 'button';
          x.title = '關閉分頁';
          x.setAttribute('aria-label', '關閉 ' + t.path);
          x.addEventListener('click', function (e) { e.stopPropagation(); closeTab(i); });
          b.appendChild(x);
          tabbar.appendChild(b);
        });
        if (!tabs.length) tabbar.appendChild(el('div', 'ed-tab-empty', '沒有開啟的檔案'));
      }

      function renderGutter() {
        var lines = area.value.split('\n').length;
        var want = [];
        for (var i = 1; i <= lines; i++) want.push(i);
        gutter.textContent = want.join('\n');
        gutter.scrollTop = area.scrollTop;
      }

      function renderStatus() {
        var t = cur();
        if (!t) { status.textContent = ''; info.textContent = ''; return; }
        var pos = area.selectionStart;
        var before = area.value.slice(0, pos);
        var line = before.split('\n').length;
        var col = pos - before.lastIndexOf('\n');
        var sel = area.selectionEnd - area.selectionStart;
        status.textContent =
          t.path + '　·　' + area.value.length + ' 字　·　' +
          area.value.split('\n').length + ' 行　·　行 ' + line + ' 欄 ' + col +
          (sel ? '　·　已選 ' + sel + ' 字' : '') +
          (t.saved ? '' : '　·　未儲存');
        info.textContent = (ext(t.path) || 'txt').toUpperCase();
      }

      function activate(i) {
        var prev = cur();
        if (prev) { prev.content = area.value; prev.cursor = area.selectionStart; }
        active = i;
        var t = cur();
        if (!t) { area.value = ''; area.disabled = true; renderTabs(); renderGutter(); renderStatus(); return; }
        area.disabled = false;
        area.value = t.content;
        area.selectionStart = area.selectionEnd = Math.min(t.cursor || 0, t.content.length);
        renderTabs();
        renderGutter();
        renderStatus();
        ctx.setTitle('編輯器 — ' + t.path.split('/').pop());
        publish();
        area.focus();
        ctx.save();
      }

      async function open(vpath) {
        if (!vpath) return;
        var existing = tabs.findIndex(function (t) { return t.path === vpath; });
        if (existing >= 0) { activate(existing); return; }

        var res = await A.fs.read(vpath);
        if (!res.ok) { ctx.toast('開啟失敗：' + res.error, 't-err'); return; }
        if (res.data.binary) { ctx.toast(vpath + ' 是二進位檔案，編輯器不處理', 't-warn'); return; }

        tabs.push({
          path: res.data.vpath,
          content: res.data.content || '',
          saved: true,
          cursor: 0,
          // Which version this tab is holding, so a save can refuse to replace a
          // different one. Carried per tab: each is a separate document.
          mtime: res.data.mtime,
          untrusted: res.data.untrusted
        });
        activate(tabs.length - 1);
        if (res.data.untrusted) {
          ctx.toast(vpath + ' 來自不可信來源，內容只當資料看', 't-taint');
        }
      }

      async function save() {
        var t = cur();
        if (!t) return '沒有開啟的檔案';
        t.content = area.value;
        /* Claim the version this tab opened. If the file moved on since, the
           write is refused and saveDoc asks rather than replacing it. */
        var res = await ctx.saveDoc(t.path, t.mtime, function (expect) {
          return A.fs.write(t.path, t.content, expect);
        });
        if (res && res.canceled) { ctx.toast(res.error, 't-warn'); return res.error; }
        if (!res.ok) { ctx.toast('儲存失敗：' + res.error, 't-err'); throw new Error(res.error); }
        t.saved = true;
        t.mtime = res.data.mtime;
        renderTabs();
        renderStatus();
        await AIOS.afterFsChange();
        ctx.toast('已儲存 ' + t.path + '（' + AIOS.bytes(res.data.bytes) + '）', 't-ok');
        return t.path;
      }

      /**
       * Write the buffer somewhere else and follow it there. Following is the
       * conventional behaviour and the one that makes the next Ctrl+S safe: if
       * the tab kept pointing at the original, "save a copy then keep editing"
       * would quietly write the edits back into the file the copy was made to
       * protect.
       */
      async function saveAs(target) {
        var t = cur();
        if (!t) return '沒有開啟的檔案';
        var to = target || await AIOS.saveAsPath({
          host: ctx.win.el,
          current: t.path,
          defaultName: '未命名.txt'
        });
        if (!to) return '取消';

        t.content = area.value;
        var res = await A.fs.write(to, t.content);
        if (!res.ok) { ctx.toast('另存失敗：' + res.error, 't-err'); throw new Error(res.error); }

        // The tab now *is* the new file -- including which version of it we
        // hold. Keeping the old file's stamp here would make the next Ctrl+S
        // report a conflict against a file this tab no longer points at.
        t.path = to;
        t.saved = true;
        t.mtime = res.data.mtime;
        renderTabs();
        renderStatus();
        ctx.setTitle('編輯器 — ' + to.split('/').pop());
        await AIOS.afterFsChange();
        publish();
        ctx.save();
        ctx.toast('已另存為 ' + to + '（' + AIOS.bytes(res.data.bytes) + '）', 't-ok');
        return to;
      }

      async function closeTab(i) {
        var t = tabs[i];
        if (t && !t.saved) {
          var ok = await ctx.confirm({
            label: t.path + ' 還沒儲存',
            note: '關掉這個分頁會丟掉未存的修改。',
            okLabel: '不存並關閉',
            danger: true
          });
          if (!ok) return;
        }
        tabs.splice(i, 1);
        activate(Math.min(i, tabs.length - 1));
      }

      /* ---------------------------------------------------- editing helpers */

      function setContent(text) {
        var t = cur();
        if (!t) return;
        area.value = text;
        t.content = text;
        t.saved = false;
        renderTabs(); renderGutter(); renderStatus(); publish();
      }

      function insert(text) {
        var s = area.selectionStart;
        var e = area.selectionEnd;
        area.setRangeText(text, s, e, 'end');
        markDirty();
      }

      function replaceSelection(text) {
        var s = area.selectionStart;
        var e = area.selectionEnd;
        if (s === e) { insert(text); return; }
        area.setRangeText(text, s, e, 'select');
        markDirty();
      }

      function markDirty() {
        var t = cur();
        if (!t) return;
        t.content = area.value;
        t.saved = false;
        renderTabs(); renderGutter(); renderStatus(); publish();
        ctx.save();
      }

      function findReplace(find, replace, all) {
        if (!find) return 0;
        var t = cur();
        if (!t) return 0;
        var n = 0;
        if (all) {
          var parts = area.value.split(find);
          n = parts.length - 1;
          if (n) setContent(parts.join(replace == null ? '' : replace));
        } else {
          var from = area.selectionEnd;
          var at = area.value.indexOf(find, from);
          if (at < 0) at = area.value.indexOf(find);
          if (at >= 0) {
            area.setRangeText(replace == null ? '' : replace, at, at + find.length, 'select');
            markDirty();
            n = 1;
          }
        }
        return n;
      }

      function findNext() {
        var q = findInput.value;
        if (!q) return;
        var from = area.selectionEnd;
        var at = area.value.indexOf(q, from);
        if (at < 0) at = area.value.indexOf(q);
        if (at < 0) { findCount.textContent = '找不到'; return; }
        area.focus();
        area.setSelectionRange(at, at + q.length);
        var total = area.value.split(q).length - 1;
        findCount.textContent = '共 ' + total + ' 處';
        renderStatus();
      }

      /* --------------------------------------------------------- listeners */

      area.addEventListener('input', markDirty);
      area.addEventListener('scroll', function () { gutter.scrollTop = area.scrollTop; });
      area.addEventListener('keyup', renderStatus);
      area.addEventListener('click', renderStatus);
      area.addEventListener('keydown', function (e) {
        // Ctrl+S and Ctrl+Shift+S are bound at the window by ctx.saveKeys, so
        // they work in the find box and the tab bar too, not just in here.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          findBar.hidden = false;
          findInput.focus();
          findInput.select();
        }
        if (e.key === 'Escape' && !findBar.hidden) { findBar.hidden = true; area.focus(); }
        // Tab inserts two spaces rather than leaving the field, which is what
        // anyone editing code in here expects.
        if (e.key === 'Tab') {
          e.preventDefault();
          insert('  ');
        }
      });

      btnSave.addEventListener('click', function () { save().catch(function () {}); });
      btnSaveAs.addEventListener('click', function () { saveAs().catch(function () {}); });
      btnFind.addEventListener('click', function () {
        findBar.hidden = !findBar.hidden;
        if (!findBar.hidden) findInput.focus();
      });
      btnOpen.addEventListener('click', function () { AIOS.apps.launch('files'); });

      /* Named rather than inline because the context menu offers it too, and
         the button's aria-pressed is the single source of truth for the state
         so the two can never disagree. */
      function wrapOn() { return btnWrap.getAttribute('aria-pressed') === 'true'; }
      function toggleWrap() {
        var on = !wrapOn();
        btnWrap.setAttribute('aria-pressed', on ? 'true' : 'false');
        area.wrap = on ? 'soft' : 'off';
        area.classList.toggle('nowrap', !on);
      }
      btnWrap.addEventListener('click', toggleWrap);

      findBar.addEventListener('submit', function (e) { e.preventDefault(); findNext(); });
      btnRepl.addEventListener('click', function () { findReplace(findInput.value, replInput.value, false); });
      btnReplAll.addEventListener('click', function () {
        var n = findReplace(findInput.value, replInput.value, true);
        findCount.textContent = '取代 ' + n + ' 處';
      });

      /* ------------------------------------------------------------ wiring */

      function publish() {
        var t = cur();
        if (!t) { ctx.publish(null); return; }
        ctx.publish('編輯器開著 ' + t.path + '（' + (t.saved ? '已儲存' : '未儲存') + '）\n' +
          '前 2000 字：\n' + area.value.slice(0, 2000), 'app/editor');
      }

      ctx.describe(function () {
        var t = cur();
        if (!t) return '沒有開啟任何檔案。已開分頁：無。';
        var s = area.selectionStart;
        var e = area.selectionEnd;
        var sel = area.value.slice(s, e);
        return [
          '開啟的檔案：' + t.path + (t.saved ? '（已儲存）' : '（未儲存）'),
          '分頁：' + tabs.map(function (x) { return x.path; }).join('、'),
          '總長度：' + area.value.length + ' 字，' + area.value.split('\n').length + ' 行',
          sel ? '使用者選取的範圍（' + sel.length + ' 字）：\n<<<\n' + sel.slice(0, 3000) + '\n>>>'
              : '使用者沒有選取任何文字。',
          '檔案內容（前 4000 字）：\n' + area.value.slice(0, 4000)
        ].join('\n');
      });

      ctx.saveKeys(save, saveAs);

      /* Right-click. The text area keeps the platform menu -- cut/copy/paste
         and spellcheck are worth more inside a text field than anything here --
         so this fires on the tab bar, the gutter and the chrome. */
      ctx.setMenu(function (ev) {
        var tabEl = ev.target.closest ? ev.target.closest('.ed-tab') : null;
        var t = cur();

        if (tabEl) {
          var idx = [].indexOf.call(tabbar.children, tabEl);
          var tt = tabs[idx];
          if (tt) {
            return [
              { label: '儲存', hint: 'Ctrl+S', disabled: tt.saved, run: function () { activate(idx); save().catch(function () {}); } },
              { label: '另存新檔…', hint: 'Ctrl+Shift+S', run: function () { activate(idx); saveAs().catch(function () {}); } },
              { sep: true },
              { label: '複製路徑', run: function () { A.clipboard.write(tt.path); ctx.toast('已複製 ' + tt.path); } },
              { label: '在檔案總管顯示', run: function () { AIOS.apps.launch('files', tt.path.replace(/\/[^/]+$/, '') || '/'); } },
              { sep: true },
              { label: '關閉分頁', danger: true, run: function () { closeTab(idx); } }
            ];
          }
        }

        return [
          { label: '儲存', hint: 'Ctrl+S', disabled: !t || t.saved, run: function () { save().catch(function () {}); } },
          { label: '另存新檔…', hint: 'Ctrl+Shift+S', disabled: !t, run: function () { saveAs().catch(function () {}); } },
          { sep: true },
          { label: '開啟檔案…', run: function () { AIOS.apps.launch('files'); } },
          { label: '尋找取代', hint: 'Ctrl+F', run: function () { findBar.hidden = false; findInput.focus(); } },
          { label: wrapOn() ? '關閉自動換行' : '開啟自動換行', run: toggleWrap },
          t ? { sep: true } : null,
          t ? { label: '複製全文', run: function () { A.clipboard.write(area.value); ctx.toast('已複製 ' + area.value.length + ' 字'); } } : null,
          t ? { label: '複製路徑', run: function () { A.clipboard.write(t.path); ctx.toast('已複製 ' + t.path); } } : null
        ];
      });

      ctx.api = {
        open: open, save: save, saveAs: saveAs, setContent: setContent, insert: insert,
        replaceSelection: replaceSelection, findReplace: findReplace,
        closeTab: closeTab,
        tabs: function () { return tabs; },
        activeIndex: function () { return active; },
        path: function () { var t = cur(); return t ? t.path : null; }
      };

      /* Restore tabs from the session, or open what we were launched with.
         An entry is either a path (saved tab) or {path, content, cursor} for one
         that had unsaved text; see getState. */
      (async function boot() {
        var st = ctx.state;
        if (st && Array.isArray(st.tabs) && st.tabs.length) {
          var want = st.tabs
            .map(function (e) { return typeof e === 'string' ? { path: e } : (e || {}); })
            .filter(function (e) { return e.path; });
          for (var i = 0; i < want.length; i++) await open(want[i].path);

          /* Applied after every open rather than during: open() activates the tab
             it just pushed, and activating stashes the textarea into the previous
             tab -- which would put the file's text back over the unsaved text we
             had just restored. */
          want.forEach(function (e) {
            if (typeof e.content !== 'string') return;
            var t = tabs.find(function (x) { return x.path === e.path; });
            if (!t) return;
            t.content = e.content;
            t.cursor = e.cursor || 0;
            t.saved = false;
          });
          // Same reason, one step later: make the stash a no-op before switching.
          var live = cur();
          if (live) area.value = live.content;
          activate(typeof st.active === 'number'
            ? Math.max(0, Math.min(st.active, tabs.length - 1))
            : tabs.length - 1);
        } else if (typeof ctx.arg === 'string') {
          await open(ctx.arg);
        } else {
          area.disabled = true;
          renderTabs();
          status.textContent = '從檔案總管開一個檔案，或按「開啟…」。';
        }
      })();

      return {
        /**
         * Unsaved text goes into the snapshot, not only the path.
         *
         * The shutdown ceremony closes windows without asking, on the grounds
         * that the session it just wrote is a faithful picture of the desk. That
         * was true of every other document app and false here: a tab used to come
         * back holding the file's contents instead of yours, quietly discarding
         * the edit the snapshot existed to preserve.
         *
         * A saved tab still carries only its path. The file is the copy, and a
         * session is not a backup of the sandbox.
         */
        getState: function () {
          var live = cur();
          if (live) { live.content = area.value; live.cursor = area.selectionStart; }
          return {
            tabs: tabs.map(function (t) {
              return t.saved ? t.path : { path: t.path, content: t.content, cursor: t.cursor };
            }),
            active: active
          };
        },
        reopen: function (p) { if (typeof p === 'string') open(p); },
        /* Closing a *tab* already asks. Closing the *window* used to take every
           tab with it silently, which is the same loss by a different button. */
        unsaved: function () { return tabs.some(function (t) { return !t.saved; }); },
        docName: function () {
          var open = tabs.filter(function (t) { return !t.saved; });
          return open.length > 1 ? open.length + ' 個未儲存的分頁' : (open[0] ? open[0].path : '編輯器');
        },
        save: async function () {
          // Every unsaved tab, not just the one in front: they are all going away.
          for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].saved) continue;
            activate(i);
            await save();
          }
        },
        onClose: function () { ctx.publish(null); }
      };
    }
  });
})();
