/**
 * DOCX 模板构建器（design-02 **P6「文档」** 合同 + P1 + P3；**纯函数、零 IO**）。
 *
 * 任务书 §6 的「文档」一行给的是三条：**最小输入** = 任务要求 + 已确认事实 + 资料引用；
 * **首版交付** = 可编辑文档及简要说明；**明确边界** = **不自行改写已确认人数、金额与日期**。
 * 本文件把那行合同落成一个"输入形状即纪律"的构建器。
 *
 * ## 为什么输入里没有"数字参数位"（P3 的结构性要求）
 *
 * 构建器的输入只有三样：任务要求（标题 / 说明，纯文本）、**事实快照**
 * （`KnownFactSnapshotEntry[]`，只可能装 `KnownFactValue`）、资料引用（文本）。
 * 没有 `headcount` / `amount` / `date` 这类"顺手传个 8"的位置——Agent 无法把 8 改成 10 写进文档，
 * 因为**没有地方可以放那个 10**。`unknown` / `not_applicable` 也进不来（那是 W-B 端口
 * 在进入物化之前就该阻塞成 `missing_fact` 的形态，见 R48.4）。未知键会被显式拒绝，
 * 不会"静静地被忽略"。
 *
 * ## "不自行改写已确认数据"是怎么被判定的（可判定的边界，不是文字承诺）
 *
 * 两条机器判据，都在**构建期**执行、不通过就抛 `ValidationError`：
 *
 * 1. **事实段逐字来自快照**：正文里的人数 / 金额 / 日期段落由 `renderDocxFactValue()` 直接从
 *    快照值渲染，构建器**没有任何算术**（不做加总、不做单位换算、不做四舍五入到"好看"的位数）。
 * 2. **正文里不得出现快照里没有的数字**（`untraceableDigitRuns`）：把文档可见文本中
 *    **快照派生的字符串**（`fact_key`、格式化后的数值、单位、币种、`iso_date`、`time_zone`、
 *    文本事实的正文）整段掩掉，再看**剩下**还有没有数字串。剩下的每一个都是一处
 *    "凭空出现的数字"（例如任务要求里写了"10 人"而快照里只有 8），一律拒绝。
 *
 * 第 2 条同时是**导出的纯函数**，验收侧可以拿它检查任意文本，不必相信本文件的措辞。
 * 注意它的判定口径：掩码按**原子字符串**整段匹配，因此 `event.date: 2026-10-02` 里的 `10`
 * 只有在**整个日期串**出现时才被认定为"指认得到"，单独冒出的 `10` 会被抓住（见单测的负例）。
 *
 * ## 容器骨架（照抄已实测可打开的最小部件集）
 *
 * - 业务部件 `word/document.xml`，内容类型 `…document.main+xml`；
 * - `content_type_defaults` 只含 `rels`（`_rels/*.rels` 自身靠它归类）；
 * - 包级关系 `_rels/.rels` → `…/officeDocument` → `word/document.xml`；
 * - 正文根 `w:document`（`xmlns:w=…/wordprocessingml/2006/main`）→ `w:body`
 *   → 若干 `w:p`/`w:r`/`w:t` → 末尾**必须**是 `w:sectPr`（含 `w:pgSz`）。
 *
 * **能不能被 Word 打开不由本模块声称**：`src/**` 零文件 IO，本模块只到"结构自检 + 字节可复现"。
 * 目标软件打开属第三层证据（R53.1），由验收侧宿主实现。
 *
 * ## 正文段落的最小扩展（design-03 / 合同 v1「DOCX 最小扩展」）
 *
 * `DocxTaskRequirement` 增加**可选** `paragraphs`：
 * - 不提供 ⇒ 正文仍是旧的单段 `description`，**逐字节不变**（golden 摘要向量仍然成立）；
 * - 提供 ⇒ 每段一个 `w:p`，取代 `description`；段数 2–4、正文总字数 ≤2000、段内不得含控制字符，
 *   违规一律 `ValidationError` 结构化拒绝（不截断、不回退）。
 *
 * **数字护栏不因扩展而放宽**：`assertNoUntraceableNumbers` 仍作用在
 * 完整的标题、段落、事实与引用上，因此新路径的**每一段**同样要
 * 通过"每个数字都能指认到快照"的检查（`docx.test.ts` 有对应的负例）。
 *
 * `presentation: 'title-body-v1'` 只关闭自动附加的事实与引用展示；输入及数字校验不变。
 * 该模式在标准自定义属性部件里标记展示版本，不向正文插入标记或按关键词删字。
 * 默认仍追加来源，保留既有调用的字节与 golden 向量。
 *
 * ## 确定性（R51）
 *
 * 全 STORE、无时间参数、无 `Date` / `Math.random` / `process.*`；部件顺序 = 声明顺序，
 * 由 `assembleOpcPackage` 唯一决定；XML 属性顺序 = 传入顺序、无 BOM、换行固定 `\n`。
 * 因此"同一输入 ⇒ 同一字节"是可断言的（单测钉死 golden 摘要向量）。
 */

