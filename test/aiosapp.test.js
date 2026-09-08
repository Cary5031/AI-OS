'use strict';

/* ===========================================================================
   Sharing, importing and re-approving generated programs, exercised for real.

   Not a source-shape test: this runs the forge against a temporary sandbox
   and a temporary index, exports a program, reads the file back, imports it
   and looks at what got installed; and approves code edited on disk to see
   what the grant becomes. The claims worth checking are the ones
   a package from a stranger would otherwise have to prove -- above all that
   the file carries no permission of its own, and that the hash which grants
   execution is computed here from the bytes actually written.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const sandbox = require('../app/main/sandbox');
const forge = require('../app/main/forge');

const CODE = [
  'function render(root, os) {',
  '  root.textContent = "hi";',
  '  os.actions.selfTest = async function () { return "自我測試通過：1 項"; };',
  '}',
  ''
].join('\n');

/** A fresh machine: empty sandbox, empty index. */
async function machine() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-aiosapp-'));
  await sandbox.init(path.join(dir, 'sandbox'));
  await fs.mkdir(path.join(dir, 'userData'), { recursive: true });
  await forge.init(path.join(dir, 'userData'));
  return dir;
}

async function installTodo(over = {}) {
  return forge.install({
    slug: 'todo', name: '待辦', purpose: '記事', icon: '☑', code: CODE,
    capabilities: ['storage', 'ai'], prompt: '一個待辦清單', note: '第一版', author: 'model', ...over
  });
}

async function readJson(vpath) {
  return JSON.parse((await sandbox.read(vpath)).content);
}

