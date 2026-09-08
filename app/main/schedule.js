'use strict';

/* ===========================================================================
   AI-OS // scheduler
   ---------------------------------------------------------------------------
   Things this machine does on its own clock: every five minutes fetch mail,
   every morning summarise the inbox, every hour run the backup program.

   The clock lives here, in the main process, and the work lives in the
   renderer -- an intent is planned by the kernel, an action is one of an
   installed program's own verbs, and both exist only on that side. So this
   file keeps the jobs, decides what is due, fires it across the bridge, and
   records what came back. It never executes anything itself.

   Two kinds of job, because they cost different things. An `action` job runs
   a program's verb directly (`app.do mail sync`) and costs no model call at
   all; an `intent` job hands a sentence to the planner every time it fires,
   which on a hosted core is money every time. The scheduler window says which
   is which.

   Jobs run only while AI-OS is open. This is a desktop program, not a service:
   a job that came due while the machine was closed runs once, shortly after
   the next boot, marked as a catch-up, and then returns to its rhythm.

   A firing marks the job running until the renderer reports back; a second
   firing cannot pile onto the first. A run that never reports -- a consent
   dialog nobody answered, a planner that hung -- is timed out here so the job
   is not stuck forever, and the timeout is recorded as the run's result.
   =========================================================================== */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MIN_EVERY = 10;                    // seconds
const MAX_EVERY = 30 * 24 * 3600;        // a month
const TICK_MS = 5000;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const CATCHUP_DELAY_MS = 20 * 1000;      // after boot, before a missed job runs
const MAX_JOBS = 100;
const KINDS = ['intent', 'action'];

let file = null;
let state = { version: 1, jobs: {} };
let sender = null;       // (payload) => void, delivers a firing to the renderer
let ready = false;       // the renderer has installed its handler
let ticker = null;
let clock = () => Date.now();

/* -------------------------------------------------------------------- setup */

async function init(userDataDir) {
  file = path.join(userDataDir, 'schedule.json');
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (raw && raw.jobs && typeof raw.jobs === 'object') state = { version: raw.version || 1, jobs: raw.jobs };
  } catch {
    state = { version: 1, jobs: {} };
  }
  /* Nothing is running when we start: a `running` flag on disk is from a
     process that ended mid-run. And a job that came due while the machine was
     closed runs once, soon, as a catch-up rather than being silently dropped or
     fired the instant the window appears. */
  const t = clock();
  for (const job of Object.values(state.jobs)) {
    delete job.running;
    delete job.runningSince;
    if (job.enabled && Number.isFinite(job.nextRun) && job.nextRun <= t) {
      job.missed = true;
      job.nextRun = t + CATCHUP_DELAY_MS;
    }
  }
  await save();
  return { count: Object.keys(state.jobs).length };
}

async function save() {
  if (!file) return;
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }
function setReady(on) { ready = !!on; }
function setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); }

/* ---------------------------------------------------------------- shaping */

/** "5m", "2h", "1d", "30s", or a number of seconds. */
function parseEvery(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const s = String(v == null ? '' : v).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|秒|分|分鐘|小時|時|天|日)?$/.exec(s);
  if (!m) return NaN;
  const n = Number(m[1]);
  const unit = m[2] || 's';
  const mult = /^(m|min|mins|分|分鐘)$/.test(unit) ? 60
    : /^(h|hr|hrs|小時|時)$/.test(unit) ? 3600
      : /^(d|day|days|天|日)$/.test(unit) ? 86400 : 1;
  return Math.round(n * mult);
}

function fail(msg, code) {
  return Object.assign(new Error(msg), { code: code || 'EINVAL' });
}

/** A job as the store keeps it, from whatever the caller sent. */
function normalise(input, existing) {
  const src = input && typeof input === 'object' ? input : {};
  const base = existing || {};
  const kind = KINDS.includes(src.kind) ? src.kind
    : (src.intent !== undefined || (!src.app && !src.action && base.kind === 'intent')) ? 'intent'
      : (src.app !== undefined || src.action !== undefined) ? 'action'
        : (base.kind || 'intent');

  const job = {
    name: String(src.name !== undefined ? src.name : base.name || '').trim().slice(0, 60),
    every: src.every !== undefined ? parseEvery(src.every) : base.every,
    kind,
    enabled: src.enabled !== undefined ? !!src.enabled : (base.enabled !== undefined ? base.enabled : true)
  };
  if (!job.name) throw fail('排程要有名稱');
  if (!Number.isFinite(job.every)) throw fail('every 看不懂：給秒數，或 "5m" / "2h" / "1d"');
  if (job.every < MIN_EVERY) throw fail('間隔最短 ' + MIN_EVERY + ' 秒');
  if (job.every > MAX_EVERY) throw fail('間隔最長 30 天');

  if (kind === 'intent') {
    job.intent = String(src.intent !== undefined ? src.intent : base.intent || '').trim().slice(0, 2000);
    if (!job.intent) throw fail('intent 要是一句要做的事');
  } else {
    job.app = String(src.app !== undefined ? src.app : base.app || '').trim().toLowerCase().slice(0, 80);
    job.action = String(src.action !== undefined ? src.action : base.action || '').trim().slice(0, 80);
    const args = src.args !== undefined ? src.args : base.args;
    job.args = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    if (!job.app || !job.action) throw fail('程式動作要有 app 與 action');
    if (JSON.stringify(job.args).length > 4000) throw fail('args 太大');
  }
  return job;
}

