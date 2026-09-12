'use strict';

/* ===========================================================================
   AI-OS // mail
   ---------------------------------------------------------------------------
   IMAP for reading, SMTP for sending, both from the main process because a
   renderer cannot open a TCP socket.

   Three things shape this module:

     1. Every received message is untrusted. Mail is the one channel where an
        arbitrary stranger can put text in front of this machine's planner, so
        message bodies are fenced before they reach the model and sending stays
        DENY until the user changes it deliberately.

     2. Credentials never touch the sandbox. They live in userData, and the only
        thing the model can learn about them is that an account exists.

     3. HTML mail is converted to text here and remote content is never loaded.
        Rendering a marketing email's <img> is a read receipt; rendering its
        script would be worse.
   =========================================================================== */

const fs = require('node:fs/promises');
const path = require('node:path');

const store = require('./mailstore');
const owa = require('./owa');
const autoconfig = require('./mailautoconfig');

let ImapFlow = null;
let nodemailer = null;
try {
  ({ ImapFlow } = require('imapflow'));
  nodemailer = require('nodemailer');
} catch {
  // Left null: the UI reports the missing dependency instead of crashing boot.
}

/* The provider table lives in mailautoconfig.js, because turning a domain into
   one of these entries is that module's job. Named here so the rest of this
   file reads as it did. */
const PRESETS = autoconfig.PRESETS;

let credFile = null;
/* { provider, email, login, label, source, imap, smtp, savedAt }
   password kept separately */
let account = null;
let password = null;       // in memory + on disk, never sent to the renderer
const cache = new Map();   // uid -> parsed message

/* ------------------------------------------------------------------ account */

async function init(userDataDir) {
  credFile = path.join(userDataDir, 'mail-account.json');
  try {
    const raw = JSON.parse(await fs.readFile(credFile, 'utf8'));
    if (raw && raw.email) {
      account = {
        /* Which of the two sources this address is read through. Absent in
           every account written before the web source existed, and those are
           all IMAP -- so the default is not a guess. */
        kind: raw.kind === 'owa' ? 'owa' : 'imap',
        base: raw.base || '',
        provider: raw.provider || 'custom',
        email: raw.email,
        /* Accounts written before autoconfig existed have no `login`, and for
           all of them it was the address -- which is what this falls back to. */
        login: raw.login || raw.email,
        label: raw.label || '',
        source: raw.source || '',
        imap: raw.imap,
        smtp: raw.smtp,
        savedAt: raw.savedAt || 0
      };
      password = raw.password || null;
      if (account.kind === 'owa') owa.configure({ email: account.email, base: account.base });
      /* The mirror is opened here, for either kind, rather than by the first
         sync. A restart followed by a search used to throw on an index that was
         null although the files on disk were full, and under the web source the
         first call of the day may well be the scheduled search rather than a
         sync. */
      try { await store.init(account.email); } catch { /* mirror opens on first sync instead */ }
    }
  } catch { /* no account configured */ }
  return status();
}

/**
 * Settings for an address, without connecting to anything or storing anything.
 *
 * A thin pass-through, but it belongs on this module: the account form asks one
 * object for what a mailbox needs and then hands the answer back to `configure`,
 * and splitting that across two imports would be the seam where the two stop
 * agreeing about the shape.
 */
async function discover(email) {
  return autoconfig.discover(email);
}

/**
 * Deliberately never returns the password, not even redacted with a length.
 * The renderer has no use for it and the model must not see it in any form.
 */
