/**
 * **演示文稿模板构建器**（design-02 P6「演示文稿」一行；纯函数、零 IO）。
 *
 * ## 能力合同（任务书 §6，原样落地）
 *
 * | 项 | 内容 |
 * |---|---|
 * | 最小输入 | 展示目标、受众、事实与数据 |
 * | 首版交付 | 可编辑演示文件（PPTX） |
 * | 明确边界 | **引用统一数据，不另编数字** |
 *
 * ## 「不另编数字」怎么做到**可判定**
 *
 * 单靠"我们不会编"是口号。这里把它落成两条结构约束：
 *
 * 1. **输入契约里没有数值参数位置**（合同 v1.4 R48.3）：`PresentationBuildInput`
 *    只有 `title` / `goal` / `audience` 三个**文本**字段与事实快照；没有任何 `number` 字段，
 *    Agent 想"顺手把 8 改成 10"也没有地方可放。
 * 2. **非事实文本不得含数字**：幻灯片上每一个数字都必须能指认到快照里的某条事实。
 *    因此 `title` / `goal` / `audience` 一旦含数字字符就**抛错**（不静默、不截断）。
 *    这条把"文本里冒出一个没有出处的数字"变成一个**构建期可判定的失败**，而不是事后靠人看。
 *
 * 于是判据变成：把生成文本里的**每个数字串**提取出来，逐一到事实快照里找得到出处。
 * 单测里同时用"改数字 ⇒ 文本跟着变"的镜像用例交叉验证（见 `pptx.test.ts`）。
 *
 * ## 部件链（最少但够 PowerPoint 打开）
 *
 * `[Content_Types].xml` + `_rels/.rels` → `ppt/presentation.xml` →（`sldMasterIdLst` / `sldIdLst`）
 * → `ppt/slideMasters/slideMaster1.xml` →（`sldLayoutIdLst` / `txStyles`）
 * → `ppt/slideLayouts/slideLayout1.xml`（`type="blank"`）→ `ppt/slides/slideN.xml`，
 * 另加 `ppt/theme/theme1.xml`（`fmtScheme` 四个列表各 **3 项**，少一项 PowerPoint 可能拒绝）。
 * 每一层都要有对应的 `_rels/*.rels`——**链条少一环就打不开**，这是本包风险的来源。
 *
 * ## 摘要口径（与同批 docx/xlsx 构建器**对齐**）
 *
 * `content_digest` = **产物字节的 sha256（小写十六进制）**，口径与 `docx.ts` / `xlsx.ts`
 * 完全一致（三份产物可被同一套回读/核对逻辑处理）。
 * 为什么不直接用既有助手：`src/dependency/digest.ts` 的 `canonicalDigest` 与
 * `src/fake/digest.ts` 的 `sha256Hex`/`contentDigest` **接口上都只接受 `string`**，
 * 而这里要的是字节摘要（"ZIP 字节变一个 bit ⇒ 摘要变"，R51.6）——把字节先 decode 成文本
 * 会丢信息，所以直接走 `node:crypto` 原语；这不是第三套"摘要模块"，只是一个两行的字节入口。
 *
 * ## 确定性边界
 *
 * 无 `node:fs`、无 `Date`、无 `Math.random`、无 `process.*`；XML 由 `el`/`attr` 显式构造，
 * 属性顺序即传入顺序；数字只经 `formatInteger` / `formatDecimal` 定点格式化。
 * 同一输入连跑两次 ⇒ 逐字节相等。
 */

import { digestBytes } from '../digest.js';

import type { KnownFactValue } from '../../protocol/index.js';
import { ValidationError } from '../../protocol/index.js';
import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  attr,
  el,
  formatDecimal,
  formatInteger,
  relationshipIdAt,
  serializeXmlDocument,
  writeZip,
  type ContentTypeDefault,
  type OpcPart,
  type RelationshipDeclaration,
  type RelationshipGroup,
  type XmlElement,
} from '../ooxml/index.js';
import type { KnownFactSnapshotEntry } from '../ports.js';

// ---------------------------------------------------------------------------
// 常量（命名空间 / 内容类型 / 关系类型）
// ---------------------------------------------------------------------------

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const REL_OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const REL_SLIDE_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const REL_SLIDE_LAYOUT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
const REL_THEME = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme';

