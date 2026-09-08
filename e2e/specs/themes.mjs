/* Every theme has to actually apply, and say its own name in the language the
   rest of the interface uses. The receipt said 「主題切換為 FOREST」 while the
   menu, the desktop menu and the syscall description all said 深林.

   And the ones a person makes: saved through the main process, painted in the
   menu with their real colours, worn by id or by name, previewed in the editor
   and on the whole desktop without reaching the session, and gone from the
   page when deleted. */

import assert from 'node:assert/strict';
import { evaluate, run } from '../lib/cdp.mjs';

export const name = '主題';

export async function spec(t, app) {
  const { cdp } = app;

  const themes = await evaluate(cdp, 'JSON.stringify(window.AIOS.themes.list)')
    .then(JSON.parse);

  await t.test('清單不是空的，而且每個都有中文名稱與說明', () => {
    assert.ok(themes.length >= 14, '主題數量不對：' + themes.length);
    for (const th of themes) {
      assert.ok(/[一-鿿]/.test(th.label), th.id + ' 沒有中文名稱');
      assert.ok(th.hint && th.hint.length >= 2, th.id + ' 沒有說明');
    }
  });

  await t.test('每一個都套得上，而且收據用中文名稱', async () => {
    const before = await evaluate(cdp, 'document.documentElement.getAttribute("data-theme")');
    for (const th of themes) {
      const r = await run(cdp, `
        var out = await AIOS.run('theme.set', { mode: ${JSON.stringify(th.id)} });
        return { note: out.note, applied: document.documentElement.getAttribute('data-theme') };
      `);
      assert.equal(r.applied, th.id, th.id + ' 沒有套上');
      assert.ok(r.note.includes(th.label),
        th.id + ' 的收據沒有用中文名稱：' + r.note);
      assert.ok(!r.note.includes(th.id.toUpperCase()),
        th.id + ' 的收據把 id 洩漏到介面上：' + r.note);
    }
    await run(cdp, `await AIOS.run('theme.set', { mode: ${JSON.stringify(before || 'void')} }); return 1;`);
  });

  await t.test('不認得的主題退回預設，不是套上壞值', async () => {
    const r = await run(cdp, `
      await AIOS.run('theme.set', { mode: 'not-a-real-theme' });
      return document.documentElement.getAttribute('data-theme');
    `);
    assert.equal(r, 'void', '無效的主題應該退回 void，實際：' + r);
  });

  await t.test('選單從清單渲染，色票畫的是各自的真實顏色', async () => {
    const r = await run(cdp, `
      AIOS.paintThemeMenu();
      var drop = document.getElementById('drop-theme');
      var rows = [].slice.call(drop.querySelectorAll('.mb-theme[data-theme-id]')).map(function (b) {
        var sw = b.querySelector('.mb-swatch');
        var cs = sw ? getComputedStyle(sw) : null;
        return {
          id: b.getAttribute('data-theme-id'),
          themed: sw ? sw.getAttribute('data-theme') : null,
          accent: cs ? cs.getPropertyValue('--accent').trim() : ''
        };
      });
      return { rows: rows, make: !!drop.querySelector('.mb-theme-new') };
    `);
    const rows = r.rows.filter((row) => themes.some((th) => th.id === row.id));
    assert.equal(rows.length, themes.length, '選單列數與清單不符');
    const accents = new Set();
    for (const row of rows) {
      assert.equal(row.themed, row.id, row.id + ' 的色票沒有掛上自己的 data-theme');
      assert.ok(row.accent, row.id + ' 的色票取不到 --accent，會畫成別的主題的顏色');
      accents.add(row.accent);
    }
    /* If the palettes were not reaching the swatches, every one of them would
       resolve to the page's own --accent and this would collapse to one value. */
    assert.ok(accents.size > 6,
      '色票的顏色幾乎都一樣，表示調色盤沒有套到色票上：' + accents.size + ' 種');
    assert.ok(r.make, '選單底下要有「自訂主題…」');
  });

  /* ------------------------------------------------------- custom themes */

  let made = null;

  await t.test('自訂主題：存進主程序、出現在選單、色票畫的是它自己的顏色', async () => {
    const r = await run(cdp, `
      var r = await AIOS.themes.save({ id: null, name: 'e2e 我的藍', mode: 'dark', primary: '#3366ff', overrides: { warn: '#ffd400' } });
      if (!r.ok) throw new Error(r.error);
      var id = r.data.saved.id;
      AIOS.paintThemeMenu();
      var row = document.querySelector('#drop-theme .mb-theme[data-theme-id="' + id + '"]');
      var sw = row && row.querySelector('.mb-swatch');
      var cs = sw ? getComputedStyle(sw) : null;
      var listed = await window.aios.themes.list();
      return {
        id: id, name: r.data.saved.name,
        inCustom: AIOS.themes.isCustom(id), has: AIOS.themes.has(id),
        rowText: row ? row.textContent : null,
        swatchAccent: cs ? cs.getPropertyValue('--accent').trim() : '',
        swatchWarn: cs ? cs.getPropertyValue('--warn').trim() : '',
        expectAccent: AIOS.themes.colorsOf(id).accent,
        onDisk: !!(listed.ok && listed.data.some(function (x) { return x.id === id; })),
        edit: !!document.querySelector('#drop-theme [data-theme-edit="' + id + '"]'),
        label: AIOS.themes.labelOf(id)
      };
    `);
    made = r;
    assert.match(r.id, /^u-[a-z0-9]{6,16}$/, '代號由主程序發');
    assert.ok(r.inCustom && r.has, '清單認得它');
    assert.ok(r.rowText && r.rowText.includes('e2e 我的藍'), '選單列要顯示它的名字：' + r.rowText);
    assert.equal(r.swatchAccent, r.expectAccent, '色票的主色要是推導出來的那個');
    assert.equal(r.swatchWarn, '#ffd400', '手動改的警告色要原樣進到色票');
    assert.ok(r.onDisk, '主程序的清單裡要有它');
    assert.ok(r.edit, '每一列旁邊要有 ✎');
    assert.equal(r.label, 'e2e 我的藍', 'labelOf 用名字');
  });

  await t.test('自訂主題：用代號或名稱都套得上，收據用名稱，頁面真的換色；內建的也認中英文名', async () => {
    const r = await run(cdp, `
      var id = ${JSON.stringify(made.id)};
      var a = await AIOS.run('theme.set', { mode: id });
      var byId = {
        applied: document.documentElement.getAttribute('data-theme'), note: a.note,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        warn: getComputedStyle(document.documentElement).getPropertyValue('--warn').trim(),
        light: document.documentElement.hasAttribute('data-light')
      };
      await AIOS.run('theme.set', { mode: 'void' });
      var b = await AIOS.run('theme.set', { mode: '  E2E 我的藍 ' });
      var byName = { applied: document.documentElement.getAttribute('data-theme'), note: b.note };
      await AIOS.run('theme.set', { mode: 'Forest' });
      var english = document.documentElement.getAttribute('data-theme');
      await AIOS.run('theme.set', { mode: '深空' });
      var chinese = document.documentElement.getAttribute('data-theme');
      return { byId: byId, byName: byName, english: english, chinese: chinese,
        expect: AIOS.themes.colorsOf(id).accent, session: AIOS.session.collect().theme };
    `);
    assert.equal(r.byId.applied, made.id, '用代號套上');
    assert.ok(r.byId.note.includes('e2e 我的藍') && !r.byId.note.includes(made.id), '收據用名稱不用代號：' + r.byId.note);
    assert.equal(r.byId.accent, r.expect, '頁面的 --accent 真的變成它的');
    assert.equal(r.byId.warn, '#ffd400', '手動改的警告色到了頁面上');
    assert.ok(!r.byId.light, '深色主題不掛 data-light');
    assert.equal(r.byName.applied, made.id, '用名稱（不分大小寫、去空白）套上');
    assert.equal(r.english, 'forest', '內建主題認英文名');
    assert.equal(r.chinese, 'void', '內建主題認中文名');
    assert.equal(r.session, 'void', '工作階段記的是現在穿的');
  });

  await t.test('自訂主題：淺色的會掛上 data-light，換回深色就拿掉', async () => {
    const r = await run(cdp, `
      var r = await AIOS.themes.save({ id: null, name: 'e2e 淺色', mode: 'light', primary: '#0a6ba8', overrides: {} });
      if (!r.ok) throw new Error(r.error);
      var id = r.data.saved.id;
      await AIOS.run('theme.set', { mode: id });
      var light = document.documentElement.hasAttribute('data-light');
      var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim();
      var trace = getComputedStyle(document.getElementById('trace')).backgroundColor;
      await AIOS.run('theme.set', { mode: 'void' });
      var dark = document.documentElement.hasAttribute('data-light');
      var gone = await AIOS.themes.remove(id);
      return { light: light, bg: bg, trace: trace, dark: dark, removed: gone.ok, has: AIOS.themes.has(id) };
    `);
    assert.ok(r.light, '淺色自訂主題要掛 data-light');
    assert.match(r.bg, /^#[0-9a-f]{6}$/);
    assert.ok(parseInt(r.bg.slice(1, 3), 16) > 200, '底色真的是淺的：' + r.bg);
    assert.match(r.trace, /rgba\(255, 255, 255/, '核心軌跡在淺色底上要用淺色覆寫：' + r.trace);
    assert.ok(!r.dark, '換回深色就拿掉');
    assert.ok(r.removed && !r.has);
  });

  await t.test('編輯器：主色調一改，預覽與細項立刻跟著變；手動調過的不被主色調牽動', async () => {
    const r = await run(cdp, `
      AIOS.themer.open(${JSON.stringify(made.id)});
      var win = document.querySelector('.win .thm');
      var pv = win.querySelector('.thm-pv');
      var before = getComputedStyle(pv).getPropertyValue('--accent').trim();
      var pin = win.querySelector('.thm-row-primary .thm-swatch-in');
      pin.value = '#22aa55';
      pin.dispatchEvent(new Event('input', { bubbles: true }));
      var after = getComputedStyle(pv).getPropertyValue('--accent').trim();
      var warnAfter = getComputedStyle(pv).getPropertyValue('--warn').trim();
      var draft = AIOS.themer.draft();
      return {
        before: before, after: after, warnAfter: warnAfter,
        primary: draft.primary, dirty: AIOS.themer.dirty(),
        accentTag: win.querySelector('.thm-row[data-key="accent"] .thm-tag').textContent,
        warnTag: win.querySelector('.thm-row[data-key="warn"] .thm-tag').textContent,
        accentHex: win.querySelector('.thm-row[data-key="accent"] .thm-hex').value,
        check: win.querySelector('.thm-check').className,
        rows: win.querySelectorAll('.thm-rows .thm-row').length,
        expect: AIOS.themes.palette.resolve(draft).accent,
        nameField: win.querySelector('.thm-name').value
      };
    `);
    assert.equal(r.nameField, 'e2e 我的藍', '開的是那一組');
    assert.equal(r.rows, 11, '十一個細項');
    assert.notEqual(r.before, r.after, '主色調改了，預覽的主色要跟著變');
    assert.equal(r.after, r.expect, '預覽用的是推導出來的顏色');
    assert.equal(r.accentHex, r.after, '細項列顯示同一個值');
    assert.equal(r.warnAfter, '#ffd400', '手動調過的警告色不被主色調牽動');
    assert.equal(r.primary, '#22aa55');
    assert.ok(r.dirty, '改過就算髒');
    assert.equal(r.accentTag, '自動');
    assert.equal(r.warnTag, '手動');
    assert.match(r.check, /\bok\b/, '推導出來的調色盤對比全過');
  });

  await t.test('編輯器：整桌預覽套上草稿、關窗不存就還原，工作階段從不記草稿', async () => {
    const r = await run(cdp, `
      var win = document.querySelector('.win .thm');
      var live = win.querySelector('.thm-live input');
      live.checked = true;
      live.dispatchEvent(new Event('change', { bubbles: true }));
      var during = document.documentElement.getAttribute('data-theme');
      var accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      var remembered = AIOS.session.collect().theme;
      var w = AIOS.wm.list().find(function (x) { return x.id === AIOS.themer.WIN_ID; });
      var closing = AIOS.wm.close(w);
      await new Promise(function (r2) { setTimeout(r2, 80); });
      var discard = document.querySelector('.ui-prompt .fbtn-danger');
      var asked = !!discard;
      if (discard) discard.click();
      /* Raced, so a prompt that never appears fails here with a reason
         instead of hanging the whole suite until its timeout. */
      var went = await Promise.race([closing, new Promise(function (r2) { setTimeout(function () { r2('timeout'); }, 3000); })]);
      // The window manager fades a window out and removes the node 160ms later.
      await new Promise(function (r2) { setTimeout(r2, 300); });
      var after = document.documentElement.getAttribute('data-theme');
      var stillOpen = !!document.querySelector('.win .thm');
      var saved = AIOS.themes.find(${JSON.stringify(made.id)}).primary;
      return { during: during, accent: accent, remembered: remembered, asked: asked, went: went, after: after, stillOpen: stillOpen, saved: saved,
        expect: AIOS.themes.palette.resolve({ mode: 'dark', primary: '#22aa55', overrides: { warn: '#ffd400' } }).accent };
    `);
    assert.equal(r.during, 'u-draft', '整桌預覽穿的是草稿');
    assert.equal(r.accent, r.expect, '整個頁面的 --accent 是草稿的');
    assert.equal(r.remembered, 'void', '工作階段記的不是草稿，是預覽前穿的');
    assert.ok(r.asked, '有未儲存的變更，關窗要先問');
    assert.notEqual(r.went, 'timeout', '關窗的承諾三秒內沒有回來：提示沒出現，或出現了沒被按到');
    assert.ok(r.went && !r.stillOpen, '選「不儲存」後視窗真的關了');
    assert.equal(r.after, 'void', '關窗還原到預覽前的主題');
    assert.equal(r.saved, '#3366ff', '沒儲存的草稿沒有寫進去');
  });

  await t.test('自訂主題：刪掉正在用的會回到預設，選單、樣式表與主程序都不再有它', async () => {
    const r = await run(cdp, `
      var id = ${JSON.stringify(made.id)};
      await AIOS.run('theme.set', { mode: id });
      var r = await AIOS.themes.remove(id);
      AIOS.paintThemeMenu();
      var listed = await window.aios.themes.list();
      return {
        ok: r.ok,
        applied: document.documentElement.getAttribute('data-theme'),
        has: AIOS.themes.has(id),
        row: !!document.querySelector('#drop-theme [data-theme-id="' + id + '"]'),
        onDisk: listed.data.some(function (x) { return x.id === id; }),
        style: document.getElementById('custom-themes').textContent.indexOf(id) >= 0,
        session: AIOS.session.collect().theme
      };
    `);
    assert.ok(r.ok);
    assert.equal(r.applied, 'void', '正在用的被刪掉，回到預設');
    assert.equal(r.session, 'void');
    assert.ok(!r.has && !r.row && !r.onDisk && !r.style, '清單、選單、主程序、樣式表都不再有它');
  });

  await t.test('自訂主題：主程序拒絕壞值與重名', async () => {
    const r = await run(cdp, `
      var a = await window.aios.themes.save({ name: 'x', mode: 'dark', primary: 'red' });
      var b = await window.aios.themes.save({ name: '', mode: 'dark', primary: '#123456' });
      var c = await window.aios.themes.save({ name: 'e2e dup', mode: 'light', primary: '#123456', overrides: { nope: '#000000' } });
      var d = await window.aios.themes.save({ name: 'e2e dup', mode: 'light', primary: '#123456' });
      var e = await window.aios.themes.save({ name: 'E2E DUP', mode: 'dark', primary: '#654321' });
      if (d.ok) await window.aios.themes.remove(d.data.saved.id);
      return { a: a.ok, b: b.ok, c: c.ok, d: d.ok, e: e.ok, eCode: e.code, eErr: e.error };
    `);
    assert.ok(!r.a && !r.b && !r.c, '壞的顏色、空名稱、不認得的項目都被拒');
    assert.ok(r.d, '好的存得進去');
    assert.ok(!r.e, '同名（不分大小寫）被拒：' + r.eErr);
    assert.equal(r.eCode, 'EEXIST');
  });
}
