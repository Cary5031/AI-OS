'use strict';

/* ===========================================================================
   The second mail source: a signed-in Outlook Web session.

   There is no O365 tenant here to point this at, which is exactly why these
   tests exist. Everything in owa.js that decides something -- what a message's
   identity is, how far back a sync reaches, whether a response means "sign in
   again" -- is a pure function, and this file feeds it the response shapes the
   design says it will meet, including the malformed ones.

   Four of these tests are here because a design review said the original plan
   would produce a specific wrong result. Each of those names the result.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const sandbox = require('../app/main/sandbox');
const store = require('../app/main/mailstore');
const owa = require('../app/main/owa');

const ACCOUNT = 'staff@company.com';

/** One message the way a FindItem response carries it. */
function item(over = {}) {
  return {
    ItemId: { Id: 'AAMkAD001', ChangeKey: 'CQAAABYA' },
    Subject: '九月份報價單',
    DateTimeReceived: '2026-09-08T02:10:00Z',
    From: { Mailbox: { Name: '王小明', EmailAddress: 'ming@abc.com' } },
    ToRecipients: [{ Mailbox: { Name: '我', EmailAddress: ACCOUNT } }],
    IsRead: false,
    HasAttachments: false,
    ...over
  };
}

/** The wrapper OWA puts around a page of them. */
function findResponse(items, last = true) {
  return {
    Body: {
      ResponseMessages: {
        Items: [{
          RootFolder: {
            TotalItemsInView: items.length,
            IncludesLastItemInRange: last,
            Items: items
          }
        }]
      }
    }
  };
}

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-owa-'));
  await sandbox.init(dir);
  await store.purge().catch(() => {});
  await store.init(ACCOUNT);
  return dir;
}

/* ------------------------------------------------------------- identity --- */

test('the same message through two different responses is one row, not two', async () => {
  /* The failure: OWA's list request and its open request do not carry the same
     fields. If the key is decided from whatever a response happens to hold, the
     list stores the message under a hash of its ItemId and the open stores it
     again under the real Message-ID -- two rows for one message, with the star
     and the tombstone on one and the body on the other. The deleted message
     comes back the next morning.

     The rule that prevents it: whoever sees the item first decides the key, and
     the mirror is asked about the ItemId before a new key is minted. */
  await freshStore();

  const thin = item();                       // as a list response often is
  const fat = item({ InternetMessageId: '<real-2026-09@abc.com>' });

  const firstPass = owa.adoptPage([thin], {
    folder: 'INBOX',
    lookup: (sid) => store.bySource(sid),
    has: (id) => !!store.get(id)
  });
  firstPass.rows.forEach((r) => store.put(r));
  const keyed = firstPass.rows[0].messageId;
  assert.match(keyed, /^<owa-[0-9a-f]{32}@aios\.local>$/, '沒有 Message-ID 時才用雜湊');

  store.setLocal(keyed, { deleted: true });   // the user deletes it here

  const secondPass = owa.adoptPage([fat], {
    folder: 'INBOX',
    lookup: (sid) => store.bySource(sid),
    has: (id) => !!store.get(id)
  });
  secondPass.rows.forEach((r) => store.put(r));

  assert.equal(secondPass.rows[0].messageId, keyed,
    '第二次看到同一封信，就算這次帶了真的 Message-ID，也要沿用原本的鍵');
  assert.equal(store.list({ includeDeleted: true }).length, 1, '一封信只能有一列');
  assert.equal(store.list({ includeDeleted: false }).length, 0, '刪除的墓碑還在，信沒有復活');
});

