'use strict';

/* ===========================================================================
   AI-OS // capability gate
   ---------------------------------------------------------------------------
   Authority lives here, in the main process, for one reason: the renderer will
   eventually display web pages and email bodies, which is untrusted content in
   a privileged window. If consent were rendered and adjudicated there, a
   compromised renderer could simply approve itself.

   So the gate owns three things the renderer cannot touch:
     * the policy table (persisted in userData, not in the sandbox)
     * the consent dialog (its own modal window, its own preload)
     * the taint set (which untrusted sources have been read this session)

   The renderer asks for an operation and gets a result or a refusal. It never
   gets to say "the user approved this".
   =========================================================================== */

const { BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

/* --------------------------------------------------------- syscall table */
/* Authoritative. The renderer fetches this to build its prompt, so there is
   one definition of what this machine can do, and it lives on this side. */

const OPS = {
  /* windows and applications */
  'app.open':        { cap: 'ui.surface', sig: '{app:"files"|"editor"|"browser"|"mail"|"docs"|"sheets"|"slides"|"pdf"|"markdown"|"memory"|"forge", arg}', desc: '開啟一個應用程式' },
  /* `request` carries the user's own words. The planner used to compress a
     paragraph of requirements into a name and a one-line purpose, and the
     forge built from that; now the forge plans from what was actually said. */
  'app.create':      { cap: 'app.create', sig: '{name, purpose, request}',
    desc: '使用者要一個系統裡沒有的程式（工具、遊戲、查詢器…）就用這個；request 放完整需求原文，核心會在背景把它建出來' },
  /* The bridge between this table and the applications' own verbs. It grants
     nothing new -- every action already runs when someone clicks the app's own
     buttons, and the dangerous parts of one pass the gate they always did -- so
     it answers to `app.run`, the capability for making an installed program do
     something. The action list is per app; ask with no action to see it. */
  'app.do':          { cap: 'app.run', sig: '{app, action, args:object}',
    desc: '叫某個程式做一件它會做的事（動作名稱因程式而異，action 留空會列出可用的）' },
  /* The machine's own clock. sys.timer, like timer.set: what a job does when
     it fires is gated then, on its own. */
  'schedule.set':    { cap: 'sys.timer', sig: '{name, every, intent, app, action, args:object}',
    desc: '定時重複做一件事。every 是秒數或 "5m"/"2h"/"1d"；給 intent（一句要做的事，每次由核心規劃）' +
          '或 app+action（直接執行某個程式的動作，不花模型）。只在 AI-OS 開著時執行' },
  'schedule.list':   { cap: 'sys.timer', sig: '{}', desc: '列出所有排程與下次執行時間' },
  'schedule.cancel': { cap: 'sys.timer', sig: '{id, name}', desc: '取消一個排程（給 id 或名稱）' },
  'surface.close':   { cap: 'ui.surface', sig: '{title}', desc: '關閉視窗' },
  'surface.arrange': { cap: 'ui.surface', sig: '{layout:"grid"|"focus"|"stack"}', desc: '重排視窗' },

  /* files */
  'fs.list':         { cap: 'fs.read',    sig: '{dir}', desc: '列出沙箱目錄' },
  'fs.read':         { cap: 'fs.read',    sig: '{path}', desc: '讀取沙箱檔案' },
  'fs.find':         { cap: 'fs.read',    sig: '{query, dir}',
    desc: '搜尋沙箱：檔名或內容含 query 的檔案，回傳路徑與命中的那幾行。dir 省略就是整個沙箱' },
  'fs.open':         { cap: 'fs.read',    sig: '{path}', desc: '用適合的程式開啟檔案' },
  'fs.write':        { cap: 'fs.write',   sig: '{path, content}', desc: '寫入沙箱檔案' },
  'fs.copy':         { cap: 'fs.write',   sig: '{from, to}', desc: '複製檔案，不需要先讀內容' },
  'fs.move':         { cap: 'fs.write',   sig: '{from, to}', desc: '搬移或改名' },
  'fs.mkdir':        { cap: 'fs.write',   sig: '{path}', desc: '建立目錄' },
  'fs.delete':       { cap: 'fs.delete',  sig: '{path}', desc: '刪除檔案（移到沙箱回收桶）' },

  /* web */
  'web.read':        { cap: 'net.egress', sig: '{url}', desc: '抓一個網頁的正文進來讀' },
  'web.open':        { cap: 'net.egress', sig: '{url}', desc: '用瀏覽器開啟網址' },

  /* mail */
  'mail.list':       { cap: 'mail.read',  sig: '{folder, limit}', desc: '列出信件' },
  'mail.read':       { cap: 'mail.read',  sig: '{uid}', desc: '讀一封信' },
  'mail.send':       { cap: 'mail.send',  sig: '{to, subject, body}', desc: '寄信' },

  /* memory */
  'memory.remember': { cap: 'mem.write',  sig: '{text, tags}', desc: '記住一件事' },
  'memory.recall':   { cap: 'mem.read',   sig: '{query}', desc: '檢索長期記憶' },
  'memory.forget':   { cap: 'mem.write',  sig: '{query}', desc: '忘掉符合的記憶' },

  /* misc */
  'timer.set':       { cap: 'sys.timer',  sig: '{seconds, label}', desc: '設定計時器' },
  /* The model picks from this list, so it has to name every theme the renderer
     has -- an omitted one is a theme nobody can ask for by name. The palettes
     live in os.css and the list in renderer/shell.js (AIOS.themes); this is the
     third place, and the only one the model reads. */
  'theme.set':       { cap: 'ui.theme',
    sig: '{mode:"midnight"|"void"|"ocean"|"forest"|"nord"|"violet"|"crimson"|' +
         '"copper"|"amber"|"mono"|"daylight"|"mint"|"sakura"|"paper" 或自訂主題的名稱}',
    desc: '換主題。深色：午夜 midnight、深空 void、深海 ocean、深林 forest、' +
          '極地 nord、靛紫 violet、緋紅 crimson、赤銅 copper、琥珀 amber、單色 mono；' +
          '淺色：日光 daylight、薄荷 mint、櫻 sakura、紙張 paper。' +
          '使用者自己存的主題（選單列「主題 → 自訂主題」）用它的名稱指定，例如 mode:"我的藍"' },
  /* One operation, once per row of a dataset. The capability is the one the
     inner op needs, checked per call as usual -- this only decides how many
     times to make the call, and anything elevated is confirmed once for the
     whole batch with the list on screen. */
  'data.each':       { cap: null,
    sig: '{file, rows:object, op, args:object}',
    desc: '對一份資料的每一列各做一次某個 op。file 是沙箱裡的 .csv/.json，' +
          'args 裡用 {{欄位名}} 代入該列的值，{{#}} 是列號。一次最多 500 列' },
  'reply':           { cap: null,         sig: '{text}', desc: '只回話，不做事' }
};

/**
 * Operations that need a capability check but are not part of the model's
 * syscall vocabulary. They are kept out of OPS so they never appear in a prompt
 * and cannot be requested by name in a plan, while still passing through the
 * same gate as everything else.
 */
const INTERNAL_OPS = {
  'app.run': { cap: 'app.run', desc: '執行一個已安裝的程式' },
  'session.write': { cap: null, desc: '保存工作階段' },
  /* What a browser extension does to the page it was given. Internal rather
     than a syscall: the arguments are node indices from a snapshot the
     extension was just handed, which is not something an intent planner can
     meaningfully produce -- but it still has to answer to a capability, because
     it changes what is on the screen. */
  'page.apply': { cap: 'ui.surface', desc: '把擴充功能提出的文字修改套用到目前的網頁' },
  'page.pdf': { cap: 'fs.write', desc: '把目前的網頁存成 PDF 檔' },
  /* Fetching the pictures of a page being exported. Internal for the same
     reason as page.pdf -- it takes a tab id, not an address, and an intent
     planner has no use for it -- but it answers to net.egress rather than
     fs.write, because unlike everything else in an export it opens a socket. */
  'page.images': { cap: 'net.egress', desc: '抓取目前網頁的圖片，夾進要轉存的檔案' },
  /* A generated program's own request (os.net.fetch). Internal because the
     planner has web.read for pages; this is an API call a program makes with
     its own arguments. Same capability, so the policy and the taint downgrade
     that govern the planner's requests govern the program's. */
  'web.fetch': { cap: 'net.egress', desc: '讓生成的程式連上一個網址' },
  /* Sending a document to the extraction model the user configured. Internal
     because there is no address in the arguments -- the destination is the one
     in that program's own settings, and a planner has nothing to say about it.
     Its own capability rather than net.egress, so that "may this machine send my
     documents to a cloud model" is a switch on its own and not a side effect of
     letting the browser fetch a page. */
  'extract.send': { cap: 'doc.extract', desc: '把文件送到你設定的萃取模型' }
};

/* Capabilities that can destroy data, move it off this machine, or introduce
   new code. While any untrusted source has been read this session these lose
   their standing grant, because the plan that requested them may have been
   written by that content rather than by the user. */
const ELEVATED = ['fs.write', 'fs.delete', 'net.egress', 'mail.send', 'app.create', 'proc.spawn'];

/* The policy a machine starts with.

   Everything is granted. The reasoning is that the file operations are confined
   to the sandbox and reversible there -- a delete is a move to the sandbox's own
   trash -- so a machine that asks before every write teaches people to click
   through prompts without reading them, which costs more than it buys.

   Four of these are not sandbox-confined, and are granted here as a deliberate
   choice rather than because they are harmless: `net.egress` fetches from the
   internet, `mail.send` puts mail in front of a real recipient and cannot be
   recalled, `doc.extract` sends a whole document to the extraction model that
   program was configured with, and `proc.spawn` would start an operating-system
   process (no syscall uses it today). They are named in every capability's
   tooltip so the decision stays visible, and any of them can be set back to ASK
   or DENY with one click.

   `doc.extract` is deliberately not in ELEVATED, unlike the other three. The
   taint downgrade exists to catch an elevated action reaching a target the user
   never named, and there is no target to reach here: the destination is the one
   address in that program's settings, the operation is invisible to the planner
   (INTERNAL_OPS), and the documents sent are the ones a person picked in a
   window. Degrading it would mean a consent dialog between every invoice in a
   batch of fifty, which is the habit an injected instruction is counting on.

   Two things still stand in front of them whatever this says: ELEVATED below
   drops the dangerous ones back to ASK for the rest of the session once
   untrusted content has been read, and installing a generated program that wants
   a capability reaching outside its own sandbox still opens a dialog. */
const DEFAULT_POLICY = {
  'ui.surface': 'allow',
  'ui.theme':   'allow',
  'fs.read':    'allow',
  'fs.write':   'allow',
  'fs.delete':  'allow',
  'mem.read':   'allow',
  'mem.write':  'allow',
  'sys.timer':  'allow',
  'app.run':    'allow',
  'app.create': 'allow',
  'net.egress': 'allow',
  'mail.read':  'allow',
  'mail.send':  'allow',
  'proc.spawn': 'allow',
  'doc.extract': 'allow'
};

/* What each capability actually permits, in the words someone deciding needs.
   Shown on hover in the capability panel.

   Kept next to the policy rather than in the panel that renders it, for the same
   reason the generated-app capabilities keep their notes next to their list: a
   capability added without a description would appear in the gate as a bare
   identifier, and a switch nobody understands is a switch nobody touches.

   Each one says what it lets the kernel do and what it costs to be wrong, since
   the point of granting everything by default is that the user decides -- and
   deciding requires knowing. */
const CAP_NOTES = {
  'ui.surface': '開啟、關閉、重新排列視窗。只動畫面，不碰資料。',
  'ui.theme':   '切換配色主題。只動外觀。',
  'fs.read':    '列出與讀取沙箱裡的檔案。讀不到沙箱以外的東西。',
  'fs.write':   '在沙箱裡寫入、複製、搬移檔案與建立目錄。' +
                '寫得到的範圍僅限沙箱，作業系統上的檔案不受影響。',
  'fs.delete':  '刪除沙箱檔案 — 實際上是移進沙箱自己的回收桶，動作日誌可以復原。',
  'net.egress': '抓取網頁內容、用瀏覽器開啟網址。' +
                '⚠ 這會離開這台機器：網址與請求會送到外部網站。',
  'mail.read':  '列出與讀取你信箱裡的信件。信件內容會被當成不可信來源，' +
                '讀過之後危險能力會自動降級成 ASK。',
  'mail.send':  '用你設定的帳號寄出郵件。' +
                '⚠ 真的會寄到收件人手上，而且收不回來。',
  'mem.read':   '檢索長期記憶，把相關的條目放進這一輪的 context。' +
                '記憶只留在這台機器上。',
  'mem.write':  '寫入或刪除長期記憶裡的條目。' +
                '記住的事會在往後每一輪都可能被取用，忘掉之後不會自己回來。',
  'sys.timer':  '設定計時器。時間到只會在畫面上通知，不會做別的事。',
  'app.run':    '執行已經安裝的生成程式。程式跑在受限的 iframe 裡。',
  'app.create': '讓核心寫一段新程式並安裝起來。' +
                '⚠ 這是在這台機器上引入新的程式碼；' +
                '會先過靜態檢查與冒煙測試，要求沙箱外能力時仍會另外詢問。',
  'proc.spawn': '啟動作業系統層級的行程。' +
                '目前沒有任何 syscall 用到它 — 保留欄位，改成 ALLOW 也不會有任何效果。',
  'doc.extract': '把整份文件送到「文件萃取」程式裡設定的萃取模型，換回表格資料。' +
                '⚠ 這會離開這台機器：文件原檔會上傳到你設定的那個服務或雲端模型。' +
                '只影響那一支程式，設成 DENY 之後它就不再送出任何文件，其他功能不受影響。'
};

/* ------------------------------------------------------------------ state */

let policy = { ...DEFAULT_POLICY };
let policyPath = null;
let ownerWindow = null;

/* Called with true when a consent dialog is about to appear and false when it
   is gone. Native browser views paint above the renderer, so they have to be
   detached first: a web page floating over the authorisation prompt would let
   the page dress up the question the user is answering. */
let onModal = () => {};
function setModalHook(fn) {
  if (typeof fn === 'function') onModal = fn;
}

/* Sources of untrusted content read during this session. Sticky on purpose:
   once hostile text is in the conversation it can influence every later turn,
   and the renderer cannot be trusted to tell us when it is gone. Cleared only
   by an explicit user action. */
const taint = new Map();   // source -> { at, vpath }

function init(userDataDir, win) {
  policyPath = path.join(userDataDir, 'policy.json');
  ownerWindow = win;
  return load();
}

function setOwnerWindow(win) {
  ownerWindow = win;
}

async function load() {
  try {
    const saved = JSON.parse(await fs.readFile(policyPath, 'utf8'));
    for (const cap of Object.keys(DEFAULT_POLICY)) {
      if (['allow', 'ask', 'deny'].includes(saved[cap])) policy[cap] = saved[cap];
    }
  } catch { /* first run */ }
  return policy;
}

async function save() {
  try {
    await fs.mkdir(path.dirname(policyPath), { recursive: true });
    await fs.writeFile(policyPath, JSON.stringify(policy, null, 2), 'utf8');
  } catch { /* non-fatal */ }
}

async function setPolicy(cap, value) {
  if (!(cap in DEFAULT_POLICY)) throw new Error('未知的能力：' + cap);
  if (!['allow', 'ask', 'deny'].includes(value)) throw new Error('不合法的政策值');
  policy[cap] = value;
  await save();
  return policy;
}

function getPolicy() {
  return { ...policy };
}

/* ------------------------------------------------------------------ taint */

/* Told when the taint set changes, so the shell can say so without being asked.

   The renderer used to learn only by calling `taint:state`, which meant the HUD
   could sit clean while this process had already downgraded the elevated
   capabilities. Enforcement was never in doubt -- it happens here -- but the
   badge that tells someone why their next write will ask for permission was
   behind, and a security indicator that lags is one people stop believing. */
let onTaintChange = () => {};
function setTaintHook(fn) {
  onTaintChange = typeof fn === 'function' ? fn : () => {};
}

function addTaint(source, vpath) {
  const before = taint.size;
  taint.set(String(source), { at: Date.now(), vpath: vpath || source });
  const state = taintState();
  if (taint.size !== before) onTaintChange(state);
  return state;
}

function clearTaint() {
  const had = taint.size > 0;
  taint.clear();
  const state = taintState();
  if (had) onTaintChange(state);
  return state;
}

function taintState() {
  return {
    tainted: taint.size > 0,
    sources: [...taint.entries()].map(([source, meta]) => ({ source, ...meta }))
  };
}

/* ------------------------------------------------------- what was asked for */

/* The user's own words for this turn.
   Set by the shell when a turn starts and cleared when it ends. This is not the
   renderer approving anything -- it may not, and does not -- it is the renderer
   reporting what was typed into the intent bar, which is the one thing in the
   whole pipeline that certainly came from the person at the keyboard. */
let intent = '';

function setIntent(text) {
  intent = String(text || '').slice(0, 4000);
  return intent;
}

/* Which argument names the thing an operation reaches for, and whether naming
   the directory is enough.

   Deliberately a short explicit table and not "any string in args": a mail body
   is a string too, and a rule that let the body match would let injected text
   approve its own delivery. The office writers all go through
   `guarded('fs.write', …)`, so `path` covers them without naming each one.

   `dir` is the difference between putting something somewhere and taking
   something away. 「存到 /notes」 names a place to write, and a file written into
   it is what was asked for; it does not name /notes/重要.txt as something to
   delete. So removal needs the exact path, said out loud. */
const TARGET_ARG = {
  'fs.write':   { key: 'path', dir: true },
  'fs.mkdir':   { key: 'path', dir: true },
  'fs.copy':    { key: 'to',   dir: true },
  'fs.move':    { key: 'to',   dir: false },   // it takes `from` away as well
  'fs.delete':  { key: 'path', dir: false },
  'web.read':   { key: 'url',  dir: false },
  'web.open':   { key: 'url',  dir: false },
  'mail.send':  { key: 'to',   dir: false },
  'app.create': { key: 'name', dir: false }
};

/**
 * Did the user name this target themselves?
 *
 * The taint downgrade exists because content read mid-task can carry
 * instructions -- a PDF that says "also write this to X" or "send this to Y".
 * What it must catch is an action reaching somewhere the user never mentioned.
 * What it was catching instead was every elevated action at all, including the
 * one the user had spelled out in the same sentence:
 *
 *   「把 /inbox/…pdf 讀進來，寫一份簡介，存成 /notes/故事簡介.md」
 *
 * -- read the PDF, then ask permission to write the exact path just given. That
 * is friction with no security in it, and worse than none: a machine that asks
 * before everything teaches people to approve without reading, which is the
 * habit the injected instruction is counting on.
 *
 * So: if the target appears in what the user typed, the instruction is theirs
 * and it proceeds. If it does not, the downgrade stands and they get asked --
 * which is exactly the case an injected instruction produces.
 */
function namedByUser(op, args) {
  const spec = TARGET_ARG[op];
  if (!spec || !intent) return null;
  const raw = args && args[spec.key];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const target = raw.trim();

  const said = intent.toLowerCase();
  const want = target.toLowerCase();
  if (said.includes(want)) return target;

  if (spec.key === 'url') {
    /* A host, not a path: naming a site is naming the site. Anything the user
       did not name -- including a link that arrived inside the document -- still
       has to be asked about. */
    try {
      const host = new URL(target).hostname.toLowerCase().replace(/^www\./, '');
      return host && said.includes(host) ? host : null;
    } catch { return null; }
  }

  if (spec.dir) {
    /* A named directory is a named place to put things. 「存到 /notes」 is how
       people actually say this, and refusing it would leave the friction exactly
       where it was. Matched on whole segments, so /notes is not satisfied by
       /notes-of-someone-else. */
    const parts = target.split('/').filter(Boolean);
    for (let i = parts.length - 1; i > 0; i--) {
      const dir = ('/' + parts.slice(0, i).join('/')).toLowerCase();
      if (new RegExp(escapeForSearch(dir) + '(?![\\w\\u4e00-\\u9fff-])').test(said)) {
        return dir;
      }
    }
  }
  return null;
}

function escapeForSearch(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* --------------------------------------------------------------- decision */

function decide(op, args) {
  const spec = OPS[op] || INTERNAL_OPS[op];
  if (!spec) return { decision: 'deny', cap: null, reason: '未知的系統呼叫，不在 syscall 表內' };
  if (!spec.cap) return { decision: 'allow', cap: null, reason: '不需要授權' };

  const level = policy[spec.cap] || 'ask';
  if (level === 'deny') {
    return { decision: 'deny', cap: spec.cap, reason: `政策把 ${spec.cap} 設為 DENY` };
  }

  /* A grant this process issued after showing the whole batch. Consumed one use
     at a time, so a hundred approved writes cannot become a hundred and one.

     This exists because two gates were stacking. `data.each` reading a CSV out
     of /inbox arms the taint downgrade, which turns the elevated capabilities to
     ASK -- and then every one of the hundred writes asked separately. That is
     the hundred dialogs the batch confirmation was built to prevent, arriving
     through a different door. The answer is not to weaken the downgrade but to
     let one informed answer cover the operations it was actually shown. */
  const grant = takeGrant(op, args);
  if (grant) {
    return { decision: 'allow', cap: spec.cap, batch: true,
      reason: `批次授權：${op}，剩餘 ${grant.left} 次` };
  }

  if (ELEVATED.includes(spec.cap) && taint.size > 0) {
    /* Unless the user named this target themselves, in which case the
       instruction is theirs and not the document's. See namedByUser. */
    const mine = namedByUser(op, args);
    if (mine) {
      return {
        decision: level, cap: spec.cap, named: mine,
        reason: `使用者自己指名了 ${mine}，不是讀進來的內容要求的，維持 ${spec.cap} = ${level.toUpperCase()}`
      };
    }
    const sources = [...taint.values()].map((t) => t.vpath).join('、');
    return {
      decision: 'ask',
      cap: spec.cap,
      taint: true,
      reason: `這個工作階段讀過不可信內容（${sources}），而${TARGET_ARG[op] ? '這次要動的目標不在你的指令裡' : `${spec.cap} 的既有授權`}被降級`
    };
  }

  return { decision: level, cap: spec.cap, reason: `政策：${spec.cap} = ${level.toUpperCase()}` };
}

/**
 * Ask once about a whole batch, then issue grants for what survived.
 *
 * The list is shown by this process, in the window this process owns. The shell
 * could render a nicer one -- and did, first -- but a decision the renderer
 * collects is a decision the gate has no reason to believe: the rule here is
 * that the renderer may ask and may display, never approve.
 */
async function askBatch({ op, items, what }) {
  const spec = OPS[op] || INTERNAL_OPS[op];
  if (!spec) return { ok: false, reason: '不認得的 op：' + op };

  const list = (Array.isArray(items) ? items : []).slice(0, 500);
  if (!list.length) return { ok: false, reason: '沒有要執行的項目' };

  const verdict = { cap: spec.cap, reason: `一次要做 ${list.length} 次 ${op}`, taint: taint.size > 0 };
  const answer = await askUser({
    op,
    what: what || spec.desc,
    args: {},
    batch: {
      count: list.length,
      /* Two strings per row: what it touches, and what it will carry. Enough to
         recognise a wrong one without turning the window into a data browser. */
      rows: list.map((args, i) => ({
        index: i,
        main: String(args.path || args.to || args.url || args.name || ''),
        extra: String(args.subject || args.title || '').slice(0, 90)
      })),
      sample: JSON.stringify(list[0], null, 2).slice(0, 1200)
    }
  }, verdict);

  if (answer === 'busy') return { ok: false, reason: '已經有另一個授權視窗在等回答' };
  if (!answer) return { ok: false, reason: '使用者取消了整批' };

  const keep = Array.isArray(lastKeep) ? lastKeep : null;
  const chosen = keep ? list.filter((_, i) => keep.indexOf(i) >= 0) : list;
  lastKeep = null;
  if (!chosen.length) return { ok: false, reason: '所有項目都被取消勾選' };

  grantBatch(op, chosen);
  return { ok: true, indices: keep || list.map((_, i) => i), count: chosen.length };
}

/* `pending` is cleared before `askUser` resolves, so the ticked rows are parked
   here on the way past rather than read off it afterwards. */
let lastKeep = null;

/* ----------------------------------------------------------- batch grants

   A batch is one question about many operations. The user is shown every one of
   them and answers once; this is what carries that answer to the gate.

   Bounded three ways on purpose. By **identity**: only the exact operations that
   were on screen, matched on the arguments that name what they touch -- an
   approval for a hundred paths cannot authorise a hundred and first. By
   **count**: each entry is spent when used. By **time**: a grant that outlived
   the plan it belonged to would be a standing permission nobody remembers
   giving. */

const GRANT_TTL_MS = 5 * 60 * 1000;
let grants = [];

/** What identifies one operation to a person: what it touches, not its shape. */
function grantKey(op, args) {
  const a = args || {};
  const who = a.path || a.to || a.url || a.from || a.dir || a.slug || a.name || '';
  /* A separator that cannot appear in an op name, which is what makes the
       two halves unambiguous. It was a NUL until a source-wide check found it:
       the key is in-memory only and worked perfectly, but a control character
       in a source file makes every tool call it binary and hides it from a
       diff. See the same note on cacheKey in translate.js. */
    /* A separator that cannot appear in an op name, which is what makes the two
     halves unambiguous. It was a NUL until a source-wide check found it: the
     key never leaves this process and worked perfectly, but a control
     character in a source file makes every tool call it binary and hides it
     from a diff. Same note as cacheKey in translate.js. */
  return op + '|' + String(who);
}

function grantBatch(op, argsList, ttlMs) {
  const until = Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : GRANT_TTL_MS);
  const added = argsList.map((args) => ({ key: grantKey(op, args), until, used: false }));
  grants = grants.filter((g) => g.until > Date.now() && !g.used).concat(added);
  log('batch grant: %s x%d for %ds', op, added.length, Math.round((until - Date.now()) / 1000));
  return { op, count: added.length, until };
}

function takeGrant(op, args) {
  const now = Date.now();
  grants = grants.filter((g) => g.until > now && !g.used);
  const key = grantKey(op, args);
  const hit = grants.find((g) => g.key === key);
  if (!hit) return null;
  hit.used = true;
  return { left: grants.filter((g) => !g.used && g.key.startsWith(op + '|')).length };
}

/** Drop everything outstanding. Used when a batch is abandoned part way. */
function clearGrants() {
  const n = grants.length;
  grants = [];
  return { cleared: n };
}

/* --------------------------------------------------------------- consent */

let consentWin = null;
let pending = null;
let askSeq = 0;

/* Consent is the one part of the gate that is hard to observe after the fact:
   the window is gone and all that survives is a boolean. So every transition
   is logged, which is how the "refused without being asked" race was found. */
function log(...args) {
  console.log('[gate] ' + args[0], ...args.slice(1));
}

/**
 * Modal consent window owned by this process. Created fresh each time and
 * destroyed after, so a stale window can never be reused to smuggle approval.
 */
function askUser(action, verdict) {
  return new Promise((resolve) => {
    // A window that has already been destroyed is not a pending question. Left
    // uncleared it wedges the gate permanently: every later request would be
    // told to wait for a dialog nobody can see or answer.
    if (consentWin && consentWin.isDestroyed()) {
      settleFor(consentWin, false, 'window destroyed before it was answered');
      consentWin = null;
    }

    // Never stack consent dialogs: two questions on screen at once is how a
    // user ends up approving the wrong one. But report that distinctly instead
    // of as a refusal, or the journal would claim the human rejected something
    // they were never shown.
    if (consentWin) {
      log('%s arrived while #%d was still on screen, reporting busy',
        action.op, pending ? pending.seq : -1);
      resolve('busy');
      return;
    }

    // Nothing should be pending at this point, but overwriting one would leave
    // its caller awaiting a promise that can never settle. Refuse it loudly
    // instead of hanging.
    if (pending && !pending.settled) {
      log('WARNING: replacing an unsettled request #%d (%s)', pending.seq, pending.action.op);
      pending.settled = true;
      const orphan = pending.resolve;
      pending = null;
      orphan(false);
    }

    // `win` is filled in below, before any event can fire, and is what ties
    // this question to the one window entitled to answer it.
    pending = { resolve, action, verdict, settled: false, win: null, seq: ++askSeq };
    log('#%d asking for %s (%s)', pending.seq, action.op, verdict.reason);
    try { onModal(true); } catch { /* never block the prompt on a hook */ }

    // Every handler below closes over `win`, never over the module-level
    // `consentWin`. The two can legitimately diverge: answering the dialog
    // clears the module reference immediately so the gate is not left wedged,
    // and 'ready-to-show' can still arrive afterwards. Reading the module
    // variable from inside a handler is how that became a null dereference.
    const win = new BrowserWindow({
      parent: ownerWindow || undefined,
      modal: true,
      width: 540,
      height: 460,
      frame: false,
      transparent: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      backgroundColor: '#0a0e17',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'consent.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    consentWin = win;
    pending.win = win;

    win.setMenu?.(null);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'consent.html'));

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    });

    // Closing the window by any other means counts as a refusal -- but only of
    // the question this window was asking. 'closed' can arrive well after the
    // dialog was answered, by which time a *later* request may be on screen
    // waiting for the user. Settling the module-level `pending` here refused
    // that newer request without anyone touching it, which is what made
    // App Forge report "使用者拒絕授權" while its dialog was still visible.
    win.on('closed', () => {
      if (consentWin === win) consentWin = null;
      try { onModal(false); } catch { /* ignore */ }
      settleFor(win, false, '視窗被關閉');
    });
  });
}

