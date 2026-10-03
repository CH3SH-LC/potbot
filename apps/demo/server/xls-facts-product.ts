/**
 * 共享事实绑定的表格交付 —— **产品交付链入口**（工作包 FA-XLS-FACTS-PRODUCT；XLS-18 的产品面）。
 *
 * ## 这个文件把什么接进了产品
 *
 * `src/spreadsheets/facts-binding.ts`（XLS-18，任务包 FA-XLS-18-FACTS）已经在**内核**侧
 * 把四件事做成了可核对的机器判据：单元格↔事实键绑定、只更新受影响格、跨模板发布的结构化
 * `not-wired`、以及"应然 vs 实然"的反向对照。但它**只有单测可达**：`apps/**` 里没有任何
 * 产品代码消费它，因此这些能力在产品上"写了等于没写"。本模块是把这条链接到 **HTTP** 的
 * 那一段路由——**只调用** `facts-binding.ts` / `package-assembly.ts` 的既有函数，
 * 不在这里重写任何判定口径（入口表现与内核语义不可能分叉）。
 *
 * ## 端点（全部挂在 {@link XLS_FACTS_ROOT} 下）
 *
 * | 端点 | 语义 | 复用的内核函数 |
 * |---|---|---|
 * | `GET  /status` | 就绪探针（通道接线状态逐条如实报出） | —— |
 * | `POST /sessions` | 开一次交付会话（建表 + 置值 + 绑定 + 图表） | `createSheet` / `setCellValue` / `bindCell` / `createChart` |
 * | `GET  /sessions/:id` | 会话状态（绑定表 / 版本账 / 上次应用报告） | `bindingsForFact` |
 * | `POST /sessions/:id/bind` | 绑一个格到一个事实键 | `bindCell` |
 * | `POST /sessions/:id/facts` | 改共享事实（**只更新受影响格 / 公式 / 图表**） | `applyFactUpdates` |
 * | `POST /sessions/:id/deliver` | 交付真实 .xlsx 字节（可写盘 / 可下载） | `assembleWorkbookPackage` |
 * | `POST /sessions/:id/publish` | 向 docx / pptx 发布同版事实（**未接线 ⇒ 结构化 not-wired**） | `publishSharedFacts` / `listUnwiredTargets` |
 * | `POST /sessions/:id/consistency` | 三处（表格 / 文档 / 演示）版本一致性核对（**不同版本 ⇒ 报冲突**） | {@link checkFactVersionConsistency} |
 * | `POST /sessions/:id/verify` | 反向对照：用"应然"核验"实然"，一次收齐全部违规 | `checkFactUpdateApplication` |
 *
 * ## 五条判据（每条都在 HTTP 出口可核对）
 *
 * 1. **只更新受影响格**：`POST /facts` 的响应里同时给出 `rewritten_cell_keys` 与
 *    `untouched_cell_keys` / `untouched_bound_cell_keys`——无关格清单是**机器可读的**，
 *    不是一句口号（内核 `applyFactUpdates` 直接算出来）。
 * 2. **真实字节**：`POST /deliver` 返回真实 .xlsx 的 base64 + sha256 + 条目数。核验方
 *    （见同名 `.test.ts`）用**本套件自带的独立 ZIP 解析器**读回字节逐格核对——**不复用**
 *    产品自检器（`readWorkbookXlsx`），否则"自产自检"不构成证据。
 * 3. **跨模板发布未接线 ⇒ 结构化 not-wired**：`POST /publish` 的每个目标都带
 *    `wire_state` / `acknowledged` / `reason`，且 `claimed_published` **恒为字面量 `false`**
 *    ——"接口点存在"与"能力已具备"被显式区分。
 * 4. **三处数值同版本**：同一份交付里，同一个事实在 **表格 / 文档(docx) / 演示(pptx)** 三处
 *    承载的版本必须一致；{@link checkFactVersionConsistency} 不一致时**报冲突**，
 *    `resolved` 给 `null`——**绝不静默取其一**。
 * 5. **反向对照**：`POST /verify` 用 `checkFactUpdateApplication` 一次收齐
 *    `unrelated_cell_rewritten` / `stale_update_applied` / `claimed_published_without_wire`
 *    三类违规——三条都必须被检出（同名套件逐条构造）。
 *
 * ## ⚠️ 如实标注（结果不得编造；不夸大）
 *
 * - **未验证**：产出的 .xlsx 是否能在真实 **Excel / WPS（安卓办公套件）**里打开、编辑、
 *   另存 —— 本工作树**未做真机 / 桌面 Office 验证**，一律标"未验证"（见
 *   {@link XLS_FACTS_UNVERIFIED}）。此处交付的是**真实容器字节**，不是"打开成功"。
 * - **绑定元数据不落进容器**：`fact_key` / `version` 是**会话内存状态**，写出的 .xlsx
 *   里只有取值；"绑定表随文件保存"本层**不宣称**（与内核 `checkBindingsSurviveRoundTrip`
 *   的 `binding_metadata_persisted: false` 同一口径）。
 * - **不导入既有 .xlsx**：本模块的会话**从零建**（表数由调用方决定）。R249 未知部件保留
 *   由 `src/session/adapters/xlsx-io.ts` 那条链负责，本模块不重复造。
 * - **发布通道产品路径未接线**：`main.ts` 装配处**不注入任何 `XlsFactsChannelPort`**，
 *   因此产品上 docx / pptx 恒为 `not-wired`。断言"已发布"在本层连**写出来**都写不出来。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { ValidationError, type LogicalTime } from '../../../src/protocol/index.js';
import {
  EMPTY_BINDING_TABLE,
  PUBLICATION_TARGETS,
  applyFactUpdates,
  bindCell,
  bindingsForFact,
  checkFactUpdateApplication,
  listUnwiredTargets,
  publishSharedFacts,
  type CellFactBinding,
  type CrossTemplatePublishPort,
  type FactBindingTable,
  type FactBindingViolation,
  type FactCellUpdate,
  type FactUpdateApplication,
  type FactUpdateObservation,
  type PublicationTarget,
  type SharedFactPublication,
  type TemplatePublicationResult,
} from '../../../src/spreadsheets/facts-binding.js';
import { assembleWorkbookPackage } from '../../../src/spreadsheets/package-assembly.js';
import {
  createChart,
  createSheet,
  createWorkbook,
  getSheet,
  setCellValue,
  type CellValue,
  type ChartSet,
  type ChartSpec,
  type ChartState,
  type RecalcOptions,
  type SheetState,
  type WorkbookState,
} from '../../../src/spreadsheets/index.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 本模块独占的路由根；`http.ts` 只按这个前缀转交。 */
export const XLS_FACTS_ROOT = '/api/xls-facts';