const CT_PRESENTATION =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const CT_SLIDE_MASTER =
  'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml';
const CT_SLIDE_LAYOUT =
  'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml';
const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_THEME = 'application/vnd.openxmlformats-officedocument.theme+xml';

/** 幻灯片尺寸 9144000 × 6858000 EMU = 10 × 7.5 英寸（4:3，与旧版模板一致，兼容性最好）。 */
const SLIDE_WIDTH_EMU = '9144000';
const SLIDE_HEIGHT_EMU = '6858000';
const NOTES_WIDTH_EMU = '6858000';
const NOTES_HEIGHT_EMU = '9144000';

/** `p:sldMasterId` / `p:sldLayoutId` 的 id 必须 ≥ 2^31（1 与 0 保留给其它对象）。 */
const MASTER_ID = '2147483648';
const LAYOUT_ID = '2147483649';
/** `p:sldId` 必须落在 [256, 2147483647]。 */
const FIRST_SLIDE_ID = 256;

/** 幻灯片上文本框的固定几何（EMU；常量 ⇒ 逐字节可复现）。 */
const TITLE_BOX = { x: '838200', y: '457200', cx: '7772400', cy: '1470025' } as const;
const BODY_BOX = { x: '838200', y: '2057400', cx: '7772400', cy: '3076575' } as const;

/** Rela 部件的内容类型默认项（`_rels/*.rels` 靠它归类；缺它会直接被 OPC 组装拒绝）。 */
const RELATIONSHIPS_DEFAULT: ContentTypeDefault = Object.freeze({
  extension: 'rels',
  content_type: RELATIONSHIPS_CONTENT_TYPE,
});

const FACT_SLIDE_TITLE = '事实与数据';
/** 空快照时数据页的占位行：**不含任何数字**（不得为了"好看"编一个 0）。 */
const EMPTY_FACTS_PLACEHOLDER = '（本次演示未引用事实数据）';
const AUDIENCE_LABEL = '受众';
const GOAL_LABEL = '展示目标';

/** 非事实文本里出现数字 ⇒ 无法指认到事实 ⇒ 判定为"另编数字"，直接拒绝。 */
const DIGIT = /[0-9]/;

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

/**
 * 演示文稿构建输入（任务书 §6「最小输入：展示目标、受众、事实与数据」）。
 *
 * **注意这里没有任何数值参数位置**：数字只能经 `fact_snapshot` 进入产物（R48.3）。
 */
export interface PresentationBuildInput {
  /** 演示标题（文本；不得含数字，见文件头「不另编数字」）。 */
  readonly title: string;
  /** 展示目标（文本；不得含数字）。 */
  readonly goal: string;
  /** 受众（文本；不得含数字）。 */
  readonly audience: string;
  /** 事实快照（唯一的数据来源；缺失/未知的事实**不得**进这里，见 R48.4）。 */
  readonly fact_snapshot: readonly KnownFactSnapshotEntry[];
}

/** 构建结果。`bytes` 是完整 PPTX；`entry_count` 是 ZIP 条目数（与独立读回交叉核对用）。 */
export interface PresentationBuildResult {
  readonly bytes: Buffer;
  readonly entry_count: number;
  readonly content_digest: string;
}

// ---------------------------------------------------------------------------
// 文本渲染（导出 `renderFactLine`：供"不另编数字"的判定直接复用）
// ---------------------------------------------------------------------------

/**
 * 把一条事实渲染成幻灯片上的一行文本：`{fact_key}：{值}`。
 *
 * 纯函数、只读该条事实 —— 因此"这行里的数字从哪来"永远能指认到**这一条**快照。
 * 整数用 `formatInteger`、非整数用 `formatDecimal(_, 2)`：不做本地化、不做科学计数法。
 */
export function renderFactLine(entry: KnownFactSnapshotEntry): string {
  return `${entry.fact_key}：${renderFactValue(entry.value)}`;
}

/**
 * 把一条事实的**值**渲染成文本（不含 key）。
 *
 * 供 `src/presentations/model.ts` 的事实引用求值复用——**同一份数值口径**，
 * 避免演示域另造一套格式化而与既有产物分叉。本函数导出是**纯增量**：
 * 不改变 `buildPresentation` 的任何输出字节（既有 golden 常量不受影响）。
 */
