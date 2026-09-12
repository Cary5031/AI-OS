'use strict';

/* ===========================================================================
   AI-OS // document extraction backends
   ---------------------------------------------------------------------------
   Two ways to turn a PDF into rows, and they are not alternatives of equal
   standing. One is the way it is meant to work; the other is what happens when
   the first one is down.

     service    the prompt studio's Extract API. It owns the list of document
                categories, the list of vendors, the column layout for each, and
                the tuned extraction prompts. The document goes to it and rows
                come back. THIS IS THE DEFAULT, and it is the default because it
                is the only arrangement in which one team can maintain those
                things for everybody.

     fallback   a cloud model called directly, with a prompt kept in a file on
                this machine. For when the studio cannot be reached. It is not a
                lesser implementation of the same idea; it is a different idea,
                and the program says which one is running.

   WHY THE STUDIO IS THE DEFAULT

   Because a vendor list maintained in fourteen copies is fourteen vendor lists.
   The first build of this made the local files the primary path, and that put
   every operator in charge of their own prompts and their own column order --
   which is exactly the state the studio exists to end.

   WHY THERE IS A FALLBACK AT ALL

   A person with forty invoices and a service that is down still has forty
   invoices. The fallback is worth having on the condition that it is honest
   about being the fallback, which is why `resolve()` returns a reason and the
   window puts it on screen rather than quietly carrying on.

   WHY THE LISTS ARE CACHED

   A fallback that cannot tell you which vendors exist is not a fallback. Every
   successful answer from the studio -- categories, vendors, column layouts -- is
   written to a cache file, so when the service is gone the program still knows
   the shape of the work. What the cache cannot supply is the extraction prompt,
   which the API does not hand out; that is the one thing a fallback profile has
   to carry itself.

   WHY THE PDF GOES WHOLE, AND NOT AS TEXT

   This machine can already read a PDF into text -- main/pdf.js does it, and
   renderer/pdfmd.js does it well enough to produce Markdown with tables. Feeding
   that text to a model is the obvious cheap path and it is the wrong one: the
   numbers in a delivery note live in a layout, and flattening the layout
   destroys the association between a part number and the quantity printed
   beside it. Tried against real documents, measured, worse.

   CONFIGURED THE WAY A CUSTOM MODEL IS CONFIGURED

   Each backend takes a base address, an auth kind, an API key, and a list of
   custom headers, exactly as llama.js's `custom` provider does. The two are
   configured separately and stored separately: a key set for one is never sent
   to the other's host. Key and headers are encrypted together in one blob,
   because a header value is exactly where a person puts a token.

   `state()` reports whether each has a key and what its custom headers are
   *called*. There is no getter for any secret value anywhere in this module.

   THE ADDRESS

   `call()` takes a path -- `/jobs` -- and joins it onto the configured service
   base. No argument anywhere lets a caller choose a host, so a renderer, or a
   plan that an untrusted document talked its way into, cannot point this at
   somewhere else. That is a stronger promise than checking a URL against a list,
   because there is no URL to check. `generate()` takes no path at all.

   WHY LOOPBACK IS ALLOWED HERE AND NOT IN web.js

   web.js refuses loopback and private addresses, and should: it fetches
   addresses that arrive inside content or inside a plan, and "read this page for
   me" must not become a way to probe the network this machine sits on. This is
   the other case -- an address a person typed into a settings pane, which for
   the prompt studio is very often the machine next to them.
   =========================================================================== */

const fs = require('node:fs/promises');
const path = require('node:path');
const { safeStorage } = require('electron');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const GEMINI_MODEL = 'gemini-2.5-pro';

/* Where documents get filed once they are done. A sandbox path, because the
   studio has no idea this machine has a sandbox, and the placeholders are
   resolved per document from whatever category and vendor it turned out to be. */
const DELIVER_DEFAULT = '/檔案/{大類}/{廠商}/{年月}';

const BACKENDS = ['service', 'fallback'];

/* How the key is presented. `apikey` is what the studio's API wants, `goog` is
   Google's own header, `bearer` is every OpenAI-compatible host, and `none` is
   for a gateway where the credential is a custom header instead. */
const AUTH_KINDS = ['apikey', 'goog', 'bearer', 'none'];

const DEFAULTS = {
  prefer: 'service',
  autoFallback: true,
  deliver: DELIVER_DEFAULT,
  owner: '',
  service: { base: '', auth: 'apikey', label: '提示詞工作室' },
  fallback: { base: GEMINI_BASE, model: GEMINI_MODEL, auth: 'goog', label: '備援模型' }
};

/* Their own console waits five minutes on an upload and thirty seconds on
   everything else. A document model reading twenty pages is slower than a chat
   turn, and the wait is the normal case rather than a symptom. */
const TIMEOUT_READ = 30 * 1000;
const TIMEOUT_UPLOAD = 300 * 1000;

/* A health answer is good for this long. Long enough that opening the window,
   picking a category and pressing parse does not cost three round trips; short
   enough that a service which died a minute ago is not still being reported as
   up when the batch is sent. Every failed call invalidates it immediately, so
   the window only matters while things are working. */
const HEALTH_TTL = 30 * 1000;

/* Gemini counts the whole serialised request against its inline limit, and
   base64 is four bytes for every three. 14 MiB of PDF is about 19 MiB on the
   wire, which is as close to the 20 MiB ceiling as is worth going. */
const MAX_INLINE = 14 * 1024 * 1024;
const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_RESPONSE = 64 * 1024 * 1024;

const MAX_HEADERS = 20;

let confPath = null;
let cachePath = null;
let sealed = false;
let conf = clone(DEFAULTS);

