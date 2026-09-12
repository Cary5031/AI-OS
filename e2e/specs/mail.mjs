/* The local mail mirror.

   Most of this needs no mailbox: the store, the tombstones and -- most
   importantly -- the boundary that keeps the mirror out of reach of `fs.*`. */

import assert from 'node:assert/strict';
import { run } from '../lib/cdp.mjs';

export const name = '郵件鏡像';

export async function spec(t, app) {
  const { cdp } = app;

  await t.test('`.mail` 是保留區，fs.* 一律碰不到', async () => {
    /* This is a capability boundary, not tidiness. `fs.read` is granted by
       default, so a mailbox under an ordinary path would let anything read any
       message without ever holding `mail.read` -- the gate would be decorative.
       Every fs.* route has to refuse. */
    const r = await run(cdp, `
      var out = {};
      var probe = '/.mail/anything.json';
      out.read   = await window.aios.fs.read(probe);
      out.write  = await window.aios.fs.write(probe, 'x');
      out.list   = await window.aios.fs.list('/.mail');
      out.mkdir  = await window.aios.fs.mkdir('/.mail/sub');
      out.copy   = await window.aios.fs.copy('/notes/readme.txt', probe);
      // And it must not show up in a listing of the root either.
      var root = await window.aios.fs.list('/');
      out.inRoot = root.ok && root.data.entries.some(function (e) { return e.name === '.mail'; });
      return {
        codes: ['read', 'write', 'list', 'mkdir', 'copy'].map(function (k) {
          return k + '=' + (out[k].ok ? 'ALLOWED' : out[k].code);
        }),
        inRoot: out.inRoot
      };
    `);
    for (const line of r.codes) {
      assert.ok(line.endsWith('ERESERVED'),
        '這條路徑沒有被擋下來，郵件會繞過 mail.read 能力：' + line);
    }
    assert.equal(r.inRoot, false, '.mail 不該出現在沙箱根目錄的列表裡');
  });

  await t.test('沒有設定帳號時，鏡像的讀取會說清楚而不是壞掉', async () => {
    const r = await run(cdp, `
      var stats = await window.aios.mail.mirrorStats();
      var list = await window.aios.mail.mirrorList({ folder: 'INBOX' });
      return { statsOk: stats.ok, stats: stats.data, listOk: list.ok, listErr: list.error };
    `);
    assert.equal(r.statsOk, true, 'mirrorStats 應該要能呼叫');
    assert.equal(r.stats, null, '沒有帳號時不該有鏡像統計');
    /* No account means no store; the call has to fail with something a person
       can act on rather than throwing an internal error. */
    assert.equal(r.listOk, false, '沒有帳號卻列得出信件');
    assert.ok(r.listErr && r.listErr.length > 2, '失敗訊息是空的：' + r.listErr);
  });

  await t.test('郵件的能力閘門仍然管得住鏡像', async () => {
    /* The mirror holds the same content the live calls return, so it must not
       become a cheaper way to reach it. */
    const r = await run(cdp, `
      var before = (await window.aios.sysInfo()).data.policy['mail.read'];
      await window.aios.policy.set('mail.read', 'deny');
      var denied = await window.aios.mail.mirrorRead('<whatever@example.com>');
      await window.aios.policy.set('mail.read', before);
      return { code: denied.code, ok: denied.ok };
    `);
    assert.equal(r.ok, false, 'mail.read 設成 DENY 之後，鏡像仍然讀得出信');
    assert.equal(r.code, 'EDENIED', '被擋下的理由不對：' + r.code);
  });

  await t.test('設定帳號只問信箱，伺服器是查出來的', async () => {
    /* The form used to open on four hostname boxes and two port numbers, which
       is a question most people cannot answer about their own mailbox. What is
       checked here is the shape of the two stages -- one field, then what was
       found plus a password -- and that the boxes are still reachable for
       somebody who does know their server.

       The address is a gmail.com one on purpose: that domain is answered from
       the built-in table without a single packet, so this test does not depend
       on the network being up or on anyone else's server staying configured. */
    const r = await run(cdp, `
      AIOS.apps.instances().filter(function (i) { return i.def.id === 'mail'; })
        .forEach(function (i) { AIOS.wm.close(i.win); });
      await new Promise(function (r) { setTimeout(r, 250); });

      await AIOS.apps.launch('mail');
      var inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'mail'; }).pop();
      if (!inst) return { error: '郵件沒開起來' };
      for (var i = 0; i < 60 && !inst.win; i++) await new Promise(function (r) { setTimeout(r, 100); });
      await new Promise(function (r) { setTimeout(r, 700); });

      var el = inst.win.el;
      var q = function (s) { return el.querySelector(s); };
      var all = function (s) { return [].slice.call(el.querySelectorAll(s)); };
      var out = {};

      out.stage1Fields = all('.ml-form .ml-input').length;
      out.stage1Type = q('.ml-form .ml-input') ? q('.ml-form .ml-input').type : null;
      out.stage1Hosts = !!q('.ml-custom');
      out.stage1Password = !!q('.ml-form input[type=password]');

      q('.ml-form .ml-input').value = 'someone@gmail.com';
      q('.ml-form button[type=submit]').click();
      for (var j = 0; j < 100 && !q('.ml-found-ok'); j++) await new Promise(function (r) { setTimeout(r, 100); });

      out.found = q('.ml-found-ok') ? q('.ml-found-ok').textContent : null;
      out.hosts = all('.ml-form .ml-dl dd').map(function (d) { return d.textContent; });
      out.stage2Password = !!q('.ml-form input[type=password]');
      out.hostsHidden = q('.ml-manual') ? q('.ml-manual').hidden : null;

      var manual = all('.ml-links button').filter(function (b) { return b.textContent === '手動設定'; });
      out.manualButton = manual.length;
      if (manual.length) { manual[0].click(); await new Promise(function (r) { setTimeout(r, 250); }); }
      out.manualOpen = q('.ml-manual') ? !q('.ml-manual').hidden : null;
      out.prefilled = all('.ml-custom .ml-input').map(function (i) { return i.value; });

      var again = all('.ml-links button').filter(function (b) { return b.textContent === '換一個信箱'; })[0];
      if (again) { again.click(); await new Promise(function (r) { setTimeout(r, 250); }); }
      out.backToOneField = all('.ml-form .ml-input').length;

      AIOS.wm.close(inst.win);
      return out;
    `, { timeout: 60000 });

    assert.equal(r.error, undefined, r.error);

    assert.equal(r.stage1Fields, 1, '第一步應該只問一件事，卻有 ' + r.stage1Fields + ' 個欄位');
    assert.equal(r.stage1Type, 'email');
    assert.equal(r.stage1Hosts, false, '還沒問到信箱就先擺出主機欄位了');
    assert.equal(r.stage1Password, false, '密碼欄不該在知道伺服器是誰之前出現');

    assert.ok(r.found && r.found.indexOf('Gmail') >= 0, '沒認出 Gmail：' + r.found);
    /* The hostnames are on screen before the password box, which is what makes
       a redirected config file a visible mistake instead of a silent one. */
    assert.deepEqual(r.hosts, ['imap.gmail.com:993（SSL）', 'smtp.gmail.com:465（SSL）'],
      '查到的主機沒有照實顯示：' + JSON.stringify(r.hosts));
    assert.equal(r.stage2Password, true, '查到設定之後就該問密碼了');
    assert.equal(r.hostsHidden, true, '查得到的時候不該把主機欄位攤在畫面上');

    assert.equal(r.manualButton, 1, '知道自己伺服器的人要有路可走');
    assert.equal(r.manualOpen, true, '按了手動設定，欄位沒有打開');
    assert.deepEqual(r.prefilled, ['imap.gmail.com', '993', 'smtp.gmail.com', '465'],
      '手動欄位沒有帶入查到的值，等於要人重打一次：' + JSON.stringify(r.prefilled));

    assert.equal(r.backToOneField, 1, '換一個信箱應該回到只問信箱的那一步');
  });

  await t.test('郵件視窗開得起來，搜尋框在，動作接得到方法', async () => {
    /* No account, so the window shows the account form -- but the toolbar,
       the search box and ctx.api are built before that, and a ReferenceError
       anywhere in mount() would have left ctx.api undefined. */
    const r = await run(cdp, `
      var live = AIOS.apps.instances().filter(function (i) { return i.def.id === 'mail'; });
      if (!live.length) await AIOS.apps.launch('mail');
      var inst;
      for (var i = 0; i < 100; i++) {
        inst = AIOS.apps.instances().filter(function (i) { return i.def.id === 'mail'; })[0];
        if (inst && inst.ctx && inst.ctx.api) break;
        await new Promise(function (r) { setTimeout(r, 100); });
      }
      if (!inst || !inst.ctx || !inst.ctx.api) return { error: '郵件視窗沒有開起來' };
      return { out: [
        !!document.querySelector('.ml-search'),
        ['search', 'openById', 'saveAttachment'].map(function (k) { return typeof inst.ctx.api[k]; }),
        Object.keys(inst.def.actions)
      ] };
    `);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.out[0], true, '工具列要有搜尋框');
    assert.deepEqual(r.out[1], ['function', 'function', 'function']);
    ['search', 'openById', 'saveAttachment'].forEach((a) => {
      assert.ok(r.out[2].includes(a), '動作 ' + a + ' 要發布出去');
    });
  });

  await t.test('筆記裡的 aios-mail: 連結會被畫成連結，而不是「不支援」', async () => {
    /* The kernel ends 「幫我記下來」 with one of these. If the viewer treated
       the scheme as unknown it would render dead text with a note saying so,
       and the whole point of the link would be lost quietly. */
    const r = await run(cdp, `
      await window.aios.fs.write('/notes/e2e-mail-link.md',
        '# 待辦\\n\\n- 回覆報價 [打開那封信](aios-mail:<abc@example.com>)\\n- 外部 [網站](https://example.com)\\n');
      await AIOS.afterFsChange();
      await AIOS.apps.launch('markdown', '/notes/e2e-mail-link.md', { forceNew: true });
      var page;
      for (var i = 0; i < 60; i++) {
        page = document.querySelector('.md-page, .md-body, .md-view');
        if (page && page.querySelector('a')) break;
        await new Promise(function (r) { setTimeout(r, 100); });
      }
      var links = [].slice.call(document.querySelectorAll('.md-link')).map(function (a) {
        return { text: a.textContent, dead: false };
      });
      var dead = [].slice.call(document.querySelectorAll('.md-link-dead')).map(function (n) { return n.textContent; });
      return { out: [links, dead] };
    `);
    assert.equal(r.error, undefined, r.error);
    const texts = r.out[0].map((l) => l.text);
    assert.ok(texts.some((t2) => t2.includes('打開那封信')), '信件連結要是連結：' + JSON.stringify(r.out));
    assert.equal(r.out[1].some((d) => d.includes('打開那封信')), false, '不該被畫成「不支援的連結」');
  });

}
