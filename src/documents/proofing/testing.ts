/**
 * 校对/翻译的**测试夹具**（非生产路径；文件名不以 `.test.ts` 结尾，故 vitest 不收集）。
 *
 * 存在的理由：本轮**不接真实模型**，"翻译"必须有一个确定性替身才能测出
 * "只翻选区 / 绑 revision / 走预算"这三条。这个替身的来源恒为
 * `deterministic_stub`，并且**自带调用计数**——"预算不足时一次都没调用"这类断言
 * 只有靠计数才能证伪。
 *
 * 沿用 `src/documents/selection/testing.ts` 的既有做法：夹具与实现同目录，
 * 但不进任何运行时路径、不从 `index.ts` 导出。
 */

import type { TranslatorPort } from './translation.js';
import type { ProofingRule } from './spelling.js';

/** 确定性桩翻译器：按词典替换；未命中则原样返回（并标注未命中）。 */
export interface StubTranslator extends TranslatorPort {
  /** 端口被调用的次数（预算类断言用）。 */
  callCount(): number;
  /** 最近一次收到的输入（排查用）。 */
  lastInput(): { readonly text: string; readonly target_language: string } | null;
}

/**
 * 造一个确定性桩翻译器。
 *
 * @param dictionary 原文 → 译文；**必须显式给**，桩不会自己"猜"翻译。
 */
export function createStubTranslator(dictionary: Readonly<Record<string, string>> = {}): StubTranslator {
  let calls = 0;
  let last: { text: string; target_language: string } | null = null;
  return {
    source: {
      kind: 'deterministic_stub',
      detail: '确定性桩：按给定词典逐字替换，不是真实翻译（模型接入留后续波次）',
    },
    translate(input) {
      calls += 1;
      last = { text: input.text, target_language: input.target_language };
      return dictionary[input.text] ?? input.text;
    },
    callCount: () => calls,
    lastInput: () => last,
  };
}

/** 桩翻译器：把整段文本映射成 `[<目标语言>]<原文>`，便于断言"范围外没被动过"。 */
export function createTaggingTranslator(): StubTranslator {
  let calls = 0;
  let last: { text: string; target_language: string } | null = null;
  return {
    source: { kind: 'deterministic_stub', detail: '确定性桩：给译文加语言前缀，用于定位断言' },
    translate(input) {
      calls += 1;
      last = { text: input.text, target_language: input.target_language };
      return `[${input.target_language}]${input.text}`;
    },
    callCount: () => calls,
    lastInput: () => last,
  };
}

/**
 * 常用检查规则（**显式给出**，不是检查器内置的默认提示）。
 * 只有把规则交给检查器，它才会命中——这正是"不以固定提示冒充真实检查"。
 */
export function sampleRules(): readonly ProofingRule[] {
  return [
    {
      rule_id: 'common-typo-teh',
      kind: 'spelling',
      message: '"teh" 疑似 "the" 的拼写错误。',
      suggestions: ['the'],
      match: { kind: 'literal', text: 'teh' },
    },
    {
      rule_id: 'double-word-the',
      kind: 'grammar',
      message: '相邻重复的 "the the"。',
      suggestions: ['the'],
      match: { kind: 'regex', source: '\\bthe\\s+the\\b', flags: 'i' },
    },
    {
      rule_id: 'chinese-double-de',
      kind: 'grammar',
      message: '相邻重复的"的的"。',
      suggestions: ['的'],
      match: { kind: 'literal', text: '的的' },
    },
  ];
}