/** 一次请求体的字节上限（表格初始值与事实更新都是小结构，给足余量）。 */
export const MAX_XLS_FACTS_BODY_BYTES = 4 * 1024 * 1024;

/** 会话 id 的合法形状。 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** 未验证清单（如实登记，不写进任何"已完成"的判定）。 */
export const XLS_FACTS_UNVERIFIED: readonly string[] = Object.freeze([
  '真实消费端（Excel / WPS / 安卓办公套件）打开产出的 .xlsx 是否正常显示取值与图表',
  'docx / pptx 侧"同版事实"是否在用户可见处生效（发布通道未接线）',
  '绑定元数据（fact_key / version）随文件保存（本层明确不落进容器）',
]);

/** 发布通道产品路径未接线的统一原因（可核对、可执行）。 */
export const NO_CHANNEL_REASON =
  '未接该模板的"同版事实"发布通道：文档 / 演示池的接线不在本包写权内；' +
  '未接下游前不宣称已在其他模板生效（XLS-18）。';

// ---------------------------------------------------------------------------
// 形状小工具（自足；不 import http.ts 的私有实现，避免耦合）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 收窄成一个非负整数（会话 id 之外的数值字段用它）。 */
function asNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 公式文本的**边界归一化**。
 *
 * 内核 `FormulaValue.text` 的口径是**不含前缀 `=`**（见 `value.ts`）。人类与 Excel 写的是
 * `=A1*A2`；若不归一化，`=A1*A2` 会解析失败、静默变成一个"被阻塞的公式"——那正是
 * "看起来成功、其实错了"的形状。这里剥掉一个前导 `=`，两种写法同解（空公式返回 `null`）。
 */
function normalizeFormulaText(text: string): string | null {
  const normalized = text.startsWith('=') ? text.slice(1) : text;
  return normalized.length === 0 ? null : normalized;
}

/** 把任意输入取值收窄成内核口径的 `CellValue`（公式文本在此归一化）。 */
function normalizeCellValue(value: CellValue): CellValue {
  if (value.kind !== 'formula') return value;
  const normalized = normalizeFormulaText(value.text);
  if (normalized === null || normalized === value.text) return value;
  return Object.freeze({ kind: 'formula' as const, text: normalized });
}

/** 单元格取值的七类判别联合（与 `src/spreadsheets` 的 `CellValue` 同一套词汇）。 */
function readCellValue(raw: unknown): CellValue | null {
  if (!isRecord(raw)) return null;
  switch (raw['kind']) {
    case 'blank':
      return Object.freeze({ kind: 'blank' as const });
    case 'number': {
      const value = raw['value'];
      return typeof value === 'number' && Number.isFinite(value)
        ? Object.freeze({ kind: 'number' as const, value })
        : null;
    }
    case 'text': {
      const value = raw['value'];
      return typeof value === 'string' ? Object.freeze({ kind: 'text' as const, value }) : null;
    }
    case 'boolean': {
      const value = raw['value'];
      return typeof value === 'boolean' ? Object.freeze({ kind: 'boolean' as const, value }) : null;
    }
    case 'date': {
      const epoch = raw['epoch_ms'];
      return typeof epoch === 'number' && Number.isFinite(epoch)
        ? Object.freeze({ kind: 'date' as const, epoch_ms: epoch })
        : null;
    }
    case 'error': {
      const code = raw['code'];
      return typeof code === 'string' && code.length > 0
        ? Object.freeze({ kind: 'error' as const, code: code as never })
        : null;
    }
    case 'formula': {
      const text = raw['text'];
      if (typeof text !== 'string' || text.length === 0) return null;
      const normalized = normalizeFormulaText(text);
      return normalized === null ? null : Object.freeze({ kind: 'formula' as const, text: normalized });
    }
    default:
      return null;
  }
}

/** 建会话时的一格初始取值（`address` 为 A1 记法）。 */
export interface CellInput {
  readonly sheet: string;
  readonly address: string;
  readonly value: CellValue;
}

function readCellInput(raw: unknown): CellInput {
  if (!isRecord(raw)) throw new ValidationError('cells 里每一项都必须是对象');
  const sheet = asString(raw['sheet']);
  const address = asString(raw['address'] ?? raw['ref']);
  if (sheet === null) throw new ValidationError('cells[].sheet 必须是非空字符串');
  if (address === null) throw new ValidationError('cells[].address 必须是非空字符串');
  const value = readCellValue(raw['value']);
  if (value === null) {
    throw new ValidationError(
      'cells[].value 不是合法的单元格取值（只能是 blank / number / text / boolean / date / error / formula）',
    );
  }
  return Object.freeze({ sheet, address, value });
}

function readCellFactBinding(raw: unknown): CellFactBinding {
  if (!isRecord(raw)) throw new ValidationError('bindings 里每一项都必须是对象');
  const sheet = asString(raw['sheet']);
  const ref = asString(raw['ref'] ?? raw['address']);
  const factKey = asString(raw['fact_key'] ?? raw['factKey']);
  const version = asNonNegativeInt(raw['version']);
  if (sheet === null) throw new ValidationError('bindings[].sheet 必须是非空字符串');
  if (ref === null) throw new ValidationError('bindings[].ref 必须是非空字符串（A1 记法）');
  if (factKey === null) throw new ValidationError('bindings[].fact_key 必须是非空字符串');
  if (version === null) throw new ValidationError('bindings[].version 必须是 ≥ 0 的整数');
  return Object.freeze({ sheet, ref, fact_key: factKey, version });
}