/* Keys and custom header values, decrypted, in memory, never returned. */
let secrets = { service: blankSecret(), fallback: blankSecret() };

/* The last health answer, and the last mode decision, so the window can show
   both without asking again. */
let health = { at: 0, ok: false, reason: '', detail: '', model: '' };
let active = { mode: 'none', reason: '還沒判定', degraded: false, at: 0 };

/* What the studio last told us exists. See the header: a fallback that cannot
   list the vendors is not a fallback. */
let cache = { at: 0, base: '', categories: [], vendors: {}, schemas: {}, identities: {}, prompts: {} };

/* The engine the batch in progress is bound to, if there is one.

   Enforced here rather than left to the window, because the damage from mixing
   is silent and permanent: rows produced by two engines have different column
   sets, different notions of which fields are mandatory and different naming
   rules, and once they are in one spreadsheet nothing on the page says which
   row came from where. A renderer is the layer most likely to grow a code path
   that alternates by accident, so the refusal lives on this side of the bridge
   where no amount of window code can talk its way past it. */
let batch = null;   // { token, which, at }

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function blankSecret() { return { key: '', headers: [] }; }
function isBackend(w) { return BACKENDS.indexOf(w) >= 0; }

function requireBackend(which) {
  if (!isBackend(which)) throw Object.assign(new Error('不認得的後端：' + which), { code: 'EINVAL' });
  return which;
}

/**
 * What a failed request to the studio says about the studio.
 *
 * This distinction is the whole safety of automatic fallback. "Could not reach
 * it" is a reason to use the other engine. "It answered, with 401" is a wrong
 * key, and "it answered, with 500" is a bug in the service -- failing over on
 * either would run the batch somewhere else, spend the operator's other quota,
 * and bury the fault so nobody ever fixes it. A revoked studio key would look
 * like an outage for weeks.
 */
function failureKind(e) {
  const code = e && e.code;
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT') return 'down';
  if (code === 'EREMOTE') {
    const status = Number(e && e.status) || 0;
    if (status === 401 || status === 403) return 'denied';
    if (status >= 500) return 'fault';
    return 'refused';
  }
  return 'fault';
}

/** Only an unreachable service is a reason to run the batch somewhere else. */
function canFallBackFrom(kind) { return kind === 'down'; }

/* ------------------------------------------------------------- lifecycle --- */

async function init(userDataDir) {
  confPath = path.join(userDataDir, 'extract-service.json');
  cachePath = path.join(userDataDir, 'extract-catalog.json');
  try { sealed = safeStorage.isEncryptionAvailable(); } catch { sealed = false; }
  conf = clone(DEFAULTS);
  secrets = { service: blankSecret(), fallback: blankSecret() };
  health = { at: 0, ok: false, reason: '', detail: '', model: '' };
  active = { mode: 'none', reason: '還沒判定', degraded: false, at: 0 };

  try {
    const raw = JSON.parse(await fs.readFile(confPath, 'utf8'));
    if (raw && typeof raw === 'object') readConf(raw);
  } catch {
    conf = clone(DEFAULTS);
  }
  try {
    const raw = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (raw && typeof raw === 'object') {
      cache = {
        at: Number(raw.at) || 0,
        base: String(raw.base || ''),
        categories: Array.isArray(raw.categories) ? raw.categories.map(String) : [],
        vendors: raw.vendors && typeof raw.vendors === 'object' ? raw.vendors : {},
        schemas: raw.schemas && typeof raw.schemas === 'object' ? raw.schemas : {},
        identities: raw.identities && typeof raw.identities === 'object' ? raw.identities : {},
        prompts: raw.prompts && typeof raw.prompts === 'object' ? raw.prompts : {}
      };
    }
  } catch { /* no catalogue yet; the first successful connection writes one */ }

  return state();
}

/**
 * Read a settings file, including one written by the version that had a single
 * exclusive mode.
 *
 * The old shape was `{mode: 'service'|'gemini', base, model, auth, secrets}`.
 * Somebody who configured that should not have to type their key again, and --
 * more to the point -- should not end up with a machine that silently has no
 * backend at all because the file no longer parses into anything.
 */
function readConf(raw) {
  if (raw.service || raw.fallback) {
    if (raw.prefer === 'service' || raw.prefer === 'fallback') conf.prefer = raw.prefer;
    if (typeof raw.autoFallback === 'boolean') conf.autoFallback = raw.autoFallback;
    if (typeof raw.deliver === 'string' && raw.deliver.trim()) conf.deliver = raw.deliver.trim();
    if (typeof raw.owner === 'string') conf.owner = raw.owner.slice(0, 60);
    BACKENDS.forEach((w) => { readBackend(w, raw[w]); });
    readSecrets(raw.secrets);
    return;
  }

  // The v1 file. Its one backend becomes whichever of the two it actually was.
  const which = raw.mode === 'gemini' ? 'fallback' : 'service';
  readBackend(which, raw);
  conf.prefer = which === 'service' ? 'service' : 'fallback';
  const old = decryptSecrets(raw.secrets);
  if (old && (old.key || (old.headers || []).length)) {
    secrets[which] = { key: String(old.key || ''), headers: Array.isArray(old.headers) ? old.headers : [] };
  }
}

function readBackend(which, raw) {
  if (!raw || typeof raw !== 'object') return;
  const b = conf[which];
  if (typeof raw.base === 'string' && raw.base) b.base = raw.base;
  if (which === 'fallback' && typeof raw.model === 'string' && raw.model) b.model = raw.model;
  if (AUTH_KINDS.indexOf(raw.auth) >= 0) b.auth = raw.auth;
  if (typeof raw.label === 'string' && raw.label.trim()) b.label = raw.label.trim().slice(0, 60);
}

