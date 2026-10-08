'use strict';

/* ===========================================================================
   AI-OS // kernel supervision + model providers
   ---------------------------------------------------------------------------
   The model host is this machine's kernel, so the application boots it and
   waits for it, streaming the real llama.cpp load log into the boot screen.
   That turns the POST sequence from a progress animation into an actual
   measurement of the model being mapped into memory.

   If a server is already listening we attach to it instead of starting a
   second one -- two copies of one model rarely fit in one card's VRAM.

   ---------------------------------------------------------------------------
   The kernel does not have to be local

   A machine whose only possible core is one gguf on one graphics card is a
   demo. So the core is a *provider*: the local llama-server, OpenAI, Gemini, or
   anything that speaks the same chat-completions shape.

   Two decisions shape everything below.

   The transport lives in this process, not the renderer. The renderer's CSP
   allows exactly two network destinations -- http://127.0.0.1:* and
   http://localhost:* -- and the comment above it says why that is deliberate:
   that document will eventually paint fetched web pages and mail bodies.
   Widening connect-src to reach api.openai.com would trade a real boundary for
   a convenience. Moving the fetch here keeps the boundary and has a second
   benefit that matters more: an API key never enters the renderer at all.

   Providers are described, not branched on. Each one carries facts -- does it
   have a tokenizer, will it accept chat_template_kwargs, which JSON mode does
   it understand -- and the request is shaped from those facts. `if (provider
   === 'openai')` scattered through a transport is how a third provider becomes
   a rewrite.
   =========================================================================== */

const { spawn, spawnSync } = require('node:child_process');
const models = require('./models');
const fsc = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { safeStorage } = require('electron');
const preset = require('./preset');

const ENDPOINT = 'http://127.0.0.1:8080';

/* ---------------------------------------------------------------------------
   Starting a local model host.

   Nothing here knows which llama.cpp build, which gguf or which offload
   settings a machine uses. Those are facts about one machine -- every value
   worth choosing depends on the card and the model -- so they are described
   from outside, by whoever owns the machine:

     AIOS_LLAMA_LAUNCHER   what to run. A .ps1 is run with PowerShell 7 (pwsh);
                           anything else is executed directly, so this can point
                           straight at llama-server.exe.
     AIOS_LLAMA_ARGS       its arguments, split on whitespace. Double quotes
                           keep a path with spaces in one argument.

   What it runs has to bring up a llama-server that answers /health at the
   local provider's endpoint, and keep running while it does: boot waits for
   /health, and shutdown takes down the whole process tree.

   The environment and nowhere else, on purpose. What this process executes
   must not be something the renderer can choose. The provider window writes
   model-provider.json through IPC, so a launcher stored there would turn one
   compromised renderer into arbitrary code on the next boot.

   Unset means "start nothing": a server that is already listening is attached
   to, and otherwise boot says there is none and carries on.

   Whatever the model, budget for this process being a browser too. Measured:
   ten windows, a live Wikipedia page and a request in flight cost about 850 MiB
   of VRAM on top of the model. Offload settings that fill the card end in
   "CUDA error: an illegal memory access was encountered" as soon as Chromium
   grows -- and once the card is full, Windows serves the overflow from system
   RAM over PCIe, so pushing more layers onto the GPU makes decoding slower,
   not faster.
   --------------------------------------------------------------------------- */
const LAUNCHER_ENV = 'AIOS_LLAMA_LAUNCHER';
const LAUNCHER_ARGS_ENV = 'AIOS_LLAMA_ARGS';

let child = null;
let attached = false;
let sink = null;          // (line, level) => void
const backlog = [];

function emit(line, level = 'info') {
  const entry = { line, level, at: Date.now() };
  backlog.push(entry);
  if (backlog.length > 400) backlog.shift();
  if (sink) sink(entry);
}

function onLog(fn) {
  sink = fn;
  return backlog.slice();
}

/** The launch the environment describes, or null when it describes none. */
function launcher(env = process.env) {
  const file = String(env[LAUNCHER_ENV] || '').trim().replace(/^"(.*)"$/, '$1');
  if (!file) return null;
  return { file: path.resolve(file), args: splitArgs(env[LAUNCHER_ARGS_ENV]) };
}

