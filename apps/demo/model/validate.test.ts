/**
 * S4 —— 纯函数校验用例（fixture，无网络、无额度）。
 */

import { describe, expect, it } from 'vitest';
import { ModelCallError } from './errors.js';
import { stripCodeFences, toParagraphTexts, validateDraftText } from './validate.js';

function expectCode(fn: () => unknown, code: string): ModelCallError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ModelCallError);
    const err = error as ModelCallError;
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`expected ModelCallError(${code}) but nothing was thrown`);
}

describe('stripCodeFences', () => {
  it('剥掉 ```json 围栏，也原样保留无围栏文本', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe('validateDraftText', () => {
  it('规范化段落 id 为 p1..pn，并统计总字数', () => {
    const draft = validateDraftText(
      JSON.stringify({
        title: '  标题  ',
        paragraphs: [
          { id: '随便写的', text: '  第一段  ' },
          { id: 'x', text: '第二段' },
        ],
      }),
    );
    expect(draft.title).toBe('标题');
    expect(draft.paragraphs.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(draft.paragraphs[0]?.text).toBe('第一段');
    expect(draft.totalChars).toBe('第一段'.length + '第二段'.length);
  });

  it('缺字段 / 非对象根 / 非数组 paragraphs 一律拒绝', () => {
    expectCode(() => validateDraftText('[]'), 'model_response_schema');
    expectCode(() => validateDraftText('"字符串"'), 'model_response_schema');
    expectCode(() => validateDraftText('{"paragraphs":[{"text":"a"},{"text":"b"}]}'), 'model_response_schema');
    expectCode(() => validateDraftText('{"title":"t","paragraphs":"nope"}'), 'model_response_schema');
    expectCode(() => validateDraftText('{"title":"t","paragraphs":[1,2]}'), 'model_response_schema');
  });

  it('空输入 / 非法 JSON 有各自独立的错误码', () => {
    expectCode(() => validateDraftText('   '), 'model_empty_response');
    expectCode(() => validateDraftText('这不是 JSON'), 'model_response_not_json');
  });

  it('toParagraphTexts 给出 S5 直接可用的纯文本数组', () => {
    const draft = validateDraftText(
      JSON.stringify({ title: 't', paragraphs: [{ text: 'a' }, { text: 'b' }] }),
    );
    expect(toParagraphTexts(draft)).toEqual(['a', 'b']);
  });
});
