/**
 * K06 模板 manifest —— **契约镜像校验器**（零依赖、纯函数）。
 *
 * 本文件是 `contracts/mobile-v1/schemas/template-manifest.schema.json` 的**手写镜像**：
 * 仓库零运行时依赖，不引 JSON-Schema 库，因此把 schema 里真正会咬人的约束逐条落成代码。
 *
 * ## 与 schema 的对应关系（逐条可核对）
 *
 * | schema 约束 | 本文件落点 |
 * | --- | --- |
 * | 根对象 `required` 八字段 | `ROOT_REQUIRED` |
 * | 根对象 `additionalProperties: false` | `ROOT_ALLOWED_KEYS`（拒 `ready` 等合并字段） |
 * | `$defs.id` / `$defs.version` | `checkId` / `MANIFEST_VERSION_PATTERN` |
 * | `capabilities` `minItems: 1` | `checkStringArray(..., {minItems: 1})` |
 * | `permissions.items.$ref` enum | `TEMPLATE_PERMISSIONS` |
 * | `runtimeCompatibility` 四项 + 三个 enum | `checkRuntimeCompatibilityShape` |
 * | `migration` 四项 + strategy enum | `checkMigrationShape` |
 * | `probe` 六项 required + `additionalProperties: false` | `checkProbeShape`（拒 probe 内的合并字段） |
 *
 * ## 为什么"合并就绪态"必须在**这里**就被拒
 *
 * 契约 description 明写：四态分别报告、不得合并成一个布尔，因此根对象
 * `additionalProperties: false` 会**直接拒绝**额外的合并字段（如 `ready`）。
 * 这是契约层面的硬约束，不是风格偏好——本文件把它变成可断言的负例。
 */

import { TemplateError } from './errors.js';
import {
  MANIFEST_VERSION_PATTERN,
  MIGRATION_STRATEGIES,
  TEMPLATE_ABIS,
  TEMPLATE_OS,
  TEMPLATE_PERMISSIONS,
  TEMPLATE_RUNTIMES,
  VERIFICATION_LAYERS,
  VERIFICATION_MODES,
  type HostPlatform,
  type ReadinessReport,
  type ReadinessStateName,
  type RuntimeCompatibility,
  READINESS_STATE_LABELS,
  READINESS_STATE_NAMES,
  type TemplateManifest,
} from './types.js';

// ---------------------------------------------------------------------------
// 校验结果
// ---------------------------------------------------------------------------

export const MANIFEST_ISSUE_CODES = [
  'wrong_type',
  'missing_required',
  'unknown_field',
  'invalid_value',
  'pattern_mismatch',
  'empty_array',
  'out_of_range',
] as const;
export type ManifestIssueCode = (typeof MANIFEST_ISSUE_CODES)[number];

export interface ManifestIssue {
  /** JSON 指针风格的路径，如 `$.probe.ready`。 */
  readonly path: string;
  readonly code: ManifestIssueCode;
  readonly detail: string;
}

export interface ManifestValidation {
  readonly ok: boolean;
  readonly issues: readonly ManifestIssue[];
}

/** 契约根对象的 `required`（顺序照 schema）。 */
export const ROOT_REQUIRED = [
  'id',
  'version',
  'capabilities',
  'schemas',
  'permissions',
  'runtimeCompatibility',
  'migration',
  'probe',
] as const;

/** 契约根对象的全部允许键（`additionalProperties: false`）。 */
export const ROOT_ALLOWED_KEYS = [...ROOT_REQUIRED, 'displayName'] as const;

/** 契约 `probe` 子对象的全部允许键（`additionalProperties: false`）。 */
export const PROBE_ALLOWED_KEYS = [
  'installed',
  'enabled',
  'authorized',
  'portReady',
  'verificationMode',
  'layers',
  'checkedAt',
] as const;