export function renderFactValue(value: KnownFactValue): string {
  switch (value.type) {
    case 'number': {
      const amount = Number.isInteger(value.amount)
        ? formatInteger(value.amount)
        : formatDecimal(value.amount, 2);
      const currency = value.currency === null ? '' : ` ${value.currency}`;
      return `${amount} ${value.unit}${currency}`;
    }
    case 'date':
      return `${value.iso_date}（${value.time_zone}）`;
    case 'text':
      return value.text;
  }
}

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`演示文稿的 ${field} 必须是字符串，收到 ${typeof value}`);
  }
  if (DIGIT.test(value)) {
    throw new ValidationError(
      `演示文稿的 ${field} 含数字（${JSON.stringify(value)}）：非事实文本不得出现数字，` +
        '数字只能来自事实快照（P6「引用统一数据，不另编数字」）',
    );
  }
  return value;
}

function requireSnapshot(value: unknown): readonly KnownFactSnapshotEntry[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`fact_snapshot 必须是数组，收到 ${typeof value}`);
  }
  return value as readonly KnownFactSnapshotEntry[];
}

function assertFactEntry(entry: KnownFactSnapshotEntry, index: number): void {
  if (typeof entry.fact_key !== 'string' || entry.fact_key.length === 0) {
    throw new ValidationError(`fact_snapshot[${String(index)}].fact_key 不能为空`);
  }
  const value = entry.value as KnownFactValue | undefined;
  if (value === undefined || value === null) {
    throw new ValidationError(`fact_snapshot[${String(index)}] 缺少 value`);
  }
  if (value.type !== 'number' && value.type !== 'date' && value.type !== 'text') {
    throw new ValidationError(
      `fact_snapshot[${String(index)}] 的值种类非法：${JSON.stringify((value as { type?: unknown }).type)}` +
        '（只接受 number / date / text；unknown / not_applicable 不得进入快照）',
    );
  }
}

// ---------------------------------------------------------------------------
// XML 片段（DrawingML / PresentationML 的公共形状）
// ---------------------------------------------------------------------------

/** 非可视属性 + 组形状属性：每个 `spTree` 开头必须有的两件。 */
function groupShapeTreePreamble(): readonly XmlElement[] {
  return [
    el('p:nvGrpSpPr', [], [
      el('p:cNvPr', [attr('id', '1'), attr('name', '')]),
      el('p:cNvGrpSpPr'),
      el('p:nvPr'),
    ]),
    el('p:grpSpPr', [], [
      el('a:xfrm', [], [
        el('a:off', [attr('x', '0'), attr('y', '0')]),
        el('a:ext', [attr('cx', '0'), attr('cy', '0')]),
        el('a:chOff', [attr('x', '0'), attr('y', '0')]),
        el('a:chExt', [attr('cx', '0'), attr('cy', '0')]),
      ]),
    ]),
  ];
}

interface TextBoxSpec {
  readonly id: number;
  readonly name: string;
  readonly box: { readonly x: string; readonly y: string; readonly cx: string; readonly cy: string };
  readonly font_size_pt: number;
  readonly lines: readonly string[];
}

/** 一个矩形文本框：`p:sp` = 非可视属性 + 形状属性 + 文本体。 */
function textBox(spec: TextBoxSpec): XmlElement {
  return el('p:sp', [], [
    el('p:nvSpPr', [], [
      el('p:cNvPr', [attr('id', formatInteger(spec.id)), attr('name', spec.name)]),
      el('p:cNvSpPr', [attr('txBox', '1')]),
      el('p:nvPr'),
    ]),
    el('p:spPr', [], [
      el('a:xfrm', [], [
        el('a:off', [attr('x', spec.box.x), attr('y', spec.box.y)]),
        el('a:ext', [attr('cx', spec.box.cx), attr('cy', spec.box.cy)]),
      ]),
      el('a:prstGeom', [attr('prst', 'rect')], [el('a:avLst')]),
    ]),
    el('p:txBody', [], [
      el('a:bodyPr', [attr('wrap', 'square')]),
      el('a:lstStyle'),
      ...spec.lines.map((line) =>
        el('a:p', [], [
          el('a:r', [], [
            el('a:rPr', [
              attr('lang', 'zh-CN'),
              attr('sz', formatInteger(spec.font_size_pt * 100)),
              attr('dirty', '0'),
            ]),
            el('a:t', [], [line]),
          ]),
        ]),
      ),
    ]),
  ]);
}

