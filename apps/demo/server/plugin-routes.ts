/**
 * 模板平台**产品入口**（FA-PRODUCT-WIRE-PLG）—— 把 `src/plugins/**` 从「只有库函数」
 * 接到 HTTP：清单 / 详情 / 安装 / 启用 / 停用 / 卸载 / 撤权 / 五态 / 版本固定。
 *
 * ## 本模块唯一的目标（只做接入口，不补功能）
 *
 * `src/plugins/**`（FA-C）已经把七个业务模板与三个基础角色的**真实清单**、安装来源管理、
 * 声明式包校验、卸载流程编排、版本冻结、五态能力发现全部做好，但**没有产品入口**。
 * 本模块把它们接到 HTTP，且**一律调用 `src/plugins/**` 的现有函数**——不在这里重写任何
 * 五态判定、包校验或卸载语义，入口表现与内核语义**不可能分叉**。
 *
 * ## 五条硬纪律（都落在代码路径上，不只是注释）
 *
 * 1. **真实清单，不是名字**（R227 / R228 / R232）。`GET /api/plugins` 逐条给出十个插件
 *    （七个业务模板 + 三个基础角色）的版本 / 能力 / 适配器依赖 / 权限 / 数据范围 / 经验策略 /
 *    产出与读取格式 / 实现标记。**可用操作清单按需读取**（`limit` + `truncated` + `omitted_count`），
 *    只给能力标签，**绝不**倒出指令全文（R231）。
 * 2. **声明式包先校验再落状态**（R229）。`POST /api/plugins/install` 先跑
 *    `validateDeclarativePackageForInstall`：`exec` / `postinstall` / 任意 MCP URL 一律拒绝，
 *    且**具名报因**（`[code] subject: detail`）。校验不过 ⇒ **一个字节都不落**。
 * 3. **卸载缺项即阻塞**（R230 / PLG-05）。`POST /api/plugins/:id/uninstall` 复用
 *    `applyUninstallFlow`：任何引用该插件的活跃实例只要**没有显式处置**，流程**阻塞**并返回
 *    结构化计划，**不改任何持久状态**——不允许「卸载了但任务还在后台跑」。
 * 4. **五态分开呈现**（R231 / R233）。`已安装 / 启用 / 授权 / 依赖就绪 / 实测支持` 是五个
 *    独立问题，逐项给出布尔 + 未就绪原因 + **解锁动作**（`unlock_actions`），并如实标识 stub。
 * 5. **无端口 ⇒ 结构化 503，不退回内存冒充持久**（R220）。没有注入 `InstallStateStore`
 *    （也没有注入现成 `InstallSourceManager`）时，**整个模块**返回 503 `plugin_store_unwired`，
 *    **绝不**用进程内存顶替持久介质。
 *
 * ## 与并发包的关系
 *
 * 本文件是**独立路由模块**：`http.ts` / `main.ts` 的挂载由总协调者统一接线（见文件末尾
 * 「挂载说明」），本模块**不改**任何既有文件，避免与同波次的其它包冲突。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { ValidationError, asLogicalTime, asTaskId, type LogicalTime } from '../../../src/protocol/index.js';
import {
  OPERATION_LIST_DEFAULT_LIMIT,
  TASK_DISPOSITIONS,
  VersionFreezer,
  applyUninstallFlow,
  conservativeProbes,
  createInstallSourceManager,
  describePackageIssue,
  findInstructionLeaks,
  planUninstallFlow,
  readAvailableOperations,
  stateVector,
  PLUGIN_CATALOG,
  type ActiveTaskRef,
  type CapabilityDiscovery,
  type DiscoveryProbes,
  type ExternalEffect,
  type FrozenInstance,
  type InstallSourceManager,
  type InstallStateStore,
  type PackageValidationIssue,
  type PluginManifest,
  type PluginRegistry,
  type RetainedAssetDecision,
  type TaskDispositionKind,
} from '../../../src/plugins/index.js';

// ---------------------------------------------------------------------------
// 常量与选项
// ---------------------------------------------------------------------------

/** 本模块独占的路由根；`http.ts` / `main.ts` 只按这个前缀转交。 */
export const PLUGINS_ROOT = '/api/plugins';

const MAX_BODY_BYTES = 64 * 1024;

/** 三态 / 五态的解锁动作里引用的路由根，避免文案与路由分叉。 */
const R = PLUGINS_ROOT;

/** 产品默认依赖探针：三个办公模板的**内置构建器**在仓库里可指认，其余适配器一律未就绪。 */
const DEFAULT_READY_ADAPTERS = ['builtin.docx_builder', 'builtin.xlsx_builder', 'builtin.pptx_builder'] as const;

