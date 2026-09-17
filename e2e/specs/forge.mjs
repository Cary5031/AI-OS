/* The smoke gate: does it let working programs through and stop broken ones?

   Absorbed from the standalone smoke_verify.mjs. It calls
   AIOS.appshell.smokeTest() directly, so no model is involved and this costs
   nothing -- a real Forge build takes minutes and spends money. */

import assert from 'node:assert/strict';
import { run, until } from '../lib/cdp.mjs';
import { pressDialog, dialogOpen } from '../lib/dialog.mjs';

export const name = 'Forge 冒煙閘門';

/* A program worth sharing: renders, has a self-test, asks for one quiet
   capability. Installed through the model's channel (`forge:install`, gated
   on app.create, which a fresh profile allows). */
const SHARED = [
  'function render(root, os) {',
  '  var p = document.createElement("p");',
  '  p.id = "hello";',
  '  p.textContent = "分享測試";',
  '  root.appendChild(p);',
  '  os.actions.selfTest = async function () { return "自我測試通過：1 項"; };',
  '}'
].join('\n');

const CASES = [
  {
    name: '有值才會爆的表單',
    expect: 'rejected',
    why: '舊的閘門不填欄位就按按鈕，只走到「沒填就安靜退出」那條分支',
    code: `
      function render(root, os) {
        var f = document.createElement('form');
        var i = document.createElement('input'); i.type = 'number';
        var b = document.createElement('button'); b.type = 'submit'; b.textContent = '算';
        f.addEventListener('submit', function (e) {
          e.preventDefault();
          if (!i.value) return;
          window.notAFunction(Number(i.value));
        });
        f.appendChild(i); f.appendChild(b); root.appendChild(f);
      }`
  },
  {
    name: '回報處理器實際收到的值',
    expect: 'rejected',
    contains: '收到值=12',
    why: '證明填進去的值真的到得了 submit 處理器，不只是進了 DOM',
    code: `
      function render(root, os) {
        var f = document.createElement('form');
        var i = document.createElement('input'); i.type = 'number';
        var b = document.createElement('button'); b.type = 'submit'; b.textContent = '送出';
        f.addEventListener('submit', function (e) {
          e.preventDefault();
          if (!i.value) return;
          throw new Error('收到值=' + i.value);
        });
        f.appendChild(i); f.appendChild(b); root.appendChild(f);
      }`
  },
  {
    name: '每種欄位都拿到合用的值',
    expect: 'rejected',
    // s=a because the fill takes the first option with a value, skipping the
    // empty 請選擇 placeholder that generated selects almost always carry.
    contains: () => 'n=12 d=' + new Date().toISOString().slice(0, 10) +
      ' t=09:00 e=a@example.com s=a c=true txt=測試 filled=7',
    why: '日期欄位填「測試」會留在空字串，下游 new Date() 得到 NaN，等於沒測',
    code: `
      function render(root, os) {
        var f = document.createElement('form');
        function mk(type) {
          var i = document.createElement('input'); i.type = type;
          f.appendChild(i); return i;
        }
        var n = mk('number'), d = mk('date'), t = mk('time'),
            e2 = mk('email'), c = mk('checkbox'), txt = mk('text');
        var s = document.createElement('select');
        ['', 'a', 'b'].forEach(function (v) {
          var o = document.createElement('option'); o.value = v; o.textContent = v || '請選擇';
          s.appendChild(o);
        });
        f.appendChild(s);
        var b = document.createElement('button'); b.type = 'submit'; b.textContent = '送出';
        f.appendChild(b);
        f.addEventListener('submit', function (ev) {
          ev.preventDefault();
          var vals = [n, d, t, e2, txt].filter(function (x) { return x.value; }).length
            + (s.value ? 1 : 0) + (c.checked ? 1 : 0);
          throw new Error('n=' + n.value + ' d=' + d.value + ' t=' + t.value +
            ' e=' + e2.value + ' s=' + s.value + ' c=' + c.checked +
            ' txt=' + txt.value + ' filled=' + vals);
        });
        root.appendChild(f);
      }`
  },
  {
    name: '正常的表單程式',
    expect: 'passed',
    why: '填輸入不能把會動的程式變成被拒絕',
    code: `
      function render(root, os) {
        var f = document.createElement('form');
        var i = document.createElement('input'); i.type = 'number';
        var out = document.createElement('p'); out.textContent = '尚未計算';
        var b = document.createElement('button'); b.type = 'submit'; b.textContent = '加一';
        f.addEventListener('submit', function (e) {
          e.preventDefault();
          out.textContent = '結果：' + (Number(i.value || 0) + 1);
        });
        f.appendChild(i); f.appendChild(b);
        root.appendChild(f); root.appendChild(out);
      }`
  },
  {
    name: '沒有表單、只有按鈕',
    expect: 'passed',
    why: '沒有東西可填的程式不該受影響',
    code: `
      function render(root, os) {
        var n = 0;
        var p = document.createElement('p'); p.textContent = '0';
        var b = document.createElement('button'); b.textContent = '加';
        b.addEventListener('click', function () { p.textContent = String(++n); });
        root.appendChild(p); root.appendChild(b);
      }`
  },
  /* The program's own claim about itself, run by the gate. A ledger that adds
     a row and then shows the wrong total throws nothing; only a test written
     against the spec can see that. */
  {
    name: '自我測試失敗的程式',
    expect: 'rejected',
    contains: '自我測試失敗：selfTest：期望 2 得到 3',
    why: '程式自己宣稱的行為要在建置時被驗證，失敗的訊息要原樣帶回來',
    code: `
      function render(root, os) {
        var p = document.createElement('p'); p.textContent = '1 + 1';
        root.appendChild(p);
        function add(a, b) { return a + b + 1; }
        os.actions.selfTest = { desc: '自我測試', args: '{}', run: async function () {
          var got = add(1, 1);
          if (got !== 2) throw new Error('selfTest：期望 2 得到 ' + got);
          return '自我測試通過：1 項';
        } };
      }`
  },
  {
    name: '自我測試通過的程式',
    expect: 'passed',
    why: '通過自己測試的程式不能被誤殺，而且測試改動的狀態要能還原',
    code: `
      function render(root, os) {
        var n = 0;
        var p = document.createElement('p'); p.textContent = '0';
        var b = document.createElement('button'); b.textContent = '加';
        function add() { n++; p.textContent = String(n); }
        b.addEventListener('click', add);
        root.appendChild(p); root.appendChild(b);
        os.actions.selfTest = { desc: '自我測試', args: '{}', run: async function () {
          var before = n;
          add();
          if (n !== before + 1) throw new Error('selfTest：加一沒有生效');
          n = before; p.textContent = String(n);
          return '自我測試通過：1 項';
        } };
      }`
  },
  {
    name: '自我測試等時間的程式',
    expect: 'rejected',
    contains: '自我測試失敗：動作 selfTest 沒有在時限內回應',
    why: '離屏 frame 的 timer 被節流，一個等 60 秒的測試等於永遠不回答；那要算失敗，不是通過',
    code: `
      function render(root, os) {
        var p = document.createElement('p'); p.textContent = 'x';
        root.appendChild(p);
        os.actions.selfTest = { desc: '自我測試', args: '{}', run: function () {
          return new Promise(function (resolve) { setTimeout(resolve, 60000); });
        } };
      }`
  },
  /* The network, stubbed. An unapproved program must not open a socket, but
     os.net.json has to resolve so the program's own parsing runs. */
  {
    name: '宣告 net 的程式在冒煙測試裡拿到假的回應',
    expect: 'passed',
    caps: ['net'],
    why: '冒煙測試不能真的連網，但 os.net.json 要能 resolve，程式自己的解析邏輯才跑得到',
    code: `
      function render(root, os) {
        var p = document.createElement('p'); p.textContent = '…'; root.appendChild(p);
        os.actions.selfTest = { desc: '自我測試', args: '{}', run: async function () {
          var d = await os.net.json('https://api.open-meteo.com/v1/forecast?latitude=25&longitude=121');
          if (!d || d.smoke !== true) throw new Error('selfTest：冒煙回應不對：' + JSON.stringify(d));
          return '自我測試通過：1 項';
        } };
      }`
  },
  {
    name: '沒宣告 net 卻連網的程式',
    expect: 'rejected',
    contains: '沒有宣告 net.fetch 需要的能力',
    why: '能力是 manifest 說了算，沒宣告的呼叫在冒煙測試就被拒，不是裝好才壞',
    code: `
      function render(root, os) {
        var p = document.createElement('p'); p.textContent = '…'; root.appendChild(p);
        os.actions.selfTest = { desc: '自我測試', args: '{}', run: async function () {
          await os.net.json('https://example.com/a.json');
          return '自我測試通過：1 項';
        } };
      }`
  }
];


