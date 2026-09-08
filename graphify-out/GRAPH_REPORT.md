# Graph Report - AI-OS  (2026-08-30)

## Corpus Check
- 72 files · ~287,549 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1578 nodes · 3562 edges · 49 communities (48 shown, 1 thin omitted)
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 261 edges (avg confidence: 0.85)
- Token cost: 67,000 input · 10,000 output

## Community Hubs (Navigation)
- 簡報應用程式
- 試算表應用程式
- 文件應用程式
- 公式引擎
- 模型供應商與傳輸
- PDF 剖析與抽字
- 共用面板與視窗管理
- 瀏覽器視圖、syscall 邊界與模型預設檔
- 沙箱檔案系統
- 端對端測試骨架
- 公式、Markdown 與沙箱測試
- 視窗 AI 對話面板與工作階段
- PDF 檢視器算繪
- 郵件 IMAP/SMTP 與網頁抓取
- 專案相依與建置設定
- 能力閘門與授權
- 郵件本機鏡像
- 意圖核心與 context 預算
- App Forge 主程序
- Markdown 檢視器
- OOXML 讀寫核心
- 生成程式沙箱與 broker
- 開機序列與意圖回合
- 主程序生命週期
- 接線測試與主題對比
- App Forge 建置介面
- PDF 應用程式視窗
- PDF 轉 Markdown
- 長期記憶儲存
- 文字編輯器
- 瀏覽器應用程式視窗
- 檔案總管
- 書籤儲存
- preload 橋接、HUD 與記憶視窗
- 郵件應用程式視窗
- 桌面殼層與 shell 文件
- OOXML：xlsx 產出與欄寬換算
- OOXML：pptx 產出
- 授權視窗與窄橋
- 文件自我檢查測試
- 能力邊界與汙染的概念
- OOXML：框線算術與 xlsx 讀取
- zip 容器與 PowerPoint 匯出
- 應用程式註冊表與分頁
- aios-app scheme 與程式完整性
- OOXML：docx 產出
- Office 往返測試
- 汙染集追蹤
- 建置腳本

