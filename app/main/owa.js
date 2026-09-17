'use strict';
/**
 * The second mail source: an Outlook Web session the user has already signed
 * into (Office 365).
 *
 * IMAP is not an option on a current O365 tenant -- basic authentication is
 * switched off and OAuth needs an application registration only IT can make.
 * What the user does have is a browser, an AD password and a phone, which is
 * enough to sign in to the web mailbox. This module reads that signed-in
 * session and feeds the same mirror IMAP feeds.
 *
 * Seven decisions. The first two were rewritten after the first real tenant,
 * because the first version of this file was wrong about how Outlook
 * authenticates and reported that wrongness as 「登入過期了」 to a user who was
 * signed in.
 *
 * 1. AI-OS never touches the sign-in, and never holds a password. The user
 *    signs in inside an ordinary browser tab -- email, AD password, second
 *    factor -- and none of it passes through here. What this module reuses is
 *    the request the signed-in page makes to its own server.
 *
 * 2. That request is signed by a bearer token, not by cookies. Measured against
 *    a real tenant: outlook.office.com/owa/service.svc is called with a ~5 KB
 *    `authorization` header, while the cookie jar for that origin holds about
 *    400 bytes of session bookkeeping and no credential at all. A request made
 *    with the cookies and without the token is an anonymous request, and
 *    Microsoft answers an anonymous request with the sign-in page -- which is
 *    exactly what the first version of this file kept reporting as an expired
 *    session. So the token is learned by watching one of the page's own
 *    requests go out (browser.learnRequest), and it is treated as the
 *    credential it is:
 *
 *      * it lives in `template`, in memory, and nowhere else. Never written to
 *        disk, never returned through IPC, never in the sample log, never shown
 *        to the model. `diagnose()` reports that it exists and how many bytes
 *        long it is, and that is the most anyone outside this module learns.
 *      * it expires, so it is re-learned rather than kept. Older than
 *        TEMPLATE_MAX_AGE_MS and it is thrown away; refused as unsigned-in and
 *        it is thrown away immediately and learned again, once.
 *      * it is only ever sent back to the origin it was captured from.
 *
 *    When no tab is showing the mailbox, one is opened, learned from, and taken
 *    away again. That is what lets a scheduled run at eight in the morning work
 *    without the user having left a tab up overnight: the cookies that let that
 *    tab sign in silently are the ones their own sign-in left behind, and this
 *    stops working exactly when the tenant says the session is over.
 *
 * 3. Read-only by construction, not by policy. There is no send, delete, move
 *    or mark-read call anywhere in this file, and a test asserts that against
 *    the source. A message whose text tells the model to delete the audit mail
 *    cannot be obeyed on this path, because the verb does not exist here.
 *    Deleting in the application writes a tombstone in the mirror; the real
 *    mailbox is never touched.
 *
 * 4. Identity is decided once, at header sync, and never revised. The list
 *    request asks for InternetMessageId twice -- by name and as extended
 *    property 0x1035 -- so the real Message-ID is normally there the first time
 *    a message is seen, and the row is keyed on it exactly as an IMAP row is.
 *    Only when the server returns none does the key become a hash, and then the
 *    hash covers ItemId.Id ONLY: an EWS ItemId is {Id, ChangeKey} and the
 *    ChangeKey changes every time anything on the server touches the message,
 *    so hashing the pair would mint a new identity on every sync and the
 *    messages the user deleted would come back every morning. Opening a message
 *    can never re-key it: the key comes out of the mirror. And before a key is
 *    minted at all, the mirror is asked whether it already has a row for this
 *    ItemId, so a response carrying more fields than last time cannot create a
 *    second row for one message.
 *
 * 5. The cursor overlaps rather than abuts. A strict "newer than last time"
 *    boundary loses every message that shares its second with the last one on
 *    the page, which is routine for distribution lists. Each incremental sync
 *    re-walks the last OVERLAP_MS; put() is idempotent, so re-seeing a message
 *    costs nothing and missing one costs the morning's answer. What an overlap
 *    still cannot see is a message moved into the folder with an old received
 *    time; `deep: true` re-walks the whole window for that.
 *
 * 6. The first sync is sized by date, not by count. "The newest 200" leaves a
 *    busy mailbox permanently partial with nothing able to say so. The mirror
 *    records how far back it reaches per folder and the application says so.
 *
 * 7. The request shapes are measured, not assumed. This was written without a
 *    tenant to observe and the guesses were wrong in four places at once: the
 *    real server refused `ItemSubject` and accepted `item:Subject`, refused an
 *    empty `AttachmentShape`, refused `item:Attachments` named beside
 *    `item:Body`, and answered `IndexedPageItemView` with an internal error
 *    while accepting `IndexedPageView`. None of that could be reasoned out --
 *    the server's own answer was 「invalid argument」 naming no argument. So the
 *    shapes live in a DIALECT that `probeShapes()` measures one piece at a
 *    time, the defaults are what a real tenant accepted, and a request refused
 *    for an argument nobody named re-measures and retries instead of failing
 *    every sync until somebody reads a packet capture.
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { session } = require('electron');
const store = require('./mailstore');
const browser = require('./browser');

const PARTITION = 'persist:aios-web';
const DEFAULT_BASE = 'https://outlook.office.com';

/**
 * The origins this module will take a credential from, or send one to.
 *
 * A list, not a pattern, and the reason is worth keeping: the first version
 * decided "is this the mailbox?" with `url.indexOf(base) === 0`, and a prefix
 * is not an origin -- `https://outlook.office.com.evil.example/` satisfied it,
 * which would have handed that page's requests the debugger and then replayed
 * its headers. Setting the base to `https://outlook.office.co`, a real
 * registrable domain, did the mirror image: it matched the user's genuine tab
 * by prefix, took Microsoft's bearer token off it, and posted it to a stranger.
 *
 * Microsoft serves the same mailbox from several of these, and is in the middle
 * of moving the web app from outlook.office.com to outlook.cloud.microsoft --
 * which is why the token may be learned from any of them. Where it is SENT is
 * narrower still: only ever `base()`, which has to be on this list too.
 */
const OUTLOOK_ORIGINS = [
  'https://outlook.office.com',
  'https://outlook.office365.com',
  'https://outlook.cloud.microsoft',
  'https://outlook.live.com'
];

/** Loopback is for the end-to-end tests, which run a fake Outlook on 127.0.0.1. */
function isLoopback(origin) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(origin || ''));
}

function knownOrigin(origin) {
  const o = String(origin || '');
  return OUTLOOK_ORIGINS.indexOf(o) >= 0 || isLoopback(o);
}

const PAGE = 50;                       // items per FindItem request
const MAX_PER_SYNC = 600;              // ceiling for one sync, deep or not
const FIRST_DAYS = 30;                 // how far back the first sync reaches
const OVERLAP_MS = 24 * 3600 * 1000;   // decision 4
const REQUEST_TIMEOUT_MS = 30000;
/* Big enough for the largest attachment the mirror will keep, base64 is a third
   larger than the bytes, plus the JSON around it. It used to be 12 MB while the
   store accepted 25 MiB, so anything over about 8.8 MiB could be listed and
   never fetched. */
const MAX_RESPONSE_BYTES = Math.ceil(25 * 1024 * 1024 * 4 / 3) + 1024 * 1024;

/* Codes that mean "no answer", as opposed to "the server refused this shape".
   A probe that cannot tell them apart concludes that everything is unsupported
   the moment the session drops, and writes that conclusion down. */
const NO_ANSWER = /^(ENEEDLOGIN|EFORBIDDEN|ETIMEOUT|ENET|ETOOBIG|ENOTAB|ENOLEARN|EORIGIN|ENOACCOUNT)$/;
const SAMPLE_MAX_BYTES = 256 * 1024;

/* The folders this source knows, by the name the application uses. `folder` is
   a free string matched exactly everywhere in the mirror, so what is written
   into a row and what a cursor is filed under must both be the application's
   name -- never the server's id and never its display name, or a sync that
   reports twenty new messages shows zero and every sync is a first sync. */
const FOLDERS = [
  { name: 'INBOX', id: 'inbox', label: '收件匣', alias: ['inbox', '收件匣'] },
  { name: 'Sent', id: 'sentitems', label: '寄件備份', alias: ['sent items', 'sentitems', '寄件備份'] },
  { name: 'Drafts', id: 'drafts', label: '草稿', alias: ['草稿'] },
  { name: 'Archive', id: 'archive', label: '封存', alias: ['封存'] },
  { name: 'Junk', id: 'junkemail', label: '垃圾郵件', alias: ['junk email', 'junkemail', '垃圾郵件'] },
  { name: 'Trash', id: 'deleteditems', label: '刪除的郵件', alias: ['deleted items', 'deleteditems', 'trash', '刪除的郵件'] }
];

let account = null;   // { email, base } -- set by mail.js configure/init
let sampling = new Set();

/* ------------------------------------------------- the request template ----

   What the signed-in page puts on its own requests, learned by watching one go
   out. This was decision 6's "the shapes are the honest weak point", and the
   first real tenant proved it: the mailbox is NOT authenticated by cookies.
   The page sends a five-kilobyte bearer token in an `authorization` header,
   with the cookie jar carrying only session bookkeeping. A request with the
   cookies and without the token is an anonymous request, and Microsoft answers
   an anonymous request with the sign-in page -- which is exactly what 「登入
   過期了」 was really reporting, every time, for a user who was signed in.

   The token is a credential:

     * it lives here, in memory, and nowhere else. Never written to disk, never
       put in the sample log, never returned through IPC, never shown to the
       model. `diagnose()` reports that it exists and how long it is, and that
       is the most anyone outside this module ever learns about it.
     * it expires, so it is re-learned rather than kept. A template older than
       TEMPLATE_MAX_AGE_MS is thrown away, and a request refused as unsigned-in
       throws it away immediately and learns a new one once.
     * it is only ever sent back to the origin it was captured from.           */

const TEMPLATE_MAX_AGE_MS = 15 * 60 * 1000;
const LEARN_EXISTING_MS = 20000;   // an open mailbox polls every few seconds
const LEARN_FRESH_MS = 60000;      // a tab opened from cold has to sign in first

/* Copied onto our requests. Everything else the page sent is either per-request
   (correlation ids, the payload), added by the network stack (cookie, length,
   the HTTP/2 pseudo-headers, which would break the request if forwarded), or
   none of our business. `prefer` is here for a reason beyond politeness: it
   carries IdType="ImmutableId", which is what makes an ItemId survive the
   message being moved between folders -- the exact weakness decision 3 had to
   admit to. */
const FORWARD = /^(authorization|x-anchormailbox|x-tenantid|x-client-version|x-owa-sessionid|x-owa-hosted-ux|prefer|accept-language|x-req-source)$/i;

let template = null;   // { origin, email, headers, at } -- memory only
let seq = 1;
/* Tabs this module opened for itself. Never adopted as "a tab already showing
   the mailbox": a second learner would otherwise take over the first learner's
   throwaway tab and then have it destroyed underneath it. */
const ownTabs = new Set();

/* The tab kept open to learn from, and not shown anywhere -- the browser window
   builds its strip from its own state, so this is invisible.

   It used to be created and destroyed for every learn, and that is a page load
   of Microsoft's web mail each time: about fifteen seconds when it works, and a
   sixty-second timeout with 「Outlook 分頁沒有送出任何請求」 when the load is slow
   or the burst of requests happens to fall outside the window. Reported after
   reading a handful of messages: the first few opened and the next one did not.
   Keeping the tab makes the second learn cost nothing and removes the failure
   entirely, at the price of one background page. */
