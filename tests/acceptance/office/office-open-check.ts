/**
 * **"目标软件可打开"实测**（design-02 A 批；合同 v1.4 R53.1 第三层）。
 *
 * 任务书 §12 明确要求"演示前还要在目标设备与软件打开验证"——前两层（内核结构自检、
 * Python/`unzip` 独立读回）都只能证"结构合法"，**证不了 Word / Excel / PowerPoint 能打开它**。
 * 本模块用本机已安装的 Office（`…\root\Office16\{WINWORD,EXCEL,POWERPNT}.EXE`）
 * 通过 COM **真打开一次**、读回关键属性、不保存关闭。
 *
 * ## 套件地位：**可选工具，不参与默认套件**（合同 v1.4 §8d / R65；2026-10-02 用户给出方向性事实后）
 *
 * **本文件不是本批的验收判据，也不属于默认套件**（文件名不含 `.test.`，本就不被 vitest 收集）。
 * 使用前提：一台**有授权**的桌面 Office。三条事实决定了它退出套件：
 *
 * 1. **本机（桌面 Windows）的 Office 没有授权 / 无法使用**；
 * 2. **项目的目标平台是安卓手机，不是桌面 Windows**——真正的"目标软件打开"验证要在**真机**
 *    （安卓办公应用）上做，属 `docs/GOAL.md` 的**真机**范围，**不在本批**；
 * 3. 它**不可重复**：实测依赖本机 Office 进程状态（COM 留下的无窗口孤儿会让后续调用被
 *    本文件自己的 COM 附着护栏判 `inconclusive`——仪器自毒）。
 *
 * 因此把"套件是否全绿"建立在一台有授权的桌面 Office 上属**验收条件错位**（把环境当判据）。
 * **保留本文件的价值**：给将来具备授权桌面环境的人一条现成路径，且不必重新踩 COM 的坑。
 *
 * ## 三层验证里它是哪一层，以及它**不是**本批判据
 *
 * 任务书 §12 的"目标软件打开验证"分三层（R53.1，**必须分开陈述、不得互相顶替**）：
 *
 * | 层 | 由谁做 | 能证明什么 | 不能证明什么 |
 * |---|---|---|---|
 * | 结构自检 | 内核（`verify.ts`，提交前） | 构建器内部自洽 | **不能**证明目标软件能打开 |
 * | 独立读回 | 验收侧（Python `zipfile` + `unzip -t`） | 结构合法 + 关键内容与记录版本一致 | **不能**证明目标软件能打开 |
 * | **目标软件打开** | **本文件（COM）** | "目标软件可打开"的**实测**证据 | 不证明编辑体验等价于办公套件 |
 *
 * **本批判据只有前两层**（R65.1）；第三层**不是**本批判据（R65.2），原因如上。
 * `§8b` 实测记录里"Word / Excel / PowerPoint 打开成功"是在**未授权（受限功能模式）**的桌面 Office
 * 上取得的（R65.3），其含义仅为"能**加载并读回**关键内容"：它**能**证明容器与部件集
 * **不是明显坏的文件**（比"结构合法"更强一格，那是真实应用解析器给出的结论）；它**不能**证明
 * 生产授权的桌面 Office、或**目标平台的安卓办公应用**能打开——**后者至今未验证**。
 *
 * **工程纪律不因退出套件而失效**（R65.4）：R53.4（`inconclusive` 不算通过）/ R53.5（附着护栏）/
 * R53.6（显式超时，不改 `vitest.config.ts`）/ R53.7（清理带重试）/ R53.8 / R62 全部保留，
 * 它们约束的是本**可选工具**。防复发断言（R65.5）机器化在 `v8-contract-conformance.test.ts`：
 * 默认套件里**没有**任何 `*.test.ts` 依赖本文件。
 *
 * ## 编码：stdout 已被钉死为 UTF-8（W-FIX2），中文**无损**
 *
 * 被删掉的第三层用例（`office-open.test.ts`）曾因**修复前** stdout 是 GBK（代码页 936）、
 * 而 Node 侧按 UTF-8 解码，导致 `text` / `reason` 里的中文变成 U+FFFD（不可逆），故当时
 * **只能断言 ASCII 段**。W-FIX2 之后本模块改用 `[System.Text.Encoding]::UTF8.GetBytes`
 * **字节直写** stdout（见「输出编码」一节），**与机器默认代码页无关**，中文可无损取回
 * （实测 `合计 1500 元`、`budget.total：600 元 CNY`）。上述 ASCII-only 限制**已随 W-FIX2 解除**。
 *
 * ## 安全护栏（**先于一切功能**）
 *
 * COM 的 `New-Object -ComObject Word.Application` 在应用**已在运行**时会**附着到用户那个实例**。
 * 那时如果调 `$app.Quit()`，就可能关掉用户**未保存**的文档——这是不可接受的破坏。
 * 因此每个格式的第一步是：**该应用已在运行 ⇒ 直接记 `inconclusive` 并退出脚本**，绝不附着、绝不 Quit。
 *
 * ## 自毒与自清（W-FIX10）—— 只收自己造的孤儿，绝不碰别人的
 *
 * **实测两次**的缺陷：一次调用之后，机器上留下一个**无窗口**（`MainWindowTitle` 为空）的
 * `WINWORD.EXE` 孤儿（219–284 MB）。`$app.Quit()` 之后虽调了 `ReleaseComObject`，但 COM 的退出是
 * **异步**的：`Quit()` 返回 ≠ 进程已退出。孤儿一旦存在，**下一次调用就会被上面那条护栏判成
 * `inconclusive`** —— 仪器自己把自己毒死，第三层证据再也取不到。
 *
 * 修法遵守一条铁律：**只能清理我们自己造出来的进程**。依据是**调用前快照**——
 * 创建 COM 对象**之前**记下该应用当前的 PID 集合与时刻；它同时是护栏的依据（R53.5）
 * 与"哪些不是我们造的"的依据。
 *
 * **入口闸门（唯一）**：COM 实例化之后 **≤1 s 内**锁定"**本轮自己造的 PID 集合**"
 * （该 `process_name` 里**不在快照中**的那些 PID）。清理阶段**只在这个集合内**动手。
 * 这把"误杀用户此刻恰好启动的实例"的窗口从**整个脚本时长**（PowerPoint 实测 20–24 s）
 * 压到 **约 1 s**；集合之外的 PID 无论其它条件如何一律不杀。
 *
 * 集合之内仍要多条件与（纵深防御，**只减不增杀**）：
 * - 快照里已存在的 PID ⇒ 不是我们造的，**绝不杀**；
 * - 起于快照时刻之前 ⇒ 不是我们造的，**绝不杀**；
 * - **对 Word / Excel**：有主窗口标题 ⇒ 可能是用户正在用的实例，**绝不杀**
 *   （这两个应用我们设 `Visible = $false`，自家实例实测无标题 ⇒ 该判据成立）；
 * - 只有"属于本轮自己造的集合 **且** 通过上述条件"的 PID 才可能被 `Stop-Process -Id -Force` 收掉。
 *
 * **PowerPoint 的例外（实测踩到，必须照做）**：PowerPoint 的对象模型强制 `Visible = 1`
 * ⇒ **我们自己造的实例也有主窗口标题**（实测 `PowerPoint (未经授权产品)`）。若对它套用"标题为空"，
 * 就会把**我们自己的**孤儿挡在门外——实测表现为每轮遗留一个 300+ MB 的无窗口孤儿，
 * 且下一轮被护栏判 `inconclusive`（等于自毒复发）。故 PowerPoint **不套用**标题判据，
 * 以 `OwnPids` 集合为唯一闸门（那个集合本来就极窄：≤1 s 内新出现、且不在调用前快照中）。
 *
 * **绝不按进程名杀**（`taskkill /IM EXCEL.EXE` 之类会连用户的实例一起误杀）。
 * 条件不满足、或"自己造的集合"为空（进程起得比 1 s 还慢）时**宁可留着**，
 * 如实上报 `lingering_pids`，交由人判断——自动化不做它没有证据支持的破坏。
 * 清理读数写进结果的 `cleanup` 字段（`{ waited_ms, killed_pids, lingering_pids }`），
 * 既有字段语义一律不变。
 *
 * ## 三种判定（**不得互相冒充**）
 *
 * - `opened`：应用打开了文件并读回了内容。这是"可打开"的**实测证据**。
 * - `inconclusive`：环境原因没做成（应用已在运行 / 超时 / 首次运行对话框）。
 *   **不是失败，但也绝不是通过**——调用方必须把该项标为**未验证**。
 * - `failed`：应用明确报出文件无效。这是**被测产物**的问题。
 *
 * ## 为什么把路径放进环境变量
 *
 * 路径直接拼进 `-Command` 会撞上 PowerShell 的引号/转义规则。放进 `POTBOT_OPEN_TARGET`
 * 由脚本读，彻底避开转义问题。
 *
 * ## 输出编码：把 stdout 钉死为 UTF-8（W-FIX2）
 *
 * 本机 PowerShell 的**输出**代码页是 **936（GB2312）**（实测 `ACP=936` / `OEMCP=gb2312`），
 * 而 Node 侧按 UTF-8 解码 ⇒ `text` / `reason` 里的中文会变成 **U+FFFD 替换字符（不可逆）**，
 * 于是"人可读证据"失效、判据只能退化成 ASCII 段。修法**不是**把中文转义成 `\uXXXX`
 * （那会让 `text` 不可读，属于仪器自欺），而是**真的修正编码**，两重保险：
 *
 * 1. 脚本最前面把 `[Console]::OutputEncoding` / `$OutputEncoding` 置为 UTF-8，并 `chcp 65001`；
 * 2. 结果 JSON 用 `[System.Text.Encoding]::UTF8.GetBytes` **直接写标准输出流**，
 *    绕开 Console 的编码转换 ⇒ **与机器默认代码页无关**（默认代码页不同的机器上同样无损）。
 *
 * 直写字节同时保证**不写 BOM**——Node 侧靠"以 `{` 开头的行即结果"解析，BOM 会让首行匹配不上。
 * 前导里的编码赋值排在 `$ErrorActionPreference = 'Stop'` **之前**：个别环境下
 * 改 `[Console]::OutputEncoding` 若报错也只是非终止错误，脚本继续往下走，
 * 真正扛事的是第 2 条（字节直写）——所以这一层不依赖前一条是否成功。
 */

