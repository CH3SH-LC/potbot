/**
 * P-R02 · 中文字体**替代**与字宽度量（源模块）。
 *
 * ## 为什么这一层独立存在
 *
 * 手机端不一定装齐排版时用到的字体（`宋体` / `微软雅黑` / `等线` / 用户自带的商业字体）。
 * 真实演示软件在字体缺失时**替代**（font substitution）；替代后的字体**度量不同**，
 * 于是换行点、行高、占位宽度都会变——**替代不只是元数据改名，它会改变版式**。
 * 本模块把这件事做成**可计算、确定性的**：给定设备已装字体清单，把每个 run 请求的字体
 * 解析成一个**已装**字体，并返回**该已装字体的度量**（不是请求字体的）。
 *
 * ## 与既有 `layout-check.ts` 的关系（不重写、不冒充）
 *
 * `src/presentations/layout-check.ts` 的 `charWidthPt` 用的是**与字体无关**的固定模型
 * （全角 1.0×字号、半角 0.5、空白 0.25），只够做"会不会溢出"的量级判断，表达不了
 * "同一段文字换成等线会不会更窄"。本模块给出**字体度量表**：正因如此，
 * **当解析结果恰好是宋体时，本模块的宽度/行高与 `layout-check.ts` 逐数字一致**
 * （宋体：cjk 1.0 / latin 0.5 / line 1.2）——这给了验收一个**跨实现的交叉断言点**。
 *
 * ## 零 IO / 零墙钟 / 零随机
 *
 * 纯函数；字体表是常量；不读文件系统、不查系统字体、不用 `Date`。
 * 设备"已装字体"由调用方显式传入，本层**不猜**。
 */

import { ValidationError } from '../../../../src/protocol/index.js';

/** 与 `layout-check.ts` 同值的 EMU / pt 换算（导出以便交叉断言）。 */
export const EMU_PER_PT = 12700;

/** 字体解析失败原因（具名）。 */
export type FontResolutionErrorReason = 'empty_installed_list';

/** 字体解析层错误：输入语义不成立时抛出，**不静默降级**。 */
export class FontResolutionError extends ValidationError {
  readonly reason: FontResolutionErrorReason;

