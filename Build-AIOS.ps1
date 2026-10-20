# ===========================================================================
#  AI-OS 重新建置
#  ---------------------------------------------------------------------------
#  改完程式之後雙擊 Build-AIOS.bat，就會跑測試並重新打包。
#  這支腳本是實際做事的地方；那個 .bat 只是一個純 ASCII 的轉接殼，
#  原因寫在它自己的註解裡。
#
#  每跑一次就發一版：版本號在打包前自動遞增，所以每個產出的 exe 都有自己的
#  版本，不會出現兩個不同的檔案掛同一個號碼。遞增在測試通過之後、打包之前做
#  —— 沒過測試的東西不是一版。
#
#  參數：
#    -NoTest      跳過測試（趕時間時用，但不建議）
#    -NoBump      不遞增版本（重出同一版時用）
#    -Minor       次版號 +1（0.9.3 -> 0.10.0），預設是修訂號 +1
#    -Major       主版號 +1（0.9.3 -> 1.0.0）
#    -Version     直接指定版本，例如 -Version 1.2.0
#    -Portable    只出免安裝版
#    -Setup       只出安裝檔
#    -WithPreset  帶上 app\preset\provider-preset.enc。裡面有 API 金鑰，拿到這一版
#                 的人都還原得出來，所以只給信得過的人；沒加這個參數而檔案存在，
#                 建置會在跑測試之前就停下來。
# ===========================================================================

[CmdletBinding()]
param(
  [switch]$NoTest,
  [switch]$NoBump,
  [switch]$Minor,
  [switch]$Major,
  [string]$Version,
  [switch]$Portable,
  [switch]$Setup,
  [switch]$WithPreset
)

# 從 IDE 終端啟動的子行程會帶著 ELECTRON_RUN_AS_NODE，而它會讓 require('electron')
# 回傳執行檔路徑字串而不是 API，讓建置在離真正原因很遠的地方爆掉。
$env:ELECTRON_RUN_AS_NODE = $null

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()

function Say($text, $kind = 'info') {
  $colour = switch ($kind) {
    'ok'   { 'Green' }
    'warn' { 'Yellow' }
    'err'  { 'Red' }
    default { 'Gray' }
  }
  $mark = switch ($kind) {
    'ok'   { '[v]' }
    'warn' { '[!]' }
    'err'  { '[x]' }
    default { '   ' }
  }
  Write-Host "  $mark $text" -ForegroundColor $colour
}

function Stop-Here($message) {
  Write-Host ''
  Say $message 'err'
  Write-Host ''
  if ($Host.UI.RawUI) { Read-Host '  按 Enter 關閉' | Out-Null }
  exit 1
}

function Get-AppVersion {
  # 從 package.json 問，而不是自己解析檔案：electron-builder 也是問同一個地方，
  # 兩邊看到的版本必須是同一個。
  return (node -p "require('./package.json').version").Trim()
}

$startVersion = Get-AppVersion

Write-Host ''
Write-Host '  AI-OS 建置' -ForegroundColor Cyan
Write-Host '  ============================================================'
Write-Host "  目錄  $PWD"
Write-Host "  版本  $startVersion"
Write-Host ''

# ------------------------------------------------------------------ 前置檢查

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Stop-Here '找不到 node。請先安裝 Node.js 24：https://nodejs.org/'
}
Say "node $(node -v)" 'ok'

# electron-builder 是打包用的，只在 devDependencies 裡；沒裝就是還沒 npm install。
if (-not (Test-Path 'node_modules\electron-builder')) {
  Say '相依套件不齊，執行 npm install…' 'warn'
  npm install
  if ($LASTEXITCODE -ne 0) { Stop-Here 'npm install 失敗' }
}
Say '相依套件就緒' 'ok'

# ------------------------------------------------------------ 內建模型預設檔

# 預設檔裡有 API 金鑰，而拿到建置結果的人都還原得出來（原因見 app\main\preset.js）。
# 真正擋住打包的是 electron-builder 的 beforePack（build\preset-guard.js），
# npm run dist 也會經過它；這裡先查一次，免得跑完好幾分鐘的測試才在打包那一步停下來。
# 只有 -WithPreset 會放行：環境裡剛好留著的 AIOS_SHIP_PRESET 不算數。
# 放行的那個變數只在打包那一步設定、打包完就清掉（見「打包」）。直接在 pwsh 裡跑
# 這支腳本的時候，環境變數會留在那個視窗裡；以前設了不清，同一個視窗之後再跑一次
# npm run dist，就會在沒有人加 -WithPreset 的情況下把金鑰打包進去。
$env:AIOS_SHIP_PRESET = $null
$shipPreset = $false
$presetFile = 'app\preset\provider-preset.enc'
if (Test-Path $presetFile) {
  if ($WithPreset) {
    $shipPreset = $true
    Say '這一版會帶著內建模型預設檔（-WithPreset）：拿到它的人都還原得出裡面的金鑰' 'warn'
  } else {
    Stop-Here "$presetFile 存在，打包會把裡面的 API 金鑰一起帶進去。要公開發佈就先把它移走；只給信得過的人、確定要帶的話加 -WithPreset。"
  }
} elseif ($WithPreset) {
  Say "-WithPreset：可是 $presetFile 不存在，這一版不會帶預設檔" 'warn'
}

