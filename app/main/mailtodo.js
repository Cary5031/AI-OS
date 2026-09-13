'use strict';
/**
 * What the mailbox turned into work, and whether it is done yet.
 *
 * This is the store behind 郵件待辦. It holds two things and nothing else:
 *
 *   rules   what to look for. A rule is a sentence the user wrote -- `say` --
 *           plus the mechanical conditions that sentence was read into: a
 *           sender or domain, a window of days, words that matter, whether a
 *           message counts as being about you
 *   items   what one run of a rule found, one per message, with whether it has
 *           been ticked off
 *
 * The sentence is the definition; the conditions are how it gets carried out.
 * Two views of one thing is the shape this machine has got wrong before, so the
 * rule carries `sayFor` -- the fingerprint of the sentence the conditions were
 * read from. When it stops matching `say`, the rule is provably out of date
 * rather than arguably out of date, and the screen can say so. The store does
 * not compute that fingerprint and does not read the sentence: reading a
 * sentence is logic, and it lives in renderer/mailask.js where it can be
 * tested.
 *
 * Three decisions, each avoiding something that goes wrong:
 *
 * 1. It stores; it does not search and it does not summarise. Searching belongs
 *    to the mirror and summarising needs the model, and both of those already
 *    live somewhere with an owner. A store that reached for them would be a
 *    second place where "what does this mailbox contain" is decided, and that
 *    shape -- two states pointing at one thing -- is the one this machine has
 *    got wrong five times.
 *
 * 2. An item is keyed by (rule, message). Running a rule twice must not produce
 *    the same piece of work twice, and a message that was ticked off on Monday
 *    must not come back on Tuesday because the rule still matches it. That is
 *    the mirror's tombstone lesson, applied here: what the user did to an item
 *    outlives any number of re-runs.
 *
 *    A re-run does update what the machine thinks -- the summary, the line
 *    saying why this message is here -- because that is the whole repair for a
 *    rule whose sentence was wrong: fix the sentence, run it again, watch the
 *    rows change. What it must never touch is a decision a person made, or one
 *    it already made once: `done` and `aside` are written and then left alone.
 *    Re-deciding placement every night would move rows under the user while
 *    they were not looking, and a list that rearranges itself is a list nobody
 *    trusts.
 *
 * 3. It keeps the ten-character handle, not just the Message-ID. The handle is
 *    what a link is written with (see mailstore.shortOf), and an item whose link
 *    cannot be written is an item you cannot open.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/* A rule's own history is worth keeping, but not forever: a mailbox produces
   work faster than anybody ticks it off, and a list nobody can reach the bottom
   of is a list nobody reads. Done items older than this are dropped on load. */
const KEEP_DONE_DAYS = 30;
const MAX_ITEMS_PER_RULE = 400;
const MAX_RULES = 30;
/* A sentence, not an essay. Long enough for the ones people actually write --
   "這禮拜 abc.com 寄來的信，內容提到我的標起來，摘要寫金額跟期限" is 44 -- and
   short enough that it cannot become a second prompt smuggled into the rule. */
const MAX_SAY = 400;
/* How many bodies one run may read. The same ceiling the bridge enforces
   (ipc.js, mail:search), repeated here as a bound on stored data rather than as
   a second opinion about what a search costs: a rule that stored `bodies: 40`
   would be a rule whose screen promised forty readings and got twelve. */
const MAX_BODIES = 12;

let file = null;
let doc = null;   // { rules: [], items: [] }
let dirty = false;

function blank() {
  return { rules: [], items: [] };
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

async function init(userDataDir) {
  file = path.join(userDataDir, 'mail-todo.json');
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    doc = {
      rules: Array.isArray(raw.rules) ? raw.rules.map(cleanRule).filter(Boolean) : [],
      items: Array.isArray(raw.items) ? raw.items.map(cleanItem).filter(Boolean) : []
    };
  } catch (e) {
    doc = blank();
  }
  prune();
  dirty = false;
  return state();
}

function ready() {
  return !!doc;
}

function require_() {
  if (!doc) throw Object.assign(new Error('郵件待辦還沒初始化'), { code: 'ENOINIT' });
  return doc;
}

/* ------------------------------------------------------------- shapes ---- */