export const RUNTIME_COMPAT_ALLOWED_KEYS = ['os', 'minimumOs', 'runtimes', 'abis'] as const;
export const MIGRATION_ALLOWED_KEYS = ['from', 'to', 'strategy', 'reversible'] as const;

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

class IssueCollector {
  readonly issues: ManifestIssue[] = [];

  push(path: string, code: ManifestIssueCode, detail: string): void {
    this.issues.push({ path, code, detail });
  }

  /** 逐条拒绝 `additionalProperties: false` 下的多余字段。 */
  rejectUnknownFields(target: Record<string, unknown>, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(target)) {
      if (!allowed.includes(key)) {
        this.issues.push({
          path: `${path}.${key}`,
          code: 'unknown_field',
          detail: `不接受字段 ${key}（additionalProperties=false）`,
        });
      }
    }
  }
}

interface StringArrayOptions {
  readonly minItems?: number;
  readonly enumValues?: readonly string[];
  readonly describeEnum?: string;
}

function checkStringArray(
  collector: IssueCollector,
  value: unknown,
  path: string,
  options: StringArrayOptions = {},
): void {
  if (!Array.isArray(value)) {
    collector.push(path, 'wrong_type', `应为数组，实际是 ${describe(value)}`);
    return;
  }
  if (options.minItems !== undefined && value.length < options.minItems) {
    collector.push(path, 'empty_array', `至少需要 ${options.minItems} 项，实际 ${value.length} 项`);
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== 'string') {
      collector.push(itemPath, 'wrong_type', `应为字符串，实际是 ${describe(item)}`);
      return;
    }
    if (item.length === 0) {
      collector.push(itemPath, 'invalid_value', '不得为空串（minLength: 1）');
      return;
    }
    if (options.enumValues !== undefined && !options.enumValues.includes(item)) {
      collector.push(
        itemPath,
        'invalid_value',
        `取值 ${JSON.stringify(item)} 不在 ${options.describeEnum ?? 'enum'} 内：${options.enumValues.join(' / ')}`,
      );
    }
  });
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

// ---------------------------------------------------------------------------
// 各段校验
// ---------------------------------------------------------------------------

function checkRuntimeCompatibilityShape(collector: IssueCollector, value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    collector.push(path, 'wrong_type', `应为对象，实际是 ${describe(value)}`);
    return;
  }
  collector.rejectUnknownFields(value, path, RUNTIME_COMPAT_ALLOWED_KEYS);

  for (const key of RUNTIME_COMPAT_ALLOWED_KEYS) {
    if (!(key in value)) {
      collector.push(`${path}.${key}`, 'missing_required', `runtimeCompatibility 缺少必需字段 ${key}`);
    }
  }

  if ('os' in value && value['os'] !== TEMPLATE_OS) {
    collector.push(`${path}.os`, 'invalid_value', `os 必须是常量 "${TEMPLATE_OS}"`);
  }
  if ('minimumOs' in value) {
    const minimumOs = value['minimumOs'];
    if (!isInteger(minimumOs)) {
      collector.push(`${path}.minimumOs`, 'wrong_type', `应为整数，实际是 ${describe(minimumOs)}`);
    } else if (minimumOs < 1) {
      collector.push(`${path}.minimumOs`, 'out_of_range', `minimumOs 必须 ≥ 1，实际 ${minimumOs}`);
    }
  }
  if ('runtimes' in value) {
    checkStringArray(collector, value['runtimes'], `${path}.runtimes`, {
      minItems: 1,
      enumValues: TEMPLATE_RUNTIMES,
      describeEnum: 'runtimes enum',
    });
  }
  if ('abis' in value) {
    checkStringArray(collector, value['abis'], `${path}.abis`, {
      minItems: 1,
      enumValues: TEMPLATE_ABIS,
      describeEnum: 'abis enum',
    });
  }
}

