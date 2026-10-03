/**
 * F09 settings / 设置页屏幕装配 + 原生端口绑定（integration slice F-I13）。
 *
 * 本文件是 F09 的**组合层**：把已经交付的六个「我的 / 设置」域——密钥状态
 * (`key-status.ts`)、连接 (`connection.ts`)、权限 (`permissions.ts`)、额度与存储
 * (`budget.ts`)、通知 (`notifications.ts`)、脱敏诊断 (`diagnostics.ts`)——装配成
 * **一个可渲染的设置页视图模型**，并把两个原生端口绑定到 F 线**唯一**的原生调用面
 * 上，设置页**不 import 任何 Android 桥 / 内核实现**。
 *
 * 对应 design-07：M01（我的）为壳，内含 M07（权限与连接）/ M08（额度与存储）/
 * M09（通知与后台说明）/ M10（应用信息与脱敏诊断导出）的分区。
 *
 * ## 三块内容
 *   1. {@link buildSettingsScreenView} —— 纯函数装配器：`SettingsScreenInput` → 六个分区
 *      (`SettingsSection`) 的 `SettingsScreenModel`；同输入同结果，不读时钟 / 随机数 / 网络。
 *   2. {@link buildStubStatusBanner} —— **占位状态横幅**：只要 `NativeKeyImporter` /
 *      `ConnectionTester` 仍是 `fixture` 绑定，横幅即置 `visible=true / tone=warning`，
 *      明说「尚未接通真机原生实现，结果不计入真实证据」。不接通就不许沉默。
 *   3. {@link createKernelKeyImporter} / {@link createKernelConnectionTester} /
 *      {@link bindSettingsPorts} —— 把两个端口**经 `KernelClient` 的原生调用**（`sendCommand`）
 *      转发：`NativeKeyImporter` → `operation:'import'`；`ConnectionTester` → `operation:'inspect'`。
 *      设置页只依赖结构面 {@link SettingsNativeCalls}（KernelClient 结构满足），
 *      因此**不 import** `apps/mobile-kernel/**` 或任何 Android 桥。
 *
 * ## 强不变量（由 `tests/mobile-ui/F09/screen.test.ts` 机器化断言）
 *   S1 六个分区恒齐全且顺序固定（key / connection / permissions / quota / notifications /
 *      diagnostics）；行触区取自 foundation `list-row` 规格（单一来源，不写死 48）。
 *   S2 只透传**已脱敏**的文本：屏幕模型里不得出现密钥明文 / 认证头 / 明文 keyRef 之外的
 *      敏感值；导入意图与命令载荷里出现明文一律 `plaintext-not-accepted`（fail-closed，
 *      适配层再拦一次）。
 *   S3 fixture 横幅诚实：任一端口为 `fixture` ⇒ `visible=true / tone=warning`；全 `native`
 *      ⇒ `visible=false`；横幅文案列出具体哪些端口是 fixture。
 *   S4 端口经 KernelClient：产出的命令是合法 v1 `Command`（operation `import` / `inspect`），
 *      可被 `contracts/mobile-v1/validate.mjs` 通过；`succeeded` 缺 `resultRef` 或返回非
 *      `keyref:` ⇒ 适配器报 `invalid-result`，绝不当作导入成功。
 *   S5 `KernelClient` 关闭（`state !== 'open'`）时，导入报 `client-closed`，探测抛错，
 *      不伪造结果。
 *
 * ## 明确未做（不得当成已完成）
 *   - 真机原生实现未接：Android Keystore / 内容选择器 / 真主机探测**均未实现**；
 *     本文件的适配器只是把端口**结构化地转发**给 `KernelClient.sendCommand`，其后的
 *     原生命令实现属 K 线 / 协调者；默认绑定标记为 `fixture`（见 {@link DEFAULT_PORT_BINDINGS}）。
 *   - `ConnectionTester` 的 `inspect` 命令按冻结契约 `queryBranch` 需要一个锚点
 *     (`conversationId` / `taskId`)——设置页无会话时须由调用方注入 {@link SettingsProbeAnchor}；
 *     这是契约限制，不是可省略参数（见 README「残留」）。
 *   - 渲染：只产出视图模型与 `ViewNode` 树，不做 Android View / 事件绑定 / 真机渲染。
 */

