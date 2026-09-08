'use strict';

/* ===========================================================================
   AI-OS // the page agent for article extraction
   ---------------------------------------------------------------------------
   Turns the page someone is looking at into Markdown, so it can be saved as
   Markdown, Word or PDF. One extraction feeds all three: a document exported
   three ways should say the same thing three times, and the way that stops
   being true is three converters each reading the page their own way.

   It runs in an ISOLATED WORLD, like the translation agent and for the same
   reason (see translate-agent.js): browser views are created with
   `preload: undefined` so untrusted content cannot reach the application, and
   an isolated world keeps that promise. The agent shares the page's DOM and
   nothing else. The source is a real function rather than a string so it is
   syntax checked with the rest of the machine, so it must close over NOTHING.

   Reading the live DOM rather than re-fetching the URL is the whole point.
   A second fetch gets a different page: no script has run, so a site that
   renders its article client-side returns an empty shell, and anything behind
   a login returns the login form. What is on screen is what gets converted.

   It only reads. Nothing here writes to the page, and the returned Markdown is
   page content -- untrusted, exactly like everything else that comes out of a
   browser view.

   PICTURES ARE NAMED HERE AND FETCHED ELSEWHERE

   The Markdown carries `![alt](url)`, and beside it comes `pictures`: the same
   URLs, with the size each one is drawn at. The bytes are not read here. An
   isolated world can see the pixels but cannot get them out -- a cross-origin
   image taints the canvas and `toDataURL` throws, which is most of the pictures
   on most articles -- so the list is the deliverable and `browser.articleImages`
   fetches from it. That list is also the allowlist: the exporter will fetch a
   URL only because this extraction saw the page draw it.

   What counts as "the article" is a heuristic and says so:

     - an explicit container wins (<article>, [role=main], <main>), because a
       site that marked one up has already answered the question
     - otherwise the element whose paragraphs hold the most text wins
     - navigation, asides, headers, footers, forms and controls are dropped by
       tag and by ARIA role
     - anything the page has actually hidden is dropped, which is the check
       that a re-fetching extractor cannot make: `display: none` is only
       knowable once the stylesheets have been applied
     - a conservative list of class and id tokens (ad, sidebar, share, related,
       comments…) is dropped, matched token by token so that `gradient` is not
       read as an ad and `header-image` is not read as a masthead
   =========================================================================== */

