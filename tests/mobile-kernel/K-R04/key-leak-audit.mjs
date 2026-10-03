#!/usr/bin/env node
/**
 * K-R04 · 手机内核线「key 泄漏面」审计器（零依赖）
 * =====================================================================
 *
 * 出处
 * ----
 * - K 线 K-R04：「key 泄漏、备份、剪贴板、日志/崩溃诊断审计」。
 * - 总方案 §3「模型和密钥」：密钥不写 Git、APK、assets、BuildConfig、前端存储、任务台账或日志；
 *   Keystore 保存加密密钥，API key 加密后存 App 私有目录，**排除备份**；JS/UI/模型提示词只能拿
 *   keyRef 和状态，不能得到原文。
 * - 总方案 §8：统一证据须「key、地址、手机号等按用途脱敏」。
 *
 * 它做什么
 * --------
 * 对「会进入手机的源码面」做纯静态扫描，把「明文密钥 / 凭据」与四类**泄漏出口（sink）**——
 * 备份、剪贴板、日志、崩溃诊断——交叉起来报：某处 sink 是否可能把密钥带出应用私有边界。
 *
 * 与 K-R01 的分工（不重复）
 * ------------------------
 * - K-R01 是「无电脑静态依赖 / 网络路径 / 私密值」的**通用**扫描（R1–R5），秘钥只是 R5 一条形状规则。
 * - K-R04 专注 K-R04 点名的四个**出口面**，做「出口 × 明文密钥邻近度」的**交叉**判定：
 *   例如「这行日志有没有把 secret 标识符一起打出去」「这个 include 会不会把密钥目录纳入备份」。
 *   它**不做**通用 NUL/地址/Node 依赖扫描——那些归 K-R01。
 *
 * 口径（与 README.md 一致，改动须同时改两边）
 * ----------------------------------------
 * 扫描面：apps/android/** `src/**` apps/mobile-kernel/** apps/mobile-ui/** apps/demo/server/**
 * 排除面：docs/tests/node_modules/.runtime/.claude/build/... 与 *.test.ts|*.spec.ts（只计数）
 *
 * 密钥红线：明文密钥**只报形状与长度，绝不回显原值**（见 redactSecret）。
 *
 * 用法
 * ----
 *   node tests/mobile-kernel/K-R04/key-leak-audit.mjs                # 人读摘要 + 写 baseline-report.json
 *   node tests/mobile-kernel/K-R04/key-leak-audit.mjs --json         # 额外把 JSON 打到 stdout
 *   node tests/mobile-kernel/K-R04/key-leak-audit.mjs --no-write     # 不写基线
 *   node tests/mobile-kernel/K-R04/key-leak-audit.mjs --root <dir>   # 扫别的根（单测用）
 *   node tests/mobile-kernel/K-R04/key-leak-audit.mjs --out <file>   # 指定输出
 *   node tests/mobile-kernel/K-R04/key-leak-audit.mjs --fail-on high # 命中 >= high 时退出码 2（CI 可选门禁）
 *
 * 退出码：0 = 扫描完成（**不论有无命中**）；1 = 扫描本身失败；2 = 仅在 --fail-on 指定时的门禁失败。
 * 注意：默认「命中不是失败」。本包**不**断言仓库零命中（会把现存问题变成测试红）。
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
export const AUDITOR_ID = 'K-R04-key-leak-audit';

// ─────────────────────────────────────────────────────────────────────────────
// 0. 对外契约常量（schema.json 的权威来源；二者必须一致）
// ─────────────────────────────────────────────────────────────────────────────

/** 严重度全序（validateFinding / --fail-on 用）。 */
export const SEVERITY_LEVELS = ['info', 'low', 'medium', 'high', 'critical'];

/** 四个泄漏出口面 + 密钥实体本身。 */
export const SINKS = ['backup', 'clipboard', 'logs', 'crash', 'secret-material'];

