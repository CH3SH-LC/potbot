/**
 * **文档排版工具**（产品层）——把「排版要求」落到**真实 DOCX 字节**上。
 *
 * ## 这一件修的是什么（缺陷原文）
 *
 * 修复前，模型在这条链上**只有** `create_word_document` 一个文档工具，它的输入是
 * `paragraphs: string[]`——一串**纯文本**，**没有任何排版参数位**。于是当用户说
 * 「标题居中、加粗、三号字；正文首行缩进 2 字符；再加一个三行两列的表格」时，
 * 模型**没有地方可以表达**这些要求，只能在回复里**写一段"排版已按要求改好"**，
 * 而产物字节与上一版**逐字节相同**（sha256 相同、`<w:jc>/<w:b>/<w:sz>/<w:ind>/<w:tbl>`
 * 一个都不在），编辑版本号却照样递增。这是**编造成功**：声称改了，实际没改。
 *
 * 本模块给这条链补上**能真改排版**的那一件：`format_word_document`。
 *
 * ## 为什么不重新实现（复用既有能力，一格都不新造）
 *
 * 排版能力本仓**早就有**（`src/documents/**`），本模块只做"接线"，不重写任何一条口径：
 *
 * | 步骤 | 复用的既有能力 |
 * |---|---|
 * | 读入盘上字节 → 文档模型 | `importDocx()`（`src/documents/docx/import.ts`） |
 * | 段落属性（对齐 / 首行缩进） | `operations/paragraph/**`（经 `edit/plan.ts` 的 `setAlignment` / `setFirstLineIndent`） |
 * | 字符属性（加粗 / 字号） | `operations/character/**`（`setToggle` / `setValue`） |
 * | 复合计划（原子、可回执） | `applyEditPlan()`（`src/documents/edit/plan.ts`，R132–R136） |
 * | 插表格（含相邻表格隔离 / 尾随段落） | `insertTable()`（`operations/table/table-structure.ts`，WF-056） |
 * | 模型 → 字节 | `exportDocx()`（`src/documents/docx/export.ts`） |
 *
 * **单位换算也不在本模块**：`2 字符` 走 `{unit:'chars'}`，由 `src/documents/units/indent.ts`
 * 唯一决定它落 `w:firstLineChars="200"`（R128/R130 的唯一换算点）。
 *
 * ## 本模块**不**做的事（边界，不得越界引用）
 *
 * - **不写盘、不发布**：字节交给调用方（`conversation-host.ts`）走既有发布链；
 * - **不判"改没改"**：这里只如实报告**每一步是否命中 / 是否改动**（`EditStepReport`
 *   与 `changed` 来自 `applyEditPlan` 的回执），"字节是否真的变了"由调用方用摘要判定；
 * - **不解析自然语言**：收的是**已结构化**的参数（R134）；
 * - **不声称 Word 能打开**：渲染效果属第三层证据（需真机 / 授权 Office），本机未验证。
 *
 * ## 中文枚举 vs 英文枚举（为什么对模型用英文键 + 值）
 *
 * 参数名与枚举值一律用**稳定英文**（`title_alignment: 'center'`）：这些字符串会出现在
 * 工具回执与事件流里，机器可判；中文只出现在**描述文本**里（"居中"）。
 * 唯一例外是字号：`title_font_size` 既收 **pt 数值**也收**中文字号名**（`三号`），
 * 因为 `三号 = 16pt` 的映射表是 `src/documents/units/font-size.ts` 的唯一实现，
 * 这里**不复制**该表，直接把名字交给它。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { exportDocx, importDocx } from '../../../src/documents/docx/index.js';
import { applyEditPlan, type EditPlan, type EditStep } from '../../../src/documents/edit/plan.js';
import type { Alignment, ChineseFontSize, DocumentModel, FontSize } from '../../../src/documents/model/types.js';
import {
  cellNode,
  rowNode,
  tableNode,
  textParagraphNode,
} from '../../../src/documents/model/nodes.js';
import { setToggle, setValue } from '../../../src/documents/operations/character/index.js';
import { ALIGNMENTS } from '../../../src/documents/operations/paragraph/alignment.js';
import { indentChars } from '../../../src/documents/operations/paragraph/indent.js';
import { insertTable } from '../../../src/documents/operations/table/table-structure.js';
import { collectParagraphs } from '../../../src/documents/selection/structure.js';
import { CHINESE_FONT_SIZE_NAMES } from '../../../src/documents/units/font-size.js';

// ---------------------------------------------------------------------------
// 常量与请求形状
// ---------------------------------------------------------------------------

/** 表格规模边界（**显式**：没有上限的工具就不是有界的工具）。 */
export const TABLE_ROWS_MIN = 1;
export const TABLE_ROWS_MAX = 20;
export const TABLE_COLS_MIN = 1;
export const TABLE_COLS_MAX = 10;
/** 单元格文字上限（防止把整篇正文塞进一格）。 */
export const TABLE_CELL_CHARS_MAX = 200;

