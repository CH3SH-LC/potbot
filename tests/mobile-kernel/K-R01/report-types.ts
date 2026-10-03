/**
 * K-R01 · 审计报告的 TypeScript 类型契约（schemaVersion 1）
 * =========================================================
 *
 * 与 `audit.mjs` 的 `buildReport()` 输出、`report.schema.json` 三者互为镜像。
 * 放在 `tests/**` 下 ⇒ 被 `tsconfig.json`（include: ["src","tests"]）静态检查，
 * 消费方（六线其它包）可 `import type` 直接拿到报告/命中形状，无需读 .mjs。
 *
 * 注意：`audit.mjs` 是零依赖 .mjs，本文件**不** import 它（避免 NodeNext 的 .mjs 声明解析问题）。
 * 运行时一致性由 `device-only-blockers.test.ts` 用真实构建的报告断言。
 */

/** 五条规则的 id。 */
export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

/** 严重度。 */
export type Severity = 'high' | 'medium' | 'low' | 'info';

/** 命中所在上下文（启发式判定）。 */
export type HitContext = 'product' | 'comment' | 'test' | 'bind-or-default' | 'endpoint-constant';

/** 迁移面：target = 要进手机；reference = 电脑侧宿主（不进手机）。 */
export type MigrationSurface = 'target' | 'reference';

/** device-only 阻断类别。 */
export type BlockerClass = 'hard' | 'conditional';

/** 单条命中：`file:line:column` + 判定结果。 */
export interface AuditFinding {
  rule: RuleId;
  subtype?: string;
  /** 仓库相对路径（正斜杠）。 */
  path: string;
  surface?: string;
  migrationSurface?: MigrationSurface;
  isTestFile?: boolean;
  /** 1 起始行号。 */
  line: number;
  /** 1 起始列号。 */
  column: number;
  severity: Severity;
  context: HitContext;
  /** R4 命中的模块名（如 `fs` / `Buffer`）。 */
  module?: string;
  /** R4 模块层级：1 = 任务书点名，2 = 同类观察项。 */
  tier?: 1 | 2;
  /** 已脱敏的判定文本（密钥只出形状，绝不出原值）。 */
  text?: string;
  snippet?: string;
  severityNote?: string;
  exceptionId?: string;
  exceptionReason?: string;
  /** 该命中是否阻断 device-only 运行；`null` = 不阻断。 */
  blockerClass: BlockerClass | null;
}

/** 一个扫描面的元信息。 */
export interface ScopeRoot {
  id: string;
  prefix: string;
  migrationSurface: MigrationSurface;
  present: boolean;
  note?: string;
}

/** 报告里的规则汇总。 */
export interface RuleSummary {
  id: RuleId;
  title: string;
  why: string;
  source: string;
  count: number;
  byContext?: Record<string, number>;
  bySeverity?: Record<string, number>;
}

/** 报告汇总区。 */
export interface AuditSummary {
  totalHits: number;
  byRule: Record<string, number>;
  bySeverity?: Record<string, number>;
  bySurface?: Record<string, number>;
  r4ByModule?: Record<string, number>;
  /** device-only 阻断投影计数（`hits[].blockerClass` 的聚合）。 */
  blockers: { hard: number; conditional: number };
  maxHitsPerRulePerFile?: number;
}

/** 扫描面元数据。 */
export interface AuditScope {
  includeRoots: ScopeRoot[];
  excludeDirs?: string[];
  excludeFilePatterns?: string[];
  filesScanned: number;
  filesBySurface?: Record<string, number>;
  filesByMigrationSurface?: Record<string, number>;
  testFilesExcluded?: number;
  skippedBinary?: { rel: string; reason: string }[];
}

/** 已知例外：降级不隐藏。 */
export interface KnownException {
  id: string;
  rule: RuleId;
  /** 序列化后的正则源码（`String(RegExp)`）。 */
  pathRe: string;
  reason: string;
}

/** 完整审计报告。 */
export interface AuditReport {
  schemaVersion: 1;
  auditor: 'K-R01-desktop-dependency-audit';
  generatedAt?: string;
  gitHead?: string | null;
  root?: string;
  scope?: AuditScope;
  rules: RuleSummary[];
  summary: AuditSummary;
  hits: AuditFinding[];
  knownExceptions?: KnownException[];
  limitations?: string[];
}

/**
 * 运行时最小形状守卫：确认对象是**可能**的报告（有 hits 数组）。
 * 完整契约校验请用 `audit.mjs` 的 `validateReport()`（本文件只提供类型）。
 */
export function isAuditReportLike(value: unknown): value is { hits: AuditFinding[] } {
  return (
    typeof value === 'object'
    && value !== null
    && Array.isArray((value as { hits?: unknown }).hits)
  );
}