import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';

/** 一个格式对应的 Office 应用与该应用的可执行文件名（用于"是否已在运行"的护栏）。 */
interface OfficeApp {
  readonly extension: string;
  readonly application: string;
  readonly process_name: string;
}

const OFFICE_APPS: readonly OfficeApp[] = Object.freeze([
  { extension: '.docx', application: 'Word', process_name: 'WINWORD' },
  { extension: '.xlsx', application: 'Excel', process_name: 'EXCEL' },
  { extension: '.pptx', application: 'PowerPoint', process_name: 'POWERPNT' },
]);

/** 按扩展名取应用；不支持的扩展名返回 `null`（调用方据此报"不适用"，不是"通过"）。 */
export function officeAppFor(filePath: string): OfficeApp | null {
  const extension = extname(filePath).toLowerCase();
  return OFFICE_APPS.find((candidate) => candidate.extension === extension) ?? null;
}

/**
 * **本轮调用的清理读数**（W-FIX10，新增）。
 *
 * 语义边界（不得延伸解读）：
 * - `killed_pids` **只**可能是"快照之后新出现 **且** 无窗口标题"的 PID——任何一个快照里已存在的
 *   PID 都**不可能**出现在这里（这是"绝不碰别人的进程"的机器保证）。
 * - `lingering_pids` 是清理动作**结束后独立回读**到的该应用 PID（**可能含别人的实例**：
 *   若为快照非空的情形，这里就是那些预先存在的进程）——它如实反映"机器上还剩谁"，不承诺干净。
 * - `waited_ms` 是等待该应用进程**自行退出**累计的毫秒数（最多 15 × 200 ms = 3000 ms）。
 */
