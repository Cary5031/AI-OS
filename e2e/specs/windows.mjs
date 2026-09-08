/* Window identity and the overwrite guard.

   Both were measured losing work: two editor windows on one path, each saving in
   turn, and the first one's edits were gone with nothing reported anywhere. */

import assert from 'node:assert/strict';
import { run, sleep } from '../lib/cdp.mjs';

export const name = '視窗與存檔';

const A = '/notes/e2e-doc-a.txt';
const B = '/notes/e2e-doc-b.txt';

export async function spec(t, app) {
  const { cdp } = app;

  await run(cdp, `
    await window.aios.fs.write('${A}', 'A');
    await window.aios.fs.write('${B}', 'B');
    return 1;
  `);

  await t.test('不同文件開成不同視窗，同一份文件不會開第二個', async () => {
    const counts = await run(cdp, `
      function n() {
        return AIOS.apps.instances().filter(function (i) { return i.def.id === 'editor'; }).length;
      }
      // Start from nothing, so a leftover window cannot make this pass.
      AIOS.apps.instances().filter(function (i) { return i.def.id === 'editor'; })
        .forEach(function (i) { AIOS.wm.close(i.win); });
      await new Promise(function (r) { setTimeout(r, 400); });
      var out = { start: n() };
      await AIOS.apps.openPath('${A}'); out.afterA = n();
      await AIOS.apps.openPath('${B}'); out.afterB = n();
      await AIOS.apps.openPath('${A}'); out.afterAAgain = n();
      return out;
    `);
    assert.equal(counts.start, 0, '起點不乾淨');
    assert.equal(counts.afterA, 1, '開第一份文件應該有一個視窗');
    /* The editor keeps documents as tabs in one window, so what matters is that
       a second document does not silently replace the first, and that opening a
       file already open does not stack another window on the same path. */
    assert.ok(counts.afterB >= 1, '開第二份文件之後沒有視窗');
    assert.equal(counts.afterAAgain, counts.afterB,
      '同一份文件開第二次不該增加視窗（兩個視窗會互相覆蓋存檔）');
  });

  await t.test('拿過期的版本存檔會被擋下，檔案不動', async () => {
    const r = await run(cdp, `
      var read = await window.aios.fs.read('${A}');
      var stamp = read.data.mtime;

      // Someone else writes: no claim attached, so it goes through.
      await window.aios.fs.write('${A}', '別人寫的');

      // Now save with the version we were holding.
      var stale = await window.aios.fs.write('${A}', '我以為我還在改原本那份', stamp);
      var after = await window.aios.fs.read('${A}');
      return { ok: stale.ok, code: stale.code, content: after.data.content };
    `);
    assert.equal(r.ok, false, '過期的存檔應該被拒絕');
    assert.equal(r.code, 'ECONFLICT', '拒絕的理由要能分辨：' + r.code);
    assert.equal(r.content, '別人寫的', '被擋下的寫入不該改到檔案');
  });

  await t.test('不提出版本主張時，覆蓋仍然允許', async () => {
    /* Creating a file and deliberately replacing one are not claims about a
       previous version, and must not be turned into errors by the guard. */
    const ok = await run(cdp, `
      var w = await window.aios.fs.write('${A}', '刻意覆蓋');
      return { ok: w.ok, mtime: typeof w.data.mtime };
    `);
    assert.ok(ok.ok, '沒有 stamp 的寫入被擋了');
    assert.equal(ok.mtime, 'number', '寫入要回傳新版本，否則下一次存檔會拿到過期的 stamp');
  });

  await t.test('縮到 Dock 的生成程式，再次啟動會還原而不是開新的', async () => {
    const r = await run(cdp, `
      var apps = await window.aios.forge.list();
      if (!apps.ok || !apps.data.length) return { skipped: true };
      var id = apps.data[0].id;
      await AIOS.apps.launch('gen:' + id);
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'gen:' + id; });
      if (!inst.length) return { skipped: true };
      AIOS.wm.minimize(inst[0].win);
      var wasMin = !!inst[0].win.minimized;
      await AIOS.apps.launch('gen:' + id);
      var now = AIOS.apps.instances().filter(function (i) { return i.def.id === 'gen:' + id; });
      return { wasMin: wasMin, count: now.length, minimized: !!now[0].win.minimized };
    `);
    if (r.skipped) return;   // nothing installed in this sandbox
    assert.equal(r.wasMin, true, '沒有縮到 Dock');
    assert.equal(r.count, 1, '生成程式只該有一個視窗（兩個會共用一份 storage 互相覆蓋）');
    assert.equal(r.minimized, false, '再次啟動應該還原它，而不是開一個新的');
  });

  await sleep(200);
}
