/* The AI panel acts on your document. Can you take it back?

   The panel runs an app's own published actions, so whether something is
   undoable is the app's answer, not the panel's -- and it turns out to be
   uneven: the actions that rewrite blocks take a snapshot first, the ones that
   change formatting did not. That gap got wider the day the panel learned to
   run up to eight actions in one turn.

   No model is involved here. The panel's action runner is what is under test,
   so the actions are invoked the way it invokes them. */

import assert from 'node:assert/strict';
import { run } from '../lib/cdp.mjs';

export const name = 'AI 對話面板';

/* Each: an action the panel can run, arguments that really change something,
   and how to read the thing it changed. */
const MUTATIONS = [
  {
    action: 'setBlock',
    args: { index: 1, text: 'E2E 改寫過的標題' },
    read: `return AIOS.__e2eDocs().blocks[0].text;`
  },
  {
    action: 'insertBlock',
    args: { type: 'para', text: 'E2E 插入的段落' },
    read: `return String(AIOS.__e2eDocs().blocks.length);`
  },
  {
    action: 'setFont',
    args: { font: '標楷體', size: 18 },
    read: `var d = AIOS.__e2eDocs(); return d.font + '/' + d.size;`
  },
  {
    action: 'setPara',
    args: { index: 1, align: 'center' },
    /* Read off the rendered block, not the description: `describe()` does not
       report paragraph alignment, so a reader built on it returns the same empty
       string before and after and the test passes for the wrong reason.

       And read the editable element inside `.dc-block`, not the block itself:
       the wrapper carries the number gutter, the alignment goes on the text. A
       reader pointed at the wrapper sees no change and reports the action as
       broken when it is not. */
    read: `
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'docs'; })[0];
      var el = inst.win.el.querySelector('.dc-block [contenteditable]');
      return el ? (el.style.textAlign || '(未設定)') : '(找不到區塊)';
    `
  },
  {
    action: 'setLayout',
    args: { header: 'E2E 頁首' },
    read: `return AIOS.__e2eDocs().header || '';`
  }
];

export async function spec(t, app) {
  const { cdp } = app;

  /* A reader for the document's own state, installed once. The app keeps its
     model in a closure, so this goes through the description it already
     publishes for the panel rather than reaching inside it. */
  const ready = await run(cdp, `
    var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'docs'; })[0];
    if (!inst) { await AIOS.apps.launch('docs'); await new Promise(function (r) { setTimeout(r, 1200); }); }
    inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'docs'; })[0];
    if (!inst) return false;
    AIOS.__e2eDocs = function () {
      var s = inst.describe ? String(inst.describe() || '') : '';
      var blocks = [];
      s.split(String.fromCharCode(10)).forEach(function (line) {
        var m = line.match(/^\\s{2}(\\d+)\\.\\s\\[([^\\]]+)\\]\\s?(.*)$/);
        if (m) blocks.push({ type: m[2], text: m[3] });
      });
      var font = (s.match(/整份預設字型：(\\S+)\\s(\\d+)pt/) || []);
      var head = (s.match(/頁首「([^」]*)」/) || []);
      return {
        blocks: blocks, font: font[1] || '', size: font[2] || '',
        header: head[1] === '無' ? '' : (head[1] || '')
      };
    };
    return true;
  `);
  assert.ok(ready, '開不起文件程式');

  await t.test('面板一個回合可以執行多個動作，並逐一回報', async () => {
    const src = await run(cdp, `return String(window.AIOS.chatpane.systemPrompt);`);
    assert.match(src, /actions/, 'prompt 沒有要求 actions 陣列');
    assert.match(src, /全部放進去，不要只做第一件/,
      'prompt 沒有要求把一句話裡的多件事全部做完');
    assert.match(src, /say 要明講哪些做了、哪些沒做/,
      'prompt 沒有要求誠實回報做不到的部分');
  });

  for (const m of MUTATIONS) {
    await t.test(`${m.action} 之後可以復原`, async () => {
      const r = await run(cdp, `
        var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'docs'; })[0];
        var read = function () { ${m.read} };
        var before = read();

        var spec = inst.def.actions[${JSON.stringify(m.action)}];
        if (!spec) return { skipped: true };
        await spec.run(${JSON.stringify(m.args)}, inst.ctx, inst);
        var after = read();

        // The app's own undo, the way a person reaches it.
        var btn = [].slice.call(inst.win.el.querySelectorAll('button'))
          .filter(function (b) { return /復原|undo/i.test(b.title || b.textContent); })[0];
        if (btn && !btn.disabled) btn.click();
        await new Promise(function (r2) { setTimeout(r2, 250); });

        return { before: before, after: after, undone: read(), hadButton: !!btn };
      `);
      if (r.skipped) return;

      assert.notEqual(r.after, r.before,
        `${m.action} 沒有真的改到東西，這條測試就沒有意義`);
      assert.equal(r.undone, r.before,
        `${m.action} 改了「${r.before}」→「${r.after}」，但復原之後仍然是「${r.undone}」` +
        ' — AI 面板可以做這件事，使用者卻收不回來');
    });
  }
}