# ---------------------------------------------------------------------- 測試

if ($NoTest) {
  Say '跳過測試（-NoTest）' 'warn'
} else {
  Write-Host ''
  Write-Host '  單元測試…'
  npm test
  if ($LASTEXITCODE -ne 0) {
    Stop-Here "測試沒過，建置中止。修好之後再跑一次；真的要先打包就加 -NoTest。"
  }
  Say '單元測試通過' 'ok'

  Write-Host ''
  Write-Host '  端對端測試（會真的啟動 app）…'
  npm run test:e2e
  if ($LASTEXITCODE -ne 0) {
    Stop-Here "端對端測試沒過，建置中止。這一關跑的是真的程式，不是讀原始碼。"
  }
  Say '端對端測試通過' 'ok'
}

# ---------------------------------------------------------------------- 版本

# 遞增在這裡：測試已經過了，還沒開始打包。順序是刻意的 ——
#   測試之前遞增，會讓沒過測試的東西也吃掉一個版號；
#   打包之後遞增，產出的 exe 會掛著舊號碼，下一版才用到新的，對不起來。
# 打包失敗的話這個號碼就算用掉了，這是划算的：號碼不值錢，
# 兩個內容不同的檔案掛同一個號碼才是麻煩。
$bumped = $false
if ($Version) {
  npm version $Version --no-git-tag-version --allow-same-version | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Here "版本設定失敗：$Version 不是合法的版本號" }
  $bumped = $true
} elseif (-not $NoBump) {
  $part = if ($Major) { 'major' } elseif ($Minor) { 'minor' } else { 'patch' }
  npm version $part --no-git-tag-version | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Here '版本遞增失敗' }
  $bumped = $true
}

$appVersion = Get-AppVersion
if ($bumped) {
  Say "版本 $startVersion -> $appVersion" 'ok'
} else {
  Say "版本維持 $appVersion（-NoBump）" 'warn'
}

# ---------------------------------------------------------------------- 打包

$target = @('--win')
if ($Portable) { $target = @('--win', 'portable') }
if ($Setup)    { $target = @('--win', 'nsis') }

Write-Host ''
Write-Host '  打包中（第一次會下載 Electron，約 144 MB）…'
Write-Host ''
if ($shipPreset) { $env:AIOS_SHIP_PRESET = '1' }
try {
  npx electron-builder @target
} finally {
  $env:AIOS_SHIP_PRESET = $null
}
if ($LASTEXITCODE -ne 0) {
  if ($bumped) {
    Say "注意：版本已經遞增到 $appVersion 了。要重出這一版就加 -NoBump。" 'warn'
  }
  Stop-Here '建置失敗，訊息在上面。'
}

# ------------------------------------------------------- 驗證剛建好的產物

# The first run of a packaged build is the path every new user takes and the one
# nobody exercises: a whole boot failure once shipped that way, invisible from
# the source tree. Run the suite against what was just built, in a throwaway
# directory, so a broken first run is caught here rather than by a user.
if (-not $NoTest -and -not $Setup) {
  Write-Host ''
  Write-Host '  驗證剛建好的免安裝版（乾淨資料夾、首次啟動）…'
  npm run test:e2e:packaged
  if ($LASTEXITCODE -ne 0) {
    Say '打包後的首次啟動測試沒過 — 產物已經在 dist\ 裡，但先別發出去。' 'err'
    Write-Host ''
    if ($Host.UI.RawUI) { Read-Host '  按 Enter 關閉' | Out-Null }
    exit 1
  }
  Say '打包版首次啟動正常' 'ok'
}

# ---------------------------------------------------------------------- 結果

Write-Host ''
Write-Host '  ============================================================'
Say "建置完成 — v$appVersion" 'ok'
Write-Host ''

# 這一版的產物先列，因為 dist\ 會隨著版本累積，而要拿去發佈的是這幾個。
$all = @(Get-ChildItem 'dist\*.exe' -ErrorAction SilentlyContinue)
$mine = @($all | Where-Object { $_.Name -like "*$appVersion*" })
foreach ($f in $mine) {
  '    {0,-34} {1,6:N1} MB' -f $f.Name, ($f.Length / 1MB) | Write-Host
}
$older = @($all | Where-Object { $_.Name -notlike "*$appVersion*" })
if ($older.Count) {
  Write-Host ''
  Say "dist\ 裡還有 $($older.Count) 個舊版本的檔案，要清理就自己刪。" 'warn'
}
Write-Host ''
Write-Host '    免安裝版：使用者的檔案在 exe 旁邊的 AI-OS-data\'
Write-Host '    安裝檔　：使用者的檔案在 %APPDATA%\ai-os'
Write-Host ''
Say '沒有程式碼簽章，第一次執行 SmartScreen 會擋一次：' 'warn'
Write-Host '      點「其他資訊」→「仍要執行」。'
Write-Host '  ============================================================'
Write-Host ''

$open = Read-Host '  要開啟 dist 資料夾嗎？(Y/N)'
if ($open -match '^[Yy]') { Start-Process explorer.exe (Join-Path $PWD 'dist') }
