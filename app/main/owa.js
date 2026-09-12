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

const PAGE = 50;                       // items per FindItem request
const MAX_PER_SYNC = 600;              // ceiling for one sync, deep or not
const FIRST_DAYS = 30;                 // how far back the first sync reaches
const OVERLAP_MS = 24 * 3600 * 1000;   // decision 4
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
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

let template = null;   // { origin, headers, at } -- memory only
let seq = 1;

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
function keyFor(internetMessageId, sourceId) {
  const real = String(internetMessageId || '').trim();
  if (real) return real;
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
    from: from.text,
    fromName: from.name,
    to: manyAddresses(pick(raw, ['ToRecipients', 'toRecipients'])),
    cc: manyAddresses(pick(raw, ['CcRecipients', 'ccRecipients'])),
    subject: subject ? String(subject) : '(無主旨)',
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
      name: String(pick(a, ['Name', 'name', 'FileName']) || '未命名附件'),
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
function adoptPage(items, { folder = 'INBOX', floor = 0, lookup, has } = {}) {
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
    if (row.date && row.date < floor) { stop = true; continue; }

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
  /* Text rather than HTML: the body is a stranger's writing on its way into a
     privileged window, and text has no script and no remote image in it. */
  if (d.getBodyType) shape.BodyType = 'Text';

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
  if (/X-OWA-Error["\s:]+[^"]*(Auth|Canary|Expired)/i.test(body)) return true;
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
  account = conf && conf.email
    ? { email: String(conf.email), base: sanitiseBase(conf.base) }
    : null;
  sampling = new Set();
  return account;
}

function sanitiseBase(v) {
  const raw = String(v || '').trim() || DEFAULT_BASE;
  let u;
  try { u = new URL(raw); } catch { return DEFAULT_BASE; }
  if (u.protocol !== 'https:' && !/^127\.0\.0\.1|^localhost/.test(u.hostname)) return DEFAULT_BASE;
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

/** A tab already showing this mailbox, or null. */
function mailboxTab() {
  let list = [];
  try { list = browser.list() || []; } catch { return null; }
  const origin = base();
  const hit = list.find((t) => t && typeof t.url === 'string' && t.url.indexOf(origin) === 0);
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
async function learnTemplate() {
  const origin = base();
  let tab = mailboxTab();
  let ours = null;

  if (!tab) {
    try {
      tab = browser.create({ url: loginUrl() });
      ours = tab.id;
    } catch (e) {
      throw fail('ENOTAB', '沒有開著的 Outlook 分頁，也開不了新的：' + String(e.message || e));
    }
  }

  try {
    let seen = await browser.learnRequest(tab.id, {
      match: /\/owa\/service\.svc/i,
      timeout: ours ? LEARN_FRESH_MS : LEARN_EXISTING_MS
    });
    /* An open tab that happened to be idle. One reload makes it talk. */
    if (!seen && !ours) {
      try { browser.reload(tab.id); } catch { /* the tab went away */ }
      seen = await browser.learnRequest(tab.id, { match: /\/owa\/service\.svc/i, timeout: LEARN_FRESH_MS });
    }
    if (!seen) {
      throw fail('ENOLEARN',
        'Outlook 分頁沒有送出任何請求，學不到怎麼問。請在瀏覽器裡打開信箱，確認看得到信件，再試一次。');
    }

    const headers = reusableHeaders(seen.headers);
    if (!headers.authorization) {
      throw fail('ENEEDLOGIN',
        'Outlook 分頁送出的請求沒有帶憑證，表示那個分頁還沒真的登入。請在分頁裡完成登入（含 2FA）再試一次。');
    }
    template = { origin, headers, at: Date.now() };
    return template;
  } finally {
    if (ours) { try { browser.destroy(ours); } catch { /* already gone */ } }
  }
}

function templateFresh() {
  return !!(template && template.origin === base() && (Date.now() - template.at) < TEMPLATE_MAX_AGE_MS);
}

async function ensureTemplate() {
  if (templateFresh()) return template;
  template = null;
  return learnTemplate();
}

/** Thrown away when the server says the credential is no longer good. */
function forgetTemplate() {
  template = null;
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
  const found = {
    propType: 'PropertyUri:#Exchange',
    spelling: 'concat',
    baseShape: 'IdOnly',
    paging: 'IndexedPageView',
    folder: 'plain',
    sortable: false,
    namedProps: false,
    extendedImid: ''
  };

  async function attempt(label, opts) {
    let rec;
    try {
      const out = await send('FindItem', buildFindItem(opts));
      rec = { label, ok: !out.bad, status: out.facts.status, fault: faultOf(out.facts.text) };
      if (!out.bad) {
        const json = JSON.parse(out.facts.text);
        rec.ids = countIds(json, 0);
        const items = walkItems(json, [], 0);
        rec.usable = items.length;
        if (items.length) {
          rec.sawImid = !!internetMessageIdOf(items[0]);
          rec.sawSubject = pick(items[0], ['Subject', 'subject']) !== undefined;
          rec.sawFrom = pick(items[0], ['From', 'from', 'Sender']) !== undefined;
        }
      }
    } catch (e) {
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
  if (!r.ok) return { steps, worked: null, dialect: null };
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

  if (apply) setDialect(found);
  return { steps, worked: found, dialect: dialect() };
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
    try { out.shapes = await probeShapes(); } catch (e) { out.shapes = { error: String(e.message || e) }; }
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
async function probe() {
  if (!configured()) return { ok: false, state: 'none', detail: '還沒設定帳號' };
  const cookies = await cookieCount();
  try {
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
    if (isLoginError(e)) {
      return { ok: false, state: 'login', cookies, detail: '需要在瀏覽器登入 Outlook', loginUrl: loginUrl() };
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

  let offset = 0;
  let seen = 0;
  let stored = 0;
  let newest = 0;
  let short = [];
  const fresh = [];
  let reachedFloor = false;

  while (seen < cap && !reachedFloor) {
    const page = await findPage(folderId, offset, Math.min(PAGE, cap - seen));
    if (!page.items.length) break;
    seen += page.items.length;

    const got = adoptPage(page.items, {
      folder: name,
      floor: plan.floor,
      lookup: (sid) => store.bySource(sid),
      has: (id) => !!store.get(id)
    });
    got.rows.forEach((r) => { store.put(r); stored++; });
    fresh.push(...got.fresh);
    short = short.concat(got.missing);
    if (got.newest > newest) newest = got.newest;
    if (got.stop) reachedFloor = true;

    offset += page.items.length;
    if (page.last === true) break;
  }

  /* The cursor only ever moves forward. A sync that saw nothing new must not
     drag it back to zero and turn the next one into a first sync. */
  const since = Math.max(newest, cur.owaSince || 0);
  store.setCursor(name, { owaSince: since, owaFloor: Math.min(plan.floor, cur.owaFloor || plan.floor) });
  await store.flush();

  return {
    folder: name,
    fetched: stored,
    scanned: seen,
    fresh,
    first: plan.first,
    deep: !!deep,
    reachedFloor,
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
  const found = await probeAttachment(meta, null);
  if (!found) return null;
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
  if (held.hasBody) return { messageId, cached: true };
  if (!held.sourceId) {
    throw fail('ENOSOURCE',
      '這封信是以前用別的方式同步進來的，網頁信箱沒有它的編號，開不了。重新同步一次這個資料夾就會有。');
  }

  const json = await call('GetItem', getItemBody(held.sourceId));
  const item = walkItems(json, [], 0)[0];
  if (!item) throw fail('ESHAPE', 'Outlook 回了東西，但裡面找不到這封信');

  const text = bodyTextOf(item);
  await store.putBody(messageId, text);

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
  reusableHeaders, forgetTemplate, templateFresh, diagnose, probeShapes, faultOf, buildFindItem,
  dialect, setDialect, fieldPath, FIELDS, attachmentPlan, ATTACHMENT_SHAPES,
  /* the mirror feeders */
  syncFolder, syncBody, refreshAttachments,
  /* pure, and tested as such */
  distinguished, folderName, normaliseItem, keyFor, idOf, internetMessageIdOf,
  walkItems, lastPage, attachmentsOf, attachmentContentOf, bodyTextOf, htmlToText,
  syncPlan, adoptPage,
  needsLogin, classify, atLoginHost, findItemBody, getItemBody, getAttachmentBody, deepLink, sanitiseBase,
  pick, extendedValue, oneAddress, manyAddresses,
  PARTITION, DEFAULT_BASE, FIRST_DAYS, OVERLAP_MS, PAGE, MAX_PER_SYNC, LIST_PROPERTIES
};