test('a program leaves as one file holding what the sandbox holds, and nothing that grants execution', async () => {
  await machine();
  const inst = await installTodo();

  const out = await forge.exportApp('todo', { appVersion: '9.9.9' });
  assert.equal(out.vpath, '/outbox/todo-v1.aiosapp', 'named by slug and version, in /outbox');
  assert.equal(out.history, 1);

  const pkg = await readJson(out.vpath);
  assert.equal(pkg.format, 'aiosapp');
  assert.equal(pkg.formatVersion, 1);
  assert.equal(pkg.exportedBy, 'AI-OS 9.9.9');
  assert.deepEqual(
    { id: pkg.app.id, name: pkg.app.name, purpose: pkg.app.purpose, icon: pkg.app.icon, version: pkg.app.version, capabilities: pkg.app.capabilities },
    { id: 'todo', name: '待辦', purpose: '記事', icon: '☑', version: 1, capabilities: ['storage', 'ai'] });
  assert.equal(pkg.code, CODE);
  assert.equal(pkg.codeHash, forge.hash(CODE), 'its own hash, for transport integrity');
  assert.equal(pkg.codeHash, inst.hash);
  assert.deepEqual(pkg.libs, []);
  assert.equal(pkg.history.length, 1);
  assert.equal(pkg.history[0].prompt, '一個待辦清單');
  assert.equal(pkg.history[0].code, undefined, 'the trail travels without its code bodies');
  assert.match(pkg.readme, /^# 待辦/);

  /* The index entry is the grant, and it stays home. */
  assert.equal(pkg.hash, undefined);
  assert.equal(pkg.approvedAt, undefined);
  assert.equal(pkg.app.hash, undefined);
  assert.equal(pkg.app.approvedAt, undefined);
  assert.equal(JSON.stringify(pkg).includes('approvedAt'), false);
});

test('only approved code leaves: an app.js edited after approval is refused', async () => {
  await machine();
  await installTodo();
  await sandbox.write('/apps/todo/app.js', CODE + '// edited\n', { origin: 'local' });
  await assert.rejects(() => forge.exportApp('todo'), /已被改動/);
  await assert.rejects(() => forge.exportApp('nope'), /沒有安裝/);
});

test('a package is checked, not trusted', async () => {
  await machine();
  await installTodo();
  const { vpath } = await forge.exportApp('todo');
  const good = await readJson(vpath);

  const put = async (name, obj) => {
    const p = '/inbox/' + name;
    await sandbox.write(p, typeof obj === 'string' ? obj : JSON.stringify(obj), { origin: 'local' });
    return p;
  };
  const refuses = async (name, obj, re, why) => {
    const p = await put(name, obj);
    await assert.rejects(() => forge.importPreview(p), re, why);
  };

  await refuses('a.aiosapp', 'not json', /不是 JSON/);
  await refuses('b.aiosapp', { hello: 1 }, /不是 AI-OS 的程式包/);
  await refuses('c.aiosapp', { ...good, formatVersion: 2 }, /格式版本/);
  await refuses('d.aiosapp', { ...good, code: good.code + '// tampered\n' },
    /雜湊不符/, 'code changed under a hash that still claims the original');
  await refuses('e.aiosapp', { ...good, code: 'function (', codeHash: forge.hash('function (') }, /無法解析/);
  await refuses('f.aiosapp', { ...good, code: '', codeHash: '' }, /沒有程式碼/);
  await refuses('g.aiosapp', { ...good, app: { ...good.app, name: '' } }, /沒有名稱/);
  await refuses('h.txt', good, /不是 \.aiosapp 檔/);

  const big = 'x'.repeat(301 * 1024);
  await refuses('i.aiosapp', { ...good, code: big, codeHash: forge.hash(big) }, /超過上限/);

  /* Libraries are checked the way fetchLib checks a download. */
  const lib = (over) => ({ name: 'tiny', version: '1.0.0', global: 'Tiny', source: 'window.Tiny = 1;', hash: forge.hash('window.Tiny = 1;'), ...over });
  await refuses('j.aiosapp', { ...good, libs: [lib({ hash: 'nope' })] }, /雜湊不符/);
  await refuses('k.aiosapp', { ...good, libs: [lib({ source: '<html>', hash: forge.hash('<html>') })] }, /HTML/);
  await refuses('l.aiosapp', { ...good, libs: [lib({ name: 'Not Valid' })] }, /套件名稱不合法/);
  await refuses('m.aiosapp', { ...good, libs: [lib({ global: '1bad' })] }, /全域名稱不合法/);

  /* A capability the machine does not have is dropped, not granted. */
  const p = await put('n.aiosapp', { ...good, app: { ...good.app, id: '../Evil Name!', capabilities: ['storage', 'root', 'net'] } });
  const pv = await forge.importPreview(p);
  assert.deepEqual(pv.capabilities, ['storage', 'net']);
  assert.deepEqual(pv.capsReachingOut, ['net']);
  assert.equal(pv.slug, 'evil-name', "the sender's id goes through the slug rule like a typed name");
  assert.equal(pv.code, good.code, 'the renderer gets the code for its checks');
  assert.equal(pv.existing, null);
  forge.dropImport(pv.token);
});

test('import installs under a hash computed here, and the token is spent', async () => {
  await machine();
  await installTodo();
  const { vpath } = await forge.exportApp('todo');
  await forge.remove('todo');
  assert.equal(forge.installedMeta('todo'), null);

  const pv = await forge.importPreview(vpath);
  assert.equal(pv.name, '待辦');
  assert.equal(pv.version, 1);
  assert.equal(pv.history, 1);
  assert.equal(pv.existing, null);
  assert.equal(pv.besideSlug, null);
  assert.ok(pv.token && pv.token.length === 32);

  const done = await forge.importInstall(pv.token, 'new');
  assert.equal(done.slug, 'todo');
  assert.equal(done.version, 1);
  assert.equal(done.replaced, false);
  assert.deepEqual(done.capabilities, ['storage', 'ai']);

  const meta = forge.installedMeta('todo');
  assert.equal(meta.hash, forge.hash(CODE), 'the grant is the hash of what was written, computed here');
  const loaded = await forge.load('todo');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.code, CODE);

  const hist = await forge.listHistory('todo');
  assert.equal(hist.length, 1);
  assert.match(hist[0].prompt, /匯入自 todo-v1\.aiosapp/);
  assert.equal(hist[0].author, 'user');
  const imported = await readJson('/apps/todo/imported-history.json');
  assert.equal(imported.history.length, 1, "the sender's trail is kept beside ours, not merged");
  assert.equal(imported.history[0].prompt, '一個待辦清單');

  await assert.rejects(() => forge.importInstall(pv.token, 'new'), /過期或不存在/, 'a token installs once');
  assert.equal(forge.dropImport('nope'), false);
});