/** Split on whitespace; a double-quoted stretch stays in one argument. */
function splitArgs(text) {
  const out = [];
  let cur = '';
  let open = false;
  let started = false;
  for (const ch of String(text || '')) {
    if (ch === '"') {
      open = !open;
      started = true;
      continue;
    }
    if (!open && /\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

async function health(timeoutMs = 1500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(localEndpoint() + '/health', { signal: ctl.signal });
    if (!res.ok) return false;
    const j = await res.json().catch(() => null);
    return !!j && j.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function props() {
  try {
    const root = localEndpoint();
    const [p, m] = await Promise.all([
      fetch(root + '/props').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(root + '/v1/models').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    ]);
    const id = m && m.data && m.data[0] && m.data[0].id;
    return {
      model: id ? String(id).split(/[\\/]/).pop().replace(/\.gguf$/i, '') : null,
      nCtx: (p && p.default_generation_settings && p.default_generation_settings.n_ctx) || (p && p.n_ctx) || 0
    };
  } catch {
    return { model: null, nCtx: 0 };
  }
}

/**
 * Bring the kernel up. Resolves once /health answers, or rejects on timeout.
 * onProgress receives every log line so the boot screen can show the real
 * thing rather than a synthetic bar.
 */
async function start(opts = {}) {
  /* A hosted core needs no local process, and starting one anyway would map the
     whole model into memory to sit idle. The user chose a provider; honour it. */
  if (!module.exports.isLocalActive()) {
    emit('core model provider is not local, skipping llama-server', 'info');
    return { attached: false, spawned: false, skipped: true };
  }

  if (await health()) {
    attached = true;
    emit('attached to a llama-server already listening on ' + localEndpoint(), 'ok');
    return { attached: true, spawned: false };
  }

  /* "Do not start one", not "fail if there is not one".
     This used to throw, which failed the whole boot -- and the flag exists
     precisely for the case where the user does not want a model of several
     gigabytes resident, which is now an ordinary way to run this machine: pick
     a hosted provider and the local host is dead weight. Refusing to start
     would leave them with no shell, and the window that changes the provider
     is inside the shell. */
  if (opts.noSpawn) {
    emit('no model host listening, and --no-spawn-llama was given: not starting one', 'warn');
    return { attached: false, spawned: false, skipped: true, reason: 'no-spawn' };
  }

  const launch = launcher();
  if (!launch) {
    emit('no model host at ' + localEndpoint() + ', and no ' + LAUNCHER_ENV + ' to start one', 'error');
    throw new Error(localEndpoint() + ' 沒有 llama-server，也沒有設定啟動程式（環境變數 ' + LAUNCHER_ENV + '）');
  }
  if (!fsc.existsSync(launch.file)) {
    emit('launcher not found: ' + launch.file, 'error');
    throw new Error('找不到啟動程式：' + launch.file);
  }
  /* Node refuses to run a batch file without a shell, and not going through a
     shell is the point of the argument array below. */
  if (/\.(bat|cmd)$/i.test(launch.file)) {
    emit('launcher is a batch file: ' + launch.file, 'error');
    throw new Error('啟動程式要是 .ps1 或執行檔，不能是 .bat／.cmd：' + launch.file);
  }

  const ps1 = /\.ps1$/i.test(launch.file);
  const argv = ps1
    ? ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launch.file, ...launch.args]
    : launch.args;
  emit('spawning kernel: ' + [path.basename(launch.file), ...launch.args].join(' '), 'hi');

  // Argument array, no shell: nothing here is interpolated into a command line.
  try {
    child = spawn(ps1 ? 'pwsh' : launch.file, argv,
      { cwd: path.dirname(launch.file), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // A file Windows will not execute at all (EFTYPE) is refused right here.
    emit('launcher could not run: ' + e.message, 'error');
    throw new Error('啟動程式跑不起來（' + e.message + '）：' + launch.file);
  }
  /* Anything else that keeps the launcher from running -- pwsh missing from
     PATH, say -- arrives as 'error' rather than 'exit', and an 'error' nobody
     listens for is thrown in the main process. */
  child.on('error', (e) => {
    emit('launcher could not run: ' + e.message, 'error');
    child = null;
  });

  const pump = (stream, level) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        const s = l.trim();
        if (!s) continue;
        // llama.cpp tags severity in its own log lines; surface that.
        const lv = /\bE\b|error|failed/i.test(s) ? 'error'
          : /\bW\b|warning/i.test(s) ? 'warn'
          : level;
        emit(s, lv);
      }
    });
  };
  pump(child.stdout, 'info');
  pump(child.stderr, 'warn');

  child.on('exit', (code, signal) => {
    emit(`kernel exited (code=${code} signal=${signal || '-'})`, code === 0 ? 'info' : 'error');
    child = null;
  });

  // Wait for the port rather than for a log line: the log format is not a
  // contract, an open socket answering /health is.
  const deadline = Date.now() + (opts.timeoutMs || 300000);
  while (Date.now() < deadline) {
    if (!child) throw new Error('llama-server 啟動後就結束了，看開機日誌');
    if (await health()) {
      emit('kernel is listening on ' + localEndpoint(), 'ok');
      return { attached: false, spawned: true };
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error('等待 llama-server 逾時');
}

/**
 * Reclaim the kernel on shutdown.
 *
 * This has to be synchronous. Spawning taskkill asynchronously from a quit
 * handler loses the race: Electron exits, our helper dies with it, and the
 * model stays resident holding VRAM until the user finds it in Task Manager.
 * spawnSync blocks the quit until the tree is actually gone.
 *
 * Only ever kills what this process started. A server the user launched
 * themselves is attached to, not owned, and is left alone.
 */
function stop() {
  if (!child || attached) {
    child = null;
    return { killed: false, reason: attached ? 'attached, not ours' : 'nothing running' };
  }

  const pid = child.pid;
  child = null;

  try {
    // /T takes the whole tree: a launcher script is the parent of
    // llama-server, so killing the launcher alone would orphan the model.
    const r = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      timeout: 10000,
      encoding: 'utf8'
    });
    return { killed: r.status === 0, pid, status: r.status };
  } catch (e) {
    return { killed: false, pid, error: e.message };
  }
}

function status() {
  return { running: !!child, attached, endpoint: localEndpoint(), provider: active, local: active === 'local' };
}

/* ===========================================================================
   Providers
   =========================================================================== */

/**
 * What each provider *is*, rather than what to do about it.
 *
 * `tokenizer` and `probeProps` are llama-server extensions: /tokenize gives real
 * token counts for the attention scheduler, /props gives the true context
 * window. No hosted API offers either, so the scheduler falls back to its
 * estimator and reports a context window it was told rather than measured.
 *
 * `templateKwargs` is the llama.cpp / vLLM extension that suppresses a thinking
 * trace. OpenAI answers 400 for an unknown top-level field, so sending it
 * everywhere would break the first attempt of every request.
 *
 * `json` is how far the provider can be held to a shape. 'schema' means it
 * accepts a json_schema grammar; 'object' means it can be told to emit some
 * JSON but not which JSON, which the tolerant parser already handles.
 */
/**
 * How hard the model should think, as one ladder.
 *
 * Every vendor invented its own dial and none of them line up. OpenAI takes
 * `reasoning_effort` from 'none' up to 'xhigh'. Gemini's compatibility layer
 * takes four rungs. DeepSeek switches thinking with a top-level `thinking`
 * object and only recognises the top two effort values. llama.cpp has a
 * boolean. So this machine offers one ladder and maps each request to the
 * nearest rung the chosen provider actually knows -- the same thing Inspect and
 * LiteLLM do, and for the same reason: the alternative is a different control
 * per provider, which is a control nobody learns.
 *
 * 'default' is deliberately not on the ladder. It means "send nothing", and it
 * has to be the default for a hosted provider: `reasoning_effort` on a model
 * that does not reason is a 400, and a model list cannot tell us which is which.
 */
const EFFORT_LADDER = ['none', 'minimal', 'low', 'medium', 'high', 'max'];

/**
 * The nearest rung a provider will accept.
 *
 * Steps down before it steps up, because spending more thinking than was asked
 * for costs money the user did not agree to.
 */
function nearestEffort(want, accepted) {
  if (!accepted || !accepted.length) return null;
  if (accepted.indexOf(want) >= 0) return want;
  var at = EFFORT_LADDER.indexOf(want);
  if (at < 0) return null;
  for (var d = 1; d < EFFORT_LADDER.length; d++) {
    var lo = EFFORT_LADDER[at - d];
    if (lo && accepted.indexOf(lo) >= 0) return lo;
    var hi = EFFORT_LADDER[at + d];
    if (hi && accepted.indexOf(hi) >= 0) return hi;
  }
  return null;
}

const PROVIDERS = {
  local: {
    id: 'local',
    label: '地端模型',
    note: 'llama-server。這台機器自己啟動並回收它，資料不離開本機。',
    remote: false,
    supervised: true,
    auth: 'none',
    tokenizer: true,
    probeProps: true,
    templateKwargs: true,
    json: 'schema',
    // A chat template has a switch, not a dial: the two rungs are the two states.
    reasoningKind: 'template',
    efforts: ['none', 'high'],
    editable: ['endpoint', 'model', 'reasoning', 'maxOut'],
    defaults: { endpoint: ENDPOINT, model: '', reasoning: 'default', maxOut: 0 }
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    note: '需要 API 金鑰。送出的內容會離開這台機器。',
    remote: true,
    supervised: false,
    auth: 'bearer',
    tokenizer: false,
    probeProps: false,
    templateKwargs: false,
    json: 'object',
    reasoningKind: 'effort',
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'max'],
    // The top rung is spelled differently on the wire.
    effortAs: { max: 'xhigh' },
    /* Measured against the live API: a current model answers
         400 Unsupported parameter: 'max_tokens' is not supported with this
         model. Use 'max_completion_tokens' instead.
       Every other provider here still takes max_tokens, so this is a fact about
       OpenAI rather than a change to the request everyone gets. */
    capField: 'max_completion_tokens',
    base: 'https://api.openai.com/v1',
    editable: ['model', 'reasoning', 'maxOut'],
    defaults: { model: 'gpt-4o-mini', reasoning: 'default', maxOut: 4096 }
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    note: '走 Google 的 OpenAI 相容端點，需要 API 金鑰。送出的內容會離開這台機器。',
    remote: true,
    supervised: false,
    auth: 'bearer',
    tokenizer: false,
    probeProps: false,
    templateKwargs: false,
    json: 'object',
    reasoningKind: 'effort',
    efforts: ['none', 'low', 'medium', 'high'],
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    editable: ['model', 'reasoning', 'maxOut'],
    defaults: { model: 'gemini-2.5-flash', reasoning: 'default', maxOut: 4096 }
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    /* deepseek-chat and deepseek-reasoner are text-only; a request with an
       image part is refused here with a sentence, not there with a 400. Every
       other provider is tried: the OpenAI-shaped image_url part is what
       OpenAI, Gemini's OpenAI endpoint and a llama-server with an mmproj all
       read, and one without an mmproj says so in its own error. */
    images: false,
    note: 'OpenAI 相容端點，需要 API 金鑰。送出的內容會離開這台機器。',
    remote: true,
    supervised: false,
    auth: 'bearer',
    tokenizer: false,
    probeProps: false,
    templateKwargs: false,
    json: 'object',
    /* Thinking is a top-level object here, not an effort string, and the effort
       string it does read only goes down as far as 'high'. */
    reasoningKind: 'thinking',
    efforts: ['high', 'max'],
    base: 'https://api.deepseek.com/v1',
    editable: ['model', 'reasoning', 'maxOut'],
    defaults: { model: 'deepseek-chat', reasoning: 'default', maxOut: 4096 }
  },
  custom: {
    id: 'custom',
    label: '自訂模型',
    note: '任何講 OpenAI chat-completions 的服務。表頭自己加，金鑰與表頭都會加密存放。',
    remote: true,
    supervised: false,
    auth: 'custom',          // decided per-configuration, see authOf()
    tokenizer: false,        // overridable: a self-hosted llama-server has one
    probeProps: false,
    templateKwargs: false,
    json: 'object',
    reasoningKind: 'effort', // overridable, see reasoningKindOf()
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'max'],
    editable: ['base', 'model', 'auth', 'json', 'tokenizer', 'reasoning', 'reasoningKind', 'capField', 'maxOut', 'headers'],
    defaults: {
      base: '', model: '', auth: 'bearer', json: 'object',
      tokenizer: false, reasoning: 'default', reasoningKind: 'effort',
      capField: 'max_tokens', maxOut: 0
    }
  }
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

