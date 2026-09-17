/* Documents that leave the machine.

   The unit tests build a .pptx by calling the writer directly, which proves the
   bytes are right and nothing about whether the application can reach it. This
   drives the real slides app the way `app.do` does, and then reads back what
   landed in the sandbox.

   The bug that makes this spec exist: `saveAs('/notes/x.pptx')` wrote the deck's
   own JSON under a PowerPoint name and reported 「已儲存」. The file opened in
   nothing, and every layer above -- the action, the plan, the trace -- said it
   had worked. */

import assert from 'node:assert/strict';
import { run } from '../lib/cdp.mjs';

export const name = '簡報匯出';

const PPTX = '/notes/e2e-deck.pptx';
const DECK = '/notes/e2e-deck.aiosdeck';

/** Drive the slides app through its published actions, as `app.do` does. */
const viaActions = (calls) => `
  await AIOS.apps.launch('slides');
  var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'slides'; })[0];
  for (var i = 0; i < 100 && (!inst || !inst.ctx || !inst.ctx.api); i++) {
    await new Promise(function (r) { setTimeout(r, 100); });
    inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'slides'; })[0];
  }
  if (!inst || !inst.ctx || !inst.ctx.api) return { error: '簡報沒有開起來' };
  var out = [];
  ${calls}
  return { out: out };
`;

