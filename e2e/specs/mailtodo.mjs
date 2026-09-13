/* 郵件待辦, driven for real, without a model and without a mailbox.

   The unit tests check the sentence reader with the functions called directly.
   This drives the window, and it can do the whole of the important path without
   either of the two expensive things -- because that is a property of the design
   rather than a convenience of the test:

     the sentence becomes conditions with no model in the room. The 「不用模型」
     button exists for a machine with no core, and it is exactly the path this
     spec takes. If reading a sentence ever quietly starts needing the core,
     these assertions are what says so.

     a rule is stored, read back and shown as its sentence. The old screen showed
     seven fields; what is asserted here is that the sentence survives the round
     trip and is what the rail and the head display.

   What this cannot reach: running a rule needs a mailbox, and the criterion step
   needs a model. Both are checked in the unit tests at the level where they are
   ordinary functions. What is checked here is that the window does what the
   buttons say -- the failure mode `npm test` cannot see. */

import assert from 'node:assert/strict';
import { run } from '../lib/cdp.mjs';

export const name = '郵件待辦';

/** Open the program (once) and run `calls`, which may push onto `out`. */
const via = (calls) => `
  var live = AIOS.apps.instances().filter(function (i) { return i.def.id === 'mailtodo'; });
  if (!live.length) await AIOS.apps.launch('mailtodo');
  var inst;
  for (var i = 0; i < 120; i++) {
    inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'mailtodo'; })[0];
    if (inst && inst.ctx && inst.ctx.api) break;
    await new Promise(function (r) { setTimeout(r, 100); });
  }
  if (!inst || !inst.ctx || !inst.ctx.api) return { error: '郵件待辦沒有開起來' };
  /* ctx.body IS the .app-main element this program draws into (registry.js), so
     every query below is scoped to this window and no other program's panel can
     answer for it. */
  var body = inst.ctx.body;
  var out = [];
  var tick = function () { return new Promise(function (r) { setTimeout(r, 60); }); };
  var q = function (sel) { return body.querySelector(sel); };
  var qa = function (sel) { return [].slice.call(body.querySelectorAll(sel)); };
  ${calls}
  return { out: out };
`;

