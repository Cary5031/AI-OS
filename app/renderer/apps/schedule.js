'use strict';

/* ===========================================================================
   AI-OS // scheduler
   ---------------------------------------------------------------------------
   The window for things this machine does on its own clock, and the hands
   that do them.

   The clock is in the main process (main/schedule.js): it keeps the jobs,
   decides what is due, and sends a firing across the bridge. This file
   catches it and runs it -- an intent through the intent bar's own runner, so
   it queues behind whatever the person is doing and every op it plans passes
   the gate as usual; an action through the same app.do the intent bar uses --
   then reports the outcome back so the clock can record it and set the next
   run. Nothing here decides *whether* a job runs; that is the clock's.

   Two kinds of job, because they cost different things: an action costs no
   model call, an intent costs one every time it fires. The card says which.
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

  /** "5 分鐘", "2 小時", "1 天", "45 秒". */
  function human(secs) {
    var s = Number(secs) || 0;
    if (s % 86400 === 0 && s >= 86400) return (s / 86400) + ' 天';
    if (s % 3600 === 0 && s >= 3600) return (s / 3600) + ' 小時';
    if (s % 60 === 0 && s >= 60) return (s / 60) + ' 分鐘';
    return s + ' 秒';
  }

  function relative(secs) {
    if (secs == null) return '—';
    if (secs <= 0) return '現在';
    if (secs < 60) return secs + ' 秒後';
    if (secs < 3600) return Math.round(secs / 60) + ' 分鐘後';
    if (secs < 86400) return Math.round(secs / 360) / 10 + ' 小時後';
    return Math.round(secs / 8640) / 10 + ' 天後';
  }

  function clock(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleString('zh-TW', { hour12: false });
  }

  /* --------------------------------------------------------------- runner */

  var running = {};

  /**
   * One firing. Reports whatever happened, including a throw, because a job
   * the clock never hears back from is timed out as a failure a quarter of an
   * hour later, and that reads as a hang rather than as the error it was.
   */
  async function handle(job) {
    if (!job || running[job.id]) return;
    running[job.id] = true;
    var t0 = Date.now();
    var tag = job.reason === 'missed' ? '（補跑）' : job.reason === 'manual' ? '（手動）' : '';
    if (AIOS.ui && AIOS.ui.trace) AIOS.ui.trace('[排程] ' + job.name + tag + ' 開始', 't-info');

    var result;
    /* Nobody is here. A job fired by the clock must never stop on a consent
       dialog: it would wait until the scheduler timed it out fifteen minutes
       later, every morning, and the person would find a card saying 「逾時」
       rather than what was actually refused. Manual runs are a person pressing
       a button, so those keep the dialog. */
    var alone = job.reason !== 'manual';
    if (alone) { try { await A.gate.unattended(true); } catch (e) { alone = false; } }
    try {
      if (job.kind === 'intent') {
        var r = await AIOS.intent.run(job.intent, { source: 'schedule' });
        result = r && r.ok === false
          ? { ok: false, note: r.note || '意圖沒有做完' }
          : { ok: true, note: (r && r.note) || '意圖已執行' };
      } else {
        var out = await AIOS.exec['app.do']({ app: job.app, action: job.action, args: job.args || {} });
        result = { ok: true, note: (out && out.note) || '完成' };
      }
    } catch (e) {
      result = { ok: false, note: String((e && e.message) || e) };
    } finally {
      if (alone) { try { await A.gate.unattended(false); } catch (e) { /* nothing to unwind */ } }
    }
    result.ms = Date.now() - t0;
    delete running[job.id];

    try { await A.schedule.report(job.id, result); } catch (e) { /* the clock will time it out */ }
    if (AIOS.ui && AIOS.ui.trace) {
      AIOS.ui.trace('[排程] ' + job.name + (result.ok ? ' 完成' : ' 失敗') + '：' + String(result.note).slice(0, 200),
        result.ok ? 't-ok' : 't-err');
    }
    refreshWindows();
  }

  function refreshWindows() {
    AIOS.apps.instances().forEach(function (i) {
      if (i.def.id === 'schedule' && i.ctx && i.ctx.api && i.ctx.api.refresh) i.ctx.api.refresh();
    });
  }

  AIOS.schedule = {
    /* Called once at boot, after the intent runner exists. ready() is what
       lets the clock fire at all: nothing is marked running with nobody here
       to run it. */
    start: function () {
      A.schedule.onFire(function (job) { handle(job); });
      return A.schedule.ready();
    },
    run: handle,
    human: human
  };

  /* --------------------------------------------------------------- window */

  /** 「每天 08:00」 for a clock-time job, 「每 5 分鐘」 for an interval one. */
  function cadence(j) {
    return j.at ? '每天 ' + j.at : '每 ' + human(j.every);
  }

  function describeJob(j) {
    return j.kind === 'intent'
      ? '規劃「' + j.intent + '」'
      : '執行 ' + j.app + '.' + j.action + (j.args && Object.keys(j.args).length ? ' ' + JSON.stringify(j.args) : '');
  }

  AIOS.apps.register({
    id: 'schedule',
    name: '排程',
    icon: '⏱',
    kind: 'SCHED',
    width: 720,
    height: 540,
    singleton: true,
    purpose: '定時執行程式的動作，或定時把一句需求交給核心',
    chatHint: '可以說「每五分鐘收一次信」、「每小時執行體重趨勢簿的 refresh」，或「取消收信的排程」。',

    actions: {
      add: {
        args: '{name, every, at, intent}',
        desc: '新增一個定時意圖：every 是秒數或 "5m"/"2h"/"1d"，或用 at 給每天的時刻（"08:00"）；intent 是每次要交給核心的一句話（每次都會花一次模型）',
        run: async function (args, ctx) {
          var j = await ctx.api.add({ name: args.name, every: args.every, at: args.at, intent: args.intent });
          return { note: '已新增排程「' + j.name + '」，' + cadence(j) + ' ' + describeJob(j) };
        }
      },
      addAction: {
        args: '{name, every, at, app, action, args}',
        desc: '新增一個定時程式動作（直接執行，不花模型）：app 是程式 id，action 是它發布的動作；every 是間隔，或用 at 給每天的時刻',
        run: async function (args, ctx) {
          var j = await ctx.api.add({ name: args.name, every: args.every, at: args.at, app: args.app, action: args.action, args: args.args });
          return { note: '已新增排程「' + j.name + '」，' + cadence(j) + ' ' + describeJob(j) };
        }
      },
      list: {
        args: '{}', desc: '列出排程',
        run: async function (_a, ctx) {
          var jobs = await ctx.api.refresh();
          return { note: jobs.length ? jobs.map(function (j) {
            return j.name + '（' + cadence(j) + (j.enabled ? '' : '，已暫停') + '，' + j.id + '）';
          }).join('；') : '沒有排程' };
        }
      },
      remove: {
        args: '{id}', desc: '刪除一個排程（給 id 或名稱）',
        run: async function (args, ctx) { return { note: await ctx.api.remove(args.id) }; }
      },
      runNow: {
        args: '{id}', desc: '立刻執行一次（不影響原本的間隔）',
        run: async function (args, ctx) { return { note: await ctx.api.runNow(args.id) }; }
      },
      pause: {
        args: '{id}', desc: '暫停一個排程',
        run: async function (args, ctx) { return { note: await ctx.api.setEnabled(args.id, false) }; }
      },
      resume: {
        args: '{id}', desc: '恢復一個排程',
        run: async function (args, ctx) { return { note: await ctx.api.setEnabled(args.id, true) }; }
      }
    },

    mount: function (ctx) {
      ctx.body.classList.add('flush');
      var jobs = [];

      var intro = el('div', 'sc-intro');
      intro.appendChild(el('h3', null, '定時做事'));
      intro.appendChild(el('p', 'sc-note',
        '兩種工作：「程式動作」直接執行某個程式發布的動作，不花模型；「意圖」每次把一句話交給核心規劃，' +
        '雲端核心就每次花錢。只在 AI-OS 開著時執行；關機期間錯過的會在下次開機後補跑一次。'));
      /* This paragraph used to say a consent window would open and wait. It no
         longer does -- a window nobody is there to answer is not a question, it
         is a fifteen-minute hang -- so what it says now is what actually
         happens, and the one thing the user can do about it. */
      intro.appendChild(el('p', 'sc-note',
        '排程是在你不在的時候跑的，所以碰到需要授權的動作不會跳視窗，會當場擋下來並把原因寫進結果裡。' +
        '最常見的是：排程讀了信（信是不可信內容），接著要寫檔，而那句話沒說要寫到哪裡。' +
        '解法是把目標寫進排程的那句話——寫到目錄就夠，例如「…追加到 /notes」。' +
        '手動按「立即執行」時你在畫面前，那時授權視窗照跳。'));
      ctx.body.appendChild(intro);

      /* ------------------------------------------------------------ form */
      var form = el('form', 'sc-form');
      var name = el('input');
      name.placeholder = '名稱，例如「收信」';
      name.setAttribute('aria-label', '排程名稱');
      name.className = 'sc-full';
      form.appendChild(name);

      var everyRow = el('div', 'sc-row');
      everyRow.appendChild(el('span', 'sc-note', '每'));
      var everyN = el('input');
      everyN.type = 'number'; everyN.min = '1'; everyN.value = '5';
      everyN.setAttribute('aria-label', '間隔數字');
      var everyU = el('select');
      [['m', '分鐘'], ['s', '秒'], ['h', '小時'], ['d', '天']].forEach(function (u) {
        var o = el('option', null, u[1]); o.value = u[0]; everyU.appendChild(o);
      });
      everyU.setAttribute('aria-label', '間隔單位');
      everyRow.appendChild(everyN);
      everyRow.appendChild(everyU);
      form.appendChild(everyRow);

      var kindRow = el('div', 'sc-kind');
      var kindAction = el('input'); kindAction.type = 'radio'; kindAction.name = 'sc-kind'; kindAction.value = 'action'; kindAction.checked = true;
      var kindIntent = el('input'); kindIntent.type = 'radio'; kindIntent.name = 'sc-kind'; kindIntent.value = 'intent';
      var la = el('label'); la.appendChild(kindAction); la.appendChild(document.createTextNode(' 程式動作（不花模型）'));
      var li = el('label'); li.appendChild(kindIntent); li.appendChild(document.createTextNode(' 意圖（每次規劃）'));
      kindRow.appendChild(la); kindRow.appendChild(li);
      form.appendChild(kindRow);

      var appSel = el('select');
      appSel.setAttribute('aria-label', '程式');
      var actSel = el('select');
      actSel.setAttribute('aria-label', '動作');
      var argsIn = el('input');
      argsIn.placeholder = '參數 JSON，例如 {"folder":"INBOX"}（可留空）';
      argsIn.setAttribute('aria-label', '參數');
      argsIn.className = 'sc-full';
      var intentIn = el('textarea');
      intentIn.rows = 2;
      intentIn.placeholder = '每次要交給核心的一句話，例如「看看有沒有新信，重要的摘要給我」';
      intentIn.setAttribute('aria-label', '意圖');
      intentIn.className = 'sc-full';
      intentIn.hidden = true;

      function fillApps() {
        appSel.innerHTML = '';
        AIOS.apps.list().filter(function (d) {
          return d.id !== 'schedule' && d.actions && Object.keys(d.actions).length;
        }).forEach(function (d) {
          var o = el('option', null, d.name + '（' + d.id + '）'); o.value = d.id; appSel.appendChild(o);
        });
        fillActions();
      }
      function fillActions() {
        actSel.innerHTML = '';
        var def = AIOS.apps.get(appSel.value);
        Object.keys((def && def.actions) || {}).forEach(function (k) {
          var o = el('option', null, k + ' ' + (def.actions[k].args || '{}') + (def.actions[k].desc ? '　' + def.actions[k].desc : ''));
          o.value = k; actSel.appendChild(o);
        });
      }
      appSel.addEventListener('change', fillActions);
      form.appendChild(appSel);
      form.appendChild(actSel);
      form.appendChild(argsIn);
      form.appendChild(intentIn);

      function syncKind() {
        var intent = kindIntent.checked;
        appSel.hidden = intent; actSel.hidden = intent; argsIn.hidden = intent;
        intentIn.hidden = !intent;
      }
      kindAction.addEventListener('change', syncKind);
      kindIntent.addEventListener('change', syncKind);

      var submit = el('button', 'fbtn fbtn-primary', '新增排程');
      submit.type = 'submit';
      submit.className += ' sc-full';
      form.appendChild(submit);
      ctx.body.appendChild(form);

      var list = el('ul', 'sc-list');
      list.setAttribute('aria-label', '排程清單');
      ctx.body.appendChild(list);

      /* ------------------------------------------------------------ paint */
      function paint() {
        list.innerHTML = '';
        if (!jobs.length) {
          list.appendChild(el('li', 'sc-note', '還沒有排程。上面新增一個，或在意圖列說「每五分鐘收一次信」。'));
          return;
        }
        jobs.forEach(function (j) {
          var card = el('li', 'sc-card' + (j.enabled ? '' : ' off'));
          var head = el('div', 'sc-head');
          head.appendChild(el('span', 'sc-name', j.name));
          head.appendChild(el('span', 'sc-badge', j.kind === 'intent' ? '意圖' : '動作'));
          head.appendChild(el('span', 'sc-badge', cadence(j)));
          if (j.running) head.appendChild(el('span', 'sc-badge', '執行中'));
          card.appendChild(head);
          card.appendChild(el('div', 'sc-what', describeJob(j)));
          var meta = el('div', 'sc-meta' + (j.lastResult ? (j.lastResult.ok ? ' ok' : ' err') : ''),
            (j.enabled ? '下次：' + relative(j.dueIn) : '已暫停') +
            '　已執行 ' + (j.runs || 0) + ' 次' +
            (j.lastResult ? '　上次 ' + clock(j.lastResult.at) + '：' + (j.lastResult.ok ? '✓ ' : '✕ ') + j.lastResult.note : ''));
          card.appendChild(meta);

          var acts = el('div', 'sc-actions');
          var run = el('button', 'fbtn', '立即執行'); run.type = 'button';
          run.disabled = !!j.running;
          run.addEventListener('click', function () { runNow(j.id).then(function (n) { ctx.toast(n, 't-info'); }); });
          var toggle = el('button', 'fbtn', j.enabled ? '暫停' : '恢復'); toggle.type = 'button';
          toggle.addEventListener('click', function () { setEnabled(j.id, !j.enabled); });
          var del = el('button', 'fbtn fbtn-danger', '刪除'); del.type = 'button';
          del.addEventListener('click', async function () {
            var ok = await ctx.confirm({ label: '刪除排程「' + j.name + '」？', okLabel: '刪除', danger: true });
            if (ok) remove(j.id).then(function (n) { ctx.toast(n, 't-ok'); });
          });
          acts.appendChild(run); acts.appendChild(toggle); acts.appendChild(del);
          card.appendChild(acts);
          list.appendChild(card);
        });
      }

      async function refresh() {
        var r = await A.schedule.list();
        jobs = r.ok ? r.data : [];
        paint();
        return jobs;
      }

      function findJob(ref) {
        var key = String(ref || '').trim();
        var hit = jobs.find(function (j) { return j.id === key; }) ||
          jobs.find(function (j) { return j.name === key; });
        if (!hit && key) {
          var pre = jobs.filter(function (j) { return j.name.indexOf(key) === 0; });
          if (pre.length === 1) hit = pre[0];
        }
        if (!hit) throw new Error('沒有這個排程：' + key + (jobs.length ? '。現有：' + jobs.map(function (j) { return j.name; }).join('、') : ''));
        return hit;
      }

      async function add(job) {
        var r = await A.schedule.add(job);
        if (!r.ok) throw new Error(r.error);
        await refresh();
        return r.data;
      }
      async function remove(ref) {
        await refresh();
        var j = findJob(ref);
        var r = await A.schedule.remove(j.id);
        if (!r.ok) throw new Error(r.error);
        await refresh();
        return '已刪除排程「' + j.name + '」';
      }
      async function runNow(ref) {
        await refresh();
        var j = findJob(ref);
        var r = await A.schedule.runNow(j.id);
        if (!r.ok) throw new Error(r.error);
        await refresh();
        return '已開始執行「' + j.name + '」，結果會寫在核心軌跡';
      }
      async function setEnabled(ref, on) {
        await refresh();
        var j = findJob(ref);
        var r = await A.schedule.update(j.id, { enabled: !!on });
        if (!r.ok) throw new Error(r.error);
        await refresh();
        return (on ? '已恢復' : '已暫停') + '排程「' + j.name + '」';
      }

      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var payload = { name: name.value.trim(), every: everyN.value + everyU.value };
        if (kindIntent.checked) {
          payload.intent = intentIn.value.trim();
        } else {
          payload.app = appSel.value;
          payload.action = actSel.value;
          var raw = argsIn.value.trim();
          if (raw) {
            try { payload.args = JSON.parse(raw); } catch (err) { ctx.toast('參數不是合法的 JSON', 't-err'); return; }
          }
        }
        try {
          var j = await add(payload);
          ctx.toast('已新增排程「' + j.name + '」', 't-ok');
          name.value = ''; intentIn.value = ''; argsIn.value = '';
        } catch (err) {
          ctx.toast('新增失敗：' + (err.message || err), 't-err');
        }
      });

      ctx.describe(function () {
        return '排程（只在 AI-OS 開著時執行；無人值守，需要授權的動作會被擋下而不是跳視窗，' +
          '所以會寫檔的那句話要自己寫出目標路徑）：\n' +
          (jobs.length ? jobs.map(function (j) {
            return '  ' + j.id + '　' + j.name + '　' + cadence(j) + '　' + describeJob(j) +
              (j.enabled ? '' : '　（已暫停）') +
              (j.lastResult ? '　上次：' + (j.lastResult.ok ? '成功' : '失敗') + ' ' + j.lastResult.note : '');
          }).join('\n') : '  （沒有）') +
          '\n可用的程式與動作，用 app.do 的簽名；意圖類的排程每次都會花一次模型。';
      });

      ctx.setMenu(function () {
        return [
          { label: '重新讀取', run: refresh },
          { label: '重新載入程式清單', run: fillApps },
          { sep: true },
          { label: '把焦點移到名稱欄', run: function () { name.focus(); } }
        ];
      });

      ctx.api = {
        refresh: refresh,
        add: add,
        remove: remove,
        runNow: runNow,
        setEnabled: setEnabled
      };

      fillApps();
      syncKind();
      refresh();

      return {
        api: ctx.api,
        getState: function () { return {}; }
      };
    }
  });
})();
