/**
 * 读侧计数测试（WF-040/042）。
 *
 * 两条关键判据在这里被验证（因为"序号只存在于编号表 + 遍历顺序里"，R150）：
 * 1. **删除中间项后编号续接正确**：剩下的项重新连续编号（不是留空缺、也不是错号）；
 * 2. **列表隔离**：一份列表的重启/删除**不影响**另一份。
 */

import { describe, expect, it } from 'vitest';
import { createList, restartList } from './table.js';
import { computeListLabels, labelTextsByParagraph, labelsForList, paragraphListText, toNumberingPartShape } from './resolve.js';
import { EMPTY_NUMBERING_TABLE, type NumberingTable } from './types.js';
import type { ParagraphNode } from '../model/types.js';
import { createDefaultParagraphProperties } from '../operations/paragraph/defaults.js';

function para(id: string, numId: string, level = 0): ParagraphNode {
  return {
    kind: 'paragraph',
    id,
    source: 'user_request',
    opaque: [],
    properties: createDefaultParagraphProperties(),
    inlines: [],
    style_ref: null,
    numbering: { num_id: numId, level },
  };
}

function numberList(start = 1): { table: NumberingTable; numId: string } {
  const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'number', formats: ['decimal'], start });
  if (!created.ok) throw new Error('构造失败');
  return { table: created.table, numId: created.num_id };
}

describe('computeListLabels', () => {
  it('十进制按文档顺序递增', () => {
    const { table, numId } = numberList();
    const labels = computeListLabels(table, [para('p1', numId), para('p2', numId), para('p3', numId)]);
    expect(labels.labels.map((label) => label.text)).toEqual(['1.', '2.', '3.']);
  });

  it('非列表段落不推进计数器（正文不是自动内容）', () => {
    const { table, numId } = numberList();
    const blocks = [
      para('p1', numId),
      { ...para('mid', numId), numbering: null },
      para('p2', numId),
    ];
    const labels = computeListLabels(table, blocks);
    expect(labels.labels.map((label) => label.text)).toEqual(['1.', '2.']);
    expect(labels.labels.map((label) => label.paragraph_id)).toEqual(['p1', 'p2']);
  });

  it('多级：出现更深级时子级从 1 开始，回到上级后子级归零', () => {
    const { table, numId } = numberList();
    const blocks = [
      para('p1', numId, 0),
      para('p1a', numId, 1),
      para('p1b', numId, 1),
      para('p2', numId, 0),
      para('p2a', numId, 1),
    ];
    const labels = computeListLabels(table, blocks);
    expect(labels.labels.map((label) => label.text)).toEqual(['1.', '1.1.', '1.2.', '2.', '2.1.']);
  });

  it('起始值生效：首项从 start 开始', () => {
    const { table, numId } = numberList(7);
    const labels = computeListLabels(table, [para('p1', numId), para('p2', numId)]);
    expect(labels.labels.map((label) => label.text)).toEqual(['7.', '8.']);
  });
});

describe('删除中间项后编号续接正确（WF-042）', () => {
  it('删掉第 2 项后，剩下两项重新连续编号', () => {
    const { table, numId } = numberList();
    const before = [para('p1', numId), para('p2', numId), para('p3', numId)];
    expect(computeListLabels(table, before).labels.map((label) => label.text)).toEqual(['1.', '2.', '3.']);

    const after = [before[0] as ParagraphNode, before[2] as ParagraphNode]; // 删掉中间项
    const labels = computeListLabels(table, after);
    // 续接正确：连续 1. 2.（不是 1. 3. 的空缺，也不是 1. 1. 的错号）。
    expect(labels.labels.map((label) => label.text)).toEqual(['1.', '2.']);
    expect(labels.labels.map((label) => label.paragraph_id)).toEqual(['p1', 'p3']);
  });

  it('删掉首项后仍从 1 开始（不是从 2 开始）', () => {
    const { table, numId } = numberList();
    const items = [para('p1', numId), para('p2', numId), para('p3', numId)];
    const labels = computeListLabels(table, [items[1] as ParagraphNode, items[2] as ParagraphNode]);
    expect(labels.labels.map((label) => label.text)).toEqual(['1.', '2.']);
  });
});