import type {
  Command,
  CommandOperation,
  Event,
  EventError,
  EventStatus,
  VerificationMode,
} from '../../../../contracts/mobile-v1/types.js';
import { getControl } from '../foundation/index.js';
import type { ViewNode } from '../render/index.js';

import {
  CONNECTION_STATES,
  KEY_STATUS_LABELS,
  PERMISSION_LABELS,
  SettingsError,
  isIsoTimestamp,
  isKeyRef,
  type ConnectionState,
  type PermissionStatus,
} from './types.js';
import {
  findPlaintext,
  type KeyImportIntent,
  type KeyRefView,
  type NativeImportResult,
  type NativeKeyImporter,
} from './key-status.js';
import {
  isValidHost,
  type ConnectionTester,
  type RawConnectionFailure,
  type RawConnectionProbe,
} from './connection.js';
import { recoveryHint, type CapabilityDecision, type PermissionEntry } from './permissions.js';
import type { BudgetUsage, StorageUsageView } from './budget.js';
import type { NotificationView } from './notifications.js';
import { sanitizeFailure, type DiagnosticExport } from './diagnostics.js';

// ---------------------------------------------------------------------------
// 原生调用面（结构端口 —— KernelClient 结构满足）
// ---------------------------------------------------------------------------

/**
 * `KernelClient.sendCommand` 回执的**结构化子集**：只取设置页需要判定的字段。
 * 真实 `platform/types.ts` 的 `CommandReceipt` 含这些字段，因而结构兼容，无需 import 平台层。
 */
export interface SettingsNativeReceipt {
  readonly status: EventStatus;
  readonly resultRef: string | null;
  readonly error: EventError | null;
  readonly verificationMode: VerificationMode;
  /** 内核终局事件原文（用于读取 `metadata` 中的原生结果）。 */
  readonly event: Event;
}

/**
 * 设置页唯一依赖的原生调用面。真实 `KernelClient`（F-I01）结构满足：
 * `state: 'open' | 'closed'` + `sendCommand(command) -> receipt`。
 * 设置页**只**依赖此结构面，不 import 桥 / 内核实现。
 */
export interface SettingsNativeCalls {
  readonly state: 'open' | 'closed';
  sendCommand(command: Command): Promise<SettingsNativeReceipt>;
}

// ---------------------------------------------------------------------------
// 端口绑定与占位状态横幅
// ---------------------------------------------------------------------------

export type PortId = 'key-importer' | 'connection-tester';

/** `fixture` = 走结构面但原生实现未落地；`native` = 真机原生实现已接通。 */
export type PortBindingKind = 'fixture' | 'native';

export interface SettingsPortBinding {
  readonly port: PortId;
  readonly kind: PortBindingKind;
  readonly note: string;
}

/** 端口展示名（横幅文案用）。 */
export const PORT_LABELS: Readonly<Record<PortId, string>> = Object.freeze({
  'key-importer': '密钥导入',
  'connection-tester': '连接测试',
});

/**
 * 默认绑定：**两个端口都是 fixture**——在本轮范围里原生实现尚未落地，
 * 因此设置页必须显式声明「占位」，不得沉默地冒充已接通。
 */
export const DEFAULT_PORT_BINDINGS: readonly SettingsPortBinding[] = Object.freeze([
  {
    port: 'key-importer',
    kind: 'fixture',
    note: 'K01/K07 原生导入命令未落地：仅经 KernelClient.sendCommand(import) 结构转发',
  },
  {
    port: 'connection-tester',
    kind: 'fixture',
    note: 'K 线探测命令未落地：仅经 KernelClient.sendCommand(inspect) 结构转发',
  },
]);

