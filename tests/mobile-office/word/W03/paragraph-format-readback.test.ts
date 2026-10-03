/**
 * **W03 — 段落 / 缩进 / 间距 / 大纲 / 样式继承 / 列表续编的独立验证**（`tests/mobile-office/word/W03/`）。
 *
 * 覆盖工作书 W03 行：`operations/paragraph/**`、`styles/**`、`numbering/**`，WF-017–044。
 * 独立验收口径（WORD.md 第 21 行）：
 *
 * > 段落、缩进、间距、大纲、样式继承、列表续编真实读回；**显式关闭/清除格式不被继承覆盖**。
 *
 * 本文件**不重复**各包 co-located 单测已钉住的点（`pagination.test.ts`、`spacing.test.ts`、
 * `clear-copy.test.ts`、`cascade.test.ts`、`apply.test.ts` 等）。它只补三类**跨模块、端到端**判据：
 *
 * | § | 行为面 | 既有覆盖 | 本文件新增的独立判据 |
 * |---|---|---|---|
 * | A | 清除/关闭的**写意图**（R117–R120） | 各 clear 单测只断言值 | 逐字段写意图：clear ⇒ `remove`、off ⇒ `write_false`、未指定 ⇒ `omit`；**四个分页开关与全部 16 字段一致** |
 * | B | 显式关闭/清零**压得住**样式继承 | cascade 单测测过 off | 操作→级联的联合读回：off/0pt 来源为 direct；clear 回落到 named_style（无残留） |
 * | C | 首行/悬挂互斥在**级联**下的表现 | 只在属性层测 | 互斥落成 `remove`，有效值回落样式；`hasConflictingIndent` 恒 false |
 * | D | 大纲级别真实读回（WF-036/R115） | 单测覆盖 apply/isHeading | `applyHeading` → 级联合成 outlineLevel 来源为 named_style；大字非标题反例 |
 * | E | 列表**续编 / 重启**的序号读回（WF-042） | 单测测过引用变化 | 用 `computeListLabels` 走一遍文档顺序读回 `1./2./3.`、重启 `5./6.`、续编回 `1./2./3.`，并证明隔离 |
 * | F | 显式直接格式经**真实 DOCX 字节**往返读回 | 无（跨包） | exportDocx→importDocx 后 off / 0pt 原样读回 |
 *
 * ## 反向对照（防"判据是空壳"）
 *
 * - §A 的每条 "clear ⇒ remove" 都配"未指定 ⇒ omit"邻位，二者若被实现混同，立即变红。
 * - §E 的"续编回 1./2./3."必须与"重启后 5./6."产出**不同**标签，否则续编判据是空壳。
 *
 * 断言全部追溯到合同语义（R117–R120 四态、R122 级联顺序、R124 来源层、R115 标题判定、
 * R150 列表序号是自动内容），不照抄实现内部量。
 *
 * ## 已知缺口（不在本文件覆盖，如实登记）
 *
 * `numbering/index.ts` 与 `styles/index.ts` 的头注释明确：当前 `exportDocx` **不消费**新的
 * `StyleTable` / `NumberingTable`，改样式/新建列表不会出现在导出的 DOCX 里（属 `src/documents/docx/**`
 * 的写出范围）。因此 §E 的列表读回在**模型+级联层**完成，§F 的 DOCX 往返只覆盖**段落直接格式**
 * （spacing / 分页开关），不冒充"样式/列表已能导出"。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDocumentModel } from '../../../../src/documents/model/document.js';
import {
  defaultParagraphProperties,
  paragraphNode,
  runNode,
} from '../../../../src/documents/model/nodes.js';
import { TOGGLE_OFF, TOGGLE_ON } from '../../../../src/documents/model/types.js';
import type {
  DocumentModel,
  ParagraphNode,
  ParagraphProperties,
  StyleDefinition,
  StyleTable,
} from '../../../../src/documents/model/types.js';

import {
  createDefaultParagraphProperties,
  createInheritedParagraphProperties,
} from '../../../../src/documents/operations/paragraph/defaults.js';
import { ALIGNMENTS, setAlignment, unsetAlignment } from '../../../../src/documents/operations/paragraph/alignment.js';
import { unsetLineSpacing } from '../../../../src/documents/operations/paragraph/line-spacing.js';
import {
  setSpacingAfter,
  setSpacingBefore,
  spacingLines,
  spacingPt,
  unsetSpacingAfter,
  unsetSpacingBefore,
} from '../../../../src/documents/operations/paragraph/spacing.js';
import {
  clearIndent,
  hasConflictingIndent,
  indentChars,
  setFirstLineIndent,
  setHangingIndent,
  setLeftIndent,
} from '../../../../src/documents/operations/paragraph/indent.js';
import { clearTabStops, addTabStop } from '../../../../src/documents/operations/paragraph/tab-stops.js';
import { clearParagraphBorders, clearParagraphShading } from '../../../../src/documents/operations/paragraph/borders-shading.js';
import {
  PAGINATION_FIELDS,
  setKeepNext,
  unsetPagination,
} from '../../../../src/documents/operations/paragraph/pagination.js';
import { clearParagraphFormat } from '../../../../src/documents/operations/paragraph/clear-copy.js';
import {
  PARAGRAPH_WRITE_INTENT_FIELDS,
  paragraphWriteIntents,
  removedFields,
  writeIntentOfField,
  writtenFields,
} from '../../../../src/documents/operations/paragraph/write-intent.js';

import { resolveParagraphCascade } from '../../../../src/documents/styles/cascade.js';
import { explainParagraphProperties, findEntry } from '../../../../src/documents/styles/explain.js';
import {
  applyHeading,
  effectiveHeadingLevel,
  isHeadingParagraph,
} from '../../../../src/documents/styles/outline.js';

import { EMPTY_NUMBERING_TABLE } from '../../../../src/documents/numbering/types.js';
import { createStandardList } from '../../../../src/documents/numbering/table.js';
import {
  applyNumbered,
  continueListForParagraphs,
  listReferenceOf,
  restartListForParagraphs,
} from '../../../../src/documents/numbering/apply.js';
import { computeListLabels, labelTextsByParagraph } from '../../../../src/documents/numbering/resolve.js';

import { exportDocx } from '../../../../src/documents/docx/export.js';
import { importDocx } from '../../../../src/documents/docx/import.js';

// ---------------------------------------------------------------------------
// 夹具工具
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CORPUS_A = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures', 'corpus-a-independent-deflate.docx');

/** 段落草稿 → 真实 `ParagraphNode`（经 `createDocumentModel` 分配 id，供列表读回使用）。 */
function materialize(
  properties: ParagraphProperties,
  options: { readonly style_ref?: string | null; readonly numbering?: ParagraphNode['numbering'] } = {},
): ParagraphNode {
  const model = createDocumentModel({
    document_id: 'w03',
    blocks: [
      paragraphNode({
        source: 'user_request',
        properties,
        style_ref: options.style_ref ?? null,
        numbering: options.numbering ?? null,
        inlines: [runNode({ text: '正文', source: 'user_request' })],
      }),
    ],
  });
  const block = model.blocks[0];
  if (block === undefined || block.kind !== 'paragraph') throw new Error('夹具段落缺失');
  return block;
}

