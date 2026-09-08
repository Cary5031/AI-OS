'use strict';

/* ===========================================================================
   AI-OS // local mail mirror
   ---------------------------------------------------------------------------
   A copy of the mailbox, on this machine, that the mail application reads
   instead of the server. Fetching is a sync; everything else is local.

   Why a mirror at all: it makes mail *data* rather than a live connection --
   readable offline, fast to list, and something the journal and undo can talk
   about like anything else here.

   ---------------------------------------------------------------------------
   Two decisions worth keeping:

   1. It lives in the sandbox's reserved `.mail`, not under an ordinary path.
      `fs.read` is granted by default, so a mailbox at /mail/ would let anything
      read any message without ever holding `mail.read`. `sandbox.resolve`
      throws ERESERVED for reserved names, which closes every fs.* route; this
      module reaches the directory directly, in the process where the capability
      is actually checked.

   2. Everything is keyed by `Message-ID`, not by IMAP UID. A UID is per-folder
      and the whole space is invalidated when UIDVALIDITY changes, so a deletion
      remembered against a UID comes back to life the moment the server
      renumbers or the message moves. A message that returns after you deleted
      it is worse than no delete at all.
   =========================================================================== */

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const sandbox = require('./sandbox');

/* Bodies are kept whole, so a mailbox can grow. The cap is on the mirror rather
   than on the mailbox: past it the oldest messages lose their bodies and keep
   their headers, so the list stays complete and re-syncing can refill them. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

let root = null;          // <sandbox>/.mail
let account = null;       // the account key this store belongs to
let index = null;         // messageId -> summary
let local = null;         // messageId -> local-only state
let cursors = null;       // folder -> { uidValidity, highestUid }
let dirty = false;

/** A filename that cannot collide or escape, from a header that can be anything. */
function keyOf(messageId) {
  return crypto.createHash('sha1').update(String(messageId)).digest('hex');
}

/* An account can be re-added with a different address; keeping the stores apart
   means the second one does not inherit the first one's tombstones. */
function accountKey(email) {
  return crypto.createHash('sha1').update(String(email || 'unknown').toLowerCase())
    .digest('hex').slice(0, 16);
}