/** A string somebody else may have written, bounded and without control characters. */
function text(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 200);
}

function cleanRule(r) {
  if (!r || !r.id) return null;
  return {
    id: String(r.id),
    name: text(r.name, 60) || '未命名規則',

    /* What the user actually said. This is the rule; everything under it is how
       the rule gets carried out. Long enough for a real sentence with an aside
       in it, because that is how people describe what they want. */
    say: text(r.say, MAX_SAY),
    /* The fingerprint of the `say` the fields below were read from, and who did
       the reading. Computed in the renderer -- see the file header. */
    sayFor: text(r.sayFor, 24),
    planBy: r.planBy === 'model' || r.planBy === 'hand' ? r.planBy : 'rules',
    /* Conditions the reader wanted to set but could not find in the sentence.
       Kept so the screen can show what it refused to invent. */
    dropped: Array.isArray(r.dropped) ? r.dropped.map((x) => text(x, 60)).filter(Boolean).slice(0, 8) : [],

    from: text(r.from, 120),
    text: text(r.text, 120),
    folder: text(r.folder, 40) || '',
    /* Days back, not a date: a rule is a standing question and a fixed date
       stops being the answer to it tomorrow. */
    days: Math.max(1, Math.min(365, Number(r.days) || 7)),
    unread: !!r.unread,
    hasAttachment: !!r.hasAttachment,
    mentions: Array.isArray(r.mentions) ? r.mentions.map((x) => text(x, 40)).filter(Boolean).slice(0, 6) : [],
    limit: Math.max(1, Math.min(50, Number(r.limit) || 12)),
    /* How many of those get their body read, separate from how many get listed.
       The bridge fetches at most MAX_BODIES per search, so a rule asking for 50
       gets 12 bodies and 38 envelopes -- two different numbers that used to be
       one, which is how rows 13 and up came to be summarised from nothing. */
    bodies: Math.max(0, Math.min(MAX_BODIES, r.bodies == null ? Math.min(MAX_BODIES, Math.max(1, Math.min(50, Number(r.limit) || 12))) : Number(r.bodies) || 0)),

    summarise: r.summarise !== false,
    /* What the summary of each message has to say, in the user's own words.
       An instruction to the writer, never a search key. */
    focus: text(r.focus, 200),
    /* The criterion for "does this one actually count", for the sentences no
       keyword can express. Only consulted when `sift` is on. */
    sieve: text(r.sieve, 200),
    sift: !!r.sift,
    /* What time of day the sentence asked to be run at, if it asked. The rule
       does not schedule itself -- schedule.js owns that -- this only remembers
       what to offer. */
    dailyAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.dailyAt || '')) ? String(r.dailyAt) : '',

    enabled: r.enabled !== false,
    createdAt: Number(r.createdAt) || Date.now(),
    lastRun: Number(r.lastRun) || 0,
    lastFound: Number(r.lastFound) || 0,
    lastNote: text(r.lastNote, 300)
  };
}

function cleanItem(i) {
  if (!i || !i.ruleId || !i.messageId) return null;
  return {
    id: String(i.id || newId()),
    ruleId: String(i.ruleId),
    messageId: String(i.messageId),
    handle: text(i.handle, 40),
    subject: text(i.subject, 200) || '(無主旨)',
    from: text(i.from, 200),
    date: Number(i.date) || 0,
    summary: text(i.summary, 600),
    /* One line: why this message is on the list, or why it was set aside.
       Without it a semantic rule is unarguable -- the list either contains what
       you expected or it does not, and there is nothing to look at. */
    why: text(i.why, 300),
    /* Set aside, not deleted. The sieve is allowed to move a row into a drawer
       the user can open; it is never allowed to drop one on the floor. */
    aside: !!i.aside,
    /* Judged on the envelope alone, because this one's body was past the run's
       reading budget. Marked so a row nobody actually read cannot look like a
       row somebody did. */
    thin: !!i.thin,
    mentions: !!i.mentions,
    hasAttachments: !!i.hasAttachments,
    done: !!i.done,
    doneAt: Number(i.doneAt) || 0,
    addedAt: Number(i.addedAt) || Date.now()
  };
}

/* -------------------------------------------------------------- rules ---- */

