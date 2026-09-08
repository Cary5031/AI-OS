'use strict';

/* ===========================================================================
   AI-OS // app forge (storage and integrity)
   ---------------------------------------------------------------------------
   Generated applications live in the sandbox at /apps/<slug>/ so the user can
   read, edit, back up and delete them like any other file. That creates a hole
   worth closing carefully:

     fs.write is a capability the user may well set to ALLOW. If running an app
     only required its code to exist on disk, then anything able to write a file
     could install executable code and have it run -- including a plan written
     by a hostile email.

   So the sandbox holds the app, but the *permission to run it* is recorded
   outside the sandbox, in userData, together with a SHA-256 of the exact code
   that was approved. Changing app.js by any route other than the forge
   invalidates the hash, and the loader refuses to run it until a human approves
   the new contents. Tampering is detected rather than prevented, which is the
   honest guarantee here.

   Every version is kept under history/ with the prompt that produced it, so the
   build trail is inspectable and any version can be restored.
   =========================================================================== */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = require('./sandbox');
const web = require('./web');

const APPS_DIR = '/apps';
const MAX_CODE = 300 * 1024;
const MAX_VERSIONS = 60;

/* Scheme the generated apps are served from. Not cosmetic: see serveFrame. */
const FRAME_SCHEME = 'aios-app';
/* Large enough for a program plus the libraries it asked for (a charting
   library is a few hundred KB minified). Held in memory per live frame only. */
const MAX_FRAME_HTML = 8 * 1024 * 1024;

let indexFile = null;
let index = { version: 1, apps: {} };

/* Whether a build you started yourself stops to ask before installing.
   Off by default.

   Pressing 「建置」 is the authorisation: relaying that request back to the same
   person a few minutes later does not produce a second decision, it produces a
   habit of clicking through. The capability list is already announced in the
   build log at step 1/4, minutes before the install, and again in the app's own
   row afterwards -- so the information is delivered twice without a modal.

   What the dialog did cover is real and narrower than it looked: the button
   authorises the *purpose*, and the model chooses the *capabilities*. A
   calculator that asks for `sandbox-read` is the case worth stopping for. That
   is what this switch is for, and why the grant is stated loudly at install
   either way. The model's own route (`forge:install`) is unaffected -- it
   answers to `app.create` and to the taint downgrade, as before. */
let confirmInstall = false;

/* Whether an installed program that throws at runtime is handed back to the
   model for repair without anyone pressing 「請核心修掉」. On by default: the
   error is already on screen with a button under it, and a machine that can
   rebuild its own programs should not wait to be told to. The generated window
   caps it at two repairs per load so a fault the model cannot fix does not turn
   into a loop that spends money. Off means the button, as before. */
let autoRepair = true;

/* -------------------------------------------------------------------- setup */

async function init(userDataDir) {
  indexFile = path.join(userDataDir, 'apps-index.json');
  try {
    const raw = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    /* libs as well as apps. The first version of this line rebuilt the index
       from apps alone: every pinned library was written to the file and
       forgotten on the next start, so a program built with Chart.js opened as
       「套件 chart.js 讀不到：沒有這個套件」 after a restart -- and only after a
       restart, which is why the build's own checks never saw it. */
    if (raw && raw.apps) index = { version: raw.version || 1, apps: raw.apps, libs: raw.libs || {} };
    if (raw && typeof raw.confirmInstall === 'boolean') confirmInstall = raw.confirmInstall;
    if (raw && typeof raw.autoRepair === 'boolean') autoRepair = raw.autoRepair;
  } catch {
    index = { version: 1, apps: {} };
  }
  await sandbox.mkdir(APPS_DIR).catch(() => {});
  return { apps: Object.keys(index.apps).length, confirmInstall, autoRepair };
}

function installPrefs() {
  return { confirmInstall, autoRepair };
}

async function setConfirmInstall(on) {
  confirmInstall = !!on;
  await saveIndex();
  return installPrefs();
}

async function setAutoRepair(on) {
  autoRepair = !!on;
  await saveIndex();
  return installPrefs();
}

async function saveIndex() {
  const tmp = indexFile + '.tmp';
  // The preferences ride in the same file as the index: one write, and a
  // setting that cannot get out of step with the apps it applies to.
  await fs.writeFile(tmp, JSON.stringify({ ...index, confirmInstall, autoRepair }, null, 2), 'utf8');
  await fs.rename(tmp, indexFile);
}

function hash(code) {
  return crypto.createHash('sha256').update(String(code), 'utf8').digest('hex');
}

/** Slugs become directory names, so they get the strictest possible charset. */
function toSlug(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'app-' + Date.now().toString(36);
}

function assertSlug(slug) {
  if (!/^[a-z0-9\u4e00-\u9fff][a-z0-9\u4e00-\u9fff-]{0,39}$/.test(String(slug || ''))) {
    throw Object.assign(new Error('程式代號不合法：' + slug), { code: 'EINVAL' });
  }
  return slug;
}

/* Capabilities a generated app may request. Anything not listed is unavailable
   to it no matter what its manifest claims. */
const APP_CAPS = ['storage', 'appdata', 'ai', 'clipboard', 'sandbox-read', 'sandbox-write', 'page', 'net', 'apps'];

/* What each one means, in the words the person authorising it needs. Kept next
   to the list rather than in the dialog that renders it: a capability added
   without a description would otherwise appear in an authorisation prompt as a
   bare identifier, which is worse than not asking at all. */