function paths() {
  const base = path.join(root, account);
  return {
    base,
    index: path.join(base, 'index.json'),
    local: path.join(base, 'local.json'),
    cursors: path.join(base, 'cursors.json'),
    bodies: path.join(base, 'bodies')
  };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

async function init(email) {
  root = path.join(sandbox.root(), sandbox.MAIL_DIR);
  account = accountKey(email);
  const p = paths();
  await fs.mkdir(p.bodies, { recursive: true });
  index = await readJson(p.index, {});
  local = await readJson(p.local, {});
  cursors = await readJson(p.cursors, {});
  dirty = false;
  return stats();
}

function ready() {
  return !!(root && account);
}

async function flush() {
  if (!ready() || !dirty) return false;
  const p = paths();
  await fs.mkdir(p.base, { recursive: true });
  await fs.writeFile(p.index, JSON.stringify(index), 'utf8');
  await fs.writeFile(p.local, JSON.stringify(local), 'utf8');
  await fs.writeFile(p.cursors, JSON.stringify(cursors), 'utf8');
  dirty = false;
  return true;
}

function stats() {
  const ids = Object.keys(index || {});
  const deleted = ids.filter((id) => (local[id] || {}).deleted).length;
  return {
    account,
    messages: ids.length - deleted,
    deleted,
    folders: [...new Set(ids.map((id) => index[id].folder))],
    lastSync: Math.max(0, ...Object.values(cursors || {}).map((c) => c.at || 0))
  };
}

/* ------------------------------------------------------------------ writing */

/**
 * Add or refresh one message.
 *
 * The server's own flags are merged, never assigned: a message the user marked
 * read here must not go back to unread because the sync ran before the flag was
 * pushed. Local state is untouched -- that is the whole point of the mirror.
 */
function put(msg) {
  if (!msg || !msg.messageId) return null;
  const id = String(msg.messageId);
  const before = index[id] || {};
  index[id] = {
    messageId: id,
    uid: msg.uid != null ? msg.uid : before.uid,
    folder: msg.folder || before.folder || 'INBOX',
    from: msg.from || before.from || '',
    fromName: msg.fromName || before.fromName || '',
    to: msg.to || before.to || '',
    cc: msg.cc || before.cc || '',
    subject: msg.subject || before.subject || '(無主旨)',
    date: msg.date || before.date || 0,
    seen: msg.seen !== undefined ? !!msg.seen : !!before.seen,
    hasBody: before.hasBody || false,
    inReplyTo: msg.inReplyTo || before.inReplyTo || '',
    references: msg.references || before.references || ''
  };
  dirty = true;
  return index[id];
}

async function putBody(messageId, body) {
  if (!index[messageId]) return false;
  const text = String(body == null ? '' : body).slice(0, MAX_MESSAGE_BYTES);
  const p = paths();
  await fs.mkdir(p.bodies, { recursive: true });
  await fs.writeFile(path.join(p.bodies, keyOf(messageId) + '.txt'), text, 'utf8');
  index[messageId].hasBody = true;
  dirty = true;
  return true;
}

async function body(messageId) {
  if (!index[messageId] || !index[messageId].hasBody) return null;
  try {
    return await fs.readFile(path.join(paths().bodies, keyOf(messageId) + '.txt'), 'utf8');
  } catch (e) {
    return null;
  }
}

/* --------------------------------------------------------------- local state

   Deletion is a tombstone rather than a removal: the message stays on the
   server, so the next sync would fetch it again and a removed row would come
   back. The tombstone is what makes 「刪掉的信不會復活」 true. */

function setLocal(messageId, patch) {
  if (!index[messageId]) return null;
  const cur = local[messageId] || {};
  local[messageId] = {
    deleted: patch.deleted !== undefined ? !!patch.deleted : !!cur.deleted,
    starred: patch.starred !== undefined ? !!patch.starred : !!cur.starred,
    folder: patch.folder !== undefined ? String(patch.folder || '') : (cur.folder || ''),
    seen: patch.seen !== undefined ? !!patch.seen : cur.seen,
    at: Date.now()
  };
  dirty = true;
  return local[messageId];
}

function localOf(messageId) {
  return local[messageId] || {};
}

/** The message as the application should see it: server data plus local edits. */
function viewOf(id) {
  const m = index[id];
  if (!m) return null;
  const l = local[id] || {};
  return {
    ...m,
    // Local read state wins: the user read it here, whether or not the flag has
    // reached the server yet.
    seen: l.seen !== undefined ? l.seen : m.seen,
    starred: !!l.starred,
    deleted: !!l.deleted,
    folder: l.folder || m.folder
  };
}

function list({ folder = null, includeDeleted = false, limit = 200, search = '' } = {}) {
  const q = String(search || '').toLowerCase();
  const out = [];
  for (const id of Object.keys(index)) {
    const v = viewOf(id);
    if (!v) continue;
    if (!includeDeleted && v.deleted) continue;
    if (folder && v.folder !== folder) continue;
    if (q && !(v.subject + ' ' + v.from + ' ' + v.fromName).toLowerCase().includes(q)) continue;
    out.push(v);
  }
  out.sort((a, b) => (b.date || 0) - (a.date || 0));
  return out.slice(0, limit);
}

function get(messageId) {
  return viewOf(messageId);
}

/** Which of these the store has never seen, so a sync only fetches new bodies. */
function unknown(ids) {
  return ids.filter((id) => !index[id]);
}

function cursor(folder) {
  return cursors[folder] || { uidValidity: 0, highestUid: 0, at: 0 };
}

function setCursor(folder, next) {
  cursors[folder] = { ...cursor(folder), ...next, at: Date.now() };
  dirty = true;
  return cursors[folder];
}

/**
 * Total size of stored bodies, and a trim when it runs past the cap.
 *
 * Headers are never dropped: losing them would make the list wrong, and the
 * list is what the application is. A body can always be fetched again.
 */
async function trim() {
  const p = paths();
  let files;
  try {
    files = await fs.readdir(p.bodies);
  } catch (e) {
    return { bytes: 0, dropped: 0 };
  }
  const stat = [];
  let bytes = 0;
  for (const f of files) {
    try {
      const s = await fs.stat(path.join(p.bodies, f));
      bytes += s.size;
      stat.push({ f, size: s.size, mtime: s.mtimeMs });
    } catch (e) { /* vanished under us */ }
  }
  if (bytes <= MAX_BODY_BYTES) return { bytes, dropped: 0 };

  stat.sort((a, b) => a.mtime - b.mtime);
  const byKey = {};
  for (const id of Object.keys(index)) byKey[keyOf(id) + '.txt'] = id;

  let dropped = 0;
  for (const s of stat) {
    if (bytes <= MAX_BODY_BYTES * 0.8) break;
    try {
      await fs.unlink(path.join(p.bodies, s.f));
      bytes -= s.size;
      dropped++;
      const id = byKey[s.f];
      if (id && index[id]) { index[id].hasBody = false; dirty = true; }
    } catch (e) { /* already gone */ }
  }
  return { bytes, dropped };
}

/** Forget everything for this account: used when the account is removed. */
async function purge() {
  if (!ready()) return false;
  await fs.rm(paths().base, { recursive: true, force: true });
  index = {};
  local = {};
  cursors = {};
  dirty = false;
  return true;
}

module.exports = {
  init, ready, flush, stats,
  put, putBody, body, get, list, unknown,
  setLocal, localOf,
  cursor, setCursor,
  trim, purge,
  keyOf, accountKey
};
