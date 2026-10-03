@echo off
rem ===================================================================
rem  potbot mobile Word demo -- install APK + adb reverse + launch (S1)
rem
rem  *** THIS SCRIPT WRITES TO A REAL PHONE. ***
rem  Coordinator only. Every adb call is pinned with -s <serial>;
rem  it refuses to guess when zero or multiple devices are present.
rem
rem  Wrapper for install-demo.ps1.
rem  Needed because the default Windows execution policy is "Restricted".
rem
rem  Usage:
rem      scripts\demo\install-demo.cmd
rem      scripts\demo\install-demo.cmd -Serial <serial>
rem      scripts\demo\install-demo.cmd -SkipInstall      (relaunch only)
rem
rem  Exit codes: 0 = ok, 2 = no usable device, 3 = ambiguous serial,
rem              4 = APK missing (run android-build.cmd first),
rem              1 = adb failed, 5 = install output had no "Success",
rem              6 = activity launch failed.
rem ===================================================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-demo.ps1" %*
exit /b %ERRORLEVEL%
