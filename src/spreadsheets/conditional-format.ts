/**
 * 表格域：条件格式规则 / 应用范围 / 优先级 / 清除（design-06-P8 / XLS-11 后半）。
 *
 * ## 优先级是条件格式的**语义核心**，不是排序装饰
 *
 * 多条规则命中同一格时，谁的颜色生效由 `priority` 决定（数字小者先、先命中者赢；
 * `stopIfTrue` 命中即终止后续）。因此：
 * - 优先级必须是**互不相同的正整数**——两条规则同优先级是**真歧义**，本模块**抛错**而不猜次序；
 * - {@link normalizePriorities} 把一组规则按既有优先级稳定排序后重编号为 `1..N`，
 *   这是"删除一条规则后把后面的往前挪"的正确做法（不留下 priority 空洞）。
 *
 * ## 应用范围：结构变更后跟着迁移，删没了就丢弃（**不伪造**）
 *
 * 在规则范围内插行 ⇒ 范围变宽；删掉范围内的行 ⇒ 范围截短；范围被整体删掉 ⇒ **丢弃该规则**，
 * 并在返回里登记被丢弃的规则（可审计）。这与 `sheet.ts` 对"删除命中"返回 `deleted`
 * 而不编一个新行号是同一态度。
 *
 * ## x14（Excel 2010 扩展）语义
 *
 * 富格式的数据条 / 图标集（渐变、边框、自定义图标）在纯 ECMA-376 里表达不了，Excel 把它们
 * 写进工作表 `extLst` 下的 `x14:conditionalFormattings`，规则用 **GUID** 标识。
 * 本模块把"扩展规则"建模为 {@link CfRule.extended}：为真的规则走 x14 块，其余走标准块。
 * GUID 由**确定性哈希**生成（内核纪律：`src/**` 不得引入随机源），因此同一规则集每次都得到同一字节。
 *
 * ## 已知边界（如实登记）
 *
 * - 条件格式的 `<formula>` 文本由调用方给出（本模块**不替调用方编造**公式）；
 *   颜色刻度 / 数据条 / 图标集的**形状**则由结构化描述生成。
 * - 真实 Excel 对"同一功能的标准块 vs x14 块"的取舍属**未验证**范围（本仓无 Office 授权）。
 * - 读侧对偶覆盖**标准块 + dxfs**（{@link parseConditionalFormattingBlocks} / {@link parseDxfsXml}）。
 *   **x14 扩展块（`extLst` 里的 `x14:conditionalFormattings`）暂无读回函数**：其规则无显式
 *   `priority`、优先级由次序与 GUID 隐式表达，无法在无真实语料时如实重建，故**不臆造**（见 X-I12 residual）。
 * - `range` 允许**空格分隔的多区域 sqref**（真实 Excel 形状），读写不丢；但行迁移
 *   （{@link migrateCfRuleRanges} / {@link clearRulesForRange}）仍按**单一区域**解析，多区域不参与迁移。
 */

import { attr, el, serializeXmlNode, type XmlAttribute, type XmlElement } from '../artifacts/ooxml/index.js';
import { SPREADSHEETML_NAMESPACE } from '../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXml,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import { ValidationError } from '../protocol/index.js';
import { columnNumberToLetters, mapReferenceOnRowInsert, parseRange, type CellReference } from './reference.js';

/** 条件格式规则类型。 */
export type CfRuleType =
  | 'cellIs'
  | 'expression'
  | 'containsText'
  | 'notContainsText'
  | 'beginsWith'
  | 'endsWith'
  | 'duplicateValues'
  | 'uniqueValues'
  | 'containsBlanks'
  | 'notContainsBlanks'
  | 'containsErrors'
  | 'notContainsErrors'
  | 'timePeriod'
  | 'top10'
  | 'aboveAverage'
  | 'colorScale'
  | 'dataBar'
  | 'iconSet';

/** `timePeriod` 规则的封闭日期周期枚举（ECMA-376 ST_TimePeriod）。 */
export type TimePeriod =
  | 'today'
  | 'yesterday'
  | 'tomorrow'
  | 'last7Days'
  | 'thisMonth'
  | 'lastMonth'
  | 'nextMonth'
  | 'thisWeek'
  | 'lastWeek'
  | 'nextWeek';

const TIME_PERIODS: ReadonlySet<string> = new Set<TimePeriod>([
  'today',
  'yesterday',
  'tomorrow',
  'last7Days',
  'thisMonth',
  'lastMonth',
  'nextMonth',
  'thisWeek',
  'lastWeek',
  'nextWeek',
]);

/** 比较算子（`cellIs` 用）。 */
export type CfOperator =
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'equal'
  | 'notEqual'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'between'
  | 'notBetween';

/** 图标集名称（ECMA-376 的封闭枚举）。 */
export type IconSetName =
  | '3Arrows'
  | '3ArrowsGray'
  | '3Flags'
  | '3TrafficLights1'
  | '3TrafficLights2'
  | '3Signs'
  | '3Symbols'
  | '3Symbols2'
  | '4Arrows'
  | '4ArrowsGray'
  | '4RedToBlack'
  | '4Rating'
  | '4TrafficLights'
  | '5Arrows'
  | '5ArrowsGray'
  | '5Rating'
  | '5Quarters';