/**
 * Resolve the pending question if, and only if, it belongs to `win`.
 * Everything that ends a consent dialog goes through here so ownership is
 * checked in one place instead of at each call site.
 */
function settleFor(win, granted, why) {
  if (!pending || pending.settled || pending.win !== win) {
    if (pending && pending.win !== win) {
      log('ignored a "%s" from a stale consent window (pending #%d for %s)',
        why, pending.seq, pending.action.op);
    }
    return false;
  }
  pending.settled = true;
  const r = pending.resolve;
  log('#%d %s -> %s (%s)', pending.seq, pending.action.op, granted ? 'granted' : 'refused', why);
  pending = null;
  r(granted);
  return true;
}

function registerConsentChannels() {
  ipcMain.handle('consent:payload', (event) => {
    // A window only ever gets its own question. Without this a dialog that was
    // slow to load could render, and then approve, a later request.
    if (!pending || !pending.win || pending.win.isDestroyed()) return null;
    if (event.sender !== pending.win.webContents) return null;
    return {
      op: pending.action.op,
      args: pending.action.args || {},
      why: pending.action.why || '',
      /* What the caller says it is doing, falling back to the capability's own
         description. The fallback is why an uninstall used to announce itself as
         "寫一個新的程式": `op` here is a capability, and app.create collides with a
         syscall of the same name whose description is about creating. A dialog
         that misnames the action cannot produce informed consent, so the caller's
         own words win. */
      desc: pending.action.what || (OPS[pending.action.op] || {}).desc || '',
      cap: pending.verdict.cap,
      reason: pending.verdict.reason,
      taint: !!pending.verdict.taint,
      /* Present only for a batch: the whole list, so one answer can be an
         informed one. The window renders it with a checkbox per row. */
      batch: pending.action.batch || null
    };
  });

  /* A batch answer carries which rows survived the user's ticking. Kept on
     `pending` rather than sent back through the resolve value so the existing
     boolean contract of `settleFor` is untouched. */
  ipcMain.on('consent:keep', (event, keep) => {
    if (!pending || pending.settled) return;
    const w = pending.win;
    if (!w || w.isDestroyed() || event.sender !== w.webContents) return;
    if (Array.isArray(keep)) lastKeep = keep;
  });

  ipcMain.on('consent:respond', (event, granted) => {
    if (!pending || pending.settled) return;

    // Only the window that asked may answer. Compared by webContents identity
    // because that window has no origin worth checking, and against `pending`
    // rather than `consentWin` so a stale window cannot answer for a newer one.
    const w = pending.win;
    if (!w || w.isDestroyed() || event.sender !== w.webContents) {
      log('rejected a consent response from an unexpected sender');
      return;
    }

    settleFor(w, !!granted, '使用者作答');

    // Released here as well as in the 'closed' handler: waiting only on the
    // event leaves the gate wedged if it never arrives.
    if (consentWin === w) consentWin = null;
    w.close();
  });
}

