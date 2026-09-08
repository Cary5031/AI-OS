'use strict';

/* ===========================================================================
   AI-OS // bookmarks
   ---------------------------------------------------------------------------
   Kept in userData rather than in the sandbox, and that is deliberate: a
   bookmark list is a record of where someone goes, which is closer to a
   credential than to a document. The sandbox is browsable by the model with
   `fs.read`, which is granted by default -- the same reasoning that puts the
   mail mirror in a reserved directory.

   One flat list with a folder name per entry rather than a tree. A tree needs
   move/reparent/cycle handling to do three things a folder name already does,
   and every one of those is a way to lose a bookmark.
   =========================================================================== */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX = 2000;
const MAX_TITLE = 200;

let file = null;
let items = [];

function idOf(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
}

/* http and https only. A bookmark is something the browser will be asked to
   open, so `javascript:` and `file:` are refused here rather than at the point
   where somebody clicks one. */
function cleanUrl(u) {
  const s = String(u || '').trim();
  let parsed;
  try {
    parsed = new URL(s);
  } catch (e) {
    throw new Error('不是合法的網址：' + s.slice(0, 80));
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只能加入 http/https 的網址');
  }
  return parsed.toString();
}

async function init(userDataDir) {
  file = path.join(userDataDir, 'bookmarks.json');
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    items = Array.isArray(raw.items) ? raw.items.filter((b) => b && b.url).slice(0, MAX) : [];
  } catch (e) {
    items = [];
  }
  return { count: items.length };
}

async function flush() {
  if (!file) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, items }, null, 2), 'utf8');
  return true;
}

function list({ folder = null, search = '' } = {}) {
  const q = String(search || '').toLowerCase();
  return items
    .filter((b) => (!folder || b.folder === folder))
    .filter((b) => !q || (b.title + ' ' + b.url).toLowerCase().includes(q))
    .sort((a, b) => (a.folder || '').localeCompare(b.folder || '') || (b.addedAt || 0) - (a.addedAt || 0));
}

function folders() {
  return [...new Set(items.map((b) => b.folder).filter(Boolean))].sort();
}

/** Add, or update the title/folder of one that is already there. */
async function add({ url, title, folder } = {}) {
  const clean = cleanUrl(url);
  const id = idOf(clean);
  const at = items.findIndex((b) => b.id === id);
  const entry = {
    id,
    url: clean,
    title: String(title || clean).slice(0, MAX_TITLE),
    folder: folder ? String(folder).slice(0, 60) : '',
    addedAt: at >= 0 ? items[at].addedAt : Date.now()
  };
  if (at >= 0) items[at] = entry;
  else {
    if (items.length >= MAX) throw new Error('書籤數量已達上限 ' + MAX);
    items.unshift(entry);
  }
  await flush();
  return { entry, updated: at >= 0 };
}

async function remove(id) {
  const at = items.findIndex((b) => b.id === String(id));
  if (at < 0) return { removed: false };
  const [gone] = items.splice(at, 1);
  await flush();
  return { removed: true, entry: gone };
}

async function rename(id, { title, folder } = {}) {
  const b = items.find((x) => x.id === String(id));
  if (!b) throw new Error('沒有這個書籤');
  if (title !== undefined) b.title = String(title).slice(0, MAX_TITLE);
  if (folder !== undefined) b.folder = String(folder || '').slice(0, 60);
  await flush();
  return b;
}

function has(url) {
  try {
    return items.some((b) => b.id === idOf(cleanUrl(url)));
  } catch (e) {
    return false;
  }
}

/* Netscape bookmark format: what every browser imports and exports, so a list
   made here is not trapped here. */
function toHtml() {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const byFolder = {};
  for (const b of list()) (byFolder[b.folder || ''] = byFolder[b.folder || ''] || []).push(b);

  /* The charset line is not decoration. This format predates HTML5 and carries
     no encoding of its own, so a browser importing the file guesses from the
     locale -- CP950 on a Traditional Chinese Windows -- and every CJK title
     arrives as mojibake. Every browser writes this line in its own export for
     exactly that reason; ours did not, and the file read correctly only because
     nothing had imported it anywhere else yet. */
  const out = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>AI-OS 書籤</TITLE>',
    '<H1>AI-OS 書籤</H1>', '<DL><p>'];
  for (const [folder, rows] of Object.entries(byFolder)) {
    if (folder) out.push(`  <DT><H3>${esc(folder)}</H3>`, '  <DL><p>');
    for (const b of rows) {
      out.push(`    <DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor(b.addedAt / 1000)}">${esc(b.title)}</A>`);
    }
    if (folder) out.push('  </DL><p>');
  }
  out.push('</DL><p>');
  return out.join('\n');
}

/**
 * Import that format back.
 *
 * Deliberately forgiving about the markup and strict about the URLs: these
 * files are written by half a dozen browsers and none of them agree, but a bad
 * URL in one row should skip that row rather than fail the import.
 */
async function fromHtml(html) {
  const text = String(html || '');
  let folder = '';
  let added = 0;
  let skipped = 0;

  /* Match the whole tag, then read its attributes: an optional HREF group
     inside a lazy attribute run never captures anything, because the lazy part
     matches zero characters and the optional group is happy to match nothing
     too. That parsed every file as zero bookmarks. */
  for (const m of text.matchAll(/<(h3|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    const title = m[3].replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

    if (tag === 'h3') { folder = title.slice(0, 60); continue; }

    const href = (m[2].match(/href\s*=\s*"([^"]*)"/i) ||
                  m[2].match(/href\s*=\s*'([^']*)'/i) || [])[1];
    if (!href) { skipped++; continue; }
    try {
      await add({ url: href.replace(/&amp;/g, '&'), title: title || href, folder });
      added++;
    } catch (e) {
      // One unusable row skips that row; these files come from half a dozen
      // browsers and none of them agree.
      skipped++;
    }
  }
  return { added, skipped, total: items.length };
}

module.exports = { init, list, folders, add, remove, rename, has, toHtml, fromHtml, flush };
