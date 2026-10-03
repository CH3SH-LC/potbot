/**
 * `word-format-product` 的单测：**排版要求真的落进字节**。
 *
 * ## 这一套件回答的唯一问题
 *
 * 「模型说改了」与「字节里真的有那几样标记」是两件事。本套件把后者钉死：
 * 起点用**产品真实起点**（`buildDocxTemplate` 的 `title-body-v1`，与
 * `conversation-host.ts` 的 `create_word_document` 逐字同源），排版后**导出字节**，
 * 再用 **ZIP 读回 + 文本检索**核对六样标记：
 *
 * | 要求 | 期望在 `word/document.xml` 里看到 |
 * |---|---|
 * | 标题居中 | `<w:jc w:val="center"/>` |
 * | 标题加粗 | `<w:b/>` |
 * | 三号字（16pt = 32 半磅） | `<w:sz w:val="32"/>` |
 * | 正文首行缩进 2 字符 | `<w:ind ... w:firstLineChars="200"/>` |
 * | 三行两列的表格 | `<w:tbl>` 与 3 个 `<w:tr>` |
 *
 * 另有反例：**不施加**排版时，这六样一个都不该出现（起点本身不含它们）——
 * 没有这条，"标记出现"可能只是起点本来就有。
 *
 * ## 诚实边界
 *
 * - **渲染效果未验证**：本机无授权 Office、无真机，本套件只证明**字节里有这些标记**，
 *   不证明 Word 里"看起来是那样"（R155/R156 不许越级宣称）。
 * - 【模型身份】本文件由**子智能体**产出，**子智能体模型身份未确认为 DS**。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../src/artifacts/ooxml/zip-read.js';
import { DOCX_TITLE_BODY_PRESENTATION, buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import { applyWordFormatting, parseWordFormatRequest } from './word-format-product.js';

const TITLE = '本周工作周报';
const BODY = [
  '本周完成了阶段任务的梳理与排期，并处理了若干遗留问题。',
  '与相关同事做了两轮沟通，把口径对齐后落成了书面记录。',
  '下周计划继续推进既定事项，并安排一次阶段性复盘。',
];

function baseBytes(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: TITLE,
      description: BODY.join('\n'),
      paragraphs: BODY,
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [],
  }).bytes;
}

function mainXml(bytes: Uint8Array): string {
  const entry = readZip(bytes).by_path.get('word/document.xml');
  if (entry === undefined) throw new Error('导出的包里没有 word/document.xml');
  return new TextDecoder().decode(entry.data);
}

/** 用户原话对应的请求（走**产品解析器**，不是手搓对象——解析本身也是被测对象）。 */
function userRequest(): ReturnType<typeof parseWordFormatRequest> {
  return parseWordFormatRequest({
    title_alignment: 'center',
    title_bold: true,
    title_font_size: '三号',
    body_first_line_indent_chars: 2,
    table: {
      rows: 3,
      cols: 2,
      header: true,
      cells: [
        ['事项', '状态'],
        ['阶段任务梳理', '已完成'],
        ['遗留问题排查', '进行中'],
      ],
    },
  });
}

describe('反例：起点字节里，那六样标记一个都不在', () => {
  it('未施加排版时，起点本身不含 w:jc / w:b / w:sz / w:ind / w:tbl', () => {
    const xml = mainXml(baseBytes());
    expect(xml).not.toContain('<w:jc ');
    expect(xml).not.toContain('<w:b/>');
    expect(xml).not.toContain('<w:sz ');
    expect(xml).not.toContain('<w:ind ');
    expect(xml).not.toContain('<w:tbl>');
  });
});

describe('正例：六样标记全部落进导出的字节（修复后的真实排版通道）', () => {
  it('居中 / 加粗 / 三号 / 首行缩进 2 字符 / 三行两列表格', () => {
    const parsed = userRequest();
    if (!parsed.ok) throw new Error(`参数解析失败：${parsed.code} ${parsed.message}`);
    const applied = applyWordFormatting(baseBytes(), parsed.request);
    if (!applied.ok) throw new Error(`排版失败：${applied.code} ${applied.message}`);

    expect(applied.model_changed).toBe(true);
    expect(applied.table_inserted).toBe(true);
    expect(applied.table_shape).toEqual({ rows: 3, cols: 2, header: true });

    const xml = mainXml(applied.bytes);
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('<w:b/>');
    // 三号 = 16pt = 32 半磅（映射来自 src/documents/units/font-size.ts，本模块不复制该表）。
    expect(xml).toContain('<w:sz w:val="32"/>');
    // "首行缩进 2 字符" 走字符域：units/indent.ts 唯一决定它落 firstLineChars="200"。
    expect(xml).toContain('w:firstLineChars="200"');
    expect(xml).toMatch(/<w:ind [^>]*w:firstLineChars="200"/);
    // 表格：一开三行。
    expect(xml).toContain('<w:tbl>');
    expect(xml.match(/<w:tr>/g)?.length).toBe(3);
    // 表头行真的被标成表头。
    expect(xml).toContain('<w:tblHeader/>');
    // 单元格文字在。
    expect(xml).toContain('阶段任务梳理');
  });

  it('同一输入 ⇒ 同一字节（确定性，可复算）', () => {
    const parsed = userRequest();
    if (!parsed.ok) throw new Error('解析失败');
    const first = applyWordFormatting(baseBytes(), parsed.request);
    const second = applyWordFormatting(baseBytes(), parsed.request);
    if (!first.ok || !second.ok) throw new Error('排版失败');
    expect(mainXml(first.bytes)).toBe(mainXml(second.bytes));
  });

  it('只要求排版、不动正文时，正文段落仍然逐字保留', () => {
    const parsed = parseWordFormatRequest({ title_alignment: 'center' });
    if (!parsed.ok) throw new Error('解析失败');
    const applied = applyWordFormatting(baseBytes(), parsed.request);
    if (!applied.ok) throw new Error('排版失败');
    const xml = mainXml(applied.bytes);
    for (const paragraph of BODY) expect(xml).toContain(paragraph);
  });
});

describe('封闭参数表：多一个键、值不在枚举里，一律结构化拒绝', () => {
  it('未知参数被具名拒绝（不静默忽略）', () => {
    const parsed = parseWordFormatRequest({ title_align: 'center' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe('unknown_parameter');
  });

  it('空请求被拒（一样都不给 = 没有可执行的动作）', () => {
    const parsed = parseWordFormatRequest({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe('empty_request');
  });

  it('对齐值不在枚举里被拒', () => {
    const parsed = parseWordFormatRequest({ title_alignment: '居中' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe('invalid_title_alignment');
  });

  it('表格行列数超界被拒', () => {
    const parsed = parseWordFormatRequest({ table: { rows: 0, cols: 2 } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe('invalid_table_rows');
  });
});