const APP_CAP_NOTES = {
  storage: '自己的小儲存（記住設定與上次的值，只有這個程式看得到）',
  appdata: '自己的資料夾 /appdata/<程式> 裡的讀寫',
  ai: '把問題送給模型',
  clipboard: '寫入剪貼簿',
  'sandbox-read': '讀取你沙箱裡的檔案',
  'sandbox-write': '寫入你沙箱裡的任何檔案（會覆蓋既有檔案）',
  apps: '叫系統裡的其他程式做事（文件、試算表、簡報、郵件…各自發布的動作）',
  page: '讀取瀏覽器目前這一頁的文字、換掉頁面上的文字、把整頁存成 PDF' +
        '（程式不會在網頁裡執行，只能提出文字修改）',
  net: '連上網路讀取公開網址的資料（走核心的 net.egress 閘門；不能連本機與內網）'
};

/* The ones that reach past the program's own sandbox, and so are the ones worth
   stopping a person to ask about.

   The split matters because the install prompt used to fire on *any* declared
   capability, and `storage` -- a 512 KB localStorage key named after the app,
   which cannot see the user's files, the network or the model -- is what every
   program that remembers anything declares. Six of the first eight installed
   apps asked for it. A prompt that fires on nearly every build is one people
   learn to click through, which spends the attention that `sandbox-read` and
   `ai` actually need. Friction proportional to the request means this list,
   not `caps.length`.

   `appdata` is on the quiet side for the same reason `storage` is: it is scoped
   to /appdata/<program> and reaches nothing the program did not create. Move a
   capability here only when it cannot affect anything outside that boundary. */
const CAPS_REACHING_OUT = ['ai', 'clipboard', 'sandbox-read', 'sandbox-write', 'page', 'net', 'apps'];

/** The declared capabilities that warrant an authorisation prompt. */
function capsNeedingConsent(list) {
  return sanitiseCaps(list).filter((c) => CAPS_REACHING_OUT.includes(c));
}

/* ----------------------------------------------------- the manifest as grant

   An installed program's calls do not go through the policy gate. The decision
   about a program is made once, at planning time (feasible or refused) and at
   install (the capabilities named to the person), and a program that exists is
   not stopped afterwards: no dialog when the weather app fetches, no taint
   downgrade turning its appdata write into a question. What stands in for the
   gate is this table -- each call a program can make, and the capability its
   manifest must carry -- checked here against the index, which is outside the
   sandbox and holds only what a human approved. A program whose code was
   edited on disk fails the hash and gets nothing; a program never installed
   gets nothing; a program asking for a call its manifest does not cover gets
   nothing. Confinement (appdata paths, the URL screen, the tab) is enforced by
   the handler that performs the call, in ipc.js. */
const CALL_CAPS = {
  'files.list': 'appdata', 'files.read': 'appdata', 'files.write': 'appdata',
  'sandbox.list': 'sandbox-read', 'sandbox.read': 'sandbox-read',
  'sandbox.write': 'sandbox-write', 'sandbox.mkdir': 'sandbox-write',
  'net.fetch': 'net',
  'clipboard.write': 'clipboard',
  'page.read': 'page', 'page.apply': 'page', 'page.pdf': 'page'
};

/**
 * Refuse unless this installed program's manifest covers the call. Returns
 * the app's index entry, so the handler can confine the call to it.
 */
async function assertGrant(slug, call) {
  const id = assertSlug(slug);
  const meta = index.apps[id];
  if (!meta) throw Object.assign(new Error('沒有安裝這個程式：' + id), { code: 'ENOENT' });
  const cap = CALL_CAPS[String(call || '')];
  if (!cap) throw Object.assign(new Error('程式不能發出這種呼叫：' + call), { code: 'EINVAL' });
  if (!(meta.capabilities || []).includes(cap)) {
    throw Object.assign(new Error('這個程式的 manifest 沒有「' + cap + '」，不能呼叫 ' + call), { code: 'EPERM' });
  }
  /* The code on disk has to be the code that was approved, or the grant is
     being spent by something nobody looked at. Same check as load(). */
  const file = await sandbox.read(`${APPS_DIR}/${id}/app.js`);
  if (hash(file.content) !== meta.hash) {
    throw Object.assign(new Error('app.js 已被改動，和核准過的版本不符，先重新核准'), { code: 'EINTEGRITY' });
  }
  return { id, cap, meta, appDir: `/appdata/${id}` };
}

/* ------------------------------------------------------------- libraries

   A program that needs a charting library, a Markdown parser, a QR encoder
   or a date library does not get told the machine has none. The planner
   names the npm package and the global it exports; this fetches the
   package's browser build, checks that it is JavaScript and not an HTML
   error page, pins its SHA-256 in the index, and keeps the file under
   /apps/_libs/ where the person can read it. The frame then loads it
   before the program's own code, inline, inside the same sandbox: a library
   has exactly the reach the program has, no more.

   Two sources, both public and unauthenticated: the npm registry for "what
   is the latest version" and jsDelivr for the file itself. jsDelivr serves
   a package's default browser entry at /npm/<name>@<version>, which for the
   libraries people ask for is the UMD/IIFE build that sets a global. The
   download is a network request the forge makes on the user's behalf and
   answers to net.egress like every other request this machine makes. */
const LIB_DIR = `${APPS_DIR}/_libs`;
const MAX_LIB = 3 * 1024 * 1024;
const MAX_LIBS_PER_APP = 4;
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const NPM_CDN = 'https://cdn.jsdelivr.net/npm/';
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,200}$/;

