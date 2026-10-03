/**
 * **W08 — K02 ModelPort 校对/翻译接线的独立验收**（`tests/mobile-office/word/W08/`）。
 *
 * 对 `src/documents/proofing/model-port.ts`（WF-093–096 的模型接线）做取证，不重复
 * `port.test.ts` / `translation.test.ts` 已钉住的判据（就绪状态、迟到 revision、预算拒绝顺序）。
 * 本文件只测**未被覆盖**的行为面：
 *
 * | 行为面 | 判据 | 用例 |
 * |---|---|---|
 * | 请求形状绑 K02 契约 | `messages/toolSchemas/cancellation/budget/keyRef/model` 逐项发出 | §A |
 * | **缺模型不得报通过** | 未接端口 / 模型只吐文本 / 空流 ⇒ `fail`，**不是** `succeed([])` | §B |
 * | **取消不改稿** | 预先取消 / 在途取消 ⇒ `fail`，端口调用次数与文档双向核对 | §C |
 * | **过期不改稿** | 注入时钟越过 `deadlineMs` ⇒ `fail`，端口不调用 | §C |
 * | 输出绑选区/revision/预算 | 只改选区内、`base_revision` 绑定、调用次数 ≤ 预算、token 超限 `budget_exceeded` | §D |
 * | 模型输出不可信即拒 | 段 id 越界 / 偏移越界 / `issues` 非数组 ⇒ `invalid_model_output` | §E |
 * | **反向对照** | 唯一能拿到 `succeed([])` 的路径是"模型真的调用了工具且 issues 为空" | §B/§E |
 *
 * 时间基准**注入**：所有 `cancellation.deadlineMs` 与 `clock()` 都用测试给定值，不读墙钟。
 * 本文件不发起任何真实网络请求——验证层为 `contract`（端口契约），**不是** `real-api`。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel } from '../../../../src/documents/model/types.js';
import {
  createModelPortBackedProofingPort,
  createUnavailableModelProofingPort,
  describeModelPortProofingReadiness,
  PROOFING_TOOL_NAME,
  type ModelPort,
  type ModelPortRequest,
  type ModelPortStreamChunk,
} from '../../../../src/documents/proofing/model-port.js';
import { commitTranslation } from '../../../../src/documents/proofing/translation.js';
import { paragraphText } from '../../../../src/documents/selection/structure.js';
import { document, paragraphOfRuns } from '../../../../src/documents/selection/testing.js';
import { succeed, type Result, type Selection } from '../../../../src/documents/selection/types.js';

// ---------------------------------------------------------------------------
// 确定性内存端口（不是 mock 的一种"假装"——它真实记录请求、真实按脚本返回片段）
// ---------------------------------------------------------------------------

interface ScriptedPort {
  readonly port: ModelPort;
  /** 每次 `stream` 实际收到的请求（用于核对"请求确实按契约形状发出"）。 */
  readonly requests: ModelPortRequest[];
}

type Script = (request: ModelPortRequest, callIndex: number) => readonly ModelPortStreamChunk[];

function scriptedPort(provider: string, script: Script): ScriptedPort {
  const requests: ModelPortRequest[] = [];
  return {
    requests,
    port: {
      provider,
      async stream(request: ModelPortRequest): Promise<readonly ModelPortStreamChunk[]> {
        requests.push(request);
        return script(request, requests.length - 1);
      },
    },
  };
}

function textChunks(...texts: readonly string[]): readonly ModelPortStreamChunk[] {
  return texts.map((text) => ({ type: 'text', text }));
}

function toolChunk(issues: unknown): ModelPortStreamChunk {
  return { type: 'tool-call', toolCallId: 'tc-1', toolName: PROOFING_TOOL_NAME, arguments: { issues } };
}

function usageChunk(totalTokens: number): ModelPortStreamChunk {
  return { type: 'usage', usage: { promptTokens: totalTokens, completionTokens: 0, totalTokens } };
}

function build(scripted: ScriptedPort, model = 'deepseek-flash', keyRef = 'keyref:app-default'): ReturnType<typeof createModelPortBackedProofingPort> {
  return createModelPortBackedProofingPort({ port: scripted.port, keyRef, model, clock: () => CLOCK_NOW });
}

const CLOCK_NOW = 1_000_000;
const NEVER_CANCELLED = { token: 'tok', deadlineMs: CLOCK_NOW + 60_000 } as const;

function twoParagraphDoc(): DocumentModel {
  return document([paragraphOfRuns('p1', [['r1', '你好世界']]), paragraphOfRuns('p2', [['r2', '别动我']])]);
}

function snap(model: DocumentModel): string {
  return JSON.stringify(model);
}

function select(nodeId: string, start: number, end: number): Selection {
  return { document_id: 'doc-1', base_revision: 1, ranges: [{ node_id: nodeId, start, end }] };
}