/* eslint-disable */
function articleAgent() {
  var LIMIT = 300000;

  /* Never part of an article. Controls and embedded media are here because
     what they would contribute to a document is a word like "Submit". */
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1,
    IFRAME: 1, OBJECT: 1, EMBED: 1, VIDEO: 1, AUDIO: 1, MAP: 1, AREA: 1,
    NAV: 1, ASIDE: 1, FOOTER: 1, HEADER: 1, FORM: 1, DIALOG: 1,
    BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, LABEL: 1, FIELDSET: 1,
    LINK: 1, META: 1, BASE: 1
  };

  var SKIP_ROLES = {
    navigation: 1, banner: 1, complementary: 1, contentinfo: 1, search: 1,
    form: 1, dialog: 1, alertdialog: 1, menu: 1, menubar: 1, toolbar: 1,
    tablist: 1, alert: 1
  };

  /* Matched against each class token and the id separately, not against the
     whole attribute. `ad` must not match `gradient`, and `header` must not
     match `header-image` -- so a token counts only when it is the whole token
     or the token's first hyphen- or underscore-separated word. */
  var NOISE = {
    ad: 1, ads: 1, adbox: 1, advert: 1, advertisement: 1, advertising: 1,
    sponsor: 1, sponsored: 1, promo: 1, promotion: 1,
    sidebar: 1, side: 1, rail: 1, widget: 1, banner: 1, masthead: 1,
    nav: 1, navbar: 1, navigation: 1, menu: 1, breadcrumb: 1, breadcrumbs: 1,
    pagination: 1, pager: 1, toolbar: 1, topbar: 1,
    share: 1, sharing: 1, social: 1, follow: 1,
    comment: 1, comments: 1, disqus: 1, respond: 1,
    related: 1, recommend: 1, recommended: 1, recirc: 1, more: 1,
    newsletter: 1, subscribe: 1, subscription: 1, signup: 1, paywall: 1,
    popup: 1, modal: 1, overlay: 1, cookie: 1, consent: 1, gdpr: 1,
    footer: 1, copyright: 1, legal: 1, skip: 1, hidden: 1, offscreen: 1,
    'sr-only': 1, visuallyhidden: 1
  };

  function firstWord(token) {
    var cut = token.length;
    for (var i = 0; i < token.length; i++) {
      var c = token.charAt(i);
      if (c === '-' || c === '_') { cut = i; break; }
    }
    return token.slice(0, cut);
  }

  function noisy(el) {
    var names = [];
    var cls = el.getAttribute && el.getAttribute('class');
    if (cls && typeof cls === 'string') names = cls.toLowerCase().split(/\s+/);
    var id = el.getAttribute && el.getAttribute('id');
    if (id) names.push(String(id).toLowerCase());
    for (var i = 0; i < names.length; i++) {
      var t = names[i];
      if (!t) continue;
      if (NOISE[t] || NOISE[firstWord(t)]) return true;
    }
    return false;
  }

  /* Only what the page has actually hidden. A page that renders an element and
     then hides it is saying it is not content, and this is the one check that
     needs the stylesheets to have been applied. */
  function hidden(el) {
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    var s;
    try { s = getComputedStyle(el); } catch (e) { return false; }
    if (!s) return false;
    return s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse';
  }

  function skip(el) {
    if (SKIP_TAGS[el.tagName]) return true;
    var role = el.getAttribute && el.getAttribute('role');
    if (role && SKIP_ROLES[String(role).toLowerCase()]) return true;
    if (noisy(el)) return true;
    return hidden(el);
  }

  function abs(href) {
    if (!href) return '';
    try {
      var u = new URL(href, location.href);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
    } catch (e) { return ''; }
  }

  /* Minimal on purpose. Escaping every `_` turns snake_case into backslash
     soup, and a document nobody can read is a worse outcome than a stray
     asterisk. Only the characters that would change the structure. */
  function esc(s) {
    return String(s).replace(/([\\`*\[\]])/g, '\\$1');
  }

  function squash(s) {
    return String(s).replace(/[\s ]+/g, ' ');
  }

  /* --------------------------------------------------------------- inline */

  function inline(node) {
    if (node.nodeType === 3) return esc(squash(node.nodeValue));
    if (node.nodeType !== 1) return '';
    if (skip(node)) return '';

    var tag = node.tagName;
    if (tag === 'BR') return '\n';
    if (tag === 'IMG') return image(node);

    if (tag === 'CODE' && !node.closest('pre')) {
      var code = squash(node.textContent || '').trim();
      /* One more backtick than the longest run inside it, which is how a code
         span holds a backtick without ending early. */
      var longest = 0;
      var runs = code.match(/`+/g) || [];
      for (var r = 0; r < runs.length; r++) if (runs[r].length > longest) longest = runs[r].length;
      var fence = new Array(longest + 2).join('`');
      return fence + (code.charAt(0) === '`' ? ' ' : '') + code +
             (code.charAt(code.length - 1) === '`' ? ' ' : '') + fence;
    }

    var inner = '';
    for (var i = 0; i < node.childNodes.length; i++) inner += inline(node.childNodes[i]);
    var body = inner.trim();
    if (!body) return inner;

    if (tag === 'A') {
      var href = abs(node.getAttribute('href'));
      /* A link whose text is already the URL says it twice as Markdown. */
      return href && href !== body ? '[' + body + '](' + href + ')' : body;
    }
    if (tag === 'STRONG' || tag === 'B') return '**' + body + '**';
    if (tag === 'EM' || tag === 'I' || tag === 'CITE') return '*' + body + '*';
    if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return '~~' + body + '~~';
    if (tag === 'SUP') return '^' + body;
    if (tag === 'SUB') return '_' + body;
    return inner;
  }

  var imageCount = 0;
  /* Every picture this extraction kept, in the order it met them: the URL, and
     the size it is actually drawn at. The exporter uses this list as the
     allowlist of what it may fetch -- see browser.articleImages -- so it must
     hold the URL exactly as emitted into the Markdown, character for character,
     or the two will not match and the picture will be refused. */
  var pictures = [];
  var pictureAt = {};

  /* Attributes a lazy-loader puts the real URL in while `src` holds a
     placeholder. Ordered by how common they are; the first that resolves to an
     http(s) URL wins. */
  var LAZY = [
    'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc',
    'data-hi-res-src', 'data-image-src', 'data-url', 'data-echo'
  ];

  /**
   * The widest candidate in a srcset.
   *
   * A responsive image is often written with no usable `src` at all, and when
   * there is one it is usually the smallest. The widest descriptor is the one
   * worth putting in a document, because the document is going to be printed or
   * read at full size rather than on the phone the small one was cut for.
   */
  function fromSrcset(raw) {
    if (!raw) return '';
    var best = '';
    var bestW = -1;
    var parts = String(raw).split(',');
    for (var i = 0; i < parts.length; i++) {
      var bits = parts[i].trim().split(/\s+/);
      if (!bits[0]) continue;
      var href = abs(bits[0]);
      if (!href) continue;
      /* "1024w" is a width, "2x" is a density. Something with neither is a
         single candidate and counts as the widest thing seen so far. */
      var d = bits[1] || '';
      var w = /^(\d+)w$/.test(d) ? parseInt(d, 10)
        : /^([\d.]+)x$/.test(d) ? parseFloat(d) * 1000
          : 0;
      if (w > bestW) { bestW = w; best = href; }
    }
    return best;
  }

  /**
   * Where this picture's bytes actually are.
   *
   * `currentSrc` first, because it is the browser's own answer to srcset and
   * `<picture>` -- it is the file that was really downloaded and is really on
   * screen, which is exactly the one the document should carry. Everything
   * after it is for an image that has not loaded, where there is no answer yet
   * and the attributes have to be read directly.
   *
   * Each candidate goes through `abs()` separately. Chaining them inside one
   * `abs()` call was the old shape and it dropped the commonest lazy-load in
   * the world: `src` holding a data: placeholder is truthy, so `data-src` was
   * never consulted, and then the placeholder failed the scheme check and the
   * whole picture went away without even being counted.
   */
  function sourceOf(el) {
    var live = abs(el.currentSrc || '');
    if (live) return live;

    var direct = abs(el.getAttribute('src') || '');
    if (direct) return direct;

    var set = fromSrcset(el.getAttribute('srcset'));
    if (set) return set;

    /* <picture> keeps its candidates on the <source> children, and the <img>
       inside it may carry nothing but an alt. */
    var pic = el.parentNode;
    if (pic && pic.tagName === 'PICTURE') {
      var kids = pic.getElementsByTagName('source');
      for (var k = 0; k < kids.length; k++) {
        var got = fromSrcset(kids[k].getAttribute('srcset') || kids[k].getAttribute('src'));
        if (got) return got;
      }
    }

    for (var i = 0; i < LAZY.length; i++) {
      var lazy = abs(el.getAttribute(LAZY[i]) || '');
      if (lazy) return lazy;
    }
    var lazySet = fromSrcset(el.getAttribute('data-srcset'));
    return lazySet || '';
  }

  function image(el) {
    var src = sourceOf(el);
    if (!src) return '';
    /* A tracking pixel is not an illustration. */
    if ((el.naturalWidth && el.naturalWidth <= 2) || (el.naturalHeight && el.naturalHeight <= 2)) return '';
    imageCount++;
    var alt = squash(el.getAttribute('alt') || '').trim();

    if (!pictureAt[src]) {
      pictureAt[src] = 1;
      pictures.push({
        src: src,
        alt: alt,
        /* The drawn size, falling back to the intrinsic one. Used to lay the
           picture out on the page and to decide what is worth carrying: a
           16-pixel icon is furniture, not an illustration. */
        w: Math.round(el.width || el.naturalWidth || 0),
        h: Math.round(el.height || el.naturalHeight || 0),
        loaded: !!(el.complete && el.naturalWidth)
      });
    }
    return '![' + esc(alt) + '](' + src + ')';
  }

  function lineOf(el) {
    var s = '';
    for (var i = 0; i < el.childNodes.length; i++) s += inline(el.childNodes[i]);
    return s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
  }

  /* ---------------------------------------------------------------- blocks */

  var out = [];
  var size = 0;

  function push(s) {
    if (size > LIMIT) return;
    var t = String(s);
    out.push(t);
    size += t.length;
  }

  function walk(el, depth) {
    if (size > LIMIT || depth > 24) return;
    if (el.nodeType === 3) {
      var loose = squash(el.nodeValue).trim();
      if (loose) push(esc(loose));
      return;
    }
    if (el.nodeType !== 1 || skip(el)) return;

    var tag = el.tagName;

    if (/^H[1-6]$/.test(tag)) {
      var text = lineOf(el);
      if (text) push(new Array(Number(tag.charAt(1)) + 1).join('#') + ' ' + text);
      return;
    }
    if (tag === 'P' || tag === 'FIGCAPTION' || tag === 'DD' || tag === 'DT') {
      var p = lineOf(el);
      if (p) push(tag === 'FIGCAPTION' ? '*' + p + '*' : p);
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      /* One block for the whole list, not one per item. Blocks are joined with
         a blank line, and a blank line between two `- ` lines is a loose list:
         Markdown still calls it a list, and every renderer puts a paragraph's
         worth of space between the bullets. */
      var lines = [];
      list(el, 0, tag === 'OL', lines);
      if (lines.length) push(lines.join('\n'));
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      var inner = [];
      var save = out; var saveSize = size;
      out = inner; size = 0;
      for (var i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i], depth + 1);
      out = save; size = saveSize + inner.join('').length;
      var quoted = inner.join('\n\n').split('\n').map(function (l) { return '> ' + l; }).join('\n');
      if (quoted.trim() !== '>') push(quoted);
      return;
    }
    if (tag === 'PRE') {
      var code = (el.textContent || '').replace(/\s+$/, '');
      if (!code.trim()) return;
      var lang = '';
      var codeEl = el.querySelector('code');
      var m = /(?:^|\s)(?:language|lang)-([a-z0-9+#-]+)/i.exec(
        (codeEl && codeEl.getAttribute('class')) || el.getAttribute('class') || '');
      if (m) lang = m[1];
      /* A fence longer than any run of backticks in the code itself. */
      var runs = code.match(/`{3,}/g) || [];
      var longest = 2;
      for (var r = 0; r < runs.length; r++) if (runs[r].length > longest) longest = runs[r].length;
      var fence = new Array(longest + 2).join('`');
      push(fence + lang + '\n' + code + '\n' + fence);
      return;
    }
    if (tag === 'TABLE') { table(el); return; }
    if (tag === 'HR') { push('---'); return; }
    if (tag === 'IMG') { var one = image(el); if (one) push(one); return; }

    for (var c = 0; c < el.childNodes.length; c++) walk(el.childNodes[c], depth + 1);
  }

  function list(el, indent, ordered, lines) {
    var pad = new Array(indent + 1).join('  ');
    var n = 1;
    for (var i = 0; i < el.children.length; i++) {
      var li = el.children[i];
      if (li.tagName !== 'LI' || skip(li)) continue;

      /* The item's own text, with any nested list left out of it -- that goes
         underneath at one more level of indent, not inside the line. */
      var own = '';
      var nested = [];
      for (var j = 0; j < li.childNodes.length; j++) {
        var kid = li.childNodes[j];
        if (kid.nodeType === 1 && (kid.tagName === 'UL' || kid.tagName === 'OL')) nested.push(kid);
        else own += inline(kid);
      }
      own = own.replace(/\s+/g, ' ').trim();
      var marker = ordered ? (n++) + '. ' : '- ';
      if (own) lines.push(pad + marker + own);
      for (var k = 0; k < nested.length; k++) {
        list(nested[k], indent + 1, nested[k].tagName === 'OL', lines);
      }
    }
  }

  function table(el) {
    var rows = [];
    var trs = el.querySelectorAll('tr');
    for (var i = 0; i < trs.length && rows.length < 200; i++) {
      if (skip(trs[i])) continue;
      var cells = [];
      var kids = trs[i].children;
      for (var j = 0; j < kids.length; j++) {
        var cell = kids[j];
        if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
        cells.push(lineOf(cell).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return;

    /* Ragged rows are common in real markup and a Markdown table with a
       different number of cells per row renders as nonsense. Pad to the
       widest row rather than dropping the odd ones. */
    var width = 0;
    for (var w = 0; w < rows.length; w++) if (rows[w].length > width) width = rows[w].length;
    var dashes = [];
    for (var d = 0; d < width; d++) dashes.push('---');
    var lines = [];
    for (var r = 0; r < rows.length; r++) {
      while (rows[r].length < width) rows[r].push('');
      lines.push('| ' + rows[r].join(' | ') + ' |');
      if (r === 0) lines.push('| ' + dashes.join(' | ') + ' |');
    }
    push(lines.join('\n'));
  }

  /* ------------------------------------------------------------ the article */

  function pickRoot() {
    var explicit = document.querySelector('article') ||
                   document.querySelector('[role="main"]') ||
                   document.querySelector('main');
    /* Low on purpose. The only thing this threshold is for is the empty
       <article> shell a client-rendered page serves before its script has run;
       anything above a sentence or two is a real article. It was 200, which is
       three lines of English and a whole short news item in Chinese -- so a
       correctly marked-up page fell through to the guesswork below and came
       back with the site's own masthead as its title. */
    if (explicit && (explicit.textContent || '').trim().length > 40) {
      return { el: explicit, how: 'explicit' };
    }

    /* Otherwise: whichever element holds the most paragraph text. Scored by
       walking the paragraphs once and crediting their nearest ancestors,
       rather than by scoring every container -- on a large page that is the
       difference between linear and quadratic. */
    var best = null;
    var bestScore = 0;
    var scores = new Map();
    var ps = document.querySelectorAll('p');
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      if (skip(p)) continue;
      var len = (p.textContent || '').trim().length;
      if (len < 25) continue;
      var up = p.parentElement;
      for (var lvl = 0; lvl < 3 && up && up !== document.body; lvl++) {
        var was = (scores.get(up) || 0) + len;
        scores.set(up, was);
        if (was > bestScore) { bestScore = was; best = up; }
        up = up.parentElement;
      }
    }
    if (best && bestScore > 200) return { el: best, how: 'scored' };
    return { el: document.body, how: 'body' };
  }

  function pickTitle(root) {
    var h1 = root.querySelector && root.querySelector('h1');
    if (h1 && !skip(h1)) {
      var t = squash(h1.textContent || '').trim();
      if (t) return t;
    }
    var og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return squash(og.content).trim();
    return squash(document.title || location.href).trim();
  }

  function pickByline() {
    var meta = document.querySelector('meta[name="author"]');
    if (meta && meta.content) return squash(meta.content).trim().slice(0, 120);
    var rel = document.querySelector('[rel="author"], [itemprop="author"]');
    if (rel && !skip(rel)) return squash(rel.textContent || '').trim().slice(0, 120);
    return '';
  }

  var picked = pickRoot();
  var root = picked.el;
  var title = pickTitle(root);

  for (var i = 0; i < root.childNodes.length; i++) walk(root.childNodes[i], 0);

  var markdown = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

  /* The article's own <h1> is almost always the first heading in the body too.
     Emitting the title above it would put the same line in the document twice. */
  var titleLine = '# ' + title;
  if (markdown.indexOf(titleLine + '\n') === 0 || markdown === titleLine) {
    markdown = markdown.slice(titleLine.length).replace(/^\n+/, '');
  }

  return {
    url: location.href,
    title: title,
    byline: pickByline(),
    how: picked.how,
    markdown: markdown.slice(0, LIMIT),
    chars: markdown.length,
    images: imageCount,
    /* Capped here as well as at the fetcher. A gallery page can hold hundreds
       of pictures, and a list that long is not worth carrying across the
       boundary to be refused on the other side. */
    pictures: pictures.slice(0, 60),
    truncated: markdown.length > LIMIT
  };
}

/* Handed to executeJavaScriptInIsolatedWorld as an expression, so the value of
   the last statement is what comes back to the main process. */
const SOURCE = '(' + articleAgent.toString() + ')()';

module.exports = { SOURCE, articleAgent };