let workerTab = null;
/* One learn at a time. Two callers needing a template at once -- the scheduled
   sync and a person pressing 收信 -- used to open two tabs and race. */
let learning = null;

/* ------------------------------------------------------------ keeping it ---

   How an Outlook session actually dies, and what can be done about each part:

     the bearer token       about an hour. The page renews it by itself, but
                            only while the page is running -- and a tab nobody
                            loads is not running anything.
     the sign-in cookie     whatever the tenant's policy says: often eight to
                            twenty-four hours, far longer if the user ticked
                            「保持登入」 at sign-in.

   So the first one is ours to prevent and the second one is not. Loading the
   mailbox page every so often is exactly what a browser does while you leave
   Outlook open in it, and it makes the session last its full allowed span
   instead of ending the moment the access token does. Beyond that span nothing
   here can help, and pretending otherwise would mean hammering a sign-in page.

   A user tab already showing the mailbox does this job better than we can, so
   when there is one, this does nothing. */

/* Ten minutes. The access token the page renews for itself lasts about an hour,
   so anything comfortably inside that keeps the session from ever lapsing; the
   point is not to refresh often, it is to never be late. One page load every ten
   minutes is cheaper than one expired session, which costs a human a sign-in. */
const KEEPALIVE_MS = 10 * 60 * 1000;
let keepTimer = null;
let keepState = { at: 0, ok: false, note: '' };

function keepAlive() {
  return { ...keepState, running: !!keepTimer, everyMs: KEEPALIVE_MS };
}

function startKeepAlive() {
  stopKeepAlive();
  if (!configured()) return false;
  keepTimer = setInterval(() => { refreshSession().catch(() => {}); }, KEEPALIVE_MS);
  /* One run shortly after starting, so the panel says something true before the
     first interval and the session is warm before anybody asks it for a message.
     Not immediately: boot has enough to do. */
  const first = setTimeout(() => { refreshSession().catch(() => {}); }, 45000);
  if (first.unref) first.unref();
  /* Unref so a timer cannot be the reason this process stays alive. */
  if (keepTimer.unref) keepTimer.unref();
  return true;
}

function stopKeepAlive() {
  if (keepTimer) clearInterval(keepTimer);
  keepTimer = null;
}

/**
 * Give the mailbox page a reason to renew its own token.
 *
 * Deliberately not a request of our own: the token this module holds is a copy,
 * and copying it again does nothing for the session it came from. What keeps
 * the session alive is the page running its own sign-in machinery, and the way
 * to make a throttled background page do that is to load it.
 */
async function refreshSession() {
  if (!configured()) { stopKeepAlive(); return keepAlive(); }

  /* Somebody has the mailbox open. Theirs is doing this already, and reloading
     the page a person is reading would be rude and pointless. */
  if (mailboxTab()) {
    keepState = { at: Date.now(), ok: true, note: '有開著的信箱分頁，它自己會續期' };
    return keepAlive();
  }

  try {
    forgetTemplate();
    await learnTemplate({ allowOpen: true });
    keepState = { at: Date.now(), ok: true, note: '背景分頁重新載入過，工作階段還活著' };
  } catch (e) {
    keepState = {
      at: Date.now(), ok: false,
      note: isLoginError(e)
        ? '登入已經過期，續期停了——要重新登入一次才會再開始'
        : String(e.message || e).slice(0, 160)
    };
    /* A dead session cannot be revived by asking again every twenty minutes; it
       can only be revived by a person. Stop, and say so. */
    if (isLoginError(e)) stopKeepAlive();
  }
  return keepAlive();
}

/* --------------------------------------------------------------- errors ---- */

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** True when the thing that went wrong is "sign in again", not "it broke". */
function isLoginError(e) {
  return !!(e && e.code === 'ENEEDLOGIN');
}

/* ---------------------------------------------------------------- pure ----- */

/** The server's id for a folder the application named, or '' for one we do not serve. */
function distinguished(folder) {
  const want = String(folder || '').trim().toLowerCase();
  if (!want) return '';
  for (const f of FOLDERS) {
    if (f.name.toLowerCase() === want) return f.id;
    if (f.id === want) return f.id;
    if (f.alias.some((a) => a.toLowerCase() === want)) return f.id;
  }
  return '';
}

/** The application's name for a folder, given anything that identifies it. */
function folderName(folder) {
  const id = distinguished(folder);
  const hit = FOLDERS.find((f) => f.id === id);
  return hit ? hit.name : '';
}

function folders() {
  return FOLDERS.map((f) => ({ name: f.name, label: f.label }));
}

/**
 * First non-empty value under any of these key names.
 *
 * Every read from a response goes through this. A missing key is a fact to
 * record, never a crash: a server version that renames one field must cost that
 * one field, not the whole sync.
 */
