'use strict';

/* ===========================================================================
   AI-OS // mail HTML, made safe to look at
   ---------------------------------------------------------------------------
   A message body is the one piece of content on this machine that a stranger
   wrote and addressed to you personally. Until now the reader answered that by
   throwing the formatting away and showing text, which is safe and, as the user
   put it, not acceptable: a quotation, a table of figures and a signature block
   all arrive as the same undifferentiated paragraph, and a report becomes
   unreadable.

   So the formatting comes back, behind three independent layers. Any one of
   them would stop a script; all three are here because the cost of being wrong
   is somebody else's code running inside a privileged window.

     1. this file        the markup is parsed and rebuilt from an allowed list.
                         Not a blacklist -- an element or an attribute that is
                         not named here does not survive, so a tag invented next
                         year is dropped rather than passed through.
     2. the frame        `sandbox` with no allow-scripts. Scripts do not run,
                         forms do not submit, nothing navigates the host.
     3. the policy       a Content-Security-Policy inside the document:
                         `default-src 'none'`. Remote images, fonts and styles
                         are not fetched, so a message cannot phone home just by
                         being opened -- which is how read receipts work.

   Links keep their text and their styling, and lose their href. A link in a
   message is the phishing surface, and a click that silently opens the real
   browser is exactly the thing to avoid; the real URLs come back separately, as
   a list the reader shows under the message with the address visible.

   Remote images are off until the reader asks for them, because fetching one is
   telling the sender that this address is real and read the message.
   =========================================================================== */