function status() {
  const kind = account ? (account.kind || 'imap') : null;
  return {
    available: !!(ImapFlow && nodemailer),
    /* An Outlook Web account has no password to hold -- the credential is a
       cookie in the browser partition -- so "configured" cannot mean the same
       thing for both. */
    configured: kind === 'owa' ? true : !!(account && account.email && password),
    kind,
    /* Where the second source reads from, and whether writing is possible at
       all. The web source is read-only by construction, not by setting. */
    base: account ? (account.base || '') : null,
    readOnly: kind === 'owa',
    email: account ? account.email : null,
    provider: account ? account.provider : null,
    /* The provider's own name for itself when discovery found one -- "Fastmail"
       reads better in the account panel than "自訂 (IMAP/SMTP)" -- and which of
       the five sources said so. */
    label: account ? (account.label || '') : null,
    source: account ? (account.source || '') : null,
    /* Shown because it is not always the address: some hosts log in with the
       part before the @, and a failed login is unreadable without knowing
       which name was sent. */
    login: account ? (account.login || account.email) : null,
    imapHost: account && account.imap ? account.imap.host : null,
    smtpHost: account && account.smtp ? account.smtp.host : null,
    /* Whether reading here also marks read on the server. On by default: the
       alternative leaves the phone showing fifty unread for mail already read,
       which makes this a second inbox rather than a view of the first. */
    syncSeen: account ? account.syncSeen !== false : true,
    mirror: store.ready() ? store.stats() : null,
    webFolders: kind === 'owa' ? owa.folders() : null,
    loginUrl: kind === 'owa' ? owa.loginUrl() : null,
    presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, note: v.note }]))
  };
}

/** Flip whether reading here also marks read on the server. */
async function setSyncSeen(on) {
  if (isWeb()) throw readOnlyError();
  requireAccount();
  account.syncSeen = !!on;
  await fs.writeFile(credFile, JSON.stringify({ ...account, password }, null, 2), 'utf8');
  return status();
}

async function configure({ kind, provider, email, password: pw, imap, smtp, syncSeen, label, source, username, base } = {}) {
  const mail = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error('信箱格式不對');

  /* The web source: an address and where to read it from. No password is asked
     for, here or anywhere -- see decision 1 in owa.js. Nothing is verified at
     this point because the only way to verify is to have signed in, and signing
     in is the user's next step, not this one's. */
  if (kind === 'owa') {
    const conf = {
      kind: 'owa',
      provider: 'owa',
      email: mail,
      login: mail,
      label: String(label || 'Outlook 網頁信箱').trim().slice(0, 80),
      source: 'owa',
      base: owa.sanitiseBase(base),
      syncSeen: false,
      savedAt: Date.now()
    };
    account = conf;
    password = null;
    owa.configure({ email: conf.email, base: conf.base });
    await fs.mkdir(path.dirname(credFile), { recursive: true });
    await fs.writeFile(credFile, JSON.stringify(conf, null, 2), 'utf8');
    cache.clear();
    if (!store.ready()) await store.init(conf.email);
    return status();
  }

  if (!ImapFlow || !nodemailer) throw new Error('缺少 imapflow / nodemailer 套件');
  if (!pw) throw new Error('沒有密碼');

  const preset = PRESETS[provider] || PRESETS.custom;
  const conf = {
    kind: 'imap',
    provider: PRESETS[provider] ? provider : 'custom',
    email: mail,
    /* Nearly always the address itself. A handful of hosts want only the part
       before the @, which their autoconfig file says as %EMAILLOCALPART%;
       sending them the full address fails as a rejected password. */
    login: username === 'local' ? mail.slice(0, mail.lastIndexOf('@')) : mail,
    label: String(label || '').trim().slice(0, 80),
    source: String(source || '').trim().slice(0, 20),
    imap: preset.imap || sanitiseHost(imap, 993),
    smtp: preset.smtp || sanitiseHost(smtp, 465),
    syncSeen: syncSeen === undefined ? true : !!syncSeen,
    savedAt: Date.now()
  };
  if (!conf.imap || !conf.smtp) throw new Error('自訂供應商需要 IMAP 與 SMTP 主機');

  account = conf;
  password = String(pw);

  await fs.mkdir(path.dirname(credFile), { recursive: true });
  await fs.writeFile(credFile, JSON.stringify({ ...conf, password }, null, 2), 'utf8');
  cache.clear();
  return status();
}

