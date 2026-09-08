'use strict';

/* ===========================================================================
   The prose, checked against the code it describes
   ---------------------------------------------------------------------------
   Every other suite here asks whether the machine works. This one asks whether
   what is written about it is still true, because that rots differently: code
   that stops working fails a test, and a sentence that stops being true just
   sits there being read.

   It has already happened more than once. The README described the generated
   apps' frame as `sandbox="allow-scripts"` for as long as it took someone to
   add `allow-forms` and not notice the prose -- and `allow-forms` was added to
   fix a real bug, so the document was describing the broken state. Comments in
   three files still said the frame was inlined into `srcdoc` after it had moved
   to `aios-app://`, which it did precisely because srcdoc inherits the shell's
   CSP and killed the app's own bootstrap. HANDOVER pointed at `smoke_verify.mjs`
   for months after that file was folded into `e2e/specs/forge.mjs`.

   Only mechanical claims are checked: counts that can be counted, paths that can
   be looked up, strings that appear in both places. A sentence's judgement is
   not testable and is not tested. What is testable is whether it names something
   that exists.
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const gate = require('../app/main/gate');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const README = read('README.md');
const HANDOVER = read('HANDOVER.md');
const TODO = read('TODO.md');

/* The checks that are not about the README's own numbers run over every
   document here. A new document that nothing checks is exactly how the last
   round of rot started -- TODO.md names files and headings like the others do,
   so it decays like the others do. */
const DOCS = [['README.md', README], ['HANDOVER.md', HANDOVER], ['TODO.md', TODO]];

/* --------------------------------------------------------------- counts */

test('the README states the real number of syscalls', () => {
  const real = Object.keys(gate.OPS).length;
  const m = /### (\d+) 個系統呼叫/.exec(README);
  assert.ok(m, 'the heading has to name a number, or nothing can check it');
  assert.equal(Number(m[1]), real, `標題說 ${m[1]} 個，gate.OPS 有 ${real} 個`);

  const prompt = /組出 system prompt：(\d+) 個系統呼叫/.exec(README);
  assert.ok(prompt, 'the pipeline diagram names the count too');
  assert.equal(Number(prompt[1]), real, `流程圖說 ${prompt[1]} 個，實際 ${real} 個`);

  /* And the table under the heading has to list them all. A count that matches
     while the table is missing a row is the same lie in a nicer font. */
  const table = README.slice(README.indexOf('### ' + real + ' 個系統呼叫'),
    README.indexOf('這張表就是 `gate.js` 裡的 `OPS`'));
  for (const op of Object.keys(gate.OPS)) {
    assert.ok(table.includes('`' + op + '`'), `${op} 不在 README 的 syscall 表裡`);
  }
});

/* Chinese numerals, because that is how the prose is written. Only the ones the
   documents actually use. */
const CN = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16
};

test('the README states the real number of capabilities and themes', () => {
  const caps = Object.keys(gate.DEFAULT_POLICY).length;
  const capM = /([一二三四五六七八九十]+)個能力，每個是/.exec(README);
  assert.ok(capM, 'the capability section has to name a number');
  assert.equal(CN[capM[1]], caps, `README 說${capM[1]}個能力，政策表有 ${caps} 個`);

  /* The theme list lives in three places by design -- os.css, shell.js and the
     syscall signature the model reads. The signature is the one this checks,
     because it is the one a wrong number would mislead the model with. */
  const themes = gate.OPS['theme.set'].sig.split('|').length;
  const themeM = /([一二三四五六七八九十]+)個主題/.exec(README);
  assert.ok(themeM, 'the theme count has to be stated');
  assert.equal(CN[themeM[1]], themes, `README 說${themeM[1]}個主題，簽名列了 ${themes} 個`);
});

