/**
 * **W-R03 — 中文字体替代 / 缺字·字体缺失的显式反馈 / 排版差异**：类型与操作 schema 面。
 *
 * ## 本包在补哪个缺口（与 W09 排版内核的关系）
 *
 * W09 的 `src/mobile-plugins/word/rendering/` 已经提供**通用**字体解析（`FontResolver`）、
 * 逐码点度量与真实分页。它对本包的价值是**可复用的度量端口与排版引擎**，本包**不重写**它，
 * 只在其上层补三个**中文特有**的缺口：
 *
 * | 缺口 | W09 现状 | 本包补什么 |
 * |---|---|---|
 * | **槽位感知** | `RunSpec.fontFamily` 是**单一字体**；而 OOXML `w:rFonts` 有 `ascii`/`hAnsi`/`eastAsia`/`cs` 四槽，中文与西文**必须能分别取字体** | 逐码点按脚本（Han/Kana/Hangul/Latin）选择 `ascii` 或 `eastAsia` 槽，逐槽解析替代 |
 * | **缺字反馈聚合** | `line-break.ts` 对**每一次出现**的缺字码点都 push 一条 `glyph_missing`：一段两千字中文会刷出几千条重复诊断 | 本包给出**按（字体, 码点）去重**的聚合报告，总量、去重码点数、未恢复数一次说清 |
 * | **排版差异量化** | 无 | 用 W09 的 `layoutDocument` 对「替代前 / 替代后」两份规格各排一次，给出页数/行数/宽度差异 |
 *
 * ## 纪律（沿用 W09 与本项目硬要求）
 *
 * - **绝不静默换字体**：请求字体缺失或该字体缺该码点字形时，要么给出**端口确认存在**的替代
 *   （发 `substituted`），要么明确标成 `unresolved_font` / `unresolved_glyph` 并在报告里列出。
 * - **不编造**：本包只计算，不接 Android、不读文件系统、不调 Windows Office；报告里的字体集合、
 *   码点、宽度差异都是**从注入端口真实算出来的**，不是常量。
 *
 * ## 单位口径
 *
 * 几何量用 **twips**（1 pt = 20 twips，同 `src/documents/units/constants.ts`）；字号用 **pt**，
 * 进本包后按 `TWIPS_PER_POINT` 换算。与 W09 一致。
 */

import type { Twips } from '../../../../../src/mobile-plugins/word/rendering/index.js';

export type { Twips };

/** 码点脚本分类。`other` 覆盖 emoji / 数学符号 / 未归类文种——它们走 `ascii` 槽但不保证有字形。 */
export type ScriptClass = 'han' | 'kana' | 'hangul' | 'latin' | 'other';

/**
 * 一个 run 的字体槽集合。**镜像** `src/documents/model/types.ts` 的 `FontSet`
 * （OOXML `w:rFonts` 的四个属性）。`null` 表示该槽未设置。
 */
export interface FontSlotSet {
  readonly ascii: string | null;
  readonly hAnsi: string | null;
  readonly eastAsia: string | null;
  readonly cs: string | null;
}

/** 每个脚本一条**有序**候选链（先到先得）。空数组表示该脚本无替代可用。 */
export interface CjkFallbackChains {
  readonly han: readonly string[];
  readonly kana: readonly string[];
  readonly hangul: readonly string[];
  readonly latin: readonly string[];
  readonly other: readonly string[];
}

/** 解析选项。 */
export interface CjkSubstitutionOptions {
  /**
   * 设备**真实存在**的字体族集合（口径 = 端口 `hasFont` 为真）。空 = 只有被请求且已存在的字体能用。
   * 本包只用它做**候选过滤**，不假装端口没声明的字体存在。
   */
  readonly availableFonts: readonly string[];
  /** 逐脚本候选链。 */
  readonly fallbacks: CjkFallbackChains;
  /**
   * 严格模式：出现 `unresolved_font`（整族缺失且无可用替代）时抛
   * `CjkFontError('font_missing')`，与 W09 fail-closed 对齐。默认 `false`：如实返回报告，
   * 由调用方决定（例如手机排版需要尽量出图，就带豆腐块输出并把 `complete=false` 报给用户）。
   */
  readonly strict?: boolean;
}

/** 单个码点的解析结论。 */
export interface CharFontDecision {
  /** 该码点对应的字符串（代理对按 1 个决策，`char` 含 2 个 UTF-16 unit）。 */
  readonly char: string;
  readonly codePoint: number;
  readonly script: ScriptClass;
  /** 选择的 `w:rFonts` 槽：Han/Kana/Hangul → `eastAsia`，其余 → `ascii`。 */
  readonly slot: 'ascii' | 'eastAsia';
  /** 该槽声明的字体族（可能为 `null`，表示槽未设置）。 */
  readonly requestedFont: string | null;
  /** 实际参与度量的字体族；`null` 表示连可用替代都没有（`unresolved_font`）。 */
  readonly effectiveFont: string | null;
  readonly status: 'kept' | 'substituted' | 'unresolved_glyph' | 'unresolved_font';
  readonly reason:
    | 'none'
    | 'font_absent'
    | 'glyph_absent'
    | 'no_candidate'
    | 'candidate_lacks_glyph';
}