function readFactUpdate(raw: unknown): FactCellUpdate {
  if (!isRecord(raw)) throw new ValidationError('updates 里每一项都必须是对象');
  const factKey = asString(raw['fact_key'] ?? raw['factKey']);
  const version = asNonNegativeInt(raw['version']);
  const source = asString(raw['source']);
  const at = raw['at'];
  if (factKey === null) throw new ValidationError('updates[].fact_key 必须是非空字符串');
  if (version === null) throw new ValidationError('updates[].version 必须是 ≥ 0 的整数');
  if (source === null) throw new ValidationError('updates[].source 必须是非空字符串（来源不得缺省）');
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    throw new ValidationError('updates[].at 必须是有限数（逻辑时间由调用方给出，本模块不读墙钟）');
  }
  const value = readCellValue(raw['value']);
  if (value === null) {
    throw new ValidationError(
      'updates[].value 不是合法的单元格取值（只能是 blank / number / text / boolean / date / error / formula）',
    );
  }
  return Object.freeze({ fact_key: factKey, version, value, source, at: at as LogicalTime });
}

function readChartSpec(raw: unknown): ChartSpec {
  if (!isRecord(raw)) throw new ValidationError('charts 里每一项都必须是对象');
  const name = asString(raw['name']);
  const kind = raw['kind'];
  const series = raw['series'];
  if (name === null) throw new ValidationError('charts[].name 必须是非空字符串');
  if (typeof kind !== 'string') throw new ValidationError('charts[].kind 必须是字符串');
  if (!Array.isArray(series)) throw new ValidationError('charts[].series 必须是数组');
  const spec: ChartSpec = {
    name,
    kind: kind as ChartSpec['kind'],
    series: series as ChartSpec['series'],
    ...(raw['title'] === undefined || raw['title'] === null ? {} : { title: String(raw['title']) }),
  };
  return spec;
}

// ---------------------------------------------------------------------------
// ④ 三处数值同版本：一致性核对（不同版本 ⇒ 报冲突，不静默取其一）
// ---------------------------------------------------------------------------

/** 承载同一个共享事实的一份"载体"（表格 / 文档 / 演示）。 */
export type FactCarrier = 'spreadsheet' | 'docx' | 'pptx';

/** 全部载体（顺序固定，保证输出确定性）。 */
export const FACT_CARRIERS: readonly FactCarrier[] = Object.freeze(['spreadsheet', 'docx', 'pptx']);

/** 一条"某载体上某事实的版本"的观测。 */
export interface FactVersionCarrier {
  readonly carrier: FactCarrier;
  readonly fact_key: string;
  readonly version: number;
}

/** 同一个事实在不同载体上的版本不一致。 */
export interface FactVersionConflict {
  readonly fact_key: string;
  /** 各载体的版本（升序按载体名），供人直接读到冲突出现在哪两处。 */
  readonly versions: readonly { readonly carrier: FactCarrier; readonly version: number }[];
  readonly detail: string;
}

/** 一致性核对结论。 */
export interface FactVersionConsistency {
  /** 每个在**多个**载体上出现的事实都版本一致 ⇒ `true`。 */
  readonly consistent: boolean;
  /** 只在**一个**载体上出现的事实（无法比较）——如实列出，**不**当作"一致"。 */
  readonly uncomparable_fact_keys: readonly string[];
  readonly conflicts: readonly FactVersionConflict[];
  /**
   * 事实键 → 版本。一致时给出该版本；**冲突时为 `null`**——本层绝不静默取其一。
   */
  readonly resolved: Readonly<Record<string, number | null>>;
}

/**
 * 核对"同一份交付里三处数值同版本"。
 *
 * 判据：把观测按 `fact_key` 分组；同一个事实在 ≥2 个载体上版本全等 ⇒ 一致；
 * 出现 ≥2 个不同版本 ⇒ **报冲突**（`resolved[fact_key] = null`），并在 `detail` 里点名
 * 是哪几处不同。只在单载体上出现的事实记入 `uncomparable_fact_keys`——**不冒充一致**。
 *
 * @throws {ValidationError} 版本不是 ≥ 0 的整数 / fact_key 为空（形状问题，不假装核对过）
 */
export function checkFactVersionConsistency(
  carriers: readonly FactVersionCarrier[],
): FactVersionConsistency {
  const byFact = new Map<string, Map<FactCarrier, number>>();
  for (const carrier of carriers) {
    const factKey = asString(carrier.fact_key);
    if (factKey === null) throw new ValidationError('FactVersionCarrier.fact_key 必须是非空字符串');
    if (!FACT_CARRIERS.includes(carrier.carrier)) {
      throw new ValidationError(`未知的载体 ${JSON.stringify(String(carrier.carrier))}`);
    }
    const version = asNonNegativeInt(carrier.version);
    if (version === null) {
      throw new ValidationError(`事实 ${factKey} 的版本必须是 ≥ 0 的整数（收到 ${String(carrier.version)}）`);
    }
    const bucket = byFact.get(factKey) ?? new Map<FactCarrier, number>();
    bucket.set(carrier.carrier, version);
    byFact.set(factKey, bucket);
  }

  const conflicts: FactVersionConflict[] = [];
  const uncomparable: string[] = [];
  const resolved: Record<string, number | null> = Object.create(null) as Record<string, number | null>;
  const factKeys = [...byFact.keys()].sort();

  for (const factKey of factKeys) {
    const bucket = byFact.get(factKey) as Map<FactCarrier, number>;
    const observed = [...bucket.entries()]
      .map(([carrier, version]) => Object.freeze({ carrier, version }))
      .sort((left, right) => (left.carrier < right.carrier ? -1 : left.carrier > right.carrier ? 1 : 0));
    const distinct = new Set(observed.map((item) => item.version));
    if (observed.length < 2) {
      uncomparable.push(factKey);
      // 单载体：版本就是它自己（不冒充"三方一致"，但也不算冲突）。
      resolved[factKey] = observed[0]?.version ?? null;
      continue;
    }
    if (distinct.size === 1) {
      resolved[factKey] = observed[0]?.version ?? null;
      continue;
    }
    resolved[factKey] = null;
    conflicts.push(
      Object.freeze({
        fact_key: factKey,
        versions: Object.freeze(observed),
        detail:
          `事实 ${factKey} 在三处载体上的版本不一致（` +
          observed.map((item) => `${item.carrier}=v${String(item.version)}`).join('、') +
          '）：同一份交付里同一事实必须同版本，本层报冲突而不静默取其一',
      }),
    );
  }

  return Object.freeze({
    consistent: conflicts.length === 0,
    uncomparable_fact_keys: Object.freeze(uncomparable),
    conflicts: Object.freeze(conflicts),
    resolved: Object.freeze(resolved),
  });
}