test('the README test tables match the test files', () => {
  const unit = {};
  let total = 0;
  for (const f of fs.readdirSync(path.join(ROOT, 'test')).filter((x) => x.endsWith('.test.js'))) {
    const n = (read('test/' + f).match(/^test\(/gm) || []).length;
    unit[f] = n;
    total += n;
  }

  for (const [f, n] of Object.entries(unit)) {
    const m = new RegExp('`test/' + f.replace(/\./g, '\\.') + '` \\((\\d+)\\)').exec(README);
    assert.ok(m, `${f} 有 ${n} 個測試但沒有列在 README 的表裡`);
    assert.equal(Number(m[1]), n, `README 說 ${f} 有 ${m[1]} 個，實際 ${n} 個`);
  }

  for (const re of [/npm test\s+# (\d+) 個/, /test\/\s+(\d+) 個測試/]) {
    const m = re.exec(README);
    assert.ok(m, 'the total has to be stated: ' + re);
    assert.equal(Number(m[1]), total, `README 說共 ${m[1]} 個，實際 ${total} 個`);
  }

  const h = /\*\*(\d+) 個測試\*\*/.exec(HANDOVER);
  assert.ok(h, 'HANDOVER states the total too');
  assert.equal(Number(h[1]), total, `HANDOVER 說 ${h[1]} 個，實際 ${total} 個`);
});

test('every e2e spec is listed in the README', () => {
  /* The count per spec is not asserted: a spec's subtests can be a loop over a
     table of cases, and counting those from source means reimplementing the
     loop. Being listed at all is what matters -- a spec nobody documented is a
     spec nobody knows to run. */
  for (const f of fs.readdirSync(path.join(ROOT, 'e2e', 'specs')).filter((x) => x.endsWith('.mjs'))) {
    assert.ok(README.includes('`e2e/specs/' + f + '`'),
      `e2e/specs/${f} 沒有列在 README 的表裡`);
  }
});

/* ---------------------------------------------------------------- paths */

test('every file the documents name actually exists', () => {
  /* Runtime files, which live in userData or are made by a generated app. They
     are named in the prose as things you will find on a running machine, not as
     things in this repository. */
  const RUNTIME = new Set([
    'policy.json', 'session.json', 'memory.json', 'model-provider.json',
    'apps-index.json', 'mail-account.json', 'app.js', 'manifest.json',
    'Start-AIOS.bat', 'Start-OrnithA1.ps1', 'Benchmark-LlamaServer.ps1',
    'origins.json', 'restore.json', 'index.json'
  ]);

  const missing = [];
  for (const [name, doc] of DOCS) {
    for (const m of doc.matchAll(/`((?:app|test|e2e|build|graphify-out)\/[A-Za-z0-9_./-]+\.[a-z]+)`/g)) {
      const p = m[1];
      if (RUNTIME.has(path.basename(p))) continue;
      if (!fs.existsSync(path.join(ROOT, p))) missing.push(name + ' → ' + p);
    }
  }
  assert.deepEqual([...new Set(missing)], [],
    '文件指向不存在的檔案：\n  ' + [...new Set(missing)].join('\n  '));
});

/* -------------------------------------------------- strings quoted twice */

test('the sandbox attribute in the prose is the one in the code', () => {
  /* This is the one that was wrong. `allow-forms` was added because Chromium
     refuses a form submission before dispatching the event, so a generated app's
     submit handler never ran -- the app rendered, said 執行中, and its only
     button did nothing. The README kept describing the frame from before the
     fix, which is worse than saying nothing: it documents a bug as a design. */
  const decl = /var FRAME_SANDBOX\s*=\s*'([^']+)'/.exec(read('app/renderer/apps/appshell.js'));
  assert.ok(decl, 'appshell.js must define the sandbox in one place');
  assert.ok(README.includes('sandbox="' + decl[1] + '"'),
    `README 沒有寫出實際的 sandbox 屬性「${decl[1]}」`);

  /* And the file's own header must not contradict its own constant. */
  const header = read('app/renderer/apps/appshell.js').slice(0, 2000);
  const quoted = header.match(/sandbox="([^"]+)"/g) || [];
  for (const q of quoted) {
    assert.ok(q.includes(decl[1]),
      `appshell.js 的檔頭寫 ${q}，但常數是 '${decl[1]}'`);
  }

  const pdfAttr = /setAttribute\('sandbox', '([^']+)'\)/.exec(read('app/renderer/apps/pdf.js'));
  assert.ok(pdfAttr, 'the PDF viewer sets its own sandbox');
  assert.ok(README.includes(pdfAttr[1]),
    `README 沒有寫出 PDF 檢視器實際的 sandbox 屬性「${pdfAttr[1]}」——` +
    '而它和生成程式相反的那一點正是最值得說的地方');
});

