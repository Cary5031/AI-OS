'use strict';

/* ===========================================================================
   Turning a web page into a document
   ---------------------------------------------------------------------------
   Two halves, tested two ways.

   The agent runs in a page and cannot be executed here, so it is read: what it
   must never do (write to the page, open a channel of its own) is checkable in
   the source, and that is the half where a mistake would be serious rather
   than ugly. Whether it extracts a given page well is a question for
   e2e/specs/browser.mjs, which runs it against a real page in a real view.

   The renderer half is executed for real. `AIOS.printing.blocksHtml` is a pure
   function of a block list, so it runs in a VM with surfaces.js loaded, and
   what it produces is compared to what it should produce.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const agent = require('../app/main/article-agent');
const browser = require('../app/main/browser');

const APP = path.join(__dirname, '..', 'app');
const read = (p) => fs.readFileSync(path.join(APP, p), 'utf8');

/* ---------------------------------------------------------------- the agent */

test('the article agent is one expression, and it only reads', () => {
  assert.match(agent.SOURCE, /^\(function articleAgent\(\) \{/, 'a single wrapped function');
  assert.match(agent.SOURCE, /\}\)\(\)$/, 'called immediately, so its value comes back');

  const body = agent.articleAgent.toString();

  /* The page is hostile input and this runs with its DOM in reach. Reading it
     is the entire job; anything that writes is a bug with consequences. */
  assert.doesNotMatch(body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    'nothing here builds markup');
  assert.doesNotMatch(body, /\.appendChild\(|\.removeChild\(|\.remove\(\)|\.replaceChild\(|\.insertBefore\(/,
    'and nothing here changes the page it is reading');
  assert.doesNotMatch(body, /\.setAttribute\(|\.nodeValue\s*=|\.textContent\s*=/,
    'nor writes to a node');

  /* An isolated world has no channel except its return value. That is what
     makes it safe to run against a stranger's page. */
  assert.doesNotMatch(body, /require\(|ipcRenderer|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/,
    'the agent has no way out except the value it returns');
  assert.doesNotMatch(body, /\beval\(|new Function\(/, 'nothing in the page gets compiled');
});

/* ------------------------------------------------- the agent, executed

   Everything above reads the agent, because it needs a page to run in. Its
   picture-finding does not: it is a function of one element's attributes, so it
   is lifted out of the source and run for real against a stubbed element.

   Worth the scaffolding because the bug it replaced was invisible to a source
   assertion. `abs(getAttribute('src') || getAttribute('data-src'))` reads
   correctly and is wrong: the `||` picks the first truthy ATTRIBUTE rather than
   the first usable URL, so the commonest lazy-load in the world -- a data: gif
   in `src` with the real picture in `data-src` -- never consulted `data-src` at
   all, then failed the scheme check and vanished without even being counted. */

/** Lift named declarations out of the agent's source so they can be run. */
function lift(names) {
  const src = agent.articleAgent.toString();
  let out = '';
  for (const name of names) {
    const at = src.search(new RegExp('(?:function|var) ' + name + '\\b'));
    assert.ok(at >= 0, name + ' is still in the agent');
    const open = src.indexOf(name.startsWith('LAZY') ? '[' : '{', at);
    const close = name.startsWith('LAZY') ? ']' : '}';
    const opener = name.startsWith('LAZY') ? '[' : '{';
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === opener) depth++;
      else if (src[end] === close) { depth--; if (!depth) { end++; break; } }
    }
    out += src.slice(at, end) + ';\n';
  }
  return out;
}

function pictureFinder(pageUrl) {
  const ctx = { URL, location: { href: pageUrl } };
  vm.createContext(ctx);
  vm.runInContext(lift(['abs', 'LAZY', 'fromSrcset', 'sourceOf']) +
    ';globalThis.sourceOf = sourceOf;', ctx);
  return ctx.sourceOf;
}

/** The smallest thing `sourceOf` will accept: attributes and a parent. */
function img(attrs, extra) {
  const el = Object.assign({
    currentSrc: '',
    parentNode: null,
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null)
  }, extra || {});
  return el;
}

test('a lazy-loaded picture is found where it actually is', () => {
  const find = pictureFinder('https://news.example.com/a/');

  /* The shape that used to be dropped entirely. */
  assert.equal(
    find(img({ src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'data-src': 'https://cdn.example.com/real.jpg' })),
    'https://cdn.example.com/real.jpg');

  /* A relative data-src still gets resolved against the page. */
  assert.equal(find(img({ src: 'about:blank', 'data-src': '/img/real.png' })),
    'https://news.example.com/img/real.png');

  /* An ordinary picture is still just its src. */
  assert.equal(find(img({ src: 'https://cdn.example.com/plain.png' })),
    'https://cdn.example.com/plain.png');

  /* Nothing usable anywhere is still nothing, not a guess. */
  assert.equal(find(img({ src: 'data:image/gif;base64,AA' })), '');
  assert.equal(find(img({})), '');
});

test('what the browser actually loaded wins over what the markup asked for', () => {
  const find = pictureFinder('https://news.example.com/a/');
  /* currentSrc is the browser's own answer to srcset and <picture>: the file
     really on screen. A document should carry that one, not the candidate a
     rule elsewhere in this function happens to prefer. */
  assert.equal(
    find(img({ src: 'https://cdn.example.com/small.jpg', srcset: 'https://cdn.example.com/huge.jpg 3000w' },
      { currentSrc: 'https://cdn.example.com/chosen.jpg' })),
    'https://cdn.example.com/chosen.jpg');
});

test('a responsive picture contributes its widest candidate, not its first', () => {
  const find = pictureFinder('https://news.example.com/a/');

  /* No src at all, which is legal and common. Widest wins because the document
     is going to be printed or read full size, not on the phone the small one
     was cut for. */
  assert.equal(
    find(img({ srcset: '/s.jpg 400w, /m.jpg 800w, /l.jpg 1600w' })),
    'https://news.example.com/l.jpg');

  /* Density descriptors are ordered too. */
  assert.equal(find(img({ srcset: '/1x.png 1x, /2x.png 2x' })), 'https://news.example.com/2x.png');

  /* <picture> keeps its candidates on the <source> children, and the <img>
     inside may carry nothing but an alt. */
  const sources = [{ getAttribute: (k) => (k === 'srcset' ? '/wide.avif 2000w' : null) }];
  assert.equal(
    find(img({ alt: '只有說明' }, {
      parentNode: { tagName: 'PICTURE', getElementsByTagName: () => sources }
    })),
    'https://news.example.com/wide.avif');
});

test('a picture that is not on the web is not a picture this can carry', () => {
  const find = pictureFinder('https://news.example.com/a/');
  /* The scheme gate is what keeps the fetcher's allowlist to things a browser
     would have fetched anyway. blob: and file: are refused here rather than
     being refused later with a worse error. */
  assert.equal(find(img({ src: 'blob:https://news.example.com/abc' })), '');
  assert.equal(find(img({ src: 'file:///C:/secret.png' })), '');
  assert.equal(find(img({ src: 'javascript:alert(1)' })), '');
});

test('the agent drops the furniture, by tag and by role', () => {
  const body = agent.articleAgent.toString();
  for (const tag of ['NAV', 'ASIDE', 'FOOTER', 'HEADER', 'FORM', 'SCRIPT', 'STYLE',
    'IFRAME', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DIALOG']) {
    assert.ok(body.includes(tag + ': 1'), tag + ' has to be in the skip list');
  }
  /* A site that uses <div role="navigation"> is saying the same thing as <nav>
     and used to be believed only when it said it with a tag. */
  for (const role of ['navigation', 'banner', 'complementary', 'contentinfo']) {
    assert.ok(body.includes(role + ': 1'), 'the ARIA role ' + role + ' has to be skipped too');
  }
});

test('a class called gradient is not an advertisement', () => {
  /* The reason `noisy` matches token by token instead of testing the whole
     class attribute. A substring rule deletes the article on any site whose
     wrapper is called `main-ad-free` or whose figure is `header-image`. */
  const body = agent.articleAgent.toString();
  assert.match(body, /function firstWord/, 'a token is split before it is judged');
  assert.match(body, /NOISE\[t\] \|\| NOISE\[firstWord\(t\)\]/,
    'the whole token or its first word, never a substring');
  assert.doesNotMatch(body, /indexOf\('ad'\)|includes\('ad'\)/,
    'a substring search for ad is exactly the bug this avoids');
});

test('the agent drops what the page itself has hidden', () => {
  /* The one check a re-fetching extractor cannot make, and the reason this
     runs in the page at all: display:none is only knowable once the
     stylesheets have been applied. */
  const body = agent.articleAgent.toString();
  assert.match(body, /getComputedStyle/, 'the computed style is what decides');
  assert.match(body, /s\.display === 'none'/, 'display:none is not content');
  assert.match(body, /s\.visibility === 'hidden'/, 'nor is visibility:hidden');
  assert.match(body, /getAttribute\('aria-hidden'\) === 'true'/, 'nor is aria-hidden');
});

test('an explicit article container wins over the scoring heuristic', () => {
  const body = agent.articleAgent.toString();
  assert.match(body, /document\.querySelector\('article'\)/,
    'a site that marked up its article has already answered the question');
  /* Scoring by crediting each paragraph's ancestors, rather than by measuring
     every container: on a large page the second one is quadratic. */
  assert.match(body, /for \(var lvl = 0; lvl < 3/, 'each paragraph credits a bounded number of ancestors');
  assert.doesNotMatch(body, /querySelectorAll\('div[^']*'\)[\s\S]{0,200}querySelectorAll\('p'\)/,
    'scoring must not run a query per container');
});

/* -------------------------------------------------------------- the browser */

test('the browser separates the blank page from the home page', () => {
  /* They shared one name, so the home button could only ever have gone to
     about:blank -- a home button that goes nowhere. */
  assert.equal(browser.BLANK, 'about:blank');
  assert.match(browser.HOME, /^https:\/\//, 'the home page is a page');

  const src = read('main/browser.js');
  assert.match(src, /if \(!raw\) return BLANK;/, 'an empty address bar is a blank page, not the home page');
});

test('the article call is gated like a page read, and does not arm the taint gate', () => {
  const ipc = read('main/ipc.js');
  const at = ipc.indexOf("ipcMain.handle('browser:article'");
  assert.ok(at > 0, 'the channel exists');
  const body = ipc.slice(at, ipc.indexOf("ipcMain.handle('", at + 10));

  assert.match(body, /guarded\('fs\.read'/,
    'reading the page for export is the same act as reading it for the model');

  /* The line this feature had to get right, and got wrong first. The taint is
     about the planner: it arms when a stranger's text enters the model's
     context, because from there it can steer the machine. An export goes to a
     file the person named. Arming here made every save cost a consent dialog
     for the write that same person had just asked for -- friction with nothing
     on the other side of it. Reading that file back into context is what arms
     the gate, on the path that already did. */
  assert.doesNotMatch(body, /addTaint/,
    'saving a page to a file is not the same as feeding it to the model');

  /* And the neighbour that does feed the model must keep doing it. */
  const readAt = ipc.indexOf("ipcMain.handle('browser:readPage'");
  assert.ok(readAt > 0 && readAt < at, 'readPage is still there, right beside it');
});

/* --------------------------------------------------------- blocks to HTML */

/** surfaces.js, loaded far enough to reach the pure helpers on AIOS. */
function loadSurfaces() {
  const AIOS = { apps: { register() {} }, kernel: {}, fonts: { cssFor: () => 'Font' } };
  const stub = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, setAttribute() {}, addEventListener() {}, remove() {},
    querySelectorAll: () => [], querySelector: () => null, style: {}
  });
  vm.runInNewContext(read('renderer/surfaces.js'), {
    window: { aios: {}, AIOS, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    AIOS,
    document: {
      createElement: stub, body: stub(), documentElement: stub(),
      addEventListener() {}, querySelectorAll: () => [], querySelector: () => null
    },
    console, setTimeout, clearTimeout, requestAnimationFrame: (f) => f(),
    navigator: {}, location: { href: '' }
  });
  return AIOS;
}

const AIOS = loadSurfaces();
const html = (blocks, opts) => AIOS.printing.blocksHtml(blocks, opts);

test('headings, paragraphs and quotes come out as themselves', () => {
  const out = html([
    { type: 'heading', level: 2, text: '小標' },
    { type: 'para', text: '一段文字。' },
    { type: 'quote', text: '引用' }
  ]);
  assert.match(out, /<h2>小標<\/h2>/);
  assert.match(out, /<p>一段文字。<\/p>/);
  assert.match(out, /<blockquote>引用<\/blockquote>/);
});

test('consecutive list items become one list, and a change of kind starts another', () => {
  /* markdownToBlocks emits one block per item with no wrapper, so grouping is
     this function's job. Emitting <ul> per item gives a list with the spacing
     of five separate lists. */
  const out = html([
    { type: 'list', ordered: false, text: '甲' },
    { type: 'list', ordered: false, text: '乙' },
    { type: 'list', ordered: true, text: '丙' },
    { type: 'para', text: '結束' }
  ]);
  assert.equal((out.match(/<ul>/g) || []).length, 1, 'two bullets, one <ul>');
  assert.match(out, /<ul>\n<li>甲<\/li>\n<li>乙<\/li>\n<\/ul>/);
  assert.match(out, /<ol>\n<li>丙<\/li>\n<\/ol>/, 'switching to numbered closes the bulleted one');
  assert.match(out, /<\/ol>\n<p>結束<\/p>/, 'and a paragraph closes the list too');
});

test('a table gets a header row, because a print stylesheet repeats thead', () => {
  const out = html([{ type: 'table', rows: [['欄一', '欄二'], ['a', 'b']] }]);
  assert.match(out, /<thead><tr><th>欄一<\/th><th>欄二<\/th><\/tr><\/thead>/);
  assert.match(out, /<tbody>[\s\S]*<td>a<\/td><td>b<\/td>/);
});

test('links survive the conversion', () => {
  /* The reason this renders from `text` rather than from `runs`: runs carry the
     bold and drop the href, and a web page saved without its links has had
     something taken out of it. */
  const out = html([{ type: 'para', text: '見 [說明](https://example.com/a) 一節' }]);
  assert.match(out, /<a href="https:\/\/example\.com\/a">說明<\/a>/);
});

test('a remote picture becomes a note; one already carried as data is drawn', () => {
  /* The print document is served under `img-src data:` so that a document on
     its way to becoming a PDF cannot reach the network. A remote <img> would
     be a broken-image box, which is worse than saying what was there. */
  const remote = html([{ type: 'para', text: '![風景](https://example.com/p.jpg)' }]);
  assert.match(remote, /<span class="pr-img">［圖片：風景］<\/span>/);
  assert.doesNotMatch(remote, /<img/, 'nothing that would send a request');

  const inlineImg = html([{ type: 'para', text: '![x](data:image/png;base64,AAAA)' }]);
  assert.match(inlineImg, /<img src="data:image\/png;base64,AAAA" alt="x">/);
});

test('a picture the caller fetched is drawn; the rule is bytes-in-hand, not data:', () => {
  /* The placeholder above is not a policy against pictures -- it is what an
     unfetchable picture looks like. Hand the same block list the bytes and the
     same URL becomes an <img>, with the CSP untouched: what reaches the print
     window is still a data: URI and still names no address. */
  const blocks = [{ type: 'para', text: '![風景](https://example.com/p.jpg)' }];
  const carried = html(blocks, {
    images: { 'https://example.com/p.jpg': 'data:image/jpeg;base64,BBBB' }
  });
  assert.match(carried, /<img src="data:image\/jpeg;base64,BBBB" alt="風景">/);
  assert.doesNotMatch(carried, /https:\/\/example\.com/,
    'the remote address does not survive into the print document');

  /* A map that does not have this picture in it changes nothing. */
  const other = html(blocks, { images: { 'https://example.com/somethingelse.jpg': 'data:image/png;base64,CC' } });
  assert.match(other, /<span class="pr-img">［圖片：風景］<\/span>/);
  assert.doesNotMatch(other, /<img/);
});

test('a fetched picture is matched by the whole URL, not by a prefix of it', () => {
  /* The key is the URL as the extractor emitted it. A lookup that matched
     loosely would let one picture stand in for another on any site that puts
     the real address in a query string. */
  const html1 = html([{ type: 'para', text: '![a](https://cdn.example.com/i?id=1)' }], {
    images: { 'https://cdn.example.com/i?id=2': 'data:image/png;base64,DD' }
  });
  assert.doesNotMatch(html1, /<img/);
  assert.match(html1, /［圖片：a］/);
});

test('page content is escaped, not rendered', () => {
  /* It is a stranger's text all the way to the file. The offscreen window runs
     no script, which is the second line -- this is the first. */
  const out = html([{ type: 'para', text: '<script>alert(1)</script> & <b>bold</b>' }]);
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&amp;/);
  assert.match(out, /&lt;b&gt;bold&lt;\/b&gt;/, 'the page\'s own tags are text, not markup');
});

test('emphasis inside a code span stays literal', () => {
  const out = html([{ type: 'para', text: 'try `a *b* c` here' }]);
  assert.match(out, /<code>a \*b\* c<\/code>/, 'a code span is not scanned again for emphasis');
  assert.doesNotMatch(out, /<code>[^<]*<em>/);
});

test('bold, italic and strikethrough all render', () => {
  const out = html([{ type: 'para', text: '**粗** *斜* ~~刪~~' }]);
  assert.match(out, /<strong>粗<\/strong>/);
  assert.match(out, /<em>斜<\/em>/);
  assert.match(out, /<s>刪<\/s>/);
});

test('a page break is a break, and an empty block list is empty', () => {
  assert.match(html([{ type: 'break' }]), /class="pr-page-break"/);
  assert.equal(html([]), '');
  assert.equal(html(null), '');
});

/* ------------------------------------------------------------- the wiring */

test('all three formats are rendered from one extraction', () => {
  /* The claim the design rests on. Three converters reading the page three
     times is how the Word file and the PDF start disagreeing about what was
     on it. */
  const app = read('renderer/apps/browser.js');
  const at = app.indexOf('async function exportPage');
  assert.ok(at > 0, 'the export function exists');
  const body = app.slice(at, app.indexOf('\n      /** Pull the live view', at));

  assert.match(body, /var md = withProvenance\(art\);/, 'one Markdown string');
  assert.match(body, /A\.office\.convert\('md->blocks', md\)/,
    'and the same conversion for both binary formats');
  assert.match(body, /AIOS\.printing\.blocksHtml\(conv\.data[,)]/,
    'the PDF is rendered from those blocks, not from a second reading');
  assert.match(body, /A\.office\.writeDocx\(target, conv\.data/, 'and so is the Word file');

  /* The pictures ride alongside as a map rather than being substituted into
     `md`. Base64 in the Markdown would reach the Word file as several hundred
     kilobytes of visible text, because writeDocx has no picture to make of it. */
  assert.match(body, /blocksHtml\(conv\.data, \{ images: pics\.images \}\)/,
    'the pictures are passed beside the blocks');
  assert.doesNotMatch(body, /md\s*=\s*md\.replace/, 'and never written into the Markdown');

  /* A file being made, not copied: `saveAsPath` otherwise suggests 「… 副本」,
     which is a wrong name to hand someone for a page they just saved. */
  assert.match(body, /fresh: true/, 'the save dialog knows this file is new');
  assert.match(body, /safeName\(art\.title\)/, 'a page title is not a filename');
});

test('the save dialog only suggests a copy when there is something to copy', () => {
  const src = read('renderer/surfaces.js');
  const at = src.indexOf('AIOS.saveAsPath = async function');
  const body = src.slice(at, src.indexOf('var answer = await AIOS.prompt', at));
  assert.match(body, /o\.fresh \? name/, 'a fresh file keeps the name it was given');
  assert.match(body, /' 副本'/, 'and a copy is still suggested for everything else');
});