// ---------------------------------------------------------------------------
// ③ 跨模板发布通道端口（产品路径不注入 ⇒ 结构化 not-wired）
// ---------------------------------------------------------------------------

/**
 * 一个目标的发布通道（docx / pptx）。
 *
 * 产品路径**不注入任何实现**（{@link createXlsFactsHost} 的 `channels` 缺省为空）：
 * 因此 `publishSharedFacts` 对两个目标都给出结构化 `not-wired`。测试夹具可注入替身，
 * 用来核对"接线后也只记受理回执、`claimed_published` 仍恒 false"，以及"通道报的是旧版本 ⇒
 * 一致性核对抓得到"。
 */
export interface XlsFactsChannelPort extends CrossTemplatePublishPort {
  /**
   * 该通道当前**承载**的某事实版本（用于一致性核对）；不提供 / 未知时返回 `null`。
   *
   * 这不是"能从下游读回"的承诺——它只是把通道自己声明的版本摆到一致性核对里；
   * 未接线通道没有它，于是那处载体不出现在核对输入里（如实标 `uncomparable`）。
   */
  readonly carrier_version?: (factKey: string) => number | null;
}

// ---------------------------------------------------------------------------
// 会话状态
// ---------------------------------------------------------------------------

interface XlsFactsSession {
  readonly sessionId: string;
  workbook: WorkbookState;
  table: FactBindingTable;
  charts: readonly ChartSet[];
  /** 每个事实键最近一次**被接受**的版本（表格侧载体版本）。 */
  readonly versions: Map<string, number>;
  /** 每个事实键最近一次发布的载荷（供 publish 复用同版取值）。 */
  readonly publications: Map<string, SharedFactPublication>;
  lastApplication: FactUpdateApplication | null;
  deliveryCount: number;
  lastDelivery: { readonly content_digest: string; readonly entry_count: number; readonly byte_length: number } | null;
  lastPublish: readonly TemplatePublicationResult[] | null;
}

/** 会话状态的可序列化视图（HTTP 响应用）。 */
export interface XlsFactsSessionView {
  readonly sessionId: string;
  readonly sheets: readonly string[];
  readonly bindings: readonly CellFactBinding[];
  readonly versions: Readonly<Record<string, number>>;
  readonly charts: readonly string[];
  readonly deliveryCount: number;
  readonly lastDelivery: XlsFactsSession['lastDelivery'];
  readonly appliedFactKeys: readonly string[];
  readonly rejectedFactKeys: readonly string[];
}

// ---------------------------------------------------------------------------
// 宿主
// ---------------------------------------------------------------------------

export interface XlsFactsHostOptions {
  /** 发布通道（产品路径不注入 ⇒ 两个目标恒 `not-wired`）。 */
  readonly channels?: readonly XlsFactsChannelPort[];
  /** 重算选项（如 `TODAY()` 的当前日期）；缺省不带。 */
  readonly recalc?: RecalcOptions;
}

/** 会话创建输入。 */
export interface CreateXlsFactsSessionInput {
  readonly sessionId: string;
  readonly sheets?: readonly string[];
  readonly cells?: readonly CellInput[];
  readonly bindings?: readonly CellFactBinding[];
  readonly charts?: readonly ChartSpec[];
}

/** 交付视图（真实字节以 base64 返回，核验方自行读回）。 */
export interface XlsFactsDeliveryView {
  readonly sessionId: string;
  readonly contentDigest: string;
  readonly entryCount: number;
  readonly byteLength: number;
  readonly partPaths: readonly string[];
  readonly fileBase64: string;
  /** **恒为 `false`**：绑定元数据不落进容器（与内核同一口径）。 */
  readonly binding_metadata_persisted: false;
}

/** 发布视图。 */
export interface XlsFactsPublishView {
  readonly sessionId: string;
  readonly sourceDigest: string;
  readonly artifactRevision: string;
  readonly results: readonly TemplatePublicationResult[];
  readonly unwiredTargets: readonly PublicationTarget[];
  /** **恒为字符量 `false`**：本层不宣称"已在文档 / 演示里生效"。 */
  readonly claimedPublished: false;
  readonly consistency: FactVersionConsistency;
}

export interface XlsFactsHost {
  readonly root: string;
  readonly channels: readonly XlsFactsChannelPort[];
  createSession(input: CreateXlsFactsSessionInput): XlsFactsSessionView;
  getSession(sessionId: string): XlsFactsSessionView | undefined;
  bind(sessionId: string, binding: CellFactBinding): XlsFactsSessionView | undefined;
  applyFacts(sessionId: string, updates: readonly FactCellUpdate[]): FactUpdateApplication | undefined;
  deliver(sessionId: string): XlsFactsDeliveryView | undefined;
  publish(
    sessionId: string,
    request: { readonly factKeys: readonly string[]; readonly artifactRevision: string },
  ): Promise<XlsFactsPublishView | undefined>;
  consistency(
    sessionId: string,
    extraCarriers: readonly FactVersionCarrier[],
  ): FactVersionConsistency | undefined;
  verify(sessionId: string, observation: FactUpdateObservation): readonly FactBindingViolation[] | undefined;
}

