/**
 * F08 templates —— 内核适配层（F-I14）：把 F08 的 `recordProbe` 与 **K06 模板探针事件流**接上，
 * 并为 **KernelClient** 提供薄的模板命令构造器（install / enable / authorize / update /
 * uninstall，外加一次 readiness 探针）。
 *
 * ## 本文件做什么
 *
 * 1. **探针事件 → `recordProbe`**：K06 `TemplateLifecycle.reportReadiness()` 产出**四态分别报告**的
 *    `ReadinessReport`；K-I04 宿主模块（`apps/mobile-kernel/host/templates-module.ts`）把它经
 *    `export` 命令的终局事件回成 resultRef 字符串。本层把两者都投影到 F08 的 `ProbeInput`
 *    并落到 `recordProbe`——**只写探针管辖的维度**（`portReady` / `portReason` /
 *    `unsupportedCapabilities` / `runtimeCompatible` / `checkedAt`）。
 * 2. **v1 命令构造**：把五个模板操作翻成 K-I04 宿主约定的 v1 `Command`（`redo`/`export`
 *    + `args.op`），供 F 线协调者单写的 `KernelClient` 投递。本层**只构造、不投递、不订阅**——
 *    真实发送与事件回执仍属未验证。
 *
 * ## 为什么不 import K06 内核（只做结构化同形）
 *
 * 与 `apps/mobile-ui/src/platform/types.ts` 对 K07 账本的取舍一致：F08 源码保持**零依赖**，
 * 用结构化最小约束（{@link KernelReadinessReport}）描述 K06 的读回形状，真机上 K06 的
 * `ReadinessReport` **原样可赋值**（由 `tests/mobile-ui/F08/kernel-adapter.test.ts` 用**真实**
 * K06 模块跑一遍证明，不是自说自话）。这样 K06 的编译错误不会穿透 F08 的独立类型检查。
 *
 * ## 关键不变量（逐条由测试机器化断言）
 *
 *   A1 **四态不合并**：{@link readinessVerdicts} 返回**四个独立布尔**，本层**不提供**任何
 *      「整体就绪」结论；K06 报告缺任一态或出现合并字段时，{@link assertFourStatesReported} 抛错。
 *   A2 **只信内核读回**：`portReady` 一律取自 K06 报告，前端不自行推断端口是否就绪。
 *   A3 **reason 忠实**：`not-ready` 的原因原样透传（不美化）；`ready` 恒为 null。
 *   A4 **id 空间桥接**：K06 mobile-v1 模板 id（`meituan`）与 F08 id（`template.meituan`）互转，
 *      未知 id 抛 `unknown-template`，不静默降级。
 *   A5 **命令取自本地视图 revision**：`expectedRevision` 由 F08 生命周期 `revision` 派生，
 *      不允许调用方自带（与 F03 / F07 同口径）。
 *   A6 **事件流 fail-closed**：resultRef 缺四态之一 / 取值非法即抛错，绝不把残缺事件当成就绪。
 */

import type { Command } from '../../../../contracts/mobile-v1/types.js';
import type {
  TemplateId,
  TemplatePermission,
  TemplateReadiness,
  TemplatesState,
} from './types.js';
import { TemplateError } from './types.js';
import { PERMISSION_ORDER, isTemplateId } from './catalog.js';
import { getTemplate, recordProbe, type ProbeInput } from './lifecycle.js';

// ---------------------------------------------------------------------------
// K06 读回报告的结构化同形（不 import 内核，保持源码零依赖）
// ---------------------------------------------------------------------------

/** K06 `StateReport` 的结构化最小约束（与 `apps/mobile-kernel/templates/types.ts` 同形）。 */
export interface KernelStateReport {
  readonly state: 'ready' | 'not-ready';
  /** `not-ready` 时的可机读原因；`ready` 时为 null。 */
  readonly reason: string | null;
  readonly evidenceRef?: string | null;
  /** 探针读取时刻（epoch ms）。 */
  readonly checkedAt?: number;
}

/**
 * K06 `ReadinessReport` 的结构化最小约束：四态**分别**报告。
 * 刻意**没有** `ready` 这类汇总字段——出现即由 {@link assertFourStatesReported} 拒绝。
 */
