/**
 * 行距操作测试（WF-022–024）。
 *
 * 操作层**不做换算**：这里只验证整块替换与不可变性；数值换算的判据在
 * `src/documents/units/line-spacing.test.ts`。
 */

import { describe, expect, it } from 'vitest';
import { createDefaultParagraphProperties } from './defaults.js';
import { setLineSpacing, unsetLineSpacing } from './line-spacing.js';
import { lineSpacingToOoxml } from '../../units/line-spacing.js';
import type { LineSpacing } from '../../model/types.js';

describe('六类行距的设置（WF-022–024）', () => {
  const cases: readonly LineSpacing[] = [
    { kind: 'single' },
    { kind: 'oneAndHalf' },
    { kind: 'double' },
    { kind: 'multiple', value: 1.25 },
    { kind: 'exact', value: { unit: 'pt', value: 20 } },
    { kind: 'atLeast', value: { unit: 'pt', value: 18 } },
  ];

  it('六类都能原样存入且可读回', () => {
    for (const spacing of cases) {
      const props = setLineSpacing(createDefaultParagraphProperties(), spacing);
      expect(props.lineSpacing).toEqual({ state: 'set', value: spacing });
    }
  });

  it('六类写入后经 units 换算得到预期属性（判据值与 units 层一致）', () => {
    const expected = [
      { line: 240, lineRule: 'auto' },
      { line: 360, lineRule: 'auto' },
      { line: 480, lineRule: 'auto' },
      { line: 300, lineRule: 'auto' },
      { line: 400, lineRule: 'exact' },
      { line: 360, lineRule: 'atLeast' },
    ];
    cases.forEach((spacing, index) => {
      const props = setLineSpacing(createDefaultParagraphProperties(), spacing);
      if (props.lineSpacing.state !== 'set') throw new Error('应为 set');
      expect(lineSpacingToOoxml(props.lineSpacing.value)).toEqual(expected[index]);
    });
  });

  it('整块替换：从 1.5 倍改成固定 20pt 不残留倍数痕迹', () => {
    let props = setLineSpacing(createDefaultParagraphProperties(), { kind: 'oneAndHalf' });
    props = setLineSpacing(props, { kind: 'exact', value: { unit: 'pt', value: 20 } });
    if (props.lineSpacing.state !== 'set') throw new Error('应为 set');
    expect(props.lineSpacing.value).toEqual({ kind: 'exact', value: { unit: 'pt', value: 20 } });
    expect(lineSpacingToOoxml(props.lineSpacing.value)).toEqual({ line: 400, lineRule: 'exact' });
  });

  it('不改原对象（不可变）', () => {
    const base = createDefaultParagraphProperties();
    const props = setLineSpacing(base, { kind: 'double' });
    expect(base.lineSpacing).toEqual({ state: 'unspecified' });
    expect(props).not.toBe(base);
  });

  it('不触碰对齐与其他段落属性', () => {
    const base = createDefaultParagraphProperties();
    const props = setLineSpacing(base, { kind: 'single' });
    expect(props.alignment).toBe(base.alignment);
    expect(props.spacingBefore).toBe(base.spacingBefore);
    expect(props.indent).toBe(base.indent);
  });

  it('unsetLineSpacing 落 inherit（清除覆盖，不是"单倍"）', () => {
    const props = unsetLineSpacing(setLineSpacing(createDefaultParagraphProperties(), { kind: 'double' }));
    expect(props.lineSpacing).toEqual({ state: 'inherit' });
    expect(props.lineSpacing).not.toEqual({ state: 'set', value: { kind: 'single' } });
  });
});
