@echo off
rem ===================================================================
rem  potbot mobile Word demo -- build the Android debug APK (S1)
rem
rem  Wrapper for android-build.ps1.
rem  Why this exists: on a default Windows client the effective
rem  PowerShell execution policy is "Restricted", so
rem      powershell -NoProfile -File scripts\demo\android-build.ps1
rem  FAILS with "running scripts is disabled on this system"
rem  (FullyQualifiedErrorId: UnauthorizedAccess, exit code 1).
rem  This wrapper runs the .ps1 with -ExecutionPolicy Bypass so the
rem  script can simply be double-clicked or typed as one line.
rem
rem  Usage:
rem      scripts\demo\android-build.cmd
rem      scripts\demo\android-build.cmd -Offline
rem
rem  Exit code is the real exit code of the .ps1 (0 = build ok).
rem ===================================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0android-build.ps1" %*
exit /b %ERRORLEVEL%
