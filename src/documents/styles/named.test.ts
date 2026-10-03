/**
 * 命名样式可修改层测试（WF-037/038）。
 *
 * 判据：
 * - 改一个命名样式后，**所有**引用它的段落读回都变（一致更新）；
 * - 直接格式覆盖**仍然生效**（不被样式改回去）；
 * - `basedOn` 成环**有限终止**、明确拒绝（不无限递归）。
 */

import { describe, expect, it } from 'vitest';
import type { BlockNode, ParagraphNode, StyleDefinition, StyleTable } from '../model/types.js';
import { TOGGLE_ON } from '../model/types.js';
import { createNamedStyle, deleteNamedStyle, modifyNamedStyle, paragraphsUsingStyle, resetNamedStyle, retargetStyleReferences, setStyleBasedOn, styleDescendants, stylesBasedOn } from './named.js';
import { resolveParagraphCascade } from './cascade.js';
import { resolveStyleChain } from './chain.js';
import { applyParagraphStyle } from './apply.js';
import { createDefaultParagraphProperties } from '../operations/paragraph/defaults.js';
import { setAlignment } from '../operations/paragraph/alignment.js';
import { createDocumentModel } from '../model/document.js';
import { cellNode, paragraphNode, rowNode, tableNode } from '../model/nodes.js';

function style(style_id: string, extra: Partial<StyleDefinition> = {}): StyleDefinition {
  return {
    style_id,
    name: style_id,
    type: 'paragraph',
    based_on: null,
    run_properties: {},
    paragraph_properties: {},
    is_default: false,
    ...extra,
  };
}

function para(id: string, styleRef: string | null = null): ParagraphNode {
  return {
    kind: 'paragraph',
    id,
    source: 'user_request',
    opaque: [],
    properties: createDefaultParagraphProperties(),
    inlines: [],
    style_ref: styleRef,
    numbering: null,
  };
}

