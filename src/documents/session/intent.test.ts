/**
 * 结构化意图编译器单测（R133/R134/R135/R140、R127–R131）。
 *
 * 三条要证明的事：
 * 1. **零模型可执行**：直接格式命令（"把第二段居中"）不需要任何模型参与；
 * 2. **拒绝在操作之前**：不支持的能力 / 非法值 / 禁止写入的状态一律 `unsupported`
 *    或 `invalid_expression`，**永不**产出半截计划；
 * 3. **单位分开**：`2 字` 与 `2 cm` 编译成两个形状不同的量（R130），且本层**不换算**（R128）。
 */

import { describe, expect, it } from 'vitest';

import { compileEditIntent } from './intent.js';

function compile(intent: unknown): { ok: true; value: unknown } | { ok: false; code: string; message: string } {
  return compileEditIntent(intent) as never;
}

describe('意图 → 计划：直接格式命令零模型（R134）', () => {
  it('"把第二段居中"编译成一条段落域计划，不经过任何模型', () => {
    const result = compileEditIntent({
      steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.steps).toHaveLength(1);
      expect(result.value.steps[0]?.range).toBe('第2段');
      expect(result.value.steps[0]?.operation).toEqual({
        domain: 'paragraph',
        operation: { kind: 'setAlignment', alignment: 'center' },
      });
    }
  });

  it('五种对齐全部可编译（WF-017）', () => {
    for (const alignment of ['left', 'center', 'right', 'justify', 'distribute']) {
      const result = compileEditIntent({
        steps: [{ range: '全文', operation: { kind: 'setAlignment', alignment } }],
      });
      expect(result.ok, `对齐 ${alignment} 应可编译`).toBe(true);
    }
  });

  it('字符开关（加粗）编译成字符域计划', () => {
    const result = compileEditIntent({
      steps: [
        { range: '指定文本:提示', operation: { kind: 'setToggle', property: 'bold', value: true } },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.steps[0]?.operation).toEqual({
        domain: 'character',
        operation: { kind: 'setToggle', property: 'bold', value: true },
      });
    }
  });

  it('复合意图（多步）按声明顺序编译', () => {
    const result = compileEditIntent({
      steps: [
        { range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } },
        { range: '第2段', operation: { kind: 'setLineSpacing', lineSpacing: { mode: 'oneAndHalf' } } },
        { range: '第1段', operation: { kind: 'setToggle', property: 'bold', value: true } },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.steps.map((step) => step.range)).toEqual(['第2段', '第2段', '第1段']);
    }
  });

  it('同一意图编译两次 ⇒ 同一计划（R133 的可复算性）', () => {
    const intent = {
      steps: [
        { range: '第1段', operation: { kind: 'setSpacingAfter', spacing: { mode: 'pt', value: 6 } } },
      ],
    };
    const first = compileEditIntent(intent);
    const second = compileEditIntent(intent);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
    }
  });
});

