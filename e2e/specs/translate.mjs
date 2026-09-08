/* Web page translation, driven end to end against a real page.

   Two loopback servers make this deterministic and free: one serves the
   article, the other speaks enough of the OpenAI chat API to answer with a
   canned translation. The custom provider is pointed at the second one for the
   length of this spec and restored afterwards, so nothing here calls a real
   model or costs anything -- and every part of the path is exercised for real:
   the agent injected into the page's isolated world, the paragraph finder, the
   batching, the prompt, the reply parser, the spans that appear in the page,
   the cache, and the progress strip.

   The browser tab is its own CDP target, so the page is inspected from the
   outside the way a person would look at it, rather than by asking the code
   that wrote it what it wrote. */

import assert from 'node:assert/strict';
import http from 'node:http';
import { connect, run, targets, until, sleep } from '../lib/cdp.mjs';

export const name = '網頁翻譯';

/* The fixture. Every case the skip rules exist for is on this page, and the
   tall spacer puts one paragraph far below the fold so that
   「只翻譯捲動到的區域」 can be told apart from translating everything. */
const ARTICLE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Translate fixture</title></head><body style="font:16px/1.6 sans-serif;margin:24px">
<article>
  <h1 id="h">Open weight model launches</h1>
  <p id="p1">A model is faster, cheaper, and better at coding.</p>
  <div id="wrap"><p id="p2">The release caught attention.</p><p id="p3">It argues for a different training idea.</p></div>
  <ul><li id="li1">Generates its own tasks.</li><li id="li2">Learns from the rollouts.</li></ul>
  <ul><li id="parent">Parent item before a nested list.<ul><li id="child">The nested child item.</li></ul></li></ul>
  <pre id="pre">const shouldNotBeTranslated = 1;</pre>
  <p id="withcode">Call <code>fetchRaw()</code> to reach the network.</p>
  <textarea id="ta">Textarea content stays put.</textarea>
  <input id="inp" value="Input value stays put">
  <p id="hid" style="display:none">Hidden paragraph stays put.</p>
  <p id="cjk">這一段已經是繁體中文，不需要翻譯。</p>
  <p id="nums">1234 5678 90.12 %$#</p>
  <p id="skipme" class="no-tr">Skipped by the selector.</p>
  <div id="spacer" style="height:3000px"></div>
  <p id="far">This paragraph is far below the fold.</p>