function sanitiseHost(h, defaultPort) {
  if (!h || !h.host) return null;
  return {
    host: String(h.host).trim().slice(0, 200),
    port: Number.isFinite(+h.port) ? +h.port : defaultPort,
    secure: h.secure === undefined ? true : !!h.secure
  };
}

/**
 * Remove the account, and with it the copy of the mailbox.
 *
 * The mirror used to survive this. `mailstore.purge()` has said 「用於帳號被移除時」
 * since it was written and nothing ever called it, so 「移除帳號」 deleted a
 * password and left every message, every body and every attachment byte on
 * disk -- inherited whole by the next account configured with the same address.
 * A button that says it removes the account has to remove the mail too; what it
 * costs is the local-only state (the tombstones, the stars), and re-syncing
 * brings the messages themselves back from the server.
 */
async function forget() {
  let mirror = null;
  try {
    if (store.ready()) {
      mirror = store.stats();
      await store.purge();
    }
  } catch { /* a mirror that will not open cannot be holding anything either */ }
  account = null;
  password = null;
  owa.configure(null);
  cache.clear();
  try { await fs.rm(credFile, { force: true }); } catch { /* ignore */ }
  return { ...status(), purged: mirror ? mirror.messages + mirror.deleted : 0 };
}

function requireAccount() {
  if (!ImapFlow || !nodemailer) throw Object.assign(new Error('缺少郵件套件'), { code: 'ENODEP' });
  if (!account || !password) throw Object.assign(new Error('還沒設定郵件帳號'), { code: 'ENOACCOUNT' });
}

/**
 * Which source this account is read through.
 *
 * Every dispatch below asks this and nothing else. The alternative -- deciding
 * from what a row happens to carry, "it has a uid so it came from IMAP" -- is
 * wrong the moment a mailbox has been read through both, and a mirror that
 * outlives an account change is exactly the case where that happens.
 */
function isWeb() {
  return !!(account && account.kind === 'owa');
}

function readOnlyError() {
  return Object.assign(
    new Error('這是 Outlook 網頁信箱帳號，只讀。要回信或刪除真實信件請到 Outlook。'),
    { code: 'EREADONLY' }
  );
}

/**
 * The name sent to the server, which is the address for all but a few hosts.
 * One function rather than three copies of the same fallback: IMAP, SMTP and
 * the connection test have to agree, and the way they would stop agreeing is
 * one of them being updated and the other two not.
 */
function loginName() {
  return (account && account.login) || (account && account.email) || '';
}

/* --------------------------------------------------------------------- IMAP */

async function withImap(fn) {
  requireAccount();
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: loginName(), pass: password },
    logger: false,
    emitLogs: false,
    socketTimeout: 30000
  });
  try {
    await client.connect();
    return await fn(client);
  } catch (e) {
    // IMAP servers phrase rejection in many ways; the useful signal for the
    // user is whether this is an authentication problem or a network one.
    const msg = String(e.message || e);
    const auth = /auth|credential|password|login|AUTHENTICATIONFAILED/i.test(msg);
    throw Object.assign(
      new Error(auth ? '登入被拒絕：' + msg : '連線失敗：' + msg),
      { code: auth ? 'EAUTH' : 'ENET' }
    );
  } finally {
    try { await client.logout(); } catch { try { client.close(); } catch { /* ignore */ } }
  }
}

async function folders() {
  if (isWeb()) {
    return owa.folders().map((f) => ({ path: f.name, name: f.label, specialUse: null }));
  }
  return withImap(async (c) => {
    const list = await c.list();
    return list
      .filter((f) => !f.flags.has('\\Noselect'))
      .map((f) => ({ path: f.path, name: f.name, specialUse: f.specialUse || null }));
  });
}

