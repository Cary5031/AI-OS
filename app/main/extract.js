'use strict';

/* ===========================================================================
   AI-OS // document extraction backend
   ---------------------------------------------------------------------------
   Turning a PDF into rows. Two ways to do it, one configuration, one key store.

     gemini   the PDF itself goes to a cloud model, together with the vendor's
              extraction prompt. This is the mode that works.
     service  an extraction API the user already runs (their own operator
              console's backend), which does the same thing behind its own key.

   WHY THE PDF GOES WHOLE, AND NOT AS TEXT

   This machine can already read a PDF into text -- main/pdf.js does it, and
   renderer/pdfmd.js does it well enough to produce Markdown with tables. Feeding
   that text to a model is the obvious cheap path and it is the wrong one: the
   numbers in a delivery note or an invoice live in a layout, and flattening the
   layout destroys the association between a part number and the quantity sitting
   in the same visual row. Tried against real documents, measured, worse. So the
   bytes go as bytes and the model does its own page reading.

   That also means this is a different model from the one the machine thinks
   with -- chosen for document reading rather than for conversation -- with its
   own endpoint, its own key and its own settings pane.

   CONFIGURED THE WAY A CUSTOM MODEL IS CONFIGURED

   Base address, model name, auth kind, API key, and a list of custom headers,
   exactly as llama.js's `custom` provider takes them, because that is the form
   the user already knows and because a service behind a gateway needs a header
   nobody can predict. Key and headers are encrypted together in one blob: a
   header value is exactly where a person puts a token, and encrypting the key
   while writing `X-Api-Key: sk-...` beside it in plaintext would be theatre.

   THE KEY

   `state()` reports whether a key exists and what the custom headers are
   *called*. There is no getter for any secret value anywhere in this module, on
   purpose.

   THE ADDRESS

   In `service` mode the caller passes a path -- `/jobs` -- and this joins it
   onto the configured base. No argument anywhere lets a caller choose a host, so
   a renderer, or a plan that an untrusted document talked its way into, cannot
   point this at somewhere else. That is a stronger promise than checking a URL
   against a list, because there is no URL to check. In `gemini` mode there is no
   caller-supplied path at all: the request is built here from the model name.

   WHY LOOPBACK IS ALLOWED HERE AND NOT IN web.js

   web.js refuses loopback and private addresses, and should: it fetches
   addresses that arrive inside content or inside a plan, and "read this page for
   me" must not become a way to probe the network this machine sits on. This is
   the other case -- one address a person typed into a settings pane, which is
   where their own extraction service actually runs. The same distinction the
   machine already makes for the core model, which talks to 127.0.0.1 because the
   user configured it and not because the guard has a hole.
   =========================================================================== */

const fs = require('node:fs/promises');
const path = require('node:path');
const { safeStorage } = require('electron');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const GEMINI_MODEL = 'gemini-2.5-pro';

/* How the key is presented. `goog` is Google's own header, `bearer` is every
   OpenAI-compatible host, `apikey` is what their operator console's backend
   wants, and `none` is for a gateway where the credential is a custom header
   instead. */
const AUTH_KINDS = ['goog', 'bearer', 'apikey', 'none'];

const DEFAULTS = {
  mode: 'gemini',
  base: GEMINI_BASE,
  model: GEMINI_MODEL,
  auth: 'goog',
  label: '文件萃取模型'
};

/* Their own console waits five minutes on an upload and thirty seconds on
   everything else. A document model reading twenty pages is slower than a chat
   turn, and the wait is the normal case rather than a symptom. */
const TIMEOUT_READ = 30 * 1000;
const TIMEOUT_UPLOAD = 300 * 1000;

/* Gemini counts the whole serialised request against its inline limit, and
   base64 is four bytes for every three. 14 MiB of PDF is about 19 MiB on the
   wire, which is as close to the 20 MiB ceiling as is worth going. A scanned
   book does not fit, and should be told so rather than silently half-fit. */
const MAX_INLINE = 14 * 1024 * 1024;
const MAX_UPLOAD = 64 * 1024 * 1024;
const MAX_RESPONSE = 64 * 1024 * 1024;

const MAX_HEADERS = 20;