/* ------------------------------------------------------------------- jobs */

function view(job) {
  const t = clock();
  return {
    ...job,
    running: !!job.running,
    dueIn: job.enabled && Number.isFinite(job.nextRun) ? Math.max(0, Math.round((job.nextRun - t) / 1000)) : null
  };
}

function list() {
  return Object.values(state.jobs)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(view);
}

function get(id) {
  const job = state.jobs[String(id || '')];
  if (!job) throw fail('沒有這個排程：' + id, 'ENOENT');
  return job;
}

/** By id, or by exact name, or by unique name prefix. */
function find(ref) {
  const key = String(ref || '').trim();
  if (state.jobs[key]) return state.jobs[key];
  const all = Object.values(state.jobs);
  const exact = all.filter((j) => j.name === key);
  if (exact.length === 1) return exact[0];
  const prefix = all.filter((j) => j.name.indexOf(key) === 0);
  if (key && prefix.length === 1) return prefix[0];
  throw fail('沒有這個排程：' + key + (prefix.length > 1 ? '（有 ' + prefix.length + ' 個名稱都符合）' : ''), 'ENOENT');
}

async function add(input) {
  if (Object.keys(state.jobs).length >= MAX_JOBS) throw fail('排程最多 ' + MAX_JOBS + ' 個');
  const job = normalise(input, null);
  job.id = crypto.randomBytes(6).toString('hex');
  job.createdAt = clock();
  job.runs = 0;
  job.lastRun = null;
  job.lastResult = null;
  job.nextRun = clock() + job.every * 1000;
  state.jobs[job.id] = job;
  await save();
  return view(job);
}

async function update(id, patch) {
  const job = get(id);
  const next = normalise(patch, job);
  const everyChanged = next.every !== job.every;
  Object.assign(job, next);
  delete job.intent; delete job.app; delete job.action; delete job.args;
  if (next.kind === 'intent') job.intent = next.intent; else { job.app = next.app; job.action = next.action; job.args = next.args; }
  if (everyChanged || (next.enabled && !Number.isFinite(job.nextRun))) job.nextRun = clock() + job.every * 1000;
  await save();
  return view(job);
}

async function remove(id) {
  const job = get(id);
  delete state.jobs[job.id];
  await save();
  return { id: job.id, name: job.name, removed: true };
}

/* ---------------------------------------------------------------- firing */

function fire(job, reason) {
  if (!sender) return false;
  job.running = true;
  job.runningSince = clock();
  delete job.missed;
  sender({
    id: job.id, name: job.name, kind: job.kind, intent: job.intent,
    app: job.app, action: job.action, args: job.args, reason
  });
  return true;
}

async function runNow(id) {
  const job = get(id);
  if (job.running) throw fail('這個排程正在執行中', 'EBUSY');
  if (!ready || !sender) throw fail('畫面還沒準備好，無法執行', 'EAGAIN');
  fire(job, 'manual');
  await save();
  return view(job);
}

async function report(id, result) {
  const job = get(id);
  const t = clock();
  job.running = false;
  const startedAt = job.runningSince;
  delete job.runningSince;
  job.runs = (job.runs || 0) + 1;
  job.lastRun = t;
  job.lastResult = {
    ok: !!(result && result.ok),
    note: String((result && result.note) || '').slice(0, 400),
    ms: Number.isFinite(result && result.ms) ? result.ms : (startedAt ? t - startedAt : null),
    at: t
  };
  /* From now, not from when it was due: a run that took a minute should not
     make the next one a minute early, and a job that fell behind should not
     fire back-to-back to catch up. */
  job.nextRun = t + job.every * 1000;
  await save();
  return view(job);
}

/** One pass: time out the stuck, fire the due. Exposed for tests. */
async function tick() {
  if (!ready || !sender) return { fired: [], timedOut: [] };
  const t = clock();
  const fired = [];
  const timedOut = [];
  for (const job of Object.values(state.jobs)) {
    if (job.running) {
      if (t - (job.runningSince || t) > RUN_TIMEOUT_MS) {
        timedOut.push(job.id);
        // eslint-disable-next-line no-await-in-loop
        await report(job.id, { ok: false, note: '逾時：' + Math.round(RUN_TIMEOUT_MS / 60000) + ' 分鐘內沒有回報（可能在等授權視窗，或規劃卡住了）' });
      }
      continue;
    }
    if (!job.enabled || !Number.isFinite(job.nextRun) || job.nextRun > t) continue;
    const reason = job.missed ? 'missed' : 'due';
    if (fire(job, reason)) fired.push(job.id);
  }
  if (fired.length || timedOut.length) await save();
  return { fired, timedOut };
}

function start() {
  if (ticker) return;
  ticker = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (ticker.unref) ticker.unref();
}

function stop() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

module.exports = {
  init, list, add, update, remove, runNow, report, find, get,
  tick, start, stop, setSender, setReady, setClock, parseEvery, normalise,
  MIN_EVERY, MAX_EVERY, RUN_TIMEOUT_MS, CATCHUP_DELAY_MS, TICK_MS, KINDS
};