/**
 * **产品默认探针**：内置构建器「依赖就绪」，但**实测支持恒为假**——本入口不代签任何实测结论
 * （R233 / R240）。要声称某能力已实测，必须由真实执行器接入后注入探针。
 */
function defaultProbes(): DiscoveryProbes {
  return conservativeProbes({ readyAdapters: [...DEFAULT_READY_ADAPTERS] });
}

// ---------------------------------------------------------------------------
// HTTP 工具（自足；不 import http.ts 的私有实现，避免耦合与冲突）
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** 与既有 `DemoError` 同形（稳定 code + 中文说明 + retryable）。 */
function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { code, message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type ParsedBody = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

async function readJson(req: IncomingMessage): Promise<ParsedBody> {
  const raw = await readBody(req);
  if (raw === null) return { ok: false };
  if (raw.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// 请求 / 选项 / 宿主
// ---------------------------------------------------------------------------

export interface PluginRequest {
  readonly method: string;
  readonly pathname: string;
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

export interface PluginRoutesOptions {
  /**
   * **持久安装状态存储**（注入式）。模板平台的安装 / 启用 / 授权 / 版本状态写进它。
   * 省略或为 `null` 时——**且未注入现成的 `manager`**——本模块整体返回 503
   * `plugin_store_unwired`，**不**退回进程内存冒充持久（R220）。
   */
  readonly store?: InstallStateStore | null;
  /** 现成的安装来源管理器（跨请求共享状态时由装配处构造并注入；优先于 `store`）。 */
  readonly manager?: InstallSourceManager;
  /** 墙上时刻来源（毫秒）。默认 `Date.now()`；测试注入固定值以获得确定性。 */
  readonly now?: () => number;
  /** 当前内核版本（用于安装期兼容性判定）。 */
  readonly kernelVersion?: string;
  /** 依赖 / 实测探针。产品默认：内置构建器就绪、**一律未实测**。 */
  readonly probes?: DiscoveryProbes;
  /** 允许被声明式包引用的**已登记** MCP 适配器 id（默认空 = 一律拒绝任何 MCP 引用，R229）。 */
  readonly allowedMcpAdapters?: readonly string[];
  /** 可用操作清单的默认上限（`?limit=` 可覆盖），默认取内核的 `OPERATION_LIST_DEFAULT_LIMIT`。 */
  readonly defaultOperationLimit?: number;
}

export interface PluginRoutes {
  /** 安装来源管理器（写入通道；持久状态在它里面）。 */
  readonly manager: InstallSourceManager;
  /** 活跃实例版本台账（固定版本；R230）。 */
  readonly freezer: VersionFreezer;
  readonly probes: DiscoveryProbes;
  /** 返回 `true` = 本模块已处理该请求（含它自己发出的错误响应）。 */
  handle(request: PluginRequest): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// 投影：真实清单（不是名字，也不是 prompt）
// ---------------------------------------------------------------------------

/** 一个插件清单的产品投影（七个业务模板 + 三个基础角色**都**用它）。 */
export interface PluginInventoryView {
  readonly plugin_id: string;
  readonly kind: 'business_template' | 'base_role';
  readonly display_name: string;
  readonly version: string;
  readonly kernel_compatibility: { readonly min_version: string; readonly max_version: string | null };
  readonly capabilities: readonly { readonly capability_id: string; readonly label: string }[];
  readonly capability_ids: readonly string[];
  readonly instruction_count: number;
  readonly input_ports: readonly string[];
  readonly output_ports: readonly string[];
  readonly required_adapter_ids: readonly string[];
  readonly optional_adapter_ids: readonly string[];
  readonly permission_ids: readonly string[];
  readonly data_scope: { readonly level: string; readonly detail: string };
  readonly experience: { readonly strategy: string; readonly detail: string };
  readonly install_source_kind: string;
  readonly implementation: 'real' | 'stub';
  readonly is_stub: boolean;
  readonly stub_reason: string | null;
  /** 产出文件格式（仅业务模板可能非空；角色恒为空数组，R232）。 */
  readonly produces_file_formats: readonly string[];
  /** 读取的资料格式（自由字符串，**不是**文件类型枚举）。 */
  readonly consumes_formats: readonly string[];
  /** 运行时身份（仅基础角色非空）。 */
  readonly runtime_identity: string | null;
}

/** 把一份清单投影成产品视图（字段**全部来自清单**，不在此处编造）。 */
export function projectPlugin(manifest: PluginManifest): PluginInventoryView {
  return Object.freeze({
    plugin_id: manifest.plugin_id,
    kind: manifest.kind,
    display_name: manifest.display_name,
    version: manifest.version,
    kernel_compatibility: Object.freeze({
      min_version: manifest.kernel_compatibility.min_version,
      max_version: manifest.kernel_compatibility.max_version,
    }),
    capabilities: Object.freeze(
      manifest.capabilities.map((capability) =>
        Object.freeze({ capability_id: capability.capability_id, label: capability.label }),
      ),
    ),
    capability_ids: Object.freeze(manifest.capabilities.map((capability) => capability.capability_id)),
    instruction_count: manifest.instructions.length,
    input_ports: Object.freeze(manifest.inputs.map((port) => port.name)),
    output_ports: Object.freeze(manifest.outputs.map((port) => port.name)),
    required_adapter_ids: Object.freeze(
      manifest.adapter_dependencies.filter((d) => d.required).map((d) => d.adapter_id),
    ),
    optional_adapter_ids: Object.freeze(
      manifest.adapter_dependencies.filter((d) => !d.required).map((d) => d.adapter_id),
    ),
    permission_ids: Object.freeze(manifest.permissions.map((p) => p.permission_id)),
    data_scope: Object.freeze({ level: manifest.data_scope.level, detail: manifest.data_scope.detail }),
    experience: Object.freeze({
      strategy: manifest.experience_policy.strategy,
      detail: manifest.experience_policy.detail,
    }),
    install_source_kind: manifest.install_source.kind,
    implementation: manifest.implementation,
    is_stub: manifest.implementation === 'stub',
    stub_reason: manifest.stub_reason,
    produces_file_formats:
      manifest.kind === 'business_template' ? manifest.produces_file_formats : Object.freeze([]),
    consumes_formats: manifest.kind === 'business_template' ? manifest.consumes_formats : Object.freeze([]),
    runtime_identity: manifest.kind === 'base_role' ? manifest.runtime_identity : null,
  });
}

// ---------------------------------------------------------------------------
// 五态视图（分开呈现 + 未就绪给原因 + 解锁动作）
// ---------------------------------------------------------------------------

interface UnlockAction {
  readonly state: string;
  readonly action: string;
  readonly reason: string;
}

/** 由五态结果给出**解锁动作**：哪一态为假，就给出推进它的那一步。 */
function unlockActions(discovery: CapabilityDiscovery): readonly UnlockAction[] {
  const out: UnlockAction[] = [];
  if (discovery.stub) {
    out.push(
      Object.freeze({
        state: 'actually_supported',
        action: '无入口动作：stub 实现指认不到承载代码，不得作为可用模板（R233）；须先补齐实现并重新登记清单',
        reason: discovery.stub_reason ?? 'stub 未给出原因',
      }),
    );
  }
  if (!discovery.installed) {
    out.push(
      Object.freeze({
        state: 'installed',
        action: `POST ${R}/${discovery.plugin_id}/install（内置来源）或 POST ${R}/install（声明式包）`,
        reason: '未安装：安装 ≠ 启用，安装后仍需显式启用与授权（R228 三态分开）',
      }),
    );
    return Object.freeze(out);
  }
  if (!discovery.enabled) {
    out.push(
      Object.freeze({
        state: 'enabled',
        action: `POST ${R}/${discovery.plugin_id}/enable`,
        reason: '未启用：停用会阻止新实例（R230）',
      }),
    );
  }
  if (!discovery.authorized) {
    out.push(
      Object.freeze({
        state: 'authorized',
        action: `POST ${R}/${discovery.plugin_id}/authorize`,
        reason: '未授权：授权缺失或已被撤销；撤权即时生效（R230）',
      }),
    );
  }
  if (!discovery.dependencies_ready) {
    const missing = discovery.dependencies.filter((d) => d.required && !d.ready).map((d) => d.adapter_id);
    out.push(
      Object.freeze({
        state: 'dependencies_ready',
        action: `装配缺失的必需适配器：${missing.join('、')}（并由装配处注入就绪探针）`,
        reason: `缺少必需依赖：${missing.join('、')}`,
      }),
    );
  }
  if (!discovery.actually_supported) {
    out.push(
      Object.freeze({
        state: 'actually_supported',
        action: '由真实执行器完成一次实测并登记证据（本入口**不代签**实测结论，R233/R240）',
        reason: '未实测支持：探针未确认该能力已被真实执行器验证',
      }),
    );
  }
  return Object.freeze(out);
}

/** 列表用的**紧凑**五态（只给布尔与为假的态）。 */
function fiveStateSummary(discovery: CapabilityDiscovery): unknown {
  const vector = stateVector(discovery);
  return {
    states: vector.states,
    ready: vector.ready,
    false_states: vector.false_states,
    stub: vector.stub,
    stub_reason: vector.stub_reason,
  };
}

/** 详情用的**完整**五态（布尔 + 未就绪原因 + 解锁动作 + 逐条依赖诊断）。 */
function fiveStateDetail(discovery: CapabilityDiscovery): unknown {
  const vector = stateVector(discovery);
  return {
    states: vector.states,
    ready: vector.ready,
    false_states: vector.false_states,
    not_ready_reasons: vector.not_ready_reasons,
    unlock_actions: unlockActions(discovery),
    stub: vector.stub,
    stub_reason: vector.stub_reason,
    dependencies: discovery.dependencies,
  };
}

// ---------------------------------------------------------------------------
// 宿主
// ---------------------------------------------------------------------------

export function createPluginRoutes(options: PluginRoutesOptions = {}): PluginRoutes {
  const manager: InstallSourceManager =
    options.manager ??
    createInstallSourceManager({
      // 未注入 store ⇒ 这里构造的是**无介质**的管理器；调用方**不得**使用它落状态。
      // 之所以仍能构造，是为了让类型与只读投影可用；真实产品路径由下面的 503 闸门拦住。
      ...(options.store === undefined || options.store === null ? {} : { store: options.store }),
      ...(options.kernelVersion === undefined ? {} : { kernelVersion: options.kernelVersion }),
    });
  const registry: PluginRegistry = manager.pluginRegistry;
  const probes = options.probes ?? defaultProbes();
  const freezer = new VersionFreezer(registry);
  const now = options.now ?? ((): number => Date.now());
  const allowedMcpAdapters = options.allowedMcpAdapters ?? [];
  const defaultLimit = options.defaultOperationLimit ?? OPERATION_LIST_DEFAULT_LIMIT;
  const at = (): LogicalTime => asLogicalTime(now());

  // -------------------------------------------------------------------------
  // 解析辅助
  // -------------------------------------------------------------------------

  const requireManifest = (pluginId: string): PluginManifest | null => registry.manifestOf(pluginId) ?? null;

  const parseActiveTasks = (
    raw: unknown,
    pluginId: string,
  ): { ok: true; value: readonly ActiveTaskRef[] } | { ok: false; detail: string } => {
    if (raw === undefined || raw === null) return { ok: true, value: Object.freeze([]) };
    if (!Array.isArray(raw)) return { ok: false, detail: 'activeTasks 必须是数组' };
    const manifest = requireManifest(pluginId);
    const fallbackVersion = manager.pluginRegistry.recordOf(pluginId)?.version ?? manifest?.version ?? '0.0.0';
    const tasks: ActiveTaskRef[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      const entry = raw[index];
      if (!isRecord(entry)) return { ok: false, detail: `activeTasks[${String(index)}] 不是对象` };
      const taskId = asString(entry['taskId']) ?? asString(entry['task_id']);
      const instanceId = asString(entry['instanceId']) ?? asString(entry['instance_id']);
      const state = asString(entry['state']);
      if (taskId === null || instanceId === null) {
        return { ok: false, detail: `activeTasks[${String(index)}] 需要 taskId 与 instanceId` };
      }
      if (state !== 'running' && state !== 'paused') {
        return { ok: false, detail: `activeTasks[${String(index)}].state 必须是 running | paused` };
      }
      const dispositionRaw = asString(entry['disposition']);
      if (dispositionRaw !== null && !(TASK_DISPOSITIONS as readonly string[]).includes(dispositionRaw)) {
        return {
          ok: false,
          detail: `activeTasks[${String(index)}].disposition 必须是 ${TASK_DISPOSITIONS.join(' | ')} 之一`,
        };
      }
      const version = asString(entry['version']) ?? fallbackVersion;
      tasks.push(
        Object.freeze({
          task_id: asTaskId(taskId),
          instance_id: instanceId,
          plugin_id: pluginId as ActiveTaskRef['plugin_id'],
          version,
          state,
          // 关键：**不**替调用方挑默认处置——省略即 `undefined`，由 uninstall-flow 判为阻塞。
          ...(dispositionRaw === null ? {} : { disposition: dispositionRaw as TaskDispositionKind }),
        }),
      );
    }
    return { ok: true, value: Object.freeze(tasks) };
  };

  const uninstallInputOf = (
    pluginId: string,
    body: Record<string, unknown>,
  ): { ok: true; value: Parameters<typeof planUninstallFlow>[0] } | { ok: false; detail: string } => {
    const tasks = parseActiveTasks(body['activeTasks'], pluginId);
    if (!tasks.ok) return tasks;
    const producedRaw = body['producedFiles'];
    if (producedRaw !== undefined && producedRaw !== null && !Array.isArray(producedRaw)) {
      return { ok: false, detail: 'producedFiles 必须是数组' };
    }
    const producedFiles = (Array.isArray(producedRaw) ? producedRaw : []).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const fileId = asString(entry['fileId']) ?? asString(entry['file_id']);
      if (fileId === null) return [];
      return [Object.freeze({ file_id: fileId, label: asString(entry['label']) ?? fileId })];
    });
    const experiencesRaw = body['experiences'];
    if (experiencesRaw !== undefined && experiencesRaw !== null && !Array.isArray(experiencesRaw)) {
      return { ok: false, detail: 'experiences 必须是数组' };
    }
    const experiences = (Array.isArray(experiencesRaw) ? experiencesRaw : []).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const experienceId = asString(entry['experienceId']) ?? asString(entry['experience_id']);
      if (experienceId === null) return [];
      return [Object.freeze({ experience_id: experienceId, lesson: asString(entry['lesson']) ?? experienceId })];
    });
    const effectsRaw = body['externalEffects'];
    if (effectsRaw !== undefined && effectsRaw !== null && !Array.isArray(effectsRaw)) {
      return { ok: false, detail: 'externalEffects 必须是数组' };
    }
    const externalEffects: ExternalEffect[] = (Array.isArray(effectsRaw) ? effectsRaw : []).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const effectId = asString(entry['effectId']) ?? asString(entry['effect_id']);
      if (effectId === null) return [];
      return [
        Object.freeze({
          effect_id: effectId,
          description: asString(entry['description']) ?? effectId,
          reversible: entry['reversible'] === true,
        }),
      ];
    });
    return {
      ok: true,
      value: {
        registry,
        plugin_id: pluginId,
        at: at(),
        active_tasks: tasks.value,
        produced_files: Object.freeze(producedFiles),
        experiences: Object.freeze(experiences),
        external_effects: Object.freeze(externalEffects),
      },
    };
  };

  const assetDecisionsOf = (body: Record<string, unknown>): readonly RetainedAssetDecision[] =>
    Object.freeze(
      (Array.isArray(body['assetDecisions']) ? body['assetDecisions'] : []).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const assetId = asString(entry['assetId']) ?? asString(entry['asset_id']);
        const action = asString(entry['action']);
        if (assetId === null || (action !== 'keep' && action !== 'discard')) return [];
        return [Object.freeze({ asset_id: assetId, action })];
      }),
    );

  // -------------------------------------------------------------------------
  // 路由：读
  // -------------------------------------------------------------------------

  const handleList = (res: ServerResponse): void => {
    const plugins = PLUGIN_CATALOG.flatMap((manifest) => {
      const discovery = registry.discover(manifest.plugin_id, probes);
      if (discovery === undefined) return [];
      return [
        Object.freeze({
          plugin_id: manifest.plugin_id,
          kind: manifest.kind,
          display_name: manifest.display_name,
          version: manifest.version,
          implementation: manifest.implementation,
          is_stub: manifest.implementation === 'stub',
          capability_ids: manifest.capabilities.map((capability) => capability.capability_id),
          required_adapter_ids: manifest.adapter_dependencies.filter((d) => d.required).map((d) => d.adapter_id),
          permission_ids: manifest.permissions.map((p) => p.permission_id),
          data_scope_level: manifest.data_scope.level,
          experience_strategy: manifest.experience_policy.strategy,
          produces_file_formats: manifest.kind === 'business_template' ? manifest.produces_file_formats : [],
          runtime_identity: manifest.kind === 'base_role' ? manifest.runtime_identity : null,
          five_state: fiveStateSummary(discovery),
        }),
      ];
    });
    const templates = plugins.filter((entry) => entry.kind === 'business_template').length;
    sendJson(res, 200, {
      ok: true,
      root: R,
      counts: { business_templates: templates, base_roles: plugins.length - templates, total: plugins.length },
      plugins,
      note:
        '这是**真实清单**（版本 / 能力 / 适配器依赖 / 权限 / 数据范围 / 经验策略），不是名字也不是 prompt（R228）。' +
        '五态是五个独立问题，未就绪请取详情看原因与解锁动作。',
    });
  };

  const handleDetail = (pluginId: string, res: ServerResponse): void => {
    const manifest = requireManifest(pluginId);
    if (manifest === null) {
      sendError(res, 404, 'unknown_plugin', `注册目录里没有插件 ${pluginId}（可选：七个 template.* 与三个 role.*）`);
      return;
    }
    const discovery = registry.discover(pluginId, probes);
    if (discovery === undefined) {
      sendError(res, 404, 'unknown_plugin', `注册目录里没有插件 ${pluginId}`);
      return;
    }
    const record = manager.pluginRegistry.recordOf(pluginId);
    const instances = freezer.listFor(pluginId);
    sendJson(res, 200, {
      ok: true,
      inventory: projectPlugin(manifest),
      install_record: record ?? null,
      install_source: manager.sourceOf(pluginId) ?? null,
      five_state: fiveStateDetail(discovery),
      instances: {
        active: instances,
        drift: freezer.driftReport(pluginId),
        note: '活跃实例一经签发即**固定版本**（R230）：停用 / 更新 / 撤权都**不改写**它的版本与签发时刻。',
      },
    });
  };

  const handleAvailableOperations = (url: URL, res: ServerResponse): void => {
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? defaultLimit : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) {
      sendError(res, 400, 'invalid_limit', `limit 必须是 ≥ 1 的整数，收到 ${String(rawLimit)}`);
      return;
    }
    try {
      const bounded = readAvailableOperations(registry, probes, { limit });
      sendJson(res, 200, {
        ok: true,
        ...bounded,
        instruction_leaks: findInstructionLeaks(bounded.entries, PLUGIN_CATALOG),
        note:
          '按需读取：**只给就绪插件的能力标签**，不含指令全文（R231）；超过 limit 时显式截断，' +
          'omitted_count = total_available - entries.length。',
      });
    } catch (error) {
      sendError(res, 400, 'invalid_limit', error instanceof Error ? error.message : String(error));
    }
  };

  // -------------------------------------------------------------------------
  // 路由：写
  // -------------------------------------------------------------------------

  const handleBuiltinInstall = (pluginId: string, res: ServerResponse): void => {
    if (requireManifest(pluginId) === null) {
      sendError(res, 404, 'unknown_plugin', `注册目录里没有插件 ${pluginId}`);
      return;
    }
    const result = manager.install(pluginId, at());
    if (!result.ok) {
      sendJson(res, result.reason === 'unknown_plugin' ? 404 : 409, {
        code: result.reason,
        message: result.detail,
        retryable: false,
      });
      return;
    }
    manager.persist();
    sendJson(res, 201, {
      ok: true,
      persisted: true,
      record: result.record,
      note: '安装 ≠ 启用：启用必须显式发生（R228 三态分开）。',
    });
  };

  const handleDeclarativeInstall = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const parsed = await readJson(req);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象（声明式包本体或 { package }）');
      return;
    }
    const raw = isRecord(parsed.value['package']) ? parsed.value['package'] : parsed.value;
    // **先校验后落状态**：校验失败一个字节都不落（R229）。
    const result = manager.installDeclarativePackage(raw, at(), { allowed_mcp_adapters: allowedMcpAdapters });
    if (!result.ok) {
      sendJson(res, 400, {
        code: 'package_rejected',
        message: `声明式包被拒绝安装：${result.issues.map((issue: PackageValidationIssue) => describePackageIssue(issue)).join('；')}`,
        retryable: false,
        issues: result.issues.map((issue) => ({ ...issue, formatted: describePackageIssue(issue) })),
        persisted: false,
        note: 'exec / postinstall / 任意 MCP 端点 URL 一律拒绝，且逐条具名报因（R229）。',
      });
      return;
    }
    manager.persist();
    sendJson(res, 201, {
      ok: true,
      persisted: true,
      record: result.record,
      note: '声明式包默认**未启用、未授权**：授权与启用都必须显式发生。',
    });
  };

  const handleSimpleTransition = (
    pluginId: string,
    action: 'enable' | 'disable' | 'authorize' | 'revoke',
    res: ServerResponse,
  ): void => {
    if (requireManifest(pluginId) === null) {
      sendError(res, 404, 'unknown_plugin', `注册目录里没有插件 ${pluginId}`);
      return;
    }
    try {
      const record =
        action === 'enable'
          ? manager.enable(pluginId, at())
          : action === 'disable'
            ? manager.disable(pluginId, at())
            : action === 'authorize'
              ? manager.pluginRegistry.authorize(pluginId, at())
              : manager.pluginRegistry.revokeAuthorization(pluginId, at());
      manager.persist();
      sendJson(res, 200, {
        ok: true,
        persisted: true,
        action,
        record,
        note:
          action === 'revoke'
            ? '撤权**即时**生效：下一次新建实例会被拒（原因含"未授权"），不需要重启（R230）。'
            : action === 'disable'
              ? '停用**阻止新实例**；活跃实例的既有固定绑定不受影响（R230）。'
              : '状态已持久化。',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, error instanceof ValidationError ? 409 : 400, {
        code: error instanceof ValidationError ? 'illegal_transition' : 'invalid_request',
        message,
        retryable: false,
      });
    }
  };

  const handleUninstall = async (
    pluginId: string,
    planOnly: boolean,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (requireManifest(pluginId) === null) {
      sendError(res, 404, 'unknown_plugin', `注册目录里没有插件 ${pluginId}`);
      return;
    }
    const parsed = await readJson(req);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
      return;
    }
    const input = uninstallInputOf(pluginId, parsed.value);
    if (!input.ok) {
      sendError(res, 400, 'invalid_body', input.detail);
      return;
    }

    // **先判后写**：计划里只要还有未显式处置的活跃实例，就**不改任何持久状态**。
    const plan = planUninstallFlow(input.value);
    if (planOnly) {
      sendJson(res, 200, { ok: true, plan });
      return;
    }
    if (plan.blocked) {
      sendJson(res, 409, {
        code: 'uninstall_blocked',
        message: plan.blocking_reasons.join('；'),
        retryable: false,
        status: 'blocked',
        blocked: true,
        blocking_reasons: plan.blocking_reasons,
        unhandled_instances: plan.unhandled_instances,
        plan,
        persisted: false,
        stub: true,
        realExecutor: false,
        note: '卸载**不在任务中途改规则**，也不允许把进行中的实例留在后台无人看管（R230）。',
      });
      return;
    }
    try {
      const outcome = applyUninstallFlow({
        ...input.value,
        asset_decisions: assetDecisionsOf(parsed.value),
      });
      manager.persist();
      sendJson(res, 200, {
        ok: true,
        persisted: true,
        ...outcome,
        note: '卸载**不撤销**任何已发生的外部动作（external_actions_reverted 恒为 false）。',
      });
    } catch (error) {
      sendJson(res, error instanceof ValidationError ? 409 : 400, {
        code: error instanceof ValidationError ? 'uninstall_rejected' : 'invalid_request',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        persisted: false,
      });
    }
  };

  const handleInstanceIssue = async (
    pluginId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const manifest = requireManifest(pluginId);
    if (manifest === null) {
      sendError(res, 404, 'unknown_plugin', `注册目录里没有插件 ${pluginId}`);
      return;
    }
    const parsed = await readJson(req);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象（{ instanceId }）');
      return;
    }
    const instanceId = asString(parsed.value['instanceId']);
    if (instanceId === null) {
      sendError(res, 400, 'invalid_body', '缺少 instanceId（非空字符串）');
      return;
    }
    try {
      // `issue()` 内部走注册表闸门：未安装 / 未启用 / 未授权 / 依赖缺失 / 未实测 / stub 一律拒。
      const frozen: FrozenInstance = freezer.issue(pluginId, instanceId, at(), probes);
      sendJson(res, 201, {
        ok: true,
        instance: frozen,
        note: '绑定一经签发即**固定版本**：停用 / 更新 / 撤权都不改写它（R230）。',
      });
    } catch (error) {
      const discovery = registry.discover(pluginId, probes);
      sendJson(res, 409, {
        code: 'instance_rejected',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        reasons: discovery?.not_ready_reasons ?? [],
        states: discovery === undefined ? null : stateVector(discovery).states,
      });
    }
  };

  // -------------------------------------------------------------------------
  // 分发
  // -------------------------------------------------------------------------

  const handle = async (request: PluginRequest): Promise<boolean> => {
    const { method, pathname, req, res } = request;
    if (pathname !== R && !pathname.startsWith(`${R}/`)) {
      return false;
    }
    const segments = pathname
      .slice(R.length)
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
    const isRead = method === 'GET' || method === 'HEAD';

    // 无持久介质 ⇒ 整个模块 503（**不**退回内存冒充持久，R220）。
    if (options.store === undefined || options.store === null) {
      sendJson(res, 503, {
        code: 'plugin_store_unwired',
        message:
          '未注入持久安装状态存储（InstallStateStore）：模板平台的安装 / 启用 / 授权 / 卸载不落任何持久介质；' +
          '按 R220 纪律，本入口**不**退回进程内存冒充持久，全部请求返回 503。',
        retryable: false,
        status: 'not_ready',
        root: R,
        unblockedBy: `在装配处注入持久存储：createPluginRoutes({ store }) 或 handlePluginRequest(req, { store })`,
        reason: '缺少持久端口：没有介质就没有"跨重启保留的安装状态"，因此不提供任何可用性结论。',
        stub: true,
        realExecutor: false,
      });
      return true;
    }

    // -- 列表 --------------------------------------------------------------
    if (segments.length === 0) {
      if (!isRead) {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return true;
      }
      handleList(res);
      return true;
    }

    // -- 可用操作清单（按需读取，长度受限，R231）---------------------------
    if (segments[0] === 'available-operations') {
      if (!isRead) {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return true;
      }
      handleAvailableOperations(request.url, res);
      return true;
    }

    // -- 声明式包安装 -------------------------------------------------------
    if (segments[0] === 'install') {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return true;
      }
      await handleDeclarativeInstall(req, res);
      return true;
    }

    const pluginId = segments[0] as string;
    const tail = segments.slice(1);

    // -- 详情 --------------------------------------------------------------
    if (tail.length === 0) {
      if (!isRead) {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return true;
      }
      handleDetail(pluginId, res);
      return true;
    }

    // -- 内置来源安装 -------------------------------------------------------
    if (tail.length === 1 && tail[0] === 'install') {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return true;
      }
      await handleBuiltinInstall(pluginId, res);
      return true;
    }

    // -- 启用 / 停用 / 授权 / 撤权 -----------------------------------------
    const transition = tail[0];
    if (
      tail.length === 1 &&
      (transition === 'enable' || transition === 'disable' || transition === 'authorize' || transition === 'revoke')
    ) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return true;
      }
      handleSimpleTransition(pluginId, transition, res);
      return true;
    }

    // -- 卸载（计划 / 执行）------------------------------------------------
    if (tail[0] === 'uninstall') {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return true;
      }
      await handleUninstall(pluginId, tail[1] === 'plan', req, res);
      return true;
    }

    // -- 活跃实例（版本固定）-----------------------------------------------
    if (tail.length === 1 && tail[0] === 'instances') {
      if (isRead) {
        const manifest = requireManifest(pluginId);
        if (manifest === null) {
          sendError(res, 404, 'unknown_plugin', `注册目录里没有插件 ${pluginId}`);
          return true;
        }
        sendJson(res, 200, {
          ok: true,
          instances: freezer.listFor(pluginId),
          drift: freezer.driftReport(pluginId),
          note: '冻结绑定与当前版本的偏差会被**如实报告**，但**不改写**任何既有实例（R230）。',
        });
        return true;
      }
      if (method === 'POST') {
        await handleInstanceIssue(pluginId, req, res);
        return true;
      }
      sendError(res, 405, 'method_not_allowed', '该接口只接受 GET / POST');
      return true;
    }

    sendError(res, 404, 'not_found', '没有这个模板平台接口');
    return true;
  };

  return { manager, freezer, probes, handle };
}

