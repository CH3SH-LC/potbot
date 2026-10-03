@echo off
rem ===================================================================
rem  potbot mobile Word demo -- detect a USB-connected Android device (S1)
rem
rem  Wrapper for device-check.ps1 (read-only; changes nothing).
rem  Needed because the default Windows execution policy is "Restricted".
rem
rem  Usage:
rem      scripts\demo\device-check.cmd
rem
rem  Exit codes: 0 = exactly one usable device, 2 = no usable device,
rem              3 = more than one usable device, 1 = adb failed.
rem ===================================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0device-check.ps1" %*
exit /b %ERRORLEVEL%