/** 首行缩进的字符数上限（"缩进 2 字符"是常规；给 10 字符以上基本是误用）。 */
export const FIRST_LINE_INDENT_CHARS_MAX = 8;

/** 一次排版请求（**全部可选**；一样都没给 ⇒ 结构化拒绝，不做无意义的"重排一遍"）。 */
export interface WordFormatRequest {
  readonly title_alignment: Alignment | null;
  readonly title_bold: boolean | null;
  readonly title_font_size: FontSize | null;
  readonly body_first_line_indent_chars: number | null;
  readonly table: WordFormatTableRequest | null;
}

export interface WordFormatTableRequest {
  readonly rows: number;
  readonly cols: number;
  /** 首行是否作为表头（`w:trPr/w:tblHeader`）。 */
  readonly header: boolean;
  /** 单元格文字（`rows × cols`；省略 ⇒ 全部留空）。 */
  readonly cells: readonly (readonly string[])[] | null;
}

/** 参数解析失败（**封闭参数表**：多一个键、值不在枚举里，一律拒绝，不猜）。 */
export interface WordFormatParseFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export interface WordFormatParseSuccess {
  readonly ok: true;
  readonly request: WordFormatRequest;
  /** 被识别到的参数名（供回执如实列出"你让我改的是哪几样"）。 */
  readonly recognized: readonly string[];
}

export type WordFormatParse = WordFormatParseSuccess | WordFormatParseFailure;

const KNOWN_PARAMETERS: readonly string[] = Object.freeze([
  'title_alignment',
  'title_bold',
  'title_font_size',
  'body_first_line_indent_chars',
  'table',
]);

const TABLE_PARAMETERS: readonly string[] = Object.freeze(['rows', 'cols', 'header', 'cells']);