import { ValidationError } from '../../protocol/index.js';
import type { KnownFactValue } from '../../protocol/index.js';
import { digestBytes } from '../digest.js';
import type { KnownFactSnapshotEntry } from '../ports.js';
import {
  RELATIONSHIPS_CONTENT_TYPE,
  RELATIONSHIPS_EXTENSION,
  assembleOpcPackage,
  attr,
  el,
  formatDecimal,
  formatInteger,
  serializeXmlDocument,
  writeZip,
} from '../ooxml/index.js';
import type { OpcPart, XmlElement } from '../ooxml/index.js';

// ---------------------------------------------------------------------------
// 容器常量（与已实测可打开的最小部件集逐字一致）
// ---------------------------------------------------------------------------

/** 主部件的内容类型（Word 的 `main+xml`）。 */
export const DOCX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

/** 主部件在包内的路径。 */
export const DOCX_DOCUMENT_PART_PATH = 'word/document.xml';

/** WordprocessingML 主命名空间。 */
export const WORD_MAIN_NAMESPACE =
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** 包级关系类型：`officeDocument`（指向主部件）。 */
export const OFFICE_DOCUMENT_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

/** A4 纵向纸张：宽 / 高（twips）。常量，不由本地语言环境或屏幕推导。 */
export const DOCX_PAGE_WIDTH_TWIPS = 11906;
export const DOCX_PAGE_HEIGHT_TWIPS = 16838;

/** 两个小节标题。**不含数字**——否则"事实为空"时正文会出现无来源的数字。 */
export const FACTS_SECTION_HEADING = '已确认事实';
export const REFERENCES_SECTION_HEADING = '资料引用';

/** 新展示模式的版本标记放在文档属性中，不属于可见正文。 */
export const DOCX_CUSTOM_PROPERTIES_PATH = 'docProps/custom.xml';
export const DOCX_PRESENTATION_PROPERTY = 'PotbotDocumentPresentation';
export const DOCX_TITLE_BODY_PRESENTATION = 'title-body-v1';
const CUSTOM_PROPERTIES_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.custom-properties+xml';
const CUSTOM_PROPERTIES_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties';

// ---------------------------------------------------------------------------
// 正文段落的合同上限（**最小扩展**：design-03 手机 Word Demo）
// ---------------------------------------------------------------------------

/**
 * 正文段落数下限 / 上限与正文总字数上限。
 *
 * **为什么在本文件里再写一遍常量、而不是从 `apps/demo/contracts.ts` 的 `LIMITS` import**：
 * `src/**` 不得依赖 `apps/**`（方向相反的依赖会把 Demo 应用拖进内核的编译面）。
 * 因此这里保留本模块自己的常量，**取值与合同对齐**，并由
 * `apps/demo/documents/contract-alignment.test.ts` 机器断言两组常量相等——
 * "对齐"是可执行的断言，不是注释里的承诺。
 *
 * 与旧路径的关系：这三个上限**只**约束 `paragraphs` 新路径。不提供 `paragraphs` 时
 * 走旧的单段 `description`，其校验与产出**逐字节不变**（老调用不受新上限追溯影响）。
 */
export const DOCX_MIN_BODY_PARAGRAPHS = 2;
export const DOCX_MAX_BODY_PARAGRAPHS = 4;
export const DOCX_MAX_BODY_CHARS = 2000;

// ---------------------------------------------------------------------------
// 输入 / 输出形状
// ---------------------------------------------------------------------------