function workbookOf(sheets: readonly string[], cells: readonly CellInput[]): WorkbookState {
  const names = sheets.length > 0 ? [...sheets] : ['Sheet1'];
  const built: SheetState[] = names.map((name) => createSheet(name));
  let workbook = createWorkbook(built);
  for (const cell of cells) {
    const sheet = getSheet(workbook, cell.sheet);
    if (sheet === undefined) {
      throw new ValidationError(
        `cells 引用了不存在的工作表 ${JSON.stringify(cell.sheet)}（现有：${names.map((n) => JSON.stringify(n)).join('、')}）`,
      );
    }
    const next = setCellValue(sheet, cell.address, normalizeCellValue(cell.value));
    workbook = createWorkbook(workbook.sheets.map((item) => (item.name === cell.sheet ? next : item)));
  }
  return workbook;
}

function chartsOf(workbook: WorkbookState, specs: readonly ChartSpec[]): readonly ChartSet[] {
  const bySheet = new Map<string, ChartState[]>();
  for (const spec of specs) {
    const chart = createChart(workbook, spec);
    const firstRef = chart.series[0]?.values.sheet;
    const sheetName = firstRef ?? workbook.sheets[0]?.name;
    if (sheetName === undefined) {
      throw new ValidationError('图表必须引用一张已存在的工作表');
    }
    const bucket = bySheet.get(sheetName) ?? [];
    bucket.push(chart);
    bySheet.set(sheetName, bucket);
  }
  const out: ChartSet[] = [];
  for (const [sheet, charts] of bySheet) {
    out.push(Object.freeze({ sheet, charts: Object.freeze(charts) }));
  }
  return Object.freeze(out);
}

/** 交付：把会话工作簿（含图表）组装成真实 .xlsx 字节，并登记交付摘要。 */
function deliverOf(session: XlsFactsSession): XlsFactsDeliveryView {
  const assembled = assembleWorkbookPackage(
    session.workbook,
    session.charts.length > 0 ? { charts: session.charts } : {},
  );
  const bytes = Buffer.from(assembled.bytes);
  session.deliveryCount += 1;
  session.lastDelivery = Object.freeze({
    content_digest: assembled.content_digest,
    entry_count: assembled.entry_count,
    byte_length: bytes.byteLength,
  });
  return Object.freeze({
    sessionId: session.sessionId,
    contentDigest: assembled.content_digest,
    entryCount: assembled.entry_count,
    byteLength: bytes.byteLength,
    partPaths: Object.freeze([...assembled.part_paths]),
    fileBase64: bytes.toString('base64'),
    binding_metadata_persisted: false as const,
  });
}

/** 表格侧载体：每个事实键在绑定表里出现的**最高**版本。 */
function spreadsheetCarriers(session: XlsFactsSession): FactVersionCarrier[] {
  const carriers: FactVersionCarrier[] = [];
  for (const binding of session.table.bindings) {
    const known = session.versions.get(binding.fact_key);
    const version = known ?? binding.version;
    carriers.push({ carrier: 'spreadsheet', fact_key: binding.fact_key, version });
  }
  return carriers;
}

function viewOf(session: XlsFactsSession): XlsFactsSessionView {
  const versions: Record<string, number> = {};
  for (const key of [...session.versions.keys()].sort()) {
    versions[key] = session.versions.get(key) as number;
  }
  const charts: string[] = [];
  for (const set of session.charts) {
    for (const chart of set.charts) charts.push(`${set.sheet}!${chart.name}`);
  }
  charts.sort();
  return Object.freeze({
    sessionId: session.sessionId,
    sheets: Object.freeze(session.workbook.sheets.map((sheet) => sheet.name)),
    bindings: Object.freeze([...session.table.bindings]),
    versions: Object.freeze(versions),
    charts: Object.freeze(charts),
    deliveryCount: session.deliveryCount,
    lastDelivery: session.lastDelivery,
    appliedFactKeys: Object.freeze(
      session.lastApplication === null ? [] : [...session.lastApplication.applied_fact_keys],
    ),
    rejectedFactKeys: Object.freeze(
      session.lastApplication === null
        ? []
        : session.lastApplication.rejected.map((entry) => entry.fact_key),
    ),
  });
}

