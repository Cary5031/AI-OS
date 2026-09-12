'use strict';

/* ===========================================================================
   The local mail mirror, exercised for real.

   Not a source-shape test: this runs the store against a temporary sandbox and
   checks what it does. The claims worth checking are the ones a mailbox would
   otherwise have to prove -- above all that a message deleted here does not
   come back the next time the folder is synced.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const sandbox = require('../app/main/sandbox');
const store = require('../app/main/mailstore');

const ACCOUNT = 'someone@example.com';

/** A message as `syncFolder` would hand it over. */
function msg(n, over = {}) {
  return {
    messageId: `<m${n}@example.com>`,
    uid: n,
    folder: 'INBOX',
    from: `寄件人${n} <s${n}@example.com>`,
    fromName: `寄件人${n}`,
    to: ACCOUNT,
    subject: `主旨 ${n}`,
    date: 1700000000000 + n * 1000,
    seen: false,
    ...over
  };
}

async function freshStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-mailstore-'));
  await sandbox.init(dir);
  await store.purge().catch(() => {});
  await store.init(ACCOUNT);
  return dir;
}

test('a message deleted here does not come back when the folder is synced again', async () => {
  /* The whole point of the mirror. The message stays on the server, so a naive
     store would re-import it on the next sync and the deletion would look like
     it never happened -- which is worse than having no delete at all. */
  await freshStore();

  store.put(msg(1));
  store.put(msg(2));
  await store.flush();
  assert.equal(store.list({}).length, 2);

  store.setLocal('<m1@example.com>', { deleted: true });
  assert.deepEqual(store.list({}).map((m) => m.messageId), ['<m2@example.com>'],
    '刪除之後不該再出現在清單裡');

  // The server still has it, so the next sync offers it again -- with a new UID,
  // as it would be after the mailbox was renumbered.
  store.put(msg(1, { uid: 991 }));

  assert.deepEqual(store.list({}).map((m) => m.messageId), ['<m2@example.com>'],
    '重新同步之後，刪掉的信復活了');
  assert.equal(store.get('<m1@example.com>').deleted, true, '墓碑應該還在');
  assert.equal(store.get('<m1@example.com>').uid, 991,
    '墓碑不該阻止其他欄位更新，否則 UID 會永遠停在舊值');

  // And it is still there when asked for explicitly.
  assert.equal(store.list({ includeDeleted: true }).length, 2);
});

test('identity is the Message-ID, so a renumbered mailbox is not a new mailbox', async () => {
  /* IMAP UIDs are per-folder and the whole space is invalidated when
     UIDVALIDITY changes. Keyed by UID, one renumbering would duplicate every
     message in the mirror. */
  await freshStore();

  store.put(msg(5));
  store.put(msg(5, { uid: 12345, subject: '主旨 5' }));

  assert.equal(store.list({}).length, 1, '同一封信被存成了兩筆');
  assert.equal(store.get('<m5@example.com>').uid, 12345, '應該更新成新的 UID');
});

test('local read state wins over what the server last said', async () => {
  /* A sync that runs before the flag has been pushed must not turn a message
     the user read back into an unread one. */
  await freshStore();

  store.put(msg(1, { seen: false }));
  store.setLocal('<m1@example.com>', { seen: true });
  assert.equal(store.get('<m1@example.com>').seen, true);

  store.put(msg(1, { seen: false }));
  assert.equal(store.get('<m1@example.com>').seen, true,
    '同步之後，使用者讀過的信變回未讀了');
});

test('the mirror survives a restart', async () => {
  const dir = await freshStore();

  store.put(msg(1));
  store.put(msg(2));
  store.setLocal('<m2@example.com>', { starred: true, deleted: false });
  await store.putBody('<m1@example.com>', '信件內文。');
  store.setCursor('INBOX', { uidValidity: 42, highestUid: 2 });
  await store.flush();

  // A new process, same directory.
  await sandbox.init(dir);
  await store.init(ACCOUNT);

  assert.equal(store.list({}).length, 2, '重開之後信不見了');
  assert.equal(store.get('<m2@example.com>').starred, true, '星標沒有留下來');
  assert.equal(await store.body('<m1@example.com>'), '信件內文。', '內文沒有留下來');
  assert.deepEqual(
    { uidValidity: store.cursor('INBOX').uidValidity, highestUid: store.cursor('INBOX').highestUid },
    { uidValidity: 42, highestUid: 2 },
    '同步游標沒有留下來，下次會重抓整個資料夾');
});

