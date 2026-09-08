/* Rewriting a PDF.

   The unit tests build fixtures by hand and check that this project's own
   reader reads the writer's output. That proves the bytes; it proves nothing
   about whether the application can reach any of it. This drives the PDF app
   through the actions `app.do` uses, against a PDF the application itself
   produced a moment earlier -- so the file under test is a real Chromium PDF,
   with object streams, an xref stream and embedded font subsets, rather than
   the hand-assembled kind.

   The check that matters is at the end: the parts are read back with
   `pdf.read`, which is a different code path from the writer and refuses to
   guess. Page counts and per-page text are compared against the original, so a
   split that produced a file-shaped thing with the wrong pages in it fails
   here even though every byte of it was well formed. */

import assert from 'node:assert/strict';
import { run, connect, targets, until } from '../lib/cdp.mjs';

export const name = 'PDF 頁面改寫';

const SRC = '/notes/e2e-pdfpages.pdf';

/* Four pages, each saying which one it is, with a forced break between them.
   Written through the machine's own PDF export so the input is a real one. */
const MAKE = `
  var blocks = [];
  for (var i = 1; i <= 4; i++) {
    blocks.push({ type: 'heading', level: 1, text: '第 ' + i + ' 章' });
    blocks.push({ type: 'para', text: 'PAGEMARK' + i + ' 這一頁的內容。' });
    if (i < 4) blocks.push({ type: 'break' });
  }
  var out = await AIOS.printing.toPdf(${JSON.stringify(SRC)}, {
    title: 'E2E 分頁測試',
    bodyHtml: AIOS.printing.blocksHtml(blocks)
  });
  return { vpath: out.vpath };
`;