function slideXml(shapes: readonly TextBoxSpec[]): string {
  return serializeXmlDocument(
    el('p:sld', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:cSld', [], [
        el('p:spTree', [], [...groupShapeTreePreamble(), ...shapes.map((shape) => textBox(shape))]),
      ]),
      el('p:clrMapOvr', [], [el('a:masterClrMapping')]),
    ]),
  );
}

// ---------------------------------------------------------------------------
// 主题（theme1.xml）
// ---------------------------------------------------------------------------

/**
 * 主题的格式方案（`a:fmtScheme`）。
 *
 * **四个列表各 3 项**——ECMA-376 的 `CT_StyleMatrix` 就是这么定义的；
 * 给少了可能在打开时被 PowerPoint 判为无效（这是 R1 风险点，见交付报告）。
 * 取值为 Office 默认主题的经典值（确定性常量，不随机器变化）。
 */
function formatScheme(): XmlElement {
  const phClr = () => el('a:schemeClr', [attr('val', 'phClr')]);

  const fillStyleLst = el('a:fillStyleLst', [], [
    el('a:solidFill', [], [phClr()]),
    el('a:gradFill', [attr('rotWithShape', '1')], [
      el('a:gsLst', [], [
        el('a:gs', [attr('pos', '0')], [
          el('a:schemeClr', [attr('val', 'phClr')], [
            el('a:tint', [attr('val', '50000')]),
            el('a:satMod', [attr('val', '300000')]),
          ]),
        ]),
        el('a:gs', [attr('pos', '100000')], [
          el('a:schemeClr', [attr('val', 'phClr')], [
            el('a:shade', [attr('val', '50000')]),
            el('a:satMod', [attr('val', '200000')]),
          ]),
        ]),
      ]),
      el('a:lin', [attr('ang', '16200000'), attr('scaled', '1')]),
    ]),
    el('a:gradFill', [attr('rotWithShape', '1')], [
      el('a:gsLst', [], [
        el('a:gs', [attr('pos', '0')], [
          el('a:schemeClr', [attr('val', 'phClr')], [
            el('a:tint', [attr('val', '100000')]),
            el('a:shade', [attr('val', '100000')]),
            el('a:satMod', [attr('val', '130000')]),
          ]),
        ]),
        el('a:gs', [attr('pos', '100000')], [
          el('a:schemeClr', [attr('val', 'phClr')], [
            el('a:tint', [attr('val', '50000')]),
            el('a:shade', [attr('val', '100000')]),
            el('a:satMod', [attr('val', '350000')]),
          ]),
        ]),
      ]),
      el('a:lin', [attr('ang', '16200000'), attr('scaled', '0')]),
    ]),
  ]);

  const lineStyle = (width: string): XmlElement =>
    el('a:ln', [
      attr('w', width),
      attr('cap', 'flat'),
      attr('cmpd', 'sng'),
      attr('algn', 'ctr'),
    ], [
      el('a:solidFill', [], [
        el('a:schemeClr', [attr('val', 'phClr')], [
          el('a:shade', [attr('val', '95000')]),
          el('a:satMod', [attr('val', '105000')]),
        ]),
      ]),
      el('a:prstDash', [attr('val', 'solid')]),
    ]);

  const lnStyleLst = el('a:lnStyleLst', [], [
    lineStyle('9525'),
    lineStyle('25400'),
    lineStyle('38100'),
  ]);

  const effectStyleLst = el('a:effectStyleLst', [], [
    el('a:effectStyle', [], [el('a:effectLst')]),
    el('a:effectStyle', [], [el('a:effectLst')]),
    el('a:effectStyle', [], [
      el('a:effectLst', [], [
        el('a:outerShdw', [
          attr('blurRad', '57150'),
          attr('dist', '19050'),
          attr('dir', '5400000'),
          attr('rotWithShape', '0'),
        ], [
          el('a:srgbClr', [attr('val', '000000')], [el('a:alpha', [attr('val', '63000')])]),
        ]),
      ]),
    ]),
  ]);

  const bgFillStyleLst = el('a:bgFillStyleLst', [], [
    el('a:solidFill', [], [phClr()]),
    el('a:solidFill', [], [
      el('a:schemeClr', [attr('val', 'phClr')], [
        el('a:tint', [attr('val', '95000')]),
        el('a:satMod', [attr('val', '170000')]),
      ]),
    ]),
    el('a:gradFill', [attr('rotWithShape', '1')], [
      el('a:gsLst', [], [
        el('a:gs', [attr('pos', '0')], [
          el('a:schemeClr', [attr('val', 'phClr')], [
            el('a:tint', [attr('val', '93000')]),
            el('a:satMod', [attr('val', '150000')]),
            el('a:shade', [attr('val', '98000')]),
            el('a:lumMod', [attr('val', '102000')]),
          ]),
        ]),
        el('a:gs', [attr('pos', '50000')], [
          el('a:schemeClr', [attr('val', 'phClr')], [
            el('a:tint', [attr('val', '98000')]),
            el('a:satMod', [attr('val', '130000')]),
            el('a:shade', [attr('val', '90000')]),
            el('a:lumMod', [attr('val', '103000')]),
          ]),
        ]),
        el('a:gs', [attr('pos', '100000')], [
          el('a:schemeClr', [attr('val', 'phClr')], [
            el('a:shade', [attr('val', '63000')]),
            el('a:satMod', [attr('val', '120000')]),
          ]),
        ]),
      ]),
      el('a:path', [attr('path', 'circle')], [
        el('a:fillToRect', [
          attr('l', '50000'),
          attr('t', '-80000'),
          attr('r', '50000'),
          attr('b', '180000'),
        ]),
      ]),
    ]),
  ]);

  return el('a:fmtScheme', [attr('name', 'potbot')], [
    fillStyleLst,
    lnStyleLst,
    effectStyleLst,
    bgFillStyleLst,
  ]);
}

