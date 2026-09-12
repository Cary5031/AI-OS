'use strict';
/**
 * The second mail source: an Outlook Web session the user has already signed
 * into (Office 365).
 *
 * IMAP is not an option on a current O365 tenant -- basic authentication is
 * switched off and OAuth needs an application registration only IT can make.
 * What the user does have is a browser, an AD password and a phone, which is
 * enough to sign in to the web mailbox. This module reads that signed-in
 * session and feeds the same mirror IMAP feeds. Six decisions, each avoiding a
 * specific way this goes wrong:
 *
 * 1. AI-OS never touches the sign-in. No form filling, no password, no second
 *    factor, no reading of the login page. The user signs in inside an ordinary
 *    browser tab; the only thing this module ever holds is a cookie jar it
 *    cannot read a password out of. The jar is `persist:aios-web`, the same
 *    partition every other tab uses, so the session survives a restart exactly
 *    as a browser session does and expires when the tenant says it does.
 *
 * 2. Read-only by construction, not by policy. There is no send, delete, move
 *    or mark-read call anywhere in this file. A message whose text tells the
 *    model to delete the audit mail cannot be obeyed on this path, because the
 *    verb does not exist here. Deleting in the application writes a tombstone
 *    in the mirror; the real mailbox is never touched.
 *
 * 3. Identity is decided once, at header sync, and never revised. The list
 *    request explicitly asks for InternetMessageId -- twice, by name and as
 *    extended property 0x1035, because the two spellings have different odds of
 *    surviving a server version -- so the real Message-ID is normally there the
 *    first time a message is seen, and the row is keyed on it exactly as an
 *    IMAP row is. Only when the server returns none does the key become a hash,
 *    and then the hash covers ItemId.Id ONLY: an EWS ItemId is {Id, ChangeKey}
 *    and the ChangeKey changes every time anything on the server touches the
 *    message, so hashing the pair would mint a new identity on every sync and
 *    the messages the user deleted would come back every morning. Opening a
 *    message (GetItem) can never re-key it: the key comes out of the mirror.
 *    And before a key is minted at all, the mirror is asked whether it already
 *    has a row for this ItemId, so a response carrying more fields than last
 *    time cannot create a second row for one message.
 *
 * 4. The cursor overlaps rather than abuts. A strict "newer than last time"
 *    boundary loses every message that shares its second with the last one on
 *    the page, which is routine for distribution lists and notifications. Each
 *    incremental sync re-walks the last OVERLAP_MS; put() is idempotent, so
 *    re-seeing a message costs nothing and missing one costs the morning's
 *    answer. What an overlap still cannot see is a message moved into the
 *    folder with an old received time -- a rule filing it, a restore from
 *    Deleted Items. `deep: true` re-walks the whole window for that, and the
 *    application offers it as a full rescan rather than pretending it is
 *    unnecessary.
 *
 * 5. The first sync is sized by date, not by count. "The newest 200" leaves a
 *    busy mailbox permanently partial with nothing able to say so, and a cursor
 *    that only looks forward can never backfill. The mirror records how far
 *    back it actually reaches per folder, and the application says so, so an
 *    answer computed from a partial mirror is visibly partial.
 *
 * 6. The shapes below are the honest weak point. This was written without an
 *    O365 tenant to observe, so every read goes through a defensive normaliser
 *    with several candidate key names, the item walk finds messages wherever
 *    they sit in the response rather than at one fixed path, and the first
 *    successful call of each action writes a redacted sample of the request and
 *    response under the mirror's own directory -- cookies and canary stripped,
 *    removed by the mirror's purge along with everything else -- so the shapes
 *    can be compared against the real server once and corrected here.
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { session } = require('electron');
const store = require('./mailstore');

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
    const inline = pick(a, ['IsInline', 'isInline']);
    out.push({
      id,
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
  return {
    __type: 'FindItemJsonRequest:#Exchange',
    Header: { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: 'Exchange2013' },
    Body: {
      __type: 'FindItemRequest:#Exchange',
      ItemShape: {
        __type: 'ItemResponseShape:#Exchange',
        BaseShape: 'IdOnly',
        AdditionalProperties: LIST_PROPERTIES
      },
      ParentFolderIds: [{ __type: 'DistinguishedFolderId:#Exchange', Id: folderId }],
      Traversal: 'Shallow',
      Paging: {
        __type: 'IndexedPageView:#Exchange',
        BasePoint: 'Beginning',
        Offset: Math.max(0, offset | 0),
        MaxEntriesReturned: Math.max(1, Math.min(PAGE, count | 0))
      },
      SortOrder: [{
        __type: 'SortResults:#Exchange',
        Order: 'Descending',
        Path: { __type: 'PropertyUri:#Exchange', FieldURI: 'ItemDateTimeReceived' }
      }]
    }
  };
}

function getItemBody(sourceId) {
  return {
    __type: 'GetItemJsonRequest:#Exchange',
    Header: { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: 'Exchange2013' },
    Body: {
      __type: 'GetItemRequest:#Exchange',
      ItemShape: {
        __type: 'ItemResponseShape:#Exchange',
        BaseShape: 'IdOnly',
        BodyType: 'Text',
        AdditionalProperties: LIST_PROPERTIES.concat([
          { __type: 'PropertyUri:#Exchange', FieldURI: 'ItemBody' },
          { __type: 'PropertyUri:#Exchange', FieldURI: 'ItemAttachments' },
          { __type: 'PropertyUri:#Exchange', FieldURI: 'ItemInReplyTo' },
          { __type: 'PropertyUri:#Exchange', FieldURI: 'ItemReferences' }
        ])
      },
      ItemIds: [{ __type: 'ItemId:#Exchange', Id: String(sourceId) }]
    }
  };
}

function getAttachmentBody(attachmentId) {
  return {
    __type: 'GetAttachmentJsonRequest:#Exchange',
    Header: { __type: 'JsonRequestHeaders:#Exchange', RequestServerVersion: 'Exchange2013' },
    Body: {
      __type: 'GetAttachmentRequest:#Exchange',
      AttachmentShape: { __type: 'AttachmentResponseShape:#Exchange' },
      AttachmentIds: [{ __type: 'RequestAttachmentId:#Exchange', Id: String(attachmentId) }]
    }
  };
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

/**
 * Did this response mean "sign in again"?
 *
 * Told apart from a real fault on purpose: one is the user's Tuesday morning,
 * the other is a bug, and a scheduled run that reports the wrong one sends the
 * user looking in the wrong place.
 */