export interface KernelReadinessReport {
  readonly id: string;
  readonly version?: string;
  readonly installed: KernelStateReport;
  readonly enabled: KernelStateReport;
  readonly authorized: KernelStateReport;
  readonly portReady: KernelStateReport;
}

const FOUR_STATE_NAMES = ['installed', 'enabled', 'authorized', 'portReady'] as const;
type FourStateName = (typeof FOUR_STATE_NAMES)[number];

const READINESS_ALLOWED_KEYS: ReadonlySet<string> = new Set(['state', 'reason', 'evidenceRef', 'checkedAt']);

/** K06 报告里用于承载「能力缺失 / 运行时不可用」的可机读原因前缀（见内核 `lifecycle.ts`）。 */
const CAPABILITY_TOKEN = 'capability_unavailable:';
const RUNTIME_TOKEN = 'runtime_incompatible:';

// ---------------------------------------------------------------------------
// A4：id 空间桥接（内核 mobile-v1 id `meituan` ⇄ F08 id `template.meituan`）
// ---------------------------------------------------------------------------

const F08_ID_PREFIX = 'template.';

/**
 * K06 内核 mobile-v1 模板 id → F08 id。已带 `template.` 前缀则原样返回。
 * 未知 id 抛 `unknown-template`（不静默返回原串让后续比对失真）。
 */
export function toF08TemplateId(kernelId: string): TemplateId {
  const prefixed = kernelId.startsWith(F08_ID_PREFIX) ? kernelId : `${F08_ID_PREFIX}${kernelId}`;
  if (!isTemplateId(prefixed)) {
    throw new TemplateError('unknown-template', `未知模板 id（无法桥接到 F08 id）：${kernelId}`, {
      kernelId,
    });
  }
  return prefixed;
}

/** F08 id → K06 内核 mobile-v1 id（去掉 `template.` 前缀）。 */
export function toKernelTemplateId(f08Id: string): string {
  return f08Id.startsWith(F08_ID_PREFIX) ? f08Id.slice(F08_ID_PREFIX.length) : f08Id;
}

// ---------------------------------------------------------------------------
// A1：四态不合并的守卫与投影
// ---------------------------------------------------------------------------

/**
 * 报告必须是**四态分别**的结构；任一态缺失、类型不符，或出现非契约键（如 `ready`），
 * 立即抛 `invalid-transition`。契约 `template-manifest.schema.json` 的
 * `additionalProperties: false` 会再兜一层；这里让适配期直接抛错，定位更快。
 */
export function assertFourStatesReported(report: KernelReadinessReport): void {
  // 参数类型是结构化约束，但运行期仍可能收到残缺对象（跨线数据），先按 unknown 收窄。
  const candidate: unknown = report;
  if (candidate === null || typeof candidate !== 'object') {
    throw new TemplateError('invalid-transition', 'K06 读回报告必须是对象', {});
  }
  const typed = candidate as KernelReadinessReport;
  if (typeof typed.id !== 'string' || typed.id.length === 0) {
    throw new TemplateError('invalid-transition', 'K06 读回报告缺 id', {});
  }
  const extra = Object.keys(typed).filter(
    (key) => !['id', 'version', ...FOUR_STATE_NAMES].includes(key),
  );
  if (extra.length > 0) {
    throw new TemplateError('invalid-transition', `K06 报告含非契约字段（可能是合并就绪态）：${extra.join('、')}`, {
      extra,
    });
  }
  for (const name of FOUR_STATE_NAMES) {
    const stateReport = typed[name];
    if (stateReport === null || typeof stateReport !== 'object') {
      throw new TemplateError('invalid-transition', `K06 报告缺状态 ${name}`, { field: name });
    }
    const reportKeys = Object.keys(stateReport);
    const strayKeys = reportKeys.filter((key) => !READINESS_ALLOWED_KEYS.has(key));
    if (strayKeys.length > 0) {
      throw new TemplateError('invalid-transition', `${name} 报告含非契约字段：${strayKeys.join('、')}`, {
        field: name,
        strayKeys,
      });
    }
    if (stateReport.state !== 'ready' && stateReport.state !== 'not-ready') {
      throw new TemplateError('invalid-transition', `${name}.state 必须是 ready / not-ready`, {
        field: name,
        state: String(stateReport.state),
      });
    }
  }
}

