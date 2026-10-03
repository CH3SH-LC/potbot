@echo off
rem ===================================================================
rem  potbot FA-E2E-DEVICE-SMOKE -- one-command device smoke
rem
rem  Wrapper for scripts\device\smoke.mjs (same split as
rem  scripts\demo\android-build.cmd -> android-build.ps1): a plain
rem  "node ..." line so it can be typed as one command or double
rem  clicked, with no dependence on the PowerShell execution policy.
rem
rem  Usage:
rem      scripts\device\smoke.cmd
rem      scripts\device\smoke.cmd --skip-build
rem      scripts\device\smoke.cmd --out .dev-evidence\device-smoke\smoke-summary.json
rem
rem  Exit code is the real exit code of smoke.mjs (0 = every required
rem  step passed; 2 = at least one step failed, see the JSON summary;
rem  1 = the wrapper itself could not find node).
rem ===================================================================
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo node.exe was not found on PATH. 1>&2
  exit /b 1
)
node "%~dp0smoke.mjs" %*
exit /b %ERRORLEVEL%