/**
 * 任务要求：标题 + 说明文本（§6「任务要求」；纯文本，不是数字参数位）。
 *
 * `paragraphs`（**可选**，design-03 最小扩展）：
 * - **不提供**（含显式 `undefined`）⇒ 正文 = `[description]`，与扩展前的字节**逐字节相同**；
 * - **提供** ⇒ 正文 = `paragraphs`（每段一个 `w:p`），`description` **不再渲染**、
 *   也不参与校验（它是旧路径的字段，仍保留在类型里以免改动既有调用点）。
 *
 * 为什么是"段落数组"而不是"把 description 写长一点"：契约 v1 的草稿形状就是
 * `{title, paragraphs: [{id,text}]}`；段落边界必须由**结构化输入**给出，
 * 而不是让渲染层去猜换行。
 */
export interface DocxTaskRequirement {
  readonly title: string;
  readonly description: string;
  /** 可选正文段落（2–4 段、总正文 ≤2000 字、段内不得含换行/控制字符）。 */
  readonly paragraphs?: readonly string[];
  /** 默认附加来源；Demo 只展示标题正文，事实与引用仍校验并留在内核。 */
  readonly presentation?: 'provenance' | typeof DOCX_TITLE_BODY_PRESENTATION;
}

/** 资料引用一条（§6「资料引用」；只带 名字 + 说明，不带"结论数字"）。 */
export interface DocxReference {
  readonly label: string;
  readonly detail: string;
}

/**
 * 构建器输入。**只有这三个字段**——没有原始数字的参数位置（P3 / R48.3）。
 * 多出来的字段会被 `buildDocxTemplate` 显式拒绝，不会静默忽略。
 */
export interface DocxTemplateInput {
  readonly requirement: DocxTaskRequirement;
  /** 事实快照：只可能是"已知值"（`KnownFactSnapshotEntry`），未知值进不来。 */
  readonly fact_snapshot: readonly KnownFactSnapshotEntry[];
  readonly references: readonly DocxReference[];
}

/** 构建结果：字节 + 容器条目数 + 内容摘要（裸小写 hex sha256）。 */
export interface DocxBuildResult {
  /** 完整容器字节（可直接落盘 / 回读）。 */
  readonly bytes: Buffer;
  /** 容器条目数（DOCX 的 ZIP 部件数），供 `ArtifactMaterializationReceipt.entry_count` 交叉核对。 */
  readonly entry_count: number;
  /** 对 `bytes` 逐字节的 sha256（裸小写 hex）。 */
  readonly content_digest: string;
}

/** 允许出现的顶层字段（白名单即"没有别的参数位"的机器形式）。 */
const INPUT_KEYS: readonly string[] = ['requirement', 'fact_snapshot', 'references'];

const DIGIT_RUN_PATTERN = /[0-9]+/g;

// ---------------------------------------------------------------------------
// 公开纯函数
// ---------------------------------------------------------------------------

/**
 * 产物字节的 sha256（**裸小写 hex**，无算法前缀）。
 *
 * 实现已收敛到唯一一处：`src/artifacts/digest.ts`（W-DISC）。本文件只保留
 * **同名同签名的再导出**，对外符号与行为逐字节不变；收敛理由见该模块头部
 * （三个模板各自写过一次同一个字节级调用）。
 */
export { digestBytes };

/**
 * 把一条已知事实渲染成正文里的值文本。
 *
 * 纪律：**只有格式化，没有算术**。整数走 `formatInteger`，非整数走 `formatDecimal` 的
 * 最短精确十进制（scale 取自 `Number::toString` 的规范输出，不经 locale / `toFixed`），
 * 不做单位换算、不做四舍五入到"好看"的位数、不做 8 → "八" 这类改写。
 *
 * @throws {ValidationError} 非有限数 / 指数表示等本模块不承诺的数值形态。
 */
export function renderDocxFactValue(value: KnownFactValue): string {
  switch (value.type) {
    case 'number': {
      // 币种与单位相同时只写一次（`600 CNY` 而不是 `600 CNY CNY`）。
      const currency =
        value.currency !== null && value.currency !== value.unit ? ` ${value.currency}` : '';
      return `${formatFactAmount(value.amount)} ${value.unit}${currency}`;
    }
    case 'date':
      return `${value.iso_date} (${value.time_zone})`;
    case 'text':
      return value.text;
    default:
      throw new ValidationError(
        `未知的事实值种类：${String((value as { type?: unknown }).type)}（只支持 number / date / text）`,
      );
  }
}

