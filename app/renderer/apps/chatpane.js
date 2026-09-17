'use strict';

/* ===========================================================================
   AI-OS // per-application chat panel
   ---------------------------------------------------------------------------
   Every window on this machine has a conversation attached to it, and that
   conversation knows what the window is doing.

   The panel does not let the model touch the application. Instead each app
   publishes a short verb list -- open this file, insert this text, set this
   cell, rebuild yourself with these changes -- and the model answers with a
   sentence for the human plus, optionally, one named verb and its arguments.
   The app decides what the verb means and whether it succeeded.

   That keeps the blast radius of a hallucination at "called insertText with odd
   arguments" instead of "executed arbitrary code against my document".

   ---------------------------------------------------------------------------
   The thread

   A panel that forgets is a panel you have to brief again every sentence, so
   the conversation is kept as a real thread with three properties:

     - it is measured, not counted. The unit is a token from the server's own
       tokeniser, not a message, because a one-word 「好」 and a six-thousand
       character table dump are not the same amount of remembering.
     - it is trimmed by whole exchanges. An exchange is a request and everything
       that came back from it, and half of one is worse than none: a question
       whose answer was dropped invites the model to answer it again, and a
       receipt with no request attached is an event with no reason.
     - it survives a restart, because the window it belongs to does.

   What the model reads and what you read are stored separately where they
   differ. The receipt on screen is 「✓ setCell — 填了 3 格」; the one in the
   thread is 「(已執行 setCell {"cell":"A1",...})」, arguments included, because
   「再改一次」 has to be able to refer to something.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var K = AIOS.kernel;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function tokFmt(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  /**
   * What an action was actually called with, for the thread's own record.
   *
   * Without this the thread said only 「(已執行 setCell)」, so a follow-up like
   * 「把它改成藍色」 had no antecedent -- the model could see that something
   * happened but not to what.
   */
  function argSummary(args) {
    if (!args || typeof args !== 'object') return '';
    if (!Object.keys(args).length) return '';
    var s;
    try { s = JSON.stringify(args); } catch (e) { return ''; }
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  }

  /**
   * How many tokens of conversation one panel may keep resident.
   *
   * A quarter of the machine's budget, from the same slider that governs the
   * intent bar, so there is one control for "how much this machine remembers"
   * rather than two that disagree. A quarter and not all of it because the
   * panel's prompt also has to fit the app's current state -- up to 6000
   * characters of it, rebuilt every turn -- and the reply.
   *
   * Deliberately not charged against the HUD's resident budget: the panel and
   * the intent bar build two different prompts that are never sent together, so
   * adding one to the other's meter would make the meter lie.
   */
  function threadBudget() {
    return Math.max(512, Math.round((AIOS.state.budget || 8192) / 4));
  }

  /* -------------------------------------------------------------- prompting */

  function actionList(def) {
    return Object.keys(def.actions || {}).map(function (name) {
      var a = def.actions[name];
      /* The return shape when the action has one. The panel's model chains
         actions too -- 「找出被 cc 的那些，再把清單寫成筆記」 needs to know that
         the first one hands back rows rather than a sentence. */
      return '  ' + name + '  ' + (a.args || '{}') +
        (a.returns ? ' -> ' + a.returns : '') + '  // ' + (a.desc || '');
    });
  }

  function systemPrompt(instance) {
    var def = instance.def;
    var lines = [];
    lines.push('你是 AI-OS 裡「' + def.name + '」這個程式內建的助手。');
    if (def.purpose) lines.push('這個程式的用途：' + def.purpose);
    lines.push('使用者正在用這個程式，你要幫他把事情做完，不要只給建議。');
    lines.push('');

    var state = '';
    if (instance.describe) {
      try { state = String(instance.describe() || ''); } catch (e) { state = '(讀不到狀態：' + e.message + ')'; }
    }
    if (state) {
      lines.push('# 程式目前狀態');
      lines.push(state.slice(0, 6000));
      lines.push('');
    }

    var acts = actionList(def);
    if (acts.length) {
      lines.push('# 可用動作');
      lines.push.apply(lines, acts);
      lines.push('');
    }

    lines.push('# 輸出格式');
    lines.push('只輸出 JSON：{"say":"要對使用者說的話"' +
      (acts.length ? ',"actions":[{"name":"動作名稱","args":{...}}]' : '') + '}');
    if (acts.length) {
      lines.push('actions 是陣列，可以省略（只回話時），也可以一次放好幾個 —— ' +
        '它們會照順序執行。使用者一句話要求好幾件事，就全部放進去，不要只做第一件。' +
        '最多 ' + maxActions(def) + ' 個。');
      lines.push('只能用上面列出的動作名稱，args 的鍵要照簽名寫。');
      lines.push('使用者要你「做」某件事時，就給 actions，不要只說你會做。');
      lines.push('如果有些事你做不到（沒有對應的動作、或參數不明），' +
        'say 要明講哪些做了、哪些沒做，不要只回報做到的部分。');
    }
    lines.push('say 用繁體中文，簡短，不要重複使用者的話。');
    lines.push('狀態裡看得到答案就直接回答，不要說你看不到。');
    /* The same enrichment the intent bar applies. 「把這份紀錄整理成周報」 is
       asked inside the document app as often as at the intent bar, and the
       answer should not depend on which box it was typed into. Only for
       programs that produce content; a spreadsheet's setRange does not need a
       paragraph about audiences. */
    if (def.contentApp) {
      lines.push('');
      lines.push(K.contentGuide('panel'));
    }
    return lines.join('\n');
  }

  /* How many actions one turn may run.
     A cap rather than no limit: a turn is a single thing the user asked for, and
     a model that answers with thirty steps has misunderstood rather than been
     thorough. An app can raise it if its verbs are naturally fine-grained. */
  function maxActions(def) {
    return Math.max(1, Math.min(24, def.chatMaxActions || 8));
  }

  function schemaFor(def) {
    var names = Object.keys(def.actions || {});
    var props = { say: { type: 'string' } };
    if (names.length) {
      var one = {
        type: 'object',
        properties: {
          name: { type: 'string', enum: names },
          args: { type: 'object' }
        },
        required: ['name']
      };
      /* A list, because people ask for more than one thing at a time.
         With a single slot, 「把第 3 段設成粗體，並且把字型改成標楷體，然後存檔」
         did the first, said 「已將第 3 段設為粗體。」 and dropped the rest without
         saying so -- the reply read as complete success. Measured: 42.7s and
         4066 thinking tokens went into choosing which third of the request to
         honour. */
      props.actions = { type: 'array', items: one, maxItems: maxActions(def) };
      // The singular is still accepted on the way in; some replies keep using it.
      props.action = one;
    }
    return { type: 'object', properties: props, required: ['say'] };
  }

  /** Whatever shape the reply used, as a list. */
  function actionsOf(data, def) {
    var list = [];
    if (data && Array.isArray(data.actions)) list = data.actions.slice();
    if (data && data.action) list.push(data.action);
    return list.filter(function (a) { return a && a.name; }).slice(0, maxActions(def));
  }

  /* ------------------------------------------------------------------ panel */

  function attach(split, ctx, instance, saved) {
    var def = instance.def;
    var aside = el('aside', 'app-chat');
    aside.setAttribute('aria-label', def.name + ' 的 AI 對話');
    split.appendChild(aside);

    var head = el('div', 'chat-head');
    head.appendChild(el('span', 'chat-title', 'AI 對話'));
    // How much of the thread is resident. On screen because a conversation that
    // silently drops its oldest turns looks like a model that got worse.
    var ctxOut = el('span', 'chat-ctx');
    head.appendChild(ctxOut);
    var clear = el('button', 'fbtn', '清除');
    clear.type = 'button';
    clear.title = '清掉這個程式的對話紀錄';
    head.appendChild(clear);
    aside.appendChild(head);

    var log = el('div', 'chat-log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    aside.appendChild(log);

    var form = el('form', 'chat-form');
    var input = el('textarea', 'chat-input');
    input.rows = 1;
    input.placeholder = '要這個程式做什麼？';
    input.setAttribute('aria-label', '對 ' + def.name + ' 說');
    var send = el('button', 'chat-send', '\u23ce');
    send.type = 'submit';
    send.title = '送出 (Enter)';
    form.appendChild(input);
    form.appendChild(send);
    aside.appendChild(form);

    /* [{ n, tokens, msgs: [{ role, content, view, shown }] }]
       `content` is what the model reads, `shown` what the log shows when they
       differ, `view` which of the four line styles redraws it after a restart. */
    var thread = [];
    var threadSeq = 0;
    var busy = false;
    var open = false;

    function threadTokens() {
      return thread.reduce(function (n, x) { return n + (x.tokens || 0); }, 0);
    }

    /** The thread as the model sees it: roles and content, nothing else. */
    function messages() {
      var out = [];
      thread.forEach(function (x) {
        x.msgs.forEach(function (m) { out.push({ role: m.role, content: m.content }); });
      });
      return out;
    }

    function record(ex, role, content, view, shown) {
      ex.msgs.push({ role: role, content: content, view: view, shown: shown || null });
    }

    function renderUsage() {
      var cap = threadBudget();
      var used = threadTokens();
      ctxOut.textContent = thread.length ? thread.length + ' 輪 · ' + tokFmt(used) + '/' + tokFmt(cap) : '';
      ctxOut.title = '這個面板記著的對話脈絡：' + thread.length + ' 輪、' + used + ' tok，' +
        '上限 ' + cap + ' tok（左側 HUD 那支預算滑桿的四分之一）。' +
        '超過就從最舊的一輪整輪捨棄，並在對話裡說一聲。';
    }

    /**
     * Measure the newest exchange, then evict whole exchanges from the front
     * until the thread fits.
     *
     * The newest one is never dropped even if it alone exceeds the budget: a
     * panel that forgot the thing it is answering right now is not forgetting,
     * it is broken. Its own reply gets truncated by the server instead, which is
     * a bounded failure the user can see.
     */
    async function settle() {
      var last = thread[thread.length - 1];
      if (last) {
        last.tokens = await K.tokenize(last.msgs.map(function (m) { return m.content; }).join('\n'));
      }
      var cap = threadBudget();
      var dropped = 0;
      while (thread.length > 1 && threadTokens() > cap) { thread.shift(); dropped++; }
      if (dropped) {
        note('（脈絡上限 ' + tokFmt(cap) + ' tok 到了，已捨棄最早的 ' + dropped + ' 輪對話）');
      }
      renderUsage();
      AIOS.apps.requestSave();
    }

    function bubble(role, text, cls) {
      var b = el('div', 'chat-msg chat-' + role + (cls ? ' ' + cls : ''));
      b.textContent = text;
      log.appendChild(b);
      log.scrollTop = log.scrollHeight;
      return b;
    }

    function note(text, cls) {
      var n = el('div', 'chat-note' + (cls ? ' ' + cls : ''), text);
      log.appendChild(n);
      log.scrollTop = log.scrollHeight;
      return n;
    }

    /**
     * Put a saved thread back, both into the log and into what the model reads.
     *
     * Redrawing the log matters as much as reloading the thread: a model that
     * remembers a conversation the human cannot see is worse than one that
     * forgot, because there is no way to tell what it is working from.
     */
    function restore(state) {
      var list = state && Array.isArray(state.thread) ? state.thread : [];
      threadSeq = Number(state && state.seq) || 0;
      list.forEach(function (x) {
        var msgs = (x.msgs || []).filter(function (m) { return m && m.content; });
        if (!msgs.length) return;
        thread.push({ n: x.n || ++threadSeq, tokens: Number(x.tokens) || 0, msgs: msgs });
        msgs.forEach(function (m) {
          var text = m.shown || m.content;
          if (m.view === 'user' || m.view === 'assistant') bubble(m.view, text);
          else note(text, m.view === 'err' ? 'chat-err' : 'chat-ok');
        });
      });
      if (threadSeq < thread.length) threadSeq = thread.length;
      return thread.length;
    }

    if (restore(saved)) {
      note('（以上 ' + thread.length + ' 輪是上次的對話，模型讀得到）');
    } else if (def.chatHint) {
      note(def.chatHint);
    }
    renderUsage();

    clear.addEventListener('click', function () {
      thread.length = 0;
      log.innerHTML = '';
      if (def.chatHint) note(def.chatHint);
      renderUsage();
      // Clearing has to reach the session file too, or the thread comes back.
      AIOS.apps.requestSave();
    });

    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(120, input.scrollHeight) + 'px';
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });

    async function submit() {
      var text = input.value.trim();
      if (!text || busy) return;
      input.value = '';
      input.style.height = 'auto';
      bubble('user', text);
      await run(text);
    }

    async function run(text) {
      busy = true;
      send.disabled = true;
      if (!AIOS.state.connected) {
        note('沒有連上模型，這個面板需要核心才能回答。', 'chat-err');
        busy = false; send.disabled = false;
        return;
      }

      /* The caller drew the user's bubble already -- submit() and ask() both do,
         because the text should appear the instant it is sent. Here it only
         joins the thread. */
      var ex = { n: ++threadSeq, tokens: 0, msgs: [] };
      thread.push(ex);
      record(ex, 'user', text, 'user');

      var streaming = bubble('assistant', '', 'chat-streaming');
      var acc = '';

      try {
        var res = await K.complete({
          // The state block is rebuilt every turn, so the thread carries what was
          // said and the system prompt carries what is true now. A remembered
          // description of a document that has since changed is worse than none.
          messages: [{ role: 'system', content: systemPrompt(instance) }].concat(messages()),
          schema: schemaFor(def),
          schemaName: 'appreply',
          // A hosted provider is only held to "some JSON", and one of them does
          // occasionally answer with a plain sentence. Here that is a real answer:
          // the model talked instead of acting.
          proseAs: 'say',
          temperature: 0.4,
          maxTokens: def.chatMaxTokens || 1400,
          onToken: function (piece) {
            acc += piece;
            // Show the say field as it forms rather than raw JSON.
            var m = acc.match(/"say"\s*:\s*"((?:[^"\\]|\\.)*)/);
            streaming.textContent = m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '思考中…';
            log.scrollTop = log.scrollHeight;
          }
        });

        streaming.classList.remove('chat-streaming');
        var data = res.data || {};
        var say = String(data.say || '').trim();
        var planned = actionsOf(data, def);
        /* A hosted provider is held to `json_object`, not to the schema, so
           `required: ['say']` is a request rather than a rule -- and one of them
           did omit it while still asking for an action. 「沒有回覆內容」 next to a
           receipt for work that happened is the panel calling itself a liar. */
        if (!say && planned.length) {
          say = '（沒有說明，只給了動作：' +
            planned.map(function (a) { return a.name; }).join('、') + '）';
        }
        streaming.textContent = say || '(沒有回覆內容)';
        record(ex, 'assistant', say || '(ok)', 'assistant', streaming.textContent);

        /* A hosted reasoning model spends its thinking out of the same output cap,
           so a high thinking level and a low cap return a truncated sentence --
           or nothing at all. Without this the panel showed an empty bubble and no
           reason, which reads as the model failing rather than as a setting. */
        if (res.finish === 'length') {
          note('回覆到達長度上限就被切斷了。思考的 token 也算在同一個上限裡，' +
            '到「系統 → 核心模型」把「輸出上限」調高，或把思考模式調低。', 'chat-err');
        }

        if (AIOS.ui) AIOS.ui.telemetry(res.timings);

        /* On a hosted core the thinking is billed and invisible, so the panel says
           what the turn cost. Nothing to show for the local host, which is free. */
        // Panels spend from the same purse as the intent bar.
        K.addSpend(res.spend);
        if (res.spend && AIOS.state.remote) {
          note('用量：prompt ' + res.spend.prompt + '、回覆 ' + res.spend.output +
            (res.spend.thinking ? '、思考 ' + res.spend.thinking +
              (res.spend.thinkingHidden ? '（供應商只算在總數裡）' : '') : '') +
            '、合計 ' + res.spend.total + ' tok');
        }

        /* Run them in order, and stop at the first failure.
           Not "carry on with the rest": these are steps of one request, and the
           later ones assume the earlier ones happened. Formatting block 4 after
           the insert meant to create it failed would format somebody else's
           paragraph, and a wrong action is worse than a missing one. What ran and
           what was abandoned are both said, on screen and in the thread. */
        var queue = actionsOf(data, def);
        for (var ai = 0; ai < queue.length; ai++) {
          var act = queue[ai];
          var step = queue.length > 1 ? '(' + (ai + 1) + '/' + queue.length + ') ' : '';
          var left = queue.length - ai - 1;
          var stop = false;
          var spec = (def.actions || {})[act.name];
          if (!spec) {
            var bad = note(step + '模型要求了不存在的動作：' + act.name, 'chat-err');
            // In the thread as well, or the next turn asks for it again.
            record(ex, 'assistant', '(沒有這個動作：' + act.name + '，不要再用這個名稱)',
              'err', bad.textContent);
            stop = true;
          } else {
            var sig = argSummary(act.args);
            var line = note(step + '執行 ' + act.name + '…');
            try {
              var out = await spec.run(act.args || {}, ctx, instance);
              line.textContent = '\u2713 ' + step + act.name + (out && out.note ? ' — ' + out.note : '');
              line.className = 'chat-note chat-ok';
              record(ex, 'assistant',
                '(已執行 ' + act.name + (sig ? ' ' + sig : '') +
                  (out && out.note ? '；' + out.note : '') + ')',
                'ok', line.textContent);
              AIOS.apps.requestSave();
            } catch (e) {
              line.textContent = '\u2715 ' + step + act.name + ' — ' + (e.message || e);
              line.className = 'chat-note chat-err';
              // Tell the model what went wrong, and with what, so a follow-up can
              // correct the arguments rather than guess at them again.
              record(ex, 'assistant',
                '(動作 ' + act.name + (sig ? ' ' + sig : '') + ' 失敗：' + (e.message || e) + ')',
                'err', line.textContent);
              stop = true;
            }
          }

          if (stop) {
            /* Saying how many were dropped matters more than it looks: the reply
               above was written before any of this ran, so it describes the whole
               request. Without this line the panel shows a plan and a partial
               result, and lets the user assume the two match. */
            if (left) {
              var halt = note('中止：後面 ' + left + ' 個動作沒有執行。', 'chat-err');
              record(ex, 'assistant',
                '(因此中止，後面 ' + left + ' 個動作沒有執行)', 'err', halt.textContent);
            }
            break;
          }
        }
      } catch (e) {
        streaming.classList.remove('chat-streaming');
        streaming.textContent = '回覆失敗：' + (e.message || e);
        streaming.classList.add('chat-err');
        /* Nothing usable came back, so there is nothing to remember. Leaving the
           question in the thread would make the next turn look like it was asked
           twice -- and the retry is going to ask it again for real. */
        var at = thread.indexOf(ex);
        if (at >= 0) thread.splice(at, 1);
      } finally {
        busy = false;
        send.disabled = false;
        await settle();
      }
    }

    function toggle(force) {
      open = force === undefined ? !open : !!force;
      aside.classList.toggle('open', open);
      split.classList.toggle('chat-open', open);
      if (open) window.setTimeout(function () { input.focus(); }, 60);
      // A native browser view has to be repositioned when the layout shifts.
      if (instance.ctrl && instance.ctrl.onResize) {
        window.setTimeout(function () { instance.ctrl.onResize(); }, 220);
      }
      AIOS.apps.requestSave();
      return open;
    }

    return {
      toggle: toggle,
      isOpen: function () { return open; },
      say: function (text, cls) { return note(text, cls); },
      ask: function (text) { toggle(true); bubble('user', text); return run(text); },
      history: messages,
      usage: function () { return { turns: thread.length, tokens: threadTokens(), budget: threadBudget() }; },

      /** The thread, for the session snapshot. Null when there is nothing yet. */
      export: function () {
        if (!thread.length) return null;
        return {
          seq: threadSeq,
          thread: thread.map(function (x) {
            return {
              n: x.n,
              tokens: x.tokens,
              msgs: x.msgs.map(function (m) {
                return { role: m.role, content: m.content, view: m.view, shown: m.shown };
              })
            };
          })
        };
      }
    };
  }

  /** One-off question with an app's context attached, outside the visible log. */
  async function ask(instance, prompt) {
    var res = await K.complete({
      messages: [
        { role: 'system', content: systemPrompt(instance) },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      maxTokens: 1200
    });
    return res.text;
  }

  AIOS.chatpane = { attach: attach, ask: ask, systemPrompt: systemPrompt };
})();