test('a message the user touched in Outlook keeps its key: the ChangeKey is not part of it', async () => {
  /* The failure: an EWS ItemId is {Id, ChangeKey}, and the ChangeKey changes
     every time anything on the server touches the message -- read on the phone,
     flagged, categorised, moved by a rule. Hashing the pair mints a new
     identity at every sync: a new row each morning, the local delete never
     sticks, the list fills with duplicates of one message. */
  const monday = owa.normaliseItem(item({ InternetMessageId: '' }));
  const tuesday = owa.normaliseItem(item({
    InternetMessageId: '',
    ItemId: { Id: 'AAMkAD001', ChangeKey: 'CQAAABYA-COMPLETELY-DIFFERENT' }
  }));

  assert.equal(monday.messageId, tuesday.messageId, 'ChangeKey 變了，鍵不能跟著變');
  assert.equal(monday.sourceId, 'AAMkAD001', 'sourceId 也只存 Id');
  assert.ok(!monday.sourceId.includes('CQAAABYA'), 'ChangeKey 不能混進 sourceId');

  const moved = owa.normaliseItem(item({ InternetMessageId: '', ItemId: { Id: 'AAMkAD-NEW' } }));
  assert.notEqual(moved.messageId, monday.messageId,
    '搬過資料夾之後 Id 真的變了，那就是新的身分——這是誠實的結果，不是 bug');
});

test('a real Message-ID is kept exactly as written, so both sources land on one row', () => {
  /* mail.js messageIdOf() trims and does nothing else: it keeps the angle
     brackets and the case. Anything different here makes a mailbox that has
     been read through both IMAP and the web two mailboxes. */
  assert.equal(owa.keyFor('  <Abc.DEF@Example.COM>  ', 'x'), '<Abc.DEF@Example.COM>');
  assert.equal(owa.keyFor('', ''), '', '兩個都沒有就不該編一個出來');
  assert.equal(owa.keyFor(null, 'AAA'), owa.keyFor(undefined, 'AAA'), '同一個 Id 一定得到同一個鍵');
});

test('InternetMessageId is asked for by name and as extended property 0x1035', () => {
  /* Without it every row falls back to a hash key, which is the fragile path.
     The two spellings have different odds of surviving a server version, so the
     request asks for both and the normaliser reads both. */
  const body = owa.findItemBody('inbox', 0, 50);
  const props = body.Body.ItemShape.AdditionalProperties;
  assert.ok(props.some((p) => p.FieldURI === 'MessageInternetMessageId'), '要用名字問一次');
  assert.ok(props.some((p) => String(p.PropertyTag).toLowerCase() === '0x1035'), '也要用擴充屬性問一次');

  const named = owa.internetMessageIdOf({ InternetMessageId: '<a@b>' });
  const extended = owa.internetMessageIdOf({
    ExtendedProperty: [{ ExtendedFieldURI: { PropertyTag: '0x1035', PropertyType: 'String' }, Value: '<a@b>' }]
  });
  assert.equal(named, '<a@b>');
  assert.equal(extended, '<a@b>', '只回擴充屬性的伺服器也要讀得到');
});

/* --------------------------------------------------------------- cursor --- */

test('the cursor overlaps, so messages sharing a second with the last one are not lost', () => {
  /* The failure: 200 newest by received time, cursor set to the newest, next
     sync asks for "greater than the cursor". Items 200 and 201 share a second
     -- routine for a distribution list -- so 201 is below the page and not
     greater than anything. Nothing ever lowers the cursor, so it is missed
     forever and 「這禮拜從 ABC 寄來的」 is quietly short one message. */
  const now = Date.parse('2026-09-12T09:00:00Z');
  const stopped = Date.parse('2026-09-12T08:00:00Z');

  const first = owa.syncPlan({ cursor: {}, now });
  assert.equal(first.first, true);
  assert.equal(first.floor, now - owa.FIRST_DAYS * 86400000,
    '第一次同步用日期決定範圍，不是「最新的 N 封」');

  const next = owa.syncPlan({ cursor: { owaSince: stopped }, now });
  assert.equal(next.first, false);
  assert.equal(next.floor, stopped - owa.OVERLAP_MS, '之後每次都往回多走一段，重看不花錢，漏掉才貴');
  assert.ok(next.floor < stopped, '界線必須低於上次停下來的地方');

  const rescan = owa.syncPlan({ cursor: { owaSince: stopped }, deep: true, now });
  assert.equal(rescan.floor, now - owa.FIRST_DAYS * 86400000,
    '完整重掃才看得到被規則搬進來、日期比較舊的信');
});

