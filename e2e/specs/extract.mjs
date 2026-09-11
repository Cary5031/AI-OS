/* 文件萃取, driven end to end against a model that is not real.

   The unit tests check the profile, the column alignment and the filing plan
   with the functions called directly. This drives the actual program: a vendor
   profile written into the sandbox, two PDFs added, the parse button pressed,
   the table read back off the screen, a spreadsheet written, and the documents
   filed through the capability gate's own window.

   The model at the other end is a small HTTP server on loopback that answers
   generateContent. That is not a shortcut -- it is the only way to exercise the
   whole road, and it exercises all of it: the program's request, the main
   process's transport with its key and headers, the reply reader, the alignment
   against the profile's columns, the required-blank shading, the two bins, and
   the batch consent. What it does not test is whether a real model reads a real
   delivery note well, which no test can answer anyway.

   The two documents are different on purpose. One comes back complete and goes
   to the finished bin; the other comes back missing a required part number, and
   has to end up in the other bin with the reason attached. A program that files
   the second one as finished is the failure this whole feature exists to
   prevent. */

import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../lib/cdp.mjs';
import { pressConsent } from '../lib/dialog.mjs';

export const name = '文件萃取';

const MODEL = 'e2e-reader';
const PROFILE = '/檔案/萃取設定/e2e.json';
const DOC_A = '/inbox/e2e-甲.pdf';
const DOC_B = '/inbox/e2e-乙.pdf';
const SHEET = '/notes/e2e-extract.xlsx';

/* Marked so the fake model can tell them apart: nothing about a document's name
   reaches the model, only its bytes. */
const PDF_A = '%PDF-1.4\n% e2e-marker-A\n%%EOF\n';
const PDF_B = '%PDF-1.4\n% e2e-marker-B\n%%EOF\n';

const ROWS_A = [
  { 單號: 'A-001', 日期: '2026-09-01', 料號: '0012345', 品名: '六角螺栓', 數量: '120' },
  { 單號: 'A-001', 日期: '2026-09-01', 料號: '0000700', 品名: '平墊圈', 數量: '40' }
];
/* The part number the model could not find. This is the row that decides which
   folder the document lands in. */
const ROWS_B = [
  { 單號: 'B-002', 日期: '2026-09-02', 料號: '', 品名: '軸承座', 數量: '8' }
];

const PROFILE_JSON = JSON.stringify({
  名稱: 'E2E 進貨單',
  大類: '進貨單',
  廠商: '鐵工廠',
  欄位: ['單號', '日期', '料號', '品名', '數量'],
  必填: ['單號', '料號'],
  提示詞: '逐列抓出這份進貨單的明細。',
  命名: '{廠商}-{單號}',
  交付: '/檔案/{大類}/{廠商}/{年月}'
}, null, 2);

/** Open the program (once) and run `calls`, which may push onto `out`. */
const via = (calls) => `
  var live = AIOS.apps.instances().filter(function (i) { return i.def.id === 'extract'; });
  if (!live.length) await AIOS.apps.launch('extract');
  var inst;
  for (var i = 0; i < 100; i++) {
    inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'extract'; })[0];
    if (inst && inst.ctx && inst.ctx.api) break;
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  if (!inst || !inst.ctx || !inst.ctx.api) return { error: '文件萃取沒有開起來' };
  var out = [];
  ${calls}
  return { out: out };
`;

/**
 * A model that answers generateContent, on loopback.
 *
 * It also records what it was asked, because half the point is checking that
 * the request the main process built is the request that was meant: the key in
 * a header rather than the query string, the custom header applied, the whole
 * PDF inline, and the vendor's own prompt reaching the model unaltered.
 */
