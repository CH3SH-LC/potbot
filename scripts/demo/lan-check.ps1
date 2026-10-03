<#
.SYNOPSIS
    potbot 手机 Word Demo —— 「无 USB 时手机网页降级路径」就绪检查（S1）。

.DESCRIPTION
    当手机没有 USB 连接时，方案允许先走「同一 Wi-Fi / 热点下的手机网页联调」
    （见 docs/other/ds-mobile-word-demo-3h-2026-10-02.md「手机连通与 Android 构建」）。
    本脚本把这条路径的就绪条件查清楚，并给出**用户可以直接照抄的命令文本**。

    本脚本**只读**：
      - 只查询本机地址、端口监听、防火墙规则状态；
      - **不**启动/停止任何服务，**不**新增、修改、删除任何防火墙规则，
        **不**调用 adb kill-server，**不**改动任何配置。

    退出码语义：
      0 = 可访问（服务已绑到手机可达的地址，且防火墙有明确放行证据）
      2 = 不可访问（无人监听；或只绑在回环 127.0.0.1；或绑在手机路由不到的地址）
      3 = 无法判定（绑定没问题但防火墙状态确认不了、解析失败、或绑定地址不明确）

.PARAMETER Port
    要检查的端口，默认 8765（合同固定值）。

.PARAMETER SkipFirewall
    跳过防火墙查询（快，但此时只要能绑定就只能是「无法判定」= 退出码 3）。

.EXAMPLE
    powershell -NoProfile -File scripts/demo/lan-check.ps1

.EXAMPLE
    powershell -NoProfile -File scripts/demo/lan-check.ps1 -Port 18765
#>
[CmdletBinding()]
param(
    [int]$Port = 8765,
    [switch]$SkipFirewall
)

$ErrorActionPreference = 'Continue'

$UTF8 = New-Object System.Text.UTF8Encoding($false)
try {
    [Console]::OutputEncoding = $UTF8
    $OutputEncoding = $UTF8
} catch { }

# 退出码常量
$EXIT_REACHABLE   = 0
$EXIT_UNREACHABLE = 2
$EXIT_UNKNOWN     = 3

function Show-Section([string]$Title) {
    Write-Host ''
    Write-Host "== $Title =="
}