test('the list is what the application shows: sorted, filtered, capped', async () => {
  await freshStore();
  for (let i = 1; i <= 5; i++) store.put(msg(i));
  store.put(msg(9, { folder: 'Archive', subject: '封存的信' }));

  const inbox = store.list({ folder: 'INBOX' });
  assert.equal(inbox.length, 5, '資料夾篩選不對');
  assert.deepEqual(inbox.map((m) => m.subject),
    ['主旨 5', '主旨 4', '主旨 3', '主旨 2', '主旨 1'],
    '應該是新的在前面');

  assert.equal(store.list({ search: '封存' }).length, 1, '搜尋失效');
  assert.equal(store.list({ search: '寄件人3' }).length, 1, '搜尋應該也涵蓋寄件人');
  assert.equal(store.list({ limit: 2 }).length, 2, '上限沒有生效');
});

test('a message with no Message-ID still gets a stable key', async () => {
  /* Rare and not fatal. What matters is that it can be stored and deleted; it
     re-imports as a new message if the server renumbers, which is the honest
     outcome when the only identity available is positional. */
  await freshStore();
  const id = '<no-id.INBOX.7@aios.local>';
  store.put({ messageId: id, uid: 7, folder: 'INBOX', subject: '沒有 Message-ID' });
  assert.equal(store.list({}).length, 1);
  store.setLocal(id, { deleted: true });
  assert.equal(store.list({}).length, 0, '沒有 Message-ID 的信也要能刪');
});

test('unknown() is what keeps a sync from refetching everything', async () => {
  await freshStore();
  store.put(msg(1));
  store.put(msg(2));
  const asked = ['<m1@example.com>', '<m2@example.com>', '<m3@example.com>'];
  assert.deepEqual(store.unknown(asked), ['<m3@example.com>'],
    '已經有的信不該被當成新的再抓一次');
});

/* ------------------------------------------------- search, attachments, links */

test('search finds a message by what it says, not only by what it is called', async () => {
  /* 「哪封信提到我」 is a question about the body. Subject and sender are in
     the index; the text is on disk, and this is what reads it. */
  await freshStore();
  store.put(msg(1, { subject: '九月報價', from: '王小明 <ming@abc.com>' }));
  store.put(msg(2, { subject: '無關', from: 'x@other.com' }));
  await store.putBody('<m1@example.com>', '各位好，這一份要請 Cary 確認。');
  await store.putBody('<m2@example.com>', '完全沒有提到那個人。');

  const r = await store.search({ text: 'Cary' });
  assert.deepEqual(r.hits.map((h) => h.messageId), ['<m1@example.com>']);
  assert.equal(r.hits[0].where, 'body');
  assert.ok(r.hits[0].snippet.includes('Cary'), r.hits[0].snippet);

  const bySubject = await store.search({ text: '報價' });
  assert.equal(bySubject.hits[0].where, 'subject', 'a subject hit says so, and carries no snippet');
  assert.equal(bySubject.hits[0].snippet, '');
});

test('a sender given as a domain matches the company, not a look-alike', async () => {
  /* 'abc.com' as a plain substring would also match notabc.com. The domain rule
     is the one people mean by 「ABC 公司寄來的」. */
  await freshStore();
  store.put(msg(1, { from: '王小明 <ming@abc.com>' }));
  store.put(msg(2, { from: 'ops@mail.abc.com' }));
  store.put(msg(3, { from: 'someone@notabc.com' }));
  store.put(msg(4, { from: 'abc.com fan <fan@else.org>' }));

  const r = await store.search({ from: 'abc.com' });
  assert.deepEqual(r.hits.map((h) => h.messageId).sort(), ['<m1@example.com>', '<m2@example.com>']);
  assert.equal((await store.search({ from: 'ming@abc.com' })).hits.length, 1, 'a full address is exact');
  assert.equal((await store.search({ from: '王小明' })).hits.length, 1, 'a name matches the display name');
});

test('a date window is inclusive of the days it names', async () => {
  await freshStore();
  const day = 86400 * 1000;
  const now = 1700000000000;
  store.put(msg(1, { date: now - 2 * day }));
  store.put(msg(2, { date: now - 10 * day }));
  const r = await store.search({ since: now - 7 * day, until: now });
  assert.deepEqual(r.hits.map((h) => h.messageId), ['<m1@example.com>']);
});

