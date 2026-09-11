'use strict';

/* ===========================================================================
   AI-OS // 文件萃取
   ---------------------------------------------------------------------------
   Pick a vendor profile, add some PDFs, press parse, check the table, file the
   documents. That is the whole program, and it is deliberately the whole
   program: the people who use this are doing the same job forty times a day and
   every extra decision on the screen is a decision they have to make forty
   times.

   WHAT ACTUALLY HAPPENS

   The document goes to a cloud model, whole, with the vendor's tuned extraction
   prompt beside it, and rows come back. It is not clever. The cleverness is in
   the prompt, which was tuned somewhere else against real pages, and this
   program's job is to keep out of its way -- pass it through unaltered, hold the
   answer to the column list, and be honest about what did not work.

   The PDF is not turned into text first. That was tried; flattening the page
   destroys the association between a part number and the quantity printed
   beside it, and the extraction gets measurably worse.

   ITS MODEL IS NOT THIS MACHINE'S MODEL

   Separate endpoint, separate key, separate settings file, configured in this
   window rather than in the machine's. A person can be running a local core
   model for privacy and still be sending every delivery note to a cloud reader,
   and pretending those are one setting would hide that.

   THE ROWS ARE UNTRUSTED

   They came out of a document that arrived from outside. The main process marks
   the session tainted when it reads one, the summary published to the kernel
   reports counts and column names but never a cell value, and the filing step
   asks the gate about the whole batch at once -- one informed answer covering
   fifty moves, rather than fifty dialogs nobody reads by the ninth.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var A = window.aios;
  var X = AIOS.extract;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function btn(label, title, cls) {
    var b = el('button', cls || 'fbtn', label);
    b.type = 'button';
    if (title) b.title = title;
    return b;
  }

  /* How long to wait between asking a job how it is doing. Their own console
     uses two seconds and that is the right order: a person is watching. */
  var POLL_MS = 2000;
  var POLL_GIVE_UP = 20 * 60 * 1000;

  /* Above this many rows the table is summarised rather than drawn. A grid with
     ten thousand editable cells in it stops being a grid and starts being a
     reason the window will not scroll. */
  var MAX_DRAWN = 2000;

  AIOS.apps.register({
    id: 'extract',
    name: '文件萃取',
    icon: '✇',
    kind: 'EXT',
    width: 1040,
    height: 660,
    singleton: true,
    purpose: '把 PDF 依廠商設定萃取成表格資料，再歸檔',
    chatHint: '可以說「用大同的設定解析 /inbox 裡的兩份 PDF」或「把結果匯出成試算表」。',

    /* No `accepts`, deliberately. Double-clicking a PDF means "let me read
       this", and `forPath` takes the first registered program that claims the
       extension -- so claiming .pdf here would put this window one script-order
       change away from silently replacing the viewer for every PDF on the
       machine. Launching it with a path still works (the dock, an action, a
       drop), it just never becomes the default answer for a document. */

    actions: {
      use: {
        args: '{name}', desc: '選一個萃取設定（廠商／文件型態）',
        run: async function (args, ctx) {
          var r = await ctx.api.useProfile(args.name);
          return { note: r };
        }
      },
      add: {
        args: '{paths}', desc: '把沙箱裡的 PDF 加進待解析清單',
        run: async function (args, ctx) {
          var list = Array.isArray(args.paths) ? args.paths
            : String(args.paths || '').split(/[,\n]/).map(function (s) { return s.trim(); });
          var r = await ctx.api.addDocs(list.filter(Boolean));
          return { note: r };
        }
      },
      run: {
        args: '{}', desc: '把清單裡的文件送去解析',
        run: async function (args, ctx) {
          var r = await ctx.api.runAll();
          return { note: r };
        }
      },
      export: {
        args: '{path}', desc: '把結果寫成試算表檔（.xlsx）',
        run: async function (args, ctx) {
          var r = await ctx.api.exportSheet(args.path);
          return { note: r };
        }
      },
      deliver: {
        args: '{}', desc: '依設定把文件改名歸檔（會先列出整批請你確認）',
        run: async function (args, ctx) {
          var r = await ctx.api.deliver();
          return { note: r };
        }
      },
      clear: {
        args: '{}', desc: '清掉目前的文件與結果',
        run: async function (args, ctx) {
          var r = await ctx.api.clearAll();
          return { note: r };
        }
      }
    },

    mount: function (ctx) {
      /* ------------------------------------------------------------ state */

      var state = ctx.state || {};
      var profiles = [];          // [{vpath, parsed}]
      var profile = null;         // the parsed profile in use
      var docs = [];              // [{path, name, status, rows, error, tokens}]
      var rows = [];              // every extracted row, in order
      var preview = null;         // a filing plan being shown, not yet carried out
      var service = null;         // the backend's reported state
      var busy = false;
      var stop = false;
      var page = 'work';          // 'work' | 'settings'

      /* -------------------------------------------------------------- UI */

      ctx.body.classList.add('ext');

      var bar = el('div', 'ext-bar');
      var pickWrap = el('label', 'ext-pick');
      pickWrap.appendChild(el('span', 'micro', '設定'));
      var pick = el('select', 'ext-select');
      pick.setAttribute('aria-label', '萃取設定');
      pickWrap.appendChild(pick);
      bar.appendChild(pickWrap);

      var btnReload = btn('↻', '重新讀取沙箱裡的萃取設定');
      var btnNew = btn('新增設定', '在沙箱裡建立一個設定檔範本');
      var btnModel = btn('模型設定', '這支程式自己的萃取模型，跟系統的核心模型分開');
      bar.appendChild(btnReload);
      bar.appendChild(btnNew);
      bar.appendChild(btnModel);
      bar.appendChild(el('span', 'ext-gap'));

      var btnAdd = btn('加入文件', '從沙箱挑 PDF 加進清單');
      var btnRun = btn('開始解析', '把清單裡還沒解析的文件送出去', 'fbtn ext-go');
      var btnStop = btn('停止', '解析完目前這一份就停');
      btnStop.disabled = true;
      bar.appendChild(btnAdd);
      bar.appendChild(btnRun);
      bar.appendChild(btnStop);
      ctx.body.appendChild(bar);

      var work = el('div', 'ext-work');
      var side = el('div', 'ext-side');
      side.setAttribute('aria-label', '文件清單');
      var grid = el('div', 'ext-grid');
      grid.setAttribute('aria-label', '萃取結果');
      work.appendChild(side);
      work.appendChild(grid);
      ctx.body.appendChild(work);

      var settings = el('div', 'ext-settings');
      settings.hidden = true;
      ctx.body.appendChild(settings);

      var foot = el('div', 'ext-foot');
      var status = el('div', 'ext-status');
      foot.appendChild(status);
      var btnExport = btn('匯出試算表', '把結果寫成 .xlsx');
      var btnCancelPlan = btn('取消計畫', '不要歸檔，回到結果表格');
      btnCancelPlan.hidden = true;
      var btnDeliver = btn('交付歸檔', '依設定改名，分別歸到完成與待確認兩個資料夾', 'fbtn ext-go');
      foot.appendChild(btnExport);
      foot.appendChild(btnCancelPlan);
      foot.appendChild(btnDeliver);
      ctx.body.appendChild(foot);

      /* --------------------------------------------------------- profiles */

      async function loadProfiles() {
        var listed = await A.fs.list(X.PROFILE_DIR);
        var found = [];
        if (listed && listed.ok) {
          var entries = (listed.data && listed.data.entries) || listed.data || [];
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var vpath = e && (e.vpath || e.path || e.name);
            if (!vpath) continue;
            if (vpath.indexOf('/') !== 0) vpath = X.PROFILE_DIR + '/' + vpath;
            if (!/\.json$/i.test(vpath)) continue;
            var read = await A.fs.read(vpath);
            if (!read || !read.ok) continue;
            found.push({ vpath: vpath, parsed: X.parseProfile(read.data.content, vpath) });
          }
        }
        profiles = found;

        pick.innerHTML = '';
        if (!profiles.length) {
          var none = el('option', null, '（沒有設定檔）');
          none.value = '';
          pick.appendChild(none);
        }
        profiles.forEach(function (p, i) {
          var o = el('option', null, p.parsed.profile.name + (p.parsed.ok ? '' : '　⚠ 有問題'));
          o.value = String(i);
          pick.appendChild(o);
        });

        // Keep the one that was in use across a reload, by path rather than index.
        var want = profile ? profile.vpath : state.profileVpath;
        var found2 = profiles.findIndex(function (p) { return p.vpath === want; });
        pick.value = String(found2 >= 0 ? found2 : 0);
        profile = profiles.length ? profiles[Number(pick.value)].parsed.profile : null;
        renderAll();
      }

      function currentIssues() {
        var i = profiles.findIndex(function (p) { return profile && p.vpath === profile.vpath; });
        return i >= 0 ? profiles[i].parsed : null;
      }

      async function useProfile(name) {
        var want = String(name || '').toLowerCase();
        var hit = profiles.findIndex(function (p) {
          return p.parsed.profile.name.toLowerCase() === want ||
            p.vpath.toLowerCase() === want ||
            X.baseName(p.vpath).toLowerCase().replace(/\.json$/, '') === want ||
            (p.parsed.profile.vendor || '').toLowerCase() === want;
        });
        if (hit < 0) {
          throw new Error('找不到叫「' + name + '」的萃取設定。目前有：' +
            (profiles.map(function (p) { return p.parsed.profile.name; }).join('、') || '（一個也沒有）'));
        }
        pick.value = String(hit);
        profile = profiles[hit].parsed.profile;
        renderAll();
        return '改用「' + profile.name + '」';
      }

      async function makeTemplate() {
        var name = await ctx.prompt({
          label: '新的萃取設定',
          note: '會在 ' + X.PROFILE_DIR + ' 底下建立一個範本，內容用編輯器改。\n' +
            '把提示詞微調工作室產生的萃取提示詞貼進「提示詞」欄位。',
          value: '廠商名稱',
          okLabel: '建立'
        });
        if (!name) return null;

        var safe = X.safeSegment(name, '新設定');
        var vpath = X.PROFILE_DIR + '/' + safe + X.PROFILE_EXT;
        if (AIOS.fs.entry(vpath)) {
          ctx.toast(safe + X.PROFILE_EXT + ' 已經存在了', 't-err');
          return null;
        }
        await A.fs.mkdir(X.PROFILE_DIR);
        var body = JSON.stringify(X.profileTemplate('', name), null, 2);
        var w = await A.fs.write(vpath, body);
        if (!w || !w.ok) {
          ctx.toast('建立失敗：' + ((w && w.error) || '不明原因'), 't-err');
          return null;
        }
        await AIOS.afterFsChange();
        await loadProfiles();
        await useProfile(safe);
        ctx.toast('建好了：' + vpath + '　用編輯器把提示詞與欄位填上', 't-ok');
        return vpath;
      }

      /* ------------------------------------------------------- documents */

      async function addDocs(paths) {
        var added = 0;
        var skipped = [];
        (paths || []).forEach(function (p) {
          var vpath = String(p || '').trim();
          if (!vpath) return;
          if (docs.some(function (d) { return d.path === vpath; })) { skipped.push(vpath); return; }
          docs.push({ path: vpath, name: X.baseName(vpath), status: 'queued', rows: 0, error: '', tokens: 0 });
          added++;
        });
        renderAll();
        return '加了 ' + added + ' 份' + (skipped.length ? '，' + skipped.length + ' 份本來就在清單裡' : '');
      }

      function dropDoc(path) {
        docs = docs.filter(function (d) { return d.path !== path; });
        // The rows that came from it go with it, and the numbering closes up.
        rows = rows.filter(function (r) { return r[X.SOURCE_COLUMNS[0]] !== X.baseName(path); });
        renumber();
        renderAll();
      }

      function renumber() {
        rows.forEach(function (r, i) { r[X.SOURCE_COLUMNS[2]] = String(i + 1); });
      }

      async function clearAll() {
        docs = [];
        rows = [];
        renderAll();
        return '清空了';
      }

      /* ----------------------------------------------------------- parse */

      async function runAll() {
        if (busy) return '已經在解析了';
        if (!profile) return '還沒選萃取設定';

        var issues = currentIssues();
        if (issues && !issues.ok) {
          throw new Error('「' + profile.name + '」這個設定有問題，先修好再解析：\n　' +
            issues.errors.join('\n　'));
        }

        var queue = docs.filter(function (d) { return d.status === 'queued' || d.status === 'failed'; });
        if (!queue.length) return '沒有待解析的文件';

        await refreshService();
        if (!service || !service.configured) {
          throw new Error('還沒設定萃取模型。按上面的「模型設定」填端點、模型與金鑰。');
        }

        busy = true;
        stop = false;
        btnStop.disabled = false;
        btnRun.disabled = true;
        var ok = 0;
        var bad = 0;

        try {
          for (var i = 0; i < queue.length; i++) {
            if (stop) break;
            var doc = queue[i];
            doc.status = 'running';
            doc.error = '';
            renderDocs();
            ctx.toast('解析中 ' + (i + 1) + '/' + queue.length + '：' + doc.name, 't-info');

            try {
              var got = service.mode === 'service'
                ? await parseViaService(doc)
                : await parseViaModel(doc);

              // The rows this document contributed are replaced, not appended to,
              // so re-running a failed document twice does not double its lines.
              rows = rows.filter(function (r) { return r[X.SOURCE_COLUMNS[0]] !== doc.name; });
              var norm = X.normalise(got.rows, profile, {
                filename: doc.name, vendor: profile.vendor, startAt: rows.length + 1
              });
              rows = rows.concat(norm.rows);
              renumber();

              doc.rows = norm.rows.length;
              doc.tokens = (got.usage && got.usage.total) || 0;
              doc.status = norm.rows.length ? 'done' : 'empty';
              if (norm.dropped.length) {
                doc.error = '這份文件多給了設定裡沒有的欄位：' + norm.dropped.join('、');
              }
              if (got.truncated) doc.error = '結果被截斷了，可能不完整';
              ok++;
            } catch (e) {
              doc.status = 'failed';
              doc.error = e.message || String(e);
              bad++;
            }
            renderAll();
          }
        } finally {
          busy = false;
          stop = false;
          btnStop.disabled = true;
          btnRun.disabled = false;
          renderAll();
        }

        var note = '解析完成 ' + ok + ' 份' + (bad ? '，失敗 ' + bad + ' 份' : '') +
          '，共 ' + rows.length + ' 列';
        var blanks = X.requiredBlanks(rows, profile);
        if (blanks.length) note += '；必填未填 ' + blanks.length + ' 格';
        return note;
      }

      /** The direct path: the document itself, with the vendor's prompt. */
      async function parseViaModel(doc) {
        var r = await A.extract.send({
          path: doc.path,
          prompt: X.promptFor(profile),
          columns: profile.columns,
          mimeType: 'application/pdf'
        });
        if (!r || !r.ok) throw new Error((r && r.error) || '送出失敗');
        return r.data;
      }

      /**
       * The other path: a job on the extraction service the user already runs.
       *
       * Create, wait, collect. The service does its own prompt selection from the
       * category and vendor, so what is sent is the names rather than the prompt.
       */
      async function parseViaService(doc) {
        var made = await A.extract.call({
          method: 'POST', path: '/jobs', paths: [doc.path],
          fields: { category: profile.category, vendor: profile.vendor, owner: 'AI-OS' }
        });
        if (!made || !made.ok) throw new Error((made && made.error) || '建立工作失敗');
        var id = made.data.json && (made.data.json.job_id || made.data.json.id);
        if (!id) throw new Error('解析服務沒有回傳工作編號');

        var started = Date.now();
        for (;;) {
          if (stop) throw new Error('已停止');
          if (Date.now() - started > POLL_GIVE_UP) throw new Error('等太久了，這份先跳過');
          await new Promise(function (r) { setTimeout(r, POLL_MS); });

          var st = await A.extract.call({ path: '/jobs/' + encodeURIComponent(id) });
          if (!st || !st.ok) throw new Error((st && st.error) || '查詢進度失敗');
          var j = st.data.json || {};
          if (Number(j.pending) === 0 || Number(j.done) + Number(j.failed) >= Number(j.total)) {
            if (Number(j.failed) > 0) {
              var why = ((j.files || []).find(function (f) { return f.error; }) || {}).error;
              throw new Error(why || '解析服務回報這份文件失敗');
            }
            break;
          }
        }

        var res = await A.extract.call({
          path: '/jobs/' + encodeURIComponent(id) + '/result', query: { flat: 'true' }
        });
        if (!res || !res.ok) throw new Error((res && res.error) || '取回結果失敗');
        return { rows: (res.data.json && res.data.json.rows) || [], usage: {}, truncated: false };
      }

      /* ---------------------------------------------------------- export */

      async function exportSheet(target) {
        if (!profile) throw new Error('還沒選萃取設定');
        if (!rows.length) throw new Error('還沒有可以匯出的資料');

        var path = target;
        if (!path) {
          path = await AIOS.saveAsPath({
            host: ctx.win && ctx.win.el,
            dir: '/文件',
            defaultName: X.exportName(profile, new Date()),
            fresh: true,
            note: '把萃取結果寫成試算表。所有欄位都會以文字格式寫入，前導零不會被吃掉。'
          });
          if (!path) return '取消了';
        }
        if (!/\.xlsx$/i.test(path)) path += '.xlsx';

        var book = X.workbook(rows, profile);
        var w = await A.office.writeXlsx(path, book.name, book.cells, {
          sheets: [book], font: null
        });
        if (!w || !w.ok) throw new Error((w && w.error) || '寫檔失敗');
        await AIOS.afterFsChange();
        ctx.toast('匯出好了：' + path, 't-ok');
        return '寫了 ' + rows.length + ' 列到 ' + path;
      }

      /* -------------------------------------------------------- delivery */

      /**
       * File the documents.
       *
       * The plan is built and shown first, then the whole batch goes to the gate
       * as one question. The gate is the only thing entitled to approve it, and
       * it answers with the subset the person kept -- so unticking three of fifty
       * in that dialog leaves those three where they are.
       */
      function buildPlan() {
        if (!profile) throw new Error('還沒選萃取設定');
        if (!docs.length) throw new Error('清單裡沒有文件');
        return X.planDelivery({
          files: docs.map(function (d) { return { path: d.path }; }),
          rows: rows, profile: profile, at: new Date()
        });
      }

      /**
       * Show what filing would do, in the window, before asking for anything.
       *
       * A modal listing fifty renames is a modal nobody reads. This is the
       * shell doing what the shell is allowed to do -- ask and display -- and
       * the approval still belongs to the gate, one question covering the batch.
       */
      function previewDelivery() {
        preview = buildPlan();
        renderAll();
        return preview;
      }

      async function deliver() {
        var plan = preview || buildPlan();

        /* No mkdir pass. sandbox.move creates the destination's parents itself,
           and asking for the folders separately would put two more consent
           dialogs in front of the one that actually matters -- which is the
           batch below, the only question here worth a person's attention. */
        var items = plan.plan.map(function (e) { return { from: e.from, to: e.to }; });
        var verdict = await A.gate.askBatch('fs.move', items, '把萃取過的文件改名歸檔');
        if (!verdict || !verdict.ok || !verdict.data.ok) {
          return '沒有歸檔' + (verdict && verdict.data && verdict.data.reason
            ? '（' + verdict.data.reason + '）' : '');
        }
        var keep = {};
        (verdict.data.indices || []).forEach(function (n) { keep[n] = true; });

        var moved = 0;
        var failed = [];
        for (var k = 0; k < plan.plan.length; k++) {
          if (!keep[k]) continue;
          var entry = plan.plan[k];
          var r = await A.fs.move(entry.from, entry.to);
          if (r && r.ok) {
            moved++;
            var d = docs.find(function (x) { return x.path === entry.from; });
            if (d) { d.path = entry.to; d.filed = entry.status; }
          } else {
            failed.push(entry.name + '：' + ((r && r.error) || '搬移失敗'));
          }
        }

        preview = null;
        await AIOS.afterFsChange();
        renderAll();
        var note = '歸檔了 ' + moved + ' / ' + plan.plan.length + ' 份（完成 ' +
          plan.finished + '、待確認 ' + plan.unsure + '）';
        if (failed.length) {
          note += '；' + failed.length + ' 份沒搬成功';
          ctx.toast(failed.join('\n'), 't-err');
        }
        return note;
      }

      /* --------------------------------------------------------- drawing */

      function renderDocs() {
        side.innerHTML = '';
        var head = el('div', 'ext-side-head');
        head.appendChild(el('span', null, '文件 ' + docs.length));
        if (docs.length) {
          var clr = btn('清空', '把清單與結果都清掉', 'ext-mini');
          clr.addEventListener('click', function () { clearAll(); });
          head.appendChild(clr);
        }
        side.appendChild(head);

        if (!docs.length) {
          var hint = el('div', 'ext-empty');
          hint.appendChild(el('p', null, '還沒有文件。'));
          hint.appendChild(el('p', 'micro',
            '按上面的「加入文件」挑 PDF，或把檔案從檔案總管拖進這個視窗。'));
          side.appendChild(hint);
          return;
        }

        var list = el('ul', 'ext-docs');
        docs.forEach(function (d) {
          // Prefixed, because a status of 'empty' would otherwise collide with
          // the .ext-empty used for the "nothing here yet" panel.
          var li = el('li', 'ext-doc ext-st-' + d.status);
          var top = el('div', 'ext-doc-top');
          top.appendChild(el('span', 'ext-dot', glyphFor(d.status)));
          var nm = el('span', 'ext-doc-name', d.name);
          nm.title = d.path;
          top.appendChild(nm);
          var x = btn('×', '從清單移除', 'ext-mini');
          x.addEventListener('click', function () { dropDoc(d.path); });
          top.appendChild(x);
          li.appendChild(top);

          var meta = [];
          if (d.status === 'done') meta.push(d.rows + ' 列');
          if (d.status === 'empty') meta.push('沒抓到資料');
          if (d.status === 'running') meta.push('解析中…');
          if (d.status === 'queued') meta.push('待解析');
          if (d.tokens) meta.push(d.tokens + ' tokens');
          if (d.filed) meta.push(d.filed === 'finished' ? '已歸檔' : '已歸到待確認');
          if (meta.length) li.appendChild(el('div', 'ext-doc-meta micro', meta.join('　')));
          if (d.error) li.appendChild(el('div', 'ext-doc-err micro', d.error));
          list.appendChild(li);
        });
        side.appendChild(list);
      }

      function glyphFor(s) {
        return { queued: '○', running: '◔', done: '●', empty: '○', failed: '⚠' }[s] || '○';
      }

      function renderGrid() {
        grid.innerHTML = '';
        if (preview) { renderPreview(); return; }
        if (!profile) {
          grid.appendChild(note('先選一個萃取設定。',
            '設定檔放在 ' + X.PROFILE_DIR + '，一個廠商一個檔。按「新增設定」可以建一份範本。'));
          return;
        }

        var issues = currentIssues();
        if (issues && !issues.ok) {
          var bad = el('div', 'ext-note ext-bad');
          bad.appendChild(el('h3', null, '「' + profile.name + '」這個設定還不能用'));
          var ul = el('ul', null);
          issues.errors.forEach(function (e) { ul.appendChild(el('li', null, e)); });
          bad.appendChild(ul);
          bad.appendChild(el('p', 'micro', '檔案在 ' + profile.vpath + '，用編輯器改。'));
          grid.appendChild(bad);
          return;
        }

        if (!rows.length) {
          grid.appendChild(note('還沒有結果。',
            '欄位：' + profile.columns.join('、') +
            (profile.required.length ? '\n必填：' + profile.required.join('、') : '') +
            '\n交付：' + profile.deliver));
          return;
        }

        var header = X.headerOf(profile);
        var blanks = {};
        X.requiredBlanks(rows, profile).forEach(function (b) { blanks[b.row + '/' + b.column] = true; });

        var table = el('table', 'ext-table');
        var thead = el('thead');
        var hr = el('tr');
        header.forEach(function (h) {
          var th = el('th', profile.required.indexOf(h) >= 0 ? 'ext-req' : null, h);
          if (X.SOURCE_COLUMNS.indexOf(h) >= 0) th.className = 'ext-src';
          hr.appendChild(th);
        });
        thead.appendChild(hr);
        table.appendChild(thead);

        var tbody = el('tbody');
        var drawn = Math.min(rows.length, MAX_DRAWN);
        for (var r = 0; r < drawn; r++) {
          (function (index) {
            var tr = el('tr');
            header.forEach(function (h) {
              var editable = X.SOURCE_COLUMNS.indexOf(h) < 0;
              var td = el('td', blanks[index + '/' + h] ? 'ext-blank' : null);
              if (!editable) td.className = (td.className ? td.className + ' ' : '') + 'ext-src';
              td.textContent = rows[index][h];
              if (editable) {
                td.contentEditable = 'true';
                td.spellcheck = false;
                td.addEventListener('blur', function () {
                  var v = td.textContent.trim();
                  if (v === rows[index][h]) return;
                  rows[index][h] = v;
                  /* Only this cell's shading and the counters can have changed.
                     Redrawing the whole table instead would throw away the
                     caret, so tabbing along a row filling in blanks -- which is
                     the entire reason these cells are editable -- would land
                     somewhere else after every entry. */
                  td.classList.toggle('ext-blank',
                    profile.required.indexOf(h) >= 0 && v === '');
                  renderStatus();
                  publish();
                });
              }
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          }(r));
        }
        table.appendChild(tbody);
        grid.appendChild(table);

        if (rows.length > drawn) {
          grid.appendChild(el('p', 'ext-more micro',
            '還有 ' + (rows.length - drawn) + ' 列沒有畫出來（畫面上限 ' + MAX_DRAWN +
            ' 列）。匯出的試算表會是完整的。'));
        }
      }

      /**
       * The filing plan, as a table: what each document is called now, what it
       * would be called, which bin it lands in, and why it landed there.
       *
       * The "why" column is the one that earns its place. A document in the
       *待確認 bin with no explanation is a document somebody has to open and
       * compare by hand.
       */
      function renderPreview() {
        var head = el('div', 'ext-note');
        head.appendChild(el('h3', null,
          '交付計畫：完成 ' + preview.finished + ' 份、待確認 ' + preview.unsure + ' 份'));
        head.appendChild(el('p', 'micro',
          '還沒有動到任何檔案。按下面的「確認交付」之後，系統會再列出每一個搬移讓你核可一次。\n' +
          '去處：\n' + preview.dirs.map(function (d) { return '　' + d; }).join('\n')));
        head.querySelector('p').style.whiteSpace = 'pre-wrap';
        grid.appendChild(head);

        var table = el('table', 'ext-table');
        var thead = el('thead');
        var hr = el('tr');
        ['原檔名', '新檔名', '去處', '列數', '原因'].forEach(function (h) {
          hr.appendChild(el('th', null, h));
        });
        thead.appendChild(hr);
        table.appendChild(thead);

        var tbody = el('tbody');
        preview.plan.forEach(function (e) {
          var tr = el('tr', e.status === 'finished' ? null : 'ext-row-unsure');
          tr.appendChild(el('td', null, e.name));
          tr.appendChild(el('td', e.newName === e.name ? 'ext-src' : null, e.newName));
          tr.appendChild(el('td', 'ext-src', e.dir));
          tr.appendChild(el('td', 'ext-src', String(e.rows)));
          tr.appendChild(el('td', e.reason ? 'ext-why' : null, e.reason || ''));
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        grid.appendChild(table);
      }

      function note(title, body) {
        var n = el('div', 'ext-note');
        n.appendChild(el('h3', null, title));
        if (body) {
          var p = el('p', 'micro');
          p.style.whiteSpace = 'pre-wrap';
          p.textContent = body;
          n.appendChild(p);
        }
        return n;
      }

      function renderStatus() {
        var bits = [];
        if (service) {
          bits.push(service.configured
            ? (service.mode === 'service' ? '服務：' + service.base : '模型：' + service.model)
            : '⚠ 萃取模型還沒設定');
        }
        bits.push(docs.length + ' 份文件');
        bits.push(rows.length + ' 列');
        if (profile) {
          var blanks = X.requiredBlanks(rows, profile);
          if (blanks.length) bits.push('必填未填 ' + blanks.length + ' 格');
          else if (rows.length) bits.push('必填齊了');
        }
        status.textContent = bits.join('　·　');
        status.className = 'ext-status' + (service && !service.configured ? ' ext-warn' : '');

        btnExport.disabled = !rows.length || !!preview;
        btnCancelPlan.hidden = !preview;
        btnDeliver.textContent = preview ? '確認交付（' + preview.plan.length + '）' : '交付歸檔';
        btnDeliver.disabled = !docs.length || busy;
        btnRun.disabled = busy || !docs.some(function (d) {
          return d.status === 'queued' || d.status === 'failed';
        });
      }

      function renderAll() {
        renderDocs();
        renderGrid();
        renderStatus();
        publish();
      }

      function publish() {
        if (!profile && !docs.length) { ctx.publish(null); return; }
        ctx.publish(X.describe({
          profile: profile, rows: rows,
          files: docs.map(function (d) { return d.path; }),
          deliverTo: profile ? profile.deliver : ''
        }), '文件萃取');
      }

      /* -------------------------------------------------- model settings */

      async function refreshService() {
        var r = await A.extract.state();
        service = r && r.ok ? r.data : null;
        renderStatus();
        return service;
      }

      function renderSettings() {
        settings.innerHTML = '';
        var s = service || {};

        var h = el('div', 'ext-set-head');
        h.appendChild(el('h3', null, '這支程式的萃取模型'));
        var back = btn('回到作業', null, 'fbtn ext-go');
        back.addEventListener('click', function () { showPage('work'); });
        h.appendChild(back);
        settings.appendChild(h);

        settings.appendChild(el('p', 'micro',
          '跟系統的核心模型是兩回事：這裡設的端點與金鑰只有這支程式會用，' +
          '系統那邊的設定也不會動到這裡。\n' +
          '⚠ 解析時文件原檔會上傳到這裡設定的服務。不想讓它送出去，可以在能力閘門把 doc.extract 設成 DENY。'));

        var form = el('div', 'ext-form');

        var mode = field(form, '模式', 'select', s.mode || 'gemini', [
          { value: 'gemini', label: '雲端模型（PDF 直送，例如 Gemini）' },
          { value: 'service', label: '解析服務（你自己跑的萃取 API）' }
        ]);
        var base = field(form, '端點位址', 'text', s.base || '');
        base.input.placeholder = (s.defaults && s.defaults.base) || 'https://…';
        var model = field(form, '模型名稱', 'text', s.model || '');
        model.input.placeholder = (s.defaults && s.defaults.model) || 'gemini-2.5-pro';
        var auth = field(form, '驗證方式', 'select', s.auth || 'goog', [
          { value: 'goog', label: 'x-goog-api-key（Google）' },
          { value: 'bearer', label: 'Authorization: Bearer（OpenAI 相容）' },
          { value: 'apikey', label: 'X-API-Key' },
          { value: 'none', label: '不帶金鑰（用下面的自訂表頭）' }
        ]);
        var key = field(form, 'API 金鑰', 'password', '');
        key.input.placeholder = s.hasKey ? '（已設定，留白就不更動）' : '貼上金鑰';

        function syncMode() {
          model.row.hidden = mode.input.value !== 'gemini';
        }
        mode.input.addEventListener('change', syncMode);
        syncMode();

        settings.appendChild(form);

        /* Custom headers, the same shape the core model's provider takes: a
           gateway in front of a model wants a header nobody can predict, and a
           value that cannot be shown back must not be wiped by saving the form. */
        var hdrWrap = el('div', 'ext-headers');
        hdrWrap.appendChild(el('h4', null, '自訂表頭'));
        hdrWrap.appendChild(el('p', 'micro',
          '每一列都會加到送出的請求上。值存起來之後就讀不回來了，留白代表「不要動它」，' +
          '要刪掉就把整列移除。'));
        var hdrList = el('div', 'ext-header-list');
        hdrWrap.appendChild(hdrList);

        function addHeaderRow(name, hasValue) {
          var row = el('div', 'ext-header-row');
          var n = el('input', 'ext-input');
          n.value = name || '';
          n.placeholder = '表頭名稱';
          n.setAttribute('aria-label', '表頭名稱');
          var v = el('input', 'ext-input');
          v.type = 'password';
          v.placeholder = hasValue ? '（已設定，留白就不更動）' : '值';
          v.setAttribute('aria-label', '表頭的值');
          var del = btn('×', '移除這一列', 'ext-mini');
          del.addEventListener('click', function () { hdrList.removeChild(row); });
          row.appendChild(n);
          row.appendChild(v);
          row.appendChild(del);
          hdrList.appendChild(row);
          return row;
        }
        (s.headerNames || []).forEach(function (n) { addHeaderRow(n, true); });
        var addHdr = btn('加一列表頭', null, 'ext-mini');
        addHdr.addEventListener('click', function () { addHeaderRow('', false); });
        hdrWrap.appendChild(addHdr);
        settings.appendChild(hdrWrap);

        var acts = el('div', 'ext-set-acts');
        var save = btn('儲存', null, 'fbtn ext-go');
        var test = btn('測試連線', '問一下端點，看設定對不對');
        var forget = btn('清除金鑰', '把金鑰與表頭的值都忘掉');
        acts.appendChild(save);
        acts.appendChild(test);
        acts.appendChild(forget);
        settings.appendChild(acts);

        var out = el('p', 'ext-set-out micro');
        settings.appendChild(out);

        if (s.sealed === false) {
          var warn = el('p', 'ext-set-out ext-warn micro',
            '⚠ 這台機器沒有作業系統金鑰保管庫，金鑰只會留在這次執行期間，不會寫進磁碟。');
          settings.appendChild(warn);
        }

        save.addEventListener('click', async function () {
          out.textContent = '儲存中…';
          try {
            var c = await A.extract.configure({
              mode: mode.input.value,
              base: base.input.value.trim(),
              model: model.input.value.trim(),
              auth: auth.input.value
            });
            if (!c || !c.ok) throw new Error((c && c.error) || '存不起來');

            var headers = [];
            hdrList.querySelectorAll('.ext-header-row').forEach(function (row) {
              var ins = row.querySelectorAll('input');
              if (ins[0].value.trim()) headers.push({ name: ins[0].value.trim(), value: ins[1].value });
            });
            var k = await A.extract.setSecret(key.input.value, headers);
            if (!k || !k.ok) throw new Error((k && k.error) || '金鑰存不起來');

            service = k.data;
            key.input.value = '';
            out.textContent = '存好了。';
            out.className = 'ext-set-out micro';
            renderSettings();
            renderStatus();
          } catch (e) {
            out.textContent = e.message || String(e);
            out.className = 'ext-set-out ext-warn micro';
          }
        });

        test.addEventListener('click', async function () {
          out.textContent = '測試中…';
          out.className = 'ext-set-out micro';
          var r = await A.extract.probe();
          if (r && r.ok && r.data.ok) {
            out.textContent = '連上了' + (r.data.model ? '：' + r.data.model : '') +
              (r.data.detail ? '（' + r.data.detail + '）' : '');
          } else {
            out.textContent = '連不上：' + ((r && r.ok ? r.data.reason : r && r.error) || '不明原因');
            out.className = 'ext-set-out ext-warn micro';
          }
        });

        forget.addEventListener('click', async function () {
          var yes = await ctx.confirm({
            label: '忘掉萃取模型的金鑰？',
            note: '金鑰與所有自訂表頭的值都會刪掉，端點與模型名稱留著。',
            okLabel: '忘掉',
            danger: true
          });
          if (!yes) return;
          var r = await A.extract.forgetSecret();
          if (r && r.ok) { service = r.data; renderSettings(); renderStatus(); }
        });
      }

      function field(form, label, type, value, options) {
        var row = el('label', 'ext-field');
        row.appendChild(el('span', 'ext-field-label', label));
        var input;
        if (type === 'select') {
          input = el('select', 'ext-input');
          (options || []).forEach(function (o) {
            var opt = el('option', null, o.label);
            opt.value = o.value;
            input.appendChild(opt);
          });
          input.value = value;
        } else {
          input = el('input', 'ext-input');
          input.type = type;
          input.value = value;
        }
        row.appendChild(input);
        form.appendChild(row);
        return { row: row, input: input };
      }

      function showPage(which) {
        page = which;
        var onWork = which === 'work';
        bar.hidden = !onWork;
        work.hidden = !onWork;
        foot.hidden = !onWork;
        settings.hidden = onWork;
        if (!onWork) renderSettings();
        ctx.save();
      }

      /* ----------------------------------------------------------- wiring */

      btnReload.addEventListener('click', async function () {
        await AIOS.afterFsChange();
        await loadProfiles();
        ctx.toast('讀到 ' + profiles.length + ' 個設定', 't-ok');
      });
      btnNew.addEventListener('click', function () { makeTemplate(); });
      btnModel.addEventListener('click', async function () {
        await refreshService();
        showPage('settings');
      });

      pick.addEventListener('change', function () {
        var i = Number(pick.value);
        profile = profiles[i] ? profiles[i].parsed.profile : null;
        renderAll();
        ctx.save();
      });

      btnAdd.addEventListener('click', async function () {
        var p = await AIOS.openPath({
          host: ctx.win && ctx.win.el,
          label: '加入要解析的文件',
          note: '只吃得下 PDF。要一次加很多份，可以從檔案總管把它們拖進這個視窗。',
          filter: function (f) { return /\.pdf$/i.test(f.vpath); },
          preview: false
        });
        if (p) await addDocs([p]);
      });

      btnRun.addEventListener('click', async function () {
        try {
          var note2 = await runAll();
          ctx.toast(note2, 't-ok');
        } catch (e) {
          ctx.toast(e.message || String(e), 't-err');
        }
      });

      btnStop.addEventListener('click', function () {
        stop = true;
        ctx.toast('解析完這一份就停', 't-info');
      });

      btnExport.addEventListener('click', async function () {
        try { ctx.toast(await exportSheet(null), 't-ok'); }
        catch (e) { ctx.toast(e.message || String(e), 't-err'); }
      });

      /* Two presses on purpose. The first builds the plan and draws it; the
         second carries it out, and only then does the gate get asked. Nobody
         should be approving fifty file moves they have not seen laid out. */
      btnDeliver.addEventListener('click', async function () {
        try {
          if (!preview) {
            var p = previewDelivery();
            ctx.toast('這是計畫，還沒動到檔案：完成 ' + p.finished + '、待確認 ' + p.unsure, 't-info');
            return;
          }
          ctx.toast(await deliver(), 't-ok');
        } catch (e) {
          ctx.toast(e.message || String(e), 't-err');
        }
      });

      btnCancelPlan.addEventListener('click', function () {
        preview = null;
        renderAll();
      });

      /* Files dropped from the operating system. The bridge is the only thing
         that can turn a dropped File into a path, and it only answers for
         objects the OS actually handed to this window. */
      ctx.body.addEventListener('dragover', function (e) { e.preventDefault(); });
      ctx.body.addEventListener('drop', async function (e) {
        e.preventDefault();
        var files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
        if (!files.length) return;
        var outside = files.map(function (f) { return A.pathForFile(f); }).filter(Boolean);
        if (!outside.length) return;
        var into = '/inbox';
        var r = await A.user.importPaths(outside, into);
        if (!r || !r.ok) { ctx.toast('匯入失敗：' + ((r && r.error) || ''), 't-err'); return; }
        await AIOS.afterFsChange();
        var added = (r.data.files || r.data.imported || []).map(function (f) {
          return typeof f === 'string' ? f : f.vpath;
        }).filter(function (v) { return /\.pdf$/i.test(v || ''); });
        await addDocs(added);
        ctx.toast('匯入 ' + added.length + ' 份 PDF 到 ' + into, 't-ok');
      });

      ctx.setMenu(function () {
        return [
          { label: '重新讀取萃取設定', run: function () { loadProfiles(); } },
          { label: '新增萃取設定…', run: function () { makeTemplate(); } },
          { label: '模型設定…', run: async function () { await refreshService(); showPage('settings'); } },
          { separator: true },
          { label: '匯出試算表…', run: function () { btnExport.click(); } },
          { label: '交付歸檔…', run: function () { btnDeliver.click(); } }
        ];
      });

      ctx.describe(function () {
        return X.describe({
          profile: profile, rows: rows,
          files: docs.map(function (d) { return d.path; }),
          deliverTo: profile ? profile.deliver : ''
        });
      });

      /* Everything an action can call. There is a wiring test that reads the
         actions above, collects every method they reach for on this object, and
         fails if one of them is not here -- so an action can never be published
         with nothing behind it. */
      ctx.api = {
        useProfile: useProfile,
        addDocs: addDocs,
        runAll: runAll,
        exportSheet: exportSheet,
        previewDelivery: previewDelivery,
        deliver: deliver,
        clearAll: clearAll,
        reload: loadProfiles
      };

      (async function start() {
        await refreshService();
        await loadProfiles();
        if (ctx.arg) await addDocs([ctx.arg]);
        showPage('work');
      }());

      return {
        getState: function () {
          return { profileVpath: profile ? profile.vpath : '', page: page };
        },
        onClose: function () { stop = true; ctx.publish(null); }
      };
    }
  });
})();
