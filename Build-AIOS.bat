@echo off
rem ===========================================================================
rem  AI-OS rebuild launcher.
rem
rem  Deliberately ASCII-only. cmd.exe parses a .bat byte by byte using the OEM
rem  code page -- CP950 on a zh-TW machine -- so a UTF-8 Chinese character in
rem  here is read as two bytes of garbage and its continuation byte can be taken
rem  for a command separator. `chcp 65001` inside the file does not help: cmd has
rem  already begun parsing by the time it runs. Saving as CP950 would work on
rem  this machine and break on any other.
rem
rem  So this file does one thing in plain ASCII and hands over to PowerShell.
rem  PowerShell 7 reads UTF-8 everywhere; Windows PowerShell 5.1, the fallback
rem  below, reads it only after a byte-order mark, which is why Build-AIOS.ps1
rem  starts with one (test/wiring.test.js checks). The real work is in there.
rem ===========================================================================

set "ELECTRON_RUN_AS_NODE="

where pwsh >nul 2>nul
if not errorlevel 1 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-AIOS.ps1" %*
  goto :eof
)

where powershell >nul 2>nul
if not errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-AIOS.ps1" %*
  goto :eof
)

echo.
echo   PowerShell not found. Install PowerShell 7:
echo   https://github.com/PowerShell/PowerShell/releases
echo.
pause