/* ------------------------------------------------------------- 貢獻點 ---- */

/* A contribution: it is handed rows and answers with one line each. Nothing
   else -- no capability call, no DOM, no waiting. */
const CONTRIB = [
  'function render(root, os) {',
  '  root.textContent = "貢獻點測試";',
  '  os.actions.slotRender = { run: async function (args) {',
  '    return { items: (args.rows || []).map(function (r) {',
  '      return r.cc ? "有副本" : "";',
  '    }) };',
  '  } };',
  '}',
  ''
].join('\n');

/* The same thing, but it tries to use a capability it was granted at install.
   From inside a contribution it must not have it. */
const GREEDY = [
  'function render(root, os) {',
  '  root.textContent = "貪心的貢獻點";',
  '  os.actions.slotRender = { run: async function () {',
  '    try {',
  '      await os.storage.set("k", 1);',
  '      return { items: ["拿到了"] };',
  '    } catch (e) {',
  '      return { items: ["被拒絕"] };',
  '    }',
  '  } };',
  '}',
  ''
].join('\n');

/* And one that never answers in time. */
const SLOW = [
  'function render(root, os) {',
  '  root.textContent = "慢的貢獻點";',
  '  os.actions.slotRender = { run: async function () {',
  '    await new Promise(function (r) { setTimeout(r, 4000); });',
  '    return { items: ["終於"] };',
  '  } };',
  '}',
  ''
].join('\n');

