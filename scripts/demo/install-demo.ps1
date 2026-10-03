<#
.SYNOPSIS
    potbot 手机 Word Demo —— 安装 APK、建立端口反向映射、启动 Activity（S1）。

.DESCRIPTION
    **只由主协调者运行。** 本脚本会对真机执行写操作（安装、reverse、启动），
    子智能体不得执行。

    所有 adb 调用都带 `-s <实际串号>`，精确指定目标设备：
    检测到零台或多台可用设备时直接报错退出，不猜、不挑第一台。

.PARAMETER Serial
    显式指定设备串号。不传时自动要求「恰好一台 device 状态设备」。

.PARAMETER Apk
    APK 路径。默认取仓库内 apps/android/app/build/outputs/apk/debug/app-debug.apk。

.PARAMETER Port
    反向映射端口，默认 8765（合同固定值）。

.PARAMETER SkipReverse
    不建立 adb reverse tcp:8765 tcp:8765。

.PARAMETER SkipLaunch
    安装后不启动 Activity。

.PARAMETER SkipInstall
    跳过安装，只做 reverse / 启动（用于已装好只想重开的场景）。

.EXAMPLE
    powershell -NoProfile -File scripts/demo/install-demo.ps1
#>
[CmdletBinding()]
param(
    [string]$Serial = '',
    [string]$Adb = 'D:\android-sdk\platform-tools\adb.exe',
    [string]$Apk = '',
    [int]$Port = 8765,
    [string]$Package = 'com.potbot.demo',
    [string]$Activity = 'com.potbot.demo.MainActivity',
    [switch]$SkipInstall,
    [switch]$SkipReverse,
    [switch]$SkipLaunch
)

$ErrorActionPreference = 'Continue'

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

function Fail([string]$Message, [int]$Code) {
    Write-Host ''
    Write-Host "== install-demo FAILED ==" -ForegroundColor Red
    Write-Host $Message
    exit $Code
}

if (-not (Test-Path -LiteralPath $Adb)) {
    Fail "找不到 adb：$Adb" 1
}

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent

# ---------------------------------------------------------------- 解析 APK
if ($SkipInstall) {
    $apkPath = $null
} else {
    if ([string]::IsNullOrWhiteSpace($Apk)) {
        $Apk = Join-Path $repoRoot 'apps\android\app\build\outputs\apk\debug\app-debug.apk'
    }
    if (-not (Test-Path -LiteralPath $Apk)) {
        Fail "找不到 APK：$Apk`n请先运行 powershell -NoProfile -File scripts/demo/android-build.ps1" 4
    }
    $apkPath = (Get-Item -LiteralPath $Apk).FullName
    $apkHash = (Get-FileHash -LiteralPath $apkPath -Algorithm SHA256).Hash
    $apkBytes = (Get-Item -LiteralPath $apkPath).Length
}

# ---------------------------------------------------------------- 选定设备
$raw = & $Adb devices -l 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    Fail "adb devices -l 执行失败，退出码 $LASTEXITCODE`n$raw" 1
}

$ready = @()
foreach ($line in ($raw -split "`r?`n")) {
    $t = $line.Trim()
    if ($t -eq '' -or $t -like 'List of devices*') { continue }
    $parts = $t -split '\s+'
    if ($parts.Count -lt 2) { continue }
    if ($parts[1] -eq 'device') {
        $ready += [pscustomobject]@{ Serial = $parts[0]; Detail = $t }
    }
}

if ([string]::IsNullOrWhiteSpace($Serial)) {
    if ($ready.Count -eq 0) {
        Fail "没有处于 device 状态的设备。请连接手机并接受 USB 调试授权后重试（可先跑 device-check.ps1）。`n$raw" 2
    }
    if ($ready.Count -gt 1) {
        $list = ($ready | ForEach-Object { $_.Serial }) -join ', '
        Fail "检测到多台可用设备（$list），拒绝猜测。请用 -Serial 显式指定目标设备。" 3
    }
    $Serial = $ready[0].Serial
} else {
    $match = $ready | Where-Object { $_.Serial -eq $Serial }
    if (-not $match) {
        Fail "指定的串号 $Serial 不在 device 状态设备列表中，拒绝继续。`n$raw" 3
    }
}

Write-Host '== install-demo =='
Write-Host "TARGET_SERIAL : $Serial"
if ($apkPath) {
    Write-Host "APK_PATH      : $apkPath"
    Write-Host "APK_BYTES     : $apkBytes"
    Write-Host "APK_SHA256    : $apkHash"
}
Write-Host "PORT_REVERSE  : $Port"
Write-Host ''

# ---------------------------------------------------------------- 安装
if (-not $SkipInstall) {
    Write-Host "--- adb -s $Serial install -r <apk> ---"
    $out = & $Adb -s $Serial install -r $apkPath 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Host $out.TrimEnd()
    if ($code -ne 0) {
        Fail "安装失败，adb 退出码 $code。" $code
    }
    if ($out -notmatch 'Success') {
        Fail "adb 退出码为 0，但输出未包含 Success，不视为安装成功。`n$out" 5
    }
    Write-Host 'INSTALL_RESULT: Success' -ForegroundColor Green
} else {
    Write-Host '跳过安装（-SkipInstall）。'
}

# ---------------------------------------------------------------- 端口反向映射
if (-not $SkipReverse) {
    Write-Host ''
    Write-Host "--- adb -s $Serial reverse tcp:$Port tcp:$Port ---"
    $out = & $Adb -s $Serial reverse "tcp:$Port" "tcp:$Port" 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Host $out.TrimEnd()
    if ($code -ne 0) {
        Fail "adb reverse 失败，退出码 $code。手机将无法通过 127.0.0.1:$Port 访问电脑服务。" $code
    }
    $listing = & $Adb -s $Serial reverse --list 2>&1 | Out-String
    Write-Host "REVERSE_LIST  : $($listing.TrimEnd())"
} else {
    Write-Host '跳过 reverse（-SkipReverse）。'
}

# ---------------------------------------------------------------- 启动
if (-not $SkipLaunch) {
    Write-Host ''
    Write-Host "--- adb -s $Serial shell am start -n $Package/$Activity ---"
    $out = & $Adb -s $Serial shell am start -n "$Package/$Activity" 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Host $out.TrimEnd()
    if ($code -ne 0 -or $out -match 'Error') {
        Fail "启动 Activity 失败，adb 退出码 $code。`n$out" 6
    }
    Write-Host 'LAUNCH_RESULT: started'
}

Write-Host ''
Write-Host '== install-demo OK ==' -ForegroundColor Green
exit 0
