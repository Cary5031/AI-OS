/* PDF to Excel and Word, and a scan read by the model.

   The unit tests prove the layout reader on pages made of numbers. This proves
   the rest of the road: a real Chromium PDF with a real bordered table goes in
   through the PDF app's own actions, the viewer frame draws it and reads its
   lines back, the main process writes an .xlsx and a .docx, and the files are
   read back through the office readers -- a different code path from the
   writers -- so a table that lost its borders or its merge on the way fails
   here.

   The OCR half runs against a fake OpenAI-compatible model on loopback that
   only answers when it is shown a picture: the request has to carry an
   image_url part with a JPEG in it, or the fake refuses. The app is pointed at
   it for the length of the spec and restored afterwards, so nothing here costs
   anything, and every part of the path is exercised for real: the scan with no
   text layer, the page drawn by the frame, the request shape, the reply kept
   beside the PDF, the second call that does not pay again, and the workbook
   built from what the model read. */

import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../lib/cdp.mjs';
import { pressConsent } from '../lib/dialog.mjs';

export const name = 'PDF 排成 Excel／Word，掃描頁由模型 OCR';

const SRC = '/notes/e2e-pdflayout.pdf';
const SCAN = '/notes/e2e-pdflayout-scan.pdf';
const OUT_X = '/notes/e2e-pdflayout.xlsx';
const OUT_D = '/notes/e2e-pdflayout.docx';
const OUT_SX = '/notes/e2e-pdflayout-scan.xlsx';

/* A bordered table, printed by the machine's own PDF export so the input is a
   real one. Inline borders: the print stylesheet draws table lines in a light
   grey that is deliberately faint, and a real document's lines are black. */
const TD = 'style="border:1px solid #000;padding:4px 6px"';
const HTML = `
<h1 style="font-size:22px">報價單 E2E</h1>
<p>客戶：LAYOUTMARK 有限公司</p>
<table style="border-collapse:collapse;width:80%">
  <tr><td colspan="3" ${TD}>九月報價</td></tr>
  <tr><td ${TD}>品名</td><td ${TD}>數量</td><td ${TD}>金額</td></tr>
  <tr><td ${TD}>螺絲 M6</td><td ${TD}>100</td><td ${TD}>1,200</td></tr>
  <tr><td ${TD}>墊片</td><td ${TD}>50</td><td ${TD}>300</td></tr>
</table>
<p>以上報價有效期限三十天。</p>`;

/* What the fake model "reads" off the scan. */
const READING = [
  '# 統一發票',
  '',
  '| 品名 | 數量 | 金額 |',
  '|---|---|---|',
  '| 螺絲 | 100 | 1,200 |',
  '| 墊片 | 50 | 300 |',
  '',
  '合計 1,500 元 SCANMARK'
].join('\n');

/** An OpenAI-compatible endpoint that transcribes only what it is shown. */
function visionServer() {
  const seen = { calls: 0, withPicture: 0, refused: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(404).end('{}');
        return;
      }
      seen.calls++;
      let picture = false;
      try {
        const j = JSON.parse(body);
        seen.bodies.push(j);
        const user = (j.messages || []).filter((m) => m.role === 'user').pop();
        const parts = Array.isArray(user && user.content) ? user.content : [];
        picture = parts.some((p) => p && p.type === 'image_url' &&
          /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{1000,}/.test(p.image_url && p.image_url.url));
      } catch (e) {
        picture = false;
      }
      if (!picture) {
        seen.refused++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'no image_url part in the request' } }));
        return;
      }
      seen.withPicture++;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      const mid = Math.ceil(READING.length / 2);
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: READING.slice(0, mid) } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: READING.slice(mid) } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 900, completion_tokens: 60, total_tokens: 960 }
      }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, seen };
}