export interface StubStatusBanner {
  readonly visible: boolean;
  readonly tone: 'info' | 'warning';
  readonly text: string;
  /** 仍为 fixture 的端口（稳定排序）。 */
  readonly fixturePorts: readonly PortId[];
}

/**
 * 构造占位状态横幅。任一端口为 `fixture` ⇒ 警告横幅并列出端口名；全 `native` ⇒ 不显示。
 * 不接通就不许沉默——这是「结果不得编造」在设置页的落地。
 */
export function buildStubStatusBanner(bindings: readonly SettingsPortBinding[]): StubStatusBanner {
  const fixturePorts = bindings
    .filter((binding) => binding.kind === 'fixture')
    .map((binding) => binding.port)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  if (fixturePorts.length === 0) {
    return { visible: false, tone: 'info', text: '原生端口已接通（非 fixture）', fixturePorts: [] };
  }
  const names = fixturePorts.map((port) => PORT_LABELS[port]).join('、');
  return {
    visible: true,
    tone: 'warning',
    text: `${names}当前为 fixture 端口，尚未接通真机原生实现；由此产生的结果不计入真实证据。`,
    fixturePorts,
  };
}

// ---------------------------------------------------------------------------
// 命令构造（v1 契约：import 分支 / inspect 分支）
// ---------------------------------------------------------------------------

/** 确定性 id 工厂（同实例内递增）；测试可注入固定序列。 */
function defaultIdFactory(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}

export interface KernelPortOptions {
  /** 命令 id / 幂等键工厂；缺省为实例内确定性递增。 */
  readonly newId?: () => string;
  readonly commandPrefix?: string;
}

/**
 * 构造密钥导入命令：`operation:'import'`（契约 `createBranch`，无需锚点）。
 * 载荷只放**原生来源描述 + 一次性令牌引用**，绝不含密钥明文。
 */
export function buildKeyImportCommand(
  intent: KeyImportIntent,
  commandId: string,
  idempotencyKey: string,
): Command {
  const args: Record<string, unknown> = {
    provider: intent.provider,
    nativeSource: intent.nativeSource,
    oneTimeToken: intent.oneTimeToken,
  };
  if (intent.requestedModel !== undefined) args['requestedModel'] = intent.requestedModel;
  return {
    schemaVersion: 'mobile-v1',
    commandId,
    operation: 'import',
    idempotencyKey,
    payload: { args },
    metadata: { kind: 'settings.key-import' },
  };
}

/**
 * 连接探测的锚点。冻结契约的 `query`/`inspect` 分支要求 `conversationId` 或 `taskId`
 * （见 `contracts/mobile-v1/schemas/command.schema.json` 的 `queryBranch`），
 * 设置页自身无会话，故由调用方注入当前会话/任务锚点。
 */
export type SettingsProbeAnchor =
  | { readonly conversationId: string }
  | { readonly taskId: string };

export interface KernelProbeOptions extends KernelPortOptions {
  readonly anchor: SettingsProbeAnchor;
}

/**
 * 构造连接探测命令：`operation:'inspect'`（契约 `queryBranch`）+ 锚点。
 * 原生命令的探测结果由终局事件的 `metadata.probe` 回传（见 {@link parseRawProbe}）。
 */
export function buildConnectionProbeCommand(
  anchor: SettingsProbeAnchor,
  commandId: string,
  idempotencyKey: string,
): Command {
  return {
    schemaVersion: 'mobile-v1',
    commandId,
    operation: 'inspect',
    idempotencyKey,
    payload: { ...anchor, filters: { probe: 'connection' } },
    metadata: { kind: 'settings.connection-probe' },
  };
}

// ---------------------------------------------------------------------------
// 适配器：NativeKeyImporter
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把 `NativeKeyImporter` 绑定到 {@link SettingsNativeCalls}（真实 `KernelClient` 结构满足）。
 *
 * 闸门顺序（fail-closed）：
 *   1. 意图含明文嫌疑 ⇒ `plaintext-not-accepted`（适配层再拦一次，结构性防线）；
 *   2. 调用面关闭 ⇒ `client-closed`（retryable）；
 *   3. 命令抛错 ⇒ `native-command-failed`；
 *   4. 非 `succeeded` ⇒ `error.code` 或 `kernel-<status>`；
 *   5. `succeeded` 但 `resultRef` 非 `keyref:` 或 `metadata.importedAt` 非 UTC ISO
 *      ⇒ `invalid-result`（绝不把坏回执当导入成功）。
 */
