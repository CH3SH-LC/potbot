#!/usr/bin/env node
/**
 * K-R01 · 手机内核线「无电脑静态依赖 / 网络路径 / 私密值」审计器（零依赖）
 * =====================================================================
 *
 * 出处
 * ----
 * - 总方案 §8：「源码新增 NUL/编码、硬编码电脑地址、私密值与桌面依赖应纳入手机包检查」。
 * - K 线 K-R01：「无电脑静态依赖/网络路径审计」。
 *
 * 它做什么
 * --------
 * 对「产品将进入手机的源码面」做纯静态文本扫描，输出机器可读 JSON + 人读摘要。
 * **不改任何产品源码**：只报告文件:行号与上下文，修复由对应包领。
 *
 * 口径（与 README.md 一致，改动须同时改两边）
 * ----------------------------------------
 * 扫描面（include）
 *   - src/**                  手机内核迁移**目标面**（migrationSurface = target）
 *   - apps/demo/server/**     电脑侧宿主 = 迁移**参考面**（reference，不进手机）
 *   - apps/mobile-kernel/**   若存在（target）
 *   - apps/mobile-ui/**       若存在（target）
 *   - src/mobile-plugins/**   若存在（target）
 *   - apps/android/**         安卓 App 壳 = 真机侧（target，**超出任务书字面重点面**，理由见 README）
 * 排除面（exclude）
 *   - docs/**  tests/**  node_modules/**  .runtime/**  .claude/**  .git/**  .task-manifest/**
 *     .dev-evidence/**  dist/**  build/**  coverage/**  __pycache__/**
 *   - 文件名匹配 *.test.ts / *.spec.ts（含 .tsx/.js/.mjs 变体）
 *   - 非代码扩展名（只扫 ts/tsx/js/jsx/mjs/cjs/java/kt/xml/gradle）
 *   - 二进制文件（正文含 NUL 字节）——单独列入 scope.skippedBinary，**不计入规则命中**，
 *     以免把 PDF/DOCX 夹具的二进制 NUL 误报成「源码裸 NUL」
 *
 * 五条规则见 RULES（每条带 why / source）。
 *
 * 输出
 * ----
 * - `hits`：全量命中（含注释/测试/参考面/已声明例外），每条带 `blockerClass`；
 * - `summary.blockers`：device-only 阻断投影（hard / conditional）——见 classifyDeviceOnly；
 * - `validateReport(report)`：结构校验；`report.schema.json`：供外部消费者的 JSON Schema。
 *
 * 用法
 * ----
 *   node tests/mobile-kernel/K-R01/audit.mjs                 # 人读摘要 + 写 baseline-report.json
 *   node tests/mobile-kernel/K-R01/audit.mjs --json          # 额外把 JSON 打到 stdout
 *   node tests/mobile-kernel/K-R01/audit.mjs --no-write      # 不写基线文件
 *   node tests/mobile-kernel/K-R01/audit.mjs --root <dir>    # 扫别的根（单元测试用）
 *   node tests/mobile-kernel/K-R01/audit.mjs --out <file>    # 指定基线输出路径
 *   node tests/mobile-kernel/K-R01/audit.mjs --max-hits <n>  # 每规则每文件上限（默认 200）
 *
 * 退出码：0 = 扫描完成（**不论有无命中**）；1 = 扫描本身失败。
 * 注意：命中不是失败。本包**不**断言仓库零命中（会把现存问题变成测试红）。
 *
 * 密钥红线：疑似密钥**只报形状与长度，绝不回显原值**（见 redactSecret）。
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
export const AUDITOR_ID = 'K-R01-desktop-dependency-audit';

// ─────────────────────────────────────────────────────────────────────────────
// 1. 口径常量
// ─────────────────────────────────────────────────────────────────────────────

export const SCOPE = {
  /** 扫描根。prefix 为仓库相对路径；resolveSurface 取**最长**匹配前缀以去重（src 与 src/mobile-plugins 重叠）。 */
  includeRoots: [
    { id: 'kernel', prefix: 'src', migrationSurface: 'target', note: '手机内核迁移目标面' },
    { id: 'demo-server', prefix: 'apps/demo/server', migrationSurface: 'reference', note: '电脑侧宿主，迁移参考面（不进手机）' },
    { id: 'mobile-kernel', prefix: 'apps/mobile-kernel', migrationSurface: 'target', note: 'K 线手机内核（若存在）' },
    { id: 'mobile-ui', prefix: 'apps/mobile-ui', migrationSurface: 'target', note: '前端线手机 UI（若存在）' },
    { id: 'mobile-plugins', prefix: 'src/mobile-plugins', migrationSurface: 'target', note: '手机插件（若存在）' },
    { id: 'android-app', prefix: 'apps/android', migrationSurface: 'target', note: '安卓 App 壳（真机侧）' },
  ],
  /** 目录名黑名单：任何层级出现即整棵剪掉。 */
  excludeDirs: new Set([
    'node_modules', 'docs', 'tests', '.runtime', '.claude', '.git', '.task-manifest',
    '.dev-evidence', 'dist', 'build', 'coverage', '__pycache__', '.pnpm-store', '.gradle',
  ]),
  /** 只扫这些扩展名的文件。 */
  codeExts: new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'kt', 'xml', 'gradle']),
  /** 扫描面里的**二进制夹具**扩展名：不扫正文，但要在报告里**点名**（避免「没扫也不说」）。 */
  binaryExts: new Set(['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'zip', 'gz', 'bin', 'ttf', 'otf', 'woff', 'woff2', 'jar', 'so', 'keystore', 'jks']),
  /** 测试文件（连同类 harness 一起，作为「测试上下文」而非排除——见 contextOf）。 */
  testFileRe: /\.(test|spec)\.[cm]?[jt]sx?$/,
};

/** Node 专用内建模块：手机运行时（RN / nodejs-mobile 精简运行时）不存在或需 polyfill。 */
const TIER1_MODULES = new Set([
  'fs', 'fs/promises', 'child_process', 'path', 'path/posix', 'path/win32',
]);
const TIER2_MODULES = new Set([
  'os', 'worker_threads', 'vm', 'cluster', 'net', 'http', 'https', 'dns', 'tls', 'zlib',
  'crypto', 'readline', 'async_hooks', 'perf_hooks', 'module', 'v8', 'repl', 'tty',
  'dgram', 'inspector', 'constants', 'buffer', 'stream/web', 'stream/consumers',
]);
const NODE_ONLY_MODULES = new Set([...TIER1_MODULES, ...TIER2_MODULES]);

/**
 * 私密值探针的标识符上下文词（仅用于**判定**；判定结果里不会回显原值）。
 * 边界需同时认 `\b` 与 **camelCase 驼峰边界**——真实代码写的是 `clientSecret` / `accessToken`，
 * 只用 `\bsecret\b` 会因前面是字母而漏掉（本包 unit test 的 `clientSecret` 样例钉这一点）。
 */
const SECRET_IDENTIFIER_RE = /(?:\b|(?<=[a-z])(?=[A-Z]))(?:api[_-]?key|apikey|access[_-]?key|secret|token|passwd|password|passphrase|credential|authorization|private[_-]?key)\b/i;

/** 已知例外：**降级不隐藏**——命中仍在列表里，只是 severity 降为 info 并挂 reason。 */
export const KNOWN_EXCEPTIONS = [
  {
    id: 'EX-A1',
    rule: 'R2',
    pathRe: /^apps\/android\/.*\.(java|xml)$/,
    reason:
      '荣耀真机开发期经 `adb reverse` 走本机回环（127.0.0.1:8765）；源码注释已明确标注「那只是开发便利」，'
      + '并配有严格判定（scheme/http + host/127.0.0.1 + port/8765）。属真机侧开发便利，非产品依赖 LAN 地址。',
  },
  {
    id: 'EX-K1',
    rule: 'R2',
    pathRe: /^src\/adapters\/research\/(query-port|not-ready)\.ts$/,
    reason:
      '该字符串是**给用户看的「未装配」说明文案**，陈述「仅有模型路由器 127.0.0.1:8008」这一现状，'
      + '本身不建立网络连接。仍保留在列表以便复核，但非可执行依赖。',
  },
  {
    id: 'EX-K2',
    rule: 'R3',
    pathRe: /^src\/(artifacts\/planner|plugins\/declarative-package)\.ts$/,
    reason:
      'Windows 盘符仅出现在**注释**里（说明路径语义 / 声明不做 URL 识别），不是路径字面量。',
  },
  {
    id: 'EX-A2',
    rule: 'R2',
    pathRe: /^apps\/mobile-kernel\/bootstrap\/origin\.ts$/,
    reason:
      '该文件是 K01 的**本地 origin 白名单**，`https://localhost` 是 Android WebView 的**本机回环**映射，'
      + '与「电脑侧 Node 服务」无关。文件自带说明：「只有本地 origin 允许提交命令」，并明确'
      + '「远程 origin（https://evil.example、http://10.0.2.2 等）一律拒绝」。属 device-only 正确写法。',
  },
  {
    id: 'EX-A3',
    rule: 'R3',
    pathRe: /^apps\/mobile-kernel\/bootstrap\/origin\.ts$/,
    reason:
      '同上：`file:///android_asset` 是 APK 内本地资源（README §3「页面必须随 APK 本地加载」），'
      + '不是电脑桌面路径字面量，属 device-only 正确写法。',
  },
  {
    id: 'EX-M1',
    rule: 'R4',
    pathRe: /^apps\/mobile-ui\/.*\.config\.ts$/,
    reason:
      '构建/测试工具配置（vitest.config）**不进手机运行**，其 `node:path` 用法是本机测试harness的正常依赖。'
      + '文件自带说明「只读用途，不改用任何网络 / 设备 / 时钟依赖」。仅命中 dev-time 配置，非产品运行路径。',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. 规则定义（每条带 why 与出处）
// ─────────────────────────────────────────────────────────────────────────────

export const RULES = [
  {
    id: 'R1',
    title: '裸 NUL / 不可见控制字符 / BOM',
    why:
      '裸 NUL 与控制字符会让源码在手机端解包/编译时被截断或产生不可见差异；'
      + 'BOM 与零宽字符会造成「同内容不同字节」，破坏逐字节校验与补丁合并。',
    source: '总方案 §8（「源码新增 NUL/编码 … 应纳入手机包检查」）',
    severity: 'high',
  },
  {
    id: 'R2',
    title: '硬编码电脑地址（回环 / 私网 / 通配绑定）',
    why:
      '手机上没有「本机 127.0.0.1 的同级 Node 服务」这回事（数字员工场景例外：美团团购核销等直连本机服务另议）。'
      + '产品运行路径若写死回环或私网地址，装机即不可达；0.0.0.0 更会把服务暴露到局域网。',
    source: '总方案 §8；K-R01「无电脑静态依赖/网络路径审计」',
    severity: 'high',
  },
  {
    id: 'R3',
    title: '桌面绝对路径字面量（Windows 盘符 / UNC / 家目录 / file URL）',
    why:
      'C:\\ / D:\\ / \\\\?\\ / /Users/ / /home/ 在安卓上不存在对应挂载点；写死即路径解析失败。',
    source: '总方案 §8；K-R01「无电脑静态依赖/网络路径审计」',
    severity: 'high',
  },
  {
    id: 'R4',
    title: 'Node 桌面专属依赖（node:fs / node:child_process / node:path / Buffer 等）',
    why:
      '手机运行时不保证有 Node 内建模块与 Buffer 全局；fs 语义（同步 IO、路径分隔符、权限）也与安卓分区/SELinux 不一致。'
      + 'tier1 = 任务书 §8 点名的四项；tier2 = 同类 Node 内建（观察项，供迁移评估）。',
    source: '总方案 §8；K-R01 规则 4',
    severity: 'high',
  },
  {
    id: 'R5',
    title: '疑似密钥 / 私密值字面量',
    why:
      '密钥若以字面量进入手机包，等于随 APK 分发；且一旦入库即无法回收。密钥应走手机侧密钥存储，不入源码。',
    source: '总方案 §8；CLAUDE.md 规则 0（「密钥存储…在手机」）；.gitignore「密钥不进入代码仓库」',
    severity: 'high',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 3. 上下文 / 严重度判定（启发式，README 有误报说明）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判断命中所在「上下文」——回答任务书要求的「区分测试/默认绑定/文档说明与产品依赖」。
 * 纯启发式：按文件路径与所在行文本判断，不解析 AST。误报口径见 README「已知局限」。
 */
export function contextOf(line, relPath) {
  const p = String(relPath || '').toLowerCase().replace(/\\/g, '/');
  if (SCOPE.testFileRe.test(p) || /(^|\/)(__tests__|__fixtures__)\//.test(p) || /harness/.test(p)) {
    return 'test';
  }
  const t = String(line || '').trim();
  if (
    t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')
    || t.startsWith('#') || t.startsWith('<!--') || t.startsWith('--')
  ) {
    return 'comment';
  }
  if (/\b(listen|bind|bindAddress|host|hostname|HOST|BIND)\b/i.test(line) || /\bdefault\b/i.test(line)) {
    return 'bind-or-default';
  }
  if (/\b(URL|endpoint|origin)\b/i.test(line)) {
    return 'endpoint-constant';
  }
  return 'product';
}

/** 上下文 → severity。product 才是「产品依赖」，其余按可解释性逐级降档。 */
export function severityFor(context, base) {
  switch (context) {
    case 'test':
    case 'comment':
      return 'info';
    case 'bind-or-default':
    case 'endpoint-constant':
      return 'medium';
    default:
      return base;
  }
}

function applyExceptions(hit) {
  for (const ex of KNOWN_EXCEPTIONS) {
    if (ex.rule !== hit.rule) continue;
    if (!ex.pathRe.test(hit.path)) continue;
    return { ...hit, severity: 'info', exceptionId: ex.id, exceptionReason: ex.reason };
  }
  return hit;
}

/**
 * 迁移**参考面**（apps/demo/server，不进手机）的 high 降为 medium —— 它的 desktop 依赖
 * 是**预期之内**的，价值在于「迁移时判定照抄还是改写」，不该与内核目标面同权计噪。
 * 裸 NUL（subtype=nul）例外：编码缺陷无论在哪一面都是真缺陷，保持 high。
 * `migrationSurface` 字段始终保留在每个命中上，消费者也可自行过滤。
 */
function applySurfaceCap(hit) {
  if (hit.migrationSurface === 'reference' && hit.severity === 'high' && hit.subtype !== 'nul') {
    return { ...hit, severity: 'medium', severityNote: 'capped: reference surface' };
  }
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3.5 破坏「无电脑运行」的判定（device-only blocker 投影）
// ─────────────────────────────────────────────────────────────────────────────
//
// 任务书要求「静态审计会破坏无电脑（device-only）运行的桌面与网络依赖，产出机器可读清单」。
// 原始 `hits` 是**全量噪音清单**（含注释、测试、参考面、已声明的开发便利例外）。
// 本投影把它收窄成**一条真的会让 APK 在手机上跑不起来的产品路径命中**，
// 使「到底有几处硬阻断」成为可计算、可断言、消费者可过滤的字段，而不是靠人读 README。

/** 严重度词表（与 report-types.ts / report.schema.json 保持一致）。 */
export const SEVERITIES = ['high', 'medium', 'low', 'info'];
/** 上下文词表。 */
export const CONTEXTS = ['product', 'comment', 'test', 'bind-or-default', 'endpoint-constant'];
/** 阻断类别词表；`null` 表示该命中不阻断 device-only 运行。 */
export const BLOCKER_CLASSES = ['hard', 'conditional', null];

/**
 * 判定一条命中是否**破坏 device-only 运行**，返回 `'hard'` / `'conditional'` / `null`。
 *
 * 判据（全部满足才可能是阻断）：
 *   1. `migrationSurface === 'target'` —— 参考面（电脑侧宿主）根本不进手机，不阻断。
 *   2. `context === 'product'` —— 注释/测试/`bind-or-default`/`endpoint-constant` 不是产品执行路径。
 *   3. `severity === 'high'` —— 例外（EX-*）与参考面封顶已在此前施加；被降档的就不是阻断。
 * 然后按规则分类：
 *   - `hard`（必须迁移/修复才能装机能跑）：
 *       R1 裸 NUL/控制字符（随源码进包）；R2 回环/私网地址（手机无同级本机服务）；
 *       R3 桌面绝对路径（安卓无该挂载点）；R5 密钥字面量（随 APK 分发）；
 *       R4 `module-import` tier 1（`fs`/`path`/`child_process` 无设备等价，K09 要建 StoragePort）。
 *   - `conditional`（取决于运行时是否提供端口/polyfill）：R4 `global-buffer`（`Buffer` 全局）、
 *       以及（理论上）tier 2 模块——后者正常为 `medium` 已被第 3 条挡住，保留分支只为健壮。
 *   - 其余 `null`。
 *
 * 注意：这是**静态**投影，回答「按现状源码进包会不会坏」；它**不**证明运行时已无 polyfill。
 */
export function classifyDeviceOnly(hit) {
  if (!hit || typeof hit !== 'object') return null;
  if (hit.migrationSurface !== 'target') return null;
  if (hit.context !== 'product') return null;
  if (hit.severity !== 'high') return null;
  switch (hit.rule) {
    case 'R1':
    case 'R2':
    case 'R3':
    case 'R5':
      return 'hard';
    case 'R4':
      if (hit.subtype === 'module-import' && hit.tier === 1) return 'hard';
      return 'conditional';
    default:
      return null;
  }
}

/** 从报告（或任意 `{hits}`）里取出 device-only 阻断投影；优先用命中自带的 `blockerClass`。 */
export function deviceOnlyBlockers(report) {
  const hits = Array.isArray(report?.hits) ? report.hits : [];
  const out = { hard: [], conditional: [] };
  for (const h of hits) {
    const cls = 'blockerClass' in (h ?? {}) ? h.blockerClass : classifyDeviceOnly(h);
    if (cls === 'hard') out.hard.push(h);
    else if (cls === 'conditional') out.conditional.push(h);
  }
  return out;
}

/**
 * 结构校验：报告是否符合 `report.schema.json` 的关键约束 + summary 是否自洽。
 * 依赖零、无副作用，供测试与外部消费者调用；只检查契约，不评价命中内容。
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateReport(report) {
  const errors = [];
  if (report == null || typeof report !== 'object') return { ok: false, errors: ['report 不是对象'] };
  for (const k of ['schemaVersion', 'auditor', 'rules', 'summary', 'hits']) {
    if (!(k in report)) errors.push(`report.${k} 缺失`);
  }
  if (report.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion 非 ${SCHEMA_VERSION}: ${report.schemaVersion}`);
  if (!Array.isArray(report.hits)) errors.push('report.hits 不是数组');
  const ruleIds = new Set(RULES.map((r) => r.id));
  if (Array.isArray(report.hits)) {
    report.hits.forEach((h, i) => {
      const p = `hits[${i}]`;
      for (const k of ['rule', 'path', 'line', 'column', 'severity', 'context']) {
        if (!(h && k in h)) errors.push(`${p}.${k} 缺失`);
      }
      if (h && !ruleIds.has(h.rule)) errors.push(`${p}.rule 非法: ${h.rule}`);
      if (h && !SEVERITIES.includes(h.severity)) errors.push(`${p}.severity 非法: ${h.severity}`);
      if (h && !CONTEXTS.includes(h.context)) errors.push(`${p}.context 非法: ${h.context}`);
      if (h && !(typeof h.line === 'number' && h.line > 0)) errors.push(`${p}.line 非正整数`);
      if (h && !(typeof h.column === 'number' && h.column > 0)) errors.push(`${p}.column 非正整数`);
      if (h && !(typeof h.path === 'string' && h.path.length > 0)) errors.push(`${p}.path 为空`);
      if (h && 'blockerClass' in h && !BLOCKER_CLASSES.includes(h.blockerClass)) {
        errors.push(`${p}.blockerClass 非法: ${h.blockerClass}`);
      }
    });
  }
  if (report.summary && typeof report.summary === 'object' && Array.isArray(report.hits)) {
    for (const r of RULES) {
      const n = report.hits.filter((h) => h.rule === r.id).length;
      if (report.summary.byRule?.[r.id] !== n) {
        errors.push(`summary.byRule.${r.id}=${report.summary.byRule?.[r.id]} 与明细 ${n} 不符`);
      }
    }
    if (report.summary.totalHits !== report.hits.length) errors.push('summary.totalHits 与 hits.length 不符');
  }
  return { ok: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 私密值脱敏：只出形状，绝不出原值
// ─────────────────────────────────────────────────────────────────────────────

/** 输入疑似密钥原文，输出**不含原值**的形状描述。 */
export function redactSecret(value) {
  const len = String(value).length;
  const prefix = String(value).slice(0, 3);
  const looksFixed = /^sk-/.test(value);
  return {
    shape: looksFixed ? 'sk-****' : `${prefix[0] ?? ''}****`,
    length: len,
    charset: /^[0-9a-fA-F]+$/.test(value) ? 'hex' : (/^[A-Za-z0-9+/=_-]+$/.test(value) ? 'base64ish' : 'mixed'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 核心：对一段文本跑全部规则（纯函数 —— 单元测试直接喂内联样例字符串）
// ─────────────────────────────────────────────────────────────────────────────

const MAX_HITS_PER_RULE_PER_FILE_DEFAULT = 200;
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d]); // \t \n \r
const INVISIBLE_UNICODE = new Map([
  [0x200b, 'zero-width-space'],
  [0x200c, 'zero-width-non-joiner'],
  [0x200d, 'zero-width-joiner'],
  [0x2060, 'word-joiner'],
  [0xfeff, 'byte-order-mark'],
]);

const ADDRESS_PATTERNS = [
  { name: 'loopback-ipv4', re: /\b127\.0\.0\.1\b/g },
  { name: 'loopback-hostname', re: /\blocalhost\b/g },
  { name: 'wildcard-bind', re: /\b0\.0\.0\.0\b/g },
  { name: 'loopback-ipv6', re: /\b::1\b/g },
  { name: 'private-192-168', re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'private-10', re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'private-172-16-31', re: /\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g },
];

const WINDOWS_ABS_RE = /(['"`])([A-Za-z]:[\\/])/;
const UNC_RE = /(['"`])(\\\\\?\\)/;
const POSIX_HOME_RE = /(['"`])\/(?:Users|home|root|Applications|Volumes)\//;
const FILE_URL_RE = /(['"`])file:\/\/\//;

// 模块说明符：**必须容忍跨行 import**（`import {\n a,\n} from 'node:fs';` —— 说明符在
// 结尾那一行）。所以首要分支是裸的 `from '…'`，而不是要求 `import` 与 `from` 同行。
// 两个踩过的坑都靠 unit test 钉住：
//   1) `(?:...)` 不参与捕获 ⇒ 引号是**第 1 组**，回引必须写 `\1`（写成 `\2` 会因
//      「组 2 = [^'"]+ 无法自我重复」而**静默零命中**）；
//   2) 只扫单行 `import … from` ⇒ **整条漏掉跨行 import**。
const MODULE_SPECIFIER_RE = /(?:\bfrom\s*|^\s*import\s*|\brequire\(\s*|\bimport\(\s*)(['"])([^'"]+)\1/gm;
const BUFFER_GLOBAL_RE = /(?<![\w.$])Buffer\b(?!\s*:)/g;

const DOTALL_TRIM = (s, n = 160) => String(s).trim().slice(0, n);

/**
 * 对一段源码文本跑全部规则。
 * @param {string} text 源码文本
 * @param {{path?: string, migrationSurface?: 'target'|'reference', maxHitsPerRulePerFile?: number}} [opts]
 * @returns {Array<object>} hits（已挂 rule / path / line / column / severity / context / snippet）
 */
export function scanText(text, opts = {}) {
  const relPath = opts.path ?? '<inline>';
  const migrationSurface = opts.migrationSurface ?? 'target';
  const cap = opts.maxHitsPerRulePerFile ?? MAX_HITS_PER_RULE_PER_FILE_DEFAULT;
  const src = String(text ?? '');
  const lines = src.split(/\n/);
  const hits = [];
  const perRule = new Map();
  const push = (hit) => {
    const n = perRule.get(hit.rule) ?? 0;
    if (n >= cap) return;
    perRule.set(hit.rule, n + 1);
    const finalized = applySurfaceCap(applyExceptions({ path: relPath, migrationSurface, ...hit }));
    // blockerClass 在例外/封顶**之后**算 —— 它衡量的是最终严重度，而不是原始规则档位。
    hits.push({ ...finalized, blockerClass: classifyDeviceOnly(finalized) });
  };
  const lineAt = (ln) => lines[ln - 1] ?? '';

  // ── R1：裸 NUL / 控制字符 / 不可见 Unicode ─────────────────────────────
  {
    let ln = 1;
    let col = 1;
    for (let i = 0; i < src.length; i += 1) {
      const code = src.charCodeAt(i);
      if (code === 0x0a) { ln += 1; col = 1; continue; }
      if (code === 0x0d) { col = 1; continue; }
      if (code < 0x20 && !ALLOWED_CONTROL.has(code)) {
        const ctx = contextOf(lineAt(ln), relPath);
        push({
          rule: 'R1',
          subtype: code === 0 ? 'nul' : 'control-char',
          line: ln,
          column: col,
          text: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
          // 裸 NUL 无条件 high（编码缺陷）；其余 C0 在注释/测试里降一档
          severity: code === 0 ? 'high' : severityFor(ctx, 'high'),
          context: ctx,
          snippet: DOTALL_TRIM(lineAt(ln)),
        });
      } else if (code === 0x7f) {
        const ctx = contextOf(lineAt(ln), relPath);
        push({
          rule: 'R1',
          subtype: 'control-char',
          line: ln,
          column: col,
          text: 'U+007F',
          severity: severityFor(ctx, 'medium'),
          context: ctx,
          snippet: DOTALL_TRIM(lineAt(ln)),
        });
      } else if (INVISIBLE_UNICODE.has(code)) {
        const subtype = code === 0xfeff && i === 0 ? 'bom' : INVISIBLE_UNICODE.get(code);
        const ctx = contextOf(lineAt(ln), relPath);
        push({
          rule: 'R1',
          subtype,
          line: ln,
          column: col,
          text: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
          severity: subtype === 'bom' ? 'info' : severityFor(ctx, 'medium'),
          context: ctx,
          snippet: DOTALL_TRIM(lineAt(ln)),
        });
      }
      col += 1;
    }
  }

  // ── R2 / R3 / R4 / R5：逐行 ────────────────────────────────────────────
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const ln = i + 1;
    const context = contextOf(raw, relPath);

    // R2 硬编码电脑地址
    for (const { name, re } of ADDRESS_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(raw)) !== null) {
        push({
          rule: 'R2',
          subtype: name,
          line: ln,
          column: m.index + 1,
          text: m[0],
          severity: severityFor(context, 'high'),
          context,
          snippet: DOTALL_TRIM(raw),
        });
        if (m[0].length === 0) re.lastIndex += 1;
      }
    }

    // R3 桌面绝对路径
    for (const [subtype, re] of [
      ['windows-drive', WINDOWS_ABS_RE],
      ['windows-unc', UNC_RE],
      ['posix-home', POSIX_HOME_RE],
      ['file-url', FILE_URL_RE],
    ]) {
      const m = re.exec(raw);
      if (m) {
        push({
          rule: 'R3',
          subtype,
          line: ln,
          column: m.index + 1,
          text: m[0],
          severity: severityFor(context, 'high'),
          context,
          snippet: DOTALL_TRIM(raw),
        });
      }
    }

    // R4 Node 桌面专属依赖
    MODULE_SPECIFIER_RE.lastIndex = 0;
    let mm;
    while ((mm = MODULE_SPECIFIER_RE.exec(raw)) !== null) {
      const spec = mm[2];
      const bare = spec.replace(/^node:/, '');
      if (NODE_ONLY_MODULES.has(bare)) {
        const tier = TIER1_MODULES.has(bare) ? 1 : 2;
        push({
          rule: 'R4',
          subtype: 'module-import',
          module: bare,
          tier,
          line: ln,
          column: mm.index + 1,
          text: `import ${bare}`,
          severity: tier === 1 ? 'high' : 'medium',
          context,
          snippet: DOTALL_TRIM(raw),
        });
      }
    }
    BUFFER_GLOBAL_RE.lastIndex = 0;
    let bm;
    while ((bm = BUFFER_GLOBAL_RE.exec(raw)) !== null) {
      const trimmed = raw.trim();
      const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
      push({
        rule: 'R4',
        subtype: 'global-buffer',
        module: 'Buffer',
        tier: 1,
        line: ln,
        column: bm.index + 1,
        text: 'Buffer',
        severity: isComment ? 'info' : 'high',
        context: isComment ? 'comment' : context,
        snippet: DOTALL_TRIM(raw),
      });
    }

    // R5 疑似密钥（**绝不回显原值**）
    const skRe = /\bsk-[A-Za-z0-9_-]{8,}/g;
    let sm;
    while ((sm = skRe.exec(raw)) !== null) {
      const r = redactSecret(sm[0]);
      push({
        rule: 'R5',
        subtype: 'openai-style-key',
        line: ln,
        column: sm.index + 1,
        text: `${r.shape}(len=${r.length})`,
        severity: severityFor(context, 'high'),
        context,
        snippet: DOTALL_TRIM(raw.replace(sm[0], `[REDACTED:${r.shape}]`)),
      });
    }

    const bearerRe = /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g;
    let brm;
    while ((brm = bearerRe.exec(raw)) !== null) {
      const r = redactSecret(brm[1]);
      push({
        rule: 'R5',
        subtype: 'bearer-token',
        line: ln,
        column: brm.index + 1,
        text: `Bearer ****(len=${r.length},${r.charset})`,
        severity: severityFor(context, 'high'),
        context,
        snippet: DOTALL_TRIM(raw.replace(brm[1], '[REDACTED]')),
      });
    }

    // 长 base64/hex 字面量，且同行出现密钥类标识符
    if (SECRET_IDENTIFIER_RE.test(raw)) {
      const longRe = /(['"`])([A-Za-z0-9+/]{32,}={0,2}|[0-9a-fA-F]{32,})\1/g;
      let lm;
      while ((lm = longRe.exec(raw)) !== null) {
        const value = lm[2];
        const isHex = /^[0-9a-fA-F]{32,}$/.test(value);
        if (isHex && !/^[0-9a-fA-F]{40,}$/.test(value)) continue; // 短 hex 常是色值/哈希常量，放过
        const ident = (SECRET_IDENTIFIER_RE.exec(raw) ?? [''])[0];
        push({
          rule: 'R5',
          subtype: isHex ? 'long-hex-literal' : 'long-base64-literal',
          line: ln,
          column: lm.index + 1,
          text: `${isHex ? 'hex' : 'base64ish'}(len=${value.length}) near "${ident}"`,
          severity: severityFor(context, 'high'),
          context,
          snippet: DOTALL_TRIM(raw.replace(value, '[REDACTED]')),
        });
      }
    }
  }

  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 仓库遍历
// ─────────────────────────────────────────────────────────────────────────────

/** 取**最长**匹配前缀的扫描面；无匹配返回 null。 */
export function resolveSurface(relPath, roots = SCOPE.includeRoots) {
  const p = String(relPath).replace(/\\/g, '/');
  let best = null;
  for (const r of roots) {
    if (p === r.prefix || p.startsWith(`${r.prefix}/`)) {
      if (!best || r.prefix.length > best.prefix.length) best = r;
    }
  }
  return best;
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/** 遍历仓库，收集扫描面文件 + 记录各面是否存在 + 跳过的二进制。 */
export function collectScope(rootDir) {
  const files = [];
  const skippedBinary = [];
  const surfaces = [];
  const stats = { testFilesExcluded: [] };
  for (const r of SCOPE.includeRoots) {
    let present = false;
    try {
      present = statSync(join(rootDir, r.prefix)).isDirectory();
    } catch {
      present = false;
    }
    surfaces.push({ ...r, present });
    if (!present) continue;
    walk(join(rootDir, r.prefix), r.prefix, files, skippedBinary, stats);
  }
  // walk 可能因 src 与 src/mobile-plugins 重叠而重复访问同一文件 —— 去重
  const seen = new Set();
  const uniq = [];
  for (const f of files) {
    if (seen.has(f.rel)) continue;
    seen.add(f.rel);
    const s = resolveSurface(f.rel);
    uniq.push({ ...f, surface: s ? s.id : 'unknown', migrationSurface: s ? s.migrationSurface : 'target' });
  }
  uniq.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  stats.testFilesExcluded = [...new Set(stats.testFilesExcluded)].sort();
  const seenBin = new Set();
  const uniqBin = skippedBinary
    .filter((s) => (seenBin.has(s.rel) ? false : (seenBin.add(s.rel), true)))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files: uniq, skippedBinary: uniqBin, surfaces, stats };
}

function walk(absDir, relDir, files, skippedBinary, stats) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SCOPE.excludeDirs.has(e.name)) continue;
      walk(join(absDir, e.name), rel, files, skippedBinary, stats);
      continue;
    }
    if (!e.isFile()) continue;
    if (!SCOPE.codeExts.has(extOf(e.name))) {
      // 非代码扩展名：二进制夹具点名记录（**不**扫正文），其余静默跳过
      if (SCOPE.binaryExts.has(extOf(e.name))) {
        skippedBinary.push({ rel, reason: `binary extension .${extOf(e.name)}（未扫正文）` });
      }
      continue;
    }
    // 口径明确排除 *.test.ts / *.spec.ts —— 只**计数**不扫描（测试文件里的回环地址是
    // 搭建本地 server 的正常做法，扫进来只会把噪音算成产品命中）。
    if (SCOPE.testFileRe.test(e.name)) {
      stats.testFilesExcluded.push(rel);
      continue;
    }
    const abs = join(absDir, e.name);
    let buf;
    try {
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    if (looksBinary(buf)) {
      skippedBinary.push({ rel, reason: 'binary (NUL byte in first 8 KiB)' });
      continue;
    }
    const isTest = SCOPE.testFileRe.test(e.name);
    files.push({ rel, abs, isTest, bytes: buf.length });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 报告组装
// ─────────────────────────────────────────────────────────────────────────────

export function buildReport(rootDir, opts = {}) {
  const cap = opts.maxHitsPerRulePerFile ?? MAX_HITS_PER_RULE_PER_FILE_DEFAULT;
  const { files, skippedBinary, surfaces, stats } = collectScope(rootDir);
  const allHits = [];
  const byFile = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    const hits = scanText(text, {
      path: f.rel,
      migrationSurface: f.migrationSurface,
      maxHitsPerRulePerFile: cap,
    });
    if (hits.length > 0) byFile.push({ path: f.rel, surface: f.surface, hits: hits.length });
    for (const h of hits) allHits.push({ ...h, surface: f.surface, isTestFile: f.isTest });
  }

  const byRule = {};
  const bySeverity = {};
  const bySurface = {};
  const blockers = { hard: 0, conditional: 0 };
  for (const r of RULES) byRule[r.id] = 0;
  for (const h of allHits) {
    byRule[h.rule] = (byRule[h.rule] ?? 0) + 1;
    bySeverity[h.severity] = (bySeverity[h.severity] ?? 0) + 1;
    bySurface[h.surface] = (bySurface[h.surface] ?? 0) + 1;
    if (h.blockerClass === 'hard' || h.blockerClass === 'conditional') blockers[h.blockerClass] += 1;
  }

  // R4 按模块细分
  const r4ByModule = {};
  for (const h of allHits) {
    if (h.rule !== 'R4') continue;
    const key = h.module ?? h.subtype;
    r4ByModule[key] = (r4ByModule[key] ?? 0) + 1;
  }

  const perRuleDetail = RULES.map((r) => {
    const ruleHits = allHits.filter((h) => h.rule === r.id);
    const contexts = {};
    for (const h of ruleHits) contexts[h.context ?? 'n/a'] = (contexts[h.context ?? 'n/a'] ?? 0) + 1;
    const sev = {};
    for (const h of ruleHits) sev[h.severity] = (sev[h.severity] ?? 0) + 1;
    return { id: r.id, title: r.title, why: r.why, source: r.source, count: ruleHits.length, byContext: contexts, bySeverity: sev };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    auditor: AUDITOR_ID,
    generatedAt: new Date().toISOString(),
    gitHead: resolveGitHead(rootDir),
    root: '.',
    scope: {
      includeRoots: SCOPE.includeRoots.map((r) => ({ id: r.id, prefix: r.prefix, migrationSurface: r.migrationSurface, present: surfaces.find((s) => s.id === r.id)?.present ?? false, note: r.note })),
      excludeDirs: [...SCOPE.excludeDirs].sort(),
      excludeFilePatterns: ['*.test.ts', '*.spec.ts', '非代码扩展名', '二进制（正文含 NUL）'],
      filesScanned: files.length,
      filesBySurface: files.reduce((acc, f) => { acc[f.surface] = (acc[f.surface] ?? 0) + 1; return acc; }, {}),
      filesByMigrationSurface: files.reduce((acc, f) => { acc[f.migrationSurface] = (acc[f.migrationSurface] ?? 0) + 1; return acc; }, {}),
      testFilesExcluded: stats.testFilesExcluded.length,
      skippedBinary,
    },
    rules: perRuleDetail,
    summary: {
      totalHits: allHits.length,
      byRule,
      bySeverity,
      bySurface,
      r4ByModule,
      // device-only 阻断投影（详见 classifyDeviceOnly）：hard = 必须迁移/修复；
      // conditional = 取决于运行时是否提供 polyfill/端口（当前主要是 Buffer 全局）。
      blockers,
      maxHitsPerRulePerFile: cap,
    },
    hits: allHits,
    knownExceptions: KNOWN_EXCEPTIONS.map((e) => ({ id: e.id, rule: e.rule, pathRe: String(e.pathRe), reason: e.reason })),
    limitations: readLimitations(),
  };
}

const LIMITATIONS = [
  '启发式上下文判定：contextOf 只看文件路径与所在行文本（不解析 AST），误判可能（例如实测行被误标 product/comment）。',
  'R2 私网正则可能误报版本号/编号（如 "10.1.2.3" 这种四段式版本号），也可能漏报变量拼接出的地址。',
  'R3 只认「引号/反引号紧跟盘符」的字面量；靠变量拼接、或写成分段字符串的路径不会命中。',
  'R4 只认 import/require 的模块说明符与 Buffer 全局标识符；间接依赖（依赖包的依赖）不在此面。',
  'R5 是形状启发式，非熵值判定：短密钥、无 sk- 前缀且长度不足 32 的密钥、或拼接构造的密钥可能漏报；也可能把非密钥的高熵常量误报。',
  '文本按 UTF-8 读取；非 UTF-8 编码文件会被替换字符污染（已通过二进制 NUL 检测剔除大部分）。',
  '只扫仓库内文件，不扫 node_modules、构建产物与远端依赖。',
  'device-only 阻断投影（blockerClass）是**静态**分类：按规则/上下文/最终严重度判定，不证明运行时是否已有 Buffer polyfill 或 StoragePort；conditional 项的最终去留需 K01/K09 的运行时证据。',
  '命中数量随源码演进而变化：baseline-report.json 是**某一提交点的快照**，不是长期门禁。',
];
function readLimitations() { return [...LIMITATIONS]; }

/**
 * 尽力解析 git HEAD（支持普通仓库与 linked worktree：后者 refs 存在 common dir，
 * 需经 `commondir` 文件转一次）；解析不到返回 null —— **不编造**。
 */
export function resolveGitHead(rootDir) {
  try {
    let gitDir = join(rootDir, '.git');
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = resolve(rootDir, m[1].trim());
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head || null;
    const refName = head.slice(5).trim();
    const dirs = [gitDir];
    try {
      const commonRel = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
      if (commonRel) dirs.push(resolve(gitDir, commonRel));
    } catch { /* 非 linked worktree */ }
    const refFile = /[.*+?^${}()|[\]\\]/g;
    for (const d of dirs) {
      try {
        const sha = readFileSync(join(d, refName), 'utf8').trim();
        if (sha) return sha;
      } catch { /* 继续 */ }
      try {
        const esc = refName.replace(refFile, '\\$&');
        const packed = readFileSync(join(d, 'packed-refs'), 'utf8');
        const m = new RegExp(`^${esc}\\s+([0-9a-f]{40})$`, 'm').exec(packed);
        if (m) return m[1];
      } catch { /* 继续 */ }
    }
    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. 人读摘要
// ─────────────────────────────────────────────────────────────────────────────

export function renderHuman(report) {
  const L = [];
  const { scope, summary } = report;
  L.push(`K-R01 手机内核线 · 无电脑依赖静态审计（${report.auditor}）`);
  L.push(`schema v${report.schemaVersion} · gitHead=${report.gitHead ?? '<unknown>'} · generatedAt=${report.generatedAt}`);
  L.push('');
  L.push('扫描面');
  for (const r of scope.includeRoots) {
    const n = scope.filesBySurface[r.id] ?? 0;
    L.push(`  ${r.present ? '[x]' : '[ ]'} ${r.prefix.padEnd(20)} ${String(n).padStart(4)} 文件  (${r.migrationSurface}) ${r.note}`);
  }
  L.push(`  合计 ${scope.filesScanned} 个文件（target=${scope.filesByMigrationSurface.target ?? 0}, reference=${scope.filesByMigrationSurface.reference ?? 0}）`
    + `；按口径排除测试文件 ${scope.testFilesExcluded ?? 0} 个`);
  if (scope.skippedBinary.length > 0) {
    L.push(`  跳过二进制：${scope.skippedBinary.length} 个（${scope.skippedBinary.map((s) => s.rel).join(', ')}）`);
  }
  L.push('');
  L.push('规则命中');
  for (const r of report.rules) {
    const sev = Object.entries(r.bySeverity).map(([k, v]) => `${k}=${v}`).join(' ');
    const ctx = Object.entries(r.byContext).map(([k, v]) => `${k}=${v}`).join(' ');
    L.push(`  ${r.id} ${r.title}`);
    L.push(`      命中 ${String(r.count).padStart(4)}   严重度[${sev || '-'}]   上下文[${ctx || '-'}]`);
  }
  L.push('');
  L.push(`总计命中 ${summary.totalHits}（severity: ${Object.entries(summary.bySeverity).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}）`);
  if (summary.blockers) {
    L.push(`device-only 阻断：hard=${summary.blockers.hard}（必须迁移/修复） · conditional=${summary.blockers.conditional}（取决于运行时 polyfill/端口）`);
  }
  const r4 = Object.entries(summary.r4ByModule).sort((a, b) => b[1] - a[1]);
  if (r4.length) L.push(`R4 按模块：${r4.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  L.push('');
  L.push('命中最多的高严重度文件（前 15）');
  const hot = report.hits.filter((h) => h.severity === 'high').reduce((acc, h) => {
    acc[h.path] = (acc[h.path] ?? 0) + 1;
    return acc;
  }, {});
  const top = Object.entries(hot).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (top.length === 0) L.push('  （无）');
  for (const [p, n] of top) L.push(`  ${String(n).padStart(4)}  ${p}`);
  L.push('');
  L.push('注意：命中不是测试失败。本审计只报告，修复由对应包领；');
  L.push('      基线报告是某一提交点的快照，会随源码演进漂移。');
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { json: false, write: true, root: null, out: null, maxHits: MAX_HITS_PER_RULE_PER_FILE_DEFAULT };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-write') out.write = false;
    else if (a === '--root') { out.root = argv[++i]; }
    else if (a === '--out') { out.out = argv[++i]; }
    else if (a === '--max-hits') { out.maxHits = Number(argv[++i]); }
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
  if (args.help) {
    process.stdout.write('用法见 tests/mobile-kernel/K-R01/README.md\n');
    return 0;
  }
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = args.root ? resolve(args.root) : resolve(scriptDir, '../../..');
  const report = buildReport(repoRoot, { maxHitsPerRulePerFile: args.maxHits });
  const human = renderHuman(report);
  process.stdout.write(`${human}\n`);
  if (args.json) process.stdout.write(`\n--- JSON ---\n${JSON.stringify(report, null, 2)}\n`);
  if (args.write) {
    const outFile = args.out ? resolve(args.out) : join(scriptDir, 'baseline-report.json');
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`\n基线已写入 ${outFile}\n`);
  }
  return 0;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