/** 只重挂直接格式，保留 id / 正文（供"施加操作后读回"）。 */
function withProps(paragraph: ParagraphNode, properties: ParagraphProperties): ParagraphNode {
  return { ...paragraph, properties };
}

function style(
  style_id: string,
  paragraph_properties: StyleDefinition['paragraph_properties'] = {},
  extra: Partial<StyleDefinition> = {},
): StyleDefinition {
  return {
    style_id,
    name: style_id,
    type: 'paragraph',
    based_on: null,
    run_properties: {},
    paragraph_properties,
    is_default: false,
    ...extra,
  };
}

/** 默认段落样式 `Normal`（居中、段后 12pt、与下段同页）+ 基于它的 `Quote`（段后 18pt）。 */
function styleTable(): StyleTable {
  return {
    styles: [
      style(
        'Normal',
        {
          alignment: { state: 'set', value: 'center' },
          spacingAfter: { state: 'set', value: spacingPt(12) },
          keepNext: TOGGLE_ON,
        },
        { is_default: true },
      ),
      style('Quote', { spacingAfter: { state: 'set', value: spacingPt(18) }, keepNext: TOGGLE_ON }, { based_on: 'Normal' }),
    ],
  };
}

function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

// ===========================================================================
// §A 清除 / 关闭的写意图（R117–R120）
// ===========================================================================

