'use strict';

/* ===========================================================================
   AI-OS // session persistence
   ---------------------------------------------------------------------------
   What a machine remembers about itself between power cycles: which windows
   were open and where, what was resident in context, what it had done, and the
   settings the user had chosen.

   Stored in userData rather than the sandbox, for the same reason the memory
   store is: the sandbox is writable by the model, and a session file the model
   can rewrite is a way to make the next boot restore something the user never
   asked for.

   Every save keeps the previous file as .bak. Restoring a slightly stale
   desktop beats restoring nothing because the process died mid-write.
   =========================================================================== */

const fs = require('node:fs/promises');
const path = require('node:path');

const VERSION = 2;
const MAX_JOURNAL = 200;
const MAX_PAGES = 60;
const MAX_WINDOWS = 24;

let file = null;
let backup = null;
let last = null;

async function init(userDataDir) {
  file = path.join(userDataDir, 'session.json');
  backup = file + '.bak';
  return stat();
}

async function stat() {
  try {
    const s = await fs.stat(file);
    return { exists: true, savedAt: s.mtimeMs, bytes: s.size };
  } catch {
    return { exists: false };
  }
}

/* A counter that cannot be poisoned by a bad write: anything that is not a
   finite, non-negative number reads as zero rather than as NaN, which would
   spread through every later addition. */
function num(v) {
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** Trim the payload so a runaway session cannot grow without bound. */
function sanitise(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  return {
    version: VERSION,
    savedAt: Date.now(),

    theme: typeof p.theme === 'string' ? p.theme : 'void',
    budget: Number.isFinite(p.budget) ? Math.max(640, Math.min(65536, p.budget)) : 8192,
    /* What the model has cost so far. Kept across restarts on purpose: a total
       that resets when you close the window is not a total, and on a metered
       core the number people need is "since I started using this", not "since
       this window opened". A session written before this existed has no field
       and starts from zero. */
    spend: p.spend && typeof p.spend === 'object' ? {
      prompt: num(p.spend.prompt), output: num(p.spend.output),
      thinking: num(p.spend.thinking), total: num(p.spend.total),
      turns: num(p.spend.turns), since: num(p.spend.since) || Date.now()
    } : null,
    endpoint: typeof p.endpoint === 'string' ? p.endpoint.slice(0, 200) : null,
    // `chips` defaults to true so a session written before the toggle existed
    // does not come back with the starter chips silently gone.
    hud: p.hud && typeof p.hud === 'object' ? {
      left: !!p.hud.left,
      right: !!p.hud.right,
      chips: p.hud.chips === undefined ? true : !!p.hud.chips
    } : null,

    // Window layout. State is app-defined and opaque here, but capped so a
    // buggy app cannot write a megabyte of it into the session file.
    windows: Array.isArray(p.windows) ? p.windows.slice(0, MAX_WINDOWS).map((w) => ({
      appId: String(w.appId || '').slice(0, 64),
      title: String(w.title || '').slice(0, 120),
      kind: String(w.kind || '').slice(0, 24),
      rect: w.rect && typeof w.rect === 'object' ? {
        x: Math.round(w.rect.x) || 0, y: Math.round(w.rect.y) || 0,
        w: Math.round(w.rect.w) || 420, h: Math.round(w.rect.h) || 260
      } : null,
      minimized: !!w.minimized,
      z: Number.isFinite(w.z) ? w.z : 0,
      chatOpen: !!w.chatOpen,
      // The chat panel's thread, capped on its own account. Folding it into
      // `state` would mean a talkative session could push a document's unsaved
      // work past the state cap and lose it to have remembered the chat.
      chat: truncate(w.chat, 12000),
      state: truncate(w.state, 20000)
    })).filter((w) => w.appId) : [],

    context: Array.isArray(p.context) ? p.context.slice(0, MAX_PAGES).map((pg) => ({
      id: String(pg.id || '').slice(0, 200),
      kind: String(pg.kind || 'ui').slice(0, 12),
      label: String(pg.label || '').slice(0, 200),
      text: String(pg.text || '').slice(0, 20000),
      priority: Number.isFinite(pg.priority) ? pg.priority : 50,
      pinned: !!pg.pinned,
      tainted: !!pg.tainted,
      source: pg.source ? String(pg.source).slice(0, 200) : null,
      role: pg.role ? String(pg.role).slice(0, 16) : null,
      tokens: Number.isFinite(pg.tokens) ? pg.tokens : 0
    })).filter((pg) => pg.id) : [],

    journal: Array.isArray(p.journal) ? p.journal.slice(-MAX_JOURNAL).map((j) => ({
      seq: Number.isFinite(j.seq) ? j.seq : 0,
      ts: Number.isFinite(j.ts) ? j.ts : Date.now(),
      op: String(j.op || '').slice(0, 64),
      status: String(j.status || 'ok').slice(0, 16),
      note: String(j.note || '').slice(0, 300),
      reason: String(j.reason || '').slice(0, 300)
      // undo functions are deliberately not persisted: a closure cannot be
      // serialised, and pretending an old entry is still reversible would lie.
    })) : [],

    turnSeq: Number.isFinite(p.turnSeq) ? p.turnSeq : 0,
    seq: Number.isFinite(p.seq) ? p.seq : 0
  };
}

function truncate(value, max) {
  if (value === undefined || value === null) return null;
  let s;
  try { s = JSON.stringify(value); } catch { return null; }
  if (s.length <= max) return value;
  return { __truncated: true, bytes: s.length };
}

async function save(payload) {
  const data = sanitise(payload);
  const body = JSON.stringify(data, null, 2);

  try { await fs.copyFile(file, backup); } catch { /* no previous session */ }
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, file);

  last = data;
  return { savedAt: data.savedAt, bytes: body.length, windows: data.windows.length, pages: data.context.length };
}

async function load() {
  for (const candidate of [file, backup]) {
    try {
      const raw = JSON.parse(await fs.readFile(candidate, 'utf8'));
      if (!raw || typeof raw !== 'object') continue;
      // An older layout is not worth migrating for a desktop snapshot; drop it
      // and let the machine come up clean rather than half-restored.
      if (raw.version !== VERSION) return { ok: false, reason: 'version-mismatch', found: raw.version };
      last = raw;
      return { ok: true, fromBackup: candidate === backup, session: raw };
    } catch { /* try the backup */ }
  }
  return { ok: false, reason: 'none' };
}

async function clear() {
  for (const f of [file, backup]) {
    try { await fs.rm(f, { force: true }); } catch { /* ignore */ }
  }
  last = null;
  return { cleared: true };
}

function cached() {
  return last;
}

module.exports = { init, save, load, clear, stat, cached, VERSION };