export interface OfficeCleanup {
  readonly waited_ms: number;
  readonly killed_pids: readonly number[];
  readonly lingering_pids: readonly number[];
}

/** COM 打开检查的结果（**确定性**：不含时间戳）。 */
export interface OfficeOpenResult {
  readonly file: string;
  readonly application: string;
  readonly verdict: 'opened' | 'inconclusive' | 'failed';
  /** 判定原因（`opened` 时为空串）。 */
  readonly reason: string;
  /** 应用读回的文本（`opened` 时用于断言"文件里确实有这些内容"）。 */
  readonly text: string;
  /** 应用自报的规模信息（段落数 / 工作表行数 / 幻灯片数），便于交叉核对。 */
  readonly detail: string;
  /**
   * 本轮调用的清理读数（W-FIX10）。**可选**：仅当 PowerShell 脚本**真的回传了**读数时存在。
   * `undefined` 表示**未取得读数**（spawn 失败 / stdout 为空 / 结果不可解析），
   * **不表示**"机器上没有遗留进程"——不得把它当"干净"的证据（工作规则 5：结果不得编造）。
   */
  readonly cleanup?: OfficeCleanup;
}

const OPEN_TIMEOUT_MS = 90_000;

/**
 * **输出编码前导**（W-FIX2）：把 PowerShell 的 stdout 钉死为 UTF-8，中文才能无损回到 Node。
 *
 * 本机实测 `ACP=936` / `OEMCP=gb2312`，默认输出的中文经 UTF-8 解码会变成 U+FFFD（不可逆）。
 * 见文件头「输出编码」。
 */
