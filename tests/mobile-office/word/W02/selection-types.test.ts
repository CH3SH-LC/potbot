/**
 * **W02 — `FailureDetail.extra` 标量类型扩展的独立验证**
 * （`tests/mobile-office/word/W02/selection-types.test.ts`）。
 *
 * 集成请求来源：W-R04 在 `src/documents/selection/types.ts` 之外实现了代理对切分，
 * 需要如实上报"平台边界是否切断了代理对"这一**布尔标志**；原类型只接受 `number | string`，
 * 只能把标志编码成 `1/0` 让调用方反解。本次把 `extra` 的值类型**加法**扩展到
 * `number | string | boolean`，不改动任何既有取值语义。
 *
 * 本文件同时覆盖两层：
 * 1. **类型层**（由 `tsc --noEmit` 判定，`vitest` 运行期擦除）：布尔字段可赋值、既有
 *    `number`/`string` 仍可赋值、`extra` 仍是**封闭的标量联合**而非 `unknown`。
 * 2. **运行期层**（由 `vitest` 判定）：布尔标志经 `fail(...)` 往返后仍是严格 `true`/`false`，
 *    没有被强转成 `1/0`；字符串/数字补充量行为不变。
 *
 * 反向对照：`@ts-expect-error` 的对象字段用例证明扩展是**窄**的（只多了布尔，没放开成任意值）。
 * 若有人把联合放宽到 `unknown`/`any`，该行不再报错 ⇒ `tsc` 报"未使用的 @ts-expect-error" ⇒ 变红。
 */

import { describe, expect, it } from 'vitest';

import type { Failure, FailureDetail } from '../../../../src/documents/selection/types.js';
import { fail, succeed } from '../../../../src/documents/selection/types.js';

// ---------------------------------------------------------------------------
// 类型层断言（只在 tsc 下生效；vitest 会擦除类型）
// ---------------------------------------------------------------------------

/** 编译期真值断言：`Expect<false>` 无法满足 `T extends true` ⇒ tsc 报错。 */
type Expect<T extends true> = T;
/** 结构等值（对联合体与成员顺序不敏感）。 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** `extra` 的值类型（去掉可选与 `undefined`）。 */
type ExtraValue = NonNullable<FailureDetail['extra']>[string];

/**
 * 值域**恰好**是这三个标量。用 `Equal`（而非 `extends`）钉死：既证明布尔被接受，
 * 也证明没有被过度放宽到例如 `unknown`。
 */
type _ExtraIsScalarUnion = Expect<Equal<ExtraValue, number | string | boolean>>;

/** 既有数字补充量仍可赋值（加法扩展不得回归旧用例）。 */
type _NumericStillAccepted = { hitCount: number } extends Record<string, ExtraValue> ? true : false;
type _NumericCheck = Expect<_NumericStillAccepted>;

/** 既有字符串补充量仍可赋值。 */
type _StringStillAccepted = { expression: string } extends Record<string, ExtraValue> ? true : false;
type _StringCheck = Expect<_StringStillAccepted>;

/** 布尔标志可赋值。 */
type _BooleanAccepted = { surrogateSplit: boolean } extends Record<string, ExtraValue> ? true : false;
type _BooleanCheck = Expect<_BooleanAccepted>;

// 反向对照：结构体字段**不是**标量，必须仍被拒绝（证明联合没有被拓宽成 `unknown`）。
// @ts-expect-error 对象/数组不在 extra 允许的值域内。
const _structuredExtraIsRejected: FailureDetail = { extra: { nested: { depth: 1 } } };

// ---------------------------------------------------------------------------
// 运行期断言
// ---------------------------------------------------------------------------

describe('FailureDetail.extra 标量类型扩展（W-R04 集成请求）', () => {
  it('布尔标志经 fail(...) 往返后仍是严格 boolean，未被编码成 1/0', () => {
    const failure: Failure = fail('unsupported', '平台边界落在代理对中间', {
      extra: {
        surrogateSplit: true,
        committed: false,
        utf16Start: 3,
        reason: 'mid-surrogate',
      },
    });

    // 真值身份：严格 boolean，而不是 truthy/falsy 的 1/0。
    expect(failure.detail.extra?.['surrogateSplit']).toBe(true);
    expect(failure.detail.extra?.['committed']).toBe(false);
    expect(typeof failure.detail.extra?.['surrogateSplit']).toBe('boolean');
    expect(typeof failure.detail.extra?.['committed']).toBe('boolean');

    // 反向对照：一旦编码成 1/0，这两条立即变红（防"标志被静默降级"）。
    expect(failure.detail.extra?.['surrogateSplit']).not.toBe(1);
    expect(failure.detail.extra?.['committed']).not.toBe(0);

    // 既有标量补充量语义不变。
    expect(failure.detail.extra?.['utf16Start']).toBe(3);
    expect(typeof failure.detail.extra?.['utf16Start']).toBe('number');
    expect(failure.detail.extra?.['reason']).toBe('mid-surrogate');
    expect(typeof failure.detail.extra?.['reason']).toBe('string');
  });

  it('布尔值可被结构化克隆往返（冻结 detail 不破坏克隆路径）', () => {
    const failure = fail('precondition', '撤销栈已就绪', {
      extra: { undoable: true, depth: 2, scope: 'paragraph' },
    });
    const clone = structuredClone(failure.detail);

    expect(clone.extra?.['undoable']).toBe(true);
    expect(clone.extra?.['depth']).toBe(2);
    expect(clone.extra?.['scope']).toBe('paragraph');
  });

  it('succeed(...) 成功分支不受影响（返回值类型仍是 T）', () => {
    const ok = succeed({ applied: true });
    expect(ok.ok).toBe(true);
    expect(ok.value.applied).toBe(true);
  });

  it('省略 extra 时仍为 undefined（可选性未被类型扩展改变）', () => {
    const failure = fail('not_found', '零命中');
    expect(failure.detail.extra).toBeUndefined();
  });
});