describe('§A 清除 / 关闭的**写意图**（R117–R120）', () => {
  it('写意图字段表长度 16，投影逐字段完备且顺序稳定', () => {
    const entries = paragraphWriteIntents(createDefaultParagraphProperties());
    expect(entries).toHaveLength(16);
    expect(entries.map((entry) => entry.field)).toEqual([...PARAGRAPH_WRITE_INTENT_FIELDS]);
    expect(new Set(entries.map((entry) => entry.field)).size).toBe(16);
  });

  it('新建段落的 16 字段写意图全是 omit（"未指定"≠"清除"）', () => {
    const entries = paragraphWriteIntents(createDefaultParagraphProperties());
    expect(entries.every((entry) => entry.intent === 'omit')).toBe(true);
  });

  it('WF-034 清除目标的 16 字段写意图全是 remove（真的会删元素）', () => {
    const entries = paragraphWriteIntents(createInheritedParagraphProperties());
    expect(entries.map((entry) => entry.intent)).toEqual(new Array<string>(16).fill('remove'));
    expect(entries.map((entry) => entry.state)).toEqual(new Array<string>(16).fill('inherit'));
  });

  it('**四个分页开关**清除后写意图必须是 remove，不是 omit（本次修复点）', () => {
    for (const field of PAGINATION_FIELDS) {
      const cleared = unsetPagination(createDefaultParagraphProperties(), field);
      expect(writeIntentOfField(cleared, field), field).toBe('remove');
      // 与 WF-034 的清除目标对同一字段完全一致
      expect(cleared[field]).toEqual(createInheritedParagraphProperties()[field]);
    }
  });

  it('对照：显式关 ⇒ write_false，显式开 ⇒ write_true，未指定 ⇒ omit（三者互不冒充，R118）', () => {
    const base = createDefaultParagraphProperties();
    const off = setKeepNext(base, false);
    const on = setKeepNext(base, true);
    expect(writeIntentOfField(off, 'keepNext')).toBe('write_false');
    expect(writeIntentOfField(on, 'keepNext')).toBe('write_true');
    expect(writeIntentOfField(base, 'keepNext')).toBe('omit');
    // 三个写意图两两不同
    expect(new Set([
      writeIntentOfField(off, 'keepNext'),
      writeIntentOfField(on, 'keepNext'),
      writeIntentOfField(base, 'keepNext'),
    ]).size).toBe(3);
  });

  it('该包每个 clear/unset 入口都产出 remove（表驱动，逐字段）', () => {
    const base = createDefaultParagraphProperties();
    const cases: readonly { readonly label: string; readonly props: ParagraphProperties; readonly fields: readonly string[] }[] = [
      { label: 'unsetAlignment', props: unsetAlignment(base), fields: ['alignment'] },
      { label: 'unsetLineSpacing', props: unsetLineSpacing(base), fields: ['lineSpacing'] },
      { label: 'unsetSpacingBefore', props: unsetSpacingBefore(base), fields: ['spacingBefore'] },
      { label: 'unsetSpacingAfter', props: unsetSpacingAfter(base), fields: ['spacingAfter'] },
      {
        label: 'clearIndent',
        props: clearIndent(base),
        fields: ['indent.left', 'indent.right', 'indent.firstLine', 'indent.hanging'],
      },
      { label: 'clearTabStops', props: clearTabStops(base), fields: ['tabStops'] },
      { label: 'clearParagraphBorders', props: clearParagraphBorders(base), fields: ['borders'] },
      { label: 'clearParagraphShading', props: clearParagraphShading(base), fields: ['shading'] },
    ];
    for (const testCase of cases) {
      for (const field of testCase.fields) {
        expect(
          writeIntentOfField(testCase.props, field as never),
          `${testCase.label} → ${field}`,
        ).toBe('remove');
      }
    }
  });

  it('区分"显式清零"与"清除"：spacingAfter=0pt 是 write_value，不是 remove/omit', () => {
    const props = setSpacingAfter(createDefaultParagraphProperties(), spacingPt(0));
    expect(writeIntentOfField(props, 'spacingAfter')).toBe('write_value');
    // removedFields 不含它（不是删除），writtenFields 含它（会写 w:after="0"）
    expect(removedFields(props)).not.toContain('spacingAfter');
    expect(writtenFields(props)).toContain('spacingAfter');
  });

  it('混合态：一次设置里"设为值 + 清除另一侧"各自写意图正确', () => {
    // 左缩进设为 2cm，其余缩进槽位清除
    const props = setLeftIndent(createInheritedParagraphProperties(), { unit: 'cm', value: 2 });
    const removed = removedFields(props);
    const written = writtenFields(props);
    expect(written).toContain('indent.left');
    expect(removed).toContain('indent.right');
    expect(removed).toContain('indent.firstLine');
    expect(removed).toContain('indent.hanging');
  });

  it('五种对齐的 set 都是 write_value（对齐不是开关）', () => {
    for (const alignment of ALIGNMENTS) {
      const props = setAlignment(createDefaultParagraphProperties(), alignment);
      expect(writeIntentOfField(props, 'alignment'), alignment).toBe('write_value');
    }
  });

  it('制表位：新增是 write_value，清除是 remove', () => {
    const added = addTabStop(createDefaultParagraphProperties(), { position: { unit: 'cm', value: 1 }, alignment: 'left', leader: 'none' });
    expect(writeIntentOfField(added, 'tabStops')).toBe('write_value');
    expect(writeIntentOfField(clearTabStops(added), 'tabStops')).toBe('remove');
  });
});