function decryptSecrets(blob) {
  if (!blob || !sealed) return null;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(blob, 'base64'))) || null;
  } catch {
    /* Written under a different OS user or on another machine. Losing the
       credentials is the correct outcome; guessing is not. */
    return null;
  }
}

function readSecrets(blob) {
  const got = decryptSecrets(blob);
  if (!got) return;
  BACKENDS.forEach((w) => {
    const s = got[w];
    if (!s || typeof s !== 'object') return;
    secrets[w] = {
      key: typeof s.key === 'string' ? s.key : '',
      headers: Array.isArray(s.headers) ? s.headers : []
    };
  });
}

/**
 * Config in the clear, secrets in one encrypted blob.
 *
 * If the platform has no keychain, nothing sensitive is written at all and the
 * caller is told. A silent plaintext fallback would be worse than refusing: the
 * user would believe a promise this file did not keep.
 */
async function save() {
  if (!confPath) return { saved: false, reason: 'not initialised' };
  const payload = {
    prefer: conf.prefer,
    autoFallback: conf.autoFallback,
    deliver: conf.deliver,
    owner: conf.owner,
    service: clone(conf.service),
    fallback: clone(conf.fallback)
  };
  const any = BACKENDS.some((w) => secrets[w].key || secrets[w].headers.length);
  if (any) {
    if (sealed) payload.secrets = safeStorage.encryptString(JSON.stringify(secrets)).toString('base64');
    else payload.secretsRefused = 'no OS keychain available; kept in memory for this session only';
  }
  try {
    await fs.mkdir(path.dirname(confPath), { recursive: true });
    await fs.writeFile(confPath, JSON.stringify(payload, null, 2), 'utf8');
    return { saved: true, sealed: sealed };
  } catch (e) {
    return { saved: false, reason: e.message };
  }
}

/* ----------------------------------------------------------------- state --- */

/**
 * What the shell may know.
 *
 * Header names but never header values, for the same reason the core model
 * reports `headerNames`: the name is how a person recognises the row they added,
 * and the value is the credential.
 */
function state() {
  const one = (w) => ({
    base: conf[w].base,
    model: w === 'fallback' ? conf[w].model : undefined,
    auth: conf[w].auth,
    label: conf[w].label,
    hasKey: !!secrets[w].key,
    headerNames: secrets[w].headers.map((r) => r.name),
    configured: ready(w)
  });
  return {
    prefer: conf.prefer,
    autoFallback: conf.autoFallback,
    deliver: conf.deliver,
    owner: conf.owner,
    service: one('service'),
    fallback: one('fallback'),
    sealed: sealed,
    active: clone(active),
    batch: batchState(),
    health: { ok: health.ok, at: health.at, reason: health.reason, detail: health.detail, model: health.model },
    catalog: {
      at: cache.at,
      base: cache.base,
      categories: cache.categories.slice(),
      prompts: Object.keys(cache.prompts || {})
    },
    authKinds: AUTH_KINDS.slice(),
    defaults: { base: GEMINI_BASE, model: GEMINI_MODEL, deliver: DELIVER_DEFAULT }
  };
}

/** Enough set up to actually send a document to this backend? */
function ready(which) {
  if (!isBackend(which)) return false;
  const b = conf[which];
  if (!b.base) return false;
  if (which === 'fallback' && !b.model) return false;
  if (b.auth !== 'none' && !secrets[which].key) return false;
  return true;
}

/* ------------------------------------------------------------ validation --- */

/** http or https and a real host. Loopback and private addresses are fine; see the header. */
function validateBase(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let u;
  try {
    u = new URL(text);
  } catch {
    throw Object.assign(new Error('服務位址格式不對，要像 http://127.0.0.1:8000'), { code: 'EINVAL' });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error('服務位址只接受 http 或 https'), { code: 'EPROTO' });
  }
  if (!u.hostname) {
    throw Object.assign(new Error('服務位址少了主機名稱'), { code: 'EINVAL' });
  }
  // Keep origin and any path prefix, drop query and hash: this is a base, not a request.
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** A model name, not a path: no slashes, so it cannot reshape the request URL. */
function validateModel(raw) {
  const text = String(raw || '').trim().replace(/^models\//, '');
  if (!text) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(text)) {
    throw Object.assign(new Error('模型名稱只能有英數字與 . _ -，例如 gemini-2.5-pro'), { code: 'EINVAL' });
  }
  return text;
}