function failStatus(result: Result<unknown>): string | undefined {
  if (result.ok) return undefined;
  return typeof result.detail.extra?.['proofingStatus'] === 'string' ? result.detail.extra['proofingStatus'] : undefined;
}

// ---------------------------------------------------------------------------

describe('W08 §A K02 请求形状（契约绑定）', () => {
  it('§A1 请求带齐 K02 必需字段，且本地类型与契约结构一致', async () => {
    // 编译期：用契约的必需字段构造请求；字段名/类型漂移会在此处报错。
    const shape = {
      messages: [{ role: 'user', content: 'hi' }],
      toolSchemas: [{ name: PROOFING_TOOL_NAME, parameters: { type: 'object' } }],
      cancellation: { token: 't1' },
      budget: { maxTokens: 100 },
      keyRef: 'keyref:k',
      model: 'deepseek-flash',
    } satisfies ModelPortRequest;
    expect(shape.keyRef.startsWith('keyref:')).toBe(true);

    const scripted = scriptedPort('model://contract-probe', () => [toolChunk([])]);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);

    const result = await built.value.checkWithModel({
      model: twoParagraphDoc(),
      cancellation: NEVER_CANCELLED,
      budget: { maxTokens: 999 },
    });
    expect(result.ok).toBe(true);

    expect(scripted.requests).toHaveLength(1);
    const request = scripted.requests[0]!;
    expect(request.keyRef).toBe('keyref:app-default');
    expect(request.model).toBe('deepseek-flash');
    expect(request.cancellation.token).toBe('tok');
    expect(request.budget.maxTokens).toBe(999);
    expect(request.stream).toBe(false);
    expect(request.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(request.toolSchemas.map((t) => t.name)).toContain(PROOFING_TOOL_NAME);
    // 用户消息里带的是**从文档实读**的段落文本（供模型定位）。
    const userContent = String(request.messages[1]!.content);
    expect(userContent).toContain('你好世界');
    expect(userContent).toContain('p1');
  });
});

describe('W08 §B 缺模型不得报通过', () => {
  it('§B1 未接模型端口 ⇒ fail 且 proofingStatus=not_ready（反向对照：不是 ok:true 空数组）', async () => {
    const port = createUnavailableModelProofingPort('App 未配置模型密钥');
    const result = await port.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('未就绪端口不该产出检查结果');
    expect(result.code).toBe('precondition');
    expect(failStatus(result)).toBe('not_ready');
    expect(result.message).toContain('App 未配置模型密钥');

    const fabricated = succeed([]);
    expect(result).not.toEqual(fabricated);
    expect(port.readiness.status).toBe('not_ready');
    expect(describeModelPortProofingReadiness(port)).toContain('未就绪');
  });

  it('§B2 模型只吐自然语言、没有结构化工具调用 ⇒ no_output，绝不当作"没问题"', async () => {
    const scripted = scriptedPort('model://chatty', () => textChunks('看起来没问题，文档很干净。'));
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);

    const result = await built.value.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('无结构化输出不该被当作检查通过');
    expect(failStatus(result)).toBe('no_output');
    expect(result.message).toContain('不得');
    expect(result).not.toEqual(succeed([]));
  });

  it('§B3 模型返回空流 ⇒ no_output（0 个片段 ≠ 检查过且无问题）', async () => {
    const scripted = scriptedPort('model://silent', () => []);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);
    const result = await built.value.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failStatus(result)).toBe('no_output');
  });

  it('§B4 模型流返回 error 片段 ⇒ model_error，不是通过', async () => {
    const scripted = scriptedPort('model://err', () => [
      { type: 'error', error: { code: 'rate_limited', message: '模型限流' } },
    ]);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);
    const result = await built.value.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(failStatus(result)).toBe('model_error');
      expect(result.detail.extra?.['modelErrorCode']).toBe('rate_limited');
    }
  });
});