/**
 * 快照**派生的字符串**全集（`fact_key` + 值的各个字面分量）。
 *
 * 语义：这些字符串出现在正文的任何位置，都算"指认到快照里的某条事实"——
 * 它们是构建器能从快照里取得数字的**全部**来源（本模块没有第二个数字来源）。
 */
export function snapshotDerivedStrings(
  snapshot: readonly KnownFactSnapshotEntry[],
): readonly string[] {
  const strings: string[] = [];
  for (const entry of snapshot) {
    strings.push(entry.fact_key);
    const value = entry.value;
    switch (value.type) {
      case 'number':
        strings.push(formatFactAmount(value.amount), value.unit);
        if (value.currency !== null) strings.push(value.currency);
        break;
      case 'date':
        strings.push(value.iso_date, value.time_zone);
        break;
      case 'text':
        strings.push(value.text);
        break;
      default:
        throw new ValidationError('快照条目的事实值种类未知：只支持 number / date / text');
    }
  }
  return Object.freeze(strings);
}

/**
 * **P6 边界的检查器**：返回 `text` 里"指认不到快照"的数字串（去重、保持出现顺序）。
 *
 * 判定：先把每个**快照派生字符串**在 `text` 中的完整出现整段掩掉（替换为换行，
 * 避免把两侧的数字粘连成新的数字串），再对**剩余文本**取数字串——剩下的每一个都是
 * "凭空出现"的数字。空数组 = 全部数字都能指认到快照。
 *
 * 长串优先掩码，避免短串先把长串切碎（例如先掩 `2026-10-02` 再掩别的）。
 */
export function untraceableDigitRuns(
  text: string,
  snapshot: readonly KnownFactSnapshotEntry[],
): readonly string[] {
  if (typeof text !== 'string') {
    throw new ValidationError(`untraceableDigitRuns 的 text 必须是字符串，收到 ${typeof text}`);
  }
  let remaining = text;
  const masks = [...snapshotDerivedStrings(snapshot)].sort((left, right) => right.length - left.length);
  for (const mask of masks) {
    if (mask.length === 0) continue;
    remaining = remaining.split(mask).join('\n');
  }
  const runs = remaining.match(DIGIT_RUN_PATTERN) ?? [];
  return Object.freeze([...new Set(runs)]);
}

/**
 * 构建 DOCX（**纯函数**：同一输入 ⇒ 同一字节、同一摘要）。
 *
 * 流程：输入校验 → 正文行就地取材于快照 → **数字边界检查** → 拼 XML → OPC 组装
 * （构造期校验：路径合法 / 部件不重复 / 关系目标存在）→ 写 ZIP → 取字节与摘要。
 *
 * @throws {ValidationError} 输入缺字段 / 空文本 / 出现未知字段 / 正文含快照里没有的数字。
 * @throws {OpcError} 容器自洽性被破坏（本模块的部件清单是常量，正常路径不可达）。
 */
