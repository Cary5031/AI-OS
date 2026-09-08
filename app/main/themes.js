'use strict';

/* ===========================================================================
   AI-OS // custom themes (the store)
   ---------------------------------------------------------------------------
   The palettes a person made for themselves. Kept beside ui-prefs.json for the
   same reason the language and the text size are: a cleared session must not
   take them away, and the sandbox is writable by the model, which must not be
   able to hand the next boot a palette nobody chose.

   What is stored is the choice, not the result: {id, name, mode, primary,
   overrides}. The renderer derives every colour that is not overridden from
   the primary at load (renderer/themer.js), so this file never holds a stale
   copy of an algorithm's output. Every value is checked here before it is
   written -- a colour is six hex digits, a mode is dark or light, a name is
   short and printable -- because the renderer generates CSS from these and a
   string that is not a colour would land inside a stylesheet.

   The file is written before memory is updated, and writes are queued: what
   list() answers is what is on disk, and two saves cannot interleave on the
   one temporary file.
   =========================================================================== */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/* The eleven colours a theme may override. The same list, in the same order,
   as renderer/themer.js KEYS; wiring.test.js pins the two together. */
const KEYS = ['bg-0', 'bg-1', 'fg', 'fg-dim', 'fg-faint', 'accent', 'accent-2', 'warn', 'danger', 'taint', 'on-fill'];
const MODES = ['dark', 'light'];
const MAX_THEMES = 32;
const NAME_MAX = 40;
/* Two letters that no built-in starts with, then the random part. The id is
   the data-theme value and a CSS selector, so the alphabet is deliberately
   tiny. */
const ID_RE = /^u-[a-z0-9]{6,16}$/;
const HEX_RE = /^#[0-9a-f]{6}$/;
const VERSION = 1;

let file = null;
let themes = [];
/* Writes happen one after another, whatever order the calls arrive in. */
let chain = Promise.resolve();

function fail(msg, code) {
  throw Object.assign(new Error(msg), { code: code || 'EINVAL' });
}

function hex(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return HEX_RE.test(s) ? s : null;
}

function num(v) {
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/**
 * Characters a name must not carry: C0 and C1 controls, and the invisible
 * ones that make a blank or a look-alike name -- zero-width joiners and
 * spaces, bidi overrides and isolates, the byte-order mark. Written as code
 * comparisons rather than a character class, because the tools that edit this
 * file turn escape sequences into the characters themselves.
 */
function printable(ch) {
  const c = ch.codePointAt(0);
  if (c < 32 || (c >= 127 && c < 160)) return false;
  if (c >= 0x200b && c <= 0x200f) return false;   // zero-width space/joiner, marks
  if (c >= 0x202a && c <= 0x202e) return false;   // bidi embeddings and overrides
  if (c >= 0x2060 && c <= 0x2064) return false;   // word joiner, invisible operators
  if (c >= 0x2066 && c <= 0x2069) return false;   // bidi isolates
  if (c === 0xfeff || c === 0x00ad) return false; // BOM, soft hyphen
  return true;
}

function newId(taken) {
  let id;
  do { id = 'u-' + crypto.randomBytes(5).toString('hex'); } while (taken.some((t) => t.id === id));
  return id;
}

/**
 * One record, checked field by field. `others` is the list a duplicate name
 * is checked against; a record being updated is excused from matching itself.
 */
function sanitise(rec, others) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const name = Array.from(String(r.name == null ? '' : r.name)).filter(printable).join('').trim();
  if (!name) fail('主題要有名稱');
  if (name.length > NAME_MAX) fail(`名稱太長（最多 ${NAME_MAX} 字）`);
  const id = r.id == null || r.id === '' ? null : String(r.id);
  if (id !== null && !ID_RE.test(id)) fail('主題代號格式不對：' + id);
  if (!MODES.includes(r.mode)) fail('明暗要是 dark 或 light');
  const primary = hex(r.primary);
  if (!primary) fail('主色調要是 #rrggbb 格式');
  const overrides = {};
  if (r.overrides !== undefined && r.overrides !== null) {
    if (typeof r.overrides !== 'object' || Array.isArray(r.overrides)) fail('overrides 要是物件');
    for (const k of Object.keys(r.overrides)) {
      if (!KEYS.includes(k)) fail('不認得的顏色項目：' + k);
      const v = hex(r.overrides[k]);
      if (!v) fail(k + ' 要是 #rrggbb 格式');
      overrides[k] = v;
    }
  }
  const dup = (others || []).find((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase());
  if (dup) fail('已經有一個叫「' + name + '」的自訂主題', 'EEXIST');
  return { id, name, mode: r.mode, primary, overrides, createdAt: num(r.createdAt), updatedAt: num(r.updatedAt) };
}

async function init(userDataDir) {
  file = path.join(userDataDir, 'custom-themes.json');
  const next = [];
  let raw = null;
  try { raw = JSON.parse(await fs.readFile(file, 'utf8')); } catch { raw = null; }
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.themes) ? raw.themes : []);
  let dropped = 0;
  for (const t of list) {
    /* A bad entry is dropped, not fatal: one corrupt colour must not take the
       other themes with it, and must not stop the machine booting. The cap
       holds here too, so a hand-edited file cannot load a thousand. */
    if (next.length >= MAX_THEMES) { dropped++; continue; }
    try {
      const clean = sanitise(t, next);
      clean.id = clean.id && !next.some((x) => x.id === clean.id) ? clean.id : newId(next);
      next.push(clean);
    } catch { dropped++; }
  }
  themes = next;
  return { count: themes.length, dropped };
}

function copy(t) {
  return { ...t, overrides: { ...t.overrides } };
}

function list() {
  return themes.map(copy);
}

/** Write `next` to disk; only when that succeeded does it become the list. */
async function commit(next) {
  if (file) {
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({ version: VERSION, themes: next }, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }
  themes = next;
}

/** Run `fn` after every earlier write has finished, whether or not it succeeded. */
function queued(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/** Add or replace. A record whose id is unknown here is a new theme and gets a fresh id. */
function save(rec) {
  return queued(async () => {
    const clean = sanitise(rec, themes);
    const now = Date.now();
    const next = themes.map(copy);
    const at = clean.id ? next.findIndex((t) => t.id === clean.id) : -1;
    if (at >= 0) {
      clean.createdAt = next[at].createdAt || now;
      clean.updatedAt = now;
      next[at] = clean;
    } else {
      if (next.length >= MAX_THEMES) fail(`自訂主題最多 ${MAX_THEMES} 組，先刪掉一些`, 'EFULL');
      clean.id = newId(next);
      clean.createdAt = now;
      clean.updatedAt = now;
      next.push(clean);
    }
    await commit(next);
    return { saved: copy(clean), themes: list() };
  });
}

function remove(id) {
  return queued(async () => {
    const at = themes.findIndex((t) => t.id === String(id || ''));
    if (at < 0) fail('沒有這個自訂主題：' + id, 'ENOENT');
    const next = themes.map(copy);
    const [gone] = next.splice(at, 1);
    await commit(next);
    return { removed: gone.id, name: gone.name, themes: list() };
  });
}

module.exports = { init, list, save, remove, sanitise, KEYS, MODES, MAX_THEMES, NAME_MAX, ID_RE, VERSION };