test('paging stops at the floor and the floor is inclusive', () => {
  const floor = Date.parse('2026-09-01T00:00:00Z');
  const on = item({ ItemId: { Id: 'ON' }, DateTimeReceived: '2026-09-01T00:00:00Z' });
  const below = item({ ItemId: { Id: 'BELOW' }, DateTimeReceived: '2026-08-31T23:59:59Z' });

  const got = owa.adoptPage([item({ ItemId: { Id: 'NEW' } }), on, below], { floor });
  assert.deepEqual(got.rows.map((r) => r.sourceId), ['NEW', 'ON'],
    '正好落在界線上的要收，低於界線的不收');
  assert.equal(got.stop, true, '看到低於界線的就該停止翻頁');
});

/* ----------------------------------------------------------- the shapes --- */

test('messages are found wherever the response puts them, and an attached message is not one', () => {
  /* Following one documented path makes a single renamed wrapper an empty
     inbox. Walking instead costs nothing and survives that. */
  const flat = owa.walkItems(findResponse([item(), item({ ItemId: { Id: 'B' } })]), [], 0);
  assert.equal(flat.length, 2);

  const renamed = { d: { NewWrapper: { Results: { Rows: [item()] } } } };
  assert.equal(owa.walkItems(renamed, [], 0).length, 1, '換個包裝還是要找得到');

  const withAttachedMail = findResponse([item({
    Attachments: [{ ItemAttachment: { AttachmentId: { Id: 'att1' }, Name: '轉寄的信.eml', Subject: '別的主旨', ItemId: { Id: 'INNER' } } }]
  })]);
  const found = owa.walkItems(withAttachedMail, [], 0);
  assert.equal(found.length, 1, '附件裡夾的信不是收件匣裡的信');
  assert.equal(owa.attachmentsOf(found[0])[0].name, '轉寄的信.eml');
});

test('a renamed field costs that field and says so, not the whole sync', () => {
  const broken = { ItemId: { Id: 'X1' }, Subject: '還在', DateTimeReceived: '2026-09-08T02:00:00Z' };
  const row = owa.normaliseItem(broken, { folder: 'INBOX' });
  assert.equal(row.subject, '還在');
  assert.equal(row.from, '', '寄件人這一版沒給');
  assert.deepEqual(row.missing, ['from'], '少了什麼要記下來，不是靜靜留白');
  assert.equal(row.messageId, owa.keyFor('', 'X1'), '其他的照常，這一列還是進得了鏡像');

  const nothing = owa.normaliseItem({}, {});
  assert.equal(nothing.messageId, '', '連 ItemId 都沒有就不該產生一列');
  assert.ok(nothing.missing.includes('sourceId'));
});

test('sender and recipients read the same whichever wrapper the version uses', () => {
  assert.equal(owa.oneAddress({ Mailbox: { Name: '王小明', EmailAddress: 'ming@abc.com' } }).text,
    '王小明 <ming@abc.com>');
  assert.equal(owa.oneAddress({ EmailAddress: 'ming@abc.com' }).text, 'ming@abc.com',
    '沒有 Mailbox 包裝的也要讀得到');
  assert.equal(owa.oneAddress({ Mailbox: { EmailAddress: 'a@b.c' } }).text, 'a@b.c', '沒有名字就只給地址');
  assert.equal(owa.manyAddresses([
    { Mailbox: { Name: '甲', EmailAddress: 'a@x.com' } },
    { Mailbox: { EmailAddress: 'b@x.com' } }
  ]), '甲 <a@x.com>, b@x.com');
  assert.equal(owa.manyAddresses(undefined), '', '沒有收件人欄位不是錯誤');
});

test('HTML bodies come out as text with no script and no remote image left in them', () => {
  const html = '<html><head><style>p{color:red}</style></head><body>' +
    '<script>fetch("http://tracker/x")</script>' +
    '<p>報價如下：</p><p>單價 <b>1,200</b> 元</p>' +
    '<img src="http://tracker/pixel.gif">&amp;&nbsp;結束</body></html>';
  const text = owa.bodyTextOf({ Body: { BodyType: 'HTML', Value: html } });
  assert.ok(text.includes('報價如下'));
  assert.ok(text.includes('單價 1,200 元'));
  assert.ok(!/script|tracker|<img/i.test(text), '腳本與遠端圖片不能留在內文裡：那是讀取回報');
  assert.ok(text.includes('& 結束'), 'HTML 實體要還原');

  assert.equal(owa.bodyTextOf({ Body: { BodyType: 'Text', Value: '  純文字  ' } }), '純文字');
  assert.equal(owa.bodyTextOf({}), '', '沒有內文不是錯誤');
});

