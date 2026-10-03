/**
 * 段落层列表操作测试（WF-039–042）。
 *
 * 头号判据（WF-039）：**不伪造普通文本前缀**——应用项目符号后，
 * 段落文本里不得出现手写的 `•` 或 `1.`，必须是结构性的 `numPr` 引用。
 * 这条用**正反两面**钉：真列表项不含前缀（正面），手写前缀能被探针抓到（反面/对照）。
 */

import { describe, expect, it } from 'vitest';
import {
  applyBullet,
  applyList,
  applyListToRange,
  applyNumbered,
  continueListForParagraphs,
  demoteListLevel,
  isListItem,
  listReferenceOf,
  manualListPrefixOf,
  promoteListLevel,
  removeList,
  removeListFromRange,
  restartListForParagraphs,
  setListLevel,
  shiftListLevel,
} from './apply.js';
import { createList, standardLevels } from './table.js';
import { EMPTY_NUMBERING_TABLE, type NumberingTable } from './types.js';
import { computeListLabels } from './resolve.js';
import type { InlineNode, ParagraphNode, RunProperties } from '../model/types.js';
import { createDefaultParagraphProperties } from '../operations/paragraph/defaults.js';
import { defaultRunProperties } from '../model/nodes.js';

function run(id: string, text: string, properties?: RunProperties): InlineNode {
  return {
    kind: 'run',
    id,
    source: 'user_request',
    opaque: [],
    properties: properties ?? defaultRunProperties(),
    text,
  };
}

function para(id: string, text: string, numbering: ParagraphNode['numbering'] = null): ParagraphNode {
  return {
    kind: 'paragraph',
    id,
    source: 'user_request',
    opaque: [],
    properties: createDefaultParagraphProperties(),
    inlines: text === '' ? [] : [run(`${id}-r`, text)],
    style_ref: null,
    numbering,
  };
}

function textOf(paragraph: ParagraphNode): string {
  return paragraph.inlines
    .map((inline) => (inline.kind === 'run' ? inline.text : ''))
    .join('');
}

function bulletTable(): { table: NumberingTable; numId: string } {
  const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
  if (!created.ok) throw new Error('构造失败');
  return { table: created.table, numId: created.num_id };
}

function numberTable(): { table: NumberingTable; numId: string } {
  const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'number', formats: ['decimal'] });
  if (!created.ok) throw new Error('构造失败');
  return { table: created.table, numId: created.num_id };
}