export async function spec(t, app) {
  const { cdp } = app;

  await t.test('第一個畫面就是那個輸入框，不是七個欄位', async () => {
    const r = await run(cdp, via(`
      /* A clean slate: this spec owns the rules it makes. */
      var st = await window.aios.mailtodo.state();
      for (var i = 0; i < st.data.rules.length; i++) {
        await window.aios.mailtodo.removeRule(st.data.rules[i].id);
      }
      await inst.ctx.api.reload();
      await tick();

      out.push(!!q('.mt-welcome'));
      out.push(qa('.mt-welcome .chip').length);
      out.push(qa('.mt-welcome .chip').map(function (c) { return c.textContent; }));
      /* Every chip carries its whole sentence as the tooltip, so the point of it
         is readable before it is pressed. */
      out.push(qa('.mt-welcome .chip').every(function (c) { return (c.title || '').length > 12; }));
      out.push(qa('.mt-input, .mt-say').length);
    `));
    assert.equal(r.error, undefined, r.error);
    const [welcome, chips, labels, titled, fields] = r.out;
    assert.equal(welcome, true, '沒有規則時該看到那個「用一句話交代」的畫面');
    assert.equal(chips, 6, '例句應該是六個：' + chips);
    assert.ok(labels.includes('在等我回覆的'),
      '第一個例句要示範「七個欄位表達不出來的東西」：' + JSON.stringify(labels));
    assert.equal(titled, true, '每個例句都要帶著完整句子當提示');
    assert.equal(fields, 0, '第一個畫面不該有任何輸入欄位');
  });

  await t.test('點一個例句只會填進去，不會跑', async () => {
    const r = await run(cdp, via(`
      var chip = qa('.mt-welcome .chip')[0];
      var label = chip.textContent;
      chip.click();
      await tick();
      var box = q('.mt-say');
      out.push(!!box);
      out.push(box ? box.value.length > 20 : false);
      out.push(box ? box.value : '');
      /* Pressing a suggestion must not create anything or reach the mailbox. */
      var st = await window.aios.mailtodo.state();
      out.push(st.data.rules.length);
      out.push(label);
      /* The fields are here, behind a fold that starts closed. */
      out.push(!!q('.mt-fold'));
      out.push(q('.mt-fold') ? q('.mt-fold').open === false : false);
    `));
    assert.equal(r.error, undefined, r.error);
    const [hasBox, filled, value, rules, label, fold, closed] = r.out;
    assert.equal(hasBox, true, '點例句應該開出那個輸入框');
    assert.equal(filled, true, '例句應該整句填進去，而不是只填一個標籤：' + value);
    assert.equal(rules, 0, '點一個例句不該建立任何規則（chip 只填，不跑）');
    assert.ok(value.length > label.length, '填進去的是句子而不是 chip 上的字');
    assert.equal(fold, true, '七個欄位還在，收在摺頁後面');
    assert.equal(closed, true, '摺頁預設是收起來的');
  });

  await t.test('一句話變成條件，而且不需要模型', async () => {
    const r = await run(cdp, via(`
      var SAY = '這禮拜 abc.com 寄來的信都列出來，內容有提到我的標起來，每天早上七點半自己跑一次';
      q('.mt-say').value = SAY;

      /* The model-free button. Nothing on this path may reach the core. */
      var buttons = qa('.mt-form-go .fbtn');
      var plain = buttons.filter(function (b) { return b.textContent.indexOf('不用模型') >= 0; })[0];
      out.push(!!plain);
      plain.click();
      for (var i = 0; i < 60; i++) {
        var st = await window.aios.mailtodo.state();
        if (st.data.rules.length) break;
        await tick();
      }

      var st2 = await window.aios.mailtodo.state();
      var rule = st2.data.rules[0];
      out.push(rule ? {
        say: rule.say, from: rule.from, days: rule.days, dailyAt: rule.dailyAt,
        planBy: rule.planBy, hasFingerprint: !!rule.sayFor, bodies: rule.bodies, limit: rule.limit
      } : null);
      out.push(rule ? AIOS.mailask.isStale(rule) : null);
    `));
    assert.equal(r.error, undefined, r.error);
    const [hasPlain, rule, stale] = r.out;
    assert.equal(hasPlain, true, '「不用模型」那顆按鈕應該在');
    assert.ok(rule, '按下去應該存出一條規則');
    assert.match(rule.say, /abc\.com/, '那句話要原封不動存下來');
    assert.equal(rule.from, 'abc.com', '網域要從句子裡讀出來');
    assert.equal(rule.days, 7, '「這禮拜」要讀成 7 天');
    assert.equal(rule.dailyAt, '07:30', '「每天早上七點半」要讀成 07:30');
    assert.equal(rule.planBy, 'rules', '這一條是機械讀出來的，不是模型');
    assert.equal(rule.hasFingerprint, true, '條件要記得自己是哪句話讀出來的');
    assert.ok(rule.bodies <= 12, '一次讀幾封內文不能超過橋的上限：' + rule.bodies);
    assert.equal(stale, false, '剛存好的規則不該被當成過時');
  });

  await t.test('純語意的例句，沒有模型也存得起來', async () => {
    /* The first three examples on the welcome screen name no sender, no keyword
       and no switch -- that is what makes them worth putting there. The first
       version of this spec happened to exercise the one example that contains a
       domain, and so it passed while five of the six suggestions on the first
       screen answered a machine with no core with a refusal. */
    const r = await run(cdp, via(`
      var SAY = '這禮拜有人問我問題、還在等我回覆的信挑出來，摘要直接寫對方在等什麼。';
      var before = (await window.aios.mailtodo.state()).data.rules.length;
      var add = qa('.mt-add')[0];
      if (add) { add.click(); await tick(); }
      q('.mt-say').value = SAY;
      qa('.mt-form-go .fbtn').filter(function (b) { return b.textContent.indexOf('不用模型') >= 0; })[0].click();
      for (var i = 0; i < 60; i++) {
        if ((await window.aios.mailtodo.state()).data.rules.length > before) break;
        await tick();
      }
      var st = await window.aios.mailtodo.state();
      out.push(st.data.rules.length - before);
      var made = st.data.rules.filter(function (x) { return x.say === SAY; })[0];
      out.push(made ? { sieve: made.sieve, sift: made.sift, from: made.from, text: made.text } : null);
      out.push(made ? AIOS.mailask.isWide(made) : null);
      out.push(q('.mt-form-note') ? q('.mt-form-note').textContent : '');
      if (made) await window.aios.mailtodo.removeRule(made.id);
      await inst.ctx.api.reload();
    `));
    assert.equal(r.error, undefined, r.error);
    const [added, made, wide, note] = r.out;
    assert.equal(added, 1, '純語意的句子必須存得起來，它正是這次改動的理由：' + note);
    assert.ok(made, '沒有找到剛存的那條');
    assert.equal(made.from, '', '這句話沒有寄件人');
    assert.equal(made.text, '', '也沒有關鍵字');
    assert.ok(made.sieve.length > 10, '判斷標準要退回用整句話，而不是空的：' + JSON.stringify(made.sieve));
    assert.equal(made.sift, true, '而且判斷要是開著的，等模型回來就會生效');
    assert.equal(wide, true, '同時要標成「看最新的幾封」，不能假裝掃過整個信箱');
  });

  await t.test('「為什麼只找到這些」的報告會留在畫面上', async () => {
    /* It used to be painted and then wiped inside the same click, because the
       handler called draw() afterwards -- so the button looked dead. */
    const r = await run(cdp, via(`
      var why = [].slice.call(inst.ctx.body.querySelectorAll('.mt-bar .fbtn'))
        .filter(function (b) { return b.textContent.indexOf('為什麼') >= 0; })[0];
      out.push(!!why);
      why.click();
      for (var i = 0; i < 80 && !q('.mt-report'); i++) await tick();
      await tick(); await tick();
      out.push(!!q('.mt-report'));
      out.push(q('.mt-report-body') ? q('.mt-report-body').textContent.slice(0, 400) : '');
      var back = [].slice.call(body.querySelectorAll('.mt-report .fbtn'))
        .filter(function (b) { return b.textContent.indexOf('回到清單') >= 0; })[0];
      out.push(!!back);
      back.click();
      await tick();
      out.push(!!q('.mt-report'));
    `));
    assert.equal(r.error, undefined, r.error);
    const [hasBtn, shown, text, hasBack, goneAfter] = r.out;
    assert.equal(hasBtn, true, '工具列上要有那顆按鈕');
    assert.equal(shown, true, '報告畫出來之後要留在畫面上，不能被 draw() 擦掉');
    assert.match(text, /在本機已同步的信裡數到的/, '而且要是真的報告：' + text);
    assert.match(text, /照這條規則現在的條件/, '逐條列出放寬的結果：' + text);
    assert.equal(hasBack, true, '要有回到清單的路');
    assert.equal(goneAfter, false, '按了才收起來');
  });

  await t.test('畫面顯示的是那句話，還有它被讀成什麼', async () => {
    const r = await run(cdp, via(`
      await inst.ctx.api.reload();
      await tick();
      out.push(q('.mt-say-shown') ? q('.mt-say-shown').textContent : '');
      out.push(q('.mt-rule-sub') ? q('.mt-rule-sub').textContent : '');
      out.push(qa('.mt-read-row').map(function (row) {
        return row.querySelector('.mt-read-k').textContent + '=' +
          row.querySelector('.mt-read-v').textContent;
      }));
    `));
    assert.equal(r.error, undefined, r.error);
    const [quoted, railed, card] = r.out;
    assert.match(quoted, /abc\.com/, '規則的畫面上要看到它自己那句話');
    assert.match(railed, /abc\.com/, '左邊的清單顯示的是那句話，不是欄位');
    const joined = card.join(' | ');
    assert.match(joined, /看誰的信=abc\.com/, '讀懂的卡片要說它會看誰的信');
    assert.match(joined, /往前=7 天/, '以及往前幾天');
    assert.match(joined, /一次=.*讀 \d+ 封的內文/,
      '以及「列幾封」與「讀幾封內文」是兩個數字：' + joined);
    assert.match(joined, /每天=07:30/, '句子裡的時間要出現在卡片上');
  });

  await t.test('改了句子而條件還沒重讀，畫面會講出來', async () => {
    const r = await run(cdp, via(`
      var st = await window.aios.mailtodo.state();
      var id = st.data.rules[0].id;
      /* The sentence alone, exactly as a hand edit or an import would leave it:
         the fingerprint now belongs to the previous one. */
      await window.aios.mailtodo.updateRule(id, { say: '這禮拜 xyz.com 寄來的信' });
      await inst.ctx.api.reload();
      await tick();
      var st2 = await window.aios.mailtodo.state();
      out.push(AIOS.mailask.isStale(st2.data.rules[0]));
      out.push(qa('.mt-badge').map(function (b) { return b.textContent; }));
      out.push(q('.mt-rule-run') ? q('.mt-rule-run').textContent : '');
    `));
    assert.equal(r.error, undefined, r.error);
    const [stale, badges, rail] = r.out;
    assert.equal(stale, true, '句子換了、指紋沒換，就是過時');
    assert.ok(badges.some((b) => b.includes('句子改過')),
      '規則的標題旁邊要標出來：' + JSON.stringify(badges));
    assert.match(rail, /句子改過/, '左邊的清單也要看得出來');
  });

  await t.test('「為什麼只找到這些」在沒有信箱的時候也答得出話', async () => {
    /* The probe is the answer to the complaint a semantic rule earns most often.
       It must not throw when there is no mailbox -- that is precisely the machine
       most likely to be asking. */
    const r = await run(cdp, via(`
      var report = '';
      try { report = await inst.ctx.api.diagnose(); }
      catch (e) { report = 'THREW: ' + (e.message || e); }
      out.push(report);
    `));
    assert.equal(r.error, undefined, r.error);
    const report = r.out[0];
    assert.ok(!report.startsWith('THREW'), '沒有信箱時不該爆掉：' + report);
    assert.ok(report.length > 20, '報告是空的');
    assert.match(report, /照這條規則現在的條件/, '報告要逐條列出放寬的結果');
  });

  await t.test('沒有條件的規則存不起來，而且說得出為什麼', async () => {
    const r = await run(cdp, via(`
      /* Days alone is every message with extra steps. A rule has to narrow the
         mailbox somehow, or say what counts. */
      var bad = await window.aios.mailtodo.addRule({ name: '空的', days: 7 });
      out.push(bad.ok);
      out.push(bad.error || '');
      var ok = await window.aios.mailtodo.addRule({
        name: '只有判準', days: 7, sieve: '只留在催我回覆的', sift: true, say: '只留在催我回覆的'
      });
      out.push(ok.ok);
      out.push(ok.ok ? AIOS.mailask.isWide(ok.data) : null);
      if (ok.ok) await window.aios.mailtodo.removeRule(ok.data.id);
    `));
    assert.equal(r.error, undefined, r.error);
    const [refused, why, accepted, wide] = r.out;
    assert.equal(refused, false, '只有天數的規則不該存得起來');
    assert.match(why, /條件/, '而且要說得出為什麼：' + why);
    assert.equal(accepted, true, '只有判斷標準的規則是合理的，要存得起來');
    assert.equal(wide, true, '但它要被標成「看最新的幾封」，不能假裝掃過整個信箱');
  });

  await t.test('勾掉的不會因為再跑一次就回來', async () => {
    /* The tombstone lesson, at the level the store owns. Re-running is the
       repair loop for a sentence that came out wrong, so it has to update what
       the machine said while leaving every decision alone. */
    const r = await run(cdp, via(`
      var st = await window.aios.mailtodo.state();
      var id = st.data.rules[0].id;
      var row = {
        messageId: '<e2e-todo@example.com>', handle: 'e2e0000001',
        subject: 'e2e 的信', from: 'someone@abc.com', date: Date.now(),
        summary: '第一次的摘要', why: '第一次的理由'
      };
      await window.aios.mailtodo.putItems(id, [row]);
      var one = await window.aios.mailtodo.state();
      var item = one.data.items.filter(function (i) { return i.ruleId === id; })[0];
      await window.aios.mailtodo.patchItem(item.id, { done: true });

      /* The same message again, with the machine's opinion changed and a verdict
         attached. The tick must survive; the summary must not be frozen. */
      var put = await window.aios.mailtodo.putItems(id, [
        Object.assign({}, row, { summary: '第二次的摘要', why: '第二次的理由', aside: true })
      ]);
      out.push(put.data.fresh);
      out.push(put.data.touched);
      var two = await window.aios.mailtodo.state();
      var again = two.data.items.filter(function (i) { return i.ruleId === id; });
      out.push(again.length);
      out.push(again[0] ? { done: again[0].done, summary: again[0].summary, why: again[0].why, aside: again[0].aside } : null);
    `));
    assert.equal(r.error, undefined, r.error);
    const [fresh, touched, count, item] = r.out;
    assert.equal(fresh, 0, '同一封信不該變成第二項待辦');
    assert.equal(touched, 1, '但機器說的話要更新');
    assert.equal(count, 1);
    assert.equal(item.done, true, '勾掉的必須留著勾掉——這是墓碑那一課');
    assert.equal(item.summary, '第二次的摘要', '摘要要跟著重跑更新，不然改句子就看不到效果');
    assert.equal(item.why, '第二次的理由');
    assert.equal(item.aside, false,
      '已經在清單上的一列，不該被後來的判斷默默收進抽屜');
  });
}