export function buildDocxTemplate(input: DocxTemplateInput): DocxBuildResult {
  const source = assertInputShape(input);
  const requirement = requireRequirement(source['requirement']);
  const title = requireNonEmptyText(requirement.title, 'requirement.title');
  const body = requireDocumentBody(requirement);
  const presentation = requirePresentation(requirement.presentation);
  const snapshot = normalizeSnapshot(source['fact_snapshot']);
  const references = normalizeReferences(source['references']);

  const completeLines = documentLines(title, body, snapshot, references);
  // 隐藏自动附加段落不能成为绕过输入或数字来源校验的途径。
  assertNoUntraceableNumbers(completeLines.join('\n'), snapshot);
  const titleBodyOnly = presentation === DOCX_TITLE_BODY_PRESENTATION;
  const lines = titleBodyOnly ? [title, ...body] : completeLines;

  const document: XmlElement = el('w:document', [attr('xmlns:w', WORD_MAIN_NAMESPACE)], [
    el('w:body', [], [
      ...lines.map(paragraph),
      // 末尾必须有 sectPr（含 pgSz）——这是"Word 能打开"的实测骨架的一部分。
      el('w:sectPr', [], [
        el('w:pgSz', [
          attr('w:w', formatInteger(DOCX_PAGE_WIDTH_TWIPS)),
          attr('w:h', formatInteger(DOCX_PAGE_HEIGHT_TWIPS)),
        ]),
      ]),
    ]),
  ]);

  const parts: OpcPart[] = [
    {
      path: DOCX_DOCUMENT_PART_PATH,
      content_type: DOCX_MAIN_CONTENT_TYPE,
      data: serializeXmlDocument(document),
    },
  ];
  if (titleBodyOnly) {
    parts.push({
      path: DOCX_CUSTOM_PROPERTIES_PATH,
      content_type: CUSTOM_PROPERTIES_CONTENT_TYPE,
      data: serializeXmlDocument(el('Properties', [
        attr('xmlns', 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties'),
        attr('xmlns:vt', 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes'),
      ], [
        el('property', [
          attr('fmtid', '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}'),
          attr('pid', '2'),
          attr('name', DOCX_PRESENTATION_PROPERTY),
        ], [el('vt:lpwstr', [], [DOCX_TITLE_BODY_PRESENTATION])]),
      ])),
    });
  }

  const assembled = assembleOpcPackage({
    parts,
    // `_rels/*.rels` 自身靠这条默认项归类；没有它 OPC 组装会显式失败。
    content_type_defaults: [
      { extension: RELATIONSHIPS_EXTENSION, content_type: RELATIONSHIPS_CONTENT_TYPE },
    ],
    // 包级关系必须且只能有一组（owner = null ⇒ `_rels/.rels`）。
    relationships: [
      {
        owner_part_path: null,
        declarations: [
          { type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: DOCX_DOCUMENT_PART_PATH },
          ...(titleBodyOnly ? [{
            type: CUSTOM_PROPERTIES_RELATIONSHIP_TYPE,
            target: DOCX_CUSTOM_PROPERTIES_PATH,
          }] : []),
        ],
      },
    ],
  });

  const bytes = writeZip(assembled.entries);
  return Object.freeze({
    bytes,
    entry_count: assembled.entries.length,
    content_digest: digestBytes(bytes),
  });
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/** 正文行（可见文本）——**顺序即段落顺序**，全部内容只来自这三处来源。 */
function documentLines(
  title: string,
  body: readonly string[],
  snapshot: readonly KnownFactSnapshotEntry[],
  references: readonly DocxReference[],
): string[] {
  const lines: string[] = [title, ...body];
  if (snapshot.length > 0) {
    lines.push(FACTS_SECTION_HEADING);
    for (const entry of snapshot) {
      lines.push(`${entry.fact_key}: ${renderDocxFactValue(entry.value)}`);
    }
  }
  if (references.length > 0) {
    lines.push(REFERENCES_SECTION_HEADING);
    for (const reference of references) {
      lines.push(`${reference.label}: ${reference.detail}`);
    }
  }
  return lines;
}

/** 一段正文 = 一个 `w:p` / `w:r` / `w:t`（与实测骨架一致，不加样式与 `w:pPr`）。 */
function paragraph(text: string): XmlElement {
  return el('w:p', [], [el('w:r', [], [el('w:t', [], [text])])]);
}

/** 整数 / 最短精确十进制；**不改写数值**，只选一种确定性的写法。 */
function formatFactAmount(amount: number): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new ValidationError(
      `事实数值必须是有限数，收到 ${String(amount)}` +
        '（缺失必须表达为 unknown，不得用 0 冒充——P3）',
    );
  }
  if (Number.isSafeInteger(amount)) return formatInteger(amount);
  // `Number.prototype.toString()` 是规范定义的最短可往返十进制（与 locale 无关）。
  const text = String(amount);
  if (/[eE]/.test(text)) {
    throw new ValidationError(
      `不支持的数值形态（指数表示）：${text}；首版只承诺定点十进制，请把该事实改成定点写法或整数`,
    );
  }
  const dot = text.indexOf('.');
  const scale = text.length - dot - 1;
  if (scale > 20) {
    throw new ValidationError(`数值 ${text} 的小数位数 ${String(scale)} 超出定点格式化上限 20`);
  }
  return formatDecimal(amount, scale);
}

/**
 * 输入白名单校验：多出来的键**显式失败**而不是被静默忽略。
 * 这是"没有'直接传数字'的参数位置"这一句在运行期也成立的形式——塞进来的数字不会被使用，
 * 而且会被当场指出（免得调用方以为它生效了）。
 */
function assertInputShape(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError(`DocxTemplateInput 必须是对象，收到 ${String(input)}`);
  }
  const record = input as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !INPUT_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw new ValidationError(
      `DocxTemplateInput 收到未知字段：${unknownKeys.join(', ')}；` +
        '构建器只接受 requirement / fact_snapshot / references——' +
        '没有"直接传数字"的参数位置（P3 / R48.3），数字只能经事实快照进入。',
    );
  }
  return record;
}