/** 颜色方案：`dk1/lt1/dk2/lt2/accent1..6/hlink/folHlink` 共 **12** 项（少一项主题不完整）。 */
function colorScheme(): XmlElement {
  const srgb = (name: string, value: string): XmlElement =>
    el(name, [], [el('a:srgbClr', [attr('val', value)])]);

  return el('a:clrScheme', [attr('name', 'potbot')], [
    el('a:dk1', [], [el('a:sysClr', [attr('val', 'windowText'), attr('lastClr', '000000')])]),
    el('a:lt1', [], [el('a:sysClr', [attr('val', 'window'), attr('lastClr', 'FFFFFF')])]),
    srgb('a:dk2', '1F497D'),
    srgb('a:lt2', 'EEECE1'),
    srgb('a:accent1', '4F81BD'),
    srgb('a:accent2', 'C0504D'),
    srgb('a:accent3', '9BBB59'),
    srgb('a:accent4', '8064A2'),
    srgb('a:accent5', '4BACC6'),
    srgb('a:accent6', 'F79646'),
    srgb('a:hlink', '0000FF'),
    srgb('a:folHlink', '800080'),
  ]);
}

function fontScheme(): XmlElement {
  const font = (name: string, typeface: string): XmlElement =>
    el(name, [], [
      el('a:latin', [attr('typeface', typeface)]),
      el('a:ea', [attr('typeface', '')]),
      el('a:cs', [attr('typeface', '')]),
    ]);

  return el('a:fontScheme', [attr('name', 'potbot')], [
    font('a:majorFont', 'Calibri Light'),
    font('a:minorFont', 'Calibri'),
  ]);
}

/**
 * 主题部件（`ppt/theme/theme1.xml`）。
 *
 * 导出供 `src/presentations/render.ts` 复用——**同一套主题**，避免演示域另造一份而分叉。
 * 与 `renderFactValue` 一样是**纯增量导出**：不改变 `buildPresentation` 的任何输出字节。
 */