/** A sandbox path template. Validated here so a bad one is refused at save time. */
function validateDeliver(raw) {
  const text = String(raw || '').trim();
  if (!text) return DELIVER_DEFAULT;
  if (text.charAt(0) !== '/') {
    throw Object.assign(new Error('交付路徑要從 / 開始，例如 ' + DELIVER_DEFAULT), { code: 'EINVAL' });
  }
  if (text.indexOf('..') >= 0 || /[\\:*?"<>|]/.test(text)) {
    throw Object.assign(new Error('交付路徑裡有不能用的字元'), { code: 'EINVAL' });
  }
  return text.replace(/\/+$/, '') || '/';
}

/* --------------------------------------------------------- configuration --- */

/**
 * Change one backend's settings, or the settings that are not a backend's.
 *
 * `which` is 'service', 'fallback', or null for the shared ones (which backend
 * is preferred, whether to fall back automatically, where documents are filed,
 * and the name this machine gives the studio for its batches).
 */
async function configure(which, patch = {}) {
  if (which === null || which === undefined) {
    if (patch.prefer === 'service' || patch.prefer === 'fallback') conf.prefer = patch.prefer;
    if (typeof patch.autoFallback === 'boolean') conf.autoFallback = patch.autoFallback;
    if (patch.deliver !== undefined) conf.deliver = validateDeliver(patch.deliver);
    if (typeof patch.owner === 'string') conf.owner = patch.owner.trim().slice(0, 60);
  } else {
    requireBackend(which);
    const b = conf[which];
    if (patch.base !== undefined) {
      const next = validateBase(patch.base);
      if (which === 'service' && next !== b.base) invalidate('位址改過了');
      b.base = next;
    }
    if (which === 'fallback' && patch.model !== undefined) b.model = validateModel(patch.model);
    if (patch.auth !== undefined) {
      if (AUTH_KINDS.indexOf(patch.auth) < 0) throw new Error('不認得的驗證方式：' + patch.auth);
      b.auth = patch.auth;
      if (which === 'service') invalidate('驗證方式改過了');
    }
    if (typeof patch.label === 'string' && patch.label.trim()) b.label = patch.label.trim().slice(0, 60);
    if (which === 'fallback' && !b.base) b.base = GEMINI_BASE;
  }
  const wrote = await save();
  return Object.assign(state(), { persisted: wrote });
}

/**
 * Store one backend's API key and/or custom header list.
 *
 * A key of '' means "leave the stored one alone" rather than "clear it", so a
 * form can be submitted again without retyping the secret. Clearing is
 * forgetSecret, which is a separate and explicit act.
 */
async function setSecret(which, payload = {}) {
  requireBackend(which);
  const s = secrets[which];
  if (typeof payload.key === 'string' && payload.key.trim()) {
    s.key = payload.key.trim();
    if (which === 'service') invalidate('金鑰改過了');
  }
  if (Array.isArray(payload.headers)) {
    const before = {};
    s.headers.forEach((r) => { before[r.name] = r.value; });
    s.headers = payload.headers
      .filter((r) => r && String(r.name || '').trim())
      .slice(0, MAX_HEADERS)
      .map((r) => {
        const name = String(r.name).trim();
        // A header name is a token; a newline in one is request splitting.
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error('表頭名稱不合法：' + name);
        let value = String(r.value == null ? '' : r.value).replace(/[\r\n]/g, '').slice(0, 4000);
        /* A blank value means "leave the stored one alone", the same as a blank
           API key. The form cannot show these back -- they never leave this
           process -- so submitting it again would otherwise wipe every value the
           user could not see. Deleting a header is removing its row. */
        if (!value && before[name] !== undefined) value = before[name];
        return { name: name, value: value };
      });
    if (which === 'service') invalidate('表頭改過了');
  }
  const wrote = await save();
  return Object.assign(state(), { persisted: wrote });
}

async function forgetSecret(which) {
  requireBackend(which);
  secrets[which] = blankSecret();
  if (which === 'service') invalidate('金鑰清掉了');
  const wrote = await save();
  return Object.assign(state(), { persisted: wrote });
}

/**
 * The headers for an outgoing request to ONE backend.
 *
 * Takes the backend by name rather than reading a current mode, so there is no
 * arrangement in which the fallback model's key can be addressed to the studio
 * or the other way round. Custom headers are applied last, so a gateway's own
 * rule wins over the auth kind's guess.
 */
function headersOf(which, extra) {
  requireBackend(which);
  const h = Object.assign({}, extra || {});
  const b = conf[which];
  const key = secrets[which].key;
  if (key) {
    if (b.auth === 'apikey') h['X-API-Key'] = key;
    else if (b.auth === 'goog') h['x-goog-api-key'] = key;
    else if (b.auth === 'bearer') h.Authorization = 'Bearer ' + key;
  }
  secrets[which].headers.forEach((row) => {
    if (row && row.name) h[String(row.name)] = String(row.value == null ? '' : row.value);
  });
  return h;
}

/* ------------------------------------------------------- what may be asked --- */

/**
 * The studio paths this machine is allowed to reach, split by what they do.
 *
 * Two jobs. The first is containment: the renderer names a path, and without
 * a list it could name any path on the studio host. The second is telling
 * asking apart from giving, which decides what needs the capability.
 *
 * A poll is not a document leaving. One batch of forty PDFs is one upload and
 * then several hundred two-second polls, and putting those behind the same
 * gate as the upload means an operator who set doc.extract to ASK gets a
 * dialog every two seconds, each one claiming a document is being sent. So
 * reads go through ungated -- they carry nothing out but the fact that this
 * machine is asking -- and everything that carries content answers to
 * doc.extract.
 *
 * The last two READS are for endpoints that do not exist yet. The studio is
 * growing a way to hand over its whole catalogue, prompts included, so that a
 * machine can work offline; they are listed now so that landing them is a
 * change to one service and not to this one as well. A 404 from either is
 * handled as "this studio is an older one", not as a failure.
 */
const STUDIO_READS = [
  /^\/health$/,
  /^\/categories$/,
  /^\/categories\/[^/]+\/vendors$/,
  /^\/categories\/[^/]+\/schema$/,
  /^\/categories\/[^/]+\/vendors\/[^/]+\/schema$/,
  /^\/categories\/[^/]+\/identities$/,
  /^\/jobs$/,
  /^\/jobs\/[^/]+$/,
  /^\/jobs\/[^/]+\/result$/,
  /^\/categories\/[^/]+\/vendors\/[^/]+\/prompt$/,   // reserved, see above
  /^\/catalog$/                                        // reserved, see above
];

/** Paths that carry a document, or something derived from one, out of here. */
const STUDIO_WRITES = [
  /^\/classify$/,
  /^\/jobs$/,
  /^\/jobs\/[^/]+\/retry$/,
  /^\/jobs\/[^/]+\/package\/preview$/
];

/**
 * Is this request a read, a write, or something this machine does not make?
 *
 * Returns "read", "write", or null. Null is not an error to explain away: it
 * is a path nothing in this program asks for, which means whoever asked is
 * not this program working normally.
 */
function classifyRequest(method, rawPath) {
  const m = String(method || 'GET').toUpperCase();
  const path = String(rawPath || '').split('?')[0];
  if (m === 'GET') return STUDIO_READS.some((re) => re.test(path)) ? 'read' : null;
  if (m === 'POST') return STUDIO_WRITES.some((re) => re.test(path)) ? 'write' : null;
  return null;
}

/* ------------------------------------------------------------- transport --- */

/** A request path: absolute within the service, with nothing that could leave it. */
function joinPath(raw) {
  if (!conf.service.base) {
    throw Object.assign(new Error('還沒設定工作室的端點位址'), { code: 'ENOCONF' });
  }
  const p = String(raw || '');
  if (!p.startsWith('/')) {
    throw Object.assign(new Error('請求路徑要以 / 開頭'), { code: 'EINVAL' });
  }
  if (p.includes('://') || p.includes('..') || /[\r\n]/.test(p)) {
    throw Object.assign(new Error('請求路徑不合法'), { code: 'EINVAL' });
  }
  return conf.service.base + p;
}

/** A multipart body built here, because the file bytes arrive as base64 over the bridge. */
function multipart(fields, files) {
  const boundary = '----aios' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const chunks = [];
  Object.keys(fields || {}).forEach((name) => {
    const value = fields[name];
    if (value === undefined || value === null) return;
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  });
  (files || []).forEach((f) => {
    const body = Buffer.from(String(f.base64 || ''), 'base64');
    const name = String(f.field || 'files');
    const filename = String(f.filename || 'file.pdf').replace(/["\r\n]/g, '');
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
      `Content-Type: ${String(f.type || 'application/pdf').replace(/[\r\n]/g, '')}\r\n\r\n`, 'utf8'));
    chunks.push(body);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  });
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), type: 'multipart/form-data; boundary=' + boundary };
}