function checkMigrationShape(collector: IssueCollector, value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    collector.push(path, 'wrong_type', `应为对象，实际是 ${describe(value)}`);
    return;
  }
  collector.rejectUnknownFields(value, path, MIGRATION_ALLOWED_KEYS);

  for (const key of MIGRATION_ALLOWED_KEYS) {
    if (!(key in value)) {
      collector.push(`${path}.${key}`, 'missing_required', `migration 缺少必需字段 ${key}`);
    }
  }
  for (const key of ['from', 'to'] as const) {
    if (key in value && typeof value[key] !== 'string') {
      collector.push(`${path}.${key}`, 'wrong_type', `应为字符串，实际是 ${describe(value[key])}`);
    }
  }
  if ('strategy' in value && !(MIGRATION_STRATEGIES as readonly string[]).includes(String(value['strategy']))) {
    collector.push(
      `${path}.strategy`,
      'invalid_value',
      `strategy 取值 ${JSON.stringify(value['strategy'])} 不在枚举内：${MIGRATION_STRATEGIES.join(' / ')}`,
    );
  }
  if ('reversible' in value && typeof value['reversible'] !== 'boolean') {
    collector.push(`${path}.reversible`, 'wrong_type', `应为布尔，实际是 ${describe(value['reversible'])}`);
  }
}

