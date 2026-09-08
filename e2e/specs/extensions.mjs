/* Browser extensions: the page goes out as data, changes come back as data.

   The two examples the feature was asked for -- translate a page, save it as a
   PDF -- are both exercised here, with a real page loaded in a real tab. */

import assert from 'node:assert/strict';
import http from 'node:http';
import { run, until, sleep } from '../lib/cdp.mjs';

export const name = '瀏覽器擴充功能';

const HTML = '<!doctype html><meta charset="utf-8"><title>E2E 測試頁</title>' +
  '<h1>Hello</h1><p>First paragraph.</p><p>Second paragraph.</p>' +
  '<script>window.__marker = "untouched";</script>' +
  '<style>body{color:#000}</style>';

/* Served over loopback rather than from a `data:` URL.
   The browser refuses `data:` and treats it as a search term instead -- which
   is correct, and something this suite found by trying: a stored or typed
   `data:` URL is a page somebody else composed. A local server keeps the test
   offline and deterministic without asking the product to relax that. */
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() });
    });
  });
}

export async function spec(t, app) {
  const { cdp } = app;
  const site = await serve();

  const ready = await run(cdp, `
    var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
    if (!inst) { await AIOS.apps.launch('browser'); await new Promise(function (r) { setTimeout(r, 900); }); }
    inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
    if (!inst) return false;
    await inst.ctx.api.navigate(${JSON.stringify(site.url)});
    return true;
  `, { timeout: 60000 });
  assert.ok(ready, '開不起瀏覽器');

  // Navigation is asynchronous; wait for the tab to actually hold the page.
  await until(() => run(cdp, `
    var id = AIOS.browserTab();
    if (!id) return false;
    var r = await window.aios.browser.pageNodes(id, 50);
    return r.ok && r.data.nodes.length >= 3;
  `), { timeout: 30000, what: '測試頁載入' });

  await t.test('頁面以「編號的文字節點」交出去，不含 script 與 style', async () => {
    const r = await run(cdp, `
      var id = AIOS.browserTab();
      var res = await window.aios.browser.pageNodes(id, 200);
      return { ok: res.ok, title: res.data.title, nodes: res.data.nodes };
    `);
    assert.ok(r.ok, '讀不到頁面節點');
    const texts = r.nodes.map((n) => n.text);
    assert.ok(texts.includes('Hello'), '缺少標題文字：' + JSON.stringify(texts));
    assert.ok(texts.some((x) => x.includes('First paragraph')), '缺少段落');
    /* Script and style text is not page content. Handing it over would let an
       extension rewrite the page's own code. */
    assert.ok(!texts.some((x) => x.includes('__marker')), 'script 的內容不該被交出去');
    assert.ok(!texts.some((x) => x.includes('color:#000')), 'style 的內容不該被交出去');
    for (const n of r.nodes) {
      assert.equal(typeof n.node, 'number', '每個節點都要有編號');
    }
  });

  await t.test('回傳的修改會套用，而且只換文字', async () => {
    const r = await run(cdp, `
      var id = AIOS.browserTab();
      var before = await window.aios.browser.pageNodes(id, 200);
      var target = before.data.nodes.filter(function (n) { return n.text === 'Hello'; })[0];

      // What a translation extension would send back.
      var applied = await window.aios.browser.applyToPage(id, [
        { node: target.node, text: '你好' },
        // Markup in the string must land as text, not as elements.
        { node: target.node + 1, text: '<b>粗體</b>與 <script>alert(1)</script>' }
      ]);

      var after = await window.aios.browser.pageNodes(id, 200);
      return {
        applied: applied.ok && applied.data.applied,
        texts: after.data.nodes.map(function (n) { return n.text; })
      };
    `);
    assert.equal(r.applied, 2, '套用的筆數不對：' + r.applied);
    assert.ok(r.texts.includes('你好'), '文字沒有換成功：' + JSON.stringify(r.texts));
    /* The markup came back as text. If it had been parsed there would be a
       <b> element and the string would no longer contain the angle brackets. */
    assert.ok(r.texts.some((x) => x.includes('<b>粗體</b>')),
      'HTML 應該被當成文字，而不是被解析：' + JSON.stringify(r.texts));
  });

  await t.test('超出範圍或格式不對的修改會被丟掉，不會壞掉', async () => {
    const r = await run(cdp, `
      var id = AIOS.browserTab();
      var res = await window.aios.browser.applyToPage(id, [
        { node: 99999, text: '不存在的節點' },
        { node: -1, text: '負數' },
        { node: 'zero', text: '不是數字' },
        { node: 0 },
        { text: '沒有 node' },
        null
      ]);
      return { ok: res.ok, applied: res.data && res.data.applied, skipped: res.data && res.data.skipped };
    `);
    assert.ok(r.ok, '格式不對的輸入不該讓整個呼叫失敗');
    assert.equal(r.applied, 0, '不該有任何修改被套用');
  });

  await t.test('存成 PDF：檔案真的出現在沙箱裡', async () => {
    const r = await run(cdp, `
      var id = AIOS.browserTab();
      var res = await window.aios.browser.toPdf(id, '/downloads/e2e-page.pdf');
      if (!res.ok) return { error: res.error };
      var read = await window.aios.fs.list('/downloads');
      var hit = read.ok && read.data.entries.filter(function (e) { return e.name === 'e2e-page.pdf'; })[0];
      return { vpath: res.data.vpath, bytes: hit ? hit.bytes : 0 };
    `, { timeout: 60000 });
    assert.ok(!r.error, '轉 PDF 失敗：' + r.error);
    assert.equal(r.vpath, '/downloads/e2e-page.pdf');
    assert.ok(r.bytes > 500, 'PDF 太小，可能是空的：' + r.bytes);
  });

  await t.test('擴充功能宣告 page 能力時，安裝前會被問過', async () => {
    /* `page` reaches outside the program's own sandbox -- it reads and rewrites
       whatever the user is looking at -- so it has to be on the list that stops
       an install to ask. */
    const r = await run(cdp, `
      var caps = (await window.aios.sysInfo()).data.appCapsNeedingConsent || [];
      return caps;
    `);
    assert.ok(r.includes('page'),
      'page 沒有被列為需要授權的能力，擴充功能會靜默安裝：' + r.join('、'));
  });

  await t.test('冒煙閘門會用假頁面測擴充功能，不會碰到真的分頁', async () => {
    /* A program is smoke-tested before it is trusted, so pressing the buttons of
       an unapproved extension must not reach a real tab -- and must not rewrite
       one. The stub answers with a fixture and applies nothing. */
    const r = await run(cdp, `
      var before = await window.aios.browser.pageNodes(AIOS.browserTab(), 200);
      var code = [
        'function render(root, os) {',
        '  var b = document.createElement("button");',
        '  b.textContent = "翻譯";',
        '  b.addEventListener("click", async function () {',
        '    var page = await os.page.read(50);',
        '    var ops = page.nodes.map(function (n) { return { node: n.node, text: "改過了" }; });',
        '    var out = await os.page.apply(ops);',
        '    root.appendChild(document.createTextNode("套用 " + out.applied));',
        '  });',
        '  root.appendChild(b);',
        '}'
      ].join(String.fromCharCode(10));

      var problems = await AIOS.appshell.smokeTest(code, ['page']);
      var after = await window.aios.browser.pageNodes(AIOS.browserTab(), 200);
      return {
        problems: problems,
        pageUnchanged: JSON.stringify(before.data.nodes) === JSON.stringify(after.data.nodes)
      };
    `, { timeout: 90000 });
    assert.deepEqual(r.problems, [], '合法的擴充功能被冒煙閘門擋下了：' + r.problems.join('；'));
    assert.equal(r.pageUnchanged, true,
      '冒煙測試改到了真正的分頁 — 未核准的程式不該碰得到它');
  });

  await t.test('裝好的擴充功能真的能讀頁面、改頁面', async () => {
    /* The whole runtime path, through the real broker rather than the stub:
       install, launch, press the button, look at the page.

       Installed through the model's own channel (`forge:install`, gated on
       `app.create`) rather than the gesture one, which opens a native dialog a
       test cannot answer. */
    const r = await run(cdp, `
      var code = [
        'function render(root, os) {',
        '  var out = document.createElement("p");',
        '  out.id = "out";',
        '  out.textContent = "尚未執行";',
        '  var b = document.createElement("button");',
        '  b.id = "go";',
        '  b.textContent = "翻譯";',
        '  b.addEventListener("click", async function () {',
        '    try {',
        '      var page = await os.page.read(200);',
        '      var ops = [];',
        '      for (var i = 0; i < page.nodes.length; i++) {',
        '        var n = page.nodes[i];',
        '        if (/^[A-Za-z][A-Za-z .!?,\\\\-]*$/.test(n.text)) {',
        '          ops.push({ node: n.node, text: "【" + n.text + "】" });',
        '        }',
        '      }',
        '      var res = await os.page.apply(ops);',
        '      out.textContent = "OK:" + res.applied;',
        '    } catch (e) { out.textContent = "ERR:" + (e && e.message); }',
        '  });',
        '  root.appendChild(b); root.appendChild(out);',
        '}'
      ].join(String.fromCharCode(10));

      var inst = await window.aios.forge.install({
        slug: 'e2e-page-ext', name: 'E2E 頁面擴充', purpose: '測試 page 能力',
        icon: '◈', code: code, capabilities: ['page'],
        prompt: 'e2e', note: 'e2e', author: 'model'
      });
      if (!inst.ok) return { installError: inst.error };

      AIOS.forge.registerGenerated({ id: 'e2e-page-ext', name: 'E2E 頁面擴充', icon: '◈', purpose: '測試' });
      await AIOS.apps.launch('gen:e2e-page-ext');
      await new Promise(function (r2) { setTimeout(r2, 2500); });
      return { installed: true };
    `, { timeout: 90000 });
    assert.ok(!r.installError, '安裝失敗：' + r.installError);

    /* The extension runs in a frame of its own, so its button is pressed from
       inside that frame -- the shell cannot reach an opaque origin's DOM. */
    const pressed = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${app.port}/json/list`)).json();
      for (const target of list.filter((x) => x.type === 'iframe')) {
        const { connect, evaluate } = await import('../lib/cdp.mjs');
        const f = await connect(target.webSocketDebuggerUrl);
        try {
          const hit = await evaluate(f, 'document.getElementById("go") ? "yes" : "no"');
          if (hit === 'yes') {
            await evaluate(f, 'document.getElementById("go").click(), 1');
            await new Promise((r2) => setTimeout(r2, 2500));
            const out = await evaluate(f, 'document.getElementById("out").textContent');
            f.close();
            return out;
          }
        } catch (e) { /* not this frame */ }
        f.close();
      }
      return null;
    }, { timeout: 30000, what: '擴充功能的視窗出現' });

    assert.match(pressed, /^OK:\d+$/, '擴充功能執行失敗：' + pressed);
    assert.notEqual(pressed, 'OK:0', '沒有任何節點被改到，等於沒測到');

    const after = await run(cdp, `
      var res = await window.aios.browser.pageNodes(AIOS.browserTab(), 200);
      return res.data.nodes.map(function (n) { return n.text; });
    `);
    assert.ok(after.some((x) => x.startsWith('【')),
      '頁面上看不到擴充功能改過的痕跡：' + JSON.stringify(after.slice(0, 6)));
  });

  await sleep(200);

  /* Point the browser away from the server before killing it.

     A browser window remembers its URL and reopens it at boot. This spec's
     server lives for the length of one run, so leaving the window on it wrote a
     dead loopback address into the session -- and every launch afterwards opened
     with a red 「載入失敗：ERR_CONNECTION_REFUSED」 that named no URL. The
     product side of that is fixed (a restore that fails is not retried, and the
     message says which page), but a test should not dirty the machine it ran on
     in the first place. */
  await run(cdp, `
    var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
    if (inst) AIOS.wm.close(inst.win);
    await new Promise(function (r) { setTimeout(r, 300); });
    return true;
  `).catch(() => {});

  site.close();
}