function libKey(name, version) {
  return String(name).replace(/^@/, '').replace(/\//g, '__') + '@' + String(version).replace(/[^0-9A-Za-z.+-]/g, '_');
}

/** Resolve, fetch, check and cache one package. Returns its index record. */
async function fetchLib(rawName, opts = {}) {
  const name = String(rawName || '').trim().toLowerCase();
  if (!NPM_NAME.test(name)) throw Object.assign(new Error('不是合法的 npm 套件名稱：' + rawName), { code: 'EINVAL' });
  const fetcher = opts.fetch || web.fetchRaw;

  const metaRes = await fetcher(NPM_REGISTRY + name.replace('/', '%2F') + '/latest', { timeoutMs: 15000 });
  if (!metaRes.ok) throw Object.assign(new Error('npm 上找不到套件 ' + name + '（HTTP ' + metaRes.status + '）'), { code: 'ENOENT' });
  let meta;
  try { meta = JSON.parse(metaRes.text); } catch { throw Object.assign(new Error('npm 的回應不是 JSON'), { code: 'EFAIL' }); }
  const version = String(meta.version || '');
  if (!/^\d+\.\d+\.\d+/.test(version)) throw Object.assign(new Error('套件 ' + name + ' 沒有可用的版本'), { code: 'ENOENT' });
  const key = libKey(name, version);

  index.libs = index.libs || {};
  const cached = index.libs[key];
  if (cached) {
    try {
      const file = await sandbox.read(cached.vpath);
      if (hash(file.content) === cached.hash) return { ...cached, cached: true };
    } catch { /* fall through and fetch again */ }
  }

  const fileRes = await fetcher(NPM_CDN + name + '@' + version, { timeoutMs: 30000 });
  if (!fileRes.ok) throw Object.assign(new Error('下載 ' + name + '@' + version + ' 失敗（HTTP ' + fileRes.status + '）'), { code: 'ENET' });
  const src = String(fileRes.text || '');
  if (src.length > MAX_LIB) throw Object.assign(new Error(name + ' 太大（' + Math.round(src.length / 1024) + ' KiB，上限 3 MiB）'), { code: 'EFBIG' });
  if (/^\s*</.test(src)) throw Object.assign(new Error(name + ' 的回應是 HTML，不是程式碼'), { code: 'ETYPE' });
  /* A module build would leave the program with nothing on window. The
     planner was told to name UMD/IIFE packages; this is the check, and it
     comes before the parse: `export` is a syntax error in a classic script,
     and "cannot be parsed" would name the wrong cause. */
  if (/^\s*(?:import|export)\b/m.test(src.slice(0, 4000)) && !/typeof\s+exports|typeof\s+define|window\./.test(src.slice(0, 20000))) {
    throw Object.assign(new Error(name + ' 的預設檔案是 ES module，不會掛全域變數；換一個提供 UMD 建置的套件'), { code: 'ETYPE' });
  }
  const parsed = checkSyntax(src);
  if (!parsed.ok) throw Object.assign(new Error(name + ' 無法解析：' + parsed.message), { code: 'ESYNTAX' });

  const vpath = `${LIB_DIR}/${key}.js`;
  await sandbox.mkdir(LIB_DIR).catch(() => {});
  await sandbox.write(vpath, src, { origin: 'local' });
  const record = { name, version, key, hash: hash(src), bytes: src.length, vpath, at: Date.now() };
  index.libs[key] = record;
  await saveIndex();
  return record;
}

/** The text of a cached library, only if it is still the text that was pinned. */
async function libSource(key) {
  const rec = (index.libs || {})[String(key || '')];
  if (!rec) throw Object.assign(new Error('沒有這個套件：' + key), { code: 'ENOENT' });
  const file = await sandbox.read(rec.vpath);
  if (hash(file.content) !== rec.hash) {
    throw Object.assign(new Error('套件 ' + key + ' 的檔案被改過，和記錄的雜湊不符'), { code: 'EINTEGRITY' });
  }
  return { ...rec, source: file.content };
}

/** The library records a manifest may carry: known keys only, capped. */
function sanitiseLibs(list) {
  const out = [];
  for (const l of Array.isArray(list) ? list : []) {
    if (!l || typeof l !== 'object') continue;
    const key = String(l.key || '');
    if (!(index.libs || {})[key]) continue;
    if (out.some((o) => o.key === key)) continue;
    out.push({ key, name: index.libs[key].name, version: index.libs[key].version,
      global: String(l.global || '').slice(0, 60), hash: index.libs[key].hash });
    if (out.length >= MAX_LIBS_PER_APP) break;
  }
  return out;
}

/** A path inside the program's own folder, or an error. */
function appDataPath(id, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some((seg) => seg === '..')) {
    throw Object.assign(new Error('路徑不能包含 ..'), { code: 'EINVAL' });
  }
  return `/appdata/${id}` + (clean ? '/' + clean : '');
}

function sanitiseCaps(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(String))].filter((c) => APP_CAPS.includes(c));
}

/* ------------------------------------------------------------ does it parse?

   The static checks in the renderer look for forbidden APIs and undeclared
   capabilities. None of them answers the cheapest and most fatal question: is
   this JavaScript at all?

   A generated timer went in with `await` inside a function nobody had marked
   async. The build reported 「通過靜態檢查」, installed it, opened it, and produced
   an empty window -- the syntax error surfaced afterwards, in the frame, where it
   read as a runtime complaint about a missing render(). Passing a check and then
   not working is the worst shape a failure can take.

   `vm.Script` compiles and does not run. A SyntaxError is raised by compilation,
   which happens before any statement of the program could execute, so this cannot
   be a way to make generated code run early. It is also why the renderer does not
   do this itself with `new Function`: that would put a compiler in the process
   that hosts the shell, to answer a question the main process can answer safely.
*/
function checkSyntax(code) {
  const src = String(code || '');
  try {
    new vm.Script(src, { filename: 'app.js' });
    return { ok: true };
  } catch (e) {
    const stack = String((e && e.stack) || '');
    const line = Number((stack.match(/^app\.js:(\d+)/m) || [])[1]) || null;
    // The offending source line, so the retry prompt can show it rather than
    // asking the model to count.
    const text = line ? (src.split('\n')[line - 1] || '').trim().slice(0, 200) : '';
    return {
      ok: false,
      message: (e && e.message) || '無法解析',
      line,
      text
    };
  }
}

