'use strict';

/* ===========================================================================
   Sandbox containment tests
   ---------------------------------------------------------------------------
   The sandbox is the only thing standing between a nondeterministic planner and
   the user's real filesystem, so its failure modes are worth asserting rather
   than assuming. Run with:  npm test

   These exercise the module directly, with no Electron and no model: the point
   is the boundary, not the UI.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsc = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sandbox = require('../app/main/sandbox');

const ROOT = path.join(os.tmpdir(), 'aios-test-' + Date.now().toString(36));
const OUTSIDE = path.join(os.tmpdir(), 'aios-outside-' + Date.now().toString(36));

test.before(async () => {
  await fs.mkdir(OUTSIDE, { recursive: true });
  await fs.writeFile(path.join(OUTSIDE, 'secret.txt'), 'TOP SECRET, must never be reachable', 'utf8');
  await sandbox.init(ROOT);
});

test.after(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.rm(OUTSIDE, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- mounting */

test('init seeds the machine and reports its root', async () => {
  assert.equal(sandbox.root(), await fs.realpath(ROOT));
  const t = await sandbox.tree();
  const paths = t.files.map((f) => f.vpath);
  assert.ok(paths.includes('/notes/readme.txt'), 'notes/readme.txt should be seeded');
  assert.ok(paths.includes('/inbox/urgent-invoice.txt'), 'the hostile sample should be seeded');
});

test('inbox contents are untrusted, notes are not', async () => {
  assert.equal(sandbox.isUntrusted('/inbox/urgent-invoice.txt'), true);
  assert.equal(sandbox.isUntrusted('/notes/readme.txt'), false);
});

/* ------------------------------------------------------------- containment */

test('writing into a directory that does not exist yet creates it', async () => {
  /* `write` has always ended with a recursive mkdir, but `verify` ran first and
     only ever tried the immediate parent -- so a path two levels deep failed on
     a second ENOENT before the mkdir could help. Found by a batch asked to write
     a hundred files into a new folder: every one of them failed with
     「ENOENT: realpath …\notes\報名」. */
  const out = await sandbox.write('/notes/深/更深/檔案.txt', '內容');
  assert.equal(out.vpath, '/notes/深/更深/檔案.txt');
  assert.equal((await sandbox.read('/notes/深/更深/檔案.txt')).content, '內容');

  const listed = await sandbox.list('/notes/深');
  assert.deepEqual(listed.entries.map((e) => e.name), ['更深']);
});

test('a new deep path is still checked for containment', async () => {
  /* The nearest existing ancestor is what gets verified, so the check has to
     survive not being able to resolve the leaf. */
  await assert.rejects(
    () => sandbox.write('/notes/新的/../../../外面.txt', 'x'),
    (e) => e.code === 'EESCAPE' || e.code === 'ERESERVED' || /\.\./.test(e.message),
    '往上跳出沙箱的新路徑仍然要被擋下');
});

test('rejects every shape of path escape', async () => {
  const attacks = [
    ['../escape.txt', 'parent traversal'],
    ['notes/../../escape.txt', 'traversal after a valid segment'],
    ['..\\escape.txt', 'windows separator traversal'],
    ['notes/..\\..\\escape.txt', 'mixed separators'],
    ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'absolute windows path'],
    ['c:/windows/win.ini', 'lowercase drive letter'],
    ['\\\\server\\share\\file.txt', 'UNC path'],
    ['//server/share/file.txt', 'UNC with forward slashes'],
    ['\\\\?\\C:\\Windows\\win.ini', 'device namespace prefix'],
    ['notes/CON', 'reserved device name'],
    ['notes/nul.txt', 'reserved device name with extension'],
    ['notes/COM1', 'reserved serial device'],
    ['notes/secret.txt:hidden', 'alternate data stream'],
    ['notes/trailing.', 'trailing dot aliases another name'],
    // Windows strips trailing dots and spaces when opening a file, so a segment
    // carrying one is an alias for a different name and must not be accepted.
    ['notes/trailing /a.txt', 'trailing space inside a segment'],
    ['notes/trailing./a.txt', 'trailing dot inside a segment'],
    ['notes/bad<name>.txt', 'illegal characters'],
    ['.aios/origins.json', 'kernel metadata directory'],
    ['.trash/anything', 'trash is reserved'],
    ['a/b/c/d/e/f/g/h/i/j/k/l/m/n.txt', 'excessive depth']
  ];

  for (const [attack, why] of attacks) {
    assert.throws(
      () => sandbox.resolve(attack),
      (e) => e && e.sandbox === true,
      `should reject ${why}: ${attack}`
    );
  }
});

test('accepts ordinary paths and normalises separators', () => {
  assert.equal(sandbox.resolve('/notes/a.txt').vpath, '/notes/a.txt');
  assert.equal(sandbox.resolve('notes/a.txt').vpath, '/notes/a.txt');
  assert.equal(sandbox.resolve('notes\\a.txt').vpath, '/notes/a.txt');
  assert.equal(sandbox.resolve('./notes/./a.txt').vpath, '/notes/a.txt');
  assert.equal(sandbox.resolve('/').vpath, '/');
  // Surrounding whitespace is normalised away rather than rejected: the model
  // emits it often, and the trimmed result is the file the user meant.
  assert.equal(sandbox.resolve('  /notes/a.txt  ').vpath, '/notes/a.txt');
});