const ICON_SET_NAMES: ReadonlySet<string> = new Set<IconSetName>([
  '3Arrows',
  '3ArrowsGray',
  '3Flags',
  '3TrafficLights1',
  '3TrafficLights2',
  '3Signs',
  '3Symbols',
  '3Symbols2',
  '4Arrows',
  '4ArrowsGray',
  '4RedToBlack',
  '4Rating',
  '4TrafficLights',
  '5Arrows',
  '5ArrowsGray',
  '5Rating',
  '5Quarters',
]);

/** 差异格式（映射到 `dxfs` 里的一条 `dxf`）。 */
export interface DifferentialFormat {
  /** 填充色（ARGB 或 6 位 RGB，自动补 `FF` 不透明前缀）。 */
  readonly fill_color?: string;
  readonly font_color?: string;
  readonly font_bold?: boolean;
  readonly border_color?: string;
}

/** 颜色刻度的一个端点。 */
export interface ColorScaleStop {
  readonly type: 'min' | 'max' | 'num' | 'percent' | 'percentile' | 'formula';
  readonly color: string;
  readonly value?: string;
}

/** 数据条描述。 */
export interface DataBarSpec {
  readonly color: string;
  readonly show_value?: boolean;
}

/** 图标集描述。 */
export interface IconSetSpec {
  readonly icon_set: IconSetName;
  readonly show_value?: boolean;
  readonly reverse?: boolean;
}

/** 一条条件格式规则。 */
export interface CfRule {
  /** 应用范围（sqref；单个 A1 区域文本）。 */
  readonly range: string;
  /** 优先级（1 = 最高；同一规则集内必须互不相同）。 */
  readonly priority: number;
  readonly type: CfRuleType;
  readonly operator?: CfOperator;
  readonly formulas?: readonly string[];
  readonly text?: string;
  readonly rank?: number;
  readonly percent?: boolean;
  /** `aboveAverage` 用：是否"高于平均值"（Excel 默认真；显式 false 才会写出 `aboveAverage="0"`）。 */
  readonly above_average?: boolean;
  /** `aboveAverage` 用：是否"等于平均值也算命中"。 */
  readonly equal_average?: boolean;
  /** `aboveAverage` 用：标准差倍数（≥0 的有限数）。 */
  readonly std_dev?: number;
  /** `timePeriod` 用：命中的日期周期（封闭枚举）。 */
  readonly time_period?: TimePeriod;
  readonly stop_if_true?: boolean;
  readonly format?: DifferentialFormat;
  readonly color_scale?: readonly ColorScaleStop[];
  readonly data_bar?: DataBarSpec;
  readonly icon_set?: IconSetSpec;
  /** 为真 ⇒ 该规则走 x14 扩展块（见文件头）。 */
  readonly extended?: boolean;
}

const TYPES_REQUIRING_FORMULA: ReadonlySet<CfRuleType> = new Set([
  'cellIs',
  'expression',
  'containsText',
  'notContainsText',
  'beginsWith',
  'endsWith',
]);

const TYPES_REQUIRING_OPERATOR: ReadonlySet<CfRuleType> = new Set(['cellIs']);

const TEXT_TYPES: ReadonlySet<CfRuleType> = new Set([
  'containsText',
  'notContainsText',
  'beginsWith',
  'endsWith',
]);

const EXTENDABLE_TYPES: ReadonlySet<CfRuleType> = new Set(['colorScale', 'dataBar', 'iconSet']);

/** 颜色归一化为 8 位 ARGB 大写。@throws {ValidationError} 非法色值 */
export function normalizeColor(color: string): string {
  if (typeof color !== 'string' || !/^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(color)) {
    throw new ValidationError(`颜色必须是 6 或 8 位十六进制，收到 ${JSON.stringify(color)}`);
  }
  return (color.length === 6 ? `FF${color}` : color).toUpperCase();
}

/**
 * 校验 sqref 文本：**允许空格分隔的多个区域**。
 *
 * Excel 把同一条规则应用到不连续区域时写成一条 `sqref="A1:A10 C1:C10"`；逐个 token
 * 交给 `parseRange`（非法 token 在此抛），既接受上述真实形状，又不放过真正的畸形区域。
 * @throws {ValidationError} 空文本或任一段非法
 */
function validateCfRange(range: string): void {
  if (typeof range !== 'string') {
    throw new ValidationError(`条件格式的 range 必须是字符串，收到 ${JSON.stringify(range)}`);
  }
  const parts = range.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new ValidationError('条件格式的 range 不能为空');
  }
  for (const part of parts) parseRange(part);
}