/* ------------------------------------------------------------------- create */

/**
 * Install a new version. Used both for the first build and every later edit;
 * the difference is only whether a manifest already exists.
 */
async function install({ slug, name, purpose, icon, code, capabilities, libs, prompt, note, author } = {}) {
  const id = assertSlug(slug || toSlug(name));
  const src = String(code || '');
  if (!src.trim()) throw new Error('沒有程式碼');
  if (src.length > MAX_CODE) throw new Error(`程式碼超過上限（${Math.round(MAX_CODE / 1024)} KB）`);

  const existing = index.apps[id] || null;
  const version = existing ? existing.version + 1 : 1;

  const manifest = {
    id,
    name: String(name || existing?.name || id).slice(0, 60),
    purpose: String(purpose || existing?.purpose || '').slice(0, 400),
    icon: String(icon || existing?.icon || '\u25c8').slice(0, 4),
    version,
    capabilities: sanitiseCaps(capabilities || existing?.capabilities),
    /* Libraries travel with the version, like capabilities: a rebuild that
       stops needing one drops it; one that omits the field keeps them. */
    libs: sanitiseLibs(libs !== undefined ? libs : existing?.libs),
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now()
  };

  const dir = `${APPS_DIR}/${id}`;
  await sandbox.mkdir(dir);
  await sandbox.mkdir(`${dir}/history`);
  await sandbox.write(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2), { origin: 'local' });
  await sandbox.write(`${dir}/app.js`, src, { origin: 'local' });

  // Build trail. One file per version, holding what was asked for and what came
  // back, so the history is readable without this application.
  const record = {
    version,
    at: Date.now(),
    author: author === 'user' ? 'user' : 'model',
    prompt: String(prompt || '').slice(0, 4000),
    note: String(note || '').slice(0, 500),
    codeHash: hash(src),
    codeBytes: src.length,
    code: src
  };
  await sandbox.write(
    `${dir}/history/${String(version).padStart(4, '0')}.json`,
    JSON.stringify(record, null, 2),
    { origin: 'local' }
  );

  await writeReadme(dir, manifest, record);

  index.apps[id] = {
    name: manifest.name,
    purpose: manifest.purpose,
    icon: manifest.icon,
    version,
    hash: record.codeHash,
    capabilities: manifest.capabilities,
    libs: manifest.libs,
    approvedAt: Date.now(),
    createdAt: manifest.createdAt
  };
  await saveIndex();

  return { manifest, version, hash: record.codeHash };
}

async function writeReadme(dir, manifest, record) {
  const lines = [
    `# ${manifest.name}`,
    '',
    manifest.purpose || '（沒有說明）',
    '',
    '## 這是什麼',
    '',
    '由 AI-OS 的 App Forge 依需求產生的程式。它跑在一個受限的 iframe 裡，',
    '沒有直接的檔案系統或網路權限，只能透過核心提供的能力介面工作。',
    '',
    '## 目前狀態',
    '',
    `- 版本：v${manifest.version}`,
    `- 能力：${manifest.capabilities.length ? manifest.capabilities.join('、') : '無（純運算與介面）'}`,
    `- 套件：${(manifest.libs || []).length ? manifest.libs.map((l) => l.name + '@' + l.version + '（' + l.global + '）').join('、') : '無'}`,
    `- 建立：${new Date(manifest.createdAt).toLocaleString('zh-TW')}`,
    `- 最後修改：${new Date(manifest.updatedAt).toLocaleString('zh-TW')}`,
    `- 程式碼雜湊：\`${record.codeHash.slice(0, 16)}…\``,
    '',
    '## 檔案',
    '',
    '| 路徑 | 內容 |',
    '| --- | --- |',
    '| `manifest.json` | 名稱、能力、版本 |',
    '| `app.js` | 目前執行的程式碼 |',
    '| `history/NNNN.json` | 每一版的需求、產出與雜湊 |',
    '| `README.md` | 這份文件（每次改版重新產生） |',
    '',
    '## 修改方式',
    '',
    '在程式視窗右側的對話面板直接說要改什麼。核心會重新產生程式碼、',
    '版本號加一、把這次的需求寫進 history/，並更新這份文件。',
    '',
    '舊版本可以從 Forge 的版本列表還原。',
    '',
    '## 完整性',
    '',
    '執行許可與程式碼雜湊記錄在沙箱外。直接用編輯器改 `app.js` 會讓雜湊',
    '對不上，核心會拒絕執行並要求你重新確認 —— 這是為了讓「能寫檔案」',
    '不等於「能安裝會執行的程式碼」。',
    '',
    '## 修改紀錄',
    ''
  ];

  const hist = await listHistory(manifest.id).catch(() => []);
  for (const h of hist.slice().reverse()) {
    lines.push(`### v${h.version} — ${new Date(h.at).toLocaleString('zh-TW')}（${h.author === 'user' ? '手動' : '模型'}）`);
    lines.push('');
    if (h.prompt) lines.push('需求：' + h.prompt.replace(/\n+/g, ' ').slice(0, 300));
    if (h.note) lines.push('');
    if (h.note) lines.push('說明：' + h.note.replace(/\n+/g, ' ').slice(0, 300));
    lines.push('');
  }

  await sandbox.write(`${dir}/README.md`, lines.join('\n'), { origin: 'local' });
}

/* --------------------------------------------------------------------- read */

async function listApps() {
  const out = [];
  for (const [id, meta] of Object.entries(index.apps)) {
    let integrity = 'unknown';
    try {
      const file = await sandbox.read(`${APPS_DIR}/${id}/app.js`);
      integrity = hash(file.content) === meta.hash ? 'ok' : 'modified';
    } catch {
      integrity = 'missing';
    }
    out.push({ id, ...meta, integrity });
  }
  return out.sort((a, b) => b.approvedAt - a.approvedAt);
}