export function createKernelKeyImporter(
  calls: SettingsNativeCalls,
  options: KernelPortOptions = {},
): NativeKeyImporter {
  const newId = options.newId ?? defaultIdFactory(options.commandPrefix ?? 'settings-key-import');

  return {
    async importFromNative(intent: KeyImportIntent): Promise<NativeImportResult> {
      if (findPlaintext(intent).length > 0) {
        return { ok: false, reason: 'plaintext-not-accepted', retryable: false };
      }
      if (calls.state !== 'open') {
        return { ok: false, reason: 'client-closed', retryable: true };
      }
      const base = newId();
      const command = buildKeyImportCommand(intent, `cmd-${base}`, `idem-${base}`);

      let receipt: SettingsNativeReceipt;
      try {
        receipt = await calls.sendCommand(command);
      } catch (error) {
        return { ok: false, reason: 'native-command-failed', retryable: true };
      }

      if (receipt.status !== 'succeeded') {
        return {
          ok: false,
          reason: receipt.error?.code ?? `kernel-${receipt.status}`,
          retryable: receipt.error?.retryable === true,
        };
      }

      const keyRef = receipt.resultRef;
      const importedAt = receipt.event.metadata?.['importedAt'];
      if (!isKeyRef(keyRef) || !isIsoTimestamp(importedAt)) {
        return { ok: false, reason: 'invalid-result', retryable: false };
      }
      const rotated = receipt.event.metadata?.['rotated'] === true;
      return {
        ok: true,
        keyRef,
        importedAt,
        verificationMode: receipt.verificationMode,
        ...(rotated ? { rotated: true } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 适配器：ConnectionTester
// ---------------------------------------------------------------------------

function parseRawFailure(value: unknown): RawConnectionFailure | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SettingsError('invalid-connection-state', 'probe.failure 必须是对象或 null');
  }
  const record = value as Record<string, unknown>;
  if (typeof record['code'] !== 'string' || typeof record['message'] !== 'string') {
    throw new SettingsError('invalid-connection-state', 'probe.failure.code / .message 必须是字符串');
  }
  return { code: record['code'], message: record['message'], retryable: record['retryable'] === true };
}

/**
 * 校验并投影原生探测结果。任何非法字段抛 {@link SettingsError}，不猜测、不补默认值。
 * 注意 `host` 必须是主机名（不含 scheme / 凭据），防止把认证信息塞进 host。
 */
export function parseRawProbe(value: unknown): RawConnectionProbe {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SettingsError('invalid-connection-state', '探测结果缺少结构化 probe 对象');
  }
  const record = value as Record<string, unknown>;

  const state = record['state'];
  if (typeof state !== 'string' || !(CONNECTION_STATES as readonly string[]).includes(state)) {
    throw new SettingsError('invalid-connection-state', 'probe.state 非法');
  }
  const host = record['host'];
  if (!isValidHost(host)) {
    throw new SettingsError('invalid-source', 'probe.host 必须是主机名（可含端口），不得含 scheme 或凭据');
  }
  const verificationMode = record['verificationMode'];
  if (verificationMode !== 'fixture' && verificationMode !== 'real') {
    throw new SettingsError('invalid-connection-state', 'probe.verificationMode 必须是 fixture / real');
  }
  const checkedAt = record['checkedAt'];
  if (checkedAt !== undefined && checkedAt !== null && !isIsoTimestamp(checkedAt)) {
    throw new SettingsError('invalid-timestamp', 'probe.checkedAt 必须是 UTC ISO 或 null');
  }
  const model = record['model'];
  if (model !== undefined && model !== null && typeof model !== 'string') {
    throw new SettingsError('invalid-connection-state', 'probe.model 必须是字符串');
  }
  const failure = parseRawFailure(record['failure']);

  return {
    state: state as ConnectionState,
    host,
    ...(typeof model === 'string' ? { model } : {}),
    checkedAt: checkedAt === undefined || checkedAt === null ? null : checkedAt,
    verificationMode,
    failure,
  };
}

/**
 * 把 `ConnectionTester` 绑定到 {@link SettingsNativeCalls}。
 *
 * `succeeded` ⇒ 从终局事件 `metadata.probe` 读原生探测结果（{@link parseRawProbe} 校验）；
 * 非 `succeeded` 或缺少 `resultRef` ⇒ 抛 {@link SettingsError}（**不得**伪造一个「已连接」
 * 的探针）；失败文案先经 `sanitizeFailure` 脱敏，绝不把密钥 / 原始认证头带进错误消息。
 */
export function createKernelConnectionTester(
  calls: SettingsNativeCalls,
  options: KernelProbeOptions,
): ConnectionTester {
  const newId = options.newId ?? defaultIdFactory(options.commandPrefix ?? 'settings-conn-probe');

  return {
    async test(): Promise<RawConnectionProbe> {
      if (calls.state !== 'open') {
        throw new SettingsError('invalid-connection-state', 'KernelClient 已关闭，无法探测连接');
      }
      const base = newId();
      const command = buildConnectionProbeCommand(options.anchor, `cmd-${base}`, `idem-${base}`);

      let receipt: SettingsNativeReceipt;
      try {
        receipt = await calls.sendCommand(command);
      } catch (error) {
        const safe = sanitizeFailure(messageOf(error));
        throw new SettingsError('invalid-connection-state', `连接探测命令失败：${safe.message}`);
      }

      const hasRef = typeof receipt.resultRef === 'string' && receipt.resultRef.length > 0;
      if (receipt.status !== 'succeeded' || !hasRef) {
        const rawMessage = receipt.error?.message ?? `内核返回 ${receipt.status}（无 resultRef）`;
        const safe = sanitizeFailure(rawMessage);
        throw new SettingsError('invalid-connection-state', `连接探测未取得结果：${safe.message}`);
      }
      return parseRawProbe(receipt.event.metadata?.['probe']);
    },
  };
}

// ---------------------------------------------------------------------------
// 一站式端口绑定
// ---------------------------------------------------------------------------

export interface BindSettingsPortsOptions {
  /** 连接探测命令的会话/任务锚点（契约 queryBranch 要求）。 */
  readonly anchor: SettingsProbeAnchor;
  /** 绑定种类；缺省 `fixture`（原生实现未落地时不得冒充 native）。 */
  readonly bindingKind?: PortBindingKind;
  readonly keyImport?: KernelPortOptions;
  readonly probe?: KernelPortOptions;
}

export interface BoundSettingsPorts {
  readonly keyImporter: NativeKeyImporter;
  readonly connectionTester: ConnectionTester;
  /** 供 {@link buildStubStatusBanner} / 屏幕装配使用的绑定声明。 */
  readonly bindings: readonly SettingsPortBinding[];
}

/** 把两个原生端口一次性绑定到 `KernelClient` 的结构面，并给出诚实的绑定声明。 */
export function bindSettingsPorts(
  calls: SettingsNativeCalls,
  options: BindSettingsPortsOptions,
): BoundSettingsPorts {
  const kind: PortBindingKind = options.bindingKind ?? 'fixture';
  const note =
    kind === 'fixture'
      ? '仅经 KernelClient.sendCommand 结构转发；原生实现未落地'
      : '经 KernelClient.sendCommand 转发到已接通的原生实现';
  return {
    keyImporter: createKernelKeyImporter(calls, options.keyImport ?? {}),
    connectionTester: createKernelConnectionTester(calls, { anchor: options.anchor, ...(options.probe ?? {}) }),
    bindings: [
      { port: 'key-importer', kind, note },
      { port: 'connection-tester', kind, note },
    ],
  };
}

// ---------------------------------------------------------------------------
// 设置页视图模型
// ---------------------------------------------------------------------------

export type SettingsTone = 'neutral' | 'ok' | 'warn' | 'danger';

export interface SettingsRow {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly detail: string | null;
  readonly tone: SettingsTone;
  /** 有效触区（dp），取自 foundation `list-row` 规格（单一来源）。 */
  readonly minTouchDp: number;
}

export type SettingsSectionId =
  | 'key'
  | 'connection'
  | 'permissions'
  | 'quota'
  | 'notifications'
  | 'diagnostics';

export interface SettingsSection {
  readonly id: SettingsSectionId;
  readonly title: string;
  readonly rows: readonly SettingsRow[];
}

export interface SettingsScreenModel {
  readonly screen: 'M01';
  readonly route: 'me';
  readonly title: string;
  /** 占位状态横幅（fixture 端口未接通时可见）。 */
  readonly banner: StubStatusBanner;
  readonly sections: readonly SettingsSection[];
}

/** 固定的分区顺序（S1）。 */
export const SETTINGS_SECTION_ORDER: readonly SettingsSectionId[] = Object.freeze([
  'key',
  'connection',
  'permissions',
  'quota',
  'notifications',
  'diagnostics',
]);

const SECTION_TITLES: Readonly<Record<SettingsSectionId, string>> = Object.freeze({
  key: '模型密钥',
  connection: '连接',
  permissions: '权限',
  quota: '额度与存储',
  notifications: '通知与后台',
  diagnostics: '应用信息与诊断',
});

const PERMISSION_STATUS_LABELS: Readonly<Record<PermissionStatus, string>> = Object.freeze({
  granted: '已授权',
  denied: '已拒绝',
  'not-requested': '未申请',
  revoked: '已撤销',
});

export interface SettingsScreenInput {
  /** 密钥注册表快照（只含引用与状态）。 */
  readonly keys: readonly KeyRefView[];
  readonly connection: ConnectionViewLike;
  readonly permissions: readonly PermissionEntry[];
  readonly capabilities?: readonly CapabilityDecision[];
  readonly budget: BudgetUsage;
  readonly storage: StorageUsageView;
  readonly notifications: NotificationView;
  readonly diagnostics: DiagnosticExport;
  readonly portBindings?: readonly SettingsPortBinding[];
}

/** 屏幕装配只读消费连接视图的可展示字段（结构面，避免硬绑具体模块版本）。 */
export interface ConnectionViewLike {
  readonly state: ConnectionState;
  readonly label: string;
  readonly host: string;
  readonly model: string | null;
  readonly checkedAt: string | null;
  readonly failure: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly redactedCount: number;
  } | null;
}

function joinDetail(parts: readonly (string | null | undefined)[]): string | null {
  const kept = parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
  return kept.length === 0 ? null : kept.join(' · ');
}

function keyRows(keys: readonly KeyRefView[], minTouchDp: number): SettingsRow[] {
  if (keys.length === 0) {
    return [
      {
        id: 'key.none',
        label: '密钥',
        value: KEY_STATUS_LABELS.absent,
        detail: '尚未导入；导入仅走原生路径，设置页不收明文',
        tone: 'warn',
        minTouchDp,
      },
    ];
  }
  return keys.map((view) => ({
    id: `key.${view.keyRef}`,
    label: view.model === undefined ? view.provider : `${view.provider} · ${view.model}`,
    value: KEY_STATUS_LABELS[view.status],
    detail: joinDetail([
      view.updatedAt === null ? null : `更新于 ${view.updatedAt}`,
      `验证：${view.verificationMode}`,
      view.usable ? '可用' : '不可用',
    ]),
    tone: view.usable ? 'ok' : view.status === 'revoked' ? 'danger' : 'warn',
    minTouchDp,
  }));
}

function connectionRows(view: ConnectionViewLike, minTouchDp: number): SettingsRow[] {
  const tone: SettingsTone =
    view.state === 'connected'
      ? 'ok'
      : view.state === 'unauthorized'
        ? 'danger'
        : view.state === 'degraded'
          ? 'warn'
          : view.state === 'disconnected'
            ? 'warn'
            : 'neutral';
  const rows: SettingsRow[] = [
    {
      id: 'connection.state',
      label: '连接状态',
      value: view.label,
      detail: joinDetail([
        view.host.length > 0 ? view.host : null,
        view.model,
        view.checkedAt === null ? null : `测试于 ${view.checkedAt}`,
      ]),
      tone,
      minTouchDp,
    },
  ];
  if (view.failure !== null) {
    rows.push({
      id: 'connection.failure',
      label: '最近失败',
      value: view.failure.code,
      detail: `${view.failure.message}${
        view.failure.redactedCount > 0 ? `（展示前已脱敏 ${view.failure.redactedCount} 处）` : ''
      }`,
      tone: view.failure.retryable ? 'warn' : 'danger',
      minTouchDp,
    });
  }
  return rows;
}

function permissionRows(
  entries: readonly PermissionEntry[],
  capabilities: readonly CapabilityDecision[],
  minTouchDp: number,
): SettingsRow[] {
  const rows: SettingsRow[] = entries.map((entry) => ({
    id: `perm.${entry.permission}`,
    label: PERMISSION_LABELS[entry.permission],
    value: PERMISSION_STATUS_LABELS[entry.status],
    detail: recoveryHint(entry.permission, entry.status),
    tone:
      entry.status === 'granted'
        ? 'ok'
        : entry.status === 'revoked'
          ? 'danger'
          : entry.status === 'denied'
            ? 'warn'
            : 'neutral',
    minTouchDp,
  }));
  for (const decision of capabilities) {
    rows.push({
      id: `cap.${decision.capability}`,
      label: `能力 · ${decision.capability}`,
      value: decision.allowed ? '可用' : '不可用',
      detail: decision.hint,
      tone: decision.allowed ? 'ok' : 'warn',
      minTouchDp,
    });
  }
  return rows;
}

function quotaRows(budget: BudgetUsage, storage: StorageUsageView, minTouchDp: number): SettingsRow[] {
  return [
    {
      id: 'quota.budget',
      label: '额度',
      value: budget.exhausted ? '已用尽' : budget.real ? '有剩余' : '未知（非真实用量）',
      detail: budget.label,
      tone: budget.exhausted ? 'warn' : budget.real ? 'ok' : 'neutral',
      minTouchDp,
    },
    {
      id: 'quota.storage',
      label: '存储',
      value: storage.measured ? '已测量' : '未知（未测量）',
      detail: storage.label,
      tone: storage.measured ? 'neutral' : 'warn',
      minTouchDp,
    },
  ];
}

function notificationRows(view: NotificationView, minTouchDp: number): SettingsRow[] {
  const rows: SettingsRow[] = [
    {
      id: 'notify.summary',
      label: '通知与提醒',
      value: view.remindersEffective ? '提醒可用' : '提醒不可用',
      detail: view.label,
      tone: view.remindersEffective ? 'ok' : 'neutral',
      minTouchDp,
    },
  ];
  if (view.backgroundRestricted) {
    rows.push({
      id: 'notify.background',
      label: '后台受限',
      value: '受限',
      detail: `${view.backgroundNotice ?? '系统限制了后台运行'}${
        view.backgroundRedactedCount > 0 ? `（展示前已脱敏 ${view.backgroundRedactedCount} 处）` : ''
      }`,
      tone: 'warn',
      minTouchDp,
    });
  }
  rows.push({
    id: 'notify.entry',
    label: '系统设置入口',
    value: view.systemSettingsEntry,
    detail: null,
    tone: 'neutral',
    minTouchDp,
  });
  return rows;
}

function diagnosticsRows(diagnostics: DiagnosticExport, minTouchDp: number): SettingsRow[] {
  const clean = diagnostics.redaction.clean;
  const kinds = diagnostics.redaction.redactedKinds;
  return [
    {
      id: 'diag.version',
      label: '应用版本',
      value: diagnostics.appVersion,
      detail: `${diagnostics.verificationMode} · 生成于 ${diagnostics.generatedAt}`,
      tone: 'neutral',
      minTouchDp,
    },
    {
      id: 'diag.export',
      label: '诊断导出',
      value: clean ? '无敏感项' : '已脱敏',
      detail: `替换 ${diagnostics.redaction.redactedFields} 处${kinds.length > 0 ? `（${kinds.join(', ')}）` : ''}`,
      tone: clean ? 'ok' : 'warn',
      minTouchDp,
    },
  ];
}

/**
 * 装配设置页视图模型：六个分区 + 占位状态横幅。纯函数，同输入同结果。
 * 只展示已脱敏 / 已推导的文本；不 dump 诊断 sections 原文。
 */
export function buildSettingsScreenView(input: SettingsScreenInput): SettingsScreenModel {
  const minTouchDp = getControl('list-row').minTouchDp;
  const bindings = input.portBindings ?? DEFAULT_PORT_BINDINGS;
  const rowsBySection: Readonly<Record<SettingsSectionId, readonly SettingsRow[]>> = {
    key: keyRows(input.keys, minTouchDp),
    connection: connectionRows(input.connection, minTouchDp),
    permissions: permissionRows(input.permissions, input.capabilities ?? [], minTouchDp),
    quota: quotaRows(input.budget, input.storage, minTouchDp),
    notifications: notificationRows(input.notifications, minTouchDp),
    diagnostics: diagnosticsRows(input.diagnostics, minTouchDp),
  };

  return {
    screen: 'M01',
    route: 'me',
    title: '我的 / 设置',
    banner: buildStubStatusBanner(bindings),
    sections: SETTINGS_SECTION_ORDER.map((id) => ({
      id,
      title: SECTION_TITLES[id],
      rows: rowsBySection[id],
    })),
  };
}

// ---------------------------------------------------------------------------
// 渲染节点（消费 F-I03 render 底座，只读）
// ---------------------------------------------------------------------------

/**
 * 把设置页视图模型投影为声明式 `ViewNode` 树（框架无关；由 shell / host 决定如何渲染）。
 * 结构：标题 + 横幅（`role:'status'`）+ 每分区（`section` > `h2` + `ul` 行）。纯函数。
 */
export function settingsScreenToViewNode(model: SettingsScreenModel): ViewNode {
  const bannerChildren: readonly ViewNode[] = [
    { tag: 'p', role: 'text', text: model.banner.text },
  ];

  const sectionNodes: readonly ViewNode[] = model.sections.map((section) => ({
    tag: 'section',
    role: 'container',
    ariaLabel: section.title,
    children: [
      { tag: 'h2', role: 'heading', text: section.title },
      {
        tag: 'ul',
        role: 'list',
        children: section.rows.map((row): ViewNode => {
          const children: readonly ViewNode[] = [
            { tag: 'span', role: 'text', text: `${row.label}：${row.value}` },
          ];
          return {
            tag: 'li',
            role: 'list-item',
            ariaLabel: `${row.label}：${row.value}`,
            children:
              row.detail === null
                ? children
                : [...children, { tag: 'span', role: 'text', text: row.detail }],
          };
        }),
      },
    ],
  }));

  return {
    tag: 'div',
    role: 'screen',
    attrs: { id: 'settings-screen' },
    children: [
      { tag: 'h1', role: 'heading', text: model.title },
      { tag: 'div', role: 'status', ariaLabel: model.banner.text, children: bannerChildren },
      ...sectionNodes,
    ],
  };
}

/** 命令操作字面量（供断言/文档引用，避免散落魔法字符串）。 */
export const SETTINGS_COMMAND_OPERATIONS: Readonly<Record<PortId, CommandOperation>> = Object.freeze({
  'key-importer': 'import',
  'connection-tester': 'inspect',
});
