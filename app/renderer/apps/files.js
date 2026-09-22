'use strict';

/* ===========================================================================
   AI-OS // file manager
   ---------------------------------------------------------------------------
   The machine's own file manager, not a button that opens Explorer. It shows the
   sandbox and only the sandbox, which is the whole point: the tree here is the
   tree the model can see, so what you are looking at and what it can reach are
   the same set of objects.

   Operations go through the same gated IPC the model uses. Renaming a file from
   this window asks for fs.write exactly as it would if the planner had asked,
   because a file manager with a private back door would make the policy a lie.
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

  var ICONS = {
    dir: '\u25b8',
    txt: '\u25a4', json: '{ }', js: '\u2039\u203a', css: '\u2039\u203a',
    // Markdown has its own viewer now, so it gets its own mark rather than the
    // plain-text one.
    md: '\u2261', markdown: '\u2261', mdown: '\u2261', mkd: '\u2261',
    csv: '\u25a6', xlsx: '\u25a6', aiossheet: '\u25a6',
    docx: '\u25a7', aiosdoc: '\u25a7',
    aiosdeck: '\u25b0', pptx: '\u25b0',
    aiosapp: '\u2692',
    png: '\u25c9', jpg: '\u25c9', jpeg: '\u25c9', gif: '\u25c9', webp: '\u25c9', svg: '\u25c9',
    zip: '\u25eb', pdf: '\u25a5',
    _: '\u25a1'
  };

  function ext(name) {
    var m = String(name).match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
  }
  function icon(entry) {
    return entry.dir ? ICONS.dir : (ICONS[ext(entry.name)] || ICONS._);
  }

  /* What an extension may add to a file row: a line under it, or an item in
     its right-click menu. The unit is what the row already shows -- name,
     size, date, kind, whether it is trusted -- and nothing the row does not. */
  AIOS.slots.declare('files:list-row', {
    desc: '檔案清單每一列底下多一行字',
    gives: '{rows:[{vpath, name, dir, bytes, mtime, untrusted}]}',
    wants: '{items:["每一列要多寫的那行字，沒有就給空字串"]}'
  });
  AIOS.slots.declare('files:row-actions', {
    kind: 'act',
    desc: '檔案的右鍵選單多一項，按下去把那個檔案交給擴充程式',
    gives: '{slot, unit:{vpath, name, dir, bytes, mtime, untrusted}}',
    wants: 'slotAct 自己決定；它跑在擴充程式自己的視窗與能力裡',
    unitAt: function (ev) {
      var row = ev && ev.target && ev.target.closest ? ev.target.closest('.fm-row') : null;
      return row && row.__slotUnit ? row.__slotUnit : null;
    }
  });

  AIOS.apps.register({
    id: 'files',
    name: '檔案總管',
    icon: '\u25a4',
    kind: 'FILES',
    width: 760,
    height: 470,
    singleton: true,
    purpose: '瀏覽與管理沙箱裡的檔案',
    chatHint: '可以說「把 inbox 裡的 txt 都搬到 notes」或「這個目錄裡有什麼重要的東西」。',

    accepts: function () { return false; },   // the launcher opens it, not files

    actions: {
      goto: {
        args: '{dir}', desc: '切換到某個目錄',
        run: async function (args, ctx) {
          await ctx.api.nav(args.dir || '/');
          return { note: args.dir };
        }
      },
      open: {
        args: '{path}', desc: '用合適的程式開啟檔案',
        run: async function (args) {
          await AIOS.apps.openPath(args.path);
          return { note: args.path };
        }
      },
      mkdir: {
        args: '{path}', desc: '建立目錄',
        run: async function (args, ctx) {
          var r = await A.fs.mkdir(args.path);
          if (!r.ok) throw new Error(r.error);
          await ctx.api.refresh();
          return { note: r.data.vpath };
        }
      },
      rename: {
        args: '{from, to}', desc: '改名或搬移',
        run: async function (args, ctx) {
          var r = await A.fs.move(args.from, args.to);
          if (!r.ok) throw new Error(r.error);
          await ctx.api.refresh();
          return { note: r.data.from + ' → ' + r.data.to };
        }
      },
      remove: {
        args: '{path}', desc: '刪除（移到回收桶）',
        run: async function (args, ctx) {
          var r = await A.fs.remove(args.path);
          if (!r.ok) throw new Error(r.error);
          await ctx.api.refresh();
          return { note: r.data.vpath + ' → 回收桶' };
        }
      },
      newFile: {
        args: '{path, content}', desc: '建立一個新檔案',
        run: async function (args, ctx) {
          var r = await A.fs.write(args.path, args.content || '');
          if (!r.ok) throw new Error(r.error);
          await ctx.api.refresh();
          return { note: r.data.vpath };
        }
      }
    },

    mount: function (ctx) {
      ctx.body.classList.add('flush');

      var cwd = (ctx.state && ctx.state.cwd) || (typeof ctx.arg === 'string' ? ctx.arg : '/');
      var selected = null;
      var listing = { vpath: '/', entries: [] };
      var tree = { files: [], dirs: [] };

      /* ---------------------------------------------------------- chrome */

      var bar = el('div', 'fm-bar');
      var up = el('button', 'fbtn', '\u2191');
      up.type = 'button'; up.title = '上一層';
      var crumbs = el('div', 'fm-crumbs');
      var search = el('input', 'fm-search');
      search.type = 'search';
      search.placeholder = '搜尋沙箱…';
      search.setAttribute('aria-label', '搜尋檔案');
      bar.appendChild(up);
      bar.appendChild(crumbs);
      bar.appendChild(search);
      ctx.body.appendChild(bar);

      var tools = el('div', 'fm-tools');
      [
        ['\u2913 匯入', '從作業系統複製檔案進沙箱（原檔不動）', function () { AIOS.userImport(cwd); }],
        ['\u002b 新資料夾', '在目前目錄建立資料夾', newFolder],
        ['\u002b 新檔案', '在目前目錄建立文字檔', newFile],
        ['\u21bb', '重新讀取', refresh],
        ['\u267b 回收桶', '沙箱回收桶', function () { AIOS.openTrash(); }]
      ].forEach(function (t) {
        var b = el('button', 'fbtn', t[0]);
        b.type = 'button'; b.title = t[1];
        b.addEventListener('click', t[2]);
        tools.appendChild(b);
      });
      ctx.body.appendChild(tools);

      var split = el('div', 'fm-split');
      var side = el('nav', 'fm-tree');
      side.setAttribute('aria-label', '目錄樹');
      var listWrap = el('div', 'fm-list-wrap');
      var list = el('ul', 'fm-list');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', '檔案清單');
      listWrap.appendChild(list);
      split.appendChild(side);
      split.appendChild(listWrap);
      ctx.body.appendChild(split);

      var status = el('div', 'fm-status');
      ctx.body.appendChild(status);

      /* ------------------------------------------------------- rendering */

      function renderCrumbs() {
        crumbs.innerHTML = '';
        var parts = cwd.split('/').filter(Boolean);
        var acc = '';
        var root = el('button', 'fm-crumb', '沙箱');
        root.type = 'button';
        root.addEventListener('click', function () { nav('/'); });
        crumbs.appendChild(root);
        parts.forEach(function (p) {
          acc += '/' + p;
          var target = acc;
          crumbs.appendChild(el('span', 'fm-sep', '/'));
          var b = el('button', 'fm-crumb', p);
          b.type = 'button';
          b.addEventListener('click', function () { nav(target); });
          crumbs.appendChild(b);
        });
        up.disabled = cwd === '/';
      }

      function renderTree() {
        side.innerHTML = '';
        var dirs = ['/'].concat((tree.dirs || []).slice().sort());
        dirs.forEach(function (d) {
          var depth = d === '/' ? 0 : d.split('/').filter(Boolean).length;
          var name = d === '/' ? '沙箱' : d.split('/').pop();
          var b = el('button', 'fm-tnode' + (d === cwd ? ' on' : ''), name);
          b.type = 'button';
          b.style.paddingLeft = (7 + depth * 12) + 'px';
          b.title = d;
          b.addEventListener('click', function () { nav(d); });
          side.appendChild(b);
        });
      }

      /* Files whose *contents* matched the search box. Filled in the background;
         see the input handler. */
      var contentHits = [];
      var contentShort = 0;

      /** The row as an extension is handed it: what the row shows, nothing else. */
      function unitOf(ent) {
        return {
          vpath: String(ent.vpath || ''), name: String(ent.name || ''), dir: !!ent.dir,
          bytes: Number(ent.bytes) || 0, mtime: Number(ent.mtime) || 0, untrusted: !!ent.untrusted
        };
      }

      /* After the list is on screen, never before: the listing is the window's
         own content and must not wait on somebody else's code. */
      function paintContributions(entries) {
        if (!AIOS.slots || !entries.length) return;
        var rows = list.querySelectorAll('li.fm-row');
        AIOS.slots.annotate('files:list-row', entries.map(unitOf), function (i) { return rows[i] || null; });
      }

      function renderList(filter) {
        list.innerHTML = '';
        var entries = listing.entries;

        if (filter) {
          /* Names first, from the tree already in hand -- that answer is
             instant and it is the one most searches want. Anything found by
             content arrives a moment later from `contentHits`, which the search
             box fills in the background: reading files takes long enough that
             blocking the list on it would make typing feel broken. */
          var seenPath = {};
          entries = (tree.files || [])
            .filter(function (f) { return f.vpath.toLowerCase().indexOf(filter.toLowerCase()) >= 0; })
            .map(function (f) {
              seenPath[f.vpath] = 1;
              return {
                vpath: f.vpath, name: f.vpath, dir: false,
                bytes: f.bytes, untrusted: f.untrusted, mtime: 0
              };
            });
          contentHits.forEach(function (h) {
            if (seenPath[h.vpath]) return;
            entries.push({
              vpath: h.vpath, name: h.vpath, dir: false,
              bytes: h.bytes, untrusted: h.untrusted, mtime: 0,
              hit: h.lines && h.lines[0] ? ('L' + h.lines[0].line + '  ' + h.lines[0].text) : null
            });
          });
        }

        if (!entries.length) {
          list.appendChild(el('li', 'fm-empty', filter ? '沒有符合的檔案' : '（空目錄）'));
        }
        if (filter && contentShort) {
          list.appendChild(el('li', 'fm-empty',
            '（檔名全部比過了；內容只讀了前 ' + contentShort +
            ' 個檔案，再往後的沒看。縮小範圍或用更少見的字再試一次。）'));
        }

        entries.forEach(function (ent) {
          var li = el('li', 'fm-row' + (ent.dir ? ' dir' : '') + (selected === ent.vpath ? ' sel' : ''));
          li.setAttribute('role', 'option');
          li.setAttribute('aria-selected', selected === ent.vpath ? 'true' : 'false');
          li.tabIndex = 0;
          // The menu provider reads this back off the DOM, so right-clicking a
          // row and right-clicking empty space go through one code path.
          li.__ent = ent;
          li.__slotUnit = unitOf(ent);

          li.appendChild(el('span', 'fm-ico', icon(ent)));
          li.appendChild(el('span', 'fm-name', ent.name));
          if (ent.untrusted) li.appendChild(el('span', 'ftag', 'UNTRUSTED'));
          li.appendChild(el('span', 'fm-size', ent.dir ? '' : AIOS.bytes(ent.bytes)));
          if (ent.mtime) {
            li.appendChild(el('span', 'fm-date', new Date(ent.mtime).toLocaleDateString('zh-TW')));
          }

          function activate() {
            if (ent.dir) nav(ent.vpath);
            else AIOS.apps.openPath(ent.vpath);
          }
          li.addEventListener('click', function () { select(ent.vpath); });
          li.addEventListener('dblclick', activate);
          li.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); activate(); }
            if (e.key === 'Delete') { e.preventDefault(); removeEntry(ent); }
            if (e.key === 'F2') { e.preventDefault(); renameEntry(ent); }
          });

          list.appendChild(li);
        });
        paintContributions(entries);

        var dirs = entries.filter(function (e) { return e.dir; }).length;
        status.textContent = filter
          ? '搜尋「' + filter + '」：' + entries.length + ' 個結果'
          : entries.length + ' 個項目（' + dirs + ' 個資料夾）' +
            (selected ? '　·　已選 ' + selected : '');
      }

      function select(vpath) {
        selected = vpath;
        renderList(search.value.trim());
        ctx.save();
      }

      /* -------------------------------------------------------- behaviour */

      /* Say a thing once. A refresh that fails tends to keep failing -- the
         sandbox directory was taken away, the drive is gone -- and repeating the
         same red line every time buries whatever else the trace had to say. */
      var lastNavError = '';

      async function nav(dir) {
        var res = await A.fs.list(dir);
        if (!res.ok) {
          if (res.error !== lastNavError) {
            lastNavError = res.error;
            ctx.toast('無法開啟 ' + dir + '：' + res.error, 't-err');
          }
          return;
        }
        lastNavError = '';
        cwd = res.data.vpath;
        listing = res.data;
        selected = null;
        search.value = '';
        renderCrumbs();
        renderTree();
        renderList('');
        publish();
        ctx.setTitle('檔案總管 — ' + cwd);
        ctx.save();
      }

      async function refresh() {
        var t = await A.fs.tree();
        if (t.ok) tree = t.data;
        await nav(cwd);
      }

      async function newFolder() {
        var name = await prompt('新資料夾名稱', '新資料夾');
        if (!name) return;
        var r = await A.fs.mkdir(join(cwd, name));
        if (!r.ok) { ctx.toast('建立失敗：' + r.error, 't-err'); return; }
        await refresh();
      }

      async function newFile() {
        var name = await prompt('新檔案名稱', '未命名.txt');
        if (!name) return;
        var r = await A.fs.write(join(cwd, name), '');
        if (!r.ok) { ctx.toast('建立失敗：' + r.error, 't-err'); return; }
        await refresh();
        AIOS.apps.openPath(join(cwd, name));
      }

      async function renameEntry(ent) {
        var name = await prompt('改名為', ent.name);
        if (!name || name === ent.name) return;
        var parent = ent.vpath.replace(/\/[^/]+$/, '') || '';
        var r = await A.fs.move(ent.vpath, parent + '/' + name);
        if (!r.ok) { ctx.toast('改名失敗：' + r.error, 't-err'); return; }
        await refresh();
      }

      async function removeEntry(ent) {
        var r = await A.fs.remove(ent.vpath);
        if (!r.ok) { ctx.toast('刪除失敗：' + r.error, 't-err'); return; }
        ctx.toast(ent.name + ' → 回收桶');
        await refresh();
        await AIOS.afterFsChange();
      }

      async function duplicate(ent) {
        var stem = ent.name.replace(/(\.[^.]*)$/, '');
        var e2 = (ent.name.match(/(\.[^.]*)$/) || [''])[0];
        var r = await A.fs.copy(ent.vpath, join(cwd, stem + ' 複本' + e2));
        if (!r.ok) { ctx.toast('複製失敗：' + r.error, 't-err'); return; }
        await refresh();
      }

      function join(dir, name) {
        return (dir === '/' ? '' : dir) + '/' + String(name).replace(/^\/+/, '');
      }

      /* Menus and prompts come from the shared window furniture in
         surfaces.js. They used to live here; every other application needed
         the same thing, and a second copy is a second set of focus and
         keyboard bugs. */

      function prompt(label, initial) {
        return ctx.prompt({ label: label, value: initial });
      }

      /* Right-click. Two menus in one provider: one for a row, one for the
         space around the rows, chosen by what is under the cursor rather than
         by separate listeners -- so a click that lands between rows still gets
         the directory menu instead of nothing. */
      ctx.setMenu(function (ev) {
        var row = ev.target.closest ? ev.target.closest('.fm-row') : null;
        var ent = row && row.__ent;

        // Select here rather than from a listener on the row. Selecting
        // re-renders the list, and doing that from a contextmenu handler
        // destroys the row while the event is still travelling -- the menu
        // happens to survive because closest() also walks detached nodes, which
        // is not a property worth depending on.
        if (ent && selected !== ent.vpath) {
          selected = ent.vpath;
          window.setTimeout(function () { renderList(search.value.trim()); ctx.save(); }, 0);
        }

        if (ent && ent.dir) {
          return [
            { label: '開啟', run: function () { nav(ent.vpath); } },
            { sep: true },
            { label: '改名', hint: 'F2', run: function () { renameEntry(ent); } },
            { label: '複製路徑', run: function () { A.clipboard.write(ent.vpath); ctx.toast('已複製路徑'); } },
            { label: '刪除（進回收桶）', hint: 'Del', danger: true, run: function () { removeEntry(ent); } }
          ];
        }

        if (ent) {
          var isPdf = /\.pdf$/i.test(ent.name);
          var isMd = /\.(md|markdown|mdown|mkd)$/i.test(ent.name);
          return [
            { label: '開啟', hint: 'Enter', run: function () { AIOS.apps.openPath(ent.vpath); } },
            /* The two viewers that also produce something. Offered here rather
               than only through "開啟" because the useful action is not always the
               default one: a Markdown file opens rendered and the editor is the
               way back to the source, while a PDF's conversion is a separate step
               from looking at it. */
            isMd
              ? { label: '用 Markdown 檢視器開啟', run: function () {
                AIOS.apps.launch('markdown', ent.vpath, { forceNew: true });
              } }
              : null,
            isPdf
              ? { label: '轉成 Markdown（含圖片）…', run: async function () {
                // Hold on to the window this opened and convert that one. With
                // several PDFs open, an un-named invoke takes the first instance
                // it finds -- which converted somebody else's document.
                var win = await AIOS.apps.launch('pdf', ent.vpath, { forceNew: true });
                // The viewer has to have the document loaded before it can
                // convert it, so this waits for the frame rather than racing it.
                await new Promise(function (r) { window.setTimeout(r, 4000); });
                try { await AIOS.apps.invoke('pdf', 'toMarkdown', {}, win); } catch (e) {
                  ctx.toast('轉換失敗：' + (e && e.message ? e.message : e), 't-err');
                }
              } }
              : null,
            { label: '用編輯器開啟', run: function () { AIOS.apps.launch('editor', ent.vpath, { forceNew: true }); } },
            { sep: true },
            { label: '改名', hint: 'F2', run: function () { renameEntry(ent); } },
            { label: '複製一份', run: function () { duplicate(ent); } },
            { label: '複製路徑', run: function () { A.clipboard.write(ent.vpath); ctx.toast('已複製路徑'); } },
            ent.untrusted
              ? { label: '這個檔案來自不可信來源', disabled: true }
              : null,
            { sep: true },
            { label: '刪除（進回收桶）', hint: 'Del', danger: true, run: function () { removeEntry(ent); } }
          ];
        }

        return [
          { label: '新資料夾', run: newFolder },
          { label: '新文字檔', run: newFile },
          { sep: true },
          { label: '從作業系統匯入…', run: function () { AIOS.userImport(cwd); } },
          { label: '重新讀取', run: refresh },
          { sep: true },
          { label: '上一層', disabled: cwd === '/', run: function () { nav(cwd.replace(/\/[^/]+$/, '') || '/'); } },
          { label: '複製目前路徑', run: function () { A.clipboard.write(cwd); ctx.toast('已複製 ' + cwd); } },
          { label: '開啟回收桶', run: function () { AIOS.openTrash(); } }
        ];
      });

      var searchTimer = null;
      search.addEventListener('input', function () {
        if (searchTimer) window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(async function () {
          var q = search.value.trim();
          /* Names redraw immediately; content follows. A search box that waits
             for a hundred files to be read before it shows anything reads as
             broken, and the name match is what most searches wanted anyway. */
          contentHits = [];
          contentShort = 0;
          renderList(q);
          if (q.length < 2) return;
          var r = await A.fs.find(q, { dir: '/' });
          if (!r.ok || search.value.trim() !== q) return;
          contentHits = r.data.hits.filter(function (h) { return h.where === 'content'; });
          /* What it did not get to. Reading files has a budget, and a search
             that quietly stopped reading reports 「沒有符合的檔案」 about a
             file that is sitting there -- so the budget is said out loud
             rather than left to be discovered. Names are always compared to
             the end; this is only about what is inside them. */
          contentShort = r.data.truncated ? (r.data.scanned || 0) : 0;
          renderList(q);
        }, 200);
      });

      up.addEventListener('click', function () {
        nav(cwd.replace(/\/[^/]+$/, '') || '/');
      });

      function publish() {
        ctx.publish(
          '檔案總管目前在 ' + cwd + '\n' +
          listing.entries.map(function (e) {
            return '  ' + (e.dir ? '[目錄] ' : '') + e.vpath + (e.untrusted ? ' [不可信]' : '');
          }).join('\n'),
          'app/files'
        );
      }

      ctx.describe(function () {
        return '目前目錄：' + cwd + '\n' +
          '選取：' + (selected || '無') + '\n' +
          '這個目錄裡的項目：\n' +
          listing.entries.map(function (e) {
            return '  ' + e.vpath + (e.dir ? '/' : ' (' + e.bytes + ' B)') + (e.untrusted ? ' [不可信]' : '');
          }).join('\n') +
          '\n沙箱全部路徑：\n' +
          (tree.files || []).map(function (f) { return '  ' + f.vpath; }).join('\n');
      });

      // Exposed so the chat actions above can drive this instance.
      // Stored on the per-instance context rather than the shared definition,
      // so a second window drives its own state instead of the first one's.
      ctx.api = { nav: nav, refresh: refresh, cwd: function () { return cwd; } };

      refresh();

      return {
        getState: function () { return { cwd: cwd, selected: selected }; },
        reopen: function (dir) { if (typeof dir === 'string') nav(dir); },
        onClose: function () { ctx.publish(null); }
      };
    }
  });
})();