// ---------------------------------------------------------------------------
// 便捷入口：按注入的 store / manager 复用同一会话
// ---------------------------------------------------------------------------

/**
 * 会话缓存：**以注入的 store（或现成的 manager）对象身份为键**。
 *
 * 这是为了让 `handlePluginRequest(req, { store })` 这种直接调用也能**跨请求共享**
 * 活跃实例台账（`VersionFreezer` 是进程内状态，靠 `store` 反序列化不了）。
 * 只要装配处每次传同一个 `store` 对象，会话就是同一个——这是注入式设计的自然结果，
 * 不是隐藏的全局状态。
 */
const SESSIONS = new WeakMap<object, PluginRoutes>();

function sessionFor(options: PluginRoutesOptions): PluginRoutes | null {
  const key: object | null | undefined = options.manager ?? options.store;
  if (key === undefined || key === null) {
    return null;
  }
  const cached = SESSIONS.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const created = createPluginRoutes(options);
  SESSIONS.set(key, created);
  return created;
}

/**
 * **产品入口主函数**：处理一个落在 `/api/plugins` 下的请求。
 *
 * @returns `true` = 本模块已处理（`http.ts` 不必再往下走）；`false` = 路径不归本模块管。
 *
 * 未注入 `store` 也未经 `manager` 注入持久端口时，返回 `true` 并写出结构化 503
 * `plugin_store_unwired`——**不**退回内存冒充持久（R220）。
 */