test('attachment metadata and bytes are found in either shape', () => {
  const wrapped = {
    Attachments: [{
      FileAttachment: {
        AttachmentId: { Id: 'AAA' }, Name: '報價單.xlsx',
        ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        Size: 40960, IsInline: false
      }
    }]
  };
  const flat = { Attachments: [{ AttachmentId: 'BBB', Name: '簽核.pdf', ContentType: 'application/pdf', Size: 1024 }] };

  const a = owa.attachmentsOf(wrapped)[0];
  assert.equal(a.id, 'AAA');
  assert.equal(a.name, '報價單.xlsx');
  assert.equal(a.bytes, 40960);

  const b = owa.attachmentsOf(flat)[0];
  assert.equal(b.id, 'BBB', 'AttachmentId 是字串的版本也要讀得到');
  assert.equal(b.name, '簽核.pdf');

  assert.equal(owa.attachmentContentOf({
    Body: { ResponseMessages: { Items: [{ Attachments: [{ FileAttachment: { Content: 'aGVsbG8=' } }] }] } }
  }), 'aGVsbG8=');
  assert.equal(owa.attachmentContentOf({ Body: {} }), null, '沒有內容就說沒有，不要回空字串裝成功');
});

/* ------------------------------------------------------------- sign-in ---- */

test('"sign in again" is told apart from "it broke"', () => {
  /* One of these is the user's Tuesday morning and the other is a bug. A
     scheduled run that reports the wrong one sends them to the wrong place. */
  assert.equal(owa.needsLogin({ url: 'https://login.microsoftonline.com/common/oauth2/authorize', status: 200 }), true);
  assert.equal(owa.needsLogin({ url: 'https://outlook.office.com/owa/service.svc', status: 401 }), true);
  assert.equal(owa.needsLogin({ url: 'https://outlook.office.com/owa/service.svc', status: 440 }), true,
    '440 是 OWA 自己的「工作階段過期」');
  assert.equal(owa.needsLogin({
    url: 'https://outlook.office.com/owa/service.svc', status: 200, contentType: 'text/html; charset=utf-8'
  }), true, '回 HTML 就是被導去登入頁了，不是回答');

  assert.equal(owa.needsLogin({
    url: 'https://outlook.office.com/owa/service.svc', status: 200, contentType: 'application/json',
    text: '{"Body":{"ResponseMessages":{"Items":[]}}}'
  }), false, '正常的空回應不是要重新登入');
  assert.equal(owa.needsLogin({
    url: 'https://outlook.office.com/owa/service.svc', status: 500, contentType: 'application/json'
  }), false, '伺服器自己壞掉不該叫使用者去重新登入');
});

test('the mailbox address is where reading happens, and it cannot be turned into somewhere else', () => {
  assert.equal(owa.sanitiseBase(''), owa.DEFAULT_BASE);
  assert.equal(owa.sanitiseBase('https://outlook.office365.com/mail/inbox'), 'https://outlook.office365.com');
  assert.equal(owa.sanitiseBase('http://evil.example.com'), owa.DEFAULT_BASE, '非 https 的外部網址不接受');
  assert.equal(owa.sanitiseBase('not a url'), owa.DEFAULT_BASE);
  assert.equal(owa.sanitiseBase('javascript:alert(1)'), owa.DEFAULT_BASE);
});

/* -------------------------------------------------------------- folders --- */

test('the folder the application asks for is the folder the mirror is written under', () => {
  /* The failure: the application syncs 'INBOX', the server wants 'inbox', and
     rows written under the server's id or its display name mean loadFolder
     shows nothing after a sync that reported twenty new messages -- and the
     cursor is filed under a different key than the next sync reads, so every
     sync is a first sync. */
  assert.equal(owa.distinguished('INBOX'), 'inbox');
  assert.equal(owa.folderName('inbox'), 'INBOX', '寫進鏡像的一律是 app 用的名字');
  assert.equal(owa.folderName('收件匣'), 'INBOX');
  assert.equal(owa.distinguished('Deleted Items'), 'deleteditems');
  assert.equal(owa.folderName('Deleted Items'), 'Trash');
  assert.equal(owa.distinguished('搜尋資料夾'), '', '不認得的資料夾要說不認得，不要猜');

  const rows = owa.adoptPage([item()], { folder: 'INBOX' }).rows;
  assert.equal(rows[0].folder, 'INBOX');
});

