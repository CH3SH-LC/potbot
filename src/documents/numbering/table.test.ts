/**
 * 编号表构造与修改测试（WF-039–042）。
 *
 * 核心判据：**列表隔离**——改符号 / 重启一处列表，另一处列表的字节与计数都不受影响。
 */

import { describe, expect, it } from 'vitest';
import {
  continueList,
  createList,
  effectiveLevelDefinition,
  effectiveStart,
  findAbstract,
  findInstance,
  instancesSharingAbstract,
  nextAbstractNumId,
  restartList,
  setLevelBulletSymbol,
  setLevelIndent,
  setLevelStart,
  standardLevels,
  updateLevelForInstance,
  validateNumberingTable,
} from './table.js';
import { chars, EMPTY_NUMBERING_TABLE, type NumberingTable } from './types.js';
import { computeListLabels } from './resolve.js';
import { applyNumbered } from './apply.js';
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

function list(table: NumberingTable, numId: string): readonly string[] {
  return computeListLabels(table, [para('a', numId), para('b', numId), para('c', numId)]).labels.map(
    (label) => label.text,
  );
}

describe('构造列表', () => {
  it('项目符号列表：9 级、格式全为 bullet、id 确定性取号', () => {
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.num_id).toBe('1');
    expect(created.abstract_num_id).toBe('abs1');
    const abstract = findAbstract(created.table, created.abstract_num_id);
    expect(abstract?.levels).toHaveLength(9);
    expect(abstract?.multi_level_type).toBe('multilevel');
    expect(abstract?.levels.every((level) => level.format === 'bullet')).toBe(true);
  });

  it('编号列表：十进制 / 字母 / 罗马数字逐级', () => {
    const created = createList(EMPTY_NUMBERING_TABLE, {
      kind: 'number',
      formats: ['decimal', 'lowerLetter', 'lowerRoman', 'upperLetter', 'upperRoman'],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(effectiveLevelDefinition(created.table, created.num_id, 0)?.format).toBe('decimal');
    expect(effectiveLevelDefinition(created.table, created.num_id, 1)?.format).toBe('lowerLetter');
    expect(effectiveLevelDefinition(created.table, created.num_id, 2)?.format).toBe('lowerRoman');
    expect(effectiveLevelDefinition(created.table, created.num_id, 3)?.format).toBe('upperLetter');
    expect(effectiveLevelDefinition(created.table, created.num_id, 4)?.format).toBe('upperRoman');
  });

  it('起始值写在级别定义上，并能被读到', () => {
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'number', start: 5 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(effectiveStart(created.table, created.num_id, 0)).toBe(5);
  });

  it('反面：重复 id 明确拒绝，不产生第二份同 id 定义', () => {
    const first = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!first.ok) throw new Error('前置构造失败');
    const dup = createList(first.table, { kind: 'bullet', num_id: '1' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe('duplicate_id');
  });

  it('反面：非法起始值拒绝', () => {
    const level0 = standardLevels('number')[0];
    if (level0 === undefined) throw new Error('缺少级别定义');
    const bad = createList(EMPTY_NUMBERING_TABLE, { levels: [{ ...level0, start: 0 }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid_definition');
  });
});

describe('列表隔离（WF-041/042）', () => {
  function twoLists(): { table: NumberingTable; a: string; b: string } {
    const first = createList(EMPTY_NUMBERING_TABLE, { kind: 'number', formats: ['decimal'] });
    if (!first.ok) throw new Error('构造失败');
    const second = createList(first.table, { kind: 'number', formats: ['decimal'] });
    if (!second.ok) throw new Error('构造失败');
    return { table: second.table, a: first.num_id, b: second.num_id };
  }

  it('两份新建列表各自从 1 开始，互不影响', () => {
    const { table, a, b } = twoLists();
    expect(list(table, a)).toEqual(['1.', '2.', '3.']);
    expect(list(table, b)).toEqual(['1.', '2.', '3.']);
    expect(instancesSharingAbstract(table, findInstance(table, a)?.abstract_num_id ?? '')).toHaveLength(1);
  });

  it('改 A 的符号不动 B（共享抽象被克隆）——正面 + 反面', () => {
    // 先让两份列表共享同一个抽象（模拟真实文档里"同一个列表定义被复用"）。
    const base = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!base.ok) throw new Error('构造失败');
    const instanceB: NumberingTable = {
      ...base.table,
      instances: [
        ...base.table.instances,
        { num_id: '2', abstract_num_id: base.abstract_num_id, overrides: [] },
      ],
    };
    expect(instancesSharingAbstract(instanceB, base.abstract_num_id)).toEqual(['1', '2']);

    const changed = setLevelBulletSymbol(instanceB, '1', 0, '★');
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    // 正面：A 变了。
    expect(effectiveLevelDefinition(changed.table, '1', 0)?.text_template).toBe('★');
    // 反面：B 一个字节没变。
    expect(effectiveLevelDefinition(changed.table, '2', 0)?.text_template).toBe('•');
    // 且抽象被克隆成两份（A 用克隆，B 留原主）。
    expect(instancesSharingAbstract(changed.table, base.abstract_num_id)).toEqual(['2']);
    expect(findInstance(changed.table, '1')?.abstract_num_id).not.toBe(base.abstract_num_id);
  });

  it('改缩进同样隔离（共享抽象克隆路径）', () => {
    const base = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!base.ok) throw new Error('构造失败');
    const two: NumberingTable = {
      ...base.table,
      instances: [
        ...base.table.instances,
        { num_id: '2', abstract_num_id: base.abstract_num_id, overrides: [] },
      ],
    };
    const changed = setLevelIndent(two, '1', 0, { left: chars(4) });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(effectiveLevelDefinition(changed.table, '1', 0)?.indent_left).toEqual(chars(4));
    expect(effectiveLevelDefinition(changed.table, '2', 0)?.indent_left).toEqual({ unit: 'cm', value: 0.74 });
  });

  it('重启 A 不影响 B 的编号（隔离判据的正反例）', () => {
    const { table, a, b } = twoLists();
    const beforeA = list(table, a);
    const beforeB = list(table, b);

    const restarted = restartList(table, a, { overrides: [{ level: 0, start: 10 }] });
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;

    // 正面：新实例从 10 开始。
    expect(list(restarted.table, restarted.num_id)).toEqual(['10.', '11.', '12.']);
    // 反面：B 完全不变；A 的原实例也不变（重启是"新开一个"，不是"重置原列表"）。
    expect(list(restarted.table, b)).toEqual(beforeB);
    expect(list(restarted.table, a)).toEqual(beforeA);
  });

  it('续编复用同一个 numId，计数器接着走', () => {
    const { table, a } = twoLists();
    const cont = continueList(table, a);
    expect(cont.ok).toBe(true);
    if (!cont.ok) return;
    expect(cont.num_id).toBe(a);
    expect(cont.table).toBe(table); // 不改表
  });

  it('反面：续编一个不存在的实例 → 明确拒绝', () => {
    const cont = continueList(EMPTY_NUMBERING_TABLE, 'nope');
    expect(cont.ok).toBe(false);
    if (!cont.ok) expect(cont.code).toBe('unknown_instance');
  });

  it('反面：重启一个不存在的实例 → 明确拒绝', () => {
    const restarted = restartList(EMPTY_NUMBERING_TABLE, 'nope');
    expect(restarted.ok).toBe(false);
    if (!restarted.ok) expect(restarted.code).toBe('unknown_instance');
  });
});

describe('级别写操作', () => {
  it('setLevelStart 落到抽象层（首次计数生效）', () => {
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'number' });
    if (!created.ok) throw new Error('构造失败');
    const changed = setLevelStart(created.table, created.num_id, 1, 3);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(effectiveStart(changed.table, created.num_id, 1)).toBe(3);
  });

  it('实例级 startOverride 优先于抽象的 start', () => {
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'number' });
    if (!created.ok) throw new Error('构造失败');
    const restarted = restartList(created.table, created.num_id, { overrides: [{ level: 0, start: 7 }] });
    if (!restarted.ok) throw new Error('重启失败');
    expect(effectiveStart(restarted.table, restarted.num_id, 0)).toBe(7);
    expect(effectiveStart(restarted.table, created.num_id, 0)).toBe(1);
  });

  it('updateLevelForInstance 对不存在的级明确拒绝', () => {
    const level0 = standardLevels('number')[0];
    if (level0 === undefined) throw new Error('缺少级别定义');
    const created = createList(EMPTY_NUMBERING_TABLE, { levels: [level0] });
    if (!created.ok) throw new Error('构造失败');
    const result = updateLevelForInstance(created.table, created.num_id, 5, (level) => level);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('level_not_defined');
  });

  it('反面：越界级别拒绝', () => {
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!created.ok) throw new Error('构造失败');
    const result = updateLevelForInstance(created.table, created.num_id, 9, (level) => level);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_level');
  });
});

