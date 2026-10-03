/**
 * run 属性编辑引擎（WF-001–016；R117–R121）。
 *
 * 纯函数：`(RunProperties, 操作) → Result<RunProperties>`。**不碰文档结构、不碰 XML**。
 * 结果的四态语义**直接就是模型态**：`off` 会被导出层写成 `w:val="false"`，
 * `unspecified` / `inherit` 不写元素（`inherit` 的含义是"删除已有元素、回落样式"）——
 * 这三种产出各有各的用例，不允许塌成一种（R118）。
 */

import {
  TOGGLE_INHERIT,
  TOGGLE_OFF,
  TOGGLE_ON,
  type FontSize,
  type RunProperties,
  type ToggleState,
  type ValuedState,
} from '../../model/types.js';
import { fail, succeed, type Result } from '../../selection/types.js';
import type {
  CharacterFormatOperation,
  CharacterPropertyKey,
  TogglePropertyKey,
  ValuedPropertyKey,
  ValuedPropertyValueMap,
} from './types.js';

/**
 * "取消"（`unsetValue`）时各带值属性取什么值。
 *
 * - **OOXML 有中性枚举值**的，写显式中性值：下划线 `none`、上下标 `baseline`、
 *   高亮 `none`、颜色 `auto`、缩放 `100`、位置 `0`；
 * - **没有中性值可取**的（字体、字号、底纹、字符间距），回落 `inherit`——
 *   即删除该元素、交由样式级联决定（R117 的 `inherit`）。
 *
 * `null` 表示"取 `inherit`"。这张表是**唯一权威**：各操作不允许各自决定"取消"长什么样。
 */
export const CANONICAL_UNSET: { readonly [K in ValuedPropertyKey]: ValuedPropertyValueMap[K] | null } = {
  underline: 'none',
  vertAlign: 'baseline',
  highlight: 'none',
  color: { kind: 'auto' },
  scale: 100,
  position: { unit: 'pt', value: 0 },
  fonts: null,
  size: null,
  shading: null,
  spacing: null,
};

export interface OperationContext {
  /**
   * `toggle` 判定所需：**选区内全部 run 的当前属性**（R121）。
   * 缺省时 toggle 直接报前置条件不满足，而不是猜一个目标态。
   */
  readonly selectedProperties?: readonly RunProperties[];
  /**
   * 中文名字号 → pt 的换算注入点（WF-008）。本包**不持有**中文字号表（R128/R129），
   * 由 `src/documents/units/**` 提供。
   */
  readonly resolveFontSizePt?: (size: FontSize) => number | null;
}

/** 单个受控断言：`key` 是 `RunProperties` 的键，`state` 与该键的类型相容由调用方保证。 */
function withToggleState(props: RunProperties, key: TogglePropertyKey, state: ToggleState): RunProperties {
  return { ...props, [key]: state } as RunProperties;
}

function withValuedState<K extends ValuedPropertyKey>(
  props: RunProperties,
  key: K,
  state: ValuedState<ValuedPropertyValueMap[K]>,
): RunProperties {
  return { ...props, [key]: state } as RunProperties;
}

/** 联合分支收窄失败时的收口：`property` 与 `value` 的相关性已在签名层保证。 */
function withValuedStateLoose(
  props: RunProperties,
  key: ValuedPropertyKey,
  state: ValuedState<unknown>,
): RunProperties {
  return { ...props, [key]: state } as RunProperties;
}

/**
 * 清除直接格式后的属性集：每个字段都是 `inherit`（删元素、回落样式）。
 * 字面量写在这里（而不是走一个返回泛型的辅助函数）是为了让**上下文的 `RunProperties`
 * 注解**去约束每个 `ValuedState<T>` 的 `T`——辅助函数会把 `T` 推成 `unknown`。
 */
const CLEARED_RUN_PROPERTIES_VALUE: RunProperties = {
  bold: TOGGLE_INHERIT,
  italic: TOGGLE_INHERIT,
  underline: { state: 'inherit' },
  strike: TOGGLE_INHERIT,
  doubleStrike: TOGGLE_INHERIT,
  vertAlign: { state: 'inherit' },
  fonts: { state: 'inherit' },
  size: { state: 'inherit' },
  scale: { state: 'inherit' },
  position: { state: 'inherit' },
  color: { state: 'inherit' },
  highlight: { state: 'inherit' },
  shading: { state: 'inherit' },
  spacing: { state: 'inherit' },
  caps: TOGGLE_INHERIT,
  smallCaps: TOGGLE_INHERIT,
};

