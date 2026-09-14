'use strict';

/* ===========================================================================
   AI-OS // 文件萃取
   ---------------------------------------------------------------------------
   Pick a document type and a vendor, add some PDFs, press parse, check the
   table, file the documents. That is the whole program, and it is deliberately
   the whole program: the people who use this are doing the same job dozens of
   times a day, and every extra decision on the screen is a decision they have
   to make dozens of times.

   THE STUDIO IS WHERE THE WORK IS DEFINED

   The list of document types, the list of vendors, the column layout for each
   and the tuned extraction prompts all live in the prompt studio and arrive
   from it. Nothing here is maintained per machine, because a vendor list
   maintained in fourteen copies is fourteen vendor lists. The window is a
   window: it shows what the studio said, hands it the documents, and files what
   comes back.

   AND THE FALLBACK IS A FALLBACK

   When the studio cannot be reached, a cloud model can be called directly with
   a prompt kept on this machine. That path is not equal to the first one and
   the window never pretends otherwise: the banner names the engine and the
   reason, the batch is bound to whichever engine started it, and every exported
   row carries a 「_來源」 column so a spreadsheet sitting in somebody's mailbox
   a month later can still answer which engine produced it.

   Falling back happens when a window opens, never in the middle of a batch.
   Half a result from each engine would have two column sets, two notions of
   which fields are mandatory and two naming conventions, and nothing on the
   page would say so.

   AND ONLY WHEN THE STUDIO IS ACTUALLY UNREACHABLE

   A 401 is a wrong key. A 500 is a bug in the studio. Neither is a reason to
   spend somebody's other quota and bury the fault, so those stop with the
   service's own words on screen. See resolve() in app/main/extract.js.

   WHAT ACTUALLY HAPPENS TO A DOCUMENT

   It is uploaded whole. Not turned into text first: the numbers in a delivery
   note live in a layout, and flattening the layout destroys the association
   between a part number and the quantity printed beside it. Tried, measured,
   worse.

   THE ROWS ARE UNTRUSTED

   They came out of documents that arrived from outside. The main process marks
   the session tainted when it reads one, the summary published to the kernel
   reports counts and column names but never a cell value, and the filing step
   asks the gate about the whole batch at once -- one informed answer covering
   fifty moves rather than fifty dialogs nobody reads by the ninth.
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

  /* How often to ask the studio how a batch is getting on. Two seconds is what
     their own console uses, and it is the right order: a person is watching. */
  var POLL_MS = 2000;

  /* Give up only when nothing has moved for this long, not on total elapsed
     time. A batch of forty documents legitimately runs for twenty minutes, and
     a clock-based ceiling would abandon a job that is working fine. */
  var POLL_STALL_MS = 6 * 60 * 1000;

  /* One 502 from a reverse proxy is not the studio going away. The job on the
     server is untouched by a failed poll, so a few in a row are tolerated
     before the batch is declared lost. */
  var POLL_TOLERATE = 3;

  /* What one upload may weigh. Checked before anything is read, so the answer
     to "too big" arrives before the wait rather than after it. */
  var MAX_BATCH_BYTES = 180 * 1024 * 1024;

  /* Above this many rows the table is summarised rather than drawn. A grid with
     ten thousand editable cells stops being a grid and starts being the reason
     the window will not scroll. */
  var MAX_DRAWN = 2000;

  var AUTO = '自動判別';

  AIOS.apps.register({
    id: 'extract',
    name: '文件萃取',
    icon: '✇',
    kind: 'EXT',
    width: 1100,
    height: 700,
    singleton: true,
    purpose: '把 PDF 交給提示詞工作室萃取成表格資料，再歸檔',
    chatHint: '可以說「用進貨單、大同解析 /inbox 裡的兩份 PDF」或「把結果匯出成試算表」。',

    /* No `accepts`, deliberately. Double-clicking a PDF means "let me read
       this", and `forPath` takes the first registered program that claims the
       extension -- so claiming .pdf here would put this window one script-order
       change away from silently replacing the viewer for every PDF on the
       machine. Launching it with a path still works (the dock, an action, a
       drop), it just never becomes the default answer for a document. */

    actions: {
      use: {
        args: '{category, vendor}', desc: '選文件大類與廠商（廠商留白代表自動判別）',
        run: async function (args, ctx) {
          return { note: await ctx.api.choose(args.category, args.vendor) };
        }
      },
      add: {
        args: '{paths}', desc: '把沙箱裡的 PDF 加進待解析清單',
        run: async function (args, ctx) {
          var list = Array.isArray(args.paths) ? args.paths
            : String(args.paths || '').split(/[,\n]/).map(function (s) { return s.trim(); });
          return { note: await ctx.api.addDocs(list.filter(Boolean)) };
        }
      },
      run: {
        args: '{}', desc: '把清單裡的文件送去解析',
        run: async function (args, ctx) { return { note: await ctx.api.runAll() }; }
      },
      export: {
        args: '{path}', desc: '把結果寫成試算表檔（.xlsx）',
        run: async function (args, ctx) { return { note: await ctx.api.exportSheet(args.path) }; }
      },
      deliver: {
        args: '{}', desc: '依命名規則把文件歸檔（會先列出整批請你確認）',
        run: async function (args, ctx) { return { note: await ctx.api.deliver() }; }
      },
      sync: {
        args: '{}', desc: '跟工作室重新同步大類、廠商、欄位與提示詞',
        run: async function (args, ctx) { return { note: await ctx.api.sync() }; }
      },
      resume: {
        args: '{jobId}', desc: '把沒收尾的批次從工作室接回來',
        run: async function (args, ctx) { return { note: await ctx.api.resumeJob(args.jobId) }; }
      },
      clear: {
        args: '{}', desc: '清掉目前的文件與結果',
        run: async function (args, ctx) { return { note: await ctx.api.clearAll() }; }
      }
    },

    mount: function (ctx) {
      /* ------------------------------------------------------------ state */

      var saved = ctx.state || {};
      var svc = null;                 // what app/main/extract.js reports
      var mode = 'none';
      var modeReason = '還沒判定';
      var degraded = false;

      var catalog = { categories: [], vendors: {}, schemas: {}, identities: {}, prompts: {}, at: 0, base: '' };
      var category = saved.category || '';
      var vendor = saved.vendor || '';
      var auto = !!saved.auto;

      var profile = null;             // the shape everything downstream works on
      var profileIssues = null;
      var localProfiles = [];         // fallback: [{vpath, parsed}]

      var docs = [];                  // [{path, name, bytes, status, rows, error, vendor, tokens}]
      var rows = [];
      var failedFiles = [];           // what the studio could not read
      var batch = null;               // {token, which, jobId, label, at, columns, schemaLabel, renameField}
      var preview = null;

      var busy = false;
      var stop = false;
      var syncing = false;
      var syncJob = null;   // the one in flight, so a second caller can wait for it
      /* The opening sequence, as something that can be waited for. ctx.api is
         published before it finishes, so anything reached from outside -- an
         action, a menu item, a test -- can arrive while the mode is still
         unresolved and get an answer computed from 'none'. */
      var booted = null;
      var page = 'work';
      /* A job the studio may still be holding. It outlives this window: the
         studio does the work and charges for it whether or not anybody is
         watching, so losing the id is losing the result. */
      var orphan = String(saved.jobId || '');

      /* ---------------------------------------------------------------- UI */

      ctx.body.classList.add('ext');

      var banner = el('div', 'ext-banner');
      ctx.body.appendChild(banner);

      var bar = el('div', 'ext-bar');
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
      var btnDeliver = btn('交付歸檔', '依命名規則改名，分別歸到完成與待確認兩個資料夾', 'fbtn ext-go');
      foot.appendChild(btnExport);
      foot.appendChild(btnCancelPlan);
      foot.appendChild(btnDeliver);
      ctx.body.appendChild(foot);

      /* --------------------------------------------------- the studio, read */

      /** A read. Carries nothing out; see the path allowlist in ipc.js. */
      async function ask(path, query) {
        var r = await A.extract.call({ method: 'GET', path: path, query: query });
        if (!r || !r.ok) {
          throw Object.assign(new Error((r && r.error) || '讀取失敗'), { code: (r && r.code) || 'EFAIL' });
        }
        return r.data.json;
      }

      /** A write: documents, or rows on their way back for a naming plan. */
      async function give(path, spec) {
        var r = await A.extract.upload(Object.assign({ method: 'POST', path: path }, spec || {}));
        if (!r || !r.ok) {
          throw Object.assign(new Error((r && r.error) || '送出失敗'), { code: (r && r.code) || 'EFAIL' });
        }
        return r.data.json;
      }

      function enc(s) { return encodeURIComponent(String(s || '')); }

      function readCatalog(raw) {
        var c = raw || {};
        return {
          at: Number(c.at) || 0,
          base: String(c.base || ''),
          categories: Array.isArray(c.categories) ? c.categories : [],
          vendors: c.vendors || {},
          schemas: c.schemas || {},
          identities: c.identities || {},
          prompts: c.prompts || {}
        };
      }

      /**
       * Fetch everything the studio knows, and keep it.
       *
       * Tried as one call first. The studio is growing a `/catalog` endpoint
       * that hands over its whole catalogue including the prompts, which is what
       * makes working offline possible at all: the per-item calls below cannot
       * supply a prompt, so a machine that has only ever used them can list the
       * vendors while being unable to extract for any of them. A 404 means an
       * older studio, not a failure, and the per-item path runs instead.
       */
      async function sync() {
        await booted;
        /* A second caller gets the one already running rather than a sentence
           saying so. The window starts a sync by itself on a first run, and an
           action that pressed 同步 a moment later would otherwise return
           immediately and have its caller carry on against an empty catalogue. */
        if (syncJob) return syncJob;
        if (mode === 'none') await refreshMode(false);
        if (mode !== 'service') return '現在連不上工作室，沒有東西可以同步';
        syncJob = runSync().finally(function () { syncJob = null; });
        return syncJob;
      }

      async function runSync() {
        syncing = true;
        renderStatus();
        var patch = { categories: [], vendors: {}, schemas: {}, identities: {}, prompts: {} };
        var prompts = 0;
        try {
          var bulk = null;
          try {
            bulk = await ask('/catalog');
          } catch (e) {
            // The expected answer from a studio that has not grown it yet.
            if (e.code !== 'EREMOTE') throw e;
          }

          if (bulk && Array.isArray(bulk.categories)) {
            bulk.categories.forEach(function (c) {
              var name = String((c && c.name) || c || '');
              if (!name) return;
              patch.categories.push(name);
              if (c && c.identities) patch.identities[name] = c.identities;
              var vs = Array.isArray(c && c.vendors) ? c.vendors : [];
              patch.vendors[name] = vs.map(function (v) {
                return String((v && v.name) || v || '');
              }).filter(Boolean);
              vs.forEach(function (v) {
                if (!v || !v.name) return;
                if (v.schema) patch.schemas[name + '/' + v.name] = v.schema;
                if (v.prompt) { patch.prompts[name + '/' + v.name] = String(v.prompt); prompts++; }
              });
              if (c && c.schema) patch.schemas[name + '/'] = c.schema;
            });
          } else {
            var cats = (await ask('/categories')).categories || [];
            patch.categories = cats.map(String);
            for (var i = 0; i < patch.categories.length; i++) {
              var c2 = patch.categories[i];
              var vs2 = (await ask('/categories/' + enc(c2) + '/vendors')).vendors || [];
              patch.vendors[c2] = vs2.map(String);
              try {
                patch.identities[c2] = await ask('/categories/' + enc(c2) + '/identities');
              } catch (e2) { /* an older studio, or a category with no identities */ }
              patch.schemas[c2 + '/'] = await ask('/categories/' + enc(c2) + '/schema');
              for (var k = 0; k < patch.vendors[c2].length; k++) {
                var v2 = patch.vendors[c2][k];
                var key = c2 + '/' + v2;
                patch.schemas[key] = await ask('/categories/' + enc(c2) + '/vendors/' + enc(v2) + '/schema');
                /* Reserved. The studio does not serve prompts yet; when it does,
                   this is what lets the fallback cover this vendor at all. */
                try {
                  var pr = await ask('/categories/' + enc(c2) + '/vendors/' + enc(v2) + '/prompt');
                  var text = String((pr && (pr.prompt || pr.text)) || '');
                  if (text) { patch.prompts[key] = text; prompts++; }
                } catch (e3) { /* not offered; the banner says which vendors are uncovered */ }
                renderStatus();
              }
            }
          }

          var wrote = await A.extract.saveCatalog(patch);
          if (wrote && wrote.ok) catalog = readCatalog(wrote.data);
          await refreshLocalProfiles();
          if (!category && catalog.categories.length) category = catalog.categories[0];
          pickDefaultVendor();
          buildProfile();
          renderAll();
          return '同步好了：' + patch.categories.length + ' 個大類、' +
            Object.keys(patch.schemas).length + ' 組欄位' +
            (prompts ? '、' + prompts + ' 份提示詞' : '；工作室還沒提供提示詞，備援要靠本機設定檔');
        } finally {
          syncing = false;
          renderStatus();
        }
      }

      /* ---------------------------------------------------- mode and shape */

      async function refreshMode(force) {
        var was = mode + '|' + modeReason;
        /* Rescan the local profiles first. They were read once at boot and once
           after a successful sync, which meant a profile written while this
           window was open stayed invisible: the banner went on naming a vendor
           as uncovered after somebody had just covered it, and pressing
           「重新連線」 -- the one button whose whole job is "look again" --
           changed nothing. The directory holds a handful of small files and
           this runs on an explicit refresh, not on a timer. */
        if (force) await refreshLocalProfiles();
        var s = await A.extract.state();
        svc = s && s.ok ? s.data : null;
        var r = await A.extract.resolve(!!force);
        if (r && r.ok) {
          mode = r.data.mode;
          modeReason = r.data.reason;
          degraded = !!r.data.degraded;
        } else {
          mode = 'none';
          modeReason = (r && r.error) || '判不出可用的後端';
          degraded = false;
        }
        /* Redraw here rather than leaving it to whoever called. A banner that
           lags the truth is the one failure this banner exists to prevent: it
           would name an engine that is no longer the one about to run. The
           picker and the profile only follow when no batch is in flight, since
           a batch is bound to the engine that started it. */
        if (was !== mode + '|' + modeReason) {
          if (!batch && page === 'work') buildProfile();
          if (page === 'work') renderAll();
        }
        return mode;
      }

      async function loadCatalog() {
        var r = await A.extract.catalog();
        catalog = readCatalog(r && r.ok ? r.data : null);
        if (!category && catalog.categories.length) category = catalog.categories[0];
        pickDefaultVendor();
      }

      function vendorsOf(cat) {
        var v = catalog.vendors[cat];
        return Array.isArray(v) ? v : [];
      }

      function autoOffered(cat) {
        /* Telling one vendor's paperwork from another is what the studio's
           identity rules are for, so the fallback cannot do it -- and offering a
           choice that can only ever answer "no" is worse than not offering it. */
        if (mode !== 'service') return false;
        var id = catalog.identities[cat];
        return !!(id && Array.isArray(id.auto_detectable) && id.auto_detectable.length);
      }

      function pickDefaultVendor() {
        var list = vendorsOf(category);
        if (auto && autoOffered(category)) { vendor = ''; return; }
        if (list.indexOf(vendor) >= 0) return;
        vendor = list.length ? list[0] : '';
        auto = false;
      }

      /** The profile everything downstream works on, whichever engine is live. */
      function buildProfile() {
        profileIssues = null;
        if (mode === 'fallback') {
          if (auto) { auto = false; pickDefaultVendor(); }
          var local = fallbackProfile();
          if (local) {
            profile = local.parsed.profile;
            profileIssues = local.parsed;
            return;
          }
          /* No hand-written file, but the columns came down with the last sync
             and are still good. Showing them beats showing nothing: the operator
             can see what this combination produces, and the only thing actually
             missing -- the prompt -- is reported when they press parse. */
          buildProfileFromCache(catalog.prompts[category + '/' + vendor] || '');
          return;
        }
        var schema = catalog.schemas[category + '/' + (auto ? '' : vendor)] ||
          catalog.schemas[category + '/'] || null;
        if (!schema) { profile = null; return; }
        var built = X.fromSchema({
          category: category,
          vendor: auto ? '' : vendor,
          schema: schema,
          deliver: (svc && svc.deliver) || X.DELIVER_DEFAULT
        });
        profile = built.profile;
        profileIssues = built;
      }

      /**
       * The local profile covering the current selection, if there is one.
       *
       * Matched on category and vendor rather than on a filename: in fallback
       * mode the operator is still working on the same vendor. The engine
       * changed; the job did not.
       */
      function fallbackProfile() {
        var want = (category || '').toLowerCase();
        var whose = (vendor || '').toLowerCase();
        /* A vendor has to be named. A profile whose own vendor field is blank
           covers a whole category and is allowed; one belonging to a different
           vendor is not, whatever its category says. Being lenient here meant a
           leftover file for another vendor quietly supplied the prompt, which
           is the kind of wrong answer that looks entirely correct. */
        if (!whose) return null;
        var hit = localProfiles.filter(function (p) {
          var pr = p.parsed.profile;
          var c = (pr.category || '').toLowerCase();
          var v = (pr.vendor || '').toLowerCase();
          return (!want || !c || c === want) && (!v || v === whose);
        });
        var exact = hit.filter(function (p) {
          return (p.parsed.profile.vendor || '').toLowerCase() === whose;
        });
        return exact[0] || hit[0] || null;
      }

      /** Which vendors the fallback could actually cover, and which it could not. */
      function fallbackCoverage() {
        var covered = [];
        var bare = [];
        vendorsOf(category).forEach(function (v) {
          var byCache = catalog.prompts[category + '/' + v];
          var byFile = localProfiles.some(function (p) {
            var pr = p.parsed.profile;
            return (pr.vendor || '') === v && X.asText(pr.prompt).trim();
          });
          if (byCache || byFile) covered.push(v); else bare.push(v);
        });
        return { covered: covered, bare: bare };
      }

      /**
       * The prompt to use in fallback mode for the current selection.
       *
       * A prompt the studio handed over during a sync beats a hand-written file,
       * because it is the one the studio is actually using. Either way there has
       * to be one: a profile built from a schema has no prompt, and sending that
       * to a model asks it for correctly-shaped rows and nothing else.
       */
      function fallbackPrompt() {
        var cached = catalog.prompts[category + '/' + vendor];
        if (X.asText(cached).trim()) return String(cached);
        var local = fallbackProfile();
        return local ? X.asText(local.parsed.profile.prompt).trim() : '';
      }

      async function refreshLocalProfiles() {
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
        localProfiles = found;
      }

      async function choose(cat, who) {
        await booted;
        if (batch) throw new Error('這一批還沒結束，先清空再換大類或廠商');
        if (cat) {
          if (catalog.categories.indexOf(cat) < 0) {
            throw new Error('沒有「' + cat + '」這個大類。目前有：' +
              (catalog.categories.join('、') || '（還沒同步）'));
          }
          category = cat;
        }
        if (who === undefined || who === null || who === '' || who === AUTO) {
          auto = autoOffered(category);
          vendor = '';
          if (!auto) pickDefaultVendor();
        } else {
          if (vendorsOf(category).indexOf(who) < 0) {
            throw new Error('「' + category + '」底下沒有「' + who + '」。目前有：' +
              (vendorsOf(category).join('、') || '（還沒同步）'));
          }
          vendor = who;
          auto = false;
        }
        buildProfile();
        renderAll();
        ctx.save();
        return category + ' / ' + (auto ? AUTO : (vendor || '（未選）'));
      }

      /* --------------------------------------------------------- documents */

      async function addDocs(paths) {
        await booted;
        var added = 0;
        var dup = [];
        var same = [];
        (paths || []).forEach(function (raw) {
          var vpath = String(raw || '').trim();
          if (!vpath) return;
          if (docs.some(function (d) { return d.path === vpath; })) { dup.push(vpath); return; }
          var name = X.baseName(vpath);
          /* Two documents with one basename cannot both be named in a plan the
             studio sends back: it only ever saw basenames. Refused here, with
             the reason, rather than discovered at filing time as one document
             moved twice and another that vanished without a word. */
          if (docs.some(function (d) { return d.name === name; })) { same.push(name); return; }
          var entry = AIOS.fs.entry(vpath);
          docs.push({
            path: vpath, name: name,
            bytes: (entry && entry.bytes) || 0,
            status: 'queued', rows: 0, error: '', vendor: '', tokens: 0
          });
          added++;
        });
        preview = null;
        renderAll();
        var note2 = '加了 ' + added + ' 份';
        if (dup.length) note2 += '，' + dup.length + ' 份本來就在清單裡';
        if (same.length) {
          note2 += '；' + same.length + ' 份因為檔名和清單裡的重複沒有加（' +
            same.slice(0, 3).join('、') + '）。工作室只看得到檔名，同名分不出誰是誰。';
        }
        return note2;
      }

      function dropDoc(path) {
        var gone = docs.filter(function (d) { return d.path === path; })[0];
        docs = docs.filter(function (d) { return d.path !== path; });
        if (gone) rows = rows.filter(function (r) { return r[X.SOURCE_COLUMNS[0]] !== gone.name; });
        preview = null;
        renderAll();
      }

      async function clearAll() {
        if (batch) {
          /* A job the studio may still be working on outlives this list. Kept so
             the banner can offer it back rather than losing work already paid
             for. */
          if (batch.which === 'service' && batch.jobId && !rows.length) orphan = batch.jobId;
          await A.extract.endBatch(batch.token);
          batch = null;
        }
        docs = [];
        rows = [];
        failedFiles = [];
        preview = null;
        renderAll();
        ctx.save();
        return '清空了';
      }

      function totalBytes() {
        return docs.reduce(function (n, d) { return n + (d.bytes || 0); }, 0);
      }

      function mib(n) { return (n / 1048576).toFixed(1) + ' MiB'; }

      /* ----------------------------------------------------------- parsing */

      async function runAll() {
        await booted;
        if (syncJob) await syncJob.catch(function () {});
        if (busy) return '已經在解析了';

        var queue = docs.filter(function (d) {
          return d.status === 'queued' || d.status === 'failed';
        });
        if (!queue.length) return '沒有待解析的文件';

        /* Decide the engine once, here, and hold it for the whole batch. */
        if (!batch) await refreshMode(true);
        var which = batch ? batch.which : mode;
        if (which === 'none') throw new Error(modeReason);

        /* One job per batch, always. A second job would take over batch.jobId,
           and the filing plan is keyed to a job id -- so the documents from the
           first job could no longer be named or filed in the same pass. The way
           to retry is the studio's own retry, on the same job. */
        if (which === 'service' && batch && batch.jobId) {
          throw new Error('這一批已經有工作編號 ' + batch.jobId +
            ' 了。要再跑失敗的那幾份請按「重跑失敗的」，' +
            '重開一個工作會讓交付計畫對不上這一批。');
        }

        if (which === 'fallback') {
          /* Auto-detect is the studio's, and it is the studio's because telling
             one vendor's paperwork from another is what its identity rules are
             for. The fallback has one prompt and no way to choose between
             several, so running a mixed batch here would put one vendor's
             extraction rules over every document in it -- and the rows would
             come back looking perfectly reasonable. */
          if (auto) {
            throw new Error('備援模式沒辦法自動判別廠商，那是工作室的功能。\n' +
              '請先指定一家廠商，或等端點恢復。');
          }
          var prompt = fallbackPrompt();
          if (!prompt) {
            throw new Error(
              '備援模式需要一份提示詞，而「' + category + (vendor ? ' / ' + vendor : '') +
              '」還沒有。\n工作室目前沒有把提示詞交出來，所以這一家在端點掛掉時接不了。\n' +
              '可以在 ' + X.PROFILE_DIR + ' 底下建一份含提示詞的設定檔，或等端點恢復。');
          }
          var local = fallbackProfile();
          if (local && local.parsed.ok) {
            profile = local.parsed.profile;
            profileIssues = local.parsed;
          } else if (local) {
            throw new Error('「' + local.parsed.profile.name + '」這份本機設定有問題：\n　' +
              local.parsed.errors.join('\n　'));
          } else {
            /* No local file, but the studio did hand over a prompt during a
               sync. The columns come from the cached schema, the prompt from the
               cache: a complete profile without anybody maintaining a file. */
            buildProfileFromCache(prompt);
          }
          if (!profile) throw new Error('這個組合沒有可用的欄位設定');
        } else {
          if (!batch) buildProfile();
          if (!profile) throw new Error('還沒選好大類與廠商，或還沒跟工作室同步過');
          if (profileIssues && !profileIssues.ok) {
            throw new Error('這個組合的欄位設定有問題：\n　' + profileIssues.errors.join('\n　'));
          }
        }

        var weight = queue.reduce(function (n, d) { return n + (d.bytes || 0); }, 0);
        if (which === 'service' && weight > MAX_BATCH_BYTES) {
          throw new Error('這一批有 ' + mib(weight) + '，超過單次上傳的 ' +
            mib(MAX_BATCH_BYTES) + '。請先移掉幾份再送。');
        }

        if (!batch) {
          var bound = await A.extract.beginBatch(which);
          if (!bound || !bound.ok) throw new Error((bound && bound.error) || '無法開始這一批');
          batch = {
            token: bound.data.token,
            which: which,
            jobId: '',
            label: which === 'service'
              ? ((svc && svc.service && svc.service.label) || '提示詞工作室')
              : ((svc && svc.fallback && svc.fallback.model) || '備援模型'),
            at: Date.now(),
            columns: profile.columns.slice(),
            schemaLabel: profile.schemaLabel || '',
            renameField: ''
          };
        }

        busy = true;
        stop = false;
        renderAll();
        try {
          if (which === 'service') return await runViaStudio(queue);
          return await runViaFallback(queue);
        } finally {
          busy = false;
          stop = false;
          renderAll();
          ctx.save();
        }
      }

      /** Columns from the cached schema, prompt from the cached prompt. */
      function buildProfileFromCache(prompt) {
        var schema = catalog.schemas[category + '/' + vendor] || catalog.schemas[category + '/'];
        if (!schema) { profile = null; return; }
        var built = X.fromSchema({
          category: category, vendor: vendor, schema: schema,
          deliver: (svc && svc.deliver) || X.DELIVER_DEFAULT
        });
        built.profile.prompt = prompt;
        built.profile.source = 'cache';
        profile = built.profile;
        profileIssues = built;
      }

      /**
       * One job for the whole batch, the way the studio expects.
       *
       * Not one job per document: the studio's delivery plan is keyed to a job
       * id, so a batch split across several jobs cannot be filed in one pass.
       */
      async function runViaStudio(queue) {
        queue.forEach(function (d) { d.status = 'running'; d.error = ''; });
        renderAll();

        /* A free, local keyword check before anything is uploaded. Their console
           runs it on every submission, and the comment there records why: five
           material certificates once went out under the wrong document type and
           all five failed, discovered only afterwards. */
        var verdicts = [];
        try {
          var pre = await give('/classify', {
            paths: queue.map(function (d) { return d.path; }),
            fields: { category: category }
          });
          verdicts = (pre && pre.results) || [];
        } catch (e) { /* an older studio, or classify is off; not a reason to stop */ }

        var matched = verdicts.filter(function (v) { return v && v.status === 'matched'; });
        if (verdicts.length && !matched.length) {
          var why = '這一批在「' + category + '」底下一份都比對不到識別特徵。';
          if (auto) {
            queue.forEach(function (d) { d.status = 'queued'; });
            throw new Error(why + '自動判別沒有東西可以判，多半是大類選錯了。' +
              '\n換一個大類，或改成手動指定廠商。');
          }
          ctx.toast(why + '你已經指定了廠商所以還是送出去，但先確認大類對不對。', 't-warn');
        }
        verdicts.forEach(function (v) {
          var d = docs.filter(function (x) { return x.name === v.filename; })[0];
          if (d && v.vendor) d.vendor = v.vendor;
        });
        renderDocs();

        var made = await give('/jobs', {
          paths: queue.map(function (d) { return d.path; }),
          fields: { category: category, vendor: auto ? '' : vendor, owner: (svc && svc.owner) || '' }
        });
        var id = made && (made.job_id || made.id);
        if (!id) throw new Error('工作室沒有回傳工作編號');
        batch.jobId = String(id);
        ctx.save();

        var job = await pollJob(batch.jobId);
        return await collect(batch.jobId, job);
      }

      /**
       * Wait for a job, tolerantly.
       *
       * The give-up rule is no-progress rather than total elapsed: forty
       * documents legitimately take twenty minutes, and a clock would abandon a
       * job that is working. A few failed polls in a row are survivable too --
       * the job on the server is untouched by them.
       */
      async function pollJob(id) {
        var lastMoved = Date.now();
        var seen = -1;
        var misses = 0;
        for (;;) {
          if (stop) {
            throw new Error('已停止。工作還在工作室那邊（編號 ' + id + '），之後可以接回來。');
          }
          await new Promise(function (r) { setTimeout(r, POLL_MS); });

          var job;
          try {
            job = await ask('/jobs/' + enc(id));
            misses = 0;
          } catch (e) {
            misses++;
            if (misses > POLL_TOLERATE) throw e;
            continue;
          }

          var done = Number(job.done) || 0;
          var failed = Number(job.failed) || 0;
          var total = Number(job.total) || 0;
          (job.files || []).forEach(function (f) {
            var d = docs.filter(function (x) { return x.name === f.filename; })[0];
            if (!d) return;
            d.status = f.status === 'done' ? 'done' : (f.status === 'failed' ? 'failed' : 'running');
            d.error = String(f.error || '');
            d.tokens = Number(f.tokens) || 0;
            if (f.vendor) d.vendor = f.vendor;
          });
          renderDocs();
          renderStatus();

          /* A total of zero means nothing was accepted, not that everything
             finished. Without this guard `done + failed >= total` is 0 >= 0 on
             the first poll and an empty batch reports success. */
          if (total === 0) throw new Error('工作室沒有收下任何一份文件');
          if (Number(job.pending) === 0) return job;

          var moved = done + failed;
          if (moved !== seen) { seen = moved; lastMoved = Date.now(); }
          if (Date.now() - lastMoved > POLL_STALL_MS) {
            throw new Error('這個批次已經 ' + Math.round(POLL_STALL_MS / 60000) +
              ' 分鐘沒有進度了。工作還在工作室那邊（編號 ' + id + '），可以稍後接回來。');
          }
        }
      }

      /** Take the result, failures and all. */
      async function collect(id, job) {
        var res = await ask('/jobs/' + enc(id) + '/result', { flat: 'true' });

        /* The result's own column list wins over the schema's promise. In a
           mixed auto-detect batch a vendor may override the layout, and building
           the table from the promise instead of the delivery would shift every
           value into the wrong field without a word. */
        var got = X.withColumns(profile, (res && res.columns) || profile.columns);
        profile = got.profile;
        if (got.changed) {
          ctx.toast('工作室回傳的欄位順序和先前的設定不同，表格以回傳的為準。', 't-info');
        }
        batch.columns = profile.columns.slice();

        var adopted = X.adoptRows((res && res.rows) || [], profile, { source: batch.label });
        rows = adopted.rows;
        failedFiles = (res && res.failed_files) ||
          ((job && job.files) || []).filter(function (f) { return f.status === 'failed'; })
            .map(function (f) { return { filename: f.filename, error: f.error }; });

        docs.forEach(function (d) {
          var mine = rows.filter(function (r) { return r[X.SOURCE_COLUMNS[0]] === d.name; });
          d.rows = mine.length;
          if (d.status === 'running') d.status = mine.length ? 'done' : 'empty';
        });
        if (adopted.unnamed.length) {
          ctx.toast('有 ' + adopted.unnamed.length + ' 列沒有帶來源檔名，歸檔時會對不上。', 't-warn');
        }
        if (adopted.dropped.length) {
          ctx.toast('工作室多給了設定裡沒有的欄位：' + adopted.dropped.join('、'), 't-info');
        }

        /* Learn the naming field now, while the studio is reachable, so filing
           can still happen later if it is not. */
        try {
          var plan = await give('/jobs/' + enc(id) + '/package/preview', { json: { rows: rows } });
          batch.renameField = String((plan && plan.rename_field) || '');
        } catch (e) { /* filing falls back to the local rule; see buildPlan() */ }

        preview = null;
        renderAll();
        var note2 = '解析完成：' + rows.length + ' 列，來自 ' +
          docs.filter(function (d) { return d.rows; }).length + ' 份文件';
        if (failedFiles.length) note2 += '；' + failedFiles.length + ' 份失敗';
        var blanks = X.requiredBlanks(rows, profile);
        if (blanks.length) note2 += '；必填未填 ' + blanks.length + ' 格';
        return note2;
      }

      /**
       * Pick up a job this window lost track of.
       *
       * The studio keeps working through a batch whether or not anybody is
       * watching, and it charges for it either way. A network blip at minute
       * six of a twelve-minute job, a reload, a closed window -- without this,
       * all of that work is done, paid for, and unreachable.
       */
      async function resumeJob(id) {
        await booted;
        var jobId = String(id || orphan || '').trim();
        if (!jobId) throw new Error('沒有可以接回來的批次');
        if (busy) throw new Error('還在跑');
        await refreshMode(false);
        if (mode !== 'service') throw new Error('要接回批次得先連上工作室');
        buildProfile();
        if (!profile) throw new Error('先選好這一批當初用的大類與廠商，再接回來');

        var bound = await A.extract.beginBatch('service');
        if (!bound || !bound.ok) throw new Error((bound && bound.error) || '無法開始');
        batch = {
          token: bound.data.token, which: 'service', jobId: jobId,
          label: (svc && svc.service && svc.service.label) || '提示詞工作室',
          at: Date.now(), columns: profile.columns.slice(),
          schemaLabel: profile.schemaLabel || '', renameField: ''
        };
        busy = true;
        renderAll();
        try {
          var job = await ask('/jobs/' + enc(jobId));
          /* Put the document list back from what the studio remembers, so the
             rows have something to be filed against. Anything it names that
             this machine no longer has is reported by the plan, not guessed. */
          (job.files || []).forEach(function (f) {
            if (docs.some(function (d) { return d.name === f.filename; })) return;
            /* The studio only ever knew the basename, so finding the document
               again is a search of the sandbox. Exactly one match is the answer;
               none or several is said out loud rather than guessed at, because
               the wrong guess files somebody else's document. */
            var hits = AIOS.fs.paths().filter(function (v) { return X.baseName(v) === f.filename; });
            var where = hits.length === 1 ? hits[0] : '/inbox/' + f.filename;
            var entry = AIOS.fs.entry(where);
            var lost = hits.length !== 1
              ? (hits.length ? '沙箱裡有 ' + hits.length + ' 份同名檔案，認不出是哪一份'
                : '這台機器上找不到這個檔案了，結果還在但沒辦法歸檔')
              : '';
            docs.push({
              path: where, name: f.filename,
              bytes: (entry && entry.bytes) || 0,
              status: f.status === 'done' ? 'done' : (f.status === 'failed' ? 'failed' : 'running'),
              rows: 0, error: lost || String(f.error || ''),
              vendor: String(f.vendor || ''), tokens: 0
            });
          });
          if (Number(job.pending) > 0) job = await pollJob(jobId);
          orphan = '';
          var note2 = await collect(jobId, job);
          ctx.save();
          return '接回批次 ' + jobId + '：' + note2;
        } finally {
          busy = false;
          renderAll();
        }
      }

      /** Ask the studio to have another go at the ones that failed. */
      async function retryFailed() {
        if (!batch || !batch.jobId) throw new Error('沒有可以重跑的批次');
        if (batch.which !== 'service') throw new Error('這一批不是工作室跑的');
        if (busy) throw new Error('還在跑');
        busy = true;
        renderAll();
        try {
          var r = await give('/jobs/' + enc(batch.jobId) + '/retry', {});
          var n = Number(r && r.requeued) || 0;
          if (!n) return '工作室說沒有需要重跑的';
          rows = [];
          preview = null;
          failedFiles = [];
          docs.forEach(function (d) { if (d.status === 'failed') d.status = 'running'; });
          renderAll();
          var job = await pollJob(batch.jobId);
          return await collect(batch.jobId, job);
        } finally {
          busy = false;
          renderAll();
        }
      }

      /** One document at a time, with a prompt from this machine. */
      async function runViaFallback(queue) {
        var ok = 0;
        var bad = 0;
        var prompt = X.promptFor(profile);
        for (var i = 0; i < queue.length; i++) {
          if (stop) break;
          var doc = queue[i];
          doc.status = 'running';
          doc.error = '';
          renderDocs();
          ctx.toast('解析中 ' + (i + 1) + '/' + queue.length + '：' + doc.name, 't-info');
          try {
            var r = await A.extract.send({
              path: doc.path,
              prompt: prompt,
              columns: profile.columns,
              mimeType: 'application/pdf'
            });
            if (!r || !r.ok) throw new Error((r && r.error) || '送出失敗');
            rows = rows.filter(function (x) { return x[X.SOURCE_COLUMNS[0]] !== doc.name; });
            var norm = X.normalise(r.data.rows, profile, {
              filename: doc.name, vendor: profile.vendor || vendor,
              startAt: rows.length + 1, source: batch.label
            });
            rows = rows.concat(norm.rows);
            rows.forEach(function (x, n) { x[X.SOURCE_COLUMNS[2]] = String(n + 1); });
            doc.rows = norm.rows.length;
            doc.tokens = (r.data.usage && r.data.usage.total) || 0;
            doc.status = norm.rows.length ? 'done' : 'empty';
            if (norm.dropped.length) doc.error = '多給了設定裡沒有的欄位：' + norm.dropped.join('、');
            if (r.data.truncated) doc.error = '結果被截斷了，可能不完整';
            ok++;
          } catch (e) {
            doc.status = 'failed';
            doc.error = e.message || String(e);
            bad++;
          }
          preview = null;
          renderAll();
        }
        var note2 = '備援解析完成 ' + ok + ' 份' + (bad ? '，失敗 ' + bad + ' 份' : '') +
          '，共 ' + rows.length + ' 列';
        var blanks = X.requiredBlanks(rows, profile);
        if (blanks.length) note2 += '；必填未填 ' + blanks.length + ' 格';
        return note2;
      }

      /* ------------------------------------------------------------ export */

      async function exportSheet(target) {
        if (!profile) throw new Error('還沒選好大類與廠商');
        if (!rows.length) throw new Error('還沒有可以匯出的資料');

        var path = target;
        if (!path) {
          path = await AIOS.saveAsPath({
            host: ctx.win && ctx.win.el,
            dir: '/文件',
            defaultName: X.exportName(profile, new Date()),
            fresh: true,
            note: '所有欄位都會以文字格式寫入，前導零不會被吃掉。' +
              '最後一欄 _來源 記的是哪個引擎產出這批資料。'
          });
          if (!path) return '取消了';
        }
        if (!/\.xlsx$/i.test(path)) path += '.xlsx';

        var book = X.workbook(rows, profile);
        var w = await A.office.writeXlsx(path, book.name, book.cells, { sheets: [book], font: null });
        if (!w || !w.ok) throw new Error((w && w.error) || '寫檔失敗');
        await AIOS.afterFsChange();
        ctx.toast('匯出好了：' + path, 't-ok');
        return '寫了 ' + rows.length + ' 列到 ' + path;
      }

      /* ---------------------------------------------------------- delivery */

      /**
       * What filing would do, built before anything moves.
       *
       * The studio decides the names when it can be reached, because it knows
       * the naming rule for this document type. This side always decides the
       * destination and the bin: the studio has never heard of the sandbox, and
       * a document with an empty mandatory cell needs a person whatever the
       * studio called it.
       */
      async function buildPlan() {
        if (!profile) throw new Error('還沒選好大類與廠商');
        if (!docs.length) throw new Error('清單裡沒有文件');
        var files = docs.map(function (d) { return { path: d.path }; });
        var at = new Date();
        /* Everything already in the sandbox, so a name that last month's batch
           is using gets numbered around rather than replaced. Refreshed here
           because filing is the one moment it has to be current. */
        await AIOS.afterFsChange();
        var occupied = AIOS.fs.paths();

        if (batch && batch.which === 'service' && batch.jobId) {
          try {
            var pv = await give('/jobs/' + enc(batch.jobId) + '/package/preview', { json: { rows: rows } });
            batch.renameField = String((pv && pv.rename_field) || batch.renameField || '');
            return X.planFromPreview({
              preview: pv, files: files, rows: rows, profile: profile, at: at, occupied: occupied
            });
          } catch (e) {
            ctx.toast('拿不到工作室的命名計畫（' + (e.message || e) + '），改用本機規則。', 't-warn');
          }
        }

        /* The local rule. `rename_field` was captured when the result arrived,
           so this still names files the way the studio would have, even now that
           it cannot be asked. */
        var p = profile;
        if (batch && batch.renameField && !p.rename) {
          p = Object.assign({}, profile, { rename: '{' + batch.renameField + '}' });
        }
        return X.planDelivery({ files: files, rows: rows, profile: p, at: at, occupied: occupied });
      }

      async function previewDelivery() {
        preview = await buildPlan();
        renderAll();
        return preview;
      }

      async function deliver() {
        var plan = preview || await buildPlan();

        if (plan.conflicts && plan.conflicts.length) {
          throw new Error('這幾個檔名在清單裡重複，分不出誰是誰，不能歸檔：' +
            plan.conflicts.join('、') + '。請先移掉其中一份。');
        }
        if (!plan.plan.length) throw new Error('沒有可以歸檔的文件');

        /* No mkdir pass. sandbox.move creates the destination's parents itself,
           and asking for the folders separately would put more consent dialogs
           in front of the one that matters, which is the batch below. */
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
            var d = docs.filter(function (x) { return x.path === entry.from; })[0];
            if (d) { d.path = entry.to; d.filed = entry.status; }
          } else {
            failed.push(entry.name + '：' + ((r && r.error) || '搬移失敗'));
          }
        }

        preview = null;
        await AIOS.afterFsChange();
        renderAll();
        var note2 = '歸檔了 ' + moved + ' / ' + plan.plan.length + ' 份（完成 ' +
          plan.finished + '、待確認 ' + plan.unsure + '）';
        if (plan.missing && plan.missing.length) {
          note2 += '；工作室提到但這裡沒有的檔案 ' + plan.missing.length + ' 份';
        }
        if (plan.unplanned && plan.unplanned.length) {
          note2 += '；計畫沒有提到、原地不動的 ' + plan.unplanned.length + ' 份';
        }
        if (failed.length) {
          note2 += '；' + failed.length + ' 份沒搬成功';
          ctx.toast(failed.join('\n'), 't-err');
        }
        return note2;
      }

      /* ----------------------------------------------------------- drawing */

      function renderBanner() {
        banner.innerHTML = '';
        banner.className = 'ext-banner ext-mode-' + mode + (degraded ? ' ext-degraded' : '');

        var line = el('div', 'ext-banner-line');
        line.appendChild(el('span', 'ext-chip',
          mode === 'service' ? '工作室' : (mode === 'fallback' ? '備援模型' : '未就緒')));
        line.appendChild(el('span', 'ext-banner-why', modeReason));
        line.appendChild(el('span', 'ext-gap'));

        var reconnect = btn(mode === 'service' ? '重新檢查' : '重新連線',
          '再問一次工作室在不在', 'ext-mini');
        reconnect.disabled = busy;
        reconnect.addEventListener('click', async function () {
          if (busy) return;
          await refreshMode(true);
          if (!batch) buildProfile();
          renderAll();
        });
        line.appendChild(reconnect);

        if (mode === 'service') {
          var s = btn(syncing ? '同步中…' : '同步清單', '重新取回大類、廠商、欄位與提示詞', 'ext-mini');
          s.disabled = syncing || busy;
          s.addEventListener('click', async function () {
            try { ctx.toast(await sync(), 't-ok'); }
            catch (e) { ctx.toast('同步失敗：' + (e.message || e), 't-err'); }
          });
          line.appendChild(s);
        }

        var cfg = btn('連線設定', '工作室端點與備援模型', 'ext-mini');
        cfg.addEventListener('click', async function () { await refreshMode(false); showPage('settings'); });
        line.appendChild(cfg);
        banner.appendChild(line);

        if (batch) {
          banner.appendChild(el('div', 'ext-banner-note micro',
            '這一批綁在「' + batch.label + '」上' +
            (batch.jobId ? '，工作室編號 ' + batch.jobId : '') + '。中途不會換引擎。'));
        } else if (orphan && mode === 'service') {
          var back = el('div', 'ext-banner-note micro');
          back.appendChild(document.createTextNode('上次有一個批次沒有收尾（編號 ' + orphan + '）。'));
          var pick = btn('接回這一批', '工作室那邊多半已經跑完了', 'ext-mini');
          pick.disabled = busy;
          pick.addEventListener('click', async function () {
            try { ctx.toast(await resumeJob(orphan), 't-ok'); }
            catch (e) { ctx.toast(e.message || String(e), 't-err'); }
          });
          back.appendChild(pick);
          var forget = btn('不用了', '忘掉這個編號', 'ext-mini');
          forget.addEventListener('click', function () { orphan = ''; renderAll(); ctx.save(); });
          back.appendChild(forget);
          banner.appendChild(back);
        }

        if (catalog.at) {
          var when = new Date(catalog.at).toLocaleString('zh-TW');
          if (mode === 'service') {
            var cov = fallbackCoverage();
            var bits = ['清單同步於 ' + when];
            if (cov.bare.length) {
              bits.push('端點掛掉時接不了的廠商：' + cov.bare.join('、') +
                '（沒有提示詞，也沒有本機設定檔）');
            }
            banner.appendChild(el('div', 'ext-banner-note micro', bits.join('　·　')));
          } else if (mode === 'fallback') {
            banner.appendChild(el('div', 'ext-banner-note micro',
              '用的是 ' + when + ' 同步下來的清單，欄位可能已經在工作室那邊改過了。'));
          }
        }
      }

      function renderBar() {
        bar.innerHTML = '';
        if (mode === 'none') { bar.hidden = true; return; }
        bar.hidden = false;

        var catWrap = el('label', 'ext-pick');
        catWrap.appendChild(el('span', 'micro', '大類'));
        var catSel = el('select', 'ext-select');
        catSel.setAttribute('aria-label', '文件大類');
        if (!catalog.categories.length) {
          var none = el('option', null, '（還沒同步）');
          none.value = '';
          catSel.appendChild(none);
        }
        catalog.categories.forEach(function (c) {
          var o = el('option', null, c);
          o.value = c;
          catSel.appendChild(o);
        });
        catSel.value = category;
        catSel.disabled = busy || !!batch;
        catSel.addEventListener('change', function () {
          category = catSel.value;
          auto = false;
          pickDefaultVendor();
          buildProfile();
          renderAll();
          ctx.save();
        });
        catWrap.appendChild(catSel);
        bar.appendChild(catWrap);

        var venWrap = el('label', 'ext-pick');
        venWrap.appendChild(el('span', 'micro', '廠商'));
        var venSel = el('select', 'ext-select');
        venSel.setAttribute('aria-label', '廠商');
        if (autoOffered(category)) {
          var a = el('option', null, '🔎 ' + AUTO);
          a.value = '';
          venSel.appendChild(a);
        }
        vendorsOf(category).forEach(function (v) {
          var o = el('option', null, v);
          o.value = v;
          venSel.appendChild(o);
        });
        venSel.value = auto ? '' : vendor;
        venSel.disabled = busy || !!batch;
        venSel.addEventListener('change', function () {
          vendor = venSel.value;
          auto = !vendor && autoOffered(category);
          buildProfile();
          renderAll();
          ctx.save();
        });
        venWrap.appendChild(venSel);
        bar.appendChild(venWrap);

        bar.appendChild(el('span', 'ext-gap'));

        var btnAdd = btn('加入文件', '從沙箱挑 PDF 加進清單');
        btnAdd.disabled = busy;
        btnAdd.addEventListener('click', async function () {
          var p = await AIOS.openPath({
            host: ctx.win && ctx.win.el,
            label: '加入要解析的文件',
            note: '只吃得下 PDF。要一次加很多份，可以從檔案總管把它們拖進這個視窗。',
            filter: function (f) { return /\.pdf$/i.test(f.vpath); },
            preview: false
          });
          if (p) ctx.toast(await addDocs([p]), 't-ok');
        });
        bar.appendChild(btnAdd);

        if (failedFiles.length && batch && batch.which === 'service') {
          var again = btn('重跑失敗的（' + failedFiles.length + '）', '請工作室再試一次那幾份');
          again.disabled = busy;
          again.addEventListener('click', async function () {
            try { ctx.toast(await retryFailed(), 't-ok'); }
            catch (e) { ctx.toast(e.message || String(e), 't-err'); }
          });
          bar.appendChild(again);
        }

        var btnRun = btn('開始解析', '把清單裡還沒解析的文件送出去', 'fbtn ext-go');
        btnRun.disabled = busy || !docs.some(function (d) {
          return d.status === 'queued' || d.status === 'failed';
        });
        btnRun.addEventListener('click', async function () {
          try { ctx.toast(await runAll(), 't-ok'); }
          catch (e) { ctx.toast(e.message || String(e), 't-err'); }
        });
        bar.appendChild(btnRun);

        var btnStop = btn('停止', '停下來，工作室那邊的批次不會取消');
        btnStop.disabled = !busy;
        btnStop.addEventListener('click', function () {
          stop = true;
          ctx.toast('停下來了。工作室那邊還在跑。', 't-info');
        });
        bar.appendChild(btnStop);
      }

      function renderDocs() {
        side.innerHTML = '';
        var head = el('div', 'ext-side-head');
        head.appendChild(el('span', null, '文件 ' + docs.length +
          (docs.length ? '　' + mib(totalBytes()) : '')));
        if (docs.length && !busy) {
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
          var li = el('li', 'ext-doc ext-st-' + d.status);
          var top = el('div', 'ext-doc-top');
          top.appendChild(el('span', 'ext-dot', glyphFor(d.status)));
          var nm = el('span', 'ext-doc-name', d.name);
          nm.title = d.path;
          top.appendChild(nm);
          if (!busy) {
            var x = btn('×', '從清單移除', 'ext-mini');
            x.addEventListener('click', function () { dropDoc(d.path); });
            top.appendChild(x);
          }
          li.appendChild(top);

          var meta = [];
          if (d.bytes) meta.push(mib(d.bytes));
          if (d.vendor) meta.push(d.vendor);
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

        if (mode === 'none') {
          grid.appendChild(note('還不能開始。', modeReason +
            '\n\n按上面的「連線設定」填工作室的端點與金鑰。備援模型可以留著不設，' +
            '但端點掛掉時就沒有東西接手。'));
          return;
        }

        if (mode === 'service' && !catalog.categories.length) {
          grid.appendChild(note('還沒跟工作室同步過。',
            '按上面的「同步清單」把大類、廠商與欄位取回來。取回來之後即使端點暫時連不上，' +
            '這些清單還在。'));
          return;
        }

        if (!profile) {
          grid.appendChild(note('這個組合還沒有欄位設定。',
            mode === 'service'
              ? '再同步一次，或換一個大類與廠商。'
              : '備援模式要有同步下來的欄位，或在 ' + X.PROFILE_DIR + ' 底下有一份對應的設定檔。'));
          return;
        }

        if (mode === 'fallback' && !X.asText(profile.prompt).trim()) {
          var bare = el('div', 'ext-note ext-bad');
          bare.appendChild(el('h3', null, '「' + (vendor || category) + '」這一家沒有提示詞，備援跑不了'));
          bare.appendChild(el('p', 'micro',
            '欄位是同步下來的，看得到；但提示詞工作室沒有交出來，所以備援模式不知道要從文件裡抓什麼。\n' +
            '可以在 ' + X.PROFILE_DIR + ' 底下放一份含提示詞的設定檔，或等端點恢復。'));
          bare.querySelector('p').style.whiteSpace = 'pre-wrap';
          grid.appendChild(bare);
        }

        if (profileIssues && !profileIssues.ok) {
          var bad = el('div', 'ext-note ext-bad');
          bad.appendChild(el('h3', null, '「' + profile.name + '」還不能用'));
          var ul = el('ul', null);
          profileIssues.errors.forEach(function (e) { ul.appendChild(el('li', null, e)); });
          bad.appendChild(ul);
          grid.appendChild(bad);
          return;
        }

        if (failedFiles.length) {
          var warn = el('div', 'ext-note ext-bad');
          warn.appendChild(el('h3', null, failedFiles.length + ' 份文件不在下面的表格裡'));
          var fl = el('ul', null);
          failedFiles.slice(0, 12).forEach(function (f) {
            fl.appendChild(el('li', null, (f.filename || f) + '：' + (f.error || '工作室沒說原因')));
          });
          warn.appendChild(fl);
          grid.appendChild(warn);
        }

        if (!rows.length) {
          grid.appendChild(note('還沒有結果。',
            '輸出格式：' + (profile.schemaLabel || profile.name) +
            '\n欄位：' + profile.columns.join('、') +
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
                  preview = null;
                  /* Only this cell's shading and the counters can have changed.
                     Redrawing the whole table would throw away the caret, so
                     tabbing along a row filling in blanks -- the entire reason
                     these cells are editable -- would land somewhere else after
                     every entry. */
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
       * would be called, which bin it lands in, and why.
       *
       * The "why" column is the one that earns its place. A document in the
       * 待確認 bin with no explanation is a document somebody has to open and
       * compare by hand.
       */
      function renderPreview() {
        var head = el('div', 'ext-note');
        head.appendChild(el('h3', null,
          '交付計畫：完成 ' + preview.finished + ' 份、待確認 ' + preview.unsure + ' 份'));
        var why = el('p', 'micro');
        why.style.whiteSpace = 'pre-wrap';
        why.textContent = '還沒有動到任何檔案。按下面的「確認交付」之後，系統會再列出每一個搬移讓你核可一次。\n' +
          (preview.renameField ? '命名依據：' + preview.renameField + '\n' : '') +
          (preview.source === 'service'
            ? '檔名由工作室決定，桶子由這台機器決定。\n'
            : '命名與桶子都用本機規則。\n') +
          '去處：\n' + preview.dirs.map(function (d) { return '　' + d; }).join('\n');
        head.appendChild(why);
        grid.appendChild(head);

        [['conflicts', '檔名重複，分不出誰是誰，不會搬'],
          ['missing', '工作室提到但這台機器沒有的檔案'],
          ['unplanned', '計畫沒有提到，會留在原地']].forEach(function (pair) {
          var list = preview[pair[0]];
          if (!list || !list.length) return;
          var box = el('div', 'ext-note ext-bad');
          box.appendChild(el('h3', null, pair[1] + '（' + list.length + '）'));
          box.appendChild(el('p', 'micro', list.slice(0, 12).join('、')));
          grid.appendChild(box);
        });

        var table = el('table', 'ext-table ext-plan');
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
          /* The bin, not the whole path. The directories are listed in full just
             above, and putting them in the rows made every one of them wide
             enough to push the 原因 column off the right edge, which is the
             column a person is actually reading this table for. */
          var bin = el('td', 'ext-src', e.dir.split('/').pop());
          bin.title = e.dir;
          tr.appendChild(bin);
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
        if (syncing) bits.push('同步中…');
        if (profile && profile.schemaLabel) bits.push(profile.schemaLabel);
        bits.push(docs.length + ' 份文件');
        bits.push(rows.length + ' 列');
        if (profile && rows.length) {
          var blanks = X.requiredBlanks(rows, profile);
          if (blanks.length) bits.push('必填未填 ' + blanks.length + ' 格');
          else bits.push('必填齊了');
        }
        if (failedFiles.length) bits.push('失敗 ' + failedFiles.length + ' 份');
        status.textContent = bits.join('　·　');
        status.className = 'ext-status' + (mode === 'none' ? ' ext-warn' : '');

        btnExport.disabled = !rows.length || !!preview;
        btnCancelPlan.hidden = !preview;
        btnDeliver.textContent = preview ? '確認交付（' + preview.plan.length + '）' : '交付歸檔';
        btnDeliver.disabled = !docs.length || busy;
      }

      function renderAll() {
        renderBanner();
        renderBar();
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
        }) + '\n引擎：' + (batch ? batch.label : (mode === 'service' ? '工作室' : '備援模型')),
        '文件萃取');
      }

      /* -------------------------------------------------- connection pane */

      function renderSettings() {
        settings.innerHTML = '';
        var s = svc || {};

        var h = el('div', 'ext-set-head');
        h.appendChild(el('h3', null, '這支程式的連線設定'));
        var back = btn('回到作業', null, 'fbtn ext-go');
        back.addEventListener('click', async function () {
          await refreshMode(false);
          if (!batch) buildProfile();
          showPage('work');
        });
        h.appendChild(back);
        settings.appendChild(h);

        settings.appendChild(el('p', 'micro',
          '跟系統的核心模型是兩回事：這裡設的端點與金鑰只有這支程式會用，' +
          '系統那邊的設定也不會動到這裡。\n' +
          '⚠ 解析時文件原檔會上傳到這裡設定的服務。不想讓它送出去，' +
          '可以在能力閘門把 doc.extract 設成 DENY。'));

        settings.appendChild(backendPane('service', '提示詞工作室（預設）',
          '大類、廠商、欄位與提示詞都由它管理。位址像 http://127.0.0.1:8000。'));
        settings.appendChild(backendPane('fallback', '備援模型',
          '端點連不上時接手。它需要提示詞才能真的跑：同步時工作室若肯交出來就用那份，' +
          '否則要在 ' + X.PROFILE_DIR + ' 底下自己放一份。'));

        var box = el('div', 'ext-headers');
        box.appendChild(el('h4', null, '共用設定'));
        var shared = el('div', 'ext-form');
        var deliver = field(shared, '交付路徑', 'text', s.deliver || X.DELIVER_DEFAULT);
        deliver.input.placeholder = X.DELIVER_DEFAULT;
        var owner = field(shared, '送件者', 'text', s.owner || '');
        owner.input.placeholder = '工作室的批次清單會用這個名字';
        var prefer = field(shared, '優先使用', 'select', s.prefer || 'service', [
          { value: 'service', label: '提示詞工作室' },
          { value: 'fallback', label: '備援模型' }
        ]);
        box.appendChild(shared);

        var autoRow = el('label', 'ext-field');
        autoRow.appendChild(el('span', 'ext-field-label', '自動降級'));
        var autoBox = el('input');
        autoBox.type = 'checkbox';
        autoBox.checked = s.autoFallback !== false;
        autoRow.appendChild(autoBox);
        box.appendChild(autoRow);
        box.appendChild(el('p', 'micro',
          '端點連不上時自動改用備援。只在開窗或按「重新連線」時發生，不會在批次中途換引擎。' +
          '金鑰錯誤或服務自己出錯不算連不上，那兩種會停下來照實說。'));

        var acts = el('div', 'ext-set-acts');
        var save = btn('儲存共用設定', null, 'fbtn ext-go');
        acts.appendChild(save);
        box.appendChild(acts);
        var out = el('p', 'ext-set-out micro');
        box.appendChild(out);
        settings.appendChild(box);

        save.addEventListener('click', async function () {
          out.textContent = '儲存中…';
          out.className = 'ext-set-out micro';
          var r = await A.extract.configure(undefined, {
            deliver: deliver.input.value.trim(),
            owner: owner.input.value.trim(),
            prefer: prefer.input.value,
            autoFallback: autoBox.checked
          });
          if (r && r.ok) {
            svc = r.data;
            out.textContent = '存好了。';
          } else {
            out.textContent = (r && r.error) || '存不起來';
            out.className = 'ext-set-out ext-warn micro';
          }
        });

        if (s.sealed === false) {
          settings.appendChild(el('p', 'ext-set-out ext-warn micro',
            '⚠ 這台機器沒有作業系統金鑰保管庫，金鑰只會留在這次執行期間，不會寫進磁碟。'));
        }
      }

      /** One backend's address, model, auth kind, key and custom headers. */
      function backendPane(which, title, hint) {
        var s = (svc && svc[which]) || {};
        var box = el('div', 'ext-headers');
        box.appendChild(el('h4', null, title));
        box.appendChild(el('p', 'micro', hint));

        var form = el('div', 'ext-form');
        var base = field(form, '端點位址', 'text', s.base || '');
        var model = which === 'fallback' ? field(form, '模型名稱', 'text', s.model || '') : null;
        if (model) model.input.placeholder = (svc && svc.defaults && svc.defaults.model) || 'gemini-2.5-pro';
        var auth = field(form, '驗證方式', 'select', s.auth || 'apikey', [
          { value: 'apikey', label: 'X-API-Key' },
          { value: 'goog', label: 'x-goog-api-key（Google）' },
          { value: 'bearer', label: 'Authorization: Bearer' },
          { value: 'none', label: '不帶金鑰（用下面的自訂表頭）' }
        ]);
        var key = field(form, 'API 金鑰', 'password', '');
        key.input.placeholder = s.hasKey ? '（已設定，留白就不更動）' : '貼上金鑰';
        box.appendChild(form);

        box.appendChild(el('p', 'micro',
          '自訂表頭：每一列都會加到送出的請求上。值存起來之後就讀不回來了，' +
          '留白代表「不要動它」，要刪掉就把整列移除。'));
        var hdrList = el('div', 'ext-header-list');
        box.appendChild(hdrList);

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
        }
        (s.headerNames || []).forEach(function (n) { addHeaderRow(n, true); });
        var addHdr = btn('加一列表頭', '再加一組要跟著請求送出的表頭');
        addHdr.addEventListener('click', function () { addHeaderRow('', false); });
        box.appendChild(addHdr);

        var acts = el('div', 'ext-set-acts');
        var save = btn('儲存', null, 'fbtn ext-go');
        var test = btn('測試連線', '問一下端點，看設定對不對');
        var forget = btn('清除金鑰', '把金鑰與表頭的值都忘掉');
        acts.appendChild(save);
        acts.appendChild(test);
        acts.appendChild(forget);
        box.appendChild(acts);
        var out = el('p', 'ext-set-out micro');
        box.appendChild(out);

        save.addEventListener('click', async function () {
          out.textContent = '儲存中…';
          out.className = 'ext-set-out micro';
          try {
            var patch = { base: base.input.value.trim(), auth: auth.input.value };
            if (model) patch.model = model.input.value.trim();
            var c = await A.extract.configure(which, patch);
            if (!c || !c.ok) throw new Error((c && c.error) || '存不起來');

            var headers = [];
            hdrList.querySelectorAll('.ext-header-row').forEach(function (row) {
              var ins = row.querySelectorAll('input');
              if (ins[0].value.trim()) headers.push({ name: ins[0].value.trim(), value: ins[1].value });
            });
            var k = await A.extract.setSecret(which, key.input.value, headers);
            if (!k || !k.ok) throw new Error((k && k.error) || '金鑰存不起來');
            svc = k.data;
            key.input.value = '';
            out.textContent = '存好了。';
            renderSettings();
          } catch (e) {
            out.textContent = e.message || String(e);
            out.className = 'ext-set-out ext-warn micro';
          }
        });

        test.addEventListener('click', async function () {
          out.textContent = '測試中…';
          out.className = 'ext-set-out micro';
          var r = await A.extract.probe(which);
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
            label: '忘掉「' + title + '」的金鑰？',
            note: '金鑰與所有自訂表頭的值都會刪掉，位址留著。',
            okLabel: '忘掉',
            danger: true
          });
          if (!yes) return;
          var r = await A.extract.forgetSecret(which);
          if (r && r.ok) { svc = r.data; renderSettings(); }
        });

        return box;
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
        banner.hidden = !onWork;
        bar.hidden = !onWork;
        work.hidden = !onWork;
        foot.hidden = !onWork;
        settings.hidden = onWork;
        if (onWork) renderAll(); else renderSettings();
        ctx.save();
      }

      /* ----------------------------------------------------------- wiring */

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
            var p = await previewDelivery();
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
        if (busy) return;
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
        ctx.toast(await addDocs(added), 't-ok');
      });

      ctx.setMenu(function () {
        return [
          { label: '同步工作室清單', run: function () { sync().catch(function () {}); } },
          {
            label: '重新連線',
            run: async function () { await refreshMode(true); if (!batch) buildProfile(); renderAll(); }
          },
          { label: '連線設定…', run: async function () { await refreshMode(false); showPage('settings'); } },
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
        choose: choose,
        addDocs: addDocs,
        runAll: runAll,
        exportSheet: exportSheet,
        previewDelivery: previewDelivery,
        deliver: deliver,
        sync: sync,
        clearAll: clearAll,
        refreshMode: refreshMode,
        retryFailed: retryFailed,
        resumeJob: resumeJob
      };

      booted = (async function start() {
        await refreshMode(false);
        await loadCatalog();
        await refreshLocalProfiles();
        buildProfile();
        showPage('work');
      }());

      /* A first run has an empty catalogue and nothing to show. Filling it is
         the one thing that has to happen before the window is any use, so it
         happens without being asked -- and quietly, because it is slow and
         nobody pressed anything. */
      booted.then(function () {
        if (mode !== 'service' || catalog.categories.length) return;
        sync().then(function (n) { ctx.toast(n, 't-ok'); }).catch(function (e) {
          ctx.toast('自動同步失敗：' + (e.message || e), 't-warn');
        });
      });

      return {
        getState: function () {
          return {
            category: category, vendor: vendor, auto: auto, page: page,
            jobId: (batch && batch.jobId) || orphan || ''
          };
        },
        onClose: function () {
          stop = true;
          if (batch && batch.jobId && !rows.length) orphan = batch.jobId;
          if (batch) A.extract.endBatch(batch.token);
          ctx.publish(null);
        }
      };
    }
  });
})();
