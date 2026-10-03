/**
 * 文本语言与选区翻译单测（WF-096）。
 *
 * 判据：**翻译绑定原 revision 与选区、不改范围外内容、明确来源、走模型预算**。
 * 其中"迟到结果必须拒绝"用一条独立用例钉住：提案在 r1 产生，文档在期间被改到 r2，
 * 提交必须 `stale_revision`——而不是"反正译文看起来对就盖上去"。
 *
 * 本轮**不接真实模型**：所有翻译端口都是确定性桩，来源恒为 `deterministic_stub`，
 * 断言里也顺带检查"来源确实被如实标出来了"。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel } from '../model/types.js';
import { paragraphText } from '../selection/structure.js';
import { breakNode, document, paragraph, paragraphOfRuns, run } from '../selection/testing.js';
import type { Result, Selection } from '../selection/types.js';
import { describeLanguageSetting, isValidLanguageTag, setProofingLanguage } from './language.js';
import { createStubTranslator, createTaggingTranslator } from './testing.js';
import { commitTranslation, describeTranslation, translateSelection, type TranslationProposal } from './translation.js';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.code} / ${result.message}`);
  return result.value;
}

function textOf(model: DocumentModel, nodeId: string): string {
  for (const block of model.blocks) {
    if (block.kind === 'paragraph' && block.id === nodeId) return paragraphText(block);
  }
  throw new Error(`找不到段落 ${nodeId}`);
}

function blockOf(model: DocumentModel, nodeId: string) {
  return model.blocks.find((block) => block.id === nodeId);
}

function select(nodeId: string, start: number, end: number, baseRevision = 1): Selection {
  return { document_id: 'doc-1', base_revision: baseRevision, ranges: [{ node_id: nodeId, start, end }] };
}

const BUDGET = { max_model_calls: 5 };

describe('校对语言（WF-096 前半句）', () => {
  it('合法 BCP-47 标签的形状判定', () => {
    for (const tag of ['zh', 'zh-CN', 'en-US', 'sr-Latn-RS']) {
      expect(isValidLanguageTag(tag), tag).toBe(true);
    }
    for (const tag of ['zh_CN', '中文', 'z', '123', '', 'zh CN']) {
      expect(isValidLanguageTag(tag), tag).toBe(false);
    }
  });

  it('为选区声明语言：绑定 documentId + baseRevision + 范围，并如实标注"未接线"', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '你好']])]);
    const setting = unwrap(setProofingLanguage(model, select('p1', 0, 2), 'zh-CN'));

    expect(setting.document_id).toBe('doc-1');
    expect(setting.base_revision).toBe(1);
    expect(setting.language_tag).toBe('zh-CN');
    expect(setting.apply_to_selection_only).toBe(true);
    expect(setting.wiring).toBe('declared_not_exported');
    expect(setting.ranges).toEqual([{ node_id: 'p1', start: 0, end: 2 }]);
    expect(describeLanguageSetting(setting)).toContain('尚未接线到导出器');
  });

  it('反例：非法标签 / 过期选区 / 空选区，分别被拒', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '你好']])], { revision: 3 });

    const badTag = setProofingLanguage(model, select('p1', 0, 1, 3), '中文');
    expect(badTag.ok).toBe(false);
    if (!badTag.ok) expect(badTag.code).toBe('invalid_query');

    const stale = setProofingLanguage(model, select('p1', 0, 1, 1), 'zh-CN');
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('stale_revision');

    const empty = setProofingLanguage(model, { document_id: 'doc-1', base_revision: 3, ranges: [] }, 'zh-CN');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('empty_range');
  });
});

describe('选区翻译：只翻选区、走预算、来源可读', () => {
  it('翻译选区产出提案（不动文档），提交后才改，且 revision +1', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '你好世界']])]);
    const translator = createStubTranslator({ 你好世界: 'Hello world' });

    const proposal = unwrap(
      translateSelection(model, select('p1', 0, 4), { target_language: 'en-US', translator, budget: BUDGET }),
    );

    expect(proposal.base_revision).toBe(1);
    expect(proposal.segments).toHaveLength(1);
    expect(proposal.segments[0]!.source_text).toBe('你好世界');
    expect(proposal.segments[0]!.translated_text).toBe('Hello world');
    expect(proposal.model_calls).toBe(1);
    expect(proposal.segments[0]!.source.kind).toBe('deterministic_stub');
    // 提案阶段文档没被改
    expect(textOf(model, 'p1')).toBe('你好世界');

    const committed = unwrap(commitTranslation(model, proposal));
    expect(textOf(committed, 'p1')).toBe('Hello world');
    expect(committed.revision).toBe(2);
    expect(describeTranslation(proposal)).toContain('1/5');
    expect(describeTranslation(proposal)).toContain('deterministic_stub');
  });

  it('只翻选区：范围外段落引用不变、范围外文本一字不动', () => {
    const model = document([
      paragraphOfRuns('p1', [['r1', '你好世界']]),
      paragraphOfRuns('p2', [['r2', '不能被动到']]),
    ]);
    const translator = createTaggingTranslator();

    const proposal = unwrap(
      translateSelection(model, select('p1', 0, 2), { target_language: 'en-US', translator, budget: BUDGET }),
    );
    expect(proposal.segments[0]!.source_text).toBe('你好');

    const committed = unwrap(commitTranslation(model, proposal));
    expect(textOf(committed, 'p1')).toBe('[en-US]你好世界'); // 只翻前两个字，其余原样
    expect(textOf(committed, 'p2')).toBe('不能被动到');
    // 范围外段落对象**按引用保留**（"未修改的东西没被重写"）
    expect(blockOf(committed, 'p2')).toBe(blockOf(model, 'p2'));
  });

  it('跨 run 的选区能整段翻译（切分由选区包负责）', () => {
    const model = document([paragraph('p1', [run('r1', '你'), run('r2', '好')])]);
    const translator = createTaggingTranslator();
    const proposal = unwrap(
      translateSelection(model, select('p1', 0, 2), { target_language: 'en-US', translator, budget: BUDGET }),
    );
    const committed = unwrap(commitTranslation(model, proposal));
    expect(textOf(committed, 'p1')).toBe('[en-US]你好');
  });

  it('多范围：每个范围一次模型调用，调用次数进提案', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '第一段文字']])]);
    const translator = createTaggingTranslator();
    const selection: Selection = {
      document_id: 'doc-1',
      base_revision: 1,
      ranges: [
        { node_id: 'p1', start: 0, end: 3 },
        { node_id: 'p1', start: 3, end: 5 },
      ],
    };
    const proposal = unwrap(
      translateSelection(model, selection, { target_language: 'en-US', translator, budget: BUDGET }),
    );
    expect(proposal.model_calls).toBe(2);
    expect(translator.callCount()).toBe(2);
    expect(unwrap(commitTranslation(model, proposal)).revision).toBe(2); // 一次事务只 +1
  });

  it('预算不足 ⇒ **先拒绝、后调用**：端口一次都不该被调用', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '第一段文字']])]);
    const translator = createTaggingTranslator();
    const selection: Selection = {
      document_id: 'doc-1',
      base_revision: 1,
      ranges: [
        { node_id: 'p1', start: 0, end: 2 },
        { node_id: 'p1', start: 2, end: 4 },
      ],
    };
    const result = translateSelection(model, selection, {
      target_language: 'en-US',
      translator,
      budget: { max_model_calls: 1 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('precondition');
      expect(result.detail.extra?.['requiredModelCalls']).toBe(2);
      expect(result.detail.extra?.['maxModelCalls']).toBe(1);
    }
    expect(translator.callCount()).toBe(0); // 没有先花掉再报错
  });

  it('迟到结果被拒：提案基于 r1，文档已到 r2 ⇒ stale_revision（R142/R143）', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '你好']])]);
    const translator = createTaggingTranslator();
    const proposal = unwrap(
      translateSelection(model, select('p1', 0, 2), { target_language: 'en-US', translator, budget: BUDGET }),
    );

    const bumped: DocumentModel = { ...model, revision: 2 };
    const result = commitTranslation(bumped, proposal);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_revision');
      expect(result.detail.currentRevision).toBe(2);
      expect(result.detail.requestedRevision).toBe(1);
      expect(result.message).toContain('迟到的翻译结果必须拒绝');
    }
  });
});

describe('翻译的拒绝路径', () => {
  it('目标语言非法 / 预算非法 / 选区过期 / 空选区', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '你好']])]);
    const translator = createTaggingTranslator();

    const badLanguage = translateSelection(model, select('p1', 0, 2), {
      target_language: '中文',
      translator,
      budget: BUDGET,
    });
    expect(badLanguage.ok).toBe(false);
    if (!badLanguage.ok) expect(badLanguage.code).toBe('invalid_query');

    const badBudget = translateSelection(model, select('p1', 0, 2), {
      target_language: 'en-US',
      translator,
      budget: { max_model_calls: -1 },
    });
    expect(badBudget.ok).toBe(false);

    const stale = translateSelection(model, select('p1', 0, 2, 0), {
      target_language: 'en-US',
      translator,
      budget: BUDGET,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('stale_revision');

    const empty = translateSelection(model, { document_id: 'doc-1', base_revision: 1, ranges: [] }, {
      target_language: 'en-US',
      translator,
      budget: BUDGET,
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('empty_range');

    expect(translator.callCount()).toBe(0);
  });

  it('重叠范围 ⇒ precondition（同一段文字不能被翻两次）', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '你好世界']])]);
    const translator = createTaggingTranslator();
    const result = translateSelection(
      model,
      {
        document_id: 'doc-1',
        base_revision: 1,
        ranges: [
          { node_id: 'p1', start: 0, end: 3 },
          { node_id: 'p1', start: 2, end: 4 },
        ],
      },
      { target_language: 'en-US', translator, budget: BUDGET },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('precondition');
  });

  it('提交时文档不符 / 原文已变 / 含软换行，分别被拒', () => {
    const model = document([paragraphOfRuns('p1', [['r1', '你好']])]);
    const translator = createTaggingTranslator();
    const proposal = unwrap(
      translateSelection(model, select('p1', 0, 2), { target_language: 'en-US', translator, budget: BUDGET }),
    );

    const otherDoc = commitTranslation({ ...model, document_id: 'doc-9' }, proposal);
    expect(otherDoc.ok).toBe(false);
    if (!otherDoc.ok) expect(otherDoc.code).toBe('mismatched_document');

    const drifted: TranslationProposal = {
      ...proposal,
      segments: [{ ...proposal.segments[0]!, source_text: '不是原来的字' }],
    };
    const driftResult = commitTranslation(model, drifted);
    expect(driftResult.ok).toBe(false);
    if (!driftResult.ok) expect(driftResult.code).toBe('precondition');

    const emptyProposal: TranslationProposal = { ...proposal, segments: [] };
    const emptyResult = commitTranslation(model, emptyProposal);
    expect(emptyResult.ok).toBe(false);
    if (!emptyResult.ok) expect(emptyResult.code).toBe('empty_range');

    const withBreak = document([paragraph('p1', [run('r1', '你好'), breakNode('b1')])]);
    const breakProposal = unwrap(
      translateSelection(withBreak, select('p1', 0, 3), { target_language: 'en-US', translator, budget: BUDGET }),
    );
    const breakResult = commitTranslation(withBreak, breakProposal);
    expect(breakResult.ok).toBe(false);
    if (!breakResult.ok) expect(breakResult.code).toBe('unsupported');
  });
});
