@echo off
rem ============================================================================
rem potbot mobile-ui spike - serve the composition root (design-07 v6 shell).
rem
rem SPIKE / throwaway delivery shim. Does NOT touch apps/demo/**, apps/android/**
rem or src/**. No kernel, no secrets, no user files.
rem
rem Run from the repo root. Prints the URL and keeps running until Ctrl+C.
rem ============================================================================
setlocal
chcp 65001 >nul 2>&1
node "%~dp0serve-mobile-ui.mjs" %*
exit /b %ERRORLEVEL%
