/**
 * **W02 / W-I13 — 查找替换的大小写转换（WF-014）独立验证**。
 *
 * WF-014 最低验收（只读素材 `docs/other/ds-word-common-features-2026-10-02.md`）：
 * 「按选区转换；**不改变中文、数字和未选区**」。
 * WF-088 最低验收含「**无匹配不假报成功**」——本次把这条钉在替换路径上。
 *
 * 被测对象：`src/documents/operations/character/replace.ts` 的 `replaceText`
 * （`caseMode` + `find.caseSensitive`）。本文件**只读模型文本**回读判定，
 * 不 import 被测实现内部的判定逻辑，避免自证。
 *
 * 核心判据（与派发单一致）：
 * - `replaceText(doc, 'foo', 'Bar', all+confirm, {find:{caseSensitive:false}, caseMode:'preserve'})`
 *   在 `FOO and Foo` 上 ⇒ `BAR and Bar`；
 * - 零命中 ⇒ `not_found`（不是 ok+replaced=0）；
 * - 默认（不给 caseMode / caseSensitive）行为与既有实现逐字一致。
 */

import { describe, expect, it } from 'vitest';

import {
  REPLACE_ALL,
  REPLACE_FIRST,
  replaceText,
  type ReplaceCaseMode,
} from '../../../../src/documents/operations/character/replace.js';
import { collectParagraphs, paragraphText } from '../../../../src/documents/selection/structure.js';
import { document, paragraphOfRuns } from '../../../../src/documents/selection/testing.js';

/** 独立回读：把模型每段文本取出来（不复用被测实现的 report）。 */
function texts(model: ReturnType<typeof document>): string[] {
  return collectParagraphs(model.blocks).map(paragraphText);
}

const MIXED_CASE = 'FOO and Foo';