function parseFailure(code: string, message: string): WordFormatParseFailure {
  return Object.freeze({ ok: false as const, code, message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析工具参数。**封闭白名单**：未知键直接拒绝——`additionalProperties: true` 的声明
 * 只是"上游给的开对象"，真正的收窄在**这里**（与 `parseConstrainedResponse` 同一纪律：
 * 模型多给一个键，不能被静默忽略）。
 */
export function parseWordFormatRequest(raw: unknown): WordFormatParse {
  if (!isPlainObject(raw)) {
    return parseFailure('invalid_arguments', 'format_word_document 的参数必须是一个对象');
  }
  const unknown = Object.keys(raw).filter((key) => !KNOWN_PARAMETERS.includes(key));
  if (unknown.length > 0) {
    return parseFailure(
      'unknown_parameter',
      `出现了未声明的参数：${unknown.join('、')}。本工具只收 ${KNOWN_PARAMETERS.join(' / ')}`,
    );
  }

  let titleAlignment: Alignment | null = null;
  if (raw['title_alignment'] !== undefined && raw['title_alignment'] !== null) {
    const value = raw['title_alignment'];
    if (typeof value !== 'string' || !(ALIGNMENTS as readonly string[]).includes(value)) {
      return parseFailure(
        'invalid_title_alignment',
        `title_alignment 必须是 ${ALIGNMENTS.join(' / ')} 之一，收到 ${JSON.stringify(value)}`,
      );
    }
    titleAlignment = value as Alignment;
  }

  let titleBold: boolean | null = null;
  if (raw['title_bold'] !== undefined && raw['title_bold'] !== null) {
    const value = raw['title_bold'];
    if (typeof value !== 'boolean') {
      return parseFailure('invalid_title_bold', `title_bold 必须是布尔值，收到 ${JSON.stringify(value)}`);
    }
    titleBold = value;
  }

  let titleFontSize: FontSize | null = null;
  if (raw['title_font_size'] !== undefined && raw['title_font_size'] !== null) {
    const value = raw['title_font_size'];
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value <= 0 || value > 400) {
        return parseFailure('invalid_title_font_size', `title_font_size 的磅值必须在 0–400 之间，收到 ${String(value)}`);
      }
      titleFontSize = { kind: 'pt', value };
    } else if (typeof value === 'string' && (CHINESE_FONT_SIZE_NAMES as readonly string[]).includes(value)) {
      titleFontSize = { kind: 'chinese', name: value as ChineseFontSize };
    } else {
      return parseFailure(
        'invalid_title_font_size',
        `title_font_size 必须是磅数值或中文字号名（${CHINESE_FONT_SIZE_NAMES.join('/')}），收到 ${JSON.stringify(value)}`,
      );
    }
  }

  let firstLineIndent: number | null = null;
  if (raw['body_first_line_indent_chars'] !== undefined && raw['body_first_line_indent_chars'] !== null) {
    const value = raw['body_first_line_indent_chars'];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > FIRST_LINE_INDENT_CHARS_MAX
    ) {
      return parseFailure(
        'invalid_body_first_line_indent_chars',
        `body_first_line_indent_chars 必须是 0–${String(FIRST_LINE_INDENT_CHARS_MAX)} 之间的数（单位：字符），收到 ${JSON.stringify(value)}`,
      );
    }
    firstLineIndent = value;
  }

  let table: WordFormatTableRequest | null = null;
  if (raw['table'] !== undefined && raw['table'] !== null) {
    const value = raw['table'];
    if (!isPlainObject(value)) {
      return parseFailure('invalid_table', 'table 必须是一个对象，形如 {"rows":3,"cols":2,"header":true}');
    }
    const extra = Object.keys(value).filter((key) => !TABLE_PARAMETERS.includes(key));
    if (extra.length > 0) {
      return parseFailure(
        'unknown_table_parameter',
        `table 出现了未声明的参数：${extra.join('、')}。只收 ${TABLE_PARAMETERS.join(' / ')}`,
      );
    }
    const rows = value['rows'];
    const cols = value['cols'];
    if (!Number.isInteger(rows) || (rows as number) < TABLE_ROWS_MIN || (rows as number) > TABLE_ROWS_MAX) {
      return parseFailure(
        'invalid_table_rows',
        `table.rows 必须是 ${String(TABLE_ROWS_MIN)}–${String(TABLE_ROWS_MAX)} 的整数，收到 ${JSON.stringify(rows)}`,
      );
    }
    if (!Number.isInteger(cols) || (cols as number) < TABLE_COLS_MIN || (cols as number) > TABLE_COLS_MAX) {
      return parseFailure(
        'invalid_table_cols',
        `table.cols 必须是 ${String(TABLE_COLS_MIN)}–${String(TABLE_COLS_MAX)} 的整数，收到 ${JSON.stringify(cols)}`,
      );
    }
    const headerRaw = value['header'];
    if (headerRaw !== undefined && headerRaw !== null && typeof headerRaw !== 'boolean') {
      return parseFailure('invalid_table_header', `table.header 必须是布尔值，收到 ${JSON.stringify(headerRaw)}`);
    }
    const cellsRaw = value['cells'];
    let cells: readonly (readonly string[])[] | null = null;
    if (cellsRaw !== undefined && cellsRaw !== null) {
      if (!Array.isArray(cellsRaw) || cellsRaw.length !== rows) {
        return parseFailure(
          'invalid_table_cells',
          `table.cells 必须是 ${String(rows)} 行的二维数组（每行 ${String(cols)} 格），收到 ${Array.isArray(cellsRaw) ? `${String(cellsRaw.length)} 行` : typeof cellsRaw}`,
        );
      }
      const normalized: (readonly string[])[] = [];
      for (const [rowIndex, rawRow] of cellsRaw.entries()) {
        if (!Array.isArray(rawRow) || rawRow.length !== cols) {
          return parseFailure(
            'invalid_table_cells',
            `table.cells[${String(rowIndex)}] 必须是 ${String(cols)} 格的数组`,
          );
        }
        const row: string[] = [];
        for (const [colIndex, rawCell] of rawRow.entries()) {
          if (typeof rawCell !== 'string') {
            return parseFailure(
              'invalid_table_cells',
              `table.cells[${String(rowIndex)}][${String(colIndex)}] 必须是字符串，收到 ${JSON.stringify(rawCell)}`,
            );
          }
          if ([...rawCell].length > TABLE_CELL_CHARS_MAX) {
            return parseFailure(
              'invalid_table_cells',
              `table.cells[${String(rowIndex)}][${String(colIndex)}] 超过 ${String(TABLE_CELL_CHARS_MAX)} 字`,
            );
          }
          row.push(rawCell);
        }
        normalized.push(Object.freeze(row));
      }
      cells = Object.freeze(normalized);
    }
    table = Object.freeze({
      rows: rows as number,
      cols: cols as number,
      header: headerRaw === true,
      cells,
    });
  }

  if (
    titleAlignment === null &&
    titleBold === null &&
    titleFontSize === null &&
    firstLineIndent === null &&
    table === null
  ) {
    return parseFailure(
      'empty_request',
      `至少要给一样要改的东西（${KNOWN_PARAMETERS.join(' / ')}）；一样都不给 = 没有可执行的动作`,
    );
  }

  const recognized: string[] = [];
  if (titleAlignment !== null) recognized.push('title_alignment');
  if (titleBold !== null) recognized.push('title_bold');
  if (titleFontSize !== null) recognized.push('title_font_size');
  if (firstLineIndent !== null) recognized.push('body_first_line_indent_chars');
  if (table !== null) recognized.push('table');

  return Object.freeze({
    ok: true as const,
    request: Object.freeze({
      title_alignment: titleAlignment,
      title_bold: titleBold,
      title_font_size: titleFontSize,
      body_first_line_indent_chars: firstLineIndent,
      table,
    }),
    recognized: Object.freeze(recognized),
  });
}