  constructor(reason: FontResolutionErrorReason, message: string) {
    super(message);
    this.name = 'FontResolutionError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 字体目录（确定性的、与机器无关的已知字体表）
// ---------------------------------------------------------------------------

/**
 * 一个已知字体的**度量**。宽度是字号的倍数；`line_height` 是行高的倍数。
 *
 * `cjk` = 该字体是否自带中日韩字形。非 CJK 字体在缺字时**不能**拿来当 CJK 替代字体
 * （否则中文会变豆腐块 / 回退到系统默认），因此替代只在"同为 CJK"的字体里找。
 */
export interface FontMetrics {
  /** 规范族名（表中顺序即候选优先级）。 */
  readonly family: string;
  /** 会被映射到本族的别名（如 `SimSun` / `宋体` 的英文名）。 */
  readonly aliases: readonly string[];
  /** 全角字形宽度（× 字号）。 */
  readonly cjk_width: number;
  /** 半角字形宽度（× 字号）。 */
  readonly latin_width: number;
  /** 空白宽度（× 字号）。 */
  readonly space_width: number;
  /** 行高（× 字号）。 */
  readonly line_height: number;
  /** 是否含 CJK 字形。 */
  readonly cjk: boolean;
}

/**
 * 已知字体目录。**顺序即 CJK 替代的候选优先级**（越靠前越先被选为替代字体）。
 * 度量取常见排版观感的近似值，不冒充某厂商精确度量文件。
 */
export const FONT_CATALOG: readonly FontMetrics[] = Object.freeze([
  Object.freeze({ family: '宋体', aliases: ['SimSun', 'NSimSun', 'Songti SC'], cjk_width: 1.0, latin_width: 0.5, space_width: 0.25, line_height: 1.2, cjk: true }),
  Object.freeze({ family: '微软雅黑', aliases: ['Microsoft YaHei', 'MSYH'], cjk_width: 1.0, latin_width: 0.55, space_width: 0.27, line_height: 1.32, cjk: true }),
  Object.freeze({ family: '黑体', aliases: ['SimHei', 'Heiti SC'], cjk_width: 1.0, latin_width: 0.5, space_width: 0.25, line_height: 1.2, cjk: true }),
  Object.freeze({ family: '楷体', aliases: ['KaiTi', 'STKaiti'], cjk_width: 1.0, latin_width: 0.5, space_width: 0.25, line_height: 1.25, cjk: true }),
  Object.freeze({ family: '等线', aliases: ['DengXian'], cjk_width: 1.0, latin_width: 0.48, space_width: 0.24, line_height: 1.28, cjk: true }),
  Object.freeze({ family: '仿宋', aliases: ['FangSong', 'STFangsong'], cjk_width: 1.0, latin_width: 0.5, space_width: 0.25, line_height: 1.2, cjk: true }),
  Object.freeze({ family: 'Noto Sans CJK SC', aliases: ['NotoSansCJK', '思源黑体'], cjk_width: 1.0, latin_width: 0.53, space_width: 0.26, line_height: 1.32, cjk: true }),
  Object.freeze({ family: 'Calibri', aliases: [], cjk_width: 1.0, latin_width: 0.5, space_width: 0.23, line_height: 1.22, cjk: false }),
  Object.freeze({ family: 'Arial', aliases: [], cjk_width: 1.0, latin_width: 0.52, space_width: 0.28, line_height: 1.15, cjk: false }),
]);

/** 缺省正文字体（未在 run 上指定字体时）。 */
export const DEFAULT_FONT_FAMILY = '宋体';

function catalogEntry(name: string): FontMetrics | undefined {
  return FONT_CATALOG.find((entry) => entry.family === name || entry.aliases.includes(name));
}

/** 一个字体族名在**目录**里是否存在（用于"未知字体"判定）。 */
export function isKnownFamily(name: string): boolean {
  return catalogEntry(name) !== undefined;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/** 替代发生的**原因**（写进结论，可解释）。 */
export type SubstitutionReason =
  | 'installed' // 请求字体已安装，未替代
  | 'default' // 未指定字体，用正文字体
  | 'cjk_fallback' // 请求的 CJK 字体缺失，替代到另一款已装 CJK 字体
  | 'latin_fallback' // 请求的纯拉丁字体缺失，替代到任一已装字体
  | 'unknown_family_fallback'; // 请求字体不在目录，替代到正文字体

/** 一次字体解析的结果。 */
export interface ResolvedFont {
  /** 请求的族名；`null` = run 未指定。 */
  readonly requested: string | null;
  /** 最终**已装**的族名（渲染实际使用的）。 */
  readonly resolved: string;
  /** 实际使用的度量（取自 `resolved`）。 */
  readonly metrics: FontMetrics;
  readonly reason: SubstitutionReason;
}

function firstInstalledCjk(installed: ReadonlySet<string>): FontMetrics | undefined {
  for (const entry of FONT_CATALOG) {
    if (!entry.cjk) continue;
    if (installed.has(entry.family) || entry.aliases.some((alias) => installed.has(alias))) {
      return entry;
    }
  }
  return undefined;
}

function firstInstalledAny(installed: ReadonlySet<string>): FontMetrics | undefined {
  for (const entry of FONT_CATALOG) {
    if (installed.has(entry.family) || entry.aliases.some((alias) => installed.has(alias))) {
      return entry;
    }
  }
  return undefined;
}

/**
 * 把一个请求字体解析成一个**已装**字体 + 其度量。
 *
 * 判定顺序（确定性，不随机）：
 * 1. `requested` 为 `null/undefined/'+'` ⇒ 正文字体（`宋体`）；若连正文字体都没装，
 *    退回 **目录里第一款已装字体**；都没有 ⇒ `empty_installed_list` 报错。
 * 2. 目录已知且已装 ⇒ 原样使用（`installed`）。
 * 3. 目录已知（含别名）但未装：
 *    - CJK 字体 ⇒ 选**已装且为 CJK 的、目录中靠前**的一款（`cjk_fallback`）；
 *    - 纯拉丁字体 ⇒ 选**任一已装**字体（`latin_fallback`）。
 * 4. 目录未知（用户自带商业字体）⇒ 正文字体 / 任一已装 CJK（`unknown_family_fallback`）。
 *
 * 关键：返回的 `metrics` 永远是 **`resolved` 的**度量——替代**改变版式**。
 */
export function resolveFont(
  requested: string | null | undefined,
  installedFonts: readonly string[],
): ResolvedFont {
  const installed = new Set(installedFonts);
  if (installed.size === 0) {
    throw new FontResolutionError('empty_installed_list', '已装字体清单为空：无法解析任何字体');
  }
  const firstCjk = firstInstalledCjk(installed) ?? firstInstalledAny(installed);
  if (firstCjk === undefined) {
    throw new FontResolutionError('empty_installed_list', '已装字体清单中没有任何目录内字体');
  }

  // 1. 未指定
  if (requested === null || requested === undefined || requested === '' || requested === '+') {
    const body = catalogEntry(DEFAULT_FONT_FAMILY);
    if (body !== undefined && (installed.has(body.family) || body.aliases.some((a) => installed.has(a)))) {
      return { requested: null, resolved: body.family, metrics: body, reason: 'default' };
    }
    return { requested: null, resolved: firstCjk.family, metrics: firstCjk, reason: 'default' };
  }

  const entry = catalogEntry(requested);
  // 4. 未知族
  if (entry === undefined) {
    return { requested, resolved: firstCjk.family, metrics: firstCjk, reason: 'unknown_family_fallback' };
  }
  // 2. 已知且已装
  if (installed.has(entry.family) || entry.aliases.some((alias) => installed.has(alias))) {
    return { requested, resolved: entry.family, metrics: entry, reason: 'installed' };
  }
  // 3. 已知但未装
  if (entry.cjk) {
    return { requested, resolved: firstCjk.family, metrics: firstCjk, reason: 'cjk_fallback' };
  }
  const anyInstalled = firstInstalledAny(installed) ?? firstCjk;
  return { requested, resolved: anyInstalled.family, metrics: anyInstalled, reason: 'latin_fallback' };
}

// ---------------------------------------------------------------------------
// 字符宽度（字体相关）
// ---------------------------------------------------------------------------

/** 全角（CJK）码点判定——与 `layout-check.ts` 同一张范围表。 */
export function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/**
 * 单字符宽度（pt），**用给定字体的度量**。
 *
 * 当 `metrics` 是宋体（cjk 1.0 / latin 0.5 / space 0.25）时，本函数与 `layout-check.ts`
 * 的 `charWidthPt` 对同一字符返回**同一个数**——这是跨实现交叉断言的基础。
 */
export function fontCharWidthPt(ch: string, sizePt: number, metrics: FontMetrics): number {
  if (ch === ' ' || ch === '\t') return metrics.space_width * sizePt;
  const code = ch.codePointAt(0) ?? 0;
  return (isWideChar(code) ? metrics.cjk_width : metrics.latin_width) * sizePt;
}