let active = 'local';
let conf = {};              // id -> non-secret settings
let secrets = {};           // id -> { key, headers: [{name, value}] }, decrypted, memory only
let confPath = null;
let sealed = false;         // whether secrets can be written to disk at all

function trimUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

/** http and https only. Loopback is allowed on purpose: a self-hosted core is
    the normal case here, and this is a user typing an address, not a model
    asking to fetch one. */
function checkBase(u) {
  var s = trimUrl(u);
  if (!s) throw new Error('沒有給服務位址');
  var parsed;
  try { parsed = new URL(s); } catch (e) { throw new Error('位址格式不對：' + s); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支援 http 與 https，收到 ' + parsed.protocol);
  }
  return s;
}

function confOf(id) {
  return Object.assign({}, PROVIDERS[id].defaults, conf[id] || {});
}

function localEndpoint() {
  return trimUrl(confOf('local').endpoint) || ENDPOINT;
}

/** Where the OpenAI-shaped paths live for a provider. */
function baseOf(id) {
  if (id === 'local') return localEndpoint() + '/v1';
  if (id === 'custom') return trimUrl(confOf('custom').base);
  return PROVIDERS[id].base;
}

function authOf(id) {
  return id === 'custom' ? (confOf('custom').auth || 'bearer') : PROVIDERS[id].auth;
}

/** A custom provider may be pointed at a llama-server, which does have one. */
function hasTokenizer(id) {
  return id === 'custom' ? !!confOf('custom').tokenizer : PROVIDERS[id].tokenizer;
}

function jsonModeOf(id) {
  return id === 'custom' ? (confOf('custom').json || 'object') : PROVIDERS[id].json;
}

/** A custom endpoint could be any of the three shapes, so it says which. */
function reasoningKindOf(id) {
  if (id !== 'custom') return PROVIDERS[id].reasoningKind;
  var k = confOf('custom').reasoningKind || 'effort';
  return ['effort', 'thinking', 'template', 'none'].indexOf(k) >= 0 ? k : 'effort';
}

function effortsOf(id) {
  if (id !== 'custom') return PROVIDERS[id].efforts;
  return reasoningKindOf(id) === 'template' ? ['none', 'high'] : EFFORT_LADDER;
}

/**
 * Whether chat_template_kwargs may be sent.
 *
 * For a custom endpoint this follows the dialect the user picked: saying "this
 * one speaks chat_template_kwargs" and then having the field suppressed by a
 * static fact about a different provider is the field silently doing nothing.
 */
function templateKwargsOf(id) {
  return id === 'custom' ? reasoningKindOf(id) === 'template' : PROVIDERS[id].templateKwargs;
}

/** What this provider calls the output cap. OpenAI renamed it. */
function capFieldOf(id) {
  var f = id === 'custom' ? confOf('custom').capField : PROVIDERS[id].capField;
  return f === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens';
}

/**
 * The headers for an outgoing request, secrets included.
 *
 * Never leaves this process. `list()` reports whether a key exists and nothing
 * else, the same way the mail account reports `configured` without the password.
 */
function headersOf(id) {
  var h = { 'Content-Type': 'application/json' };
  var s = secrets[id] || {};
  if (authOf(id) === 'bearer' && s.key) h.Authorization = 'Bearer ' + s.key;
  (s.headers || []).forEach(function (row) {
    if (row && row.name) h[String(row.name)] = String(row.value == null ? '' : row.value);
  });
  return h;
}