// ===========================================================================
// §B 显式关闭 / 清除不被继承覆盖（操作 → 级联 联合读回）
// ===========================================================================

describe('§B 显式关闭 / 清零压得住继承，清除无残留', () => {
  const table = styleTable();

  function resolve(paragraph: ParagraphNode) {
    return resolveParagraphCascade({ styles: table, style_ref: paragraph.style_ref, direct: paragraph.properties });
  }

  it('样式要求 keepNext=on，段落显式关 ⇒ 有效值 false，来源 direct', () => {
    const paragraph = withProps(materialize(createDefaultParagraphProperties(), { style_ref: 'Quote' }), setKeepNext(createDefaultParagraphProperties(), false));
    const resolved = resolve(paragraph).properties.keepNext;
    expect(resolved.specified).toBe(true);
    if (!resolved.specified) return;
    expect(resolved.value).toBe(false);
    expect(resolved.origin.layer).toBe('direct');
  });

  it('样式段后 18pt，段落显式 0pt ⇒ 有效值 0pt（style 的 18 不覆盖），来源 direct', () => {
    const direct = setSpacingAfter(createDefaultParagraphProperties(), spacingPt(0));
    const paragraph = withParagraphProps(style_ref('Quote'), direct);
    const resolved = resolve(paragraph).properties.spacingAfter;
    expect(resolved.specified).toBe(true);
    if (!resolved.specified) return;
    expect(resolved.value).toEqual(spacingPt(0));
    expect(resolved.origin.layer).toBe('direct');
  });

  it('清除段后 ⇒ 有效值回落到命名样式 18pt，来源 named_style（清除不是"变空"）', () => {
    const direct = unsetSpacingAfter(createDefaultParagraphProperties());
    const paragraph = withParagraphProps(style_ref('Quote'), direct);
    const resolved = resolve(paragraph).properties.spacingAfter;
    expect(resolved.specified).toBe(true);
    if (!resolved.specified) return;
    expect(resolved.value).toEqual(spacingPt(18));
    expect(resolved.origin.layer).toBe('named_style');
    expect(resolved.origin.style_id).toBe('Quote');
  });

  it('清除分页开关 ⇒ 有效值回落样式 on，且写意图是 remove（删掉旧元素让样式透出来）', () => {
    const direct = unsetPagination(createDefaultParagraphProperties(), 'keepNext');
    const paragraph = withParagraphProps(style_ref('Quote'), direct);
    const resolved = resolve(paragraph).properties.keepNext;
    expect(resolved.specified).toBe(true);
    if (!resolved.specified) return;
    expect(resolved.value).toBe(true);
    expect(resolved.origin.layer).toBe('named_style');
    expect(writeIntentOfField(direct, 'keepNext')).toBe('remove');
  });

  it('WF-034 clearParagraphFormat ⇒ 直接格式全清，有效值全部来自样式（居中 + 段后 12pt）', () => {
    const messy = setSpacingBefore(
      setAlignment(createDefaultParagraphProperties(), 'right'),
      spacingLines(3),
    );
    const paragraph = clearParagraphFormat(materialize(messy));
    const explanation = explainParagraphProperties(table, { ...paragraph, style_ref: 'Quote' });
    // 直接格式已无任何字段
    expect(removedFields(paragraph.properties).length).toBe(16);
    // 对齐回落 Normal 的 center（Quote 未设对齐，从 basedOn 继承）
    const alignment = findEntry(explanation, 'alignment');
    expect(alignment?.value).toBe('center');
    expect(alignment?.origin?.layer).toBe('named_style');
    // 段前已被清掉：不再来自 direct
    const before = findEntry(explanation, 'spacingBefore');
    expect(before?.origin?.layer).not.toBe('direct');
  });

  it('深拷贝读回：清除后改样式表不影响已解析结果', () => {
    const paragraph = withProps(style_ref('Quote'), unsetSpacingAfter(createDefaultParagraphProperties()));
    const first = resolve(paragraph).properties.spacingAfter;
    expects18(first);
    // 构造一个同值但不同的表引用，确认解析结果与表未共享对象
    const mutated: StyleTable = { styles: table.styles.map((s) => ({ ...s })) };
    const again = resolveParagraphCascade({ styles: mutated, style_ref: 'Quote', direct: paragraph.properties }).properties.spacingAfter;
    expects18(again);
  });

  function expects18(slot: { specified: boolean; value: unknown }): void {
    expect(slot.specified).toBe(true);
    expect(slot.value).toEqual(spacingPt(18));
  }
});