function pick(o, names) {
  if (!o || typeof o !== 'object') return undefined;
  for (const n of names) {
    const v = o[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** ItemId.Id and nothing else -- see decision 3 for why the ChangeKey is poison. */
function idOf(item) {
  const raw = pick(item, ['ItemId', 'itemId', 'Id', 'id']);
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  const id = pick(raw, ['Id', 'id']);
  return id ? String(id) : '';
}

/** The value of one extended property, by tag, wherever the response put it. */
function extendedValue(item, tag) {
  const want = String(tag).toLowerCase();
  const list = pick(item, ['ExtendedProperty', 'ExtendedProperties', 'extendedProperty']);
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  for (const ent of arr) {
    const uri = pick(ent, ['ExtendedFieldURI', 'ExtendedFieldUri', 'PropertyUri', 'extendedFieldURI']) || ent;
    const got = String(pick(uri, ['PropertyTag', 'propertyTag']) || '').toLowerCase();
    if (!got) continue;
    const norm = got.startsWith('0x') ? got : '0x' + Number(got).toString(16);
    if (norm === want) {
      const v = pick(ent, ['Value', 'value']);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/** One mailbox, as the mirror stores addresses: "Name <addr>" or just the address. */
function oneAddress(box) {
  if (!box) return { text: '', name: '', address: '' };
  const m = pick(box, ['Mailbox', 'mailbox']) || box;
  const name = String(pick(m, ['Name', 'name', 'DisplayName']) || '').trim();
  const address = String(pick(m, ['EmailAddress', 'emailAddress', 'Address', 'address', 'SmtpAddress']) || '').trim();
  const text = name && address ? name + ' <' + address + '>' : (address || name);
  return { text, name, address };
}

function manyAddresses(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  return arr.map((b) => oneAddress(b).text).filter(Boolean).join(', ');
}

/* How much of a recipient list is kept on a row. A To header has no length
   limit and a distribution list can run to hundreds of names; two thousand
   characters is roughly forty people, which is already past the point where
   anybody reads the list rather than searches it. */
const MAX_PARTY_CHARS = 2000;

/**
 * A recipient list, capped between recipients rather than through one.
 *
 * `clean(..., 600)` used to do this, and its cut landed wherever 600 fell:
 * 「王小明 <ming@ab」 is not an address, matches no search, and looks like a
 * real one on screen. Cutting whole recipients and saying how many were left
 * out is the version a reader can trust -- an elided list says so.
 */
function manyParties(list) {
  const all = (Array.isArray(list) ? list : (list ? [list] : []))
    .map((b) => clean(oneAddress(b).text, 200)).filter(Boolean);
  const kept = [];
  let len = 0;
  for (const one of all) {
    if (kept.length && len + one.length + 2 > MAX_PARTY_CHARS) break;
    kept.push(one);
    len += one.length + 2;
  }
  if (kept.length < all.length) kept.push(`（另有 ${all.length - kept.length} 人未列出）`);
  return kept.join(', ');
}

function timeOf(v) {
  if (!v) return 0;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

/**
 * The key for a message, decided once (decision 3).
 *
 * A real Message-ID is kept exactly as the server wrote it -- trimmed, brackets
 * kept, case kept -- because mail.js messageIdOf() does the same and a message
 * seen through both sources has to land on one row.
 */
/* Names that are not keys, whatever the header says. A Message-ID is chosen by
   whoever sent the message, and these three stop being an entry and start being
   the prototype. The mirror is hardened against them as well; this is the half
   that keeps the message instead of losing it. */
const NOT_A_KEY = /^(__proto__|constructor|prototype)$/;

function keyFor(internetMessageId, sourceId) {
  const real = String(internetMessageId || '').trim();
  if (real && !NOT_A_KEY.test(real)) return real;
  if (!sourceId) return '';
  const h = crypto.createHash('sha1').update(String(sourceId)).digest('hex').slice(0, 32);
  return '<owa-' + h + '@aios.local>';
}

function internetMessageIdOf(item) {
  const named = pick(item, ['InternetMessageId', 'internetMessageId', 'MessageInternetMessageId']);
  if (named) return String(named).trim();
  const ext = extendedValue(item, '0x1035');
  return ext ? String(ext).trim() : '';
}

/** Does this object look like a message rather than a wrapper around messages? */
function looksLikeItem(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  if (!idOf(o)) return false;
  return pick(o, ['Subject', 'subject']) !== undefined
    || pick(o, ['DateTimeReceived', 'dateTimeReceived']) !== undefined
    || pick(o, ['From', 'from', 'Sender']) !== undefined
    || pick(o, ['ItemClass', 'itemClass']) !== undefined;
}

/**
 * Every message in a response, wherever it sits.
 *
 * The documented path is Body.ResponseMessages.Items[].RootFolder.Items[], and
 * following only that path makes one renamed wrapper an empty inbox. This walks
 * instead and stops descending at anything that is itself a message, so an
 * attached message cannot be mistaken for inbox mail.
 */
function walkItems(node, out, depth) {
  out = out || [];
  depth = depth || 0;
  if (!node || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const n of node) walkItems(n, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (looksLikeItem(node)) { out.push(node); return out; }
  for (const k of Object.keys(node)) {
    if (k === 'Attachments' || k === 'attachments') continue;
    walkItems(node[k], out, depth + 1);
  }
  return out;
}

/** Whether the response says this was the last page, when it says anything. */
function lastPage(json) {
  let last = null;
  const walk = (n, d) => {
    if (!n || typeof n !== 'object' || d > 10 || last !== null) return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, d + 1)); return; }
    const v = pick(n, ['IncludesLastItemInRange', 'includesLastItemInRange']);
    if (v !== undefined) { last = !!(v === true || v === 'true'); return; }
    Object.keys(n).forEach((k) => walk(n[k], d + 1));
  };
  walk(json, 0);
  return last;
}

/**
 * One message, reduced to the shape the mirror stores.
 *
 * `missing` lists the fields this response did not carry. It is not decoration:
 * the day Microsoft renames something, that list is the only warning before the
 * list view quietly shows a column of empty senders.
 */
/**
 * A string a stranger wrote, made safe to put in a list, a note, a dialog.
 *
 * Control characters go because a subject carrying a newline can forge a second
 * line anywhere this text is laid out one per line -- a context page the model
 * reads, the taint reason in a consent dialog, a markdown note. The cap is
 * because a header has no length limit and a list row does.
 */
function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 200);
}

function normaliseItem(raw, opts = {}) {
  const folder = opts.folder || 'INBOX';
  const missing = [];
  const need = (name, v) => { if (v === undefined || v === '' || v === null) missing.push(name); return v; };

  const sourceId = idOf(raw);
  const internetMessageId = internetMessageIdOf(raw);
  const from = oneAddress(pick(raw, ['From', 'from', 'Sender', 'sender']));
  const date = timeOf(pick(raw, ['DateTimeReceived', 'dateTimeReceived', 'DateTimeSent', 'dateTimeSent']));
  const subject = pick(raw, ['Subject', 'subject']);
  const read = pick(raw, ['IsRead', 'isRead']);
  const hasAtt = pick(raw, ['HasAttachments', 'hasAttachments']);

  need('sourceId', sourceId);
  need('from', from.text);
  need('date', date || undefined);
  need('subject', subject);

  return {
    messageId: keyFor(internetMessageId, sourceId),
    sourceId,
    internetMessageId,
    folder,
    from: clean(from.text, 200),
    fromName: clean(from.name, 120),
    to: manyParties(pick(raw, ['ToRecipients', 'toRecipients'])),
    cc: manyParties(pick(raw, ['CcRecipients', 'ccRecipients'])),
    subject: clean(subject, 200) || '(無主旨)',
    date,
    seen: read === undefined ? false : !!(read === true || read === 'true'),
    hasAttachments: !!(hasAtt === true || hasAtt === 'true'),
    inReplyTo: String(pick(raw, ['InReplyTo', 'inReplyTo']) || ''),
    references: String(pick(raw, ['References', 'references']) || ''),
    webLink: sourceId ? deepLink(sourceId) : '',
    missing
  };
}

function deepLink(sourceId) {
  return base() + '/mail/deeplink/read/' + encodeURIComponent(sourceId);
}

/** HTML to text: no remote images means no read receipt, no script means no active content. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The message exactly as it arrived, when it arrived as markup. */
function rawHtmlOf(item) {
  const body = pick(item, ['NormalizedBody', 'Body', 'body', 'UniqueBody']);
  if (!body) return '';
  if (typeof body === 'string') return /<[a-z!/]/i.test(body) ? body : '';
  const type = String(pick(body, ['BodyType', 'bodyType', 'ContentType']) || '');
  if (/text|plain/i.test(type)) return '';
  const value = pick(body, ['Value', 'value', 'Content', 'content']);
  return value == null ? '' : String(value);
}

/** The readable text of one message, whichever body field this version used. */
function bodyTextOf(item) {
  const body = pick(item, ['NormalizedBody', 'Body', 'body', 'UniqueBody', 'TextBody']);
  if (!body) return '';
  if (typeof body === 'string') return htmlToText(body);
  const value = pick(body, ['Value', 'value', 'Content', 'content']);
  const type = String(pick(body, ['BodyType', 'bodyType', 'ContentType']) || 'HTML');
  const text = value == null ? '' : String(value);
  return /text|plain/i.test(type) ? text.trim() : htmlToText(text);
}

/** Attachment metadata, flattened out of whichever wrapper carries it. */
function attachmentsOf(item) {
  const list = pick(item, ['Attachments', 'attachments']);
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  const out = [];
  for (const ent of arr) {
    const a = pick(ent, ['FileAttachment', 'fileAttachment', 'ItemAttachment', 'itemAttachment']) || ent;
    const idRaw = pick(a, ['AttachmentId', 'attachmentId']);
    const id = typeof idRaw === 'string' ? idRaw : String(pick(idRaw, ['Id', 'id']) || '');
    /* Kept because an attachment id is not always just its Id: some servers want
       the RootItemId and change key back with it, and the only way to find out
       is to be able to hand back what was given. */
    const whole = (idRaw && typeof idRaw === 'object') ? idRaw : null;
    const inline = pick(a, ['IsInline', 'isInline']);
    out.push({
      id,
      idRaw: whole,
      name: clean(pick(a, ['Name', 'name', 'FileName']), 200) || '未命名附件',
      type: String(pick(a, ['ContentType', 'contentType']) || 'application/octet-stream'),
      bytes: Number(pick(a, ['Size', 'size', 'ContentSize'])) || 0,
      inline: !!(inline === true || inline === 'true')
    });
  }
  return out;
}

/* ---------------------------------------------------------- sync, pure ---- */

/**
 * How far back this sync should reach, and whether it is the first.
 *
 * Split out from the fetching because this is where the sync is right or wrong
 * and none of it needs a network. Three cases, one line each: a mirror that has
 * never seen this folder reaches back FIRST_DAYS; a full rescan does the same
 * on purpose; an ordinary sync reaches back to where it stopped last time,
 * minus an overlap. The overlap is decision 4 -- a strict boundary drops every
 * message sharing its second with the last one on the page.
 */
function syncPlan({ cursor = {}, deep = false, days = 0, now = 0 } = {}) {
  const at = now || Date.now();
  const first = !cursor.owaSince;
  const floor = (first || deep)
    ? at - (days || FIRST_DAYS) * 86400000
    : Math.max(0, cursor.owaSince - OVERLAP_MS);
  return { first, deep: !!deep, floor };
}

/**
 * One page of responses turned into mirror rows.
 *
 * `lookup(sourceId)` is the mirror saying whether it already has a row for this
 * item, and `has(messageId)` whether that key is known at all. Both are passed
 * in rather than read, so the rule that decides identity can be tested without
 * a mailbox: an item whose row exists keeps the key it was given, whatever
 * fields this particular response happened to carry (decision 3).
 *
 * `stop` means the page reached past the floor. The caller stops paging then --
 * the sort is newest first, so everything after it is older still.
 */
function adoptPage(items, { folder = 'INBOX', floor = 0, lookup, has, sorted = true } = {}) {
  const find = typeof lookup === 'function' ? lookup : () => null;
  const known = typeof has === 'function' ? has : () => false;
  const rows = [];
  const fresh = [];
  let missing = [];
  let stop = false;
  let newest = 0;

  for (const raw of (items || [])) {
    const row = normaliseItem(raw, { folder });
    if (!row.sourceId) { missing.push('sourceId'); continue; }
    if (row.date && row.date < floor) {
      /* Older than the floor: never stored. Whether it also means "and
         everything after it is older" depends on the page being sorted
         newest-first -- which is measured, not guaranteed. On a server that
         refused the sort, stopping here would end the sync at the first old
         message in an arbitrary order and call the folder done. */
      if (sorted) stop = true;
      continue;
    }

    const held = find(row.sourceId);
    const id = held || row.messageId;
    if (!id) { missing.push('messageId'); continue; }
    if (!known(id)) fresh.push(id);
    if (row.date > newest) newest = row.date;
    if (row.missing.length) missing = missing.concat(row.missing);

    rows.push({
      messageId: id,
      folder,
      from: row.from,
      fromName: row.fromName,
      to: row.to,
      cc: row.cc,
      subject: row.subject,
      date: row.date,
      seen: row.seen,
      inReplyTo: row.inReplyTo,
      references: row.references,
      webLink: row.webLink,
      sourceId: row.sourceId,
      hasAttachments: row.hasAttachments
    });
  }
  return { rows, fresh, stop, newest, missing: [...new Set(missing)] };
}

/* ------------------------------------------------------- request bodies ---- */

/* The property list is the single most likely thing to be wrong in this file,
   and InternetMessageId is the one that matters: without it every row falls
   back to a hash key (decision 3). It is asked for twice on purpose -- the
   named property and extended property 0x1035 -- because a server that rejects
   one spelling usually honours the other, and the normaliser reads both. */
const LIST_PROPERTIES = [
  { __type: 'PropertyUri:#Exchange', FieldURI: 'ItemSubject' },
  { __type: 'PropertyUri:#Exchange', FieldURI: 'ItemDateTimeReceived' },
  { __type: 'PropertyUri:#Exchange', FieldURI: 'ItemHasAttachments' },
  { __type: 'PropertyUri:#Exchange', FieldURI: 'MessageFrom' },
  { __type: 'PropertyUri:#Exchange', FieldURI: 'MessageToRecipients' },
  { __type: 'PropertyUri:#Exchange', FieldURI: 'MessageCcRecipients' },
  { __type: 'PropertyUri:#Exchange', FieldURI: 'MessageIsRead' },
  { __type: 'PropertyUri:#Exchange', FieldURI: 'MessageInternetMessageId' },
  { __type: 'ExtendedPropertyUri:#Exchange', PropertyTag: '0x1035', PropertyType: 'String' }
];

function findItemBody(folderId, offset, count) {
  const d = DIALECT;
  const shape = { __type: 'ItemResponseShape:#Exchange', BaseShape: d.baseShape || 'AllProperties' };
  const props = listProperties(d);
  if (props.length) shape.AdditionalProperties = props;

  const body = {
    __type: 'FindItemJsonRequest:#Exchange',
    Header: { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: 'V2018_01_18' },
    Body: {
      __type: 'FindItemRequest:#Exchange',
      ItemShape: shape,
      ParentFolderIds: [folderFor(d)(folderId)],
      Traversal: 'Shallow',
      Paging: pageFor(d)(Math.max(1, Math.min(PAGE, count | 0)), Math.max(0, offset | 0))
    }
  };
  /* Newest-first is what makes an incremental sync cheap; a server that refuses
     to sort still syncs, it just has to walk further. */
  if (d.sortable) {
    const sort = sortByReceived(d);
    if (sort) body.Body.SortOrder = sort;
  }
  return body;
}

/* What a list row needs, in whichever spelling was measured. Asked for even
   under BaseShape AllProperties, because AllProperties is a promise about the
   server's idea of "all" and InternetMessageId is the one field the mirror's
   identity depends on (decision 3). */
function listProperties(d) {
  const out = [];
  if (d.namedProps) {
    for (const name of ['subject', 'received', 'hasAttachments', 'from', 'to', 'cc', 'isRead', 'internetMessageId']) {
      const path = fieldPath(name, d);
      if (path) out.push(path);
    }
  }
  if (d.extendedImid) out.push({ __type: d.extendedImid, PropertyTag: '0x1035', PropertyType: 'String' });
  return out;
}

function getItemBody(sourceId, over) {
  const d = { ...DIALECT, ...(over || {}) };
  const shape = { __type: 'ItemResponseShape:#Exchange', BaseShape: d.getBaseShape || 'AllProperties' };
  /* HTML, and the text is derived from it here.
     It used to ask for Text, on the reasoning that text has no script and no
     remote image in it -- true, and it also has no table, no quotation and no
     heading, which made a report unreadable. The formatting is kept and made
     safe where it is shown instead: app/renderer/mailhtml.js rebuilds it from
     an allowed list, inside a frame that cannot run scripts, under a policy
     that fetches nothing. */
  if (d.getBodyType) shape.BodyType = 'HTML';

  const extras = [];
  if (d.namedProps && d.getExtras && d.getExtras !== 'none') {
    const wanted = d.getExtras === 'body' ? ['body'] : ['body', 'attachments', 'inReplyTo', 'references'];
    for (const name of wanted) {
      const path = fieldPath(name, d);
      if (path) extras.push(path);
    }
  }
  if (extras.length) shape.AdditionalProperties = extras;

  return {
    __type: 'GetItemJsonRequest:#Exchange',
    Header: { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: 'V2018_01_18' },
    Body: {
      __type: 'GetItemRequest:#Exchange',
      ItemShape: shape,
      ItemIds: [{ __type: 'ItemId:#Exchange', Id: String(sourceId) }]
    }
  };
}

/* How this server wants an attachment asked for. Measured like the rest: the
   first real tenant refused the documented shape with "invalid argument". */
const ATTACHMENT_SHAPES = [
  {
    name: 'RequestAttachmentId ＋ 空的 AttachmentShape',
    build: (a) => ({
      AttachmentShape: { __type: 'AttachmentResponseShape:#Exchange' },
      AttachmentIds: [{ __type: 'RequestAttachmentId:#Exchange', Id: a.id }]
    })
  },
  {
    name: 'RequestAttachmentId，不給 AttachmentShape',
    build: (a) => ({ AttachmentIds: [{ __type: 'RequestAttachmentId:#Exchange', Id: a.id }] })
  },
  {
    name: 'AttachmentIdType',
    build: (a) => ({ AttachmentIds: [{ __type: 'AttachmentIdType:#Exchange', Id: a.id }] })
  },
  {
    name: '只給 Id，不給型別',
    build: (a) => ({ AttachmentIds: [{ Id: a.id }] })
  },
  {
    name: '把伺服器給的整個 AttachmentId 原封奉還',
    build: (a) => (a.idRaw ? { AttachmentIds: [a.idRaw] } : null)
  },
  {
    name: 'RequestAttachmentId ＋ IncludeMimeContent',
    build: (a) => ({
      AttachmentShape: { __type: 'AttachmentResponseShape:#Exchange', IncludeMimeContent: true, BodyType: 'Best' },
      AttachmentIds: [{ __type: 'RequestAttachmentId:#Exchange', Id: a.id }]
    })
  }
];

/* Which of the shapes above worked, and under which action name. */
let ATTACHMENT_PLAN = { shape: 1, action: 'GetAttachment' };
/* When the ladder was last walked and came back with nothing. Without this, a
   message whose attachments the server will not hand back cost a full twelve
   request ladder per attachment, every time it was opened. */
let attachmentLadderFailedAt = 0;
const ATTACHMENT_RETRY_MS = 5 * 60 * 1000;

function getAttachmentBody(attachment, shapeIndex) {
  const a = typeof attachment === 'string' ? { id: attachment, idRaw: null } : (attachment || {});
  const i = shapeIndex === undefined ? ATTACHMENT_PLAN.shape : shapeIndex;
  const parts = ATTACHMENT_SHAPES[i] && ATTACHMENT_SHAPES[i].build(a);
  if (!parts) return null;
  return {
    __type: 'GetAttachmentJsonRequest:#Exchange',
    Header: { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: 'V2018_01_18' },
    Body: { __type: 'GetAttachmentRequest:#Exchange', ...parts }
  };
}

function attachmentPlan() {
  return { ...ATTACHMENT_PLAN };
}

/**
 * Which attachment request this server accepts, measured against a real one.
 *
 * Without this the reader shows a name and a size for a file nobody can ever
 * open, which is the failure the mirror's own attachment rules exist to stop.
 */
async function probeAttachment(attachment, steps) {
  const names = ['GetAttachment', 'GetFileAttachment'];
  for (const action of names) {
    for (let i = 0; i < ATTACHMENT_SHAPES.length; i++) {
      const body = getAttachmentBody(attachment, i);
      if (!body) continue;
      let rec;
      try {
        const res = await send(action, body);
        const content = res.bad ? null : attachmentContentOf(JSON.parse(res.facts.text));
        rec = {
          label: '附件：' + action + ' / ' + ATTACHMENT_SHAPES[i].name,
          ok: !res.bad && !!content,
          status: res.facts.status,
          fault: res.bad ? faultOf(res.facts.text) : (content ? '' : '回了 200 但沒有內容')
        };
        if (rec.ok) {
          if (steps) steps.push(rec);
          ATTACHMENT_PLAN = { shape: i, action };
          return ATTACHMENT_PLAN;
        }
      } catch (e) {
        rec = { label: '附件：' + action + ' / ' + ATTACHMENT_SHAPES[i].name, ok: false, status: 0, fault: String(e.message || e) };
      }
      if (steps) steps.push(rec);
    }
  }
  return null;
}

/** The base64 content of one attachment, out of whichever wrapper holds it. */
function attachmentContentOf(json) {
  let found = null;
  const walk = (n, d) => {
    if (!n || typeof n !== 'object' || d > 10 || found !== null) return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, d + 1)); return; }
    const v = pick(n, ['Content', 'content']);
    if (typeof v === 'string' && v.length) { found = v; return; }
    Object.keys(n).forEach((k) => walk(n[k], d + 1));
  };
  walk(json, 0);
  return found;
}