describe('WF-014 · 大小写不敏感匹配 + preserve 保大小写替换（核心判据）', () => {
  const doc = document([paragraphOfRuns('p1', [['r1', MIXED_CASE]])]);

  it("replace 'foo'->'Bar'（caseSensitive:false, preserve）⇒ FOO→BAR、Foo→Bar", () => {
    const out = replaceText(doc, 'foo', 'Bar', REPLACE_ALL, {
      confirmAll: true,
      find: { caseSensitive: false },
      caseMode: 'preserve',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(texts(out.value.model)).toEqual(['BAR and Bar']);
    expect(out.value.report.replaced).toBe(2);
    expect(out.value.report.totalMatches).toBe(2);
    expect(out.value.report.caseMode).toBe('preserve');
  });

  it('反向对照：同一输入 caseMode=none（默认形态）⇒ 两处都原样 Bar，证明 preserve 不是空壳', () => {
    const out = replaceText(doc, 'foo', 'Bar', REPLACE_ALL, {
      confirmAll: true,
      find: { caseSensitive: false },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 与上一条**必须产出不同文本**——否则 preserve 分支没起作用。
    expect(texts(out.value.model)).toEqual(['Bar and Bar']);
    expect(out.value.report.caseMode).toBe('none');
  });

  it('默认区分大小写：query "foo" 匹配不到 "FOO" ⇒ not_found，文档不变（WF-088 不假报成功）', () => {
    const before = texts(doc);
    const out = replaceText(doc, 'foo', 'Bar', REPLACE_ALL, { confirmAll: true });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('not_found');
    expect(out.detail.hitCount).toBe(0);
    expect(texts(doc)).toEqual(before);
  });
});

describe('WF-014 · 显式形态 lower / upper / title', () => {
  const doc = document([paragraphOfRuns('p1', [['r1', 'foo and Foo']])]);

  function replaceAll(mode: ReplaceCaseMode, replacement = 'Bar'): string[] {
    const out = replaceText(doc, 'foo', replacement, REPLACE_ALL, {
      confirmAll: true,
      find: { caseSensitive: false },
      caseMode: mode,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return [];
    return texts(out.value.model);
  }

  it('upper ⇒ 替换文本整体大写', () => {
    expect(replaceAll('upper', 'Bar')).toEqual(['BAR and BAR']);
  });

  it('lower ⇒ 替换文本整体小写', () => {
    expect(replaceAll('lower', 'BAR')).toEqual(['bar and bar']);
  });

  it('title ⇒ 替换文本词首大写、其余小写', () => {
    expect(replaceAll('title', 'bAR')).toEqual(['Bar and Bar']);
    expect(replaceAll('title', 'hello world')).toEqual(['Hello World and Hello World']);
  });
});

describe('WF-014 · preserve 的推断分支', () => {
  function one(text: string, query: string, replacement: string): string[] {
    const doc = document([paragraphOfRuns('p1', [['r1', text]])]);
    const out = replaceText(doc, query, replacement, REPLACE_FIRST, {
      find: { caseSensitive: false },
      caseMode: 'preserve',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return [];
    return texts(out.value.model);
  }

  it('全小写命中 ⇒ 替换文本转小写', () => {
    expect(one('foo', 'FOO', 'BAR')).toEqual(['bar']);
  });

  it('全大写命中 ⇒ 替换文本转大写', () => {
    expect(one('FOO', 'foo', 'bar')).toEqual(['BAR']);
  });

  it('首字母大写命中 ⇒ 替换文本词首大写', () => {
    expect(one('Foo', 'foo', 'bar')).toEqual(['Bar']);
  });

  it('大小写混乱命中（fOo）⇒ 按"首字母形态"判定为小写', () => {
    expect(one('fOo', 'foo', 'BAR')).toEqual(['bar']);
  });

  it('命中原文本无字母（纯数字）⇒ 替换文本原样落地，不做推断（WF-014 不动数字）', () => {
    // 反向对照：若误走 upper，会把 'x' 变成 'X'。
    expect(one('v1', '1', 'x')).toEqual(['vx']);
  });
});

describe('WF-014 · 不改变中文、数字与未选区', () => {
  it('中英数混排：只改命中的英文词，中文/数字/标点与其余文本原封不动', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '版本 v2 foo 3.5 测试 foo 完']])]);
    const out = replaceText(doc, 'foo', 'NAME', REPLACE_ALL, {
      confirmAll: true,
      caseMode: 'upper',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(texts(out.value.model)).toEqual(['版本 v2 NAME 3.5 测试 NAME 完']);
  });

  it('preserve 在中文语境里同样只动命中词的形态', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', '标题 Foo 与 FOO 并列']])]);
    const out = replaceText(doc, 'foo', 'bar', REPLACE_ALL, {
      confirmAll: true,
      find: { caseSensitive: false },
      caseMode: 'preserve',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(texts(out.value.model)).toEqual(['标题 Bar 与 BAR 并列']);
  });
});

describe('WF-014 · 跨 run 命中的大小写取自段落拼接文本', () => {
  it('命中被拆在 3 个 run 里，preserve 仍按整词形态（FOO ⇒ 大写）替换', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', 'F'], ['r2', 'O'], ['r3', 'O tail']])]);
    const out = replaceText(doc, 'foo', 'bar', REPLACE_FIRST, {
      find: { caseSensitive: false },
      caseMode: 'preserve',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(texts(out.value.model)).toEqual(['BAR tail']);
  });

  it('同段小写跨 run 命中 ⇒ preserve 转小写（与上一条构成形态对照）', () => {
    const doc = document([paragraphOfRuns('p1', [['r1', 'f'], ['r2', 'o'], ['r3', 'o tail']])]);
    const out = replaceText(doc, 'FOO', 'BAR', REPLACE_FIRST, {
      find: { caseSensitive: false },
      caseMode: 'preserve',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(texts(out.value.model)).toEqual(['bar tail']);
  });
});

describe('WF-088 · 无匹配不假报成功（多入口一致的失败形态）', () => {
  const doc = document([paragraphOfRuns('p1', [['r1', '唯一 foo 处']])]);

  it('caseSensitive:false 下也查不到 ⇒ not_found，绝不 ok+replaced=0', () => {
    const out = replaceText(doc, 'zzz', 'Q', REPLACE_ALL, {
      confirmAll: true,
      find: { caseSensitive: false },
      caseMode: 'preserve',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('not_found');
    expect(out.detail.hitCount).toBe(0);
    expect(out.detail.expression).toBe('zzz');
  });

  it('空查询 ⇒ invalid_query（"没查"与"查不到"是两回事）', () => {
    const out = replaceText(doc, '', 'Q', REPLACE_ALL, { confirmAll: true, caseMode: 'upper' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('invalid_query');
  });

  it('nth 越界即使设置 preserve 也失败，且模型一字未改', () => {
    const before = texts(doc);
    const out = replaceText(doc, 'foo', 'Q', { kind: 'nth', index: 5 }, { caseMode: 'preserve' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('not_found');
    expect(texts(doc)).toEqual(before);
  });

  it('报告中 replaced 恒等于实际落地处数：命中 1 处时 replaced=1、totalMatches=1', () => {
    const out = replaceText(doc, 'foo', 'BAR', REPLACE_ALL, { caseMode: 'lower' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.report.replaced).toBe(1);
    expect(out.value.report.totalMatches).toBe(1);
    expect(texts(out.value.model)).toEqual(['唯一 bar 处']);
  });
});
