@echo off
setlocal
rem Build the version-locked x86 bridge. No device commands run here.
for %%I in ("%~dp0..\..") do set "_HONOR_ROOT=%%~fI"
set "_HONOR_OUT=%_HONOR_ROOT%\.runtime\honor-hdb"
if not exist "%_HONOR_OUT%" mkdir "%_HONOR_OUT%"
if errorlevel 1 exit /b 1
rem Remove the previous executable first: failed builds must never use it.
if exist "%_HONOR_OUT%\honor-hdb-native.exe" del /q "%_HONOR_OUT%\honor-hdb-native.exe"
if exist "%_HONOR_OUT%\honor-hdb-native.exe" exit /b 1
if exist "%_HONOR_OUT%\honor-hdb-native.building.exe" del /q "%_HONOR_OUT%\honor-hdb-native.building.exe"
if exist "%_HONOR_OUT%\honor-hdb-native.building.exe" exit /b 1
set "_HONOR_VS="
if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" for /f "usebackq tokens=*" %%I in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "_HONOR_VS=%%I"
if not defined _HONOR_VS set "_HONOR_VS=C:\Program Files\Microsoft Visual Studio\2022\Community"
if not exist "%_HONOR_VS%\VC\Auxiliary\Build\vcvars32.bat" goto missing_compiler
call "%_HONOR_VS%\VC\Auxiliary\Build\vcvars32.bat" >nul
if errorlevel 1 exit /b %ERRORLEVEL%
cl /nologo /W4 /MD /O2 /EHsc /D_ITERATOR_DEBUG_LEVEL=0 /D_CRT_SECURE_NO_WARNINGS /D_WIN32_WINNT=0x0602 /Fo"%_HONOR_OUT%\honor-hdb-native.obj" /Fd"%_HONOR_OUT%\honor-hdb-native.pdb" /Fe"%_HONOR_OUT%\honor-hdb-native.building.exe" "%~dp0honor-hdb-native.cpp"
if errorlevel 1 goto compile_failed
if not exist "%_HONOR_OUT%\honor-hdb-native.building.exe" exit /b 1
move /y "%_HONOR_OUT%\honor-hdb-native.building.exe" "%_HONOR_OUT%\honor-hdb-native.exe" >nul
if errorlevel 1 exit /b %ERRORLEVEL%
echo Built .runtime\honor-hdb\honor-hdb-native.exe
exit /b 0
:compile_failed
set "_HONOR_EXIT=%ERRORLEVEL%"
if exist "%_HONOR_OUT%\honor-hdb-native.building.exe" del /q "%_HONOR_OUT%\honor-hdb-native.building.exe"
exit /b %_HONOR_EXIT%
:missing_compiler
echo Visual Studio C++ x86 build tools were not found. 1>&2
exit /b 2
