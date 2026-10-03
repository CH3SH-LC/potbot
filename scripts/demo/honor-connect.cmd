@echo off
setlocal
node "%~dp0honor-connect.mjs" %*
exit /b %errorlevel%