/** Did the request end up at Microsoft's sign-in host? */
function atLoginHost(url) {
  return /login\.(microsoftonline|live|windows|windows-ppe)\.(com|net)|\/common\/oauth2\//i
    .test(String(url || ''));
}

/**
 * Did this response mean "sign in again"?
 *
 * The first version of this said yes to every HTML response and every 403, and
 * so reported 「登入過期了」 for a wrong endpoint, a canary mismatch and a tenant
 * that authenticates some other way -- three different problems with three
 * different fixes, all wearing the one label that sends the user to re-enter a
 * password that was never wrong. HTML only counts when the HTML is a sign-in
 * page, and 403 gets its own answer below.
 */
function needsLogin({ url, status, contentType, text } = {}) {
  if (atLoginHost(url)) return true;
  if (status === 401 || status === 440) return true;
  const body = String(text || '').slice(0, 4000);
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html')) {
    return /sign in|signin|登入|msalAuth|aadcdn|urlOwaFallback|login\.microsoftonline/i.test(body);
  }
  /* Deliberately NOT run against a JSON body. It used to be, and a JSON body is
     where message subjects and sender names live -- so a stranger could name a
     message `X-OWA-Error: Auth` and every sync from then on would report the
     user's session as expired and stop. An error belongs in an envelope, and a
     JSON envelope is read by faultOf, not by grepping the payload. */
  if (!ct.includes('json') && /X-OWA-Error["\s:]+[^"]*(Auth|Canary|Expired)/i.test(body)) return true;
  return false;
}

/**
 * What went wrong, in terms of what the user can do about it.
 *
 * Returns null when the response is usable. Every branch names a different
 * action, because they are different problems: signing in again does nothing
 * for a wrong endpoint, and reloading the mailbox tab does nothing for an
 * expired session.
 */
function classify({ url, status, contentType, text } = {}) {
  if (needsLogin({ url, status, contentType, text })) {
    return { code: 'ENEEDLOGIN', message: '需要在瀏覽器重新登入 Outlook' };
  }
  const ct = String(contentType || '').toLowerCase();
  if (status === 403) {
    return {
      code: 'EFORBIDDEN',
      message: 'Outlook 拒絕了這個請求（403）。通常是 canary 不對：' +
        '把 Outlook 那個分頁重新整理一次，再按收信。'
    };
  }
  if (ct.includes('text/html')) {
    return {
      code: 'ESHAPE',
      message: '這個網址回的是網頁不是 JSON（狀態 ' + status + '）。' +
        '你的租戶上 Outlook 的介面路徑可能不一樣，按「診斷」看它實際回了什麼。'
    };
  }
  if (status < 200 || status >= 300) {
    /* The server's own words matter here: a 400 from EWS says which part of the
       request it did not understand, and that sentence is the difference
       between fixing it and guessing at it. */
    const said = scrub(String(text || '').slice(0, 200));
    return {
      code: 'EREMOTE',
      message: 'Outlook 網頁信箱回了 ' + status + (said ? '：' + said : '')
    };
  }
  return null;
}

/* ------------------------------------------------------------- impure ------ */

function base() {
  return (account && account.base) || DEFAULT_BASE;
}

function configure(conf) {
  /* A learned template belongs to one mailbox. Changing the account without
     dropping it meant the next sync ran for fifteen minutes with the previous
     account's bearer and anchor-mailbox headers, reading mailbox A into account
     B's mirror -- which the mirror cannot tell apart from B's own mail. */
  release();
  account = conf && conf.email
    ? { email: String(conf.email), base: sanitiseBase(conf.base) }
    : null;
  sampling = new Set();
  if (account) startKeepAlive();
  return account;
}

/** The origin of a URL, or '' when it is not one. */
function originOf(url) {
  try { return new URL(String(url)).origin; } catch (e) { return ''; }
}

/**
 * Where this account's mailbox is read from.
 *
 * Anything not on the known list becomes the default rather than being trusted:
 * this value decides where a bearer token is sent, so a typo in it is a typo
 * with a credential attached.
 */
function sanitiseBase(v) {
  const raw = String(v || '').trim() || DEFAULT_BASE;
  let u;
  try { u = new URL(raw); } catch (e) { return DEFAULT_BASE; }
  if (!knownOrigin(u.origin)) return DEFAULT_BASE;
  return u.origin;
}

function configured() {
  return !!(account && account.email);
}

function partition() {
  if (!session || !session.fromPartition) throw fail('ENOSESSION', '瀏覽器分區還沒準備好');
  return session.fromPartition(PARTITION);
}

/**
 * The canary OWA wants echoed back in a header.
 *
 * It is the value of the cookie of the same name, which is how the page itself
 * gets it; reading a cookie is not reading a password. Absent is not fatal --
 * some builds accept the request without it -- so a missing canary is reported
 * rather than thrown.
 */
async function canaryOf(ses) {
  try {
    const jar = await ses.cookies.get({ url: base(), name: 'X-OWA-CANARY' });
    if (jar && jar.length && jar[0].value) return String(jar[0].value);
  } catch { /* no jar yet */ }
  try {
    const all = await ses.cookies.get({ url: base() });
    const hit = (all || []).find((c) => /canary/i.test(c.name));
    return hit ? String(hit.value) : '';
  } catch {
    return '';
  }
}

async function cookieCount() {
  try {
    const all = await partition().cookies.get({ url: base() });
    return (all || []).length;
  } catch {
    return 0;
  }
}

/** Only the headers we are willing to reuse, and never a pseudo-header. */
function reusableHeaders(headers) {
  const out = {};
  for (const k of Object.keys(headers || {})) {
    if (k.startsWith(':')) continue;
    if (FORWARD.test(k)) out[k] = String(headers[k]);
  }
  return out;
}

/**
 * A tab already showing this mailbox, or null.
 *
 * Origins are compared, not prefixes. `indexOf(origin) === 0` let
 * `https://outlook.office.com.evil.example/` pass for the real mailbox -- and
 * that tab would then have been handed the debugger and asked for the headers
 * it signs its requests with. A prefix is not an origin; only an origin is.
 */
function mailboxTab() {
  let list = [];
  try { list = browser.list() || []; } catch (e) { return null; }
  const origin = base();
  /* The mailbox may be served from any of Microsoft's Outlook origins, and a
     tenant mid-migration answers on two of them at once. What must not count is
     a host that merely looks like one. */
  const hit = list.find((t) => {
    if (!t || typeof t.url !== 'string' || ownTabs.has(t.id)) return false;
    const o = originOf(t.url);
    return o === origin || knownOrigin(o);
  });
  return hit || null;
}

/**
 * Learn how the signed-in page asks, from the page itself.
 *
 * Prefers a tab the user already has open, because that costs nothing and the
 * page is already signed in. With none open it opens one of its own and takes
 * it away again -- which is what lets a scheduled run at eight in the morning
 * work without the user having left a tab up overnight. The cookies that let
 * that tab sign in silently are the ones the user's own sign-in left behind, so
 * this stops working exactly when the tenant says the session is over, and then
 * it says so.
 */
async function learnTemplate(opts) {
  /* One at a time. Concurrent learners opened a tab each and the first one to
     finish destroyed a tab the second was still listening to. */
  if (learning) return learning;
  learning = learnOnce(opts || {}).finally(() => { learning = null; });
  return learning;
}

