<#
.SYNOPSIS
    potbot 手机 Word Demo —— 构建 Android 调试 APK（S1）。

.DESCRIPTION
    在**本 PowerShell 子进程内**临时设置 JAVA_HOME / ANDROID_HOME / ANDROID_SDK_ROOT，
    然后调用 Gradle 绝对入口执行 assembleDebug。不修改机器级或用户级环境变量。

    成功时打印 APK 的绝对路径与 SHA256；失败时如实以 Gradle 的真实退出码结束，
    并原样打印 Gradle 的错误输出——脚本**不会**伪造成功。

.PARAMETER Offline
    传 -Offline 时给 Gradle 加 --offline，只用本机缓存解析依赖。
    默认不加：本机缓存缺 org.jetbrains.kotlin:kotlin-reflect:1.9.20 与
    kotlin-stdlib:1.9.20（AGP 8.7.3 的传递依赖），--offline 会直接失败。

.PARAMETER GradleTask
    要执行的 Gradle 任务，默认 assembleDebug。

.EXAMPLE
    powershell -NoProfile -File scripts/demo/android-build.ps1
#>
[CmdletBinding()]
param(
    [switch]$Offline,
    [string]$GradleTask = 'assembleDebug',
    [string]$JavaHome = 'C:\Program Files\Java\jdk-21.0.11',
    [string]$AndroidSdk = 'D:\android-sdk'
)

$ErrorActionPreference = 'Continue'

# 控制台编码：让 Gradle 的中文 javac 注记不变成乱码（仅影响本进程）。
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

function Fail([string]$Message, [int]$Code) {
    Write-Host ''
    Write-Host "== android-build FAILED ==" -ForegroundColor Red
    Write-Host $Message
    exit $Code
}

# ---- 1. 解析仓库根（scripts/demo -> 仓库根）----
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$projectDir = Join-Path $repoRoot 'apps\android'

if (-not (Test-Path -LiteralPath $projectDir)) {
    Fail "找不到 Android 工程目录：$projectDir" 11
}

# ---- 2. 校验工具链绝对入口 ----
$gradleBat = Join-Path $AndroidSdk 'gradle-8.9\bin\gradle.bat'
if (-not (Test-Path -LiteralPath $gradleBat)) {
    Fail "找不到 Gradle 入口：$gradleBat" 12
}
if (-not (Test-Path -LiteralPath $JavaHome)) {
    Fail "找不到 JDK 目录：$JavaHome" 13
}
if (-not (Test-Path -LiteralPath $AndroidSdk)) {
    Fail "找不到 Android SDK 目录：$AndroidSdk" 14
}

# ---- 3. 只在子进程内设置环境（不改全局）----
$env:JAVA_HOME       = $JavaHome
$env:ANDROID_HOME    = $AndroidSdk
$env:ANDROID_SDK_ROOT = $AndroidSdk
$env:GRADLE_OPTS     = '-Dfile.encoding=UTF-8'

Write-Host '== android-build =='
Write-Host "repoRoot    : $repoRoot"
Write-Host "projectDir  : $projectDir"
Write-Host "JAVA_HOME   : $env:JAVA_HOME"
Write-Host "ANDROID_HOME: $env:ANDROID_HOME"
Write-Host "gradle      : $gradleBat"
Write-Host "task        : $GradleTask  (offline=$($Offline.IsPresent -eq $true))"
Write-Host ''

# ---- 4. 调用 Gradle ----
$gradleArgs = @('--no-daemon')
if ($Offline) { $gradleArgs += '--offline' }
$gradleArgs += @('-p', $projectDir, $GradleTask)

& $gradleBat @gradleArgs
$gradleExit = $LASTEXITCODE

Write-Host ''
if ($gradleExit -ne 0) {
    Fail "Gradle 退出码 $gradleExit（任务 $GradleTask 未通过）。以上为 Gradle 原始输出。" $gradleExit
}

# ---- 5. 定位 APK 并给出摘要 ----
$apk = Join-Path $projectDir 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path -LiteralPath $apk)) {
    Fail "Gradle 报告成功，但未找到预期 APK：$apk（不视为构建通过）" 15
}

$apkItem = Get-Item -LiteralPath $apk
$hash = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash
$absolute = $apkItem.FullName

Write-Host '== android-build OK ==' -ForegroundColor Green
Write-Host "APK_PATH   : $absolute"
Write-Host "APK_BYTES  : $($apkItem.Length)"
Write-Host "APK_SHA256 : $hash"
Write-Host "APK_MTIME  : $($apkItem.LastWriteTime.ToString('s'))"
Write-Host "GRADLE_EXIT: $gradleExit"

exit 0