/** Envelope-only listing: bodies are fetched on demand, one message at a time. */
async function list({ folder = 'INBOX', limit = 30 } = {}) {
  /* The live listing is IMAP's. Under the web source the mirror is the only
     list there is, and mail:mirrorList is the channel that reads it. */
  if (isWeb()) throw readOnlyError();
  const take = Math.max(1, Math.min(100, limit));
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const total = c.mailbox.exists;
      if (!total) return { folder, total: 0, messages: [] };
      const from = Math.max(1, total - take + 1);
      const messages = [];
      for await (const m of c.fetch(`${from}:*`, { uid: true, envelope: true, flags: true, size: true })) {
        messages.push({
          uid: m.uid,
          subject: (m.envelope && m.envelope.subject) || '(無主旨)',
          from: addr(m.envelope && m.envelope.from),
          to: addr(m.envelope && m.envelope.to),
          date: m.envelope && m.envelope.date ? new Date(m.envelope.date).getTime() : 0,
          seen: m.flags ? m.flags.has('\\Seen') : false,
          flagged: m.flags ? m.flags.has('\\Flagged') : false,
          size: m.size || 0
        });
      }
      messages.sort((a, b) => b.date - a.date);
      return { folder, total, messages };
    } finally {
      lock.release();
    }
  });
}

function addr(a) {
  if (!Array.isArray(a) || !a.length) return '';
  return a.map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ');
}

/* =========================================================================
   Sync into the local mirror
   -------------------------------------------------------------------------
   Everything the application shows comes from `mailstore`; this is the only
   code that talks to the server about existing mail. See mailstore.js for why
   messages are keyed by Message-ID rather than UID.
   ========================================================================= */

/** A stable key, even for a server that omits the header. */
function messageIdOf(envelope, uid, folder) {
  const id = envelope && envelope.messageId;
  if (id) return String(id).trim();
  /* No Message-ID is rare and not fatal: fall back to something stable for this
     folder so the message can still be stored and deleted. It will re-import as
     a new message if the server renumbers, which is the honest outcome when the
     only identity available is positional. */
  return `<no-id.${folder}.${uid}@aios.local>`;
}

/**
 * Pull new mail for one folder into the mirror.
 *
 * Incremental by UID, with a full header re-read when UIDVALIDITY changes --
 * that is the server saying "the numbers you have mean nothing now", and
 * carrying on from the old highest UID would silently skip everything.
 */
async function syncFolder({ folder = 'INBOX', limit = 200, deep = false, days = 0 } = {}) {
  if (isWeb()) {
    if (!store.ready()) await store.init(account.email);
    return owa.syncFolder({ folder, limit, deep, days });
  }
  requireAccount();
  if (!store.ready()) await store.init(account.email);

  return withImap(async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const cur = store.cursor(folder);
      const validity = Number(c.mailbox.uidValidity) || 0;
      const reset = validity !== cur.uidValidity;
      const total = c.mailbox.exists;
      if (!total) {
        store.setCursor(folder, { uidValidity: validity, highestUid: 0 });
        await store.flush();
        return { folder, fetched: 0, total: 0, reset };
      }

      const range = reset || !cur.highestUid
        ? `${Math.max(1, total - limit + 1)}:*`
        : `${cur.highestUid + 1}:*`;

      let fetched = 0;
      let highest = reset ? 0 : cur.highestUid;
      const fresh = [];
      for await (const m of c.fetch(range, { uid: true, envelope: true, flags: true }, { uid: !reset && !!cur.highestUid })) {
        const env = m.envelope || {};
        const id = messageIdOf(env, m.uid, folder);
        store.put({
          messageId: id,
          uid: m.uid,
          folder,
          from: addr(env.from),
          fromName: (env.from && env.from[0] && env.from[0].name) || '',
          to: addr(env.to),
          cc: addr(env.cc),
          subject: env.subject || '(無主旨)',
          date: env.date ? new Date(env.date).getTime() : 0,
          seen: m.flags ? m.flags.has('\\Seen') : false,
          inReplyTo: env.inReplyTo || '',
          references: (env.references || []).join(' ')
        });
        if (m.uid > highest) highest = m.uid;
        fresh.push({ id, uid: m.uid });
        fetched++;
      }

      store.setCursor(folder, { uidValidity: validity, highestUid: highest });
      await store.flush();
      return { folder, fetched, total, reset, fresh: fresh.map((f) => f.id) };
    } finally {
      lock.release();
    }
  });
}