export const CLEARED_RUN_PROPERTIES: RunProperties = Object.freeze(CLEARED_RUN_PROPERTIES_VALUE);

/** 该属性集是否已是"无任何直接字符格式"（每个字段都 `inherit`）。 */
export function isDirectFormatCleared(props: RunProperties): boolean {
  return (Object.keys(CLEARED_RUN_PROPERTIES) as CharacterPropertyKey[]).every(
    (key) => props[key].state === 'inherit',
  );
}

/** 该属性集是否**没有任何**直接格式（每个字段都 `inherit` 或 `unspecified`）。 */
export function hasNoDirectFormat(props: RunProperties): boolean {
  return (Object.keys(CLEARED_RUN_PROPERTIES) as CharacterPropertyKey[]).every((key) => {
    const state: string = props[key].state;
    return state === 'inherit' || state === 'unspecified';
  });
}

/**
 * 施加一个字符格式操作。失败时**不返回任何部分结果**（R136 的原子性在单 run 层的体现）。
 */
export function applyCharacterOperation(
  props: RunProperties,
  operation: CharacterFormatOperation,
  context: OperationContext = {},
): Result<RunProperties> {
  switch (operation.kind) {
    case 'setToggle':
      return succeed(withToggleState(props, operation.property, operation.value ? TOGGLE_ON : TOGGLE_OFF));

    case 'toggle': {
      const selection = context.selectedProperties;
      if (selection === undefined || selection.length === 0) {
        return fail('precondition', 'toggle 需要选区内全部 run 的当前属性才能判定目标态（R121），调用方未提供。', {
          extra: { property: operation.property },
        });
      }
      const allOn = selection.every((item) => item[operation.property].state === 'on');
      return succeed(withToggleState(props, operation.property, allOn ? TOGGLE_OFF : TOGGLE_ON));
    }

    case 'setValue':
      return succeed(withValuedStateLoose(props, operation.property, { state: 'set', value: operation.value }));

    case 'unsetValue': {
      const canonical = CANONICAL_UNSET[operation.property];
      if (canonical === null) {
        return succeed(withValuedStateLoose(props, operation.property, { state: 'inherit' }));
      }
      return succeed(withValuedStateLoose(props, operation.property, { state: 'set', value: canonical }));
    }

    case 'inherit':
      return succeed(
        isToggleKey(operation.property)
          ? withToggleState(props, operation.property, TOGGLE_INHERIT)
          : withValuedStateLoose(props, operation.property, { state: 'inherit' }),
      );

    case 'clearDirectFormat':
      return succeed(CLEARED_RUN_PROPERTIES);

    case 'formatBrush':
      // 格式刷复制的是**直接格式整份**：目标 run 的 rPr 变成来源 run 的 rPr。
      return succeed(operation.source);

    case 'adjustFontSize': {
      const size = props.size;
      if (size.state !== 'set') {
        return fail('precondition', '字号未显式设置，无法做相对增减；请先设定绝对字号（WF-007）。', {
          extra: { deltaPt: operation.deltaPt },
        });
      }
      const currentPt =
        size.value.kind === 'pt' ? size.value.value : (context.resolveFontSizePt?.(size.value) ?? null);
      if (currentPt === null) {
        return fail(
          'unsupported',
          '中文字号名到 pt 的映射表在 src/documents/units/**（R128/R129 唯一权威），本包不复制；' +
            '请通过 OperationContext.resolveFontSizePt 注入换算后再做相对调整。',
          { extra: { name: size.value.kind === 'chinese' ? size.value.name : '' } },
        );
      }
      const next = currentPt + operation.deltaPt;
      if (!(next > 0)) {
        return fail('precondition', `增减后的字号 ${next}pt 不是正数。`, {
          extra: { currentPt, deltaPt: operation.deltaPt },
        });
      }
      return succeed(withValuedState(props, 'size', { state: 'set', value: { kind: 'pt', value: next } }));
    }
  }
}

function isToggleKey(key: CharacterPropertyKey): key is TogglePropertyKey {
  return key === 'bold' || key === 'italic' || key === 'strike' || key === 'doubleStrike' || key === 'caps' || key === 'smallCaps';
}
