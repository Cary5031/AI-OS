/* Turning a web page into a document.

   The unit tests read the extraction agent and execute the HTML renderer. This
   is the half neither of them can reach: the agent running inside a real
   Chromium view, against a page built to look like every page -- an article
   wrapped in navigation, a sidebar, an advertisement, a footer, and one block
   the page renders and then hides.

   The page is served from this process rather than fetched, so the suite still
   needs no network and the expected output is written next to the input. */

import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../lib/cdp.mjs';

export const name = '網頁轉存';

const PAGE = `<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>測試文章 - 某某新聞網</title>
<meta name="author" content="記者甲">
<style>.gone { display: none; }</style>
</head><body>
<header id="masthead"><h1>某某新聞網</h1></header>
<nav class="navbar"><a href="/a">首頁導覽甲</a> <a href="/b">首頁導覽乙</a></nav>
<div class="ad-banner">買一送一限時特價</div>
<div class="gradient-box">漸層裝飾區塊的文字</div>
<main>
  <article>
    <h1>颱風假的判斷標準</h1>
    <p>第一段<strong>粗體</strong>與<em>斜體</em>，還有一個<a href="/rule">連結</a>。</p>
    <div class="gone">這段被頁面自己藏起來了</div>
    <h2>判斷依據</h2>
    <ul><li>風速</li><li>雨量</li></ul>
    <ol><li>第一步</li><li>第二步</li></ol>
    <blockquote>引用一段規定。</blockquote>
    <pre><code class="language-js">const x = 1;</code></pre>
    <table><tr><th>縣市</th><th>結果</th></tr><tr><td>臺北</td><td>停班</td></tr></table>
    <p>行內程式碼 <code>getComputedStyle()</code> 與圖片：</p>
    <img src="/pic.png" alt="風力圖">
  </article>
  <aside class="sidebar"><h3>相關報導</h3><p>側欄的相關報導內容</p></aside>
</main>
<div class="comments"><p>留言區的留言</p></div>
<footer><p>版權所有</p></footer>
</body></html>`;