/** The service's own words for a failure, dug out of whatever shape it used. */
function remoteMessage(buf, type, status) {
  let detail = buf.toString('utf8').slice(0, 4000);
  if (/json/i.test(type)) {
    try {
      const parsed = JSON.parse(detail);
      // FastAPI says `detail`; Google says `error.message`.
      let d = parsed.detail !== undefined ? parsed.detail
        : (parsed.error && parsed.error.message !== undefined ? parsed.error.message : detail);
      if (Array.isArray(d)) d = d.map((x) => String(x && x.msg ? x.msg : x)).join('; ');
      detail = d;
    } catch { /* not JSON after all; the text is the message */ }
  }
  return String(detail || ('服務回應 ' + status));
}

async function request(url, opts = {}) {
  const ctl = new AbortController();
  const body = opts.body || null;
  const limit = Number(opts.timeout) > 0 ? Number(opts.timeout) : (body ? TIMEOUT_UPLOAD : TIMEOUT_READ);
  const timer = setTimeout(() => ctl.abort(), limit);
  let res;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body,
      signal: ctl.signal,
      redirect: 'error'
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') {
      throw Object.assign(new Error('回應逾時（等了 ' + Math.round(limit / 1000) + ' 秒）'), { code: 'ETIMEDOUT' });
    }
    throw Object.assign(new Error(
      '連不上（' + (opts.what || url) + '）：' + (e && e.message ? e.message : '無法連線')
    ), { code: 'ECONNREFUSED' });
  }
  clearTimeout(timer);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_RESPONSE) {
    throw Object.assign(new Error('回傳的內容太大'), { code: 'E2BIG' });
  }
  const type = res.headers.get('content-type') || '';
  if (res.status >= 400) {
    throw Object.assign(new Error(remoteMessage(buf, type, res.status)), { code: 'EREMOTE', status: res.status });
  }
  if (opts.binary) return { status: res.status, base64: buf.toString('base64'), type };
  if (!buf.length) return { status: res.status, json: null };
  try {
    return { status: res.status, json: JSON.parse(buf.toString('utf8')) };
  } catch {
    throw Object.assign(new Error('回傳的不是 JSON'), { code: 'EPROTO' });
  }
}

/* --------------------------------------------------------------- service --- */

/**
 * One request to the prompt studio.
 *
 * `spec` is `{ method, path, query, json, fields, files, binary, timeout }`. The
 * caller supplies a path and a payload; the destination is this module's own
 * business.
 *
 * A transport failure marks the health answer stale, so the next `resolve()`
 * finds out rather than trusting a reading from before the service went away.
 */