test('a name already installed is a question: replace continues the line, beside gets a new slug', async () => {
  await machine();
  await installTodo();
  const { vpath } = await forge.exportApp('todo');

  let pv = await forge.importPreview(vpath);
  assert.deepEqual(pv.existing, { name: '待辦', version: 1 });
  assert.equal(pv.besideSlug, 'todo-2');
  await assert.rejects(() => forge.importInstall(pv.token, 'new'), /要取代還是另外裝/, 'no default');

  pv = await forge.importPreview(vpath);
  const beside = await forge.importInstall(pv.token, 'beside');
  assert.equal(beside.slug, 'todo-2');
  assert.equal(beside.version, 1);
  assert.equal(beside.replaced, false);
  assert.ok(forge.installedMeta('todo-2'));
  assert.equal(forge.installedMeta('todo').version, 1, 'the original is untouched');

  pv = await forge.importPreview(vpath);
  assert.equal(pv.besideSlug, 'todo-3');
  const replaced = await forge.importInstall(pv.token, 'replace');
  assert.equal(replaced.slug, 'todo');
  assert.equal(replaced.version, 2);
  assert.equal(replaced.replaced, true);
  const hist = await forge.listHistory('todo');
  assert.deepEqual(hist.map((h) => h.version), [1, 2], 'history kept, the import is v2');

  assert.equal(forge.freeSlug('todo'), 'todo-3');
  assert.equal(forge.freeSlug('fresh'), 'fresh');
});

test('libraries travel with their source and are pinned like fetched ones', async () => {
  await machine();
  await installTodo();
  const { vpath } = await forge.exportApp('todo');
  const good = await readJson(vpath);
  const src = 'window.Tiny = { v: 1 };';
  const lib = { name: 'tiny', version: '1.0.0', global: 'Tiny', source: src, hash: forge.hash(src) };
  await sandbox.write('/inbox/withlib.aiosapp', JSON.stringify({ ...good, app: { ...good.app, id: 'withlib' }, libs: [lib] }), { origin: 'local' });

  const pv = await forge.importPreview('/inbox/withlib.aiosapp');
  assert.deepEqual(pv.libs, [{ name: 'tiny', version: '1.0.0', global: 'Tiny', bytes: src.length, pinned: false }]);
  assert.deepEqual(pv.libSources, [{ global: 'Tiny', name: 'tiny', version: '1.0.0', source: src }]);
  await forge.importInstall(pv.token, 'new');

  const rec = await forge.libSource('tiny@1.0.0');
  assert.equal(rec.source, src, 'pinned under /apps/_libs and readable back');
  assert.equal(rec.vpath, '/apps/_libs/tiny@1.0.0.js');
  const loaded = await forge.load('withlib');
  assert.deepEqual(loaded.libs.map((l) => [l.key, l.global]), [['tiny@1.0.0', 'Tiny']], 'the manifest carries it');

  /* The same name and version with a different body: refused, because other
     programs here already load the pinned one. */
  const other = 'window.Tiny = { v: 2 };';
  await sandbox.write('/inbox/swap.aiosapp', JSON.stringify({ ...good, app: { ...good.app, id: 'swap' },
    libs: [{ ...lib, source: other, hash: forge.hash(other) }] }), { origin: 'local' });
  await assert.rejects(() => forge.importPreview('/inbox/swap.aiosapp'), /已釘住的版本內容不同/);

  /* The same bytes again: already pinned, nothing rewritten. */
  await sandbox.write('/inbox/again.aiosapp', JSON.stringify({ ...good, app: { ...good.app, id: 'again' }, libs: [lib] }), { origin: 'local' });
  const pv2 = await forge.importPreview('/inbox/again.aiosapp');
  assert.equal(pv2.libs[0].pinned, true);
  forge.dropImport(pv2.token);
});

