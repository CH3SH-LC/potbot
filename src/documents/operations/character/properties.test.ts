/**
 * run 属性编辑引擎单测（WF-001–016；R117–R121）。
 *
 * **判据的核心对照在这里**：
 * - 取消加粗 ⇒ 显式 `off`（会被导出成 `w:b w:val="false"`，**不是**删元素）；
 * - 未指定 ⇒ `unspecified`（不写元素）；
 * - 清除直接格式 ⇒ `inherit`（删元素、回落样式）——与上面两者都是**不同**的状态。
 */

import { describe, expect, it } from 'vitest';

import { TOGGLE_UNSPECIFIED } from '../../model/types.js';
import { deepEqual } from '../../selection/equals.js';
import { boldOff, boldOn, runProperties, unspecifiedRunProperties } from '../../selection/testing.js';
import {
  CANONICAL_UNSET,
  CLEARED_RUN_PROPERTIES,
  applyCharacterOperation,
  hasNoDirectFormat,
  isDirectFormatCleared,
} from './properties.js';
import {
  CLEAR_DIRECT_FORMAT,
  adjustFontSize,
  formatBrush,
  inherit,
  setToggle,
  setValue,
  toggleProperty,
  unsetValue,
} from './types.js';

/**
 * 测试内局部判据：把模型态映射成"导出层会写出的东西"。
 * 规则**直接来自 R118**（`on` ⇒ 写元素；`off` ⇒ 写 `w:val="false"`；
 * `unspecified` / `inherit` ⇒ 不写元素），放在测试里是为了让"不写元素"这件事
 * 有一个可断言的具体形状，而不是只比字符串。
 */
function boldElementFor(state: string): string {
  if (state === 'on') return '<w:b/>';
  if (state === 'off') return '<w:b w:val="false"/>';
  return '';
}

function applyOrThrow(
  props: ReturnType<typeof unspecifiedRunProperties>,
  operation: Parameters<typeof applyCharacterOperation>[1],
  context?: Parameters<typeof applyCharacterOperation>[2],
) {
  const applied = applyCharacterOperation(props, operation, context);
  expect(applied.ok).toBe(true);
  if (!applied.ok) throw new Error(applied.message);
  return applied.value;
}

describe('取消加粗 vs 未指定 vs 清除覆盖 —— 三种状态必须能分别产出（R118）', () => {
  it('未指定 ⇒ 不写元素', () => {
    const props = unspecifiedRunProperties();
    expect(props.bold).toBe(TOGGLE_UNSPECIFIED);
    expect(props.bold.state).toBe('unspecified');
    expect(boldElementFor(props.bold.state)).toBe('');
  });

  it('取消加粗 ⇒ 显式 off（写 w:val="false"），不是删元素', () => {
    // "已继承加粗的片段"在模型里就是 bold = unspecified（它自己没有覆盖，随样式走）
    const inherited = unspecifiedRunProperties();
    const cancelled = applyOrThrow(inherited, setToggle('bold', false));

    expect(cancelled.bold.state).toBe('off');
    expect(boldElementFor(cancelled.bold.state)).toBe('<w:b w:val="false"/>');
    // 关键对照：**不是** unspecified（不写元素），**也不是** inherit（删元素）
    expect(cancelled.bold.state).not.toBe('unspecified');
    expect(cancelled.bold.state).not.toBe('inherit');
  });

  it('清除覆盖 ⇒ inherit（删元素回落样式），与 off 不同、与 unspecified 也不同', () => {
    const bold = boldOn();
    const cleared = applyOrThrow(bold, inherit('bold'));
    expect(cleared.bold.state).toBe('inherit');
    expect(boldElementFor(cleared.bold.state)).toBe(''); // 不写元素
    expect(cleared.bold.state).not.toBe('off');
    expect(cleared.bold.state).not.toBe('unspecified');
  });

  it('加粗 ⇒ on 写元素；off 覆盖得住继承来的加粗', () => {
    expect(boldElementFor(applyOrThrow(unspecifiedRunProperties(), setToggle('bold', true)).bold.state)).toBe('<w:b/>');
    expect(applyOrThrow(boldOn(), setToggle('bold', false)).bold.state).toBe('off');
    expect(boldOff().bold.state).toBe('off');
  });
});

