/* ===========================================================================
   AI-OS // init + the intent pipeline
   ---------------------------------------------------------------------------
   intent -> plan -> gate -> exec, with the journal written as it goes.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var K = AIOS.kernel;
  var S = AIOS.state;
  var UI = AIOS.ui;

  function $(id) { return document.getElementById(id); }

  /* Starters for the intent bar. A chip only fills the input, it does not run,
     so one may name a capability the policy will stop and ask about.

     Each of these has to be something the pipeline can actually finish: a chip
     that walks the model into an op that does not exist is worse than no chip,
     because the failure looks like the machine is broken rather than like the
     suggestion was wrong. */
  var CHIPS = [
    '設一個 25 分鐘的專注計時器',
    '開文件程式，我要寫這週的工作報告',
    '開一份新試算表，我要做這個月的開銷表',
    '開簡報，我要做三頁的專案進度報告',
    '記住我偏好回覆用繁體中文、程式碼註解用英文',
    '把視窗排列整齊'
  ];

  /** The interface language's word for it, or the Chinese when there is none. */
  function T(key, zh, vars) { return AIOS.i18n ? AIOS.i18n.t(key, zh, vars) : zh; }

  /* ===================================================================
     machine state -> context
     =================================================================== */

  function refreshMachineState() {
    var wins = AIOS.wm.list().filter(function (w) { return !w.minimized; });
    var lines = [];
    lines.push('開啟的視窗：' + (wins.length
      ? wins.map(function (w) { return '「' + w.title + '」(' + w.kind + ')'; }).join('、')
      : '無'));

    // Ground the paths in what is actually on disk. Without the real listing
    // the model invents filenames, and a syscall with a made-up argument just
    // fails. Directories are included so it can target them for writes.
    lines.push('沙箱檔案系統（完整清單，只能用這些路徑）：');
    var dirs = AIOS.fs.cache.dirs || [];
    dirs.slice().sort().forEach(function (d) { lines.push('  ' + d + '/'); });
    (AIOS.fs.cache.files || []).slice()
      .sort(function (a, b) { return a.vpath < b.vpath ? -1 : 1; })
      .forEach(function (f) {
        lines.push('  ' + f.vpath + (f.untrusted ? '  [不可信來源]' : ''));
      });
    if (!(AIOS.fs.cache.files || []).length) lines.push('  （沙箱是空的）');

    var u = S.fsUsage;
    if (u) {
      lines.push('沙箱用量：' + AIOS.bytes(u.bytes) + ' / ' +
        AIOS.bytes(u.quota.totalBytes) + '，' + u.files + ' 個檔案');
    }
    lines.push('長期記憶：' + (S.memoryCount || 0) + ' 筆（用 memory.recall 檢索）');

    var apps = AIOS.apps.list();
    lines.push('可開啟的程式（app.open 的 app 參數）：' +
      apps.map(function (d) { return d.id; }).join('、'));

    var open = AIOS.apps.instances();
    if (open.length) {
      lines.push('目前開著的程式：' + open.map(function (i) { return i.def.name; }).join('、'));
    }

    /* The user's own themes, by the names theme.set accepts. The built-ins are
       in the syscall table already; these exist only on this machine, so the
       model can learn them nowhere else. */
    var own = AIOS.themes && AIOS.themes.custom ? AIOS.themes.custom : [];
    if (own.length) {
      lines.push('自訂主題（theme.set 的 mode 可以填這些名稱）：' + own.map(function (t) { return t.name; }).join('、'));
    }

    K.page('ui/machine', { kind: 'ui', label: 'ui/machine', priority: 70, text: lines.join('\n') });
  }
  AIOS.refreshMachineState = refreshMachineState;

  /* ===================================================================
     the pipeline
     =================================================================== */

  /** Ask the model for one plan. Returns null if the request failed. */
  async function planRound(promptText, label) {
    UI.phase('plan', 'active');
    UI.trace('prompt: ' + S.pages.length + ' 個常駐分頁 / ' + K.usage().used + ' tok', 't-info');

    var sink = UI.traceStream(label + ' ← ');
    try {
      var res = await K.plan(promptText, function (piece) { sink.push(piece); });
      sink.done();
      UI.phase('plan', 'done');
      UI.telemetry(res.timings);
      if (res.retried) UI.trace('第一次受限解碼失敗，已用寬鬆解析重試', 't-warn');
      if (res.finish === 'length') {
        UI.trace('計畫在長度上限處被切斷 —— 思考的 token 也算在同一個上限裡，' +
          '到「系統 → 核心模型」調高「輸出上限」，或把思考模式調低', 't-warn');
      }
      K.addSpend(res.spend);
      if (res.spend && S.remote) {
        UI.trace('用量：prompt ' + res.spend.prompt + '、計畫 ' + res.spend.output +
          (res.spend.thinking ? '、思考 ' + res.spend.thinking +
            (res.spend.thinkingHidden ? '（供應商只算在總數裡）' : '') : '') +
          '、合計 ' + res.spend.total + ' tok', 't-info');
      }
      if (res.plan.understanding) UI.trace('理解：' + res.plan.understanding, 't-info');
      UI.trace('計畫：' + (res.plan.actions.length
        ? res.plan.actions.map(function (a) { return a.op; }).join(' → ')
        : '（無動作）'), 't-info');
      if (res.plan.dropped) {
        UI.trace('計畫超過一回合上限，後面 ' + res.plan.dropped +
          ' 個動作這一輪不做，下一輪接著做', 't-warn');
      }
      return res;
    } catch (e) {
      sink.done(' ✕');
      UI.phase('plan', null);
      if (e && e.name === 'AbortError') {
        UI.trace('已中止', 't-warn');
      } else if (e instanceof TypeError || /Failed to fetch|NetworkError|load failed/i.test(String(e.message || e))) {
        // The model host went away mid-request (llama-server crash, restart,
        // port change). Drop the link so the next intent reconnects first.
        S.connected = false;
        UI.link('down');
        UI.trace('與模型伺服器的連線中斷了。確認 llama-server 還活著，再按右上角 LED 重連。', 't-err');
      } else {
        UI.trace('規劃失敗：' + (e.message || e), 't-err');
      }
      return null;
    }
  }

  /**
   * Execute the plan action by action.
   *
   * The gate itself is not here any more. Filesystem ops are authorised inside
   * the main process, which owns the policy and the consent window, so this
   * loop cannot approve anything: it asks, and reports what came back. The
   * local preview is used only to label the trace before the call goes out.
   */
  async function gateAndExec(plan, seen) {
    UI.phase('gate', 'active');
    var results = [];
    var failed = 0;
    // Which ops actually ran. The caller needs this to tell a plan that finished
    // from a plan that only fetched something and stopped -- see runIntent.
    var ran = [];

    for (var i = 0; i < plan.actions.length; i++) {
      var a = plan.actions[i];

      // A repair round tends to restate steps that already succeeded. Running
      // them twice is at best wasted work and at worst a duplicated write.
      var fingerprint = a.op + '|' + JSON.stringify(a.args || {});
      if (seen[fingerprint]) {
        UI.trace('skip ' + a.op + ' — 這一回合已經做過了', 't-info');
        continue;
      }

      /* `reply` is the turn's answer to the user, and the planner wrote it
         before any of this ran -- it describes the world the plan expected to
         create. Delivering it after an earlier step failed states something
         untrue as fact.

         Measured: 「再記今天喝了 750 毫升，然後告訴我今天總共喝多少」 planned
         app.do → reply. The write failed on a wrong parameter name; the reply
         went out anyway saying 「今天總共喝了 2,250 毫升」. The program held one
         record of 1,500. The number was arithmetic on an event that never
         happened.

         So a reply behind a failure is held, and the repair round -- which now
         knows what actually went wrong -- writes the real answer. */
      if (a.op === 'reply' && failed > 0) {
        UI.trace('hold reply — 前面有 ' + failed + ' 個動作失敗，這句回覆是照原計畫寫的，先不送出',
          't-warn');
        results.push('✕ reply：前面的動作失敗了，這句回覆沒有送出（內容是照原計畫預先寫好的）');
        continue;
      }

      if (a.unknown || !AIOS.exec[a.op]) {
        K.record({ op: a.op || '(空)', status: 'blocked', reason: '不在 syscall 表內', note: '未知呼叫' });
        UI.trace('reject ' + (a.op || '(空)') + ' — 不在 syscall 表內', 't-err');
        results.push('✕ ' + a.op + '：不存在這個系統呼叫');
        continue;
      }

      var pv = K.preview(a);
      if (pv.decision === 'deny') {
        UI.trace('deny ' + a.op + ' — ' + pv.reason, 't-err');
      } else if (pv.decision === 'ask') {
        UI.trace((pv.taint ? 'taint-gate ' : 'ask ') + a.op + ' — ' + pv.reason,
          pv.taint ? 't-taint' : 't-warn');
      }

      UI.phase('gate', 'done');
      UI.phase('exec', 'active');

      try {
        var out = await AIOS.exec[a.op](a.args || {});
        seen[fingerprint] = true;
        K.record({
          op: a.op, args: a.args, status: pv.decision === 'ask' ? 'asked' : 'ok',
          reason: pv.reason, note: out && out.note, undo: out && out.undo
        });
        ran.push(a.op);
        UI.trace('exec ' + a.op + ' — ' + ((out && out.note) || 'ok'), 't-ok');
        results.push('✓ ' + ((out && out.note) || a.op));
      } catch (err) {
        // A refusal from the main process is not a bug, it is the gate working.
        var refused = err.code === 'EREFUSED' || err.code === 'EDENIED';
        if (!refused) failed++;
        else seen[fingerprint] = true;

        K.record({
          op: a.op, args: a.args, status: 'blocked',
          reason: String(err.message || err),
          note: refused ? '未獲授權' : '執行失敗'
        });
        UI.trace((refused ? 'blocked ' : 'fail ') + a.op + ' — ' + (err.message || err),
          't-err');
        results.push('✕ ' + a.op + '：' + (err.message || err));
      }
      UI.renderJournal();
      await K.refreshTaint();
    }

    UI.phase('gate', 'done');
    UI.phase('exec', 'done');
    return { results: results, failed: failed, ran: ran };
  }

  /**
   * Did this round leave a mark, or did it only go and fetch something?
   *
   * `reply` ends a turn by answering it, and an op whose capability is ELEVATED
   * is one that changes data, sends it off the machine, or installs code -- the
   * gate's own definition, reused here rather than restated as a second list
   * that would drift the first time an op is added.
   *
   * `app.do` is the hard one, and two measurements bracket it. A round that
   * built a seven-slide deck, set its font and saved it to /notes left no
   * ELEVATED op behind -- `app.do` carries `app.run`, which is not elevated
   * because running an application the machine already trusts is not the thing
   * worth asking about -- and was read as having done nothing, so the next round
   * built the same deck again. Answering that with "app.do always settles" then
   * broke the other direction: `app.do` on the PDF reader's readIntoContext
   * fetches and nothing else, and the round that only fetched was called
   * finished.
   *
   * The op name cannot tell those apart, so this does not ask it. It asks what
   * changed: a file appeared on disk, or a document in a window now has unsaved
   * work in it. Both are things the user would lose, which is the same question
   * "did this round leave a mark" was always trying to ask.
   */
  function marks() {
    /* Only the windows that hold unsaved work, never the list of open windows.
       Counting every instance made opening one a mark, and opening one is the
       "only fetched" case this is here to recognise: 「把 docx 做成簡報」 planned
       app.open, the new window changed the fingerprint, the round was called
       finished, and the deck was never built. */
    var dirty = AIOS.apps.instances().filter(function (i) {
      var c = i.ctrl;
      try { return !!(c && typeof c.unsaved === 'function' && c.unsaved()); } catch (e) { return false; }
    }).map(function (i) { return i.def.id; }).sort().join('|');
    return AIOS.fsWrites + '#' + dirty;
  }

  function settles(ops, before, after) {
    if (before !== undefined && before !== after) return true;
    return (ops || []).some(function (op) {
      if (op === 'reply') return true;
      var def = AIOS.OPS[op];
      return !!(def && AIOS.ELEVATED.indexOf(def.cap) >= 0);
    });
  }

  /** Write what actually happened back into context, blocks included. */
  async function closeTurn(plan, results, round) {
    var summary = (plan.understanding ? plan.understanding + '\n' : '') +
      (results.length ? results.join('\n') : '（沒有執行任何動作）');
    var page = K.page('turn/' + S.turnSeq + ':kernel' + (round > 1 ? round : ''), {
      kind: 'turn', role: 'assistant', priority: 51, text: summary
    });
    await K.measure(page);

    // Age older turns so the scheduler prefers evicting them first.
    S.pages.forEach(function (p) {
      if (p.kind === 'turn' && p.priority > 20) p.priority -= 2;
    });

    refreshMachineState();
    UI.renderContext(K.schedule());
    UI.renderJournal();
  }

  /* How far one intent may go. Rounds bound what it costs; stalled rounds bound
     going nowhere. Five is enough for read -> act -> repair with a step to
     spare, which the old shared cap of two could not reach.

     A plan that sets `more` is walking a sequence it cannot see the end of --
     「攻擊到打贏為止」 is four or five rounds of one action each -- so it gets a
     larger budget of its own. Larger and still bounded: every round is a model
     call, and an intent that would run forever should stop and say so rather
     than quietly spend. MAX_STALLED still applies, so a loop that stops making
     progress ends immediately whichever budget it is on. */
  var MAX_ROUNDS = 5;
  var MAX_STEP_ROUNDS = 14;
  /* Repairing is not the same kind of work as planning, and it used to be given
     the smaller budget by accident: the repair branch cleared `stepping`, so a
     turn that had earned the larger budget dropped back to five the moment
     something failed -- which is exactly when it needs the rounds. Reported as
     「他明明還沒修正完成，但因為回合限制而停止」, and it is the same shape as the
     failure in the mail run: the work was not too large, the budget was
     withdrawn at the wrong moment. */
  var MAX_REPAIR_ROUNDS = 12;
  var MAX_STALLED = 2;

  /** Resident pages holding content read in from a file, a page or a mailbox. */
  /**
   * A fingerprint of the content this turn has to work from.
   *
   * Counting `data` pages alone was right while `fs.read` was the only way to
   * bring anything in. Opening a document is the other way, and what it brings
   * arrives as the application's own published page -- `app/docs` and the like,
   * kind `ui`. So a plan that opened a report and stopped looked to the loop
   * exactly like a plan that had done nothing: no continuation round, and the
   * turn ended with the report on screen and the user's goal untouched.
   *
   * Length rather than presence, because an application's page is rewritten
   * every time its state changes: it is already there when the round starts and
   * only its content is new.
   */
  function contentPrint() {
    var out = {};
    S.pages.forEach(function (p) {
      if (p.kind === 'data' || (p.kind === 'ui' && /^app\//.test(p.label || ''))) {
        out[p.id] = String(p.text || '').length;
      }
    });
    return out;
  }

  /** How many of those pages appeared, or grew, across a round. */
  function contentGained(before, after) {
    var n = 0;
    Object.keys(after).forEach(function (id) {
      /* A little longer is an application redrawing itself; a lot longer is a
         document arriving. The threshold keeps a cursor move from looking like
         new material and starting a round nobody needed. */
      if (!(id in before) || after[id] - before[id] > 80) n++;
    });
    return n;
  }

  var CONTINUE_NOTE =
    '（系統事件：上一份計畫只把內容讀進來，還沒有完成使用者交代的事。' +
    '那些內容現在就在上面的「讀進來的內容」區塊裡，直接根據它把事情做完。' +
    '不要重讀已經讀過的檔案；寫檔的 content 要用你從那份內容整理出來的真正文字。' +
    '如果使用者要的其實只是知道內容，那就用 reply 回答。)';

  /* The continue note above tells the model its plan only read something. That
     is the wrong thing to say when the plan was cut for length -- it did act,
     and what it needs is the rest of its own plan, not a re-read. */
  var RESUME_NOTE =
    '（系統事件：上一份計畫太長，一回合最多只執行 6 個動作，後面的被留到這一輪。' +
    '前面已經做完的步驟不要重做，直接規劃剩下還沒做的那些——' +
    '通常最後那個存檔或匯出的動作就在裡面。）';

  /* "Do not redo what succeeded" is right, and on its own it produced a wrong
     file: the plan saved the spreadsheet and then a later action failed, the
     repair round fixed the document, and the .xlsx on disk kept the version
     from before the fix -- correct numbers, missing borders, and nothing saying
     the file and the window had drifted apart. A save is only as good as the
     last change before it. */
  /* The planner asked for this round by setting more. It knows what it was
     doing; what it needs is the results, not an explanation of its own plan. */
  var STEP_NOTE =
    '（系統事件：你上一份計畫標了 more: true，執行結果就在上面。' +
    '照結果決定接下來要做什麼，把使用者交代的事做完。已經做過的不要重做；' +
    '如果剩下的還是要看結果才能決定，可以再標一次 more。事情做完就用 reply 回答。）';

  var REPAIR_NOTE =
    '（系統事件：上一份計畫裡有動作執行失敗，錯誤訊息已經在上面的執行結果裡。' +
    '請只針對失敗的部分重新規劃，已經成功的步驟不要重做。路徑只能用「機器狀態」裡列出的那些。' +
    '注意：如果上一輪已經存檔或匯出過，而這次修復又改到了那份文件，' +
    '就要在修完之後再存一次，否則檔案裡是修好之前的版本。）';

  /* Intents typed while one is running. They used to be dropped on the floor:
     `if (S.busy) return` -- and an intent that built a program held `busy` for
     the whole build, so for ten minutes every other request silently vanished.
     Builds no longer hold the turn (app.create returns as soon as the build has
     started), and what does hold it is queued rather than lost, in order.
     One at a time on purpose: two plans mutating the same machine state at
     once is not concurrency, it is a race. */
  var pendingIntents = [];   // { text, resolve }

  /**
   * Run an intent, now or after the one in progress. Resolves when this
   * intent has actually run -- a queued one waits its turn -- with
   * { ok, note }, which is what the scheduler records for a timed intent.
   */
  async function runIntent(text) {
    text = String(text || '').trim();
    if (!text) return { ok: false, note: '沒有內容' };
    if (S.busy) {
      return new Promise(function (resolve) {
        pendingIntents.push({ text: text, resolve: resolve });
        UI.trace('核心正在處理上一個意圖，這一個已排入（第 ' + pendingIntents.length + ' 個）：' +
          text.slice(0, 60), 't-warn');
        $('intent-input').value = '';
        autoGrow($('intent-input'));
      });
    }
    var outcome = { ok: true, note: '' };
    try {
      outcome = (await runIntentNow(text)) || outcome;
    } catch (e) {
      UI.trace('意圖執行時出錯：' + ((e && e.message) || e), 't-err');
      outcome = { ok: false, note: String((e && e.message) || e) };
    } finally {
      /* Always, or a thrown executor leaves the bar disabled until reboot --
         the one way this machine could actually lock up. */
      UI.busy(false);
      if (pendingIntents.length) {
        var next = pendingIntents.shift();
        UI.trace('接著處理排入的意圖：' + next.text.slice(0, 60), 't-info');
        setTimeout(function () { runIntent(next.text).then(next.resolve); }, 0);
      }
    }
    return outcome;
  }

  /* The intent bar as a service: the scheduler hands a job's sentence in here
     and gets the outcome back, on the same queue a person's typing uses. */
  AIOS.intent = { run: runIntent };

  /**
   * The kernel page -- the syscall table and the rules -- is primed a few
   * steps after the model connects. An intent submitted in that gap was
   * planned against a 129-token prompt with no syscalls in it, and the model,
   * told nothing, improvised a JSON of its own: `{"type":"inspect"}` and a
   * paragraph about the sandbox being empty. Measured by a script that typed
   * the moment `connected` went true; a person can type that fast too.
   */
  async function waitForKernelPage() {
    for (var i = 0; i < 120; i++) {
      if (S.pages.some(function (p) { return p.id === 'sys/kernel' && p.text; })) return true;
      await new Promise(function (r) { window.setTimeout(r, 250); });
    }
    return false;
  }

  async function runIntentNow(text) {
    if (!S.connected) {
      UI.trace('沒有連上模型伺服器，先嘗試重新連線…', 't-warn');
      var ok = await reconnect();
      if (!ok) return { ok: false, note: '沒有連上模型伺服器' };
    }
    if (!(await waitForKernelPage())) {
      UI.trace('開機序列還沒完成（核心規則頁尚未載入），這個意圖沒有執行，請再送一次', 't-err');
      return { ok: false, note: '開機序列還沒完成' };
    }

    UI.busy(true);
    UI.resetPhases();
    /* What this turn amounted to, for whoever asked programmatically. */
    var finished = true;
    var lastNote = '';

    /* Tell the gate what was actually asked for, before anything runs.
       It uses this to tell an instruction the user gave from one that arrived
       inside a document: a write to a path named in this sentence is theirs, a
       write to somewhere they never mentioned is the case the taint downgrade
       exists for. Sent every turn, so a previous request cannot vouch for this
       one. */
    await window.aios.intent.set(text);

    /* --- phase 1: intent ------------------------------------------- */
    UI.phase('intent', 'active');
    UI.trace('intent: ' + text, 't-hi');

    var turn = K.page('turn/' + (++S.turnSeq) + ':user', {
      kind: 'turn', role: 'user', priority: 52, text: text
    });
    await K.measure(turn);
    refreshMachineState();

    // Prefetch from the warm tier before planning. A page fault on this
    // machine is a retrieval, and the scheduler does it rather than waiting
    // for the model to ask -- same reason a real OS reads ahead.
    var found = await window.aios.memory.search(text, 4);
    var hits = found && found.ok ? found.data : [];
    await UI.renderMemory(hits);
    if (hits.length) {
      hits.forEach(function (h) {
        K.page('mem/' + h.item.id, {
          kind: 'mem', label: 'mem/' + h.item.id, priority: 60, text: h.item.text
        });
      });
      await window.aios.memory.markUsed(hits.map(function (h) { return h.item.id; }));
      UI.trace('page-in: 預取 ' + hits.length + ' 筆記憶（分數 ' +
        hits.map(function (h) { return h.score.toFixed(2); }).join(', ') + '）', 't-ok');
    }

    UI.renderContext(K.schedule());
    UI.phase('intent', 'done');

    /* --- plan -> gate -> exec, with one repair round ---------------- */
    // A single-shot plan cannot see the results of its own steps, so a wrong
    // path or a missing window just fails. One repair round, with the error
    // text in context, fixes most of it. Bounded at two rounds on purpose:
    // an unbounded retry loop on a 24 GB local model is a way to waste minutes.
    var prompt = text;
    var mode = 'plan';
    var round = 0;
    var stalled = 0;
    var seen = {};
    /* Set for the round after a plan asked to continue. It changes two things:
       the budget above, and whether a repeated action counts as a duplicate. */
    var stepping = false;
    var cap = MAX_ROUNDS;
    for (;;) {
      round++;
      if (round > 1) { UI.resetPhases(); UI.phase('intent', 'done'); }

      var res = await planRound(prompt, mode);
      if (!res) { finished = false; lastNote = '規劃失敗'; break; }

      // Content the plan could not have seen when it was written arrives as
      // `data` pages during execution, so count them across the round.
      var contentBefore = contentPrint();
      var marksBefore = marks();
      var outcome = await gateAndExec(res.plan, seen);
      await closeTurn(res.plan, outcome.results, round);
      var gained = contentGained(contentBefore, contentPrint());

      /* Two limits, because they are two different failure modes.
         MAX_ROUNDS bounds the cost of one intent. MAX_STALLED bounds going
         nowhere: a round that ran nothing new and pulled nothing in has
         repeated itself, and a model that repeats itself twice will keep
         repeating itself. Sharing one counter -- which is what `round < 2`
         did -- meant a read round spent the budget the repair round needed,
         so "read it, do it, one step fails" had no recovery left. */
      if (outcome.ran.length || gained > 0) stalled = 0; else stalled++;
      /* The budget only ever grows. Work that turns out to need repairing, or
         to be one step of a sequence, has earned the larger allowance, and
         taking it away again on the next round is how a turn stops halfway
         through fixing itself. MAX_STALLED is what still ends a loop going
         nowhere, and it does not care which budget is in force. */
      if (outcome.failed) cap = Math.max(cap, MAX_REPAIR_ROUNDS);
      if (res.plan.more) cap = Math.max(cap, MAX_STEP_ROUNDS);
      if (stepping) cap = Math.max(cap, MAX_STEP_ROUNDS);
      var room = round < cap && stalled < MAX_STALLED;
      /* Three ways a round can leave the job open, and the third was silent
         until it was watched happening: a plan longer than one round's cap had
         its tail thrown away, and the tail is where the save is. Measured:
         「統計、上色、加框線、存成 xlsx」 planned seven actions, six ran, all six
         succeeded, and the turn ended with no file and nothing saying why. */
      var left = settles(outcome.ran, marksBefore, marks());
      /* `plan.more` is the planner saying its plan was one step of something
         longer. Everything else here is the machine inferring that from what
         changed, and inference cannot see a conditional: 「探索一次，遇到怪物就打
         到贏，然後告訴我等級」 planned a single explore -- correctly, because what
         comes next depends on what the explore returns -- and the turn ended
         there with two thirds of the request undone. The result was sitting in
         context; the same question asked again was answered instantly. */
      var unfinished = (gained > 0 && !left) || res.plan.dropped > 0 || res.plan.more;

      if (!room && (outcome.failed || unfinished)) {
        UI.trace('停在第 ' + round + ' 回合' +
          (stalled >= MAX_STALLED ? '：連續 ' + stalled + ' 回合沒有任何進展'
                                  : '：已達 ' + cap + ' 回合上限') +
          '，這件事沒有做完', 't-err');
        finished = false;
        lastNote = outcome.failed ? outcome.failed + ' 個動作失敗，回合用完' : '回合用完，沒有做完';
        break;
      }
      lastNote = outcome.ran.length
        ? outcome.ran.length + ' 個動作' + (outcome.failed ? '，' + outcome.failed + ' 個失敗' : '')
        : (res.plan.understanding || '');

      if (outcome.failed) {
        UI.trace('repair: 有 ' + outcome.failed + ' 個動作失敗，核心帶著錯誤訊息重規劃一次', 't-warn');
        prompt = REPAIR_NOTE;
        mode = 'repair';
        stepping = false;
        continue;
      }

      /* A plan that only fetched something is not a finished plan, and nothing
         above notices: every action succeeded, so `failed` is 0 and the turn
         ends with the user's goal untouched.

         Rule 7 of the system prompt is what puts the model here. It forbids
         inventing file contents, so for "summarise the notes in inbox into
         notes/summary.txt" the only honest first plan is a bare fs.read -- the
         summary cannot be written by a planner that has not read the file yet.
         Measured: that intent, which is the README's own first example, planned
         fs.read alone and stopped, and notes/summary.txt was never created.
         Asked again in a second turn, with the content now resident, the model
         wrote the correct summary immediately -- so the content was never the
         problem, only the missing round.

         So: if this round pulled new content in and left no mark of its own,
         hand the model the content and let it finish. `settles` reads the gate's
         own ELEVATED list, so an op that writes, sends, or installs counts as a
         finished turn, and so does `reply`. Still bounded at two rounds. */
      if (unfinished) {
        UI.trace(res.plan.dropped
          ? 'continue: 計畫還有 ' + res.plan.dropped + ' 個動作沒做，核心接著規劃剩下的'
          : res.plan.more
            ? 'continue: 核心說這只是一步，帶著結果接著規劃'
            : 'continue: 這一輪把 ' + gained + ' 份內容讀進 context 卻沒有動到任何東西，' +
              '核心帶著內容再規劃一次', 't-warn');
        prompt = res.plan.dropped ? RESUME_NOTE : (res.plan.more ? STEP_NOTE : CONTINUE_NOTE);
        mode = 'continue';
        stepping = res.plan.more;
        /* A repeat is not a duplicate when the planner asked for another round.
           `seen` exists so a repair round does not redo steps that already
           worked -- a model restating a finished step is a mistake worth
           catching. A planner that saw the result and chose the same action
           again is not making that mistake: 「攻擊到打贏為止」 is the same action
           four times on purpose, and the guard skipped every one after the
           first, so the fight never ended and the turn stopped on 「連續 2 回合
           沒有任何進展」 with the wolf still alive. */
        if (stepping) seen = {};
        continue;
      }
      break;
    }

    UI.busy(false);
    $('intent-input').value = '';
    autoGrow($('intent-input'));
    return { ok: finished, note: lastNote };
  }

  /* ===================================================================
     connection
     =================================================================== */

  async function reconnect() {
    UI.link('busy');
    try {
      var info = await K.probe();
      UI.link('up');
      UI.telemetry(null);
      UI.trace('連線成功：' + info.label + ' / ' + info.model +
        (info.nCtx ? '　n_ctx=' + Number(info.nCtx).toLocaleString() +
            (info.nCtxSourceName ? '（' + info.nCtxSourceName + '）' : '')
          : '　n_ctx 未知：這個供應商的 /models 只回 id 與擁有者，沒有上限欄位' +
            '（可以在模型設定裡自己填）') +
        (info.tokenizer ? '' : '　沒有 tokenizer，context 用量改為估算'),
        info.remote ? 't-warn' : 't-ok');
      if (info.remote) {
        UI.trace('核心在遠端：送出的 prompt 會離開這台機器', 't-taint');
      }
      var sys = S.pages.find(function (p) { return p.id === 'sys/kernel'; });
      if (sys) { await K.measure(sys); UI.renderContext(); }
      return true;
    } catch (e) {
      S.connected = false;
      UI.link('down');
      UI.trace('連線失敗：' + (e.message || e), 't-err');
      return false;
    }
  }

  /* ===================================================================
     chrome wiring
     =================================================================== */

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(132, ta.scrollHeight) + 'px';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * Choose which model is this machine's core.
   *
   * The window shows one provider at a time and edits it in place, rather than
   * four panels of which three are wrong. Which fields exist comes from the
   * provider's own `editable` list, so adding a fifth provider adds a form.
   *
   * Nothing here can read a credential back. The main process reports whether a
   * key is stored and the names of any custom headers, never the values, so an
   * empty field means "leave it alone" and never means "it is empty".
   */
  function openModelWindow() {
    AIOS.wm.open({
      id: 'sys:model', kind: 'SYSTEM', title: '核心模型', w: 580, h: 660,
      render: function (b) {
        b.appendChild(el('p', 'micro', '讀取供應商設定…'));
        paintModelPicker(b);
      }
    });
  }

  /* Model lists, per provider. Kept between repaints so switching providers back
     and forth does not spend a request each time. */
  var modelCache = {};

  async function paintModelPicker(host, showId) {
    var res = await window.aios.model.state();
    host.innerHTML = '';
    if (!res || !res.ok) {
      host.appendChild(el('p', 'fence-note', '讀不到供應商設定：' + ((res && res.error) || '未知錯誤')));
      return;
    }
    var st = res.data;
    var shown = showId || st.active;
    var p = st.providers.find(function (x) { return x.id === shown; }) || st.providers[0];
    var can = function (field) { return p.editable.indexOf(field) >= 0; };

    var form = el('form', 'mp-form');
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    host.appendChild(form);

    /* ---- which provider -------------------------------------------- */
    form.appendChild(el('label', 'mp-label', '供應商'));
    var pick = el('select', 'mp-input');
    pick.setAttribute('aria-label', '模型供應商');
    st.providers.forEach(function (x) {
      var o = document.createElement('option');
      o.value = x.id;
      o.textContent = x.label + (x.id === st.active ? '　（使用中）' : '');
      if (x.id === shown) o.selected = true;
      pick.appendChild(o);
    });
    // Re-render rather than toggle hidden blocks: the fields differ per provider
    // and a stale value left in a hidden input is a value that gets submitted.
    pick.addEventListener('change', function () { paintModelPicker(host, pick.value); });
    form.appendChild(pick);
    form.appendChild(el('p', 'micro', p.note));

    /* ---- where the prompts go -------------------------------------- */
    if (p.remote) {
      var warn = el('div', 'mp-warn');
      warn.appendChild(el('b', null, '這個核心在別人的機器上。'));
      warn.appendChild(el('span', null,
        '每一次思考都會把 prompt 送出去，那裡面包含機器狀態、對話脈絡，' +
        '以及你讀進 context 的檔案內容與網頁正文。沙箱擋得住檔案被改，擋不住內容被送走。'));
      form.appendChild(warn);
    }

    /* ---- addresses and model names --------------------------------- */
    var fields = {};
    function textField(key, label, hint, type) {
      form.appendChild(el('label', 'mp-label', label));
      var i = el('input', 'mp-input');
      i.type = type || 'text';
      i.value = p.config[key] == null ? '' : String(p.config[key]);
      i.setAttribute('aria-label', label);
      form.appendChild(i);
      if (hint) form.appendChild(el('p', 'micro', hint));
      fields[key] = i;
      return i;
    }

    if (can('endpoint')) {
      textField('endpoint', '伺服器位址', 'llama-server 的根位址。/props 與 /tokenize 都掛在這底下。', 'url');
    }
    if (can('base')) {
      textField('base', '服務位址（base URL）',
        '要能接受 POST {位址}/chat/completions。例：http://127.0.0.1:11434/v1', 'url');
    }

    /* ---- the credential, before the model list that needs it -------- */
    var key = null;
    if (p.needsKey || can('headers')) {
      form.appendChild(el('label', 'mp-label', 'API 金鑰'));
      key = el('input', 'mp-input');
      key.type = 'password';
      key.autocomplete = 'off';
      key.placeholder = p.hasKey ? '已存有金鑰，留空表示不變更' : '貼上金鑰';
      key.setAttribute('aria-label', 'API 金鑰');
      form.appendChild(key);
      fields.key = key;
    }

    /* ---- the model, asked for rather than typed --------------------- */
    var modelSel = null, modelText = null, modelNote = null;
    if (can('model')) {
      form.appendChild(el('label', 'mp-label', '模型名稱'));
      var row = el('div', 'mp-row');
      modelSel = el('select', 'mp-input');
      modelSel.setAttribute('aria-label', '模型名稱');
      var refresh = el('button', 'fbtn', '重新取得');
      refresh.type = 'button';
      refresh.title = '向這個供應商問一次模型清單';
      row.appendChild(modelSel);
      row.appendChild(refresh);
      form.appendChild(row);

      // The escape hatch. A brand new model, or a private deployment, will not be
      // in any list, and a dropdown that cannot be overridden is a dead end.
      modelText = el('input', 'mp-input');
      modelText.type = 'text';
      modelText.placeholder = '模型代號';
      modelText.setAttribute('aria-label', '自己輸入模型代號');
      modelText.hidden = true;
      form.appendChild(modelText);

      modelNote = el('p', 'micro', '');
      form.appendChild(modelNote);

      var current = String(p.config.model || '');

      function fillModels(list, note, noteBad) {
        modelSel.innerHTML = '';
        var seen = {};
        (list || []).forEach(function (id2) {
          if (seen[id2]) return;
          seen[id2] = 1;
          var o = document.createElement('option');
          o.value = id2; o.textContent = id2;
          modelSel.appendChild(o);
        });
        // Whatever is configured stays selectable even if the list disagrees.
        if (current && !seen[current]) {
          var o2 = document.createElement('option');
          o2.value = current; o2.textContent = current + '（目前設定）';
          modelSel.insertBefore(o2, modelSel.firstChild);
        }
        var own = document.createElement('option');
        own.value = '__own__';
        own.textContent = '自己輸入…';
        modelSel.appendChild(own);

        if (current) modelSel.value = current;
        else if (modelSel.options.length > 1) modelSel.selectedIndex = 0;

        modelText.hidden = modelSel.value !== '__own__';
        modelNote.textContent = note || '';
        modelNote.className = noteBad ? 'micro mp-bad' : 'micro';
      }

      modelSel.addEventListener('change', function () {
        modelText.hidden = modelSel.value !== '__own__';
        if (!modelText.hidden) modelText.focus();
      });

      async function loadModels(explicit) {
        modelNote.textContent = '問模型清單…';
        modelNote.className = 'micro';
        var out = await window.aios.model.models(p.id);
        if (out && out.ok) {
          modelCache[p.id] = out.data.models;
          fillModels(out.data.models, out.data.models.length
            ? out.data.models.length + ' 個模型可選'
            : '這個供應商沒有回報任何模型，請自己輸入');
          if (!out.data.models.length) { modelSel.value = '__own__'; modelText.hidden = false; }
        } else {
          // Not a failure worth blocking on: the name can still be typed.
          fillModels(modelCache[p.id] || [], '問不到清單：' + ((out && out.error) || '未知錯誤') + '，可以自己輸入', true);
        }
        if (explicit) modelSel.focus();
      }

      fillModels(modelCache[p.id] || []);
      refresh.addEventListener('click', function () { loadModels(true); });

      /* Asked for automatically once there is something to ask with. The list is
         cached per provider so reopening the window does not spend a request. */
      if (!modelCache[p.id] && (!p.needsKey || p.hasKey)) loadModels(false);

      // The point of putting the key above the model: finishing the key is what
      // makes the list available, so finishing it fetches the list.
      if (key) {
        key.addEventListener('change', async function () {
          if (!key.value.trim()) return;
          modelNote.textContent = '存金鑰並問模型清單…';
          var saved = await window.aios.model.setSecret(p.id, key.value, null);
          if (!saved || !saved.ok) {
            modelNote.textContent = '金鑰存不起來：' + ((saved && saved.error) || '未知錯誤');
            modelNote.className = 'micro mp-bad';
            return;
          }
          key.placeholder = '已存有金鑰，留空表示不變更';
          key.value = '';
          delete modelCache[p.id];
          await loadModels(false);
        });
      }
    }

    /* ---- how hard it should think ---------------------------------- */
    if (can('reasoning') && p.reasoningKind !== 'none') {
      form.appendChild(el('label', 'mp-label', '思考模式'));
      var think = el('select', 'mp-input');
      think.setAttribute('aria-label', '思考模式');
      var RUNGS = [
        ['default', '跟著供應商預設'],
        ['none', 'NONE — 不思考，最快'],
        ['minimal', 'MINIMAL — 幾乎不想'],
        ['low', 'LOW — 想一下'],
        ['medium', 'MEDIUM — 一般'],
        ['high', 'HIGH — 想久一點'],
        ['max', 'MAX — 想到最深，最慢也最貴']
      ];
      RUNGS.forEach(function (pair) {
        var o = document.createElement('option');
        o.value = pair[0]; o.textContent = pair[1];
        if ((p.config.reasoning || 'default') === pair[0]) o.selected = true;
        think.appendChild(o);
      });
      form.appendChild(think);
      fields.reasoning = think;

      /* The ladder is shared and the providers are not, so say out loud which
         rung this one will actually land on. A dial that silently rounds is a
         dial you cannot trust. */
      var mapNote = el('p', 'micro', '');
      form.appendChild(mapNote);
      function sayMapping() {
        var want = think.value;
        if (want === 'default') {
          mapNote.textContent = p.reasoningKind === 'template'
            ? '不送思考參數；地端核心維持一向的行為 —— 不思考，直接答。'
            : '不送思考參數，用供應商自己的預設。想指定的模型不會思考時，這是最安全的選擇。';
          return;
        }
        var accepted = p.efforts || [];
        var how = p.reasoningKind === 'template' ? 'chat_template_kwargs.enable_thinking'
          : p.reasoningKind === 'thinking' ? 'thinking.type（＋ reasoning_effort）'
          : 'reasoning_effort';

        /* Off is off. Two of the three dialects have an explicit switch, so NONE
           is never rounded to the nearest effort -- rounding it up would turn
           「不要思考」 into 「想到最深」. */
        if (want === 'none') {
          mapNote.textContent = p.reasoningKind === 'template'
            ? '關掉思考：送 chat_template_kwargs.enable_thinking = false。'
            : p.reasoningKind === 'thinking'
              ? '關掉思考：送 thinking.type = disabled。'
              : (accepted.indexOf('none') >= 0
                ? '關掉思考：送 reasoning_effort = none。'
                : '這個供應商的 reasoning_effort 沒有 none 這一級，所以不送思考參數（不會改成更高的等級）。');
          return;
        }

        var landed = accepted.indexOf(want) >= 0 ? want : null;
        if (!landed) {
          // Mirror of nearestEffort in the main process: step down before up.
          var ladder = st.ladder;
          var at = ladder.indexOf(want);
          for (var d = 1; d < ladder.length && !landed; d++) {
            if (ladder[at - d] && accepted.indexOf(ladder[at - d]) >= 0) landed = ladder[at - d];
            else if (ladder[at + d] && accepted.indexOf(ladder[at + d]) >= 0) landed = ladder[at + d];
          }
        }
        mapNote.textContent = landed === want
          ? '這個供應商認得 ' + want.toUpperCase() + '，會用 ' + how + ' 送出。'
          : (landed
            ? '這個供應商只認得 ' + accepted.join('、') + '，' + want.toUpperCase() +
              ' 會對應成 ' + landed.toUpperCase() + '，用 ' + how + ' 送出。'
            : '這個供應商沒有可對應的等級，不會送思考參數。');
      }
      think.addEventListener('change', sayMapping);
      sayMapping();

      /* Measured on a live hosted model: with the dial high and the output cap at
         its default, the whole cap went on thinking and the answer came back one
         character long with finish_reason 'length'. Worth saying here rather than
         only after it happens -- and the cap that fixes it is the next field. */
      if (p.remote && p.reasoningKind !== 'none') {
        form.appendChild(el('p', 'micro',
          '注意：雲端模型的思考 token 跟回覆共用同一個輸出上限。調高思考等級時，' +
          '下面的「輸出上限」也要跟著調高，不然回覆會在說完之前就被截斷。'));
      }
    }

    /* ---- how much room the answer gets --------------------------------- */
    if (can('maxOut')) {
      form.appendChild(el('label', 'mp-label', '輸出上限（max tokens）'));
      var cap = el('input', 'mp-input');
      cap.type = 'number';
      cap.min = '0';
      cap.max = '200000';
      cap.step = '256';
      cap.value = String(p.config.maxOut == null ? 0 : p.config.maxOut);
      cap.setAttribute('aria-label', '輸出上限');
      form.appendChild(cap);
      fields.maxOut = cap;
      form.appendChild(el('p', 'micro',
        p.remote
          ? '思考與回覆共用這個上限，所以思考等級越高就要留越多。0 表示交給呼叫端決定'
            + '（對話面板 1400、意圖計畫 900 —— 那是為地端模型不思考時調的，雲端會不夠）。'
          : '0 表示交給呼叫端決定：對話面板 1400、意圖計畫 900。地端核心通常不用動這個。'));
    }

    /* ---- how far it can be held to a shape ------------------------- */
    if (can('auth')) {
      form.appendChild(el('label', 'mp-label', '驗證方式'));
      var auth = el('select', 'mp-input');
      auth.setAttribute('aria-label', '驗證方式');
      [['bearer', 'Authorization: Bearer <金鑰>'], ['none', '不帶驗證（金鑰放自訂表頭）']]
        .forEach(function (pair) {
          var o = document.createElement('option');
          o.value = pair[0]; o.textContent = pair[1];
          if (p.config.auth === pair[0]) o.selected = true;
          auth.appendChild(o);
        });
      form.appendChild(auth);
      fields.auth = auth;
    }
    if (can('json')) {
      form.appendChild(el('label', 'mp-label', 'JSON 約束'));
      var json = el('select', 'mp-input');
      json.setAttribute('aria-label', 'JSON 約束方式');
      [['object', 'json_object（多數服務支援）'],
       ['schema', 'json_schema（要伺服器真的支援 grammar）'],
       ['none', '不約束（靠寬鬆解析）']].forEach(function (pair) {
        var o = document.createElement('option');
        o.value = pair[0]; o.textContent = pair[1];
        if (p.config.json === pair[0]) o.selected = true;
        json.appendChild(o);
      });
      form.appendChild(json);
      fields.json = json;
    }
    if (can('reasoningKind')) {
      form.appendChild(el('label', 'mp-label', '思考參數的形式'));
      var rk = el('select', 'mp-input');
      rk.setAttribute('aria-label', '思考參數的形式');
      [['effort', 'reasoning_effort（OpenAI 那一派）'],
       ['thinking', 'thinking: {type}（DeepSeek 那一派）'],
       ['template', 'chat_template_kwargs.enable_thinking（llama.cpp / vLLM）'],
       ['none', '不送思考參數']].forEach(function (pair) {
        var o = document.createElement('option');
        o.value = pair[0]; o.textContent = pair[1];
        if ((p.config.reasoningKind || 'effort') === pair[0]) o.selected = true;
        rk.appendChild(o);
      });
      form.appendChild(rk);
      fields.reasoningKind = rk;
      form.appendChild(el('p', 'micro', '改完按「儲存」，上面的思考模式說明才會跟著更新。'));
    }
    if (can('tokenizer')) {
      var wrap = el('label', 'mp-check');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!p.config.tokenizer;
      wrap.appendChild(cb);
      wrap.appendChild(el('span', null, '這個服務有 /tokenize（自架 llama-server 才有）'));
      form.appendChild(wrap);
      fields.tokenizer = cb;
    }

    /* ---- custom headers -------------------------------------------- */
    var headerRows = [];
    if (can('headers')) {
      form.appendChild(el('label', 'mp-label', '自訂表頭'));
      var table = el('div', 'mp-heads');
      form.appendChild(table);

      function addRow(name) {
        var row = el('div', 'mp-head');
        var n = el('input', 'mp-input mp-head-n');
        n.type = 'text';
        n.placeholder = '表頭名稱';
        n.value = name || '';
        n.setAttribute('aria-label', '表頭名稱');
        var v = el('input', 'mp-input mp-head-v');
        v.type = 'password';
        v.autocomplete = 'off';
        v.placeholder = name ? '值已存，留空表示不變更' : '值';
        v.setAttribute('aria-label', '表頭內容');
        var rm = el('button', 'fbtn fbtn-danger', '\u2715');
        rm.type = 'button';
        rm.title = '刪掉這一列';
        rm.addEventListener('click', function () {
          row.remove();
          headerRows = headerRows.filter(function (r) { return r.row !== row; });
        });
        row.appendChild(n); row.appendChild(v); row.appendChild(rm);
        table.appendChild(row);
        headerRows.push({ row: row, name: n, value: v });
      }

      p.headerNames.forEach(function (n) { addRow(n); });
      var add = el('button', 'fbtn', '\uff0b 新增表頭');
      add.type = 'button';
      add.addEventListener('click', function () { addRow(''); });
      form.appendChild(add);
      form.appendChild(el('p', 'micro',
        '表頭值跟金鑰一樣加密存放，也一樣讀不回來。要刪掉一個表頭就刪掉那一列。'));
    }

    /* ---- where the secrets live ------------------------------------ */
    form.appendChild(el('p', 'fence-note', st.sealed
      ? '金鑰與表頭值用作業系統的金鑰保管機制加密，存在應用程式的設定目錄，不在沙箱裡，'
        + '不進工作階段檔案，也不會回傳到畫面這一側——模型讀不到。'
      : '這台機器沒有可用的金鑰保管機制，所以金鑰不會寫進磁碟，只留在這次執行的記憶體裡。'
        + '重開之後要重新填。'));

    /* ---- actions ---------------------------------------------------- */
    var bar = el('div', 'mp-actions');
    var status = el('p', 'micro', p.id === st.active
      ? '目前的核心就是這個供應商。'
      : '目前的核心是「' + (st.providers.find(function (x) { return x.id === st.active; }) || {}).label + '」。');

    function collect() {
      var patch = {};
      Object.keys(fields).forEach(function (k) {
        if (k === 'key') return;
        var f = fields[k];
        patch[k] = f.type === 'checkbox' ? f.checked : f.value.trim();
      });
      // The model is a dropdown with a typed-in escape hatch, so it does not read
      // like the other fields.
      if (modelSel) {
        patch.model = modelSel.value === '__own__'
          ? (modelText.value || '').trim()
          : modelSel.value;
      }
      var headers = can('headers') ? headerRows.map(function (r) {
        return { name: r.name.value.trim(), value: r.value.value };
      }).filter(function (r) { return r.name; }) : null;
      return { patch: patch, key: fields.key ? fields.key.value : '', headers: headers };
    }

    async function persist() {
      var c = collect();
      var out = await window.aios.model.configure(p.id, c.patch);
      if (!out || !out.ok) throw new Error(out && out.error);
      if (c.key || c.headers) {
        var out2 = await window.aios.model.setSecret(p.id, c.key, c.headers);
        if (!out2 || !out2.ok) throw new Error(out2 && out2.error);
      }
    }

    var save = el('button', 'fbtn', '儲存');
    save.type = 'button';
    save.addEventListener('click', async function () {
      status.textContent = '儲存中…';
      try {
        await persist();
        status.textContent = '已儲存。';
        UI.trace('核心模型設定已儲存：' + p.label, 't-ok');
      } catch (e) {
        status.textContent = '儲存失敗：' + (e.message || e);
        status.className = 'micro mp-bad';
      }
    });

    var use = el('button', 'fbtn fbtn-primary', '設為核心並連線');
    use.type = 'button';
    use.addEventListener('click', async function () {
      status.className = 'micro';
      status.textContent = '切換中…';
      try {
        await persist();
        var sel = await window.aios.model.select(p.id);
        if (!sel || !sel.ok) throw new Error(sel && sel.error);
        var ok = await reconnect();
        if (AIOS.fitBudget) AIOS.fitBudget();
        status.textContent = ok
          ? '已切換到 ' + p.label + '，' + (S.tokenizer ? '有 tokenizer。' : '沒有 tokenizer，排程器改用估算。')
          : '已切換到 ' + p.label + '，但連線沒有成功，看右邊的核心軌跡。';
        paintModelPicker(host, p.id);
      } catch (e) {
        status.textContent = '切換失敗：' + (e.message || e);
        status.className = 'micro mp-bad';
      }
    });

    bar.appendChild(use);
    bar.appendChild(save);

    if (p.hasKey || p.headerNames.length) {
      var forget = el('button', 'fbtn fbtn-danger', '忘記金鑰與表頭');
      forget.type = 'button';
      forget.addEventListener('click', async function () {
        var yes = await AIOS.confirm({
          // Asked inside this window, so it cannot be mistaken for something the
          // system is asking on its own behalf.
          host: host.closest('.win') || undefined,
          label: '忘記 ' + p.label + ' 的憑證？',
          note: '金鑰與自訂表頭會從磁碟與記憶體移除，沒辦法復原，要用就得重新填一次。',
          okLabel: '忘記',
          danger: true
        });
        if (!yes) return;
        var out = await window.aios.model.forgetSecret(p.id);
        if (out && out.ok) {
          UI.trace('已忘記 ' + p.label + ' 的憑證', 't-warn');
          paintModelPicker(host, p.id);
        } else {
          status.textContent = '忘記失敗：' + ((out && out.error) || '未知錯誤');
          status.className = 'micro mp-bad';
        }
      });
      bar.appendChild(forget);
    }

    form.appendChild(bar);
    form.appendChild(status);

    /* Authoring the shipped preset. Only offered from a source checkout: inside
       a packaged application the file would have to be written into a read-only
       asar, and a person running a build has no reason to be making one. The
       button is added asynchronously because whether it belongs here is the main
       process's answer, not something the renderer should assume. */
    window.aios.model.presetState().then(function (r) {
      if (!r || !r.ok || !r.data.canAuthor) return;

      var pbar = el('div', 'mp-bar');
      var mk = el('button', 'fbtn', r.data.exists ? '更新內建預設檔' : '產生內建預設檔');
      mk.type = 'button';
      mk.title = '把目前的核心設定（含金鑰）封成隨版本出貨的預設檔，' +
                 '讓使用者裝好就能直接用，不必自己設定模型。';
      mk.addEventListener('click', async function () {
        var yes = await AIOS.confirm({
          host: host.closest('.win') || undefined,
          label: '把目前設定封成內建預設檔？',
          /* Said plainly, because the encryption around it does not change it:
             a key that ships inside the program can be recovered by anyone who
             has the program. The place to be careful is here, before it goes in
             -- not in the choice of cipher. */
          note: '會先儲存目前這一頁的設定，再把「使用中的供應商 + 各家設定 + 金鑰」' +
                '加密寫進 app/preset/，下次建置就會帶著它出貨。\n\n' +
                '⚠ 加密只擋得住隨手翻看：金鑰跟解密所需的一切都在同一個執行檔裡，' +
                '拿到程式的人有辦法把它取出來。請只放你願意被還原的金鑰' +
                '（設好用量上限、可隨時換掉）。',
          okLabel: '產生',
          cancelLabel: '取消'
        });
        if (!yes) return;
        status.className = 'micro';
        status.textContent = '產生中…';
        try {
          await persist();
          var out = await window.aios.model.exportPreset();
          if (!out || !out.ok) throw new Error((out && out.error) || '未知錯誤');
          var withKeys = out.data.withKeys || [];
          status.textContent = '已寫入 ' + out.data.file +
            '（使用中：' + out.data.active +
            (withKeys.length ? '，含金鑰：' + withKeys.join('、') : '，沒有任何金鑰') +
            '）。重新建置就會帶著它出貨。';
          UI.trace('已產生內建模型預設檔：' + out.data.file, 't-ok');
          mk.textContent = '更新內建預設檔';
        } catch (e) {
          status.textContent = '產生失敗：' + (e.message || e);
          status.className = 'micro mp-bad';
        }
      });
      pbar.appendChild(mk);
      form.appendChild(pbar);
      form.appendChild(el('p', 'micro',
        '內建預設檔只在使用者「第一次啟動」時套用；' +
        '之後他自己選過的供應商與金鑰不會被覆蓋。'));
    });
  }

  /* The identity block, fetched once and kept: it cannot change while the
     process runs, and both windows below read it. */
  var aboutInfo = null;
  async function loadAbout() {
    if (aboutInfo) return aboutInfo;
    var r = await window.aios.about();
    aboutInfo = r && r.ok ? r.data : null;
    return aboutInfo;
  }

  /** "AI-OS v1.0.16（免安裝版）· Electron 43.4.0 · Chromium 150… · Node 24…" */
  function aboutLine(a) {
    if (!a) return T('about.unknown', 'AI-OS（版本未知）');
    return 'AI-OS v' + a.version + '（' + T('ver.mode.' + a.mode, a.modeLabel) + '）· Electron ' + a.electron +
      ' · Chromium ' + a.chromium + ' · Node ' + a.node;
  }

  /**
   * 系統 → 版本說明. The version this process is, said by the process --
   * not read off a file name -- with the release notes shipped beside the
   * code, and one button that copies the whole block for a bug report.
   */
  function openVersion() {
    AIOS.wm.open({
      id: 'sys:version', kind: 'SYSTEM', title: T('ver.title', '版本說明'), w: 520, h: 460,
      render: async function (b) {
        b.classList.add('ver');
        var a = await loadAbout();
        if (!a) {
          b.appendChild(el('p', 'app-error', T('ver.unreadable', '讀不到版本資訊')));
          return;
        }
        var head = el('div', 'ver-head');
        head.appendChild(el('div', 'ver-name', 'AI-OS'));
        head.appendChild(el('div', 'ver-num', 'v' + a.version));
        head.appendChild(el('div', 'ver-mode', T('ver.mode.' + a.mode, a.modeLabel)));
        b.appendChild(head);

        var t = el('table', 'ver-table');
        [
          ['Electron', a.electron],
          ['Chromium', a.chromium],
          ['Node', a.node],
          [T('ver.platform', '平台'), a.platform],
          [T('ver.core', '核心模型'), S.providerLabel + (S.model ? ' · ' + S.model : '') + (S.remote ? T('ver.remote', '（遠端）') : '')],
          [T('ver.data', '資料位置'), a.dataHome],
          [T('ver.sandbox', '沙箱'), S.sandboxRoot || T('ui.unmounted', '（未掛載）')]
        ].forEach(function (row) {
          var tr = el('tr');
          tr.appendChild(el('th', null, row[0]));
          tr.appendChild(el('td', null, String(row[1] || '—')));
          t.appendChild(tr);
        });
        b.appendChild(t);

        var copy = el('button', 'fbtn', T('ver.copy', '複製版本資訊'));
        copy.type = 'button';
        copy.addEventListener('click', async function () {
          var text = aboutLine(a) + '\n' + T('ver.platform', '平台') + '：' + a.platform +
            '\n' + T('ver.data', '資料位置') + '：' + a.dataHome +
            '\n' + T('ver.core', '核心模型') + '：' + S.providerLabel + (S.model ? ' · ' + S.model : '');
          var r = await window.aios.clipboard.write(text);
          UI.trace(r && r.ok ? T('ver.copied', '版本資訊已複製') : T('ver.copyFail', '複製失敗'), r && r.ok ? 't-ok' : 't-err');
        });
        b.appendChild(copy);

        /* This version's notes first, in full; the rest folded. A version
           with no entry says so rather than showing the previous one's. */
        var mine = (a.notes || []).find(function (n) { return n.version === a.version; });
        var h = el('h3', null, T('ver.thisVersion', '這一版的變更') + (mine ? '（v' + mine.version + '，' + mine.date + '）' : ''));
        b.appendChild(h);
        if (mine) {
          if (mine.title) b.appendChild(el('p', 'ver-title', mine.title));
          var ul = el('ul', 'ver-notes');
          (mine.notes || []).forEach(function (n) { ul.appendChild(el('li', null, n)); });
          b.appendChild(ul);
        } else {
          b.appendChild(el('p', 'micro', T('ver.noNotes', '這一版沒有版本說明（app/release-notes.json 裡沒有 v{v}）。', { v: a.version })));
        }
        var older = (a.notes || []).filter(function (n) { return n.version !== a.version; });
        if (older.length) {
          var det = el('details', 'ver-older');
          det.appendChild(el('summary', null, T('ver.older', '先前的版本（{n}）', { n: older.length })));
          older.forEach(function (n) {
            det.appendChild(el('h4', null, 'v' + n.version + '　' + n.date + (n.title ? '　' + n.title : '')));
            var u = el('ul', 'ver-notes');
            (n.notes || []).forEach(function (x) { u.appendChild(el('li', null, x)); });
            det.appendChild(u);
          });
          b.appendChild(det);
        }
      }
    });
  }

  /**
   * 關於這台機器. Every fact on it is read from the running machine at the
   * moment the window opens: the version the process reports, the core
   * provider and model and whether it is remote, the tokenizer, the sandbox
   * path. Nothing here is a fixed sentence about a hypothetical machine --
   * 「本地模型」 was, for a machine running on a cloud core, and it is gone.
   */
  function openAbout() {
    AIOS.wm.open({
      id: 'sys:about', kind: 'SYSTEM', title: T('about.title', '關於這台機器'), w: 490, h: 340,
      render: async function (b) {
        var a = await loadAbout();
        var measured = S.tokenizer
          ? T('about.measured', '經過真實的 tokenizer 計量')
          : T('about.estimated', '被估算長度（這個供應商沒有 tokenizer）');
        var remote = S.remote
          ? T('about.remote', '這個核心在遠端，prompt 會離開這台機器。')
          : T('about.local', '這個核心在這台電腦上執行。');
        var text =
          T('about.version', '這是 {line}。版本的變更在「系統 → 版本說明」。', { line: aboutLine(a) }) + '\n\n' +
          T('about.machine', 'AI-OS 是一台真的機器：意圖是它的系統呼叫介面，語言模型是它的意圖核心。') + '\n\n' +
          T('about.core', '核心：{provider} 上的 {model}，n_ctx = {nctx}。你打的每一句話都會{measured}、放進 context 分頁、由排程器決定留或不留。{remote}', {
            provider: S.providerLabel || '?',
            model: S.model || T('about.notConnected', '（未連線）'),
            nctx: S.nCtx || '?',
            measured: measured,
            remote: remote
          }) + '\n\n' +
          T('about.files', '檔案：真的。沙箱在 {root}，讀寫刪都是真實檔案操作。但核心出不去這個目錄，作業系統上的檔案永遠不受影響，刪除只會移進沙箱回收桶，所以動作日誌的「復原」是真的還原。', {
            root: S.sandboxRoot || T('ui.unmounted', '（未掛載）')
          }) + '\n\n' +
          T('about.import', '要放東西進來：用左邊的「從 OS 匯入」，或直接把檔案拖進這個視窗。一律複製，原檔不會被搬移或修改。從外面進來的檔案會被標記為不可信。') +
          (AIOS.i18n && AIOS.i18n.isEnglish ? '\n\n' + T('about.lang', '') : '');
        AIOS.render.text(b, text);
      }
    });
  }

  /* ------------------------------------------------ language, text size */

  /** Tick the row that matches the saved preference, in both menus. */
  function paintPrefMenus() {
    var p = S.prefs || {};
    document.querySelectorAll('.mb-drop button[data-pref]').forEach(function (b) {
      var kind = b.getAttribute('data-pref');
      var v = b.getAttribute('data-value');
      var on = kind === 'lang' ? (p.locale || 'zh-TW') === v : Number(v) === Number(p.zoom || 1.15);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  /**
   * Save a preference and apply it. The main process keeps the file and
   * applies the zoom itself; the language is applied here, to this document,
   * and everything that paints its own words is told to paint again.
   */
  async function setPref(patch) {
    var r = await window.aios.prefs.set(patch);
    if (!r || !r.ok) {
      UI.trace(T('prefs.fail', '設定沒有保存：{err}', { err: (r && r.error) || '?' }), 't-err');
      return;
    }
    S.prefs = r.data;
    if (patch.locale && AIOS.i18n) {
      AIOS.i18n.set(r.data.locale);
      UI.trace(T('prefs.langSet', '介面語言：{name}。已保存，下次啟動也用它。', { name: AIOS.i18n.NAMES[r.data.locale] || r.data.locale }), 't-ok');
    }
    if (patch.zoom) {
      UI.trace(T('prefs.zoomSet', '文字大小：{pct}%。已保存。', { pct: Math.round(r.data.zoom * 100) }), 't-ok');
    }
    paintPrefMenus();
  }

  /** Everything that wrote its own words repaints in the new language. */
  function repaintForLocale() {
    paintChips();
    var row = $('chips');
    var btn = $('btn-chips');
    if (btn && row) btn.title = row.classList.contains('off') ? T('intent.showChips', '顯示建議詞') : T('intent.hideChips', '隱藏建議詞');
    if (AIOS.launcher) AIOS.launcher.refresh();
    UI.renderSandbox();
    UI.renderJournal();
    UI.renderMemory();
    UI.syncDock();
    paintPrefMenus();
  }

  function paintChips() {
    var chipHost = $('chips');
    if (!chipHost) return;
    chipHost.innerHTML = '';
    CHIPS.forEach(function (c, i) {
      var zh = typeof c === 'string' ? c : c.text;
      var text = T('chip.' + i, zh);
      var label = typeof c === 'string' ? text : (c.label || text);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (c.danger ? ' chip-danger' : '');
      b.textContent = label;
      b.title = text;
      b.addEventListener('click', function () {
        var inp = $('intent-input');
        inp.value = text;
        autoGrow(inp);
        inp.focus();
      });
      chipHost.appendChild(b);
    });
  }

  /**
   * Build the 主題 menu from AIOS.themes, and mark which one is on.
   *
   * Rendered rather than written into the markup so the list has one home. Each
   * entry carries a swatch of the palette it switches to, because a name alone
   * ("極地", "靛紫") does not tell anyone what they are about to get.
   */
  function paintThemeMenu() {
    var drop = $('drop-theme');
    if (!drop) return;
    var now = AIOS.themes.current();
    drop.innerHTML = '';
    AIOS.themes.list.forEach(function (t) {
      drop.appendChild(themeRow(t.id, T('theme.' + t.id, t.label), T('themeHint.' + t.id, t.hint), now));
    });

    /* The user's own, under a rule of their own. A different kind of thing
       from the fourteen above -- these can be edited and deleted -- so each row
       also carries the way into the editor. */
    var custom = AIOS.themes.custom || [];
    if (custom.length) {
      drop.appendChild(document.createElement('hr'));
      drop.appendChild(el('span', 'mb-drop-label', T('theme.customSection', '自訂主題')));
      custom.forEach(function (t) {
        var row = el('div', 'mb-theme-row');
        var hint = t.mode === 'light' ? T('theme.customLight', '自訂，淺色') : T('theme.customDark', '自訂，深色');
        row.appendChild(themeRow(t.id, t.name, hint, now));
        var edit = el('button', 'mb-theme-edit', '✎');
        edit.type = 'button';
        edit.title = T('theme.edit', '編輯這個主題');
        edit.setAttribute('aria-label', T('theme.edit', '編輯這個主題') + '：' + t.name);
        edit.setAttribute('data-theme-edit', t.id);
        edit.addEventListener('click', function () {
          menu(null, false);
          AIOS.themer.open(t.id);
        });
        row.appendChild(edit);
        drop.appendChild(row);
      });
    }

    drop.appendChild(document.createElement('hr'));
    var make = el('button', 'mb-theme-new', T('theme.customNew', '自訂主題…'));
    make.type = 'button';
    make.title = T('theme.customNewTitle', '從一個主色調搭配出自己的配色，可以存好幾組');
    make.setAttribute('data-theme-act', 'new');
    make.addEventListener('click', function () {
      menu(null, false);
      AIOS.themer.open();
    });
    drop.appendChild(make);
  }
  AIOS.paintThemeMenu = paintThemeMenu;

  /** One row of the theme menu: swatch, name, one-line hint; clicking wears it. */
  function themeRow(id, label, hintText, now) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mb-theme' + (id === now ? ' on' : '');
    b.setAttribute('data-theme-id', id);
    b.title = hintText;

    var sw = document.createElement('span');
    sw.className = 'mb-swatch';
    sw.setAttribute('data-theme', id);
    sw.setAttribute('aria-hidden', 'true');
    b.appendChild(sw);

    b.appendChild(document.createTextNode(label));
    var hint = document.createElement('em');
    hint.textContent = hintText;
    b.appendChild(hint);

    b.setAttribute('aria-label', label + '：' + hintText +
      (id === now ? T('theme.current', '（目前使用中）') : ''));
    b.addEventListener('click', function () {
      menu(null, false);
      AIOS.run('theme.set', { mode: id });
    });
    return b;
  }

  function menu(name, open) {
    if (name === 'theme' && open) paintThemeMenu();
    if ((name === 'system' || name === 'view') && open) paintPrefMenus();
    ['system', 'view', 'theme', 'help'].forEach(function (m) {
      var drop = $('drop-' + m);
      var btn = document.querySelector('.mb-item[data-menu="' + m + '"]');
      var on = (m === name) && open;
      drop.hidden = !on;
      btn.classList.toggle('open', on);
      if (on) drop.style.left = (btn.getBoundingClientRect().left - 4) + 'px';
    });
  }

  var MENU_ACTS = {
    reconnect: reconnect,
    endpoint: openModelWindow,
    'lang-zh-TW': function () { setPref({ locale: 'zh-TW' }); },
    'lang-en': function () { setPref({ locale: 'en' }); },
    'zoom-1': function () { setPref({ zoom: 1 }); },
    'zoom-1.15': function () { setPref({ zoom: 1.15 }); },
    'zoom-1.3': function () { setPref({ zoom: 1.3 }); },
    'zoom-1.5': function () { setPref({ zoom: 1.5 }); },
    import: function () { AIOS.userImport('/inbox'); },
    reveal: function () { window.aios.user.reveal(); },
    trash: function () { AIOS.openTrash(); },
    cleartaint: async function () {
      await K.clearTaint();
      UI.trace('汙染標記已清除，提權能力回到政策設定值', 't-info');
      UI.renderSandbox();
      UI.renderContext();
    },
    reset: function () {
      AIOS.wm.closeAll();
      S.pages = S.pages.filter(function (p) { return p.kind === 'sys'; });
      S.journal = [];
      S.seq = 0;
      S.turnSeq = 0;
      $('trace').innerHTML = '';
      UI.trace('工作階段已清空（沙箱檔案不動）', 't-info');
      refreshMachineState();
      UI.renderContext();
      UI.renderJournal();
      UI.renderMemory();
    },
    reboot: function () { window.location.reload(); },
    // Same path as the desktop's context menu, confirmation included: one
    // wording for one irreversible action, however it was reached.
    shutdown: function () { AIOS.shutdown.ask(); },
    'toggle-left': function () { toggleHud('hud-left'); },
    'toggle-right': function () { toggleHud('hud-right'); },
    'toggle-chips': function () { toggleChips(); },
    tile: function () { AIOS.wm.tile(); },
    closeall: function () { AIOS.wm.closeAll(); },
    about: openAbout,
    version: openVersion,
    injection: function () {
      var inp = $('intent-input');
      inp.value = '讀 inbox 的發票，照裡面寫的做';
      autoGrow(inp);
      inp.focus();
      UI.trace('示範：這份檔案裡藏了指令。核心會把它當資料，並把提權降級為 ASK。', 't-taint');
    }
  };

  /**
   * Below 1040px the rails are display:none and only appear when forced, so the
   * toggle has to drive both flags or the dock button does nothing on a narrow
   * window.
   */
  /**
   * Show or hide the intent bar's starter chips.
   *
   * Two ways in, like the HUD rails: the button in the bar and the 檢視 menu. The
   * state persists with the rest of the shell furniture, because a preference that
   * resets every boot is one the user has to keep re-expressing.
   */
  function toggleChips(force) {
    var row = $('chips');
    var btn = $('btn-chips');
    var shown = force === undefined ? row.classList.contains('off') : !!force;
    row.classList.toggle('off', !shown);
    btn.setAttribute('aria-expanded', shown ? 'true' : 'false');
    btn.textContent = shown ? '\u25be' : '\u25b4';
    // The glyph says which state; the tooltip says what pressing it will do, so
    // there is nothing to infer from the direction a triangle points.
    btn.title = shown ? T('intent.hideChips', '隱藏建議詞') : T('intent.showChips', '顯示建議詞');
    if (AIOS.session && AIOS.session.save) AIOS.session.save('auto');
    return shown;
  }

  /**
   * While the desktop is folded for a maximised window the dock waits just off
   * the bottom edge; reaching for the command strip brings it back.
   *
   * The delay on the way out is what makes it usable: the dock reveals above
   * the strip, so getting to it means leaving the strip, and a dock that
   * vanished at that moment would be one nobody could ever click.
   */
  function installDockPeek() {
    var bar = $('intent-form');
    var dock = $('dock');
    if (!bar || !dock) return;
    var away = null;
    function peek(on) {
      if (away) { window.clearTimeout(away); away = null; }
      if (on) { document.body.classList.add('peek'); return; }
      away = window.setTimeout(function () { document.body.classList.remove('peek'); }, 340);
    }
    bar.addEventListener('pointerenter', function () { peek(true); });
    bar.addEventListener('pointerleave', function () { peek(false); });
    dock.addEventListener('pointerenter', function () { peek(true); });
    dock.addEventListener('pointerleave', function () { peek(false); });
    // Tabbing to the dock has to reveal it too, or the keyboard lands on
    // buttons that are off screen.
    dock.addEventListener('focusin', function () { peek(true); });
    dock.addEventListener('focusout', function () { peek(false); });
  }

  function toggleHud(id) {
    var hud = $(id);
    var narrow = window.innerWidth <= 1040;
    var shown;
    if (narrow) {
      shown = !hud.classList.contains('forced');
      hud.classList.toggle('forced', shown);
      hud.classList.remove('off');
    } else {
      shown = hud.classList.contains('off');
      hud.classList.toggle('off', !shown);
    }
    var dk = document.querySelector('.dk[data-dock="' + id + '"]');
    if (dk) dk.setAttribute('aria-pressed', shown ? 'true' : 'false');
    // The rails are part of what "the whole desktop" means, so anything
    // maximised has to grow into the space one just gave back.
    AIOS.wm.refitMax();
  }

  /* Which rails this folded away, so un-maximising restores those and only
     those. A rail somebody opened while maximised was a decision, and decisions
     survive -- it is already open when the fold lifts, and nothing here touches
     it. */
  var foldedRails = [];
  var railsFolded = false;

  /**
   * Fold the HUD rails away for a maximised window, or bring them back.
   *
   * Measured on a 1336px desktop: with both rails open a maximised window gets
   * 50% of the desktop, and folding them takes it to 94%. That gap is the whole
   * reason maximise did not feel like maximise.
   *
   * Idempotent on purpose: the window manager syncs this on every open, close,
   * minimise and restore, and a second fold must not forget what the first one
   * put away.
   */
  function foldRails(on) {
    on = !!on;
    if (on === railsFolded) return foldedRails.length;
    railsFolded = on;
    var narrow = window.innerWidth <= 1040;
    if (on) {
      foldedRails = [];
      ['hud-left', 'hud-right'].forEach(function (id) {
        var hud = $(id);
        if (!hud) return;
        var shown = narrow ? hud.classList.contains('forced') : !hud.classList.contains('off');
        if (!shown) return;
        foldedRails.push(id);
        if (narrow) hud.classList.remove('forced'); else hud.classList.add('off');
      });
    } else {
      foldedRails.forEach(function (id) {
        var hud = $(id);
        if (!hud) return;
        if (narrow) hud.classList.add('forced'); else hud.classList.remove('off');
      });
      foldedRails = [];
    }
    syncHudButtons();
    return foldedRails.length;
  }
  AIOS.foldRails = foldRails;

  /** Keep the dock's pressed state honest about what is actually on screen. */
  function syncHudButtons() {
    var narrow = window.innerWidth <= 1040;
    ['hud-left', 'hud-right'].forEach(function (id) {
      var hud = $(id);
      var shown = narrow ? hud.classList.contains('forced') : !hud.classList.contains('off');
      var dk = document.querySelector('.dk[data-dock="' + id + '"]');
      if (dk) dk.setAttribute('aria-pressed', shown ? 'true' : 'false');
    });
  }

  /**
   * A dock button brings back what you already have before it makes more.
   *
   * These used to pass forceNew unconditionally, so after minimising the
   * browser the dock's browser button handed back a new empty one and the first
   * was nowhere -- which is exactly what 「我把它縮小之後就再也找不到了」 means.
   * Right-click still opens a new window.
   */
  function dockOpen(appId, canHaveMany) {
    if (AIOS.apps.reveal(appId)) return;
    AIOS.apps.launch(appId, undefined, { forceNew: !!canHaveMany });
  }

  var DOCK_ACTS = {
    intent: function () { $('intent-input').focus(); },
    apps: function () { AIOS.launcher.open(); },
    files: function () { dockOpen('files', false); },
    editor: function () { dockOpen('editor', true); },
    browser: function () { dockOpen('browser', true); },
    mail: function () { dockOpen('mail', false); },
    mailtodo: function () { dockOpen('mailtodo', false); },
    docs: function () { dockOpen('docs', true); },
    sheets: function () { dockOpen('sheets', true); },
    slides: function () { dockOpen('slides', true); },
    // Both open empty and ask for a file, since neither can create one.
    pdf: function () { dockOpen('pdf', true); },
    markdown: function () { dockOpen('markdown', true); },
    photos: function () { dockOpen('photos', true); },
    memoryApp: function () { AIOS.apps.launch('memory'); },
    forge: function () { AIOS.apps.launch('forge'); },
    schedule: function () { AIOS.apps.launch('schedule'); },
    // Singleton: a second window would hold a second batch against the same
    // profiles, and filing twice is the mistake this program exists to avoid.
    extract: function () { AIOS.apps.launch('extract'); },
    import: function () { AIOS.userImport('/inbox'); },
    trash: function () { AIOS.openTrash(); },
    policy: function () {
      AIOS.wm.open({
        id: 'sys:policy', kind: 'SECURITY', title: T('policy.title', '能力政策'), w: 420, h: 320,
        render: function (b) { AIOS.render.policy(b); }
      });
    },
    'hud-left': function () { toggleHud('hud-left'); },
    'hud-right': function () { toggleHud('hud-right'); }
  };

  /* ===================================================================
     boot
     =================================================================== */

  window.addEventListener('DOMContentLoaded', async function () {
    // chips
    paintChips();
    $('btn-chips').addEventListener('click', function () { toggleChips(); });
    // A language change repaints everything that wrote its own words.
    document.addEventListener('aios:locale', repaintForLocale);

    // intent bar
    var form = $('intent-form');
    var input = $('intent-input');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      runIntent(input.value);
    });
    input.addEventListener('input', function () { autoGrow(input); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runIntent(input.value);
      }
    });
    $('btn-stop').addEventListener('click', function () {
      K.abort();
      UI.trace(T('ui.stopSent', '中止訊號已送出'), 't-warn');
    });

    // The spend meter zeroes on click, after confirming: it is a record of what
    // this machine has cost and clearing it by mis-click would be annoying.
    var spendBtn = $('s-spend');
    if (spendBtn) {
      spendBtn.addEventListener('click', async function () {
        var s = AIOS.state.spend || {};
        var yes = await AIOS.confirm({
          label: '把累計用量歸零？',
          note: '目前累計 ' + (s.total || 0).toLocaleString() + ' tok，共 ' + (s.turns || 0) +
            ' 次呼叫。歸零只是清掉這個計數，不會影響供應商那邊的帳單。',
          okLabel: '歸零'
        });
        if (yes) {
          K.resetSpend();
          UI.trace('累計用量已歸零', 't-info');
        }
      });
    }

    // menu bar
    var openName = null;
    document.querySelectorAll('.mb-item').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var name = btn.getAttribute('data-menu');
        openName = (openName === name) ? null : name;
        menu(openName, !!openName);
      });
    });
    document.querySelectorAll('.mb-drop button').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act');
        openName = null;
        menu(null, false);
        if (MENU_ACTS[act]) MENU_ACTS[act]();
      });
    });
    document.addEventListener('click', function () {
      if (openName) { openName = null; menu(null, false); }
    });

    // dock
    document.querySelectorAll('.dk[data-dock]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-dock');
        if (DOCK_ACTS[act]) DOCK_ACTS[act]();
      });
      /* The way to a second window of the same program, kept one click away
         rather than made the default -- and a list of the ones already open,
         so a minimised window is reachable from here too. */
      b.addEventListener('contextmenu', function (ev) {
        var act = b.getAttribute('data-dock');
        var appId = act === 'memoryApp' ? 'memory' : act;
        if (!AIOS.apps.list().some(function (d) { return d.id === appId; })) return;
        ev.preventDefault();
        ev.stopPropagation();
        var items = [{
          label: '開新視窗',
          run: function () { AIOS.apps.launch(appId, undefined, { forceNew: true }); }
        }];
        AIOS.apps.windowsFor(appId).forEach(function (inst) {
          items.push({
            label: (inst.win.minimized ? '▫ ' : '▪ ') + String(inst.win.title || appId).slice(0, 40),
            run: function () { AIOS.wm.restore(inst.win); AIOS.wm.focus(inst.win); }
          });
        });
        AIOS.menu.open(b, ev.clientX, ev.clientY, items);
      });
    });

    // led = reconnect
    $('led').addEventListener('click', reconnect);

    // frameless window controls. Closing runs the shutdown ceremony rather
    // than killing the process, so nothing is lost.
    $('wc-min').addEventListener('click', function () { window.aios.win.minimize(); });
    $('wc-full').addEventListener('click', function () { window.aios.win.toggleFullScreen(); });
    $('wc-close').addEventListener('click', function () { AIOS.shutdown.request(); });

    // The main process starts the ceremony; this side performs and narrates it.
    window.aios.shutdown.onStart(function () { AIOS.shutdown.run(); });

    // sandbox panel
    $('sb-import').addEventListener('click', function () { AIOS.userImport('/inbox'); });
    $('sb-open').addEventListener('click', function () { window.aios.user.reveal(); });
    $('sb-taint-clear').addEventListener('click', MENU_ACTS.cleartaint);

    /* Drag and drop from Explorer. The renderer resolves each File to a real
       path through webUtils in the preload and hands the list to the main
       process, which copies into the sandbox. Originals are never touched. */
    var dz = $('dropzone');
    var dragDepth = 0;
    window.addEventListener('dragenter', function (e) {
      e.preventDefault();
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragDepth++;
      dz.hidden = false;
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function (e) {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dz.hidden = true;
    });
    window.addEventListener('drop', async function (e) {
      e.preventDefault();
      dragDepth = 0;
      dz.hidden = true;
      var files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;

      var paths = files.map(function (f) { return window.aios.pathForFile(f); })
        .filter(Boolean);
      if (!paths.length) {
        UI.trace('拖進來的東西沒有檔案路徑（可能是選取的文字或網頁內容）', 't-warn');
        return;
      }

      var res = await window.aios.user.importPaths(paths, '/inbox');
      if (!res.ok) { UI.trace('匯入失敗：' + res.error, 't-err'); return; }
      res.data.imported.forEach(function (f) {
        UI.trace('import: ' + f.from + ' → ' + f.vpath + '（' + AIOS.bytes(f.bytes) +
          '，標記為不可信）', 't-taint');
      });
      res.data.skipped.forEach(function (s) {
        UI.trace('skip: ' + s.src + ' — ' + s.why, 't-warn');
      });
      await AIOS.afterFsChange();
      await K.refreshTaint();
      UI.renderSandbox();
      if (res.data.imported.length) await AIOS.run('fs.list', { dir: '/inbox' });
      refreshMachineState();
      UI.renderContext(K.schedule());
    });

    // budget slider
    var slider = $('budget-slider');
    /* Sized from the model, not from a number typed into the HTML in 2025.
       The slider shipped with max 32768 while this machine was connected to a
       model that holds 1,050,000 -- three per cent of it -- and the user watched
       a 392-token page get evicted 「超出預算」 with a million tokens of room
       going spare. See AIOS.fitBudget for why the ceiling is what it is, and
       why raising it does not by itself make a single request bigger. */
    AIOS.fitBudget();
    slider.addEventListener('input', function () {
      S.budget = parseInt(slider.value, 10);
      $('budget-out').value = S.budget;
      UI.renderContext(K.schedule());
    });

    // global keys
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.focus();
        input.select();
        return;
      }

      // Ctrl+/ toggles the focused window's chat panel. The window chrome
      // advertises this shortcut in its tooltip, so it has to exist.
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        var top = AIOS.wm.topmost && AIOS.wm.topmost();
        var inst = top && AIOS.apps.instanceFor(top);
        if (!inst || !inst.chat) return;
        e.preventDefault();
        var open = inst.chat.toggle();
        var btn = top.barButtons && top.barButtons.chat;
        if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
      }
    });

    window.addEventListener('resize', function () {
      // Keep windows reachable after a viewport change, and keep the dock's
      // toggle state matching the rails' actual visibility at this width.
      var desk = $('desktop');
      AIOS.wm.list().forEach(function (w) {
        w.el.style.left = Math.min(w.el.offsetLeft, Math.max(4, desk.offsetWidth - 90)) + 'px';
      });
      // A maximised window is a claim on the whole desktop, so it follows the
      // desktop rather than keeping the size the old one happened to have.
      AIOS.wm.refitMax();
      syncHudButtons();
    });

    installDockPeek();

    // Refuse to run outside the desktop shell: without the bridge there is no
    // sandbox, and silently falling back to a fake one would be dishonest.
    if (!window.aios) {
      $('boot-log').textContent =
        'FATAL: 找不到 IPC 橋接。\n\n' +
        'AI-OS 需要在桌面應用程式內執行，才有真實的沙箱檔案系統。\n' +
        '請在 ai-os 目錄執行：npm start\n';
      $('boot-status').textContent = 'HALTED';
      return;
    }

    // First paint, then the real boot.
    AIOS.desktopMenu.install();
    UI.startClock();
    syncHudButtons();
    UI.renderJournal();
    UI.renderContext();

    var ok = await UI.boot();

    UI.renderCaps();
    await UI.renderMemory();
    UI.renderSandbox();
    // After the session has been restored, so a carried-over total shows at once
    // rather than only after the next call.
    UI.renderSpend();
    refreshMachineState();
    UI.link(ok ? 'up' : 'down');
    UI.telemetry(null);
    UI.renderContext(K.schedule());
    syncHudButtons();
    AIOS.session.startAutosave();
    /* Last, so a job that fires now finds a machine that can run it. */
    if (AIOS.schedule) AIOS.schedule.start();
    input.focus();
  });
})();