export function themeXml(): string {
  return serializeXmlDocument(
    el('a:theme', [attr('xmlns:a', NS_A), attr('name', 'potbot')], [
      el('a:themeElements', [], [colorScheme(), fontScheme(), formatScheme()]),
      el('a:objectDefaults'),
      el('a:extraClrSchemeLst'),
    ]),
  );
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 产物字节的内容摘要（sha256，小写十六进制）。
 *
 * 两个既有摘要助手（`src/dependency/digest.ts` 的 `canonicalDigest`、
 * `src/fake/digest.ts` 的 `sha256Hex`）**接口上都只接受 `string`**，
 * 而这里要的是**字节**摘要；把字节先 decode 成文本会丢信息。故直接走 `node:crypto` 原语
 * （同批 `docx.ts` / `xlsx.ts` 用了同一口径，三份产物可被同一套核对逻辑处理）。
 */
/**
 * 演示产物的内容摘要（**裸小写 hex**）。
 *
 * 自 W-DISC 起**委托给唯一实现** `src/artifacts/digest.ts` 的 `digestBytes`（对外符号名保留，
 * 行为逐字节不变）。
 */
export function presentationContentDigest(bytes: Uint8Array): string {
  return digestBytes(bytes);
}

/**
 * 构建一份 PPTX（纯函数、零 IO）。
 *
 * @throws {ValidationError} 标题/目标/受众含数字（另编数字）、快照结构非法、数值不可定点格式化。
 */
export function buildPresentation(input: PresentationBuildInput): PresentationBuildResult {
  const title = requireText(input.title, 'title');
  const goal = requireText(input.goal, 'goal');
  const audience = requireText(input.audience, 'audience');
  const snapshot = requireSnapshot(input.fact_snapshot);
  snapshot.forEach((entry, index) => {
    assertFactEntry(entry, index);
  });

  const factLines =
    snapshot.length === 0 ? [EMPTY_FACTS_PLACEHOLDER] : snapshot.map((entry) => renderFactLine(entry));

  const slides: readonly (readonly TextBoxSpec[])[] = [
    [
      { id: 2, name: 'Title', box: TITLE_BOX, font_size_pt: 40, lines: [title] },
      {
        id: 3,
        name: 'Body',
        box: BODY_BOX,
        font_size_pt: 18,
        lines: [`${GOAL_LABEL}：${goal}`, `${AUDIENCE_LABEL}：${audience}`],
      },
    ],
    [
      { id: 2, name: 'Title', box: TITLE_BOX, font_size_pt: 40, lines: [FACT_SLIDE_TITLE] },
      { id: 3, name: 'Body', box: BODY_BOX, font_size_pt: 18, lines: factLines },
    ],
  ];

  const parts: OpcPart[] = [
    {
      path: 'ppt/presentation.xml',
      content_type: CT_PRESENTATION,
      data: presentationXml(slides.length),
    },
    {
      path: 'ppt/slideMasters/slideMaster1.xml',
      content_type: CT_SLIDE_MASTER,
      data: slideMasterXml(),
    },
    {
      path: 'ppt/slideLayouts/slideLayout1.xml',
      content_type: CT_SLIDE_LAYOUT,
      data: slideLayoutXml(),
    },
    ...slides.map((shapes, index) => ({
      path: `ppt/slides/slide${String(index + 1)}.xml`,
      content_type: CT_SLIDE,
      data: slideXml(shapes),
    })),
    { path: 'ppt/theme/theme1.xml', content_type: CT_THEME, data: themeXml() },
  ];

  // 关系声明顺序 = `relationshipIdAt(i)` 的分配顺序，必须与 `presentationXml()` 里的引用严格对齐：
  // 组内第 0 条（rId1）= slideMaster，第 i+1 条（rId(i+2)）= 第 i 张幻灯片。
  const relationships: RelationshipGroup[] = [
    {
      owner_part_path: null,
      declarations: [
        { type: REL_OFFICE_DOCUMENT, target: 'ppt/presentation.xml' },
      ] satisfies RelationshipDeclaration[],
    },
    {
      owner_part_path: 'ppt/presentation.xml',
      declarations: [
        { type: REL_SLIDE_MASTER, target: 'slideMasters/slideMaster1.xml' },
        ...slides.map((_shapes, index) => ({
          type: REL_SLIDE,
          target: `slides/slide${String(index + 1)}.xml`,
        })),
      ] satisfies RelationshipDeclaration[],
    },
    {
      owner_part_path: 'ppt/slideMasters/slideMaster1.xml',
      declarations: [
        { type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' },
        { type: REL_THEME, target: '../theme/theme1.xml' },
      ] satisfies RelationshipDeclaration[],
    },
    {
      owner_part_path: 'ppt/slideLayouts/slideLayout1.xml',
      declarations: [
        { type: REL_SLIDE_MASTER, target: '../slideMasters/slideMaster1.xml' },
      ] satisfies RelationshipDeclaration[],
    },
    ...slides.map((_shapes, index) => ({
      owner_part_path: `ppt/slides/slide${String(index + 1)}.xml`,
      declarations: [
        { type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' },
      ] satisfies RelationshipDeclaration[],
    })),
  ];

  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [RELATIONSHIPS_DEFAULT],
    relationships,
  });
  const bytes = writeZip(assembled.entries);

  return Object.freeze({
    bytes,
    entry_count: assembled.entries.length,
    content_digest: presentationContentDigest(bytes),
  });
}

/** `ppt/presentation.xml`：`sldMasterIdLst` → `sldIdLst` → `sldSz` → `notesSz`（顺序是 schema 要求）。 */
function presentationXml(slideCount: number): string {
  return serializeXmlDocument(
    el('p:presentation', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:sldMasterIdLst', [], [
        el('p:sldMasterId', [attr('id', MASTER_ID), attr('r:id', relationshipIdAt(0))]),
      ]),
      el('p:sldIdLst', [], [
        ...Array.from({ length: slideCount }, (_unused, index) =>
          el('p:sldId', [
            attr('id', formatInteger(FIRST_SLIDE_ID + index)),
            // 关系顺序：0 = slideMaster，1..slideCount = 各幻灯片 ⇒ 幻灯片 i 是 rId(i+2)
            attr('r:id', relationshipIdAt(index + 1)),
          ]),
        ),
      ]),
      el('p:sldSz', [attr('cx', SLIDE_WIDTH_EMU), attr('cy', SLIDE_HEIGHT_EMU)]),
      el('p:notesSz', [attr('cx', NOTES_WIDTH_EMU), attr('cy', NOTES_HEIGHT_EMU)]),
    ]),
  );
}