describe('toggle 语义（R121 钉死：全部已开 ⇒ 关；否则 ⇒ 开）', () => {
  const allOn = [boldOn(), boldOn()];

  it('选区全部已开 ⇒ off', () => {
    const result = applyOrThrow(boldOn(), toggleProperty('bold'), { selectedProperties: allOn });
    expect(result.bold.state).toBe('off');
  });

  it('选区混合（开 + 未指定）⇒ on', () => {
    const result = applyOrThrow(unspecifiedRunProperties(), toggleProperty('bold'), {
      selectedProperties: [boldOn(), unspecifiedRunProperties()],
    });
    expect(result.bold.state).toBe('on');
  });

  it('选区全部关闭 ⇒ on', () => {
    const result = applyOrThrow(boldOff(), toggleProperty('bold'), { selectedProperties: [boldOff()] });
    expect(result.bold.state).toBe('on');
  });

  it('缺少选区内属性上下文 ⇒ 前置条件失败（不猜目标态）', () => {
    const applied = applyCharacterOperation(boldOn(), toggleProperty('bold'));
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('precondition');
  });
});

describe('带值属性：set / unset（取规范取消值，R117）', () => {
  it('set 写带值状态', () => {
    expect(applyOrThrow(unspecifiedRunProperties(), setValue('underline', 'double')).underline).toEqual({
      state: 'set',
      value: 'double',
    });
    expect(applyOrThrow(unspecifiedRunProperties(), setValue('size', { kind: 'pt', value: 12 })).size).toEqual({
      state: 'set',
      value: { kind: 'pt', value: 12 },
    });
  });

  it('unset 取规范取消值：下划线 → none、颜色 → auto、缩放 → 100、位置 → 0pt', () => {
    expect(applyOrThrow(unspecifiedRunProperties(), unsetValue('underline')).underline).toEqual({
      state: 'set',
      value: 'none',
    });
    expect(applyOrThrow(unspecifiedRunProperties(), unsetValue('color')).color).toEqual({
      state: 'set',
      value: { kind: 'auto' },
    });
    expect(applyOrThrow(unspecifiedRunProperties(), unsetValue('scale')).scale).toEqual({ state: 'set', value: 100 });
    expect(applyOrThrow(unspecifiedRunProperties(), unsetValue('position')).position).toEqual({
      state: 'set',
      value: { unit: 'pt', value: 0 },
    });
    expect(applyOrThrow(unspecifiedRunProperties(), unsetValue('vertAlign')).vertAlign).toEqual({
      state: 'set',
      value: 'baseline',
    });
  });

  it('没有规范取消值的属性 ⇒ 回落 inherit（删元素）', () => {
    for (const key of ['size', 'fonts', 'shading', 'spacing'] as const) {
      expect(CANONICAL_UNSET[key]).toBeNull();
      expect(applyOrThrow(unspecifiedRunProperties(), unsetValue(key))[key]).toEqual({ state: 'inherit' });
    }
  });

  it('取消下划线产出 none（写元素）——与 inherit（删元素）不同', () => {
    const none = applyOrThrow(unspecifiedRunProperties(), unsetValue('underline'));
    const cleared = applyOrThrow(unspecifiedRunProperties(), inherit('underline'));
    expect(none.underline).toEqual({ state: 'set', value: 'none' });
    expect(cleared.underline).toEqual({ state: 'inherit' });
    expect(deepEqual(none.underline, cleared.underline)).toBe(false);
  });
});

