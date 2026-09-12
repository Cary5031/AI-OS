/* 文件萃取, driven end to end against a studio that is not real.

   The unit tests check the schema arithmetic, the column alignment and the
   filing plan with the functions called directly. This drives the actual
   program: a prompt studio on loopback that serves categories, vendors, column
   layouts and jobs; a second server standing in for the fallback model; and the
   window doing the whole round -- sync, pick, upload, poll, collect, edit, file.

   Three things here are the point, and none of them can be checked any other
   way:

     the two backends stay separate. Two keys, two hosts, and neither key is
     ever readable back through the bridge.

     the studio is the default and the fallback is a fallback. When the studio
     goes away the window says so and names the reason; when the studio answers
     401 it does NOT fail over, because a wrong key is not an outage and running
     the batch somewhere else would bury it.

     a batch belongs to the engine that started it. The two disagree about
     columns, about which fields are mandatory and about naming, and nothing on
     a finished spreadsheet would say which one produced it -- except the 「_來源」
     column, which is checked. */

import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../lib/cdp.mjs';
import { pressConsent } from '../lib/dialog.mjs';

export const name = '文件萃取';

const CATEGORY = '進貨單';
const VENDOR_A = '中鋼';
const VENDOR_B = '燁聯';
const MODEL = 'e2e-reader';

const DOC_A = '/inbox/e2e-甲.pdf';
const DOC_B = '/inbox/e2e-乙.pdf';
const DOC_C = '/inbox/e2e-丙.pdf';
const SHEET = '/notes/e2e-extract.xlsx';
const LOCAL_PROFILE = '/檔案/萃取設定/e2e-備援.json';

const PDF_A = '%PDF-1.4 marker-A';
const PDF_B = '%PDF-1.4 marker-B';
const PDF_C = '%PDF-1.4 marker-C';

/* 爐號 sits inside the repeating block, so it is required per repetition and
   therefore NOT required in the flat table. Included so the window's red cells
   have to come from the same arithmetic the studio uses. */
const SCHEMA = {
  schema_label: '進貨單標準格式',
  export_columns: ['單號', '日期', '料號', '品名', '數量', '爐號'],
  master_required: ['單號'],
  arrays: { 明細: { required: ['料號', '數量', '爐號'] } },
  array_fields: ['爐號']
};

/* What the job produces. 乙 is missing its part number, which the studio does
   not consider a failure -- and this machine does, because whatever sits in
   待確認 is what still needs a person. */
const ROWS = [
  { 單號: 'A-001', 日期: '2026-09-01', 料號: '0012345', 品名: '鋼板 6mm', 數量: '12', 爐號: '0800',
    _檔名: 'e2e-甲.pdf', _廠商: VENDOR_A, _列號: '1' },
  { 單號: 'A-001', 日期: '2026-09-01', 料號: '0000700', 品名: '鋼板 9mm', 數量: '4', 爐號: '0801',
    _檔名: 'e2e-甲.pdf', _廠商: VENDOR_A, _列號: '2' },
  { 單號: 'B-002', 日期: '2026-09-02', 料號: '', 品名: '不鏽鋼捲', 數量: '3', 爐號: '',
    _檔名: 'e2e-乙.pdf', _廠商: VENDOR_B, _列號: '3' }
];

/* The result's own column order, deliberately different from the schema's, so
   the window has to take the delivery over the promise. */
const RESULT_COLUMNS = ['單號', '料號', '品名', '數量', '日期', '爐號'];