/**
 * Load an app for execution. Refuses when the code on disk is not the code that
 * was approved: see the note at the top of this file.
 */
async function load(slug) {
  const id = assertSlug(slug);
  const meta = index.apps[id];
  if (!meta) throw Object.assign(new Error('沒有這個程式：' + id), { code: 'ENOENT' });

  const dir = `${APPS_DIR}/${id}`;
  const codeFile = await sandbox.read(`${dir}/app.js`);
  const actual = hash(codeFile.content);

  let manifest = null;
  try {
    manifest = JSON.parse((await sandbox.read(`${dir}/manifest.json`)).content);
  } catch {
    manifest = { id, name: meta.name, version: meta.version, capabilities: meta.capabilities };
  }

  /* What the manifest on disk claims, sanitised. Alongside the grant, so the
     window can show a person what approving this code would hand it -- and,
     when the two differ with the hash intact, that the program is about to be
     refused calls its own manifest says it needs. */
  const manifestCaps = sanitiseCaps(manifest.capabilities);

  if (actual !== meta.hash) {
    return {
      ok: false,
      code: 'EINTEGRITY',
      error: 'app.js 已被改動，和核准過的版本不符',
      expected: meta.hash.slice(0, 16),
      actual: actual.slice(0, 16),
      manifest,
      capabilities: meta.capabilities,
      pendingCapabilities: manifestCaps,
      pendingCode: codeFile.content
    };
  }

  return { ok: true, manifest, code: codeFile.content, capabilities: meta.capabilities, manifestCaps,
    libs: meta.libs || [], hash: actual };
}

/**
 * Approve the current on-disk contents, after a human has looked at them.
 *
 * The grant follows the code. Approving used to re-hash app.js and leave the
 * index's capabilities as they were, so a program whose new version declared
 * `storage` ran under the old version's empty grant and was refused every
 * call -- 「拒絕 storage.get（未授權的能力）」 right after 「已核准新的程式碼」.
 * The manifest beside the code is what the person was shown; it is what the
 * approval grants, through the same sanitiser as an install.
 */
async function approveCurrent(slug) {
  const id = assertSlug(slug);
  const meta = index.apps[id];
  if (!meta) throw new Error('沒有這個程式：' + id);
  const codeFile = await sandbox.read(`${APPS_DIR}/${id}/app.js`);
  let manifest = null;
  try { manifest = JSON.parse((await sandbox.read(`${APPS_DIR}/${id}/manifest.json`)).content); } catch { manifest = null; }

  const before = (meta.capabilities || []).slice();
  if (manifest && typeof manifest === 'object') {
    meta.capabilities = sanitiseCaps(manifest.capabilities);
    meta.libs = sanitiseLibs(manifest.libs);
    if (manifest.name) meta.name = String(manifest.name).slice(0, 60);
    if (manifest.purpose) meta.purpose = String(manifest.purpose).slice(0, 400);
    if (manifest.icon) meta.icon = String(manifest.icon).slice(0, 4);
    if (Number(manifest.version) > 0) meta.version = Number(manifest.version);
  }
  meta.hash = hash(codeFile.content);
  meta.approvedAt = Date.now();
  await saveIndex();
  return { id, hash: meta.hash, capabilities: meta.capabilities, before };
}

async function listHistory(slug) {
  const id = assertSlug(slug);
  const listing = await sandbox.list(`${APPS_DIR}/${id}/history`).catch(() => ({ entries: [] }));
  const out = [];
  for (const ent of listing.entries) {
    // The NNNN.json records only; an imported trail sits beside them.
    if (ent.dir || !/^\d{4}\.json$/.test(ent.name)) continue;
    try {
      const raw = JSON.parse((await sandbox.read(ent.vpath)).content);
      // Code bodies stay on disk; the list only needs the metadata.
      out.push({
        version: raw.version, at: raw.at, author: raw.author,
        prompt: raw.prompt, note: raw.note,
        codeHash: raw.codeHash, codeBytes: raw.codeBytes
      });
    } catch { /* skip damaged record */ }
  }
  return out.sort((a, b) => a.version - b.version).slice(-MAX_VERSIONS);
}

async function getVersion(slug, version) {
  const id = assertSlug(slug);
  const file = `${APPS_DIR}/${id}/history/${String(version).padStart(4, '0')}.json`;
  const raw = JSON.parse((await sandbox.read(file)).content);
  return raw;
}

/** Restoring an old version installs it as a new one, so history stays linear. */
async function rollback(slug, version) {
  const old = await getVersion(slug, version);
  return install({
    slug,
    code: old.code,
    prompt: `回滾到 v${version}`,
    note: `內容取自 v${version}（${new Date(old.at).toLocaleString('zh-TW')}）`,
    author: 'user'
  });
}

/* ============================================================ frame hosting

   A generated app used to run in an `about:srcdoc` iframe. That does not work,
   and the failure was silent: a srcdoc document inherits its parent's Content
   Security Policy, the shell document sets `script-src 'self'`, and the two
   policies are enforced together. So every inline script in the frame was
   blocked -- the styles applied, #root stayed empty, and because the bootstrap
   never ran there was nothing left alive to report the error.

   Serving the frame from its own scheme fixes it at the root: only the "local"
   schemes (about:, data:, blob:, filesystem:) and srcdoc inherit a policy, so
   an aios-app:// document carries exactly the CSP sent with it and nothing
   else. The iframe is still sandboxed without allow-same-origin, so the document
   lands in an opaque origin and cannot reach this one; the scheme buys the app
   its own policy, not any authority. The exact token list lives in one place,
   `FRAME_SANDBOX` in renderer/apps/appshell.js -- naming it here as well is how
   the two drift apart.

   HTML is held in memory only, keyed by a random token, and is never read from
   disk on this path -- so nothing that can write a file can get code served
   here. The renderer composes it from code that forge.load() already
   hash-checked.
   =========================================================================== */