/**
 * Single entry point for every privileged operation. Returns a verdict the
 * caller must obey; 'ask' has already been resolved with the human by the time
 * this settles.
 */
async function authorize(op, args, meta = {}) {
  const verdict = decide(op, args);
  if (verdict.decision === 'allow') return { ok: true, verdict };
  if (verdict.decision === 'deny') return { ok: false, verdict };

  const answer = await askUser({ op, args, why: meta.why, what: meta.what }, verdict);
  if (answer === 'busy') {
    return {
      ok: false,
      verdict: { ...verdict, decision: 'busy', reason: '已經有一個授權請求在等你回答，這個先不處理' }
    };
  }
  return {
    ok: answer === true,
    verdict: answer === true
      ? { ...verdict, decision: 'granted' }
      : { ...verdict, decision: 'refused', reason: '使用者拒絕授權' }
  };
}

module.exports = {
  OPS,
  INTERNAL_OPS,
  ELEVATED,
  DEFAULT_POLICY,
  CAP_NOTES,
  init,
  setOwnerWindow,
  setModalHook,
  getPolicy,
  setPolicy,
  decide,
  authorize,
  registerConsentChannels,
  addTaint,
  setTaintHook,
  setIntent,
  namedByUser,
  TARGET_ARG,
  askBatch,
  grantBatch,
  clearGrants,
  clearTaint,
  taintState
};