function needsLogin({ url, status, contentType, text } = {}) {
  if (/login\.(microsoftonline|live|windows|windows-ppe)\.(com|net)/i.test(String(url || ''))) return true;
  if (status === 401 || status === 440 || status === 403) return true;
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const body = String(text || '').slice(0, 2000);
  if (/urlOwaFallback|OwaPageError|X-OWA-Error["\s:]+[^"]*(Auth|Canary)/i.test(body)) return true;
  return false;
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

/**
 * One EWS-over-JSON call, from the tab session the user signed in with.
 *
 * Nothing here knows a password. The request carries the partition's cookies
 * because `credentials: 'include'` makes the session attach them, exactly as it
 * does for the tab that is showing the mailbox.
 */
async function call(action, body) {
  if (!configured()) throw fail('ENOACCOUNT', '還沒設定 Outlook 網頁信箱帳號');
  const ses = partition();
  const canary = await canaryOf(ses);
  const url = base() + '/owa/service.svc?action=' + encodeURIComponent(action);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Accept: 'application/json',
    Action: action,
    'X-Requested-With': 'XMLHttpRequest',
    'X-OWA-ActionName': action
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
  if (needsLogin({ url: res.url, status: res.status, contentType: ct, text })) {
    throw fail('ENEEDLOGIN', '需要在瀏覽器重新登入 Outlook');
  }
  if (!res.ok) throw fail('EREMOTE', 'Outlook 網頁信箱回了 ' + res.status);

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw fail('ESHAPE', '回應不是 JSON，Outlook 的介面可能改版了');
  }
  await sample(action, body, json);
  return json;
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

  const metas = attachmentsOf(item).filter((a) => a.id);
  const list = [];
  for (const meta of metas.slice(0, store.MAX_ATTACHMENTS)) {
    if (meta.bytes && meta.bytes > store.MAX_ONE_ATTACHMENT) {
      list.push({ ...meta, data: null });
      continue;
    }
    try {
      const got = await call('GetAttachment', getAttachmentBody(meta.id));
      const content = attachmentContentOf(got);
      if (!content) { list.push({ ...meta, data: null, reason: 'Outlook 沒有回傳這個附件的內容' }); continue; }
      list.push({ ...meta, data: content });
    } catch (e) {
      if (isLoginError(e)) throw e;
      list.push({ ...meta, data: null, reason: '取不到附件內容：' + String(e.message || e) });
    }
  }
  const kept = await store.putAttachments(messageId, list);
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
  /* the mirror feeders */
  syncFolder, syncBody,
  /* pure, and tested as such */
  distinguished, folderName, normaliseItem, keyFor, idOf, internetMessageIdOf,
  walkItems, lastPage, attachmentsOf, attachmentContentOf, bodyTextOf, htmlToText,
  syncPlan, adoptPage,
  needsLogin, findItemBody, getItemBody, getAttachmentBody, deepLink, sanitiseBase,
  pick, extendedValue, oneAddress, manyAddresses,
  PARTITION, DEFAULT_BASE, FIRST_DAYS, OVERLAP_MS, PAGE, MAX_PER_SYNC, LIST_PROPERTIES
};
