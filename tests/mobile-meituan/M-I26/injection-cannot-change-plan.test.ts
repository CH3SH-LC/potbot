/**
 * M-I26 / 注入面 —— **恶意商家/菜品描述不能改变计划**（M03 + M-R06/I15 跨模块负例）。
 *
 * 负例对照的两侧都是**生产模块**：
 * - M03 `catalog`：`asUntrustedText` → `envelopeFromUntrustedText` → 复核闸门 → 数据块；
 * - M-R06/I15 `injection-guard`：taint 信封 + `applyDescriptionToPlan`。
 *
 * 断言口径：
 * 1. 同一段描述在两包的严重度结论**一致**（都是 `high`），且 `mayBeInterpretedAsInstruction`
 *    恒为 `false`——文本永远只是数据；
 * 2. 把描述"应用到计划"**返回同一引用**（`toBe`）——注入无法把只读搜索计划改成下单计划；
 * 3. 严格模式下两包都**硬拒**高风险描述（各自的具体拒因类型）。
 */

import { describe, expect, it } from 'vitest';

import {
  applyDescriptionToPlan,
  buildDescriptionEnvelope as guardBuildEnvelope,
  analyzeDescription as guardAnalyze,
  isM06GuardError,
  renderDescriptionDataBlock as guardRender,
} from '../../../src/mobile-plugins/meituan/injection-guard/index.js';
import {
  CatalogReviewRequiredError,
  analyzeDescription as catalogAnalyze,
  asUntrustedText,
  buildDescriptionEnvelope as catalogBuildEnvelope,
  envelopeFromUntrustedText,
  evaluateDescriptionGate,
  renderDescriptionForPrompt,
} from '../../../src/mobile-plugins/meituan/catalog/index.js';
import { DESCRIPTIONS, FENCE_ATTACK, SEARCH_PLAN, SUBMIT_TOOL } from './support.js';

const SOURCE = 'catalog.item.description';

/** 恶意描述 + 期望命中的信号。 */
const MALICIOUS: ReadonlyArray<readonly [string, string, string]> = [
  ['override', DESCRIPTIONS.override, 'instruction_override'],
  ['toolCall', DESCRIPTIONS.toolCall, 'tool_invocation'],
  ['roleMarker', DESCRIPTIONS.roleMarker, 'role_marker'],
  ['purchaseOnly', DESCRIPTIONS.purchaseOnly, 'purchase_action'],
];

describe('M03 与 M-R06/I15 对同一段恶意描述结论一致', () => {
  it.each(MALICIOUS)('%s：两包都判 high 且都只当数据', (_name, text, signal) => {
    const guard = guardAnalyze(text);
    const catalog = catalogAnalyze(text);

    expect(guard.severity).toBe('high');
    expect(catalog.severity).toBe('high');
    expect(guard.signals).toContain(signal);
    expect(catalog.signals).toContain(signal);

    // taint 三件套恒成立：不是指令、不可执行。
    expect(guard.trust).toBe('untrusted_data');
    expect(guard.renderedAs).toBe('data_only');
    expect(guard.mayBeInterpretedAsInstruction).toBe(false);
    expect(catalog.trust).toBe('untrusted_data');
    expect(catalog.renderedAs).toBe('data_only');
    expect(catalog.mayBeInterpretedAsInstruction).toBe(false);
    expect(catalog.executable).toBe(false);
  });

  it('良性描述两包都判 none 且仍只是数据', () => {
    expect(guardAnalyze(DESCRIPTIONS.benign).severity).toBe('none');
    expect(catalogAnalyze(DESCRIPTIONS.benign).severity).toBe('none');
    expect(catalogAnalyze(DESCRIPTIONS.benign).executable).toBe(false);
  });
});

describe('恶意描述不能改变计划（同一引用）', () => {
  it.each(MALICIOUS)('%s：applyDescriptionToPlan 返回同一引用，工具/参数不变', (_name, text) => {
    const env = guardBuildEnvelope(text, { source: SOURCE, strict: false });
    const after = applyDescriptionToPlan(SEARCH_PLAN, env);

    expect(after).toBe(SEARCH_PLAN);
    expect(after.toolId).toBe(SEARCH_PLAN.toolId);
    expect(after.arguments).toEqual({ category: '火锅', location: '徐汇', budgetMinor: 8_000 });
  });

  it('良性描述同样不改变计划', () => {
    const env = guardBuildEnvelope(DESCRIPTIONS.benign, { source: SOURCE });
    expect(applyDescriptionToPlan(SEARCH_PLAN, env)).toBe(SEARCH_PLAN);
  });

  it('注入不能把只读搜索计划换成下单计划', () => {
    const env = guardBuildEnvelope(DESCRIPTIONS.override, { source: SOURCE, strict: false });
    const after = applyDescriptionToPlan(SEARCH_PLAN, env);
    expect(after.toolId).not.toBe(SUBMIT_TOOL);
    expect(after).toBe(SEARCH_PLAN);
  });
});

describe('M03 描述信封 → 复核闸门：高风险描述不进入提示词路径', () => {
  it('envelopeFromUntrustedText 产出的信封在闸门下为 review_required', () => {
    const untrusted = asUntrustedText(DESCRIPTIONS.override, SOURCE);
    const envelope = envelopeFromUntrustedText(untrusted, SOURCE);

    expect(envelope.kind).toBe('untrusted_merchant_description');
    expect(envelope.trust).toBe('untrusted_data');
    expect(envelope.renderedAs).toBe('data_only');
    expect(envelope.analysis.requiresReview).toBe(true);

    const gate = evaluateDescriptionGate(envelope.analysis);
    expect(gate.status).toBe('review_required');
  });

  it('renderDescriptionForPrompt 对高风险描述抛 CatalogReviewRequiredError', () => {
    const untrusted = asUntrustedText(DESCRIPTIONS.override, SOURCE);
    const envelope = envelopeFromUntrustedText(untrusted, SOURCE);
    let caught: unknown;
    try {
      renderDescriptionForPrompt(envelope);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CatalogReviewRequiredError);
  });
});

describe('严格模式下两包都硬拒高风险描述', () => {
  it('M03 抛 CatalogReviewRequiredError；M-R06/I15 抛 description_injection_blocked', () => {
    let catalogCaught: unknown;
    try {
      catalogBuildEnvelope(DESCRIPTIONS.override, { source: SOURCE });
    } catch (error) {
      catalogCaught = error;
    }
    expect(catalogCaught).toBeInstanceOf(CatalogReviewRequiredError);

    let guardCaught: unknown;
    try {
      guardBuildEnvelope(DESCRIPTIONS.override, { source: SOURCE });
    } catch (error) {
      guardCaught = error;
    }
    expect(isM06GuardError(guardCaught)).toBe(true);
    expect((guardCaught as { code: string }).code).toBe('description_injection_blocked');
  });
});

describe('数据围栏不可被正文提前闭合（M-R06/I15 渲染）', () => {
  it('正文里的 </DATA> 被转义，只保留一处真实围栏', () => {
    const env = guardBuildEnvelope(FENCE_ATTACK, { source: SOURCE, strict: false });
    const block = guardRender(env);
    expect(block.split('</DATA>').length - 1).toBe(1);
    expect(block).toContain('&lt;/DATA&gt;');
    expect(block).toContain('<DATA source="untrusted_merchant_description">');
  });
});