test('attachments are kept whole, capped, and come back by index', async () => {
  await freshStore();
  store.put(msg(1));
  const kept = await store.putAttachments('<m1@example.com>', [
    { name: '報價單.xlsx', type: 'application/vnd.ms-excel', data: Buffer.from('PK fake') },
    { name: 'huge.bin', type: 'application/octet-stream', bytes: store.MAX_ONE_ATTACHMENT + 1 }
  ]);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].stored, true);
  assert.equal(kept[1].stored, false, 'oversized is recorded, not stored');
  assert.ok(kept[1].reason.includes('MiB'), kept[1].reason);

  const a = await store.attachment('<m1@example.com>', 0);
  assert.equal(a.data.toString(), 'PK fake');
  assert.equal(a.name, '報價單.xlsx');
  const b = await store.attachment('<m1@example.com>', 1);
  assert.equal(b.data, null, 'the bytes were never kept');
  assert.equal(store.get('<m1@example.com>').hasAttachments, true);
  assert.equal((await store.search({ hasAttachment: true })).hits.length, 1);
});

test('a web link and a source id survive a re-sync that does not carry them', async () => {
  /* IMAP knows nothing of either. A feeder that does sets them once; a later
     put() from a feeder that does not must not wipe them. */
  await freshStore();
  store.put(msg(1, { webLink: 'https://outlook.office.com/mail/x', sourceId: 'AAMk...' }));
  store.put(msg(1));
  assert.equal(store.get('<m1@example.com>').webLink, 'https://outlook.office.com/mail/x');
  assert.equal(store.get('<m1@example.com>').sourceId, 'AAMk...');
});

test('search can fetch one known message, deleted or not', async () => {
  await freshStore();
  store.put(msg(1));
  store.setLocal('<m1@example.com>', { deleted: true });
  const r = await store.search({ messageId: '<m1@example.com>', includeDeleted: true });
  assert.equal(r.hits.length, 1);
  assert.equal((await store.search({ messageId: '<m1@example.com>' })).hits.length, 0,
    'and without includeDeleted a deleted message stays gone');
});

test('the MIME reader keeps an attachment’s bytes and decodes its encoded name', () => {
  /* Before this the reader recorded a name and a size and threw the bytes
     away, which left a mail client that could only say 「有一個 3 MB 的檔案」. */
  const mail = require('../app/main/mail');
  const payload = Buffer.from('PK not really a zip', 'binary').toString('base64');
  const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
  const src = [
    'From: a@b.c', 'Subject: x', 'Content-Type: multipart/mixed; boundary="B"', '', '--B',
    'Content-Type: text/plain; charset=utf-8', '', '內文在這裡', '--B',
    'Content-Type: application/vnd.ms-excel; name="=?utf-8?B?5aCx5YO55Zau?=.xlsx"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="=?utf-8?B?5aCx5YO55Zau?=.xlsx"', '',
    payload, '--B--', ''
  ].join(CRLF);
  const out = mail.parseSource(src);
  assert.equal(out.text, '內文在這裡');
  assert.equal(out.attachments.length, 1);
  assert.equal(out.attachments[0].name, '報價單.xlsx', 'the RFC 2047 name is decoded');
  assert.ok(Buffer.isBuffer(out.attachments[0].data), 'the bytes are there');
  assert.equal(out.attachments[0].data.toString('binary').startsWith('PK'), true);
  assert.equal(out.attachments[0].bytes, out.attachments[0].data.length);
});

test('a boundary with capitals in it still splits the message, and a filename keeps its case', () => {
  /* Found while writing the attachment test: the reader lower-cased the whole
     Content-Type before taking the boundary out of it, so "----=_NextPart_ABC"
     never matched "--" + "----=_nextpart_abc" in the body. Nearly every real
     boundary has capitals, so nearly every multipart message came back as one
     lump of base64 noise with no attachments. Filenames were lower-cased the
     same way, and an RFC 2047 name stops decoding once its base64 is. */
  const mail = require('../app/main/mail');
  const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
  const src = [
    'Content-Type: multipart/mixed; boundary="----=_NextPart_000_ABC"', '',
    '------=_NextPart_000_ABC',
    'Content-Type: text/plain; charset=utf-8', '', 'hello', '',
    '------=_NextPart_000_ABC',
    'Content-Type: application/pdf; name="Report.PDF"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="Report.PDF"', '',
    Buffer.from('%PDF-1.7').toString('base64'),
    '------=_NextPart_000_ABC--', ''
  ].join(CRLF);
  const out = mail.parseSource(src);
  assert.equal(out.text, 'hello');
  assert.equal(out.attachments.length, 1);
  assert.equal(out.attachments[0].name, 'Report.PDF');
  assert.equal(out.attachments[0].data.toString(), '%PDF-1.7');
});