const UTF8_OUTPUT_PREAMBLE = `
# ① 控制台输出编码 -> UTF-8（对 Console 自身的输出生效，含 stderr 的错误记录）
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 > $null
# ② 结果 JSON 用 UTF-8 字节直写 stdout：绕开 Console 的编码转换 => 与机器默认代码页无关。
#    直写字节不产生 BOM，避免破坏 Node 侧"以 { 开头的行即结果"的解析。
#    两种调用写法都支持（脚本内按上下文取用）：Write-Utf8Json <对象>  或  <对象> | Write-Utf8Json。
function Write-Utf8Json {
  param([Parameter(ValueFromPipeline = $true, Position = 0)] $payload)
  process {
    $json = $payload | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $stream = [System.Console]::OpenStandardOutput()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
  }
}
`;

/**
 * **孤儿清理前导**（W-FIX10）：只收掉**我们自己造出来**的 Office 孤儿，绝不碰别人的。
 *
 * 判据分两层，**越靠前越窄**：
 *
 * 1. `Get-OfficeOwnPids`：在 `New-Object -ComObject` 之后 **≤1 s 内**锁定"**本轮自己造的 PID 集合**"
 *    （该 `process_name` 里**不在调用前快照中**的那些 PID）。这是**唯一的入口闸门**——
 *    集合之外的任何 PID，无论其它条件如何，一律不杀。**把误伤窗口从整个脚本时长（PowerPoint 实测
 *    20–24 s）压到约 1 s**：只有恰好在这 1 s 内启动、且此后再不出现的进程才可能进集合。
 * 2. `Invoke-OfficeOrphanCleanup` 内仍是**多条件与**：① 在 `OwnPids` 集合内；② 不在快照 PID 集合里；
 *    ③ `StartTime` 晚于快照时刻（读不到则放弃杀）；④ 标题为空——**仅对 `-RequireEmptyTitle $true`
 *    的应用（Word / Excel）生效**。②③④ 是纵深防御（②与①的推导重复，③④再各挡一层），**只减不增杀**。
 *    **PowerPoint 传 `$false`**：它强制 `Visible = 1`，自家实例也有标题（实测 `PowerPoint (未经授权产品)`），
 *    套用标题判据会把自家孤儿挡在门外 ⇒ 以 ① 为唯一闸门。见下方 `scriptFor()` 的 `requireEmptyTitle`。
 *
 * 此外**只按 PID 杀**，绝不按进程名杀。集合为空（进程起得比 1 s 还慢，或本轮压根没起）⇒
 * 一个也不杀，如实把 `lingering_pids` 上报给人——宁可留孤儿，也不做判据之外的破坏。
 *
 * 注意：本段在 `$ErrorActionPreference = 'Stop'` **之前**注入，但函数体内部对"可预期会失败"的调用
 * 都显式给了 `-ErrorAction SilentlyContinue` / 自带 `try/catch`，因此不依赖该变量的取值。
 * 本段**不得**出现反引号（TS 模板字面量定界符）与 `${`（会被 TS 抢先插值）。
 */
