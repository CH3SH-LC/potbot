@echo off
rem ===================================================================
rem  potbot mobile Word demo -- Wi-Fi fallback readiness check (S1)
rem
rem  Wrapper for lan-check.ps1. Read-only: does NOT start or stop any
rem  service and does NOT add, change or delete any firewall rule.
rem  Needed because the default Windows execution policy is "Restricted".
rem
rem  Usage:
rem      scripts\demo\lan-check.cmd
rem      scripts\demo\lan-check.cmd -Port 18765
rem      scripts\demo\lan-check.cmd -SkipFirewall
rem
rem  Exit codes: 0 = reachable, 2 = not reachable, 3 = cannot determine.
rem ===================================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0lan-check.ps1" %*
exit /b %ERRORLEVEL%