describe('新建命名样式（WF-037）', () => {
  it('新建成功且不产生第二个同 id 样式', () => {
    const result = createNamedStyle({ styles: [] }, style('Quote', { name: '引用' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.styles).toHaveLength(1);
    const dup = createNamedStyle(result.table, style('Quote'));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe('duplicate_style_id');
  });

  it('反面：基于不存在的样式 → 拒绝', () => {
    const result = createNamedStyle({ styles: [] }, style('Quote', { based_on: 'Ghost' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('dangling_based_on');
  });

  it('反面：类型不符（段落样式基于字符样式）→ 拒绝', () => {
    const character = style('Emph', { type: 'character' });
    const result = createNamedStyle({ styles: [character] }, style('Quote', { based_on: 'Emph' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('wrong_type');
  });
});

describe('一致更新（WF-037 的核心判据）', () => {
  it('改命名样式后，所有引用它的段落读回都变', () => {
    const heading = style('Heading1', { paragraph_properties: { alignment: { state: 'set', value: 'left' } } });
    const table: StyleTable = { styles: [heading] };
    const applied = applyParagraphStyle(para('p1'), 'Heading1');

    const before = resolveParagraphCascade({ styles: table, style_ref: applied.style_ref, direct: applied.properties });
    expect(before.properties.alignment.value).toBe('left');

    const changed = modifyNamedStyle(table, 'Heading1', {
      paragraph_properties: { alignment: { state: 'set', value: 'center' } },
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    // 两个引用同一命名样式的段落，读回都变了。
    for (const id of ['p1', 'p2']) {
      const item = applyParagraphStyle(para(id), 'Heading1');
      const after = resolveParagraphCascade({ styles: changed.table, style_ref: item.style_ref, direct: item.properties });
      expect(after.properties.alignment.value).toBe('center');
      expect(after.properties.alignment.origin?.style_name).toBe('Heading1');
    }
  });

  it('直接格式覆盖仍生效：改样式不动直接格式', () => {
    const table: StyleTable = { styles: [style('Heading1', { paragraph_properties: { alignment: { state: 'set', value: 'left' } } })] };
    const dirty: ParagraphNode = {
      ...para('p1', 'Heading1'),
      properties: setAlignment(createDefaultParagraphProperties(), 'right'),
    };
    const changed = modifyNamedStyle(table, 'Heading1', {
      paragraph_properties: { alignment: { state: 'set', value: 'center' } },
    });
    if (!changed.ok) throw new Error('改样式失败');
    const resolved = resolveParagraphCascade({ styles: changed.table, style_ref: dirty.style_ref, direct: dirty.properties });
    expect(resolved.properties.alignment.value).toBe('right');
    expect(resolved.properties.alignment.origin?.layer).toBe('direct');
  });

  it('paragraphsUsingStyle 深度遍历（含表格单元格内）', () => {
    const model = createDocumentModel({
      document_id: 'doc',
      blocks: [
        paragraphNode({ source: 'user_request', style_ref: 'Quote' }),
        tableNode({
          source: 'user_request',
          grid: [],
          rows: [
            rowNode({
              source: 'user_request',
              cells: [
                cellNode({
                  source: 'user_request',
                  blocks: [
                    paragraphNode({ source: 'user_request', style_ref: 'Quote' }),
                    paragraphNode({ source: 'user_request' }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    });
    expect(paragraphsUsingStyle(model.blocks, 'Quote')).toHaveLength(2);
  });
});

describe('basedOn 成环不无限递归（R123）', () => {
  it('设置会成环的 basedOn → 明确拒绝', () => {
    const a = style('A');
    const b = style('B', { based_on: 'A' });
    const result = setStyleBasedOn({ styles: [a, b] }, 'A', 'B');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('cycle_based_on');
  });

  it('自环（basedOn 指向自己）→ 拒绝', () => {
    const result = setStyleBasedOn({ styles: [style('A')] }, 'A', 'A');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('cycle_based_on');
  });

  it('即便表里已有坏环，读取链仍然有限终止（返回 conflict 而非栈溢出）', () => {
    const broken: StyleTable = { styles: [style('A', { based_on: 'B' }), style('B', { based_on: 'A' })] };
    const result = resolveStyleChain(broken, 'A');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe('cycle');
  });

  it('健全的链可以设置成功', () => {
    const result = setStyleBasedOn({ styles: [style('A'), style('B', { based_on: 'A' })] }, 'B', null);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.table.styles.find((item) => item.style_id === 'B')?.based_on).toBeNull();
  });
});

describe('重置（WF-038 的"清除覆盖回继承"）', () => {
  it('重置清空本层表达，有效值回落到 basedOn', () => {
    const base = style('Base', {
      paragraph_properties: { alignment: { state: 'set', value: 'justify' }, keepNext: TOGGLE_ON },
    });
    const child = style('Child', {
      based_on: 'Base',
      paragraph_properties: { alignment: { state: 'set', value: 'center' } },
    });
    const table: StyleTable = { styles: [base, child] };
    const applied = applyParagraphStyle(para('p1'), 'Child');
    const before = resolveParagraphCascade({ styles: table, style_ref: applied.style_ref, direct: applied.properties });
    expect(before.properties.alignment.value).toBe('center');

    const reset = resetNamedStyle(table, 'Child');
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    const after = resolveParagraphCascade({ styles: reset.table, style_ref: 'Child', direct: applied.properties });
    expect(after.properties.alignment.value).toBe('justify');
    expect(after.properties.alignment.origin?.style_name).toBe('Base');
  });

  it('重置保留 basedOn（keepBase 默认 true）；keepBase:false 时连 basedOn 一起清', () => {
    const table: StyleTable = { styles: [style('Base'), style('Child', { based_on: 'Base' })] };
    const kept = resetNamedStyle(table, 'Child');
    if (!kept.ok) throw new Error('重置失败');
    expect(kept.table.styles.find((item) => item.style_id === 'Child')?.based_on).toBe('Base');

    const dropped = resetNamedStyle(table, 'Child', { keepBase: false });
    if (!dropped.ok) throw new Error('重置失败');
    expect(dropped.table.styles.find((item) => item.style_id === 'Child')?.based_on).toBeNull();
  });

  it('反面：重置不存在的样式 → 拒绝', () => {
    const result = resetNamedStyle({ styles: [] }, 'Ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_style');
  });
});

describe('删除与引用完整性', () => {
  it('反面：仍有样式基于它时删除被拒绝', () => {
    const table: StyleTable = { styles: [style('A'), style('B', { based_on: 'A' })] };
    const result = deleteNamedStyle(table, 'A');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('style_in_use');
  });

  it('给出 reassign_to 后删除成功，后代改指替代样式', () => {
    const table: StyleTable = { styles: [style('A'), style('B', { based_on: 'A' }), style('C')] };
    const result = deleteNamedStyle(table, 'A', { reassign_to: 'C' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.table.styles.map((item) => item.style_id)).toEqual(['B', 'C']);
    expect(result.table.styles.find((item) => item.style_id === 'B')?.based_on).toBe('C');
  });

  it('反面：reassign_to 类型不符 → 拒绝', () => {
    const table: StyleTable = { styles: [style('A'), style('B', { based_on: 'A' }), style('X', { type: 'character' })] };
    const result = deleteNamedStyle(table, 'A', { reassign_to: 'X' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('wrong_type');
  });

  it('retargetStyleReferences 把段落引用改指；无命中返回 null', () => {
    const blocks: readonly BlockNode[] = [para('p1', 'A'), para('p2', 'A'), para('p3', null)];
    const changed = retargetStyleReferences(blocks, 'A', 'C');
    expect(changed?.changed).toEqual(['p1', 'p2']);
    expect((changed?.blocks[0] as ParagraphNode).style_ref).toBe('C');
    expect(retargetStyleReferences(blocks, 'Ghost', 'C')).toBeNull();
  });
});

describe('继承关系查询', () => {
  it('stylesBasedOn / styleDescendants 给出影响面', () => {
    const table: StyleTable = { styles: [style('A'), style('B', { based_on: 'A' }), style('C', { based_on: 'B' })] };
    expect(stylesBasedOn(table, 'A').map((item) => item.style_id)).toEqual(['B']);
    expect([...styleDescendants(table, 'A')].sort()).toEqual(['B', 'C']);
  });
});
