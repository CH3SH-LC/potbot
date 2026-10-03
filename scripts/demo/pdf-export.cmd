@echo off
rem ===================================================================
rem  potbot -- WF-089 PDF export / WF-090 print handoff (real engine, opt-in)
rem
rem  Wrapper for pdf-export.ps1. Needed because the default Windows
rem  execution policy is "Restricted".
rem
rem  Usage:
rem      scripts\demo\pdf-export.cmd
rem
rem  Starts Microsoft Word 16.0.20430 via COM to export a real PDF, reads it
rem  back independently with pypdf, then hands it to the default PDF handler.
rem  It opens your default PDF viewer and **claims nothing about printing**.
rem
rem  Exit code: the vitest exit code (0 = all opt-in cases passed).
rem ===================================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0pdf-export.ps1" %*
exit /b %ERRORLEVEL%