/** 四态判定投影为**四个独立布尔**（与 F08 `TemplateReadiness` 同形，不合并）。 */
export function readinessVerdicts(report: KernelReadinessReport): TemplateReadiness {
  assertFourStatesReported(report);
  const verdict = (name: FourStateName): boolean => report[name].state === 'ready';
  return {
    installed: verdict('installed'),
    enabled: verdict('enabled'),
    authorized: verdict('authorized'),
    portReady: verdict('portReady'),
  };
}

// ---------------------------------------------------------------------------
// A2/A3：K06 报告 → F08 `ProbeInput`
// ---------------------------------------------------------------------------

/** 从 `; ` 分隔的原因里取出某前缀段。 */
function segmentsWith(reason: string | null, token: string): readonly string[] {
  if (reason === null || reason === '') return [];
  return reason
    .split('; ')
    .filter((segment) => segment.startsWith(token))
    .map((segment) => segment.slice(token.length));
}

/** 取某前缀段里的逗号分隔项（去空白、丢空串）。 */
function itemsWith(reason: string | null, token: string): readonly string[] {
  return segmentsWith(reason, token)
    .flatMap((segment) => segment.split(','))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** epoch ms → UTC ISO 8601；非正 / 非有限则视为「无检查时刻」。 */
function isoFromEpochMs(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

/**
 * 把 K06 的读回报告投影为 F08 `recordProbe` 的输入。
 *
 * **只投影探针管辖的维度**：`portReady` / `portReason` / `unsupportedCapabilities` /
 * `runtimeCompatible` / `checkedAt`。报告里的 `installed` / `enabled` / `authorized`
 * **不写回**——那三态由 F08 的安装 / 启用 / 授权操作驱动，报告里的它们供
 * {@link readinessVerdicts} 交给调用方**分别**核对（不合并、不覆盖）。
 *
 * `portReady=true` 时原因强制为 null（与 `recordProbe` 的自洽约束一致）。
 * K06 用 `capability_unavailable:<csv>` / `runtime_incompatible:<csv>` 承载细分原因，
 * 本层忠实提取；缺失时**不推断**（`unsupportedCapabilities` 省略，交由 `recordProbe` 保留旧值）。
 */
export function probeInputFromReadiness(report: KernelReadinessReport): ProbeInput {
  assertFourStatesReported(report);
  const port = report.portReady;
  const ready = port.state === 'ready';
  const unsupported = itemsWith(port.reason, CAPABILITY_TOKEN);
  const runtimeIncompatible = port.reason !== null && port.reason.includes(RUNTIME_TOKEN);
  const checkedAt = isoFromEpochMs(port.checkedAt);
  return {
    portReady: ready,
    portReason: ready ? null : (port.reason ?? '内核探针：端口未就绪（探针未给出细分原因）'),
    ...(unsupported.length > 0 ? { unsupportedCapabilities: unsupported } : {}),
    runtimeCompatible: !runtimeIncompatible,
    ...(checkedAt === undefined ? {} : { checkedAt }),
  };
}

/**
 * 把一份 K06 读回报告落到 F08 状态：`recordProbe(state, toF08TemplateId(report.id), …)`。
 * 未知模板 id / 残缺报告各自抛错（A1 / A4），不静默吞掉。
 */
export function applyReadinessReport(state: TemplatesState, report: KernelReadinessReport): TemplatesState {
  const templateId = toF08TemplateId(report.id);
  return recordProbe(state, templateId, probeInputFromReadiness(report));
}

// ---------------------------------------------------------------------------
// A6：探针**事件流**（K-I04 宿主 `export` 命令的终局 resultRef）→ F08 状态
// ---------------------------------------------------------------------------

/** K-I04 宿主 `templates.export`（readiness）终局事件的 resultRef 形状。 */
export interface TemplateProbeEvent {
  /** 内核 mobile-v1 模板 id（如 `meituan`）。 */
  readonly templateId: string;
  readonly version: string;
  /** 四态判定（四个独立布尔）。 */
  readonly verdicts: TemplateReadiness;
}

const PROBE_RESULT_REF_PATTERN = /^template:([^@]+)@(\d+\.\d+\.\d+):(.*)$/;

/**
 * 解析 K-I04 宿主 readiness 事件的 resultRef：
 * `template:<id>@<x.y.z>:installed=<ready|not-ready>,enabled=…,authorized=…,portReady=…`。
 *
 * fail-closed：形状不符、缺任一态、或取值不是 `ready` / `not-ready`，一律抛 `invalid-transition`。
 * 该格式由**真实** K06 宿主模块产出，round-trip 由测试对真模块验证（非手写字符串）。
 */
export function parseProbeResultRef(resultRef: string): TemplateProbeEvent {
  const match = PROBE_RESULT_REF_PATTERN.exec(resultRef);
  if (match === null) {
    throw new TemplateError('invalid-transition', `无法解析模板就绪事件 resultRef：${resultRef}`, { resultRef });
  }
  const kernelId = match[1];
  const version = match[2];
  const statesPart = match[3];
  if (kernelId === undefined || version === undefined || statesPart === undefined) {
    throw new TemplateError('invalid-transition', `模板就绪事件 resultRef 字段缺失：${resultRef}`, { resultRef });
  }
  const seen: Partial<Record<FourStateName, boolean>> = {};
  for (const pair of statesPart.split(',')) {
    const [name, value] = pair.split('=');
    if (name === undefined || value === undefined || !(FOUR_STATE_NAMES as readonly string[]).includes(name)) {
      throw new TemplateError('invalid-transition', `模板就绪事件含未知状态项：${String(pair)}`, { resultRef });
    }
    if (value !== 'ready' && value !== 'not-ready') {
      throw new TemplateError('invalid-transition', `模板就绪事件状态取值非法：${pair}`, { resultRef });
    }
    seen[name as FourStateName] = value === 'ready';
  }
  for (const name of FOUR_STATE_NAMES) {
    if (seen[name] === undefined) {
      throw new TemplateError('invalid-transition', `模板就绪事件缺状态 ${name}（四态不得合并 / 省略）`, {
        resultRef,
      });
    }
  }
  return {
    templateId: kernelId,
    version,
    verdicts: {
      installed: seen.installed === true,
      enabled: seen.enabled === true,
      authorized: seen.authorized === true,
      portReady: seen.portReady === true,
    },
  };
}

/**
 * 把一条探针事件（resultRef）落到 F08 状态。
 *
 * 事件只携带四态判定、**不含**细分原因与检查时刻，因此这里只写 `portReady`；未就绪原因
 * 用如实兜底文案（不编造 `capability_unavailable` 之类的事件没给的东西）。需要细分原因时
 * 用 {@link applyReadinessReport}（走 `reportReadiness()` 的富报告）。
 */
export function applyProbeResultRef(state: TemplatesState, resultRef: string): TemplatesState {
  const event = parseProbeResultRef(resultRef);
  const templateId = toF08TemplateId(event.templateId);
  return recordProbe(state, templateId, {
    portReady: event.verdicts.portReady,
    ...(event.verdicts.portReady
      ? {}
      : { portReason: '内核探针：端口未就绪（事件仅含四态判定，未含细分原因）' }),
  });
}

// ---------------------------------------------------------------------------
// A5：KernelClient 模板命令构造（薄适配，不含状态机）
// ---------------------------------------------------------------------------

/** 命令的公共上下文：内核去重用 id + 所属会话（mutation 分支需要 `conversationId` / `taskId`）。 */
export interface TemplateCommandContext {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly conversationId: string;
  /** 任务范围的模板操作可带上所属任务。 */
  readonly taskId?: string;
}

/** F08 面向模板的操作名（与 v1 `operation` 不是同一层，故单独命名词表）。 */
export type TemplateCommandName =
  | 'install'
  | 'enable'
  | 'authorize'
  | 'update'
  | 'uninstall'
  | 'probe';

/**
 * 操作 → 命令形态映射（唯一权威，测试直接读它）。
 *
 * K-I04 宿主约定（`apps/mobile-kernel/host/templates-module.ts`）：模板子操作走
 * `operation ∈ {redo, export}`（均属契约 mutation 分支），子操作名与参数放进 `args`：
 *   - `redo` + `args.op ∈ {install, upgrade, enable, authorize, uninstall, …}` → 状态迁移；
 *   - `export` + `args.op='readiness'` → 四态读回。
 *
 * `proposed: true`：契约 `command.schema.json` 的 `operation` 枚举**没有**模板专属操作，
 * 因此这是宿主模块的承载约定（`args.op`），待合同负责人确认，不冒充已冻结。
 */
export const TEMPLATE_COMMAND_MAP = {
  install: { v1Operation: 'redo', hostOp: 'install', branch: 'mutation', proposed: true },
  enable: { v1Operation: 'redo', hostOp: 'enable', branch: 'mutation', proposed: true },
  authorize: { v1Operation: 'redo', hostOp: 'authorize', branch: 'mutation', proposed: true },
  update: { v1Operation: 'redo', hostOp: 'upgrade', branch: 'mutation', proposed: true },
  uninstall: { v1Operation: 'redo', hostOp: 'uninstall', branch: 'mutation', proposed: true },
  probe: { v1Operation: 'export', hostOp: 'readiness', branch: 'mutation', proposed: true },
} as const satisfies Record<
  TemplateCommandName,
  { v1Operation: 'redo' | 'export'; hostOp: string; branch: 'mutation'; proposed: boolean }
>;

function assertContext(ctx: TemplateCommandContext): void {
  for (const key of ['commandId', 'idempotencyKey', 'conversationId'] as const) {
    const value = ctx[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TemplateError('invalid-transition', `命令缺少 ${key}`, { field: key });
    }
  }
  if (ctx.taskId !== undefined && (typeof ctx.taskId !== 'string' || ctx.taskId.trim() === '')) {
    throw new TemplateError('invalid-transition', 'taskId 若提供必须是非空字符串', { field: 'taskId' });
  }
}

function requireRecordArg(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TemplateError('invalid-transition', `${field} 必须是对象`, { field });
  }
  return value as Record<string, unknown>;
}

function requirePermissions(permissions: readonly TemplatePermission[]): readonly TemplatePermission[] {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    throw new TemplateError('invalid-permissions', '授权命令至少要给出一个权限', {});
  }
  for (const permission of permissions) {
    if (!PERMISSION_ORDER.includes(permission)) {
      throw new TemplateError('invalid-permissions', `未知权限：${String(permission)}`, { permission });
    }
  }
  return [...permissions];
}