/* ------------------------------------------------------------- persistence */

/**
 * Config in the clear, secrets in one encrypted blob.
 *
 * The blob is everything sensitive at once -- API keys and the custom header
 * list -- because a header value is exactly where a person puts a token, and
 * encrypting the key while writing `X-Api-Key: sk-...` next to it in plaintext
 * would be security theatre.
 *
 * If the platform has no keychain, nothing sensitive is written at all and the
 * caller is told. A silent plaintext fallback would be worse than refusing:
 * the user would believe a promise this file did not keep.
 */
async function saveProviders() {
  if (!confPath) return { saved: false, reason: 'not initialised' };
  var payload = { active: active, providers: conf };
  var anySecret = PROVIDER_IDS.some(function (id) {
    var s = secrets[id];
    return s && (s.key || (s.headers || []).length);
  });
  if (anySecret) {
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
 * Apply the preset this build ships with, if there is one and this machine has
 * nothing of its own yet.
 *
 * Only on a first run. Once `model-provider.json` exists it is the user's, and a
 * preset must never reach back in and change a provider they chose or a key they
 * typed -- an update that silently repointed the core at somebody else's account
 * would be indefensible.
 *
 * The secrets land in memory here and are written out by the normal
 * `saveProviders()` path, so from the second run they are held in the OS
 * keychain like any other credential rather than being re-read from the bundle.
 */
async function applyPreset() {
  var value;
  try {
    value = await preset.load();
  } catch (e) {
    emit('內建的模型預設檔打不開：' + e.message, 'warn');
    return { applied: false, error: e.message };
  }
  if (!value) return { applied: false };

  if (value.active && PROVIDERS[value.active]) active = value.active;
  if (value.providers && typeof value.providers === 'object') {
    PROVIDER_IDS.forEach(function (id) {
      if (value.providers[id] && typeof value.providers[id] === 'object') {
        conf[id] = value.providers[id];
      }
    });
  }
  if (value.secrets && typeof value.secrets === 'object') secrets = value.secrets;

  // Persist immediately, so the preset is consulted exactly once and everything
  // after this run reads the user's own file.
  await saveProviders();
  return { applied: true, active: active };
}

async function initProviders(userDataDir) {
  confPath = path.join(userDataDir, 'model-provider.json');
  try { sealed = safeStorage.isEncryptionAvailable(); } catch (e) { sealed = false; }

  var mine = true;
  try {
    var raw = JSON.parse(await fs.readFile(confPath, 'utf8'));
    if (raw && PROVIDERS[raw.active]) active = raw.active;
    if (raw && raw.providers && typeof raw.providers === 'object') {
      PROVIDER_IDS.forEach(function (id) {
        if (raw.providers[id] && typeof raw.providers[id] === 'object') conf[id] = raw.providers[id];
      });
    }
    if (raw && raw.secrets && sealed) {
      try {
        secrets = JSON.parse(safeStorage.decryptString(Buffer.from(raw.secrets, 'base64'))) || {};
      } catch (e) {
        // A blob written under a different OS user or machine cannot be read
        // back. Losing the key is the correct outcome; guessing is not.
        secrets = {};
        emit('stored model credentials could not be decrypted, they were discarded', 'warn');
      }
    }
  } catch (e) {
    // No configuration of our own: a first run, which is the only moment a
    // shipped preset is allowed to speak.
    mine = false;
  }

  if (!mine) {
    var p = await applyPreset();
    if (p.applied) emit('套用內建的模型預設：' + (PROVIDERS[p.active] || {}).label, 'ok');
  }

  return providerState();
}

/* --------------------------------------------------------------- reporting */

/** What the renderer is allowed to know. No key material, not even a length. */
/** Whether a message list carries a picture (an OpenAI-shaped image_url part). */
function hasImages(messages) {
  return Array.isArray(messages) && messages.some(function (m) {
    return m && Array.isArray(m.content) && m.content.some(function (part) {
      return part && part.type === 'image_url';
    });
  });
}

/** Whether this provider is worth sending a picture to. */
function acceptsImages(id) {
  var p = PROVIDERS[id];
  return !!p && p.images !== false;
}

function providerState() {
  return {
    active: active,
    sealed: sealed,
    providers: PROVIDER_IDS.map(function (id) {
      var p = PROVIDERS[id];
      var s = secrets[id] || {};
      return {
        id: id,
        label: p.label,
        note: p.note,
        remote: p.remote,
        supervised: p.supervised,
        editable: p.editable,
        auth: authOf(id),
        needsKey: authOf(id) === 'bearer',
        hasKey: !!s.key,
        headerNames: (s.headers || []).map(function (r) { return r.name; }),
        tokenizer: hasTokenizer(id),
        images: acceptsImages(id),
        json: jsonModeOf(id),
        reasoningKind: reasoningKindOf(id),
        efforts: effortsOf(id),
        // What the chosen rung becomes for this provider, so the picker can show
        // "high" when the user asked for "max" and this one stops at high.
        effortResolved: resolvedEffort(id),
        /* Which optional fields this provider has rejected this session. Reported
           because the transport quietly stops sending them, and a request that is
           quietly different from the one that was configured is the hardest kind
           of behaviour to account for. */
        refusedFields: Object.keys(refused[id] || {}),
        base: baseOf(id),
        config: confOf(id)
      };
    }),
    ladder: EFFORT_LADDER
  };
}

/**
 * The models a provider will admit to having, without switching to it.
 *
 * Separate from probeActive on purpose: the point is to fill the dropdown the
 * moment a key is entered, which is before the provider is in use and possibly
 * before it works at all.
 */
async function listModels(id) {
  if (!PROVIDERS[id]) throw new Error('沒有這個供應商：' + id);
  var base = baseOf(id);
  if (!base) throw new Error(PROVIDERS[id].label + ' 還沒有設定服務位址');
  if (authOf(id) === 'bearer' && !(secrets[id] || {}).key) {
    throw new Error('要先填 API 金鑰才問得到模型清單');
  }
  var res = await fetch(base + '/models', { headers: headersOf(id) });
  if (!res.ok) {
    var detail = await res.text().catch(function () { return ''; });
    throw new Error('HTTP ' + res.status + (detail ? '：' + detail.slice(0, 200) : ''));
  }
  var body = await res.json();
  /* Reported verbatim. The local host answers with a filesystem path, and
     prettifying it here would hand back a name the server was never told. */
  var ids = ((body && body.data) || [])
    .map(function (m) { return String(m && m.id || ''); })
    .filter(Boolean)
    .sort();
  return { provider: id, models: ids.slice(0, 200) };
}

/* ----------------------------------------------------------------- mutation */

async function selectProvider(id) {
  if (!PROVIDERS[id]) throw new Error('沒有這個供應商：' + id);
  if (id === 'custom') checkBase(confOf('custom').base);
  if (authOf(id) === 'bearer' && !(secrets[id] || {}).key) {
    throw new Error(PROVIDERS[id].label + ' 需要 API 金鑰，請先填好再切換');
  }
  active = id;
  var w = await saveProviders();
  emit('core model provider is now ' + id + ' (' + baseOf(id) + ')', 'hi');
  return Object.assign(providerState(), { persisted: w });
}

/** Non-secret settings only. Anything sensitive goes through setSecret. */
async function configureProvider(id, patch) {
  if (!PROVIDERS[id]) throw new Error('沒有這個供應商：' + id);
  var allow = PROVIDERS[id].editable;
  var next = Object.assign({}, conf[id] || {});
  Object.keys(patch || {}).forEach(function (k) {
    if (k === 'headers') return;             // secret, not config
    if (allow.indexOf(k) < 0) return;        // silently ignored, not an error
    next[k] = patch[k];
  });
  if (next.base !== undefined && String(next.base).trim()) next.base = checkBase(next.base);
  if (next.endpoint !== undefined && String(next.endpoint).trim()) next.endpoint = checkBase(next.endpoint);
  if (next.maxOut !== undefined) {
    /* 0 disables the override. Above that there is a floor, because a cap of 20
       on a reasoning model is not a small answer, it is no answer -- and the
       failure would look like the machine rather than the setting. */
    var n = parseInt(next.maxOut, 10);
    next.maxOut = !n || n <= 0 ? 0 : Math.max(256, Math.min(200000, n));
  }
  conf[id] = next;
  var w = await saveProviders();
  return Object.assign(providerState(), { persisted: w });
}

/**
 * Store an API key and/or a custom header list for one provider.
 *
 * A key of '' means "leave the stored one alone" rather than "clear it", so a
 * form can be submitted again without retyping the secret. Clearing is
 * forgetSecret, which is a separate and explicit act.
 */
async function setSecret(id, payload) {
  if (!PROVIDERS[id]) throw new Error('沒有這個供應商：' + id);
  payload = payload || {};
  var s = secrets[id] || {};
  if (typeof payload.key === 'string' && payload.key.trim()) s.key = payload.key.trim();
  if (Array.isArray(payload.headers)) {
    if (PROVIDERS[id].editable.indexOf('headers') < 0) throw new Error(id + ' 不支援自訂表頭');
    var before = {};
    (s.headers || []).forEach(function (r) { before[r.name] = r.value; });
    s.headers = payload.headers
      .filter(function (r) { return r && String(r.name || '').trim(); })
      .slice(0, 20)
      .map(function (r) {
        var name = String(r.name).trim();
        // A header name is a token; a newline in one is request splitting.
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error('表頭名稱不合法：' + name);
        var value = String(r.value == null ? '' : r.value).replace(/[\r\n]/g, '').slice(0, 4000);
        /* A blank value means "leave the stored one alone", the same as a blank
           API key. The form cannot show these back -- they never leave this
           process -- so submitting it again would otherwise wipe every value the
           user could not see. Deleting a header is removing its row. */
        if (!value && before[name] !== undefined) value = before[name];
        return { name: name, value: value };
      });
  }
  secrets[id] = s;
  var w = await saveProviders();
  return Object.assign(providerState(), { persisted: w });
}

async function forgetSecret(id) {
  if (!PROVIDERS[id]) throw new Error('沒有這個供應商：' + id);
  delete secrets[id];
  // Refusing to keep credentials for the provider currently in use would leave
  // the machine with no core, so fall back to the one that needs none.
  if (active === id && authOf(id) === 'bearer') active = 'local';
  var w = await saveProviders();
  return Object.assign(providerState(), { persisted: w });
}

/* ---------------------------------------------------------------- transport */

const inflight = new Map();   // requestId -> AbortController

/**
 * Optional fields a 400 is allowed to talk us out of.
 *
 * Measured against the live OpenAI API, two rejections in a row from one model:
 *   Unsupported parameter: 'max_tokens' is not supported with this model.
 *   Unsupported value: 'temperature' does not support 0.3 ... Only 1 is supported.
 *
 * Which sampling and reasoning fields a hosted model accepts is not stable and
 * not discoverable from a model list, so a fixed table per provider would go
 * stale -- it already did, twice, inside one afternoon. The error names the
 * field, so the request drops that field and tries again. Everything here is
 * optional by definition: losing it changes the answer's flavour, not whether
 * there is one. `messages` and `model` are deliberately absent.
 */
const DROPPABLE = [
  'temperature', 'top_p', 'reasoning_effort', 'chat_template_kwargs',
  'thinking', 'response_format', 'stream_options'
];

/* What each provider has already refused this session, so the round trips are
   paid once rather than on every turn. Not persisted: it is a fact about a model
   that may be updated under us, and a stale cache would silently drop a field
   the provider had started accepting again. */
const refused = {};   // providerId -> { field: true }

/** The field a 400 is complaining about, if it names one. */
function refusedField(bodyText) {
  var param = null;
  try {
    var j = JSON.parse(bodyText);
    param = j && j.error && j.error.param;
  } catch (e) { /* not the documented shape, fall back to reading it */ }
  if (!param) {
    var m = /'([A-Za-z_][A-Za-z0-9_]*)'/.exec(String(bodyText || ''));
    param = m ? m[1] : null;
  }
  return param && DROPPABLE.indexOf(param) >= 0 ? param : null;
}

/**
 * Provider-aware handshake. Reports the model identity and, where the provider
 * can be asked, the real context window.
 */
async function probeActive() {
  var id = active;
  var p = PROVIDERS[id];
  var base = baseOf(id);
  if (!base) throw new Error(p.label + ' 還沒有設定服務位址');
  var headers = headersOf(id);

  var propsData = null;
  if (p.probeProps) {
    try {
      var r = await fetch(localEndpoint() + '/props', { headers: headers });
      if (r.ok) propsData = await r.json();
    } catch (e) { /* optional everywhere, absent on hosted APIs */ }
  }

  var wanted = String(confOf(id).model || '').trim();
  var model = wanted;
  var listed = [];
  /* The whole record for the model we end up using, not just its name. OpenAI's
     own listing carries nothing but id/created/owned_by, but most
     OpenAI-compatible gateways put the context window in there under one name
     or another -- and reading it costs nothing, while assuming OpenAI's shape
     is the only one costs the number. */
  var records = [];
  try {
    var r2 = await fetch(base + '/models', { headers: headers });
    if (r2.ok) {
      var body = await r2.json();
      records = (body && body.data) || [];
      listed = records.map(function (m) { return String(m.id); });
    } else if (!wanted) {
      throw new Error('/models HTTP ' + r2.status);
    }
  } catch (e) {
    // A configured model name is enough to work with; only a provider that can
    // neither list nor be told which model to use is unusable.
    if (!wanted) throw e;
  }
  if (!model) model = listed[0] || 'unknown';

  // Only the local host serves paths off a filesystem, so only its identifier
  // needs the directory and the .gguf suffix taken off.
  if (id === 'local') model = model.split(/[\\/]/).pop().replace(/\.gguf$/i, '');

  /* llama.cpp answers /props, which is the provider reporting it directly. */
  var localCtx =
    (propsData && propsData.default_generation_settings && propsData.default_generation_settings.n_ctx) ||
    (propsData && propsData.n_ctx) || 0;

  var record = records.find(function (m) { return String(m && m.id) === model; }) || null;
  var known = models.describe(model, {
    reported: localCtx ? { n_ctx: localCtx } : record,
    override: confOf(id).limits || null,
    measured: measuredCtx[model] || 0,
    measuredOut: measuredOut[model] || 0
  });

  return {
    provider: id,
    label: p.label,
    remote: p.remote,
    model: model,
    models: listed.slice(0, 60),
    nCtx: known.ctx,
    /* Where that number came from, because 「1,050,000」 from a table compiled in
       September and 「1,050,000」 measured off the server today are worth
       different amounts, and the window that shows it should say which. */
    nCtxSource: known.ctxSource,
    nCtxSourceName: known.ctxSourceName,
    maxOut: known.out,
    maxOutSource: known.outSource,
    tokenizer: hasTokenizer(id),
    base: base
  };
}

/**
 * A limit the server itself told us about, keyed by model.
 *
 * Outranks the table because it is this deployment, this key, today. Filled in
 * when a request comes back refused for being too long -- which is the one
 * moment a provider that documents nothing says the number out loud.
 */
var measuredCtx = Object.create(null);
var measuredOut = Object.create(null);

function noteLimitFrom(modelId, message) {
  var n = models.ctxFromError(message);
  if (!n || !modelId) return 0;
  measuredCtx[String(modelId)] = n;
  return n;
}

/**
 * The same, for the output cap.
 *
 * Separate from the context one on purpose: they are different numbers about
 * different things, and a context window learned from an output refusal would
 * quietly shrink the attention budget with nothing on screen to explain it.
 */
function noteOutLimitFrom(modelId, message) {
  var n = models.outFromError(message);
  if (!n || !modelId) return 0;
  measuredOut[String(modelId)] = n;
  return n;
}

/**
 * What this model will actually produce, whoever knows it best.
 *
 * Same order as everywhere else -- what the server told us today beats the
 * table, and what the user typed beats both -- except that the user's number
 * cannot raise the ceiling above one the server has already refused. A person is
 * entitled to set a limit; they are not able to grant themselves one the
 * provider does not offer, and pretending otherwise just returns the 400.
 */
function outCapFor(id) {
  var conf = confOf(id);
  var model = String(conf.model || '').trim();
  if (!model) return 0;
  var known = models.describe(model, {
    override: conf.limits || null,
    measuredOut: measuredOut[model] || 0
  });
  var cap = Number(known.out) || 0;
  var server = Number(measuredOut[model]) || 0;
  if (server > 0 && (cap === 0 || cap > server)) cap = server;
  return cap > 0 ? Math.round(cap) : 0;
}

/** Real token counts, for the providers that can actually give them. */
async function tokenizeActive(text) {
  if (!hasTokenizer(active)) return null;
  var root = active === 'local' ? localEndpoint() : trimUrl(confOf('custom').base).replace(/\/v1$/, '');
  var res = await fetch(root + '/tokenize', {
    method: 'POST',
    headers: headersOf(active),
    body: JSON.stringify({ content: String(text == null ? '' : text) })
  });
  if (!res.ok) throw new Error('/tokenize HTTP ' + res.status);
  var out = await res.json();
  return Array.isArray(out.tokens) ? out.tokens.length : null;
}

/**
 * Shape one request for the active provider.
 *
 * The renderer asks for what it wants -- these messages, hold it to this shape
 * or do not -- and the provider's own facts decide how to say it. That is why
 * chat_template_kwargs no longer appears anywhere in the renderer: it is true
 * of one provider, not of the request.
 */
/**
 * Put the thinking dial on the wire in whichever dialect this provider speaks.
 *
 * 'default' sends nothing at all, except on the local host, where it keeps the
 * behaviour this machine has always had: the intent pipeline wants an answer,
 * not a monologue, so thinking is off unless asked for.
 */
/**
 * `override` lets one caller ask for a different dial than the machine's,
 * without touching the setting. Translation is the case it exists for: a page
 * of paragraphs wants no thinking at all, whatever the person chose for the
 * intent core, and a reasoning model left on can take tens of times longer for
 * an answer that is not better. It is still expressed as a rung on the one
 * ladder, so which dialect this provider speaks stays a fact about the
 * provider and is not copied into the caller.
 */
function applyReasoning(body, id, override) {
  var p = PROVIDERS[id];
  var kind = reasoningKindOf(id);
  var want = String(override || confOf(id).reasoning || 'default');

  if (want === 'default') {
    if (kind === 'template' && templateKwargsOf(id)) body.chat_template_kwargs = { enable_thinking: false };
    return;
  }
  if (kind === 'none') return;

  /* 'none' is not a rung to be rounded to the nearest one.
     Two of the three dialects have an explicit off switch, and DeepSeek's effort
     string starts at 'high' -- so rounding "do not think" to the nearest
     acceptable effort turned it into "think as hard as possible", which is the
     opposite of the request and the expensive opposite at that. */
  if (want === 'none') {
    if (kind === 'template') {
      if (templateKwargsOf(id)) body.chat_template_kwargs = { enable_thinking: false };
    } else if (kind === 'thinking') {
      body.thinking = { type: 'disabled' };
    } else if ((effortsOf(id) || []).indexOf('none') >= 0) {
      body.reasoning_effort = 'none';
    }
    // An effort-only provider with no 'none' rung gets nothing rather than more.
    return;
  }

  var got = nearestEffort(want, effortsOf(id));
  if (!got) return;

  if (kind === 'template') {
    if (templateKwargsOf(id)) body.chat_template_kwargs = { enable_thinking: true };
    return;
  }
  if (kind === 'thinking') {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = got;
    return;
  }
  // 'effort'
  body.reasoning_effort = (p.effortAs && p.effortAs[got]) || got;
}

/** Which rung a request would actually land on. Shown in the picker, so the
    mapping is visible rather than something that happens quietly. */
function resolvedEffort(id) {
  var want = String(confOf(id).reasoning || 'default');
  var kind = reasoningKindOf(id);
  if (want === 'default' || kind === 'none') return null;
  // Matches applyReasoning: off is off, never the nearest rung upwards.
  if (want === 'none') {
    if (kind === 'template' || kind === 'thinking') return 'none';
    return (effortsOf(id) || []).indexOf('none') >= 0 ? 'none' : null;
  }
  return nearestEffort(want, effortsOf(id));
}

function shapeBody(req) {
  var id = active;
  var p = PROVIDERS[id];
  var body = {
    model: String(confOf(id).model || '').trim() || (id === 'local' ? 'local' : undefined),
    messages: req.messages,
    stream: true,
    temperature: req.temperature != null ? req.temperature : 0.3,
    top_p: req.topP != null ? req.topP : 0.9
  };
  /* The output cap, and who gets to decide it.
     A caller asks for what its answer needs -- a plan around 900, a chat reply
     around 1400 -- and those numbers were chosen for a local model with thinking
     switched off. On a hosted reasoner the thinking is spent out of this same cap,
     so the same 1400 returns a sentence that stops mid-word with finish_reason
     'length'. The provider's own setting therefore wins when it is set: how much
     room this model needs is a fact about the model, not about the question.
     Zero means "leave it to the caller", which is what the local host wants. */
  var want = Number(confOf(id).maxOut) > 0 ? Number(confOf(id).maxOut) : (req.maxTokens || 900);
  /* And a ceiling, because asking for more than the model will give is not
     ambitious, it is a guaranteed HTTP 400 -- every call, until somebody edits a
     settings field. A user set this to 200,000 against a model documented at
     128,000 and the machine could not plan a single intent; what it said was the
     provider's raw refusal, which names max_tokens but not which of this
     machine's settings put it there.
     The number the model can actually produce was already known here -- the
     table has it, the provider sometimes reports it, and a refusal measures it
     -- and it was being used only to draw a line in the settings window. Using
     it is the whole fix. Zero means nobody knows, and then the caller's number
     goes out unchanged rather than being clamped to a guess. */
  var ceiling = outCapFor(id);
  if (ceiling > 0 && want > ceiling) {
    emit(id + ' 的輸出上限是 ' + ceiling.toLocaleString('en-US') + '，這次要求 ' +
      want.toLocaleString('en-US') + '，已改用上限', 'warn');
    want = ceiling;
  }
  body[capFieldOf(id)] = want;

  /* Ask for the token count. Measured: OpenAI and Gemini send no usage block in a
     stream unless asked, which on the two providers that bill for invisible
     reasoning tokens means no report of what a turn cost. DeepSeek sends it
     unasked and does not mind being asked. If a provider objects, the retry above
     drops it -- that is what it is for. */
  if (p.remote) body.stream_options = { include_usage: true };
  if (body.model === undefined) delete body.model;

  /* Only on the constrained attempt. The second attempt is the fallback for when
     the first was refused, so it carries nothing optional -- which is also what
     makes a reasoning dial safe to offer: pointing it at a model that does not
     reason costs one rejected request, not a broken machine. */
  if (!req.constrain) return body;

  applyReasoning(body, id, req.reasoning);

  var mode = jsonModeOf(id);
  if (req.schema && mode === 'schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: req.schemaName || 'out', schema: req.schema }
    };
  } else if (req.schema && mode === 'object') {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

/**
 * Fields the caller wants left off the wire entirely.
 *
 * Different from DROPPABLE, which is what a provider talked us out of after a
 * 400. This is the caller saying up front "do not send this at all", and the
 * case it exists for is `temperature`: the newest hosted models ask to be left
 * at their own default, and there is no number that means "unset" -- omitting
 * 0.3 and sending 0.3 are different requests. Only optional fields can go;
 * `messages` and `model` are not negotiable.
 */
const OMITTABLE = ['temperature', 'top_p', 'reasoning_effort', 'response_format', 'chat_template_kwargs', 'thinking'];

function applyOmissions(body, omit) {
  var out = [];
  (Array.isArray(omit) ? omit : []).forEach(function (f) {
    if (OMITTABLE.indexOf(f) >= 0 && f in body) { delete body[f]; out.push(f); }
  });
  return out;
}

/**
 * Statuses worth trying again, and how long to wait.
 *
 * 429 is the provider saying "not so fast" and 5xx is it having a bad moment;
 * both are answered by waiting, and neither is answered by giving up. This is
 * opt-in (`req.retry`) rather than the rule for every call, because the intent
 * bar should fail in front of the person who is waiting for it rather than
 * quietly spend twenty seconds retrying. Bulk work -- a page of paragraphs --
 * opts in.
 */
const TRANSIENT = [429, 500, 502, 503, 504, 522, 524];

/**
 * An abort, in the shape every caller on this machine already tests for.
 *
 * `fetch` rejects with a DOMException named AbortError, and both the renderer
 * (kernel.js) and translate.js branch on `e.name === 'AbortError'` before
 * treating an error as a failure. Anything thrown out of the backoff has to
 * answer to the same name or a stop button reads as a fault.
 */
function abortError() {
  var e = new Error('請求已中止');
  e.name = 'AbortError';
  return e;
}

function retryDelay(attempt, res) {
  var after = res && res.headers && res.headers.get ? res.headers.get('retry-after') : null;
  var secs = after && /^\d+$/.test(String(after).trim()) ? Number(after) : 0;
  if (secs > 0) return Math.min(secs * 1000, 30000);
  // 0.6s, 1.2s, 2.4s, 4.8s ... with a little jitter so a batch does not
  // resynchronise on the same second and get throttled together again.
  return Math.min(600 * Math.pow(2, attempt) + Math.floor(Math.random() * 250), 30000);
}

/**
 * One streamed completion. Calls onEvent with every parsed SSE payload.
 *
 * The payloads are handed over untouched. The renderer already knows how to
 * read a delta, a reasoning trace and llama.cpp's timings block, and that
 * reading is not provider-specific -- so this forwards frames rather than
 * inventing a second wire format to translate into.
 */
async function chatActive(requestId, req, onEvent) {
  var id = active;
  var base = baseOf(id);
  if (!base) throw new Error(PROVIDERS[id].label + ' 還沒有設定服務位址');
  var pictures = hasImages(req.messages);
  if (pictures && !acceptsImages(id)) {
    var blind = new Error(PROVIDERS[id].label + ' 這個通道不接受圖片：模型沒有視覺能力。' +
      '讀掃描頁要到「系統 → 核心模型」換一個看得懂圖片的模型。');
    blind.code = 'ENOVISION';
    throw blind;
  }

  var ctl = new AbortController();
  inflight.set(requestId, ctl);
  try {
    var body = shapeBody(req);
    // Anything this provider has already refused is left out from the start.
    Object.keys(refused[id] || {}).forEach(function (f) { delete body[f]; });
    var omitted = applyOmissions(body, req.omit);

    var url = base + '/chat/completions';
    var headers = headersOf(id);
    var res = null;
    var dropped = [];
    /* Two different retries share this loop, and they are not the same thing:
       a 400 naming a field is answered by asking for less, a 429 or a 5xx by
       asking again later. The field budget is DROPPABLE.length; the waiting
       budget is the caller's and defaults to none. */
    var waits = Math.max(0, Math.min(Number(req.retry) || 0, 6));
    var waited = 0;
    for (var round = 0; round <= DROPPABLE.length + waits; round++) {
      res = await fetch(url, {
        method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctl.signal
      });
      if (res.ok) break;
      var detail = await res.text().catch(function () { return ''; });
      /* A picture the model cannot see is not a field to drop nor a moment to
         wait out. llama-server without an mmproj answers 500 "image input is
         not supported"; a text-only hosted model answers 400 naming image_url.
         Both are the same fact, and retrying either is the same waste. */
      if (pictures && /image|vision|multimodal|mmproj|visual/i.test(detail)) {
        var cannot = new Error('這個模型讀不了圖片：' + detail.slice(0, 200) +
          '。讀掃描頁要到「系統 → 核心模型」換一個看得懂圖片的模型。');
        cannot.code = 'ENOVISION';
        throw cannot;
      }
      if (TRANSIENT.indexOf(res.status) >= 0) {
        /* Out of patience. Said in one sentence rather than as the provider's
           raw body, because "we waited four times and it kept saying 429" is a
           different thing to know than "429". */
        if (waited >= waits) {
          throw new Error(waits
            ? '供應商連續回應 HTTP ' + res.status + '，已退避重試 ' + waited + ' 次仍未成功'
            : 'HTTP ' + res.status + ': ' + detail.slice(0, 240));
        }
        var pause = retryDelay(waited, res);
        waited++;
        emit(id + ' answered ' + res.status + ', waiting ' + pause + 'ms (' + waited + '/' + waits + ')', 'warn');
        // eslint-disable-next-line no-await-in-loop
        await new Promise(function (r, rej) {
          /* A stop button must not be held up by a backoff that is still
             sleeping -- and what comes out of it has to be recognisable as an
             abort. Rejecting with a plain Error made a user's stop arrive at
             the caller as an ordinary failure, so a cancelled translation
             reported every paragraph as broken. The listener is removed either
             way; up to six of them would otherwise pile up on one request. */
          var t = null;
          var onAbort = function () { clearTimeout(t); rej(abortError()); };
          t = setTimeout(function () {
            ctl.signal.removeEventListener('abort', onAbort);
            r();
          }, pause);
          ctl.signal.addEventListener('abort', onAbort, { once: true });
        });
        continue;
      }
      /* Read the refusal for the numbers it is refusing over, before deciding
         what to do about it. This is the one moment a provider that documents
         nothing says its limits out loud, and until now nothing listened: both
         of these were written months ago and neither was ever called, so the
         「從伺服器的錯誤訊息量到的」 source in the model window could not have
         had a value in it. Learning here means the next request is shaped by
         what this deployment actually enforces, not by a table. */
      var learnedCtx = noteLimitFrom(String(confOf(id).model || '').trim(), detail);
      var learnedOut = noteOutLimitFrom(String(confOf(id).model || '').trim(), detail);
      if (learnedCtx) emit(id + ' 說它的 context 上限是 ' + learnedCtx.toLocaleString('en-US'), 'warn');

      /* An output cap we just learned is actionable right here: the body in hand
         is over it, and the same request under the real ceiling is the request
         the caller meant. Retried once, inside the loop that already exists for
         "asked for something this provider will not take". */
      if (learnedOut && Number(body[capFieldOf(id)]) > learnedOut) {
        emit(id + ' 的輸出上限是 ' + learnedOut.toLocaleString('en-US') +
          '，改用上限重試（設定裡是 ' + Number(body[capFieldOf(id)]).toLocaleString('en-US') + '）', 'warn');
        body[capFieldOf(id)] = learnedOut;
        continue;
      }

      var field = res.status === 400 ? refusedField(detail) : null;
      if (!field || !(field in body)) {
        throw new Error('HTTP ' + res.status + ': ' + detail.slice(0, 240));
      }
      delete body[field];
      dropped.push(field);
      refused[id] = refused[id] || {};
      refused[id][field] = true;
      emit(id + ' refused ' + field + ', retrying without it', 'warn');
    }
    if (!res || !res.ok) throw new Error('這個供應商拒絕了每一種請求形狀');

    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var lines = buf.split('\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        var j;
        try { j = JSON.parse(payload); } catch (e) { continue; }
        onEvent(j);
      }
    }
    return { ok: true, provider: id, dropped: dropped, omitted: omitted, waited: waited };
  } finally {
    inflight.delete(requestId);
  }
}

function abortActive(requestId) {
  if (requestId == null) {
    var n = inflight.size;
    inflight.forEach(function (c) { c.abort(); });
    inflight.clear();
    return { aborted: n };
  }
  var ctl = inflight.get(requestId);
  if (!ctl) return { aborted: 0 };
  ctl.abort();
  inflight.delete(requestId);
  return { aborted: 1 };
}

/**
 * Freeze the current provider settings, keys included, into the build's preset.
 *
 * This is the authoring side of `applyPreset`: set the core up the way a new
 * user should find it, export, rebuild, and the next installer carries it.
 *
 * It writes the keys currently held in memory, which is the whole point and also
 * the thing to be careful about -- see the header of `preset.js` for what the
 * encryption around them is worth.
 */
async function exportPreset(opts) {
  var payload = { active: active, providers: conf, secrets: secrets };
  var file = await preset.write(payload, opts || {});
  var withKeys = PROVIDER_IDS.filter(function (id) {
    var s = secrets[id];
    return s && (s.key || (s.headers || []).length);
  });
  return { file: file, active: active, withKeys: withKeys };
}

module.exports = {
  ENDPOINT, LAUNCHER_ENV, LAUNCHER_ARGS_ENV, launcher, splitArgs,
  start, stop, status, health, props, onLog,
  initProviders, providerState, selectProvider, configureProvider,
  setSecret, forgetSecret, probeActive, tokenizeActive, chatActive, abortActive,
  listModels, localEndpoint, exportPreset, hasImages, acceptsImages,
  isLocalActive: function () { return active === 'local'; },
  PROVIDER_IDS, EFFORT_LADDER
};
