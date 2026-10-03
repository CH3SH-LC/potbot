/**
 * 符号与特殊字符单测（WF-093）。
 *
 * 核心判据：**插入后实际字符可读回，不被规范化成普通空格**。
 * 因此关键用例对 NBSP 同时断言两件事：读回里**有** U+00A0，且普通空格 U+0020
 * 的数量**没有变化**——只断言"有 NBSP"不够。
 *
 * 本文件里**不出现**任何不可见字符的字面量：NBSP / ZWJ 全部用 `String.fromCodePoint` 拼出，
 * 避免"编辑器或存盘是否动过那个字符"变成测试里说不清的一环。
 * 把不可见字符写进源码，等于让"编辑器/存盘/复制有没有动过它"成为测试里说不清的一环。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel } from '../model/types.js';
import { paragraphText } from '../selection/structure.js';
import { breakNode, document, paragraph, paragraphOfRuns, run } from '../selection/testing.js';
import type { Result, Selection } from '../selection/types.js';
import {
  NO_BREAK_SPACE,
  SPECIAL_SYMBOLS,
  countCodePoint,
  formatCodePoint,
  insertSymbol,
  insertSymbolByName,
  isNoBreakSpace,
  readCodePoints,
  symbolByCodePoint,
  symbolByName,
  symbolsByCategory,
} from './symbols.js';

const NBSP = String.fromCodePoint(0x00a0); // U+00A0 不间断空格
const SPACE = String.fromCodePoint(0x0020); // U+0020 普通空格
/** 人 + ZWJ + 人 + ZWJ + 人：5 个码位、8 个 UTF-16 码元。 */
const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467); // 人+ZWJ+人+ZWJ+人

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.code} / ${result.message}`);
  return result.value;
}

function select(nodeId: string, start: number, end: number, baseRevision = 1): Selection {
  return { document_id: 'doc-1', base_revision: baseRevision, ranges: [{ node_id: nodeId, start, end }] };
}

function textOf(model: DocumentModel, nodeId: string): string {
  for (const block of model.blocks) {
    if (block.kind === 'paragraph' && block.id === nodeId) return paragraphText(block);
  }
  throw new Error(`找不到段落 ${nodeId}`);
}

describe('符号表自身的一致性', () => {
  it('每个符号的 char 与 code_point 严格对应，且码位/名字不重复', () => {
    for (const spec of SPECIAL_SYMBOLS) {
      expect(spec.char, spec.name).toBe(String.fromCodePoint(spec.code_point));
      expect(readCodePoints(spec.char)).toEqual([spec.code_point]);
    }
    const codePoints = SPECIAL_SYMBOLS.map((spec) => spec.code_point);
    expect(new Set(codePoints).size).toBe(codePoints.length);
    const names = SPECIAL_SYMBOLS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('NBSP 在表里且被识别为不换行空格；普通空格不是', () => {
    const nbsp = symbolByName('不间断空格')!;
    expect(nbsp.code_point).toBe(NO_BREAK_SPACE);
    expect(nbsp.char).toBe(NBSP);
    expect(isNoBreakSpace(nbsp.code_point)).toBe(true);
    expect(isNoBreakSpace(0x0020)).toBe(false);
    expect(formatCodePoint(nbsp.code_point)).toBe('U+00A0');
  });

  it('按类别检索：空白类含 NBSP / 窄 NBSP / 全角空格 / 零宽空格；数学类成组', () => {
    const spaces = symbolsByCategory('space').map((spec) => spec.name);
    expect(spaces).toContain('不间断空格');
    expect(spaces).toContain('窄不换行空格');
    expect(spaces).toContain('全角空格');
    expect(symbolsByCategory('math').length).toBeGreaterThanOrEqual(8);
  });

  it('表外码位查不到（不猜）', () => {
    expect(symbolByCodePoint(0x1f600)).toBeNull();
    expect(symbolByName('并不存在的符号')).toBeNull();
  });

  it('码位读取按 Unicode 码点算：ZWJ 家庭 emoji 是 5 个码位、8 个 UTF-16 码元', () => {
    expect(readCodePoints(FAMILY)).toEqual([0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467]);
    expect(FAMILY.length).toBe(8);
    expect(FAMILY).not.toBe(NBSP);
  });
});

describe('插入符号：实际字符可读回、不被规范化', () => {
  it('插入 NBSP 后读回来还是 U+00A0，且普通空格数量不变', () => {
    const model = document([paragraphOfRuns('p1', [['r1', `A${SPACE}B`]])]);
    expect(countCodePoint(`A${SPACE}B`, 0x0020)).toBe(1);

    const result = unwrap(insertSymbol(model, select('p1', 1, 1), NO_BREAK_SPACE));

    expect(result.char).toBe(NBSP);
    expect(result.code_point).toBe(0x00a0);
    expect(result.positions).toEqual([{ node_id: 'p1', start: 1, end: 2 }]);
    expect(result.model.revision).toBe(2);

    const text = textOf(result.model, 'p1');
    expect(readCodePoints(text)).toEqual([0x41, 0x00a0, 0x20, 0x42]);
    expect(countCodePoint(text, 0x00a0)).toBe(1);
    // 关键：普通空格数量**没有变化**（既没把 NBSP 归一化成空格，也没顺手补一个）
    expect(countCodePoint(text, 0x0020)).toBe(1);
    expect(text).not.toBe(`A${SPACE}${SPACE}B`);
  });

  it('选中一段文本插入符号时是替换；未选中的部分逐字保留', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'AB']])]);
    const result = unwrap(insertSymbolByName(model, select('p1', 0, 1), '版权'));
    expect(textOf(result.model, 'p1')).toBe('©B');
  });

  it('空范围即插入，不删除任何字符', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'AB']])]);
    const result = unwrap(insertSymbolByName(model, select('p1', 2, 2), '省略号'));
    expect(textOf(result.model, 'p1')).toBe('AB…');
  });

  it('连续两次插入互不干扰（第二次基于第一次的结果）', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'AB']])]);
    const first = unwrap(insertSymbol(model, select('p1', 0, 0), 0x00a9));
    const second = unwrap(
      insertSymbol(first.model, { ...select('p1', 3, 3), base_revision: first.model.revision }, 0x2026),
    );
    expect(textOf(second.model, 'p1')).toBe('©AB…');
    expect(second.model.revision).toBe(3);
  });
});

describe('插入符号：拒绝路径', () => {
  it('表外码位 ⇒ unsupported（不给"随便插一个"的兜底）', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'A']])]);
    const result = insertSymbol(model, select('p1', 1, 1), 0x1f600);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsupported');
      expect(result.detail.extra?.['codePoint']).toBe('U+1F600');
    }
  });

  it('非法码位（代理区 / 负数 / 小数 / 越界）⇒ invalid_query', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'A']])]);
    for (const bad of [0xd800, -1, 1.5, 0x110000]) {
      const result = insertSymbol(model, select('p1', 1, 1), bad);
      expect(result.ok, `应被拒绝：${String(bad)}`).toBe(false);
      if (!result.ok) expect(result.code).toBe('invalid_query');
    }
  });

  it('选区 revision 过期 ⇒ stale_revision（不把旧偏移套到新文本）', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'A']])], { revision: 5 });
    const result = insertSymbol(model, select('p1', 1, 1, 4), 0x00a9);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_revision');
      expect(result.detail.currentRevision).toBe(5);
      expect(result.detail.requestedRevision).toBe(4);
    }
  });

  it('选区为空 / 范围越界 / 文档不符，分别被拒', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'A']])]);

    const empty = insertSymbol(model, { document_id: 'doc-1', base_revision: 1, ranges: [] }, 0x00a9);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('empty_range');

    const outOfRange = insertSymbol(model, select('p1', 0, 5), 0x00a9);
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.code).toBe('invalid_range');

    const otherDoc = insertSymbol(model, { ...select('p1', 0, 0), document_id: 'doc-2' }, 0x00a9);
    expect(otherDoc.ok).toBe(false);
    if (!otherDoc.ok) expect(otherDoc.code).toBe('mismatched_document');
  });

  it('范围内含软换行 ⇒ unsupported（插入不得破坏结构）', () => {
    const model = document([paragraph('p1', [run('r1', 'teh'), breakNode('b1')])]);
    const result = insertSymbol(model, select('p1', 0, 4), 0x00a9);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unsupported');
  });

  it('按名字插入查不到 ⇒ not_found', () => {
    const model = document([paragraphOfRuns('p1', [['r1', 'A']])]);
    const result = insertSymbolByName(model, select('p1', 0, 0), '不存在的符号名');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });
});