/** A5：`expectedRevision` 从 F08 生命周期派生（调用方不可自带）。 */
function expectedRevisionOf(state: TemplatesState, templateId: string): number {
  return getTemplate(state, toF08TemplateId(templateId)).revision;
}

function templateCommand(
  ctx: TemplateCommandContext,
  state: TemplatesState,
  templateId: string,
  operation: 'redo' | 'export',
  args: Record<string, unknown>,
): Command {
  assertContext(ctx);
  const kernelId = toKernelTemplateId(templateId);
  return {
    schemaVersion: 'mobile-v1',
    commandId: ctx.commandId,
    operation,
    idempotencyKey: ctx.idempotencyKey,
    payload: {
      conversationId: ctx.conversationId,
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      expectedRevision: expectedRevisionOf(state, templateId),
      args: { id: kernelId, ...args },
    },
  };
}

/** 安装命令（`redo` + `args.op='install'`，携带目标 manifest）。 */
export function buildInstallTemplateCommand(
  ctx: TemplateCommandContext,
  state: TemplatesState,
  templateId: string,
  input: { readonly manifest: unknown },
): Command {
  const manifest = requireRecordArg(input.manifest, 'manifest');
  return templateCommand(ctx, state, templateId, 'redo', { op: 'install', manifest });
}