export async function spec(t, app) {
  const { cdp, port } = app;

  /* The pdf.js viewer is a document of its own on the aios-pdf:// scheme, with
     no bridge to the shell -- that isolation is the point of the design, and it
     means a click has to be dispatched where the pages actually are. */
  async function inViewer(body) {
    const target = await until(async () => {
      const list = (await targets(port)).filter((x) => x.url.startsWith('aios-pdf://') &&
        x.url.indexOf('viewer.html') > 0 && x.webSocketDebuggerUrl);
      /* The newest, not the first. Each open publishes a token of its own, so a
         frame from an earlier subtest can still be in the list showing the same
         document -- and talking to that one looks exactly like the live one
         ignoring every message. */
      return list.length ? list[list.length - 1] : null;
    }, { timeout: 20000, what: 'PDF 檢視器的 CDP target' });
    const p = await connect(target.webSocketDebuggerUrl);
    try {
      return await run(p, body, { timeout: 20000 });
    } finally {
      try { p.close(); } catch { /* the frame may have gone */ }
    }
  }

  await t.test('先做出一份四頁的 PDF 當素材', async () => {
    const r = await run(cdp, `
      await window.aios.fs.remove(${JSON.stringify(SRC)});
      ${MAKE}
    `, { timeout: 60000 });
    assert.equal(r.error, undefined, r.error);

    const check = await run(cdp, `
      var res = await window.aios.pdf.read(${JSON.stringify(SRC)});
      if (!res.ok) return { error: res.error };
      return { pages: res.data.pageCount, texts: res.data.pages.map(function (p) { return p.text; }) };
    `, { timeout: 60000 });
    assert.equal(check.error, undefined, check.error);
    assert.equal(check.pages, 4, '素材要真的有四頁');
    check.texts.forEach((t2, i) => {
      assert.match(t2, new RegExp('PAGEMARK' + (i + 1)), '第 ' + (i + 1) + ' 頁的標記在它自己那一頁');
    });
  });

  /** Open the PDF app on the fixture and call one of its actions. */
  const viaApp = (call) => `
    AIOS.apps.instances().filter(function (i) { return i.def.id === 'pdf'; })
      .forEach(function (i) { AIOS.wm.close(i.win); });
    await new Promise(function (r) { setTimeout(r, 200); });

    await AIOS.apps.launch('pdf', ${JSON.stringify(SRC)});
    var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'pdf'; }).pop();
    for (var i = 0; i < 100 && (!inst || !inst.ctx || !inst.ctx.api); i++) {
      await new Promise(function (r) { setTimeout(r, 100); });
      inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'pdf'; }).pop();
    }
    if (!inst || !inst.ctx || !inst.ctx.api) return { error: 'PDF 沒有開起來' };
    for (var j = 0; j < 100 && !inst.ctx.api.state().doc; j++) {
      await new Promise(function (r) { setTimeout(r, 100); });
    }
    if (!inst.ctx.api.state().doc) return { error: 'PDF 沒有讀進來' };
    var note = ${call};
    return { note: note };
  `;

  /** Read a written file back through the reader, not through the writer. */
  const readBack = (vpath) => `
    var res = await window.aios.pdf.read(${JSON.stringify(vpath)});
    if (!res.ok) return { error: res.error };
    return { pages: res.data.pageCount, texts: res.data.pages.map(function (p) { return p.text; }) };
  `;

  await t.test('抽出頁面：選到的頁進去了，沒選到的沒進去', async () => {
    const out = '/notes/e2e-pdfpages-抽出.pdf';
    const r = await run(cdp, viaApp(
      `await inst.ctx.api.splitPages('2-3', ${JSON.stringify(out)})`), { timeout: 90000 });
    assert.equal(r.error, undefined, r.error);
    assert.match(String(r.note), /已存成/, '轉存回報：' + r.note);

    const back = await run(cdp, readBack(out), { timeout: 60000 });
    assert.equal(back.error, undefined, back.error);
    assert.equal(back.pages, 2);
    assert.match(back.texts[0], /PAGEMARK2/);
    assert.match(back.texts[1], /PAGEMARK3/);
    assert.ok(!back.texts.join('').includes('PAGEMARK1'), '沒選到的頁不該跟著出去');
    assert.ok(!back.texts.join('').includes('PAGEMARK4'));
  });

  await t.test('重新排序：順序照寫的來', async () => {
    const out = '/notes/e2e-pdfpages-重排.pdf';
    const r = await run(cdp, viaApp(
      `await inst.ctx.api.reorderPages('3,1,4,2', ${JSON.stringify(out)})`), { timeout: 90000 });
    assert.equal(r.error, undefined, r.error);

    const back = await run(cdp, readBack(out), { timeout: 60000 });
    assert.equal(back.error, undefined, back.error);
    assert.equal(back.pages, 4, '重排不會丟頁');
    ['PAGEMARK3', 'PAGEMARK1', 'PAGEMARK4', 'PAGEMARK2'].forEach((mark, i) => {
      assert.match(back.texts[i], new RegExp(mark), '第 ' + (i + 1) + ' 頁應該是 ' + mark);
    });
  });

  await t.test('刪除頁面：刪掉的不見了，其餘保持原序', async () => {
    const out = '/notes/e2e-pdfpages-刪頁.pdf';
    const r = await run(cdp, viaApp(
      `await inst.ctx.api.deletePages('2', ${JSON.stringify(out)})`), { timeout: 90000 });
    assert.equal(r.error, undefined, r.error);

    const back = await run(cdp, readBack(out), { timeout: 60000 });
    assert.equal(back.error, undefined, back.error);
    assert.equal(back.pages, 3);
    assert.ok(!back.texts.join('').includes('PAGEMARK2'), '刪掉的頁真的不在了');
    ['PAGEMARK1', 'PAGEMARK3', 'PAGEMARK4'].forEach((mark, i) => {
      assert.match(back.texts[i], new RegExp(mark));
    });
  });

  await t.test('每 N 頁拆成一個檔案：檔名照份數編，最後一份可以比較短', async () => {
    /* No target path: this one names its own files, which is half of what is
       being tested -- a person asking for parts wants them in order. */
    const r = await run(cdp, viaApp(
      `await inst.ctx.api.splitEvery(3, '/notes')`), { timeout: 120000 });
    assert.equal(r.error, undefined, r.error);
    assert.match(String(r.note), /已拆成 2 個檔案/, '拆檔回報：' + r.note);

    const a = await run(cdp, readBack('/notes/e2e-pdfpages 1.pdf'), { timeout: 60000 });
    const b = await run(cdp, readBack('/notes/e2e-pdfpages 2.pdf'), { timeout: 60000 });
    assert.equal(a.error, undefined, a.error);
    assert.equal(b.error, undefined, b.error);
    assert.equal(a.pages, 3, '第一份三頁');
    assert.equal(b.pages, 1, '第二份是餘數');
    assert.match(a.texts[0], /PAGEMARK1/);
    assert.match(b.texts[0], /PAGEMARK4/);
  });

  await t.test('加文字：原本的內容還在，新的字也在，而且是可以選取的文字', async () => {
    /* The real test of the whole approach. The overlay goes through Chromium,
       so the Chinese has to come back as text in the finished file -- not as a
       picture of text, and not as the mojibake a hand-rolled font embedding
       would produce. It reads back through `pdf.read`, which recurses into the
       form the stamp created; before that recursion existed this page would
       have come back as a scan. */
    const out = '/notes/e2e-pdfpages-加字.pdf';
    const r = await run(cdp, viaApp(
      `await inst.ctx.api.addText({ page: 2, x: 60, y: 40, text: '審閱中：這頁要重寫',
                                    size: 18, path: ${JSON.stringify(out)} })`),
      { timeout: 120000 });
    assert.equal(r.error, undefined, r.error);
    assert.match(String(r.note), /已存成/, '加字回報：' + r.note);

    const back = await run(cdp, readBack(out), { timeout: 60000 });
    assert.equal(back.error, undefined, back.error);
    assert.equal(back.pages, 4, '加字不會改變頁數');
    assert.match(back.texts[1], /PAGEMARK2/, '第 2 頁原本的內容還在');
    assert.match(back.texts[1], /審閱中：這頁要重寫/, '加上去的中文是真的文字');
    assert.ok(!back.texts[0].includes('審閱中'), '只加在指定的那一頁');
    assert.ok(!back.texts[2].includes('審閱中'));
  });

  await t.test('點一下就放在那裡：位置是真的 pdf.js 換算出來的', async () => {
    /* The conversion cannot be poked at directly -- the viewer is a module, so
       its bindings are its own, which is the isolation working. So this checks
       the only thing that matters anyway: click a quarter of the way across and
       down page 2, and see whether the machine understood that as a quarter of
       the way across and down page 2.

       A4 through this machine's own exporter is 595 x 842pt, so a quarter in is
       149, 211. The click is dispatched at a fraction of the element's CSS box,
       which is the page scaled by whatever zoom the viewer settled on -- if the
       scale were being dropped or double-counted anywhere in the chain, these
       numbers would not come back. */
    const out = '/notes/e2e-pdfpages-點選.pdf';

    /* Armed, not awaited: addText was given its text, so it goes straight to
       pick mode and its promise stays pending until somebody clicks. Waiting
       for it here would deadlock -- the click is the next step. */
    /* The whole user path, not a shortcut into it: no text and no coordinates,
       so it asks what to write and then waits to be shown where. Handing it the
       text as an argument -- which is how the model reaches it -- deliberately
       skips pick mode, because nothing the model can do amounts to a click.

       Armed and not awaited: the promise stays pending until somebody clicks,
       and waiting for it here would deadlock. */
    const armed = await run(cdp, viaApp(
      `await (async function () {
         inst.ctx.api.setMode('pages');
         /* The frame reports itself ready separately from the text extraction
            viaApp already waited for, and pick mode needs the frame. */
         for (var k = 0; k < 200 && !inst.ctx.api.state().ready; k++) {
           await new Promise(function (r) { setTimeout(r, 100); });
         }
         if (!inst.ctx.api.state().ready) return 'frame-never-ready';

         window.__e2ePick = inst.ctx.api.addText({ path: ${JSON.stringify(out)} });

         for (var i = 0; i < 100 && !document.querySelector('.ui-prompt-input'); i++) {
           await new Promise(function (r) { setTimeout(r, 100); });
         }
         var inp = document.querySelector('.ui-prompt-input');
         if (!inp) return 'no-prompt';
         inp.value = '點選放這裡';
         document.querySelector('.ui-prompt .fbtn-primary').click();
         return 'armed';
       })()`), { timeout: 90000 });
    assert.equal(armed.error, undefined, armed.error);
    assert.equal(armed.note, 'armed', '要走到點選模式：' + armed.note);

    const clicked = await inViewer(`
      var box = null;
      for (var i = 0; i < 100 && !box; i++) {
        box = document.querySelector('.page[data-n="2"]');
        if (!box) await new Promise(function (r) { setTimeout(r, 100); });
      }
      if (!box) return { error: '第 2 頁的框沒有建出來' };
      if (!document.getElementById('scroll').classList.contains('picking')) {
        return { error: '檢視器沒有進入點選模式（頁框 ' +
          document.querySelectorAll('.page').length + ' 個，位址 ' +
          location.href.slice(0, 60) + '）' };
      }
      var r = box.getBoundingClientRect();
      box.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true,
        clientX: r.left + r.width * 0.25, clientY: r.top + r.height * 0.25
      }));
      return { ok: true, css: [Math.round(r.width), Math.round(r.height)] };
    `);
    assert.equal(clicked.error, undefined, clicked.error);

    const note = String(await run(cdp, 'return await window.__e2ePick;', { timeout: 60000 }));
    assert.match(note, /已存成/, '點完之後就寫出來了：' + note);

    const at = /第 (\d+) 頁 (\d+),(\d+)/.exec(note);
    assert.ok(at, '回報要說出它放在哪裡：' + note);
    assert.equal(Number(at[1]), 2, '點在第 2 頁');
    /* Two points of slack: the click lands on a whole device pixel and the
       viewer's scale is not a round number. */
    assert.ok(Math.abs(Number(at[2]) - 149) <= 2,
      'x 應該在 149 附近，實際 ' + at[2] + '（頁面 CSS 尺寸 ' + JSON.stringify(clicked.css) + '）');
    assert.ok(Math.abs(Number(at[3]) - 211) <= 2,
      'y 應該在 211 附近，實際 ' + at[3]);

    const back = await run(cdp, `
      var f = await window.aios.pdf.read(${JSON.stringify(out)});
      if (!f.ok) return { error: f.error };
      return { pages: f.data.pageCount, texts: f.data.pages.map(function (p) { return p.text; }) };
    `, { timeout: 60000 });
    assert.equal(back.error, undefined, back.error);
    assert.equal(back.pages, 4);
    assert.match(back.texts[1], /點選放這裡/, '點在第 2 頁，字就落在第 2 頁');
    assert.ok(!back.texts[0].includes('點選放這裡'), '不是落在當時顯示的那一頁');
  });

  await t.test('原檔沒有被動到', async () => {
    const back = await run(cdp, readBack(SRC), { timeout: 60000 });
    assert.equal(back.error, undefined, back.error);
    assert.equal(back.pages, 4, '每一個動作都是另存新檔，原檔還是四頁');
    assert.match(back.texts[0], /PAGEMARK1/);

    await run(cdp, `
      AIOS.apps.instances().filter(function (i) { return i.def.id === 'pdf'; })
        .forEach(function (i) { AIOS.wm.close(i.win); });
      return 1;
    `);
  });
}