async function learnOnce({ allowOpen = true } = {}) {
  const origin = base();
  /* A tab the user has open is preferred: it is already signed in, already
     loaded, and costs nothing. */
  let tab = mailboxTab();
  let usingWorker = false;

  if (!tab && workerTab && stillOpen(workerTab)) {
    tab = { id: workerTab };
    usingWorker = true;
  }

  if (!tab) {
    /* A caller that is watching a sign-in in progress must not open a tab of
       its own: the user's login tab is on Microsoft's host, not the mailbox's,
       so every poll would look like "no mailbox tab" and mint another one --
       one new tab every few seconds for as long as the user takes to find
       their phone. */
    if (!allowOpen) throw fail('ENOTAB', '現在沒有開著的 Outlook 信箱分頁');
    try {
      const made = browser.create({ url: loginUrl() });
      workerTab = made.id;
      ownTabs.add(workerTab);
      tab = made;
      usingWorker = true;
    } catch (e) {
      throw fail('ENOTAB', '沒有開著的 Outlook 分頁，也開不了新的：' + String(e.message || e));
    }
  }

  /* Any Outlook origin may be the one the page talks to -- the web app is
     mid-migration between two of them -- but it has to be one of those, and the
     path has to be the service endpoint. A request to some other host that
     merely has /owa/service.svc in its path is not a candidate. */
  const wanted = /^https?:\/\/[^/]+\/owa\/service\.svc/i;

  try {
    /* The two answers race. A tab on the sign-in page will never send a mailbox
       request, so waiting out the timeout to discover that is a minute the user
       spends looking at a message that will not open. */
    const first = await learnOrLogin(tab.id, wanted,
      usingWorker ? LEARN_FRESH_MS : LEARN_EXISTING_MS);
    if (first.login) {
      if (usingWorker) dropWorker();
      throw fail('ENEEDLOGIN',
        'Outlook 的登入過期了，分頁被導到微軟的登入頁。' +
        '請按「帳號」裡的「在瀏覽器登入 Outlook」重新登入一次（email → 密碼 → 2FA），' +
        '登入完成後它會自己把瀏覽器收起來、把信收進來。');
    }
    let seen = first.seen;

    /* A tab that is loaded but idle. A background page is throttled and may not
       poll at all, so rather than waiting longer, make it talk: reloading is
       what produces the startup burst of service.svc calls. The user's own tab
       is never reloaded -- it is the page they are looking at -- so a worker
       tab is opened for that instead. */
    if (!seen && usingWorker) {
      try {
        browser.reload(tab.id);
        const again = await learnOrLogin(tab.id, wanted, LEARN_FRESH_MS);
        if (again.login) {
          dropWorker();
          throw fail('ENEEDLOGIN',
            'Outlook 的登入過期了。請按「帳號」裡的「在瀏覽器登入 Outlook」重新登入一次。');
        }
        seen = again.seen;
      } catch (e) {
        if (isLoginError(e)) throw e;
        /* anything else falls through to the honest failure below */
      }
    }
    if (!seen && !usingWorker) {
      try {
        const made = browser.create({ url: loginUrl() });
        workerTab = made.id;
        ownTabs.add(workerTab);
        usingWorker = true;
        seen = await browser.learnRequest(workerTab, { match: wanted, timeout: LEARN_FRESH_MS });
      } catch (e) { /* falls through */ }
    }

    if (!seen) {
      throw fail('ENOLEARN',
        '連不上 Outlook 的介面：背景分頁在 ' + Math.round(LEARN_FRESH_MS / 1000) +
        ' 秒內沒有送出任何請求。多半是登入過期了——按「帳號」裡的「在瀏覽器登入 Outlook」重新登入一次；' +
        '如果已經登入著，把那個分頁留在信箱畫面上再試一次。');
    }

    /* Observed, not assumed. The origin the template is stamped with is the one
       the request actually went to; anything else and the token would be
       replayed somewhere it was never issued for. */
    const learnedFrom = originOf(seen.url);
    if (!knownOrigin(learnedFrom)) {
      throw fail('EORIGIN',
        '學到的請求是送去 ' + (learnedFrom || '不明來源') + ' 的，那不是 Outlook 的網域，不採用。');
    }

    const headers = reusableHeaders(seen.headers);
    if (!headers.authorization) {
      throw fail('ENEEDLOGIN',
        'Outlook 分頁送出的請求沒有帶憑證，表示那個分頁還沒真的登入。請在分頁裡完成登入（含 2FA）再試一次。');
    }
    /* A learn that worked means the session is alive; if the keeper had given
       up because it was not, this is the moment it can start again. */
    if (!keepTimer && configured()) startKeepAlive();
    template = {
      /* Learned from `learnedFrom`, sent to `origin`. They are allowed to
         differ only because both are on the known list and Microsoft serves one
         mailbox from several of them; nothing else may be either. */
      learnedFrom,
      origin,
      /* Which mailbox this belongs to, so a changed account cannot keep using
         it -- see configure(). */
      email: account ? account.email : '',
      headers,
      at: Date.now()
    };
    return template;
  } catch (e) {
    /* A worker tab that could not teach us anything is not worth keeping: the
       next attempt should start from a fresh load rather than inherit whatever
       state this one is stuck in. */
    if (usingWorker) dropWorker();
    throw e;
  }
}

/**
 * Where a tab has actually landed, once it has landed anywhere.
 *
 * A tab opened at the mailbox and redirected to Microsoft's sign-in page looks,
 * to a request watcher, exactly like a mailbox that is being slow: nothing
 * matches, and the wait runs to its timeout. Twice, because the retry reloads
 * and waits again. Two minutes to conclude something the URL said in three
 * seconds -- and the user meets it as 「有些郵件會無法讀取」, one message at a
 * time.
 */
async function settledUrl(id, ms) {
  const until = Date.now() + (ms || 8000);
  let seen = '';
  while (Date.now() < until) {
    let url = '';
    try {
      const tab = (browser.list() || []).find((t) => t && t.id === id);
      url = tab ? String(tab.url || '') : '';
    } catch (e) { return seen; }
    if (url && url !== 'about:blank') {
      /* The same URL twice running is a page that has stopped moving. */
      if (url === seen) return url;
      seen = url;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 600));
  }
  return seen;
}

/** Did this tab end up at the sign-in page rather than at the mailbox? */
async function landedOnLogin(id) {
  const url = await settledUrl(id, 9000);
  return !!url && atLoginHost(url);
}

/**
 * Watch a tab's address until it is somewhere that will never send a mailbox
 * request, and say so.
 *
 * Run alongside the request watch rather than before it, because a tab that has
 * just been created is still on about:blank when a one-shot check looks -- and
 * then the redirect to the sign-in page happens, and the whole minute is spent
 * waiting for a request from a page that is asking for a password. Measured at
 * sixty-two seconds for something the URL says in three.
 */
function watchForLogin(id, ms) {
  return new Promise((resolve) => {
    const until = Date.now() + (ms || LEARN_FRESH_MS);
    const timer = setInterval(() => {
      let url = '';
      try {
        const tab = (browser.list() || []).find((t) => t && t.id === id);
        url = tab ? String(tab.url || '') : '';
        if (!tab) { clearInterval(timer); resolve(null); return; }
      } catch (e) { clearInterval(timer); resolve(null); return; }
      if (url && atLoginHost(url)) { clearInterval(timer); resolve('login'); return; }
      if (Date.now() > until) { clearInterval(timer); resolve(null); }
    }, 700);
  });
}

/** The request, or the discovery that no request is coming. Whichever is first. */
async function learnOrLogin(id, match, timeout) {
  const got = await Promise.race([
    browser.learnRequest(id, { match, timeout }).then((x) => ({ seen: x })),
    watchForLogin(id, timeout).then((x) => (x === 'login' ? { login: true } : new Promise(() => {})))
  ]);
  return got;
}

function stillOpen(id) {
  try {
    return (browser.list() || []).some((t) => t && t.id === id);
  } catch (e) {
    return false;
  }
}

function dropWorker() {
  if (!workerTab) return;
  const id = workerTab;
  workerTab = null;
  ownTabs.delete(id);
  try { browser.destroy(id); } catch (e) { /* already gone */ }
}

function templateFresh() {
  if (!template) return false;
  if (template.origin !== base()) return false;
  if (template.email !== (account ? account.email : '')) return false;
  return (Date.now() - template.at) < TEMPLATE_MAX_AGE_MS;
}

async function ensureTemplate(opts) {
  if (templateFresh()) return template;
  template = null;
  return learnTemplate(opts);
}

/** Thrown away when the server says the credential is no longer good. */
function forgetTemplate() {
  template = null;
}

/** Everything this module is holding open. Called when the account goes away. */
function release() {
  stopKeepAlive();
  keepState = { at: 0, ok: false, note: '' };
  forgetTemplate();
  dropWorker();
}

/**
 * One EWS-over-JSON call, from the tab session the user signed in with.
 *
 * Nothing here knows a password. The request carries the partition's cookies
 * because `credentials: 'include'` makes the session attach them, exactly as it
 * does for the tab that is showing the mailbox.
 */
/**
 * One request, with the facts of the answer and no opinion about them.
 *
 * Split out of `call` so a shape probe can read a refusal instead of being
 * thrown at: telling which request the server accepts means seeing the ones it
 * did not, and a function that throws cannot report that comparison.
 */
async function send(action, body) {
  if (!configured()) throw fail('ENOACCOUNT', '還沒設定 Outlook 網頁信箱帳號');
  const ses = partition();
  const tpl = await ensureTemplate();
  const canary = await canaryOf(ses);

  const url = tpl.origin + '/owa/service.svc?action=' + encodeURIComponent(action) +
    '&app=Mail&n=' + (seq++);
  const headers = {
    ...tpl.headers,
    'Content-Type': 'application/json; charset=utf-8',
    Accept: '*/*',
    Action: action,
    'X-OWA-ActionSource': action,
    'X-OWA-CorrelationId': crypto.randomUUID(),
    Origin: tpl.origin,
    Referer: tpl.origin + '/mail/'
  };
  if (canary) headers['X-OWA-CANARY'] = canary;

  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), REQUEST_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await ses.fetch(url, {
      method: 'POST',
      credentials: 'include',
      signal: stop.signal,
      headers,
      body: JSON.stringify(body)
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_RESPONSE_BYTES) throw fail('ETOOBIG', '回應太大：' + buf.length + ' 位元組');
    text = buf.toString('utf8');
  } catch (e) {
    if (e && e.code) throw e;
    if (e && e.name === 'AbortError') throw fail('ETIMEOUT', 'Outlook 網頁信箱沒有在時間內回應');
    throw fail('ENET', '連不上 Outlook 網頁信箱：' + String((e && e.message) || e));
  } finally {
    clearTimeout(timer);
  }

  const ct = res.headers.get('content-type') || '';
  const facts = { url: res.url, status: res.status, contentType: ct, text };
  return { facts, asked: url, bad: classify(facts) };
}

/* Only these two are built from the dialect, so only these two are worth
   re-measuring for. An attachment request carries an id and nothing else;
   running the whole property ladder for it would cost a dozen requests and
   change nothing about the one that failed. */
const REBUILDABLE = /^(FindItem|GetItem)$/;

/**
 * The same request, asked again in the dialect just measured.
 *
 * Only the two requests whose shape depends on the dialect are rebuilt; the
 * attachment fetch carries an id and nothing else, so there is nothing in it a
 * property spelling could invalidate.
 */
function rebuild(action, body) {
  try {
    if (action === 'FindItem') {
      const b = body.Body;
      const folderId = (b.ParentFolderIds[0].Id) ||
        (b.ParentFolderIds[0].BaseFolderId && b.ParentFolderIds[0].BaseFolderId.Id) || 'inbox';
      return findItemBody(folderId, b.Paging.Offset || 0, b.Paging.MaxEntriesReturned || PAGE);
    }
    if (action === 'GetItem') return getItemBody(body.Body.ItemIds[0].Id);
  } catch (e) { /* the shape was not one of ours */ }
  return body;
}

/**
 * One EWS-over-JSON call, or a refusal that says what to do about it.
 */