const CLEANUP_PREAMBLE = `
function Get-OfficeOwnPids {
  param([string] $ProcessName, [int[]] $SnapshotPids)
  # 在 COM 实例化之后尽快锁定"本轮自己造的 PID 集合"：最多 10 x 100 ms（约 1 s）。
  # 进程出现得更慢 => 返回空集合 => 清理阶段一个也不杀（保守方向，宁可留孤儿）。
  $found = @()
  for ($probe = 0; $probe -lt 10; $probe++) {
    $found = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id } | Where-Object { $SnapshotPids -notcontains $_ })
    if ($found.Count -gt 0) { break }
    Start-Sleep -Milliseconds 100
  }
  return $found
}

function Invoke-OfficeOrphanCleanup {
  param([string] $ProcessName, [datetime] $SnapshotTime, [int[]] $SnapshotPids, [int[]] $OwnPids, [bool] $RequireEmptyTitle = $true)
  # ① 轮询等待该应用**自行退出**：Quit() 返回 != 进程已退出（COM 退出是异步的，实测约 2.8 s）。
  $waitedMs = 0
  for ($attempt = 0; $attempt -lt 15; $attempt++) {
    $alive = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
    if ($alive.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
    $waitedMs += 200
  }
  # ② 仍未退出 => 只收"本轮自己造的 且 无窗口标题"的 PID。
  $killedPids = @()
  $stillAlive = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
  foreach ($proc in $stillAlive) {
    if ($OwnPids -notcontains $proc.Id) { continue }          # ← 唯一入口闸门：不在"我造的集合"里，一律不杀
    if ($SnapshotPids -contains $proc.Id) { continue }        # 纵深防御：不是我们造的
    $started = $null
    try { $started = $proc.StartTime } catch { $started = $null }
    if ($started -eq $null) { continue }                      # 读不到起始时刻 => 不可判定 => 放弃杀
    if ($started -le $SnapshotTime) { continue }              # 起于快照之前 => 不是我们造的
    if ($RequireEmptyTitle) {
      $title = ''
      try { $title = [string]$proc.MainWindowTitle } catch { $title = '' }
      if ($title -ne '') { continue }                         # 有窗口 => 可能是用户正在用的实例
    }
    try {
      Stop-Process -Id $proc.Id -Force -ErrorAction Stop      # 只按 PID，绝不按进程名
      $killedPids += $proc.Id
    } catch { }
  }
  if ($killedPids.Count -gt 0) { Start-Sleep -Milliseconds 200 }
  # ③ 独立回读"还剩谁"——如实上报，可能包含别人的实例。
  $lingering = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  return @{ waited_ms = $waitedMs; killed_pids = @($killedPids); lingering_pids = @($lingering) }
}
`;