/** 启用命令（`redo` + `args.op='enable'`）。 */
export function buildEnableTemplateCommand(
  ctx: TemplateCommandContext,
  state: TemplatesState,
  templateId: string,
  options: { readonly version?: string } = {},
): Command {
  return templateCommand(ctx, state, templateId, 'redo', {
    op: 'enable',
    ...(options.version === undefined ? {} : { version: options.version }),
  });
}

/** 授权命令（`redo` + `args.op='authorize'`，携带权限集合）。 */
export function buildAuthorizeTemplateCommand(
  ctx: TemplateCommandContext,
  state: TemplatesState,
  templateId: string,
  input: { readonly permissions: readonly TemplatePermission[]; readonly version?: string },
): Command {
  const permissions = requirePermissions(input.permissions);
  return templateCommand(ctx, state, templateId, 'redo', {
    op: 'authorize',
    permissions: [...permissions],
    ...(input.version === undefined ? {} : { version: input.version }),
  });
}

/**
 * 更新命令（`redo` + `args.op='upgrade'`，携带**目标版本** manifest）。
 *
 * 更新比对新增权限的再授权语义由 F08 `applyUpdate` 与内核共同保证：目标 manifest 里新增的
 * 权限不会自动授予，命令发出后本地 `authorized` 会掉回 false（见测试与 `update-rollback`）。
 */