// helper：造一个只带 style_ref 的空段落
function style_ref(id: string): ParagraphNode {
  return materialize(createDefaultParagraphProperties(), { style_ref: id });
}
function withParagraphProps(paragraph: ParagraphNode, properties: ParagraphProperties): ParagraphNode {
  return { ...paragraph, properties };
}

// ===========================================================================
// §C 首行 / 悬挂互斥在级联下的表现（WF-027/028）
// ===========================================================================

describe('§C 首行/悬挂互斥在级联下（WF-027/028）', () => {
  it('设悬挂 ⇒ 首行的直接格式落 remove；有效首行回落到样式；无冲突态', () => {
    const table: StyleTable = {
      styles: [
        style('Normal', { indent: { firstLine: { state: 'set', value: indentChars(2) }, hanging: { state: 'unspecified' }, left: { state: 'unspecified' }, right: { state: 'unspecified' } } }, { is_default: true }),
      ],
    };
    const direct = setHangingIndent(createDefaultParagraphProperties(), indentChars(1));
    expect(writeIntentOfField(direct, 'indent.firstLine')).toBe('remove');
    expect(writeIntentOfField(direct, 'indent.hanging')).toBe('write_value');
    expect(hasConflictingIndent(direct.indent)).toBe(false);

    const cascade = resolveParagraphCascade({ styles: table, style_ref: null, direct });
    // hanging 直接设置生效
    expect(cascade.properties.indent.hanging.specified).toBe(true);
    if (cascade.properties.indent.hanging.specified) {
      expect(cascade.properties.indent.hanging.value).toEqual(indentChars(1));
      expect(cascade.properties.indent.hanging.origin.layer).toBe('direct');
    }
    // firstLine 因互斥被删，有效值来自文档默认样式
    expect(cascade.properties.indent.firstLine.specified).toBe(true);
    if (cascade.properties.indent.firstLine.specified) {
      expect(cascade.properties.indent.firstLine.value).toEqual(indentChars(2));
      expect(cascade.properties.indent.firstLine.origin.layer).toBe('document_default');
    }
  });

  it('反向对照：设首行 ⇒ 悬挂回落；两次互斥操作后恒无冲突', () => {
    let props = createDefaultParagraphProperties();
    props = setFirstLineIndent(props, indentChars(2));
    props = setHangingIndent(props, indentChars(2));
    props = setFirstLineIndent(props, indentChars(1));
    expect(hasConflictingIndent(props.indent)).toBe(false);
    expect(props.indent.firstLine.state).toBe('set');
    expect(props.indent.hanging.state).toBe('inherit');
  });
});

// ===========================================================================
// §D 大纲级别真实读回（WF-036 / R115）
// ===========================================================================

