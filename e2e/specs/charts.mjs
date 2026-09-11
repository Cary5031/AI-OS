/* Charts travelling between the three Office programs.

   The unit tests draw a chart against a fake document and write its parts
   with the writers called directly. This drives the real programs the way
   `app.do` does -- a bookkeeping table typed into the spreadsheet, a chart
   made from it, handed to the word processor and the deck, saved in every
   format, and read back -- because the roads between the programs are the
   feature, and none of them exist in a unit test. */

import assert from 'node:assert/strict';
import { run } from '../lib/cdp.mjs';

export const name = '圖表';

const XLSX = '/notes/e2e-charts.xlsx';
const DOCX = '/notes/e2e-charts.docx';
const PPTX = '/notes/e2e-charts.pptx';
const PDF = '/notes/e2e-charts.pdf';
const MD = '/notes/e2e-charts.md';
const HTML = '/notes/e2e-charts.html';

/** Open `app` (once) and run `calls`, which may push onto `out`. */
const via = (app, calls) => `
  var live = AIOS.apps.instances().filter(function (i) { return i.def.id === '${app}'; });
  if (!live.length) await AIOS.apps.launch('${app}');
  var inst;
  for (var i = 0; i < 100; i++) {
    inst = AIOS.apps.instances().filter(function (i) { return i.def.id === '${app}'; })[0];
    if (inst && inst.ctx && inst.ctx.api) break;
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  if (!inst || !inst.ctx || !inst.ctx.api) return { error: '${app} 沒有開起來' };
  var out = [];
  ${calls}
  return { out: out };
`;

/** The names of the parts inside a zip the machine wrote, read off the local headers. */
const partsOf = (vpath) => `
  var b = await window.aios.fs.readBytes('${vpath}');
  if (!b.ok) return { error: b.error };
  var bin = atob(b.data.base64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var text = new TextDecoder('latin1').decode(bytes);
  var names = [];
  var re = /((?:xl|word|ppt)\\/[a-zA-Z0-9_\\/.]+\\.(?:xml|rels))/g, m;
  while ((m = re.exec(text))) if (names.indexOf(m[1]) < 0) names.push(m[1]);
  return { magic: bin.slice(0, 2), names: names };
`;