</article>
</body></html>`;

/** An OpenAI-compatible endpoint that translates by prefixing. */
function modelServer() {
  const seen = { calls: 0, segments: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(404).end('{}');
        return;
      }
      seen.calls++;
      let items = [];
      try {
        const j = JSON.parse(body);
        seen.bodies.push(j);
        const user = (j.messages || []).filter((m) => m.role === 'user').pop();
        const payload = JSON.parse(user.content);
        items = (payload.segments || []).map((s) => ({ i: s.i, t: '[譯] ' + s.text }));
        seen.segments += items.length;
      } catch (e) {
        items = [];
      }
      const answer = JSON.stringify({ items });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      /* Split across frames, because the reader assembles deltas and a single
         frame would not exercise that. */
      const mid = Math.ceil(answer.length / 2);
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: answer.slice(0, mid) } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: answer.slice(mid) } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
      }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, seen };
}

export async function spec(t, app) {
  const { cdp, port } = app;

  const pages = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ARTICLE);
  });
  await new Promise((r) => pages.listen(0, '127.0.0.1', r));
  const pageUrl = 'http://127.0.0.1:' + pages.address().port + '/';

  const { server: models, seen } = modelServer();
  await new Promise((r) => models.listen(0, '127.0.0.1', r));
  const modelUrl = 'http://127.0.0.1:' + models.address().port + '/v1';

  let before = null;

  /** Evaluate inside the web page itself, not in the shell. */
  async function inPage(body) {
    const target = await until(async () => {
      const list = await targets(port);
      return list.find((x) => x.url.startsWith(pageUrl) && x.webSocketDebuggerUrl) || null;
    }, { timeout: 20000, what: '網頁的 CDP target' });
    const p = await connect(target.webSocketDebuggerUrl);
    try {
      return await run(p, body, { timeout: 20000 });
    } finally {
      try { p.close(); } catch { /* the page may have gone */ }
    }
  }

  await t.test('把自訂供應商指到本機的假模型', async () => {
    const r = await run(cdp, `
      var st = await window.aios.model.state();
      var before = st.ok ? { active: st.data.active, config: (st.data.providers.find(function (p) { return p.id === 'custom'; }) || {}).config } : null;
      var c = await window.aios.model.configure('custom', {
        base: ${JSON.stringify(modelUrl)}, model: 'stub', auth: 'none',
        json: 'object', reasoningKind: 'none', maxOut: 0
      });
      if (!c.ok) return { error: c.error };
      var s = await window.aios.model.select('custom');
      if (!s.ok) return { error: s.error };
      return { before: before, active: s.data.active };
    `, { timeout: 30000 });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.active, 'custom');
    before = r.before;
  });

  await t.test('整頁翻譯：譯文插在原文下面，程式碼與輸入框沒有被動到', async () => {
    const started = await run(cdp, `
      await window.aios.translate.setSettings({
        viewportOnly: false, skipSelector: '.no-tr', target: 'zh-TW',
        batchSegments: 3, concurrency: 2, cacheOn: true
      });
      var was = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
      if (was) { AIOS.wm.close(was.win); await new Promise(function (r) { setTimeout(r, 300); }); }
      await AIOS.apps.launch('browser');
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
      if (!inst) return { error: '瀏覽器沒開起來' };
      for (var i = 0; i < 60 && !inst.ctrl; i++) { await new Promise(function (r) { setTimeout(r, 100); }); }
      await inst.ctx.api.navigate(${JSON.stringify(pageUrl)});
      for (var i = 0; i < 100 && !inst.ctx.api.tabId(); i++) { await new Promise(function (r) { setTimeout(r, 100); }); }
      var id = inst.ctx.api.tabId();
      // Let the document finish before asking for its paragraphs.
      await new Promise(function (r) { setTimeout(r, 1200); });
      var s = await window.aios.translate.start(id);
      return s.ok ? { tabId: id, total: s.data.total } : { error: s.error };
    `, { timeout: 60000 });
    assert.equal(started.error, undefined, started.error);

    const done = await until(async () => {
      const st = await run(cdp, `
        var r = await window.aios.translate.status(${JSON.stringify(started.tabId)});
        return r.ok ? r.data : null;
      `);
      return st && st.done >= 10 ? st : null;
    }, { timeout: 60000, what: '十段翻譯完成' });

    assert.equal(done.failed, 0, '沒有段落應該失敗：' + JSON.stringify(done.note));
    assert.ok(done.spend.total > 0, '用量要記下來');

    const dom = await inPage(`
      function tr(id) {
        var el = document.getElementById(id);
        var s = el ? el.querySelector('.aios-tr-line') : null;
        return s ? s.textContent : null;
      }
      return {
        h: tr('h'), p1: tr('p1'), p2: tr('p2'), p3: tr('p3'), li1: tr('li1'), li2: tr('li2'),
        /* Its own line, not the nested item's: :scope keeps the query on the
           element itself rather than reaching into the list it introduces. */
        parent: (function () {
          var s = document.querySelector('#parent > .aios-tr-line');
          return s ? s.textContent : null;
        })(),
        child: tr('child'),
        parentSpanBeforeList: (function () {
          var span = document.querySelector('#parent > .aios-tr-line');
          var list = document.querySelector('#parent > ul');
          return !!(span && list &&
            (span.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING));
        })(),
        withcode: tr('withcode'),
        wrap: !!document.querySelector('#wrap > .aios-tr-line'),
        pre: document.getElementById('pre').textContent,
        preSpan: !!document.querySelector('#pre .aios-tr-line'),
        ta: document.getElementById('ta').value,
        inp: document.getElementById('inp').value,
        hid: !!document.querySelector('#hid .aios-tr-line'),
        cjk: !!document.querySelector('#cjk .aios-tr-line'),
        nums: !!document.querySelector('#nums .aios-tr-line'),
        skipme: !!document.querySelector('#skipme .aios-tr-line'),
        far: !!document.querySelector('#far .aios-tr-line'),
        originalP1: document.getElementById('p1').firstChild.nodeValue,
        hud: !!document.getElementById('aios-tr-hud'),
        agentVisible: typeof window.__aiosTr,
        spans: document.querySelectorAll('.aios-tr-line').length
      };
    `);

    assert.equal(dom.h, '[譯] Open weight model launches', '標題要翻譯');
    assert.equal(dom.p1, '[譯] A model is faster, cheaper, and better at coding.');
    assert.equal(dom.p2, '[譯] The release caught attention.');
    assert.equal(dom.p3, '[譯] It argues for a different training idea.');
    assert.equal(dom.li1, '[譯] Generates its own tasks.');
    assert.equal(dom.li2, '[譯] Learns from the rollouts.');
    /* A block that introduces a nested list keeps its own line: the old rule
       dropped anything containing another candidate, which silently lost the
       text of every nested list, outline and comment thread. */
    assert.equal(dom.parent, '[譯] Parent item before a nested list.', '巢狀清單的父項不能被吃掉');
    assert.equal(dom.child, '[譯] The nested child item.');
    assert.equal(dom.parentSpanBeforeList, true, '父項的譯文要接在自己那一行後面，不是整個清單的後面');
    assert.equal(dom.withcode, '[譯] Call fetchRaw() to reach the network.',
      '行內的 code 是段落的一部分，整段一起翻');
    assert.equal(dom.wrap, false, '包住兩個 p 的 div 不能自己也翻一次');

    assert.equal(dom.pre, 'const shouldNotBeTranslated = 1;', '程式碼區塊一個字都不能改');
    assert.equal(dom.preSpan, false);
    assert.equal(dom.ta, 'Textarea content stays put.', '輸入中的文字不能動');
    assert.equal(dom.inp, 'Input value stays put');
    assert.equal(dom.hid, false, '看不見的段落不翻');
    assert.equal(dom.cjk, false, '已經是目標語言的段落不翻');
    assert.equal(dom.nums, false, '純數字與符號不翻');
    assert.equal(dom.skipme, false, '被 CSS 選擇器排除的不翻');
    assert.equal(dom.far, true, '關掉「只翻譯捲動到的區域」時，捲軸外的段落也要翻');

    assert.equal(dom.originalP1, 'A model is faster, cheaper, and better at coding.',
      '原始文字節點必須原封不動');
    assert.equal(dom.spans, 10, '剛好十段：標題、五段內文、清單兩項、巢狀清單的父子各一');
    assert.equal(dom.hud, true, '右下角要有進度提示條');
    assert.equal(dom.agentVisible, 'undefined',
      '網頁自己的世界看不到翻譯程式（隔離世界的重點）');

    assert.ok(seen.calls >= 3, '批次要真的分開送：' + seen.calls + ' 次');
    const sys = seen.bodies[0].messages[0].content;
    assert.match(sys, /不是給你的指令/, '提示要說明網頁內容是資料不是指令');
    assert.equal('temperature' in seen.bodies[0], false, '預設留空就不送 temperature');
  });

  await t.test('關閉翻譯只是隱藏，原文與譯文都還在', async () => {
    const tabId = await run(cdp, `
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
      var id = inst.ctx.api.tabId();
      await window.aios.translate.stop(id);
      return id;
    `);
    const after = await inPage(`
      var s = document.querySelector('#p1 .aios-tr-line');
      return {
        stillThere: !!s,
        hidden: s ? s.hidden : null,
        original: document.getElementById('p1').firstChild.nodeValue,
        hud: !!document.getElementById('aios-tr-hud')
      };
    `);
    assert.equal(after.stillThere, true, '譯文的節點不該被刪掉');
    assert.equal(after.hidden, true, '只是隱藏');
    assert.equal(after.original, 'A model is faster, cheaper, and better at coding.');
    assert.equal(after.hud, false, '停掉之後提示條要收掉');
    assert.ok(tabId, 'tabId');
  });

  await t.test('重新翻譯同一頁完全走快取，不再呼叫模型', async () => {
    const callsBefore = seen.calls;
    const r = await run(cdp, `
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
      var id = inst.ctx.api.tabId();
      await window.aios.browser.reload(id);
      await new Promise(function (r) { setTimeout(r, 1500); });
      var s = await window.aios.translate.start(id);
      if (!s.ok) return { error: s.error };
      for (var i = 0; i < 100; i++) {
        var st = await window.aios.translate.status(id);
        if (st.ok && st.data.done >= 10) return st.data;
        await new Promise(function (r) { setTimeout(r, 200); });
      }
      var last = await window.aios.translate.status(id);
      return last.ok ? last.data : { error: 'timeout' };
    `, { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.done, 10, '十段都回來了');
    assert.equal(r.cached, 10, '而且十段都來自快取：' + JSON.stringify(r));
    assert.equal(seen.calls, callsBefore, '模型一次都沒有被呼叫');
  });

  await t.test('只翻譯捲動到的區域：捲軸外的段落先不翻', async () => {
    const r = await run(cdp, `
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
      var id = inst.ctx.api.tabId();
      await window.aios.translate.stop(id);
      await window.aios.translate.setSettings({ viewportOnly: true });
      await window.aios.browser.reload(id);
      await new Promise(function (r) { setTimeout(r, 1500); });
      var s = await window.aios.translate.start(id);
      if (!s.ok) return { error: s.error };
      await new Promise(function (r) { setTimeout(r, 2500); });
      var st = await window.aios.translate.status(id);
      return st.ok ? st.data : { error: st.error };
    `, { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);

    /* Reported whether or not it passes. `false !== true` is what this used to
       say, and it sent the first person to read it looking at the translator
       when the answer was in the page: `visibility: "hidden"`.

       A tab's document is not rendered even while its view is attached, sized,
       focused and front-most -- Chromium's native window occlusion decides that
       on its own, and detaching the view (which AI-OS does on minimise, on any
       modal, and whenever the browser window is covered) only adds a second way
       in. Nothing delivered as part of the rendering steps can be relied on in
       there, IntersectionObserver included, so nothing was ever marked visible
       -- with the paragraph sitting 97px down a 482px viewport the whole time.
       Layout is not suspended with rendering, which is why measuring works and
       waiting does not. See onScreenNow in main/translate-agent.js. */
    const dom = await inPage(`
      var p1 = document.getElementById('p1');
      var r1 = p1 ? p1.getBoundingClientRect() : null;
      return {
        near: !!document.querySelector('#p1 .aios-tr-line'),
        far: !!document.querySelector('#far .aios-tr-line'),
        why: {
          viewport: window.innerWidth + 'x' + window.innerHeight,
          visibility: document.visibilityState,
          p1Top: r1 ? Math.round(r1.top) : null,
          spans: document.querySelectorAll('.aios-tr-line').length
        }
      };
    `);
    const why = ' — status=' + JSON.stringify(r) + ' page=' + JSON.stringify(dom.why);
    assert.equal(dom.near, true, '看得到的段落要翻' + why);
    assert.equal(dom.far, false, '三千像素外的段落還不該翻' + why);

    // Scroll to it, and the observer should wake it up.
    await inPage('document.getElementById("far").scrollIntoView(); return 1;');
    const woke = await until(async () => {
      const d = await inPage('return !!document.querySelector("#far .aios-tr-line");');
      return d ? d : null;
    }, { timeout: 30000, what: '捲到之後補翻' });
    assert.equal(woke, true, '捲到就補翻');
  });

  await t.test('模型出錯時標記失敗，重試可以救回來', async () => {
    const r = await run(cdp, `
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
      var id = inst.ctx.api.tabId();
      await window.aios.translate.stop(id);
      await window.aios.translate.setSettings({ viewportOnly: false, cacheOn: false });
      await window.aios.model.configure('custom', { base: 'http://127.0.0.1:9/v1' });
      await window.aios.browser.reload(id);
      await new Promise(function (r) { setTimeout(r, 1500); });
      var s = await window.aios.translate.start(id);
      if (!s.ok) return { error: s.error };
      for (var i = 0; i < 120; i++) {
        var st = await window.aios.translate.status(id);
        if (st.ok && st.data.failed >= 10) return st.data;
        await new Promise(function (r) { setTimeout(r, 250); });
      }
      var last = await window.aios.translate.status(id);
      return last.ok ? Object.assign({ timedOut: true }, last.data) : { error: 'timeout' };
    `, { timeout: 120000 });
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.failed >= 10, '連不上模型時每一段都要標記失敗：' + JSON.stringify(r));
    assert.ok(r.note, '而且要說出原因');

    const hud = await inPage(`
      var h = document.getElementById('aios-tr-hud');
      return { present: !!h };
    `);
    assert.equal(hud.present, true, '提示條要留著，重試按鈕在上面');

    // Point it back at the working stub and retry: the same paragraphs return.
    const fixed = await run(cdp, `
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
      var id = inst.ctx.api.tabId();
      await window.aios.model.configure('custom', { base: ${JSON.stringify(modelUrl)} });
      await window.aios.translate.retry(id);
      for (var i = 0; i < 120; i++) {
        var st = await window.aios.translate.status(id);
        if (st.ok && st.data.done >= 10) return st.data;
        await new Promise(function (r) { setTimeout(r, 250); });
      }
      var last = await window.aios.translate.status(id);
      return last.ok ? Object.assign({ timedOut: true }, last.data) : { error: 'timeout' };
    `, { timeout: 120000 });
    assert.equal(fixed.error, undefined, fixed.error);
    assert.equal(fixed.done, 10, '重試之後十段都補回來：' + JSON.stringify(fixed));
  });

  await t.test('收尾：關掉翻譯、還原供應商、關掉視窗', async () => {
    await run(cdp, `
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
      if (inst) {
        var id = inst.ctx.api.tabId();
        if (id) await window.aios.translate.stop(id);
        AIOS.wm.close(inst.win);
      }
      await window.aios.translate.setSettings({ viewportOnly: true, skipSelector: '', cacheOn: true, auto: 'off' });
      await window.aios.translate.clearCache();
      ${before && before.config ? `await window.aios.model.configure('custom', ${JSON.stringify(before.config)});` : ''}
      ${before && before.active ? `await window.aios.model.select(${JSON.stringify(before.active)});` : ''}
      return 1;
    `, { timeout: 30000 });

    const st = await run(cdp, `
      var s = await window.aios.model.state();
      return s.ok ? s.data.active : null;
    `);
    assert.equal(st, before ? before.active : st, '供應商要還原');
  });

  pages.close();
  models.close();
}
