/* Bookmarks, and the URLs the browser remembers on its own.

   The interesting parts are the refusals -- a bookmark is a URL the browser will
   later be asked to open, so what it declines to store matters as much as what
   it keeps. The restore case at the end is the same question asked of a URL
   nobody chose to save: what the browser does when the page it remembers is
   gone. */

import assert from 'node:assert/strict';
import { run } from '../lib/cdp.mjs';

export const name = '書籤與瀏覽器還原';

export async function spec(t, app) {
  const { cdp } = app;

  await t.test('加入、去重、改名、刪除', async () => {
    const r = await run(cdp, `
      var out = {};
      var a = await window.aios.bookmarks.add('https://example.com/one', '第一個', '測試');
      out.added = a.ok && a.data.entry.title;

      // The same URL again updates rather than duplicating: two rows pointing at
      // one page is a list nobody can keep tidy.
      var again = await window.aios.bookmarks.add('https://example.com/one', '改過的名字', '測試');
      out.updated = again.ok && again.data.updated;

      var list = await window.aios.bookmarks.list({ folder: '測試' });
      out.count = list.data.length;
      out.title = list.data[0].title;

      var ren = await window.aios.bookmarks.rename(list.data[0].id, '最終名字', '別的資料夾');
      out.renamed = ren.ok && ren.data.folder;

      var folders = await window.aios.bookmarks.folders();
      out.folders = folders.data;

      var gone = await window.aios.bookmarks.remove(list.data[0].id);
      out.removed = gone.ok && gone.data.removed;
      return out;
    `);
    assert.equal(r.added, '第一個');
    assert.equal(r.updated, true, '同一個網址加第二次應該是更新，不是新增一筆');
    assert.equal(r.count, 1, '去重沒有生效：' + r.count);
    assert.equal(r.title, '改過的名字');
    assert.equal(r.renamed, '別的資料夾');
    assert.ok(r.folders.includes('別的資料夾'), '資料夾清單不對：' + r.folders);
    assert.equal(r.removed, true);
  });

  await t.test('只收 http/https，其他一律拒絕', async () => {
    /* A bookmark is something the browser is later told to open. `javascript:`
       stored here would be a stored script waiting for a click, and `file:`
       would reach outside the sandbox -- both are refused at the point of
       storage rather than at the point of use. */
    const r = await run(cdp, `
      var bad = ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,<b>x',
                 'aios-app://something/index.html', '不是網址'];
      var out = [];
      for (var i = 0; i < bad.length; i++) {
        var res = await window.aios.bookmarks.add(bad[i], 'x', '');
        out.push(bad[i].slice(0, 24) + ' => ' + (res.ok ? 'ACCEPTED' : 'rejected'));
      }
      return out;
    `);
    for (const line of r) {
      assert.ok(line.endsWith('rejected'), '這個網址不該被收進書籤：' + line);
    }
  });

  await t.test('匯出成 HTML 再匯入，內容對得回來', async () => {
    const r = await run(cdp, `
      await window.aios.bookmarks.add('https://example.com/a', 'A 頁', '匯出測試');
      await window.aios.bookmarks.add('https://example.com/b', 'B 頁', '匯出測試');

      var exp = await window.aios.bookmarks.exportTo('/notes/e2e-bookmarks.html');
      if (!exp.ok) return { error: exp.error };
      var file = await window.aios.fs.read('/notes/e2e-bookmarks.html');

      // Clear the two, then bring them back from the file.
      var before = await window.aios.bookmarks.list({ folder: '匯出測試' });
      for (var i = 0; i < before.data.length; i++) {
        await window.aios.bookmarks.remove(before.data[i].id);
      }
      var emptied = (await window.aios.bookmarks.list({ folder: '匯出測試' })).data.length;

      var imp = await window.aios.bookmarks.importFrom('/notes/e2e-bookmarks.html');
      var after = await window.aios.bookmarks.list({ folder: '匯出測試' });
      return {
        // Long enough to reach the charset line, which sits after the DOCTYPE.
        html: file.data.content.slice(0, 200),
        emptied: emptied,
        imported: imp.ok && imp.data.added,
        back: after.data.map(function (b) { return b.title + '|' + b.url + '|' + b.folder; }).sort()
      };
    `);
    assert.ok(!r.error, '匯出失敗：' + r.error);
    assert.match(r.html, /NETSCAPE-Bookmark-file-1/,
      '匯出的不是標準格式，別的瀏覽器匯不進去');
    /* This format predates HTML5 and carries no encoding of its own, so a
       browser importing the file guesses from the locale -- CP950 on a
       Traditional Chinese Windows -- and every CJK title arrives as mojibake.
       Every browser writes this line in its own export for that reason. */
    assert.match(r.html, /charset=UTF-8/i,
      '沒有宣告編碼，別的瀏覽器匯進去中文會變亂碼');
    assert.equal(r.emptied, 0, '清除沒有成功，後面的驗證就沒有意義');
    assert.ok(r.imported >= 2, '匯入的筆數不對：' + r.imported);
    assert.deepEqual(r.back, [
      'A 頁|https://example.com/a|匯出測試',
      'B 頁|https://example.com/b|匯出測試'
    ], '匯出再匯入之後對不回來');
  });
  await t.test('還原不回來的頁面，下次開機不會再試一次', async () => {
    /* An e2e run left a browser window pointing at its own throwaway loopback
       server. Every launch after that opened with a red 「載入失敗：
       ERR_CONNECTION_REFUSED」 naming no URL, and nothing the user could do
       about it except open the browser and navigate away.

       Restoring is not the same as being asked, so a failure means something
       different: show it, say which page, and stop reaching for it. */
    const r = await run(cdp, `
      // A port nothing is listening on. Deliberately not a real site: this must
      // not depend on the network.
      var dead = 'http://127.0.0.1:9/';

      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
      if (inst) AIOS.wm.close(inst.win);
      await new Promise(function (r) { setTimeout(r, 300); });

      await AIOS.apps.launch('browser', dead);
      inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })[0];
      if (!inst) return { error: '瀏覽器沒開起來' };
      for (var i = 0; i < 60 && !inst.ctrl; i++) await new Promise(function (r) { setTimeout(r, 100); });

      // Asked for, not restored: this one is allowed to complain loudly.
      await new Promise(function (r) { setTimeout(r, 2500); });
      var asked = inst.ctrl && inst.ctrl.getState ? inst.ctrl.getState() : null;

      // Now restore a window that already holds a failed page.
      AIOS.wm.close(inst.win);
      await new Promise(function (r) { setTimeout(r, 300); });
      return { asked: asked, dead: dead };
    `, { timeout: 60000 });

    assert.equal(r.error, undefined, r.error);
    assert.ok(r.asked, '拿不到瀏覽器狀態');
    assert.equal(r.asked.restoreFailed, false,
      '使用者自己要求的網址載入失敗，不該被記成「還原失敗」');

    /* Restoring that same state is what boot does. The window must come up with
       the address visible and no load attempted. */
    const restored = await run(cdp, `
      var st = { url: 'http://127.0.0.1:9/', mode: 'live', restoreFailed: true };
      var inst = await AIOS.apps.launch('browser', undefined, { forceNew: true, state: st });
      inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; }).pop();
      for (var i = 0; i < 60 && !inst.ctrl; i++) await new Promise(function (r) { setTimeout(r, 100); });
      await new Promise(function (r) { setTimeout(r, 1200); });
      var tab = inst.ctx.api && inst.ctx.api.tabId ? inst.ctx.api.tabId() : null;
      var addr = inst.win.el.querySelector('.br-bar input');
      var out = { tab: tab, addr: addr ? addr.value : null };
      AIOS.wm.close(inst.win);
      return out;
    `, { timeout: 60000 });

    assert.equal(restored.tab, null, '還原失敗的頁面不該再開一個分頁去載入它');
    assert.equal(restored.addr, 'http://127.0.0.1:9/',
      '網址還是要看得到，使用者才能按 ↻ 重試');
  });

  await t.test('多個頁面只開一個視窗，用分頁裝', async () => {
    /* A run that produced a hundred notes opened a hundred windows, and the
       shell became a slideshow: every window is a composited layer with a
       blurred backdrop, so scrolling made content blank out and come back while
       the compositor rebuilt tiles. Pages belong in tabs. */
    const r = await run(cdp, `
      AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; })
        .forEach(function (i) { AIOS.wm.close(i.win); });
      await new Promise(function (r) { setTimeout(r, 400); });

      // Three different pages, opened the way a plan opens them.
      var urls = ['http://127.0.0.1:9/a', 'http://127.0.0.1:9/b', 'http://127.0.0.1:9/c'];
      for (var i = 0; i < urls.length; i++) {
        await AIOS.apps.launch('browser', urls[i]);
        await new Promise(function (r) { setTimeout(r, 500); });
      }
      var live = AIOS.apps.instances().filter(function (i) { return i.def.id === 'browser'; });
      var inst = live[0];
      var out = { windows: live.length, tabs: inst ? inst.ctx.api.tabs().length : 0 };

      // Exactly one native view belongs to the visible tab.
      out.active = inst ? inst.ctx.api.tabId() : null;
      out.ids = inst ? inst.ctx.api.tabs().map(function (s) { return s.id; }) : [];
      out.activeIsATab = out.ids.indexOf(out.active) >= 0;

      // Closing the window must take every view with it.
      if (inst) AIOS.wm.close(inst.win);
      await new Promise(function (r) { setTimeout(r, 600); });
      var left = await window.aios.browser.list();
      out.viewsLeft = (left.data || []).filter(function (t) {
        return out.ids.indexOf(t.id) >= 0;
      }).length;
      return out;
    `, { timeout: 90000 });

    assert.equal(r.windows, 1, '三個頁面開出了 ' + r.windows + ' 個視窗');
    assert.equal(r.tabs, 3, '分頁數不對：' + r.tabs);
    assert.ok(r.activeIsATab, '作用中的分頁不在分頁清單裡');
    assert.equal(r.viewsLeft, 0, '關掉視窗之後還有 ' + r.viewsLeft + ' 個原生 view 活著');
  });

  await t.test('多份文件只開一個編輯器視窗', async () => {
    const r = await run(cdp, `
      AIOS.apps.instances().filter(function (i) { return i.def.id === 'editor'; })
        .forEach(function (i) { AIOS.wm.close(i.win); });
      await new Promise(function (r) { setTimeout(r, 400); });
      for (var i = 1; i <= 5; i++) {
        await window.aios.fs.write('/notes/e2e-tab-' + i + '.txt', 'x' + i);
      }
      for (var j = 1; j <= 5; j++) await AIOS.apps.openPath('/notes/e2e-tab-' + j + '.txt');
      await new Promise(function (r) { setTimeout(r, 600); });
      var eds = AIOS.apps.instances().filter(function (i) { return i.def.id === 'editor'; });
      var out = { windows: eds.length, tabs: eds.length ? eds[0].ctx.api.tabs().length : 0 };
      // Opening one that is already open lands on its tab rather than adding another.
      await AIOS.apps.openPath('/notes/e2e-tab-3.txt');
      await new Promise(function (r) { setTimeout(r, 300); });
      out.again = eds.length ? eds[0].ctx.api.tabs().length : 0;
      for (var k = 1; k <= 5; k++) await window.aios.fs.remove('/notes/e2e-tab-' + k + '.txt');
      return out;
    `, { timeout: 90000 });

    assert.equal(r.windows, 1, '五份文件開出了 ' + r.windows + ' 個視窗');
    assert.equal(r.tabs, 5, '分頁數不對：' + r.tabs);
    assert.equal(r.again, 5, '開一份已經開著的文件不該再加一個分頁');
  });
}
