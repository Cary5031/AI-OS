# graphify 重建腳本

`/graphify .` 的預設流程對這個專案會產生一張**結構上錯誤**的圖。這個資料夾裡的
腳本是修正過的重建流程；graphify 升級或重跑 `/graphify` 之後，圖會退回錯誤版本，
用這裡的腳本重跑即可。

## 預設流程錯在哪

1. **語意抽取容易造出 ghost duplicate。** 為 `wiring.test.js` 之類「已經有 AST 節點
   的檔案」再開一個概念節點，會把同一個實體拆成兩個：概念邊掛在假節點上、結構邊
   掛在真節點上。實測假節點 betweenness 0.1889、真節點 0.0684 —— 排名完全反了。

2. **AST 會從字串字面值裡抽出節點。** `test/wiring.test.js:227` 的 fixture
   `'function render(){ import("x") }'` 讓抽取器產生一個叫 `x` 的節點與一條
   `dynamic_import` 邊。那個檔案不存在。

3. **AST 看不見這個 repo 真正的耦合方式。** 兩種都漏：
   - `test/wiring.test.js:25` 的 `read()` 以字串路徑讀 28 個原始檔來做斷言，
     另外用 `readdirSync` 掃過 `renderer/apps/` 每一個 `.js`。這是真的相依
     （改那些檔這個測試會紅），但 `fs.readFileSync` 不是 import，AST 只看到 3 個 require。
   - `app/renderer/index.html:307-309` 明講 renderer 刻意不上 bundler。模組之間
     靠 `window.AIOS` 全域命名空間互相取用，preload 橋是 `window.aios`。
     `AIOS.grid.merge(...)` 是屬性存取不是 import，所以 AST 一條都看不到。

   漏掉的後果是可量測的：把測試檔拿掉之後，production 圖裂成 **9 個互不相連的元件**，
   `docs.js` 有 85 條邊卻只有 1 條離開自己。補回 68 條命名空間邊之後變成 **2 個**
   （其中一個是單一節點），而 production 的 betweenness 首位變成
   `surfaces.js` (0.268) 與 `preload/index.js` (0.268) —— 也就是 README 說大家共用的那兩樣。

## 怎麼重跑

在專案根目錄，用 graphify 的直譯器（`graphify-out/.graphify_python` 裡有路徑）：

```powershell
$py = Get-Content graphify-out\.graphify_python -Raw
& $py graphify-out\rebuild\semantic_extract.py   # 產生 .graphify_chunk_01.json
& $py graphify-out\rebuild\corrections.py        # 修 ghost duplicate、補 read() 耦合
& $py graphify-out\rebuild\namespace_edges.py    # 產生 .graphify_chunk_02.json（AIOS.* 邊）
& $py graphify-out\rebuild\rebuild.py            # detect + AST + 合併 + 建圖 + 分群
& $py graphify-out\rebuild\label.py              # 社群命名 + 重生報告
graphify export html
& $py graphify-out\rebuild\manifest.py
```

`prod_view.py` 是驗證用的：印出整體與「拿掉測試檔」兩種視角的 betweenness 與元件數。

## ⚠ 社群標籤會錯位，每次重跑都要看一遍

`label.py` 的 `LABELS` 是 **community id → 名稱**，而 id 是 Leiden 每次重新分群時
現給的。程式碼一改、社群重新編號，整張表就會系統性地對到錯的社群上。

**每一次重跑，整張表都會錯，而且錯法都不一樣。** 三次紀錄：

| 重跑 | 社群數 | 錯位情形 |
|---|---|---|
| 第一次 | 44 | 4 個對錯：`package.json` 叫「Markdown 檢視器」、`preset.js` 叫「視窗管理與版面」 |
| 第二次 | 45 | **超過三十個**對錯：`e2e/` 叫「PDF 檢視器算繪」、`kernel.js` 叫「PDF 應用程式視窗」 |
| 第三次 | 52 | 整張重寫。加了 `fs.find`、`more` 旗標、部首修復、瀏覽器分頁之後又全部重編號 |
| 第三次·再一次 | 49 | **只多加了一條概念邊**（`readme_test_suite → e2e_run`），整張表從第 4 群起全錯 |
| 第四次 | 49 | 補了六個概念節點與十六條邊之後又全部重編號 |