/** 一条**去重**的替代记录（按 请求字体 × 脚本 × 原因 合并）。 */
export interface SubstitutionRecord {
  readonly requestedFont: string;
  readonly substitutedBy: string;
  readonly script: ScriptClass;
  readonly reason: 'font_absent' | 'glyph_absent';
  /** 该替代覆盖的**出现次数**（不是去重码点数）。 */
  readonly affectedOccurrences: number;
}

/** 一条**去重**的缺字记录（按 字体 × 码点 合并）。 */
export interface MissingGlyphRecord {
  /** 真正参与度量、却缺该字形的字体族。 */
  readonly font: string;
  readonly codePoint: number;
  readonly char: string;
  readonly script: ScriptClass;
  /** 该缺字在该文档中出现的次数。 */
  readonly occurrences: number;
  /** 是否因替代而恢复（原始字体缺、替代字体有）。 */
  readonly recoveredBySubstitution: boolean;
  /** 恢复时用的替代字体；未恢复为 `null`。 */
  readonly substitutedBy: string | null;
}

/** 字体层报告：有哪些替代、哪些整族缺失。 */
export interface FontSubstitutionReport {
  /** 按 请求字体 × 脚本 × 原因 去重的替代记录。 */
  readonly substitutions: readonly SubstitutionRecord[];
  /** 被请求但设备不存在、且**没有任何可用替代**（`unresolved_font`）的字体族，去重升序。 */
  readonly missingFonts: readonly string[];
  /** 文档实际会用到的字体族（含替代），升序。 */
  readonly usedFonts: readonly string[];
  /** 恒为 `true`：本包不存在「悄悄换字体」路径；替代与缺失都进报告。 */
  readonly explicit: true;
}

/** 缺字层报告：聚合、去重、显式。 */
export interface MissingGlyphReport {
  /** 按 字体 × 码点 去重的缺字记录，按（字体, 码点）升序。 */
  readonly records: readonly MissingGlyphRecord[];
  /** 缺字**总出现次数**（未去重）。 */
  readonly totalMissingOccurrences: number;
  /** 去重后的缺字**码点数**。 */
  readonly distinctMissingCodePoints: number;
  /** 替代后仍缺字形的码点数（`recoveredBySubstitution === false`）。 */
  readonly unresolvedCodePoints: number;
  /** 可能出现缺字的字体族，升序。 */
  readonly fontsWithMissingGlyphs: readonly string[];
  /** `unresolvedCodePoints === 0`。为 `false` 时调用方**必须**把缺字反馈给用户，不得宣称排版完整。 */
  readonly complete: boolean;
}

/** 一次完整解析的产出。 */
export interface CjkFontResolution {
  /** 逐码点决策（按文档顺序）。 */
  readonly decisions: readonly CharFontDecision[];
  readonly fonts: FontSubstitutionReport;
  readonly glyphs: MissingGlyphReport;
  /** `fonts.missingFonts.length === 0`。为 `false` 表示有整族缺失未解决。 */
  readonly fontsComplete: boolean;
}

// ---------------------------------------------------------------------------
// 排版差异
// ---------------------------------------------------------------------------

/** 一处段落级差异。 */
export interface ParagraphLayoutDelta {
  readonly paragraphIndex: number;
  readonly lineCountBefore: number;
  readonly lineCountAfter: number;
  readonly lineCountDelta: number;
  /** 段内首行宽度差（twips，替代后 − 替代前）。 */
  readonly firstLineWidthDeltaTwips: Twips;
}

/** 「替代前 vs 替代后」的排版差异（用 W09 `layoutDocument` 各排一次真实产出）。 */
export interface LayoutDiff {
  readonly pageCountBefore: number;
  readonly pageCountAfter: number;
  readonly pageCountDelta: number;
  readonly totalLinesBefore: number;
  readonly totalLinesAfter: number;
  readonly totalLineDelta: number;
  readonly paragraphs: readonly ParagraphLayoutDelta[];
  /** 页数或任一段行数发生变化的段落下标。空 = 排版无差异。 */
  readonly changedParagraphs: readonly number[];
  readonly identical: boolean;
}

/** 排版影响测量结果：before 可能因请求字体缺失而**排不出来**——那是结论，不是错误掩盖。 */
export interface CjkLayoutImpact {
  readonly resolution: CjkFontResolution;
  /** 朴素基线排版（每 run 单字体 = 槽声明字体）。请求字体缺失时不出结果。 */
  readonly before: import('../../../../../src/mobile-plugins/word/rendering/index.js').LayoutResult | null;
  /** 替代后排版（逐槽解析、按字体边界切 run）。有 `unresolved_font` 时不出结果。 */
  readonly after: import('../../../../../src/mobile-plugins/word/rendering/index.js').LayoutResult | null;
  /** 只有 before 与 after 都产出时才有差异对象。 */
  readonly diff: LayoutDiff | null;
  /** `before`/`after` 缺失的真实原因（缺失即写入，不静默）。 */
  readonly skippedReasons: readonly string[];
}