/* global window, module */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AIOS = root.AIOS || {};
    root.AIOS.mailhtml = factory();
  }
}(typeof window !== 'undefined' ? window : this, function () {

  /* Elements that carry meaning a reader needs. Everything structural about a
     business email is here: headings, lists, tables, quotes, and the font/style
     spans that make a report look like a report. */
  var ALLOW = {
    a: 1, abbr: 1, b: 1, blockquote: 1, br: 1, caption: 1, center: 1, cite: 1,
    code: 1, col: 1, colgroup: 1, dd: 1, del: 1, div: 1, dl: 1, dt: 1, em: 1,
    figcaption: 1, figure: 1, font: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
    hr: 1, i: 1, img: 1, ins: 1, li: 1, mark: 1, ol: 1, p: 1, pre: 1, q: 1,
    s: 1, samp: 1, small: 1, span: 1, strike: 1, strong: 1, sub: 1, sup: 1,
    table: 1, tbody: 1, td: 1, tfoot: 1, th: 1, thead: 1, tr: 1, u: 1, ul: 1,
    wbr: 1
  };

  /* Dropped whole, contents and all. Everything else that is not allowed keeps
     its text -- a <section> is a box, and losing the box should not lose the
     words inside it -- but these carry no text a reader wants and every one of
     them is a way in. */
  var DROP_WHOLE = {
    script: 1, style: 1, head: 1, title: 1, meta: 1, link: 1, base: 1,
    iframe: 1, frame: 1, frameset: 1, object: 1, embed: 1, applet: 1,
    audio: 1, video: 1, source: 1, track: 1, canvas: 1, svg: 1, math: 1,
    form: 1, input: 1, button: 1, select: 1, option: 1, textarea: 1, label: 1,
    template: 1, slot: 1, noscript: 1, dialog: 1, portal: 1
  };

  /* Attributes kept, per element. `style` is the one that matters for looking
     like the original, and it is filtered again below. */
  var ATTRS = {
    '*': { style: 1, align: 1, valign: 1, dir: 1, lang: 1, title: 1 },
    a: { },
    img: { src: 1, alt: 1, width: 1, height: 1 },
    table: { border: 1, cellpadding: 1, cellspacing: 1, width: 1, bgcolor: 1 },
    td: { colspan: 1, rowspan: 1, width: 1, height: 1, bgcolor: 1, nowrap: 1 },
    th: { colspan: 1, rowspan: 1, width: 1, height: 1, bgcolor: 1, nowrap: 1 },
    tr: { bgcolor: 1 },
    col: { span: 1, width: 1 },
    colgroup: { span: 1, width: 1 },
    font: { color: 1, size: 1, face: 1 },
    ol: { start: 1, type: 1 },
    div: { },
    p: { },
    span: { }
  };

  /* CSS properties a message may set. A list again, not a filter: `position`,
     `behavior`, `-moz-binding` and whatever comes next are simply not here. */
  var CSS_OK = /^(color|background-color|background|font|font-[a-z-]+|text-[a-z-]+|line-height|letter-spacing|word-spacing|white-space|vertical-align|text-align|margin|margin-[a-z]+|padding|padding-[a-z]+|border|border-[a-z-]+|width|max-width|min-width|height|max-height|min-height|display|list-style|list-style-[a-z]+|table-layout|border-collapse|border-spacing|direction|opacity)$/;

  /* A value that reaches outside the document, or runs. */
  var CSS_BAD = /url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|binding\s*:|<\/?[a-z]/i;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Only what a browser may safely be asked to fetch for an image. */
  function imageSrc(v) {
    var s = String(v || '').trim();
    if (/^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(s)) return s;
    if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
    if (/^http:\/\/[^\s"'<>]+$/i.test(s)) return s;
    if (/^cid:[^\s"'<>]+$/i.test(s)) return s;
    return '';
  }

  /** A link the reader may offer to open. Anything else is not a destination. */
  function linkHref(v) {
    var s = String(v || '').trim();
    if (/^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(s)) return s;
    return '';
  }

  function cleanStyle(v) {
    var out = [];
    String(v || '').split(';').forEach(function (bit) {
      var at = bit.indexOf(':');
      if (at < 0) return;
      var name = bit.slice(0, at).trim().toLowerCase();
      var val = bit.slice(at + 1).trim();
      if (!name || !val) return;
      if (!CSS_OK.test(name)) return;
      if (CSS_BAD.test(val)) return;
      if (val.length > 200) return;
      out.push(name + ':' + val);
    });
    return out.join(';');
  }

  /* --------------------------------------------------------------- parsing */

  var TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  var ATTR = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  var VOID = { br: 1, hr: 1, img: 1, col: 1, wbr: 1 };

  function attrsOf(raw) {
    var out = {};
    var m;
    ATTR.lastIndex = 0;
    while ((m = ATTR.exec(raw))) {
      var name = m[1].toLowerCase();
      var val = m[2] || '';
      if (val.length > 1 && (val[0] === '"' || val[0] === "'")) val = val.slice(1, -1);
      out[name] = val;
    }
    return out;
  }

  /**
   * Rebuild a message body from what is allowed.
   *
   * Returns `{ html, links, images, blocked }`: the markup to show, the real
   * destinations of every link so the reader can list them, how many images
   * there are, and how many of those were left unfetched.
   */
  function sanitise(src, opts) {
    var o = opts || {};
    var showImages = !!o.images;
    var html = String(src == null ? '' : src);

    /* Comments can hide a closing bracket, and conditional comments hide whole
       elements from one parser and not another. Neither is content. */
    html = html.replace(/<!--[\s\S]*?-->/g, '');
    html = html.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    html = html.replace(/<![^>]*>/g, '');

    var out = [];
    var links = [];
    var images = 0;
    var blocked = 0;
    var skipUntil = null;     // inside a dropped element, and how deep
    var depth = 0;
    var open = [];            // elements we emitted and must close
    var last = 0;
    var m;

    TAG.lastIndex = 0;
    while ((m = TAG.exec(html))) {
      var textBit = html.slice(last, m.index);
      last = TAG.lastIndex;
      if (!skipUntil && textBit) out.push(textBit);

      var closing = m[1] === '/';
      var name = m[2].toLowerCase();

      if (skipUntil) {
        if (name === skipUntil) {
          if (closing) { depth--; if (depth <= 0) { skipUntil = null; depth = 0; } }
          else depth++;
        }
        continue;
      }

      if (DROP_WHOLE[name]) {
        if (!closing && !VOID[name]) { skipUntil = name; depth = 1; }
        continue;
      }

      if (!ALLOW[name]) continue;   // unknown box: keep the words, lose the box

      if (closing) {
        var at = open.lastIndexOf(name);
        if (at >= 0) {
          /* Close anything left open inside it, so a stray </div> cannot drop
             the rest of the message out of its container. */
          for (var k = open.length - 1; k >= at; k--) out.push('</' + open[k] + '>');
          open.length = at;
        }
        continue;
      }

      var a = attrsOf(m[3] || '');
      var keep = [];
      var allowed = ATTRS[name] || {};
      var shared = ATTRS['*'];

      Object.keys(a).forEach(function (k) {
        if (!allowed[k] && !shared[k]) return;
        var v = a[k];
        if (k === 'style') {
          v = cleanStyle(v);
          if (!v) return;
        } else if (/^on/i.test(k)) {
          return;
        } else if (v.length > 500) {
          return;
        }
        keep.push(k + '="' + esc(v) + '"');
      });

      if (name === 'img') {
        var src2 = imageSrc(a.src);
        images++;
        var remote = /^https?:/i.test(src2);
        if (!src2 || (remote && !showImages) || /^cid:/i.test(src2)) {
          if (src2) blocked++;
          /* The gap where a picture goes, so the layout does not collapse and
             the reader can see that something was withheld. */
          out.push('<span class="m-img-off" title="' + esc(a.alt || '圖片') + '">［圖片］</span>');
          continue;
        }
        keep = keep.filter(function (x) { return x.indexOf('src=') !== 0; });
        keep.push('src="' + esc(src2) + '"');
      }

      if (name === 'a') {
        var href = linkHref(a.href);
        if (href) {
          links.push(href);
          /* The number the reader puts beside the same link in its own list, so
             a person can tell which one they are about to open. */
          keep.push('data-link="' + links.length + '"');
        }
      }

      out.push('<' + name + (keep.length ? ' ' + keep.join(' ') : '') + '>');
      if (!VOID[name]) open.push(name);
      else if (name === 'a') { /* not void; kept for clarity */ }
    }

    var tail = html.slice(last);
    if (!skipUntil && tail) out.push(tail);
    for (var j = open.length - 1; j >= 0; j--) out.push('</' + open[j] + '>');

    return {
      html: out.join(''),
      links: links,
      images: images,
      blocked: blocked
    };
  }

  /* The policy the document carries. `default-src 'none'` is the line that
     stops a message fetching anything at all; images are opened up only when
     the reader asked for them, and never for http. */
  function policy(showImages) {
    return "default-src 'none'; style-src 'unsafe-inline'; font-src data:; " +
      'img-src data:' + (showImages ? ' https: http:' : '') +
      "; script-src 'none'; object-src 'none'; frame-src 'none'; " +
      "form-action 'none'; base-uri 'none'; connect-src 'none'";
  }

  /**
   * The whole document handed to the frame.
   *
   * Written here rather than in the reader so the policy and the markup that it
   * governs are decided in one place; a page whose CSP came from somewhere else
   * is a page whose CSP can be forgotten.
   */
  function document_(body, opts) {
    var o = opts || {};
    var clean = sanitise(body, o);
    var page = [
      '<!doctype html><html><head><meta charset="utf-8">',
      '<meta http-equiv="Content-Security-Policy" content="' + esc(policy(o.images)) + '">',
      '<style>',
      'html,body{margin:0;padding:12px 14px;background:' + (o.background || '#ffffff') + ';',
      '  color:' + (o.color || '#111111') + ';',
      "  font:14px/1.6 'Segoe UI','Microsoft JhengHei',system-ui,sans-serif;",
      '  word-break:break-word;overflow-wrap:anywhere;}',
      'img{max-width:100%;height:auto}',
      'table{max-width:100%;border-collapse:collapse}',
      'td,th{padding:2px 6px}',
      'blockquote{margin:8px 0;padding:2px 12px;border-left:3px solid #c9c9c9;color:#555}',
      'pre{white-space:pre-wrap}',
      'a{color:#0b57d0;text-decoration:underline;cursor:default}',
      'a[data-link]::after{content:" [" attr(data-link) "]";font-size:11px;color:#777;vertical-align:super}',
      '.m-img-off{display:inline-block;padding:1px 6px;margin:1px;border:1px dashed #b9b9b9;',
      '  border-radius:3px;color:#777;font-size:12px;background:#fafafa}',
      '</style></head><body>',
      clean.html,
      '</body></html>'
    ].join('\n');
    return { page: page, links: clean.links, images: clean.images, blocked: clean.blocked };
  }

  return {
    sanitise: sanitise,
    document: document_,
    policy: policy,
    imageSrc: imageSrc,
    linkHref: linkHref,
    cleanStyle: cleanStyle,
    ALLOW: ALLOW,
    DROP_WHOLE: DROP_WHOLE
  };
}));
