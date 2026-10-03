/**
 * X03：样式描述符 → `styles.xml` 的 `cellXfs` 集合（design-06-P8 / XLS-05）。
 *
 * ## 产出什么
 *
 * {@link buildStyleTable} 把一组 {@link CellStyle} 收敛为 `xl/styles.xml` 需要的五张表：
 * `fonts` / `fills` / `borders` / `numFmts` / `cellXfs`，以及"样式键 → cellXfs 下标"的映射。
 * `cellXfs[0]` 恒为**默认 xf**（`{}` 对应它），其余描述符按**样式键字典序**从 1 排起。
 *
 * ## 确定性
 *
 * "同样式集合 ⇒ 同输出"靠三处强制：描述符按**键**排序（与传入顺序无关）、
 * 字体/填充/边框按各自**键**排序、自定义 `numFmt` 按**格式码字典序**编号（从 164 起）。
 * 因此 `[A,B]` 与 `[B,A]` 得到逐字节相同的表。
 *
 * ## 保留槽位（Excel 的硬约束，不是本模块的偏好）
 *
 * - `fonts[0]` = 默认字体（Calibri 11）——`fontId=0` 必须可解析；
 * - `fills[0]` = `none`、`fills[1]` = `gray125`——ECMA-376 / 真实 Excel 要求这两项在最前；
 * - `borders[0]` = 全空边框——`borderId=0` 必须可解析。
 *
 * ## 如实降级（不静默丢弃）
 *
 * 只过滤线型 `'none'` 的边框边——它与"该侧未设置"渲染等价。降级动作会记进
 * {@link StyleTable.warnings}，调用方可断言、可展示，**不是**悄悄吞掉。
 */

import {
  type CellBorderLineStyle,
  type CellStyle,
} from '../styles.js';
import { canonicalizeStyle, EMPTY_STYLE_KEY, stableStringify } from './descriptor.js';
import { describeNumberFormat, FIRST_CUSTOM_NUMFMT_ID } from './numfmt.js';

// ---------------------------------------------------------------------------
// 表记录
// ---------------------------------------------------------------------------

/** 一条字体记录（`fonts` 表项）。 */
export interface FontRecord {
  readonly name: string;
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  /** 前景色 `#RRGGBB`；`null` = 不设色。 */
  readonly color: string | null;
}

/** 一条填充记录（`fills` 表项）。 */
export interface FillRecord {
  readonly pattern: 'none' | 'gray125' | 'solid';
  readonly color: string | null;
}

/** 一条边框记录（`borders` 表项）；`null` 的边 = 该边不设边框。 */
export interface BorderEdgeRecord {
  readonly style: Exclude<CellBorderLineStyle, 'none'>;
  readonly color: string | null;
}

export interface BorderRecord {
  readonly top: BorderEdgeRecord | null;
  readonly bottom: BorderEdgeRecord | null;
  readonly left: BorderEdgeRecord | null;
  readonly right: BorderEdgeRecord | null;
}

/** 一条自定义数字格式记录（`numFmts` 表项，`numFmtId ≥ 164`）。 */
export interface NumFmtRecord {
  readonly numFmtId: number;
  readonly formatCode: string;
}

/** 对齐（`xf` 的 `<alignment>` 子元素）。 */
export interface AlignmentRecord {
  readonly horizontal?: string;
  readonly vertical?: string;
  readonly wrapText?: boolean;
  readonly indent?: number;
}

/**
 * 单元格保护（`xf` 的 `<protection>` 子元素；XLS-15「有权限才修改」）。
 *
 * `locked: false` ⇒ 写 `locked="0"`（未锁定格，工作表被保护时仍可编辑）；
 * `locked: true` 是 Excel 默认，描述符层已按"渲染等价"丢弃，故这里通常只出现 `false`。
 */
export interface ProtectionRecord {
  readonly locked: boolean;
}

/** 一个 `xf`（`cellXfs` 表项），含 `applyXxx` 标志。 */
export interface CellXfRecord {
  readonly numFmtId: number;
  readonly fontId: number;
  readonly fillId: number;
  readonly borderId: number;
  readonly xfId: number;
  readonly applyFont: boolean;
  readonly applyFill: boolean;
  readonly applyBorder: boolean;
  readonly applyAlignment: boolean;
  readonly applyNumberFormat: boolean;
  readonly applyProtection: boolean;
  readonly alignment: AlignmentRecord | null;
  /** 单元格保护；`null` = 用默认（锁定）。仅 `{ locked: false }` 真正写出。 */
  readonly protection: ProtectionRecord | null;
}