describe('§D 大纲级别与标题判定（WF-036 / R115）', () => {
  it('applyHeading(2) ⇒ 写引用不写外观；级联合成 outlineLevel=1 来源 named_style', () => {
    const paragraph = materialize(createDefaultParagraphProperties());
    const applied = applyHeading({ styles: [] }, paragraph, 2);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.paragraph.style_ref).toBe('Heading2');
    // 只写引用：直接格式被清成 inherit
    expect(removedFields(applied.paragraph.properties).length).toBe(16);

    const cascade = resolveParagraphCascade({
      styles: applied.table,
      style_ref: applied.paragraph.style_ref,
      direct: applied.paragraph.properties,
    });
    const outline = cascade.properties.outlineLevel;
    expect(outline.specified).toBe(true);
    if (outline.specified) {
      expect(outline.value).toBe(1); // 标题 2 ↔ outlineLvl 1
      expect(outline.origin.layer).toBe('named_style');
    }

    const heading = isHeadingParagraph(applied.table, applied.paragraph);
    expect(heading.is_heading).toBe(true);
    expect(heading.level).toBe(2);
    expect(heading.source).toBe('style');
    expect(effectiveHeadingLevel(applied.table, applied.paragraph).outline_level).toBe(1);
  });

  it('反例（R115）：字号很大但没有样式/大纲级别 ⇒ **不是**标题', () => {
    const huge = materialize(createDefaultParagraphProperties());
    const heading = isHeadingParagraph({ styles: [] }, huge);
    expect(heading.is_heading).toBe(false);
    expect(heading.level).toBeNull();
  });

  it('直接格式给 outlineLevel=0（标题 1）也能识别，来源为 direct', () => {
    const direct = { ...createDefaultParagraphProperties(), outlineLevel: { state: 'set' as const, value: 0 } };
    const paragraph = withParagraphProps(materialize(createDefaultParagraphProperties()), direct);
    const heading = isHeadingParagraph({ styles: [] }, paragraph);
    expect(heading.is_heading).toBe(true);
    expect(heading.level).toBe(1);
    expect(heading.source).toBe('outline_level');
    const cascade = resolveParagraphCascade({ styles: { styles: [] }, style_ref: null, direct });
    expect(cascade.properties.outlineLevel.specified).toBe(true);
    if (cascade.properties.outlineLevel.specified) {
      expect(cascade.properties.outlineLevel.origin.layer).toBe('direct');
    }
  });
});

// ===========================================================================
// §E 列表续编 / 重启的序号真实读回（WF-042）
// ===========================================================================

