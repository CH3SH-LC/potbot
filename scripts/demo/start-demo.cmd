@echo off
rem ============================================================================
rem potbot mobile Word demo - launcher wrapper.
rem
rem WHY THIS FILE EXISTS
rem   This machine's PowerShell execution policy is Restricted (all scopes
rem   Undefined), so `powershell -NoProfile -File start-demo.ps1` exits 1 with
rem   "running scripts is disabled on this system". A .ps1 cannot lift that
rem   restriction on itself, so this wrapper starts PowerShell with
rem   -ExecutionPolicy Bypass, which applies to THIS process only and does not
rem   change any machine or user setting.
rem
rem USAGE
rem   scripts\demo\start-demo.cmd                     local browser only
rem   scripts\demo\start-demo.cmd -Bind 0.0.0.0       phone on the same Wi-Fi
rem   scripts\demo\start-demo.cmd -SkipBuild          reuse the last build
rem
rem   All arguments are passed through unchanged (%*).
rem
rem ENCODING: pure ASCII, no BOM, CRLF. This file must never contain non-ASCII
rem   characters: cmd.exe decodes it with the active code page (GBK here), so
rem   non-ASCII text would be garbled or break parsing. All Chinese output comes
rem   from start-demo.ps1, which is UTF-8 with BOM.
rem ============================================================================

setlocal
rem Switch this console to UTF-8 so Chinese from PowerShell and from node land
rem as one consistent stream. Without it the console code page (936/GBK here)
rem and node's UTF-8 output disagree, and one of the two looks garbled.
rem `>nul` hides chcp's own status line; failure is non-fatal by design.
chcp 65001 >nul 2>&1

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-demo.ps1" %*
exit /b %ERRORLEVEL%