// ---------------------------------------------------------------------------
// 施加
// ---------------------------------------------------------------------------

/** 单步回执（**原样来自** `applyEditPlan`，不是本模块自己描的）。 */
export interface WordFormatStepReport {
  readonly range: string;
  readonly domain: string;
  readonly hitCount: number;
  readonly changed: boolean;
}

export interface WordFormatSuccess {
  readonly ok: true;
  readonly bytes: Uint8Array;
  /** 逐段回执（在**本函数**构建的计划上）。 */
  readonly steps: readonly WordFormatStepReport[];
  /** 是否真的插入了一张表格（`false` = 本次没提出表格要求）。 */
  readonly table_inserted: boolean;
  /** 施加排版后的段落总数（含表格引入的尾随段落）。 */
  readonly paragraph_count: number;
  /** 表格几何（未插表时 `null`）。 */
  readonly table_shape: { readonly rows: number; readonly cols: number; readonly header: boolean } | null;
  /** 计划里是否有**任何一步**报告 `changed:true`，或插入了表格。 */
  readonly model_changed: boolean;
}

export interface WordFormatFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type WordFormatOutcome = WordFormatSuccess | WordFormatFailure;

/**
 * 把排版要求施加到**给定的 DOCX 字节**上，返回**新的** DOCX 字节。
 *
 * 输入字节由调用方从**盘上读回**（不是内存里的"我以为的那一份"）：这样"排版的是用户手里
 * 那一份文件"是可核对的。
 *
 * 失败一律结构化（`ok:false` + 具名 `code`），**不抛**——调用方据此把原因如实回喂给模型。
 */