test('a write cannot land outside the root', async () => {
  await assert.rejects(() => sandbox.write('../pwned.txt', 'x'), (e) => e.code === 'EESCAPE');
  assert.equal(fsc.existsSync(path.join(path.dirname(ROOT), 'pwned.txt')), false);
});

test('a junction planted inside the sandbox does not become an exit', async (t) => {
  // Requires the ability to create a directory symlink, which on Windows needs
  // either developer mode or elevation. Skip rather than fail if unavailable.
  const linkPath = path.join(ROOT, 'escape-link');
  try {
    await fs.symlink(OUTSIDE, linkPath, 'junction');
  } catch (e) {
    t.skip('cannot create a junction here: ' + e.code);
    return;
  }

  await assert.rejects(
    () => sandbox.read('/escape-link/secret.txt'),
    (e) => e.code === 'EESCAPE' || e.code === 'ELINK' || e.code === 'ENOENT',
    'reading through a junction must not reach outside'
  );

  // And it must not appear as a normal directory to the planner.
  const listing = await sandbox.list('/');
  const names = listing.entries.map((e) => e.name);
  assert.ok(!names.includes('escape-link'), 'symlinks are not listed');

  await fs.rm(linkPath, { recursive: true, force: true });
});

/* -------------------------------------------------------------- operations */

test('write, read, copy and move round-trip', async () => {
  const w = await sandbox.write('/notes/round.txt', 'hello sandbox');
  assert.equal(w.created, true);
  assert.equal(w.bytes, Buffer.byteLength('hello sandbox'));

  const r = await sandbox.read('/notes/round.txt');
  assert.equal(r.content, 'hello sandbox');
  assert.equal(r.untrusted, false);

  await sandbox.copy('/notes/round.txt', '/notes/round-copy.txt');
  assert.equal((await sandbox.read('/notes/round-copy.txt')).content, 'hello sandbox');

  await sandbox.move('/notes/round-copy.txt', '/notes/moved.txt');
  assert.equal((await sandbox.read('/notes/moved.txt')).content, 'hello sandbox');
  await assert.rejects(() => sandbox.read('/notes/round-copy.txt'), (e) => e.code === 'ENOENT');
});

test('copying untrusted content keeps it untrusted', async () => {
  await sandbox.copy('/inbox/urgent-invoice.txt', '/notes/laundered.txt');
  assert.equal(
    sandbox.isUntrusted('/notes/laundered.txt'), true,
    'moving a hostile file to notes/ must not launder it into trusted content'
  );
});

test('delete moves to the trash and restore puts it back', async () => {
  await sandbox.write('/notes/doomed.txt', 'delete me');
  const t = await sandbox.trash('/notes/doomed.txt');
  assert.ok(t.id);
  await assert.rejects(() => sandbox.read('/notes/doomed.txt'), (e) => e.code === 'ENOENT');

  const listed = await sandbox.trashList();
  assert.ok(listed.some((x) => x.id === t.id));

  await sandbox.restore(t.id);
  assert.equal((await sandbox.read('/notes/doomed.txt')).content, 'delete me');
});

test('restore refuses to clobber a file that came back', async () => {
  await sandbox.write('/notes/dup.txt', 'first');
  const t = await sandbox.trash('/notes/dup.txt');
  await sandbox.write('/notes/dup.txt', 'second');
  await assert.rejects(() => sandbox.restore(t.id), (e) => e.code === 'EEXIST');
});

test('trash is hidden from the planner but counts against the quota', async () => {
  const tree = await sandbox.tree();
  assert.ok(
    !tree.files.some((f) => f.vpath.startsWith('/.trash/')),
    'trashed paths are not addressable, so they must not be offered'
  );
  const usage = await sandbox.usage();
  assert.ok(usage.bytes > 0);
});

test('restore rejects a forged trash id', async () => {
  await assert.rejects(() => sandbox.restore('../../etc'), (e) => e.code === 'EINVAL');
  await assert.rejects(() => sandbox.restore('a/b'), (e) => e.code === 'EINVAL');
});

/* ------------------------------------------------------------------ quota */

test('a single file over the per-file cap is refused', async () => {
  const big = 'x'.repeat(1024);
  const original = sandbox.QUOTA.fileBytes;
  sandbox.QUOTA.fileBytes = 512;
  try {
    await assert.rejects(() => sandbox.write('/notes/big.txt', big), (e) => e.code === 'EFBIG');
  } finally {
    sandbox.QUOTA.fileBytes = original;
  }
});