const frames = new Map();   // token -> { slug, html, at }

function publishFrame(slug, html) {
  const id = assertSlug(slug);
  const body = String(html || '');
  if (!body) throw new Error('沒有內容可以呈現');
  if (body.length > MAX_FRAME_HTML) throw new Error('程式頁面太大');

  // One live token per app: republishing revokes the old URL, so a stale frame
  // cannot be reopened after the code changed.
  for (const [token, rec] of frames) {
    if (rec.slug === id) frames.delete(token);
  }

  const token = crypto.randomBytes(16).toString('hex');
  frames.set(token, { slug: id, html: body, at: Date.now() });
  return { url: `${FRAME_SCHEME}://${token}/index.html`, token };
}

function revokeFrame(token) {
  return frames.delete(String(token || ''));
}

/**
 * Answer a request on the frame scheme. Only the exact published path for a
 * live token is served; everything else is a 404, including any attempt to walk
 * to another token's document.
 */
function serveFrame(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== FRAME_SCHEME + ':') return null;
  if (u.pathname !== '/index.html') return null;
  const rec = frames.get(u.hostname);
  if (!rec) return null;
  return { html: rec.html, slug: rec.slug };
}

/* ============================================================ share / import

   A program leaves this machine as one JSON file, `.aiosapp`, holding what
   the sandbox already holds -- manifest, code, the pinned libraries' source,
   and the build trail without its code bodies -- and nothing from outside it:
   not the index entry, not the hash that grants execution, not /appdata.

   Import is the side that matters. Four things it never does:

     1. It is not a syscall. Nothing in the OPS table reaches it; the model can
        open the file in Forge, where a person has to press 匯入.
     2. It never installs without a dialog, even for a program that asks for no
        capability at all. The gesture install may skip its dialog because the
        person asked for that program minutes ago; a file someone sent them is
        not that situation, and the manifest is the sender's claim.
     3. The package's word about itself is checked, not trusted. Its hash is
        compared against its own code (transport integrity), and the hash that
        grants execution is computed here by install() from the bytes actually
        written -- a package cannot bring its own permission.
     4. A name already installed is a question with no default: replace as
        v+1 (history kept) or install beside as <slug>-2.

   Two steps, both here, joined by a token: preview parses and holds the
   package in memory; the confirmed install uses that held copy, so what the
   person was shown is what is installed even if the renderer is lying. */
const PACKAGE_FORMAT = 'aiosapp';
const PACKAGE_VERSION = 1;
const MAX_PACKAGE = 16 * 1024 * 1024;
const EXPORT_DIR = '/outbox';
const PENDING_TTL = 10 * 60 * 1000;
const GLOBAL_NAME = /^[A-Za-z_$][\w$]{0,59}$/;

const pending = new Map();   // token -> { pkg, slug, vpath, at }

/** The package for an installed program, written to /outbox. */
async function exportApp(slug, opts = {}) {
  const id = assertSlug(slug);
  const meta = index.apps[id];
  if (!meta) throw Object.assign(new Error('沒有安裝這個程式：' + id), { code: 'ENOENT' });
  const dir = `${APPS_DIR}/${id}`;
  const file = await sandbox.read(`${dir}/app.js`);
  /* Only approved code leaves: a file edited on disk after approval is
     something nobody has looked at, and it should not travel under this
     program's name. */
  if (hash(file.content) !== meta.hash) {
    throw Object.assign(new Error('app.js 已被改動，和核准過的版本不符；先在程式視窗重新核准再分享'), { code: 'EINTEGRITY' });
  }
  let manifest = null;
  try { manifest = JSON.parse((await sandbox.read(`${dir}/manifest.json`)).content); } catch { manifest = {}; }

  const libs = [];
  for (const l of meta.libs || []) {
    // eslint-disable-next-line no-await-in-loop
    const src = await libSource(l.key);
    libs.push({ name: src.name, version: src.version, global: l.global, hash: src.hash, source: src.source });
  }

  const withHistory = opts.history !== false;
  const history = withHistory ? (await listHistory(id).catch(() => [])) : [];
  let readme = '';
  try { readme = (await sandbox.read(`${dir}/README.md`)).content; } catch { readme = ''; }

  const pkg = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_VERSION,
    exportedAt: Date.now(),
    exportedBy: 'AI-OS ' + (opts.appVersion || ''),
    app: {
      id,
      name: meta.name,
      purpose: meta.purpose,
      icon: meta.icon,
      version: meta.version,
      capabilities: sanitiseCaps(meta.capabilities),
      createdAt: manifest.createdAt || meta.createdAt || null,
      updatedAt: manifest.updatedAt || null
    },
    code: file.content,
    codeHash: meta.hash,
    libs,
    history,
    readme
  };

  await sandbox.mkdir(EXPORT_DIR).catch(() => {});
  const vpath = `${EXPORT_DIR}/${id}-v${meta.version}.aiosapp`;
  const out = await sandbox.write(vpath, JSON.stringify(pkg, null, 2), { origin: 'local' });
  return { vpath: out.vpath, bytes: out.bytes, name: meta.name, version: meta.version,
    libs: libs.length, history: history.length };
}