export async function spec(t, app) {
  const { cdp } = app;

  await run(cdp, `
    for (const p of ${JSON.stringify([XLSX, DOCX, PPTX, PDF, MD, HTML])}) await window.aios.fs.remove(p);
    return 1;
  `);

  await t.test('試算表：一張帳務表變成圖表，自動認出標題列、類別欄與合計列', async () => {
    const r = await run(cdp, via('sheets', `
      out.push(await AIOS.apps.invoke('sheets', 'setRange', { start: 'A1', rows: [
        ['月份', '收入', '支出', '淨利'],
        ['1月', 120000, 80000, 40000], ['2月', 95000, 110000, -15000], ['3月', 130000, 90000, 40000],
        ['4月', 110000, 70000, 40000], ['5月', 140000, 100000, 40000], ['6月', 150000, 95000, 55000],
        ['合計', 745000, 545000, 200000]
      ] }));
      out.push(await AIOS.apps.invoke('sheets', 'insertChart', { range: 'A1:D8', type: '直條圖', title: '上半年收支' }));
      out.push(await AIOS.apps.invoke('sheets', 'charts', {}));
      var inst2 = AIOS.apps.instances().filter(function (i) { return i.def.id === 'sheets'; })[0];
      out.push(inst2.describe ? inst2.describe() : '');
      out.push(document.querySelectorAll('.sh-chart svg').length);
    `), { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);
    const [, inserted, listed, described, drawn] = r.out;
    assert.ok(inserted && inserted.note, JSON.stringify(inserted));
    assert.match(inserted.note, /3 個數列/, '收入、支出、淨利 are the series: ' + inserted.note);
    assert.match(inserted.note, /6 個類別/, 'six months, the 合計 row left out: ' + inserted.note);
    assert.match(listed.note, /直條圖「上半年收支」/);
    assert.match(described, /圖表 c[a-z0-9]+：直條圖「上半年收支」/, 'the model is told about the chart');
    assert.equal(drawn, 1, 'the chart is on the grid');
  });

  await t.test('試算表 → 文件：圖表帶著資料過去，文件存成 .docx 就有圖表部件', async () => {
    const r = await run(cdp, via('sheets', `
      out.push(await AIOS.apps.invoke('sheets', 'chartToApp', { app: 'docs' }));
      for (var w = 0; w < 50 && !document.querySelector('.dc-chart svg'); w++) await new Promise(function (r) { setTimeout(r, 100); });
      out.push(document.querySelectorAll('.dc-chart svg').length);
      out.push(await AIOS.apps.invoke('docs', 'saveAs', { path: '${DOCX}' }));
    `), { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.out[0] && r.out[0].note, JSON.stringify(r.out[0]));
    assert.equal(r.out[1], 1, 'the document shows the chart');
    const parts = await run(cdp, partsOf(DOCX));
    assert.equal(parts.magic, 'PK', '.docx is a zip');
    assert.ok(parts.names.includes('word/charts/chart1.xml'), 'the chart part is in the package: ' + parts.names.join('、'));
  });

  await t.test('文件：.docx 讀回來還是圖表區塊，Markdown 也是', async () => {
    const r = await run(cdp, via('docs', `
      out.push(await AIOS.apps.invoke('docs', 'exportAs', { format: 'md' }));
      var md = await window.aios.fs.read('${MD}');
      out.push(md.ok ? md.data.content : md.error);
      await inst.ctx.api.open('${DOCX}');
      var inst3 = AIOS.apps.instances().filter(function (i) { return i.def.id === 'docs'; })[0];
      out.push(inst3.describe ? inst3.describe() : '');
    `), { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);
    assert.match(String(r.out[1]), /<!-- chart \{"type":"column"/, 'Markdown carries the chart as a comment');
    assert.match(String(r.out[1]), /\| 1月 \| 120,000 \|/, 'and its data as a table');
    assert.match(r.out[2], /\[圖表\] 直條圖「上半年收支」：3 個數列/, 'reopened from .docx: ' + r.out[2].slice(0, 400));
  });

  await t.test('簡報：加一張圖表，存成 .pptx 有圖表部件，.html 匯出帶著行內 SVG', async () => {
    const r = await run(cdp, via('slides', `
      out.push(await AIOS.apps.invoke('slides', 'buildDeck', { title: 'E2E 圖表', slides: [
        { layout: 'title', title: '封面', body: [''] },
        { layout: 'blank', title: '', body: [''] }
      ] }));
      out.push(await AIOS.apps.invoke('slides', 'addChart', { index: 2, type: 'pie', title: '支出占比',
        rows: [['項目', '金額'], ['房租', 30000], ['薪資', 50000], ['水電', 8000], ['雜項', 12000]] }));
      out.push(document.querySelectorAll('.sl-obj-chart svg').length);
      out.push(await AIOS.apps.invoke('slides', 'saveAs', { path: '${HTML}' }));
      var html = await window.aios.fs.read('${HTML}');
      out.push(html.ok ? (html.data.content.indexOf('<svg') >= 0 && html.data.content.indexOf('--ch-1') >= 0) : html.error);
      out.push(await AIOS.apps.invoke('slides', 'saveAs', { path: '${PPTX}' }));
    `), { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);
    assert.match(r.out[1].note, /圓餅圖/, JSON.stringify(r.out[1]));
    assert.ok(r.out[2] >= 1, 'the chart is on the slide');
    const parts = await run(cdp, partsOf(PPTX));
    assert.equal(parts.magic, 'PK');
    assert.ok(parts.names.includes('ppt/charts/chart1.xml'), parts.names.join('、'));
    assert.equal(r.out[4], true, 'the html export draws the chart itself and carries the dark series steps');
  });

  await t.test('試算表：存成 .xlsx 是活的 Excel 圖表，重開還在', async () => {
    const r = await run(cdp, via('sheets', `
      out.push(await AIOS.apps.invoke('sheets', 'saveAs', { path: '${XLSX}' }));
      await inst.ctx.api.open('${XLSX}');
      out.push(await AIOS.apps.invoke('sheets', 'charts', {}));
      out.push(document.querySelectorAll('.sh-chart svg').length);
    `), { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);
    const parts = await run(cdp, partsOf(XLSX));
    assert.equal(parts.magic, 'PK');
    for (const p of ['xl/charts/chart1.xml', 'xl/drawings/drawing1.xml', 'xl/worksheets/_rels/sheet1.xml.rels']) {
      assert.ok(parts.names.includes(p), p + ' missing from ' + parts.names.join('、'));
    }
    assert.match(r.out[1].note, /直條圖「上半年收支」/, 'the chart came back bound to its cells: ' + r.out[1].note);
    assert.equal(r.out[2], 1);
  });

  await t.test('文件：PDF 真的寫出來，而且圖表區塊可以轉回表格', async () => {
    const r = await run(cdp, via('docs', `
      out.push(await AIOS.apps.invoke('docs', 'exportAs', { format: 'pdf' }));
      var f = await window.aios.fs.readBytes('${PDF}');
      out.push(f.ok ? atob(f.data.base64.slice(0, 8)).slice(0, 5) : f.error);
      // Whichever block the chart landed in when the .docx was read back.
      var at = Array.prototype.map.call(document.querySelectorAll('.dc-block'), function (row) {
        return row.querySelector('.dc-chart') ? Number(row.dataset.bi) + 1 : 0;
      }).filter(Boolean)[0];
      out.push(at);
      out.push(await AIOS.apps.invoke('docs', 'chartToTable', { index: at }));
      out.push(document.querySelectorAll('.dc-chart').length);
      out.push(document.querySelectorAll('.dc-table').length);
    `), { timeout: 90000 });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.out[1], '%PDF-', 'a PDF was written: ' + r.out[1]);
    assert.ok(r.out[2] > 0, 'the reopened document still holds the chart');
    assert.ok(r.out[3] && r.out[3].note, JSON.stringify(r.out[3]));
    assert.equal(r.out[4], 0, 'the chart block is gone');
    assert.ok(r.out[5] >= 1, 'and a table took its place');
  });
}