async function call(spec = {}) {
  /* The health check is exempt: it carries nothing, and a fallback batch still
     wants to know when the studio comes back. */
  if (!spec.skipBatchCheck) requireBatch('service');
  if (!conf.service.base) {
    throw Object.assign(new Error('還沒設定工作室的端點位址（請在「文件萃取」程式裡按「連線設定」）'), { code: 'ENOCONF' });
  }
  let url = joinPath(spec.path);
  if (spec.query && typeof spec.query === 'object') {
    const q = new URLSearchParams();
    Object.keys(spec.query).forEach((k) => {
      const v = spec.query[k];
      if (v !== undefined && v !== null) q.append(k, String(v));
    });
    const text = q.toString();
    if (text) url += (url.includes('?') ? '&' : '?') + text;
  }

  let body = null;
  let type = '';
  if (spec.files && spec.files.length) {
    const part = multipart(spec.fields, spec.files);
    if (part.body.length > MAX_UPLOAD) {
      throw Object.assign(new Error('這批檔案太大（上限 '
        + Math.floor(MAX_UPLOAD / 1048576) + ' MiB），請分批送'), { code: 'E2BIG' });
    }
    body = part.body;
    type = part.type;
  } else if (spec.json !== undefined) {
    body = Buffer.from(JSON.stringify(spec.json), 'utf8');
    type = 'application/json';
  } else if (spec.fields) {
    const form = new URLSearchParams();
    Object.keys(spec.fields).forEach((k) => form.append(k, String(spec.fields[k])));
    body = Buffer.from(form.toString(), 'utf8');
    type = 'application/x-www-form-urlencoded';
  }

  try {
    return await request(url, {
      method: String(spec.method || 'GET').toUpperCase(),
      headers: headersOf('service', type ? { 'Content-Type': type } : {}),
      body,
      timeout: Number(spec.timeout) || 0,
      binary: !!spec.binary,
      what: conf.service.label + '（' + conf.service.base + '）'
    });
  } catch (e) {
    /* Only a failure to reach it says anything about health. A 422 from a bad
       argument means the service is alive and answered. */
    if (e && (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT')) invalidate(e.message);
    throw e;
  }
}

/* -------------------------------------------------------------- fallback --- */

/**
 * The response shape asked of the fallback model: rows, every value a string.
 *
 * Strings all the way through, and this is not laziness. A part number is
 * 0012345 and a heat number is 0800; read as numbers they become 12345 and 800,
 * and the spreadsheet no longer matches the document it came from. The studio's
 * own exporter writes every cell as text for exactly this reason, so asking the
 * model for text keeps one rule instead of two.
 */
function rowSchema(columns) {
  const properties = {};
  (columns || []).forEach((c) => {
    properties[String(c)] = { type: 'string', description: String(c) };
  });
  return {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: { type: 'object', properties, required: Object.keys(properties) }
      }
    },
    required: ['rows']
  };
}

/**
 * Send one document to the fallback model with a locally-kept prompt.
 *
 * `job` is `{ base64, filename, mimeType, prompt, columns, temperature }`.
 * Returns `{ rows, usage, model, finish, truncated }`.
 */
async function generate(job = {}) {
  requireBatch('fallback');
  const b = conf.fallback;
  if (!b.base || !b.model) {
    throw Object.assign(new Error('還沒設定備援模型（請在「文件萃取」程式裡按「連線設定」）'), { code: 'ENOCONF' });
  }
  if (b.auth !== 'none' && !secrets.fallback.key) {
    throw Object.assign(new Error('還沒設定備援模型的 API 金鑰（請在「文件萃取」程式裡按「連線設定」）'), { code: 'ENOKEY' });
  }

  const data = String(job.base64 || '');
  if (!data) throw Object.assign(new Error('沒有文件內容可以送出'), { code: 'EINVAL' });
  const bytes = Math.floor(data.length * 3 / 4);
  if (bytes > MAX_INLINE) {
    throw Object.assign(new Error(
      `「${job.filename || '這份文件'}」有 ${(bytes / 1048576).toFixed(1)} MiB，` +
      `超過單次直送的 ${Math.floor(MAX_INLINE / 1048576)} MiB 上限。請先用 PDF 工具拆頁再送。`
    ), { code: 'E2BIG' });
  }

  const prompt = String(job.prompt || '').trim();
  if (!prompt) {
    throw Object.assign(new Error('這個備援設定沒有提示詞，模型不知道要抓什麼'), { code: 'EINVAL' });
  }

  const columns = Array.isArray(job.columns) ? job.columns.map(String).filter(Boolean) : [];
  const body = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: String(job.mimeType || 'application/pdf'), data: data } },
        { text: prompt }
      ]
    }],
    generationConfig: {
      /* Zero, because this is transcription and not composition. The same
         document parsed twice has to give the same rows, or reconciling a
         delivery note against an invoice becomes guesswork. */
      temperature: Number(job.temperature) >= 0 ? Number(job.temperature) : 0,
      responseMimeType: 'application/json'
    }
  };
  if (columns.length) body.generationConfig.responseSchema = rowSchema(columns);

  const out = await request(b.base + '/v1beta/models/' + b.model + ':generateContent', {
    method: 'POST',
    /* The key as a header, never in the query string: a URL travels into proxy
       logs and crash reports, and a header does not. */
    headers: headersOf('fallback', { 'Content-Type': 'application/json' }),
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    timeout: TIMEOUT_UPLOAD,
    what: b.label + '（' + b.model + '）'
  });

  return Object.assign(readCandidate(out.json), { model: b.model });
}

/**
 * Pull the rows out of a generateContent reply.
 *
 * Kept separate from the request so it can be tested without a network, and
 * because every branch here is a real reply the API sends: a refusal with no
 * candidate at all, a candidate cut off at the token limit, and text that is
 * JSON with a code fence around it despite responseMimeType.
 */
