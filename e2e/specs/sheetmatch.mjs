/* Two sheets, matched by meaning within a PO, driven through the spreadsheet's
   own actions. No model here: the rows that need a judgement are sent to
   review with the reason, and the person's choices come back through 套用選擇.
   The judgement itself is covered by the unit tests of the prompt and the
   reading of the answer, and by a run against the real model for the manual. */
import assert from 'node:assert/strict';
import { run } from '../lib/cdp.mjs';

export const name = '兩張表對照';

/** A fresh spreadsheet window with the two tables in it, then the body. */
const via = (body) => `
  AIOS.apps.instances().filter(function (i) { return i.def.id === 'sheets'; })
    .forEach(function (i) { AIOS.wm.close(i.win); });
  await new Promise(function (r) { setTimeout(r, 200); });
  await AIOS.apps.launch('sheets');
  var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'sheets'; }).pop();
  for (var i = 0; i < 100 && (!inst || !inst.ctx || !inst.ctx.api); i++) {
    await new Promise(function (r) { setTimeout(r, 100); });
    inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'sheets'; }).pop();
  }
  if (!inst || !inst.ctx || !inst.ctx.api) return { error: '試算表沒有開起來' };
  var out = [];
  var cellsOf = function (name) {
    var st = inst.ctrl.getState();
    var s = st.sheets.filter(function (x) { return x.name === name; })[0];
    return s ? s.cells : null;
  };
  var v = function (name, ref) { var c = (cellsOf(name) || {})[ref]; return c ? (c.v !== undefined ? c.v : c.f) : ''; };
  var bg = function (name, ref) { var c = (cellsOf(name) || {})[ref]; return c ? (c.bg || '') : ''; };
  try {
    ${body}
  } catch (e) {
    return { error: String(e && e.message || e), out: out };
  }
  return { out: out };
`;

const SEED = `
  out.push(await AIOS.apps.invoke('sheets', 'setRange', { start: 'A1', rows: [
    ['PO號碼', 'item描述', '數量'],
    ['1001', '不鏽鋼螺絲 M6x20 A2', 500],
    ['1001', '平墊圈 M6', 800],
    ['1002', '六角螺栓 M10x40', 120],
    ['1003', '尼龍墊片', 50]
  ] }));
  out.push(await AIOS.apps.invoke('sheets', 'addSheet', { name: '公司資料' }));
  out.push(await AIOS.apps.invoke('sheets', 'setRange', { start: 'A1', rows: [
    ['PO No.', '貨號', '品名', '庫存'],
    ['1001', 'SS-M6-20', '不銹鋼螺絲 M6*20 A2-70', 300],
    ['1001', 'WS-M6', '平墊圈 M6 DIN125', 1000],
    ['1002', 'HB-M10-40', '六角螺栓 M10*40 8.8', 60]
  ] }));
  out.push(await AIOS.apps.invoke('sheets', 'selectSheet', { name: '工作表1' }));
`;

