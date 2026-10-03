/**
 * 演示域**同版事实同步**（PPT-16：根据**同版事实**生成与更新演示）。
 *
 * ## 这一层解决什么
 *
 * PPT-16 的硬要求是"修改人数 / 预算后**文本、图表、表格一致**"。三处数字落在三个不同的
 * 数据结构里，因此"一致"必须被**显式建模**，而不是靠约定：
 *
 * - **正文**：`TextRun.source.kind === 'fact'`，渲染时对着事实快照求值（`resolveRunText`）。
 *   它**天然**指回某一条事实，不会各编一个数。
 * - **表格**：单元格文本在模型里是**字面量**（`TableCell.text` 的 run），模型不知道它对应哪条
 *   事实——因此用 {@link TableFactBinding} 声明"这一格对应哪条事实"，本层再把格里的数字与
 *   事实值比对。
 * - **图表**：`ChartModel.series[].values` 是**嵌入的字面数字**（PPT-09 的"嵌入数据"），
 *   同样用 {@link ChartFactBinding} 声明"这一根柱子对应哪条事实"。
 *
 * 于是"三处一致"在结构上被钉死成一句话：**同一个 `fact_key` 的全部出现处，其呈现出来的数值
 * 必须等于目标版本里这条事实的值**。任何一处不相等 ⇒ 报冲突（`value_mismatch`）；若不相等的
 * 那个值恰好等于某个**历史版本**里同键的值 ⇒ 升级为 `stale_fact_version`，把"这一处用的是
 * 哪一版"写进冲突里（"图表用了旧版事实而正文用了新版"就是这一类）。
 *
 * ## 生成与更新
 *
 * - 生成：{@link factTextBody} / {@link chartFromFacts} / {@link factCell} —— 三处都**只接事实键**，
 *   数值一律来自同一条快照，调用方没有机会"另编一个数"。
 * - 更新：{@link applyFactVersion} —— 把文档里**字面量**的那两处（图表嵌入数据、表格单元格）
 *   重写成目标版本的事实值；正文因为本来就是事实引用，换快照即换数字。
 *
 * ## 未做到 / 未验证（如实登记，不得编造）
 *
 * - **手机关闭重开无修复提示**、**目标软件打开无修复提示**：这两条需要**真机 / 消费端**
 *   （移动端演示应用或桌面 Office）实际打开并观察有没有修复提示。本仓没有这个消费端，
 *   因此一律标"未验证"，见 {@link FACT_SYNC_UNVERIFIED_CLAIMS}，并由每份报告原样带出。
 *   本层**只**断言"同版事实一致"——这一条在模型层可完整判定，不需要消费端。
 * - 图表形状在本增量**渲染层未实现**（`render.ts` 的 `case 'chart'` 显式抛
 *   `unsupported_shape_kind`），因此"带图表的演示能导出成 PPTX 再被目标软件打开"这条链
 *   **未打通**；本层的图表一致性判据是**模型层**判据。
 * - 表格单元格里的 `fact` run 在**渲染层**目前不会求值（`tableXml` 不接收事实快照，单元格按
 *   空快照渲染 ⇒ 落到缺失占位符）。本层在**模型层**按正确语义读取事实值，但"表格里的
 *   `fact` run 能正确导出"**未经验证**；修渲染不属本包写权。
 *
 * ## 事实指纹 = `dc1-*`（采用 P06 `dataVersionOf`，不另造哈希）
 *
 * 三处同版"这件事需要一枚**可比较的版本坐标**，而不是靠逐项比对的次序偶然。P06 的
 * `table-chart-parts` 已经把"一份图表数据"投影成图内嵌工作簿 + 表字面量，并用
 * {@link dataVersionOf}（FNV-1a 32 位，前缀 `dc1-`）盖同一枚指纹；本层**采用同一枚**：
 * {@link VersionedFactSnapshot.data_version} 就是"数值事实的规范图表投影"的 `dc1-*` 指纹
 * （见 {@link factChartData} / {@link factDataVersionOf}）。于是正文事实引用、表格字面量、
 * 图表嵌入数据 / 内嵌工作簿只要都从同一份快照派生，就**结构上**同版——判"是不是同一版"
 * 只需比一个大写无关的短串，不必逐格重比。
 *
 * 本模块零 IO、零墙钟、不读环境，纯函数。
 */

import { renderFactValue } from '../artifacts/templates/pptx.js';
import { ValidationError } from '../protocol/index.js';

import type { KnownFactValue } from '../protocol/index.js';
import type { ExpectedChartData } from './table-chart-parts/consistency.js';
import { dataVersionOf } from './table-chart-parts/table-facts.js';
import {
  literalText,
  resolveRunText,
  type ChartModel,
  type ChartShape,
  type FactSnapshot,
  type Presentation,
  type RunStyle,
  type Shape,
  type Slide,
  type TableCell,
  type TableRow,
  type TableShape,
  type TextBody,
} from './model.js';

// ---------------------------------------------------------------------------
// 事实版本
// ---------------------------------------------------------------------------

/** 事实的**版本坐标**（任务 + 任务版本）。同一坐标下的同键事实就是"同版事实"。 */
export interface FactVersion {
  readonly task_id: string;
  readonly task_revision: number;
}

/** `task@r3` 形式的人类可读版本描述（供冲突信息与报告使用）。 */
export function describeFactVersion(version: FactVersion): string {
  return `${version.task_id}@r${String(version.task_revision)}`;
}

export function sameFactVersion(left: FactVersion, right: FactVersion): boolean {
  return left.task_id === right.task_id && left.task_revision === right.task_revision;
}

/** 一条**带身份**的事实条目（比模型层的 `FactValueLookup` 多一个 `fact_ref`）。 */
export interface VersionedFactEntry {
  /** 稳定事实键（`headcount` / `budget.total`）。 */
  readonly fact_key: string;
  /** 事实身份（同一键在不同版本下是不同的 `fact_ref`）。 */
  readonly fact_ref: string;
  readonly value: KnownFactValue;
}