/** Parse and check a package. Throws with the first thing wrong. */
function parsePackage(text) {
  let pkg;
  try { pkg = JSON.parse(String(text || '')); } catch { throw Object.assign(new Error('不是 JSON 檔'), { code: 'EFORMAT' }); }
  if (!pkg || typeof pkg !== 'object' || pkg.format !== PACKAGE_FORMAT) {
    throw Object.assign(new Error('不是 AI-OS 的程式包（format 不是 aiosapp）'), { code: 'EFORMAT' });
  }
  if (pkg.formatVersion !== PACKAGE_VERSION) {
    throw Object.assign(new Error('程式包的格式版本是 ' + pkg.formatVersion + '，這台機器只認得 ' + PACKAGE_VERSION), { code: 'EFORMAT' });
  }
  const app = pkg.app && typeof pkg.app === 'object' ? pkg.app : null;
  if (!app || !String(app.name || '').trim()) throw Object.assign(new Error('程式包沒有名稱'), { code: 'EFORMAT' });
  const code = typeof pkg.code === 'string' ? pkg.code : '';
  if (!code.trim()) throw Object.assign(new Error('程式包沒有程式碼'), { code: 'EFORMAT' });
  if (code.length > MAX_CODE) throw Object.assign(new Error(`程式碼超過上限（${Math.round(MAX_CODE / 1024)} KB）`), { code: 'EFBIG' });
  if (typeof pkg.codeHash === 'string' && pkg.codeHash && pkg.codeHash !== hash(code)) {
    throw Object.assign(new Error('程式碼和程式包自己記的雜湊不符，檔案在傳輸中壞了或被改過'), { code: 'EINTEGRITY' });
  }
  const parsed = checkSyntax(code);
  if (!parsed.ok) throw Object.assign(new Error('程式碼無法解析：' + parsed.message + (parsed.line ? '（第 ' + parsed.line + ' 行）' : '')), { code: 'ESYNTAX' });

  const libs = [];
  for (const l of Array.isArray(pkg.libs) ? pkg.libs : []) {
    if (!l || typeof l !== 'object') continue;
    const name = String(l.name || '').trim().toLowerCase();
    const version = String(l.version || '');
    const global = String(l.global || '');
    const source = typeof l.source === 'string' ? l.source : '';
    if (!NPM_NAME.test(name)) throw Object.assign(new Error('套件名稱不合法：' + l.name), { code: 'EFORMAT' });
    if (!/^\d+\.\d+\.\d+/.test(version)) throw Object.assign(new Error('套件 ' + name + ' 沒有版本'), { code: 'EFORMAT' });
    if (!GLOBAL_NAME.test(global)) throw Object.assign(new Error('套件 ' + name + ' 的全域名稱不合法'), { code: 'EFORMAT' });
    if (!source.trim()) throw Object.assign(new Error('套件 ' + name + ' 沒有程式碼'), { code: 'EFORMAT' });
    if (source.length > MAX_LIB) throw Object.assign(new Error('套件 ' + name + ' 太大'), { code: 'EFBIG' });
    if (String(l.hash || '') !== hash(source)) throw Object.assign(new Error('套件 ' + name + ' 的內容和記的雜湊不符'), { code: 'EINTEGRITY' });
    if (/^\s*</.test(source)) throw Object.assign(new Error('套件 ' + name + ' 是 HTML，不是程式碼'), { code: 'ETYPE' });
    const lp = checkSyntax(source);
    if (!lp.ok) throw Object.assign(new Error('套件 ' + name + ' 無法解析：' + lp.message), { code: 'ESYNTAX' });
    libs.push({ name, version, global, hash: l.hash, source, key: libKey(name, version) });
    if (libs.length >= MAX_LIBS_PER_APP) break;
  }

  const history = (Array.isArray(pkg.history) ? pkg.history : []).slice(0, MAX_VERSIONS)
    .filter((h) => h && typeof h === 'object')
    .map((h) => ({
      version: Number(h.version) || 0, at: Number(h.at) || 0,
      author: h.author === 'user' ? 'user' : 'model',
      prompt: String(h.prompt || '').slice(0, 4000), note: String(h.note || '').slice(0, 500),
      codeHash: String(h.codeHash || '').slice(0, 64), codeBytes: Number(h.codeBytes) || 0
    }));

  return {
    app: {
      name: String(app.name).slice(0, 60),
      purpose: String(app.purpose || '').slice(0, 400),
      icon: String(app.icon || '◈').slice(0, 4),
      version: Number(app.version) || 0,
      capabilities: sanitiseCaps(app.capabilities),
      /* The sender's id is a suggestion for the slug, nothing more: it goes
         through the same charset rule as a name typed here. */
      id: toSlug(app.id || app.name)
    },
    code, libs, history,
    exportedAt: Number(pkg.exportedAt) || 0,
    exportedBy: String(pkg.exportedBy || '').slice(0, 60)
  };
}

/** A slug not yet taken: `todo` → `todo-2`, `todo-3`, … */
function freeSlug(base) {
  if (!index.apps[base]) return base;
  const stem = base.slice(0, 36);
  for (let n = 2; n < 1000; n++) {
    const s = stem + '-' + n;
    if (!index.apps[s]) return s;
  }
  throw Object.assign(new Error('找不到可用的程式代號'), { code: 'EEXIST' });
}

function sweepPending() {
  const now = Date.now();
  for (const [t, p] of pending) if (now - p.at > PENDING_TTL) pending.delete(t);
}

/**
 * Read a package from the sandbox and describe it. The code and library
 * sources go back too -- the renderer runs the same static checks and smoke
 * test every build passes -- but the copy that gets installed is the one
 * held here under the token.
 */
