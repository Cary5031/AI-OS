# 參與開發

謝謝你願意幫忙。這份說明開發環境、測試，以及送修改之前要注意的事。

## 環境

- Windows 10／11 x64。應用程式、打包與端對端測試都只在 Windows 上跑過。
- Node.js 24（開發與 CI 用的版本），`npm install` 裝好相依。
- 要測到意圖解析才需要核心模型，見 [README](README.md#快速開始)。沒有模型也能開機，
  大部分測試也用不到它。

## 測試

```powershell
npm test            # 單元測試：讀原始碼，檢查接線與不變式，幾秒就跑完
npm run test:e2e    # 端對端：真的啟動程式，用 CDP 驅動
```

- 兩套都要過。修 bug 的話，先寫一個能重現它的測試，再修。
- 跑 `npm run test:e2e` 時，不要把桌面鎖起來或把視窗最小化：視窗看不到時 Chromium
  會把計時器降到每秒一次、停掉畫面更新，測試會慢到逾時，那不是程式碼的問題。
- `test/docs.test.js` 會拿文件核對程式碼。新增測試檔、e2e spec、系統呼叫、內建程式
  或原始碼檔案時，要一起更新 `docs/README.md` 裡對應的表格與數字；測試失敗的訊息會
  說哪一處對不上。

## 寫法

- 照周圍的程式碼寫：命名、註解的多寡與慣用法都跟著既有的檔案走。註解寫「為什麼」，
  特別是踩過的坑與實測過的數字。
- 介面文字用繁體中文。
- 文字檔一律 LF，`.gitattributes` 會處理；`.bat` 是 CRLF，而且只用 ASCII（原因寫在
  `Build-AIOS.bat` 裡）。
- 透過 shell 寫檔要小心：PowerShell 的雙引號 here-string 會把反引號當成跳脫字元吃掉。
  用單引號的 `@'...'@`，或乾脆不要經過 shell。

## 不要提交的東西

- `app/preset/provider-preset.enc`（內建模型預設檔，裡面有 API 金鑰）、`sandbox/`
  （你自己的檔案）、`dist/`。這些都已經在 `.gitignore` 裡。
- 任何 API 金鑰、密碼、真實的郵件內容。測試資料請用 `example.com` 這類保留給範例的網域。

## 送出修改

- 一個 pull request 做一件事，寫清楚改了什麼、為什麼，以及你怎麼確認它有效。
- 安全問題請不要開公開的 issue，見 [SECURITY.md](SECURITY.md)。

送進來的修改以與本專案相同的 [MIT 授權](LICENSE)釋出。