describe('WF-039 不伪造前缀', () => {
  it('应用项目符号：正文逐字符不变，只多一个结构性引用', () => {
    const { table, numId } = bulletTable();
    const before = para('p1', '第一项');
    const result = applyBullet(before, table, { num_id: numId, level: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 正面：文本照旧。
    expect(textOf(result.paragraph)).toBe('第一项');
    // 反面：没有手写前缀。
    expect(manualListPrefixOf(result.paragraph)).toBeNull();
    // 结构性引用就位。
    expect(result.paragraph.numbering).toEqual({ num_id: numId, level: 0 });
  });

  it('应用编号列表：同样不往正文塞 "1."', () => {
    const { table, numId } = numberTable();
    const result = applyNumbered(para('p1', '条目'), table, { num_id: numId, level: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(textOf(result.paragraph)).toBe('条目');
    expect(textOf(result.paragraph)).not.toContain('1.');
    expect(manualListPrefixOf(result.paragraph)).toBeNull();
  });

  it('对照（反面）：手写前缀的脏数据能被探针抓到', () => {
    expect(manualListPrefixOf(para('d1', '• 手写符号'))).not.toBeNull();
    expect(manualListPrefixOf(para('d2', '1. 手写序号'))).not.toBeNull();
    expect(manualListPrefixOf(para('d3', '(a) 手写字母'))).not.toBeNull();
    expect(manualListPrefixOf(para('d4', '正文而已'))).toBeNull();
  });

  it('取消列表：断引用，正文无残留（因为从未伪造过）', () => {
    const { table, numId } = bulletTable();
    const applied = applyBullet(para('p1', '第一项'), table, { num_id: numId, level: 0 });
    if (!applied.ok) throw new Error('应用失败');
    const removed = removeList(applied.paragraph);
    expect(removed.numbering).toBeNull();
    expect(textOf(removed)).toBe('第一项');
    expect(isListItem(removed)).toBe(false);
  });

  it('应用列表不改正文之外的格式字段（style_ref / properties 原样）', () => {
    const { table, numId } = bulletTable();
    const base = { ...para('p1', 'x'), style_ref: 'Heading1' };
    const result = applyList(base, table, { num_id: numId, level: 0 });
    if (!result.ok) throw new Error('应用失败');
    expect(result.paragraph.style_ref).toBe('Heading1');
    expect(result.paragraph.properties).toBe(base.properties);
    expect(result.paragraph.inlines).toBe(base.inlines);
  });
});

describe('格式与操作匹配（WF-040）', () => {
  it('反面：拿项目符号列表当编号列表用 → 拒绝', () => {
    const { table, numId } = bulletTable();
    const result = applyNumbered(para('p1', 'x'), table, { num_id: numId, level: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_definition');
  });

  it('反面：拿编号列表当项目符号用 → 拒绝', () => {
    const { table, numId } = numberTable();
    const result = applyBullet(para('p1', 'x'), table, { num_id: numId, level: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_definition');
  });

  it('反面：numId 不存在 → 拒绝（不写进去等导出时才发现）', () => {
    const { table } = numberTable();
    const result = applyNumbered(para('p1', 'x'), table, { num_id: 'ghost', level: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_instance');
  });

  it('反面：级别越界 → 拒绝', () => {
    const { table, numId } = numberTable();
    const result = applyNumbered(para('p1', 'x'), table, { num_id: numId, level: 9 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_level');
  });
});

describe('升级 / 降级（WF-041）', () => {
  it('降级与升级改的是级别下标，引用不变', () => {
    const { table, numId } = numberTable();
    const item = para('p1', 'x', { num_id: numId, level: 0 });
    const demoted = demoteListLevel(item);
    expect(demoted.ok).toBe(true);
    if (!demoted.ok) return;
    expect(demoted.paragraph.numbering).toEqual({ num_id: numId, level: 1 });
    expect(demoted.changed).toBe(true);

    const promoted = promoteListLevel(demoted.paragraph);
    if (!promoted.ok) throw new Error('升级失败');
    expect(promoted.paragraph.numbering).toEqual({ num_id: numId, level: 0 });
  });

  it('已在最低级时降级不报错，但如实报告未动', () => {
    const { numId } = numberTable();
    const item = para('p1', 'x', { num_id: numId, level: 8 });
    const demoted = demoteListLevel(item);
    expect(demoted.ok).toBe(true);
    if (!demoted.ok) return;
    expect(demoted.changed).toBe(false);
    expect(demoted.at_limit).toBe(true);
    expect(demoted.paragraph.numbering).toEqual({ num_id: numId, level: 8 });
  });

  it('多级升降一次到位并夹紧到 0–8', () => {
    const { numId } = numberTable();
    const item = para('p1', 'x', { num_id: numId, level: 2 });
    const down = shiftListLevel(item, 5);
    if (!down.ok) throw new Error('降级失败');
    expect(down.level).toBe(7);
    const up = shiftListLevel(item, -10);
    if (!up.ok) throw new Error('升级失败');
    expect(up.level).toBe(0);
    expect(up.at_limit).toBe(true);
  });

  it('反面：不在列表里的段落不能升降级', () => {
    const result = demoteListLevel(para('p1', 'x'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unknown_instance');
  });

  it('setListLevel 越界拒绝；合法则生效', () => {
    const { numId } = numberTable();
    const item = para('p1', 'x', { num_id: numId, level: 0 });
    const bad = setListLevel(item, 9);
    expect(bad.ok).toBe(false);
    const good = setListLevel(item, 3);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.paragraph.numbering?.level).toBe(3);
  });
});

describe('范围操作（WF-042）', () => {
  it('批量套用：只改该改的，已是目标引用者不计入 changed', () => {
    const { table, numId } = numberTable();
    const items = [para('p1', 'a'), para('p2', 'b', { num_id: numId, level: 0 }), para('p3', 'c')];
    const result = applyListToRange(items, table, { num_id: numId, level: 0 });
    if (!result.ok) throw new Error('失败');
    expect(result.changed).toEqual(['p1', 'p3']);
    expect(result.paragraphs[1]).toBe(items[1]); // 已是目标 ⇒ 原对象引用不变
  });

  it('批量取消：正文与顺序不变', () => {
    const { table, numId } = bulletTable();
    const items = [para('p1', 'a', { num_id: numId, level: 0 }), para('p2', 'b')];
    const result = removeListFromRange(items);
    expect(result.changed).toEqual(['p1']);
    expect(result.paragraphs[1]).toBe(items[1]);
  });

  it('重启指定段落：不影响同列表的其他段落（隔离判据）', () => {
    const { table, numId } = numberTable();
    const items = [
      para('p1', 'a', { num_id: numId, level: 0 }),
      para('p2', 'b', { num_id: numId, level: 0 }),
      para('p3', 'c', { num_id: numId, level: 0 }),
      para('p4', 'd', { num_id: numId, level: 0 }),
    ];
    // 只把后两项重启成从 10 开始。
    const restarted = restartListForParagraphs(table, items, ['p3', 'p4'], numId, {
      overrides: [{ level: 0, start: 10 }],
    });
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;

    expect(restarted.changed).toEqual(['p3', 'p4']);
    // 前两项的对象引用与引用值都原样。
    expect(restarted.paragraphs[0]).toBe(items[0]);
    expect(restarted.paragraphs[1]).toBe(items[1]);

    const labels = computeListLabels(restarted.table, restarted.paragraphs);
    expect(labels.labels.map((label) => label.text)).toEqual(['1.', '2.', '10.', '11.']);
    // 原列表（前两项）计数未被重置。
    expect(labels.labels[0]?.text).toBe('1.');
    expect(labels.labels[1]?.text).toBe('2.');
  });

  it('续编指定段落：指回既有实例，计数接续', () => {
    const { table, numId } = numberTable();
    const items = [para('p1', 'a', { num_id: numId, level: 0 }), para('p2', 'b')];
    const continued = continueListForParagraphs(table, items, ['p2'], numId);
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.changed).toEqual(['p2']);
    const labels = computeListLabels(table, continued.paragraphs);
    expect(labels.labels.map((label) => label.text)).toEqual(['1.', '2.']);
  });

  it('反面：重启/续编一个不存在的列表 → 明确拒绝', () => {
    const restarted = restartListForParagraphs(EMPTY_NUMBERING_TABLE, [para('p1', 'a')], ['p1'], 'ghost');
    expect(restarted.ok).toBe(false);
    const continued = continueListForParagraphs(EMPTY_NUMBERING_TABLE, [para('p1', 'a')], ['p1'], 'ghost');
    expect(continued.ok).toBe(false);
  });
});

describe('引用读取', () => {
  it('listReferenceOf 读出引用；非列表为 null', () => {
    const { numId } = numberTable();
    expect(listReferenceOf(para('p1', 'a', { num_id: numId, level: 2 }))).toEqual({ num_id: numId, level: 2 });
    expect(listReferenceOf(para('p2', 'b'))).toBeNull();
  });

  it('standardLevels 的第 1 级模板是 %1.（多级编号的基础）', () => {
    const levels = standardLevels('number');
    expect(levels[0]?.text_template).toBe('%1.');
    expect(levels[2]?.text_template).toBe('%1.%2.%3.');
  });
});