/**
 * Fetch and store the body of one message.
 *
 * Bodies are pulled on demand rather than during the folder sync: a mailbox of
 * ten thousand messages is a fast header sync and a slow body sync, and the
 * list is what the application needs first.
 */
async function syncBody({ folder = 'INBOX', uid, messageId } = {}) {
  /* Dispatch on the account, never on the row. A row synced through IMAP before
     the tenant switched basic auth off still carries a uid, and following that
     uid under a web account reaches for a password that no longer exists; the
     web source refuses it by name instead, which is a sentence the user can act
     on rather than 「還沒設定郵件帳號」. */
  if (isWeb()) {
    if (!store.ready()) await store.init(account.email);
    return owa.syncBody({ messageId });
  }
  requireAccount();
  if (!store.ready()) await store.init(account.email);

  const held = store.get(messageId);
  if (held && held.hasBody) return { messageId, cached: true };

  const full = await read({ folder, uid, withData: true });
  await store.putBody(messageId, full.text || '');
  const kept = await store.putAttachments(messageId, full.attachments || []);
  await store.flush();
  return { messageId, cached: false, bytes: (full.text || '').length, attachments: kept.length };
}

/**
 * Fetch a message's attachments again, for one already opened.
 *
 * `syncBody` returns early once the body is stored, so an attachment that could
 * not be fetched the first time could never be fetched at all -- and the reader
 * offered the file anyway, with 「重新同步一次試試」 as the advice, which did
 * nothing at all. This is the something.
 */
async function refreshAttachments({ folder = 'INBOX', uid, messageId } = {}) {
  if (isWeb()) {
    if (!store.ready()) await store.init(account.email);
    return owa.refreshAttachments({ messageId });
  }
  requireAccount();
  if (!store.ready()) await store.init(account.email);
  const held = store.get(messageId);
  if (!held) throw Object.assign(new Error('本機沒有這封信，先同步一次'), { code: 'ENOMSG' });
  const full = await read({ folder: folder || held.folder, uid: uid != null ? uid : held.uid, withData: true });
  const kept = await store.putAttachments(messageId, full.attachments || []);
  await store.flush();
  return { messageId, attachments: kept.length, stored: kept.filter((a) => a.stored).length };
}

/**
 * Mark read, here and -- unless the account says otherwise -- on the server.
 *
 * The one place a local action is allowed out. Without it the phone still shows
 * fifty unread for mail already read here, and a mirror that leaves the real
 * mailbox looking untouched is a second inbox rather than a view of the first.
 * Deleting and filing stay local, which is what the mirror is for.
 */
async function setSeen({ folder = 'INBOX', uid, messageId, seen = true } = {}) {
  if (isWeb()) {
    if (!store.ready()) await store.init(account.email);
    store.setLocal(messageId, { seen: !!seen });
    await store.flush();
    /* Local and only local, whatever the row carries. An IMAP-era row's uid
       would otherwise send a mark-read at a server this account has no password
       for, and the reader would toast a sync failure on every open. */
    return { messageId, seen: !!seen, pushed: false, readOnly: true };
  }
  requireAccount();
  if (!store.ready()) await store.init(account.email);
  store.setLocal(messageId, { seen: !!seen });
  await store.flush();

  if (account.syncSeen === false || uid == null) {
    return { messageId, seen: !!seen, pushed: false };
  }
  try {
    await markSeen({ folder, uid, seen });
    return { messageId, seen: !!seen, pushed: true };
  } catch (e) {
    /* The local state stands: the user did read it. Say the push failed rather
       than pretending the server agrees. */
    return { messageId, seen: !!seen, pushed: false, error: String(e.message || e) };
  }
}