function checkProbeShape(collector: IssueCollector, value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    collector.push(path, 'wrong_type', `应为对象，实际是 ${describe(value)}`);
    return;
  }
  // 关键：probe 也是 additionalProperties=false —— 想把四态合并成 `ready` 会在这里被拒。
  collector.rejectUnknownFields(value, path, PROBE_ALLOWED_KEYS);

  for (const key of ['installed', 'enabled', 'authorized', 'portReady'] as const) {
    if (!(key in value)) {
      collector.push(`${path}.${key}`, 'missing_required', `probe 缺少必需状态字段 ${key}（四态必须分别上报）`);
      continue;
    }
    if (typeof value[key] !== 'boolean') {
      collector.push(
        `${path}.${key}`,
        'wrong_type',
        `应为布尔（该态独立上报），实际是 ${describe(value[key])}`,
      );
    }
  }
  if (!('verificationMode' in value)) {
    collector.push(`${path}.verificationMode`, 'missing_required', 'probe 缺少必需字段 verificationMode');
  } else if (!(VERIFICATION_MODES as readonly string[]).includes(String(value['verificationMode']))) {
    collector.push(
      `${path}.verificationMode`,
      'invalid_value',
      `verificationMode 取值 ${JSON.stringify(value['verificationMode'])} 不在枚举内：${VERIFICATION_MODES.join(' / ')}`,
    );
  }
  if (!('layers' in value)) {
    collector.push(`${path}.layers`, 'missing_required', 'probe 缺少必需字段 layers');
  } else {
    checkStringArray(collector, value['layers'], `${path}.layers`, {
      minItems: 1,
      enumValues: VERIFICATION_LAYERS,
      describeEnum: 'verificationLayer enum',
    });
  }
  if ('checkedAt' in value && !isNonEmptyString(value['checkedAt'])) {
    collector.push(`${path}.checkedAt`, 'invalid_value', 'checkedAt 若存在必须是非空字符串（minLength: 1）');
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 逐条校验一个 manifest 候选，收集**全部**问题（不早退——一次报全，便于修）。 */
export function validateManifest(input: unknown): ManifestValidation {
  const collector = new IssueCollector();

  if (!isPlainObject(input)) {
    collector.push('$', 'wrong_type', `manifest 必须是对象，实际是 ${describe(input)}`);
    return { ok: false, issues: collector.issues };
  }

  collector.rejectUnknownFields(input, '$', ROOT_ALLOWED_KEYS);

  for (const key of ROOT_REQUIRED) {
    if (!(key in input)) {
      collector.push(`$.${key}`, 'missing_required', `根对象缺少必需字段 ${key}`);
    }
  }

  if ('id' in input) {
    const id = input['id'];
    if (typeof id !== 'string') {
      collector.push('$.id', 'wrong_type', `应为字符串，实际是 ${describe(id)}`);
    } else if (id.length < 1 || id.length > 128) {
      collector.push('$.id', 'out_of_range', `id 长度必须落在 1..128，实际 ${id.length}`);
    }
  }
  if ('displayName' in input && !isNonEmptyString(input['displayName'])) {
    collector.push('$.displayName', 'invalid_value', 'displayName 若存在必须是非空字符串（minLength: 1）');
  }
  if ('version' in input) {
    const version = input['version'];
    if (typeof version !== 'string') {
      collector.push('$.version', 'wrong_type', `应为字符串，实际是 ${describe(version)}`);
    } else if (!MANIFEST_VERSION_PATTERN.test(version)) {
      collector.push('$.version', 'pattern_mismatch', `version 必须匹配 ^\\d+\\.\\d+\\.\\d+$，实际 ${JSON.stringify(version)}`);
    }
  }
  if ('capabilities' in input) {
    checkStringArray(collector, input['capabilities'], '$.capabilities', { minItems: 1 });
  }
  if ('schemas' in input) {
    checkStringArray(collector, input['schemas'], '$.schemas');
  }
  if ('permissions' in input) {
    checkStringArray(collector, input['permissions'], '$.permissions', {
      enumValues: TEMPLATE_PERMISSIONS,
      describeEnum: 'permission enum',
    });
  }
  if ('runtimeCompatibility' in input) {
    checkRuntimeCompatibilityShape(collector, input['runtimeCompatibility'], '$.runtimeCompatibility');
  }
  if ('migration' in input) {
    checkMigrationShape(collector, input['migration'], '$.migration');
  }
  if ('probe' in input) {
    checkProbeShape(collector, input['probe'], '$.probe');
  }

  return { ok: collector.issues.length === 0, issues: collector.issues };
}

/**
 * 校验并**收窄类型**；不合法时抛 `manifest_invalid`（消息里带上前若干条问题）。
 */
export function assertManifest(input: unknown): TemplateManifest {
  const result = validateManifest(input);
  if (!result.ok) {
    const head = result.issues
      .slice(0, 6)
      .map((issue) => `${issue.path} ${issue.code}: ${issue.detail}`)
      .join(' | ');
    const more = result.issues.length > 6 ? `（另有 ${result.issues.length - 6} 条）` : '';
    throw new TemplateError('manifest_invalid', `manifest 校验失败 ${result.issues.length} 条：${head}${more}`);
  }
  return input as TemplateManifest;
}

// ---------------------------------------------------------------------------
// 运行时兼容（manifest.runtimeCompatibility  vs  宿主 HostPlatform）
// ---------------------------------------------------------------------------

export interface CompatibilityIssue {
  readonly field: 'os' | 'minimumOs' | 'runtimes' | 'abis';
  readonly detail: string;
}

/** 逐项比对运行时兼容；返回**全部**不符项（空数组 = 兼容）。 */
export function checkRuntimeCompatibility(
  compat: RuntimeCompatibility,
  host: HostPlatform,
): readonly CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (compat.os !== host.os) {
    issues.push({ field: 'os', detail: `manifest os=${compat.os}，宿主 os=${host.os}` });
  }
  if (host.apiLevel < compat.minimumOs) {
    issues.push({
      field: 'minimumOs',
      detail: `manifest minimumOs=${compat.minimumOs}，宿主 apiLevel=${host.apiLevel}（低于要求）`,
    });
  }
  const supportedRuntimes = compat.runtimes.filter((runtime) => host.runtimes.includes(runtime));
  if (supportedRuntimes.length === 0) {
    issues.push({
      field: 'runtimes',
      detail: `manifest runtimes=[${compat.runtimes.join(', ')}] 与宿主 runtimes=[${host.runtimes.join(', ')}] 无交集`,
    });
  }
  const supportedAbis = compat.abis.filter((abi) => host.abis.includes(abi));
  if (supportedAbis.length === 0) {
    issues.push({
      field: 'abis',
      detail: `manifest abis=[${compat.abis.join(', ')}] 与宿主 abis=[${host.abis.join(', ')}] 无交集`,
    });
  }
  return issues;
}