# 本机是中文 Windows。实测：netsh 的 stdout 被**重定向到文件**时会自动改用英文
# （Rule Name / Enabled / Direction / Profiles / LocalPort / Program / Action），
# 而在控制台里则是中文。为规避本地化差异，这里统一「重定向到文件 → 按 OEM 代码页显式解码」，
# 完全不走控制台编码，解析规则同时接受英文与中文关键字（见第 3 节）。
function Get-OemEncoding {
    try {
        $cp = [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
        if ($cp -gt 0) { return [System.Text.Encoding]::GetEncoding($cp) }
        $cp2 = [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage
        if ($cp2 -gt 0) { return [System.Text.Encoding]::GetEncoding($cp2) }
    } catch { }
    return [System.Text.Encoding]::ASCII
}

function Invoke-NativeText {
    param([string]$FilePath, [string[]]$Arguments)
    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath $FilePath -ArgumentList $Arguments -NoNewWindow -Wait `
                -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru
        $enc = Get-OemEncoding
        $outText = $enc.GetString([System.IO.File]::ReadAllBytes($outFile))
        $errText = $enc.GetString([System.IO.File]::ReadAllBytes($errFile))
        if ($errText.Trim().Length -gt 0) { $outText = $outText + "`r`n" + $errText }
        return [pscustomobject]@{ Text = $outText; ExitCode = $p.ExitCode }
    } catch {
        return [pscustomobject]@{ Text = "调用 $FilePath 失败：$($_.Exception.Message)"; ExitCode = -1 }
    } finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
}

function Test-TcpPort {
    param([string]$TargetHost, [int]$TargetPort, [int]$TimeoutMs = 2000)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($TargetHost, $TargetPort, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

Write-Host '== lan-check =='
Write-Host "PORT : $Port"
Write-Host "TIME : $(Get-Date -Format 's')"

# =====================================================================
# 1. 本机非回环 IPv4 地址（含网卡名）
# =====================================================================
Show-Section '1. 本机非回环 IPv4 地址'

$allIps = @()
try {
    foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($ni.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
        $props = $null
        try { $props = $ni.GetIPProperties() } catch { continue }
        if ($null -eq $props) { continue }
        # 有默认网关的网卡通常才是手机真正能路由到的那张（虚拟网卡一般没有）
        $hasGw = $false
        try {
            $hasGw = (@($props.GatewayAddresses | Where-Object {
                $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork
            }).Count -gt 0)
        } catch { }

        foreach ($ua in $props.UnicastAddresses) {
            if ($ua.Address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
            if ([System.Net.IPAddress]::IsLoopback($ua.Address)) { continue }
            $ip = $ua.Address.ToString()
            $allIps += [pscustomobject]@{
                Adapter = $ni.Name
                Type    = $ni.NetworkInterfaceType.ToString()
                Status  = $ni.OperationalStatus.ToString()
                IP      = $ip
                IsLinkLocal = ($ip -like '169.254.*')
                HasGateway  = $hasGw
            }
        }
    }
} catch {
    Write-Host "枚举网卡失败：$($_.Exception.Message)"
}

if ($allIps.Count -eq 0) {
    Write-Host '没有找到任何非回环 IPv4 地址。' -ForegroundColor Yellow
} else {
    $allIps | Format-Table -AutoSize Adapter, Type, Status, IP, IsLinkLocal, HasGateway | Out-String | Write-Host
}

# 手机有希望访问到的地址：网卡 Up 且不是 169.254 链路本地
$usableIps = @($allIps | Where-Object { $_.Status -eq 'Up' -and -not $_.IsLinkLocal })
# 更可信的一层：还带默认网关（虚拟网卡如 Meta/Docker/WSL 一般没有）
$primaryIps = @($usableIps | Where-Object { $_.HasGateway })
# 最可信的一层：再加「物理网卡类型」（以太网 / 无线）——手机上最可能真连得到的通常是这一张
$preferredIps = @($primaryIps | Where-Object { $_.Type -eq 'Ethernet' -or $_.Type -eq 'Wireless80211' })
if ($preferredIps.Count -eq 0) { $preferredIps = $primaryIps }
Write-Host "USABLE_LAN_IPS  : $(if ($usableIps.Count -eq 0) { '(none)' } else { ($usableIps | ForEach-Object { $_.IP }) -join ', ' })"
Write-Host "PRIMARY_LAN_IPS : $(if ($primaryIps.Count -eq 0) { '(none)' } else { ($primaryIps | ForEach-Object { $_.IP }) -join ', ' })"
Write-Host "PREFERRED_LAN_IPS : $(if ($preferredIps.Count -eq 0) { '(none)' } else { ($preferredIps | ForEach-Object { "$($_.IP)@$($_.Adapter)" }) -join ', ' })"

# 当前网络类别（决定防火墙哪套 profile 适用）
$activeCategory = $null
$activeAdapter = $null
try {
    $profiles = @(Get-NetConnectionProfile -ErrorAction Stop)
    foreach ($cp in $profiles) {
        Write-Host ("NET_PROFILE    : {0} ({1}) -> {2}" -f $cp.Name, $cp.InterfaceAlias, $cp.NetworkCategory)
    }
    # 优先取拥有可用 LAN IP 的那张网卡
    foreach ($u in $usableIps) {
        $hit = $profiles | Where-Object { $_.InterfaceAlias -eq $u.Adapter }
        if ($hit) { $activeCategory = "$($hit[0].NetworkCategory)"; $activeAdapter = $u.Adapter; break }
    }
} catch {
    Write-Host "NET_PROFILE    : 查询失败（$($_.Exception.Message)）"
}
Write-Host "ACTIVE_PROFILE : $(if ($activeCategory) { $activeCategory } else { '未判定' })"

# =====================================================================
# 2. $Port 当前监听在哪个地址上
# =====================================================================
Show-Section "2. 端口 $Port 的监听地址"

$netstat = Invoke-NativeText -FilePath 'netstat' -Arguments @('-ano', '-p', 'TCP')
$bindVerdict = 'UNKNOWN'
$listeners = @()
$netstatOk = $true

if ($netstat.ExitCode -ne 0) {
    $netstatOk = $false
    Write-Host "netstat 执行失败，退出码 $($netstat.ExitCode)："
    Write-Host $netstat.Text
} else {
    foreach ($line in ($netstat.Text -split "`r?`n")) {
        $t = $line.Trim()
        if ($t -notmatch 'LISTENING') { continue }
        $parts = $t -split '\s+'
        if ($parts.Count -lt 4) { continue }
        $local = $parts[1]
        $procId = $parts[$parts.Count - 1]
        if ($local -notmatch ':(\d+)$') { continue }
        if ([int]$Matches[1] -ne $Port) { continue }

        $hostPart = $local.Substring(0, $local.Length - ($Matches[1].Length + 1))
        $procName = '(未知)'
        try {
            $p = Get-Process -Id ([int]$procId) -ErrorAction Stop
            $procName = $p.ProcessName
        } catch { }

        $listeners += [pscustomobject]@{
            Raw = $t; LocalAddress = $local; HostPart = $hostPart; PID = $procId; Process = $procName
        }
    }
}

if (-not $netstatOk) {
    $bindVerdict = 'UNKNOWN'
} elseif ($listeners.Count -eq 0) {
    $bindVerdict = 'NONE'
} else {
    $listeners | Format-Table -AutoSize LocalAddress, HostPart, PID, Process | Out-String | Write-Host

    $wildcard = $false
    $loopbackOnly = $true
    $onLanIp = $false
    $other = @()
    foreach ($l in $listeners) {
        $h = $l.HostPart
        $hBare = $h.Trim('[', ']')
        if ($hBare -eq '0.0.0.0' -or $hBare -eq '::' -or $hBare -eq '*') {
            $wildcard = $true
            $loopbackOnly = $false
            continue
        }
        if ($hBare -eq '127.0.0.1' -or $hBare -eq '::1') {
            continue   # 仍是回环，不改变 loopbackOnly
        }
        # 非回环的具体地址
        $loopbackOnly = $false
        if ($usableIps | Where-Object { $_.IP -eq $hBare }) { $onLanIp = $true }
        else { $other += $hBare }
    }

    if ($wildcard -or $onLanIp)      { $bindVerdict = 'REACHABLE' }
    elseif ($loopbackOnly)           { $bindVerdict = 'LOOPBACK_ONLY' }
    elseif ($other.Count -gt 0)      { $bindVerdict = 'OTHER'; $otherIps = $other }
    else                             { $bindVerdict = 'LOOPBACK_ONLY' }
}

Write-Host ''
switch ($bindVerdict) {
    'NONE' {
        Write-Host '结论：**没有任何进程在监听这个端口** —— 手机现在一定访问不到。' -ForegroundColor Yellow
        Write-Host '请先在电脑上把 Demo 服务起起来（由主协调者/ S3 侧负责），再重跑本脚本。'
    }
    'LOOPBACK_ONLY' {
        Write-Host '结论：**只监听在 127.0.0.1** —— 手机访问不到。' -ForegroundColor Yellow
        Write-Host '回环地址只在电脑本机内可见，同一 Wi-Fi 下的手机连不上。'
        Write-Host '需要让服务端改成监听所有网卡后重启，例如：'
        Write-Host '    $env:POTBOT_BIND = "0.0.0.0"'
        Write-Host '    （然后用主协调者给的启动脚本重启服务；S3 已支持该变量）'
    }
    'REACHABLE' {
        Write-Host '结论：**服务已绑定到手机可达的地址**（0.0.0.0 / 本机 LAN IP）。' -ForegroundColor Green
    }
    'OTHER' {
        Write-Host "结论：服务只绑定在本机其他接口上（$($otherIps -join ', ')），**不确定手机能否访问**。" -ForegroundColor Yellow
        Write-Host '这类地址通常是虚拟网卡（WSL / Docker / VPN），手机一般路由不到。'
        Write-Host '建议改绑 0.0.0.0 或本机 LAN IP 后重启服务。'
    }
    default {
        Write-Host '结论：**无法判定**端口监听状态（netstat 查询失败）。' -ForegroundColor Red
    }
}
Write-Host "BIND_VERDICT : $bindVerdict"

# =====================================================================
# 3. Windows 防火墙放行状态（只读）
# =====================================================================
Show-Section '3. Windows 防火墙状态（只读查询，脚本不会修改任何规则）'

$fwVerdict = 'UNKNOWN'
$fwDetail  = '未查询'
$fwOnProfiles = @()
$fwAllOff = $false
$fwMatchRules = @()
$fwParsedRules = 0
$fwProfileOk = $false
$fwRulesOk = $false

if ($SkipFirewall) {
    $fwVerdict = 'SKIPPED'
    Write-Host '（-SkipFirewall：本次跳过防火墙查询）'
} else {
    # 3a. 各 profile 开关状态：用 locale 无关的 cmdlet
    try {
        foreach ($p in @(Get-NetFirewallProfile -ErrorAction Stop)) {
            $isOn = ($p.Enabled -eq 'True' -or $p.Enabled -eq $true)
            Write-Host ("FW_PROFILE : {0,-8} Enabled={1}" -f $p.Name, $p.Enabled)
            if ($isOn) { $fwOnProfiles += "$($p.Name)" }
        }
        if ($fwOnProfiles.Count -eq 0) { $fwAllOff = $true }
        $fwProfileOk = $true
    } catch {
        Write-Host "FW_PROFILE : 查询失败（$($_.Exception.Message)）"
        $fwProfileOk = $false
        $fwDetail = 'profile 状态查询被拒'
    }

    # 3b. 入站允许规则里，是否有覆盖本端口的
    #     netsh 在本机输出中文，所以这里按「中英文双关键字」解析；解析不到任何规则即判无法判定。
    if ($fwProfileOk) {
        $dump = Invoke-NativeText -FilePath 'netsh' -Arguments @('advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in', 'verbose')
        if ($dump.ExitCode -ne 0) {
            Write-Host "FW_RULES   : netsh 查询失败，退出码 $($dump.ExitCode)"
            $fwRulesOk = $false
            $fwDetail = 'netsh 查询被拒'
        } else {
            $reDash    = '^\s*-{5,}\s*$'
            $reEnabled = '^(?:Enabled|已启用)\s*[:：]\s*(.*)$'
            $reDir     = '^(?:Direction|方向)\s*[:：]\s*(.*)$'
            $reProf    = '^(?:Profiles|配置文件)\s*[:：]\s*(.*)$'
            $reProto   = '^(?:Protocol|协议)\s*[:：]\s*(.*)$'
            $reLPort   = '^(?:LocalPort|本地端口)\s*[:：]\s*(.*)$'
            $reProg    = '^(?:Program|程序)\s*[:：]\s*(.*)$'
            $reAction  = '^(?:Action|操作)\s*[:：]\s*(.*)$'

            $cur = $null
            $rules = New-Object System.Collections.ArrayList

            foreach ($line in ($dump.Text -split "`r?`n")) {
                if ($line -match $reDash) { continue }

                if ($line -match '^(?:Rule Name|规则名称)\s*[:：]\s*(.*)$') {
                    if ($cur -ne $null) { [void]$rules.Add($cur) }
                    $cur = @{ Name = $Matches[1].Trim() }
                    continue
                }
                if ($cur -eq $null) { continue }

                $m = $null
                if     ($line -match $reEnabled) { $cur.Enabled  = $Matches[1].Trim() }
                elseif ($line -match $reDir)     { $cur.Direction = $Matches[1].Trim() }
                elseif ($line -match $reProf)    { $cur.Profiles = $Matches[1].Trim() }
                elseif ($line -match $reProto)   { $cur.Protocol = $Matches[1].Trim() }
                elseif ($line -match $reLPort)   { $cur.LocalPort = $Matches[1].Trim() }
                elseif ($line -match $reProg)    { $cur.Program  = $Matches[1].Trim() }
                elseif ($line -match $reAction)  { $cur.Action   = $Matches[1].Trim() }
            }
            if ($cur -ne $null) { [void]$rules.Add($cur) }
            $fwParsedRules = $rules.Count

            Write-Host "FW_RULES   : 解析到入站规则 $fwParsedRules 条（netsh verbose 输出 $(($dump.Text.Length)) 字符）"

            if ($fwParsedRules -eq 0) {
                $fwRulesOk = $false
                $fwDetail = 'netsh 输出一条规则都没解析出来（本地化格式与预期不符）'
            } else {
                $fwRulesOk = $true
                $anyToken  = '^(?:Any|任何)$'
                $mapProfile = @{ '域' = 'Domain'; '专用' = 'Private'; '公用' = 'Public' }

                foreach ($r in $rules) {
                    # 只看启用 + 入站 + 允许
                    $en = "$($r.Enabled)"
                    if ($en -notmatch '^(?:Yes|是|True|启用)$') { continue }
                    if ("$($r.Direction)" -notmatch '^(?:In|入|入站)$') { continue }
                    if ("$($r.Action)"    -notmatch '^(?:Allow|允许)$') { continue }

                    # 协议必须是 TCP 或 Any
                    $proto = "$($r.Protocol)"
                    if ($proto -notmatch '^(?:TCP|Any|任何)$') { continue }

                    # 端口覆盖本端口（或 Any）
                    $lport = "$($r.LocalPort)"
                    $lportAny = ($lport -match $anyToken)
                    $lportList = @(($lport -split '\s*[,，]\s*') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
                    $portHit = $lportAny -or ($lportList -contains "$Port")

                    # 程序是 Any 或 node.exe（本 Demo 服务是 Node）
                    $prog = "$($r.Program)"
                    $progAny = ($prog -match $anyToken)
                    $progNode = ($prog -match '(?i)node\.exe$')
                    $progHit = $progAny -or $progNode

                    if (-not ($portHit -and $progHit)) { continue }

                    # 规则适用的 profile 列表
                    $rprof = "$($r.Profiles)"
                    $rprofList = @()
                    if ($rprof -match $anyToken) { $rprofList = @('Domain','Private','Public') }
                    else {
                        foreach ($tok in ($rprof -split '\s*[,，]\s*')) {
                            $tk = $tok.Trim()
                            if ($tk -eq '') { continue }
                            if ($mapProfile.ContainsKey($tk)) { $rprofList += $mapProfile[$tk] } else { $rprofList += $tk }
                        }
                    }

                    $broad = ($lportAny -and $progAny)
                    $fwMatchRules += [pscustomobject]@{
                        Name = "$($r.Name)"; Profiles = ($rprofList -join ','); LocalPort = $lport
                        Program = $prog; Broad = $broad
                    }
                }
            }
        }
    }

    # 3c. 判定
    if ($fwVerdict -eq 'SKIPPED') {
        Write-Host 'FW_VERDICT : SKIPPED（-SkipFirewall）'
    } elseif (-not $fwProfileOk) {
        Write-Host "FW_VERDICT : UNKNOWN（$fwDetail）"
    } elseif ($fwAllOff) {
        $fwVerdict = 'ALLOW'
        Write-Host 'FW_VERDICT : ALLOW —— 三套 profile 的防火墙都是关闭的，不会拦入站。' -ForegroundColor Green
    } elseif (-not $fwRulesOk) {
        Write-Host "FW_VERDICT : UNKNOWN（$fwDetail）" -ForegroundColor Yellow
    } elseif ($fwMatchRules.Count -eq 0) {
        $fwVerdict = 'UNKNOWN'
        Write-Host "FW_VERDICT : UNKNOWN —— 防火墙有开启的 profile，但**没找到**覆盖 $Port 或 node.exe 的入站放行规则。" -ForegroundColor Yellow
        Write-Host '（不代表一定被拦：也可能规则命中了本脚本没解析的形态；但现有证据不足以判定放行。）'
    } else {
        Write-Host 'FW_MATCH_RULES :'
        $fwMatchRules | Format-Table -AutoSize Name, Profiles, LocalPort, Program, Broad | Out-String | Write-Host

        # 需要的 profile：能判定适用 profile 就只看它，否则要求覆盖全部开启的 profile
        $need = @()
        if ($activeCategory) {
            $mapCat = @{ 'DomainAuthenticated' = 'Domain'; 'Private' = 'Private'; 'Public' = 'Public' }
            if ($mapCat.ContainsKey($activeCategory)) { $need = @($mapCat[$activeCategory]) }
        }
        if ($need.Count -eq 0) { $need = $fwOnProfiles }
        Write-Host "FW_NEED_PROFILES : $($need -join ', ')  （ACTIVE_PROFILE=$(if ($activeCategory) { $activeCategory } else { '未判定' })）"

        $missing = @()
        foreach ($n in $need) {
            $covered = $false
            foreach ($r in $fwMatchRules) {
                if (($r.Profiles -split ',') -contains $n) { $covered = $true; break }
            }
            if (-not $covered) { $missing += $n }
        }
        if ($missing.Count -eq 0) {
            $fwVerdict = 'ALLOW'
            Write-Host 'FW_VERDICT : ALLOW —— 找到覆盖所需 profile 的入站放行规则。' -ForegroundColor Green
        } else {
            $fwVerdict = 'UNKNOWN'
            Write-Host "FW_VERDICT : UNKNOWN —— 放行规则没有覆盖 profile：$($missing -join ', ')" -ForegroundColor Yellow
        }
    }

    # 3d. 用户可自行执行的命令文本（本脚本绝不代跑）
    Show-Section '3b. 如果确认被防火墙拦住，用户可自行执行的命令（本脚本不会代跑）'
    Write-Host '查看当前规则（只读，和本脚本做的是同一件事）：'
    Write-Host '    netsh advfirewall firewall show rule name=all dir=in verbose'
    Write-Host ''
    Write-Host '为 Demo 端口新增一条入站放行规则（需要管理员权限的 PowerShell／终端）：'
    Write-Host ("    netsh advfirewall firewall add rule name=""potbot demo {0}"" dir=in action=allow protocol=TCP localport={0} profile=private,public" -f $Port)
    Write-Host ''
    Write-Host '演示结束后想删掉它：'
    Write-Host ("    netsh advfirewall firewall delete rule name=""potbot demo {0}""" -f $Port)
    Write-Host ''
    Write-Host '提示：仅在手机与电脑处于同一可信 Wi-Fi／热点时使用；公用网络下建议改网卡为「专用」网络而不是放宽公用 profile。'
}

# =====================================================================
# 4. 本机对 LAN IP 的连通性自测
# =====================================================================
Show-Section '4. 本机对自身 LAN IP 的连通性自测'

$testIps = @()
if ($preferredIps.Count -gt 0)     { $testIps = $preferredIps }
elseif ($primaryIps.Count -gt 0)   { $testIps = $primaryIps }
else                                { $testIps = $usableIps }

if ($testIps.Count -eq 0) {
    Write-Host '没有可用的 LAN IP，跳过。'
} elseif ($bindVerdict -eq 'NONE' -or $bindVerdict -eq 'UNKNOWN') {
    Write-Host '没有确认在监听，跳过连通性自测。'
} else {
    foreach ($u in $testIps) {
        $tcpOk = Test-TcpPort -TargetHost $u.IP -TargetPort $Port -TimeoutMs 2000
        if (-not $tcpOk) {
            Write-Host ("SELFTEST : {0} ({1}) -> TCP 连接失败" -f $u.IP, $u.Adapter) -ForegroundColor Yellow
            continue
        }
        Write-Host ("SELFTEST : {0} ({1}) -> TCP 端口已连通" -f $u.IP, $u.Adapter) -ForegroundColor Green
        # 顺手看看是不是 potbot 服务（合同里有 GET /health）
        $url = "http://$($u.IP):$Port/health"
        try {
            $resp = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
            Write-Host ("           GET {0} -> HTTP {1}" -f $url, $resp.StatusCode)
            $body = "$($resp.Content)"
            if ($body.Length -gt 300) { $body = $body.Substring(0, 300) + '...' }
            Write-Host ("           响应片段：{0}" -f $body)
        } catch {
            Write-Host ("           GET {0} 失败：{1}" -f $url, $_.Exception.Message)
        }
    }
    Write-Host ''
    Write-Host '注意：这是「电脑访问自己」，走的是本机回环路径，**不能**证明防火墙对别的设备放行；'
    Write-Host '      真机侧结论必须由手机实际打开页面得出。'
}

# =====================================================================
# 5. 总结与行动指引
# =====================================================================
Show-Section '5. 总结与指引'

$phoneIp = $null
if ($bindVerdict -eq 'REACHABLE') {
    if ($preferredIps.Count -gt 0)   { $phoneIp = $preferredIps[0].IP }
    elseif ($primaryIps.Count -gt 0) { $phoneIp = $primaryIps[0].IP }
    elseif ($usableIps.Count -gt 0)  { $phoneIp = $usableIps[0].IP }
}

if ($phoneIp) { Write-Host "PHONE_URL  : http://${phoneIp}:${Port}/" }
else         { Write-Host "PHONE_URL  : （待定——先把服务绑到手机可达的地址）" }

if ($usableIps.Count -gt 0) {
    Write-Host "PHONE_URL_CANDIDATES : $(($usableIps | ForEach-Object { "http://$($_.IP):${Port}/" }) -join '  ')"
    Write-Host '（第一个是脚本推荐的；若手机上打不开，可按顺序试后面的候选。）'
}

Write-Host "BIND_VERDICT     : $bindVerdict"
Write-Host "FIREWALL_VERDICT : $fwVerdict"

$exitCode = $EXIT_UNKNOWN
if ($bindVerdict -eq 'NONE' -or $bindVerdict -eq 'LOOPBACK_ONLY' -or $bindVerdict -eq 'OTHER') {
    $exitCode = $EXIT_UNREACHABLE
} elseif ($bindVerdict -eq 'REACHABLE') {
    if ($fwVerdict -eq 'ALLOW') { $exitCode = $EXIT_REACHABLE } else { $exitCode = $EXIT_UNKNOWN }
} else {
    $exitCode = $EXIT_UNKNOWN
}

Write-Host ''
if ($exitCode -eq $EXIT_REACHABLE) {
    Write-Host '=> 可访问：手机连同一 Wi-Fi／热点后，用浏览器打开上面 PHONE_URL 即可。' -ForegroundColor Green
} elseif ($exitCode -eq $EXIT_UNREACHABLE) {
    Write-Host '=> 不可访问：按第 2 节的结论修（先起服务，或让服务改绑 0.0.0.0 后重启）。' -ForegroundColor Yellow
} else {
    Write-Host '=> 无法判定：绑定看起来没问题，但防火墙放行确认不了；需要用户按第 3b 节自行确认/放行。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '提醒：这条路径交付的是**手机网页**入口，不是可安装 App，也不是离线 PWA ——'
Write-Host '      安装能力（APK 冷启动）仍需 USB，本脚本不改变该结论。'
Write-Host "EXIT : $exitCode"

exit $exitCode