/** 建一个表格事实交付宿主。产品路径用 `createXlsFactsHost({})`（无通道 ⇒ 发布恒 not-wired）。 */
export function createXlsFactsHost(options: XlsFactsHostOptions = {}): XlsFactsHost {
  const channels = options.channels ?? [];
  const sessions = new Map<string, XlsFactsSession>();

  function requireSession(sessionId: string): XlsFactsSession | undefined {
    return sessions.get(sessionId);
  }

  return {
    root: XLS_FACTS_ROOT,
    channels,
    createSession(input: CreateXlsFactsSessionInput): XlsFactsSessionView {
      if (!SAFE_ID.test(input.sessionId)) {
        throw new ValidationError('sessionId 必须是 1–128 位安全字符（A-Za-z0-9._-）');
      }
      if (sessions.has(input.sessionId)) {
        throw new ValidationError(`会话 ${input.sessionId} 已存在（本模块不覆盖既有交付会话）`);
      }
      const workbook = workbookOf(input.sheets ?? [], input.cells ?? []);
      let table: FactBindingTable = EMPTY_BINDING_TABLE;
      for (const binding of input.bindings ?? []) {
        if (getSheet(workbook, binding.sheet) === undefined) {
          throw new ValidationError(
            `绑定 ${binding.sheet}!${binding.ref} 指向不存在的工作表（绑定不得悬空）`,
          );
        }
        table = bindCell(table, binding);
      }
      const charts = chartsOf(workbook, input.charts ?? []);
      const session: XlsFactsSession = {
        sessionId: input.sessionId,
        workbook,
        table,
        charts,
        versions: new Map(),
        publications: new Map(),
        lastApplication: null,
        deliveryCount: 0,
        lastDelivery: null,
        lastPublish: null,
      };
      sessions.set(input.sessionId, session);
      return viewOf(session);
    },
    getSession(sessionId: string): XlsFactsSessionView | undefined {
      const session = requireSession(sessionId);
      return session === undefined ? undefined : viewOf(session);
    },
    bind(sessionId: string, binding: CellFactBinding): XlsFactsSessionView | undefined {
      const session = requireSession(sessionId);
      if (session === undefined) return undefined;
      if (getSheet(session.workbook, binding.sheet) === undefined) {
        throw new ValidationError(
          `绑定 ${binding.sheet}!${binding.ref} 指向不存在的工作表（绑定不得悬空）`,
        );
      }
      session.table = bindCell(session.table, binding);
      return viewOf(session);
    },
    applyFacts(sessionId: string, updates: readonly FactCellUpdate[]): FactUpdateApplication | undefined {
      const session = requireSession(sessionId);
      if (session === undefined) return undefined;
      const application = applyFactUpdates({
        workbook: session.workbook,
        table: session.table,
        updates,
        charts: session.charts,
        ...(options.recalc === undefined ? {} : { recalc: options.recalc }),
      });
      session.workbook = application.workbook;
      session.table = application.table;
      session.lastApplication = application;
      for (const key of application.applied_fact_keys) {
        const update = updates.find((item) => item.fact_key === key);
        if (update !== undefined) {
          session.versions.set(key, update.version);
          session.publications.set(
            key,
            Object.freeze({
              fact_key: key,
              value: update.value,
              version: update.version,
              source: update.source,
              at: update.at,
            }),
          );
        }
      }
      return application;
    },
    deliver(sessionId: string): XlsFactsDeliveryView | undefined {
      const session = requireSession(sessionId);
      return session === undefined ? undefined : deliverOf(session);
    },
    async publish(
      sessionId: string,
      request: { readonly factKeys: readonly string[]; readonly artifactRevision: string },
    ): Promise<XlsFactsPublishView | undefined> {
      const session = requireSession(sessionId);
      if (session === undefined) return undefined;
      if (request.factKeys.length === 0) {
        throw new ValidationError('factKeys 不能为空（没有要发布的事实就不要发起发布）');
      }
      const publications: SharedFactPublication[] = [];
      for (const key of request.factKeys) {
        const publication = session.publications.get(key);
        if (publication === undefined) {
          throw new ValidationError(
            `事实 ${key} 还没有被应用过（没有可发布的同版取值）：请先经 /facts 应用该事实`,
          );
        }
        publications.push(publication);
      }
      const results = await publishSharedFacts({ channels, publications });
      session.lastPublish = results;

      // 一致性核对：表格侧载体 + 已接线通道自报的载体版本（未接线通道不出现 ⇒ uncomparable）。
      const carriers: FactVersionCarrier[] = spreadsheetCarriers(session);
      for (const channel of channels) {
        if (channel.carrier_version === undefined) continue;
        for (const publication of publications) {
          const version = channel.carrier_version(publication.fact_key);
          if (version === null) continue;
          carriers.push({ carrier: channel.target, fact_key: publication.fact_key, version });
        }
      }
      const consistency = checkFactVersionConsistency(carriers);

      // 交付摘要就是 source_digest：发布必须说得清"引用的是哪一版字节"。
      const delivered = deliverOf(session);
      return Object.freeze({
        sessionId,
        sourceDigest: delivered.contentDigest,
        artifactRevision: request.artifactRevision,
        results,
        unwiredTargets: listUnwiredTargets(results),
        claimedPublished: false as const,
        consistency,
      });
    },
    consistency(
      sessionId: string,
      extraCarriers: readonly FactVersionCarrier[],
    ): FactVersionConsistency | undefined {
      const session = requireSession(sessionId);
      if (session === undefined) return undefined;
      return checkFactVersionConsistency([...spreadsheetCarriers(session), ...extraCarriers]);
    },
    verify(
      sessionId: string,
      observation: FactUpdateObservation,
    ): readonly FactBindingViolation[] | undefined {
      const session = requireSession(sessionId);
      if (session === undefined) return undefined;
      if (session.lastApplication === null) {
        throw new ValidationError('本会话还没有应用过任何事实更新：没有"应然"可比对（先调 /facts）');
      }
      return checkFactUpdateApplication(session.lastApplication, observation);
    },
  };
}

// ---------------------------------------------------------------------------
// 纯路由核心（不碰 node:http，便于直接单测）
// ---------------------------------------------------------------------------

export interface XlsFactsWireRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

export interface XlsFactsWireResponse {
  readonly status: number;
  readonly body: unknown;
}

/** 本命名空间是否归本模块管（挂载点的可判前缀）。 */
export function isXlsFactsPath(pathname: string): boolean {
  return pathname === XLS_FACTS_ROOT || pathname.startsWith(`${XLS_FACTS_ROOT}/`);
}

function ok(body: unknown, status = 200): XlsFactsWireResponse {
  return Object.freeze({ status, body });
}

function fail(status: number, code: string, message: string): XlsFactsWireResponse {
  return Object.freeze({ status, body: Object.freeze({ code, message, retryable: false }) });
}

function segmentsOf(pathname: string): readonly string[] {
  const rest = pathname.slice(XLS_FACTS_ROOT.length).replace(/^\/+/, '').replace(/\/+$/, '');
  return rest === '' ? [] : rest.split('/');
}

