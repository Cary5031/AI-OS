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

  await t.test('最大化真的填滿桌面：家具收起來，意圖列留著', async () => {
    /* Maximise used to stop at the top edge of the intent bar and keep a gutter
       on every other side, so a "maximised" window left a measurable band of
       desktop unused -- 38% of it on the machine this was first measured on.
       Now the desktop folds its own furniture away: chips, dock and both HUD
       rails, with the intent bar staying as a full-width strip flush with the
       bottom. This starts with the rails OPEN because that is what is on a real
       screen, and folding them is where most of the space comes from. */
    const r = await run(cdp, `
      AIOS.wm.closeAll({ force: true });
      await new Promise(function (r) { setTimeout(r, 250); });

      /* Say that nobody is reaching for the dock, because on this machine
         somebody might be. While a window is maximised the dock hides below the
         command strip, and hovering the strip holds it out on purpose -- a dock
         that vanished as you moved towards it is one nobody could click. That
         is the HOVER behaviour; this test is about the MAXIMISE one, and with a
         real mouse resting at the bottom of a real screen -- which is where a
         mouse usually is -- the two were being measured at once and the answer
         depended on where somebody had left the pointer.

         So the pointer is sent away through the app's own listener, and the
         class it sets is cleared for the measurement. Nothing moves the mouse
         back while the suite runs, and the fold itself is still asserted below:
         a dock that stopped folding fails here exactly as before. */
      ['intent-form', 'dock'].forEach(function (id) {
        var e = document.getElementById(id);
        if (e) e.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
      });
      document.body.classList.remove('peek');

      function rail(id) { return document.getElementById(id); }
      function shown(id) {
        var h = rail(id);
        return !!h && (window.innerWidth <= 1040
          ? h.classList.contains('forced') : !h.classList.contains('off'));
      }
      function press(id) { document.querySelector('.dk[data-dock="' + id + '"]').click(); }
      function open_(id) { if (!shown(id)) press(id); }

      open_('hud-left'); open_('hud-right');
      await new Promise(function (r) { setTimeout(r, 120); });
      var railsBefore = { left: shown('hud-left'), right: shown('hud-right') };

      var win = AIOS.wm.open({ kind: 'TEXT', title: '最大化測試', render: function (b) {
        b.textContent = '內容';
      } });
      var deskEl = document.getElementById('desktop');
      var before = AIOS.wm.freeRect();

      AIOS.wm.toggleMax(win);
      /* Maximising moves the strip and the dock out from under wherever the
         pointer is, which is itself an enter or a leave. Said again, for the
         same reason as above. */
      document.body.classList.remove('peek');
      /* Wait for the dock to have ARRIVED, not for a number of milliseconds and
         not for it to stop changing -- "has not started moving yet" and "has
         finished moving" read exactly alike, and a fixed wait measures the speed
         of the machine. Giving up after three seconds leaves the assertion below
         to report where the dock actually is, which is the useful failure. */
      await (async function arrive(el) {
        /* Bounded in wall time, never in iterations. A window that is not on top
           -- another window over it, or a screen that has gone to sleep during a
           long suite -- has its timers throttled to about one a minute, and
           eighty of those is an hour. Counting iterations turned an environment
           that used to merely slow this test down into one that timed the whole
           suite out. */
        var until = Date.now() + 3000;
        do {
          if (Math.round(el.getBoundingClientRect().top) >= window.innerHeight - 2) return;
          // Held for the whole measurement, not just its first frame: the dock
          // slides out from under the pointer, and passing beneath it is an
          // enter.
          document.body.classList.remove('peek');
          await new Promise(function (r) { setTimeout(r, 50); });
        } while (Date.now() < until);
      })(document.getElementById('dock'));

      function box(e) {
        var x = e.getBoundingClientRect();
        return { top: Math.round(x.top), bottom: Math.round(x.bottom),
                 left: Math.round(x.left), right: Math.round(x.right),
                 w: Math.round(x.width), h: Math.round(x.height) };
      }
      var desk = box(deskEl);
      var bar = box(document.getElementById('intent-form'));
      var dock = box(document.getElementById('dock'));
      var chips = document.getElementById('chips');
      var maxed = {
        body: document.body.classList.contains('maxed'),
        win: box(win.el), desk: desk, bar: bar, dock: dock,
        chipsShown: !!(chips && getComputedStyle(chips).display !== 'none'),
        rails: { left: shown('hud-left'), right: shown('hud-right') },
        dockOff: dock.top >= window.innerHeight - 2,
        barFullWidth: Math.abs(bar.w - desk.w) <= 2,
        barAtBottom: Math.abs(bar.bottom - window.innerHeight) <= 2,
        /* Reported so a failure caused by a window nobody is drawing reads as
           one. A hidden document does not composite, so an animation measured
           in it never arrives -- that is the environment, not the fold. */
        visible: document.visibilityState
      };

      /* Opening a rail while maximised is a decision: the window gives that
         width back rather than sitting on top of what somebody asked to see.

         Waited for, not timed. The rail slides and the window resizes with it,
         so a fixed wait measures how fast this machine is: a two-pixel overlap
         here was a window still on its way, reported as a window sitting on top
         of the rail. The loop gives up after three seconds and lets the
         assertion below report where things actually are. */
      press('hud-left');
      var railEl = rail('hud-left');
      var railUntil = Date.now() + 3000;
      do {
        await new Promise(function (r) { setTimeout(r, 50); });
        if (Math.round(win.el.getBoundingClientRect().left) >=
            Math.round(railEl.getBoundingClientRect().right)) break;
      } while (Date.now() < railUntil);
      var withRail = { win: box(win.el), rail: box(railEl) };

      AIOS.wm.toggleMax(win);
      await new Promise(function (r) { setTimeout(r, 150); });
      var back = {
        body: document.body.classList.contains('maxed'),
        chipsShown: !!(chips && getComputedStyle(chips).display !== 'none'),
        rails: { left: shown('hud-left'), right: shown('hud-right') },
        win: box(win.el)
      };
      AIOS.wm.close(win, { force: true });
      return { railsBefore: railsBefore, before: before, maxed: maxed,
               withRail: withRail, back: back };
    `, { timeout: 60000 });

    assert.deepEqual(r.railsBefore, { left: true, right: true }, '這個測試從兩欄都開著開始');

    const m = r.maxed;
    assert.equal(m.body, true, '最大化時桌面要進入收起家具的狀態');
    assert.equal(m.chipsShown, false, '建議詞要收起來，那一排就是被討回來的空間');
    assert.deepEqual(m.rails, { left: false, right: false }, 'HUD 欄也要跟著收起來');
    assert.equal(m.dockOff, true, 'dock 要退到畫面外，需要時再伸手叫它出來：' +
      JSON.stringify(m.dock) + '（視窗當時 ' + m.visible + '）');
    assert.equal(m.barFullWidth, true, '意圖列變成整條指令列：' + JSON.stringify(m.bar));
    assert.equal(m.barAtBottom, true, '而且貼齊底邊，中間不留縫：' + JSON.stringify(m.bar));

    assert.ok(Math.abs(m.win.top - m.desk.top) <= 1,
      '視窗上緣要貼齊桌面上緣：' + JSON.stringify({ win: m.win, desk: m.desk }));
    assert.ok(Math.abs(m.win.bottom - m.bar.top) <= 2,
      '視窗下緣要接在指令列上緣，不是浮在它上面：' + JSON.stringify({ win: m.win, bar: m.bar }));
    assert.ok(Math.abs(m.win.left - m.desk.left) <= 1 && Math.abs(m.win.right - m.desk.right) <= 1,
      '左右要貼到桌面的邊：' + JSON.stringify({ win: m.win, desk: m.desk }));

    /* The gain, stated as a number so a future change that quietly gives it back
       fails here instead of in somebody's eyes. */
    const fill = (m.win.w * m.win.h) / (m.desk.w * m.desk.h);
    const was = (r.before.w * r.before.h) / (m.desk.w * m.desk.h);
    assert.ok(fill > 0.9, '最大化要蓋住九成以上的桌面，實際 ' + Math.round(fill * 100) + '%');
    assert.ok(fill > was + 0.3,
      '而且要比舊的可用區大得有感：' + Math.round(was * 100) + '% → ' + Math.round(fill * 100) + '%');

    assert.ok(r.withRail.win.left >= r.withRail.rail.right,
      '最大化中途打開的 HUD 欄不該被蓋住：' + JSON.stringify(r.withRail));
    assert.ok(r.withRail.win.w < m.win.w,
      '視窗要把那塊寬度讓出來：' + JSON.stringify({ maxed: m.win.w, withRail: r.withRail.win.w }));

    assert.equal(r.back.body, false, '取消最大化要把家具放回來');
    assert.equal(r.back.chipsShown, true, '建議詞也要自己回來，使用者沒有關過它');
    assert.deepEqual(r.back.rails, { left: true, right: true },
      '收起來的欄位要原樣回來，自己中途打開的那一欄也還開著');
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