describe('列表隔离（WF-041）', () => {
  function two(): { table: NumberingTable; a: string; b: string } {
    const first = numberList();
    const second = createList(first.table, { kind: 'number', formats: ['decimal'] });
    if (!second.ok) throw new Error('构造失败');
    return { table: second.table, a: first.numId, b: second.num_id };
  }

  it('两份列表各自独立计数', () => {
    const { table, a, b } = two();
    const labels = computeListLabels(table, [
      para('a1', a),
      para('b1', b),
      para('a2', a),
      para('b2', b),
    ]);
    const map = labelTextsByParagraph(labels);
    expect(map.get('a1')).toBe('1.');
    expect(map.get('a2')).toBe('2.');
    expect(map.get('b1')).toBe('1.');
    expect(map.get('b2')).toBe('2.');
  });

  it('重启 A 后：A 从新起始值开始，B 完全不动', () => {
    const { table, a, b } = two();
    const restarted = restartList(table, a, { overrides: [{ level: 0, start: 100 }] });
    if (!restarted.ok) throw new Error('重启失败');

    const labels = computeListLabels(restarted.table, [
      para('a1', a),
      para('a2', a),
      para('r1', restarted.num_id),
      para('b1', b),
      para('b2', b),
    ]);
    const map = labelTextsByParagraph(labels);
    expect(map.get('a1')).toBe('1.'); // 原列表未受重启影响
    expect(map.get('a2')).toBe('2.');
    expect(map.get('r1')).toBe('100.'); // 新实例从覆盖值开始
    expect(map.get('b1')).toBe('1.');
    expect(map.get('b2')).toBe('2.');
  });

  it('labelsForList 只返回指定列表的标签', () => {
    const { table, a, b } = two();
    const labels = computeListLabels(table, [para('a1', a), para('b1', b)]);
    expect(labelsForList(labels, a).map((label) => label.paragraph_id)).toEqual(['a1']);
    expect(labelsForList(labels, b).map((label) => label.paragraph_id)).toEqual(['b1']);
  });

  it('重启实例与其源实例共享抽象定义（改抽象会串扰，故 table.ts 克隆）', () => {
    const { table, a } = two();
    const restarted = restartList(table, a);
    if (!restarted.ok) throw new Error('重启失败');
    const source = table.instances.find((instance) => instance.num_id === a);
    const fresh = restarted.table.instances.find((instance) => instance.num_id === restarted.num_id);
    expect(fresh?.abstract_num_id).toBe(source?.abstract_num_id);
  });
});

describe('坏引用与单段渲染', () => {
  it('反面：numId 不存在 → 记进 failures，不产出假标签', () => {
    const result = computeListLabels(EMPTY_NUMBERING_TABLE, [para('p1', 'ghost')]);
    expect(result.labels).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe('unknown_instance');
  });

  it('paragraphListText 单段渲染用起始值兜底；非列表为 null', () => {
    const { table, numId } = numberList(3);
    expect(paragraphListText(table, para('p1', numId))).toBe('3.');
    expect(paragraphListText(table, para('p2', numId, 1))).toBe('3.1.');
    expect(
      paragraphListText(table, { ...para('p3', numId), numbering: null }),
    ).toBeNull();
  });
});

describe('导出器形状', () => {
  it('toNumberingPartShape 摊平抽象与实例，保留 OOXML 字段名且不含 XML', () => {
    const { table, numId } = numberList();
    const shape = toNumberingPartShape(table);
    expect(shape.abstractNums).toHaveLength(1);
    expect(shape.nums[0]?.numId).toBe(numId);
    expect(shape.abstractNums[0]?.levels[0]?.lvlText).toBe('%1.');
    expect(shape.abstractNums[0]?.levels[0]?.numFmt).toBe('decimal');
    // 缩进仍是模型单位（不做换算——换算是 units 包的职责）。
    expect(shape.abstractNums[0]?.levels[0]?.indent_left).toEqual({ unit: 'cm', value: 0.74 });
  });

  it('重启实例的 startOverride 出现在形状里', () => {
    const { table, numId } = numberList();
    const restarted = restartList(table, numId, { overrides: [{ level: 0, start: 42 }] });
    if (!restarted.ok) throw new Error('重启失败');
    const shape = toNumberingPartShape(restarted.table);
    const fresh = shape.nums.find((num) => num.numId === restarted.num_id);
    expect(fresh?.overrides[0]?.startOverride).toBe(42);
  });

  it('符号字体映射到四个字体槽位', () => {
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!created.ok) throw new Error('构造失败');
    const shape = toNumberingPartShape(created.table);
    expect(shape.abstractNums[0]?.levels[0]?.rFonts).toEqual({
      ascii: 'Symbol',
      hAnsi: 'Symbol',
      eastAsia: 'Symbol',
      cs: 'Symbol',
    });
  });
});