describe('自检与取号', () => {
  it('validateNumberingTable 抓出坏抽象引用与重复 id', () => {
    const broken: NumberingTable = {
      abstract: [],
      instances: [
        { num_id: '1', abstract_num_id: 'ghost', overrides: [] },
        { num_id: '1', abstract_num_id: 'ghost', overrides: [] },
      ],
    };
    const problems = validateNumberingTable(broken);
    expect(problems.map((problem) => problem.code)).toContain('unknown_abstract');
    expect(problems.map((problem) => problem.code)).toContain('duplicate_id');
  });

  it('nextAbstractNumId 取未占用的最小号（确定性）', () => {
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!created.ok) throw new Error('构造失败');
    expect(nextAbstractNumId(created.table)).toBe('abs2');
  });
});

describe('与段落操作配合（端到端的最小闭环）', () => {
  it('新建列表 → 应用到段落 → 算得出序号', () => {
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'number', formats: ['decimal'] });
    if (!created.ok) throw new Error('构造失败');
    const applied = applyNumbered(
      { ...para('p1', created.num_id), numbering: null },
      created.table,
      { num_id: created.num_id, level: 0 },
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const labels = computeListLabels(created.table, [applied.paragraph]);
    expect(labels.labels.map((label) => label.text)).toEqual(['1.']);
  });
});