let confPath = null;
let sealed = false;
let conf = { ...DEFAULTS };

/* The key and the custom header values. Decrypted, in memory, never returned. */
let secrets = { key: '', headers: [] };

async function init(userDataDir) {
  confPath = path.join(userDataDir, 'extract-service.json');
  try { sealed = safeStorage.isEncryptionAvailable(); } catch { sealed = false; }
  conf = { ...DEFAULTS };
  secrets = { key: '', headers: [] };
  try {
    const raw = JSON.parse(await fs.readFile(confPath, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (raw.mode === 'service' || raw.mode === 'gemini') conf.mode = raw.mode;
      if (typeof raw.base === 'string' && raw.base) conf.base = raw.base;
      if (typeof raw.model === 'string' && raw.model) conf.model = raw.model;
      if (AUTH_KINDS.includes(raw.auth)) conf.auth = raw.auth;
      if (typeof raw.label === 'string' && raw.label.trim()) conf.label = raw.label.trim().slice(0, 60);
      if (raw.secrets && sealed) {
        try {
          const s = JSON.parse(safeStorage.decryptString(Buffer.from(raw.secrets, 'base64'))) || {};
          secrets.key = typeof s.key === 'string' ? s.key : '';
          secrets.headers = Array.isArray(s.headers) ? s.headers : [];
        } catch {
          /* Written under a different OS user or on another machine. Losing the
             credentials is the correct outcome; guessing is not. */
          secrets = { key: '', headers: [] };
        }
      }
    }
  } catch {
    conf = { ...DEFAULTS };
  }
  return state();
}

/**
 * What the shell may know: the mode, the address, the model, the auth kind,
 * whether a key exists, and what the custom headers are called.
 *
 * Header names but never header values, for the same reason the core model
 * reports `headerNames`: the name is how a person recognises the row they added,
 * and the value is the credential.
 */
function state() {
  return {
    mode: conf.mode,
    base: conf.base,
    model: conf.model,
    auth: conf.auth,
    label: conf.label,
    hasKey: !!secrets.key,
    headerNames: (secrets.headers || []).map((r) => r.name),
    sealed: sealed,
    configured: ready(),
    authKinds: AUTH_KINDS.slice(),
    defaults: { base: GEMINI_BASE, model: GEMINI_MODEL }
  };
}

/** Enough set up to actually send a document? */
function ready() {
  if (!conf.base) return false;
  if (conf.mode === 'gemini' && !conf.model) return false;
  if (conf.auth !== 'none' && !secrets.key) return false;
  return true;
}

/** http or https and a real host. Loopback and private addresses are fine; see the header. */
function validateBase(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let u;
  try {
    u = new URL(text);
  } catch {
    throw Object.assign(new Error('服務位址格式不對，要像 https://generativelanguage.googleapis.com'), { code: 'EINVAL' });
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

/**
 * Config in the clear, secrets in one encrypted blob.
 *
 * If the platform has no keychain, nothing sensitive is written at all and the
 * caller is told. A silent plaintext fallback would be worse than refusing: the
 * user would believe a promise this file did not keep.
 */
async function save() {
  if (!confPath) return { saved: false, reason: 'not initialised' };
  const payload = { mode: conf.mode, base: conf.base, model: conf.model, auth: conf.auth, label: conf.label };
  if (secrets.key || (secrets.headers || []).length) {
    if (sealed) {
      payload.secrets = safeStorage.encryptString(JSON.stringify(secrets)).toString('base64');
    } else {
      payload.secretsRefused = 'no OS keychain available; kept in memory for this session only';
    }
  }
  try {
    await fs.mkdir(path.dirname(confPath), { recursive: true });
    await fs.writeFile(confPath, JSON.stringify(payload, null, 2), 'utf8');
    return { saved: true, sealed: sealed };
  } catch (e) {
    return { saved: false, reason: e.message };
  }
}

/**
 * Set the mode, address, model, auth kind and display name.
 *
 * Switching to gemini with no address of its own fills in Google's, because a
 * settings pane that demands a URL nobody has memorised is one people give up
 * on. Switching to service does not guess -- there is nothing to guess.
 */
async function configure(patch = {}) {
  if (patch.mode === 'gemini' || patch.mode === 'service') {
    const changed = conf.mode !== patch.mode;
    conf.mode = patch.mode;
    if (changed && patch.base === undefined) conf.base = patch.mode === 'gemini' ? GEMINI_BASE : '';
    if (changed && patch.auth === undefined) conf.auth = patch.mode === 'gemini' ? 'goog' : 'apikey';
  }
  if (patch.base !== undefined) conf.base = validateBase(patch.base);
  if (patch.model !== undefined) conf.model = validateModel(patch.model);
  if (patch.auth !== undefined) {
    if (!AUTH_KINDS.includes(patch.auth)) throw new Error('不認得的驗證方式：' + patch.auth);
    conf.auth = patch.auth;
  }
  if (typeof patch.label === 'string' && patch.label.trim()) conf.label = patch.label.trim().slice(0, 60);
  if (conf.mode === 'gemini' && !conf.base) conf.base = GEMINI_BASE;
  const wrote = await save();
  return Object.assign(state(), { persisted: wrote });
}

/**
 * Store an API key and/or a custom header list.
 *
 * A key of '' means "leave the stored one alone" rather than "clear it", so a
 * form can be submitted again without retyping the secret. Clearing is
 * forgetSecret, which is a separate and explicit act.
 */
async function setSecret(payload = {}) {
  if (typeof payload.key === 'string' && payload.key.trim()) secrets.key = payload.key.trim();
  if (Array.isArray(payload.headers)) {
    const before = {};
    (secrets.headers || []).forEach((r) => { before[r.name] = r.value; });
    secrets.headers = payload.headers
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
  }
  const wrote = await save();
  return Object.assign(state(), { persisted: wrote });
}

async function forgetSecret() {
  secrets = { key: '', headers: [] };
  const wrote = await save();
  return Object.assign(state(), { persisted: wrote });
}

/**
 * The headers for an outgoing request, secrets included. Never leaves this
 * process. Custom headers are applied last so a gateway's own rule wins over
 * the auth kind's guess.
 */
function headersOf(extra) {
  const h = Object.assign({}, extra || {});
  const key = secrets.key;
  if (key) {
    if (conf.auth === 'goog') h['x-goog-api-key'] = key;
    else if (conf.auth === 'bearer') h.Authorization = 'Bearer ' + key;
    else if (conf.auth === 'apikey') h['X-API-Key'] = key;
  }
  (secrets.headers || []).forEach((row) => {
    if (row && row.name) h[String(row.name)] = String(row.value == null ? '' : row.value);
  });
  return h;
}

/* ------------------------------------------------------------- transport --- */

/** A request path: absolute within the service, with nothing that could leave it. */
function joinPath(raw) {
  const p = String(raw || '');
  if (!p.startsWith('/')) {
    throw Object.assign(new Error('請求路徑要以 / 開頭'), { code: 'EINVAL' });
  }
  if (p.includes('://') || p.includes('..') || /[\r\n]/.test(p)) {
    throw Object.assign(new Error('請求路徑不合法'), { code: 'EINVAL' });
  }
  return conf.base + p;
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
  return String(detail || ('萃取服務回應 ' + status));
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
      throw Object.assign(new Error('萃取服務回應逾時（等了 ' + Math.round(limit / 1000) + ' 秒）'), { code: 'ETIMEDOUT' });
    }
    throw Object.assign(new Error(
      '連不上萃取服務（' + conf.base + '）：' + (e && e.message ? e.message : '無法連線')
    ), { code: 'ECONNREFUSED' });
  }
  clearTimeout(timer);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_RESPONSE) {
    throw Object.assign(new Error('萃取服務回傳的內容太大'), { code: 'E2BIG' });
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
    throw Object.assign(new Error('萃取服務回傳的不是 JSON'), { code: 'EPROTO' });
  }
}

