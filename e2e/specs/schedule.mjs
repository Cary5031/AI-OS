/* The scheduler: a job is set, fired, run in the renderer, and reported back
   to the clock in main. Costs nothing -- the action job drives the memory app,
   and the intent job proves that a machine with no model reports the failure
   instead of pretending. */

import assert from 'node:assert/strict';
import { run } from '../lib/cdp.mjs';

export const name = '排程';

export async function spec(t, app) {
  const { cdp } = app;

  await t.test('程式動作的排程：設定、立即執行、回報、刪除', async () => {
    const out = await run(cdp, `
      var tag = 'e2e-排程-' + Date.now();
      var add = await window.aios.schedule.add({ name: tag, every: '1h', app: 'memory', action: 'remember', args: { text: tag, tags: 'e2e' } });
      if (!add.ok) return { error: add.error };
      var job = add.data;
      var ran = await window.aios.schedule.runNow(job.id);
      var done = null;
      for (var i = 0; i < 150; i++) {
        var l = await window.aios.schedule.list();
        var j = l.data.find(function (x) { return x.id === job.id; });
        if (j && j.runs > 0) { done = j; break; }
        await new Promise(function (r) { setTimeout(r, 200); });
      }
      var mem = await window.aios.memory.search(tag, 3);
      var hit = mem.ok ? mem.data.find(function (h) { return h.item.text === tag; }) : null;
      if (hit) await window.aios.memory.remove(hit.item.id);
      var rm = await window.aios.schedule.remove(job.id);
      var after = await window.aios.schedule.list();
      var trace = [...document.querySelectorAll('#trace .t-line')].map(function (n) { return n.textContent; })
        .filter(function (s) { return s.indexOf('[排程]') >= 0; });
      return { kind: job.kind, every: job.every, runNowOk: ran.ok, done: done, found: !!hit, removed: rm.ok,
        gone: !after.data.some(function (x) { return x.id === job.id; }), trace: trace };
    `, { timeout: 90000 });
    assert.ok(!out.error, '設定排程失敗：' + out.error);
    assert.equal(out.kind, 'action');
    assert.equal(out.every, 3600, '"1h" 要解析成 3600 秒');
    assert.ok(out.runNowOk, '立即執行被拒');
    assert.ok(out.done, '執行後沒有回報（runs 一直是 0）');
    assert.equal(out.done.runs, 1);
    assert.ok(out.done.lastResult && out.done.lastResult.ok, '回報應該是成功：' + JSON.stringify(out.done.lastResult));
    assert.ok(out.done.dueIn > 3000, '下次執行要從回報時起算，約一小時後');
    assert.ok(out.found, '動作真的執行了：記憶裡要有那一筆');
    assert.ok(out.removed && out.gone, '刪除後清單裡不該還有');
    assert.ok(out.trace.some((s) => /開始/.test(s)) && out.trace.some((s) => /完成/.test(s)),
      '軌跡要有開始與完成兩行：' + out.trace.join(' | '));
  });

  await t.test('意圖的排程在沒有模型時回報失敗，不假裝做完', async () => {
    const out = await run(cdp, `
      var add = await window.aios.schedule.add({ name: 'e2e-意圖', every: 600, intent: '看看有沒有新信' });
      if (!add.ok) return { error: add.error };
      var job = add.data;
      await window.aios.schedule.runNow(job.id);
      var done = null;
      for (var i = 0; i < 300; i++) {
        var l = await window.aios.schedule.list();
        var j = l.data.find(function (x) { return x.id === job.id; });
        if (j && j.runs > 0) { done = j; break; }
        await new Promise(function (r) { setTimeout(r, 200); });
      }
      await window.aios.schedule.remove(job.id);
      return { kind: job.kind, done: done, connected: AIOS.state.connected };
    `, { timeout: 120000 });
    assert.ok(!out.error, out.error);
    assert.equal(out.kind, 'intent');
    assert.ok(out.done, '沒有回報');
    if (!out.connected) {
      assert.equal(out.done.lastResult.ok, false, '沒有模型就該是失敗');
      assert.match(out.done.lastResult.note, /模型/, '而且要說是模型的問題：' + out.done.lastResult.note);
    }
  });

  await t.test('壞的設定會被拒絕，而且說原因', async () => {
    const out = await run(cdp, `
      var a = await window.aios.schedule.add({ name: 'x', every: 3, intent: 'y' });
      var b = await window.aios.schedule.add({ name: '', every: '5m', intent: 'y' });
      var c = await window.aios.schedule.add({ name: 'x', every: 'soon', intent: 'y' });
      var d = await window.aios.schedule.add({ name: 'x', every: '5m', app: 'mail' });
      var e = await window.aios.schedule.runNow('nope');
      return [a, b, c, d, e].map(function (r) { return r.ok ? 'ok' : r.error; });
    `);
    assert.match(out[0], /最短/, '太短');
    assert.match(out[1], /名稱/, '沒名字');
    assert.match(out[2], /看不懂/, '看不懂的間隔');
    assert.match(out[3], /app 與 action/, '動作少欄位');
    assert.match(out[4], /沒有這個排程/, '不存在的 id');
  });
}