function readCandidate(reply) {
  const r = reply || {};
  if (r.promptFeedback && r.promptFeedback.blockReason) {
    throw Object.assign(new Error('模型拒絕處理這份文件：' + r.promptFeedback.blockReason), { code: 'EBLOCKED' });
  }
  const cand = (r.candidates || [])[0];
  if (!cand) throw Object.assign(new Error('模型沒有回傳任何結果'), { code: 'EEMPTY' });

  const finish = String(cand.finishReason || '');
  const text = ((cand.content && cand.content.parts) || [])
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('');

  if (!text.trim()) {
    if (finish === 'MAX_TOKENS') {
      throw Object.assign(new Error('這份文件的結果超過模型單次輸出上限，請拆頁後再送'), { code: 'E2BIG' });
    }
    throw Object.assign(new Error('模型回傳空白的結果' + (finish ? '（' + finish + '）' : '')), { code: 'EEMPTY' });
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch {
    if (finish === 'MAX_TOKENS') {
      throw Object.assign(new Error('模型的結果被截斷了，JSON 不完整。請拆頁後再送。'), { code: 'E2BIG' });
    }
    throw Object.assign(new Error('模型回傳的不是可讀的 JSON'), { code: 'EPROTO' });
  }

  let rows = [];
  if (Array.isArray(parsed)) rows = parsed;
  else if (parsed && Array.isArray(parsed.rows)) rows = parsed.rows;
  else if (parsed && typeof parsed === 'object') {
    // A model that answered with one bare object meant one row.
    const nested = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
    rows = nested ? parsed[nested] : [parsed];
  }

  const usage = r.usageMetadata || {};
  return {
    rows: rows.filter((x) => x && typeof x === 'object' && !Array.isArray(x)),
    finish: finish,
    truncated: finish === 'MAX_TOKENS',
    usage: {
      prompt: Number(usage.promptTokenCount) || 0,
      output: Number(usage.candidatesTokenCount) || 0,
      total: Number(usage.totalTokenCount) || 0
    }
  };
}

/** ```json ... ``` around an answer that was supposed to be bare JSON. */
function stripFence(text) {
  const s = String(text || '').trim();
  const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(s);
  return m ? m[1].trim() : s;
}

/* ------------------------------------------------------ health and mode --- */

/** Throw away the last health answer. Called whenever something makes it a lie. */
function invalidate(why) {
  health = { at: 0, ok: false, reason: String(why || ''), detail: '', model: '' };
}

/**
 * Is the studio up? Cached briefly; see HEALTH_TTL.
 *
 * Never throws. A settings pane and a mode decision both want the reason, and a
 * health check that throws would make every caller write the same try/catch.
 */
async function checkHealth(force) {
  if (!ready('service')) {
    return {
      state: 'unset', ok: false, at: 0,
      reason: conf.service.base ? '還沒設定工作室的 API 金鑰' : '還沒設定工作室的端點位址'
    };
  }
  const now = Date.now();
  if (!force && health.at && now - health.at < HEALTH_TTL) return Object.assign({}, health, { cached: true });
  try {
    const out = await call({ path: '/health', timeout: TIMEOUT_READ, skipBatchCheck: true });
    const h = (out && out.json) || {};
    /* Healthy only when it says so. Anything else -- 'starting', 'degraded', a
       body with no status at all -- is a service that is answering the door but
       is not ready to take a batch, and the right move is to block and show what
       it said rather than either submitting or running off to the other engine.
       Their own console is strict the same way. */
    const ok = String(h.status || '').toLowerCase() === 'ok';
    health = {
      at: Date.now(),
      state: ok ? 'up' : 'notready',
      ok: ok,
      reason: ok ? '' : (String(h.detail || '') || ('服務回報狀態是「' + (h.status || '空白') + '」')),
      detail: String(h.detail || ''),
      model: String((h.settings && h.settings.model && h.settings.model.model_name) || '')
    };
  } catch (e) {
    health = {
      at: Date.now(),
      state: failureKind(e),
      ok: false,
      reason: e.message,
      detail: '',
      model: ''
    };
  }
  return Object.assign({}, health);
}

/**
 * Which backend should this batch go through, and why.
 *
 * The reason is half the answer. A window that switched to the fallback without
 * saying so would produce rows from a different engine under the same heading,
 * and the operator would find out when the columns did not match.
 */
async function resolve(opts = {}) {
  const force = !!opts.force;
  const canFall = ready('fallback');

  if (conf.prefer === 'fallback') {
    if (canFall) return remember('fallback', '你把備援模型設成優先使用', false);
    // Preferring something that is not configured is not a reason to do nothing.
  }

  if (ready('service')) {
    const h = await checkHealth(force);
    if (h.ok) {
      return remember('service', '已連上' + conf.service.label + (h.model ? '（模型 ' + h.model + '）' : ''), false, h);
    }
    /* Only an unreachable studio hands the work to the other engine. A studio
       that answered -- with a wrong key, with a fault, with "still starting" --
       is a thing to stop on and repeat verbatim, because every one of those is
       fixed by a person and none of them is fixed by spending another provider's
       quota while the cause goes unreported. */
    if (!canFallBackFrom(h.state)) {
      return remember('none', reasonFor(h), false, h);
    }
    if (!conf.autoFallback) {
      return remember('none', '連不上' + conf.service.label + '：' + h.reason + '（自動改用備援是關著的）', false, h);
    }
    if (canFall) {
      return remember('fallback', '連不上' + conf.service.label + '：' + h.reason + '，這一批改用備援模型', true, h);
    }
    return remember('none', '連不上' + conf.service.label + '：' + h.reason + '，而備援模型也還沒設定', false, h);
  }

  if (canFall) {
    return remember('fallback', conf.service.base ? '工作室的金鑰還沒設定' : '還沒設定工作室端點，只有備援模型可用', true);
  }
  return remember('none', '兩邊都還沒設定。按「連線設定」填上工作室的端點與金鑰。', false);
}

/** The studio's own words about why it will not take work, in full. */
function reasonFor(h) {
  const name = conf.service.label;
  if (h.state === 'denied') return name + '拒絕了這把金鑰（' + h.reason + '）。金鑰不對或被撤銷了，這不是連線問題，所以不會改用備援。';
  if (h.state === 'fault') return name + '自己出錯了：' + h.reason + '。服務是通的，所以不會改用備援——這個要回報給工作室那邊。';
  if (h.state === 'notready') return name + '還沒準備好：' + h.reason + '。通常是模型還在載入，等一下再按「重新連線」。';
  if (h.state === 'refused') return name + '拒絕了這個請求：' + h.reason;
  return name + '連不上：' + h.reason;
}

function remember(mode, reason, degraded, h) {
  active = {
    mode: mode,
    reason: reason,
    degraded: !!degraded,
    state: (h && h.state) || (mode === 'service' ? 'up' : 'unset'),
    at: Date.now()
  };
  return Object.assign(clone(active), {
    health: { ok: health.ok, state: health.state, reason: health.reason, model: health.model, at: health.at }
  });
}

/**
 * Probe one backend on demand, for the settings pane's "test connection".
 *
 * Never throws: the pane wants the reason, and a button that turns an
 * unreachable host into an exception makes every caller write the same catch.
 */
async function probe(which) {
  requireBackend(which);
  if (!ready(which)) {
    return { ok: false, reason: conf[which].base ? '還沒設定 API 金鑰' : '還沒設定位址' };
  }
  if (which === 'service') {
    const h = await checkHealth(true);
    return { ok: h.ok, reason: h.reason, detail: h.detail, model: h.model };
  }
  try {
    const b = conf.fallback;
    const out = await request(b.base + '/v1beta/models/' + b.model, {
      headers: headersOf('fallback'), timeout: TIMEOUT_READ, what: b.label
    });
    const m = (out && out.json) || {};
    return {
      ok: true,
      model: String(m.name || b.model).replace(/^models\//, ''),
      detail: String(m.displayName || '')
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/* ----------------------------------------------------------------- batch --- */

/**
 * Bind the work that follows to one engine.
 *
 * A batch is the unit that ends up in one spreadsheet and one folder, and every
 * property that matters to the person reading it -- the columns, their order,
 * which fields were mandatory, how the files were named, which bin a doubtful
 * document lands in -- differs between the two engines. Mixing them produces a
 * result that is wrong in a way nothing on the page admits to.
 *
 * So the engine is chosen once, here, and the other one refuses to run until
 * the batch is closed. `resolve()` may change its mind about which engine is
 * available at any time; this is what stops that from reaching a batch that is
 * already under way.
 */
function beginBatch(which) {
  requireBackend(which);
  batch = {
    token: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    which: which,
    at: Date.now()
  };
  return { token: batch.token, which: which, at: batch.at };
}

function endBatch(token) {
  const had = batch;
  if (batch && (!token || batch.token === token)) batch = null;
  return { ended: !!had, open: !!batch };
}

function batchState() { return batch ? clone(batch) : null; }

function requireBatch(which) {
  if (!batch || batch.which === which) return;
  throw Object.assign(new Error(
    '這一批已經綁在' + (batch.which === 'service' ? conf.service.label : conf.fallback.label) +
    '上了，中途不能換引擎。要換請先結束這一批。'
  ), { code: 'EMIXED' });
}

/* ------------------------------------------------------------- catalogue --- */

/**
 * Remember what the studio said exists.
 *
 * Not a performance cache. Its job is that a machine which cannot reach the
 * studio can still show the operator which categories and vendors there are and
 * what columns each produces, so the fallback is a usable path rather than a
 * blank window. Stamped with the base it came from, so pointing the program at
 * a different studio does not silently serve the old one's lists.
 */
async function saveCatalog(patch = {}) {
  const base = conf.service.base;
  if (cache.base && cache.base !== base) {
    cache = { at: 0, base: base, categories: [], vendors: {}, schemas: {}, identities: {}, prompts: {} };
  }
  cache.base = base;
  cache.at = Date.now();
  if (Array.isArray(patch.categories)) cache.categories = patch.categories.map(String);
  if (patch.vendors && typeof patch.vendors === 'object') Object.assign(cache.vendors, patch.vendors);
  if (patch.schemas && typeof patch.schemas === 'object') Object.assign(cache.schemas, patch.schemas);
  if (patch.identities && typeof patch.identities === 'object') Object.assign(cache.identities, patch.identities);
  /* Prompts, when the studio is willing to hand them out. It is not obliged to,
     and the API as it stands does not -- so this is written opportunistically
     and the fallback says plainly which vendors it can and cannot cover. */
  if (patch.prompts && typeof patch.prompts === 'object') Object.assign(cache.prompts, patch.prompts);
  try {
    if (cachePath) await fs.writeFile(cachePath, JSON.stringify(cache, null, 2), 'utf8');
    return { saved: true };
  } catch (e) {
    return { saved: false, reason: e.message };
  }
}

/** Everything the studio has told us, for a window that cannot ask it now. */
function catalog() {
  return clone(cache);
}

module.exports = {
  init, state, ready, configure, setSecret, forgetSecret, headersOf,
  call, generate, probe, resolve, checkHealth, invalidate,
  saveCatalog, catalog,
  classifyRequest, STUDIO_READS, STUDIO_WRITES,
  beginBatch, endBatch, batchState, failureKind, canFallBackFrom, reasonFor,
  validateBase, validateModel, validateDeliver, joinPath, multipart,
  rowSchema, readCandidate, stripFence,
  GEMINI_BASE, GEMINI_MODEL, DELIVER_DEFAULT, MAX_INLINE, MAX_UPLOAD, AUTH_KINDS, BACKENDS, HEALTH_TTL
};
