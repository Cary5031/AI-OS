'use strict';

/* ===========================================================================
   AI-OS // the page agent for web translation
   ---------------------------------------------------------------------------
   This is the only code AI-OS runs inside a web page, and it runs in an
   ISOLATED WORLD (main/translate.js injects it with
   executeJavaScriptInIsolatedWorld). That matters more than anything else
   here: browser views are created with `preload: undefined` on purpose --
   "untrusted content must not be able to reach into the application" -- and an
   isolated world keeps that promise. The agent shares the page's DOM and
   nothing else: the page cannot see its variables, cannot call it, and cannot
   replace it, and the agent has no IPC, no require, and no channel of its own.
   Measured, on a page serving `default-src 'none'`: the page's own script
   reading `window.__aiosTr` gets undefined and finds no matching key on
   window, while the agent sees the same `document`.

   Because it has no channel, the main process drives it and polls it: every
   call below returns a plain JSON value, and anything that happens on its own
   schedule (an element scrolling into view, a page adding paragraphs, the
   person pressing 重試) is put in a queue that the next poll drains. There is
   no other way out of here, which is the point.

   The source is a real function rather than a string so that it is syntax
   checked with the rest of the machine, can be read with normal highlighting,
   and cannot rot behind escaping. It is handed over with Function.prototype
   .toString(), so it must close over NOTHING outside itself.

   Translations are inserted as a <span> whose textContent is the model's
   answer -- never innerHTML. The model wrote that string after reading a
   hostile page, so it is treated as text, exactly like the extension
   vocabulary in browser.js treats its replacements. Turning translation off
   hides the spans; it never rewrites the original nodes, which are not
   touched at any point.
   =========================================================================== */