/**
 * Fetch one message and reduce it to text. HTML is stripped rather than
 * rendered: no remote images means no read receipt, and no <script> means no
 * active content in a privileged window.
 */
async function read({ folder = 'INBOX', uid, withData = false } = {}) {
  if (isWeb()) throw readOnlyError();
  const key = folder + ':' + uid;
  if (!withData && cache.has(key)) return cache.get(key);

  const out = await withImap(async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const msg = await c.fetchOne(String(uid), { uid: true, envelope: true, source: true, flags: true });
      if (!msg) throw Object.assign(new Error('找不到這封信'), { code: 'ENOENT' });
      const parsed = parseSource(msg.source.toString('utf8'));
      return {
        uid: Number(uid),
        folder,
        subject: (msg.envelope && msg.envelope.subject) || '(無主旨)',
        from: addr(msg.envelope && msg.envelope.from),
        to: addr(msg.envelope && msg.envelope.to),
        cc: addr(msg.envelope && msg.envelope.cc),
        date: msg.envelope && msg.envelope.date ? new Date(msg.envelope.date).getTime() : 0,
        text: parsed.text,
        wasHtml: parsed.wasHtml,
        attachments: parsed.attachments,
        untrusted: true
      };
    } finally {
      lock.release();
    }
  });

  if (cache.size > 60) cache.clear();
  /* The cache keeps names and sizes; the bytes go to the mirror through
     syncBody and are not worth holding twice. */
  cache.set(key, Object.assign({}, out, {
    attachments: (out.attachments || []).map((a) => ({ name: a.name, type: a.type, bytes: a.bytes }))
  }));
  return withData ? out : cache.get(key);
}

/**
 * A deliberately small MIME reader. Full RFC 2045 handling is a library's job,
 * but for the common shapes -- text/plain, text/html, multipart/alternative,
 * multipart/mixed -- this gets the body out without pulling in a parser and its
 * transitive dependencies.
 */
function parseSource(src) {
  const split = src.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const headEnd = src.indexOf(split);
  const head = headEnd < 0 ? src : src.slice(0, headEnd);
  const body = headEnd < 0 ? '' : src.slice(headEnd + split.length);

  const headers = unfold(head);
  /* Lower-cased for comparing; the raw value for anything taken OUT of it. A
     boundary is case-sensitive, and nearly every real one has capitals in it
     (----=_NextPart_000_0012, Apple-Mail=_ABC). Lower-casing it first meant
     the parts never split, the body came back as base64 noise and the
     attachments were simply not there -- for most multipart mail. */
  const ctypeRaw = headers['content-type'] || 'text/plain';
  const ctype = ctypeRaw.toLowerCase();
  const boundary = (ctypeRaw.match(/boundary="?([^";]+)"?/i) || [])[1];

  const attachments = [];
  let text = '';
  let wasHtml = false;

  if (boundary) {
    const parts = body.split(new RegExp('--' + boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    let plain = '';
    let html = '';
    for (const part of parts) {
      if (!part.trim() || part.trim() === '--') continue;
      const pSplit = part.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
      const pEnd = part.indexOf(pSplit);
      if (pEnd < 0) continue;
      const pHead = unfold(part.slice(0, pEnd));
      const pBody = part.slice(pEnd + pSplit.length);
      const pTypeRaw = pHead['content-type'] || '';
      const dispRaw = pHead['content-disposition'] || '';
      const pType = pTypeRaw.toLowerCase();
      const disp = dispRaw.toLowerCase();
      const decoded = decodeBody(pBody, pHead['content-transfer-encoding'], pType);

      if (disp.includes('attachment') || /name="?[^";]+/i.test(pType) && !pType.startsWith('text/')) {
        // The raw headers: a filename is case-sensitive, and an RFC 2047 encoded
        // one is base64 that stops decoding the moment it is lower-cased.
        const name = (dispRaw.match(/filename="?([^";]+)"?/i) || pTypeRaw.match(/name="?([^";]+)"?/i) || [])[1];
        /* The bytes, not just the size. An attachment is the thing a person most
           often opens a mail client to get at, and a reader that can only say
           「有一個 3 MB 的檔案」 sends them back to the other client. */
        const data = decodeBytes(pBody, pHead['content-transfer-encoding']);
        attachments.push({
          name: decodeHeaderWord(name || '未命名附件'),
          type: pType.split(';')[0].trim(),
          bytes: data.length,
          data
        });
        continue;
      }
      if (pType.startsWith('text/plain') && !plain) plain = decoded;
      else if (pType.startsWith('text/html') && !html) html = decoded;
    }
    if (plain) text = plain;
    else if (html) { text = htmlToText(html); wasHtml = true; }
  } else {
    const decoded = decodeBody(body, headers['content-transfer-encoding'], ctype);
    if (ctype.startsWith('text/html')) { text = htmlToText(decoded); wasHtml = true; }
    else text = decoded;
  }

  return { text: text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 100000), wasHtml, attachments };
}

