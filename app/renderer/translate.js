'use strict';

/* ===========================================================================
   AI-OS // web translation, the part a person touches
   ---------------------------------------------------------------------------
   The work itself is in the main process (main/translate.js): it drives the
   agent in the page, batches the paragraphs, calls the model and puts the
   answers back. None of that is here, and deliberately so -- the page's text
   is untrusted and never needs to reach this document at all.

   What is here is the surface: the toolbar toggle, the popover of things a
   person changes mid-page, and the settings form. They send commands and
   receive progress; they never see a paragraph.

   Progress while a page is being translated is shown *in the page*, bottom
   right, by the agent -- a native view paints above everything this document
   draws, so a strip drawn here would be behind the page it is reporting on.
   The status line in the window mirrors it for the case where the view is
   detached (a settings pane open, a window covered).
   =========================================================================== */

/* global window, document */

(function () {
  var AIOS = (window.AIOS = window.AIOS || {});
  var A = window.aios;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function unwrap(r, what) {
    if (!r || !r.ok) throw new Error((r && r.error) || (what || '翻譯') + '失敗');
    return r.data;
  }

  var TONE_LABELS = {
    natural: '自然流暢', technical: '專業技術文件', academic: '學術嚴謹',
    casual: '輕鬆口語', news: '新聞報導'
  };
  var STYLE_LABELS = {
    underline: '虛線底線', box: '虛線外框', plain: '純色文字',
    tint: '淡色底', bar: '左側色條'
  };
  var TARGET_LABELS = {
    'zh-TW': '繁體中文', 'zh-CN': '简体中文', en: 'English',
    ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español'
  };
  var EFFORT_LABELS = {
    none: '關閉思考（建議）', minimal: '最低', low: '低',
    medium: '中', high: '高', max: '最高', default: '跟隨核心模型設定'
  };

  function labelled(row, text, hint) {
    var l = el('label', 'tr-label', text);
    if (hint) l.title = hint;
    row.appendChild(l);
    return l;
  }

  function select(values, current, labels) {
    var s = el('select', 'tr-input');
    values.forEach(function (v) {
      var o = el('option', null, (labels && labels[v]) || v);
      o.value = v;
      if (v === current) o.selected = true;
      s.appendChild(o);
    });
    return s;
  }

  function numberField(value, min, max) {
    var i = el('input', 'tr-input');
    i.type = 'number';
    i.min = String(min);
    i.max = String(max);
    i.value = String(value);
    return i;
  }

  AIOS.translate = (function () {

    /**
     * The settings form.
     *
     * Every field writes through to the main process as it changes rather than
     * on a Save button: there is nothing here that is only valid as a set, and
     * a form that silently keeps changes the machine has not accepted is the
     * shape that produces "I turned that off and it kept doing it".
     */
    function settingsForm(host, opts) {
      var onChange = (opts && opts.onChange) || function () {};
      var wrap = el('div', 'tr-conf');
      host.appendChild(wrap);

      var cfg = null;

      function row(text, hint, control) {
        var r = el('div', 'tr-row');
        labelled(r, text, hint);
        r.appendChild(control);
        wrap.appendChild(r);
        return r;
      }

      function note(text) {
        wrap.appendChild(el('p', 'tr-note', text));
      }

      function section(text) {
        wrap.appendChild(el('h4', 'tr-sec', text));
      }

      /**
       * Write through, then show what came back.
       *
       * The main process clamps and rejects (a batch of 999999 characters
       * becomes 8000, a nonsense language is refused), and a form that keeps
       * showing what was typed claims a setting the machine does not have.
       * `field` is the control to correct; everything else is left alone so
       * that typing in one box does not rewrite another.
       */
      async function save(patch, field, key) {
        try {
          cfg = unwrap(await A.translate.setSettings(patch), '儲存設定');
          if (field && key && document.activeElement !== field) {
            var got = cfg[key];
            field.value = got === null || got === undefined ? '' : String(got);
          }
          onChange(cfg);
        } catch (e) {
          if (AIOS.ui) AIOS.ui.trace('翻譯設定沒存起來：' + (e.message || e), 't-err');
        }
      }

      async function build() {
        cfg = unwrap(await A.translate.settings(), '讀取設定');
        wrap.innerHTML = '';

        section('翻譯');
        var target = select(cfg.targets, cfg.target, TARGET_LABELS);
        target.addEventListener('change', function () { save({ target: target.value }); });
        row('目標語言', '要翻成哪一種語言。改了之後重新翻譯這一頁才會生效。', target);

        var tone = select(cfg.tones, cfg.tone, TONE_LABELS);
        tone.addEventListener('change', function () { save({ tone: tone.value }); });
        row('語氣風格', '決定潤飾方向：技術文件不加修飾，口語會鬆一點。', tone);

        var domain = el('input', 'tr-input');
        domain.type = 'text';
        domain.value = cfg.domain;
        domain.placeholder = '例如：大型語言模型推論與 GPU 硬體';
        domain.addEventListener('change', function () { save({ domain: domain.value }); });
        row('領域提示', '寫上這一頁的主題，術語會準確得多。', domain);

        var style = select(cfg.styles, cfg.style, STYLE_LABELS);
        style.addEventListener('change', function () { save({ style: style.value }); });
        row('對照樣式', '譯文在原文底下長什麼樣子。正在翻譯的頁面會立刻換掉。', style);

        var viewport = el('input');
        viewport.type = 'checkbox';
        viewport.checked = cfg.viewportOnly;
        viewport.addEventListener('change', function () { save({ viewportOnly: viewport.checked }); });
        row('只翻譯捲動到的區域', '預設開啟。邊捲邊翻，沒看到的段落不花錢。', viewport);

        var skip = el('input', 'tr-input');
        skip.type = 'text';
        skip.value = cfg.skipSelector;
        skip.placeholder = '例如：.highlight, nav';
        skip.addEventListener('change', function () { save({ skipSelector: skip.value }); });
        row('跳過的 CSS 選擇器', '符合的區塊完全不翻譯。程式碼區塊、輸入框、已經是目標語言的段落本來就會跳過。', skip);

        section('批次與模型');
        var chars = numberField(cfg.batchChars, cfg.limits.batchChars[0], cfg.limits.batchChars[1]);
        chars.addEventListener('change', function () { save({ batchChars: chars.value }, chars, 'batchChars'); });
        row('每批字元數', '太大容易被模型截斷（會提示 MAX_TOKENS），太小則請求次數變多。預設 1800。', chars);

        var segs = numberField(cfg.batchSegments, cfg.limits.batchSegments[0], cfg.limits.batchSegments[1]);
        segs.addEventListener('change', function () { save({ batchSegments: segs.value }, segs, 'batchSegments'); });
        row('每批段落數', '一次最多送幾段。', segs);

        var conc = numberField(cfg.concurrency, cfg.limits.concurrency[0], cfg.limits.concurrency[1]);
        conc.addEventListener('change', function () { save({ concurrency: conc.value }, conc, 'concurrency'); });
        row('同時請求數', '同時進行的批次數。太多會被供應商限流（429 會自動退避重試）。', conc);

        var effort = select(cfg.efforts, cfg.reasoning, EFFORT_LABELS);
        effort.addEventListener('change', function () { save({ reasoning: effort.value }); });
        row('思考程度', '翻譯不需要推理。「關閉思考」會依供應商送出 enable_thinking=false、' +
          'thinking.type=disabled 或 reasoning_effort=none；不支援的參數會自動略過。', effort);

        var temp = el('input', 'tr-input');
        temp.type = 'text';
        temp.value = cfg.temperature === null || cfg.temperature === undefined ? '' : String(cfg.temperature);
        temp.placeholder = '留空＝用模型自己的預設';
        temp.addEventListener('change', function () { save({ temperature: temp.value }, temp, 'temperature'); });
        row('temperature', 'Gemini 3 與 GPT-5 系列建議留空：留空就完全不送這個欄位，跟送 0.3 是不同的請求。', temp);

        section('自動翻譯與快取');
        var auto = select(['off', 'all', 'domains'], cfg.auto, {
          off: '關閉', all: '每一個網站都自動翻譯', domains: '只對指定網域自動翻譯'
        });
        auto.addEventListener('change', function () { save({ auto: auto.value }); });
        row('自動翻譯', '頁面載入完成就開始翻譯。指定網域的清單可以在網址列旁邊的翻譯選單勾選。', auto);

        var doms = el('textarea', 'tr-input tr-area');
        doms.rows = 3;
        doms.value = cfg.autoDomains.join('\n');
        doms.placeholder = '一行一個網域，例如 example.com';
        doms.addEventListener('change', function () {
          save({ autoDomains: doms.value.split(/[\s,]+/).filter(Boolean) });
        });
        row('自動翻譯的網域', '子網域也算。', doms);

        var cacheOn = el('input');
        cacheOn.type = 'checkbox';
        cacheOn.checked = cfg.cacheOn;
        cacheOn.addEventListener('change', function () { save({ cacheOn: cacheOn.checked }); });
        row('使用翻譯快取', '重複的段落不會重複計費，換模型或換語氣就不會用到舊的。', cacheOn);

        var cacheRow = el('div', 'tr-row');
        labelled(cacheRow, '快取內容');
        var cacheBox = el('div', 'tr-cache');
        var cacheNum = el('span', 'tr-cache-n', '…');
        var clearBtn = el('button', 'fbtn', '清空快取');
        clearBtn.type = 'button';
        cacheBox.appendChild(cacheNum);
        cacheBox.appendChild(clearBtn);
        cacheRow.appendChild(cacheBox);
        wrap.appendChild(cacheRow);

        async function showCache() {
          try {
            var st = unwrap(await A.translate.cacheStats(), '讀取快取');
            cacheNum.textContent = st.entries + ' / ' + st.max + ' 段';
          } catch (e) { cacheNum.textContent = '（讀不到）'; }
        }
        clearBtn.addEventListener('click', async function () {
          try {
            unwrap(await A.translate.clearCache(), '清空快取');
          } catch (e) {
            if (AIOS.ui) AIOS.ui.trace('清空快取失敗：' + (e.message || e), 't-err');
          }
          showCache();
        });
        showCache();

        note('譯文是插在原文段落後面的 <span>，原始節點完全沒有被改寫；關閉翻譯只是把它們隱藏起來。' +
          '網頁內容一律當成資料而不是指令送給模型，回來的字只會以純文字放進頁面。');
      }

      build();
      return { el: wrap, reload: build };
    }

    /**
     * The toolbar controls for one browser window.
     *
     * `api` supplies what only the window knows: which native tab is in front
     * and what it is showing.
     */
    function controls(ctx, api) {
      var btn = el('button', 'fbtn br-tr', '翻譯');
      btn.type = 'button';
      btn.title = '把這一頁翻成設定的語言，譯文插在原文下面';
      var moreBtn = el('button', 'fbtn br-tr-more', '▾');
      moreBtn.type = 'button';
      moreBtn.title = '翻譯選項';

      var running = false;
      var shown = true;
      var last = null;

      function paint() {
        btn.classList.toggle('on', running);
        btn.textContent = running ? '翻譯中' : (shown ? '翻譯' : '顯示譯文');
        if (last && last.running) {
          btn.textContent = last.phase === 'done' ? '已翻譯' : '翻譯中';
        }
      }

      async function refresh() {
        var id = api.tabId();
        if (!id) { running = false; shown = true; last = null; paint(); return; }
        try {
          last = unwrap(await A.translate.status(id), '翻譯狀態');
          running = !!last.running;
        } catch (e) {
          /* A status that could not be read is not a status: keeping the last
             one let the button say 翻譯中 about a tab that had none, and a
             click then started a second run behind the first. */
          last = null;
          running = false;
        }
        /* Nothing translated on this tab means there is nothing to re-show, so
           the button is an offer to translate rather than to unhide. Without
           this, hiding a translation and then navigating left the first press
           on the new page doing nothing at all. */
        if (!last || (!last.running && !last.done)) shown = true;
        paint();
      }

      async function start() {
        var id = api.tabId();
        if (!id) { ctx.toast('還沒有開啟任何頁面', 't-warn'); return; }
        btn.disabled = true;
        try {
          last = unwrap(await A.translate.start(id), '開始翻譯');
          running = true;
          shown = true;
          ctx.toast('開始翻譯這一頁', 't-info');
        } catch (e) {
          ctx.toast('翻譯失敗：' + (e.message || e), 't-err');
        } finally {
          btn.disabled = false;
          paint();
        }
      }

      async function stop() {
        var id = api.tabId();
        if (!id) return;
        try {
          unwrap(await A.translate.stop(id), '停止翻譯');
        } catch (e) { /* the tab may be gone; the button still has to settle */ }
        running = false;
        shown = false;
        paint();
      }

      btn.addEventListener('click', function () {
        if (running) return stop();
        if (!shown) {
          // Translated already, then hidden: showing it again costs nothing.
          shown = true;
          A.translate.setVisible(api.tabId(), true);
          paint();
          return;
        }
        return start();
      });

      moreBtn.addEventListener('click', function () {
        var url = api.url();
        AIOS.popover(ctx.body, moreBtn, function (panel, close) {
          panel.appendChild(el('div', 'ui-pop-label', '翻譯'));

          var q = el('div', 'tr-quick');

          function line(text, control) {
            var r = el('label', 'tr-quick-row');
            r.appendChild(el('span', null, text));
            r.appendChild(control);
            q.appendChild(r);
            return r;
          }

          A.translate.settings().then(function (r) {
            if (!r || !r.ok) return;
            var cfg = r.data;

            var target = select(cfg.targets, cfg.target, TARGET_LABELS);
            target.addEventListener('change', function () {
              A.translate.setSettings({ target: target.value });
            });
            line('目標語言', target);

            var style = select(cfg.styles, cfg.style, STYLE_LABELS);
            style.addEventListener('change', function () {
              A.translate.setSettings({ style: style.value });
            });
            line('對照樣式', style);

            var vp = el('input');
            vp.type = 'checkbox';
            vp.checked = cfg.viewportOnly;
            vp.addEventListener('change', function () {
              A.translate.setSettings({ viewportOnly: vp.checked });
            });
            line('只翻譯捲動到的區域', vp);

            A.translate.autoState(url).then(function (ar) {
              if (!ar || !ar.ok) return;
              var site = el('input');
              site.type = 'checkbox';
              site.checked = ar.data.onList;
              site.disabled = !ar.data.host;
              site.addEventListener('change', function () {
                A.translate.setAutoDomain(url, site.checked);
              });
              line('此網站自動翻譯' + (ar.data.host ? '（' + ar.data.host + '）' : ''), site);
            });
          });

          panel.appendChild(q);

          var acts = el('div', 'tr-quick-acts');
          var retryBtn = el('button', 'fbtn', '重試失敗的段落');
          retryBtn.type = 'button';
          retryBtn.addEventListener('click', function () {
            A.translate.retry(api.tabId());
            close();
          });
          acts.appendChild(retryBtn);

          var confBtn = el('button', 'fbtn', '翻譯設定…');
          confBtn.type = 'button';
          confBtn.addEventListener('click', function () {
            close();
            api.openSettings();
          });
          acts.appendChild(confBtn);
          panel.appendChild(acts);
        }, 'tr-pop');
      });

      /* Progress comes from the main process, for every tab. Only the one this
         window is showing may touch this window's button. */
      var off = A.translate.onProgress(function (p) {
        if (!p || p.tabId !== api.tabId()) return;
        last = p;
        running = !!p.running;
        paint();
        api.onProgress(p);
      });

      return {
        button: btn,
        more: moreBtn,
        refresh: refresh,
        stop: stop,
        state: function () { return last; },
        destroy: function () { if (typeof off === 'function') off(); }
      };
    }

    return { controls: controls, settingsForm: settingsForm, TARGET_LABELS: TARGET_LABELS };
  })();
})();