function requireRequirement(raw: unknown): DocxTaskRequirement {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError(
      `requirement.title / requirement.description 缺失：requirement 必须是对象，收到 ${String(raw)}`,
    );
  }
  return raw as DocxTemplateInput['requirement'];
}

function requirePresentation(raw: unknown): NonNullable<DocxTaskRequirement['presentation']> {
  if (raw === undefined || raw === 'provenance') return 'provenance';
  if (raw === DOCX_TITLE_BODY_PRESENTATION) return raw;
  throw new ValidationError(
    'requirement.presentation 只接受 provenance / title-body-v1，或省略以保留默认展示',
  );
}

/**
 * 取正文段落（**旧路径逐字节不变**的接缝）。
 *
 * - `paragraphs === undefined`（含字段不存在）⇒ `[description]`，校验与旧实现相同；
 * - `paragraphs` 给出 ⇒ **只**校验段落数组，`description` 既不渲染也不校验。
 *
 * 任何不满足都抛 `ValidationError`（**结构化拒绝**，不静默截断、不静默回退到 description——
 * 静默回退会让"我传了段落"与"盘上是单段"之间产生无声分叉）。
 */
function requireDocumentBody(requirement: DocxTaskRequirement): readonly string[] {
  const paragraphs = requirement.paragraphs;
  if (paragraphs === undefined) {
    return [requireNonEmptyText(requirement.description, 'requirement.description')];
  }
  return requireParagraphs(paragraphs);
}

/**
 * 段落数组的校验（合同 v1「DOCX 最小扩展」的判据）。
 *
 * 拒绝：非数组、段数不在 `[DOCX_MIN_BODY_PARAGRAPHS, DOCX_MAX_BODY_PARAGRAPHS]`（含空数组）、
 * 非字符串元素、空段、**纯空白段**、段内含换行 / 制表 / C0 控制字符（渲染层没有 `w:br`，
 * 写了会在 Word 里无声消失——宁可拒绝也不静默吞字）、正文总字数超出 `DOCX_MAX_BODY_CHARS`。
 *
 * @throws {ValidationError} 上述任一情形。
 */
function requireParagraphs(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError(
      `requirement.paragraphs 必须是字符串数组，收到 ${String(raw)}；` +
        '要回到旧的单段 description，请把该字段整项省略（写 undefined 与省略等价）',
    );
  }
  if (raw.length < DOCX_MIN_BODY_PARAGRAPHS || raw.length > DOCX_MAX_BODY_PARAGRAPHS) {
    throw new ValidationError(
      `requirement.paragraphs 的段数必须在 ${String(DOCX_MIN_BODY_PARAGRAPHS)}–` +
        `${String(DOCX_MAX_BODY_PARAGRAPHS)} 之间，收到 ${String(raw.length)} 段；` +
        '超出即拒绝，不静默截断（合同 v1 LIMITS）。',
    );
  }
  const paragraphs: string[] = [];
  for (const [index, value] of raw.entries()) {
    const field = `requirement.paragraphs[${String(index)}]`;
    if (typeof value !== 'string') {
      throw new ValidationError(`${field} 必须是字符串，收到 ${typeof value}`);
    }
    if (value.length === 0 || value.trim().length === 0) {
      throw new ValidationError(
        `${field} 不能是空段或纯空白段（合同 v1：空白段明确拒绝，不静默丢弃）`,
      );
    }
    if (FORBIDDEN_IN_PARAGRAPH_PATTERN.test(value)) {
      throw new ValidationError(
        `${field} 含换行 / 制表 / 控制字符（${describeControlCharacters(value)}）：` +
          '本模板不写 w:br，段内换行在 Word 里会无声消失；段落边界请用段落数组表达，' +
          '文本请用纯文本（也不写制表符）。',
      );
    }
    paragraphs.push(value);
  }
  const total = paragraphs.reduce((sum, text) => sum + codePointLength(text), 0);
  if (total > DOCX_MAX_BODY_CHARS) {
    throw new ValidationError(
      `requirement.paragraphs 的正文共 ${String(total)} 字，超出上限 ` +
        `${String(DOCX_MAX_BODY_CHARS)} 字（合同 v1 LIMITS.maxDraftChars）；` +
        '超出即拒绝，不静默截断。',
    );
  }
  return Object.freeze(paragraphs);
}