/** `ppt/slideMasters/slideMaster1.xml`：`cSld` → `clrMap` → `sldLayoutIdLst` → `txStyles`。 */
function slideMasterXml(): string {
  const levelStyle = (sizePt: number, typeface: string): XmlElement =>
    el('a:lvl1pPr', [], [
      el('a:defRPr', [attr('sz', formatInteger(sizePt * 100))], [
        el('a:solidFill', [], [el('a:schemeClr', [attr('val', 'tx1')])]),
        el('a:latin', [attr('typeface', typeface)]),
        el('a:ea', [attr('typeface', '')]),
      ]),
    ]);

  return serializeXmlDocument(
    el('p:sldMaster', [attr('xmlns:a', NS_A), attr('xmlns:r', NS_R), attr('xmlns:p', NS_P)], [
      el('p:cSld', [], [el('p:spTree', [], [...groupShapeTreePreamble()])]),
      el('p:clrMap', [
        attr('bg1', 'lt1'),
        attr('tx1', 'dk1'),
        attr('bg2', 'lt2'),
        attr('tx2', 'dk2'),
        attr('accent1', 'accent1'),
        attr('accent2', 'accent2'),
        attr('accent3', 'accent3'),
        attr('accent4', 'accent4'),
        attr('accent5', 'accent5'),
        attr('accent6', 'accent6'),
        attr('hlink', 'hlink'),
        attr('folHlink', 'folHlink'),
      ]),
      el('p:sldLayoutIdLst', [], [
        el('p:sldLayoutId', [attr('id', LAYOUT_ID), attr('r:id', relationshipIdAt(0))]),
      ]),
      el('p:txStyles', [], [
        el('p:titleStyle', [], [levelStyle(44, '+mj-lt')]),
        el('p:bodyStyle', [], [levelStyle(28, '+mn-lt')]),
        el('p:otherStyle', [], [levelStyle(18, '+mn-lt')]),
      ]),
    ]),
  );
}

/** `ppt/slideLayouts/slideLayout1.xml`：`type="blank"` 的空白版式，供幻灯片直接挂载。 */
function slideLayoutXml(): string {
  return serializeXmlDocument(
    el('p:sldLayout', [
      attr('xmlns:a', NS_A),
      attr('xmlns:r', NS_R),
      attr('xmlns:p', NS_P),
      attr('type', 'blank'),
      attr('preserve', '1'),
    ], [
      el('p:cSld', [attr('name', 'Blank')], [el('p:spTree', [], [...groupShapeTreePreamble()])]),
      el('p:clrMapOvr', [], [el('a:masterClrMapping')]),
    ]),
  );
}