async function importPreview(vpath) {
  sweepPending();
  const p = String(vpath || '');
  if (!/\.aiosapp$/i.test(p)) throw Object.assign(new Error('不是 .aiosapp 檔：' + p), { code: 'EFORMAT' });
  const file = await sandbox.read(p, { maxBytes: MAX_PACKAGE });
  const pkg = parsePackage(file.content);
  const existing = index.apps[pkg.app.id] || null;

  /* A library already pinned under the same name and version must be the
     same bytes; a package cannot swap what other programs here load. */
  for (const l of pkg.libs) {
    const have = (index.libs || {})[l.key];
    if (have && have.hash !== l.hash) {
      throw Object.assign(new Error('套件 ' + l.name + '@' + l.version + ' 和這台機器已釘住的版本內容不同，不能匯入'), { code: 'EINTEGRITY' });
    }
  }

  const token = crypto.randomBytes(16).toString('hex');
  pending.set(token, { pkg, slug: pkg.app.id, vpath: p, at: Date.now() });
  return {
    token,
    vpath: p,
    slug: pkg.app.id,
    name: pkg.app.name,
    purpose: pkg.app.purpose,
    icon: pkg.app.icon,
    version: pkg.app.version,
    capabilities: pkg.app.capabilities,
    capsReachingOut: capsNeedingConsent(pkg.app.capabilities),
    codeBytes: pkg.code.length,
    libs: pkg.libs.map((l) => ({ name: l.name, version: l.version, global: l.global, bytes: l.source.length,
      pinned: !!(index.libs || {})[l.key] })),
    history: pkg.history.length,
    exportedAt: pkg.exportedAt,
    exportedBy: pkg.exportedBy,
    existing: existing ? { name: existing.name, version: existing.version } : null,
    besideSlug: existing ? freeSlug(pkg.app.id) : null,
    code: pkg.code,
    libSources: pkg.libs.map((l) => ({ global: l.global, name: l.name, version: l.version, source: l.source }))
  };
}

/** What a pending import is, for the dialog. Null when the token is unknown. */
function pendingImport(token) {
  sweepPending();
  return pending.get(String(token || '')) || null;
}

/** Forget a previewed package: the checks failed, or the person said no. */
function dropImport(token) {
  return pending.delete(String(token || ''));
}

/** The index entry for an installed program, or null. */
function installedMeta(slug) {
  return index.apps[String(slug || '')] || null;
}

/**
 * The install a person confirmed. `choice` is 'replace' (v+1 under the same
 * slug) or 'beside' (a fresh slug); with no existing program either means a
 * new install. Called only after the dialog, by ipc.js.
 */
async function importInstall(token, choice) {
  const p = pendingImport(token);
  if (!p) throw Object.assign(new Error('這個匯入已經過期或不存在，重新開啟程式包'), { code: 'ENOENT' });
  pending.delete(token);
  const { pkg } = p;
  const existing = index.apps[pkg.app.id] || null;
  const slug = existing && choice === 'beside' ? freeSlug(pkg.app.id) : pkg.app.id;
  if (existing && slug === pkg.app.id && choice !== 'replace') {
    throw Object.assign(new Error('已經有一個「' + pkg.app.id + '」，要取代還是另外裝，沒有說'), { code: 'EEXIST' });
  }

  // Libraries first, pinned exactly as fetchLib pins them.
  index.libs = index.libs || {};
  await sandbox.mkdir(LIB_DIR).catch(() => {});
  for (const l of pkg.libs) {
    const have = index.libs[l.key];
    if (have && have.hash === l.hash) continue;
    const lv = `${LIB_DIR}/${l.key}.js`;
    // eslint-disable-next-line no-await-in-loop
    await sandbox.write(lv, l.source, { origin: 'local' });
    index.libs[l.key] = { name: l.name, version: l.version, key: l.key, hash: l.hash, bytes: l.source.length, vpath: lv, at: Date.now() };
  }

  const from = p.vpath.split('/').pop();
  const res = await install({
    slug,
    name: pkg.app.name,
    purpose: pkg.app.purpose,
    icon: pkg.app.icon,
    code: pkg.code,
    capabilities: pkg.app.capabilities,
    libs: pkg.libs.map((l) => ({ key: l.key, global: l.global })),
    prompt: '匯入自 ' + from,
    note: '來自 ' + (pkg.exportedBy || '另一台 AI-OS') + '，原版本 v' + pkg.app.version +
      (pkg.history.length ? '，附 ' + pkg.history.length + ' 筆歷史' : ''),
    author: 'user'
  });

  /* The sender's build trail, kept beside ours rather than merged into it:
     their v1..vN and our v1 are different lines, and listHistory() reads only
     the NNNN.json records. */
  if (pkg.history.length) {
    await sandbox.write(`${APPS_DIR}/${slug}/imported-history.json`,
      JSON.stringify({ from, exportedBy: pkg.exportedBy, exportedAt: pkg.exportedAt, history: pkg.history }, null, 2),
      { origin: 'local' });
  }
  return { slug, name: pkg.app.name, version: res.version, hash: res.hash,
    replaced: !!(existing && slug === pkg.app.id), capabilities: pkg.app.capabilities };
}

async function remove(slug) {
  const id = assertSlug(slug);
  delete index.apps[id];
  for (const [token, rec] of frames) {
    if (rec.slug === id) frames.delete(token);
  }
  await saveIndex();
  // The files are left in the sandbox on purpose: this revokes the permission
  // to run, and the user can delete the directory in the file manager if they
  // also want the code gone.
  return { id, revoked: true, filesKeptAt: `${APPS_DIR}/${id}` };
}

module.exports = {
  init, install, listApps, load, approveCurrent,
  listHistory, getVersion, rollback, remove,
  publishFrame, revokeFrame, serveFrame,
  toSlug, hash, sanitiseCaps, capsNeedingConsent, checkSyntax,
  installPrefs, setConfirmInstall, setAutoRepair,
  assertGrant, appDataPath, CALL_CAPS,
  fetchLib, libSource, sanitiseLibs, libKey, NPM_NAME, MAX_LIBS_PER_APP,
  exportApp, parsePackage, importPreview, pendingImport, dropImport, importInstall, freeSlug, installedMeta,
  PACKAGE_FORMAT, PACKAGE_VERSION, EXPORT_DIR,
  APP_CAPS, APP_CAP_NOTES, CAPS_REACHING_OUT, APPS_DIR, FRAME_SCHEME
};
