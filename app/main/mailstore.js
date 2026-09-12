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

   3. The store does not know where a message came from. IMAP fills it; so can
      a logged-in webmail session; so could anything else that produces a
      message with a Message-ID. Every feeder writes the same shape through
      put() and putBody(), and everything downstream -- the list, the reader,
      search, the kernel's syscalls -- reads only the store. That is what lets
      the source change without the application noticing.

   4. Search reads bodies. Subject and sender are in the index; the text of a
      message is on disk, one file each, and a search that only looked at the
      index would be the search every mail client already has. The one a person
      actually needs is 「哪封信提到我」, and that is the body.
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

/* Attachments are kept whole too, under their own cap, because they are the
   thing a person most often opens a mail client to get at. Past the cap the
   oldest are dropped and can be fetched again; their names and sizes stay in
   the index, so the reader still says what was attached. */
const MAX_ATTACH_BYTES = 256 * 1024 * 1024;
const MAX_ONE_ATTACHMENT = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 40;

/* Bodies a search has read recently. A search over a few thousand messages is
   a few thousand small file reads, which is fine once and wasteful on every
   keystroke. Bounded, and dropped whole when it fills. */
const BODY_CACHE_MAX = 400;
const bodyCache = new Map();

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
    bodies: path.join(base, 'bodies'),
    attachments: path.join(base, 'attachments')
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
  bodyCache.clear();
  sourceMap = null;
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
    references: msg.references || before.references || '',
    /* Where the message can be opened in the source's own client, when the
       source has one -- a webmail item URL. Absent for IMAP. Kept so a note
       written weeks later can still say 「打開那封信」 and mean it. */
    webLink: msg.webLink || before.webLink || '',
    /* The source's own id for this item, for feeders whose ids are not
       Message-IDs. Never used as a key here; see decision 2 in the header. */
    sourceId: msg.sourceId || before.sourceId || '',
    hasAttachments: msg.hasAttachments !== undefined ? !!msg.hasAttachments
      : (before.hasAttachments || false),
    attachments: Array.isArray(before.attachments) ? before.attachments : []
  };
  dirty = true;
  sourceMap = null;
  return index[id];
}

async function putBody(messageId, body) {
  if (!index[messageId]) return false;
  const text = String(body == null ? '' : body).slice(0, MAX_MESSAGE_BYTES);
  const p = paths();
  await fs.mkdir(p.bodies, { recursive: true });
  await fs.writeFile(path.join(p.bodies, keyOf(messageId) + '.txt'), text, 'utf8');
  index[messageId].hasBody = true;
  bodyCache.delete(messageId);
  dirty = true;
  return true;
}

/**
 * Keep a message's attachments, bytes and all.
 *
 * `list` is `[{name, type, bytes, data}]` where `data` is a Buffer or base64.
 * Written one file per attachment under the message's key; the index keeps
 * only the names and sizes, which is what the reader shows before anybody asks
 * for the bytes. Oversized ones are recorded but not stored, and say so.
 */
async function putAttachments(messageId, list) {
  if (!index[messageId]) return [];
  const p = paths();
  const dir = path.join(p.attachments, keyOf(messageId));
  await fs.rm(dir, { recursive: true, force: true });
  const kept = [];
  const items = (Array.isArray(list) ? list : []).slice(0, MAX_ATTACHMENTS);
  for (let i = 0; i < items.length; i++) {
    const a = items[i] || {};
    const data = Buffer.isBuffer(a.data) ? a.data
      : (typeof a.data === 'string' ? Buffer.from(a.data, 'base64') : null);
    const size = data ? data.length : Number(a.bytes) || 0;
    const entry = {
      i,
      name: String(a.name || '未命名附件').slice(0, 200),
      type: String(a.type || 'application/octet-stream').slice(0, 100),
      bytes: size,
      stored: false
    };
    if (data && size > 0 && size <= MAX_ONE_ATTACHMENT) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, String(i)), data);
      entry.stored = true;
    } else if (size > MAX_ONE_ATTACHMENT) {
      entry.reason = '超過 ' + Math.round(MAX_ONE_ATTACHMENT / 1048576) + ' MiB，沒有存下來';
    } else if (a.reason) {
      /* The feeder knew why it could not get the bytes. Keep its words: 「取不到
         附件內容」 sends the user somewhere, 「沒有存下來」 with no reason does not. */
      entry.reason = String(a.reason).slice(0, 200);
    }
    kept.push(entry);
  }
  index[messageId].attachments = kept;
  index[messageId].hasAttachments = kept.length > 0;
  dirty = true;
  return kept;
}