function state() {
  const d = require_();
  return { rules: d.rules.slice(), items: d.items.slice() };
}

function addRule(patch) {
  const d = require_();
  if (d.rules.length >= MAX_RULES) {
    throw Object.assign(new Error('規則太多了（上限 ' + MAX_RULES + ' 條）'), { code: 'EFULL' });
  }
  const rule = cleanRule({ ...patch, id: newId(), createdAt: Date.now() });
  /* Something has to narrow the mailbox. A window of days does not: every
     message arrived on some day, so days-only is the whole mailbox with extra
     steps -- and on a semantic rule it would mean handing the model whatever
     happened to be newest. A criterion counts, because the user wrote one and
     the run still only reads MAX_BODIES of them; what is refused is a rule that
     says nothing at all. */
  if (!rule.from && !rule.text && !rule.unread && !rule.hasAttachment && !rule.sieve) {
    throw Object.assign(
      new Error('這條規則沒有任何條件，它會對上整個信箱。至少要說出寄件人、關鍵字，' +
        '或是一個判斷的標準（例如「只留在催我回覆的」）'),
      { code: 'EEMPTY' });
  }
  d.rules.push(rule);
  dirty = true;
  return rule;
}

function updateRule(id, patch) {
  const d = require_();
  const at = d.rules.findIndex((r) => r.id === id);
  if (at < 0) throw Object.assign(new Error('沒有這條規則'), { code: 'ENORULE' });
  d.rules[at] = cleanRule({ ...d.rules[at], ...patch, id: id });
  dirty = true;
  return d.rules[at];
}

function removeRule(id) {
  const d = require_();
  const before = d.rules.length;
  d.rules = d.rules.filter((r) => r.id !== id);
  d.items = d.items.filter((i) => i.ruleId !== id);
  dirty = d.rules.length !== before;
  return { removed: before - d.rules.length };
}

function rule(id) {
  const d = require_();
  return d.rules.find((r) => r.id === id) || null;
}

/* -------------------------------------------------------------- items ---- */

/**
 * Add what a run found, without disturbing what anybody decided.
 *
 * A message this rule has seen before keeps its item -- and with it whether it
 * was ticked off. Re-running a rule is meant to be free; if it resurrected
 * finished work, nobody would run it twice.
 *
 * What a re-run does change is what the machine says: the summary and the line
 * explaining why this message is here. That is the entire repair loop for a
 * rule whose sentence came out wrong -- edit the sentence, run it again, read
 * the rows. Leaving those frozen would mean the only way to see a corrected
 * sentence take effect was to delete the rule and lose the ticks with it.
 *
 * What it never changes is a placement: `done`, because a person set it, and
 * `aside`, because the machine set it once already and a list that quietly
 * rearranges itself overnight is a list nobody can rely on. A row whose verdict
 * turned out wrong is moved by the user, in one click, and it stays moved.
 */
function putItems(ruleId, list) {
  const d = require_();
  if (!rule(ruleId)) throw Object.assign(new Error('沒有這條規則'), { code: 'ENORULE' });

  const mine = new Map();
  for (const i of d.items) if (i.ruleId === ruleId) mine.set(i.messageId, i);

  const fresh = [];
  let touched = 0;
  for (const raw of (Array.isArray(list) ? list : [])) {
    const item = cleanItem({ ...raw, ruleId, id: newId(), addedAt: Date.now() });
    if (!item) continue;

    const was = mine.get(item.messageId);
    if (was) {
      /* A message that was read once stays read. Whether this run got to its
         body depends on where it happened to land in the batch, so a busy week
         can push a message past the reading budget -- and without this, the
         second run would overwrite a real summary with an empty one and relabel
         the row 「只看主旨」, quietly destroying the only account of a message
         that nothing will read again. What a re-run may do is replace what it
         actually has: better information wins, absence never does. */
      const next = cleanItem({
        ...was,
        subject: item.subject, from: item.from, date: item.date,
        summary: item.summary || was.summary,
        why: item.why || was.why,
        thin: was.thin ? item.thin : false,
        mentions: item.mentions, hasAttachments: item.hasAttachments,
        handle: item.handle || was.handle,
        /* The two the run does not get a second opinion about. */
        done: was.done, doneAt: was.doneAt, aside: was.aside
      });
      const at = d.items.findIndex((x) => x.id === was.id);
      if (at >= 0 && JSON.stringify(d.items[at]) !== JSON.stringify(next)) {
        d.items[at] = next;
        touched++;
      }
      continue;
    }

    mine.set(item.messageId, item);
    d.items.push(item);
    fresh.push(item);
  }
  trimRule(ruleId);
  dirty = true;
  return { added: fresh, fresh: fresh.length, touched: touched };
}