/**
 * 某个任务版本下的一份事实快照。
 *
 * 不变式（由 {@link versionedSnapshot} 构造即校验）：**同一份快照里一个键只能出现一次**。
 * 同一键两条会让"到底用哪一条"变成隐式选择——那正是本模块要消灭的东西，因此这里**抛错**，
 * 不静默取第一条。
 */
export interface VersionedFactSnapshot {
  readonly version: FactVersion;
  readonly entries: readonly VersionedFactEntry[];
  /**
   * 本快照承载的**事实指纹**（`dc1-*`），现算自 {@link factChartData} 的规范图表投影，
   * 与 P06 的图 / 内嵌工作簿 / 表字面量是**同一枚** {@link dataVersionOf}。构造时即冻结，
   * 事后不可变——判断"是不是同一版事实"只比这一枚短串。
   */
  readonly data_version: string;
}

/**
 * 规范图表投影里**唯一序列**的名字（事实指纹用；不是展示文案）。
 * 每个数值事实 = 一个类别（键即类别名），该序列在每个类别上取该事实的数值。
 */
export const FACT_DATA_SERIES_NAME = 'facts';

/**
 * 把**数值事实条目**摊成规范图表数据：类别 = 数值事实键（按字典序，
 * 与条目登记顺序无关 ⇒ 换序不改指纹），唯一序列 {@link FACT_DATA_SERIES_NAME} 的值 = 各事实数值。
 *
 * 非数值事实（文本 / 日期）不能进数值轴，**不**入投影——它们仍由快照的 `entries` 承载，
 * 只是不参与图表 / 工作簿指纹（这是数据结构上的边界，不是静默丢弃：快照里仍在）。
 * 没有任何数值事实时返回空投影（`dataVersionOf` 对空投影仍给出确定的一枚指纹）。
 */
function chartDataFromEntries(entries: readonly VersionedFactEntry[]): ExpectedChartData {
  const numeric = entries
    .flatMap((entry) => (entry.value.type === 'number' ? [{ key: entry.fact_key, amount: entry.value.amount }] : []))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  if (numeric.length === 0) return { categories: [], series: [] };
  return {
    categories: numeric.map((point) => point.key),
    series: [{ name: FACT_DATA_SERIES_NAME, values: numeric.map((point) => point.amount) }],
  };
}

/**
 * 事实快照的**规范图表投影**（{@link VersionedFactSnapshot.data_version} 的定义域）。
 *
 * 图表嵌入数据、内嵌工作簿格、表字面量都可以从这**同一份**投影派生，从而盖同一枚 `dc1-*`；
 * 调用方不必自己拼类别 / 序列，也就没有机会让三处各算一份不同的图。
 */
export function factChartData(snapshot: VersionedFactSnapshot): ExpectedChartData {
  return chartDataFromEntries(snapshot.entries);
}

/**
 * 事实快照的 `dc1-*` 指纹——**独立复算**（`= dataVersionOf(factChartData(snapshot))`），
 * 不读 {@link VersionedFactSnapshot.data_version} 自证，供"快照指纹是否等于规范投影指纹"的复核。
 */
export function factDataVersionOf(snapshot: VersionedFactSnapshot): string {
  return dataVersionOf(chartDataFromEntries(snapshot.entries));
}

/** 本模块的错误（构造即校验的违规，以及"更新时绑定对不上"这类调用方错误）。 */
export class FactSyncError extends ValidationError {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'FactSyncError';
    this.reason = reason;
  }
}

/**
 * 校验并冻结一份版本化事实快照。
 *
 * @throws {FactSyncError} 任务 id 为空 / 版本非非负整数 / 某个键出现两次 / 某条 `fact_ref` 为空。
 */
export function versionedSnapshot(
  version: FactVersion,
  entries: readonly VersionedFactEntry[],
): VersionedFactSnapshot {
  if (version.task_id.length === 0) {
    throw new FactSyncError('invalid_version', '事实版本的任务 id 不得为空');
  }
  if (!Number.isSafeInteger(version.task_revision) || version.task_revision < 0) {
    throw new FactSyncError(
      'invalid_version',
      `事实版本号必须是非负整数，收到 ${String(version.task_revision)}`,
    );
  }
  const seen = new Set<string>();
  const frozen = entries.map((entry) => {
    if (entry.fact_key.length === 0) {
      throw new FactSyncError('invalid_entry', '事实键不得为空');
    }
    if (entry.fact_ref.length === 0) {
      throw new FactSyncError('invalid_entry', `事实 ${entry.fact_key} 的 fact_ref 不得为空`);
    }
    if (seen.has(entry.fact_key)) {
      throw new FactSyncError(
        'duplicate_fact_key',
        `同一版本（${describeFactVersion(version)}）下事实键 ${entry.fact_key} 出现两次：` +
          '同一键两条会让"用哪一条"变成隐式选择；请先在上游确定当前事实',
      );
    }
    seen.add(entry.fact_key);
    return Object.freeze({ fact_key: entry.fact_key, fact_ref: entry.fact_ref, value: entry.value });
  });
  return Object.freeze({
    version: Object.freeze({ ...version }),
    entries: Object.freeze(frozen),
    data_version: dataVersionOf(chartDataFromEntries(frozen)),
  });
}

/**
 * 改一条事实的值 ⇒ **新**版本快照（`task_revision + 1`），坐标与 `dc1-*` 指纹现算、
 * 旧快照一字不动。键不在快照里时按"新增一条事实"处理（与 P10 会话的 `publishFactValue` 同语义，
 * 本函数是它的纯函数底座，便于不经会话直接接线）。
 *
 * 因为新快照经 {@link versionedSnapshot} 构造，它的 `data_version` 必然等于新值下的规范投影指纹：
 * 一次 `set_fact_value` **只移动一枚** `dc1-*`，正文 / 表格 / 图表随之同版。
 *
 * @throws {FactSyncError} fact_key 为空。
 */