/** 每条 finding 必须带的字段（schema.json 的 required 同步）。 */
export const FINDING_FIELDS = [
  'rule', 'sink', 'subtype', 'severity', 'confidence',
  'path', 'line', 'column', 'context', 'snippet', 'evidence', 'fixHint',
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. 扫描口径
// ─────────────────────────────────────────────────────────────────────────────

export const SCOPE = {
  includeRoots: [
    { id: 'kernel', prefix: 'src', migrationSurface: 'target', note: '手机内核迁移目标面' },
    { id: 'demo-server', prefix: 'apps/demo/server', migrationSurface: 'reference', note: '电脑侧宿主（不进手机）' },
    { id: 'mobile-kernel', prefix: 'apps/mobile-kernel', migrationSurface: 'target', note: 'K 线手机内核' },
    { id: 'mobile-ui', prefix: 'apps/mobile-ui', migrationSurface: 'target', note: '前端线手机 UI' },
    { id: 'mobile-plugins', prefix: 'src/mobile-plugins', migrationSurface: 'target', note: '手机插件' },
    { id: 'android-app', prefix: 'apps/android', migrationSurface: 'target', note: '安卓 App 壳（真机侧，备份/剪贴板/崩溃面都在这里）' },
  ],
  excludeDirs: new Set([
    'node_modules', 'docs', 'tests', '.runtime', '.claude', '.git', '.task-manifest',
    '.dev-evidence', 'dist', 'build', 'coverage', '__pycache__', '.pnpm-store', '.gradle',
  ]),
  codeExts: new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'kt', 'xml', 'gradle']),
  /** 二进制夹具：点名不扫。 */
  binaryExts: new Set(['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'zip', 'gz', 'bin', 'ttf', 'otf', 'woff', 'woff2', 'jar', 'so', 'keystore', 'jks']),
  testFileRe: /\.(test|spec)\.[cm]?[jt]sx?$/,
};

/**
 * 明文密钥的**显著特征**（高精度、低召回）。
 * 与 K02 `apps/mobile-kernel/model/redact.ts` 的 `PLAINTEXT_SECRET_PATTERNS` 同形——
 * 单测 `SM1 与 K02 的口径对齐` 会读该文件核对（防止两处口径漂移）。
 */
export const SECRET_PATTERNS = [
  { id: 'sk-key', re: /\bsk-[A-Za-z0-9_-]{10,}/g },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{20,}/g },
  { id: 'api-key-assign', re: /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/gi },
  { id: 'private-key-pem', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/**
 * 「密钥类标识符」——用于判断某行是否**同时**出现敏感变量名（邻近度启发式）。
 * 边界同时认 `\b` 与 camelCase 驼峰边界（`clientSecret`）。
 * 比 K-R01 多一个 `keyRef`（K02/K03 的引用字段名）。
 */
export const SECRET_IDENTIFIER_RE =
  /(?:\b|(?<=[a-z])(?=[A-Z]))(?:api[_-]?key|apikey|access[_-]?key|secret|token|passwd|password|passphrase|credential|authorization|private[_-]?key|keyref|keystore)\b/i;

/** 已知例外：**降级不隐藏**——命中仍在列表里，只是降级并挂 reason。 */
export const KNOWN_EXCEPTIONS = [
  {
    id: 'EX-CB1',
    rule: 'CB1',
    pathRe: /^apps\/android\/.*\.(java|xml)$/,
    reason:
      '安卓壳里出现 `ClipData` 相关标识符多为 **FileProvider / 系统分享**的 URI 权限传播'
      + '（`view.setClipData(ClipData.newRawUri(...))`），不是 `ClipboardManager` 剪贴板写入。'
      + 'CB1 的写入正则已排除 `setClipData`；此例外兜住仍需人工复核的少量变体。',
  },
  {
    id: 'EX-LG1-SHEET',
    rule: 'LG1',
    subtypeRe: /^secret-in-log$/,
    pathRe: /^src\/spreadsheets\/.*\.ts$/,
    severity: 'low',
    reason:
      '表格解析里 `token` 是**单元格引用 token**（`parseCellReference(token)`），不是凭据；'
      + 'LG1 的邻近度启发式把裸标识符 `token` 误当密钥类变量。降级为 low 并保留，'
      + '因为该行本身是遗留的 `console.log(\'DBG …\')` 调试打印，仍值得 X 线确认是否该移除。',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. 规则定义（每条带 why / source / 基础严重度）
// ─────────────────────────────────────────────────────────────────────────────

export const RULES = [
  // ── 备份 ──
  {
    id: 'BK1', sink: 'backup', title: 'allowBackup 未关闭（密钥随系统备份/迁移外流）',
    why: '安卓默认 allowBackup=true；应用私有目录（含加密后的 API key）会被纳入云备份与设备迁移。'
      + 'keystore 的加密密钥在 TEE/StrongBox 里不可备份，备份出的密文到新机**解不开**，'
      + '更要紧的是密文与元数据离开了应用私有边界。',
    source: '总方案 §3「keystore 加密、备份排除」；K-R04', severity: 'high', confidence: 'static',
  },
  {
    id: 'BK2', sink: 'backup', title: 'allowBackup=false 但缺 dataExtractionRules（API 31+ 设备迁移面未声明）',
    why: 'targetSdk>=31 时，`android:dataExtractionRules` 才是备份/设备迁移的权威声明；'
      + '只写 allowBackup=false 时，「设备到设备」迁移路径是否仍带走私有目录需以真机验证为准，'
      + '静态上应显式声明 dataExtractionRules 才能把口径钉死。',
    source: '总方案 §3；Android dataExtractionRules；K-R04', severity: 'medium', confidence: 'static',
  },
  {
    id: 'BK3', sink: 'backup', title: '备份规则 include 了密钥类路径且无 exclude',
    why: '`<full-backup-content>`/`<data-extraction-rules>` 若通过 include 把 keys/secrets/keystore/.private '
      + '等目录纳入备份，就等于把凭据写出私有边界。',
    source: '总方案 §3；K-R04', severity: 'high', confidence: 'static',
  },
  {
    id: 'BK4', sink: 'backup', title: '备份规则宽口径 include（domain 覆盖私有目录根）',
    why: '`<include domain="file" path="."/>`（或 database/sharedpref 根）会把整个私有目录纳入备份，'
      + '其中必然含密钥库与产物；应是「默认排除 + 精确 include」而非「默认全收」。',
    source: '总方案 §3；K-R04', severity: 'high', confidence: 'static',
  },
  // ── 剪贴板 ──
  {
    id: 'CB1', sink: 'clipboard', title: '剪贴板写入',
    why: '写入系统剪贴板的文本可被其他应用读取，且部分输入法/历史面板会持久化。'
      + '产品路径不应把用户可读内容以外的值放上剪贴板。',
    source: 'K-R04「剪贴板审计」', severity: 'medium', confidence: 'static',
  },
  {
    id: 'CB2', sink: 'clipboard', title: '剪贴板写入/读取涉及密钥类值（高危泄漏）',
    why: '把密钥、令牌、授权头写进剪贴板，或从剪贴板读取并当作凭据使用，是最直接的 key 外流路径。'
      + '密钥只应以 keyRef 形式存在，绝不经剪贴板。',
    source: '总方案 §3；K-R04', severity: 'critical', confidence: 'static',
  },
  {
    id: 'CB3', sink: 'clipboard', title: '剪贴板写入未标记敏感（EXTRA_IS_SENSITIVE）',
    why: 'Android 13+ 提供 `ClipDescription.EXTRA_IS_SENSITIVE` 让系统在预览/历史里遮蔽内容。'
      + '写入含敏感内容却不打标，等于放弃系统最后一层保护。',
    source: 'K-R04', severity: 'low', confidence: 'static',
  },
  {
    id: 'CB4', sink: 'clipboard', title: '剪贴板读取',
    why: '读取系统剪贴板可能把用户误复制的密钥/凭据带入模型上下文或日志。'
      + '若读取值随后进入请求或日志，风险叠加。',
    source: 'K-R04', severity: 'medium', confidence: 'static',
  },
  // ── 日志 ──
  {
    id: 'LG1', sink: 'logs', title: '日志调用同行带密钥类标识符（高危泄漏）',
    why: '把 apiKey/secret/token/authorization/keyRef 一类变量直接塞进 `Log.*` / `console.*`，'
      + '密钥就会进入 logcat、崩溃报告或前端控制台，且常被长期留存与上传。',
    source: '总方案 §3「…或日志」；K-R04', severity: 'critical', confidence: 'static',
  },
  {
    id: 'LG2', sink: 'logs', title: '裸流/栈打印（printStackTrace / System.out / dumpStack）',
    why: '`printStackTrace()`、`System.out/err.print*`、`dumpStack()` 会把异常链或对象打到标准错误/logcat；'
      + '若信息里含 URL 查询串、请求头或响应体，凭据可能随之外泄。产品路径应走结构化、脱敏的错误上报。',
    source: '总方案 §3；K-R04', severity: 'medium', confidence: 'static',
  },
  {
    id: 'LG3', sink: 'logs', title: '结构化日志调用（出口面清点）',
    why: '统计性质：记录存在哪些结构化日志出口（Log.*/console.*/NSLog），便于后续判断'
      + '「哪些日志会随崩溃报告上传」。本身不是缺陷，severity=info；若同行出现密钥类标识符则由 LG1 升级。',
    source: 'K-R04', severity: 'info', confidence: 'static',
  },
  // ── 崩溃诊断 ──
  {
    id: 'CR1', sink: 'crash', title: '未捕获异常处理器（崩溃诊断出口清点）',
    why: '自定义 `UncaughtExceptionHandler` 会接管崩溃路径；它是「崩溃时可能把内存里的请求/凭据'
      + '写盘或上传」的出口。存在本身不是缺陷（severity=info），但需确认其落盘内容已脱敏。',
    source: '总方案 §3「崩溃诊断脱敏」；K-R04', severity: 'info', confidence: 'static',
  },
  {
    id: 'CR2', sink: 'crash', title: '崩溃/异常路径同行带密钥类标识符（高危泄漏）',
    why: '在异常构造或崩溃处理器里拼接 apiKey/token/headers 等，会把凭据写进崩溃日志与第三方报告。',
    source: '总方案 §3；K-R04', severity: 'high', confidence: 'static',
  },
  {
    id: 'CR3', sink: 'crash', title: '第三方崩溃上报 SDK（外部外泄面）',
    why: 'Crashlytics/ACRA/Sentry/Bugly 等会把崩溃栈与自定义键上传到第三方。'
      + '引入即需确认上报内容已脱敏、且密钥不进入上报字段。',
    source: '总方案 §3；K-R04', severity: 'medium', confidence: 'static',
  },
  // ── 密钥实体 ──
  {
    id: 'SM1', sink: 'secret-material', title: '明文密钥字面量（形状启发式）',
    why: '密钥以字面量进手机包 = 随 APK 分发，且一旦入库无法回收。密钥应走手机侧密钥存储，'
      + '源码里只允许 keyRef。',
    source: '总方案 §3；CLAUDE.md 规则 0；K-R04', severity: 'critical', confidence: 'static',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 3. 泄漏出口的检测正则
// ─────────────────────────────────────────────────────────────────────────────

// 结构化日志 API（LG3 清点；带密钥标识符则升 LG1）。
const LOG_CALL_RE = /\b(?:Log\.(?:v|d|i|w|e|wtf)|console\.(?:log|info|warn|error|debug|trace)|NSLog\b|__android_log_print)\b/g;
// 裸流/栈打印（LG2；带密钥标识符则升 LG1）。比结构化日志更不可控。
const RAW_PRINT_RE = /\b(?:printStackTrace|dumpStack|System\.(?:out|err)\.print(?:ln|f)?)\b/g;

// 只认真正的**系统剪贴板**写入；刻意**不含** `setClipData`（那是 FileProvider/分享的 URI 传播，非剪贴板）。
const CLIPBOARD_WRITE_RE = /\b(?:setPrimaryClip|navigator\.clipboard\.writeText|ClipboardManager\.(?:set|copy)|copyToClipboard)\b/g;
const CLIPBOARD_READ_RE = /\b(?:getPrimaryClip|navigator\.clipboard\.readText|ClipboardManager\.getPrimaryClip)\b/g;
const SENSITIVE_FLAG_RE = /\bEXTRA_IS_SENSITIVE\b/;

const CRASH_HANDLER_RE = /\b(?:setDefaultUncaughtExceptionHandler|UncaughtExceptionHandler|process\.on\(\s*['"]uncaughtException|window\.addEventListener\(\s*['"]error|onFatalError)\b/g;
const CRASH_SDK_RE = /\b(?:Crashlytics|FirebaseCrashlytics|ACRA|Sentry|Bugsnag|bugsnag|Bugly|Instabug)\b/g;

const MANIFEST_ALLOW_BACKUP_RE = /android:allowBackup\s*=\s*"([^"]*)"/;
const DATA_EXTRACTION_RULES_RE = /android:dataExtractionRules\s*=/;
const FULL_BACKUP_CONTENT_RE = /android:fullBackupContent\s*=/;
const BACKUP_INCLUDE_RE = /<include\b([^>]*)\/?>/g;
const BACKUP_EXCLUDE_RE = /<exclude\b([^>]*)\/?>/g;
const BACKUP_RULES_ROOT_RE = /<(?:full-backup-content|data-extraction-rules)\b/;
const SECRETISH_PATH_RE = /(?:^|\/|\.)(?:keys?|secrets?|tokens?|credentials?|keystore|keyref|\.private)(?:\/|\.|$|")/i;

// ─────────────────────────────────────────────────────────────────────────────
// 4. 上下文 / 严重度
// ─────────────────────────────────────────────────────────────────────────────

export function contextOf(line, relPath) {
  const p = String(relPath || '').toLowerCase().replace(/\\/g, '/');
  if (SCOPE.testFileRe.test(p) || /(^|\/)(__tests__|__fixtures__)\//.test(p) || /harness/.test(p)) return 'test';
  const t = String(line || '').trim();
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')
    || t.startsWith('#') || t.startsWith('<!--') || t.startsWith('--')) return 'comment';
  return 'product';
}

/** 上下文降档：test/comment 一律 info（避免把语料/夹具算成产品泄漏）。 */
export function severityFor(context, base) {
  if (context === 'test' || context === 'comment') return 'info';
  return base;
}

function applySurfaceCap(finding) {
  if (finding.migrationSurface === 'reference' && finding.severity !== 'info' && finding.severity !== 'low') {
    return { ...finding, severity: 'medium', severityNote: 'capped: reference surface' };
  }
  return finding;
}

function applyExceptions(finding) {
  for (const ex of KNOWN_EXCEPTIONS) {
    if (ex.rule !== finding.rule) continue;
    if (!ex.pathRe.test(finding.path)) continue;
    if (ex.subtypeRe && !ex.subtypeRe.test(finding.subtype ?? '')) continue;
    return {
      ...finding,
      severity: ex.severity ?? 'info',
      exceptionId: ex.id,
      exceptionReason: ex.reason,
    };
  }
  return finding;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 脱敏：只出形状，绝不出原值
// ─────────────────────────────────────────────────────────────────────────────

export function redactSecret(value) {
  const s = String(value);
  const len = s.length;
  const prefix = s.slice(0, 3);
  const shape = /^sk-/.test(s) ? 'sk-****'
    : /^Bearer\s/i.test(s) ? 'Bearer ****'
      : /^AIza/.test(s) ? 'AIza****'
        : /^-----BEGIN/.test(s) ? '-----BEGIN **** PRIVATE KEY-----'
          : `${prefix[0] ?? ''}****`;
  const charset = /^[0-9a-fA-F]+$/.test(s) ? 'hex'
    : (/^[A-Za-z0-9+/=_.~-]+$/.test(s) ? 'base64ish' : 'mixed');
  return { shape, length: len, charset };
}

/** 把一行里的所有明文密钥替换成 [REDACTED:<shape>]，任何输出（snippet/evidence/json）都不得含原值。 */
function redactLine(raw) {
  let out = String(raw);
  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => `[REDACTED:${redactSecret(m).shape}]`);
  }
  return out;
}

function secretAdjacent(line) {
  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(line)) return true;
  }
  SECRET_IDENTIFIER_RE.lastIndex = 0;
  return SECRET_IDENTIFIER_RE.test(line);
}

const TRIM = (s, n = 180) => String(s).trim().slice(0, n);

// ─────────────────────────────────────────────────────────────────────────────
// 6. 核心：对一段源码文本跑全部规则（纯函数 —— 单测直接喂内联样例）
// ─────────────────────────────────────────────────────────────────────────────

const MAX_HITS_PER_RULE_PER_FILE_DEFAULT = 200;

/**
 * @param {string} text 源码文本
 * @param {{path?: string, migrationSurface?: 'target'|'reference', maxHitsPerRulePerFile?: number}} [opts]
 * @returns {Array<object>} findings
 */
export function scanText(text, opts = {}) {
  const relPath = opts.path ?? '<inline>';
  const migrationSurface = opts.migrationSurface ?? 'target';
  const cap = opts.maxHitsPerRulePerFile ?? MAX_HITS_PER_RULE_PER_FILE_DEFAULT;
  const src = String(text ?? '');
  const baseName = relPath.replace(/\\/g, '/').split('/').pop() ?? '';
  const isManifest = /^AndroidManifest\.xml$/i.test(baseName);
  const lines = src.split(/\n/);
  const findings = [];
  const perRule = new Map();
  // 敏感标记是**文件级**属性：真实代码常在写入前若干行给 clip.extras 打标，逐行判断会误报。
  const hasSensitiveFlag = SENSITIVE_FLAG_RE.test(src);

  const push = (f) => {
    const n = perRule.get(f.rule) ?? 0;
    if (n >= cap) return;
    perRule.set(f.rule, n + 1);
    findings.push(applySurfaceCap(applyExceptions({
      path: relPath, migrationSurface, confidence: 'static', ...f,
    })));
  };

  // ── 文件级：备份（manifest / backup-rules xml） ────────────────────────────
  if (isManifest) scanManifest(src, relPath, push);
  if (BACKUP_RULES_ROOT_RE.test(src)) scanBackupRules(src, relPath, push, lines);

  // ── 行级：日志 / 剪贴板 / 崩溃 / 密钥 ─────────────────────────────────────
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const ln = i + 1;
    const context = contextOf(raw, relPath);
    const adjacent = secretAdjacent(raw);
    const safe = redactLine(raw);

    // SM1 明文密钥
    for (const { id, re } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(raw)) !== null) {
        const r = redactSecret(m[0]);
        push({
          rule: 'SM1', sink: 'secret-material', subtype: id,
          line: ln, column: m.index + 1,
          severity: severityFor(context, 'critical'), context,
          snippet: TRIM(safe),
          evidence: `${r.shape}(len=${r.length},${r.charset})`,
          fixHint: '改为 keyRef 引用；明文导入走一次性受控通道，不入源码。',
        });
        if (m[0].length === 0) re.lastIndex += 1;
      }
    }

    // LG1 / LG3 日志
    LOG_CALL_RE.lastIndex = 0;
    let lm;
    while ((lm = LOG_CALL_RE.exec(raw)) !== null) {
      if (adjacent) {
        push({
          rule: 'LG1', sink: 'logs', subtype: 'secret-in-log',
          line: ln, column: lm.index + 1,
          severity: severityFor(context, 'critical'), context,
          snippet: TRIM(safe),
          evidence: '该行同时出现日志出口与密钥类标识符',
          fixHint: '日志只打脱敏记录（model/host/usage/failureReason），禁止拼接 key/token/authorization。',
        });
      } else {
        push({
          rule: 'LG3', sink: 'logs', subtype: 'log-call',
          line: ln, column: lm.index + 1,
          severity: 'info', context,
          snippet: TRIM(safe),
          evidence: '日志出口清点',
          fixHint: '确认该日志随崩溃报告上传时已脱敏。',
        });
      }
      if (lm[0].length === 0) LOG_CALL_RE.lastIndex += 1;
    }

    // LG2 裸流/栈打印（带密钥标识符则升 LG1）
    RAW_PRINT_RE.lastIndex = 0;
    let pm;
    while ((pm = RAW_PRINT_RE.exec(raw)) !== null) {
      push({
        rule: adjacent ? 'LG1' : 'LG2', sink: 'logs',
        subtype: adjacent ? 'secret-in-log' : 'print-stack-trace',
        line: ln, column: pm.index + 1,
        severity: severityFor(context, adjacent ? 'critical' : 'medium'), context,
        snippet: TRIM(safe),
        evidence: adjacent ? '裸流/栈打印同行出现密钥类标识符' : '栈/标准流打印出口',
        fixHint: '改结构化错误上报；确认异常信息不含 URL 查询串/请求头/响应体。',
      });
      if (pm[0].length === 0) RAW_PRINT_RE.lastIndex += 1;
    }

    // CB1 / CB2 / CB3 剪贴板写入
    CLIPBOARD_WRITE_RE.lastIndex = 0;
    let cw;
    while ((cw = CLIPBOARD_WRITE_RE.exec(raw)) !== null) {
      if (adjacent) {
        push({
          rule: 'CB2', sink: 'clipboard', subtype: 'clipboard-secret',
          line: ln, column: cw.index + 1,
          severity: severityFor(context, 'critical'), context,
          snippet: TRIM(safe),
          evidence: '剪贴板写入同行出现密钥类标识符',
          fixHint: '密钥绝不进剪贴板；只可复制 keyRef 或非敏感展示文本。',
        });
      } else {
        push({
          rule: 'CB1', sink: 'clipboard', subtype: 'clipboard-write',
          line: ln, column: cw.index + 1,
          severity: severityFor(context, 'medium'), context,
          snippet: TRIM(safe),
          evidence: '剪贴板写入',
          fixHint: '确认写入值非敏感；若含敏感内容加 EXTRA_IS_SENSITIVE 标记。',
        });
      }
      if (!hasSensitiveFlag) {
        push({
          rule: 'CB3', sink: 'clipboard', subtype: 'no-sensitive-flag',
          line: ln, column: cw.index + 1,
          severity: severityFor(context, 'low'), context,
          snippet: TRIM(safe),
          evidence: '全文件未出现 EXTRA_IS_SENSITIVE 标记',
          fixHint: 'Android 13+ 写入敏感内容时设置 ClipDescription.EXTRA_IS_SENSITIVE。',
        });
      }
      if (cw[0].length === 0) CLIPBOARD_WRITE_RE.lastIndex += 1;
    }

    // CB4 剪贴板读取
    CLIPBOARD_READ_RE.lastIndex = 0;
    let cr;
    while ((cr = CLIPBOARD_READ_RE.exec(raw)) !== null) {
      push({
        rule: 'CB4', sink: 'clipboard', subtype: 'clipboard-read',
        line: ln, column: cr.index + 1,
        severity: severityFor(context, adjacent ? 'critical' : 'medium'), context,
        snippet: TRIM(safe),
        evidence: adjacent ? '剪贴板读取同行出现密钥类标识符' : '剪贴板读取',
        fixHint: '确认读取值不会进入请求/日志/模型上下文。',
      });
      if (cr[0].length === 0) CLIPBOARD_READ_RE.lastIndex += 1;
    }

    // CR1 / CR2 / CR3 崩溃诊断
    CRASH_HANDLER_RE.lastIndex = 0;
    let ch;
    while ((ch = CRASH_HANDLER_RE.exec(raw)) !== null) {
      push({
        rule: adjacent ? 'CR2' : 'CR1', sink: 'crash',
        subtype: adjacent ? 'crash-handler-secret' : 'crash-handler',
        line: ln, column: ch.index + 1,
        severity: severityFor(context, adjacent ? 'high' : 'info'), context,
        snippet: TRIM(safe),
        evidence: adjacent ? '崩溃路径同行出现密钥类标识符' : '未捕获异常处理器存在',
        fixHint: '确认崩溃落盘/上报内容已脱敏（无 key/token/headers/请求体）。',
      });
      if (ch[0].length === 0) CRASH_HANDLER_RE.lastIndex += 1;
    }

    CRASH_SDK_RE.lastIndex = 0;
    let cs;
    while ((cs = CRASH_SDK_RE.exec(raw)) !== null) {
      push({
        rule: 'CR3', sink: 'crash', subtype: 'crash-sdk',
        line: ln, column: cs.index + 1,
        severity: severityFor(context, 'medium'), context,
        snippet: TRIM(safe),
        evidence: `第三方崩溃上报 SDK：${cs[0]}`,
        fixHint: '确认上报字段不含密钥；必要时禁用自动收集的 keys。',
      });
      if (cs[0].length === 0) CRASH_SDK_RE.lastIndex += 1;
    }
  }

  return findings;
}

/** manifest 文件级：BK1 / BK2。 */
function scanManifest(src, relPath, push) {
  const m = MANIFEST_ALLOW_BACKUP_RE.exec(src);
  const hasRules = DATA_EXTRACTION_RULES_RE.test(src) || FULL_BACKUP_CONTENT_RE.test(src);
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  if (m === null) {
    push({
      rule: 'BK1', sink: 'backup', subtype: 'allow-backup-default-true',
      line: 1, column: 1, severity: 'high', context: 'product',
      snippet: '<application> 未声明 android:allowBackup',
      evidence: '缺省 allowBackup=true（系统默认）',
      fixHint: '显式设置 android:allowBackup="false" 并声明 dataExtractionRules。',
    });
  } else if (String(m[1]).toLowerCase() !== 'false') {
    push({
      rule: 'BK1', sink: 'backup', subtype: 'allow-backup-true',
      line: lineOf(src.indexOf(m[0])), column: 1, severity: 'high', context: 'product',
      snippet: TRIM(redactLine(m[0])),
      evidence: `allowBackup="${m[1]}"`,
      fixHint: '改为 android:allowBackup="false"。',
    });
  } else if (!hasRules) {
    push({
      rule: 'BK2', sink: 'backup', subtype: 'missing-data-extraction-rules',
      line: lineOf(src.indexOf(m[0])), column: 1, severity: 'medium', context: 'product',
      snippet: TRIM(redactLine(m[0])),
      evidence: 'allowBackup=false 存在，但无 dataExtractionRules / fullBackupContent',
      fixHint: '为 targetSdk>=31 增加 android:dataExtractionRules，显式排除密钥与私有目录。',
    });
  }
}

/** backup-rules xml 文件级：BK3 / BK4。 */
function scanBackupRules(src, relPath, push, lines) {
  const lineOfIdx = (idx) => src.slice(0, idx).split('\n').length;
  const includes = [];
  const excludes = [];
  BACKUP_INCLUDE_RE.lastIndex = 0;
  let m;
  while ((m = BACKUP_INCLUDE_RE.exec(src)) !== null) includes.push({ attrs: m[1], idx: m.index });
  BACKUP_EXCLUDE_RE.lastIndex = 0;
  while ((m = BACKUP_EXCLUDE_RE.exec(src)) !== null) excludes.push({ attrs: m[1], idx: m.index });
  const norm = (p) => String(p).replace(/^\.\//, '').replace(/\/+$/, '');
  const excludePaths = excludes
    .map((e) => (/(?:android:)?path\s*=\s*"([^"]*)"/.exec(e.attrs) || [, ''])[1])
    .map(norm);
  /** include 的 path 是否被任一条 exclude 覆盖（相等 / 前缀 / 或 exclude 是 `.`）。 */
  const coveredByExclude = (p) => {
    const np = norm(p);
    return excludePaths.some((ep) => ep === '.' || np === ep || np.startsWith(`${ep}/`) || ep.startsWith(`${np}/`));
  };

  for (const inc of includes) {
    const attrs = inc.attrs;
    const pathM = /(?:android:)?path\s*=\s*"([^"]*)"/.exec(attrs);
    const domainM = /(?:android:)?domain\s*=\s*"([^"]*)"/.exec(attrs);
    const path = pathM ? pathM[1] : '';
    const domain = domainM ? domainM[1] : '';
    const ln = lineOfIdx(inc.idx);
    if (path === '.' && /^(file|database|sharedpref|root)$/.test(domain)) {
      push({
        rule: 'BK4', sink: 'backup', subtype: 'broad-include',
        line: ln, column: 1, severity: 'high', context: 'product',
        snippet: TRIM(redactLine(lines[ln - 1] ?? attrs)),
        evidence: `include domain="${domain}" path="."`,
        fixHint: '改为「默认排除 + 精确 include」，并在 exclude 里点名密钥目录。',
      });
    }
    if (SECRETISH_PATH_RE.test(path) && !coveredByExclude(path)) {
      push({
        rule: 'BK3', sink: 'backup', subtype: 'secret-path-included',
        line: ln, column: 1, severity: 'high', context: 'product',
        snippet: TRIM(redactLine(lines[ln - 1] ?? attrs)),
        evidence: `include path="${path}" 命中密钥类路径且无对应 exclude`,
        fixHint: '把密钥/凭据目录加入 <exclude>，或从 include 中移除。',
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 契约校验（schema.json 的运行时对应物）
// ─────────────────────────────────────────────────────────────────────────────

/** 校验单条 finding 是否满足 FINDING_FIELDS / 枚举；返回 {ok, errors}。 */
export function validateFinding(f) {
  const errors = [];
  if (typeof f !== 'object' || f === null) return { ok: false, errors: ['finding 不是对象'] };
  for (const k of FINDING_FIELDS) {
    if (!(k in f)) errors.push(`缺字段 ${k}`);
  }
  if (f.rule !== undefined && !RULES.some((r) => r.id === f.rule)) errors.push(`未知 rule ${f.rule}`);
  if (f.sink !== undefined && !SINKS.includes(f.sink)) errors.push(`未知 sink ${f.sink}`);
  if (f.severity !== undefined && !SEVERITY_LEVELS.includes(f.severity)) errors.push(`未知 severity ${f.severity}`);
  if (f.line !== undefined && !(Number.isInteger(f.line) && f.line > 0)) errors.push(`line 非正整数：${f.line}`);
  if (f.column !== undefined && !(Number.isInteger(f.column) && f.column > 0)) errors.push(`column 非正整数：${f.column}`);
  // snippet 里若含**真实**明文密钥形状（不是变量名）却没有 [REDACTED]，说明漏脱敏。
  if (typeof f.snippet === 'string' && !/\[REDACTED/.test(f.snippet)) {
    for (const { re } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(f.snippet)) { errors.push('snippet 含明文密钥且未见 [REDACTED]'); break; }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 校验整份报告的自洽性 + 每条 finding 合规。 */
export function validateReport(report) {
  const errors = [];
  if (report.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion 期望 ${SCHEMA_VERSION}`);
  if (report.auditor !== AUDITOR_ID) errors.push(`auditor 期望 ${AUDITOR_ID}`);
  if (!Array.isArray(report.findings)) errors.push('findings 不是数组');
  else report.findings.forEach((f, i) => {
    const r = validateFinding(f);
    if (!r.ok) errors.push(`findings[${i}] ${f?.rule ?? '?'}: ${r.errors.join('; ')}`);
  });
  if (!Array.isArray(report.rules)) errors.push('rules 不是数组');
  if (report.summary) {
    const sum = RULES.reduce((a, r) => a + (report.summary.byRule?.[r.id] ?? 0), 0);
    if (report.summary.totalFindings !== sum) {
      errors.push(`summary.totalFindings=${report.summary.totalFindings} != ΣbyRule=${sum}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. 仓库遍历
// ─────────────────────────────────────────────────────────────────────────────

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
    const ext = extOf(e.name);
    if (!SCOPE.codeExts.has(ext)) {
      if (SCOPE.binaryExts.has(ext)) skippedBinary.push({ rel, reason: `binary extension .${ext}（未扫正文）` });
      continue;
    }
    if (SCOPE.testFileRe.test(e.name)) {
      stats.testFilesExcluded.push(rel);
      continue;
    }
    let buf;
    try {
      buf = readFileSync(join(absDir, e.name));
    } catch {
      continue;
    }
    if (looksBinary(buf)) {
      skippedBinary.push({ rel, reason: 'binary (NUL byte in first 8 KiB)' });
      continue;
    }
    files.push({ rel, abs: join(absDir, e.name), bytes: buf.length });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. 报告组装
// ─────────────────────────────────────────────────────────────────────────────

export function buildReport(rootDir, opts = {}) {
  const cap = opts.maxHitsPerRulePerFile ?? MAX_HITS_PER_RULE_PER_FILE_DEFAULT;
  const { files, skippedBinary, surfaces, stats } = collectScope(rootDir);
  const findings = [];
  const byFile = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    const hits = scanText(text, {
      path: f.rel, migrationSurface: f.migrationSurface, maxHitsPerRulePerFile: cap,
    });
    if (hits.length > 0) byFile.push({ path: f.rel, surface: f.surface, findings: hits.length });
    for (const h of hits) findings.push({ ...h, surface: f.surface });
  }

  const byRule = {};
  const bySeverity = {};
  const bySurface = {};
  const bySink = {};
  for (const r of RULES) byRule[r.id] = 0;
  for (const s of SINKS) bySink[s] = 0;
  for (const h of findings) {
    byRule[h.rule] = (byRule[h.rule] ?? 0) + 1;
    bySeverity[h.severity] = (bySeverity[h.severity] ?? 0) + 1;
    bySurface[h.surface] = (bySurface[h.surface] ?? 0) + 1;
    bySink[h.sink] = (bySink[h.sink] ?? 0) + 1;
  }

  const perRuleDetail = RULES.map((r) => {
    const rf = findings.filter((h) => h.rule === r.id);
    const sev = {};
    for (const h of rf) sev[h.severity] = (sev[h.severity] ?? 0) + 1;
    return { id: r.id, sink: r.sink, title: r.title, why: r.why, source: r.source, baseSeverity: r.severity, count: rf.length, bySeverity: sev };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    auditor: AUDITOR_ID,
    generatedAt: new Date().toISOString(),
    gitHead: resolveGitHead(rootDir),
    root: '.',
    scope: {
      includeRoots: SCOPE.includeRoots.map((r) => ({
        id: r.id, prefix: r.prefix, migrationSurface: r.migrationSurface, note: r.note,
        present: surfaces.find((s) => s.id === r.id)?.present ?? false,
      })),
      excludeDirs: [...SCOPE.excludeDirs].sort(),
      excludeFilePatterns: ['*.test.ts', '*.spec.ts', '非代码扩展名', '二进制（正文含 NUL）'],
      filesScanned: files.length,
      filesBySurface: files.reduce((a, f) => { a[f.surface] = (a[f.surface] ?? 0) + 1; return a; }, {}),
      filesByMigrationSurface: files.reduce((a, f) => { a[f.migrationSurface] = (a[f.migrationSurface] ?? 0) + 1; return a; }, {}),
      testFilesExcluded: stats.testFilesExcluded.length,
      skippedBinary,
    },
    surfaces: surfaces.map((s) => ({ id: s.id, prefix: s.prefix, present: s.present })),
    rules: perRuleDetail,
    summary: { totalFindings: findings.length, byRule, bySeverity, bySurface, bySink, maxHitsPerRulePerFile: cap },
    byFile,
    findings,
    knownExceptions: KNOWN_EXCEPTIONS.map((e) => ({ id: e.id, rule: e.rule, pathRe: String(e.pathRe), reason: e.reason })),
    limitations: [...LIMITATIONS],
  };
}

const LIMITATIONS = [
  '上下文/邻近度判定是启发式的：只看文件路径与所在行文本（不解析 AST，不做数据流分析）。',
  '「邻近度」= 同一行同时出现出口与密钥类标识符；跨行拼接、变量中转、或经函数参数传递的泄漏会漏报。',
  'SM1 是形状启发式，非熵值判定：短密钥、自造形状、拼接构造的密钥可能漏报；也可能把非密钥的高熵常量误报。',
  'BK1/BK2 只静态读源码 manifest；真正的备份行为（含设备迁移）需在真机验证，本审计不能替代。',
  'CB1 只认系统剪贴板 API；`view.setClipData`（FileProvider/分享的 URI 传播）刻意不认，但也可能漏掉非标准封装。',
  '只扫仓库内文件，不扫 node_modules、构建产物与远端依赖；不检查密钥是否曾在历史提交里出现（需 git 历史工具）。',
  '文本按 UTF-8 读取；非 UTF-8 文件可能被替换字符污染（二进制 NUL 检测已剔除大部分）。',
  'findings 数量随源码演进而变化：baseline-report.json 是某一提交点的快照，不是长期门禁。',
];

/** 尽力解析 git HEAD（支持 linked worktree）；解析不到返回 null——不编造。 */
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
// 10. 人读摘要
// ─────────────────────────────────────────────────────────────────────────────

export function renderHuman(report) {
  const L = [];
  const { scope, summary } = report;
  L.push(`K-R04 手机内核线 · key 泄漏面审计（${report.auditor}）`);
  L.push(`schema v${report.schemaVersion} · gitHead=${report.gitHead ?? '<unknown>'} · generatedAt=${report.generatedAt}`);
  L.push('');
  L.push('扫描面');
  for (const r of scope.includeRoots) {
    const n = scope.filesBySurface[r.id] ?? 0;
    L.push(`  ${r.present ? '[x]' : '[ ]'} ${r.prefix.padEnd(22)} ${String(n).padStart(4)} 文件  (${r.migrationSurface})`);
  }
  L.push(`  合计 ${scope.filesScanned} 个文件（target=${scope.filesByMigrationSurface.target ?? 0}, reference=${scope.filesByMigrationSurface.reference ?? 0}）`);
  L.push('');
  L.push('按出口（sink）');
  for (const s of SINKS) L.push(`  ${s.padEnd(16)} ${String(summary.bySink[s] ?? 0).padStart(4)}`);
  L.push('');
  L.push('按规则');
  for (const r of report.rules) {
    const sev = Object.entries(r.bySeverity).map(([k, v]) => `${k}=${v}`).join(' ');
    L.push(`  ${r.id.padEnd(4)} [${r.sink.padEnd(15)}] ${String(r.count).padStart(4)}  ${r.title}  [${sev || '-'}]`);
  }
  L.push('');
  L.push(`总计 ${summary.totalFindings}（severity: ${Object.entries(summary.bySeverity).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}）`);
  const high = report.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  L.push('');
  L.push(`critical/high 命中 ${high.length} 条：`);
  if (high.length === 0) L.push('  （无）');
  for (const f of high.slice(0, 30)) {
    L.push(`  ${f.severity.padEnd(8)} ${f.rule} ${f.path}:${f.line}  ${f.subtype}`);
  }
  L.push('');
  L.push('注意：命中不是测试失败。本审计只报告，修复由对应包领；');
  L.push('      基线报告是某一提交点的快照，会随源码演进漂移。');
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { json: false, write: true, root: null, out: null, maxHits: MAX_HITS_PER_RULE_PER_FILE_DEFAULT, failOn: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-write') out.write = false;
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--max-hits') out.maxHits = Number(argv[++i]);
    else if (a === '--fail-on') out.failOn = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  if (out.failOn !== null && !SEVERITY_LEVELS.includes(out.failOn)) {
    throw new Error(`--fail-on 需为 ${SEVERITY_LEVELS.join('|')}`);
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
    process.stdout.write('用法见 tests/mobile-kernel/K-R04/README.md\n');
    return 0;
  }
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = args.root ? resolve(args.root) : resolve(scriptDir, '../../..');
  const report = buildReport(repoRoot, { maxHitsPerRulePerFile: args.maxHits });
  const check = validateReport(report);
  if (!check.ok) {
    process.stderr.write(`报告契约校验失败：\n  ${check.errors.join('\n  ')}\n`);
    return 1;
  }
  process.stdout.write(`${renderHuman(report)}\n`);
  if (args.json) process.stdout.write(`\n--- JSON ---\n${JSON.stringify(report, null, 2)}\n`);
  if (args.write) {
    const outFile = args.out ? resolve(args.out) : join(scriptDir, 'baseline-report.json');
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`\n基线已写入 ${outFile}\n`);
  }
  if (args.failOn !== null) {
    const threshold = SEVERITY_LEVELS.indexOf(args.failOn);
    const worst = report.findings.some((f) => SEVERITY_LEVELS.indexOf(f.severity) >= threshold);
    if (worst) {
      process.stderr.write(`门禁失败：存在 severity >= ${args.failOn} 的命中\n`);
      return 2;
    }
  }
  return 0;
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