/** 规则形状校验。@throws {ValidationError} */
export function validateCfRule(rule: CfRule): void {
  validateCfRange(rule.range); // 非法范围文本在此抛（含空格分隔多区域）
  if (!Number.isInteger(rule.priority) || rule.priority < 1) {
    throw new ValidationError(`条件格式的优先级必须是 ≥1 的整数，收到 ${String(rule.priority)}`);
  }
  if (TYPES_REQUIRING_OPERATOR.has(rule.type) && rule.operator === undefined) {
    throw new ValidationError(`条件格式类型 ${rule.type} 需要 operator`);
  }
  if (!TYPES_REQUIRING_OPERATOR.has(rule.type) && rule.operator !== undefined) {
    throw new ValidationError(`条件格式类型 ${rule.type} 不接受 operator`);
  }
  if (
    rule.type !== 'aboveAverage' &&
    (rule.above_average !== undefined || rule.equal_average !== undefined || rule.std_dev !== undefined)
  ) {
    throw new ValidationError(`above_average / equal_average / std_dev 只对 aboveAverage 有意义，收到 ${rule.type}`);
  }
  if (rule.std_dev !== undefined && (!Number.isFinite(rule.std_dev) || rule.std_dev < 0)) {
    throw new ValidationError(`std_dev 必须是非负有限数，收到 ${String(rule.std_dev)}`);
  }
  if (rule.type === 'timePeriod') {
    if (rule.time_period === undefined) {
      throw new ValidationError('timePeriod 需要 time_period');
    }
    if (!TIME_PERIODS.has(rule.time_period)) {
      throw new ValidationError(`未知的 time_period：${JSON.stringify(rule.time_period)}`);
    }
  } else if (rule.time_period !== undefined) {
    throw new ValidationError(`time_period 只对 timePeriod 有意义，收到 ${rule.type}`);
  }
  if (TYPES_REQUIRING_FORMULA.has(rule.type) && (rule.formulas === undefined || rule.formulas.length === 0)) {
    throw new ValidationError(`条件格式类型 ${rule.type} 需要 formulas（本模块不替调用方编造公式）`);
  }
  if (TEXT_TYPES.has(rule.type) && (rule.text === undefined || rule.text.length === 0)) {
    throw new ValidationError(`条件格式类型 ${rule.type} 需要 text`);
  }
  if (rule.type === 'top10' && rule.rank !== undefined && (!Number.isInteger(rule.rank) || rule.rank < 1)) {
    throw new ValidationError(`top10 的 rank 必须是 ≥1 的整数，收到 ${String(rule.rank)}`);
  }
  if (rule.type === 'colorScale') {
    const stops = rule.color_scale;
    if (stops === undefined || stops.length < 2 || stops.length > 3) {
      throw new ValidationError('colorScale 需要 2 或 3 个端点');
    }
    for (const stop of stops) {
      normalizeColor(stop.color);
      if (stop.type === 'num' || stop.type === 'percent' || stop.type === 'percentile' || stop.type === 'formula') {
        if (stop.value === undefined) {
          throw new ValidationError(`colorScale 端点的类型 ${stop.type} 需要 value`);
        }
      }
    }
  }
  if (rule.type === 'dataBar') {
    if (rule.data_bar === undefined) {
      throw new ValidationError('dataBar 需要 data_bar 描述');
    }
    normalizeColor(rule.data_bar.color);
  }
  if (rule.type === 'iconSet') {
    if (rule.icon_set === undefined) {
      throw new ValidationError('iconSet 需要 icon_set 描述');
    }
    if (!ICON_SET_NAMES.has(rule.icon_set.icon_set)) {
      throw new ValidationError(`未知图标集：${JSON.stringify(rule.icon_set.icon_set)}`);
    }
  }
  if (rule.extended === true && !EXTENDABLE_TYPES.has(rule.type)) {
    throw new ValidationError(`只有 colorScale / dataBar / iconSet 可以走 x14 扩展块，收到 ${rule.type}`);
  }
  if (rule.extended === true && rule.format !== undefined) {
    // 扩展块的这三类规则自带配色描述；外挂 dxf 在 x14 里无法如实表达 ⇒ 显式失败而非丢弃
    throw new ValidationError('走 x14 扩展块的规则不接受 format（配色由 color_scale / data_bar / icon_set 表达）');
  }
  if (rule.format !== undefined) {
    if (rule.format.fill_color !== undefined) normalizeColor(rule.format.fill_color);
    if (rule.format.font_color !== undefined) normalizeColor(rule.format.font_color);
    if (rule.format.border_color !== undefined) normalizeColor(rule.format.border_color);
  }
}

// ---------------------------------------------------------------------------
// 优先级（XLS-11）
// ---------------------------------------------------------------------------

/**
 * 按优先级**稳定排序并重编号**为 `1..N`（消掉空洞与重复引发的歧义）。
 *
 * 重复优先级 ⇒ 抛 `ValidationError`：同优先级是**真歧义**，不猜顺序。
 * @throws {ValidationError} 优先级非法或重复
 */
export function normalizePriorities(rules: readonly CfRule[]): readonly CfRule[] {
  const seen = new Set<number>();
  for (const rule of rules) {
    if (!Number.isInteger(rule.priority) || rule.priority < 1) {
      throw new ValidationError(`条件格式的优先级必须是 ≥1 的整数，收到 ${String(rule.priority)}`);
    }
    if (seen.has(rule.priority)) {
      throw new ValidationError(`条件格式存在重复优先级 ${String(rule.priority)}：次序有歧义，拒绝猜测`);
    }
    seen.add(rule.priority);
  }
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);
  return Object.freeze(ordered.map((rule, index) => Object.freeze({ ...rule, priority: index + 1 })));
}

/** 按优先级升序排列（不重编号）。 */
export function sortRulesByPriority(rules: readonly CfRule[]): readonly CfRule[] {
  return Object.freeze([...rules].sort((a, b) => a.priority - b.priority));
}

// ---------------------------------------------------------------------------
// 应用范围迁移 / 清除（XLS-11）
// ---------------------------------------------------------------------------

function intervalOf(range: string): { readonly start: CellReference; readonly end: CellReference } {
  const parsed = parseRange(range);
  return { start: parsed.start, end: parsed.end };
}

