'use strict';

/* ===========================================================================
   AI-OS // long-term memory
   ---------------------------------------------------------------------------
   The warm tier of this machine's memory hierarchy: facts that outlive a
   session and get paged into context when they look relevant.

   Two deliberate decisions:

     1. Nothing is seeded. An empty memory on first boot is honest; inventing
        facts about the user and presenting them as remembered would not be.
        Everything here arrives either because the user typed it or because a
        turn taught it, and every item records which.

     2. It lives in userData, not in the sandbox. The model may rewrite anything
        in the sandbox at will, and a memory store the model can silently edit
        is a memory store that can be poisoned by a file the user dragged in.
        Writes go through the mem.write capability instead.
   =========================================================================== */

const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_ITEMS = 500;
const MAX_TEXT = 600;

let file = null;
let store = { version: 1, items: [] };
let dirty = false;
let flushTimer = null;

/* ------------------------------------------------------------------- setup */

async function init(userDataDir) {
  file = path.join(userDataDir, 'memory.json');
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (raw && Array.isArray(raw.items)) {
      store = { version: raw.version || 1, items: raw.items.filter(valid) };
    }
  } catch {
    // First run. Deliberately empty: see the note at the top of this file.
    store = { version: 1, items: [] };
  }
  return summary();
}

function valid(it) {
  return it && typeof it.id === 'string' && typeof it.text === 'string' && it.text.trim();
}

async function flush() {
  if (!dirty || !file) return;
  dirty = false;
  const tmp = file + '.tmp';
  const body = JSON.stringify(store, null, 2);
  // Write to a sibling then rename: a half-written memory file on a crash
  // would lose everything the user has taught this machine.
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, file);
}

/** Coalesce bursts of edits, but never leave data unwritten for long. */
function touchDirty() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => { dirty = true; });
  }, 400);
}

function summary() {
  const bySource = {};
  for (const it of store.items) bySource[it.source] = (bySource[it.source] || 0) + 1;
  return { count: store.items.length, bySource, pinned: store.items.filter((i) => i.pinned).length };
}

/* --------------------------------------------------------------- retrieval */

/**
 * Character-bigram overlap, biased by pinning and past usefulness. Crude and
 * entirely local, which is the point: retrieval has to be cheap enough to run
 * before every single turn.
 */
