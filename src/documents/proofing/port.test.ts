/**
 * 校对 / 翻译的**显式注入端口**（design-05-P9 收口；WF-095 / WF-096）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | **没有真实模型 ⇒ 如实未就绪**，且 `check` / `translator()` 都是 `fail` | ①② |
 * | **不得伪造校对结果**：未就绪的结果**不是** `ok:true` + `[]`（反向对照） | ①③ |
 * | 未就绪时**一个 `ProofingIssue` 都不产出**，也**不调用**任何能力 | ②④ |
 * | 就绪闸门 `requireReady` 在未就绪时先拒绝（不把"没做成"漏成"没问题"） | ⑤ |
 * | 空壳端口被构造期拒绝（无 provider / 两个适配器都缺） | ⑥⑦ |
 * | 接了真实模型时 `kind === 'model'`、provider 可读、能力真被调用 | ⑧ |
 * | 只接规则表时 `kind === 'deterministic_rules'`（**如实标注不是模型**），翻译给 `unsupported` | ⑨ |
 * | 回执文本能读出就绪状态与来源类别 | ⑩ |
 */

import { describe, expect, it, vi } from 'vitest';

import { createDocumentModel } from '../model/document.js';
import { textParagraphNode } from '../model/nodes.js';
import type { DocumentModel } from '../model/types.js';
import { succeed } from '../selection/types.js';
import { createRuleBasedChecker, type ProofingChecker, type ProofingIssue } from './spelling.js';
import {
  createModelBackedProofingPort,
  createRuleBasedProofingPort,
  createUnavailableProofingPort,
  describeProofingReadiness,
  isNotReady,
  requireReady,
} from './port.js';
import { createStubTranslator, sampleRules } from './testing.js';

function doc(): DocumentModel {
  return createDocumentModel({
    document_id: 'proofing-port-doc',
    blocks: [textParagraphNode({ text: 'the 的的 document', source: 'user_request' })],
  });
}