function intervalText(start: CellReference, end: CellReference): string {
  const format = (reference: CellReference): string =>
    `${reference.abs_column ? '$' : ''}${columnNumberToLetters(reference.column)}${reference.abs_row ? '$' : ''}${String(reference.row)}`;
  const first = format(start);
  const last = format(end);
  return first === last ? first : `${first}:${last}`;
}

/** 行轴区间迁移结果。 */
export type IntervalMigration =
  | { readonly ok: true; readonly range: string }
  | { readonly ok: false; readonly reason: 'deleted' };

/**
 * 行轴区间迁移（插入用 `reference.ts` 的映射；删除按区间截短，整体删掉才丢弃）。
 * @throws {ValidationError} 参数非法
 */
export function migrateIntervalRows(
  range: string,
  at: number,
  count: number,
  mode: 'insert' | 'delete',
): IntervalMigration {
  if (!Number.isInteger(at) || at < 1) {
    throw new ValidationError(`区间迁移的 at 必须是 ≥1 的整数，收到 ${String(at)}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ValidationError(`区间迁移的 count 必须是 ≥1 的整数，收到 ${String(count)}`);
  }
  const { start, end } = intervalOf(range);
  if (mode === 'insert') {
    // 两端分别按"行插入"规则下移；插入落在区间内部时区间被撑大——正是所需语义
    const mappedStart = mapReferenceOnRowInsert(start, at, count);
    const mappedEnd = mapReferenceOnRowInsert(end, at, count);
    /* c8 ignore next -- 行插入对两端恒为 ok */
    if (!mappedStart.ok || !mappedEnd.ok) {
      throw new ValidationError('行插入不应产生 deleted 结果');
    }
    return { ok: true, range: intervalText(mappedStart.reference, mappedEnd.reference) };
  }
  const lastDeleted = at + count - 1;
  if (end.row < at) {
    return { ok: true, range: intervalText(start, end) };
  }
  if (start.row > lastDeleted) {
    return {
      ok: true,
      range: intervalText({ ...start, row: start.row - count }, { ...end, row: end.row - count }),
    };
  }
  if (start.row >= at && end.row <= lastDeleted) {
    return { ok: false, reason: 'deleted' };
  }
  // 部分覆盖 ⇒ 截短到存活的部分（不编造新行号，只是把两端收到存活边界）
  const newStartRow = start.row >= at ? at : start.row;
  const newEndRow = end.row <= lastDeleted ? at - 1 : end.row - count;
  return { ok: true, range: intervalText({ ...start, row: newStartRow }, { ...end, row: newEndRow }) };
}

/** 区间迁移结果（带被丢弃登记）。 */
export interface CfRuleMigrationResult {
  readonly rules: readonly CfRule[];
  /** 因范围被整体删掉而丢弃的规则（优先级 + 原范围），可审计。 */
  readonly dropped: readonly { readonly priority: number; readonly range: string }[];
}

/** 按行增删迁移全部规则的应用范围。@throws {ValidationError} */
export function migrateCfRuleRanges(
  rules: readonly CfRule[],
  at: number,
  count: number,
  mode: 'insert' | 'delete',
): CfRuleMigrationResult {
  const kept: CfRule[] = [];
  const dropped: { priority: number; range: string }[] = [];
  for (const rule of rules) {
    const migrated = migrateIntervalRows(rule.range, at, count, mode);
    if (migrated.ok) kept.push(Object.freeze({ ...rule, range: migrated.range }));
    else dropped.push({ priority: rule.priority, range: rule.range });
  }
  return Object.freeze({ rules: Object.freeze(kept), dropped: Object.freeze(dropped) });
}

/** 清除方式：`exact` = 范围完全相同；`intersect` = 与给定范围有交集。 */
export type ClearMode = 'exact' | 'intersect';

/** 按范围清除规则。@throws {ValidationError} 范围文本非法 */
export function clearRulesForRange(
  rules: readonly CfRule[],
  range: string,
  mode: ClearMode = 'exact',
): readonly CfRule[] {
  const target = parseRange(range);
  const overlaps = (rule: CfRule): boolean => {
    const current = parseRange(rule.range);
    return (
      current.start.column <= target.end.column &&
      current.end.column >= target.start.column &&
      current.start.row <= target.end.row &&
      current.end.row >= target.start.row
    );
  };
  if (mode === 'intersect') {
    return Object.freeze(rules.filter((rule) => !overlaps(rule)));
  }
  return Object.freeze(rules.filter((rule) => rule.range !== range.trim()));
}

/** 清空全部规则。 */
export function clearAllRules(): readonly CfRule[] {
  return Object.freeze([]);
}

/** 删除指定下标的规则。@throws {ValidationError} 下标越界 */
export function removeRuleAt(rules: readonly CfRule[], index: number): readonly CfRule[] {
  if (!Number.isInteger(index) || index < 0 || index >= rules.length) {
    throw new ValidationError(`removeRuleAt 的下标越界：${String(index)}`);
  }
  const next = [...rules];
  next.splice(index, 1);
  return Object.freeze(next);
}

// ---------------------------------------------------------------------------
// 确定性 x14 GUID
// ---------------------------------------------------------------------------

function hash32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

/**
 * 由规则键生成**确定性** GUID（同键 ⇒ 同 GUID；无随机源，满足内核确定性纪律）。
 * 版本位固定为 4，变体位固定为 8（视觉上就是一枚格式合法的 GUID）。
 */
export function deterministicX14Id(key: string): string {
  const raw =
    hex8(hash32(key, 0x811c9dc5)) +
    hex8(hash32(key, 0x01000193)) +
    hex8(hash32(key, 0x9e3779b9)) +
    hex8(hash32(key, 0x85ebca6b));
  const versioned = `${raw.slice(0, 12)}4${raw.slice(13, 16)}8${raw.slice(17)}`;
  return `{${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${versioned.slice(16, 20)}-${versioned.slice(20)}}`;
}

/** 该规则是否走 x14 扩展块。 */
export function requiresX14(rule: CfRule): boolean {
  return rule.extended === true;
}

// ---------------------------------------------------------------------------
// OOXML 片段
// ---------------------------------------------------------------------------

/** x14 扩展命名空间（工作表 `extLst` 下扩展部件的默认命名空间）。 */
export const X14_NAMESPACE = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
/** Excel 2006 `xm` 命名空间（x14 块里引用范围用）。 */
export const XM_NAMESPACE = 'http://schemas.microsoft.com/office/excel/2006/main';
/** 工作表 `extLst` 中承载 x14 条件格式的固定 `ext` URI。 */
export const X14_CF_EXT_URI = '{B025F937-C7B1-47D3-B67F-A62EFF666E3E}';

function formatKey(format: DifferentialFormat): string {
  return [
    format.fill_color === undefined ? '' : normalizeColor(format.fill_color),
    format.font_color === undefined ? '' : normalizeColor(format.font_color),
    format.font_bold === true ? 'b' : '',
    format.border_color === undefined ? '' : normalizeColor(format.border_color),
  ].join('|');
}

function dxfElement(format: DifferentialFormat): XmlElement {
  const children: XmlElement[] = [];
  if (format.font_color !== undefined || format.font_bold === true) {
    const fontChildren: XmlElement[] = [];
    if (format.font_bold === true) fontChildren.push(el('b'));
    if (format.font_color !== undefined) fontChildren.push(el('color', [attr('rgb', normalizeColor(format.font_color))]));
    children.push(el('font', [], fontChildren));
  }
  if (format.fill_color !== undefined) {
    children.push(
      el('fill', [], [
        el('patternFill', [], [el('bgColor', [attr('rgb', normalizeColor(format.fill_color))])]),
      ]),
    );
  }
  if (format.border_color !== undefined) {
    const side = (): XmlElement => el('color', [attr('rgb', normalizeColor(format.border_color as string))]);
    children.push(el('border', [], [el('left', [], [side()]), el('right', [], [side()]), el('top', [], [side()]), el('bottom', [], [side()])]));
  }
  return el('dxf', [], children);
}

/** 给根元素补上默认命名空间声明，使片段可**独立解析**（嵌进工作表时属合法冗余声明）。 */
function standalone(element: XmlElement): XmlElement {
  return el(element.name, [attr('xmlns', SPREADSHEETML_NAMESPACE), ...element.attributes], element.children);
}

/**
 * 产出 `<dxfs count="N">…</dxfs>` 片段；没有差异格式时返回 `null`。
 * @throws {ValidationError} 色值非法
 */
export function buildDxfsXml(formats: readonly DifferentialFormat[]): string | null {
  if (formats.length === 0) return null;
  return serializeXmlNode(standalone(el('dxfs', [attr('count', String(formats.length))], formats.map(dxfElement))));
}

function cfvoElement(stop: ColorScaleStop): XmlElement {
  const attributes: XmlAttribute[] = [attr('type', stop.type)];
  if (stop.value !== undefined) attributes.push(attr('val', stop.value));
  return el('cfvo', attributes);
}

/** 规则的标准 `<cfRule>` 元素（`dxfId` 由差异格式表给出）。@throws {ValidationError} */
export function buildCfRuleElement(rule: CfRule, dxfId: number | undefined): XmlElement {
  validateCfRule(rule);
  const attributes: XmlAttribute[] = [attr('type', rule.type)];
  if (dxfId !== undefined) attributes.push(attr('dxfId', String(dxfId)));
  attributes.push(attr('priority', String(rule.priority)));
  if (rule.stop_if_true === true) attributes.push(attr('stopIfTrue', '1'));
  if (rule.operator !== undefined) attributes.push(attr('operator', rule.operator));
  if (rule.text !== undefined) attributes.push(attr('text', rule.text));
  if (rule.type === 'top10') {
    attributes.push(attr('rank', String(rule.rank ?? 10)));
    if (rule.percent === true) attributes.push(attr('percent', '1'));
  }
  if (rule.type === 'aboveAverage') {
    if (rule.above_average !== undefined) attributes.push(attr('aboveAverage', rule.above_average ? '1' : '0'));
    if (rule.equal_average === true) attributes.push(attr('equalAverage', '1'));
    if (rule.std_dev !== undefined) attributes.push(attr('stdDev', String(rule.std_dev)));
  }
  if (rule.type === 'timePeriod' && rule.time_period !== undefined) {
    attributes.push(attr('timePeriod', rule.time_period));
  }

  const children: XmlElement[] = [];
  for (const formula of rule.formulas ?? []) {
    children.push(el('formula', [], [formula]));
  }
  if (rule.type === 'colorScale') {
    const stops = rule.color_scale ?? [];
    children.push(
      el('colorScale', [], [
        ...stops.map(cfvoElement),
        ...stops.map((stop) => el('color', [attr('rgb', normalizeColor(stop.color))])),
      ]),
    );
  }
  if (rule.type === 'dataBar' && rule.data_bar !== undefined) {
    const bar = rule.data_bar;
    children.push(
      el('dataBar', [attr('showValue', bar.show_value === false ? '0' : '1')], [
        el('cfvo', [attr('type', 'min')]),
        el('cfvo', [attr('type', 'max')]),
        el('color', [attr('rgb', normalizeColor(bar.color))]),
      ]),
    );
  }
  if (rule.type === 'iconSet' && rule.icon_set !== undefined) {
    children.push(
      el('iconSet', [
        attr('iconSet', rule.icon_set.icon_set),
        attr('showValue', rule.icon_set.show_value === false ? '0' : '1'),
        ...(rule.icon_set.reverse === true ? [attr('reverse', '1')] : []),
      ]),
    );
  }
  return el('cfRule', attributes, children);
}

/** x14 版的 `<x14:cfRule>`（type + GUID；格式内联在子元素里）。@throws {ValidationError} */
export function buildX14CfRuleElement(rule: CfRule): XmlElement {
  validateCfRule(rule);
  const attributes: XmlAttribute[] = [
    attr('type', rule.type),
    attr('id', deterministicX14Id(`${rule.range}#${String(rule.priority)}#${rule.type}`)),
  ];
  if (rule.stop_if_true === true) attributes.push(attr('stopIfTrue', '1'));

  const children: XmlElement[] = [];
  if (rule.type === 'colorScale') {
    const stops = rule.color_scale ?? [];
    children.push(
      el('x14:colorScale', [], [
        ...stops.map(cfvoElement),
        ...stops.map((stop) => el('x14:color', [attr('rgb', normalizeColor(stop.color))])),
      ]),
    );
  }
  if (rule.type === 'dataBar' && rule.data_bar !== undefined) {
    const bar = rule.data_bar;
    children.push(
      el('x14:dataBar', [attr('minLength', '0'), attr('maxLength', '100'), attr('showValue', bar.show_value === false ? '0' : '1')], [
        el('x14:cfvo', [attr('type', 'autoMin')]),
        el('x14:cfvo', [attr('type', 'autoMax')]),
        el('x14:fillColor', [attr('rgb', normalizeColor(bar.color))]),
      ]),
    );
  }
  if (rule.type === 'iconSet' && rule.icon_set !== undefined) {
    const spec = rule.icon_set;
    children.push(
      el('x14:iconSet', [
        attr('iconSet', spec.icon_set),
        attr('showValue', spec.show_value === false ? '0' : '1'),
        ...(spec.reverse === true ? [attr('reverse', '1')] : []),
      ]),
    );
  }
  return el('x14:cfRule', attributes, children);
}

/**
 * 标准块：按范围分组，**逐块**产出 `<conditionalFormatting sqref="…">…</conditionalFormatting>`
 * 文本（同一范围内多条规则共用一块）。@throws {ValidationError}
 */
export function buildConditionalFormattingBlocks(
  rules: readonly CfRule[],
  dxfIds: ReadonlyMap<string, number>,
): readonly string[] {
  const order: string[] = [];
  const groups = new Map<string, CfRule[]>();
  for (const rule of rules) {
    let bucket = groups.get(rule.range);
    if (bucket === undefined) {
      bucket = [];
      groups.set(rule.range, bucket);
      order.push(rule.range);
    }
    bucket.push(rule);
  }
  return Object.freeze(
    order.map((range) => serializedConditionalFormatting(range, groups.get(range) ?? [], dxfIds)),
  );
}

/**
 * 标准块拼接（同一工作表可有多个并列的 `conditionalFormatting`）。
 * 没有任何规则时返回 `null`。@throws {ValidationError}
 */
export function buildConditionalFormattingXml(
  rules: readonly CfRule[],
  dxfIds: ReadonlyMap<string, number>,
): string | null {
  const blocks = buildConditionalFormattingBlocks(rules, dxfIds);
  return blocks.length === 0 ? null : blocks.join('');
}

function serializedConditionalFormatting(
  range: string,
  rules: readonly CfRule[],
  dxfIds: ReadonlyMap<string, number>,
): string {
  const elements = rules.map((rule) =>
    buildCfRuleElement(rule, rule.format === undefined ? undefined : dxfIds.get(formatKey(rule.format))),
  );
  return serializeXmlNode(standalone(el('conditionalFormatting', [attr('sqref', range)], elements)));
}

/**
 * x14 块：`<x14:conditionalFormattings>`（自身声明命名空间，可直接贴进工作表的 `extLst`）。
 * 没有扩展规则时返回 `null`。@throws {ValidationError}
 */
export function buildX14ConditionalFormattingXml(rules: readonly CfRule[]): string | null {
  if (rules.length === 0) return null;
  const blocks = rules.map((rule) =>
    el('x14:conditionalFormatting', [attr('xmlns:xm', XM_NAMESPACE)], [
      buildX14CfRuleElement(rule),
      el('xm:sqref', [], [rule.range]),
    ]),
  );
  return serializeXmlNode(el('x14:conditionalFormattings', [attr('xmlns:x14', X14_NAMESPACE)], blocks));
}

/** 编译产物：一份可直接写进文件的完整条件格式套装。 */
export interface CompiledConditionalFormats {
  /** 优先级归一化后的规则（`1..N`）。 */
  readonly rules: readonly CfRule[];
  /** `<dxfs>` 片段；无差异格式时为 `null`。 */
  readonly dxfs_xml: string | null;
  /** 标准 `<conditionalFormatting>` 块；无标准规则时为 `null`。 */
  readonly conditional_formatting_xml: string | null;
  /** x14 扩展块；无扩展规则时为 `null`。 */
  readonly x14_xml: string | null;
  /** 差异格式键 → `dxfId`（组装 `<cfRule dxfId>` 与 `<dxfs>` 时用的是同一张表）。 */
  readonly dxf_ids: ReadonlyMap<string, number>;
}

/**
 * 一次编译：归一化优先级 → 去重差异格式 → 分组产出标准块与 x14 块。
 *
 * 扩展规则（`extended: true`）**只**出现在 x14 块里（见文件头对取舍的声明）。
 * @throws {ValidationError} 任一条规则非法或优先级重复
 */
export function compileConditionalFormats(rules: readonly CfRule[]): CompiledConditionalFormats {
  const normalized = normalizePriorities(rules);
  for (const rule of normalized) validateCfRule(rule);

  const dxfFormats: DifferentialFormat[] = [];
  const dxfIds = new Map<string, number>();
  for (const rule of normalized) {
    if (rule.format === undefined || requiresX14(rule)) continue;
    const key = formatKey(rule.format);
    if (dxfIds.has(key)) continue;
    dxfIds.set(key, dxfFormats.length);
    dxfFormats.push(rule.format);
  }

  const standard = normalized.filter((rule) => !requiresX14(rule));
  const extended = normalized.filter(requiresX14);

  return Object.freeze({
    rules: normalized,
    dxfs_xml: buildDxfsXml(dxfFormats),
    conditional_formatting_xml: buildConditionalFormattingXml(standard, dxfIds),
    x14_xml: buildX14ConditionalFormattingXml(extended),
    dxf_ids: dxfIds,
  });
}

// ---------------------------------------------------------------------------
// 读回（XLS-11：标准块与 dxfs 的读侧对偶）
// ---------------------------------------------------------------------------

/** 取**无命名空间**属性的原始文本（OOXML 的非限定属性）。 */
function plainAttr(element: ParsedXmlElement, localName: string): string | null {
  return attributeValue(element, '', localName);
}

function childElement(element: ParsedXmlElement, localName: string): ParsedXmlElement | null {
  return findChild(element, SPREADSHEETML_NAMESPACE, localName);
}

/** 需要一个直接子元素，缺失即抛（不静默当空）。 */
function requireChild(element: ParsedXmlElement, localName: string): ParsedXmlElement {
  const child = childElement(element, localName);
  if (child === null) throw new ValidationError(`条件格式片段缺少子元素 ${localName}`);
  return child;
}

function parseSingleDxf(element: ParsedXmlElement): DifferentialFormat {
  const format: { -readonly [K in keyof DifferentialFormat]: DifferentialFormat[K] } = {};
  const font = childElement(element, 'font');
  if (font !== null) {
    if (childElement(font, 'b') !== null) format.font_bold = true;
    const color = childElement(font, 'color');
    const rgb = color === null ? null : plainAttr(color, 'rgb');
    if (rgb !== null) format.font_color = rgb;
  }
  const fill = childElement(element, 'fill');
  if (fill !== null) {
    const patternFill = childElement(fill, 'patternFill');
    // 本模块写出用 bgColor；真实 Excel 的实色填充也可能写在 fgColor（patternType="solid"），作后备读取
    const bgColor = patternFill === null ? null : childElement(patternFill, 'bgColor');
    const fgColor = patternFill === null ? null : childElement(patternFill, 'fgColor');
    const rgb = (bgColor === null ? null : plainAttr(bgColor, 'rgb')) ?? (fgColor === null ? null : plainAttr(fgColor, 'rgb'));
    if (rgb !== null) format.fill_color = rgb;
  }
  const border = childElement(element, 'border');
  if (border !== null) {
    const left = childElement(border, 'left');
    const color = left === null ? null : childElement(left, 'color');
    const rgb = color === null ? null : plainAttr(color, 'rgb');
    if (rgb !== null) format.border_color = rgb;
  }
  return Object.freeze(format);
}

/**
 * `<dxfs>`（或含它的片段）→ 差异格式数组。@throws {ValidationError}
 *
 * 下标即 `dxfId`：{@link parseConditionalFormattingBlock} 用同一下标把 `<cfRule dxfId>` 还原成
 * `format`，因此"哪条规则用哪条 dxf"能如实读回（不靠猜）。
 */
export function parseDxfsXml(xml: string): readonly DifferentialFormat[] {
  const root = parseXml(xml);
  const container = root.localName === 'dxfs' ? root : findChild(root, SPREADSHEETML_NAMESPACE, 'dxfs');
  if (container === null) throw new ValidationError('输入片段里没有 <dxfs> 元素');
  return Object.freeze(
    childElements(container)
      .filter((child) => child.namespace === SPREADSHEETML_NAMESPACE && child.localName === 'dxf')
      .map(parseSingleDxf),
  );
}

function parseCfvoAndColors(element: ParsedXmlElement): readonly ColorScaleStop[] {
  const cfvos = childElements(element).filter(
    (child) => child.namespace === SPREADSHEETML_NAMESPACE && child.localName === 'cfvo',
  );
  const colors = childElements(element).filter(
    (child) => child.namespace === SPREADSHEETML_NAMESPACE && child.localName === 'color',
  );
  return Object.freeze(
    cfvos.map((cfvo, index) => {
      const type = (plainAttr(cfvo, 'type') ?? 'min') as ColorScaleStop['type'];
      const color = colors[index] === undefined ? 'FFFFFFFF' : (plainAttr(colors[index] as ParsedXmlElement, 'rgb') ?? 'FFFFFFFF');
      const value = plainAttr(cfvo, 'val');
      return Object.freeze(value === null ? { type, color } : { type, color, value });
    }),
  );
}

function parseCfRuleElement(element: ParsedXmlElement, range: string, dxfs: readonly DifferentialFormat[]): CfRule {
  const type = plainAttr(element, 'type') as CfRuleType | null;
  if (type === null) throw new ValidationError('cfRule 缺少 type 属性');
  const priorityRaw = plainAttr(element, 'priority');
  if (priorityRaw === null) throw new ValidationError('cfRule 缺少 priority 属性');
  const rule: { -readonly [K in keyof CfRule]: CfRule[K] } = {
    range,
    priority: Number.parseInt(priorityRaw, 10),
    type,
  };
  if (plainAttr(element, 'stopIfTrue') === '1') rule.stop_if_true = true;
  const operator = plainAttr(element, 'operator') as CfOperator | null;
  if (operator !== null) rule.operator = operator;
  const text = plainAttr(element, 'text');
  if (text !== null) rule.text = text;

  const formulas = childElements(element)
    .filter((child) => child.namespace === SPREADSHEETML_NAMESPACE && child.localName === 'formula')
    .map((child) => directText(child));
  if (formulas.length > 0) rule.formulas = Object.freeze(formulas);

  const dxfIdRaw = plainAttr(element, 'dxfId');
  if (dxfIdRaw !== null) {
    const index = Number.parseInt(dxfIdRaw, 10);
    const format = dxfs[index];
    if (format === undefined) {
      throw new ValidationError(`cfRule 引用了不存在的 dxfId=${String(index)}（dxfs 表里没有对应项）`);
    }
    rule.format = format;
  }

  if (type === 'top10') {
    const rankRaw = plainAttr(element, 'rank');
    rule.rank = rankRaw === null ? 10 : Number.parseInt(rankRaw, 10);
    if (plainAttr(element, 'percent') === '1') rule.percent = true;
  }
  if (type === 'colorScale') {
    rule.color_scale = parseCfvoAndColors(requireChild(element, 'colorScale'));
  }
  if (type === 'dataBar') {
    const bar = requireChild(element, 'dataBar');
    const color = requireChild(bar, 'color');
    const spec: { -readonly [K in keyof DataBarSpec]: DataBarSpec[K] } = { color: plainAttr(color, 'rgb') ?? 'FF000000' };
    // 写出侧总会写 showValue（1/0），读回时如实还原 true，避免默认值被静默丢成 undefined
    const showValue = plainAttr(bar, 'showValue');
    if (showValue !== null) spec.show_value = showValue !== '0';
    rule.data_bar = Object.freeze(spec);
  }
  if (type === 'iconSet') {
    const icons = requireChild(element, 'iconSet');
    const name = plainAttr(icons, 'iconSet') ?? '3TrafficLights1';
    const spec: { -readonly [K in keyof IconSetSpec]: IconSetSpec[K] } = { icon_set: name as IconSetName };
    const showValue = plainAttr(icons, 'showValue');
    if (showValue !== null) spec.show_value = showValue !== '0';
    if (plainAttr(icons, 'reverse') === '1') spec.reverse = true;
    rule.icon_set = Object.freeze(spec);
  }
  if (type === 'aboveAverage') {
    const above = plainAttr(element, 'aboveAverage');
    if (above !== null) rule.above_average = above !== '0';
    if (plainAttr(element, 'equalAverage') === '1') rule.equal_average = true;
    const stdDev = plainAttr(element, 'stdDev');
    if (stdDev !== null) rule.std_dev = Number.parseFloat(stdDev);
  }
  if (type === 'timePeriod') {
    const timePeriod = plainAttr(element, 'timePeriod');
    if (timePeriod !== null) rule.time_period = timePeriod as TimePeriod;
  }

  validateCfRule(rule); // 与写出侧同一把尺子
  return Object.freeze(rule);
}

/**
 * 单个 `<conditionalFormatting sqref="…">` 块 → 规则数组（`dxfs` 提供 `dxfId` 还原）。
 * @throws {ValidationError}
 */
export function parseConditionalFormattingBlock(xml: string, dxfs: readonly DifferentialFormat[] = []): readonly CfRule[] {
  const root = parseXml(xml);
  if (root.localName !== 'conditionalFormatting') {
    throw new ValidationError('输入片段不是 <conditionalFormatting> 块');
  }
  const range = plainAttr(root, 'sqref');
  if (range === null) throw new ValidationError('conditionalFormatting 缺少 sqref 属性');
  return Object.freeze(
    childElements(root)
      .filter((child) => child.namespace === SPREADSHEETML_NAMESPACE && child.localName === 'cfRule')
      .map((child) => parseCfRuleElement(child, range, dxfs)),
  );
}

/** 多个块（如 {@link buildConditionalFormattingBlocks} 的产物）→ 扁平规则数组。@throws {ValidationError} */
export function parseConditionalFormattingBlocks(
  blocks: readonly string[],
  dxfs: readonly DifferentialFormat[] = [],
): readonly CfRule[] {
  return Object.freeze(blocks.flatMap((block) => [...parseConditionalFormattingBlock(block, dxfs)]));
}