/** 生成某格式的 PowerShell 脚本。`$env:POTBOT_OPEN_TARGET` 由调用方注入。 */
function scriptFor(app: OfficeApp): string {
  // 前导的两条编码赋值排在 `$ErrorActionPreference = 'Stop'` 之前：即使某环境下设置
  // `[Console]::OutputEncoding` 抛错，也只是非终止错误，脚本继续走 ② 的字节直写。
  const guard = `${UTF8_OUTPUT_PREAMBLE}
${CLEANUP_PREAMBLE}
$ErrorActionPreference = 'Stop'
$path = $env:POTBOT_OPEN_TARGET
# ── 调用前快照（W-FIX10）：在创建 COM 对象**之前**记下该应用当前已存在的进程。
#    它一身二任：① 是 R53.5 护栏的依据；② 是清理时"哪些进程不是我们造的"的白名单。
$snapshotTime = Get-Date
$snapshotPids = @(Get-Process -Name ${app.process_name} -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$running = $snapshotPids.Count
if ($running -gt 0) {
  Write-Utf8Json @{ verdict = 'inconclusive'; reason = '${app.application} 已在运行：拒绝附着到用户会话（护栏），不触碰其文档'; text = ''; detail = ''; cleanup = @{ waited_ms = 0; killed_pids = @(); lingering_pids = $snapshotPids } }
  exit 0
}
`;

  // 每条出口都**显式 `exit 0`**：PowerShell 会把"最后一条命令的 `$?`"当作进程退出码，
  // 而 `Get-Process` 找不到进程时 `$?` 为假 ⇒ 退出码 1（实测）。若不显式归零，
  // 调用侧会把"成功打开"误当成失败。
  //
  // 结尾（**两条路径共用**：打开成功与 catch 到的失败都走到这里）：
  // finally 已做完 Quit + ReleaseComObject（保持原样），此处再**轮询等待进程退出**，
  // 仍未退出才收掉"自己造的、无窗口的"孤儿，最后把读数并入结果一起输出。
  // 位置在 `Write-Utf8Json` **之前**是必须的——清理读数必须出现在返回结构里。
  // `-OwnPids $ownPids` 是**入口闸门**：清理阶段只在这个集合内动手（见 CLEANUP_PREAMBLE）。
  //
  // `-RequireEmptyTitle`：**只有"我们让它保持无窗口"的应用才成立**。
  // Word / Excel 我们设 `Visible = $false`，自家实例的 `MainWindowTitle` 实测为空 ⇒ 该判据可用。
  // **PowerPoint 例外**：对象模型强制 `Visible = 1`（见本文件 PowerPoint 分支的注释），自家实例必有
  // 主窗口标题（实测 `PowerPoint (未经授权产品)`）⇒ 该判据在 PowerPoint 上是**假阴性**，会把**我们自己的**
  // 孤儿挡在门外（实测：`own` 已含该 PID，却因标题非空而不杀 ⇒ 每次遗留一个 300+ MB 孤儿、下轮自毒）。
  // 故对 PowerPoint **不套用**标题判据，以 `OwnPids` 集合为唯一闸门。
  const requireEmptyTitle = app.application !== 'PowerPoint';
  const cleanupTail = `
$result.cleanup = Invoke-OfficeOrphanCleanup -ProcessName '${app.process_name}' -SnapshotTime $snapshotTime -SnapshotPids $snapshotPids -OwnPids $ownPids -RequireEmptyTitle $${requireEmptyTitle ? 'true' : 'false'}
Write-Utf8Json $result
exit 0
`;

  // 在 COM 实例化之后**立刻**锁定"本轮自己造的 PID 集合"（≤1 s）——清理的唯一入口闸门。
  // 它把"误杀用户此刻恰好启动的实例"的窗口从整个脚本时长（PowerPoint 实测 20–24 s）压到约 1 s。
  const ownPidsCapture = `
# ── 锁定"我自己造的 PID 集合"（W-FIX10 收窄）：COM 实例化之后 <=1 s 内取"不在调用前快照里"的那些 PID。
#    清理阶段**只在这个集合内**动手；集合为空则一个也不杀（保守方向，宁可留孤儿并如实上报）。
$ownPids = @(Get-OfficeOwnPids -ProcessName '${app.process_name}' -SnapshotPids $snapshotPids)
`;

  if (app.application === 'Word') {
    return `${guard}
$app = New-Object -ComObject Word.Application
$app.Visible = $false
$app.DisplayAlerts = 0
$app.AutomationSecurity = 3
${ownPidsCapture}$result = @{ verdict = 'inconclusive'; reason = '未预期路径：脚本未产生判定'; text = ''; detail = '' }
try {
  $doc = $app.Documents.Open($path, $false, $true)
  $text = $doc.Content.Text
  $detail = 'paragraphs=' + $doc.Paragraphs.Count + '; words=' + $doc.Words.Count
  $doc.Close(0)
  $result = @{ verdict = 'opened'; reason = ''; text = $text; detail = $detail }
} catch {
  $result = @{ verdict = 'failed'; reason = 'Word 拒绝打开：' + $_.Exception.Message; text = ''; detail = '' }
} finally {
  # Quit/Release 各自 try 住：任一步抛错都不能让结尾的孤儿清理被跳过（那正是孤儿留下的原因之一）。
  try { $app.Quit() } catch { }
  try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
}
${cleanupTail}`;
  }

  if (app.application === 'Excel') {
    return `${guard}
$app = New-Object -ComObject Excel.Application
$app.Visible = $false
$app.DisplayAlerts = $false
${ownPidsCapture}$result = @{ verdict = 'inconclusive'; reason = '未预期路径：脚本未产生判定'; text = ''; detail = '' }
try {
  $wb = $app.Workbooks.Open($path, 0, $true)
  $ws = $wb.Worksheets.Item(1)
  $rows = $ws.UsedRange.Rows.Count
  $cols = $ws.UsedRange.Columns.Count
  $sb = New-Object System.Text.StringBuilder
  for ($r = 1; $r -le $rows; $r++) {
    for ($c = 1; $c -le $cols; $c++) {
      [void]$sb.Append([string]$ws.Cells.Item($r, $c).Text)
      [void]$sb.Append([char]9)
    }
    [void]$sb.Append([char]10)
  }
  $text = $sb.ToString()
  $detail = 'sheets=' + $wb.Worksheets.Count + '; rows=' + $rows + '; cols=' + $cols
  $wb.Close($false)
  $result = @{ verdict = 'opened'; reason = ''; text = $text; detail = $detail }
} catch {
  $result = @{ verdict = 'failed'; reason = 'Excel 拒绝打开：' + $_.Exception.Message; text = ''; detail = '' }
} finally {
  # Quit/Release 各自 try 住：任一步抛错都不能让结尾的孤儿清理被跳过（那正是孤儿留下的原因之一）。
  try { $app.Quit() } catch { }
  try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
}
${cleanupTail}`;
  }

  // PowerPoint：`Visible` 必须为真（对象模型要求），但 `Presentations.Open` 的
  // `WithWindow = $false` 让它**不开演示窗口**，因此不会闪窗。
  return `${guard}
$app = New-Object -ComObject PowerPoint.Application
$app.Visible = 1
${ownPidsCapture}$result = @{ verdict = 'inconclusive'; reason = '未预期路径：脚本未产生判定'; text = ''; detail = '' }
try {
  $pres = $app.Presentations.Open($path, $true, $false, $false)
  $sb = New-Object System.Text.StringBuilder
  $slideCount = $pres.Slides.Count
  foreach ($slide in $pres.Slides) {
    foreach ($shape in $slide.Shapes) {
      if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) {
        [void]$sb.Append([string]$shape.TextFrame.TextRange.Text)
        [void]$sb.Append([char]10)
      }
    }
  }
  $text = $sb.ToString()
  $detail = 'slides=' + $slideCount
  $pres.Close()
  $result = @{ verdict = 'opened'; reason = ''; text = $text; detail = $detail }
} catch {
  $result = @{ verdict = 'failed'; reason = 'PowerPoint 拒绝打开：' + $_.Exception.Message; text = ''; detail = '' }
} finally {
  # Quit/Release 各自 try 住：任一步抛错都不能让结尾的孤儿清理被跳过（那正是孤儿留下的原因之一）。
  try { $app.Quit() } catch { }
  try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
}
${cleanupTail}`;
}

