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
