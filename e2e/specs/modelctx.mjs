/* The core's context window, typed in by hand for a provider that reports none.

   Before 1.0.37 the machine said 「n_ctx 未知……可以在模型設定裡自己填」 and the
   settings window had no such field, so the budget slider sat at 32,640 whatever
   the user did; and a context window learned after boot never reached the
   slider at all. This drives the real window: a loopback server answers /models
   with an id and nothing else, a number goes into 上下文長度, 儲存 is pressed,
   and the slider has to follow -- with no restart and no separate reconnect.

   The custom provider is pointed at the loopback server for the length of this
   spec and put back afterwards, the way translate and pdflayout do it. */

import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../lib/cdp.mjs';

export const name = '核心模型的上下文長度';

export async function spec(t, app) {
  const { cdp } = app;
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'house-model', object: 'model', owned_by: 'e2e' }] }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  let before = null;

  try {
    await t.test('供應商不報上限：n_ctx 未知，預算滑桿退回 32,640', async () => {
      const r = await run(cdp, `
        var st = await window.aios.model.state();
        var before = { active: st.data.active,
          config: (st.data.providers.find(function (p) { return p.id === 'custom'; }) || {}).config };
        var c = await window.aios.model.configure('custom', {
          base: ${JSON.stringify(base)}, model: 'house-model', auth: 'none',
          json: 'object', reasoningKind: 'none', maxOut: 0, ctx: 0
        });
        if (!c.ok) return { error: c.error, before: before };
        var s = await window.aios.model.select('custom');
        if (!s.ok) return { error: s.error, before: before };
        document.querySelector('#drop-system [data-act="reconnect"]').click();
        for (var i = 0; i < 100 && AIOS.state.model !== 'house-model'; i++) {
          await new Promise(function (r2) { setTimeout(r2, 100); });
        }
        return { before: before, model: AIOS.state.model, nCtx: AIOS.state.nCtx,
          max: document.getElementById('budget-slider').max };
      `, { timeout: 30000 });
      before = r.before;
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.model, 'house-model');
      assert.equal(r.nCtx, 0, 'the server named no window, and nothing else knows this model');
      assert.equal(r.max, '32640', 'the reconnect refitted the slider to the unknown-window fallback');
    });

    await t.test('在「核心模型」視窗填上下文長度、按儲存，n_ctx 與滑桿立刻跟著走', async () => {
      const r = await run(cdp, `
        document.querySelector('#drop-system [data-act="endpoint"]').click();
        var input = null;
        for (var i = 0; i < 100 && !input; i++) {
          input = document.querySelector('input[aria-label="上下文長度"]');
          if (!input) await new Promise(function (r2) { setTimeout(r2, 100); });
        }
        if (!input) return { error: '核心模型視窗裡沒有上下文長度欄位' };
        var shown = input.value;
        input.value = '200000';
        var save = Array.prototype.find.call(document.querySelectorAll('.mp-actions button'),
          function (b) { return b.textContent === '儲存'; });
        if (!save) return { error: '找不到儲存按鈕' };
        save.click();
        for (var j = 0; j < 100 && AIOS.state.nCtx !== 200000; j++) {
          await new Promise(function (r2) { setTimeout(r2, 100); });
        }
        var st = await window.aios.model.state();
        return {
          shown: shown,
          saved: st.data.providers.find(function (p) { return p.id === 'custom'; }).config.ctx,
          nCtx: AIOS.state.nCtx,
          source: AIOS.state.nCtxSource,
          max: Number(document.getElementById('budget-slider').max),
          budget: AIOS.state.budget
        };
      `, { timeout: 30000 });
      assert.equal(r.error, undefined, r.error);
      assert.equal(r.shown, '0', 'the field shows what is stored');
      assert.equal(r.saved, 200000, 'what is typed is stored');
      assert.equal(r.nCtx, 200000, 'saving the core in use re-handshakes with it');
      assert.equal(r.source, 'user');
      assert.ok(r.max > 100000, 'the slider is sized from it, not left at 32,640: ' + r.max);
      assert.equal(r.budget, r.max, 'and the old fallback budget is raised to the new top');
    });
  } finally {
    await run(cdp, `
      var w = AIOS.wm.find('sys:model');
      if (w) AIOS.wm.close(w);
      var before = ${JSON.stringify(before)};
      if (before) {
        await window.aios.model.configure('custom', Object.assign({ ctx: 0 }, before.config || {}));
        await window.aios.model.select(before.active);
        document.querySelector('#drop-system [data-act="reconnect"]').click();
      }
      return 1;
    `, { timeout: 30000 }).catch(() => {});
    server.close();
  }
}