/** 段内禁止的字符：Unicode 控制类（Cc）。含 `\n` `\r` `\t` 与 DEL，也含 C1 控制字符。 */
const FORBIDDEN_IN_PARAGRAPH_PATTERN = /[\p{Cc}]/u;

/** 同上，带 g 标志（只为把违规字符逐个列进失败说明）。 */
const FORBIDDEN_IN_PARAGRAPH_SCAN = /[\p{Cc}]/gu;

/** 把段内的控制字符逐个列成 `U+XXXX`（**不把控制字符原样回显**到错误信息里）。 */
function describeControlCharacters(text: string): string {
  const offenders = [...new Set(text.match(FORBIDDEN_IN_PARAGRAPH_SCAN) ?? [])];
  return offenders
    .map((character) => `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`)
    .join('、');
}

/** 字符数按**码位**计（`"😀".length === 2`，但它是 1 个字）。 */
function codePointLength(text: string): number {
  return [...text].length;
}

function requireNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串，收到 ${String(value)}`);
  }
  return value;
}

function normalizeSnapshot(raw: unknown): KnownFactSnapshotEntry[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError(`fact_snapshot 必须是数组，收到 ${String(raw)}`);
  }
  return raw.map((entry: unknown, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ValidationError(`fact_snapshot[${String(index)}] 必须是对象`);
    }
    const record = entry as Record<string, unknown>;
    const factKey = requireNonEmptyText(record['fact_key'], `fact_snapshot[${String(index)}].fact_key`);
    if (typeof record['value'] !== 'object' || record['value'] === null) {
      throw new ValidationError(`fact_snapshot[${String(index)}].value 必须是对象（未知值不得进入快照）`);
    }
    const factRef = requireNonEmptyText(record['fact_ref'], `fact_snapshot[${String(index)}].fact_ref`);
    return {
      fact_ref: factRef as KnownFactSnapshotEntry['fact_ref'],
      fact_key: factKey,
      value: record['value'] as KnownFactValue,
      source: record['source'] as KnownFactSnapshotEntry['source'],
    };
  });
}

function normalizeReferences(raw: unknown): DocxReference[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError(`references 必须是数组，收到 ${String(raw)}`);
  }
  return raw.map((reference: unknown, index) => {
    if (typeof reference !== 'object' || reference === null || Array.isArray(reference)) {
      throw new ValidationError(`references[${String(index)}] 必须是对象`);
    }
    const record = reference as Record<string, unknown>;
    return {
      label: requireNonEmptyText(record['label'], `references[${String(index)}].label`),
      detail: requireNonEmptyText(record['detail'], `references[${String(index)}].detail`),
    };
  });
}

/** **P6 的边界断言**：正文里不得出现快照里没有的数字。 */
function assertNoUntraceableNumbers(
  text: string,
  snapshot: readonly KnownFactSnapshotEntry[],
): void {
  const untraceable = untraceableDigitRuns(text, snapshot);
  if (untraceable.length > 0) {
    throw new ValidationError(
      `文档正文出现了快照里没有的数字：${untraceable.join('、')}；` +
        'P6：文档不自行改写已确认人数、金额与日期——凡正文里的数字都必须能指认到一条已确认事实' +
        '（缺数据要走 missing_fact 阻塞，不得在正文里现编）。',
    );
  }
}