function decodeId(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  try {
    const decoded = decodeURIComponent(segment);
    return SAFE_ID.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function applicationView(application: FactUpdateApplication): Record<string, unknown> {
  return Object.freeze({
    applied_fact_keys: application.applied_fact_keys,
    rewritten_cell_keys: application.rewritten_cell_keys,
    untouched_bound_cell_keys: application.untouched_bound_cell_keys,
    untouched_cell_keys: application.untouched_cell_keys,
    recalculated_formula_keys: application.recalculated_formula_keys,
    blocked_formula_keys: application.blocked_formula_keys,
    affected_charts: application.affected_charts,
    untouched_charts: application.untouched_charts,
    rejected: application.rejected,
    digest: application.digest,
  });
}

/**
 * 处理一条 `/api/xls-facts/**` 路由（**纯函数**：不碰 node:http）。
 *
 * @returns `null` = 不是本命名空间（调用方落到 404 / 其它路由）。
 */
export async function routeXlsFactsRequest(
  request: XlsFactsWireRequest,
  host: XlsFactsHost,
): Promise<XlsFactsWireResponse | null> {
  if (!isXlsFactsPath(request.pathname)) return null;
  const method = request.method.toUpperCase();
  const segments = segmentsOf(request.pathname);
  const body = isRecord(request.body) ? request.body : {};

  // -- GET /api/xls-facts[/status] ----------------------------------------
  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'status')) {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'method_not_allowed', '只接受 GET');
    return ok({
      root: XLS_FACTS_ROOT,
      ready: true,
      channels: Object.freeze(channelsView(host)),
      unwired_targets: Object.freeze(
        PUBLICATION_TARGETS.filter((target) => !host.channels.some((channel) => channel.target === target)),
      ),
      unverified: XLS_FACTS_UNVERIFIED,
      note: NO_CHANNEL_REASON,
    });
  }

  // -- /api/xls-facts/sessions/** ------------------------------------------
  if (segments[0] !== 'sessions') {
    return fail(404, 'not_found', `没有这个共享事实接口 ${method} ${request.pathname}`);
  }

  // POST /api/xls-facts/sessions（新建会话）
  if (segments.length === 1) {
    if (method !== 'POST') return fail(405, 'method_not_allowed', '只接受 POST');
    const sessionId = asString(body['sessionId']);
    if (sessionId === null || !SAFE_ID.test(sessionId)) {
      return fail(400, 'invalid_session_id', 'sessionId 必填且必须是 1–128 位安全字符');
    }
    try {
      const view = host.createSession({
        sessionId,
        ...(Array.isArray(body['sheets']) ? { sheets: body['sheets'].map((s) => String(s)) } : {}),
        ...(Array.isArray(body['cells'])
          ? { cells: body['cells'].map((raw) => readCellInput(raw)) }
          : {}),
        ...(Array.isArray(body['bindings'])
          ? { bindings: body['bindings'].map((raw) => readCellFactBinding(raw)) }
          : {}),
        ...(Array.isArray(body['charts'])
          ? { charts: body['charts'].map((raw) => readChartSpec(raw)) }
          : {}),
      });
      return ok(view, 201);
    } catch (error) {
      return fail(422, 'invalid_session', describe(error));
    }
  }

  const sessionId = decodeId(segments[1]);
  if (sessionId === null) {
    return fail(404, 'session_not_found', `没有这个交付会话 ${JSON.stringify(String(segments[1] ?? ''))}`);
  }

  // GET /api/xls-facts/sessions/:id
  if (segments.length === 2) {
    if (method !== 'GET' && method !== 'HEAD') return fail(405, 'method_not_allowed', '只接受 GET');
    const view = host.getSession(sessionId);
    return view === undefined ? fail(404, 'session_not_found', `没有会话 ${sessionId}`) : ok(view);
  }

  const action = segments[2];

  // POST /api/xls-facts/sessions/:id/bind
  if (action === 'bind') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', '只接受 POST');
    try {
      const binding = readCellFactBinding(body);
      const view = host.bind(sessionId, binding);
      return view === undefined ? fail(404, 'session_not_found', `没有会话 ${sessionId}`) : ok(view);
    } catch (error) {
      return fail(422, 'invalid_binding', describe(error));
    }
  }

  // POST /api/xls-facts/sessions/:id/facts
  if (action === 'facts') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', '只接受 POST');
    const rawUpdates = body['updates'];
    if (!Array.isArray(rawUpdates)) return fail(422, 'invalid_updates', 'updates 必须是数组');
    let updates: FactCellUpdate[];
    try {
      updates = rawUpdates.map((raw) => readFactUpdate(raw));
    } catch (error) {
      return fail(422, 'invalid_update', describe(error));
    }
    try {
      const application = host.applyFacts(sessionId, updates);
      if (application === undefined) return fail(404, 'session_not_found', `没有会话 ${sessionId}`);
      return ok(Object.freeze({ sessionId, ...applicationView(application) }));
    } catch (error) {
      // 绑定悬空 / 绑定到公式格这类误绑：显式失败，不就近套用。
      return fail(422, 'invalid_application', describe(error));
    }
  }

  // POST /api/xls-facts/sessions/:id/deliver
  if (action === 'deliver') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', '只接受 POST');
    try {
      const delivery = host.deliver(sessionId);
      return delivery === undefined
        ? fail(404, 'session_not_found', `没有会话 ${sessionId}`)
        : ok(Object.freeze({ ...delivery }));
    } catch (error) {
      return fail(502, 'delivery_failed', describe(error));
    }
  }

  // POST /api/xls-facts/sessions/:id/publish
  if (action === 'publish') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', '只接受 POST');
    const rawKeys = body['factKeys'] ?? body['fact_keys'];
    if (!Array.isArray(rawKeys) || rawKeys.some((key) => typeof key !== 'string' || key.length === 0)) {
      return fail(422, 'invalid_fact_keys', 'factKeys 必须是非空字符串数组');
    }
    const artifactRevision = asString(body['artifactRevision'] ?? body['artifact_revision']);
    if (artifactRevision === null) {
      return fail(422, 'invalid_artifact_revision', 'artifactRevision 必填（发布必须说得出版本）');
    }
    try {
      const view = await host.publish(sessionId, { factKeys: rawKeys as string[], artifactRevision });
      return view === undefined
        ? fail(404, 'session_not_found', `没有会话 ${sessionId}`)
        : ok(Object.freeze({ ...view }));
    } catch (error) {
      return fail(422, 'publish_rejected', describe(error));
    }
  }

  // POST /api/xls-facts/sessions/:id/consistency
  if (action === 'consistency') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', '只接受 POST');
    const rawCarriers = body['carriers'] ?? [];
    if (!Array.isArray(rawCarriers)) return fail(422, 'invalid_carriers', 'carriers 必须是数组');
    const extraCarriers: FactVersionCarrier[] = [];
    for (const raw of rawCarriers) {
      if (!isRecord(raw)) return fail(422, 'invalid_carriers', 'carriers 里每一项都必须是对象');
      extraCarriers.push({
        carrier: raw['carrier'] as FactCarrier,
        fact_key: String(raw['fact_key'] ?? raw['factKey'] ?? ''),
        version: Number(raw['version']),
      });
    }
    try {
      const report = host.consistency(sessionId, extraCarriers);
      return report === undefined
        ? fail(404, 'session_not_found', `没有会话 ${sessionId}`)
        : ok(Object.freeze({ sessionId, ...report }));
    } catch (error) {
      return fail(422, 'invalid_carriers', describe(error));
    }
  }

  // POST /api/xls-facts/sessions/:id/verify（反向对照）
  if (action === 'verify') {
    if (method !== 'POST') return fail(405, 'method_not_allowed', '只接受 POST');
    const rewriteKeys = body['rewritten_cell_keys'];
    if (!Array.isArray(rewriteKeys)) {
      return fail(422, 'invalid_observation', 'rewritten_cell_keys 必须是数组');
    }
    const observation: FactUpdateObservation = {
      rewritten_cell_keys: rewriteKeys.map((key) => String(key)),
    };
    if (Array.isArray(body['applied_fact_keys'])) {
      (observation as { applied_fact_keys?: readonly string[] }).applied_fact_keys =
        body['applied_fact_keys'].map((key) => String(key));
    }
    if (Array.isArray(body['publication_claims'])) {
      (observation as { publication_claims?: FactUpdateObservation['publication_claims'] }).publication_claims =
        body['publication_claims'] as FactUpdateObservation['publication_claims'];
    }
    try {
      const violations = host.verify(sessionId, observation);
      return violations === undefined
        ? fail(404, 'session_not_found', `没有会话 ${sessionId}`)
        : ok(Object.freeze({ sessionId, violations }));
    } catch (error) {
      return fail(422, 'invalid_observation', describe(error));
    }
  }

  return fail(404, 'not_found', `没有这个共享事实接口 ${method} ${request.pathname}`);
}