async function call(action, body, { retried = false, remeasured = false } = {}) {
  const { facts, asked, bad } = await send(action, body);
  if (bad) {
    /* A token that has expired looks exactly like never having signed in. The
       difference is that one of them is fixed by asking the page again, so that
       is tried once before the user is told to go and log in. */
    if ((bad.code === 'ENEEDLOGIN' || bad.code === 'EFORBIDDEN') && !retried) {
      forgetTemplate();
      return call(action, body, { retried: true, remeasured });
    }
    /* "Invalid argument", naming no argument, is what this server says when a
       property spelling has moved under it. The dialect is measurable, so it is
       measured and the call retried rather than failing every sync until
       somebody reads a packet capture. Once per call, and never for the probe
       itself, which would recurse. */
    if (bad.code === 'EREMOTE' && !remeasured && REBUILDABLE.test(action) &&
        /OwaMethodArgumentException|Invalid argument/i.test(facts.text || '')) {
      try {
        await probeShapes({ apply: true });
        return call(action, rebuild(action, body), { retried, remeasured: true });
      } catch (e) { /* fall through to the honest failure below */ }
    }
    const e = fail(bad.code, bad.message);
    /* Carried so the window can show what actually came back instead of making
       the user believe a sentence that may be about the wrong problem. */
    e.detail = evidence(facts, asked);
    throw e;
  }

  let json;
  try {
    json = JSON.parse(facts.text);
  } catch {
    throw fail('ESHAPE', '回應不是 JSON，Outlook 的介面可能改版了');
  }
  await sample(action, body, json);
  return json;
}

/**
 * The facts of one response, safe to show a person.
 *
 * No cookie values, no tokens, no message content beyond what a sign-in page or
 * an error page says about itself. This exists because 「登入過期了」 was being
 * shown for four different problems and the user had no way to see which.
 */
function evidence({ url, status, contentType, text } = {}, asked) {
  return {
    asked: String(asked || ''),
    landedOn: String(url || ''),
    redirected: String(url || '') !== String(asked || ''),
    status: status || 0,
    contentType: String(contentType || ''),
    head: scrub(String(text || '').slice(0, 400))
  };
}