describe('清除字符直接格式（WF-015 / R120）', () => {
  it('每个字段都变成 inherit，且不改动任何非字符字段（这里只经手 rPr）', () => {
    const busy = runProperties({
      bold: { state: 'on' },
      italic: { state: 'on' },
      underline: { state: 'set', value: 'double' },
      size: { state: 'set', value: { kind: 'pt', value: 16 } },
      highlight: { state: 'set', value: 'yellow' },
    });
    const cleared = applyOrThrow(busy, CLEAR_DIRECT_FORMAT);

    expect(deepEqual(cleared, CLEARED_RUN_PROPERTIES)).toBe(true);
    expect(isDirectFormatCleared(cleared)).toBe(true);
    expect(hasNoDirectFormat(cleared)).toBe(true);
    for (const key of Object.keys(cleared) as (keyof typeof cleared)[]) {
      expect(cleared[key].state).toBe('inherit');
    }
  });

  it('未指定与 inherit 都属于"没有直接格式"', () => {
    expect(hasNoDirectFormat(unspecifiedRunProperties())).toBe(true);
    expect(isDirectFormatCleared(unspecifiedRunProperties())).toBe(false);
  });
});

describe('格式刷（WF-016）', () => {
  it('把来源 run 的直接格式整份复制到目标', () => {
    const source = runProperties({
      bold: { state: 'on' },
      size: { state: 'set', value: { kind: 'chinese', name: '小四' } },
      color: { state: 'set', value: { kind: 'rgb', hex: 'ff0000' } },
    });
    const target = unspecifiedRunProperties();
    const brushed = applyOrThrow(target, formatBrush(source));
    expect(deepEqual(brushed, source)).toBe(true);
  });

  it('来源的 unspecified 字段也会覆盖目标（是"复制整份直接格式"，不是"合并"）', () => {
    const source = boldOn();
    const target = runProperties({ italic: { state: 'on' } });
    const brushed = applyOrThrow(target, formatBrush(source));
    expect(brushed.italic.state).toBe('unspecified');
    expect(brushed.bold.state).toBe('on');
  });
});

describe('增减字号（WF-008）', () => {
  it('pt 字号直接相对增减', () => {
    const props = runProperties({ size: { state: 'set', value: { kind: 'pt', value: 12 } } });
    expect(applyOrThrow(props, adjustFontSize(2)).size).toEqual({ state: 'set', value: { kind: 'pt', value: 14 } });
    expect(applyOrThrow(props, adjustFontSize(-2)).size).toEqual({ state: 'set', value: { kind: 'pt', value: 10 } });
  });

  it('字号未显式设置 ⇒ 前置条件失败（不假装知道相对基准）', () => {
    const applied = applyCharacterOperation(unspecifiedRunProperties(), adjustFontSize(2));
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('precondition');
  });

  it('中文名字号：未注入换算表 ⇒ unsupported（表在 units 包，本包不复制，R128/R129）', () => {
    const props = runProperties({ size: { state: 'set', value: { kind: 'chinese', name: '小四' } } });
    const applied = applyCharacterOperation(props, adjustFontSize(2));
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.code).toBe('unsupported');
    expect(applied.message).toContain('units');
  });

  it('注入换算表后中文名字号也能相对增减', () => {
    const props = runProperties({ size: { state: 'set', value: { kind: 'chinese', name: '小四' } } });
    const applied = applyCharacterOperation(props, adjustFontSize(2), {
      resolveFontSizePt: (size) => (size.kind === 'chinese' && size.name === '小四' ? 12 : null),
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.size).toEqual({ state: 'set', value: { kind: 'pt', value: 14 } });
  });

  it('增减到非正数 ⇒ 拒绝', () => {
    const props = runProperties({ size: { state: 'set', value: { kind: 'pt', value: 1 } } });
    const applied = applyCharacterOperation(props, adjustFontSize(-5));
    expect(applied.ok).toBe(false);
  });
});
