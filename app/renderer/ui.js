/* ===========================================================================
   AI-OS // display layer
   ---------------------------------------------------------------------------
   Rendering only. Every panel here is a view onto kernel state, so the machine
   stays legible: what is resident, what is authorised, what already happened.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var K = AIOS.kernel;
  var S = AIOS.state;
  var T0 = Date.now();

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function T(key, zh, vars) { return AIOS.i18n ? AIOS.i18n.t(key, zh, vars) : zh; }
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function stamp() {
    var s = (Date.now() - T0) / 1000;
    return '[' + (s < 10 ? ' ' : '') + s.toFixed(2) + '] ';
  }

  /* ==================================================================== */

  AIOS.ui = {

    /* ------------------------------------------------------------ boot */

    /**
     * Boot is a real measurement now. The main process mounts the sandbox,
     * loads the policy and starts llama-server; llama.cpp's own load log is
     * streamed in here, so the progress on screen is a 24 GB model actually
     * being mapped rather than an animation.
     */
    boot: async function () {
      var logEl = $('boot-log');
      var fill = $('boot-fill');
      var status = $('boot-status');
      var done = 0;
      var expected = 8;

      function line(text, cls) {
        var span = el('span', cls, text + '\n');
        logEl.appendChild(span);
        // Keep the pane on the tail without letting the DOM grow unbounded:
        // llama.cpp is talkative during a load.
        while (logEl.childNodes.length > 220) logEl.removeChild(logEl.firstChild);
        logEl.scrollTop = logEl.scrollHeight;
      }
      function tick(label) {
        done++;
        fill.style.width = Math.min(96, Math.round((done / expected) * 100)) + '%';
        if (label) status.textContent = label;
      }

      var levelClass = { ok: 'ok', error: 'no', warn: '', hi: 'hi', info: '' };

      line('AI-OS intent kernel rev 0.9', 'hi');
      line('display server ................ up');
      tick('POST');

      // Kernel log, live.
      window.aios.onKernelLog(function (entry) {
        line('  ' + entry.line, levelClass[entry.level] || '');
      });
      // Boot narration from the main process.
      window.aios.onBootStep(function (step) {
        line(step.text, levelClass[step.level] || '');
        tick(step.level === 'hi' ? 'KERNEL' : null);
      });

      /* Taint, pushed. Reading a hostile file downgrades the elevated
         capabilities in the main process immediately; before this the badge that
         explains why only appeared the next time something happened to ask. */
      window.aios.taint.onChanged(function (state) {
        var was = !!(S.taint && S.taint.tainted);
        S.taint = state || { tainted: false, sources: [] };
        // The badge lives in the sandbox panel; the context list marks the pages
        // that carry the untrusted content.
        AIOS.ui.renderSandbox();
        AIOS.ui.renderContext();
        if (S.taint.tainted && !was) {
          var src = (S.taint.sources || []).map(function (s) { return s.vpath || s.source; });
          AIOS.ui.trace('汙染降級：讀進了不可信內容（' + src.slice(0, 2).join('、') +
            '），需要提權的能力這一輪都會先問過你', 't-taint');
        } else if (!S.taint.tainted && was) {
          AIOS.ui.trace('汙染標記已清除，能力回到政策設定', 't-ok');
        }
      });

      /* Files that arrived without going through this machine. The sandbox is a
         real directory and people put things in it from Explorer; before this
         the shell only knew what it had read at boot, so a file dropped in was
         invisible and the machine would say it did not exist.

         Silent on purpose. It announced itself at first, and the line said
         nothing anybody could act on while appearing several times a minute --
         the file manager showing the new file is the evidence, and a trace that
         reports its own bookkeeping is a trace people stop reading. Errors are
         still worth hearing, so those still speak. */
      window.aios.fs.onChanged(function () {
        AIOS.afterFsChange({ external: true }).catch(function (e) {
          AIOS.ui.trace('沙箱重新讀取失敗：' + (e && e.message ? e.message : e), 't-warn');
        });
      });

      $('boot-skip').addEventListener('click', function () {
        $('boot').classList.add('gone');
        window.setTimeout(function () { $('boot').hidden = true; }, 600);
      });

      status.textContent = 'MOUNT';
      var res = await window.aios.boot();

      if (res.endpoint) S.endpoint = res.endpoint;
      /* Booted is not the same as connected. A wrong API key leaves the machine
         perfectly able to start and unable to think, and saying "connected"
         because the boot succeeded would make the LED lie. */
      S.connected = !!(res.ok && res.model);
      S.model = res.model || null;
      S.nCtx = res.nCtx || 0;
      S.nCtxSource = res.nCtxSource || '';
      S.nCtxSourceName = res.nCtxSourceName || '';
      S.maxOut = res.maxOut || 0;
      /* Here, not in the event wiring: that runs before the boot reply and would
         size the slider against an n_ctx of zero -- which is how it stayed at the
         old 32,768 ceiling in front of a million-token model. */
      if (AIOS.fitBudget) AIOS.fitBudget();
      S.tokenizer = res.tokenizer !== false;
      if (res.providers) {
        var act = (res.providers.providers || []).find(function (p) { return p.id === res.providers.active; });
        S.provider = res.providers.active;
        if (act) { S.providerLabel = act.label; S.remote = !!act.remote; }
      }
      S.sandboxRoot = res.sandboxRoot || null;
      S.quota = res.quota || null;
      if (res.policy) S.policy = res.policy;
      if (res.capNotes) S.capNotes = res.capNotes;
      if (res.taint) S.taint = res.taint;
      if (res.ops) AIOS.setOps(res.ops, res.elevated, res.lasting);
      /* Language and text size, as the main process keeps them. The language
         layer may already have applied itself from prefs.get(); this is the
         same answer, and the menus read it from here. */
      if (res.prefs) {
        S.prefs = res.prefs;
        if (AIOS.i18n && res.prefs.locale) AIOS.i18n.set(res.prefs.locale);
      }
      /* The user's own themes, ahead of the session that may name one of them.
         They reach the page as a generated stylesheet; until it is installed a
         saved custom id resolves to no palette at all. */
      if (AIOS.themes && AIOS.themes.setCustom) AIOS.themes.setCustom(res.themes || []);

      if (!res.ok) {
        line('boot degraded: ' + (res.error || '未知錯誤'), 'no');
        line('提示：從選單「系統 → 核心模型」挑一個核心，或「系統 → 重新連線核心」重試。', 'no');
      }

      line('installing syscall table ...');
      line('  ' + Object.keys(AIOS.OPS).length + ' ops registered', 'ok');
      tick('SYSCALL');

      await AIOS.fs.refresh();
      var usage = await window.aios.fs.usage();
      if (usage && usage.ok) S.fsUsage = usage.data;
      line('sandbox: ' + (AIOS.fs.cache.files || []).length + ' 個檔案，' +
        AIOS.bytes(AIOS.fs.cache.bytes || 0), 'ok');
      tick('FS');

      // Long-term memory lives in the main process now; nothing is seeded, so
      // an empty store on a fresh machine is the correct state.
      var memCount = res.memory ? res.memory.count : 0;
      line('memory: ' + memCount + ' 筆' + (memCount ? '' : '（空的，不預載任何內容）'),
        memCount ? 'ok' : '');

      // Programs the machine wrote for itself become launchable again.
      var genCount = await AIOS.forge.bootstrapInstalled(res.apps);
      line('applications: ' + AIOS.apps.list().length + ' 個（其中 ' + genCount + ' 個是核心自製）', 'ok');
      tick('APPS');

      line('priming attention scheduler ...');
      var sys = K.page('sys/kernel', {
        kind: 'sys', label: 'sys/kernel', priority: 100, pinned: true, text: K.systemPrompt()
      });
      if (S.connected) await K.measure(sys);
      K.page('ui/policy', {
        kind: 'ui', label: 'ui/policy', priority: 72,
        text: '能力政策：' + Object.keys(S.policy).map(function (c) { return c + '=' + S.policy[c]; }).join(', ')
      });
      line('  sys/kernel = ' + fmt(sys.tokens) + ' tok, budget ' + fmt(S.budget) + ' tok', 'ok');
      tick('SCHED');

      // Bring back the desktop the machine was last using.
      if (res.session) {
        line('restoring session ...');
        var r = await AIOS.session.restore(res.session);
        line('  ' + r.windows + ' 個視窗、' + r.pages + ' 個 context 分頁' +
          (res.sessionFromBackup ? '（從備份檔還原）' : ''), 'ok');
      }
      tick('SESSION');

      /* Degraded means "cannot think", which is true whether the local host is
         missing or a hosted key is wrong. Either way the fix is in one window, so
         say which one rather than leaving the reader to hunt. */
      line(S.connected ? 'READY' : 'READY (degraded: no core model -- 系統 → 核心模型)',
        S.connected ? 'ok' : 'no');
      fill.style.width = '100%';
      status.textContent = S.connected ? 'READY' : 'DEGRADED';
      await new Promise(function (r2) { window.setTimeout(r2, S.connected ? 420 : 1400); });

      $('boot').classList.add('gone');
      window.setTimeout(function () { $('boot').hidden = true; }, 600);

      this.trace('kernel 啟動完成', 't-ok');
      if (S.sandboxRoot) this.trace('沙箱：' + S.sandboxRoot, 't-info');
      // 0 is not a context length, it is the absence of one: no hosted provider
      // reports n_ctx, so printing "n_ctx=0" states a measurement that was never
      // taken. The reconnect line already says this properly; this one is the
      // first thing on screen at boot and said 0 for months.
      if (S.connected) {
        this.trace('模型：' + S.model +
          (S.nCtx ? '　n_ctx=' + fmt(S.nCtx) + (S.nCtxSourceName ? '（' + S.nCtxSourceName + '）' : '')
            : '　n_ctx 未知（這個供應商的 /models 沒有上限欄位，可在「系統 → 核心模型」的「上下文長度」自己填）'), 't-info');
      }
      else this.trace('沒有連上模型伺服器，意圖解析會失敗', 't-err');
      return S.connected;
    },

    /* ----------------------------------------------------------- clock */

    startClock: function () {
      var c = $('clock');
      function paint() {
        var d = new Date();
        function p(n) { return (n < 10 ? '0' : '') + n; }
        c.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      }
      paint();
      window.setInterval(paint, 1000);
    },

    /* ----------------------------------------------------------- trace */

    trace: function (msg, cls) {
      var t = $('trace');
      var line = el('div', 't-line ' + (cls || ''));
      line.appendChild(el('b', null, stamp()));
      line.appendChild(document.createTextNode(msg));
      t.appendChild(line);
      t.scrollTop = t.scrollHeight;
      while (t.childNodes.length > 260) t.removeChild(t.firstChild);
      return line;
    },

    /** Streaming sink so token output does not create a node per token. */
    traceStream: function (label, cls) {
      var t = $('trace');
      var line = el('div', 't-line ' + (cls || 't-tok') + ' caret');
      line.appendChild(el('b', null, stamp()));
      var span = el('span', null, label || '');
      line.appendChild(span);
      t.appendChild(line);
      var buf = label || '';
      return {
        push: function (piece) {
          buf += piece;
          // Keep the tail only: this is a trace, not a transcript.
          span.textContent = buf.length > 420 ? '…' + buf.slice(-420) : buf;
          t.scrollTop = t.scrollHeight;
        },
        done: function (suffix) {
          line.classList.remove('caret');
          if (suffix) span.textContent += suffix;
        }
      };
    },

    phase: function (name, state) {
      var nodes = $('phases').querySelectorAll('.ph');
      Array.prototype.forEach.call(nodes, function (n) {
        if (n.getAttribute('data-phase') === name) {
          n.classList.remove('active', 'done');
          if (state) n.classList.add(state);
        }
      });
    },

    resetPhases: function () {
      var nodes = $('phases').querySelectorAll('.ph');
      Array.prototype.forEach.call(nodes, function (n) { n.classList.remove('active', 'done'); });
    },

    /* ------------------------------------------------------- telemetry */

    link: function (state) {
      var led = $('led');
      led.classList.remove('up', 'busy');
      var text = 'OFFLINE';
      if (state === 'up') { led.classList.add('up'); text = 'ONLINE'; }
      else if (state === 'busy') { led.classList.add('busy'); text = 'THINKING'; }
      led.querySelector('span').textContent = text;
    },

    telemetry: function (timings) {
      if (timings) S.lastTimings = timings;
      var t = S.lastTimings;
      var dec = $('s-decode'), pre = $('s-prefill');
      if (t) {
        var d = t.predicted_per_second, p = t.prompt_per_second;
        dec.innerHTML = 'DEC <b>' + (d ? d.toFixed(1) + ' t/s' : '—') + '</b>';
        pre.innerHTML = 'PRE <b>' + (p ? p.toFixed(0) + ' t/s' : '—') + '</b>';
        dec.classList.add('hot');
      }
      $('s-model').textContent = S.model || '—';
    },

    /* -------------------------------------------------- attention HUD */

    renderContext: function (evicted) {
      var u = K.usage();
      var pct = S.budget ? Math.min(100, Math.round((u.used / S.budget) * 100)) : 0;
      var over = u.used > S.budget;

      $('ctx-used').textContent = fmt(u.used);
      $('ctx-budget').textContent = '/ ' + fmt(S.budget) + ' tok';
      $('ctx-pct').textContent = pct + '%' + (over ? T('ui.over', ' 超載') : '');

      var ring = $('ring-fg');
      var circ = 113;
      ring.style.strokeDashoffset = String(circ - (Math.min(100, pct) / 100) * circ);
      ring.classList.toggle('over', over);

      var g = $('g-ctx');
      g.querySelector('.gauge-track i').style.width = Math.min(100, pct) + '%';
      g.querySelector('.gauge-v').textContent = pct + '%';
      g.classList.toggle('over', over);

      var bar = $('budget-bar');
      bar.innerHTML = '';
      var order = ['sys', 'ui', 'mem', 'turn', 'data'];
      var denom = Math.max(u.used, S.budget);
      order.forEach(function (k) {
        var v = u.byKind[k] || 0;
        if (!v) return;
        var seg = el('span', 'seg seg-' + k);
        seg.style.width = ((v / denom) * 100) + '%';
        seg.title = k + ': ' + fmt(v) + ' tok';
        bar.appendChild(seg);
      });

      var list = $('pages');
      list.innerHTML = '';
      S.pages.slice().sort(function (a, b) {
        return (b.priority - a.priority) || (a.label < b.label ? -1 : 1);
      }).forEach(function (p) {
        var li = el('li', 'page' + (p.tainted ? ' tainted' : ''));
        var mark = el('span', 'page-mark');
        mark.style.background = 'var(--' + ({ sys: 'fg-faint', ui: 'accent', mem: 'accent-2', turn: 'accent', data: 'taint' }[p.kind] || 'hair-2') + ')';
        li.appendChild(mark);
        li.appendChild(el('span', 'page-label', p.label));
        li.appendChild(el('span', 'page-tok', fmt(p.tokens)));
        var pin = el('button', 'page-pin', p.pinned ? '\u25c9' : '\u25cb');
        pin.type = 'button';
        pin.setAttribute('aria-pressed', p.pinned ? 'true' : 'false');
        pin.setAttribute('aria-label', (p.pinned ? '取消釘選 ' : '釘選 ') + p.label);
        pin.title = p.pinned ? '已釘選，不會被驅逐' : '釘選這一頁';
        pin.addEventListener('click', function () {
          p.pinned = !p.pinned;
          AIOS.ui.renderContext();
        });
        li.appendChild(pin);
        list.appendChild(li);
      });

      (evicted || []).forEach(function (p) {
        AIOS.ui.trace('evict ' + p.label + ' (' + fmt(p.tokens) + ' tok) — 超出預算', 't-warn');
      });
    },

    /* ------------------------------------------------------- policy HUD */

    /**
     * The running token total, in the menu bar next to the model.
     *
     * Hidden until something has been spent: a local core costs nothing and a
     * meter reading zero forever is noise. The breakdown is on hover rather than
     * on screen, because the number people glance at is the total.
     */
    renderSpend: function () {
      var el = $('s-spend');
      if (!el) return;
      var s = S.spend || {};
      if (!s.total) { el.hidden = true; return; }
      el.hidden = false;
      el.querySelector('b').textContent = fmt(s.total);
      var since = s.since ? new Date(s.since).toLocaleString() : '未知';
      el.title = '累計用量 ' + s.total.toLocaleString() + ' tok，共 ' + s.turns + ' 次呼叫\n' +
        'prompt ' + s.prompt.toLocaleString() +
        '、回覆 ' + s.output.toLocaleString() +
        (s.thinking ? '、思考 ' + s.thinking.toLocaleString() : '') + '\n' +
        '從 ' + since + ' 起算（跨重開機累計）\n' +
        '點一下歸零';
      el.setAttribute('aria-label',
        '累計用量 ' + s.total + ' tok，共 ' + s.turns + ' 次呼叫，點一下歸零');
    },

    renderCaps: function () {
      var list = $('caps');
      list.innerHTML = '';
      var order = ['allow', 'ask', 'deny'];
      Object.keys(S.policy).forEach(function (cap) {
        var li = el('li');
        var b = el('button', 'cap');
        b.type = 'button';
        b.appendChild(el('span', 'cap-name', cap));
        var state = S.policy[cap];
        b.appendChild(el('span', 'cap-state cap-' + state, state.toUpperCase()));
        /* What this switch actually controls, on hover. Everything starts as
           ALLOW, so the user is the one deciding what to turn down -- and that
           decision needs the description more than a default-deny would. The
           text comes from the main process, which owns the policy; a capability
           with no note falls back to its own name rather than an empty tip. */
        var note = (S.capNotes && S.capNotes[cap]) || '';
        b.title = note ? cap + '\n\n' + note + '\n\n' + T('ui.capClick', '點一下循環切換 ALLOW / ASK / DENY。') : cap;
        b.setAttribute('aria-label',
          T('ui.capAria', '{cap} 目前為 {state}，點擊切換', { cap: cap, state: state }) + (note ? '。' + note : ''));
        b.addEventListener('click', async function () {
          var next = order[(order.indexOf(S.policy[cap]) + 1) % 3];
          b.disabled = true;
          await K.setPolicy(cap, next);
          b.disabled = false;
          K.page('ui/policy', {
            kind: 'ui', label: 'ui/policy', priority: 72,
            text: '能力政策：' + Object.keys(S.policy).map(function (c) { return c + '=' + S.policy[c]; }).join(', ')
          });
          AIOS.ui.renderCaps();
          AIOS.ui.renderContext();
          AIOS.ui.trace('policy: ' + cap + ' → ' + String(S.policy[cap]).toUpperCase() +
            '（由主程序保存）', 't-info');
        });
        li.appendChild(b);
        list.appendChild(li);
      });
    },

    /* ------------------------------------------------------- memory HUD */

    /**
     * The HUD's view of long-term memory. Reads from the main process rather
     * than a local copy, so it always shows what is actually stored.
     */
    renderMemory: async function (hits) {
      var list = $('mem');
      var res = await window.aios.memory.list();
      var items = res && res.ok ? res.data : [];
      S.memoryCount = items.length;

      list.innerHTML = '';
      if (!items.length) {
        var empty = el('li', 'mem-empty', T('ui.memEmpty', '（空的 — 不預載任何內容）'));
        list.appendChild(empty);
        var hint = el('li', 'mem-empty');
        hint.style.marginTop = '4px';
        hint.textContent = T('ui.memHint', '在意圖列說「記住…」，或從 Dock 打開長期記憶自己輸入。');
        list.appendChild(hint);
        return;
      }

      var scores = {};
      (hits || []).forEach(function (h) { scores[h.item.id] = h.score; });

      items.slice(0, 24).forEach(function (it) {
        var li = el('li', 'mem-item' + (scores[it.id] ? ' hit' : ''));
        if (scores[it.id]) li.appendChild(el('span', 'mem-score', scores[it.id].toFixed(2)));
        if (it.pinned) li.appendChild(document.createTextNode('\u2605 '));
        li.appendChild(document.createTextNode(it.text));
        li.title = (it.source === 'learned' ? T('ui.learned', '學習而來') : T('ui.manual', '手動輸入')) +
          (it.useCount ? T('ui.used', '，用過 {n} 次', { n: it.useCount }) : '');
        list.appendChild(li);
      });
    },

    /* ---------------------------------------------------------- journal */

    renderJournal: function () {
      var list = $('journal');
      list.innerHTML = '';
      if (!S.journal.length) {
        list.appendChild(el('li', 'j-empty', T('ui.noActions', '尚無動作')));
        return;
      }
      S.journal.slice(-40).forEach(function (e) {
        var li = el('li', 'j-item ' + (e.status || 'ok'));
        li.appendChild(el('span', 'j-seq', '#' + e.seq));
        var op = el('span', 'j-op', e.op + (e.note ? '  ' + e.note : ''));
        op.title = (e.reason || '') + (e.note ? '\n' + e.note : '');
        li.appendChild(op);
        var b = el('button', 'j-undo', e.undone ? T('ui.undone', '已復原') : T('ui.undo', '復原'));
        b.type = 'button';
        b.disabled = !e.undo || e.undone;
        b.setAttribute('aria-label', T('ui.undoAria', '復原動作 ') + e.op);
        b.addEventListener('click', async function () {
          b.disabled = true;
          var ok = await K.undo(e.seq);
          AIOS.ui.trace((ok ? 'undo #' : 'undo 失敗 #') + e.seq + ' ' + e.op,
            ok ? 't-info' : 't-err');
          AIOS.ui.renderJournal();
          AIOS.ui.renderContext();
        });
        li.appendChild(b);
        list.appendChild(li);
      });
    },

    /* ---------------------------------------------------------- sandbox */

    /** Quota and taint readout. Both are facts the main process reports. */
    renderSandbox: function () {
      var u = S.fsUsage;
      var bar = $('sb-bar');
      var text = $('sb-text');
      var rootEl = $('sb-root');

      if (rootEl) rootEl.textContent = S.sandboxRoot || T('ui.unmounted', '（未掛載）');
      if (!u || !bar) return;

      var pct = Math.min(100, (u.bytes / u.quota.totalBytes) * 100);
      bar.querySelector('i').style.width = pct.toFixed(1) + '%';
      bar.classList.toggle('over', pct > 90);
      text.textContent = AIOS.bytes(u.bytes) + ' / ' + AIOS.bytes(u.quota.totalBytes) +
        '　' + u.files + T('ui.files', ' 檔 / ') + u.quota.files;

      var taintEl = $('sb-taint');
      if (taintEl) {
        var t = S.taint || { tainted: false, sources: [] };
        taintEl.hidden = !t.tainted;
        if (t.tainted) {
          var sum = AIOS.ui.taintSummary(t.sources);
          taintEl.querySelector('.sb-taint-what').textContent =
            T('ui.tainted', '讀過外部內容，寫檔與刪除會先問過你');
          taintEl.querySelector('.sb-taint-count').textContent = sum.counts;
          taintEl.title = T('ui.taintWhy',
            '這個工作階段讀過信件、網頁或 PDF 的內容。' +
            '為了不讓那些內容指揮這台機器，' +
            '寫檔、刪除、連外、寄信、安裝與執行程式，' +
            '在目標不是你自己指名的時候會先問過你。' +
            '按「清除標記」就恢復，已經讀進來的內容不會因此消失。') +
            (sum.recent ? '\n' + T('ui.taintRecent', '最近讀到：') + sum.recent : '');
        }
      }
    },

    /**
     * What the taint badge says, as counts rather than as a list.
     *
     * It used to print every source's label joined by 、, which grew by one
     * entry per message opened: after a morning in the mailbox the panel was a
     * paragraph of subjects, and the one thing it never said was what any of
     * it meant for the person reading it. Counted by kind, the line stays one
     * line however long the session runs, and the labels move to the tooltip
     * where they answer 「which ones?」 without being in the way.
     */
    taintSummary: function (sources) {
      var list = sources || [];
      var order = ['mail', 'search', 'web', 'file', 'app'];
      var word = {
        mail: [T('taint.mail', '信件'), T('taint.mailUnit', ' 封')],
        search: [T('taint.search', '信件搜尋'), T('taint.searchUnit', ' 次')],
        web: [T('taint.web', '網頁'), T('taint.webUnit', ' 個')],
        file: [T('taint.file', '檔案'), T('taint.fileUnit', ' 個')],
        app: [T('taint.app', '程式交出來的資料'), T('taint.appUnit', ' 項')]
      };
      var n = { mail: 0, search: 0, web: 0, file: 0, app: 0 };
      list.forEach(function (s) { n[AIOS.ui.taintKind(s)]++; });
      var parts = order.filter(function (k) { return n[k]; })
        .map(function (k) { return word[k][0] + ' ' + n[k] + word[k][1]; });
      /* Newest first, because the one that just armed it is the one being
         asked about. Five, because a tooltip nobody can read is the problem
         this is fixing. */
      var recent = list.map(function (s, i) { return { s: s, i: i }; })
        /* Ties broken by insertion order: a dozen messages opened in one
           burst share a millisecond, and sorting on the clock alone showed
           the oldest of them as the newest. */
        .sort(function (a, b) { return (b.s.at || 0) - (a.s.at || 0) || b.i - a.i; })
        .slice(0, 5).map(function (x) { return x.s.vpath; }).join('\n');
      return { counts: parts.join('　·　'), recent: recent, total: list.length };
    },

    /** Which kind of thing a taint source is, from the key main stored it under. */
    taintKind: function (s) {
      var src = String((s && s.source) || '');
      if (src.indexOf('mail:search:') === 0) return 'search';
      if (src.indexOf('mail:') === 0) return 'mail';
      if (/^https?:/i.test(src)) return 'web';
      if (src.indexOf('app:') === 0) return 'app';
      return 'file';
    },

    /* -------------------------------------------------------------- dock */

    /* How many minimised windows fit on the strip before the rest go behind a
       single button. Measured rather than chosen: at 1335px the thirteenth
       button's right edge landed at 1366, thirty-one pixels past the screen,
       and the dock neither wrapped nor scrolled -- so that window could not be
       clicked at all. Anything past this count goes in a menu, which cannot run
       off the edge because it is positioned to stay on screen. */
    DOCK_MINS_SHOWN: 6,

    syncDock: function () {
      var host = $('dock-mins');
      var sep = document.querySelector('.dk-min-sep');
      host.innerHTML = '';
      var mins = AIOS.wm.list().filter(function (w) { return w.minimized; });
      sep.hidden = !mins.length;

      var shown = mins.slice(0, this.DOCK_MINS_SHOWN);
      var rest = mins.slice(this.DOCK_MINS_SHOWN);

      shown.forEach(function (w) {
        var b = el('button', 'dk mini', w.title.slice(0, 14));
        b.type = 'button';
        b.title = T('win.restore', '還原 ') + w.title;
        b.addEventListener('click', function () { AIOS.wm.restore(w); });
        host.appendChild(b);
      });

      if (rest.length) {
        var more = el('button', 'dk mini more', '⋯ ' + rest.length);
        more.type = 'button';
        more.title = T('win.moreMin', '還有 {n} 個縮小的視窗', { n: String(rest.length) });
        more.addEventListener('click', function (ev) {
          AIOS.menu.open(more, ev.clientX, ev.clientY, rest.map(function (w) {
            return { label: String(w.title || '').slice(0, 40), run: function () { AIOS.wm.restore(w); } };
          }));
        });
        host.appendChild(more);
      }

      this.syncDockCounts();
      if (AIOS.launcher && AIOS.launcher.refresh) AIOS.launcher.refresh();
    },

    /**
     * The number on each dock button, and what clicking it means.
     *
     * A dock button used to open a new window every time, so the way back to a
     * minimised one was never through the dock -- you got another empty program
     * instead, which reads as the old one having been lost.
     */
    syncDockCounts: function () {
      if (!AIOS.apps || !AIOS.apps.windowsFor) return;
      document.querySelectorAll('.dk[data-dock]').forEach(function (b) {
        var id = b.getAttribute('data-dock');
        var open = AIOS.apps.windowsFor(id === 'memoryApp' ? 'memory' : id);
        var old = b.querySelector('.dk-count');
        if (old) old.remove();
        if (!open.length) { b.classList.remove('has-windows'); return; }
        b.classList.add('has-windows');
        var hidden = open.filter(function (i) { return i.win && i.win.minimized; }).length;
        b.appendChild(el('span', 'dk-count' + (hidden ? ' has-hidden' : ''), String(open.length)));
      });
    },

    /* ------------------------------------------------------------- misc */

    busy: function (on) {
      S.busy = on;
      $('btn-run').disabled = on;
      $('btn-stop').hidden = !on;
      this.link(on ? 'busy' : (S.connected ? 'up' : 'down'));
    }
  };
})();