export function buildUpdateTemplateCommand(
  ctx: TemplateCommandContext,
  state: TemplatesState,
  templateId: string,
  input: { readonly manifest: unknown; readonly manualConfirmed?: boolean },
): Command {
  const manifest = requireRecordArg(input.manifest, 'manifest');
  return templateCommand(ctx, state, templateId, 'redo', {
    op: 'upgrade',
    manifest,
    ...(input.manualConfirmed === true ? { manualConfirmed: true } : {}),
  });
}

/** 卸载命令（`redo` + `args.op='uninstall'`）。 */
export function buildUninstallTemplateCommand(
  ctx: TemplateCommandContext,
  state: TemplatesState,
  templateId: string,
  options: { readonly version?: string } = {},
): Command {
  return templateCommand(ctx, state, templateId, 'redo', {
    op: 'uninstall',
    ...(options.version === undefined ? {} : { version: options.version }),
  });
}

/** 探针命令（`export` + `args.op='readiness'`）：产出的终局事件即探针事件流的那一条。 */
export function buildProbeTemplateCommand(
  ctx: TemplateCommandContext,
  state: TemplatesState,
  templateId: string,
  options: { readonly version?: string } = {},
): Command {
  return templateCommand(ctx, state, templateId, 'export', {
    op: 'readiness',
    ...(options.version === undefined ? {} : { version: options.version }),
  });
}

// ---------------------------------------------------------------------------
// 分支校验（与 command.schema.json 的 mutation 分支同口径；供适配器与测试共用）
// ---------------------------------------------------------------------------

const TEMPLATE_COMMAND_OPERATIONS: ReadonlySet<string> = new Set(['redo', 'export']);

/**
 * 断言一条模板命令满足公共必需字段与 mutation 分支不变量（`expectedRevision` 整数、
 * `conversationId|taskId` 至少其一），且 `args.op` 存在。违反抛 `invalid-transition`。
 * 与真实 `command.schema.json` 一致；测试另行对 schema 逐项核对。
 */
export function assertTemplateCommand(command: Command): void {
  const required = ['schemaVersion', 'commandId', 'operation', 'idempotencyKey', 'payload'] as const;
  for (const key of required) {
    if (command[key] === undefined) {
      throw new TemplateError('invalid-transition', `命令缺少必需字段 ${key}`, { field: key });
    }
  }
  if (command.schemaVersion !== 'mobile-v1') {
    throw new TemplateError('invalid-transition', 'schemaVersion 必须是 mobile-v1', {
      schemaVersion: command.schemaVersion,
    });
  }
  if (!TEMPLATE_COMMAND_OPERATIONS.has(command.operation)) {
    throw new TemplateError('invalid-transition', `模板命令 operation 必须是 redo / export：${command.operation}`, {
      operation: command.operation,
    });
  }
  const payload = command.payload as unknown as Record<string, unknown>;
  if (payload === null || typeof payload !== 'object') {
    throw new TemplateError('invalid-transition', 'payload 必须是对象', { operation: command.operation });
  }
  if (!Number.isInteger(payload['expectedRevision'])) {
    throw new TemplateError('invalid-transition', '模板命令（mutation 分支）必须含整数 expectedRevision', {
      operation: command.operation,
    });
  }
  if (payload['conversationId'] === undefined && payload['taskId'] === undefined) {
    throw new TemplateError('invalid-transition', '模板命令必须含 conversationId 或 taskId', {
      operation: command.operation,
    });
  }
  const args = payload['args'];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new TemplateError('invalid-transition', '模板命令必须含对象 args（宿主扩展槽）', {
      operation: command.operation,
    });
  }
  if (typeof (args as Record<string, unknown>)['op'] !== 'string') {
    throw new TemplateError('invalid-transition', '模板命令 args.op 必须是非空字符串', {
      operation: command.operation,
    });
  }
}