test('approving edited code re-reads the manifest: the grant follows the code', async () => {
  /* Seen on a real machine: a program rebuilt on disk under the same slug,
     its manifest now declaring `storage`. The person pressed 核准; the index
     re-hashed app.js and kept its old empty capability list, and the program
     was refused storage.get on its first call. */
  await machine();
  await installTodo({ capabilities: [] });
  assert.deepEqual(forge.installedMeta('todo').capabilities, []);

  const newCode = CODE + '// rebuilt elsewhere\n';
  await sandbox.write('/apps/todo/app.js', newCode, { origin: 'local' });
  await sandbox.write('/apps/todo/manifest.json', JSON.stringify({
    id: 'todo', name: '待辦 2', purpose: '記事，會記住設定', icon: '✓', version: 3,
    capabilities: ['storage', 'root', 'net']
  }), { origin: 'local' });

  const refused = await forge.load('todo');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'EINTEGRITY');
  assert.deepEqual(refused.capabilities, [], 'what is granted now');
  assert.deepEqual(refused.pendingCapabilities, ['storage', 'net'], 'what the manifest claims, sanitised');

  const ok = await forge.approveCurrent('todo');
  assert.deepEqual(ok.before, []);
  assert.deepEqual(ok.capabilities, ['storage', 'net']);
  const meta = forge.installedMeta('todo');
  assert.equal(meta.hash, forge.hash(newCode));
  assert.deepEqual(meta.capabilities, ['storage', 'net'], 'the grant is the manifest beside the approved code');
  assert.equal(meta.name, '待辦 2');
  assert.equal(meta.version, 3);

  const loaded = await forge.load('todo');
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.capabilities, ['storage', 'net']);
  assert.deepEqual(loaded.manifestCaps, ['storage', 'net'], 'and the two agree');
  await assert.doesNotReject(() => forge.assertGrant('todo', 'net.fetch'), 'so the program\'s own calls are served');

  /* A manifest edited without touching the code is not adopted by load():
     the window shows the gap and a button, and only approve changes the grant. */
  await sandbox.write('/apps/todo/manifest.json', JSON.stringify({ id: 'todo', name: '待辦 2', version: 3, capabilities: ['storage', 'net', 'sandbox-read'] }), { origin: 'local' });
  const gap = await forge.load('todo');
  assert.equal(gap.ok, true);
  assert.deepEqual(gap.capabilities, ['storage', 'net'], 'still the approved grant');
  assert.deepEqual(gap.manifestCaps, ['storage', 'net', 'sandbox-read'], 'the claim, shown, not granted');
  await assert.rejects(() => forge.assertGrant('todo', 'sandbox.read'), /沒有「sandbox-read」/);
});

test('the round trip is lossless for a program with everything', async () => {
  await machine();
  await installTodo({ capabilities: ['storage', 'appdata', 'ai', 'clipboard', 'sandbox-read', 'sandbox-write', 'page', 'net', 'apps'] });
  await forge.install({ slug: 'todo', code: CODE + '// v2\n', prompt: '改一下', note: '第二版', author: 'model' });
  const { vpath, history } = await forge.exportApp('todo');
  assert.equal(history, 2);
  await forge.remove('todo');

  const pv = await forge.importPreview(vpath);
  assert.equal(pv.version, 2);
  assert.equal(pv.capabilities.length, 9);
  const done = await forge.importInstall(pv.token, 'new');
  const loaded = await forge.load(done.slug);
  assert.equal(loaded.code, CODE + '// v2\n');
  assert.equal(loaded.capabilities.length, 9);
  assert.equal(loaded.manifest.name, '待辦');
  assert.equal(loaded.manifest.icon, '☑');
  const imported = await readJson('/apps/todo/imported-history.json');
  assert.deepEqual(imported.history.map((h) => h.note), ['第一版', '第二版']);
});