export function setFactValue(
  snapshot: VersionedFactSnapshot,
  factKey: string,
  value: KnownFactValue,
): VersionedFactSnapshot {
  if (factKey.length === 0) {
    throw new FactSyncError('invalid_entry', 'setFactValue 的 fact_key 不得为空');
  }
  const revision = snapshot.version.task_revision + 1;
  const exists = lookupVersionedFact(snapshot, factKey) !== null;
  const entries: VersionedFactEntry[] = snapshot.entries.map((entry) =>
    entry.fact_key === factKey
      ? { fact_key: factKey, fact_ref: `fact.${factKey}.r${String(revision)}`, value }
      : { ...entry },
  );
  if (!exists) {
    entries.push({ fact_key: factKey, fact_ref: `fact.${factKey}.r${String(revision)}`, value });
  }
  return versionedSnapshot({ task_id: snapshot.version.task_id, task_revision: revision }, entries);
}

/** 查某键在某版本快照里的条目；没有则 `null`（缺失不当零）。 */
export function lookupVersionedFact(
  snapshot: VersionedFactSnapshot,
  factKey: string,
): VersionedFactEntry | null {
  return snapshot.entries.find((entry) => entry.fact_key === factKey) ?? null;
}

/**
 * 把版本化快照降级成**模型层**的 `FactSnapshot`（只保留键与值），供 `resolveRunText` 等求值。
 *
 * 降级是**有损**的（丢掉 `fact_ref` 与版本），因此只在求值处使用；一致性判定一律用
 * {@link VersionedFactSnapshot} 本体。
 */
export function asFactSnapshot(snapshot: VersionedFactSnapshot): FactSnapshot {
  return snapshot.entries.map((entry) => ({ fact_key: entry.fact_key, value: entry.value }));
}

// ---------------------------------------------------------------------------
// 绑定：把"字面量"那两处挂回事实
// ---------------------------------------------------------------------------

/** 一条图表系列的绑定：每个类别对应哪个事实键（顺序即类别轴顺序）。 */
export interface ChartSeriesFactBinding {
  /** 系列名（须与图表里该序号的系列同名，避免"绑错了系列"）。 */
  readonly name: string;
  readonly fact_keys: readonly string[];
}

/** 图表绑定：`shape_id` 指向幻灯片上的图表形状。 */
export interface ChartFactBinding {
  readonly shape_id: number;
  readonly series: readonly ChartSeriesFactBinding[];
}

/** 表格单元格绑定：第 `row` 行第 `column` 列（均 0 起）这一格应当等于事实 `fact_key`。 */
export interface TableCellFactBinding {
  readonly row: number;
  readonly column: number;
  readonly fact_key: string;
}

/** 表格绑定：`shape_id` 指向幻灯片上的表格形状。 */
export interface TableFactBinding {
  readonly shape_id: number;
  readonly cells: readonly TableCellFactBinding[];
}

/** 一份演示文稿的全部事实绑定。 */
export interface FactBindings {
  readonly chart?: readonly ChartFactBinding[];
  readonly table?: readonly TableFactBinding[];
}

function chartBindingsOf(bindings: FactBindings | undefined): readonly ChartFactBinding[] {
  return bindings?.chart ?? [];
}

function tableBindingsOf(bindings: FactBindings | undefined): readonly TableFactBinding[] {
  return bindings?.table ?? [];
}

// ---------------------------------------------------------------------------
// 用量与冲突
// ---------------------------------------------------------------------------

/** 事实在演示里承担的角色（正是 PPT-16 点名的三处）。 */
export type FactUsageRole = 'text' | 'table' | 'chart';

/** 数值的**呈现来源**：事实求值 / 单元格字面量 / 图表嵌入数据。 */
export type FactValueOrigin = 'fact' | 'literal' | 'embedded';

/** 一处事实用量的审计记录。 */
export interface FactUsage {
  readonly fact_key: string;
  readonly role: FactUsageRole;
  /** 人类可读定位，如 `slide 2 / shape 5`。 */
  readonly location: string;
  /** 该处**呈现出来**的数值。 */
  readonly value: number;
  /** 该处数值所属的版本：`fact` 来源 = 目标版本；`literal` / `embedded` = 值对得上的那一版。 */
  readonly version: FactVersion;
  readonly origin: FactValueOrigin;
}

/** 冲突种类（封闭枚举）。 */
export const FACT_SYNC_CONFLICT_KINDS = [
  /** 目标版本里没有这个键（事实缺失——不得当零，也不得用别的版本的旧值）。 */
  'missing_fact',
  /** 目标版本里有这个键，但它不是数值事实（图表 / 表格的数值位不能装文本事实）。 */
  'non_numeric_fact',
  /** 绑定指向的形状不存在，或单元格行列越界。 */
  'binding_target_missing',
  /** 绑定声明的数据点个数与形状里实际的数据点个数对不上。 */
  'arity_mismatch',
  /** 绑定的单元格里读不出任何数值（空单元格 / 没有数字的字面量）。 */
  'unreadable_value',
  /** 同一键的两处出现数值不相等，且该数值不属于任何已知历史版本。 */
  'value_mismatch',
  /** 同一键的两处出现数值不相等，且不相等的那一处**恰好等于某个历史版本的值**。 */
  'stale_fact_version',
] as const;

export type FactSyncConflictKind = (typeof FACT_SYNC_CONFLICT_KINDS)[number];

/** 一条冲突。 */
export interface FactSyncConflict {
  readonly kind: FactSyncConflictKind;
  /** 涉及的事实键；与具体事实无关的冲突（如绑定目标缺失）为 `null`。 */
  readonly fact_key: string | null;
  readonly message: string;
  /** 卷入冲突的角色（去重、按 text → table → chart 顺序）。 */
  readonly roles: readonly FactUsageRole[];
  /** 卷入冲突的数值（不相等的那几个）。 */
  readonly values: readonly number[];
  /** 仅 `stale_fact_version`：被认出的旧版本。 */
  readonly stale_version: FactVersion | null;
  /** 涉及的位置。 */
  readonly locations: readonly string[];
}