export async function spec(t, app) {
  const { cdp } = app;

  await run(cdp, `
    await window.aios.fs.remove('${PPTX}');
    await window.aios.fs.remove('${DECK}');
    return 1;
  `);

  await t.test('簡報動作真的能產出 PowerPoint 檔', async () => {
    const r = await run(cdp, viaActions(`
      out.push(await AIOS.apps.invoke('slides', 'buildDeck', {
        title: 'E2E 簡報',
        slides: [
          { layout: 'title', title: '封面', body: ['副標\\n\\n第二行'], notes: '開場講稿' },
          { layout: 'bullets', title: '重點', body: ['甲\\n乙\\n丙'], notes: '' }
        ]
      }));
      out.push(await AIOS.apps.invoke('slides', 'setFont', { font: 'Noto Sans TC', scale: 110 }));
      out.push(await AIOS.apps.invoke('slides', 'saveAs', { path: '${PPTX}' }));
    `), { timeout: 60000 });

    assert.equal(r.error, undefined, r.error);
    r.out.forEach((o, i) => assert.ok(o && o.ok !== false,
      `第 ${i + 1} 個動作失敗：` + JSON.stringify(o)));

    const file = await run(cdp, `
      var b = await window.aios.fs.readBytes('${PPTX}');
      if (!b.ok) return { ok: false, error: b.error };
      var raw = atob(b.data.base64.slice(0, 8));
      return { ok: true, magic: raw.slice(0, 2), bytes: b.data.base64.length };
    `);
    assert.ok(file.ok, '檔案沒寫出來：' + file.error);
    /* Every OOXML file is a zip, and the deck's native format is JSON. `PK`
       versus `{` is the whole difference the bug hid. */
    assert.equal(file.magic, 'PK', '寫出來的不是 zip，就不是 PowerPoint 檔');
  });

  await t.test('寫出來的簡報，內容和頁數都對得上', async () => {
    /* Read the package back through the same reader the machine ships. Slide
       parts and speaker notes both have to be there: notes were what PowerPoint
       refused the file over, and a spec that only counted slides passed while
       the file would not open at all. */
    const parts = await run(cdp, `
      var b = await window.aios.fs.readBytes('${PPTX}');
      var bin = atob(b.data.base64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var text = new TextDecoder('latin1').decode(bytes);
      // Entry names live in the local headers; enough to see what is inside.
      var names = [];
      var re = /(ppt\\/[a-zA-Z0-9_\\/.]+\\.(?:xml|rels|png|jpeg))/g, m;
      while ((m = re.exec(text))) if (names.indexOf(m[1]) < 0) names.push(m[1]);
      return names;
    `);

    const slides = parts.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
    assert.equal(slides.length, 2, '應該有兩頁，實際：' + slides.join('、'));
    assert.ok(parts.includes('ppt/notesSlides/notesSlide1.xml'), '備忘稿沒有寫進去');
    assert.ok(parts.includes('ppt/theme/theme2.xml'),
      '備忘稿主板必須有自己的佈景主題，共用會讓 PowerPoint 拒絕開啟');
  });

  await t.test('存成不認得的格式會被拒絕，而不是偷偷存成別的東西', async () => {
    /* The original bug. An unknown extension fell through to the deck's own
       JSON, so the caller was told it had a .key file when it had JSON. */
    const r = await run(cdp, viaActions(`
      try {
        out.push(await AIOS.apps.invoke('slides', 'saveAs', { path: '/notes/e2e-deck.key' }));
      } catch (e) { out.push({ threw: String(e.message || e) }); }
      out.push(await window.aios.fs.read('/notes/e2e-deck.key'));
    `), { timeout: 60000 });

    assert.equal(r.error, undefined, r.error);
    const said = JSON.stringify(r.out[0]);
    assert.match(said, /存不成|\.key/, '拒絕的理由要說得出來：' + said);
    assert.equal(r.out[1].ok, false, '被拒絕的格式不該留下檔案');
  });

  await t.test('原生格式仍然存得下去', async () => {
    /* The refusal must not have taken the working path with it. */
    const r = await run(cdp, viaActions(`
      out.push(await AIOS.apps.invoke('slides', 'saveAs', { path: '${DECK}' }));
      var f = await window.aios.fs.read('${DECK}');
      out.push({ ok: f.ok, kind: f.ok ? JSON.parse(f.data.content).kind : null });
    `), { timeout: 60000 });

    assert.equal(r.error, undefined, r.error);
    assert.equal(r.out[1].ok, true, '.aiosdeck 存不出來');
    assert.equal(r.out[1].kind, 'aiosdeck');
  });

  await t.test('那個 .pptx 開得回來，而且開回來的就是原本那份簡報', async () => {
    /* The round trip a person actually performs: save as .pptx, close, open it
       again later. It used to come back as an import -- every slide blank, the
       bullets gone, the cover centred -- which is right for a file PowerPoint
       wrote and was reported as 「整個版面都跑掉了」 for one this editor wrote.
       Now the writer embeds the deck and the reader hands it back when nothing
       else has touched the slides, so the file opens as itself: same layouts,
       a real path, no 「（匯入）」. Somebody else's .pptx still imports; the unit
       tests cover that boundary with a hand-edited file.

       The last assertion still matters: opening must not write the file. */
    const before = await run(cdp, `
      var b = await window.aios.fs.readBytes('${PPTX}');
      return { ok: b.ok, bytes: b.ok ? b.data.bytes : 0 };
    `);
    assert.ok(before.ok && before.bytes > 0, '要先有那個 .pptx');

    const r = await run(cdp, `
      AIOS.wm.closeAll({ force: true });
      await new Promise(function (s) { setTimeout(s, 400); });
      await AIOS.apps.launch('slides', '${PPTX}');
      var inst;
      for (var i = 0; i < 150 && !(inst && inst.ctx); i++) {
        await new Promise(function (s) { setTimeout(s, 100); });
        inst = AIOS.apps.instances().filter(function (x) { return x.def.id === 'slides'; })[0];
      }
      if (!inst) return { error: '簡報沒有開起來' };
      for (var j = 0; j < 60 && document.querySelectorAll('.sl-thumb').length < 2; j++) {
        await new Promise(function (s) { setTimeout(s, 100); });
      }
      var title = document.querySelector('.win .win-title');
      var canvas = document.querySelector('.sl-stage .sl-canvas');
      var texts = [].slice.call(document.querySelectorAll('.sl-stage .sl-title, .sl-stage .sl-text, .sl-stage .sl-obj'))
        .map(function (n) { return n.textContent.trim(); }).filter(Boolean);
      var st = inst.ctrl && inst.ctrl.getState ? inst.ctrl.getState() : {};
      return {
        title: title ? title.textContent : '',
        thumbs: document.querySelectorAll('.sl-thumb').length,
        texts: texts,
        path: st.path || '',
        layouts: (st.deck && st.deck.slides || []).map(function (s) { return s.layout; }),
        canvas: canvas ? canvas.className : '',
        dirty: !!st.dirty
      };
    `, { timeout: 90000 });

    assert.equal(r.error, undefined, r.error);
    assert.equal(r.thumbs, 2, '兩頁都要回來');
    assert.doesNotMatch(r.title, /（匯入）/, '自己存的檔不是匯入：' + r.title);
    assert.equal(r.path, PPTX, '開的就是那個檔，Ctrl+S 會存回去');
    assert.equal(r.dirty, false, '剛開的檔沒有未儲存的變更');
    assert.deepEqual(r.layouts, ['title', 'bullets'], '版面要跟存的時候一樣，不是全部變空白：' + r.layouts.join(','));
    assert.match(r.canvas, /layout-title/, '第一頁畫的是封面版面：' + r.canvas);
    assert.ok(r.texts.length > 0, '第一頁的文字要畫得出來，實際看到：' + JSON.stringify(r.texts));

    const after = await run(cdp, `
      var b = await window.aios.fs.readBytes('${PPTX}');
      return { ok: b.ok, bytes: b.ok ? b.data.bytes : 0 };
    `);
    assert.equal(after.bytes, before.bytes, '匯入不可以動到原檔');
  });
}