function unfold(head) {
  const out = {};
  const lines = head.replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ').split(/\r?\n/);
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function decodeBody(body, encoding, ctype) {
  const enc = String(encoding || '').toLowerCase().trim();
  const charset = (String(ctype || '').match(/charset="?([\w-]+)"?/i) || [])[1] || 'utf8';
  let buf;
  if (enc === 'base64') {
    buf = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  } else if (enc === 'quoted-printable') {
    buf = Buffer.from(
      body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
      'binary'
    );
  } else {
    /* 7bit, 8bit, binary, or nothing said: the text is already characters.
       The source was decoded from UTF-8 into a string before it got here, so
       squeezing it through a 'binary' Buffer keeps only the low byte of every
       character -- five Chinese characters came back as five bytes of noise.
       Most mail from modern servers is exactly this shape. */
    return String(body);
  }
  try {
    return new TextDecoder(charset.toLowerCase() === 'utf8' ? 'utf-8' : charset.toLowerCase()).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/**
 * A part's raw bytes, for attachments.
 *
 * Nearly every attachment travels as base64, which is ASCII and survives the
 * source having been read as UTF-8. An 8bit or binary part does not survive
 * that read, so this is best-effort for those -- rare in practice, and the
 * size is still right enough to show.
 */
function decodeBytes(body, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (enc === 'base64') return Buffer.from(String(body).replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') {
    return Buffer.from(
      String(body).replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
      'binary'
    );
  }
  return Buffer.from(String(body), 'binary');
}

/** =?utf-8?B?...?= and =?utf-8?Q?...?= in a filename, which is how non-ASCII names travel. */
function decodeHeaderWord(s) {
  return String(s || '').replace(/=\?([\w-]+)\?([bq])\?([^?]*)\?=/gi, (_, cs, kind, text) => {
    try {
      const buf = kind.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
      return new TextDecoder(cs.toLowerCase() === 'utf8' ? 'utf-8' : cs).decode(buf);
    } catch {
      return text;
    }
  });
}

function htmlToText(html) {
  const { toText } = require('./web');
  return toText(html);
}

async function markSeen({ folder = 'INBOX', uid, seen = true } = {}) {
  if (isWeb()) throw readOnlyError();
  return withImap(async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      if (seen) await c.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true });
      else await c.messageFlagsRemove({ uid: String(uid) }, ['\\Seen'], { uid: true });
      return { uid, seen };
    } finally {
      lock.release();
    }
  });
}

/* --------------------------------------------------------------------- SMTP */

/**
 * Send, and leave the evidence where a person would look for it.
 *
 * Two things beyond handing the message to SMTP:
 *
 *   - `inReplyTo` / `references`. Without them a reply arrives in the
 *     recipient's client as a new, unrelated message. Threading is not a nicety
 *     when the reply says 「好」.
 *   - a copy appended to the server's Sent folder. SMTP delivers to the
 *     recipient and to nobody else: with no APPEND the message exists in their
 *     mailbox and in no view of yours -- not the phone, not webmail. This is the
 *     one action that has to reach the server whatever the mirror's rules say,
 *     because the alternative looks exactly like mail that failed to send.
 */