/** One attachment's bytes, or null when they were never kept or have been trimmed. */
async function attachment(messageId, i) {
  const m = index[messageId];
  if (!m) return null;
  const entry = (m.attachments || []).find((a) => a.i === Number(i));
  if (!entry || !entry.stored) return entry ? { ...entry, data: null } : null;
  try {
    const data = await fs.readFile(path.join(paths().attachments, keyOf(messageId), String(entry.i)));
    return { ...entry, data };
  } catch (e) {
    return { ...entry, data: null };
  }
}

async function body(messageId) {
  if (!index[messageId] || !index[messageId].hasBody) return null;
  if (bodyCache.has(messageId)) return bodyCache.get(messageId);
  try {
    const text = await fs.readFile(path.join(paths().bodies, keyOf(messageId) + '.txt'), 'utf8');
    if (bodyCache.size >= BODY_CACHE_MAX) bodyCache.clear();
    bodyCache.set(messageId, text);
    return text;
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

/* ------------------------------------------------------------------- search */

function norm(s) {
  return String(s == null ? '' : s).toLowerCase();
}

/** Every address in a header, lower-cased: 「王小明 <ming@abc.com>, x@y.z」 → [ming@abc.com, x@y.z]. */
function addressesIn(header) {
  const out = [];
  const re = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
  let m;
  const text = String(header || '');
  while ((m = re.exec(text))) out.push(m[0].toLowerCase());
  return out;
}

/**
 * Does this header name the party? `who` may be a whole address, a domain, or
 * a fragment of a display name.
 *
 *   abc.com        matches anyone @abc.com and @mail.abc.com
 *   ming@abc.com   matches that address
 *   王小明          matches the display name
 *
 * The domain rule is the one people mean by 「ABC 公司寄來的」, and it is the
 * one a plain substring gets wrong: 'abc.com' as a substring also matches
 * notabc.com.
 */
function partyMatches(header, who) {
  const want = norm(who).trim();
  if (!want) return true;
  const text = norm(header);
  if (want.includes('@')) return addressesIn(text).includes(want);
  if (/^[\w-]+(?:\.[\w-]+)+$/.test(want)) {
    return addressesIn(text).some((a) => {
      const dom = a.split('@')[1] || '';
      return dom === want || dom.endsWith('.' + want);
    });
  }
  return text.includes(want);
}

/** A window of text around the first hit, for a list that shows why it matched. */
function snippetOf(text, needle, span) {
  const t = String(text || '');
  const at = norm(t).indexOf(norm(needle));
  if (at < 0) return '';
  const start = Math.max(0, at - Math.floor(span / 2));
  const cut = t.slice(start, start + span).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + cut + (start + span < t.length ? '…' : '');
}

/**
 * Find messages.
 *
 * `text` is looked for in the subject, the sender, and -- unless `inBody` is
 * false -- the body; a body hit comes back with a snippet so a list can say
 * why the message is there. `from` and `to` take an address, a domain or a
 * name (see partyMatches). `since` and `until` are epoch milliseconds.
 *
 * Bodies are read from disk through a bounded cache. This is a linear scan and
 * it is meant to be: a mirror holds thousands of messages, not millions, and
 * an index would be a second thing to keep right.
 */
async function search(opts = {}) {
  const o = opts || {};
  const text = String(o.text || '').trim();
  const q = norm(text);
  const inBody = o.inBody !== false;
  const limit = Math.max(1, Math.min(Number(o.limit) || 50, 500));
  const since = Number(o.since) || 0;
  const until = Number(o.until) || 0;

  const candidates = [];
  // One id, when the caller already knows which message and wants its row.
  const ids = o.messageId ? [String(o.messageId)] : Object.keys(index);
  for (const id of ids) {
    const v = viewOf(id);
    if (!v) continue;
    if (!o.includeDeleted && v.deleted) continue;
    if (o.folder && v.folder !== o.folder) continue;
    if (since && (v.date || 0) < since) continue;
    if (until && (v.date || 0) > until) continue;
    if (o.from && !partyMatches(v.from + ' ' + v.fromName, o.from)) continue;
    if (o.to && !partyMatches(v.to + ' ' + v.cc, o.to)) continue;
    if (o.hasAttachment && !v.hasAttachments) continue;
    if (o.unread && v.seen) continue;
    candidates.push(v);
  }
  candidates.sort((a, b) => (b.date || 0) - (a.date || 0));

  if (!q) return { hits: candidates.slice(0, limit).map((v) => ({ ...v, where: '', snippet: '' })), scanned: candidates.length };

  const hits = [];
  let scanned = 0;
  for (const v of candidates) {
    scanned++;
    if (norm(v.subject).includes(q)) { hits.push({ ...v, where: 'subject', snippet: '' }); }
    else if (norm(v.from + ' ' + v.fromName).includes(q)) { hits.push({ ...v, where: 'from', snippet: '' }); }
    else if (inBody && v.hasBody) {
      // eslint-disable-next-line no-await-in-loop
      const b = await body(v.messageId);
      if (b && norm(b).includes(q)) hits.push({ ...v, where: 'body', snippet: snippetOf(b, text, 160) });
    }
    if (hits.length >= limit) break;
  }
  return { hits, scanned };
}

/** Which of these the store has never seen, so a sync only fetches new bodies. */
function unknown(ids) {
  return ids.filter((id) => !index[id]);
}

/**
 * The row a source's own id belongs to, if the mirror already has one.
 *
 * A feeder whose ids are not Message-IDs asks this before it mints a key. Two
 * responses about one message can differ in which fields they carry -- a list
 * request and an open request, or the same request after a server update -- and
 * without this lookup the second one silently creates a second row, orphaning
 * the first one's tombstone so a deleted message reappears. Built on demand and
 * dropped by put(), because it is a view of the index rather than a second copy
 * of it: the shape that has gone wrong here five times is two states pointing
 * at one place, and a cache that can drift is exactly that.
 */
let sourceMap = null;

function bySource(sourceId) {
  const want = String(sourceId || '');
  if (!want) return null;
  if (!sourceMap) {
    sourceMap = new Map();
    for (const id of Object.keys(index)) {
      const sid = index[id].sourceId;
      if (sid) sourceMap.set(String(sid), id);
    }
  }
  return sourceMap.get(want) || null;
}

/** This account's directory, for anything a feeder must keep beside the mirror. */
function dir() {
  return ready() ? paths().base : null;
}

/**
 * How far back this folder actually reaches, and how much of it is here.
 *
 * A mirror is a partial copy by construction, and an answer computed from a
 * partial copy is a partial answer. Returned so the application and the model
 * can say 「只到 9 月 1 日」 instead of implying the week is complete.
 */
function coverage(folder) {
  const ids = Object.keys(index).filter((id) => index[id].folder === folder);
  const dates = ids.map((id) => index[id].date).filter((d) => d > 0);
  return {
    folder,
    messages: ids.length,
    oldest: dates.length ? Math.min(...dates) : 0,
    newest: dates.length ? Math.max(...dates) : 0
  };
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

/**
 * The same for attachments, under their own cap. The index keeps every name
 * and size; only the bytes go, and `stored` says so.
 */
async function trimAttachments() {
  const p = paths();
  let dirs;
  try {
    dirs = await fs.readdir(p.attachments);
  } catch (e) {
    return { bytes: 0, dropped: 0 };
  }
  const stat = [];
  let bytes = 0;
  for (const d of dirs) {
    const full = path.join(p.attachments, d);
    let files = [];
    try { files = await fs.readdir(full); } catch (e) { continue; }
    let size = 0;
    let mtime = 0;
    for (const f of files) {
      try {
        const st = await fs.stat(path.join(full, f));
        size += st.size;
        mtime = Math.max(mtime, st.mtimeMs);
      } catch (e) { /* vanished */ }
    }
    bytes += size;
    stat.push({ d, size, mtime });
  }
  if (bytes <= MAX_ATTACH_BYTES) return { bytes, dropped: 0 };

  stat.sort((a, b) => a.mtime - b.mtime);
  const byKey = {};
  for (const id of Object.keys(index)) byKey[keyOf(id)] = id;
  let dropped = 0;
  for (const s of stat) {
    if (bytes <= MAX_ATTACH_BYTES * 0.8) break;
    try {
      await fs.rm(path.join(p.attachments, s.d), { recursive: true, force: true });
      bytes -= s.size;
      dropped++;
      const id = byKey[s.d];
      if (id && index[id]) {
        (index[id].attachments || []).forEach((a) => { a.stored = false; });
        dirty = true;
      }
    } catch (e) { /* already gone */ }
  }
  return { bytes, dropped };
}

/**
 * Forget everything for this account: used when the account is removed.
 *
 * Leaves the store closed, not empty. An empty-but-open store answers 「零封」 to
 * a question about a mailbox that no longer exists here, which reads as "your
 * mail is gone" rather than "there is no account"; closed, every caller gets
 * the same 「還沒設定帳號」 it gets before the first sync.
 */
async function purge() {
  if (!ready()) return false;
  await fs.rm(paths().base, { recursive: true, force: true });
  index = null;
  local = null;
  cursors = null;
  root = null;
  account = null;
  bodyCache.clear();
  sourceMap = null;
  dirty = false;
  return true;
}

module.exports = {
  init, ready, flush, stats,
  put, putBody, body, get, list, unknown,
  putAttachments, attachment,
  search, partyMatches, addressesIn, snippetOf,
  setLocal, localOf,
  cursor, setCursor, bySource, dir, coverage,
  trim, trimAttachments, purge,
  keyOf, accountKey,
  MAX_ONE_ATTACHMENT, MAX_ATTACHMENTS
};
