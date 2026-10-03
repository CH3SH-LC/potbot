/**
 * 选区扩展与常用选区构造（WF-088：字词 / 句 / 段 / 多段 / 全文 / 表格·单元格）。
 *
 * ## 词边界
 * - ASCII 字母/数字/下划线连成一"词"；
 * - **汉字按单字成词**（Word 双击中文取单字的行为）。中文无空格分词，若把连续汉字算一个词，
 *   双击"天气"会选中整句，反而更难用；
 * - 其它字符（标点等）各自成一段"非词"游程。
 *
 * ## 句边界
 * 取 `。！？…!?` 与换行；句范围**包含**结尾标点，且止于下一个句末之后。
 */

import type { DocumentModel } from '../model/types.js';
import { buildInlineTextMap } from './inline-map.js';
import { resolveRangeExpression } from './resolve.js';
import { requireParagraph } from './structure.js';
import { fail, succeed, type DocumentRange, type Result, type Selection } from './types.js';

const CJK = /^\p{Script=Han}$/u;
const WORD_CHAR = /^[0-9A-Za-z_]$/;
const SENTENCE_END = '。！？…!?\n';

type CharClass = 'latin' | 'cjk' | 'other';

function classify(char: string | undefined): CharClass {
  if (char === undefined) return 'other';
  if (CJK.test(char)) return 'cjk';
  if (WORD_CHAR.test(char)) return 'latin';
  return 'other';
}

function loadRange(model: DocumentModel, range: DocumentRange): Result<{ points: readonly string[] }> {
  const paragraph = requireParagraph(model, range.node_id);
  if (!paragraph.ok) return paragraph;
  const points = Array.from(buildInlineTextMap(paragraph.value.inlines).text);
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end > points.length) {
    return fail('invalid_range', `范围 [${range.start}, ${range.end}) 超出段落码位长度 ${points.length}。`, {
      extra: { node_id: range.node_id, start: range.start, end: range.end, total: points.length },
    });
  }
  return succeed({ points });
}

/** 扩到词（WF-088"字词"）。空选区时取插入点左侧的字符所属词。 */
export function expandToWord(model: DocumentModel, range: DocumentRange): Result<DocumentRange> {
  const loaded = loadRange(model, range);
  if (!loaded.ok) return loaded;
  const { points } = loaded.value;

  const probeIndex = range.end > range.start ? range.end - 1 : Math.max(0, range.start - 1);
  const probe = points[probeIndex];
  const kind = classify(probe);
  if (probe === undefined) {
    return succeed({ node_id: range.node_id, start: range.start, end: range.start });
  }
  if (kind === 'cjk') {
    return succeed({ node_id: range.node_id, start: probeIndex, end: probeIndex + 1 });
  }

  let start = probeIndex;
  let end = probeIndex + 1;
  while (start > 0 && classify(points[start - 1]) === kind) start -= 1;
  while (end < points.length && classify(points[end]) === kind) end += 1;
  return succeed({ node_id: range.node_id, start, end });
}

/** 扩到句（WF-088"句"）。 */
export function expandToSentence(model: DocumentModel, range: DocumentRange): Result<DocumentRange> {
  const loaded = loadRange(model, range);
  if (!loaded.ok) return loaded;
  const { points } = loaded.value;

  let start = 0;
  for (let i = Math.min(range.start, points.length) - 1; i >= 0; i -= 1) {
    if (SENTENCE_END.includes(points[i]!)) {
      start = i + 1;
      break;
    }
  }
  let end = points.length;
  for (let i = Math.max(range.end, 0); i < points.length; i += 1) {
    if (SENTENCE_END.includes(points[i]!)) {
      end = i + 1;
      break;
    }
  }
  return succeed({ node_id: range.node_id, start, end });
}

/** 扩到整段（WF-088"段"）。 */
export function expandToParagraph(model: DocumentModel, range: DocumentRange): Result<DocumentRange> {
  const loaded = loadRange(model, range);
  if (!loaded.ok) return loaded;
  return succeed({ node_id: range.node_id, start: 0, end: loaded.value.points.length });
}

/** 全文选区（WF-088"全文"）。 */
export function wholeDocumentSelection(model: DocumentModel): Selection {
  const resolved = resolveRangeExpression(model, '全文');
  return {
    document_id: model.document_id,
    base_revision: model.revision,
    ranges: resolved.status === 'ok' ? resolved.ranges : [],
  };
}

/** 多段选区（WF-088"多段"）：第 `from` 至 `to` 段（1 起、含两端）。 */
export function paragraphSpanSelection(model: DocumentModel, from: number, to: number): Result<Selection> {
  const resolved = resolveRangeExpression(model, `第${from}至${to}段`);
  if (resolved.status !== 'ok') {
    return fail(
      resolved.status === 'invalid' ? 'invalid_expression' : 'not_found',
      resolved.message,
      resolved.detail,
    );
  }
  return succeed({
    document_id: model.document_id,
    base_revision: model.revision,
    ranges: resolved.ranges,
  });
}

/** 表格·单元格选区（WF-088"表格/单元格"）：命中的是该单元格内全部段落。 */
export function tableCellSelection(
  model: DocumentModel,
  table: number,
  row: number,
  column: number,
): Result<Selection> {
  const resolved = resolveRangeExpression(model, `第${table}个表格第${row}行第${column}列`);
  if (resolved.status !== 'ok') {
    return fail(
      resolved.status === 'invalid' ? 'invalid_expression' : 'not_found',
      resolved.message,
      resolved.detail,
    );
  }
  return succeed({
    document_id: model.document_id,
    base_revision: model.revision,
    ranges: resolved.ranges,
  });
}
