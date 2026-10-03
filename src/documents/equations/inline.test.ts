/**
 * 轻公式 → 行内 run 的桥（WF-091）。
 *
 * 这里同时钉住**能力**与**缺口**：
 * - 只含上下标的公式（`x^2` / `H_2O`）能落成带 `vertAlign` 的 run（正例，可读回）；
 * - 分式/根式/嵌套上下标**明确拒绝**并给原因（反例）——不静默降级成斜杠文本；
 * - 缺口本身作为断言写下来：`InlineNode` 里没有公式节点，这条桥只是过渡形态。
 */

import { describe, expect, it } from 'vitest';

import type { Result } from '../selection/types.js';
import { fraction, mathRun, sequence, subSuperscript, superscript } from './build.js';
import { equationToInlineRuns } from './inline.js';
import { parseMath } from './parse.js';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.code} / ${result.message}`);
  return result.value;
}

describe('轻公式桥接到行内 run', () => {
  it('x^2 落成两个 run，第二个带上标 vertAlign（属性可读回）', () => {
    const eq = unwrap(parseMath('x^{2}'));
    const runs = unwrap(equationToInlineRuns('eq-1', eq));

    expect(runs.map((run) => run.text)).toEqual(['x', '2']);
    expect(runs[1]!.properties.vertAlign).toEqual({ state: 'set', value: 'superscript' });
    // 底数不带垂直对齐（不臆造格式）
    expect(runs[0]!.properties.vertAlign.state).toBe('unspecified');
    // id 确定性
    expect(runs.map((run) => run.id)).toEqual(['eq-1#r0', 'eq-1#r1']);
    expect(runs.every((run) => run.source === 'model_generated')).toBe(true);
  });

  it('H_2O：下标落在中间的 run 上，两侧正文不受影响', () => {
    const eq = unwrap(parseMath('H_{2}O'));
    const runs = unwrap(equationToInlineRuns('eq-2', eq));

    expect(runs.map((run) => run.text)).toEqual(['H', '2', 'O']);
    expect(runs[0]!.properties.vertAlign.state).toBe('unspecified');
    expect(runs[1]!.properties.vertAlign).toEqual({ state: 'set', value: 'subscript' });
    expect(runs[2]!.properties.vertAlign.state).toBe('unspecified');
  });

  it('同一公式重复桥接得到同一串 id 与同一串属性（幂等，R137）', () => {
    const eq = subSuperscript(mathRun('a'), mathRun('1'), mathRun('2'));
    const first = unwrap(equationToInlineRuns('eq-3', eq));
    const second = unwrap(equationToInlineRuns('eq-3', eq));
    expect(second).toEqual(first);
  });

  it('反例：分式与根式被明确拒绝（run 层表达不了 m:f / m:rad）', () => {
    const frac = equationToInlineRuns('eq-4', fraction(mathRun('1'), mathRun('2')));
    expect(frac.ok).toBe(false);
    if (!frac.ok) {
      expect(frac.code).toBe('unsupported');
      expect(frac.message).toContain('m:f');
    }

    const sqrt = equationToInlineRuns('eq-5', unwrap(parseMath('\\sqrt{x}')));
    expect(sqrt.ok).toBe(false);
    if (!sqrt.ok) expect(sqrt.message).toContain('m:rad');
  });

  it('反例：嵌套上下标（一层 run 只有一档 vertAlign）被拒绝，而不是丢一层', () => {
    const nested = superscript(mathRun('x'), superscript(mathRun('2'), mathRun('3')));
    const result = equationToInlineRuns('eq-6', nested);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('嵌套上下标');
  });

  it('反例：非法结构先被校验挡下（空 run 不进入桥接）', () => {
    const result = equationToInlineRuns('eq-7', mathRun(''));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_query');
  });

  it('反例：空 equation_id 被拒（派生 id 需要稳定前缀）', () => {
    const result = equationToInlineRuns('', mathRun('x'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_query');
  });

  it('缺口声明：模型 InlineNode 四分支里没有公式节点，故本桥只覆盖 run 能表达的形态', () => {
    const kinds = ['run', 'break', 'field', 'drawing'];
    expect(kinds).not.toContain('equation');
    // 序列里混入分式 ⇒ 整体拒绝（不做"部分桥接"——半条公式比没有更糟）
    const mixed = equationToInlineRuns('eq-8', sequence([mathRun('x'), fraction(mathRun('1'), mathRun('2'))]));
    expect(mixed.ok).toBe(false);
  });
});