## God Nodes (most connected - your core abstractions)
1. `render()` - 32 edges
2. `mutate()` - 26 edges
3. `el()` - 25 edges
4. `markDirty()` - 22 edges
5. `render()` - 22 edges
6. `run()` - 20 edges
7. `markDirty()` - 19 edges
8. `cur()` - 18 edges
9. `selRect()` - 18 edges
10. `snapshot()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `PDF 檢視器的隔離` --semantically_similar_to--> `生成程式跑在 opaque origin 的 iframe`  [INFERRED] [semantically similar]
  app/renderer/pdfview.html → README.md
- `runConvert()` --indirect_call--> `doc()`  [INFERRED]
  app/renderer/pdfview.js → test/pdfmd.test.js
- `PDF 檢視器的隔離` --conceptually_related_to--> `主程序邊界（四件事 renderer 拿不到）`  [INFERRED]
  app/renderer/pdfview.html → README.md
- `列印時把每頁畫成圖` --conceptually_related_to--> `PDF 匯出（printToPDF）`  [INFERRED]
  app/renderer/pdfview.html → README.md
- `授權視窗的 CSP` --semantically_similar_to--> `shell 的 Content-Security-Policy`  [INFERRED] [semantically similar]
  app/renderer/consent.html → app/renderer/index.html

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **授權與汙染的主程序防線** — readme_capability_gate, readme_taint_downgrade, readme_elevated_capabilities, readme_consent_window, readme_main_process_boundary, app_main_gate [EXTRACTED 1.00]
- **三個介面共用的表格堆疊** — readme_grid_algebra, readme_cell_picker, readme_shared_borders, readme_merged_cells, readme_palette, app_renderer_surfaces [EXTRACTED 1.00]
- **供應商抽象層** — readme_model_provider, readme_provider_described_not_branched, readme_transport_in_main_process, readme_thinking_ladder, readme_output_cap_provider_owned, readme_rejected_field_dropping [EXTRACTED 1.00]

## Communities (49 total, 1 thin omitted)

### Community 0 - "簡報應用程式"
Cohesion: 0.06
Nodes (106): addObject(), addSlide(), addTable(), adopt(), blank(), borderPopover(), buildBody(), buildDeck() (+98 more)

### Community 1 - "試算表應用程式"
Cohesion: 0.06
Nodes (90): activate(), addSheet(), applyBorder(), applyFormat(), beginEdit(), blankSheet(), blockWidth(), bookCells() (+82 more)

### Community 2 - "文件應用程式"
Cohesion: 0.08
Nodes (85): after(), applyBlockFormat(), applyFont(), applyFontStyle(), applyPara(), applyParaSpec(), applyParaStyle(), applyRun() (+77 more)

### Community 3 - "公式引擎"
Cohesion: 0.06
Nodes (62): colToIndex(), dateSerial(), evaluate(), cmp(), looseEq(), walk(), expandRange(), first() (+54 more)

### Community 4 - "模型供應商與傳輸"
Cohesion: 0.06
Nodes (65): applyPreset(), applyReasoning(), authOf(), backlog, baseOf(), capFieldOf(), chatActive(), checkBase() (+57 more)

### Community 5 - "PDF 剖析與抽字"
Cohesion: 0.06
Nodes (54): a85Decode(), contentTokens(), crypto, decodeTextString(), decodeWithFont(), DELIM, Doc, emptyReason() (+46 more)

### Community 6 - "共用面板與視窗管理"
Cohesion: 0.07
Nodes (52): build(), cellAt(), chip(), choose(), close(), closeAll(), done(), dragify() (+44 more)

### Community 7 - "瀏覽器視圖、syscall 邊界與模型預設檔"
Cohesion: 0.06
Nodes (48): applyToPage(), create(), destroy(), destroyAll(), get(), goBack(), goForward(), hide() (+40 more)

### Community 8 - "沙箱檔案系統"
Cohesion: 0.11
Nodes (50): assertQuota(), assertUnchanged(), copy(), dropOrigin(), fail(), find(), FIND_LIMITS, flushOrigins() (+42 more)

### Community 9 - "端對端測試骨架"
Cohesion: 0.09
Nodes (35): launch(), launchClean(), launchPortable(), newerThanBuild(), newestPortable(), ROOT, connect(), evaluate() (+27 more)

### Community 10 - "公式、Markdown 與沙箱測試"
Cohesion: 0.04
Nodes (38): 兩套測試：讀原始碼的與跑真程式的, AIOS, assert, fs, path, sandboxGlobals, test, vm (+30 more)

### Community 11 - "視窗 AI 對話面板與工作階段"
Cohesion: 0.08
Nodes (40): fs, init(), num(), path, sanitise(), save(), stat(), truncate() (+32 more)

### Community 12 - "PDF 檢視器算繪"
Cohesion: 0.11
Nodes (42): boot(), describeError(), doPrint(), draw(), elNote, elPages, elScroll, elVeil (+34 more)

### Community 13 - "郵件 IMAP/SMTP 與網頁抓取"
Cohesion: 0.11
Nodes (37): addr(), appendToSent(), cache, configure(), decodeBody(), folders(), forget(), fs (+29 more)

### Community 14 - "專案相依與建置設定"
Cohesion: 0.05
Nodes (37): electron, electron-builder, imapflow, nodemailer, _comment:build, dependencies, imapflow, nodemailer (+29 more)

### Community 15 - "能力閘門與授權"
Cohesion: 0.08
Nodes (30): askBatch(), askUser(), authorize(), { BrowserWindow, ipcMain }, CAP_NOTES, decide(), DEFAULT_POLICY, ELEVATED (+22 more)

### Community 16 - "郵件本機鏡像"
Cohesion: 0.08
Nodes (29): accountKey(), body(), crypto, cursor(), flush(), fs, get(), init() (+21 more)

### Community 17 - "意圖核心與 context 預算"
Cohesion: 0.09
Nodes (19): abort(), bridge(), buildMessages(), clearTaint(), complete(), drop(), estimate(), extract() (+11 more)

### Community 18 - "App Forge 主程序"
Cohesion: 0.10
Nodes (26): APP_CAP_NOTES, APP_CAPS, approveCurrent(), assertSlug(), CAPS_REACHING_OUT, capsNeedingConsent(), crypto, frames (+18 more)

### Community 19 - "Markdown 檢視器"
Cohesion: 0.15
Nodes (31): appendText(), cssEscape(), el(), escapeHtml(), exportHtml(), findClose(), imageNode(), imageNote() (+23 more)

### Community 20 - "OOXML 讀寫核心"
Cohesion: 0.09
Nodes (24): ALIGN_ATTR, BUILTIN_NUMFMT, DOCX_STYLE, DOCX_STYLE_BACK, EDGE_TAG, EDGES, HIGHLIGHTS, IMG_TYPES (+16 more)

### Community 21 - "生成程式沙箱與 broker"
Cohesion: 0.13
Nodes (26): allowed(), askAction(), finish(), onMsg(), askSmoke(), finish(), onMsg(), bootstrapSource() (+18 more)

### Community 22 - "開機序列與意圖回合"
Cohesion: 0.12
Nodes (22): autoGrow(), closeTurn(), contentGained(), contentPrint(), el(), gateAndExec(), marks(), menu() (+14 more)

### Community 23 - "主程序生命週期"
Cohesion: 0.13
Nodes (26): { app, BrowserWindow, ipcMain, protocol, shell, session: electronSession }, APP_ROOT, ARGS, beginShutdown(), bookmarks, browser, createWindow(), dataHome() (+18 more)

### Community 24 - "接線測試與主題對比"
Cohesion: 0.09
Nodes (17): 版面與配色寫成可照做的規則, --on-fill 主題變數, AIOS.palette 文件配色, APP, assert, contrast(), forge, fs (+9 more)

### Community 25 - "App Forge 建置介面"
Cohesion: 0.20
Nodes (24): checkCode(), cleanCode(), create(), el(), generateCode(), makeCode(), makeSpec(), refresh() (+16 more)

### Community 26 - "PDF 應用程式視窗"
Cohesion: 0.18
Nodes (22): askConvert(), drain(), dropGrant(), el(), find(), goToPage(), markMatches(), onFrameMessage() (+14 more)

### Community 27 - "PDF 轉 Markdown"
Cohesion: 0.16
Nodes (23): bodySize(), classify(), collapse(), convert(), dedupe(), docTitle(), emit(), emitTable() (+15 more)

### Community 28 - "長期記憶儲存"
Cohesion: 0.15
Nodes (19): add(), findSimilar(), flush(), fs, importAll(), init(), learn(), markUsed() (+11 more)

### Community 29 - "文字編輯器"
Cohesion: 0.29
Nodes (20): activate(), closeTab(), cur(), el(), ext(), findNext(), findReplace(), insert() (+12 more)

### Community 30 - "瀏覽器應用程式視窗"
Cohesion: 0.25
Nodes (17): activate(), closeSheet(), el(), ensureTab(), hostOf(), navigate(), newSheet(), onEvent() (+9 more)

### Community 31 - "檔案總管"
Cohesion: 0.26
Nodes (18): duplicate(), el(), ext(), icon(), join(), nav(), newFile(), newFolder() (+10 more)

### Community 32 - "書籤儲存"
Cohesion: 0.18
Nodes (12): add(), cleanUrl(), crypto, flush(), fromHtml(), fs, has(), idOf() (+4 more)

### Community 33 - "preload 橋接、HUD 與記憶視窗"
Cohesion: 0.15
Nodes (8): { contextBridge, ipcRenderer, webUtils }, el(), publish(), refresh(), render(), el(), line(), paint()

### Community 34 - "郵件應用程式視窗"
Cohesion: 0.30
Nodes (12): accountForm(), boot(), compose(), el(), intoContext(), loadFolder(), localEdit(), openMessage() (+4 more)

### Community 35 - "桌面殼層與 shell 文件"
Cohesion: 0.16
Nodes (11): 開機序列畫面, 右側 HUD（核心軌跡 / 動作日誌）, 意圖列, renderer 腳本相依順序, shell 文件 index.html, el(), renderLauncher(), step() (+3 more)

### Community 36 - "OOXML：xlsx 產出與欄寬換算"
Cohesion: 0.23
Nodes (13): charsToPx(), colToIndex(), indexToCol(), pxToChars(), readSheetXml(), writeXlsx(), internBorder(), internFill() (+5 more)

### Community 37 - "OOXML：pptx 產出"
Cohesion: 0.29
Nodes (13): decodeDataUri(), esc(), paras(), pctX(), pctY(), pictureXml(), rPr(), solid() (+5 more)

### Community 38 - "授權視窗與窄橋"
Cohesion: 0.22
Nodes (7): { contextBridge, ipcRenderer }, 授權視窗的 CSP, 授權視窗文件 consent.html, el(), renderBatch(), 授權刻意不在這份文件裡呈現, 授權視窗（主程序 modal）

### Community 39 - "文件自我檢查測試"
Cohesion: 0.18
Nodes (9): assert, CN, fs, gate, HANDOVER, path, README, ROOT (+1 more)

### Community 40 - "能力邊界與汙染的概念"
Cohesion: 0.25
Nodes (9): Dock, 能力閘門, ELEVATED 能力, 例外：你自己指名的目標, 雲端核心的代價要講清楚, 搜尋沙箱（fs.find）, 種子 prompt injection 假請款單, 26 個系統呼叫（OPS 表） (+1 more)

### Community 41 - "OOXML：框線算術與 xlsx 讀取"
Cohesion: 0.32
Nodes (8): borderKey(), eighths(), normBorder(), normEdge(), readTcBorders(), readXlsx(), tcBordersXml(), xlsxBorderEdge()

### Community 42 - "zip 容器與 PowerPoint 匯出"
Cohesion: 0.32
Nodes (6): crc32(), CRC_TABLE, dosTime(), write(), zlib, PowerPoint 匯出（.pptx）

### Community 43 - "應用程式註冊表與分頁"
Cohesion: 0.32
Nodes (6): editMenuFor(), paste(), restore(), el(), makeContext(), 為什麼是分頁不是視窗

### Community 44 - "aios-app scheme 與程式完整性"
Cohesion: 0.25
Nodes (8): shell 的 Content-Security-Policy, frame-src aios-app: aios-pdf:, aios-app:// scheme, App Forge, 設定刻意放在沙箱外, 完整性：能寫檔案 ≠ 能安裝程式, 第 3 步先問「這是 JavaScript 嗎」, AIOS.images 圖片管線

### Community 45 - "OOXML：docx 產出"
Cohesion: 0.48
Nodes (6): fontXml(), hex6(), sizeXml(), writeDocx(), run(), runs()

### Community 46 - "Office 往返測試"
Cohesion: 0.33
Nodes (6): assert, DECK, office, opc(), test, zip

### Community 47 - "汙染集追蹤"
Cohesion: 0.67
Nodes (4): addTaint(), clearTaint(), onTaintChange(), taintState()

## Knowledge Gaps
- **242 isolated node(s):** `fs`, `path`, `crypto`, `items`, `{ WebContentsView, session, shell }` (+237 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `兩套測試：讀原始碼的與跑真程式的` connect `公式、Markdown 與沙箱測試` to `接線測試與主題對比`, `端對端測試骨架`, `Office 往返測試`?**
  _High betweenness centrality (0.138) - this node is a cross-community bridge._
- **Why does `--n-cpu-moe 調校` connect `專案相依與建置設定` to `模型供應商與傳輸`?**
  _High betweenness centrality (0.045) - this node is a cross-community bridge._
- **What connects `fs`, `path`, `crypto` to the rest of the system?**
  _242 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `簡報應用程式` be split into smaller, more focused modules?**
  _Cohesion score 0.05929323819232076 - nodes in this community are weakly interconnected._
- **Should `試算表應用程式` be split into smaller, more focused modules?**
  _Cohesion score 0.060087719298245613 - nodes in this community are weakly interconnected._
- **Should `文件應用程式` be split into smaller, more focused modules?**
  _Cohesion score 0.08366746859128575 - nodes in this community are weakly interconnected._
- **Should `公式引擎` be split into smaller, more focused modules?**
  _Cohesion score 0.060362173038229376 - nodes in this community are weakly interconnected._