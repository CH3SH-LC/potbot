<#
.SYNOPSIS
  构建并启动 potbot 手机 Word Demo 的电脑端服务（S3 独占写入范围）。

.DESCRIPTION
  两步，**先构建、后启动**，任一步失败即停并回显退出码（不吞错、不"看起来启动了"）：

    1) node node_modules/typescript/bin/tsc -p tsconfig.demo.json
       —— 产物落在 .runtime/mobile-word-demo/build/，入口为
          .runtime/mobile-word-demo/build/apps/demo/server/main.js
    2) node .runtime/mobile-word-demo/build/apps/demo/server/main.js

  监听地址由 POTBOT_BIND 决定（**不设置时只监听 127.0.0.1**，安全默认闭合）：
    - 只在本机浏览器看：      .\start-demo.ps1
    - 手机走同一 Wi-Fi 访问： .\start-demo.ps1 -Bind 0.0.0.0
      然后用启动日志里打印的局域网地址访问（例如 http://192.168.1.10:8765/）。
      非法值会让服务**启动失败**，不会静默回落到对外全开。

  密钥纪律：模型密钥只从电脑环境变量读取，服务不向页面转发任何密钥。

  文件编码：本文件**必须**是 UTF-8 with BOM。PowerShell 5.1 对无 BOM 的 .ps1 会按
  本地代码页（本机为 GBK）解码源码，中文输出会乱码、个别字符还会直接造成语法错误退出。
  本仓另有 start-demo.cmd 包装器（纯 ASCII），用于绕过 Restricted 执行策略：
  双击它、或在 cmd 里执行 `scripts\demo\start-demo.cmd` 即可。

.PARAMETER Bind
  监听地址。省略时用 $env:POTBOT_BIND；再省略则 127.0.0.1。
  取值必须是 127.0.0.1 / 0.0.0.0 / localhost / 合法 IPv4 字面量 / 主机名。

.PARAMETER Port
  监听端口；默认 8765（合同 DEFAULT_PORT）。

.PARAMETER SkipBuild
  跳过 tsc 构建（仅在刚构建过、只想重启服务时用）。
#>

[CmdletBinding()]
param(
  [string]$Bind = $env:POTBOT_BIND,
  [int]$Port = 8765,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

# 让本脚本的中文输出与子进程 node 的 UTF-8 输出**同一条流**。
# 不设置的话：PowerShell 按控制台代码页（本机 GBK）编码自己的输出，而 node 直接写 UTF-8，
# 两者混在同一个终端里必有一方显示为乱码。控制台不可用时（无 TTY）忽略即可。
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
}
catch {
  # 没有控制台时设置会抛错：这不是失败条件，继续跑。
}

function Write-Step([string]$Text) {
  Write-Host ""
  Write-Host "==> $Text" -ForegroundColor Cyan
}

function Stop-WithError([string]$Text, [int]$Code) {
  Write-Host ""
  Write-Host "失败：$Text（退出码 $Code）" -ForegroundColor Red
  exit $Code
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Entry = Join-Path $RepoRoot '.runtime\mobile-word-demo\build\apps\demo\server\main.js'
$Tsc = Join-Path $RepoRoot 'node_modules\typescript\bin\tsc'
$TsConfig = Join-Path $RepoRoot 'tsconfig.demo.json'

Write-Host "仓库根：$RepoRoot"
Write-Host "入口文件：$Entry"

if (-not (Test-Path $Tsc)) {
  Stop-WithError "找不到 TypeScript 编译器：$Tsc（请先在仓库根执行依赖安装）" 2
}
if (-not (Test-Path $TsConfig)) {
  Stop-WithError "找不到构建配置：$TsConfig" 2
}

if (-not $SkipBuild) {
  Write-Step "构建：node node_modules/typescript/bin/tsc -p tsconfig.demo.json"
  Push-Location $RepoRoot
  try {
    & node $Tsc -p $TsConfig
    $tscExit = $LASTEXITCODE
  }
  finally {
    Pop-Location
  }
  if ($tscExit -ne 0) {
    # tsc 在存在类型错误时仍会发射产物，但"有错"必须让调用方看见，不能当成构建成功。
    Write-Host "tsc 退出码：$tscExit（非 0 = 类型检查未通过；产物可能仍已发射）" -ForegroundColor Yellow
    Stop-WithError "TypeScript 构建未通过" $tscExit
  }
  Write-Host "tsc 退出码：0" -ForegroundColor Green
}
else {
  Write-Host "已跳过构建（-SkipBuild）"
}

if (-not (Test-Path $Entry)) {
  Stop-WithError "构建产物不存在：$Entry（请去掉 -SkipBuild 重新构建）" 3
}

Write-Step "启动：node $Entry"
if (-not [string]::IsNullOrWhiteSpace($Bind)) {
  $env:POTBOT_BIND = $Bind
  Write-Host "POTBOT_BIND=$Bind"
}
else {
  Write-Host "POTBOT_BIND 未设置 —— 只监听 127.0.0.1（手机访问请加 -Bind 0.0.0.0）"
}
$env:POTBOT_PORT = "$Port"
Write-Host "POTBOT_PORT=$Port"

Push-Location $RepoRoot
try {
  & node $Entry
  $runExit = $LASTEXITCODE
}
finally {
  Pop-Location
}

if ($runExit -ne 0) {
  Stop-WithError "服务进程退出" $runExit
}
exit 0