// ---------------------------------------------------------------------------
// 操作 schema（供 OfficePlugin `apply` 描述符消费；纯声明，不含逻辑）
// ---------------------------------------------------------------------------

/** 一个可序列化的操作描述符（本仓 App 侧命令契约的窄切片）。 */
export interface CjkOperationDescriptor {
  readonly name: string;
  readonly version: number;
  readonly summary: string;
  /** 手写 JSON Schema（draft 2020-12 子集）。 */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  /** 本操作是否可能改变文档字节：字体替代只改度量，不改 DOCX。 */
  readonly mutatesDocument: boolean;
}

/**
 * 字体替代解析操作。**只读**：产出报告与排版差异，不改文档 XML
 * （真正写 `w:rFonts` 属于字符格式操作，归 W02 的 `operations/character/`）。
 */
export const CJK_FONT_SUBSTITUTION_OPERATION: CjkOperationDescriptor = {
  name: 'word.font.resolveSubstitution',
  version: 1,
  summary: '按脚本解析 ascii/eastAsia 槽字体，显式报告替代与缺字，并量化排版差异',
  mutatesDocument: false,
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['runs', 'options'],
    additionalProperties: false,
    properties: {
      runs: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['text', 'sizePt', 'fonts'],
          properties: {
            text: { type: 'string' },
            sizePt: { type: 'number', exclusiveMinimum: 0 },
            fonts: {
              type: 'object',
              required: ['ascii', 'hAnsi', 'eastAsia', 'cs'],
              properties: {
                ascii: { type: ['string', 'null'] },
                hAnsi: { type: ['string', 'null'] },
                eastAsia: { type: ['string', 'null'] },
                cs: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
      options: {
        type: 'object',
        required: ['availableFonts', 'fallbacks'],
        properties: {
          availableFonts: { type: 'array', items: { type: 'string' } },
          strict: { type: 'boolean', default: false },
          fallbacks: {
            type: 'object',
            required: ['han', 'kana', 'hangul', 'latin', 'other'],
            properties: {
              han: { type: 'array', items: { type: 'string' } },
              kana: { type: 'array', items: { type: 'string' } },
              hangul: { type: 'array', items: { type: 'string' } },
              latin: { type: 'array', items: { type: 'string' } },
              other: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  } as const,
  outputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['fonts', 'glyphs'],
    properties: {
      decisions: { type: 'array' },
      fonts: {
        type: 'object',
        required: ['substitutions', 'missingFonts', 'usedFonts', 'explicit'],
        properties: {
          substitutions: { type: 'array' },
          missingFonts: { type: 'array', items: { type: 'string' } },
          usedFonts: { type: 'array', items: { type: 'string' } },
          explicit: { const: true },
        },
      },
      glyphs: {
        type: 'object',
        required: ['records', 'totalMissingOccurrences', 'distinctMissingCodePoints', 'unresolvedCodePoints', 'complete'],
        properties: {
          records: { type: 'array' },
          totalMissingOccurrences: { type: 'integer', minimum: 0 },
          distinctMissingCodePoints: { type: 'integer', minimum: 0 },
          unresolvedCodePoints: { type: 'integer', minimum: 0 },
          fontsWithMissingGlyphs: { type: 'array', items: { type: 'string' } },
          complete: { type: 'boolean' },
        },
      },
    },
  } as const,
};

/** 本包的结构化错误码（与 W09 `LayoutError` 口径一致：错误可分类，不是自由文本）。 */
export type CjkFontErrorCode = 'font_missing' | 'invalid_input';

export interface CjkFontErrorDetail {
  readonly requestedFont?: string;
  readonly script?: ScriptClass;
  readonly field?: string;
}

export class CjkFontError extends Error {
  readonly code: CjkFontErrorCode;
  readonly detail: CjkFontErrorDetail;

  constructor(code: CjkFontErrorCode, detail: CjkFontErrorDetail = {}) {
    super(describeCjkFontError(code, detail));
    this.name = 'CjkFontError';
    this.code = code;
    this.detail = detail;
  }
}

export function describeCjkFontError(code: CjkFontErrorCode, detail: CjkFontErrorDetail): string {
  switch (code) {
    case 'font_missing':
      return `字体整族缺失且无可用替代：「${detail.requestedFont ?? '(未指名)'}」（脚本 ${detail.script ?? '?'}）——不静默换字体`;
    case 'invalid_input':
      return `输入非法：${detail.field ?? '(未指名字段)'}`;
  }
}