function fakeModel() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body });

      const reply = (code, obj) => {
        const text = JSON.stringify(obj);
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(text);
      };

      if (req.method === 'GET' && req.url === `/v1beta/models/${MODEL}`) {
        reply(200, { name: `models/${MODEL}`, displayName: '假的閱讀器' });
        return;
      }
      if (req.method === 'POST' && req.url === `/v1beta/models/${MODEL}:generateContent`) {
        let inline = '';
        try {
          const parsed = JSON.parse(body);
          const part = (parsed.contents[0].parts || []).find((p) => p.inline_data);
          inline = Buffer.from(part.inline_data.data, 'base64').toString('utf8');
        } catch {
          reply(400, { error: { message: '送來的不是我認得的請求' } });
          return;
        }
        const rows = inline.includes('e2e-marker-B') ? ROWS_B : ROWS_A;
        reply(200, {
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: JSON.stringify({ rows: rows }) }] }
          }],
          usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120, totalTokenCount: 1020 }
        });
        return;
      }
      reply(404, { error: { message: '沒有這個路徑：' + req.url } });
    });
  });
  return { server, seen };
}

export async function spec(t, app) {
  const cdp = app.cdp;
  const { server, seen } = fakeModel();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    await t.test('設定檔與文件放進沙箱，程式開得起來而且讀得到設定', async () => {
      const r = await run(cdp, via(`
        await window.aios.fs.mkdir('/檔案/萃取設定');
        out.push(await window.aios.fs.write(${JSON.stringify(PROFILE)}, ${JSON.stringify(PROFILE_JSON)}));
        out.push(await window.aios.fs.write(${JSON.stringify(DOC_A)}, ${JSON.stringify(PDF_A)}));
        out.push(await window.aios.fs.write(${JSON.stringify(DOC_B)}, ${JSON.stringify(PDF_B)}));
        await AIOS.afterFsChange();
        await inst.ctx.api.reload();
        out.push(await inst.ctx.api.useProfile('E2E 進貨單'));
        out.push(document.querySelector('.ext-select') ? '有選單' : '沒有選單');
      `));
      assert.equal(r.error, undefined, r.error);
      assert.ok(r.out[0].ok, '設定檔寫不進去：' + JSON.stringify(r.out[0]));
      assert.match(r.out[3], /E2E 進貨單/, '沒有選到設定：' + r.out[3]);
      assert.equal(r.out[4], '有選單');
    });

    await t.test('「新增設定」建得出一份範本，而且範本自己是合法的設定', async () => {
      /* Run before anything is parsed, while the session is still clean: a write
         here needs no consent, which is itself worth pinning -- the dialog that
         shows up later is the taint downgrade, not the write. */
      const r = await run(cdp, via(`
        /* The sandbox outlives a run, so a template left by the last one would
           make this exercise the refusal path instead of the create path.
           Cleared first; the refusal gets its own check at the end. */
        await window.aios.fs.remove('/檔案/萃取設定/E2E 範本廠.json');
        await AIOS.afterFsChange();
        await inst.ctx.api.reload();

        var buttons = [].slice.call(document.querySelectorAll('.ext-bar button'));
        var make = buttons.filter(function (b) { return b.textContent === '新增設定'; })[0];
        if (!make) return { error: '找不到「新增設定」' };
        make.click();
        for (var i = 0; i < 40 && !document.querySelector('.ui-prompt-input'); i++) {
          await new Promise(function (r) { setTimeout(r, 50); });
        }
        var inp = document.querySelector('.ui-prompt-input');
        if (!inp) return { error: '提示框沒有出現' };
        inp.value = 'E2E 範本廠';
        document.querySelector('form.ui-prompt').dispatchEvent(
          new Event('submit', { cancelable: true, bubbles: true }));
        /* Wait for the selector to land on the new profile, not for the file to
           appear: writing it is the first step of 新增設定, and reading it back
           the moment it exists races the reload and the switch that follow. */
        var picked = '';
        for (var j = 0; j < 80; j++) {
          picked = document.querySelector('.ext-select').selectedOptions[0].textContent;
          if (picked.indexOf('E2E 範本廠') >= 0) break;
          await new Promise(function (r) { setTimeout(r, 100); });
        }
        var got = await window.aios.fs.read('/檔案/萃取設定/E2E 範本廠.json');
        out.push(got.ok ? got.data.content : '');
        out.push(picked);

        /* And again with the same name. A template that overwrote an existing
           profile would take a tuned extraction prompt with it, so the marker
           written here has to still be there afterwards. */
        await window.aios.fs.write('/檔案/萃取設定/E2E 範本廠.json',
          got.data.content.replace('"備註": ""', '"備註": "不要蓋掉我"'));
        await AIOS.afterFsChange();
        make.click();
        for (var k = 0; k < 40 && !document.querySelector('.ui-prompt-input'); k++) {
          await new Promise(function (r) { setTimeout(r, 50); });
        }
        var again = document.querySelector('.ui-prompt-input');
        again.value = 'E2E 範本廠';
        document.querySelector('form.ui-prompt').dispatchEvent(
          new Event('submit', { cancelable: true, bubbles: true }));
        await new Promise(function (r) { setTimeout(r, 600); });
        var after = await window.aios.fs.read('/檔案/萃取設定/E2E 範本廠.json');
        out.push(after.ok ? after.data.content : '');

        // Put the real one back for everything that follows.
        out.push(await inst.ctx.api.useProfile('E2E 進貨單'));
        out.push(document.querySelector('.ext-select').selectedOptions[0].textContent);
      `), { timeout: 60000 });
      assert.equal(r.error, undefined, r.error);

      const text = r.out[0];
      assert.ok(text, '範本沒有寫出來');
      const tpl = JSON.parse(text);
      assert.equal(tpl['廠商'], 'E2E 範本廠');
      assert.ok(Array.isArray(tpl['欄位']) && tpl['欄位'].length, '範本要帶一份欄位清單');
      assert.ok(tpl['提示詞'], '範本要帶一段提示詞的位置');
      assert.equal(tpl['交付'], '/檔案/{大類}/{廠商}/{年月}');

      assert.match(r.out[1], /E2E 範本廠/, '建好之後應該就選著它：' + r.out[1]);
      assert.match(r.out[2], /不要蓋掉我/,
        '同名再建一次把既有的設定蓋掉了——那會連著調好的提示詞一起消失');
      assert.match(r.out[3], /E2E 進貨單/, r.out[3]);
      assert.match(r.out[4], /E2E 進貨單/, '換回去之後選單也要跟著：' + r.out[4]);
    });

    await t.test('萃取模型是這支程式自己的設定，金鑰存得進去也拿不回來', async () => {
      const r = await run(cdp, via(`
        out.push(await window.aios.extract.configure({
          mode: 'gemini', base: ${JSON.stringify(base)}, model: ${JSON.stringify(MODEL)}, auth: 'apikey'
        }));
        out.push(await window.aios.extract.setSecret('e2e-secret-key',
          [{ name: 'X-E2E-Gateway', value: 'e2e-header-value' }]));
        out.push(await window.aios.extract.state());
        out.push(await window.aios.extract.probe());
        // The machine's own model provider must not have been touched by any of it.
        out.push(await window.aios.model.state());
      `));
      assert.equal(r.error, undefined, r.error);
      assert.ok(r.out[0].ok, JSON.stringify(r.out[0]));

      const state = r.out[2].data;
      assert.equal(state.base, base);
      assert.equal(state.model, MODEL);
      assert.equal(state.hasKey, true, 'the key was stored');
      assert.deepEqual(state.headerNames, ['X-E2E-Gateway'], 'the header name comes back');
      const dump = JSON.stringify(r.out[2]);
      assert.equal(dump.includes('e2e-secret-key'), false, 'the key came back through the bridge');
      assert.equal(dump.includes('e2e-header-value'), false, 'a header value came back through the bridge');

      assert.equal(r.out[3].data.ok, true, '測試連線失敗：' + JSON.stringify(r.out[3]));
      assert.equal(r.out[3].data.model, MODEL);

      /* Two settings, two files, no crosstalk: configuring this program's model
         must not have changed the machine's. */
      const core = r.out[4].data;
      assert.ok(core && core.providers, 'the core provider state is still readable');
      assert.equal(JSON.stringify(core).includes(base), false,
        'the core model provider picked up this program’s endpoint');
    });

    await t.test('設定面板畫得出來，欄位帶著存好的值，表頭只看得到名稱', async () => {
      /* The settings pane is a hundred and fifty lines of DOM that the calls
         above never touch. A window that throws while drawing it is a window
         that looks fine until somebody presses the button. */
      const r = await run(cdp, via(`
        var buttons = [].slice.call(document.querySelectorAll('.ext-bar button'));
        var open = buttons.filter(function (b) { return b.textContent === '模型設定'; })[0];
        if (!open) return { error: '找不到「模型設定」' };
        open.click();
        for (var i = 0; i < 60 && document.querySelector('.ext-settings').hidden; i++) {
          await new Promise(function (r) { setTimeout(r, 50); });
        }
        out.push(document.querySelector('.ext-settings').hidden);
        out.push([].slice.call(document.querySelectorAll('.ext-field .ext-input')).map(function (n) {
          return n.value;
        }));
        out.push([].slice.call(document.querySelectorAll('.ext-header-row input')).map(function (n) {
          return { type: n.type, value: n.value, placeholder: n.placeholder };
        }));
        out.push(document.querySelectorAll('.ext-set-acts button').length);
        // And back, so the rest of the run has the working page again.
        document.querySelector('.ext-set-head button').click();
        await new Promise(function (r) { setTimeout(r, 100); });
        out.push(document.querySelector('.ext-settings').hidden);
        out.push(!document.querySelector('.ext-work').hidden);
      `), { timeout: 60000 });
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.out[0], false, '設定頁沒有顯示出來');

      const fields = r.out[1];
      assert.ok(fields.includes(base), '端點沒有帶進表單：' + JSON.stringify(fields));
      assert.ok(fields.includes(MODEL), '模型名稱沒有帶進表單：' + JSON.stringify(fields));
      assert.ok(fields.includes(''), 'API 金鑰欄應該是空的');
      assert.equal(fields.includes('e2e-secret-key'), false, '金鑰被畫到畫面上了');

      const header = r.out[2];
      assert.equal(header.length, 2, '一列表頭是名稱加值兩格');
      assert.equal(header[0].value, 'X-E2E-Gateway', '表頭名稱要顯示出來');
      assert.equal(header[1].type, 'password');
      assert.equal(header[1].value, '', '表頭的值不該被帶回畫面');
      assert.match(header[1].placeholder, /已設定/, '要說明留白代表不更動：' + header[1].placeholder);

      assert.equal(r.out[3], 3, '儲存、測試連線、清除金鑰');
      assert.equal(r.out[4], true, '按「回到作業」之後設定頁要收起來');
      assert.equal(r.out[5], true, '作業頁要回來');
    });

    await t.test('兩份 PDF 原檔直送模型，回來的列照設定的欄位對齊', async () => {
      const r = await run(cdp, via(`
        out.push(await inst.ctx.api.addDocs([${JSON.stringify(DOC_A)}, ${JSON.stringify(DOC_B)}]));
        out.push(await inst.ctx.api.runAll());
        out.push([].slice.call(document.querySelectorAll('.ext-table thead th')).map(function (th) {
          return th.textContent;
        }));
        out.push(document.querySelectorAll('.ext-table tbody tr').length);
        out.push([].slice.call(document.querySelectorAll('.ext-table tbody tr')[0].children).map(function (td) {
          return td.textContent;
        }));
        out.push(document.querySelectorAll('.ext-table td.ext-blank').length);
        out.push(document.querySelector('.ext-status').textContent);
        out.push(inst.describe ? inst.describe() : '');
      `), { timeout: 60000 });
      assert.equal(r.error, undefined, r.error);

      assert.match(r.out[1], /解析完成 2 份/, r.out[1]);
      assert.deepEqual(r.out[2], ['單號', '日期', '料號', '品名', '數量', '_檔名', '_廠商', '_列號'],
        'the header is the profile’s columns then the provenance ones');
      assert.equal(r.out[3], 3, 'two rows from one document and one from the other');

      /* The leading zero is the whole reason every value is text. A model that
         answered "0012345" must still read 0012345 on screen. */
      assert.deepEqual(r.out[4],
        ['A-001', '2026-09-01', '0012345', '六角螺栓', '120', 'e2e-甲.pdf', '鐵工廠', '1']);

      assert.equal(r.out[5], 1, 'exactly the one empty required cell is shaded');
      assert.match(r.out[6], /必填未填 1 格/, r.out[6]);

      /* What the kernel is told. The rows came out of documents from /inbox,
         which this session has already marked untrusted; the summary reports
         how many, never what. */
      const said = r.out[7];
      assert.match(said, /3 列/, said);
      ['0012345', '六角螺栓', '軸承座', 'A-001'].forEach((leak) => {
        assert.equal(said.includes(leak), false, '摘要漏出了儲存格內容：' + leak);
      });
    });

    await t.test('送出去的請求是該有的樣子：金鑰在表頭、PDF 整份、廠商的提示詞原封不動', () => {
      const posts = seen.filter((s) => s.method === 'POST');
      assert.equal(posts.length, 2, '一份文件一次請求');

      posts.forEach((p) => {
        assert.equal(p.headers['x-api-key'], 'e2e-secret-key', '金鑰要在表頭');
        assert.equal(p.headers['x-e2e-gateway'], 'e2e-header-value', '自訂表頭要送出去');
        assert.equal(p.url.includes('key='), false, '金鑰不可以出現在網址上');

        const body = JSON.parse(p.body);
        const parts = body.contents[0].parts;
        const file = parts.find((x) => x.inline_data);
        assert.equal(file.inline_data.mime_type, 'application/pdf');
        const text = parts.find((x) => x.text).text;
        assert.ok(text.startsWith('逐列抓出這份進貨單的明細。'), '廠商自己的提示詞要在最前面');
        assert.ok(text.includes('前導零'), '格式契約要接在後面');
        assert.equal(body.generationConfig.temperature, 0, '抄寫不是創作');
        assert.equal(body.generationConfig.responseMimeType, 'application/json');
        assert.deepEqual(Object.keys(body.generationConfig.responseSchema.properties.rows.items.properties),
          ['單號', '日期', '料號', '品名', '數量']);
      });

      /* The bytes that went were the file's own bytes, not a transcription. */
      const sent = posts.map((p) => Buffer.from(
        JSON.parse(p.body).contents[0].parts.find((x) => x.inline_data).inline_data.data, 'base64'
      ).toString('utf8')).sort();
      assert.deepEqual(sent, [PDF_A, PDF_B].sort(), 'the whole PDF goes, unaltered');
    });

    await t.test('匯出的試算表是真的 xlsx，而且前導零還在', async () => {
      /* The gate asks first, and that is correct rather than in the way: the
         documents came out of /inbox, so reading them armed the taint downgrade,
         and fs.write is elevated. A spreadsheet full of somebody else's PDF is
         exactly the write that should be shown to a person before it happens.
         Pressed here the way a person presses it. */
      const pressed = pressConsent(app.port, true, { timeout: 60000 });
      const r = await run(cdp, via(`
        out.push(await inst.ctx.api.exportSheet(${JSON.stringify(SHEET)}));
        var b = await window.aios.fs.readBytes(${JSON.stringify(SHEET)});
        out.push(b.ok ? atob(b.data.base64.slice(0, 8)).slice(0, 2) : b.error);
        var bin = atob(b.data.base64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        // Part names live uncompressed in the local headers, so they read out
        // of the raw bytes. This writer inlines its strings, so there is no
        // sharedStrings part to look for -- the worksheet is the one that must
        // be there.
        out.push(new TextDecoder('latin1').decode(bytes).indexOf('xl/worksheets/sheet1.xml') >= 0);
        // Read it back through the machine's own reader rather than trusting the bytes.
        var read = await window.aios.office.readXlsx(${JSON.stringify(SHEET)});
        out.push(read.ok ? read.data : { error: read.error });
      `), { timeout: 60000 });

      const said = await pressed;
      assert.equal(said.error, undefined, JSON.stringify(said));
      assert.match(said.text, /不可信/,
        '授權視窗要說出為什麼現在才問：' + said.text.slice(0, 160));

      assert.equal(r.error, undefined, r.error);
      assert.match(r.out[0], /3 列/, r.out[0]);
      assert.equal(r.out[1], 'PK', 'a zip was written: ' + r.out[1]);
      assert.equal(r.out[2], true, 'and the worksheet part is in it');

      const book = r.out[3];
      assert.ok(book && book.cells, JSON.stringify(book).slice(0, 200));
      assert.equal(book.cells.A1 && (book.cells.A1.v || book.cells.A1), '單號');
      const c2 = book.cells.C2 && (book.cells.C2.v !== undefined ? book.cells.C2.v : book.cells.C2);
      assert.equal(String(c2), '0012345', '前導零在往返之後不見了');
    });

    await t.test('交付計畫先畫在視窗裡，還沒有動到任何檔案', async () => {
      const r = await run(cdp, via(`
        var plan = inst.ctx.api.previewDelivery();
        out.push({ finished: plan.finished, unsure: plan.unsure, dirs: plan.dirs });
        out.push(plan.plan.map(function (e) {
          return [e.name, e.newName, e.status, e.reason];
        }));
        out.push([].slice.call(document.querySelectorAll('.ext-table tbody tr')).length);
        out.push(document.querySelector('.ext-foot .ext-go').textContent);
        // Nothing moved yet: both documents are still where they were.
        out.push((await window.aios.fs.readBytes(${JSON.stringify(DOC_A)})).ok);
        out.push((await window.aios.fs.readBytes(${JSON.stringify(DOC_B)})).ok);
      `));
      assert.equal(r.error, undefined, r.error);

      const summary = r.out[0];
      assert.equal(summary.finished, 1);
      assert.equal(summary.unsure, 1);

      const plan = r.out[1];
      const a = plan.find((e) => e[0] === 'e2e-甲.pdf');
      const b = plan.find((e) => e[0] === 'e2e-乙.pdf');
      assert.deepEqual([a[1], a[2], a[3]], ['鐵工廠-A-001.pdf', 'finished', '']);
      assert.equal(b[1], '鐵工廠-B-002.pdf');
      assert.equal(b[2], 'unsure');
      assert.match(b[3], /料號/, '待確認的那一份要說出是哪一欄空著：' + b[3]);

      assert.equal(r.out[2], 2, 'the plan is drawn as a table');
      assert.match(r.out[3], /確認交付（2）/, r.out[3]);
      assert.equal(r.out[4], true, 'the source document is still in /inbox');
      assert.equal(r.out[5], true);
    });

    await t.test('真的歸檔：閘門一次列出整批，完成與待確認各進各的資料夾', async () => {
      const pressed = pressConsent(app.port, true, { timeout: 60000 });
      const ran = run(cdp, via(`
        out.push(await inst.ctx.api.deliver());
        out.push((await window.aios.fs.readBytes('/檔案/進貨單/鐵工廠/2026-09/Finished/鐵工廠-A-001.pdf')).ok);
        out.push((await window.aios.fs.readBytes('/檔案/進貨單/鐵工廠/2026-09/Undefined/鐵工廠-B-002.pdf')).ok);
        out.push((await window.aios.fs.readBytes(${JSON.stringify(DOC_A)})).ok);
      `), { timeout: 90000 });

      const said = await pressed;
      assert.equal(said.error, undefined, JSON.stringify(said));
      assert.equal(said.count, 2, '閘門要一次把整批列出來，不是一份問一次');
      assert.match(said.allow, /執行 2 次/, said.allow);
      assert.ok(said.rows.some((row) => row.includes('鐵工廠-A-001.pdf')),
        '清單要看得到每一個目的地：' + said.rows.join(' | '));

      const r = await ran;
      assert.equal(r.error, undefined, r.error);
      assert.match(r.out[0], /歸檔了 2 \/ 2 份/, r.out[0]);
      assert.equal(r.out[1], true, '完成的那一份沒進 Finished');
      assert.equal(r.out[2], true, '待確認的那一份沒進 Undefined');
      assert.equal(r.out[3], false, '原本的檔案應該已經搬走了');
    });

    await t.test('金鑰忘得掉，端點留著', async () => {
      const r = await run(cdp, via(`
        out.push(await window.aios.extract.forgetSecret());
      `));
      assert.equal(r.error, undefined, r.error);
      const s = r.out[0].data;
      assert.equal(s.hasKey, false);
      assert.deepEqual(s.headerNames, []);
      assert.equal(s.base, base, '位址不該跟著金鑰一起消失');
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}