test('a row carries a link back to the message in Outlook', async () => {
  await freshStore();
  const row = owa.adoptPage([item()], { folder: 'INBOX' }).rows[0];
  store.put(row);
  const held = store.get(row.messageId);
  assert.ok(held.webLink.includes('/mail/deeplink/read/'), '「在 Outlook 開啟」要有東西可開');
  assert.ok(held.webLink.includes('AAMkAD001'));
  assert.equal(held.sourceId, 'AAMkAD001', 'sourceId 是之後抓內文與附件唯一的憑據');
});

/* ------------------------------------------------------------- coverage --- */

test('the mirror says how far back it reaches, so a partial answer looks partial', async () => {
  await freshStore();
  const days = [1, 3, 9].map((d) => item({
    ItemId: { Id: 'I' + d },
    DateTimeReceived: '2026-09-0' + d + 'T01:00:00Z'
  }));
  owa.adoptPage(days, { folder: 'INBOX' }).rows.forEach((r) => store.put(r));

  const cov = store.coverage('INBOX');
  assert.equal(cov.messages, 3);
  assert.equal(cov.oldest, Date.parse('2026-09-01T01:00:00Z'));
  assert.equal(cov.newest, Date.parse('2026-09-09T01:00:00Z'));
  assert.equal(store.coverage('Sent').messages, 0, '沒同步過的資料夾要回 0，不是崩潰');
});

test('a feeder that knows why it could not get an attachment gets to say so', async () => {
  /* Without this the reader shows a name and a size for a file nobody can ever
     open, and the only explanation on offer is 「重新同步一次試試」 -- which does
     nothing, because the body is already cached. */
  await freshStore();
  const row = owa.adoptPage([item({ HasAttachments: true })], { folder: 'INBOX' }).rows[0];
  store.put(row);
  await store.putBody(row.messageId, '內文');

  const kept = await store.putAttachments(row.messageId, [
    { name: '好的.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4') },
    { name: '拿不到.xlsx', type: 'application/octet-stream', bytes: 2048, data: null, reason: 'Outlook 沒有回傳這個附件的內容' }
  ]);

  assert.equal(kept[0].stored, true);
  assert.equal(kept[1].stored, false);
  assert.equal(kept[1].reason, 'Outlook 沒有回傳這個附件的內容', '理由要照抄，使用者才知道下一步');
  assert.ok((await store.attachment(row.messageId, 0)).data.length > 0, '拿得到的那個還在');
  const gone = await store.attachment(row.messageId, 1);
  assert.equal(gone.data, null, '拿不到的那個沒有位元組');
  assert.equal(gone.reason, 'Outlook 沒有回傳這個附件的內容', '但它還是帶著理由，不是靜靜消失');
});

test('the source is read-only by construction: the verbs simply are not there', () => {
  /* Not a policy that can be toggled and not a check that can be bypassed by a
     message telling the model to delete the audit mail. There is no call in the
     module that could change the real mailbox, and this is the test that
     notices the day somebody adds one. */
  const exported = Object.keys(owa);
  const writes = exported.filter((k) => /send|delete|remove|move|markSeen|setSeen|flag|reply|forward/i.test(k));
  assert.deepEqual(writes, [], '這個模組不該有任何會改動真實信箱的出口：' + writes.join(', '));

  const src = require('node:fs').readFileSync(require.resolve('../app/main/owa.js'), 'utf8');
  for (const action of ['CreateItem', 'DeleteItem', 'MoveItem', 'UpdateItem', 'SendItem', 'MarkAsRead']) {
    assert.ok(!src.includes("'" + action + "'"), 'owa.js 裡不該出現 ' + action + ' 這個動作');
  }
});