describe('W08 §C 取消 / 过期不改稿', () => {
  it('§C1 预先取消 ⇒ fail cancelled，端口一次都没被调用，文档逐字节不变', async () => {
    const model = twoParagraphDoc();
    const before = snap(model);
    const scripted = scriptedPort('model://x', () => [toolChunk([])]);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);

    const result = await built.value.checkWithModel({
      model,
      cancellation: { token: 'cancel-pre', cancelled: true },
      budget: { maxTokens: 100 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failStatus(result)).toBe('cancelled');
    expect(scripted.requests).toHaveLength(0); // 取消的活儿不花模型调用
    expect(snap(model)).toBe(before);
  });

  it('§C2 注入时钟越过 deadlineMs ⇒ fail expired，端口不调用，文档不变', async () => {
    const model = twoParagraphDoc();
    const before = snap(model);
    const scripted = scriptedPort('model://x', () => [toolChunk([])]);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);

    const result = await built.value.checkWithModel({
      model,
      cancellation: { token: 'tok', deadlineMs: CLOCK_NOW - 1 },
      budget: { maxTokens: 100 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(failStatus(result)).toBe('expired');
      expect(result.detail.extra?.['token']).toBe('tok');
    }
    expect(scripted.requests).toHaveLength(0);
    expect(snap(model)).toBe(before);
  });

  it('§C3 翻译在途被取消：已花掉的第一个范围也作废，文档不改、无提案可提交', async () => {
    const model = document([paragraphOfRuns('p1', [['r1', '你好世界']])]);
    const before = snap(model);
    let cancelled = false;
    const cancellation = {
      token: 'cancel-mid',
      get cancelled(): boolean {
        return cancelled;
      },
    };
    // 端口的第一次调用就把 token 置为取消——模拟"请求在途期间用户点了取消"。
    const scripted = scriptedPort('model://x', () => {
      cancelled = true;
      return textChunks('[EN]你好');
    });
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);

    const result = await built.value.translateSelectionWithModel(
      model,
      { document_id: 'doc-1', base_revision: 1, ranges: [{ node_id: 'p1', start: 0, end: 2 }, { node_id: 'p1', start: 2, end: 4 }] },
      { target_language: 'en-US', cancellation, budget: { max_model_calls: 5 } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failStatus(result)).toBe('cancelled');
    expect(scripted.requests).toHaveLength(1); // 只发了第一段；第二段被门禁挡住
    expect(snap(model)).toBe(before); // 取消的工作**没有**改动文档
  });
});

describe('W08 §D 翻译输出绑选区 / revision / 预算', () => {
  it('§D1 成功：只改选区内，范围外段落一字不动，revision 提交后 +1', async () => {
    const model = twoParagraphDoc(); // p1 你好世界 / p2 别动我
    const scripted = scriptedPort('model://translate', () => textChunks('X'));
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);

    const proposal = await built.value.translateSelectionWithModel(model, select('p1', 1, 3), {
      target_language: 'en-US',
      cancellation: NEVER_CANCELLED,
      budget: { max_model_calls: 3 },
    });
    if (!proposal.ok) throw new Error(proposal.message);

    expect(proposal.value.base_revision).toBe(1);
    expect(proposal.value.segments).toHaveLength(1);
    expect(proposal.value.segments[0]!.source_text).toBe('好世');
    expect(proposal.value.segments[0]!.source.kind).toBe('model');
    expect(proposal.value.model_calls).toBe(1);

    const committed = commitTranslation(model, proposal.value);
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(committed.message);
    expect(committed.value.revision).toBe(2);
    const p1 = committed.value.blocks.find((b) => b.kind === 'paragraph' && b.id === 'p1');
    const p2 = committed.value.blocks.find((b) => b.kind === 'paragraph' && b.id === 'p2');
    if (p1?.kind !== 'paragraph' || p2?.kind !== 'paragraph') throw new Error('段落丢失');
    expect(paragraphText(p1)).toBe('你X界'); // 仅选区被替换
    expect(paragraphText(p2)).toBe('别动我'); // 范围外不动
  });

  it('§D2 调用次数超预算 ⇒ 先拒绝、端口不调用（预算门在模型之前）', async () => {
    const model = twoParagraphDoc();
    const scripted = scriptedPort('model://x', () => textChunks('X'));
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);

    const result = await built.value.translateSelectionWithModel(
      model,
      { document_id: 'doc-1', base_revision: 1, ranges: [{ node_id: 'p1', start: 0, end: 2 }, { node_id: 'p1', start: 2, end: 4 }] },
      { target_language: 'en-US', cancellation: NEVER_CANCELLED, budget: { max_model_calls: 1 } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail.extra?.['requiredModelCalls']).toBe(2);
    expect(scripted.requests).toHaveLength(0);
  });

  it('§D3 token 超预算 ⇒ budget_exceeded，文档不改', async () => {
    const model = twoParagraphDoc();
    const before = snap(model);
    const scripted = scriptedPort('model://x', () => [...textChunks('X'), usageChunk(500)]);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);

    const result = await built.value.translateSelectionWithModel(model, select('p1', 0, 2), {
      target_language: 'en-US',
      cancellation: NEVER_CANCELLED,
      budget: { max_model_calls: 3, maxTokens: 100 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(failStatus(result)).toBe('budget_exceeded');
      expect(result.detail.extra?.['tokensUsed']).toBe(500);
    }
    expect(snap(model)).toBe(before);
  });

  it('§D4 提案绑 revision：产生后文档被改到 r2，提交必须 stale_revision', async () => {
    const model = twoParagraphDoc();
    const scripted = scriptedPort('model://x', () => textChunks('X'));
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);

    const proposal = await built.value.translateSelectionWithModel(model, select('p1', 0, 2), {
      target_language: 'en-US',
      cancellation: NEVER_CANCELLED,
      budget: { max_model_calls: 3 },
    });
    if (!proposal.ok) throw new Error(proposal.message);

    const bumped: DocumentModel = { ...model, revision: 2 };
    const result = commitTranslation(bumped, proposal.value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_revision');
      expect(result.detail.requestedRevision).toBe(1);
    }
  });

  it('§D5 模型对某范围无译文文本 ⇒ no_output（不得用原文冒充译文）', async () => {
    const model = twoParagraphDoc();
    const before = snap(model);
    const scripted = scriptedPort('model://x', () => textChunks(''));
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);
    const result = await built.value.translateSelectionWithModel(model, select('p1', 0, 2), {
      target_language: 'en-US',
      cancellation: NEVER_CANCELLED,
      budget: { max_model_calls: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failStatus(result)).toBe('no_output');
    expect(snap(model)).toBe(before);
  });
});

describe('W08 §E 模型输出校验（fail-closed）', () => {
  it('§E1 工具调用报了不在本次范围内的段 ⇒ invalid_model_output', async () => {
    const scripted = scriptedPort('model://x', () => [toolChunk([{ paragraph_id: 'ghost', start: 0, end: 1, kind: 'spelling', message: 'x' }])]);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);
    const result = await built.value.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failStatus(result)).toBe('invalid_model_output');
  });

  it('§E2 偏移越界 ⇒ invalid_model_output（不把不可信坐标当结果）', async () => {
    const scripted = scriptedPort('model://x', () => [toolChunk([{ paragraph_id: 'p1', start: 0, end: 99, kind: 'spelling', message: 'x' }])]);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);
    const result = await built.value.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failStatus(result)).toBe('invalid_model_output');
  });

  it('§E3 arguments.issues 不是数组 ⇒ invalid_model_output', async () => {
    const scripted = scriptedPort('model://x', () => [{ type: 'tool-call', toolCallId: 'tc', toolName: PROOFING_TOOL_NAME, arguments: { issues: 'nope' } }]);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);
    const result = await built.value.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(failStatus(result)).toBe('invalid_model_output');
  });

  it('§E4 反向对照：模型真的调了工具且 issues 为空 ⇒ 此时才是"检查过、0 条"（唯一合法空结果）', async () => {
    const scripted = scriptedPort('model://x', () => [toolChunk([])]);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);

    const result = await built.value.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toEqual([]);
    // 与 §B2/§B3 的 no_output 形成对照：同样的"空结果"，一个是通过、一个是失败——
    // 区别只在于"模型是否真的给出了结构化结论"。
    expect(result).toEqual(succeed([]));
  });

  it('§E5 合法提示被采纳：location.text 由文档实读（不采信模型自报）', async () => {
    const scripted = scriptedPort('model://x', () => [
      toolChunk([{ paragraph_id: 'p1', start: 0, end: 2, kind: 'spelling', message: '疑似用词', suggestions: ['您好'], text: '模型瞎报的原文' }]),
    ]);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);
    const result = await built.value.checkWithModel({ model: twoParagraphDoc(), cancellation: NEVER_CANCELLED });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.location.text).toBe('你好'); // 实读，而不是 '模型瞎报的原文'
    expect(result.value[0]!.base_revision).toBe(1);
    expect(result.value[0]!.suggestions).toEqual(['您好']);
  });
});