/** Open the program (once) and run `calls`, which may push onto `out`. */
const via = (calls) => `
  var live = AIOS.apps.instances().filter(function (i) { return i.def.id === 'extract'; });
  if (!live.length) await AIOS.apps.launch('extract');
  var inst;
  for (var i = 0; i < 120; i++) {
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
 * A prompt studio, on loopback.
 *
 * `state.fail` drives the failure the tests need: 'denied' answers 401 to
 * everything (a wrong key, which must NOT cause a fallback), and closing the
 * server is how an outage is simulated.
 */
function fakeStudio() {
  const seen = [];
  const state = { fail: '', jobs: new Map(), nextId: 1, retried: 0 };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = req.url.split('?')[0];
      seen.push({ method: req.method, url: req.url, headers: req.headers, length: raw.length });

      const reply = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (state.fail === 'denied') return reply(401, { detail: '這把金鑰不對' });
      if (state.fail === 'fault') return reply(500, { detail: '某個廠商的提示詞壞了' });

      if (url === '/health') return reply(200, { status: 'ok', settings: { model: { model_name: MODEL } } });
      if (url === '/catalog') return reply(404, { detail: 'not implemented' });
      if (url === '/categories') return reply(200, { categories: [CATEGORY] });
      if (url === `/categories/${encodeURIComponent(CATEGORY)}/vendors`) {
        return reply(200, { vendors: [VENDOR_A, VENDOR_B] });
      }
      if (url === `/categories/${encodeURIComponent(CATEGORY)}/identities`) {
        return reply(200, { auto_detectable: [VENDOR_A, VENDOR_B], manual_only: [] });
      }
      if (/\/schema$/.test(url)) return reply(200, SCHEMA);
      if (/\/prompt$/.test(url)) return reply(404, { detail: '工作室還沒提供提示詞' });

      if (url === '/classify' && req.method === 'POST') {
        // utf8, not latin1: the filenames are Chinese and arrive as UTF-8 bytes.
        const body = raw.toString('utf8');
        const results = [];
        if (body.includes('e2e-甲.pdf')) {
          results.push({ filename: 'e2e-甲.pdf', status: 'matched', vendor: VENDOR_A, confidence: 0.9 });
        }
        if (body.includes('e2e-乙.pdf')) {
          results.push({ filename: 'e2e-乙.pdf', status: 'matched', vendor: VENDOR_B, confidence: 0.8 });
        }
        if (body.includes('e2e-丙.pdf')) {
          results.push({ filename: 'e2e-丙.pdf', status: 'unmatched', vendor: '', confidence: 0 });
        }
        return reply(200, { results });
      }

      if (url === '/jobs' && req.method === 'POST') {
        // utf8, not latin1: the filenames are Chinese and arrive as UTF-8 bytes.
        const body = raw.toString('utf8');
        const names = ['e2e-甲.pdf', 'e2e-乙.pdf', 'e2e-丙.pdf'].filter((n) => body.includes(n));
        const id = 'job-' + (state.nextId++);
        state.jobs.set(id, {
          polls: 0,
          files: names.map((n) => ({
            filename: n, status: 'queued', vendor: '', elapsed: 0, tokens: 0,
            error: n === 'e2e-丙.pdf' ? '這頁是掃描件，讀不出文字' : ''
          }))
        });
        return reply(200, { job_id: id });
      }

      const jobMatch = /^\/jobs\/([^/]+)$/.exec(url);
      if (jobMatch && req.method === 'GET') {
        const job = state.jobs.get(jobMatch[1]);
        if (!job) return reply(404, { detail: '沒有這個工作' });
        /* Two polls of work, so the window's progress path is exercised rather
           than skipped by an instant answer. */
        job.polls++;
        if (job.polls >= 2) {
          job.files.forEach((f) => {
            f.status = f.error ? 'failed' : 'done';
            f.vendor = f.filename === 'e2e-乙.pdf' ? VENDOR_B : VENDOR_A;
            f.tokens = 900;
          });
        } else {
          job.files.forEach((f) => { f.status = 'running'; });
        }
        const done = job.files.filter((f) => f.status === 'done').length;
        const failed = job.files.filter((f) => f.status === 'failed').length;
        const pending = job.files.length - done - failed;
        return reply(200, {
          pending, done, failed, total: job.files.length,
          tokens: done * 900, files: job.files
        });
      }

      const resultMatch = /^\/jobs\/([^/]+)\/result$/.exec(url);
      if (resultMatch && req.method === 'GET') {
        const job = state.jobs.get(resultMatch[1]);
        if (!job) return reply(404, { detail: '沒有這個工作' });
        const wanted = new Set(job.files.filter((f) => f.status === 'done').map((f) => f.filename));
        return reply(200, {
          columns: RESULT_COLUMNS,
          rows: ROWS.filter((r) => wanted.has(r['_檔名'])),
          failed_files: job.files.filter((f) => f.status === 'failed')
            .map((f) => ({ filename: f.filename, error: f.error }))
        });
      }

      const retryMatch = /^\/jobs\/([^/]+)\/retry$/.exec(url);
      if (retryMatch && req.method === 'POST') {
        const job = state.jobs.get(retryMatch[1]);
        if (!job) return reply(404, { detail: '沒有這個工作' });
        state.retried++;
        job.polls = 0;
        job.files.forEach((f) => {
          if (f.status !== 'failed') return;
          f.status = 'queued';
          f.error = '';          // the retry succeeds this time
        });
        return reply(200, { requeued: 1 });
      }

      const planMatch = /^\/jobs\/([^/]+)\/package\/preview$/.exec(url);
      if (planMatch && req.method === 'POST') {
        let rows = [];
        try { rows = JSON.parse(raw.toString('utf8')).rows || []; } catch { /* shape checked below */ }
        const byFile = new Map();
        rows.forEach((r) => { if (!byFile.has(r['_檔名'])) byFile.set(r['_檔名'], r); });
        const finished = [];
        [...byFile.entries()].forEach(([file, row]) => {
          const no = String(row['單號'] || '').trim();
          finished.push(no
            ? { old: file, new: row['_廠商'] + '-' + no + '.pdf', status: 'ok', reason: '' }
            : { old: file, new: file, status: 'skipped', reason: '單號是空的' });
        });
        return reply(200, { rename_field: '單號', finished, undefined: [], duplicated: 0, skipped: 0 });
      }

      reply(404, { detail: '沒有這個路徑：' + url });
    });
  });
  return { server, seen, state };
}

/** A stand-in for the fallback model: generateContent and one model lookup. */
function fakeModel() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET') return reply(200, { name: 'models/' + MODEL, displayName: '假的閱讀器' });
      return reply(200, {
        candidates: [{
          finishReason: 'STOP',
          content: {
            parts: [{
              text: JSON.stringify({
                rows: [{ 單號: 'F-9', 日期: '2026-09-03', 料號: '0000999',
                  品名: '備援讀到的', 數量: '1', 爐號: '' }]
              })
            }]
          }
        }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
      });
    });
  });
  return { server, seen };
}

export async function spec(t, app) {
  const cdp = app.cdp;
  const studio = fakeStudio();
  const model = fakeModel();
  await new Promise((r) => studio.server.listen(0, '127.0.0.1', r));
  await new Promise((r) => model.server.listen(0, '127.0.0.1', r));
  const studioBase = 'http://127.0.0.1:' + studio.server.address().port;
  const modelBase = 'http://127.0.0.1:' + model.server.address().port;

  try {
    await t.test('兩個後端各自設定，兩把金鑰都拿不回來', async () => {
      const r = await run(cdp, `
        await window.aios.fs.write(${JSON.stringify(DOC_A)}, ${JSON.stringify(PDF_A)});
        await window.aios.fs.write(${JSON.stringify(DOC_B)}, ${JSON.stringify(PDF_B)});
        await window.aios.fs.write(${JSON.stringify(DOC_C)}, ${JSON.stringify(PDF_C)});
        await AIOS.afterFsChange();
        var out = [];
        out.push(await window.aios.extract.configure('service',
          { base: ${JSON.stringify(studioBase)}, auth: 'apikey' }));
        out.push(await window.aios.extract.setSecret('service', 'studio-secret',
          [{ name: 'X-Studio-Gateway', value: 'studio-header' }]));
        out.push(await window.aios.extract.configure('fallback',
          { base: ${JSON.stringify(modelBase)}, model: ${JSON.stringify(MODEL)}, auth: 'goog' }));
        out.push(await window.aios.extract.setSecret('fallback', 'model-secret', []));
        out.push(await window.aios.extract.state());
        out.push(await window.aios.extract.resolve(true));
        out.push(await window.aios.model.state());
        return { out: out };
      `);
      assert.equal(r.error, undefined, r.error);
      const state = r.out[4].data;
      assert.equal(state.service.base, studioBase);
      assert.equal(state.fallback.base, modelBase);
      assert.equal(state.service.hasKey, true);
      assert.equal(state.fallback.hasKey, true);
      assert.deepEqual(state.service.headerNames, ['X-Studio-Gateway']);

      const dump = JSON.stringify(r.out[4]);
      ['studio-secret', 'model-secret', 'studio-header'].forEach((leak) => {
        assert.equal(dump.includes(leak), false, '這個秘密從橋上漏出來了：' + leak);
      });

      assert.equal(r.out[5].data.mode, 'service', '預設就是工作室：' + r.out[5].data.reason);
      assert.equal(JSON.stringify(r.out[6].data).includes(studioBase), false,
        '核心模型供應商被這支程式的設定動到了');
    });

    await t.test('開窗就同步：大類、廠商、欄位從工作室來，不是本機維護的', async () => {
      const r = await run(cdp, via(`
        out.push(await inst.ctx.api.sync());
        var cat = await window.aios.extract.catalog();
        out.push(cat.data.categories);
        out.push(Object.keys(cat.data.vendors || {}).length ? cat.data.vendors[${JSON.stringify(CATEGORY)}] : []);
        out.push(await inst.ctx.api.choose(${JSON.stringify(CATEGORY)}, ${JSON.stringify(VENDOR_A)}));
        out.push(document.querySelector('.ext-chip').textContent);
        out.push([].slice.call(document.querySelectorAll('.ext-bar select')).map(function (s) {
          return [].slice.call(s.options).map(function (o) { return o.textContent; });
        }));
      `), { timeout: 60000 });
      assert.equal(r.error, undefined, r.error);
      assert.match(r.out[0], /1 個大類/, r.out[0]);
      assert.match(r.out[0], /還沒提供提示詞/, '沒有提示詞這件事要說出來：' + r.out[0]);
      assert.deepEqual(r.out[1], [CATEGORY]);
      assert.deepEqual(r.out[2], [VENDOR_A, VENDOR_B]);
      assert.match(r.out[3], new RegExp(VENDOR_A));
      assert.equal(r.out[4], '工作室');

      const [cats, vendors] = r.out[5];
      assert.deepEqual(cats, [CATEGORY], '大類下拉來自工作室');
      assert.ok(vendors[0].includes('自動判別'), '有可自動判別的廠商就要提供那個選項');
      assert.ok(vendors.includes(VENDOR_A) && vendors.includes(VENDOR_B), vendors.join(','));
    });

    await t.test('整批一個工作：欄位以回傳的為準，來源欄是工作室填的', async () => {
      const r = await run(cdp, via(`
        out.push(await inst.ctx.api.choose(${JSON.stringify(CATEGORY)}, ''));
        out.push(await inst.ctx.api.addDocs([
          ${JSON.stringify(DOC_A)}, ${JSON.stringify(DOC_B)}, ${JSON.stringify(DOC_C)}]));
        out.push(await inst.ctx.api.runAll());
        out.push([].slice.call(document.querySelectorAll('.ext-table thead th')).map(function (th) {
          return th.textContent.replace(' *', '');
        }));
        out.push([].slice.call(document.querySelectorAll('.ext-table tbody tr')).map(function (tr) {
          return [].slice.call(tr.children).map(function (td) { return td.textContent; });
        }));
        out.push(document.querySelectorAll('.ext-table td.ext-blank').length);
        out.push(document.querySelector('.ext-banner-note').textContent);
        out.push(inst.describe ? inst.describe() : '');
      `), { timeout: 120000 });
      assert.equal(r.error, undefined, r.error);
      assert.match(r.out[2], /解析完成/, r.out[2]);
      assert.match(r.out[2], /1 份失敗/, '讀不出來的那一份要講出來：' + r.out[2]);

      assert.deepEqual(r.out[3], RESULT_COLUMNS.concat(['_檔名', '_廠商', '_列號', '_來源']),
        '欄位順序要照工作室回傳的結果，不是 schema 承諾的');

      const table = r.out[4];
      assert.equal(table.length, 3, '兩份成功的文件共三列');
      assert.equal(table[0][0], 'A-001');
      assert.equal(table[0][1], '0012345', '前導零還在');
      assert.equal(table[0][6], 'e2e-甲.pdf');
      assert.equal(table[0][7], VENDOR_A);
      assert.equal(table[2][7], VENDOR_B, '每一列帶的是它自己那份文件的廠商');
      assert.ok(table[0][9].length > 0, '_來源 要寫上是哪個引擎');

      /* 爐號 is inside the repeating block, so a blank one is NOT a mandatory
         blank. Only 料號 on the third row is. */
      assert.equal(r.out[5], 1, '只有真正的必填空白會標紅');

      assert.match(r.out[6], /綁在/, '橫幅要說這一批綁在哪個引擎上：' + r.out[6]);
      ['0012345', '鋼板', 'A-001'].forEach((leak) => {
        assert.equal(r.out[7].includes(leak), false, '摘要漏出了儲存格內容：' + leak);
      });
    });

    await t.test('讀不出來的那一份可以重跑，重跑後進到表格裡', async () => {
      const before = studio.state.retried;
      const r = await run(cdp, via(`
        out.push(await inst.ctx.api.retryFailed());
        out.push(document.querySelectorAll('.ext-table tbody tr').length);
      `), { timeout: 120000 });
      assert.equal(r.error, undefined, r.error);
      assert.equal(studio.state.retried, before + 1, '真的有打 /retry');
      assert.match(r.out[0], /解析完成/, r.out[0]);
    });

    await t.test('交付：工作室決定檔名，這台機器決定桶子與去處', async () => {
      const r = await run(cdp, via(`
        var plan = await inst.ctx.api.previewDelivery();
        out.push({ finished: plan.finished, unsure: plan.unsure, renameField: plan.renameField,
                   source: plan.source, dirs: plan.dirs });
        out.push(plan.plan.map(function (e) { return [e.name, e.newName, e.status, e.reason]; }));
      `), { timeout: 60000 });
      assert.equal(r.error, undefined, r.error);

      const sum = r.out[0];
      assert.equal(sum.source, 'service');
      assert.equal(sum.renameField, '單號');

      const rowsOut = r.out[1];
      const a = rowsOut.find((e) => e[0] === 'e2e-甲.pdf');
      const b = rowsOut.find((e) => e[0] === 'e2e-乙.pdf');
      assert.equal(a[1], VENDOR_A + '-A-001.pdf', '檔名是工作室給的');
      assert.equal(a[2], 'finished');
      /* The studio called this one finished. This machine does not, because a
         mandatory cell is empty -- and the operator's triage habit is that
         whatever is in 待確認 is what still needs them. */
      assert.equal(b[2], 'unsure', '必填空白的那一份不能算完成');
      assert.ok(b[3].includes('料號') || b[3].includes('單號'), b[3]);

      assert.ok(sum.dirs.some((d) => d.includes('/' + VENDOR_A + '/')), sum.dirs.join(' | '));
      assert.ok(sum.dirs.some((d) => d.includes('/' + VENDOR_B + '/')),
        '自動判別時每一家進自己的資料夾：' + sum.dirs.join(' | '));
    });

    await t.test('真的歸檔：閘門一次列出整批', async () => {
      const pressed = pressConsent(app.port, true, { timeout: 60000 });
      const ran = run(cdp, via(`
        out.push(await inst.ctx.api.deliver());
        out.push((await window.aios.fs.readBytes(${JSON.stringify(DOC_A)})).ok);
      `), { timeout: 120000 });

      const said = await pressed;
      assert.equal(said.error, undefined, JSON.stringify(said));
      assert.ok(said.count >= 2, '整批一次列出來：' + said.count);

      const r = await ran;
      assert.equal(r.error, undefined, r.error);
      assert.match(r.out[0], /歸檔了/, r.out[0]);
      assert.equal(r.out[1], false, '原本的檔案應該已經搬走了');
    });

    await t.test('匯出的試算表帶著來源欄，而且前導零還在', async () => {
      const pressed = pressConsent(app.port, true, { timeout: 60000 });
      const r = await run(cdp, via(`
        out.push(await inst.ctx.api.exportSheet(${JSON.stringify(SHEET)}));
        var read = await window.aios.office.readXlsx(${JSON.stringify(SHEET)});
        out.push(read.ok ? read.data.cells : { error: read.error });
      `), { timeout: 90000 });
      await pressed.catch(() => {});
      assert.equal(r.error, undefined, r.error);
      const cells = r.out[1];
      const val = (ref) => {
        const c = cells[ref];
        return c && c.v !== undefined ? String(c.v) : String(c || '');
      };
      assert.equal(val('A1'), '單號');
      assert.equal(val('B2'), '0012345', '前導零在往返之後不見了');
      assert.equal(val('J1'), '_來源', '最後一欄要記下是哪個引擎產的');
    });

    await t.test('金鑰不對不會降級：它會停下來照實說', async () => {
      /* A revoked key looks exactly like an outage if nobody separates them,
         and the operator would run on the other engine for weeks without
         knowing the studio key had died. */
      studio.state.fail = 'denied';
      const r = await run(cdp, via(`
        out.push(await inst.ctx.api.clearAll());
        out.push(await window.aios.extract.resolve(true));
        out.push(await inst.ctx.api.refreshMode(true));
        out.push(document.querySelector('.ext-chip').textContent);
        out.push(document.querySelector('.ext-banner-why').textContent);
      `), { timeout: 60000 });
      studio.state.fail = '';
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.out[1].data.mode, 'none', '401 不可以變成備援：' + r.out[1].data.reason);
      assert.match(r.out[1].data.reason, /金鑰/, r.out[1].data.reason);
      assert.equal(r.out[3], '未就緒');
      assert.match(r.out[4], /金鑰/, r.out[4]);
    });

    await t.test('工作室掛掉才降級，而且沒有提示詞就不假裝跑得動', async () => {
      await new Promise((r) => studio.server.close(r));
      const r = await run(cdp, via(`
        /* The sandbox outlives a run. A local profile left by the last one would
           make this exercise the happy path instead of the refusal, and the
           document was moved by the filing test above. Both put back.

           The taint mark is cleared first: reading those PDFs armed the
           downgrade, so these setup writes would each stop on a consent dialog
           that nothing in this test is going to press. Clearing it is a real
           user gesture and none of what follows is about the gate. */
        await window.aios.taint.clear();
        await window.aios.fs.remove(${JSON.stringify(LOCAL_PROFILE)});
        await window.aios.fs.write(${JSON.stringify(DOC_B)}, ${JSON.stringify(PDF_B)});
        await AIOS.afterFsChange();
        out.push(await inst.ctx.api.refreshMode(true));
        out.push(document.querySelector('.ext-chip').textContent);
        out.push(document.querySelector('.ext-banner-why').textContent);
        out.push(await inst.ctx.api.addDocs([${JSON.stringify(DOC_B)}]));
        try {
          out.push(await inst.ctx.api.runAll());
        } catch (e) {
          out.push('REFUSED: ' + e.message);
        }
      `), { timeout: 90000 });
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.out[0], 'fallback', '連不上才降級');
      assert.equal(r.out[1], '備援模型');
      assert.match(r.out[2], /連不上/, r.out[2]);
      assert.ok(String(r.out[4]).startsWith('REFUSED:'),
        '沒有提示詞就不能跑，不然模型只會收到「請輸出 JSON」：' + r.out[4]);
      assert.match(String(r.out[4]), /自動判別|提示詞/, r.out[4]);
    });

    await t.test('放一份本機提示詞，備援就接得住，而且來源欄說得出是誰做的', async () => {
      const local = JSON.stringify({
        名稱: 'E2E 備援', 大類: CATEGORY, 廠商: VENDOR_B,
        欄位: SCHEMA.export_columns,
        必填: ['單號', '料號'],
        提示詞: '這是備援用的萃取提示詞，逐列抓明細。',
        交付: '/檔案/{大類}/{廠商}/{年月}'
      }, null, 2);
      const r = await run(cdp, via(`
        await window.aios.taint.clear();
        await window.aios.fs.mkdir('/檔案/萃取設定');
        await window.aios.fs.write(${JSON.stringify(LOCAL_PROFILE)}, ${JSON.stringify(local)});
        await window.aios.fs.write(${JSON.stringify(DOC_B)}, ${JSON.stringify(PDF_B)});
        await AIOS.afterFsChange();
        out.push(await inst.ctx.api.clearAll());
        out.push(await inst.ctx.api.refreshMode(true));
        out.push(await inst.ctx.api.choose(${JSON.stringify(CATEGORY)}, ${JSON.stringify(VENDOR_B)}));
        out.push(await inst.ctx.api.addDocs([${JSON.stringify(DOC_B)}]));
        out.push(await inst.ctx.api.runAll());
        out.push([].slice.call(document.querySelectorAll('.ext-table tbody tr')).map(function (tr) {
          return [].slice.call(tr.children).map(function (td) { return td.textContent; });
        }));
      `), { timeout: 120000 });
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.out[1], 'fallback');
      assert.match(r.out[4], /備援解析完成 1 份/, r.out[4]);

      const table = r.out[5];
      assert.equal(table.length, 1);
      assert.equal(table[0][table[0].length - 1], MODEL,
        '_來源 要寫的是備援模型，不是工作室：' + table[0].join(' | '));

      const posts = model.seen.filter((s) => s.method === 'POST');
      assert.ok(posts.length >= 1, '備援模型真的被呼叫了');
      const body = JSON.parse(posts[posts.length - 1].body);
      const text = body.contents[0].parts.find((x) => x.text).text;
      assert.ok(text.startsWith('這是備援用的萃取提示詞'),
        '本機那份提示詞要原封不動排在最前面');
      assert.equal(posts[posts.length - 1].headers['x-goog-api-key'], 'model-secret');
      assert.equal(posts[posts.length - 1].headers['x-api-key'], undefined,
        '工作室的金鑰不可以跑到模型那邊去');
    });
  } finally {
    await new Promise((r) => studio.server.close(() => r()));
    await new Promise((r) => model.server.close(() => r()));
  }
}