test('both generated-app frames are served from the scheme, not srcdoc', () => {
  /* They moved to aios-app:// because a srcdoc document inherits the shell's
     CSP, which allows only script-src 'self' -- so the app's own inline
     bootstrap was silently blocked, #root stayed empty, and nothing was left
     alive to report it. A comment in appshell.js went on saying the bootstrap
     "has to be inlined into srcdoc" long afterwards.

     Pinned on the mechanism rather than on the prose. Policing every sentence
     that contains the word gives false positives on the true ones -- forge.js
     correctly explains *which* schemes inherit a policy, and srcdoc is one of
     them -- while this catches the thing that actually regressed. */
  const shell = read('app/renderer/apps/appshell.js');
  const forge = read('app/renderer/apps/forge.js');

  for (const [name, src] of [['appshell.js', shell], ['forge.js', forge]]) {
    assert.ok(!/\.srcdoc\s*=/.test(src), `${name} 還在設 srcdoc`);
    assert.match(src, /frame\.src = pub\.data\.url/,
      `${name} 的 frame 必須從 scheme 取得內容`);
  }

  /* The smoke test and the installed app have to arrive the same way, or the
     test frame is not the frame that ships. */
  for (const src of [shell, forge]) {
    assert.match(src, /A\.forge\.frame\(|forge\.publish\(|await A\.forge\.frame/,
      '兩邊都要走同一條發布路徑');
  }

  // And the one sentence that was wrong must not come back.
  assert.ok(!/has to be inlined into srcdoc/.test(shell),
    'appshell.js 又說 bootstrap 必須內嵌進 srcdoc 了');
});

/* ----------------------------------------------------------- dependencies */

test('the README lists exactly the dependencies package.json declares', () => {
  /* This one had gone stale in the most misleading direction available: the
     prose said "執行期依賴只有兩個" and named electron, which is a *dev*
     dependency, while imapflow and nodemailer -- both genuinely loaded at
     runtime by the mail module -- went unmentioned. The README even contradicted
     itself twenty pages later by naming them. A dependency list is the first
     thing anyone auditing a desktop app reads, so it is worth pinning. */
  const pkg = JSON.parse(read('package.json'));
  const declared = new Map();
  for (const [name, ver] of Object.entries(pkg.dependencies || {})) declared.set(name, ver);
  for (const [name, ver] of Object.entries(pkg.devDependencies || {})) declared.set(name, ver);

  const claimed = new Map();
  for (const m of README.matchAll(/^\| (?:執行期|開發期) \| `([a-z@/-]+)` ([\^~]?[\d.]+) \|/gm)) {
    claimed.set(m[1], m[2]);
  }

  assert.deepEqual([...claimed.keys()].sort(), [...declared.keys()].sort(),
    'README 的依賴表和 package.json 對不起來');
  for (const [name, ver] of claimed) {
    assert.equal(ver, declared.get(name), `README 說 ${name} 是 ${ver}，package.json 是 ${declared.get(name)}`);
  }

  /* And the count in the sentence above the table. */
  const n = /依賴一共([一二三四五六七八九十]+)個/.exec(README);
  assert.ok(n, 'the dependency count has to be stated');
  assert.equal(CN[n[1]], declared.size, `README 說${n[1]}個依賴，實際 ${declared.size} 個`);

  /* Every version the prose puts next to the word Electron is the same one.
     There are four of them once you count 為什麼是 Electron and 架構參考, and a
     version bump is precisely the edit that updates one and forgets the rest.
     The Chromium and Node numbers in that section come from whatever Electron
     ships, so they cannot be read from here -- but they are stated as belonging
     to this exact Electron build, which is what makes this assertion the trigger
     to go and re-read them. */
  const electron = declared.get('electron');
  for (const m of README.matchAll(/Electron\s+(\d+\.\d+\.\d+)/g)) {
    assert.equal(m[1], electron, `README 有一處寫 Electron ${m[1]}，實際是 ${electron}`);
  }
});

/* -------------------------------------------------------- built-in apps */

test('the built-in app count matches the registry and the dock', () => {
  /* Two prose numbers and one piece of markup, all naming the same set. The
     dock said 九個 for as long as it took to add two applications; nobody
     recounts a number in the middle of a sentence. */
  const apps = new Set();
  const dir = path.join(ROOT, 'app', 'renderer', 'apps');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const m = /AIOS\.apps\.register\(\{\s*\n\s*id:\s*'([a-z]+)'/.exec(read('app/renderer/apps/' + f));
    if (m) apps.add(m[1]);
  }
  assert.ok(apps.size > 5, 'the registry scan has to find the applications');

  /* The dock's own buttons, minus the controls that are not applications. */
  const NOT_APPS = new Set(['intent', 'apps', 'import', 'trash', 'policy', 'hud-left', 'hud-right']);
  const dock = [...read('app/renderer/index.html').matchAll(/data-dock="([a-zA-Z-]+)"/g)]
    .map((m) => m[1])
    .filter((id) => !NOT_APPS.has(id))
    /* The memory application's button is `memoryApp`, because `memory` is
       already the id of the HUD's memory readout. */
    .map((id) => (id === 'memoryApp' ? 'memory' : id));
  assert.deepEqual([...dock].sort(), [...apps].sort(),
    'dock 上的程式和註冊的程式對不起來');

  for (const re of [/([一二三四五六七八九十]+)個內建程式，加上核心自己寫的/,
    /`⊞` 所有程式、([一二三四五六七八九十]+)個內建程式/]) {
    const m = re.exec(README);
    assert.ok(m, 'the built-in count has to be stated: ' + re);
    assert.equal(CN[m[1]], apps.size, `README 說${m[1]}個，實際 ${apps.size} 個`);
  }
});

/* ------------------------------------------------- counts inside the code */

test('the README states the real number of op executors', () => {
  /* The architecture tree annotates surfaces.js with how many executors it
     holds. It said 23 while OPS had grown to 26 -- and the two numbers are
     kept honest by wiring.test.js, so only the prose could drift. */
  const src = read('app/renderer/surfaces.js');
  const real = [...src.matchAll(/^\s{4}'([a-z.]+)':\s*(?:async\s+)?function/gm)].length;
  const m = /surfaces\.js\s+(\d+) 個 op 的 executor/.exec(README);
  assert.ok(m, 'the architecture tree names the count');
  assert.equal(Number(m[1]), real, `README 說 ${m[1]} 個 executor，實際 ${real} 個`);
  assert.equal(real, Object.keys(gate.OPS).length,
    'executor 的數量本來就該等於 OPS 的大小');
});

test('the README states the real number of path-escape shapes', () => {
  /* The number is the length of a table inside another test. Adding a case
     there is exactly the moment the prose stops being true. */
  const suite = read('test/sandbox.test.js');
  const block = /rejects every shape of path escape[\s\S]*?const attacks = \[([\s\S]*?)\n\s*\];/.exec(suite);
  assert.ok(block, 'the escape table has to be findable');
  const real = (block[1].match(/^\s*\[/gm) || []).length;
  const m = /測試裡列了 (\d+) 種逃逸手法/.exec(README);
  assert.ok(m, 'the escape count has to be stated');
  assert.equal(Number(m[1]), real, `README 說 ${m[1]} 種，表裡有 ${real} 種`);
});

/* --------------------------------------------------------------- links */

test('every internal link points at a heading that exists', () => {
  /* Three were dead. Two had been renamed out from under the link (`#能力政策`
     became 能力閘門與汙染降級, `#powerpoint-匯出` grew a `（.pptx）`), and one
     pointed at a section that never existed. A dead anchor scrolls nowhere and
     says nothing, so nobody notices from the rendered page. */
  for (const [doc, src] of DOCS) {
    const slugs = new Set();
    let fence = false;
    for (const line of src.split('\n')) {
      if (/^\s*```/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      const h = /^#{1,6}\s+(.*?)\s*$/.exec(line);
      if (!h) continue;
      slugs.add(h[1].replace(/`/g, '').toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-'));
    }
    const dead = [...src.matchAll(/\[([^\]]*)\]\(#([^)]+)\)/g)]
      .filter((m) => !slugs.has(m[2]))
      .map((m) => '[' + m[1] + '](#' + m[2] + ')');
    assert.deepEqual([...new Set(dead)], [], doc + ' 有指不到任何標題的內部連結');
  }
});

test('the documents contain no control characters', () => {
  /* HANDOVER lost twelve characters this way and nobody saw it for a round.
     The section had been written through a PowerShell double-quoted here-string
     (@"..."@), and PowerShell treats the backtick as its escape character there:
     `a became BEL, `f a form feed, `t a tab, `r a carriage return, and every
     other backtick simply vanished. So `appshell.js` landed in the file as
     BEL + "ppshell.js" -- a letter short, with an invisible control character
     where the backtick had been. Markdown rendered it happily, so on screen it
     read as a couple of typos rather than as corruption.

     The fix for the writer is to use a single-quoted here-string, @'...'@, or
     not to go through the shell at all. The fix for the document is this
     assertion, because the damage is invisible in every viewer that matters. */
  for (const [name, src] of DOCS) {
    const bad = [];
    for (let i = 0; i < src.length; i++) {
      const n = src.charCodeAt(i);
      if (n < 32 && n !== 10) {
        bad.push('第 ' + (src.slice(0, i).split('\n').length) + ' 行有 0x' +
          n.toString(16).padStart(2, '0') + '：…' + src.slice(Math.max(0, i - 20), i + 20).replace(/\n/g, '⏎') + '…');
      }
    }
    assert.deepEqual(bad, [], name + ' 裡有控制字元（多半是 shell 吃掉了反引號）：\n  ' + bad.join('\n  '));
  }
});

/* ---------------------------------------------------- architecture tree */

test('every source file appears in the architecture tree', () => {
  /* The tree is the only place that claims to be a complete listing, which is
     what makes it the one that quietly stops being one. bookmarks.js,
     mailstore.js and preset.js were all missing -- three modules a reader
     following the tree would conclude do not exist. */
  const tree = README.slice(README.indexOf('## 架構參考'));

  const missing = [];
  for (const dir of ['app/main', 'app/preload', 'app/renderer']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (!f.isFile()) continue;
      if (!tree.includes(f.name)) missing.push(dir + '/' + f.name);
    }
  }
  /* The applications are listed by id rather than by filename, because that is
     what the dock and the syscalls call them. */
  for (const f of fs.readdirSync(path.join(ROOT, 'app/renderer/apps'))) {
    const stem = f.replace(/\.js$/, '');
    if (!tree.includes(f) && !new RegExp('\\b' + stem + '\\b').test(tree)) {
      missing.push('app/renderer/apps/' + f);
    }
  }
  assert.deepEqual(missing, [], '架構樹沒有列出這些檔案：\n  ' + missing.join('\n  '));
});