describe('W08 §F 构造期守卫', () => {
  it('§F1 空的 / 非 keyref 的 keyRef ⇒ 拒绝（本层只接引用）', () => {
    const scripted = scriptedPort('model://x', () => []);
    expect(build(scripted, 'deepseek-flash', '').ok).toBe(false);
    const bad = createModelPortBackedProofingPort({ port: scripted.port, keyRef: 'sk-plaintext', model: 'deepseek-flash' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid_query');
  });

  it('§F2 空 model / 空 provider ⇒ 拒绝', () => {
    const scripted = scriptedPort('model://x', () => []);
    expect(build(scripted, '   ').ok).toBe(false);
    const emptyProvider = createModelPortBackedProofingPort({
      port: { provider: '  ', stream: async () => [] },
      keyRef: 'keyref:k',
      model: 'deepseek-flash',
    });
    expect(emptyProvider.ok).toBe(false);
  });

  it('§F3 顺利构造后 readiness 可读、来源可描述', () => {
    const scripted = scriptedPort('model://deepseek-host', () => []);
    const built = build(scripted);
    if (!built.ok) throw new Error(built.message);
    expect(built.value.readiness).toEqual({ status: 'ready', provider: 'model://deepseek-host', kind: 'model' });
    expect(describeModelPortProofingReadiness(built.value)).toContain('model://deepseek-host');
  });
});