export async function spec(t, app) {
  const { cdp } = app;

  await t.test('閘門會先填輸入再按按鈕', async () => {
    const phases = await run(cdp, `
      var src = String(window.AIOS.appshell.smokeTest);
      var out = [], re = /askSmoke\\(frame, '([a-z]+)'/g, m;
      while ((m = re.exec(src))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
      return out;
    `);
    assert.deepEqual(phases, ['probe', 'form', 'fill', 'click', 'collect'],
      '驅動順序不對：' + phases.join(' -> '));
  });

  for (const c of CASES) {
    await t.test(c.name, async () => {
      const problems = await run(cdp,
        `return window.AIOS.appshell.smokeTest(${JSON.stringify(c.code)}, ${JSON.stringify(c.caps || [])});`,
        { timeout: 90000 });
      const verdict = problems.length ? 'rejected' : 'passed';
      assert.equal(verdict, c.expect,
        `${c.why}\n  回報：${problems.join('；') || '(無)'}`);
      if (c.contains) {
        const want = typeof c.contains === 'function' ? c.contains() : c.contains;
        assert.ok(problems.some((p) => p.includes(want)),
          `少了預期字串「${want}」，實際：${problems.join('；')}`);
      }
    });
  }

  /* ------------------------------------------------- share and import ----
     One program, four steps, in order: it leaves as a file, the file opens
     as a description, a button and the dialog install it, and a second
     import of the same name is the replace question. */

  let packagePath = null;

  await t.test('分享：打包出來的檔案帶著程式，不帶執行許可', async () => {
    const r = await run(cdp, `
      /* From source the sandbox is the repository's and outlives the run, so
         a previous run's program directory (its history in particular) has
         to go first, or the export carries that run's trail. */
      await window.aios.forge.remove('e2e-share').catch(function () {});
      AIOS.apps.unregister('gen:e2e-share');
      for (var p of ['/apps/e2e-share', '/outbox/e2e-share-v1.aiosapp']) {
        try { await window.aios.fs.remove(p); } catch (e) { /* not there */ }
      }
      await AIOS.afterFsChange();

      var inst = await window.aios.forge.install({
        slug: 'e2e-share', name: 'E2E 分享', purpose: '測試分享與匯入', icon: '◈',
        code: ${JSON.stringify(SHARED)}, capabilities: ['storage'],
        prompt: 'e2e', note: 'e2e', author: 'model'
      });
      if (!inst.ok) return { error: '安裝失敗：' + inst.error };
      var ex = await window.aios.forge.export('e2e-share');
      if (!ex.ok) return { error: '匯出失敗：' + ex.error };
      var f = await window.aios.fs.read(ex.data.vpath);
      if (!f.ok) return { error: '讀不回來：' + f.error };
      var pkg = JSON.parse(f.data.content);
      var text = f.data.content;
      return {
        vpath: ex.data.vpath, bytes: ex.data.bytes,
        format: pkg.format, name: pkg.app.name, version: pkg.app.version, caps: pkg.app.capabilities,
        codeSame: pkg.code === ${JSON.stringify(SHARED)},
        history: pkg.history.length,
        grant: /"approvedAt"/.test(text) || Object.prototype.hasOwnProperty.call(pkg, 'hash')
      };
    `, { timeout: 30000 });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.vpath, '/outbox/e2e-share-v1.aiosapp');
    assert.equal(r.format, 'aiosapp');
    assert.equal(r.name, 'E2E 分享');
    assert.equal(r.version, 1);
    assert.deepEqual(r.caps, ['storage']);
    assert.ok(r.codeSame, '程式碼要原樣帶著');
    assert.equal(r.history, 1);
    assert.equal(r.grant, false, '執行許可（雜湊與核准時間）不能在檔案裡');
    packagePath = r.vpath;
  });

  await t.test('開啟程式包只會顯示它，不會安裝', async () => {
    const r = await run(cdp, `
      await window.aios.forge.remove('e2e-share');
      AIOS.apps.unregister('gen:e2e-share');
      await AIOS.apps.openPath(${JSON.stringify(packagePath)});
      for (var i = 0; i < 60 && !document.querySelector('.fg-import-go'); i++) {
        await new Promise(function (r2) { setTimeout(r2, 100); });
      }
      var box = document.querySelector('.fg-import');
      var list = await window.aios.forge.list();
      return {
        button: !!document.querySelector('.fg-import-go'),
        text: box ? box.textContent : '',
        installed: list.ok && list.data.some(function (a) { return a.id === 'e2e-share'; })
      };
    `, { timeout: 30000 });
    assert.ok(r.button, '沒有「檢查並匯入」按鈕');
    assert.match(r.text, /E2E 分享/, '要說是哪個程式');
    assert.match(r.text, /storage/, '要列能力');
    assert.doesNotMatch(r.text, /createElement|selfTest/, '不顯示程式碼');
    assert.equal(r.installed, false, '開啟就裝了，那就沒有人按過任何東西');
  });

  await t.test('按下按鈕：檢查、確認視窗、安裝、開啟', async () => {
    await run(cdp, `document.querySelector('.fg-import-go').click(); return 1;`);
    /* The question is the machine's own dialog, drawn inside the window by the
       main process (main/askbox.js) from the copy of the package it holds.
       Read what it says, then press 匯入 the way a person would. */
    const dlg = await pressDialog(app.port, '匯入', { timeout: 60000 });
    assert.match(dlg.title, /匯入「E2E 分享」？/, '視窗要問的是這個程式');
    assert.match(dlg.text, /storage/, '要列出能力');
    assert.match(dlg.text, /靜態檢查與冒煙測試通過/, '要說 Forge 的檢查結果');
    assert.doesNotMatch(dlg.text, /createElement|selfTest/, '不顯示程式碼');
    assert.deepEqual(dlg.buttons, ['取消', '匯入'], '第一次匯入是兩顆按鈕');
    /* The trace line is the last thing runImport does, after install, refresh
       and launch -- so waiting for it waits for all of them. */
    const r = await until(async () => {
      const done = await run(cdp, `
        var trace = [...document.querySelectorAll('#trace .t-line')].map(function (n) { return n.textContent; });
        if (!trace.some(function (s) { return /已匯入並開啟「E2E 分享」/.test(s); })) return null;
        var l = await window.aios.forge.list();
        return l.ok ? (l.data.find(function (a) { return a.id === 'e2e-share'; }) || null) : null;
      `);
      return done;
    }, { timeout: 60000, what: '匯入完成並開啟' });
    assert.equal(r.version, 1);
    assert.equal(r.integrity, 'ok');

    const after = await run(cdp, `
      var buf = new TextEncoder().encode(${JSON.stringify(SHARED)});
      var d = await crypto.subtle.digest('SHA-256', buf);
      var hex = Array.from(new Uint8Array(d)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      var l = await window.aios.forge.list();
      var a = l.data.find(function (x) { return x.id === 'e2e-share'; });
      var hist = await window.aios.forge.history('e2e-share');
      var trace = [...document.querySelectorAll('#trace .t-line')].map(function (n) { return n.textContent; });
      var open = AIOS.apps.instances().some(function (i) { return i.def.id === 'gen:e2e-share'; });
      return { hashMatch: a.hash === hex, prompt: hist.ok ? hist.data[0].prompt : '',
        author: hist.ok ? hist.data[0].author : '', open: open,
        told: trace.some(function (s) { return /已匯入並開啟「E2E 分享」/.test(s); }),
        boxGone: document.querySelector('.fg-import').hidden };
    `, { timeout: 30000 });
    assert.ok(after.hashMatch, '執行許可的雜湊要是本機從寫入的位元組算出來的');
    assert.match(after.prompt, /匯入自 e2e-share-v1\.aiosapp/);
    assert.equal(after.author, 'user');
    assert.ok(after.open, '匯入後要開起來');
    assert.ok(after.told, '核心軌跡要說');
    assert.ok(after.boxGone, '匯入完成後預覽框要收起來');
  });

  await t.test('同名再匯入一次：確認視窗問取代還是另外裝，取代變成 v2', async () => {
    /* importConfirm waits for the answer, so the dialog is pressed alongside
       it: three buttons and no default, and 取代 is the one pressed. */
    const [r, dlg] = await Promise.all([
      run(cdp, `
        var pv = await window.aios.forge.importPreview(${JSON.stringify(packagePath)});
        if (!pv.ok) return { error: pv.error };
        var existing = pv.data.existing, beside = pv.data.besideSlug;
        var done = await window.aios.forge.importConfirm(pv.data.token, { ok: true });
        var l = await window.aios.forge.list();
        var a = l.data.find(function (x) { return x.id === 'e2e-share'; });
        var hist = await window.aios.forge.history('e2e-share');
        return { existing: existing, beside: beside, done: done.ok ? done.data : { error: done.error },
          version: a && a.version, versions: hist.ok ? hist.data.map(function (h) { return h.version; }) : [],
          stray: l.data.some(function (x) { return x.id === 'e2e-share-2'; }) };
      `, { timeout: 30000 }),
      pressDialog(app.port, '取代')
    ]);
    assert.deepEqual(dlg.buttons, ['取消', '另外安裝（e2e-share-2）', '取代（v2）'], '撞名是三顆按鈕');
    assert.match(dlg.text, /已經有一個「E2E 分享」（v1）/, '要說已經有哪一個');
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.existing, { name: 'E2E 分享', version: 1 });
    assert.equal(r.beside, 'e2e-share-2');
    assert.equal(r.done.installed, true, JSON.stringify(r.done));
    assert.equal(r.done.replaced, true);
    assert.equal(r.version, 2);
    assert.deepEqual(r.versions, [1, 2], '歷史保留，匯入是 v2');
    assert.equal(r.stray, false, '取代就不該另外裝一個');
  });

  await t.test('被改過的程式包會被拒絕，而且不會跳確認視窗', async () => {
    const r = await run(cdp, `
      var f = await window.aios.fs.read(${JSON.stringify(packagePath)});
      var pkg = JSON.parse(f.data.content);
      pkg.code = pkg.code.replace('分享測試', '被換掉的');
      await window.aios.fs.write('/inbox/tampered.aiosapp', JSON.stringify(pkg));
      var pv = await window.aios.forge.importPreview('/inbox/tampered.aiosapp');
      var junk = await window.aios.fs.write('/inbox/junk.aiosapp', '{"format":"zip"}');
      var pv2 = await window.aios.forge.importPreview('/inbox/junk.aiosapp');
      var confirm = await window.aios.forge.importConfirm('0123456789abcdef0123456789abcdef', { ok: true });
      // Leave the sandbox as it was found: the program, its package, the fixtures.
      await window.aios.forge.remove('e2e-share');
      AIOS.wm.list().slice().forEach(function (w) {
        var inst = AIOS.apps.instanceFor(w);
        if (inst && inst.def && inst.def.id === 'gen:e2e-share') AIOS.wm.close(w);
      });
      AIOS.apps.unregister('gen:e2e-share');
      for (var p of ['/inbox/tampered.aiosapp', '/inbox/junk.aiosapp', '/apps/e2e-share', ${JSON.stringify(packagePath)}]) {
        try { await window.aios.fs.remove(p); } catch (e) { /* already gone */ }
      }
      await AIOS.afterFsChange();
      return { tampered: pv.ok ? 'ok' : pv.error, junk: pv2.ok ? 'ok' : pv2.error, confirm: confirm.ok ? 'ok' : confirm.error };
    `, { timeout: 30000 });
    assert.match(r.tampered, /雜湊不符/, '改過的程式碼：' + r.tampered);
    assert.match(r.junk, /不是 AI-OS 的程式包/, '不是程式包：' + r.junk);
    assert.match(r.confirm, /過期或不存在/, '沒有預覽過的 token 不能安裝：' + r.confirm);
    assert.equal(await dialogOpen(app.port), false, '這三條路都不該留下一個確認視窗在畫面上');
  });

  await t.test('擴充程式寫得進內建視窗，而且只寫得進去字', async () => {
    /* The whole of TODO item 4's third layer, exercised for real: an installed
       program answering a question about rows it was handed, in a frame this
       session built for it. Source-shape tests can check that the frame is
       built with no capabilities; only this can check that the answer comes
       back at all. */
    const r = await run(cdp, `
      await window.aios.forge.remove('e2e-slot').catch(function () {});
      var inst = await window.aios.forge.install({
        slug: 'e2e-slot', name: 'E2E 貢獻', purpose: '測試貢獻點', icon: '◈',
        code: ${JSON.stringify(CONTRIB)}, capabilities: [],
        contributes: ['mail:list-row'], prompt: 'e2e', note: 'e2e', author: 'model'
      });
      if (!inst.ok) return { error: '安裝失敗：' + inst.error };

      var declared = AIOS.slots.declared().map(function (s) { return s.name; });
      var got = await AIOS.slots.render('mail:list-row', { rows: [
        { subject: '一', cc: 'a@b.com' },
        { subject: '二', cc: '' }
      ] });
      await window.aios.forge.remove('e2e-slot');
      AIOS.slots.forget('e2e-slot');
      return { out: [declared, got.length, got[0] && got[0].items, got[0] && got[0].name] };
    `);
    assert.equal(r.error, undefined, r.error);
    assert.ok(r.out[0].includes('mail:list-row'), '郵件應該宣告了那個貢獻點：' + r.out[0].join('、'));
    assert.equal(r.out[1], 1, '安裝好的貢獻程式應該被問到');
    assert.deepEqual(r.out[2], ['有副本', ''], '每一列要一一對應，沒話說就是空字串');
    assert.equal(r.out[3], 'E2E 貢獻', '宿主要說得出這行字是誰加的');
  });

  await t.test('貢獻點裡拿不到那個程式自己被授予的能力', async () => {
    /* The property that makes this safe to ship. The program declares storage
       and is granted it in its own window; the frame a contribution answers
       from is built with `capabilities: []`, so the broker refuses. If this
       ever comes back 「拿到了」, an extension has been handed the run of the
       machine on a path nobody looks at. */
    const r = await run(cdp, `
      await window.aios.forge.remove('e2e-greedy').catch(function () {});
      var inst = await window.aios.forge.install({
        slug: 'e2e-greedy', name: 'E2E 貪心', purpose: '測試貢獻點沒有能力', icon: '◈',
        code: ${JSON.stringify(GREEDY)}, capabilities: ['storage'],
        contributes: ['mail:list-row'], prompt: 'e2e', note: 'e2e', author: 'model'
      });
      if (!inst.ok) return { error: '安裝失敗：' + inst.error };
      var got = await AIOS.slots.render('mail:list-row', { rows: [{ subject: '一' }] });
      await window.aios.forge.remove('e2e-greedy');
      AIOS.slots.forget('e2e-greedy');
      return { out: [inst.data.manifest.capabilities, got[0] && got[0].items] };
    `);
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.out[0], ['storage'], '這個程式在自己的視窗裡是有 storage 的');
    assert.deepEqual(r.out[1], ['被拒絕'],
      '但貢獻點裡不該拿得到——回來的是：' + JSON.stringify(r.out[1]));
  });

  await t.test('答不出來的貢獻者會被停用，而且不會每次重問', async () => {
    /* A list being drawn cannot wait. A contributor over the deadline is dropped
       for the session rather than retried, or one broken extension becomes a
       window that stutters on every draw. The second call is the point: it has
       to come back empty and fast, not slow again. */
    const r = await run(cdp, `
      await window.aios.forge.remove('e2e-slow').catch(function () {});
      var inst = await window.aios.forge.install({
        slug: 'e2e-slow', name: 'E2E 慢', purpose: '測試貢獻點時限', icon: '◈',
        code: ${JSON.stringify(SLOW)}, capabilities: [],
        contributes: ['mail:list-row'], prompt: 'e2e', note: 'e2e', author: 'model'
      });
      if (!inst.ok) return { error: '安裝失敗：' + inst.error };

      var first = await AIOS.slots.render('mail:list-row', { rows: [{ subject: '一' }] });
      var t0 = Date.now();
      var second = await AIOS.slots.render('mail:list-row', { rows: [{ subject: '一' }] });
      var again = Date.now() - t0;
      await window.aios.forge.remove('e2e-slow');
      AIOS.slots.forget('e2e-slow');
      return { out: [first.length, second.length, again] };
    `);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.out[0], 0, '超過時限的貢獻不該被畫出來');
    assert.equal(r.out[1], 0, '停用之後也不該再出現');
    assert.ok(r.out[2] < 500, '第二次應該立刻回來，不是再等一次時限：' + r.out[2] + 'ms');
  });

  await t.test('開關：在宿主的選單裡關掉一個貢獻，它就不再被畫；打開就回來', async () => {
    /* The switch is the host window's own menu item, built by the framework
       from the same catalogue the painter reads. Off means not asked at all --
       not asked-and-hidden -- and the state survives in the forge index. */
    const r = await run(cdp, `
      await window.aios.forge.remove('e2e-switch').catch(function () {});
      var inst = await window.aios.forge.install({
        slug: 'e2e-switch', name: 'E2E 開關', purpose: '測試開關', icon: '◈',
        code: ${JSON.stringify(CONTRIB)}, capabilities: [],
        contributes: ['mail:list-row'], prompt: 'e2e', note: 'e2e', author: 'model'
      });
      if (!inst.ok) return { error: '安裝失敗：' + inst.error };
      var rows = [{ subject: '一', cc: 'a@b.com' }];
      var before = (await AIOS.slots.render('mail:list-row', { rows: rows })).length;

      /* The same switch a person flips: the menu item for this contribution. */
      var items = AIOS.slots.menuItems({ id: 'mail' }, { target: document.body }, null);
      var sw = items.find(function (i) { return i.label && i.label.indexOf('E2E 開關') >= 0; });
      if (!sw) return { error: '選單裡沒有這個貢獻的開關：' + JSON.stringify(items.map(function (i) { return i.label; })) };
      var labelBefore = sw.label;
      sw.run();
      for (var i = 0; i < 40; i++) {
        await new Promise(function (r) { setTimeout(r, 100); });
        var l = await window.aios.forge.list();
        var me = (l.data || []).find(function (a) { return a.id === 'e2e-switch'; });
        if (me && (me.slotsOff || []).indexOf('mail:list-row') >= 0) break;
      }
      var off = (await AIOS.slots.render('mail:list-row', { rows: rows })).length;
      var items2 = AIOS.slots.menuItems({ id: 'mail' }, { target: document.body }, null);
      var sw2 = items2.find(function (i) { return i.label && i.label.indexOf('E2E 開關') >= 0; });
      var labelOff = sw2 && sw2.label;
      var hintOff = sw2 && sw2.hint;
      await AIOS.slots.setEnabled('e2e-switch', 'mail:list-row', true);
      var on = (await AIOS.slots.render('mail:list-row', { rows: rows })).length;
      await window.aios.forge.remove('e2e-switch');
      AIOS.slots.forget('e2e-switch');
      return { out: [before, labelBefore, off, labelOff, hintOff, on] };
    `);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.out[0], 1, '關之前有畫');
    assert.match(r.out[1], /^☑ ◈ E2E 開關/, '開著的開關要打勾並帶圖示：' + r.out[1]);
    assert.equal(r.out[2], 0, '關掉之後不該再問它');
    assert.match(String(r.out[3]), /^☐/, '關掉之後開關要顯示為關：' + r.out[3]);
    assert.equal(r.out[4], '已關');
    assert.equal(r.out[5], 1, '打開之後又回來了');
  });

  await t.test('動作：右鍵選單裡的擴充項把游標下的那一列交給擴充程式，跑在它自己的能力裡', async () => {
    /* The act path: the item is built from the unit the host left on the row,
       and choosing it runs the extension's slotAct through app.do -- its own
       window, its own grant. Here the extension declares storage and uses it,
       which an annotation could not. */
    const ACT = [
      'function render(root, os) {',
      '  root.textContent = "動作測試";',
      '  os.actions.slotAct = { desc: "記下這封", args: "{slot, unit}", run: async function (args) {',
      '    await os.storage.set("last", args.unit.subject);',
      '    return "記下了：" + args.unit.subject + "（" + args.slot + "）";',
      '  } };',
      '}',
      ''
    ].join('\n');
    const r = await run(cdp, `
      await window.aios.forge.remove('e2e-act').catch(function () {});
      var inst = await window.aios.forge.install({
        slug: 'e2e-act', name: 'E2E 動作', purpose: '測試動作插槽', icon: '⚑',
        code: ${JSON.stringify(ACT)}, capabilities: ['storage'],
        contributes: ['mail:row-actions'], slotLabels: { 'mail:row-actions': '記下這封' },
        prompt: 'e2e', note: 'e2e', author: 'model'
      });
      if (!inst.ok) return { error: '安裝失敗：' + inst.error };
      await AIOS.slots.refresh();

      /* A row as the mail window leaves it, and an event that landed on it. */
      var row = document.createElement('li');
      row.className = 'ml-item';
      row.__slotUnit = { subject: '九月份報價單', from: 'ming@abc.com' };
      document.body.appendChild(row);
      var items = AIOS.slots.menuItems({ id: 'mail' }, { target: row }, null);
      row.remove();
      var actItem = items.find(function (i) { return i.hint === '擴充'; });
      if (!actItem) return { error: '選單裡沒有動作項：' + JSON.stringify(items.map(function (i) { return i.label; })) };

      var res = await AIOS.slots.act('mail:row-actions', 'e2e-act', row.__slotUnit);
      var note = res && res.data && res.data.note;
      var opened = (AIOS.apps.instances() || []).some(function (i) { return i.def && i.def.id === 'gen:e2e-act'; });
      await window.aios.forge.remove('e2e-act');
      AIOS.apps.unregister('gen:e2e-act');
      AIOS.slots.forget('e2e-act');
      return { out: [actItem.label, note, opened] };
    `);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.out[0], '⚑ 記下這封', '動作項要用擴充程式的圖示與它給的標籤：' + r.out[0]);
    assert.match(String(r.out[1]), /記下了：九月份報價單（mail:row-actions）/, '擴充程式要拿到那一列並在自己的能力裡跑：' + r.out[1]);
    assert.equal(r.out[2], true, '動作跑在擴充程式自己的視窗裡，所以視窗會開');
  });
}