/** 未验证声明（PPT-16 后半句没有消费端，必须如实标注而不是默认已通过）。 */
export interface FactSyncUnverifiedClaim {
  readonly claim: string;
  readonly status: 'unverified';
  /** 需要什么才能验证。 */
  readonly requires: string;
  readonly detail: string;
}

/**
 * PPT-16 里**本仓无法验证**的断言。
 *
 * 判据：这两条都需要"演示文稿被另一个程序打开"这一外部观测，本仓没有任何演示消费端，
 * 也没有已连接的真机 ⇒ 只能登记为未验证。把它们放进报告（而不是只写在文档里）是为了让
 * 上游转述时**结构上**必须带上这份清单。
 */
export const FACT_SYNC_UNVERIFIED_CLAIMS: readonly FactSyncUnverifiedClaim[] = Object.freeze([
  Object.freeze({
    claim: '手机关闭重开演示文稿后没有修复提示',
    status: 'unverified' as const,
    requires: '已连接的 Android 真机 + 移动端演示消费应用',
    detail:
      '本仓没有手机端消费路径，也不产生 / 读回任何"修复提示"；本层只做模型层同步，' +
      '故不得声称"重开无提示"已验证。',
  }),
  Object.freeze({
    claim: '目标软件打开演示文稿没有修复提示',
    status: 'unverified' as const,
    requires: '桌面或移动端 Office 消费端（PowerPoint / 演示应用）',
    detail:
      '需要目标软件实开并观察是否弹修复提示。本批未做该实开，' +
      '且图表形状在渲染层尚未实现（本层一致性判据因此只到模型层）。',
  }),
  Object.freeze({
    claim: '图表 / 表格 / 正文在目标软件中显示为同一个数',
    status: 'unverified' as const,
    requires: '消费端',
    detail:
      '本层断言的是"模型层数值同版一致"（可完整判定）；渲染后的观感一致需要消费端实看，' +
      '不在本层判据内。',
  }),
]);

/** 同步报告。 */
export interface FactSyncReport {
  /** 无冲突即 `true`（是否"三处都用上"另看 `counts`）。 */
  readonly ok: boolean;
  readonly version: FactVersion;
  /** 目标快照的 `dc1-*` 事实指纹（三处同版判据的坐标；= `target.data_version`）。 */
  readonly data_version: string;
  readonly usages: readonly FactUsage[];
  readonly conflicts: readonly FactSyncConflict[];
  readonly counts: Readonly<Record<FactUsageRole, number>>;
  /** 「同版事实一致」的判定口径（原文写进报告，供上游如实转述）。 */
  readonly consistency_scope: string;
  readonly unverified: readonly FactSyncUnverifiedClaim[];
}

export const FACT_SYNC_CONSISTENCY_SCOPE =
  '同一个事实键在正文 / 表格 / 图表里的全部出现处，其呈现数值必须等于目标版本里这条事实的值；' +
  '任一处不相等即报冲突；不相等的那一处若等于某个历史版本的值，则升级为 stale_fact_version。';

// ---------------------------------------------------------------------------
// 求值辅助
// ---------------------------------------------------------------------------

/** 取一个文本体里全部 `fact` run 的事实键（按出现顺序）。 */
export function factKeysOfBody(body: TextBody): readonly string[] {
  const keys: string[] = [];
  for (const paragraph of body.paragraphs) {
    for (const run of paragraph.runs) {
      if (run.source.kind === 'fact') keys.push(run.source.fact_key);
    }
  }
  return keys;
}

/** 把文本体按给定快照求值成一行文本（段内 run 直接相连，段间用空格分隔）。 */
export function bodyText(body: TextBody, snapshot: FactSnapshot): string {
  return body.paragraphs
    .map((paragraph) => paragraph.runs.map((run) => resolveRunText(run.source, snapshot)).join(''))
    .join(' ');
}

/** 数字字面量的识别（含千分位逗号与负号）。 */
const NUMERIC_LITERAL = /[-+]?\d[\d,]*(?:\.\d+)?/;