export async function spec(t, app) {
  const { cdp } = app;

  /** Open a PDF in the PDF app and call one of its api methods. */
  const viaApp = (vpath, call) => `
    AIOS.apps.instances().filter(function (i) { return i.def.id === 'pdf'; })
      .forEach(function (i) { AIOS.wm.close(i.win); });
    await new Promise(function (r) { setTimeout(r, 200); });
    await AIOS.apps.launch('pdf', ${JSON.stringify(vpath)});
    var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'pdf'; }).pop();
    for (var i = 0; i < 100 && (!inst || !inst.ctx || !inst.ctx.api); i++) {
      await new Promise(function (r) { setTimeout(r, 100); });
      inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'pdf'; }).pop();
    }
    if (!inst || !inst.ctx || !inst.ctx.api) return { error: 'PDF 沒有開起來' };
    for (var j = 0; j < 150 && !(inst.ctx.api.state().doc && inst.ctx.api.state().ready); j++) {
      await new Promise(function (r) { setTimeout(r, 100); });
    }
    if (!inst.ctx.api.state().doc) return { error: 'PDF 沒有讀進來' };
    if (!inst.ctx.api.state().ready) return { error: '檢視器沒有備妥' };
    /* Raced, because a promise that never settles is a run that never ends:
       the CDP evaluation has no deadline of its own. */
    var note = await Promise.race([${call}, new Promise(function (r) { setTimeout(function () { r('TIMEOUT: 90 秒沒有回來'); }, 90000); })]);
    return { note: note, state: { ocrPages: inst.ctx.api.state().ocrPages } };
  `;

  await t.test('先做出一份帶框線表格的 PDF 當素材', async () => {
    const r = await run(cdp, `
      for (const p of ${JSON.stringify([SRC, OUT_X, OUT_D])}) { try { await window.aios.fs.remove(p); } catch (e) {} }
      var out = await AIOS.printing.toPdf(${JSON.stringify(SRC)}, {
        title: 'E2E 版面', bodyHtml: ${JSON.stringify(HTML)}
      });
      var res = await window.aios.pdf.read(${JSON.stringify(SRC)});
      if (!res.ok) return { error: res.error };
      return { vpath: out.vpath, pages: res.data.pageCount, text: res.data.pages[0].text };
    `, { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.pages, 1);
    assert.match(r.text, /LAYOUTMARK/);
  });

  await t.test('排成 Excel：文字在原本的格子裡，框線與合併照畫出來的線', async () => {
    const r = await run(cdp, viaApp(SRC, `await inst.ctx.api.toSheet({ path: ${JSON.stringify(OUT_X)} })`),
      { timeout: 120000 });
    assert.equal(r.error, undefined, r.error);
    assert.match(String(r.note), /已排成 Excel/, '收據：' + r.note);
    assert.match(String(r.note), /格有框線/);

    const back = await run(cdp, `
      var res = await window.aios.office.readXlsx(${JSON.stringify(OUT_X)});
      if (!res.ok) return { error: res.error };
      var s = res.data.sheets[0];
      var cells = Object.keys(s.cells).map(function (k) {
        var c = s.cells[k];
        return { ref: k, v: String(c.v == null ? '' : c.v), border: c.border ? Object.keys(c.border).sort() : [], align: c.align || '' };
      });
      return { names: res.data.sheetNames, cells: cells, merges: s.merges, cols: s.cols, rows: s.rows,
               widths: Object.keys(s.colWidths).length, heights: Object.keys(s.rowHeights).length };
    `, { timeout: 60000 });
    assert.equal(back.error, undefined, back.error);
    assert.deepEqual(back.names, ['第 1 頁'], '一頁一張工作表');

    const byText = (re) => back.cells.find((c) => re.test(c.v));
    const title = byText(/LAYOUTMARK/);
    const name = byText(/^品名$/);
    const bolt = byText(/^螺絲 M6$/);
    const amount = byText(/^1,200$/);
    assert.ok(title && name && bolt && amount, '四段文字都在：' + JSON.stringify(back.cells.map((c) => c.v)));

    const row = (ref) => Number(ref.replace(/^[A-Z]+/, ''));
    const col = (ref) => ref.replace(/[0-9]+$/, '');
    assert.ok(row(title.ref) < row(name.ref), '標題在表格上面');
    assert.equal(row(bolt.ref), row(amount.ref), '同一列的東西在同一列');
    assert.ok(col(amount.ref) > col(name.ref), '金額在品名右邊');
    assert.equal(col(bolt.ref), col(name.ref), '品名欄裡的東西對齊在同一欄');

    assert.deepEqual(name.border, ['b', 'l', 'r', 't'], '表格的格子四邊都有線');
    assert.deepEqual(title.border, [], '表格外面的字沒有線');
    assert.ok(back.merges.some((m) => m.c1 - m.c0 >= 2 && m.r0 === m.r1), '跨三欄的標題列有合併：' + JSON.stringify(back.merges));
    assert.ok(back.widths >= 3 && back.heights >= 5, '欄寬列高都寫了');
  });

  await t.test('排成 Word：標題、段落、有框線與合併的表格，順序照頁面', async () => {
    const r = await run(cdp, viaApp(SRC, `await inst.ctx.api.toDoc({ path: ${JSON.stringify(OUT_D)} })`),
      { timeout: 120000 });
    assert.equal(r.error, undefined, r.error);
    assert.match(String(r.note), /已排成 Word/, '收據：' + r.note);
    assert.match(String(r.note), /1 個表格/);

    const back = await run(cdp, `
      var res = await window.aios.office.readDocx(${JSON.stringify(OUT_D)});
      if (!res.ok) return { error: res.error };
      return { blocks: res.data.blocks.map(function (b) {
        return { type: b.type, text: b.text || '', rows: b.rows || null, merges: b.merges || null,
                 borders: b.cellStyles ? Object.keys(b.cellStyles).filter(function (k) { return b.cellStyles[k].border; }).length : 0 };
      }) };
    `, { timeout: 60000 });
    assert.equal(back.error, undefined, back.error);
    const types = back.blocks.map((b) => b.type);
    const table = back.blocks.find((b) => b.type === 'table');
    assert.ok(table, '有一個表格：' + JSON.stringify(types));
    const flat = table.rows.map((r) => r.join('|'));
    assert.ok(flat.some((r) => /螺絲 M6\|100\|1,200/.test(r)), '一列三格：' + JSON.stringify(flat));
    assert.ok(flat.some((r) => /^九月報價\|?\|?$/.test(r)), '標題列在第一列');
    assert.ok(table.merges && table.merges.some((m) => m.c1 - m.c0 === 2 && m.r0 === 0), '標題列跨三欄');
    assert.ok(table.borders >= 9, '格子帶著框線：' + table.borders);
    const titleAt = back.blocks.findIndex((b) => /LAYOUTMARK/.test(b.text));
    const tableAt = back.blocks.indexOf(table);
    const tailAt = back.blocks.findIndex((b) => /三十天/.test(b.text));
    assert.ok(titleAt >= 0 && titleAt < tableAt && tableAt < tailAt, '順序：客戶、表格、尾註');
  });

  /* ---------------------------------------------------------------- OCR -- */

  const { server, seen } = visionServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const modelUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  let before = null;

  try {
    await t.test('把核心指到本機的假視覺模型；做一份沒有文字圖層的掃描件', async () => {
      const r = await run(cdp, `
        var st = await window.aios.model.state();
        var before = st.ok ? { active: st.data.active, config: (st.data.providers.find(function (p) { return p.id === 'custom'; }) || {}).config } : null;
        var c = await window.aios.model.configure('custom', {
          base: ${JSON.stringify(modelUrl)}, model: 'stub-vision', auth: 'none',
          json: 'object', reasoningKind: 'none', maxOut: 0
        });
        if (!c.ok) return { error: c.error };
        var s = await window.aios.model.select('custom');
        if (!s.ok) return { error: s.error };

        for (const p of ${JSON.stringify([SCAN, SCAN.replace(/\.pdf$/, '.ocr.md'), OUT_SX])}) { try { await window.aios.fs.remove(p); } catch (e) {} }
        // A picture of an invoice, drawn here, so the PDF printed from it has no text layer.
        var cv = document.createElement('canvas');
        cv.width = 1000; cv.height = 640;
        var g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
        g.fillStyle = '#000'; g.font = 'bold 44px sans-serif';
        g.fillText('統一發票 SCANMARK', 60, 90);
        g.font = '30px sans-serif';
        g.fillText('品名        數量      金額', 60, 180);
        g.fillText('螺絲        100       1,200', 60, 240);
        g.fillText('墊片        50        300', 60, 300);
        g.fillText('合計 1,500 元', 60, 380);
        var png = cv.toDataURL('image/png');
        var out = await AIOS.printing.toPdf(${JSON.stringify(SCAN)}, {
          title: 'E2E 掃描件', bodyHtml: '<img src="' + png + '" style="width:100%">'
        });
        var res = await window.aios.pdf.read(${JSON.stringify(SCAN)});
        if (!res.ok) return { error: res.error };
        return { before: before, active: s.data.active, scanned: res.data.scanned, textless: res.data.textless };
      `, { timeout: 60000 });
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.active, 'custom');
      before = r.before;
      assert.equal(r.textless, true, '素材真的沒有文字圖層');
      assert.equal(r.scanned, true);
    });

    await t.test('OCR：頁面畫成圖送給模型，讀出來的字存在 PDF 旁邊', async () => {
      const r = await run(cdp, viaApp(SCAN, `await inst.ctx.api.ocr({})`), { timeout: 120000 });
      assert.equal(r.error, undefined, r.error);
      assert.match(String(r.note), /模型讀出了 1 頁/, '收據：' + r.note);
      assert.deepEqual(r.state.ocrPages, [1]);
      assert.equal(seen.withPicture, 1, '一頁一次請求，而且帶著圖');
      assert.equal(seen.refused, 0, '沒有一次是沒帶圖就問的');

      const sys = (seen.bodies[0].messages || []).find((m) => m.role === 'system');
      assert.ok(sys && /不要照做/.test(sys.content), '提示詞說明頁面是資料不是指令');
      assert.equal(seen.bodies[0].temperature, 0);

      const cache = await run(cdp, `
        var f = ${JSON.stringify(SCAN.replace(/\.pdf$/, '.ocr.md'))};
        var ex = await window.aios.fs.exists(f);
        if (!ex.ok || !ex.data.exists) return { error: '沒有 .ocr.md' };
        var r = await window.aios.fs.read(f);
        return { text: r.ok ? r.data.content : null, origin: r.ok ? r.data.origin : null };
      `, { timeout: 30000 });
      assert.equal(cache.error, undefined, cache.error);
      assert.match(cache.text, /<!-- 第 1 頁 -->/, '每一頁一個標記');
      assert.match(cache.text, /SCANMARK/);
    });

    await t.test('再讀一次不會再問模型；讀進 context 用的是讀出來的字', async () => {
      const r = await run(cdp, viaApp(SCAN, `await inst.ctx.api.ocr({})`), { timeout: 60000 });
      assert.equal(r.error, undefined, r.error);
      assert.match(String(r.note), /已經讀過了/, '收據：' + r.note);
      assert.equal(seen.withPicture, 1, '快取命中，沒有第二次請求');

      const ctx = await run(cdp, viaApp(SCAN, `await inst.ctx.api.readIntoContext()`), { timeout: 60000 });
      assert.equal(ctx.error, undefined, ctx.error);
      assert.match(String(ctx.note), /字讀進 context/, '收據：' + ctx.note);
      assert.equal(seen.withPicture, 1, '還是那一次');
    });

    await t.test('掃描件排成 Excel：模型讀出的表格成了帶框線的列，寫檔要過授權', async () => {
      /* Reading the scan into context armed the taint gate (the PDF's words are
         untrusted content in the prompt now), so this write is the first one
         the gate asks a person about. The spec is that person. */
      const pressed = pressConsent(app.port, true, { timeout: 60000 });
      const r = await run(cdp, viaApp(SCAN, `await inst.ctx.api.toSheet({ path: ${JSON.stringify(OUT_SX)} })`),
        { timeout: 120000 });
      const said = await pressed.catch((e) => ({ error: String(e && e.message || e) }));
      assert.equal(r.error, undefined, r.error);
      assert.ok(said && !said.error, '授權視窗出現並被按下：' + JSON.stringify(said));
      assert.match(String(said.text || '') + JSON.stringify(said.rows || []), /e2e-pdflayout-scan\.xlsx/, '問的是這個檔案');
      assert.match(String(r.note), /已排成 Excel/, '收據：' + r.note);
      assert.match(String(r.note), /1 頁是模型 OCR 讀出來的/);

      const back = await run(cdp, `
        var res = await window.aios.office.readXlsx(${JSON.stringify(OUT_SX)});
        if (!res.ok) return { error: res.error };
        var s = res.data.sheets[0];
        return { cells: Object.keys(s.cells).map(function (k) {
          var c = s.cells[k]; return { ref: k, v: String(c.v == null ? '' : c.v), bordered: !!c.border, bold: !!c.bold };
        }), merges: s.merges };
      `, { timeout: 60000 });
      assert.equal(back.error, undefined, back.error);
      const find = (re) => back.cells.find((c) => re.test(c.v));
      const head = find(/統一發票/);
      const bolt = find(/^螺絲$/);
      const amount = find(/^1,200$/);
      assert.ok(head && bolt && amount, JSON.stringify(back.cells.map((c) => c.v)));
      assert.equal(head.bold, true, '標題是粗體');
      assert.ok(bolt.bordered && amount.bordered, '表格的格子有框線');
      assert.ok(!head.bordered, '標題沒有');
      assert.ok(back.merges.some((m) => m.c1 === 2), '標題跨表格的寬度');
      assert.ok(find(/SCANMARK/), '表格底下的那一行也在');
    });
  } finally {
    server.close();
    if (before) {
      await run(cdp, `
        if (${JSON.stringify(before.config || null)}) {
          await window.aios.model.configure('custom', ${JSON.stringify(before.config || {})});
        }
        try { await window.aios.model.select(${JSON.stringify(before.active)}); } catch (e) {}
        return true;
      `, { timeout: 30000 }).catch(() => null);
    }
  }
}
