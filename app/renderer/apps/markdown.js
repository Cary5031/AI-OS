'use strict';

/* ===========================================================================
   AI-OS // Markdown viewer
   ---------------------------------------------------------------------------
   Reading, not editing. The document editor already opens .md by converting it
   into its own block model, which is the right thing for editing and the wrong
   thing for reading: the conversion keeps what that model can represent and
   quietly drops the rest -- code fences, nested lists, task boxes, inline code,
   links. This shows the file as written.

   Two properties shape the implementation.

   NOTHING IS PARSED AS HTML. Every node is built with createElement and
   createTextNode. A Markdown file is untrusted content -- dragged in, fetched,
   or written by the model -- and it may contain raw HTML. Assigning innerHTML
   anywhere here would hand that file the ability to place nodes inside a
   privileged document, so raw HTML is shown as the text it is.

   LINKS DO NOT NAVIGATE. This document is the machine's own shell; letting a
   link in a file move it would be the end of the sandbox. An external link is
   an offer to open the browser, and a relative link resolves inside the sandbox
   and opens with whichever application claims it.

   The parser is deliberately separate from office.js's markdownToBlocks. That
   one exists to fill the editor's block model and is bounded by it; this one is
   bounded by what a reader should see. Sharing them would mean one of the two
   getting the wrong answer.
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

  /* ======================================================== block parsing ===

     Line-based, producing a flat list of block descriptors. Lists carry their
     own nesting because indentation is the only thing that expresses it, and
     resolving that during parsing is simpler than trying to recover it later.
     ========================================================================= */

  var RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var FENCE = /^ {0,3}(```+|~~~+)\s*([^`]*)$/;
  var ATX = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  var UL = /^(\s*)([-*+])\s+(.*)$/;
  var OL = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
  var QUOTE = /^ {0,3}>\s?(.*)$/;
  var TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function parse(src) {
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var blocks = [];
    var para = [];
    var i = 0;

    function flushPara() {
      if (!para.length) return;
      blocks.push({ type: 'para', text: para.join('\n') });
      para = [];
    }

    while (i < lines.length) {
      var line = lines[i];

      /* fenced code -- taken first, because everything inside it is literal */
      var fence = line.match(FENCE);
      if (fence) {
        flushPara();
        var marker = fence[1][0];
        var need = fence[1].length;
        var lang = fence[2].trim();
        var body = [];
        var closed = false;
        i++;
        while (i < lines.length) {
          var close = lines[i].match(/^ {0,3}(```+|~~~+)\s*$/);
          if (close && close[1][0] === marker && close[1].length >= need) { i++; closed = true; break; }
          body.push(lines[i]);
          i++;
        }
        // A blank line before a real closing fence is content. One at the end of
        // an unterminated fence is just the file's final newline, so it goes.
        if (!closed) while (body.length && !body[body.length - 1].trim()) body.pop();
        blocks.push({ type: 'code', lang: lang, text: body.join('\n') });
        continue;
      }

      if (!line.trim()) { flushPara(); i++; continue; }

      /* Setext heading, checked before the thematic break: "---" is a rule on
         its own but an h2 underline directly under a one-line paragraph, and
         RULE matches it either way. Testing the rule first turned every setext
         h2 into a paragraph followed by a horizontal line. */
      if (para.length === 1 && /^ {0,3}(=+|-+)\s*$/.test(line)) {
        var lvl = line.trim()[0] === '=' ? 1 : 2;
        blocks.push({ type: 'heading', level: lvl, text: para[0] });
        para = [];
        i++;
        continue;
      }

      if (RULE.test(line)) { flushPara(); blocks.push({ type: 'rule' }); i++; continue; }

      var atx = line.match(ATX);
      if (atx) {
        flushPara();
        blocks.push({ type: 'heading', level: atx[1].length, text: atx[2] });
        i++;
        continue;
      }

      if (QUOTE.test(line)) {
        flushPara();
        var quoted = [];
        while (i < lines.length) {
          var q = lines[i].match(QUOTE);
          if (q) { quoted.push(q[1]); i++; continue; }
          // A blank line ends the quote; a plain line is a lazy continuation.
          if (!lines[i].trim()) break;
          if (ATX.test(lines[i]) || FENCE.test(lines[i]) || UL.test(lines[i]) || OL.test(lines[i])) break;
          quoted.push(lines[i]);
          i++;
        }
        blocks.push({ type: 'quote', blocks: parse(quoted.join('\n')) });
        continue;
      }

      if (UL.test(line) || OL.test(line)) {
        flushPara();
        var items = [];
        var listOrdered = !UL.test(line);
        while (i < lines.length) {
          var m = lines[i].match(UL) || lines[i].match(OL);
          if (m) {
            var ordered = !UL.test(lines[i]);
            // Switching marker kind at the top level starts a new list.
            if (items.length && ordered !== listOrdered &&
                m[1].replace(/\t/g, '    ').length === items[0].indent) {
              break;
            }
            var indent = m[1].replace(/\t/g, '    ').length;
            var text = m[3];
            var task = null;
            var box = text.match(/^\[([ xX])\]\s+(.*)$/);
            if (box) { task = box[1].toLowerCase() === 'x'; text = box[2]; }
            items.push({ indent: indent, ordered: ordered, task: task, lines: [text] });
            i++;
            continue;
          }
          // A continuation line belongs to the item above it.
          if (lines[i].trim() && items.length && /^\s+\S/.test(lines[i])) {
            items[items.length - 1].lines.push(lines[i].trim());
            i++;
            continue;
          }
          // A loose list: a blank line between items of the *same* kind. The
          // kind has to match, or a bullet list followed by a numbered one gets
          // swallowed into the first and renders with the wrong marker.
          if (!lines[i].trim() && i + 1 < lines.length) {
            var nextUl = UL.test(lines[i + 1]);
            var nextOl = !nextUl && OL.test(lines[i + 1]);
            if ((nextUl || nextOl) && nextOl === !!items[0].ordered) { i++; continue; }
          }
          break;
        }
        blocks.push({ type: 'list', items: items });
        continue;
      }

      /* table: a header row followed by a separator row */
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        flushPara();
        var cut = function (row) {
          return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
        };
        var rows = [cut(line)];
        var align = cut(lines[i + 1]).map(function (c) {
          if (/^:-+:$/.test(c)) return 'center';
          if (/-+:$/.test(c)) return 'right';
          return 'left';
        });
        i += 2;
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
          rows.push(cut(lines[i]));
          i++;
        }
        blocks.push({ type: 'table', rows: rows, align: align });
        continue;
      }

      /* indented code, but only where a paragraph is not already open */
      if (!para.length && /^(\t| {4})/.test(line)) {
        flushPara();
        var pre = [];
        while (i < lines.length && (/^(\t| {4})/.test(lines[i]) || !lines[i].trim())) {
          pre.push(lines[i].replace(/^(\t| {4})/, ''));
          i++;
        }
        while (pre.length && !pre[pre.length - 1].trim()) pre.pop();
        blocks.push({ type: 'code', lang: '', text: pre.join('\n') });
        continue;
      }

      para.push(line);
      i++;
    }
    flushPara();
    return blocks;
  }

  /* ======================================================= inline parsing === */

  /**
   * Split inline Markdown into typed spans. Order matters: code spans are taken
   * before anything else, because their contents are literal and must not be
   * re-read as emphasis or links.
   */
  function inline(text) {
    var out = [];
    var s = String(text == null ? '' : text);
    var i = 0;
    var buf = '';

    function push() {
      if (buf) { out.push({ t: 'text', v: buf }); buf = ''; }
    }

    while (i < s.length) {
      var c = s[i];

      if (c === '\\' && i + 1 < s.length && /[\\`*_{}\[\]()#+\-.!~>|]/.test(s[i + 1])) {
        buf += s[i + 1];
        i += 2;
        continue;
      }

      if (c === '`') {
        var run = /^`+/.exec(s.slice(i))[0];
        var close = s.indexOf(run, i + run.length);
        if (close > 0) {
          push();
          out.push({ t: 'code', v: s.slice(i + run.length, close).replace(/^ | $/g, '') });
          i = close + run.length;
          continue;
        }
      }

      // image before link: the syntax differs only by the leading '!'
      if (c === '!' && s[i + 1] === '[') {
        var img = matchLink(s, i + 1);
        if (img) {
          push();
          out.push({ t: 'image', alt: img.label, href: img.href, title: img.title });
          i = img.end;
          continue;
        }
      }

      if (c === '[') {
        var lk = matchLink(s, i);
        if (lk) {
          push();
          out.push({ t: 'link', kids: inline(lk.label), href: lk.href, title: lk.title });
          i = lk.end;
          continue;
        }
      }

      if (c === '<') {
        var auto = /^<((?:https?|mailto):[^\s>]+)>/.exec(s.slice(i));
        if (auto) {
          push();
          out.push({ t: 'link', kids: [{ t: 'text', v: auto[1] }], href: auto[1] });
          i += auto[0].length;
          continue;
        }
      }

      if (c === '~' && s[i + 1] === '~') {
        var strike = s.indexOf('~~', i + 2);
        if (strike > 0) {
          push();
          out.push({ t: 'del', kids: inline(s.slice(i + 2, strike)) });
          i = strike + 2;
          continue;
        }
      }

      if (c === '*' || c === '_') {
        var double = s[i + 1] === c;
        var mark = double ? c + c : c;
        var from = i + mark.length;
        var at = findClose(s, mark, from);
        if (at > 0) {
          push();
          out.push({ t: double ? 'strong' : 'em', kids: inline(s.slice(from, at)) });
          i = at + mark.length;
          continue;
        }
      }

      // two trailing spaces before a newline is a hard break
      if (c === ' ' && /^ {2,}\n/.test(s.slice(i))) {
        push();
        out.push({ t: 'break' });
        i += /^ +/.exec(s.slice(i))[0].length + 1;
        continue;
      }

      buf += c;
      i++;
    }
    push();
    return out;
  }

  /** Find the closing run of `mark`, skipping code spans and escapes. */
  function findClose(s, mark, from) {
    for (var k = from; k < s.length; k++) {
      if (s[k] === '\\') { k++; continue; }
      if (s[k] === '`') {
        var run = /^`+/.exec(s.slice(k))[0];
        var end = s.indexOf(run, k + run.length);
        if (end > 0) { k = end + run.length - 1; continue; }
      }
      if (s.startsWith(mark, k)) {
        // An empty span is not emphasis.
        return k > from ? k : -1;
      }
    }
    return -1;
  }

  /** [label](href "title") starting at `at`, which must be the '['. */
  function matchLink(s, at) {
    if (s[at] !== '[') return null;
    var depth = 0;
    var close = -1;
    for (var k = at; k < s.length; k++) {
      if (s[k] === '\\') { k++; continue; }
      if (s[k] === '[') depth++;
      else if (s[k] === ']') { depth--; if (!depth) { close = k; break; } }
    }
    if (close < 0 || s[close + 1] !== '(') return null;
    var end = -1;
    var paren = 0;
    for (var j = close + 1; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '(') paren++;
      else if (s[j] === ')') { paren--; if (!paren) { end = j; break; } }
    }
    if (end < 0) return null;
    var target = s.slice(close + 2, end).trim();
    var title = null;
    var tm = target.match(/^(\S*)\s+["'(](.*)["')]$/);
    if (tm) { target = tm[1]; title = tm[2]; }
    return { label: s.slice(at + 1, close), href: target, title: title, end: end + 1 };
  }

  /* ============================================================== rendering = */

  /* Only these schemes are ever put on an href, and even then the click is
     intercepted. Anything else -- javascript:, data:, file: -- is rendered as
     plain text so it cannot be followed at all. */
  var SAFE_SCHEME = /^(https?|mailto):/i;

  /**
   * A relative or absolute path inside the sandbox, as opposed to a URL. The
   * scheme test is what keeps `javascript:alert(1)` from being treated as a
   * filename, which would make it clickable.
   */
  function isSandboxPath(href) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;   // has a scheme
    return /^[./]/.test(href) || /^[\w\u4e00-\u9fff]/.test(href);
  }

  AIOS.apps.register({
    id: 'markdown',
    name: 'Markdown',
    contentApp: true,   // its chat panel gets the intent-enrichment guide
    purpose: '把 Markdown 排版成看得懂的樣子，附大綱與原始碼對照',
    icon: '\u2261',
    kind: 'MD',
    width: 900,
    height: 640,
    singleton: false,
    chatHint: '可以說「摘要這份文件」、「列出所有標題」、「這裡提到哪些指令」。',

    accepts: function (p) { return /\.(md|markdown|mdown|mkd)$/i.test(p || ''); },

    actions: {
      open: {
        args: '{path}', desc: '開啟一個 Markdown 檔',
        run: async function (a, ctx) { return { note: await ctx.api.open(a.path) }; }
      },
      outline: {
        args: '{}', desc: '列出文件的標題大綱',
        run: async function (_a, ctx) { return { note: ctx.api.outlineText() }; }
      },
      setMode: {
        args: '{mode:"rendered"|"source"}', desc: '切換排版檢視或原始碼',
        run: async function (a, ctx) { return { note: ctx.api.setMode(a.mode) }; }
      },
      exportHtml: {
        args: '{path}', desc: '匯出成一個自帶樣式的 HTML 檔',
        run: async function (a, ctx) { return { note: await ctx.api.exportHtml(a.path) }; }
      },
      exportPdf: {
        args: '{path}', desc: '排版成 PDF（A4，圖片一起帶進去）',
        run: async function (a, ctx) { return { note: await ctx.api.exportPdf(a.path) }; }
      }
    },

    mount: function (ctx) {
      ctx.body.classList.add('flush');

      var path = null;
      var source = '';
      var blocks = [];
      var mode = (ctx.state && ctx.state.mode) || 'rendered';
      var query = '';

      /* ---------------------------------------------------------- chrome */

      var bar = el('div', 'md-bar');
      var nameTag = el('span', 'md-name', '（沒有開啟檔案）');

      var btnRendered = el('button', 'fbtn', '\u25a4 排版');
      btnRendered.type = 'button';
      var btnSource = el('button', 'fbtn', '\u2039\u203a 原始碼');
      btnSource.type = 'button';
      var btnOutline = el('button', 'fbtn', '\u2263 大綱');
      btnOutline.type = 'button';
      btnOutline.setAttribute('aria-pressed', 'true');

      var search = el('input', 'md-search');
      search.type = 'search';
      search.placeholder = '搜尋…';
      search.setAttribute('aria-label', '搜尋文件');

      var btnEdit = el('button', 'fbtn', '編輯');
      btnEdit.type = 'button';
      btnEdit.title = '用文字編輯器開啟原始檔';
      var btnHtml = el('button', 'fbtn', '匯出 HTML');
      btnHtml.type = 'button';

      var btnPdf = el('button', 'fbtn', '匯出 PDF');
      btnPdf.type = 'button';
      btnPdf.title = '排版成 A4 的 PDF，圖片一起帶進去';
      [nameTag, btnRendered, btnSource, btnOutline, search, btnEdit, btnHtml, btnPdf]
        .forEach(function (n) { bar.appendChild(n); });
      ctx.body.appendChild(bar);

      var split = el('div', 'md-split');
      var side = el('nav', 'md-outline');
      side.setAttribute('aria-label', '大綱');
      var page = el('article', 'md-page');
      page.setAttribute('role', 'document');
      var srcPane = el('pre', 'md-source');
      srcPane.hidden = true;
      split.appendChild(side);
      split.appendChild(page);
      split.appendChild(srcPane);
      ctx.body.appendChild(split);

      var status = el('div', 'md-status', '沒有開啟檔案');
      ctx.body.appendChild(status);

      /* ------------------------------------------------------- rendering */

      var headings = [];

      function renderInline(host, spans) {
        spans.forEach(function (s) {
          if (s.t === 'text') {
            appendText(host, s.v);
          } else if (s.t === 'code') {
            host.appendChild(el('code', 'md-code-inline', s.v));
          } else if (s.t === 'strong') {
            var b = el('strong');
            renderInline(b, s.kids);
            host.appendChild(b);
          } else if (s.t === 'em') {
            var i2 = el('em');
            renderInline(i2, s.kids);
            host.appendChild(i2);
          } else if (s.t === 'del') {
            var d = el('del');
            renderInline(d, s.kids);
            host.appendChild(d);
          } else if (s.t === 'break') {
            host.appendChild(el('br'));
          } else if (s.t === 'link') {
            host.appendChild(linkNode(s));
          } else if (s.t === 'image') {
            host.appendChild(imageNode(s));
          }
        });
      }

      /** Text, with search hits wrapped. Always via text nodes. */
      function appendText(host, text) {
        if (!query) { host.appendChild(document.createTextNode(text)); return; }
        var lower = text.toLowerCase();
        var needle = query.toLowerCase();
        var at = 0;
        for (;;) {
          var hit = lower.indexOf(needle, at);
          if (hit < 0) { host.appendChild(document.createTextNode(text.slice(at))); return; }
          if (hit > at) host.appendChild(document.createTextNode(text.slice(at, hit)));
          host.appendChild(el('mark', 'md-hit', text.slice(hit, hit + query.length)));
          at = hit + query.length;
        }
      }

      /**
       * A link. Never navigable by itself: the href is only set for schemes we
       * would be willing to hand to the browser, and the click is handled here
       * regardless. A link inside a document must not be able to move the shell.
       */
      function linkNode(s) {
        var label = el('span', 'md-link-label');
        renderInline(label, s.kids);

        var href = String(s.href || '');
        var external = SAFE_SCHEME.test(href);
        var internal = !external && isSandboxPath(href) && !/^#/.test(href);
        var anchor = /^#/.test(href);

        if (!external && !internal && !anchor) {
          // Unsupported scheme. Shown, not linked.
          var plain = el('span', 'md-link-dead');
          plain.appendChild(label);
          plain.appendChild(el('span', 'md-link-note', '（不支援的連結：' + href.slice(0, 30) + '）'));
          return plain;
        }

        var a = el('a', 'md-link' + (external ? ' md-link-ext' : ''));
        a.href = external ? href : '#';
        a.appendChild(label);
        if (s.title) a.title = s.title;
        if (external) a.appendChild(el('span', 'md-link-ext-mark', '\u2197'));

        a.addEventListener('click', async function (e) {
          e.preventDefault();
          if (anchor) {
            var id = href.slice(1);
            var target = page.querySelector('[data-anchor="' + cssEscape(id) + '"]');
            if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
            return;
          }
          if (external) {
            var ok = await ctx.confirm({
              label: '開啟外部網址？',
              note: href,
              okLabel: '在瀏覽器開啟'
            });
            if (ok) AIOS.apps.launch('browser', href, { forceNew: true });
            return;
          }
          // Relative link: resolve against this file's directory and open with
          // whichever application claims it.
          var base = (path || '/').replace(/\/[^/]+$/, '');
          var resolved = AIOS.fs.resolve(joinPath(base, href.split('#')[0]));
          var entry = AIOS.fs.entry(resolved);
          if (!entry) { ctx.toast('沙箱裡找不到 ' + resolved, 't-warn'); return; }
          AIOS.apps.openPath(resolved);
        });
        return a;
      }

      /* Which formats can be shown, and how bytes become something an <img> can
         take, is AIOS.images' business -- shared with the deck rather than copied,
         because two tables of raster formats drift apart and the bug reads as
         "the picture works here but not there". */
      var IMG = AIOS.images;

      /**
       * An image.
       *
       * Three cases, and only one of them fetches anything:
       *
       *   data:      shown as given.
       *   sandbox    read through the bridge and turned into a data URL. It cannot
       *              be linked by URL instead: this document is file:// and the
       *              sandbox has no scheme of its own, so bytes are the only route.
       *              This is what makes a converted PDF's figures visible, since
       *              those are written to a sibling .assets folder.
       *   remote     described, never requested. connect-src and img-src both stop
       *              it, and a caption is more use than a broken-image icon.
       *
       * Sandbox images load lazily. A converted scan is one full-page image per
       * page, and reading eighty of them through IPC the moment the document opens
       * would stall the shell for no reason.
       */
      function imageNode(s) {
        var href = String(s.href || '');

        if (/^data:image\//i.test(href)) {
          var direct = el('img', 'md-img');
          direct.src = href;
          direct.alt = s.alt || '';
          return direct;
        }

        if (isSandboxPath(href)) {
          var bare = href.split('#')[0].split('?')[0];
          if (!IMG.mimeFor(bare)) return imageNote(s, href, '不支援這個圖片格式');

          var img = el('img', 'md-img md-img-wait');
          img.alt = s.alt || '';
          img.dataset.src = bare;
          watchImage(img);
          return img;
        }

        return imageNote(s, href, null);
      }

      function imageNote(s, href, why) {
        var box = el('span', 'md-img-note');
        box.appendChild(el('span', 'md-img-mark', '\u25a3'));
        box.appendChild(el('span', null, s.alt ? '圖：' + s.alt : '圖'));
        box.appendChild(el('span', 'md-img-src', (why ? why + '　' : '') + String(href).slice(0, 60)));
        return box;
      }

      var imgWatcher = null;

      function watchImage(img) {
        if (!imgWatcher) {
          imgWatcher = new window.IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
              if (!e.isIntersecting) return;
              imgWatcher.unobserve(e.target);
              loadSandboxImage(e.target);
            });
          }, { root: page, rootMargin: '400px 0px' });
        }
        imgWatcher.observe(img);
      }

      async function loadSandboxImage(img) {
        var rel = img.dataset.src;
        if (!rel) return;
        delete img.dataset.src;

        var base = (path || '/').replace(/\/[^/]+$/, '');
        var resolved = joinPath(base, rel);

        var r = await IMG.dataUrl(resolved);
        if (!r.ok) { swapForNote(img, resolved, r.error); return; }

        img.classList.remove('md-img-wait');
        img.src = r.url;
        img.title = resolved;
      }

      function swapForNote(img, href, why) {
        var box = imageNote({ alt: img.alt }, href, why);
        if (img.parentNode) img.parentNode.replaceChild(box, img);
      }

      function joinPath(base, rel) {
        if (rel.charAt(0) === '/') return rel;
        var parts = (base + '/' + rel).split('/');
        var out = [];
        parts.forEach(function (p) {
          if (!p || p === '.') return;
          if (p === '..') { out.pop(); return; }
          out.push(p);
        });
        return '/' + out.join('/');
      }

      function cssEscape(s) {
        return String(s).replace(/["\\]/g, '\\$&');
      }

      function slug(text) {
        return String(text).toLowerCase().trim()
          .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
          .replace(/\s+/g, '-');
      }

      function renderBlocks(host, list) {
        list.forEach(function (b) {
          if (b.type === 'heading') {
            var h = el('h' + Math.min(6, b.level), 'md-h md-h' + b.level);
            var id = slug(b.text);
            h.dataset.anchor = id;
            renderInline(h, inline(b.text));
            host.appendChild(h);
            if (host === page) headings.push({ level: b.level, text: b.text, node: h });
            return;
          }
          if (b.type === 'para') {
            var p = el('p', 'md-p');
            renderInline(p, inline(b.text));
            host.appendChild(p);
            return;
          }
          if (b.type === 'code') {
            var wrap = el('div', 'md-code');
            var head = el('div', 'md-code-head');
            head.appendChild(el('span', 'md-code-lang', b.lang || 'text'));
            var copy = el('button', 'fbtn', '複製');
            copy.type = 'button';
            copy.addEventListener('click', function () {
              A.clipboard.write(b.text);
              ctx.toast('已複製 ' + b.text.length + ' 字');
            });
            head.appendChild(copy);
            wrap.appendChild(head);
            var pre = el('pre', 'md-pre');
            var code = el('code');
            appendText(code, b.text);
            pre.appendChild(code);
            wrap.appendChild(pre);
            host.appendChild(wrap);
            return;
          }
          if (b.type === 'quote') {
            var q = el('blockquote', 'md-quote');
            renderBlocks(q, b.blocks);
            host.appendChild(q);
            return;
          }
          if (b.type === 'rule') {
            host.appendChild(el('hr', 'md-rule'));
            return;
          }
          if (b.type === 'list') {
            host.appendChild(listNode(b.items));
            return;
          }
          if (b.type === 'table') {
            var t = el('table', 'md-table');
            (b.rows || []).forEach(function (row, ri) {
              var tr = el('tr');
              row.forEach(function (cell, ci) {
                var td = el(ri === 0 ? 'th' : 'td');
                if (b.align && b.align[ci]) td.style.textAlign = b.align[ci];
                renderInline(td, inline(cell));
                tr.appendChild(td);
              });
              t.appendChild(tr);
            });
            host.appendChild(t);
            return;
          }
        });
      }

      /** Build a nested list from flat items, using indentation as the depth. */
      function listNode(items) {
        var root = el(items[0] && items[0].ordered ? 'ol' : 'ul', 'md-list');
        var stack = [{ indent: items[0] ? items[0].indent : 0, node: root }];

        items.forEach(function (it) {
          while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) stack.pop();

          if (it.indent > stack[stack.length - 1].indent) {
            var sub = el(it.ordered ? 'ol' : 'ul', 'md-list');
            var host = stack[stack.length - 1].node;
            var last = host.lastElementChild;
            (last || host).appendChild(sub);
            stack.push({ indent: it.indent, node: sub });
          }

          var li = el('li', 'md-li' + (it.task === null ? '' : ' md-task'));
          if (it.task !== null) {
            var box = el('input');
            box.type = 'checkbox';
            box.checked = !!it.task;
            // A viewer does not edit the file, so the box reflects and does not
            // accept input -- a checkbox that silently discards the click would
            // be worse than one that cannot be clicked.
            box.disabled = true;
            box.setAttribute('aria-label', it.task ? '已完成' : '未完成');
            li.appendChild(box);
          }
          var span = el('span', 'md-li-body');
          renderInline(span, inline(it.lines.join(' ')));
          li.appendChild(span);
          stack[stack.length - 1].node.appendChild(li);
        });
        return root;
      }

      function render() {
        headings = [];
        page.innerHTML = '';
        srcPane.textContent = '';

        if (!path) {
          page.appendChild(el('p', 'micro', '從檔案總管開一個 .md 檔，或用意圖列說「開啟 readme」。'));
          renderOutline();
          return;
        }

        renderBlocks(page, blocks);
        appendText(srcPane, source);
        renderOutline();
        renderStatus();
      }

      function renderOutline() {
        side.innerHTML = '';
        if (!headings.length) {
          side.appendChild(el('p', 'micro', '（沒有標題）'));
          return;
        }
        var min = headings.reduce(function (n, h) { return Math.min(n, h.level); }, 6);
        headings.forEach(function (h) {
          var b = el('button', 'md-onode md-onode-' + Math.min(3, h.level - min + 1), h.text);
          b.type = 'button';
          b.title = h.text;
          b.addEventListener('click', function () {
            setMode('rendered');
            h.node.scrollIntoView({ block: 'start', behavior: 'smooth' });
            h.node.classList.add('md-flash');
            window.setTimeout(function () { h.node.classList.remove('md-flash'); }, 900);
          });
          side.appendChild(b);
        });
      }

      function stats() {
        var words = (source.match(/[\u4e00-\u9fff]|[A-Za-z0-9'’-]+/g) || []).length;
        return {
          words: words,
          chars: source.length,
          lines: source ? source.split('\n').length : 0,
          headings: headings.length,
          // 200 words a minute is the usual rough figure for prose.
          minutes: Math.max(1, Math.round(words / 200))
        };
      }

      function renderStatus() {
        if (!path) { status.textContent = '沒有開啟檔案'; return; }
        var s = stats();
        status.textContent = [
          path,
          s.words + ' 詞',
          s.lines + ' 行',
          s.headings + ' 個標題',
          '約 ' + s.minutes + ' 分鐘讀完',
          query ? '搜尋「' + query + '」：' + page.querySelectorAll('.md-hit').length + ' 處' : null
        ].filter(Boolean).join('　·　');
      }

      /* ------------------------------------------------------- behaviour */

      async function open(vpath) {
        if (!vpath) return '沒有給路徑';
        var r = await A.fs.read(vpath);
        if (!r.ok) {
          ctx.toast('開啟失敗：' + r.error, 't-err');
          return '開啟失敗：' + r.error;
        }
        path = r.data.vpath;
        source = r.data.content;
        blocks = parse(source);
        nameTag.textContent = path.split('/').pop();
        ctx.setTitle('Markdown — ' + path.split('/').pop());
        if (r.data.untrusted) {
          ctx.toast(path + ' 來自不可信來源，內容只當資料看', 't-taint');
        }
        render();
        publish();
        ctx.save();
        var s = stats();
        return '已開啟 ' + path + '（' + s.words + ' 詞，' + s.headings + ' 個標題）';
      }

      function setMode(next) {
        mode = next === 'source' ? 'source' : 'rendered';
        btnRendered.setAttribute('aria-pressed', mode === 'rendered' ? 'true' : 'false');
        btnSource.setAttribute('aria-pressed', mode === 'source' ? 'true' : 'false');
        page.hidden = mode !== 'rendered';
        srcPane.hidden = mode !== 'source';
        ctx.save();
        return mode === 'source' ? '已切到原始碼' : '已切到排版檢視';
      }

      function outlineText() {
        if (!headings.length) return '這份文件沒有標題。';
        var min = headings.reduce(function (n, h) { return Math.min(n, h.level); }, 6);
        return headings.map(function (h) {
          return '  '.repeat(h.level - min) + '- ' + h.text;
        }).join('\n');
      }

      async function exportHtml(target) {
        if (!path) return '還沒開啟檔案';
        var to = target || await AIOS.saveAsPath({
          host: ctx.win.el,
          current: path.replace(/\.(md|markdown|mdown|mkd)$/i, '.html'),
          defaultName: path.split('/').pop().replace(/\.[^.]*$/, '') + '.html',
          note: '匯出成一個自帶樣式的 HTML 檔，任何瀏覽器都能開。'
        });
        if (!to) return '取消';

        // Serialised from the DOM that is already on screen, so the file matches
        // what was rendered rather than being a second implementation.
        var body = page.cloneNode(true);
        body.querySelectorAll('button').forEach(function (b) { b.remove(); });
        body.querySelectorAll('mark.md-hit').forEach(function (m) {
          m.replaceWith(document.createTextNode(m.textContent));
        });

        var html = [
          '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">',
          '<title>' + escapeHtml(path.split('/').pop()) + '</title><style>',
          'body{margin:0;background:#0a0e17;color:#d9e6f7;font-family:"微軟正黑體","Noto Sans TC",system-ui,sans-serif;line-height:1.8}',
          'article{max-width:820px;margin:0 auto;padding:48px 24px 96px}',
          'h1,h2,h3,h4,h5,h6{color:#fff;line-height:1.35;margin:1.6em 0 .6em}',
          'h1{font-size:2em;border-bottom:1px solid #223;padding-bottom:.3em}',
          'h2{font-size:1.55em;border-bottom:1px solid #1a2333;padding-bottom:.25em}',
          'a{color:#4fd6ff}code{font-family:Consolas,monospace;font-size:.92em}',
          '.md-code-inline{background:#161d2b;padding:1px 5px;border-radius:4px;color:#9fe6ff}',
          'pre{background:#0d1219;border:1px solid #1c2636;border-radius:8px;padding:12px 14px;overflow-x:auto}',
          'blockquote{margin:1em 0;padding-left:14px;border-left:3px solid #2a3a52;color:#8ea3c0}',
          'table{border-collapse:collapse;width:100%;margin:1em 0}',
          'th,td{border:1px solid #1c2636;padding:6px 10px;text-align:left}',
          'th{background:#131a26;color:#9fb3cc}',
          'hr{border:0;border-top:1px solid #1c2636;margin:2em 0}',
          'li{margin:.35em 0}.md-img-note{color:#566b8a;font-size:.9em}',
          '.md-code-head{display:none}',
          '</style></head><body>',
          body.outerHTML,
          '</body></html>'
        ].join('\n');

        var w = await A.fs.write(to, html);
        if (!w.ok) { ctx.toast('寫入失敗：' + w.error, 't-err'); return '寫入失敗：' + w.error; }
        await AIOS.afterFsChange();
        ctx.toast('已匯出 ' + to, 't-ok');
        return '已匯出 ' + to;
      }

      /**
       * Export to PDF.
       *
       * Same source as the HTML export -- the rendered DOM -- but through the
       * shared print stylesheet, which is light. Images are already inline data
       * URLs by the time they are on screen (see imageNode), so a converted PDF's
       * figures travel into the output with nothing further to resolve.
       */
      async function exportPdf(target) {
        if (!path) return '還沒開啟檔案';
        var to = target || await AIOS.saveAsPath({
          host: ctx.win.el,
          current: path.replace(/\.(md|markdown|mdown|mkd)$/i, '.pdf'),
          defaultName: path.split('/').pop().replace(/\.[^.]*$/, '') + '.pdf',
          note: '排版成 A4 的 PDF。圖片會一起帶進去，文字可選取。'
        });
        if (!to) return '取消';

        var body = page.cloneNode(true);
        body.querySelectorAll('button').forEach(function (b) { b.remove(); });
        body.querySelectorAll('mark.md-hit').forEach(function (m) {
          m.replaceWith(document.createTextNode(m.textContent));
        });
        // A placeholder that never loaded would print as an empty dashed strip.
        body.querySelectorAll('img.md-img-wait').forEach(function (i) { i.remove(); });

        var out;
        try {
          out = await AIOS.printing.toPdf(to, {
            title: path.split('/').pop(),
            bodyHtml: body.outerHTML,
            css: [
              'article { max-width: none; padding: 0; }',
              'h1 { border-bottom: 1px solid #c7d2de; padding-bottom: .3em; }',
              'h2 { border-bottom: 1px solid #dde4ec; padding-bottom: .25em; }',
              '.md-code-inline { background: #f4f6f9; padding: 1px 5px; border-radius: 4px; }',
              '.md-code-head { display: none; }',
              '.md-img-note, .md-img-src { color: #6b7c8f; font-size: .9em; }',
              '.md-task { list-style: none; }',
              '.md-link-ext-mark { display: none; }'
            ].join('\n')
          });
        } catch (e) {
          ctx.toast('匯出失敗：' + e.message, 't-err');
          return '匯出失敗：' + e.message;
        }
        await AIOS.afterFsChange();
        ctx.toast('已匯出 ' + out.vpath + '（' + Math.round(out.bytes / 1024) + ' KB）', 't-ok');
        if (out.warning) ctx.toast(out.warning, 't-warn');
        return '已匯出 ' + out.vpath + (out.warning ? '。' + out.warning : '');
      }

      function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      function publish() {
        if (!path) { ctx.publish(null); return; }
        var s = stats();
        ctx.publish([
          'Markdown：' + path,
          s.words + ' 詞、' + s.headings + ' 個標題',
          '',
          '大綱：',
          outlineText(),
          '',
          '內容：',
          source.slice(0, 6000)
        ].join('\n'), 'app/markdown');
      }

      /* ------------------------------------------------------- listeners */

      btnRendered.addEventListener('click', function () { setMode('rendered'); });
      btnSource.addEventListener('click', function () { setMode('source'); });
      btnOutline.addEventListener('click', function () {
        var on = btnOutline.getAttribute('aria-pressed') !== 'true';
        btnOutline.setAttribute('aria-pressed', on ? 'true' : 'false');
        split.classList.toggle('no-outline', !on);
      });
      btnEdit.addEventListener('click', function () {
        if (!path) { ctx.toast('還沒開啟檔案', 't-warn'); return; }
        AIOS.apps.launch('editor', path, { forceNew: true });
      });
      btnHtml.addEventListener('click', function () { exportHtml(); });
      btnPdf.addEventListener('click', function () { exportPdf(); });

      var searchTimer = null;
      search.addEventListener('input', function () {
        if (searchTimer) window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(function () {
          query = search.value.trim();
          render();
        }, 180);
      });

      ctx.setMenu(function (ev) {
        var onHeading = ev.target.closest ? ev.target.closest('.md-h') : null;
        var head = [];
        if (onHeading) {
          head = [
            { label: '複製這個標題', run: function () {
              A.clipboard.write(onHeading.textContent);
              ctx.toast('已複製');
            } },
            { sep: true }
          ];
        }
        return head.concat([
          { label: mode === 'rendered' ? '看原始碼' : '看排版',
            run: function () { setMode(mode === 'rendered' ? 'source' : 'rendered'); } },
          { label: split.classList.contains('no-outline') ? '顯示大綱' : '隱藏大綱',
            run: function () { btnOutline.click(); } },
          { sep: true },
          { label: '用編輯器開啟', disabled: !path,
            run: function () { AIOS.apps.launch('editor', path, { forceNew: true }); } },
          { label: '用文件編輯器開啟（會轉成區塊）', disabled: !path,
            run: function () { AIOS.apps.launch('docs', path, { forceNew: true }); } },
          { label: '匯出 HTML…', disabled: !path, run: function () { exportHtml(); } },
          { label: '匯出 PDF…', disabled: !path, run: function () { exportPdf(); } },
          { sep: true },
          { label: '複製原始碼', disabled: !source,
            run: function () { A.clipboard.write(source); ctx.toast('已複製 ' + source.length + ' 字'); } },
          { label: '複製大綱', disabled: !headings.length,
            run: function () { A.clipboard.write(outlineText()); ctx.toast('已複製大綱'); } },
          { label: '重新讀取', disabled: !path, run: function () { open(path); } }
        ]);
      });

      ctx.describe(function () {
        if (!path) return '還沒有開啟任何 Markdown 檔。';
        var s = stats();
        return [
          '檔案：' + path,
          s.words + ' 詞、' + s.lines + ' 行、' + s.headings + ' 個標題、約 ' + s.minutes + ' 分鐘讀完',
          '檢視模式：' + (mode === 'rendered' ? '排版' : '原始碼'),
          '',
          '大綱：',
          outlineText(),
          '',
          '原始內容（前 6000 字）：',
          source.slice(0, 6000)
        ].join('\n');
      });

      ctx.api = {
        open: open,
        setMode: setMode,
        outlineText: outlineText,
        exportHtml: exportHtml,
        exportPdf: exportPdf,
        stats: stats,
        blocks: function () { return blocks; },
        headings: function () { return headings.map(function (h) { return { level: h.level, text: h.text }; }); }
      };

      if (typeof ctx.arg === 'string') open(ctx.arg);
      else if (ctx.state && ctx.state.path) open(ctx.state.path);
      else render();
      setMode(mode);

      return {
        getState: function () { return { path: path, mode: mode }; },
        reopen: function (vpath) { if (typeof vpath === 'string') open(vpath); },
        onClose: function () { ctx.publish(null); }
      };
    }
  });

  /* Exposed for the tests, which exercise the parser without a DOM. */
  AIOS.markdown = { parse: parse, inline: inline };
})();