export async function spec(t, app) {
  const { cdp } = app;

  await t.test('對照：對得上的填貨號，判斷不了的進待確認，對方沒有的 PO 說出來', async () => {
    const r = await run(cdp, via(SEED + `
      var m = await AIOS.apps.invoke('sheets', 'match', {
        source: { sheet: '公司資料' },
        key: { mine: 'PO號碼', theirs: 'PO No.' },
        compare: { mine: 'item描述', theirs: '品名' },
        take: [{ theirs: '貨號', into: 'D' }],
        model: false
      });
      out.push(m.note);
      out.push([v('工作表1', 'D1'), v('工作表1', 'D2'), v('工作表1', 'D3'), v('工作表1', 'D4'), v('工作表1', 'D5')]);
      out.push([v('工作表1', 'E1'), v('工作表1', 'E4'), v('工作表1', 'F1'), String(v('工作表1', 'F4'))]);
      out.push([bg('工作表1', 'D2'), bg('工作表1', 'D4')]);
      out.push(String(v('工作表1', 'F5')));
      out.push([v('待確認', 'A1'), v('待確認', 'I1'), v('待確認', 'A2'), v('待確認', 'D2'), v('待確認', 'F2'), v('待確認', 'A4'), v('待確認', 'H4'), v('待確認', 'D3')]);
      out.push(inst.ctrl.getState().sheets.map(function (s) { return s.name; }));
    `), { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);
    const [, , , , note, d, ef, fills, why5, review, sheets] = r.out;
    assert.match(note, /對上 1 筆（高 1、中 0）/, note);
    assert.match(note, /待確認 3 筆/, note);
    assert.match(note, /對方沒有的鍵值：1003/, note);
    assert.match(note, /用「PO號碼」對「PO No.」，比對「item描述」與「品名」，「貨號」→D 欄/, 'the receipt restates the mapping it used: ' + note);
    assert.deepEqual(d, ['貨號', '待確認', '待確認', 'HB-M10-40', '待確認'],
      'the lone 1002 candidate is taken; the two 1001 rows and the missing 1003 wait');
    assert.deepEqual(ef.slice(0, 3), ['信心', '高', '依據']);
    assert.match(ef[3], /唯一候選/);
    assert.equal(fills[0], 'FFF2CC', 'a 待確認 cell is marked');
    assert.equal(fills[1], '', 'a matched one is not');
    assert.match(why5, /沒有這個鍵值/);
    assert.deepEqual(review.slice(0, 2), ['列', '選擇']);
    assert.equal(review[2], 2, 'row 2 of the order is the first review row');
    assert.equal(review[3], 'SS-M6-20', 'with the bolt as candidate 1');
    assert.equal(review[4], 'WS-M6', 'and the washer as candidate 2');
    assert.equal(review[5], 5);
    assert.match(review[6], /沒有這個鍵值/);
    assert.equal(review[7], 'WS-M6', 'candidate 1 is the likeliest for that row: the washer row leads with the washer');
    assert.deepEqual(sheets, ['工作表1', '公司資料', '待確認']);
  });

  await t.test('套用選擇：1、2 或直接填的貨號寫回原表，依據寫人工，清單移掉那幾列', async () => {
    const r = await run(cdp, via(SEED + `
      await AIOS.apps.invoke('sheets', 'match', {
        source: { sheet: '公司資料' }, key: { mine: 'PO號碼', theirs: 'PO No.' },
        compare: { mine: 'item描述', theirs: '品名' }, take: [{ theirs: '貨號', into: 'D' }], model: false
      });
      /* 「第 1 列選候選 1」 as the sentence says it: no cell to find. Row 2 (the
         bolt) leads with the bolt. */
      var first = await AIOS.apps.invoke('sheets', 'applyChoices', { choices: [{ item: 1, pick: 1 }] });
      out.push(first.note);
      /* The rest by hand in the 選擇 column: the list is now rows 3 and 5. Row 3
         (the washer) leads with the washer; row 5 has no candidate. */
      await AIOS.apps.invoke('sheets', 'selectSheet', { name: '待確認' });
      out.push(await AIOS.apps.invoke('sheets', 'setRange', { start: 'I2', rows: [['1'], ['NY-WASHER']] }));
      var a = await AIOS.apps.invoke('sheets', 'applyChoices', {});
      out.push(a.note);
      out.push([v('工作表1', 'D2'), v('工作表1', 'D3'), v('工作表1', 'D5'), v('工作表1', 'E2'), v('工作表1', 'F3'), bg('工作表1', 'D2')]);
      out.push([v('待確認', 'A1'), v('待確認', 'A2')]);
      out.push(inst.ctrl.getState().sheets[inst.ctrl.getState().active].name);
      try { await AIOS.apps.invoke('sheets', 'applyChoices', {}); out.push('沒擋'); } catch (e) { out.push(String(e.message)); }
    `), { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);
    const [, , , , first, , note, cells, review, active, again] = r.out;
    assert.match(first, /套用了 1 筆，還有 2 筆沒填選擇/, first);
    assert.match(note, /套用了 2 筆/, note);
    assert.match(note, /清空了/);
    assert.deepEqual(cells, ['SS-M6-20', 'WS-M6', 'NY-WASHER', '人工', '人工選擇', ''],
      '1 and 2 are the candidates that row was shown; anything else is the value itself');
    assert.deepEqual(review, ['列', ''], 'the review sheet keeps its header and nothing else');
    assert.equal(active, '工作表1', 'the window comes back to the sheet that was written');
    assert.match(again, /「選擇」欄都還是空的/, 'nothing left to apply is said, not silently done');
  });

  await t.test('讀不出欄位就問，不猜：兩個像的欄名回一個問題，找不到的列出有哪些', async () => {
    const r = await run(cdp, via(SEED + `
      await AIOS.apps.invoke('sheets', 'selectSheet', { name: '公司資料' });
      await AIOS.apps.invoke('sheets', 'setRange', { start: 'E1', rows: [['品名（英文）']] });
      await AIOS.apps.invoke('sheets', 'selectSheet', { name: '工作表1' });
      try {
        await AIOS.apps.invoke('sheets', 'match', { source: { sheet: '公司資料' }, key: 'PO', compare: { mine: 'item描述', theirs: '名' }, take: ['貨號'], model: false });
        out.push('沒問');
      } catch (e) { out.push(String(e.message)); }
      try {
        await AIOS.apps.invoke('sheets', 'match', { source: { sheet: '沒有這張' }, key: 'PO', compare: 'item描述', take: ['貨號'], model: false });
        out.push('沒說');
      } catch (e) { out.push(String(e.message)); }
      try {
        await AIOS.apps.invoke('sheets', 'match', { source: { sheet: '公司資料' }, key: 'PO', compare: { mine: 'item描述', theirs: '品名' }, take: ['單價'], model: false });
        out.push('沒說');
      } catch (e) { out.push(String(e.message)); }
    `), { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);
    const [, , , , ambiguous, noSheet, noCol] = r.out;
    assert.match(ambiguous, /「品名」（C 欄）/, ambiguous);
    assert.match(ambiguous, /「品名（英文）」（E 欄）/, ambiguous);
    assert.match(ambiguous, /要哪一個？/);
    assert.match(noSheet, /沒有工作表「沒有這張」，有：工作表1、公司資料/, noSheet);
    assert.match(noCol, /「單價」在這張表找不到。欄名有：PO No.（A）、貨號（B）/, noCol);
  });
}