/** 不兼容即抛 `runtime_incompatible`（带 `field`）。 */
export function assertRuntimeCompatible(compat: RuntimeCompatibility, host: HostPlatform): void {
  const issues = checkRuntimeCompatibility(compat, host);
  const first = issues[0];
  if (first !== undefined) {
    const detail = issues.map((issue) => `[${issue.field}] ${issue.detail}`).join('; ');
    throw new TemplateError('runtime_incompatible', detail, first.field);
  }
}

// ---------------------------------------------------------------------------
// 就绪报告的形状不变量：**禁止合并成单布尔**
// ---------------------------------------------------------------------------

/** 就绪报告允许出现的键（四态 + 身份 + 版本）。任何额外键都视为"试图合并"。 */
export const READINESS_REPORT_ALLOWED_KEYS = ['id', 'version', ...READINESS_STATE_NAMES] as const;

/**
 * 运行期拦"把四态压成单布尔"。
 *
 * 两种退化都会被拒：
 *  - 报告上多出 `ready` 之类的汇总字段（`additionalProperties` 语义）；
 *  - 某个态不是状态对象而是裸布尔（如 `installed: true`）——那正是"合并"的第一步。
 */
export function assertSeparateReadinessStates(report: unknown): asserts report is ReadinessReport {
  if (!isPlainObject(report)) {
    throw new TemplateError('merged_readiness_forbidden', `就绪报告必须是对象，实际是 ${describe(report)}`);
  }
  for (const key of Object.keys(report)) {
    if (!(READINESS_REPORT_ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new TemplateError(
        'merged_readiness_forbidden',
        `就绪报告不接受字段 ${key}：四态（installed/enabled/authorized/portReady）必须分别上报，不得合并`,
      );
    }
  }
  for (const name of READINESS_STATE_NAMES) {
    const state = (report as Record<ReadinessStateName, unknown>)[name];
    if (typeof state === 'boolean') {
      throw new TemplateError(
        'merged_readiness_forbidden',
        `就绪态 ${name} 是裸布尔：必须给出 {state: 'ready'|'not-ready', reason} 的独立报告`,
      );
    }
    if (!isPlainObject(state)) {
      throw new TemplateError('merged_readiness_forbidden', `就绪态 ${name} 缺失或形状不对`);
    }
    const verdict = state['state'];
    if (verdict !== 'ready' && verdict !== 'not-ready') {
      throw new TemplateError('merged_readiness_forbidden', `就绪态 ${name} 的 state 必须是 ready / not-ready`);
    }
    // ready 时不得带原因，not-ready 时**必须**给原因——否则原因会被悄悄丢掉。
    if (verdict === 'ready' && state['reason'] !== null) {
      throw new TemplateError('merged_readiness_forbidden', `就绪态 ${name} 为 ready 时 reason 必须为 null`);
    }
    if (verdict === 'not-ready' && !isNonEmptyString(state['reason'])) {
      throw new TemplateError('merged_readiness_forbidden', `就绪态 ${name} 为 not-ready 时必须给出非空原因`);
    }
  }
}

/** 供上层做可读摘要（**不是**判定，也不产生汇总布尔）。 */
export function describeReadiness(report: ReadinessReport): string {
  return READINESS_STATE_NAMES.map((name) => {
    const state = report[name];
    const label = READINESS_STATE_LABELS[name];
    return state.state === 'ready' ? `${label}:就绪` : `${label}:未就绪(${state.reason})`;
  }).join(' / ');
}