/** 从一段文本里读第一个数字；读不出返回 `null`（**不当零**）。 */
export function parseNumericLiteral(text: string): number | null {
  const match = NUMERIC_LITERAL.exec(text);
  if (match === null) return null;
  const parsed = Number(match[0].split(',').join(''));
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// 生成（PPT-16「根据同版事实生成演示」）
// ---------------------------------------------------------------------------

/** 造一个**事实引用**文本体：数字由渲染时对着同版快照求值，调用方编不出数字。 */
export function factTextBody(factKey: string, style?: RunStyle): TextBody {
  return Object.freeze({
    paragraphs: Object.freeze([
      Object.freeze({
        runs: Object.freeze([
          Object.freeze({ source: { kind: 'fact', fact_key: factKey } as const, style }),
        ]),
        level: 0,
        alignment: 'left' as const,
        bullet: false,
      }),
    ]),
  });
}

/** 造一个**绑定到事实**的表格单元格：格里的数字是目标版本的事实值。 */
export function factCell(factKey: string, snapshot: VersionedFactSnapshot): TableCell {
  const entry = lookupVersionedFact(snapshot, factKey);
  if (entry === null) {
    throw new FactSyncError(
      'missing_fact',
      `生成表格单元格时找不到事实 ${factKey}（${describeFactVersion(snapshot.version)}）：` +
        '缺失不得当零，也不得改用无来源字面量',
    );
  }
  return Object.freeze({ text: literalText(renderFactValue(entry.value)), col_span: 1, row_span: 1 });
}

export interface ChartFromFactsSeriesInput {
  readonly name: string;
  readonly fact_keys: readonly string[];
}

export interface ChartFromFactsInput {
  readonly chart_type: ChartModel['chart_type'];
  readonly title: string | null;
  readonly categories: readonly string[];
  readonly series: readonly ChartFromFactsSeriesInput[];
  readonly snapshot: VersionedFactSnapshot;
}

/**
 * 由事实键装配图表嵌入数据。
 *
 * 逐键取数：缺失 ⇒ 抛（不当零）；非数值 ⇒ 抛；声明数据点个数与类别数不等 ⇒ 抛；
 * 一张图里混装不同单位 / 币种 ⇒ 抛（同一坐标轴解释不了两种量纲）。
 * 因为入口只有事实键，装配出来的图表**必然**与正文、表格同版。
 */
export function chartFromFacts(input: ChartFromFactsInput): ChartModel {
  const units = new Set<string>();
  const series = input.series.map((seriesInput) => {
    const values = seriesInput.fact_keys.map((factKey, pointIndex) => {
      const category = input.categories[pointIndex];
      if (category === undefined) {
        throw new FactSyncError(
          'arity_mismatch',
          `系列 "${seriesInput.name}" 声明了 ${String(seriesInput.fact_keys.length)} 个数据点，` +
            `类别轴只有 ${String(input.categories.length)} 个类别（必须一一对应）`,
        );
      }
      const entry = lookupVersionedFact(input.snapshot, factKey);
      if (entry === null) {
        throw new FactSyncError(
          'missing_fact',
          `系列 "${seriesInput.name}" 的第 ${String(pointIndex + 1)} 个数据点找不到事实 "${factKey}"` +
            `（${describeFactVersion(input.snapshot.version)}）：缺失不得当零`,
        );
      }
      if (entry.value.type !== 'number') {
        throw new FactSyncError(
          'non_numeric_fact',
          `事实 "${factKey}" 是 ${entry.value.type} 类型，图表数值轴只接受数值事实`,
        );
      }
      units.add(`${entry.value.unit}|${entry.value.currency ?? ''}`);
      return entry.value.amount;
    });
    return Object.freeze({ name: seriesInput.name, values: Object.freeze(values) });
  });

  if (units.size > 1) {
    throw new FactSyncError(
      'non_numeric_fact',
      `同一张图里出现了 ${String(units.size)} 种不同的数值单位 / 币种（${[...units].join('、')}）；` +
        '同一坐标轴无法解释不同量纲，拒绝装配',
    );
  }

  return Object.freeze({
    chart_type: input.chart_type,
    categories: Object.freeze([...input.categories]),
    series: Object.freeze(series),
    title: input.title,
  });
}

// ---------------------------------------------------------------------------
// 采集：把模型里的"事实出现处"找出来
// ---------------------------------------------------------------------------

/** 采集阶段的中间表示：还没跟目标版本对账。 */
interface RawUsage {
  readonly fact_key: string;
  readonly role: FactUsageRole;
  readonly location: string;
  /** 该处**写死**的数值；`fact` 来源为 `null`（它的值就是事实本身）。 */
  readonly observed: number | null;
  readonly origin: FactValueOrigin;
}

function locationOf(slideId: number, shapeId: number | null, table?: string): string {
  const base = `slide ${String(slideId)}`;
  if (shapeId === null) return base;
  const shape = `${base} / shape ${String(shapeId)}`;
  return table === undefined ? shape : `${shape} / ${table}`;
}

function collectBodyUsages(
  body: TextBody,
  role: FactUsageRole,
  location: string,
  out: RawUsage[],
): void {
  for (const paragraph of body.paragraphs) {
    for (const run of paragraph.runs) {
      if (run.source.kind === 'fact') {
        out.push({ fact_key: run.source.fact_key, role, location, observed: null, origin: 'fact' });
      }
    }
  }
}

function collectShapeUsages(slide: Slide, shape: Shape, out: RawUsage[]): void {
  const location = (table?: string) => locationOf(slide.slide_id, shape.shape_id, table);
  switch (shape.kind) {
    case 'text_box':
      collectBodyUsages(shape.text, 'text', location(), out);
      return;
    case 'auto_shape':
      if (shape.text !== null) collectBodyUsages(shape.text, 'text', location(), out);
      return;
    case 'table':
      shape.rows.forEach((row, rowIndex) => {
        row.cells.forEach((cell, columnIndex) => {
          if (cell.text !== null) {
            collectBodyUsages(cell.text, 'table', location(`r${String(rowIndex)}c${String(columnIndex)}`), out);
          }
        });
      });
      return;
    case 'group':
      for (const child of shape.children) {
        collectShapeUsages(slide, child, out);
      }
      return;
    case 'connector':
    case 'picture':
    case 'chart':
    case 'media':
      return;
  }
}

// ---------------------------------------------------------------------------
// 同步
// ---------------------------------------------------------------------------

export interface PresentationFactSyncInput {
  readonly presentation: Presentation;
  /** 本次演示**应当依据**的版本。 */
  readonly target: VersionedFactSnapshot;
  readonly bindings?: FactBindings;
  /** 已知的历史版本（按给定顺序取首个命中），用于把不一致判成"用了旧版"而不是"凭空错值"。 */
  readonly history?: readonly VersionedFactSnapshot[];
}

/** 在某历史版本里找到"该键等于这个数值"的那一版；没找到返回 `null`。 */
function findVersionWithValue(
  history: readonly VersionedFactSnapshot[],
  factKey: string,
  value: number,
): FactVersion | null {
  for (const snapshot of history) {
    const entry = lookupVersionedFact(snapshot, factKey);
    if (entry === null) continue;
    if (entry.value.type !== 'number') continue;
    if (entry.value.amount === value) return snapshot.version;
  }
  return null;
}

const ROLE_ORDER: readonly FactUsageRole[] = Object.freeze(['text', 'table', 'chart']);

function orderRoles(roles: ReadonlySet<FactUsageRole>): readonly FactUsageRole[] {
  return ROLE_ORDER.filter((role) => roles.has(role));
}

function findShape(slide: Slide, shapeId: number): Shape | null {
  return slide.shapes.find((shape) => shape.shape_id === shapeId) ?? null;
}

/**
 * 对账：演示模型 × 目标版本 × 绑定 ⇒ 报告。
 *
 * 判定分两层：
 * 1. **采集**（本层）：绑定指向的对象是否存在、数据点个数是否对得上、单元格里能不能读出数值；
 * 2. **对账**（按事实键分组）：目标版本里有没有这个键、是不是数值、各处数值是否相等，
 *    不相等的那一处能不能被认成某个历史版本的值。
 */
export function syncPresentationFacts(input: PresentationFactSyncInput): FactSyncReport {
  const { target } = input;
  const history = input.history ?? [];
  const raw: RawUsage[] = [];
  const conflicts: FactSyncConflict[] = [];

  // --- 1. 采集正文 / 表格里的 fact run ------------------------------------
  input.presentation.slides.forEach((slide) => {
    for (const shape of slide.shapes) collectShapeUsages(slide, shape, raw);
    if (slide.notes !== null) {
      collectBodyUsages(slide.notes, 'text', locationOf(slide.slide_id, null), raw);
    }
  });

  // --- 2. 采集绑定（图表嵌入数据 / 表格字面量） ---------------------------
  for (const binding of chartBindingsOf(input.bindings)) {
    let found = false;
    for (const slide of input.presentation.slides) {
      const shape = findShape(slide, binding.shape_id);
      if (shape === null) continue;
      found = true;
      if (shape.kind !== 'chart') {
        conflicts.push({
          kind: 'binding_target_missing',
          fact_key: null,
          message: `图表绑定指向 shape ${String(binding.shape_id)}，但它是 ${shape.kind} 形状`,
          roles: ['chart'],
          values: [],
          stale_version: null,
          locations: [locationOf(slide.slide_id, shape.shape_id)],
        });
        break;
      }
      collectChartUsages(slide, shape, binding, conflicts, raw);
      break;
    }
    if (!found) {
      conflicts.push({
        kind: 'binding_target_missing',
        fact_key: null,
        message: `图表绑定指向的 shape ${String(binding.shape_id)} 不在任何幻灯片上`,
        roles: ['chart'],
        values: [],
        stale_version: null,
        locations: [],
      });
    }
  }

  for (const binding of tableBindingsOf(input.bindings)) {
    let found = false;
    for (const slide of input.presentation.slides) {
      const shape = findShape(slide, binding.shape_id);
      if (shape === null) continue;
      found = true;
      if (shape.kind !== 'table') {
        conflicts.push({
          kind: 'binding_target_missing',
          fact_key: null,
          message: `表格绑定指向 shape ${String(binding.shape_id)}，但它是 ${shape.kind} 形状`,
          roles: ['table'],
          values: [],
          stale_version: null,
          locations: [locationOf(slide.slide_id, shape.shape_id)],
        });
        break;
      }
      collectTableUsages(slide, shape, binding, conflicts, raw);
      break;
    }
    if (!found) {
      conflicts.push({
        kind: 'binding_target_missing',
        fact_key: null,
        message: `表格绑定指向的 shape ${String(binding.shape_id)} 不在任何幻灯片上`,
        roles: ['table'],
        values: [],
        stale_version: null,
        locations: [],
      });
    }
  }

  // --- 3. 按事实键对账 ---------------------------------------------------
  const usages: FactUsage[] = [];
  const byKey = new Map<string, RawUsage[]>();
  for (const usage of raw) {
    const list = byKey.get(usage.fact_key);
    if (list === undefined) byKey.set(usage.fact_key, [usage]);
    else list.push(usage);
  }

  for (const [factKey, group] of byKey) {
    const entry = lookupVersionedFact(target, factKey);
    const rolesSeen = new Set(group.map((usage) => usage.role));
    const locations = group.map((usage) => usage.location);

    if (entry === null) {
      conflicts.push({
        kind: 'missing_fact',
        fact_key: factKey,
        message:
          `事实键 ${factKey} 在目标版本 ${describeFactVersion(target.version)} 里没有登记：` +
          '缺失必须如实上报，不得当零、也不得改用别的版本的旧值',
        roles: orderRoles(rolesSeen),
        values: [],
        stale_version: null,
        locations,
      });
      continue;
    }

    if (entry.value.type !== 'number') {
      conflicts.push({
        kind: 'non_numeric_fact',
        fact_key: factKey,
        message: `事实 ${factKey} 是 ${entry.value.type} 类型，不能与图表 / 表格的数值位对账`,
        roles: orderRoles(rolesSeen),
        values: [],
        stale_version: null,
        locations,
      });
      continue;
    }

    const expected = entry.value.amount;
    for (const usage of group) {
      if (usage.observed === null) {
        usages.push({
          fact_key: factKey,
          role: usage.role,
          location: usage.location,
          value: expected,
          version: target.version,
          origin: usage.origin,
        });
        continue;
      }
      if (usage.observed === expected) {
        usages.push({
          fact_key: factKey,
          role: usage.role,
          location: usage.location,
          value: usage.observed,
          version: target.version,
          origin: usage.origin,
        });
        continue;
      }
      // 数值对不上：先问"这是不是某个历史版本的值"。
      const stale = findVersionWithValue(history, factKey, usage.observed);
      usages.push({
        fact_key: factKey,
        role: usage.role,
        location: usage.location,
        value: usage.observed,
        version: stale ?? target.version,
        origin: usage.origin,
      });
      conflicts.push({
        kind: stale === null ? 'value_mismatch' : 'stale_fact_version',
        fact_key: factKey,
        message:
          stale === null
            ? `事实 ${factKey} 在 ${usage.location} 呈现为 ${String(usage.observed)}，` +
              `但目标版本 ${describeFactVersion(target.version)} 的值是 ${String(expected)}：` +
              '三处数值必须来自同一版事实'
            : `事实 ${factKey} 在 ${usage.location} 呈现为 ${String(usage.observed)}——` +
              `这正是旧版本 ${describeFactVersion(stale)} 的值，而目标版本 ` +
              `${describeFactVersion(target.version)} 的值是 ${String(expected)}：` +
              '该处用的是旧版事实（图表嵌入数据 / 表格字面量没有跟着更新）',
        roles: [usage.role],
        values: [usage.observed, expected],
        stale_version: stale,
        locations: [usage.location],
      });
    }
  }

  const counts: Record<FactUsageRole, number> = { text: 0, table: 0, chart: 0 };
  for (const usage of usages) counts[usage.role] += 1;

  return Object.freeze({
    ok: conflicts.length === 0,
    version: target.version,
    data_version: target.data_version,
    usages: Object.freeze(usages),
    conflicts: Object.freeze(conflicts),
    counts: Object.freeze(counts),
    consistency_scope: FACT_SYNC_CONSISTENCY_SCOPE,
    unverified: FACT_SYNC_UNVERIFIED_CLAIMS,
  });
}

function collectChartUsages(
  slide: Slide,
  shape: ChartShape,
  binding: ChartFactBinding,
  conflicts: FactSyncConflict[],
  out: RawUsage[],
): void {
  binding.series.forEach((seriesBinding, seriesIndex) => {
    const series = shape.chart.series[seriesIndex];
    if (series === undefined) {
      conflicts.push({
        kind: 'arity_mismatch',
        fact_key: null,
        message:
          `图表绑定声明了 ${String(binding.series.length)} 个系列，但 shape ` +
          `${String(shape.shape_id)} 的图表只有 ${String(shape.chart.series.length)} 个系列`,
        roles: ['chart'],
        values: [],
        stale_version: null,
        locations: [locationOf(slide.slide_id, shape.shape_id)],
      });
      return;
    }
    if (series.name !== seriesBinding.name) {
      conflicts.push({
        kind: 'arity_mismatch',
        fact_key: null,
        message:
          `图表绑定第 ${String(seriesIndex + 1)} 个系列名为 "${seriesBinding.name}"，` +
          `但图里的系列名是 "${series.name}"：绑定与图表对不上`,
        roles: ['chart'],
        values: [],
        stale_version: null,
        locations: [locationOf(slide.slide_id, shape.shape_id)],
      });
      return;
    }
    if (seriesBinding.fact_keys.length !== series.values.length) {
      conflicts.push({
        kind: 'arity_mismatch',
        fact_key: null,
        message:
          `系列 "${series.name}" 声明了 ${String(seriesBinding.fact_keys.length)} 个事实键，` +
          `但嵌入数据有 ${String(series.values.length)} 个数值（必须一一对应）`,
        roles: ['chart'],
        values: [],
        stale_version: null,
        locations: [locationOf(slide.slide_id, shape.shape_id)],
      });
      return;
    }
    seriesBinding.fact_keys.forEach((factKey, pointIndex) => {
      const value = series.values[pointIndex];
      if (value === undefined) return;
      out.push({
        fact_key: factKey,
        role: 'chart',
        location: locationOf(
          slide.slide_id,
          shape.shape_id,
          `series ${String(seriesIndex)} / point ${String(pointIndex)}`,
        ),
        observed: value,
        origin: 'embedded',
      });
    });
  });
}

function collectTableUsages(
  slide: Slide,
  shape: TableShape,
  binding: TableFactBinding,
  conflicts: FactSyncConflict[],
  out: RawUsage[],
): void {
  for (const cellBinding of binding.cells) {
    const row: TableRow | undefined = shape.rows[cellBinding.row];
    const cell: TableCell | undefined = row?.cells[cellBinding.column];
    const location = locationOf(
      slide.slide_id,
      shape.shape_id,
      `r${String(cellBinding.row)}c${String(cellBinding.column)}`,
    );
    if (cell === undefined) {
      conflicts.push({
        kind: 'binding_target_missing',
        fact_key: cellBinding.fact_key,
        message:
          `表格绑定指向第 ${String(cellBinding.row)} 行第 ${String(cellBinding.column)} 列，` +
          '但表格没有这一格',
        roles: ['table'],
        values: [],
        stale_version: null,
        locations: [location],
      });
      continue;
    }
    const observed = observeTableCell(cell);
    if (observed.origin === 'unreadable') {
      conflicts.push({
        kind: 'unreadable_value',
        fact_key: cellBinding.fact_key,
        message:
          `表格 ${location} 绑定到事实 ${cellBinding.fact_key}，但该格读不出任何数值` +
          '（空文本 / 没有数字）：不得把"读不出"当成零',
        roles: ['table'],
        values: [],
        stale_version: null,
        locations: [location],
      });
      continue;
    }
    if (observed.origin === 'fact' && observed.fact_key !== cellBinding.fact_key) {
      conflicts.push({
        kind: 'value_mismatch',
        fact_key: cellBinding.fact_key,
        message:
          `表格 ${location} 绑定到事实 ${cellBinding.fact_key}，` +
          `但该格的事实引用指向 ${observed.fact_key}：绑定与单元格必须指同一条事实`,
        roles: ['table'],
        values: [],
        stale_version: null,
        locations: [location],
      });
      continue;
    }
    out.push({
      fact_key: observed.origin === 'fact' ? observed.fact_key : cellBinding.fact_key,
      role: 'table',
      location,
      observed: observed.origin === 'fact' ? null : observed.value,
      origin: observed.origin,
    });
  }
}

/** 一个单元格的读数结果。 */
export type TableCellObservation =
  /** 格子里是**事实引用**：数值由对账阶段从目标版本取（本阶段只认事实键）。 */
  | { readonly origin: 'fact'; readonly fact_key: string }
  /** 格子里是**字面量**：读出其中的第一个数字。 */
  | { readonly origin: 'literal'; readonly value: number }
  /** 读不出数值（空格 / 没有数字）：**不得当成零**。 */
  | { readonly origin: 'unreadable' };

/**
 * 读一个单元格：是事实引用，还是写死的数字。
 *
 * 事实引用**优先**——一个格里既有事实 run 又有别的字面量时，以事实为准（多来源即冲突源）。
 */
export function observeTableCell(cell: TableCell): TableCellObservation {
  if (cell.text === null) return { origin: 'unreadable' };
  const factKeys = factKeysOfBody(cell.text);
  const first = factKeys[0];
  if (first !== undefined) return { origin: 'fact', fact_key: first };
  const parsed = parseNumericLiteral(bodyText(cell.text, []));
  return parsed === null ? { origin: 'unreadable' } : { origin: 'literal', value: parsed };
}

// ---------------------------------------------------------------------------
// 更新（PPT-16「修改人数 / 预算后文本、图表、表格一致」）
// ---------------------------------------------------------------------------

export interface ApplyFactVersionInput {
  readonly presentation: Presentation;
  readonly target: VersionedFactSnapshot;
  readonly bindings: FactBindings;
}

function numericAmountOf(
  snapshot: VersionedFactSnapshot,
  factKey: string,
  context: string,
): number {
  const entry = lookupVersionedFact(snapshot, factKey);
  if (entry === null) {
    throw new FactSyncError(
      'missing_fact',
      `${context}：找不到事实 ${factKey}（${describeFactVersion(snapshot.version)}）`,
    );
  }
  if (entry.value.type !== 'number') {
    throw new FactSyncError(
      'non_numeric_fact',
      `${context}：事实 ${factKey} 是 ${entry.value.type} 类型，数值位不接受`,
    );
  }
  return entry.value.amount;
}

/**
 * 把演示文稿里**字面量**的那两处（图表嵌入数据、表格绑定单元格）改写为目标版本的事实值。
 *
 * 正文不必改：它本来就是 `fact` 引用，换快照即换数字。
 * 返回**新**模型（不可变），原模型不被污染。
 *
 * @throws {FactSyncError} 绑定指向的形状不存在、数据点个数对不上、或目标版本缺这条事实。
 */
export function applyFactVersion(input: ApplyFactVersionInput): Presentation {
  const { target } = input;
  const charts = new Map<number, ChartFactBinding>();
  for (const binding of chartBindingsOf(input.bindings)) charts.set(binding.shape_id, binding);
  const tables = new Map<number, TableFactBinding>();
  for (const binding of tableBindingsOf(input.bindings)) tables.set(binding.shape_id, binding);

  const shapeIdsSeen = new Set<number>();
  for (const binding of charts.values()) shapeIdsSeen.add(binding.shape_id);
  for (const binding of tables.values()) shapeIdsSeen.add(binding.shape_id);

  const present = new Set<number>();
  for (const slide of input.presentation.slides) {
    for (const shape of slide.shapes) {
      if (shapeIdsSeen.has(shape.shape_id)) present.add(shape.shape_id);
    }
  }
  for (const shapeId of shapeIdsSeen) {
    if (!present.has(shapeId)) {
      throw new FactSyncError(
        'binding_target_missing',
        `绑定指向的 shape ${String(shapeId)} 不在任何幻灯片上`,
      );
    }
  }

  const slides = input.presentation.slides.map((slide) => ({
    ...slide,
    shapes: slide.shapes.map((shape) => rewriteShape(shape, charts, tables, target)),
  }));

  return Object.freeze({ ...input.presentation, slides: Object.freeze(slides) });
}

function rewriteShape(
  shape: Shape,
  charts: ReadonlyMap<number, ChartFactBinding>,
  tables: ReadonlyMap<number, TableFactBinding>,
  target: VersionedFactSnapshot,
): Shape {
  if (shape.kind === 'chart') {
    const binding = charts.get(shape.shape_id);
    if (binding === undefined) return shape;
    return { ...shape, chart: rewriteChart(shape, binding, target) };
  }
  if (shape.kind === 'table') {
    const binding = tables.get(shape.shape_id);
    if (binding === undefined) return shape;
    return rewriteTable(shape, binding, target);
  }
  if (shape.kind === 'group') {
    return { ...shape, children: shape.children.map((child) => rewriteShape(child, charts, tables, target)) };
  }
  return shape;
}

function rewriteChart(
  shape: ChartShape,
  binding: ChartFactBinding,
  target: VersionedFactSnapshot,
): ChartModel {
  const series = shape.chart.series.map((existing, seriesIndex) => {
    const seriesBinding = binding.series[seriesIndex];
    if (seriesBinding === undefined) return existing;
    const context = `图表 shape ${String(shape.shape_id)} 系列 "${existing.name}"`;
    if (seriesBinding.fact_keys.length !== existing.values.length) {
      throw new FactSyncError(
        'arity_mismatch',
        `${context}：绑定声明 ${String(seriesBinding.fact_keys.length)} 个事实键，` +
          `嵌入数据有 ${String(existing.values.length)} 个数值（必须一一对应）`,
      );
    }
    return {
      name: existing.name,
      values: seriesBinding.fact_keys.map((factKey) => numericAmountOf(target, factKey, context)),
    };
  });
  return { ...shape.chart, series };
}

function rewriteTable(
  shape: TableShape,
  binding: TableFactBinding,
  target: VersionedFactSnapshot,
): TableShape {
  const rows = shape.rows.map((row, rowIndex) => ({
    cells: row.cells.map((cell, columnIndex) => {
      const cellBinding = binding.cells.find(
        (candidate) => candidate.row === rowIndex && candidate.column === columnIndex,
      );
      if (cellBinding === undefined) return cell;
      const entry = lookupVersionedFact(target, cellBinding.fact_key);
      if (entry === null) {
        throw new FactSyncError(
          'missing_fact',
          `表格 shape ${String(shape.shape_id)} 第 ${String(rowIndex)} 行第 ${String(columnIndex)} 列：` +
            `找不到事实 ${cellBinding.fact_key}（${describeFactVersion(target.version)}）`,
        );
      }
      return { ...cell, text: literalText(renderFactValue(entry.value)) };
    }),
  }));
  return { ...shape, rows };
}