最後那一列是這條規則最尖銳的示範：**一條邊就夠了。** 那次是把過期的概念節點
（「362 個測試，七個檔案」——README 早就改成兩套共 510 條了）改成正確的敘述，
順手補一條指向 `e2e_run` 的邊，社群數 52 → 49，第 4 群從 OOXML 變成模型供應商。

第三次還有兩個**結構性**的變化，不只是編號動了：`office.js` 原本裂成四個子社群
（pptx / xlsx / 框線 / docx），這次合回成一個 67 節點的群；而 `gate.js` 反過來裂成三個——
主體、批次授權、汙染集追蹤。那反映的是真實的耦合變化，值得看一眼再決定名字。

`label.py` 只會在**有社群沒名字**時中止（新增的社群抓得到），
**錯位它抓不到**——那要用眼睛看。所以加了稽核模式：

```powershell
& $py graphify-out\rebuild\label.py audit
```

它把每個社群的名稱與「實際上由哪個檔案組成」並排印出來。
**重跑之後、寫報告之前先跑這個**，兩欄對不上就改 `LABELS`。
一張把 `preset.js` 叫成「視窗管理」的圖，比沒有名字的圖更糟——名字會被當成事實讀。

## production 元件數會隨著獨立腳本增加

上面說補完命名空間邊之後 production 應該是 2 個元件。現在是 **4 個**，多出來的孤島是：

| 孤島 | 幾個節點 | 為什麼孤立是對的 |
|---|---|---|
| `e2e/` | 50 | 端對端套件**用 CDP 驅動跑起來的程式**，不 import 專案任何模組。它和專案的耦合是行為上的，不是模組上的——這張圖看不到那種耦合，而它孤立正好如實反映了這件事 |
| `Build-AIOS.ps1` | 4 | 獨立的建置腳本 |
| `readme_test_suite` | 1 | 概念節點，沒接到任何檔案 |

判斷標準是**主元件有沒有裂開**（目前 1424/1479 個 production 節點在同一個元件裡；
總數 1578 節點 / 3562 邊），不是元件總數。

補完那六個概念之後整體元件數從 3 降到 2——原本那個孤立的 `readme_test_suite` 接上了，
而 `sandbox.js` 進了 production betweenness 前五（0.162）。那反映的是真實的變化：
它這一輪多了 `find()` 與 `watch()`。

## 已知限制

- `semantic_extract.py` 的概念節點是人工從 README 抽的，README 大改之後要跟著更新。
  **那六節已經補上了**（PowerPoint 匯出、為什麼是分頁、從外面丟檔案進來、
  例外：你自己指名的目標、搜尋沙箱、一份計畫可以說「我還沒做完」），各自接到它描述的程式碼。
- **行號現在會自己驗。** `ANCHORS` 給每個帶位置的節點一個必須出現在那個範圍裡的字串，
  `check_locations()` 在寫出 chunk 之前檢查。它上線當天就抓到兩個漂移的位置
  （「授權刻意不在這份文件裡呈現」指到 dock 按鈕、「renderer 腳本相依順序」指到拖放區），
  以及我自己編輯 index.html 之後造成的第三個。一個自信地指錯地方的位址，比沒有位址更糟。
- `HANDOVER.md` 與 `electron-builder.yml` 不在語意抽取範圍（manifest 會回報
  `unstamped semantic files`），所以 63 項交接記錄不在圖裡。那是刻意的：
  HANDOVER 是敘事，不是結構。
- 那 68 條命名空間邊與 33 條 `read()` 邊帶的 `source_file` 是程式碼檔，不在 graphify
  語意快取的 `allowed_source_files` 裡，所以**不會進快取**；`--update` 增量重跑會掉，
  必須重跑上面整串。
- `renderer/os.css` 被 `wiring.test.js` 讀去算 WCAG 對比，但 `.css` 不在 graphify 的
  偵測範圍，所以沒有節點，那條耦合只以概念邊（`--on-fill 主題變數`、`AIOS.palette 文件配色`）
  表示。
- token 數是這個 session 的估算值，不是 subagent 回報的實際用量。