export async function handlePluginRequest(
  request: PluginRequest,
  options: PluginRoutesOptions = {},
): Promise<boolean> {
  if (request.pathname !== PLUGINS_ROOT && !request.pathname.startsWith(`${PLUGINS_ROOT}/`)) {
    return false;
  }
  const routes = sessionFor(options);
  if (routes === null) {
    // 无持久端口：仍由 createPluginRoutes 的同一个 503 分支作答（口径只有一份）。
    return createPluginRoutes(options).handle(request);
  }
  return routes.handle(request);
}

/**
 * 挂载说明（`http.ts` / `main.ts` 由总协调者统一接线，本模块**不改**那两个文件）：
 *
 * ```ts
 * // http.ts —— 在既有的路由分发之前插入（不改任何既有分支）：
 * import { handlePluginRequest, type PluginRequest } from './plugin-routes.js';
 *
 * // 装配处持有同一个 store 对象（例如内核 Store 的落盘实现），跨请求共享会话：
 * const pluginRoutesOptions = { store: pluginInstallStore, now, kernelVersion };
 *
 * // 分发处：
 * if (await handlePluginRequest({ method, pathname, url, req, res }, pluginRoutesOptions)) return;
 * ```
 *
 * 若装配处已有现成的 `InstallSourceManager`，改为 `handlePluginRequest(req, { manager })` 即可；
 * 两者都省略时，本模块对 `/api/plugins/**` 一律返回 503（不是 404，也不是假装可用）。
 */