function channelsView(host: XlsFactsHost): readonly Record<string, unknown>[] {
  return host.channels.map((channel) =>
    Object.freeze({
      target: channel.target,
      wired: true,
      reports_carrier_version: channel.carrier_version !== undefined,
    }),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------------------------------------------------------------------------
// node:http 适配器（挂载点）
// ---------------------------------------------------------------------------

export interface XlsFactsHttpInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  /** 省略时取 `req.method`。 */
  readonly method?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readRawBody(
  req: IncomingMessage,
): Promise<{ readonly ok: true; readonly raw: string } | { readonly ok: false }> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: { readonly ok: true; readonly raw: string } | { readonly ok: false }): void => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_XLS_FACTS_BODY_BYTES) {
        finish({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false }));
  });
}

/**
 * **挂载点**：处理一次 `/api/xls-facts/**` 请求。
 *
 * @returns `true` = 已写过响应（调用方直接 `return`）；`false` = 不是本命名空间。
 *
 * 协调者在 `http.ts` 的 `createDemoRequestHandler` 里加**两行**（放在 `/api/**` 兜底 404 之前）：
 *
 * ```ts
 * import { handleXlsFactsRequest, createXlsFactsHost } from './xls-facts-product.js';
 * ...
 * if (await handleXlsFactsRequest({ req, res, url, method }, xlsFactsHost)) return;
 * ```
 *
 * 产品装配处（`main.ts`）构造**一次**宿主并复用；**不注入任何通道** ⇒ 发布恒 `not-wired`。
 */
export async function handleXlsFactsRequest(
  input: XlsFactsHttpInput,
  host: XlsFactsHost,
): Promise<boolean> {
  const pathname = input.url.pathname;
  if (!isXlsFactsPath(pathname)) return false;

  const method = (input.method ?? input.req.method ?? 'GET').toUpperCase();
  let body: unknown = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readRawBody(input.req);
    if (!raw.ok) {
      sendJson(input.res, 413, { code: 'body_too_large', message: `请求体超过 ${String(MAX_XLS_FACTS_BODY_BYTES)} 字节上限`, retryable: false });
      return true;
    }
    if (raw.raw.trim() !== '') {
      try {
        body = JSON.parse(raw.raw) as unknown;
      } catch {
        sendJson(input.res, 400, { code: 'invalid_json', message: '请求体不是合法 JSON', retryable: false });
        return true;
      }
    }
  }

  const response = await routeXlsFactsRequest(
    { method, pathname, query: input.url.searchParams, body },
    host,
  );
  if (response === null) return false;
  sendJson(input.res, response.status, response.body);
  return true;
}

// ---------------------------------------------------------------------------
// 可达性自证：本路由**直接消费**（因而使其产品可达）的内核模块清单
// ---------------------------------------------------------------------------

/** 本路由**直接 import 并调用**的内核模块（→ 它们获得了非测试消费者）。 */
export const XLS_FACTS_MODULES_REACHABLE_BY_ROUTE: readonly string[] = Object.freeze([
  'src/spreadsheets/facts-binding.ts',
  'src/spreadsheets/package-assembly.ts',
]);

/** 仍未由本路由接线的能力（如实登记，不声称已覆盖）。 */
export const XLS_FACTS_NOT_WIRED_BY_ROUTE: readonly string[] = Object.freeze([
  'docx / pptx 侧"同版事实"发布通道（产品路径未装配任何 XlsFactsChannelPort）',
  '导入既有 .xlsx 并保留未知部件（R249，由 src/session/adapters/xlsx-io.ts 那条链负责）',
  '绑定元数据落进容器（明确不落进容器，见 XLS_FACTS_UNVERIFIED）',
]);