/** 完整的样式表（`styles.xml` 的五张表 + 索引 + 降级提示）。 */
export interface StyleTable {
  readonly fonts: readonly FontRecord[];
  readonly fills: readonly FillRecord[];
  readonly borders: readonly BorderRecord[];
  readonly numFmts: readonly NumFmtRecord[];
  readonly cellXfs: readonly CellXfRecord[];
  /** 样式键 → `cellXfs` 下标。 */
  readonly indexByKey: ReadonlyMap<string, number>;
  /** 如实降级提示（当前只有"线型 none 的边框被并进无边框"）。 */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// 保留槽位
// ---------------------------------------------------------------------------

const DEFAULT_FONT: FontRecord = Object.freeze({
  name: 'Calibri',
  size: 11,
  bold: false,
  italic: false,
  color: null,
});

const NONE_FILL: FillRecord = Object.freeze({ pattern: 'none', color: null });
const GRAY125_FILL: FillRecord = Object.freeze({ pattern: 'gray125', color: null });

const EMPTY_BORDER: BorderRecord = Object.freeze({
  top: null,
  bottom: null,
  left: null,
  right: null,
});

/** 默认 xf（`cellXfs[0]`）——对应空描述符 `{}`。 */
const DEFAULT_XF: CellXfRecord = Object.freeze({
  numFmtId: 0,
  fontId: 0,
  fillId: 0,
  borderId: 0,
  xfId: 0,
  applyFont: false,
  applyFill: false,
  applyBorder: false,
  applyAlignment: false,
  applyNumberFormat: false,
  applyProtection: false,
  alignment: null,
  protection: null,
});

// ---------------------------------------------------------------------------
// 子构建器
// ---------------------------------------------------------------------------

function fontRecordOf(descriptor: CellStyle): FontRecord {
  return {
    name: descriptor.font_family ?? DEFAULT_FONT.name,
    size: descriptor.font_size ?? DEFAULT_FONT.size,
    bold: descriptor.bold === true,
    italic: descriptor.italic === true,
    color: descriptor.font_color ?? null,
  };
}

function hasFont(descriptor: CellStyle): boolean {
  return (
    descriptor.bold === true ||
    descriptor.italic === true ||
    descriptor.font_family !== undefined ||
    descriptor.font_size !== undefined ||
    descriptor.font_color !== undefined
  );
}

function borderEdgeOf(
  edge: { style: CellBorderLineStyle; color: string | null } | undefined,
  side: string,
  warnings: string[],
): BorderEdgeRecord | null {
  if (edge === undefined) return null;
  if (edge.style === 'none') {
    // 与"该侧未设置"渲染等价 ⇒ 如实降级并记账，不静默丢弃。
    warnings.push(`边框 ${side} 的线型为 none，按「无边框」降级（与该侧未设置等价）`);
    return null;
  }
  return { style: edge.style, color: edge.color };
}

function borderRecordOf(descriptor: CellStyle, warnings: string[]): BorderRecord | null {
  const borders = descriptor.borders;
  if (borders === undefined) return null;
  const record: BorderRecord = {
    top: borderEdgeOf(borders.top, 'top', warnings),
    bottom: borderEdgeOf(borders.bottom, 'bottom', warnings),
    left: borderEdgeOf(borders.left, 'left', warnings),
    right: borderEdgeOf(borders.right, 'right', warnings),
  };
  if (record.top === null && record.bottom === null && record.left === null && record.right === null) {
    return null; // 四边都没边框 ⇒ 等价默认，归入 borderId 0
  }
  return record;
}

/**
 * 描述符 → 保护记录。
 *
 * 只有 `locked === false`（未锁定格）才产出记录——`true` / 缺省是 Excel 默认，
 * 在描述符层已被 `dropRenderingDefaults` 收敛掉，这里再兜一次底，保证不写出冗余
 * `<protection locked="1"/>`。
 */
function protectionRecordOf(descriptor: CellStyle): ProtectionRecord | null {
  const protection = descriptor.protection;
  if (protection === undefined) return null;
  if (protection.locked !== false) return null;
  return Object.freeze({ locked: false });
}

function alignmentOf(descriptor: CellStyle): AlignmentRecord | null {
  if (
    descriptor.horizontal_align === undefined &&
    descriptor.vertical_align === undefined &&
    descriptor.wrap_text !== true &&
    descriptor.indent === undefined
  ) {
    return null;
  }
  const alignment: {
    horizontal?: string;
    vertical?: string;
    wrapText?: boolean;
    indent?: number;
  } = {};
  if (descriptor.horizontal_align !== undefined) alignment.horizontal = descriptor.horizontal_align;
  if (descriptor.vertical_align !== undefined) alignment.vertical = descriptor.vertical_align;
  if (descriptor.wrap_text === true) alignment.wrapText = true;
  if (descriptor.indent !== undefined) alignment.indent = descriptor.indent;
  return alignment;
}

// ---------------------------------------------------------------------------
// 主构建器
// ---------------------------------------------------------------------------

/**
 * 把一组样式去重并收敛成 `styles.xml` 的五张表。
 *
 * 输入顺序**不影响**输出（内部按键排序）；同一份样式可重复传入（幂等）。
 *
 * @throws {ValidationError} 任一样式含未知键或非法值（由 `canonicalizeStyle` / `describeNumberFormat` 抛）
 */
export function buildStyleTable(styles: Iterable<CellStyle>): StyleTable {
  const canonicalByKey = new Map<string, CellStyle>();

  const intern = (style: CellStyle): void => {
    const canonical = canonicalizeStyle(style);
    const key = stableStringify(canonical);
    if (!canonicalByKey.has(key)) canonicalByKey.set(key, canonical);
  };

  // 默认样式恒在，保证 cellXfs[0] 存在且可被空样式命中。
  canonicalByKey.set(EMPTY_STYLE_KEY, canonicalizeStyle({}));
  for (const style of styles) intern(style);

  const sortedKeys = [...canonicalByKey.keys()].sort();
  const nonEmptyKeys = sortedKeys.filter((key) => key !== EMPTY_STYLE_KEY);

  // --- 字体 / 填充 / 边框：先按各自键去重，再排序，最后加上保留槽位 ---
  const fontByKey = new Map<string, FontRecord>();
  const fillByKey = new Map<string, FillRecord>();
  const borderByKey = new Map<string, BorderRecord>();
  const warnings: string[] = [];

  // 逐描述符只解析一次子记录，避免重复调用 borderRecordOf 造成降级提示被记账多次。
  const fontRecordByStyleKey = new Map<string, FontRecord>();
  const fillRecordByStyleKey = new Map<string, FillRecord>();
  const borderRecordByStyleKey = new Map<string, BorderRecord | null>();

  for (const key of nonEmptyKeys) {
    const descriptor = canonicalByKey.get(key) as CellStyle;
    if (hasFont(descriptor)) {
      const font = fontRecordOf(descriptor);
      fontRecordByStyleKey.set(key, font);
      fontByKey.set(stableStringify(font), font);
    }
    if (descriptor.fill_color !== undefined) {
      const fill: FillRecord = { pattern: 'solid', color: descriptor.fill_color };
      fillRecordByStyleKey.set(key, fill);
      fillByKey.set(stableStringify(fill), fill);
    }
    const border = borderRecordOf(descriptor, warnings);
    borderRecordByStyleKey.set(key, border);
    if (border !== null) borderByKey.set(stableStringify(border), border);
  }

  const fonts: FontRecord[] = [DEFAULT_FONT, ...[...fontByKey.keys()].sort().map((k) => fontByKey.get(k) as FontRecord)];
  const fills: FillRecord[] = [
    NONE_FILL,
    GRAY125_FILL,
    ...[...fillByKey.keys()].sort().map((k) => fillByKey.get(k) as FillRecord),
  ];
  const borders: BorderRecord[] = [EMPTY_BORDER, ...[...borderByKey.keys()].sort().map((k) => borderByKey.get(k) as BorderRecord)];

  const fontIndex = new Map<string, number>();
  fonts.forEach((font, index) => fontIndex.set(stableStringify(font), index));
  const fillIndex = new Map<string, number>();
  fills.forEach((fill, index) => fillIndex.set(stableStringify(fill), index));
  const borderIndex = new Map<string, number>();
  borders.forEach((border, index) => borderIndex.set(stableStringify(border), index));

  // --- 自定义 numFmt：收集格式码 → 排序 → 从 164 编号 ---
  const customCodes = new Set<string>();
  const resolvedNumFmt = new Map<string, { numFmtId: number | null; formatCode: string | null }>();
  for (const key of nonEmptyKeys) {
    const descriptor = canonicalByKey.get(key) as CellStyle;
    const resolved = describeNumberFormat(descriptor.number_format);
    resolvedNumFmt.set(key, resolved);
    if (resolved.formatCode !== null) customCodes.add(resolved.formatCode);
  }
  const customIdByCode = new Map<string, number>();
  [...customCodes].sort().forEach((code, offset) => {
    customIdByCode.set(code, FIRST_CUSTOM_NUMFMT_ID + offset);
  });
  const numFmts: NumFmtRecord[] = [...customIdByCode.keys()]
    .sort()
    .map((code) => ({ numFmtId: customIdByCode.get(code) as number, formatCode: code }));

  // --- cellXfs：0 = 默认；其余按样式键顺序 ---
  const cellXfs: CellXfRecord[] = [DEFAULT_XF];
  const indexByKey = new Map<string, number>();
  indexByKey.set(EMPTY_STYLE_KEY, 0);

  for (const key of nonEmptyKeys) {
    const descriptor = canonicalByKey.get(key) as CellStyle;
    const resolved = resolvedNumFmt.get(key) as { numFmtId: number | null; formatCode: string | null };
    const numFmtId =
      resolved.numFmtId !== null ? resolved.numFmtId : (customIdByCode.get(resolved.formatCode as string) as number);
    const fontRecord = fontRecordByStyleKey.get(key);
    const fontId = fontRecord !== undefined ? (fontIndex.get(stableStringify(fontRecord)) as number) : 0;
    const fillRecord = fillRecordByStyleKey.get(key);
    const fillId = fillRecord !== undefined ? (fillIndex.get(stableStringify(fillRecord)) as number) : 0;
    const borderRecord = borderRecordByStyleKey.get(key) ?? null;
    const borderId = borderRecord !== null ? (borderIndex.get(stableStringify(borderRecord)) as number) : 0;
    const alignment = alignmentOf(descriptor);
    const protection = protectionRecordOf(descriptor);

    cellXfs.push({
      numFmtId,
      fontId,
      fillId,
      borderId,
      xfId: 0,
      applyFont: fontId !== 0,
      applyFill: fillId !== 0,
      applyBorder: borderId !== 0,
      applyAlignment: alignment !== null,
      applyNumberFormat: numFmtId !== 0,
      applyProtection: protection !== null,
      alignment,
      protection,
    });
    indexByKey.set(key, cellXfs.length - 1);
  }

  return Object.freeze({
    fonts,
    fills,
    borders,
    numFmts,
    cellXfs,
    indexByKey,
    warnings: Object.freeze([...warnings]),
  });
}

// ---------------------------------------------------------------------------
// XML 渲染（无依赖；供 styles.xml 直接拼接）
// ---------------------------------------------------------------------------

function escapeXmlAttribute(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function argb(color: string): string {
  return `FF${color.slice(1).toUpperCase()}`;
}

function boolAttr(name: string, value: boolean): string {
  return value ? ` ${name}="1"` : '';
}

function renderXf(xf: CellXfRecord): string {
  const head =
    `<xf numFmtId="${String(xf.numFmtId)}" fontId="${String(xf.fontId)}"` +
    ` fillId="${String(xf.fillId)}" borderId="${String(xf.borderId)}" xfId="${String(xf.xfId)}"` +
    boolAttr('applyFont', xf.applyFont) +
    boolAttr('applyFill', xf.applyFill) +
    boolAttr('applyBorder', xf.applyBorder) +
    boolAttr('applyNumberFormat', xf.applyNumberFormat) +
    boolAttr('applyAlignment', xf.applyAlignment) +
    boolAttr('applyProtection', xf.applyProtection);
  // CT_Xf 子元素顺序：alignment → protection（→ extLst）。
  const children: string[] = [];
  if (xf.alignment !== null) {
    const a = xf.alignment;
    const attrs =
      (a.horizontal !== undefined ? ` horizontal="${a.horizontal}"` : '') +
      (a.vertical !== undefined ? ` vertical="${a.vertical}"` : '') +
      (a.wrapText === true ? ' wrapText="1"' : '') +
      (a.indent !== undefined ? ` indent="${String(a.indent)}"` : '');
    children.push(`<alignment${attrs}/>`);
  }
  if (xf.protection !== null) {
    children.push(`<protection locked="${xf.protection.locked ? '1' : '0'}"/>`);
  }
  if (children.length === 0) return `${head}/>`;
  return `${head}>${children.join('')}</xf>`;
}

function renderBorderEdge(tag: string, edge: BorderEdgeRecord | null): string {
  if (edge === null) return `<${tag}/>`;
  const color = edge.color !== null ? `<color rgb="${argb(edge.color)}"/>` : '';
  return `<${tag} style="${edge.style}">${color}</${tag}>`;
}

/** `styles.xml` 各表对应的 XML 片段（顺序即 CT_Stylesheet 要求的顺序）。 */
export interface StyleTableXml {
  readonly numFmts: string;
  readonly fonts: string;
  readonly fills: string;
  readonly borders: string;
  readonly cellXfs: string;
}

/**
 * 把 {@link StyleTable} 渲染成 `styles.xml` 的片段。
 *
 * 返回的是**片段**（不含 `styleSheet` 外壳）——调用方按 `numFmts → fonts → fills →
 * borders → cellStyleXfs → cellXfs` 的顺序拼进自己的样式表，这样本模块不与既有
 * `xlsx-write.ts` 的 `dxfs` 合并逻辑打架。
 */
export function renderStyleTableXml(table: StyleTable): StyleTableXml {
  const numFmts =
    table.numFmts.length === 0
      ? ''
      : `<numFmts count="${String(table.numFmts.length)}">` +
        table.numFmts
          .map((f) => `<numFmt numFmtId="${String(f.numFmtId)}" formatCode="${escapeXmlAttribute(f.formatCode)}"/>`)
          .join('') +
        '</numFmts>';

  const fonts =
    `<fonts count="${String(table.fonts.length)}">` +
    table.fonts
      .map((font) => {
        const bold = font.bold ? '<b/>' : '';
        const italic = font.italic ? '<i/>' : '';
        const color = font.color !== null ? `<color rgb="${argb(font.color)}"/>` : '';
        return `<font>${bold}${italic}<sz val="${String(font.size)}"/>${color}<name val="${escapeXmlAttribute(font.name)}"/></font>`;
      })
      .join('') +
    '</fonts>';

  const fills =
    `<fills count="${String(table.fills.length)}">` +
    table.fills
      .map((fill) => {
        if (fill.pattern === 'none') return '<fill><patternFill patternType="none"/></fill>';
        if (fill.pattern === 'gray125') return '<fill><patternFill patternType="gray125"/></fill>';
        const fg = fill.color !== null ? `<fgColor rgb="${argb(fill.color)}"/>` : '';
        return `<fill><patternFill patternType="solid">${fg}<bgColor indexed="64"/></patternFill></fill>`;
      })
      .join('') +
    '</fills>';

  const borders =
    `<borders count="${String(table.borders.length)}">` +
    table.borders
      .map(
        (border) =>
          '<border>' +
          renderBorderEdge('left', border.left) +
          renderBorderEdge('right', border.right) +
          renderBorderEdge('top', border.top) +
          renderBorderEdge('bottom', border.bottom) +
          '<diagonal/>' +
          '</border>',
      )
      .join('') +
    '</borders>';

  const cellXfs =
    `<cellXfs count="${String(table.cellXfs.length)}">` +
    table.cellXfs.map(renderXf).join('') +
    '</cellXfs>';

  return Object.freeze({ numFmts, fonts, fills, borders, cellXfs });
}

/** 便捷入口：一组样式 → 完整 `styles.xml` 五表片段（等价于 `buildStyleTable` + `renderStyleTableXml`）。 */
export function buildStyleXmlParts(styles: Iterable<CellStyle>): StyleTableXml {
  return renderStyleTableXml(buildStyleTable(styles));
}