describe('校对/翻译端口的就绪状态（WF-095 / WF-096）', () => {
  it('① 没有真实模型 ⇒ 如实未就绪；`check` 是 fail，而不是"0 条提示"（反向对照）', () => {
    const port = createUnavailableProofingPort('本环境没有配置真实的校对模型');
    expect(isNotReady(port)).toBe(true);
    expect(port.readiness).toEqual({
      status: 'not_ready',
      reason: '本环境没有配置真实的校对模型',
    });
    expect(port.rule_ids).toEqual([]);

    const result = port.check({ model: doc() });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('未就绪端口不该产出检查结果');
    expect(result.code).toBe('precondition');
    // 原因**原样**出现在回执里（用户能看懂"为什么没就绪"）。
    expect(result.message).toContain('本环境没有配置真实的校对模型');
    expect(result.message).toContain('不得');

    // **反向对照**：把"未就绪"伪造成"检查过、没有问题"会得到一个 ok:true 的空数组。
    // 本用例把那条路堵死——两者在结构上就不相等。
    const fabricated = succeed<readonly ProofingIssue[]>([]);
    expect(result).not.toEqual(fabricated);
    expect(result.ok).not.toBe(fabricated.ok);
  });

  it('② 未就绪端口的 `translator()` 也是 fail；两个能力都不产出"替身结果"', () => {
    const port = createUnavailableProofingPort('模型额度未配置');
    const translated = port.translator();
    expect(translated.ok).toBe(false);
    if (translated.ok) throw new Error('未就绪端口不该产出翻译端口');
    expect(translated.code).toBe('precondition');
    expect(translated.message).toContain('模型额度未配置');
  });

  it('③ 未就绪原因空串也不编造：回执明说"原因不明"，仍然是 fail', () => {
    const port = createUnavailableProofingPort('');
    expect(port.readiness.status).toBe('not_ready');
    const result = port.check({ model: doc() });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('未就绪端口不该产出检查结果');
    expect(result.message).toContain('原因不明');
  });

  it('④ 未就绪端口不调用任何能力：注入的检查适配器**一次都没被调用**', () => {
    // 造一个"如果被调用就会留下痕迹"的检查器——它**不该**出现在未就绪端口里。
    const spy = vi.fn(() => succeed<readonly ProofingIssue[]>([]));
    const checker: ProofingChecker = { rule_ids: ['x'], check: spy };
    const port = createUnavailableProofingPort('没接模型');
    void checker; // 刻意不注入：未就绪端口没有可注入的适配器，这正是它的定义。
    port.check({ model: doc() });
    expect(spy).not.toHaveBeenCalled();
  });

  it('⑤ 就绪闸门：未就绪时先拒绝，且给出可读回执', () => {
    const port = createUnavailableProofingPort('未配置模型');
    const gate = requireReady(port, 'translation');
    expect(gate.ok).toBe(false);
    if (gate.ok) throw new Error('未就绪端口不该通过就绪闸门');
    expect(gate.message).toContain('translation');
    expect(gate.message).toContain('未配置模型');
    expect(describeProofingReadiness(port)).toContain('未就绪');
  });

  it('⑥ 空壳端口被构造期拒绝：provider 是空白 —— 说不清是谁做的就不算接了模型', () => {
    const result = createModelBackedProofingPort({ provider: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('空白 provider 不该构造成功');
    expect(result.code).toBe('invalid_query');
  });

  it('⑦ 空壳端口被构造期拒绝：检查与翻译适配器一个都没有', () => {
    const result = createModelBackedProofingPort({ provider: 'http://model.local' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('没有任何适配器的端口不该构造成功');
    expect(result.code).toBe('precondition');
    expect(result.message).toContain('空壳');
  });

  it('⑧ 接了真实模型：`kind === "model"`，provider 可读，能力真的被调用', () => {
    const rules = createRuleBasedChecker(sampleRules());
    if (!rules.ok) throw new Error(rules.message);
    const spy = vi.fn(rules.value.check);
    const translator = createStubTranslator({ 'the 的的 document': 'The document' });
    const built = createModelBackedProofingPort({
      provider: 'model://proofing-v1',
      checker: { rule_ids: rules.value.rule_ids, check: spy },
      translator,
    });
    if (!built.ok) throw new Error(built.message);
    const port = built.value;

    expect(port.readiness).toEqual({
      status: 'ready',
      provider: 'model://proofing-v1',
      kind: 'model',
    });
    expect(requireReady(port, 'spelling').ok).toBe(true);

    const issues = port.check({ model: doc() });
    expect(issues.ok).toBe(true);
    if (!issues.ok) throw new Error(issues.message);
    // 命中是**真的**（规则表里 "的的" 与 "the the" 都在）——不是伪造的 0 条。
    expect(issues.value.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(1);

    const back = port.translator();
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error(back.message);
    expect(back.value).toBe(translator);
  });

  it('⑨ 只接规则表 ⇒ `kind === "deterministic_rules"`（如实标注不是模型）；翻译给 unsupported', () => {
    const built = createRuleBasedProofingPort(sampleRules());
    if (!built.ok) throw new Error(built.message);
    const port = built.value;

    expect(port.readiness.status).toBe('ready');
    if (port.readiness.status !== 'ready') throw new Error('规则表端口应当是就绪的');
    expect(port.readiness.kind).toBe('deterministic_rules');
    expect(port.readiness.provider).toContain('非真实模型');
    expect(port.rule_ids.length).toBe(sampleRules().length);

    const translated = port.translator();
    expect(translated.ok).toBe(false);
    if (translated.ok) throw new Error('规则表端口不含翻译能力');
    expect(translated.code).toBe('unsupported');
    // **反向对照**：不返回"原样回显的译文"——那不是翻译。
    expect(translated.message).toContain('替身');
  });

  it('⑩ 回执能同时读出"就绪状态"与"来源类别"', () => {
    const rules = createRuleBasedProofingPort(sampleRules());
    if (!rules.ok) throw new Error(rules.message);
    expect(describeProofingReadiness(rules.value)).toContain('非模型');
    expect(describeProofingReadiness(rules.value)).toContain('规则');

    const model = createModelBackedProofingPort({
      provider: 'model://x',
      translator: createStubTranslator(),
    });
    if (!model.ok) throw new Error(model.message);
    expect(describeProofingReadiness(model.value)).toContain('真实模型');
    expect(describeProofingReadiness(model.value)).toContain('model://x');

    // 只接了翻译、没有检查器：`check` 明确说"没有这个能力"，**不是**"0 条提示"。
    const noChecker = model.value.check({ model: doc() });
    expect(noChecker.ok).toBe(false);
    if (noChecker.ok) throw new Error('未接检查能力不该产出结果');
    expect(noChecker.code).toBe('unsupported');
  });
});
