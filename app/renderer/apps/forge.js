'use strict';

/* ===========================================================================
   AI-OS // App Forge
   ---------------------------------------------------------------------------
   The machine writing its own programs.

   Flow: a sentence about what is needed becomes a spec, the spec becomes code,
   the code is checked, run, reviewed, installed as v1, registered as a
   launchable app, and opened. Asking for a change repeats the loop against the
   current source and installs v2. Every version keeps the request that produced
   it, so the trail from "I want a thing that tracks X" to the code running now
   is readable.

   Generation is two calls rather than one. Asking a local model for JSON with a
   whole program inside a string field means escaping every newline and quote,
   and it gets that wrong often. Spec first as JSON, then code as plain text, is
   far more reliable and each half can be repaired independently.

   A build does not stop at the first failure. It is a loop with a budget: a
   candidate that fails a check is handed back with the complaint and a remedy;
   one that fails the same way twice sends the spec back to the planner with the
   history of what went wrong; a program too large for one answer is continued
   across answers or built in stages; and when the budget is spent, the best
   candidate that ran is installed with a note saying what it lacks, rather than
   nothing. See buildProgram.

   Nothing generated here runs with any authority of its own: see appshell.js.
   =========================================================================== */

/* global window, document, AIOS */

(function () {
  var A = window.aios;
  var K = AIOS.kernel;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* -------------------------------------------------------------- budgets */

  /**
   * How hard a build may try before it says it could not.
   *
   * Every number here bounds a loop that would otherwise be bounded only by the
   * model's willingness to keep failing, and each round of it costs a model
   * call. They are generous on purpose -- the previous shape stopped after three
   * static retries and one smoke retry, and a program that needed a fourth was
   * simply not built -- but they are still numbers, and the log says which one
   * ran out.
   */
  var BUILD = {
    MAX_ROUNDS: 10,      // code generations per build; every repair is one
    MAX_REPLANS: 2,      // times the spec itself may be rewritten from failures
    MAX_MINUTES: 25,     // wall clock for the whole build
    MAX_CONTINUE: 3,     // continuations when the code outruns the output cap
    CODE_TOKENS: 8000,   // asked for; a provider's own cap wins when it sets one
    PHASE_ITEMS: 4,      // plan items per stage when building in stages
    SINGLE_SHOT_ITEMS: 5, // a plan longer than this is built in stages
    MAX_STAGES: 5,       // stages at most; a longer plan gets bigger stages
    STEP_ROUNDS: 4,      // rounds one stage may spend before it is skipped
    REVIEW_ROUNDS: 2     // rounds to act on what the review found
  };

  /* ------------------------------------------------------------- prompting */

  var ENV_DOC = [
    '執行環境（很重要，寫錯就跑不起來）：',
    '- 程式跑在一個沙箱 iframe 裡，沒有直接的網路、沒有直接的檔案系統、看不到宿主程式。',
    '  要連網就宣告 net 能力並用 os.net（見下）；要存檔就用 os.files；電腦上沙箱以外的東西一律碰不到。',
    '- 你必須定義一個全域函式：function render(root, os) { ... }',
    '  root 是一個空的 <div>，你在裡面用原生 DOM API 建介面。',
    '- os 的所有方法都是 async（回傳 Promise）：',
    '    os.storage.get(key) / os.storage.set(key, value) / os.storage.keys()',
    '        程式自己的小型儲存區，適合設定與清單，上限 512 KB。',
    '    os.files.list(dir) / os.files.read(path) / os.files.write(path, content)',
    '        程式自己的資料夾（自動限定在 /appdata/<你的程式>/），path 用相對路徑。',
    '        read 回傳檔案內容字串；list 回傳 { vpath, entries: [{ name, dir, vpath, size }] }（dir 為 true 是資料夾）。',
    '    os.sandbox.list(dir) / os.sandbox.read(path)   // 只有宣告 sandbox-read 能力才可用',
    '        使用者沙箱的絕對路徑（例如 "/inbox"、"/notes/a.txt"）；read 回傳內容字串，list 的形狀同上。',
    '        .docx / .xlsx / .pdf 是二進位檔，read 讀不出內容；要處理它們就用 os.apps.do 叫對應的程式。',
    '    os.sandbox.write(path, content) / os.sandbox.mkdir(path)   // 只有宣告 sandbox-write 能力才可用',
    '        寫使用者沙箱裡的任何路徑（例如 /notes/報告.md）；會覆蓋既有檔案，路徑要讓使用者指定或確認。',
    '    os.ai.ask(prompt)      // 問模型一個問題，回傳字串',
    '    os.ai.json(prompt, schema)   // 同上，但要求模型依 JSON Schema 回傳物件（分類、抽取、結構化摘要用它）',
    '        例如 await os.ai.json("判斷這段的情緒", {type:"object",properties:{label:{type:"string"}},required:["label"]})',
    '    os.apps.list() / os.apps.do(app, action, args) / os.apps.open(path)   // 只有宣告 apps 能力才可用',
    '        叫系統裡的其他程式做事：docs、sheets、slides、editor、files、mail、browser、memory…',
    '        list() 回每個程式的動作名稱、參數簽名與說明；do() 執行一個動作並回傳結果；',
    '        open(path) 用適合的程式開啟一個沙箱檔案（.md 進 Markdown 檢視器、.docx 進文件、.xlsx 進試算表、.txt 進編輯器）。',
    '        動作名稱只能用 list() 列出來的，不要猜：「開啟檔案」不是任何程式的動作，一律用 os.apps.open(path)。',
    '        例如 await os.apps.do("sheets", "setRange", {...})、await os.apps.do("docs", "saveAs", {path: "/notes/x.docx"})。',
    '        不能指定 forge 或你自己。',
    '    os.ui.title(text) / os.ui.toast(text)',
    '        title 是接在程式名稱後面的「副標題」，視窗會顯示成「程式名 — text」。',
    '        所以 text 不要再放程式名稱，放現在的狀態就好（例如「3 筆未買」、「編輯中」）；',
    '        沒有狀態可講就不要呼叫。',
    '    os.clipboard.write(text)',
    '    os.page.read(limit) / os.page.apply(ops) / os.page.pdf(path)   // 只有宣告 page 能力才可用',
    '        瀏覽器擴充功能用的。read() 回傳 { url, title, nodes:[{node, tag, text}] }，',
    '        node 是編號；apply([{node, text}]) 把那些編號的文字換掉；pdf(path) 把整頁存成 PDF。',
    '        ★ 你的程式不會在網頁裡執行。你拿到的是頁面的文字，回傳的是「要改成什麼」，',
    '        由系統去套用。所以只能換文字，不能塞 HTML、不能加事件、不能碰網頁的 JS。',
    '    os.calc(算式字串)       // 算數學算式，回傳數字',
    '    os.net.fetch(url, {method, headers, body})   // 只有宣告 net 能力才可用',
    '        回傳 { url, status, ok, headers, text }。由核心代為連線，沒有 CORS 問題；',
    '        只能連 http/https 的公開網址，不能連本機與內網；回應上限 4 MB；每分鐘最多 60 次。',
    '    os.net.json(url, opts)  // 同上，但直接回傳 JSON.parse 後的物件，非 2xx 或不是 JSON 就 throw。',
    '        天氣、匯率、新聞這類需求就用它接公開 API（例如 open-meteo.com 不用金鑰）。',
    '        資料的解析與畫面更新要拆成純函式，selfTest 用一份範例資料測那些函式，不要真的連網。',
    '',
    '★ 你可以用的東西（不必宣告能力）：',
    '  原生 DOM、CSS（grid / flex / animation / transition）、SVG、<canvas> 的 2D context、',
    '  requestAnimationFrame、setTimeout / setInterval、鍵盤與滑鼠事件、Web Audio（AudioContext 合成音效）、',
    '  Date / Intl、Map / Set、正規表達式、JSON。這些足以做遊戲、繪圖工具、編輯器、計時器、資料表。',
    '  要收鍵盤事件就給容器 tabIndex = 0 並在 render() 結尾 focus() 它；事件掛在容器上，不要掛在 window。',
    '  圖片只能用 data: URI，或自己用 canvas / SVG 畫，不能載入外部圖片。',
    '  沒有「下載檔案」這回事：要輸出就 os.files.write（需要 appdata）或 os.clipboard.write。',
    '',
    '★ 讓你的程式可以被自動化（重要）：',
    '    在 render() 裡把程式能做的事登記到 os.actions，這樣使用者就可以用一句話',
    '    叫核心驅動它，或是把一份 100 列的資料餵給它逐列處理。',
    '    os.actions.addEntry = {',
    '      desc: "新增一筆報名", args: "{name, email}",',
    '      run: async function (a) { …做事…; return "已新增 " + a.name; }',
    '    };',
    '    每個動作要：參數用具名的鍵、做完回傳一句人看得懂的話、失敗就 throw。',
    '    凡是使用者按按鈕做得到的事，都應該有一個對應的動作。',
    '',
    '★ 自我測試（必做，建置時會自動執行）：',
    '    在 render() 裡登記 os.actions.selfTest = { desc: "自我測試", args: "{}",',
    '      run: async function () { …用程式自己的函式跑一遍關鍵流程…; return "自我測試通過：N 項"; } };',
    '    要測的是規格裡的核心行為：例如新增一筆→總數對→刪掉→歸零；算式算對；狀態存了讀得回來。',
    '    每一項不符就 throw new Error("selfTest：哪裡不對，期望 X 得到 Y")。',
    '    規則：可以 await 程式自己的 async 函式，但不要用 setTimeout 等時間、不要呼叫 os.ai.ask；',
    '    測完把測試資料清掉，不要留在畫面或 storage 裡；不能只回傳「通過」而什麼都沒檢查。',
    '    自我測試失敗的程式會被退回修正，所以測試要對得上程式真正的行為。',
    '',
    '★ 算式一定要用 os.calc，不可以用 eval 或 new Function。',
    '  os.calc 用的是試算表的運算式引擎：支援 + - * / ^、括號、負號，',
    '  以及 SUM MIN MAX ROUND ABS SQRT 等函式。範例：',
    '    var n = await os.calc("(1+2)*3");        // 9',
    '    var m = await os.calc("2^10");           // 1024',
    '  除以零之類的錯誤會 throw，用 try/catch 接起來再 os.ui.toast 告訴使用者。',
    '  要做計算機就是這樣做 —— 不要自己寫 parser，也不要嘗試繞過這條規則。',
    '',
    '',
    '★ 只有 capabilities 宣告過的 API 才能呼叫。沒宣告就呼叫會在執行期被拒絕，',
    '  程式會半途壞掉。對照表：',
    '    os.storage.*   需要 "storage"',
    '    os.files.*     需要 "appdata"',
    '    os.sandbox.list / read    需要 "sandbox-read"',
    '    os.sandbox.write / mkdir  需要 "sandbox-write"',
    '    os.ai.ask / os.ai.json    需要 "ai"',
    '    os.clipboard.* 需要 "clipboard"',
    '    os.net.*       需要 "net"',
    '    os.apps.*      需要 "apps"',
    '  os.ui.* 與 os.calc 不需要任何能力。',
    '  所以：要用就宣告，不宣告就不要用。這件事安裝前會被檢查。',
    '',
    '- 不可以用：fetch、XMLHttpRequest、WebSocket、eval、new Function、import()、require、',
    '  localStorage、document.cookie、parent、top。用了會被拒絕安裝，換一個也一樣：',
    '  eval 與 new Function 都禁，兩個都不能用；直接的 fetch 被 CSP 擋住，連網一律走 os.net。',
    '- 不能自己載入外部函式庫或字型（CSP 會擋）。需要現成的套件（圖表、Markdown、QR code、日期、',
    '  PDF、壓縮、數學…）就在規格的 libs 列出 npm 套件名與它掛在 window 上的全域變數名，',
    '  系統會自動下載、檢查、和你的程式一起載入；程式碼裡直接用那個全域變數（例如 new Chart(...)、',
    '  marked.parse(...)），不要 import、不要 require、不要自己插 <script>。',
    '  規格沒列的套件在執行期不存在，用了就是 ReferenceError。',
    '- 樣式：已注入 CSS 變數 --bg-1 --fg --fg-dim --fg-faint --accent --accent-2 --hair',
    '  --hair-2 --danger --warn --on-fill --mono --sans，button/input/table 已有基本樣式。',
    '  請用這些變數配色，不要寫死顏色。',
    '- 介面文字一律繁體中文。',
    '',
    '★ 大型程式的寫法：',
    '- 狀態集中在一個物件，畫面用一個 draw() / update() 從狀態重畫，不要把狀態散放在 DOM 裡。',
    '- 功能拆成小函式，每個處理器都能單獨執行（欄位可能是空的、storage 可能還沒有值）。',
    '- render() 不能卡住：需要等資料就先畫空狀態，拿到資料再更新；不要在 render() 裡 while(true)。',
    '- 遊戲迴圈用 requestAnimationFrame，並在 document.hidden 時停下來。',
    '- 程式可以很長，不要為了省篇幅省略功能；但重複的段落要抽成函式，不要複製貼上。',
    '',
    '★ 配色規則（這關係到程式看起來專業還是廉價，請照做）：',
    '- 對比是硬規則：文字與它背後的顏色，亮度對比至少要 4.5:1。',
    '  最常見的錯誤是「淺色底配淺色字」，例如亮綠色按鈕配白字、淺黃底配白字 ——',
    '  看得到但讀起來很吃力。深色底配深色字同理。',
    '- 不要自己猜哪個顏色該配白字或黑字。任何用 --accent / --accent-2 / --warn /',
    '  --danger 當**底色**的元素，文字就寫 color: var(--on-fill)。這個變數的值會跟著',
    '  主題自動變成近黑或純白，是唯一保證讀得清楚的搭配。',
    '    正確：background: var(--accent); color: var(--on-fill);',
    '    錯誤：background: var(--accent); color: #fff;   ← 淺色主題下對比只有 1.7:1',
    '- 一般的按鈕不要上底色。預設的 button 樣式（--hair 底、--fg-dim 字）就是 AI-OS',
    '  的樣子，維持它；只有「主要動作」那一顆才用 --accent 當底色。',
    '  一個畫面裡最多一顆主要按鈕，這是它之所以醒目的原因。',
    '- 顏色比例大致 60 / 30 / 10：多數面積是背景與中性色（--bg-1、--hair、--fg-dim），',
    '  次要是結構與邊框（--hair-2、--fg-faint），只有一成用在強調色上。',
    '  整個畫面最多三到四種顏色，再多就是雜亂而不是豐富。',
    '- 語意要固定：--accent 是主要動作與選取狀態，--accent-2 是成功與完成，',
    '  --warn 是需要注意，--danger 是破壞性動作。不要拿 --danger 當裝飾色。',
    '- 不要只用顏色傳達資訊（紅綠色盲約占男性 8%）。狀態要同時有文字或符號，',
    '  例如「✓ 已完成」而不是只給一個綠點。',
    '- 深淺層次用同一個顏色的透明度做，不要另外發明新顏色：',
    '  color-mix(in srgb, var(--accent) 14%, transparent) 是這個系統的慣用寫法。',
    '',
    '★ 版面規則（視窗會自動縮放成你的內容大小，所以版面寫錯就會看起來很醜）：',
    '- 不要在最外層容器寫 max-width、width: 100vw 或固定像素寬。視窗本來就會貼合你的',
    '  內容，再加一個上限只會讓程式變成一條窄條，而且 margin: 0 auto 也沒有東西可以居中。',
    '  要控制寬度就控制內容本身（例如按鈕的 padding、欄數），不要壓外框。',
    '- 但最外層容器一定要寫 min-width，這是你唯一能說「我需要多寬」的地方。',
    '  視窗量的是內容的自然寬度：一個什麼都能換行、什麼都能壓扁的版面，',
    '  量出來就會是它能縮到的最小值，於是一個四欄表格開起來只有三百多像素寬。',
    '  照內容挑一個數字，不要照抄：',
    '    只有幾顆按鈕或一個計時器　　　　　min-width: 320px',
    '    有輸入表單或左右兩欄　　　　　　　min-width: 420px',
    '    有多欄表格、清單加統計、圖表　　　min-width: 560px',
    '  比那個寬度窄的時候才讓內容換行，這樣視窗一打開就是舒服的寬度，',
    '  使用者想縮小也還是能用。',
    '- min-width 要寫在最外層那個容器上，不能只寫在裡面的表格上。',
    '  一個 overflow-x: auto 的外框對外的最小寬度是零 —— 它等於在說',
    '  「我多窄都行，裡面自己捲」，所以裡層再大的 min-width 都會被它藏起來，',
    '  視窗就照著那個「零」開出來。實際踩過：表格寫了 min-width: 760px，',
    '  外面包一層 overflow-x: auto，視窗開起來只有 400px 寬，表格從第一眼就在捲。',
    '  真的需要橫向捲動時，還是要在最外層寫 min-width 說出你要多寬。',
    '- 不要用 height: 100vh 或 height: 100% 撐滿高度，視窗高度是跟著你長的。',
    '- 用 grid 排鍵盤或按鈕牆時，每一列的 span 總和一定要剛好等於欄數。',
    '  grid-template-columns: repeat(4, 1fr) 的格子裡，如果某一列已經放了 3 個一格寬的鍵，',
    '  再放一個 grid-column: span 2 的鍵就放不下 —— 它會整個掉到下一列並留下一個洞，',
    '  後面每一顆鍵都跟著位移。這是計算機最常見的排版錯誤（= 或 0 佔兩格時特別容易發生）。',
    '  自己數過：4 欄的計算機，最後兩列要嘛是 [1][2][3][+] 與 [0 span2][.][=]，',
    '  要嘛是 [1][2][3][=（下一列開始就不要 span）]，不要讓總和超過 4。',
    '- 按鈕上的字要短。標籤不會自動換行（刻意的），太長只會把整欄撐寬。',
    '- 每一列的高度要一致：同一組按鈕用同樣的 padding 與 font-size。'
  ].join('\n');

  var SPEC_SCHEMA = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      icon: { type: 'string' },
      purpose: { type: 'string' },
      capabilities: { type: 'array', items: { type: 'string', enum: ['storage', 'appdata', 'ai', 'clipboard', 'sandbox-read', 'sandbox-write', 'net', 'apps'] } },
      plan: { type: 'array', items: { type: 'string' } },
      checks: { type: 'array', items: { type: 'string' } },
      size: { type: 'string', enum: ['small', 'medium', 'large'] },
      deferred: { type: 'array', items: { type: 'string' } },
      /* What the planner decided on the user's behalf: the details a one-line
         request leaves out and a finished program cannot. Built (they are in
         the plan) and announced (they are here), so the person sees what was
         assumed and can say otherwise. */
      assumed: { type: 'array', items: { type: 'string' } },
      feasible: { type: 'boolean' },
      refusal: { type: 'string' },
      libs: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, global: { type: 'string' }, why: { type: 'string' } },
          required: ['name', 'global']
        }
      },
      readme: { type: 'string' }
    },
    required: ['name', 'purpose', 'plan', 'feasible']
  };

  /* A package name as npm spells it. Mirrors NPM_NAME in main/forge.js, which
     is the check that counts; this one keeps nonsense out of the log. */
  var NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,200}$/;
  var GLOBAL_NAME = /^[A-Za-z_$][\w$]{0,59}$/;
  var MAX_LIBS = 4;

  /**
   * The line a generated program may not cross, decided before a model is
   * asked.
   *
   * The sandbox enforces this anyway -- a program in the frame cannot reach a
   * file on this machine however it is written -- so the point is honesty: a
   * request for something the program will never be able to do should be
   * refused with the reason, not built into something that quietly cannot do
   * it. The planner makes the full judgement (see makeSpec); this catches the
   * unambiguous cases without spending a call, and its patterns are narrow on
   * purpose. 「刪除清單裡的項目」 is not 「刪除電腦上的檔案」.
   */
  var OUTSIDE = [
    [/[A-Za-z]:\\|[A-Za-z]:\/(?:users|program|windows)/i, '指定了電腦上的絕對路徑'],
    [/登錄檔|regedit|registry/i, '要改 Windows 登錄檔'],
    [/格式化(?:硬碟|磁碟|磁區)|清空(?:硬碟|磁碟)/, '要格式化磁碟'],
    [/(?:把|讓)?(?:電腦|主機|系統)(?:自動)?(?:關機|重開機|重新開機|休眠|登出)|shutdown/i, '要控制電腦的電源'],
    [/(?:執行|啟動|呼叫|開啟)[^，。]{0,12}(?:\.exe|\.bat|\.ps1|\.cmd|powershell|cmd\.exe|終端機指令|命令提示字元)/i, '要執行電腦上的程式或指令'],
    [/(?:安裝|移除|解除安裝)[^，。]{0,8}(?:軟體|應用程式|驅動程式)(?:到|至)?(?:電腦|系統|本機)/, '要在電腦上安裝或移除軟體'],
    [/鍵盤側錄|側錄鍵盤|記錄(?:所有|全部)按鍵|keylog/i, '要側錄鍵盤'],
    [/(?:刪除|清除|清理|移除|修改|改寫|讀取|掃描|搜尋|列出|備份)[^，。]{0,14}(?:電腦|本機|硬碟|磁碟|系統目錄|桌面|我的文件|下載資料夾|使用者資料夾|整台)(?:上|裡|中|內)?[^，。]{0,10}(?:檔案|資料夾|目錄|資料|文件)/, '要碰電腦上沙箱以外的檔案'],
    [/(?:桌面|我的文件|下載資料夾|系統目錄|Program Files|AppData)[^，。]{0,10}(?:的|裡的|中的)[^，。]{0,10}(?:檔案|資料夾|文件)/i, '要碰電腦上沙箱以外的檔案']
  ];

  function screenRequest(request) {
    var text = String(request || '');
    for (var i = 0; i < OUTSIDE.length; i++) {
      if (OUTSIDE[i][0].test(text)) {
        return '這個需求' + OUTSIDE[i][1] + '。生成的程式只能碰自己的資料夾、沙箱裡的檔案與網路，' +
          '碰不到電腦上沙箱以外的任何東西——這不是能力不夠，是這台機器刻意不給的。' +
          '可以改成：只處理沙箱裡的檔案（先用「從 OS 匯入」把檔案放進沙箱），或者把要處理的資料貼進程式裡。';
      }
    }
    return null;
  }

  /**
   * Plan a program, or re-plan one whose plan did not survive being built.
   *
   * `opts.failures` is what happened to the previous spec, round by round. A
   * planner that is told only "try again" produces the same spec, and the same
   * spec produces the same code; told which mechanism kept failing, it can route
   * around it. `opts.mode === 'simplify'` asks for the smallest version that is
   * certain to build, with everything else listed under `deferred` so the user is
   * told what was left out rather than left to discover it.
   */
  async function makeSpec(request, existing, onToken, opts) {
    opts = opts || {};
    var sys = [
      '你是 AI-OS 的程式設計師。使用者描述一個需求，你先規劃出這個小程式的規格。',
      '',
      ENV_DOC,
      '',
      '輸出 JSON：',
      '{"name":"程式名稱（4-12 字）","icon":"一個符號字元","purpose":"一句話說明用途",',
      ' "feasible":true,"refusal":"",',
      ' "capabilities":["storage"],"plan":["要做的介面元素與行為，一項一行"],',
      ' "checks":["建置時自我測試要驗證的行為，一項一行"],"size":"small|medium|large",',
      ' "assumed":["你替使用者補上的決定，一項一行"],',
      ' "deferred":["這一版刻意不做的功能"],"readme":"使用說明"}',
      '',
      '★ 把一句話的需求補完整（使用者通常只說一句話，細節是你的責任，不是他的）：',
      '使用者說「一個記帳工具」，他要的不只是一個輸入框和一張清單。先想「這個人為什麼要這個、',
      '會在什麼時候打開它、打開之後第一件事是什麼」，然後逐項過下面的清單，把他沒說但一定會需要的',
      '東西補進 plan，並在 assumed 列出你替他做的每一個決定：',
      '- 資料：要不要記住（關掉重開還在）？記在 storage 還是 appdata？能不能清空、匯出、備份？上限多少？',
      '- 輸入：空值、非數字、超出範圍、重複、太長，各怎麼處理？預設值是什麼？日期、金額、單位用什麼格式？',
      '- 狀態：第一次打開沒有資料時顯示什麼（空狀態要有引導，不能一片空白）？載入中怎麼顯示？',
      '  失敗訊息要看得懂、能重試；連網的程式要處理逾時和 API 回傳不完整。',
      '- 操作：新增／編輯／刪除／排序／搜尋／篩選哪些該有？刪除要能復原或先確認。Enter 送出、Esc 取消。',
      '- 邊界：資料有幾百筆時還能用嗎？很長的文字會不會撐壞版面？0 和負數？跨日與時區？',
      '- 一眼看懂：最重要的數字或狀態放最顯眼的位置；600×400 的小視窗也要能用。',
      '- 順手的一兩件事，依用途推：記帳→本月合計與分類小計；番茄鐘→今天完成幾輪；待辦→到期日與過期標示；',
      '  查詢→記住上次查的；遊戲→最高分與重新開始；轉換器→常用值一鍵帶入。',
      '規則：補上的東西一定要寫進 plan（寫在 assumed 但不在 plan 的不會被做出來），也一定要列在 assumed',
      '（使用者才知道那是你決定的，不合意可以改）；small 補 1–3 項、medium 3–5 項、large 5–8 項，',
      '不要把小工具膨脹成系統；和使用者明說的衝突時以使用者為準；拿不準就選最常見的做法並在 assumed',
      '說明，不要問（建置在背景進行，沒有人會回答）。修改現有程式也一樣：使用者說「加個匯出」，',
      '你要決定匯出什麼格式、檔名怎麼取、失敗時怎麼說，並列在 assumed。',
      '',
      '★ 先判斷這個需求能不能在這台機器上建置（feasible）：',
      '- 可以：任何在沙箱 iframe 裡做得到的事，包括需要網路資料的程式（宣告 net，用 os.net.fetch / os.net.json',
      '  接公開 API，例如查一週天氣、匯率、新聞）、讀寫程式自己的資料夾（appdata）、讀使用者沙箱裡的檔案',
      '  （sandbox-read）、問模型（ai）、遊戲、工具、編輯器、任何複雜度的介面。複雜不是拒絕的理由。',
      '- 不可以：需要碰沙箱以外的本機資源——讀取、修改、刪除電腦上的任意檔案（桌面、C:\\、系統目錄）、',
      '  執行其他程式或指令、改系統設定、關機、安裝軟體、讀其他程式的資料、側錄鍵盤、連本機或內網服務。',
      '  這些不是能力不夠，是這台機器刻意不給生成程式的權限，所以不要用「模擬」或「假裝做到」來交差。',
      '- 一部分做得到、一部分不行：feasible 填 true，做得到的部分照做，做不到的列進 deferred 並在 readme 說明。',
      'feasible 為 false 時：name 照樣取，plan 留空陣列，refusal 用兩三句話說明「為什麼不能」與',
      '「可以改成什麼」（例如：先用「從 OS 匯入」把檔案放進沙箱，程式就處理得到）。',
      '你在這裡的判斷就是最終授權：建好的程式執行時不會再被問、不會被政策擋住，它宣告的能力就是它拿到的。',
      '所以能力要據實宣告（用到網路就寫 net、要讀沙箱就寫 sandbox-read），不該存在的程式現在就拒絕，',
      '不要把「不知道能不能」推給之後。',
      '',
      '★ 系統沒有的功能，自己去找來裝（libs）：',
      '需要現成的函式庫就列在 libs：name 是 npm 套件名，global 是它掛在 window 上的全域變數名，',
      'why 說用途。例如 {"name":"chart.js","global":"Chart"}、{"name":"marked","global":"marked"}、',
      '{"name":"qrcode","global":"QRCode"}、{"name":"dayjs","global":"dayjs"}、{"name":"jszip","global":"JSZip"}、',
      '{"name":"mathjs","global":"math"}、{"name":"papaparse","global":"Papa"}。系統會從 npm 下載該套件',
      '的瀏覽器版（jsDelivr 的預設檔案，必須是掛全域變數的 UMD/IIFE 建置）、檢查、釘住雜湊，',
      '在程式之前載入。最多 4 個；只列真的需要、而且你確定有瀏覽器 UMD 版的套件；',
      '原生 API 幾十行做得到的事就不要拉套件。',
      '「系統目前沒有這個功能」不是拒絕或縮減的理由——先想有沒有套件能補上；',
      '真的沒有套件也做不到的（例如需要 GPU 運算的模型、需要作業系統權限的東西）才列進 deferred 並說明。',
      '',
      'capabilities 只列真正需要的：要記東西才用 storage，要存檔案才用 appdata，',
      '要問模型才用 ai，要讀使用者的沙箱檔案才用 sandbox-read，要寫使用者的沙箱檔案（例如把報告存到 /notes）',
      '才用 sandbox-write，要連網才用 net，要叫文件／試算表／簡報／郵件等其他程式做事才用 apps。能不要就不要。',
      '但要用就一定要宣告：plan 裡只要提到記住、保存、歷史紀錄、上次的值，',
      'capabilities 就必須包含 storage，否則程式碼會呼叫被拒絕的 API 而半途壞掉。',
      'plan 要具體：寫出有哪些按鈕、欄位、清單，以及按下去會發生什麼。',
      'plan 描述行為，不要指定被禁的實作手段。要算算式就寫「用 os.calc 計算」，',
      '絕對不要寫 eval 或 new Function —— 寫進規格等於叫自己去違規，程式碼會被拒絕。',
      'checks 寫 3–8 條程式可以自己驗證的行為（例如「新增一筆後清單長度加一」、',
      '「輸入 2+3 顯示 5」），程式碼會照它們寫 selfTest。',
      'size：small 是幾十行就寫完的小工具，medium 是一般的工具，large 是需要好幾百行以上的程式',
      '（多個畫面、多個子系統、有關卡或地圖的遊戲）。',
      'plan 的每一項是一個可以獨立做完、獨立驗證的小步驟，不要把好幾個功能塞在同一項裡：',
      'small 通常 3–5 項，medium 6–10 項，large 10–16 項。',
      'plan 超過五項、或 size 是 large，就會分階段建置：先做核心，每個階段做完先檢查、跑過、',
      '自我測試通過，再加下一批。所以 plan 的順序要讓前面幾項單獨就是一個能跑的核心版本，',
      '後面幾項是逐步加上去的功能；每一項要小到一個階段做得完、測得到。',
      '這個環境做不到的事（連網路、外部函式庫、下載檔案）不要放進 plan，改用做得到的方式替代，',
      '真的無法替代就列進 deferred 並在 readme 說明。'
    ].join('\n');

    var user;
    if (opts.mode === 'replan' && opts.previous) {
      user = '原本的需求：\n' + request +
        '\n\n上一版規格：\n' + JSON.stringify(opts.previous, null, 2) +
        '\n\n照這份規格做出來的程式反覆失敗，每一輪的問題：\n' +
        (opts.failures || []).map(function (f) { return '- ' + f; }).join('\n') +
        '\n\n請重新規劃，換一種更不容易出錯的做法：避開上面失敗涉及的機制；' +
        '把最容易出錯的部分簡化或改用另一種實作方式；' +
        '在這個環境做不到的功能列進 deferred，用做得到的方式替代。' +
        'plan 每一項要寫清楚做什麼，但項數不要膨脹：合併相關的小項，總數不要超過上一版的 1.5 倍；' +
        'deferred 只列使用者會在意的功能，不要列實作細節。' +
        'name 與 icon 保持不變。輸出完整的新規格。';
    } else if (opts.mode === 'simplify' && opts.previous) {
      user = '原本的需求：\n' + request +
        '\n\n上一版規格：\n' + JSON.stringify(opts.previous, null, 2) +
        '\n\n這份規格建不出來，每一輪的問題：\n' +
        (opts.failures || []).map(function (f) { return '- ' + f; }).join('\n') +
        '\n\n請把規格縮減成一個一定做得出來的核心版本：plan 最多 5 項，只留最重要、最單純的功能，' +
        '其餘全部列進 deferred。size 填 small。name 與 icon 保持不變。';
    } else if (existing) {
      user = '這是現有程式的規格：\n' + JSON.stringify(existing, null, 2) +
        '\n\n使用者要求的修改：\n' + request +
        '\n\n請輸出修改後的完整規格（name 與 icon 通常保持不變；plan 要列出修改後程式的全部功能，' +
        '不只是這次改的部分）。';
    } else {
      user = '需求：\n' + request;
    }

    var res = await K.complete({
      owner: 'forge',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      schema: SPEC_SCHEMA,
      schemaName: 'appspec',
      temperature: opts.mode ? 0.5 : 0.4,
      maxTokens: 1600,
      onToken: onToken
    });
    K.addSpend(res.spend);
    return sanitiseSpec(res.data);
  }

  /* Forbidden techniques that have a legal equivalent: swap the name. A bare
     `fetch` becomes `os.net.fetch` (the lookbehind keeps the replacement from
     matching itself); the capability it needs is added below. */
  var SUBSTITUTE = [
    [/\bnew\s+Function\b/gi, 'os.calc'],
    [/\beval\s*\(/gi, 'os.calc('],
    [/\beval\b/gi, 'os.calc'],
    [/\blocalStorage\b/gi, 'os.storage'],
    [/(?<![.\w])fetch\b/gi, 'os.net.fetch'],
    [/\bXMLHttpRequest\b/gi, 'os.net.fetch']
  ];
  var SUBSTITUTABLE = /\bnew\s+Function\b|\beval\b|\blocalStorage\b|(?<![.\w])fetch\b|\bXMLHttpRequest\b/i;

  /* Forbidden techniques with no equivalent at all: a plan step built on one
     cannot be delivered however it is worded. Blanking the name would leave
     "使用 取得遠端資料"; the step goes instead. */
  var NO_EQUIVALENT = /\bWebSocket\b|\bimport\s*\(|\brequire\s*\(/i;

  var NEGATED = /不|勿|避免|禁止|別|沒有|無法/;
  /* Clause boundaries in both scripts, since a plan line mixes them. */
  var CLAUSE = /([^，。；、,;.]+[，。；、,;.]?)/g;

  /**
   * Take forbidden techniques out of the spec before the spec becomes an order.
   *
   * The spec is handed to makeCode as the authoritative instruction, so a plan
   * line reading "使用 JavaScript 原生 eval 計算結果" tells the model to do the one
   * thing that guarantees rejection -- and it outranks the prohibition in the
   * environment notes, because it is specific and it is the actual task. That is
   * what happened with the calculator: the plan asked for eval, the code used
   * eval, the validator refused, the retry substituted new Function, and the
   * whole generation failed with nothing to show.
   *
   * Rewriting here rather than re-planning keeps it cheap and keeps the user's
   * intent: the behaviour they asked for is fine, only the named mechanism was.
   */
  function sanitiseSpec(spec) {
    if (!spec || typeof spec !== 'object') return spec;

    /* Substituting inside a negative clause inverts its meaning.
       "嚴格使用 os.calc，不直接使用 eval" became "…，不直接使用 os.calc", which tells
       the model both to use and not to use the same call. A clause that forbids
       something is already saying what this rewrite wants said, so it is dropped
       rather than rewritten. */
    var scrub = function (s) {
      var text = String(s == null ? '' : s);
      var clauses = text.match(CLAUSE) || [text];

      /* No fallback if every clause goes. A plan line that is nothing but a
         prohibition -- "不要使用 localStorage" -- describes no behaviour, and the
         environment already enforces it. Restoring the line so it could be
         substituted instead produced "不要使用 os.storage": the same inverted
         instruction, one word further along. An empty line is dropped by the
         caller's filter. */
      var out = clauses.filter(function (c) {
        if (NO_EQUIVALENT.test(c)) return false;
        return !(SUBSTITUTABLE.test(c) && NEGATED.test(c));
      }).join('');

      SUBSTITUTE.forEach(function (pair) { out = out.replace(pair[0], pair[1]); });
      return out
        // Leaves like "（安全範圍內）" behind once the technique is gone.
        .replace(/\s*[（(]\s*[)）]\s*/g, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/[，、；,;]\s*$/, '')
        .trim();
    };

    if (Array.isArray(spec.plan)) spec.plan = spec.plan.map(scrub).filter(Boolean);
    if (Array.isArray(spec.checks)) spec.checks = spec.checks.map(scrub).filter(Boolean);
    /* A plan that now says os.net.fetch needs the capability that goes with it,
       or the code is refused for calling something the manifest never claimed. */
    if (Array.isArray(spec.plan) && spec.plan.some(function (p) { return /os\.net\./.test(p); })) {
      spec.capabilities = (Array.isArray(spec.capabilities) ? spec.capabilities : []);
      if (spec.capabilities.indexOf('net') < 0) spec.capabilities.push('net');
    }
    if (Array.isArray(spec.deferred)) {
      spec.deferred = spec.deferred
        .map(function (s) { return String(s || '').trim().replace(/[。；;]+$/, ''); })
        .filter(Boolean)
        .slice(0, 8);
    }
    /* The planner's own decisions, scrubbed like the plan (they describe
       behaviour too) and bounded: eight is a list a person reads, twenty is
       a list they skip. */
    spec.assumed = (Array.isArray(spec.assumed) ? spec.assumed : [])
      .map(function (s) { return scrub(String(s || '')).replace(/[。；;]+$/, ''); })
      .filter(Boolean)
      .slice(0, 8);
    if (spec.purpose) spec.purpose = scrub(spec.purpose);
    if (spec.readme) spec.readme = scrub(spec.readme);
    if (spec.size !== 'small' && spec.size !== 'medium' && spec.size !== 'large') spec.size = 'medium';
    /* Packages: a sane name, a sane global, no duplicates, a few at most. */
    var libs = [];
    (Array.isArray(spec.libs) ? spec.libs : []).forEach(function (l) {
      if (!l || typeof l !== 'object') return;
      var name = String(l.name || '').trim().toLowerCase();
      var global = String(l.global || '').trim();
      if (!NPM_NAME.test(name) || !GLOBAL_NAME.test(global)) return;
      if (libs.some(function (x) { return x.name === name; })) return;
      if (libs.length >= MAX_LIBS) return;
      libs.push({ name: name, global: global, why: String(l.why || '').slice(0, 120) });
    });
    spec.libs = libs;
    return spec;
  }

  /**
   * Fetch the packages a spec asks for, and turn the wish into a fact.
   *
   * Each entry comes back either resolved -- {name, version, key, global,
   * hash} for the manifest, and its source for the frame -- or dropped, with
   * the reason said in the log and carried into the code prompt so the model
   * writes the thing itself instead of calling a global that is not there.
   * The fetch is main's (forge:fetchLib), gated as a network request.
   */
  async function prepareLibs(spec, say) {
    var wanted = spec.libs || [];
    var resolved = [];
    var sources = [];
    var missing = [];
    for (var i = 0; i < wanted.length; i++) {
      var want = wanted[i];
      say('　準備套件：' + want.name + '（' + want.global + '）…');
      // eslint-disable-next-line no-await-in-loop
      var r = await A.forge.fetchLib(want.name);
      if (!r || !r.ok) {
        var why = (r && r.error) || '未知原因';
        say('　套件 ' + want.name + ' 拿不到：' + why + '，改用原生 API 實作', 'fg-warn');
        missing.push(want.name + '（' + why + '）');
        continue;
      }
      var rec = r.data;
      // eslint-disable-next-line no-await-in-loop
      var s = await A.forge.libSource(rec.key);
      if (!s || !s.ok) {
        say('　套件 ' + want.name + ' 讀不回來：' + ((s && s.error) || '未知原因'), 'fg-warn');
        missing.push(want.name);
        continue;
      }
      resolved.push({ key: rec.key, name: rec.name, version: rec.version, global: want.global, hash: rec.hash });
      sources.push({ global: want.global, name: rec.name, version: rec.version, source: s.data.source });
      say('　已' + (rec.cached ? '有' : '下載') + ' ' + rec.name + '@' + rec.version + '（' +
        Math.round(rec.bytes / 1024) + ' KB）→ window.' + want.global, 'fg-ok');
    }
    return { resolved: resolved, sources: sources, missing: missing };
  }

  /**
   * Every check a candidate has to pass, syntax first.
   *
   * Parsing comes before the rule checks because a program that does not parse
   * cannot be reasoned about at all -- and because the rule checks are textual, so
   * they happily approve something that will never run. A generated timer went in
   * with `await` inside a function nobody had marked async: it passed, installed,
   * opened, and drew nothing.
   *
   * The self-test is required here rather than in the runtime validator because
   * it is a rule of this forge, not of the sandbox: a program without one is
   * legal to run, it is just not something this build loop can verify.
   */
  async function checkCode(code, capabilities) {
    var out = [];
    var res = await A.forge.checkSyntax(code);
    if (res.ok && res.data && res.data.ok === false) {
      out.push('程式碼無法解析：' + res.data.message +
        (res.data.line ? '（第 ' + res.data.line + ' 行' +
          (res.data.text ? '：' + res.data.text : '') + '）' : ''));
    }
    out = out.concat(AIOS.appshell.validate(code, capabilities));
    if (!/os\.actions\.selfTest\s*=/.test(String(code || ''))) {
      out.push('沒有登記 selfTest 動作（os.actions.selfTest）');
    }
    return out;
  }

  /** Turn "不能用 X" into "不能用 X，改用 Y". */
  function withRemedy(problems, attempt) {
    var out = problems.slice();
    var joined = problems.join(' ');

    if (/eval|new Function/.test(joined)) {
      out.push('算式請改用 await os.calc("(1+2)*3")，它回傳數字。' +
        'eval 與 new Function 兩個都被禁止，換另一個一樣會被拒絕。');
    }
    if (/不能用 fetch|XMLHttpRequest|WebSocket/.test(joined)) {
      out.push('直接的 fetch / XMLHttpRequest / WebSocket 被沙箱的 CSP 擋住。要連網就在 capabilities 宣告 net，' +
        '改用 await os.net.json(url) 或 await os.net.fetch(url, {method, headers, body})；沒有 WebSocket 的替代品，改成定時輪詢。');
    }
    if (/localStorage/.test(joined)) {
      out.push('改用 await os.storage.set(key, value) 與 await os.storage.get(key)。');
    }
    if (/capabilities 沒有宣告/.test(joined)) {
      out.push('兩條路選一條：把缺的能力加進 capabilities，或者不要呼叫那些 API。' +
        '一台計算機通常兩者都不需要 —— os.calc 不用任何能力，' +
        '只有「要記住上次的算式」這種需求才需要 storage。');
    }
    if (/await is only valid|無法解析/.test(joined)) {
      out.push('os 的方法都是 async，所以每個用到 await 的函式自己也要標成 async：' +
        'async function 或 async () => {}。' +
        '事件處理器也一樣：btn.onclick = async () => { await os.calc(...) }。' +
        '如果錯誤在最後幾行，很可能是程式被截斷了：把程式寫完整，補上缺的括號。');
    }
    if (/沒有任何看得見的東西/.test(joined)) {
      out.push('render(root, os) 必須把節點掛進 root 才看得到，' +
        '而且 root 是唯一的容器：append 到 document.body 不算。');
    }
    if (/sandbox 不允許送出表單/.test(joined)) {
      out.push('不要靠 <form> 的 submit 來觸發動作，改成給按鈕 onclick，' +
        '或者呼叫 form.addEventListener("submit", …) 之外再補一個 button 的 click 處理。');
    }
    if (/按下按鈕時發生錯誤|未處理的 Promise/.test(joined)) {
      out.push('每個按鈕的處理器都要能單獨執行：欄位可能是空的、storage 可能還沒有值，' +
        '所以先檢查再用，並且把 await 包在 try/catch 裡。');
    }
    if (/沒有完成 render|卡住/.test(joined)) {
      out.push('render() 裡不要有等不到的 await 或無窮迴圈；' +
        '需要等資料就先畫出空狀態，拿到資料再更新。');
    }
    if (/沒有登記 selfTest/.test(joined)) {
      out.push('在 render() 裡登記 os.actions.selfTest = { desc: "自我測試", args: "{}", ' +
        'run: async function () { …檢查核心行為，不符就 throw…; return "自我測試通過：N 項"; } }。');
    }
    if (/自我測試失敗/.test(joined)) {
      out.push('自我測試失敗代表程式的行為和它自己的檢查對不上。先判斷是程式錯還是測試錯：' +
        '程式的行為符合規格就修正 selfTest 的期望值，否則修程式。' +
        'selfTest 不能等時間（setTimeout / setInterval），也不能等永遠不會 resolve 的 Promise。');
    }
    if (/沒有做到|審查發現/.test(joined)) {
      out.push('把缺的功能補上、把指出的錯誤修掉，不要刪掉已經能用的部分；' +
        '改完之後 selfTest 也要涵蓋修改到的行為。');
    }
    if (/不能存取 parent|不能存取 top/.test(joined)) {
      out.push('程式裡不能出現 parent. 或 top.，那是宿主視窗，沙箱本來就碰不到。' +
        '要指父元素就用 parentNode / parentElement；如果只是變數名稱，改叫 container 或 host。');
    }
    if (/程式碼太長|被截斷/.test(joined)) {
      out.push('把程式寫短：抽出共用函式、去掉重複的段落、樣式用 class 不要逐個元素寫 style；' +
        '功能一項都不能少，但每一項用最直接的寫法。');
    }
    if (attempt >= 2) {
      out.push('這是最後幾次機會：完全不要出現 eval、new Function、fetch、' +
        'XMLHttpRequest、WebSocket、import(、require(、localStorage 這些字。');
    }
    return out;
  }

  var CONTINUE_PROMPT = '你的程式碼還沒寫完就被截斷了。從上一段最後一個字元的下一個字元接著輸出：' +
    '不要重複已經輸出過的內容、不要從頭開始、不要加任何說明或 ``` 圍籬，直接接著寫到程式結束。';

  /**
   * Generate one candidate.
   *
   * Three shapes of request, and the prompt says which:
   *   fresh   -- spec and the original request
   *   modify  -- the installed code and what the user wants changed
   *   repair  -- the previous candidate and what was wrong with it
   * Repair used to be a fresh generation with the complaints appended, which
   * threw away everything the candidate got right and let the next one get
   * different things wrong. Fixing the candidate keeps what worked.
   *
   * A program that outruns the output cap is continued rather than refused. The
   * cap is a property of the provider, not of the program: the cloud defaults sit
   * at 4096 tokens, which is a few hundred lines, and "any program" cannot mean
   * "any program under three hundred lines". finish === 'length' is the signal;
   * the partial answer goes back as the assistant's turn and the model is asked
   * to pick up where it stopped. See stitch() for the seam.
   */
  async function makeCode(spec, ctx, onToken, say) {
    var sys = [
      '你是 AI-OS 的程式設計師。依照規格寫出可以直接執行的 JavaScript。',
      '',
      ENV_DOC,
      '',
      '輸出規則（違反就無法安裝）：',
      '- 只輸出 JavaScript 程式碼本身。',
      '- 不要 markdown 圍籬（不要 ```），不要任何說明文字，不要 JSON 包裝。',
      '- 第一行就開始寫程式。',
      '- 程式碼要完整可執行，不要留 TODO 或省略，不要用「…其餘類似」帶過。',
      '- 錯誤要自己處理：把 await 放在 try/catch 裡，失敗就用 os.ui.toast 告訴使用者。'
    ].join('\n');

    var parts = ['規格：', JSON.stringify(spec, null, 2)];
    if (ctx.libs && ctx.libs.length) {
      parts.push('', '已載入的套件（在你的程式之前執行，直接用全域變數，不要 import / require）：',
        ctx.libs.map(function (l) { return '- window.' + l.global + '　←　' + l.name + '@' + l.version; }).join('\n'));
    }
    if (ctx.missingLibs && ctx.missingLibs.length) {
      parts.push('', '這些套件拿不到，程式裡不能用，改用原生 API 實作：', ctx.missingLibs.map(function (m) { return '- ' + m; }).join('\n'));
    }
    if (ctx.mode === 'repair' && ctx.previousCode) {
      parts.push('', ctx.existing ? '這一版要達成的修改：' : '原始需求：', ctx.request);
      parts.push('', '上一版程式碼：', ctx.previousCode);
      parts.push('', '它有這些問題，請修正：', (ctx.problems || []).map(function (p) { return '- ' + p; }).join('\n'));
      parts.push('', '請輸出修正後的完整程式碼（不是 diff）。沒問題的部分保持原樣，功能一項都不能少。');
    } else if (ctx.previousCode) {
      parts.push('', '目前的程式碼：', ctx.previousCode);
      parts.push('', '使用者要求的修改：', ctx.request);
      parts.push('', '請輸出修改後的完整程式碼，不是 diff。既有功能要保留。');
      if (ctx.problems && ctx.problems.length) {
        parts.push('', '上一次產出的程式碼有這些問題，請一併修正：', ctx.problems.map(function (p) { return '- ' + p; }).join('\n'));
      }
    } else {
      parts.push('', '原始需求：', ctx.request);
      if (ctx.problems && ctx.problems.length) {
        parts.push('', '上一次產出的程式碼有這些問題，這次不要再犯：', ctx.problems.map(function (p) { return '- ' + p; }).join('\n'));
      }
    }
    if (ctx.stage) parts.push('', ctx.stage);

    var messages = [{ role: 'system', content: sys }, { role: 'user', content: parts.join('\n') }];
    var res = await K.complete({
      owner: 'forge',
      messages: messages,
      temperature: 0.25,
      maxTokens: BUILD.CODE_TOKENS,
      onToken: onToken
    });
    K.addSpend(res.spend);

    var text = String(res.text || '');
    var finish = res.finish;
    var cont = 0;
    while (finish === 'length' && cont < BUILD.MAX_CONTINUE) {
      cont++;
      if (say) say('　程式碼超過單次輸出上限，接續輸出（' + cont + '/' + BUILD.MAX_CONTINUE + '）…', 'fg-warn');
      // eslint-disable-next-line no-await-in-loop
      var more = await K.complete({
        owner: 'forge',
        messages: messages.concat([
          { role: 'assistant', content: text },
          { role: 'user', content: CONTINUE_PROMPT }
        ]),
        temperature: 0.2,
        maxTokens: BUILD.CODE_TOKENS,
        onToken: onToken
      });
      K.addSpend(more.spend);
      text = stitch(text, more.text);
      finish = more.finish;
    }
    if (finish === 'length') {
      var cut = new Error('程式碼太長：接續輸出 ' + cont + ' 次之後仍然沒有寫完');
      cut.code = 'ELENGTH';
      throw cut;
    }
    return cleanCode(text);
  }

  /**
   * Join a continuation onto the partial it continues.
   *
   * Asked to continue, a model usually restarts at the line it was cut off in,
   * and sometimes reopens a code fence first. The last non-empty line of the
   * head is the seam: when the tail starts with it, that much of the tail is the
   * head's own line coming back, so only what follows is new. A cut that landed
   * mid-line works the same way, since the partial line is a prefix of the whole
   * one. When the tail starts elsewhere it is appended as it is, and a wrong
   * guess here surfaces as a syntax error, which the loop repairs.
   */
  function stitch(head, tail) {
    var a = String(head || '').replace(/\s*```\s*$/, '');
    var b = String(tail || '').replace(/^\s*```[a-zA-Z]*[ \t]*\r?\n?/, '');
    var lines = a.split('\n');
    var last = '';
    for (var i = lines.length - 1; i >= 0 && !last; i--) last = lines[i].trim();
    var lead = b.replace(/^\s+/, '');
    if (last && lead.indexOf(last) === 0) {
      return a + lead.slice(last.length);
    }
    return a + b;
  }

  /** Models add fences and prose no matter how firmly they are asked not to. */
  function cleanCode(text) {
    var s = String(text || '');
    s = s.replace(/<think>[\s\S]*?<\/think>/g, '');
    var fence = s.match(/```(?:javascript|js)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1];
    else {
      /* An opening fence with no closing one is what a truncated answer looks
         like; the loop will hear about the truncation, but the fence itself
         must not be the reason the candidate fails to parse. */
      s = s.replace(/^\s*```[a-zA-Z]*[ \t]*\r?\n/, '').replace(/\n```\s*$/, '');
    }
    s = s.replace(/^\s*(?:這是|以下是|好的)[^\n]*\n/, '');
    return s.trim();
  }

  /**
   * Read the code against the spec, and say what is missing.
   *
   * The static checks say whether the code is allowed to run and the smoke test
   * says whether it runs; neither says whether it does what was asked. A pinball
   * table shipped that rendered, kept score, and could not be played: the ball
   * fell straight through. That is the failure this pass is for, and it is the
   * one only a reader can find. One call, structured answer, and it is told to
   * say "ok" when there is nothing wrong -- a reviewer that always finds
   * something sends every build through a repair round it did not need.
   */
  async function reviewCode(spec, request, code, onToken) {
    var src = String(code || '');
    if (src.length > 90000) return [];   // more than a reviewer can hold at once
    var sys = [
      '你是程式碼審查員。對照規格與需求，檢查這份 JavaScript 是否把每一項都做到了，',
      '以及有沒有明顯的邏輯錯誤。只列確定的問題，不要挑剔風格、命名或效能。',
      '判斷「有沒有做到」看的是使用者能不能實際用到那個功能：按鈕有沒有接處理器、',
      '處理器有沒有真的改狀態並重畫、算式算得對不對、該存的狀態有沒有存回去、',
      '遊戲有沒有真的能玩（碰撞、得分、結束條件）。',
      '如果 plan 的每一項都做到了、也沒有確定的錯誤，ok 就填 true，missing 與 bugs 留空陣列。',
      '輸出 JSON：{"ok":true|false,"missing":["沒做到的 plan 項目，說明缺在哪"],"bugs":["確定的錯誤，指出在哪個函式"]}'
    ].join('\n');
    var user = ['規格：', JSON.stringify({
      name: spec.name, purpose: spec.purpose, plan: spec.plan, checks: spec.checks, capabilities: spec.capabilities
    }, null, 2), '', '需求：', request, '', '程式碼：', src].join('\n');
    var res = await K.complete({
      owner: 'forge',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          missing: { type: 'array', items: { type: 'string' } },
          bugs: { type: 'array', items: { type: 'string' } }
        },
        required: ['ok']
      },
      schemaName: 'review',
      temperature: 0.2,
      maxTokens: 1400,
      onToken: onToken
    });
    K.addSpend(res.spend);
    var d = res.data || {};
    if (d.ok === true) return [];
    var out = [];
    (Array.isArray(d.missing) ? d.missing : []).slice(0, 5).forEach(function (m) {
      if (String(m || '').trim()) out.push('沒有做到：' + String(m).trim().slice(0, 300));
    });
    (Array.isArray(d.bugs) ? d.bugs : []).slice(0, 4).forEach(function (b) {
      if (String(b || '').trim()) out.push('審查發現錯誤：' + String(b).trim().slice(0, 300));
    });
    return out;
  }

  /* ------------------------------------------------------------ the loop */

  /**
   * Plan items in stages: the first is the core, the rest are increments.
   *
   * Bounded in count as well as in size. A re-planned spec came back with 26
   * items where the first had 13 -- asked for "more specific", the planner
   * split every line -- and four items a stage made that seven stages, each a
   * model call with the whole program as input. Past MAX_STAGES the stages
   * grow instead.
   */
  function splitPlan(plan, per) {
    var items = (plan || []).slice();
    if (!items.length) return [];
    var size = Math.max(1, per || BUILD.PHASE_ITEMS);
    var count = Math.max(1, Math.min(BUILD.MAX_STAGES, Math.ceil(items.length / size)));
    /* Balanced, so a plan of thirteen is 4/3/3/3 rather than 4/4/4/1: a
       one-item last stage is a whole model call, with the whole program as
       input, for one feature. */
    var base = Math.floor(items.length / count);
    var extra = items.length % count;
    var out = [];
    for (var i = 0; i < count; i++) out.push(items.splice(0, base + (i < extra ? 1 : 0)));
    return out;
  }

  /** One line per failed round, for the planner and for the log. */
  function summarise(history) {
    return history.map(function (h) {
      return '第 ' + h.round + ' 輪' + (h.stage ? '（' + h.stage + '）' : '') + '：' +
        h.problems.slice(0, 3).join('；').slice(0, 400);
    });
  }

  /**
   * Generate, check, run, repeat until a candidate works or this stage's share
   * of the budget is gone.
   *
   * Returns { ok, code } or { ok: false, problems, why } where `why` says how
   * it ended: 'stuck' (the same failure twice running -- the model is not going
   * to fix this by being asked a third time, so the caller should change the
   * question), 'toolong' (the program does not fit the output cap even continued,
   * so the caller should build it in stages), or 'budget'.
   *
   * A candidate whose only failing check is its own self-test is remembered on
   * `state.fallback`: it draws, it runs, its buttons work, and only the claim it
   * makes about itself is wrong. If nothing better arrives before the budget
   * ends, that is what gets installed, with the failed claim in the note.
   */
  async function repairLoop(spec, ctx, state, maxRounds, say, onToken) {
    var caps = AIOS.appshell.capsOf(spec.capabilities);
    var problems = ctx.problems || null;
    var previous = ctx.previousCode || null;
    var mode = ctx.mode || 'fresh';
    var rounds = 0;
    var lastKey = null;

    while (rounds < maxRounds) {
      if (state.budget.spent()) return { ok: false, problems: problems || [], why: 'budget' };
      rounds++;
      state.budget.rounds++;
      var round = state.budget.rounds;
      var verb = mode === 'repair' ? '修正程式碼' : mode === 'modify' ? '改寫程式碼' : '產生程式碼';
      say('第 ' + round + ' 輪' + (ctx.label ? '（' + ctx.label + '）' : '') + '：' + verb + '…');
      state.tell({ step: '模型' + verb + '中', round: round, stage: ctx.label || '', streaming: true });

      var code;
      try {
        // eslint-disable-next-line no-await-in-loop
        code = await makeCode(spec, {
          mode: mode, request: ctx.request, previousCode: previous, problems: problems,
          existing: ctx.existing, stage: ctx.stage,
          libs: state.libs && state.libs.sources, missingLibs: state.libs && state.libs.missing
        }, onToken, say);
      } catch (e) {
        state.tell({ streaming: false });
        if (e && e.code === 'ELENGTH') {
          state.history.push({ round: round, stage: '長度', problems: [e.message] });
          say('　' + e.message, 'fg-warn');
          return { ok: false, problems: [e.message], why: 'toolong' };
        }
        throw e;
      }

      state.tell({ step: '靜態檢查', streaming: false });
      // eslint-disable-next-line no-await-in-loop
      var found = await checkCode(code, spec.capabilities);
      var stage = '靜態檢查';
      if (!found.length) {
        say('　通過靜態檢查', 'fg-ok');
        say('　冒煙測試…');
        state.tell({ step: '冒煙測試（在測試框裡跑一遍）' });
        // eslint-disable-next-line no-await-in-loop
        found = await AIOS.appshell.smokeTest(code, caps, state.libs && state.libs.sources);
        stage = '冒煙測試';
        if (!found.length) {
          say('　通過冒煙測試', 'fg-ok');
          return { ok: true, code: code, rounds: rounds };
        }
        var onlySelf = found.every(function (p) { return p.indexOf('自我測試失敗') === 0; });
        if (onlySelf && !state.fallback) state.fallback = { code: code, spec: spec, problems: found.slice() };
      }

      state.history.push({ round: round, stage: stage, problems: found.slice() });
      say('　' + (stage === '靜態檢查' ? '不合規：' : '跑不起來：') + found.join('；'), 'fg-warn');

      var key = found.join('|');
      if (key === lastKey) {
        return { ok: false, problems: found, why: 'stuck' };
      }
      lastKey = key;

      // The next round fixes this candidate rather than starting over.
      problems = withRemedy(found, rounds);
      previous = code;
      mode = 'repair';
    }
    return { ok: false, problems: problems || [], why: 'budget' };
  }

  /**
   * Build one spec, in one go or in stages.
   *
   * Stages are the default for anything beyond a handful of features, not a
   * fallback for programs that will not fit one answer. The user's rule:
   * 「大功能不要一次做完，細分為小步驟逐一完成並自動檢視」 -- a big feature
   * built in one piece is checked once, at the end, and a fault found there
   * sends the whole piece back. The first stage is the core; each later one
   * adds the next few plan items to code that already passed its checks, the
   * way a modification does, and is checked itself before the next begins. A
   * stage that cannot be made to work is skipped and reported, not allowed to
   * take the rest down with it -- a game without its sound effects is still a
   * game. Stages also happen when the planner marked the spec large or a
   * single-shot attempt came back too long even continued.
   *
   * A modification is not staged unless it was too long: its plan lists the
   * whole program, existing features included, and adding those to code that
   * already has them would be stages of nothing.
   */
  async function buildFromSpec(spec, ctx, state, say, onToken) {
    var plan = spec.plan || [];
    var phased = ctx.phased ||
      (!ctx.previousCode && (spec.size === 'large' || plan.length > BUILD.SINGLE_SHOT_ITEMS));

    if (!phased) {
      return repairLoop(spec, ctx, state, BUILD.MAX_ROUNDS, say, onToken);
    }

    var stages = splitPlan(plan, BUILD.PHASE_ITEMS);
    say('　分 ' + stages.length + ' 個階段建置：先做核心，每個階段做完都先檢查再加下一批功能', 'fg-line');
    /* Every stage is at least one generation, so a staged build is granted
       that many rounds on top of the base budget: ten rounds shared by seven
       stages would skip the last ones before they were tried once. Repairs
       still draw on the base budget. */
    state.budget.extra = Math.max(state.budget.extra, stages.length);
    var code = ctx.previousCode || null;
    var done = [];
    var skipped = [];
    var lastProblems = [];

    for (var i = 0; i < stages.length; i++) {
      var items = stages[i];
      var label = '第 ' + (i + 1) + '/' + stages.length + ' 階段';
      state.tell({ stage: label, step: items.join('；').slice(0, 60) });
      var stageSpec = Object.assign({}, spec, {
        plan: items,
        stage: label,
        alreadyBuilt: done.slice(),
        comingLater: plan.slice(done.length + items.length)
      });
      var stageCtx = i === 0 && !code
        ? {
          mode: 'fresh', request: ctx.request, label: label,
          stage: '分階段建置：這一階段只做規格 plan 列出的這幾項，但架構要留給 comingLater 那些功能擴充。' +
            'selfTest 只測這一階段做的行為。'
        }
        : {
          mode: 'modify', request: '在現有程式碼上加入這些功能：' + items.join('；') + '。既有功能保持不變。',
          previousCode: code, existing: true, label: label,
          stage: '分階段建置：alreadyBuilt 是已經做好的，這一階段加上 plan 這幾項；selfTest 要一併涵蓋新功能。'
        };
      // eslint-disable-next-line no-await-in-loop
      var r = await repairLoop(stageSpec, stageCtx, state, BUILD.STEP_ROUNDS, say, onToken);
      if (r.ok) {
        code = r.code;
        done = done.concat(items);
        say('　' + label + '完成', 'fg-ok');
        continue;
      }
      lastProblems = r.problems || [];
      if (!code) {
        // The core itself did not come together; there is nothing to add to.
        return { ok: false, problems: lastProblems, why: r.why };
      }
      skipped = skipped.concat(items);
      say('　' + label + '沒做成，跳過：' + items.join('；'), 'fg-warn');
      if (state.budget.spent()) break;
    }
    if (!code) return { ok: false, problems: lastProblems, why: 'budget' };
    return { ok: true, code: code, deferred: skipped };
  }

  /**
   * Build a program, and keep building until it works or the budget is spent.
   *
   * This is the loop the whole feature hangs on. The order of escalation:
   *
   *   1. repair    -- a failing candidate is fixed, with the complaint and a
   *                   remedy (repairLoop)
   *   2. re-plan   -- the same failure twice, or a program that will not fit,
   *                   sends the spec back with the history (makeSpec 'replan')
   *   3. stages    -- a program too large for one answer is built in increments
   *                   (buildFromSpec)
   *   4. simplify  -- when re-planning did not help, ask for the smallest
   *                   version that certainly builds, and say what was left out
   *   5. review    -- a candidate that runs is read against the spec, and gaps
   *                   go round once more (reviewCode)
   *   6. fallback  -- when the budget ends, the best candidate that ran is
   *                   installed with its shortfall in the note, rather than
   *                   nothing being installed at all
   *
   * Returns { code, spec, caps, notes, deferred, rounds, seconds } or throws
   * with a report of every round when there is nothing installable.
   */
  async function buildProgram(opts) {
    var request = String(opts.request || '');
    var say = opts.say || function () {};
    var existing = opts.existing || null;
    var t0 = Date.now();
    /* The caller's stop button. Checked wherever the loop would start another
       round, and before anything is installed: a cancelled build installs
       nothing, not even its best candidate. */
    var cancelled = typeof opts.cancelled === 'function' ? opts.cancelled : function () { return false; };
    function stopped() {
      var err = new Error('已中止建置');
      err.code = 'ECANCEL';
      return err;
    }
    var state = {
      budget: {
        rounds: 0,
        replans: 0,
        extra: 0,        // rounds granted on top, one per stage of a staged build
        spent: function () {
          if (cancelled()) return true;
          return this.rounds >= BUILD.MAX_ROUNDS + this.extra || Date.now() - t0 > BUILD.MAX_MINUTES * 60000;
        },
        why: function () {
          if (cancelled()) return '已被中止';
          return this.rounds >= BUILD.MAX_ROUNDS + this.extra
            ? '已用完 ' + (BUILD.MAX_ROUNDS + this.extra) + ' 輪的額度'
            : '已超過 ' + BUILD.MAX_MINUTES + ' 分鐘';
        }
      },
      history: [],
      fallback: null,
      libs: null,     // { resolved, sources, missing } once the spec's libs are fetched
      tell: null      // progress, below
    };
    var notes = [];

    /* What is happening right now, for whoever is watching.

       A build is minutes of the machine working with nothing on screen but
       the last log line, and a model in a deep thinking mode can go a minute
       without emitting a token. The log says what was *done*; this says what
       is being done, how long it has been at it, and whether anything has
       arrived -- the difference between 「還在跑」 and 「當機了」. Every model
       call marks itself streaming and every token bumps the clock, so the
       watcher can say 「等了 50 秒，模型還在想」 rather than nothing. */
    var status = {
      phase: '', step: '', stage: '', round: 0, streaming: false,
      chars: 0, thinkingChars: 0, lastTokenAt: 0, stepAt: t0, startedAt: t0, done: false
    };
    var onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : function () {};
    function tell(patch) {
      if (patch.step !== undefined || patch.phase !== undefined) {
        status.stepAt = Date.now();
        status.chars = 0;
        status.thinkingChars = 0;
        status.lastTokenAt = 0;
      }
      Object.assign(status, patch);
      onStatus(status);
    }
    state.tell = tell;
    /** A token callback that also keeps the status honest about what arrived. */
    function tokenWatch(inner) {
      return function (piece, thinking) {
        var n = String(piece || '').length;
        if (thinking) status.thinkingChars += n; else status.chars += n;
        status.lastTokenAt = Date.now();
        onStatus(status);
        if (inner) inner(piece, thinking);
      };
    }
    var onCode = tokenWatch(opts.onCodeToken);

    /* 0. The line. Unambiguous requests for the machine outside the sandbox
       are refused before a model is asked; the planner judges the rest. */
    var outside = screenRequest(request);
    if (outside) {
      say('　不能建置：' + outside, 'fg-err');
      var no = new Error(outside);
      no.code = 'EREFUSED';
      throw no;
    }

    /* 1. The spec. A planner that cannot answer once is asked again before the
       build is declared impossible; a truncated plan is a plan that was too
       long, which the second ask is told. */
    var spec = opts.spec || null;
    if (!spec) {
      say('1/5　規劃規格…');
      tell({ phase: '1/5 規劃規格', step: '模型在把需求補完整、寫規格', streaming: true });
      var specLine = say('', 'fg-stream');
      var acc = '';
      var onSpec = tokenWatch(function (piece, thinking) {
        if (thinking || !specLine) return;
        acc += piece;
        var m = acc.match(/"purpose"\s*:\s*"((?:[^"\\]|\\.)*)/);
        specLine.textContent = m ? m[1] : '思考中…';
      });
      for (var tries = 0; !spec; tries++) {
        try {
          // eslint-disable-next-line no-await-in-loop
          spec = await makeSpec(request, existing, onSpec);
        } catch (e) {
          if (cancelled()) throw stopped();
          if (tries >= 1) throw e;
          say('　規劃失敗：' + (e.message || e) + '，再規劃一次', 'fg-warn');
          acc = '';
        }
      }
      tell({ streaming: false });
      /* The planner's judgement. A request for something the program will
         never be able to do is refused here with the reason, rather than built
         into something that quietly cannot do it. */
      if (spec.feasible === false) {
        var why = String(spec.refusal || '').trim() ||
          '這個需求要碰電腦上沙箱以外的資源，生成的程式做不到。';
        if (specLine) {
          specLine.textContent = (spec.name ? spec.name + '　' : '') + '不能建置';
          specLine.className = 'fg-line fg-err';
        }
        say('　不能建置：' + why, 'fg-err');
        var refused = new Error(why);
        refused.code = 'EREFUSED';
        throw refused;
      }
      if (specLine) {
        specLine.textContent = spec.name + '　' + spec.purpose;
        specLine.className = 'fg-line fg-ok';
      }
      announceSpec(spec, say);
    }

    /* 1b. What the machine lacks, fetched: the packages the plan named. A
       package that cannot be had is dropped from the spec and named in the
       code prompt, so the program is written without it rather than around a
       global that will not exist. */
    if ((spec.libs || []).length) {
      tell({ phase: '1/5 準備套件', step: '從 npm 下載並檢查：' + spec.libs.map(function (l) { return l.name; }).join('、') });
      state.libs = await prepareLibs(spec, say);
      spec.libs = state.libs.resolved.map(function (l) { return { name: l.name, global: l.global, version: l.version }; });
      if (state.libs.missing.length) notes.push('拿不到的套件改用原生實作：' + state.libs.missing.join('；').slice(0, 200));
    }

    var ctx = {
      mode: existing ? 'modify' : 'fresh',
      request: request,
      previousCode: opts.previousCode || null,
      existing: !!existing
    };

    /* 2–4. Build, and change the question when the answer keeps failing. */
    var result = null;
    var simplified = false;
    for (;;) {
      say('2/5　產生程式碼');
      tell({ phase: '2/5 產生程式碼', step: '', stage: '', round: 0 });
      var result0;
      try {
        // eslint-disable-next-line no-await-in-loop
        result0 = await buildFromSpec(spec, ctx, state, say, onCode);
      } catch (e) {
        if (cancelled()) throw stopped();
        throw e;
      }
      result = result0;
      if (result.ok) break;
      if (state.budget.spent()) {
        say('　' + state.budget.why(), 'fg-warn');
        break;
      }

      var failures = summarise(state.history);
      if (result.why === 'toolong' && !ctx.phased) {
        say('　程式一次寫不完，改成分階段建置', 'fg-warn');
        ctx.phased = true;
        continue;
      }
      if (state.budget.replans < BUILD.MAX_REPLANS) {
        state.budget.replans++;
        say('3/5　重新規劃（第 ' + state.budget.replans + ' 次）：' +
          (result.why === 'stuck' ? '同樣的問題連續出現兩次' : '這條路走不通'), 'fg-warn');
        tell({ phase: '3/5 重新規劃（第 ' + state.budget.replans + ' 次）', step: '模型帶著失敗紀錄改規格', stage: '', round: 0, streaming: true });
        var replanLine = say('', 'fg-stream');
        try {
          // eslint-disable-next-line no-await-in-loop
          spec = await makeSpec(request, existing, tokenWatch(function (piece, thinking) {
            if (!thinking && replanLine) replanLine.textContent = '規劃中…';
          }), { mode: 'replan', previous: spec, failures: failures });
        } catch (e) {
          say('　重新規劃失敗：' + (e.message || e), 'fg-warn');
          if (replanLine) replanLine.remove();
          break;
        }
        tell({ streaming: false });
        if (replanLine) { replanLine.textContent = '新規格：' + (spec.plan || []).length + ' 項'; replanLine.className = 'fg-line fg-ok'; }
        announceSpec(spec, say);
        ctx.previousCode = opts.previousCode || null;
        continue;
      }
      if (!simplified) {
        simplified = true;
        say('3/5　縮減規格：只留一定做得出來的核心，其餘列為之後再加', 'fg-warn');
        tell({ phase: '3/5 縮減規格', step: '模型只留一定做得出來的核心', stage: '', round: 0, streaming: true });
        try {
          // eslint-disable-next-line no-await-in-loop
          spec = await makeSpec(request, existing, tokenWatch(null), { mode: 'simplify', previous: spec, failures: failures });
        } catch (e) {
          say('　縮減失敗：' + (e.message || e), 'fg-warn');
          break;
        }
        tell({ streaming: false });
        announceSpec(spec, say);
        ctx.previousCode = opts.previousCode || null;
        ctx.phased = false;
        continue;
      }
      break;
    }

    var code = result && result.ok ? result.code : null;
    var deferred = (spec.deferred || []).concat((result && result.deferred) || []);

    if (cancelled()) throw stopped();

    /* 6. Nothing passed. Install what ran, or say why nothing will be. */
    if (!code) {
      if (state.fallback) {
        say('　沒有版本完全通過，安裝最接近的一版（它自己的測試沒過）', 'fg-warn');
        code = state.fallback.code;
        spec = state.fallback.spec;
        notes.push('自我測試沒有通過：' + state.fallback.problems.join('；').slice(0, 300));
      } else {
        var report = summarise(state.history);
        var err = new Error('試了 ' + state.budget.rounds + ' 輪' +
          (state.budget.replans ? '、重新規劃 ' + state.budget.replans + ' 次' : '') +
          '仍然做不出能跑的程式。' +
          (report.length ? '每一輪的問題：\n' + report.join('\n') : ''));
        err.code = 'EBUILD';
        err.history = state.history;
        throw err;
      }
    } else if (!state.budget.spent()) {
      /* 5. It runs. Does it do what was asked? */
      say('4/5　審查…');
      tell({ phase: '4/5 審查', step: '模型對照規格讀一遍程式碼', stage: '', round: 0, streaming: true });
      var gaps = [];
      try {
        gaps = await reviewCode(spec, request, code, tokenWatch(null));
      } catch (e) {
        say('　審查沒有完成：' + (e.message || e) + '，沿用通過測試的版本', 'fg-warn');
      }
      tell({ streaming: false });
      if (gaps.length) {
        say('　審查發現：' + gaps.join('；'), 'fg-warn');
        var fixed = await repairLoop(spec, {
          mode: 'repair', request: request, previousCode: code, problems: withRemedy(gaps, 1),
          existing: ctx.existing, label: '依審查修正'
        }, state, BUILD.REVIEW_ROUNDS, say, onCode);
        if (fixed.ok) {
          code = fixed.code;
          say('　已依審查修正', 'fg-ok');
        } else {
          say('　審查提到的問題沒能修好，沿用審查前的版本', 'fg-warn');
          notes.push('審查指出但沒能修好：' + gaps.join('；').slice(0, 300));
        }
      } else {
        say('　審查通過', 'fg-ok');
      }
    }

    if (deferred.length) notes.push('這一版沒做：' + deferred.join('；').slice(0, 300));

    var seconds = Math.round((Date.now() - t0) / 1000);
    say('　共 ' + state.budget.rounds + ' 輪' +
      (state.budget.replans ? '、重新規劃 ' + state.budget.replans + ' 次' : '') +
      '，' + seconds + ' 秒', 'fg-line');
    tell({ phase: '', step: '', streaming: false, done: true });

    return {
      code: code,
      spec: spec,
      caps: AIOS.appshell.capsOf(spec.capabilities),
      libs: state.libs ? state.libs.resolved : [],
      notes: notes,
      deferred: deferred,
      rounds: state.budget.rounds,
      replans: state.budget.replans,
      seconds: seconds
    };
  }

  /* ------------------------------------------------------ progress words */

  function mmss(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  /**
   * One line that says what the build is doing right now.
   *
   * `short` is the menu-bar form: phase, round and clock. The long form adds
   * the stage, the step, and -- the part that matters -- what has arrived
   * from the model and how long since: a count going up is proof of life, a
   * silence with a number on it is explained rather than left to look like a
   * hang. Above 45 s the line says so in words, because a Max thinking mode
   * genuinely takes that long and a person who does not know that closes the
   * window.
   */
  function statusLine(st, now, short) {
    if (!st || st.done) return '';
    now = now || Date.now();
    var parts = [];
    if (st.phase) parts.push(st.phase);
    if (!short && st.stage) parts.push(st.stage);
    if (st.round) parts.push('第 ' + st.round + ' 輪');
    if (!short && st.step) parts.push(st.step);
    if (!short && st.streaming) {
      var silent = Math.round((now - (st.lastTokenAt || st.stepAt || st.startedAt)) / 1000);
      if (st.chars) parts.push('已收到 ' + st.chars.toLocaleString() + ' 字元');
      else if (st.thinkingChars) parts.push('模型思考中，' + st.thinkingChars.toLocaleString() + ' 字');
      else parts.push('等模型回應');
      if (silent >= 8) {
        parts.push((st.lastTokenAt ? '上一個字元是 ' + silent + ' 秒前' : '已等 ' + silent + ' 秒') +
          (silent >= 45 ? '——還在進行，思考模式深的時候一兩分鐘沒輸出是正常的' : ''));
      }
    }
    parts.push((short ? '' : '共 ') + mmss(now - st.startedAt));
    return parts.join(' · ');
  }

  /* The menu-bar chip: visible only while something is being built, so a
     person who has App Forge behind four windows still sees the machine at
     work, and can click through to it. */
  var chip = null;
  var chipOpen = null;
  function chipStatus(text, title, open) {
    if (!chip) {
      chip = document.getElementById('s-forge');
      if (!chip) return;
      chip.addEventListener('click', function () { if (chipOpen) chipOpen(); });
    }
    chipOpen = open || null;
    if (!text) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.querySelector('b').textContent = text;
    chip.title = title || '';
  }

  function announceSpec(spec, say) {
    var caps = AIOS.appshell.capsOf(spec.capabilities);
    say('　能力：' + (caps.length ? caps.join('、') : '無') +
      (spec.size === 'large' ? '　規模：大（分階段建置）' : '') +
      ((spec.libs || []).length ? '　套件：' + spec.libs.map(function (l) { return l.name; }).join('、') : ''));
    (spec.plan || []).slice(0, 12).forEach(function (p) { say('　· ' + p); });
    if ((spec.plan || []).length > 12) say('　· …共 ' + spec.plan.length + ' 項');
    /* The decisions made for the person, said as such: what a one-line
       request left out and the planner filled in. Not warnings -- they are
       the program being complete -- but a list to disagree with. */
    if (spec.assumed && spec.assumed.length) {
      say('　補上你沒說、但通常需要的（不合意可以在程式的對話面板說要改）：', 'fg-line');
      spec.assumed.forEach(function (a) { say('　　＋ ' + a, 'fg-line'); });
    }
    if (spec.deferred && spec.deferred.length) {
      say('　這一版先不做：' + spec.deferred.slice(0, 5).join('；').slice(0, 240) +
        (spec.deferred.length > 5 ? '…（共 ' + spec.deferred.length + ' 項）' : ''), 'fg-warn');
    }
  }

  /* ------------------------------------------------------ app registration */

  /**
   * Make an installed app launchable, with its own chat panel wired to rebuild.
   *
   * The launcher renders once when it opens, so it is repainted here rather than
   * at each of the seven call sites: installing an app left the list without it,
   * and uninstalling left the list with it -- still clickable, onto a load the main
   * process had already revoked.
   */
  /* The Forge window keeps its own copy of the installed list and the tiles
     are drawn from it, so an approval made in a program's window left the tile
     dark and labelled 已被改動 until App Forge was closed and reopened. */
  function refreshForgeList() {
    AIOS.apps.instances().forEach(function (inst) {
      if (inst.def && inst.def.id === 'forge' && inst.ctrl && inst.ctrl.api && inst.ctrl.api.refresh) {
        try { inst.ctrl.api.refresh(); } catch (e) { /* the list is cosmetic */ }
      }
    });
    if (AIOS.launcher && AIOS.launcher.refresh) AIOS.launcher.refresh();
  }

  /** Of these capabilities, the ones the machine stops a person to ask about. */
  async function capsReachingOut(caps) {
    if (!caps || !caps.length) return [];
    try {
      var sys = await A.sysInfo();
      var needs = (sys && sys.ok && sys.data.appCapsNeedingConsent) || [];
      return caps.filter(function (c) { return needs.indexOf(c) >= 0; });
    } catch (e) { return []; }
  }

  function registerGenerated(meta) {
    var out = AIOS.apps.redefine({
      id: 'gen:' + meta.id,
      name: meta.name,
      icon: meta.icon || '◈',
      kind: 'APP',
      width: 620,
      height: 460,
      generated: true,
      slug: meta.id,
      purpose: meta.purpose,

      /* One window, because there is exactly one box of state behind it.
         A generated program keeps its data in `aios.app.<slug>` and writes it
         the way generated programs do -- hold the whole list in memory, save the
         whole list on every change. Two windows are therefore two divergent
         copies with no way to reconcile: measured on 購物清單, adding an item in
         each window left only the second one's, and the first was discarded with
         no error anywhere. Nothing here can fix that from the outside -- the
         broker re-reads before every set, and it is the program's own list that
         goes stale -- so the second window must not exist.

         These apps also open no documents (`accepts` is false below), so a
         second window could never be showing something different anyway. */
      singleton: true,
      chatHint: '這個程式是核心自己寫的。想改它就直接說，例如「加一個匯出按鈕」' +
                '或「排序方式改成按日期」。每次修改都會存成新版本，可以回滾。',

      accepts: function () { return false; },

      /* The program's own actions are merged in at mount, once the frame has
         said what it publishes. These three are the ones every generated app
         has whatever it contains. */
      actions: {
        run: {
          args: '{action, args}',
          desc: '執行這個程式自己發布的動作（不給 action 就列出有哪些）',
          run: async function (args, ctx) {
            return { note: await ctx.api.runAction(args.action, args.args) };
          }
        },
        modify: {
          args: '{request}', desc: '依照要求改寫這個程式（會建立新版本）',
          run: async function (args, ctx) {
            var note = await ctx.api.rebuild(String(args.request || ''));
            return { note: note };
          }
        },
        reload: {
          args: '{}', desc: '重新載入程式',
          run: async function (_a, ctx) { await ctx.api.reload(); return { note: '已重新載入' }; }
        },
        rollback: {
          args: '{version}', desc: '回滾到某個版本',
          run: async function (args, ctx) {
            var note = await ctx.api.rollback(Number(args.version));
            return { note: note };
          }
        }
      },

      mount: function (ctx) {
        ctx.body.classList.add('flush');

        var slug = meta.id;
        var frame = null;
        var frameToken = null;
        var detach = null;
        var loaded = null;
        var errors = [];
        var ready = false;
        var building = false;

        /* Runtime errors are handed back to the model on their own, up to this
           many times per load. The cap is what keeps a fault the model cannot
           fix from becoming a loop that spends money: after two tries the
           button is still there, and a person decides. */
        var AUTO_REPAIRS = 2;
        var autoRepair = true;
        var autoRepairs = 0;
        var repairTimer = 0;

        var bar = el('div', 'gen-bar');
        var ver = el('span', 'gen-ver', '');
        var btnReload = el('button', 'fbtn', '↻');
        btnReload.type = 'button'; btnReload.title = '重新載入';
        var btnCode = el('button', 'fbtn', '看程式碼');
        btnCode.type = 'button';
        var btnHist = el('button', 'fbtn', '版本');
        btnHist.type = 'button';
        var btnDoc = el('button', 'fbtn', '說明');
        btnDoc.type = 'button';
        [ver, btnReload, btnCode, btnHist, btnDoc].forEach(function (n) { bar.appendChild(n); });
        ctx.body.appendChild(bar);

        var host = el('div', 'gen-host');
        ctx.body.appendChild(host);

        var errBox = el('div', 'gen-errors');
        errBox.hidden = true;
        ctx.body.appendChild(errBox);

        A.forge.installPrefs().then(function (r) {
          if (r && r.ok && typeof r.data.autoRepair === 'boolean') autoRepair = r.data.autoRepair;
        }).catch(function () {});

        function showErrors(status) {
          errBox.innerHTML = '';
          errBox.hidden = !errors.length && !status;
          if (errBox.hidden) return;
          if (errors.length) {
            errBox.appendChild(el('strong', null, '程式回報了錯誤：'));
            errors.slice(-4).forEach(function (e) { errBox.appendChild(el('div', 'gen-err-line', e)); });
          }
          if (status) {
            errBox.appendChild(el('div', 'gen-err-line gen-err-status', status));
            return;
          }
          var fix = el('button', 'fbtn', '請核心修掉');
          fix.type = 'button';
          fix.addEventListener('click', function () {
            rebuild('程式執行時出現這些錯誤，請修好：\n' + errors.slice(-4).join('\n'));
          });
          errBox.appendChild(fix);
        }

        /**
         * A runtime error, a moment later, becomes a rebuild -- without waiting
         * for the button. Debounced, because the first error is rarely alone:
         * a broken draw() throws once per frame, and the model should be sent
         * the set, not the first one.
         */
        function scheduleAutoRepair() {
          if (!autoRepair || building || autoRepairs >= AUTO_REPAIRS) return;
          if (!AIOS.state.connected) return;
          clearTimeout(repairTimer);
          repairTimer = setTimeout(async function () {
            if (building || !errors.length || autoRepairs >= AUTO_REPAIRS) return;
            autoRepairs++;
            var n = autoRepairs;
            var lines = [];
            showErrors('核心正在自動修復（第 ' + n + '/' + AUTO_REPAIRS + ' 次）…');
            var note = await rebuild('程式執行時出現這些錯誤，請修好：\n' + errors.slice(-4).join('\n'), {
              auto: true,
              say: function (text) {
                lines.push(text);
                if (!errBox.hidden) showErrors('自動修復（第 ' + n + '/' + AUTO_REPAIRS + ' 次）：' + String(text || '').trim());
              }
            });
            ctx.toast(note, /失敗|沒有|無法/.test(note) ? 't-warn' : 't-ok');
            if (errors.length) showErrors();
          }, 1500);
        }

        /* Version, granted capabilities, and whether render() actually ran. */
        function stamp() {
          if (!loaded) { ver.textContent = ''; return; }
          ver.textContent = 'v' + (loaded.manifest.version || 1) +
            (loaded.capabilities && loaded.capabilities.length
              ? '　能力：' + loaded.capabilities.join('、')
              : '　無額外能力') +
            (loaded.libs && loaded.libs.length
              ? '　套件：' + loaded.libs.map(function (l) { return l.name + '@' + l.version; }).join('、')
              : '') +
            (ready ? '　執行中' : '　載入中…');
          ver.className = 'gen-ver' + (ready ? ' gen-ver-ready' : '');
        }

        async function load() {
          host.innerHTML = '';
          errors = [];
          ready = false;
          clearTimeout(repairTimer);
          showErrors();

          var res = await A.forge.load(slug);
          if (!res.ok) {
            host.appendChild(el('p', 'app-error', '載入失敗：' + res.error));
            return;
          }
          var d = res.data;

          if (d.ok === false) {
            // Integrity failure: the file on disk is not what was approved.
            var warn = el('div', 'gen-integrity');
            warn.appendChild(el('h3', null, '程式碼和核准過的版本不符'));
            warn.appendChild(el('p', null,
              'app.js 被改過了（核准 ' + d.expected + '…，現在 ' + d.actual + '…）。' +
              '核心不會執行沒核准過的程式碼，因為「能寫檔案」不該等於「能安裝會執行的程式」。'));
            /* What approving grants, said before the button. The grant follows
               the code: the manifest beside it is what gets approved, so a
               capability it added is named here -- and one that reaches out
               is named louder. */
            var pend = d.pendingCapabilities || [];
            var cur = d.capabilities || [];
            var added = pend.filter(function (c) { return cur.indexOf(c) < 0; });
            var dropped = cur.filter(function (c) { return pend.indexOf(c) < 0; });
            warn.appendChild(el('p', 'gen-integrity-caps',
              '這份程式碼的 manifest 宣告的能力：' + (pend.length ? pend.join('、') : '無') +
              (added.length ? '　新增：' + added.join('、') : '') +
              (dropped.length ? '　移除：' + dropped.join('、') : '') +
              '。核准就是授予這份清單。'));
            var reaching = await capsReachingOut(added);
            if (reaching.length) {
              warn.appendChild(el('p', 'gen-integrity-warn',
                '⚠ 新增的 ' + reaching.join('、') + ' 會讓它讀到或送出你的資料。不是你改的就不要核准。'));
            }
            var pre = el('pre', 'fenced', String(d.pendingCode || '').slice(0, 4000));
            warn.appendChild(pre);
            var ok = el('button', 'fbtn fbtn-primary', '我看過了，核准這份程式碼' + (pend.length ? '並授予這些能力' : ''));
            ok.type = 'button';
            ok.addEventListener('click', async function () {
              var r = await A.forge.approve(slug);
              if (!r.ok) { ctx.toast('核准失敗：' + r.error, 't-err'); return; }
              ctx.toast('已核准新的程式碼' + (r.data.capabilities.length ? '，授予：' + r.data.capabilities.join('、') : ''), 't-ok');
              refreshForgeList();
              load();
            });
            warn.appendChild(ok);
            host.appendChild(warn);
            return;
          }

          loaded = d;
          ready = false;
          stamp();

          /* Approved code whose manifest asks for more than the index grants:
             the state an approval left behind before it learned to read the
             manifest. The program is about to be refused its own calls, so
             say so, with the one click that fixes it. */
          var want = d.manifestCaps || [];
          var have = d.capabilities || [];
          var missing = want.filter(function (c) { return have.indexOf(c) < 0; });
          var extra = have.filter(function (c) { return want.indexOf(c) < 0; });
          if (missing.length || extra.length) {
            var gap = el('div', 'gen-capgap');
            gap.appendChild(el('span', null,
              'manifest 宣告的能力（' + (want.length ? want.join('、') : '無') + '）和已授予的（' +
              (have.length ? have.join('、') : '無') + '）不同' +
              (missing.length ? '，程式會被拒絕使用 ' + missing.join('、') : '') + '。'));
            var fix = el('button', 'fbtn', '重新核准，授予 manifest 宣告的能力');
            fix.type = 'button';
            fix.addEventListener('click', async function () {
              var r = await A.forge.approve(slug);
              if (!r.ok) { ctx.toast('重新核准失敗：' + r.error, 't-err'); return; }
              ctx.toast('已重新核准，授予：' + (r.data.capabilities.join('、') || '無'), 't-ok');
              refreshForgeList();
              load();
            });
            gap.appendChild(fix);
            host.appendChild(gap);
          }

          if (detach) { detach(); detach = null; }

          frame = document.createElement('iframe');
          frame.className = 'gen-frame';
          /* No allow-same-origin: the frame gets an opaque origin and cannot
             reach this document, which is the entire security model here.

             allow-forms, on the other hand, has to be here. A <form> with a
             submit button is how anyone writes an input UI, and without this
             Chromium refuses the submission before the event is dispatched --
             so the handler never runs. Measured on a generated ledger: the app
             rendered, reported "執行中", and pressing its only button logged
             "Blocked form submission ... the 'allow-forms' permission is not
             set" and did nothing. Passing the checks and then not working is
             the worst shape a failure takes, and this one was invisible from
             the outside.

             It grants no reach: frameHtml pins form-action 'none', so a handler
             that forgets preventDefault still navigates nowhere, and the opaque
             origin is untouched either way.

             Taken from appshell so the smoke test that approved this program ran
             in the same frame it is about to run in. */
          frame.setAttribute('sandbox', AIOS.appshell.FRAME_SANDBOX);
          frame.setAttribute('title', meta.name);

          // The program's pinned libraries, from main, which refuses a file
          // whose hash drifted from the record.
          var libs = [];
          try {
            libs = await AIOS.appshell.loadLibs(d.libs || []);
          } catch (e) {
            host.appendChild(el('p', 'app-error', '無法載入程式的套件：' + (e.message || e)));
            return;
          }

          // Served from aios-app:// rather than set as srcdoc. A srcdoc frame
          // inherits this document's CSP, and this document allows only
          // script-src 'self', so the app's own inline bootstrap was silently
          // blocked and nothing ever rendered. See main/forge.js.
          var pub = await A.forge.frame(slug, AIOS.appshell.frameHtml(d.code, libs));
          if (!pub.ok) {
            host.appendChild(el('p', 'app-error', '無法載入程式頁面：' + pub.error));
            return;
          }
          if (frameToken) A.forge.frameRevoke(frameToken);
          frameToken = pub.data.token;
          frame.src = pub.data.url;
          host.appendChild(frame);

          detach = AIOS.appshell.broker(frame, {
            id: slug,
            name: d.manifest.name || meta.name,
            purpose: d.manifest.purpose || meta.purpose,
            capabilities: d.capabilities || []
          }, ctx);

          ctx.setTitle(d.manifest.name || meta.name);
        }

        /**
         * Rebuild against the current source. The same loop as a first build:
         * the modification is planned, coded, checked, run, reviewed, and
         * repaired until it works or the budget says stop. It used to skip the
         * smoke test and the review, so a modification could install a program
         * that no longer ran.
         */
        async function rebuild(request, opts) {
          opts = opts || {};
          if (!request) return '沒有說要改什麼';
          if (!AIOS.state.connected) return '模型沒有連線，無法改寫';
          if (building) return '正在改寫中，請等這一次做完';
          building = true;

          if (!opts.auto) ctx.toast('重新產生程式碼中…');
          var chat = ctx.win && AIOS.apps.instanceFor(ctx.win);
          var say = opts.say
            ? opts.say
            : chat && chat.chat ? chat.chat.say.bind(chat.chat) : function () {};

          /* The status line of this window carries the progress, and the
             menu-bar chip carries it everywhere else, ticking every second. */
          var progress = null;
          var tick = null;
          function showProgress() {
            var now = Date.now();
            var text = statusLine(progress, now, false);
            if (text) {
              ver.textContent = '改寫中 · ' + text;
              ver.className = 'gen-ver gen-ver-building';
            } else {
              stamp();
            }
            chipStatus(statusLine(progress, now, true), text ? '改寫「' + meta.name + '」：' + text + '\n點一下回到程式' : '',
              function () { if (ctx.win) { AIOS.wm.restore(ctx.win); AIOS.wm.focus(ctx.win); } });
          }
          var lastPhase = '';

          try {
            var currentSpec = {
              name: loaded && loaded.manifest.name || meta.name,
              icon: loaded && loaded.manifest.icon || meta.icon,
              purpose: loaded && loaded.manifest.purpose || meta.purpose,
              capabilities: (loaded && loaded.capabilities) || [],
              libs: ((loaded && loaded.libs) || []).map(function (l) { return { name: l.name, global: l.global }; })
            };
            var built = await buildProgram({
              request: request,
              existing: currentSpec,
              previousCode: loaded && loaded.code,
              say: say,
              onStatus: function (st) {
                progress = st;
                if (!tick) tick = setInterval(showProgress, 1000);
                showProgress();
                if (st.phase && st.phase !== lastPhase) {
                  lastPhase = st.phase;
                  ctx.toast('改寫：' + st.phase, 't-info');
                }
              }
            });

            var res = await A.forge.install({
              slug: slug,
              name: built.spec.name || currentSpec.name,
              purpose: built.spec.purpose || currentSpec.purpose,
              icon: built.spec.icon || currentSpec.icon,
              code: built.code,
              capabilities: built.caps,
              libs: built.libs,
              prompt: request,
              note: ((built.spec.plan || []).join('；') +
                (built.notes.length ? '　⚠ ' + built.notes.join('；') : '')).slice(0, 400),
              author: 'model'
            });
            if (!res.ok) return '安裝失敗：' + res.error;

            meta.name = res.data.manifest.name;
            meta.purpose = res.data.manifest.purpose;
            meta.icon = res.data.manifest.icon;
            registerGenerated(meta);
            await AIOS.afterFsChange();
            await load();
            return '已建立 v' + res.data.version + '，並重新載入' +
              (built.notes.length ? '（' + built.notes.join('；') + '）' : '');
          } catch (e) {
            if (e && e.code === 'EREFUSED') return '無法改成那樣：' + (e.message || e);
            return '改寫失敗：' + (e.message || e);
          } finally {
            building = false;
            progress = null;
            if (tick) { clearInterval(tick); tick = null; }
            showProgress();
          }
        }

        async function showHistory() {
          var res = await A.forge.history(slug);
          if (!res.ok) { ctx.toast('讀不到版本紀錄：' + res.error, 't-err'); return; }
          host.innerHTML = '';
          if (detach) { detach(); detach = null; }

          var wrap = el('div', 'gen-history');
          wrap.appendChild(el('h3', null, '版本紀錄'));
          res.data.slice().reverse().forEach(function (h) {
            var card = el('div', 'gen-hist-card');
            card.appendChild(el('div', 'gen-hist-head',
              'v' + h.version + '　' + new Date(h.at).toLocaleString('zh-TW') +
              '　' + (h.author === 'user' ? '手動' : '模型') + '　' + h.codeBytes + ' bytes'));
            if (h.prompt) card.appendChild(el('div', 'gen-hist-prompt', '需求：' + h.prompt));
            if (h.note) card.appendChild(el('div', 'gen-hist-note', h.note));
            var back = el('button', 'fbtn', '回滾到 v' + h.version);
            back.type = 'button';
            back.addEventListener('click', async function () {
              var r = await A.forge.rollback(slug, h.version);
              if (!r.ok) { ctx.toast('回滾失敗：' + r.error, 't-err'); return; }
              ctx.toast('已回滾到 v' + h.version + '（建立為 v' + r.data.version + '）', 't-ok');
              await load();
            });
            card.appendChild(back);
            wrap.appendChild(card);
          });
          var close = el('button', 'fbtn fbtn-primary', '回到程式');
          close.type = 'button';
          close.addEventListener('click', load);
          wrap.appendChild(close);
          host.appendChild(wrap);
        }

        async function showCode() {
          if (!loaded) return;
          host.innerHTML = '';
          if (detach) { detach(); detach = null; }
          var wrap = el('div', 'gen-code');
          wrap.appendChild(el('h3', null, 'app.js（v' + loaded.manifest.version + '）'));
          wrap.appendChild(el('pre', 'gen-pre', loaded.code));
          var open = el('button', 'fbtn', '在編輯器開啟');
          open.type = 'button';
          open.title = '直接改檔案會讓雜湊對不上，核心會要求你重新核准';
          open.addEventListener('click', function () {
            AIOS.apps.launch('editor', '/apps/' + slug + '/app.js', { forceNew: true });
          });
          var close = el('button', 'fbtn fbtn-primary', '回到程式');
          close.type = 'button';
          close.addEventListener('click', load);
          wrap.appendChild(open);
          wrap.appendChild(close);
          host.appendChild(wrap);
        }

        async function showDoc() {
          var r = await A.fs.read('/apps/' + slug + '/README.md');
          host.innerHTML = '';
          if (detach) { detach(); detach = null; }
          var wrap = el('div', 'gen-code');
          wrap.appendChild(el('h3', null, 'README.md'));
          wrap.appendChild(el('pre', 'gen-pre', r.ok ? r.data.content : '（讀不到說明文件：' + r.error + '）'));
          var close = el('button', 'fbtn fbtn-primary', '回到程式');
          close.type = 'button';
          close.addEventListener('click', load);
          wrap.appendChild(close);
          host.appendChild(wrap);
        }

        btnReload.addEventListener('click', load);
        btnCode.addEventListener('click', showCode);
        btnHist.addEventListener('click', showHistory);
        btnDoc.addEventListener('click', showDoc);

        ctx.describe(function () {
          return [
            '這是一個由核心產生的程式：' + meta.name,
            '用途：' + meta.purpose,
            '版本：v' + (loaded ? loaded.manifest.version : '?'),
            '能力：' + ((loaded && loaded.capabilities || []).join('、') || '無'),
            errors.length ? '執行時的錯誤：\n' + errors.slice(-4).join('\n') : '目前沒有回報錯誤。',
            '',
            '目前的程式碼：',
            (loaded && loaded.code ? loaded.code.slice(0, 6000) : '（尚未載入）')
          ].join('\n');
        });

        /* Right-click on a generated program. The iframe has its own opaque
           origin and gets Chromium's menu; this is the frame around it. */
        ctx.setMenu(function () {
          return [
            { label: (loaded ? 'v' + loaded.manifest.version : '未載入') +
                     (ready ? '　執行中' : '　載入中'), disabled: true },
            { label: '重新載入', run: load },
            { sep: true },
            { label: '看程式碼', run: showCode },
            { label: '版本紀錄', run: showHistory },
            { label: '說明文件', run: showDoc },
            { sep: true },
            { label: '在編輯器開啟 app.js', run: function () {
              AIOS.apps.launch('editor', '/apps/' + slug + '/app.js', { forceNew: true });
            } },
            { label: '在檔案總管顯示', run: function () { AIOS.apps.launch('files', '/apps/' + slug); } },
            errors.length
              ? { label: '請核心修掉回報的錯誤', run: function () {
                  rebuild('程式執行時出現這些錯誤，請修好：\n' + errors.slice(-4).join('\n'));
                } }
              : null,
            { sep: true },
            { label: '解除安裝（保留檔案）', danger: true, run: async function () {
              var ok = await ctx.confirm({
                label: '解除安裝「' + meta.name + '」？',
                note: '執行許可會被撤銷，/apps/' + slug + '/ 的檔案留在沙箱裡，你可以自己刪。',
                okLabel: '解除安裝',
                danger: true
              });
              if (!ok) return;
              var r = await A.forge.remove(slug);
              if (!r.ok) { ctx.toast('解除安裝失敗：' + r.error, 't-err'); return; }
              ctx.toast('已解除安裝，檔案保留在 ' + r.data.filesKeptAt, 't-ok');
              ctx.close();
            } }
          ];
        });

        ctx.api = {
          reload: load,
          /* The `modify` action, and app.do behind it: answered at once, with
             the rebuild running on. The chat panel that asked shows the
             progress (rebuild says into it) and gets the outcome as a note;
             the kernel trace gets it too, for a modification an intent asked
             for minutes ago. */
          rebuild: function (request) {
            request = String(request || '').trim();
            if (!request) return '沒有說要改什麼';
            if (!AIOS.state.connected) return '模型沒有連線，無法改寫';
            if (building) return '正在改寫中，請等這一次做完';
            rebuild(request).then(function (note) {
              var bad = /失敗|無法|沒有說/.test(note);
              // The toast is the trace line, prefixed with this program's name.
              ctx.toast(note, bad ? 't-err' : 't-ok');
              var chat = ctx.win && AIOS.apps.instanceFor(ctx.win);
              if (chat && chat.chat) chat.chat.say(note, bad ? 'chat-err' : 'chat-ok');
            });
            return '已開始改寫「' + meta.name + '」，進度在這個視窗的對話面板，完成後會通知；這段時間可以繼續做別的事';
          },
          /**
           * Call one of the actions this program published.
           *
           * The program declares them on `os.actions`; this asks the frame for
           * the list, or runs one. Naming no action lists them, which is how a
           * plan finds out what a generated app can be told to do without the
           * whole catalogue living in the system prompt.
           */
          runAction: async function (name, args) {
            if (!frame) throw new Error('程式還沒載入');
            var table = await AIOS.appshell.askAction(frame, '__list', {}, 8000)
              .catch(function () { return {}; });
            var names = Object.keys(table || {});
            if (!name) {
              return names.length
                ? '這個程式可以做：' + names.map(function (k) {
                  return k + (table[k].args ? ' ' + table[k].args : '');
                }).join('、')
                : '這個程式沒有發布任何動作';
            }
            if (names.length && names.indexOf(name) < 0) {
              /* Name the arguments too. A caller that got the action name wrong
                 is about to get the parameter names wrong for the same reason. */
              throw new Error('沒有 ' + name + ' 這個動作。可以做：' +
                names.map(function (k) {
                  return k + (table[k].args ? ' ' + table[k].args : '');
                }).join('、'));
            }
            try {
              var out = await AIOS.appshell.askAction(frame, name, args || {});
              return typeof out === 'string' ? out
                : (out && out.note) ? out.note
                  : (name + ' 完成');
            } catch (err) {
              /* The program validated its own arguments and said no. It has no
                 idea what it was sent, so its message cannot mention the one
                 thing the caller needs -- what the parameters are called.

                 Measured: `addRecord {date, ml}` was called with `milliliters`,
                 and said 「毫升數必須是正整數」. The repair round read that as a
                 range problem, sent the same wrong name with a different number,
                 and failed identically until the round budget ran out. */
              var sig = table[name] && table[name].args;
              throw new Error(String(err.message || err) +
                (sig ? '（' + name + ' 的參數是 ' + sig + '，送過去的是 ' +
                  Object.keys(args || {}).join('、') + '）' : ''));
            }
          },
          rollback: async function (v) {
            var r = await A.forge.rollback(slug, v);
            if (!r.ok) throw new Error(r.error);
            await load();
            return '已回滾到 v' + v;
          },
          // The frame reported that render() returned without throwing. Shown
          // in the title bar because "it loaded" and "it ran" are different
          // claims, and the difference was invisible while the frame's scripts
          // were being blocked outright.
          markReady: function () {
            ready = true;
            stamp();
          },
          reportError: function (msg, line) {
            errors.push(msg + (line ? '（第 ' + line + ' 行）' : ''));
            showErrors();
            scheduleAutoRepair();
          },
          isReady: function () { return ready; }
        };

        load();

        return {
          getState: function () { return { slug: slug }; },
          isReady: function () { return ready; },
          onClose: function () {
            clearTimeout(repairTimer);
            if (detach) detach();
            if (frameToken) { A.forge.frameRevoke(frameToken); frameToken = null; }
          }
        };
      }
    });

    // The launcher renders once when it opens; without this a newly installed app
    // is missing from a list the user already has on screen.
    if (AIOS.launcher && AIOS.launcher.refresh) AIOS.launcher.refresh();
    return out;
  }

  /* ---------------------------------------------------------- the forge app */

  AIOS.apps.register({
    id: 'forge',
    name: 'App Forge',
    icon: '⚒',
    kind: 'FORGE',
    width: 700,
    height: 520,
    singleton: true,
    purpose: '沒有現成程式時，讓核心寫一個；也能把程式打包分享、匯入別人的',
    chatHint: '直接說你想要什麼程式，例如「一個記錄每天喝水量的小工具」。',

    /* A `.aiosapp` package opens here. Opening only *shows* it, with a button;
       nothing is installed until a person presses that button and then the
       main process's own dialog -- so the kernel's fs.open on a package
       reaches a description, never an install. */
    accepts: function (p) { return /\.aiosapp$/i.test(p || ''); },

    actions: {
      create: {
        args: '{request}', desc: '依照需求產生一個新程式',
        run: async function (args, ctx) {
          var note = await ctx.api.create(String(args.request || ''));
          return { note: note };
        }
      },
      list: {
        args: '{}', desc: '列出已安裝的程式',
        run: async function (_a, ctx) {
          await ctx.api.refresh();
          return { note: '已更新清單' };
        }
      },
      /* Share is a model verb: it writes a file the sandbox already holds the
         parts of. Import is not, on purpose -- see `accepts` above. */
      share: {
        args: '{app}', desc: '把一個已安裝的程式打包成 .aiosapp 放到 /outbox，可以分享給別人',
        run: async function (args, ctx) {
          return { note: await ctx.api.share(String(args.app || args.slug || args.id || '')) };
        }
      }
    },

    mount: function (ctx) {
      var apps = [];

      var intro = el('div', 'fg-intro');
      intro.appendChild(el('h3', null, '讓核心幫你寫一個程式'));
      intro.appendChild(el('p', 'micro',
        '描述你要什麼，核心會規劃規格、產生程式碼、檢查、實際跑一遍、審查，然後安裝並開起來。' +
        '過程中出錯不會停：它會帶著錯誤修正、必要時重新規劃或分階段建置，直到做出能跑的版本。' +
        '產生的程式跑在受限的 iframe 裡：沒有網路、沒有直接檔案系統，' +
        '只能用你核准過的能力。每一版的需求與程式碼都留在沙箱的 /apps/ 底下。' +
        '做好的程式可以打包成 .aiosapp 分享；別人給的程式包從下面匯入，裝之前一定會問你。'));
      ctx.body.appendChild(intro);

      /* Import, from a file on this computer. The picker is the gesture, so
         a package chosen here goes straight to the checks and the dialog. */
      var tools = el('div', 'fg-tools');
      var importBtn = el('button', 'fbtn', '匯入程式包（.aiosapp）…');
      importBtn.type = 'button';
      importBtn.title = '從電腦選一個 .aiosapp 檔，複製進沙箱的 /inbox，檢查後跳出確認視窗才會安裝';
      tools.appendChild(importBtn);
      var outboxBtn = el('button', 'fbtn', '打開 /outbox');
      outboxBtn.type = 'button';
      outboxBtn.title = '分享出去的程式包放在這裡';
      outboxBtn.addEventListener('click', function () { AIOS.apps.launch('files', '/outbox'); });
      tools.appendChild(outboxBtn);
      ctx.body.appendChild(tools);

      /* A package that was opened but not yet imported lives here, with the
         button that starts the import. Empty until then. */
      var importBox = el('div', 'fg-import');
      importBox.hidden = true;
      ctx.body.appendChild(importBox);

      var form = el('form', 'fg-form');
      var req = el('textarea', 'fg-req');
      req.rows = 3;
      req.placeholder = '例如：一個番茄鐘，可以設定工作與休息時間，記錄今天完成幾輪';
      req.setAttribute('aria-label', '程式需求');
      var go = el('button', 'fbtn fbtn-primary', '產生程式');
      go.type = 'submit';
      form.appendChild(req);
      form.appendChild(go);
      ctx.body.appendChild(form);

      /* What is happening now, above the log, ticking every second while a
         build runs. The log below is the record; this is the pulse. */
      var statusBar = el('div', 'fg-status');
      statusBar.hidden = true;
      ctx.body.appendChild(statusBar);
      var current = null;
      var ticker = null;
      function renderStatus() {
        var now = Date.now();
        var text = statusLine(current, now, false);
        statusBar.hidden = !text;
        statusBar.textContent = text;
        chipStatus(statusLine(current, now, true), text ? '建置中：' + text + '\n點一下打開 App Forge' : '',
          function () { AIOS.apps.launch('forge'); });
      }
      function watch(st) {
        current = st;
        if (!ticker) ticker = setInterval(renderStatus, 1000);
        renderStatus();
      }
      function unwatch() {
        current = null;
        if (ticker) { clearInterval(ticker); ticker = null; }
        renderStatus();
      }

      var log = el('div', 'fg-log');
      ctx.body.appendChild(log);

      var listWrap = el('div', 'fg-apps');
      ctx.body.appendChild(listWrap);

      function say(text, cls) {
        var line = el('div', 'fg-line' + (cls ? ' ' + cls : ''), text);
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
        return line;
      }

      /* Two switches under the form. Both are the main process's to remember;
         these only show and set them. */
      var prefs = el('div', 'fg-prefs');
      form.appendChild(prefs);

      /* Whether a build you started stops to ask before installing.
         Off by default: pressing 建置 is the authorisation. Offered here because
         the one thing the dialog covered is real -- the button authorises the
         purpose, and the model picks the capabilities, so a calculator that asks
         for sandbox-read is worth being stopped for. */
      var confirmWrap = el('label', 'fg-confirm');
      var confirmBox = el('input');
      confirmBox.type = 'checkbox';
      confirmWrap.appendChild(confirmBox);
      confirmWrap.appendChild(el('span', null, '安裝前先問我一次（只有要求沙箱外能力時）'));
      confirmWrap.title = '預設關閉：你按了建置就是授權。' +
        '打開的話，程式要求 ai／clipboard／sandbox-read／page 這類能力時會先跳確認視窗。';
      prefs.appendChild(confirmWrap);

      /* Whether an installed program that throws is rebuilt without being
         asked. On by default; capped at two repairs per load by the window
         that reports the error. */
      var repairWrap = el('label', 'fg-confirm');
      var repairBox = el('input');
      repairBox.type = 'checkbox';
      repairWrap.appendChild(repairBox);
      repairWrap.appendChild(el('span', null, '程式執行時出錯就自動請核心修（每次載入最多兩次）'));
      repairWrap.title = '預設開啟：程式回報錯誤後 1.5 秒，核心會帶著錯誤重新產生一版並重新載入。' +
        '關掉的話錯誤只會顯示出來，旁邊留一顆「請核心修掉」。';
      prefs.appendChild(repairWrap);

      A.forge.installPrefs().then(function (r) {
        if (r && r.ok) {
          confirmBox.checked = !!r.data.confirmInstall;
          repairBox.checked = r.data.autoRepair !== false;
        }
      });
      confirmBox.addEventListener('change', async function () {
        var r = await A.forge.setConfirmInstall(confirmBox.checked);
        if (!r || !r.ok) {
          ctx.toast('設定失敗：' + ((r && r.error) || '未知錯誤'), 't-err');
          confirmBox.checked = !confirmBox.checked;
          return;
        }
        ctx.toast(r.data.confirmInstall
          ? '之後要求沙箱外能力的程式，安裝前會先問你'
          : '之後按下建置就直接安裝，能力會寫在建置紀錄裡', 't-info');
      });
      repairBox.addEventListener('change', async function () {
        var r = await A.forge.setAutoRepair(repairBox.checked);
        if (!r || !r.ok) {
          ctx.toast('設定失敗：' + ((r && r.error) || '未知錯誤'), 't-err');
          repairBox.checked = !repairBox.checked;
          return;
        }
        ctx.toast(r.data.autoRepair
          ? '之後程式執行時出錯，核心會自動修'
          : '之後程式出錯只會顯示，按「請核心修掉」才會修', 't-info');
      });

      async function refresh() {
        var res = await A.forge.list();
        apps = res.ok ? res.data : [];
        listWrap.innerHTML = '';
        listWrap.appendChild(el('h3', null, '已安裝的程式（' + apps.length + '）'));
        if (!apps.length) {
          listWrap.appendChild(el('p', 'micro', '還沒有。上面描述一個需求就會有第一個。'));
          return;
        }
        var grid = el('div', 'launcher');
        apps.forEach(function (a) {
          // The tile and its uninstall control are siblings, not nested: a button
          // inside a button is invalid, and the inner one would swallow clicks
          // meant for the outer.
          var cell = el('div', 'fg-app-cell');

          var tile = el('button', 'launch-tile generated' + (a.integrity === 'ok' ? '' : ' broken'));
          tile.type = 'button';
          tile.__app = a;      // read back by the menu provider
          tile.appendChild(el('span', 'launch-ico', a.icon || '◈'));
          tile.appendChild(el('span', 'launch-name', a.name));
          tile.appendChild(el('span', 'launch-sub',
            'v' + a.version + (a.integrity === 'ok' ? '' : ' · ' +
              (a.integrity === 'modified' ? '已被改動' : '檔案不見'))));
          tile.title = a.purpose || '';
          tile.addEventListener('click', function () {
            registerGenerated({ id: a.id, name: a.name, icon: a.icon, purpose: a.purpose });
            AIOS.apps.launch('gen:' + a.id);
          });
          cell.appendChild(tile);

          var shareBtn = el('button', 'fg-app-drop fg-app-share', '⇪');
          shareBtn.type = 'button';
          shareBtn.title = '把「' + a.name + '」打包成 .aiosapp 放到 /outbox';
          shareBtn.setAttribute('aria-label', '分享 ' + a.name);
          shareBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            share(a.id);
          });
          cell.appendChild(shareBtn);

          /* Uninstall was only ever in a right-click menu, which is a poor place
             for the one action a person goes looking for after building something
             they did not want. */
          var drop = el('button', 'fg-app-drop', '×');
          drop.type = 'button';
          drop.title = '解除安裝「' + a.name + '」';
          drop.setAttribute('aria-label', '解除安裝 ' + a.name);
          drop.addEventListener('click', function (e) {
            e.stopPropagation();
            uninstall(a);
          });
          cell.appendChild(drop);

          grid.appendChild(cell);
        });
        listWrap.appendChild(grid);
      }

      /**
       * Revoke a generated app's permission to run.
       *
       * The files stay. Deleting them would take the source of something the user
       * may want to look at or rebuild from, and the sandbox already has a trash
       * for that decision.
       */
      async function uninstall(a) {
        var ok = await ctx.confirm({
          label: '解除安裝「' + a.name + '」？',
          note: '執行許可會被撤銷，/apps/' + a.id + '/ 的檔案留在沙箱裡，你可以自己刪。',
          okLabel: '解除安裝',
          danger: true
        });
        if (!ok) return;
        var r = await A.forge.remove(a.id);
        if (!r.ok) { ctx.toast('解除安裝失敗：' + r.error, 't-err'); return; }

        /* Revoking the permission in the main process is only half of it. The app
           was also registered in this document's own registry by
           registerGenerated(), which is what the launcher and the desktop menu
           read -- so without this it stayed listed and launchable, and clicking it
           would fail on a load the main process now refuses. */
        var appId = 'gen:' + a.id;
        AIOS.wm.list().slice().forEach(function (w) {
          var inst = AIOS.apps.instanceFor(w);
          if (inst && inst.def && inst.def.id === appId) AIOS.wm.close(w);
        });
        AIOS.apps.unregister(appId);

        await refresh();
        AIOS.launcher.refresh();
        ctx.toast('已解除安裝 ' + a.name, 't-ok');
      }

      /* ------------------------------------------------------ share ---- */

      /**
       * One file into /outbox: manifest, code, the pinned libraries' source,
       * the build trail without code bodies. Nothing from outside the
       * sandbox travels -- not the hash that grants execution, not /appdata.
       */
      async function share(slug) {
        slug = String(slug || '').trim();
        var a = apps.filter(function (x) { return x.id === slug || x.name === slug; })[0];
        if (!a) return '沒有安裝「' + slug + '」';
        var r = await A.forge.export(a.id, { history: true });
        if (!r.ok) {
          say('分享「' + a.name + '」失敗：' + r.error, 'fg-err');
          ctx.toast('分享「' + a.name + '」失敗：' + r.error, 't-err');
          return '分享失敗：' + r.error;
        }
        await AIOS.afterFsChange();
        var note = '已把「' + a.name + '」v' + r.data.version + ' 打包成 ' + r.data.vpath +
          '（' + Math.max(1, Math.round(r.data.bytes / 1024)) + ' KB' +
          (r.data.libs ? '，含 ' + r.data.libs + ' 個套件' : '') +
          (r.data.history ? '，' + r.data.history + ' 筆歷史' : '') + '）';
        say(note + '。在檔案總管右鍵「在作業系統顯示」就能把檔案送出去', 'fg-ok');
        ctx.toast(note, 't-ok');
        return note;
      }

      /* ----------------------------------------------------- import ----

         Three steps, and a person between each pair.

           1. A package is *shown*: name, purpose, capabilities, size, where
              it came from, and one button. Opening a file gets this far and
              no further -- from the file manager, from the kernel's fs.open,
              from a drop.
           2. The button runs the checks every build passes (syntax, the
              rule check, the smoke test in a stub frame). A package that
              fails stops here, with the reasons, and no dialog appears.
           3. The main process's own dialog asks; only 匯入／取代／另外安裝
              installs. The renderer never gets a channel that skips it.

         The code is never displayed. It is not needed for the decision --
         the capabilities and the checks are -- and a person asked to read
         300 KB of generated JavaScript before pressing a button does not
         read it. */

      function capsLine(caps) {
        if (!caps || !caps.length) return '不要求任何能力（純運算與介面）';
        return caps.map(function (c) { return c + '（' + (CAP_WORDS[c] || c) + '）'; }).join('、');
      }

      var CAP_WORDS = {
        storage: '自己的小儲存', appdata: '自己的資料夾', ai: '問模型', clipboard: '寫剪貼簿',
        'sandbox-read': '讀你的沙箱檔案', 'sandbox-write': '寫你的沙箱檔案',
        page: '讀改瀏覽器頁面', net: '連網', apps: '叫其他程式做事'
      };

      var pendingPreview = null;

      function clearImportBox() {
        if (pendingPreview && pendingPreview.token) A.forge.importCancel(pendingPreview.token);
        pendingPreview = null;
        importBox.innerHTML = '';
        importBox.hidden = true;
      }

      /** Step 1: show the package. `auto` skips the button (the file picker was the gesture). */
      async function prepareImport(vpath, auto) {
        clearImportBox();
        importBox.hidden = false;
        importBox.appendChild(el('div', null, '正在讀取程式包 ' + vpath + '…'));
        var r = await A.forge.importPreview(vpath);
        importBox.innerHTML = '';
        if (!r.ok) {
          importBox.appendChild(el('div', 'fg-err', '這個程式包不能匯入：' + r.error));
          var close = el('button', 'fbtn', '關閉');
          close.type = 'button';
          close.addEventListener('click', clearImportBox);
          importBox.appendChild(close);
          say('程式包 ' + vpath + ' 不能匯入：' + r.error, 'fg-err');
          return null;
        }
        var p = r.data;
        pendingPreview = p;

        var head = el('div');
        head.appendChild(el('b', null, p.icon + ' ' + p.name));
        head.appendChild(document.createTextNode('　v' + p.version +
          (p.exportedBy ? '　由 ' + p.exportedBy + ' 匯出' : '') +
          (p.exportedAt ? '（' + new Date(p.exportedAt).toLocaleDateString('zh-TW') + '）' : '')));
        importBox.appendChild(head);
        if (p.purpose) importBox.appendChild(el('div', null, p.purpose));
        importBox.appendChild(el('div', 'fg-import-caps',
          '能力：' + capsLine(p.capabilities) +
          '　套件：' + (p.libs.length ? p.libs.map(function (l) { return l.name + '@' + l.version; }).join('、') : '無') +
          '　程式碼 ' + Math.max(1, Math.round(p.codeBytes / 1024)) + ' KB' +
          (p.history ? '　歷史 ' + p.history + ' 筆' : '')));
        importBox.appendChild(el('div', 'fg-import-caps', '來源：' + p.vpath));
        if (p.existing) {
          importBox.appendChild(el('div', 'fg-warn',
            '已經有一個「' + p.existing.name + '」（v' + p.existing.version + '）；確認視窗會問你要取代還是另外裝成「' + p.besideSlug + '」'));
        }
        if (p.capsReachingOut.length) {
          importBox.appendChild(el('div', 'fg-warn',
            '⚠ 這是別人寫的程式，而它要求 ' + p.capsReachingOut.join('、') + '：會讀到或送出你的資料。不確定來源就不要裝。'));
        }
        var row = el('div', 'fg-import-row');
        var go = el('button', 'fbtn fbtn-primary fg-import-go', '檢查並匯入這個程式…');
        go.type = 'button';
        go.title = '先跑靜態檢查與冒煙測試，通過後跳出確認視窗，按下匯入才會安裝';
        go.addEventListener('click', function () { runImport(p); });
        row.appendChild(go);
        var no = el('button', 'fbtn', '不要');
        no.type = 'button';
        no.addEventListener('click', clearImportBox);
        row.appendChild(no);
        importBox.appendChild(row);

        if (auto) return runImport(p);
        return p;
      }

      var importing = false;

      /** Steps 2 and 3. */
      async function runImport(p) {
        if (importing) { say('已經有一個匯入在進行', 'fg-warn'); return null; }
        importing = true;
        var goBtn = importBox.querySelector('.fg-import-go');
        if (goBtn) goBtn.disabled = true;
        if (log.childNodes.length) say('', 'fg-sep');
        say('▶ 匯入：' + p.name + ' v' + p.version + '（' + p.vpath + '）');
        try {
          say('1/3　靜態檢查…');
          var problems = await checkCode(p.code, p.capabilities);
          if (problems.length) {
            problems.forEach(function (x) { say('　✗ ' + x, 'fg-err'); });
            say('沒有通過檢查，沒有安裝', 'fg-err');
            report('程式包「' + p.name + '」沒有通過靜態檢查，沒有安裝', 't-err');
            clearImportBox();
            return null;
          }
          say('　通過', 'fg-ok');
          say('2/3　冒煙測試（在沒有任何授權的測試框裡跑一遍）…');
          var smoke = await AIOS.appshell.smokeTest(p.code, p.capabilities, p.libSources);
          if (smoke.length) {
            smoke.forEach(function (x) { say('　✗ ' + x, 'fg-err'); });
            say('程式跑不起來，沒有安裝', 'fg-err');
            report('程式包「' + p.name + '」冒煙測試失敗，沒有安裝', 't-err');
            clearImportBox();
            return null;
          }
          say('　通過', 'fg-ok');
          say('3/3　等待你在確認視窗按下匯入…', 'fg-warn');
          var r = await A.forge.importConfirm(p.token, { ok: true });
          pendingPreview = null;
          if (!r.ok) {
            say('匯入失敗：' + r.error, 'fg-err');
            report('匯入「' + p.name + '」失敗：' + r.error, 't-err');
            clearImportBox();
            return null;
          }
          if (r.data.canceled) {
            say('你取消了，沒有安裝', 'fg-warn');
            report('已取消匯入「' + p.name + '」', 't-warn');
            clearImportBox();
            return null;
          }
          var d = r.data;
          say('已安裝 ' + d.name + ' v' + d.version + '，路徑 /apps/' + d.slug + '/' +
            (d.replaced ? '（取代了原本的）' : ''), 'fg-ok');
          if (d.capabilities.length) say('　已授予能力：' + d.capabilities.join('、'), 'fg-line');
          registerGenerated({ id: d.slug, name: d.name, icon: p.icon, purpose: p.purpose });
          await AIOS.afterFsChange();
          await refresh();
          AIOS.launcher.refresh();
          importBox.innerHTML = '';
          importBox.hidden = true;
          await AIOS.apps.launch('gen:' + d.slug);
          report('已匯入並開啟「' + d.name + '」（v' + d.version + '）', 't-ok');
          return d;
        } catch (e) {
          say('匯入失敗：' + ((e && e.message) || e), 'fg-err');
          clearImportBox();
          return null;
        } finally {
          importing = false;
        }
      }

      importBtn.addEventListener('click', async function () {
        var r = await A.user.import('/inbox');
        if (!r.ok) { ctx.toast('匯入失敗：' + r.error, 't-err'); return; }
        if (r.data.canceled) return;
        await AIOS.afterFsChange();
        var got = (r.data.imported || []).filter(function (f) { return /\.aiosapp$/i.test(f.vpath); });
        var other = (r.data.imported || []).length - got.length;
        if (other) say('有 ' + other + ' 個不是 .aiosapp 的檔案，只複製進 /inbox，沒有處理', 'fg-warn');
        if (!got.length) { if (!other) say('沒有選到 .aiosapp 檔', 'fg-warn'); return; }
        if (got.length > 1) say('一次只匯入一個：先處理 ' + got[0].vpath + '，其他的在 /inbox 裡', 'fg-warn');
        await prepareImport(got[0].vpath, true);
      });

      /* Proof that a person pressed 「建置」, and not something that merely says so.
         A private object rather than `true` because `create` is also this app's
         api -- `ctx.api.create` is this very function, reachable from the chat
         action and from the kernel's app.create syscall. Those callers pass one
         argument today, but a boolean flag would put the whole difference between
         the gated and the ungated path one careless argument away. Nothing
         outside this closure can produce this value. */
      var GESTURE = {};

      /* Builds run off the caller's clock, one after another.

         `create` used to await the whole build, and so did everything above
         it: the app.create syscall, the intent round that issued it, the
         intent bar's `busy` flag. A ten-minute build was ten minutes in which
         every other intent was silently dropped. Now a request is queued and
         the caller gets an answer at once; the log in this window is the
         progress, and the kernel trace gets a line when the build ends.

         One build at a time in this window, on purpose: two builds streaming
         into one log would be unreadable, and two builds' worth of model calls
         at once is a spend nobody asked for. The rest of the machine is not
         waiting on it either way. */
      var queue = [];
      var running = null;

      var stop = el('button', 'fbtn', '中止建置');
      stop.type = 'button';
      stop.hidden = true;
      stop.title = '中止正在進行的建置；已排入的會接著跑';
      stop.addEventListener('click', function () {
        if (!running) return;
        running.cancelled = true;
        K.abort('forge');
        say('　已送出中止訊號，等這一步結束…', 'fg-warn');
      });
      form.insertBefore(stop, prefs);

      function summary(request) {
        var s = String(request || '').replace(/\s+/g, ' ');
        return s.length > 40 ? s.slice(0, 40) + '…' : s;
      }

      /* Said in the kernel trace, because the person who asked may have moved
         on: the intent that started this build ended minutes ago, and this
         window may be behind three others. ctx.toast is that trace line, with
         the app's name in front -- calling AIOS.ui.trace as well printed every
         outcome twice. */
      function report(msg, cls) {
        ctx.toast(msg, cls === 't-err' ? 't-err' : cls === 't-warn' ? 't-warn' : cls === 't-info' ? 't-info' : 't-ok');
      }

      /* `gesture` is GESTURE only when a click brought us here. The model's route
         (the `create` action below, and the kernel syscall that drives it) leaves
         it undefined and stays behind the app.create gate. */
      async function create(request, gesture) {
        request = String(request || '').trim();
        if (!request) return '沒有描述需求';
        if (!AIOS.state.connected) return '模型沒有連線';

        var job = { request: request, gesture: gesture, cancelled: false };
        queue.push(job);
        var ahead = (queue.length - 1) + (running ? 1 : 0);
        pump();
        return ahead
          ? '已排入建置佇列（前面還有 ' + ahead + ' 個）：' + summary(request) +
            '。進度在 App Forge 視窗，完成後核心軌跡會通知'
          : '已開始建置：' + summary(request) +
            '。進度在 App Forge 視窗，完成後核心軌跡會通知；這段時間可以繼續下其他意圖';
      }

      function pump() {
        if (running || !queue.length) return;
        var job = queue.shift();
        running = job;
        stop.hidden = false;
        runJob(job)
          .catch(function (e) { say('失敗：' + ((e && e.message) || e), 'fg-err'); })
          .then(function () {
            running = null;
            stop.hidden = true;
            pump();
          });
      }

      async function runJob(job) {
        var request = job.request;
        var gesture = job.gesture;
        /* The previous build's log stays -- it is the only record of what a
           build that ran in the background did -- under a rule, and bounded. */
        if (log.childNodes.length) say('', 'fg-sep');
        while (log.childNodes.length > 400) log.removeChild(log.firstChild);
        say('▶ 建置：' + summary(request) + (queue.length ? '　（佇列中還有 ' + queue.length + ' 個）' : ''));
        try {
          /* Everything up to a program that runs and does what was asked
             happens in the loop; what is left here is the install, which is
             the one step that is about authority rather than about code. */
          var codeLine = null;
          var codeAcc = '';
          /* Phase changes go to the kernel trace as well: the person who
             asked may have four windows over this one, and 「規劃 → 產生 →
             審查 → 安裝」 in the trace is how they know it is moving. Every
             second's tick stays here and in the menu-bar chip. */
          var lastPhase = '';
          var built = await buildProgram({
            request: request,
            say: say,
            cancelled: function () { return job.cancelled; },
            onStatus: function (st) {
              watch(st);
              if (st.phase && st.phase !== lastPhase) {
                lastPhase = st.phase;
                report(summary(request) + '　' + st.phase, 't-info');
              }
            },
            onCodeToken: function (piece, thinking) {
              if (thinking) return;
              if (!codeLine || !codeLine.parentNode || codeLine !== log.lastChild) {
                codeLine = say('', 'fg-stream');
                codeAcc = '';
              }
              codeAcc += piece;
              codeLine.textContent = codeAcc.length + ' 字元…';
            }
          });
          var spec = built.spec;
          var code = built.code;
          var caps = built.caps;

          say('5/5　安裝…');
          watch({ phase: '5/5 安裝', step: '寫進 /apps 並登記雜湊', startedAt: Date.now() - built.seconds * 1000, stepAt: Date.now() });
          report(summary(request) + '　5/5 安裝', 't-info');
          /* What the program is being granted, said at the moment it is granted.
             With no dialog this is the disclosure, so it is stated plainly here
             rather than left to the row in the list below -- and when the dialog
             is switched on, it also explains what the modal that is about to
             appear is for. That dialog used to be a native one that could sit
             behind the window, and the log's last line reading 「4/4　安裝…」
             was mistaken for a hang for four minutes the first time it
             happened. It is drawn inside the window now (main/askbox.js); the
             line stays, because a log should still say what it is waiting on. */
          var asks = [];
          var willAsk = false;
          try {
            var sys = await A.sysInfo();
            // The bridge answers {ok, data}; reading the field off the envelope
            // yields undefined and silently never warns.
            var needs = (sys && sys.ok && sys.data.appCapsNeedingConsent) || [];
            asks = caps.filter(function (c) { return needs.indexOf(c) >= 0; });
            var prefsNow = await A.forge.installPrefs();
            willAsk = !!(prefsNow && prefsNow.ok && prefsNow.data.confirmInstall) && asks.length > 0;
          } catch (e) { /* the lines below are disclosure, not the gate */ }

          if (asks.length) {
            say('　這個程式會取得沙箱外的能力：' + asks.join('、'), 'fg-warn');
          }
          /* The pair worth a second sentence: a program that can both read what
             is in the sandbox and talk to the network can carry one to the
             other. Said plainly, because nothing else stops to ask. */
          if (caps.indexOf('net') >= 0 && (caps.indexOf('sandbox-read') >= 0 || caps.indexOf('page') >= 0)) {
            say('　⚠ 它同時能讀你的' + (caps.indexOf('sandbox-read') >= 0 ? '沙箱檔案' : '網頁內容') +
              '和連網，讀到的內容有可能被送出去；不放心就別裝', 'fg-warn');
          }
          if (willAsk) {
            say('　等待安裝確認（畫面上會跳出視窗）', 'fg-warn');
          }

          var slugRes = await A.forge.slug(spec.name);
          var slug = slugRes.ok ? slugRes.data.slug : ('app-' + Date.now().toString(36));

          var payload = {
            slug: slug,
            name: spec.name,
            purpose: spec.purpose,
            icon: spec.icon,
            code: code,
            capabilities: caps,
            libs: built.libs,
            prompt: request,
            note: ((spec.plan || []).join('；') +
              ((spec.assumed || []).length ? '　補上：' + spec.assumed.join('；') : '') +
              (built.notes.length ? '　⚠ ' + built.notes.join('；') : '')).slice(0, 400),
            author: 'model'
          };

          /* Two channels, same install. The gesture one is ungated -- pressing
             the button is the authorisation -- and only stops to ask when the
             confirmation preference is on; the other is the app.create syscall
             and answers to the policy and to the taint downgrade. Deciding here
             rather than in main keeps the model's route on the gated channel by
             construction. */
          var res = gesture === GESTURE
            ? await A.forge.installByGesture(payload)
            : await A.forge.install(payload);
          if (!res.ok) {
            say('安裝失敗：' + res.error, 'fg-err');
            report('安裝「' + spec.name + '」失敗：' + res.error, 't-err');
            return;
          }
          if (res.data && res.data.canceled) {
            say('已取消安裝', 'fg-warn');
            report('已取消安裝「' + spec.name + '」', 't-warn');
            return;
          }

          say('已安裝 ' + spec.name + ' v' + res.data.version + '，路徑 /apps/' + slug + '/', 'fg-ok');
          /* The grant, restated after the fact and with the way out attached.
             Nothing asked before this happened, so the one place a person can
             notice it and act on it is here. */
          if (caps.length) {
            say('　已授予能力：' + caps.join('、') +
              '　（不想要就在下面的清單解除安裝）', asks.length ? 'fg-warn' : 'fg-line');
          }
          built.notes.forEach(function (n) { say('　⚠ ' + n, 'fg-warn'); });
          if (built.deferred.length) {
            say('　之後想加就在程式的對話面板說「加上…」', 'fg-line');
          }
          registerGenerated({ id: slug, name: spec.name, icon: spec.icon, purpose: spec.purpose });
          await AIOS.afterFsChange();
          await refresh();
          await AIOS.apps.launch('gen:' + slug);
          report('已產生並開啟「' + spec.name + '」（v' + res.data.version + '，' + built.rounds + ' 輪、' +
            built.seconds + ' 秒）' + (built.notes.length ? '　⚠ ' + built.notes.join('；') : '') +
            ((spec.assumed || []).length ? '　補上了 ' + spec.assumed.length + ' 項你沒說的細節，見 Forge 紀錄' : ''), 't-ok');
        } catch (e) {
          if (job.cancelled) {
            say('已中止建置', 'fg-warn');
            report('已中止建置：' + summary(request), 't-warn');
            return;
          }
          if (e && e.code === 'EREFUSED') {
            // Already said in the log, with the reason; the trace gets it too,
            // because the intent that asked has already ended.
            report('無法建置「' + summary(request) + '」：' + (e.message || e), 't-err');
            return;
          }
          say('失敗：' + (e.message || e), 'fg-err');
          report('建置「' + summary(request) + '」失敗：' + (e.message || e), 't-err');
        } finally {
          unwatch();
        }
      }

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        // The only place GESTURE is ever passed.
        var note = create(req.value.trim(), GESTURE);
        req.value = '';
        note.then(function (n) { if (/佇列/.test(n)) say(n, 'fg-line'); });
      });

      ctx.describe(function () {
        return '已安裝的程式：\n' +
          (apps.length
            ? apps.map(function (a) {
                return '  ' + a.id + '　' + a.name + '　v' + a.version + '　' + a.purpose +
                       '　完整性：' + a.integrity;
              }).join('\n')
            : '  （還沒有）') +
          '\n\n可用能力：storage（自己的小儲存）、appdata（自己的資料夾）、' +
          'ai（問模型）、clipboard、sandbox-read（讀使用者沙箱檔案）、sandbox-write（寫使用者沙箱檔案）、' +
          'net（連網讀公開 API）、apps（叫其他程式做事）' +
          '\n建置會自動修正錯誤、重新規劃、分階段建置，最多 ' + BUILD.MAX_ROUNDS + ' 輪。' +
          '\n做不到的：碰電腦上沙箱以外的檔案、執行程式或指令、改系統設定——這種需求會在規劃時拒絕並說明原因。' +
          '\n分享：share {app} 會把程式打包成 /outbox/<代號>-v<版本>.aiosapp。' +
          '匯入只能由使用者在 App Forge 視窗按按鈕並在確認視窗同意，沒有動作可以代做。' +
          (pendingPreview ? '\n目前有一個等待匯入的程式包：' + pendingPreview.name + '（' + pendingPreview.vpath + '），要使用者自己按「檢查並匯入」。' : '');
      });

      /* Right-click. On a tile the menu acts on that program. */
      ctx.setMenu(function (ev) {
        var tile = ev.target.closest ? ev.target.closest('.launch-tile') : null;
        var a = tile && tile.__app;

        if (a) {
          return [
            { label: a.name + '　v' + a.version, disabled: true },
            { label: '開啟', run: function () {
              registerGenerated({ id: a.id, name: a.name, icon: a.icon, purpose: a.purpose });
              AIOS.apps.launch('gen:' + a.id);
            } },
            { label: '在檔案總管顯示', run: function () { AIOS.apps.launch('files', '/apps/' + a.id); } },
            { label: '看說明文件', run: function () {
              AIOS.apps.launch('editor', '/apps/' + a.id + '/README.md', { forceNew: true });
            } },
            { label: '分享成 .aiosapp（放到 /outbox）', disabled: a.integrity !== 'ok',
              run: function () { share(a.id); } },
            a.integrity !== 'ok'
              ? { label: '完整性：' + a.integrity + '（開啟後要重新核准）', disabled: true }
              : null,
            { sep: true },
            { label: '解除安裝（保留檔案）', danger: true,
              run: function () { uninstall(a); } }
          ];
        }

        return [
          { label: '重新讀取清單', run: refresh },
          { label: '在檔案總管開啟 /apps', run: function () { AIOS.apps.launch('files', '/apps'); } },
          { label: '匯入程式包（.aiosapp）…', run: function () { importBtn.click(); } },
          { sep: true },
          { label: AIOS.state.connected ? '把焦點移到需求欄' : '模型沒有連線', disabled: !AIOS.state.connected,
            run: function () { req.focus(); } }
        ];
      });

      /* One argument on purpose. Everything reaching the app through `api` is
         acting for the model, so the gesture slot is dropped at the boundary
         instead of relying on each caller to leave it out. */
      ctx.api = {
        create: function (request) { return create(request); },
        refresh: refresh,
        share: share
        // No import here: `api` acts for the model, and importing is not
        // something the model gets to do. See `accepts` on the definition.
      };

      refresh().then(function () {
        // Opened on a package (double-click in the file manager, fs.open):
        // show it. The person still has to press the button.
        if (/\.aiosapp$/i.test(String(ctx.arg || ''))) prepareImport(String(ctx.arg), false);
      });

      return {
        // Exposed so the kernel's app.create syscall can drive this window
        // rather than duplicating the generation pipeline.
        api: ctx.api,
        reopen: function (arg) {
          if (/\.aiosapp$/i.test(String(arg || ''))) return prepareImport(String(arg), false);
          return null;
        },
        getState: function () { return {}; }
      };
    }
  });

  /* Re-register everything already installed, so the launcher and the session
     restore can find them by id without opening the forge first. */
  AIOS.forge = {
    registerGenerated: registerGenerated,
    bootstrapInstalled: async function (list) {
      var apps = list;
      if (!apps) {
        var res = await A.forge.list();
        apps = res.ok ? res.data : [];
      }
      apps.forEach(function (a) {
        registerGenerated({ id: a.id, name: a.name, icon: a.icon, purpose: a.purpose });
      });
      return apps.length;
    },
    /* The pure parts of the loop, reachable so the tests can run them rather
       than read them: the seam between a partial answer and its continuation,
       the fence stripping, the stage split, and the budget the log reports. */
    parts: {
      BUILD: BUILD,
      stitch: stitch,
      cleanCode: cleanCode,
      splitPlan: splitPlan,
      summarise: summarise,
      withRemedy: withRemedy,
      sanitiseSpec: sanitiseSpec,
      screenRequest: screenRequest,
      statusLine: statusLine,
      mmss: mmss
    }
  };
})();