function patchItem(id, patch) {
  const d = require_();
  const at = d.items.findIndex((i) => i.id === id);
  if (at < 0) throw Object.assign(new Error('沒有這個項目'), { code: 'ENOITEM' });
  const was = d.items[at];
  const next = cleanItem({ ...was, ...patch, id: id, ruleId: was.ruleId, messageId: was.messageId });
  if (patch && patch.done !== undefined) next.doneAt = patch.done ? Date.now() : 0;
  d.items[at] = next;
  dirty = true;
  return next;
}

function removeItem(id) {
  const d = require_();
  const before = d.items.length;
  d.items = d.items.filter((i) => i.id !== id);
  dirty = d.items.length !== before;
  return { removed: before - d.items.length };
}

function clearDone(ruleId) {
  const d = require_();
  const before = d.items.length;
  d.items = d.items.filter((i) => !(i.done && (!ruleId || i.ruleId === ruleId)));
  dirty = d.items.length !== before;
  return { removed: before - d.items.length };
}

function itemsFor(ruleId) {
  const d = require_();
  return d.items
    .filter((i) => !ruleId || i.ruleId === ruleId)
    .sort((a, b) => {
      const rank = (i) => (i.done ? 2 : i.aside ? 1 : 0);
      return rank(a) === rank(b) ? (b.date || 0) - (a.date || 0) : rank(a) - rank(b);
    });
}

function counts() {
  const d = require_();
  const out = {};
  for (const i of d.items) {
    const c = out[i.ruleId] || (out[i.ruleId] = { open: 0, done: 0, mentions: 0, aside: 0 });
    /* A row in the drawer is not work waiting to be done, so it is not part of
       the number on the rule. It is counted anyway, because "6 項，另外 5 項先放
       一邊" is the sentence that tells somebody their criterion is too strict. */
    if (i.aside && !i.done) { c.aside++; continue; }
    if (i.done) c.done++; else c.open++;
    if (i.mentions && !i.done) c.mentions++;
  }
  return out;
}

function trimRule(ruleId) {
  const d = require_();
  const mine = d.items.filter((i) => i.ruleId === ruleId);
  if (mine.length <= MAX_ITEMS_PER_RULE) return 0;
  /* Finished work goes first, oldest first: an open item is the point of the
     list, and dropping one would lose work nobody has done yet. */
  const order = mine.slice().sort((a, b) =>
    (a.done === b.done ? (a.addedAt || 0) - (b.addedAt || 0) : (a.done ? -1 : 1)));
  const drop = new Set(order.slice(0, mine.length - MAX_ITEMS_PER_RULE).map((i) => i.id));
  d.items = d.items.filter((i) => !drop.has(i.id));
  return drop.size;
}

function prune() {
  const d = require_();
  const floor = Date.now() - KEEP_DONE_DAYS * 86400000;
  const before = d.items.length;
  const rules = new Set(d.rules.map((r) => r.id));
  d.items = d.items.filter((i) =>
    rules.has(i.ruleId) && !(i.done && i.doneAt && i.doneAt < floor));
  if (d.items.length !== before) dirty = true;
  return before - d.items.length;
}

/* --------------------------------------------------------------- disk ---- */

async function flush() {
  if (!doc || !dirty || !file) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(doc), 'utf8');
  dirty = false;
  return true;
}

async function purge() {
  doc = blank();
  dirty = true;
  await flush();
  return true;
}

module.exports = {
  init, ready, flush, purge, state,
  addRule, updateRule, removeRule, rule,
  putItems, patchItem, removeItem, clearDone, itemsFor, counts, prune,
  KEEP_DONE_DAYS, MAX_ITEMS_PER_RULE, MAX_RULES, MAX_SAY, MAX_BODIES
};