/* A real PNG, so /pic.png is a picture rather than the HTML page under another
   name: the export sniffs the magic bytes and refuses anything that is not
   actually an image, so serving HTML here would exercise the refusal path and
   quietly stop exercising the carrying path.

   64x64 and not smaller. The extractor treats anything two pixels or less as a
   tracking pixel and drops it before it is even counted -- which is correct, and
   is exactly what a 2x2 fixture ran into. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAAAAACPAi4CAAAAKUlEQVR42u3MQREAAAwCIKMb3R' +
  'D77SAA6VEEAoFAIBAIBAKBQCAQfA8G320AeXC6efoAAAAASUVORK5CYII=', 'base64');

export async function spec(t, app) {
  const { cdp } = app;

  const pages = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/pic.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => pages.listen(0, '127.0.0.1', r));
  const pageUrl = 'http://127.0.0.1:' + pages.address().port + '/';

  const stamp = Date.now();

  await t.test('只有正文被抓出來，導覽列、廣告、側欄、頁尾都不見', async () => {
    const r = await run(cdp, `
      AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })
        .forEach(function (i) { AIOS.wm.close(i.win); });
      await new Promise(function (r) { setTimeout(r, 250); });

      await AIOS.apps.launch('browser', ${JSON.stringify(pageUrl)});
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; }).pop();
      if (!inst) return { error: '瀏覽器沒開起來' };
      for (var i = 0; i < 60 && !inst.ctrl; i++) await new Promise(function (r) { setTimeout(r, 100); });
      await new Promise(function (r) { setTimeout(r, 2500); });

      var res = await window.aios.browser.article(inst.ctx.api.tabId());
      if (!res.ok) return { error: res.error };
      return { md: res.data.markdown, title: res.data.title, how: res.data.how,
               byline: res.data.byline, images: res.data.images };
    `, { timeout: 90000 });

    assert.equal(r.error, undefined, r.error);

    /* What must be there. */
    assert.match(r.md, /^## 判斷依據$/m, '標題層級要留著');
    assert.match(r.md, /\*\*粗體\*\*/, '粗體');
    assert.match(r.md, /\*斜體\*/, '斜體');
    assert.match(r.md, /\[連結\]\(http:\/\/127\.0\.0\.1:\d+\/rule\)/, '連結要變成絕對網址');
    assert.match(r.md, /^- 風速$/m, '項目符號清單');
    assert.match(r.md, /^1\. 第一步$/m, '編號清單');
    assert.match(r.md, /^> 引用一段規定。$/m, '引用');
    assert.match(r.md, /```js\nconst x = 1;\n```/, '程式碼區塊與語言標記');
    assert.match(r.md, /`getComputedStyle\(\)`/, '行內程式碼');
    assert.match(r.md, /\| 縣市 \| 結果 \|/, '表格標題列');
    assert.match(r.md, /\| 臺北 \| 停班 \|/, '表格內容');
    assert.match(r.md, /!\[風力圖\]\(http:\/\/127\.0\.0\.1:\d+\/pic\.png\)/, '圖片保留參照');

    /* What must not be. Each of these is a different way of being furniture. */
    for (const [what, needle] of [
      ['<nav> 的連結', '首頁導覽甲'],
      ['廣告區塊', '買一送一'],
      ['側欄', '側欄的相關報導內容'],
      ['留言區', '留言區的留言'],
      ['頁尾', '版權所有'],
      ['<header> 站名', '某某新聞網'],
      ['頁面自己藏起來的區塊', '這段被頁面自己藏起來了']
    ]) {
      assert.ok(!r.md.includes(needle), what + '不該被轉進去，但出現了：\n' + r.md);
    }

    /* Outside the article, so it goes -- but note which way it goes: it is
       dropped for being outside, never for having `ad` inside its class name. */
    assert.doesNotMatch(r.md, /漸層裝飾/, 'gradient-box 在 <article> 之外，不該被轉進來');

    assert.equal(r.title, '颱風假的判斷標準', '標題取自文章的 h1，不是站名');
    assert.equal(r.how, 'explicit', '<article> 標好了就該直接用，不必猜');
    assert.equal(r.byline, '記者甲');
    assert.equal(r.images, 1);

    /* The title is not repeated: it is the h1 and it is also `title`. */
    assert.doesNotMatch(r.md, /^# 颱風假的判斷標準/, '標題不該同時是內文的第一行');
  });

  await t.test('存成 Markdown：檔案裡有正文，也有來源網址', async () => {
    const target = '/notes/e2e-article-' + stamp + '.md';
    const r = await run(cdp, `
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; }).pop();
      var pending = inst.ctx.api.exportPage('md');

      for (var i = 0; i < 80 && !document.querySelector('.ui-prompt-input'); i++) {
        await new Promise(function (r) { setTimeout(r, 100); });
      }
      var inp = document.querySelector('.ui-prompt-input');
      if (!inp) return { error: '另存對話框沒有出現' };
      var suggested = inp.value;
      inp.value = ${JSON.stringify(target)};
      document.querySelector('.ui-prompt .fbtn-primary').click();

      var note = await pending;
      var file = await window.aios.fs.read(${JSON.stringify(target)});
      return { note: note, suggested: suggested, ok: file.ok, text: file.ok ? file.data.content : file.error };
    `, { timeout: 90000 });

    assert.equal(r.error, undefined, r.error);
    /* A page being saved has no original, so the dialog must not suggest 副本. */
    assert.ok(!/副本/.test(r.suggested), '新檔案不該被建議成「副本」：' + r.suggested);
    assert.match(r.suggested, /颱風假的判斷標準\.md$/, '檔名用頁面標題：' + r.suggested);

    assert.equal(r.ok, true, '檔案沒寫出來：' + r.text + '（轉存回報：' + r.note + '）');
    assert.match(r.text, /^# 颱風假的判斷標準$/m, '標題寫進檔案裡，實際開頭：' + JSON.stringify(r.text.slice(0, 160)));
    assert.match(r.text, /^> 來源：http:\/\/127\.0\.0\.1:\d+\/.*作者：記者甲$/m, '來源與作者');
    assert.match(r.text, /^## 判斷依據$/m);
    assert.ok(!r.text.includes('版權所有'), '頁尾還是不該在');
  });

  await t.test('存成 PDF 與 Word：都是真的檔案，都從同一份抽取來', async () => {
    const base = '/notes/e2e-article-' + stamp;
    const r = await run(cdp, `
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; }).pop();
      var out = {};

      async function saveAs(kind, target) {
        var pending = inst.ctx.api.exportPage(kind);
        for (var i = 0; i < 80 && !document.querySelector('.ui-prompt-input'); i++) {
          await new Promise(function (r) { setTimeout(r, 100); });
        }
        var inp = document.querySelector('.ui-prompt-input');
        if (!inp) return '另存對話框沒有出現';
        inp.value = target;
        document.querySelector('.ui-prompt .fbtn-primary').click();
        return await pending;
      }

      out.pdf = await saveAs('pdf', ${JSON.stringify(base + '.pdf')});
      out.docx = await saveAs('docx', ${JSON.stringify(base + '.docx')});

      /* The picture, fetched in main and handed back as bytes. Asserted here
         rather than only inside the PDF, because the PDF is binary and this is
         the value the renderer actually put into the print document. */
      var pics = await window.aios.browser.articleImages(inst.ctx.api.tabId());
      out.pics = pics.ok
        ? { got: pics.data.got, of: pics.data.of,
            png: Object.keys(pics.data.images).map(function (k) {
              /* indexOf, not a regex: this string is evaluated in the page,
                 and a slash inside a regex literal does not survive the trip. */
              return pics.data.images[k].indexOf('data:image/png;base64,') === 0;
            }) }
        : { error: pics.error };

      var list = await window.aios.fs.list('/notes');
      var byName = {};
      (list.ok ? list.data.entries : []).forEach(function (e) { byName[e.name] = e.bytes; });
      out.pdfBytes = byName['e2e-article-${stamp}.pdf'] || 0;
      out.names = Object.keys(byName).join('、');
      out.docxBytes = byName['e2e-article-${stamp}.docx'] || 0;

      /* A PDF holds NUL bytes, so the sandbox reports it as binary and hands
         back no text at all. That flag is the check: an error page written to
         disk under a .pdf name would come back as perfectly readable text. */
      var head = await window.aios.fs.read(${JSON.stringify(base + '.pdf')});
      out.pdfBinary = head.ok ? head.data.binary : ('讀不到：' + head.error);

      AIOS.wm.close(inst.win);
      return out;
    `, { timeout: 120000 });

    assert.equal(r.error, undefined, r.error);
    assert.match(String(r.pdf), /已存成/, 'PDF 轉存回報：' + r.pdf);
    assert.match(String(r.docx), /已存成/, 'Word 轉存回報：' + r.docx);
    assert.ok(r.pdfBytes > 1000, 'PDF 檔案太小，不像真的產出：' + r.pdfBytes + '（沙箱裡有：' + r.names + '）');
    assert.ok(r.docxBytes > 1000, 'docx 檔案太小：' + r.docxBytes);
    assert.equal(r.pdfBinary, true, 'PDF 應該是二進位檔；讀成純文字表示寫進去的不是 PDF：' + r.pdfBinary);

    /* The picture went out as bytes, not as a placeholder. The page and the
       picture share a host, which is the exemption that lets an export work on
       a page served from somewhere the SSRF screen would otherwise refuse --
       and it is the reason this fixture can test the carrying path at all. */
    assert.equal(r.pics.error, undefined, '抓圖失敗：' + r.pics.error);
    assert.equal(r.pics.of, 1, '這一頁只有一張圖');
    assert.equal(r.pics.got, 1, '那張圖應該被抓下來，實際：' + JSON.stringify(r.pics));
    assert.deepEqual(r.pics.png, [true], '抓回來的應該是 PNG 的 data: URI');
  });

  await t.test('首頁按鈕有個真的去處', async () => {
    /* Only that the channel answers with a page. Actually navigating there
       would put this suite on the network, which it is not. */
    const r = await run(cdp, `
      var res = await window.aios.browser.home();
      return { ok: res.ok, url: res.ok ? res.data.url : res.error };
    `);
    assert.equal(r.ok, true);
    assert.match(r.url, /^https:\/\//, '首頁要是一個真的網址，不是 about:blank：' + r.url);
  });

  await new Promise((r) => pages.close(r));
}