export function applyWordFormatting(bytes: Uint8Array, request: WordFormatRequest): WordFormatOutcome {
  let model: DocumentModel;
  try {
    model = importDocx(bytes);
  } catch (error) {
    return failure('import_failed', `读回的那一份 DOCX 解不开：${describe(error)}`);
  }

  const paragraphs = collectParagraphs(model.blocks);
  if (paragraphs.length === 0) {
    return failure('no_paragraph', '这份文档没有任何段落：没有可施加排版的对象');
  }

  const steps: EditStep[] = [];
  const titleRange = '第1段';
  if (request.title_alignment !== null) {
    steps.push({
      range: titleRange,
      operation: { domain: 'paragraph', operation: { kind: 'setAlignment', alignment: request.title_alignment } },
    });
  }
  if (request.title_bold !== null) {
    steps.push({
      range: titleRange,
      operation: { domain: 'character', operation: setToggle('bold', request.title_bold) },
    });
  }
  if (request.title_font_size !== null) {
    steps.push({
      range: titleRange,
      operation: { domain: 'character', operation: setValue('size', request.title_font_size) },
    });
  }
  if (request.body_first_line_indent_chars !== null) {
    if (paragraphs.length < 2) {
      return failure('no_body_paragraph', '这份文档只有标题一段，没有"每个正文段落"可缩进');
    }
    steps.push({
      range: `第2至${String(paragraphs.length)}段`,
      operation: {
        domain: 'paragraph',
        operation: { kind: 'setFirstLineIndent', amount: indentChars(request.body_first_line_indent_chars) },
      },
    });
  }

  let next = model;
  const reports: WordFormatStepReport[] = [];
  if (steps.length > 0) {
    const plan: EditPlan = { steps };
    const applied = applyEditPlan(next, plan);
    if (!applied.ok) {
      return failure(
        `plan_${applied.code}`,
        `排版计划未执行（文档零改动）：${applied.message}`,
      );
    }
    next = applied.value.model;
    for (const report of applied.value.steps) {
      reports.push(
        Object.freeze({
          range: report.range,
          domain: report.domain,
          hitCount: report.hitCount,
          changed: report.changed,
        }),
      );
    }
  }

  let tableInserted = false;
  let tableShape: { readonly rows: number; readonly cols: number; readonly header: boolean } | null = null;
  if (request.table !== null) {
    const draft = draftTableOf(request.table);
    const inserted = insertTable(next, { index: next.blocks.length, table: draft });
    if (!inserted.ok) {
      return failure(`table_${inserted.code}`, `插入表格失败（文档零改动）：${inserted.detail}`);
    }
    next = inserted.model;
    tableInserted = true;
    tableShape = Object.freeze({
      rows: request.table.rows,
      cols: request.table.cols,
      header: request.table.header,
    });
  }

  let out: Uint8Array;
  try {
    out = exportDocx(next);
  } catch (error) {
    return failure('export_failed', `导出失败（盘上文件一个字节都没动）：${describe(error)}`);
  }

  return Object.freeze({
    ok: true as const,
    bytes: out,
    steps: Object.freeze(reports),
    table_inserted: tableInserted,
    paragraph_count: collectParagraphs(next.blocks).length,
    table_shape: tableShape,
    model_changed: tableInserted || reports.some((report) => report.changed),
  });
}

/**
 * 由请求造一张表格草稿。
 *
 * 复用 `model/nodes.ts` 的工厂（id 由分配器在 `insertTable` 里取号，R101）：
 * 这里**不**手写节点字面量，也不自己拼 XML。
 */
function draftTableOf(request: WordFormatTableRequest): ReturnType<typeof tableNode> {
  const rows = [];
  for (let rowIndex = 0; rowIndex < request.rows; rowIndex += 1) {
    const cells = [];
    for (let colIndex = 0; colIndex < request.cols; colIndex += 1) {
      const text = request.cells?.[rowIndex]?.[colIndex] ?? '';
      cells.push(
        cellNode({
          source: 'model_generated',
          blocks: [textParagraphNode({ text, source: 'model_generated' })],
        }),
      );
    }
    rows.push(
      rowNode({
        source: 'model_generated',
        cells,
        header: request.header && rowIndex === 0,
      }),
    );
  }
  return tableNode({ source: 'model_generated', rows });
}

function failure(code: string, message: string): WordFormatFailure {
  return Object.freeze({ ok: false as const, code, message });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