describe('单位分开表达（R127/R128/R130）', () => {
  it('"首行缩进 2 字" 与 "2 cm" 编译成两个形状不同的量', () => {
    const chars = compileEditIntent({
      steps: [
        { range: '全文', operation: { kind: 'setFirstLineIndent', indent: { mode: 'chars', value: 2 } } },
      ],
    });
    const centimetres = compileEditIntent({
      steps: [
        {
          range: '全文',
          operation: {
            kind: 'setFirstLineIndent',
            indent: { mode: 'length', unit: 'cm', value: 2 },
          },
        },
      ],
    });
    expect(chars.ok && centimetres.ok).toBe(true);
    if (chars.ok && centimetres.ok) {
      expect(chars.value.steps[0]?.operation).toEqual({
        domain: 'paragraph',
        operation: { kind: 'setFirstLineIndent', amount: { unit: 'chars', value: 2 } },
      });
      expect(centimetres.value.steps[0]?.operation).toEqual({
        domain: 'paragraph',
        operation: { kind: 'setFirstLineIndent', amount: { unit: 'cm', value: 2 } },
      });
    }
  });

  it('长度量**原样搬运**，本层不做任何换算（R128 换算集中在 units 层）', () => {
    const result = compileEditIntent({
      steps: [
        {
          range: '全文',
          operation: {
            kind: 'setLeftIndent',
            indent: { mode: 'length', unit: 'twips', value: 567 },
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.steps[0]?.operation).toEqual({
        domain: 'paragraph',
        operation: { kind: 'setLeftIndent', amount: { unit: 'twips', value: 567 } },
      });
    }
  });

  it('行距六类分别编译（单倍 / 1.5 / 双倍 / 多倍 / 固定 / 最小）', () => {
    const cases: readonly [unknown, unknown][] = [
      [{ mode: 'single' }, { kind: 'single' }],
      [{ mode: 'oneAndHalf' }, { kind: 'oneAndHalf' }],
      [{ mode: 'double' }, { kind: 'double' }],
      [{ mode: 'multiple', value: 1.25 }, { kind: 'multiple', value: 1.25 }],
      [
        { mode: 'exact', unit: 'pt', value: 20 },
        { kind: 'exact', value: { unit: 'pt', value: 20 } },
      ],
      [
        { mode: 'atLeast', unit: 'pt', value: 18 },
        { kind: 'atLeast', value: { unit: 'pt', value: 18 } },
      ],
    ];
    for (const [intentValue, expected] of cases) {
      const result = compileEditIntent({
        steps: [{ range: '全文', operation: { kind: 'setLineSpacing', lineSpacing: intentValue } }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.steps[0]?.operation).toEqual({
          domain: 'paragraph',
          operation: { kind: 'setLineSpacing', spacing: expected },
        });
      }
    }
  });

  it('段间距三态互斥（pt / 行 / 自动）', () => {
    const result = compileEditIntent({
      steps: [
        { range: '全文', operation: { kind: 'setSpacingBefore', spacing: { mode: 'auto' } } },
        { range: '全文', operation: { kind: 'setSpacingAfter', spacing: { mode: 'lines', value: 1 } } },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.steps[0]?.operation).toEqual({
        domain: 'paragraph',
        operation: { kind: 'setSpacingBefore', spacing: { kind: 'auto' } },
      });
      expect(result.value.steps[1]?.operation).toEqual({
        domain: 'paragraph',
        operation: { kind: 'setSpacingAfter', spacing: { kind: 'lines', value: 1 } },
      });
    }
  });
});

describe('拒绝在操作之前（R140/R154）', () => {
  it('未知操作种类 ⇒ unsupported，且不产出任何步骤', () => {
    const result = compileEditIntent({
      steps: [
        { range: '第1段', operation: { kind: 'setAlignment', alignment: 'center' } },
        { range: '第2段', operation: { kind: 'insertChart', chart: 'pie' } },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unsupported');
      expect(result.message).toContain('insertChart');
    }
  });

  it('非法对齐值 ⇒ unsupported（不是"悄悄降级成左对齐"）', () => {
    const result = compileEditIntent({
      steps: [{ range: '全文', operation: { kind: 'setAlignment', alignment: 'diagonal' } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unsupported');
  });

  it('非开关型属性用 toggle ⇒ unsupported；开关型属性用 unsetValue ⇒ unsupported', () => {
    const toggleOnValued = compileEditIntent({
      steps: [{ range: '全文', operation: { kind: 'toggle', property: 'size' } }],
    });
    expect(toggleOnValued.ok).toBe(false);
    if (!toggleOnValued.ok) expect(toggleOnValued.code).toBe('unsupported');

    const unsetOnToggle = compileEditIntent({
      steps: [{ range: '全文', operation: { kind: 'unsetValue', property: 'bold' } }],
    });
    expect(unsetOnToggle.ok).toBe(false);
    if (!unsetOnToggle.ok) expect(unsetOnToggle.code).toBe('unsupported');
  });

  it('模糊的"字号写成一个裸数字"被拒（R131：没有"一个数字到处复用"）', () => {
    const result = compileEditIntent({
      steps: [{ range: '全文', operation: { kind: 'setFirstLineIndent', indent: 2 } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_expression');
  });

  it('空步骤数组 ⇒ empty_range（空计划不是一次事务）', () => {
    const result = compileEditIntent({ steps: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('empty_range');
  });

  it('形状不对（非对象 / steps 不是数组 / 缺 range）逐项被拒', () => {
    for (const bad of [null, 42, 'x', {}, { steps: 'nope' }, { steps: [{}] }, { steps: [{ range: '' }] }]) {
      const result = compileEditIntent(bad);
      expect(result.ok).toBe(false);
    }
  });

  it('mismatched_document 之类的"禁止写入态"不会从这里流出去：clearParagraphFormat 可编译', () => {
    const result = compileEditIntent({
      steps: [{ range: '全文', operation: { kind: 'clearParagraphFormat' } }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.steps[0]?.operation).toEqual({
        domain: 'paragraph',
        operation: { kind: 'clearParagraphFormat' },
      });
    }
  });
});