/* eslint-disable */
function pageAgent() {
  const NS = '__aiosTr';
  if (globalThis[NS] && globalThis[NS].version === 3) return 'already';

  const HUD_ID = 'aios-tr-hud';
  const SPAN_CLASS = 'aios-tr-line';
  const MARK = 'data-aios-tr';

  /* Elements whose text is not prose and must never be sent anywhere: code,
     form controls, media, and the machinery of the page itself. */
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'PRE', 'CODE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'OPTGROUP', 'SVG', 'MATH', 'IFRAME',
    'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'MAP', 'AREA', 'TITLE'
  ]);
  /* What is not part of a sentence even when it sits inside one. Deliberately
     smaller than SKIP_TAGS: an inline <code> in the middle of a paragraph IS
     part of that paragraph, and dropping it sent the model 「Call  to reach the
     network」 -- a sentence with a hole in it, translated as if the hole were
     meant. A <pre> block inside a container is a different thing and still
     goes. */
  const TEXT_SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'PRE', 'TEXTAREA', 'SELECT',
    'SVG', 'MATH', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED'
  ]);
  /* What counts as one paragraph. DIV and friends are included because a great
     many sites lay paragraphs out with them, and excluding them left long
     articles half translated; a wrapper is dropped later by having no text of
     its own rather than by being the wrong tag. */
  const BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'DT', 'DD',
    'FIGCAPTION', 'CAPTION', 'TD', 'TH', 'SUMMARY', 'DIV', 'SECTION', 'ARTICLE',
    'ASIDE', 'HEADER', 'FOOTER', 'MAIN', 'LABEL', 'LEGEND', 'ADDRESS'
  ]);
  /* The same list as a selector, for asking "is there a block inside this?".
     Kept beside BLOCK_TAGS rather than derived, because it is read on a hot
     path and building it per call showed up while scrolling. */
  const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,dt,dd,figcaption,caption,td,th,' +
    'summary,div,section,article,aside,header,footer,main,label,legend,address';

  const state = {
    on: false,
    /* Which run these ids belong to. A document that has been navigated away
       from gets a fresh world and starts numbering at g1 again, so a batch
       still in flight for the old page would otherwise be applied to whatever
       paragraph now happens to be called g1 -- text from one site written into
       another. Every apply carries the run it was collected under. */
    run: '',
    visible: true,
    target: 'zh-TW',
    viewportOnly: true,
    skipSelector: '',
    style: 'underline',
    minChars: 2,
    maxChars: 6000,
    seq: 0
  };

  const byId = new Map();       // id -> { el, text, status }
  const seen = new WeakMap();   // element -> id
  const events = [];
  let io = null;
  let mo = null;
  let rescanTimer = null;
  let rescanSince = 0;
  let sheet = null;
  let hud = null;
  let hudShadow = null;
  let hudText = null;
  let hudRetry = null;
  let hudClose = null;
  let lastStatus = { phase: 'idle', done: 0, total: 0, failed: 0, text: '' };
  /* Records released because their element left the page. Counted only so the
     number is visible when something looks wrong. */
  let gone = 0;

  function push(kind, detail) {
    events.push({ kind: kind, detail: detail || null, at: Date.now() });
    if (events.length > 200) events.splice(0, events.length - 200);
  }

  /* ------------------------------------------------------------ styling */

  /* A constructed stylesheet rather than a <style> element: a page serving
     `style-src 'none'` blocks the element, and adopted stylesheets from an
     isolated world are not subject to the page's policy. Verified against
     such a page before this was written. */
  function styleText() {
    return [
      '.' + SPAN_CLASS + ' {',
      '  display: block;',
      '  margin: .35em 0 .1em;',
      '  color: var(--aios-tr-accent, #1558b0);',
      '  font-size: inherit; font-family: inherit; line-height: 1.5;',
      '  text-align: inherit;',
      '}',
      '.' + SPAN_CLASS + '[hidden] { display: none !important; }',
      /* The five contrast styles. The attribute lives on <html>, so switching
         is one write and no walk over the inserted spans. */
      '[' + MARK + '-style="underline"] .' + SPAN_CLASS + ' {',
      '  border-bottom: 1px dashed var(--aios-tr-accent, #1558b0);',
      '  padding-bottom: .15em;',
      '}',
      '[' + MARK + '-style="box"] .' + SPAN_CLASS + ' {',
      '  border: 1px dashed var(--aios-tr-accent, #1558b0);',
      '  border-radius: 6px; padding: .3em .5em;',
      '}',
      '[' + MARK + '-style="plain"] .' + SPAN_CLASS + ' { }',
      '[' + MARK + '-style="tint"] .' + SPAN_CLASS + ' {',
      '  background: color-mix(in srgb, var(--aios-tr-accent, #1558b0) 12%, transparent);',
      '  border-radius: 6px; padding: .3em .5em;',
      '}',
      '[' + MARK + '-style="bar"] .' + SPAN_CLASS + ' {',
      '  border-left: 3px solid var(--aios-tr-accent, #1558b0);',
      '  padding-left: .6em;',
      '}'
    ].join('\n');
  }

  function ensureSheet() {
    if (sheet) return;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(styleText());
      document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
    } catch (e) {
      /* Very old engines only. Falling back to a <style> element is allowed to
         fail silently under a strict policy: the translation is still readable
         as plain text, which is better than not translating. */
      sheet = null;
      try {
        const el = document.createElement('style');
        el.textContent = styleText();
        document.head.appendChild(el);
      } catch (e2) { /* nothing more to try */ }
    }
  }

  /**
   * A readable accent for this page, decided once from what the page is
   * actually painted with. A single colour cannot serve both a white article
   * and a black one: the blue that reads on paper disappears on a dark page.
   */
  function pickAccent() {
    let bg = '';
    try {
      bg = getComputedStyle(document.body).backgroundColor || '';
      if (!bg || bg === 'transparent' || /rgba\(0, 0, 0, 0\)/.test(bg)) {
        bg = getComputedStyle(document.documentElement).backgroundColor || '';
      }
    } catch (e) { /* fall through to the light default */ }
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg || '');
    let light = true;
    if (m) {
      const lum = (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
      light = lum >= 0.5;
    }
    return light ? '#1558b0' : '#7fb6ff';
  }

  function applyStyle(style) {
    state.style = style || 'underline';
    document.documentElement.setAttribute(MARK + '-style', state.style);
  }

  /* ---------------------------------------------------------------- HUD */

  /* The progress strip, bottom right, in a closed shadow root so the page can
     neither read it nor style it. `all: initial` on the host keeps the page's
     own rules off it. It is rebuilt if the page removes it. */
  function ensureHud() {
    if (hud && hud.isConnected) return;
    hud = document.createElement('div');
    hud.id = HUD_ID;
    hud.setAttribute(MARK + '-ui', '1');
    hudShadow = hud.attachShadow({ mode: 'closed' });

    const css = new CSSStyleSheet();
    css.replaceSync([
      ':host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; }',
      '.box { display: flex; align-items: center; gap: 10px;',
      '  font: 12px/1.5 system-ui, "Noto Sans TC", sans-serif;',
      '  background: #0f1726; color: #dbe7f7;',
      '  border: 1px solid #2b3d5c; border-radius: 10px;',
      '  padding: 7px 11px; box-shadow: 0 10px 30px rgba(0,0,0,.45);',
      '  max-width: 60vw; }',
      '.txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.spin { width: 9px; height: 9px; border-radius: 50%; flex: none;',
      '  background: #4fd6ff; animation: p 1.1s ease-in-out infinite; }',
      '@keyframes p { 50% { opacity: .25; } }',
      '.spin.done { background: #58f2c8; animation: none; }',
      '.spin.err { background: #ffc14d; animation: none; }',
      'button { font: inherit; border: 1px solid #3a5680; background: #16223a;',
      '  color: #dbe7f7; border-radius: 6px; padding: 2px 9px; cursor: pointer; flex: none; }',
      'button:hover { border-color: #4fd6ff; color: #fff; }',
      'button[hidden] { display: none; }',
      '.x { border: 0; background: none; color: #7f93b3; padding: 2px 4px; font-size: 14px; }'
    ].join('\n'));
    hudShadow.adoptedStyleSheets = [css];

    const box = document.createElement('div');
    box.className = 'box';
    const dot = document.createElement('span');
    dot.className = 'spin';
    hudText = document.createElement('span');
    hudText.className = 'txt';
    hudText.textContent = '準備翻譯…';
    hudRetry = document.createElement('button');
    hudRetry.type = 'button';
    hudRetry.textContent = '重試';
    hudRetry.hidden = true;
    hudRetry.addEventListener('click', function () { push('retry'); });
    hudClose = document.createElement('button');
    hudClose.type = 'button';
    hudClose.className = 'x';
    hudClose.textContent = '×';
    hudClose.title = '關閉翻譯';
    hudClose.addEventListener('click', function () { push('off'); });

    box.appendChild(dot);
    box.appendChild(hudText);
    box.appendChild(hudRetry);
    box.appendChild(hudClose);
    hudShadow.appendChild(box);
    hud.__dot = dot;
    (document.body || document.documentElement).appendChild(hud);
  }

  function setStatus(s) {
    lastStatus = Object.assign({}, lastStatus, s || {});
    if (!state.on) return removeHud();
    ensureHud();
    const st = lastStatus;
    hudText.textContent = st.text || (st.phase === 'done'
      ? '翻譯完成　' + st.done + ' 段' + (st.failed ? '，' + st.failed + ' 段失敗' : '')
      : '翻譯中　' + st.done + ' / ' + st.total + (st.failed ? '　' + st.failed + ' 失敗' : ''));
    hudRetry.hidden = !st.failed;
    const dot = hud.__dot;
    dot.className = 'spin' + (st.failed ? ' err' : (st.phase === 'done' ? ' done' : ''));
    return true;
  }

  function removeHud() {
    if (hud && hud.isConnected) hud.remove();
    hud = null;
    return true;
  }

  /* ------------------------------------------------------- what to translate */

  function isSkippable(el) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.id === HUD_ID || el.hasAttribute(MARK + '-ui')) return true;
    if (el.classList && el.classList.contains(SPAN_CLASS)) return true;
    if (el.isContentEditable) return true;
    if (el.closest('pre, code, textarea, [contenteditable="true"], [' + MARK + '-ui]')) return true;
    if (el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return true;
    if (state.skipSelector) {
      try { if (el.closest(state.skipSelector)) return true; } catch (e) { /* a bad selector skips nothing */ }
    }
    return false;
  }

  /** Drawn on screen at all -- display:none, visibility:hidden and zero boxes. */
  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    return true;
  }

  /** Letters of any script, so a heading of digits and punctuation is skipped. */
  function hasLetters(s) {
    return /[a-zA-ZÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ぀-ヿ㐀-鿿가-힯]/.test(s);
  }

  /**
   * Is this already the language being asked for? Counting scripts rather than
   * guessing a language: the question is only ever "would translating this be
   * a no-op", and for that a ratio is enough and costs nothing.
   */
  function alreadyTarget(text, target) {
    const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length;
    const kana = (text.match(/[぀-ヿ]/g) || []).length;
    const hangul = (text.match(/[가-힯]/g) || []).length;
    const latin = (text.match(/[a-zA-Z]/g) || []).length;
    /* Letters this counter does not recognise -- Cyrillic, Greek, Arabic,
       Hebrew, accented Latin. They are counted, not identified, and that is
       enough: their presence proves the text is not already Chinese, Japanese,
       Korean or plain English. Without this, `letters` was zero for a Russian
       page and every paragraph on it was skipped as "already translated". */
    const other = (text.match(/[À-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ]/g) || []).length;
    const letters = cjk + kana + hangul + latin + other;
    if (!letters) return true;
    const t = String(target || '').toLowerCase();
    /* Chinese has no kana at all. Allowing a tenth of it let kanji-heavy
       Japanese pass as Traditional Chinese and go untranslated. */
    if (t.indexOf('zh') === 0) return (cjk / letters) > 0.5 && kana === 0;
    if (t.indexOf('ja') === 0) return (kana + cjk) / letters > 0.5 && kana > 0;
    if (t.indexOf('ko') === 0) return hangul / letters > 0.4;
    /* Latin script is not English. French, German and Spanish are all mostly
       a-z, so the ratio alone declared them already translated and skipped the
       page; an accent is the cheapest evidence to the contrary. */
    if (t.indexOf('en') === 0) return latin / letters > 0.9 && other === 0;
    return false;
  }

  /**
   * The text of one block, without any translation already inside it.
   *
   * Walks the direct children rather than cloning the element: a clone of
   * every candidate on a long article is a second copy of the document, and
   * this runs again on every poll. The inserted span is always a direct child
   * of the block it belongs to, so skipping those is enough.
   */
  /**
   * Does this child hold a block of its own? Then its text belongs to that
   * block and not to the element above it.
   *
   * The cheap test first: an element with no element children cannot contain
   * one, and that is the overwhelming majority of the inline markup inside a
   * paragraph. Only the rest pay for a querySelector.
   */
  function holdsBlock(el) {
    if (BLOCK_TAGS.has(el.tagName)) return true;
    if (!el.children || el.children.length === 0) return false;
    return !!el.querySelector(BLOCK_SEL);
  }

  function ownText(el) {
    let s = '';
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (n.nodeType === 3) { s += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      if (n.classList && n.classList.contains(SPAN_CLASS)) continue;
      if (n.id === HUD_ID || (n.hasAttribute && n.hasAttribute(MARK + '-ui'))) continue;
      if (TEXT_SKIP.has(n.tagName)) continue;
      /* A nested block's text is that block's, not this one's. This is what
         makes 「innermost only」 fall out rather than being a separate rule: a
         div that only wraps paragraphs has no text of its own and is never
         registered, while 「Parent<ul><li>child</li></ul>」 keeps 「Parent」 --
         which the old innermost check dropped on the floor, silently, on every
         nested list and outline. */
      if (holdsBlock(n)) continue;
      s += n.textContent;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * Where a translation goes: after the last thing this element says itself.
   *
   * Appending would be wrong for a block that has both its own text and a
   * nested block -- the translation of the first line would appear below the
   * nested list it introduces. Nothing is moved or rewritten; a new node is
   * put between two existing ones.
   */
  function placeSpan(el, span) {
    let after = null;
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (n.nodeType === 3) { if (n.nodeValue && n.nodeValue.trim()) after = n; continue; }
      if (n.nodeType !== 1) continue;
      if (n.classList && n.classList.contains(SPAN_CLASS)) continue;
      if (holdsBlock(n) || TEXT_SKIP.has(n.tagName)) continue;
      after = n;
    }
    if (after && after.nextSibling) el.insertBefore(span, after.nextSibling);
    else el.appendChild(span);
  }

  /**
   * Every block worth translating under `root`, innermost only.
   *
   * Two passes rather than one clever one: collect candidates, then drop any
   * that contains another candidate. A single pass that stopped descending at
   * the first block missed sites that wrap each paragraph in a div, and one
   * that took every block translated the wrapper and its children both -- the
   * same sentence twice, billed twice.
   */
  function candidates(root) {
    const scope = root && root.nodeType === 1 ? root : document.body;
    if (!scope) return [];
    const found = [];
    const walk = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (el) {
        if (SKIP_TAGS.has(el.tagName) || el.id === HUD_ID || el.hasAttribute(MARK + '-ui')) {
          return NodeFilter.FILTER_REJECT;      // and nothing inside it either
        }
        return BLOCK_TAGS.has(el.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    if (scope.nodeType === 1 && BLOCK_TAGS.has(scope.tagName)) found.push(scope);
    let n;
    while ((n = walk.nextNode())) found.push(n);
    /* No separate innermost rule: register() takes whatever has text of its
       own, and ownText() already refuses to count a nested block's words as
       this element's. A wrapper therefore has nothing to say and is dropped,
       and a block that both introduces a list and contains it keeps its own
       line. */
    const out = [];
    for (let i = 0; i < found.length; i++) {
      if (!isSkippable(found[i])) out.push(found[i]);
    }
    return out;
  }

  /** Register a block, returning its record or null when it is not worth one. */
  function register(el) {
    if (seen.has(el)) {
      const prev = byId.get(seen.get(el));
      if (prev) return prev;
      /* Known once, released since. A virtual list reuses its elements, so an
         element that comes back is a paragraph to translate again rather than
         one to ignore for ever. */
      seen.delete(el);
    }
    if (isSkippable(el)) return null;
    const text = ownText(el);
    if (!text || text.length < state.minChars) return null;
    if (text.length > state.maxChars) return null;
    if (!hasLetters(text)) return null;
    if (alreadyTarget(text, state.target)) return null;
    const id = 'g' + (++state.seq);
    const rec = { id: id, el: el, text: text, status: 'new' };
    byId.set(id, rec);
    seen.set(el, id);
    if (io) io.observe(el);
    return rec;
  }

  function scan(root) {
    let added = 0;
    for (const el of candidates(root)) {
      if (register(el)) added++;
    }
    return added;
  }

  /* ------------------------------------------------------------ observers */

  /* A generous margin so a paragraph is translated just before it is read, not
     as it lands. The observer and the measurement below both use it, or the two
     would disagree about what "on screen" means and a paragraph would be
     translated or not depending on which of them noticed it first. */
  const VIEW_MARGIN = 400;

  /* The last viewport this page was measured at, and what to assume when it
     has never had one. Both exist because a page is not always being shown,
     and a page that is not being shown is not told how big it is.

     Measured, on this machine: a view that was placed once and then detached
     -- the window went behind another one, a menu opened, another tab came to
     the front -- keeps its last size, so the live reading is still the truth.
     A view that was NEVER placed is told nothing: innerWidth, clientWidth,
     outerWidth, visualViewport and even screen all read 0, and the document
     lays itself out at zero width. That is the state of every page opened
     while its window was off screen, which on Windows includes the whole
     application from the moment the session locks.

     What this used to do with that was return false: no viewport, so nothing
     is on screen, so nothing is translated. It is defensible and it is
     useless -- a translation somebody had pressed the button for sat at
     「翻譯 0 / 0 段」 for as long as the window stayed away, and the strip
     said 「等你捲到」 about a page that could not be scrolled because it was
     not on screen. So: the last real viewport if there was one, and otherwise
     a nominal window. Guessing the window is the conservative half of the
     job; the geometry is still measured, so what gets translated is the top
     of the document rather than all of it, and the moment the page is shown
     the real numbers take over. */
  let lastView = null;
  const NOMINAL_VIEW = { w: 1280, h: 800 };

  function viewport() {
    const w = window.innerWidth || document.documentElement.clientWidth || 0;
    const h = window.innerHeight || document.documentElement.clientHeight || 0;
    if (w > 0 && h > 0) {
      if (!lastView || lastView.w !== w || lastView.h !== h) lastView = { w: w, h: h };
      return lastView;
    }
    return lastView || NOMINAL_VIEW;
  }

  /**
   * Is this element within the viewport right now, measured rather than waited
   * for?
   *
   * The IntersectionObserver is the fast path: it says the moment something
   * scrolls in. It is not a reliable path. Its callbacks are delivered as part
   * of the rendering steps, and a tab's document is very often not being
   * rendered -- more often than is comfortable. Chromium's native window
   * occlusion can mark it hidden while the view is attached, sized, focused and
   * front-most; and AI-OS detaches views deliberately on minimise, on any modal
   * (browser.suspend), and whenever the browser window is covered, each of which
   * does it too. Measured on a real run: with `document.visibilityState ===
   * 'hidden'` the observer never fired once -- not late, never, and not even the
   * initial callback that observe() would normally deliver -- so every paragraph
   * stayed unseen, `total` was 0, and the session reported 「翻譯完成」 on a page
   * where nothing had been translated. Saying a job is finished when it never
   * started is the worst of the available failures.
   *
   * This is also why the geometric check is the mechanism and not a backstop:
   * the `push('visible')` nudge below never arrives in a tab, so waking on a
   * scroll happens on the next poll, through here.
   *
   * Layout is not suspended with rendering, so a rectangle is still the truth:
   * on that same run getBoundingClientRect put the first paragraph 97px down a
   * 482px viewport, correctly, while the observer was silent.
   *
   * What the rectangle is compared against is the other half -- see viewport()
   * above for the page that cannot say how big it is.
   */
  function onScreenNow(el) {
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r) return false;
    if (!r.width && !r.height) return false;
    const v = viewport();
    return r.bottom > -VIEW_MARGIN && r.top < v.h + VIEW_MARGIN && r.right > 0 && r.left < v.w;
  }

  function startObservers() {
    if (state.viewportOnly && !io) {
      io = new IntersectionObserver(function (entries) {
        let woke = 0;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = seen.get(e.target);
          const rec = id && byId.get(id);
          if (rec && rec.status === 'new') { rec.seenOnScreen = true; woke++; }
        }
        if (woke) push('visible', { count: woke });
      }, { rootMargin: VIEW_MARGIN + 'px 0px', threshold: 0.01 });
      byId.forEach(function (rec) { if (rec.el.isConnected) io.observe(rec.el); });
    }
    if (!mo) {
      mo = new MutationObserver(function (records) {
        let touched = false;
        for (const r of records) {
          if (r.type !== 'childList') continue;
          for (const node of r.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.id === HUD_ID || (node.hasAttribute && node.hasAttribute(MARK + '-ui'))) continue;
            if (node.classList && node.classList.contains(SPAN_CLASS)) continue;
            touched = true;
          }
        }
        if (!touched) return;
        /* Debounced: an infinite-scroll page appends in bursts, and scanning
           per mutation walked the whole document dozens of times a second. The
           deadline is the other half of it -- a page that mutates continuously
           (a ticker, a live feed, an animation that rewrites a node) would
           otherwise push the rescan back for ever and never translate
           anything. */
        if (!rescanSince) rescanSince = Date.now();
        if (Date.now() - rescanSince > 2000) {
          if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null; }
    rescanSince = 0;
          rescanSince = 0;
          const now = scan(document.body);
          if (now) push('added', { count: now });
          return;
        }
        if (rescanTimer) clearTimeout(rescanTimer);
        rescanTimer = setTimeout(function () {
          rescanTimer = null;
          rescanSince = 0;
          const added = scan(document.body);
          if (added) push('added', { count: added });
        }, 350);
      });
      mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }
  }

  function stopObservers() {
    if (io) { io.disconnect(); io = null; }
    if (mo) { mo.disconnect(); mo = null; }
    if (rescanTimer) { clearTimeout(rescanTimer); rescanTimer = null; }
  }

  /* ------------------------------------------------------------- the API */

  /** Turn the agent on for this page. Idempotent. */
  function start(opts) {
    Object.assign(state, {
      on: true,
      run: (opts && opts.run) || state.run || 'r1',
      target: (opts && opts.target) || state.target,
      viewportOnly: opts && opts.viewportOnly !== undefined ? !!opts.viewportOnly : state.viewportOnly,
      skipSelector: (opts && opts.skipSelector) || '',
      style: (opts && opts.style) || state.style
    });
    ensureSheet();
    document.documentElement.style.setProperty('--aios-tr-accent',
      (opts && opts.accent) || pickAccent());
    applyStyle(state.style);
    state.visible = true;
    /* Anything left over from a previous run on this same document goes back
       in the queue. Without this, stopping and starting again left every
       failed paragraph stranded: collect() only ever hands over 'new', so the
       failures were invisible to the new session and could not be retried. */
    byId.forEach(function (rec) {
      if (rec.status === 'failed' || rec.status === 'pending') rec.status = 'new';
    });
    startObservers();
    const n = scan(document.body);
    setStatus({ phase: 'working', text: '正在挑出要翻譯的段落…' });
    return { ok: true, found: n, counts: counts() };
  }

  /**
   * Segments the main process should translate now, and everything that
   * happened since the last call. Flips what it hands over to 'pending', so a
   * segment is never given out twice.
   */
  function collect(limit) {
    const out = [];
    const max = limit > 0 ? limit : 400;
    byId.forEach(function (rec) {
      /* Connectedness first, and whatever the status. A record handed out as
         'pending' whose element was then re-rendered away used to be skipped
         by the status guard above and stranded: nothing ever moved it out of
         'pending', so counts reported work in progress for ever and the strip
         never said 翻譯完成 on a page where everything visible was done. */
      if (!rec.el.isConnected) { drop(rec); return; }
      if (rec.status !== 'new') return;
      /* Not eligible *yet* is not the same as not eligible: a paragraph behind
         a closed accordion, or below the fold with 只翻譯捲動到的區域 on, is
         left in 'new' and picked up when it appears. It is also left out of
         the total until then -- counting it would show 「6 / 8」 on a page
         that is finished, and the two that never arrive would look like a
         failure nobody can retry. */
      /* The observer may simply never have run -- see onScreenNow. So this
         asks the geometry directly rather than waiting to be told, and the
         observer stays what it is good at: noticing the moment something
         scrolls in, without a poll having to come round first. */
      if (state.viewportOnly && !rec.seenOnScreen) {
        if (!onScreenNow(rec.el)) return;
        rec.seenOnScreen = true;
      }
      /* Measured once. isVisible calls getClientRects, which forces a
         synchronous layout, and this loop runs over every record on every poll
         for as long as the tab is open -- on a finished page that is a layout
         per paragraph per second, for nothing. */
      if (!rec.eligible && !isVisible(rec.el)) return;
      rec.eligible = true;
      if (out.length >= max) return;
      /* Re-read: a framework may have replaced the text since it was found,
         and translating what is no longer there is worse than a round trip. */
      const now = ownText(rec.el);
      if (!now || !hasLetters(now) || alreadyTarget(now, state.target)) { rec.status = 'skip'; return; }
      rec.text = now;
      rec.status = 'pending';
      out.push({ id: rec.id, text: now });
    });
    const drained = events.splice(0, events.length);
    return { run: state.run, segments: out, events: drained, counts: counts() };
  }

  /**
   * What the strip counts. `total` is what this page means to translate --
   * everything already handled plus everything eligible and waiting -- so it
   * reaches 100% on a finished page. `known` is every block that was found,
   * which is bigger whenever part of the page has not been reached yet.
   */
  /**
   * Let a record go. Its element has left the document, so nothing will ever be
   * done with it -- and on an infinite-scroll page the ones already scrolled
   * past are the majority. Left in place they held detached nodes alive, kept
   * an IntersectionObserver target each, and were walked again on every poll.
   */
  function drop(rec) {
    byId.delete(rec.id);
    if (io) { try { io.unobserve(rec.el); } catch (e) { /* already gone */ } }
    gone++;
  }

  /** Just the events, for a caller that is busy and wants to stay responsive. */
  function drain() {
    return { run: state.run, events: events.splice(0, events.length), counts: counts() };
  }

  function counts() {
    let done = 0, failed = 0, pending = 0, waiting = 0, skipped = 0;
    byId.forEach(function (r) {
      if (r.status === 'done') done++;
      else if (r.status === 'failed') failed++;
      else if (r.status === 'pending') pending++;
      else if (r.status === 'skip') skipped++;
      else if (r.status === 'new' && r.eligible) waiting++;
    });
    return {
      total: done + failed + pending + waiting,
      done: done, failed: failed, pending: pending, waiting: waiting,
      skipped: skipped, known: byId.size, gone: gone
    };
  }

  /**
   * Put translations on the page. textContent only -- never markup.
   *
   * `run` is checked first: a batch collected from a document this tab has
   * since navigated away from must not be written into the document that
   * replaced it. The ids would happily match -- a fresh world numbers from g1
   * again -- so the answer would land on an unrelated paragraph of a different
   * site.
   */
  function apply(items, run) {
    if (run && run !== state.run) return { applied: 0, stale: true, counts: counts() };
    let applied = 0;
    for (const it of (items || [])) {
      const rec = byId.get(it.id);
      if (!rec) continue;
      /* Translated, but the paragraph is no longer on the page -- a framework
         re-rendered while the batch was in flight. Left 'pending' it would
         never be counted and the strip would sit one short of a total it could
         not reach. */
      if (!rec.el.isConnected) { drop(rec); continue; }
      const text = String(it.text == null ? '' : it.text);
      if (!text) { rec.status = 'skip'; continue; }
      let span = rec.span;
      if (!span || !span.isConnected) {
        span = document.createElement('span');
        span.className = SPAN_CLASS;
        span.setAttribute(MARK, rec.id);
        rec.span = span;
        placeSpan(rec.el, span);
      }
      span.textContent = text;
      span.lang = state.target;
      span.hidden = !state.visible;
      rec.status = 'done';
      applied++;
    }
    return { applied: applied, counts: counts() };
  }

  /** Mark segments that could not be translated, so the strip can offer 重試. */
  function fail(ids, run) {
    if (run && run !== state.run) return counts();
    for (const id of (ids || [])) {
      const rec = byId.get(id);
      if (rec && rec.status === 'pending') rec.status = 'failed';
    }
    return counts();
  }

  /** Everything that failed goes back in the queue. The 重試 button. */
  function retry() {
    let n = 0;
    byId.forEach(function (rec) {
      if (rec.status === 'failed') { rec.status = 'new'; rec.seenOnScreen = true; n++; }
    });
    return { requeued: n, counts: counts() };
  }

  /** Translation off is translation hidden: the original nodes never change. */
  function setVisible(on) {
    state.visible = !!on;
    byId.forEach(function (rec) {
      if (rec.span && rec.span.isConnected) rec.span.hidden = !state.visible;
    });
    return { visible: state.visible };
  }

  function setOptions(opts) {
    if (!opts) return state;
    if (opts.style) applyStyle(opts.style);
    if (opts.target) state.target = opts.target;
    if (opts.skipSelector !== undefined) state.skipSelector = opts.skipSelector || '';
    if (opts.accent) document.documentElement.style.setProperty('--aios-tr-accent', opts.accent);
    if (opts.viewportOnly !== undefined) {
      state.viewportOnly = !!opts.viewportOnly;
      if (!state.viewportOnly && io) { io.disconnect(); io = null; }
      if (state.viewportOnly) startObservers();
    }
    return { ok: true };
  }

  /** Stop entirely: observers off, strip gone, spans hidden but kept. */
  function stop() {
    state.on = false;
    stopObservers();
    setVisible(false);
    removeHud();
    return { ok: true, counts: counts() };
  }

  globalThis[NS] = {
    version: 3,
    start: start,
    stop: stop,
    collect: collect,
    drain: drain,
    apply: apply,
    fail: fail,
    retry: retry,
    setVisible: setVisible,
    setOptions: setOptions,
    setStatus: setStatus,
    counts: counts,
    state: function () { return Object.assign({}, state, { known: byId.size }); }
  };
  return 'installed';
}
/* eslint-enable */

/* Handed to executeJavaScriptInIsolatedWorld as an expression, so the value of
   the last statement is what comes back to the main process. */
const SOURCE = '(' + pageAgent.toString() + ')()';

module.exports = { SOURCE, pageAgent };
