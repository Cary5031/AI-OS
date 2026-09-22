/* What has to be true once this machine has come up.
   Every one of these was a real failure at some point, most of them only
   visible from outside the source tree. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate, run } from '../lib/cdp.mjs';
import { ROOT } from '../lib/app.mjs';

export const name = '開機';

export async function spec(t, app, { fresh = false } = {}) {
  const { cdp } = app;

  await t.test('系統 → 版本說明：這個行程自己報的版本，不是檔名上的', async () => {
    /* The version lived only in the exe's file name -- and the packaged run
       copies the exe to a plain AI-OS.exe, so here the file name says nothing.
       What the process reports has to be what package.json said when it was
       built, and the window has to show that number with its own notes. */
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const r = await run(cdp, `
      var about = await window.aios.about();
      if (!about.ok) return { error: about.error };
      var item = document.querySelector('#drop-system [data-act="version"]');
      if (!item) return { error: '系統選單沒有版本說明' };
      item.click();
      for (var i = 0; i < 50 && !document.querySelector('.ver-num'); i++) {
        await new Promise(function (r2) { setTimeout(r2, 100); });
      }
      var win = [].slice.call(document.querySelectorAll('.win')).find(function (w) {
        var t = w.querySelector('.win-title');
        return t && t.textContent === '版本說明';
      });
      if (!win) return { error: '版本說明視窗沒開起來' };
      var h3 = win.querySelector('h3');
      var rows = {};
      [].slice.call(win.querySelectorAll('.ver-table tr')).forEach(function (tr) {
        rows[tr.querySelector('th').textContent] = tr.querySelector('td').textContent;
      });
      return {
        data: about.data,
        shown: win.querySelector('.ver-num').textContent,
        mode: win.querySelector('.ver-mode').textContent,
        heading: h3 && h3.textContent,
        notes: win.querySelectorAll('.ver-notes li').length,
        rows: rows,
        copy: !!win.querySelector('button')
      };
    `, { timeout: 30000 });

    assert.equal(r.error, undefined, r.error);
    assert.equal(r.data.version, pkg.version, '行程報的版本和 package.json 不同');
    assert.equal(r.data.mode, fresh ? 'portable' : 'source', '執行方式判斷錯了：' + r.data.mode);
    assert.match(r.data.electron, /^\d+\.\d+\.\d+/, 'Electron 版本');
    assert.match(r.data.chromium, /^\d+\./, 'Chromium 版本');
    assert.ok(r.data.dataHome, '資料位置');
    assert.equal(r.shown, 'v' + pkg.version, '視窗上的版本號：' + r.shown);
    assert.equal(r.mode, r.data.modeLabel, '視窗上的執行方式：' + r.mode);
    assert.match(r.heading, new RegExp('v' + pkg.version.replace(/\./g, '\\.')),
      '這一版的變更要指名這一版：' + r.heading);
    assert.ok(r.notes >= 1, '這一版沒有變更說明');
    assert.equal(r.rows['Electron'], r.data.electron, '表裡的 Electron 版本');
    assert.equal(r.rows['資料位置'], r.data.dataHome, '表裡的資料位置');
    assert.ok(r.copy, '沒有複製按鈕');
  });

  await t.test('沙箱掛載，而且路徑指向可寫的地方', async () => {
    const info = await run(cdp, `
      var r = await window.aios.sysInfo();
      return { ok: r.ok, root: r.data && r.data.sandboxRoot, usage: r.data && r.data.usage };
    `);
    assert.ok(info.ok, 'sys:info 失敗');
    assert.ok(info.root, '沙箱沒有掛載');
    assert.ok(info.usage && info.usage.quota, '沒有配額資訊');
    /* Packaged, the app directory is inside a read-only asar; the boot used to
       point the sandbox at it and lose everything else in the reply. */
    assert.ok(!/app\.asar/.test(info.root), '沙箱指向 asar 裡面，那是唯讀的');
  });

  await t.test('能力政策載入，而且每一條都有說明', async () => {
    const caps = await run(cdp, `
      var r = await window.aios.sysInfo();
      var p = r.data.policy, notes = r.data.capNotes || {};
      return Object.keys(p).map(function (c) {
        return { cap: c, value: p[c], note: (notes[c] || '').length };
      });
    `);
    assert.ok(caps.length >= 14, '能力數量不對：' + caps.length);
    for (const c of caps) {
      assert.ok(['allow', 'ask', 'deny'].includes(c.value),
        c.cap + ' 的值不是三種之一：' + c.value);
      /* A default-open gate is asking the user to decide what to turn down, and
         nobody turns down an identifier they do not understand. */
      assert.ok(c.note > 8, c.cap + ' 在閘門上會是一個沒有說明的識別字');
    }
  });

  if (fresh) {
    await t.test('全新的機器每個能力都是開的', async () => {
      /* Only meaningful on a profile with no policy.json: a saved policy is the
         user's own and correctly wins over whatever the defaults later became.
         Asserting this against a development profile tests the developer's past
         clicks, not the shipped defaults. */
      const caps = await run(cdp, `
        var r = await window.aios.sysInfo();
        var p = r.data.policy;
        return Object.keys(p).filter(function (c) { return p[c] !== 'allow'; });
      `);
      assert.deepEqual(caps, [], '這些能力在全新設定檔上不是開的：' + caps.join('、'));
    });
  }

  await t.test('syscall 表送到了 renderer', async () => {
    const ops = await evaluate(cdp, 'Object.keys(window.AIOS.OPS || {}).length');
    assert.ok(ops > 10, 'syscall 表沒有安裝，模型會無事可做：' + ops);
  });

  await t.test('主程序汙染時，畫面立刻知道（不是等下次去問）', async () => {
    /* Enforcement was never in doubt -- it happens in main. What lagged was the
       badge that explains why the next write will ask for permission, and a
       security indicator that lags is one people stop believing. */
    const r = await run(cdp, `
      await window.aios.taint.clear();
      AIOS.ui.renderSandbox();
      var before = {
        state: !!(AIOS.state.taint && AIOS.state.taint.tainted),
        badge: !document.getElementById('sb-taint').hidden
      };

      // Taint from the main process, with nothing on this side asking for it.
      await window.aios.taint.add('e2e://untrusted', 'e2e 測試用的不可信來源');
      await new Promise(function (r2) { setTimeout(r2, 400); });

      var after = {
        state: !!(AIOS.state.taint && AIOS.state.taint.tainted),
        badge: !document.getElementById('sb-taint').hidden
      };
      await window.aios.taint.clear();
      await new Promise(function (r2) { setTimeout(r2, 400); });
      var cleared = !!(AIOS.state.taint && AIOS.state.taint.tainted);
      return { before: before, after: after, cleared: cleared };
    `);
    assert.equal(r.before.state, false, '起點就已經被汙染了');
    assert.equal(r.after.state, true, 'renderer 沒有收到汙染推播');
    assert.equal(r.after.badge, true, '畫面上的汙染標記沒有亮起來');
    assert.equal(r.cleared, false, '清除汙染之後 renderer 還以為被汙染');
  });

  await t.test('汙染標記說的是「這對你代表什麼」，而不是一列越來越長的來源', async () => {
    /* It printed every source's label joined by 、. One message opened is one
       source, so after a morning in the mailbox the sandbox panel was a
       paragraph of other people's subject lines -- and the one thing it never
       said was what any of it meant for the person reading it. */
    const r = await run(cdp, `
      await window.aios.taint.clear();
      var read = function () {
        AIOS.ui.renderSandbox();
        var el = document.getElementById('sb-taint');
        return {
          what: el.querySelector('.sb-taint-what').textContent,
          counts: el.querySelector('.sb-taint-count').textContent,
          visible: el.textContent.trim().length,
          title: el.title
        };
      };
      for (var i = 1; i <= 3; i++) {
        await window.aios.taint.add('mail:u' + i, '信件「主旨 ' + i + '」（某人）');
      }
      await window.aios.taint.add('https://example.com/a', '網頁「Example」');
      await new Promise(function (r2) { setTimeout(r2, 300); });
      var few = read();
      for (var j = 4; j <= 40; j++) {
        await window.aios.taint.add('mail:u' + j, '信件「主旨 ' + j + '」（某人）');
      }
      await new Promise(function (r2) { setTimeout(r2, 300); });
      var many = read();
      await window.aios.taint.clear();
      return { few: few, many: many };
    `, { timeout: 30000 });

    assert.match(r.few.what, /寫檔/, '第一行要說出後果，不是名詞：' + r.few.what);
    assert.match(r.few.counts, /信件 3 封/, '第二行是數量：' + r.few.counts);
    assert.match(r.few.counts, /網頁 1 個/, '而且分類數：' + r.few.counts);
    assert.ok(!r.few.counts.includes('主旨 1'), '別人寫的主旨不在畫面上：' + r.few.counts);
    assert.match(r.few.title, /主旨/, '但在提示裡查得到');

    assert.match(r.many.counts, /信件 40 封/, '數量要跟著走：' + r.many.counts);
    /* The point of the whole change: ten times the sources, the same line. */
    assert.ok(Math.abs(r.many.visible - r.few.visible) <= 2,
      '開了四十封信之後這塊要還是一樣長：' + r.few.visible + ' → ' + r.many.visible);
  });

  await t.test('用量會累加，而且能歸零', async () => {
    /* Every call reported its own spend and nothing added them up, so on a
       metered core there was no way to answer 「今天花了多少」 short of reading
       the trace. */
    const r = await run(cdp, `
      AIOS.kernel.resetSpend();
      var meter = document.getElementById('s-spend');
      var hiddenAtZero = meter.hidden;

      AIOS.kernel.addSpend({ prompt: 100, output: 40, thinking: 25, total: 165 });
      AIOS.kernel.addSpend({ prompt: 200, output: 60, total: 260 });
      var after = JSON.parse(JSON.stringify(AIOS.state.spend));

      var shown = !meter.hidden && meter.querySelector('b').textContent;
      AIOS.kernel.resetSpend();
      return { hiddenAtZero: hiddenAtZero, after: after, shown: shown,
               zeroed: AIOS.state.spend.total, hiddenAgain: meter.hidden };
    `);
    assert.equal(r.hiddenAtZero, true, '沒花錢時不該顯示計數器');
    assert.equal(r.after.total, 425, '總和不對：' + r.after.total);
    assert.equal(r.after.turns, 2, '呼叫次數不對：' + r.after.turns);
    assert.equal(r.after.thinking, 25, '思考 token 沒有累加');
    assert.equal(r.shown, '425', '選單列顯示的數字不對：' + r.shown);
    assert.equal(r.zeroed, 0, '歸零沒有生效');
    assert.equal(r.hiddenAgain, true, '歸零之後計數器該收起來');
  });

  await t.test('沒有模型也要能開起來', async () => {
    /* Booted is not connected. A machine with a wrong key or no provider must
       still reach a usable desktop -- the window that fixes the setting is the
       one that would otherwise have failed to appear. */
    const st = await evaluate(cdp, `JSON.stringify({
      sandbox: !!window.AIOS.state.sandboxRoot,
      policy: Object.keys(window.AIOS.state.policy || {}).length,
      desktop: !!document.getElementById('desktop')
    })`);
    const s = JSON.parse(st);
    assert.ok(s.sandbox && s.policy > 0 && s.desktop,
      '開機不完整（連不上模型時不該連帶掉這些）：' + st);
  });
  await t.test('檔案總管的樹狀窗格看得見，不是被壓扁的碎片', async () => {
    /* The DOM was right and the window was unreadable. Every node was a flex
       item in a column pane, so forty-odd directories squeezed each one to six
       pixels, and `overflow: hidden` clipped the text to a horizontal slice --
       the tree rendered as a column of specks. A test that only asked whether
       the pane existed passed the whole time. */
    const r = await run(cdp, `
      await AIOS.apps.launch('files');
      await new Promise(function (r) { setTimeout(r, 1200); });
      var fm = AIOS.apps.instances().filter(function (i) { return i.def.id === 'files'; })[0];
      if (!fm) return { error: '檔案總管沒開起來' };
      var nodes = fm.win.el.querySelectorAll('.fm-tnode');
      if (!nodes.length) return { error: '樹狀窗格是空的' };
      var out = { count: nodes.length, min: Infinity, clipped: 0, texts: [] };
      [].slice.call(nodes).forEach(function (n) {
        var h = n.getBoundingClientRect().height;
        var need = parseFloat(getComputedStyle(n).fontSize);
        if (h < out.min) out.min = h;
        if (h < need) out.clipped++;
        if (out.texts.length < 3) out.texts.push(n.textContent);
      });
      return out;
    `, { timeout: 60000 });

    assert.equal(r.error, undefined, r.error);
    assert.ok(r.count >= 2, '樹狀窗格只有 ' + r.count + ' 個節點');
    assert.equal(r.clipped, 0,
      r.clipped + ' 個節點比自己的字還矮（最矮 ' + Math.round(r.min) + 'px），字會被切掉');
    assert.ok(r.texts.every((s) => s && s.trim()), '節點沒有文字：' + JSON.stringify(r.texts));
  });
  await t.test('搜尋沙箱：檔名與內容都找得到，而且回報命中的那一行', async () => {
    /* Searching by content was missing entirely: the file manager filtered the
       listing by path, and the kernel's only route to 「哪些檔案裡提到 X」 was to
       read every file into context one at a time. */
    const r = await run(cdp, `
      await window.aios.fs.write('/notes/e2e-find/甲.txt', '第一行\\n交付可靠度是這一季的主軸\\n第三行');
      await window.aios.fs.write('/notes/e2e-find/交付可靠度.md', '# 只有檔名符合');
      await window.aios.fs.write('/notes/e2e-find/乙.txt', '完全無關的內容');
      await AIOS.afterFsChange();

      /* Scoped to the directory these three were just written to. Unscoped,
         what comes back depends on how many other readable files the sandbox
         happens to hold: content scanning has a budget of FIND_LIMITS.files,
         and on a machine that has been used for a while these three sit past
         it -- a real limit, reported by the truncated flag, but not what
         is about. The unscoped search below covers what must hold whatever
         the budget does. */
      var res = await window.aios.fs.find('交付可靠度', { dir: '/notes/e2e-find' });
      if (!res.ok) return { error: res.error };
      var hits = res.data.hits.filter(function (h) { return /e2e-find/.test(h.vpath); });
      var out = {
        paths: hits.map(function (h) { return h.vpath; }).sort(),
        byContent: hits.filter(function (h) { return h.where === 'content'; })
          .map(function (h) { return { p: h.vpath, line: h.lines[0] && h.lines[0].line, text: h.lines[0] && h.lines[0].text }; }),
        truncated: res.data.truncated
      };

      // Scoped to a directory, and the syscall path the kernel actually uses.
      var scoped = await window.aios.fs.find('交付可靠度', { dir: '/inbox' });
      out.scopedAway = scoped.ok ? scoped.data.hits.filter(function (h) { return /e2e-find/.test(h.vpath); }).length : -1;

      /* A name match costs no read, so running out of reading budget must not
         stop it. It used to break the whole walk at the four-hundredth file
         scanned, so on a sandbox of any size a search for a file whose name
         is exactly the query came back empty -- and 「not found」 reads the
         same as 「not there」. */
      var wide = await window.aios.fs.find('交付可靠度');
      out.wideName = wide.ok
        ? wide.data.hits.some(function (h) { return h.vpath === '/notes/e2e-find/交付可靠度.md'; })
        : false;
      out.wideTruncated = wide.ok ? !!wide.data.truncated : null;

      out.exec = typeof AIOS.exec['fs.find'] === 'function';
      var ran = await AIOS.exec['fs.find']({ query: '交付可靠度' });
      out.note = ran && ran.note;

      for (var f of ['甲.txt', '交付可靠度.md', '乙.txt']) await window.aios.fs.remove('/notes/e2e-find/' + f);
      return out;
    `, { timeout: 60000 });

    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.paths, ['/notes/e2e-find/交付可靠度.md', '/notes/e2e-find/甲.txt'],
      '找到的不是預期的那兩個：' + JSON.stringify(r.paths));
    assert.equal(r.byContent.length, 1, '應該只有一個是靠內容命中');
    assert.equal(r.wideName, true,
      '掉出讀檔預算之後，檔名還是要比到底（truncated=' + r.wideTruncated + '）');
    assert.equal(r.byContent[0].line, 2, '命中的行號不對');
    assert.match(r.byContent[0].text, /交付可靠度/,
      '要回報命中的那一行，不然呼叫端還是得把每個檔案打開');
    assert.equal(r.scopedAway, 0, '限定目錄之後不該找到別的目錄');
    assert.ok(r.exec, 'fs.find 沒有 executor，計畫裡寫了也只會失敗');
    assert.match(r.note, /搜尋「交付可靠度」/, '收據要說清楚搜了什麼');
  });
}
