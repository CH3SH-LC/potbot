<#
.SYNOPSIS
    potbot 手机 Word Demo —— 检测 USB 连接的安卓设备（S1）。

.DESCRIPTION
    只做读取：运行 `adb devices -l`，解析设备列表。不改动设备状态，
    **不调用 adb kill-server**，不对设备下任何写指令。

    退出码（供主协调者分支使用）：
      0  = 恰好一台设备处于 device 状态，可以部署
      2  = 没有可用设备（未连接，或已连接但手机上尚未允许 USB 调试）
      3  = 检测到多于一台可用设备，串号不唯一，需要人工指定
      1  = adb 本身执行失败

    无设备时只提示一次并正常结束，不循环重试。

.EXAMPLE
    powershell -NoProfile -File scripts/demo/device-check.ps1
#>
[CmdletBinding()]
param(
    [string]$Adb = 'D:\android-sdk\platform-tools\adb.exe'
)

$ErrorActionPreference = 'Continue'

# 控制台编码：让中文提示在重定向场景也保持 UTF-8（仅影响本进程）。
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

if (-not (Test-Path -LiteralPath $Adb)) {
    Write-Host "找不到 adb：$Adb" -ForegroundColor Red
    exit 1
}

$raw = & $Adb devices -l 2>&1 | Out-String
$adbExit = $LASTEXITCODE
if ($adbExit -ne 0) {
    Write-Host "adb devices -l 执行失败，退出码 $adbExit" -ForegroundColor Red
    Write-Host $raw
    exit 1
}

# 解析：跳过 "List of devices attached" 与空行；每行首列为串号，次列为状态。
$ready = @()
$unauthorized = @()
$other = @()

foreach ($line in ($raw -split "`r?`n")) {
    $t = $line.Trim()
    if ($t -eq '' -or $t -like 'List of devices*') { continue }
    # 跳过 adb 自身的横幅行，例如 "* daemon not running; starting now at tcp:5037"
    if ($t.StartsWith('*')) { continue }
    $parts = $t -split '\s+'
    if ($parts.Count -lt 2) { continue }
    $serial = $parts[0]
    $state = $parts[1]
    switch ($state) {
        'device'       { $ready += [pscustomobject]@{ Serial = $serial; State = $state; Detail = $t } }
        'unauthorized' { $unauthorized += [pscustomobject]@{ Serial = $serial; State = $state; Detail = $t } }
        default        { $other += [pscustomobject]@{ Serial = $serial; State = $state; Detail = $t } }
    }
}

Write-Host '== device-check =='
Write-Host $raw.TrimEnd()
Write-Host ''

if ($ready.Count -eq 1) {
    Write-Host "DEVICE_READY : $($ready[0].Serial)" -ForegroundColor Green
    Write-Host "DEVICE_DETAIL: $($ready[0].Detail)"
    exit 0
}

if ($ready.Count -eq 0) {
    if ($unauthorized.Count -gt 0) {
        Write-Host "检测到已连接但未授权的设备：$(($unauthorized | ForEach-Object { $_.Serial }) -join ', ')" -ForegroundColor Yellow
        Write-Host '请在手机屏幕上点击「允许 USB 调试」一次（可勾选「一律允许」），然后重跑本脚本。'
    } else {
        Write-Host '未检测到任何处于 device 状态的安卓设备。' -ForegroundColor Yellow
        Write-Host '请用 USB 连接手机，打开「开发者选项 → USB 调试」，解锁屏幕后接受调试授权，然后重跑本脚本。'
    }
    if ($other.Count -gt 0) {
        Write-Host "其他状态设备：$(($other | ForEach-Object { "$($_.Serial)[$($_.State)]" }) -join ', ')"
    }
    Write-Host 'DEVICE_READY : none'
    exit 2
}

Write-Host '检测到多于一台可用设备，串号不唯一，拒绝猜测：' -ForegroundColor Red
$ready | ForEach-Object { Write-Host "  - $($_.Serial)" }
Write-Host '请断开多余设备，或在部署时显式指定 -Serial。'
exit 3