function search(query, limit = 4) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, '');
  if (q.length < 2) return [];

  const grams = [];
  for (let i = 0; i < q.length - 1; i++) grams.push(q.slice(i, i + 2));

  const scored = [];
  for (const it of store.items) {
    const hay = (it.text + ' ' + (it.tags || []).join(' ')).toLowerCase();
    let hits = 0;
    for (const g of grams) if (hay.includes(g)) hits++;
    let score = hits / grams.length;
    if (!score) continue;
    if (it.pinned) score += 0.35;
    score += Math.min(0.15, (it.useCount || 0) * 0.01);
    scored.push({ item: it, score: Math.min(1, score) });
  }

  return scored
    .filter((r) => r.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Record that an item earned its place in context. */
function markUsed(ids) {
  const now = Date.now();
  for (const id of ids || []) {
    const it = store.items.find((x) => x.id === id);
    if (it) { it.useCount = (it.useCount || 0) + 1; it.lastUsed = now; }
  }
  touchDirty();
}

/* ----------------------------------------------------------------- editing */

function newId() {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function normalise(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

/** Near-duplicate check, so learning the same fact twice does not accumulate. */
function findSimilar(text) {
  const a = normalise(text).toLowerCase();
  if (!a) return null;
  for (const it of store.items) {
    const b = it.text.toLowerCase();
    if (b === a) return it;
    if (a.length > 12 && (b.includes(a) || a.includes(b))) return it;
  }
  return null;
}

function add({ text, tags, source, pinned } = {}) {
  const clean = normalise(text);
  if (!clean) throw new Error('記憶內容是空的');

  const dup = findSimilar(clean);
  if (dup) {
    // Keep the longer phrasing, and promote it to manual if a human typed it.
    if (clean.length > dup.text.length) dup.text = clean;
    if (source === 'manual') dup.source = 'manual';
    dup.updatedAt = Date.now();
    touchDirty();
    return { item: dup, deduped: true };
  }

  if (store.items.length >= MAX_ITEMS) {
    // Evict the least useful unpinned item rather than refusing to learn.
    const victim = store.items
      .filter((i) => !i.pinned)
      .sort((a, b) => (a.useCount || 0) - (b.useCount || 0) || (a.lastUsed || 0) - (b.lastUsed || 0))[0];
    if (!victim) throw new Error(`記憶已滿（${MAX_ITEMS} 筆），而且全部被釘選`);
    store.items = store.items.filter((i) => i !== victim);
  }

  const item = {
    id: newId(),
    text: clean,
    tags: Array.isArray(tags) ? tags.slice(0, 8).map((t) => String(t).slice(0, 24)) : [],
    source: source === 'learned' ? 'learned' : 'manual',
    pinned: !!pinned,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    useCount: 0,
    lastUsed: 0
  };
  store.items.push(item);
  touchDirty();
  return { item, deduped: false };
}

function update(id, patch = {}) {
  const it = store.items.find((x) => x.id === id);
  if (!it) throw new Error('找不到這筆記憶：' + id);
  if (patch.text !== undefined) {
    const clean = normalise(patch.text);
    if (!clean) throw new Error('記憶內容不能清空，要刪除請用刪除');
    it.text = clean;
  }
  if (patch.tags !== undefined) {
    it.tags = Array.isArray(patch.tags) ? patch.tags.slice(0, 8).map((t) => String(t).slice(0, 24)) : [];
  }
  if (patch.pinned !== undefined) it.pinned = !!patch.pinned;
  // Editing by hand makes it the user's statement, whatever taught it first.
  if (patch.text !== undefined) it.source = 'manual';
  it.updatedAt = Date.now();
  touchDirty();
  return it;
}

function remove(id) {
  const before = store.items.length;
  const gone = store.items.find((x) => x.id === id) || null;
  store.items = store.items.filter((x) => x.id !== id);
  if (store.items.length === before) throw new Error('找不到這筆記憶：' + id);
  touchDirty();
  return gone;
}

function list() {
  return store.items
    .slice()
    .sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
}

/**
 * Learn from a turn. The model proposes candidate facts; anything already known
 * is merged rather than duplicated. Marked 'learned' so the memory manager can
 * show where each item came from and the user can disown it.
 */
function learn(candidates) {
  const added = [];
  const merged = [];
  for (const c of (candidates || []).slice(0, 5)) {
    const text = typeof c === 'string' ? c : (c && c.text);
    if (!normalise(text)) continue;
    try {
      const r = add({ text, tags: (c && c.tags) || ['learned'], source: 'learned' });
      (r.deduped ? merged : added).push(r.item);
    } catch { /* full and all pinned: skip silently */ }
  }
  return { added, merged };
}

/* ------------------------------------------------------- export and import */

function exportAll() {
  return { version: store.version, exportedAt: Date.now(), items: list() };
}

/** Import is additive and deduping: it never wipes what is already known. */
function importAll(payload) {
  const items = payload && Array.isArray(payload.items) ? payload.items : null;
  if (!items) throw new Error('匯入格式不對：需要 { items: [...] }');
  let added = 0;
  let skipped = 0;
  for (const raw of items.slice(0, MAX_ITEMS)) {
    try {
      const r = add({
        text: raw.text,
        tags: raw.tags,
        source: raw.source === 'learned' ? 'learned' : 'manual',
        pinned: !!raw.pinned
      });
      if (r.deduped) skipped++; else added++;
    } catch { skipped++; }
  }
  return { added, skipped, total: store.items.length };
}

module.exports = {
  init, flush, summary,
  list, search, markUsed,
  add, update, remove, learn,
  exportAll, importAll,
  MAX_ITEMS, MAX_TEXT
};