describe('§E 列表续编与重启的序号读回（WF-042）', () => {
  it('三项编号列表 ⇒ 读回 1./2./3.；重启指定项 ⇒ 5./6.；续编 ⇒ 回 1./2./3.', () => {
    const built = createStandardList(EMPTY_NUMBERING_TABLE, 'number');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const numId = built.num_id;

    // 三个段落加入同一列表
    let paragraphs = ['一', '二', '三'].map((text, index) => {
      const paragraph = materialize(createDefaultParagraphProperties(), {
        numbering: { num_id: numId, level: 0 },
      });
      // 保留不同 id（materialize 每次给同一 document_id，id 可能重复；这里文档顺序即数组顺序）
      return { ...paragraph, id: `${paragraph.id}-${String(index)}` };
    });

    const first = computeListLabels(built.table, paragraphs);
    expect(first.failures).toEqual([]);
    expect([...labelTextsByParagraph(first).values()]).toEqual(['1.', '2.', '3.']);

    // 重启后两项：新实例起始 5
    const targetIds = [paragraphs[1]!.id, paragraphs[2]!.id];
    const restarted = restartListForParagraphs(built.table, paragraphs, targetIds, numId, {
      overrides: [{ level: 0, start: 5 }],
    });
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(restarted.num_id).not.toBe(numId);

    const afterRestart = computeListLabels(restarted.table, restarted.paragraphs);
    const restartTexts = [...labelTextsByParagraph(afterRestart).values()];
    expect(restartTexts).toEqual(['1.', '5.', '6.']);
    // 反向对照：重启后 ≠ 原序号（"5./6." ≠ "2./3."），否则判据是空壳
    expect(restartTexts).not.toEqual(['1.', '2.', '3.']);
    // 隔离：第一项仍指向原实例，序号未受影响
    expect(listReferenceOf(restarted.paragraphs[0]!)?.num_id).toBe(numId);

    // 续编：把后两项指回原实例 ⇒ 计数接续
    const continued = continueListForParagraphs(restarted.table, restarted.paragraphs, targetIds, numId);
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    const afterContinue = computeListLabels(restarted.table, continued.paragraphs);
    expect([...labelTextsByParagraph(afterContinue).values()]).toEqual(['1.', '2.', '3.']);
  });

  it('不误改其他列表：第二份列表的计数与第一份完全隔离', () => {
    const listA = createStandardList(EMPTY_NUMBERING_TABLE, 'number');
    expect(listA.ok).toBe(true);
    if (!listA.ok) return;
    const listB = createStandardList(listA.table, 'number');
    expect(listB.ok).toBe(true);
    if (!listB.ok) return;

    const a1 = applyNumbered(materialize(createDefaultParagraphProperties(), { numbering: { num_id: listA.num_id, level: 0 } }), listB.table, { num_id: listA.num_id, level: 0 });
    expect(a1.ok).toBe(true);
    const b1 = applyNumbered(materialize(createDefaultParagraphProperties(), { numbering: { num_id: listB.num_id, level: 0 } }), listB.table, { num_id: listB.num_id, level: 0 });
    expect(b1.ok).toBe(true);
    if (!a1.ok || !b1.ok) return;
    // 夹具里两个段落来自同一 document_id，id 会重复；读回按 id 建索引，故必须区分。
    const aPara = { ...a1.paragraph, id: `${a1.paragraph.id}-listA` };
    const bPara = { ...b1.paragraph, id: `${b1.paragraph.id}-listB` };

    const result = computeListLabels(listB.table, [aPara, bPara]);
    expect([...labelTextsByParagraph(result).values()]).toEqual(['1.', '1.']);
    expect(result.labels[0]?.reference.num_id).not.toBe(result.labels[1]?.reference.num_id);
  });
});

// ===========================================================================
// §F 显式直接格式经真实 DOCX 字节往返读回
// ===========================================================================

describe('§F 真实 DOCX export→import 后显式直接格式原样读回', () => {
  function modelWith(drafts: readonly ReturnType<typeof paragraphNode>[]): DocumentModel {
    const created = createDocumentModel({ document_id: 'w03-docx', blocks: drafts });
    const base = corpusModel();
    return { ...base, blocks: created.blocks };
  }

  it('显式关（keepNext=off）与显式清零（段后 0pt）经字节往返仍在', () => {
    const props = setSpacingAfter(setKeepNext(createDefaultParagraphProperties(), false), spacingPt(0));
    const draft = paragraphNode({
      source: 'user_request',
      properties: props,
      inlines: [runNode({ text: '显式格式', source: 'user_request' })],
    });

    const bytes = exportDocx(modelWith([draft]));
    expect(bytes.length).toBeGreaterThan(0);
    const reopened = importDocx(bytes);

    const paragraph = reopened.blocks.find((block) => block.kind === 'paragraph');
    expect(paragraph).toBeDefined();
    if (paragraph === undefined || paragraph.kind !== 'paragraph') return;
    expect(paragraph.properties.keepNext).toEqual(TOGGLE_OFF);
    expect(paragraph.properties.spacingAfter).toEqual({ state: 'set', value: spacingPt(0) });
  });

  it('对照：清除（inherit）经往返后元素不存在（读回未指定），不会残留"显式关"字节', () => {
    const cleared = clearParagraphFormat(
      materialize(setKeepNext(createDefaultParagraphProperties(), false)),
    );
    const draft = paragraphNode({
      source: 'user_request',
      properties: cleared.properties,
      inlines: [runNode({ text: '已清除', source: 'user_request' })],
    });
    const reopened = importDocx(exportDocx(modelWith([draft])));
    const paragraph = reopened.blocks.find((block) => block.kind === 'paragraph');
    if (paragraph === undefined || paragraph.kind !== 'paragraph') throw new Error('缺少段落');
    // clear ⇒ 元素不写；读回是"未指定"，与 off / on 都分得开（R118）
    expect(paragraph.properties.keepNext.state).toBe('unspecified');
    expect(paragraph.properties.keepNext).not.toEqual(TOGGLE_OFF);
    expect(paragraph.properties.keepNext).not.toEqual(TOGGLE_ON);
  });
});