/**
 * One request to the configured service, in `service` mode.
 *
 * `spec` is `{ method, path, query, json, fields, files, binary, timeout }`. The
 * caller supplies a path and a payload; the destination is this module's own
 * business.
 */
async function call(spec = {}) {
  if (conf.mode !== 'service') {
    throw Object.assign(new Error('目前設定的是雲端模型模式，沒有解析服務可以呼叫'), { code: 'EMODE' });
  }
  if (!conf.base) {
    throw Object.assign(new Error('還沒設定解析服務的位址（請在「文件萃取」程式裡按「模型設定」）'), { code: 'ENOCONF' });
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
      throw Object.assign(new Error('這批檔案太大（上限 64 MiB），請分批送'), { code: 'E2BIG' });
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

  return request(url, {
    method: String(spec.method || 'GET').toUpperCase(),
    headers: headersOf(type ? { 'Content-Type': type } : {}),
    body,
    timeout: Number(spec.timeout) || 0,
    binary: !!spec.binary
  });
}

/* --------------------------------------------------------------- gemini --- */

/**
 * The response shape asked of the model: an array of rows, every value a string.
 *
 * Strings all the way through, and this is not laziness. A part number is
 * 0012345 and a heat number is 0800; read as numbers they become 12345 and 800,
 * and the spreadsheet no longer matches the document it came from. Their own
 * exporter writes every cell as text for exactly this reason, so asking the
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
 * Send one document to the cloud model with the vendor's extraction prompt.
 *
 * `job` is `{ base64, filename, mimeType, prompt, columns, temperature }`.
 * Returns `{ rows, usage, model, finish, truncated }`.
 *
 * The PDF goes whole. See the header for why it is not turned into text first.
 */
async function generate(job = {}) {
  if (conf.mode !== 'gemini') {
    throw Object.assign(new Error('目前設定的是解析服務模式，不會直接呼叫雲端模型'), { code: 'EMODE' });
  }
  if (!conf.base || !conf.model) {
    throw Object.assign(new Error('還沒設定萃取模型（請在「文件萃取」程式裡按「模型設定」）'), { code: 'ENOCONF' });
  }
  if (conf.auth !== 'none' && !secrets.key) {
    throw Object.assign(new Error('還沒設定萃取模型的 API 金鑰（請在「文件萃取」程式裡按「模型設定」）'), { code: 'ENOKEY' });
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
    throw Object.assign(new Error('這個萃取設定沒有提示詞，模型不知道要抓什麼'), { code: 'EINVAL' });
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

  const url = conf.base + '/v1beta/models/' + conf.model + ':generateContent';
  const out = await request(url, {
    method: 'POST',
    /* The key as a header, never in the query string: a URL travels into proxy
       logs and crash reports, and a header does not. */
    headers: headersOf({ 'Content-Type': 'application/json' }),
    body: Buffer.from(JSON.stringify(body), 'utf8'),
    timeout: TIMEOUT_UPLOAD
  });

  return Object.assign(readCandidate(out.json), { model: conf.model });
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

/**
 * Is the configuration usable? One model lookup for gemini, the service's own
 * health check otherwise. Never throws: a settings pane wants the reason.
 */
async function probe() {
  if (!conf.base) return { ok: false, reason: '還沒設定位址' };
  if (conf.auth !== 'none' && !secrets.key) return { ok: false, reason: '還沒設定 API 金鑰' };
  try {
    if (conf.mode === 'gemini') {
      if (!conf.model) return { ok: false, reason: '還沒設定模型名稱' };
      const out = await request(conf.base + '/v1beta/models/' + conf.model, {
        headers: headersOf(), timeout: TIMEOUT_READ
      });
      const m = out.json || {};
      return {
        ok: true,
        model: String(m.name || conf.model).replace(/^models\//, ''),
        detail: m.displayName || ''
      };
    }
    const out = await call({ path: '/health', timeout: TIMEOUT_READ });
    const h = out.json || {};
    return {
      ok: String(h.status || '').toLowerCase() !== 'error',
      detail: h.detail || '',
      model: (h.settings && h.settings.model && h.settings.model.model_name) || ''
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = {
  init, state, configure, setSecret, forgetSecret, headersOf, ready,
  call, generate, probe,
  validateBase, validateModel, joinPath, multipart, rowSchema, readCandidate, stripFence,
  GEMINI_BASE, GEMINI_MODEL, MAX_INLINE, AUTH_KINDS
};