async function send({ to, cc, subject, body, inReplyTo, references } = {}) {
  if (isWeb()) throw readOnlyError();
  requireAccount();
  const recipients = String(to || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) throw new Error('沒有收件人');
  for (const r of recipients) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r)) throw new Error('收件人格式不對：' + r);
  }

  const transport = nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: loginName(), pass: password }
  });

  try {
    const info = await transport.sendMail({
      from: account.email,
      to: recipients.join(', '),
      cc: cc || undefined,
      subject: String(subject || '(無主旨)').slice(0, 300),
      text: String(body || ''),
      inReplyTo: inReplyTo || undefined,
      references: references || (inReplyTo ? String(inReplyTo) : undefined)
    });

    /* Best effort, and reported rather than thrown: the message is already with
       the recipient, so failing the whole call here would say "not sent" about
       mail that was. */
    let saved = null;
    try {
      saved = await appendToSent(info);
    } catch (e) {
      saved = { ok: false, error: String(e.message || e) };
    }

    return {
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      savedToSent: saved
    };
  } catch (e) {
    const msg = String(e.message || e);
    const auth = /auth|credential|password|login/i.test(msg);
    throw Object.assign(new Error((auth ? '寄信登入被拒絕：' : '寄信失敗：') + msg), { code: auth ? 'EAUTH' : 'ESMTP' });
  } finally {
    transport.close();
  }
}

/**
 * Put a copy of a sent message in the account's Sent folder.
 *
 * Servers disagree about what that folder is called, so ask: IMAP special-use
 * flags name it without guessing, and the common names are a fallback for
 * servers that do not advertise them. If none of it matches, say so instead of
 * inventing a folder -- creating 「Sent」 next to an existing 「已寄郵件」 would
 * split the record of what was sent.
 */
async function appendToSent(info) {
  if (!info || !info.message) return { ok: false, error: '沒有可存的原始訊息' };
  const raw = Buffer.isBuffer(info.message) ? info.message : Buffer.from(String(info.message));

  return withImap(async (c) => {
    const boxes = await c.list();
    const special = boxes.find((b) => b.specialUse === '\\Sent');
    const named = boxes.find((b) => /^(sent|sent items|sent mail|已寄郵件|寄件備份|已发送)$/i
      .test(b.name) || /sent/i.test(b.path));
    const box = special || named;
    if (!box) {
      return { ok: false, error: '找不到寄件備份資料夾，這封信只送到了收件人那邊' };
    }
    await c.append(box.path, raw, ['\\Seen']);
    return { ok: true, folder: box.path };
  });
}

async function verify() {
  if (isWeb()) {
    const p = await owa.probe();
    return { web: p, imap: null, smtp: null };
  }
  requireAccount();
  const out = { imap: null, smtp: null };
  try {
    await withImap(async (c) => { out.imap = { ok: true, folders: (await c.list()).length }; });
  } catch (e) {
    out.imap = { ok: false, error: e.message, code: e.code };
  }
  try {
    const t = nodemailer.createTransport({
      host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure,
      auth: { user: loginName(), pass: password }
    });
    await t.verify();
    t.close();
    out.smtp = { ok: true };
  } catch (e) {
    out.smtp = { ok: false, error: String(e.message || e) };
  }
  return out;
}

module.exports = {
  init, status, discover, configure, forget, verify,
  folders, list, read, markSeen, send,
  /* The mirror. `list`/`read` above still talk to the server and are what the
     sync uses; everything the application shows comes from these. */
  syncFolder, syncBody, setSeen, setSyncSeen, store, refreshAttachments,
  /* The web source, for the channels that are about it and not about mail in
     general: signing in, and asking whether the session still works. */
  owa, isWeb,
  parseSource, PRESETS
};