/** Anything token-shaped goes, whatever else the page happened to contain. */
function scrub(s) {
  return String(s)
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, '[權杖已移除]')
    .replace(/(Bearer|canary|token|code|id_token|access_token)[=:"'\s]+[A-Za-z0-9._~+/=-]{12,}/gi, '$1=[已移除]')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A redacted request/response pair, written once per action, under the mirror's
 * own directory so the mirror's purge takes it away with everything else.
 *
 * This exists because the shapes in this file were written without a tenant to
 * look at. The first real sync leaves one honest sample to correct them from.
 */
async function sample(action, request, response) {
  if (sampling.has(action) || !store.ready()) return false;
  sampling.add(action);
  try {
    const body = JSON.stringify({ action, at: Date.now(), request, response }, redact, 1);
    const file = path.join(store.dir(), 'owa-sample-' + action + '.json');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, body.slice(0, SAMPLE_MAX_BYTES), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function redact(key, value) {
  if (/cookie|canary|authorization|token|password/i.test(String(key))) return '[已移除]';
  return value;
}

/* ------------------------------------------------------- shape probing ---- */

/* Decision 6 said the request shapes were the honest weak point and would have
   to be checked against a real server once. This is that check, done by the
   program rather than by a person reading a packet capture -- and the first
   real tenant earned it: of the five things the first version sent, the server
   accepted two, refused two with "invalid argument" naming no argument, and
   answered the fifth with an internal error.

   Every probe reads at most one item and changes nothing. */

const FOLDER_PLAIN = (id) => ({ __type: 'DistinguishedFolderId:#Exchange', Id: id });
const FOLDER_TARGET = (id) => ({
  __type: 'TargetFolderId:#Exchange',
  BaseFolderId: { __type: 'DistinguishedFolderId:#Exchange', Id: id }
});
const PAGE_PLAIN = (n, offset) => ({ __type: 'IndexedPageView:#Exchange', BasePoint: 'Beginning', Offset: offset || 0, MaxEntriesReturned: n });
const PAGE_ITEM = (n, offset) => ({ __type: 'IndexedPageItemView:#Exchange', BasePoint: 'Beginning', Offset: offset || 0, MaxEntriesReturned: n });

/* The property this dialect calls by several names, depending on which version
   of the JSON mapping the server was built from. The logical name is ours; the
   spelling is the server's, and which one it wants is measured, not assumed. */
const FIELDS = {
  subject: { concat: 'ItemSubject', colon: 'item:Subject', bare: 'Subject' },
  received: { concat: 'ItemDateTimeReceived', colon: 'item:DateTimeReceived', bare: 'DateTimeReceived' },
  hasAttachments: { concat: 'ItemHasAttachments', colon: 'item:HasAttachments', bare: 'HasAttachments' },
  from: { concat: 'MessageFrom', colon: 'message:From', bare: 'From' },
  to: { concat: 'MessageToRecipients', colon: 'message:ToRecipients', bare: 'ToRecipients' },
  cc: { concat: 'MessageCcRecipients', colon: 'message:CcRecipients', bare: 'CcRecipients' },
  isRead: { concat: 'MessageIsRead', colon: 'message:IsRead', bare: 'IsRead' },
  internetMessageId: { concat: 'MessageInternetMessageId', colon: 'message:InternetMessageId', bare: 'InternetMessageId' },
  body: { concat: 'ItemBody', colon: 'item:Body', bare: 'Body' },
  attachments: { concat: 'ItemAttachments', colon: 'item:Attachments', bare: 'Attachments' },
  inReplyTo: { concat: 'ItemInReplyTo', colon: 'item:InReplyTo', bare: 'InReplyTo' },
  references: { concat: 'ItemReferences', colon: 'item:References', bare: 'References' }
};

const PROP_TYPES = ['PropertyUri:#Exchange', 'PathToUnindexedFieldType:#Exchange'];
const SPELLINGS = ['concat', 'colon', 'bare'];

/** One property path, in the dialect that was measured to work. */
function fieldPath(name, dialect) {
  const d = dialect || DIALECT;
  const spelt = (FIELDS[name] || {})[d.spelling];
  if (!spelt) return null;
  return { __type: d.propType, FieldURI: spelt };
}

/* InternetMessageId is worth asking for twice: it is what decides a message's
   identity (decision 3), and the extended-property form survived a server that
   refused every named property. 0x1035 is PR_INTERNET_MESSAGE_ID. */
const EXT_IMID = { __type: 'ExtendedPropertyUri:#Exchange', PropertyTag: '0x1035', PropertyType: 'String' };
const EXT_IMID_ALT = { __type: 'PathToExtendedFieldType:#Exchange', PropertyTag: '0x1035', PropertyType: 'String' };

/* What the last measurement found. Defaults are what the first real tenant
   accepted, so a machine that never runs the probe still works there. */
let DIALECT = {
  propType: 'PropertyUri:#Exchange',
  /* Measured, not assumed: a real Exchange Online tenant refused `ItemSubject`
     with "invalid argument" and accepted `item:Subject`. The concatenated
     spelling is in FIELDS as well, because a probe that can only confirm what
     it already believed is not a measurement. */
  spelling: 'colon',
  baseShape: 'AllProperties',
  paging: 'IndexedPageView',
  folder: 'plain',
  sortable: true,
  namedProps: true,
  extendedImid: 'ExtendedPropertyUri:#Exchange',
  /* Opening a message is a different request with its own answer about what it
     will accept. A tenant that took the list request refused the open one until
     the extras came off it, which is why this is measured separately rather
     than assumed to follow. */
  getBaseShape: 'AllProperties',
  getBodyType: true,
  /* Naming the body is accepted; naming the attachments collection alongside it
     is not, on the tenant this was measured against. The attachments come back
     under AllProperties anyway -- what was refused was asking for them twice. */
  getExtras: 'body'
};

function dialect() {
  return { ...DIALECT };
}

function setDialect(next) {
  DIALECT = { ...DIALECT, ...(next || {}) };
  return dialect();
}

function pageFor(d) {
  return d.paging === 'IndexedPageItemView' ? PAGE_ITEM : PAGE_PLAIN;
}

function folderFor(d) {
  return d.folder === 'target' ? FOLDER_TARGET : FOLDER_PLAIN;
}

function buildFindItem(opts) {
  const o = opts || {};
  const d = o.dialect || DIALECT;
  const shape = { __type: 'ItemResponseShape:#Exchange', BaseShape: o.baseShape || d.baseShape || 'IdOnly' };
  if (o.props && o.props.length) shape.AdditionalProperties = o.props;
  const body = {
    __type: 'FindItemJsonRequest:#Exchange',
    Header: { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: 'V2018_01_18' },
    Body: {
      __type: 'FindItemRequest:#Exchange',
      ItemShape: shape,
      ParentFolderIds: [(o.folder || folderFor(d))(o.folderId || 'inbox')],
      Traversal: 'Shallow',
      Paging: (o.paging || pageFor(d))(o.count || 1)
    }
  };
  if (o.sort) body.Body.SortOrder = o.sort;
  return body;
}

function sortByReceived(d) {
  const path = fieldPath('received', d);
  if (!path) return null;
  return [{ __type: 'SortResults:#Exchange', Order: 'Descending', Path: path }];
}

/** What the server said went wrong, in its own words. */
function faultOf(text) {
  try {
    const j = JSON.parse(String(text || ''));
    const b = j && j.Body ? j.Body : j;
    const msg = pick(b, ['FaultMessage', 'faultMessage', 'MessageText', 'ResponseCode']);
    const name = pick(b, ['ExceptionName', 'exceptionName']);
    return [name, msg].filter(Boolean).join(': ') || '';
  } catch (e) {
    return '';
  }
}

/** Anything with an id, however thin -- an IdOnly answer has nothing else. */
function countIds(node, depth) {
  depth = depth || 0;
  if (!node || depth > 12) return 0;
  if (Array.isArray(node)) return node.reduce((n, x) => n + countIds(x, depth + 1), 0);
  if (typeof node !== 'object') return 0;
  if (idOf(node)) return 1;
  return Object.keys(node).reduce((n, k) => n + countIds(node[k], depth + 1), 0);
}

/**
 * Measure what this server accepts, one piece at a time.
 *
 * Each step adds exactly one thing to the last one that worked, because
 * "invalid argument" names no argument and a whole-request guess tells you
 * nothing about which part was wrong. What comes back is a list a person can
 * read and a dialect the rest of the module can be set to.
 */
async function probeShapes({ apply = true } = {}) {
  const steps = [];
  /* Seeded from what is already known to work, not from the most pessimistic
     guess. A probe that starts at the bottom and fails halfway used to write
     the bottom down as the answer -- so one throttled burst, or a session that
     dropped mid-run, permanently downgraded a tenant that had been measured
     correctly an hour earlier. */
  const before = dialect();
  const found = { ...before };
  let proved = 0;

  async function attempt(label, opts) {
    let rec;
    try {
      const out = await send('FindItem', buildFindItem(opts));
      rec = { label, ok: !out.bad, status: out.facts.status, fault: faultOf(out.facts.text) };
      if (out.bad && NO_ANSWER.test(out.bad.code)) {
        throw Object.assign(new Error(out.bad.message), { code: out.bad.code });
      }
      if (!out.bad) {
        const json = JSON.parse(out.facts.text);
        rec.ids = countIds(json, 0);
        const items = walkItems(json, [], 0);
        rec.usable = items.length;
        if (items.length) {
          proved++;
          rec.sawImid = !!internetMessageIdOf(items[0]);
          rec.sawSubject = pick(items[0], ['Subject', 'subject']) !== undefined;
          rec.sawFrom = pick(items[0], ['From', 'from', 'Sender']) !== undefined;
        }
      }
    } catch (e) {
      /* A measurement that could not be taken is not a measurement of zero. */
      if (e && NO_ANSWER.test(e.code || '')) {
        e.steps = steps;
        throw e;
      }
      rec = { label, ok: false, status: 0, fault: String(e.message || e) };
    }
    steps.push(rec);
    return rec;
  }

  /* 1. The skeleton: paging and how a folder is named. */
  let r = await attempt('骨架：IndexedPageView + DistinguishedFolderId', { paging: PAGE_PLAIN, folder: FOLDER_PLAIN });
  if (!r.ok) {
    found.paging = 'IndexedPageItemView';
    r = await attempt('骨架：改用 IndexedPageItemView', { paging: PAGE_ITEM, folder: FOLDER_PLAIN });
  }
  if (!r.ok) {
    found.paging = 'IndexedPageView'; found.folder = 'target';
    r = await attempt('骨架：改用 TargetFolderId 包一層', { paging: PAGE_PLAIN, folder: FOLDER_TARGET });
  }
  if (!r.ok) return { steps, worked: null, dialect: dialect() };
  const skeleton = { paging: pageFor(found), folder: folderFor(found) };

  /* 2. A shape that returns readable fields without naming any of them. That
        alone can settle the whole property question, so it is asked first. */
  for (const shape of ['AllProperties', 'Default']) {
    r = await attempt('整組欄位：BaseShape ' + shape, { ...skeleton, baseShape: shape });
    if (r.ok && r.usable) { found.baseShape = shape; break; }
  }

  /* 3. Which spelling of a named property this server understands. Subject is
        the probe because every message has one and it is cheap to confirm. */
  let namedWorks = false;
  outer:
  for (const propType of PROP_TYPES) {
    for (const spelling of SPELLINGS) {
      const path = { __type: propType, FieldURI: FIELDS.subject[spelling] };
      r = await attempt('欄位拼法：' + propType.split(':')[0] + ' / ' + FIELDS.subject[spelling],
        { ...skeleton, baseShape: 'IdOnly', props: [path] });
      if (r.ok) {
        found.propType = propType; found.spelling = spelling; namedWorks = true;
        break outer;
      }
    }
  }
  found.namedProps = namedWorks;

  /* 4. The whole set, in the spelling that worked. */
  const d = { ...found };
  const wanted = ['subject', 'received', 'hasAttachments', 'from', 'to', 'cc', 'isRead', 'internetMessageId'];
  let props = [];
  if (namedWorks) {
    props = wanted.map((n) => fieldPath(n, d)).filter(Boolean);
    r = await attempt('整份欄位清單', { ...skeleton, baseShape: 'IdOnly', props });
    if (!r.ok) {
      /* One of them is not understood. Find which by adding them one at a time. */
      props = [];
      for (const name of wanted) {
        const path = fieldPath(name, d);
        const test = props.concat([path]);
        r = await attempt('欄位：' + name + ' (' + path.FieldURI + ')', { ...skeleton, baseShape: 'IdOnly', props: test });
        if (r.ok) props = test;
      }
    }
  }

  /* 5. InternetMessageId as an extended property, which survived a server that
        refused named ones. Tried whichever way round is still missing. */
  const haveImid = props.some((x) => /InternetMessageId/i.test(x.FieldURI || ''));
  for (const ext of [EXT_IMID, EXT_IMID_ALT]) {
    r = await attempt('InternetMessageId 擴充屬性：' + ext.__type.split(':')[0],
      { ...skeleton, baseShape: 'IdOnly', props: props.concat([ext]) });
    if (r.ok) { found.extendedImid = ext.__type; props = props.concat([ext]); break; }
  }
  if (!haveImid && !found.extendedImid) {
    steps.push({ label: 'InternetMessageId 兩種都不行', ok: false, status: 0, fault: '身分只能退回雜湊 ItemId' });
  }

  /* 6. Sorting, last among the list probes, because it is the only part the
        mirror can live without: newest-first is an optimisation, and a folder
        walked in the server's own order still syncs, just less cheaply. */
  const sort = sortByReceived(d);
  if (sort) {
    r = await attempt('依收件時間排序', { ...skeleton, baseShape: found.baseShape, props, sort });
    found.sortable = r.ok;
  }

  /* 7. Opening one message, which is a separate request with a separate
        answer. Needs a real id, so it borrows one from the list probe -- and if
        the list never returned one there is nothing here to measure. */
  const borrowed = await borrowId(skeleton, found);
  if (borrowed) {
    const openStep = await probeOpen(borrowed, found, steps);
    Object.assign(found, openStep);
  } else {
    steps.push({ label: '開信形狀：收件匣沒有可借的信件編號，跳過', ok: false, status: 0, fault: '' });
  }

  /* 8. And getting an attachment's bytes, which is its own request again. */
  const sample0 = await borrowAttachment(skeleton, found);
  if (sample0) {
    const plan = await probeAttachment(sample0, steps);
    found.attachment = plan ? { action: plan.action, shape: ATTACHMENT_SHAPES[plan.shape].name } : null;
  } else {
    steps.push({ label: '附件形狀：這個資料夾裡找不到帶附件的信，跳過', ok: false, status: 0, fault: '' });
  }

  /* Only install a measurement that actually read a message. A combination that
     the server accepts but that returns nothing usable would make every later
     sync store zero rows and report success. */
  const installed = apply && proved > 0;
  if (installed) setDialect(found);
  return { steps, worked: found, applied: installed, proved, dialect: dialect() };
}

/** One real item id from the folder, so the open probe has something to open. */
async function borrowId(skeleton, found) {
  try {
    const out = await send('FindItem', buildFindItem({
      ...skeleton, baseShape: found.baseShape || 'AllProperties', count: 1
    }));
    if (out.bad) return null;
    const items = walkItems(JSON.parse(out.facts.text), [], 0);
    return items.length ? idOf(items[0]) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Which GetItem this server accepts.
 *
 * From the plainest upward, keeping the richest that worked. A message opens
 * with less than we would like far more usefully than it does not open at all,
 * so every step here is allowed to fail without failing the whole measurement.
 */
async function probeOpen(sourceId, found, steps) {
  const out = { getBaseShape: 'IdOnly', getBodyType: false, getExtras: 'none' };

  async function attempt(label, over) {
    let rec;
    try {
      const res = await send('GetItem', getItemBody(sourceId, { ...found, ...over }));
      rec = { label, ok: !res.bad, status: res.facts.status, fault: faultOf(res.facts.text) };
      if (!res.bad) {
        const item = walkItems(JSON.parse(res.facts.text), [], 0)[0];
        rec.gotBody = !!(item && bodyTextOf(item).length);
        rec.gotAttachments = !!(item && attachmentsOf(item).length);
      }
    } catch (e) {
      rec = { label, ok: false, status: 0, fault: String(e.message || e) };
    }
    steps.push(rec);
    return rec;
  }

  let best = null;
  const ladder = [
    ['開信：IdOnly', { getBaseShape: 'IdOnly', getBodyType: false, getExtras: 'none' }],
    ['開信：Default', { getBaseShape: 'Default', getBodyType: false, getExtras: 'none' }],
    ['開信：AllProperties', { getBaseShape: 'AllProperties', getBodyType: false, getExtras: 'none' }],
    ['開信：AllProperties ＋ BodyType Text', { getBaseShape: 'AllProperties', getBodyType: true, getExtras: 'none' }],
    ['開信：＋指名內文欄位', { getBaseShape: 'AllProperties', getBodyType: true, getExtras: 'body' }],
    ['開信：＋指名內文與附件欄位', { getBaseShape: 'AllProperties', getBodyType: true, getExtras: 'all' }]
  ];
  for (const [label, over] of ladder) {
    const r = await attempt(label, over);
    /* Richer is only better if it actually came back with the body. */
    if (r.ok && (r.gotBody || !best)) best = over;
  }
  return best || out;
}

/** One real attachment, so the attachment probe has something to fetch. */
async function borrowAttachment(skeleton, found) {
  try {
    const out = await send('FindItem', buildFindItem({ ...skeleton, baseShape: found.baseShape || 'AllProperties', count: 25 }));
    if (out.bad) return null;
    const items = walkItems(JSON.parse(out.facts.text), [], 0);
    for (const it of items) {
      const has = pick(it, ['HasAttachments', 'hasAttachments']);
      if (!(has === true || has === 'true')) continue;
      const full = await send('GetItem', getItemBody(idOf(it), found));
      if (full.bad) continue;
      const opened = walkItems(JSON.parse(full.facts.text), [], 0)[0];
      const atts = attachmentsOf(opened).filter((a) => a.id && !a.inline);
      if (atts.length) return atts[0];
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * What is actually happening between this machine and the mailbox.
 *
 * Built because one sentence -- 「登入過期了」 -- was being shown for four
 * different problems, and a user who really was signed in had no way to see
 * which one they had. Cookie values, tokens and message content never appear
 * here: names, lengths and the server's own error text tell the four apart.
 */
async function diagnose(opts) {
  const shapes = !opts || opts.shapes !== false;
  const out = { base: base(), configured: configured(), at: Date.now() };
  if (!configured()) { out.verdict = '還沒設定網頁信箱帳號。'; return out; }

  let jar = [];
  try { jar = (await partition().cookies.get({ url: base() })) || []; } catch (e) { /* no jar */ }
  out.cookies = jar.map((c) => ({ name: c.name, domain: c.domain, session: !!c.session }));
  out.tabOpen = !!mailboxTab();

  try {
    const tpl = await ensureTemplate();
    out.learned = {
      from: tpl.origin,
      ageSeconds: Math.round((Date.now() - tpl.at) / 1000),
      headers: Object.keys(tpl.headers),
      /* Length only. The value is a credential and never leaves this module. */
      credentialBytes: (tpl.headers.authorization || '').length
    };
  } catch (e) {
    out.learned = null;
    out.learnError = { code: e.code || 'EFAIL', message: e.message };
  }

  if (out.learned && shapes) {
    /* A report, not a reconfiguration. `apply` is opt-in so pressing 「診斷」
       cannot leave the module measuring differently than it did before. */
    try {
      out.shapes = await probeShapes({ apply: shapes === 'apply' });
    } catch (e) {
      out.shapes = { error: String(e.message || e), code: e.code || '', steps: e.steps || [] };
    }
  }

  out.verdict = verdictOf(out);
  return out;
}

function verdictOf(d) {
  if (!d.learned) {
    if (!d.cookies || !d.cookies.length) {
      return '這個瀏覽器分區裡完全沒有這個網域的 cookie。最可能的原因是你在別的瀏覽器登入的，' +
        'AI-OS 看不到那個登入——請用郵件視窗的「在瀏覽器登入 Outlook」開分頁，在那個分頁裡登入。';
    }
    return '有 cookie，但學不到那個分頁怎麼問伺服器：' +
      ((d.learnError && d.learnError.message) || '不明原因') +
      '。把 Outlook 分頁打開、確認看得到信件，再試一次。';
  }
  if (!d.learned.credentialBytes) {
    return '學到了請求，但裡面沒有憑證，表示那個分頁還沒真的登入完成。';
  }
  if (d.shapes && d.shapes.worked) {
    return '連得上、認得出身分，伺服器接受的請求形狀也量出來了。';
  }
  if (d.shapes) {
    return '憑證沒問題（' + d.learned.credentialBytes + ' 位元組），但連最簡單的查詢都被拒絕——' +
      '下面每一步的錯誤訊息是伺服器自己的說法。';
  }
  return '憑證拿得到。';
}

/**
 * Is this session usable right now?
 *
 * Answered by making the cheapest real call rather than by looking at cookies:
 * a jar full of expired cookies looks exactly like a signed-in one.
 */
async function probe({ open = true } = {}) {
  if (!configured()) return { ok: false, state: 'none', detail: '還沒設定帳號' };
  const cookies = await cookieCount();
  try {
    if (!open) await ensureTemplate({ allowOpen: false });
    const json = await call('FindItem', findItemBody('inbox', 0, 1));
    const items = walkItems(json, [], 0);
    return {
      ok: true,
      state: 'ready',
      cookies,
      detail: items.length ? '已登入，讀得到信件' : '已登入，但收件匣第一頁是空的',
      sawItem: items.length > 0
    };
  } catch (e) {
    if (isLoginError(e) || e.code === 'ENOTAB' || e.code === 'ENOLEARN') {
      return {
        ok: false, state: 'login', cookies,
        detail: e.code === 'ENEEDLOGIN' ? '需要在瀏覽器登入 Outlook' : e.message,
        loginUrl: loginUrl()
      };
    }
    return { ok: false, state: 'error', cookies, code: e.code || '', detail: String(e.message || e) };
  }
}

function loginUrl() {
  return base() + '/mail/';
}

/* -------------------------------------------------------------- syncing ---- */

async function findPage(folderId, offset, count) {
  const json = await call('FindItem', findItemBody(folderId, offset, count));
  return { items: walkItems(json, [], 0), last: lastPage(json) };
}

/**
 * Pull headers for one folder into the mirror.
 *
 * The loop stops on the first item older than the floor, which is what makes an
 * incremental sync cheap; the floor itself is what makes it correct (decisions
 * 4 and 5). Every row goes in through store.put() in exactly the shape the IMAP
 * feeder uses, so nothing downstream needs to know where it came from.
 */
async function syncFolder({ folder = 'INBOX', limit = MAX_PER_SYNC, days = 0, deep = false } = {}) {
  if (!configured()) throw fail('ENOACCOUNT', '還沒設定 Outlook 網頁信箱帳號');
  const name = folderName(folder);
  if (!name) throw fail('EFOLDER', '網頁信箱不支援這個資料夾：' + folder);
  const folderId = distinguished(name);
  if (!store.ready()) await store.init(account.email);

  const cur = store.cursor(name);
  const plan = syncPlan({ cursor: cur, deep, days });
  const cap = Math.max(1, Math.min(MAX_PER_SYNC, (limit | 0) || MAX_PER_SYNC));
  const sorted = !!DIALECT.sortable;

  let seen = 0;
  let stored = 0;
  let newest = 0;
  let short = [];
  const fresh = [];

  /**
   * Walk pages from an offset until the floor, the cap, or the end.
   *
   * Returns where it stopped and whether it got all the way down, because that
   * is the difference between a folder that is finished and one that has a hole
   * in it -- and a hole nobody records is a hole nobody ever fills.
   */
  async function walk(from, floor) {
    let offset = from;
    let reached = false;
    while (seen < cap) {
      const page = await findPage(folderId, offset, Math.min(PAGE, cap - seen));
      if (!page.items.length) { reached = true; break; }
      seen += page.items.length;

      const got = adoptPage(page.items, {
        folder: name,
        floor,
        sorted,
        lookup: (sid) => store.bySource(sid),
        has: (id) => !!store.get(id)
      });
      got.rows.forEach((r) => { store.put(r); stored++; });
      fresh.push(...got.fresh);
      short = short.concat(got.missing);
      if (got.newest > newest) newest = got.newest;

      offset += page.items.length;
      if (got.stop) { reached = true; break; }
      if (page.last === true) { reached = true; break; }
    }
    return { offset, reached };
  }

  /* The head: everything back to the overlap boundary, newest first. */
  const head = await walk(0, plan.floor);

  /* The hole, if the last run left one. A first sync of a busy folder spends
     its whole budget near the top and stops; the cursor then only ever looks
     forward, so those older messages were never fetched by anything -- not by
     the next sync, and not by a full rescan, which also starts at the top. This
     picks the walk up where it stopped. */
  let backfill = null;
  const owed = !deep && cur.owaDone === false && cur.owaOffset > 0;
  if ((owed || (plan.first && !head.reached)) && seen < cap) {
    const from = owed ? cur.owaOffset : head.offset;
    const floor = cur.owaFloor || plan.floor;
    backfill = await walk(from, floor);
  }

  const done = backfill ? backfill.reached : head.reached;
  const stoppedAt = backfill ? backfill.offset : head.offset;

  /* The cursor only ever moves forward. A sync that saw nothing new must not
     drag it back to zero and turn the next one into a first sync. */
  const since = Math.max(newest, cur.owaSince || 0);
  store.setCursor(name, {
    owaSince: since,
    owaFloor: Math.min(plan.floor, cur.owaFloor || plan.floor),
    owaDone: done,
    owaOffset: done ? 0 : stoppedAt
  });
  await store.flush();

  return {
    folder: name,
    /* What the word means on the other feeder: messages that were not here
       before. The overlap re-walks a day of already-mirrored mail on every
       sync, and counting those as 「新增」 told the user they had thirty-seven
       new messages every few minutes. */
    fetched: fresh.length,
    updated: stored - fresh.length,
    scanned: seen,
    fresh,
    first: plan.first,
    deep: !!deep,
    /* Whether this folder is now walked all the way back, or still owes a
       backfill that the next sync will pick up. */
    complete: done,
    reachedFloor: done,
    coverage: store.coverage(name),
    missing: [...new Set(short)]
  };
}

/**
 * One attachment's bytes, measuring how to ask for them if the current way
 * stops working.
 *
 * The measurement happens at most once per run of failures: an attachment that
 * genuinely cannot be fetched should cost one extra round of probes, not one
 * per attachment in the mailbox.
 */
async function fetchAttachment(meta) {
  try {
    const got = await call(ATTACHMENT_PLAN.action, getAttachmentBody(meta));
    const content = attachmentContentOf(got);
    if (content) return content;
  } catch (e) {
    if (isLoginError(e)) throw e;
    if (!/Invalid argument|OwaMethodArgumentException/i.test(String(e.message || e))) throw e;
  }
  if (Date.now() - attachmentLadderFailedAt < ATTACHMENT_RETRY_MS) return null;
  const found = await probeAttachment(meta, null);
  if (!found) { attachmentLadderFailedAt = Date.now(); return null; }
  const got = await call(ATTACHMENT_PLAN.action, getAttachmentBody(meta));
  return attachmentContentOf(got);
}

/**
 * Fetch this message's attachments again, for a message already opened.
 *
 * `syncBody` returns early once a body is stored, which is right -- a body does
 * not change -- but it meant that attachments which failed the first time could
 * never be retried, and the reader offered a file nobody could ever open with
 * 「重新同步一次試試」 as the advice, which did nothing. This is the something.
 */
async function refreshAttachments({ messageId } = {}) {
  if (!configured()) throw fail('ENOACCOUNT', '還沒設定 Outlook 網頁信箱帳號');
  if (!store.ready()) await store.init(account.email);

  const held = store.get(messageId);
  if (!held) throw fail('ENOMSG', '本機沒有這封信，先同步一次');
  if (!held.sourceId) throw fail('ENOSOURCE', '這封信沒有網頁信箱的編號，重新同步一次這個資料夾就會有。');

  const json = await call('GetItem', getItemBody(held.sourceId));
  const item = walkItems(json, [], 0)[0];
  if (!item) throw fail('ESHAPE', 'Outlook 回了東西，但裡面找不到這封信');

  const kept = await collectAttachments(item, messageId);
  await store.flush();
  return { messageId, attachments: kept.length, stored: kept.filter((a) => a.stored).length };
}

/**
 * Every attachment's bytes, then one write.
 *
 * One write because putAttachments rewrites the whole directory: fetching them
 * one at a time and storing as they arrive would erase the siblings each time.
 */
async function collectAttachments(item, messageId) {
  const metas = attachmentsOf(item).filter((a) => a.id);
  const list = [];
  for (const meta of metas.slice(0, store.MAX_ATTACHMENTS)) {
    if (meta.bytes && meta.bytes > store.MAX_ONE_ATTACHMENT) {
      list.push({ ...meta, data: null });
      continue;
    }
    try {
      const content = await fetchAttachment(meta);
      if (!content) { list.push({ ...meta, data: null, reason: 'Outlook 沒有回傳這個附件的內容' }); continue; }
      list.push({ ...meta, data: content });
    } catch (e) {
      if (isLoginError(e)) throw e;
      list.push({ ...meta, data: null, reason: '取不到附件內容：' + String(e.message || e) });
    }
  }
  return store.putAttachments(messageId, list);
}

/**
 * The body and every attachment of one message, in one pass.
 *
 * Attachment bytes are fetched here rather than later on purpose: putAttachments
 * rewrites the whole directory on each call, so a lazy per-attachment fetch
 * would erase its siblings, and the reader would show names for files nobody
 * could ever open.
 */
async function syncBody({ messageId } = {}) {
  if (!configured()) throw fail('ENOACCOUNT', '還沒設定 Outlook 網頁信箱帳號');
  if (!store.ready()) await store.init(account.email);

  const held = store.get(messageId);
  if (!held) throw fail('ENOMSG', '本機沒有這封信，先同步一次');
  /* A message stored before the reader could show formatting has the text and
     no markup, and would otherwise never get any: syncBody returns early on
     hasBody alone. `htmlTried` is the difference between "this message has no
     markup" and "nobody has asked for it yet". */
  if (held.hasBody && held.htmlTried) return { messageId, cached: true };
  if (!held.sourceId) {
    throw fail('ENOSOURCE',
      '這封信是以前用別的方式同步進來的，網頁信箱沒有它的編號，開不了。重新同步一次這個資料夾就會有。');
  }

  const json = await call('GetItem', getItemBody(held.sourceId));
  const item = walkItems(json, [], 0)[0];
  if (!item) throw fail('ESHAPE', 'Outlook 回了東西，但裡面找不到這封信');

  const text = bodyTextOf(item);
  await store.putBody(messageId, text);
  /* Kept beside the text, not instead of it: see mailstore.putHtml. */
  await store.putHtml(messageId, rawHtmlOf(item));

  const kept = await collectAttachments(item, messageId);
  await store.flush();

  return {
    messageId,
    cached: false,
    bytes: text.length,
    attachments: kept.length,
    unstored: kept.filter((a) => !a.stored).length
  };
}

module.exports = {
  /* wiring */
  configure, configured, probe, loginUrl, folders, isLoginError,
  keepAlive, startKeepAlive, stopKeepAlive, refreshSession, KEEPALIVE_MS,
  reusableHeaders, forgetTemplate, release, templateFresh, originOf, mailboxTab, clean, NOT_A_KEY,
  knownOrigin, OUTLOOK_ORIGINS, landedOnLogin, settledUrl, diagnose, probeShapes, faultOf, buildFindItem,
  dialect, setDialect, fieldPath, FIELDS, attachmentPlan, ATTACHMENT_SHAPES,
  /* the mirror feeders */
  syncFolder, syncBody, refreshAttachments,
  /* pure, and tested as such */
  distinguished, folderName, normaliseItem, keyFor, idOf, internetMessageIdOf,
  walkItems, lastPage, attachmentsOf, attachmentContentOf, bodyTextOf, rawHtmlOf, htmlToText,
  syncPlan, adoptPage, NO_ANSWER,
  needsLogin, classify, atLoginHost, findItemBody, getItemBody, getAttachmentBody, deepLink, sanitiseBase,
  pick, extendedValue, oneAddress, manyAddresses, manyParties,
  PARTITION, DEFAULT_BASE, FIRST_DAYS, OVERLAP_MS, PAGE, MAX_PER_SYNC, LIST_PROPERTIES
};
