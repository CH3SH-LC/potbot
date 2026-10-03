/**
 * **合同对齐的可执行断言**（S5）。
 *
 * `src/artifacts/templates/docx.ts` 不能 import `apps/demo/contracts.ts`（内核不依赖应用），
 * 于是段数 / 字数上限在两边各有一份常量。那就有"两份常量悄悄漂开"的风险——
 * 本文件把"对齐"从注释里的承诺变成机器判据：
 *
 * 1. 三个上限制**数值相等**；
 * 2. 模板**实际执行**的判据就是合同那一组数（用 `LIMITS` 算出的边界输入去试）：
 *    `minParagraphs - 1` / `maxParagraphs + 1` 必须被拒，`minParagraphs` / `maxParagraphs` 必须通过；
 *    `maxDraftChars` 恰好通过、`maxDraftChars + 1` 被拒。
 *
 * 这样 S3 只要按 `LIMITS` 造草稿，模板就不会在边界处给出"合同说行、内核说不行"的分叉。
 */

import { describe, expect, it } from 'vitest';

import { DOCX_MIME, LIMITS } from '../contracts.js';
import {
  DOCX_MAIN_CONTENT_TYPE,
  DOCX_MAX_BODY_CHARS,
  DOCX_MAX_BODY_PARAGRAPHS,
  DOCX_MIN_BODY_PARAGRAPHS,
  buildDocxTemplate,
} from '../../../src/artifacts/templates/docx.js';

/** 只换 paragraphs 的最小输入（空快照 / 空引用，避免与数字护栏纠缠）。 */
function withParagraphs(paragraphs: readonly string[]) {
  return {
    requirement: { title: '合同对齐', description: '（段落路径不渲染 description）', paragraphs },
    fact_snapshot: [],
    references: [],
  };
}

/** `count` 段、每段 `length` 字（全部为无数字字符，只考察长度判据）。 */
function paragraphsOf(count: number, length: number): readonly string[] {
  return Array.from({ length: count }, () => '长'.repeat(length));
}

describe('合同 v1 LIMITS 与 DOCX 模板常量必须一致', () => {
  it('段数上下限与正文字数上限逐项相等', () => {
    expect(DOCX_MIN_BODY_PARAGRAPHS).toBe(LIMITS.minParagraphs);
    expect(DOCX_MAX_BODY_PARAGRAPHS).toBe(LIMITS.maxParagraphs);
    expect(DOCX_MAX_BODY_CHARS).toBe(LIMITS.maxDraftChars);
  });

  it('模板**实际执行**的边界 = 合同的边界（不是只有常量相同）', () => {
    expect(() =>
      buildDocxTemplate(withParagraphs(paragraphsOf(LIMITS.minParagraphs - 1, 8))),
    ).toThrow(/段数必须在/);
    expect(() =>
      buildDocxTemplate(withParagraphs(paragraphsOf(LIMITS.minParagraphs, 8))),
    ).not.toThrow();

    expect(() =>
      buildDocxTemplate(withParagraphs(paragraphsOf(LIMITS.maxParagraphs + 1, 8))),
    ).toThrow(/段数必须在/);
    expect(() =>
      buildDocxTemplate(withParagraphs(paragraphsOf(LIMITS.maxParagraphs, 8))),
    ).not.toThrow();

    const perParagraph = Math.floor(LIMITS.maxDraftChars / LIMITS.maxParagraphs);
    const exact = paragraphsOf(LIMITS.maxParagraphs, perParagraph);
    expect(exact.join('').length).toBe(LIMITS.maxDraftChars);
    expect(() => buildDocxTemplate(withParagraphs(exact))).not.toThrow();
    expect(() =>
      buildDocxTemplate(withParagraphs([...exact.slice(0, -1), '长'.repeat(perParagraph + 1)])),
    ).toThrow(/超出上限/);
  });

  it('合同里的 MIME 与内核模板口径一致（S1/S2/S5 共用同一字面量）', () => {
    // 主部件的内容类型 = 官方 DOCX MIME + `.main+xml`（两者同源，不是两套写法）。
    expect(DOCX_MAIN_CONTENT_TYPE).toBe(DOCX_MIME + '.main+xml');
  });
});