test('the total cap is enforced', async () => {
  const original = sandbox.QUOTA.totalBytes;
  sandbox.QUOTA.totalBytes = 64;
  try {
    await assert.rejects(
      () => sandbox.write('/notes/overflow.txt', 'y'.repeat(4096)),
      (e) => e.code === 'EDQUOT' || e.code === 'EFBIG'
    );
  } finally {
    sandbox.QUOTA.totalBytes = original;
  }
});

/* ----------------------------------------------------------------- import */

test('import copies from outside without touching the original', async () => {
  const src = path.join(OUTSIDE, 'secret.txt');
  const before = await fs.readFile(src, 'utf8');

  const res = await sandbox.importFiles([src], '/inbox');
  assert.equal(res.imported.length, 1);
  const vpath = res.imported[0].vpath;

  assert.equal((await sandbox.read(vpath)).content, before, 'contents must match');
  assert.equal(await fs.readFile(src, 'utf8'), before, 'source must be unmodified');
  assert.equal(fsc.existsSync(src), true, 'source must still exist: import copies, never moves');
  assert.equal(sandbox.isUntrusted(vpath), true, 'imported files arrive untrusted');
});

test('import never clobbers and sanitises hostile names', async () => {
  const nasty = path.join(OUTSIDE, 'weird.txt');
  await fs.writeFile(nasty, 'one', 'utf8');
  const a = await sandbox.importFiles([nasty], '/inbox');
  const b = await sandbox.importFiles([nasty], '/inbox');
  assert.notEqual(a.imported[0].vpath, b.imported[0].vpath, 'second import gets a new name');
  assert.equal((await sandbox.read(a.imported[0].vpath)).content, 'one');
});

test('import reports rather than throws on a missing source', async () => {
  const res = await sandbox.importFiles([path.join(OUTSIDE, 'does-not-exist.txt')], '/inbox');
  assert.equal(res.imported.length, 0);
  assert.equal(res.skipped.length, 1);
});

/* ------------------------------------------------------------------ search */

test('find matches names and contents, and says what it read', async () => {
  await sandbox.write('/notes/會議/一月.txt', '第一季目標是把交付可靠度做上去\n負責人：林昱翔');
  await sandbox.write('/notes/會議/二月.txt', '沒有相關內容');
  await sandbox.write('/notes/交付可靠度.md', '# 標題只在檔名');

  const byContent = await sandbox.find('交付可靠度');
  const paths = byContent.hits.map((h) => h.vpath).sort();
  assert.deepEqual(paths, ['/notes/交付可靠度.md', '/notes/會議/一月.txt']);

  /* The line is the point. A list of paths makes the caller open each file to
     find out which was the right one; a matching line usually settles it. */
  const inFile = byContent.hits.find((h) => h.vpath === '/notes/會議/一月.txt');
  assert.equal(inFile.where, 'content');
  assert.equal(inFile.lines[0].line, 1);
  assert.match(inFile.lines[0].text, /交付可靠度/);

  const byName = byContent.hits.find((h) => h.vpath === '/notes/交付可靠度.md');
  assert.equal(byName.where, 'name', '檔名命中就不必再讀內容');
  assert.deepEqual(byName.lines, []);
});

test('find can be scoped to a directory, and skips binary files', async () => {
  await sandbox.write('/notes/找得到.txt', '關鍵字');
  await sandbox.write('/inbox/也找得到.txt', '關鍵字');
  await sandbox.writeBytes('/notes/二進位.bin',
    Buffer.from([0, 1, 2, 0xe9, 0xa1, 0x9e, 0]).toString('base64'));

  const scoped = await sandbox.find('關鍵字', { dir: '/notes' });
  assert.deepEqual(scoped.hits.map((h) => h.vpath), ['/notes/找得到.txt']);
  assert.equal(scoped.dir, '/notes');

  const all = await sandbox.find('關鍵字');
  assert.equal(all.hits.length, 2);

  /* A NUL byte means bytes, not text. Searching a .docx for a word finds
     nothing useful and costs a megabyte of scanning -- the words are inside a
     zip, and opening it is what the document applications are for. */
  const bin = await sandbox.find('\u985e');
  assert.ok(!bin.hits.some((h) => h.vpath === '/notes/二進位.bin'),
    '二進位檔不該被當文字搜');
});

test('an empty query is refused rather than matching everything', async () => {
  await assert.rejects(() => sandbox.find(''), /沒有給搜尋字串/);
  await assert.rejects(() => sandbox.find('   '), /沒有給搜尋字串/);
});

test('find reports when it stopped early instead of reporting nothing found', async () => {
  /* A search is a read of the whole sandbox, and the quota allows five thousand
     files. Without a ceiling one question could read half a gigabyte. With a
     silent ceiling it answers 「找不到」 about a file that is sitting there. */
  const big = 'x'.repeat(600 * 1024);
  await sandbox.write('/notes/太大.txt', big + '針');
  const r = await sandbox.find('針');
  assert.equal(r.skippedBig, 1, '太大的檔案要算進去並回報');
  assert.equal(r.hits.length, 0);
  assert.equal(typeof r.truncated, 'boolean');
});
