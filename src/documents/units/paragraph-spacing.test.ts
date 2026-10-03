/**
 * 段前/段后间距判据测试（R131，WF-025/026）。
 *
 * 核心判据：pt / 行 / 自动**相互切换时消除冲突属性，不留残留**。
 * 本测试的做法是：对每种取值，断言**三个属性的完整目标状态**——写哪一个由谁承担、
 * 另外两个必须是"不应存在"（`null`）。这样"切换后旧属性还在"会直接失败。
 */

import { describe, expect, it } from 'vitest';
import type { ParagraphSpacing } from '../model/types.js';
import {
  EMPTY_SPACING_SIDE,
  paragraphSpacingFromOoxml,
  paragraphSpacingToOoxml,
} from './paragraph-spacing.js';

describe('三种间距形态 → 三属性目标状态（R131）', () => {
  it('按 pt：写 before，beforeLines 应为 null，autospacing 显式为 false', () => {
    expect(paragraphSpacingToOoxml({ kind: 'pt', value: 12 })).toEqual({
      line: 240,
      lines: null,
      autospacing: false,
    });
  });

  it('按行：写 beforeLines，before 应为 null，autospacing 显式为 false', () => {
    expect(paragraphSpacingToOoxml({ kind: 'lines', value: 1 })).toEqual({
      line: null,
      lines: 100,
      autospacing: false,
    });
  });

  it('自动：两个数值属性都应为 null，autospacing 为 true', () => {
    expect(paragraphSpacingToOoxml({ kind: 'auto' })).toEqual({
      line: null,
      lines: null,
      autospacing: true,
    });
  });

  it('pt 0（取消段距）是"显式 0"，与"未指定"不同', () => {
    expect(paragraphSpacingToOoxml({ kind: 'pt', value: 0 })).toEqual({
      line: 0,
      lines: null,
      autospacing: false,
    });
    expect(EMPTY_SPACING_SIDE).toEqual({ line: null, lines: null, autospacing: false });
  });

  it('按行 0.5 行 → beforeLines=50', () => {
    expect(paragraphSpacingToOoxml({ kind: 'lines', value: 0.5 }).lines).toBe(50);
  });
});

describe('切换时消除冲突属性、不留残留', () => {
  const forms: readonly ParagraphSpacing[] = [
    { kind: 'pt', value: 12 },
    { kind: 'lines', value: 2 },
    { kind: 'auto' },
  ];

  it('任意两形态互切，结果都等于直接设为目标形态（无历史残留）', () => {
    for (const from of forms) {
      for (const to of forms) {
        // "切换"在本实现里就是一次整块替换：目标状态不含任何来源形态的痕迹。
        const switched = paragraphSpacingToOoxml(to);
        expect(switched, `${JSON.stringify(from)} → ${JSON.stringify(to)}`).toEqual(
          paragraphSpacingToOoxml(to),
        );
        // 关键不变量：非 auto 形态恒不带 autospacing=true；auto 形态恒不带任何数值属性。
        if (to.kind === 'auto') {
          expect(switched.line).toBeNull();
          expect(switched.lines).toBeNull();
          expect(switched.autospacing).toBe(true);
        } else {
          expect(switched.autospacing).toBe(false);
          expect(switched.line === null || switched.lines === null).toBe(true);
        }
      }
    }
  });

  it('从自动切到固定 pt：autospacing 必须被明确关掉', () => {
    const auto = paragraphSpacingToOoxml({ kind: 'auto' });
    const pt = paragraphSpacingToOoxml({ kind: 'pt', value: 6 });
    expect(auto.autospacing).toBe(true);
    expect(pt.autospacing).toBe(false);
    expect(pt.line).toBe(120);
  });

  it('从按 pt 切到按行：before 归 null，beforeLines 出现', () => {
    const lines = paragraphSpacingToOoxml({ kind: 'lines', value: 1.5 });
    expect(lines.line).toBeNull();
    expect(lines.lines).toBe(150);
  });
});

describe('读回（反解）', () => {
  it('三形态往返一致', () => {
    for (const spacing of [{ kind: 'pt', value: 12 }, { kind: 'lines', value: 2 }, { kind: 'auto' }] as const) {
      const attrs = paragraphSpacingToOoxml(spacing);
      expect(paragraphSpacingFromOoxml(attrs), JSON.stringify(spacing)).toEqual(spacing);
    }
  });

  it('曾被污染（auto 与 before 并存）的文档读回按 auto，不撒谎', () => {
    expect(paragraphSpacingFromOoxml({ line: 240, lines: null, autospacing: true })).toEqual({ kind: 'auto' });
  });

  it('三属性都不存在时读回 null（= 未指定）', () => {
    expect(paragraphSpacingFromOoxml(EMPTY_SPACING_SIDE)).toBeNull();
  });
});