/** 把脚本回传的 `cleanup` 读数解析成 `OfficeCleanup`；缺失或形状不符 ⇒ `undefined`（不猜、不补零）。 */
function parseCleanup(raw: unknown): OfficeCleanup | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as { readonly [key: string]: unknown };
  const pidList = (value: unknown): readonly number[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    if (!value.every((entry) => typeof entry === 'number' && Number.isInteger(entry))) return undefined;
    return Object.freeze(value as number[]);
  };
  const waited = record['waited_ms'];
  const killed = pidList(record['killed_pids']);
  const lingering = pidList(record['lingering_pids']);
  if (typeof waited !== 'number' || !Number.isFinite(waited)) return undefined;
  if (killed === undefined || lingering === undefined) return undefined;
  return Object.freeze({ waited_ms: waited, killed_pids: killed, lingering_pids: lingering });
}

/**
 * 用目标软件（Word / Excel / PowerPoint）打开一个产物并读回内容。
 *
 * **不抛错**：环境问题记 `inconclusive`，文件问题记 `failed`，成功记 `opened`。
 * 调用方必须把 `inconclusive` 当作**未验证**处理，不得当作通过。
 */
export function openWithOffice(absolutePath: string): OfficeOpenResult {
  const app = officeAppFor(absolutePath);
  if (app === null) {
    return Object.freeze({
      file: absolutePath,
      application: 'n/a',
      verdict: 'inconclusive',
      reason: `没有为该扩展名登记的 Office 应用（${extname(absolutePath) || '无扩展名'}）`,
      text: '',
      detail: '',
    });
  }

  const command = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', scriptFor(app)];
  // 用 `spawnSync` 而**不是** `execFileSync`：后者在非零退出码时抛错，会把"已成功打开"
  // 误判成环境失败。这里要的是 stdout，退出码只作参考（脚本每条出口都已显式 `exit 0`）。
  const spawned = spawnSync('powershell.exe', command, {
    encoding: 'utf8',
    timeout: OPEN_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, POTBOT_OPEN_TARGET: absolutePath },
  });
  const stdout = typeof spawned.stdout === 'string' ? spawned.stdout : '';

  if (spawned.error !== undefined && spawned.error !== null) {
    const message = String(spawned.error.message ?? spawned.error);
    const timedOut = /ETIMEDOUT|timed out/i.test(message);
    return Object.freeze({
      file: absolutePath,
      application: app.application,
      verdict: 'inconclusive',
      reason: timedOut
        ? `调用 ${app.application} 超时（${OPEN_TIMEOUT_MS} ms）——可能弹出了首次运行/授权对话框`
        : `PowerShell 调用失败（可能是环境问题，不是文件问题）：${message.slice(0, 300)}`,
      text: '',
      detail: '',
    });
  }
  if (stdout.trim() === '') {
    return Object.freeze({
      file: absolutePath,
      application: app.application,
      verdict: 'inconclusive',
      reason: `PowerShell 无输出（退出码 ${String(spawned.status)}）；可能是环境问题：${
        String(spawned.stderr ?? '').trim().slice(0, 200) || '无 stderr'
      }`,
      text: '',
      detail: '',
    });
  }

  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .pop();
  if (line === undefined) {
    return Object.freeze({
      file: absolutePath,
      application: app.application,
      verdict: 'inconclusive',
      reason: `未能从 PowerShell 输出里解析结果：${stdout.trim().slice(0, 200)}`,
      text: '',
      detail: '',
    });
  }

  const parsed = JSON.parse(line) as {
    readonly verdict?: string;
    readonly reason?: string;
    readonly text?: string;
    readonly detail?: string;
    readonly cleanup?: unknown;
  };
  const verdict =
    parsed.verdict === 'opened' || parsed.verdict === 'failed' || parsed.verdict === 'inconclusive'
      ? parsed.verdict
      : 'inconclusive';
  const cleanup = parseCleanup(parsed.cleanup);

  // 只加 `cleanup` 一个字段；上面六个字段的类型与取值口径**一字未改**。
  if (cleanup === undefined) {
    return Object.freeze({
      file: absolutePath,
      application: app.application,
      verdict,
      reason: parsed.reason ?? '',
      text: parsed.text ?? '',
      detail: parsed.detail ?? '',
    });
  }
  return Object.freeze({
    file: absolutePath,
    application: app.application,
    verdict,
    reason: parsed.reason ?? '',
    text: parsed.text ?? '',
    detail: parsed.detail ?? '',
    cleanup,
  });
}
